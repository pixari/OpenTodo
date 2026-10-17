package sync

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	gosync "sync"
	"time"

	"github.com/pixari/opentodo/internal/ids"
	"github.com/pixari/opentodo/internal/notify"
)

// Service persists ops and materializes current field values.
type Service struct {
	db *sql.DB
	// rdb is the reader pool (store.OpenReader) for pure reads; nil uses db
	// (OpenSpec change database-concurrency).
	rdb      *sql.DB
	now      func() time.Time
	observer Observer
	notifier *Notifier
	// sinks receive assignment events after commit (task-assignment design D4).
	sinks notify.Multi
	// commentLimiter caps comment creation per account (comments-and-activity).
	commentLimiter *fixedWindow
	// attachmentLimit is the per-file attachment size limit in bytes (attachments D5).
	attachmentLimit func() int64
	// blobs removes attachment files after purges (attachments D13); nil in tests without files.
	blobs BlobStore
	// pullBudget overrides MaxPullBytes in tests; 0 means MaxPullBytes.
	pullBudget int
	// guard bounds writes on a demo instance (demo-sandboxes D3); nil elsewhere.
	guard WriteGuard
	// quota refuses single ops once a hosted tenant reached a limit
	// (multi-tenant-host D5); nil elsewhere.
	quota Quota
	// clockMu guards lastTS, the last timestamp ServerTS issued (sync-convergence).
	clockMu gosync.Mutex
	lastTS  int64
}

// Quota bounds what a hosted tenant may store (OpenSpec `multi-tenant-host`,
// design D5). Admit runs once per batch inside Apply's transaction and returns
// the check for each op that would be stored: "" admits it, a reason (one of
// the Reason* limit constants) refuses that op alone, reported in Rejected like
// any other refusal, so the rest of a device's outbox keeps syncing. Stored is
// told how many ops were kept once the batch committed.
type Quota interface {
	Admit(ctx context.Context, tx *sql.Tx) (func(op Op) string, error)
	Stored(n int)
}

// Refusal reasons of a tenant's limits (multi-tenant-host D5).
const (
	ReasonLimitStorage  = "limit_storage"
	ReasonLimitOpsHour  = "limit_ops_hour"
	ReasonLimitOpsTotal = "limit_ops_total"
)

// IsLimitReason reports whether a refusal reason names a tenant limit.
func IsLimitReason(r string) bool {
	return r == ReasonLimitStorage || r == ReasonLimitOpsHour || r == ReasonLimitOpsTotal
}

// SetQuota installs the tenant quota (nil removes it). Call it during wiring.
func (s *Service) SetQuota(q Quota) { s.quota = q }

// WriteGuard bounds what one account may write (OpenSpec change
// `demo-sandboxes`, design D3). CheckOp runs for every op before the batch's
// transaction and may refuse it (wrap ErrInvalidOp for a size limit); Charge
// runs inside the transaction once the number of ops that will be stored and
// the total size of their values (bytes) are known, and refusing there (wrap ErrWriteLimit) rolls the whole batch back,
// so nothing is applied.
type WriteGuard interface {
	CheckOp(op Op) error
	Charge(ctx context.Context, tx *sql.Tx, userID string, n int, bytes int64) error
}

// ErrWriteLimit is wrapped by a WriteGuard that refuses a batch because the
// account used up its write budget.
var ErrWriteLimit = errors.New("write limit reached")

// SetWriteGuard installs the write guard (nil removes it). Call it during wiring.
func (s *Service) SetWriteGuard(g WriteGuard) { s.guard = g }

type guardKey struct{}

// WithoutWriteGuard marks ctx so Apply skips the write guard: server-side
// provisioning (the demo seed) is not visitor writing.
func WithoutWriteGuard(ctx context.Context) context.Context {
	return context.WithValue(ctx, guardKey{}, true)
}

func (s *Service) guardFor(ctx context.Context) WriteGuard {
	if s.guard == nil || ctx.Value(guardKey{}) != nil {
		return nil
	}
	return s.guard
}

// pullBytes is the byte budget of one pull page.
func (s *Service) pullBytes() int {
	if s.pullBudget > 0 {
		return s.pullBudget
	}
	return MaxPullBytes
}

