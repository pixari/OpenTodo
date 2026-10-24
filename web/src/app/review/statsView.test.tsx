// @vitest-environment happy-dom
// The Statistics dashboard on screen (OpenSpec change stats-dashboard, tasks 1.3,
// 3.2, 4.1): tiles before the panels, the period chooser by keyboard, a stored
// period that no longer exists, empty panels as one line, the chart grids by
// keyboard with their tooltip, "Show as table", "keeps slipping", no request, axe.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../lib/db'
import { setDateTime } from '../../lib/dates'
import { createProject, createTask, resetDeviceId } from '../../lib/ops'
import { compute, periodFor, PERIOD_LABELS } from '../../lib/stats'
import type { ActivityEntry } from '../../lib/types'
import { click, flush, key, render } from '../../ui/test-utils'
import { resetPanel } from '../panel'
import { openedTask, resetTaskPage } from '../taskPage.testkit'
import { StatsContent, StatsView } from './StatsView'

const NOW = new Date(2026, 9, 14, 12, 0) // Wednesday 14 October 2026
const at = (d: number, h = 10, month = 9) => new Date(2026, month, d, h).getTime()

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(async () => {
  resetTaskPage()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await db.delete()
  await db.open()
  await db.meta.put({ key: 'userId', value: 'u1' })
  resetDeviceId()
  resetPanel()
  localStorage.clear()
  setDateTime({ date_format: 'day-month', time_format: '24h', week_start: 'mon' }, { order: 'DM', hour12: false, weekStart: 1 })
  fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  resetPanel()
})

async function waitFor(ok: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !ok(); t += 20) await flush(20)
  expect(ok()).toBe(true)
}
const tile = (root: ParentNode, k: string) => root.querySelector(`[data-tile="${k}"] [data-tile-value]`)?.textContent ?? ''

async function seedWeek(): Promise<string> {
  const work = await createProject({ name: 'Work' })
  for (const [title, day, due] of [['Report', 12, null], ['Slides', 13, 12], ['Call', 13, null], ['Old', 6, null]] as const) {
    const id = await createTask({ title, project_id: work, due: due ? { date: `2026-10-${due}` } : null })
    await db.tasks.update(id, { completed_at: at(day), created_at: at(1) })
  }
  await createTask({ title: 'Overdue', project_id: work, due: { date: '2026-10-12' } })
  return work
}

