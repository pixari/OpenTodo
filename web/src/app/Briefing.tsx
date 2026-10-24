// The briefing sentence of the day pages (OpenSpec change `briefing`): the facts of
// lib/briefing worded through the message layer. A bold lead sentence, then what
// stands out joined by the language's own list pattern; late in the danger tone, a
// full day in the warning tone, a reply in the strong text tone (design D2, D5).
// Each part leads to what it names (briefing-links D2, D3): quiet links in the
// clause's own tone, underlined on hover and keyboard focus.
import { Fragment, useMemo, type MouseEvent, type ReactNode } from 'react'
import { briefingFacts, type Briefing, type BriefingFact, type BriefingTask, type BriefingTomorrow } from '../lib/briefing'
import { formatTime, weekday } from '../lib/dates'
import { formatMinutes } from '../lib/duration'
import { formatList, t, useLanguageVersion } from '../lib/i18n'
import { useGridPrefs, useLiveProjects } from '../lib/liveData'
import { useNotifications, useReviewRow } from '../lib/localData'
import { useLiveTasks } from '../lib/liveTasks'
import { dayClosed } from '../lib/review'
import { openBriefingTask, openNotifications, openUpcomingDay, revealTasks } from './briefingLinks'
import { useDateTimeFormat } from './DateTimePrefsProvider'
import { routePath } from './router'
import { useToday } from './useViews'

/** The briefing of Today or Upcoming from the live rows; null for any other view and until the tasks are read. */
export function useBriefing(view: 'today' | 'upcoming' | null): Briefing | null {
  const tasks = useLiveTasks()
  const projects = useLiveProjects()
  const today = useToday()
  const { dayStart } = useDateTimeFormat()
  const { dayLength } = useGridPrefs()
  const review = useReviewRow()
  // The bell's list: the newest in-app notifications, cached on the device (design D4).
  const notifications = useNotifications()
  return useMemo(() => (view && tasks
    ? briefingFacts({ view, today, tasks, projects, dayLength, notifications, closed: dayClosed(review, today), dayStart })
    : null), [view, tasks, projects, today, dayLength, notifications, review, dayStart])
}

/** A plain click (not one that opens a new tab) runs `go` instead of following the address. */
function follow(go: () => void) {
  return (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    go()
  }
}

/** One part of the sentence as a link: its text and tone unchanged, `label` saying where it leads. */
function PartLink({ href, label, go, part, className = '', children }: { href?: string; label: string | undefined; go: () => void; part: string; className?: string; children: ReactNode }) {
  return href
    ? <a href={href} className={`briefing-link ${className}`} aria-label={label} onClick={follow(go)} data-briefing-link={part}>{children}</a>
    : <button type="button" className={`briefing-link ${className}`} aria-label={label} onClick={go} data-briefing-link={part}>{children}</button>
}

/** A task named in the briefing: its own text, never translated, opening its page. */
function taskValues(task: BriefingTask) {
  return {
    title: task.title,
    task: (s: ReactNode) => (
      <PartLink href={routePath({ view: 'task', id: task.id })} label={t('{title}, open task', { title: task.title })} go={() => openBriefingTask(task.id)}
        part="task" className="user-text text-strong"><span data-briefing-task>{s}</span></PartLink>
    ),
  }
}

/** A whole clause as a link where it leads somewhere (briefing-links D2); a named task links itself. */
function linked(fact: BriefingFact, node: ReactNode): ReactNode {
  const text = typeof node === 'string' ? node : undefined
  switch (fact.kind) {
    case 'late':
      return fact.task ? node : (
        <PartLink href={routePath({ view: 'today' })} label={text && t('{text}, select them in Today', { text })} go={() => revealTasks(fact.ids)} part="late">{node}</PartLink>
      )
    case 'full':
      // Several full days link one by one (fullDays); one day links its whole clause.
      return fact.dates.length > 1 ? node
        : <PartLink href={routePath({ view: 'upcoming' })} label={text && t('{text}, open in Upcoming', { text })} go={() => openUpcomingDay(fact.dates[0])} part="full">{node}</PartLink>
    case 'replies':
      return fact.count === 1 && fact.name && fact.task ? node
        : <PartLink label={text && t('{text}, open notifications', { text })} go={openNotifications} part="replies">{node}</PartLink>
    case 'overfull':
      return node
  }
}

/**
 * "Friday and Monday are already full" with each day its own link to that day in
 * Upcoming (precision-polish-2): the language's list pattern and plural word the
 * sentence around per-day marks, which are then replaced by the links.
 */
function fullDays(dates: readonly string[], start: boolean): ReactNode {
  const marks = dates.map((_, i) => `\u0002${i}\u0002`)
  const text = t('{n, plural, one {{days} is already full} other {{days} are already full}}', { n: dates.length, days: formatList(marks) })
  const parts = text.split(/\u0002(\d+)\u0002/)
  // The first visible part takes the capital when the clause starts the sentence.
  const lead = parts.findIndex((p, j) => j % 2 === 1 || p !== '')
  return parts.map((part, i) => {
    const first = start && i === lead
    if (i % 2 === 0) return part ? <Fragment key={i}>{first ? sentenceStart(part) : part}</Fragment> : null
    const date = dates[Number(part)]
    const day = weekday(date)
    return (
      <PartLink key={i} href={routePath({ view: 'upcoming' })} label={t('{text}, open in Upcoming', { text: day })} go={() => openUpcomingDay(date)} part="full-day">
        {first ? sentenceStart(day) : day}
      </PartLink>
    )
  })
}

