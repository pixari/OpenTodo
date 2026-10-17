package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/agenttools"
	"github.com/pixari/opentodo/internal/ids"
	opsync "github.com/pixari/opentodo/internal/sync"
)

// REST collections: every write goes through the op log (ApplyStrict), like a
// device would, so REST and sync writes converge the same way.

var serverDevice = opsync.ServerDevice

func collection(r *http.Request) (string, bool) {
	e, ok := opsync.Plural[r.PathValue("collection")]
	return e, ok
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	entity, ok := collection(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown collection")
		return
	}
	after, before, msg := completionRange(r, entity)
	if msg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	list, err := s.sync.List(r.Context(), userFrom(r.Context()).ID, entity, r.URL.Query().Get("include_deleted") == "true")
	if err != nil {
		s.internal(w, err)
		return
	}
	if after != 0 || before != 0 {
		kept := list[:0]
		for _, e := range list {
			var at float64
			if raw, ok := e["completed_at"]; ok {
				_ = json.Unmarshal(raw, &at)
			}
			// A habit's skipped occurrence record is not a completion (habits D6).
			if string(e["skipped"]) == "true" {
				continue
			}
			if agenttools.InCompletionRange(int64(at), after, before) {
				kept = append(kept, e)
			}
		}
		list = kept
	}
	if err := s.annotateProjects(r.Context(), entity, list...); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{r.PathValue("collection"): list})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	entity, ok := collection(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown collection")
		return
	}
	e, err := s.sync.Get(r.Context(), userFrom(r.Context()).ID, entity, r.PathValue("id"))
	if err != nil {
		s.internal(w, err)
		return
	}
	if e == nil || e.Deleted() {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	if err := s.annotateProjects(r.Context(), entity, e); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	entity, ok := collection(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown collection")
		return
	}
	var body map[string]json.RawMessage
	if err := readJSON(r, &body); err != nil {
		badBody(w, err)
		return
	}
	key, keyed, handled := idempotencyKey(w, r)
	if handled {
		return
	}
	uid := userFrom(r.Context()).ID
	now := time.Now().UnixMilli()
	id := ids.New()
	if keyed {
		id = s.idemEntityID(uid, r.PathValue("collection"), key)
	}
	if _, has := body["created_at"]; !has {
		body["created_at"] = json.RawMessage(fmt.Sprint(now))
	}
	if entity == "task" {
		if _, has := body["priority"]; !has {
			body["priority"] = json.RawMessage("4")
		}
	}
	if entity == "label" {
		if _, has := body["name"]; !has {
			body["name"] = json.RawMessage(`""`)
		}
		if _, has := body["color"]; !has {
			pick := int(now)
			if keyed {
				// A retried keyed create must plan the same colour.
				pick = int(id[0])
			}
			body["color"] = json.RawMessage(opsync.QuoteJSON(labelPalette[pick%len(labelPalette)]))
		}
	}
	if entity == "view" {
		applyViewDefaults(body)
	}
	if _, has := body["position"]; !has && entity != "reminder" {
		body["position"] = json.RawMessage(fmt.Sprint(now))
	}
	delete(body, "id")
	stripAnnotations(entity, body)
	if entity == "view" {
		if err := s.checkView(r.Context(), userFrom(r.Context()).ID, id, body, nil); err != nil {
			s.viewError(w, err)
			return
		}
	}
	if entity == "task" {
		canonicalizeRecurrence(body)
		// Custom field values become fields.<id> keys before an idempotent
		// replay compares the planned ops (custom-fields D3).
		if msg, err := s.checkTaskFields(r.Context(), uid, body, nil); err != nil {
			s.internal(w, err)
			return
		} else if msg != "" {
			writeError(w, http.StatusBadRequest, "invalid_input", msg)
			return
		}
	}
	if entity == "field" {
		if msg, err := s.checkField(r.Context(), uid, id, body, nil); err != nil {
			s.internal(w, err)
			return
		} else if msg != "" {
			writeError(w, http.StatusBadRequest, "invalid_input", msg)
			return
		}
	}
	if entity == "reminder" {
		if msg, err := s.completeReminderBody(r.Context(), userFrom(r.Context()).ID, body, nil); err != nil {
			s.internal(w, err)
			return
		} else if msg != "" {
			writeError(w, http.StatusBadRequest, "invalid_input", msg)
			return
		}
	}
	if keyed {
		state, err := s.replayState(r.Context(), uid, entity, id, body, func(f string) string { return idemOpID(id, f) })
		if err != nil {
			s.internal(w, err)
			return
		}
		switch state {
		case replayMatch:
			s.writeReplay(w, r, entity, id)
			return
		case replayConflict:
			writeIdempotencyConflict(w, "")
			return
		}
	}
	if msg, err := s.checkReferences(r.Context(), userFrom(r.Context()).ID, entity, body); err != nil {
		s.internal(w, err)
		return
	} else if msg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	if msg, err := s.checkSections(r.Context(), userFrom(r.Context()).ID, entity, body, nil); err != nil {
		s.internal(w, err)
		return
	} else if msg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	if err := s.validateParent(r.Context(), entity, id, body, nil); err != nil {
		s.parentError(w, err)
		return
	}
	if keyed {
		ts := s.opTS()
		ops := make([]opsync.Op, 0, len(body))
		for field, value := range body {
			ops = append(ops, opsync.Op{ID: idemOpID(id, field), Entity: entity, EntityID: id, Field: field, Value: value, TS: ts, Device: serverDevice})
		}
		s.writeOps(w, r, entity, id, ops, http.StatusCreated, body)
		return
	}
	s.writeFields(w, r, entity, id, body, http.StatusCreated)
}

