// The list body (OpenSpec change web-component-structure): rows, the grouped list
// with its headers and section groups, and the logbook's "Show more". The board and
// the timeline have their own bodies (BoardView, TimelineView).
import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef } from 'react'
import { t } from '../../lib/i18n'
import { BLOCKED_OPEN_KEY, earlierCollapsed, flatRow, type ListGroup, type ListRow as Row } from '../../lib/listGroups'
import type { DropAt } from '../listDrop'
import { memberName } from '../../lib/sharing'
import type { Progress } from '../../lib/subtasks'
import type { HabitStats } from '../../lib/habits'
import type { FieldDef, Label, Membership, Project, Task } from '../../lib/types'
import { Button, ListGroupHeader } from '../../ui'
import { sectionTarget, type BoardColumn } from '../BoardView'
import { groupKey, setGroupCollapsed } from '../collapsedGroups'
import { FieldColumnsRow, FieldColumnsTable } from '../FieldColumns'
import { SectionHeader, SectionQuickAdd } from '../Sections'
import { isGhost, listCommitted, markGhost, registerList, useDepartures, withGhosts, type Departure } from '../motion'
import { navigate } from '../router'
import type { RowMotion } from '../TaskRow'
import { ListRow, SubtaskInput, type RowActions } from './ListRow'
import type { ListRoute } from './useListModel'

export interface RowContext {
  /** Touch rows follow a swipe (phone-v2 D3): coarse pointer, nothing ticked, not select mode. */
  swipe?: boolean
  view: ListRoute['view']
  /** The open label's id in a label's view: its own chip is left out of Calm rows (calm-rows D3). */
  labelId?: string
  userId?: string
  projectMap: Map<string, Project>
  labelMap: Map<string, Label>
  memberMap: Map<string, Membership>
  selectedId: string | null
  progress: Map<string, Progress>
  blocked: Map<string, number>
  habits: Map<string, HabitStats>
  isReadOnly: (task: Task) => boolean
  board: boolean
  manual: boolean
  treeView: boolean
  dropAt: DropAt | null
  draggingId: string | null
  ticked: ReadonlySet<string>
  showCheckbox: boolean
  fieldColumns: boolean
  projectFieldDefs: FieldDef[]
  siblingPos: Map<string, { pos: number; size: number }>
  /** The list shows the time column (rows-v2 D2). */
  timeColumn: boolean
  actions: RowActions
  addingUnder: string | null
  onCloseSubtask: () => void
  /** The row being edited in place, and its editor (inline-task-editing). */
  inlineId?: string | null
  renderInline?: (task: Task) => ReactNode
  /** Running completion sequences (motion-v2). */
  departures?: ReadonlyMap<string, Departure>
  /** The one row whose details are shown under it (row-expand D4). */
  expandedId?: string | null
}

/** The sequence a row plays: a ghost departs, a completed row that stayed rolled forward, Undo restores. */
function rowMotion(task: Task, departures: ReadonlyMap<string, Departure> | undefined): RowMotion | undefined {
  if (isGhost(task)) return 'leave'
  const d = departures?.get(task.id)
  if (d === 'restored') return 'restored'
  if (d === 'leave' && !task.completed_at) return 'rolled'
  return undefined
}

/** A group's rows with its departing rows kept in place (motion-v2 D2); counts skip them. */
export function useGhostGroups(groups: ListGroup[], departures: ReadonlyMap<string, Departure>): ListGroup[] {
  const memory = useRef(new Map<string, { list: string; after: string | null; ghost: Row }>())
  return useMemo(() => {
    if (departures.size === 0 && memory.current.size === 0) return groups
    const shown = withGhosts(groups.map((g) => ({ key: g.key, items: g.rows })), (r) => r.task.id, (r) => ({ ...r, task: markGhost({ ...r.task }) }), departures, memory.current)
    return groups.map((g) => (shown.get(g.key)!.length === g.rows.length ? g : { ...g, rows: shown.get(g.key)! }))
  }, [groups, departures])
}

