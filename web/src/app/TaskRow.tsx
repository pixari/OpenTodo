// The task row and card (OpenSpec change ux-overhaul, task-list-presentation "One
// row anatomy", "Metadata language", "Completion feedback", "Bulk selection does
// not shift rows", "Drag feedback"; design D7). One row in every list: a fixed
// leading slot (the collapse chevron only on rows with children), one checkbox
// slot (the task's checkbox, or the selection box in its place on hover, focus or
// tick), the time column when the list has one, the title, a metadata line only when
// there is metadata, and a quiet trailing group. The board card is the same data as a card.
//
// One row language (OpenSpec change rows-v2, design D1 to D9): the row leaves out what
// the view or the group heading already says (`implied`, `omitLabel`) and colours only
// what needs attention. The time column holds the due time, else the deadline
// countdown (`timeColumn`, a fact of the whole list); the metadata line is one run of
// muted text separated by CSS middle dots; labels are the only chips (LabelChips);
// the project, the counts and the origin form the trailing group, in whose place the
// revealed actions (RowActionCluster) appear on a fine pointer.
//
// Precision rows (OpenSpec change precision-rows, design D1 to D5): a list row is one
// line from 40 rem of row width. The title leads, with the repeat mark and the counts
// beside it; the properties stand in a right-hand column of fixed cells (date, project,
// labels or deadline or sub-task progress, estimate, assignee) that drops cells from
// the end as the row narrows; the facts the column does not hold take a second line
// only when there are any. Narrower rows keep the title and one run of text under it.
// The row is its own size container (`@container/row`), so every host gets the layout
// its width allows; the rules are in index.css, "The property column".
import { isSample } from '../lib/sampleTasks'
import { hueFor, Icon, LabelChips, ReadAs, ToneText, TruncatedText, type IconName, type Tone } from '../ui'
import { lazy, memo, type ReactNode, Suspense, useLayoutEffect, useRef } from 'react'
import type { RowImplied } from '../lib/listGroups'
import { describeDeadline, describeDue, formatDate, formatTime, localDueOf, logicalToday, zoneHint } from '../lib/dates'
import { formatMinutes } from '../lib/duration'
import type { Progress } from '../lib/subtasks'
import { streakLabel, type HabitStats } from '../lib/habits'
import type { Label, Project, RowProperty, Task } from '../lib/types'
import { AssigneeChip } from './AssigneePicker'
import { useAttachmentCount, useCommentCount, useSharedProject } from './useCommentCounts'
import { notYetEncrypted, useEncryption } from '../lib/e2ee'
import { useDateTimeFormat } from './DateTimePrefsProvider'
import { prefersReducedMotion } from './motion'
import { useRowSwipe } from './task-list/RowSwipe'
import { dragFeedback } from './listDrop'
import { fieldBadges } from '../lib/fields'
import { useFieldDefs } from './useFields'
import { t } from '../lib/i18n'
import { originOf } from '../lib/taskOrigin'
import { taskSource, type SourceKind } from '../lib/taskSource'
import { relativeLabel } from './task-detail/RelativeTime'
import { trackedLabel, trackedText } from '../lib/time'
import { useTaskTracked } from '../lib/timeEntries'
import { OriginChip } from './OriginChip'
import { DEADLINE_TONE, ladderTone, PRIORITY_RING } from './rowTone'
import { RowActionCluster } from './task-list/RowActionCluster'

/** The details of an expanded row (row-expand D3), loaded on the first expand. */
const RowDetails = lazy(() => import('./task-list/RowDetails'))

/** Field values shown on a row before the rest collapse into "+n" (custom-fields). */
export const MAX_FIELD_BADGES = 3

/** Indentation stops growing after this level so deep trees stay readable on phones. */
export const MAX_INDENT = 3

/**
 * The date words of a row (calm-rows D4, rows-v2 D3): the day's words left out under a
 * heading that names it, the time left out when the time column holds it, evening left
 * out under This Evening, no repeat suffix (the repeat is its own item).
 */
export function rowDateText(due: { label: string; day: string; time: string | null } | null, dueDate: string | null, evening: boolean, implied: RowImplied | undefined, inColumn = false): string | null {
  const eve = evening && !implied?.evening
  if (!due) return eve ? t('This evening') : null
  const sameDay = !!implied?.date && dueDate === implied.date
  const words = sameDay ? (inColumn ? null : due.time) : inColumn ? due.day : due.label
  return [words, eve ? t('evening') : null].filter(Boolean).join(' · ') || null
}

/** One count of a row: subtask progress, notes, comments, attachments (calm-rows D7). */
export interface RowCount {
  key: 'progress' | 'notes' | 'comments' | 'attachments'
  icon?: IconName
  /** The visible text; none for an icon-only marker (notes). */
  text?: string
  /** The spoken phrase. */
  label: string
}

/** A row's counts in display order: the trailing group of a row, the end of a card's line. A new count is one more entry. */
export function rowCounts(c: { progress?: Progress; notes: boolean; comments: number; attachments: number }): RowCount[] {
  const out: RowCount[] = []
  if (c.progress && c.progress.total > 0) out.push({ key: 'progress', text: `${c.progress.done}/${c.progress.total}`, label: t('{done} of {total} subtasks completed', { done: c.progress.done, total: c.progress.total }) })
  if (c.notes) out.push({ key: 'notes', icon: 'list', label: t('Has notes') })
  if (c.comments > 0) out.push({ key: 'comments', icon: 'message-circle', text: String(c.comments), label: t('{n, plural, one {# comment} other {# comments}}', { n: c.comments }) })
  if (c.attachments > 0) out.push({ key: 'attachments', icon: 'paperclip', text: String(c.attachments), label: t('{n, plural, one {# attachment} other {# attachments}}', { n: c.attachments }) })
  return out
}

