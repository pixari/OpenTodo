import { SettingsPendingGate } from './settingsPending'
import { HowYouWorkSection } from './method/HowYouWorkSection'
import { ProfileSection } from './profile/ProfileSection'
import { PersonAvatar } from './PersonAvatar'
import { Badge, Icon, type IconName, Input, LearnMore, Notice, PageBody, PageHeader, TruncatedText, useMediaQuery } from '../ui'
import { DateTimeSection } from './DateTimeSettings'
import { lazy, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '../lib/types'
import { AssistantsPanel } from './AssistantsPanel'
import { AppearanceSection, SidebarSection } from './AppearanceSection'
import { BackupsPanel } from './BackupsPanel'
import { QuickAddSettingsSection } from './QuickAddSettings'
import { VoiceSettingsSection } from './VoiceSettings'
import { CalendarSettingsSection } from './CalendarSettings'
import { PasswordSection } from './PasswordSection'
import { AdministrationSections } from './UsersPanel'
import { NotificationsSettings } from './NotificationsSettings'
import { NotificationChannelsCard } from './NotificationChannels'
import { DigestCard } from './DigestCard'
import { ActivityPanel } from './ActivityPanel'
import { AuditPanel } from './AuditPanel'
import { SecurityPanel } from './SecurityPanel'
import { LinkedAccountsPanel, SsoPanel } from './SsoPanel'
import { ProjectInvitePolicyPanel } from './ProjectInvitePolicyPanel'
import { MfaPolicyPanel, TwoFactorPanel } from './TwoFactorPanel'
import { EncryptionPanel } from './EncryptionPanel'
import { LEGACY_SETTINGS_IDS, navigate, routePath, type Route, type SettingsSectionId } from './router'
import { AboutSection } from './AboutSection'
import { firstSection, groupedSections, joinList, resolveSection, type SettingsSection } from './settingsSections'
import { requestSettingsFocus, searchSettings, takeSettingsFocus, type SettingsHit } from './settingsIndex'
import { TokensSection } from './TokensSection'
import { WebhooksPanel } from './WebhooksPanel'
import { CaldavPanel } from './CaldavPanel'
import { CalendarFeedsPanel } from './CalendarFeedsPanel'
import { IssuesPanel } from './IssuesPanel'
import { ConfigWarningsNotice } from './ConfigWarnings'
import { EmailInboxPanel } from './EmailInboxPanel'
import { BriefingSection, FocusSection, KeyboardSection, LanguageSection, StartViewSection } from './PreferencesPanels'
import { AutoArchiveSection } from './ProjectsSettings'
import { CaptureSection } from './CaptureSettings'
import { AttachmentSettingsPanel } from './AttachmentSettingsPanel'
import { OutgoingEmailPanel } from './OutgoingEmailPanel'
import { MapsServerPanel, MapsUserSection } from './locations/MapsSettings'
import { AutomationsServerPanel } from './rules/AutomationsSettings'
import { SpeechServerPanel } from './SpeechServerPanel'
import { BrandingPanel } from './BrandingPanel'
import { YourDataSection } from './DataSettings'
import { SessionPanel } from './AccountSettings'
import { useDemo } from '../lib/demo'
import { useHosted } from '../lib/hosted'
import { ServerArchivePanel } from './ServerArchivePanel'
import { t } from '../lib/i18n'
import { cardIcon, noticeCopy, SETTINGS_COPY } from '../lib/settingsCopy'
import { ACCOUNT_ROLE_LABEL } from '../lib/roleNames'
import { WorkspacesSettings } from './WorkspacesSettings'
import { useShortcutScope } from './shortcuts'
import { keysOf } from '../lib/shortcuts'

// Settings → Integrations → Assistant (in-app-assistant): part of the lazy assistant code.
const AssistantSettingsSection = lazy(() => import('./assistant/AssistantSettings'))

/** Each page's Help screen (documentation "Help links name the same screens"); the guide's `screens` resolve them. */
const PAGE_HELP_SCREENS: Record<SettingsSectionId, string> = {
  account: 'settings/account', workspaces: 'settings/workspaces', appearance: 'settings/appearance', general: 'settings/general', notifications: 'settings/notifications',
  capture: 'settings/capture', about: 'settings/about', integrations: 'settings/integrations', data: 'settings/data', people: 'settings/people', server: 'settings/server',
}

/** From here the section list is the left column and a section is open beside it (settings-navigation "Settings overview"). */
export const SETTINGS_TWO_COLUMN_QUERY = '(min-width: 64rem)'

/** Follows an in-app link without a reload; modified clicks (new tab, new window) keep the browser's behaviour. */
export function followLink(e: Pick<MouseEvent<HTMLAnchorElement>, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'preventDefault'>, r: Route) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate(r)
}

