package importer

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// TickTick's CSV backup (OpenSpec change named-importers): a preamble of quoted
// values (the export date, the version and a status legend, which may span
// several lines) before a 25-column header. Lists become projects inside their
// folders, the board column is the section, checklists become subtasks.

const tickTickFormat = "ticktick-csv"

type tickTickProfile struct{}

func (tickTickProfile) Name() string        { return tickTickFormat }
func (tickTickProfile) Description() string { return "TickTick: the CSV backup from Settings, Backup" }

// tickTickRecords reads the CSV and returns the preamble records, the header and
// a reader positioned at the first task record.
func tickTickRecords(data []byte) (pre [][]string, header []string, r *csv.Reader, err error) {
	r = csv.NewReader(bytes.NewReader(trimBOM(data)))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	for i := 0; i < 20; i++ {
		rec, err := r.Read()
		if err != nil {
			return nil, nil, nil, err
		}
		if len(rec) > 0 && strings.TrimSpace(rec[0]) == "Folder Name" {
			return pre, rec, r, nil
		}
		pre = append(pre, rec)
	}
	return nil, nil, nil, errors.New("no TickTick header")
}

func (tickTickProfile) Detect(data []byte) bool {
	if !bytes.HasPrefix(bytes.TrimLeft(trimBOM(data), "\""), []byte("Date:")) {
		return false
	}
	_, h, _, err := tickTickRecords(data)
	if err != nil || len(h) < 4 {
		return false
	}
	return strings.TrimSpace(h[1]) == "List Name" && strings.TrimSpace(h[2]) == "Title" && strings.TrimSpace(h[3]) == "Kind"
}

func (tickTickProfile) Read(rd io.Reader, opts Options) (*Parsed, error) {
	data, err := io.ReadAll(rd)
	if err != nil {
		return nil, err
	}
	pre, header, r, err := tickTickRecords(data)
	if err != nil {
		return nil, &FileError{"cannot find the TickTick header (Folder Name, List Name, Title, …)"}
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.TrimSpace(h)] = i
	}
	out := &Parsed{}
	for _, p := range pre {
		if len(p) > 0 && strings.HasPrefix(strings.TrimSpace(p[0]), "Version:") {
			out.Notes = append(out.Notes, "TickTick backup "+strings.TrimSpace(p[0]))
		}
	}
	loc := opts.Location()
	folders := map[string]bool{}
	lists := map[string]bool{}
	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				out.Rows = append(out.Rows, Row{Line: pe.StartLine, Kind: KindTask, Err: fmt.Sprintf("unreadable CSV record: %v", pe.Err)})
				continue
			}
			return nil, &FileError{fmt.Sprintf("cannot read the CSV file: %v", err)}
		}
		if allBlank(rec) {
			continue
		}
		line, _ := r.FieldPos(0)
		get := func(c string) string {
			if i, ok := col[c]; ok && i < len(rec) {
				return strings.TrimSpace(rec[i])
			}
			return ""
		}
		folder, list := get("Folder Name"), get("List Name")
		folderSource, listSource := "", ""
		if folder != "" {
			folderSource = "ticktick:folder:" + folder
			if !folders[folder] {
				folders[folder] = true
				out.Rows = append(out.Rows, Row{Line: line, Kind: KindProject, SourceID: folderSource, Title: folder})
			}
		}
		if list != "" && !strings.EqualFold(list, "Inbox") {
			listSource = "ticktick:list:" + folder + "/" + list
			if !lists[listSource] {
				lists[listSource] = true
				out.Rows = append(out.Rows, Row{Line: line, Kind: KindProject, SourceID: listSource, Title: list, ParentSourceID: folderSource})
				if strings.EqualFold(get("View Mode"), "kanban") {
					out.ViewHints = append(out.ViewHints, ViewHint{ProjectSourceID: listSource, View: "board"})
				}
			}
		}
		row := Row{Line: line, Kind: KindTask, ProjectSourceID: listSource, SectionName: get("Column Name")}
		if id := get("taskId"); id != "" {
			row.SourceID = "ticktick:" + id
		} else {
			row.SourceID = fmt.Sprintf("ticktick:line:%d", line)
		}
		if p := get("parentId"); p != "" {
			row.ParentSourceID = "ticktick:" + p
		}
		row.Title = get("Title")
		if row.Title == "" {
			row.fail("title is required")
		}
		row.Labels = splitList(get("Tags"))
		tickTickTaskFields(&row, get, loc)
		content := get("Content")
		if strings.EqualFold(get("Kind"), "CHECKLIST") {
			out.Rows = append(out.Rows, row)
			n := 0
			for _, item := range strings.Split(content, "\n") {
				done, text := tickTickItem(item)
				if text == "" {
					continue
				}
				n++
				out.Rows = append(out.Rows, Row{Line: line, Kind: KindTask, SourceID: row.SourceID + ":item:" + strconv.Itoa(n),
					Title: text, ProjectSourceID: listSource, SectionName: row.SectionName, ParentSourceID: row.SourceID, Completed: done})
			}
			continue
		}
		row.Description = content
		out.Rows = append(out.Rows, row)
		if len(out.Rows) > MaxRows {
			return nil, ErrTooManyRows
		}
	}
	return out, nil
}

