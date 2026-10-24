import { type FormEvent, memo, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../lib/i18n'
import { resolveLabels } from '../../lib/labels'
import { createSubtask } from '../../lib/ops'
import type { Label, Task } from '../../lib/types'
import { act } from '../actionError'
import { MAX_INDENT, TaskRow, type TaskRowProps } from '../TaskRow'

/** The list's row handlers, stable for the life of the list (large-list-performance D1). */
export interface RowActions {
  toggle: (task: Task) => void
  toggleCollapse: (id: string) => void
  /** Opens the task: inline (a click, inline-task-editing) or in the panel. */
  open: (id: string, e?: React.MouseEvent) => void
  tick: (id: string, range: boolean) => void
  drag: (e: React.PointerEvent, task: Task) => void
  /** Opens the row menu for the task, as `.` does (rows-v2: the revealed More action). */
  more: (id: string, from: HTMLElement) => void
  /** Shows or hides the task's details under its row (row-expand D4). */
  expand: (id: string) => void
}

type ListRowProps = Omit<TaskRowProps, 'labels' | 'onToggle' | 'onOpen' | 'onTick' | 'onToggleCollapse' | 'onPointerDown' | 'dropKey' | 'actions' | 'onMore' | 'onExpand'> & {
  labelMap: Map<string, Label>
  /** The row can be picked up (to a sidebar project or label, ux-feedback-2 D4). */
  draggable: boolean
  /** Other rows can be dropped on it (a manually ordered list). */
  reorderable: boolean
  /** Tree list: rows with children get the collapse chevron. */
  collapsible: boolean
  /** The row can show its details under it (row-expand): list rows, not cards or departing rows. */
  expandable: boolean
  handlers: RowActions
}

/**
 * One list row, memoized: every prop is a primitive, a stable object from the
 * list's maps, or the stable `handlers`, so moving the cursor re-renders only the
 * rows whose `selected` changed.
 */
export const ListRow = memo(function ListRow({ task, labelMap, draggable, reorderable, collapsible, expandable, handlers: actions, ...rest }: ListRowProps) {
  const labels = useMemo(() => resolveLabels(task.labels, labelMap), [task.labels, labelMap])
  return (
    <TaskRow
      {...rest}
      task={task}
      labels={labels}
      onPointerDown={draggable ? (e) => actions.drag(e, task) : undefined}
      dropKey={reorderable ? `task:${task.id}` : undefined}
      onToggle={() => actions.toggle(task)}
      onToggleCollapse={collapsible ? () => actions.toggleCollapse(task.id) : undefined}
      onOpen={(e) => actions.open(task.id, e)}
      onTick={(range) => actions.tick(task.id, range)}
      onMore={(from) => actions.more(task.id, from)}
      onExpand={expandable ? () => actions.expand(task.id) : undefined}
    />
  )
})

/** Inline "Add subtask" line under a row; stays focused for the next entry, Escape closes. */
export function SubtaskInput({ parent, depth, onClose }: { parent: Task; depth: number; onClose: () => void }) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  async function submit(e: FormEvent) {
    e.preventDefault()
    const title = value.trim()
    if (!title) return
    setValue('')
    await createSubtask(parent.id, title)
    ref.current?.focus()
  }
  return (
    <form onSubmit={(e) => act(submit(e))} className="flex items-center gap-2 py-1 pr-2" style={{ paddingLeft: `${Math.min(depth, MAX_INDENT) * 1.5 + 2}rem` }}>
      <span className="text-accent">+</span>
      <input
        ref={ref}
        className="ui-input py-1"
        placeholder={(parent.title ? t('Add a subtask to {title}…', { title: parent.title }) : t('Add a subtask to this task…'))}
        aria-label={t('Add a subtask')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
        onBlur={() => { if (!value) onClose() }}
      />
    </form>
  )
}
