// A saved list view (OpenSpec changes `custom-views` and `views-and-display`): "Views ›
// name" in the header, the query's conditions as chips in the toolbar with the filter
// panel (builder and formula) under it, the display panel for layout, grouping, order,
// completed tasks and row properties, and live results from the view runner. A
// dashboard is rendered by DashboardView instead.
import { isFirstRow, revealRow } from './task-list/revealRow'
import { blockedMap } from '../lib/dependencies'
import { useFlowView } from '../lib/useFlow'
import { Button, EmptyState, IconButton, PageBody, PageHeader, Dialog } from '../ui'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { parse } from '../lib/filter'
import { resolveLabels } from '../lib/labels'
import { hasTimeColumn } from '../lib/rowTime'
import { setTaskCompleted } from '../lib/ops'
import { breadcrumbOf, progressMap } from '../lib/subtasks'
import type { View } from '../lib/types'
import { displayOptions, runView, updateView, viewOptions, type ViewPatch } from '../lib/views'
import { setFavourite } from '../lib/favourites'
import { DashboardView } from './DashboardView'
import { LabelPicker } from './LabelPicker'
import { setPanelTaskId, usePanelTaskId } from './panel'
import { openFromRow } from './sidePanel'
import { TaskRow } from './TaskRow'
import { ViewMark, ViewMenu } from './ViewsView'
import { useListKeys, type KeyRow } from './useListKeys'
import type { ViewStep } from '../lib/viewOrder'
import type { OrderHost } from '../lib/viewOrderMove'
import { stepInView } from './viewOrderActions'
import { groupOfKey, useViewOrderDrag, viewRowTarget } from './views/useViewOrderDrag'
import { useBulkList } from './bulk/useBulkList'
import { placeInDay } from './signals'
import { logicalToday } from '../lib/dates'
import { habitStatsMap } from '../lib/habits'
import { useViewData, type ViewData } from './useViews'
import { t } from '../lib/i18n'
import { keysOf } from '../lib/shortcuts'
import { act } from './actionError'
import { FilterBuilder } from './filter/FilterBuilder'
import { useBuilderOpen } from './filter/builderToggle'
import { ViewsCrumb } from './views/ViewsCrumb'
import { FilterPanel, ViewToolbar } from './views/ViewToolbar'
import { BOARD_COLOR_BY_KEY } from '../lib/colorBy'
import { useColorBy } from './calendar/colorByControls'
import { useFoldedGroups, ViewResults } from './views/ViewResults'
import type { ViewDisplay } from './views/DisplayPanel'
import { rowLayoutOf, useAccountRowLayout } from '../lib/rowLayout'

