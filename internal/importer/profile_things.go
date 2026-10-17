package importer

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Things 3 has no export, but its database can be copied (Cultured Code's
// support article "Accessing the Things database"). things-db reads that
// main.sqlite (OpenSpec change named-importers, design D4) from a private
// temporary copy, read-only, with fixed queries over Things' own tables, and
// deletes the copy afterwards.

const thingsFormat = "things-db"

// thingsTested is the database schema version the mapping was verified against.
const thingsTested = 29

var sqliteMagic = []byte("SQLite format 3\x00")

type thingsDBProfile struct{}

func (thingsDBProfile) Name() string { return thingsFormat }
func (thingsDBProfile) Description() string {
	return "Things 3: a copy of its database (main.sqlite) or a ZIP of the Things Database folder"
}

func (thingsDBProfile) Detect(data []byte) bool { return bytes.HasPrefix(data, sqliteMagic) }

func (thingsDBProfile) Read(rd io.Reader, opts Options) (*Parsed, error) {
	data, err := io.ReadAll(rd)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(data, sqliteMagic) {
		return nil, &FileError{"not a SQLite database; upload Things' main.sqlite"}
	}
	dir, err := os.MkdirTemp(opts.tempDir, "things-import-")
	if err != nil {
		return nil, fmt.Errorf("things: temporary directory: %w", err)
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "main.sqlite")
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return nil, fmt.Errorf("things: temporary copy: %w", err)
	}
	dsn := "file:" + file + "?mode=ro&immutable=1"
	if len(opts.thingsWAL) > 0 {
		if err := os.WriteFile(file+"-wal", opts.thingsWAL, 0o600); err != nil {
			return nil, fmt.Errorf("things: temporary copy: %w", err)
		}
		dsn = "file:" + file + "?mode=ro" // the private copy may grow a -shm file next to it
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, &FileError{fmt.Sprintf("cannot open the database: %v", err)}
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, "PRAGMA query_only = 1"); err != nil {
		return nil, &FileError{fmt.Sprintf("cannot read the database: %v", err)}
	}
	t := &thingsReader{db: db, ctx: ctx, loc: opts.Location(), out: &Parsed{}}
	if err := t.check(); err != nil {
		return nil, err
	}
	if err := t.read(opts); err != nil {
		var fe *FileError
		if errors.As(err, &fe) {
			return nil, err
		}
		return nil, &FileError{fmt.Sprintf("cannot read the Things database: %v", err)}
	}
	return t.out, nil
}

type thingsReader struct {
	db  *sql.DB
	ctx context.Context
	loc *time.Location
	out *Parsed
}

var plistInteger = regexp.MustCompile(`<integer>(-?\d+)</integer>`)

// check refuses SQLite files that are not a Things database.
func (t *thingsReader) check() error {
	have := map[string]bool{}
	rows, err := t.db.QueryContext(t.ctx, "SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		return &FileError{fmt.Sprintf("cannot read the database: %v", err)}
	}
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			have[n] = true
		}
	}
	rows.Close()
	for _, want := range []string{"TMTask", "TMArea", "TMTag", "TMTaskTag", "TMChecklistItem", "Meta"} {
		if !have[want] {
			return &FileError{"not a Things database (the Things tables are missing)"}
		}
	}
	var v string
	if err := t.db.QueryRowContext(t.ctx, "SELECT value FROM Meta WHERE key = 'databaseVersion'").Scan(&v); err != nil {
		return &FileError{"not a Things database (no database version)"}
	}
	m := plistInteger.FindStringSubmatch(v)
	if m == nil {
		return &FileError{"not a Things database (unreadable database version)"}
	}
	version, _ := strconv.Atoi(m[1])
	switch {
	case version < 20:
		return &FileError{fmt.Sprintf("this Things database (version %d) is too old; update Things 3 and copy it again", version)}
	case version != thingsTested:
		t.out.Notes = append(t.out.Notes, fmt.Sprintf("Things database version %d; the import was verified with version %d. Check the preview carefully.", version, thingsTested))
	}
	return nil
}

