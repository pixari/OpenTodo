// The on-device assistant's screens (OpenSpec change assistant-on-device): the
// setup form an encrypted account fills on this device (provider, model, its own
// key or a model server address), the owner's switch in the configuration form,
// and the rows of Settings → Assistant for an account in device mode.
import { useState } from 'react'
import type { AssistantStatus, DeviceAllowance } from '../../lib/assistantStatus'
import { rowCopy } from '../../lib/settingsCopy'
import { describeStreamError } from '../../lib/assistant'
import { checkSetup, DEVICE_PROVIDERS, MODEL_RE, originOf, type DeviceProvider, type DeviceSetup, type SetupProblem } from '../../lib/assistantDevice/settings'
import type { DeviceSettings, ProviderName } from '../../lib/assistantTypes'
import { msg, t, translatedMap } from '../../lib/i18n'
import { Button, Checkbox, Field, Input, Notice, Select, SettingRow, StatusIndicator, Textarea, toneForHue } from '../../ui'
import { deviceProviderLabel, useDeviceAssistant, withDevice } from './useDeviceAssistant'

const NAME = translatedMap<DeviceProvider>({ anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini', compatible: msg('A model server (Ollama, LM Studio, …)') })
const MODEL_HINT = translatedMap<DeviceProvider>({ anthropic: '', openai: msg('for example gpt-4.1-mini'), gemini: msg('for example gemini-2.5-flash'), compatible: msg('the model name your server serves') })

function problemText(p: SetupProblem, origins: string[]): string {
  switch (p) {
    case 'provider': return t('The server owner does not allow this provider on devices.')
    case 'model': return t('Enter a model id: letters, digits, dots, dashes, underscores or colons.')
    case 'key': return t('Paste your API key for this provider.')
    case 'base_url': return t('Enter the model server’s address, such as http://localhost:11434/v1.')
    case 'origin': return t('The server owner does not allow this address. Allowed: {origins}.', { origins: origins.join(', ') })
  }
}

type TestState = { ok: true } | { ok: false; message: string } | 'running' | null

/** Test connection from this device: one request to the provider, nothing saved. */
async function runTest(s: DeviceSetup): Promise<TestState> {
  const { testConnection } = await import('../../lib/assistantDevice/providers')
  const r = await testConnection(s)
  if (r.ok) return { ok: true }
  return { ok: false, message: describeStreamError(r.code === 'blocked' ? 'device_blocked' : r.code === 'provider_auth' ? 'device_auth' : r.code, r.message) }
}

export interface DeviceSetupFormProps {
  allowance: DeviceAllowance
  setup: DeviceSetup | null
  onSave: (s: DeviceSetup) => void | Promise<void>
  onCancel?: () => void
}

/** Provider, model and key for this device (assistant-on-device D5). */
export function DeviceSetupForm({ allowance, setup, onSave, onCancel }: DeviceSetupFormProps) {
  const choices = DEVICE_PROVIDERS.filter((p) => allowance.providers.includes(p))
  const first = setup?.provider && choices.includes(setup.provider) ? setup.provider : choices[0]
  const [provider, setProvider] = useState<DeviceProvider>(first)
  const [model, setModel] = useState(setup?.model ?? (first === 'anthropic' ? allowance.default_model : ''))
  const [baseUrl, setBaseUrl] = useState(setup?.baseUrl ?? (allowance.origins[0] ? `${allowance.origins[0]}/v1` : ''))
  const [key, setKey] = useState(setup?.key ?? '')
  const [shown, setShown] = useState<SetupProblem | null>(null)
  const [test, setTest] = useState<TestState>(null)
  const draft: DeviceSetup = { provider, model: model.trim(), key: key.trim() || undefined, ...(provider === 'compatible' ? { baseUrl: baseUrl.trim() } : {}), savedAt: Date.now() }
  const problem = checkSetup(draft, allowance)
  const change = (fn: () => void) => { fn(); setTest(null); setShown(null) }
  if (!choices.length) return <Notice>{t('The server owner allows no provider on devices.')}</Notice>
  return (
    <section className="space-y-3 text-body" aria-labelledby="device-setup-heading" data-device-setup>
      <h3 id="device-setup-heading" className="font-semibold">{t('Set up the assistant on this device')}</h3>
      <p className="text-muted">{t('Your account is end-to-end encrypted, so the server cannot read your tasks. This device can: it sends what a question needs directly to the provider you choose, with your own key. The OpenTodo server sees none of it.')}</p>
      <Field label={t('Provider')}>
        <Select className="min-w-0 max-w-full sm:max-w-sm" value={provider} onChange={(e) => {
          const next = e.target.value as DeviceProvider
          change(() => { setProvider(next); setModel(next === 'anthropic' ? allowance.default_model : ''); setKey('') })
        }}>
          {choices.map((p) => <option key={p} value={p}>{NAME[p]}</option>)}
        </Select>
      </Field>
      <Field label={t('Model')}>
        {provider === 'anthropic' ? (
          <Select className="min-w-0 max-w-full sm:max-w-sm" value={model} onChange={(e) => change(() => setModel(e.target.value))}>
            {allowance.anthropic_models.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        ) : (
          <Input className="max-w-sm" value={model} maxLength={100} spellCheck={false} autoCapitalize="off" autoComplete="off" placeholder={MODEL_HINT[provider]}
            aria-invalid={model.trim() !== '' && !MODEL_RE.test(model.trim())} onChange={(e) => change(() => setModel(e.target.value))} />
        )}
      </Field>
      {provider === 'compatible' && (
        <Field label={t('Model server address')} description={t('Allowed by the server owner: {origins}.', { origins: allowance.origins.join(', ') })}>
          <Input className="max-w-sm" value={baseUrl} inputMode="url" spellCheck={false} autoCapitalize="off" onChange={(e) => change(() => setBaseUrl(e.target.value))} />
        </Field>
      )}
      <Field label={provider === 'compatible' ? t('API key (if the server needs one)') : t('Your API key')}
        description={t('Kept only in this browser: never synced, never sent to the OpenTodo server, deleted when you sign out. The app’s page on this device can read it.')}>
        <Input className="max-w-sm" type="password" autoComplete="off" value={key} onChange={(e) => change(() => setKey(e.target.value))} />
      </Field>
      {shown && <Notice tone="danger">{problemText(shown, allowance.origins)}</Notice>}
      {test && test !== 'running' && (test.ok ? <Notice tone="success">{t('Connection works.')}</Notice> : <Notice tone="danger">{test.message}</Notice>)}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => { if (problem) setShown(problem); else void onSave(draft) }} data-device-save>{t('Save on this device')}</Button>
        <Button size="sm" busy={test === 'running'} onClick={() => {
          if (problem) { setShown(problem); return }
          setTest('running')
          void runTest(draft).then(setTest)
        }}>{t('Test connection')}</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>}
      </div>
    </section>
  )
}

/** Settings → Assistant for an encrypted account in device mode: this device's provider and key, and the consent. */
export function DeviceUserRows({ status, connected, onWithdraw }: { status: AssistantStatus; connected: boolean; onWithdraw: () => void }) {
  const device = useDeviceAssistant(status)
  const s = withDevice(status, device.setup)!
  const setup = device.setup
  if (!status.device) return null
  return (
    <>
      <SettingRow {...rowCopy('assistant-settings', 'thisDevice')}
        status={setup ? (
          <span className="block space-y-1" data-device-row>
            <span className="block">{t.rich('Provider: <strong>{provider}</strong>{model}, called from this device with your own key.', { provider: deviceProviderLabel(setup), model: setup.model ? ` (${setup.model})` : '', strong: (chunks) => <strong>{chunks}</strong> })}</span>
            <span className="flex flex-wrap items-center gap-2 text-muted">
              <StatusIndicator tone={toneForHue(s.consented ? 'green' : 'slate')}>{s.consented ? t('Accepted') : t('Not accepted yet')}</StatusIndicator>
            </span>
          </span>
        ) : t('Not set up on this device yet.')}
        control={(
          <span className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => device.edit(true)}>{setup ? t('Change') : t('Set up')}</Button>
            {setup && <Button size="sm" variant="ghost" onClick={() => void device.clear()}>{t('Remove from this device')}</Button>}
            {s.consented && <Button size="sm" variant="ghost" disabled={!connected} onClick={onWithdraw}>{t('Withdraw consent')}</Button>}
          </span>
        )} />
      {device.editing && (
        <div className="py-3">
          <DeviceSetupForm allowance={status.device} setup={setup} onSave={device.save} onCancel={() => device.edit(false)} />
        </div>
      )}
    </>
  )
}