/** A board's cards with their departing cards kept in place. */
export function useGhostColumns(columns: BoardColumn[], departures: ReadonlyMap<string, Departure>): BoardColumn[] {
  const memory = useRef(new Map<string, { list: string; after: string | null; ghost: Task }>())
  return useMemo(() => {
    if (departures.size === 0 && memory.current.size === 0) return columns
    const shown = withGhosts(columns.map((c) => ({ key: c.key, items: c.cards })), (task) => task.id, (task) => ({ ...task }), departures, memory.current)
    return columns.map((c) => (shown.get(c.key)!.length === c.cards.length ? c : { ...c, cards: shown.get(c.key)! }))
  }, [columns, departures])
}

/**
 * The list's motion (motion-v2): its groups and board columns with departing rows kept
 * in place (D2), and the hooks a list transition needs: the list is on screen, and it
 * says when it committed, so the new snapshot shows the write (D4).
 */
export function useListMotion(groups: ListGroup[], columns: BoardColumn[]) {
  const departures = useDepartures()
  const shownGroups = useGhostGroups(groups, departures)
  const shownColumns = useGhostColumns(columns, departures)
  useLayoutEffect(() => listCommitted())
  useLayoutEffect(() => registerList(), [])
  return { groups: shownGroups, columns: shownColumns, departures }
}

/** Rows that count: everything but the departing ones. */
export const liveRows = (rows: Row[]): number => rows.reduce((n, r) => n + (isGhost(r.task) ? 0 : 1), 0)

/** One task line (or a board card), inside the columns table when that layout is on (custom-fields). */
export function rowRenderer(c: RowContext): (r: Row) => ReactNode {
  const tree = c.treeView && !c.board
  const line = (r: Row) => {
    // The row being edited in place is not dragged: a press in its field selects text.
    const editing = !c.board && c.inlineId === r.task.id
    const motion = rowMotion(r.task, c.departures)
    // A departing row (motion-v2 D2) is a picture: no cursor, tick, drag or drop.
    const ghost = motion === 'leave'
    return (
      <Fragment key={r.task.id}>
        <ListRow
          motion={motion}
          task={r.task}
          depth={r.depth}
          breadcrumb={r.breadcrumb}
          hasChildren={r.hasChildren}
          collapsed={r.collapsed}
          project={r.task.project_id ? c.projectMap.get(r.task.project_id) : undefined}
          labelMap={c.labelMap}
          assignee={r.task.assignee_id && r.task.project_id && c.memberMap.has(r.task.project_id)
            ? (r.task.assignee_id === c.userId ? t('You') : memberName(r.task.assignee_id, c.memberMap) ?? t('Former member')) : null}
          assignedToMe={!!c.userId && r.task.assignee_id === c.userId}
          showProject={c.view !== 'project' && c.view !== 'label' && c.view !== 'inbox'}
          source={c.view === 'inbox' && r.depth === 0 && !c.board}
          implied={r.implied}
          omitLabel={c.view === 'label' ? c.labelId : undefined}
          selected={!ghost && r.task.id === c.selectedId}
          progress={c.progress.get(r.task.id)}
          blockedBy={c.blocked.get(r.task.id)}
          habit={c.habits.get(r.task.id)}
          readOnly={ghost || c.isReadOnly(r.task)}
          shape={c.board ? 'card' : 'row'}
          timeColumn={c.timeColumn}
          draggable={!ghost && !editing && !c.isReadOnly(r.task)}
          reorderable={!ghost && c.manual}
          collapsible={tree}
          expandable={!c.board && !ghost}
          // No row shows its details while a drag runs, so drop zones are one-line rows (row-expand D4).
          expanded={!ghost && !c.draggingId && c.expandedId === r.task.id}
          dropIndicator={!ghost && c.dropAt?.id === r.task.id ? c.dropAt.zone : null}
          dragging={!ghost && c.draggingId === r.task.id}
          ticked={!ghost && c.ticked.has(r.task.id)}
          showCheckbox={c.showCheckbox}
          hideFieldBadges={c.fieldColumns}
          posInSet={tree ? c.siblingPos.get(r.task.id)?.pos : undefined}
          setSize={tree ? c.siblingPos.get(r.task.id)?.size : undefined}
          handlers={c.actions}
          swipe={!!c.swipe && !ghost && !editing && !c.board}
          inline={editing ? c.renderInline?.(r.task) : undefined}
        />
        {c.addingUnder === r.task.id && !c.board && (
          <li>
            <SubtaskInput parent={r.task} depth={r.depth + 1} onClose={c.onCloseSubtask} />
          </li>
        )}
      </Fragment>
    )
  }
  return (r) => (c.fieldColumns ? <FieldColumnsRow key={r.task.id} task={r.task} defs={c.projectFieldDefs} row={line(r)} /> : line(r))
}

