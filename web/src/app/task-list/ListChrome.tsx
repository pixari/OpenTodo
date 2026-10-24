// The task list's page furniture (OpenSpec change web-component-structure): page
// actions, the layout switch, the duration filter, empty views, the "complete the
// parent too?" prompt and the label and assignee dialogs. Each is a small
// component with props only; TaskListView decides when they show.
import type { ReactNode } from 'react'
import { DURATION_FILTERS, type DurationFilter } from '../../lib/filters'
import { msg, t, translatedMap } from '../../lib/i18n'
import type { ProjectViewMode } from '../../lib/sections'
import { keysOf } from '../../lib/shortcuts'
import type { AccountRole, Label, Place, Project, Task } from '../../lib/types'
import { Button, DESKTOP_HEADER_QUERY, EmptyState as EmptyStatePattern, type EmptyStateAction, type EmptyStateLink, Icon, type IconName, type IllustrationName, IconButton, MenuGroup, MenuItem, MenuSeparator, Tooltip, useMediaQuery } from '../../ui'
import { TodayAskAction, useTodayAsk } from '../assistant/AskEntry'
import { AssigneePicker } from '../AssigneePicker'
import { DEFAULT_DISPLAY_OPTIONS } from '../display/displayOptions'
import { LabelPicker } from '../LabelPicker'
import type { ActionGroup, ActionItem } from '../menus/ActionMenu'
import { Dialog, Menu } from '../../ui'
import { navigate } from '../router'
import { requestProjectNote } from '../ProjectNote'
import { RowScheduleHost } from './RowSwipe'
import { Kbd } from '../shortcuts/Kbd'
import type { ListRoute } from './useListModel'

/** The project layouts, in `v` order (month-and-timeline-views). */
export const LAYOUT_LABEL = translatedMap<ProjectViewMode>({ list: msg('List'), board: msg('Board'), timeline: msg('Timeline') })

/** The project header's List / Board / Timeline switch. */
export function LayoutSwitch({ mode, onChoose }: { mode: ProjectViewMode; onChoose: (m: ProjectViewMode) => void }) {
  return (
    <span className="flex rounded-control border border-default text-meta" role="group" aria-label={t('Project layout')}>
      {(['list', 'board', 'timeline'] as const).map((m) => (
        <Tooltip key={m} label={LAYOUT_LABEL[m]} shortcut={keysOf('project.view-mode')}>
          <button type="button" aria-pressed={mode === m} onClick={() => onChoose(m)}
            className={`${m === 'list' ? 'rounded-l-control' : m === 'timeline' ? 'rounded-r-control' : ''} px-2 py-1 ${mode === m ? 'bg-sunken font-medium dark:bg-raised' : 'text-muted hover:bg-sunken dark:hover:bg-raised'}`}>
            {LAYOUT_LABEL[m]}
          </button>
        </Tooltip>
      ))}
    </span>
  )
}

/**
 * Page actions (ux-overhaul, task-list-presentation): the header row holds them, so
 * nothing sits between the quick add and the first task. Touch screens have no
 * hover: the Select button shows every checkbox (bulk-edit D3).
 */
export function ListPageActions({ route, userRole, rowCount, selectMode, onSelectMode, filterKey, duration, onDuration }: {
  route: ListRoute
  userRole?: AccountRole
  rowCount: number
  selectMode: boolean
  onSelectMode: () => void
  filterKey: string | null
  duration: DurationFilter | null
  onDuration: (kind: DurationFilter | null) => void
}) {
  return (
    <>
      {route.view === 'today' && <TodayAskAction role={userRole} />}
      {route.view === 'inbox' && rowCount > 0 && (
        // Process the Inbox one task at a time (inbox-triage): the page's primary action, P (inbox-split D3).
        <Tooltip label={t('Process the Inbox one task at a time')} shortcut={keysOf('inbox.process')}>
          <Button variant="primary" size="sm" icon="inbox" onClick={() => navigate({ view: 'triage' })} data-triage-start aria-keyshortcuts="p">
            {/* A phone with a large text size keeps the icon, so the page title still fits beside it. */}
            <span className="max-[21rem]:sr-only">{t('Process')}</span> <kbd className="ui-kbd ml-1 max-[21rem]:hidden" aria-hidden="true">P</kbd>
          </Button>
        </Tooltip>
      )}
      {route.view !== 'completed' && rowCount > 0 && (
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm hidden px-2 py-1 text-body pointer-coarse:inline-flex" aria-pressed={selectMode} onClick={onSelectMode} data-select-mode>
          {selectMode ? t('Done') : t('Select')}
        </button>
      )}
      {filterKey && <DurationFilterControl active={duration} onChange={onDuration} />}
      {(route.view === 'today' || route.view === 'upcoming') && (
        // Display mode (display-mode D6): this view in large type, for a tablet or an e-ink panel.
        <IconButton size="sm" icon="monitor" label={t('Display mode')} data-display-mode
          onClick={() => navigate({ view: 'display', target: { kind: route.view as 'today' | 'upcoming' }, options: { ...DEFAULT_DISPLAY_OPTIONS } })} />
      )}
    </>
  )
}

