// The settings search index (OpenSpec change ux-overhaul, settings-navigation
// "Settings search"): every section and the rows people look for, with the id of
// the element that scrolls into view and takes focus when a result is opened. The
// settings list's search field and the command palette read the same table.
import { getHosted } from '../lib/hosted'
import type { User } from '../lib/types'
import { matchPrepared, prepare, prepareQuery } from '../ui'
import type { SettingsSectionId } from './router'
import { resolveSection, type SettingsSection, visibleSections } from './settingsSections'
import { msg, translatedList } from '../lib/i18n'

export interface SettingsEntry {
  section: SettingsSectionId
  /** The row or card as people name it ("Passkeys", "First day of the week"). */
  label: string
  description: string
  /** id of the row, card heading or group wrapper inside the section page. */
  anchor: string
  /** Words the entry also matches on, never shown. */
  keywords?: string
  /** Who sees the row; the section's own visibility applies first. */
  visible?: (user: User) => boolean
  /** On a hosted service (multi-tenant-host): 'managed' rows belong to the operator and are hidden, 'only' rows exist only there. */
  hosted?: 'managed' | 'only'
}

const owner = (u: User) => u.role === 'owner'

export const SETTINGS_INDEX: readonly SettingsEntry[] = translatedList<SettingsEntry, 'label' | 'description'>([
  { section: 'account', label: msg('Profile'), description: msg('Your picture, name and email'), anchor: 'profile-heading', keywords: 'avatar photo picture rename name email address' },
  { section: 'account', label: msg('Profile'), description: msg('Your name, email and role'), anchor: 'profile' },
  { section: 'account', label: msg('How you work'), description: msg('Lists only, Companion or Open Loops first: how much the app shows its method'), anchor: 'how-you-work-heading', keywords: 'open loops gtd method mode loop home' },
  { section: 'account', label: msg('Sign out of this device'), description: msg('Removes your tasks from this device after uploading pending changes'), anchor: 'session-heading', keywords: 'logout log out' },
  { section: 'account', label: msg('Password'), description: msg('Change your password'), anchor: 'password-heading' },
  { section: 'account', label: msg('Two-factor authentication'), description: msg('A code from your phone on top of your password, and recovery codes'), anchor: 'mfa-heading', keywords: '2fa totp mfa' },
  { section: 'account', label: msg('Passkeys'), description: msg('Sign in with your fingerprint, face or device PIN'), anchor: 'security-heading', keywords: 'webauthn passkey' },
  { section: 'account', label: msg('Linked accounts'), description: msg('Single sign-on identities linked to your account'), anchor: 'linked-heading', keywords: 'sso oidc' },
  { section: 'account', label: msg('End-to-end encryption'), description: msg('Encrypt your task text on your devices, and keep its recovery key'), anchor: 'e2ee-heading', keywords: 'e2ee passphrase recovery key' },
  { section: 'account', label: msg('Recent activity'), description: msg('Sign-ins and token changes on your account over the last 90 days'), anchor: 'activity-heading', keywords: 'sessions sign-ins' },
  // Appearance
  { section: 'appearance', label: msg('Mode'), description: msg('System, light or dark'), anchor: 'appearance-mode', keywords: 'dark light theme' },
  { section: 'appearance', label: msg('Theme'), description: msg('The colour of buttons, links and selection'), anchor: 'appearance-theme', keywords: 'accent colour color' },
  { section: 'appearance', label: msg('Density'), description: msg('Comfortable or compact rows'), anchor: 'appearance-density', keywords: 'compact rows' },
  { section: 'appearance', label: msg('Sidebar destinations'), description: msg('Which of Anytime, Someday, Assigned to me, Completed, Updates, Trash and New view sit next to Inbox, Today, Upcoming and Calendar'), anchor: 'sidebar-heading', keywords: 'promote more group' },
  // General
  { section: 'general', label: msg('Language'), description: msg('The language of the app on all your devices'), anchor: 'language-heading', keywords: 'language locale translation sprache langue idioma lingua idioma' },
  { section: 'general', label: msg('Start view'), description: msg('The view this device opens on'), anchor: 'start-view-heading', keywords: 'launch open on' },
  { section: 'general', label: msg('Show the briefing'), description: msg('The sentence under the title of Today and Upcoming. On all your devices.'), anchor: 'briefing-heading', keywords: 'briefing summary sentence today upcoming hide' },
  { section: 'general', label: msg('Date format'), description: msg('Day-month, month-day or ISO'), anchor: 'date-time-heading' },
  { section: 'general', label: msg('Time format'), description: msg('12-hour or 24-hour'), anchor: 'date-time-heading', keywords: 'clock' },
  { section: 'general', label: msg('First day of the week'), description: msg('Where the Week view and calendars start'), anchor: 'date-time-heading', keywords: 'week start monday sunday' },
  { section: 'general', label: msg('My day starts at'), description: msg('Work done before this time counts for the previous day.'), anchor: 'date-time-heading', keywords: 'day start night owl midnight end of day' },
  { section: 'general', label: msg('Calendar grid'), description: msg('When the Day and Week grid starts and ends, and your day length'), anchor: 'calendar-heading', keywords: 'capacity hours' },
  { section: 'general', label: msg('Show shortcut hints'), description: msg('Print the keys in the app, next to quick add and in prompts'), anchor: 'shortcut-hints', keywords: 'keyboard shortcuts kbd badges' },
  { section: 'general', label: msg('Focus timer'), description: msg('Pomodoro, Flowtime or Countdown, the lengths, breaks and the sound'), anchor: 'focus-heading', keywords: 'focus pomodoro flowtime countdown timer session break reminder sound tone' },
  { section: 'general', label: msg('Vim keybindings'), description: msg('Keyboard navigation with hjkl'), anchor: 'keyboard-heading', keywords: 'keyboard shortcuts' },
  // Notifications
  { section: 'notifications', label: msg('Push notifications'), description: msg('Reminders delivered to this device, and a test'), anchor: 'notifications-heading', keywords: 'reminders' },
  { section: 'notifications', label: msg('Weekly digest'), description: msg('An email on your review day with last week\'s numbers'), anchor: 'email-digest-heading', keywords: 'email summary review statistics' },
  // About (welcome-note)
  { section: 'about', label: msg('Documentation'), description: msg('The same guides on the website, with setup and self-hosting.'), anchor: 'about-docs', keywords: 'docs help manual guide website version' },
  { section: 'about', label: msg('Share feedback or report a problem'), description: msg('Open an issue on GitHub. Every report is read.'), anchor: 'about-feedback', keywords: 'bug issue github feedback support contact' },
  { section: 'about', label: msg('Community'), description: msg('Questions, ideas and other people who use OpenTodo, on Discord.'), anchor: 'about-community', keywords: 'discord community chat forum people' },
  { section: 'about', label: msg('Buy me a coffee'), description: msg('Support OpenTodo'), anchor: 'about-support-heading', keywords: 'donate sponsor support coffee' },
  { section: 'about', label: msg('Welcome note'), description: msg('The thank-you shown the first time you opened this server.'), anchor: 'about-welcome', visible: owner, keywords: 'thanks welcome' },
  // Capture
  { section: 'capture', label: msg('Quick add'), description: msg('Natural-language parsing, its languages and the date order'), anchor: 'quick-add-heading', keywords: 'natural language parsing' },
  { section: 'capture', label: msg('Voice capture'), description: msg('Dictate tasks into quick add'), anchor: 'voice-settings-heading', keywords: 'dictation microphone' },
  { section: 'capture', label: msg('Bookmarklet and extension'), description: msg('Save the page you are reading as a task'), anchor: 'capture-heading', keywords: 'browser' },
  { section: 'capture', label: msg('Email to task'), description: msg('Your secret address; emails sent there become tasks'), anchor: 'email-inbox-heading', keywords: 'mail inbox' },
  // Integrations
  { section: 'integrations', label: msg('Calendar apps (CalDAV)'), description: msg('See your tasks in calendar and reminder apps with an app password'), anchor: 'caldav-heading', keywords: 'caldav app password' },
  { section: 'integrations', label: msg('Calendar feeds'), description: msg('Show your other calendars beside your tasks, and subscribe to your tasks from a calendar app'), anchor: 'calendar-feeds-heading', keywords: 'ics subscribe google outlook apple calendar' },
  { section: 'integrations', label: msg('Webhooks'), description: msg('Send a message to another service when tasks change'), anchor: 'webhooks-heading' },
  { section: 'integrations', label: msg('API tokens'), description: msg('Keys for scripts and the command-line client'), anchor: 'tokens-heading', keywords: 'api key cli' },
  { section: 'integrations', label: msg('Assistant'), description: msg('The in-app assistant: consent, provider, model and usage'), anchor: 'ai', keywords: 'ai llm anthropic openai gemini' },
  { section: 'integrations', label: msg('AI assistants (MCP)'), description: msg('Read-only access for an AI assistant, or a token that can make changes'), anchor: 'assistants-heading', keywords: 'mcp claude' },
  // Data
  { section: 'data', label: msg('Export'), description: msg('Download everything as JSON, or with files as a ZIP'), anchor: 'data-heading', keywords: 'backup download json zip' },
  { section: 'data', label: msg('Import'), description: msg('Bring in tasks from a file or another app'), anchor: 'data-heading', keywords: 'todoist things ticktick linear csv' },
  { section: 'data', label: msg('Sync status'), description: msg('This device’s sync state'), anchor: 'data-heading', keywords: 'offline pending' },
  { section: 'data', label: msg('Automatic archiving'), description: msg('Archive projects after 30 days without open tasks, and restore archived projects'), anchor: 'projects-heading', keywords: 'archive archived projects' },
  // People
  { section: 'people', label: msg('Users'), description: msg('Everyone with an account, their role and last sign-in'), anchor: 'users-heading', keywords: 'admin deactivate reset password' },
  { section: 'people', label: msg('Members'), description: msg('Invite people with a single-use link'), anchor: 'members-heading', keywords: 'invite invitation' },
  { section: 'people', label: msg('Two-factor policy'), description: msg('Optional, required for the owner, or required for everyone'), anchor: 'mfa-policy-heading', visible: owner, keywords: '2fa mfa policy' },
  { section: 'people', label: msg('Single sign-on'), description: msg('Sign in through your identity provider'), anchor: 'sso-heading', visible: owner, keywords: 'sso oidc', hosted: 'managed' },
  { section: 'people', label: msg('Project invite links'), description: msg('Whether members can bring new people with project links'), anchor: 'project-invite-policy-heading', visible: owner, keywords: 'invite policy' },
  // Server
  { section: 'server', label: msg('Backups'), description: msg('Scheduled backups, destinations, recent runs and restore'), anchor: 'backups-heading', keywords: 's3 webdav restore', hosted: 'managed' },
  { section: 'server', label: msg('Attachments'), description: msg('Turn attachments on or off and set their size limits'), anchor: 'attachments-settings-heading', keywords: 'files upload limit quota', hosted: 'managed' },
  { section: 'server', label: msg('Outgoing email'), description: msg('The SMTP server this server mails password resets, sign-up confirmations and invitations through, and a test message'), anchor: 'outgoing-email-heading', keywords: 'smtp mail sender send test email forgot password', hosted: 'managed' },
  { section: 'server', label: msg('Download your data'), description: msg('The whole server as one backup archive, to move to your own OpenTodo server'), anchor: 'server-archive-heading', keywords: 'archive export backup leave move self-host', hosted: 'only' },
  { section: 'server', label: msg('Branding'), description: msg('Your own name and logo for this server, in the tab, the app icon and the sidebar'), anchor: 'branding-heading', keywords: 'logo favicon icon name white label personal brand' },
  { section: 'server', label: msg('Speech to text'), description: msg('Connect a speech service for dictation'), anchor: 'speech-server-heading', keywords: 'voice dictation whisper speaches stt transcription microphone', hosted: 'managed' },
  { section: 'server', label: msg('Audit settings'), description: msg('How long audit events are kept and whether addresses are recorded'), anchor: 'audit-settings-heading', keywords: 'retention ip address' },
  { section: 'server', label: msg('Audit log'), description: msg('What changed on the server and who did it'), anchor: 'audit-heading', keywords: 'audit' },
], 'label', 'description')

