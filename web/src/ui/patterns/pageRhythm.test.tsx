// @vitest-environment happy-dom
// The page rhythm (OpenSpec change page-rhythm): the lead line under the title (D1),
// the two frames (D3; list-stays-still D1), and group headers as labels (D2).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { minWidthPx, render } from '../test-utils'
import { frameKind, PageBody, PageHeader } from './PageHeader'
import { pageBar } from './pageBar'

afterEach(() => { vi.unstubAllGlobals() })

/** matchMedia answering `width` for min-width queries and `reduce` for reduced motion. */
function stubMedia(width: number, reduce = false) {
  vi.stubGlobal('matchMedia', (q: string) => {
    const min = minWidthPx(q)
    const matches = min ? width >= min : q.includes('reduced-motion') ? reduce : false
    return { matches, media: q, addEventListener() {}, removeEventListener() {} }
  })
}

describe('PageHeader lead line (page-rhythm D1)', () => {
  it('a day page puts the title at the display step with the date line beside it (precision-shell D1)', async () => {
    stubMedia(1280)
    const r = await render(<PageHeader kind="day" title="Today" meta="Wednesday 21 October · 5 h 15 m planned" actions={<button>Add</button>} help="today" briefing="Three things matter today." />)
    const title = r.container.querySelector('[data-page-title]')!
    expect(title.className).toContain('text-display')
    const lead = r.container.querySelector('[data-page-lead]')!
    expect(lead.textContent).toBe('Wednesday 21 October · 5 h 15 m planned')
    expect(lead.className).toContain('text-muted')
    expect(lead.className).toContain('text-prose')
    // The title's row holds the title and the date line; the actions are in the top row above it, and the briefing follows.
    const row = r.container.querySelector('[data-page-header-row]')!
    expect(row.contains(lead)).toBe(true)
    expect(r.container.querySelector('[data-page-top-row] [data-page-actions]')).not.toBeNull()
    expect(r.container.querySelector('[data-page-briefing]')!.className).toContain('text-prose')
    // One header element: the lead line is inside it (the interface budget counts elements).
    expect(r.container.querySelectorAll('[data-page-header]')).toHaveLength(1)
    expect(r.container.querySelector('[data-page-header]')!.contains(lead)).toBe(true)
    await r.unmount()
  })

  it('a tool page is one compact row: title at the header step, the lead line beside it, then the actions (precision-shell D1)', async () => {
    stubMedia(1280)
    const r = await render(<PageHeader title="Home renovation" meta="2 · owner" actions={<button>Share</button>} help="project" />)
    const row = r.container.querySelector('[data-page-header-row]')!
    expect(r.container.querySelector('[data-page-title]')!.className).toContain('text-h3')
    expect(row.className).toContain('min-h-[2.875rem]')
    expect(row.contains(r.container.querySelector('[data-page-lead]'))).toBe(true)
    expect(row.querySelector('[data-page-actions]')).not.toBeNull()
    await r.unmount()
  })

  it('renders no lead line without meta', async () => {
    stubMedia(1280)
    const r = await render(<PageHeader title="Inbox" />)
    expect(r.container.querySelector('[data-page-lead]')).toBeNull()
    await r.unmount()
  })

  it('below 768 px gives the lead line to the shell bar as its subtitle', async () => {
    stubMedia(390)
    const r = await render(<PageHeader title="Today" meta="Wednesday 21 October" />)
    expect(pageBar()?.title).toBe('Today')
    expect(pageBar()?.subtitle).toBe('Wednesday 21 October')
    expect(r.container.querySelector('[data-page-title]')).toBeNull()
    expect(r.container.querySelector('[data-page-lead]')).toBeNull()
    await r.unmount()
  })

  it('keeps an explicit subtitle for the bar (the board column)', async () => {
    stubMedia(390)
    const r = await render(<PageHeader title="Q4 launch" meta="3 members" subtitle="Doing" />)
    expect(pageBar()?.subtitle).toBe('Doing')
    await r.unmount()
  })
})

describe('two frames (page-rhythm D3)', () => {
  it('a page without a layout switch is standalone; a full page is a layout page', () => {
    expect(frameKind('list')).toBe('standalone')
    expect(frameKind('form')).toBe('standalone')
    expect(frameKind('wide')).toBe('standalone')
    expect(frameKind('wide', 'layout')).toBe('layout')
    expect(frameKind('full')).toBe('layout')
    expect(frameKind('full', 'standalone')).toBe('layout')
  })

  it('PageBody marks its frame and width', async () => {
    const r = await render(<><PageBody width="list" data-a>a</PageBody><PageBody width="full" data-b>b</PageBody></>)
    const a = r.container.querySelector('[data-a]')!
    const b = r.container.querySelector('[data-b]')!
    expect([a.getAttribute('data-page-frame'), a.getAttribute('data-page-body')]).toEqual(['standalone', 'list'])
    expect([b.getAttribute('data-page-frame'), b.getAttribute('data-page-body')]).toEqual(['layout', 'full'])
    await r.unmount()
  })

  it('the stylesheet lets every page fill the content surface; only a form keeps its fields at 42 rem (precision-shell D3)', async () => {
    const css = (await import('../../index.css?raw')).default
    expect(css).not.toMatch(/--page-width:\s*60rem/)
    expect(css).not.toMatch(/\.page-frame\[data-page-project\]/)
    expect(css).toMatch(/\.page-frame\[data-page-body="form"\] > :not\(\[data-page-header\]\) \{ max-width: 42rem; \}/)
  })
})

describe('opening the panel moves nothing (list-stays-still D1)', () => {
  it('puts both frames at the column\'s left edge, never centred', async () => {
    const css = (await import('../../index.css?raw')).default
    expect(css).toMatch(/\.page-frame\s*\{\s*margin-left:\s*0;\s*margin-right:\s*0;\s*\}/)
    const r = await render(<PageBody width="list"><p>row</p></PageBody>)
    expect(r.container.querySelector('[data-page-body]')!.className).not.toContain('mx-auto')
  })
  it('gives the docked panel one width, 26 rem and 30 rem from 1440 px', async () => {
    const css = (await import('../../index.css?raw')).default
    expect(css).toMatch(/:root\s*\{\s*--panel-w:\s*26rem;\s*\}/)
    expect(css).toMatch(/@media \(min-width: 90rem\)\s*\{\s*:root\s*\{\s*--panel-w:\s*30rem;\s*\}\s*\}/)
    const sources = import.meta.glob(['../../app/PanelFrame.tsx', '../../app/task-detail/TaskDetail.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    for (const [path, src] of Object.entries(sources)) {
      expect(src, path).toContain('lg:w-(--panel-w)')
      expect(src, path).not.toMatch(/min-\[1440px\]:w-|lg:w-\[26rem\]/)
    }
  })
})
