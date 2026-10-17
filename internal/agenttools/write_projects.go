package agenttools

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/pixari/opentodo/internal/ids"
)

// Project, label and comment write tools (see write.go).

// ---- create_project / create_label ----

func (r *Registry) planCreateProject(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "name", "color", "parent_id", "client_request_id"); err != nil {
		return Plan{}, err
	}
	name, _, err := a.text("name", true, 200)
	if err != nil {
		return Plan{}, err
	}
	color, err := a.color("#64748b")
	if err != nil {
		return Plan{}, err
	}
	seed, err := a.requestID(c)
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	now := stamp()
	id := entityID(seed, 0)
	patch := map[string]json.RawMessage{"name": raw(strings.TrimSpace(name)), "color": color, "position": raw(now),
		"archived": raw(false), "parent_id": nullRaw, "created_at": raw(now), "deleted_at": nullRaw}
	if parent, err := a.str("parent_id"); err != nil {
		return Plan{}, err
	} else if parent != "" {
		if _, ok := snap.projects[parent]; !ok {
			return Plan{}, notFound("project", []string{parent})
		}
		patch["parent_id"] = raw(parent)
	}
	if err := checkPatch("", "project", id, patch); err != nil {
		return Plan{}, err
	}
	cs := ChangeSet{{Entity: "project", EntityID: id, Create: true, Patch: patch, opSeed: seed}}
	return Plan{Result: result("create_project", []map[string]any{{"id": id, "status": "created"}}, 1), Changes: cs, Count: 1}, nil
}

func (r *Registry) planCreateLabel(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "name", "color", "client_request_id"); err != nil {
		return Plan{}, err
	}
	name, _, err := a.text("name", true, 100)
	if err != nil {
		return Plan{}, err
	}
	name = strings.TrimSpace(name)
	color, err := a.color("#64748b")
	if err != nil {
		return Plan{}, err
	}
	seed, err := a.requestID(c)
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	id := entityID(seed, 0)
	for _, l := range snap.labelList {
		lid := str(l, "id")
		if lid == id || strings.EqualFold(plainOrEmpty(l, "name"), name) {
			return Plan{Result: result("create_label", []map[string]any{{"id": lid, "status": "exists"}}, 0)}, nil
		}
	}
	now := stamp()
	patch := map[string]json.RawMessage{"name": raw(name), "color": color, "position": raw(now), "created_at": raw(now), "deleted_at": nullRaw}
	if err := checkPatch("", "label", id, patch); err != nil {
		return Plan{}, err
	}
	cs := ChangeSet{{Entity: "label", EntityID: id, Create: true, Patch: patch, opSeed: seed}}
	return Plan{Result: result("create_label", []map[string]any{{"id": id, "status": "created"}}, 1), Changes: cs, Count: 1}, nil
}

// ---- add_comment ----

func (r *Registry) planAddComment(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "task_id", "body", "parent_id"); err != nil {
		return Plan{}, err
	}
	taskID, err := a.str("task_id")
	if err != nil || taskID == "" {
		return Plan{}, argErr("task_id: the task id is required")
	}
	body, _, err := a.text("body", true, 10000)
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	if snap.task(taskID) == nil {
		return Plan{}, notFound("task", []string{taskID})
	}
	parent := nullRaw
	if pid, err := a.str("parent_id"); err != nil {
		return Plan{}, err
	} else if pid != "" {
		pc, err := r.sync.Get(ctx, c.UserID, "comment", pid)
		if err != nil {
			return Plan{}, err
		}
		if pc == nil || pc.Deleted() || rawStr(pc, "task_id") != taskID {
			return Plan{}, argErr("parent_id: must be a comment on the same task")
		}
		parent = raw(pid)
	}
	id := ids.New()
	now := stamp()
	// mentions stays empty: assistant comments never notify (design D9.3).
	patch := map[string]json.RawMessage{
		"task_id": raw(taskID), "author_id": raw(c.UserID), "body": raw(body), "parent_id": parent,
		"mentions": raw([]string{}), "created_at": raw(now), "edited_at": nullRaw, "deleted_at": nullRaw,
	}
	if err := checkPatch("", "comment", id, patch); err != nil {
		return Plan{}, err
	}
	cs := ChangeSet{{Entity: "comment", EntityID: id, Create: true, Patch: patch}}
	return Plan{Result: result("add_comment", []map[string]any{{"id": id, "status": "created", "task_id": taskID}}, 1), Changes: cs, Count: 1}, nil
}