// labelPalette gives API-created labels a colour when the caller sets none.
var labelPalette = []string{"#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"}

// checkReferences enforces the REST-only rules that the sync path cannot: a label
// needs a non-empty name, and a task may only reference existing, non-deleted labels.
// It returns a user-facing message when the body is rejected. Type errors are left
// to the schema validation in Apply so the two never disagree.
func (s *Server) checkReferences(ctx context.Context, uid, entity string, body map[string]json.RawMessage) (string, error) {
	if entity == "label" {
		if raw, has := body["name"]; has {
			var name string
			if err := json.Unmarshal(raw, &name); err == nil && strings.TrimSpace(name) == "" {
				return "label.name must not be empty", nil
			}
		}
	}
	if entity == "task" {
		if raw, has := body["labels"]; has {
			var ids []string
			if err := json.Unmarshal(raw, &ids); err != nil {
				return "", nil
			}
			for _, id := range ids {
				l, err := s.sync.Get(ctx, uid, "label", id)
				if err != nil {
					return "", err
				}
				if l == nil || l.Deleted() {
					return fmt.Sprintf("task.labels references unknown or deleted label %q", id), nil
				}
			}
		}
	}
	return "", nil
}

// errInvalidParent marks a parent_id rejected by validateTaskParent or validateProjectParent.
var errInvalidParent = errors.New("invalid parent")

// validateParent dispatches the tree rules of the entity being written.
func (s *Server) validateParent(ctx context.Context, entity, id string, body map[string]json.RawMessage, existing opsync.Entity) error {
	uid := userFrom(ctx).ID
	switch entity {
	case "task":
		return s.validateTaskParent(ctx, uid, id, body, existing)
	case "project":
		return s.validateProjectParent(ctx, uid, id, body)
	}
	return nil
}

func (s *Server) parentError(w http.ResponseWriter, err error) {
	if errors.Is(err, errInvalidParent) {
		writeError(w, http.StatusBadRequest, "invalid_input", strings.TrimPrefix(err.Error(), errInvalidParent.Error()+": "))
		return
	}
	s.internal(w, err)
}

