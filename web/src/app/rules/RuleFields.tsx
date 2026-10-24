// The parts of the rule editor (OpenSpec change automation-rules, design D11):
// the trigger, the condition and the actions. Each part edits one whole value;
// the dialog saves them through createRule/updateRule.
import { RULE_DUE, RULE_START, RULE_STATE, RULE_TRIGGERS, type Label, type Priority, type Project, type RuleActions, type RuleCondition, type RuleTrigger, type RuleTriggerKind, type Section, type Webhook } from '../../lib/types'
import { t, msg, translatedMap } from '../../lib/i18n'
import { Field, Input, Switch } from '../../ui'
import { Choice, LabelsField } from '../RuleEditor'
import { ProjectPickerField } from '../ProjectPickerField'

export const TRIGGER_LABEL = translatedMap<RuleTriggerKind>({
  'task.created': msg('A task is created'),
  'task.completed': msg('A task is completed'),
  'task.reopened': msg('A task is reopened'),
  'label.added': msg('A label is added'),
  'label.removed': msg('A label is removed'),
  'assigned.to_me': msg('A task is assigned to me'),
  'task.moved': msg('A task is moved'),
  'due.reached': msg('A task is due'),
  overdue: msg('A task’s date passes'),
  schedule: msg('On a schedule'),
})
const DUE_LABEL = translatedMap({ today: msg('Today'), tomorrow: msg('Tomorrow'), 'next-week': msg('Next week'), clear: msg('No date') })
const START_LABEL = translatedMap({ someday: msg('Someday'), clear: msg('Clear the start') })
const STATE_LABEL = translatedMap({ complete: msg('Complete'), reopen: msg('Reopen') })
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
const WEEKDAY_SHORT = translatedMap<string>({ 1: msg('Mon'), 2: msg('Tue'), 3: msg('Wed'), 4: msg('Thu'), 5: msg('Fri'), 6: msg('Sat'), 7: msg('Sun') })

const row = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-body'

interface Names { labels: readonly Label[]; projects: readonly Project[]; sections: readonly Section[] }

function SectionSelect({ projectId, value, sections, onChange }: { projectId: string; value: string | null; sections: readonly Section[]; onChange: (id: string | null) => void }) {
  const own = sections.filter((s) => s.project_id === projectId && !s.deleted_at).sort((a, b) => a.position - b.position)
  return (
    <label className={row}>
      <span>{t('Section')}</span>
      <select className="ui-input w-44" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t('No section')}</option>
        {own.map((s) => <option key={s.id} value={s.id}>{s.name || t('Untitled section')}</option>)}
      </select>
    </label>
  )
}

