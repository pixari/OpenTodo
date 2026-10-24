// The details of an expanded row (OpenSpec change row-expand, task-list-presentation
// "Expanded rows", design D3): what the one-line row leaves out, read in place under
// it. Built from the task page's own parts, so a fact reads the same in the list, the
// panel and the page: the notes as rendered Markdown (about four lines, then Show
// more), the panel's facet lines read-only (only parts with a value), the subtasks as
// the panel's checklist (ticking is the one edit made here), then the comment and
// attachment counts and Open task. Loaded lazily, on the first expand.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FacetId, FacetPart } from '../../lib/facets'
import { t } from '../../lib/i18n'
import { useSubtasks, useTask } from '../../lib/localData'
import { progressOf } from '../../lib/subtasks'
import type { Task } from '../../lib/types'
import { Button, Icon, type IconName } from '../../ui'
import { act } from '../actionError'
import { Markdown } from '../Markdown'
import { setPanelTaskId } from '../panel'
import { useTaskDetailData } from '../PanelHost'
import { FacetLine } from '../task-detail/FacetLine'
import { useFacetParts } from '../task-detail/Facets'
import { Subtasks } from '../task-detail/Subtasks'
import { usePropertiesModel } from '../task-detail/usePropertiesModel'
import { completeWithUndo } from '../undoable'
import { useAttachmentCount, useCommentCount } from '../useCommentCounts'

/** Nothing is revealed: the details show only the parts that have a value. */
const NONE = new Set<string>()

/** The facet lines in the panel's order, with their icon and name. */
const LINES: { id: FacetId; icon: IconName; name: () => string }[] = [
  { id: 'when', icon: 'calendar-days', name: () => t('When') },
  { id: 'where', icon: 'folder', name: () => t('Where') },
  { id: 'how', icon: 'flag', name: () => t('How') },
  { id: 'who', icon: 'users', name: () => t('Who') },
]

/** The parts a facet line shows in the details: set values only, and no default priority. */
export function shownParts(parts: FacetPart[]): FacetPart[] {
  return parts.filter((p) => !p.empty && !(p.id === 'priority' && p.text === 'P4'))
}

export interface RowDetailsProps {
  task: Task
  /** The element id the row's controls point at (`aria-controls`). */
  id: string
  readOnly: boolean
  /** The list shows the subtasks as rows under the task: the details leave the checklist out. */
  childrenShown: boolean
  /** Opens the task, as Enter does. */
  onOpen: () => void
}

export default function RowDetails({ task, id, readOnly, childrenShown, onOpen }: RowDetailsProps) {
  const { projects, labelMap } = useTaskDetailData()
  const children = useSubtasks(task.id)
  const parent = useTask(task.parent_id) ?? undefined
  const props = { task, readOnly: true, projects, labelMap, parent, childCount: children.length }
  const m = usePropertiesModel(props)
  const { facets } = useFacetParts(props, m, NONE)
  const progress = useMemo(() => progressOf({ id: task.id }, children), [task.id, children])
  const comments = useCommentCount(task.id)
  const attachments = useAttachmentCount(task.id)
  const name = task.title || t('Untitled')
  const counts = [
    comments > 0 && { icon: 'message-circle' as const, text: t('{n, plural, one {# comment} other {# comments}}', { n: comments }), key: 'comments' },
    attachments > 0 && { icon: 'paperclip' as const, text: t('{n, plural, one {# attachment} other {# attachments}}', { n: attachments }), key: 'attachments' },
  ].filter((c): c is { icon: 'message-circle' | 'paperclip'; text: string; key: string } => !!c)

  return (
    <div id={id} role="group" aria-label={t('Details of {title}', { title: name })} data-row-details={task.id}
      className="min-w-0 basis-full space-y-2 pb-2 pt-1"
      // The details are not the row: a press here never opens the task, starts a drag or a swipe.
      onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {task.description.trim() && <ClampedNotes taskId={task.id} text={task.description} />}
      <div className="space-y-0.5" data-row-facts>
        {LINES.map((l) => {
          const parts = shownParts(facets[l.id])
          return parts.length > 0 && <FacetLine key={l.id} facet={l.id} icon={l.icon} name={l.name()} parts={parts} readOnly />
        })}
      </div>
      {children.length > 0 && !childrenShown && (
        <Subtasks task={task} items={children} progress={progress} readOnly={readOnly} add={false}
          onToggle={(c) => act(completeWithUndo(c.id, !c.completed_at))} onOpen={(sub) => setPanelTaskId(sub)} />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted" data-row-details-end>
        {counts.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1" {...{ [`data-${c.key}`]: '' }}>
            <Icon name={c.icon} size="xs" className="text-faint" />{c.text}
          </span>
        ))}
        <Button variant="ghost" size="sm" className="-ml-1.5" onClick={onOpen} data-row-details-open>{t('Open task')}</Button>
      </div>
    </div>
  )
}

/** The notes as rendered Markdown, four lines (`max-h-[4lh]`) until Show more (design D3). */
function ClampedNotes({ taskId, text }: { taskId: string; text: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [tall, setTall] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || open) return
    const measure = () => setTall(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [open, text])
  return (
    <div data-row-notes>
      <div ref={box} className={`user-text text-body text-muted ${open ? '' : 'max-h-[4lh] overflow-hidden'}`}>
        <Markdown source={text} taskId={taskId} />
      </div>
      {(tall || open) && (
        <button type="button" className="mt-0.5 text-meta text-accent hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-row-notes-more>
          {open ? t('Show less') : t('Show more')}
        </button>
      )}
    </div>
  )
}
