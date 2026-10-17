package importer

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Todoist's CSV export (OpenSpec change named-importers): one file per project,
// as downloaded from a project's menu or inside the backup ZIP. Rows are typed
// (meta, section, task, note); INDENT nests tasks; DATE is the text the user saw,
// read by todoistDate.

const (
	todoistFormat       = "todoist-csv"
	todoistBackupFormat = "todoist-backup"
)

var todoistColumns = []string{"TYPE", "CONTENT", "DESCRIPTION", "PRIORITY", "INDENT", "AUTHOR", "RESPONSIBLE", "DATE", "DATE_LANG", "TIMEZONE"}

var (
	todoistLabel    = regexp.MustCompile(`(^|\s)@([\p{L}\p{N}_-]+)`)
	todoistFileName = regexp.MustCompile(`^(.*) \[([^\]]+)\]\.csv$`)
)

type todoistProfile struct{}

func (todoistProfile) Name() string { return todoistFormat }
func (todoistProfile) Description() string {
	return "Todoist: a project's CSV export, or the backup ZIP of every project"
}

func (todoistProfile) Detect(data []byte) bool {
	h := csvHeader(data)
	if len(h) == 0 || h[0] != "TYPE" {
		return false
	}
	have := map[string]bool{}
	for _, c := range h {
		have[c] = true
	}
	for _, c := range []string{"CONTENT", "PRIORITY", "INDENT"} {
		if !have[c] {
			return false
		}
	}
	return true
}

// csvHeader reads the first record of a CSV file (BOM stripped, trimmed).
func csvHeader(data []byte) []string {
	r := csv.NewReader(bytes.NewReader(trimBOM(data)))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	rec, err := r.Read()
	if err != nil {
		return nil
	}
	for i := range rec {
		rec[i] = strings.TrimSpace(rec[i])
	}
	return rec
}

func (todoistProfile) Read(rd io.Reader, opts Options) (*Parsed, error) {
	data, err := io.ReadAll(rd)
	if err != nil {
		return nil, err
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	header, err := r.Read()
	if err != nil {
		return nil, &FileError{fmt.Sprintf("cannot read the CSV header: %v", err)}
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.TrimSpace(h)] = i
	}
	out := &Parsed{}
	for _, c := range todoistColumns {
		if _, ok := col[c]; ok {
			out.Recognised = append(out.Recognised, c)
		}
	}
	loc := opts.Location()
	ref := opts.exportedAt.In(loc)

	projectID, projectSource := todoistProject(opts, out)

	var stack []string // source ids of the open parents by indent level
	section := ""
	seen := map[string]int{}
	var last *Row
	lastCommented := false
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
		line, _ := r.FieldPos(0)
		get := func(c string) string {
			if i, ok := col[c]; ok && i < len(rec) {
				return strings.TrimSpace(rec[i])
			}
			return ""
		}
		switch strings.ToLower(get("TYPE")) {
		case "":
			continue
		case "meta":
			if strings.TrimSpace(get("CONTENT")) == "view_style=board" && projectSource != "" {
				out.ViewHints = append(out.ViewHints, ViewHint{ProjectSourceID: projectSource, View: "board"})
			}
		case "section":
			section = get("CONTENT")
			last = nil // notes belong to the task right above them
			stack = stack[:0]
			if opts.Sections == "section" && projectSource != "" && section != "" {
				out.Rows = append(out.Rows, Row{Line: line, Kind: KindSection, SourceID: "todoist:section:" + projectID + ":" + section,
					Title: section, ProjectSourceID: projectSource})
			}
		case "note":
			if last != nil {
				if text := get("CONTENT"); text != "" {
					// The heading is added once per task (a description that was empty
					// starts with it, so its position cannot tell).
					if !lastCommented {
						last.Description = strings.TrimSpace(last.Description+"\n\nComments") + "\n"
						lastCommented = true
					}
					last.Description += "\n- " + text
				}
				if !hasPrefix(last.Warnings, "comments appended") {
					last.warn("comments appended to the description (their authors cannot be kept)")
				}
			}
		case "task":
			row := Row{Line: line, Kind: KindTask, ProjectSourceID: projectSource, SectionName: section}
			title := get("CONTENT")
			for _, m := range todoistLabel.FindAllStringSubmatch(title, -1) {
				row.Labels = append(row.Labels, m[2])
			}
			row.Title = strings.Join(strings.Fields(todoistLabel.ReplaceAllString(title, "$1")), " ")
			if row.Title == "" {
				row.fail("content is required")
			}
			row.Description = get("DESCRIPTION")
			indent, _ := strconv.Atoi(get("INDENT"))
			if indent < 1 {
				indent = 1
			}
			if indent > len(stack)+1 {
				row.warn("indent %d without a parent at level %d; imported one level up", indent, indent-1)
				indent = len(stack) + 1
			}
			stack = stack[:indent-1]
			if indent > 1 {
				row.ParentSourceID = stack[indent-2]
			}
			todoistTaskFields(&row, get, ref, loc)
			if get("RESPONSIBLE") != "" {
				row.warn("assignee dropped (only your own account can be assigned by an import)")
			}
			key := strings.ToLower(strings.Join([]string{projectID, section, row.ParentSourceID, title}, "\x1f"))
			sum := sha256.Sum256([]byte(key))
			seen[key]++
			row.SourceID = fmt.Sprintf("todoist:%s:%d", hex.EncodeToString(sum[:8]), seen[key])
			out.Rows = append(out.Rows, row)
			last, lastCommented = &out.Rows[len(out.Rows)-1], false
			stack = append(stack, row.SourceID)
		default:
			out.Rows = append(out.Rows, Row{Line: line, Kind: KindTask, Err: fmt.Sprintf("unknown row type %q", get("TYPE"))})
		}
		if len(out.Rows) > MaxRows {
			return nil, ErrTooManyRows
		}
	}
	return out, nil
}

