import type { Meta, StoryObj } from '@storybook/react-vite'
import { createProject, createTask, REVIEW_DEFAULTS, setTaskCompleted } from '../lib/ops'
import { db } from '../lib/db'
import type { EmailDigest, Task, TimeEntry } from '../lib/types'
import { DigestView, type DigestState } from './DigestCard'
import { CloseDay } from './review/CloseDay'
import { DoneForToday } from './review/DoneForToday'
import { PageBody, PageHeader } from '../ui'
import { ReviewView } from './review/ReviewView'
import { StatTile } from './review/charts'
import { StatsContent } from './review/StatsView'
import { HEX, project, seeded, task, TODAY, withClock, withSeed } from './stories/fixtures'

// Statistics, the weekly review and the digest card (OpenSpec changes
// stats-and-review and stats-dashboard): the screens on design tokens, light and
// dark, at 375 px and 1280 px, checked by the a11y and visual gates. Every chart
// has a summary and a table, so colour never carries meaning alone.
const meta: Meta = { title: 'Screens/Review and statistics' }
export default meta

const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()
const projects = [
  project({ id: 'work', name: 'Work', color: HEX.blue }), project({ id: 'home', name: 'Home', color: HEX.green }),
  project({ id: 'health', name: 'Health', color: HEX.red }),
]
const done = (id: string, day: number, projectId: string | null, due?: number): Task =>
  task({ id, title: `Done ${id}`, project_id: projectId, completed_at: at(day), created_at: at(day - 3), due: due ? { date: `2026-10-${String(due).padStart(2, '0')}` } : null })
const rows: Task[] = [
  done('a', 12, 'work'), done('b', 12, 'home'), done('c', 13, 'work', 12), done('d', 13, 'health'), done('e', 14, 'work'),
  done('f', 6, 'home'), done('g', 7, 'work'), done('h', 8, 'work', 6), done('i', 1, 'home'),
  task({ id: 'o1', title: 'Send the invoice to Northwind', project_id: 'work', due: { date: '2026-10-12' }, created_at: at(10) }),
  task({ id: 'o2', title: 'Book the dentist', project_id: 'health', due: { date: '2026-10-13' }, created_at: at(13) }),
]

// A year of work for the dense stories, deterministic (a small linear congruential generator).
function year(): { tasks: Task[]; entries: TimeEntry[] } {
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const tasks: Task[] = []
  const entries: TimeEntry[] = []
  const base = new Date(2026, 9, 14, 9).getTime()
  for (let back = 0; back < 371; back++) {
    const weekday = new Date(base - back * 86_400_000).getDay()
    const n = weekday === 0 || weekday === 6 ? Math.floor(rand() * 2) : Math.floor(rand() * 6)
    for (let k = 0; k < n; k++) {
      const id = `y${back}-${k}`
      const hour = 8 + Math.floor(rand() * 10)
      const p = ['work', 'work', 'home', 'health'][Math.floor(rand() * 4)]
      const est = rand() < 0.5 ? 30 + 30 * Math.floor(rand() * 3) : null
      const completed = base - back * 86_400_000 + (hour - 9) * 3_600_000
      const due = rand() < 0.6 ? new Date(completed + (rand() < 0.8 ? 0 : -2) * 86_400_000).toISOString().slice(0, 10) : null
      tasks.push(task({ id, title: `Task ${id}`, project_id: p, completed_at: completed, created_at: completed - 3 * 86_400_000, estimate_minutes: est, due: due ? { date: due } : null }))
      if (est && back < 60) entries.push({ id: `e${id}`, task_id: id, user_id: 'u-ada', started_at: completed - 2 * 3_600_000, ended_at: completed - 2 * 3_600_000 + est * (0.8 + rand()) * 60_000, device_id: 'd', note: '', created_at: completed, deleted_at: null } as TimeEntry)
    }
  }
  return { tasks, entries }
}
const dense = year()
const slipping = [
  { task: rows[9], moves: 4 },
  { task: rows[10], moves: 3 },
]

