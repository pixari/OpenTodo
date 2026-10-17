package importer

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// csvProfile reads a CSV file with the documented columns (docs/import.md). Only
// `title` is required; the reader streams records, so memory follows the row
// count, not the file size.
type csvProfile struct{}

func (csvProfile) Name() string { return "csv" }
func (csvProfile) Description() string {
	return "CSV with a header row (title, project, section, parent, priority, due_date, due_time, labels, recurrence, reminder, …)"
}

// csvColumns maps accepted header names (lower case, spaces as underscores) to the
// documented column they fill.
var csvColumns = map[string]string{
	"title": "title", "task": "title", "content": "title", "summary": "title",
	"description": "description", "notes": "description", "note": "description",
	"project": "project", "list": "project", "project_name": "project",
	"section": "section",
	"parent":  "parent", "parent_id": "parent",
	"id": "id", "source_id": "id",
	"priority": "priority",
	"due_date": "due_date", "due": "due_date",
	"due_time": "due_time",
	"labels":   "labels", "tags": "labels", "label": "labels",
	"completed_at": "completed_at",
	"completed":    "completed", "done": "completed",
	"created_at": "created_at", "created": "created_at",
	"recurrence": "recurrence", "recurring": "recurrence", "repeat": "recurrence", "rrule": "recurrence", "repeats": "recurrence",
	"reminder": "reminder", "reminders": "reminder",
	"deadline": "deadline",
	"start":    "start", "start_date": "start",
	"evening":    "evening",
	"attachment": "attachment", "attachments": "attachment", "files": "attachment", "links": "attachment",
	"blocked_by": "blocked_by", "depends_on": "blocked_by", "waits_for": "blocked_by",
}

// csvUnsupported are columns the model cannot hold; a non-empty value is dropped
// with a per-row warning naming the column.
var csvUnsupported = map[string]string{
	"comment": "comment", "comments": "comment",
	"assignee": "assignee", "assigned_to": "assignee", "collaborator": "assignee",
}

func normHeader(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	h = strings.NewReplacer(" ", "_", "-", "_").Replace(h)
	return h
}

// sniffComma picks the delimiter of the header line: comma, semicolon or tab.
func sniffComma(data []byte) rune {
	line, _, _ := bufio.NewReader(bytes.NewReader(data)).ReadLine()
	best, bestN := ',', strings.Count(string(line), ",")
	for _, c := range []rune{';', '\t'} {
		if n := strings.Count(string(line), string(c)); n > bestN {
			best, bestN = c, n
		}
	}
	return best
}

func (csvProfile) Detect(data []byte) bool {
	t := bytes.TrimSpace(data)
	if len(t) == 0 || t[0] == '{' || t[0] == '[' {
		return false
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = sniffComma(data)
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return false
	}
	for _, h := range header {
		if csvColumns[normHeader(h)] == "title" {
			return true
		}
	}
	return false
}

func (csvProfile) Read(rd io.Reader, opts Options) (*Parsed, error) {
	data, err := io.ReadAll(rd)
	if err != nil {
		return nil, err
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = sniffComma(data)
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	r.ReuseRecord = true
	header, err := r.Read()
	if err != nil {
		return nil, &FileError{fmt.Sprintf("cannot read the CSV header: %v", err)}
	}
	out := &Parsed{}
	col := map[string]int{}         // documented column → index
	unsupported := map[int]string{} // index → dropped attribute
	for i, h := range header {
		n := normHeader(h)
		if c, ok := csvColumns[n]; ok {
			if _, dup := col[c]; !dup {
				col[c] = i
				out.Recognised = append(out.Recognised, strings.TrimSpace(h))
				continue
			}
		}
		if a, ok := csvUnsupported[n]; ok {
			unsupported[i] = a
		}
		out.Ignored = append(out.Ignored, strings.TrimSpace(h))
	}
	if _, ok := col["title"]; !ok {
		return nil, &FileError{"the CSV header has no title column"}
	}
	loc := opts.Location()
	seen := map[string]int{} // content key → occurrences, for stable source ids
	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				out.Rows = append(out.Rows, Row{Line: pe.StartLine, Kind: KindTask, Err: fmt.Sprintf("unreadable CSV record: %v", pe.Err)})
				if len(out.Rows) > MaxRows {
					return nil, ErrTooManyRows
				}
				continue
			}
			return nil, &FileError{fmt.Sprintf("cannot read the CSV file: %v", err)}
		}
		line, _ := r.FieldPos(0)
		get := func(c string) string {
			if i, ok := col[c]; ok && i < len(rec) {
				return strings.TrimSpace(rec[i])
			}
			return ""
		}
		if allBlank(rec) {
			continue
		}
		out.Rows = append(out.Rows, csvRow(line, rec, get, unsupported, seen, loc))
		if len(out.Rows) > MaxRows {
			return nil, ErrTooManyRows
		}
	}
	resolveCSVParents(out.Rows)
	return out, nil
}

