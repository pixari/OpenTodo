package sync

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// apply is Apply and ApplyStrict: it validates the batch, then in one
// transaction admits, resolves and stores each op (applyBatch.applyOne), and
// finally charges the write guard, commits and notifies (finish).
func (s *Service) apply(ctx context.Context, userID string, ops []Op, strict bool) (ApplyResult, error) {
	guard, err := s.validateBatch(ctx, ops)
	if err != nil {
		return ApplyResult{}, err
	}
	nowMs := s.now().UnixMilli()
	// The attachment size limit reads owner settings: before the transaction, since
	// SQLite has one writer connection (attachments D5).
	var attachmentLimit int64
	if s.attachmentLimit != nil {
		attachmentLimit = s.attachmentLimit()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ApplyResult{}, err
	}
	defer tx.Rollback()
	b, err := s.newApplyBatch(ctx, tx, userID, ops, strict, nowMs, attachmentLimit)
	if err != nil {
		return ApplyResult{}, err
	}
	for _, op := range ops {
		if err := b.applyOne(op); err != nil {
			return b.res, err
		}
	}
	return b.finish(guard)
}

// validateBatch checks the batch size and every op's shape, and the write
// guard's per-op limits, before anything is read or written.
func (s *Service) validateBatch(ctx context.Context, ops []Op) (WriteGuard, error) {
	if len(ops) > MaxOpsPerRequest {
		return nil, fmt.Errorf("%w: at most %d ops per request", ErrInvalidOp, MaxOpsPerRequest)
	}
	guard := s.guardFor(ctx)
	for i := range ops {
		if err := Validate(ops[i]); err != nil {
			return nil, err
		}
		if guard != nil {
			if err := guard.CheckOp(ops[i]); err != nil {
				return nil, err
			}
		}
	}
	return guard, nil
}

// applyBatch is the state of one apply call inside its transaction.
type applyBatch struct {
	s          *Service
	ctx        context.Context
	tx         *sql.Tx
	userID     string
	strict     bool
	nowMs      int64
	refuseSkew bool
	acc        *access
	rs         *resolver
	pc         *purgeChecker
	admit      func(Op) string
	tracker    *changeTracker
	touched    map[string]bool
	// refused ops get the server's value handed back; rewritten ops were stored
	// with a changed value the author's device must adopt.
	refused, rewritten []Op
	storedBytes        int64 // value bytes of the stored ops, for the write guard
	res                ApplyResult
}