/** One overflow item of the phone bar (phone-v2 D1): plain data, so a Menu and an ActionMenu can both show it. */
export interface PhoneItem { id: string; label: string; icon?: IconName; checked?: boolean; group?: string; onSelect: () => void }

/**
 * A list's actions on a phone (phone-v2 D1): two visible slots in the shell's bar
 * (Process the Inbox or Ask in Today first, then the duration filter) and the rest
 * as overflow items: Select tasks, Display mode, and the duration filter when it
 * had no slot (its active choice then shows as a chip in the bar).
 */
export function usePhoneListActions({ route, userRole, rowCount, topLevelCount, onSelectMode, filterKey, duration, onDuration, project }: {
  route: ListRoute
  userRole?: AccountRole
  rowCount: number
  topLevelCount: number
  onSelectMode: () => void
  filterKey: string | null
  duration: DurationFilter | null
  onDuration: (kind: DurationFilter | null) => void
  /** A project page: its layout choice and, when empty, "Add a note" join the project menu. */
  project?: { row: Project; editable: boolean; viewMode: ProjectViewMode; onViewMode: (m: ProjectViewMode) => void }
}): { phone: boolean; slots: ReactNode; items: PhoneItem[]; projectItems: PhoneItem[] } {
  const phone = !useMediaQuery(DESKTOP_HEADER_QUERY)
  const ask = useTodayAsk(userRole) && route.view === 'today'
  const process = route.view === 'inbox' && rowCount > 0
  const filterSlot = !!filterKey && !ask && !process
  const items: PhoneItem[] = []
  if (route.view !== 'completed' && rowCount > 0) items.push({ id: 'select', label: t('Select tasks'), icon: 'list-checks', onSelect: onSelectMode })
  if (route.view === 'today' || route.view === 'upcoming') {
    const target = { kind: route.view }
    items.push({ id: 'display', label: t('Display mode'), icon: 'monitor', onSelect: () => navigate({ view: 'display', target, options: { ...DEFAULT_DISPLAY_OPTIONS } }) })
  }
  if (filterKey && !filterSlot) {
    for (const f of DURATION_FILTERS) items.push({ id: `duration-${f.kind}`, label: f.label, checked: duration === f.kind, group: t('Filter by duration'), onSelect: () => onDuration(duration === f.kind ? null : f.kind) })
  }
  const current = DURATION_FILTERS.find((f) => f.kind === duration)
  const slots = (
    <>
      {ask && <TodayAskAction role={userRole} />}
      {process && (
        <Button variant="secondary" size="sm" icon="inbox" onClick={() => navigate({ view: 'triage' })} data-triage-start>
          {/* As on the desktop header: a phone with a large text size keeps the icon, so the title fits. */}
          <span className="max-[21rem]:sr-only">{t.rich('Process {count}', { count: <span className="tabular-nums text-muted">{topLevelCount}</span> })}</span>
        </Button>
      )}
      {filterSlot && <DurationFilterControl active={duration} onChange={onDuration} />}
      {!filterSlot && current && <DurationChip label={current.label} onClear={() => onDuration(null)} />}
    </>
  )
  const projectItems: PhoneItem[] = project ? [
    ...(['list', 'board', 'timeline'] as const).map((mode) => ({ id: `layout-${mode}`, label: LAYOUT_LABEL[mode], checked: project.viewMode === mode, group: t('Layout'), onSelect: () => project.onViewMode(mode) })),
    ...(project.editable && !project.row.description?.trim() ? [{ id: 'note', label: t('Add a note'), icon: 'pencil' as const, onSelect: () => requestProjectNote(project.row.id) }] : []),
    ...items,
  ] : items
  return { phone, slots, items, projectItems }
}