// todoistProject reads the project from the file name inside a backup
// ("Work [2203306141].csv") and adds its row; the source id is empty for a
// single CSV and for the Inbox.
func todoistProject(opts Options, out *Parsed) (projectID, projectSource string) {
	projectName := ""
	if opts.entryName != "" {
		base := path.Base(opts.entryName)
		if m := todoistFileName.FindStringSubmatch(base); m != nil {
			projectName, projectID = strings.TrimSpace(m[1]), m[2]
		} else {
			projectName = strings.TrimSuffix(base, path.Ext(base))
		}
	}
	switch {
	case projectName == "":
		out.Notes = append(out.Notes, "A single Todoist CSV does not name its project: its tasks go to the target project. Upload the backup ZIP to keep project names.")
	case strings.EqualFold(projectName, "Inbox"):
		// Todoist's Inbox maps onto ours (or the chosen target project).
	default:
		if projectID == "" {
			projectID = projectName
		}
		projectSource = "todoist:project:" + projectID
		out.Rows = append(out.Rows, Row{Line: 1, Kind: KindProject, SourceID: projectSource, Title: projectName})
	}
	return projectID, projectSource
}

// todoistTaskFields reads a task row's priority, due date or rule, deadline,
// duration and reminder; loc is the import's zone, which the row's TIMEZONE
// overrides for its reminder.
func todoistTaskFields(row *Row, get func(string) string, ref time.Time, loc *time.Location) {
	if p := get("PRIORITY"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 4 {
			row.fail("invalid priority %q (expected 1-4)", p)
		} else {
			// The CSV uses the numbers the app shows (1 is the red flag), unlike
			// Todoist's API, where 4 is the highest (json-items reverses it).
			row.Priority = n
		}
	}
	if text := get("DATE"); text != "" {
		due, rule, err := todoistDate(text, get("DATE_LANG"), ref)
		switch {
		case err != nil:
			row.warn("date %q not understood; imported without a due date", text)
		case rule != "":
			row.Recurrence = rule
		default:
			row.Due = due
		}
	}
	// The deadline column uses the same date language as DATE (deadlines D9).
	if text := get("DEADLINE"); text != "" {
		lang := get("DEADLINE_LANG")
		if lang == "" {
			lang = get("DATE_LANG")
		}
		due, rule, err := todoistDate(text, lang, ref)
		if err != nil || rule != "" || due == nil {
			row.Description = strings.TrimSpace(row.Description + "\n\nDeadline: " + text)
			row.warn("deadline %q not understood; kept in the description", text)
		} else {
			row.Deadline = due.Date
		}
	}
	if n, err := strconv.Atoi(get("DURATION")); err == nil && n > 0 {
		switch strings.ToLower(get("DURATION_UNIT")) {
		case "minute", "minutes", "":
			row.EstimateMinutes = n
		case "day", "days":
			row.warn("duration of %d days dropped (estimates are in minutes)", n)
		}
	}
	rowLoc := loc
	if tz := get("TIMEZONE"); tz != "" {
		if z, err := time.LoadLocation(tz); err == nil {
			rowLoc = z
		}
	}
	todoistReminder(row, get, ref, rowLoc)
}

// todoistReminder reads REMINDER_TYPE / REMINDER_OFFSET (minutes before the due
// time) or REMINDER_DATE (an absolute date-time in the row's language).
func todoistReminder(row *Row, get func(string) string, ref time.Time, loc *time.Location) {
	if off := get("REMINDER_OFFSET"); off != "" {
		if n, err := strconv.Atoi(off); err == nil && n >= 0 {
			row.Reminders = append(row.Reminders, Reminder{Offset: -n}) // minutes before the due time
			return
		}
	}
	if d := get("REMINDER_DATE"); d != "" {
		lang := get("REMINDER_DATE_LANG")
		if lang == "" {
			lang = get("DATE_LANG")
		}
		due, _, err := todoistDate(d, lang, ref)
		if err != nil || due == nil || due.Time == "" {
			row.warn("reminder %q not understood; dropped", d)
			return
		}
		at, err := time.ParseInLocation("2006-01-02 15:04", due.Date+" "+due.Time, loc)
		if err != nil {
			row.warn("reminder %q not understood; dropped", d)
			return
		}
		row.Reminders = append(row.Reminders, Reminder{Absolute: true, At: at.UnixMilli()})
		return
	}
	if get("REMINDER_TYPE") != "" {
		row.warn("reminder dropped (no time given)")
	}
}
