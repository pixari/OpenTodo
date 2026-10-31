// The task list's data (OpenSpec change web-component-structure): live reads from
// lib/liveData and the shared task snapshot, turned into rows and groups by the
// pure functions of lib/listGroups. One hook, so TaskListView only renders.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePlace } from '../../lib/locations'
import { blockedMap } from '../../lib/dependencies'
import { useFlowView } from '../../lib/useFlow'
import { durationPredicate, loadDurationFilter, saveDurationFilter, type DurationFilter } from '../../lib/filters'
import { UPCOMING_FILTER_KEY, useQueryFilter } from '../calendar/queryFilter'
import { habitStatsMap } from '../../lib/habits'
import { boardColumns, completedBySection, completedNewestFirst, completedOpenKey, listGroups, sectionBuckets, siblingPositions, tasksForView, type ListGroup, type ListScope } from '../../lib/listGroups'
import { useAllLabels, useCollapsedSections, useListColumnsPref, useLiveProjects, useMemberships, useProjectPrefsRow, useProjectSectionRows, useProjectViewMode, useShowCompletedPref } from '../../lib/liveData'
import { listDisplayOf, type DisplayScope } from '../../lib/listDisplay'
import { useListDisplay } from './useListDisplay'
import { orderRank } from '../../lib/viewOrder'
import { useAccountRowLayout } from '../../lib/rowLayout'
import { useUserPrefsRow } from '../../lib/localData'
import { dayPartsOn } from '../../lib/dayParts'
import { useClosedList } from './useClosedList'
import { NO_TASKS, useLiveTasks } from '../../lib/liveTasks'
import { LOGBOOK_PAGE, logbookGroups } from '../../lib/logbook'
import { canEditTasks, roleOf } from '../../lib/sharing'
import { buildTaskTree, progressMap } from '../../lib/subtasks'
import type { Task } from '../../lib/types'
import { inLater } from '../../lib/views'
import { DESKTOP_HEADER_QUERY, useMediaQuery } from '../../ui'
import { useDateTimeFormat } from '../DateTimePrefsProvider'
import { hasTimeColumn } from '../../lib/rowTime'
import { useSlotted } from '../../lib/slots'
import type { Route } from '../router'
import { useApplicableFields, useFieldDefs } from '../useFields'
import { useToday, useViewerZone } from '../useViews'
import { readJSON, writeJSON } from '../../lib/deviceStorage'
import { useResetOnChange } from '../../lib/useResetOnChange'
import { useUpcomingGroups } from './upcomingProjections'

export type ListRoute = Extract<Route, ListScope>

const COLLAPSE_KEY = 'opentodo.collapsed'

function loadCollapsed(): Set<string> {
  return new Set(readJSON<string[]>(COLLAPSE_KEY, [], (v) => (Array.isArray(v) ? v as string[] : null)))
}

function saveCollapsed(set: Set<string>) {
  writeJSON(COLLAPSE_KEY, [...set]) // per-device convenience only; losing it is harmless
}

/** Views that offer the duration filter, each with its own per-device setting. */
export function durationFilterKey(route: ListRoute): string | null {
  switch (route.view) {
    case 'inbox':
    case 'today':
    case 'upcoming':
      return route.view
    case 'project':
      return `project:${route.id}`
    default:
      return null
  }
}

/** Duration filter chips (OpenSpec `time-blocking`): per view, per device. */
function useDurationFilter(route: ListRoute) {
  const filterKey = durationFilterKey(route)
  const [duration, setDuration] = useState<DurationFilter | null>(() => (filterKey ? loadDurationFilter(filterKey) : null))
  useEffect(() => {
    setDuration(filterKey ? loadDurationFilter(filterKey) : null)
  }, [filterKey])
  const chooseDuration = useCallback((kind: DurationFilter | null) => {
    if (!filterKey) return
    setDuration(kind)
    saveDurationFilter(filterKey, kind)
  }, [filterKey])
  return { filterKey, duration, chooseDuration }
}

