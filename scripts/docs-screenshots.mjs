// Captures the screenshots of the user guide (docs/images/*.webp) from the seeded
// demo data, in light and dark (OpenSpec change `user-documentation`, task 2.2).
//
//   make docs-screenshots            builds the app, then runs this script
//   node scripts/docs-screenshots.mjs [only,names]
//
// It starts two throwaway servers from bin/opentodo: a demo instance
// (OPENTODO_DEMO=true; one sandbox with the sample data, the banner hidden) for
// everyday screens, and a fresh ordinary instance for account, settings and
// sharing screens the demo switches off. Each shot is written as
// <name>-light.webp and <name>-dark.webp; shots marked `card` also get a small
// card-<name>-{light,dark}.webp for the docs landing page. WebP is encoded by
// Chromium itself (no image tools). Environment: CHROMIUM_PATH (optional),
// OPENTODO_BIN (default bin/opentodo).
const { chromium } = await import('playwright').catch(async () => {
  const { createRequire } = await import('node:module')
  const { execSync } = await import('node:child_process')
  return createRequire(execSync('npm root -g').toString().trim() + '/')('playwright')
})
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeLLM } from './fake-llm.mjs'

const OUT = 'docs/images'
let eisenhowerPath = null
const BIN = process.env.OPENTODO_BIN ?? 'bin/opentodo'
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null
const want = (name) => !only || only.has(name)
const DESKTOP = { width: 1200, height: 760 }
const PHONE = { width: 390, height: 780 }
const QUALITY = 0.72
const PASSWORD = 'correct horse battery staple'
mkdirSync(OUT, { recursive: true })

