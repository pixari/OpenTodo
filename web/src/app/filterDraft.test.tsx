// @vitest-environment happy-dom
// The New view page keeps its draft (OpenSpec change sidebar-polish 5.1, 5.2;
// filter-queries "New view keeps its draft"): per device and workspace in the local
// meta table, restored after navigating away and after a reload, cleared by saving
// it as a view and by Clear (with Undo), never synced.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getMeta } from '../lib/db'
import { filterDraftKey, getFilterDraft, getFilterHistory, saveFilterDraft } from '../lib/filter'
import { createTask, resetDeviceId } from '../lib/ops'
import { fieldSortBy } from '../lib/types'
import { switchTo } from '../lib/workspaces'
import type { Workspace } from '../lib/types'
import { click, render, type, waitFor } from '../ui/test-utils'
import { hideBulkToast } from './bulk/toastStore'
import { UndoToast } from './bulk/UndoToast'
import { displayOfDraft, FilterView, NEW_VIEW_DISPLAY, toDraft } from './FilterView'

beforeEach(async () => {
  await db.delete()
  await db.open()
  resetDeviceId()
  localStorage.clear()
  hideBulkToast()
})

const input = (root: ParentNode) => root.querySelector<HTMLInputElement>('input[aria-label="Filter query"]')!
const board = (layout = 'board') => ({ query: '@work', group_by: 'project', sort_by: 'due', sort_dir: 'asc', layout, show_completed: false, hidden_props: [] })

describe('New view keeps its draft', () => {
  it('Check something and come back: the query is stored after a pause and restored on the next visit', async () => {
    await createTask({ title: 'Plan sprint', priority: 1 })
    const ops = await db.outbox.count()
    const r = await render(<FilterView />)
    await type(input(r.container), 'p1')
    await waitFor(async () => (await getFilterDraft(''))?.query === 'p1', 'the draft stored')
    await r.unmount()
    const again = await render(<FilterView />)
    await waitFor(() => input(again.container)?.value === 'p1', 'the query restored')
    await waitFor(() => again.container.textContent?.includes('Plan sprint') ?? false, 'the same results')
    // Nothing of it is synced: the draft wrote no op.
    expect(await db.outbox.count()).toBe(ops)
    await again.unmount()
  })

  it('Survives a reload with its display options: a stored board layout comes back', async () => {
    await createTask({ title: 'Plan sprint', priority: 1 })
    await saveFilterDraft('', { ...board(), query: 'p1' })
    const r = await render(<FilterView />)
    await waitFor(() => input(r.container)?.value === 'p1', 'the query')
    await waitFor(() => !!r.container.querySelector('[data-view-board]'), 'the board layout')
    await r.unmount()
  })

  it('keeps a custom field definition ID when a New view draft is restored', async () => {
    const sortBy = fieldSortBy('11111111-1111-4111-8111-111111111111')
    const draft = toDraft('p1', { ...NEW_VIEW_DISPLAY, sortBy })
    await saveFilterDraft('', draft)

    const restored = await getFilterDraft('')
    expect(restored).not.toBeNull()
    expect(displayOfDraft(restored!).sortBy).toBe(sortBy)
  })

  it('leaving at once still keeps the latest query', async () => {
    await saveFilterDraft('', { ...board('list'), query: 'p0' })
    const r = await render(<FilterView />)
    await waitFor(() => input(r.container)?.value === 'p0', 'the draft read')
    await type(input(r.container), 'p2')
    await r.unmount()
    await waitFor(async () => (await getFilterDraft(''))?.query === 'p2', 'flushed on close')
  })

  it('Saving clears it; Up recalls the saved query from the history', async () => {
    await saveFilterDraft('', { ...board('list'), query: 'p1' })
    const r = await render(<FilterView />)
    await waitFor(() => input(r.container)?.value === 'p1', 'the draft')
    await click([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save as view')!)
    await waitFor(() => !!r.container.querySelector('[data-save-view-card] input'), 'the save card')
    await type(r.container.querySelector<HTMLInputElement>('[data-save-view-card] input')!, 'Urgent')
    await click(r.container.querySelector('[data-save-view-card] button[type="submit"]')!)
    await waitFor(async () => (await db.views.count()) === 1, 'the view saved')
    await r.unmount()
    await waitFor(async () => (await getFilterDraft('')) === null, 'the draft cleared')
    const again = await render(<FilterView />)
    await waitFor(() => !!input(again.container), 'the page')
    expect(input(again.container).value).toBe('')
    expect((await getFilterHistory())[0]).toBe('p1')
    await again.unmount()
  })

  it('Clear and undo: the query and options are reset and the draft removed; Undo brings it back', async () => {
    await saveFilterDraft('', { ...board(), query: 'p1' })
    const r = await render(<><FilterView /><UndoToast /></>)
    await waitFor(() => input(r.container)?.value === 'p1', 'the draft')
    await click(r.container.querySelector('[data-filter-clear]')!)
    await waitFor(() => input(r.container).value === '', 'cleared')
    await waitFor(async () => (await getFilterDraft('')) === null, 'the stored draft removed')
    await waitFor(() => !!document.querySelector('[data-toast-action]'), 'the Undo offer')
    expect(document.querySelector('[data-bulk-toast] [role="status"]')?.textContent).toBe('New view cleared')
    await click(document.querySelector('[data-toast-action]')!)
    await waitFor(() => input(r.container).value === 'p1', 'restored')
    await waitFor(async () => (await getFilterDraft(''))?.layout === 'board', 'stored again with its options')
    await r.unmount()
  })

  it('Per workspace: each workspace has its own draft', async () => {
    const ws = (id: string, name: string, isDefault: boolean): Workspace => ({ id, name, icon: '', color: '', default: isDefault, role: 'owner', ownerId: 'u1' })
    await db.workspaces.bulkPut([ws('personal', 'Personal', true), ws('work', 'Work', false)])
    await saveFilterDraft('work', { ...board('list'), query: '@work' })
    await switchTo('work')
    const r = await render(<FilterView />)
    await waitFor(() => input(r.container)?.value === '@work', 'Work’s draft')
    await switchTo('personal')
    await waitFor(() => input(r.container).value === '', 'Personal has none')
    await type(input(r.container), 'p3')
    await waitFor(async () => (await getFilterDraft('personal'))?.query === 'p3', 'Personal’s draft')
    await switchTo('work')
    await waitFor(() => input(r.container).value === '@work', 'Work’s draft back')
    expect(await getMeta(filterDraftKey('work'), null)).toMatchObject({ query: '@work' })
    await r.unmount()
  })

  it('Address wins: ?q= replaces the draft query, and Up recalls the previous one', async () => {
    await saveFilterDraft('', { ...board('list'), query: '@errand' })
    const r = await render(<FilterView initialQuery="p1" />)
    await waitFor(async () => (await getFilterHistory()).includes('@errand'), 'the old query in the history')
    expect(input(r.container).value).toBe('p1')
    await waitFor(async () => (await getFilterDraft(''))?.query === 'p1', 'the draft follows the address')
    await r.unmount()
  })
})
