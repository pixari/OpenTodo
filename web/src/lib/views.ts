// Saved views (OpenSpec change `custom-views`): named filter queries with grouping
// and sort options, pinned to the sidebar, composed into dashboards. Every write is
// an op through mutate(); evaluation reuses the filter compiler from lib/filter, so a
// saved view behaves exactly like the same query typed into the Filter view.
import { useLiveQuery } from 'dexie-react-hooks'
import { addDaysISO, compareDue, formatDateHeading, localDate, localDueOf } from './dates'
import type { RowLayout } from './rowLayout'
import { db, getMeta, setMeta } from './db'
import { compile, filterScope, mentionsState, namesWorkspace, parse, withCompletedTasks, type FilterContext, type Node } from './filter'
import type { BoardTemplate } from './boardTemplates'
import { activeLabels } from './labels'
import { applicableFieldsLookup } from './fieldTree'
import { nameKey } from './fieldNames'
import { VIEW_DEFAULTS, getDeviceId, mutate, mutateMany, mutationTables, type Change } from './ops'
import { knownRule } from './rules'
import { buildProjectTree } from './projects'
import { ancestors, flattenTree } from './tree'
import {
  GROUP_BY_OPTIONS, ROW_PROPERTIES, SORT_BY_OPTIONS, SORT_DIR_OPTIONS, VIEW_KINDS, VIEW_LAYOUTS,
  fieldSortId, isFieldSortBy, type FieldDef, type GroupBy, type OnDropRule, type Project, type RowProperty, type SortBy, type SortDir, type Task, type View, type ViewKind, type ViewLayout,
} from './types'
import { t, msg } from './i18n'
import { uuid } from './ids'
import { workspaceFields } from './workspaces'
import { compareManual, orderRank } from './viewOrder'
import { spanOf } from './span'

// ---- Today and Upcoming selection (OpenSpec change `deadlines`, design D3) ----
// One definition shared by the list, its grouping and the sidebar count.

type DatedTask = Pick<Task, 'completed_at' | 'due' | 'deadline' | 'start'> & { project_id?: string | null; span?: boolean }

// ---- start dates, Someday and This Evening (OpenSpec change `someday-and-evening`, D2) ----

type StartTask = Pick<Task, 'start'>

/** Parked in Someday. */
export const isSomeday = (item: StartTask): boolean => item.start === 'someday'
/** Deferred: a start date still in the future. */
export const isDeferred = (item: StartTask, today: string): boolean => !!item.start && item.start !== 'someday' && item.start > today
/** Started: a start date that has come (the task stays in Today until handled). */
export const isStarted = (item: StartTask, today: string): boolean => !!item.start && item.start !== 'someday' && item.start <= today
/** Neither parked nor deferred: what the planning views and counts consider. */
export const isActive = (item: StartTask, today: string): boolean => !isSomeday(item) && !isDeferred(item, today)

/** A due date or deadline today or earlier: wins over deferral and parking. */
function hardDate(task: Pick<Task, 'due' | 'deadline'>, today: string): boolean {
  const deadline = task.deadline ?? null
  return (!!task.due && localDueOf(task.due).date <= today) || (deadline !== null && deadline <= today)
}

/**
 * Today lists open tasks due today or earlier, whose deadline is today or past,
 * or whose start date has come. A hard date wins over deferral and Someday.
 */
export function inToday(item: DatedTask, today: string): boolean {
  if (item.completed_at) return false
  return hardDate(item, today) || isStarted(item, today)
}

/** Anytime: open, active tasks with no date of any kind and no start. */
export function inAnytime(item: DatedTask, today: string): boolean {
  return !item.completed_at && isActive(item, today) && !item.due && !(item.deadline ?? null) && (item.start ?? null) === null
}

/** Counted in the sidebar (Inbox, projects): open and active. */
export function openCount(task: Pick<Task, 'completed_at' | 'start'>, today: string): boolean {
  return !task.completed_at && isActive(task, today)
}

/** The Later group of a project or Inbox view: deferred or parked. */
export const inLater = (item: StartTask, today: string): boolean => isSomeday(item) || isDeferred(item, today)

/** Within Today, the Overdue group: due before today, or deadline passed and not planned for today. */
export function overdueInToday(item: DatedTask, today: string): boolean {
  const due = item.due ? localDueOf(item.due).date : null
  const deadline = item.deadline ?? null
  return (due !== null && due < today) || (deadline !== null && deadline < today && due !== today)
}

