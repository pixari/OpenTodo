// The selection's Actions menu and bar (OpenSpec change bulk-edit, design D3): one
// menu for the ticked tasks (or the cursor task when nothing is ticked), built on
// the shared ActionMenu so its items, pickers, shortcuts and disabled reasons work
// like every other object menu. Moves and assignments go through the review (D6).
import { useLiveQuery } from 'dexie-react-hooks'
import { keysOf } from '../../lib/shortcuts'
import { Kbd } from '../shortcuts/Kbd'
import { useMemo, useState, type RefObject } from 'react'
import { allCompleted, applyBulk, commonSharedProject, readTicked, reviewAssign, reviewMove, type BulkAction, type ReviewPlan } from '../../lib/bulk'
import { useAllLabels, useLiveSections, useProjects } from '../../lib/localData'
import { itemKeywords, projectSource, sectionSource, type PickerItem } from '../../lib/pickerSources'
import { membershipMap, roleOf } from '../../lib/sharing'
import { toggleTracking, useRunningEntry } from '../../lib/timeEntries'
import { act } from '../actionError'
import type { Label, Membership, Priority, Project, Section, Task } from '../../lib/types'
import { Icon, Dialog, useFinePointer } from '../../ui'
import { Tooltip } from '../../ui'
import { DateField } from '../datetime/DateField'
import { ActionMenu, type ActionGroup, type ActionItem } from '../menus/ActionMenu'
import { openRowSchedule } from '../task-list/RowSwipe'
import { BulkReview } from './BulkReview'
import { showBulkToast } from './toastStore'
import { t } from '../../lib/i18n'
import { withListTransition } from '../motion'

/** Apply a bulk action and offer its undo. */
export async function runBulk(ids: readonly string[], action: BulkAction): Promise<void> {
  if (ids.length === 0) return
  // The rows that stay slide into place; more than the cap update at once (motion-v2 D4).
  const r = await withListTransition(ids.length, () => applyBulk(ids, action))
  showBulkToast(r.label, r.undoId)
}

const tasksWord = (n: number) => t('{n, plural, one {# task} other {# tasks}}', { n })
const itemKey = (i: PickerItem) => i.key
const itemLabel = (i: PickerItem) => i.label
const itemPath = (i: PickerItem) => i.path

interface Data { tasks: Task[]; labels: Label[]; projects: Project[]; sections: Section[]; memberships: Map<string, Membership>; runningTask?: string | null }

/**
 * Start or Stop tracking for one task (time-tracking D5): Stop while its entry runs,
 * Start for an open task the user may edit; nothing for a completed or deleted one.
 */
export function trackingItem(task: Task | undefined, runningTask: string | null | undefined, memberships: Map<string, Membership>): ActionGroup['items'] {
  if (!task || task.deleted_at || roleOf(task.project_id, memberships) === 'viewer') return []
  const stop = runningTask === task.id
  if (!stop && task.completed_at) return []
  return [{ kind: 'action', id: 'track', label: stop ? t('Stop tracking') : t('Start tracking'), icon: 'timer', shortcut: keysOf('list.track'),
    onSelect: () => act(toggleTracking(task.id)) }]
}

