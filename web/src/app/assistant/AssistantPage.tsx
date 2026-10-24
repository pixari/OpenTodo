// The Assistant page (`/ask`, OpenSpec change assistant-surface D1): the same
// conversation as the side sheet, given the content surface. Empty, the composer sits
// in the middle under the greeting with the starter skills below it; once a
// conversation runs, the messages fill a centred column and the composer stays at
// the foot. Part of the lazy assistant chunk, like the sheet.
import { useOnline } from '../../lib/online'
import { t } from '../../lib/i18n'
import { Button, PageBody, PageHeader } from '../../ui'
import { Composer } from './AssistantComposer'
import { contextName, focusComposer, useConversationReady } from './AssistantPanel'
import { AssistantPanelBody, OFFLINE_MESSAGE } from './AssistantPanelBody'
import { useAssistantConversation } from './useAssistantConversation'

/** The page sends no view: a turn from here is about all the person's tasks, or the tasks a prefill names. */
const NO_CONTEXT = () => ({})
const noop = () => {}

export default function AssistantPage({ name }: { name: string }) {
  const online = useOnline()
  const c = useAssistantConversation({ context: NO_CONTEXT, onApplied: noop, userName: name })
  // A device turn needs no connection to this server (assistant-on-device).
  const connected = online || c.status?.mode === 'device'
  const ready = useConversationReady(c, connected, 'data-assistant-page')
  const { status, composer, review: rv, streaming } = c
  const usable = !!status?.enabled && status.reason !== 'encryption_enabled'
  const empty = (c.thread?.messages.length ?? 0) === 0 && !streaming && !c.threads
  const composerFor = (large: boolean) => (
    <Composer draft={composer.draft} onDraft={composer.setDraft} onSend={() => void c.send()} onStop={c.stop} streaming={!!streaming} connected={connected} disabled={!ready}
      skills={composer.skills} skill={composer.skill} onSkill={composer.chooseSkill} pasted={composer.pasted} onPasted={composer.setPasted}
      context={contextName(undefined, composer.selection?.length ?? 0)} large={large}
      placeholder={large ? t('Ask about your tasks, or tell me what to plan…') : t('Reply or ask for changes…')} />
  )
  return (
    <PageBody width="list" flush className="flex min-h-full flex-col" data-assistant-page tabIndex={-1}
      onKeyDown={(e) => {
        // Esc in a proposal discards it, as in the sheet (in-app-assistant "Reviewable change sets").
        if (e.key === 'Escape' && rv.review && rv.reviewRef.current?.contains(e.target as Node)) {
          e.preventDefault()
          e.stopPropagation()
          void rv.discard()
        }
      }}>
      <PageHeader title={t('Assistant')} help="ask" barActions
        actions={usable ? (
          <>
            <Button variant="ghost" size="sm" icon="history" onClick={() => void c.toggleThreads()} aria-expanded={!!c.threads}>{t('History')}</Button>
            <Button variant="secondary" size="sm" icon="plus" onClick={c.startNew}>{t('New chat')}</Button>
          </>
        ) : undefined} />
      <div className="mx-auto w-full max-w-[46rem] flex-1 py-4">
        <AssistantPanelBody status={status} connected={online} messages={c.thread?.messages ?? []} streaming={streaming} announce={c.live.announce}
          statusAnnounce={c.statusAnnounce} review={rv.review} result={rv.result} reviewBusy={rv.reviewBusy} error={c.error} draft={composer.draft}
          consentBusy={c.consent.consentBusy} consentError={c.consent.consentError} threads={c.threads} reviewRef={rv.reviewRef}
          onToggle={rv.toggle} onApply={() => void rv.apply()} onDiscard={() => void rv.discard()} onUndo={() => void rv.undo()} onDraft={composer.setDraft} onSend={() => void c.send()}
          onStop={c.stop} onAccept={(k) => void c.consent.accept(k)} onPickThread={c.pickThread}
          name={name} skills={composer.skills} onStarter={(s) => { composer.chooseSkill(s); focusComposer() }} composer={composerFor(true)} layout="page" device={c.device} />
      </div>
      {usable && !empty && (
        <div className="sticky bottom-0 mx-auto w-full max-w-[46rem] space-y-1 bg-surface pb-4 pt-2" data-assistant-foot>
          {composerFor(false)}
          <div className="flex flex-wrap items-center justify-between gap-x-2 text-meta text-faint">
            <span data-testid="assistant-hint">{!connected ? t(OFFLINE_MESSAGE) : status ? `${status.provider === 'compatible' ? t('Model server') : status.provider_label}${status.model ? ` · ${status.model}` : ''}` : ''}</span>
            {c.threads && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm touch-target px-2 text-meta" onClick={() => void c.clearAll()}>{t('Clear conversations')}</button>}
          </div>
        </div>
      )}
    </PageBody>
  )
}