/** This week on a Wednesday: the tiles, keeping up per day, where time goes, the year, the hours. */
export const StatisticsThisWeek: StoryObj = {
  decorators: [withClock],
  render: () => <StatsContent tasks={rows} projects={projects} memberships={[]} me="u-ada" today={TODAY} weekStart={1} period="this-week" />,
}

/** This year on a busy account: monthly keeping up, tracked time, estimates and the slipping list. */
export const StatisticsThisYear: StoryObj = {
  decorators: [withClock],
  render: () => <StatsContent tasks={[...dense.tasks, ...rows]} entries={dense.entries} projects={projects} memberships={[]} me="u-ada" today={TODAY} weekStart={1} period="this-year" slipping={slipping} />,
}

/** Nothing completed yet: zeros and one line per panel instead of empty charts. */
export const StatisticsEmpty: StoryObj = {
  decorators: [withClock],
  render: () => <StatsContent tasks={[]} projects={[]} memberships={[]} me="u-ada" today={TODAY} weekStart={1} period="this-week" />,
}

async function seedReview() {
  seeded.work = await createProject({ name: 'Work', color: HEX.blue })
  seeded.garage = await createProject({ name: 'Garage', color: HEX.orange })
  await createTask({ title: 'Renew passport', priority: 2 })
  await createTask({ title: 'Reply to Mara about the workshop' })
  await createTask({ title: 'Send the invoice to Northwind', project_id: seeded.work, due: { date: '2026-10-12' }, priority: 1 })
  const sweep = await createTask({ title: 'Sweep the floor', project_id: seeded.garage })
  await setTaskCompleted(sweep, true)
  await db.review.put({ ...REVIEW_DEFAULTS, id: 'me', completed_at: new Date('2026-10-05T18:00:00').getTime(), _clock: {} })
}

/** The review on its first unfinished step, Get clear, with two Inbox tasks. */
/** The tile states (surfaces-v2 D10): up, down, the same, and "–" with its reason, at the display step. */
export const StatisticsTileStates: StoryObj = {
  render: () => (
    <dl className="grid grid-cols-1 gap-3 min-[21.25rem]:grid-cols-2 lg:grid-cols-4">
      <StatTile testId="up" label="Done" value="42" change={{ text: '+12 % vs last week', direction: 'up' }} note="including each day of a recurring task" />
      <StatTile testId="down" label="Tracked" value="6h 30m" change={{ text: '−1h 15m vs last week', direction: 'down' }} note="against 8h estimated" />
      <StatTile testId="same" label="On time" value="80 %" change={{ text: 'same as last week', direction: 'same' }} note="of 10 tasks with a due date" />
      <StatTile testId="none" label="On time" value="–" note="No due dates in this period" />
    </dl>
  ),
}

export const WeeklyReview: StoryObj = {
  ...withSeed(seedReview),
  render: () => <ReviewView userId="u-ada" />,
}

/** The Mind sweep: trigger prompts and a quick add into the Inbox. */
export const WeeklyReviewMindSweep: StoryObj = {
  ...withSeed(seedReview),
  render: () => <ReviewView userId="u-ada" step="sweep" />,
}

/** The project walk inside the step card: one project at a time. */
export const WeeklyReviewProjects: StoryObj = {
  ...withSeed(seedReview),
  render: () => <ReviewView userId="u-ada" step="projects" />,
}

/** Every step done: the all-clear card, and Finish review as the primary action. */
export const WeeklyReviewAllClear: StoryObj = {
  ...withSeed(async () => {}),
  render: () => <ReviewView userId="u-ada" />,
}

