package caldav

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/recurrence"
	"github.com/pixari/opentodo/internal/zoned"
)

// Errors returned by Decode besides ErrInvalid (unparseable data).
var (
	// ErrUnsupportedComponent: the object holds a VEVENT or VJOURNAL instead of a
	// VTODO (CALDAV:supported-calendar-component).
	ErrUnsupportedComponent = errors.New("only VTODO components are supported")
	// ErrInvalidObject: no UID, several UIDs, or no VTODO at all
	// (CALDAV:valid-calendar-object-resource).
	ErrInvalidObject = errors.New("invalid calendar object resource")
)

// Due mirrors the task due value: a floating date, a floating date and time, or
// a wall time in a named IANA zone (absolute-datetimes).
type Due struct {
	Date string  `json:"date"`
	Time *string `json:"time,omitempty"`
	TZ   *string `json:"tz,omitempty"`
}

// ProdID identifies the server in generated objects.
const ProdID = "-//OpenTodo//CalDAV//EN"

// Task is the outbound view of a task: everything one VTODO carries.
type Task struct {
	UID         string
	Title       string
	Description string
	Priority    int // app priority 1..4
	Due         *Due
	Deadline    string // "YYYY-MM-DD" or "" (OpenSpec change deadlines)
	Start       string // "someday", "YYYY-MM-DD" or "" (OpenSpec change someday-and-evening)
	Evening     bool
	Categories  []string
	ParentUID   string
	// DependsOn are the UIDs of the task's blockers in the same calendar
	// (OpenSpec change task-dependencies, design D10).
	DependsOn   []string
	CreatedAt   int64
	CompletedAt *int64
	Recurrence  string // canonical rule or ""
	Extra       string // ical_extra: unmapped content lines, unfolded, CRLF separated
	Modified    int64  // greatest field timestamp: LAST-MODIFIED and DTSTAMP
}

// Inbound is what a client's VTODO says about the mapped fields.
type Inbound struct {
	UID         string
	Title       string
	Description string
	Priority    int // app priority 1..4
	Due         *Due
	// Deadline is the date of DUE when the client sent a DTSTART that differs
	// from it (design D6); then Due is the DTSTART. DueOnly reports a DUE
	// without any DTSTART: the caller decides whether it is the due date or,
	// on a task that has a deadline, the deadline.
	Deadline string
	DueOnly  bool
	// Start and Evening come from X-OPENTODO-START and X-OPENTODO-EVENING
	// (someday-and-evening D7); nil means the client did not send the property,
	// which leaves the field alone.
	Start       *string
	Evening     *bool
	Completed   bool
	CompletedAt *int64 // the COMPLETED time when the client sent one
	Categories  []string
	ParentUID   string
	// DependsOn are the UIDs of RELATED-TO;RELTYPE=DEPENDS-ON lines (task-dependencies D10).
	DependsOn []string
	CreatedAt *int64
	// RRULE is the raw rule value ("" when none). Rule is its canonical
	// OpenTodo form, or "" when the grammar cannot express it; then the RRULE
	// line is part of Extra and the task keeps no rule of its own.
	RRULE string
	Rule  string
	Extra string
}

// AppToICalPriority is the outbound priority table (design D3): 1→1, 2→5, 3→9,
// 4 (none)→0.
func AppToICalPriority(p int) int {
	switch p {
	case 1:
		return 1
	case 2:
		return 5
	case 3:
		return 9
	}
	return 0
}

// ICalToAppPriority is the inbound table: 1–3→1, 4–6→2, 7–9→3, 0 or anything
// else→4.
func ICalToAppPriority(p int) int {
	switch {
	case p >= 1 && p <= 3:
		return 1
	case p >= 4 && p <= 6:
		return 2
	case p >= 7 && p <= 9:
		return 3
	}
	return 4
}

func utcStamp(ms int64) string { return time.UnixMilli(ms).UTC().Format("20060102T150405Z") }

func dateValue(d string) string { return strings.ReplaceAll(d, "-", "") }

func clockValue(c string) string { return strings.ReplaceAll(c, ":", "") + "00" }

