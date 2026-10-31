package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/OpenTodoApp/opentodo/internal/filter"
	"github.com/OpenTodoApp/opentodo/internal/iconset"
	opsync "github.com/OpenTodoApp/opentodo/internal/sync"
)

// Saved views (OpenSpec `custom-views`) use the generic collection handlers; this file
// holds the REST-only rules. Sync accepts any string for the enumerations so a future
// value stays additive (clients fall back to defaults at read time), while REST is
// sequential against current state and can safely reject (design D1, D6).

// maxPanels caps how many views a dashboard shows.
const maxPanels = 6

var (
	viewKinds   = []string{"list", "dashboard"}
	viewGroupBy = []string{"project", "due", "priority", "label", "none"}
	viewSortBy  = []string{"due", "priority", "position", "created", "title", "deadline"}
	viewSortDir = []string{"asc", "desc"}
	viewLayouts = []string{"list", "board"}
	// viewRowLayouts: one line or detailed rows; "" follows the account's choice (row-layouts D1).
	viewRowLayouts = []string{"", "line", "detailed"}
	viewEnumSets   = map[string][]string{"kind": viewKinds, "group_by": viewGroupBy, "sort_dir": viewSortDir, "layout": viewLayouts, "row_layout": viewRowLayouts}
	// viewRowProps are the row properties a view can hide (views-and-display D3).
	viewRowProps = []string{"date", "project", "labels", "estimate", "assignee", "deadline", "start", "origin", "energy"}
	// viewDefaults are written on create for every field the caller leaves out.
	viewDefaults = map[string]json.RawMessage{
		"kind":     json.RawMessage(`"list"`),
		"group_by": json.RawMessage(`"project"`),
		"sort_by":  json.RawMessage(`"due"`),
		"sort_dir": json.RawMessage(`"asc"`),
		"pinned":   json.RawMessage(`false`),
		"color":    json.RawMessage(`"#64748b"`),
		"panels":   json.RawMessage(`[]`),
		// layout, show_completed and hidden_props are left out: absent reads as the list
		// layout, completed matches hidden and every row property shown (views-and-display).
	}
)

// errInvalidView marks a body rejected by checkView; the message names the field.
var errInvalidView = errors.New("invalid view")

func invalidView(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errInvalidView, fmt.Sprintf(format, args...))
}

// applyViewDefaults fills the defaults of a view being created.
func applyViewDefaults(body map[string]json.RawMessage) {
	for f, v := range viewDefaults {
		if _, has := body[f]; !has {
			body[f] = v
		}
	}
	if _, has := body["query"]; !has && kindOf(body, nil) == "dashboard" {
		body["query"] = json.RawMessage(`""`)
	}
}

// kindOf is the view's kind after the write: the body's value, else the stored one,
// else "list" (the default for rows written by sync without a kind).
func kindOf(body map[string]json.RawMessage, existing opsync.Entity) string {
	for _, src := range []map[string]json.RawMessage{body, existing} {
		if raw, ok := src["kind"]; ok {
			var k string
			if json.Unmarshal(raw, &k) == nil {
				return k
			}
		}
	}
	return "list"
}