// csvRow reads one record into a task row. unsupported names the columns
// whose values are dropped with a warning; seen counts content keys, so rows
// without an id column get stable source ids.
func csvRow(line int, rec []string, get func(string) string, unsupported map[int]string, seen map[string]int, loc *time.Location) Row {
	row := Row{Line: line, Kind: KindTask}
	row.Title = get("title")
	row.Description = get("description")
	row.ProjectName = get("project")
	row.SectionName = get("section")
	row.ParentSourceID = get("parent")
	for _, ref := range strings.FieldsFunc(get("blocked_by"), func(r rune) bool { return r == ';' || r == '|' || r == ',' }) {
		if ref = strings.TrimSpace(ref); ref != "" {
			row.BlockedBySourceIDs = append(row.BlockedBySourceIDs, ref)
		}
	}
	if row.Title == "" {
		row.fail("title is required")
	}
	if p, err := parsePriority(get("priority")); err != nil {
		row.fail("%v", err)
	} else {
		row.Priority = p
	}
	due, err := parseDue(get("due_date"), loc)
	if err != nil {
		row.fail("%v", err)
	}
	if t := get("due_time"); t != "" {
		switch clock, err := parseClock(t); {
		case err != nil:
			row.fail("%v", err)
		case due == nil && get("due_date") == "":
			row.fail("due_time requires due_date")
		case due != nil:
			due.Time = clock
		}
	}
	row.Due = due
	row.Labels = splitList(get("labels"))
	if v := get("completed_at"); v != "" {
		if truthy(v) {
			row.Completed = true
		} else if ts, err := parseTimestamp(v, loc); err != nil {
			row.fail("completed_at: %v", err)
		} else {
			row.Completed, row.CompletedAt = true, ts
		}
	}
	if v := get("completed"); v != "" && truthy(v) {
		row.Completed = true
	}
	if v := get("recurrence"); v != "" {
		setRecurrence(&row, v)
	}
	setDeadline(&row, get("deadline"), loc)
	// Attachment references become link attachments (attachments D12).
	for _, ref := range strings.FieldsFunc(get("attachment"), func(r rune) bool { return r == ';' || r == '|' || r == ',' || r == '\n' || r == ' ' }) {
		row.addLink("", ref)
	}
	if v := get("start"); v != "" {
		if strings.EqualFold(v, "someday") {
			row.Start = "someday"
		} else if d, err := parseDue(v, loc); err != nil || d == nil || d.Time != "" {
			row.fail("invalid start %q (expected YYYY-MM-DD or someday)", v)
		} else {
			row.Start = d.Date
		}
	}
	if v := get("evening"); v != "" {
		row.Evening = truthy(v)
	}
	if v := get("reminder"); v != "" {
		var list []any
		for _, part := range strings.FieldsFunc(v, func(r rune) bool { return r == ';' || r == ',' || r == '|' }) {
			if part = strings.TrimSpace(part); part != "" {
				list = append(list, part)
			}
		}
		addReminders(&row, list, loc)
	}
	if v := get("created_at"); v != "" {
		if ts, err := parseTimestamp(v, loc); err != nil {
			row.fail("created_at: %v", err)
		} else {
			row.CreatedAt = ts
		}
	}
	idxs := make([]int, 0, len(unsupported))
	for i := range unsupported {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)
	for _, i := range idxs {
		if i < len(rec) && strings.TrimSpace(rec[i]) != "" {
			row.warn("%s dropped (not supported)", unsupported[i])
		}
	}
	// The source id lets a repeated import of the same file skip what it already
	// created: the id column when present, otherwise a hash of the row's content.
	if id := get("id"); id != "" {
		row.SourceID = "id:" + id
	} else {
		key := strings.ToLower(strings.Join([]string{row.Title, row.ProjectName, row.SectionName, row.ParentSourceID, get("due_date"), get("due_time")}, "\x1f"))
		sum := sha256.Sum256([]byte(key))
		seen[key]++
		row.SourceID = fmt.Sprintf("row:%s:%d", hex.EncodeToString(sum[:8]), seen[key])
	}
	return row
}

// resolveCSVParents maps the `parent` column onto source ids: the id of another
// row first, otherwise the title of exactly one row. Unmatched values stay as they
// are and the planner reports them.
func resolveCSVParents(rows []Row) {
	byID := map[string]bool{}
	byTitle := map[string]string{}
	ambiguous := map[string]bool{}
	for _, r := range rows {
		if strings.HasPrefix(r.SourceID, "id:") {
			byID[r.SourceID] = true
		}
		t := strings.ToLower(r.Title)
		if t == "" {
			continue
		}
		if _, ok := byTitle[t]; ok {
			ambiguous[t] = true
		}
		byTitle[t] = r.SourceID
	}
	for i := range rows {
		p := rows[i].ParentSourceID
		if p == "" {
			continue
		}
		if byID["id:"+p] {
			rows[i].ParentSourceID = "id:" + p
			continue
		}
		t := strings.ToLower(p)
		if sid, ok := byTitle[t]; ok && !ambiguous[t] && sid != rows[i].SourceID {
			rows[i].ParentSourceID = sid
			continue
		}
		if ambiguous[t] {
			rows[i].warn("parent %q matches several rows; imported as a top-level task", p)
			rows[i].ParentSourceID = ""
			continue
		}
		rows[i].ParentSourceID = "id:" + p
	}
	// blocked_by references resolve the same way (task-dependencies D10).
	for i := range rows {
		for k, ref := range rows[i].BlockedBySourceIDs {
			t := strings.ToLower(ref)
			switch {
			case byID["id:"+ref]:
				rows[i].BlockedBySourceIDs[k] = "id:" + ref
			case !ambiguous[t] && byTitle[t] != "":
				rows[i].BlockedBySourceIDs[k] = byTitle[t]
			default:
				rows[i].BlockedBySourceIDs[k] = "id:" + ref
			}
		}
	}
}

func allBlank(rec []string) bool {
	for _, f := range rec {
		if strings.TrimSpace(f) != "" {
			return false
		}
	}
	return true
}
