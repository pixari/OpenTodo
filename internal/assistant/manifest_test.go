package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/pixari/opentodo/internal/agenttools"
)

// The on-device assistant's shared files (assistant-on-device D8): the
// manifest the browser loads, and the vectors that pin the browser's prompt
// and planners to the server's. `go test ./internal/assistant -run Device -update`
// rewrites them.

var update = flag.Bool("update", false, "rewrite the on-device assistant's manifest and vectors")

const deviceDir = "../../web/src/lib/assistantDevice"

func checkFile(t *testing.T, name string, v any) {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(deviceDir, name)
	if *update {
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, buf.Bytes()) {
		t.Fatalf("%s is out of date: run go test ./internal/assistant -run Device -update", path)
	}
}

func TestDeviceManifest(t *testing.T) {
	f := newFixture(t)
	m := DeviceManifest(f.loop.Tools)
	if len(m.Tools) != len(deviceTools) {
		t.Fatalf("manifest has %d tools, want %d", len(m.Tools), len(deviceTools))
	}
	for _, tool := range m.Tools {
		if notInApp[tool.Name] {
			t.Fatalf("%s is not offered in the app", tool.Name)
		}
	}
	// Pruned arguments never reach the device.
	raw, _ := json.Marshal(m.Tools)
	for _, gone := range []string{`"location"`, `"recurrence"`, `"fields"`, `"origin_url"`, `"workspace"`, `"cursor"`, `"client_request_id"`} {
		if strings.Contains(string(raw), gone) {
			t.Fatalf("manifest offers %s", gone)
		}
	}
	checkFile(t, "manifest.json", m)
}

// promptVector is one input of SystemPrompt and its text.
type promptVector struct {
	Name     string   `json:"name"`
	User     string   `json:"user"`
	Zone     string   `json:"zone"`
	Now      int64    `json:"now"`
	View     string   `json:"view,omitempty"`
	Selected []string `json:"selected,omitempty"`
	Skill    string   `json:"skill,omitempty"`
	Workday  *Workday `json:"workday,omitempty"`
	Want     string   `json:"want"`
}

func TestDevicePromptVectors(t *testing.T) {
	now := time.Date(2026, 10, 12, 22, 30, 0, 0, time.UTC).UnixMilli()
	vs := []promptVector{
		{Name: "plain", User: "Ada", Zone: "UTC", Now: now},
		{Name: "zone rolls the day", User: "", Zone: "Pacific/Auckland", Now: now, View: "today"},
		{Name: "selection and unknown view", User: "  Grace ", Zone: "Europe/Rome", Now: now, View: "nowhere", Selected: []string{"t1", "bad id!", "t-2"}},
		{Name: "plan week default day", User: "Ada", Zone: "UTC", Now: now, Skill: "plan-week"},
		{Name: "plan week own day", User: "Ada", Zone: "UTC", Now: now, Skill: "plan-week", Workday: &Workday{StartHour: 8, EndHour: 17, DayLength: 300}},
		{Name: "break down", User: "Ada", Zone: "UTC", Now: now, Skill: "break-down", View: "project", Selected: []string{"t1"}},
	}
	for i := range vs {
		v := &vs[i]
		loc, err := time.LoadLocation(v.Zone)
		if err != nil {
			t.Fatal(err)
		}
		in := TurnInput{UserName: v.User, Zone: loc, View: v.View, Selected: v.Selected, Workday: v.Workday}
		if v.Skill != "" {
			sk, _ := agenttools.SkillByID(v.Skill)
			in.Skill = &sk
		}
		v.Want = SystemPrompt(in, time.UnixMilli(v.Now))
	}
	checkFile(t, "prompt.vectors.json", vs)
}

// planVectors pin the browser's planners to Registry.Plan over the same rows.
type planVectors struct {
	User     string                      `json:"user"`
	Today    string                      `json:"today"`
	Rows     map[string][]map[string]any `json:"rows"`
	Cases    []planCase                  `json:"cases"`
	Comments string                      `json:"_comment"`
}

type planCase struct {
	Name    string          `json:"name"`
	Tool    string          `json:"tool"`
	Args    json.RawMessage `json:"args"`
	Error   string          `json:"error,omitempty"`
	Changes []any           `json:"changes,omitempty"`
}

