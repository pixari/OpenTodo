package importer

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/pixari/opentodo/internal/recurrence"
	opsync "github.com/pixari/opentodo/internal/sync"
	"github.com/pixari/opentodo/internal/zoned"
)

// Planning an import of a foreign format: every profile other than the own
// export reads into rows of projects, sections and tasks.

type taskPlan struct {
	state     int // 0 new, 1 resolving, 2 done
	entityID  string
	projectID string
}

type projPlan struct {
	id      string
	name    string
	created bool
	row     int
}

// foreignPlan is the state of one planForeign call. The passes run in a fixed
// order (projects, their parents, sections, tasks, dependencies, then the
// changes), because ids, positions and implicit labels are allotted as rows are
// read.
type foreignPlan struct {
	pl   *planner
	rows []Row

	projBySource   map[string]*projPlan
	projByFileName map[string]*projPlan
	projChanges    []*change
	projChangeByID map[string]*change

	taskIdx         map[string]int // task source id → its first row
	plans           []taskPlan
	taskChanges     []*change
	reminderChanges [][]change
}

func (pl *planner) planForeign(rows []Row) []change {
	fp := &foreignPlan{pl: pl, rows: rows, projBySource: map[string]*projPlan{}, projByFileName: map[string]*projPlan{},
		projChangeByID: map[string]*change{}}
	fp.projects()
	fp.projectParents()
	fp.sections()
	fp.tasks()
	pl.dependencies(rows, fp.taskIdx, fp.plans, fp.taskChanges)
	return fp.changes()
}

// projects plans the projects named by rows of kind project.
func (fp *foreignPlan) projects() {
	pl := fp.pl
	for i, row := range fp.rows {
		if row.Kind != KindProject {
			continue
		}
		res := &pl.results[i]
		if row.Err != "" {
			res.Outcome, res.Reason = OutcomeError, row.Err
			continue
		}
		name := strings.TrimSpace(row.Title)
		pp := &projPlan{name: name, row: i}
		if id, ok := pl.st.Remembered[row.SourceID]; ok && pl.alive(KindProject, id) {
			pp.id = id
			res.Outcome, res.Reason = OutcomeSkip, ReasonAlreadyImported
		} else if id, ok := pl.projectByName[strings.ToLower(name)]; ok {
			pp.id = id
			res.Outcome, res.Reason = OutcomeSkip, ReasonExists
		} else if !fp.createProject(row, pp, res) {
			continue
		}
		if row.SourceID != "" {
			fp.projBySource[row.SourceID] = pp
		}
		if _, ok := fp.projByFileName[strings.ToLower(name)]; !ok {
			fp.projByFileName[strings.ToLower(name)] = pp
		}
	}
}

// createProject plans a new project for row; false when its fields are invalid
// (the row is an error then).
func (fp *foreignPlan) createProject(row Row, pp *projPlan, res *RowResult) bool {
	pl := fp.pl
	pp.id, pp.created = pl.newID(), true
	fields := []field{
		{"name", raw(pp.name)},
		{"color", raw(palette[len(fp.projChanges)%len(palette)])},
		{"position", raw(pl.nextPosition())},
		{"archived", raw(false)},
		{"created_at", raw(pl.now)},
	}
	if d := strings.TrimSpace(row.Description); d != "" {
		// The note travels with a created project only; an existing one keeps its own.
		fields = append(fields, field{"description", raw(d)})
	}
	if err := validateFields(KindProject, pp.id, fields); err != nil {
		res.Outcome, res.Reason = OutcomeError, err.Error()
		return false
	}
	res.Outcome = OutcomeCreate
	if row.SourceID != "" {
		pl.createdBySource[row.SourceID] = pp.id
	}
	c := &change{entity: KindProject, id: pp.id, fields: fields, created: true, sourceID: row.SourceID}
	fp.projChanges = append(fp.projChanges, c)
	fp.projChangeByID[pp.id] = c
	return true
}

