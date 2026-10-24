// The comment composer's editor (OpenSpec change editor-everywhere, design D1,
// D2): the notes editor mounted on a Markdown body. The body stays Markdown: the
// field parses it once and writes renderMarkdown of the document back on every
// change, and a document equal to the one it started from gives back the text it
// started from, byte for byte. Loaded with React.lazy; until it arrives the
// composer is a plain text field.
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { EditorView } from 'prosemirror-view'
import { mentionToken, type MentionTarget } from '../../lib/comments'
import { mentionIds } from '../../lib/editorNotes'
import { parseMarkdown, renderMarkdown, type RNode } from '../../lib/richtext'
import { createState, insertBlocks, markdownSlice, modelToPm, pmToModel, schema, type EditorHooks } from '../../lib/richtextEditor'
import { EditorToolbar, openCellMenu, useEditorChrome } from '../EditorChrome'
import type { CommandEnv } from '../editorCommands'
import { imageViews } from '../editorImage'
import { LinkDialog } from '../LinkDialog'
import { filesFrom } from './AttachmentsRow'
import { t } from '../../lib/i18n'
import { afterTap } from './afterTap'
import { isImage } from '../../lib/attachments'

export interface RichComposerFieldProps {
  id: string
  value: string
  /** The Markdown body and the members it mentions, after every change. */
  onChange: (body: string, mentions: string[]) => void
  members: MentionTarget[]
  me: string | null
  label: string
  placeholder: string
  describedBy: string
  autoFocus?: boolean
  taskId: string | null
  onSubmit: () => void
  onEscape: () => void
  /** Pasted or dropped files that are not embedded (the comment's attachments). */
  onFiles?: (files: File[]) => void
  /** Plan images for embedding: their attachment ids, written with the comment. */
  onImages?: (files: File[]) => Promise<{ id: string; name: string }[]>
  fieldRef: Ref<RichFieldHandle | null>
  /** Show the formatting row whatever the pointer (the Formatting toggle, rich-comments D3). */
  toolbar?: boolean
}

/** What the composer asks of the field: focus, and start a mention at the caret (rich-comments D2). */
export interface RichFieldHandle {
  focus: () => void
  mention: () => void
}

/** The editor behind a composer element (tests drive it like a person would). */
const views = new WeakMap<Element, EditorView>()
export function composerViewOf(el: Element): EditorView | undefined {
  return views.get(el)
}

const canon = (nodes: RNode[]) => JSON.stringify(pmToModel(modelToPm(nodes)))