/** The phone overflow items as ActionMenu groups (the project and label menus). */
export function phoneGroups(items: PhoneItem[]): ActionGroup[] {
  const toItem = (i: PhoneItem): ActionItem => (i.checked === undefined
    ? { kind: 'action', id: i.id, label: i.label, icon: i.icon, onSelect: i.onSelect }
    : { kind: 'check', id: i.id, label: i.label, checked: i.checked, onSelect: i.onSelect })
  const plain = items.filter((i) => !i.group)
  const named = [...new Set(items.filter((i) => i.group).map((i) => i.group!))]
  return [...(plain.length ? [{ items: plain.map(toItem) }] : []), ...named.map((g) => ({ label: g, items: items.filter((i) => i.group === g).map(toItem) }))]
}

/** The phone overflow items as menu items, grouped where they carry a group name. */
export function PhoneMenuItems({ items }: { items: PhoneItem[] }) {
  const plain = items.filter((i) => !i.group)
  const groups = [...new Set(items.filter((i) => i.group).map((i) => i.group!))]
  return (
    <>
      {plain.map((i) => <MenuItem key={i.id} label={i.label} icon={i.icon} onSelect={i.onSelect} data-phone-item={i.id} />)}
      {groups.map((g) => (
        <MenuGroup key={g} label={g}>
          {items.filter((i) => i.group === g).map((i) => <MenuItem key={i.id} label={i.label} checked={i.checked} onSelect={i.onSelect} data-phone-item={i.id} />)}
        </MenuGroup>
      ))}
    </>
  )
}

/** The active duration filter as one chip with its clear control. */
function DurationChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft py-0.5 pl-2.5 pr-1 text-meta font-medium text-on-accent-soft" data-duration-active>
      {label}
      <button type="button" className="touch-target flex h-5 w-5 items-center justify-center rounded-full hover:bg-accent/10" aria-label={t('Clear filter')} onClick={onClear} data-clear-duration>
        <Icon name="x" size="xs" />
      </button>
    </span>
  )
}

/**
 * The duration filter as a page action (ux-overhaul, time-blocking "Duration filter"):
 * a Filter menu in the header, and one chip with a clear control while a filter is on.
 */
function DurationFilterControl({ active, onChange }: { active: DurationFilter | null; onChange: (kind: DurationFilter | null) => void }) {
  const current = DURATION_FILTERS.find((f) => f.kind === active)
  return (
    <span className="flex items-center gap-1" data-duration-filter>
      {current && <DurationChip label={current.label} onClear={() => onChange(null)} />}
      <Menu kind="menu" label={t('Filter')} title={t('Filter by duration')} trigger={<Icon name="filter" />} triggerClassName={`ui-btn ui-btn--ghost ui-btn--sm touch-target px-2 py-1 ${active ? 'text-accent' : ''}`} width="sm:w-56">
        {DURATION_FILTERS.map((f) => (
          <MenuItem key={f.kind} label={f.label} description={f.title} checked={active === f.kind} onSelect={() => onChange(active === f.kind ? null : f.kind)} />
        ))}
        {active && <MenuSeparator />}
        {active && <MenuItem label={t('Clear filter')} icon="x" onSelect={() => onChange(null)} />}
      </Menu>
    </span>
  )
}

export function placeholderFor(route: ListRoute, project?: Project, label?: Label, place?: Place, workspace?: string): string {
  switch (route.view) {
    case 'today':
      return t('Add a task for today…')
    case 'upcoming':
      return t('Add a task for tomorrow…')
    case 'someday':
      return t('Add a someday task…')
    case 'anytime':
      return t('Add a task…')
    case 'project':
      return project?.name ? t('Add a task to {project}…', { project: project.name }) : t('Add a task to this project…')
    case 'label':
      return label?.name ? t('Add a task labelled {label}…', { label: label.name }) : t('Add a task with this label…')
    case 'place':
      return place?.name ? t('Add a task at {place}…', { place: place.name }) : t('Add a task at this location…')
    case 'assigned':
      return t('Add a task assigned to you…')
    default:
      // With more than one workspace the Inbox names its workspace (workspaces "Quick add").
      return workspace ? t('Add to {workspace}…', { workspace }) : t('Add a task to your Inbox…')
  }
}

