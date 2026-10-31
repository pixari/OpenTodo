import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshViewerZone } from './dates'
import { getMeta, useDatabase } from './db'
import { applyOps, createProject, deleteProject, getDeviceId, resetDeviceId } from './ops'
import { fieldSortBy, type FieldDef, type Label, type Op, type Project, type Task, type View } from './types'
import {
  MAX_PANELS, START_VIEW_KEY, addPanel, compareTasks, createView, dashboardPanels, deleteView, displayOptions, evaluateViews, groupTasks,
  movePanel, removePanel, reorderView, resolveStartView, runView, setOnDrop, setPanels, setPinned, setStartView, updateView, viewOptions, type ViewContext,
} from './views'

let n = 0
let db = useDatabase('views-init')
beforeEach(() => {
  db = useDatabase(`views-${Date.now()}-${n++}`)
  resetDeviceId()
})

const TODAY = '2026-10-10'

function task(p: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: p.id, description: '', project_id: null, parent_id: null, priority: 4, due: null, labels: [], position: 0,
    estimate_minutes: null, recurrence: null, series_id: null, assignee_id: null, section_id: null, ical_extra: null, created_at: 0, completed_at: null, deleted_at: null, _clock: {}, ...p,
  }
}
function project(p: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return { color: '#000', position: 0, archived: false, parent_id: null, created_at: 0, deleted_at: null, _clock: {}, ...p }
}
function label(p: Partial<Label> & Pick<Label, 'id' | 'name'>): Label {
  return { color: '#000', position: 0, created_at: 0, deleted_at: null, _clock: {}, ...p }
}
function view(p: Partial<View> & Pick<View, 'id' | 'query'>): View {
  return {
    name: p.id, kind: 'list', group_by: 'project', sort_by: 'due', sort_dir: 'asc', pinned: true, position: 0, color: '#000',
    panels: [], on_drop: null, created_at: 0, deleted_at: null, _clock: {}, ...p,
  }
}

const LABELS = [label({ id: 'lw', name: 'work', position: 1 }), label({ id: 'lwait', name: 'waiting', position: 2 }), label({ id: 'le', name: 'errand', position: 3 })]
const PROJECTS = [
  project({ id: 'pw', name: 'Work', position: 1 }),
  project({ id: 'pc', name: 'Client A', parent_id: 'pw', position: 1 }),
  project({ id: 'ph', name: 'Home', position: 2 }),
  project({ id: 'pa', name: 'Old', position: 3, archived: true }),
]
const TASKS = [
  task({ id: 'overdue-p2', due: { date: '2026-10-08' }, priority: 2, labels: ['lw'], project_id: 'pw' }),
  task({ id: 'today-p1', due: { date: TODAY, time: '09:00' }, priority: 1, labels: ['lw'], project_id: 'pc' }),
  task({ id: 'today-p4', due: { date: TODAY }, priority: 4, labels: ['lw', 'le'] }),
  task({ id: 'tomorrow-p1', due: { date: '2026-10-11' }, priority: 1, labels: ['lw'], project_id: 'pw' }),
  task({ id: 'later-p3', due: { date: '2026-10-20' }, priority: 3, labels: ['lw'], project_id: 'ph' }),
  task({ id: 'undated-p1', priority: 1, labels: ['lw'], project_id: 'ph' }),
  task({ id: 'waiting', labels: ['lwait'] }),
  task({ id: 'done', completed_at: 5, labels: ['lw'] }),
  task({ id: 'gone', deleted_at: 5, labels: ['lw'] }),
  task({ id: 'archived', labels: ['lw'], project_id: 'pa' }),
]
const CTX: ViewContext = { today: TODAY, labels: LABELS, projects: PROJECTS, tasks: TASKS }
const ids = (ts: Task[]) => ts.map((t) => t.id)