// newApplyBatch loads the author's access and prepares the resolver, the purge
// check and the tenant quota for the batch.
func (s *Service) newApplyBatch(ctx context.Context, tx *sql.Tx, userID string, ops []Op, strict bool, nowMs, attachmentLimit int64) (*applyBatch, error) {
	acc, err := loadAccess(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	rs := newResolver(ctx, tx, acc, ops)
	rs.allowComment = func() bool { return s.commentLimiter.allow(userID) }
	rs.attachmentLimit = attachmentLimit
	b := &applyBatch{s: s, ctx: ctx, tx: tx, userID: userID, strict: strict, nowMs: nowMs,
		refuseSkew: ctx.Value(skewKey{}) != nil, acc: acc, rs: rs,
		pc:      &purgeChecker{ctx: ctx, q: tx, acc: acc, cache: map[string]bool{}},
		tracker: newChangeTracker(userID), touched: map[string]bool{}}
	if s.quota != nil && ctx.Value(guardKey{}) == nil {
		if b.admit, err = s.quota.Admit(ctx, tx); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// reject refuses op: in strict mode the whole batch (res is cleared), otherwise
// the op alone, reported in Rejected.
func (b *applyBatch) reject(op Op, reason string, detail string, rej Rejection) error {
	if b.strict {
		b.res = ApplyResult{}
		return &RejectedError{Op: op, Reason: reason, Detail: detail}
	}
	b.res.Rejected = append(b.res.Rejected, rej)
	return nil
}

// applyOne admits, resolves and stores one op, counting it as applied, a
// duplicate or rejected. An error ends the batch.
func (b *applyBatch) applyOne(op Op) error {
	ctx, tx, rs := b.ctx, b.tx, b.rs
	skewed := op.TS > b.nowMs+MaxFutureSkewMs
	if skewed && !b.refuseSkew {
		// Older clients: clamp, as before sync-convergence.
		op.TS = b.nowMs + MaxFutureSkewMs
		skewed = false
	}
	// A retried op that was stored earlier stays a duplicate even if the
	// author's role changed since: it is already part of the log.
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM ops WHERE user_id = ? AND op_id = ?`, b.userID, op.ID).Scan(&one)
	if err == nil {
		b.res.Duplicates++
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	// Ops for a purged entity are discarded and counted as duplicates so a
	// device with stale offline edits cannot resurrect it (trash-and-history D5).
	if gone, err := b.pc.purged(op.Entity, op.EntityID); err != nil {
		return err
	} else if gone {
		b.res.Duplicates++
		return nil
	}
	if skewed {
		// Not a verdict on the value: the device keeps its change, corrects
		// its clock and sends it again with a new timestamp, so nothing is
		// restored here (sync-convergence).
		return b.reject(op, ReasonClockSkew, "", Rejection{ID: op.ID, Reason: ReasonClockSkew, ServerTime: b.nowMs})
	}
	scope, reason, err := rs.resolve(op)
	if err != nil {
		return err
	}
	if reason == reasonDiscard {
		b.res.Duplicates++
		return nil
	}
	if reason == "" && b.admit != nil {
		reason = b.admit(op)
	}
	if reason != "" {
		if err := b.reject(op, reason, rs.detail, Rejection{ID: op.ID, Reason: reason}); err != nil {
			return err
		}
		// A limit refusal is not a verdict on the value: the device keeps its
		// change and sends it again later, so the server's value is not
		// handed back to overwrite it (multi-tenant-host D5).
		if !IsLimitReason(reason) {
			b.refused = append(b.refused, op)
		}
		return nil
	}
	return b.store(op, scope)
}

// store writes one admitted op and records what follows from it.
func (b *applyBatch) store(op Op, scope string) error {
	// Mentions keep current members only (comments-and-activity D2): the op
	// is stored with the filtered value and handed back to the author's
	// device, whose copy carries the same clock (see applyOps on the client).
	filtered := false
	if op.Entity == "comment" && op.Field == "mentions" {
		var err error
		if op.Value, filtered, err = b.rs.filterMentions(scope, op.Value); err != nil {
			return err
		}
	}
	stored, err := writeOp(b.ctx, b.tx, b.userID, op, scope, b.nowMs, b.tracker)
	if err != nil {
		return err
	}
	if !stored {
		b.res.Duplicates++ // the same op id twice in one batch
		return nil
	}
	b.rs.noteBlockedBy(op, scope)
	if filtered {
		op.Actor = b.userID
		b.rewritten = append(b.rewritten, op)
	}
	b.storedBytes += int64(len(op.Value))
	b.touched[scope] = true
	b.res.Applied++
	return nil
}

// finish charges the write guard, computes what the author's device restores,
// the new cursor and the audience, commits, and then notifies observers and
// emits assignment, mention and unblocked events.
func (b *applyBatch) finish(guard WriteGuard) (ApplyResult, error) {
	s, ctx, tx, res := b.s, b.ctx, b.tx, b.res
	var err error
	if guard != nil && res.Applied > 0 {
		if err := guard.Charge(ctx, tx, b.userID, res.Applied, b.storedBytes); err != nil {
			return ApplyResult{}, err
		}
	}
	if res.Restore, err = b.rs.restoreOps(b.refused); err != nil {
		return res, err
	}
	res.Restore = append(res.Restore, b.rewritten...)
	if res.Seq, err = maxSeq(ctx, tx, b.acc.scopes()); err != nil {
		return res, err
	}
	if res.Audience, err = audience(ctx, tx, b.userID, b.touched); err != nil {
		return res, err
	}
	if err := tx.Commit(); err != nil {
		return res, err
	}
	if s.quota != nil && res.Applied > 0 {
		s.quota.Stored(res.Applied)
	}
	// The batch is committed: what follows must happen even if the client
	// disconnected and the request's context was cancelled (sync-convergence).
	post := context.WithoutCancel(ctx)
	changes := b.tracker.changes()
	if s.observer != nil && len(changes) > 0 {
		s.observer(post, changes)
	}
	s.emitAssignments(post, b.userID, b.nowMs, changes)
	s.emitMentions(post, b.userID, b.nowMs, changes)
	s.emitUnblocked(post, b.userID, b.nowMs, changes)
	return res, nil
}