/** Upcoming lists open tasks due after today, and undated ones whose deadline is ahead. */
export function inUpcoming(item: DatedTask, today: string): boolean {
  if (deferredUnplaced(item, today)) return true
  // A span is listed once, under its first day, and only before it (multi-day-tasks D5).
  if (spanOf(item)) return !item.completed_at && isDeferred(item, today)
  if (item.completed_at || !isActive(item, today)) return false
  if (item.due) return localDueOf(item.due).date > today
  const deadline = item.deadline ?? null
  return deadline !== null && deadline > today
}

/**
 * A deferred task without a project and without a do-on date (inbox-means-unplaced
 * D3): not an Inbox task, so Upcoming lists it on its start date to keep it reachable.
 */
export function deferredUnplaced(item: DatedTask, today: string): boolean {
  return !item.completed_at && item.project_id === null && !item.due && isDeferred(item, today) // inbox-rule-ok: a scheduled task, listed in Upcoming
}

/** The Upcoming day a task is listed under: its due date, else its start date when deferredUnplaced, else its deadline. */
export function upcomingDate(task: Pick<Task, 'due' | 'deadline' | 'completed_at' | 'start'> & { project_id?: string | null; span?: boolean }, today?: string): string | null {
  const span = spanOf(task)
  if (span) return span.first
  if (task.due) return localDueOf(task.due).date
  if (today !== undefined && deferredUnplaced(task, today)) return task.start ?? null
  return task.deadline ?? null
}

/** A dashboard shows at most this many panels. */
export const MAX_PANELS = 6
/** Tasks listed per dashboard panel. */
export const PANEL_TASKS = 10

export interface ViewOptions {
  kind: ViewKind
  groupBy: GroupBy
  sortBy: SortBy
  sortDir: SortDir
}

