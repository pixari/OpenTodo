// The on-device read tools (assistant-on-device D8), over this device's rows in
// the shapes of internal/agenttools/read.go: every user-written string travels
// inside `untrusted_text`, and the loop adds the untrusted notice to each result.
import { isInboxTask, type InboxFields } from '../inbox'
import { localDate } from '../dates'
import { isCiphertext, PREFIX as CIPHERTEXT_PREFIX } from '../crypto'
import { db } from '../db'
import type { Due } from '../types'
import { ArgError, ToolError, bool, date, int, limit, only, str, zone, type Args } from './args'
import { isOpen, list, num, str as field, type Row, type Snapshot } from './data'

/** Today's date in a zone. */
export function todayIn(tz: string, now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : undefined)
const dueOf = (t: Row): Due | null => {
  const d = t.due as Due | null | undefined
  return d && typeof d.date === 'string' ? d : null
}
/** The due date in the zone (a zoned due moves; a floating one stays). */
const dueDate = (d: Due, tz: string): string => localDate(d, tz) ?? d.date

function blockedNow(snap: Snapshot, t: Row): boolean {
  if (!isOpen(t)) return false
  return list(t, 'blocked_by').some((id) => {
    const b = snap.byId.get(id)
    return !!b && isOpen(b)
  })
}

function inboxRule(snap: Snapshot): (t: Row) => boolean {
  const parentOf = (id: string) => snap.byId.get(id) as InboxFields | undefined
  return (t) => isInboxTask(t as unknown as InboxFields, parentOf)
}

const projectName = (snap: Snapshot, pid: string) => (pid ? field(snap.projects.get(pid), 'name') : 'Inbox')

/** A task as an assistant sees it (snapshot.render). */
function render(snap: Snapshot, t: Row, tz: string, today: string, withDescription: boolean): Record<string, unknown> {
  const pid = field(t, 'project_id')
  const labels: string[] = []
  const labelIds: string[] = []
  for (const lid of list(t, 'labels')) {
    const l = snap.labels.get(lid)
    if (l) { labels.push(field(l, 'name')); labelIds.push(lid) }
  }
  const text: Record<string, unknown> = { title: field(t, 'title'), project: projectName(snap, pid), labels }
  if (withDescription) text.description = field(t, 'description')
  const sid = field(t, 'section_id')
  const out: Record<string, unknown> = {
    id: field(t, 'id'), untrusted_text: text, project_id: pid || null, priority: [1, 2, 3, 4].includes(num(t, 'priority')) ? num(t, 'priority') : 4,
    due: null, label_ids: labelIds, completed: !isOpen(t),
    deadline: (t.deadline as string | null | undefined) ?? null, start: (t.start as string | null | undefined) ?? null, evening: t.evening === true,
    blocked_by: list(t, 'blocked_by'), blocked: blockedNow(snap, t),
  }
  if (sid && snap.sections.has(sid)) { out.section_id = sid; text.section = field(snap.sections.get(sid), 'name') }
  if (field(t, 'parent_id')) out.parent_id = field(t, 'parent_id')
  if (field(t, 'recurrence')) out.recurrence = field(t, 'recurrence')
  if (num(t, 'estimate_minutes') > 0) out.estimate_minutes = num(t, 'estimate_minutes')
  if (!isOpen(t)) out.completed_at = iso(num(t, 'completed_at'))
  if (pid && snap.memberships.has(pid)) out.shared = true
  if (isCiphertext(t.title) || isCiphertext(t.description)) out.encrypted = true
  const d = dueOf(t)
  if (d) {
    const local = dueDate(d, tz)
    out.due = d.tz ? { ...d, local_date: local } : d
    out.overdue = isOpen(t) && local < today
  }
  return out
}