/**
 * The counts (task-list-presentation "One row anatomy"): faint until the row is hovered
 * or holds focus, then muted; always in the page and read in full, never a control.
 */
export function RowCounts({ counts }: { counts: RowCount[] }) {
  return (
    // min-w-0 and overflow-hidden: in a very narrow panel the counts clip, never the page (they are read in full).
    <span data-row-counts="" className="flex min-w-0 items-center gap-2 overflow-hidden text-meta tabular-nums text-faint transition-colors duration-(--duration-ui) group-hover:text-muted group-focus-within:text-muted">
      {counts.map((c) => (
        <span key={c.key} className="inline-flex items-center gap-1" {...{ [`data-${c.key}`]: '' }}>
          {c.icon && <Icon name={c.icon} size="xs" />}
          <ReadAs label={c.label}>{c.text}</ReadAs>
        </span>
      ))}
    </span>
  )
}

/** The time column's value (rows-v2 D3): the due time in the date tone, else the deadline countdown in its tone. */
function TimeCell({ time, timeTone, deadline, deadlineLabel }: { time: string | null; timeTone: Tone; deadline: { label: string; tone: 'overdue' | 'soon' | 'later' } | null; deadlineLabel: string }) {
  return (
    <span data-row-time="" className="mt-0.5 flex h-5 w-(--row-time-w) shrink-0 items-center">
      {time ? <ToneText tone={timeTone} data-time="">{time}</ToneText>
        : deadline ? <ToneText tone={DEADLINE_TONE[deadline.tone]} data-deadline="" label={deadlineLabel}>{deadline.label}</ToneText>
        : null}
    </span>
  )
}

type FieldBadge = ReturnType<typeof fieldBadges>[number]

/** The values of the metadata line, computed once by the row. */
interface MetaValues {
  /** A start guide sample (moments-and-onboarding D4): the muted word, a fact rather than a chip. */
  sample?: boolean
  breadcrumb?: string | null
  date: string | null
  dateTone: Tone
  hint: string | null
  zone: string
  repeat: string | null
  /** The task repeats (not an occurrence of a series). */
  recurring: boolean
  deadline: { label: string; tone: 'overdue' | 'soon' | 'later' } | null
  deadlineLabel: string
  startText: string | null
  someday: boolean
  estimate: { text: string; label: string; tracked: boolean } | null
  blockedBy: number
  streak: HabitStats | null
  badges: FieldBadge[]
  assignee?: ReactNode
  origin?: ReactNode
  project?: ReactNode
  labels?: ReactNode
  counts?: ReactNode
  /** A card's subtask progress, which leads its property row (precision-boards-timeline D3). */
  progress?: RowCount
}

/** How many items the line has to show (the project and the repeat mark are placed apart). */
function metaItems(m: MetaValues): number {
  return [m.sample, m.breadcrumb, m.date, m.hint, m.repeat, m.deadline, m.startText, m.estimate, m.blockedBy > 0, m.streak, m.badges.length > 0, m.assignee, m.origin, m.labels, m.counts, m.progress].filter(Boolean).length
}

/**
 * A card's property row (precision-boards-timeline D3): the date, the estimate and the
 * subtask progress lead with their icons, the other facts and the label chips follow,
 * and the assignee ends the row.
 */
function CardMeta({ m }: { m: MetaValues }) {
  const more = m.badges.slice(MAX_FIELD_BADGES)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1" data-row-meta="card">
      {m.date && <ToneText tone={m.dateTone} icon="calendar-days" data-date="">{m.date}</ToneText>}
      {m.estimate && <ToneText icon="clock" data-estimate="" data-tracked={m.estimate.tracked ? '' : undefined} label={m.estimate.label}>{m.estimate.text}</ToneText>}
      {m.progress && <ToneText icon="circle-check-big" data-progress="" label={m.progress.label}>{m.progress.text}</ToneText>}
      {m.sample && <ToneText data-sample="">{t('Sample')}</ToneText>}
      {m.breadcrumb && <ToneText icon="corner-down-right" label={t('In {breadcrumb}', { breadcrumb: m.breadcrumb })} data-breadcrumb="">{m.breadcrumb}</ToneText>}
      {m.hint && <ToneText tone="faint" data-zone-hint="" label={t('fixed to {zone}', { zone: m.zone })}>{m.hint}</ToneText>}
      {m.repeat && <ToneText icon="repeat" data-repeat="" data-recurring={m.recurring ? '' : undefined}>{m.repeat}</ToneText>}
      {m.deadline && <ToneText tone={DEADLINE_TONE[m.deadline.tone]} icon="hourglass" data-deadline="" label={m.deadlineLabel}>{m.deadline.label}</ToneText>}
      {m.startText && <ToneText icon={m.someday ? 'archive' : 'calendar-days'} data-start="">{m.startText}</ToneText>}
      {m.blockedBy > 0 && <ToneText icon="lock" data-blocked="" label={t('Blocked by {blockedBy}', { blockedBy: m.blockedBy })}>{m.blockedBy}</ToneText>}
      {m.streak && <ToneText icon="flame" data-streak="" data-at-risk={m.streak.atRisk ? '' : undefined} label={streakLabel(m.streak)}>{m.streak.current}</ToneText>}
      {m.badges.slice(0, MAX_FIELD_BADGES).map((b) => <ToneText key={b.def.id} data-field-badge={b.def.id}>{b.text}</ToneText>)}
      {more.length > 0 && (
        <ToneText data-field-more="" label={t('{count} more fields: {join}', { count: more.length, join: more.map((b) => b.text).join(', ') })}>+{more.length}</ToneText>
      )}
      {m.origin}
      {m.project}
      {m.labels && <span data-row-labels="" className="inline-flex max-w-full min-w-0">{m.labels}</span>}
      {m.counts}
      {m.assignee && <span data-row-assignee="" className="ml-auto inline-flex min-w-0 items-center gap-1 text-meta">{m.assignee}</span>}
    </div>
  )
}

