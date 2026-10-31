// Display options of project and label pages (OpenSpec change list-display-options):
// reading the stored options with their defaults, writing them as ops, and the
// groups and order a project's list and a label's page show with them.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { currentDateTime } from './dates'
import { db } from './db'
import { defaultListDisplay, isDefaultDisplay, listDisplayOf, setListDisplay } from './listDisplay'
import { listGroups, sectionBuckets, type GroupInput } from './listGroups'
import { buildTaskTree } from './subtasks'
import { fieldSortBy, type FieldDef, type Label, type Project, type Section, type Task } from './types'
import { compareTasks } from './views'
import { createField } from './fields'
import { createProject } from './ops'

const TODAY = '2026-10-14'
let n = 0
function task(over: Partial<Task> = {}): Task {
  n++
  return {
    id: over.id ?? `t${n}`, title: over.title ?? `Task ${n}`, notes: '', project_id: 'p', section_id: null, parent_id: null, position: n,
    priority: 4, due: null, deadline: null, start: null, labels: [], completed_at: null, deleted_at: null, created_at: n, updated_at: n,
    assignee_id: null, ...over,
  } as Task
}
const label = (id: string, position: number) => ({ id, name: id, color: '#000', position, created_at: 0, deleted_at: null }) as Label
const section = (id: string, position: number) => ({ id, project_id: 'p', name: id, position, deleted_at: null }) as Section

function projectInput(tasks: Task[], over: Partial<GroupInput> = {}, sections: Section[] = []): GroupInput {
  const tree = buildTaskTree(tasks)
  const proj = { id: 'p', name: 'P', position: 1, archived: false, deleted_at: null } as Project
  return {
    view: 'project', tasks, laterTasks: [], tree, today: TODAY, resolved: currentDateTime(), collapsed: new Set(), blocked: new Set(),
    taskMap: new Map(tasks.map((x) => [x.id, x])), projects: [proj], projectMap: new Map([['p', proj]]), board: false, columns: [],
    buckets: sectionBuckets('p', tree, sections), sectionCount: sections.length, collapsedSections: [], logbook: null, ...over,
  }
}
const titles = (g: { rows: { task: Task }[] }) => g.rows.map((r) => r.task.title)