function LabelSelect({ value, labels, onChange }: { value: string | undefined; labels: readonly Label[]; onChange: (id: string) => void }) {
  return (
    <label className={row}>
      <span>{t('Label')}</span>
      <select className="ui-input w-44" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>{t('Choose a label')}</option>
        {labels.filter((l) => !l.deleted_at).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  )
}

/** The trigger: its kind and the members that kind takes. */
export function TriggerFields({ value, onChange, names, sharedProjects }: { value: RuleTrigger; onChange: (v: RuleTrigger) => void; names: Names; sharedProjects: Set<string> }) {
  const setKind = (kind: RuleTriggerKind) => {
    if (kind === 'schedule') onChange({ kind, at: '18:00', weekdays: [7] })
    else onChange({ kind })
  }
  const days = value.weekdays ?? []
  return (
    <fieldset className="space-y-2" data-rule-trigger>
      <legend className="text-meta font-medium text-muted">{t('When')}</legend>
      <label className={row}>
        <span>{t('Trigger')}</span>
        <select className="ui-input w-56 max-w-full" value={value.kind} onChange={(e) => setKind(e.target.value as RuleTriggerKind)}>
          {RULE_TRIGGERS.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
        </select>
      </label>
      {(value.kind === 'label.added' || value.kind === 'label.removed') && (
        <LabelSelect value={value.label_id} labels={names.labels} onChange={(id) => onChange({ kind: value.kind, label_id: id })} />
      )}
      {value.kind === 'task.moved' && (
        <>
          <div className={row}>
            <span>{t('Project')}</span>
            <ProjectPickerField label={t('Project')} projects={names.projects.filter((p) => !sharedProjects.has(p.id))} value={value.project_id ?? null} inbox={false}
              noneLabel={t('Choose a project')} rankContext="rule.project" className="w-44" onChange={(id) => onChange({ kind: 'task.moved', ...(id ? { project_id: id } : {}) })} />
          </div>
          {value.project_id && <SectionSelect projectId={value.project_id} value={value.section_id ?? null} sections={names.sections}
            onChange={(id) => onChange({ kind: 'task.moved', project_id: value.project_id, ...(id ? { section_id: id } : {}) })} />}
        </>
      )}
      {value.kind === 'schedule' && (
        <>
          <Field label={t('Time')}>
            <Input type="time" value={value.at ?? ''} onChange={(e) => onChange({ ...value, at: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('Days')}>
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" aria-pressed={days.includes(d)}
                className={`ui-btn ui-btn--sm ${days.includes(d) ? 'ui-btn--primary' : 'ui-btn--ghost'}`}
                onClick={() => onChange({ ...value, weekdays: days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort() })}>{WEEKDAY_SHORT[d]}</button>
            ))}
          </div>
        </>
      )}
    </fieldset>
  )
}

const DATE_PRED = ['', 'none', 'set', 'today', 'overdue', 'within'] as const
const DATE_PRED_LABEL = translatedMap<string>({ '': msg('Any'), none: msg('No date'), set: msg('Has a date'), today: msg('Today'), overdue: msg('Earlier'), within: msg('Within days') })

function DatePredicate({ label, value, overdue, onChange }: { label: string; value: RuleCondition['due']; overdue: boolean; onChange: (v: RuleCondition['due']) => void }) {
  const kind = value === undefined ? '' : typeof value === 'object' ? 'within' : value
  return (
    <div className={row}>
      <span>{label}</span>
      <span className="flex items-center gap-2">
        {kind === 'within' && typeof value === 'object' && (
          <Input aria-label={t('Days')} className="w-16" type="number" min={0} max={365} value={value.within_days}
            onChange={(e) => onChange({ within_days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />
        )}
        <select className="ui-input w-36" aria-label={label} value={kind} onChange={(e) => {
          const k = e.target.value
          onChange(k === '' ? undefined : k === 'within' ? { within_days: 3 } : (k as 'none'))
        }}>
          {DATE_PRED.filter((k) => overdue || (k !== 'today' && k !== 'overdue')).map((k) => <option key={k} value={k}>{DATE_PRED_LABEL[k]}</option>)}
        </select>
      </span>
    </div>
  )
}

/** Sets or clears one predicate of a condition. */
function withPredicate<K extends keyof RuleCondition>(c: RuleCondition, key: K, value: RuleCondition[K] | undefined): RuleCondition {
  const next = { ...c }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** The condition: every predicate set must hold. */
export function ConditionFields({ value, onChange, names }: { value: RuleCondition; onChange: (v: RuleCondition) => void; names: Names }) {
  const set = <K extends keyof RuleCondition>(key: K, v: RuleCondition[K] | undefined) => onChange(withPredicate(value, key, v))
  const project = value.project && value.project !== 'none' ? value.project : null
  const pick = (v: string, map: Record<string, RuleCondition[keyof RuleCondition] | undefined>) => map[v]
  return (
    <fieldset className="space-y-2" data-rule-condition>
      <legend className="text-meta font-medium text-muted">{t('Only for tasks that')}</legend>
      <div className={row}>
        <span>{t('Project')}</span>
        <ProjectPickerField label={t('Project')} projects={names.projects} value={project?.in[0] ?? null} inbox={false} noneLabel={t('Any')} rankContext="rule.project"
          className="w-44" onChange={(id) => set('project', id ? { in: [id], descendants: true } : undefined)} />
      </div>
      <LabelsField title={t('Have every label')} ids={value.labels?.all ?? []} labels={names.labels}
        onChange={(ids) => set('labels', ids.length || value.labels?.none?.length ? { ...value.labels, all: ids } : undefined)} />
      <LabelsField title={t('Have none of the labels')} ids={value.labels?.none ?? []} labels={names.labels}
        onChange={(ids) => set('labels', ids.length || value.labels?.all?.length ? { ...value.labels, none: ids } : undefined)} />
      <label className={row}>
        <span>{t('Priority')}</span>
        <select className="ui-input w-44" value={value.priority?.in.join(',') ?? ''} onChange={(e) => set('priority', e.target.value ? { in: e.target.value.split(',').map(Number) } : undefined)}>
          <option value="">{t('Any')}</option>
          {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{t('Priority {p}', { p })}</option>)}
          <option value="1,2">{t('Priority 1 or 2')}</option>
        </select>
      </label>
      <DatePredicate label={t('Date')} value={value.due} overdue onChange={(v) => set('due', v)} />
      <DatePredicate label={t('Deadline')} value={value.deadline} overdue={false} onChange={(v) => set('deadline', v as RuleCondition['deadline'])} />
      <label className={row}>
        <span>{t('Assignee')}</span>
        <select className="ui-input w-44" value={value.assignee ?? ''} onChange={(e) => set('assignee', (e.target.value || undefined) as RuleCondition['assignee'])}>
          <option value="">{t('Any')}</option>
          <option value="me">{t('Assigned to me')}</option>
          <option value="none">{t('Unassigned')}</option>
          <option value="anyone">{t('Assigned to someone')}</option>
        </select>
      </label>
      <label className={row}>
        <span>{t('Blocked')}</span>
        <select className="ui-input w-44" value={value.blocked === undefined ? '' : String(value.blocked)}
          onChange={(e) => set('blocked', pick(e.target.value, { true: true, false: false }) as boolean | undefined)}>
          <option value="">{t('Any')}</option>
          <option value="true">{t('Blocked')}</option>
          <option value="false">{t('Not blocked')}</option>
        </select>
      </label>
    </fieldset>
  )
}

/** Sets or clears one key of the actions. */
function withAction<K extends keyof RuleActions>(a: RuleActions, key: K, value: RuleActions[K] | undefined): RuleActions {
  const next = { ...a }
  if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key]
  else next[key] = value
  return next
}

/** The actions: the column rule's controls plus the automation keys. */
export function ActionFields({ value, onChange, names, encrypted, webhooks, sharedProjects }: {
  value: RuleActions; onChange: (v: RuleActions) => void; names: Names; encrypted: boolean; webhooks: readonly Webhook[] | null; sharedProjects: Set<string>
}) {
  const set = <K extends keyof RuleActions>(key: K, v: RuleActions[K] | undefined) => onChange(withAction(value, key, v))
  const projectId = value.section?.project_id ?? null
  const due = typeof value.due === 'string' ? value.due : undefined
  return (
    <fieldset className="space-y-2" data-rule-actions>
      <legend className="text-meta font-medium text-muted">{t('Then')}</legend>
      <label className={row}>
        <span>{t('Priority')}</span>
        <select className="ui-input w-44" value={value.priority ?? ''} onChange={(e) => set('priority', e.target.value ? (Number(e.target.value) as Priority) : undefined)}>
          <option value="">{t('Keep')}</option>
          {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{t('Priority {p}', { p })}</option>)}
        </select>
      </label>
      <Choice label={t('Date')} value={due} options={RULE_DUE} names={DUE_LABEL} onChange={(v) => set('due', v)} />
      <Choice label={t('Start')} value={value.start} options={RULE_START} names={START_LABEL} onChange={(v) => set('start', v)} />
      <label className={row}>
        <span>{t('Deadline')}</span>
        <select className="ui-input w-44" value={value.deadline === undefined ? '' : value.deadline === 'clear' ? 'clear' : String(value.deadline.in_days)}
          onChange={(e) => set('deadline', e.target.value === '' ? undefined : e.target.value === 'clear' ? 'clear' : { in_days: Number(e.target.value) })}>
          <option value="">{t('Keep')}</option>
          <option value="clear">{t('No deadline')}</option>
          {[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{t('{n, plural, one {In # day} other {In # days}}', { n })}</option>)}
        </select>
      </label>
      <label className={row}>
        <span>{t('Assignee')}</span>
        <select className="ui-input w-44" value={value.assignee ?? ''} onChange={(e) => set('assignee', (e.target.value || undefined) as RuleActions['assignee'])}>
          <option value="">{t('Keep')}</option>
          <option value="me">{t('Assign to me')}</option>
          <option value="clear">{t('Unassign')}</option>
        </select>
      </label>
      <LabelsField title={t('Add labels')} ids={value.add_labels ?? []} labels={names.labels} onChange={(ids) => set('add_labels', ids)} />
      <LabelsField title={t('Remove labels')} ids={value.remove_labels ?? []} labels={names.labels} onChange={(ids) => set('remove_labels', ids)} />
      <div className={row}>
        <span>{t('Project')}</span>
        <ProjectPickerField label={t('Project')} projects={names.projects.filter((p) => !sharedProjects.has(p.id))} value={projectId} inbox={false} noneLabel={t('Keep')}
          rankContext="rule.project" className="w-44" onChange={(id) => set('section', id ? { project_id: id, section_id: null } : undefined)} />
      </div>
      {projectId && <SectionSelect projectId={projectId} value={value.section?.section_id ?? null} sections={names.sections}
        onChange={(id) => set('section', { project_id: projectId, section_id: id })} />}
      <Choice label={t('Status')} value={value.state} options={RULE_STATE} names={STATE_LABEL} onChange={(v) => set('state', v)} />
      <Field label={t('Comment')} description={encrypted ? t('Not available with end-to-end encryption: the server cannot encrypt a comment.') : t('Optional')}>
        <textarea className="ui-input min-h-16 w-full" maxLength={2000} disabled={encrypted} value={value.comment?.text ?? ''}
          onChange={(e) => set('comment', e.target.value ? { text: e.target.value } : undefined)} />
      </Field>
      <Switch label={t('Notify me')} checked={!!value.notify} onChange={(on) => set('notify', on ? true : undefined)} />
      <label className={row}>
        <span>{t('Webhook')}</span>
        <select className="ui-input w-44" value={value.webhook?.webhook_id ?? ''} disabled={!webhooks}
          onChange={(e) => set('webhook', e.target.value ? { webhook_id: e.target.value } : undefined)}>
          <option value="">{webhooks ? t('None') : t('Unavailable offline')}</option>
          {(webhooks ?? []).map((w) => <option key={w.id} value={w.id}>{w.url}</option>)}
        </select>
      </label>
    </fieldset>
  )
}
