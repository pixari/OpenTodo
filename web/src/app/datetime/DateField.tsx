// Date field of task editing (OpenSpec change date-time-preferences, design D4): a
// text field that shows the date in the user's format and accepts it typed, as ISO
// or as a phrase (tomorrow, fri), plus a calendar whose weeks start on the user's
// first day. The calendar is a role=grid month view operated by keyboard: arrows
// move by day and week, Page Up/Down by month, Home/End to the week's edges, Enter
// picks and Escape closes.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { addDaysISO, formatDate, logicalToday, weekStartOf, type ResolvedDateTime, dateLocaleOf } from '../../lib/dates'
import { addMonths } from '../../lib/nlp/dates'
import { loadQuickAddSettings, resolveLanguages } from '../../lib/nlp/settings'
import { IconButton, Popover } from '../../ui'
import { Field, Input } from '../../ui'
import { useDateTimeFormat } from '../DateTimePrefsProvider'
import { parseDateInput } from './parse'
import { t, preferredLanguages } from '../../lib/i18n'

export interface DateFieldProps {
  /** `YYYY-MM-DD`, or null when empty. */
  value: string | null
  onChange: (iso: string | null) => void
  label: string
  hideLabel?: boolean
  disabled?: boolean
  className?: string
  /** Width of the text field (Tailwind classes). */
  inputClassName?: string
  autoFocus?: boolean
  /** A message when a parsed date is not allowed here (it is then not saved), else null. */
  validate?: (iso: string) => string | null
}

/** The browser's languages for relative words, as quick add reads them. */
export function inputLanguages(): string[] {
  const browser = preferredLanguages()
  return resolveLanguages(loadQuickAddSettings(), browser)
}

export function DateField({ value, onChange, label, hideLabel, disabled, className, inputClassName = 'min-w-0 flex-1', autoFocus, validate }: DateFieldProps) {
  const { resolved } = useDateTimeFormat()
  const shown = value ? formatDate(value, 'numeric', resolved) : ''
  const [draft, setDraft] = useState(shown)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  // A new value from outside (another device, the calendar) replaces the text.
  useEffect(() => { setDraft(shown); setError(null) }, [shown])

  const commit = () => {
    const text = draft.trim()
    if (text === shown.trim()) return setError(null)
    if (!text) {
      setError(null)
      if (value !== null) onChange(null)
      return
    }
    const iso = parseDateInput(text, { today: logicalToday(), prefs: resolved, languages: inputLanguages() })
    if (!iso) {
      setError(t('Not a valid date. Try {example}, {iso} or “tomorrow”.', { example: formatDate(logicalToday(), 'numeric', resolved), iso: logicalToday() }))
      return
    }
    const refused = validate?.(iso)
    if (refused) return setError(refused)
    setError(null)
    setDraft(formatDate(iso, 'numeric', resolved))
    if (iso !== value) onChange(iso)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault()
      setOpen(true)
    } else if (e.key === 'Escape' && draft !== shown) {
      // First Escape restores the shown value; the next one reaches the panel.
      e.stopPropagation()
      setDraft(shown)
      setError(null)
    }
  }

  return (
    <div className={className}>
      <Field label={label} hideLabel={hideLabel} error={error}>
        <div className="flex items-center gap-1">
          <Input className={inputClassName} value={draft} disabled={disabled} autoComplete="off" spellCheck={false} autoFocus={autoFocus}
            placeholder={formatDate(logicalToday(), 'numeric', resolved)} aria-keyshortcuts="Alt+ArrowDown"
            onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />
          <IconButton ref={button} icon="calendar-days" label={t('Open calendar')} disabled={disabled}
            aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
        </div>
      </Field>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} label={t('Choose a date')} width="sm:w-72" className="p-3">
        <CalendarGrid value={value} prefs={resolved} onPick={(iso) => { setOpen(false); const refused = validate?.(iso); setError(refused ?? null); if (!refused && iso !== value) onChange(iso) }} />
      </Popover>
    </div>
  )
}