describe('listDisplayOf', () => {
  it('reads missing, empty and unknown values as the page default', () => {
    expect(listDisplayOf('project', null)).toEqual({ groupBy: 'section', sortBy: 'position', sortDir: 'asc', rowLayout: 'line' })
    expect(listDisplayOf('label', { group_by: '', sort_by: 'colour', sort_dir: 'up' }, 'detailed')).toEqual({ groupBy: 'project', sortBy: 'position', sortDir: 'asc', rowLayout: 'detailed' })
    // The page's own layout wins over the account's.
    expect(listDisplayOf('label', { row_layout: 'line' }, 'detailed').rowLayout).toBe('line')
    // A label page has no sections and no grouping by label; a project none by project.
    expect(listDisplayOf('label', { group_by: 'section' }).groupBy).toBe('project')
    expect(listDisplayOf('project', { group_by: 'project' }).groupBy).toBe('section')
    expect(listDisplayOf('project', { group_by: 'priority', sort_by: 'deadline', sort_dir: 'desc' })).toEqual({ groupBy: 'priority', sortBy: 'deadline', sortDir: 'desc', rowLayout: 'line' })
    expect(listDisplayOf('project', { sort_by: fieldSortBy('cccccccc-cccc-4ccc-8ccc-cccccccccccc') }).sortBy).toBe(fieldSortBy('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))
    expect(listDisplayOf('project', { sort_by: 'field:' }).sortBy).toBe('position')
    expect(isDefaultDisplay('project', defaultListDisplay('project'))).toBe(true)
    expect(isDefaultDisplay('label', { groupBy: 'project', sortBy: 'title', sortDir: 'asc', rowLayout: 'line' })).toBe(false)
  })
})

describe('setListDisplay', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('writes a project choice to the personal prefs row and a label choice to the label, one op per field', async () => {
    await setListDisplay({ kind: 'project', id: 'p1' }, { groupBy: 'priority', sortBy: 'due' })
    expect(await db.prefs.get('p1')).toMatchObject({ group_by: 'priority', sort_by: 'due' })
    const ops = await db.outbox.toArray()
    expect(ops.map((o) => `${o.entity}.${o.field}`).sort()).toEqual(['project_prefs.group_by', 'project_prefs.sort_by'])
    await db.labels.put(label('l1', 1))
    await setListDisplay({ kind: 'label', id: 'l1' }, { sortDir: 'desc' })
    expect(await db.labels.get('l1')).toMatchObject({ name: 'l1', sort_dir: 'desc' })
    await setListDisplay({ kind: 'project', id: 'p1' }, { sortBy: fieldSortBy('cccccccc-cccc-4ccc-8ccc-cccccccccccc') })
    expect(await db.prefs.get('p1')).toMatchObject({ sort_by: fieldSortBy('cccccccc-cccc-4ccc-8ccc-cccccccccccc') })
  })

  it('stores only the field definition ID in the sync sort operation', async () => {
    const projectId = await createProject({ name: 'Home' })
    const fieldName = 'Salary review'
    const fieldId = await createField(projectId, { name: fieldName, type: 'number' })
    const sortBy = fieldSortBy(fieldId)
    await setListDisplay({ kind: 'project', id: projectId }, { sortBy })

    const op = (await db.outbox.toArray()).findLast((candidate) => candidate.entity === 'project_prefs' && candidate.entityId === projectId && candidate.field === 'sort_by')
    expect(op?.value).toBe(sortBy)
    expect(JSON.stringify(op)).not.toContain(fieldName)
  })
})

describe('compareTasks by deadline', () => {
  it('puts tasks without a deadline last in either direction', () => {
    const a = task({ title: 'A', deadline: '2026-10-20' })
    const b = task({ title: 'B', deadline: '2026-10-15' })
    const none = task({ title: 'None' })
    expect([none, a, b].sort(compareTasks('deadline', 'asc')).map((x) => x.title)).toEqual(['B', 'A', 'None'])
    expect([none, b, a].sort(compareTasks('deadline', 'desc')).map((x) => x.title)).toEqual(['A', 'B', 'None'])
  })
})

describe('project list with display options', () => {
  it('sorts roots by a custom field across its project and keeps children attached', () => {
    const field: FieldDef = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'WSJF', project_id: 'p', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} }
    const parent = task({ title: 'Parent', fields: { 'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 10 } })
    const child = task({ title: 'Child', parent_id: parent.id, fields: { 'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 100 } })
    const sibling = task({ title: 'Sibling', fields: { 'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 2 } })
    const empty = task({ title: 'Empty' })
    const parked = task({ title: 'Parked', start: 'someday', fields: { 'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 1 } })
    const g = listGroups({
      ...projectInput([parent, child, sibling, empty], { laterTasks: [parked] }), fields: [field],
      display: { groupBy: 'section', sortBy: fieldSortBy('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), sortDir: 'asc', rowLayout: 'line' },
    })
    expect(g.map((group) => [group.key, titles(group)])).toEqual([['all', ['Sibling', 'Parent', 'Child', 'Empty']], ['later', ['Parked']]])
  })

  it('falls back to manual order when a project field sort is unavailable', () => {
    const manualFirst = task({ title: 'Manual first', position: 1, due: { date: '2026-10-20' } })
    const manualSecond = task({ title: 'Manual second', position: 2, due: { date: '2026-10-10' } })
    const g = listGroups({
      ...projectInput([manualFirst, manualSecond]),
      display: { groupBy: 'section', sortBy: fieldSortBy('ffffffff-ffff-4fff-8fff-ffffffffffff'), sortDir: 'desc', rowLayout: 'line' },
    })
    expect(g.flatMap(titles)).toEqual(['Manual first', 'Manual second'])
  })

  it('keeps sections and manual order by default, and orders each section when an order is chosen', () => {
    const s1 = section('s1', 1)
    const late = task({ title: 'Late', priority: 3, section_id: 's1' })
    const urgent = task({ title: 'Urgent', priority: 1, section_id: 's1' })
    const loose = task({ title: 'Loose' })
    const base = projectInput([late, urgent, loose], {}, [s1])
    expect(listGroups(base).map((g) => [g.key, titles(g)])).toEqual([['section:', ['Loose']], ['section:s1', ['Late', 'Urgent']]])
    const byPriority = listGroups({ ...base, display: { groupBy: 'section', sortBy: 'priority', sortDir: 'desc', rowLayout: 'line' } })
    expect(byPriority.map((g) => [g.key, titles(g)])).toEqual([['section:', ['Loose']], ['section:s1', ['Urgent', 'Late']]])
  })

  it('groups by priority with subtasks under their parent, and ungrouped ignores sections', () => {
    const s1 = section('s1', 1)
    const parent = task({ title: 'Parent', priority: 2, section_id: 's1' })
    const child = task({ title: 'Child', priority: 4, parent_id: parent.id })
    const other = task({ title: 'Other', priority: 4 })
    const base = projectInput([parent, child, other], {}, [s1])
    const grouped = listGroups({ ...base, display: { groupBy: 'priority', sortBy: 'position', sortDir: 'asc', rowLayout: 'line' } })
    expect(grouped.map((g) => [g.heading, titles(g)])).toEqual([['Priority 2', ['Parent', 'Child']], ['Priority 4', ['Other']]])
    expect(grouped[0].rows[1]).toMatchObject({ depth: 1, parent: parent.id })
    const flat = listGroups({ ...base, display: { groupBy: 'none', sortBy: 'title', sortDir: 'asc', rowLayout: 'line' } })
    expect(flat.map((g) => [g.key, titles(g)])).toEqual([['all', ['Other', 'Parent', 'Child']]])
  })

  it('groups by label with each task once, under its first label in label order', () => {
    const both = task({ title: 'Both', labels: ['l2', 'l1'] })
    const none = task({ title: 'Bare' })
    const g = listGroups({ ...projectInput([both, none]), labels: [label('l2', 2), label('l1', 1)], display: { groupBy: 'label', sortBy: 'position', sortDir: 'asc', rowLayout: 'line' } })
    expect(g.map((x) => [x.heading, titles(x)])).toEqual([['l1', ['Both']], ['No label', ['Bare']]])
    expect(g[0].named).toBe(true)
  })

  it('groups by do date in the view order of headings', () => {
    const today = task({ title: 'Now', due: { date: TODAY } })
    const later = task({ title: 'Later', due: { date: '2026-10-30' } })
    const undated = task({ title: 'Undated' })
    const g = listGroups({ ...projectInput([undated, later, today]), display: { groupBy: 'due', sortBy: 'position', sortDir: 'asc', rowLayout: 'line' } })
    expect(g.map((x) => x.key)).toEqual(['today', '2026-10-30', 'none'])
  })
})

describe('label page with display options', () => {
  it('sorts custom fields inside project groups using each project definition', () => {
    const projects = [
      { id: 'p1', name: 'One', color: '#000', position: 1, archived: false, parent_id: null, created_at: 0, deleted_at: null, _clock: {} },
      { id: 'p2', name: 'Two', color: '#000', position: 2, archived: false, parent_id: null, created_at: 0, deleted_at: null, _clock: {} },
    ] as Project[]
    const fields: FieldDef[] = [
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Score', project_id: 'p1', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'score', project_id: 'p2', type: 'number', options: '', position: 0, created_at: 0, deleted_at: null, _clock: {} },
    ]
    const tasks = [
      task({ id: 'one-high', title: 'High one', project_id: 'p1', fields: { 'dddddddd-dddd-4ddd-8ddd-dddddddddddd': 9 } }),
      task({ id: 'one-low', title: 'Low one', project_id: 'p1', fields: { 'dddddddd-dddd-4ddd-8ddd-dddddddddddd': 2 } }),
      task({ id: 'two-high', title: 'High two', project_id: 'p2', fields: { 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee': 8 } }),
      task({ id: 'two-low', title: 'Low two', project_id: 'p2', fields: { 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee': 1 } }),
    ]
    const base: GroupInput = {
      ...projectInput([]), view: 'label', tree: null, buckets: null, tasks, projects,
      projectMap: new Map(projects.map((p) => [p.id, p])), fields,
      display: { groupBy: 'project', sortBy: fieldSortBy('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), sortDir: 'asc', rowLayout: 'line' },
    }
    expect(listGroups(base).map((group) => [group.key, titles(group)])).toEqual([
      ['p1', ['Low one', 'High one']], ['p2', ['Low two', 'High two']],
    ])
  })

  it('orders within project groups, or groups by priority instead', () => {
    const a = task({ title: 'Beta', project_id: null, priority: 1 })
    const b = task({ title: 'Alpha', project_id: null, priority: 3 })
    const base: GroupInput = { ...projectInput([]), view: 'label', tree: null, buckets: null, tasks: [a, b] }
    expect(listGroups({ ...base, display: { groupBy: 'project', sortBy: 'title', sortDir: 'asc', rowLayout: 'line' } }).map(titles)).toEqual([['Alpha', 'Beta']])
    const byPriority = listGroups({ ...base, display: { groupBy: 'priority', sortBy: 'position', sortDir: 'asc', rowLayout: 'line' } })
    expect(byPriority.map((g) => [g.heading, titles(g)])).toEqual([['Priority 1', ['Beta']], ['Priority 3', ['Alpha']]])
  })

  it('lists its own manual order first, then the rest by position (view-manual-order)', () => {
    const a = task({ title: 'One', project_id: null })
    const b = task({ title: 'Two', project_id: null })
    const c = task({ title: 'Three', project_id: null })
    const base: GroupInput = { ...projectInput([]), view: 'label', tree: null, buckets: null, tasks: [a, b, c], manualOrder: new Map([[c.id, 0]]) }
    const manual = { groupBy: 'project', sortBy: 'position', sortDir: 'asc', rowLayout: 'line' } as const
    expect(listGroups({ ...base, display: manual }).map(titles)).toEqual([['Three', 'One', 'Two']])
    expect(listGroups({ ...base, display: { ...manual, sortDir: 'desc' } }).map(titles)).toEqual([['Two', 'One', 'Three']])
    expect(listGroups({ ...base, display: { ...manual, groupBy: 'none' } }).map(titles)).toEqual([['Three', 'One', 'Two']])
  })
})