export interface GroupedListProps {
  groups: ListGroup[]
  view: ListRoute['view']
  project?: Project
  fieldColumns: boolean
  projectFieldDefs: FieldDef[]
  editable: boolean
  renderRow: (r: Row) => ReactNode
  addingTo: string | null
  setAddingTo: (key: string | null) => void
  onToggleSection: (key: string) => void
  doneBySection: Map<string, Task[]>
  revealed: ReadonlySet<string>
  onReveal: (groupKey: string) => void
  toggleCollapsed: (id: string) => void
  collapsedGroups: ReadonlySet<string>
  projects: Project[]
  labels: Label[]
  /** The project's Completed group at the end of the list (project-completed-section). */
  completed?: { tasks: Task[]; open: boolean; onToggle: () => void }
  /** The always-visible actions of Today's Earlier group, for its task ids (page-rhythm D6). */
  earlierActions?: (ids: readonly string[]) => ReactNode
}

/** The list's groups: section groups of a project (headings are drop targets), or headed groups. */
export function GroupedList(p: GroupedListProps) {
  /** The rows of a group: a list, or a row group of the columns table (custom-fields). */
  const rowList = (children: ReactNode, extra?: Record<string, string>) => (p.fieldColumns
    ? <div role="rowgroup" {...extra}>{children}</div>
    : <ul {...extra}>{children}</ul>)
  const body = [...p.groups.map((g, gi) => (g.section !== undefined && p.project
    ? <SectionGroup key={g.key} g={g} first={gi <= 1} last={gi === p.groups.length - 1} rowList={rowList} {...p} project={p.project} />
    : <HeadedGroup key={g.key} g={g} rowList={rowList} {...p} />)),
  p.completed && p.completed.tasks.length > 0 && <CompletedGroup key="completed" c={p.completed} rowList={rowList} renderRow={p.renderRow} fieldColumns={p.fieldColumns} />]
  return p.fieldColumns ? <FieldColumnsTable defs={p.projectFieldDefs}>{body}</FieldColumnsTable> : <>{body}</>
}

type RowList = (children: ReactNode, extra?: Record<string, string>) => ReactNode

/** Project list grouped by section (board-view). */
function SectionGroup({ g, first, last, rowList, project, ...p }: GroupedListProps & { g: ListGroup; first: boolean; last: boolean; rowList: RowList; project: Project }) {
  const key = g.section?.id ?? ''
  return (
    <section role={p.fieldColumns ? 'rowgroup' : undefined} className="mb-3 rounded-control data-drop-active:ring-2 data-drop-active:ring-accent" data-drop-target={sectionTarget(key)}>
      <SectionHeader
        section={g.section ?? null}
        count={g.count ?? 0}
        layout="list"
        editable={p.editable}
        first={first}
        last={last}
        collapsed={g.sectionCollapsed}
        onToggleCollapse={() => p.onToggleSection(key)}
        onAdd={() => p.setAddingTo(key)}
        completed={p.doneBySection.get(key)?.length ?? 0}
        revealed={p.revealed.has(g.key)}
        onReveal={() => p.onReveal(g.key)}
      />
      {p.addingTo === key && p.editable && (
        <SectionQuickAdd project={project} sectionId={g.section?.id ?? null} sectionName={g.heading ?? t('No section')} projects={p.projects} labels={p.labels} onClose={() => p.setAddingTo(null)} />
      )}
      {rowList(g.rows.map((r) => p.renderRow(r)))}
      {g.count === 0 && p.revealed.has(g.key) && rowList(
        (p.doneBySection.get(key) ?? []).map((task) => p.renderRow(flatRow(task))),
        { 'data-revealed-completed': '' },
      )}
    </section>
  )
}