// Empty views (OpenSpec change lean-chrome D7, task-list-presentation "Empty views"):
// one sentence, at most one primary action (none where the view has its own quick add,
// row-and-cursor D3), at most one secondary link, rendered through the
// EmptyState primitive; the action's key is in its tooltip on fine pointers only.
type EmptyView = ListRoute['view']
interface EmptyCopy { title: string; action?: 'inbox' | 'today' }
const EMPTY_COPY: Record<EmptyView, EmptyCopy> = {
  inbox: { get title() { return t('Inbox zero: every task has a place.') } },
  today: { get title() { return t('Nothing due today.') } },
  upcoming: { get title() { return t('Nothing scheduled yet.') } },
  anytime: { get title() { return t('Nothing waiting for a free moment.') } },
  someday: { get title() { return t('Nothing parked for later.') } },
  assigned: { get title() { return t('Nothing is assigned to you.') }, action: 'inbox' },
  project: { get title() { return t('This project has no open tasks.') } },
  label: { get title() { return t('No open task carries this label.') } },
  place: { get title() { return t('No open task happens at this location.') } },
  completed: { get title() { return t('Nothing completed yet.') }, action: 'today' },
}

// The illustration set (moments-and-onboarding D1): the views with a drawing of their own.
const EMPTY_ILLUSTRATION: Partial<Record<EmptyView, IllustrationName>> = {
  inbox: 'inbox-zero', today: 'today-clear', upcoming: 'week-clear', project: 'project-new',
}

/**
 * The primary action of an empty view: open Inbox or Today. A view with its own quick add
 * has none (row-and-cursor D3): the field above is the way to add, and `q` focuses it.
 */
function emptyAction(kind: EmptyCopy['action']): EmptyStateAction | undefined {
  if (kind === 'today') return { label: t('Open Today'), onClick: () => navigate({ view: 'today' }), shortcut: keysOf('go.today') }
  if (kind === 'inbox') return { label: t('Open Inbox'), onClick: () => navigate({ view: 'inbox' }), shortcut: keysOf('go.inbox') }
  return undefined
}

export function EmptyState({ view, waiting = 0, readOnly = false, completed = 0, onShowCompleted }: {
  view: EmptyView
  /** Today: tasks due today that all wait for other tasks (task-dependencies). */
  waiting?: number
  /** A shared project the viewer may only read: no quick add, so the action opens the Inbox. */
  readOnly?: boolean
  /** A project's completed tasks while its Completed group is off. */
  completed?: number
  onShowCompleted?: () => void
}) {
  const copy = EMPTY_COPY[view]
  const blocked = view === 'today' && waiting > 0
  const action = emptyAction(view === 'project' && readOnly ? 'inbox' : copy.action)
  const secondary: EmptyStateLink | undefined = blocked
    ? { label: t('{n, plural, one {# waiting for other tasks} other {# waiting for other tasks}}', { n: waiting }), onClick: () => navigate({ view: 'waiting' }) }
    : view === 'today'
      ? { label: t('Open Upcoming'), onClick: () => navigate({ view: 'upcoming' }) }
      : view === 'project' && completed > 0 && onShowCompleted
        ? { label: t('{n, plural, one {Show # completed} other {Show # completed}}', { n: completed }), onClick: onShowCompleted }
        : undefined
  return (
    <div data-empty-state={view}>
      <EmptyStatePattern title={blocked ? t('Nothing is ready to start today.') : copy.title} action={action} secondary={secondary}
        illustration={EMPTY_ILLUSTRATION[view]} />
    </div>
  )
}

/**
 * The line after a project's list while its completed tasks are hidden (precision-rows
 * D6): how many there are and one link that turns "Show completed tasks" on.
 */
