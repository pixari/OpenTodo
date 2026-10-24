// The on-device write tools (assistant-on-device D8): they only PLAN. Each
// returns the result for the model and the changes, which the loop gathers into
// one proposal for the review card. Ported from internal/agenttools
// (write_tasks.go, write_projects.go, write_planning.go) and pinned to it by
// plan.vectors.json; arguments the device does not offer are refused as unknown.
import { seriesRule, planCompletion } from '../recurring'
import { isKnownZone } from '../dates'
import { uuid } from '../ids'
import type { ProposedChange } from '../assistantTypes'
import type { Task } from '../types'
import { ArgError, ToolError, calendarDate, forbidden, idList, items, notFound, only, present, str, text, zone, type Args } from './args'
import { canWriteTask, isOpen, list, roleIn, scopeKey, str as field, type Row, type Snapshot } from './data'
import { todayIn } from './read'

export interface Plan {
  result: Record<string, unknown>
  changes: ProposedChange[]
}

export interface PlanContext {
  snap: Snapshot
  now: number
  /** Changes planned earlier in this turn (trash_tasks accepts only their creations). */
  overlay: ProposedChange[]
}

const MAX_BLOCKED_BY = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function result(tool: string, results: Record<string, unknown>[], changed: number): Record<string, unknown> {
  return { tool, results, changed, undo: 'Every change is in the task\'s history; completed tasks can be reopened and trashed tasks restored from the Trash.' }
}

/** The planned-over values of the patched fields. */
function base(t: Row, patch: Record<string, unknown>): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  for (const f of Object.keys(patch)) b[f] = t[f] === undefined ? null : t[f]
  return b
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The op schema checks a planned value must pass (internal/sync kinds). */
function checkPatch(prefix: string, patch: Record<string, unknown>): void {
  for (const [f, v] of Object.entries(patch)) {
    if (v === null) continue
    switch (f) {
      case 'priority':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4) throw new ArgError(`${prefix}priority: must be an integer from 1 (highest) to 4 (lowest)`)
        break
      case 'estimate_minutes':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10080) throw new ArgError(`${prefix}estimate_minutes: must be null or an integer from 1 to 10080`)
        break
      case 'due': {
        const d = v as { date?: unknown; time?: unknown; tz?: unknown }
        if (typeof d !== 'object' || typeof d.date !== 'string' || !calendarDate(d.date)) throw new ArgError(`${prefix}due.date: must be a calendar date in YYYY-MM-DD form`)
        if (d.time !== undefined && d.time !== null && (typeof d.time !== 'string' || !CLOCK_RE.test(d.time))) throw new ArgError(`${prefix}due: must be null or a due whose time "HH:MM" is between 00:00 and 23:59`)
        if (d.tz !== undefined && d.tz !== null) {
          if (d.time === undefined || d.time === null) throw new ArgError(`${prefix}due: tz requires time`)
          if (typeof d.tz !== 'string' || !isKnownZone(d.tz)) throw new ArgError(`${prefix}due: tz must be a known IANA time zone`)
        }
        break
      }
      case 'title': case 'description': case 'name': case 'body':
        if (typeof v !== 'string') throw new ArgError(`${prefix}${f}: must be a string`)
        break
    }
  }
}

