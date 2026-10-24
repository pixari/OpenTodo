// The command bar's own parts (OpenSpec change moments-and-onboarding, design D7;
// palette-quick-add D3, D6): the segmented control (phones and touch screens), the
// footer that names the keys and the prefixes (a fine pointer), Add mode (the quick-add
// palette with the opening screen's defaults) and Ask mode (one line handed to the
// assistant panel on Enter; nothing is sent before).
import { useRef, useState, type FormEvent } from 'react'
import { useLabels, useProjects } from '../../lib/localData'
import { t } from '../../lib/i18n'
import { Icon, KeySequence } from '../../ui'
import { HelpLink } from '../help/HelpLink'
import { QuickAdd, type QuickAddInput } from '../QuickAdd'
import { ask } from '../assistant/AskEntry'
import { MODE_LABEL, PREFIX_OF, type BarMode } from './modes'

/** A command's keys at the right of its row (palette-quick-add D5): each alternative as keycaps, a sequence with "then". */
export function ShortcutKeys({ keys }: { keys: string }) {
  const alternatives = keys.split(' / ')
  return (
    <span className="inline-flex items-center gap-1.5" data-shortcut-keys>
      {alternatives.map((a, i) => <span key={a} className="inline-flex items-center gap-1.5">{i > 0 && <span className="text-faint">{t('or')}</span>}<KeySequence keys={a} /></span>)}
    </span>
  )
}

/** Search, Add, Commands and (when available) Ask, as one radio group under the field. */
export function ModeSwitch({ modes, mode, onMode }: { modes: BarMode[]; mode: BarMode; onMode: (m: BarMode) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = modes.indexOf(mode)
    const next = modes[(i + (e.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length]
    onMode(next)
    refs.current[next]?.focus()
  }
  return (
    // On a desktop with a mouse the footer names the prefixes instead (palette-quick-add D6).
    // With a large text size the modes wrap to a second line instead of overflowing (precision-polish-2).
    <div role="radiogroup" aria-label={t('Mode')} onKeyDown={move} className="mx-3 mt-2 flex flex-wrap gap-1 rounded-control bg-sunken p-0.5 sm:pointer-fine:hidden" data-bar-modes>
      {modes.map((m) => {
        const checked = m === mode
        return (
          <button key={m} ref={(el) => { refs.current[m] = el }} type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1}
            onClick={() => onMode(m)} data-bar-mode={m}
            className={`min-h-8 min-w-fit flex-1 rounded-chip px-2 text-meta font-medium ${checked ? 'bg-surface text-strong shadow-1' : 'text-muted hover:text-default'}`}>
            {MODE_LABEL[m]}
          </button>
        )
      })}
    </div>
  )
}

/** Search and Commands' footer: the keys that choose and run, the prefixes and Help (palette-quick-add D6). */
export function BarFooter({ ask: withAsk }: { ask: boolean }) {
  const key = (k: string) => <kbd className="ui-kbd">{k}</kbd>
  return (
    <div className="flex items-center gap-3.5 border-t border-default bg-raised px-3.5 py-2 text-meta text-muted" data-bar-hint>
      <span className="hidden items-center gap-3.5 sm:pointer-fine:flex">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <kbd className="ui-kbd"><Icon name="arrow-up" size="xs" /><span className="sr-only">{t('Up')}</span></kbd><kbd className="ui-kbd"><Icon name="arrow-down" size="xs" /><span className="sr-only">{t('Down')}</span></kbd>{t('Choose')}
        </span>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">{key('Enter')}{t('Run')}</span>
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-right sm:pointer-fine:block">
        {withAsk
          ? t.rich('Type {add} to add, {commands} for commands, {ask} to ask', { add: key(PREFIX_OF.add), commands: key(PREFIX_OF.commands), ask: key(PREFIX_OF.ask) })
          : t.rich('Type {add} to add, {commands} for commands', { add: key(PREFIX_OF.add), commands: key(PREFIX_OF.commands) })}
      </span>
      <span className="flex-1 sm:pointer-fine:hidden" />
      <HelpLink screen="palette" topic={t('Search and commands')} />
    </div>
  )
}

/**
 * Add mode: the quick-add palette (field rows, the title and the keys). Enter adds and
 * keeps the field, empty and focused; Shift+Enter adds and opens the task.
 */
export function AddPanel({ onAdd, onAddAndOpen, initial, escape }: {
  onAdd: (input: QuickAddInput) => Promise<unknown>
  onAddAndOpen: (input: QuickAddInput) => Promise<unknown>
  initial?: string
  escape: { label: string; run: () => void }
}) {
  const projects = useProjects()
  const labels = useLabels()
  return (
    <div data-bar-add>
      <QuickAdd layout="palette" autoFocus hideHint initialValue={initial} placeholder={t('Add a task…')} label={t('Add a task')} projects={projects} labels={labels}
        onAdd={async (input) => { await onAdd(input) }} onAddAndOpen={async (input) => { await onAddAndOpen(input) }} escape={escape} />
    </div>
  )
}

/** Ask mode: one line for the assistant; Enter opens the panel with it sent as one turn. */
export function AskPanel({ onSent }: { onSent: () => void }) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const line = text.trim()
    if (!line) return
    ask({ text: line, send: true })
    onSent()
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-2.5 border-b border-default px-4 py-2.5 sm:pr-11" data-bar-ask>
      <Icon name="message-circle" className="shrink-0 text-accent" />
      <input className="ui-input border-transparent bg-transparent px-1 text-prose shadow-none focus:border-transparent focus:ring-0 dark:bg-transparent" autoFocus
        value={text} onChange={(e) => setText(e.target.value)} aria-label={t('Ask the assistant')} placeholder={t('Ask about your tasks…')} enterKeyHint="send" data-bar-ask-input />
    </form>
  )
}
