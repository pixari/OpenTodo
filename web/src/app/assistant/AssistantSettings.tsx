import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { keysOf } from '../../lib/shortcuts'
import { Kbd } from '../shortcuts/Kbd'
import { api, ApiError } from '../../lib/api'
import { clearThreads, getAutoApply, setAutoApply } from '../../lib/assistant'
import { refreshAssistantStatus, setAssistantStatus, type AssistantStatus } from '../../lib/assistantStatus'
import {
  isOwnerSettings, MEMBER_MODEL_RE, MEMBER_PROVIDERS, PROVIDERS, type AssistantMemberSettings, type AssistantOwnerSettings, type AssistantSettingsInput,
  type AssistantTestDraft, type AssistantTestResult, type AssistantUsage, type MyAssistantInput, type MyAssistantTestDraft, type ProviderName,
} from '../../lib/assistantTypes'
import { useOnline } from '../../lib/online'
import { Button, Dialog, StatusIndicator, toneForHue } from '../../ui'
import { Badge } from '../../ui'
import { Field, Input, Select } from '../../ui'
import { ConfirmDialog } from '../../ui'
import { Notice } from '../../ui'
import { SettingRow, SettingsSection } from '../../ui'
import { Checkbox, Switch } from '../../ui'
import { formatDate } from '../../lib/dates'
import { useDateTimeFormat } from '../DateTimePrefsProvider'
import { EncryptionOffHint } from './AssistantPanel'
import { deviceDraftFrom, deviceInputFrom, DeviceUserRows, OwnerDeviceGroup, type OwnerDeviceDraft } from './AssistantDevice'
import { t, msg, translatedMap } from '../../lib/i18n'
import { cardCopy, noticeCopy, rowCopy } from '../../lib/settingsCopy'