function parseError(src: string): string | null {
  if (!src.trim()) return t('The query must not be empty')
  try {
    parse(src)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** The view's fields a display change writes: one op per changed field (custom-views "Saved view entity"). */
export function displayPatch(patch: Partial<ViewDisplay>): ViewPatch {
  const out: ViewPatch = {}
  if (patch.layout !== undefined) out.layout = patch.layout
  if (patch.groupBy !== undefined) out.group_by = patch.groupBy
  if (patch.sortBy !== undefined) out.sort_by = patch.sortBy
  if (patch.sortDir !== undefined) out.sort_dir = patch.sortDir
  if (patch.showCompleted !== undefined) out.show_completed = patch.showCompleted
  if (patch.hidden !== undefined) out.hidden_props = [...patch.hidden]
  if (patch.rowLayout !== undefined) out.row_layout = patch.rowLayout
  if (patch.cardNotes !== undefined) out.card_notes = patch.cardNotes
  return out
}

export function SavedViewRoute({ id }: { id: string }) {
  const data = useViewData()
  const view = data.views.find((v) => v.id === id)
  if (!view) {
    return <p className="px-4 py-10 text-center text-body text-faint">{t('This view does not exist (it may have been deleted on another device).')}</p>
  }
  return view.kind === 'dashboard' ? <DashboardView key={id} dashboard={view} data={data} /> : <SavedViewView key={id} view={view} data={data} />
}

export function SavedViewView({ view, data }: { view: View; data: ViewData }) {
  const { projects, labels, tasks, ctx } = data
  const opts = viewOptions(view)
  const shown = displayOptions(view)
  const account = useAccountRowLayout()
  // Colour by on boards (calendar-clarity): the device's one choice for every board.
  const boardColor = useColorBy(BOARD_COLOR_BY_KEY)
  const display: ViewDisplay = { layout: shown.layout, groupBy: opts.groupBy, sortBy: opts.sortBy, sortDir: opts.sortDir, showCompleted: shown.showCompleted, hidden: shown.hidden, rowLayout: rowLayoutOf(view.row_layout, account), cardNotes: shown.cardNotes }
  const result = useMemo(() => runView(view, ctx), [view, ctx])
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const labelMap = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const taskMap = useMemo(() => new Map(tasks.map((tk) => [tk.id, tk])), [tasks])
  const progress = useMemo(() => progressMap(tasks), [tasks])
  const blocked = useMemo(() => blockedMap(tasks), [tasks])
  const flow = useFlowView(tasks, ctx.today)
  const habits = useMemo(() => habitStatsMap(tasks, ctx.today), [tasks, ctx.today])

  // ---- query editing: the input holds a draft; Enter (or Save) confirms it ----
  const [draft, setDraft] = useState(view.query)
  const [draftError, setDraftError] = useState<string | null>(null)
  const lastSaved = useRef(view.query)
  // A remote edit of the query replaces the draft unless the user is mid-edit.
  useEffect(() => {
    if (draft === lastSaved.current) setDraft(view.query)
    lastSaved.current = view.query
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a remote query change triggers this; the draft is read, not a trigger
  }, [view.query])
  const dirty = draft.trim() !== view.query
  // The filter panel (views-and-display D5): closed by default on a saved view, kept per device.
  const [filterOpen, setFilterOpen] = useBuilderOpen('view')
  // The panel's count follows the draft (filter-builder D6); the list keeps the saved query.
  const draftCount = useMemo(() => {
    if (!filterOpen) return null
    if (!dirty) return result.ok ? result.tasks.length : null
    const r = runView({ ...view, query: draft }, ctx)
    return r.ok ? r.tasks.length : null
  }, [filterOpen, dirty, draft, view, ctx, result])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusQuery = () => {
    if (!filterOpen) setFilterOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  async function saveQuery() {
    const err = parseError(draft)
    setDraftError(err)
    if (err) return
    await updateView(view.id, { query: draft })
    listRef.current?.focus()
  }
  function onInputKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (dirty) void saveQuery()
      else listRef.current?.focus()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setDraft(view.query)
      setDraftError(null)
    }
  }

  // ---- results and keyboard navigation (a task can appear under several labels) ----
  const resultGroups = useMemo(() => (result.ok ? result.groups : []), [result])
  // Groups collapsed or folded on this device (board-polish D1) keep their tasks off screen and out of the keyboard's rows.
  const { groups, shown: shownGroups } = useFoldedGroups(`view:${view.id}`, resultGroups)
  const rows = useMemo(() => shownGroups.flatMap((g) => g.tasks.map((item) => ({ key: `${g.key}:${item.id}`, task: item }))), [shownGroups])
  // The time column (rows-v2 D2): one fact of the whole view.
  const timeColumn = useMemo(() => hasTimeColumn(rows.map((r) => r.task)), [rows])
  const [selected, setSelected] = useState<string | null>(null)
  const openId = usePanelTaskId()
  const setOpenId = setPanelTaskId
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  // The one row (by key) whose details are shown under it (row-expand D4); a board layout has none.
  const [expanded, setExpanded] = useState<string | null>(null)
  const bulkTasks = useMemo(() => rows.map((r) => r.task), [rows])
  const bulk = useBulkList(bulkTasks)
  // The view's own manual order (view-manual-order): drag within a group and Alt+arrows, with Undo.
  const host = useMemo<OrderHost>(() => ({ entity: 'view', id: view.id }), [view.id])
  const moveBy = (r: KeyRow, step: ViewStep) => {
    const group = groups.find((g) => g.key === groupOfKey(r.key))
    return stepInView(host, bulkTasks, group?.tasks ?? [], r.task.id, step)
  }
  const drag = useViewOrderDrag(host, rows, { ticked: bulk.ticked, openRowMenu: (tk, x, y, el) => bulk.rowProps(tk).onRowMenu(x, y, el), onDropped: setSelected })

  useListKeys({
    rows, selected, setSelected, openId, setOpenId, pickerFor, setPickerFor, bulk, sidePanel: true,
    expanded, setExpanded: display.layout === 'board' ? undefined : setExpanded,
    onIdleEscape: () => setSelected(null), moveBy,
    extra: {
      'list.schedule': () => {
        const row = rows.find((r) => r.key === selected)?.task
        if (!row || row.completed_at) return false
        placeInDay(row, logicalToday())
      },
      'view.edit-query': () => focusQuery(),
    },
  })

  useEffect(() => {
    if (!selected) return
    const i = selected.lastIndexOf(':')
    const row = document.querySelector<HTMLElement>(`[data-group="${CSS.escape(selected.slice(0, i))}"] [data-task-id="${CSS.escape(selected.slice(i + 1))}"]`)
    // Below the sticky header, and back to the very top on the first row (issue 514).
    if (row) revealRow(row, { first: isFirstRow(row) })
  }, [selected])

  const message = draftError ?? (!dirty && !result.ok ? result.error : null)
  const count = result.ok ? result.tasks.length : null

  return (
    <PageBody width="list">
          <PageHeader title={<ViewsCrumb name={view.name} />} meta={count !== null ? count : undefined} help="saved-filter"
            leading={view.icon ? <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted" aria-hidden="true"><ViewMark view={view} /></span> : undefined}
            actions={<IconButton icon={view.pinned ? 'pin-off' : 'pin'} size="sm" label={view.pinned ? t('Unpin') : t('Pin')} onClick={() => act(setFavourite('view', view.id, !view.pinned))} />}
            menu={<ViewMenu view={view} />} />

          <ViewToolbar sortFields={ctx.fields} query={view.query} filterOpen={filterOpen} setFilterOpen={setFilterOpen} display={display}
            onDisplay={(patch) => act(updateView(view.id, displayPatch(patch)))}
            colorBy={display.layout === 'board' ? { mode: boardColor.mode, onChange: boardColor.setMode } : undefined}
            onAdd={() => document.querySelector<HTMLButtonElement>('[data-filter-panel] [data-add-condition]')?.click()} />
          {filterOpen && (
            <FilterPanel count={draftCount} onClose={() => setFilterOpen(false)} inputRef={inputRef}
              builder={<FilterBuilder query={draft} onChange={(q) => { setDraft(q); setDraftError(null) }} labels={labels} projects={projects} fields={ctx.fields ?? []} workspaces={ctx.workspaces} />}
              formula={(
                <div className="flex items-center gap-2">
                  <input ref={inputRef} className="ui-input border-transparent bg-transparent font-mono" aria-label={t('View query')} aria-invalid={!!message} aria-describedby="view-message"
                    autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    value={draft} onChange={(e) => { setDraft(e.target.value); setDraftError(null) }} onKeyDown={onInputKey} />
                  {dirty && <Button variant="primary" size="sm" className="shrink-0" onClick={() => void saveQuery()}>{t('Save')}</Button>}
                </div>
              )}
              message={(
                <div id="view-message" className="min-h-5 px-1 pt-1 text-meta" aria-live="polite">
                  {message ? (
                    <p role="alert" className="text-danger">{message}</p>
                  ) : dirty ? (
                    <p className="text-faint">{t('Enter saves the query for every device · Esc discards the change')}</p>
                  ) : result.ok && result.warnings.length > 0 ? (
                    <p className="text-warning">{result.warnings.join(' · ')}</p>
                  ) : null}
                </div>
              )} />
          )}
          {!filterOpen && message && <p role="alert" className="mb-2 px-1 text-meta text-danger">{message}</p>}

          {result.ok && rows.length === 0 && (
            <div data-empty-state="saved-view">
              <EmptyState title={t('No task matches this view.')} action={{ label: t('Edit the view'), onClick: focusQuery, shortcut: keysOf('view.edit-query') }} />
            </div>
          )}

          {bulk.render(rows.find((r) => r.key === selected)?.task.id ?? null)}
          <div ref={listRef} tabIndex={-1} className="outline-none" role="region" aria-label={t('View results')}>
            <ViewResults groups={groups} layout={display.layout} foldScope={`view:${view.id}`} selectedGroup={selected ? groupOfKey(selected) : null} renderTask={(tk, key, shape) => (
              <TaskRow
                key={key}
                shape={shape}
                task={tk}
                project={tk.project_id ? projectMap.get(tk.project_id) : undefined}
                labels={resolveLabels(tk.labels, labelMap)}
                showProject={opts.groupBy !== 'project'}
                timeColumn={timeColumn}
                hidden={display.hidden}
                layout={display.rowLayout}
                edge={shape === 'card' && boardColor.mode !== 'project' ? boardColor.hueOf(tk) : undefined}
                notes={shape === 'card' && display.cardNotes}
                onMore={(from) => { setSelected(key); bulk.openActions(null, from) }}
                selected={key === selected}
                progress={progress.get(tk.id)}
                blockedBy={blocked.get(tk.id)}
                waitsFor={flow.waitsFor(tk.id)}
                habit={habits.get(tk.id)}
                breadcrumb={tk.parent_id ? breadcrumbOf(tk, taskMap) : null}
                onToggle={() => act(setTaskCompleted(tk.id, !tk.completed_at))}
                onOpen={(e) => { setSelected(key); openFromRow(tk.id, e) }}
                onExpand={() => { setSelected(key); setExpanded((cur) => (cur === key ? null : key)) }}
                {...bulk.rowProps(tk)}
                onPointerDown={(e) => drag.startDrag(e, key, tk)}
                dropKey={viewRowTarget(key)}
                dropIndicator={drag.dropAt?.key === key ? drag.dropAt.zone : null}
                dragging={drag.draggingKey === key}
                expanded={!drag.draggingKey && expanded === key}
              />
            )} />
          </div>
      {pickerFor && (
        <Dialog title={t('Labels')} label={t('Labels for task')} onClose={() => setPickerFor(null)}>
          <LabelPicker taskId={pickerFor} onClose={() => setPickerFor(null)} />
        </Dialog>
      )}
    </PageBody>
  )
}
