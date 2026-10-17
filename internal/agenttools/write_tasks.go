package agenttools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	opsync "github.com/pixari/opentodo/internal/sync"
)

// Task write tools: create, update, complete and reopen, move, schedule and
// trash (see write.go).

// ---- create_tasks ----

func (r *Registry) planCreateTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "items", "client_request_id"); err != nil {
		return Plan{}, err
	}
	list, err := a.items("items")
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
	var cs ChangeSet
	var out []map[string]any
	var refused []map[string]any
	for i, it := range list {
		p := fmt.Sprintf("items[%d].", i)
		if err := it.only(p, "title", "description", "project_id", "section_id", "parent_id", "priority", "due", "labels", "estimate_minutes", "recurrence", "fields"); err != nil {
			return Plan{}, err
		}
		title, _, err := it.text("title", true, 500)
		if err != nil {
			return Plan{}, argErr(p + err.Error())
		}
		desc, _, err := it.text("description", false, 20000)
		if err != nil {
			return Plan{}, argErr(p + err.Error())
		}
		id := entityID(seed, i)
		patch := map[string]json.RawMessage{
			"title": raw(strings.TrimSpace(title)), "description": raw(desc), "project_id": nullRaw, "parent_id": nullRaw,
			"priority": raw(4), "due": nullRaw, "labels": raw([]string{}), "position": raw(now + int64(i)),
			"created_at": raw(now), "completed_at": nullRaw, "deleted_at": nullRaw,
		}
		pid, err := it.str("project_id")
		if err != nil {
			return Plan{}, argErr(p + err.Error())
		}
		if pid != "" {
			if _, ok := snap.projects[pid]; !ok {
				return Plan{}, notFound("project", []string{pid})
			}
			patch["project_id"] = raw(pid)
			if role := snap.role(pid); !opsync.CanWrite(role, "task", "title") {
				refused = append(refused, map[string]any{"item": i, "project_id": pid, "reason": "forbidden", "role": role})
			}
		}
		if sid, err := it.str("section_id"); err != nil {
			return Plan{}, argErr(p + err.Error())
		} else if sid != "" {
			if proj, ok := snap.sectionProject[sid]; !ok || proj != pid {
				return Plan{}, argErr(p + "section_id: no such section in that project")
			}
			patch["section_id"] = raw(sid)
		}
		if parent, err := it.str("parent_id"); err != nil {
			return Plan{}, argErr(p + err.Error())
		} else if parent != "" {
			pt := snap.task(parent)
			if pt == nil {
				return Plan{}, notFound("task", []string{parent})
			}
			// A subtask without project_id goes where its parent is (assistant-skills:
			// models often name only the parent).
			if pp := rawStr(pt, "project_id"); pid == "" && !it.present("project_id") && pp != "" {
				pid = pp
				patch["project_id"] = raw(pid)
				if role := snap.role(pid); !opsync.CanWrite(role, "task", "title") {
					refused = append(refused, map[string]any{"item": i, "project_id": pid, "reason": "forbidden", "role": role})
				}
			}
			if rawStr(pt, "project_id") != pid {
				return Plan{}, argErr(p + "parent_id: the parent task must be in the same project")
			}
			patch["parent_id"] = raw(parent)
		}
		for _, f := range []string{"priority", "due", "estimate_minutes"} {
			if it.present(f) {
				patch[f] = it[f]
			}
		}
		if it.present("labels") {
			lids, err := snap.labelIDsFor(p, it["labels"])
			if err != nil {
				return Plan{}, err
			}
			patch["labels"] = raw(lids)
		}
		if it.present("recurrence") {
			if patch["recurrence"], err = canonicalRecurrence(p, it["recurrence"]); err != nil {
				return Plan{}, err
			}
		}
		if it.present("fields") {
			fp, err := snap.fieldPatch(p, pid, it["fields"], c.Encrypted)
			if err != nil {
				return Plan{}, err
			}
			for k, v := range fp {
				patch[k] = v
			}
		}
		if err := checkPatch(p, "task", id, patch); err != nil {
			return Plan{}, err
		}
		cs = append(cs, Change{Entity: "task", EntityID: id, Create: true, Patch: patch, opSeed: seed})
		out = append(out, map[string]any{"id": id, "status": "created"})
	}
	if len(refused) > 0 {
		return Plan{}, forbidden(refused)
	}
	return Plan{Result: result("create_tasks", out, len(cs)), Changes: cs, Count: len(cs)}, nil
}

