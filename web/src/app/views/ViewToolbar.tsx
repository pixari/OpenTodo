// The view toolbar and its filter panel (OpenSpec change views-and-display, design D5):
// under the header, the query's conditions as chips and "Filter" on the left, the
// filter and display buttons on the right. The filter panel opens in place under the
// toolbar, so the results stay in view while the count follows the edit: the builder,
// then the formula line, which is the query input itself ("Edit as text" focuses it).
import type { ReactNode, RefObject } from 'react'
import { Button, IconButton } from '../../ui'
import { t } from '../../lib/i18n'
import { FilterChips } from './FilterChips'
import { DisplayPanel, type DisplayPanelProps, type ViewDisplay } from './DisplayPanel'

export interface ViewToolbarProps {
  /** The query the chips read. */
  query: string
  filterOpen: boolean
  setFilterOpen: (open: boolean) => void
  /** Called after "Filter" opened the panel to add a condition. */
  onAdd?: () => void
  display: ViewDisplay
  onDisplay: (patch: Partial<ViewDisplay>) => void
  /** A board's Colour by (calendar-clarity), shown in the display panel. */
  colorBy?: DisplayPanelProps['colorBy']
  /** Order by choices; a saved view's by default (the New view page has no Manual order, view-manual-order D7). */
  sortOptions?: DisplayPanelProps['sortOptions']
  sortFields?: DisplayPanelProps['sortFields']
}

export function ViewToolbar({ query, filterOpen, setFilterOpen, onAdd, display, onDisplay, colorBy, sortOptions, sortFields }: ViewToolbarProps) {
  return (
    <div className="mb-2 flex items-start gap-2" data-view-toolbar>
      <div className="min-w-0 flex-1">
        <FilterChips query={query} onOpen={(adding) => {
          setFilterOpen(true)
          if (adding) requestAnimationFrame(() => onAdd?.())
        }} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton icon="filter" size="sm" label={filterOpen ? t('Hide the filter') : t('Show the filter')} aria-pressed={filterOpen} data-filter-toggle
          className={filterOpen ? 'bg-selected text-default' : ''} onClick={() => setFilterOpen(!filterOpen)} />
        <DisplayPanel value={display} onChange={onDisplay} colorBy={colorBy} sortOptions={sortOptions} sortFields={sortFields} />
      </div>
    </div>
  )
}

export interface FilterPanelProps {
  /** Tasks the edited query matches, or null while unknown. */
  count: number | null
  onClose: () => void
  /** Starts the New view page over (its draft, sidebar-polish D5); absent elsewhere. */
  onClear?: () => void
  /** The builder, or the notice that replaces it. */
  builder: ReactNode
  /** The formula line: the query input. */
  formula: ReactNode
  /** Under the formula: the error or warning line, completions. */
  message?: ReactNode
  inputRef: RefObject<HTMLInputElement | null>
}

export function FilterPanel({ count, onClose, onClear, builder, formula, message, inputRef }: FilterPanelProps) {
  return (
    <section aria-label={t('Filter')} data-filter-panel className="mb-3 rounded-card border border-strong bg-pop">
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <h2 className="flex min-w-0 items-baseline gap-1.5 text-body font-medium text-strong">
          {t('Filter')}
          <span className="text-meta font-normal text-muted" aria-live="polite" data-filter-count>
            {count === null ? '' : t('{n, plural, one {# task matches} other {# tasks match}}', { n: count })}
          </span>
        </h2>
        {/* The New view page's draft starts over (filter-queries "New view keeps its draft"). */}
        {onClear && <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear} data-filter-clear>{t('Clear')}</Button>}
        <IconButton icon="x" size="sm" label={t('Close the filter')} className={onClear ? undefined : 'ml-auto'} onClick={onClose} />
      </header>
      <div className="px-3">{builder}</div>
      <div className="mx-3 mb-3 rounded-control bg-sunken p-1.5" data-filter-formula>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{formula}</div>
          <button type="button" className="shrink-0 rounded-control px-2 py-1 text-meta text-default hover:bg-raised"
            onClick={() => { inputRef.current?.focus(); inputRef.current?.select() }}>{t('Edit as text')}</button>
        </div>
        {message}
      </div>
    </section>
  )
}
