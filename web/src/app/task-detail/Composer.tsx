// Comment composer (OpenSpec task-detail-redesign D5; comments "Composer behaviour"):
// markdown text that grows with its content, `@` completion from the cached project
// members, Ctrl/⌘+Enter submits, Esc cancels or leaves the field. The new-comment
// composer keeps an unsent draft per task in this tab's session (never synced).
// Expanded, the field is the notes' rich-text editor (editor-everywhere D1, D2),
// loaded lazily; until it arrives it is a plain text field holding the same text.
import { flushSync } from 'react-dom'
import { forwardRef, type KeyboardEvent, lazy, Suspense, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Kbd } from '../shortcuts/Kbd'
import { planFiles, type PlannedFile } from '../../lib/attachments'
import { mentionAt, mentionCandidates, mentionsInBody, mentionToken, type MentionTarget } from '../../lib/comments'
import { MentionOption } from './MentionOption'
import { uuid } from '../../lib/ids'
import { Button, ComposerFrame, IconButton, Popover, useMediaQuery } from '../../ui'
import { Icon } from '../../ui'
import { filesFrom } from './AttachmentsRow'
import { t } from '../../lib/i18n'

const MAX_LINES = 10
const LINE_PX = 20

const RichComposerField = lazy(() => import('./RichComposerField'))
type RichFieldHandle = import('./RichComposerField').RichFieldHandle

// The rich editor is on by default; a test of the plain field turns it off.
let richComposer = true
export function setRichComposer(on: boolean): void {
  richComposer = on
}

/** What a new comment carries beyond its text: its id and the images embedded in it. */
export interface ComposedExtras {
  id: string
  embeds: PlannedFile[]
}

// Drafts live in memory and in sessionStorage: device-local, gone with the browser session.
const drafts = new Map<string, string>()
const draftStorageKey = (taskId: string) => `ot.draft.${taskId}`