// FieldChange is one field's transition within a batch. From is nil (JSON null)
// when the field had no stored value before the batch.
type FieldChange struct {
	From json.RawMessage `json:"from"`
	To   json.RawMessage `json:"to"`
}

// Change describes everything that genuinely changed on one entity in one Apply
// batch: only ops that won under last-writer-wins and altered the stored value
// contribute. Origin is the device id of the last winning op ("server" for REST).
type Change struct {
	UserID   string // author of the batch
	ScopeID  string // user:<id> or project:<id>; everyone who can see it may be told
	Entity   string
	EntityID string
	Fields   map[string]FieldChange
	Origin   string
}

// Observer receives the winning changes of a batch after its transaction has
// committed. It runs synchronously on the caller's goroutine, so it must be quick
// (the webhook queue only inserts rows). It never sees losing or duplicate ops.
type Observer func(ctx context.Context, changes []Change)

// SetObserver installs the post-commit observer (nil removes it). Call it during
// wiring, before the service handles requests.
func (s *Service) SetObserver(o Observer) { s.observer = o }

// SetAttachmentLimit installs the per-file attachment size limit in bytes, read
// per batch (owner settings can change it without a restart); nil or 0 means
// unlimited (OpenSpec change attachments, design D5).
func (s *Service) SetAttachmentLimit(limit func() int64) { s.attachmentLimit = limit }

// NewService wires a Service.
func NewService(db *sql.DB) *Service {
	s := &Service{db: db, now: time.Now, notifier: NewNotifier()}
	s.SetCommentRateLimit(CommentRateLimit, CommentRateWindow)
	return s
}

// SetReader installs the reader pool (store.OpenReader) that List, Get and
// Pull read from, so they do not queue behind writes. Call it during wiring.
func (s *Service) SetReader(db *sql.DB) { s.rdb = db }

// reader is the handle for pure reads: the reader pool when installed, else
// the writer. Never use it for a read whose result decides a write in the same
// transaction.
func (s *Service) reader() *sql.DB {
	if s.rdb != nil {
		return s.rdb
	}
	return s.db
}

// DB returns the database the op log lives in, for packages that keep their own
// operational tables next to it (import jobs). Entity data must still be written
// through Apply only.
func (s *Service) DB() *sql.DB { return s.db }

// Notifier returns the live-update fan-out for this service. Callers of Apply
// use it to wake the user's other devices once a batch has been committed.
func (s *Service) Notifier() *Notifier { return s.notifier }

// ApplyResult summarizes an Apply call.
type ApplyResult struct {
	Applied    int   `json:"applied"`
	Duplicates int   `json:"duplicates"`
	Seq        int64 `json:"seq"` // the latest op cursor over the user's scopes after the batch
	// Rejected lists the ops refused for authorization reasons; they were not stored.
	Rejected []Rejection `json:"rejected,omitempty"`
	// Restore holds the current winning op of every refused field the caller can
	// see, so the device can put the server's value back without another exchange.
	Restore []Op `json:"-"`
	// Audience is every user who can see a scope this batch changed: the users whose
	// devices should be woken (see NotifyApplied).
	Audience []string `json:"-"`
}

// Rejection is one refused op of a batch.
type Rejection struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
	// ServerTime is the server's clock (Unix ms) when it refused an op with
	// ReasonClockSkew, so the device can correct its clock (sync-convergence).
	ServerTime int64 `json:"serverTime,omitempty"`
}

// Rejection reasons.
const (
	// ReasonForbidden: the author's role (or lack of membership) does not allow the write.
	ReasonForbidden = "forbidden"
	// ReasonScopeChange: a task's project_id would move it into another sharing
	// scope; clients copy the task and tombstone the original instead.
	ReasonScopeChange = "scope_change"
	// ReasonNotAMember: a task's assignee_id names an account that may not be
	// assigned in the task's scope (OpenSpec change task-assignment, design D2):
	// not a current member of the shared project, or not the author for a task in
	// a personal scope.
	ReasonNotAMember = "not_a_member"
	// ReasonClockSkew: the op's timestamp is more than MaxFutureSkewMs ahead of
	// the server's clock (OpenSpec change sync-convergence). Only devices that
	// announce support get it (see WithClockSkewRefusal); the device corrects
	// its clock, stamps the op again and re-sends it, so no edit is lost.
	ReasonClockSkew = "clock_skew"
)