// ---- update_tasks ----

func (r *Registry) planUpdateTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "updates"); err != nil {
		return Plan{}, err
	}
	list, err := a.items("updates")
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	var cs ChangeSet
	var out []map[string]any
	var missing []string
	var refused []map[string]any
	seen := map[string]bool{}
	for i, it := range list {
		p := fmt.Sprintf("updates[%d].", i)
		if err := it.only(p, "id", "title", "description", "priority", "labels", "estimate_minutes", "recurrence", "fields"); err != nil {
			return Plan{}, err
		}
		id, err := it.str("id")
		if err != nil || id == "" {
			return Plan{}, argErr(p + "id: the task id is required")
		}
		if seen[id] {
			return Plan{}, argErr(p + "id: each task may appear only once per call")
		}
		seen[id] = true
		patch := map[string]json.RawMessage{}
		if v, has, err := it.text("title", false, 500); err != nil {
			return Plan{}, argErr(p + err.Error())
		} else if has {
			if strings.TrimSpace(v) == "" {
				return Plan{}, argErr(p + "title: must not be empty")
			}
			patch["title"] = raw(strings.TrimSpace(v))
		}
		if v, has, err := it.text("description", false, 20000); err != nil {
			return Plan{}, argErr(p + err.Error())
		} else if has {
			patch["description"] = raw(v)
		}
		if it.present("priority") {
			patch["priority"] = it["priority"]
		}
		if _, ok := it["estimate_minutes"]; ok {
			patch["estimate_minutes"] = it["estimate_minutes"]
		}
		if it.present("labels") {
			lids, err := snap.labelIDsFor(p, it["labels"])
			if err != nil {
				return Plan{}, err
			}
			patch["labels"] = raw(lids)
		}
		if v, ok := it["recurrence"]; ok {
			if patch["recurrence"], err = canonicalRecurrence(p, v); err != nil {
				return Plan{}, err
			}
		}
		if len(patch) == 0 && !it.present("fields") {
			return Plan{}, argErr(p + "nothing to change: give at least one field besides id")
		}
		if err := checkPatch(p, "task", id, patch); err != nil {
			return Plan{}, err
		}
		t := snap.task(id)
		if t == nil {
			missing = append(missing, id)
			continue
		}
		// Custom field values (custom-fields D6): checked against the task's project.
		if it.present("fields") {
			fp, err := snap.fieldPatch(p, rawStr(t, "project_id"), it["fields"], c.Encrypted)
			if err != nil {
				return Plan{}, err
			}
			for k, v := range fp {
				patch[k] = v
			}
			if len(patch) == 0 {
				return Plan{}, argErr(p + "nothing to change: give at least one field besides id")
			}
			if err := checkPatch(p, "task", id, patch); err != nil {
				return Plan{}, err
			}
		}
		role := snap.role(rawStr(t, "project_id"))
		for f := range patch {
			if !opsync.CanWrite(role, "task", f) {
				refused = append(refused, map[string]any{"id": id, "reason": "forbidden", "role": role})
				break
			}
		}
		cs = append(cs, Change{Entity: "task", EntityID: id, Patch: patch, Base: base(t, patch)})
		out = append(out, map[string]any{"id": id, "status": "updated"})
	}
	if len(missing) > 0 {
		return Plan{}, notFound("task", missing)
	}
	if len(refused) > 0 {
		return Plan{}, forbidden(refused)
	}
	return Plan{Result: result("update_tasks", out, len(cs)), Changes: cs, Count: len(cs)}, nil
}