// tickTickTaskFields reads a task row's priority, due date, reminders,
// repeat rule, status and timestamps; loc is the import's zone, which the
// row's Timezone overrides.
func tickTickTaskFields(row *Row, get func(string) string, loc *time.Location) {
	switch get("Priority") {
	case "5":
		row.Priority = 1
	case "3":
		row.Priority = 2
	case "1":
		row.Priority = 3
	case "0", "":
	default:
		row.warn("priority %q not recognised; imported as p4", get("Priority"))
	}
	zone := loc
	if tz := get("Timezone"); tz != "" {
		if z, err := time.LoadLocation(tz); err == nil {
			zone = z
		}
	}
	if d := get("Due Date"); d != "" {
		due, err := tickTickDue(d, truthy(get("Is All Day")), truthy(get("Is Floating")), zone)
		if err != nil {
			row.warn("due date %q not understood; imported without a due date", d)
		} else {
			row.Due = due
		}
	}
	if rem := get("Reminder"); rem != "" {
		for _, part := range strings.Split(rem, ",") {
			if part = strings.TrimSpace(part); part == "" {
				continue
			}
			rr, err := reminderFromString(part, zone)
			if err != nil {
				row.warn("reminder %q not supported; dropped", part)
				continue
			}
			if !rr.Absolute && truthy(get("Is All Day")) {
				// An all-day task's trigger counts from midnight (PT9H is 09:00 on
				// the day, as in iCalendar); ours count from 09:00.
				rr.Offset -= 9 * 60
			}
			row.Reminders = append(row.Reminders, rr)
		}
	}
	if rep := get("Repeat"); rep != "" {
		setRecurrence(row, rep)
	}
	switch get("Status") {
	case "2":
		row.Completed = true
	case "-1":
		row.Completed = true
		row.Labels = append(row.Labels, "canceled")
	}
	if row.Completed {
		if ts, err := tickTickTime(get("Completed Time"), zone); err == nil {
			row.CompletedAt = ts
		}
	}
	if ts, err := tickTickTime(get("Created Time"), zone); err == nil {
		row.CreatedAt = ts
	}
}

// tickTickDue reads "2026-10-14T16:00:00+0000" as the date (all-day) or the
// wall clock the user saw: in the task's zone, or as written when floating.
func tickTickDue(s string, allDay, floating bool, zone *time.Location) (*Due, error) {
	t, err := time.Parse("2006-01-02T15:04:05-0700", s)
	if err != nil {
		if t, err = time.Parse(time.RFC3339, s); err != nil {
			return parseDue(s, zone)
		}
	}
	if !floating {
		t = t.In(zone)
	}
	if allDay {
		return &Due{Date: t.Format("2006-01-02")}, nil
	}
	return &Due{Date: t.Format("2006-01-02"), Time: t.Format("15:04")}, nil
}

// tickTickTime reads a timestamp such as "2026-10-14T08:00:00+0000" (an offset
// without a colon, which RFC 3339 layouts refuse).
func tickTickTime(s string, zone *time.Location) (int64, error) {
	if t, err := time.Parse("2006-01-02T15:04:05-0700", strings.TrimSpace(s)); err == nil {
		return t.UnixMilli(), nil
	}
	return parseTimestamp(s, zone)
}

// tickTickItem reads one checklist line: "▪" marks a checked item, "▫" an open one.
func tickTickItem(s string) (bool, string) {
	s = strings.TrimSpace(s)
	for _, m := range []string{"▪", "- [x]", "[x]"} {
		if rest, ok := strings.CutPrefix(s, m); ok {
			return true, strings.TrimSpace(rest)
		}
	}
	for _, m := range []string{"▫", "- [ ]", "[ ]"} {
		if rest, ok := strings.CutPrefix(s, m); ok {
			return false, strings.TrimSpace(rest)
		}
	}
	return false, s
}