// ------------------------------------------------------------------ servers
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) }) })
const servers = []
async function startServer(env) {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'opentodo-docs-'))
  const base = `http://localhost:${port}`
  const proc = spawn(BIN, [], { env: { ...process.env, OPENTODO_ADDR: `127.0.0.1:${port}`, OPENTODO_DATA_DIR: dir, OPENTODO_BASE_URL: base, ...env }, stdio: 'ignore' })
  servers.push({ proc, dir })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return base } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server on ${base} did not start`)
}
function stopServers() {
  for (const s of servers) { s.proc.kill(); rmSync(s.dir, { recursive: true, force: true }) }
}
process.on('exit', stopServers)

const demoBase = await startServer({ OPENTODO_DEMO: 'true' })
const plainBase = only && [...only].every((n) => n.startsWith('assistant-')) ? null : await startServer({})
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})

// ------------------------------------------------------------------ encoder
const enc = await (await browser.newContext()).newPage()
// width > 0 makes a card thumbnail: a full desktop screen is cropped to the main
// column (right of the sidebar) at 16:10 so the text stays readable when small.
async function encode(png, width = 0) {
  const b64 = await enc.evaluate(async ([src, w, q]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode()
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight
    if (w && sw >= 1400) { sx = Math.round(sw * 0.215); sw = Math.round(sw * 0.62); sh = Math.min(sh, Math.round(sw * 10 / 16)) }
    const scale = w ? w / sw : 1
    const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale)
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height)
    return c.toDataURL('image/webp', q).split(',')[1]
  }, [png.toString('base64'), width, QUALITY])
  return Buffer.from(b64, 'base64')
}
let bytes = 0
async function save(name, theme, png, card) {
  const buf = await encode(png)
  writeFileSync(`${OUT}/${name}-${theme}.webp`, buf); bytes += buf.length
  if (card) { const c = await encode(png, 640); writeFileSync(`${OUT}/card-${name}-${theme}.webp`, c); bytes += c.length }
  console.log(`  ${name}-${theme}.webp ${(buf.length / 1024).toFixed(0)} KB`)
}

// ------------------------------------------------------------------ helpers
const HIDE = `[data-testid="demo-banner"]{display:none!important} *,*::before,*::after{caret-color:transparent!important;transition:none!important;animation:none!important}`
async function context(theme, opts = {}) {
  const c = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1.25, colorScheme: theme, timezoneId: 'UTC', locale: 'en-GB', ...opts })
  await c.addInitScript((css) => { addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s) }) }, HIDE)
  // A click on a title edits it in place (inline-task-editing); the scenes open the panel.
  await c.addInitScript(() => { try { localStorage.setItem('opentodo.rowClick', 'open'); localStorage.setItem('opentodo.swipe-cue', '1') } catch { /* no storage */ } })
  return c
}
const settle = (p, ms = 600) => p.waitForTimeout(ms)
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const row = (p, title) => p.getByRole('button', { name: new RegExp('^' + esc(title)) }).first()
const detail = (p) => p.locator('[data-detail-for]')
const sidebar = (p) => p.locator('aside').first()
async function go(p, base, path, ready) { await p.goto(base + path); if (ready) await ready(); await settle(p, 800) }
async function unfold(p, button) { if ((await button.getAttribute('aria-expanded')) === 'false') { await button.click(); await settle(p, 300) } }
async function openProject(p, name) {
  const link = sidebar(p).getByRole('button', { name: new RegExp('^' + esc(name) + '\\b') }).first()
  if (!(await link.isVisible())) for (const b of await sidebar(p).getByRole('button', { name: /^Expand / }).all()) await b.click()
  await link.click(); await p.getByRole('heading', { level: 1, name }).waitFor(); await settle(p)
}
async function openTask(p, title) { await row(p, title).click(); await detail(p).waitFor(); await settle(p, 500) }
/** Clip around one element, with padding, clamped to the viewport. */
async function clipOf(p, locator, pad = 12, extra = {}) {
  const b = await locator.boundingBox()
  const vp = p.viewportSize()
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad)
  return { x, y, width: Math.min(vp.width - x, b.width + 2 * pad + (extra.width ?? 0)), height: Math.min(vp.height - y, b.height + 2 * pad + (extra.height ?? 0)) }
}
// Scroll the detail panel so the element is near its top.
async function scrollPanelTo(p, locator, offset = 16) {
  await locator.evaluate((el, off) => {
    let sc = el.parentElement
    while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
    if (sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - off
  }, offset)
  await settle(p, 300)
}

// ------------------------------------------------------------------ demo sandbox
// One sandbox serves both themes (the demo allows five new sandboxes per hour).
async function demoState() {
  const c = await context('light'); const p = await c.newPage()
  await p.goto(demoBase)
  await p.getByRole('button', { name: /Try the demo/i }).click()
  await p.getByRole('combobox', { name: 'Add a task' }).waitFor({ timeout: 20000 })
  await settle(p, 1500)
  const state = await c.storageState(); await c.close(); return state
}

// ------------------------------------------------------------------ plain instance
async function plainSetup() {
  const c = await context('light'); const p = await c.newPage()
  await p.goto(plainBase)
  await p.getByText('Create the owner account').waitFor()
  const api = async (method, path, body, ctx = c) => {
    const r = await ctx.request.fetch(plainBase + path, { method, headers: { Origin: plainBase, 'Content-Type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) })
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`)
    const t = await r.text(); return t ? JSON.parse(t) : null
  }
  await p.getByLabel('Name').fill('Ada Lovelace'); await p.getByLabel('Email').fill('ada@example.com'); await p.getByLabel(/Password/).fill(PASSWORD)
  await p.getByRole('button', { name: 'Create owner account' }).click()
  await p.getByRole('combobox', { name: 'Add a task' }).waitFor()
  // The owner's one-time welcome note (welcome-note) is closed before the scenes.
  await p.locator('[data-welcome-close]').click({ timeout: 10000 }).catch(() => {})
  // A second account, a shared project and a pending invitation.
  const { link } = await api('POST', '/api/v1/invitations', { email: 'bob@example.com' })
  const bc = await browser.newContext()
  await api('POST', '/api/v1/auth/register', { email: 'bob@example.com', name: 'Bob Okafor', password: PASSWORD, invitation: link.split('/invite/')[1] }, bc)
  await bc.close()
  await api('POST', '/api/v1/invitations', { email: 'chen@example.com' })
  const home = await api('POST', '/api/v1/projects', { name: 'Home renovation', color: '#f59e0b' })
  await api('POST', `/api/v1/projects/${home.id}/members`, { email: 'bob@example.com', role: 'editor' })
  for (const title of ['Get three quotes for the kitchen', 'Pick paint colours', 'Order new taps']) await api('POST', '/api/v1/tasks', { title, project_id: home.id })
  // Archived projects for Settings → Projects (unarchive-projects).
  const trip = await api('POST', '/api/v1/projects', { name: 'Trip to Lisbon', color: '#0ea5e9' })
  for (const title of ['Book flights', 'Reserve the guesthouse']) {
    const t = await api('POST', '/api/v1/tasks', { title, project_id: trip.id })
    await api('PATCH', `/api/v1/tasks/${t.id}`, { completed_at: Date.now() - 40 * 86_400_000 })
  }
  await api('PATCH', `/api/v1/projects/${trip.id}`, { archived: true })
  const garden = await api('POST', '/api/v1/projects', { name: 'Garden', color: '#22c55e', parent_id: home.id })
  await api('POST', '/api/v1/tasks', { title: 'Plant the spring bulbs', project_id: garden.id })
  await api('PATCH', `/api/v1/projects/${garden.id}`, { archived: true })
  // A published task page with a guest's reply (task-pages).
  const fence = await api('POST', '/api/v1/tasks', { title: 'Paint the fence', description: 'Two coats of **white**. The paint is in the shed; brushes are on the shelf.', due: { date: '2026-10-25' } })
  for (const title of ['Buy primer', 'Sand the boards', 'First coat']) await api('POST', '/api/v1/tasks', { title, parent_id: fence.id })
  const page = await api('POST', `/api/v1/tasks/${fence.id}/page`, { rights: 'tick', label: 'paint-the-fence' })
  const secret = page.link.split('/t/')[1].split('/')[0]
  await api('POST', `/api/v1/pages/${secret}/replies`, { name: 'Marco', body: 'Bought the primer, starting tomorrow morning.' })
  // Automation rules (automation-rules): a label rule, a Sunday sweep and one turned off.
  const waiting = await api('POST', '/api/v1/labels', { name: 'waiting' })
  await api('POST', '/api/v1/rules', { name: 'Waiting for others', trigger: { kind: 'label.added', label_id: waiting.id }, actions: { priority: 3 } })
  await api('POST', '/api/v1/rules', { name: 'Sunday sweep', trigger: { kind: 'schedule', at: '18:00', weekdays: [7] }, condition: { due: 'overdue' }, actions: { due: 'tomorrow' } })
  await api('POST', '/api/v1/rules', { name: 'Due today means urgent', trigger: { kind: 'due.reached' }, actions: { priority: 1, notify: true }, enabled: false })
  await p.reload(); await settle(p, 1500)
  const state = await c.storageState(); await c.close(); return { state, home, pageLink: page.link }
}