// validateTaskParent enforces the subtask tree rules on REST writes (OpenSpec
// `subtasks`): a parent must exist and not be deleted, share the task's project,
// and must not be the task itself or one of its descendants. REST requests are
// handled sequentially against current state, so rejecting is safe here; sync
// ops are never rejected for tree reasons, clients break cycles by display.
func (s *Server) validateTaskParent(ctx context.Context, uid, id string, body map[string]json.RawMessage, existing opsync.Entity) error {
	raw, has := body["parent_id"]
	if !has || string(raw) == "null" {
		return nil
	}
	var parentID string
	if err := json.Unmarshal(raw, &parentID); err != nil || parentID == "" {
		return fmt.Errorf("%w: task.parent_id must be null or a task id", errInvalidParent)
	}
	if parentID == id {
		return fmt.Errorf("%w: task.parent_id: a task cannot be its own parent", errInvalidParent)
	}
	parent, err := s.sync.Get(ctx, uid, "task", parentID)
	if err != nil {
		return err
	}
	if parent == nil || parent.Deleted() {
		return fmt.Errorf("%w: task.parent_id: parent task not found", errInvalidParent)
	}
	project := idOf(body["project_id"])
	if _, has := body["project_id"]; !has && existing != nil {
		project = idOf(existing["project_id"])
	}
	if idOf(parent["project_id"]) != project {
		return fmt.Errorf("%w: task.parent_id: parent must be in the same project", errInvalidParent)
	}
	cycle, err := s.chainReaches(ctx, uid, "task", parentID, parent, id)
	if err != nil {
		return err
	}
	if cycle {
		return fmt.Errorf("%w: task.parent_id: parent is a descendant of the task", errInvalidParent)
	}
	return nil
}

// validateProjectParent enforces the project tree rules on REST writes (OpenSpec
// `project-hierarchy`): a parent must exist and not be deleted, and must not be
// the project itself or one of its descendants. Same reasoning as for tasks: REST
// is sequential against current state, sync ops are never rejected for tree reasons.
func (s *Server) validateProjectParent(ctx context.Context, uid, id string, body map[string]json.RawMessage) error {
	raw, has := body["parent_id"]
	if !has || string(raw) == "null" {
		return nil
	}
	var parentID string
	if err := json.Unmarshal(raw, &parentID); err != nil || parentID == "" {
		return fmt.Errorf("%w: project.parent_id must be null or a project id", errInvalidParent)
	}
	if parentID == id {
		return fmt.Errorf("%w: project.parent_id: a project cannot be its own parent", errInvalidParent)
	}
	parent, err := s.sync.Get(ctx, uid, "project", parentID)
	if err != nil {
		return err
	}
	if parent == nil || parent.Deleted() {
		return fmt.Errorf("%w: project.parent_id: parent project not found", errInvalidParent)
	}
	cycle, err := s.chainReaches(ctx, uid, "project", parentID, parent, id)
	if err != nil {
		return err
	}
	if cycle {
		return fmt.Errorf("%w: project.parent_id: parent is a descendant of the project", errInvalidParent)
	}
	return nil
}

// chainReaches walks parent pointers upwards from `start` in the materialized
// fields and reports whether `target` is on the chain, which would close a cycle.
// The visited set guards against a cycle that already exists in synced data, so
// the walk is bounded by the number of entities.
func (s *Server) chainReaches(ctx context.Context, uid, entity, startID string, start opsync.Entity, target string) (bool, error) {
	seen := map[string]bool{startID: true}
	for cur := start; cur != nil; {
		next := idOf(cur["parent_id"])
		if next == "" {
			return false, nil
		}
		if next == target {
			return true, nil
		}
		if seen[next] {
			return false, nil
		}
		seen[next] = true
		var err error
		if cur, err = s.sync.Get(ctx, uid, entity, next); err != nil {
			return false, err
		}
	}
	return false, nil
}