describe('createView / updateView / deleteView', () => {
  it('creates a pinned list view through the op log with default options, last in order', async () => {
    const a = await createView({ name: ' Work tomorrow ', query: '@work & due <= tomorrow & p1' })
    const b = await createView({ name: 'Waiting', query: '@waiting', pinned: false })
    const va = await db.views.get(a)
    expect(va).toMatchObject({ name: 'Work tomorrow', query: '@work & due <= tomorrow & p1', kind: 'list', group_by: 'project', sort_by: 'due', sort_dir: 'asc', pinned: true, panels: [], deleted_at: null })
    expect((await db.views.get(b))!.position).toBeGreaterThan(va!.position)
    const outbox = await db.outbox.toArray()
    expect(outbox.filter((o) => o.entity === 'view' && o.entityId === a)).toHaveLength(12)
  })

  it('refuses an empty name, an empty query and a query that does not parse', async () => {
    await expect(createView({ name: ' ', query: 'p1' })).rejects.toThrow('name')
    await expect(createView({ name: 'x', query: '  ' })).rejects.toThrow('must not be empty')
    await expect(createView({ name: 'x', query: '@work p1' })).rejects.toThrow('Expected "&" or "|" before "p1" at position 7')
    expect(await db.views.count()).toBe(0)
  })

  it('updates only changed fields, validates the query and never changes the kind', async () => {
    const id = await createView({ name: 'Work', query: '@work' })
    const before = await db.outbox.count()
    await updateView(id, { query: '@work & !@waiting', group_by: 'due', name: 'Work' })
    const ops = (await db.outbox.toArray()).slice(before)
    expect(ops.map((o) => o.field).sort()).toEqual(['group_by', 'query'])
    expect((await db.views.get(id))!.query).toBe('@work & !@waiting')
    await expect(updateView(id, { query: 'p5' })).rejects.toThrow('Priority must be')
    await expect(updateView(id, { name: '' })).rejects.toThrow()
    expect('kind' in ({} as Parameters<typeof updateView>[1])).toBe(false)
  })

  it('pins, unpins, reorders among pinned views and tombstones on delete', async () => {
    const a = await createView({ name: 'Work tomorrow', query: '@work' })
    const b = await createView({ name: 'Waiting', query: '@waiting' })
    await reorderView(b, -1)
    const pos = async (id: string) => (await db.views.get(id))!.position
    expect(await pos(b)).toBeLessThan(await pos(a))
    await reorderView(b, -1) // already first: no-op
    expect(await pos(b)).toBeLessThan(await pos(a))
    await setPinned(b, false)
    expect((await db.views.get(b))!.pinned).toBe(false)
    await deleteView(a)
    expect((await db.views.get(a))!.deleted_at).toBeTypeOf('number')
  })

  it('a view saved offline converges with a remote edit of another option', async () => {
    const id = await createView({ name: 'Work', query: '@work' })
    await updateView(id, { group_by: 'due' })
    const local = await db.views.get(id)
    // Another device changed the sort meanwhile (older timestamp, different field): both survive.
    // Its device id sorts after any local UUID, so a tie with the creation's timestamp (both
    // local writes in consecutive milliseconds) still resolves in its favour.
    await applyOps([{ id: 'r1', entity: 'view', entityId: id, field: 'sort_by', value: 'priority', ts: local!._clock.group_by.ts - 1, device: '~B' } as Op])
    expect(await db.views.get(id)).toMatchObject({ group_by: 'due', sort_by: 'priority' })
  })
})

describe('on-drop rules (rule-boards)', () => {
  it('a rule set offline is on the row at once and survives a rename from a client without the field', async () => {
    const id = await createView({ name: 'Errands', query: '@errand' })
    await setOnDrop(id, { priority: 1 })
    expect((await db.views.get(id))!.on_drop).toEqual({ priority: 1 })
    expect((await db.outbox.toArray()).filter((o) => o.field === 'on_drop')).toHaveLength(1)
    // An older client renames the view: its op names only the field it changed.
    const ts = (await db.views.get(id))!._clock.on_drop.ts + 1
    await applyOps([{ id: 'old1', entity: 'view', entityId: id, field: 'name', value: 'Out and about', ts, device: '~old' } as Op])
    expect(await db.views.get(id)).toMatchObject({ name: 'Out and about', on_drop: { priority: 1 } })
  })

  it('a rule converges whole: the later of two concurrent rules wins', async () => {
    const id = await createView({ name: 'Errands', query: '@errand' })
    await setOnDrop(id, { priority: 1 })
    const ts = (await db.views.get(id))!._clock.on_drop.ts + 1
    await applyOps([{ id: 'r1', entity: 'view', entityId: id, field: 'on_drop', value: { add_labels: ['le'] }, ts, device: '~B' } as Op])
    expect((await db.views.get(id))!.on_drop).toEqual({ add_labels: ['le'] })
  })

  it('keeps a rule key this build does not know', async () => {
    await applyOps([{ id: 'n1', entity: 'view', entityId: 'v9', field: 'on_drop', value: { priority: 2, later_key: 'x' }, ts: 5, device: '~new' } as Op])
    expect((await db.views.get('v9'))!.on_drop).toEqual({ priority: 2, later_key: 'x' })
  })

  it('clears with null, writes nothing for an unchanged rule and refuses dashboards', async () => {
    const id = await createView({ name: 'Errands', query: '@errand' })
    await setOnDrop(id, { due: 'today' })
    await db.outbox.clear()
    await setOnDrop(id, { due: 'today' })
    expect(await db.outbox.count()).toBe(0)
    await setOnDrop(id, {})
    expect((await db.views.get(id))!.on_drop).toBeNull()
    const dash = await createView({ name: 'Board', kind: 'dashboard' })
    await expect(setOnDrop(dash, { priority: 1 })).rejects.toThrow()
  })
})

