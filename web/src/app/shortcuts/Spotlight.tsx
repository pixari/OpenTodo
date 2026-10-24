// The sequence spotlight (OpenSpec change shortcut-spotlight, keyboard-shortcuts
// "Sequence spotlight"): when the user hesitates after the first key of a sequence
// (`g`), a small card in the centre of the screen shows the key pressed, waits for
// the second one without expiring, and lists what can complete it here. It never
// takes focus: keys keep going to the one dispatcher, so a listed key runs its
// shortcut, any other key ends the sequence, and Esc cancels. A click on an entry
// runs it; the close button or a click outside cancels.
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { type Chord, chordText, labelMessage, shortcut, spotlightGroup, type Shortcut, type SpotlightGroup } from '../../lib/shortcuts'
import { t } from '../../lib/i18n'
import { IconButton } from '../../ui'
import { clearPrefix, type Continuation, dispatch, hasScope, holdPrefix, pendingContinuations, pendingPrefix, subscribePrefix } from './dispatch'

/** How long a hesitation lasts before the spotlight shows (design D2). */
export const SPOTLIGHT_DELAY_MS = 250

const GROUPS: { id: SpotlightGroup; readonly title: string }[] = [
  { id: 'views', get title() { return t('Views') } },
  { id: 'calendar', get title() { return t('Calendar') } },
  { id: 'method', get title() { return t('Review and planning') } },
  { id: 'tools', get title() { return t('Tools') } },
]

/** The label of an entry in the interface language. */
export function shortcutLabel(s: Pick<Shortcut, 'label' | 'description'>): string {
  const { message, context } = labelMessage(s)
  return context ? t(message, { context }) : t(message)
}

/** A key press that completes the sequence with this chord (for a click on an entry). */
function pressOf(c: Chord): KeyboardEvent {
  const letter = /^[a-z]$/.test(c.key)
  const key = c.key === 'escape' ? 'Escape' : c.key === 'enter' ? 'Enter' : letter && c.shift ? c.key.toUpperCase() : c.key
  return new KeyboardEvent('keydown', { key, shiftKey: c.shift, altKey: c.alt, ctrlKey: c.ctrl === 'ctrl', metaKey: c.ctrl === 'meta', cancelable: true })
}

/** What the spotlight lists for the pending prefix: the dispatcher's continuations, plus Vim's `gg`. */
function entriesNow(): Continuation[] {
  const list = pendingContinuations()
  const pend = pendingPrefix()
  // `gg` is the Vim machine's own (it consumes the second `g` before the registry).
  if (pend.length === 1 && pend[0].key === 'g' && !pend[0].shift && hasScope('vim')) {
    list.unshift({ entry: shortcut('vim.first'), next: { key: 'g', ctrl: false, alt: false, shift: false, symbol: false } })
  }
  return list
}

function usePrefix(): Chord[] {
  return useSyncExternalStore(subscribePrefix, pendingPrefix, () => [])
}

/** `delay` is the hesitation before it shows; stories pass 0 to show an armed prefix at once. */
export function Spotlight({ delay = SPOTLIGHT_DELAY_MS }: { delay?: number }) {
  const prefix = usePrefix()
  const [shown, setShown] = useState(() => delay === 0 && pendingPrefix().length > 0)
  const titleId = useId()

  useEffect(() => {
    if (!prefix.length) { setShown(false); return }
    const show = () => {
      if (!pendingPrefix().length || !entriesNow().length) return
      holdPrefix(true)
      setShown(true)
    }
    if (delay === 0) { show(); return }
    const timer = window.setTimeout(show, delay)
    return () => window.clearTimeout(timer)
  }, [prefix, delay])

  if (!shown || !prefix.length || typeof document === 'undefined') return null
  const entries = entriesNow()
  if (!entries.length) return null
  const cancel = () => clearPrefix()
  const run = (c: Continuation) => { dispatch(pressOf(c.next)) }
  const groups = GROUPS.map((g) => ({ ...g, items: entries.filter((c) => (c.entry.scope === 'vim' ? 'tools' : spotlightGroup(c.entry.id)) === g.id) })).filter((g) => g.items.length)
  const pressed = prefix.map(chordText)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4" data-overlay-root
      onPointerDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); cancel() } }}>
      <div role="dialog" aria-modal="false" aria-labelledby={titleId} data-spotlight data-overlay="spotlight"
        className="spotlight-in surface-overlay w-[30rem] max-w-full p-4">
        <div className="mb-3 flex items-center gap-2">
          <p id={titleId} className="flex min-w-0 flex-1 items-center gap-2 text-body">
            {pressed.map((k, i) => <kbd key={i} className="ui-kbd text-meta">{k}</kbd>)}
            <span aria-hidden className="text-muted">+</span>
            <span className="truncate text-muted">{t('Press a key')}</span>
          </p>
          <IconButton icon="x" size="sm" label={t('Cancel')} onClick={cancel} data-overlay-close />
        </div>
        <p className="sr-only" role="status">{t('Press a key')}</p>
        <div className="max-h-[60dvh] space-y-3 overflow-y-auto overscroll-contain" data-scroll-y>
          {groups.map((g) => (
            <section key={g.id} aria-label={g.title}>
              <h3 className="mb-1 text-hint font-semibold uppercase tracking-wide text-faint">{g.title}</h3>
              <ul className="grid grid-cols-1 gap-x-3 min-[25rem]:grid-cols-2">
                {g.items.map((c) => (
                  <li key={c.entry.id}>
                    <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded-control px-1.5 text-left text-body hover:bg-sunken focus-visible:outline-2 focus-visible:outline-focus dark:hover:bg-raised"
                      onClick={() => run(c)} data-spotlight-entry={c.entry.id}>
                      <kbd className="ui-kbd inline-flex min-w-6 justify-center">{chordText(c.next)}</kbd>
                      <span className="min-w-0 truncate">{shortcutLabel(c.entry)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