/** Label names (case-insensitive) or ids to ids. */
function labelIds(snap: Snapshot, prefix: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ArgError(`${prefix}labels: must be an array of strings`)
  if (v.length > 50) throw new ArgError(`${prefix}labels: at most 50 labels`)
  const out: string[] = []
  for (const n of v as string[]) {
    let id = snap.labels.has(n) ? n : ''
    if (!id) {
      const want = n.trim().toLowerCase()
      const hit = snap.labelList.find((l) => { const name = field(l, 'name'); return name && !name.startsWith('enc:') && name.toLowerCase() === want })
      id = hit ? field(hit, 'id') : ''
    }
    if (!id) throw new ArgError(`${prefix}labels: no label named ${JSON.stringify(n)} (create it with create_label first)`)
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** deadline, start, evening and blocked_by as sent (planningPatch). */
function planningPatch(prefix: string, it: Args, patch: Record<string, unknown>): void {
  if ('deadline' in it) {
    const v = it.deadline
    if (v === null) patch.deadline = null
    else if (typeof v !== 'string' || !calendarDate(v)) throw new ArgError(`${prefix}deadline: must be a calendar date in YYYY-MM-DD form or null`)
    else patch.deadline = v
  }
  if ('start' in it) {
    const v = it.start
    if (v === null) patch.start = null
    else if (typeof v !== 'string' || (v !== 'someday' && !calendarDate(v))) throw new ArgError(`${prefix}start: must be a calendar date in YYYY-MM-DD form, "someday" or null`)
    else patch.start = v
  }
  if ('evening' in it) {
    if (typeof it.evening !== 'boolean') throw new ArgError(`${prefix}evening: must be true or false`)
    patch.evening = it.evening
  }
  if ('blocked_by' in it) {
    const v = it.blocked_by
    if (v !== null && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) throw new ArgError(`${prefix}blocked_by: must be an array of task ids`)
    const out: string[] = []
    for (const raw of (v as string[] | null) ?? []) {
      const id = raw.trim()
      if (!id || id.length > 64) throw new ArgError(`${prefix}blocked_by: ids must be non-empty strings`)
      if (!out.includes(id)) out.push(id)
    }
    if (out.length > MAX_BLOCKED_BY) throw new ArgError(`${prefix}blocked_by: at most ${MAX_BLOCKED_BY} tasks`)
    patch.blocked_by = out
  }
}

interface BlockerEntry { prefix: string; taskId: string; project: string; list: string[] }

/** Blockers exist, are not the task, share its scope and close no cycle (checkBlockers). */
function checkBlockers(snap: Snapshot, entries: BlockerEntry[], created: Map<string, string>): void {
  const missing: string[] = []
  for (const e of entries) {
    for (const id of e.list) {
      if (id === e.taskId) throw new ArgError(`${e.prefix}blocked_by: a task cannot wait for itself (${id})`)
      let proj = created.get(id)
      if (proj === undefined) {
        const t = snap.byId.get(id)
        if (!t) { missing.push(id); continue }
        proj = field(t, 'project_id')
      }
      if (scopeKey(snap, proj) !== scopeKey(snap, e.project)) throw new ArgError(`${e.prefix}blocked_by: task ${id} is in a project shared differently; a task can only wait for tasks of the same sharing`)
    }
  }
  if (missing.length) throw notFound('task', missing.sort())
  const graph = new Map<string, string[]>()
  for (const t of snap.tasks) if (list(t, 'blocked_by').length) graph.set(field(t, 'id'), list(t, 'blocked_by'))
  for (const e of entries) graph.set(e.taskId, e.list)
  for (const e of entries) {
    for (const id of e.list) {
      const seen = new Set<string>()
      const stack = [id]
      while (stack.length) {
        const cur = stack.pop()!
        if (cur === e.taskId) throw new ArgError(`${e.prefix}blocked_by: waiting for ${id} would close a cycle (that task already waits for this one, directly or through others)`)
        if (seen.has(cur)) continue
        seen.add(cur)
        stack.push(...(graph.get(cur) ?? []))
      }
    }
  }
}

function chosenId(it: Args, prefix: string): string {
  const v = str(it, 'id').toLowerCase()
  if (v && !UUID_RE.test(v)) throw new ArgError(`${prefix}id: must be a UUID`)
  return v
}

function claimIds(ctx: PlanContext, ids: string[]): void {
  for (const id of ids) {
    if (ctx.snap.byId.has(id) || ctx.snap.projects.has(id) || ctx.snap.labels.has(id) || ctx.overlay.some((c) => c.entityId === id)) {
      throw new ToolError('conflict', 'the id you chose is already used; nothing was created', { id })
    }
  }
}

function lookupTasks(snap: Snapshot, ids: string[]): Row[] {
  const missing = ids.filter((id) => !snap.byId.has(id))
  if (missing.length) throw notFound('task', missing)
  return ids.map((id) => snap.byId.get(id)!)
}

function checkRoles(snap: Snapshot, tasks: Row[]): void {
  const refused = tasks.filter((t) => !canWriteTask(roleIn(snap, field(t, 'project_id')))).map((t) => ({ id: field(t, 'id'), reason: 'forbidden', role: roleIn(snap, field(t, 'project_id')) }))
  if (refused.length) throw forbidden(refused)
}

export function createTasks(ctx: PlanContext, a: Args): Plan {
  const { snap, now } = ctx
  only(a, '', 'items')
  const list0 = items(a, 'items')
  const changes: ProposedChange[] = []
  const out: Record<string, unknown>[] = []
  const refused: Record<string, unknown>[] = []
  const chosen: string[] = []
  const blockers: BlockerEntry[] = []
  const created = new Map<string, string>()
  list0.forEach((it, i) => {
    const p = `items[${i}].`
    only(it, p, 'id', 'title', 'description', 'project_id', 'section_id', 'parent_id', 'priority', 'due', 'labels', 'estimate_minutes', 'deadline', 'start', 'evening', 'blocked_by')
    let title: string, desc: string
    try {
      title = text(it, 'title', true, 500)!
      desc = text(it, 'description', false, 20000) ?? ''
    } catch (e) {
      throw new ArgError(p + (e as Error).message)
    }
    let id = chosenId(it, p)
    if (id) {
      if (chosen.includes(id)) throw new ArgError(`${p}id: each id may appear only once per call`)
      chosen.push(id)
    } else id = uuid()
    const patch: Record<string, unknown> = {
      title: title.trim(), description: desc, project_id: null, parent_id: null, priority: 4, due: null, labels: [], position: now + i,
      created_at: now, completed_at: null, deleted_at: null,
    }
    let pid = str(it, 'project_id')
    if (pid) {
      if (!snap.projects.has(pid)) throw notFound('project', [pid])
      patch.project_id = pid
      if (!canWriteTask(roleIn(snap, pid))) refused.push({ item: i, project_id: pid, reason: 'forbidden', role: roleIn(snap, pid) })
    }
    const sid = str(it, 'section_id')
    if (sid) {
      if (field(snap.sections.get(sid), 'project_id') !== pid || !pid) throw new ArgError(`${p}section_id: no such section in that project`)
      patch.section_id = sid
    }
    const parent = str(it, 'parent_id')
    if (parent) {
      const pt = snap.byId.get(parent)
      if (!pt) throw notFound('task', [parent])
      const pp = field(pt, 'project_id')
      if (!pid && !present(it, 'project_id') && pp) {
        pid = pp
        patch.project_id = pid
        if (!canWriteTask(roleIn(snap, pid))) refused.push({ item: i, project_id: pid, reason: 'forbidden', role: roleIn(snap, pid) })
      }
      if (pp !== pid) throw new ArgError(`${p}parent_id: the parent task must be in the same project`)
      patch.parent_id = parent
    }
    for (const f of ['priority', 'due', 'estimate_minutes']) if (present(it, f)) patch[f] = it[f]
    if (present(it, 'labels')) patch.labels = labelIds(snap, p, it.labels)
    planningPatch(p, it, patch)
    checkPatch(p, patch)
    created.set(id, pid)
    if (Array.isArray(patch.blocked_by)) blockers.push({ prefix: p, taskId: id, project: pid, list: patch.blocked_by as string[] })
    changes.push({ entity: 'task', entityId: id, create: true, patch })
    out.push({ id, status: 'created' })
  })
  if (refused.length) throw forbidden(refused)
  checkBlockers(snap, blockers, created)
  claimIds(ctx, chosen)
  return { result: result('create_tasks', out, changes.length), changes }
}

export function updateTasks(ctx: PlanContext, a: Args): Plan {
  const { snap } = ctx
  only(a, '', 'updates')
  const list0 = items(a, 'updates')
  const changes: ProposedChange[] = []
  const out: Record<string, unknown>[] = []
  const missing: string[] = []
  const refused: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const blockers: BlockerEntry[] = []
  list0.forEach((it, i) => {
    const p = `updates[${i}].`
    only(it, p, 'id', 'title', 'description', 'priority', 'labels', 'estimate_minutes', 'deadline', 'start', 'evening', 'blocked_by')
    const id = typeof it.id === 'string' ? it.id : ''
    if (!id) throw new ArgError(`${p}id: the task id is required`)
    if (seen.has(id)) throw new ArgError(`${p}id: each task may appear only once per call`)
    seen.add(id)
    const patch: Record<string, unknown> = {}
    try {
      const title = text(it, 'title', false, 500)
      if (title !== null) {
        if (!title.trim()) throw new ArgError('title: must not be empty')
        patch.title = title.trim()
      }
      const desc = text(it, 'description', false, 20000)
      if (desc !== null) patch.description = desc
    } catch (e) {
      throw new ArgError(p + (e as Error).message)
    }
    if (present(it, 'priority')) patch.priority = it.priority
    if ('estimate_minutes' in it) patch.estimate_minutes = it.estimate_minutes
    if (present(it, 'labels')) patch.labels = labelIds(snap, p, it.labels)
    planningPatch(p, it, patch)
    if (Object.keys(patch).length === 0) throw new ArgError(`${p}nothing to change: give at least one field besides id`)
    checkPatch(p, patch)
    const t = snap.byId.get(id)
    if (!t) { missing.push(id); return }
    if (Array.isArray(patch.blocked_by)) blockers.push({ prefix: p, taskId: id, project: field(t, 'project_id'), list: patch.blocked_by as string[] })
    const role = roleIn(snap, field(t, 'project_id'))
    if (!canWriteTask(role)) refused.push({ id, reason: 'forbidden', role })
    changes.push({ entity: 'task', entityId: id, patch, base: base(t, patch) })
    out.push({ id, status: 'updated' })
  })
  if (missing.length) throw notFound('task', missing)
  if (refused.length) throw forbidden(refused)
  checkBlockers(snap, blockers, new Map())
  return { result: result('update_tasks', out, changes.length), changes }
}

export function completeTasks(ctx: PlanContext, a: Args): Plan {
  const { snap, now } = ctx
  only(a, '', 'ids', 'timezone')
  const ids = idList(a, 'ids')
  const today = todayIn(zone(a), now)
  const tasks = lookupTasks(snap, ids)
  checkRoles(snap, tasks)
  const changes: ProposedChange[] = []
  const out: Record<string, unknown>[] = []
  let n = 0
  for (const t of tasks) {
    const id = field(t, 'id')
    if (!isOpen(t)) { out.push({ id, status: 'already_completed' }); continue }
    const rule = seriesRule(t as unknown as Task)
    const plan = rule ? planCompletion(t as unknown as Task, rule, snap.tasks as unknown as Task[], now, today) : null
    if (plan && plan.kind === 'roll') {
      // A recurring task records the occurrence and moves to its next date, as in the app (recurring-tasks D5).
      const [record, series] = plan.changes
      changes.push({ entity: 'task', entityId: record.entityId, create: true, patch: record.patch })
      changes.push({ entity: 'task', entityId: id, patch: series.patch, base: base(t, series.patch) })
      out.push({ id, status: 'occurrence_completed', occurrence_id: record.entityId, next_due: plan.next })
    } else {
      const patch = { completed_at: now }
      changes.push({ entity: 'task', entityId: id, patch, base: base(t, patch) })
      out.push({ id, status: 'completed' })
    }
    n++
  }
  return { result: result('complete_tasks', out, n), changes }
}

export function reopenTasks(ctx: PlanContext, a: Args): Plan {
  only(a, '', 'ids')
  const tasks = lookupTasks(ctx.snap, idList(a, 'ids'))
  checkRoles(ctx.snap, tasks)
  const changes: ProposedChange[] = []
  const out = tasks.map((t) => {
    if (isOpen(t)) return { id: field(t, 'id'), status: 'already_open' }
    const patch = { completed_at: null }
    changes.push({ entity: 'task', entityId: field(t, 'id'), patch, base: base(t, patch) })
    return { id: field(t, 'id'), status: 'reopened' }
  })
  return { result: result('reopen_tasks', out, changes.length), changes }
}

export function moveTasks(ctx: PlanContext, a: Args): Plan {
  const { snap } = ctx
  only(a, '', 'ids', 'project_id', 'section_id')
  const ids = idList(a, 'ids')
  if (!('project_id' in a)) throw new ArgError('project_id: is required (null moves to the inbox)')
  const pid = str(a, 'project_id')
  const sid = str(a, 'section_id')
  if (pid && !snap.projects.has(pid)) throw notFound('project', [pid])
  if (sid && (!snap.sections.has(sid) || field(snap.sections.get(sid), 'project_id') !== pid)) throw new ArgError('section_id: no such section in the target project')
  const tasks = lookupTasks(snap, ids)
  const refused: Record<string, unknown>[] = []
  for (const t of tasks) {
    const from = field(t, 'project_id')
    if (scopeKey(snap, from) !== scopeKey(snap, pid)) refused.push({ id: field(t, 'id'), reason: 'scope_change' })
    else if (!canWriteTask(roleIn(snap, from))) refused.push({ id: field(t, 'id'), reason: 'forbidden', role: roleIn(snap, from) })
  }
  if (refused.length) {
    if (refused.some((r) => r.reason === 'scope_change')) throw new ToolError('scope_change', 'tasks cannot move between projects that are shared differently (or between a shared project and a personal one); nothing was changed', { items: refused })
    throw forbidden(refused)
  }
  const moving = new Set(ids)
  const changes: ProposedChange[] = []
  const out = tasks.map((t) => {
    const id = field(t, 'id')
    const patch: Record<string, unknown> = {}
    if (field(t, 'project_id') !== pid) patch.project_id = pid || null
    if (field(t, 'section_id') !== sid) patch.section_id = sid || null
    const parent = field(t, 'parent_id')
    if (parent && !moving.has(parent) && 'project_id' in patch) patch.parent_id = null
    if (!Object.keys(patch).length) return { id, status: 'unchanged' }
    changes.push({ entity: 'task', entityId: id, patch, base: base(t, patch) })
    return { id, status: 'moved' }
  })
  return { result: result('move_tasks', out, changes.length), changes }
}

export function scheduleTasks(ctx: PlanContext, a: Args): Plan {
  const { snap } = ctx
  only(a, '', 'ids', 'due')
  const ids = idList(a, 'ids')
  if (!('due' in a)) throw new ArgError('due: is required (null removes the due date)')
  const want = a.due as Record<string, unknown> | null
  if (want !== null) {
    if (typeof want !== 'object' || Array.isArray(want)) throw new ArgError('due: must be null or {"date":"YYYY-MM-DD","time":"HH:MM"?,"tz":"Area/City"?}')
    for (const k of Object.keys(want)) if (!['date', 'time', 'tz'].includes(k)) throw new ArgError(`due.${k}: unknown argument`)
    if (typeof want.date !== 'string' || !want.date) throw new ArgError('due.date: is required (YYYY-MM-DD)')
  }
  const tasks = lookupTasks(snap, ids)
  checkRoles(snap, tasks)
  const changes: ProposedChange[] = []
  const out: Record<string, unknown>[] = []
  for (const t of tasks) {
    const id = field(t, 'id')
    let next: Record<string, unknown> | null = null
    if (want) {
      const cur = t.due as { time?: string; tz?: string } | null | undefined
      next = { date: want.date }
      if ('time' in want) {
        if (want.time !== null) {
          if (typeof want.time !== 'string') throw new ArgError('due.time: must be HH:MM or null')
          next.time = want.time
        }
      } else if (cur?.time) next.time = cur.time
      if ('tz' in want) {
        if (want.tz !== null) {
          if (typeof want.tz !== 'string') throw new ArgError('due.tz: must be an IANA time zone or null')
          next.tz = want.tz
        }
      } else if (cur?.tz && next.time) next.tz = cur.tz
    }
    const patch = { due: next }
    checkPatch('', patch)
    if (same(t.due, next)) { out.push({ id, status: 'unchanged' }); continue }
    changes.push({ entity: 'task', entityId: id, patch, base: base(t, patch) })
    out.push({ id, status: 'scheduled' })
  }
  return { result: result('schedule_tasks', out, changes.length), changes }
}

function color(a: Args): string {
  const v = text(a, 'color', false, 7)
  if (v === null) return '#64748b'
  if (!COLOR_RE.test(v)) throw new ArgError('color: must be #rrggbb')
  return v.toLowerCase()
}

export function createProject(ctx: PlanContext, a: Args): Plan {
  const { snap, now } = ctx
  only(a, '', 'name', 'color', 'parent_id')
  const name = text(a, 'name', true, 200)!
  const c = color(a)
  const id = uuid()
  const patch: Record<string, unknown> = { name: name.trim(), color: c, position: now, archived: false, parent_id: null, created_at: now, deleted_at: null }
  const parent = str(a, 'parent_id')
  if (parent) {
    if (!snap.projects.has(parent)) throw notFound('project', [parent])
    patch.parent_id = parent
  }
  return { result: result('create_project', [{ id, status: 'created' }], 1), changes: [{ entity: 'project', entityId: id, create: true, patch }] }
}

export function createLabel(ctx: PlanContext, a: Args): Plan {
  const { snap, now } = ctx
  only(a, '', 'name', 'color')
  const name = text(a, 'name', true, 100)!.trim()
  const c = color(a)
  const hit = snap.labelList.find((l) => field(l, 'name') && !field(l, 'name').startsWith('enc:') && field(l, 'name').toLowerCase() === name.toLowerCase())
  if (hit) return { result: result('create_label', [{ id: field(hit, 'id'), status: 'exists' }], 0), changes: [] }
  const id = uuid()
  const patch = { name, color: c, position: now, created_at: now, deleted_at: null }
  return { result: result('create_label', [{ id, status: 'created' }], 1), changes: [{ entity: 'label', entityId: id, create: true, patch }] }
}

export function addComment(ctx: PlanContext, a: Args): Plan {
  const { snap, now } = ctx
  only(a, '', 'task_id', 'body')
  const taskId = str(a, 'task_id')
  if (!taskId) throw new ArgError('task_id: the task id is required')
  const body = text(a, 'body', true, 10000)!
  if (!snap.byId.has(taskId)) throw notFound('task', [taskId])
  const id = uuid()
  // mentions stays empty: assistant comments never notify (mcp-write-tools D9.3).
  const patch = { task_id: taskId, author_id: snap.userId, body, parent_id: null, mentions: [], created_at: now, edited_at: null, deleted_at: null }
  return { result: result('add_comment', [{ id, status: 'created', task_id: taskId }], 1), changes: [{ entity: 'comment', entityId: id, create: true, patch }] }
}

export function trashTasks(ctx: PlanContext, a: Args): Plan {
  only(a, '', 'ids')
  const tasks = lookupTasks(ctx.snap, idList(a, 'ids'))
  // Only tasks this same proposal creates (in-app-assistant D7.2).
  const foreign = tasks.map((t) => field(t, 'id')).filter((id) => !ctx.overlay.some((c) => c.create && c.entityId === id))
  if (foreign.length) throw new ToolError('not_permitted', 'trash_tasks accepts only tasks created with this same token; nothing was changed', { ids: foreign })
  checkRoles(ctx.snap, tasks)
  const changes = tasks.map((t) => {
    const patch = { deleted_at: ctx.now }
    return { entity: 'task' as const, entityId: field(t, 'id'), patch, base: base(t, patch) }
  })
  return { result: result('trash_tasks', tasks.map((t) => ({ id: field(t, 'id'), status: 'trashed' })), changes.length), changes }
}

export const PLANNERS: Record<string, (ctx: PlanContext, a: Args) => Plan> = {
  create_tasks: createTasks, update_tasks: updateTasks, complete_tasks: completeTasks, reopen_tasks: reopenTasks, move_tasks: moveTasks,
  schedule_tasks: scheduleTasks, create_project: createProject, create_label: createLabel, add_comment: addComment, trash_tasks: trashTasks,
}