// dueProp renders a due value as a property with the given name (DUE or DTSTART).
func dueProp(name string, d *Due) Prop {
	switch {
	case d.Time == nil:
		return Prop{Name: name, Params: []Param{{Name: "VALUE", Values: []string{"DATE"}}}, Value: dateValue(d.Date)}
	case d.TZ != nil:
		return Prop{Name: name, Params: []Param{{Name: "TZID", Values: []string{*d.TZ}}}, Value: dateValue(d.Date) + "T" + clockValue(*d.Time)}
	}
	return Prop{Name: name, Value: dateValue(d.Date) + "T" + clockValue(*d.Time)}
}

// Encode renders a task as a complete VCALENDAR object.
func Encode(t Task) []byte {
	cal := &Component{Name: "VCALENDAR", Props: []Prop{
		{Name: "VERSION", Value: "2.0"},
		{Name: "PRODID", Value: ProdID},
		{Name: "CALSCALE", Value: "GREGORIAN"},
	}}
	if t.Due != nil && t.Due.TZ != nil && t.Due.Time != nil {
		if tz := vtimezone(*t.Due.TZ, t.Due.Date, *t.Due.Time); tz != nil {
			cal.Children = append(cal.Children, tz)
		}
	}
	todo := &Component{Name: "VTODO"}
	add := func(name, value string) { todo.Props = append(todo.Props, Prop{Name: name, Value: value}) }
	add("UID", EscapeText(t.UID))
	stamp := t.Modified
	if stamp <= 0 {
		stamp = t.CreatedAt
	}
	add("DTSTAMP", utcStamp(stamp))
	if t.CreatedAt > 0 {
		add("CREATED", utcStamp(t.CreatedAt))
	}
	add("LAST-MODIFIED", utcStamp(stamp))
	add("SUMMARY", EscapeText(t.Title))
	if t.Description != "" {
		add("DESCRIPTION", EscapeText(t.Description))
	}
	extra := extraLines(t.Extra)
	if t.Deadline != "" {
		// With a deadline, DUE is the deadline (a date) and DTSTART the planned
		// day (OpenSpec change deadlines, design D6).
		todo.Props = append(todo.Props, Prop{Name: "DUE", Params: []Param{{Name: "VALUE", Values: []string{"DATE"}}}, Value: dateValue(t.Deadline)})
		if t.Due != nil {
			todo.Props = append(todo.Props, dueProp("DTSTART", t.Due))
			extra = dropTopLevel(extra, "DTSTART")
		}
	} else if t.Due != nil {
		todo.Props = append(todo.Props, dueProp("DUE", t.Due))
		// A recurring VTODO is anchored at DTSTART; restate the due date unless
		// the client keeps its own DTSTART in the preserved remainder.
		if t.Recurrence != "" && !hasTopLevel(extra, "DTSTART") {
			todo.Props = append(todo.Props, dueProp("DTSTART", t.Due))
		}
	}
	if t.Recurrence != "" {
		if r, err := recurrence.Parse(t.Recurrence); err == nil {
			add("RRULE", r.RRULE())
		}
	}
	// iCalendar has no deferral or evening bucket: OpenTodo's own properties.
	switch {
	case t.Start == "someday":
		add("X-OPENTODO-START", "SOMEDAY")
	case t.Start != "":
		add("X-OPENTODO-START", dateValue(t.Start))
	}
	if t.Evening {
		add("X-OPENTODO-EVENING", "TRUE")
	}
	if p := AppToICalPriority(t.Priority); p != 0 {
		add("PRIORITY", strconv.Itoa(p))
	}
	completed := t.CompletedAt != nil
	if completed {
		add("STATUS", "COMPLETED")
		add("COMPLETED", utcStamp(*t.CompletedAt))
		add("PERCENT-COMPLETE", "100")
		extra = dropTopLevel(extra, "STATUS", "COMPLETED", "PERCENT-COMPLETE")
	} else if !hasTopLevel(extra, "STATUS") {
		add("STATUS", "NEEDS-ACTION")
	}
	if len(t.Categories) > 0 {
		esc := make([]string, len(t.Categories))
		for i, c := range t.Categories {
			esc[i] = EscapeText(c)
		}
		add("CATEGORIES", strings.Join(esc, ","))
	}
	if t.ParentUID != "" {
		add("RELATED-TO", EscapeText(t.ParentUID))
	}
	for _, uid := range t.DependsOn {
		todo.Props = append(todo.Props, Prop{Name: "RELATED-TO", Params: []Param{{Name: "RELTYPE", Values: []string{"DEPENDS-ON"}}}, Value: EscapeText(uid)})
	}
	lines := cal.Lines()
	lines = lines[:len(lines)-1] // reopen VCALENDAR to append the VTODO
	todoLines := todo.Lines()
	todoLines = todoLines[:len(todoLines)-1]
	lines = append(lines, todoLines...)
	lines = append(lines, extra...)
	lines = append(lines, "END:VTODO", "END:VCALENDAR")
	var b bytes.Buffer
	for _, l := range lines {
		writeFolded(&b, l)
	}
	return b.Bytes()
}