/** Undated last, then due date and time, priority and creation (taskKey). */
function byKey(tz: string) {
  const key = (t: Row) => {
    const d = dueOf(t)
    return [d ? dueDate(d, tz) : '~', d?.time ?? '~', String(num(t, 'priority') || 4), String(num(t, 'created_at')).padStart(16, '0'), field(t, 'id')].join('|')
  }
  return (a: Row, b: Row) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

function visible(snap: Snapshot, t: Row, includeArchived: boolean): boolean {
  const pid = field(t, 'project_id')
  if (!pid) return true
  const p = snap.projects.get(pid)
  return !!p && (includeArchived || p.archived !== true)
}

export function listProjects(snap: Snapshot, a: Args, maxItems: number) {
  only(a, '', 'include_archived')
  const archived = bool(a, 'include_archived')
  const counts = new Map<string, number>()
  for (const t of snap.tasks) if (isOpen(t)) counts.set(field(t, 'project_id'), (counts.get(field(t, 'project_id')) ?? 0) + 1)
  const inInbox = inboxRule(snap)
  const projects = snap.projList
    .filter((p) => archived || p.archived !== true)
    .sort((x, y) => num(x, 'position') - num(y, 'position') || num(x, 'created_at') - num(y, 'created_at'))
    .slice(0, maxItems)
    .map((p) => {
      const id = field(p, 'id')
      const shared = snap.memberships.get(id)
      return {
        id, untrusted_text: { name: field(p, 'name'), description: field(p, 'description') }, encrypted: isCiphertext(p.name), color: field(p, 'color'),
        archived: p.archived === true, ...(field(p, 'parent_id') ? { parent_id: field(p, 'parent_id') } : {}),
        shared: !!shared, ...(shared ? { role: shared.role } : {}), open_count: counts.get(id) ?? 0,
      }
    })
  return { projects, inbox_open_count: snap.tasks.filter(inInbox).length }
}

const VIEWS = ['all', 'inbox', 'today', 'upcoming', 'someday', 'anytime']

export function listTasks(snap: Snapshot, a: Args, now: number, maxItems: number) {
  only(a, '', 'view', 'project_id', 'label', 'priority', 'due_from', 'due_to', 'include_completed', 'blocked', 'limit', 'timezone')
  const view = str(a, 'view') || 'all'
  if (!VIEWS.includes(view)) throw new ArgError('view: must be one of all, inbox, today, upcoming, someday, anytime')
  const blocked = a.blocked === undefined || a.blocked === null ? null : bool(a, 'blocked')
  const projectId = str(a, 'project_id')
  const label = str(a, 'label')
  const priority = int(a, 'priority')
  if (priority !== null && (priority < 1 || priority > 4)) throw new ArgError('priority: must be an integer from 1 (highest) to 4')
  const from = date(a, 'due_from')
  const to = date(a, 'due_to')
  const completed = bool(a, 'include_completed')
  const tz = zone(a)
  const max = limit(a, maxItems)
  const today = todayIn(tz, now)
  if (projectId && !snap.projects.has(projectId)) throw new ArgError('project_id: no such project')
  let wanted: Set<string> | null = null
  if (label) {
    wanted = new Set(snap.labelList.filter((l) => l.id === label || field(l, 'name').toLowerCase() === label.toLowerCase()).map((l) => field(l, 'id')))
    if (wanted.size === 0) throw new ArgError('label: no such label')
  }
  const inInbox = inboxRule(snap)
  const out = snap.tasks.filter((t) => {
    if (projectId && field(t, 'project_id') !== projectId) return false
    if (!visible(snap, t, !!projectId)) return false
    const open = isOpen(t)
    const d = dueOf(t)
    const day = d ? dueDate(d, tz) : ''
    const start = (t.start as string | null | undefined) ?? ''
    switch (view) {
      case 'inbox': if (!inInbox(t)) return false; break
      case 'today': if (!d || day > today || !open) return false; break
      case 'upcoming': if (!d || day <= today || !open) return false; break
      case 'someday': if (!open || start !== 'someday') return false; break
      case 'anytime': if (!open || d || t.deadline || start) return false; break
    }
    if (blocked !== null && blockedNow(snap, t) !== blocked) return false
    if (!open && !completed) return false
    if (priority !== null && (num(t, 'priority') || 4) !== priority) return false
    if ((from || to) && (!d || (from && day < from) || (to && day > to))) return false
    if (wanted && !list(t, 'labels').some((l) => wanted!.has(l))) return false
    return true
  }).sort(byKey(tz))
  return { tasks: out.slice(0, max).map((t) => render(snap, t, tz, today, false)), ...(out.length > max ? { truncated: true } : {}), timezone: tz, today }
}

export async function getTask(snap: Snapshot, a: Args, now: number, maxItems: number) {
  only(a, '', 'id', 'timezone')
  const id = str(a, 'id')
  if (!id) throw new ArgError('id: the task id is required')
  const tz = zone(a)
  const today = todayIn(tz, now)
  const task = snap.byId.get(id)
  if (!task) throw new ToolError('', 'task not found')
  const subtasks = snap.tasks.filter((t) => field(t, 'parent_id') === id)
    .sort((x, y) => num(x, 'position') - num(y, 'position') || num(x, 'created_at') - num(y, 'created_at'))
    .slice(0, maxItems).map((t) => render(snap, t, tz, today, false))
  const rows = (await db.comments.where('task_id').equals(id).toArray()) as unknown as Row[]
  const comments = rows.filter((c) => !c.deleted_at).sort((x, y) => num(x, 'created_at') - num(y, 'created_at')).slice(0, maxItems).map((c) => ({
    id: field(c, 'id'), untrusted_text: { body: field(c, 'body') }, ...(field(c, 'parent_id') ? { parent_id: field(c, 'parent_id') } : {}),
    author_id: field(c, 'author_id'), author_is_you: field(c, 'author_id') === snap.userId, created_at: iso(num(c, 'created_at')),
  }))
  return { task: render(snap, task, tz, today, true), subtasks, comments, timezone: tz, today }
}

export function searchTasks(snap: Snapshot, a: Args, now: number, maxItems: number) {
  only(a, '', 'query', 'include_completed', 'limit', 'timezone')
  const query = str(a, 'query')
  if (!query) throw new ArgError('query: must not be empty')
  const completed = bool(a, 'include_completed')
  const tz = zone(a)
  const max = limit(a, maxItems)
  const today = todayIn(tz, now)
  const needle = query.toLowerCase()
  const plain = (v: unknown) => {
    // Ciphertext a device could not decrypt never matches.
    const s: string = typeof v === 'string' ? v : ''
    return s.startsWith(CIPHERTEXT_PREFIX) ? '' : s.toLowerCase()
  }
  const out = snap.tasks.filter((t) => visible(snap, t, false) && (completed || isOpen(t)) && (plain(t.title).includes(needle) || plain(t.description).includes(needle))).sort(byKey(tz))
  return { tasks: out.slice(0, max).map((t) => render(snap, t, tz, today, true)), ...(out.length > max ? { truncated: true } : {}), timezone: tz, today }
}

export function todaySummary(snap: Snapshot, a: Args, now: number, maxItems: number) {
  only(a, '', 'timezone')
  const tz = zone(a)
  const today = todayIn(tz, now)
  const inInbox = inboxRule(snap)
  const overdue: Row[] = []
  const dueToday: Row[] = []
  let inbox = 0
  const perProject = new Map<string, number>()
  for (const t of snap.tasks) {
    if (!isOpen(t) || !visible(snap, t, false)) continue
    const pid = field(t, 'project_id')
    if (inInbox(t)) inbox++
    else if (pid) perProject.set(pid, (perProject.get(pid) ?? 0) + 1)
    const d = dueOf(t)
    if (!d) continue
    const day = dueDate(d, tz)
    if (day < today) overdue.push(t)
    else if (day === today) dueToday.push(t)
  }
  const sort = byKey(tz)
  const o = overdue.sort(sort).slice(0, maxItems)
  const dt = dueToday.sort(sort).slice(0, maxItems - o.length)
  const counts = snap.projList.filter((p) => p.archived !== true)
    .map((p) => ({ id: field(p, 'id'), untrusted_text: { name: field(p, 'name') }, open: perProject.get(field(p, 'id')) ?? 0 }))
    .sort((x, y) => y.open - x.open).slice(0, maxItems)
  return {
    timezone: tz, today, overdue: o.map((t) => render(snap, t, tz, today, false)), due_today: dt.map((t) => render(snap, t, tz, today, false)),
    counts: { overdue: overdue.length, due_today: dueToday.length, inbox, per_project: counts },
    ...(o.length < overdue.length || dt.length < dueToday.length ? { truncated: true } : {}),
  }
}
