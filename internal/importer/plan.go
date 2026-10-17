package importer

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	opsync "github.com/pixari/opentodo/internal/sync"
)

// Row outcomes in a preview or job.
const (
	OutcomeCreate = "create"
	OutcomeUpdate = "update"
	OutcomeSkip   = "skip"
	OutcomeError  = "error"
)

// Skip reasons.
const (
	ReasonAlreadyImported   = "already_imported"
	ReasonPossibleDuplicate = "possible_duplicate"
	ReasonExists            = "exists"
	ReasonUnchanged         = "unchanged"
	ReasonDeleted           = "deleted"
	// ReasonNoProject: a section listed by the file whose project is the Inbox
	// (sections always belong to a project).
	ReasonNoProject = "no_project"
)

// State is the part of the user's current data the planner needs.
type State struct {
	Projects, Labels, Tasks []opsync.Entity // including tombstoned ones
	// Sections, Reminders and Views (including tombstoned ones) let own-export
	// rows detect existing ids and foreign rows reuse sections by name.
	Sections, Reminders, Views []opsync.Entity
	// UserPrefs holds the account's own date and time preferences row, if any.
	UserPrefs []opsync.Entity
	// Fields are custom field definitions, tombstoned ones included (custom-fields).
	Fields []opsync.Entity
	// Review holds the account's own "last weekly review" row, if any.
	Review []opsync.Entity
	// Attachments (including removed ones) let own-export rows detect existing ids.
	Attachments []opsync.Entity
	// UserID is the importing account (own-export assignees are kept only for it).
	UserID string
	// Remembered maps source ids recorded by earlier, not undone imports of the
	// same profile to the entity ids they created.
	Remembered map[string]string
}