describe('Statistics dashboard', () => {
  it('tiles first, then the panels; Done equals the headline count, nothing is requested, and axe finds nothing', async () => {
    await seedWeek()
    const r = await render(<StatsView />)
    await waitFor(() => tile(r.container, 'done') === '3')
    const expected = compute({ tasks: await db.tasks.toArray(), projects: await db.projects.toArray(), shared: new Set(), me: 'u1', today: '2026-10-14' }, periodFor('this-week', '2026-10-14', 1), 1)
    expect(tile(r.container, 'done')).toBe(String(expected.completed))
    // One dated completion, Slides, done the day after its due day.
    expect(tile(r.container, 'on-time')).toBe('0 %')
    expect(tile(r.container, 'streak')).toBe('2 days')
    const tiles = r.container.querySelector('[data-testid="stats-tiles"]')!
    const panels = r.container.querySelector('[data-testid="stats-panels"]')!
    expect(tiles.compareDocumentPosition(panels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(r.container.textContent).toContain('Computed on this device')
    expect(fetchSpy).not.toHaveBeenCalled()
    const axe = (await import('axe-core')).default
    const res = await axe.run(r.container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
    expect(res.violations.map((v) => v.id)).toEqual([])
    await r.unmount()
  })

  it('Keyboard: the heading takes focus, the period chooser is the next stop, and the arrow keys change the period', async () => {
    await seedWeek()
    const r = await render(<StatsView />)
    await waitFor(() => tile(r.container, 'done') === '3')
    expect(document.activeElement).toBe(r.container.querySelector('h1'))
    const focusable = [...r.container.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((el) => el.tabIndex >= 0)
    expect(focusable[0].getAttribute('role')).toBe('radio')
    expect(focusable[0].getAttribute('aria-checked')).toBe('true')
    focusable[0].focus()
    await key(focusable[0], 'ArrowRight')
    const checked = () => r.container.querySelector('[role="radio"][aria-checked="true"]')!
    expect(checked().textContent).toBe(PERIOD_LABELS['this-month'])
    expect(document.activeElement).toBe(checked())
    await waitFor(() => tile(r.container, 'done') === '4')
    expect([...r.container.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['This week', 'This month', 'This quarter', 'This year', 'Last week'])
    await r.unmount()
  })

  it('Stored period no longer offered: "last 4 weeks" opens on this week and nothing is written', async () => {
    localStorage.setItem('ot.stats.period', '4-weeks')
    const r = await render(<StatsView />)
    await waitFor(() => !!r.container.querySelector('[role="radio"][aria-checked="true"]'))
    expect(r.container.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe('This week')
    expect(localStorage.getItem('ot.stats.period')).toBe('4-weeks')
    expect(await db.outbox.count()).toBe(0)
    await r.unmount()
  })

  it('Empty history: zeros and one line per panel instead of empty charts', async () => {
    const r = await render(<StatsContent tasks={[]} projects={[]} memberships={[]} me="u1" today="2026-10-14" weekStart={1} period="this-week" />)
    expect(tile(r.container, 'done')).toBe('0')
    expect(tile(r.container, 'on-time')).toBe('–')
    expect(r.container.querySelector('[data-tile="on-time"]')!.textContent).toContain('No due dates in this period')
    expect([...r.container.querySelectorAll('[data-empty]')].map((p) => p.getAttribute('data-panel'))).toEqual(['keeping-up', 'time', 'hours', 'estimates', 'slipping'])
    expect(r.container.querySelector('[data-line-chart]')).toBeNull()
    // The heatmap keeps its 53 weeks whatever the period.
    expect(r.container.querySelector('[data-panel="heatmap"] [data-heatmap]')).toBeTruthy()
    await r.unmount()
  })

  it('Surfaces: tiles are cards with the display figure; panels are flat, with no border or shadow class of their own (surfaces-v2)', async () => {
    const r = await render(<StatsContent tasks={[]} projects={[]} memberships={[]} me="u1" today="2026-10-14" weekStart={1} period="this-week" />)
    for (const tl of r.container.querySelectorAll('[data-tile]')) {
      expect(tl.className).toContain('surface-card')
      expect(tl.querySelector('[data-tile-value]')!.className).toMatch(/\btext-display\b.*\btabular-nums\b/)
    }
    const panels = [...r.container.querySelectorAll('[data-panel]')]
    expect(panels.length).toBe(6)
    for (const p of panels) {
      expect(p.className).toContain('ui-section-flat')
      expect(p.className).not.toMatch(/\b(rounded-card|shadow-\d|border-dashed|border-input|surface-card)\b/)
    }
    await r.unmount()
  })

  it('Phone: tiles wrap to two per row, panels stack in one column, the heatmap scrolls inside its figure', async () => {
    const r = await render(<StatsContent tasks={[]} projects={[]} memberships={[]} me="u1" today="2026-10-14" weekStart={1} period="this-week" />)
    const tiles = r.container.querySelector('[data-testid="stats-tiles"]')!.className
    expect(tiles).toMatch(/\bgrid-cols-1\b/)
    expect(tiles).toMatch(/min-\[21.25rem\]:grid-cols-2/)
    expect(tiles).toMatch(/\blg:grid-cols-4\b/)
    expect(r.container.querySelector('[data-testid="stats-panels"]')!.className).toMatch(/\bgrid-cols-1 .*lg:grid-cols-2/)
    const heatmap = r.container.querySelector('[data-heatmap]')!
    expect(heatmap.hasAttribute('data-scroll-x')).toBe(true)
    expect(heatmap.className).toMatch(/overflow-x-auto/)
    await r.unmount()
  })
})

describe('accessible charts', () => {
  it('Keyboard through the heatmap: two left arrows move two days back and the tooltip reads the day', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: 't', project_id: null, completed_at: at(12), created_at: at(1), deleted_at: null, due: null, series_id: null, assignee_id: null, estimate_minutes: null, labels: [] }))
    const r = await render(<StatsContent tasks={tasks as never} projects={[]} memberships={[]} me="u1" today="2026-10-14" weekStart={1} period="this-week" />)
    const grid = r.container.querySelector('[data-panel="heatmap"] [role="grid"]')!
    const active = () => grid.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')!
    expect(active().getAttribute('data-day')).toBe('2026-10-14')
    active().focus()
    await key(active(), 'ArrowLeft')
    await key(active(), 'ArrowLeft')
    expect(active().getAttribute('data-day')).toBe('2026-10-12')
    expect(document.activeElement).toBe(active())
    expect(r.container.querySelector('[data-panel="heatmap"] [data-chart-tooltip]')!.textContent).toBe('Mon 12 Oct: 5 completed')
    await key(active(), 'ArrowUp')
    expect(active().getAttribute('data-day')).toBe('2026-10-05')
    await r.unmount()
  })

  it('Screen reader: the heatmap has a summary, and "Show as table" exposes one row per month', async () => {
    const tasks = [12, 13].map((d, i) => ({ id: `t${i}`, title: 't', project_id: null, completed_at: at(d), created_at: at(1), deleted_at: null, due: null, series_id: null, assignee_id: null, estimate_minutes: null, labels: [] }))
    const r = await render(<StatsContent tasks={tasks as never} projects={[]} memberships={[]} me="u1" today="2026-10-14" weekStart={1} period="this-week" />)
    const fig = r.container.querySelector('[data-panel="heatmap"]')!
    const summary = fig.querySelector('[role="grid"]')!.getAttribute('aria-label')!
    expect(summary).toContain('2 completed in the last 53 weeks')
    expect(summary).toContain('current streak 2 days')
    const toggle = fig.querySelector<HTMLButtonElement>('[data-show-table]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(fig.querySelector('[data-chart-table]')!.className).toMatch(/\bhidden\b/)
    expect(fig.querySelector('[data-chart-table]')!.className).toMatch(/forced-colors:block/)
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = [...fig.querySelectorAll('[data-chart-table] tbody tr')]
    expect(rows).toHaveLength(13)
    const october = rows[rows.length - 1]
    expect(october.querySelector('th')!.textContent).toBe('October 2026')
    expect([...october.querySelectorAll('td')].slice(11, 14).map((c) => c.textContent)).toEqual(['1', '1', '0'])
    await r.unmount()
  })

  it('Colour not alone: completed and created differ by line style, and the legend names both', async () => {
    const tasks = [{ id: 'a', title: 'a', project_id: null, completed_at: at(13), created_at: at(12), deleted_at: null, due: null, series_id: null, assignee_id: null, estimate_minutes: null, labels: [] }]
    const r = await render(<StatsContent tasks={tasks as never} projects={[]} memberships={[]} me="u1" today="2026-10-14" weekStart={1} period="this-week" />)
    const fig = r.container.querySelector('[data-panel="keeping-up"]')!
    expect(fig.querySelector('[data-series="a"]')!.getAttribute('stroke-dasharray')).toBeNull()
    expect(fig.querySelector('[data-series="b"]')!.getAttribute('stroke-dasharray')).toBe('5 4')
    expect(fig.querySelector('[data-legend]')!.textContent).toBe('CompletedCreated')
    expect(fig.querySelector('[data-end-labels]')!.textContent).toContain('Completed 0')
    await r.unmount()
  })
})

describe('keeps slipping', () => {
  it('lists a task moved later three times on this device, says so, and opens the task', async () => {
    const id = await createTask({ title: 'Renew passport' })
    await db.tasks.update(id, { due: { date: '2026-10-22' } })
    const move = (n: number, from: string, to: string): ActivityEntry => ({ id: `op${n}`, actor: 'u1', entity: 'task', entityId: id, field: 'due', value: { date: to }, from: { date: from }, ts: at(n), device: 'd', projectKey: '', taskId: id })
    await db.activity.bulkPut([move(1, '2026-10-01', '2026-10-08'), move(8, '2026-10-08', '2026-10-15'), move(13, '2026-10-15', '2026-10-22')])
    const r = await render(<StatsView />)
    await waitFor(() => !!r.container.querySelector(`[data-slipping="${id}"]`))
    const panel = r.container.querySelector('[data-panel="slipping"]')!
    expect(panel.textContent).toContain("Based on this device's history")
    expect(panel.textContent).toContain('Inbox · moved 3 times')
    await click(panel.querySelector(`[data-slipping="${id}"]`)!)
    expect(openedTask()).toBe(id)
    expect(fetchSpy).not.toHaveBeenCalled()
    await r.unmount()
  })
})