// checkView validates a view create (existing == nil) or patch. Values of the wrong
// JSON type are left to the op schema validation in Apply so the two never disagree.
func (s *Server) checkView(ctx context.Context, uid, id string, body map[string]json.RawMessage, existing opsync.Entity) error {
	str := func(field string) (string, bool) {
		raw, has := body[field]
		if !has {
			return "", false
		}
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return "", false
		}
		return v, true
	}
	if existing == nil {
		if _, has := body["name"]; !has {
			return invalidView("view.name is required")
		}
		if _, has := body["query"]; !has {
			return invalidView("view.query is required")
		}
	}
	if name, ok := str("name"); ok && strings.TrimSpace(name) == "" {
		return invalidView("view.name must not be empty")
	}
	if sortBy, ok := str("sort_by"); ok && !slices.Contains(viewSortBy, sortBy) && !validViewSortBy(sortBy) {
		return invalidView("view.sort_by must be one of %s or field:<id>", strings.Join(viewSortBy, ", "))
	}
	for field, allowed := range viewEnumSets {
		if v, ok := str(field); ok && !slices.Contains(allowed, v) {
			return invalidView("view.%s must be one of %s", field, strings.Join(allowed, ", "))
		}
	}
	if existing != nil {
		if k, ok := str("kind"); ok && k != kindOf(nil, existing) {
			return invalidView("view.kind cannot be changed after creation")
		}
	}
	kind := kindOf(body, existing)
	if q, ok := str("query"); ok {
		if strings.TrimSpace(q) == "" && kind == "list" {
			return invalidView("view.query must not be empty")
		}
		if err := filter.Parse(q); err != nil {
			return invalidView("view.query: %s", err.Error())
		}
	}
	// The view's icon (sidebar-polish D4): null or a name from the icon catalogue. Sync
	// accepts any string so a newer catalogue stays additive; REST checks the name.
	if raw, has := body["icon"]; has && string(raw) != "null" {
		var name string
		if json.Unmarshal(raw, &name) != nil || !iconset.Valid(name) {
			return invalidView("view.icon must be a name from the icon catalogue or null, got %s", raw)
		}
	}
	if raw, has := body["on_drop"]; has {
		if err := s.checkOnDrop(ctx, uid, kind, raw); err != nil {
			return err
		}
	}
	if raw, has := body["hidden_props"]; has {
		var props []string
		if json.Unmarshal(raw, &props) == nil {
			for _, p := range props {
				if !slices.Contains(viewRowProps, p) {
					return invalidView("view.hidden_props: %q is not one of %s", p, strings.Join(viewRowProps, ", "))
				}
			}
		}
	}
	if raw, has := body["panels"]; has {
		var panels []string
		if json.Unmarshal(raw, &panels) != nil {
			return nil
		}
		if kind != "dashboard" && len(panels) > 0 {
			return invalidView("view.panels is only allowed on dashboards")
		}
		if len(panels) > maxPanels {
			return invalidView("view.panels holds at most %d views", maxPanels)
		}
		seen := map[string]bool{}
		for _, pid := range panels {
			if pid == id {
				return invalidView("view.panels: a dashboard cannot contain itself")
			}
			if seen[pid] {
				return invalidView("view.panels: view %q is listed twice", pid)
			}
			seen[pid] = true
			p, err := s.sync.Get(ctx, uid, "view", pid)
			if err != nil {
				return err
			}
			if p == nil || p.Deleted() {
				return invalidView("view.panels references unknown or deleted view %q", pid)
			}
			if kindOf(nil, p) != "list" {
				return invalidView("view.panels: view %q is not a list view (dashboards cannot be nested)", pid)
			}
		}
	}
	return nil
}

// validViewSortBy accepts a canonical UUID field definition id after the built-in sort options.
func validViewSortBy(value string) bool {
	id, ok := strings.CutPrefix(value, "field:")
	if !ok || len(id) != 36 {
		return false
	}
	for i, ch := range id {
		if i == 14 && (ch < '1' || ch > '8') {
			return false
		}
		if i == 19 && ch != '8' && ch != '9' && ch != 'a' && ch != 'b' {
			return false
		}
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if ch != '-' {
				return false
			}
			continue
		}
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
			return false
		}
	}
	return true
}

// checkOnDrop validates a view's on-drop rule against current state (OpenSpec
// change rule-boards, design D2): list views only, the shape of the op kind, label
// ids that exist and are not deleted, and a section of the named project. The
// value is written whole, so a patch replaces the rule.
func (s *Server) checkOnDrop(ctx context.Context, uid, kind string, raw json.RawMessage) error {
	if string(raw) == "null" {
		return nil
	}
	if kind != "list" {
		return invalidView("view.on_drop is only allowed on list views")
	}
	rule, err := opsync.ParseRule(raw)
	if err != nil {
		return invalidView("view.on_drop: %s", err.Error())
	}
	live := func(entity, id string) (opsync.Entity, error) {
		e, err := s.sync.Get(ctx, uid, entity, id)
		if err != nil || e == nil || e.Deleted() {
			return nil, err
		}
		return e, nil
	}
	for field, ids := range map[string][]string{"add_labels": rule.AddLabels, "remove_labels": rule.RemoveLabels} {
		for _, lid := range ids {
			l, err := live("label", lid)
			if err != nil {
				return err
			}
			if l == nil {
				return invalidView("view.on_drop.%s references unknown or deleted label %q", field, lid)
			}
		}
	}
	if sec := rule.Section; sec != nil {
		p, err := live("project", sec.ProjectID)
		if err != nil {
			return err
		}
		if p == nil {
			return invalidView("view.on_drop.section references unknown or deleted project %q", sec.ProjectID)
		}
		if sec.SectionID != nil {
			row, err := live("section", *sec.SectionID)
			if err != nil {
				return err
			}
			if row == nil || idOf(row["project_id"]) != sec.ProjectID {
				return invalidView("view.on_drop.section: section %q is not a section of project %q", *sec.SectionID, sec.ProjectID)
			}
		}
	}
	return nil
}

// viewError answers 400 invalid_input for a rejected view body and 500 otherwise.
func (s *Server) viewError(w http.ResponseWriter, err error) {
	if errors.Is(err, errInvalidView) {
		writeError(w, http.StatusBadRequest, "invalid_input", strings.TrimPrefix(err.Error(), errInvalidView.Error()+": "))
		return
	}
	s.internal(w, err)
}