/** A list view's display options (views-and-display D2), read like viewOptions. */
export interface DisplayOptions {
  layout: ViewLayout
  showCompleted: boolean
  /** Row properties the view hides; names this build does not know are left out. */
  hidden: RowProperty[]
  /** Cards show two lines of their notes (board-polish D4). */
  cardNotes: boolean
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * The view's options with values this build does not know (sent by a newer client)
 * mapped to the defaults. Read-time only: the stored row is never rewritten, so the
 * newer client keeps its value and every replica still converges on the same ops.
 */
export function viewOptions(v: Pick<View, 'kind' | 'group_by' | 'sort_by' | 'sort_dir'>): ViewOptions {
  return {
    kind: pick(v.kind, VIEW_KINDS, VIEW_DEFAULTS.kind as ViewKind),
    groupBy: pick(v.group_by, GROUP_BY_OPTIONS, VIEW_DEFAULTS.group_by as GroupBy),
    sortBy: isFieldSortBy(v.sort_by) ? v.sort_by : pick(v.sort_by, SORT_BY_OPTIONS, VIEW_DEFAULTS.sort_by as SortBy),
    sortDir: pick(v.sort_dir, SORT_DIR_OPTIONS, VIEW_DEFAULTS.sort_dir as SortDir),
  }
}

/** The display options of a view; a row written before views-and-display (no fields) shows everything as before. */
export function displayOptions(v: Partial<Pick<View, 'layout' | 'show_completed' | 'hidden_props' | 'card_notes'>>): DisplayOptions {
  const hidden = Array.isArray(v.hidden_props) ? v.hidden_props : []
  return {
    layout: pick(v.layout, VIEW_LAYOUTS, 'list'),
    showCompleted: v.show_completed === true,
    // The Board layout's notes preview (board-polish D4): only an exact true turns it on.
    cardNotes: v.card_notes === true,
    hidden: ROW_PROPERTIES.filter((p) => hidden.includes(p)),
  }
}

/** Unknown kinds read as `list` (see viewOptions), so only the exact value makes a dashboard. */
export const isDashboard = (v: Pick<View, 'kind'>): boolean => v.kind === 'dashboard'

/** Non-deleted views in sidebar order. */
export function activeViews(views: View[]): View[] {
  return views.filter((v) => !v.deleted_at).sort((a, b) => a.position - b.position || a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
}

// ---- writes (all through the op log) ----

/** Throws a readable error when a list view's query does not parse; dashboards carry no query. */
function checkQuery(query: string, kind: ViewKind): void {
  if (kind === 'dashboard') return
  if (!query.trim()) throw new Error(t('The query must not be empty'))
  parse(query) // FilterSyntaxError carries the message shown by the Filter view
}

async function liveViews(): Promise<View[]> {
  return activeViews(await db.views.toArray())
}

export interface NewView {
  name: string
  query?: string
  kind?: ViewKind
  group_by?: GroupBy
  sort_by?: SortBy
  sort_dir?: SortDir
  pinned?: boolean
  color?: string
  layout?: ViewLayout
  show_completed?: boolean
  hidden_props?: RowProperty[]
  /** One line or detailed rows (row-layouts); absent follows the account's choice. */
  row_layout?: RowLayout
  /** The Board layout's notes preview (board-polish D4). */
  card_notes?: boolean
}

/** Create a view, last in sidebar order. Pinned unless told otherwise (the Filter view's "Save view"). */
export async function createView(input: NewView): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error(t('A view needs a name'))
  const kind = input.kind ?? 'list'
  const query = kind === 'dashboard' ? '' : (input.query ?? '').trim()
  checkQuery(query, kind)
  const id = uuid()
  const now = Date.now()
  let position = now
  for (const v of await liveViews()) if (v.position >= position) position = v.position + 1
  await mutate('view', id, {
    name, query, kind,
    group_by: input.group_by ?? VIEW_DEFAULTS.group_by,
    sort_by: input.sort_by ?? VIEW_DEFAULTS.sort_by,
    sort_dir: input.sort_dir ?? VIEW_DEFAULTS.sort_dir,
    pinned: input.pinned ?? true,
    position,
    color: input.color ?? VIEW_DEFAULTS.color,
    panels: [],
    // Display options only when they differ from the defaults, so a plain view's ops stay as before.
    ...(input.layout && input.layout !== 'list' ? { layout: input.layout } : {}),
    ...(input.show_completed ? { show_completed: true } : {}),
    ...(input.hidden_props?.length ? { hidden_props: input.hidden_props } : {}),
    ...(input.row_layout ? { row_layout: input.row_layout } : {}),
    ...(input.card_notes ? { card_notes: true } : {}),
    ...(await workspaceFields()),
    created_at: now,
    deleted_at: null,
  })
  return id
}

export type ViewPatch = Partial<Pick<View, 'name' | 'query' | 'group_by' | 'sort_by' | 'sort_dir' | 'color' | 'position' | 'layout' | 'show_completed' | 'hidden_props' | 'row_layout' | 'icon' | 'card_notes'>>

/** Edit a view: one op per changed field. The kind is fixed at creation; panels go through setPanels. */
export async function updateView(id: string, patch: ViewPatch): Promise<void> {
  const view = await db.views.get(id)
  if (!view || view.deleted_at) throw new Error('View not found')
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const cur = (view as unknown as Record<string, unknown>)[k]
    // A list compares by its items: the same hidden properties are no change.
    if (Array.isArray(v) && Array.isArray(cur) ? v.join() !== cur.join() : cur !== v) next[k] = v
  }
  if (typeof next.name === 'string') {
    next.name = next.name.trim()
    if (!next.name) throw new Error(t('A view needs a name'))
  }
  if (typeof next.query === 'string') {
    next.query = next.query.trim()
    checkQuery(next.query as string, viewOptions(view).kind)
  }
  if (Object.keys(next).length === 0) return
  await mutate('view', id, next)
}

/** Tombstone a view. Dashboards that show it keep the id and render a placeholder. */
export async function deleteView(id: string): Promise<void> {
  await mutate('view', id, { deleted_at: Date.now() })
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const view = await db.views.get(id)
  if (!view || view.deleted_at || view.pinned === pinned) return
  await mutate('view', id, { pinned })
}

/**
 * Move a view one step up (-1) or down (+1) among the saved views, as the sidebar's
 * Filters group and the overview list them (sidebar-favourites: every saved filter is
 * listed, pinned or not). Swaps two positions in one batch.
 */
