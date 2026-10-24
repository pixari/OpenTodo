// The in-app assistant's side sheet (in-app-assistant, assistant-skills). Since
// web-component-structure the state lives in useAssistantConversation and the
// sheet, the body and the composer in their own files; this component wires them.
// The Assistant page (assistant-surface D1) wires the same parts in a page.
import { useEffect } from 'react'
import { useOnline } from '../../lib/online'
import { useAgentExclusions } from '../../lib/agentAccess'
import { t } from '../../lib/i18n'
import { Composer } from './AssistantComposer'
import { AssistantPanelBody, OFFLINE_MESSAGE } from './AssistantPanelBody'
import { AssistantSheet } from './AssistantSheet'
import { useAssistantConversation, type ConversationOptions } from './useAssistantConversation'

export { AssistantSheet } from './AssistantSheet'
export { AssistantPanelBody, ENCRYPTED_MESSAGE, EncryptionOffHint, OFFLINE_MESSAGE, type PanelViewProps } from './AssistantPanelBody'
export { Composer } from './AssistantComposer'

type Conversation = ReturnType<typeof useAssistantConversation>

/**
 * What the sheet and the page share once the assistant can take input: a prefilled
 * request sends itself, and the composer takes focus unless the person already moved
 * it elsewhere.
 */
export function useConversationReady(c: Conversation, connected: boolean, host: 'data-assistant-panel' | 'data-assistant-page') {
  const { status, streaming } = c
  const ready = !!status && status.available && status.consented
  const { autoSend, setAutoSend, skill, pickedSkillId } = c.composer
  useEffect(() => {
    if (!autoSend || !ready || !connected || !c.thread || streaming) return
    if (pickedSkillId && !skill) return // wait for the skill list
    setAutoSend(false)
    void c.send()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send reads the latest state; this runs when a prefilled send can go, not on every streaming change
  }, [autoSend, ready, connected, c.thread, skill, pickedSkillId])
  useEffect(() => {
    if (!ready || !connected) return
    const el = document.querySelector<HTMLTextAreaElement>('[data-assistant-composer]')
    const active = document.activeElement
    // On the page the person arrived by navigation: focus the field unless they are already typing somewhere.
    const typing = !!active && (active.matches('input, textarea, select') || (active as HTMLElement).isContentEditable)
    if (el && (!active || active === document.body || active.hasAttribute(host) || active.hasAttribute('data-assistant-accept') || (host === 'data-assistant-page' && !typing))) el.focus({ preventScroll: true })
  }, [ready, connected, host])
  return ready
}

/** The tray's context chip (assistant-surface D3): the view or selection the turn carries; nothing on other pages. */
export function contextName(view: string | undefined, selected: number): string | undefined {
  if (selected > 0) return t('{n, plural, one {# selected task} other {# selected tasks}}', { n: selected })
  switch (view) {
    case 'today': return t('Today')
    case 'upcoming': return t('Upcoming')
    case 'inbox': return t('Inbox')
    case 'project': return t('This project')
    case 'view': return t('This view')
    default: return undefined
  }
}

/** Picking a starter puts its skill in the composer and the cursor in the field. */
export function focusComposer() {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-assistant-composer]')?.focus())
}

export interface AssistantPanelProps extends ConversationOptions {
  onClose: () => void
  /** The greeting's name (assistant-surface D2). */
  name?: string
}

export function AssistantPanel({ onClose, context, onApplied, name = '' }: AssistantPanelProps) {
  const online = useOnline()
  const c = useAssistantConversation({ context, onApplied, userName: name })
  // A device turn needs no connection to this server: a model server on the same computer answers offline (assistant-on-device).
  const connected = online || c.status?.mode === 'device'
  const { status, composer, review: rv, streaming } = c
  // A project kept away from assistants replaces the view hint (agent-planning-fields D9).
  const excluded = useAgentExclusions()
  const ctx = context()
  const keptAway = !!ctx.projectId && excluded.has(ctx.projectId)

  const onEscape = () => {
    if (rv.review && rv.reviewRef.current?.contains(document.activeElement)) void rv.discard()
    else onClose()
  }

  const ready = useConversationReady(c, connected, 'data-assistant-panel')
  const { skill } = composer
  const headerExtra = status?.enabled && status.reason !== 'encryption_enabled' ? (
    <>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm touch-target gap-1 px-2 text-meta" onClick={() => void c.toggleThreads()} aria-expanded={!!c.threads}>{t('History')}</button>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm touch-target gap-1 px-2 text-meta" onClick={c.startNew}>{t('New chat')}</button>
    </>
  ) : null
  return (
    <AssistantSheet title={t('Assistant')} onClose={onClose} onEscape={onEscape} headerExtra={headerExtra}
      footer={status?.reason === 'encryption_enabled' || !status?.enabled ? undefined : (
        <div className="space-y-1">
          <Composer draft={composer.draft} onDraft={composer.setDraft} onSend={() => void c.send()} onStop={c.stop} streaming={!!streaming} connected={connected} disabled={!ready}
            skills={composer.skills} skill={skill} onSkill={composer.chooseSkill} pasted={composer.pasted} onPasted={composer.setPasted}
            context={contextName(ctx.view, composer.selection?.length ?? ctx.selected?.length ?? 0)} />
          <div className="flex flex-wrap items-center justify-between gap-x-2 text-meta text-faint">
            <span data-testid="assistant-hint">{keptAway ? t('This project is kept away from assistants') : !connected ? t(OFFLINE_MESSAGE) : status ? `${status.provider === 'compatible' ? t('Model server') : status.provider_label}${status.model ? ` · ${status.model}` : ''}` : ''}</span>
            {c.threads && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm touch-target px-2 text-meta" onClick={() => void c.clearAll()}>{t('Clear conversations')}</button>}
          </div>
        </div>
      )}>
      <AssistantPanelBody status={status} connected={online} messages={c.thread?.messages ?? []} streaming={streaming} announce={c.live.announce}
        statusAnnounce={c.statusAnnounce} review={rv.review} result={rv.result} reviewBusy={rv.reviewBusy} error={c.error} draft={composer.draft}
        consentBusy={c.consent.consentBusy} consentError={c.consent.consentError} threads={c.threads} reviewRef={rv.reviewRef}
        onToggle={rv.toggle} onApply={() => void rv.apply()} onDiscard={() => void rv.discard()} onUndo={() => void rv.undo()} onDraft={composer.setDraft} onSend={() => void c.send()}
        onStop={c.stop} onAccept={(k) => void c.consent.accept(k)} onPickThread={c.pickThread}
        name={name} skills={composer.skills} onStarter={(s) => { composer.chooseSkill(s); focusComposer() }} layout="sheet" device={c.device} />
    </AssistantSheet>
  )
}
