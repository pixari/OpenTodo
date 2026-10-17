package quickadd

import (
	"sort"

	"github.com/pixari/opentodo/internal/recurrence"
)

// Context is the reference state of one parse (ParseContext in parse.ts).
type Context struct {
	Today         string    `json:"today"` // YYYY-MM-DD
	Now           string    `json:"now"`   // HH:MM
	Languages     []string  `json:"languages"`
	Projects      []Project `json:"projects"`
	DayMonthOrder string    `json:"dayMonthOrder,omitempty"` // DM | MD; the first language's when empty
	WeekStart     *int      `json:"weekStart,omitempty"`     // 0 = Sunday; Monday when nil
}

// Due is a floating due date with an optional time.
type Due struct {
	Date string `json:"date"`
	Time string `json:"time,omitempty"`
}

// Result is what a line sets (ParseResult in parse.ts, without the chips).
type Result struct {
	Title           string     `json:"title"`
	Due             *Due       `json:"due"`
	Deadline        string     `json:"deadline,omitempty"`
	Someday         bool       `json:"someday,omitempty"`
	Evening         bool       `json:"evening,omitempty"`
	ProjectID       string     `json:"projectId,omitempty"`
	Labels          []string   `json:"labels"`
	Priority        int        `json:"priority,omitempty"`
	EstimateMinutes int        `json:"estimateMinutes,omitempty"`
	Recurrence      string     `json:"recurrence,omitempty"`
	Reminders       []Reminder `json:"reminders"`
}

func spanOf(line string, tokens []token, from, to int) Span {
	s, e := tokens[from].start, tokens[to-1].end
	return Span{s, e, line[s:e]}
}

func newCtx(ctx Context) *dateCtx {
	vocabs := vocabsFor(ctx.Languages)
	order := ctx.DayMonthOrder
	if order == "" {
		order = vocabs[0].DayMonthOrder
	}
	ws := 1
	if ctx.WeekStart != nil {
		ws = *ctx.WeekStart
	}
	return &dateCtx{today: ctx.Today, now: ctx.Now, vocabs: vocabs, dayMonthOrder: order, weekStart: ws}
}

// Parse reads a quick-add line. Pure: the result depends only on the line and ctx.
func Parse(line string, ctx Context) Result {
	p := &parser{line: line, ctx: ctx, dctx: newCtx(ctx)}
	for _, v := range p.dctx.vocabs {
		p.bareHourIsTime = p.bareHourIsTime || v.HourSuffixH
	}
	var quotes []Span
	p.tokens, quotes = tokenize(line)
	for i := 0; i < len(p.tokens); {
		i = p.step(i)
	}
	return p.result(quotes)
}

// found is one recognised value and the span of the line it came from.
type found struct {
	value string
	span  Span
	set   bool
}

// parser is the state of one Parse call: the tokens and what was recognised.
type parser struct {
	line           string
	ctx            Context
	dctx           *dateCtx
	bareHourIsTime bool
	tokens         []token

	date, deadline, project, rec found
	timeV                        struct {
		value, date string
		span        Span
		set         bool
	}
	priority, estimate struct {
		value int
		span  Span
	}
	evening, someday *Span
	labels           []found
	reminders        []struct {
		value Reminder
		span  Span
	}
}

func (p *parser) span(from, to int) Span { return spanOf(p.line, p.tokens, from, to) }

// step reads what starts at token i and returns the index of the next token
// to read.
func (p *parser) step(i int) int {
	if p.tokens[i].quoted {
		return i + 1
	}
	if next, ok := p.attribute(i); ok {
		return next
	}
	return p.phrase(i)
}

// attribute matches the single-token attributes (project, label, priority,
// estimate), a deadline and the evening words at token i.
func (p *parser) attribute(i int) (int, bool) {
	t, tokens, dctx := p.tokens[i], p.tokens, p.dctx
	one := p.span(i, i+1)
	if !p.project.set && len(t.text) > 1 && t.text[0] == '#' {
		if pr := matchProject(t.text, p.ctx.Projects); pr != nil {
			p.project = found{pr.ID, one, true}
			return i + 1, true
		}
	}
	if l, ok := matchLabel(t.text); ok {
		p.labels = append(p.labels, found{l, one, true})
		return i + 1, true
	}
	if p.priority.value == 0 {
		if pr := matchPriority(t.text); pr > 0 {
			p.priority.value, p.priority.span = pr, one
			return i + 1, true
		}
	}
	if p.estimate.value == 0 {
		if m := matchDuration(t.text, p.bareHourIsTime); m > 0 {
			p.estimate.value, p.estimate.span = m, one
			return i + 1, true
		}
	}
	if !p.deadline.set {
		if dl := matchDeadlineAt(tokens, i, dctx); dl != nil {
			p.deadline = found{dl.date, p.span(dl.from, dl.to), true}
			next := dl.to
			if tm := matchTimeAt(tokens, dl.to, dctx); tm != nil {
				next = tm.to
			}
			return next, true
		}
	}
	if p.evening == nil {
		if n := wordsAt(tokens, i, dctx, func(v *Vocab) []string { return v.EveningWords }); n > 0 {
			s := p.span(i, i+n)
			p.evening = &s
			if !p.date.set {
				p.date = found{p.ctx.Today, s, true}
			}
			return i + n, true
		}
	}
	return 0, false
}