export async function reorderView(id: string, delta: -1 | 1): Promise<void> {
  const all = await liveViews()
  const self = all.find((v) => v.id === id)
  if (!self) return
  const list = all
  const i = list.findIndex((v) => v.id === id)
  const j = i + delta
  if (j < 0 || j >= list.length) return
  const a = list[i], b = list[j]
  // Equal positions (two views created in the same millisecond on two devices) would not swap.
  const pa = a.position === b.position ? b.position + delta : b.position
  await mutateMany([
    { entity: 'view', entityId: a.id, patch: { position: pa } },
    { entity: 'view', entityId: b.id, patch: { position: a.position } },
  ])
}

/**
 * Replace a dashboard's panel list (a whole-array register, like task.labels). Refuses
 * more than six panels, the dashboard itself, other dashboards (no nesting) and views
 * that are missing or deleted; duplicates are dropped. Read and write share one
 * transaction so sequential edits on this device never lose a panel.
 */
export async function setPanels(dashboardId: string, panels: string[]): Promise<void> {
  await getDeviceId()
  await db.transaction('rw', mutationTables(), async () => {
    const dash = await db.views.get(dashboardId)
    if (!dash || dash.deleted_at) throw new Error('Dashboard not found')
    if (!isDashboard(dash)) throw new Error('Only dashboards have panels')
    const unique = [...new Set(panels)]
    if (unique.length > MAX_PANELS) throw new Error(`A dashboard shows at most ${MAX_PANELS} views`)
    const added = unique.filter((id) => !dash.panels.includes(id))
    for (const id of added) {
      if (id === dashboardId) throw new Error('A dashboard cannot contain itself')
      const v = await db.views.get(id)
      if (!v || v.deleted_at) throw new Error('View not found')
      if (isDashboard(v)) throw new Error('A dashboard cannot contain another dashboard')
    }
    if (unique.length === dash.panels.length && unique.every((id, i) => id === dash.panels[i])) return
    await mutate('view', dashboardId, { panels: unique })
  })
}

/** Add a panel at the end. */
export async function addPanel(dashboardId: string, viewId: string): Promise<void> {
  const dash = await db.views.get(dashboardId)
  if (!dash) throw new Error('Dashboard not found')
  if (dash.panels.includes(viewId)) return
  await setPanels(dashboardId, [...dash.panels, viewId])
}

/** Remove a panel (also works for a panel whose view was deleted). */
export async function removePanel(dashboardId: string, viewId: string): Promise<void> {
  const dash = await db.views.get(dashboardId)
  if (!dash) return
  await setPanels(dashboardId, dash.panels.filter((id) => id !== viewId))
}

/** Move a panel one step left (-1) or right (+1). */
export async function movePanel(dashboardId: string, viewId: string, delta: -1 | 1): Promise<void> {
  const dash = await db.views.get(dashboardId)
  if (!dash) return
  const list = [...dash.panels]
  const i = list.indexOf(viewId)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  await setPanels(dashboardId, list)
}

// ---- on-drop rules and board templates (OpenSpec change rule-boards) ----

/**
 * Set or clear a list view's on-drop rule: one op, the whole value (D2). A rule
 * with nothing in it is stored as null; dashboards carry no rule.
 */
export async function setOnDrop(viewId: string, rule: OnDropRule | null): Promise<void> {
  const view = await db.views.get(viewId)
  if (!view || view.deleted_at) throw new Error('View not found')
  if (isDashboard(view)) throw new Error('Only saved filters have a rule')
  const next = rule && Object.keys(rule).length ? rule : null
  if (JSON.stringify(view.on_drop ?? null) === JSON.stringify(next)) return
  await mutate('view', viewId, { on_drop: next })
}

/**
 * Create a board from a template (D8): its saved filters, unpinned and each with
 * its rule, and one pinned board of them in order, after the last view, in one
 * batch. Like a new saved filter (sidebar-favourites), the board is a favourite by
 * its pinned flag and lists after the ordered entries until the user moves it.
 * Returns the board's id.
 */
export async function createBoardFromTemplate(template: BoardTemplate, name: string): Promise<string> {
  const boardName = name.trim()
  if (!boardName) throw new Error(t('A view needs a name'))
  for (const c of template.columns) checkQuery(c.query, 'list')
  const now = Date.now()
  let position = now
  for (const v of await liveViews()) if (v.position >= position) position = v.position + 1
  const base = { group_by: VIEW_DEFAULTS.group_by, sort_by: VIEW_DEFAULTS.sort_by, sort_dir: VIEW_DEFAULTS.sort_dir, created_at: now, deleted_at: null }
  const changes: Change[] = []
  const panels: string[] = []
  for (const c of template.columns) {
    const id = uuid()
    panels.push(id)
    changes.push({ entity: 'view', entityId: id, patch: { ...base, name: t(c.name), query: c.query, kind: 'list', pinned: false, position: position++, color: c.color, panels: [], on_drop: knownRule(c.on_drop) } })
  }
  const board = uuid()
  changes.push({ entity: 'view', entityId: board, patch: { ...base, name: boardName, query: '', kind: 'dashboard', pinned: true, position, color: VIEW_DEFAULTS.color, panels } })
  await mutateMany(changes)
  return board
}

