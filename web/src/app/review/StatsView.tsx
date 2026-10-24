// Statistics (OpenSpec changes `stats-and-review` and `stats-dashboard`): a dashboard
// of what was done, when, and where the time went, computed on this device from the
// local rows by lib/dashboard.ts. It sends nothing and writes nothing, so it works
// offline and every synced device shows the same numbers, except "keeps slipping",
// which reads this device's own activity record and says so (design D5).
import { useLiveQuery } from 'dexie-react-hooks'
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Menu, MenuItem, PageBody, PageHeader } from '../../ui'
import { NO_TASK_ROWS, useAllLabels, useAllProjects, useAllTaskRows, useMemberships } from '../../lib/localData'
import { currentDayStart, dateLocaleOf, formatDate } from '../../lib/dates'
import { currentUserId } from '../../lib/sharing'
import { comparisonOf, PERIOD_KINDS, PERIOD_LABELS, periodFor, sharedIds, type DashboardPeriod, type Period } from '../../lib/stats'
import { buildModel, dashboardOf, type Dashboard, type HourGrid } from '../../lib/dashboard'
import { slippingFrom, slipRows } from '../../lib/statsSlipping'
import type { Label, Membership, Project, Task, TimeEntry } from '../../lib/types'
import { useDateTimeFormat } from '../DateTimePrefsProvider'
import { HelpLink } from '../help/HelpLink'
import { setPanelTaskId } from '../panel'
import { useToday } from '../useViews'
import { ChartFigure, DotGrid, EmptyPanel, HBars, Heatmap, LineChart, StatTile, type Direction, type HeatDay, type LinePoint } from './charts'
import { formatMinutes } from '../../lib/duration'
import { useLiveEntries, useMinuteNow } from '../../lib/timeEntries'
import { useTimeExport } from './timeExport'
import { t } from '../../lib/i18n'

const PERIOD_KEY = 'ot.stats.period'
/** The stored period; a value this version no longer offers (the 4 and 12 weeks) opens on this week. */
export function readPeriod(): DashboardPeriod {
  try {
    const v = localStorage.getItem(PERIOD_KEY)
    return (PERIOD_KINDS as readonly string[]).includes(v ?? '') ? (v as DashboardPeriod) : 'this-week'
  } catch {
    return 'this-week'
  }
}
function writePeriod(p: DashboardPeriod): void {
  try { localStorage.setItem(PERIOD_KEY, p) } catch { /* device convenience only */ }
}

