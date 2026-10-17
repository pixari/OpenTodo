package caldav

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/recurrence"
	"github.com/pixari/opentodo/internal/zoned"
)

// Decode reads a client's VCALENDAR body and maps its VTODO onto task fields.
func Decode(body []byte) (*Inbound, error) {
	cal, err := Parse(body)
	if err != nil {
		return nil, err
	}
	master, uid, err := masterVTODO(cal)
	if err != nil {
		return nil, err
	}
	d := &decoder{in: &Inbound{UID: uid, Priority: 4}}
	for i := range master.Props {
		d.prop(master, i)
	}
	in := d.in
	in.Completed = d.status == "COMPLETED" || d.status == "CANCELLED" || (d.status == "" && in.CompletedAt != nil)
	if !in.Completed {
		in.CompletedAt = nil
	}
	d.dates()
	for _, ch := range master.Children {
		d.extra = append(d.extra, ch.Lines()...)
	}
	in.Extra = strings.Join(d.extra, "\r\n")
	return in, nil
}

// masterVTODO finds the calendar's one UID and the VTODO that carries the
// task. Per-occurrence overrides (RECURRENCE-ID) are not modelled.
func masterVTODO(cal *Component) (*Component, string, error) {
	var master *Component
	uid := ""
	for _, c := range cal.Children {
		switch c.Name {
		case "VTIMEZONE":
			continue
		case "VTODO":
		case "VEVENT", "VJOURNAL", "VFREEBUSY":
			return nil, "", ErrUnsupportedComponent
		default:
			continue
		}
		u := c.Prop("UID")
		if u == nil || strings.TrimSpace(UnescapeText(u.Value)) == "" {
			return nil, "", fmt.Errorf("%w: VTODO without UID", ErrInvalidObject)
		}
		if uid != "" && strings.TrimSpace(UnescapeText(u.Value)) != uid {
			return nil, "", fmt.Errorf("%w: more than one UID", ErrInvalidObject)
		}
		uid = strings.TrimSpace(UnescapeText(u.Value))
		// The master component carries the task.
		if c.Prop("RECURRENCE-ID") == nil && master == nil {
			master = c
		}
	}
	if uid == "" {
		return nil, "", fmt.Errorf("%w: no VTODO", ErrInvalidObject)
	}
	if master == nil {
		return nil, "", fmt.Errorf("%w: only occurrence overrides, no master VTODO", ErrInvalidObject)
	}
	return master, uid, nil
}

// decoder is the state of one Decode call: the task fields read so far, the
// lines kept as client data (extra), and the properties read after the loop.
type decoder struct {
	in      *Inbound
	extra   []string
	dtstart *Prop
	rrule   *Prop
	status  string
}

// keep stores a property the task fields do not model as client data.
func (d *decoder) keep(p Prop) { d.extra = append(d.extra, p.Line()) }

// prop reads master's property i.
func (d *decoder) prop(master *Component, i int) {
	in, p := d.in, master.Props[i]
	switch p.Name {
	case "UID", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE":
	case "SUMMARY":
		in.Title = UnescapeText(p.Value)
	case "DESCRIPTION":
		in.Description = UnescapeText(p.Value)
	case "PRIORITY":
		n, err := strconv.Atoi(strings.TrimSpace(p.Value))
		if err != nil {
			d.keep(p)
			return
		}
		in.Priority = ICalToAppPriority(n)
	case "DUE":
		due, err := parseDue(p)
		if err != nil || in.Due != nil {
			d.keep(p)
			return
		}
		in.Due = due
	case "DTSTART":
		d.dtstart = &master.Props[i]
	case "RRULE":
		if d.rrule != nil {
			d.keep(p)
			return
		}
		d.rrule = &master.Props[i]
	case "STATUS":
		d.status = strings.ToUpper(strings.TrimSpace(p.Value))
		if d.status == "IN-PROCESS" {
			d.keep(p)
		}
	case "COMPLETED":
		if ms, err := instantOf(p); err == nil {
			in.CompletedAt = &ms
		}
	case "PERCENT-COMPLETE":
		if strings.TrimSpace(p.Value) != "100" {
			d.keep(p)
		}
	case "CATEGORIES":
		for _, c := range SplitText(p.Value) {
			if c = strings.TrimSpace(c); c != "" {
				in.Categories = append(in.Categories, c)
			}
		}
	case "RELATED-TO":
		d.relatedTo(p)
	case "CREATED":
		if ms, err := instantOf(p); err == nil {
			in.CreatedAt = &ms
		}
	case "X-OPENTODO-START", "X-OPENTODO-EVENING":
		d.opentodoProp(p)
	default:
		d.keep(p)
	}
}

// relatedTo reads RELATED-TO: the first parent link and every DEPENDS-ON;
// anything else is client data.
func (d *decoder) relatedTo(p Prop) {
	in := d.in
	rt := strings.ToUpper(p.Param("RELTYPE"))
	if (rt == "" || rt == "PARENT") && in.ParentUID == "" && strings.TrimSpace(p.Value) != "" {
		in.ParentUID = UnescapeText(strings.TrimSpace(p.Value))
		return
	}
	if rt == "DEPENDS-ON" && strings.TrimSpace(p.Value) != "" {
		in.DependsOn = append(in.DependsOn, UnescapeText(strings.TrimSpace(p.Value)))
		return
	}
	d.keep(p)
}

