// The New view page (OpenSpec changes filter-query-language and views-and-display): a
// query over the local store, shown with display options and saved as a view in place.
// Parsing and evaluation are pure (lib/filter); results are a live query, so local edits
// and synced ops update them without a reload, offline too. The grouping and order are
// the saved view's (lib/views), so what is saved is what was seen.
import { isFirstRow, revealRow } from './task-list/revealRow'
import { Button, EmptyState, PageBody, PageHeader, Dialog } from '../ui'
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { blockedMap } from '../lib/dependencies'
import { useFlowView } from '../lib/useFlow'
import { useAllLabels, useProjects } from '../lib/localData'
import { addFilterHistory, clearFilterDraft, compile, getFilterDraft, saveFilterDraft, type FilterDraft, fieldSuggestions, getFilterHistory, mentionsState, namesWorkspace, originSuggestions, parse, withCompletedTasks, type Node } from '../lib/filter'
import { useWorkspaceFilter } from './useWorkspaceFilter'
import { useFieldDefs } from './useFields'
import { resolveLabels } from '../lib/labels'
import { hasTimeColumn } from '../lib/rowTime'
import { setTaskCompleted } from '../lib/ops'
import { breadcrumbOf, progressMap } from '../lib/subtasks'
import { habitStatsMap } from '../lib/habits'
import { compareTasks, createView, groupTasks } from '../lib/views'
import { LabelPicker } from './LabelPicker'
import { navigate } from './router'
import { setCurrentFilter } from './listActions'
import { useBulkList } from './bulk/useBulkList'
import { useListKeys } from './useListKeys'
import { useShortcutScope } from './shortcuts'
import { useToday, useViewerZone } from './useViews'
import { setPanelTaskId, usePanelTaskId } from './panel'
import { openFromRow } from './sidePanel'
import { TaskRow } from './TaskRow'
import { NO_TASKS, useLiveTasks } from '../lib/liveTasks'
import { useTrackedTotals } from '../lib/timeEntries'
import { useDateTimeFormat } from './DateTimePrefsProvider'
import { t, msg } from '../lib/i18n'
import { act } from './actionError'
import { FilterBuilder } from './filter/FilterBuilder'
import { useBuilderOpen } from './filter/builderToggle'
import { ViewsCrumb } from './views/ViewsCrumb'
import { FilterPanel, ViewToolbar } from './views/ViewToolbar'
import { useFoldedGroups, ViewResults } from './views/ViewResults'
import { SaveViewCard } from './views/SaveViewCard'
import type { ViewDisplay } from './views/DisplayPanel'
import type { Task } from '../lib/types'
import { ROW_LAYOUTS, useAccountRowLayout, type RowLayout } from '../lib/rowLayout'
import { useWorkspaceState } from '../lib/localData'
import { currentWorkspaceId } from '../lib/workspaces'
import { ACTION_TOAST_MS, showBulkToast } from './bulk/toastStore'
import { GROUP_BY_OPTIONS, isFieldSortBy, ROW_PROPERTIES, SORT_BY_OPTIONS, SORT_DIR_OPTIONS, VIEW_LAYOUTS, type GroupBy, type RowProperty, type SortBy, type SortDir, type ViewLayout } from '../lib/types'

const DEBOUNCE_MS = 150

/** A new view's display options: the saved view defaults (custom-views "Grouping and sort options"). */
export const NEW_VIEW_DISPLAY: ViewDisplay = { layout: 'list', groupBy: 'project', sortBy: 'due', sortDir: 'asc', showCompleted: false, hidden: [], cardNotes: false }

/**
 * Order by on the New view page: no Manual order, which only a saved view can keep
 * (view-manual-order D7); a draft that held it reads as the default.
 */
export const NEW_VIEW_SORT_OPTIONS: readonly SortBy[] = SORT_BY_OPTIONS.filter((s) => s !== 'position')

/** How long the draft waits after the last change before it is stored (sidebar-polish D5). */
const DRAFT_DEBOUNCE_MS = 300