describe('dashboards', () => {
  it('sets, adds, moves and removes panels; a dashboard cannot nest a dashboard', async () => {
    const today = await createView({ name: 'Today p1', query: 'today & p1' })
    const waiting = await createView({ name: 'Waiting', query: '@waiting' })
    const dash = await createView({ name: 'Morning', kind: 'dashboard' })
    const other = await createView({ name: 'Evening', kind: 'dashboard' })
    expect((await db.views.get(dash))!.query).toBe('')

    await setPanels(dash, [today, waiting, today])
    expect((await db.views.get(dash))!.panels).toEqual([today, waiting])
    await expect(setPanels(dash, [today, other])).rejects.toThrow('cannot contain another dashboard')
    await expect(addPanel(dash, dash)).rejects.toThrow('cannot contain itself')
    await expect(setPanels(today, [waiting])).rejects.toThrow('Only dashboards')
    await expect(setPanels(dash, Array.from({ length: MAX_PANELS + 1 }, (_, i) => `v${i}`))).rejects.toThrow('at most 6')
    expect((await db.views.get(dash))!.panels).toEqual([today, waiting])

    await movePanel(dash, waiting, -1)
    expect((await db.views.get(dash))!.panels).toEqual([waiting, today])
    await removePanel(dash, waiting)
    expect((await db.views.get(dash))!.panels).toEqual([today])
  })

  it('a deleted panel view becomes a placeholder and can still be removed', async () => {
    const errands = await createView({ name: 'Errands', query: '@errand' })
    const waiting = await createView({ name: 'Waiting', query: '@waiting' })
    const dash = await createView({ name: 'Morning', kind: 'dashboard' })
    await setPanels(dash, [errands, waiting])
    await deleteView(errands)
    const views = await db.views.toArray()
    const panels = dashboardPanels((await db.views.get(dash))!, views, evaluateViews(views, CTX))
    expect(panels.map((p) => p.kind)).toEqual(['removed', 'view'])
    expect(panels[1].kind === 'view' && panels[1].summary.ok && panels[1].summary.count).toBe(1)
    await removePanel(dash, errands)
    expect((await db.views.get(dash))!.panels).toEqual([waiting])
  })
})

