// Wire types of the in-app assistant routes (OpenSpec `in-app-assistant`).
import type { Entity } from './types'

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'compatible'
export const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'gemini', 'compatible']

export interface ProviderView {
  enabled: boolean
  model: string
  key_set: boolean
  label: string
  base_url?: string
}

/** The owner's view of GET/PUT /api/v1/settings/assistant: presence flags, never keys. */
export interface AssistantOwnerSettings {
  enabled: boolean
  active: boolean
  providers: Record<ProviderName, ProviderView>
  default_provider: ProviderName
  allow_member_keys: boolean
  monthly_token_cap_per_user: number
  allow_private_endpoint: boolean
  anthropic_models: string[]
  default_model: string
  /** assistant-member-provider (absent on older servers). */
  cap_member_keys?: boolean
  member_providers?: ProviderName[]
  /** Accounts whose turns use their own provider and key. */
  own_key_members?: number
  /** The on-device assistant for encrypted accounts (assistant-on-device D2). */
  device?: DeviceSettings
  /** The API origin of each built-in provider (what the page's policy adds). */
  device_origins?: Record<string, string>
}

export interface DeviceSettings {
  enabled: boolean
  providers: ProviderName[]
  origins: string[]
}

/** What a member reads from the same route. */
export interface AssistantMemberSettings {
  enabled: boolean
  provider: ProviderName
  provider_label: string
  model: string
  allow_member_keys: boolean
  monthly_token_cap_per_user: number
  cap_member_keys?: boolean
}

export interface AssistantSettingsInput {
  enabled?: boolean
  providers?: Partial<Record<ProviderName, { enabled: boolean; model: string; base_url?: string }>>
  default_provider?: ProviderName
  allow_member_keys?: boolean
  monthly_token_cap_per_user?: number
  allow_private_endpoint?: boolean
  cap_member_keys?: boolean
  device?: DeviceSettings
  /** A value sets the key, "" clears it, absent keeps it. */
  keys?: Partial<Record<ProviderName, string>>
}

/** The owner's on-screen values for one provider sent with "Test connection"; absent fields use the saved settings. */
export interface AssistantTestDraft {
  model?: string
  base_url?: string
  /** Absent: the saved key; "": no key; otherwise used for this test only. */
  key?: string
  allow_private_endpoint?: boolean
}

/** A member's on-screen provider, model and key sent with "Test connection". */
export interface MyAssistantTestDraft {
  provider?: string
  model?: string
  key?: string
}

export interface AssistantTestResult {
  ok: boolean
  code?: string
  message?: string
  status?: number
}

export interface AssistantUsage {
  month: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  turns: number
  cap: number
  resets_at: string
  /** assistant-member-provider: what counts toward `cap`, and the turns on your own key. */
  counted_tokens?: number
  cap_member_keys?: boolean
  own_key?: { input_tokens: number; output_tokens: number; total_tokens: number; turns: number }
}

/** PUT /api/v1/me/assistant. */
export interface MyAssistantInput {
  consent?: boolean
  provider?: string
  /** A value sets your key (for your own provider when one is chosen), "" removes it. */
  own_key?: string
  /** Your own provider (anthropic, openai, gemini); "" goes back to the server's assistant. */
  own_provider?: string
  own_model?: string
}

/** Providers a member may choose for their own key. */
export const MEMBER_PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'gemini']
/** Model ids a member may type for OpenAI and Gemini (the server checks the same). */
export const MEMBER_MODEL_RE = /^[A-Za-z0-9._:-]{1,100}$/

/** One proposed entity change (agenttools.Change plus the shared mark). */
export interface ProposedChange {
  entity: Entity
  entityId: string
  create?: boolean
  patch: Record<string, unknown>
  base?: Record<string, unknown>
  shared?: boolean
}

export type TurnEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string }
  | { type: 'changeset'; items: ProposedChange[]; limit: number }
  | { type: 'usage'; input: number; output: number; month_total: number; cap: number; own_key?: boolean }
  | { type: 'done'; stop_reason: string; message?: string; server_time?: string }
  | { type: 'error'; code: string; message: string }

export function isOwnerSettings(s: AssistantOwnerSettings | AssistantMemberSettings | null): s is AssistantOwnerSettings {
  return !!s && 'providers' in s
}