/** What a list row's third cell holds (precision-rows D2): the labels, else the deadline, else the sub-task progress. */
export type RowExtra = 'labels' | 'deadline' | 'progress' | null

export function rowExtra(labels: boolean, deadline: boolean, progress: boolean): RowExtra {
  return labels ? 'labels' : deadline ? 'deadline' : progress ? 'progress' : null
}

/** The one cell a phone row keeps (precision-phone D2): the date, else the deadline, else the assignee, else the project's dot. */
export type PhoneCell = 'date' | 'extra' | 'assignee' | 'project' | null

export function phoneCell(c: { date: boolean; deadline: boolean; assignee: boolean; project: boolean }): PhoneCell {
  return c.date ? 'date' : c.deadline ? 'extra' : c.assignee ? 'assignee' : c.project ? 'project' : null
}

/**
 * A list row's properties (precision-rows D1, D3): the cells of the column in their
 * order, then the facts the column does not hold. Under 40 rem of row width the two
 * wrappers are not boxes, so everything reads as one muted run under the title; on a
 * phone the row is one line that keeps a single cell (`data-row-phone`, precision-phone D2).
 */
function RowLine({ m, extra, progress, projectColor, projectColumn }: { m: MetaValues; extra: RowExtra; progress?: RowCount; projectColor?: string; projectColumn: boolean }) {
  const more = m.badges.slice(MAX_FIELD_BADGES)
  const phone = phoneCell({ date: !!(m.date || m.hint), deadline: extra === 'deadline', assignee: !!m.assignee, project: !!m.project })
  const keep = (cell: Exclude<PhoneCell, null>) => (phone === cell ? { 'data-row-phone': '' } : {})
  const deadline = m.deadline && <ToneText tone={DEADLINE_TONE[m.deadline.tone]} icon="hourglass" data-deadline="" data-row-item="" label={m.deadlineLabel}>{m.deadline.label}</ToneText>
  const rest = [
    m.sample && <ToneText key="sample" data-sample="" data-row-item="">{t('Sample')}</ToneText>,
    m.breadcrumb && <ToneText key="crumb" icon="corner-down-right" label={t('In {breadcrumb}', { breadcrumb: m.breadcrumb })} data-breadcrumb="" data-row-item="">{m.breadcrumb}</ToneText>,
    extra !== 'deadline' && deadline && <span key="deadline" className="contents">{deadline}</span>,
    m.startText && <ToneText key="start" icon={m.someday ? 'archive' : 'calendar-days'} data-start="" data-row-item="">{m.startText}</ToneText>,
    m.blockedBy > 0 && <ToneText key="blocked" icon="lock" data-blocked="" data-row-item="" label={t('Blocked by {blockedBy}', { blockedBy: m.blockedBy })}>{m.blockedBy}</ToneText>,
    m.streak && <ToneText key="streak" icon="flame" data-streak="" data-row-item="" data-at-risk={m.streak.atRisk ? '' : undefined} label={streakLabel(m.streak)}>{m.streak.current}</ToneText>,
    ...m.badges.slice(0, MAX_FIELD_BADGES).map((b) => <ToneText key={b.def.id} data-field-badge={b.def.id} data-row-item="">{b.text}</ToneText>),
    more.length > 0 && <ToneText key="more" data-field-more="" data-row-item="" label={t('{count} more fields: {join}', { count: more.length, join: more.map((b) => b.text).join(', ') })}>+{more.length}</ToneText>,
  ].filter(Boolean)
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5" data-row-meta="row">
      <span className="contents" data-row-props={projectColumn ? 'project' : ''}>
        {(m.date || m.hint) && (
          <span data-row-cell="date" data-row-item="" {...keep('date')} className="inline-flex min-w-0 items-center gap-1">
            {m.date && <ToneText tone={m.dateTone} icon="calendar-days" data-date="">{m.date}</ToneText>}
            {m.hint && <ToneText tone="faint" data-zone-hint="" label={t('fixed to {zone}', { zone: m.zone })}>{m.hint}</ToneText>}
          </span>
        )}
        {m.project && (
          <span data-row-cell="project" data-row-item="" {...keep('project')} data-dot={projectColor ? '' : undefined} className="inline-flex min-w-0 items-center gap-1 text-meta text-muted">
            {projectColor && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: projectColor }} />}
            {m.project}
          </span>
        )}
        {extra === 'labels' && <span data-row-cell="extra" data-row-labels="" className="inline-flex max-w-full min-w-0 items-center">{m.labels}</span>}
        {extra === 'deadline' && <span data-row-cell="extra" data-row-item="" {...keep('extra')} className="inline-flex min-w-0 items-center">{deadline}</span>}
        {extra === 'progress' && progress && <span data-row-cell="extra" data-row-item="" className="inline-flex min-w-0 items-center"><ToneText icon="circle-check-big" data-progress="" label={progress.label}>{progress.text}</ToneText></span>}
        {m.estimate && <span data-row-cell="estimate" data-row-item="" className="inline-flex min-w-0 items-center"><ToneText icon="clock" data-estimate="" data-tracked={m.estimate.tracked ? '' : undefined} label={m.estimate.label}>{m.estimate.text}</ToneText></span>}
        {m.assignee && <span data-row-cell="assignee" data-row-item="" data-row-assignee="" {...keep('assignee')} className="inline-flex min-w-0 items-center gap-1 text-meta">{m.assignee}</span>}
      </span>
      {rest.length > 0 && <span className="contents" data-row-rest>{rest}</span>}
    </div>
  )
}