const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`
const dateOf = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d) }
const monthName = () => new Intl.DateTimeFormat(dateLocaleOf(), { month: 'long', year: 'numeric' })
const fullDate = () => new Intl.DateTimeFormat(dateLocaleOf(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const shortDay = () => new Intl.DateTimeFormat(dateLocaleOf(), { weekday: 'short' })

/** The month grid: six weeks starting on the preferred first day, one focusable day at a time. */
export function CalendarGrid({ value, prefs, onPick, today = logicalToday(), compact = false, marked }: {
  value: string | null
  prefs: ResolvedDateTime
  onPick: (iso: string) => void
  today?: string
  /** Inline in the When popover: smaller days and no hint line. */
  compact?: boolean
  /** One day to mark with a dot and name in its label, such as the deadline (inbox-means-unplaced D8). */
  marked?: { date: string; label: string }
}) {
  const [cursor, setCursor] = useState(value ?? today)
  const grid = useRef<HTMLTableElement>(null)
  const headingId = useId()
  const month = firstOfMonth(cursor)
  const days = useMemo(() => {
    const start = weekStartOf(month, prefs)
    return Array.from({ length: 42 }, (_, i) => addDaysISO(start, i))
  }, [month, prefs])
  const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7))

  // The focused day follows the cursor (roving tabindex).
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)?.focus()
  }, [cursor])

  const move = (next: string) => { moved.current = true; setCursor(next) }
  const shiftMonth = (n: number) => {
    const target = addMonths(cursor, n)
    move(target)
  }

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, () => void> = {
      ArrowLeft: () => move(addDaysISO(cursor, -1)),
      ArrowRight: () => move(addDaysISO(cursor, 1)),
      ArrowUp: () => move(addDaysISO(cursor, -7)),
      ArrowDown: () => move(addDaysISO(cursor, 7)),
      PageUp: () => shiftMonth(e.shiftKey ? -12 : -1),
      PageDown: () => shiftMonth(e.shiftKey ? 12 : 1),
      Home: () => move(weekStartOf(cursor, prefs)),
      End: () => move(addDaysISO(weekStartOf(cursor, prefs), 6)),
      Enter: () => onPick(cursor),
      ' ': () => onPick(cursor),
    }
    const fn = step[e.key]
    if (!fn) return
    e.preventDefault()
    fn()
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <IconButton icon="chevron-left" label={t('Previous month')} size="sm" onClick={() => shiftMonth(-1)} />
        <h3 id={headingId} className="flex-1 text-center text-body font-semibold text-default" aria-live="polite">{monthName().format(dateOf(month))}</h3>
        <IconButton icon="chevron-right" label={t('Next month')} size="sm" onClick={() => shiftMonth(1)} />
      </div>
      {/* On touch no gap around the 44 px days, so seven fit a phone with a large text size (precision-polish-2). */}
      <table ref={grid} role="grid" aria-labelledby={headingId} className="w-full border-collapse text-center text-body" onKeyDown={onKey}>
        <thead>
          <tr>
            {days.slice(0, 7).map((d) => (
              <th key={d} scope="col" className="pb-1 text-meta font-medium text-muted" abbr={new Intl.DateTimeFormat(dateLocaleOf(), { weekday: 'long' }).format(dateOf(d))}>
                {shortDay().format(dateOf(d))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const outside = d.slice(0, 7) !== month.slice(0, 7)
                const selected = d === value
                const isToday = d === today
                const isMarked = marked?.date === d
                return (
                  <td key={d} role="gridcell" aria-selected={selected} className="p-0.5 pointer-coarse:p-0">
                    <button type="button" data-date={d} tabIndex={d === cursor ? 0 : -1} data-autofocus={d === cursor ? '' : undefined}
                      aria-label={isMarked ? `${fullDate().format(dateOf(d))}, ${marked.label}` : fullDate().format(dateOf(d))} aria-current={isToday ? 'date' : undefined}
                      data-marked={isMarked || undefined}
                      onClick={() => onPick(d)}
                      className={[
                        `touch-target relative flex ${compact ? 'h-7 text-meta' : 'h-9'} w-full items-center justify-center rounded-control tabular-nums transition duration-(--duration-ui)`,
                        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
                        selected ? 'bg-accent font-semibold text-on-accent' : outside ? 'text-faint hover:bg-sunken' : 'text-default hover:bg-sunken',
                        isToday && !selected ? 'font-semibold text-accent ring-1 ring-inset ring-accent' : '',
                      ].join(' ')}>
                      {Number(d.slice(8))}
                      {isMarked && <span aria-hidden="true" className={`absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full ${selected ? 'bg-on-accent' : 'bg-warning'}`} />}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {compact
        ? <p className="sr-only">{t('Arrows move by day and week, Page Up and Page Down by month.')}</p>
        : <p className="mt-2 text-meta text-muted">{t('Arrows move by day and week, Page Up and Page Down by month.')}</p>}
    </div>
  )
}
