// The display panel of a view (OpenSpec change views-and-display, design D2): how the
// results are shown, never which tasks match. Layout, grouping, order, completed tasks
// and the properties a row shows; the sort direction is folded under "More options".
// Opened from the toolbar's display button; every change applies at once. Project and
// label pages show the same panel with the parts they have (list-display-options D2):
// a part whose value is absent is left out.
import { useRef, useState, type ReactNode } from 'react'
import { Icon, IconButton, Popover, Switch, type IconName } from '../../ui'
import {
  GROUP_BY_OPTIONS, ROW_PROPERTIES, SORT_BY_OPTIONS, VIEW_LAYOUTS,
  type FieldDef, type GroupBy, type RowProperty, type SortBy, type SortDir, type ViewLayout,
} from '../../lib/types'
import { msg, t, translatedMap } from '../../lib/i18n'
import type { ListGroupBy } from '../../lib/listDisplay'
import { ROW_LAYOUTS, type RowLayout } from '../../lib/rowLayout'
import { COLOR_BY_MODES, type ColorByMode } from '../../lib/colorBy'
import { COLOR_BY_LABEL } from '../calendar/colorByControls'
import { fieldSortOptions } from '../../lib/fieldSortOptions'

export interface ViewDisplay {
  layout: ViewLayout
  groupBy: GroupBy
  sortBy: SortBy
  sortDir: SortDir
  showCompleted: boolean
  hidden: readonly RowProperty[]
  /** The view's own row layout (row-layouts); absent follows the account's. */
  rowLayout?: RowLayout
  /** The Board layout's notes preview (board-polish D4); off by default. */
  cardNotes?: boolean
}

/** What the panel shows: a part without a value (layout, completed tasks, row properties) is left out. */
export interface PanelValue {
  groupBy: ListGroupBy
  sortBy: SortBy
  sortDir: SortDir
  layout?: ViewLayout
  showCompleted?: boolean
  hidden?: readonly RowProperty[]
  /** One line or detailed rows (row-layouts). */
  rowLayout?: RowLayout
  /** Notes on cards, offered only while the layout is Board (board-polish D4). */
  cardNotes?: boolean
}

export const GROUP_LABEL = translatedMap<ListGroupBy>({ project: msg('Project'), due: msg('Due date'), priority: msg('Priority'), label: msg('Label'), none: msg('None'), section: msg('Section') })
export const SORT_LABEL = translatedMap<SortBy>({ due: msg('Due date'), priority: msg('Priority'), position: msg('Manual order'), created: msg('Created'), deadline: msg('Deadline'), title: msg('Title') })
const LAYOUT_LABEL = translatedMap<ViewLayout>({ list: msg('List'), board: msg('Board') })
const LAYOUT_ICON: Record<ViewLayout, IconName> = { list: 'list', board: 'kanban' }
export const ROW_LAYOUT_LABEL = translatedMap<RowLayout>({ line: msg('One line'), detailed: msg('Detailed') })
const ROW_LAYOUT_ICON: Record<RowLayout, IconName> = { line: 'rows-3', detailed: 'rows-2' }
export const PROPERTY_LABEL = translatedMap<RowProperty>({
  date: msg('Date'), project: msg('Project'), labels: msg('Labels'), estimate: msg('Estimate'), assignee: msg('Assignee'),
  deadline: msg('Deadline'), start: msg('Start'), origin: msg('Origin'), energy: msg('Energy'),
})

export interface DisplayPanelProps<V extends PanelValue = ViewDisplay> {
  value: V
  onChange: (patch: Partial<V>) => void
  /** Group by choices, in order; a view's by default. */
  groupOptions?: readonly V['groupBy'][]
  /** Order by choices, in order; a view's by default. */
  sortOptions?: readonly SortBy[]
  /** Live definitions used to offer local-only custom-field sorts. */
  sortFields?: readonly FieldDef[]
  /** A board's Colour by (calendar-clarity "Colour by on boards"): a device choice for every board, not part of the view. */
  colorBy?: { mode: ColorByMode; onChange: (mode: ColorByMode) => void }
}

/** The toolbar's display button and its panel. */
export function DisplayPanel<V extends PanelValue = ViewDisplay>(props: DisplayPanelProps<V>) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <IconButton ref={anchor} icon="sliders-horizontal" size="sm" label={t('Display options')} aria-haspopup="dialog" aria-expanded={open}
        data-display-trigger className={open ? 'bg-selected text-default' : ''} onClick={() => setOpen(!open)} />
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('Display options')} width="sm:w-[22rem]" className="p-0">
        <DisplayOptionsBody {...props} />
      </Popover>
    </>
  )
}