// idOf decodes a nullable id field; missing and null both read as "".
func idOf(raw json.RawMessage) string {
	var s string
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	_ = json.Unmarshal(raw, &s)
	return s
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request) {
	entity, ok := collection(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown collection")
		return
	}
	var body map[string]json.RawMessage
	if err := readJSON(r, &body); err != nil {
		badBody(w, err)
		return
	}
	delete(body, "id")
	stripAnnotations(entity, body)
	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "no fields to update")
		return
	}
	existing, err := s.sync.Get(r.Context(), userFrom(r.Context()).ID, entity, r.PathValue("id"))
	if err != nil {
		s.internal(w, err)
		return
	}
	if existing == nil {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	if msg, err := s.checkReferences(r.Context(), userFrom(r.Context()).ID, entity, body); err != nil {
		s.internal(w, err)
		return
	} else if msg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	if msg, err := s.checkSections(r.Context(), userFrom(r.Context()).ID, entity, body, existing); err != nil {
		s.internal(w, err)
		return
	} else if msg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	// Custom fields (custom-fields D3): task values against the definitions of
	// the task's project after the write; definitions keep project and type.
	var fieldMsg string
	switch entity {
	case "task":
		fieldMsg, err = s.checkTaskFields(r.Context(), userFrom(r.Context()).ID, body, existing)
	case "field":
		fieldMsg, err = s.checkField(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"), body, existing)
	}
	if err != nil {
		s.internal(w, err)
		return
	} else if fieldMsg != "" {
		writeError(w, http.StatusBadRequest, "invalid_input", fieldMsg)
		return
	}
	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "no fields to update")
		return
	}
	if err := s.validateParent(r.Context(), entity, r.PathValue("id"), body, existing); err != nil {
		s.parentError(w, err)
		return
	}
	if entity == "view" {
		if err := s.checkView(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"), body, existing); err != nil {
			s.viewError(w, err)
			return
		}
	}
	var extra []opsync.Op
	ts := s.opTS()
	if entity == "reminder" {
		if msg, err := s.completeReminderBody(r.Context(), userFrom(r.Context()).ID, body, existing); err != nil {
			s.internal(w, err)
			return
		} else if msg != "" {
			writeError(w, http.StatusBadRequest, "invalid_input", msg)
			return
		}
	}
	if entity == "task" {
		canonicalizeRecurrence(body)
		// Completing a recurring task records the occurrence and moves the series.
		recordID, record, ok, err := s.recurringCompletion(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"), body, existing, localToday(time.Now()))
		if err != nil {
			s.internal(w, err)
			return
		}
		if ok {
			extra = fieldOps("task", recordID, record, ts)
		}
		// Relative reminders follow the due date and deadline reminders the
		// deadline, stamped like the task op (reminders D2, deadlines D5).
		rops, err := s.reminderOpsForTask(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"), body, ts)
		if err != nil {
			s.internal(w, err)
			return
		}
		extra = append(extra, rops...)
	}
	s.writeFieldsAt(w, r, entity, r.PathValue("id"), body, http.StatusOK, extra, ts)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	entity, ok := collection(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "unknown collection")
		return
	}
	existing, err := s.sync.Get(r.Context(), userFrom(r.Context()).ID, entity, r.PathValue("id"))
	if err != nil {
		s.internal(w, err)
		return
	}
	if existing == nil || existing.Deleted() {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	body := map[string]json.RawMessage{"deleted_at": json.RawMessage(fmt.Sprint(time.Now().UnixMilli()))}
	ts := s.opTS()
	var extra []opsync.Op
	if entity == "section" {
		// Its open tasks fall back to "No section" in the same batch (board-view).
		if extra, err = s.sectionDeleteOps(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"), ts); err != nil {
			s.internal(w, err)
			return
		}
	}
	s.writeFieldsAt(w, r, entity, r.PathValue("id"), body, http.StatusNoContent, extra, ts)
}

// writeFields turns a REST body into ops stamped with server time and applies them.
func (s *Server) writeFields(w http.ResponseWriter, r *http.Request, entity, id string, body map[string]json.RawMessage, status int) {
	s.writeFieldsWith(w, r, entity, id, body, status, nil)
}

// fieldOps turns the fields of one entity into server-stamped ops.
func fieldOps(entity, id string, body map[string]json.RawMessage, ts int64) []opsync.Op {
	ops := make([]opsync.Op, 0, len(body))
	for field, value := range body {
		ops = append(ops, opsync.Op{ID: ids.New(), Entity: entity, EntityID: id, Field: field, Value: value, TS: ts, Device: serverDevice})
	}
	return ops
}

// writeFieldsWith is writeFields plus extra ops (other entities) applied in the
// same batch; the response still describes entity/id.
func (s *Server) writeFieldsWith(w http.ResponseWriter, r *http.Request, entity, id string, body map[string]json.RawMessage, status int, extra []opsync.Op) {
	s.writeFieldsAt(w, r, entity, id, body, status, extra, s.opTS())
}

// writeFieldsAt is writeFieldsWith with the body's op timestamp chosen by the caller.
func (s *Server) writeFieldsAt(w http.ResponseWriter, r *http.Request, entity, id string, body map[string]json.RawMessage, status int, extra []opsync.Op, ts int64) {
	s.writeOps(w, r, entity, id, append(fieldOps(entity, id, body, ts), extra...), status, nil)
}

// writeOps applies a REST write's ops and answers with entity/id. keyedBody is
// the planned body of an Idempotency-Key create (nil otherwise): a concurrent
// duplicate that applied nothing new answers as a replay or a conflict, and a
// refused keyed create as a conflict.
func (s *Server) writeOps(w http.ResponseWriter, r *http.Request, entity, id string, ops []opsync.Op, status int, keyedBody map[string]json.RawMessage) {
	uid := userFrom(r.Context()).ID
	keyed := keyedBody != nil
	// REST writes are all or nothing: one refused field refuses the request.
	res, err := s.sync.ApplyStrict(r.Context(), uid, ops)
	if err != nil {
		var rej *opsync.RejectedError
		switch {
		case keyed && errors.As(err, &rej) && rej.Reason == opsync.ReasonForbidden:
			// The derived id is taken by an entity this user may not write.
			writeIdempotencyConflict(w, "")
		case writeLimited(w, err):
		case errors.Is(err, opsync.ErrInvalidOp):
			writeError(w, http.StatusBadRequest, "invalid_input", err.Error())
		case errors.As(err, &rej) && rej.Reason == opsync.ReasonScopeChange:
			writeError(w, http.StatusBadRequest, "scope_change",
				"task.project_id: the target project is shared differently; create a copy there and delete this task instead")
		case errors.As(err, &rej) && rej.Reason == opsync.ReasonCycle:
			writeError(w, http.StatusBadRequest, "invalid_input",
				fmt.Sprintf("task.blocked_by: %q already waits for this task, so this would make it wait for itself", rej.Detail))
		case errors.As(err, &rej) && rej.Reason == opsync.ReasonNotInScope:
			writeError(w, http.StatusBadRequest, "invalid_input",
				fmt.Sprintf("task.blocked_by: %q is not in the same project sharing as this task (blockers must be shared the same way)", rej.Detail))
		case errors.As(err, &rej) && rej.Reason == opsync.ReasonNotAMember:
			writeError(w, http.StatusBadRequest, "not_a_member",
				"task.assignee_id: the assignee must be a member of the task's project (or yourself for a personal task)")
		case errors.As(err, &rej):
			writeError(w, http.StatusForbidden, "forbidden", "your role on this project does not allow changing "+rej.Op.Entity+"."+rej.Op.Field)
		default:
			s.internal(w, err)
		}
		return
	}
	if res.Applied > 0 {
		// REST writes come from no browser device, so every connected device is woken.
		s.sync.NotifyApplied(res, serverDevice)
	} else if keyed {
		// A concurrent request with the same key applied first.
		state, err := s.replayState(r.Context(), uid, entity, id, keyedBody, func(f string) string { return idemOpID(id, f) })
		if err != nil {
			s.internal(w, err)
			return
		}
		if state != replayMatch {
			writeIdempotencyConflict(w, "")
			return
		}
		s.writeReplay(w, r, entity, id)
		return
	}
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	e, err := s.sync.Get(r.Context(), uid, entity, id)
	if err != nil {
		s.internal(w, err)
		return
	}
	if err := s.annotateProjects(r.Context(), entity, e); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, status, e)
}
