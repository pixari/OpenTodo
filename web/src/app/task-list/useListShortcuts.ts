// Keyboard of the task list (keyboard-shortcuts "One shortcut registry with scopes"):
// the `list` scope, the `board` scope on a board and the project's `view` scope.
// The dispatcher resolves the key, these handlers act on the selection. A handler
// returns false when it does not apply, so the key keeps its default. A viewer may
// navigate and open tasks of a shared project, never change them: every handler
// that writes checks `writable` (or the task's own read-only state) first.
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { detachOccurrence, setTaskParent, skipOccurrence, unparkTask, updateTask } from '../../lib/ops'
import type { ListColumn, ListRow } from '../../lib/listGroups'
import { moveTaskBy, type Step } from '../../lib/move'
import { duplicateTask } from '../../lib/templates'
import { toggleTracking } from '../../lib/timeEntries'
import type { Priority, Task } from '../../lib/types'
import type { Tree } from '../../lib/tree'
import { act } from '../actionError'
import { runBulk } from '../bulk/BulkActions'
import { setPanelTaskId as setOpenId, taskSplitDocks } from '../panel'
import { navigate } from '../router'
import { openTaskPage } from '../taskTrail'
import type { useSelection } from '../selection'
import { blockedByFocus, deadlineFocus, deferFocus, estimateFocus, placeInDay } from '../signals'
import { isActivationTarget, isTypingTarget, useShortcutScope } from '../shortcuts'
import { deleteWithUndo, parkWithUndo } from '../undoable'
import type { ListRoute } from './useListModel'

/** The list's transient UI state the keys open and close. */
export interface ListUi {
  pickerFor: string | null
  setPickerFor: Dispatch<SetStateAction<string | null>>
  assignFor: string | null
  setAssignFor: Dispatch<SetStateAction<string | null>>
  prompt: Task | null
  setPrompt: Dispatch<SetStateAction<Task | null>>
  addingUnder: string | null
  setAddingUnder: Dispatch<SetStateAction<string | null>>
  setAddingTo: Dispatch<SetStateAction<string | null>>
  /** `from`: the row's More button, where the menu then opens. */
  openActions: (picker?: string | null, from?: HTMLElement | null) => void
}

export interface ShortcutContext {
  route: ListRoute
  projectId: string | null
  rows: ListRow[]
  tree: Tree<Task> | null
  board: boolean
  columns: ListColumn[]
  /** Ids of every row, in order (the tick order). */
  tickRows: string[]
  ticked: string[]
  selection: ReturnType<typeof useSelection>
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  openId: string | null
  manual: boolean
  treeView: boolean
  projectReadOnly: boolean
  projectEditable: boolean
  isReadOnly: (task: Task | undefined) => boolean
  taskMap: Map<string, Task>
  today: string
  userId?: string
  ui: ListUi
  quickAddRef: RefObject<HTMLInputElement | null>
  toggleCollapsed: (id: string, force?: boolean) => void
  toggleComplete: (id: string, completed: boolean) => Promise<void>
  acceptPrompt: () => void
  moveToSection: (task: Task, key: string) => void
  toggleViewMode: () => void
  /** F2: edit the selected task's title in place (inline-task-editing). */
  editInline?: (id: string) => void
  /** The row whose details are shown under it, and its setter (row-expand D1, D4). */
  expandedId: string | null
  setExpandedId: (id: string | null) => void
}

/** Selecting tasks moves keyboard attention to the list: a sidebar project left
 * focused by a click must not take the next Alt+Up/Down (manual-ordering). A data
 * attribute, not the translated group name, so it holds in every language. */
function leaveSidebar() {
  if ((document.activeElement as HTMLElement | null)?.closest?.('[data-project-row]')) (document.activeElement as HTMLElement).blur()
}

/** The key was pressed on a row's revealed actions (rows-v2 D7): Tab keeps its browser meaning there. */
function inRowActions(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.('[data-row-actions]')
}

