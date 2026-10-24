// The task's subtasks as a checklist with a quiet add line (ux-overhaul, "Task panel
// layout"). On the task page the list is one bordered block with its count and a
// progress bar in the head (task-full-page D1); in the docked panel it stays bare.
import { type FormEvent, useRef, useState } from 'react'
import { createSubtask } from '../../lib/ops'
import type { Task } from '../../lib/types'
import { t } from '../../lib/i18n'
import { Icon } from '../../ui'

export interface SubtasksProps {
  task: Task
  items: Task[]
  progress: { done: number; total: number }
  readOnly: boolean
  /** The page's bordered block (head, rows, add line) instead of the panel's bare list. */
  boxed?: boolean
  /** The add line under the list (off in an expanded row, row-expand D3). */
  add?: boolean
  onToggle: (task: Task) => void
  onOpen?: (id: string) => void
}

export function Subtasks({ task, items, progress, readOnly, boxed = false, add = true, onToggle, onOpen }: SubtasksProps) {
  const row = boxed ? 'flex min-h-9 items-center gap-2 border-t border-soft px-3 hover:bg-hover' : 'flex items-center gap-2 rounded-control px-1 py-1 hover:bg-sunken dark:hover:bg-raised'
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <section aria-label={t('Subtasks')} data-subtasks className={boxed ? 'overflow-hidden rounded-card border border-default' : undefined}>
      {(items.length > 0 || boxed) && (
        <h3 className={`flex items-center gap-2 text-meta font-semibold text-muted ${boxed ? 'min-h-9 px-3' : 'mb-1'}`}>
          <Icon name="list" className="text-faint" />{t('Subtasks')}
          {items.length > 0 && <span className="font-normal text-faint">{boxed ? t('{done} of {total}', progress) : `${progress.done}/${progress.total}`}</span>}
          {boxed && items.length > 0 && (
            <span className="ml-auto h-1 w-20 overflow-hidden rounded-full bg-sunken" aria-hidden="true" data-subtask-progress>
              <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </span>
          )}
        </h3>
      )}
      <ul className={`empty:hidden ${boxed ? '' : 'space-y-0.5'}`} aria-label={t('Subtasks')}>
        {items.map((c) => (
          <li key={c.id} className={row}>
            <button
              type="button"
              aria-label={c.completed_at ? t('Reopen {title}', { title: c.title }) : t('Complete {title}', { title: c.title })}
              aria-pressed={!!c.completed_at}
              onClick={() => onToggle(c)}
              disabled={readOnly}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${c.completed_at ? 'border-accent bg-accent text-on-accent' : 'border-input hover:bg-success-soft'}`}
            >
              {c.completed_at && <Icon name="check" size={10} />}
            </button>
            <button type="button" className={`min-w-0 flex-1 truncate text-left text-body ${c.completed_at ? 'text-faint line-through' : 'text-default'}`} onClick={() => onOpen?.(c.id)}>
              {c.title || <span className="italic text-faint">{t('Untitled')}</span>}
            </button>
          </li>
        ))}
      </ul>
      {!readOnly && add && <div className={boxed ? 'border-t border-soft px-2 py-1' : undefined}><AddSubtask parent={task} /></div>}
    </section>
  )
}

/** "Add subtask" input: creates on Enter and stays focused for the next entry. */
export function AddSubtask({ parent }: { parent: Task }) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const title = value.trim()
    if (!title) return
    setValue('')
    await createSubtask(parent.id, title)
    ref.current?.focus()
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex items-center gap-2 px-1" data-add-subtask>
      <span className="text-faint"><Icon name="plus" size="xs" /></span>
      <input
        ref={ref}
        className="min-w-0 flex-1 rounded-chip bg-transparent py-1 text-body text-default placeholder:text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        placeholder={t('Add subtask…')}
        aria-label={t('Add subtask')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLInputElement).blur() }}
      />
    </form>
  )
}