type skewKey struct{}

// WithClockSkewRefusal marks ctx so Apply refuses ops stamped too far in the
// future with ReasonClockSkew instead of clamping them (sync-convergence). The
// sync route sets it for devices that announce the "clock_skew" feature: older
// clients drop an op refused for a reason they do not know, so they keep the
// clamping behaviour.
func WithClockSkewRefusal(ctx context.Context) context.Context {
	return context.WithValue(ctx, skewKey{}, true)
}

// RejectedError is returned by ApplyStrict when any op of the batch is refused.
type RejectedError struct {
	Op     Op
	Reason string
	// Detail names what was refused when the reason alone does not (the blocker
	// id of a cycle or of another scope, task-dependencies).
	Detail string
}

func (e *RejectedError) Error() string {
	return fmt.Sprintf("op %s.%s refused: %s", e.Op.Entity, e.Op.Field, e.Reason)
}

// Apply validates and records a batch of ops for one user atomically.
// Duplicate op ids are ignored, so clients can retry safely. Timestamps far in the
// future are refused with ReasonClockSkew when ctx carries WithClockSkewRefusal,
// and clamped otherwise, so a misconfigured clock cannot freeze a field forever.
// Each op is authorized against the author's memberships at receipt time; refused
// ops are reported in Rejected and never stored, the rest of the batch is applied.
func (s *Service) Apply(ctx context.Context, userID string, ops []Op) (ApplyResult, error) {
	return s.apply(ctx, userID, ops, false)
}

// ApplyStrict is Apply for the REST API: one refused op refuses the whole batch
// with a *RejectedError and nothing is stored. A task completion without
// completed_by gets one for userID (see StampCompletedBy).
func (s *Service) ApplyStrict(ctx context.Context, userID string, ops []Op) (ApplyResult, error) {
	return s.apply(ctx, userID, StampCompletedBy(userID, ops), true)
}

// StampCompletedBy records who completed a task (OpenSpec change
// completed-date-filters, design D5) for server-side writes: a task completed_at
// op without a completed_by op for the same task in the batch gains one, set to
// userID when it completes and to null when it reopens, with the same timestamp
// and device so both fields resolve to the same winner. A creation that leaves
// the task open needs nothing. The added op's id derives from the completed_at
// op's, so a retried batch stays a duplicate. Devices write the field themselves:
// Apply (the sync path) does not stamp.
func StampCompletedBy(userID string, ops []Op) []Op {
	has := map[string]bool{}
	creates := map[string]bool{}
	for _, op := range ops {
		if op.Entity != "task" {
			continue
		}
		switch op.Field {
		case "completed_by":
			has[op.EntityID] = true
		case "created_at":
			creates[op.EntityID] = true
		}
	}
	var extra []Op
	for _, op := range ops {
		if op.Entity != "task" || op.Field != "completed_at" || has[op.EntityID] {
			continue
		}
		done := !nullish(op.Value)
		if !done && creates[op.EntityID] {
			continue
		}
		value := json.RawMessage("null")
		if done {
			value = jsonOf(userID)
		}
		has[op.EntityID] = true
		extra = append(extra, Op{ID: ids.NameID("completed_by", op.ID), Entity: "task", EntityID: op.EntityID,
			Field: "completed_by", Value: value, TS: op.TS, Device: op.Device})
	}
	if len(extra) == 0 {
		return ops
	}
	return append(append(make([]Op, 0, len(ops)+len(extra)), ops...), extra...)
}

