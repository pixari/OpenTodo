// The on-device assistant's loop (OpenSpec change assistant-on-device, design
// D7): internal/assistant Loop.Run in the browser. Model calls go to the
// provider set up on this device; read tools read this device's decrypted rows;
// write tools only plan into a draft. It emits the same events as the server's
// turn stream, so the panel's review, apply (mutateMany with device
// assistant:<device-id>) and undo are unchanged. It never writes.
import type { ProposedChange, TurnEvent } from '../assistantTypes'
import type { TurnRequest } from '../assistant'
import { ArgError, ToolError, type Args } from './args'
import { loadSnapshot } from './data'
import { manifest, manifestSkill, type ManifestTool } from './manifest'
import { PLANNERS } from './plan'
import { systemPrompt } from './prompt'
import { providerFor, ProviderError, type Fetch, type Message, type Provider, type ToolCall } from './providers'
import { getTask, listProjects, listTasks, searchTasks, todaySummary } from './read'
import type { DeviceSetup } from './settings'

export interface DeviceTurnOptions {
  setup: DeviceSetup
  userName: string
  /** Tests: a fake provider or fetch, and the clock. */
  provider?: Provider
  fetch?: Fetch
  now?: () => number
}

const READERS: Record<string, (snap: Awaited<ReturnType<typeof loadSnapshot>>, a: Args, now: number, max: number) => unknown> = {
  list_projects: (s, a, _n, max) => listProjects(s, a, max),
  list_tasks: listTasks,
  get_task: getTask,
  search_tasks: searchTasks,
  today_summary: todaySummary,
}

/** Every manifest tool with a device implementation (a test checks both ways). */
export const IMPLEMENTED = [...Object.keys(READERS), ...Object.keys(PLANNERS)]

const clip = (s: string) => [...s.slice(0, 64)].filter((ch) => ch >= ' ' && ch !== '\u007f').join('')

/** Pasted text wrapped as untrusted and folded into the user's next message (foldUntrusted). */
export function foldUntrusted(msgs: TurnRequest['messages']): Message[] {
  const out: Message[] = []
  let pending: string[] = []
  for (const m of msgs) {
    if (m.untrusted) { pending.push(JSON.stringify({ untrusted_text: m.text })); continue }
    let text = m.text
    if (m.role === 'user' && pending.length) {
      text = `${manifest.untrusted_note}\n${pending.join('\n')}\n\n${text}`
      pending = []
    }
    out.push({ role: m.role, text })
  }
  if (pending.length && out.length && out[out.length - 1].role === 'user') out[out.length - 1].text += `\n\n${manifest.untrusted_note}\n${pending.join('\n')}`
  return out
}

/** The progress line of a tool call (statusFor). */
export function statusFor(name: string, args: string): string {
  switch (name) {
    case 'today_summary': return 'Looking at Today…'
    case 'list_projects': return 'Looking at your projects…'
    case 'list_tasks': {
      let view = ''
      try { view = (JSON.parse(args) as { view?: string }).view ?? '' } catch { /* the default line */ }
      return view === 'today' ? 'Looking at Today…' : view === 'inbox' ? 'Looking at the Inbox…' : view === 'upcoming' ? 'Looking at Upcoming…' : 'Looking at tasks…'
    }
    case 'get_task': return 'Reading a task…'
    case 'search_tasks': return 'Searching tasks…'
  }
  return 'Preparing changes…'
}

const entityKey = (c: ProposedChange) => `${c.entity}\u0000${c.entityId}`
const countEntities = (cs: ProposedChange[]) => new Set(cs.map(entityKey)).size

/** One call: reads return their result with the notice; writes plan into the draft. */
async function runTool(call: ToolCall, tools: ManifestTool[], draft: ProposedChange[], now: number): Promise<{ content: string; isError: boolean; draft: ProposedChange[] }> {
  const fail = (payload: Record<string, unknown>) => ({ content: JSON.stringify(payload), isError: true, draft })
  const def = tools.find((t) => t.name === call.name)
  if (!def) return fail({ error: 'unknown_tool', message: `there is no tool named ${clip(call.name)}; use only the tools listed` })
  let args: Args
  try {
    const parsed = call.args ? JSON.parse(call.args) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    args = parsed as Args
  } catch {
    return fail({ error: 'invalid_arguments', message: 'arguments: must be an object' })
  }
  try {
    const snap = await loadSnapshot(draft)
    const max = manifest.limits.max_items
    if (def.kind === 'read') {
      const out = (await READERS[def.name](snap, args, now, max)) as Record<string, unknown>
      return { content: JSON.stringify({ ...out, _notice: manifest.notice }), isError: false, draft }
    }
    const plan = PLANNERS[def.name]({ snap, now, overlay: draft }, args)
    const next = [...draft, ...plan.changes]
    const n = countEntities(next)
    const limit = manifest.limits.max_entities
    if (n > limit) {
      return fail({ error: 'proposal_full', message: `one proposal holds at most ${limit} changed items; with this call it would hold ${n}. Nothing from this call was added. Propose at most ${limit} in total now, and tell the user you can continue with the rest after they have reviewed this proposal.`, limit, in_proposal: countEntities(draft) })
    }
    return { content: JSON.stringify({ ...plan.result, _notice: manifest.notice, proposed: true, status_note: 'Proposed, not applied: the user reviews the proposal and confirms it in the app.' }), isError: false, draft: next }
  } catch (err) {
    if (err instanceof ToolError) return fail(err.code ? err.payload() : { error: 'failed', message: err.message })
    if (err instanceof ArgError) return fail({ error: 'invalid_arguments', message: err.message })
    return fail({ error: 'internal', message: 'the tool failed on this device' })
  }
}