/** One clause of what stands out; `start` when it begins the sentence. */
function clause(fact: BriefingFact, start = false): ReactNode {
  switch (fact.kind) {
    case 'late':
      return fact.task
        ? t.rich('<task>{title}</task> is {days, plural, one {a day} other {# days}} late', { ...taskValues(fact.task), days: fact.days ?? 1 })
        : t('{n, plural, one {# task is} other {# tasks are}} late', { n: fact.count })
    case 'overfull':
      return t('today holds {planned} of work, more than your {length} day', { planned: formatMinutes(fact.planned), length: formatMinutes(fact.dayLength) })
    case 'full':
      return fact.dates.length > 1 ? fullDays(fact.dates, start)
        : t('{n, plural, one {{days} is already full} other {{days} are already full}}', { n: 1, days: weekday(fact.dates[0]) })
    case 'replies':
      if (fact.count > 1) return t('{n, plural, one {# reply is} other {# replies are}} waiting', { n: fact.count })
      if (fact.name && fact.task) return t.rich('{name} answered about <task>{title}</task>', { name: fact.name, ...taskValues(fact.task) })
      return fact.name ? t('{name} replied', { name: fact.name }) : t('{n, plural, one {# reply is} other {# replies are}} waiting', { n: 1 })
  }
}

const TONE: Record<BriefingFact['kind'], string> = { late: 'text-danger', overfull: 'text-warning', full: 'text-warning', replies: 'text-strong' }

/** Upper-cases the first letter of a clause that starts a sentence. */
function sentenceStart(node: ReactNode): ReactNode {
  return typeof node === 'string' && node ? node[0].toLocaleUpperCase() + node.slice(1) : node
}

/** The clauses joined by the language's list pattern ("a, b and c"), each in its tone, ending the sentence. */
function factsSentence(facts: readonly BriefingFact[]): ReactNode {
  const marks = facts.map((_, i) => `\u0001${i}\u0001`)
  const joined = formatList(marks, true)
  const parts = joined.split(/\u0001(\d+)\u0001/)
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part ? <Fragment key={i}>{part}</Fragment> : null
        const n = Number(part)
        const node = clause(facts[n], n === 0)
        return <span key={i} className={`font-medium ${TONE[facts[n].kind]}`} data-briefing-fact={facts[n].kind}>{linked(facts[n], n === 0 ? sentenceStart(node) : node)}</span>
      })}
      .
    </>
  )
}

function tomorrowSentence(tomorrow: BriefingTomorrow): ReactNode {
  if (tomorrow.count === 0 || !tomorrow.first) return t('Nothing is planned for tomorrow yet.')
  const values = { n: tomorrow.count, ...taskValues(tomorrow.first) }
  return tomorrow.first.time
    ? t.rich('Tomorrow starts with {n, plural, one {one task} other {# tasks}}; the first is <task>{title}</task> at {time}.', { ...values, time: formatTime(tomorrow.first.time) })
    : t.rich('Tomorrow starts with {n, plural, one {one task} other {# tasks}}; the first is <task>{title}</task>.', values)
}

const lead = (text: string) => <b className="font-semibold text-strong" data-briefing-lead>{text}</b>

/** The briefing as one paragraph's content: the bold lead, then the rest. */
export function BriefingText({ briefing }: { briefing: Briefing }) {
  useLanguageVersion()
  let head: string
  let rest: ReactNode
  switch (briefing.mode) {
    case 'today':
      if (briefing.facts.length) {
        head = t('{n, plural, one {One thing matters today.} =2 {Two things matter today.} =3 {Three things matter today.} other {# things matter today.}}', { n: briefing.facts.length })
        rest = factsSentence(briefing.facts)
      } else {
        head = t('Nothing stands out today.')
        rest = briefing.planned > 0
          ? t('{n, plural, one {One task is} other {# tasks are}} planned, about {time} in all.', { n: briefing.open, time: formatMinutes(briefing.planned) })
          : t('{n, plural, one {One task is} other {# tasks are}} planned.', { n: briefing.open })
      }
      break
    case 'done':
      head = t('All done for today.')
      rest = tomorrowSentence(briefing.tomorrow)
      break
    case 'clear':
      head = t('Nothing is planned for today.')
      rest = tomorrowSentence(briefing.tomorrow)
      break
    case 'upcoming':
      head = t('{n, plural, =0 {Nothing is planned for the next seven days.} one {One task in the next seven days.} other {# tasks in the next seven days.}}', { n: briefing.count })
      rest = briefing.count === 0 ? null : <>{briefing.facts.length ? factsSentence(briefing.facts) : t('Every day still has room.')} {tomorrowSentence(briefing.tomorrow)}</>
      break
  }
  return <span data-briefing={briefing.mode}>{lead(head)}{rest ? <> {rest}</> : null}</span>
}