// projectParents sets the parents of created projects, resolved after all rows
// are known, and drops a link that closes a cycle inside the file.
func (fp *foreignPlan) projectParents() {
	pl := fp.pl
	parentOf := map[string]string{}
	for i, row := range fp.rows {
		if row.Kind != KindProject || row.ParentSourceID == "" || pl.results[i].Outcome != OutcomeCreate {
			continue
		}
		pp := fp.projBySource[row.SourceID]
		if pp == nil {
			continue
		}
		parent := ""
		if pr, ok := fp.projBySource[row.ParentSourceID]; ok {
			parent = pr.id
		} else if id, ok := pl.st.Remembered[row.ParentSourceID]; ok && pl.alive(KindProject, id) {
			parent = id
		}
		if parent == "" || parent == pp.id {
			pl.results[i].Warnings = append(pl.results[i].Warnings, "parent project not found; imported as a top-level project")
			continue
		}
		parentOf[pp.id] = parent
	}
	for id, parent := range parentOf {
		// Break cycles formed inside the file: walk up and drop the link that closes one.
		seen := map[string]bool{id: true}
		cycle := false
		for cur := parent; cur != ""; cur = parentOf[cur] {
			if seen[cur] {
				cycle = true
				break
			}
			seen[cur] = true
		}
		if cycle {
			delete(parentOf, id)
			continue
		}
	}
	for id, parent := range parentOf {
		fp.projChangeByID[id].fields = append(fp.projChangeByID[id].fields, field{"parent_id", raw(parent)})
	}
}

// sections plans the sections listed by the file (json-items with sections:
// section).
func (fp *foreignPlan) sections() {
	pl := fp.pl
	for i, row := range fp.rows {
		if row.Kind != KindSection {
			continue
		}
		res := &pl.results[i]
		if row.Err != "" {
			res.Outcome, res.Reason = OutcomeError, row.Err
			continue
		}
		projectID, projectName, _ := pl.resolveProject(row, fp.projBySource, fp.projByFileName, res)
		res.Project = projectName
		if projectID == "" {
			res.Outcome, res.Reason = OutcomeSkip, ReasonNoProject
			continue
		}
		key := sectionKey(projectID, row.Title)
		if id, ok := pl.st.Remembered[row.SourceID]; ok && pl.alive(KindSection, id) {
			res.Outcome, res.Reason = OutcomeSkip, ReasonAlreadyImported
			if _, ok := pl.sectionByKey[key]; !ok {
				pl.sectionByKey[key] = id
			}
			continue
		}
		if _, ok := pl.sectionByKey[key]; ok {
			res.Outcome, res.Reason = OutcomeSkip, ReasonExists
			continue
		}
		if _, ok := pl.implicitSec[key]; ok {
			res.Outcome, res.Reason = OutcomeSkip, ReasonExists
			continue
		}
		if err := validateFields(KindSection, "validate", []field{{"name", raw(strings.TrimSpace(row.Title))}}); err != nil {
			res.Outcome, res.Reason = OutcomeError, err.Error()
			continue
		}
		pl.sectionID(projectID, row.Title, row.SourceID)
		pl.markProjectUsed(projectID)
		res.Outcome = OutcomeCreate
	}
}

// tasks plans every task row (parents first) and marks rows of an unknown kind
// as errors.
func (fp *foreignPlan) tasks() {
	rows := fp.rows
	fp.taskIdx = map[string]int{}
	for i, row := range rows {
		if row.Kind == KindTask && row.SourceID != "" {
			if _, dup := fp.taskIdx[row.SourceID]; !dup {
				fp.taskIdx[row.SourceID] = i
			}
		}
	}
	fp.plans = make([]taskPlan, len(rows))
	fp.taskChanges = make([]*change, len(rows))
	fp.reminderChanges = make([][]change, len(rows))
	for i, row := range rows {
		if row.Kind == KindTask {
			fp.resolve(i)
		} else if row.Kind != KindProject && row.Kind != KindSection {
			fp.pl.results[i].Outcome, fp.pl.results[i].Reason = OutcomeError, "unsupported row kind"
		}
	}
}