export function HiddenNote({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-2 pt-4 pb-2 text-meta text-muted" data-hidden-note>
      <span>{t('{n, plural, one {# completed task hidden by display options} other {# completed tasks hidden by display options}}', { n: count })}</span>
      <button type="button" onClick={onShow} className="rounded-chip text-default underline decoration-(--ot-line-strong) underline-offset-3 hover:decoration-current">{t('Show')}</button>
    </p>
  )
}

/** No list matches when the duration filter hides every task. */
export function FilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div data-empty-state="duration">
      <EmptyStatePattern title={t('No task matches this duration filter.')} action={{ label: t('Clear the filter'), onClick: onClear }} />
    </div>
  )
}

/** A project or label route whose target is gone. */
export function MissingTarget({ kind }: { kind: 'project' | 'label' | 'place' }) {
  return (
    <div className="p-6 text-body text-muted">
      {kind === 'project'
        ? <>{t('This project no longer exists.')}{' '}<button className="underline" onClick={() => navigate({ view: 'inbox' })}>{t('Go to Inbox')}</button></>
        : kind === 'place'
          ? <>{t('This saved location no longer exists.')}{' '}<button className="underline" onClick={() => navigate({ view: 'places' })}>{t('All locations')}</button></>
          : <>{t('This label no longer exists.')}{' '}<button className="underline" onClick={() => navigate({ view: 'labels' })}>{t('All labels')}</button></>}
    </div>
  )
}

/** The quick add of a shared project the viewer may only read. */
export function ReadOnlyQuickAdd() {
  return (
    <>
      <input className="ui-input" disabled aria-label={t('Quick add (read-only)')} placeholder={t('You can view this project but not add tasks')} />
      <p role="note" className="mt-1 text-meta text-muted">{t('Read-only: you are a viewer of this shared project.')}</p>
    </>
  )
}

/** After the last open subtask: offer to complete the parent too (Enter) or keep it open (Esc). */
export function CompleteParentPrompt({ parent, onAccept, onDismiss }: { parent: Task; onAccept: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="fixed inset-x-0 z-40 flex justify-center px-4" style={{ bottom: 'calc(var(--vv-bottom, 0px) + max(1rem, env(safe-area-inset-bottom)))' }}>
      <div className="flex flex-wrap items-center gap-3 rounded-control border border-default bg-surface px-4 py-2 text-body shadow-2">
        <span className="user-text min-w-0">{t.rich('All subtasks done. Complete <b>{title}</b> too?', { title: parent.title || t('Untitled'), b: (chunks) => <strong>{chunks}</strong> })}</span>
        <button className="ui-btn ui-btn--primary ui-btn--sm text-meta" onClick={onAccept}>{t('Complete')} <Kbd k="Enter" only className="ml-1 border-on-accent/40 bg-accent-hover text-on-accent" /></button>
        <button className="ui-btn ui-btn--ghost ui-btn--sm text-meta" onClick={onDismiss}>{t('Keep open')} <Kbd k="Esc" only className="ml-1" /></button>
      </div>
    </div>
  )
}

/** The assignee (Shift+A) and label (`L`) dialogs of the cursor task. */
export function RowPickerDialogs({ assignFor, pickerFor, userId, onCloseAssign, onClosePicker }: {
  assignFor: string | null
  pickerFor: string | null
  userId?: string
  onCloseAssign: () => void
  onClosePicker: () => void
}) {
  return (
    <>
      {/* The Schedule sheet of a left swipe or the touch row menu (phone-v2 D3). */}
      <RowScheduleHost />
      {assignFor && userId && (
        <Dialog title={t('Assign')} label={t('Assign task')} onClose={onCloseAssign}>
          <AssigneePicker taskId={assignFor} userId={userId} onClose={onCloseAssign} />
          <p className="mt-2 px-1 text-hint text-faint">{t('Type to filter · Enter assigns · Esc closes')}</p>
        </Dialog>
      )}
      {pickerFor && (
        <Dialog title={t('Labels')} label={t('Labels for task')} onClose={onClosePicker}>
          <LabelPicker taskId={pickerFor} onClose={onClosePicker} />
          <p className="mt-2 px-1 text-hint text-faint">{t('Enter toggles or creates · Esc closes')}</p>
        </Dialog>
      )}
    </>
  )
}