func planRows() map[string][]map[string]any {
	return map[string][]map[string]any{
		"project": {
			{"id": "p1", "name": "Work", "color": "#2563eb", "position": 1, "archived": false, "parent_id": nil, "created_at": 1, "deleted_at": nil},
			{"id": "p2", "name": "Home", "color": "#16a34a", "position": 2, "archived": false, "parent_id": nil, "created_at": 1, "deleted_at": nil},
		},
		"label":   {{"id": "l1", "name": "urgent", "color": "#dc2626", "position": 1, "created_at": 1, "deleted_at": nil}},
		"section": {{"id": "s1", "project_id": "p1", "name": "Backlog", "position": 1, "created_at": 1, "deleted_at": nil}},
		"task": {
			{"id": "t1", "title": "Write report", "description": "", "project_id": "p1", "parent_id": nil, "priority": 2, "labels": []string{"l1"}, "due": map[string]any{"date": "2026-10-10"}, "completed_at": nil, "deleted_at": nil, "created_at": 1, "position": 1},
			{"id": "t2", "title": "Call plumber", "description": "", "project_id": "p2", "parent_id": nil, "priority": 4, "labels": []string{}, "due": map[string]any{"date": "2026-10-12", "time": "09:00"}, "completed_at": nil, "deleted_at": nil, "created_at": 1, "position": 2},
			{"id": "t3", "title": "Buy milk", "description": "", "project_id": nil, "parent_id": nil, "priority": 4, "labels": []string{}, "due": nil, "completed_at": nil, "deleted_at": nil, "created_at": 1, "position": 3},
			{"id": "t4", "title": "Old task", "description": "", "project_id": "p2", "parent_id": nil, "priority": 4, "labels": []string{}, "due": nil, "completed_at": 1700000000000, "deleted_at": nil, "created_at": 1, "position": 4},
			{"id": "t5", "title": "Water plants", "description": "", "project_id": "p2", "parent_id": nil, "priority": 4, "labels": []string{}, "due": map[string]any{"date": "2026-10-12"}, "recurrence": "every day", "completed_at": nil, "deleted_at": nil, "created_at": 1, "position": 5},
			{"id": "t6", "title": "Draft outline", "description": "", "project_id": "p1", "parent_id": "t1", "priority": 4, "labels": []string{}, "due": nil, "completed_at": nil, "deleted_at": nil, "created_at": 1, "position": 6},
		},
	}
}