func (t *thingsReader) read(opts Options) error {
	tagsOf, err := t.readTags()
	if err != nil {
		return err
	}
	line, err := t.readAreas()
	if err != nil {
		return err
	}
	tasks, err := t.readTasks()
	if err != nil {
		return err
	}
	byID := map[string]*thingsTask{}
	for i := range tasks {
		byID[tasks[i].id] = &tasks[i]
	}
	checklist, err := t.readChecklist()
	if err != nil {
		return err
	}
	for i := range tasks {
		k := &tasks[i]
		if thingsTrashed(k, byID) {
			continue
		}
		line++
		switch k.typ {
		case 1: // project
			row := Row{Line: line, Kind: KindProject, SourceID: "things:" + k.id, Title: strings.TrimSpace(k.title)}
			if k.area != "" {
				row.ParentSourceID = "things:" + k.area
			}
			if row.Title == "" {
				row.fail("project title is required")
			}
			if k.status == 3 || k.status == 2 {
				row.warn("completed project imported as an open project")
			}
			t.out.Rows = append(t.out.Rows, row)
		case 2: // heading
			if opts.Sections != "section" || k.project == "" {
				continue
			}
			row := Row{Line: line, Kind: KindSection, SourceID: "things:" + k.id, Title: strings.TrimSpace(k.title), ProjectSourceID: "things:" + k.project}
			if row.Title == "" {
				row.fail("heading title is required")
			}
			t.out.Rows = append(t.out.Rows, row)
		case 0: // to-do
			row := t.todoRow(k, line, byID, tagsOf)
			t.out.Rows = append(t.out.Rows, row)
			for _, c := range checklist[k.id] {
				line++
				c.Line = line
				c.ProjectSourceID, c.SectionName = row.ProjectSourceID, row.SectionName
				t.out.Rows = append(t.out.Rows, c)
			}
		}
		if len(t.out.Rows) > MaxRows {
			return ErrTooManyRows
		}
	}
	return nil
}

// readTags returns each task's tags, with parents flattened as "parent/child".
func (t *thingsReader) readTags() (map[string][]string, error) {
	tagName := map[string]string{}
	tagParent := map[string]string{}
	rows, err := t.db.QueryContext(t.ctx, "SELECT uuid, COALESCE(title, ''), COALESCE(parent, '') FROM TMTag")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, title, parent string
		if err := rows.Scan(&id, &title, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		tagName[id], tagParent[id] = strings.TrimSpace(title), parent
	}
	rows.Close()
	fullTag := func(id string) string {
		name, seen := tagName[id], map[string]bool{id: true}
		for p := tagParent[id]; p != "" && !seen[p]; p = tagParent[p] {
			seen[p] = true
			name = tagName[p] + "/" + name
		}
		return name
	}
	tagsOf := map[string][]string{}
	rows, err = t.db.QueryContext(t.ctx, "SELECT tasks, tags FROM TMTaskTag")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var task, tag string
		if err := rows.Scan(&task, &tag); err != nil {
			rows.Close()
			return nil, err
		}
		if n := fullTag(tag); n != "" {
			tagsOf[task] = append(tagsOf[task], n)
		}
	}
	rows.Close()
	return tagsOf, nil
}

// readAreas adds the areas as parent projects and returns the last line number.
func (t *thingsReader) readAreas() (int, error) {
	rows, err := t.db.QueryContext(t.ctx, `SELECT uuid, COALESCE(title, '') FROM TMArea ORDER BY "index"`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	line := 0
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			return 0, err
		}
		line++
		row := Row{Line: line, Kind: KindProject, SourceID: "things:" + id, Title: strings.TrimSpace(title)}
		if row.Title == "" {
			row.fail("area title is required")
		}
		t.out.Rows = append(t.out.Rows, row)
	}
	return line, nil
}

// thingsTask is one TMTask row: a to-do (type 0), a project (1) or a heading (2).
type thingsTask struct {
	id, title, notes, area, project, heading string
	typ, status, start, bucket               int
	trashed                                  bool
	startDate, deadline, reminder            sql.NullInt64
	created, stopped                         sql.NullFloat64
	rule                                     []byte
}