// ------------------------------------------------------------------ assistant instance
// The in-app assistant (in-app-assistant) on its own instance, so the other
// screenshots keep their header: the "compatible endpoint" is the scripted fake
// in scripts/fake-llm.mjs, so answers are deterministic and no provider is used.
let assistantBase = null
async function assistantSetup() {
  const llmPort = await freePort()
  const llm = await startFakeLLM(llmPort)
  servers.push({ proc: { kill: () => llm.close() }, dir: mkdtempSync(join(tmpdir(), 'opentodo-docs-llm-')) })
  assistantBase = await startServer({})
  const c = await context('light'); const p = await c.newPage()
  const api = async (method, path, body) => {
    const r = await c.request.fetch(assistantBase + path, { method, headers: { Origin: assistantBase, 'Content-Type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) })
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`)
    const t = await r.text(); return t ? JSON.parse(t) : null
  }
  await api('POST', '/api/v1/auth/register', { email: 'ada@example.com', name: 'Ada Lovelace', password: PASSWORD })
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const home = await api('POST', '/api/v1/projects', { name: 'Home renovation', color: '#f59e0b' })
  await api('POST', '/api/v1/tasks', { title: 'Water the plants', due: { date: day(-2) } })
  await api('POST', '/api/v1/tasks', { title: 'Renew passport', due: { date: day(-1) }, priority: 2 })
  await api('POST', '/api/v1/tasks', { title: 'Get three quotes for the kitchen', project_id: home.id, due: { date: day(-1) } })
  await api('POST', '/api/v1/tasks', { title: 'Plan the team offsite', due: { date: day(0) } })
  await api('PUT', '/api/v1/settings/assistant', { enabled: true, default_provider: 'compatible', allow_private_endpoint: true,
    providers: { compatible: { enabled: true, model: 'llama3.1', base_url: `http://127.0.0.1:${llmPort}/v1` } } })
  await api('PUT', '/api/v1/me/assistant', { consent: true, provider: 'compatible' })
  await p.goto(assistantBase + '/inbox'); await p.getByRole('combobox', { name: 'Add a task' }).waitFor(); await settle(p, 1000)
  const state = await c.storageState(); await c.close(); return state
}
async function ask(p, question, ready) {
  await go(p, assistantBase, '/inbox', () => p.getByRole('combobox', { name: 'Add a task' }).waitFor())
  await p.keyboard.press('Shift+I'); await p.locator('[data-assistant-panel]').waitFor(); await settle(p, 400)
  await p.locator('[data-assistant-composer]').fill(question); await p.keyboard.press('Enter')
  await ready(); await settle(p, 600)
}

// ------------------------------------------------------------------ shots
// Each shot runs once per theme on a fresh page. `clip` returns a clip rectangle
// (or nothing for the whole viewport).
const D = 'demo', P = 'plain', FRESH = 'fresh'
const shots = [
  { name: 'demo-signin', server: FRESH, base: () => demoBase, async run(p) {
    await p.goto(demoBase); const card = p.getByRole('button', { name: /Try the demo/i }); await card.waitFor(); await settle(p)
    return clipOf(p, p.locator('div[class*="rounded"]').filter({ has: card }).first(), 32)
  } },
  { name: 'setup-owner', server: 'setup', async run(p, { setupBase }) {
    await p.goto(setupBase); await p.getByText('Create the owner account').waitFor(); await settle(p)
    return clipOf(p, p.locator('div[class*="rounded"]').filter({ has: p.locator('form') }).first(), 32)
  } },
  { name: 'today', server: D, card: true, async run(p) { await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor()) } },
  { name: 'quick-add', server: D, card: true, async run(p) {
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor())
    const qa = p.getByRole('combobox', { name: 'Add a task' }); await qa.click()
    await qa.pressSequentially('Call Sam about the tiles tomorrow at 4pm #Home @call p2 +15m', { delay: 5 }); await settle(p, 500)
    const main = p.locator('main'); const b = await main.boundingBox()
    const h1 = await p.getByRole('heading', { level: 1 }).boundingBox()
    return { x: b.x, y: h1.y - 16, width: b.width, height: 250 }
  } },
  // display-mode: Today full screen in large type, without the shell.
  { name: 'display-today', server: D, async run(p) { await go(p, demoBase, '/display/today', () => p.locator('[data-screen="display"] [data-display-row]').first().waitFor()) } },
  { name: 'triage', server: D, async run(p) { await go(p, demoBase, '/triage', () => p.locator('[data-triage-card]').waitFor()); await settle(p, 300) } },
  // Focus (focus-mode 7.2): a task of the sample data, its session started a moment ago.
  { name: 'focus', server: D, async run(p) {
    await go(p, demoBase, '/focus', () => p.locator('[data-focus-timer], [data-empty-state="focus"]').first().waitFor())
    if (await p.locator('[data-empty-state="focus"]').count()) {
      await p.getByRole('button', { name: 'Choose a task' }).click()
      await p.getByRole('option').first().click()
      await p.locator('[data-focus-timer]').waitFor()
    }
    await p.locator('[data-focus-toggle]').click(); await settle(p, 1200)
  } },
  // stats-and-review: the weekly review on its first unfinished step, and Statistics.
  { name: 'review', server: D, async run(p) { await go(p, demoBase, '/review', () => p.locator('#review-step-title').waitFor()); await settle(p, 300) } },
  // Open Loops (open-loops-method): the Loop home with the sidebar by the Places, Next, and the project walk.
  { name: 'loop', server: D, async run(p) {
    await go(p, demoBase, '/settings/account', () => p.locator('[data-method-mode="first"]').waitFor())
    await p.locator('[data-method-mode="first"]').click()
    await p.locator('[data-offer="start"]').getByRole('button', { name: 'Keep my start view' }).click()
    const contexts = p.locator('[data-offer="contexts"]')
    if (await contexts.count()) await contexts.getByRole('button', { name: 'Create them' }).click()
    await go(p, demoBase, '/loop', () => p.locator('[data-loop-tile="do"]').waitFor()); await settle(p, 300)
  }, async after(p) {
    await go(p, demoBase, '/settings/account', () => p.locator('[data-method-mode="lists"]').waitFor())
    await p.locator('[data-method-mode="lists"]').click(); await settle(p, 300)
  } },
  { name: 'next', server: D, async run(p) { await go(p, demoBase, '/next', () => p.locator('[data-group]').first().waitFor()); await settle(p, 300) } },
  // close-the-day: the Carry over step with its decisions.
  { name: 'close-day', server: D, async run(p) {
    await go(p, demoBase, '/review/close', () => p.locator('#review-step-title').waitFor())
    await p.keyboard.press(']'); await p.locator('[data-review-step="carry"]').waitFor(); await settle(p, 300)
  } },
  { name: 'review-walk', server: D, async run(p) { await go(p, demoBase, '/review/projects', () => p.locator('[data-walk-card]').waitFor()); await settle(p, 300) } },
  { name: 'stats', server: D, async run(p) { await go(p, demoBase, '/stats', () => p.locator('[data-period-chooser]').waitFor()); await settle(p, 300) } },
  { name: 'upcoming', server: D, card: true, async run(p) { await go(p, demoBase, '/upcoming', () => p.getByRole('heading', { name: 'Tomorrow' }).first().waitFor()) } },
  { name: 'project-list', server: D, card: true, async run(p) { await go(p, demoBase, '/inbox'); await openProject(p, 'Home renovation') } },
  { name: 'task-detail', server: D, async run(p) { await go(p, demoBase, '/inbox'); await openProject(p, 'Home renovation'); await openTask(p, 'Get three quotes for the kitchen') } },
  { name: 'board', server: D, card: true, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Q4 launch')
    await p.getByRole('group', { name: 'Project layout' }).getByRole('button', { name: 'Board' }).click(); await settle(p, 800)
  }, async after(p) { await p.getByRole('group', { name: 'Project layout' }).getByRole('button', { name: 'List' }).click().catch(() => {}) } },
  // Custom fields (custom-fields): the Side project's list in the columns layout.
  { name: 'custom-fields', server: D, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Side project')
    await p.locator('[data-columns-toggle]').click(); await p.getByRole('table', { name: 'Tasks and fields' }).waitFor(); await p.mouse.move(700, 700); await settle(p, 800)
  }, async after(p) { await p.locator('[data-columns-toggle]').click().catch(() => {}) } },
  { name: 'sidebar', server: D, async run(p) {
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor())
    return clipOf(p, sidebar(p), 0)
  } },
  { name: 'labels', server: D, card: true, async run(p) {
    await go(p, demoBase, '/today'); await unfold(p, sidebar(p).getByRole('button', { name: /^Labels/ }).first())
    await sidebar(p).getByRole('button', { name: /^errand/ }).click(); await settle(p, 800)
  } },
  // labels-and-menus: the shared object menus.
  { name: 'label-menu', server: D, async run(p) {
    await go(p, demoBase, '/labels', () => p.getByRole('heading', { level: 1, name: 'Labels' }).waitFor())
    await p.locator('main').getByRole('button', { name: 'Menu for label errand' }).click(); await settle(p, 500)
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'view-menu', server: D, async run(p) {
    await go(p, demoBase, '/views', () => p.getByRole('button', { name: 'New view' }).waitFor())
    await p.locator('main').getByRole('button', { name: /^Menu for view Deep work/ }).first().click(); await settle(p, 500)
  }, async after(p) { await p.keyboard.press('Escape') } },
  // Completed tasks kept in the project (project-completed-section): the switch is per device, so the scene turns it on and off again.
  { name: 'project-completed', server: D, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Work')
    await p.getByRole('button', { name: 'Project menu' }).click(); await p.locator('[data-menu-label="Show completed tasks"]').click()
    await unfold(p, p.locator('[data-completed-group] button[aria-expanded]').first()); await p.locator('[data-completed-group] [data-task-id]').first().waitFor(); await p.mouse.move(700, 120); await settle(p, 500)
  }, async after(p) {
    await p.getByRole('button', { name: 'Project menu' }).click(); await p.locator('[data-menu-label="Show completed tasks"]').click().catch(() => {})
  } },
  { name: 'project-move', server: D, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Side project')
    await p.keyboard.press('m'); await p.locator('[data-picker-step]').waitFor(); await settle(p, 500)
  }, async after(p) { await p.keyboard.press('Escape'); await p.keyboard.press('Escape') } },
  { name: 'filter', server: D, card: true, async run(p) {
    await go(p, demoBase, '/views/new', () => p.getByLabel('Filter query').waitFor())
    await p.getByLabel('Filter query').fill('(@call | @errand) & due <= 7 days'); await p.getByLabel('Filter query').press('Enter'); await settle(p, 800)
  } },
  { name: 'dashboard', server: D, card: true, async run(p) {
    await go(p, demoBase, '/today'); await sidebar(p).getByRole('button', { name: /^Weekly review/ }).click(); await settle(p, 1000)
  } },
  // The Eisenhower board (rule-boards 4.2): created from its template once, opened again for the dark shot.
  { name: 'eisenhower', server: D, async run(p) {
    if (!eisenhowerPath) {
      await go(p, demoBase, '/views', () => p.getByRole('button', { name: 'New board' }).waitFor())
      await p.getByRole('button', { name: 'New board' }).click(); await p.locator('[data-board-choice="eisenhower"] input').check()
      await p.getByRole('button', { name: 'Next' }).click(); await p.getByRole('button', { name: 'Create' }).click()
      await p.locator('section[aria-label="Urgent and important"]').waitFor(); eisenhowerPath = new URL(p.url()).pathname
    } else await go(p, demoBase, eisenhowerPath, () => p.locator('section[aria-label="Urgent and important"]').waitFor())
    await settle(p, 800)
  } },
  { name: 'repeat', server: D, async run(p) {
    // Dated tasks are not in the Inbox (inbox-means-unplaced): Run club is in Today.
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor()); await openTask(p, 'Run club')
    await detail(p).getByRole('button', { name: /^Repeat: every/ }).click(); const editor = p.getByRole('dialog', { name: 'When' }); await editor.waitFor(); await settle(p, 400)
    return clipOf(p, editor, 16)
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'reminders', server: D, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Home renovation'); await openTask(p, 'Get three quotes for the kitchen')
    await detail(p).getByRole('button', { name: /^Reminder: / }).first().click(); const editor = p.getByRole('dialog', { name: 'When' }); await editor.waitFor()
    await editor.getByRole('tab', { name: /^Reminders/ }).click(); await settle(p, 400)
    return clipOf(p, editor, 16)
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'week', server: D, card: true, async run(p) {
    await go(p, demoBase, '/week', () => p.getByRole('button', { name: 'Week' }).first().waitFor())
    await p.getByRole('button', { name: 'Hide task list' }).click().catch(() => {}); await settle(p, 500)
  }, async after(p) { await p.getByRole('button', { name: /Show task list/ }).click().catch(() => {}) } },
  { name: 'day', server: D, async run(p) { await go(p, demoBase, '/day', () => p.getByRole('button', { name: 'Day' }).first().waitFor()) } },
  // The Plan (planner-view 5.2): two rows of columns with their capacity bars and a dimmed projected row.
  { name: 'plan', server: D, async run(p) { await go(p, demoBase, '/plan', () => p.locator('[data-plan-grid]').waitFor()); await settle(p, 300) } },
  { name: 'comments', server: D, card: true, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Home renovation'); await openTask(p, 'Get three quotes for the kitchen')
    await scrollPanelTo(p, detail(p).getByRole('region', { name: 'Comments, activity, history and time' }), 8)
  } },
  { name: 'notifications', card: true, server: D, async run(p) {
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor())
    await p.getByRole('button', { name: /^Notifications/ }).click(); const d = p.getByRole('dialog', { name: 'Notifications' }); await d.waitFor(); await settle(p, 500)
    const b = await d.boundingBox(); const vp = p.viewportSize()
    const x = Math.max(0, b.x - 240)
    return { x, y: 0, width: vp.width - x, height: Math.min(vp.height, b.y + b.height + 24) }
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'activity', server: D, card: true, async run(p) { await go(p, demoBase, '/activity', () => p.getByRole('heading', { level: 1, name: 'Updates' }).waitFor()) } },
  { name: 'history', server: D, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Home renovation'); await openTask(p, 'Pick paint colours')
    // History is a tab of the panel (task-detail-redesign); expand the newest version.
    const hist = detail(p).getByRole('tab', { name: 'History' }); await hist.scrollIntoViewIfNeeded(); await hist.click(); await settle(p, 1200)
    await detail(p).getByRole('list', { name: 'Versions' }).getByRole('button', { expanded: false }).first().click().catch(() => {}); await settle(p, 400)
    await scrollPanelTo(p, hist, 8)
    const b = await detail(p).boundingBox()
    return { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, 470) }
  } },
  // The time-zone popover of a timed due (task-detail-redesign 5.4).
  { name: 'time-zone', server: D, async run(p) {
    await go(p, demoBase, '/inbox'); await openProject(p, 'Home renovation'); await openTask(p, 'Get three quotes for the kitchen')
    await detail(p).getByRole('button', { name: /^Do: / }).first().click(); await p.getByRole('dialog', { name: 'When' }).waitFor()
    await p.getByRole('dialog', { name: 'When' }).getByRole('button', { name: /^Time zone/ }).first().click()
    const d = p.getByRole('dialog', { name: 'Time zone' }); await d.waitFor(); await settle(p, 400)
    return clipOf(p, d, 16)
  }, async after(p) { await p.keyboard.press('Escape') } },
  // A task's location editor (task-locations): coordinates typed into the field, set as the location.
  { name: 'locations', server: D, async run(p) {
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor()); await openTask(p, 'Pick up groceries')
    const d = p.getByRole('dialog', { name: 'Location' })
    const part = detail(p).getByRole('button', { name: /^Location: .*45\.4642/ }).first()
    if (!(await part.count())) {
      // The first theme sets it; the second finds it set (one sandbox for both).
      await detail(p).getByRole('button', { name: 'Location: Add a place' }).click(); await d.waitFor()
      await d.getByRole('combobox').fill('45.4642, 9.19'); await d.getByRole('option').first().waitFor(); await p.keyboard.press('Enter'); await settle(p, 400)
    }
    await part.click(); await d.waitFor(); await settle(p, 400)
    return clipOf(p, d, 16)
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'trash', server: D, card: true, async run(p) { await go(p, demoBase, '/trash', () => p.getByRole('heading', { level: 1, name: 'Trash' }).waitFor()) } },
  { name: 'shortcuts', server: D, card: true, async run(p) {
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor())
    await p.keyboard.press('?'); await p.getByText('Keyboard shortcuts').first().waitFor(); await settle(p, 500)
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'sync-status', card: true, server: D, async run(p, { ctx }) {
    await go(p, demoBase, '/inbox', () => p.getByRole('combobox', { name: 'Add a task' }).waitFor())
    await ctx.setOffline(true); await settle(p, 800)
    const qa = p.getByRole('combobox', { name: 'Add a task' }); await qa.click(); await qa.fill('Buy stamps'); await qa.press('Enter'); await settle(p, 1200)
    const main = p.locator('main'); const b = await main.boundingBox()
    return { x: b.x, y: b.y, width: b.width, height: 330 }
  }, async after(p, { ctx }) { await ctx.setOffline(false); await settle(p, 2500) } },
  // Phone
  { name: 'mobile-today', card: true, server: D, phone: true, async run(p) { await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor()) } },
  { name: 'mobile-menu', server: D, phone: true, async run(p) {
    await go(p, demoBase, '/today', () => p.getByRole('heading', { name: 'Earlier' }).waitFor())
    await p.getByRole('button', { name: 'Open menu' }).click(); await settle(p, 600)
  } },
  // Ordinary instance: account, settings and sharing
  { name: 'signin', card: true, server: FRESH, async run(p) {
    await p.goto(plainBase); await p.getByRole('button', { name: 'Sign in', exact: true }).first().waitFor(); await settle(p)
    return clipOf(p, p.locator('div[class*="rounded"]').filter({ has: p.locator('form') }).first(), 32)
  } },
  { name: 'share-dialog', server: P, async run(p, { home }) {
    await go(p, plainBase, `/project/${home.id}`, () => row(p, 'Pick paint colours').waitFor())
    await p.getByRole('button', { name: /^Share/ }).first().click(); const d = p.getByRole('dialog', { name: /Share/ }); await d.waitFor()
    await d.getByRole('textbox').first().fill('chen@example.com').catch(() => {}); await settle(p, 500)
    return clipOf(p, d, 16)
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'settings', server: P, card: true, async run(p) { await go(p, plainBase, '/settings', () => p.getByRole('heading', { name: 'Account', level: 1 }).waitFor()) } },
  { name: 'settings-security', card: true, server: P, async run(p) {
    await go(p, plainBase, '/settings/account', () => p.getByRole('heading', { name: 'Account', level: 1 }).waitFor())
    const h = p.getByRole('heading', { level: 2, name: 'Two-factor authentication' }); await h.waitFor()
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
    return { x: main.x, y: Math.max(0, top.y - 20), width: main.width, height: 350 }
  } },
  // A task page as a guest sees it (task-pages): its own document at /t/<secret>.
  { name: 'task-page', server: P, async run(p) {
    await p.goto(plain.pageLink); await p.getByRole('heading', { level: 1, name: 'Paint the fence' }).waitFor(); await settle(p, 800)
  } },
  { name: 'settings-passkeys', server: P, async run(p) {
    await go(p, plainBase, '/settings/account', () => p.getByRole('heading', { name: 'Account', level: 1 }).waitFor())
    const h = p.getByRole('heading', { level: 2, name: 'Passkeys', exact: true }); await h.waitFor()
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
    return { x: main.x, y: Math.max(0, top.y - 20), width: main.width, height: 270 }
  } },
  { name: 'settings-notifications', server: P, permissions: ['notifications'], async run(p) {
    await go(p, plainBase, '/settings/notifications', () => p.getByRole('heading', { name: 'Notifications', level: 1 }).waitFor())
    const h = p.getByRole('heading', { level: 2, name: 'Notifications' }); await h.waitFor()
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
    return { x: main.x, y: Math.max(0, top.y - 20), width: main.width, height: 240 }
  } },
  // Delivery channels (notification-channels): one ntfy channel added through the API.
  { name: 'settings-notification-channels', server: P, async run(p) {
    await go(p, plainBase, '/settings/notifications', () => p.getByRole('heading', { name: 'Notifications', level: 1 }).waitFor())
    await p.evaluate(async () => {
      const { channels } = await (await fetch('/api/v1/notification-channels')).json()
      if (channels.length) return
      await fetch('/api/v1/notification-channels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'ntfy', name: 'Phone', url: 'https://ntfy.sh', topic: 'ana-tasks', events: ['reminder', 'assigned', 'mentioned'] }) })
    })
    await go(p, plainBase, '/settings/notifications', () => p.locator('[data-channel]').first().waitFor())
    const h = p.getByRole('heading', { level: 2, name: 'Delivery channels' }); await h.waitFor()
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
    return { x: main.x, y: Math.max(0, top.y - 20), width: main.width, height: 330 }
  } },
  // All projects as a table with health (projects-table): the header, the tabs and the table.
  { name: 'all-projects', server: P, async run(p) {
    await go(p, plainBase, '/projects', () => p.locator('[data-projects-table] [data-health]').first().waitFor())
    await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const table = await p.locator('[data-projects-table]').boundingBox()
    return { x: main.x, y: main.y, width: main.width, height: Math.min(table.y + table.height - main.y + 56, 640) }
  } },
  // Archived projects are the Projects page's second tab (projects-table D7).
  { name: 'archived-projects', server: P, async run(p) {
    await go(p, plainBase, '/projects', () => p.getByRole('tab', { name: /^Archived/ }).waitFor())
    const tab = p.getByRole('tab', { name: /^Archived/ }); await tab.click(); await p.getByTestId('archived-projects').waitFor()
    await settle(p, 400)
    const main = await p.locator('main').boundingBox()
    const list = await p.getByTestId('archived-projects').boundingBox()
    return { x: main.x, y: main.y, width: main.width, height: list.y + list.height - main.y + 32 }
  } },
  { name: 'members', server: P, async run(p) {
    await go(p, plainBase, '/settings/people', () => p.getByRole('heading', { name: 'People', level: 1 }).waitFor())
    const h = p.getByRole('heading', { level: 2, name: 'Members' }); await h.waitFor()
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
    return { x: main.x, y: Math.max(0, top.y - 20), width: main.width, height: 380 }
  } },
  { name: 'rules', server: P, async run(p) { await go(p, plainBase, '/rules', () => p.locator('[data-rule-row]').nth(2).waitFor()); await settle(p, 600) } },
  { name: 'import', card: true, server: P, async run(p) { await go(p, plainBase, '/settings/import', () => p.getByRole('heading', { level: 1 }).first().waitFor()) } },
  // The switch guides (named-importers 7.4): the import preview of each app's real
  // export, from the sanitised fixtures in internal/importer/testdata (and the
  // synthesised ones of more-importers).
  ...[['todoist', 'todoist-backup/backup.zip'], ['things', 'things-db/main.sqlite'], ['ticktick', 'ticktick-csv/backup.csv'], ['linear', 'linear-csv/export.csv'],
    ['google-tasks', 'google-tasks-json/Tasks.json'], ['trello', 'trello-json/board.json'], ['asana', 'asana-csv/export.csv'],
    ['microsoft-todo', 'microsoft-todo-json/todo.json'], ['apple-reminders', 'apple-reminders-json/reminders.json'], ['anydo', 'anydo-json/data.json']].map(([app, fixture]) => (
    { name: `import-${app}`, server: P, async run(p) {
      await go(p, plainBase, '/settings/import', () => p.getByRole('heading', { level: 1 }).first().waitFor())
      await p.locator('#import-file').setInputFiles(`internal/importer/testdata/${fixture}`)
      await p.getByRole('button', { name: 'Preview', exact: true }).click()
      const h = p.getByRole('heading', { level: 2, name: /^Preview · / }); await h.waitFor({ timeout: 20000 })
      await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
      const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
      return { x: main.x, y: Math.max(0, top.y - 16), width: main.width, height: 460 }
    } })),
  // In-app assistant (in-app-assistant), against the scripted fake provider.
  { name: 'assistant-chat', card: true, server: 'assistant', async run(p) {
    await ask(p, 'What is due today?', () => p.locator('[data-assistant-panel] li').filter({ hasText: 'Want me to move' }).waitFor({ timeout: 20000 }))
  } },
  { name: 'assistant-review', server: 'assistant', async run(p) {
    await ask(p, 'Move everything overdue to Friday', () => p.locator('[data-assistant-review]').waitFor({ timeout: 20000 }))
  }, async after(p) { await p.locator('[data-assistant-review]').getByRole('button', { name: 'Discard' }).click().catch(() => {}) } },
  { name: 'assistant-phone', server: 'assistant', phone: true, async run(p) {
    await ask(p, 'Move everything overdue to Friday', () => p.locator('[data-assistant-review]').waitFor({ timeout: 20000 }))
  }, async after(p) { await p.locator('[data-assistant-review]').getByRole('button', { name: 'Discard' }).click().catch(() => {}) } },
  // Workspaces (workspaces): last, because the scene adds a second workspace to the instance.
  { name: 'workspace-switcher', server: P, async run(p) {
    const api = async (method, path, body) => {
      const r = await p.request.fetch(plainBase + path, { method, headers: { Origin: plainBase, 'Content-Type': 'application/json' }, data: body === undefined ? undefined : JSON.stringify(body) })
      if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`)
      const t = await r.text(); return t ? JSON.parse(t) : null
    }
    // Once for both themes: the second run finds Family there.
    const { workspaces } = await api('GET', '/api/v1/workspaces')
    if (!workspaces.some((w) => w.name === 'Family')) {
      const family = await api('POST', '/api/v1/workspaces', { name: 'Family', color: '#22c55e' })
      await api('POST', `/api/v1/workspaces/${family.id}/members`, { email: 'bob@example.com', role: 'member' })
      const adults = await api('POST', `/api/v1/workspaces/${family.id}/groups`, { name: 'Adults' })
      await api('PUT', `/api/v1/workspaces/${family.id}/groups/${adults.id}/members/${family.ownerId}`)
      const house = await api('POST', '/api/v1/projects', { name: 'House', color: '#f97316', workspace_id: family.id })
      await api('POST', '/api/v1/tasks', { title: 'Fix the gutter', project_id: house.id })
    }
    await go(p, plainBase, '/today', () => p.locator('[data-workspace-trigger]').waitFor())
    await settle(p, 1500)
    await p.locator('[data-workspace-trigger]').click(); const menu = p.getByRole('menu'); await menu.waitFor(); await settle(p, 400)
    const side = await p.locator('[data-sidebar-header]').boundingBox(); const m = await menu.boundingBox()
    return { x: Math.max(0, side.x - 8), y: Math.max(0, side.y - 8), width: Math.max(side.width, m.x + m.width - side.x) + 24, height: m.y + m.height - side.y + 24 }
  }, async after(p) { await p.keyboard.press('Escape') } },
  { name: 'workspaces', server: P, async run(p) { await go(p, plainBase, '/today', () => p.locator('[data-workspace-trigger]').waitFor()) } },
  { name: 'settings-workspaces', server: P, card: true, async run(p) {
    await go(p, plainBase, '/settings/workspaces', () => p.getByRole('heading', { name: 'Workspaces', level: 1 }).waitFor())
    await p.getByRole('button', { name: /^Family/ }).first().click(); await p.getByRole('tab', { name: /^Members/ }).click()
    await p.locator('#workspace-members').waitFor(); await settle(p, 600)
  } },
  { name: 'assistant-settings', server: 'assistant', async run(p) {
    await go(p, assistantBase, '/settings/integrations', () => p.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor())
    const h = p.locator('#assistant-settings-heading'); await h.waitFor(); await p.locator('[data-assistant-owner]').waitFor()
    await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await settle(p, 400)
    const main = await p.locator('main').boundingBox(); const top = await h.boundingBox()
    return { x: main.x, y: Math.max(0, top.y - 20), width: main.width, height: 560 }
  } },
  // The owner's switch for the on-device assistant of encrypted accounts (assistant-on-device), not saved.
  { name: 'assistant-device-owner', server: 'assistant', async run(p) {
    await go(p, assistantBase, '/settings/integrations', () => p.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor())
    await p.locator('[data-assistant-owner]').getByRole('button', { name: 'Configure' }).click()
    const group = p.locator('[data-assistant-group="device"]'); await group.waitFor()
    await group.getByLabel('Let encrypted accounts use the assistant from their own device').check()
    await group.getByLabel('Anthropic (Claude)').check()
    await group.getByLabel(/^A model server/).check()
    await group.locator('textarea').fill('http://localhost:11434')
    await group.evaluate((el) => el.scrollIntoView({ block: 'center' })); await settle(p, 400)
    const box = await group.boundingBox()
    return { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 48 }
  } },
]

// ------------------------------------------------------------------ run
const demo = shots.some((s) => s.server === D && want(s.name)) ? await demoState() : null
const plain = shots.some((s) => s.server === P && want(s.name)) || want('signin') ? await plainSetup() : null
const assistant = shots.some((s) => s.server === 'assistant' && want(s.name)) ? await assistantSetup() : null
let failed = 0
for (const shot of shots) {
  if (!want(shot.name)) continue
  for (const theme of ['light', 'dark']) {
    const opts = shot.phone ? { viewport: PHONE, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true } : {}
    let extra = {}
    if (shot.server === 'setup') extra.setupBase = await startServer({})
    const storageState = shot.server === D ? demo : shot.server === P ? plain.state : shot.server === 'assistant' ? assistant : undefined
    const ctx = await context(theme, { ...opts, storageState, ...(shot.permissions ? { permissions: shot.permissions } : {}) })
    const p = await ctx.newPage()
    try {
      const clip = await shot.run(p, { ctx, home: plain?.home, ...extra })
      const png = await p.screenshot(clip ? { clip } : {})
      await save(shot.name, theme, png, shot.card)
      if (shot.after) await shot.after(p, { ctx })
    } catch (err) {
      failed++
      console.error(`  ${shot.name}-${theme}: ${err.message.split('\n')[0]}`)
    }
    await ctx.close()
  }
}
await browser.close()
stopServers()
console.log(`${failed ? 'SHOTS FAILED' : 'SHOTS OK'}: ${(bytes / 1024).toFixed(0)} KB written to ${OUT}/`)
process.exit(failed ? 1 : 0)
