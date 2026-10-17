package agenttools

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/ids"
	"github.com/pixari/opentodo/internal/recurrence"
	opsync "github.com/pixari/opentodo/internal/sync"
)

// Shared planning helpers of the write tools (see write.go).

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

var nullRaw = json.RawMessage("null")

// loadFor is load plus the overlay of changes planned earlier in the turn.
func (r *Registry) loadFor(ctx context.Context, c Caller, overlay ChangeSet) (*snapshot, error) {
	snap, err := r.load(ctx, c.UserID)
	if err != nil {
		return nil, err
	}
	snap.apply(overlay)
	return snap, nil
}

// apply lays planned changes over the snapshot (in-app assistant turns).
func (snap *snapshot) apply(cs ChangeSet) {
	for _, ch := range cs {
		switch ch.Entity {
		case "task":
			found := false
			for i, t := range snap.tasks {
				if str(t, "id") == ch.EntityID {
					snap.tasks[i] = merge(t, ch.Patch)
					found = true
				}
			}
			if !found && ch.Create {
				snap.tasks = append(snap.tasks, merge(opsync.Entity{"id": raw(ch.EntityID)}, ch.Patch))
			}
		case "project":
			p, ok := snap.projects[ch.EntityID]
			if !ok && !ch.Create {
				continue
			}
			if !ok {
				p = opsync.Entity{"id": raw(ch.EntityID)}
			}
			p = merge(p, ch.Patch)
			snap.projects[ch.EntityID] = p
			if !ok {
				snap.projList = append(snap.projList, p)
			}
		case "label":
			if _, ok := snap.labels[ch.EntityID]; ok || ch.Create {
				l := merge(opsync.Entity{"id": raw(ch.EntityID)}, ch.Patch)
				snap.labels[ch.EntityID] = str(l, "name")
				snap.labelList = append(snap.labelList, l)
			}
		}
	}
	// Planned tombstones disappear like synced ones.
	live := snap.tasks[:0]
	for _, t := range snap.tasks {
		if !deleted(t) {
			live = append(live, t)
		}
	}
	snap.tasks = live
}

func merge(e opsync.Entity, patch map[string]json.RawMessage) opsync.Entity {
	out := opsync.Entity{}
	for k, v := range e {
		out[k] = v
	}
	for k, v := range patch {
		out[k] = v
	}
	return out
}

func deleted(e opsync.Entity) bool {
	v, ok := e["deleted_at"]
	return ok && string(v) != "null" && len(v) > 0
}

func (snap *snapshot) task(id string) opsync.Entity {
	for _, t := range snap.tasks {
		if str(t, "id") == id {
			return t
		}
	}
	return nil
}

// role is the caller's role for a task in project pid ("owner" for personal).
func (snap *snapshot) role(pid string) string {
	if acc, ok := snap.shared[pid]; ok {
		return acc.Role
	}
	return opsync.RoleOwner
}

// scopeKey identifies the sharing scope of a project id ("" = personal).
func (snap *snapshot) scopeKey(pid string) string {
	if _, ok := snap.shared[pid]; ok {
		return "project:" + pid
	}
	return "personal"
}

// notFound is the tool error for ids that are unknown, deleted or foreign
// (indistinguishable on purpose).
func notFound(entity string, missing []string) *ToolError {
	return &ToolError{Code: "not_found", Message: fmt.Sprintf("no such %s (unknown, deleted, or not visible to you); nothing was changed", entity),
		Data: map[string]any{"ids": missing}}
}

func forbidden(items []map[string]any) *ToolError {
	return &ToolError{Code: "forbidden", Message: "your role in a shared project does not allow this change; nothing was changed",
		Data: map[string]any{"items": items}}
}