// writeOp stores one authorized op in scope and upserts the scope's winning value
// under last-writer-wins, recording genuine changes in tracker. It reports false
// when the op id was already stored for this author (a duplicate within a batch).
func writeOp(ctx context.Context, tx *sql.Tx, userID string, op Op, scope string, nowMs int64, tracker *changeTracker) (bool, error) {
	r, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO ops(user_id,op_id,entity,entity_id,field,value,ts,device,received_at)
		VALUES(?,?,?,?,?,?,?,?,?)`, userID, op.ID, op.Entity, op.EntityID, op.Field, string(op.Value), op.TS, op.Device, nowMs)
	if err != nil {
		return false, err
	}
	if n, _ := r.RowsAffected(); n == 0 {
		return false, nil
	}
	seq, err := r.LastInsertId()
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO op_scopes(seq, scope_id) VALUES(?,?)`, seq, scope); err != nil {
		return false, err
	}
	// Read the current winner so the observer learns about genuine changes only.
	var prevValue, prevDevice string
	var prevTS int64
	err = tx.QueryRowContext(ctx, `SELECT value, ts, device FROM scope_fields WHERE scope_id = ? AND entity = ? AND entity_id = ? AND field = ?`,
		scope, op.Entity, op.EntityID, op.Field).Scan(&prevValue, &prevTS, &prevDevice)
	existed := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if !existed || Wins(op.TS, op.Device, prevTS, prevDevice) {
		var prev json.RawMessage
		if existed {
			prev = json.RawMessage(prevValue)
		}
		tracker.record(scope, op, prev)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO scope_fields(scope_id,entity,entity_id,field,value,ts,device) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(scope_id,entity,entity_id,field) DO UPDATE SET value=excluded.value, ts=excluded.ts, device=excluded.device
		WHERE excluded.ts > scope_fields.ts OR (excluded.ts = scope_fields.ts AND excluded.device > scope_fields.device)`,
		scope, op.Entity, op.EntityID, op.Field, string(op.Value), op.TS, op.Device)
	return err == nil, err
}

// NotifyApplied wakes the devices of everyone who can see what a batch changed,
// except the device that sent it. Call it after a successful Apply with Applied > 0.
func (s *Service) NotifyApplied(res ApplyResult, originDevice string) {
	for _, uid := range res.Audience {
		s.notifier.Notify(uid, originDevice, res.Seq)
	}
}

// NotifyMembership wakes every device of the given users after a membership change,
// which adds no op: the wake-up carries no cursor, so devices always sync.
func (s *Service) NotifyMembership(users []string) {
	for _, uid := range users {
		s.notifier.Notify(uid, "", MembershipWake)
	}
}

// MembershipWake is the cursor value of a wake-up that is not about new ops; the
// event stream sends it without a cursor so every device runs the exchange.
const MembershipWake int64 = -1

func maxSeq(ctx context.Context, q querier, scopes []string) (int64, error) {
	var seq int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM op_scopes WHERE scope_id IN (`+placeholders(len(scopes))+`)`, anys(scopes)...).Scan(&seq)
	return seq, err
}

// perScope repeats a single-scope query n times joined by UNION ALL, one arm
// per visible scope, each searching that scope's index range (CORE-7).
func perScope(n int, arm string) string {
	if n <= 0 {
		return arm
	}
	return strings.TrimSuffix(strings.Repeat(arm+" UNION ALL ", n), " UNION ALL ")
}

// audience resolves the users who can see the touched scopes, author first.
func audience(ctx context.Context, q querier, author string, touched map[string]bool) ([]string, error) {
	if len(touched) == 0 {
		return nil, nil
	}
	out := []string{author}
	seen := map[string]bool{author: true}
	scopes := make([]string, 0, len(touched))
	for sc := range touched {
		scopes = append(scopes, sc)
	}
	sort.Strings(scopes)
	for _, sc := range scopes {
		users, err := scopeUsers(ctx, q, sc)
		if err != nil {
			return nil, err
		}
		for _, u := range users {
			if !seen[u] {
				seen[u] = true
				out = append(out, u)
			}
		}
	}
	return out, nil
}

// changeTracker coalesces the winning ops of one batch per entity, keeping the
// value before the batch as From and the final winner as To.
type changeTracker struct {
	userID string
	order  []string
	byKey  map[string]*Change
}

func newChangeTracker(userID string) *changeTracker {
	return &changeTracker{userID: userID, byKey: map[string]*Change{}}
}

