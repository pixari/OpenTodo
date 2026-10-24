// What the rich-text editor shows around itself (OpenSpec change
// editor-everywhere, design D7, D9): the `/` command menu and the `@` member
// list (a listbox at the caret driven by the editor's suggest plugin), the
// table's context menu, limit notices, and on touch screens a row of
// formatting controls. Shared by the notes and the comment composer; lazy chunk.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EditorView } from 'prosemirror-view'
import { mentionCandidates, mentionToken, type MentionTarget } from '../lib/comments'
import { insertMention } from '../lib/editorNotes'
import { dismissSuggest, type Suggest, type SuggestBridge } from '../lib/editorSuggest'
import { t } from '../lib/i18n'
import { Icon, IconButton, Menu, MenuItem, Popover, useMediaQuery } from '../ui'
import { editorCommands, filterCommands, tableCommands, type CommandEnv, type EditorCommand } from './editorCommands'
import { MentionOption } from './task-detail/MentionOption'

// A person or a workspace group (group-mentions D4).
type Member = MentionTarget
const MAX_ITEMS = 8
type Item = { kind: 'command'; cmd: EditorCommand } | { kind: 'member'; m: Member }

export interface ChromeOptions {
  /** Unique id prefix for the list and its options. */
  id: string
  env: CommandEnv
  members: Member[]
  me: string | null
}

export interface EditorChrome {
  /** Pass to the editor's hooks. */
  bridge: SuggestBridge
  notify: (message: string) => void
  /** Open the table menu for a cell (right click, long press). */
  openTableMenu: (view: EditorView, cell: HTMLElement) => void
  /** The list, the table menu and the notice; render next to the editor. */
  overlays: ReactNode
}

export function useEditorChrome(o: ChromeOptions): EditorChrome {
  const opts = useRef(o)
  opts.current = o
  const [open, setOpen] = useState<{ s: Suggest; view: EditorView } | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const [active, setActive] = useState(0)
  const activeRef = useRef(0)
  activeRef.current = active
  const [message, setMessage] = useState<string | null>(null)
  const [tableMenu, setTableMenu] = useState<{ view: EditorView; anchor: { current: HTMLElement } } | null>(null)
  const commands = useMemo(() => editorCommands(), [])
  const items: Item[] = !open ? []
    // At most eight at a time, so the list never scrolls: typing narrows it.
    : open.s.kind === 'slash' ? filterCommands(commands, open.s.query, open.view, o.env).slice(0, MAX_ITEMS).map((cmd) => ({ kind: 'command' as const, cmd }))
      : mentionCandidates(o.members, open.s.query, o.me).map((m) => ({ kind: 'member' as const, m }))
  const itemsRef = useRef(items)
  itemsRef.current = items
  const listId = `${o.id}-suggest`

  const apply = (item: Item) => {
    const cur = openRef.current
    if (!cur) return
    const { s, view } = cur
    if (item.kind === 'member') {
      insertMention(view, s, { id: item.m.userId, token: mentionToken(item.m) })
      return
    }
    view.dispatch(view.state.tr.delete(s.from, s.to))
    item.cmd.run(view, opts.current.env)
  }
  const applyRef = useRef(apply)
  applyRef.current = apply

  const bridge = useMemo<SuggestBridge>(() => ({
    mentions: () => opts.current.members.length > 0,
    onChange: (s, view) => {
      setOpen(s ? { s, view } : null)
      setActive(0)
    },
    onKey: (e) => {
      const list = itemsRef.current
      const cur = openRef.current
      if (!list.length || !cur) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length)
        return true
      }
      if (e.key === 'Enter' || (e.key === 'Tab' && cur.s.kind === 'mention')) {
        applyRef.current(list[Math.min(activeRef.current, list.length - 1)])
        return true
      }
      if (e.key === 'Escape') {
        dismissSuggest(cur.view)
        return true
      }
      return false
    },
  }), [])

  // The editor announces the list it controls and the option in focus.
  const shown = open && items.length > 0
  useEffect(() => {
    const dom = open?.view.dom
    if (!dom || !shown) return
    dom.setAttribute('aria-controls', listId)
    dom.setAttribute('aria-activedescendant', `${listId}-${Math.min(active, items.length - 1)}`)
    return () => {
      dom.removeAttribute('aria-controls')
      dom.removeAttribute('aria-activedescendant')
    }
  }, [open, shown, active, items.length, listId])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useMemo(() => (m: string) => {
    setMessage(m)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(null), 5000)
  }, [])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const overlays = (
    <>
      {shown && <SuggestList id={listId} open={open} items={items} active={Math.min(active, items.length - 1)} onPick={apply} />}
      {tableMenu && (
        <Popover open onClose={() => setTableMenu(null)} anchor={tableMenu.anchor} label={t('Table')} role="menu" align="start" className="p-1">
          {tableCommands().filter((c) => c.available?.(tableMenu.view, o.env) ?? true).map((c) => (
            <MenuItem key={c.id} label={c.label} icon={c.icon} onSelect={() => { setTableMenu(null); c.run(tableMenu.view, opts.current.env) }} />
          ))}
        </Popover>
      )}
      <p role="status" className="text-meta text-warning empty:hidden">{message ?? ''}</p>
    </>
  )
  return { bridge, notify, openTableMenu: (view, cell) => setTableMenu({ view, anchor: { current: cell } }), overlays }
}

