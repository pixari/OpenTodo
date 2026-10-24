# Roadmap

OpenTodo set out to replace commercial task managers for people who want to own their data, then go further with what a self-hosted, local-first platform makes possible. **The original roadmap is complete**: every capability below has shipped (see the [changelog](CHANGELOG.md)). Each one was built as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change; the change names are the folders under `openspec/changes/archive/`, and the resulting behaviour contracts live in `openspec/specs/`.

New work starts the same way: `openspec new change <name>` or `/opsx:propose "<idea>"`. See [Parity and depth](#next-parity-and-depth) for the next ten candidates and [Future ideas](#future-ideas) for smaller ones.

## Shipped

### 1. Core engine and architecture

| Capability | Change name | Notes |
| --- | --- | --- |
| Local-first storage, works fully offline, installable PWA | `bootstrap-core-platform` | IndexedDB is the source of truth on each device |
| Conflict-free multi-device sync | `bootstrap-core-platform` | Field-level last-writer-wins op log, convergent by construction. See [docs/sync.md](docs/sync.md) |
| Single small container, runs on a Raspberry Pi | `bootstrap-core-platform` | Static Go binary of about 23 MB with the web app embedded, distroless image of about 25 MB |
| Keyboard navigation (q, j/k, c, 1–4, g+key, ?) | `bootstrap-core-platform` | |
| Live push of changes between devices | `realtime-sync-channel` | Server-sent event wake-ups; the protocol stays op-based, polling is the fallback |
| Rich text with collaborative editing for task notes | `collaborative-rich-text` | Yjs document in `task.notes_doc`, editor lazy-loaded; comments stay Markdown |
| Vim-style modal navigation option | `vim-keybindings` | |
| Public demo instance for the launch | `demo-mode` | `OPENTODO_DEMO=true`: seeded demo account, nightly reset, abusable features off. See [docs/self-hosting/demo.md](docs/self-hosting/demo.md) |
| User guide, docs website and in-app Help | `user-documentation` | One source in `docs/`, built into [open-todo.app/docs](https://open-todo.app/docs/) and an offline Help view with contextual help links. See [docs/README.md](docs/README.md) |
| Your own name and logo on a server | `instance-branding` | Owner-set name and logo in the tab, the installed app's icons, the sign-in screen and the sidebar; "Powered by OpenTodo" stays. See [docs/self-hosting/branding.md](docs/self-hosting/branding.md) |
| Hosted OpenTodo: host mode, many tenants in one process | `multi-tenant-host` | Optional `OPENTODO_HOST_*`: tenants by host name, opened on demand and closed when idle, one scheduler for due work, per-tenant limits, an operator interface, and an archive owners can take to a self-hosted server. The control plane (sign-up site, billing) stays outside this repository. See [docs/self-hosting/host-mode.md](docs/self-hosting/host-mode.md) |

### 2. Capture and input

| Capability | Change name |
| --- | --- |
| Quick add with view-aware defaults | `bootstrap-core-platform` |
| Natural-language quick add in six languages ("Meeting with Sarah next Wed at 3pm #work @call +30m") | `nlp-quick-add` |
| REST API and API tokens for scripts | `bootstrap-core-platform` |
| Command-line client | `cli-client` |
| Email to task (forward to an inbox address) | `email-to-task` |
| Browser extension and mobile share-sheet target (the captured page, or a recognised GitHub, GitLab, Jira or Linear issue, now stays on the task as its origin chip: `task-origin`) | `share-capture` |
| Voice capture via the Web Speech API | `voice-capture` |

### 3. Organisation, views and GTD

| Capability | Change name |
| --- | --- |
| Projects, Inbox, Today, Upcoming, Completed | `bootstrap-core-platform` |
| Nested projects | `project-hierarchy` |
| Sections and Kanban board view | `board-view` |
| Subtask trees with parent progress | `subtask-trees` |
| Labels | `labels` |
| Filter query language (`@work & due <= tomorrow & p1`) | `filter-query-language` |
| Saved views pinned to the sidebar, with display options (list or board, grouping, order, completed tasks, the properties rows show: `views-and-display`), custom dashboards (boards whose columns carry on-drop rules, with an Eisenhower matrix template: `rule-boards`) | `custom-views` |
| Filter by completion date (`completed = last week`), period dates (this, last or next week or month) and a Completed logbook (closes #86) | `completed-date-filters` |
| Trash with restore, auto-archive of completed projects, revision history from the op log | `trash-and-history` |
| Drag-and-drop ordering | `manual-ordering` |
| Custom fields per project: text, number, date, choice, link and checkbox values on tasks, in the panel, on cards, as columns and in filters | `custom-fields` |
| Open Loops, OpenTodo's own method inspired by GTD: the five moves, Next and Waiting views, the Loop home, a weekly review that walks every project with a Daily check and a Monthly look, and a choice of how prominent it is (Lists only, Companion, Open Loops first) | `open-loops-method` |
| Appearance: light, dark or system, and eight colour themes, synced to every device | `theming` |

### 4. Time management

| Capability | Change name |
| --- | --- |
| Floating due dates with optional time | `bootstrap-core-platform` |
| Reminders and web push notifications | `reminders` |
| Recurring rules incl. "every last weekday", "every 3 days after completion" | `recurring-tasks` |
| Duration estimates and time-blocking calendar grid | `time-blocking` |
| Absolute (time-zone aware) times next to floating dates | `absolute-datetimes` |
| Date, time and week-start preferences, and when your day starts | `date-time-preferences`, `day-boundary` |

### 5. Collaboration

| Capability | Change name |
| --- | --- |
| Share projects with roles (viewer, editor, admin) | `project-sharing` |
| Invite links for shared projects, creating the account when allowed | `project-invite-links` |
| Assignees and in-app notifications | `task-assignment` |
| Threaded Markdown comments and activity log | `comments-and-activity` |
| Live activity feed in shared lists | `activity-feed` |

### 6. Integrations and data ownership

| Capability | Change name |
| --- | --- |
| JSON export | `bootstrap-core-platform` |
| JSON / CSV import, including export files from popular commercial task apps | `data-import` |
| Import Todoist, Things, TickTick and Linear exports as they are, with a switch guide for each (Linear estimates now become a number field of `custom-fields`, in `more-importers`). Imported tasks keep their source on the task as an origin (`task-origin`), the first step toward `issue-import` | `named-importers` |
| Import Google Tasks, Trello, Asana, Microsoft To Do, Apple Reminders and Any.do, with a switch guide for each (a PowerShell script for To Do, a Shortcut or CalDAV for Reminders, Any.do's data request); Trello custom fields, Asana columns and Linear estimates become custom fields | `more-importers` |
| Scheduled backups to local disk, S3 or WebDAV | `backups` |
| CalDAV two-way sync (Apple Reminders, Thunderbird, Android via DAVx⁵) | `caldav` |
| Outbound webhooks (Home Assistant, Telegram, n8n) | `webhooks` |
| Notification channels: ntfy, Pushover, Gotify and a webhook for reminders and notifications (closes #271) | `notification-channels` |
| Read-only MCP server for AI assistants, off by default | `mcp-server` |
| AI assistants can make changes through MCP: `agent` tokens, owner and user switches, limits, audit, history labels | `mcp-write-tools` |
| Assistants plan like the app (deadline, start, Someday, This Evening, waiting for, location) on every surface; projects can be kept away from assistants | `agent-planning-fields` |
| stdio bridge for assistants that only speak stdio (`ot mcp`), read-only by default | `mcp-stdio-bridge` |
| `ot` for agent harnesses: versioned `--json` schemas, `ot schema`, `--dry-run`, idempotency keys, `--yes` off a terminal, exit code 5, read-only mode, `agent` tokens on REST content routes, the agent skill file | `agent-ready-cli` |

### 7. Security and access

| Capability | Change name |
| --- | --- |
| Owner setup, password sign-in, sessions, closed sign-up by default, rate limiting, CSP | `bootstrap-core-platform` |
| Invitations for new members | `invitations` |
| Passkeys (WebAuthn) | `passkeys` |
| OIDC single sign-on | `oidc-login` |
| Multi-factor authentication (TOTP) | `mfa-totp` |
| Audit log | `audit-log` |
| User administration: list users, admin role, deactivate, delete, password reset, owner transfer | `user-management` |
| Optional end-to-end encryption of task content | `e2ee` |

## Next: Bring your agent

In this order. Each starts as an OpenSpec change under `openspec/changes/`. The cross-cutting decisions (one agent tool registry shared by MCP and the in-app assistant, the `agent` token scope, the "Allow AI assistants to make changes" switch, and the prompt-injection threat model) are recorded in the `mcp-write-tools` design (archived under `openspec/changes/archive/`).

| # | Capability | Change name | Notes |
| --- | --- | --- | --- |
| 1 | **Shipped.** AI assistants can act through MCP: create, edit, complete, reschedule and move tasks, create projects and labels, comment | `mcp-write-tools` | Needs an `agent` token plus owner and user switches (both off by default). Every write goes through the op log, is attributed in history, audited, rate limited and reversible. No permanent deletion |
| 2 | **Shipped.** `ot` as a dependable tool for agent harnesses | `agent-ready-cli` | Versioned `--json` schemas, `ot schema`, `--dry-run`, idempotency keys, `--yes` required without a terminal, read-only mode, a shipped agent skill file. The CLI stays in this repository; no Homebrew or Scoop repositories for now |
| 3 | **Shipped.** Conversational assistant in the app, with your own model key | `in-app-assistant` | Anthropic, OpenAI, Gemini or any OpenAI-compatible endpoint (including local models). Off by default, per-user consent, every change reviewed before it applies and undoable in one step. End-to-end encrypted accounts run it on their own device with their own key when the owner allows it (`assistant-on-device`). Its own page, the composer tray and the change-set card: `assistant-surface` |
| 4 | **In progress.** A Claude Code plugin with an MCP agent skill | `claude-plugin` | Built in `deploy/claude-plugin/`, published to `pixari/opentodo-claude` after each release. Asks for the server address and an agent token; checks keep the skills in step with the MCP tools |

## Next: Design refresh

One visual language, built in a workbench: friendly and roomy like TickTick, Todoist and Any.do, keeping OpenTodo's emerald and slate identity. Each step is an OpenSpec change.

| # | Step | Change | Notes |
| --- | --- | --- | --- |
| 1 | **In progress.** Design tokens, bundled typeface, refreshed buttons and inputs, and a Storybook workbench with accessibility and visual-regression checks | `design-language` | Dev-only workbench; the app gains only the font (54 KB). No op, API or data change |
| 2 | Shared building blocks: icons, buttons, menus, the smart picker, cards and settings rows | `ui-primitives` | Lucide icons vendored, no new runtime dependency |
| 3 | Settings regrouped into smaller sections with state-first cards | `settings-redesign` | Old settings links keep working |
| 4 | Task detail: smart pickers, comments, activity and history tabs, a usable time-zone control | `task-detail-redesign` | Uses `date-time-preferences` |
| 5 | One menu language everywhere and a redesigned labels page | `labels-and-menus` | |
| 6 | **Shipped.** Moments and onboarding: an illustration set for empty and finished states, three sample tasks and a first-day checklist, Done for today at the end of Close the day, one command bar with Search, Add, Commands and Ask, inline tints in quick add, and one toast primitive | `moments-and-onboarding` | Additive `task.sample` and `user_prefs.start_checklist`; no migration, no dependency |
| 7 | Motion: a completion moment that never delays the write, rows that make room when tasks move, overlays that enter and leave the same way, and a haptics switch | `motion-v2` | View transitions with no dependency (about 2 KB of CSS and helpers); one additive `user_prefs.haptics` field; reduced motion checked by `make ui-check` |
| 8 | Page rhythm: a lead line under larger titles, small group labels, centred standalone pages, Earlier instead of Overdue with its two actions, a due ladder for dates | `page-rhythm` | CSS and strings only; no op-log change |

Related usability fixes, independent of the refresh: your own date and time format (`date-time-preferences`), a test notification that proves delivery (`push-test-delivery`) and restoring a backup from the web app (`backup-restore-web`).

## Next: Parity and depth

Nineteen candidates for after the design refresh, in a suggested order: the first ten close gaps with the apps people switch from, the next four add views and ways to share for households and small teams, and the last five deepen capture and projects. They come from four sources: what the named importers must drop today with a warning (`named-importers`, now shipped with `deadlines` and `someday-and-evening` mapped), the gaps the comparison pages on open-todo.app concede to Todoist, Things and Linear, the open issues, and what the code does not have yet (no search, no multi-select, no attachments, no outgoing mail, English only). Parity with the apps people switch from came first because the hosted offering (`multi-tenant-host`, now shipped as host mode) was scheduled after it. Each starts as an OpenSpec change; none is a commitment.

| # | Capability | Change name | Notes |
| --- | --- | --- | --- |
| 1 | **Shipped.** **Deadlines**, separate from the scheduled day: a task can be planned for Tuesday and due by Friday | `deadlines` | Additive `deadline` field (floating date), shown as a countdown in rows, Today and Upcoming; filters (`deadline <= 3d`), reminders and CalDAV `DUE` versus `DTSTART` follow. The Things and Todoist importers map their deadlines instead of dropping them |
| 2 | **Shipped.** **Start dates, Someday and This Evening**: defer a task until a date, park it without a date, or plan it for tonight | `someday-and-evening` | Additive `start` (date or `someday`) and `evening` fields; deferred tasks stay out of Today and Upcoming until their day, with Someday and Anytime views. Matches Things' "when" model and the GTD someday list; the Things importer maps `start` and `startBucket` |
| 3 | **Shipped.** **Search and command palette** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>): find any task, project, label or setting and run any command from one box | `search-and-command-palette` | Local index over IndexedDB, so it works offline and on end-to-end encrypted accounts without the server seeing anything; filter-query syntax accepted inline; every menu action reachable by name. Keyboard-first principle, no new route |
| 4 | **Shipped.** **Multi-select and bulk actions**: select several tasks and complete, reschedule, move, label, prioritise or trash them at once | `bulk-edit` | <kbd>x</kbd> toggles selection, <kbd>Shift</kbd>+<kbd>j</kbd>/<kbd>k</kbd> extends it, actions apply to the selection; one batch of ops, undone in one step. Checkbox selection on touch. Reuses the assistant's proposal review for "n changes" |
| 5 | **Shipped.** **Attachments**: files and images on tasks and comments, shared from the phone's share sheet or the extension | `attachments` | Blobs under the data directory (one volume), per-file and per-account limits, in backups and the export, served with authentication; encrypted on the device for end-to-end encrypted accounts; refused on the demo instance. Completes the share target (text and links only today) and lets importers keep attachment references |
| 6 | **Shipped.** **Task dependencies**: "blocked by" and "waiting for" between tasks | `task-dependencies` | Additive `blocked_by` list; blocked tasks dimmed in lists and on the board, unblocked ones surface in Today when their blocker is completed; filter `blocked` / `unblocked`. The Linear importer maps relations; GTD's waiting-for list stops needing a label |
| 7 | **Shipped.** **Project templates and duplication**: duplicate a project or task tree, save one as a template, start a project from a template | `project-templates` | Templates are plain JSON in the existing import format, so the website's templates install in one click and a household can reuse its "trip" checklist; recurring checklists ("new client onboarding") duplicate with dates shifted relative to a start day. **Template library** (`template-library`): curated templates in the repository's `templates/` folder, contributed by pull request, browsable offline in the app and published in the site bundle; follow-up on the website: read the templates from the bundle and drop its own copies |
| 8 | **Shipped.** **Calendar feeds, both ways**: show your other calendars in Day and Week, and subscribe to your tasks from Google Calendar or Outlook | `calendar-feeds` | Operator-allowed, user-configured iCalendar URLs fetched by the server on a schedule (same policy as webhooks, refused on the demo), events drawn read-only in the time-blocking grid so free slots are real; a private read-only `.ics` URL per user with revocation. CalDAV keeps the two-way sync for clients that speak it |
| 9 | **Shipped.** **Outgoing email** (optional SMTP): password reset, verified sign-up, invitations and project invites by mail, and an optional daily digest | `outgoing-email` | Phase 2 of `multi-tenant-host`, split out because it helps self-hosters now. `OPENTODO_SMTP_*` optional, nothing changes without it; sending limits, templates in the six quick-add languages, never sends task content for end-to-end encrypted accounts |
| 10 | **Shipped.** **The app in your language**: translated interface in the quick-add languages (English, German, French, Spanish, Italian, Portuguese), community catalogs after | `app-localization` | A small hand-written formatter (no runtime dependency), one lazy catalog chunk per language, precached for offline switching; the language is chosen in Settings → General and synced like the date format, and dates, quick add, voice, push notifications, server errors and the browser extension follow it. Docs and Help stay English. See [docs/language.md](docs/language.md) and [docs/translating.md](docs/translating.md) |
| 11 | **Shipped.** **Month view and timeline**: a month grid for due dates, and a project timeline for start, deadline and dependencies | `month-and-timeline-views` | Month view with drag to reschedule, same grid rules as Day and Week; timeline (a light Gantt) built on `deadlines`, `someday-and-evening` and `task-dependencies`. Linear's roadmap view, sized for a team of five |
| 12 | **Shipped.** **Statistics and weekly review**: what you completed, what slipped, a guided review | `stats-and-review` | Computed on the device from the local rows, nothing sent to the server; a four-step review that walks every project for a next action (the website's weekly-review guide, built in); an optional weekly email digest on top of `outgoing-email`. Streaks on recurring tasks moved to `habits` (row 19). Todoist karma without the gamification |
| 13 | **Shipped.** **Public and guest links**: let someone without an account see a list, or tick items on it | `public-links` | A revocable link per project with view or tick-only rights, rate limited, no account created, every tick attributed to the link; shown with a visible warning that the list is public. The shopping list a visiting relative can check off, the packing list for the group chat |
| 13b | **Shipped.** **Task pages**: publish one task as a page someone without an account can read, reply to and tick | `task-pages` | A private, unindexed link per task with read, reply or reply-and-tick rights, guest replies as comments named "(guest)", notifications, revoke and expiry; encrypted tasks through a per-page share key carried after `#`. The errand handed to a neighbour, the job for a colleague |
| 14 | **Shipped.** **Display mode**: a large-type, read-mostly screen for a tablet on the fridge or an e-ink panel | `display-mode` | `/display/today`, `/display/upcoming` and a route per project or saved view with big type, a clock, today and the next days, live over the existing channel and offline from the local copy, high contrast and no animation for e-ink (`eink=1`), options in the URL. Signed in with the ordinary session; a shared screen uses a dedicated viewer account, which the server enforces (a read-only token cannot fill the device's copy). Public links accept `display=1` for a panel with no account. Small change, large effect for the household toolkit |
| 15 | **Shipped.** **Quick add for recurrence and reminders**: "every Monday", "every 3 days after completion", "remind me at 9" | `quick-add-recurrence` | Six languages like the rest of the parser, a chip that shows the rule in words, the same grammar in `ot add`. Open issue #6; the only quick-add gap people hit daily |
| 16 | **Shipped.** **Project notes**: a description and a pinned note on every project | `project-notes` | Additive `notes_doc` on projects, the same collaborative editor as task notes, shown at the top of the list and the board; the place for the brief, the address, the shopping rules. Todoist and Things both have it; the GTD and household templates need it |
| 17 | **Shipped.** **Inbox triage**: process the Inbox one task at a time, keyboard only | `inbox-triage` | A focused mode (<kbd>g</kbd> <kbd>t</kbd>): one task, its notes, and single-key decisions: do now, schedule, move, delegate, someday, trash; progress "4 of 17". No new data, just a flow. The website's GTD and inbox-zero guides, built in |
| 18 | **Shipped.** **Custom fields per project**: typed columns per project, such as cost, client, effort or a link | `custom-fields` | Field definitions on the project (text, number, date, choice, link, checkbox), values in an additive `fields` map on tasks, shown in the detail panel, as board badges and as table columns; filterable (`cost > 100`), exported and importable. Linear's and Asana's answer to "a task is more than a title", kept small by refusing formulas and rollups |
| 19 | **Shipped.** **Habits with streaks and a month history**: recurring tasks that track streaks and allow a skip without breaking the chain | `habits` | An additive `habit` flag on a recurring task with a calendar rule; streaks and a month heat-map are computed on the device from the occurrence records the series already writes, and a skip of a habit leaves a record marked `skipped`, so "skip today" keeps the streak while missed days do not. A `habit` filter keyword lists them. TickTick's habit tracker without a second app |
| 20 | **Shipped.** **Markdown vault**: a folder of Markdown files in two-way sync, one file per project, for Obsidian and plain-text people | `markdown-vault` | `ot vault` is a sync device (`vault:<id>`) with a three-way merge per field, the Obsidian Tasks line format (`📅`, `🔁`, `🆔`, `⛔` and Dataview inline fields), conflict files instead of silent loss, and encryption on the user's machine. CLI only: the server binary is unchanged. See [docs/vault.md](docs/vault.md) |

Considered and set aside for now, so they are not forgotten: a focus timer with time tracking, ~~groups~~ (now row 1 of the next table), custom keyboard shortcuts, saved views shared with a project's members, board swimlanes and column limits, end-to-end encryption for shared projects, and scheduled assistant routines (an `assistant` action on an automation rule is the natural hook). Rules on events and timers shipped as `automation-rules`, after the drop rules of `rule-boards`. **Hosted OpenTodo** shipped as host mode (`multi-tenant-host`); running the service itself (control plane, pricing) is tracked outside this repository.

## Next: ten more

The next candidates, in a suggested order. Each starts as an OpenSpec change; none is a commitment.

| # | Capability | Change name | Notes |
| --- | --- | --- | --- |
| 1 | **In progress.** **Workspaces and groups**: separate rooms for work and home, each with its own projects, labels, filters and people, and sharing a project with a whole group in one step | `workspaces` | Additive `workspace_id` on projects, labels, views and project-less tasks; a server-side directory (members, groups, invite links) delivered in every sync; effective project membership materialised from grants. Follow-ups: group mentions (`@Family`) and a `workspace:` filter term |

## Next: Native shells

Phone and desktop apps as thin shells around the same web app, loaded from your own server (decided in `native-shells`, design D1 to D3). Each is an OpenSpec change.

| # | Shell | Change | Notes |
| --- | --- | --- | --- |
| 1 | **In progress.** Android app: first-run server screen, reminders scheduled on the phone without a push service, the share menu, Today and quick-add widgets, fingerprint unlock of an encrypted account | `native-shells` | Hand-written Kotlin around a `WebView`, AndroidX only (APK about 1 MB). Open: Play and F-Droid listings and the signing key (owner), instrumented emulator tests, a real-device smoke test |
| 2 | iOS app with the same bridge | `ios-shell` | Open: App Store review of a server-URL app, a Mac runner in CI, whether reminders can be refreshed in the background often enough without push |
| 3 | Desktop app for macOS and Windows: the embedded server plus a window, a tray icon and native notifications | `desktop-shell` | Open: Wails v3 or the `webview/webview` binding (D2), code signing and notarisation, where the data directory lives |

## Future ideas

Not commitments, just honest next steps. Each would start as an OpenSpec change.

- **Real-world verification.** Exercise the integrations that automated tests could only simulate: CalDAV with Apple Reminders, Thunderbird and DAVx⁵; single sign-on with Authentik and Keycloak; email to task with common IMAP providers; MCP with real assistant clients; voice capture, web push, passkeys and touch drag and drop on real devices; the Firefox share flow. Fix what they turn up and record the results in the docs.
- **Reminders over CalDAV.** Map `VALARM` to OpenTodo reminders in both directions instead of only preserving alarms verbatim.
- **Rich text for comments.** Comments are Markdown today; reuse the notes editor where it helps without losing the plain-text API.
- **Built-in SMTP receiver** for email to task, for operators who own an MX record (`email-smtp-receiver`).
- **Published browser extension** in the Chromium and Firefox stores. (File and image sharing through the share target is part of `attachments` above.)

## Principles that do not change

- The client is the source of truth; the server syncs. Nothing should require the network to work.
- One container, one volume, no mandatory configuration.
- No telemetry. No paid tier. AGPL forever. The only default outbound destination is the map provider (OpenStreetMap-based), which the owner can change or turn off.
