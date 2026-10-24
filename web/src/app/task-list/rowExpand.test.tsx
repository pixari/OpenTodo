// @vitest-environment happy-dom
// Expanded rows (OpenSpec change row-expand, task-list-presentation "Expanded rows"):
// → shows the selected task's details under its row and ← hides them, Esc closes them
// before the selection clears, one row at a time, the touch disclosure toggles without
// opening the task, a subtask ticks in place, and nothing is remembered.
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../lib/db'
import { logicalToday } from '../../lib/dates'
import { createProject, createSubtask, createTask, resetDeviceId, updateTask } from '../../lib/ops'
import { saveViewMode } from '../../lib/sections'
import { setCurrentUserId } from '../../lib/sharing'
import { click, flush, key, minWidthPx, mockFetch, noPublicLinks, render, waitFor } from '../../ui/test-utils'
import { resetPanel } from '../panel'
import { openedTask, resetTaskPage } from '../taskPage.testkit'
import { SavedViewRoute } from '../SavedViewView'
import { TaskListView } from '../TaskListView'
import { createView } from '../../lib/views'
import { shownParts } from './RowDetails'

const original = window.matchMedia
let width = 1280
let coarse = false
function viewport(px: number, touch = false) {
  width = px
  coarse = touch
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })
  window.matchMedia = ((q: string) => ({
    matches: /pointer:\s*fine/.test(q) ? !coarse : /pointer:\s*coarse/.test(q) ? coarse : /hover/.test(q) ? !coarse : minWidthPx(q) <= width,
    media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(async () => {
  mockFetch(noPublicLinks)
  await db.delete()
  await db.open()
  resetDeviceId()
  setCurrentUserId('me')
  resetPanel()
  resetTaskPage()
  localStorage.clear()
  history.replaceState(null, '', '/')
  viewport(1280)
})
afterEach(() => {
  window.matchMedia = original
  resetPanel()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const row = (title: string) => [...document.querySelectorAll<HTMLElement>('li[data-task-id]')].find((li) => li.querySelector('[data-row-title]')?.textContent === title)!
const details = () => [...document.querySelectorAll<HTMLElement>('[data-row-details]')]
const openControl = (title: string) => row(title).querySelector<HTMLButtonElement>('[data-row-open]')!
const focused = () => (document.activeElement ?? document.body) as HTMLElement

async function today(...titles: string[]) {
  const ids: string[] = []
  for (const title of titles) ids.push(await createTask({ title, due: { date: logicalToday() } }))
  const r = await render(<main><TaskListView route={{ view: 'today' }} /></main>)
  await waitFor(() => document.querySelectorAll('li[data-task-id]').length === titles.length, 'the rows')
  await flush(20)
  return { ids, r }
}

describe('expanded rows', () => {
  it('→ shows the details under the selected row and ← hides them; focus stays on the row', async () => {
    const { ids, r } = await today('Pay rent')
    await act(async () => { await updateTask(ids[0], { description: 'Transfer **850** to the landlord', priority: 2, estimate_minutes: 20 }) })
    await key(document.body, 'j')
    await waitFor(() => focused().matches('[data-row-open]'), 'focus on the row')
    expect(openControl('Pay rent').getAttribute('aria-expanded')).toBe('false')
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details')
    const d = details()[0]
    const group = document.getElementById(openControl('Pay rent').getAttribute('aria-controls') ?? '')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe('Details of Pay rent')
    expect(group.contains(d)).toBe(true)
    expect(d.querySelector('[data-row-notes]')?.textContent).toContain('850')
    expect(d.querySelector('[data-facet="how"]')?.textContent).toContain('P2')
    expect(d.querySelector('[data-facet="how"]')?.textContent).toContain('20m')
    expect(d.querySelector('[data-row-details-open]')?.textContent).toBe('Open task')
    expect(openControl('Pay rent').getAttribute('aria-expanded')).toBe('true')
    expect(focused()).toBe(openControl('Pay rent'))
    // The facts are read here, never edited: no fact is a button.
    expect(d.querySelectorAll('[data-row-facts] button').length).toBe(0)
    await key(focused(), 'ArrowLeft')
    await waitFor(() => details().length === 0, 'the details hidden')
    expect(row('Pay rent').getAttribute('aria-current')).toBe('true')
    expect(openedTask()).toBeNull()
    await r.unmount()
  })

  it('Esc hides the details before it clears the selection', async () => {
    const { r } = await today('Water the plants')
    await key(document.body, 'j')
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details')
    await key(focused(), 'Escape')
    await waitFor(() => details().length === 0, 'the details hidden')
    expect(row('Water the plants').getAttribute('aria-current')).toBe('true')
    await key(focused(), 'Escape')
    await waitFor(() => !row('Water the plants').hasAttribute('aria-current'), 'the selection cleared')
    await r.unmount()
  })

  it('one row at a time: expanding another row hides the first; moving the cursor does not', async () => {
    const { r } = await today('First', 'Second')
    await key(document.body, 'j')
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details')
    const first = details()[0].getAttribute('data-row-details')
    await key(focused(), 'j')
    await flush(20)
    expect(details().map((d) => d.getAttribute('data-row-details'))).toEqual([first])
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1 && details()[0].getAttribute('data-row-details') !== first, 'the second row expanded')
    await r.unmount()
  })

  it('ticks a subtask in place and leaves the rest of the task alone', async () => {
    const { ids, r } = await today('Pack for the trip')
    let sub = ''
    await act(async () => { sub = await createSubtask(ids[0], 'Passport') })
    await key(document.body, 'j')
    await key(focused(), 'ArrowRight')
    await waitFor(() => !!details()[0]?.querySelector('[data-subtasks]'), 'the subtasks')
    const box = details()[0].querySelector<HTMLButtonElement>('[aria-label="Complete Passport"]')!
    expect(details()[0].querySelector('[data-add-subtask]')).toBeNull()
    await click(box)
    await waitFor(async () => !!(await db.tasks.get(sub))?.completed_at, 'the subtask completed')
    expect((await db.tasks.get(ids[0]))?.completed_at).toBeFalsy()
    expect(openedTask()).toBeNull()
    await r.unmount()
  })

  it('in a project tree, → unfolds folded subtasks first and the details leave the shown subtasks out', async () => {
    const pid = await createProject({ name: 'Home' })
    const parent = await createTask({ title: 'Paint the hall', project_id: pid })
    await createSubtask(parent, 'Buy paint')
    const r = await render(<main><TaskListView route={{ view: 'project', id: pid }} /></main>)
    await waitFor(() => !!document.querySelector('li[data-task-id]'), 'the rows')
    await flush(20)
    // Fold the subtasks with ←, then → unfolds them before it shows the details.
    await key(document.body, 'j')
    await key(focused(), 'ArrowLeft')
    await waitFor(() => !row('Buy paint'), 'the subtasks folded')
    await key(focused(), 'ArrowRight')
    await waitFor(() => !!row('Buy paint'), 'the subtasks unfolded')
    expect(details().length).toBe(0)
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details')
    expect(details()[0].querySelector('[data-subtasks]')).toBeNull()
    // ← hides the details first, then folds the subtasks.
    await key(focused(), 'ArrowLeft')
    await waitFor(() => details().length === 0, 'the details hidden')
    expect(row('Buy paint')).toBeTruthy()
    await r.unmount()
  })

  it('on a touch phone the row ends with a disclosure that toggles the details without opening the task', async () => {
    viewport(360, true)
    const { r } = await today('Call the plumber')
    const button = row('Call the plumber').querySelector<HTMLButtonElement>('[data-row-expand] button')!
    expect(button.getAttribute('aria-label')).toBe('Show details')
    expect(button.className).toContain('touch-target')
    await click(button)
    await waitFor(() => details().length === 1, 'the details')
    expect(openedTask()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe('Hide details')
    // A press inside the details never opens the task.
    await click(details()[0])
    expect(openedTask()).toBeNull()
    await click(button)
    await waitFor(() => details().length === 0, 'the details hidden')
    await r.unmount()
  })

  it('the revealed actions start with Show details on a fine pointer', async () => {
    const { r } = await today('Book the dentist')
    const actions = [...row('Book the dentist').querySelectorAll<HTMLElement>('[data-row-action]')].map((b) => b.getAttribute('data-row-action'))
    expect(actions).toEqual(['details', 'schedule', 'priority', 'more'])
    const show = row('Book the dentist').querySelector<HTMLButtonElement>('[data-row-action="details"]')!
    expect(show.getAttribute('aria-label')).toBe('Show details')
    await click(show)
    await waitFor(() => details().length === 1, 'the details')
    expect(row('Book the dentist').querySelector('[data-row-action="details"]')!.getAttribute('aria-label')).toBe('Hide details')
    // Open task opens it, as Enter does.
    await click(details()[0].querySelector('[data-row-details-open]')!)
    await waitFor(() => openedTask() !== null, 'the task opened')
    await r.unmount()
  })

  it('is not remembered: a new list starts with every row closed, and nothing is stored', async () => {
    const { r } = await today('Renew the passport')
    const before = await db.outbox.count()
    await key(document.body, 'j')
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details')
    expect(await db.outbox.count()).toBe(before)
    expect(Object.keys(localStorage).filter((k) => /expand|detail/i.test(k))).toEqual([])
    await r.unmount()
    const again = await render(<main><TaskListView route={{ view: 'today' }} /></main>)
    await waitFor(() => !!document.querySelector('li[data-task-id]'), 'the row')
    await flush(20)
    expect(details().length).toBe(0)
    await again.unmount()
  })

  it('a board card does not expand', async () => {
    const pid = await createProject({ name: 'Garden' })
    await createTask({ title: 'Plant tulips', project_id: pid })
    await saveViewMode(pid, 'board')
    const r = await render(<main><TaskListView route={{ view: 'project', id: pid }} /></main>)
    await waitFor(() => !!document.querySelector('li[data-task-id]'), 'the card')
    await flush(20)
    expect(document.querySelector('[data-row-expand]')).toBeNull()
    expect(document.querySelector('[data-row-action="details"]')).toBeNull()
    await key(document.body, 'j')
    await key(focused(), 'ArrowRight')
    await flush(50)
    expect(details().length).toBe(0)
    await r.unmount()
  })
})

describe('expanded rows in a saved view', () => {
  it('→ and ← open and close the selected row; Esc closes it before the selection', async () => {
    await createTask({ title: 'Order the tiles', description: 'Ask for samples first.' })
    await createTask({ title: 'Measure the hall' })
    const view = await createView({ name: 'Everything', query: 'no date' })
    const r = await render(<SavedViewRoute id={view} />)
    await waitFor(() => document.querySelectorAll('li[data-task-id]').length === 2, 'the rows')
    await flush(20)
    await key(document.body, 'j')
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details')
    await key(focused(), 'ArrowLeft')
    await waitFor(() => details().length === 0, 'the details hidden')
    await key(focused(), 'ArrowRight')
    await waitFor(() => details().length === 1, 'the details again')
    await key(focused(), 'Escape')
    await waitFor(() => details().length === 0, 'Esc hides them')
    expect(document.querySelector('li[data-task-id][aria-current]')).toBeTruthy()
    await r.unmount()
  })
})

describe('shownParts', () => {
  it('keeps set values only and leaves out the default priority', () => {
    expect(shownParts([
      { id: 'priority', text: 'P4' },
      { id: 'estimate', text: 'Estimate', empty: true },
      { id: 'labels', text: 'home', labels: [] },
    ]).map((p) => p.id)).toEqual(['labels'])
    expect(shownParts([{ id: 'priority', text: 'P1' }]).map((p) => p.id)).toEqual(['priority'])
  })
})
