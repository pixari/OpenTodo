// The assistant panel's state (in-app-assistant, assistant-skills), split out of
// AssistantPanel by web-component-structure: the thread on this device, consent,
// the composer's draft, skill and pasted material, the streamed turn and the review
// of proposed changes. The panel component only renders what this returns.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import {
  applyChanges, autoApplicable, clearThreads, describeStreamError, describeTurnError, getAutoApply, listThreads, newThread,
  refreshReview, reviewChangeSet, saveThread, streamTurn, turnMessages, undoChanges, type AssistantMessage, type AssistantThread, type Review, type TurnRequest,
} from '../../lib/assistant'
import { assistantStatus, refreshAssistantStatus, setAssistantStatus, takeAssistantPrefill, useAssistantPrefill, type AssistantPrefill, type AssistantStatus } from '../../lib/assistantStatus'
import { useAssistantSkills, workday, type AssistantSkill } from '../../lib/assistantSkills'
import type { ProposedChange, TurnEvent } from '../../lib/assistantTypes'
import { t } from '../../lib/i18n'
import type { ReviewResult } from './ChangeSetReview'
import { useSentenceAnnouncer } from './useSentenceAnnouncer'
import { useDeviceAssistant, withDevice } from './useDeviceAssistant'

export interface ConversationOptions {
  /** Light context for the turn: the current view and selected tasks. */
  context: () => { view?: string; selected?: string[]; projectId?: string }
  onApplied: (r: { text: string; undoId: string }) => void
  /** The person's name for an on-device turn's instructions (the server uses the account's). */
  userName?: string
}

type Streaming = { text: string; status: string[] }

/** The assistant's message of one turn, the change set it proposed, and the error that ended it early, if any. */
interface StreamedAnswer {
  answer: AssistantMessage
  proposal: ProposedChange[] | null
  failure?: { err: unknown }
}

/**
 * One streamed turn: text, status lines, usage, the proposed change set and the
 * stop reason, gathered into the assistant's message. A failed or stopped stream
 * keeps what arrived before it ended.
 */
type TurnRunner = (req: TurnRequest, onEvent: (e: TurnEvent) => void, signal?: AbortSignal) => Promise<void>

async function streamAnswer(req: TurnRequest, signal: AbortSignal, on: { text: (delta: string, all: string, status: string[]) => void; status: (line: string, all: string, lines: string[]) => void }, run: TurnRunner = streamTurn): Promise<StreamedAnswer> {
  let text = ''
  const statusLines: string[] = []
  let proposal: ProposedChange[] | null = null
  let failure: StreamedAnswer['failure']
  const answer: AssistantMessage = { role: 'assistant', text: '', at: Date.now() }
  try {
    await run(req, (ev: TurnEvent) => {
      switch (ev.type) {
        case 'text':
          text += ev.text
          on.text(ev.text, text, statusLines)
          break
        case 'status':
          statusLines.push(ev.text)
          on.status(ev.text, text, [...statusLines])
          break
        case 'usage':
          answer.usage = { input: ev.input, output: ev.output, month_total: ev.month_total, cap: ev.cap, own_key: ev.own_key }
          break
        case 'changeset':
          proposal = ev.items
          break
        case 'error':
          answer.error = describeStreamError(ev.code, ev.message)
          break
        case 'done':
          answer.stop = ev.stop_reason
          if (ev.stop_reason === 'refusal') text = ''
          if (ev.message && ev.stop_reason !== 'max_tokens') answer.error = ev.message
          break
      }
    }, signal)
  } catch (err) {
    failure = { err }
  }
  answer.text = text
  return { answer, proposal, failure }
}

