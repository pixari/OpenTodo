// @vitest-environment happy-dom
// The on-device assistant in the panel (OpenSpec change assistant-on-device):
// an encrypted account sets up its provider on this device, accepts the device
// disclosure, and a turn runs here against the provider (a fake Anthropic
// stream) with a reviewable proposal; the OpenTodo server gets no turn and no key.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSkills } from '../lib/assistantSkills'
import { openAssistantWith, resetAssistantStatus, setAssistantStatus, type AssistantStatus } from '../lib/assistantStatus'
import { db, getMeta } from '../lib/db'
import { publishEncryption } from '../lib/e2ee'
import { createTask, resetDeviceId } from '../lib/ops'
import { setCurrentUserId } from '../lib/sharing'
import { DEVICE_SETUP_KEY } from '../lib/assistantDevice/settings'
import { click, flush, render, type, waitFor } from '../ui/test-utils'
import { AssistantPanel } from './assistant/AssistantPanel'

const allowance = { available: true, providers: ['anthropic'], origins: [], consented_provider: '', anthropic_models: ['claude-opus-5-5', 'claude-sonnet-5-5'], default_model: 'claude-opus-5-5' }
const base: AssistantStatus = {
  available: true, enabled: true, reason: '', mode: 'device', provider: 'anthropic', provider_label: 'Anthropic (Claude)', model: 'claude-opus-5-5', consented: false,
  disclosure_version: 1, fields: ['task titles and descriptions'], allow_member_keys: false, own_key_set: false, operator_key_set: false, device: allowance,
}

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
const round = (blocks: Record<string, unknown>[], deltas: Record<string, unknown>[], stop: string) => sse([
  { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } },
  ...blocks.map((b, i) => ({ type: 'content_block_start', index: i, content_block: b })),
  ...deltas,
  ...blocks.map((_, i) => ({ type: 'content_block_stop', index: i })),
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 20 } },
])

let server: { method: string; path: string; body: string }[] = []
let provider: { url: string; headers: Record<string, string>; body: string }[] = []
let status = base

beforeEach(async () => {
  await db.delete()
  await db.open()
  resetDeviceId()
  resetAssistantStatus()
  resetSkills([])
  await setCurrentUserId('u1')
  publishEncryption({ enabled: true, unlocked: true })
  status = base
  setAssistantStatus(status)
  server = []
  provider = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.anthropic.com/')) {
      provider.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) })
      const id = JSON.parse(String(init?.body)).messages.length
      const ids = (await db.tasks.toArray()).map((t) => t.id)
      const text = id === 1
        ? round([{ type: 'tool_use', id: 'tu1', name: 'schedule_tasks', input: {} }], [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ ids, due: { date: '2026-10-16' } }) } }], 'tool_use')
        : round([{ type: 'text', text: '' }], [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I proposed moving them to Friday; review it below.' } }], 'end_turn')
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    server.push({ method: init?.method ?? 'GET', path: url, body: String(init?.body ?? '') })
    if (url === '/api/v1/me/assistant' && init?.method === 'PUT') {
      status = { ...status, device: { ...allowance, consented_provider: 'anthropic' } }
      return new Response(JSON.stringify(status), { status: 200 })
    }
    if (url === '/api/v1/me/assistant') return new Response(JSON.stringify(status), { status: 200 })
    if (url === '/api/v1/assistant/skills') return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

const panel = () => render(<AssistantPanel onClose={() => {}} context={() => ({ view: 'today' })} onApplied={() => {}} name="Ada" />)

describe('on-device assistant in the panel', () => {
  it('sets up, asks for consent and runs a turn on this device', async () => {
    await createTask({ title: 'Pay rent', due: { date: '2026-10-10' } })
    await createTask({ title: 'Call Ann', due: { date: '2026-10-11' } })
    openAssistantWith({ text: 'move everything overdue to Friday', send: true })
    const r = await panel()
    await waitFor(() => !!document.querySelector('[data-device-setup]'), 'setup form')
    await type(document.querySelector<HTMLInputElement>('[data-device-setup] input[type="password"]')!, 'sk-ant-device')
    await click(document.querySelector('[data-device-save]')!)
    await waitFor(() => !!document.querySelector('[data-consent-device]'), 'device disclosure')
    expect(document.querySelector('[data-consent-device]')!.textContent).toContain('directly to Anthropic (Claude)')
    expect(await getMeta<{ key?: string } | null>(DEVICE_SETUP_KEY, null)).toMatchObject({ provider: 'anthropic', key: 'sk-ant-device' })
    await click(document.querySelector('[data-assistant-accept]')!)
    await waitFor(() => !!document.querySelector('[data-assistant-review]'), 'proposal')
    expect(document.querySelector('[data-assistant-selected]')!.textContent).toBe('2 of 2 selected')
    // The provider got the turn with the device's key; the server got the consent and nothing else.
    expect(provider).toHaveLength(2)
    expect(provider[0].headers['x-api-key']).toBe('sk-ant-device')
    expect(provider[1].body).toContain('\\"proposed\\":true')
    const put = server.find((x) => x.method === 'PUT')!
    expect(JSON.parse(put.body)).toEqual({ consent: true, provider: 'device:anthropic' })
    expect(server.some((x) => x.path.includes('/assistant/turn'))).toBe(false)
    expect(server.some((x) => x.body.includes('sk-ant-device') || x.body.includes('Pay rent'))).toBe(false)
    // Apply writes through the op log with the assistant's device.
    await click(document.querySelector('[data-assistant-apply]')!)
    await waitFor(async () => (await db.tasks.toArray()).every((t) => t.due?.date === '2026-10-16'), 'applied')
    const ops = await db.outbox.toArray()
    expect(ops.some((o) => o.field === 'due' && String(o.device).startsWith('assistant:'))).toBe(true)
    await waitFor(() => !!document.querySelector('[data-assistant-result]'), 'applied summary')
    await flush(100)
    await r.unmount()
  })

  it('asks to unlock a locked device', async () => {
    publishEncryption({ unlocked: false })
    const r = await panel()
    await waitFor(() => !!document.querySelector('[data-device-locked]'), 'locked note')
    expect(document.querySelector('[data-assistant-composer]')?.hasAttribute('disabled') ?? true).toBe(true)
    await r.unmount()
  })
})
