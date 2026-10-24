// Built-in assistant skills (OpenSpec change assistant-skills): the list the
// server offers, the device's working day for "Plan my week", and how pasted
// text is told apart from a typed question. The skills' instructions stay on
// the server; the client only names a skill by id.
import { useEffect, useState } from 'react'
import { api } from './api'
import { DEFAULT_GRID_PREFS, GRID_PREFS_META_KEY, normalizeGridPrefs, type GridPrefs } from './calendar'
import { getMeta } from './db'
import { assistantStatus } from './assistantStatus'

export interface AssistantSkill {
  id: string
  name: string
  description: string
  example: string
  result: 'changes' | 'answer'
  subject?: 'selection' | 'pasted'
}

let cache: AssistantSkill[] | null = null
const listeners = new Set<(s: AssistantSkill[]) => void>()

/** Fetches the skill list (empty when the assistant is not available to you). */
export async function loadSkills(): Promise<AssistantSkill[]> {
  try {
    cache = (await api.assistantSkills()).skills
  } catch {
    cache ??= []
  }
  // An encrypted account in device mode runs the skills of the generated manifest (assistant-on-device D11).
  if (!cache.length && assistantStatus()?.mode === 'device') {
    try {
      const { manifest } = await import('./assistantDevice/manifest')
      cache = manifest.skills.map(({ id, name, description, example, result, subject }) => ({ id, name, description, example, result, ...(subject ? { subject } : {}) }))
    } catch {
      // The chunk could not load (offline after an update): no starters.
    }
  }
  listeners.forEach((fn) => fn(cache!))
  return cache
}

/** The skills, loaded once per session and shared. */
export function useAssistantSkills(enabled = true): AssistantSkill[] {
  const [skills, setSkills] = useState<AssistantSkill[]>(cache ?? [])
  useEffect(() => {
    if (!enabled) return
    listeners.add(setSkills)
    if (cache === null) void loadSkills()
    else setSkills(cache)
    return () => { listeners.delete(setSkills) }
  }, [enabled])
  return enabled ? skills : []
}

/** Test hook. */
export function resetSkills(list: AssistantSkill[] | null = null): void {
  cache = list
}

/** The device's working day (Settings → Calendar), for plan-week. */
export async function workday(): Promise<Pick<GridPrefs, 'startHour' | 'endHour' | 'dayLength'>> {
  let prefs = DEFAULT_GRID_PREFS
  try {
    prefs = normalizeGridPrefs(await getMeta<unknown>(GRID_PREFS_META_KEY, null))
  } catch {
    // The defaults.
  }
  // Only the working day: the server refuses fields it does not know (the Plan's span stays on the device).
  return { startHour: prefs.startHour, endHour: prefs.endHour, dayLength: prefs.dayLength }
}

/** A paste becomes untrusted material when it is long or has line breaks (design D3). */
export function isMaterial(text: string): boolean {
  return text.length > 280 || /\r|\n/.test(text.trim())
}