// RowResult is the per-row outcome shown in a preview.
type RowResult struct {
	Row      int      `json:"row,omitempty"`
	File     string   `json:"file,omitempty"`
	SourceID string   `json:"sourceId,omitempty"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title"`
	Project  string   `json:"project,omitempty"`
	Outcome  string   `json:"outcome"`
	Reason   string   `json:"reason,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// RowError is a row that could not be imported.
type RowError struct {
	Row      int    `json:"row,omitempty"`
	SourceID string `json:"sourceId,omitempty"`
	Reason   string `json:"reason"`
}

func (e RowError) String() string {
	where := "row " + fmt.Sprint(e.Row)
	if e.Row == 0 {
		where = "source id " + e.SourceID
	}
	return where + ": " + e.Reason
}

// Totals counts outcomes; Entities, Written and Ops report commit progress.
type Totals struct {
	Rows               int `json:"rows"`
	Create             int `json:"create"`
	Update             int `json:"update"`
	Skip               int `json:"skip"`
	Error              int `json:"error"`
	PossibleDuplicates int `json:"possibleDuplicates"`
	Warnings           int `json:"warnings"`
	NewProjects        int `json:"newProjects"`
	NewLabels          int `json:"newLabels"`
	// NewSections, Recurring (created or updated tasks with a rule) and
	// Reminders (created live reminders) are additive (import-completeness).
	NewSections int `json:"newSections"`
	Recurring   int `json:"recurring"`
	Reminders   int `json:"reminders"`
	// Deadlines counts created or updated tasks with a deadline (deadlines); additive.
	Deadlines int `json:"deadlines"`
	// Attachments counts created attachments, files and links (attachments); additive.
	Attachments int `json:"attachments"`
	// Fields counts created live custom field definitions (custom-fields); additive.
	Fields   int `json:"fields"`
	Entities int `json:"entities"`
	Written  int `json:"written"`
	Ops      int `json:"ops"`
	// Refused counts ops the sync engine refused for authorization reasons (for
	// example a shared project whose role changed during the import); additive.
	Refused int `json:"refused,omitempty"`
}

// Columns lists the recognised and ignored CSV columns.
type Columns struct {
	Recognised []string `json:"recognised"`
	Ignored    []string `json:"ignored"`
}

// Plan is a dry run: what each row would do and the entity changes to write.
type Plan struct {
	Format    string      `json:"format"`
	Version   int         `json:"version,omitempty"`
	Columns   *Columns    `json:"columns,omitempty"`
	Options   Options     `json:"options"`
	Totals    Totals      `json:"totals"`
	Rows      []RowResult `json:"rows"`
	Truncated bool        `json:"truncated"`
	// Notes are file-level remarks, such as records that are not imported.
	Notes []string `json:"notes"`
	// ViewHints are projects this import creates that were boards in the source
	// app; the web app opens them as boards on the importing device.
	ViewHints []PlanViewHint `json:"viewHints,omitempty"`
	// Template is set when the file is a template (project-templates D7): the web
	// app suggests "From a template" for a fresh copy.
	Template *TemplateInfo `json:"template,omitempty"`

	changes []change
	errors  []RowError
}

// Errors returns every row error, in file order.
func (p *Plan) Errors() []RowError { return p.errors }

type field struct {
	name  string
	value json.RawMessage
}

// change is one entity's set of field writes.
type change struct {
	entity   string
	id       string
	fields   []field
	created  bool
	sourceID string
	// file holds the bytes of an own-export attachment from a ZIP (attachments D12).
	file []byte
}

// value returns the value written to field name, or nil.
func (c change) value(name string) json.RawMessage {
	for _, f := range c.fields {
		if f.name == name {
			return f.value
		}
	}
	return nil
}

var palette = []string{"#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"}

func raw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func str(e opsync.Entity, f string) string {
	var s string
	if v, ok := e[f]; ok {
		_ = json.Unmarshal(v, &s)
	}
	return s
}

func isNull(v json.RawMessage) bool { return len(v) == 0 || string(v) == "null" }

// validateFields runs the op schema check on every field so a row that the op log
// would refuse is reported as a row error instead of failing a whole batch.
func validateFields(entity, id string, fields []field) error {
	for _, f := range fields {
		op := opsync.Op{ID: "validate", Entity: entity, EntityID: id, Field: f.name, Value: f.value, TS: 1, Device: Device}
		if err := opsync.Validate(op); err != nil {
			return fmt.Errorf("%s", strings.TrimPrefix(err.Error(), opsync.ErrInvalidOp.Error()+": "))
		}
	}
	return nil
}

type planner struct {
	opts   Options
	st     *State
	now    int64
	newID  func() string
	byKind map[string]map[string]opsync.Entity
	// files are the attachment files of an own ZIP export, by id.
	files   map[string][]byte
	results []RowResult

	projectByName map[string]string // lower name → existing, non-deleted project id
	labelByName   map[string]string
	fingerprints  map[string]string // open task fingerprint → task id

	implicitProj map[string]*implicit
	implicitByID map[string]*implicit
	implicitLbl  map[string]*implicit
	labelOrder   []*implicit
	projOrder    []*implicit
	position     int64

	sectionByKey map[string]string    // project id NUL lower name → existing live section id
	implicitSec  map[string]*implicit // sections to create, by the same key
	secOrder     []*implicit

	// createdBySource maps a project row's source id to the id of the project this
	// import creates (for view hints).
	createdBySource map[string]string
}

// PlanViewHint asks the importing device to open a created project as a board.
type PlanViewHint struct {
	ProjectID string `json:"projectId"`
	View      string `json:"view"`
}

type implicit struct {
	id, name string
	used     bool
	// project and sourceID are set for sections.
	project, sourceID string
}

func sectionKey(projectID, name string) string {
	return projectID + "\x00" + strings.ToLower(strings.TrimSpace(name))
}

// BuildPlan resolves rows against the current state. It never writes anything.
func BuildPlan(parsed *Parsed, opts Options, st *State, now time.Time, newID func() string) *Plan {
	pl := &planner{opts: opts, st: st, now: now.UnixMilli(), newID: newID, position: now.UnixMilli(), files: parsed.Files,
		byKind: map[string]map[string]opsync.Entity{KindProject: {}, KindLabel: {}, KindTask: {},
			KindSection: {}, KindReminder: {}, KindView: {}, KindUserPrefs: {}, KindAttachment: {}, KindField: {}, KindReview: {}},
		projectByName: map[string]string{}, labelByName: map[string]string{}, fingerprints: map[string]string{},
		implicitProj: map[string]*implicit{}, implicitByID: map[string]*implicit{}, implicitLbl: map[string]*implicit{},
		sectionByKey: map[string]string{}, implicitSec: map[string]*implicit{}, createdBySource: map[string]string{}}
	if st.Remembered == nil {
		st.Remembered = map[string]string{}
	}
	for kind, list := range map[string][]opsync.Entity{KindProject: st.Projects, KindLabel: st.Labels, KindTask: st.Tasks,
		KindSection: st.Sections, KindReminder: st.Reminders, KindView: st.Views, KindUserPrefs: st.UserPrefs, KindAttachment: st.Attachments, KindField: st.Fields, KindReview: st.Review} {
		for _, e := range list {
			id := str(e, "id")
			pl.byKind[kind][id] = e
		}
	}
	for _, e := range st.Projects {
		if n := strings.ToLower(strings.TrimSpace(str(e, "name"))); n != "" && !e.Deleted() {
			if _, ok := pl.projectByName[n]; !ok {
				pl.projectByName[n] = str(e, "id")
			}
		}
	}
	for _, e := range st.Sections {
		if n := strings.TrimSpace(str(e, "name")); n != "" && !e.Deleted() {
			if _, ok := pl.sectionByKey[sectionKey(str(e, "project_id"), n)]; !ok {
				pl.sectionByKey[sectionKey(str(e, "project_id"), n)] = str(e, "id")
			}
		}
	}
	for _, e := range st.Labels {
		if n := strings.ToLower(strings.TrimSpace(str(e, "name"))); n != "" && !e.Deleted() {
			if _, ok := pl.labelByName[n]; !ok {
				pl.labelByName[n] = str(e, "id")
			}
		}
	}
	for _, e := range st.Tasks {
		if e.Deleted() || !isNull(e["completed_at"]) {
			continue
		}
		var due struct {
			Date string `json:"date"`
		}
		if v := e["due"]; !isNull(v) {
			_ = json.Unmarshal(v, &due)
		}
		key := fingerprint(str(e, "title"), str(e, "project_id"), due.Date)
		if _, ok := pl.fingerprints[key]; !ok {
			pl.fingerprints[key] = str(e, "id")
		}
	}

	p := &Plan{Format: parsed.Format, Version: parsed.Version, Options: opts, Notes: nonNil(parsed.Notes), Template: parsed.Template}
	if parsed.Format == "csv" {
		p.Columns = &Columns{Recognised: nonNil(parsed.Recognised), Ignored: nonNil(parsed.Ignored)}
	}
	pl.results = make([]RowResult, len(parsed.Rows))
	for i, r := range parsed.Rows {
		pl.results[i] = RowResult{Row: r.Line, File: r.File, SourceID: r.SourceID, Kind: r.Kind, Title: r.Title, Warnings: r.Warnings}
	}
	if parsed.Format == "opentodo" {
		p.changes = pl.planOwn(parsed.Rows)
	} else {
		p.changes = pl.planForeign(parsed.Rows)
	}
	for i := range pl.results {
		r := &pl.results[i]
		p.Totals.Rows++
		switch r.Outcome {
		case OutcomeCreate:
			p.Totals.Create++
		case OutcomeUpdate:
			p.Totals.Update++
		case OutcomeSkip:
			p.Totals.Skip++
		case OutcomeError:
			p.Totals.Error++
			p.errors = append(p.errors, RowError{Row: r.Row, SourceID: r.SourceID, Reason: r.Reason})
		}
		if r.Reason == ReasonPossibleDuplicate || hasPrefix(r.Warnings, "possible duplicate") {
			p.Totals.PossibleDuplicates++
		}
		if len(r.Warnings) > 0 {
			p.Totals.Warnings++
		}
	}
	for _, c := range p.changes {
		if c.created && c.entity == KindProject {
			p.Totals.NewProjects++
		}
		if c.created && c.entity == KindLabel {
			p.Totals.NewLabels++
		}
		live := isNull(c.value("deleted_at"))
		switch {
		case c.created && c.entity == KindField && live:
			p.Totals.Fields++
		case c.created && c.entity == KindSection && live:
			p.Totals.NewSections++
		case c.entity == KindTask && live && !isNull(c.value("recurrence")):
			p.Totals.Recurring++
		case c.created && c.entity == KindReminder && live:
			p.Totals.Reminders++
		}
		if c.entity == KindTask && live && !isNull(c.value("deadline")) {
			p.Totals.Deadlines++
		}
		if c.created && c.entity == KindAttachment && live {
			p.Totals.Attachments++
		}
	}
	p.Totals.Entities = len(p.changes)
	seenHint := map[string]bool{}
	for _, h := range parsed.ViewHints {
		if id, ok := pl.createdBySource[h.ProjectSourceID]; ok && !seenHint[id] {
			seenHint[id] = true
			p.ViewHints = append(p.ViewHints, PlanViewHint{ProjectID: id, View: h.View})
		}
	}
	p.Rows, p.Truncated = previewRows(pl.results)
	return p
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func hasPrefix(list []string, prefix string) bool {
	for _, s := range list {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}

func fingerprint(title, projectID, dueDate string) string {
	return strings.ToLower(strings.TrimSpace(title)) + "\x00" + projectID + "\x00" + dueDate
}

// previewRows keeps the response bounded: rows that need attention (errors,
// skips, updates, warnings) come first, then creates, in file order.
func previewRows(all []RowResult) ([]RowResult, bool) {
	if len(all) <= MaxPreviewRows {
		return all, false
	}
	keep := make([]bool, len(all))
	n := 0
	for pass := 0; pass < 2 && n < MaxPreviewRows; pass++ {
		for i, r := range all {
			if n >= MaxPreviewRows {
				break
			}
			attention := r.Outcome != OutcomeCreate || len(r.Warnings) > 0
			if !keep[i] && (pass == 1 || attention) {
				keep[i] = true
				n++
			}
		}
	}
	out := make([]RowResult, 0, n)
	for i, r := range all {
		if keep[i] {
			out = append(out, r)
		}
	}
	return out, true
}

func (pl *planner) nextPosition() int64 {
	pl.position++
	return pl.position
}

func (pl *planner) alive(kind, id string) bool {
	e := pl.byKind[kind][id]
	return e != nil && !e.Deleted()
}

// resolveProject returns the project id ("" for the Inbox), a display name, and
// whether the row named a project itself.
func (pl *planner) resolveProject(row Row, bySource, byFileName map[string]*projPlan, res *RowResult) (string, string, bool) {
	if row.ProjectSourceID != "" {
		if pp, ok := bySource[row.ProjectSourceID]; ok {
			return pp.id, pp.name, true
		}
		if id, ok := pl.st.Remembered[row.ProjectSourceID]; ok && pl.alive(KindProject, id) {
			return id, str(pl.byKind[KindProject][id], "name"), true
		}
		if row.ProjectName == "" {
			res.Warnings = append(res.Warnings, "project not found; imported into the target project")
		}
	}
	if name := strings.TrimSpace(row.ProjectName); name != "" {
		key := strings.ToLower(name)
		if id, ok := pl.projectByName[key]; ok {
			return id, str(pl.byKind[KindProject][id], "name"), true
		}
		if pp, ok := byFileName[key]; ok {
			return pp.id, pp.name, true
		}
		ip, ok := pl.implicitProj[key]
		if !ok {
			ip = &implicit{id: pl.newID(), name: name}
			pl.implicitProj[key] = ip
			pl.implicitByID[ip.id] = ip
			pl.projOrder = append(pl.projOrder, ip)
		}
		return ip.id, ip.name, true
	}
	if pl.opts.TargetProject != "" {
		return pl.opts.TargetProject, str(pl.byKind[KindProject][pl.opts.TargetProject], "name"), false
	}
	return "", "", false
}

func (pl *planner) projectLabel(id string) string {
	if e := pl.byKind[KindProject][id]; e != nil {
		return str(e, "name")
	}
	if ip, ok := pl.implicitByID[id]; ok {
		return ip.name
	}
	return ""
}

func (pl *planner) markProjectUsed(id string) {
	if ip, ok := pl.implicitByID[id]; ok {
		ip.used = true
	}
}

func (pl *planner) labelID(name string) string {
	key := strings.ToLower(name)
	if id, ok := pl.labelByName[key]; ok {
		return id
	}
	l, ok := pl.implicitLbl[key]
	if !ok {
		l = &implicit{id: pl.newID(), name: name}
		pl.implicitLbl[key] = l
		pl.labelOrder = append(pl.labelOrder, l)
	}
	l.used = true
	return l.id
}