// resolve plans task row i once, resolving its parent row first.
func (fp *foreignPlan) resolve(i int) {
	pl := fp.pl
	tp := &fp.plans[i]
	if tp.state != 0 {
		return
	}
	tp.state = 1
	defer func() { tp.state = 2 }()
	row := fp.rows[i]
	res := &pl.results[i]
	if row.Err != "" {
		res.Outcome, res.Reason = OutcomeError, row.Err
		return
	}
	projectID, parentID := fp.taskPlace(i, res)
	tp.projectID = projectID
	if id, ok := pl.st.Remembered[row.SourceID]; ok && pl.alive(KindTask, id) {
		res.Outcome, res.Reason = OutcomeSkip, ReasonAlreadyImported
		tp.entityID, tp.projectID = id, str(pl.byKind[KindTask][id], "project_id")
		return
	}
	dueDate := ""
	if row.Due != nil {
		dueDate = row.Due.Date
	}
	if dup, ok := pl.fingerprints[fingerprint(row.Title, projectID, dueDate)]; ok {
		if pl.opts.Duplicates != "import" {
			res.Outcome, res.Reason = OutcomeSkip, ReasonPossibleDuplicate
			tp.entityID = dup
			return
		}
		res.Warnings = append(res.Warnings, "possible duplicate of an existing task")
	}
	labelNames, sectionName := fp.taskLabels(row, projectID, res)
	due := fp.taskDue(row)
	id := pl.newID()
	fields := fp.taskFields(row, projectID, parentID, due)
	// Label ids are only known once implicit labels are allotted; validate names
	// as a list first so a bad row does not create labels.
	if err := validateFields(KindTask, id, append(fields, field{"labels", raw(nonNil(labelNames))})); err != nil {
		res.Outcome, res.Reason = OutcomeError, err.Error()
		return
	}
	labelIDs := make([]string, 0, len(labelNames))
	for _, n := range labelNames {
		labelIDs = append(labelIDs, pl.labelID(n))
	}
	fields = append(fields, field{"labels", raw(labelIDs)})
	if sectionName != "" {
		fields = append(fields, field{"section_id", raw(pl.sectionID(projectID, sectionName, ""))})
	}
	if projectID != "" {
		pl.markProjectUsed(projectID)
	}
	res.Outcome = OutcomeCreate
	tp.entityID = id
	fp.taskChanges[i] = &change{entity: KindTask, id: id, fields: fields, created: true, sourceID: row.SourceID}
	fp.reminderChanges[i] = append(pl.reminders(id, due, row.Reminders, res), pl.links(id, row.Links, res)...)
}

// taskPlace resolves the project and the parent task of task row i (a subtask
// moves to its parent's project) and sets the row's project name.
func (fp *foreignPlan) taskPlace(i int, res *RowResult) (projectID, parentID string) {
	pl, row := fp.pl, fp.rows[i]
	projectID, projectName, explicit := pl.resolveProject(row, fp.projBySource, fp.projByFileName, res)
	if row.ParentSourceID != "" {
		parentProject := ""
		if j, ok := fp.taskIdx[row.ParentSourceID]; ok && j != i {
			if fp.plans[j].state == 1 {
				res.Warnings = append(res.Warnings, "parent forms a cycle; imported as a top-level task")
			} else {
				fp.resolve(j)
				if fp.plans[j].entityID != "" {
					parentID, parentProject = fp.plans[j].entityID, fp.plans[j].projectID
				} else {
					res.Warnings = append(res.Warnings, fmt.Sprintf("parent row %d could not be imported; imported as a top-level task", fp.rows[j].Line))
				}
			}
		} else if id, ok := pl.st.Remembered[row.ParentSourceID]; ok && pl.alive(KindTask, id) {
			parentID, parentProject = id, str(pl.byKind[KindTask][id], "project_id")
		} else {
			res.Warnings = append(res.Warnings, fmt.Sprintf("parent %q not found; imported as a top-level task", displaySource(row.ParentSourceID)))
		}
		if parentID != "" && parentProject != projectID {
			if explicit {
				res.Warnings = append(res.Warnings, "moved to its parent's project")
			}
			projectID, projectName = parentProject, ""
		}
	}
	res.Project = projectName
	if res.Project == "" && projectID != "" {
		res.Project = pl.projectLabel(projectID)
	}
	return projectID, parentID
}