describe('runView', () => {
  it('evaluates the query with the filter compiler: open only, no deleted or archived tasks', () => {
    const r = runView(view({ id: 'v', query: '@work', group_by: 'none' }), CTX)
    expect(r.ok && ids(r.tasks)).toEqual(['overdue-p2', 'today-p1', 'today-p4', 'tomorrow-p1', 'later-p3', 'undated-p1'])
  })

  it('orders by the view\'s own manual order, then by position (view-manual-order)', () => {
    const all = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: 'position' }), CTX)
    const byPosition = all.ok ? ids(all.tasks) : []
    const placed = [byPosition[3], byPosition[0]]
    const r = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: 'position', manual_order: placed }), CTX)
    expect(r.ok && ids(r.tasks)).toEqual([...placed, ...byPosition.filter((id) => !placed.includes(id))])
  })

  it('shows the parse error and no results for a query that no longer parses', () => {
    expect(runView(view({ id: 'v', query: '@work & urgent' }), CTX)).toEqual({ ok: false, error: 'Unknown term "urgent" at position 9' })
  })

  it('keeps unknown names as warnings like the Filter view', () => {
    const r = runView(view({ id: 'v', query: '@nope | @waiting' }), CTX)
    expect(r.ok && r.warnings).toEqual(['No label named "nope"'])
    expect(r.ok && ids(r.tasks)).toEqual(['waiting'])
  })

  it('groups by due date under Earlier, Today, Tomorrow, later dates, then No date', () => {
    const r = runView(view({ id: 'v', query: '@work', group_by: 'due' }), CTX)
    expect(r.ok && r.groups.map((g) => g.heading).slice(0, 3)).toEqual(['Earlier', 'Today', 'Tomorrow'])
    expect(r.ok && r.groups.map((g) => g.key)).toEqual(['overdue', 'today', 'tomorrow', '2026-10-20', 'none'])
    expect(r.ok && r.groups.at(-1)!.heading).toBe('No date')
  })

  it('groups by project: Inbox first, then projects in sidebar tree order with their path', () => {
    const r = runView(view({ id: 'v', query: '@work' }), CTX)
    expect(r.ok && r.groups.map((g) => g.heading)).toEqual(['Inbox', 'Work', 'Work › Client A', 'Home'])
  })

  it('groups by priority 1 to 4 and by label in label order (a task under each of its labels)', () => {
    const p = runView(view({ id: 'v', query: '@work', group_by: 'priority' }), CTX)
    expect(p.ok && p.groups.map((g) => g.heading)).toEqual(['Priority 1', 'Priority 2', 'Priority 3', 'Priority 4'])
    const l = runView(view({ id: 'v', query: '@work | @waiting', group_by: 'label' }), CTX)
    expect(l.ok && l.groups.map((g) => g.heading)).toEqual(['work', 'waiting', 'errand'])
    expect(l.ok && ids(l.groups[2].tasks)).toEqual(['today-p4'])
    const none = runView(view({ id: 'v', query: 'no project & !@work', group_by: 'label' }), { ...CTX, labels: [] })
    expect(none.ok && none.groups.map((g) => g.heading)).toEqual(['No label'])
  })

  it('sorts by priority descending within groups: p1 first, p4 last', () => {
    const r = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: 'priority', sort_dir: 'desc' }), CTX)
    expect(r.ok && r.tasks.map((t) => t.priority)).toEqual([1, 1, 1, 2, 3, 4])
    const asc = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: 'priority', sort_dir: 'asc' }), CTX)
    expect(asc.ok && asc.tasks.map((t) => t.priority)).toEqual([4, 3, 2, 1, 1, 1])
    const grouped = runView(view({ id: 'v', query: '@work', group_by: 'due', sort_by: 'priority', sort_dir: 'desc' }), CTX)
    expect(grouped.ok && ids(grouped.groups[1].tasks)).toEqual(['today-p1', 'today-p4'])
  })

  it('sorts by due date with undated tasks last in both directions', () => {
    const asc = runView(view({ id: 'v', query: '@work', group_by: 'none' }), CTX)
    expect(asc.ok && ids(asc.tasks).at(-1)).toBe('undated-p1')
    const desc = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_dir: 'desc' }), CTX)
    expect(desc.ok && ids(desc.tasks)).toEqual(['later-p3', 'tomorrow-p1', 'today-p4', 'today-p1', 'overdue-p2', 'undated-p1'])
  })

  it('sorts by title, created and position', () => {
    const ts = [task({ id: 'a', title: 'banana', created_at: 3, position: 2 }), task({ id: 'b', title: 'Apple', created_at: 1, position: 3 }), task({ id: 'c', title: 'cherry', created_at: 2, position: 1 })]
    expect(ids([...ts].sort(compareTasks('title', 'asc')))).toEqual(['b', 'a', 'c'])
    expect(ids([...ts].sort(compareTasks('title', 'desc')))).toEqual(['c', 'a', 'b'])
    expect(ids([...ts].sort(compareTasks('created', 'asc')))).toEqual(['b', 'c', 'a'])
    expect(ids([...ts].sort(compareTasks('position', 'desc')))).toEqual(['b', 'a', 'c'])
  })

  it('sorts custom number fields by case-insensitive name across projects and keeps empty values last', () => {
    const fields: FieldDef[] = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'WSJF', project_id: 'pw', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
      { id: '22222222-2222-4222-8222-222222222222', name: 'wsjf', project_id: 'ph', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
    ]
    const tasks = [
      task({ id: 'large', project_id: 'pw', labels: ['lw'], fields: { '11111111-1111-4111-8111-111111111111': 10 } }),
      task({ id: 'small', project_id: 'ph', labels: ['lw'], fields: { '22222222-2222-4222-8222-222222222222': 2 } }),
      task({ id: 'invalid', project_id: 'pw', labels: ['lw'], due: { date: '2026-10-09' }, fields: { '11111111-1111-4111-8111-111111111111': 'ten' } }),
      task({ id: 'empty-later', project_id: 'pw', labels: ['lw'], due: { date: '2026-10-12' } }),
      task({ id: 'empty-earlier', project_id: 'ph', labels: ['lw'], due: { date: '2026-10-11' } }),
    ]
    const context: ViewContext = { ...CTX, tasks, fields }
    const asc = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: fieldSortBy('11111111-1111-4111-8111-111111111111') }), context)
    const desc = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: fieldSortBy('11111111-1111-4111-8111-111111111111'), sort_dir: 'desc' }), context)
    expect(asc.ok && ids(asc.tasks)).toEqual(['small', 'large', 'invalid', 'empty-earlier', 'empty-later'])
    expect(desc.ok && ids(desc.tasks)).toEqual(['large', 'small', 'invalid', 'empty-earlier', 'empty-later'])
  })

  it('keeps Number, Date, Text type order fixed while reversing values within each type', () => {
    const fields: FieldDef[] = [
      { id: '33333333-3333-4333-8333-333333333333', name: 'Order date', project_id: 'pw', type: 'date', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
      { id: '44444444-4444-4444-8444-444444444444', name: 'ORDER DATE', project_id: 'ph', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
      { id: '55555555-5555-4555-8555-555555555555', name: 'order date', project_id: 'pt', type: 'text', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
    ]
    const dated = task({ id: 'dated', project_id: 'pw', fields: { '33333333-3333-4333-8333-333333333333': '2026-10-20' } })
    const numbered = task({ id: 'numbered', project_id: 'ph', fields: { '44444444-4444-4444-8444-444444444444': 10 } })
    const earlier = task({ id: 'earlier', project_id: 'pw', fields: { '33333333-3333-4333-8333-333333333333': '2026-10-10' } })
    const alpha = task({ id: 'alpha', project_id: 'pt', fields: { '55555555-5555-4555-8555-555555555555': 'Alpha' } })
    const beta = task({ id: 'beta', project_id: 'pt', fields: { '55555555-5555-4555-8555-555555555555': 'beta' } })
    const context = { projects: [...PROJECTS, project({ id: 'pt', name: 'Text' })], fields }
    expect([dated, numbered, earlier, beta, alpha].sort(compareTasks(fieldSortBy('33333333-3333-4333-8333-333333333333'), 'asc', context)).map((x) => x.id)).toEqual(['numbered', 'earlier', 'dated', 'alpha', 'beta'])
    expect([alpha, earlier, beta, numbered, dated].sort(compareTasks(fieldSortBy('33333333-3333-4333-8333-333333333333'), 'desc', context)).map((x) => x.id)).toEqual(['numbered', 'dated', 'earlier', 'beta', 'alpha'])
  })

  it('sorts by a field inherited from a parent project', () => {
    const fields: FieldDef[] = [{ id: '66666666-6666-4666-8666-666666666666', name: 'Rank', project_id: 'pw', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} }]
    const tasks = [
      task({ id: 'inherited-high', project_id: 'pc', labels: ['lw'], fields: { '66666666-6666-4666-8666-666666666666': 8 } }),
      task({ id: 'inherited-low', project_id: 'pc', labels: ['lw'], fields: { '66666666-6666-4666-8666-666666666666': 1 } }),
      task({ id: 'unset', project_id: 'pc', labels: ['lw'] }),
    ]
    const result = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: fieldSortBy('66666666-6666-4666-8666-666666666666') }), { ...CTX, tasks, fields })
    expect(result.ok && ids(result.tasks)).toEqual(['inherited-low', 'inherited-high', 'unset'])
  })

  it('sorts a parent number field with inherited subproject values and same-named text fields', () => {
    const fields: FieldDef[] = [
      { id: '77777777-7777-4777-8777-777777777777', name: 'Score', project_id: 'pw', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
      { id: '88888888-8888-4888-8888-888888888888', name: 'score', project_id: 'pt', type: 'text', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
    ]
    const tasks = [
      task({ id: 'parent-number', project_id: 'pw', labels: ['lw'], fields: { '77777777-7777-4777-8777-777777777777': 5 } }),
      task({ id: 'child-number', project_id: 'pc', labels: ['lw'], fields: { '77777777-7777-4777-8777-777777777777': 2 } }),
      task({ id: 'text', project_id: 'pt', labels: ['lw'], fields: { '88888888-8888-4888-8888-888888888888': 'Alpha' } }),
      task({ id: 'invalid-number', project_id: 'pc', labels: ['lw'], due: { date: '2026-10-08' }, fields: { '77777777-7777-4777-8777-777777777777': 'bad' } }),
      task({ id: 'empty-text', project_id: 'pt', labels: ['lw'], due: { date: '2026-10-09' }, fields: { '88888888-8888-4888-8888-888888888888': '' } }),
      task({ id: 'unset', project_id: 'pw', labels: ['lw'], due: { date: '2026-10-10' } }),
    ]
    const context: ViewContext = {
      ...CTX, projects: [...PROJECTS, project({ id: 'pt', name: 'Text' })], tasks, fields,
    }
    const asc = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: fieldSortBy('77777777-7777-4777-8777-777777777777') }), context)
    const desc = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: fieldSortBy('77777777-7777-4777-8777-777777777777'), sort_dir: 'desc' }), context)
    expect(asc.ok && ids(asc.tasks)).toEqual(['child-number', 'parent-number', 'text', 'invalid-number', 'empty-text', 'unset'])
    expect(desc.ok && ids(desc.tasks)).toEqual(['parent-number', 'child-number', 'text', 'invalid-number', 'empty-text', 'unset'])
  })

  it('uses the established fallback order when custom field values tie', () => {
    const fields: FieldDef[] = [{ id: '99999999-9999-4999-8999-999999999999', name: 'Score', project_id: 'pw', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} }]
    const later = task({ id: 'later', project_id: 'pw', fields: { '99999999-9999-4999-8999-999999999999': 4 }, due: { date: '2026-10-12' }, position: 1 })
    const earlier = task({ id: 'earlier', project_id: 'pw', fields: { '99999999-9999-4999-8999-999999999999': 4 }, due: { date: '2026-10-11' }, position: 9 })
    const context = { projects: PROJECTS, fields }
    expect([later, earlier].sort(compareTasks(fieldSortBy('77777777-7777-4777-8777-777777777777'), 'asc', context)).map((x) => x.id)).toEqual(['earlier', 'later'])
  })

  it('uses the existing fallback when text values differ only by case', () => {
    const fields: FieldDef[] = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Name', project_id: 'pw', type: 'text', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} }]
    const laterDue = task({ id: 'later-due', project_id: 'pw', fields: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'apple' }, due: { date: '2026-10-12' } })
    const earlierDue = task({ id: 'earlier-due', project_id: 'pw', fields: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'Apple' }, due: { date: '2026-10-11' } })
    const context = { projects: PROJECTS, fields }
    expect([laterDue, earlierDue].sort(compareTasks(fieldSortBy('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'asc', context)).map((x) => x.id)).toEqual(['earlier-due', 'later-due'])
    expect([laterDue, earlierDue].sort(compareTasks(fieldSortBy('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'desc', context)).map((x) => x.id)).toEqual(['earlier-due', 'later-due'])
  })

  it('uses the same accent-insensitive text comparison as Title sorting', () => {
    const fields: FieldDef[] = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Name', project_id: 'pw', type: 'text', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} }]
    const emile = task({ id: 'emile', project_id: 'pw', fields: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'Émile' } })
    const zoe = task({ id: 'zoe', project_id: 'pw', fields: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'Zoe' } })
    const context = { projects: PROJECTS, fields }
    expect([zoe, emile].sort(compareTasks(fieldSortBy('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'asc', context)).map((x) => x.id)).toEqual(['emile', 'zoe'])
    expect([zoe, emile].sort(compareTasks('title', 'asc')).map((x) => x.id)).toEqual(['emile', 'zoe'])
  })

  it('groups, sorts and filters zoned dues by their date in the viewer zone (absolute-datetimes)', () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: 'Europe/Berlin' }
    })
    try {
      refreshViewerZone()
      // 02:00 Tokyo on the 11th is 19:00 in Berlin on the 10th (today).
      const tokyo = task({ id: 'tokyo', due: { date: '2026-10-11', time: '02:00', tz: 'Asia/Tokyo' } })
      const early = task({ id: 'early', due: { date: '2026-10-10', time: '20:00' } })
      const groups = groupTasks([tokyo, early], 'due', CTX)
      expect(groups.map((g) => g.key)).toEqual(['today'])
      expect(ids([early, tokyo].sort(compareTasks('due', 'asc')))).toEqual(['tokyo', 'early'])
      const r = runView(view({ id: 'v', query: 'today' }), { ...CTX, tasks: [tokyo] })
      expect(r.ok && r.tasks.length).toBe(1)
    } finally {
      spy.mockRestore()
      refreshViewerZone()
    }
  })

  it('keeps a custom-field sort attached to its definition after a rename', () => {
    const selectedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const before: FieldDef[] = [
      { id: selectedId, name: 'Impact', project_id: 'pw', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
      { id: otherId, name: 'Impact', project_id: 'ph', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
    ]
    const after = before.map((field) => ({ ...field, name: 'Effort' }))
    const tasks = [
      task({ id: 'high', project_id: 'pw', fields: { [selectedId]: 8 } }),
      task({ id: 'low', project_id: 'ph', fields: { [otherId]: 2 } }),
    ]
    const sortBy = fieldSortBy(selectedId)
    expect(viewOptions(view({ id: 'v', query: 'p1', sort_by: sortBy })).sortBy).toBe(sortBy)
    expect([...tasks].sort(compareTasks(sortBy, 'asc', { projects: PROJECTS, fields: after })).map((x) => x.id)).toEqual(['low', 'high'])
  })

  it('falls back to the view default when the selected field is deleted or unavailable', () => {
    const selectedId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const fields: FieldDef[] = [{ id: selectedId, name: 'Rank', project_id: 'pw', type: 'number', options: '', position: 0, created_at: 0, deleted_at: 1, _clock: {} }]
    const late = task({ id: 'late', labels: ['lw'], due: { date: '2026-10-12' }, priority: 1 })
    const early = task({ id: 'early', labels: ['lw'], due: { date: '2026-10-11' }, priority: 1 })
    const storedSort = fieldSortBy(selectedId)
    const result = runView(view({ id: 'v', query: '@work', group_by: 'none', sort_by: storedSort }), { ...CTX, tasks: [late, early], fields })
    expect(result.ok && ids(result.tasks)).toEqual(['early', 'late'])
    expect(viewOptions(view({ id: 'v', query: '@work', sort_by: storedSort })).sortBy).toBe(storedSort)
  })

  it('reads unknown option values as defaults', () => {
    const r = runView(view({ id: 'v', query: '@work', group_by: 'colour', sort_by: 'mood' }), CTX)
    expect(r.ok && r.groups[0].heading).toBe('Inbox')
    expect(groupTasks([], 'none', CTX)).toEqual([])
  })

  it('preserves a custom field sort value in saved view options', () => {
    expect(viewOptions(view({ id: 'v', query: '@work', sort_by: fieldSortBy('11111111-1111-4111-8111-111111111111') })).sortBy).toBe(fieldSortBy('11111111-1111-4111-8111-111111111111'))
    expect(viewOptions(view({ id: 'v', query: '@work', sort_by: 'field:' })).sortBy).toBe('due')
  })
})

describe('display options (views-and-display)', () => {
  it('a view without the fields reads as a list of open matches showing every property', () => {
    expect(displayOptions(view({ id: 'v', query: '@work' }))).toEqual({ layout: 'list', showCompleted: false, hidden: [], cardNotes: false })
  })

  it('unknown values from a newer client fall back without being rewritten', () => {
    const v = view({ id: 'v', query: '@work', layout: 'gallery', hidden_props: ['mood', 'estimate', 'date'], show_completed: 'yes' as never })
    expect(displayOptions(v)).toEqual({ layout: 'list', showCompleted: false, hidden: ['date', 'estimate'], cardNotes: false })
    expect(v.layout).toBe('gallery')
  })

  it('Completed tasks: Show lists completed matches, and leaves a query that names a state alone', () => {
    expect(ids((runView(view({ id: 'v', query: '@work', group_by: 'none', show_completed: true }), CTX) as { tasks: Task[] }).tasks)).toContain('done')
    expect(ids((runView(view({ id: 'v', query: '@work', group_by: 'none' }), CTX) as { tasks: Task[] }).tasks)).not.toContain('done')
    const open = runView(view({ id: 'v', query: '@work & open', group_by: 'none', show_completed: true }), CTX) as { tasks: Task[] }
    expect(ids(open.tasks)).not.toContain('done')
    // The sidebar counts stay counts of open matches.
    const s = evaluateViews([view({ id: 'v', query: '@work', show_completed: true })], CTX).get('v')!
    expect(s.ok && s.count).toBe(6)
  })

  it('writes display options as ops, only when they change', async () => {
    const id = await createView({ name: 'Board', query: '@work', layout: 'board', hidden_props: ['estimate'] })
    expect(await db.views.get(id)).toMatchObject({ layout: 'board', hidden_props: ['estimate'] })
    const before = await db.outbox.count()
    await updateView(id, { hidden_props: ['estimate'] })
    expect(await db.outbox.count()).toBe(before)
    await updateView(id, { show_completed: true, hidden_props: ['estimate', 'project'] })
    expect(await db.views.get(id)).toMatchObject({ show_completed: true, hidden_props: ['estimate', 'project'] })
    expect(await db.outbox.count()).toBe(before + 2)
  })
})

describe('evaluateViews', () => {
  it('sorts dashboard summaries with fields from the named workspace scope', () => {
    const remoteProject = project({ id: 'remote', name: 'Remote', workspace_id: 'w-home' })
    const fields: FieldDef[] = [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Score', project_id: 'remote', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} }]
    const tasks = [
      task({ id: 'remote-large', project_id: 'remote', fields: { 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': 10 } }),
      task({ id: 'remote-small', project_id: 'remote', fields: { 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': 2 } }),
    ]
    const context: ViewContext = {
      ...CTX, fields, workspaces: [{ id: 'w-home', name: 'Home' }],
      workspaceOf: (item) => item.project_id === 'remote' ? 'w-home' : 'current',
      everyWorkspace: { tasks, projects: [remoteProject], labels: [] },
    }
    const result = evaluateViews([
      view({ id: 'home', query: 'workspace: Home', group_by: 'none', sort_by: fieldSortBy('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') }),
    ], context, 2).get('home')
    expect(result?.ok && ids(result.tasks)).toEqual(['remote-small', 'remote-large'])
  })

  it('counts match the runner results and panels list the first tasks in view order', () => {
    const views = [
      view({ id: 'work', query: '@work', group_by: 'due' }),
      view({ id: 'waiting', query: '@waiting' }),
      view({ id: 'p1', query: 'p1 & due <= tomorrow' }),
      view({ id: 'all', query: '@work | completed' }),
      view({ id: 'broken', query: 'p5' }),
      view({ id: 'dash', query: '', kind: 'dashboard', panels: ['work'] }),
      view({ id: 'deleted', query: 'p1', deleted_at: 1 }),
    ]
    const res = evaluateViews(views, CTX, 3)
    for (const id of ['work', 'waiting', 'p1']) {
      const r = runView(views.find((v) => v.id === id)!, CTX)
      const s = res.get(id)!
      expect(s.ok && r.ok && s.count).toBe(r.ok ? r.tasks.length : -1)
      expect(s.ok && ids(s.tasks)).toEqual(r.ok ? ids(r.groups.flatMap((g) => g.tasks)).slice(0, 3) : [])
    }
    // The count is of open matches, even when the query also lists completed tasks.
    const all = res.get('all')!
    expect(all.ok && all.count).toBe(6)
    expect(res.get('broken')).toMatchObject({ ok: false })
    expect(res.has('dash')).toBe(false)
    expect(res.has('deleted')).toBe(false)
  })

  it('evaluates a few pinned views over many tasks quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => task({ id: `t${i}`, priority: ((i % 4) + 1) as Task['priority'], labels: i % 3 ? ['lw'] : ['le'], due: i % 5 ? { date: '2026-10-1' + (i % 9) } : null }))
    const views = Array.from({ length: 8 }, (_, i) => view({ id: `v${i}`, query: i % 2 ? '@work & p1' : 'due <= tomorrow | @errand' }))
    // Best of three runs after a warm-up, so a busy CI machine (parallel test files)
    // does not fail a budget meant for the evaluator itself.
    const ctx = { ...CTX, tasks: many }
    let res = evaluateViews(views, ctx)
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      res = evaluateViews(views, ctx)
      best = Math.min(best, performance.now() - start)
    }
    expect(best).toBeLessThan(200)
    expect(res.size).toBe(8)
  })
})

describe('start view', () => {
  it('defaults to the Inbox and is stored per device in meta, never in the op log', async () => {
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: false })
    await setStartView('today')
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'today', removed: false })
    const id = await createView({ name: 'Work tomorrow', query: '@work' })
    const before = await db.outbox.count()
    await setStartView(`view:${id}`)
    expect(await resolveStartView()).toEqual({ kind: 'saved', id })
    expect(await db.outbox.count()).toBe(before)
  })

  it('falls back to the Inbox with a notice when the saved start view was deleted elsewhere', async () => {
    const id = await createView({ name: 'Work tomorrow', query: '@work' })
    await setStartView(`view:${id}`)
    await getDeviceId()
    await applyOps([{ id: 'del', entity: 'view', entityId: id, field: 'deleted_at', value: Date.now(), ts: Date.now() + 60_000, device: 'phone' }])
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: true })
    // The notice is shown once: the preference is reset.
    expect(await getMeta(START_VIEW_KEY, null)).toBe('inbox')
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: false })
    await setStartView('view:never-existed')
    expect(await resolveStartView()).toMatchObject({ view: 'inbox', removed: true })
  })

  // OpenSpec display-mode, task 4.2 (custom-views "Start view per device", display routes).
  it('opens a display start view with its options', async () => {
    await setStartView('display:/display/today?eink=1')
    expect(await resolveStartView()).toEqual({ kind: 'display', path: '/display/today?eink=1' })
    await setStartView('display:/display')
    expect(await resolveStartView()).toEqual({ kind: 'display', path: '/display' })
    const pid = await createProject({ name: 'Groceries' })
    await setStartView(`display:/display/project/${pid}?size=xl`)
    expect(await resolveStartView()).toEqual({ kind: 'display', path: `/display/project/${pid}?size=xl` })
    const vid = await createView({ name: 'Fridge', query: 'today' })
    await setStartView(`display:/display/view/${vid}`)
    expect(await resolveStartView()).toEqual({ kind: 'display', path: `/display/view/${vid}` })
  })

  it('falls back to the Inbox with the notice when the display names a deleted project or view, or is malformed', async () => {
    const pid = await createProject({ name: 'Groceries' })
    await setStartView(`display:/display/project/${pid}`)
    await deleteProject(pid)
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: true })
    expect(await getMeta(START_VIEW_KEY, null)).toBe('inbox')
    await setStartView('display:/display/view/missing')
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: true })
    await setStartView('display:/settings')
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: true })
    await setStartView('display:/display/project/a/b')
    expect(await resolveStartView()).toEqual({ kind: 'builtin', view: 'inbox', removed: true })
  })
})