func (t *changeTracker) record(scope string, op Op, prev json.RawMessage) {
	key := scope + "\x00" + op.Entity + "\x00" + op.EntityID
	c, ok := t.byKey[key]
	if !ok {
		c = &Change{UserID: t.userID, ScopeID: scope, Entity: op.Entity, EntityID: op.EntityID, Fields: map[string]FieldChange{}}
		t.byKey[key] = c
		t.order = append(t.order, key)
	}
	c.Origin = op.Device
	fc, seen := c.Fields[op.Field]
	if !seen {
		fc.From = prev
	}
	fc.To = append(json.RawMessage(nil), op.Value...)
	c.Fields[op.Field] = fc
}

// changes drops fields whose value ended where it started (a re-seeded op with a
// newer timestamp but the same value) and entities left with no changed field.
func (t *changeTracker) changes() []Change {
	out := make([]Change, 0, len(t.order))
	for _, key := range t.order {
		c := t.byKey[key]
		for f, fc := range c.Fields {
			if SameJSON(fc.From, fc.To) {
				delete(c.Fields, f)
			}
		}
		if len(c.Fields) > 0 {
			out = append(out, *c)
		}
	}
	return out
}

// SameJSON reports whether two JSON values are equal ignoring insignificant
// whitespace. A missing value (nil) equals JSON null.
func SameJSON(a, b json.RawMessage) bool {
	norm := func(v json.RawMessage) []byte {
		if len(v) == 0 {
			return []byte("null")
		}
		var buf bytes.Buffer
		if err := json.Compact(&buf, v); err != nil {
			return v
		}
		return buf.Bytes()
	}
	return bytes.Equal(norm(a), norm(b))
}

// Pull returns ops after cursor from every scope the user can see, the newest
// cursor and whether more remain. Ops authored by device are skipped; the cursor
// still advances past them.
//
// A project the user joined after their device's cursor had passed part of its
// history is caught up first (design D4): pages of that history are served with
// the cursor unchanged and more = true, then the regular pull continues, so the
// device's single cursor stays monotonic.
func (s *Service) Pull(ctx context.Context, userID string, cursor int64, device string, limit int) ([]Op, int64, bool, error) {
	r, err := s.PullAll(ctx, userID, cursor, device, limit)
	return r.Ops, r.Cursor, r.More, err
}

// PullResult is one page of the exchange: ops after the cursor, the entities
// purged since the cursor (trash-and-history D5), the next cursor and whether
// more remain.
type PullResult struct {
	Ops    []Op
	Purged []PurgedEntity
	Cursor int64
	More   bool
	// BackfillSeq names a served page of a joined project's history when the
	// device confirms pages (PullOptions.ConfirmBackfill): the device echoes it
	// as PullOptions.BackfillAck once it applied the page. 0 otherwise.
	BackfillSeq int64
}

// PullOptions tune one pull for what the device supports.
type PullOptions struct {
	// ConfirmBackfill: the device echoes BackfillSeq after applying a page of a
	// joined project's history (OpenSpec change sync-convergence). Progress then
	// advances only on that echo, so a page lost in transit is served again.
	// Without it (older clients) progress advances when the page is served.
	ConfirmBackfill bool
	// BackfillAck is the BackfillSeq of the last page the device applied (0: none).
	BackfillAck int64
}

// PullAll is Pull plus purge markers. Markers share the ops sequence, so the
// cursor also advances past markers; ops and markers are read in one snapshot.
func (s *Service) PullAll(ctx context.Context, userID string, cursor int64, device string, limit int) (PullResult, error) {
	return s.PullWith(ctx, userID, cursor, device, limit, PullOptions{})
}

