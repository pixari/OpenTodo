import type { ReactNode } from 'react'
import { BrandMark, Skeleton } from '../../ui'
import type { AssistantSkill } from '../../lib/assistantSkills'
import { AssistantWelcome } from './AssistantWelcome'
import type { Review } from '../../lib/assistant'
import { usageLine, type AssistantMessage, type AssistantThread } from '../../lib/assistant'
import type { AssistantStatus } from '../../lib/assistantStatus'
import { msg, t } from '../../lib/i18n'
import { useDateTimeFormat } from '../DateTimePrefsProvider'
import { Markdown } from '../Markdown'
import { navigate } from '../router'
import { requestSettingsFocus } from '../settingsIndex'
import { AssistantConsent } from './AssistantConsent'
import { ChangeSetReview, type ReviewResult } from './ChangeSetReview'
import { DeviceLocked, DeviceSetupForm } from './AssistantDevice'
import type { DeviceMode } from './useDeviceAssistant'

export const ENCRYPTED_MESSAGE = msg('The assistant can’t read end-to-end encrypted tasks. Your tasks never leave your devices unencrypted.')

/** What an encrypted account can do to use the assistant: a link to the encryption settings. */
export function EncryptionOffHint() {
  return (
    <span data-assistant-encryption-hint>
      {t.rich('To use the assistant, you can turn encryption off in <a>Settings → Account → Encryption</a>; your tasks are then stored on the server without end-to-end encryption.', { a: (chunks) => <a className="underline" href="/settings/account" onClick={(e) => { e.preventDefault(); requestSettingsFocus('encryption'); navigate({ view: 'settings', section: 'account' }) }}>{chunks}</a> })}
    </span>
  )
}
export const OFFLINE_MESSAGE = msg('The assistant needs a connection.')

export interface PanelViewProps {
  status: AssistantStatus | null
  connected: boolean
  messages: AssistantMessage[]
  streaming: { text: string; status: string[] } | null
  /** Polite live regions: completed sentences of the answer, and status lines. */
  announce: string
  statusAnnounce: string
  review: Review | null
  result: ReviewResult | null
  reviewBusy: boolean
  error: string | null
  draft: string
  consentBusy: boolean
  consentError: string | null
  threads: AssistantThread[] | null
  reviewRef?: React.RefObject<HTMLDivElement | null>
  onToggle: (i: number, c: boolean) => void
  onApply: () => void
  onDiscard: () => void
  onUndo: () => void
  onDraft: (s: string) => void
  onSend: () => void
  onStop: () => void
  onAccept: (ownKey?: string) => void
  onPickThread: (id: string) => void
  /** The empty state (assistant-surface D2): the person's name, the starter skills, what a starter does. */
  name?: string
  skills?: AssistantSkill[]
  onStarter?: (s: AssistantSkill) => void
  /** The page's empty state holds the composer; the sheet keeps it at its foot. */
  composer?: ReactNode
  layout?: 'page' | 'sheet'
  /** The on-device assistant of an encrypted account (assistant-on-device). */
  device?: DeviceMode
}

