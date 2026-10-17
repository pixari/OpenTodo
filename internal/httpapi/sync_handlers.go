package httpapi

import (
	"errors"
	"net/http"
	"slices"
	"time"

	opsync "github.com/pixari/opentodo/internal/sync"
)

// The sync endpoint: devices push ops and pull what changed since their cursor.

type syncRequest struct {
	Device string      `json:"device"`
	Cursor int64       `json:"cursor"`
	Ops    []opsync.Op `json:"ops"`
	// TZOffset is the device's zone offset in minutes east of UTC (optional,
	// additive); REST writes that move a due date recompute relative reminders in it.
	TZOffset *int `json:"tzOffset,omitempty"`
	// Features names the protocol additions the device supports (optional,
	// additive; OpenSpec change sync-convergence): "clock_skew" (refuse ops
	// stamped too far ahead with reason clock_skew instead of clamping them)
	// and "backfill_ack" (confirm member backfill pages with BackfillAck).
	Features []string `json:"features,omitempty"`
	// BackfillAck echoes the backfillSeq of the last backfill page applied.
	BackfillAck int64 `json:"backfillAck,omitempty"`
}

func (in syncRequest) supports(feature string) bool {
	return slices.Contains(in.Features, feature)
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var in syncRequest
	// Op batches accept fields this server does not know (jsonbody.go).
	if err := readJSONLoose(r, &in); err != nil {
		badBody(w, err)
		return
	}
	if in.Device == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "device is required")
		return
	}
	// Devices may not write as an AI assistant or a calendar app: those device
	// ids are reserved for the server's own writers (mcp-write-tools D4).
	if opsync.ReservedDevice(in.Device) {
		writeError(w, http.StatusBadRequest, "invalid_op", "device: server and ids starting with agent:, caldav: or public: are reserved")
		return
	}
	for _, op := range in.Ops {
		if opsync.ReservedDevice(op.Device) {
			writeError(w, http.StatusBadRequest, "invalid_op", "op device: server and ids starting with agent:, caldav: or public: are reserved")
			return
		}
	}
	uid := userFrom(r.Context()).ID
	s.recordTZOffset(r.Context(), uid, in.TZOffset)
	applyCtx := r.Context()
	if in.supports("clock_skew") {
		applyCtx = opsync.WithClockSkewRefusal(applyCtx)
	}
	res, err := s.sync.Apply(applyCtx, uid, in.Ops)
	if errors.Is(err, opsync.ErrInvalidOp) {
		writeError(w, http.StatusBadRequest, "invalid_op", err.Error())
		return
	}
	if writeLimited(w, err) {
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}
	if res.Applied > 0 {
		// Wake the other devices of everyone who can see the change; this one
		// learns the cursor from the response.
		s.sync.NotifyApplied(res, in.Device)
	}
	pull, err := s.sync.PullWith(r.Context(), uid, in.Cursor, in.Device, opsync.MaxOpsPerRequest,
		opsync.PullOptions{ConfirmBackfill: in.supports("backfill_ack"), BackfillAck: in.BackfillAck})
	if err != nil {
		s.internal(w, err)
		return
	}
	ops, cursor, more := pull.Ops, pull.Cursor, pull.More
	purged := pull.Purged
	if purged == nil {
		purged = []opsync.PurgedEntity{}
	}
	// The server's value of every refused field travels with the response, so the
	// device restores it without another round trip (project-sharing design D3).
	ops = append(ops, res.Restore...)
	memberships, err := s.sync.Memberships(r.Context(), uid)
	if err != nil {
		s.internal(w, err)
		return
	}
	rejected := res.Rejected
	if rejected == nil {
		rejected = []opsync.Rejection{}
	}
	gen, err := s.sync.Generation(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	out := map[string]any{
		"applied":    res.Applied,
		"duplicates": res.Duplicates,
		"ops":        ops,
		"cursor":     cursor,
		"hasMore":    more,
		"serverTime": time.Now().UnixMilli(),
		// generation changes only when the server is restored from a backup (additive field).
		"generation": gen,
		// Additive (project-sharing): refused ops and the caller's shared projects.
		"rejected":    rejected,
		"memberships": memberships,
		// Additive (trash-and-history): entities purged since the cursor, which
		// devices delete locally, and the Trash retention in days (0 = never).
		"purged":             purged,
		"trashRetentionDays": s.cfg.TrashRetentionDays,
	}
	if pull.BackfillSeq > 0 {
		// Additive (sync-convergence): echoed as backfillAck once applied.
		out["backfillSeq"] = pull.BackfillSeq
	}
	writeJSON(w, http.StatusOK, out)
}
