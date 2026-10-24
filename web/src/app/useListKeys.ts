// Keyboard handling shared by the Filter view and saved views: the `list` scope
// handlers for j / k, Enter, c, 1–4, Shift+L, Delete, e, d, n, Shift+N, Shift+E, → / ←
// and Esc (the shortcut registry names them; the shell's dispatcher resolves the keys).
import { useEffect, useRef } from 'react'
import { deleteTask, parkTask, setTaskCompleted, unparkTask, updateTask } from '../lib/ops'
import type { Priority, Task } from '../lib/types'
import { blockedByFocus, deadlineFocus, deferFocus, estimateFocus } from './signals'
import { isActivationTarget, isTypingTarget, type ShortcutHandler, useShortcutScope } from './shortcuts'
import { registerListState } from './listActions'
import type { BulkList } from './bulk/useBulkList'
import { runBulk } from './bulk/BulkActions'
import { act } from './actionError'
import { toggleTracking } from '../lib/timeEntries'

export interface KeyRow {
  key: string
  task: Task
}

export interface ListKeys {
  rows: KeyRow[]
  selected: string | null
  setSelected: (key: string | null) => void
  openId: string | null
  setOpenId: (id: string | null) => void
  pickerFor: string | null
  setPickerFor: (id: string | null) => void
  /** Esc with nothing open and nothing to close. */
  onIdleEscape: () => void
  /** Handlers for further registry ids of the `list` scope (a saved view's `s` and `/`). */
  extra?: Partial<Record<string, ShortcutHandler>>
  /** While set (e.g. the view's own modal is open) no key is handled. */
  paused?: boolean
  /** Bulk selection (bulk-edit D2): x / Space tick, Shift+↓/↑ extend, `.`, Ctrl/⌘+A, and the action keys on the ticked set. */
  bulk?: BulkList
  /** The row (by key) whose details are shown under it (row-expand D1, D4); without a setter the list does not expand (a board layout). */
  expanded?: string | null
  setExpanded?: (key: string | null) => void
}

export function useListKeys(opts: ListKeys): void {
  const ref = useRef(opts)
  ref.current = opts
  // The Filter view and saved views expose their list to the command palette too
  // (search-and-command-palette D5), as TaskListView does.
  useEffect(() => registerListState({
    rows: () => ref.current.rows.map((r) => r.task),
    columns: () => null,
    selected: () => ref.current.rows.find((r) => r.key === ref.current.selected)?.task.id ?? null,
    select: (id) => ref.current.setSelected(id === null ? null : ref.current.rows.find((r) => r.task.id === id)?.key ?? null),
    openId: () => ref.current.openId,
    open: (id) => ref.current.setOpenId(id),
    readOnly: () => false,
    ticked: () => ref.current.bulk?.ticked ?? [],
    tick: (ids) => ref.current.bulk?.selection.set(ids),
    openActions: (picker) => ref.current.bulk?.openActions(picker ?? null),
    manual: () => false,
    focusQuickAdd: () => false,
    toggleComplete: (id, completed) => setTaskCompleted(id, completed),
    openLabels: (id) => ref.current.setPickerFor(id),
  }), [])
  // The `list` scope (keyboard-shortcuts): the dispatcher resolves the key, these
  // handlers act on the selection; a handler returns false when it does not apply.
  const o = opts
  const b = o.bulk
  const idx = o.rows.findIndex((r) => r.key === o.selected)
  const row = idx >= 0 ? o.rows[idx].task : undefined
  const openWith = (focus: { request(id: string): void }) => () => {
    if (!row) return false
    focus.request(row.id)
    o.setOpenId(row.id)
  }
  const extend = (dir: 1 | -1) => () => {
    if (!b) return false
    const at = row ? b.order.indexOf(row.id) : -1
    const next = b.order[Math.max(0, Math.min(b.order.length - 1, at + dir))]
    if (!next) return false
    if (b.ticked.length === 0 && row) b.selection.toggle(row.id)
    b.selection.extendTo(next)
    o.setSelected(o.rows.find((r) => r.task.id === next)?.key ?? null)
  }
  useShortcutScope('list', {
    'list.select-all': () => { if (!b || b.ticked.length === 0) return false; b.selection.selectAll() },
    'list.escape': (e) => {
      const target = e.target as HTMLElement | null
      if (isTypingTarget(target)) return false
      if (b && b.ticked.length && !o.pickerFor && !o.openId) b.selection.clear()
      else if (o.pickerFor) o.setPickerFor(null)
      else if (o.openId) o.setOpenId(null)
      // The details of an expanded row close before the selection clears (row-expand D1).
      else if (o.expanded && o.setExpanded) o.setExpanded(null)
      else o.onIdleEscape()
    },
    'list.tick': () => { if (!b || !row) return false; b.selection.toggle(row.id) },
    'list.extend-down': extend(1), 'list.extend-up': extend(-1),
    'list.actions': () => { if (!b || !(b.ticked.length || row)) return false; b.openActions() },
    'list.down': () => o.setSelected(o.rows[Math.min(o.rows.length - 1, idx + 1)]?.key ?? null),
    'list.up': () => o.setSelected(o.rows[Math.max(0, idx - 1)]?.key ?? null),
    // → shows the selected row's details, ← hides them (row-expand D1); these rows have no subtask tree.
    'list.expand': () => { if (!row || !o.setExpanded) return false; o.setExpanded(o.selected) },
    'list.collapse': () => { if (!row || !o.setExpanded || o.expanded !== o.selected) return false; o.setExpanded(null) },
    'list.open': (e) => { if (!row || isActivationTarget(e.target)) return false; o.setOpenId(row.id) },
    'list.complete': () => {
      if (b?.ticked.length) { void runBulk(b.ticked, { kind: 'complete' }); return }
      if (!row) return false
      act(setTaskCompleted(row.id, !row.completed_at))
    },
    'list.priority': (e) => {
      const priority = Number(e.key) as Priority
      if (b?.ticked.length) { void runBulk(b.ticked, { kind: 'priority', priority }); return }
      if (!row) return false
      act(updateTask(row.id, { priority }))
    },
    'list.labels': () => {
      if (b?.ticked.length) { b.openActions('labels'); return }
      if (!row) return false
      o.setPickerFor(row.id)
    },
    'list.delete': () => {
      if (b?.ticked.length) { void runBulk(b.ticked, { kind: 'trash' }); return }
      if (!row) return false
      act(deleteTask(row.id))
      o.setSelected(o.rows[idx + 1]?.key ?? o.rows[idx - 1]?.key ?? null)
    },
    'list.estimate': openWith(estimateFocus),
    // Start or stop tracking (time-tracking D5); a completed task offers no start.
    'list.track': () => { if (!row) return false; act(toggleTracking(row.id, { canStart: !row.completed_at })) },
    'list.deadline': openWith(deadlineFocus),
    'list.defer': openWith(deferFocus),
    'list.blocked-by': openWith(blockedByFocus),
    // Park or un-park (someday-and-evening D5).
    'list.park': () => { if (!row) return false; void (row.start === 'someday' ? unparkTask(row.id) : parkTask(row.id)) },
    'list.evening': () => { if (!row) return false; act(updateTask(row.id, { evening: !row.evening })) },
    ...o.extra,
  }, { paused: o.paused })
}
