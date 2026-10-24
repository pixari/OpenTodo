// In-app assistant data layer (OpenSpec change `in-app-assistant`), loaded with
// the assistant chunk: the turn stream client (server-sent events over fetch),
// change-set review with "changed since proposed" detection, apply through
// mutateMany with device assistant:<device-id>, one-step undo, the auto-apply
// rule, sentence chunks for the live region, and the device-local threads.
// The server never applies a proposal; this module does, after review.
import { ApiError } from './api'
import { db, getMeta, setMeta, tableOf, type AssistantMessage, type AssistantThread, type AssistantUndo } from './db'
import { syncNow } from './sync'
import type { FieldDef, FieldValue, Label, Project, Section, Task } from './types'
import { formatValue } from './fields'
import { fieldValueId, readField } from './ops'
import type { ProposedChange, TurnEvent } from './assistantTypes'
import { applyBatch, undoBatch, type UndoResult } from './undo'
import { t } from './i18n'
import { uuid } from './ids'
export { UNDO_KEEP } from './undo'

// ------------------------------------------------------------------ stream

/** Parses a server-sent event stream fed in arbitrary chunks. */
export class SSEParser {
  private buf = ''
  private event = 'message'
  private data: string[] = []

  feed(chunk: string): TurnEvent[] {
    this.buf += chunk
    const out: TurnEvent[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') {
        if (this.data.length) {
          try {
            out.push({ type: this.event, ...JSON.parse(this.data.join('\n')) } as TurnEvent)
          } catch {
            // A malformed event is skipped.
          }
        }
        this.event = 'message'
        this.data = []
      } else if (line.startsWith('event:')) this.event = line.slice(6).trim()
      else if (line.startsWith('data:')) this.data.push(line.slice(5).trimStart())
    }
    return out
  }
}

export interface TurnRequest {
  /** `untrusted` marks text the user pasted (assistant-skills D3). */
  messages: { role: 'user' | 'assistant'; text: string; untrusted?: boolean }[]
  timezone: string
  view?: string
  selected?: string[]
  /** A built-in skill id and the device's working day (assistant-skills D2). */
  skill?: string
  workday?: { startHour: number; endHour: number; dayLength: number }
}

/**
 * Runs one turn: uploads pending local edits first (so the server reads what
 * the user sees), then streams the answer. Throws ApiError when the server
 * refuses the turn before streaming (consent, quota, size, busy, …).
 */