/** The entries this user may open, in list order. */
export function visibleEntries(user: User): SettingsEntry[] {
  const sections = new Set(visibleSections(user).map((s) => s.id))
  const hosted = getHosted()
  return SETTINGS_INDEX.filter((e) => sections.has(e.section) && (!e.visible || e.visible(user)) &&
    (e.hosted === 'managed' ? !hosted : e.hosted === 'only' ? hosted : true))
}

export interface SettingsHit { section: SettingsSection; entries: SettingsEntry[] }

/** Sections and rows matching a query, grouped by section in list order. */
export function searchSettings(query: string, user: User): SettingsHit[] {
  const q = prepareQuery(query)
  if (!q.q) return []
  const out: SettingsHit[] = []
  for (const section of visibleSections(user)) {
    const own = matchPrepared(q, prepare(section.label, section.description(user)), section.label.length).tier > 0
    const rows = visibleEntries(user).filter((e) => e.section === section.id && matchPrepared(q, prepare(e.label, `${e.description} ${e.keywords ?? ''}`), e.label.length).tier > 0)
    if (own || rows.length) out.push({ section, entries: rows })
  }
  return out
}

/** The entry for a section and anchor, if any. */
export function entryFor(user: User, section: SettingsSectionId, anchor: string): SettingsEntry | undefined {
  return resolveSection(user, section) ? visibleEntries(user).find((e) => e.section === section && e.anchor === anchor) : undefined
}

// The element to scroll to and focus once the section page renders (settings
// search, the palette): handed over out of band because the address carries only
// the section.
let pending: string | null = null

export function requestSettingsFocus(anchor: string): void {
  pending = anchor
}

export function takeSettingsFocus(): string | null {
  const a = pending
  pending = null
  return a
}