/** The composer's draft, chosen skill and pasted material, and prefills from elsewhere (assistant-skills D4). */
function useComposerState() {
  const [draft, setDraft] = useState('')
  const skills = useAssistantSkills()
  const [skill, setSkill] = useState<AssistantSkill | null>(null)
  const [pickedSkillId, setPickedSkillId] = useState<string | null>(null)
  const [pasted, setPasted] = useState<string | null>(null)
  const selectedFor = useRef<string[] | null>(null)
  // The same selection as state, for the tray's context chip (assistant-surface D3).
  const [selection, setSelection] = useState<string[] | null>(null)
  const [autoSend, setAutoSend] = useState(false)
  // Opened from the composer, the Ask screen or a task's menu (assistant-skills D4).
  const pendingPrefill = useAssistantPrefill()
  const applyPrefill = useCallback((p: AssistantPrefill | null) => {
    if (!p) return
    if (p.text !== undefined) setDraft(p.text)
    setPickedSkillId(p.skill ?? null)
    setPasted(p.pasted ?? null)
    selectedFor.current = p.selected ?? null
    setSelection(p.selected ?? null)
    setAutoSend(!!p.send)
  }, [])
  useEffect(() => { applyPrefill(takeAssistantPrefill()) }, [applyPrefill, pendingPrefill])
  useEffect(() => {
    if (!pickedSkillId) { setSkill(null); return }
    const found = skills.find((x) => x.id === pickedSkillId)
    if (found) setSkill(found)
  }, [pickedSkillId, skills])
  const chooseSkill = (sk: AssistantSkill | null) => { setPickedSkillId(sk?.id ?? null); setSkill(sk) }
  const clearSelection = () => { selectedFor.current = null; setSelection(null) }
  return { draft, setDraft, skills, skill, setSkill, pickedSkillId, chooseSkill, pasted, setPasted, selectedFor, selection, clearSelection, autoSend, setAutoSend }
}

/** Accepting the provider's terms (in-app-assistant consent), with an optional own key. */
function useConsent(status: AssistantStatus | null, setStatus: (s: AssistantStatus | null) => void) {
  const [consentBusy, setConsentBusy] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const accept = async (ownKey?: string) => {
    if (!status) return
    setConsentBusy(true)
    setConsentError(null)
    try {
      // On a device the consent names the device's provider (assistant-on-device D6); no key goes to the server.
      const next = status.mode === 'device'
        ? await api.setMyAssistant({ consent: true, provider: `device:${status.provider}` })
        : await api.setMyAssistant({ consent: true, provider: status.provider, ...(ownKey ? { own_key: ownKey } : {}) })
      setAssistantStatus(next)
      setStatus(next)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'provider_changed') {
        setStatus(await refreshAssistantStatus())
        setConsentError(t('The provider changed while you were reading. Read the updated text and accept again.'))
      } else setConsentError(describeTurnError(err))
    } finally {
      setConsentBusy(false)
    }
  }
  return { consentBusy, consentError, accept }
}

/** The review of a proposed change set: apply the checked items, discard, undo. */
function useReview(thread: AssistantThread | null, note: (x: AssistantThread, text: string) => Promise<void>, announce: (s: string) => void, onApplied: ConversationOptions['onApplied']) {
  const [review, setReview] = useState<Review | null>(null)
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const reviewRef = useRef<HTMLDivElement>(null)
  const apply = async () => {
    if (!review || !thread || reviewBusy) return
    setReviewBusy(true)
    try {
      // Another device may have synced since the proposal arrived.
      const fresh = await refreshReview(review)
      const newlyStale = fresh.items.some((i) => i.state === 'stale' && review.items.find((o) => o.change.entityId === i.change.entityId)?.state === 'ok')
      if (newlyStale) {
        setReview(fresh)
        announce(t('Some items changed since they were proposed and were unchecked. Review and apply again.'))
        return
      }
      const chosen = fresh.items.filter((i) => i.checked).map((i) => i.change)
      const undo = await applyChanges(chosen)
      const res: ReviewResult = { applied: chosen.length, total: fresh.items.length, undoId: undo?.id ?? null }
      setReview(null)
      setResult(res)
      const summary = res.applied === res.total ? t('{n, plural, one {# change applied.} other {# changes applied.}}', { n: res.applied }) : t('{n} of {total} changes applied.', { n: res.applied, total: res.total })
      await note(thread, summary)
      announce(`${summary} ${t('Undo is available.')}`)
      if (undo) onApplied({ text: t('Assistant: {summary}', { summary }), undoId: undo.id })
    } finally {
      setReviewBusy(false)
    }
  }
  const discard = async () => {
    if (!review || !thread) return
    setReview(null)
    setResult({ applied: 0, total: review.items.length, undoId: null, discarded: true })
    await note(thread, t('Proposal discarded.'))
    announce(t('Proposal discarded.'))
  }
  const undo = async () => {
    if (!result?.undoId || !thread) return
    setReviewBusy(true)
    try {
      const u = await undoChanges(result.undoId)
      setResult({ ...result, undone: u })
      await note(thread, u.skipped.length ? t('Undone, except: {items}.', { items: u.skipped.join(', ') }) : t('Undone.'))
      announce(t('Undone: {n} restored.', { n: u.restored }))
    } finally {
      setReviewBusy(false)
    }
  }
  const toggle = (i: number, c: boolean) => setReview((r) => r && { ...r, items: r.items.map((it, j) => (j === i ? { ...it, checked: c } : it)) })
  return { review, setReview, result, setResult, reviewBusy, reviewRef, apply, discard, undo, toggle }
}