export async function streamTurn(req: TurnRequest, onEvent: (e: TurnEvent) => void, signal?: AbortSignal): Promise<void> {
  await Promise.race([syncNow().catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
  const res = await fetch('/api/v1/assistant/turn', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    const err = (data as { error?: { code: string; message: string } }).error
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const parser = new SSEParser()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const ev of parser.feed(dec.decode(value, { stream: true }))) onEvent(ev)
  }
  for (const ev of parser.feed(dec.decode() + '\n\n')) onEvent(ev)
}

/**
 * Messages of a turn: the last 40 at most and about 200 KB, older ones
 * summarised in one line. Pasted material goes just before the question,
 * marked untrusted; the server wraps it and folds it into the question.
 */
export function turnMessages(history: AssistantMessage[], question: string, pasted?: string): TurnRequest['messages'] {
  const all = [...history.filter((m) => m.text && !m.error && m.stop !== 'refusal').map((m) => ({ role: m.role, text: m.text })), { role: 'user' as const, text: question }]
  const out: TurnRequest['messages'] = []
  let bytes = 0
  for (let i = all.length - 1; i >= 0; i--) {
    const size = all[i].text.length * 3
    if (out.length >= 39 || bytes + size > 200_000) {
      out.unshift({ role: 'user', text: `(${i + 1} earlier message${i ? 's were' : ' was'} left out of this conversation.)` })
      break
    }
    bytes += size
    out.unshift(all[i])
  }
  // The server wants alternation to start with the user; it joins repeats itself.
  while (out.length && out[0].role !== 'user') out.shift()
  if (pasted) out.splice(out.length - 1, 0, { role: 'user', text: pasted, untrusted: true })
  return out
}

/** Splits streamed text at the last sentence boundary: [complete sentences, rest]. */
export function takeSentences(buffer: string): [string, string] {
  const re = /[.!?…](?:["'”’)\]]*)(?=\s)|\n/g
  let end = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(buffer))) end = m.index + m[0].length
  if (end < 0) return ['', buffer]
  return [buffer.slice(0, end).trim(), buffer.slice(end).replace(/^\s+/, '')]
}

// ------------------------------------------------------------------ review

export type ItemState = 'ok' | 'stale'

export interface ReviewItem {
  change: ProposedChange
  state: ItemState
  /** Unchecked items are not applied; stale items start unchecked. */
  checked: boolean
  /** The entity in words ("Water plants", "New project Garden"). */
  title: string
  /** Each change in words ("Due Wed 14 Oct → Fri 16 Oct"). */
  lines: string[]
  shared: boolean
}

export interface Review {
  items: ReviewItem[]
  /** Items dropped because the entity is gone on this device. */
  dropped: string[]
}

const norm = (v: unknown) => (v === undefined ? null : v)
/** Value equality of field values (JSON, key order ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    v = norm(v)
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    return v
  }
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

interface Names {
  projects: Map<string, string>
  labels: Map<string, string>
  sections: Map<string, string>
  /** Custom field definitions by id (custom-fields), for "Cost → 120". */
  fields?: Map<string, FieldDef>
  tasks: Map<string, string>
}