/** A date, project, Later or Blocked group; collapsible per device. */
function HeadedGroup({ g, rowList, view, collapsedGroups, toggleCollapsed, renderRow, earlierActions }: GroupedListProps & { g: ListGroup; rowList: RowList }) {
  if (g.rows.length === 0 && g.folded === undefined) return null
  // Today's Earlier group (page-rhythm D5): folded above five tasks until this device chooses.
  const earlier = view === 'today' && g.key === 'earlier'
  const collapsed = earlier ? earlierCollapsed(collapsedGroups, g.rows.length) : collapsedGroups.has(groupKey(view, g.key))
  const toggle = () => {
    if (!earlier) return setGroupCollapsed(view, g.key, !collapsed)
    setGroupCollapsed('today', 'earlier', !collapsed)
    setGroupCollapsed('today', 'earlier:open', collapsed)
  }
  return (
    <section className="mb-4" data-group={g.key}>
      {g.folded !== undefined ? (
        <ListGroupHeader title={g.heading ?? ''} count={g.count} collapsed={g.folded} onToggle={() => toggleCollapsed(g.openKey ?? BLOCKED_OPEN_KEY)}
          actions={g.key === 'planned' ? <PlannedActions /> : undefined} actionsAlwaysVisible={g.key === 'planned'} />
      ) : g.heading && (
        <ListGroupHeader title={g.heading} count={g.note ? undefined : liveRows(g.rows)} note={g.note} kind={g.named ? 'named' : 'generated'}
          collapsed={collapsed} onToggle={toggle}
          actions={earlier ? earlierActions?.(g.rows.filter((r) => !isGhost(r.task)).map((r) => r.task.id)) : undefined} actionsAlwaysVisible={earlier} />
      )}
      {!(g.heading && g.folded === undefined && collapsed) && rowList(g.rows.map((r) => renderRow(r)))}
    </section>
  )
}

/** The Inbox's "Planned, no project" group header action (inbox-planned-group D3): the same tasks in Filter. */
function PlannedActions() {
  return (
    <Button variant="ghost" size="sm" className="text-meta" onClick={() => navigate({ view: 'filter', q: 'no project' })} data-planned-filter>
      {t('Open as a new view')}
    </Button>
  )
}

/**
 * The project's completed tasks at the end of its list (project-completed-section):
 * closed by default, newest first; unchecking one puts it back among the open tasks.
 */
function CompletedGroup({ c, rowList, renderRow, fieldColumns }: { c: NonNullable<GroupedListProps['completed']>; rowList: RowList; renderRow: (r: Row) => ReactNode; fieldColumns: boolean }) {
  return (
    <section role={fieldColumns ? 'rowgroup' : undefined} className="mb-4" data-completed-group>
      <ListGroupHeader title={t('Completed')} count={c.tasks.length} countLabel={(n) => t('{n, plural, one {# completed task} other {# completed tasks}}', { n })} collapsed={!c.open} onToggle={c.onToggle} />
      {c.open && rowList(c.tasks.map((task) => renderRow(flatRow(task))))}
    </section>
  )
}

/** The logbook pages through completions (completed-date-filters D4). */
export function LogbookMore({ total, limit, onMore }: { total: number; limit: number; onMore: () => void }) {
  if (total <= limit) return null
  return (
    <div className="mb-4 flex justify-center">
      <Button variant="secondary" size="sm" onClick={onMore} data-logbook-more>
        {t.rich('Show more {older}', { older: <span className="tabular-nums text-muted">{t('{n} older', { n: total - limit })}</span> })}
      </Button>
    </div>
  )
}