// ---- complete_tasks / reopen_tasks ----

func (r *Registry) planCompleteTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "ids", "timezone"); err != nil {
		return Plan{}, err
	}
	list, err := a.idList("ids")
	if err != nil {
		return Plan{}, err
	}
	today := r.today0()
	if tz, err := a.str("timezone"); err != nil {
		return Plan{}, err
	} else if tz != "" {
		loc, err := parseZone(tz, "timezone")
		if err != nil {
			return Plan{}, err
		}
		today = r.today(loc)
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	tasks, err := snap.lookupTasks(list)
	if err != nil {
		return Plan{}, err
	}
	if err := snap.checkTaskRoles(tasks, "completed_at"); err != nil {
		return Plan{}, err
	}
	now := stamp()
	var cs ChangeSet
	var out []map[string]any
	n := 0
	for _, t := range tasks {
		id := str(t, "id")
		if !isOpen(t) {
			out = append(out, map[string]any{"id": id, "status": "already_completed"})
			continue
		}
		body := map[string]json.RawMessage{"completed_at": raw(now)}
		// A recurring task records the occurrence and moves the series, through
		// the same rule as REST and CalDAV (recurring-tasks D5).
		recordID, record, ok, err := r.sync.RecurringCompletion(ctx, c.UserID, id, body, t, today)
		if err != nil {
			return Plan{}, err
		}
		cs = append(cs, Change{Entity: "task", EntityID: id, Patch: body, Base: base(t, body)})
		item := map[string]any{"id": id, "status": "completed"}
		if ok {
			cs = append(cs, Change{Entity: "task", EntityID: recordID, Create: true, Patch: record})
			item["status"] = "occurrence_completed"
			item["occurrence_id"] = recordID
			var d struct {
				Date string `json:"date"`
			}
			_ = json.Unmarshal(body["due"], &d)
			item["next_due"] = d.Date
		}
		out = append(out, item)
		n++
	}
	return Plan{Result: result("complete_tasks", out, n), Changes: cs, Count: n}, nil
}

func (r *Registry) planReopenTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	return r.planSimple(ctx, c, a, overlay, "reopen_tasks", func(t opsync.Entity) (map[string]json.RawMessage, string) {
		if isOpen(t) {
			return nil, "already_open"
		}
		return map[string]json.RawMessage{"completed_at": nullRaw}, "reopened"
	}, "completed_at")
}

// planSimple plans a per-task patch over an id list.
func (r *Registry) planSimple(ctx context.Context, c Caller, a args, overlay ChangeSet, name string,
	fn func(t opsync.Entity) (map[string]json.RawMessage, string), fields ...string) (Plan, error) {
	if err := a.only("", "ids"); err != nil {
		return Plan{}, err
	}
	list, err := a.idList("ids")
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	tasks, err := snap.lookupTasks(list)
	if err != nil {
		return Plan{}, err
	}
	if err := snap.checkTaskRoles(tasks, fields...); err != nil {
		return Plan{}, err
	}
	var cs ChangeSet
	var out []map[string]any
	for _, t := range tasks {
		id := str(t, "id")
		patch, status := fn(t)
		out = append(out, map[string]any{"id": id, "status": status})
		if patch != nil {
			cs = append(cs, Change{Entity: "task", EntityID: id, Patch: patch, Base: base(t, patch)})
		}
	}
	return Plan{Result: result(name, out, len(cs)), Changes: cs, Count: len(cs)}, nil
}

// ---- move_tasks ----