// taskLabels is the row's label names and its section, which becomes a label
// when the import maps sections to labels or the task lands in the Inbox.
func (fp *foreignPlan) taskLabels(row Row, projectID string, res *RowResult) ([]string, string) {
	labelNames := append([]string{}, row.Labels...)
	sectionName := ""
	if row.SectionName != "" {
		switch {
		case fp.pl.opts.Sections == "label":
			labelNames = append(labelNames, row.SectionName)
		case fp.pl.opts.Sections == "section" && projectID == "":
			labelNames = append(labelNames, row.SectionName)
			res.Warnings = append(res.Warnings, "the Inbox has no sections; section imported as a label")
		case fp.pl.opts.Sections == "section":
			sectionName = row.SectionName
		}
	}
	return dedupeNames(labelNames), sectionName
}

// taskDue is the row's due date. Like the app, a rule on a task without a due
// date gives it the rule's first date from today (docs/recurrence.md).
func (fp *foreignPlan) taskDue(row Row) *Due {
	due := row.Due
	if row.Recurrence != "" && due == nil {
		if r, err := recurrence.Parse(row.Recurrence); err == nil {
			if first, err := r.First(time.UnixMilli(fp.pl.now).In(fp.pl.opts.Location()).Format("2006-01-02")); err == nil {
				due = &Due{Date: first}
			}
		}
	}
	return due
}

// taskFields is a new task's fields except its labels and section.
func (fp *foreignPlan) taskFields(row Row, projectID, parentID string, due *Due) []field {
	pl := fp.pl
	priority := row.Priority
	if priority == 0 {
		priority = 4
	}
	fields := []field{
		{"title", raw(row.Title)},
		{"description", raw(row.Description)},
		{"priority", raw(priority)},
		{"position", raw(pl.nextPosition())},
	}
	created := row.CreatedAt
	if created <= 0 {
		created = pl.now
	}
	fields = append(fields, field{"created_at", raw(created)})
	if projectID != "" {
		fields = append(fields, field{"project_id", raw(projectID)})
	}
	if parentID != "" {
		fields = append(fields, field{"parent_id", raw(parentID)})
	}
	if due != nil {
		fields = append(fields, field{"due", raw(due)})
	}
	if row.Recurrence != "" {
		fields = append(fields, field{"recurrence", raw(row.Recurrence)})
	}
	if row.EstimateMinutes > 0 {
		fields = append(fields, field{"estimate_minutes", raw(row.EstimateMinutes)})
	}
	if row.Deadline != "" {
		fields = append(fields, field{"deadline", raw(row.Deadline)})
	}
	if row.Start != "" {
		fields = append(fields, field{"start", raw(row.Start)})
	}
	if row.Evening {
		fields = append(fields, field{"evening", raw(true)})
	}
	if row.AssignSelf && pl.st.UserID != "" {
		fields = append(fields, field{"assignee_id", raw(pl.st.UserID)})
	}
	if row.Completed {
		at := row.CompletedAt
		if at <= 0 {
			at = pl.now
		}
		fields = append(fields, field{"completed_at", raw(at)})
	}
	return fields
}

