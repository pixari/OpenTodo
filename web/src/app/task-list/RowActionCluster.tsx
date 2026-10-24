// Revealed row actions (OpenSpec change rows-v2, task-list-presentation "Revealed
// row actions", design D7): Show details (row-expand D2), Schedule, Priority and More at the row's right edge, in
// the place of the trailing group while the pointer is over the row or focus is
// inside it. They are real buttons at all times (reachable by Tab, never hover-only);
// CSS shows them only on a fine pointer from 768 px, and on touch they are not
// displayed at all, so they are neither tab stops nor heard there. Each writes through
// the same path as its key: Priority through updateTask, More through the list's
// actions menu, Schedule through the panel's Do on editor.
import { lazy, Suspense, useRef, useState, type KeyboardEvent } from 'react'
import { act } from '../actionError'
import { updateTask } from '../../lib/ops'
import { keysOf } from '../../lib/shortcuts'
import type { Priority, Task } from '../../lib/types'
import { t } from '../../lib/i18n'
import { Icon, IconButton, Menu, MenuItem } from '../../ui'

const RowSchedule = lazy(() => import('./RowSchedule'))

const PRIORITY_TEXT: Record<Priority, string> = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' }

/** Keeps a focused action fully visible above the toast and the selection bar (WCAG 2.2 2.4.11). */
function reveal(el: HTMLElement) {
  el.scrollIntoView?.({ block: 'nearest' })
}

export function RowActionCluster({ task, onMore, force = false, editable = true, details }: {
  task: Task
  /** The user may change the task: Schedule, Priority and More; a viewer's cluster has Show details only. */
  editable?: boolean
  /** Show details / Hide details (row-expand D2), when the row can expand. */
  details?: { expanded: boolean; controls: string; onToggle: () => void }
  /** Opens the row menu, as `.` does; without it the cluster has no More button. */
  onMore?: (from: HTMLElement) => void
  /** Stories: shown as if hovered (the visual gate cannot hover). */
  force?: boolean
}) {
  const [scheduling, setScheduling] = useState(false)
  const schedule = useRef<HTMLButtonElement>(null)
  // Esc on an action goes back to the row's open control.
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Escape' || scheduling) return
    const open = e.currentTarget.closest('li')?.querySelector<HTMLElement>('[data-row-open]')
    if (!open) return
    e.preventDefault()
    e.stopPropagation()
    open.focus()
  }
  // Hidden actions take no clicks: the trailing group's origin link stays under the pointer.
  const shown = force || scheduling ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
  return (
    <span data-row-actions="" onKeyDown={onKeyDown} onFocus={(e) => reveal(e.target as HTMLElement)}
      className={`absolute top-px right-1 hidden items-center gap-2 rounded-control border border-strong bg-pop px-0.5 shadow-2 transition-opacity duration-(--duration-ui) md:pointer-fine:flex ${shown}`}>
      {details && (
        <IconButton icon="chevron-down" size="sm" label={details.expanded ? t('Hide details') : t('Show details')}
          shortcut={keysOf(details.expanded ? 'list.collapse' : 'list.expand')} aria-expanded={details.expanded}
          aria-controls={details.expanded ? details.controls : undefined} data-row-action="details" onClick={details.onToggle}
          className={details.expanded ? '[&_svg]:rotate-180' : undefined} />
      )}
      {editable && <>
      <IconButton ref={schedule} icon="calendar-days" size="sm" label={t('Schedule')} aria-haspopup="dialog" aria-expanded={scheduling}
        data-row-action="schedule" onClick={() => setScheduling(true)} />
      <Menu kind="menu" label={`${t('Priority')}: ${PRIORITY_TEXT[task.priority]}`} tip={t('Priority')} tipShortcut={keysOf('list.priority')} align="end"
        triggerProps={{ 'data-row-action': 'priority' }}
        trigger={<Icon name="flag" size="sm" />}
        triggerClassName="ui-btn ui-btn--icon ui-btn--ghost ui-btn--sm">
        {([1, 2, 3, 4] as Priority[]).map((p) => (
          <MenuItem key={p} label={PRIORITY_TEXT[p]} checked={task.priority === p} onSelect={() => act(updateTask(task.id, { priority: p }))} />
        ))}
      </Menu>
      {onMore && <IconButton icon="ellipsis" size="sm" label={t('More actions')} shortcut={keysOf('list.actions')} data-row-action="more" onClick={(e) => onMore(e.currentTarget)} />}
      </>}
      {scheduling && (
        <Suspense fallback={null}>
          <RowSchedule task={task} anchor={schedule} onClose={() => setScheduling(false)} />
        </Suspense>
      )}
    </span>
  )
}