func (r *Registry) planMoveTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "ids", "project_id", "section_id"); err != nil {
		return Plan{}, err
	}
	list, err := a.idList("ids")
	if err != nil {
		return Plan{}, err
	}
	if _, ok := a["project_id"]; !ok {
		return Plan{}, argErr("project_id: is required (null moves to the inbox)")
	}
	pid, err := a.str("project_id")
	if err != nil {
		return Plan{}, err
	}
	sid, err := a.str("section_id")
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	if pid != "" {
		if _, ok := snap.projects[pid]; !ok {
			return Plan{}, notFound("project", []string{pid})
		}
	}
	if sid != "" {
		if proj, ok := snap.sectionProject[sid]; !ok || proj != pid {
			return Plan{}, argErr("section_id: no such section in the target project")
		}
	}
	tasks, err := snap.lookupTasks(list)
	if err != nil {
		return Plan{}, err
	}
	var refused []map[string]any
	moving := map[string]bool{}
	for _, t := range tasks {
		moving[str(t, "id")] = true
		from := rawStr(t, "project_id")
		if snap.scopeKey(from) != snap.scopeKey(pid) {
			refused = append(refused, map[string]any{"id": str(t, "id"), "reason": "scope_change"})
			continue
		}
		if role := snap.role(from); !opsync.CanWrite(role, "task", "project_id") {
			refused = append(refused, map[string]any{"id": str(t, "id"), "reason": "forbidden", "role": role})
		}
	}
	if len(refused) > 0 {
		code, msg := "forbidden", "your role in a shared project does not allow this change; nothing was changed"
		for _, it := range refused {
			if it["reason"] == "scope_change" {
				code, msg = "scope_change", "tasks cannot move between projects that are shared differently (or between a shared project and a personal one); nothing was changed"
			}
		}
		return Plan{}, &ToolError{Code: code, Message: msg, Data: map[string]any{"items": refused}}
	}
	target := nullRaw
	if pid != "" {
		target = raw(pid)
	}
	section := nullRaw
	if sid != "" {
		section = raw(sid)
	}
	var cs ChangeSet
	var out []map[string]any
	for _, t := range tasks {
		id := str(t, "id")
		patch := map[string]json.RawMessage{}
		if rawStr(t, "project_id") != pid {
			patch["project_id"] = target
		}
		if rawStr(t, "section_id") != sid {
			patch["section_id"] = section
		}
		// A subtask whose parent stays behind becomes a top-level task.
		if parent := rawStr(t, "parent_id"); parent != "" && !moving[parent] && patch["project_id"] != nil {
			patch["parent_id"] = nullRaw
		}
		if len(patch) == 0 {
			out = append(out, map[string]any{"id": id, "status": "unchanged"})
			continue
		}
		cs = append(cs, Change{Entity: "task", EntityID: id, Patch: patch, Base: base(t, patch)})
		out = append(out, map[string]any{"id": id, "status": "moved"})
	}
	return Plan{Result: result("move_tasks", out, len(cs)), Changes: cs, Count: len(cs)}, nil
}

// ---- schedule_tasks ----

