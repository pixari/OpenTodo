// @vitest-environment happy-dom
// Where the briefing's parts lead and hiding it (OpenSpec change briefing-links,
// tasks 2.1 and 2.3): late tasks ticked in Today, a full day opened in Upcoming,
// the replies' request, and the synced Hide briefing / Show briefing item.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, useDatabase } from '../lib/db'
import { setDateTime } from '../lib/dates'
import { createTask, resetDeviceId } from '../lib/ops'
import { click, flush, key, render, waitFor } from '../ui/test-utils'
import { BriefingSection } from './PreferencesPanels'
import { openNotifications } from './briefingLinks'
import { resetPanel } from './panel'
import { navigate } from './router'
import { notificationsOpen } from './signals'
import { TaskListView } from './TaskListView'

let n = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 22, 12, 0))
  useDatabase(`briefing-links-${Date.now()}-${n++}`)
  resetDeviceId()
  setDateTime({ date_format: 'day-month', time_format: '24h', week_start: 'mon' }, { order: 'MD', hour12: false, weekStart: 1 })
})
afterEach(() => {
  vi.useRealTimers()
  resetPanel()
  setDateTime({ date_format: 'system', time_format: 'system', week_start: 'system' })
  document.body.innerHTML = ''
})

const briefing = (el: Element) => el.querySelector('[data-page-briefing]')

describe('briefing links (2.1)', () => {
  it('"2 tasks are late" ticks exactly those tasks in Today and selects the first; nothing is written', async () => {
    const a = await createTask({ title: 'Renew the passport', due: { date: '2026-10-20' } })
    const b = await createTask({ title: 'Pay the invoice', due: { date: '2026-10-21' } })
    await createTask({ title: 'Write the report', due: { date: '2026-10-22' } })
    navigate({ view: 'today' })
    const r = await render(<TaskListView route={{ view: 'today' }} />)
    await waitFor(() => !!r.container.querySelector('[data-briefing-link="late"]'))
    const link = r.container.querySelector<HTMLAnchorElement>('[data-briefing-link="late"]')!
    expect(link.textContent).toBe('2 tasks are late')
    expect(link.getAttribute('href')).toBe('/today')
    expect(link.getAttribute('aria-label')).toBe('2 tasks are late, select them in Today')
    const outbox = await db.outbox.count()
    await click(link)
    await waitFor(() => r.container.querySelectorAll('[data-ticked]').length === 2)
    expect([...r.container.querySelectorAll('[data-ticked]')].map((e) => e.closest('[data-task-id]')!.getAttribute('data-task-id')).sort()).toEqual([a, b].sort())
    expect(await db.outbox.count()).toBe(outbox)
    // A selection, not a passing highlight (precision-polish-2): the bar offers its actions and Escape clears it.
    await waitFor(() => r.container.querySelector('[data-selection-bar] [role="status"]')?.textContent === '2 selected')
    expect(r.container.querySelector('[data-selection-bar]')!.textContent).toContain('Actions')
    await key(document.body, 'Escape')
    await waitFor(() => !r.container.querySelector('[data-selection-bar]') && r.container.querySelectorAll('[data-ticked]').length === 0)
    await r.unmount()
  })

  it('a full day opens Upcoming at that day', async () => {
    await createTask({ title: 'Today', due: { date: '2026-10-22' } })
    await createTask({ title: 'Workshop', due: { date: '2026-10-26' }, estimate_minutes: 480 })
    navigate({ view: 'today' })
    const r = await render(<TaskListView route={{ view: 'today' }} />)
    await waitFor(() => !!r.container.querySelector('[data-briefing-link="full"]'))
    const link = r.container.querySelector<HTMLAnchorElement>('[data-briefing-link="full"]')!
    expect(link.getAttribute('aria-label')).toBe('Monday is already full, open in Upcoming')
    await click(link)
    expect(location.pathname).toBe('/upcoming')
    await r.unmount()
  })

  it('replies that are not about one task ask for the notifications', async () => {
    const seen: string[] = []
    const off = notificationsOpen.subscribe((id) => seen.push(id))
    openNotifications()
    off()
    expect(seen).toEqual(['open'])
    notificationsOpen.take()
  })
})

describe('hide the briefing (2.3)', () => {
  it('Hide briefing in Today\'s menu keeps the title and date, writes one op, and Show briefing brings it back', async () => {
    await createTask({ title: 'Write the report', due: { date: '2026-10-22' } })
    navigate({ view: 'today' })
    const r = await render(<TaskListView route={{ view: 'today' }} />)
    await waitFor(() => !!briefing(r.container))
    const menu = () => r.container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!
    await click(menu())
    await waitFor(() => !!document.querySelector('[data-briefing-toggle]'))
    expect(document.querySelector('[data-briefing-toggle]')!.textContent).toContain('Hide briefing')
    await click(document.querySelector('[data-briefing-toggle]')!)
    await waitFor(() => !briefing(r.container))
    expect(r.container.querySelector('h1')!.textContent).toBe('Today')
    expect((await db.outbox.toArray()).filter((o) => o.entity === 'user_prefs').map((o) => [o.field, o.value])).toEqual([['briefing', 'hidden']])
    await flush()
    await click(menu())
    await waitFor(() => document.querySelector('[data-briefing-toggle]')?.textContent?.includes('Show briefing') === true)
    await click(document.querySelector('[data-briefing-toggle]')!)
    await waitFor(() => !!briefing(r.container))
    await r.unmount()
  })
})

describe('Settings → General → Briefing (precision-polish-2)', () => {
  it('the switch and the day pages\' menu are one synced preference', async () => {
    await createTask({ title: 'Write the report', due: { date: '2026-10-22' } })
    navigate({ view: 'today' })
    const r = await render(<><BriefingSection /><TaskListView route={{ view: 'today' }} /></>)
    const sw = () => r.container.querySelector<HTMLButtonElement>('#briefing-show-switch')!
    await waitFor(() => !!briefing(r.container))
    expect(sw().getAttribute('aria-checked')).toBe('true')
    await click(sw())
    await waitFor(() => !briefing(r.container) && sw().getAttribute('aria-checked') === 'false')
    expect((await db.outbox.toArray()).filter((o) => o.entity === 'user_prefs').map((o) => [o.field, o.value])).toEqual([['briefing', 'hidden']])
    await click(r.container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!)
    await waitFor(() => document.querySelector('[data-briefing-toggle]')?.textContent?.includes('Show briefing') === true)
    await click(document.querySelector('[data-briefing-toggle]')!)
    await waitFor(() => !!briefing(r.container) && sw().getAttribute('aria-checked') === 'true')
    await r.unmount()
  })
})
