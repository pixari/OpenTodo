// End-to-end check of saved views (OpenSpec change `custom-views`) against a running
// server with a FRESH data directory: saving from New view, editing, grouping
// and sort, sidebar order and counts, unpin and the g v overview, dashboards (Tab
// between panels, live counts, removed-view placeholder, stacking), the per-device
// start view with its fallback, and two devices converging on a view edited offline.
// See scripts/README.md.
// Resolve Playwright locally (npm i / npx -p) or from a global install (npm i -g playwright).
const { chromium } = await import('playwright').catch(async () => {
  const { createRequire } = await import('node:module')
  const { execSync } = await import('node:child_process')
  return createRequire(execSync('npm root -g').toString().trim() + '/')('playwright')
})

const base = process.env.OPENTODO_URL ?? 'http://127.0.0.1:8080'
const shots = process.argv[2] ?? null
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const errors = []
const step = (s) => console.log('·', s)
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}` }) }
const assert = (c, msg) => { if (!c) throw new Error('ASSERT: ' + msg) }

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const now = new Date()
const TODAY = iso(now)
const TOMORROW = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
const YESTERDAY = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
const LATER = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 9))

async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  // The Views group starts folded on a new device (sidebar-favourites, quiet-sidebar): open it, as a device that stored it.
  await ctx.addInitScript(() => { try { if (localStorage.getItem('ot.sidebar.group.filters') === null) localStorage.setItem('ot.sidebar.group.filters', '1') } catch { /* no storage */ } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text())) errors.push(`${name} console: ${m.text()}`) })
  page.on('dialog', (d) => d.accept())
  return { ctx, page }
}

const A = await device('A')
const api = A.ctx.request
let r = await api.post(`${base}/api/v1/auth/register`, { data: { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery staple' } })
assert(r.status() === 201, 'register ' + r.status())
const post = async (path, data) => { const res = await api.post(`${base}/api/v1/${path}`, { data }); assert(res.ok(), `${path} ${res.status()} ${await res.text()}`); return res.json() }
const get = async (path) => (await api.get(`${base}/api/v1/${path}`)).json()

step('seed labels, projects and tasks through the API')
const work = (await post('labels', { name: 'work' })).id
const waiting = (await post('labels', { name: 'waiting' })).id
const errand = (await post('labels', { name: 'errand' })).id
const pWork = (await post('projects', { name: 'Work' })).id
const effortField = (await post('fields', { name: 'Effort', type: 'number', project_id: pWork })).id
const seed = [
  { title: 'Overdue report', priority: 1, due: { date: YESTERDAY }, labels: [work], project_id: pWork, fields: { [effortField]: 9 } },
  { title: 'Ship release', priority: 1, due: { date: TODAY }, labels: [work], project_id: pWork, fields: { [effortField]: 2 } },
  { title: 'Review PR', priority: 3, due: { date: TODAY }, labels: [work] },
  { title: 'Plan sprint', priority: 1, due: { date: TOMORROW }, labels: [work, waiting], project_id: pWork, fields: { [effortField]: 4 } },
  { title: 'Prepare demo', priority: 1, due: { date: TOMORROW }, labels: [work] },
  { title: 'Quarterly goals', priority: 1, due: { date: LATER }, labels: [work] },
  { title: 'Hear back from landlord', priority: 4, labels: [waiting] },
  { title: 'Buy stamps', priority: 2, due: { date: TODAY }, labels: [errand] },
  { title: 'Pick up parcel', priority: 1, due: { date: TODAY }, labels: [errand] },
]
for (const t of seed) await post('tasks', t)

const pageA = A.page
// The display panel (views-and-display): opened from the toolbar, kept open while options change.
const display = async (p) => {
  if (!(await p.locator('[data-display-panel]').count())) await p.getByRole('button', { name: 'Display options' }).click()
  return p.locator('[data-display-panel]')
}
const closeDisplay = async (p) => { if (await p.locator('[data-display-panel]').count()) await p.keyboard.press('Escape') }
await pageA.goto(base)
await pageA.getByText('Hear back from landlord').waitFor()

step('New view: run a query, press s, save "Work tomorrow" from the header card')
// The Inbox opens with quick add focused: leave the field so g f is a shortcut, not text.
await pageA.getByRole('combobox', { name: 'Add a task' }).blur()
await pageA.keyboard.press('g'); await pageA.keyboard.press('f')
const q = pageA.getByLabel('Filter query')
await q.fill('@work & due <= tomorrow & p1')
await q.press('Enter')
await pageA.getByText('Plan sprint').waitFor()
const filterCount = await pageA.locator('[data-page-meta]').first().textContent()
assert(filterCount === '4', 'filter count ' + filterCount)
await pageA.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Filter results')
await pageA.keyboard.press('s')
await pageA.getByLabel('View name').fill('Work tomorrow')
await pageA.getByLabel('View name').press('Enter')
await pageA.getByRole('heading', { name: 'Work tomorrow' }).waitFor()
const sidebarViews = pageA.getByRole('navigation', { name: 'Views' })
await sidebarViews.getByText('Work tomorrow').waitFor()
// The count renders before the view has evaluated; give it a moment to settle.
await pageA.waitForFunction(() => document.querySelector('[data-page-meta]')?.textContent === '4', null, { timeout: 5000 }).catch(() => undefined)
const viewCount = await pageA.locator('[data-page-meta]').first().textContent()
assert(viewCount === '4', 'view result count ' + viewCount)
// A filter row shows no number (quiet-sidebar): its name and data-open-count, the count read by assistive technology.
await pageA.waitForFunction(() => [...document.querySelectorAll('nav[aria-label="Views"] button[data-view-id]')].some((b) => (b.querySelector('.truncate')?.textContent ?? '') + (b.querySelector('[data-open-count]')?.getAttribute('data-open-count') ?? '') === 'Work tomorrow4'))

step('Sort a saved view by a custom field ID and keep its decrypted name local')
const effortSort = `field:${effortField}`
const displayPanel = await display(pageA)
await displayPanel.getByLabel('Group by').selectOption('none')
await displayPanel.getByLabel('Order by').selectOption(effortSort)
await pageA.waitForFunction(() => {
  const titles = [...document.querySelectorAll('[aria-label="View results"] [data-task-id] [data-row-title]')].map((el) => el.textContent?.trim())
  return JSON.stringify(titles) === JSON.stringify(['Ship release', 'Plan sprint', 'Overdue report', 'Prepare demo'])
})
assert(await displayPanel.locator(`option[value="${effortSort}"]`).textContent() === 'Effort', 'the UI resolves the local custom-field name')
assert(await displayPanel.getByLabel('Order by').inputValue() === effortSort, 'the selector keeps the definition ID')
let fieldSortedViews = (await get('views')).views
for (let i = 0; i < 20 && fieldSortedViews.find((view) => view.name === 'Work tomorrow')?.sort_by !== effortSort; i++) {
  await pageA.waitForTimeout(250); fieldSortedViews = (await get('views')).views
}
const fieldSortedView = fieldSortedViews.find((view) => view.name === 'Work tomorrow')
assert(fieldSortedView?.sort_by === effortSort, 'the REST view stores field:<definition-id>')
const fieldSortSync = await post('sync', { device: 'browser-privacy-check', cursor: 0 })
const fieldSortOps = fieldSortSync.ops.filter((op) => op.entity === 'view' && op.field === 'sort_by' && op.value === effortSort)
assert(fieldSortOps.length > 0, 'the sync operation carries the definition ID')
assert(!JSON.stringify(fieldSortOps).includes('Effort'), 'the sync operation does not carry the decrypted field name')
await closeDisplay(pageA)

await shot(pageA, 'views-saved.png')

step('Edit a saved query: / then add "& !@waiting", Enter')
await pageA.locator('body').click({ position: { x: 900, y: 700 } })
await pageA.keyboard.press('/')
const vq = pageA.getByLabel('View query')
// The filter panel opens (closed by default on a saved view) with focus in the query.
await pageA.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View query')
await vq.press('End')
await vq.type(' & !@waiting')
await vq.press('Enter')
await pageA.waitForFunction(() => document.querySelector('[data-page-meta]')?.textContent === '3')
assert(!(await pageA.getByText('Plan sprint').isVisible()), 'Plan sprint filtered out')
let serverViews = (await get('views')).views
for (let i = 0; i < 20 && serverViews[0]?.query !== '@work & due <= tomorrow & p1 & !@waiting'; i++) {
  await pageA.waitForTimeout(250); serverViews = (await get('views')).views
}
assert(serverViews[0].query === '@work & due <= tomorrow & p1 & !@waiting', 'query synced to server: ' + serverViews[0]?.query)
const workId = serverViews[0].id

step('Invalid query edit shows the parse error and keeps the saved query')
await vq.fill('@work p1')
await vq.press('Enter')
await pageA.getByRole('alert').filter({ hasText: 'Expected "&" or "|" before "p1" at position 7' }).waitFor()
await vq.press('Escape')
assert((await vq.inputValue()) === '@work & due <= tomorrow & p1 & !@waiting', 'Esc restores the query')

step('Group by due date: Earlier, Today, Tomorrow headings in order; sort by priority descending')
await (await display(pageA)).getByLabel('Group by').selectOption('due')
await pageA.getByRole('heading', { name: 'Earlier', level: 2 }).waitFor()
const headings = await pageA.locator('[aria-label="View results"] [data-group-label]').allTextContents()
assert(JSON.stringify(headings) === JSON.stringify(['Earlier', 'Today', 'Tomorrow']), 'headings ' + headings)
await (await display(pageA)).getByLabel('Order by').selectOption('priority')
await (await display(pageA)).getByRole('button', { name: 'More options' }).click()
await (await display(pageA)).getByLabel('Sort direction').selectOption('desc')
// keyboard reachability: the display button opens its panel with focus inside it
await closeDisplay(pageA)
await pageA.getByRole('button', { name: 'Display options' }).focus()
await pageA.keyboard.press('Enter')
await pageA.waitForFunction(() => !!document.activeElement?.closest('[data-display-panel]'))
await shot(pageA, 'views-grouped.png')

step('Save a second view "Waiting" and move it first in the sidebar')
await pageA.keyboard.press('Escape')
await pageA.locator('body').click({ position: { x: 900, y: 700 } })
await pageA.keyboard.press('g'); await pageA.keyboard.press('f')
await pageA.getByLabel('Filter query').fill('@waiting')
await pageA.getByLabel('Filter query').press('Enter')
await pageA.getByText('Hear back from landlord').waitFor()
await pageA.getByRole('button', { name: 'Save as view' }).click()
await pageA.getByLabel('View name').fill('Waiting')
await pageA.getByLabel('View name').press('Enter')
await pageA.getByRole('heading', { name: 'Waiting' }).waitFor()
await sidebarViews.getByLabel('Menu for view Waiting').click()
await pageA.locator('[data-overlay]').getByRole('menuitem', { name: 'Move up' }).click() // menus open in the overlay layer
await pageA.waitForFunction(() => {
  const t = [...document.querySelectorAll('nav[aria-label="Views"] button[data-view-id]')].map((b) => (b.querySelector('.truncate')?.textContent ?? '') + (b.querySelector('[data-open-count]')?.getAttribute('data-open-count') ?? ''))
  return t[0] === 'Waiting2' && t[1] === 'Work tomorrow3'
})
await shot(pageA, 'views-sidebar-order.png')

step('Device B signs in and sees the same order and counts after sync')
const B = await device('B')
const pageB = B.page
r = await B.ctx.request.post(`${base}/api/v1/auth/login`, { data: { email: 'ada@example.com', password: 'correct horse battery staple' } })
assert(r.ok(), 'login B')
await pageB.goto(base)
const sidebarB = pageB.getByRole('navigation', { name: 'Views' })
await pageB.waitForFunction(() => {
  const t = [...document.querySelectorAll('nav[aria-label="Views"] button[data-view-id]')].map((b) => (b.querySelector('.truncate')?.textContent ?? '') + (b.querySelector('[data-open-count]')?.getAttribute('data-open-count') ?? ''))
  return t[0] === 'Waiting2' && t[1] === 'Work tomorrow3'
}, null, { timeout: 15000 })
// The edited query arrived on B too.
await sidebarB.getByText('Work tomorrow').click()
await pageB.locator('[data-filter-toggle]').click()
assert((await pageB.getByLabel('View query').inputValue()) === '@work & due <= tomorrow & p1 & !@waiting', 'B sees edited query')
assert((await (await display(pageB)).getByLabel('Group by').inputValue()) === 'due', 'B sees grouping')
await closeDisplay(pageB)

step('Unpin "Waiting": leaves Favourites, still in Views and the g v overview')
await sidebarViews.getByLabel('Menu for view Waiting').click()
await pageA.locator('[data-overlay]').getByRole('menuitemcheckbox', { name: 'Pin to sidebar' }).click()
await pageA.getByRole('navigation', { name: 'Favourites' }).getByText('Waiting').waitFor({ state: 'detached' })
await sidebarViews.getByText('Waiting').waitFor()
await pageA.locator('body').click({ position: { x: 900, y: 700 } })
await pageA.keyboard.press('g'); await pageA.keyboard.press('v')
await pageA.getByRole('heading', { name: 'Views', level: 1 }).waitFor()
// The overview lists every saved view; an unpinned one offers Pin.
const notPinned = pageA.locator('li', { has: pageA.getByRole('button', { name: 'Pin Waiting' }) })
await notPinned.getByText('Waiting', { exact: true }).waitFor()
await shot(pageA, 'views-overview.png')
await pageB.waitForFunction(() => ![...document.querySelectorAll('nav[aria-label="Favourites"] [data-favourite^="view:"]')].some((b) => b.textContent?.includes('Waiting')), null, { timeout: 15000 })
await notPinned.getByRole('button', { name: 'Pin Waiting' }).click()

step('Morning review dashboard with three panels')
const mk = async (name, query) => { await post('views', { name, query, pinned: false }) }
await mk('Today p1', 'today & p1')
await mk('Errands', '@errand')
await pageA.getByRole('button', { name: 'New board' }).click()
// The chooser (rule-boards): Empty board is preselected.
await pageA.locator('[data-board-choice="empty"] input').check()
await pageA.getByRole('button', { name: 'Next' }).click()
await pageA.getByLabel('Board name').fill('Morning')
await pageA.getByLabel('Board name').press('Enter')
await pageA.getByRole('heading', { name: 'Morning' }).waitFor()
for (const n of ['Today p1', 'Waiting', 'Errands']) {
  await pageA.getByLabel('Add panel').selectOption({ label: n })
  await pageA.locator(`section[aria-label="${n}"]`).waitFor()
}
// The visible count; the full phrase beside it is for screen readers (assistive-tech-semantics).
const panelText = async (n) => pageA.locator(`section[aria-label="${n}"] h2 + span [aria-hidden="true"]`).textContent()
assert(await panelText('Today p1') === '2', 'Today p1 count ' + await panelText('Today p1'))
assert(await panelText('Waiting') === '2', 'Waiting count')
assert(await panelText('Errands') === '2', 'Errands count')
await pageA.locator('section[aria-label="Errands"]').getByText('Pick up parcel').waitFor()
step('Tab / Shift+Tab move between panels, j/k inside one')
await pageA.locator('body').click({ position: { x: 1200, y: 830 } })
await pageA.keyboard.press('Tab')
const focusedPanel = () => pageA.evaluate(() => document.activeElement?.getAttribute('aria-label'))
assert(await focusedPanel() === 'Today p1', 'Tab → first panel, got ' + await focusedPanel())
await pageA.keyboard.press('Tab')
assert(await focusedPanel() === 'Waiting', 'Tab → second panel')
await pageA.keyboard.press('Shift+Tab')
assert(await focusedPanel() === 'Today p1', 'Shift+Tab → first panel')
await pageA.keyboard.press('j')
await pageA.locator('section[aria-label="Today p1"] li[aria-current]').waitFor()
step('Live update: completing a task through the API updates the panel')
const tasks = (await get('tasks')).tasks
const parcel = tasks.find((t) => t.title === 'Pick up parcel')
await api.patch(`${base}/api/v1/tasks/${parcel.id}`, { data: { completed_at: Date.now() } })
await pageA.waitForFunction(() => document.querySelector('section[aria-label="Errands"] h2 + span [aria-hidden="true"]')?.textContent === '1', null, { timeout: 15000 })
await shot(pageA, 'views-dashboard.png')
const dashId = (await get('views')).views.find((v) => v.name === 'Morning').id
await pageB.goto(`${base}/views/${dashId}`)
await pageB.locator('section[aria-label="Errands"]').waitFor({ timeout: 15000 })

step('Panel view deleted: placeholder with a remove action, other panels keep working')
const errandsId = (await get('views')).views.find((v) => v.name === 'Errands').id
await api.delete(`${base}/api/v1/views/${errandsId}`)
await pageA.getByText('View removed').waitFor({ timeout: 15000 })
assert(await panelText('Waiting') === '2', 'other panels still work')
await shot(pageA, 'views-panel-removed.png')
await pageA.getByRole('button', { name: 'Remove panel' }).click()
await pageA.getByText('View removed').waitFor({ state: 'detached' })

step('Narrow screen: panels stack')
await pageA.setViewportSize({ width: 380, height: 800 })
await pageA.waitForTimeout(400) // let the sidebar transition finish
const xs = await pageA.locator('section[data-panel-index]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
assert(new Set(xs).size === 1, 'stacked panels ' + xs)
await shot(pageA, 'views-dashboard-mobile.png')
await pageA.setViewportSize({ width: 1280, height: 860 })

step('Start view per device: A starts on "Work tomorrow", B keeps the Inbox')
await pageA.goto(`${base}/settings/general/start`)
await pageA.getByLabel('Start view on this device').selectOption({ label: 'Work tomorrow' })
await pageA.waitForTimeout(200)
await pageA.goto(base)
await pageA.waitForURL(`**/views/${workId}`)
await pageA.getByRole('heading', { name: 'Work tomorrow' }).waitFor()
await pageB.goto(base)
await pageB.waitForTimeout(800)
assert(new URL(pageB.url()).pathname === '/', 'B stays on the Inbox: ' + pageB.url())
await pageB.getByRole('combobox', { name: 'Add a task' }).waitFor()
step('B sets its own start view from a view menu')
await pageB.getByRole('navigation', { name: 'Views' }).getByLabel('Menu for view Morning').click()
await pageB.getByRole('menuitemcheckbox', { name: 'Start view on this device' }).click()
await pageB.waitForTimeout(200) // the preference is written to IndexedDB asynchronously
await pageB.goto(base)
await pageB.waitForURL(`**/views/${dashId}`)
await pageA.goto(base)
await pageA.waitForURL(`**/views/${workId}`)

step('Deleted start view: B deletes "Work tomorrow"; A syncs, relaunches on the Inbox with a notice')
await pageB.getByRole('navigation', { name: 'Views' }).getByLabel('Menu for view Work tomorrow').click()
await pageB.getByRole('menuitem', { name: 'Delete view…' }).click()
// Deleting asks first (labels-and-menus): confirm in the alert dialog.
await pageB.getByRole('alertdialog').getByRole('button', { name: 'Delete view' }).click()
await pageA.getByText('This view does not exist').waitFor({ timeout: 15000 })
await pageA.goto(base)
await pageA.getByRole('status').filter({ hasText: 'start view was deleted' }).waitFor()
assert(new URL(pageA.url()).pathname === '/', 'A fell back to the Inbox')
await shot(pageA, 'views-start-fallback.png')

step('Two devices offline: A saves and pins a view offline, B sees it after A reconnects')
await pageA.getByRole('button', { name: 'Dismiss' }).click()
await A.ctx.setOffline(true)
await pageA.keyboard.press('g'); await pageA.keyboard.press('f')
await pageA.getByLabel('Filter query').fill('@work & p1')
await pageA.getByLabel('Filter query').press('Enter')
await pageA.getByText('Quarterly goals').waitFor()
await pageA.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Filter results')
await pageA.keyboard.press('s')
await pageA.getByLabel('View name').fill('Work p1')
await pageA.getByLabel('View name').press('Enter')
await pageA.getByRole('heading', { name: 'Work p1' }).waitFor()
await sidebarViews.getByText('Work p1').waitFor()
await pageA.waitForTimeout(500)
assert(!(await get('views')).views.some((v) => v.name === 'Work p1'), 'not on server while offline')
await A.ctx.setOffline(false)
await pageB.getByRole('navigation', { name: 'Views' }).getByText('Work p1').waitFor({ timeout: 20000 })
const wp1 = (await get('views')).views.find((v) => v.name === 'Work p1').id

step('Both offline: A changes sort and grouping, B later changes grouping; reconnect and converge')
await pageB.goto(`${base}/views/${wp1}`)
await pageB.getByRole('heading', { name: 'Work p1' }).waitFor()
await pageA.goto(`${base}/views/${wp1}`)
await pageA.getByRole('heading', { name: 'Work p1' }).waitFor()
await A.ctx.setOffline(true)
await B.ctx.setOffline(true)
await (await display(pageA)).getByLabel('Group by').selectOption('priority')
await (await display(pageA)).getByLabel('Order by').selectOption('title')
await pageA.waitForTimeout(50)
await (await display(pageB)).getByLabel('Group by').selectOption('due')
await pageA.waitForTimeout(300)
await A.ctx.setOffline(false)
await B.ctx.setOffline(false)
const converged = async (p) => p.waitForFunction(() => {
  const g = document.querySelector('select[aria-label="Group by"]')?.value
  const s = document.querySelector('select[aria-label="Order by"]')?.value
  return g === 'due' && s === 'title'
}, null, { timeout: 30000 })
await converged(pageA)
await converged(pageB)
const sideCounts = (p) => p.evaluate(() => [...document.querySelectorAll('nav[aria-label="Views"] button[data-view-id]')].map((b) => (b.querySelector('.truncate')?.textContent ?? '') + (b.querySelector('[data-open-count]')?.getAttribute('data-open-count') ?? '')))
const ca = await sideCounts(pageA), cb = await sideCounts(pageB)
assert(JSON.stringify(ca) === JSON.stringify(cb), `identical sidebars ${ca} / ${cb}`)
const ha = await pageA.locator('[aria-label="View results"] [data-group-label]').allTextContents()
const hb = await pageB.locator('[aria-label="View results"] [data-group-label]').allTextContents()
assert(JSON.stringify(ha) === JSON.stringify(hb) && ha[0] === 'Earlier', `identical groups ${ha} / ${hb}`)
const sv = (await get('views')).views.find((v) => v.id === wp1)
assert(sv.group_by === 'due' && sv.sort_by === 'title', 'server converged ' + JSON.stringify(sv))
console.log('  A sidebar:', ca.join(' | '))
console.log('  B sidebar:', cb.join(' | '))
await shot(pageA, 'views-converged-A.png')
await shot(pageB, 'views-converged-B.png')

step('two page frames on one left edge; a project keeps its header still; opening a task moves nothing (page-rhythm, list-stays-still)')
// app-shell "Page template": Inbox, Today, Labels, Trash and Filter are standalone
// pages; a project's list, board and timeline share one layout frame. Both start at
// the column's left edge.
const frameEdges = () => pageA.evaluate(() => {
  const row = document.querySelector('[data-page-header-row]')
  const body = row?.closest('[data-page-body]')
  const column = document.getElementById('content')
  const content = body ? [...body.children].find((c) => !c.matches('[data-page-header]')) : null
  if (!row || !content || !column) return null
  const h = row.getBoundingClientRect(), b = body.getBoundingClientRect(), c = column.getBoundingClientRect()
  const actions = row.querySelector('[data-page-actions]')?.getBoundingClientRect()
  return {
    left: Math.round(h.left), actionsRight: Math.round(actions?.right ?? h.right), content: Math.round(content.getBoundingClientRect().left), contentRight: Math.round(content.getBoundingClientRect().right),
    spaceLeft: b.left - c.left, spaceRight: c.left + column.clientWidth - b.right, frame: body.getAttribute('data-page-frame'),
  }
})
const layout = (name) => pageA.getByRole('group', { name: 'Project layout' }).getByRole('button', { name })
const settle = async () => { await pageA.locator('[data-page-header-row]').first().waitFor(); await pageA.waitForTimeout(400) }
await pageA.setViewportSize({ width: 1536, height: 900 })
const standalone = []
for (const path of ['/inbox', '/today', '/labels', '/trash', '/views/new']) {
  await pageA.goto(base + path); await settle()
  const e = await frameEdges()
  assert(e && e.frame === 'standalone', `${path}: a standalone frame at 1536 px (${e?.frame})`)
  assert(Math.abs(e.content - e.left) <= 1, `${path}: content starts at ${e.content}, title at ${e.left}`)
  standalone.push([path, e])
}
for (const [path, e] of standalone) assert(Math.abs(e.left - standalone[0][1].left) <= 1, `${path} title at ${e.left}, ${standalone[0][0]} at ${standalone[0][1].left}`)
console.log(`  1536 px: ${standalone.length} standalone pages on one left edge, title at ${standalone[0][1].left}`)
for (const width of [1280, 1440]) {
  await pageA.setViewportSize({ width, height: 900 })
  await pageA.goto(`${base}/project/${pWork}`)
  const seen = []
  for (const mode of ['List', 'Board', 'Timeline']) { await layout(mode).click(); await settle(); seen.push([mode, await frameEdges()]) }
  await layout('List').click()
  const [first] = seen
  for (const [mode, e] of seen) {
    assert(e.frame === 'layout', `project ${mode}: a layout frame (${e.frame})`)
    assert(Math.abs(e.left - first[1].left) <= 1 && Math.abs(e.actionsRight - first[1].actionsRight) <= 1, `project ${mode} header ${e.left}–${e.actionsRight} differs from List ${first[1].left}–${first[1].actionsRight} at ${width} px`)
    assert(Math.abs(e.content - e.left) <= 1, `project ${mode} content starts at ${e.content}, header at ${e.left} (${width} px)`)
  }
  console.log(`  ${width} px: project header ${first[1].left}–${first[1].actionsRight} in list, board and timeline`)
}
// Opening a task shows its page; Esc brings the list back with nothing moved
// (list-stays-still D1, task-full-page): the same first row and title position.
const rowAndTitle = () => pageA.evaluate(() => {
  const row = [...document.querySelectorAll('[data-task-id]')].map((r) => r.getBoundingClientRect()).find((r) => r.width > 0)
  const title = document.querySelector('[data-page-header-row]')?.getBoundingClientRect()
  return row && title ? { row: Math.round(row.left), title: Math.round(title.left) } : null
})
const openFirst = async () => {
  await pageA.keyboard.press('j'); await pageA.keyboard.press('Enter')
  await pageA.locator('[data-task-page]').waitFor(); await pageA.waitForTimeout(400)
}
const closeIt = async () => {
  await pageA.keyboard.press('Escape')
  await pageA.locator('[data-task-page]').waitFor({ state: 'detached' })
  await pageA.locator('[data-task-id][aria-current]').first().waitFor(); await pageA.waitForTimeout(400)
}
for (const width of [1280, 1440, 1920]) {
  await pageA.setViewportSize({ width, height: 860 })
  for (const path of ['/today', `/project/${pWork}`]) {
    await pageA.goto(base + path); await settle()
    // The project shows its list (the step above may have left it on the timeline).
    if (path.startsWith('/project')) { await layout('List').click(); await settle(); await pageA.evaluate(() => (document.activeElement)?.blur()) }
    await pageA.locator('[data-task-id]:visible').first().waitFor()
    const closed = await rowAndTitle()
    await openFirst()
    await closeIt()
    const again = await rowAndTitle()
    assert(again && Math.abs(again.row - closed.row) <= 1 && Math.abs(again.title - closed.title) <= 1,
      `${path} at ${width} px: returning from a task moved the first row ${closed.row} → ${again?.row}, the title ${closed.title} → ${again?.title}`)
  }
  console.log(`  ${width} px: returning from a task moves nothing on Today and a project`)
}
// On a wide screen too, every page starts at the column's left edge: Today, Labels and
// a project share one title edge, and the panel opens into the space on the right.
await pageA.setViewportSize({ width: 2560, height: 900 })
const edges = []
for (const path of ['/today', '/labels', `/project/${pWork}`]) { await pageA.goto(base + path); await settle(); edges.push([path, await frameEdges()]) }
for (const [path, e] of edges) assert(Math.abs(e.left - edges[0][1].left) <= 1, `2560 px: ${path} title at ${e.left}, /today at ${edges[0][1].left}`)
console.log(`  2560 px: Today, Labels and a project share the left edge ${edges[0][1].left}`)
// The header is as wide as the content under it (page-frame-v3 D1, D2): its actions end
// at the content's right edge on a list page, a project list and a project board.
for (const width of [1920, 2560]) {
  await pageA.setViewportSize({ width, height: 900 })
  const pages = [['/inbox', null], ['/today', null], [`/project/${pWork}`, 'List'], [`/project/${pWork}`, 'Board']]
  for (const [path, mode] of pages) {
    await pageA.goto(base + path); await settle()
    if (mode) { await layout(mode).click(); await settle() }
    const e = await frameEdges()
    assert(Math.abs(e.actionsRight - e.contentRight) <= 2, `${path}${mode ? ` (${mode})` : ''} at ${width} px: header actions end at ${e.actionsRight}, content at ${e.contentRight}`)
  }
  await pageA.goto(`${base}/project/${pWork}`); await settle(); await layout('List').click(); await settle()
  console.log(`  ${width} px: header actions end at the content's right edge on Inbox, Today and a project's list and board`)
}
await pageA.setViewportSize({ width: 1280, height: 860 })

step('Help lists the new shortcuts')
await pageA.locator('body').click({ position: { x: 900, y: 700 } })
await pageA.keyboard.press('?')
await pageA.getByText('Go to Views: saved views and boards').first().waitFor()

await browser.close()
if (errors.length) {
  console.log('ERRORS:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('OK: all saved-view flows passed')