/** One change per entity: later values win, the first base of each field is kept (finalise). */
export function finalise(draft: ProposedChange[], shared: (c: ProposedChange) => boolean): ProposedChange[] {
  const out: ProposedChange[] = []
  const index = new Map<string, number>()
  for (const c of draft) {
    let i = index.get(entityKey(c))
    if (i === undefined) {
      i = out.length
      index.set(entityKey(c), i)
      out.push({ entity: c.entity, entityId: c.entityId, ...(c.create ? { create: true } : {}), patch: {} })
    }
    const p = out[i]
    if (c.create) p.create = true
    for (const [f, v] of Object.entries(c.patch)) {
      if (!(f in p.patch) && !p.create && c.base && f in c.base) p.base = { ...(p.base ?? {}), [f]: c.base[f] }
      p.patch[f] = v
    }
  }
  for (const p of out) if (shared(p)) p.shared = true
  const rank: Record<string, number> = { project: 0, label: 1, section: 2, task: 3, comment: 4 }
  return out.map((p, i) => [p, i] as const).sort((a, b) => (rank[a[0].entity] ?? 9) - (rank[b[0].entity] ?? 9) || a[1] - b[1]).map(([p]) => p)
}

/**
 * Runs one turn on this device and reports it through onEvent like the server's
 * stream: text and status while it runs, then usage, the change set and done,
 * or an error. Throws only when aborted.
 */
export async function runDeviceTurn(req: TurnRequest, onEvent: (e: TurnEvent) => void, signal: AbortSignal | undefined, opts: DeviceTurnOptions): Promise<void> {
  const now = opts.now ?? Date.now
  const skill = req.skill ? manifestSkill(req.skill) ?? null : null
  const tools = manifest.tools.filter((t) => !skill || skill.tools.includes(t.name))
  const snap0 = await loadSnapshot()
  const selected = (req.selected ?? []).filter((id) => snap0.byId.has(id))
  const system = systemPrompt({ userName: opts.userName, zone: req.timezone, view: req.view, selected, skill, workday: req.workday ?? null }, now()) + '\n' + manifest.device_note + '\n'
  const provider = opts.provider ?? providerFor(opts.setup, opts.fetch)
  const conv = provider.start({ system, messages: foldUntrusted(req.messages), tools, maxTokens: manifest.limits.max_output_tokens })
  let draft: ProposedChange[] = []
  let input = 0
  let output = 0
  let paused = false
  const usage = () => onEvent({ type: 'usage', input, output, month_total: 0, cap: 0, own_key: true })
  const done = (stop: string, message?: string) => {
    usage()
    onEvent({ type: 'done', stop_reason: stop, ...(message ? { message } : {}) })
  }
  const failed = (code: string, message: string) => {
    usage()
    onEvent({ type: 'error', code, message })
  }
  for (let round = 0; round < manifest.limits.max_rounds; round++) {
    let r
    try {
      r = await conv.next((t) => onEvent({ type: 'text', text: t }), signal)
    } catch (err) {
      if (signal?.aborted) throw err
      // The panel words device failures itself: the key is this device's, and a block may need a reload.
      if (err instanceof ProviderError) return failed(err.code === 'provider_auth' ? 'device_auth' : err.code === 'blocked' ? 'device_blocked' : err.code, err.message)
      return failed('provider_error', 'the provider could not answer')
    }
    input += r.input
    output += r.output
    switch (r.stop) {
      case 'end_turn': {
        const changes = finalise(draft, (c) => {
          const pid = c.entity === 'project' ? c.entityId : String(c.patch.project_id ?? c.base?.project_id ?? snap0.byId.get(c.entity === 'comment' ? String(c.patch.task_id) : c.entityId)?.project_id ?? '')
          return !!pid && snap0.memberships.has(pid)
        })
        usage()
        if (changes.length) onEvent({ type: 'changeset', items: changes, limit: manifest.limits.max_entities })
        onEvent({ type: 'done', stop_reason: 'end_turn' })
        return
      }
      case 'max_tokens': return done('max_tokens', manifest.messages.cut_off)
      case 'refusal': return done('refusal', manifest.messages.refusal)
      case 'pause_turn':
        if (paused) return failed('provider_error', 'the provider paused the answer twice')
        paused = true
        continue
      case 'tool_use': {
        if (round === manifest.limits.max_rounds - 1) break
        if (!r.toolCalls.length) return failed('provider_error', 'the provider asked for a tool without naming one')
        const results = []
        for (const call of r.toolCalls) {
          onEvent({ type: 'status', text: statusFor(call.name, call.args) })
          const res = await runTool(call, tools, draft, now())
          draft = res.draft
          results.push({ id: call.id, content: res.content, isError: res.isError })
        }
        conv.addToolResults(results)
        continue
      }
      default:
        return failed('provider_error', 'the provider ended the answer for an unknown reason')
    }
  }
  done('round_limit', manifest.messages.round_limit)
}