export interface TaskRowProps {
  task: Task
  project?: Project
  /** Already resolved: unknown and deleted label ids are not in this list. */
  labels?: Label[]
  /** Display name of the assignee, given only for tasks in shared projects (task-assignment). */
  assignee?: string | null
  assignedToMe?: boolean
  selected: boolean
  showProject: boolean
  depth?: number
  progress?: Progress
  /** Open blockers (task-dependencies): above 0 the row is dimmed with a lock marker. */
  blockedBy?: number
  /** The streak of a habit (OpenSpec habits), computed once by the list: an item after the repeat. */
  habit?: HabitStats | null
  /** Title of the parent when the task is shown outside its parent's subtree. */
  breadcrumb?: string | null
  hasChildren?: boolean
  collapsed?: boolean
  /** Viewer of a shared project: the row can be opened but not completed. */
  readOnly?: boolean
  onToggle: () => void
  /** Opens the task; Shift or Ctrl/⌘ clicks tick instead when `onTick` is set (bulk-edit D3). */
  onOpen: (e?: React.MouseEvent) => void
  /** Ticked for a bulk action (bulk-edit). */
  ticked?: boolean
  /** Checkboxes always shown: something is ticked, or touch Select mode is on. */
  showCheckbox?: boolean
  /** Tick or untick; `range` for Shift (extend from the anchor). */
  onTick?: (range: boolean) => void
  onToggleCollapse?: () => void
  /** A list row, or a board card (rows-v2 D8: the card has no column; its line leads with the time); the compact shape takes CompactRowProps. */
  shape?: 'row' | 'card'
  /** The list shows the time column (rows-v2 D2): one fact of the whole list, never per row. */
  timeColumn?: boolean
  /** The revealed actions (rows-v2 D7); off where the screen has its own controls (Close the day, D9). */
  actions?: boolean
  /** Opens the row menu, as `.` does: the revealed More action. */
  onMore?: (from: HTMLElement) => void
  /** Stories: the revealed actions shown as if hovered. */
  forceActions?: boolean
  /** Starts a drag (board-view: move between sections; manual-ordering: place in a list). */
  onPointerDown?: (e: React.PointerEvent<HTMLLIElement>) => void
  /** Drop target key for lib/dnd (manual-ordering): the row accepts drops before, after or inside it. */
  dropKey?: string
  /** Where the dragged task would land relative to this row (manual-ordering). */
  dropIndicator?: 'before' | 'after' | 'inside' | null
  /** This row is the one being dragged: it lifts (an opacity change under reduced motion). */
  dragging?: boolean
  /** The columns layout shows field values in cells, so the row leaves out their values (custom-fields). */
  hideFieldBadges?: boolean
  /**
   * Position among the visible rows with the same parent (assistive-tech-semantics):
   * with `depth`, the row's aria-level, aria-posinset and aria-setsize, so the
   * subtask hierarchy is announced and not only indented.
   */
  posInSet?: number
  setSize?: number
  /** What the view or the group heading already says (calm-rows D3); the row leaves it out. */
  implied?: RowImplied
  /** The label whose view is open: the row leaves out its chip. */
  omitLabel?: string
  /** Every member's tracked minutes on the task, when it has entries (time-tracking D4); a running entry counts to the minute. */
  tracked?: number
  /** The inline editor in place of the title and metadata (inline-task-editing). */
  inline?: ReactNode
  /** The completion sequence this row plays, if any (motion-v2). */
  /** Touch: the row follows a swipe (phone-v2 D3); the list decides (coarse pointer, nothing ticked). */
  swipe?: boolean
  /** Stories: shown mid-swipe at this offset (the gate cannot swipe). */
  forceSwipe?: number
  motion?: RowMotion
  /** The properties the view's display options hide (views-and-display D3); the task page still shows them. */
  hidden?: readonly RowProperty[]
  /** The Inbox's source line under the title, "From email · yesterday" (inbox-split D4); it stands for the origin chip. */
  source?: boolean
  /** The task's details are shown under the row (row-expand, task-list-presentation "Expanded rows"). */
  expanded?: boolean
  /** Shows or hides the details; without it the row cannot expand (boards, review screens). */
  onExpand?: () => void
}

const NO_HIDDEN: readonly RowProperty[] = []

/** Where the task came from and when, as one quiet line (inbox-split D4). */
function SourceLine({ task }: { task: Task }) {
  const dt = useDateTimeFormat()
  const source = taskSource(task)
  const when = task.created_at ? relativeLabel(task.created_at, Date.now(), (ms) => dt.formatInstant(ms, 'date')) : ''
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta text-muted" data-row-source={source.kind}>
      <Icon name={SOURCE_ICON[source.kind]} size="xs" className="shrink-0 text-faint" />
      <span className="min-w-0 truncate">{when ? `${source.text} · ${when}` : source.text}</span>
    </span>
  )
}

const SOURCE_ICON: Record<SourceKind, IconName> = {
  email: 'mail', web: 'globe', issue: 'git-pull-request', import: 'download', calendar: 'calendar-sync',
  assistant: 'sparkles', api: 'code', vault: 'file', app: 'plus',
}

/**
 * Where the row is in the completion sequence (task-list-presentation "Completion
 * feedback", motion-v2 D2, D3): `leave` while it departs (the list renders it once more
 * after the op was written), `rolled` while a repeating task rolls to its next date,
 * `restored` while Undo brings it back.
 */