export function readDraft(taskId: string): string {
  if (drafts.has(taskId)) return drafts.get(taskId)!
  try {
    return sessionStorage.getItem(draftStorageKey(taskId)) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(taskId: string, body: string) {
  if (body) drafts.set(taskId, body)
  else drafts.delete(taskId)
  try {
    if (body) sessionStorage.setItem(draftStorageKey(taskId), body)
    else sessionStorage.removeItem(draftStorageKey(taskId))
  } catch {
    // storage unavailable: the in-memory copy still covers closing and reopening the panel
  }
}

/** The submit hint: ⌘ on Apple platforms, Ctrl elsewhere. */
function submitKey(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'
}

export interface ComposerProps {
  id: string
  /** Keep the unsent text as this task's draft (the main composer only). */
  draftTaskId?: string
  initial?: string
  /** People, then workspace groups, to mention (group-mentions D4). */
  members: MentionTarget[]
  me: string | null
  /** Resolves false (or rejects inside) when the comment was not stored; the text is then kept. */
  onSubmit: (body: string, mentions: string[], files: File[], extras: ComposedExtras) => Promise<unknown>
  /** The task, for images embedded in a new comment (the main composer only). */
  taskId?: string
  /** The rich editor (default) or the plain field. */
  rich?: boolean
  /** Offer an attach button: picked or pasted files go with the comment (OpenSpec attachments). */
  attach?: boolean
  onCancel?: () => void
  autoFocus?: boolean
  submitLabel: string
  /** Accessible name of the text field. */
  label: string
}

export const Composer = forwardRef<HTMLElement | null, ComposerProps>(function Composer(
  { id, draftTaskId, initial = '', members, me, onSubmit, onCancel, autoFocus, submitLabel, label, attach = false, taskId, rich: richProp }, ref,
) {
  const [rich] = useState(() => richProp ?? richComposer)
  const richField = useRef<RichFieldHandle | null>(null)
  // The formatting row on a computer (rich-comments D3); touch screens show it while the editor has focus.
  const [formatting, setFormatting] = useState(false)
  const coarse = useMediaQuery('(pointer: coarse)')
  const richMentions = useRef<string[] | null>(null)
  const commentId = useRef(uuid())
  const embeds = useRef<PlannedFile[]>([])
  const [files, setFiles] = useState<File[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const [body, setBodyState] = useState(() => (draftTaskId ? readDraft(draftTaskId) || initial : initial))
  const [picked, setPicked] = useState(() => new Map<string, string>(members.filter((m) => initial.includes(`@${mentionToken(m)}`)).map((m) => [m.userId, mentionToken(m)])))
  const [caret, setCaret] = useState(initial.length)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  // Focus goes to the editor once it is there, else to the plain field.
  useImperativeHandle(ref, () => ({
    focus: () => (richField.current ? richField.current.focus() : area.current?.focus()),
    scrollIntoView: (o?: ScrollIntoViewOptions) => (area.current ?? document.getElementById(id))?.scrollIntoView?.(o),
  }) as unknown as HTMLElement, [id])
  const at = members.length ? mentionAt(body, caret) : null
  const options = at && !closed ? mentionCandidates(members, at.query, me) : []
  const listId = `${id}-mentions`

  // The latest text, also before React renders it (Ctrl+Enter right after a keystroke).
  const bodyRef = useRef(body)
  bodyRef.current = body
  const setBody = (next: string) => {
    bodyRef.current = next
    setBodyState(next)
    if (draftTaskId) writeDraft(draftTaskId, next)
  }

  // Another task opened in the same panel: show that task's draft.
  useEffect(() => {
    if (draftTaskId) setBodyState(readDraft(draftTaskId))
  }, [draftTaskId])

  // Grow with the content up to about ten lines, then scroll.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    const max = MAX_LINES * LINE_PX + 16
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [body])

  function pick(m: MentionTarget) {
    if (!at) return
    const token = mentionToken(m)
    const next = `${body.slice(0, at.start)}@${token} ${body.slice(caret)}`
    const pos = at.start + token.length + 2
    setBody(next)
    setPicked((p) => new Map(p).set(m.userId, token))
    setCaret(pos)
    setActive(0)
    // The caret goes after the name; setting the range may not report a selection change.
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  /** The Mention control (rich-comments D2): `@` at the caret, the completion opens. */
  function startMention() {
    if (richField.current) {
      richField.current.mention()
      return
    }
    const el = area.current
    const pos = el?.selectionStart ?? body.length
    const prev = body.slice(0, pos)
    const text = prev && !/\s$/.test(prev) ? ' @' : '@'
    const next = `${prev}${text}${body.slice(pos)}`
    // Rendered at once, so the caret can go after the `@` before anything else happens.
    flushSync(() => {
      setBody(next)
      setCaret(pos + text.length)
      setClosed(false)
      setActive(0)
    })
    el?.focus()
    el?.setSelectionRange(pos + text.length, pos + text.length)
  }

  const canSend = !!body.trim() || files.length > 0
  async function submit() {
    const text = bodyRef.current
    if ((!text.trim() && files.length === 0) || busy) return
    setBusy(true)
    const mentions = richMentions.current ?? mentionsInBody(text, picked)
    const ok = await onSubmit(text, mentions, files, { id: commentId.current, embeds: embeds.current })
    setBusy(false)
    if (ok !== false && !onCancel) {
      setBody('')
      setPicked(new Map())
      setFiles([])
      richMentions.current = null
      commentId.current = uuid()
      embeds.current = []
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[Math.min(active, options.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setClosed(true)
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (onCancel) onCancel()
      else (e.target as HTMLTextAreaElement).blur()
    }
  }

  const key = submitKey()
  const placeholder = members.length ? t('Write a comment… (markdown, @ to mention)') : t('Write a comment… (markdown)')
  const plain = (
      <textarea
        id={id}
        ref={area}
        rows={2}
        className="ui-input min-h-16 resize-none text-body leading-5"
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={`${id}-hint`}
        value={body}
        autoFocus={autoFocus}
        role={options.length ? 'combobox' : undefined}
        aria-expanded={options.length ? true : undefined}
        aria-controls={options.length ? listId : undefined}
        aria-activedescendant={options.length ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
        onChange={(e) => {
          setBody(e.target.value)
          setCaret(e.target.selectionStart)
          setClosed(false)
          setActive(0)
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={attach ? (e) => {
          const pasted = filesFrom(e.clipboardData)
          if (pasted.length === 0) return
          e.preventDefault()
          setFiles((f) => [...f, ...pasted])
        } : undefined}
      />
  )
  const fileList = files.length > 0 && (
    <ul aria-label={t('Files to attach')} className="mt-1 flex flex-wrap gap-1">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} className="flex max-w-full items-center gap-1 rounded-control bg-sunken py-0.5 pl-2 text-meta text-default">
          <Icon name="paperclip" size="xs" className="text-faint" /><span className="min-w-0 truncate">{f.name}</span>
          <IconButton icon="x" size="sm" label={t('Remove {name}', { name: f.name })} onClick={() => setFiles((list) => list.filter((_, j) => j !== i))} />
        </li>
      ))}
    </ul>
  )
  // The shared frame (task-full-page D6): the field, then attach on the left, the keys and Send on the right.
  const tools = (
    // The controls keep the field's focus and selection: a press never moves focus.
    <span className="contents" onMouseDown={(e) => { if ((e.target as HTMLElement).closest('[data-keep-focus]')) e.preventDefault() }}>
      {members.length > 0 && (
        <IconButton icon="at-sign" size="sm" label={t('Mention someone')} onClick={startMention} data-keep-focus="" data-composer-mention="" />
      )}
      {rich && !coarse && (
        <IconButton icon="bold" size="sm" label={t('Formatting')} aria-pressed={formatting} onClick={() => setFormatting((f) => !f)}
          data-keep-focus="" data-composer-formatting="" />
      )}
      {attach && (
        <>
          <input ref={picker} type="file" multiple hidden aria-label={t('Choose files for the comment')} data-testid="comment-file-picker"
            onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; setFiles((f) => [...f, ...picked]) }} />
          <IconButton icon="paperclip" size="sm" label={t('Attach files')} onClick={() => picker.current?.click()} />
        </>
      )}
    </span>
  )
  const end = (
    <>
      <span id={`${id}-hint`} className="hidden text-hint text-faint sm:inline">{t.rich('Send with {keys}', { keys: <Kbd k={`${key}+Enter`} /> })}</span>
      {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>{t('Cancel')}</Button>}
    </>
  )
  return (
    <div className="relative" data-composer>
      <ComposerFrame tools={tools} end={end} below={fileList || undefined}
        send={{ label: submitLabel, onSend: () => void submit(), disabled: !canSend, busy, shortcut: `${key}+Enter` }}>
        {rich ? (
          <Suspense fallback={plain}>
            <RichComposerField id={id} value={body} members={members} me={me} label={label} placeholder={placeholder} describedBy={`${id}-hint`}
              autoFocus={autoFocus || (!!area.current && document.activeElement === area.current)} taskId={taskId ?? null} fieldRef={richField} toolbar={formatting}
              onChange={(next, ids) => { richMentions.current = ids; setBody(next) }}
              onSubmit={() => void submit()}
              onEscape={() => { if (onCancel) onCancel(); else (document.activeElement as HTMLElement | null)?.blur() }}
              onFiles={attach ? (more) => setFiles((f) => [...f, ...more]) : undefined}
              onImages={attach && taskId ? async (images) => {
                const planned = await planFiles(taskId, images, { commentId: commentId.current })
                embeds.current = [...embeds.current, ...planned]
                return planned.map((x) => ({ id: x.blob.id, name: x.blob.name }))
              } : undefined} />
          </Suspense>
        ) : plain}
      </ComposerFrame>
      {/* Non-modal: focus stays in the textarea (combobox pattern); a sheet on phones. */}
      <Popover open={options.length > 0} onClose={() => setClosed(true)} anchor={area} label={t('Mention a member')} modal={false} align="start" role={undefined} className="py-1">
        <ul id={listId} role="listbox" aria-label={t('Mention a member')}>
          {options.map((m, i) => (
            <li key={m.userId} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={`flex min-h-11 flex-wrap items-center gap-x-1 px-3 py-1 ${i === active ? 'bg-sunken' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(m) }}>
              <MentionOption m={m} />
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  )
})