/** Collapsed tree rows (and the open Blocked group), per device. */
function useCollapsedRows() {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const toggleCollapsed = useCallback((id: string, force?: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      const want = force ?? !next.has(id)
      if (want) next.add(id)
      else next.delete(id)
      saveCollapsed(next)
      return next
    })
  }, [])
  return { collapsed, toggleCollapsed }
}

/** Sections, layout and columns of a project (OpenSpec `board-view`, custom-fields); per-device preferences. */
function useProjectLayout(projectId: string | null) {
  const sections = useProjectSectionRows(projectId)
  const liveSections = useMemo(() => sections.filter((s) => !s.deleted_at), [sections])
  const viewMode = useProjectViewMode(projectId)
  const collapsedSections = useCollapsedSections(projectId)
  // Custom fields (custom-fields): the list's columns layout, offered on wide
  // screens when the project defines fields; below 768 px rows show badges.
  // Inherited fields are columns too (inherited-custom-fields).
  const fieldsOf = useApplicableFields()
  const projectFieldDefs = useMemo(() => fieldsOf(projectId), [projectId, fieldsOf])
  const wideScreen = useMediaQuery(DESKTOP_HEADER_QUERY)
  const columnsPref = useListColumnsPref(projectId)
  const offerColumns = !!projectId && viewMode === 'list' && wideScreen && projectFieldDefs.length > 0
  const sectionMap = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections])
  return {
    sections, liveSections, viewMode, collapsedSections, projectFieldDefs, columnsPref, offerColumns, sectionMap,
    fieldColumns: offerColumns && columnsPref,
    board: !!projectId && viewMode === 'board',
    timeline: !!projectId && viewMode === 'timeline',
  }
}

