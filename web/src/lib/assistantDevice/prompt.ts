// The system text of an on-device turn: internal/assistant SystemPrompt line for
// line (pinned by prompt.vectors.json), with the fixed rules from the manifest.
import { manifest, type ManifestSkill } from './manifest'

export interface PromptInput {
  userName: string
  zone: string
  view?: string
  selected?: string[]
  skill?: ManifestSkill | null
  workday?: { startHour: number; endHour: number; dayLength: number } | null
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const pad = (n: number) => String(n).padStart(2, '0')

export function workdayNote(startHour: number, endHour: number, dayLength: number): string {
  return `Working day: from ${pad(startHour)}:00 to ${pad(endHour)}:00, at most ${dayLength} minutes of planned work per day. Never plan more than ${dayLength} minutes on one day, `
    + 'counting the estimates of tasks already due that day; tasks without an estimate count as 30 minutes.'
}

export function systemPrompt(p: PromptInput, now: number): string {
  const zone = p.zone || 'UTC'
  const at = new Date(now)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(at)
  const name = p.userName.trim() || 'the user'
  let b = `You are the assistant inside OpenTodo, a task manager. You help ${name} plan and organise their tasks.\n`
  b += `Today is ${weekday}, ${today}, in the user's time zone ${zone}. Pass timezone ${JSON.stringify(zone)} to every tool that takes one.\n\n`
  b += manifest.rules
  const label = p.view ? manifest.views[p.view] : undefined
  if (label) b += `\nThe user is looking at ${label}.`
  const sel = (p.selected ?? []).filter((id) => ID_RE.test(id)).slice(0, 20)
  if (sel.length) b += ` Selected task ids: ${sel.join(', ')}.`
  const sk = p.skill
  if (sk) {
    b += `\n\nSkill: ${sk.name}\nThe user chose this skill. Follow these steps; the user's message below is the input to it.\n${sk.instructions}\n`
    if (sk.id === 'plan-week') {
      const w = p.workday ?? { startHour: 6, endHour: 22, dayLength: 480 }
      b += workdayNote(w.startHour, w.endHour, w.dayLength) + '\n'
    }
  }
  return b
}