// extraLines splits the stored remainder into content lines.
func extraLines(extra string) []string {
	if extra == "" {
		return nil
	}
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(extra, "\r\n", "\n"), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// hasTopLevel reports whether a property of the given name appears outside any
// nested component (VALARM) of the remainder.
func hasTopLevel(lines []string, name string) bool {
	depth := 0
	for _, l := range lines {
		n := lineName(l)
		switch {
		case n == "BEGIN":
			depth++
		case n == "END":
			depth--
		case depth == 0 && n == name:
			return true
		}
	}
	return false
}

func dropTopLevel(lines []string, names ...string) []string {
	depth := 0
	out := lines[:0:0]
	for _, l := range lines {
		n := lineName(l)
		switch n {
		case "BEGIN":
			depth++
		case "END":
			depth--
		}
		drop := false
		if depth == 0 && n != "END" {
			for _, x := range names {
				if n == x {
					drop = true
				}
			}
		}
		if !drop {
			out = append(out, l)
		}
	}
	return out
}

func lineName(l string) string {
	i := strings.IndexAny(l, ";:")
	if i < 0 {
		return strings.ToUpper(l)
	}
	return strings.ToUpper(l[:i])
}

// vtimezone describes a zone around the given wall time: the observance in force
// at the start of that year plus every transition within it, which is enough
// for any client to resolve the due time. Clients that know the IANA name (all
// target clients do) use their own rules.
func vtimezone(tz, date, clock string) *Component {
	loc, err := zoned.Load(tz)
	if err != nil {
		return nil
	}
	at, err := zoned.Instant(date, clock, loc)
	if err != nil {
		return nil
	}
	year := at.Year()
	start := time.Date(year, 1, 1, 0, 0, 0, 0, loc)
	end := time.Date(year+1, 1, 1, 0, 0, 0, 0, loc)
	c := &Component{Name: "VTIMEZONE", Props: []Prop{{Name: "TZID", Value: tz}}}
	observance := func(t time.Time, from int, dtstart string) {
		name, off := t.Zone()
		kind := "STANDARD"
		if t.IsDST() {
			kind = "DAYLIGHT"
		}
		c.Children = append(c.Children, &Component{Name: kind, Props: []Prop{
			{Name: "DTSTART", Value: dtstart},
			{Name: "TZOFFSETFROM", Value: offsetText(from)},
			{Name: "TZOFFSETTO", Value: offsetText(off)},
			{Name: "TZNAME", Value: EscapeText(name)},
		}})
	}
	_, off0 := start.Zone()
	observance(start, off0, "19700101T000000")
	t := start
	for i := 0; i < 8; i++ {
		_, next := t.ZoneBounds()
		if next.IsZero() || !next.Before(end) {
			break
		}
		_, before := next.Add(-time.Second).Zone()
		wall := next.In(time.FixedZone("", before))
		observance(next, before, wall.Format("20060102T150405"))
		t = next
	}
	return c
}

func offsetText(sec int) string {
	sign := '+'
	if sec < 0 {
		sign, sec = '-', -sec
	}
	return fmt.Sprintf("%c%02d%02d", sign, sec/3600, (sec%3600)/60)
}

// VTimezone is the VTIMEZONE for an IANA zone around a date and time (shared
// with the task feed, OpenSpec change calendar-feeds); nil for an unknown zone.
func VTimezone(tz, date, clock string) *Component { return vtimezone(tz, date, clock) }