const LABEL = translatedMap<ProviderName>({ anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', compatible: msg('Compatible endpoint (Ollama, LM Studio, OpenRouter, …)') })
const SHORT = translatedMap<ProviderName>({ anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', compatible: msg('Compatible endpoint') })
/** Pre-filled suggestions the owner can change; only the Anthropic default is built into the server. */
const MODEL_HINT = translatedMap<ProviderName>({ anthropic: 'claude-opus-5-5', openai: msg('a model id from your OpenAI account'), gemini: msg('a Gemini model id'), compatible: msg('the model name your server serves') })

export interface OwnerDraft {
  enabled: boolean
  default_provider: ProviderName
  providers: Record<ProviderName, { enabled: boolean; model: string; base_url: string }>
  keys: Partial<Record<ProviderName, string>>
  allow_member_keys: boolean
  allow_private_endpoint: boolean
  monthly_token_cap_per_user: number
  cap_member_keys: boolean
  /** The on-device assistant for encrypted accounts (assistant-on-device). */
  device: OwnerDeviceDraft
}

export function draftFrom(s: AssistantOwnerSettings): OwnerDraft {
  const providers = {} as OwnerDraft['providers']
  for (const p of PROVIDERS) providers[p] = { enabled: s.providers[p]?.enabled ?? false, model: s.providers[p]?.model ?? '', base_url: s.providers[p]?.base_url ?? '' }
  return { enabled: s.enabled, default_provider: s.default_provider, providers, keys: {}, allow_member_keys: s.allow_member_keys,
    allow_private_endpoint: s.allow_private_endpoint, monthly_token_cap_per_user: s.monthly_token_cap_per_user, cap_member_keys: !!s.cap_member_keys,
    device: deviceDraftFrom(s.device) }
}

export function inputFrom(d: OwnerDraft): AssistantSettingsInput {
  const providers: AssistantSettingsInput['providers'] = {}
  for (const p of PROVIDERS) {
    const v = d.providers[p]
    providers[p] = p === 'compatible' ? { enabled: v.enabled, model: v.model.trim(), base_url: v.base_url.trim() } : { enabled: v.enabled, model: v.model.trim() }
  }
  const keys: AssistantSettingsInput['keys'] = {}
  for (const [k, v] of Object.entries(d.keys)) if (v !== undefined) keys[k as ProviderName] = v
  return { enabled: d.enabled, default_provider: d.default_provider, providers, keys, allow_member_keys: d.allow_member_keys,
    allow_private_endpoint: d.allow_private_endpoint, monthly_token_cap_per_user: d.monthly_token_cap_per_user, cap_member_keys: d.cap_member_keys,
    device: deviceInputFrom(d.device) }
}

/** The on-screen values "Test connection" sends for one provider (assistant-test-unsaved-settings). */
export function testDraft(d: OwnerDraft, n: ProviderName): AssistantTestDraft {
  const v = d.providers[n]
  const out: AssistantTestDraft = { model: v.model.trim(), allow_private_endpoint: d.allow_private_endpoint }
  if (n === 'compatible') out.base_url = v.base_url.trim()
  if (d.keys[n] !== undefined) out.key = d.keys[n]
  return out
}

/** Whether a test of these values covers settings that are not saved yet. */
export function testIsUnsaved(item: AssistantTestDraft, saved: AssistantOwnerSettings, n: ProviderName): boolean {
  const sp = saved.providers[n]
  return item.key !== undefined || item.model !== (sp?.model ?? '') || (n === 'compatible' && item.base_url !== (sp?.base_url ?? ''))
    || (n === 'compatible' && item.allow_private_endpoint !== saved.allow_private_endpoint)
}

export const SAVE_TO_USE = msg('Connection works. Save to use these settings.')

export interface OwnerViewProps {
  saved: AssistantOwnerSettings
  draft: OwnerDraft
  connected: boolean
  busy: boolean
  error: string | null
  message: string | null
  tests: Partial<Record<ProviderName, AssistantTestResult | 'running'>>
  /** The values each shown result was tested with; a result whose values have changed since is hidden. */
  testedWith?: Partial<Record<ProviderName, string>>
  onChange: (d: OwnerDraft) => void
  onSave: () => void
  onTest: (p: ProviderName) => void
}

function TestResult({ test }: { test: AssistantTestResult | 'running' | undefined | null }) {
  if (!test) return null
  if (test === 'running') return <Notice>{t('Testing…')}</Notice>
  return <Notice tone={test.ok ? 'success' : 'danger'}>{test.ok ? test.message : `${test.message}${test.code ? ` (${test.code})` : ''}`}</Notice>
}

/** The owner's configuration, shown in the Configure dialog: providers, keys, models, base URL, network, caps. */
/** A titled group of the owner's form ("Provider", "Limits"). */
function FormGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4" data-assistant-group={title}>
      <h3 className="text-body font-semibold text-default">{title}</h3>
      {children}
    </section>
  )
}

/** A titled group of the card's rows ("For everyone on this server", "For you"). */
function CardGroup({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="pt-3" aria-labelledby={id} data-assistant-card-group={id}>
      <h3 id={id} className="text-meta font-medium uppercase text-muted">{title}</h3>
      {children}
    </section>
  )
}

/** The card's status line (in-app-assistant "Assistant card structure"). */
export function assistantStatusLine(s: AssistantStatus | null): string | null {
  if (!s) return null
  if (!s.enabled) return t('Off: the owner has not turned it on')
  if (s.reason === 'encryption_enabled') return t('Off for your account: end-to-end encryption is on')
  if (s.mode === 'device') return t('On for your account, from your own device')
  return s.source === 'own' ? t('On, using your own key') : t('On for everyone')
}

/** The month's usage as a bar with the numbers. */
function UsageMeter({ u }: { u: AssistantUsage }) {
  const counted = u.counted_tokens ?? u.total_tokens
  const pct = u.cap ? Math.min(100, Math.round((counted / u.cap) * 100)) : null
  return (
    <span className="block space-y-1" data-usage-meter>
      {pct !== null && (
        <span className="block h-2 w-full max-w-xs overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('Usage this month')}>
          <span className={`block h-full rounded-full ${pct >= 90 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="block text-muted">{usageText(u)}</span>
    </span>
  )
}

export function OwnerAssistantSettings(p: OwnerViewProps & { onCancel?: () => void }) {
  const d = p.draft
  const set = (patch: Partial<OwnerDraft>) => p.onChange({ ...d, ...patch })
  const setProv = (name: ProviderName, patch: Partial<OwnerDraft['providers'][ProviderName]>) =>
    set({ providers: { ...d.providers, [name]: { ...d.providers[name], ...patch } } })
  const off = !p.connected
  return (
    <div className="space-y-4" data-assistant-owner-form>
      <Checkbox checked={d.enabled} disabled={off} onChange={(e) => set({ enabled: e.target.checked })} label={t('Turn on the assistant for this server')}
        description={t('Off by default. While off, no one sees it and the server contacts no model provider. Each person still has to accept what is sent before their first message.')} />
      <FormGroup title={t('Provider')}>
      <Field label={t('Provider everyone uses')} description={t('Changing it asks every person to accept the disclosure again.')}>
        <Select className="min-w-0 max-w-full sm:max-w-sm" value={d.default_provider} disabled={off} onChange={(e) => set({ default_provider: e.target.value as ProviderName })}>
          {PROVIDERS.map((n) => <option key={n} value={n}>{SHORT[n]}</option>)}
        </Select>
      </Field>
      {PROVIDERS.map((n) => {
        const v = d.providers[n]
        const keySet = p.saved.providers[n]?.key_set
        const tested = p.testedWith === undefined || p.testedWith[n] === JSON.stringify(testDraft(d, n))
        const test = tested ? p.tests[n] : undefined
        const noModel = !v.model.trim()
        return (
          <fieldset key={n} className="space-y-3 rounded-control border border-default p-3" data-provider={n}>
            <legend className="px-1 text-body font-medium text-default">{LABEL[n]}</legend>
            <Checkbox checked={v.enabled} disabled={off} onChange={(e) => setProv(n, { enabled: e.target.checked })} label={t('Allow this provider')} />
            <Field label={t('Model')}>
              <Input value={v.model} disabled={off} placeholder={MODEL_HINT[n]} list={n === 'anthropic' ? 'assistant-anthropic-models' : undefined}
                onChange={(e) => setProv(n, { model: e.target.value })} spellCheck={false} />
            </Field>
            {n === 'anthropic' && (
              <datalist id="assistant-anthropic-models">
                {p.saved.anthropic_models.map((m) => <option key={m} value={m} />)}
              </datalist>
            )}
            {n === 'compatible' && (
              <Field label={t('Base URL')}>
                <Input value={v.base_url} disabled={off} placeholder={t('http://192.168.1.20:11434/v1')} inputMode="url" spellCheck={false}
                  onChange={(e) => setProv(n, { base_url: e.target.value })} />
              </Field>
            )}
            <Field label={(n === 'compatible' ? t('API key (if the endpoint needs one)') : t('API key'))}
              description={t('Stored in the server’s secrets file, never shown again, never in backups or exports.')}>
              <Input type="password" autoComplete="off" disabled={off} value={d.keys[n] ?? ''}
                placeholder={keySet ? t('A key is saved; type to replace it') : t('Paste the key')} onChange={(e) => set({ keys: { ...d.keys, [n]: e.target.value } })} />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={off || noModel} busy={test === 'running'} onClick={() => p.onTest(n)}>{t('Test connection')}</Button>
              {keySet && <Button size="sm" variant="ghost" disabled={off} onClick={() => set({ keys: { ...d.keys, [n]: '' } })}>{t('Remove saved key')}</Button>}
              {noModel && !off && <span className="text-meta text-muted" data-test-needs-model>{t('Enter a model id to test')}</span>}
            </div>
            <TestResult test={test} />
          </fieldset>
        )
      })}
      <Checkbox checked={d.allow_private_endpoint} disabled={off} onChange={(e) => set({ allow_private_endpoint: e.target.checked })} label={t('Allow private endpoints')}
        description={t('Needed for a model server on your own network (Ollama, LM Studio). Off, the compatible endpoint may only be a public address.')} />
      </FormGroup>
      <FormGroup title={t('Limits')}>
      <Field label={t('Monthly tokens per person')} description={t('0 means unlimited. Usage resets on the first day of each month (UTC).')}>
        <Input className="max-w-[12rem]" type="number" min={0} step={10000} value={d.monthly_token_cap_per_user} disabled={off}
          onChange={(e) => set({ monthly_token_cap_per_user: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
      </Field>
      <Checkbox checked={d.allow_member_keys} disabled={off} onChange={(e) => set({ allow_member_keys: e.target.checked })} label={t('Let members bring their own key')}
        description={t('Each person may then choose Anthropic, OpenAI or Google Gemini with their own key and model for their turns, instead of yours. The compatible endpoint is never offered to members, so no one but you decides which other host the server connects to.')} />
      {d.allow_member_keys && (
        <div className="pl-6">
          <Checkbox checked={d.cap_member_keys} disabled={off} onChange={(e) => set({ cap_member_keys: e.target.checked })} label={t('Count members’ own keys toward the monthly limit')}
            description={t('Off by default: a person who pays with their own key is not held to your limit. One answer at a time per person still applies.')} />
        </div>
      )}
      {p.saved.allow_member_keys && typeof p.saved.own_key_members === 'number' && (
        <p className="text-meta text-muted" data-own-key-members>{t('{n, plural, one {# person uses their own provider and key.} other {# people use their own provider and key.}}', { n: p.saved.own_key_members })}</p>
      )}
      </FormGroup>
      <OwnerDeviceGroup draft={d.device} off={off} onChange={(device) => set({ device })} apiOrigins={p.saved.device_origins ?? {}} />
      {p.error && <Notice tone="danger">{p.error}</Notice>}
      {p.message && <Notice tone="success">{p.message}</Notice>}
      <div className="flex justify-end gap-2">
        {p.onCancel && <Button variant="ghost" onClick={p.onCancel}>{t('Cancel')}</Button>}
        <Button variant="primary" disabled={off} busy={p.busy} onClick={p.onSave}>{t('Save assistant settings')}</Button>
      </div>
    </div>
  )
}

export interface OwnerSummaryProps {
  saved: AssistantOwnerSettings
  connected: boolean
  onConfigure: () => void
}

/** The owner's view of the server's assistant: its state at a glance, with the form behind Configure. */
export function OwnerAssistantSummary({ saved, connected, onConfigure }: OwnerSummaryProps) {
  const model = saved.providers[saved.default_provider]?.model
  const allowed = PROVIDERS.filter((n) => saved.providers[n]?.enabled)
  const cap = saved.monthly_token_cap_per_user
  return (
    <div className="divide-y divide-(--ot-border)" data-assistant-owner>
      <SettingRow {...rowCopy('assistant-settings', 'server')}
        status={(
          <span className="flex flex-wrap items-center gap-2" data-testid="assistant-owner-status">
            <StatusIndicator tone={toneForHue(saved.enabled ? 'green' : 'slate')}>{saved.enabled ? t('On') : t('Off')}</StatusIndicator>
            <span>{saved.enabled
              ? (model ? t('Everyone uses {provider} ({model}).', { provider: SHORT[saved.default_provider], model }) : t('Everyone uses {provider}.', { provider: SHORT[saved.default_provider] }))
              : t('No one sees the assistant and the server contacts no model provider.')}</span>
          </span>
        )}
        control={<Button size="sm" icon="settings" disabled={!connected} onClick={onConfigure}>{t('Configure')}</Button>} />
      <SettingRow {...rowCopy('assistant-settings', 'providers')}
        status={allowed.length === 0 ? t('None yet.') : (
          <span className="flex flex-wrap gap-1.5">
            {allowed.map((n) => (
              <Badge key={n} hue={saved.providers[n]?.key_set || n === 'compatible' ? 'blue' : 'orange'}>
                {SHORT[n]}{saved.providers[n]?.key_set || n === 'compatible' ? '' : ` · ${t('no key')}`}
              </Badge>
            ))}
          </span>
        )} />
      <SettingRow {...rowCopy('assistant-settings', 'cap')} status={cap ? t('{n, plural, one {# token} other {# tokens}}', { n: cap }) : t('Unlimited')} />
      <SettingRow {...rowCopy('assistant-settings', 'memberKeys')}
        status={saved.allow_member_keys
          ? [
            saved.cap_member_keys ? t('Allowed, counted toward the limit') : t('Allowed'),
            typeof saved.own_key_members === 'number' ? t('{n, plural, one {# person uses their own} other {# people use their own}}', { n: saved.own_key_members }) : '',
          ].filter(Boolean).join(' · ') + '.'
          : t('Not allowed.')} />
      <SettingRow {...rowCopy('assistant-settings', 'device')}
        status={saved.device?.enabled && saved.device.providers.length
          ? t('On their own device: {providers}.', { providers: saved.device.providers.map((n) => SHORT[n]).join(', ') })
          : t('Off: the assistant is not available to encrypted accounts.')} />
    </div>
  )
}

export type MemberProvider = 'anthropic' | 'openai' | 'gemini'

/** The "Which assistant you use" form (assistant-member-provider). */
export interface OwnDraft {
  mode: 'server' | 'own'
  provider: MemberProvider
  model: string
  key: string
}

const MEMBER_MODEL_HINT = translatedMap<MemberProvider>({ anthropic: '', openai: msg('for example gpt-4.1-mini'), gemini: msg('for example gemini-2.5-flash') })

function isMemberProvider(p: string | undefined): p is MemberProvider {
  return !!p && (MEMBER_PROVIDERS as string[]).includes(p)
}

export function ownDraftFrom(s: AssistantStatus): OwnDraft {
  const own = s.own_provider
  const models = s.anthropic_models ?? []
  if (own && isMemberProvider(own.provider)) return { mode: 'own', provider: own.provider, model: own.model, key: '' }
  return { mode: 'server', provider: 'anthropic', model: models[0] ?? '', key: '' }
}

/** What to send for the form, or a message saying what is missing. */
export function ownInputFrom(d: OwnDraft, s: AssistantStatus): MyAssistantInput | string {
  if (d.mode === 'server') return { own_provider: '' }
  const model = d.model.trim()
  if (d.provider === 'anthropic') {
    if (!(s.anthropic_models ?? []).includes(model)) return t('Choose one of the offered Anthropic models.')
  } else if (!MEMBER_MODEL_RE.test(model)) {
    return t('Enter a model id of up to 100 characters: letters, digits, dots, underscores, colons and hyphens.')
  }
  const key = d.key.trim()
  const saved = s.own_provider?.provider === d.provider && s.own_provider.key_set
  if (!key && !saved) return t('Enter your API key for {provider}.', { provider: SHORT[d.provider] })
  return { own_provider: d.provider, own_model: model, ...(key ? { own_key: key } : {}) }
}

export interface UserViewProps {
  status: AssistantStatus | null
  usage: AssistantUsage | null
  autoApply: boolean
  connected: boolean
  busy: boolean
  error: string | null
  onWithdraw: () => void
  onOwnKey: (key: string) => void
  onAutoApply: (on: boolean) => void
  onClear: () => void
  cleared: boolean
  /** Saves "Which assistant you use"; resolves true when saved. */
  onSaveOwn?: (input: MyAssistantInput) => Promise<boolean> | void
  /** Tests the provider, model and key on screen (a key left empty uses the one saved for that provider). */
  onTestOwn?: (draft: MyAssistantTestDraft) => void
  ownTest?: AssistantTestResult | 'running'
  ownMessage?: string | null
}

function usageText(u: AssistantUsage): string {
  const counted = u.counted_tokens ?? u.total_tokens
  const pct = u.cap ? Math.min(100, Math.round((counted / u.cap) * 100)) : null
  const parts = [t('{turns, plural, one {This month: {tokens, number} tokens in # answer} other {This month: {tokens, number} tokens in # answers}}', { tokens: u.total_tokens, turns: u.turns })]
  parts.push(pct !== null ? t('{pct}% of your {cap, number}-token limit, resets {date}', { pct, cap: u.cap, date: formatDate(u.resets_at, 'compact') }) : t('no limit'))
  const own = u.own_key?.total_tokens ?? 0
  if (own > 0) parts.push(u.cap_member_keys || !u.cap ? t('{n, number} on your own key', { n: own }) : t('{n, number} on your own key, not counted toward the limit', { n: own }))
  return `${parts.join(' · ')}.`
}

/** "Which assistant you use": the server's, or your own provider, model and key. */
export function OwnProviderForm(p: UserViewProps & { status: AssistantStatus }) {
  const s = p.status
  const [d, setD] = useState<OwnDraft>(() => ownDraftFrom(s))
  const [problem, setProblem] = useState<string | null>(null)
  const set = (patch: Partial<OwnDraft>) => { setProblem(null); setD({ ...d, ...patch }) }
  const off = !p.connected
  const own = s.own_provider
  const ownActive = s.source === 'own'
  const models = s.anthropic_models ?? []
  const choices = (s.member_providers ?? MEMBER_PROVIDERS).filter(isMemberProvider)
  const savedSame = own?.provider === d.provider && own.key_set
  const dirty = d.mode === 'server' ? !!own : !own || own.provider !== d.provider || own.model !== d.model.trim() || !!d.key.trim()
  const ownTestDraft: MyAssistantTestDraft = { provider: d.provider, model: d.model.trim(), ...(d.key.trim() ? { key: d.key.trim() } : {}) }
  const ownSig = JSON.stringify(ownTestDraft)
  const [testedSig, setTestedSig] = useState<string | null>(null)
  const capNote = s.cap_member_keys ? t('Your answers still count toward the server’s monthly limit.') : t('Answers on your key do not count toward the server’s monthly limit.')
  const save = async () => {
    const input = ownInputFrom(d, s)
    if (typeof input === 'string') { setProblem(input); return }
    const ok = await p.onSaveOwn?.(input)
    if (ok) setD((cur) => ({ ...cur, key: '' }))
  }
  const radio = 'mt-0.5 h-4 w-4 shrink-0 accent-(--ot-accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
  return (
    <fieldset className="space-y-3 py-3 text-body" data-assistant-own>
      <legend className="float-left mb-2 w-full text-body font-medium text-default">{t('Which assistant you use')}</legend>
      <label className="clear-left flex items-start gap-2.5">
        <input type="radio" name="assistant-own-mode" className={radio} checked={d.mode === 'server'} disabled={off} onChange={() => set({ mode: 'server' })} />
        <span className="text-default">{t('The server’s assistant')}
          <span className="block text-meta text-muted">{t('{provider}, set up by the server owner.', { provider: `${s.server_provider_label ?? s.provider_label}${s.server_model ? ` (${s.server_model})` : ''}` })}</span>
        </span>
      </label>
      <label className="flex items-start gap-2.5">
        <input type="radio" name="assistant-own-mode" className={radio} checked={d.mode === 'own'} disabled={off} onChange={() => set({ mode: 'own' })} />
        <span className="text-default">{t('My own provider and key')}<span className="block text-meta text-muted">{t('Anthropic, OpenAI or Google Gemini, with an API key from your own account.')} {capNote}</span>
        </span>
      </label>
      {d.mode === 'own' && (
        <div className="space-y-3 pl-6">
          <Field label={t('Provider')}>
            <Select className="min-w-0 max-w-full sm:max-w-sm" value={d.provider} disabled={off}
              onChange={(e) => {
                const provider = e.target.value as MemberProvider
                const model = provider === own?.provider ? own.model : provider === 'anthropic' ? (models[0] ?? '') : ''
                set({ provider, model, key: '' })
              }}>
              {choices.map((n) => <option key={n} value={n}>{SHORT[n]}</option>)}
            </Select>
          </Field>
          <Field label={t('Model')}>
            {d.provider === 'anthropic' ? (
              <Select className="min-w-0 max-w-full sm:max-w-sm" value={d.model} disabled={off} onChange={(e) => set({ model: e.target.value })}>
                {!models.includes(d.model) && <option value={d.model}>{t('Choose a model')}</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            ) : (
              <Input className="max-w-sm" value={d.model} disabled={off} maxLength={100} spellCheck={false} autoCapitalize="off" autoComplete="off"
                placeholder={MEMBER_MODEL_HINT[d.provider]} onChange={(e) => set({ model: e.target.value })} />
            )}
          </Field>
          <Field label={t('Your API key for {provider}', { provider: SHORT[d.provider] })}
            description={t('Requests go from this server to {provider} with your key. It is stored on the server, never shown again, never sent to your browser and never in backups or exports. A custom endpoint is not offered here, so no account can make the server connect to a host of its choosing.', { provider: SHORT[d.provider] })}>
            <Input className="max-w-sm" type="password" autoComplete="off" value={d.key} disabled={off} onChange={(e) => set({ key: e.target.value })}
              placeholder={savedSame ? t('Your key is saved; type to replace it') : t('Paste your key')} />
          </Field>
        </div>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={off || !dirty} busy={p.busy} onClick={() => void save()}>
          {d.mode === 'server' ? t('Use the server’s assistant') : t('Save my provider')}
        </Button>
        {d.mode === 'own' && p.onTestOwn && (
          <Button size="sm" disabled={off || !d.model.trim()} busy={p.ownTest === 'running'} onClick={() => { setTestedSig(ownSig); p.onTestOwn?.(ownTestDraft) }}>{t('Test connection')}</Button>
        )}
        {d.mode === 'own' && p.onTestOwn && !d.model.trim() && !off && <span className="text-meta text-muted" data-test-needs-model>{t('Enter a model id to test')}</span>}
      </div>
      {d.mode === 'own' && (testedSig === null || testedSig === ownSig) && (
        <TestResult test={p.ownTest && p.ownTest !== 'running' && p.ownTest.ok && dirty ? { ...p.ownTest, message: t(SAVE_TO_USE) } : p.ownTest} />
      )}
      {p.ownMessage && <Notice tone="success">{p.ownMessage}</Notice>}
      {d.mode === 'server' && !ownActive && (s.server_own_key_set ?? s.own_key_set) && (
        <div data-legacy-key>
          <Notice action={<Button size="sm" variant="ghost" disabled={off} onClick={() => p.onOwnKey('')}>{t('Remove my key')}</Button>}>
            {t('Your key is saved for {provider}; the server’s assistant uses it instead of the server owner’s key.', { provider: s.server_provider_label ?? s.provider_label })}
          </Notice>
        </div>
      )}
    </fieldset>
  )
}

/** The own-key form of servers from before assistant-member-provider. */
function LegacyOwnKey(p: UserViewProps & { status: AssistantStatus }) {
  const [key, setKey] = useState('')
  const s = p.status
  return (
    <div className="space-y-2 py-3">
      <Field label={t('Your own API key')}>
        <Input className="max-w-sm" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} disabled={!p.connected}
          placeholder={s.own_key_set ? t('Your key is saved; type to replace it') : t('Optional')} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!p.connected || !key.trim()} onClick={() => { p.onOwnKey(key.trim()); setKey('') }}>{t('Save my key')}</Button>
        {s.own_key_set && <Button size="sm" variant="ghost" disabled={!p.connected} onClick={() => p.onOwnKey('')}>{t('Remove my key')}</Button>}
      </div>
    </div>
  )
}

/** Settings → Integrations → Assistant for everyone: consent, which assistant you use, usage, auto-apply, conversations. */
export function UserAssistantSettings(p: UserViewProps) {
  useDateTimeFormat()
  const s = p.status
  if (!s) return null
  if (s.reason === 'encryption_enabled') return <div className="py-3"><Notice>{noticeCopy('assistant-settings', 'encrypted')}{' '}<EncryptionOffHint /></Notice></div>
  if (!s.enabled) return <div className="py-3"><Notice>{noticeCopy('assistant-settings', 'ownerOff')}</Notice></div>
  const commonRows = (
    <>
      <SettingRow {...rowCopy('assistant-settings', 'auto')}
        control={<Switch checked={p.autoApply} onChange={p.onAutoApply} label={t('Apply small changes without review (this device)')} hideLabel />} />
      <SettingRow {...rowCopy('assistant-settings', 'conversations')}
        status={p.cleared ? <span role="status" className="text-muted">{t('Cleared.')}</span> : undefined}
        control={<Button size="sm" variant="danger" onClick={p.onClear}>{t('Clear conversations on this device')}</Button>} />
      {p.error && <div className="py-3"><Notice tone="danger">{p.error}</Notice></div>}
    </>
  )
  // An encrypted account runs the assistant on its own device (assistant-on-device).
  if (s.mode === 'device') {
    return (
      <div className="divide-y divide-(--ot-border)" data-assistant-user data-assistant-device>
        <DeviceUserRows status={s} connected={p.connected} onWithdraw={p.onWithdraw} />
        {commonRows}
      </div>
    )
  }
  const ownSupported = s.source !== undefined
  const keptChoice = !s.allow_member_keys && s.own_provider
  return (
    <div className="divide-y divide-(--ot-border)" data-assistant-user>
      <SettingRow {...rowCopy('assistant-settings', 'yours')}
        status={(
          <span className="block space-y-1">
            <span className="block">{t.rich(s.source === 'own' ? 'Provider: <strong>{provider}</strong>{model}, with your own key.' : 'Provider: <strong>{provider}</strong>{model}.', { provider: s.provider_label, model: s.model ? ` (${s.model})` : '', strong: (chunks) => <strong>{chunks}</strong> })}</span>
            <span className="flex flex-wrap items-center gap-2 text-muted">
              <StatusIndicator tone={toneForHue(s.consented ? 'green' : 'slate')}>{s.consented ? t('Accepted') : t('Not accepted yet')}</StatusIndicator>
              {s.consented ? t('You accepted what is sent.') : t('You have not accepted yet; the assistant asks before your first message.')}{' '}{t.rich('Open it with {keys}.', { keys: <Kbd k={keysOf('global.assistant')} /> })}
            </span>
          </span>
        )}
        control={s.consented ? <Button size="sm" disabled={!p.connected} onClick={p.onWithdraw}>{t('Withdraw consent')}</Button> : undefined} />
      {p.usage && <SettingRow {...rowCopy('assistant-settings', 'usage')} status={<UsageMeter u={p.usage} />} />}
      {s.allow_member_keys && (ownSupported ? <OwnProviderForm key={`${s.own_provider?.provider ?? ''}:${s.own_provider?.model ?? ''}`} {...p} status={s} /> : <LegacyOwnKey {...p} status={s} />)}
      {keptChoice && (
        <div className="py-3" data-own-provider-kept>
          <Notice tone="warning" action={<Button size="sm" variant="ghost" disabled={!p.connected} onClick={() => void p.onSaveOwn?.({ own_provider: '' })}>{t('Forget my provider and key')}</Button>}>
            {noticeCopy('assistant-settings', 'kept', { values: { provider_label: keptChoice.provider_label } })}
          </Notice>
        </div>
      )}
      {commonRows}
    </div>
  )
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message.charAt(0).toUpperCase() + err.message.slice(1)
  return t('The server is unreachable. These settings live on the server and need a connection.')
}

/** Settings → Assistant (lazy chunk). */
export default function AssistantSettingsSection({ isOwner }: { isOwner: boolean }) {
  const connected = useOnline()
  const [settings, setSettings] = useState<AssistantOwnerSettings | AssistantMemberSettings | null>(null)
  const [draft, setDraft] = useState<OwnerDraft | null>(null)
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [usage, setUsage] = useState<AssistantUsage | null>(null)
  const [autoApply, setAuto] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userError, setUserError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [tests, setTests] = useState<OwnerViewProps['tests']>({})
  const [testedWith, setTestedWith] = useState<NonNullable<OwnerViewProps['testedWith']>>({})
  const [cleared, setCleared] = useState(false)
  const [ownBusy, setOwnBusy] = useState(false)
  const [ownMessage, setOwnMessage] = useState<string | null>(null)
  const [ownTest, setOwnTest] = useState<AssistantTestResult | 'running' | undefined>(undefined)
  const [configuring, setConfiguring] = useState(false)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await api.getAssistantSettings()
      setSettings(s)
      if (isOwnerSettings(s)) setDraft(draftFrom(s))
      setStatus(await refreshAssistantStatus())
      setUsage(await api.assistantUsage().catch(() => null))
    } catch (err) {
      setError(message(err))
      setStatus(await refreshAssistantStatus())
    }
  }, [])
  useEffect(() => {
    void load()
    void getAutoApply().then(setAuto)
  }, [load])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const s = await api.saveAssistantSettings(inputFrom(draft))
      setSettings(s)
      setDraft(draftFrom(s))
      setStatus(await refreshAssistantStatus())
      setMsg(t('Saved.'))
      setConfiguring(false)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const test = async (p: ProviderName) => {
    if (!draft || !settings || !isOwnerSettings(settings)) return
    const values = testDraft(draft, p)
    setTestedWith((w) => ({ ...w, [p]: JSON.stringify(values) }))
    setTests((item) => ({ ...item, [p]: 'running' }))
    try {
      const r = await api.testAssistant(p, values)
      setTests((entry) => ({ ...entry, [p]: r.ok && testIsUnsaved(values, settings, p) ? { ...r, message: t(SAVE_TO_USE) } : r }))
    } catch (err) {
      setTests((x1) => ({ ...x1, [p]: { ok: false, message: message(err) } }))
    }
  }
  const updateMine = async (input: MyAssistantInput): Promise<boolean> => {
    setUserError(null)
    setOwnMessage(null)
    try {
      const next = await api.setMyAssistant({ ...input, provider: status?.provider })
      setAssistantStatus(next)
      setStatus(next)
      return true
    } catch (err) {
      setUserError(message(err))
      return false
    }
  }
  const saveOwn = async (input: MyAssistantInput): Promise<boolean> => {
    setOwnBusy(true)
    setOwnTest(undefined)
    const ok = await updateMine(input)
    setOwnBusy(false)
    if (ok) setOwnMessage(input.own_provider ? t('Saved. Before your next message, the assistant asks you to accept what is sent to your provider.') : t('Saved.'))
    return ok
  }
  const testOwn = async (values: MyAssistantTestDraft) => {
    setOwnTest('running')
    try {
      setOwnTest(await api.testMyAssistant(values))
    } catch (err) {
      setOwnTest({ ok: false, message: message(err) })
    }
  }

  const configure = () => {
    if (settings && isOwnerSettings(settings)) setDraft(draftFrom(settings))
    setError(null)
    setMsg(null)
    setConfiguring(true)
  }

  return (
    <SettingsSection {...cardCopy('assistant-settings')} testId="assistant-settings">
      {!connected && <div className="pb-3"><Notice>{noticeCopy('assistant-settings', 'offline')}</Notice></div>}
      {error && !configuring && <div className="py-3"><Notice tone="danger">{error}</Notice></div>}
      {msg && !configuring && <div className="py-3"><Notice tone="success">{msg}</Notice></div>}
      {assistantStatusLine(status) && <p className="pb-1 text-body font-medium text-default" data-assistant-status-line>{assistantStatusLine(status)}</p>}
      {isOwner && settings && isOwnerSettings(settings) && (
        <CardGroup title={t('For everyone on this server')} id="assistant-everyone">
          <OwnerAssistantSummary saved={settings} connected={connected} onConfigure={configure} />
        </CardGroup>
      )}
      <CardGroup title={t('For you')} id="assistant-you">
        <UserAssistantSettings status={status} usage={usage} autoApply={autoApply} connected={connected} busy={ownBusy} error={userError} cleared={cleared}
          onWithdraw={() => void updateMine({ consent: false })} onOwnKey={(k) => void updateMine({ own_key: k })}
          onSaveOwn={saveOwn} onTestOwn={(v) => void testOwn(v)} ownTest={ownTest} ownMessage={ownMessage}
          onAutoApply={(on) => { setAuto(on); void setAutoApply(on) }} onClear={() => setClearing(true)} />
      </CardGroup>
      {configuring && isOwner && settings && isOwnerSettings(settings) && draft && (
        <Dialog title={t('Configure the assistant')} onClose={() => setConfiguring(false)} size="lg" dismissable={false} testId="assistant-configure">
          <OwnerAssistantSettings saved={settings} draft={draft} connected={connected} busy={busy} error={error} message={null} tests={tests} testedWith={testedWith}
            onChange={setDraft} onSave={() => void save()} onTest={(p) => void test(p)} onCancel={() => setConfiguring(false)} />
        </Dialog>
      )}
      {clearing && (
        <ConfirmDialog title={t('Clear conversations on this device?')} confirmLabel={t('Clear conversations')}
          consequence={t('Every assistant conversation stored in this browser is deleted. Your tasks and changes already applied stay as they are.')}
          onConfirm={() => clearThreads().then(() => setCleared(true))} onCancel={() => setClearing(false)} />
      )}
    </SettingsSection>
  )
}