export function useListModel(route: ListRoute, userId?: string) {
  const allFieldDefs = useFieldDefs()
  const dt = useDateTimeFormat()
  // Re-read every minute: Today, Upcoming and the Logbook roll over at midnight.
  const today = useToday()
  // Zoned dues (absolute-datetimes) are grouped in the viewer zone; re-group when it changes.
  const zone = useViewerZone()
  const projects = useLiveProjects()
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const treeView = route.view === 'project' || route.view === 'inbox'
  const labels = useAllLabels()
  // Cached memberships (project-sharing): viewers get a read-only project, also offline.
  const memberships = useMemberships()
  const memberMap = useMemo(() => new Map(memberships.map((m) => [m.projectId, m])), [memberships])
  const isReadOnly = useCallback((tk: Task | undefined) => !!tk && roleOf(tk.project_id, memberMap) === 'viewer', [memberMap])
  const labelMap = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const projectId = route.view === 'project' ? route.id : null

  // Every live task once; views, breadcrumbs and progress badges derive from this set,
  // so a remote op that lands in IndexedDB updates all of them without a reload. The
  // snapshot is shared with the sidebar and the panel (large-list-performance D2).
  const liveTasks = useLiveTasks()
  const allTasks = liveTasks ?? NO_TASKS
  const taskMap = useMemo(() => new Map(allTasks.map((task) => [task.id, task])), [allTasks])
  const progress = useMemo(() => progressMap(allTasks), [allTasks])
  const blocked = useMemo(() => blockedMap(allTasks), [allTasks])
  // Steps waiting in sequence (project-flow-modes): dimmed rows, and Today folds them with the blocked ones.
  const flow = useFlowView(allTasks, today)
  const held = useMemo(() => flow.held(blocked), [flow, blocked])
  // Streaks of habits (OpenSpec habits D5): once per list, from the rows it holds.
  const habits = useMemo(() => habitStatsMap(allTasks, today), [allTasks, today])

  const filter = useDurationFilter(route)
  const { duration, filterKey } = filter
  // eslint-disable-next-line react-hooks/exhaustive-deps -- zone: a zone change re-groups zoned dues (absolute-datetimes)
  const viewTasks = useMemo(() => tasksForView(route, allTasks, projects, today, userId), [allTasks, projects, route, today, zone, userId])
  // Upcoming's query filter (calendar-clarity D4), under the duration filter; per device, on local rows.
  const upcoming = useQueryFilter(UPCOMING_FILTER_KEY, allTasks)
  const queryTest = route.view === 'upcoming' ? upcoming.test : null
  const tasks = useMemo(() => {
    const byDuration = !duration || !filterKey ? viewTasks : viewTasks.filter(durationPredicate(duration))
    return queryTest ? byDuration.filter(queryTest) : byDuration
  }, [viewTasks, duration, filterKey, queryTest])

  // Completed renders a page of the logbook at a time; a new route starts again.
  const [logbookLimit, setLogbookLimit] = useState(LOGBOOK_PAGE)
  useResetOnChange([route.view], () => setLogbookLimit(LOGBOOK_PAGE))
  const logbook = useMemo(() => (route.view === 'completed' ? logbookGroups(tasks, logbookLimit) : null), [route.view, tasks, logbookLimit])

  const { collapsed, toggleCollapsed } = useCollapsedRows()
  const layout = useProjectLayout(projectId)
  const { board, sections, liveSections, collapsedSections } = layout

  // Project lists keep deferred and parked tasks in a Later group at the
  // end (someday-and-evening D2); the board keeps every card in its column.
  const laterTasks = useMemo(() => (treeView && !board ? tasks.filter((task) => inLater(task, today)) : []), [treeView, board, tasks, today])
  const treeTasks = useMemo(() => (laterTasks.length ? tasks.filter((task) => !inLater(task, today)) : tasks), [laterTasks, tasks, today])
  const tree = useMemo(() => (treeView ? buildTaskTree(treeTasks) : null), [treeView, treeTasks])
  const buckets = useMemo(() => sectionBuckets(projectId, tree, sections), [projectId, tree, sections])
  const columns = useMemo(() => boardColumns(buckets, collapsedSections), [buckets, collapsedSections])

  // A project's or label's display options (list-display-options): personal and synced.
  const prefsRow = useProjectPrefsRow(projectId)
  const labelRow = route.view === 'label' ? labelMap.get(route.id) : undefined
  const displayScope = useMemo<DisplayScope | null>(() => (route.view === 'project' || route.view === 'label' ? { kind: route.view, id: route.id } : null), [route])
  const account = useAccountRowLayout()
  const { groupBy: dGroup, sortBy: dSort, sortDir: dDir, rowLayout: dRows } = displayScope ? listDisplayOf(displayScope.kind, displayScope.kind === 'project' ? prefsRow : labelRow, account) : { groupBy: undefined, sortBy: undefined, sortDir: undefined, rowLayout: undefined }
  const display = useMemo(() => (dGroup && dSort && dDir && dRows ? { groupBy: dGroup, sortBy: dSort, sortDir: dDir, rowLayout: dRows } : undefined), [dGroup, dSort, dDir, dRows])
  // The header's display button and the switch to manual order; a project's board and timeline have their own layout.
  const sortFields = route.view === 'project' ? layout.projectFieldDefs : allFieldDefs
  const listDisplay = useListDisplay(display, displayScope, route.view === 'label' || layout.viewMode === 'list', sortFields)
  // A label page's own manual order (view-manual-order D1): the rank of each placed task.
  const labelOrder = labelRow?.manual_order
  const manualOrder = useMemo(() => (route.view === 'label' ? orderRank(labelOrder) : undefined), [route.view, labelOrder])

  // Today grouped by part of the day (day-parts D3): the account's synced choice.
  const dayParts = dayPartsOn(useUserPrefsRow())
  // Today's closed list (today-closed-list): slots from the whole of Today, before the duration filter.
  const closed = useClosedList(route.view === 'today', viewTasks, allTasks, today, flow, blocked)
  const closedList = useMemo(() => {
    if (!closed.fill.limit) return undefined
    const shown = new Set(tasks.map((x) => x.id))
    return { limit: closed.fill.limit, waiting: closed.fill.waiting.filter((id) => shown.has(id)).map((id) => taskMap.get(id)!).filter(Boolean) }
  }, [closed.fill, tasks, taskMap])
  const doneToday = closed.doneToday ?? undefined
  const groups = useMemo<ListGroup[]>(() => listGroups({
    view: route.view, tasks, laterTasks, tree, today, resolved: dt.resolved, collapsed, blocked: held, taskMap,
    projects, projectMap, fields: sortFields, board, columns, buckets, sectionCount: liveSections.length, collapsedSections, logbook, display, labels, manualOrder, dayParts, closedList, doneToday,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zone: a zone change re-groups zoned dues (absolute-datetimes)
  }), [dt.resolved, tree, tasks, laterTasks, route.view, today, zone, collapsed, held, taskMap, projects, projectMap, sortFields, board, columns, buckets, liveSections, collapsedSections, logbook, display, labels, manualOrder, dayParts, closedList, doneToday])
  // Upcoming's projected occurrences (series-occurrences D4): off by default, per device; never rows.
  const projectedGroups = useUpcomingGroups(route.view === 'upcoming', groups, { allTasks, projects, today, zone, duration: filterKey ? duration : null, queryTest, resolved: dt.resolved })
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  // The list's own rows: Today's Done today group is not part of Today's open list (today-closed-list D6).
  const ownRows = useMemo(() => (doneToday?.length ? groups.filter((g) => g.key !== 'done').flatMap((g) => g.rows) : rows), [doneToday, groups, rows])
  const siblingPos = useMemo(() => siblingPositions(groups), [groups])
  // The time column (rows-v2 D2): one fact of the whole list, from its visible rows; cards have none.
  // A task a calendar slot holds shows the slot's start there (calendar-slots D8).
  const slotted = useSlotted()
  const timeColumn = useMemo(() => !board && hasTimeColumn(rows.map((r) => r.task), slotted), [board, rows, slotted])
  // Sections with only completed tasks keep a header with "n completed" and Show
  // (task-list-presentation "Empty groups").
  const doneBySection = useMemo(() => completedBySection(allTasks, projectId, layout.sectionMap), [allTasks, projectId, layout.sectionMap])
  // With "Show completed tasks" on (project-completed-section), the list layout
  // keeps them in one Completed group at the end, newest first, closed by default.
  const showCompletedPref = useShowCompletedPref(projectId)
  const showCompleted = !!projectId && showCompletedPref && !board && !layout.timeline
  const completedTasks = useMemo(() => (showCompleted ? completedNewestFirst(doneBySection) : NO_TASKS), [showCompleted, doneBySection])
  const completedOpen = !!projectId && collapsed.has(completedOpenKey(projectId))

  // A place's list (task-locations): undefined while loading, null when it does not exist.
  const placeId = route.view === 'place' ? route.id : null
  const currentPlace = usePlace(placeId)

  return {
    /** The tasks are read: until then the list shows nothing rather than filling in stages. */
    loaded: liveTasks !== undefined,
    dt, today, zone, projects, projectMap, labels, labelMap, memberMap, isReadOnly, treeView, projectId,
    currentProject: route.view === 'project' ? projectMap.get(route.id) : undefined,
    currentLabel: route.view === 'label' ? labelMap.get(route.id) : undefined,
    currentPlace,
    projectReadOnly: route.view === 'project' && roleOf(route.id, memberMap) === 'viewer',
    projectEditable: !!projectId && canEditTasks(roleOf(projectId, memberMap)),
    allTasks, taskMap, progress, blocked, flow, habits, ...filter, logbook, logbookLimit, setLogbookLimit,
    collapsed, toggleCollapsed, ...layout, tree, columns, groups: projectedGroups, rows, ownRows, siblingPos, timeColumn, doneBySection,
    showCompleted, completedTasks, completedOpen, display, displayScope, listDisplay, dayParts, closed,
    queryFilter: route.view === 'upcoming' ? upcoming : null,
  }
}

export type ListModel = ReturnType<typeof useListModel>