/** The panel while the account key is not on this device. */
export function DeviceLocked() {
  return (
    <div className="space-y-2 text-body" data-device-locked>
      <p className="font-medium">{t('Unlock this device to use the assistant.')}</p>
      <p className="text-muted">{t('The assistant reads your tasks on this device, and they are encrypted until you unlock it with your passphrase.')}</p>
    </div>
  )
}

/** The disclosure's first paragraph for a device turn (assistant-on-device D6). */
export function DeviceDisclosure({ setup, onChange }: { setup: DeviceSetup; onChange: () => void }) {
  return (
    <>
      <p data-consent-device>
        {t.rich('To answer, this device sends what you type and the task data it needs <strong>directly to {provider}</strong>{model}, with your own key. The OpenTodo server sees none of it. Nothing is sent before you accept.', {
          provider: deviceProviderLabel(setup), model: setup.model ? ` (${setup.model})` : '', strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      <p className="text-muted">
        {t('Your key is stored only in this browser. Like any page that calls a provider itself, this app’s page can read it.')}{' '}
        <button type="button" className="underline" onClick={onChange}>{t('Change provider or key')}</button>
      </p>
    </>
  )
}

/** The owner's form: which providers devices of encrypted accounts may call (assistant-on-device D2, D3). */
export interface OwnerDeviceDraft {
  enabled: boolean
  providers: ProviderName[]
  /** One origin per line. */
  origins: string
}

export function deviceDraftFrom(d: DeviceSettings | undefined): OwnerDeviceDraft {
  return { enabled: !!d?.enabled, providers: d?.providers ?? [], origins: (d?.origins ?? []).join('\n') }
}

export function deviceInputFrom(d: OwnerDeviceDraft): DeviceSettings {
  const origins = d.origins.split(/[\s,]+/).map((o) => o.trim()).filter(Boolean)
  return { enabled: d.enabled, providers: d.enabled ? d.providers : [], origins: d.providers.includes('compatible') ? origins : [] }
}

export function OwnerDeviceGroup({ draft, off, onChange, apiOrigins }: { draft: OwnerDeviceDraft; off: boolean; onChange: (d: OwnerDeviceDraft) => void; apiOrigins: Record<string, string> }) {
  const set = (patch: Partial<OwnerDeviceDraft>) => onChange({ ...draft, ...patch })
  const toggle = (p: ProviderName, on: boolean) => set({ providers: on ? [...draft.providers.filter((x) => x !== p), p] : draft.providers.filter((x) => x !== p) })
  const bad = draft.providers.includes('compatible') ? deviceInputFrom(draft).origins.filter((o) => originOf(o) === null) : []
  return (
    <section className="space-y-4" data-assistant-group="device">
      <h3 className="text-body font-semibold text-default">{t('On-device assistant for encrypted accounts')}</h3>
      <Checkbox checked={draft.enabled} disabled={off} onChange={(e) => set({ enabled: e.target.checked })} label={t('Let encrypted accounts use the assistant from their own device')}
        description={t('Off by default. The server cannot read encrypted tasks, so the person’s browser calls the provider directly with the person’s own key. Your keys are never used or sent to a browser. Pages of this server may then connect to the providers you allow here.')} />
      {draft.enabled && (
        <div className="flex flex-col gap-2 pl-6" data-device-providers>
          {DEVICE_PROVIDERS.map((p) => (
            <div key={p}>
              <Checkbox checked={draft.providers.includes(p)} disabled={off} onChange={(e) => toggle(p, e.target.checked)} label={NAME[p]}
                description={p === 'compatible' ? t('Only the addresses you list below.') : apiOrigins[p]} />
            </div>
          ))}
          {draft.providers.includes('compatible') && (
            <Field label={t('Model server addresses')} description={t('One origin per line, at most 10: https://host[:port], or http://localhost:port for a model on the person’s own computer.')}
              error={bad.length ? t('Not an address: {list}', { list: bad.join(', ') }) : undefined}>
              <Textarea className="max-w-sm font-mono" rows={3} value={draft.origins} disabled={off} spellCheck={false} placeholder="http://localhost:11434"
                onChange={(e) => set({ origins: e.target.value })} />
            </Field>
          )}
        </div>
      )}
    </section>
  )
}