/** The panel's content without state (rendered to markup in tests). */
export function AssistantPanelBody(p: PanelViewProps) {
  const dt = useDateTimeFormat()
  const s = p.status
  if (!s) return <Skeleton shape="line" count={3} label={t('Loading the assistant')} />
  if (s.reason === 'encryption_enabled') {
    return (
      <div className="space-y-2 text-body" data-assistant-encrypted>
        <p className="font-medium">{t(ENCRYPTED_MESSAGE)}</p>
        <p className="text-muted">{t('Your account uses end-to-end encryption, so the server holds no key to your tasks and cannot pass them to a model. The rest of the app works as usual.')}</p>
        <p className="text-muted"><EncryptionOffHint /></p>
      </div>
    )
  }
  if (s.reason === 'demo') return <p className="text-body">{t('The assistant is not available on the demo instance.')}</p>
  if (!s.enabled) return <p className="text-body">{t('The server owner has not turned the assistant on.')}</p>
  const dev = s.mode === 'device' ? p.device : undefined
  if (dev && s.device) {
    if (dev.locked) return <DeviceLocked />
    if (!dev.loaded) return <Skeleton shape="line" count={3} label={t('Loading the assistant')} />
    if (!dev.setup || dev.editing) return <DeviceSetupForm allowance={s.device} setup={dev.setup} onSave={dev.save} onCancel={dev.setup ? () => dev.edit(false) : undefined} />
  }
  return (
    <div className="space-y-4">
      {p.threads && (
        <nav aria-label={t('Earlier conversations')} className="space-y-1">
          <h3 className="text-body font-semibold">{t('Earlier conversations on this device')}</h3>
          {p.threads.length === 0 ? <p className="text-body text-muted">{t('None yet.')}</p> : (
            <ul className="space-y-1">
              {p.threads.map((item) => (
                <li key={item.id}>
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--md w-full justify-start text-left" onClick={() => p.onPickThread(item.id)}>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="text-meta text-faint">{dt.formatInstant(item.updated_at, 'date')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      )}
      {!s.consented ? (
        <AssistantConsent status={s} connected={p.connected} busy={p.consentBusy} error={p.consentError} onAccept={p.onAccept}
          device={dev?.setup ? { setup: dev.setup, onChange: () => dev.edit(true) } : undefined} />
      ) : (
        <>
          {p.messages.length === 0 && !p.streaming && !p.threads ? (
            <AssistantWelcome name={p.name ?? ''} skills={p.skills ?? []} onStarter={(s) => p.onStarter?.(s)} composer={p.composer} layout={p.layout ?? 'sheet'} />
          ) : (
            <ol className="space-y-5" aria-label={t('Conversation')}>
              {p.messages.map((m, i) => <MessageItem key={i} m={m} />)}
              {p.streaming && (
                <AnswerItem busy>
                  {p.streaming.status.length > 0 && <p className="text-meta text-muted">{p.streaming.status[p.streaming.status.length - 1]}</p>}
                  {p.streaming.text ? <Markdown source={p.streaming.text} /> : <p className="text-muted">{t('Thinking…')}</p>}
                </AnswerItem>
              )}
            </ol>
          )}
          {(p.review || p.result) && (
            <div className="sm:pl-9">
              <ChangeSetReview review={p.review} result={p.result} busy={p.reviewBusy} onToggle={p.onToggle} onApply={p.onApply} onDiscard={p.onDiscard} onUndo={p.onUndo} regionRef={p.reviewRef} />
            </div>
          )}
        </>
      )}
      {p.error && <p role="alert" className="text-body text-danger">{p.error}</p>}
      <div className="sr-only" aria-live="polite" data-assistant-live>{p.announce}</div>
      <div className="sr-only" aria-live="polite" data-assistant-status>{p.statusAnnounce}</div>
    </div>
  )
}

/** An answer: the assistant's mark at the left, the text beside it (assistant-surface D2). */
function AnswerItem({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-body" aria-busy={busy || undefined}>
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-control border border-default" aria-hidden="true"><BrandMark size={16} /></span>
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </li>
  )
}

function MessageItem({ m }: { m: AssistantMessage }) {
  if (m.role === 'user') {
    return (
      <li className="ml-auto w-fit max-w-[85%] rounded-card bg-sunken px-3 py-2 text-body">
        {(m.skill || m.pastedLines) && (
          <p className="mb-1 text-meta text-muted">{[m.skill && t('Skill: {name}', { name: m.skill }), m.pastedLines && t('{n, plural, one {pasted text, # line} other {pasted text, # lines}}', { n: m.pastedLines })].filter(Boolean).join(' · ')}</p>
        )}
        <span className="sr-only">{t('You:')}</span><span className="whitespace-pre-wrap user-text">{m.text}</span>
      </li>
    )
  }
  return (
    <AnswerItem>
      <span className="sr-only">{t('Assistant:')}{' '}</span>
      {m.text && <Markdown source={m.text} />}
      {m.stop === 'max_tokens' && <p className="text-meta font-medium text-on-warning-soft">{t('Cut off: the answer reached its length limit.')}</p>}
      {m.error && <p className="text-danger">{m.error}</p>}
      {m.note && <p className="text-meta text-muted">{m.note}</p>}
      {m.usage && <p className="text-meta text-faint">{usageLine(m.usage)}</p>}
    </AnswerItem>
  )
}