export function useListShortcuts(c: ShortcutContext) {
  const { rows, selectedId, setSelectedId, selection, ticked, ui, openId, isReadOnly } = c
  const idx = rows.findIndex((r) => r.task.id === selectedId)
  const row = idx >= 0 ? rows[idx] : undefined
  // A viewer may navigate and open tasks of a shared project, never change them.
  const writable = !!row && !isReadOnly(row.task)

  const indent = (r: ListRow, at: number) => {
    // The previous visible sibling: scan upwards at the same depth, stopping at an ancestor.
    for (let i = at - 1; i >= 0; i--) {
      const prev = rows[i]
      if (prev.depth < r.depth) return
      if (prev.depth === r.depth && prev.parent === r.parent) {
        c.toggleCollapsed(prev.task.id, false)
        act(setTaskParent(r.task.id, prev.task.id))
        return
      }
    }
  }
  const outdent = (r: ListRow) => {
    if (!c.tree || r.parent === null) return
    const grandparent = c.tree.nodes.get(r.parent)?.parent ?? null
    act(setTaskParent(r.task.id, grandparent))
  }
  const openFor = (focus: { request(id: string): void }) => () => {
    if (!row || !writable) return false
    focus.request(row.task.id)
    setOpenId(row.task.id)
  }
  const extend = (dir: 1 | -1) => () => {
    const order = c.board ? (c.columns.find((col) => col.cards.some((task) => task.id === selectedId))?.cards.map((task) => task.id) ?? c.tickRows) : c.tickRows
    const at = selectedId ? order.indexOf(selectedId) : -1
    const next = order[Math.max(0, Math.min(order.length - 1, at + dir))]
    if (!next) return false
    if (selection.ticked.size === 0 && selectedId) selection.toggle(selectedId)
    selection.extendTo(next, order)
    setSelectedId(next)
  }
  const moveBy = (how: Step) => () => {
    // Keyboard moves (manual-ordering): only in manually ordered views; the selection stays on the moved task; edges do nothing.
    if (!c.manual || !selectedId) return false
    act(moveTaskBy(selectedId, how))
  }
  /** The selected (or open) task, for occurrence keys; false when it is missing or read-only. */
  const occurrence = () => {
    const id = row?.task.id ?? openId
    return !id || isReadOnly(row?.task ?? c.taskMap.get(id)) ? null : id
  }
  useShortcutScope('view', {
    'project.view-mode': () => { if (!c.projectId) return false; c.toggleViewMode() },
    // P processes the Inbox one task at a time (inbox-split D3), as its primary action does.
    'inbox.process': () => { if (c.route.view !== 'inbox' || rows.length === 0) return false; navigate({ view: 'triage' }) },
  }, { view: c.route.view })
  useShortcutScope('list', {
    'list.escape': (e) => {
      const target = e.target as HTMLElement | null
      if (isTypingTarget(target)) target!.blur()
      else if (ui.pickerFor) ui.setPickerFor(null)
      else if (ui.assignFor) ui.setAssignFor(null)
      else if (ui.prompt) ui.setPrompt(null)
      else if (ui.addingUnder) ui.setAddingUnder(null)
      else if (openId && !taskSplitDocks()) setOpenId(null)
      // The details of an expanded row close before the selection clears (row-expand D1).
      else if (c.expandedId) c.setExpandedId(null)
      else if (selection.ticked.size) selection.clear()
      // On the Inbox's split the pane follows the cursor: Escape clears both (inbox-split D1).
      else if (openId) { setOpenId(null); setSelectedId(null) }
      else setSelectedId(null)
    },
    'list.move-up': moveBy(-1), 'list.move-down': moveBy(1), 'list.move-top': moveBy('top'), 'list.move-bottom': moveBy('bottom'),
    // Ctrl/⌘+A selects every row once something is ticked (bulk-edit D2); before that it keeps selecting the page's text.
    'list.select-all': () => { if (selection.ticked.size === 0) return false; selection.selectAll() },
    'list.tick': () => { if (!row) return false; selection.toggle(row.task.id) },
    'list.extend-down': extend(1), 'list.extend-up': extend(-1),
    'list.actions': () => { if (!ticked.length && !selectedId) return false; ui.openActions() },
    'list.down': () => { leaveSidebar(); setSelectedId(rows[Math.min(rows.length - 1, idx + 1)]?.task.id ?? null) },
    'list.up': () => { leaveSidebar(); setSelectedId(rows[Math.max(0, idx - 1)]?.task.id ?? null) },
    // ← shows less, → shows more (row-expand D1): the details close first and open last, around the subtasks.
    'list.collapse': () => {
      if (!row) return false
      if (c.expandedId === row.task.id) c.setExpandedId(null)
      else if (!c.treeView) return false
      else if (row.hasChildren && !row.collapsed) c.toggleCollapsed(row.task.id, true)
      else if (row.parent) setSelectedId(row.parent)
    },
    'list.expand': () => {
      if (!row) return false
      if (c.treeView && row.hasChildren && row.collapsed) c.toggleCollapsed(row.task.id, false)
      else if (!c.board) c.setExpandedId(row.task.id)
      else return false
    },
    'list.open': (e) => {
      if (ui.prompt) { c.acceptPrompt(); return }
      // Enter on a focused button or link is that control's own (the panel's tabs, a version's expander).
      if (!selectedId || isActivationTarget(e.target)) return false
      // On the Inbox's split the task is already beside the list: Enter opens its page (inbox-split D1).
      if (taskSplitDocks()) openTaskPage(selectedId)
      else setOpenId(selectedId)
    },
    'list.add-subtask': () => {
      if (!row || !writable) return false
      c.toggleCollapsed(row.task.id, false)
      ui.setAddingUnder(row.task.id)
    },
    // Tab inside a row's revealed actions moves between them (rows-v2 D7), never indents.
    'list.indent': (e) => { if (!row || !writable || !c.treeView || inRowActions(e)) return false; indent(row, idx) },
    'list.outdent': (e) => { if (!row || !writable || !c.treeView || inRowActions(e)) return false; outdent(row) },
    'list.complete': () => {
      if (ticked.length) { act(runBulk(ticked, { kind: 'complete' })); return }
      if (!row || !writable) return false
      const completing = !row.task.completed_at
      // The cursor moves on at once (motion-v2 D2): the next completion never waits for the row
      // to leave. A repeating task stays in the list with its next date, and so does the cursor.
      if (completing && !row.task.recurrence) setSelectedId((rows[idx + 1] ?? rows[idx - 1])?.task.id ?? null)
      act(c.toggleComplete(row.task.id, completing))
    },
    'list.priority': (e) => {
      const priority = Number(e.key) as Priority
      if (ticked.length) { act(runBulk(ticked, { kind: 'priority', priority })); return }
      if (!selectedId || (row && !writable)) return false
      act(updateTask(selectedId, { priority }))
    },
    'list.labels': () => {
      if (ticked.length) { ui.openActions('labels'); return }
      if (!row || !writable) return false
      ui.setPickerFor(row.task.id)
    },
    'list.assign': () => {
      if (ticked.length) { ui.openActions('assign'); return }
      if (!row || !writable || !c.userId) return false
      ui.setAssignFor(row.task.id)
    },
    'list.delete': () => {
      if (ticked.length) { act(runBulk(ticked, { kind: 'trash' })); return }
      if (!selectedId || (row && !writable)) return false
      act(deleteWithUndo(selectedId))
      setSelectedId(rows[idx + 1]?.task.id ?? rows[idx - 1]?.task.id ?? null)
    },
    'list.skip': () => {
      // Skip the current occurrence of the selected (or open) recurring task.
      const id = occurrence()
      if (!id) return false
      act(skipOccurrence(id))
    },
    'list.detach': () => {
      // "This occurrence only": detach a standalone copy and open it.
      const id = occurrence()
      if (!id) return false
      act(detachOccurrence(id).then((copy) => {
        if (copy) {
          setSelectedId(copy)
          setOpenId(copy)
        }
      }))
    },
    // Placement mode in the Day view (OpenSpec `time-blocking`).
    'list.schedule': () => { if (!row || !writable || row.task.completed_at) return false; placeInDay(row.task, c.today) },
    'list.estimate': () => { if (!row || !writable) return false; estimateFocus.request(row.task.id); setOpenId(row.task.id) },
    'list.edit-inline': () => { if (!row || !writable || c.board || !c.editInline) return false; c.editInline(row.task.id) },
    // Start or stop tracking (time-tracking D5); a completed task offers no start.
    'list.track': () => { if (!row || !writable) return false; act(toggleTracking(row.task.id, { canStart: !row.task.completed_at })) },
    'list.deadline': openFor(deadlineFocus),
    'list.defer': openFor(deferFocus),
    'list.blocked-by': openFor(blockedByFocus),
    // Park or un-park (someday-and-evening D5).
    'list.park': () => { if (!row || !writable) return false; act(row.task.start === 'someday' ? unparkTask(row.task.id) : parkWithUndo(row.task.id)) },
    'list.evening': () => { if (!row || !writable) return false; act(updateTask(row.task.id, { evening: !row.task.evening })) },
    // Duplicate the task and its open subtasks right below it (project-templates D6).
    'list.duplicate': () => { if (!row || !writable) return false; act(duplicateTask(row.task.id).then((id) => setSelectedId(id))) },
  })
  useBoardShortcuts(c, row)
}