// changes lists the planned changes in apply order: used implicit labels, the
// file's projects, used implicit projects, used sections, tasks, then their
// reminders and links.
func (fp *foreignPlan) changes() []change {
	pl := fp.pl
	var out []change
	for _, l := range pl.labelOrder {
		if !l.used {
			continue
		}
		out = append(out, change{entity: KindLabel, id: l.id, created: true, fields: []field{
			{"name", raw(l.name)},
			{"color", raw(palette[len(out)%len(palette)])},
			{"position", raw(pl.nextPosition())},
			{"created_at", raw(pl.now)},
		}})
	}
	for _, c := range fp.projChanges {
		out = append(out, *c)
	}
	for _, ip := range pl.projOrder {
		if !ip.used {
			continue
		}
		out = append(out, change{entity: KindProject, id: ip.id, created: true, fields: []field{
			{"name", raw(ip.name)},
			{"color", raw(palette[(len(fp.projChanges)+len(out))%len(palette)])},
			{"position", raw(pl.nextPosition())},
			{"archived", raw(false)},
			{"created_at", raw(pl.now)},
		}})
	}
	for _, sec := range pl.secOrder {
		if !sec.used {
			continue
		}
		out = append(out, change{entity: KindSection, id: sec.id, created: true, sourceID: sec.sourceID, fields: []field{
			{"name", raw(sec.name)},
			{"project_id", raw(sec.project)},
			{"position", raw(pl.nextPosition())},
			{"created_at", raw(pl.now)},
		}})
	}
	for _, c := range fp.taskChanges {
		if c != nil {
			out = append(out, *c)
		}
	}
	for _, list := range fp.reminderChanges {
		out = append(out, list...)
	}
	return out
}

// dependencies is the final relations pass (task-dependencies D10): once every
// task of the file has its id, a row's blockers become its blocked_by list. A
// reference outside the file and one that would close a cycle (checked in row
// order against the edges kept so far) are dropped with a warning on the row.
func (pl *planner) dependencies(rows []Row, taskIdx map[string]int, plans []taskPlan, taskChanges []*change) {
	graph := map[string][]string{}
	for i, row := range rows {
		if len(row.BlockedBySourceIDs) == 0 || taskChanges[i] == nil {
			continue
		}
		res := &pl.results[i]
		self := plans[i].entityID
		var ids []string
		for _, src := range row.BlockedBySourceIDs {
			j, ok := taskIdx[src]
			if !ok || plans[j].entityID == "" {
				res.Warnings = append(res.Warnings, fmt.Sprintf("waits for %q, which is not in this file; dependency dropped", displaySource(src)))
				continue
			}
			id := plans[j].entityID
			if id == self || slices.Contains(ids, id) {
				continue
			}
			if dependsOn(graph, id, self) {
				res.Warnings = append(res.Warnings, fmt.Sprintf("waiting for %q would make the tasks wait for each other; dependency dropped", displaySource(src)))
				continue
			}
			ids = append(ids, id)
		}
		if len(ids) == 0 {
			continue
		}
		if len(ids) > opsync.MaxBlockedBy {
			ids = ids[:opsync.MaxBlockedBy]
			res.Warnings = append(res.Warnings, fmt.Sprintf("waits for more than %d tasks; the rest were dropped", opsync.MaxBlockedBy))
		}
		graph[self] = ids
		taskChanges[i].fields = append(taskChanges[i].fields, field{"blocked_by", raw(ids)})
	}
}

// dependsOn reports whether to is reachable from from along the graph's edges.
func dependsOn(graph map[string][]string, from, to string) bool {
	seen := map[string]bool{}
	stack := []string{from}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if id == to {
			return true
		}
		if !seen[id] {
			seen[id] = true
			stack = append(stack, graph[id]...)
		}
	}
	return false
}