// PullWith is PullAll with options for what the device supports.
func (s *Service) PullWith(ctx context.Context, userID string, cursor int64, device string, limit int, opt PullOptions) (PullResult, error) {
	res := PullResult{Ops: []Op{}, Cursor: cursor}
	if limit <= 0 || limit > MaxOpsPerRequest {
		limit = MaxOpsPerRequest
	}
	if device != "" {
		ops, served, err := s.backfillPage(ctx, userID, device, cursor, limit, opt)
		if err != nil {
			return res, err
		}
		if len(ops) > 0 {
			res.Ops, res.More, res.BackfillSeq = ops, true, served
			return res, nil
		}
	}
	// A read-only snapshot on the reader pool: ops and purge markers agree, and
	// the pull does not wait for writes in progress (database-concurrency).
	tx, err := s.reader().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return res, err
	}
	defer tx.Rollback()
	acc, err := loadAccess(ctx, tx, userID)
	if err != nil {
		return res, err
	}
	scopes := acc.scopes()
	rows, err := tx.QueryContext(ctx, pullQuery(len(scopes)), pullArgs(scopes, cursor, limit+1)...)
	if err != nil {
		return res, err
	}
	next := cursor
	n, size := 0, 0
	for rows.Next() {
		if n == limit {
			res.More = true
			break
		}
		op, err := scanOp(rows)
		if err != nil {
			rows.Close()
			return res, err
		}
		if op.Device != device && len(res.Ops) > 0 && size+len(op.Value) > s.pullBytes() {
			// Byte budget reached: this op opens the next page.
			res.More = true
			break
		}
		next = op.Seq
		n++
		if op.Device == device {
			continue
		}
		size += len(op.Value)
		res.Ops = append(res.Ops, op)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	// With more ops pending, only markers up to the page's end; otherwise all.
	upto := int64(0)
	if res.More {
		upto = next
	}
	purged, top, err := purgedSince(ctx, tx, scopes, cursor, upto)
	if err != nil {
		return res, err
	}
	res.Purged = purged
	res.Cursor = max(next, top)
	return res, nil
}

// pullQuery reads the next ops of n scopes in seq order. Each scope's ops after
// the cursor come from its own index range, merged in seq order and cut at the
// limit before the op rows are read; with scope_id IN (...) SQLite instead
// read and sorted every op of the scopes after the cursor (CORE-7).
func pullQuery(n int) string {
	return `SELECT o.seq,o.op_id,o.entity,o.entity_id,o.field,o.value,o.ts,o.device,o.user_id
		FROM (SELECT seq FROM (` + perScope(n, `SELECT seq FROM (SELECT seq FROM op_scopes WHERE scope_id = ? AND seq > ? ORDER BY seq LIMIT ?)`) + `) ORDER BY seq LIMIT ?) s
		JOIN ops o ON o.seq = s.seq ORDER BY s.seq`
}

func pullArgs(scopes []string, cursor int64, limit int) []any {
	args := make([]any, 0, 3*len(scopes)+1)
	for _, sc := range scopes {
		args = append(args, sc, cursor, limit)
	}
	return append(args, limit)
}

func scanOp(rows *sql.Rows) (Op, error) {
	var op Op
	var value string
	if err := rows.Scan(&op.Seq, &op.ID, &op.Entity, &op.EntityID, &op.Field, &value, &op.TS, &op.Device, &op.Actor); err != nil {
		return op, err
	}
	op.Value = json.RawMessage(value)
	return op, nil
}