// phrase matches the longest of a date, a time, a recurrence or a reminder at
// token i, then the someday words; an unrecognised token stays in the title.
func (p *parser) phrase(i int) int {
	tokens, dctx := p.tokens, p.dctx
	var dm *dateMatch
	var tm *timeMatch
	var rm *recMatch
	if !p.date.set {
		dm = matchDateAt(tokens, i, dctx)
	}
	if !p.timeV.set {
		tm = matchTimeAt(tokens, i, dctx)
	}
	if !p.rec.set {
		rm = matchRecurrenceAt(tokens, i, dctx)
	}
	mm := matchReminderAt(tokens, i, dctx)
	end := func(to int, ok bool) int {
		if ok {
			return to
		}
		return 0
	}
	phraseEnd := max(end(rmTo(rm)), end(mmTo(mm)))
	switch {
	case phraseEnd > max(end(dmTo(dm)), end(tmTo(tm))):
		if rm != nil && rm.to == phraseEnd {
			p.rec = found{rm.rule, p.span(rm.from, rm.to), true}
			return rm.to
		} else if mm != nil {
			p.reminders = append(p.reminders, struct {
				value Reminder
				span  Span
			}{mm.reminder, p.span(mm.from, mm.to)})
			return mm.to
		}
		return i
	case dm != nil && (tm == nil || dm.to >= tm.to):
		p.date = found{dm.date, p.span(dm.from, dm.to), true}
		return dm.to
	case tm != nil:
		p.timeV.value, p.timeV.date, p.timeV.span, p.timeV.set = tm.time, tm.date, p.span(tm.from, tm.to), true
		return tm.to
	}
	n := 0
	if p.someday == nil {
		n = wordsAt(tokens, i, dctx, func(v *Vocab) []string { return v.SomedayWords })
	}
	if n > 0 {
		s := p.span(i, i+n)
		p.someday = &s
		return i + n
	}
	return i + 1
}

// due is the due date the line sets: its date, or the recurrence's first
// date, the time's own date or today when only those were given.
func (p *parser) due() *Due {
	if !p.date.set && !p.timeV.set && !p.rec.set {
		return nil
	}
	d := p.date.value
	if !p.date.set {
		switch {
		case p.rec.set:
			r, _ := recurrence.Parse(p.rec.value)
			d, _ = r.First(p.ctx.Today)
		case p.timeV.date != "":
			d = p.timeV.date
		default:
			d = p.ctx.Today
		}
	}
	due := &Due{Date: d}
	if p.timeV.set {
		due.Time = p.timeV.value
	}
	return due
}

// result builds the Result and the title: the line without the recognised
// spans (quoted text always stays).
func (p *parser) result(quotes []Span) Result {
	parked := p.someday != nil && !p.date.set && !p.timeV.set && !p.deadline.set && !p.rec.set
	var remove []Span
	add := func(s Span, ok bool) {
		if ok {
			remove = append(remove, s)
		}
	}
	add(p.date.span, p.date.set)
	add(p.timeV.span, p.timeV.set)
	if p.evening != nil {
		remove = append(remove, *p.evening)
	}
	if parked {
		remove = append(remove, *p.someday)
	}
	add(p.deadline.span, p.deadline.set)
	add(p.project.span, p.project.set)
	add(p.rec.span, p.rec.set)
	add(p.priority.span, p.priority.value > 0)
	add(p.estimate.span, p.estimate.value > 0)
	out := Result{Due: p.due(), Deadline: p.deadline.value, Someday: parked, Evening: p.evening != nil, ProjectID: p.project.value,
		Priority: p.priority.value, EstimateMinutes: p.estimate.value, Recurrence: p.rec.value, Labels: []string{}, Reminders: []Reminder{}}
	for _, l := range p.labels {
		remove = append(remove, l.span)
		out.Labels = append(out.Labels, l.value)
	}
	for _, r := range p.reminders {
		remove = append(remove, r.span)
		out.Reminders = append(out.Reminders, r.value)
	}
	sort.Slice(remove, func(a, b int) bool { return remove[a].Start < remove[b].Start })
	out.Title = stripSpans(p.line, remove, quotes)
	return out
}

func rmTo(m *recMatch) (int, bool) {
	if m == nil {
		return 0, false
	}
	return m.to, true
}
func mmTo(m *remMatch) (int, bool) {
	if m == nil {
		return 0, false
	}
	return m.to, true
}
func dmTo(m *dateMatch) (int, bool) {
	if m == nil {
		return 0, false
	}
	return m.to, true
}
func tmTo(m *timeMatch) (int, bool) {
	if m == nil {
		return 0, false
	}
	return m.to, true
}

// ParseReminder parses a reminder body without its trigger word ("30 min
// before", "tomorrow at 9"), for `ot add --remind`.
func ParseReminder(phrase string, ctx Context) (Reminder, bool) {
	tokens, _ := tokenize(phrase)
	r, to, ok := parseReminderAt(tokens, 0, newCtx(ctx))
	return r, ok && to == len(tokens)
}