async function loadNames(changes: ProposedChange[]): Promise<Names> {
  const [projects, labels, sections, fields] = await Promise.all([db.projects.toArray(), db.labels.toArray(), db.sections.toArray(), db.fields.toArray()])
  const n: Names = {
    projects: new Map(projects.map((p: Project) => [p.id, p.name])),
    labels: new Map(labels.map((l: Label) => [l.id, l.name])),
    sections: new Map(sections.map((s: Section) => [s.id, s.name])),
    fields: new Map(fields.map((f: FieldDef) => [f.id, f])),
    tasks: new Map(),
  }
  // Entities created in the same proposal are named from their patch.
  for (const c of changes) {
    const name = typeof c.patch.name === 'string' ? c.patch.name : ''
    if (c.entity === 'project' && name) n.projects.set(c.entityId, name)
    if (c.entity === 'label' && name) n.labels.set(c.entityId, name)
    if (c.entity === 'task' && typeof c.patch.title === 'string') n.tasks.set(c.entityId, c.patch.title)
  }
  return n
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** A floating due date in words: "Fri 16 Oct", "Fri 16 Oct 09:00", "none". */
export function dueWords(due: unknown): string {
  const d = due as { date?: string; time?: string } | null
  if (!d || !d.date) return 'none'
  const [y, m, day] = d.date.split('-').map(Number)
  const text = Number.isFinite(y) ? DAY.format(new Date(Date.UTC(y, m - 1, day))).replace(',', '') : d.date
  return d.time ? `${text} ${d.time}` : text
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** A bare date (deadline, start) in words, as dueWords. */
const dayWords = (date: unknown) => dueWords(typeof date === 'string' ? { date } : null)

/** A location in words: its name, else its address, else its coordinates. */
function placeWords(v: unknown): string {
  const l = v as { name?: string; address?: string; lat?: number; lon?: number } | null
  if (!l) return ''
  if (l.name) return clip(l.name, 50)
  if (l.address) return clip(l.address, 50)
  return typeof l.lat === 'number' && typeof l.lon === 'number' ? `${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}` : t('a place')
}

/** The planning fields of a task change in words (agent-planning-fields D7). */
function planningLines(p: Record<string, unknown>, base: Record<string, unknown>, names: Names, create: boolean): string[] {
  const lines: string[] = []
  const title = (id: string) => `“${clip(names.tasks.get(id) ?? t('a task'), 40)}”`
  if ('deadline' in p && (p.deadline || !create)) {
    const old = base.deadline
    lines.push(p.deadline ? (old && !create ? t('Deadline {from} → {to}', { from: dayWords(old), to: dayWords(p.deadline) }) : t('Deadline {date}', { date: dayWords(p.deadline) })) : t('Deadline removed'))
  }
  if ('start' in p && (p.start || !create)) {
    const old = base.start
    if (p.start === 'someday') lines.push(t('Someday'))
    else if (p.start) lines.push(old && old !== 'someday' && !create ? t('Starts {from} → {to}', { from: dayWords(old), to: dayWords(p.start) }) : t('Starts {date}', { date: dayWords(p.start) }))
    else lines.push(old === 'someday' ? t('Out of Someday') : t('No start date'))
  }
  if ('evening' in p && (p.evening || !create)) lines.push(p.evening ? t('This evening') : t('Not this evening'))
  if ('blocked_by' in p) {
    const ids = (p.blocked_by as string[] | null) ?? []
    if (ids.length) lines.push(t('Waits for {tasks}', { tasks: ids.map(title).join(', ') }))
    else if (!create) lines.push(t('No longer waits'))
  }
  if ('location' in p && (p.location || !create)) lines.push(p.location ? t('At {place}', { place: placeWords(p.location) }) : t('Location removed'))
  return lines
}

/** "a task", "a project", … for an entity without a known name. */
const someEntity = (entity: string) => t('{entity, select, task {a task} project {a project} label {a label} section {a section} comment {a comment} view {a view} field {a field} reminder {a reminder} other {an item}}', { entity })
/** "New task", "New view", … for a proposed entity of another kind. */
const newEntity = (entity: string) => t('{entity, select, task {New task} project {New project} label {New label} section {New section} comment {New comment} view {New view} field {New field} reminder {New reminder} other {New item}}', { entity })

/** A custom field value change in words: "Cost → 120", "Client cleared" (custom-fields D6). */
export function fieldWords(names: Names, id: string, v: unknown): string {
  const def = names.fields?.get(id)
  const name = def?.name ?? t('A field')
  if (v === null || v === undefined || v === '') return t('{name} cleared', { name })
  const text = def ? formatValue(def, v as FieldValue) : String(v)
  return `${name} → ${clip(text, 60)}`
}

/** Every field change of one proposed change, in words. */
export function describe(c: ProposedChange, local: Record<string, unknown> | undefined, names: Names): { title: string; lines: string[] } {
  const p = c.patch
  const base = { ...(local ?? {}), ...(c.base ?? {}) } as Record<string, unknown>
  const project = (id: unknown) => (id ? names.projects.get(String(id)) ?? t('a project') : t('Inbox'))
  if (c.create) {
    switch (c.entity) {
      case 'project': return { title: t('New project: {name}', { name: String(p.name ?? '') }), lines: [] }
      case 'label': return { title: t('New label: {name}', { name: String(p.name ?? '') }), lines: [] }
      case 'comment': {
        const task = names.tasks.get(String(p.task_id)) ?? t('a task')
        return { title: t('Comment on “{task}”', { task: clip(task, 50) }), lines: [clip(String(p.body ?? ''), 140)] }
      }
      case 'task': {
        const lines: string[] = []
        if (p.due) lines.push(t('Due {date}', { date: dueWords(p.due) }))
        if (p.priority && p.priority !== 4) lines.push(t('Priority P{p}', { p: p.priority as number }))
        if (Array.isArray(p.labels) && p.labels.length) lines.push(t('Labels: {labels}', { labels: p.labels.map((id) => names.labels.get(String(id)) ?? t('a label')).join(', ') }))
        if (p.parent_id) lines.push(t('Subtask of “{task}”', { task: clip(names.tasks.get(String(p.parent_id)) ?? t('a task'), 50) }))
        if (p.deleted_at) lines.push(t('Moved to the Trash'))
        lines.push(...planningLines(p, {}, names, true))
        for (const [f, v] of Object.entries(p)) {
          const fid = fieldValueId(f)
          if (fid && v !== null) lines.push(fieldWords(names, fid, v))
        }
        return { title: t('New task in {project}: {title}', { project: project(p.project_id), title: String(p.title ?? '') }), lines }
      }
    }
    return { title: newEntity(c.entity), lines: [] }
  }
  const title = String((local as { title?: string; name?: string } | undefined)?.title ?? (local as { name?: string } | undefined)?.name ?? someEntity(c.entity))
  const lines: string[] = c.entity === 'task' ? planningLines(p, base, names, false) : []
  for (const [f, v] of Object.entries(p)) {
    const fid = fieldValueId(f)
    if (fid) {
      lines.push(fieldWords(names, fid, v))
      continue
    }
    const old = base[f]
    switch (f) {
      case 'due': lines.push(t('Due {from} → {to}', { from: dueWords(old), to: dueWords(v) })); break
      case 'completed_at': lines.push(v ? t('Completed') : t('Reopened')); break
      case 'priority': lines.push(t('Priority P{from} → P{to}', { from: String(old ?? 4), to: String(v) })); break
      case 'project_id': lines.push(t('Moved from {from} to {to}', { from: project(old), to: project(v) })); break
      case 'section_id': lines.push(v ? t('Section: {name}', { name: names.sections.get(String(v)) ?? t('a section') }) : t('No section')); break
      case 'labels': {
        const before = new Set((old as string[] | null) ?? [])
        const after = new Set((v as string[] | null) ?? [])
        const name = (id: string) => names.labels.get(id) ?? t('a label')
        const add = [...after].filter((x) => !before.has(x)).map((x) => `+${name(x)}`)
        const del = [...before].filter((x) => !after.has(x)).map((x) => `−${name(x)}`)
        lines.push(t('Labels: {labels}', { labels: [...add, ...del].join(', ') || t('unchanged') }))
        break
      }
      case 'title': case 'name': lines.push(t('Renamed “{from}” → “{to}”', { from: clip(String(old ?? ''), 50), to: clip(String(v ?? ''), 50) })); break
      case 'description': lines.push(t('Description changed')); break
      case 'estimate_minutes': lines.push(v ? (old ? t('Estimate {from} min → {to} min', { from: String(old), to: String(v) }) : t('Estimate {to} min', { to: String(v) })) : t('Estimate removed')); break
      case 'recurrence': lines.push(v ? t('Repeats {rule}', { rule: String(v) }) : t('Stops repeating')); break
      case 'deleted_at': lines.push(v ? t('Moved to the Trash') : t('Restored')); break
      case 'parent_id': lines.push(v ? t('Subtask of “{task}”', { task: clip(names.tasks.get(String(v)) ?? t('a task'), 50) }) : t('No longer a subtask')); break
      case 'deadline': case 'start': case 'evening': case 'location':
      case 'blocked_by': if (c.entity !== 'task') lines.push(t('{field} changed', { field: f.replace(/_/g, ' ') })); break
      case 'color': lines.push(t('Colour {name}', { name: String(v) })); break
      case 'position': case 'created_at': case 'notes_doc': break
      default: lines.push(t('{field} changed', { field: f.replace(/_/g, ' ') }))
    }
  }
  return { title, lines }
}

/**
 * Prepares a proposal for review against this device's data: an item whose
 * entity is gone is dropped with a note; one whose current value differs from
 * the value the proposal was planned on is unchecked and marked stale
 * ("changed since proposed").
 */
export async function reviewChangeSet(changes: ProposedChange[]): Promise<Review> {
  const names = await loadNames(changes)
  for (const c of changes) {
    if (c.entity === 'task' && !names.tasks.has(c.entityId)) {
      const task = await db.tasks.get(c.entityId)
      if (task) names.tasks.set(task.id, task.title)
    }
    if (c.entity === 'comment' && c.patch.task_id && !names.tasks.has(String(c.patch.task_id))) {
      const tk = await db.tasks.get(String(c.patch.task_id))
      if (tk) names.tasks.set(tk.id, tk.title)
    }
    // Blockers are named by title (agent-planning-fields D7).
    for (const id of Array.isArray(c.patch.blocked_by) ? (c.patch.blocked_by as string[]) : []) {
      if (names.tasks.has(id)) continue
      const tk = await db.tasks.get(id)
      if (tk) names.tasks.set(tk.id, tk.title)
    }
  }
  const review: Review = { items: [], dropped: [] }
  for (const c of changes) {
    const local = (await tableOf(c.entity).get(c.entityId)) as Record<string, unknown> | undefined
    if (!c.create && (!local || local.deleted_at)) {
      const { title } = describe(c, undefined, names)
      const what = title === someEntity(c.entity) ? title.charAt(0).toUpperCase() + title.slice(1) : `“${title}”`
      review.dropped.push(t('{what} is no longer on this device, so its change was left out.', { what }))
      continue
    }
    let stale = false
    if (!c.create) {
      for (const [f, b] of Object.entries(c.base ?? {})) {
        if (!sameValue(local ? readField(local, f) : undefined, b)) stale = true
      }
    }
    const { title, lines } = describe(c, local, names)
    review.items.push({ change: c, state: stale ? 'stale' : 'ok', checked: !stale, title, lines, shared: !!c.shared })
  }
  return review
}

/** Re-checks a review before applying (another device may have synced meanwhile). */
export async function refreshReview(r: Review): Promise<Review> {
  const fresh = await reviewChangeSet(r.items.map((i) => i.change))
  const wasChecked = new Map(r.items.map((i) => [i.change.entity + i.change.entityId, i.checked]))
  for (const i of fresh.items) {
    if (i.state === 'ok') i.checked = wasChecked.get(i.change.entity + i.change.entityId) ?? true
  }
  return { items: fresh.items, dropped: [...r.dropped, ...fresh.dropped.filter((d) => !r.dropped.includes(d))] }
}

// ------------------------------------------------------------------ apply and undo


/** Applies a proposal as one batch with device assistant:<device-id>, undoable in one step (lib/undo.ts). */
export async function applyChanges(changes: ProposedChange[]): Promise<AssistantUndo | null> {
  return applyBatch(changes, { source: 'assistant', origin: 'assistant' })
}

export type { UndoResult }

/** Undoes one applied change set (lib/undo.ts). */
export async function undoChanges(id: string): Promise<UndoResult> {
  return undoBatch(id)
}

// ------------------------------------------------------------------ auto-apply

/**
 * Fields auto-apply may touch (design D2): small, reversible and never a move.
 * Moves always need review: text in a shared task could otherwise move private
 * tasks into a shared project, where other members would see them.
 */
export const AUTO_FIELDS = new Set(['completed_at', 'due', 'priority', 'labels'])
export const AUTO_MAX = 3

/** Whether a proposal may skip review when auto-apply is on. */
export function autoApplicable(changes: ProposedChange[]): boolean {
  if (changes.length === 0 || changes.length > AUTO_MAX) return false
  return changes.every((c) => !c.create && c.entity === 'task' && Object.keys(c.patch).every((f) => AUTO_FIELDS.has(f)))
}

const AUTO_KEY = 'assistant.autoApply'

/** Per device, off by default. */
export async function getAutoApply(): Promise<boolean> {
  try {
    return await getMeta<boolean>(AUTO_KEY, false)
  } catch {
    return false
  }
}

export async function setAutoApply(on: boolean): Promise<void> {
  await setMeta(AUTO_KEY, on)
}

// ------------------------------------------------------------------ threads (device only)

export const THREAD_KEEP = 50
export const THREAD_DAYS = 30

/** Saves a conversation on this device and applies retention (50 threads, 30 days). */
export async function saveThread(item: AssistantThread): Promise<void> {
  await db.assistantThreads.put(item)
  await pruneThreads()
}

export async function pruneThreads(now = Date.now()): Promise<void> {
  const cutoff = now - THREAD_DAYS * 86_400_000
  const old = await db.assistantThreads.where('updated_at').below(cutoff).primaryKeys()
  if (old.length) await db.assistantThreads.bulkDelete(old)
  const keys = await db.assistantThreads.orderBy('updated_at').reverse().primaryKeys()
  if (keys.length > THREAD_KEEP) await db.assistantThreads.bulkDelete(keys.slice(THREAD_KEEP))
}

export async function listThreads(): Promise<AssistantThread[]> {
  return db.assistantThreads.orderBy('updated_at').reverse().toArray()
}

export async function clearThreads(): Promise<void> {
  await db.assistantThreads.clear()
}

export function newThread(provider: string): AssistantThread {
  const now = Date.now()
  return { id: uuid(), title: t('New conversation'), messages: [], created_at: now, updated_at: now, provider, usage: { input: 0, output: 0 } }
}

// ------------------------------------------------------------------ messages

/** The panel's words for refused turns and stream errors. */
export function describeTurnError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'consent_required': return t('Accept the disclosure first: the assistant sends task content to the model provider only after you agree.')
      case 'encryption_enabled': return t('The assistant can’t read end-to-end encrypted tasks. Your tasks never leave your devices unencrypted.')
      case 'assistant_quota': return err.message.charAt(0).toUpperCase() + err.message.slice(1) + '.'
      case 'turn_in_progress': return t('Another answer is still being written. Wait for it or stop it first.')
      case 'assistant_busy': return t('The assistant is busy on this server. Try again in a few seconds.')
      case 'too_large': return t('This conversation is too long. Start a new conversation.')
      case 'not_found': return t('The assistant is not enabled on this server.')
      case 'demo_restricted': return t('The assistant is not available on the demo instance.')
      case 'no_key': return t('No API key is configured for this provider. Ask the server owner.')
    }
    return err.message
  }
  return t('The server is unreachable. The assistant needs a connection.')
}