// idList reads a bounded list of distinct, non-empty ids.
func (a args) idList(name string) ([]string, error) {
	if !a.present(name) {
		return nil, argErr(name + ": is required")
	}
	var list []string
	if json.Unmarshal(a[name], &list) != nil {
		return nil, argErr(name + ": must be an array of strings")
	}
	if len(list) == 0 {
		return nil, argErr(name + ": must not be empty")
	}
	if len(list) > PerCall {
		return nil, argErr(fmt.Sprintf("%s: at most %d items per call (got %d); split the work into several calls", name, PerCall, len(list)))
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(list))
	for _, id := range list {
		id = strings.TrimSpace(id)
		if id == "" || len(id) > opsync.MaxIDLen {
			return nil, argErr(name + ": ids must be non-empty strings")
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// items reads a bounded array of objects.
func (a args) items(name string) ([]args, error) {
	if !a.present(name) {
		return nil, argErr(name + ": is required")
	}
	var list []args
	if json.Unmarshal(a[name], &list) != nil {
		return nil, argErr(name + ": must be an array of objects")
	}
	if len(list) == 0 {
		return nil, argErr(name + ": must not be empty")
	}
	if len(list) > PerCall {
		return nil, argErr(fmt.Sprintf("%s: at most %d items per call (got %d); split the work into several calls", name, PerCall, len(list)))
	}
	for i, it := range list {
		if it == nil {
			return nil, argErr(fmt.Sprintf("%s[%d]: must be an object", name, i))
		}
	}
	return list, nil
}

// only refuses argument names outside allowed (additionalProperties: false).
func (a args) only(prefix string, allowed ...string) error {
	ok := map[string]bool{}
	for _, k := range allowed {
		ok[k] = true
	}
	for k := range a {
		if !ok[k] {
			return argErr(prefix + k + ": unknown argument")
		}
	}
	return nil
}

// text reads a required (or optional) string with a length cap.
func (a args) text(name string, required bool, maxLen int) (string, bool, error) {
	if !a.present(name) {
		if required {
			return "", false, argErr(name + ": is required")
		}
		return "", false, nil
	}
	var v string
	if json.Unmarshal(a[name], &v) != nil {
		return "", false, argErr(name + ": must be a string")
	}
	if required && strings.TrimSpace(v) == "" {
		return "", false, argErr(name + ": must not be empty")
	}
	if len([]rune(v)) > maxLen {
		return "", false, argErr(fmt.Sprintf("%s: at most %d characters", name, maxLen))
	}
	return v, true, nil
}

// checkPatch runs the op schema validation every REST and sync write passes,
// so a planned change can never fail it later (shared with REST).
func checkPatch(prefix, entity, id string, patch map[string]json.RawMessage) error {
	// Assistants get a real calendar date (the op schema checks the shape only).
	if d := taskDue(opsync.Entity{"due": patch["due"]}); d != nil {
		if t, err := time.Parse("2006-01-02", d.Date); err != nil || t.Format("2006-01-02") != d.Date {
			return argErr(prefix + "due.date: must be a calendar date in YYYY-MM-DD form")
		}
	}
	for f, v := range patch {
		if err := opsync.Validate(opsync.Op{ID: "plan", Entity: entity, EntityID: id, Field: f, Value: v, TS: 1, Device: "plan"}); err != nil {
			return argErr(prefix + strings.TrimPrefix(err.Error(), opsync.ErrInvalidOp.Error()+": "))
		}
	}
	return nil
}

// labelIDsFor resolves label names (case-insensitive) or ids.
func (snap *snapshot) labelIDsFor(prefix string, raw json.RawMessage) ([]string, error) {
	var names []string
	if json.Unmarshal(raw, &names) != nil || names == nil {
		return nil, argErr(prefix + "labels: must be an array of strings")
	}
	if len(names) > 50 {
		return nil, argErr(prefix + "labels: at most 50 labels")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, n := range names {
		var id string
		if _, ok := snap.labels[n]; ok {
			id = n
		} else {
			// Names match plaintext only: an encrypted name reads as a
			// placeholder and must never match by accident.
			for _, l := range snap.labelList {
				if name := plainOrEmpty(l, "name"); name != "" && strings.EqualFold(strings.TrimSpace(n), name) {
					id = str(l, "id")
					break
				}
			}
		}
		if id == "" {
			return nil, argErr(fmt.Sprintf("%slabels: no label named %q (create it with create_label first)", prefix, n))
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func canonicalRecurrence(prefix string, rawRule json.RawMessage) (json.RawMessage, error) {
	if string(rawRule) == "null" {
		return nullRaw, nil
	}
	var rule string
	if json.Unmarshal(rawRule, &rule) != nil {
		return nil, argErr(prefix + "recurrence: must be a string or null")
	}
	c, err := recurrence.Canonicalize(rule)
	if err != nil {
		return nil, argErr(prefix + "recurrence: " + err.Error())
	}
	return raw(c), nil
}

// requestID derives entity ids from client_request_id (design D4): the same
// user, token and request id always name the same entities and op ids.
func (a args) requestID(c Caller) (string, error) {
	v, has, err := a.text("client_request_id", false, 100)
	if err != nil || !has {
		return "", err
	}
	if strings.TrimSpace(v) == "" {
		return "", argErr("client_request_id: must not be empty")
	}
	return requestSeed(c, v), nil
}

func requestSeed(c Caller, v string) string {
	return ids.NameID("agent-request", c.UserID+"\x00"+c.TokenID+"\x00"+v)
}

func entityID(seed string, i int) string {
	if seed == "" {
		return ids.New()
	}
	return ids.NameID("agent-entity", seed+":"+strconv.Itoa(i))
}

var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (a args) color(def string) (json.RawMessage, error) {
	v, has, err := a.text("color", false, 7)
	if err != nil {
		return nil, err
	}
	if !has {
		return raw(def), nil
	}
	if !colorRe.MatchString(v) {
		return nil, argErr("color: must be #rrggbb")
	}
	return raw(strings.ToLower(v)), nil
}

func result(tool string, items []map[string]any, changed int) map[string]any {
	return map[string]any{"tool": tool, "results": items, "changed": changed,
		"undo": "Every change is in the task's history; completed tasks can be reopened and trashed tasks restored from the Trash."}
}

// base records the planned-over values of the patched fields.
func base(e opsync.Entity, patch map[string]json.RawMessage) map[string]json.RawMessage {
	b := map[string]json.RawMessage{}
	for f := range patch {
		if v, ok := e[f]; ok {
			b[f] = v
		} else {
			b[f] = nullRaw
		}
	}
	return b
}

// lookupTasks resolves ids to live tasks, refusing unknown ones as a group.
func (snap *snapshot) lookupTasks(list []string) ([]opsync.Entity, error) {
	out := make([]opsync.Entity, 0, len(list))
	var missing []string
	for _, id := range list {
		t := snap.task(id)
		if t == nil {
			missing = append(missing, id)
			continue
		}
		out = append(out, t)
	}
	if len(missing) > 0 {
		return nil, notFound("task", missing)
	}
	return out, nil
}

// checkTaskRoles refuses, as a group, tasks whose shared project does not let
// the caller write the given fields (ApplyStrict enforces the same table).
func (snap *snapshot) checkTaskRoles(tasks []opsync.Entity, fields ...string) error {
	var refused []map[string]any
	for _, t := range tasks {
		role := snap.role(rawStr(t, "project_id"))
		for _, f := range fields {
			if !opsync.CanWrite(role, "task", f) {
				refused = append(refused, map[string]any{"id": str(t, "id"), "reason": "forbidden", "role": role})
				break
			}
		}
	}
	if len(refused) > 0 {
		return forbidden(refused)
	}
	return nil
}