/** The menu's groups for the given tasks (exported for the palette and tests). */
export function bulkMenuGroups(ids: readonly string[], d: Data, a: { review: (title: string, plan: Promise<ReviewPlan>) => void; pickDate: () => void; schedule?: () => void }, besideRow = false): ActionGroup[] {
  const n = d.tasks.length
  const reopen = allCompleted(d.tasks)
  const live = d.labels.filter((l) => !l.deleted_at)
  const common = live.filter((l) => d.tasks.length > 0 && d.tasks.every((task) => task.labels.includes(l.id))).map((l) => l.id)
  const projectId = d.tasks[0]?.project_id ?? null
  const oneProject = n > 0 && d.tasks.every((tk) => (tk.project_id ?? null) === projectId)
  const shared = commonSharedProject(d.tasks, d.memberships)
  const members = shared ? d.memberships.get(shared)?.members ?? [] : []
  const run = (action: BulkAction) => () => runBulk(ids, action)
  const complete: ActionItem = { kind: 'action', id: 'complete', label: reopen ? t('Reopen') : t('Complete'), icon: 'check', shortcut: keysOf('list.complete'), onSelect: run({ kind: 'complete' }) }
  // On touch, one task's menu starts with the two swipe actions (phone-v2 D3, WCAG 2.2 2.5.7).
  const swipeTwins = n === 1 && a.schedule
  return [
    ...(swipeTwins ? [{ items: [complete, { kind: 'action', id: 'schedule', label: t('Schedule…'), icon: 'calendar-days', onSelect: a.schedule } as ActionItem] }] : []),
    ...(n === 1 ? [{ items: trackingItem(d.tasks[0], d.runningTask, d.memberships) }] : []),
    ...(swipeTwins ? [] : [{ items: [complete] }]),
    // Beside a row its own Priority and Schedule buttons already offer these.
    ...(besideRow ? [] : [{ label: t('Priority'), items: ([1, 2, 3, 4] as Priority[]).map((p) => ({ kind: 'action' as const, id: `p${p}`, label: t('Priority {p}', { p }), icon: 'flag' as const, shortcut: String(p), onSelect: run({ kind: 'priority', priority: p }) })) }]),
    { items: [
      { kind: 'picker', id: 'labels', label: t('Labels'), icon: 'tag', shortcut: keysOf('list.labels'), disabled: live.length === 0, reason: t('There are no labels yet'), picker: {
        title: t('Labels'), placeholder: t('Add to all, or remove from all…'), source: live, multiple: true, selected: common, rankContext: 'label',
        getKey: (l: Label) => l.id, getLabel: (l: Label) => l.name,
        // Add or remove is decided from the ticked tasks as stored at the click, not from the
        // menu's read, which can still be loading on a quick pick; the open picker follows the
        // read, so its marks appear when it lands and change after each pick.
        onPick: (l: Label) => { void labelToggle(ids, l.id) },
      } },
    ] },
    ...(besideRow ? [] : [{ label: t('Date'), items: [
      { kind: 'action', id: 'today', label: t('Today'), icon: 'calendar-check', onSelect: run({ kind: 'due', pick: 'today' }) },
      { kind: 'action', id: 'tomorrow', label: t('Tomorrow'), icon: 'calendar-days', onSelect: run({ kind: 'due', pick: 'tomorrow' }) },
      { kind: 'action', id: 'next-week', label: t('Next week'), icon: 'calendar-range', onSelect: run({ kind: 'due', pick: 'next-week' }) },
      { kind: 'action', id: 'no-date', label: t('No date'), icon: 'x', onSelect: run({ kind: 'due', pick: null }) },
      { kind: 'action', id: 'pick-date', label: t('Pick a date…'), icon: 'calendar-days', onSelect: a.pickDate },
    ] }] as ActionGroup[]),
    { items: [
      { kind: 'picker', id: 'move', label: t('Move to project'), icon: 'folder-input', picker: {
        title: t('Move to project'), placeholder: t('Find a project…'), source: projectSource(d.projects, { memberships: d.memberships }),
        getKey: itemKey, getLabel: itemLabel, getPath: itemPath, getKeywords: itemKeywords, rankContext: 'project',
        onPick: (i: PickerItem) => { a.review(i.value ? t('Move {tasks} to {target}', { tasks: tasksWord(n), target: i.label }) : t('Move {tasks} to the Inbox', { tasks: tasksWord(n) }), reviewMove(ids, { projectId: i.value })) },
      } },
      { kind: 'picker', id: 'section', label: t('Move to section'), icon: 'kanban', disabled: !oneProject || !projectId, reason: t('The tasks must be in one project'), picker: {
        title: t('Move to section'), placeholder: t('Find a section…'), source: sectionSource(d.sections, projectId),
        getKey: itemKey, getLabel: itemLabel,
        onPick: (i: PickerItem) => { a.review(i.value ? t('Move {tasks} to {target}', { tasks: tasksWord(n), target: i.label }) : t('Move {tasks} to “No section”', { tasks: tasksWord(n) }), reviewMove(ids, { projectId, sectionId: i.value })) },
      } },
      { kind: 'picker', id: 'assign', label: t('Assign'), icon: 'user-check', shortcut: keysOf('list.assign'), disabled: !shared, reason: t('Tasks must be in one shared project'), picker: {
        title: t('Assign'), placeholder: t('Find a member…'), source: [{ userId: '', name: t('Unassigned'), email: '' }, ...members] as { userId: string; name: string; email: string }[],
        getKey: (m: { userId: string }) => m.userId || 'none', getLabel: (m: { name: string; email: string }) => m.name || m.email, rankContext: `assignee:${shared ?? ''}`,
        onPick: (m: { userId: string; name: string; email: string }) => { a.review(m.userId ? t('Assign {tasks} to {name}', { tasks: tasksWord(n), name: m.name || m.email }) : t('Unassign {tasks}', { tasks: tasksWord(n) }), reviewAssign(ids, m.userId || null)) },
      } },
    ] },
    { items: [{ kind: 'action', id: 'trash', label: t('Move to Trash'), icon: 'trash-2', shortcut: keysOf('list.delete'), tone: 'danger', onSelect: run({ kind: 'trash' }) }] },
  ]
}