export default function RichComposerField(p: RichComposerFieldProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const props = useRef(p)
  props.current = p
  const [focused, setFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // The text the field started from (or was reset to) and its document.
  const start = useRef<{ text: string; canon: string }>({ text: '', canon: '' })
  const emitted = useRef<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const parse = (text: string) => parseMarkdown(text, {
    mention: (token) => {
      const m = props.current.members.find((x) => mentionToken(x) === token)
      return m ? { id: m.userId, name: token } : null
    },
  })

  const embed = async (v: EditorView, files: File[]) => {
    const images = files.filter((f) => isImage(f.type))
    const planned = images.length && props.current.onImages ? await props.current.onImages(images) : []
    const rest = files.filter((f) => !planned.length || !isImage(f.type))
    if (rest.length) props.current.onFiles?.(rest)
    if (!planned.length || v.isDestroyed) return
    v.dispatch(insertBlocks(v.state, planned.map((f) => schema.nodes.image.create({ id: f.id, alt: f.name.replace(/\.[a-z0-9]+$/i, '') }))).scrollIntoView())
  }
  const [linkAsk, setLinkAsk] = useState<{ current: string; answer: (href: string | null) => void } | null>(null)
  const env: CommandEnv = {
    notes: false, members: p.members.length > 0, askLink: (current) => new Promise<string | null>((answer) => setLinkAsk({ current, answer })), notify: (m) => chrome.notify(m),
    pickImage: p.onImages ? () => picker.current?.click() : undefined,
  }
  const chrome = useEditorChrome({ id: `${useId()}-composer`, env, members: p.members, me: p.me })
  const envRef = useRef(env)
  envRef.current = env

  useImperativeHandle(p.fieldRef, () => ({
    focus: () => view.current?.focus(),
    // `@` at the caret, after a space when it follows a word, so the suggest list opens.
    mention: () => {
      const v = view.current
      if (!v) return
      v.focus()
      const { $from, from } = v.state.selection
      const before = $from.parentOffset > 0 ? v.state.doc.textBetween(from - 1, from) : ''
      v.dispatch(v.state.tr.insertText(before && !/\s/.test(before) ? ' @' : '@').scrollIntoView())
    },
  }), [])

  useEffect(() => {
    const nodes = parse(p.value)
    start.current = { text: p.value, canon: canon(nodes) }
    emitted.current = p.value
    const hooks: EditorHooks = {
      askLink: (current) => envRef.current.askLink(current),
      onEscape: () => props.current.onEscape(),
      size: () => 0,
      placeholder: p.placeholder,
      suggest: chrome.bridge,
      notify: (m) => envRef.current.notify(m),
    }
    const v = new EditorView(host.current as HTMLDivElement, {
      state: createState(nodes, hooks),
      attributes: { id: p.id, role: 'textbox', 'aria-multiline': 'true', 'aria-label': p.label, 'aria-describedby': p.describedBy, class: 'notes-editor composer-editor' },
      nodeViews: imageViews(p.taskId),
      clipboardTextParser: (text) => markdownSlice(text),
      // Ctrl/⌘+Enter posts (props on the view run before the editor's own keys).
      handleKeyDown: (_v, e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
          e.preventDefault()
          props.current.onSubmit()
          return true
        }
        return false
      },
      handlePaste: (pv, event) => {
        const files = filesFrom(event.clipboardData)
        if (files.length === 0) return false
        void embed(pv, files)
        return true
      },
      handleDOMEvents: {
        focus: () => {
          setFocused(true)
          return false
        },
        blur: () => {
          // After the tap's click: hiding the toolbar now would move what was tapped.
          afterTap(() => setFocused(v.hasFocus()))
          return false
        },
        contextmenu: (pv, event) => openCellMenu(pv, event, chrome.openTableMenu),
      },
      dispatchTransaction(tr) {
        const next = v.state.apply(tr)
        v.updateState(next)
        if (!tr.docChanged) return
        const model = pmToModel(next.doc)
        // Unchanged from where it started: the original text, not a re-rendering of it.
        const body = canon(model) === start.current.canon ? start.current.text : renderMarkdown(model)
        emitted.current = body
        props.current.onChange(body, mentionIds(model))
      },
    })
    view.current = v
    views.set(v.dom, v)
    if (p.autoFocus) v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- one editor per field; later values arrive through the reset effect

  // The composer cleared or replaced the body (posted, another task's draft): start over.
  useEffect(() => {
    const v = view.current
    if (!v || p.value === emitted.current) return
    const nodes = parse(p.value)
    start.current = { text: p.value, canon: canon(nodes) }
    emitted.current = p.value
    v.updateState(createState(nodes, {
      askLink: (current) => envRef.current.askLink(current), onEscape: () => props.current.onEscape(), size: () => 0,
      placeholder: p.placeholder, suggest: chrome.bridge, notify: (m) => envRef.current.notify(m),
    }))
  }, [p.value]) // eslint-disable-line react-hooks/exhaustive-deps -- reacts to a new body only

  return (
    <div className="space-y-1">
      <EditorToolbar view={view.current} env={env} visible={focused || menuOpen} onMenu={setMenuOpen} always={p.toolbar} />
      <div ref={host} className="ui-input min-h-16 max-h-60 overflow-y-auto p-0" data-rich-composer />
      {chrome.overlays}
      {linkAsk && (
        <LinkDialog current={linkAsk.current}
          onSubmit={(href) => { linkAsk.answer(href); setLinkAsk(null) }}
          onCancel={() => { linkAsk.answer(null); setLinkAsk(null) }} />
      )}
      {p.onImages && (
        <input ref={picker} type="file" accept="image/*" multiple hidden aria-label={t('Choose an image for the comment')}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (view.current) void embed(view.current, files)
          }} />
      )}
    </div>
  )
}