export type RowMotion = 'leave' | 'rolled' | 'restored'

/**
 * The compact shape (rows-v2 D8, task-list-presentation "One row on the board, in Plan
 * and in the review screens"): the Plan's rows and the calendar's day lists. The column
 * already says the day, so the row shows the time (in the due ladder's colour), the
 * title, the estimate and the priority ring only. It is one `aria-pressed` button that
 * selects, drags and opens: a compact row has no checkbox.
 */
export interface CompactRowProps {
  shape: 'compact'
  task: Task
  /** The column's day and the row's time there (the Plan places a task on a day). */
  date: string
  time?: string
  today: string
  selected: boolean
  readOnly?: boolean
  project?: Project
  /** The phone agenda's 44 px rows. */
  large?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onSelect: () => void
  onOpen: () => void
  /** Hooks of the screen that hosts the row (`data-plan-task`). */
  attrs?: Record<`data-${string}`, string>
}

/** The row's own controls: a click on one of them is theirs, not the row's (row-and-cursor D1). */
const ROW_CONTROL = 'button, a, input, label, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]'

const TONE_TEXT: Partial<Record<Tone, string>> ={ danger: 'text-danger', accent: 'text-accent', default: 'text-default' }

function CompactRow({ task, date, time, today, selected, readOnly = false, project, large = false, onPointerDown, onSelect, onOpen, attrs }: CompactRowProps) {
  const priority = task.priority < 4 ? PRIORITY_RING[task.priority] : null
  return (
    <button type="button" tabIndex={large ? 0 : -1} {...attrs} data-row-shape="compact" data-hue={hueFor(project?.color ?? null)} aria-pressed={selected}
      onPointerDown={readOnly ? undefined : onPointerDown}
      onClick={(e) => { e.stopPropagation(); if (selected && large) onOpen(); else onSelect() }}
      onDoubleClick={onOpen}
      onKeyDown={large ? (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOpen() } } : undefined}
      className={`ui-block ui-block--row flex w-full min-w-0 touch-manipulation items-center gap-x-1 px-1 text-left ${large ? 'min-h-11 py-1 text-body' : 'flex-wrap py-0.5 text-meta'} ${date < today ? 'ui-block--past' : ''} ${selected ? 'ring-1 ring-accent' : ''} ${readOnly ? '' : 'cursor-grab'}`}>
      {/* Named by its visible content (WCAG 2.5.3 Label in Name), in reading order; only "read-only" has no visible text. */}
      {time && <span data-plan-time className={`shrink-0 tabular-nums ${TONE_TEXT[ladderTone(date, today)] ?? 'text-muted'}`}>{formatTime(time)}</span>}
      {/* In a narrow column the title takes the first line and the time, estimate and priority the second. */}
      <span className={`min-w-0 flex-1 truncate ${large ? '' : 'order-first basis-full'}`}>{task.title || t('Untitled')}</span>
      {task.estimate_minutes ? <span data-estimate className="shrink-0 text-hint tabular-nums text-muted">{formatMinutes(task.estimate_minutes)}</span> : null}
      {/* The row's priority ring: coloured for P1 and P2, neutral for P3; read as "P1". */}
      {priority && (
        <span data-priority={task.priority} className="inline-flex shrink-0 items-center">
          <span aria-hidden data-priority-dot className={`h-2.5 w-2.5 rounded-full border-2 ${priority}`} /><span className="sr-only">P{task.priority}</span>
        </span>
      )}
      {readOnly && <span className="sr-only">{`, ${t('read-only')}`}</span>}
    </button>
  )
}

/**
 * Memoized (large-list-performance D1): a list re-renders a row only when one of its
 * props changes, so callers pass stable handlers and per-row values (`selected` is a
 * boolean, not the list's selected id).
 */
export const TaskRow = memo(function TaskRow(props: TaskRowProps | CompactRowProps) {
  return props.shape === 'compact' ? <CompactRow {...props} /> : <FullRow {...props} />
})

