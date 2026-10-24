// The on-device assistant's settings on this device (OpenSpec change
// assistant-on-device, design D5): provider, model, model server address and the
// user's own key, in one record of the local `meta` table. Never synced, never
// sent to the OpenTodo server, deleted at sign-out with the rest of `meta`.
import { getMeta, setMeta } from '../db'

export type DeviceProvider = 'anthropic' | 'openai' | 'gemini' | 'compatible'
export const DEVICE_PROVIDERS: DeviceProvider[] = ['anthropic', 'openai', 'gemini', 'compatible']

export interface DeviceSetup {
  provider: DeviceProvider
  model: string
  /** The model server's base URL (compatible only), e.g. http://localhost:11434/v1. */
  baseUrl?: string
  /** The user's own key; optional for a model server. */
  key?: string
  savedAt: number
}

export const DEVICE_SETUP_KEY = 'assistant.device'

/** Model ids other than Anthropic's (the server checks members' the same way). */
export const MODEL_RE = /^[A-Za-z0-9._:-]{1,100}$/

export async function getDeviceSetup(): Promise<DeviceSetup | null> {
  try {
    return await getMeta<DeviceSetup | null>(DEVICE_SETUP_KEY, null)
  } catch {
    return null
  }
}

export async function saveDeviceSetup(s: DeviceSetup): Promise<void> {
  await setMeta(DEVICE_SETUP_KEY, s)
}

export async function clearDeviceSetup(): Promise<void> {
  await setMeta(DEVICE_SETUP_KEY, null)
}

/** The origin of a URL, or null when it is not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin.toLowerCase()
  } catch {
    return null
  }
}

/** The built-in providers' API base URLs (equal to the manifest's endpoints; a test checks). */
export const ENDPOINTS: Record<Exclude<DeviceProvider, 'compatible'>, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
}

/** The base URL the device sends requests to. */
export function baseUrlOf(s: Pick<DeviceSetup, 'provider' | 'baseUrl'>): string {
  if (s.provider === 'compatible') return (s.baseUrl ?? '').replace(/\/+$/, '')
  return ENDPOINTS[s.provider]
}

export type SetupProblem = 'provider' | 'model' | 'key' | 'base_url' | 'origin'

/** What is wrong with a setup against what the owner allows, or null. */
export function checkSetup(s: Pick<DeviceSetup, 'provider' | 'model' | 'baseUrl' | 'key'>, allowed: { providers: string[]; origins: string[]; anthropic_models: string[] }): SetupProblem | null {
  if (!allowed.providers.includes(s.provider)) return 'provider'
  const model = s.model.trim()
  if (s.provider === 'anthropic' ? !allowed.anthropic_models.includes(model) : !MODEL_RE.test(model)) return 'model'
  if (s.provider !== 'compatible' && !(s.key ?? '').trim()) return 'key'
  if (s.provider === 'compatible') {
    const origin = originOf(s.baseUrl ?? '')
    if (!origin) return 'base_url'
    if (!allowed.origins.map((o) => o.toLowerCase()).includes(origin)) return 'origin'
  }
  return null
}