/** The `/` or `@` list at the caret: a listbox; focus stays in the editor. */
function SuggestList({ id, open, items, active, onPick }: { id: string; open: { s: Suggest; view: EditorView }; items: Item[]; active: number; onPick: (item: Item) => void }) {
  let left = 16
  let top = 0
  try {
    const c = open.view.coordsAtPos(open.s.from)
    left = c.left
    top = c.bottom + 4
  } catch {
    // No layout (a test, a hidden editor): the list sits at the start.
  }
  const width = 256
  if (typeof window !== 'undefined') left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
  const label = open.s.kind === 'slash' ? t('Commands') : t('Mention a member')
  return (
    <ul id={id} role="listbox" aria-label={label} className="slash-menu fixed" style={{ left, top }} data-suggest={open.s.kind}>
      {items.map((item, i) => (
        <li key={item.kind === 'command' ? item.cmd.id : item.m.userId} id={`${id}-${i}`} role="option" aria-selected={i === active}
          className="flex min-h-11 items-center gap-2 rounded-control px-2 py-1 text-body"
          onMouseDown={(e) => { e.preventDefault(); onPick(item) }}>
          {item.kind === 'command'
            ? <><Icon name={item.cmd.icon} size="sm" className="text-muted" />{item.cmd.label}</>
            : <MentionOption m={item.m} />}
        </li>
      ))}
    </ul>
  )
}

/**
 * The formatting row on touch screens (rich-text-editing "Editing toolbar on
 * touch screens"): shown only on a coarse pointer while the editor has focus.
 */
export function EditorToolbar({ view, env, visible, onMenu, coarse: forced, always = false }: {
  view: EditorView | null; env: CommandEnv; visible: boolean; onMenu: (open: boolean) => void
  /** Stories: show the touch row whatever the pointer. */
  coarse?: boolean
  /** Shown on request whatever the pointer and focus (the comment composer's Formatting toggle, rich-comments D3). */
  always?: boolean
}) {
  const coarse = useMediaQuery('(pointer: coarse)') || !!forced
  const commands = useMemo(() => editorCommands(), [])
  if (!view || !(always || (coarse && visible))) return null
  const byId = (id: string) => commands.find((c) => c.id === id) as EditorCommand
  const run = (id: string) => byId(id).run(view, env)
  const more = commands.filter((c) => !['bold', 'italic', 'link', 'bullet', 'checklist'].includes(c.id) && (c.available ? c.available(view, env) : true))
  return (
    // Buttons keep the editor's focus and selection: the press never moves focus.
    <div role="toolbar" aria-label={t('Formatting')} className="editor-toolbar" data-editor-toolbar onMouseDown={(e) => e.preventDefault()}>
      <IconButton icon="bold" size="sm" label={t('Bold')} onClick={() => run('bold')} />
      <IconButton icon="italic" size="sm" label={t('Italic')} onClick={() => run('italic')} />
      <IconButton icon="link" size="sm" label={t('Link')} onClick={() => run('link')} />
      <IconButton icon="list" size="sm" label={t('Bullet list')} onClick={() => run('bullet')} />
      <IconButton icon="list-checks" size="sm" label={t('Checklist')} onClick={() => run('checklist')} />
      <Menu label={t('More formatting')} kind="menu" align="end" onOpenChange={onMenu} trigger={<Icon name="ellipsis" size="sm" />} triggerClassName="ui-btn ui-btn--icon ui-btn--ghost ui-btn--sm">
        {more.map((c) => <MenuItem key={c.id} label={c.label} icon={c.icon} onSelect={() => c.run(view, env)} />)}
      </Menu>
    </div>
  )
}

/** A table cell's own menu (right click): rows, columns, header, delete. */
export function openCellMenu(view: EditorView, event: MouseEvent, open: (view: EditorView, cell: HTMLElement) => void): boolean {
  const cell = (event.target as HTMLElement).closest('td, th') as HTMLElement | null
  if (!cell) return false
  event.preventDefault()
  open(view, cell)
  return true
}
