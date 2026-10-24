import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createSubtask, createTask, setTaskCompleted } from '../lib/ops'
import { seedBase, seedCounts, seeded, storyUser, TODAY, withSeed } from './stories/fixtures'
import { TaskListView } from './TaskListView'

// Expanded rows (OpenSpec change row-expand, task-list-presentation "Expanded rows"):
// Today with one row's details open under it, as Show details (a fine pointer from
// 768 px) or the row's disclosure (narrower) opens them: the notes, the facet lines,
// the subtasks with their checkboxes, the counts and Open task, indented under the title.
const meta: Meta = { title: 'Screens/Expanded row' }
export default meta

async function seedExpanded(): Promise<void> {
  await seedBase()
  await createTask({ title: 'Book the dentist', due: { date: TODAY, time: '08:30' }, project_id: seeded.health, labels: [seeded.errand] })
  const quotes = await createTask({
    title: 'Get three quotes for the kitchen', due: { date: TODAY, time: '10:00' }, project_id: seeded.home, priority: 1, estimate_minutes: 60,
    labels: [seeded.waiting], deadline: '2026-10-20',
    description: 'Ask about **lead times** and the payment schedule. Budget is around 12k, including the worktop and fitting.',
  })
  const first = await createSubtask(quotes, 'Call Northside Kitchens')
  await createSubtask(quotes, 'Email Brightwood for a site visit')
  await createSubtask(quotes, 'Compare payment schedules')
  await setTaskCompleted(first, true)
  await seedCounts(quotes)
  await createTask({ title: 'Water the plants', due: { date: TODAY }, recurrence: 'every 3 days', project_id: seeded.home })
}

/** Opens the details of "Get three quotes for the kitchen" the way a pointer does, then leaves the row at rest. */
function Expand({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    let stop = false
    const tick = () => {
      if (stop) return
      const el = root.current
      const li = [...(el?.querySelectorAll<HTMLElement>('li[data-task-id]') ?? [])].find((r) => r.querySelector('[data-row-title]')?.textContent === 'Get three quotes for the kitchen')
      const details = el?.querySelector('[data-row-details] [data-subtasks]')
      if (details) { (document.activeElement as HTMLElement | null)?.blur(); setDone(true); return }
      const button = li && (li.querySelector<HTMLButtonElement>('[data-row-action="details"]') ?? li.querySelector<HTMLButtonElement>('[data-row-expand] button'))
      if (button && li.getAttribute('data-expanded') === null) {
        // The visible control: the cluster's from 768 px on a fine pointer, else the row's disclosure.
        const wide = matchMedia('(min-width: 768px) and (pointer: fine)').matches
        ;(wide ? li.querySelector<HTMLButtonElement>('[data-row-action="details"]') : li.querySelector<HTMLButtonElement>('[data-row-expand] button'))?.click()
      }
      setTimeout(tick, 50)
    }
    tick()
    return () => { stop = true }
  }, [])
  return <div ref={root}>{children}{!done && <span data-story-pending />}</div>
}

/** Today with the kitchen quotes expanded: notes, When / Where / How, three subtasks (one done), 2 comments, 1 attachment. */
export const TodayExpanded: StoryObj = {
  ...withSeed(seedExpanded),
  render: () => (
    <div className="-m-4 h-[44rem] overflow-y-auto bg-canvas">
      <Expand><TaskListView route={{ view: 'today' }} userId={storyUser.id} userRole={storyUser.role} /></Expand>
    </div>
  ),
}
