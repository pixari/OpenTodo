// How the task list talks to the rest of the app (OpenSpec change
// web-component-structure): the panel, the Vim layer's list state, "open this task"
// signals, focus that follows the cursor and the rows' stable handlers. Everything
// reads the latest render through refs, so each registration happens once.
import { type RefObject, useEffect, useMemo, useRef } from 'react'
import type { ListColumn, ListRow } from '../../lib/listGroups'
import type { Task } from '../../lib/types'
import { act } from '../actionError'
import { registerListState } from '../listActions'
import { panelTaskId, registerPanelHandlers, setPanelTaskId as setOpenId, taskSplitDocks } from '../panel'
import { openTaskPage } from '../taskTrail'
import type { useSelection } from '../selection'
import { openTask, selectTask } from '../signals'
import { isTypingTarget } from '../shortcuts'
import type { RowActions } from './ListRow'
import type { ListRoute } from './useListModel'
import type { ListUi } from './useListShortcuts'

export interface BindingContext {
  route: ListRoute
  rows: ListRow[]
  columns: ListColumn[]
  board: boolean
  manual: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  openId: string | null
  isReadOnly: (task: Task | undefined) => boolean
  taskMap: Map<string, Task>
  ticked: string[]
  selection: ReturnType<typeof useSelection>
  ui: ListUi
  setSelectMode: (on: boolean) => void
  toggleComplete: (id: string, completed: boolean) => Promise<void>
  toggleCollapsed: (id: string, force?: boolean) => void
  startDrag: (e: React.PointerEvent, task: Task) => void
  quickAddRef: RefObject<HTMLInputElement | null>
  /** Vim `o` (vim-keybindings): the task the next quick-add entry is placed after, if any. */
  insertAfter: RefObject<string | null>
  listRoot: RefObject<HTMLDivElement | null>
  projectReadOnly: boolean
  /** A click on a row's title edits it in place when it applies (inline-task-editing D1); true when it did. */
  startInline?: (id: string, e?: React.MouseEvent) => boolean
  /** The row whose details are shown (row-expand D4): one per list, closed when the list changes. */
  setExpandedId: (update: (id: string | null) => string | null) => void
}