/** The page's state as a stored draft. */
export function toDraft(query: string, d: ViewDisplay): FilterDraft {
  return {
    query, group_by: d.groupBy, sort_by: d.sortBy, sort_dir: d.sortDir, layout: d.layout, show_completed: d.showCompleted,
    hidden_props: [...d.hidden], ...(d.rowLayout ? { row_layout: d.rowLayout } : {}), ...(d.cardNotes ? { card_notes: true } : {}),
  }
}

/** A stored draft's display options; a value this build does not know reads as the default. */
export function displayOfDraft(d: FilterDraft): ViewDisplay {
  const pick = <T extends string>(v: string, all: readonly T[], fallback: T): T => ((all as readonly string[]).includes(v) ? v as T : fallback)
  return {
    layout: pick<ViewLayout>(d.layout, VIEW_LAYOUTS, NEW_VIEW_DISPLAY.layout),
    groupBy: pick<GroupBy>(d.group_by, GROUP_BY_OPTIONS, NEW_VIEW_DISPLAY.groupBy),
    sortBy: isFieldSortBy(d.sort_by) ? d.sort_by : pick<SortBy>(d.sort_by, NEW_VIEW_SORT_OPTIONS, NEW_VIEW_DISPLAY.sortBy),
    sortDir: pick<SortDir>(d.sort_dir, SORT_DIR_OPTIONS, NEW_VIEW_DISPLAY.sortDir),
    showCompleted: d.show_completed === true,
    cardNotes: d.card_notes === true,
    hidden: d.hidden_props.filter((p): p is RowProperty => (ROW_PROPERTIES as readonly string[]).includes(p)),
    ...(d.row_layout && (ROW_LAYOUTS as readonly string[]).includes(d.row_layout) ? { rowLayout: d.row_layout as RowLayout } : {}),
  }
}

type Parsed = { ok: true; ast: Node | null } | { ok: false; error: string }

