// @vitest-environment happy-dom
// The briefing's wording (OpenSpec change briefing, task 2.2): the facts of
// lib/briefing as one paragraph, in English and in a shipped language.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Briefing } from '../lib/briefing'
import { applyLanguagePreference } from '../lib/i18n'
import { BriefingText } from './Briefing'

const text = (b: Briefing) => {
  const div = document.createElement('div')
  div.innerHTML = renderToStaticMarkup(<BriefingText briefing={b} />)
  return div
}

const THREE: Briefing = {
  mode: 'today', open: 4, planned: 90,
  facts: [
    { kind: 'late', count: 1, ids: ['p'], task: { id: 'p', title: 'Renew the passport' }, days: 2 },
    { kind: 'full', dates: ['2026-10-23'] },
    { kind: 'replies', count: 1, name: 'Mia', task: { id: 'b', title: 'Boiler' } },
  ],
}

afterEach(() => applyLanguagePreference('en', ['en-US']))

describe('briefing wording', () => {
  it('three things: a bold lead, then the clauses in their tones joined as one sentence', () => {
    const el = text(THREE)
    expect(el.textContent).toBe('Three things matter today. Renew the passport is 2 days late, Friday is already full, and Mia answered about Boiler.')
    expect(el.querySelector('[data-briefing-lead]')?.textContent).toBe('Three things matter today.')
    expect(el.querySelector('[data-briefing-fact="late"]')?.className).toContain('text-danger')
    expect(el.querySelector('[data-briefing-fact="full"]')?.className).toContain('text-warning')
    expect([...el.querySelectorAll('[data-briefing-task]')].map((n) => n.textContent)).toEqual(['Renew the passport', 'Boiler'])
  })

  it('a clause that starts the sentence starts with a capital; counts and today past its length', () => {
    const el = text({ mode: 'today', open: 5, planned: 540, facts: [{ kind: 'overfull', planned: 540, dayLength: 480 }, { kind: 'replies', count: 3 }] })
    expect(el.textContent).toBe('Two things matter today. Today holds 9h of work, more than your 8h day and 3 replies are waiting.')
    expect(text({ mode: 'today', open: 3, planned: 0, facts: [{ kind: 'late', count: 3, ids: ['a', 'b', 'c'] }] }).textContent).toBe('One thing matters today. 3 tasks are late.')
  })

  it('a calm day, all done, a clear day, and Upcoming', () => {
    expect(text({ mode: 'today', open: 2, planned: 45, facts: [] }).textContent).toBe('Nothing stands out today. 2 tasks are planned, about 45m in all.')
    expect(text({ mode: 'today', open: 1, planned: 0, facts: [] }).textContent).toBe('Nothing stands out today. One task is planned.')
    expect(text({ mode: 'done', tomorrow: { count: 4, first: { id: 's', title: 'Standup', time: '09:30' } } }).textContent)
      .toMatch(/^All done for today\. Tomorrow starts with 4 tasks; the first is Standup at (9:30 AM|09:30)\.$/)
    expect(text({ mode: 'clear', tomorrow: { count: 0, first: null } }).textContent).toBe('Nothing is planned for today. Nothing is planned for tomorrow yet.')
    expect(text({ mode: 'upcoming', count: 6, facts: [{ kind: 'full', dates: ['2026-10-23', '2026-10-26'] }], tomorrow: { count: 1, first: { id: 'g', title: 'Groceries' } } }).textContent)
      .toBe('6 tasks in the next seven days. Friday and Monday are already full. Tomorrow starts with one task; the first is Groceries.')
    expect(text({ mode: 'upcoming', count: 2, facts: [], tomorrow: { count: 0, first: null } }).textContent).toBe('2 tasks in the next seven days. Every day still has room. Nothing is planned for tomorrow yet.')
    expect(text({ mode: 'upcoming', count: 0, facts: [], tomorrow: { count: 0, first: null } }).textContent).toBe('Nothing is planned for the next seven days.')
  })

  it('each part leads somewhere: named tasks to their page, counts and days to their list, replies to the notifications (briefing-links D2, D3)', () => {
    const el = text(THREE)
    const task = el.querySelector<HTMLAnchorElement>('[data-briefing-link="task"]')!
    expect(task.getAttribute('href')).toBe('/task/p')
    expect(task.getAttribute('aria-label')).toBe('Renew the passport, open task')
    expect(task.closest('[data-briefing-fact]')!.getAttribute('data-briefing-fact')).toBe('late')
    expect(el.querySelector('[data-briefing-link="late"]')).toBeNull()
    expect(el.querySelector('[data-briefing-link="full"]')!.getAttribute('aria-label')).toBe('Friday is already full, open in Upcoming')
    expect(el.querySelector('[data-briefing-link="replies"]')).toBeNull()
    const counts = text({ mode: 'today', open: 5, planned: 0, facts: [{ kind: 'late', count: 2, ids: ['a', 'b'] }, { kind: 'replies', count: 3 }] })
    expect(counts.querySelector('[data-briefing-link="late"]')!.textContent).toBe('2 tasks are late')
    const replies = counts.querySelector('[data-briefing-link="replies"]')!
    expect(replies.tagName).toBe('BUTTON')
    expect(replies.getAttribute('aria-label')).toBe('3 replies are waiting, open notifications')
    const tomorrow = text({ mode: 'done', tomorrow: { count: 1, first: { id: 's', title: 'Standup' } } })
    expect(tomorrow.querySelector('[data-briefing-link="task"]')!.getAttribute('href')).toBe('/task/s')
  })

  it('several full days are one link each, opening that day in Upcoming (precision-polish-2)', () => {
    const el = text({ mode: 'upcoming', count: 6, facts: [{ kind: 'full', dates: ['2026-10-23', '2026-10-26'] }], tomorrow: { count: 0, first: null } })
    const days = [...el.querySelectorAll<HTMLAnchorElement>('[data-briefing-link="full-day"]')]
    expect(days.map((d) => d.textContent)).toEqual(['Friday', 'Monday'])
    expect(days.map((d) => d.getAttribute('aria-label'))).toEqual(['Friday, open in Upcoming', 'Monday, open in Upcoming'])
    expect(days.every((d) => d.getAttribute('href') === '/upcoming')).toBe(true)
    expect(el.querySelector('[data-briefing-link="full"]')).toBeNull()
    expect(el.querySelector('[data-briefing-fact="full"]')!.textContent).toBe('Friday and Monday are already full')
    const three = text({ mode: 'upcoming', count: 9, facts: [{ kind: 'full', dates: ['2026-10-23', '2026-10-24', '2026-10-26'] }], tomorrow: { count: 0, first: null } })
    expect(three.querySelector('[data-briefing-fact="full"]')!.textContent).toBe('Friday, Saturday and Monday are already full')
    expect(three.querySelectorAll('[data-briefing-link="full-day"]').length).toBe(3)
  })

  it.each([
    ['de', 'Freitag und Montag sind schon voll'],
    ['es', 'Viernes y lunes ya están completos'],
    ['fr', 'Vendredi et lundi sont déjà complets'],
    ['it', 'Venerdì e lunedì sono già al completo'],
    ['pt', 'Sexta-feira e segunda-feira já não têm espaço'],
  ] as const)('in %s the days are linked one by one inside the language\'s own list and plural', async (lang, sentence) => {
    await applyLanguagePreference(lang, ['en-US'])
    const el = text({ mode: 'upcoming', count: 6, facts: [{ kind: 'full', dates: ['2026-10-23', '2026-10-26'] }], tomorrow: { count: 0, first: null } })
    expect(el.querySelector('[data-briefing-fact="full"]')!.textContent).toBe(sentence)
    expect(el.querySelectorAll('[data-briefing-link="full-day"]').length).toBe(2)
  })

  it('in Italian the same facts read in Italian; the task titles stay as written', async () => {
    await applyLanguagePreference('it', ['en-US'])
    expect(text(THREE).textContent).toBe('Oggi contano tre cose. Renew the passport è in ritardo di 2 giorni, venerdì è già al completo e Mia ha risposto su Boiler.')
    expect(text({ mode: 'today', open: 5, planned: 540, facts: [{ kind: 'overfull', planned: 540, dayLength: 480 }] }).textContent).toBe('Oggi conta una cosa. Oggi hai 9h di lavoro, più della tua giornata di 8h.')
  })
})