function FullRow({ task, project, labels = [], assignee, assignedToMe = false, selected, showProject, depth = 0, progress, blockedBy = 0, habit = null, breadcrumb, hasChildren = false, collapsed = false, readOnly = false, onToggle, onOpen, onToggleCollapse, shape = 'row', timeColumn = false, actions = true, onMore, forceActions = false, onPointerDown, dropKey, dropIndicator = null, dragging = false, ticked = false, showCheckbox = false, onTick, hideFieldBadges = false, posInSet, setSize, implied, omitLabel, tracked: trackedProp, inline, motion, swipe = false, forceSwipe, hidden = NO_HIDDEN, source = false, expanded = false, onExpand }: TaskRowProps) {
  const card = shape === 'card'
  const hides = (p: RowProperty) => hidden.includes(p)
  // One shared, ticking map for every row (time-tracking D4); stories and tests may pass the figure.
  const trackedLive = useTaskTracked(task.id)
  const tracked = trackedProp ?? trackedLive
  const dt = useDateTimeFormat()
  const due = describeDue(task.due, undefined, undefined, dt.resolved)
  // The local day of the due, for the due ladder (page-rhythm D7).
  const dueDay = task.due ? localDueOf(task.due).date : null
  const done = !!task.completed_at
  // Start dates, Someday and This Evening (someday-and-evening D2): they say why a
  // task is in Later, or in Today without a date.
  const start = task.start ?? null
  const startText = done || !start || hides('start') || (start === 'someday' && implied?.someday) ? null
    : start === 'someday' ? t('Someday')
    : start > logicalToday() ? t('Starts {date}', { date: formatDate(start, 'compact', dt.resolved) }) : t('Started {date}', { date: formatDate(start, 'compact', dt.resolved) })
  const deadline = done || hides('deadline') ? null : describeDeadline(task.deadline, undefined, task.due ? localDueOf(task.due).date : null)
  const deadlineLabel = deadline ? t('Deadline {date}, {label}', { date: formatDate(task.deadline!, 'long', dt.resolved), label: deadline.label }) : ''
  // The column (rows-v2 D2, D3): the due time, else the deadline countdown; the line never repeats it.
  const column = timeColumn && !card && !hides('date')
  const timeInColumn = column && !!due?.time
  const deadlineInColumn = column && !due?.time && !!deadline
  const comments = useCommentCount(task.id)
  const attachments = useAttachmentCount(task.id)
  // End-to-end encryption (OpenSpec e2ee): content the server still holds in
  // plaintext is marked until an unlocked device has re-written it.
  const enc = useEncryption()
  // One shared membership map for every row, not a live query per row (large-list-performance).
  const shared = useSharedProject(task.project_id, enc.enabled)
  const unencrypted = notYetEncrypted(task as unknown as Record<string, unknown>, 'task', !shared)
  const undecryptable = !!task._e2ee?.raw?.title
  // The name controls read for the task ("Complete Buy milk"); ciphertext is never read out.
  const name = undecryptable || !task.title ? t('Untitled') : task.title
  const counts = rowCounts({ progress, notes: !!task.description, comments, attachments })
  // Custom field values of the task's project (custom-fields): three values, then "+n".
  const fieldDefs = useFieldDefs()
  // Tracked time joins the estimate: one item, `35m / 1h` (time-tracking).
  const estimate = hides('estimate') ? null : tracked !== undefined
    ? { text: trackedText(tracked, task.estimate_minutes ?? null), label: trackedLabel(tracked, task.estimate_minutes ?? null), tracked: true }
    : task.estimate_minutes ? { text: formatMinutes(task.estimate_minutes), label: t('Estimate {minutes}', { minutes: formatMinutes(task.estimate_minutes) }), tracked: false } : null
  // Where the task came from (task-origin D7): quiet text, in the trailing group of a row and the line of a card.
  // The Inbox's source line names it instead (inbox-split D4).
  const origin = hides('origin') || (source && !card) ? null : originOf(task)
  const originChip = origin ? <OriginChip origin={origin} quiet /> : null
  const projectName = showProject && project && !hides('project') ? project.name : null
  const hint = zoneHint(task.due)
  const m: MetaValues = {
    sample: isSample(task),
    breadcrumb,
    date: hides('date') ? null : rowDateText(due, dueDay, !!task.evening && !done, implied, timeInColumn),
    dateTone: dueDay ? ladderTone(dueDay, logicalToday()) : 'muted',
    hint, zone: task.due?.tz ?? '',
    repeat: task.recurrence ? t('repeats') : task.series_id ? t('occurrence') : null, recurring: !!task.recurrence,
    deadline: deadlineInColumn ? null : deadline, deadlineLabel,
    startText, someday: start === 'someday',
    estimate, blockedBy: done ? 0 : blockedBy, streak: habit && !done ? habit : null,
    badges: hideFieldBadges ? [] : fieldBadges(task, fieldDefs, dt.resolved),
    assignee: assignee && task.assignee_id && !hides('assignee') ? <AssigneeChip id={task.assignee_id} name={assignee} me={assignedToMe} /> : null,
    origin: null,
    labels: <LabelChips labels={labels} omit={omitLabel} />,
    counts: null,
  }
  if (hides('labels') || !labels.some((l) => l.id !== omitLabel)) m.labels = null
  // The project: a cell of a list row's column (precision-rows D1), the end of a card's line.
  if (projectName) m.project = <span data-project="" className="inline-flex max-w-48 min-w-0 items-center gap-1 text-meta text-muted"><TruncatedText text={projectName} /></span>
  // A list row (precision-rows D2): the third cell takes the labels, else the deadline, else the progress, which then leaves the counts.
  const progressCount = counts.find((c) => c.key === 'progress')
  const extra = rowExtra(!!m.labels, !!m.deadline, !!progressCount)
  const headCounts = extra === 'progress' ? counts.filter((c) => c.key !== 'progress') : counts
  if (card) {
    // The card's progress leads its property row; the other counts close it (precision-boards-timeline D3).
    const rest = counts.filter((c) => c.key !== 'progress')
    m.progress = progressCount
    m.counts = rest.length > 0 ? <RowCounts counts={rest} /> : null
  }
  const meta = card ? (metaItems(m) > 0 || m.project) && <CardMeta m={m} />
    : (metaItems({ ...m, repeat: null }) > 0 || m.project || extra === 'progress') && <RowLine m={m} extra={extra} progress={progressCount} projectColor={projectName ? project?.color : undefined} projectColumn={showProject && !hides('project')} />
  // Expanded rows (row-expand D2): a list row may show its details under it; never a card, the row edited in place or a departing row.
  const canExpand = !!onExpand && !card && !inline && motion !== 'leave'
  const showDetails = canExpand && expanded
  const detailsId = `row-details-${task.id}`
  // A viewer's row reveals Show details only (row-expand D2); an editor's all four actions.
  const revealed = !card && !inline && actions && (!readOnly || canExpand)

  // A departing row is the last picture of a task that was completed: done, and out of reach.
  const departing = motion === 'leave'
  const checked = done || departing
  const rowRef = useRowHeight(departing)
  // Swipe right completes, left schedules, on touch rows the user may edit (phone-v2 D3).
  const swiping = useRowSwipe({ task, enabled: swipe && !card && !readOnly && !inline && !departing, onComplete: onToggle, force: forceSwipe, rowEl: rowRef })
  const feedback = dragFeedback(prefersReducedMotion())
  const lift = dragging ? feedback.lift : ''
  // The origin is a link, so it never sits inside the open button: on a card it ends the
  // card at the top right, as before rows-v2 (a link nested in a button is invalid).
  const trailing = card ? originChip && <span data-row-trailing="" className="ml-auto flex shrink-0 items-start">{originChip}</span>
    : (originChip || revealed) && (
    // While a two-line row can reveal its actions the group keeps their width (7 rem), so they never cover the open control (ux-fixes-phone, audit M11) and revealing them moves nothing; a one-line row lets them float over its column (index.css).
    <span data-row-trailing="" className={`ml-auto mt-0.5 flex h-5 min-w-0 items-center justify-end gap-2 transition-opacity duration-(--duration-ui) ${revealed ? `${readOnly ? 'md:pointer-fine:min-w-8' : 'md:pointer-fine:min-w-36'} ${forceActions ? 'md:pointer-fine:opacity-0' : 'md:pointer-fine:group-hover:opacity-0 md:pointer-fine:group-focus-within:opacity-0'}` : ''}`}>
      {originChip && <span className="flex shrink-0">{originChip}</span>}
    </span>
  )

  return (
    <li
      ref={rowRef}
      // A departing row is not a row of the list: no id for the cursor, drops or tests.
      data-task-id={departing ? undefined : task.id}
      data-departing={departing ? task.id : undefined}
      data-rolled={motion === 'rolled' || undefined}
      data-restored={motion === 'restored' || undefined}
      aria-hidden={departing || undefined}
      inert={departing || undefined}
      data-depth={depth}
      data-drop-target={dropKey}
      data-draggable={onPointerDown ? '' : undefined}
      data-swipeable={swipe && !card && !readOnly && !inline && !departing ? '' : undefined}
      data-ticked={ticked || undefined}
      data-dragging={dragging || undefined}
      aria-current={selected || undefined}
      aria-level={card || setSize === undefined ? undefined : depth + 1}
      aria-posinset={card ? undefined : posInSet}
      aria-setsize={card ? undefined : setSize}
      onPointerDown={swipe ? (e) => { swiping.onPointerDown(e); onPointerDown?.(e) } : onPointerDown}
      // The row's empty area opens the task under either "Click a task to" choice (row-and-cursor
      // D1): a pointer shortcut; the open button stays the keyboard path. Drags and swipes
      // swallow their click (lib/dnd.ts, rowSwipe.ts), so they never get here.
      onClick={inline || departing ? undefined : (e) => {
        const hit = (e.target as Element).closest(ROW_CONTROL)
        if (hit && e.currentTarget.contains(hit)) return
        if (onTick && !readOnly && (e.shiftKey || e.ctrlKey || e.metaKey)) { onTick(e.shiftKey); return }
        onOpen()
      }}
      style={depth ? { paddingLeft: `${Math.min(depth, MAX_INDENT) * 1.5 + 0.5}rem` } : undefined}
      data-expanded={showDetails || undefined}
      className={`group relative flex items-start gap-2 rounded-control px-2 ${showDetails ? 'flex-wrap' : ''} ${card ? '' : '@container/row'} ${swipe ? 'touch-pan-y' : ''} transition-[opacity,transform] duration-(--duration-emphasis) ease-calm ${card ? 'py-2.5 border border-default bg-surface shadow-1 dark:bg-raised' : 'row-pad'} ${dropIndicator === 'inside' ? feedback.inside : ''} ${ticked ? 'bg-accent-soft' : selected ? (card ? 'ring-1 ring-accent/50' : 'row-selected') : card ? '' : 'row-hover'} ${lift}`}
    >
      {(dropIndicator === 'before' || dropIndicator === 'after') && (
        // The drop position: a line with a dot at its start (task-list-presentation "Drag feedback").
        <span aria-hidden="true" data-drop-indicator={dropIndicator}
          className={`${feedback.line} ${dropIndicator === 'before' ? '-top-px' : '-bottom-px'}`} />
      )}
      {!card && (
        // Every list reserves the same leading slot ("One row anatomy"), so checkboxes line
        // up across tree and flat views; the chevron appears only on rows with children.
        <span className="mt-0.5 flex h-5 w-4 shrink-0 items-center justify-center" data-leading-slot>
          {onToggleCollapse && hasChildren && (
            <button
              type="button"
              aria-label={collapsed ? t('Expand subtasks') : t('Collapse subtasks')}
              aria-expanded={!collapsed}
              onClick={onToggleCollapse}
              className="flex h-5 w-4 items-center justify-center rounded-chip text-faint hover:bg-sunken hover:text-muted dark:hover:bg-raised pointer-fine:-mx-1 pointer-fine:-my-0.5 pointer-fine:h-6 pointer-fine:w-6 pointer-coarse:-mx-3.5 pointer-coarse:-my-2.5 pointer-coarse:h-11 pointer-coarse:w-11"
            >
              <Icon name="chevron-right" size="xs" className={`transition-transform duration-(--duration-ui) ${collapsed ? '' : 'rotate-90'}`} />
            </button>
          )}
        </span>
      )}
      {/* One slot for both boxes ("Bulk selection does not shift rows"): the task's
          checkbox, replaced by the selection box only while a selection is in progress
          (a row is ticked, or touch Select mode), in the same 20 px square, so the title
          never moves. Hover and focus never swap them: a click on the circle always
          completes (row-checkbox-completes). */}
      <span className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center self-start" data-row-controls data-selecting={onTick && !readOnly && (showCheckbox || ticked) ? '' : undefined}>
        <button
          type="button"
          aria-label={done ? t('Reopen {title}', { title: name }) : t('Complete {title}', { title: name })}
          onClick={onToggle}
          disabled={readOnly}
          className={`group/check touch-target inline-flex items-center justify-center rounded-full pointer-fine:-m-0.5 pointer-fine:size-6 pointer-coarse:-m-3 ${onTick && !readOnly && (showCheckbox || ticked) ? 'invisible' : ''}`}
        >
          <span data-check-mark className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors duration-(--duration-ui) ${checked ? 'bg-faint border-input text-on-accent' : `${PRIORITY_RING[task.priority]} group-hover/check:bg-success-soft`}`}>
            {checked && <Icon name="check" size="xs" />}
          </span>
        </button>
        {onTick && !readOnly && (
          <label className={`absolute inset-0 cursor-pointer items-center justify-center pointer-fine:-inset-0.5 pointer-coarse:-inset-3.5 ${showCheckbox || ticked ? 'inline-flex' : 'hidden'}`}>
            <input type="checkbox" className="h-4 w-4 accent-(--ot-accent)" checked={ticked} aria-label={t('Select {title}', { title: name })} data-tick
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); onTick(e.shiftKey) }} onChange={() => {}} />
          </label>
        )}
      </span>
      {column && <TimeCell time={due?.time ?? null} timeTone={dueDay ? ladderTone(dueDay, logicalToday()) : 'muted'} deadline={deadlineInColumn ? deadline : null} deadlineLabel={deadlineLabel} />}
      {inline ?? <button type="button" className="flex min-w-0 flex-1 flex-col text-left pointer-fine:-my-px pointer-fine:py-px" data-row-open
        aria-expanded={canExpand ? showDetails : undefined} aria-controls={showDetails ? detailsId : undefined}
        onClick={(e) => {
          // Shift+click extends, Ctrl/⌘+click toggles the tick instead of opening (bulk-edit D3).
          if (onTick && !readOnly && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); onTick(e.shiftKey); return }
          onOpen(e)
        }}>
        <div className={card ? '' : 'flex min-w-0 items-center gap-2'} data-row-head>
        <div className={`user-text text-body ${card ? 'line-clamp-2' : 'min-w-0 truncate'} ${checked ? 'text-faint line-through' : blockedBy > 0 ? 'text-muted' : ''}`} data-row-title>
          {undecryptable ? <span className="italic text-faint"><ReadAs label={t('This title could not be decrypted with this device\'s key')}>{task.title}</ReadAs></span>
            : task.title || <span className="italic text-faint">{t('Untitled')}</span>}
          {unencrypted && (
            <span className="ml-2 rounded-chip bg-warning-soft px-1.5 py-0.5 align-middle text-hint text-on-warning-soft">
              <ReadAs label={t('The server still holds this text unencrypted; it is encrypted after the next sync of an unlocked device.')}>{t('not yet encrypted')}</ReadAs>
            </span>
          )}
        </div>
        {!card && m.repeat && <ToneText tone="faint" icon="repeat" data-repeat="" data-recurring={m.recurring ? '' : undefined} label={m.repeat} className="shrink-0">{null}</ToneText>}
        {!card && headCounts.length > 0 && <RowCounts counts={headCounts} />}
        </div>
        {meta}
        {source && !card && <SourceLine task={task} />}
      </button>}
      {trailing}
      {canExpand && (
        // Touch and narrow windows (row-expand D2): one quiet disclosure at the row's end; a fine pointer from 768 px has it in the revealed actions.
        // The slot sits on the title's line like the checkbox's; the button inside takes a 44 px target on touch.
        <span data-row-expand="" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center md:pointer-fine:hidden">
          <button type="button" aria-expanded={showDetails} aria-controls={showDetails ? detailsId : undefined}
            aria-label={showDetails ? t('Hide details') : t('Show details')} onClick={onExpand}
            className="touch-target flex h-5 w-5 items-center justify-center rounded-chip text-faint hover:bg-hover hover:text-muted pointer-coarse:-m-3">
            <Icon name="chevron-down" size="xs" className={`transition-transform duration-(--duration-ui) ${showDetails ? 'rotate-180' : ''}`} />
          </button>
        </span>
      )}
      {revealed && <RowActionCluster task={task} onMore={onMore} force={forceActions} editable={!readOnly}
        details={canExpand ? { expanded: showDetails, controls: detailsId, onToggle: onExpand! } : undefined} />}
      {showDetails && (
        // Indented under the title column: past the leading slot, the checkbox and the time column (row-expand D3).
        // The id lives here, so `aria-controls` names an element while the lazy details still load.
        <div id={detailsId} role="group" aria-label={t('Details of {title}', { title: name })} className={`min-w-0 basis-full pl-[3.25rem] ${column ? 'md:pl-[calc(3.75rem+var(--row-time-w))]' : ''}`}>
          <Suspense fallback={null}>
            <RowDetails task={task} readOnly={readOnly} childrenShown={!!onToggleCollapse && hasChildren && !collapsed} onOpen={() => onOpen()} />
          </Suspense>
        </div>
      )}
      {swipe && swiping.layers}
    </li>
  )
}

/** Measures a departing row so its collapse starts from its own height (motion-v2 D3). */
function useRowHeight(departing: boolean) {
  const ref = useRef<HTMLLIElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (departing && el) el.style.setProperty('--row-h', `${el.offsetHeight}px`)
  }, [departing])
  return ref
}

/** The board card: the same row data as a card (sections-and-boards "Card content"). */
export function TaskCard(props: Omit<TaskRowProps, 'shape'>) {
  return <TaskRow {...props} shape="card" />
}
