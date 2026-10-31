// Filter evaluation: compile a parsed query once into a predicate over local
// tasks. Pure; names are resolved against the labels and projects passed in on
// every compile, so renames are picked up and deleted names degrade to a warning
// plus an empty match instead of an error (design D3).
import { nameKey } from '../fieldNames'
import { blockedMap } from '../dependencies'
import { currentDateTime, currentDayStart, localDueOf } from '../dates'
import { descendants } from '../tree'
import { applicableFieldsLookup } from '../fieldTree'
import type { FieldDef, FieldValue, Label, Project, Section, Task } from '../types'
import { availability, type FlowState } from '../flow'
import { originMatches, originOf } from '../taskOrigin'
import { fieldValueText, FilterSyntaxError, parse, resolveRange, shiftISO, type Cmp, type DateRange, type Node } from './parse'
import { t } from '../i18n'
import { dayPartOf } from '../dayParts'
import { energyOf } from '../energy'

export interface FilterContext {
  /** The viewer's local calendar date, YYYY-MM-DD. */
  today: string
  labels: readonly Label[]
  projects: readonly Project[]
  /** Every live task, for `blocked` and `unblocked` (task-dependencies D6). */
  tasks?: readonly Task[]
  /** Every live section, for the sequences of `available` (project-flow-modes). */
  sections?: readonly Section[]
  /**
   * First day of the week for `this week` and friends, 0 = Sunday. Defaults to the
   * user's date-time preference snapshot (completed-date-filters D2).
   */
  weekStart?: number
  /**
   * Custom field definitions (OpenSpec custom-fields) for `name cmp value` and
   * `no name`; names resolve against the live ones of every project, ignoring case.
   */
  fields?: readonly FieldDef[]
  /**
   * Every member's tracked minutes per task, a running entry to the current minute
   * (time-tracking D4), for `tracked` and `tracked cmp duration`; none tracked without it.
   */
  tracked?: ReadonlyMap<string, number>
  /**
   * The cached workspaces and the workspace a task belongs to (OpenSpec change
   * group-mentions, D6), for `workspace: name`; without them the term matches nothing.
   */
  workspaces?: readonly { id: string; name: string }[]
  workspaceOf?: (task: Task) => string
  /**
   * Every workspace's tasks, projects and labels. A query that names a workspace
   * is evaluated over these instead of the current workspace's (filterScope).
   */
  everyWorkspace?: { tasks: readonly Task[]; projects: readonly Project[]; labels: readonly Label[] }
}

export interface CompiledFilter {
  test: (task: Task) => boolean
  /** One message per unknown label or project name, in query order, without duplicates. */
  warnings: string[]
}

export type FilterResult =
  | { ok: true; empty: boolean; tasks: Task[]; warnings: string[] }
  | { ok: false; error: string; position: number; offset: number }

type Pred = (task: Task) => boolean

const NEVER: Pred = () => false

/**
 * True when the query mentions `completed` or `open`, or compares the completion
 * date (completed-date-filters D3); otherwise only open tasks match (design D5).
 */
/**
 * `(query) & (open | completed)`, the reading of a query with completed tasks shown
 * (views-and-display D4), built on the parsed query rather than parsed again from
 * text, so a query at the nesting or length limit (filter-limits) still works.
 */
export function withCompletedTasks(ast: Node): Node {
  return { kind: 'and', items: [ast, parse('open | completed')!] }
}

export function mentionsState(n: Node): boolean {
  switch (n.kind) {
    case 'or':
    case 'and':
      return n.items.some(mentionsState)
    case 'not':
      return mentionsState(n.item)
    case 'keyword':
      return n.keyword === 'completed' || n.keyword === 'open'
    case 'date':
      return n.field === 'completed'
    default:
      return false
  }
}

