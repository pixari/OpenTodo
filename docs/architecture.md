---
title: Architecture
summary: How data flows from a tap on the screen to every device: server packages, tables, client modules and the build.
audience: developer
section: Internals
specs: [site-bundle]
screens: []
order: 10
---
# Architecture

OpenTodo is a local-first application with a thin sync server. Every device holds a full copy of the user's data in IndexedDB and edits it offline; the server keeps an append-only operation log, resolves it to current values, and offers the same data to other devices, scripts and integrations.

```
┌──────────────────────── browser / PWA ─────────────────────────┐
│  React views  ◄── useLiveQuery ──  IndexedDB (Dexie)           │
│       │                               ▲        │               │
│   mutate()  ──► applyOps (LWW) ───────┘        └► outbox       │
│                                                       │        │
│  sync engine: push outbox / pull since cursor ◄───────┘        │
└──────────────────────────────┬─────────────────────────────────┘
                               │  POST /api/v1/sync  (JSON, same origin)
                               │  GET  /api/v1/sync/events  (SSE wake-ups, cursor only)
┌──────────────────────────────▼─────────────────────────────────┐
│  Go server (single static binary)                              │
│                                                                │
│  httpapi ── REST, auth, CalDAV (/dav), MCP (/mcp), SSE         │
│     │                                                          │
│  sync: Apply / ApplyStrict ── op log + scope_fields (SQLite)   │
│     │  after commit: observer, sinks, notifier                 │
│     ├─► webhook queue + worker      ├─► notify (in-app)        │
│     └─► Notifier (wake devices)                                │
│                                                                │
│  background: push scheduler · email poller · backup scheduler  │
│              trash retention · audit pruning · webhook worker  │
│                                                                │
│  embedded web app (internal/web/dist)        /data (SQLite)    │
└────────────────────────────────────────────────────────────────┘
```

## Data flow

### Every write is an op

All task, project, label, section, view, reminder, comment and project-preference data changes as **field-level operations** (`{entity, entityId, field, value, ts, device}`), never as direct row writes. `internal/sync` validates each op against `Schema` (`internal/sync/ops.go`), resolves its **sharing scope** (`user:<id>` for personal data, `project:<id>` for a shared project and everything in it), checks the author's role, stores it in `ops` / `op_scopes` and updates the winner per field in `scope_fields` by last-writer-wins (`ts`, then `device`). Replaying the same ops in any order gives the same state. The protocol is in [sync.md](sync.md).

The writers are:

| Writer | Path | Device id |
| --- | --- | --- |
| Web app on each device | `POST /api/v1/sync` → `sync.Apply` (refused ops reported per op, never block the outbox) | the device's id |
| REST API, CLI | handler turns body fields into ops → `sync.ApplyStrict` (all or nothing) | `server:<boot id>` (`server` in ops from older releases) |
| CalDAV clients | `/dav/` PUT, PROPPATCH, MKCALENDAR, DELETE → one op per changed property | `caldav:<app password id>` |
| Email to task | IMAP poller → `ApplyStrict`, ids derived from account and Message-ID | `server:<boot id>` |
| Import | background job, batches of 1,000 ops | `import` |
| Server itself | reminder delivery (`delivered_at`), unassigning people who leave a project or whose account is deleted, recurring completion via REST | `server:<boot id>` |

Every server-side writer takes its timestamps from one strictly increasing clock (`sync.Service.ServerTS`), and the boot id is chosen when the process starts, so two server writes never tie under last-writer-wins.

Membership, accounts, tokens, settings, webhooks, audit events and backup runs are **not** ops: they are server-side account data in ordinary tables, changed only through authenticated REST routes.

### Request flow for a REST write

`POST /api/v1/tasks` → auth middleware resolves the user (session cookie with origin check, or bearer token with its scope) → body fields become ops with `ts = Service.ServerTS()`, `device = "server:<boot id>"` → `sync.ApplyStrict` resolves each op's scope and checks the caller's role → after commit the observer queues webhook deliveries for genuine changes (for every member who can see the scope) and notification sinks record assignments and mentions → `sync.NotifyApplied` wakes the open event streams of everyone who can see the change → the entity is re-read from `scope_fields` → JSON response. Devices receive the ops on their next sync, which the wake-up triggers at once.

