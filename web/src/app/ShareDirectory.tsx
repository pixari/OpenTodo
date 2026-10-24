// Sharing inside a created workspace (OpenSpec change workspaces, task 6.1):
// the people picker lists the workspace's members by name from the cache (no
// email field: the directory is closed), and a Groups section grants a group
// one role on the project. Changes need a connection; offline the lists stay
// and the controls are disabled with a line saying why.
import { useState } from 'react'
import { api } from '../lib/api'
import { t } from '../lib/i18n'
import { useWorkspaceGroups, useWorkspaceMembers } from '../lib/localData'
import { useOnline } from '../lib/online'
import { roleName } from '../lib/roleNames'
import type { Membership, ProjectRole, Workspace } from '../lib/types'
import { workspaceApi } from '../lib/workspaceApi'

type GrantRole = Exclude<ProjectRole, 'owner'>

/** The directory part of the share dialog; `run` is the dialog's request runner (busy, errors, sync). */
export function ShareDirectory({ projectId, workspace, membership, roles, busy, run }: {
  projectId: string
  workspace: Workspace
  membership: Membership | undefined
  /** The roles the caller may grant. */
  roles: ProjectRole[]
  busy: boolean
  run: (action: () => Promise<Membership | void>) => void
}) {
  const online = useOnline()
  const people = useWorkspaceMembers().filter((m) => m.workspaceId === workspace.id)
  const groups = useWorkspaceGroups().filter((g) => g.workspaceId === workspace.id)
  const onProject = new Set((membership?.members ?? []).map((m) => m.userId))
  const candidates = people.filter((p) => !onProject.has(p.userId))
  const [who, setWho] = useState('')
  const [role, setRole] = useState<GrantRole>('editor')
  const grants = new Map((membership?.grants ?? []).map((g) => [g.groupId, g.role]))
  const disabled = !online || busy
  const grantable = roles.filter((r): r is GrantRole => r !== 'owner')
  return (
    <div className="mb-4 space-y-3" data-share-directory>
      {!online && <p role="status" className="text-meta text-muted" data-share-offline>{t('Sharing needs a connection. The people and groups below are from this device.')}</p>}
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (who) run(() => workspaceApi.addMemberById(projectId, who, role)); setWho('') }}>
        <select className="ui-input min-w-0 flex-1" aria-label={t('Person')} value={who} disabled={disabled} onChange={(e) => setWho(e.target.value)} data-directory-picker>
          <option value="">{candidates.length ? t('Choose a person') : t('Everyone in {workspace} is on this project', { workspace: workspace.name })}</option>
          {candidates.map((p) => <option key={p.userId} value={p.userId}>{p.name || t('Unnamed')}</option>)}
        </select>
        <select className="ui-input w-auto" aria-label={t('Role')} value={role} disabled={disabled} onChange={(e) => setRole(e.target.value as GrantRole)}>
          {grantable.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
        </select>
        <button className="ui-btn ui-btn--primary ui-btn--md" disabled={disabled || !who}>{t('Share')}</button>
      </form>
      {groups.length > 0 && (
        <section aria-label={t('Groups')} data-share-groups>
          <h3 className="mb-1 text-meta font-semibold text-muted">{t('Groups')}</h3>
          <ul className="space-y-1">
            {groups.map((g) => {
              const current = grants.get(g.id) as GrantRole | undefined
              return (
                <li key={g.id} className="flex items-center gap-2 text-body">
                  <span className="min-w-0 flex-1 truncate">{g.name}<span className="block text-meta text-faint">{t('{n, plural, one {# person} other {# people}}', { n: g.members.length })}</span></span>
                  <select className="ui-input w-auto py-1 text-meta" aria-label={t('Role of {name}', { name: g.name })} value={current ?? ''} disabled={disabled || (!!current && !grantable.includes(current))}
                    onChange={(e) => {
                      const next = e.target.value as GrantRole | ''
                      run(async () => {
                        if (!next) { await workspaceApi.removeGrant(projectId, g.id); return api.listMembers(projectId) }
                        return current ? workspaceApi.changeGrant(projectId, g.id, next) : workspaceApi.grant(projectId, g.id, next)
                      })
                    }}>
                    <option value="">{t('Not shared')}</option>
                    {[...new Set([...grantable, ...(current ? [current] : [])])].map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
                  </select>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