var planCalls = []struct {
	name, tool string
	args       any
}{
	{"schedule keeps the time", "schedule_tasks", map[string]any{"ids": []string{"t1", "t2"}, "due": map[string]any{"date": "2026-10-16"}}},
	{"schedule clears", "schedule_tasks", map[string]any{"ids": []string{"t2"}, "due": nil}},
	{"schedule unknown task", "schedule_tasks", map[string]any{"ids": []string{"nope"}, "due": map[string]any{"date": "2026-10-16"}}},
	{"schedule bad date", "schedule_tasks", map[string]any{"ids": []string{"t1"}, "due": map[string]any{"date": "2026-02-30"}}},
	{"complete", "complete_tasks", map[string]any{"ids": []string{"t3", "t4"}, "timezone": "UTC"}},
	{"complete recurring", "complete_tasks", map[string]any{"ids": []string{"t5"}, "timezone": "UTC"}},
	{"reopen", "reopen_tasks", map[string]any{"ids": []string{"t4", "t3"}}},
	{"move to a section", "move_tasks", map[string]any{"ids": []string{"t3"}, "project_id": "p1", "section_id": "s1"}},
	{"move subtask without parent", "move_tasks", map[string]any{"ids": []string{"t6"}, "project_id": "p2"}},
	{"move to the inbox", "move_tasks", map[string]any{"ids": []string{"t2"}, "project_id": nil}},
	{"move section of another project", "move_tasks", map[string]any{"ids": []string{"t3"}, "project_id": "p2", "section_id": "s1"}},
	{"update planning fields", "update_tasks", map[string]any{"updates": []any{map[string]any{"id": "t1", "priority": 1, "labels": []string{}, "deadline": "2026-10-20", "start": "someday", "evening": true, "estimate_minutes": 45}}}},
	{"update labels by name and blockers", "update_tasks", map[string]any{"updates": []any{map[string]any{"id": "t3", "title": "  Buy oat milk ", "labels": []string{"URGENT"}, "blocked_by": []string{"t2", "t2"}}}}},
	{"update unknown label", "update_tasks", map[string]any{"updates": []any{map[string]any{"id": "t3", "labels": []string{"later"}}}}},
	{"update nothing", "update_tasks", map[string]any{"updates": []any{map[string]any{"id": "t3"}}}},
	{"create", "create_tasks", map[string]any{"items": []any{
		map[string]any{"id": "0b7c6f1e-2f43-4c55-9b7a-3f1f1e1a2b3c", "title": "Plan trip", "project_id": "p2", "due": map[string]any{"date": "2026-10-13", "time": "18:30"}, "labels": []string{"urgent"}, "estimate_minutes": 30, "priority": 2, "start": "2026-10-13", "blocked_by": []string{"t2"}},
		map[string]any{"id": "5d0e4b1c-8a3f-4e2b-9c1d-7e6f5a4b3c2d", "title": "Pack", "description": "Bags", "deadline": "2026-10-14", "evening": true},
	}}},
	{"create with a parent from the same call", "create_tasks", map[string]any{"items": []any{
		map[string]any{"id": "0b7c6f1e-2f43-4c55-9b7a-3f1f1e1a2b3c", "title": "Plan trip", "project_id": "p2", "due": map[string]any{"date": "2026-10-13"}, "labels": []string{"urgent"}, "estimate_minutes": 30, "priority": 2},
		map[string]any{"id": "5d0e4b1c-8a3f-4e2b-9c1d-7e6f5a4b3c2d", "title": "Pack", "parent_id": "0b7c6f1e-2f43-4c55-9b7a-3f1f1e1a2b3c", "deadline": "2026-10-14"},
	}}},
	{"create subtask takes parent project", "create_tasks", map[string]any{"items": []any{map[string]any{"id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "title": "Find sources", "parent_id": "t1"}}}},
	{"create in unknown project", "create_tasks", map[string]any{"items": []any{map[string]any{"title": "X", "project_id": "nope"}}}},
	{"create without title", "create_tasks", map[string]any{"items": []any{map[string]any{"title": "  "}}}},
	{"label exists", "create_label", map[string]any{"name": "Urgent"}},
	{"new label", "create_label", map[string]any{"name": "Errands", "color": "#AABBCC"}},
	{"new project", "create_project", map[string]any{"name": " Garden ", "parent_id": "p2"}},
	{"bad colour", "create_project", map[string]any{"name": "Garden", "color": "red"}},
	{"comment", "add_comment", map[string]any{"task_id": "t1", "body": "Looks good"}},
	{"trash a task the proposal did not create", "trash_tasks", map[string]any{"ids": []string{"t3"}}},
	{"unknown argument", "complete_tasks", map[string]any{"ids": []string{"t3"}, "now": true}},
}

// normalise replaces what differs between runs: timestamps and random ids.
func normalise(changes agenttools.ChangeSet, given map[string]bool) []any {
	var out []any
	for _, c := range changes {
		b, _ := json.Marshal(c)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if c.Create && !given[c.EntityID] && c.Entity != "task" {
			m["entityId"] = "<new>"
		}
		for _, k := range []string{"patch", "base"} {
			p, _ := m[k].(map[string]any)
			for f, v := range p {
				if n, ok := v.(float64); ok && n > 1e12 && (f == "created_at" || f == "position" || f == "completed_at" || f == "deleted_at") && k == "patch" {
					p[f] = "<ts>"
				}
			}
		}
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].(map[string]any), out[j].(map[string]any)
		return a["entity"].(string)+a["entityId"].(string) < b["entity"].(string)+b["entityId"].(string)
	})
	return out
}

func TestDevicePlanVectors(t *testing.T) {
	f := newFixture(t)
	rows := planRows()
	for _, entity := range []string{"project", "label", "section", "task"} {
		for _, r := range rows[entity] {
			fields := map[string]any{}
			for k, v := range r {
				if k != "id" {
					fields[k] = v
				}
			}
			f.put("u1", entity, r["id"].(string), fields)
		}
	}
	pv := planVectors{User: "u1", Today: "2026-10-12", Rows: rows,
		Comments: "Generated by go test ./internal/assistant -run DevicePlanVectors -update. Timestamps read <ts>; ids the planner chose read <new>."}
	for _, call := range planCalls {
		args, _ := json.Marshal(call.args)
		p, err := f.loop.Tools.Plan(context.Background(), Caller("u1"), call.tool, args, nil)
		c := planCase{Name: call.name, Tool: call.tool, Args: args}
		if err != nil {
			var te *agenttools.ToolError
			var ae *agenttools.ArgError
			switch {
			case errors.As(err, &te):
				c.Error = te.Code
			case errors.As(err, &ae):
				c.Error = "invalid_arguments"
			default:
				t.Fatalf("%s: %v", call.name, err)
			}
		} else {
			given := map[string]bool{}
			for _, ch := range p.Changes {
				if strings.Contains(string(args), `"`+ch.EntityID+`"`) {
					given[ch.EntityID] = true
				}
			}
			c.Changes = normalise(p.Changes, given)
		}
		pv.Cases = append(pv.Cases, c)
	}
	checkFile(t, "plan.vectors.json", pv)
}