### Reads

REST collections, the export, MCP tools (the shared agent tool registry in `internal/agenttools`, whose write tools plan changes and apply them with `ApplyStrict` as device `agent:<token-id>`) and resources, CalDAV reports and webhook payloads all read materialised entities through `sync.List` / `sync.Get` (and helpers such as `TaskComments`, `Memberships`), restricted to the scopes the caller can see. History and activity are derived on request from the op log (`ActivityOps`, `activity.Derive`); there is no separate activity table on the server.

### Live updates

`GET /api/v1/sync/events` is a server-sent event stream per device (`httpapi/events.go`). It carries only the latest op cursor, never data; the client reacts by running the ordinary sync exchange. `sync.Notifier` is the in-memory per-user fan-out (at most 10 streams per account; `httpapi/events.go` also caps streams per client address and per server). See [sync.md](sync.md#live-updates).

### Background work

Started by `cmd/opentodo` and stopped on shutdown:

- **Reminder push scheduler** (`push.Service.Run`, unless `OPENTODO_PUSH=off`): one pass at startup and every 30 s. A single query over `scope_fields` (reminders are always personal) selects reminders whose `fire_at` has passed, not deleted, not delivered or dismissed for the current firing, whose task is open; each is encrypted and posted to every subscription of the owner (404/410 removes the subscription), then `delivered_at` is written through `sync.Apply` as device `server`. Delivery state lives in the op log, so a restart neither loses nor repeats a push (a crash between send and write can repeat one).
- **Webhook worker** (`webhook.Run`): sends queued deliveries with retries; finishes the pass in progress on shutdown.
- **Email poller** (`email.Run`): polls the configured IMAP mailbox, only when `OPENTODO_EMAIL_*` is set.
- **Backup scheduler** (`backup.Start`): runs scheduled backups; a missed run executes once at startup.
- **Trash retention** (`sync.RunRetention`): purges items older than `OPENTODO_TRASH_RETENTION_DAYS` at startup and daily.
- **Audit pruning**: at startup and hourly. Old read notifications are swept at startup.

## Server packages (`cmd/opentodo`, `internal/`)

| Package | Responsibility |
| --- | --- |
| `config` | `OPENTODO_*` environment variables with defaults and validation; nothing is mandatory |
| `codesize` | Test only: `go test ./...` fails when a function under `internal/` is longer than 150 lines or a file longer than 1,100 lines; exceptions need a reason, and the list can only shrink |
| `store` | Opens SQLite (pure-Go `modernc.org/sqlite`, WAL): one writer connection whose write transactions begin `IMMEDIATE`, and a pool of query-only reader connections (`OpenReader`) for pure reads such as `sync` List, Get and Pull; applies embedded migrations (`migrations/NNNN_*.sql`) by `PRAGMA user_version`; runs `PRAGMA optimize` at open and daily; `Lock` holds `<data>/opentodo.lock` for the process lifetime |
| `tenant` | Builds one server around one data directory: the database and its lock, the services, the notifier, the HTTP handler and the background jobs. A self-hosted server opens exactly one tenant |
| `host` | Optional multi-tenant host, built only with `OPENTODO_HOST_URL`: a registry of tenants beside their data directories, host-name routing, lazy open and idle close, one scheduler for every tenant's background work, per-tenant limits and the operator interface a control plane drives |
| `settings` | Owner-level key/value settings (`settings` table, JSON values) and 0600 secret files under `<data>/secrets/` |
| `sync` | Op schema and validation, `Apply` (idempotent, LWW, per-op authorisation and refusal reasons) and `ApplyStrict` (REST), `Pull` (cursor, member backfill), materialised reads, sharing scopes (`scope.go`) and membership (`members.go`), trash, history and purge, the post-commit observer and sinks, `Notifier` (per-user live wake-ups) |
| `auth` | Users and roles, argon2id passwords, sessions, API tokens and their scopes, CalDAV app passwords, invitations, password resets, user administration, TOTP and recovery codes, step-up, passkeys storage, provider identities (subject-first matching, verified-email linking, provisioning, the SSO-only rule) |
| `webauthn` | Passkey verification: clientDataJSON, authenticator data, COSE keys (ES256, Ed25519, RS256), signature checks; uses `fxamacker/cbor` for CBOR (the other third-party Go modules are SQLite and `golang.org/x/crypto` for argon2). `testauth` is a synthetic authenticator for tests |
| `oidc` | Single sign-on with one OpenID Connect provider, standard library only: discovery, PKCE, code exchange, JWKS cache, identity-token verification, the signed flow-state cookie, owner configuration and `OPENTODO_OIDC_*` overrides. `oidctest` is an in-process provider for tests. See [self-hosting/sso.md](self-hosting/sso.md) |
| `audit` | The closed catalogue of security events with typed constructors and an allow-list for details, recording (in the same transaction as credential changes), queries, NDJSON export and retention pruning |
| `outbound` | The policy for every request to an address a user or the owner typed: http(s) only, no private network targets unless the owner allows them, the connection pinned to the address that was checked. Used by webhooks (and through their client by push and the assistant) and by calendar subscriptions |
| `demo` | The public demo instance (`OPENTODO_DEMO=true`): a hidden owner, a private short-lived sandbox per visitor seeded through the op log, the nightly reset; the HTTP side and its deny list are in `httpapi/demo.go` |
| `httpapi` | Router (stdlib `net/http` with method patterns), middleware (auth, origin check, security headers, rate limits, logging), JSON error envelope, handlers for every `/api/v1` route, the CalDAV transport (`caldav_*.go`), the MCP transport (`mcp.go`) and the event stream |
| `web` | Embeds the Vite build (`internal/web/dist`) and serves it with SPA fallback and cache headers |
| `notify` | Post-commit events for people: the `Sink` interface the sync service calls after a batch commits, and the in-app sink that stores `notifications` for assignments and mentions |
| `activity` | Pure derivation of attributed activity events from ops (fold by actor and entity within 5 s, classify by touched fields, page newest first); mirrored by `web/src/lib/activity.ts` and pinned by a shared fixture |
| `webhook` | Maps observed changes to events, durable queue in SQLite, one worker with retries, HMAC signing, SSRF-safe HTTP client. See [webhooks.md](webhooks.md) |
| `push` | Web push for reminders with the standard library: VAPID key pair in `<data>/push_vapid.pem`, ES256 JWTs, RFC 8291 `aes128gcm`, per-device subscriptions and the scheduler. See [reminders.md](reminders.md) |
| `recurrence` | Parser and next-occurrence calculator for recurrence rules; mirrored by `web/src/lib/recurrence.ts` against shared vectors. See [recurrence.md](recurrence.md) |
| `quickadd` | Go port of the quick-add parser (`web/src/lib/nlp`): dates and times, `#project @label p1 +30m`, recurrence and reminder phrases in six languages, kept identical by shared vectors; used by the CLI and the importer |
| `zoned` | Resolves time-zone-fixed due values to instants (gaps and overlaps included); mirrored by `web/src/lib/dates.ts` against shared vectors |
| `filter` | Go port of the filter query parser, used to validate saved views; evaluation stays on the client. See [filters.md](filters.md) |
| `importer` | Reads the own export, CSV and other apps' JSON exports into rows, plans projects, labels, parents and duplicates, and writes ops in background jobs with undo. `sanitize` is a command that turns a real export into a test fixture; it is never linked into the server. See [import.md](import.md) |
| `blobs` | Attachment bytes as immutable files under `<data>/attachments/`, written once through a temporary file with the size and SHA-256 checked, streamed and never read whole. See [attachments.md](attachments.md) |
| `calfeed` | Calendar feeds: other people's calendars read into read-only events (fetched through `outbound`), and the user's tasks written as an iCalendar feed. See [calendar-feeds.md](calendar-feeds.md) |
| `backup` | Snapshots (`VACUUM INTO`), tar/gzip archives, `OTBK1` encryption, local / S3 (SigV4) / WebDAV destinations, scheduler, retention, `Restore`. See [backups.md](backups.md) |
| `caldav` | Protocol pieces of the CalDAV endpoint: iCalendar tokenizer and serialiser for VTODO, the VTODO ↔ task mapping (unmapped lines kept in `ical_extra`), WebDAV XML parsing and multistatus rendering; HTTP handling lives in `httpapi`. See [caldav.md](caldav.md) |
| `mcp` | Model Context Protocol server: a JSON-RPC 2.0 subset that serves the tools of `agenttools` (read tools always; write tools behind the owner's switch, the user's switch and an `agent` token) and read-only `opentodo://` resources, plus the owner switches. See [mcp.md](mcp.md) |
| `agenttools` | The one registry of tools an AI agent can call (definitions, argument validation, planning into change sets, untrusted-text marking, write limits, the write permission gate, `agent.write` audit), shared by MCP and the in-app assistant; writes only through `ApplyStrict`. Also the per-user "Allow AI assistants to make changes" switch |
| `assistant` | The in-app assistant: the owner's configuration and provider keys, per-user consent and token usage, the model providers (Anthropic through the official Go SDK, one standard-library Chat Completions adapter for OpenAI, Gemini and compatible endpoints) and the agent loop that runs read tools and plans write tools without applying them; the browser applies the confirmed part. See [assistant.md](assistant.md) |
| `email` | Email to task: minimal IMAP client (TLS or STARTTLS), MIME parsing to title and description, sub-address routing, per-account inboxes, limits and the poller. See [email.md](email.md) |
| `mail` | Optional outgoing email: the owner's SMTP configuration with `OPENTODO_SMTP_*` overrides, a standard-library SMTP transport with an explicit TLS policy, plain-text templates in six languages, sending limits and audit events; every message goes through `Service.Send`. `smtptest` is an in-process SMTP server for tests |
| `digest` | The opt-in weekly email digest: per-user settings, the scheduler on the jobs leader, and the content built from the user's materialised rows with the same definitions as the Statistics screen |
| `e2ee` | Server side of end-to-end encryption: stores the wrapped key record with optimistic versioning, recognises ciphertext so server-side features degrade explicitly, purges superseded content ops. The server runs no content cryptography. See [e2ee.md](e2ee.md) |
| `ids` | UUID v4, name-based ids (SHA-256, version 8 UUIDs, for recurring occurrences and tasks created from email) and random secrets |
| `cli` | The `ot` command-line client (`cmd/ot`): profiles, REST calls, table and `--json` output. See [cli.md](cli.md) |

### Tables

| Area | Tables |
| --- | --- |
| Op log and current values | `ops` (append-only, `user_id` = author, `seq` autoincrement), `op_scopes` (the sharing scope of each op), `scope_fields` (winner per field within a scope), `purges` (markers for permanently deleted entities) |
| Sharing | `project_scopes`, `project_members` (roles, outside the op log), `member_backfills` (history replay per member device) |
| Accounts and credentials | `users`, `user_status`, `sessions`, `session_auth`, `session_oidc`, `api_tokens`, `api_token_scopes`, `api_token_agent`, `user_agent_access`, `app_passwords`, `passkeys`, `identities`, `mfa_totp`, `mfa_recovery_codes`, `trusted_devices`, `invitations`, `password_resets` |
| Features | `notifications`, `push_subscriptions`, `webhooks`, `webhook_deliveries`, `import_jobs`, `import_items`, `caldav_resources`, `email_inboxes`, `email_receipts`, `encryption_keys` |
| Operations | `settings` (owner key/value settings, also the log `generation`), `audit_events`, `backup_runs` |

Files in the data directory: `opentodo.db` (plus WAL files), `opentodo.lock`, `push_vapid.pem`, `secrets/` (backup and single sign-on secrets, 0600, never archived) and `backups/` (default local backup folder).

## Client (`web/`)

| Module | Responsibility |
| --- | --- |
| `lib/db.ts` | Dexie database: `projects`, `tasks`, `labels`, `views`, `reminders`, `sections`, `comments`, `prefs` (synced `project_prefs`), `outbox`, `meta` (device settings), plus caches (`memberships`, `notifications`) and the local `activity` log |
| `lib/types.ts` | Entity types; field names mirror `internal/sync/ops.go` |
| `lib/hlc.ts` | Hybrid logical clock and the shared `wins()` rule |
| `lib/ops.ts` | `applyOps` (per-field LWW into IndexedDB, merge-and-republish of note documents), `mutate` (local apply + outbox + notify), entity helpers and defaults |
| `lib/sync.ts` | Background push/pull loop, triggers, live-update channel (`EventSource` with backoff), status store (`useSyncStatus`) |
| `lib/api.ts` | Fetch wrappers and `ApiError` |
| `lib/e2ee.ts`, `lib/crypto.ts`, `lib/e2eeSync.ts` | End-to-end encryption: key record handling, AES-256-GCM field encryption, encrypt at upload and decrypt before apply |
| `lib/nlp/` | Natural-language quick add (tokenizer, dates, attributes, languages) |
| `lib/filter/`, `lib/filters.ts` | Filter query parser and evaluator, duration predicates |
| `lib/recurrence.ts`, `lib/recurring.ts` | Recurrence grammar and the completion, skip and detach flows |
| `lib/dates.ts` | Floating and zoned due values |
| `lib/ordering.ts`, `lib/dnd.ts` | Fractional positions and pointer drag and drop (no library) |
| `lib/reminders.ts`, `lib/reminderTime.ts`, `lib/reminderWatcher.ts`, `lib/push.ts` | Reminder writes and time arithmetic, the in-app watcher, the device's push subscription |
| `lib/comments.ts`, `lib/activity.ts`, `lib/feed.ts`, `lib/markdown.ts` | Comments and mentions; the shared activity rule, local recording and merging of older server pages; the cross-project feed and unread counts; the in-house Markdown subset (rendered by `app/Markdown.tsx` as React elements, so raw HTML never reaches the DOM) |
| `lib/docfields.ts`, `lib/richtext.ts`, `lib/richtextEditor.ts`, `app/NotesEditor.tsx` | Rich-text notes ([sync.md](sync.md#mergeable-documents)): the document field list and lazy loader; the Yjs document code (envelope, merge, growth check, Markdown projection); the ProseMirror schema and binding; the editor component. The last three are lazy chunks |
| `lib/share.ts` | Parsing of share-target and bookmarklet payloads |
| `public/push-sw.js` | Imported by the generated service worker: `push`, `notificationclick` (snooze and dismiss written as ops into the outbox), `notificationclose` |
| `app/` | Router, auth screens, shell, views (lists, board, calendar, filters, dashboards, feed, trash), detail panel, settings panels, Vim layer (`app/vim/`, lazy) |

The UI never talks to the server for task data. Views subscribe to IndexedDB with `useLiveQuery`; local edits and remote ops surface through the same path. Views that need the whole task list share one live snapshot (`web/src/lib/liveTasks.ts`) instead of each scanning the tasks table on every change. Account-level screens (users, audit log, backups, webhooks, tokens) call the REST API directly and need a connection.

## Build and packaging

`web/` builds into `internal/web/dist`, which `go:embed` compiles into the binary (`internal/web/dist/.gitkeep` keeps the embed compiling on a fresh clone). The Dockerfile runs both builds on the build platform, cross-compiles a static binary (`CGO_ENABLED=0`, `-trimpath -s -w`) and copies it into `gcr.io/distroless/static-debian12:nonroot`. CI publishes `linux/amd64` and `linux/arm64` images to GHCR and attaches the server and `ot` binaries, the browser extension zip, the agent skill and the **site bundle** (`opentodo-site-bundle-<version>.tar.gz`: the docs website, screenshots, colour tokens, icons, changelog and a feature manifest, which the website repository builds from) to releases; every CI run uploads the same bundle as an artefact. The server binary is about 27 MB (about 5 MB of it is the official Anthropic SDK for the in-app assistant, about 1.6 MB the five interface language catalogs). Nothing in the server may use `text/template`, `html/template` or `reflect.Value.MethodByName`: any of them stops the linker from pruning unused methods and adds about 13 MB.

## Specs

Behaviour is specified in `openspec/specs/<capability>/spec.md` (live) and proposed in `openspec/changes/`; shipped changes are archived under `openspec/changes/archive/`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