export function useListBindings(c: BindingContext): RowActions {
  const { route, selectedId, setSelectedId, openId, ui, quickAddRef, insertAfter } = c
  useEffect(() => {
    // A pending "open this task" request (reminder toast, notification click) survives the route change.
    const want = openTask.take()
    // Leaving the triage mode selects the task it was on (inbox-triage), without opening it.
    const pick = want ?? selectTask.take()
    setSelectedId(pick)
    setOpenId(want)
    ui.setAddingUnder(null)
    ui.setPrompt(null)
    ui.setPickerFor(null)
    ui.setAssignFor(null)
    ui.setAddingTo(null)
    c.selection.clear()
    c.setSelectMode(false)
    c.setExpandedId(() => null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a route change resets the list; selection is a new object on every row change
  }, [route])
  useEffect(() => openTask.subscribe((id) => {
    openTask.take(id)
    setSelectedId(id)
    setOpenId(id)
  }), [setSelectedId])

  // The prompt only makes sense while the parent is still open.
  const { prompt, setPrompt } = ui
  useEffect(() => {
    if (prompt) {
      const p = c.taskMap.get(prompt.id)
      if (!p || p.completed_at) setPrompt(null)
    }
  }, [c.taskMap, prompt, setPrompt])

  // List actions for the optional Vim layer (vim-keybindings, design D3); getters
  // read the latest render through a ref so the registration happens once.
  const live = useRef(c)
  live.current = c
  // Complete / reopen from the panel goes through this list, so the "complete parent too?" prompt and the archive offer follow.
  useEffect(() => registerPanelHandlers({ toggleComplete: (task) => act(live.current.toggleComplete(task.id, !task.completed_at)) }), [])
  // Opening another task from the panel (a subtask, the parent) selects it here when it is listed.
  useEffect(() => {
    if (openId && live.current.rows.some((r) => r.task.id === openId)) setSelectedId(openId)
  }, [openId, setSelectedId])
  useEffect(() => registerListState({
    rows: () => live.current.rows.map((r) => r.task),
    columns: () => (live.current.board ? live.current.columns.map((col) => col.cards) : null),
    selected: () => live.current.selectedId,
    select: setSelectedId,
    openId: () => live.current.openId,
    open: setOpenId,
    readOnly: (task) => live.current.isReadOnly(task),
    manual: () => live.current.manual,
    focusQuickAdd: (after) => {
      const input = quickAddRef.current
      if (!input) return false
      insertAfter.current = after
      input.focus()
      return true
    },
    toggleComplete: (id, completed) => live.current.toggleComplete(id, completed),
    openLabels: (id) => live.current.ui.setPickerFor(id),
    openAssignee: (id) => live.current.ui.setAssignFor(id),
    ticked: () => live.current.ticked,
    tick: (ids) => live.current.selection.set(ids),
    openActions: (picker) => live.current.ui.openActions(picker ?? null),
  }), [setSelectedId, quickAddRef, insertAfter])
  useEffect(() => {
    // Leaving the quick-add line ends an `o` insertion; `q` and clicks add at the end as before.
    const input = quickAddRef.current
    insertAfter.current = null
    if (!input) return
    const reset = () => (insertAfter.current = null)
    input.addEventListener('blur', reset)
    return () => input.removeEventListener('blur', reset)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the quick add is re-mounted on a route change or when it becomes read-only
  }, [route, c.projectReadOnly])

  // The cursor is real focus (assistive-tech-semantics): a new cursor row takes focus
  // on its open button, so a screen reader reads the task, unless focus is elsewhere
  // (a panel, a dialog, the quick add, the sidebar): only an unfocused page or focus
  // already on a row of this list moves with the cursor.
  const { listRoot } = c
  useEffect(() => {
    if (!selectedId) return
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedId)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    const active = document.activeElement as HTMLElement | null
    const free = !active || active === document.body
      || (!!listRoot.current?.contains(active) && !!active.closest('li[data-task-id]') && !isTypingTarget(active))
    if (el && free && !el.contains(active)) el.querySelector<HTMLElement>('[data-row-open]')?.focus({ preventScroll: true })
  }, [selectedId, listRoot])

  // Row handlers (large-list-performance D1): one object for the life of the list,
  // reading the latest state through a ref, so a memoized row re-renders only when
  // its own props change (j/k changes two rows' `selected`, nothing else).
  return useMemo<RowActions>(() => ({
    toggle: (task) => act(live.current.toggleComplete(task.id, !task.completed_at)),
    toggleCollapse: (id) => live.current.toggleCollapsed(id),
    open: (id, e) => {
      if (live.current.startInline?.(id, e)) return
      // On the Inbox's split the task is already beside the list: Enter or Space on its row opens its page (inbox-split D1).
      if (e?.detail === 0 && taskSplitDocks() && panelTaskId() === id) { openTaskPage(id); return }
      setSelectedId(id)
      setOpenId(id)
    },
    tick: (id, range) => {
      const sel = live.current.selection
      if (range) sel.extendTo(id)
      else sel.toggle(id)
      setSelectedId(id)
    },
    drag: (e, task) => live.current.startDrag(e, task),
    // The revealed More action (rows-v2 D7): the row menu for this row, as `.` opens it.
    more: (id, from) => {
      setSelectedId(id)
      live.current.ui.openActions(null, from)
    },
    // Show details / the row's disclosure (row-expand D4): one row at a time, and the cursor goes with it.
    expand: (id) => {
      setSelectedId(id)
      live.current.setExpandedId((cur) => (cur === id ? null : id))
    },
  }), [setSelectedId])
}
