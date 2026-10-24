// @vitest-environment happy-dom
// The comment composer's Mention and Formatting controls (OpenSpec change
// rich-comments, D2, D3), and bodies posted as plain Markdown rendering as before.
import { act } from 'react'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionTarget } from '../../lib/comments'
import type { Comment } from '../../lib/types'
import { click, flush, key, render, waitFor } from '../../ui/test-utils'
import { setRichComposer, writeDraft } from './Composer'
import { CommentsView, type CommentsViewProps } from './CommentsTab'
import { composerViewOf } from './RichComposerField'

const MON = new Date(2026, 9, 12, 15, 5).getTime()
const targets: MentionTarget[] = [
  { userId: 'me', name: 'Me', email: 'me@example.com' },
  { userId: 'anna', name: 'Anna', email: 'anna@example.com' },
  { userId: 'group:g-adults', name: 'Adults', email: '', group: { size: 2 } },
]

function props(over: Partial<CommentsViewProps> = {}): CommentsViewProps {
  return {
    taskId: 't1', threads: [], me: 'me', role: 'admin', members: targets, name: (id) => (id === 'me' ? 'You' : 'Anna'),
    onCreate: vi.fn(async () => true), onEdit: vi.fn(async () => true), onDelete: vi.fn(async () => {}), now: MON + 1000, ...over,
  }
}

async function typeText(v: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = v.state.selection
    const handled = v.someProp('handleTextInput', (f) => f(v, from, to, ch, () => v.state.tr.insertText(ch, from, to)))
    if (!handled) v.dispatch(v.state.tr.insertText(ch, from, to))
  }
  await flush(10)
}

async function press(v: EditorView, k: string, mods: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })
  v.someProp('handleKeyDown', (f) => f(v, ev))
  await flush(20)
}

async function typeArea(el: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const mentionButton = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[data-composer-mention]')
const posted = (p: CommentsViewProps) => (p.onCreate as ReturnType<typeof vi.fn>).mock.calls

beforeEach(() => {
  sessionStorage.clear()
  writeDraft('t1', '')
})
afterEach(() => {
  setRichComposer(true)
  document.body.innerHTML = ''
})

describe('Mention control', () => {
  it('starts a mention after the text in the rich editor, then posts it', async () => {
    const p = props()
    const r = await render(<CommentsView {...p} />)
    await waitFor(() => !!r.container.querySelector('[data-rich-composer] #comment-composer'), 'the rich composer')
    const v = composerViewOf(r.container.querySelector('#comment-composer')!)!
    v.focus()
    await typeText(v, 'Thanks')
    expect(mentionButton(r.container)?.getAttribute('aria-label')).toBe('Mention someone')
    await click(mentionButton(r.container)!)
    await flush(20)
    expect(v.state.doc.textContent).toBe('Thanks @')
    await waitFor(() => !!document.querySelector('[data-suggest="mention"]'), 'the mention list')
    const options = [...document.querySelectorAll('[data-suggest="mention"] [role="option"]')].map((o) => o.textContent)
    expect(options[0]).toContain('Anna')
    expect(options.at(-1)).toContain('Adults')
    await press(v, 'Enter')
    await press(v, 'Enter', { ctrlKey: true })
    await waitFor(() => posted(p).length > 0, 'the comment to post')
    expect(posted(p)[0].slice(0, 2)).toEqual(['Thanks @Anna', ['anna']])
  })

  it('works in the plain field too', async () => {
    const p = props({ richComposer: false })
    const r = await render(<CommentsView {...p} />)
    const area = r.container.querySelector('#comment-composer') as HTMLTextAreaElement
    await typeArea(area, 'Hi')
    area.setSelectionRange(2, 2)
    await click(mentionButton(r.container)!)
    await flush(20)
    expect(area.value).toBe('Hi @')
    await waitFor(() => document.querySelectorAll('[role="listbox"] [role="option"]').length > 0, 'the mention list')
    await key(area, 'Enter')
    expect(area.value).toBe('Hi @Anna ')
    // The pick places the caret after the name on the next frame.
    await flush(50)
    await key(area, 'Enter', { ctrlKey: true })
    await waitFor(() => posted(p).length > 0, 'the comment to post')
    expect(posted(p)[0].slice(0, 2)).toEqual(['Hi @Anna ', ['anna']])
  })

  it('is not offered without anyone to mention (a personal task)', async () => {
    const r = await render(<CommentsView {...props({ members: [], richComposer: false })} />)
    expect(mentionButton(r.container)).toBeNull()
  })
})

describe('Formatting control', () => {
  it('shows the formatting row on a computer, applies bold, and hides it again', async () => {
    const p = props()
    const r = await render(<CommentsView {...p} />)
    await waitFor(() => !!r.container.querySelector('[data-rich-composer] #comment-composer'), 'the rich composer')
    const v = composerViewOf(r.container.querySelector('#comment-composer')!)!
    const toggle = r.container.querySelector<HTMLButtonElement>('[data-composer-formatting]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(r.container.querySelector('[data-editor-toolbar]')).toBeNull()
    await click(toggle)
    await waitFor(() => !!r.container.querySelector('[data-editor-toolbar]'), 'the formatting row')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    v.focus()
    await typeText(v, 'done')
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 5)))
    await click(r.container.querySelector<HTMLButtonElement>('[data-editor-toolbar] [aria-label="Bold"]')!)
    await press(v, 'Enter', { ctrlKey: true })
    await waitFor(() => posted(p).length > 0, 'the comment to post')
    expect(posted(p)[0][0]).toBe('**done**')
    await click(toggle)
    await waitFor(() => !r.container.querySelector('[data-editor-toolbar]'), 'the row to hide')
  })
})

describe('rendering', () => {
  it('a body written through the API renders bold and a mention chip, as before', async () => {
    const c = { id: 'c1', task_id: 't1', parent_id: null, body: '**done**, see @Anna', author_id: 'anna', mentions: ['anna'], created_at: MON, edited_at: null, deleted_at: null, _clock: {} } as Comment
    const r = await render(<CommentsView {...props({ threads: [{ root: c, replies: [] }], richComposer: false })} />)
    const body = r.container.querySelector('.markdown')!
    expect(body.querySelector('strong')?.textContent).toBe('done')
    expect(body.querySelector('[data-mention-token="Anna"]')).not.toBeNull()
  })
})