func (t *thingsReader) readTasks() ([]thingsTask, error) {
	var tasks []thingsTask
	rows, err := t.db.QueryContext(t.ctx, `SELECT uuid, COALESCE(title, ''), COALESCE(notes, ''), type, status, trashed,
		start, COALESCE(startBucket, 0), startDate, deadline, reminderTime, creationDate, stopDate,
		COALESCE(area, ''), COALESCE(project, ''), COALESCE(heading, ''), rt1_recurrenceRule
		FROM TMTask ORDER BY type DESC, "index"`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k thingsTask
		if err := rows.Scan(&k.id, &k.title, &k.notes, &k.typ, &k.status, &k.trashed, &k.start, &k.bucket,
			&k.startDate, &k.deadline, &k.reminder, &k.created, &k.stopped, &k.area, &k.project, &k.heading, &k.rule); err != nil {
			return nil, err
		}
		tasks = append(tasks, k)
	}
	return tasks, nil
}

// thingsTrashed reports whether k, its heading or its project is in the trash.
func thingsTrashed(k *thingsTask, byID map[string]*thingsTask) bool {
	for cur, n := k, 0; cur != nil && n < 4; n++ {
		if cur.trashed {
			return true
		}
		switch {
		case cur.heading != "":
			cur = byID[cur.heading]
		case cur.project != "":
			cur = byID[cur.project]
		default:
			cur = nil
		}
	}
	return false
}

// readChecklist returns the checklist items, as subtask rows, by their to-do.
func (t *thingsReader) readChecklist() (map[string][]Row, error) {
	checklist := map[string][]Row{}
	rows, err := t.db.QueryContext(t.ctx, `SELECT uuid, COALESCE(title, ''), status, task, stopDate FROM TMChecklistItem ORDER BY "index"`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, title, owner string
		var status int
		var stopped sql.NullFloat64
		if err := rows.Scan(&id, &title, &status, &owner, &stopped); err != nil {
			return nil, err
		}
		if strings.TrimSpace(title) == "" {
			continue
		}
		r := Row{Kind: KindTask, SourceID: "things:" + id, Title: strings.TrimSpace(title), ParentSourceID: "things:" + owner,
			Completed: status == 3 || status == 2}
		if r.Completed && stopped.Valid {
			r.CompletedAt = int64(stopped.Float64 * 1000)
		}
		checklist[owner] = append(checklist[owner], r)
	}
	return checklist, nil
}

// todoRow is the task row of a to-do.
func (t *thingsReader) todoRow(k *thingsTask, line int, byID map[string]*thingsTask, tagsOf map[string][]string) Row {
	row := Row{Line: line, Kind: KindTask, SourceID: "things:" + k.id, Title: strings.TrimSpace(k.title), Labels: tagsOf[k.id]}
	if row.Title == "" {
		row.fail("title is required")
	}
	row.Description = thingsNotes(k.notes)
	switch {
	case k.heading != "":
		if h := byID[k.heading]; h != nil {
			row.ProjectSourceID = "things:" + h.project
			row.SectionName = strings.TrimSpace(h.title)
		}
	case k.project != "":
		row.ProjectSourceID = "things:" + k.project
	case k.area != "":
		row.ProjectSourceID = "things:" + k.area
	}
	if k.startDate.Valid {
		if d, ok := thingsDate(k.startDate.Int64); ok {
			row.Due = &Due{Date: d}
			if k.reminder.Valid {
				if clock, ok := thingsClock(k.reminder.Int64); ok {
					if at, err := time.ParseInLocation("2006-01-02 15:04", d+" "+clock, t.loc); err == nil {
						row.Reminders = append(row.Reminders, Reminder{Absolute: true, At: at.UnixMilli()})
					}
				} else {
					row.warn("reminder time not understood; dropped")
				}
			}
		}
	}
	if k.deadline.Valid {
		if d, ok := thingsDate(k.deadline.Int64); ok {
			row.Deadline = d
		}
	}
	if k.start == 2 {
		row.Start = "someday"
	}
	if k.bucket == 1 {
		row.Evening = true
	}
	if len(k.rule) > 0 {
		if rule, ok := thingsRecurrence(k.rule); ok {
			row.Recurrence = rule
		} else {
			row.warn("repeat rule not supported; imported without it")
		}
	}
	switch k.status {
	case 3:
		row.Completed = true
	case 2:
		row.Completed = true
		row.Labels = append(row.Labels, "canceled")
	}
	if row.Completed && k.stopped.Valid {
		row.CompletedAt = int64(k.stopped.Float64 * 1000)
	}
	if k.created.Valid {
		row.CreatedAt = int64(k.created.Float64 * 1000)
	}
	return row
}

