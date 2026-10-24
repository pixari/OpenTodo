// In-app assistant (OpenSpec change `in-app-assistant`): the part the main
// chunk carries, the status that decides whether the launcher and the Shift+I
// shortcut are offered, and the open/close signal. Everything else (panel,
// stream client, review, apply, undo) is in the lazy assistant chunk.
import { useSyncExternalStore } from 'react'
import { api, ApiError } from './api'
import { getMeta, setMeta } from './db'

/** GET /api/v1/me/assistant: what this account may do; never a key. */
export interface AssistantStatus {
  available: boolean
  /** The owner enabled the assistant with a provider. */
  enabled: boolean
  /** Why it is not available: off, no provider, an encrypted account, or the demo instance. */
  reason: '' | 'disabled' | 'no_provider' | 'encryption_enabled' | 'demo'
  provider: string
  provider_label: string
  model: string
  consented: boolean
  consent?: { accepted_at: number; disclosure_version: number; provider: string }
  disclosure_version: number
  /** What the disclosure says may be sent. */
  fields: string[]
  allow_member_keys: boolean
  /** A key of yours is stored for `provider`. */
  own_key_set: boolean
  operator_key_set: boolean
  // assistant-member-provider (absent on older servers):
  /** `own` when turns use the provider you chose with your key; `provider`, `provider_label` and `model` then name it. */
  source?: 'server' | 'own'
  /** Turns run on your own key (your provider, or a key you stored for the server's provider). */
  own_key_in_use?: boolean
  /** The owner's provider and model. */
  server_provider?: string
  server_provider_label?: string
  server_model?: string
  /** A key of yours is stored for the server's provider (used with the server's assistant). */
  server_own_key_set?: boolean
  /** Your own provider choice, kept while the owner does not allow member keys. */
  own_provider?: OwnProviderView | null
  /** Providers you may choose (never the compatible endpoint). */
  member_providers?: string[]
  anthropic_models?: string[]
  /** Turns on members' own keys count toward the monthly limit. */
  cap_member_keys?: boolean
  // assistant-on-device (absent on older servers):
  /** `device` when this encrypted account runs the assistant on its own device. */
  mode?: 'server' | 'device' | ''
  /** For an encrypted account: what the owner allows devices to call, and the device consent. */
  device?: DeviceAllowance | null
}

/** What the owner allows an encrypted account's devices (assistant-on-device D2, D6). */
export interface DeviceAllowance {
  available: boolean
  providers: string[]
  origins: string[]
  /** The provider the person consented to for the device, or "". */
  consented_provider: string
  anthropic_models: string[]
  default_model: string
}

export interface OwnProviderView {
  provider: string
  provider_label: string
  model: string
  key_set: boolean
}

const KEY = 'assistant.status'
let status: AssistantStatus | null = null
let open = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const DEMO_STATUS: AssistantStatus = {
  available: false, enabled: false, reason: 'demo', provider: '', provider_label: '', model: '', consented: false,
  disclosure_version: 0, fields: [], allow_member_keys: false, own_key_set: false, operator_key_set: false,
}

/** Fetches the status (cached on the device for offline launches; cleared at sign-out with meta). */
export async function refreshAssistantStatus(): Promise<AssistantStatus | null> {
  try {
    setAssistantStatus(await api.getMyAssistant())
  } catch (err) {
    if (err instanceof ApiError && err.code === 'demo_restricted') setAssistantStatus(DEMO_STATUS)
    else if (status === null) {
      try {
        status = await getMeta<AssistantStatus | null>(KEY, null)
        emit()
      } catch {
        // Offline and nothing cached: no launcher.
      }
    }
  }
  return status
}

export function setAssistantStatus(next: AssistantStatus): void {
  // Unchanged status: no re-render of the shell (the header stays put).
  if (status && JSON.stringify(status) === JSON.stringify(next)) return
  status = next
  emit()
  // Write the offline copy only when it differs, so other live queries on the
  // meta table are not woken on every launch.
  void getMeta<AssistantStatus | null>(KEY, null)
    .then((cached) => (JSON.stringify(cached) === JSON.stringify(next) ? undefined : setMeta(KEY, next)))
    .catch(() => {})
}

export function assistantStatus(): AssistantStatus | null {
  return status
}

export function useAssistantStatus(): AssistantStatus | null {
  return useSyncExternalStore(subscribe, () => status, () => status)
}

/**
 * The launcher and the shortcut are offered when the owner turned the
 * assistant on (an encrypted account gets them too, to read why it is
 * unavailable); never on a fresh server or the demo.
 */
export function showLauncher(s: AssistantStatus | null): boolean {
  return !!s && s.enabled && s.reason !== 'demo'
}

export function openAssistant(): void {
  open = true
  emit()
}

/** What the panel starts with when opened from the composer, the Ask screen or a task menu (assistant-skills D4). */
export interface AssistantPrefill {
  text?: string
  skill?: string
  /** Text the user pasted; sent as untrusted material. */
  pasted?: string
  /** Send at once (Enter in a composer) instead of waiting in the panel's input. */
  send?: boolean
  /** Task ids the turn is about (Break this down from a task's menu). */
  selected?: string[]
}

let prefill: AssistantPrefill | null = null

/** Opens the panel with text, a skill or pasted material filled in. */
export function openAssistantWith(p: AssistantPrefill): void {
  prefill = p
  open = true
  emit()
}

/** The pending prefill, once: the panel takes it when it opens. */
export function takeAssistantPrefill(): AssistantPrefill | null {
  const p = prefill
  prefill = null
  return p
}

/** A prefill waiting for an already open panel. */
export function useAssistantPrefill(): AssistantPrefill | null {
  return useSyncExternalStore(subscribe, () => prefill, () => prefill)
}

export function closeAssistant(): void {
  open = false
  emit()
}

export function useAssistantOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => open)
}

/** Test hook. */
export function resetAssistantStatus(): void {
  status = null
  open = false
  prefill = null
  emit()
}