/** True when the query has a `workspace:` term anywhere (group-mentions D6). */
export function namesWorkspace(n: Node): boolean {
  switch (n.kind) {
    case 'or':
    case 'and':
      return n.items.some(namesWorkspace)
    case 'not':
      return namesWorkspace(n.item)
    default:
      return n.kind === 'workspace'
  }
}

/**
 * The context a query is evaluated in: every workspace's tasks, projects and
 * labels when it names a workspace and the caller supplied them, else `ctx`.
 * Callers that list results iterate the returned `tasks`.
 */
export function filterScope<C extends FilterContext>(ast: Node, ctx: C): C {
  if (!ctx.everyWorkspace || !namesWorkspace(ast)) return ctx
  return { ...ctx, ...ctx.everyWorkspace }
}

/** A day against a range of days (completed-date-filters D1); a one-day range is a plain comparison. */
function compareISO(d: string, op: Cmp, r: DateRange): boolean {
  switch (op) {
    case '<': return d < r.start
    case '<=': return d <= r.end
    case '=': return d >= r.start && d <= r.end
    case '>=': return d >= r.start
    case '>': return d > r.end
  }
}

/** Local midnight of a floating date as Unix milliseconds. */
/** The first instant of a logical day (day-boundary D2): its date at the user's day start, local midnight by default. */
function startOfDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const dayStart = currentDayStart()
  return new Date(y, m - 1, d, Math.floor(dayStart / 60), dayStart % 60).getTime()
}

/**
 * `created <op> date` and `completed <op> date` as a millisecond range check on an
 * instant in the viewer's zone; a null instant never matches.
 */
function instantPred(at: (task: Task) => number | null, op: Cmp, r: DateRange): Pred {
  const start = startOfDay(r.start)
  const next = startOfDay(shiftISO(r.end, 1))
  const test = (ms: number): boolean => {
    switch (op) {
      case '<': return ms < start
      case '<=': return ms < next
      case '=': return ms >= start && ms < next
      case '>=': return ms >= start
      case '>': return ms >= next
    }
  }
  return (tk) => {
    const ms = at(tk)
    return ms !== null && ms !== undefined && test(ms)
  }
}


function isEmptyValue(v: FieldValue | undefined): boolean {
  return v === null || v === undefined || v === ''
}

/**
 * The predicate of one field term against one definition (custom-fields D5):
 * numbers numerically, dates with the date grammar, text, link and choice with
 * `=` only ignoring case, checkboxes with `= true` / `= false`. A term the type
 * cannot answer is a FilterSyntaxError at the operator. Only tasks of projects
 * the definition applies to (its own and its sub-projects, inherited-custom-fields)
 * are considered, the same values the panel shows.
 */
function fieldPred(def: FieldDef, n: Extract<Node, { kind: 'field' }>, today: string, weekStart: number, applies: (task: Task, def: FieldDef) => boolean): Pred {
  const at = n.opPos
  const value = (task: Task): FieldValue | undefined => (applies(task, def) ? task.fields?.[def.id] : undefined)
  const label = `"${n.name}"`
  switch (def.type) {
    case 'number': {
      if (n.value.type !== 'number') throw new FilterSyntaxError(t('Field {name} holds numbers: compare it with a number at position {pos}', { name: label, pos: at + 1 }), at, ['number'])
      const want = n.value.value
      const op = n.op
      return (tk) => {
        const v = value(tk)
        if (typeof v !== 'number') return false
        switch (op) {
          case '<': return v < want
          case '<=': return v <= want
          case '=': return v === want
          case '>=': return v >= want
          case '>': return v > want
        }
      }
    }
    case 'date': {
      if (n.value.type !== 'date') throw new FilterSyntaxError(t('Field {name} holds dates: compare it with a date at position {pos}', { name: label, pos: at + 1 }), at, ['date'])
      const range = resolveRange(n.value.date, today, weekStart)
      const op = n.op
      return (item) => {
        const v = value(item)
        return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && compareISO(v, op, range)
      }
    }
    case 'checkbox': {
      if (n.op !== '=' || n.value.type !== 'bool') throw new FilterSyntaxError(t('Checkbox fields support "= true" or "= false" only, at position {pos}', { pos: at + 1 }), at, ['"= true"', '"= false"'])
      const want = n.value.value
      // An unset checkbox reads as unchecked.
      return (task) => {
        const v = value(task)
        return applies(task, def) && (want ? v === true : v !== true)
      }
    }
    default: {
      if (n.op !== '=') throw new FilterSyntaxError(t('{type, select, link {Link} choice {Choice} other {Text}} fields support "=" only, at position {pos}', { type: def.type, pos: at + 1 }), at, ['"="'])
      // A bare word that reads as a date (`client = today`) still compares as its text.
      const want = fieldValueText(n.value).toLocaleLowerCase()
      return (task) => {
        const v = value(task)
        return typeof v === 'string' && v.toLocaleLowerCase() === want
      }
    }
  }
}