function tryParse(src: string): Parsed {
  try {
    return { ok: true, ast: parse(src) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function FilterView({ initialQuery = '' }: { initialQuery?: string } = {}) {
  const today = useToday()
  const zone = useViewerZone()
  // `this week` follows the first-day-of-week preference (completed-date-filters D2).
  const weekStart = useDateTimeFormat().resolved.weekStart
  const [query, setQuery] = useState(initialQuery)
  const [debounced, setDebounced] = useState(initialQuery)
  // A query handed over by the command palette is remembered like a typed one.
  useEffect(() => { if (initialQuery.trim()) void addFilterHistory(initialQuery) }, [initialQuery])
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])
  const [display, setDisplay] = useState<ViewDisplay>(NEW_VIEW_DISPLAY)
  const account = useAccountRowLayout()
  const draftWs = useFilterDraft(initialQuery, query, display, (q, d) => { setQuery(q); setDebounced(q); setDisplay(d) })

  const hereProjects = useProjects()
  const hereLabels = useAllLabels()
  // undefined until the first read: Enter can arrive before the tasks are loaded.
  const loadedTasks = useLiveTasks()
  const ws = useWorkspaceFilter()

  // A syntax error keeps the last valid query (and so the previous results) on screen.
  const parsed = useMemo(() => tryParse(debounced), [debounced])
  const [good, setGood] = useState<{ src: string; ast: Node | null }>({ src: '', ast: null })
  if (parsed.ok && good.src !== debounced) setGood({ src: debounced, ast: parsed.ast })

  // A query that names a workspace looks at every workspace (group-mentions D6).
  const every = good.ast && namesWorkspace(good.ast) ? ws.everyWorkspace : undefined
  const projects = (every?.projects ?? hereProjects) as typeof hereProjects
  const labels = (every?.labels ?? hereLabels) as typeof hereLabels
  const allTasks = (every?.tasks ?? loadedTasks ?? NO_TASKS) as Task[]
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const labelMap = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const taskMap = useMemo(() => new Map(allTasks.map((tk) => [tk.id, tk])), [allTasks])
  const progress = useMemo(() => progressMap(allTasks), [allTasks])
  const blocked = useMemo(() => blockedMap(allTasks), [allTasks])
  const flow = useFlowView(allTasks, today)
  const habits = useMemo(() => habitStatsMap(allTasks, today), [allTasks, today])

  useEffect(() => { setCurrentFilter(good.ast ? good.src : null); return () => setCurrentFilter(null) }, [good])
  // Custom field definitions and tracked minutes (time-tracking: `tracked > 1h` follows a running entry live).
  const fieldDefs = useFieldDefs(), tracked = useTrackedTotals()
  const ctx = useMemo(() => ({ today, labels, projects, tasks: allTasks, sections: flow.sections, weekStart, fields: fieldDefs, tracked, workspaces: ws.workspaces, workspaceOf: ws.workspaceOf }),
    [today, labels, projects, allTasks, flow.sections, weekStart, fieldDefs, tracked, ws])
  const compiled = useMemo(() => {
    if (!good.ast) return null
    // "Completed tasks: Show" (views-and-display D4) reads the query as `(query) & (open | completed)`.
    const ast = display.showCompleted && !mentionsState(good.ast) ? withCompletedTasks(good.ast) : good.ast
    try {
      return { ok: true as const, ...compile(ast, ctx) }
    } catch (e) {
      // A custom field term its type cannot answer (custom-fields): shown like a syntax error.
      return { ok: false as const, error: (e as Error).message }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zone: a zone change re-groups zoned dues (absolute-datetimes)
  }, [good, ctx, zone, display.showCompleted])
  const result = useMemo(() => {
    if (!compiled || !compiled.ok) return null
    // Like the other cross-project views, tasks of archived projects stay out.
    const archived = new Set(projects.filter((p) => p.archived).map((p) => p.id))
    const tasks = allTasks.filter((item) => !(item.project_id && archived.has(item.project_id)) && compiled.test(item))
    return { tasks: tasks.sort(compareTasks(display.sortBy, display.sortDir, ctx)), warnings: compiled.warnings }
  }, [compiled, allTasks, projects, display.sortBy, display.sortDir, ctx])
  // After `origin:` the kinds and providers are offered (task-origin), else field names.
  const origins = useMemo(() => originSuggestions(query, allTasks), [query, allTasks])
  const suggestions = useMemo(() => (origins.length ? origins : fieldSuggestions(query, fieldDefs)), [origins, query, fieldDefs])

  const { groups, shown } = useFoldedGroups('filter', useMemo(() => (result ? groupTasks(result.tasks, display.groupBy, ctx) : []), [result, display.groupBy, ctx]))
  const rows = useMemo(() => shown.flatMap((g) => g.tasks.map((task) => ({ key: `${g.key}:${task.id}`, task }))), [shown])
  // The time column (rows-v2 D2): one fact of the whole result.
  const timeColumn = useMemo(() => hasTimeColumn(rows.map((r) => r.task)), [rows])

  const [selected, setSelected] = useState<string | null>(null)
  const openId = usePanelTaskId()
  const setOpenId = setPanelTaskId
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  // The one row (by key) whose details are shown under it (row-expand D4); a board layout has none.
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // A view can be saved from any query that parses and is not empty.
  const canSave = query.trim() !== '' && tryParse(query).ok
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ---- per-device history (local meta, never synced) ----
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const draft = useRef('')
  useEffect(() => {
    void getFilterHistory().then(setHistory)
  }, [])
  const remember = useCallback((q: string) => {
    if (q.trim()) void addFilterHistory(q).then(setHistory)
  }, [])
  // Leaving the view keeps the last valid query in the history too.
  const lastValid = useRef('')
  lastValid.current = good.src
  useEffect(() => () => remember(lastValid.current), [remember])

  // Enter: run now and move to the first result once it is rendered.
  const [focusFirst, setFocusFirst] = useState(false)
  useEffect(() => {
    // Wait for the tasks as well: with none loaded yet there are no rows to move to.
    if (!focusFirst || debounced !== query || good.src !== query || loadedTasks === undefined) return
    setFocusFirst(false)
    if (rows.length === 0) return
    setSelected(rows[0].key)
    listRef.current?.focus()
  }, [focusFirst, debounced, query, good, rows, loadedTasks])

  function onInputKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      setDebounced(query)
      if (!tryParse(query).ok) return
      remember(query)
      setHistIdx(-1)
      setFocusFirst(true)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = e.key === 'ArrowUp' ? Math.min(history.length - 1, histIdx + 1) : Math.max(-1, histIdx - 1)
      if (next === histIdx) return
      if (histIdx === -1) draft.current = query
      setHistIdx(next)
      setQuery(next === -1 ? draft.current : history[next])
    } else if (e.key === 'Escape') {
      e.stopPropagation()
    }
  }

  // The filter panel (views-and-display D5): open by default here, kept per device.
  const [filterOpen, setFilterOpen] = useBuilderOpen('filter')
  const focusQuery = () => {
    if (!filterOpen) setFilterOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  // ---- list keyboard navigation (only while focus is outside text fields) ----
  const bulkTasks = useMemo(() => rows.map((r) => r.task), [rows])
  const bulk = useBulkList(bulkTasks)
  useListKeys({
    rows, selected, setSelected, openId, setOpenId, pickerFor, setPickerFor, bulk, sidePanel: true,
    expanded, setExpanded: display.layout === 'board' ? undefined : setExpanded,
    paused: saving,
    onIdleEscape: () => {
      setSelected(null)
      focusQuery()
    },
  })
  // `s` saves the query as a view (filter.save); the Filter list has no schedule action, so the key reaches this view scope.
  useShortcutScope('view', { 'filter.save': () => { if (!canSave) return false; setSaving(true) } }, { view: 'filter' })

  useEffect(() => {
    if (!selected) return
    const i = selected.lastIndexOf(':')
    const row = document.querySelector<HTMLElement>(`[data-group="${CSS.escape(selected.slice(0, i))}"] [data-task-id="${CSS.escape(selected.slice(i + 1))}"]`)
    // Below the sticky header, and back to the very top on the first row (issue 514).
    if (row) revealRow(row, { first: isFirstRow(row) })
  }, [selected])

  const error = parsed.ok ? (compiled && !compiled.ok && good.src === debounced ? compiled.error : null) : parsed.error
  const warnings = !error && good.src === debounced ? result?.warnings ?? [] : []
  const count = result ? result.tasks.length : null

  async function save(name: string) {
    const id = await createView({
      name, query, group_by: display.groupBy, sort_by: display.sortBy, sort_dir: display.sortDir,
      layout: display.layout, show_completed: display.showCompleted, hidden_props: [...display.hidden], row_layout: display.rowLayout, card_notes: display.cardNotes,
    })
    remember(query)
    await draftWs.saved()
    setSaving(false)
    navigate({ view: 'view', id })
  }

  return (
    <PageBody width="list">
      {saving ? <SaveViewCard onSave={save} onCancel={() => setSaving(false)} /> : (
        <PageHeader title={<ViewsCrumb name={t('New view')} />} meta={count ?? undefined} help="filter"
          actions={<Button variant="secondary" size="sm" disabled={!canSave} onClick={() => setSaving(true)}>{t('Save as view')}</Button>} />
      )}
      <ViewToolbar query={query} filterOpen={filterOpen} setFilterOpen={setFilterOpen} display={{ ...display, rowLayout: display.rowLayout ?? account }} sortOptions={NEW_VIEW_SORT_OPTIONS} sortFields={fieldDefs}
        onDisplay={(patch) => setDisplay((d) => ({ ...d, ...patch }))}
        onAdd={() => document.querySelector<HTMLButtonElement>('[data-filter-panel] [data-add-condition]')?.click()} />
      {filterOpen && (
        <FilterPanel count={count} onClose={() => setFilterOpen(false)} inputRef={inputRef} onClear={() => { setHistIdx(-1); draftWs.clear(); focusQuery() }}
          builder={<FilterBuilder query={query} onChange={(q) => { setQuery(q); setHistIdx(-1) }} labels={labels} projects={projects} fields={fieldDefs} workspaces={ws.workspaces} />}
          formula={(
            <input
              ref={inputRef}
              className="ui-input border-transparent bg-transparent font-mono"
              placeholder={t('@work & due <= tomorrow & p1')}
              aria-label={t('Filter query')}
              aria-invalid={!!error}
              aria-describedby="filter-message"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHistIdx(-1)
              }}
              onKeyDown={onInputKey}
            />
          )}
          message={<QueryHints error={error} warnings={warnings} suggestions={suggestions} origins={origins.length > 0}
            onPick={(q) => { setQuery(q); inputRef.current?.focus() }} />} />
      )}
      {!filterOpen && error && <p role="alert" className="mb-2 px-1 text-meta text-danger">{error}</p>}

      {!good.ast && <UsageHint />}
      {result && rows.length === 0 && (
        <div data-empty-state="filter">
          <EmptyState title={t('No task matches this filter.')} action={{ label: t('Clear the filter'), onClick: () => { setQuery(''); focusQuery() } }} />
        </div>
      )}

      {bulk.render(rows.find((r) => r.key === selected)?.task.id ?? null)}
      <div ref={listRef} tabIndex={-1} className="outline-none" role="region" aria-label={t('Filter results')}>
        <ViewResults groups={groups} layout={display.layout} foldScope="filter" selectedGroup={selected ? selected.slice(0, selected.lastIndexOf(':')) : null} renderTask={(tk, key, shape) => (
          <TaskRow
            key={key}
            shape={shape}
            task={tk}
            project={tk.project_id ? projectMap.get(tk.project_id) : undefined}
            labels={resolveLabels(tk.labels, labelMap)}
            showProject={display.groupBy !== 'project'} timeColumn={timeColumn}
            hidden={display.hidden}
            layout={display.rowLayout} notes={shape === 'card' && !!display.cardNotes}
            onMore={(from) => { setSelected(key); bulk.openActions(null, from) }}
            selected={key === selected}
            progress={progress.get(tk.id)}
            blockedBy={blocked.get(tk.id)}
            waitsFor={flow.waitsFor(tk.id)}
            habit={habits.get(tk.id)}
            breadcrumb={tk.parent_id ? breadcrumbOf(tk, taskMap) : null}
            onToggle={() => act(setTaskCompleted(tk.id, !tk.completed_at))}
            onOpen={(e) => { setSelected(key); openFromRow(tk.id, e) }}
            expanded={expanded === key}
            onExpand={() => { setSelected(key); setExpanded((cur) => (cur === key ? null : key)) }}
            {...bulk.rowProps(tk)}
          />
        )} />
      </div>
      {pickerFor && (
        <Dialog title={t('Labels')} label={t('Labels for task')} onClose={() => setPickerFor(null)}>
          <LabelPicker taskId={pickerFor} onClose={() => setPickerFor(null)} />
          <p className="mt-2 px-1 text-hint text-faint">{t('Enter toggles or creates · Esc closes')}</p>
        </Dialog>
      )}
    </PageBody>
  )
}