func (r *Registry) planScheduleTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "ids", "due"); err != nil {
		return Plan{}, err
	}
	list, err := a.idList("ids")
	if err != nil {
		return Plan{}, err
	}
	rawDue, ok := a["due"]
	if !ok {
		return Plan{}, argErr("due: is required (null removes the due date)")
	}
	var want *struct {
		Date string           `json:"date"`
		Time *json.RawMessage `json:"time"`
		TZ   *json.RawMessage `json:"tz"`
	}
	if string(rawDue) != "null" {
		var probe map[string]json.RawMessage
		if json.Unmarshal(rawDue, &probe) != nil {
			return Plan{}, argErr("due: must be null or {\"date\":\"YYYY-MM-DD\",\"time\":\"HH:MM\"?,\"tz\":\"Area/City\"?}")
		}
		for k := range probe {
			if k != "date" && k != "time" && k != "tz" {
				return Plan{}, argErr("due." + k + ": unknown argument")
			}
		}
		if json.Unmarshal(rawDue, &want) != nil || want.Date == "" {
			return Plan{}, argErr("due.date: is required (YYYY-MM-DD)")
		}
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	tasks, err := snap.lookupTasks(list)
	if err != nil {
		return Plan{}, err
	}
	if err := snap.checkTaskRoles(tasks, "due"); err != nil {
		return Plan{}, err
	}
	var cs ChangeSet
	var out []map[string]any
	for _, t := range tasks {
		id := str(t, "id")
		next := nullRaw
		if want != nil {
			d := due{Date: want.Date}
			cur := taskDue(t)
			// Keep the time of day and zone unless time is given (null clears it).
			if want.Time != nil {
				if string(*want.Time) != "null" {
					var s string
					if json.Unmarshal(*want.Time, &s) != nil {
						return Plan{}, argErr("due.time: must be HH:MM or null")
					}
					d.Time = &s
				}
			} else if cur != nil {
				d.Time = cur.Time
			}
			if want.TZ != nil {
				if string(*want.TZ) != "null" {
					var s string
					if json.Unmarshal(*want.TZ, &s) != nil {
						return Plan{}, argErr("due.tz: must be an IANA time zone or null")
					}
					d.TZ = &s
				}
			} else if cur != nil && d.Time != nil {
				d.TZ = cur.TZ
			}
			next = raw(d)
		}
		patch := map[string]json.RawMessage{"due": next}
		if err := checkPatch("", "task", id, patch); err != nil {
			return Plan{}, err
		}
		if opsync.SameJSON(t["due"], next) {
			out = append(out, map[string]any{"id": id, "status": "unchanged"})
			continue
		}
		cs = append(cs, Change{Entity: "task", EntityID: id, Patch: patch, Base: base(t, patch)})
		out = append(out, map[string]any{"id": id, "status": "scheduled"})
	}
	return Plan{Result: result("schedule_tasks", out, len(cs)), Changes: cs, Count: len(cs)}, nil
}

// ---- trash_tasks ----

func (r *Registry) planTrashTasks(ctx context.Context, c Caller, a args, overlay ChangeSet) (Plan, error) {
	if err := a.only("", "ids"); err != nil {
		return Plan{}, err
	}
	list, err := a.idList("ids")
	if err != nil {
		return Plan{}, err
	}
	snap, err := r.loadFor(ctx, c, overlay)
	if err != nil {
		return Plan{}, err
	}
	tasks, err := snap.lookupTasks(list)
	if err != nil {
		return Plan{}, err
	}
	// Only the token's own creations (design D6): an assistant can clean up
	// after itself but cannot empty someone's project.
	var foreign []string
	for _, t := range tasks {
		id := str(t, "id")
		if overlayCreated(overlay, id) {
			continue
		}
		dev, err := r.sync.CreatedBy(ctx, c.UserID, "task", id)
		if err != nil {
			return Plan{}, err
		}
		if dev != c.Device() {
			foreign = append(foreign, id)
		}
	}
	if len(foreign) > 0 {
		return Plan{}, &ToolError{Code: "not_permitted", Message: "trash_tasks accepts only tasks created with this same token; nothing was changed",
			Data: map[string]any{"ids": foreign}}
	}
	if err := snap.checkTaskRoles(tasks, "deleted_at"); err != nil {
		return Plan{}, err
	}
	now := stamp()
	var cs ChangeSet
	var out []map[string]any
	for _, t := range tasks {
		patch := map[string]json.RawMessage{"deleted_at": raw(now)}
		cs = append(cs, Change{Entity: "task", EntityID: str(t, "id"), Patch: patch, Base: base(t, patch)})
		out = append(out, map[string]any{"id": str(t, "id"), "status": "trashed"})
	}
	return Plan{Result: result("trash_tasks", out, len(cs)), Changes: cs, Count: len(cs)}, nil
}

func overlayCreated(cs ChangeSet, id string) bool {
	for _, ch := range cs {
		if ch.Create && ch.EntityID == id {
			return true
		}
	}
	return false
}