/** Removes the label when every ticked task has it, otherwise adds it to the ones lacking it. */
async function labelToggle(ids: readonly string[], labelId: string) {
  const { tasks } = await readTicked(ids)
  const all = tasks.length > 0 && tasks.every((task) => task.labels.includes(labelId))
  await runBulk(ids, { kind: 'label', labelId, add: !all })
}

/** Live data the menu needs, read while it is mounted. */
function useBulkData(ids: readonly string[]): Data {
  const key = ids.join(',')
  // Tagged with the selection it was read for: until the read for this selection lands,
  // the menu has no tasks (and marks no common label) rather than an earlier selection's.
  const read = useLiveQuery(() => readTicked(ids).then((r) => ({ key, tasks: r.tasks })), [key])
  const tasks = useMemo(() => (read?.key === key ? read.tasks : []), [read, key])
  const labels = useAllLabels()
  const projects = useProjects()
  const sections = useLiveSections()
  const memberships = useLiveQuery(() => membershipMap(), [], new Map<string, Membership>())
  const runningTask = useRunningEntry()?.task_id ?? null
  return { tasks, labels, projects, sections, memberships, runningTask }
}

/**
 * The Actions menu for `ids`. `startPicker` opens it straight into a picker
 * ("labels" for `L`, "assign" for Shift+A on a selection).
 */
export function BulkActionsMenu({ ids, open, onOpenChange, trigger, triggerClassName, startPicker = null, onApplied, anchor }: {
  ids: readonly string[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactNode
  triggerClassName?: string
  startPicker?: string | null
  onApplied?: () => void
  /** Opened from a row's More button: placed there, without the groups the row's own buttons offer. */
  anchor?: RefObject<HTMLElement | null>
}) {
  const data = useBulkData(ids)
  const [review, setReview] = useState<{ title: string; plan: ReviewPlan } | null>(null)
  const [dating, setDating] = useState(false)
  const besideRow = !!anchor?.current
  const touch = !useFinePointer()
  const groups = useMemo(() => bulkMenuGroups(ids, data, {
    review: (title, plan) => { void plan.then((p) => setReview({ title, plan: p })) },
    pickDate: () => setDating(true),
    schedule: touch && ids.length === 1 ? () => openRowSchedule(ids[0]) : undefined,
  }, besideRow), [ids, data, besideRow, touch])
  const n = data.tasks.length || ids.length
  return (
    <>
      <ActionMenu label={t('Actions for {tasks}', { tasks: tasksWord(n) })} title={tasksWord(n)} groups={groups} open={open} onOpenChange={onOpenChange}
        trigger={trigger} triggerClassName={triggerClassName} startPicker={startPicker} width="sm:w-72" anchor={anchor} />
      {review && <BulkReview title={review.title} plan={review.plan} onClose={() => setReview(null)} onApplied={onApplied} />}
      {dating && (
        <Dialog title={t('Date for {tasks}', { tasks: tasksWord(n) })} onClose={() => setDating(false)}>
          <DateField label={t('Date')} autoFocus value={null} onChange={(iso) => { setDating(false); if (iso) void runBulk(ids, { kind: 'due', pick: iso }) }} />
        </Dialog>
      )}
    </>
  )
}

/** "3 selected · Actions · Clear" above a list while tasks are ticked. */
export function SelectionBar({ ids, onClear, menuOpen, onMenuOpenChange, startPicker, onDone }: {
  ids: readonly string[]
  onClear: () => void
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  startPicker?: string | null
  /** Select mode on touch (phone-v2 D8): Done hides the checkboxes and keeps the ticks; the bar shows with nothing ticked. */
  onDone?: () => void
}) {
  if (ids.length === 0 && !onDone) return null
  return (
    <div className="mb-2 flex items-center gap-2 rounded-control bg-selected px-3 py-1.5 text-body" data-selection-bar>
      <span role="status" className="min-w-0 flex-1 font-medium text-strong">{t('{count} selected', { count: ids.length })}</span>
      {ids.length > 0 && <BulkActionsMenu ids={ids} open={menuOpen} onOpenChange={onMenuOpenChange} startPicker={startPicker}
        trigger={<>{t('Actions')} <Kbd k={keysOf('list.actions')} only className="ml-1" /></>} triggerClassName="ui-btn ui-btn--ghost ui-btn--sm px-2 py-1 text-body" />}
      {ids.length > 0 && (
        <Tooltip label={t('Clear the selection')} shortcut="Esc">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm px-2 py-1 text-body" onClick={onClear}><Icon name="x" />{t('Clear')}</button>
        </Tooltip>
      )}
      {onDone && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm touch-target px-2 py-1 text-body font-medium" onClick={onDone} data-select-done>{t('Done')}</button>}
    </div>
  )
}