/**
 * The draft of the New view page (sidebar-polish D5): restored when the page opens (a
 * `?q=` query replaces its query, and the replaced one goes into the history), stored
 * 300 ms after each change and when the page closes, per workspace. Nothing is
 * stored until the draft was read, so opening the page never overwrites it.
 */
function useFilterDraft(initialQuery: string, query: string, display: ViewDisplay, apply: (query: string, display: ViewDisplay) => void) {
  const current = useWorkspaceState().current
  const [ws, setWs] = useState<string | null>(null)
  const wsRef = useRef<string | null>(null)
  const applyRef = useRef(apply)
  applyRef.current = apply
  const latest = useRef({ query, display })
  latest.current = { query, display }
  // Saved as a view: the stored draft is gone and the page writes nothing more before it closes.
  const quiet = useRef(false)
  useEffect(() => {
    let live = true
    void currentWorkspaceId().then(async (id) => {
      // Another workspace: the one being left keeps the page as it was.
      const prev = wsRef.current
      if (prev !== null && prev !== id && !quiet.current) await saveFilterDraft(prev, toDraft(latest.current.query, latest.current.display))
      const d = await getFilterDraft(id)
      if (!live) return
      if (d) {
        const fromAddress = initialQuery.trim() !== ''
        if (fromAddress && d.query.trim() && d.query.trim() !== initialQuery.trim()) await addFilterHistory(d.query)
        if (!live) return
        applyRef.current(fromAddress ? initialQuery : d.query, displayOfDraft(d))
      } else if (prev !== null) applyRef.current(initialQuery, NEW_VIEW_DISPLAY)
      quiet.current = false
      wsRef.current = id
      setWs(id)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per workspace; the address query is fixed for the page's lifetime (Shell keys it)
  }, [current])
  useEffect(() => {
    if (ws === null || quiet.current) return
    const id = setTimeout(() => { void saveFilterDraft(ws, toDraft(query, display)) }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [ws, query, display])
  // Leaving the page stores the latest state at once.
  useEffect(() => () => {
    const id = wsRef.current
    if (id !== null && !quiet.current) void saveFilterDraft(id, toDraft(latest.current.query, latest.current.display))
  }, [])
  return {
    /**
     * "Clear" (filter-queries "New view keeps its draft"): empties the page and the stored
     * draft (an empty one is never kept), with Undo while the toast is shown.
     */
    clear: () => {
      const before = latest.current
      applyRef.current('', NEW_VIEW_DISPLAY)
      if (ws !== null) act(clearFilterDraft(ws))
      showBulkToast(t('New view cleared'), null, { ttl: ACTION_TOAST_MS, action: { label: t('Undo'), run: () => {
        if (ws !== null) act(saveFilterDraft(ws, toDraft(before.query, before.display)))
        applyRef.current(before.query, before.display)
      } } })
    },
    /** Saved as a view: as Clear, and the page keeps it that way until it closes. */
    saved: async () => {
      quiet.current = true
      if (ws !== null) await clearFilterDraft(ws)
    },
  }
}

/** The error or warning line under the query, then field or origin completions. */
function QueryHints({ error, warnings, suggestions, origins, onPick }: {
  error: string | null; warnings: string[]; suggestions: { name: string; query: string }[]; origins: boolean; onPick: (query: string) => void
}) {
  return (
    <>
      <div id="filter-message" className="px-1 text-meta empty:hidden" aria-live="polite">
        {error ? (
          <p role="alert" className="text-danger">{error}</p>
        ) : warnings.length > 0 ? (
          <p className="text-warning">{warnings.join(' · ')}</p>
        ) : null}
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-1 pt-1 text-meta" role="group" aria-label={origins ? t('Origin values') : t('Field names')}>
          <span className="text-faint">{origins ? t('Origins:') : t('Fields:')}</span>
          {suggestions.map((s) => <Button key={s.name} variant="ghost" size="sm" onClick={() => onPick(s.query)}>{s.name}</Button>)}
        </div>
      )}
    </>
  )
}

const HINT: [string[], string][] = [
  [['@errand', '#Work', '##Work'], msg('label, project, project with its sub-projects')],
  [['p1', 'p4'], msg('priority')],
  [['due <= tomorrow', 'created > 7 days ago'], '< <= = >= > before after · today, tomorrow, yesterday, monday…, 2026-12-01, 3 days, 3 days ago'],
  [['due = this week', 'completed >= last month'], msg('periods: this, last or next week or month, 2 weeks ago, 3 months ago · = means within')],
  [['overdue', 'today', 'tomorrow', 'no date', 'no time'], msg('due date keywords')],
  [['no project', 'no labels', 'subtask'], msg('Inbox, unlabelled, has a parent task')],
  [['completed', 'open', 'completed = last week'], msg('open tasks only unless one of these, or a completion date, appears')],
  [['search: "oat milk"'], msg('title or notes contain the text')],
  [['tracked', 'tracked > 1h'], msg('time tracked on the task: any, or compared with 30m, 1h30, 90')],
  [['&', '|', '!', '( )'], msg('and, or, not, grouping · quote names with spaces: @"follow up"')],
]

function UsageHint() {
  return (
    <div className="rounded-control border border-dashed border-input p-4 text-body text-muted">
      <p className="mb-2">{t('Type a query to list matching tasks. Enter jumps to the results, Esc comes back, ↑ / ↓ recall recent queries.')}</p>
      <dl className="text-meta">
        {HINT.map(([terms, d]) => (
          <div key={terms[0]} className="flex flex-col gap-1 border-t border-default py-1.5 sm:flex-row sm:gap-3">
            <dt className="flex flex-wrap gap-1 sm:w-64 sm:shrink-0">
              {terms.map((item) => <code key={item} className="ui-kbd text-muted">{item}</code>)}
            </dt>
            <dd>{t(d)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