async function seedCloseDay() {
  seeded.work = await createProject({ name: 'Work', color: HEX.blue })
  seeded.garage = await createProject({ name: 'Garage', color: HEX.orange })
  await createTask({ title: 'Send the invoice to Northwind', project_id: seeded.work, due: { date: '2026-10-12' }, priority: 1 })
  await createTask({ title: 'Call the plumber about the leak', project_id: seeded.garage, due: { date: TODAY, time: '14:00' } })
  await createTask({ title: 'Reply to Mara about the workshop', due: { date: TODAY } })
  const done = [
    await createTask({ title: 'Book the dentist', due: { date: TODAY } }),
    await createTask({ title: 'Renew passport', due: { date: TODAY } }),
    await createTask({ title: 'Sweep the floor', project_id: seeded.garage, due: { date: TODAY } }),
  ]
  for (const id of done) await setTaskCompleted(id, true)
  await db.review.put({ ...REVIEW_DEFAULTS, id: 'me', focus_date: TODAY, focus: done.slice(0, 2).join(','), _clock: {} })
}

/** Close the day's first step (close-the-day-v2 D5): the day's figures as one sentence, Back and Next inside the card. */
export const CloseTheDaySummary: StoryObj = {
  name: 'Close the day · how it went',
  ...withSeed(seedCloseDay),
  render: () => <CloseDay />,
}

/** Close the day on Carry over (close-the-day-v2 D2): one task on the card with its five decisions, the decisions so far below. */
export const CloseTheDay: StoryObj = {
  name: 'Close the day',
  ...withSeed(seedCloseDay),
  render: () => <CloseDay initialStep="carry" />,
}

/** Close the day's last step: the note for tomorrow morning with its preview, and the primary "Close the day". */
export const CloseTheDayNote: StoryObj = {
  name: 'Close the day · note',
  ...withSeed(seedCloseDay),
  render: () => <CloseDay initialStep="note" />,
}

/** Done for today (moments-and-onboarding D6): the calm final state after the close. */
export const CloseTheDayDone: StoryObj = {
  name: 'Close the day · done for today',
  render: () => (
    <PageBody width="list">
      <PageHeader title="Close the day" icon="moon" meta="Day closed, 18:42" />
      <DoneForToday figures={{ time: '18:42', planned: 9, done: 5, carried: { tomorrow: 3, day: 0, someday: 0, keep: 0, done: 0 }, kept: 1, note: 'Start with the invoice' }}
        onBack={() => {}} onReopen={() => {}} />
    </PageBody>
  ),
}

const digest: EmailDigest = {
  available: true, encryption: false, enabled: true, weekday: 5, hour: 7, timeZone: 'Europe/Zurich', language: 'de',
  nextSendAt: new Date('2026-10-16T07:00:00').getTime(), lastOutcome: 'sent', lastSentFor: '2026-10-09', lastAttemptAt: null,
}
const noop = () => {}
const card = (state: DigestState, extra: { editing?: boolean; demo?: boolean } = {}) => (
  <DigestView state={state} demo={!!extra.demo} busy={false} editing={!!extra.editing} draft={{ weekday: 5, hour: 7 }}
    capture={{ timeZone: 'Europe/Zurich', language: 'de' }} error={null}
    onToggle={noop} onEdit={noop} onCancel={noop} onDraft={noop} onSave={noop} />
)

export const DigestOn: StoryObj = { decorators: [withClock], render: () => card({ kind: 'ready', digest }) }
export const DigestChange: StoryObj = { decorators: [withClock], render: () => card({ kind: 'ready', digest: { ...digest, enabled: false, lastOutcome: undefined } }, { editing: true }) }
export const DigestUnavailable: StoryObj = { decorators: [withClock], render: () => card({ kind: 'ready', digest: { ...digest, available: false } }) }
export const DigestEncrypted: StoryObj = { decorators: [withClock], render: () => card({ kind: 'ready', digest: { ...digest, encryption: true } }) }
export const DigestOffline: StoryObj = { decorators: [withClock], render: () => card({ kind: 'offline' }) }
