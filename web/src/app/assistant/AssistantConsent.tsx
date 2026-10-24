import { useState } from 'react'
import type { AssistantStatus } from '../../lib/assistantStatus'
import { t } from '../../lib/i18n'
import type { DeviceSetup } from '../../lib/assistantDevice/settings'
import { DeviceDisclosure } from './AssistantDevice'

export interface ConsentProps {
  status: AssistantStatus
  connected: boolean
  busy: boolean
  error: string | null
  onAccept: (ownKey?: string) => void
  /** The on-device assistant's provider and the way back to its setup (assistant-on-device D6). */
  device?: { setup: DeviceSetup; onChange: () => void }
}

/**
 * The disclosure before the first message (in-app-assistant "Per-user consent
 * and own keys"): which provider receives task content, which fields may be
 * sent, and, when the owner allows it, an optional key of your own.
 */
export function AssistantConsent({ status, connected, busy, error, onAccept, device }: ConsentProps) {
  const [ownKey, setOwnKey] = useState('')
  const changed = !device && status.consent && status.consent.provider !== status.provider
  // assistant-member-provider: the provider the member chose, with their key.
  const own = status.source === 'own'
  return (
    <section className="space-y-3 text-body" aria-labelledby="assistant-consent-heading" data-assistant-consent>
      <h3 id="assistant-consent-heading" className="text-body font-semibold">{t('Before you start')}</h3>
      {changed && <p className="rounded-control bg-warning-soft p-2 text-on-warning-soft">{own ? t('The model provider changed.') : t('The server owner changed the model provider.')}{' '}{t('Read what is sent now and accept again.')}</p>}
      {device ? <DeviceDisclosure setup={device.setup} onChange={device.onChange} /> : own ? (
        <p data-consent-own>
          {t.rich('To answer, the assistant sends what you type and the task data it needs from this server to <strong>{provider}</strong>{model}, with your own API key. You chose it in Settings → Integrations → Assistant. Nothing is sent before you accept.', { provider: status.provider_label, model: status.model ? <>{' '}{t.rich('(model <code>{model}</code>)', { model: status.model, code: (chunks) => <code className="rounded-control bg-sunken dark:bg-raised px-1">{chunks}</code> })}</> : '', strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      ) : (
        <p>
          {t.rich('To answer, the assistant sends what you type and the task data it needs to <strong>{provider}</strong>{model}. Your server owner chose it. Nothing is sent before you accept.', { provider: status.provider_label, model: status.model ? <>{' '}{t.rich('(model <code>{model}</code>)', { model: status.model, code: (chunks) => <code className="rounded-control bg-sunken dark:bg-raised px-1">{chunks}</code> })}</> : '', strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      )}
      <div>
        <p className="font-medium">{t('What may be sent')}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
          {status.fields.map((f) => <li key={f}>{f}</li>)}
        </ul>
      </div>
      <p className="text-muted">
        {t('In shared projects this includes text other members wrote. Changes are only proposed: nothing in your tasks changes until you review and apply them, and you can undo them. Conversations stay on this device. You can withdraw consent in Settings → Integrations → Assistant.')}
      </p>
      {status.allow_member_keys && !own && !device && (
        <label className="block">
          {t.rich('<span>Your own API key (optional)</span><span2>Used instead of the server’s key. It is stored on the server, never shown again and never sent to your browser.</span2>', { span: (chunks) => <span className="font-medium">{chunks}</span>, span2: (chunks) => <span className="block text-meta text-muted">{chunks}</span> })}
          <input className="ui-input mt-1" type="password" autoComplete="off" value={ownKey} onChange={(e) => setOwnKey(e.target.value)} disabled={!connected} />
        </label>
      )}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {!connected && <p className="text-muted">{t('Accepting needs a connection.')}</p>}
      <button type="button" className="ui-btn ui-btn--primary ui-btn--md" disabled={!connected} aria-busy={busy} onClick={() => { if (!busy) onAccept(ownKey.trim() || undefined) }} data-assistant-accept>
        {t('Accept and continue')}
      </button>
    </section>
  )
}