// backfillPage serves the next page of history of a project the user joined, for
// this device: ops of the project's scope up to the device's cursor at its first
// sync after joining (later ops arrive through the regular pull). It returns nil
// once every joined project has been replayed for the device. Ops this device
// authored are included: a device that was removed purged them locally.
//
// With opt.ConfirmBackfill the page's end is kept as served_seq
// (member_backfill_served) and returned;
// done_seq moves there only when the device echoes it (opt.BackfillAck), so a
// page that never arrived is served again from done_seq (sync-convergence).
func (s *Service) backfillPage(ctx context.Context, userID, device string, cursor int64, limit int, opt PullOptions) ([]Op, int64, error) {
	if !opt.ConfirmBackfill || opt.BackfillAck <= 0 {
		// Nearly every pull has no history to replay: find out on the reader
		// pool so it does not take the write lock (database-concurrency).
		var one int
		err := s.reader().QueryRowContext(ctx, `SELECT 1 FROM project_members m
			LEFT JOIN member_backfills b ON b.project_id = m.project_id AND b.user_id = m.user_id AND b.device = ?
			WHERE m.user_id = ? AND m.backfill = 1 AND (b.project_id IS NULL OR b.done_seq < b.upto_seq) LIMIT 1`, device, userID).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, 0, nil
		}
		if err != nil {
			return nil, 0, fmt.Errorf("check backfill: %w", err)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	if opt.ConfirmBackfill && opt.BackfillAck > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE member_backfills SET done_seq = ?
			WHERE user_id = ? AND device = ? AND done_seq < ? AND project_id IN
			(SELECT project_id FROM member_backfill_served WHERE user_id = ? AND device = ? AND served_seq = ?)`,
			opt.BackfillAck, userID, device, opt.BackfillAck, userID, device, opt.BackfillAck); err != nil {
			return nil, 0, fmt.Errorf("confirm backfill page: %w", err)
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT m.project_id, b.upto_seq, b.done_seq FROM project_members m
		LEFT JOIN member_backfills b ON b.project_id = m.project_id AND b.user_id = m.user_id AND b.device = ?
		WHERE m.user_id = ? AND m.backfill = 1 AND (b.project_id IS NULL OR b.done_seq < b.upto_seq)
		ORDER BY m.project_id`, device, userID)
	if err != nil {
		return nil, 0, err
	}
	type pending struct {
		project    string
		upto, done int64
		fresh      bool
	}
	var list []pending
	for rows.Next() {
		var p pending
		var upto, done sql.NullInt64
		if err := rows.Scan(&p.project, &upto, &done); err != nil {
			rows.Close()
			return nil, 0, err
		}
		p.fresh = !upto.Valid
		p.upto, p.done = upto.Int64, done.Int64
		if p.fresh {
			p.upto = cursor
		}
		list = append(list, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	var page []Op
	var served int64
	size, full := 0, false
	for _, p := range list {
		if p.fresh {
			if _, err := tx.ExecContext(ctx, `INSERT INTO member_backfills(project_id,user_id,device,upto_seq,done_seq) VALUES(?,?,?,?,0)`,
				p.project, userID, device, p.upto); err != nil {
				return nil, 0, err
			}
		}
		if p.done < p.upto {
			r, err := tx.QueryContext(ctx, `SELECT o.seq,o.op_id,o.entity,o.entity_id,o.field,o.value,o.ts,o.device,o.user_id
				FROM op_scopes s JOIN ops o ON o.seq = s.seq
				WHERE s.scope_id = ? AND s.seq > ? AND s.seq <= ? ORDER BY s.seq LIMIT ?`, ProjectScope(p.project), p.done, p.upto, limit)
			if err != nil {
				return nil, 0, err
			}
			for r.Next() {
				op, err := scanOp(r)
				if err != nil {
					r.Close()
					return nil, 0, err
				}
				if len(page) > 0 && size+len(op.Value) > s.pullBytes() {
					// Byte budget reached: the rest of this history is the next page.
					full = true
					break
				}
				size += len(op.Value)
				page = append(page, op)
			}
			r.Close()
			if err := r.Err(); err != nil {
				return nil, 0, err
			}
		}
		done := p.upto
		if full || len(page) == limit {
			done = page[len(page)-1].Seq
		}
		if opt.ConfirmBackfill && len(page) > 0 {
			// Confirmed by the device's next exchange (see above).
			served = done
			if _, err := tx.ExecContext(ctx, `INSERT INTO member_backfill_served(project_id,user_id,device,served_seq) VALUES(?,?,?,?)
				ON CONFLICT(project_id,user_id,device) DO UPDATE SET served_seq = excluded.served_seq`,
				p.project, userID, device, done); err != nil {
				return nil, 0, err
			}
		} else if _, err := tx.ExecContext(ctx, `UPDATE member_backfills SET done_seq = ? WHERE project_id = ? AND user_id = ? AND device = ?`,
			done, p.project, userID, device); err != nil {
			return nil, 0, err
		}
		if len(page) > 0 {
			break
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	return page, served, nil
}

// Entity is a materialized record: id plus every field that has a value.
type Entity map[string]json.RawMessage

// List materializes all entities of one kind the user can see (personal scope
// plus shared projects), including soft-deleted ones when includeDeleted is set.
// Results are ordered by position, then created_at.
func (s *Service) List(ctx context.Context, userID, entity string, includeDeleted bool) ([]Entity, error) {
	if _, ok := Schema[entity]; !ok {
		return nil, fmt.Errorf("%w: unknown entity %q", ErrInvalidOp, entity)
	}
	acc, err := loadAccess(ctx, s.reader(), userID)
	if err != nil {
		return nil, err
	}
	scopes := acc.scopes()
	rows, err := s.reader().QueryContext(ctx, listQuery(len(scopes)), append(anys(scopes), entity)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]Entity{}
	scopeOf := map[string]string{}
	order := []string{}
	for rows.Next() {
		var scope, id, field, value string
		if err := rows.Scan(&scope, &id, &field, &value); err != nil {
			return nil, err
		}
		e, ok := byID[id]
		if !ok {
			e = Entity{"id": json.RawMessage(QuoteJSON(id))}
			byID[id] = e
			scopeOf[id] = scope
			order = append(order, id)
		} else if scopeOf[id] != scope {
			// The same id in two visible scopes (only possible with forged ids):
			// keep the preferred scope's record, never a mix of both.
			if acc.rank(scope) >= acc.rank(scopeOf[id]) {
				continue
			}
			e = Entity{"id": e["id"]}
			byID[id] = e
			scopeOf[id] = scope
		}
		e[field] = json.RawMessage(value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Strings(order)
	out := make([]Entity, 0, len(order))
	for _, id := range order {
		e := byID[id]
		if !includeDeleted && e.deleted() {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := out[i].number("position"), out[j].number("position")
		if pi != pj {
			return pi < pj
		}
		return out[i].number("created_at") < out[j].number("created_at")
	})
	return out, nil
}

// listQuery reads one entity kind's fields in n scopes. It has no ORDER BY:
// sorting by entity_id made SQLite walk the entity index over every user's
// rows once a user sees more than one scope (CORE-7); the primary key
// (scope_id, entity, ...) reads only the visible scopes, and List sorts the ids.
func listQuery(n int) string {
	return `SELECT scope_id,entity_id,field,value FROM scope_fields WHERE scope_id IN (` + placeholders(n) + `) AND entity = ?`
}

// Get materializes one entity the user can see or returns nil when it does not exist.
func (s *Service) Get(ctx context.Context, userID, entity, id string) (Entity, error) {
	if _, ok := Schema[entity]; !ok {
		return nil, fmt.Errorf("%w: unknown entity %q", ErrInvalidOp, entity)
	}
	acc, err := loadAccess(ctx, s.reader(), userID)
	if err != nil {
		return nil, err
	}
	scopes := acc.scopes()
	rows, err := s.reader().QueryContext(ctx, `SELECT scope_id,field,value FROM scope_fields WHERE scope_id IN (`+placeholders(len(scopes))+`) AND entity = ? AND entity_id = ?`,
		append(anys(scopes), entity, id)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byScope := map[string]Entity{}
	for rows.Next() {
		var scope, field, value string
		if err := rows.Scan(&scope, &field, &value); err != nil {
			return nil, err
		}
		e := byScope[scope]
		if e == nil {
			e = Entity{"id": json.RawMessage(QuoteJSON(id))}
			byScope[scope] = e
		}
		e[field] = json.RawMessage(value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var best Entity
	bestRank := 0
	for scope, e := range byScope {
		if r := acc.rank(scope); best == nil || r < bestRank {
			best, bestRank = e, r
		}
	}
	return best, nil
}

// Generation returns the op-log generation. It changes only when the database is
// restored from a backup; devices that see a new value re-seed the server from
// their local copy (docs/sync.md, "Log generation").
func (s *Service) Generation(ctx context.Context) (string, error) {
	var g sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'generation'`).Scan(&g)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return g.String, err
}

func (e Entity) deleted() bool {
	v, ok := e["deleted_at"]
	return ok && string(v) != "null"
}

// Deleted reports whether the entity carries a tombstone.
func (e Entity) Deleted() bool { return e.deleted() }

func (e Entity) number(field string) float64 {
	var f float64
	if v, ok := e[field]; ok {
		_ = json.Unmarshal(v, &f)
	}
	return f
}