// opentodoProp reads this server's own X-OPENTODO-START and X-OPENTODO-EVENING.
func (d *decoder) opentodoProp(p Prop) {
	in := d.in
	v := strings.ToUpper(strings.TrimSpace(p.Value))
	if p.Name == "X-OPENTODO-START" {
		if v == "SOMEDAY" {
			s := "someday"
			in.Start = &s
		} else if date, err := isoDate(v); err == nil {
			in.Start = &date
		} else {
			d.keep(p)
		}
		return
	}
	switch v {
	case "TRUE":
		b := true
		in.Evening = &b
	case "FALSE":
		b := false
		in.Evening = &b
	default:
		d.keep(p)
	}
}

// dates maps DTSTART, DUE and RRULE (design D6): differing DTSTART and DUE are
// the planned day and the deadline (the date of DUE, any time dropped). Equal
// ones set the due date only; the DTSTART is the anchor this server writes on
// recurring tasks (Encode) and is kept as client data only when the rule stays
// unmapped. A DTSTART without a DUE, or one that does not parse, is client data.
func (d *decoder) dates() {
	in, dtstart, rrule := d.in, d.dtstart, d.rrule
	in.DueOnly = in.Due != nil && dtstart == nil
	startEqual := false
	if dtstart != nil && in.Due != nil {
		if start, err := parseDue(*dtstart); err == nil {
			if sameDue(start, in.Due) {
				startEqual = true
			} else {
				in.Deadline = in.Due.Date
				in.Due = start
			}
		}
	}
	if rrule != nil {
		in.RRULE = strings.TrimSpace(rrule.Value)
		due := ""
		if in.Due != nil {
			due = in.Due.Date
		}
		if r, ok := recurrence.FromRRULE(in.RRULE, due); ok {
			in.Rule = r.Canonical()
		} else {
			d.extra = append(d.extra, rrule.Line())
		}
	}
	if dtstart != nil && in.Deadline == "" && !(startEqual && in.Rule != "") {
		d.extra = append([]string{dtstart.Line()}, d.extra...)
	}
}

func sameDue(a, b *Due) bool {
	eq := func(x, y *string) bool { return (x == nil && y == nil) || (x != nil && y != nil && *x == *y) }
	return a.Date == b.Date && eq(a.Time, b.Time) && eq(a.TZ, b.TZ)
}

// parseDue maps a DUE (or DTSTART) property onto a due value: VALUE=DATE is a
// floating date, a date-time without zone is floating, TZID with a known IANA
// zone (or a known suffix of a vendor path such as /mozilla.org/…/Europe/Berlin)
// is zoned, a UTC time is zoned in UTC, and an unknown TZID falls back to the
// floating wall time. Seconds are dropped.
func parseDue(p Prop) (*Due, error) {
	v := strings.TrimSpace(p.Value)
	if len(v) == 8 || strings.EqualFold(p.Param("VALUE"), "DATE") {
		if len(v) < 8 {
			return nil, fmt.Errorf("%w: bad date", ErrInvalid)
		}
		d, err := isoDate(v[:8])
		if err != nil {
			return nil, err
		}
		return &Due{Date: d}, nil
	}
	if len(v) < 13 || v[8] != 'T' {
		return nil, fmt.Errorf("%w: bad date-time", ErrInvalid)
	}
	d, err := isoDate(v[:8])
	if err != nil {
		return nil, err
	}
	hh, mm := v[9:11], v[11:13]
	if !digits(hh) || !digits(mm) || hh > "23" || mm > "59" {
		return nil, fmt.Errorf("%w: bad time", ErrInvalid)
	}
	clock := hh + ":" + mm
	due := &Due{Date: d, Time: &clock}
	switch {
	case strings.HasSuffix(v, "Z"):
		utc := "UTC"
		due.TZ = &utc
	case p.Param("TZID") != "":
		if tz := ianaZone(p.Param("TZID")); tz != "" {
			due.TZ = &tz
		}
	}
	return due, nil
}

// ianaZone resolves a TZID to an IANA zone name, or "" when unknown.
func ianaZone(tzid string) string {
	tzid = strings.Trim(strings.TrimSpace(tzid), "/")
	if zoned.Valid(tzid) {
		return tzid
	}
	parts := strings.Split(tzid, "/")
	for i := 1; i < len(parts); i++ {
		if cand := strings.Join(parts[i:], "/"); zoned.Valid(cand) {
			return cand
		}
	}
	return ""
}

// instantOf reads a DATE-TIME property (COMPLETED, CREATED) as Unix
// milliseconds: UTC, a TZID wall time, or a floating time read as UTC.
func instantOf(p Prop) (int64, error) {
	d, err := parseDue(p)
	if err != nil {
		return 0, err
	}
	clock := "00:00"
	if d.Time != nil {
		clock = *d.Time
	}
	loc := time.UTC
	if d.TZ != nil {
		if l, err := zoned.Load(*d.TZ); err == nil {
			loc = l
		}
	}
	t, err := zoned.Instant(d.Date, clock, loc)
	if err != nil {
		return 0, err
	}
	sec := 0
	v := strings.TrimSpace(p.Value)
	if len(v) >= 15 && digits(v[13:15]) {
		sec, _ = strconv.Atoi(v[13:15])
	}
	return t.UnixMilli() + int64(sec)*1000, nil
}

func isoDate(v string) (string, error) {
	if !digits(v) || len(v) != 8 {
		return "", fmt.Errorf("%w: bad date", ErrInvalid)
	}
	d := v[:4] + "-" + v[4:6] + "-" + v[6:8]
	if _, err := time.Parse("2006-01-02", d); err != nil {
		return "", fmt.Errorf("%w: bad date", ErrInvalid)
	}
	return d, nil
}

func digits(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return s != ""
}