// ---- evaluation ----

export interface ViewContext extends FilterContext {
  /** Every task to evaluate against (deleted ones are ignored by the compiler). */
  tasks: readonly Task[]
}

export interface ViewGroup {
  key: string
  heading: string
  tasks: Task[]
}

export type ViewResult =
  | { ok: true; tasks: Task[]; groups: ViewGroup[]; warnings: string[] }
  | { ok: false; error: string }

interface Compiled {
  ok: true
  test: (task: Task) => boolean
  warnings: string[]
  /** The query names a workspace: the view looks at every workspace's tasks (group-mentions D6). */
  every: boolean
}

/** The context a compiled view lists from: every workspace's data when it names a workspace. */
export function viewScope<C extends ViewContext>(c: Pick<Compiled, 'every'>, ctx: C): C {
  return c.every && ctx.everyWorkspace ? { ...ctx, ...ctx.everyWorkspace } : ctx
}

/**
 * Parse and compile a stored query; a query that no longer parses yields its error.
 * `withCompleted` (the view's "Completed tasks: Show", views-and-display D4) lists
 * completed matches too: the query is read as `(query) & (open | completed)`, so a
 * query that names a state itself is unchanged.
 */
export function compileView(view: Pick<View, 'query'>, given: FilterContext, withCompleted = false): Compiled | { ok: false; error: string } {
  let ast: Node | null
  try {
    ast = parse(view.query)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if (!ast) return { ok: false, error: t('This view has no query') }
  if (withCompleted && !mentionsState(ast)) ast = withCompletedTasks(ast)
  const ctx = filterScope(ast, given)
  // Like the Filter view and the other cross-project views, tasks of archived projects stay out.
  const archived = new Set(ctx.projects.filter((p) => p.archived && !p.deleted_at).map((p) => p.id))
  let compiled: ReturnType<typeof compile>
  try {
    compiled = compile(ast, ctx)
  } catch (e) {
    // A field term its type cannot answer (custom-fields).
    return { ok: false, error: (e as Error).message }
  }
  const { test, warnings } = compiled
  return { ok: true, warnings, every: !!given.everyWorkspace && namesWorkspace(ast), test: (task) => !(task.project_id && archived.has(task.project_id)) && test(task) }
}

const TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

function byTitle(a: Task, b: Task): number {
  return TITLE_COLLATOR.compare(a.title, b.title)
}

export interface FieldSortContext {
  projects: readonly Project[]
  fields?: readonly FieldDef[]
}

interface SortableFieldValue {
  rank: number
  value: number | string
}

function isFieldDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function fieldValueFor(task: Task, selectedName: string, fieldsOf: (projectId: string | null | undefined) => FieldDef[]): SortableFieldValue | null {
  const def = fieldsOf(task.project_id).find((field) => nameKey(field.name) === selectedName)
  if (!def) return null
  const value = task.fields?.[def.id]
  switch (def.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { rank: 0, value } : null
    case 'date':
      return isFieldDate(value) ? { rank: 1, value } : null
    case 'text':
      return typeof value === 'string' && value.length > 0 ? { rank: 2, value } : null
    default:
      return null
  }
}

/**
 * Comparator for one view's sort. Descending reverses field values, except that undated
 * tasks always come last under a due-date sort. Priority 1 is highest: descending
 * puts it first. Ties fall back to due, priority, position and id.
 */
export function compareTasks(sortBy: SortBy, dir: SortDir, context?: FieldSortContext): (a: Task, b: Task) => number {
  const sign = dir === 'desc' ? -1 : 1
  const fallback = (a: Task, b: Task) =>
    compareDue(a.due, b.due) || a.priority - b.priority || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const selectedId = fieldSortId(sortBy)
  if (selectedId) {
    const selected = context?.fields?.find((field) => field.id === selectedId && !field.deleted_at)
    if (!selected || !context || (selected.type !== 'number' && selected.type !== 'date')) return compareTasks('due', 'asc')
    const selectedName = nameKey(selected.name)
    const fieldsOf = applicableFieldsLookup(context.projects, context.fields ?? [])
    const values = new WeakMap<Task, SortableFieldValue | null>()
    const valueOf = (task: Task) => {
      if (!values.has(task)) values.set(task, fieldValueFor(task, selectedName, fieldsOf))
      return values.get(task)!
    }
    return (a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (!av || !bv) return (av ? -1 : bv ? 1 : 0) || fallback(a, b)
      if (av.rank !== bv.rank) return av.rank - bv.rank
      const order = typeof av.value === 'number' && typeof bv.value === 'number'
        ? av.value - bv.value
        : TITLE_COLLATOR.compare(String(av.value), String(bv.value))
      return sign * order || fallback(a, b)
    }
  }
  switch (sortBy) {
    case 'due':
      return (a, b) => {
        if (!a.due || !b.due) return compareDue(a.due, b.due) || fallback(a, b)
        return sign * compareDue(a.due, b.due) || fallback(a, b)
      }
    case 'priority':
      return (a, b) => sign * (b.priority - a.priority) || fallback(a, b)
    case 'position':
      return (a, b) => sign * (a.position - b.position) || fallback(a, b)
    case 'created':
      return (a, b) => sign * (a.created_at - b.created_at) || fallback(a, b)
    case 'title':
      return (a, b) => sign * byTitle(a, b) || fallback(a, b)
    case 'deadline':
      return (a, b) => {
        if (!a.deadline || !b.deadline) return (a.deadline ? -1 : b.deadline ? 1 : 0) || fallback(a, b)
        return sign * (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0) || fallback(a, b)
      }
    default:
      return compareTasks('due', 'asc')
  }
}
/**
 * A saved view's comparator (OpenSpec change view-manual-order): its sort, where
 * Manual order is the view's own stored order, then the other tasks by position;
 * descending reverses it.
 */
export function viewComparator(view: Pick<View, 'manual_order'>, sortBy: SortBy, dir: SortDir, context?: FieldSortContext): (a: Task, b: Task) => number {
  if (sortBy !== 'position') return compareTasks(sortBy, dir, context)
  const asc = compareManual(orderRank(view.manual_order))
  return dir === 'desc' ? (a, b) => asc(b, a) : asc
}

/**
 * Split sorted tasks into headed groups; headings come in a fixed, meaningful order.
 * `once` (a project or label page, list-display-options D3): a task with several
 * labels is listed once, under the first of them in label order, since a list page
 * selects, drags and opens a task by its id.
 */
export function groupTasks(tasks: Task[], groupBy: GroupBy, ctx: Pick<FilterContext, 'today' | 'labels' | 'projects'>, once = false): ViewGroup[] {
  const buckets = new Map<string, Task[]>()
  const put = (key: string, task: Task) => {
    const list = buckets.get(key)
    if (list) list.push(task)
    else buckets.set(key, [task])
  }
  const emit = (order: [string, string][]) => order.filter(([k]) => buckets.has(k)).map(([key, heading]) => ({ key, heading, tasks: buckets.get(key)! }))

  switch (groupBy) {
    case 'none':
      return tasks.length ? [{ key: 'all', heading: '', tasks }] : []
    case 'priority':
      for (const tk of tasks) put(`p${tk.priority}`, tk)
      return emit([1, 2, 3, 4].map((p) => [`p${p}`, t('Priority {p}', { p })]))
    case 'due': {
      const today = ctx.today
      const tomorrow = addDaysISO(today, 1)
      const dates = new Set<string>()
      for (const item of tasks) {
        // A zoned due groups under its date in the viewer's zone (absolute-datetimes).
        const date = localDate(item.due)
        if (!date) put('none', item)
        else if (date < today) put('overdue', item)
        else if (date === today) put('today', item)
        else if (date === tomorrow) put('tomorrow', item)
        else {
          put(date, item)
          dates.add(date)
        }
      }
      return emit([
        ['overdue', t('Earlier')], ['today', t('Today')], ['tomorrow', t('Tomorrow')],
        ...[...dates].sort().map((d): [string, string] => [d, formatDateHeading(d, today)]),
        ['none', t('No date')],
      ])
    }
    case 'label': {
      // A task with several labels appears under each of them.
      const labels = activeLabels([...ctx.labels])
      const known = new Set(labels.map((l) => l.id))
      for (const tVar of tasks) {
        const own = [...new Set(tVar.labels.filter((id) => known.has(id)))]
        if (own.length === 0) put('none', tVar)
        else if (once) put(labels.find((l) => own.includes(l.id))!.id, tVar)
        else for (const id of own) put(id, tVar)
      }
      return emit([...labels.map((l): [string, string] => [l.id, l.name]), ['none', t('No label')]])
    }
    case 'project': {
      const projects = ctx.projects.filter((p) => !p.deleted_at) as Project[]
      const byId = new Map(projects.map((p) => [p.id, p]))
      for (const tVar of tasks) put(tVar.project_id && byId.has(tVar.project_id) ? tVar.project_id : tVar.project_id ? 'unknown' : 'inbox', tVar)
      const path = (id: string) => [...ancestors(id, byId).reverse(), byId.get(id)!].map((p) => p.name).join(' › ')
      // Inbox first, then projects in sidebar (tree) order.
      const order: [string, string][] = [['inbox', t('Inbox')]]
      for (const n of flattenTree(buildProjectTree(projects).roots)) order.push([n.id, path(n.id)])
      for (const p of projects) if (!order.some(([k]) => k === p.id)) order.push([p.id, path(p.id)])
      order.push(['unknown', t('Other')])
      return emit(order)
    }
  }
}

/** Evaluate one list view: its query through the filter compiler, then its sort and grouping. */
export function runView(view: View, ctx: ViewContext): ViewResult {
  const c = compileView(view, ctx, displayOptions(view).showCompleted)
  if (!c.ok) return c
  const { groupBy, sortBy, sortDir } = viewOptions(view)
  const scoped = viewScope(c, ctx)
  const tasks = scoped.tasks.filter(c.test).sort(viewComparator(view, sortBy, sortDir, scoped))
  return { ok: true, tasks, groups: groupTasks(tasks, groupBy, scoped), warnings: c.warnings }
}

export type ViewSummary =
  | { ok: true; count: number; tasks: Task[]; warnings: string[] }
  | { ok: false; error: string }

/**
 * Evaluate several list views in one pass over the tasks (design D5): compile every
 * predicate once, then test each task against all of them. `count` is the number of
 * open matches (what the sidebar and dashboard panels show); `tasks` are the first
 * `limit` matches in the view's own sort, flattened in group order like the view.
 */
export function evaluateViews(views: View[], ctx: ViewContext, limit = PANEL_TASKS): Map<string, ViewSummary> {
  const out = new Map<string, ViewSummary>()
  const live: { view: View; test: (task: Task) => boolean; warnings: string[]; matches: Task[]; every: boolean }[] = []
  for (const view of views) {
    if (view.deleted_at || isDashboard(view)) continue
    const c = compileView(view, ctx)
    if (!c.ok) out.set(view.id, c)
    else live.push({ view, test: c.test, warnings: c.warnings, matches: [], every: c.every })
  }
  // One pass over the current workspace's tasks, and one over every workspace's for views that name a workspace.
  const here = live.filter((l) => !l.every)
  const every = live.filter((l) => l.every)
  for (const tk of here.length ? ctx.tasks : []) for (const l of here) if (l.test(tk)) l.matches.push(tk)
  for (const tk of every.length ? ctx.everyWorkspace!.tasks : []) for (const l of every) if (l.test(tk)) l.matches.push(tk)
  for (const l of live) {
    const { groupBy, sortBy, sortDir } = viewOptions(l.view)
    const scoped = viewScope(l, ctx)
    const sorted = l.matches.sort(viewComparator(l.view, sortBy, sortDir, scoped))
    const firstN: Task[] = []
    if (limit > 0) {
      // Grouping by label can list a task twice; a panel shows each task once.
      const seen = new Set<string>()
      for (const g of groupTasks(sorted, groupBy, scoped)) {
        for (const item of g.tasks) {
          if (firstN.length >= limit) break
          if (!seen.has(item.id)) {
            seen.add(item.id)
            firstN.push(item)
          }
        }
      }
    }
    out.set(l.view.id, { ok: true, count: sorted.filter((tVar) => tVar.completed_at === null).length, tasks: firstN, warnings: l.warnings })
  }
  return out
}

export type PanelState =
  | { kind: 'removed'; id: string }
  | { kind: 'view'; id: string; view: View; summary: ViewSummary }

/** A dashboard's panels in order; a missing, deleted or nested-dashboard panel becomes a placeholder. */
export function dashboardPanels(dashboard: View, views: View[], summaries: Map<string, ViewSummary>): PanelState[] {
  const byId = new Map(views.map((v) => [v.id, v]))
  return dashboard.panels.slice(0, MAX_PANELS).map((id) => {
    const view = byId.get(id)
    const summary = summaries.get(id)
    if (!view || view.deleted_at || isDashboard(view) || !summary) return { kind: 'removed', id }
    return { kind: 'view', id, view, summary }
  })
}

// ---- start view (per device, never synced) ----

export const START_VIEW_KEY = 'startView'

/**
 * Built-in views that can be a start view, plus `view:<id>` for a saved view and
 * `display:<path>` for a display route with its options (OpenSpec `display-mode`).
 */
export const BUILTIN_START_VIEWS = ['inbox', 'today', 'upcoming', 'completed', 'filter', 'next', 'waiting', 'loop'] as const
export type BuiltinStartView = (typeof BUILTIN_START_VIEWS)[number]
export type StartView = BuiltinStartView | `view:${string}` | `display:${string}`

/** The display start views offered in Settings; projects and saved views are pinned from the display itself. */
export const DISPLAY_START_VIEWS = [
  { value: 'display:/display/today', label: msg('Display: Today') },
  { value: 'display:/display/upcoming', label: msg('Display: Upcoming') },
] as const satisfies readonly { value: StartView; label: string }[]

export async function getStartView(): Promise<StartView> {
  return getMeta<StartView>(START_VIEW_KEY, 'inbox')
}

export async function setStartView(v: StartView): Promise<void> {
  await setMeta(START_VIEW_KEY, v)
}

export type ResolvedStart =
  | { kind: 'builtin'; view: BuiltinStartView; removed: boolean }
  | { kind: 'saved'; id: string }
  /** A display route (`/display/...?...`), to be parsed by the router. */
  | { kind: 'display'; path: string }

/** The project or saved view a display start path names, or null for Today and Upcoming. */
function displayEntity(path: string): { kind: 'project' | 'view'; id: string } | null | 'invalid' {
  const [p] = path.split('?')
  const parts = p.split('/').filter(Boolean)
  if (parts[0] !== 'display') return 'invalid'
  if (parts.length === 1 || ((parts[1] === 'today' || parts[1] === 'upcoming') && parts.length === 2)) return null
  if ((parts[1] === 'project' || parts[1] === 'view') && parts[2] && parts.length === 3) {
    try {
      return { kind: parts[1], id: decodeURIComponent(parts[2]) }
    } catch {
      return 'invalid'
    }
  }
  return 'invalid'
}

/**
 * The start view to open on launch. A saved view, or the project or view of a
 * display, that is missing or deleted (for example deleted on another device)
 * falls back to the Inbox with `removed: true`, and the preference is reset so
 * the notice is shown once.
 */
export async function resolveStartView(): Promise<ResolvedStart> {
  const v = await getStartView()
  const removed = async (): Promise<ResolvedStart> => {
    await setStartView('inbox')
    return { kind: 'builtin', view: 'inbox', removed: true }
  }
  if (typeof v === 'string' && v.startsWith('view:')) {
    const id = v.slice('view:'.length)
    const view = await db.views.get(id)
    if (view && !view.deleted_at) return { kind: 'saved', id }
    return removed()
  }
  if (typeof v === 'string' && v.startsWith('display:')) {
    const path = v.slice('display:'.length)
    const entity = displayEntity(path)
    if (entity === 'invalid') return removed()
    if (entity) {
      const row = entity.kind === 'project' ? await db.projects.get(entity.id) : await db.views.get(entity.id)
      if (!row || row.deleted_at) return removed()
    }
    return { kind: 'display', path }
  }
  return { kind: 'builtin', view: (BUILTIN_START_VIEWS as readonly string[]).includes(v) ? (v as BuiltinStartView) : 'inbox', removed: false }
}

/** This device's start view (local meta, never synced). */
export function useStartView(): StartView {
  return useLiveQuery(() => getStartView(), [], 'inbox' as StartView)
}