/**
 * Settings (OpenSpec change ux-overhaul, settings-navigation, design D6): one
 * layout. The section list (profile card, search, groups, footer) is the left
 * column from 1024 px and the whole screen below it; `/settings/<id>` opens a
 * section as a page, with a back action to the list on narrow screens. Legacy
 * ids open their section at the anchor of the moved content, and an unknown or
 * hidden id opens the first visible section, both replacing the address.
 */
export function SettingsView({ user, onLogout, section, anchor }: { user: User; onLogout: () => void; section?: SettingsSectionId; anchor?: string }) {
  const current = resolveSection(user, section)
  const twoColumn = useMediaQuery(SETTINGS_TWO_COLUMN_QUERY)
  const first = firstSection(user)
  const requested = typeof location !== 'undefined' ? location.pathname.split('/')[2] : undefined
  // The page shown: the section, or the first one when the list alone would be empty beside it.
  const page: SettingsSection | null = current ?? ((twoColumn || (requested && requested !== 'import')) ? first : null)

  // Address repair, in place so Back leaves Settings (settings-navigation "Legacy settings addresses").
  useEffect(() => {
    if (!requested || requested === 'import') {
      if (twoColumn && !section) navigate({ view: 'settings', section: first.id }, { replace: true })
      return
    }
    if (!current) navigate({ view: 'settings', section: first.id }, { replace: true })
    else if (requested in LEGACY_SETTINGS_IDS) navigate({ view: 'settings', section: current.id }, { replace: true })
  }, [requested, section, current, twoColumn, first.id])

  const headingRef = useRef<HTMLHeadingElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  // Focus follows navigation: the row or card a link or the search asked for, else the page heading.
  useEffect(() => {
    const target = anchor ?? takeSettingsFocus()
    const el = target ? document.getElementById(target) : null
    if (el) {
      el.scrollIntoView({ block: 'start' })
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.focus({ preventScroll: true })
    } else {
      // The page title: the header's h1, or the shell's phone bar below 768 px, else the page.
      const heading = headingRef.current ?? document.querySelector<HTMLElement>('[data-phone-title]') ?? pageRef.current
      if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
      heading?.focus({ preventScroll: true })
    }
  }, [page?.id, anchor])

  if (!page) {
    return (
      <PageBody width="form" className="space-y-6" data-settings-overview>
        <PageHeader title={t('Settings')} titleRef={headingRef} titleTabIndex={-1} help="settings" sticky={false} />
        <SettingsList user={user} />
      </PageBody>
    )
  }
  // precision-settings D1–D3: from 1024 px the header is a breadcrumb across the surface,
  // the navigation pane sits under it on a hairline, and the page opens with its title
  // and lead line; below 1024 px the header carries Back and the list is its own page.
  const crumb = twoColumn && (
    <span className="flex shrink-0 items-center gap-1 text-h3 font-normal text-muted" data-settings-crumb>
      <a href={routePath({ view: 'settings' })} className="rounded-control hover:text-default focus-visible:outline-2 focus-visible:outline-focus"
        onClick={(e) => followLink(e, { view: 'settings', section: first.id })}>{t('Settings')}</a>
      <Icon name="chevron-right" size="xs" />
    </span>
  )
  return (
    <div ref={pageRef} className="outline-none" data-settings-section={page.id}>
      <div className="px-4 md:px-8">
        <PageHeader title={page.label} leading={crumb} titleRef={headingRef} titleTabIndex={-1} help={PAGE_HELP_SCREENS[page.id]} sticky={false}
          back={{ label: t('Settings'), href: routePath({ view: 'settings' }), onClick: () => navigate({ view: 'settings' }), hideFrom: 'lg' }} />
      </div>
      <div className="lg:-mt-2 lg:grid lg:grid-cols-[14.25rem_minmax(0,1fr)]">
        {twoColumn && (
          <aside className="hidden border-r border-soft lg:sticky lg:top-0 lg:block lg:max-h-[calc(100dvh-4.5rem)] lg:min-h-[calc(100dvh-4.5rem)] lg:self-start lg:overflow-y-auto lg:px-3 lg:py-3" aria-label={t('Settings')} data-settings-pane>
            <SettingsList user={user} current={page.id} compact />
          </aside>
        )}
        {/* workspaces-settings-v2 D2: the Workspaces page's two panes need 56 rem; every other section keeps 45 (precision-settings D3). */}
        <div className={`min-w-0 space-y-8 px-4 pt-4 pb-10 md:px-8 lg:px-16 lg:pt-10 ${page.id === 'workspaces' ? 'lg:max-w-[64rem]' : 'lg:max-w-[53rem]'}`} data-settings-width={page.id === 'workspaces' ? 'wide' : 'form'}>
          {twoColumn && (
            <div aria-hidden="true" data-settings-page-head>
              <p className="text-h1 text-strong">{page.label}</p>
              <p className="mt-2 max-w-[72ch] text-body text-muted">{page.description(user)}</p>
            </div>
          )}
          <SettingsPendingGate key={page.id}><SectionContent section={page} user={user} onLogout={onLogout} /></SettingsPendingGate>
        </div>
      </div>
    </div>
  )
}

