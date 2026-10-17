package importer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"

	"github.com/pixari/opentodo/internal/recurrence"
	opsync "github.com/pixari/opentodo/internal/sync"
)

// Planning an import of OpenTodo's own export (opentodo-export files and
// their ZIP form).

func (pl *planner) planOwn(rows []Row) []change {
	var out []change
	fileTasks := map[string]bool{}
	for _, row := range rows {
		if row.Kind == KindTask && row.SourceID != "" {
			fileTasks[row.SourceID] = true
		}
	}
	for i, row := range rows {
		res := &pl.results[i]
		if row.Err != "" {
			res.Outcome, res.Reason = OutcomeError, row.Err
			continue
		}
		names := make([]string, 0, len(row.Entity))
		for k := range row.Entity {
			names = append(names, k)
		}
		sort.Strings(names)
		var fields []field
		for _, k := range names {
			if k == "id" {
				continue
			}
			if row.Kind == KindProject && (k == "role" || k == "owner_id") {
				continue // read-only sharing annotations of the export, not data
			}
			if !opsync.KnownField(row.Kind, k) {
				res.Warnings = append(res.Warnings, fmt.Sprintf("unknown field %q dropped", k))
				continue
			}
			fields = append(fields, field{k, row.Entity[k]})
		}
		switch row.Kind {
		case KindTask:
			fields = pl.ownTask(fields, res)
		case KindReminder:
			var task string
			_ = json.Unmarshal(row.Entity["task_id"], &task)
			if task != "" && !fileTasks[task] && pl.byKind[KindTask][task] == nil {
				res.Outcome, res.Reason = OutcomeError, fmt.Sprintf("task %s is neither in the file nor in your account", task)
				continue
			}
			fields = pl.ownReminder(fields, res)
		case KindAttachment:
			var task string
			_ = json.Unmarshal(row.Entity["task_id"], &task)
			if task != "" && !fileTasks[task] && pl.byKind[KindTask][task] == nil {
				res.Outcome, res.Reason = OutcomeError, fmt.Sprintf("task %s is neither in the file nor in your account", task)
				continue
			}
			var ok bool
			if fields, ok = pl.ownAttachment(row, fields, res); !ok {
				continue
			}
		}
		if err := validateFields(row.Kind, row.SourceID, fields); err != nil {
			res.Outcome, res.Reason = OutcomeError, err.Error()
			continue
		}
		existing := pl.byKind[row.Kind][row.SourceID]
		switch {
		case existing == nil:
			res.Outcome = OutcomeCreate
			c := change{entity: row.Kind, id: row.SourceID, fields: fields, created: true, sourceID: row.SourceID}
			if row.Kind == KindAttachment {
				c.file = pl.files[row.SourceID]
			}
			out = append(out, c)
		case existing.Deleted():
			// Never resurrect: a tombstone wins over anything an import carries.
			res.Outcome, res.Reason = OutcomeSkip, ReasonDeleted
		case pl.opts.Existing != "overwrite":
			res.Outcome, res.Reason = OutcomeSkip, ReasonExists
		default:
			var diff []field
			for _, f := range fields {
				if !jsonEqual(existing[f.name], f.value) {
					diff = append(diff, f)
				}
			}
			if len(diff) == 0 {
				res.Outcome, res.Reason = OutcomeSkip, ReasonUnchanged
				continue
			}
			res.Outcome = OutcomeUpdate
			out = append(out, change{entity: row.Kind, id: row.SourceID, fields: diff, sourceID: row.SourceID})
		}
	}
	return out
}

// ownAttachment adapts an exported attachment to this account (attachments D12):
// the importing account becomes its author (comments are not imported, so a
// comment link is dropped), uploaded_at is the server's to write once the file is
// stored, and a file attachment needs its file from the ZIP export.
func (pl *planner) ownAttachment(row Row, fields []field, res *RowResult) ([]field, bool) {
	isLink := !isNull(row.Entity["url"])
	if !isLink && len(row.Entity["url"]) == 0 {
		isLink = false
	}
	if !isLink && pl.files[row.SourceID] == nil {
		res.Outcome, res.Reason = OutcomeSkip, "the file is not in this import (use the ZIP export)"
		return nil, false
	}
	out := fields[:0]
	for _, f := range fields {
		switch f.name {
		case "uploaded_at":
			continue
		case "author_id":
			f.value = raw(pl.st.UserID)
		case "comment_id":
			f.value = json.RawMessage("null")
		}
		out = append(out, f)
	}
	return out, true
}

// ownTask stores the rule in canonical form and keeps an assignee only when it
// is the importing account (anyone else is not a member here, design D2).
func (pl *planner) ownTask(fields []field, res *RowResult) []field {
	out := fields[:0]
	for _, f := range fields {
		switch f.name {
		case "recurrence":
			var rule string
			if json.Unmarshal(f.value, &rule) == nil && rule != "" {
				if c, err := recurrence.Canonicalize(rule); err == nil {
					f.value = raw(c)
				}
			}
		case "assignee_id":
			var who string
			if json.Unmarshal(f.value, &who) == nil && who != "" && who != pl.st.UserID {
				res.Warnings = append(res.Warnings, "assignee dropped (only your own account can be assigned by an import)")
				continue
			}
		}
		out = append(out, f)
	}
	return out
}

// ownReminder keeps delivery and dismissal state; a live reminder whose firing
// time has passed without a delivery or dismissal for that firing is imported
// dismissed, so the server does not push a burst of stale notifications.
func (pl *planner) ownReminder(fields []field, res *RowResult) []field {
	num := func(name string) float64 {
		var n float64
		for _, f := range fields {
			if f.name == name {
				_ = json.Unmarshal(f.value, &n)
			}
		}
		return n
	}
	fire := num("fire_at")
	if num("deleted_at") != 0 || fire <= 0 || fire >= float64(pl.now) || num("delivered_at") >= fire || num("dismissed_at") >= fire {
		return fields
	}
	res.Warnings = append(res.Warnings, warnPastReminder)
	return setField(fields, "dismissed_at", raw(pl.now))
}

const warnPastReminder = "reminder time already passed; imported as dismissed"

func setField(fields []field, name string, v json.RawMessage) []field {
	for i := range fields {
		if fields[i].name == name {
			fields[i].value = v
			return fields
		}
	}
	return append(fields, field{name, v})
}

func jsonEqual(a, b json.RawMessage) bool {
	if len(a) == 0 {
		return isNull(b) && len(b) == 0
	}
	if bytes.Equal(a, b) {
		return true
	}
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
