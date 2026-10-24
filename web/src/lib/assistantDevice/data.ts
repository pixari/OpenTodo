// What the on-device assistant's tools read (assistant-on-device D8): this
// device's own decrypted rows, without deleted items and projects kept away from
// assistants, with the changes planned earlier in the same turn laid over them
// (the draft overlay of the server's loop, internal/agenttools snapshot.apply).
import { db, getMeta } from '../db'
import { AGENT_EXCLUSIONS_KEY } from '../agentAccess'
import { membershipMap, currentUserId } from '../sharing'
import type { Membership } from '../types'
import type { ProposedChange } from '../assistantTypes'

export type Row = Record<string, unknown>

export interface Snapshot {
  userId: string
  projects: Map<string, Row>
  projList: Row[]
  labels: Map<string, Row>
  labelList: Row[]
  sections: Map<string, Row>
  tasks: Row[]
  byId: Map<string, Row>
  memberships: Map<string, Membership>
}

export const str = (r: Row | undefined, f: string): string => {
  const v = r?.[f]
  return typeof v === 'string' ? v : ''
}
export const num = (r: Row | undefined, f: string): number => {
  const v = r?.[f]
  return typeof v === 'number' ? v : 0
}
export const isDeleted = (r: Row): boolean => r.deleted_at !== null && r.deleted_at !== undefined && r.deleted_at !== 0 && r.deleted_at !== false
export const isOpen = (t: Row): boolean => !t.completed_at
export const list = (r: Row | undefined, f: string): string[] => (Array.isArray(r?.[f]) ? (r![f] as unknown[]).filter((x): x is string => typeof x === 'string') : [])

/** Projects kept away, inherited from any ancestor (agent-planning-fields D9). */
function keptAwaySet(projects: Row[], cached: string[]): Set<string> {
  const own = new Set(cached)
  const parent = new Map(projects.map((p) => [str(p, 'id'), str(p, 'parent_id')]))
  const out = new Set<string>()
  for (const p of projects) {
    let id = str(p, 'id')
    for (let depth = 0; id && depth < 32; depth++) {
      if (own.has(id)) {
        out.add(str(p, 'id'))
        break
      }
      id = parent.get(id) ?? ''
    }
  }
  for (const id of own) out.add(id)
  return out
}

/** Loads the snapshot and lays the overlay over it. */
export async function loadSnapshot(overlay: ProposedChange[] = []): Promise<Snapshot> {
  const [projects, labels, sections, tasks, memberships, me, cached] = await Promise.all([
    db.projects.toArray(), db.labels.toArray(), db.sections.toArray(), db.tasks.toArray(), membershipMap(), currentUserId(),
    getMeta<string[]>(AGENT_EXCLUSIONS_KEY, []).catch(() => [] as string[]),
  ])
  const keptAway = keptAwaySet(projects as unknown as Row[], Array.isArray(cached) ? cached : [])
  const snap: Snapshot = {
    userId: me ?? '', projects: new Map(), projList: [], labels: new Map(), labelList: [], sections: new Map(), tasks: [], byId: new Map(), memberships,
  }
  for (const p of projects as unknown as Row[]) {
    if (isDeleted(p) || keptAway.has(str(p, 'id'))) continue
    snap.projList.push(p)
  }
  for (const l of labels as unknown as Row[]) if (!isDeleted(l)) snap.labelList.push(l)
  for (const s of sections as unknown as Row[]) if (!isDeleted(s) && !keptAway.has(str(s, 'project_id'))) snap.sections.set(str(s, 'id'), s)
  snap.tasks = (tasks as unknown as Row[]).filter((t) => !isDeleted(t) && !keptAway.has(str(t, 'project_id')))
  applyOverlay(snap, overlay)
  return snap
}

/** Lays planned changes over the snapshot (snapshot.apply on the server). */
export function applyOverlay(snap: Snapshot, overlay: ProposedChange[]): void {
  for (const ch of overlay) {
    if (ch.entity === 'task') {
      const i = snap.tasks.findIndex((t) => t.id === ch.entityId)
      if (i >= 0) snap.tasks[i] = { ...snap.tasks[i], ...ch.patch }
      else if (ch.create) snap.tasks.push({ id: ch.entityId, ...ch.patch })
    } else if (ch.entity === 'project') {
      const i = snap.projList.findIndex((p) => p.id === ch.entityId)
      if (i >= 0) snap.projList[i] = { ...snap.projList[i], ...ch.patch }
      else if (ch.create) snap.projList.push({ id: ch.entityId, ...ch.patch })
    } else if (ch.entity === 'label') {
      const i = snap.labelList.findIndex((l) => l.id === ch.entityId)
      if (i >= 0) snap.labelList[i] = { ...snap.labelList[i], ...ch.patch }
      else if (ch.create) snap.labelList.push({ id: ch.entityId, ...ch.patch })
    }
  }
  snap.tasks = snap.tasks.filter((t) => !isDeleted(t))
  snap.projects = new Map(snap.projList.map((p) => [str(p, 'id'), p]))
  snap.labels = new Map(snap.labelList.map((l) => [str(l, 'id'), l]))
  snap.byId = new Map(snap.tasks.map((t) => [str(t, 'id'), t]))
}

/** The caller's role for project pid ("owner" for personal tasks). */
export function roleIn(snap: Snapshot, pid: string): string {
  return (pid && snap.memberships.get(pid)?.role) || 'owner'
}

/** The sharing scope of a project id. */
export function scopeKey(snap: Snapshot, pid: string): string {
  return pid && snap.memberships.has(pid) ? `project:${pid}` : 'personal'
}

/** Whether a role may write tasks (internal/sync CanWrite). */
export function canWriteTask(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor'
}