export function describeStreamError(code: string, message: string): string {
  switch (code) {
    case 'provider_auth': return t('The model provider rejected the API key. The server owner can check it in Settings → Integrations → Assistant.')
    case 'provider_rate_limited': return t('The model provider is rate limiting requests. Try again in a moment.')
    case 'timeout': return t('The answer took too long and was stopped.')
    // On-device turns (assistant-on-device D9).
    case 'device_auth': return t('The provider rejected the API key saved on this device. Change it with “Change provider or key” or in Settings → Integrations → Assistant.')
    case 'device_blocked': return t('This page could not reach the provider. If the server owner allowed it a moment ago, reload the page. A model server must also allow requests from this app’s address.')
  }
  return message ? message.charAt(0).toUpperCase() + message.slice(1) + '.' : t('The model provider could not answer.')
}

/** "1,240 tokens · this month 18% of your limit". */
export function usageLine(u: { input: number; output: number; month_total?: number; cap?: number; own_key?: boolean }): string {
  const n = u.input + u.output
  if (!u.cap) return u.own_key ? t('{n, plural, one {# token · your key} other {# tokens · your key}}', { n }) : t('{n, plural, one {# token} other {# tokens}}', { n })
  const pct = Math.min(100, Math.round(((u.month_total ?? 0) / u.cap) * 100))
  return t('{n, plural, one {# token · this month {pct}% of your limit} other {# tokens · this month {pct}% of your limit}}', { n, pct })
}

export type { Task }
export type { AssistantMessage, AssistantThread } from './db'