/** Compile an AST into a predicate. Deleted tasks never match; open-only unless the query mentions state. */
export function compile(ast: Node, given: FilterContext): CompiledFilter {
  const ctx = filterScope(ast, given)
  const warnings: string[] = []
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg)
  }

  const liveLabels = ctx.labels.filter((l) => !l.deleted_at)
  const liveProjects = ctx.projects.filter((p) => !p.deleted_at)
  const labelsByName = new Map<string, string[]>()
  for (const l of liveLabels) labelsByName.set(nameKey(l.name), [...(labelsByName.get(nameKey(l.name)) ?? []), l.id])
  const projectsByName = new Map<string, string[]>()
  for (const p of liveProjects) projectsByName.set(nameKey(p.name), [...(projectsByName.get(nameKey(p.name)) ?? []), p.id])
  const fieldsByName = new Map<string, FieldDef[]>()
  for (const d of ctx.fields ?? []) {
    if (!d.deleted_at) fieldsByName.set(nameKey(d.name), [...(fieldsByName.get(nameKey(d.name)) ?? []), d])
  }
  // Which definitions apply to a task's project, inherited ones included (inherited-custom-fields D2).
  const fieldsOf = applicableFieldsLookup(liveProjects, ctx.fields ?? [])
  const appliesTo = new Map<string, Set<string>>()
  const applies = (task: Task, def: FieldDef): boolean => {
    if (!task.project_id) return false
    let ids = appliesTo.get(task.project_id)
    if (!ids) appliesTo.set(task.project_id, (ids = new Set(fieldsOf(task.project_id).map((d) => d.id))))
    return ids.has(def.id)
  }
  const today = ctx.today
  const weekStart = ctx.weekStart ?? currentDateTime().weekStart
  const tomorrow = shiftISO(today, 1)
  // Open blockers per task, built once when the query asks (task-dependencies D6).
  let blocked: Map<string, number> | null = null
  const blockedSet = () => {
    if (!blocked) {
      if (!ctx.tasks) warn(t('Blocked tasks cannot be told apart here'))
      blocked = blockedMap(ctx.tasks ?? [])
    }
    return blocked
  }
  // The flow state (project-flow-modes), built once when the query asks for `available`.
  let flow: FlowState | null = null
  const flowState = () => {
    if (!flow) {
      if (!ctx.tasks) warn(t('Blocked tasks cannot be told apart here'))
      flow = availability({ tasks: ctx.tasks ?? [], projects: ctx.projects, sections: ctx.sections ?? [], today })
    }
    return flow
  }

  const build = (n: Node): Pred => {
    switch (n.kind) {
      case 'or': {
        const ps = n.items.map(build)
        return (task) => ps.some((p) => p(task))
      }
      case 'and': {
        const ps = n.items.map(build)
        return (tk) => ps.every((p) => p(tk))
      }
      case 'not': {
        const p = build(n.item)
        return (task) => !p(task)
      }
      case 'label': {
        const ids = labelsByName.get(nameKey(n.name))
        if (!ids) {
          warn(t('No label named "{name}"', { name: n.name }))
          return NEVER
        }
        // Several labels may share a name after concurrent creation: any of them matches.
        if (ids.length === 1) {
          const id = ids[0]
          return (task) => task.labels.includes(id)
        }
        const set = new Set(ids)
        return (task) => task.labels.some((id) => set.has(id))
      }
      case 'project': {
        const ids = projectsByName.get(nameKey(n.name))
        if (!ids) {
          warn(t('No project named "{name}"', { name: n.name }))
          return NEVER
        }
        const set = new Set(ids)
        if (n.descendants) for (const id of ids) for (const d of descendants(id, liveProjects as Project[])) set.add(d)
        return (task) => task.project_id !== null && set.has(task.project_id)
      }
      case 'priority': {
        const v = n.value
        return (task) => task.priority === v
      }
      case 'date': {
        const date = resolveRange(n.date, today, weekStart)
        if (n.field === 'created') return instantPred((task) => task.created_at, n.op, date)
        if (n.field === 'completed') return instantPred((task) => task.completed_at, n.op, date)
        const op = n.op
        // A task without a deadline never matches a `deadline` comparison (deadlines D4).
        if (n.field === 'deadline') return (task) => !!task.deadline && compareISO(task.deadline, op, date)
        // Only a start date compares; null and Someday never match (someday-and-evening).
        if (n.field === 'start') return (task) => !!task.start && task.start !== 'someday' && compareISO(task.start, op, date)
        // A task without a due date never matches a `due` comparison.
        return (task) => task.due !== null && compareISO(localDueOf(task.due).date, op, date)
      }
      case 'field': {
        const defs = fieldsByName.get(nameKey(n.name))
        if (!defs) {
          warn(t('No field named "{name}"', { name: n.name }))
          return NEVER
        }
        // Several projects may define the name, with different types: the term
        // uses every definition it can answer, and fails only when none can.
        const ps: Pred[] = []
        let first: unknown = null
        for (const d of defs) {
          try {
            ps.push(fieldPred(d, n, today, weekStart, applies))
          } catch (e) {
            first ??= e
          }
        }
        if (ps.length === 0) throw first
        return (task) => ps.some((p) => p(task))
      }
      case 'nofield': {
        const defs = fieldsByName.get(nameKey(n.name))
        if (!defs) {
          warn(t('No field named "{name}"', { name: n.name }))
          return NEVER
        }
        return (task) => defs.some((d) => applies(task, d) && isEmptyValue(task.fields?.[d.id]))
      }
      case 'search': {
        const needle = n.text.toLocaleLowerCase()
        return (task) => task.title.toLocaleLowerCase().includes(needle) || task.description.toLocaleLowerCase().includes(needle)
      }
      // The note is the task's description, its Markdown projection; on an encrypted
      // account the decrypted local copy (notes-overview D5, D8). Never the title.
      case 'notes': {
        const needle = n.text.toLocaleLowerCase()
        return (task) => (task.description ?? '').toLocaleLowerCase().includes(needle)
      }
      case 'origin':
        return (task) => originMatches(originOf(task), n.value)
      // A value this client does not know reads as none (task-energy D5).
      case 'energy': {
        const want = n.value
        return (task) => energyOf(task) === want
      }
      case 'workspace': {
        const ids = new Set((ctx.workspaces ?? []).filter((w) => nameKey(w.name) === nameKey(n.name)).map((w) => w.id))
        const of = ctx.workspaceOf
        if (ids.size === 0 || !of) {
          warn(t('No workspace named "{name}"', { name: n.name }))
          return NEVER
        }
        return (task) => ids.has(of(task))
      }
      case 'tracked': {
        const minutes = n.minutes
        const op = n.op
        return (task) => {
          const m = ctx.tracked?.get(task.id) ?? 0
          return op === '<' ? m < minutes : op === '<=' ? m <= minutes : op === '=' ? m === minutes : op === '>=' ? m >= minutes : m > minutes
        }
      }
      case 'keyword':
        switch (n.keyword) {
          case 'overdue': return (task) => task.due !== null && localDueOf(task.due).date < today
          case 'today': return (task) => task.due !== null && localDueOf(task.due).date === today
          case 'tomorrow': return (task) => task.due !== null && localDueOf(task.due).date === tomorrow
          case 'no date': return (task) => task.due === null
          case 'no time': return (task) => task.due !== null && !task.due.time
          case 'no project': return (task) => task.project_id === null
          case 'no labels': return (task) => task.labels.length === 0
          case 'no deadline': return (task) => !task.deadline
          case 'no start': return (task) => !task.start
          case 'someday': return (task) => task.start === 'someday'
          case 'deferred': return (task) => !!task.start && task.start !== 'someday' && task.start > today
          case 'evening': return (task) => !!task.evening
          // The stored part of the day (day-parts), never the part a due time places it in.
          case 'morning': return (task) => dayPartOf(task) === 'morning'
          case 'afternoon': return (task) => dayPartOf(task) === 'afternoon'
          // A habit's skipped occurrence record is not a completion (OpenSpec habits, D6).
          case 'completed': return (task) => task.completed_at !== null && !task.skipped
          case 'open': return (task) => task.completed_at === null
          case 'subtask': return (task) => task.parent_id !== null
          case 'habit': return (task) => task.habit === true
          case 'origin': return (task) => originOf(task) !== null
          case 'no origin': return (task) => originOf(task) === null
          case 'energy': return (task) => energyOf(task) !== null
          case 'no energy': return (task) => energyOf(task) === null
          // A note of only whitespace is no note (notes-overview D5).
          case 'notes': return (task) => (task.description ?? '').trim() !== ''
          case 'no notes': return (task) => (task.description ?? '').trim() === ''
          // At least one minute of live tracked time (time-tracking D9).
          case 'tracked': return (task) => (ctx.tracked?.get(task.id) ?? 0) >= 1
          case 'blocked': { const b = blockedSet(); return (task) => b.has(task.id) }
          case 'unblocked': { const b = blockedSet(); return (task) => !b.has(task.id) }
          // Available now (project-flow-modes): not blocked, not waiting in sequence, neither Someday nor deferred.
          case 'available': { const f = flowState(); return (task) => f.available(task.id) }
        }
    }
  }

  const pred = build(ast)
  const openOnly = !mentionsState(ast)
  // Skipped habit records match no query, whatever its terms (habits D6).
  const test: Pred = openOnly
    ? (task) => !task.deleted_at && task.completed_at === null && pred(task)
    : (task) => !task.deleted_at && !task.skipped && pred(task)
  return { test, warnings }
}

/** Parse and evaluate in one step; syntax errors are returned, not thrown. */
export function runFilter(source: string, tasks: readonly Task[], ctx: FilterContext): FilterResult {
  try {
    const ast = parse(source)
    if (!ast) return { ok: true, empty: true, tasks: [], warnings: [] }
    // A field term its type cannot answer is reported like a syntax error (custom-fields).
    const { test, warnings } = compile(ast, ctx.tasks ? ctx : { ...ctx, tasks })
    // A query that names a workspace looks at every workspace's tasks (group-mentions D6).
    const scope = ctx.everyWorkspace && namesWorkspace(ast) ? ctx.everyWorkspace.tasks : tasks
    return { ok: true, empty: false, tasks: scope.filter(test), warnings }
  } catch (e) {
    const err = e as { message: string; offset?: number }
    if (typeof err.offset !== 'number') throw e
    return { ok: false, error: err.message, offset: err.offset, position: err.offset + 1 }
  }
}