// sectionID returns the id of the live section named name in the project,
// allotting a new one (created once) when there is none.
func (pl *planner) sectionID(projectID, name, sourceID string) string {
	key := sectionKey(projectID, name)
	if id, ok := pl.sectionByKey[key]; ok {
		return id
	}
	sec, ok := pl.implicitSec[key]
	if !ok {
		sec = &implicit{id: pl.newID(), name: strings.TrimSpace(name), project: projectID, sourceID: sourceID}
		pl.implicitSec[key] = sec
		pl.secOrder = append(pl.secOrder, sec)
	}
	sec.used = true
	return sec.id
}

// dueInstant is the instant a floating due denotes in the chosen time zone,
// 09:00 for a date-only due (as REST due changes resolve relative reminders).
func (pl *planner) dueInstant(d *Due) (int64, bool) {
	clock := d.Time
	if clock == "" {
		clock = "09:00"
	}
	t, err := zoned.Instant(d.Date, clock, pl.opts.Location())
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

// reminders builds the reminder entities of a created task (design D4).
func (pl *planner) reminders(taskID string, due *Due, list []Reminder, res *RowResult) []change {
	var out []change
	for _, r := range list {
		id := pl.newID()
		var fire int64
		fields := []field{{"task_id", raw(taskID)}}
		if r.Absolute {
			fire = r.At
			fields = append(fields, field{"kind", raw("absolute")}, field{"offset_minutes", json.RawMessage("null")})
		} else {
			fields = append(fields, field{"kind", raw("relative")}, field{"offset_minutes", raw(r.Offset)})
			if due != nil {
				if at, ok := pl.dueInstant(due); ok {
					fire = at + int64(r.Offset)*60_000
				}
			} else {
				res.Warnings = append(res.Warnings, "relative reminder on a task without a due date will not fire")
			}
		}
		if fire > 0 {
			fields = append(fields, field{"fire_at", raw(fire)})
		} else {
			fields = append(fields, field{"fire_at", json.RawMessage("null")})
		}
		fields = append(fields, field{"created_at", raw(pl.now)}, field{"delivered_at", json.RawMessage("null")})
		if fire > 0 && fire < pl.now {
			fields = append(fields, field{"dismissed_at", raw(pl.now)})
			res.Warnings = append(res.Warnings, warnPastReminder)
		} else {
			fields = append(fields, field{"dismissed_at", json.RawMessage("null")})
		}
		if err := validateFields(KindReminder, id, fields); err != nil {
			res.Warnings = append(res.Warnings, "reminder dropped: "+err.Error())
			continue
		}
		out = append(out, change{entity: KindReminder, id: id, fields: fields, created: true})
	}
	return out
}

// links builds the link attachments of a created task (attachments D12).
func (pl *planner) links(taskID string, list []Link, res *RowResult) []change {
	var out []change
	for _, l := range list {
		id := pl.newID()
		name := []rune(strings.NewReplacer("/", "-", "\\", "-").Replace(strings.TrimSpace(l.Name)))
		if len(name) > opsync.MaxAttachmentName {
			name = name[:opsync.MaxAttachmentName]
		}
		fields := []field{
			{"task_id", raw(taskID)}, {"author_id", raw(pl.st.UserID)}, {"comment_id", json.RawMessage("null")},
			{"name", raw(string(name))}, {"mime", raw("text/uri-list")}, {"size", raw(0)}, {"sha256", raw("")},
			{"url", raw(l.URL)}, {"encrypted", raw(false)}, {"created_at", raw(pl.now)},
			{"uploaded_at", json.RawMessage("null")}, {"deleted_at", json.RawMessage("null")},
		}
		if err := validateFields(KindAttachment, id, fields); err != nil {
			res.Warnings = append(res.Warnings, "link dropped: "+err.Error())
			continue
		}
		out = append(out, change{entity: KindAttachment, id: id, fields: fields, created: true})
	}
	return out
}

func displaySource(s string) string {
	for _, p := range []string{"id:", "task:", "item:"} {
		s = strings.TrimPrefix(s, p)
	}
	return s
}