/** The `board` scope: columns and cards; cards are not nested. */
function useBoardShortcuts(c: ShortcutContext, row: ListRow | undefined) {
  const { columns, selectedId, setSelectedId } = c
  const col = c.board ? columns.findIndex((x) => x.cards.some((task) => task.id === selectedId)) : -1
  const pos = col >= 0 ? columns[col].cards.findIndex((task) => task.id === selectedId) : -1
  const firstCard = (from: number, dir: 1 | -1) => {
    for (let i = from; i >= 0 && i < columns.length; i += dir) if (columns[i].cards.length) return columns[i].cards[0].id
    return null
  }
  const boardStep = (dir: 1 | -1) => () => {
    if (col < 0) setSelectedId(firstCard(0, 1))
    else setSelectedId(columns[col].cards[Math.max(0, Math.min(columns[col].cards.length - 1, pos + dir))].id)
  }
  const boardColumn = (dir: 1 | -1) => () => {
    if (col < 0) setSelectedId(firstCard(0, 1))
    else setSelectedId(firstCard(col + dir, dir) ?? selectedId)
  }
  const boardMove = (dir: 1 | -1) => () => {
    // Shift+←/→ moves the selected card to the adjacent column; it stays selected.
    const target = columns[col + dir]
    if (row && col >= 0 && target && c.projectEditable) c.moveToSection(row.task, target.key)
  }
  useShortcutScope('board', {
    'board.down': boardStep(1), 'board.up': boardStep(-1),
    'board.column-prev': boardColumn(-1), 'board.column-next': boardColumn(1),
    'board.move-prev': boardMove(-1), 'board.move-next': boardMove(1),
    // On the board, `a` opens the quick add of the selected card's column.
    'board.add': () => { if (!c.projectEditable) return false; c.ui.setAddingTo(col >= 0 ? columns[col].key : columns[0]?.key ?? '') },
    // Cards are not nested: Tab keeps moving focus and never reaches the list's indent.
    'board.indent': () => undefined,
  }, { enabled: c.board })
}