/**
 * The section list (settings-navigation "Settings overview"): profile card, search,
 * the groups as labelled lists, the free-software footer. `compact` is the column
 * beside a section page.
 */
export function SettingsList({ user, current, compact = false }: { user: User; current?: SettingsSectionId; compact?: boolean }) {
  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'} data-settings-list>
      {/* The pane beside a page (precision-settings D2) keeps only search and the groups. */}
      {!compact && <ProfileCard user={user} />}
      <SettingsSearch user={user} compact={compact} />
      {!compact && <ConfigWarningsNotice user={user} />}
      <nav aria-label={t('Settings sections')} className={compact ? 'space-y-4' : 'space-y-6'}>
        {groupedSections(user).map(({ group, sections }) => (
          <section key={group.id} aria-labelledby={`group-${group.id}`}>
            <h2 id={`group-${group.id}`} className={compact ? 'px-2 pb-1 text-hint text-faint' : 'mb-2 px-1 text-hint font-semibold uppercase tracking-wide text-faint'}>{group.label}</h2>
            <ul className={compact ? 'space-y-0.5' : 'divide-y divide-(--ot-border) overflow-hidden rounded-card border border-default bg-surface shadow-1'}>{/* surface-lint-allow: the section list, not a section */}
              {sections.map((s) => {
                const on = s.id === current
                return (
                  <li key={s.id}>
                    <a href={routePath({ view: 'settings', section: s.id })} data-settings-link={s.id} aria-current={on ? 'page' : undefined}
                      className={compact
                        ? `touch-target flex min-h-[1.875rem] items-center gap-2.5 rounded-control px-2 text-body focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${on ? 'bg-selected font-medium text-strong' : 'text-default hover:bg-hover'}`
                        : 'flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus dark:hover:bg-raised'}
                      onClick={(e) => followLink(e, { view: 'settings', section: s.id })}>
                      {compact
                        ? <span className={on ? 'text-strong' : 'text-muted'}><Icon name={s.icon} /></span>
                        : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-on-accent-soft"><Icon name={s.icon} size="md" /></span>}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{s.label}</span>
                        {!compact && <span className="block text-meta text-muted">{s.description(user)}</span>}
                      </span>
                      {!compact && <span className="text-faint"><Icon name="chevron-right" /></span>}
                    </a>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </nav>
      {!compact && (
        <p className="text-meta text-faint">
          {t('OpenTodo is free software (AGPL-3.0). No telemetry, no tracking, no subscription.')}<a className="ml-1 underline" href="https://github.com/pixari/opentodo" target="_blank" rel="noreferrer">{t('Source code')}</a>
        </p>
      )}
    </div>
  )
}

/** The search field (settings-navigation "Settings search"): rows under their section, Enter opens the first. */
function SettingsSearch({ user, compact = false }: { user: User; compact?: boolean }) {
  const [query, setQuery] = useState('')
  const hits = useMemo(() => searchSettings(query, user), [query, user])
  const listRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // `/` focuses the field from anywhere on a Settings page (precision-settings D2).
  useShortcutScope('view', { 'settings.search': () => inputRef.current?.focus() }, { view: 'settings' })
  const slash = keysOf('settings.search')
  const open = (section: SettingsSectionId, anchor?: string) => {
    if (anchor) requestSettingsFocus(anchor)
    setQuery('')
    navigate({ view: 'settings', section })
  }
  const first = hits[0]
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!first) return
    open(first.section.id, first.entries[0]?.anchor)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); listRef.current?.querySelector<HTMLElement>('a')?.focus() }
    if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') }
  }
  return (
    <form role="search" onSubmit={submit} className="space-y-2" data-settings-search>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"><Icon name="search" size="sm" /></span>
        <Input ref={inputRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
          placeholder={t('Search settings')} aria-label={t('Search settings')} autoComplete="off" aria-keyshortcuts={slash}
          className={compact ? 'min-h-8 py-1 pr-8 pl-8 text-body' : 'pl-8'} />
        {!query && slash && <kbd aria-hidden="true" className="ui-kbd pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">{slash}</kbd>}
      </div>
      {query.trim() && (
        <ul ref={listRef} className="rounded-card border border-default bg-surface p-1 shadow-1" aria-label={t('Matching settings')} data-settings-results>{/* surface-lint-allow: search results, not a section */}
          {hits.length === 0 && <li className="px-2 py-2 text-meta text-muted">{t('No setting matches “{trim}”.', { trim: query.trim() })}</li>}
          {hits.map((h: SettingsHit) => (
            <li key={h.section.id}>
              <ResultLink section={h.section} onOpen={() => open(h.section.id)} />
              {h.entries.map((en) => (
                <a key={en.anchor + en.label} href={routePath({ view: 'settings', section: h.section.id })} data-settings-result={`${h.section.id}:${en.anchor}`}
                  className="flex min-h-9 items-center gap-2 rounded-control px-2 py-1 pl-7 text-body hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus dark:hover:bg-raised"
                  onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); open(h.section.id, en.anchor) }}>
                  {cardIcon(en.anchor) ? <Icon name={cardIcon(en.anchor) as IconName} size="xs" className="-ml-5 text-muted" /> : null}
                  <span className="min-w-0 flex-1 truncate">{en.label}</span>
                  <span className="truncate text-meta text-muted">{en.description}</span>
                </a>
              ))}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}

function ResultLink({ section, onOpen }: { section: SettingsSection; onOpen: () => void }) {
  return (
    <a href={routePath({ view: 'settings', section: section.id })} data-settings-result={section.id}
      className="flex min-h-9 items-center gap-2 rounded-control px-2 py-1 text-body font-medium hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus dark:hover:bg-raised"
      onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onOpen() }}>
      <span className="text-muted"><Icon name={section.icon} /></span>{section.label}
    </a>
  )
}


/** Who is signed in: avatar initials, name, email and role (the list and Account). */
export function ProfileCard({ user, compact = false }: { user: User; compact?: boolean }) {
  return (
    <div id="profile" className={`flex flex-wrap items-center gap-3 rounded-card border border-default bg-surface ${compact ? 'p-3' : 'gap-4 p-4'} shadow-1`} data-profile-card>{/* surface-lint-allow: the profile card above the list */}
      <PersonAvatar id={user.id} name={user.name || user.email} size={compact ? 'md' : 'lg'} />
      {/* The role wraps under the card when the name needs the width (a phone with a large
          text size, precision-polish-2), so the name is not cut to a letter. */}
      <div className="min-w-0 flex-[1_1_8rem]">
        <p className="user-text truncate text-body font-semibold text-default">{user.name || user.email}</p>
        <TruncatedText as="p" className="user-text text-meta text-muted" text={user.email} />
      </div>
      <Badge hue={user.role === 'owner' ? 'green' : user.role === 'admin' ? 'indigo' : 'slate'}>{ACCOUNT_ROLE_LABEL[user.role]}</Badge>
    </div>
  )
}

/** The cards of one section; on a demo instance the refused ones are disabled under one note. */
function SectionContent({ section, user, onLogout }: { section: SettingsSection; user: User; onLogout: () => void }) {
  const demo = !!useDemo()
  // A hosted service's operator owns the server-level settings (multi-tenant-host D4).
  const hosted = useHosted()
  const isOwner = user.role === 'owner'
  const ownsServer = isOwner && !hosted
  const refused = demo ? (section.demo?.(user) ?? []) : []
  const note = refused.length > 0 ? <DemoRestrictedNote features={refused} /> : null
  switch (section.id) {
    case 'account':
      return (
        <>
          {note}
          <Anchor id="profile"><ProfileSection user={user} /></Anchor>
          <Anchor id="how-you-work"><HowYouWorkSection /></Anchor>
          <SessionPanel onLogout={onLogout} />
          <Anchor id="security">
            <DemoDisabled on={demo}>
              <PasswordSection />
              <TwoFactorPanel user={user} />
              <SecurityPanel />
              <LinkedAccountsPanel />
            </DemoDisabled>
          </Anchor>
          <Anchor id="encryption"><DemoDisabled on={demo}><EncryptionPanel /></DemoDisabled></Anchor>
          <Anchor id="sessions"><ActivityPanel /></Anchor>
        </>
      )
    case 'workspaces':
      return <WorkspacesSettings user={user} />
    case 'appearance':
      return (
        <>
          <AppearanceSection />
          <SidebarSection />
        </>
      )
    case 'general':
      return (
        <>
          <LanguageSection />
          <StartViewSection />
          <BriefingSection />
          <DateTimeSection />
          <CalendarSettingsSection />
          <KeyboardSection />
          <FocusSection />
          <MapsUserSection />
        </>
      )
    case 'notifications':
      return <>{note}<DemoDisabled on={demo}><NotificationsSettings /><NotificationChannelsCard isOwner={isOwner} /><DigestCard /></DemoDisabled></>
    case 'capture':
      return (
        <>
          {note}
          <QuickAddSettingsSection />
          <VoiceSettingsSection />
          <CaptureSection />
          <DemoDisabled on={demo}><EmailInboxPanel /></DemoDisabled>
        </>
      )
    case 'about':
      return <AboutSection user={user} />
    case 'integrations':
      // TokensSection loads its list whenever this section mounts, so a token
      // created under AI assistants is listed here without shared state.
      return (
        <>
          {note}
          <DemoDisabled on={demo}>
            <CaldavPanel isOwner={isOwner} email={user.email} />
            <CalendarFeedsPanel isOwner={isOwner} />
            <IssuesPanel isOwner={isOwner} />
            <WebhooksPanel isOwner={ownsServer} />
            <TokensSection />
          </DemoDisabled>
          <Anchor id="ai">
            <DemoDisabled on={demo}>
              <Suspense fallback={null}><AssistantSettingsSection isOwner={ownsServer} /></Suspense>
              <AssistantsPanel isOwner={ownsServer} />
            </DemoDisabled>
          </Anchor>
        </>
      )
    case 'data':
      return (
        <>
          <YourDataSection demo={demo} isOwner={isOwner} />
          <Anchor id="projects"><AutoArchiveSection /></Anchor>
        </>
      )
    case 'people':
      return (
        <>
          {note}
          <ConfigWarningsNotice user={user} />
          <DemoDisabled on={demo}><AdministrationSections user={user} /></DemoDisabled>
          {isOwner && (
            <Anchor id="access-policies">
              <DemoDisabled on={demo}>
                <MfaPolicyPanel />
                {!hosted && <SsoPanel />}
                <ProjectInvitePolicyPanel />
              </DemoDisabled>
            </Anchor>
          )}
        </>
      )
    case 'server':
      return (
        <>
          {note}
          {hosted ? (
            // Hosted: backups, attachment limits and outgoing email are the operator's; the owner can take the data away.
            <ServerArchivePanel />
          ) : (
            <>
              <DemoDisabled on={demo}><BackupsPanel /></DemoDisabled>
              <AttachmentSettingsPanel />
              {/* Outgoing email (outgoing-email change): the owner's SMTP settings; a demo instance never builds the mailer. */}
              <DemoDisabled on={demo}><OutgoingEmailPanel /></DemoDisabled>
            </>
          )}
          {/* Branding (instance-branding): the owner's name and logo; a demo keeps the app's own. */}
          {isOwner && <DemoDisabled on={demo}><BrandingPanel /></DemoDisabled>}
          {/* Maps (task-locations D6): the owner's switch and providers; off on a demo unless OPENTODO_MAPS=on. */}
          {isOwner && <DemoDisabled on={demo}><MapsServerPanel /></DemoDisabled>}
          {/* Automation rules (automation-rules D9): the owner's switch; nothing runs on a demo. */}
          {isOwner && <DemoDisabled on={demo}><AutomationsServerPanel /></DemoDisabled>}
          {/* Speech to text (settings-refresh D7): the owner's speech service; never on a demo. */}
          {ownsServer && <DemoDisabled on={demo}><SpeechServerPanel /></DemoDisabled>}
          <Anchor id="audit-log"><AuditPanel /></Anchor>
        </>
      )
  }
}

/** A focusable landmark for a legacy address or a search result inside a page. */
function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return <div id={id} tabIndex={-1} className="space-y-8 outline-none" data-settings-anchor={id}>{children}</div>
}

/** On a demo instance, the refused cards stay visible with their controls disabled (settings-navigation "Demo instance sections"). */
function DemoDisabled({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) return <>{children}</>
  return <fieldset disabled className="m-0 min-w-0 space-y-8 border-0 p-0" data-demo-disabled>{children}</fieldset>
}

/** Features a demo instance refuses (OpenSpec `demo-mode`); each section names its own (settingsSections.ts). */
export const DEMO_RESTRICTED_FEATURES = [
  'password and two-factor authentication', 'passkeys', 'end-to-end encryption', 'push notifications', 'linked accounts',
  'users and invitations', 'single sign-on', 'calendar apps (CalDAV)', 'calendar feeds', 'webhooks', 'email to task', 'backups',
  'outgoing email', 'the weekly digest', 'the assistant', 'AI assistants (MCP)', 'API tokens', 'import', 'sharing changes', 'workspaces',
]

/**
 * The demo note once at the top of a page, naming the rows whose controls are disabled:
 * one line, with Learn more opening the demo section of the getting-started guide
 * (settings-copy D6), which says what the sandbox is and how to run your own server.
 */
function DemoRestrictedNote({ features }: { features: string[] }) {
  const learn = (
    <LearnMore screen={SETTINGS_COPY.demo.learnMore} topic={t('Demo instance')} className="text-meta" />
  )
  return (
    <div data-testid="demo-restricted">
      <Notice tone="info" action={learn}>
        {noticeCopy('demo', 'restricted', { variant: features.length === 1 ? 'one' : 'other', values: { features: joinList(features.map((x) => t(x))) } })}
      </Notice>
    </div>
  )
}