/** The period chooser: a radio group with roving focus; the arrow keys change the period. */
export function PeriodChooser({ value, onChange, chooserRef }: { value: DashboardPeriod; onChange: (p: DashboardPeriod) => void; chooserRef?: React.Ref<HTMLDivElement> }) {
  const refs = useRef<Partial<Record<DashboardPeriod, HTMLButtonElement | null>>>({})
  const move = (e: KeyboardEvent) => {
    const i = PERIOD_KINDS.indexOf(value)
    const n = PERIOD_KINDS.length
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    onChange(PERIOD_KINDS[next])
    refs.current[PERIOD_KINDS[next]]?.focus()
  }
  return (
    <div ref={chooserRef} role="radiogroup" aria-label={t('Period')} onKeyDown={move} className="inline-flex flex-wrap gap-1 rounded-control border border-default bg-sunken p-1" data-period-chooser>
      {PERIOD_KINDS.map((p) => {
        const on = p === value
        return (
          <button key={p} ref={(el) => { refs.current[p] = el }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
            onClick={() => onChange(p)}
            className={`rounded-chip px-3 py-1 text-meta font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${on ? 'bg-surface text-default shadow-1' : 'text-muted hover:text-default'}`}>
            {PERIOD_LABELS[p]}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- wording

/** What a period is compared with, in words. */
function versus(kind: DashboardPeriod): string {
  switch (kind) {
    case 'this-month': return t('vs last month')
    case 'this-quarter': return t('vs last quarter')
    case 'this-year': return t('vs last year')
    case 'last-week': return t('vs the week before')
    default: return t('vs last week')
  }
}

/** A change in words and a direction, never judged good or bad (D2). */
function change(value: number, previous: number, vs: string, unit: 'percent' | 'points' | 'count' = 'percent', format: (n: number) => string = String): { text: string; direction: Direction } {
  const diff = value - previous
  const direction: Direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same'
  if (diff === 0) return { text: t('No change {vs}', { vs }), direction }
  const sign = diff > 0 ? '+' : '−'
  if (unit === 'points') return { text: t('{sign}{n} pts {vs}', { sign, n: Math.abs(diff), vs }), direction }
  if (unit === 'count' || previous === 0) return { text: `${sign}${format(Math.abs(diff))} ${vs}`, direction }
  return { text: `${sign}${Math.round((Math.abs(diff) / previous) * 100)} % ${vs}`, direction }
}

const weekdayName = (wd: number, style: 'short' | 'long') =>
  new Intl.DateTimeFormat(dateLocaleOf(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 11 + wd)))
const monthName = (iso: string, style: 'short' | 'long', year = false) =>
  new Intl.DateTimeFormat(dateLocaleOf(), { month: style, ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 7)}-15T12:00:00Z`))
const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`

// ---------------------------------------------------------------- the dashboard

interface Slip {
  task: Task
  moves: number
}

/** The screen's content for given rows; the view below feeds it live rows. */
export function StatsContent({ tasks, projects, labels = [], memberships, me, today, weekStart, dayStart = 0, period, entries, now, slipping = [] }: {
  tasks: readonly Task[]
  projects: readonly Project[]
  labels?: readonly Label[]
  memberships: readonly Membership[]
  me: string | null
  today: string
  weekStart: number
  dayStart?: number
  period: DashboardPeriod
  /** Time entries this device holds (time-tracking); the user's own count. */
  entries?: readonly TimeEntry[]
  now?: number
  /** "Keeps slipping", from this device's activity record. */
  slipping?: readonly Slip[]
}) {
  // One pass over the rows; a period change only slices it (design D8).
  const model = useMemo(() => buildModel({ tasks, projects, labels, shared: sharedIds(memberships), me, today, weekStart, dayStart, entries, now }),
    [tasks, projects, labels, memberships, me, today, weekStart, dayStart, entries, now])
  const range = useMemo(() => periodFor(period, today, weekStart), [period, today, weekStart])
  const dash = useMemo(() => dashboardOf(model, range, comparisonOf(range, weekStart)), [model, range, weekStart])
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const vs = versus(period)
  return (
    <div className="space-y-4" data-stats-content>
      <Tiles dash={dash} vs={vs} />
      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2" data-testid="stats-panels">
        <KeepingUp dash={dash} range={range} />
        <WhereTimeGoes dash={dash} />
        <YearOfDone dash={dash} weekStart={weekStart} streak={dash.tiles.streak.current} />
        <WhenDone grid={dash.hours} />
        <EstimatesPanel dash={dash} />
        <KeepsSlipping slipping={slipping} projectOf={(task) => (task.project_id ? names.get(task.project_id) ?? t('Project') : t('Inbox'))} />
      </div>
      <p className="flex flex-wrap items-center gap-2 text-meta text-muted" data-testid="stats-local">
        {t('{date} – {date2}. Computed on this device from your tasks; nothing is sent anywhere.', { date: formatDate(range.start, 'long'), date2: formatDate(range.end, 'long') })}
        <HelpLink screen="stats" topic={t('Statistics')} />
      </p>
    </div>
  )
}

function Tiles({ dash, vs }: { dash: Dashboard; vs: string }) {
  const { done, onTime, streak, tracked } = dash.tiles
  const trackedNote = [
    tracked.estimate > 0 ? t('against {time} estimated', { time: formatMinutes(tracked.estimate) }) : '',
    tracked.noEstimate > 0 ? t('{n, plural, one {# tracked task has no estimate} other {# tracked tasks have no estimate}}', { n: tracked.noEstimate }) : '',
  ].filter(Boolean).join(' · ')
  return (
    <dl className="grid grid-cols-1 gap-3 min-[21.25rem]:grid-cols-2 lg:grid-cols-4" data-testid="stats-tiles">
      <StatTile testId="done" label={t('Done')} value={String(done.value)} change={change(done.value, done.previous, vs)} note={t('including each day of a recurring task')} />
      {onTime.value === null
        ? <StatTile testId="on-time" label={t('On time')} value="–" note={t('No due dates in this period')} />
        : <StatTile testId="on-time" label={t('On time')} value={`${onTime.value} %`}
          change={onTime.previous === null ? undefined : change(onTime.value, onTime.previous, vs, 'points')}
          note={t('{n, plural, one {of # task with a due date} other {of # tasks with a due date}}', { n: onTime.dated })} />}
      <StatTile testId="streak" label={t('Streak')} value={t('{n, plural, one {# day} other {# days}}', { n: streak.current })}
        note={t('Best: {n, plural, one {# day} other {# days}} in the last 53 weeks', { n: streak.best })} />
      <StatTile testId="tracked" label={t('Tracked')} value={formatMinutes(tracked.minutes)}
        change={tracked.minutes === 0 && tracked.previous === 0 ? undefined : change(tracked.minutes, tracked.previous, vs, 'percent', formatMinutes)}
        note={trackedNote || (tracked.minutes === 0 ? t('your own time entries') : undefined)} />
    </dl>
  )
}

function KeepingUp({ dash, range }: { dash: Dashboard; range: Period }) {
  const title = t('Am I keeping up?')
  const short = range.kind === 'this-week' || range.kind === 'last-week'
  const points: LinePoint[] = dash.keepingUp.map((b) => ({
    a: b.done, b: b.created,
    label: range.unit === 'month' ? monthName(b.start, 'short') : short ? weekdayName(new Date(`${b.start}T12:00:00Z`).getUTCDay(), 'short') : formatDate(b.start, 'compact'),
    name: range.unit === 'month' ? monthName(b.start, 'long', true) : range.unit === 'week' ? t('Week of {date}', { date: formatDate(b.start, 'long') }) : formatDate(b.start, 'heading'),
  }))
  const done = points.reduce((n, p) => n + p.a, 0)
  const created = points.reduce((n, p) => n + p.b, 0)
  if (done === 0 && created === 0) {
    return <EmptyPanel title={title} testId="keeping-up">{t('Nothing completed or created in this period yet.')}</EmptyPanel>
  }
  const best = points.reduce((a, p) => (p.a > a.a ? p : a), points[0])
  const summary = t('{done} completed and {created} created in this period; most completed: {name}, {n}.', { done, created, name: best.name, n: best.a })
  return (
    <ChartFigure title={title} summary={summary} testId="keeping-up"
      table={{ head: [t('Period'), t('Completed'), t('Created')], rows: points.map((p) => [p.name, String(p.a), String(p.b)]) }}>
      <LineChart points={points} aName={t('Completed')} bName={t('Created')} summary={summary} />
    </ChartFigure>
  )
}

function WhereTimeGoes({ dash }: { dash: Dashboard }) {
  const title = t('Where does my time go?')
  const { kind, rows } = dash.time
  if (rows.length === 0) return <EmptyPanel title={title} testId="time">{t('No time tracked and nothing completed in this period.')}</EmptyPanel>
  const text = (v: number) => (kind === 'tracked' ? formatMinutes(v) : String(v))
  const bars = rows.map((r) => ({ label: r.name, value: r.value, text: text(r.value) }))
  const summary = kind === 'tracked'
    ? t('Tracked time per project: {values}.', { values: bars.map((b) => `${b.label} ${b.text}`).join(', ') })
    : t('Completed tasks per project: {values}.', { values: bars.map((b) => `${b.label} ${b.text}`).join(', ') })
  return (
    <ChartFigure title={title} summary={summary} testId="time" note={kind === 'tracked' ? undefined : t('No time tracked: completed tasks per project')}
      table={{ head: [t('Project'), kind === 'tracked' ? t('Tracked') : t('Completed')], rows: bars.map((b) => [b.label, b.text]) }}>
      <HBars bars={bars} summary={summary} />
    </ChartFigure>
  )
}

function YearOfDone({ dash, weekStart, streak }: { dash: Dashboard; weekStart: number; streak: number }) {
  const title = t('A year of done tasks')
  const { weeks, total, busiest } = dash.heatmap
  const tip = useCallback((d: HeatDay) => t('{date}: {n} completed', { date: formatDate(d.date, 'long'), n: d.count }), [])
  const days = weeks.flat().filter((d): d is HeatDay => d !== null)
  const summary = busiest
    ? t('{total} completed in the last 53 weeks; busiest day {date} with {n}; current streak {streak, plural, one {# day} other {# days}}.', { total, date: formatDate(busiest.date, 'long'), n: busiest.count, streak })
    : t('Nothing completed in the last 53 weeks.')
  // One row per month with the completions per day of the month.
  const months = new Map<string, string[]>()
  for (const d of days) {
    const key = d.date.slice(0, 7)
    const row = months.get(key) ?? Array.from({ length: 31 }, () => '')
    row[Number(d.date.slice(8)) - 1] = String(d.count)
    months.set(key, row)
  }
  const columnLabels = weeks.map((col) => {
    const first = col.find((d) => d && Number(d.date.slice(8)) <= 7 && d.date.slice(8) === '01') ?? col.find((d) => d?.date.slice(8) === '01')
    return first ? monthName(first.date, 'short') : ''
  })
  return (
    <ChartFigure title={title} summary={summary} wide testId="heatmap"
      table={{ head: [t('Month'), ...Array.from({ length: 31 }, (_, i) => String(i + 1))], rows: [...months.entries()].map(([m, r]) => [monthName(m, 'long', true), ...r]) }}>
      <Heatmap weeks={weeks} tip={tip} summary={summary} columnLabels={columnLabels}
        rowLabels={Array.from({ length: 7 }, (_, i) => weekdayName((weekStart + i) % 7, 'short'))} />
    </ChartFigure>
  )
}

function WhenDone({ grid }: { grid: HourGrid }) {
  const title = t('When do I get things done?')
  const tip = useCallback((r: number, c: number) => t('{day} {hour}: {n} completed', { day: weekdayName(grid.weekdays[r], 'long'), hour: hourText(grid.hours[c]), n: grid.counts[r][c] }), [grid])
  if (grid.total === 0) return <EmptyPanel title={title} testId="hours">{t('Complete a few tasks in this period to see when you work best.')}</EmptyPanel>
  let best = { r: 0, c: 0 }
  grid.counts.forEach((row, r) => row.forEach((n, c) => { if (n > grid.counts[best.r][best.c]) best = { r, c } }))
  const summary = t('{total} completions by weekday and hour; most often on {day} at {hour}.', { total: grid.total, day: weekdayName(grid.weekdays[best.r], 'long'), hour: hourText(grid.hours[best.c]) })
  return (
    <ChartFigure title={title} summary={summary} testId="hours"
      table={{ head: [t('Day'), ...grid.hours.map(hourText)], rows: grid.counts.map((row, r) => [weekdayName(grid.weekdays[r], 'long'), ...row.map(String)]) }}>
      <DotGrid counts={grid.counts} max={grid.max} tip={tip} summary={summary}
        rowLabels={grid.weekdays.map((d) => weekdayName(d, 'short'))} columnLabels={grid.hours.map((h) => String(h).padStart(2, '0'))} />
    </ChartFigure>
  )
}

const times = (ratio: number) => `${ratio.toFixed(1)}×`

function EstimatesPanel({ dash }: { dash: Dashboard }) {
  const title = t('How good are my estimates?')
  const e = dash.estimates
  if (!e.ok) {
    return <EmptyPanel title={title} testId="estimates">{t('Needs at least three completed tasks with an estimate and tracked time; {n} so far.', { n: e.count })}</EmptyPanel>
  }
  const sentence = t('Most tasks take {ratio} their estimate ({n} tasks).', { ratio: times(e.median), n: e.count })
  const bars = e.groups.map((g) => ({ label: g.kind === 'label' ? `@${g.name}` : g.name, value: g.median, text: times(g.median) }))
  const summary = bars.length ? `${sentence} ${t('Furthest from the estimate: {values}.', { values: bars.map((b) => `${b.label} ${b.text}`).join(', ') })}` : sentence
  return (
    <ChartFigure title={title} summary={summary} testId="estimates"
      table={{ head: [t('Group'), t('Tracked ÷ estimate'), t('Tasks')], rows: [[t('All tasks'), times(e.median), String(e.count)], ...e.groups.map((g, i) => [bars[i].label, bars[i].text, String(g.count)])] }}>
      <p className="mb-3 text-body text-default" data-estimate-median>{sentence}</p>
      {bars.length > 0 && <HBars bars={bars} summary={summary} />}
    </ChartFigure>
  )
}

function KeepsSlipping({ slipping, projectOf }: { slipping: readonly Slip[]; projectOf: (task: Task) => string }) {
  const title = t('What keeps slipping?')
  const note = t("Based on this device's history")
  if (slipping.length === 0) {
    return <EmptyPanel title={title} testId="slipping">{t('No open task was moved later three times or more in the last 90 days, on this device.')}</EmptyPanel>
  }
  return (
    <section className="ui-section-flat ui-panel-flat min-w-0" aria-label={title} data-panel="slipping">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-body font-semibold text-default">{title}</h2>
        <p className="text-meta text-muted">{note}</p>
      </div>
      <ul className="divide-y divide-(--ot-border)">
        {slipping.map(({ task, moves }) => (
          <li key={task.id}>
            <button type="button" className="flex w-full flex-wrap items-baseline justify-between gap-x-3 rounded-control px-1 py-2 text-left text-body hover:bg-sunken focus-visible:outline-2 focus-visible:outline-focus"
              onClick={() => setPanelTaskId(task.id)} data-slipping={task.id}>
              <span className="min-w-0 truncate text-default">{task.title}</span>
              <span className="text-meta text-muted">{t('{project} · moved {n, plural, one {# time} other {# times}}', { project: projectOf(task), n: moves })}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function StatsView() {
  const today = useToday()
  const weekStart = useDateTimeFormat().resolved.weekStart
  const tasks = useAllTaskRows()
  // Deleted projects too: their tasks are in the Trash with them and must not count.
  const projects = useAllProjects()
  const labels = useAllLabels()
  const memberships = useMemberships()
  const me = useLiveQuery(() => currentUserId(), [], null)
  const entries = useLiveEntries()
  const now = useMinuteNow(entries.some((e) => e.ended_at === null))
  // This device's due-date changes, read once per open (design D5, D8).
  const read = useLiveQuery(() => slipRows(Date.now()), [], null)
  const rows = useMemo(() => read ?? [], [read])
  // The panels wait for the tasks and this device's date changes: panels that fill in stages move the page (ux-fixes-phone, audit M12).
  const ready = tasks !== NO_TASK_ROWS && read !== null
  const slipping = useMemo(() => slippingFrom(rows, { tasks, projects, shared: sharedIds(memberships), me }, Date.now()), [rows, tasks, projects, memberships, me])
  const [period, setPeriod] = useState<DashboardPeriod>(readPeriod)
  const exportCsv = useTimeExport(entries, tasks, projects, period, today, weekStart)
  const title = useRef<HTMLHeadingElement>(null)
  // The heading takes focus, so Tab reaches the period chooser first (statistics "Keyboard").
  useEffect(() => { title.current?.focus() }, [])
  return (
    <PageBody width="full" className="max-w-5xl" data-stats-page>
      <PageHeader title={t('Statistics')} icon="chart-column" titleRef={title} titleTabIndex={-1}>
        <div className="flex flex-wrap items-center gap-2" data-stats-header-row>
          <PeriodChooser value={period} onChange={(p) => { setPeriod(p); writePeriod(p) }} />
          {/* After the period chooser, which stays the first stop (statistics "Statistics screen"). */}
          <span className="ml-auto">
            <Menu kind="menu" label={t('More actions')} trigger={<Icon name="ellipsis" />} triggerClassName="ui-btn ui-btn--ghost ui-btn--sm touch-target px-2 py-1" width="sm:w-64" align="end">
              <MenuItem label={t('Export time entries')} icon="download" description={t('A CSV of the period, made on this device')} onSelect={exportCsv} data-export-time />
            </Menu>
          </span>
        </div>
      </PageHeader>
      {ready && <StatsContent tasks={tasks} projects={projects} labels={labels} memberships={memberships} me={me} today={today} weekStart={weekStart}
        dayStart={currentDayStart()} entries={entries} now={now} period={period} slipping={slipping} />}
    </PageBody>
  )
}