// thingsDate unpacks Things' date integer: year<<16 | month<<12 | day<<7.
func thingsDate(v int64) (string, bool) {
	y, m, d := int(v>>16), int(v>>12&0xF), int(v>>7&0x1F)
	if y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31 {
		return "", false
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if t.Day() != d {
		return "", false
	}
	return t.Format("2006-01-02"), true
}

// thingsClock unpacks a reminder time: hour<<26 | minute<<20.
func thingsClock(v int64) (string, bool) {
	h, m := int(v>>26), int(v>>20&0x3F)
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return "", false
	}
	return fmt.Sprintf("%02d:%02d", h, m), true
}

var noteTag = regexp.MustCompile(`</?note[^>]*>`)

// thingsNotes unwraps the XML wrapper newer versions put around notes.
func thingsNotes(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "<note") {
		s = html.UnescapeString(noteTag.ReplaceAllString(s, ""))
	}
	return strings.TrimSpace(s)
}

// thingsRecurrence reads the repeat rule plist (an XML property list with
// fu = unit: 16 day, 256 week, 8 month, 4 year; fa = interval; tp = 1 after
// completion; of = weekdays as {wd: 1 = Sunday … 7 = Saturday}).
func thingsRecurrence(b []byte) (string, bool) {
	if bytes.HasPrefix(b, []byte("bplist")) {
		return "", false
	}
	d, ok := plistDict(b)
	if !ok {
		return "", false
	}
	unit := map[int64]string{16: "day", 256: "week", 8: "month", 4: "year"}[d.int("fu")]
	if unit == "" {
		return "", false
	}
	n := d.int("fa")
	if n < 1 {
		n = 1
	}
	var text string
	if days := d.weekdays(); unit == "week" && n == 1 && len(days) > 0 {
		text = "every " + strings.Join(days, " and ")
	} else if n == 1 {
		text = "every " + unit
	} else {
		text = fmt.Sprintf("every %d %ss", n, unit)
	}
	if d.int("tp") == 1 {
		text += " after completion"
	}
	rule, err := parseRecurrence(text, "")
	return rule, err == nil && rule != ""
}

// plist is a decoded XML property list dictionary (only what the rule needs).
type plist struct {
	ints  map[string]int64
	wdays []int64
}

func (p plist) int(k string) int64 { return p.ints[k] }

func (p plist) weekdays() []string {
	names := []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}
	var out []string
	for _, w := range p.wdays {
		if w >= 1 && w <= 7 {
			out = append(out, names[w-1])
		}
	}
	return out
}

// plistDict reads the top-level dict of an XML plist: integer values by key, and
// the "wd" integers found anywhere under "of".
func plistDict(b []byte) (plist, bool) {
	dec := xml.NewDecoder(bytes.NewReader(b))
	p := plist{ints: map[string]int64{}}
	depth, key, inOf, lastKey := 0, "", false, ""
	sawDict := false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return p, false
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "dict":
				depth++
				sawDict = true
			case "key":
				var k string
				if dec.DecodeElement(&k, &t) == nil {
					lastKey = k
					if depth == 1 {
						key = k
						inOf = k == "of"
					}
				}
			case "integer":
				var v string
				if dec.DecodeElement(&v, &t) == nil {
					n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
					if err != nil {
						continue
					}
					switch {
					case depth == 1 && key != "":
						p.ints[key] = n
					case inOf && lastKey == "wd":
						p.wdays = append(p.wdays, n)
					}
				}
			}
		case xml.EndElement:
			if t.Name.Local == "dict" {
				depth--
			}
		}
	}
	return p, sawDict
}