/** The panel's content; also rendered on its own in stories and tests. */
export function DisplayOptionsBody<V extends PanelValue = ViewDisplay>({ value, onChange: change, groupOptions = GROUP_BY_OPTIONS as readonly V['groupBy'][], sortOptions = SORT_BY_OPTIONS, sortFields = [], colorBy }: DisplayPanelProps<V>) {
  const [more, setMore] = useState(false)
  const onChange = (patch: Partial<PanelValue>) => change(patch as Partial<V>)
  const hiddenNow = value.hidden
  const fieldOptions = fieldSortOptions(sortFields, value.sortBy, t('Unavailable custom field'))
  const toggle = (p: RowProperty) => {
    if (!hiddenNow) return
    const hidden = hiddenNow.includes(p) ? hiddenNow.filter((x) => x !== p) : [...hiddenNow, p]
    onChange({ hidden: ROW_PROPERTIES.filter((x) => hidden.includes(x)) })
  }
  const layout = value.layout
  return (
    <div data-display-panel className="text-meta">
      <div className="space-y-2 p-3">
        {layout !== undefined && (
          <Choice label={t('Layout')} items={VIEW_LAYOUTS} value={layout} labels={LAYOUT_LABEL} icons={LAYOUT_ICON} attr="layout" onChange={(l) => onChange({ layout: l })} />
        )}
        {value.rowLayout !== undefined && (
          <Choice label={t('Rows')} items={ROW_LAYOUTS} value={value.rowLayout} labels={ROW_LAYOUT_LABEL} icons={ROW_LAYOUT_ICON} attr="row-layout" onChange={(r) => onChange({ rowLayout: r })} />
        )}
        <OptionRow label={t('Group by')}>
          <select className="ui-input w-full py-1 text-meta" aria-label={t('Group by')} value={value.groupBy}
            onChange={(e) => onChange({ groupBy: e.target.value as ListGroupBy })}>
            {groupOptions.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
          </select>
        </OptionRow>
        <OptionRow label={t('Order by')}>
          <select className="ui-input w-full py-1 text-meta" aria-label={t('Order by')} value={value.sortBy}
            onChange={(e) => onChange({ sortBy: e.target.value as SortBy })}>
            {sortOptions.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
            {fieldOptions.length > 0 && <optgroup label={t('Custom fields')}>
              {fieldOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </optgroup>}
          </select>
        </OptionRow>
        {colorBy && (
          <OptionRow label={t('Colour by')}>
            <select className="ui-input w-full py-1 text-meta" aria-label={t('Colour by')} value={colorBy.mode} data-display-color-by
              onChange={(e) => colorBy.onChange(e.target.value as ColorByMode)}>
              {COLOR_BY_MODES.map((m) => <option key={m} value={m}>{COLOR_BY_LABEL[m]}</option>)}
            </select>
          </OptionRow>
        )}
        {value.showCompleted !== undefined && <OptionRow label={t('Completed tasks')}>
          <select className="ui-input w-full py-1 text-meta" aria-label={t('Completed tasks')} value={value.showCompleted ? 'show' : 'hide'}
            onChange={(e) => onChange({ showCompleted: e.target.value === 'show' })}>
            <option value="hide">{t('Hide')}</option>
            <option value="show">{t('Show')}</option>
          </select>
        </OptionRow>}
      </div>
      {hiddenNow && <div className="border-t border-soft p-3">
        <p id="display-props-label" className="mb-2 text-muted">{t('Show on rows')}</p>
        <div role="group" aria-labelledby="display-props-label" className="flex flex-wrap gap-1.5" data-display-props>
          {ROW_PROPERTIES.map((p) => {
            const shown = !hiddenNow.includes(p)
            return (
              <button key={p} type="button" aria-pressed={shown} data-prop={p} onClick={() => toggle(p)}
                className={`touch-target rounded-chip border px-2.5 py-1 ${shown ? 'border-strong bg-raised text-strong' : 'border-soft text-faint hover:text-muted'}`}>
                {PROPERTY_LABEL[p]}
              </button>
            )
          })}
        </div>
        {layout === 'board' && value.cardNotes !== undefined && (
          <div className="mt-3" data-display-card-notes>
            <Switch checked={value.cardNotes} onChange={(on) => onChange({ cardNotes: on })} label={t('Notes on cards')} />
          </div>
        )}
      </div>}
      <div className="border-t border-soft">
        <button type="button" aria-expanded={more} onClick={() => setMore(!more)} data-display-more
          className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-default hover:bg-sunken">
          <Icon name="chevron-right" size="xs" className={`text-faint transition-transform duration-(--duration-ui) ${more ? 'rotate-90' : ''}`} />
          {t('More options')}
          <span className="ml-auto truncate text-faint">{t('Sort direction')}</span>
        </button>
        {more && (
          <div className="px-3 pb-3">
            <OptionRow label={t('Direction')}>
              <select className="ui-input w-full py-1 text-meta" aria-label={t('Sort direction')} value={value.sortDir}
                onChange={(e) => onChange({ sortDir: e.target.value as SortDir })}>
                <option value="asc">{value.sortBy === 'priority' ? t('Ascending (p4 first)') : t('Ascending')}</option>
                <option value="desc">{value.sortBy === 'priority' ? t('Descending (p1 first)') : t('Descending')}</option>
              </select>
            </OptionRow>
          </div>
        )}
      </div>
    </div>
  )
}

/** A two-way choice as a segmented radio group; the arrow keys move the choice and the focus. */
function Choice<T extends string>({ label, items, value, labels, icons, attr, onChange }: {
  label: string; items: readonly T[]; value: T; labels: Record<T, string>; icons: Record<T, IconName>; attr: string; onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-0.5 rounded-control bg-sunken p-0.5" {...{ [`data-display-${attr}`]: '' }}>
      {items.map((l) => (
        <button key={l} type="button" role="radio" aria-checked={value === l}
          className={`touch-target flex min-w-0 items-center justify-center gap-1.5 rounded-control px-3 py-1.5 ${value === l ? 'bg-raised text-strong shadow-1' : 'text-muted hover:text-default'}`}
          onClick={() => onChange(l)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const next = items[(items.indexOf(value) + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length]
            onChange(next)
            ;(e.currentTarget.parentElement?.querySelector(`[data-${attr}="${next}"]`) as HTMLElement | null)?.focus()
          }}
          {...{ [`data-${attr}`]: l }} tabIndex={value === l ? 0 : -1}>
          <Icon name={icons[l]} /><span className="truncate">{labels[l]}</span>
        </button>
      ))}
    </div>
  )
}

function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_10rem] items-center gap-3">
      <span className="text-muted" aria-hidden>{label}</span>
      {children}
    </div>
  )
}