export function useAssistantConversation({ context, onApplied, userName = '' }: ConversationOptions) {
  // The cached status renders at once (offline too); a fresh one follows.
  const [serverStatus, setStatus] = useState<AssistantStatus | null>(assistantStatus)
  // An encrypted account in device mode takes provider, model and consent from this device (assistant-on-device).
  const device = useDeviceAssistant(serverStatus)
  const status = withDevice(serverStatus, device.setup)
  const [thread, setThread] = useState<AssistantThread | null>(null)
  const [threads, setThreads] = useState<AssistantThread[] | null>(null)
  const composer = useComposerState()
  const [streaming, setStreaming] = useState<Streaming | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusAnnounce, setStatusAnnounce] = useState('')
  const live = useSentenceAnnouncer()
  const abort = useRef<AbortController | null>(null)
  const consent = useConsent(status, setStatus)

  useEffect(() => {
    void refreshAssistantStatus().then(setStatus)
    void listThreads().then((all) => setThread((cur) => cur ?? all[0] ?? newThread('')))
    return () => abort.current?.abort()
  }, [])

  const persist = useCallback(async (item: AssistantThread) => {
    setThread(item)
    await saveThread(item).catch(() => {})
  }, [])
  const note = async (x1: AssistantThread, text: string) => {
    const msgs = [...x1.messages]
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, note: text }
    await persist({ ...x1, messages: msgs, updated_at: Date.now() })
  }
  const rv = useReview(thread, note, setStatusAnnounce, onApplied)

  /** Auto-apply a small, fully fresh change set when the person turned that on; otherwise offer it for review. */
  const offer = async (entry: AssistantThread, items: ProposedChange[]) => {
    const r = await reviewChangeSet(items)
    if (r.items.length && (await getAutoApply()) && r.items.every((i) => i.state === 'ok') && autoApplicable(r.items.map((i) => i.change))) {
      const undo = await applyChanges(r.items.map((i) => i.change))
      const res: ReviewResult = { applied: r.items.length, total: r.items.length, undoId: undo?.id ?? null, auto: true }
      rv.setResult(res)
      await note(entry, t('{n, plural, one {# change applied automatically.} other {# changes applied automatically.}}', { n: res.applied }))
      if (undo) onApplied({ text: t('{n, plural, one {Assistant: # change applied.} other {Assistant: # changes applied.}}', { n: res.applied }), undoId: undo.id })
      setStatusAnnounce(t('{n, plural, one {# change applied automatically. Undo is available.} other {# changes applied automatically. Undo is available.}}', { n: res.applied }))
    } else {
      rv.setReview(r)
      setStatusAnnounce(t('{n, plural, one {# proposed change to review below.} other {# proposed changes to review below.}}', { n: r.items.length }))
    }
  }

  const send = async () => {
    const { draft, skill: chosen, pasted } = composer
    // A skill or pasted material can be sent without typed text.
    const question = draft.trim() || (chosen ? chosen.example : pasted ? t('Use the pasted text.') : '')
    if (!question || streaming) return
    const material = pasted
    const selection = composer.selectedFor.current
    // The latest thread may still be loading from the device: start a new one then.
    const current = thread ?? newThread(status?.provider ?? '')
    composer.setDraft('')
    composer.setSkill(null)
    composer.setPasted(null)
    composer.clearSelection()
    setError(null)
    rv.setReview(null)
    rv.setResult(null)
    live.reset()
    const userMsg: AssistantMessage = { role: 'user', text: question, at: Date.now(),
      ...(chosen ? { skill: chosen.name } : {}), ...(material ? { pastedLines: material.split(/\r?\n/).length } : {}) }
    const history = current.messages
    let entry: AssistantThread = { ...current, messages: [...history, userMsg], updated_at: Date.now(), provider: status?.provider ?? '',
      title: current.messages.length ? current.title : question.slice(0, 60) }
    await persist(entry)
    const ctl = new AbortController()
    abort.current = ctl
    setStreaming({ text: '', status: [] })
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    let streamed: StreamedAnswer
    try {
      // projectId only drives the panel's kept-away line; the server never gets it.
      const ctx = { ...context() }
      delete ctx.projectId
      const req: TurnRequest = { messages: turnMessages(history, question, material ?? undefined), timezone: zone, ...ctx,
        ...(selection ? { selected: selection } : {}),
        ...(chosen ? { skill: chosen.id, workday: await workday() } : {}) }
      // Device mode runs the loop here and calls the provider directly; the server sees nothing (assistant-on-device D7).
      const setup = device.setup
      const run = status?.mode === 'device' && setup
        ? await import('../../lib/assistantDevice/loop').then(({ runDeviceTurn }) => (r: TurnRequest, on: (e: TurnEvent) => void, sig?: AbortSignal) => runDeviceTurn(r, on, sig, { setup, userName }))
        : undefined
      streamed = await streamAnswer(req, ctl.signal, {
        text: (delta, text, lines) => { live.push(delta); setStreaming({ text, status: lines }) },
        status: (line, text, lines) => { setStatusAnnounce(line); setStreaming({ text, status: lines }) },
      }, run)
    } catch (err) {
      streamed = { answer: { role: 'assistant', text: '', at: Date.now() }, proposal: null, failure: { err } }
    }
    let { answer } = streamed
    if (streamed.failure) {
      const { err } = streamed.failure
      if (ctl.signal.aborted) answer.note = t('Stopped.')
      else {
        answer.error = describeTurnError(err)
        if (err instanceof ApiError && (err.code === 'consent_required' || err.code === 'encryption_enabled')) setStatus(await refreshAssistantStatus())
      }
    }
    abort.current = null
    // A refusal shows the fixed message and no partial text (design D5).
    answer = { ...answer, text: answer.stop === 'refusal' ? '' : answer.text }
    live.flush()
    if (answer.error) live.setAnnounce(answer.error)
    setStreaming(null)
    entry = { ...entry, messages: [...entry.messages, answer], updated_at: Date.now(),
      usage: { input: entry.usage.input + (answer.usage?.input ?? 0), output: entry.usage.output + (answer.usage?.output ?? 0) } }
    await persist(entry)
    const items = answer.stop === 'end_turn' ? streamed.proposal : null
    if (items && items.length) await offer(entry, items)
  }

  const startNew = () => {
    abort.current?.abort()
    setThread(newThread(status?.provider ?? ''))
    rv.setReview(null)
    rv.setResult(null)
    setThreads(null)
    setError(null)
  }
  const toggleThreads = async () => setThreads(threads ? null : await listThreads())
  const clearAll = async () => {
    await clearThreads()
    startNew()
  }
  const pickThread = (id: string) => {
    void listThreads().then((all) => {
      const item = all.find((x) => x.id === id)
      if (item) { setThread(item); setThreads(null); rv.setReview(null); rv.setResult(null) }
    })
  }

  return {
    status, device, thread, threads, toggleThreads, clearAll, composer, streaming, error, statusAnnounce, live, abort, consent, review: rv,
    send, startNew, pickThread, stop: () => abort.current?.abort(),
  }
}
