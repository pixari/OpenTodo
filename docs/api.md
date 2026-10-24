---
title: HTTP API
summary: Authentication, every route, entity fields, error codes and examples for scripts and integrations.
audience: developer
section: Integrations
specs: [http-api]
screens: []
order: 10
---
# HTTP API

Base path: `/api/v1`. All requests and responses are JSON. Errors look like:

```json
{ "error": { "code": "invalid_input", "message": "task.priority must be an integer from 1 (highest) to 4 (lowest)" } }
```

## Authentication

Two options:

- **Session cookie** (the web app). Obtained from `auth/register` or `auth/login`. State-changing requests must come from the app's own origin.
- **Bearer token** (scripts, CLI, AI assistants). Create one in **Settings → Integrations → API tokens** (**New token**, then a name and the access) or via `POST /tokens`, then send `Authorization: Bearer ot_…`.

A token has a **scope**: `full` (the default), `read`, `agent` or `admin`. A `read` token reads everything its account can read but is refused with 403 `insufficient_scope` on every request that can change something: every method other than `GET`, `HEAD` and `OPTIONS`, and `/api/v1/sync` whatever the method. That includes creating another token, so a read token cannot escalate itself. Tokens created before scopes existed are `full`. Give read tokens to anything that only needs to look, such as an AI assistant connected to the [MCP endpoint](mcp.md).

An `agent` token is for an AI assistant that may make changes. It is the only scope that may call the MCP write tools, and only while the owner's `writes_enabled` and the user's `allow_writes` are both on ([mcp.md](mcp.md#letting-an-assistant-make-changes)). On the REST API it may write only on the [agent content routes](#agent-tokens) (create and edit tasks, projects, labels and comments) under the same switches and limits; every other write is refused like a `read` token's, including `/api/v1/sync`, `/api/v1/tokens`, every settings route and `/api/v1/me/agent-access` (even `GET`). It is stored as a `read` scope plus a marker, so a server downgraded to a version without `agent` treats it as read-only.

### Token scopes

A `full` token can do everything its account can **except** the *credential* routes (marked **credential** in the tables below): turning the second factor on or off, recovery codes, passkeys, creating API tokens and app passwords, unlinking a single sign-on identity, the own password, invitations, user administration (roles, deactivation, deletion, reset links, ownership transfer, second-factor resets), the two-factor policy, single sign-on settings, the encryption key record, and the server settings that hold secrets (outgoing email, backups, the assistant's provider key). There a `full` token gets 403 `insufficient_scope`; a session (recently confirmed where the route is also *fresh*) or an **`admin`** token is accepted. Reading those settings and lists, revoking tokens and app passwords, and forgetting remembered browsers stay open to `full` tokens. An `admin` token can do everything a `full` token can plus the credential routes, and is never challenged for freshness. It can only be created from a signed-in session that confirmed the password or a code in the last ten minutes (Settings → Integrations → API tokens → **New token**, access **Admin**, or `POST /api/v1/tokens` with `{"scope":"admin"}` from that session); a token, even an `admin` one, cannot create an `admin` token (403 `session_required`). Like `agent`, it is stored as a `read` scope plus a marker, so a downgraded server treats it as read-only. Tokens created before this rule keep their scope: a `full` script that changed credentials or administered users needs an `admin` token now.

`GET /api/v1/me` tells a client which credential it is using: see [Credential introspection](#credential-introspection).

```bash
export OT=https://todo.example.com
export TOKEN=ot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

If you would rather not hand-write requests, the [`ot` command-line client](cli.md) wraps this API and prints the same entity shapes with `--json`.

### How a non-browser client signs in

Bearer tokens are minted by a signed-in user, so a client that only has an email and a password goes through a short session, which is what `ot login` does:

1. `POST /api/v1/auth/login` with `{email, password}` → the `opentodo_session` cookie.
2. `POST /api/v1/tokens` with that cookie and `{"name":"cli@<hostname>"}` → `{token, secret}`. Send **no `Origin` header**: cookie-authenticated writes are refused when `Origin` is present and does not match the server, and accepted without it (browsers always send one, non-browser clients normally do not).
3. `POST /api/v1/auth/logout` with the cookie, then keep only the `secret` and use it as a bearer token. Bearer requests are not subject to the Origin check.

Login is rate limited (10 attempts per minute per address); a token created in Settings and passed to `ot auth set-token` skips the session entirely.

If the account has two-factor authentication, step 1 answers `{"mfaRequired":true,"challenge":"…"}` without a cookie. Post the challenge and a code to `POST /api/v1/auth/mfa` to get the cookie, then continue with step 2 (see [Two-factor authentication](#two-factor-authentication)). The fresh session can create the token without re-authenticating. Bearer tokens are never asked for a code.

### Endpoints

Auth column: **none** = public; **yes** = any session or token (a `read` token only on `GET`); **owner**, **admin** = that account role; **member** = a member of the project; **fresh** = a step-up route for sessions (see [Two-factor authentication](#two-factor-authentication)); **credential** = a session or an `admin` token, never a `full` one (see [token scopes](#token-scopes)); **cookie** = a browser session. Every route's policy is declared where it is registered (`internal/httpapi/policy.go`) and checked by a test. Every `/api/v1` route not listed as public requires authentication.

#### Health and authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/healthz` | none | `{"status":"ok","version":"…"}` |
| GET | `/api/v1/auth/status` | none | `{setupRequired, setupTokenRequired, setupCodeRequired, signupAllowed, authenticated, user, version, passkeysAvailable, oidc, outgoingEmail, mfa?, encryption?, minClientVersion?, demo?}`; `outgoingEmail` is `{enabled}`, true when [outgoing email](#outgoing-email) is configured (never on a demo instance); `mfa`, `encryption` and `minClientVersion` only when signed in; `setupCodeRequired` is true while no account exists, no setup token is configured and the requesting client's address is not loopback, private or link-local; `demo` (`{token, sandboxHours: {idle, max}, resetsAt}`: a fresh single-use sandbox-creation token valid for 10 minutes, the sandbox lifetimes in hours and the next nightly reset; no credentials) only on a [demo instance](self-hosting/demo.md) (see [Two-factor authentication](#two-factor-authentication), [Single sign-on](#single-sign-on), [End-to-end encryption](#end-to-end-encryption)) |
| POST | `/api/v1/auth/register` | none | `{email, name?, password, invitation?, projectInvite?, setupToken?}` → 201 `{user}` + cookie. The first account becomes owner; when `OPENTODO_SETUP_TOKEN` is set (`setupTokenRequired` in the status), it needs `setupToken` with that value, otherwise 403 `setup_token_invalid`; without a token, a client outside the local network (`setupCodeRequired`) sends the one-time setup code from the server log as `setupToken` (case and dashes ignored), otherwise 403 `setup_code_invalid`; afterwards an `invitation` secret admits one member while sign-up is closed, and a `projectInvite` secret creates a member who joins that project (201 `{user, projectId, role}`, see [Project invite links](#project-invite-links)). With open sign-up and [outgoing email](#outgoing-email), a registration without an invitation answers 202 `{verificationRequired: true}` and mails a link instead of creating the account |
| POST | `/api/v1/auth/login` | none | `{email, password}` → `{user}` + cookie, or `{mfaRequired:true, challenge, expiresAt}` and no cookie when the account has a second factor. A password over 1,024 bytes is refused with 401 `invalid_credentials` without being checked |
| POST | `/api/v1/auth/mfa` | none | `{challenge, code}` or `{challenge, recoveryCode}`, optional `remember` → `{user}` + cookie (+ `ot_trust` cookie when `remember`) |
| POST | `/api/v1/auth/reauth` | cookie | `{password}` or `{code}` → `{reauthAt, validForMs}`; unlocks *fresh* routes for 10 minutes |
| POST | `/api/v1/auth/passkey/options` | none | → `{publicKey}` sign-in options, see [Passkeys](#passkeys) |
| POST | `/api/v1/auth/passkey` | none | `{credential}` → `{user}` + cookie |
| POST | `/api/v1/auth/logout` | cookie | 204, or 200 `{redirect}` (provider sign-out, see [Single sign-on](#single-sign-on)) |
| POST | `/api/v1/demo/sandbox` | none | [demo instance](self-hosting/demo.md) only (absent otherwise): `{token}` from `auth/status` → 201 `{user}` + cookie for a new private sandbox. Requires a same-origin `Origin` header; 403 `demo_token` (missing, forged, expired or used token), 403 `bad_origin`, 429 `rate_limited` (5 per address per hour), 503 `demo_busy` |
| GET | `/api/v1/auth/oidc/start` | none | browser navigation: 302 to the provider (links the identity instead when signed in) |
| GET | `/api/v1/auth/oidc/callback` | none | provider return: 303 to `/` + cookie, or to `/?error=…` |
| GET | `/api/v1/invitations/{token}` | none | preview `{inviterName, email, expiresAt}` or 404 `invitation_invalid`, see [Invitations](#invitations) |
| GET | `/api/v1/project-invites/{token}` | none | preview `{inviterName, projectName, role, email, expiresAt, canCreateAccount, alreadyMember?}` or 404 `invitation_invalid`, see [Project invite links](#project-invite-links) |
| POST | `/api/v1/auth/password-reset` | none | `{email}` → always 202 `{ok: true}`; mails a reset link to an active account's address, see [Outgoing email](#outgoing-email); 404 `smtp_disabled` without outgoing email, 409 `base_url_required` without `OPENTODO_BASE_URL` |
| GET | `/api/v1/auth/verify/{token}` | none | pending sign-up `{email, expiresAt}` or 404 `verification_invalid` |
| POST | `/api/v1/auth/verify/{token}` | none | creates the account of a pending sign-up → 201 `{user}` + cookie; 404 `verification_invalid`, 403 `signup_closed`, 409 `email_taken` |
| GET | `/api/v1/password-resets/{token}` | none | preview `{email, expiresAt}` or 404 `reset_invalid` |
| POST | `/api/v1/password-resets/{token}` | none | `{password}` → 204 or 404 `reset_invalid` |

#### Your account and credentials

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/me` | yes | `{user, mfa, encryption: {enabled, keyVersion}, minClientVersion, auth, agent_excluded_projects}`; `auth` describes the credential, see [Credential introspection](#credential-introspection); `agent_excluded_projects` lists the projects [kept away from assistants](#keeping-a-project-away-from-assistants). The owner's session also gets `config_warnings: [{variable, message, ignored?}]`, configuration problems the server started despite (an invalid `OPENTODO_TRUSTED_PROXIES` entry, outgoing email without `OPENTODO_BASE_URL`), empty when there are none; admins, members and tokens never get the field |
| POST | `/api/v1/me/password` | credential, fresh | `{currentPassword, newPassword}` → 204; signs out your other sessions |
| GET | `/api/v1/me/activity` | yes | `{events:[…]}`: your own access events, last 90 days, at most 100 |
| GET | `/api/v1/me/agent-access` | session or `full` token | `{allow_writes, owner_allows_writes, mcp_enabled}`: your "Allow AI assistants to make changes" switch; `read` and `agent` tokens → 403 `insufficient_scope` |
| PUT | `/api/v1/me/agent-access` | session or `full` token | `{allow_writes: boolean}` → same shape; recorded as `settings.changed` (`agent.writes`); anything else → 400 `invalid_input`; demo instances → 403 `demo_restricted` |
| GET | `/api/v1/me/email-digest` | session or `full` token | your weekly email digest settings, see [Weekly digest](#weekly-digest); `read` and `agent` tokens → 403 `insufficient_scope` |
| PUT | `/api/v1/me/email-digest` | session or `full` token | any of `{enabled, weekday, hour, timeZone, language}` → the same shape; demo instances → 403 `demo_restricted` |
| GET | `/api/v1/me/identities` | yes | `{identities:[…], provider}` |
| DELETE | `/api/v1/me/identities/{id}` | credential | 204, or 409 `last_credential` |
| GET | `/api/v1/tokens` | yes | `{tokens:[{id,name,scope,createdAt,lastUsedAt}]}`; `lastUsedAt` is updated at most once a minute |
| POST | `/api/v1/tokens` | credential, fresh | `{name, scope?}` (`full` default, `read`, `agent` or `admin`) → 201 `{token, secret}` (secret shown once); another scope → 400 `invalid_input`; `admin` only from a session (a token gets 403 `session_required`) |
| DELETE | `/api/v1/tokens/{id}` | yes | 204 |
| POST | `/api/v1/me/sign-out-everywhere` | cookie, fresh | → 204 and the session cookie cleared: ends every session of the account (this one too), forgets its remembered browsers and revokes its API tokens and app passwords; recorded as `sessions.revoked`; a token gets 403 `session_required` |
| POST | `/api/v1/passkeys/register/options` | credential | → `{publicKey}` creation options |
| POST | `/api/v1/passkeys/register` | credential | `{name, credential}` → 201 `{passkey}` |
| GET | `/api/v1/passkeys` | yes | `{passkeys:[{id,name,createdAt,lastUsedAt,suspiciousAt,backedUp}]}` |
| PATCH | `/api/v1/passkeys/{id}` | credential | `{name}` → `{passkey}` |
| DELETE | `/api/v1/passkeys/{id}` | credential | 204 |
| GET | `/api/v1/mfa` | yes | `{mfa}`, see [Two-factor authentication](#two-factor-authentication) |
| POST | `/api/v1/mfa/totp/enroll` | credential | → `{secret, uri, expiresAt}` (pending for 10 minutes; the only time the secret is returned) |
| POST | `/api/v1/mfa/totp/confirm` | credential | `{code}` → `{recoveryCodes:[10], mfa}` (codes shown once) |
| DELETE | `/api/v1/mfa/totp` | credential, fresh | turn the second factor off → 204 |
| POST | `/api/v1/mfa/recovery-codes/regenerate` | credential, fresh | → `{recoveryCodes:[10]}`; every earlier code stops working |
| GET | `/api/v1/mfa/trusted-devices` | yes | `{devices:[{id,userAgent,createdAt,expiresAt,lastUsedAt}]}` |
| DELETE | `/api/v1/mfa/trusted-devices` | yes | forget every remembered browser → 204 |
| DELETE | `/api/v1/mfa/trusted-devices/{id}` | yes | forget one → 204 |
| GET | `/api/v1/encryption/keys` | yes | `{keys}`: the wrapped key record, or 404 `encryption_disabled`; see [End-to-end encryption](#end-to-end-encryption) |
| PUT | `/api/v1/encryption/keys` | credential (fresh when replacing) | create (`version: 1`) or replace (`version` = stored + 1) the key record → 201/200 `{keys}`; 409 `encryption_conflict` |
| DELETE | `/api/v1/encryption/keys` | credential, fresh | 204; turns encryption off for the account (404 `encryption_disabled` without a record) |
| POST | `/api/v1/encryption/purge-history` | yes | → `{purged, notice}`; deletes superseded content operations; 409 `encryption_disabled` |
| GET | `/api/v1/notifications` | yes | your in-app notifications and the unread count, see [Assignment and notifications](#assignment-and-notifications) |
| POST | `/api/v1/notifications/{id}/read` | yes | mark one read → 204 |
| GET | `/api/v1/push/vapid-key` | yes | `{publicKey}`; with `?device={id}` also `subscription` (that device's status or `null`), see [Reminders and push](#reminders-and-push) |
| POST | `/api/v1/push/subscriptions` | yes | `{deviceId, endpoint, keys:{p256dh, auth}, includeContent?}` → 201 `{subscription}` (200 when the device's subscription was replaced) |
| DELETE | `/api/v1/push/subscriptions/{id}` | yes | 204, or 404 `not_found` |
| POST | `/api/v1/push/test` | yes | `{deviceId}` → 200 `{outcome, testId?, subscription, status?, error?}`: sends one real test push to that device; 5 per account per 10 minutes, see [Reminders and push](#reminders-and-push) |

#### Tasks, projects and other synced data

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/tasks` | yes | `{tasks:[…]}` (yours and those of projects shared with you); `?include_deleted=true` to include tombstones; `?completed_after=…&completed_before=…` for [tasks completed in a range](#tasks-completed-in-a-range) |
| POST | `/api/v1/tasks` | yes | create → 201 task, see [Task fields](#task-fields); optional `Idempotency-Key` header, see [Idempotency keys](#idempotency-keys) (every collection below accepts it on create) |
| POST | `/api/v1/quick-add/parse` | yes, every scope | read a quick-add line with the account's languages, projects and labels; writes nothing, so a `read` token may call it; see [Quick-add parse](#quick-add-parse) |
| GET | `/api/v1/tasks/{id}` | yes | task or 404 |
| PATCH | `/api/v1/tasks/{id}` | yes | partial update → task |
| DELETE | `/api/v1/tasks/{id}` | yes | soft delete (to the Trash) → 204 |
| GET/POST/GET/PATCH/DELETE | `/api/v1/projects…` | yes | same shape for projects, see [Project fields](#project-fields) |
| GET/POST/GET/PATCH/DELETE | `/api/v1/sections…` | yes | same shape for sections, see [Sections](#sections) |
| GET/POST/GET/PATCH/DELETE | `/api/v1/fields…` | yes | same shape for custom field definitions, see [Custom fields](#custom-fields) |
| GET/POST/GET/PATCH/DELETE | `/api/v1/labels…` | yes | same shape for labels, see [Label fields](#label-fields) |
| GET/POST/GET/PATCH/DELETE | `/api/v1/views…` | yes | same shape for saved views, see [View fields](#view-fields) |
| GET/POST/GET/PATCH/DELETE | `/api/v1/reminders…` | yes | same shape for reminders, see [Reminders and push](#reminders-and-push) |
| GET | `/api/v1/tasks/{id}/history`, `/api/v1/projects/{id}/history` | yes | change sets from the operation log, oldest first; `?before=<ts>&limit=<1-200>` pages backwards; see [Trash and history](#trash-and-history) |
| DELETE | `/api/v1/tasks/{id}/purge`, `/api/v1/projects/{id}/purge` | yes | permanently delete an item that is in the Trash → `{purged:{tasks,projects,reminders,sections,comments}}`; 409 `not_deleted` otherwise |
| POST | `/api/v1/trash/purge` | yes | empty the Trash (every deleted task and project you may delete) → `{purged:{…}}` |
| GET | `/api/v1/tasks/{id}/comments` | yes | `{comments}`: the task's live comments in thread order; see [Comments and activity](#comments-and-activity) |
| POST | `/api/v1/tasks/{id}/comments` | yes | `{body, parent_id?, mentions?}` → 201 comment; 429 `rate_limited` past 60 new comments a minute |
| PATCH | `/api/v1/comments/{id}` | yes | `{body?, mentions?}` → 200 comment with `edited_at` set; 403 `forbidden` unless you wrote it |
| DELETE | `/api/v1/comments/{id}` | yes | 204; allowed for the author, project admins and the owner |
| PUT | `/api/v1/comments/{id}/reactions` | yes | `{reactions: [names]}` replaces your own reactions → 200 comment; 400 `invalid_input` naming an unknown name or a duplicate; 404 for an unreadable or deleted comment; `read` and `agent` tokens get 403 `insufficient_scope` |
| GET | `/api/v1/tasks/{id}/activity`, `/api/v1/projects/{id}/activity` | yes | `{events, more, cursor?}` newest first, derived from the operation log; `?before=<cursor>&limit=<1-200>` (default 50) |
| GET | `/api/v1/activity` | yes | the activity feed across every shared project you are a member of; `?cursor=&limit=&project=&actor=&kind=`; see [Activity feed](#activity-feed) |
| GET | `/api/v1/projects/{id}/members` | member | `{projectId, role, ownerId, members:[{userId,name,email,role}]}`, see [Sharing](#sharing) |
| POST | `/api/v1/projects/{id}/members` | owner, admin of the project | `{email, role}` → 201 membership (shares the project on first use) |
| PATCH | `/api/v1/projects/{id}/members/{userId}` | owner, admin of the project | `{role}` → membership |
| DELETE | `/api/v1/projects/{id}/members/{userId}` | member | remove a member, or leave with your own id or `me` → 204 |
| POST | `/api/v1/projects/{id}/transfer` | owner of the project | `{userId}` → membership; the previous owner becomes an admin |
| GET | `/api/v1/projects/{id}/invites` | owner, admin of the project | pending invite links `{invites:[…]}`, see [Project invite links](#project-invite-links) |
| POST | `/api/v1/projects/{id}/invites` | owner, admin of the project, fresh | `{role, email?, expiresInHours?, send?}` → 201 `{invite, link, newAccounts, sent?}` (link shown once; `send` mails it to `email`) |
| DELETE | `/api/v1/projects/{id}/invites/{inviteId}` | owner, admin of the project | revoke a pending link → 204 |
| POST | `/api/v1/project-invites/{token}/accept` | yes | join the project as the signed-in account → `{projectId, role}` |
| GET | `/api/v1/projects/{id}/public-links` | owner, admin of the project | active public links `{links:[…]}`, see [Public links](#public-links) |
| POST | `/api/v1/projects/{id}/public-links` | owner, admin of the project, fresh | `{rights, name?, expiresInDays?}` → 201 the link with `link` (shown once) |
| DELETE | `/api/v1/projects/{id}/public-links/{linkId}` | owner, admin of the project | revoke → 204 |
| GET | `/api/v1/public/{token}` | none | a public list `{projectName, projectColor, rights, sections, tasks, serverTime}` |
| POST | `/api/v1/public/{token}/tick` | none (a `tick` link) | `{taskId, completed}` → `{taskId, completed_at}` |
| POST | `/api/v1/tasks/{id}/page` | the task's owner, owner or admin of its project; fresh; full token | `{rights, label?, expiresInDays?, includeMap?, snapshot?, wrappedKey?}` → 201 the page with `link` (shown once), see [Task pages](#task-pages) |
| GET | `/api/v1/tasks/{id}/page` | the same | the active page's status (never the secret or a key) |
| DELETE | `/api/v1/tasks/{id}/page` | the same | revoke → 204 |
| GET | `/api/v1/task-pages` | signed in, full token | the caller's own active pages, with the wrapped share key of encrypted ones |
| PUT | `/api/v1/tasks/{id}/page/snapshot` | the publisher, full token | `{ciphertext, version, wrappedKey?}` → 200; an older `version` changes nothing |
| GET | `/api/v1/tasks/{id}/page/replies` | the publisher, full token | pending encrypted replies `{replies:[{id, ciphertext, createdAt}]}` |
| DELETE | `/api/v1/tasks/{id}/page/replies/{replyId}` | the publisher, full token | confirm an imported reply → 204 |
| GET | `/api/v1/pages/{secret}` | none | the page: `mode` `live` (the task's shown fields) or `encrypted` (`snapshot`) |
| POST | `/api/v1/pages/{secret}/replies` | none (`reply` or `tick` page) | `{name, body}`, or `{ciphertext}` on an encrypted page → 201 |
| POST | `/api/v1/pages/{secret}/tick` | none (a `tick` page) | `{taskId, completed, name}` → `{taskId, completed_at}` |
| GET | `/api/v1/pages/{secret}/files/{fileId}`, `…/maps/…` | none | a file of the task, as a download; the page's map style, tiles, fonts and sprites |
| GET | `/api/v1/settings/project-invites` | yes | `{membersCanInviteNewPeople}` (the owner switch) |
| PUT | `/api/v1/settings/project-invites` | owner | `{membersCanInviteNewPeople: true\|false}` → the same shape |
| POST | `/api/v1/sync` | yes (not `read`) | device sync, see [sync.md](sync.md#exchange); the response carries the log `generation` |
| GET | `/api/v1/sync/events?device={id}` | yes | server-sent event stream; wakes the device when other devices or the API record operations, see [sync.md](sync.md#live-updates) |
| GET | `/api/v1/time-entries` | yes | time entries you can read, newest first; `task`, `from`, `to`, `tz`, `running`, `limit`, `cursor`, `format=csv`, see [Time entries](#time-entries) |
| GET | `/api/v1/tasks/{id}/time-entries` | yes | one task's live time entries, newest first |
| POST | `/api/v1/time-entries` | yes (not `read`, not `agent`) | `{taskId}` starts an entry (the running one ends at its start), or `{taskId, startedAt, endedAt, note?}` logs a closed one → 201 |
| POST | `/api/v1/time-entries/stop` | yes (not `read`, not `agent`) | stop your running entry → the entry; 404 when none runs |
| PATCH | `/api/v1/time-entries/{id}` | yes (not `read`, not `agent`), author only | `{startedAt?, endedAt?, note?}` → the entry |
| DELETE | `/api/v1/time-entries/{id}` | yes (not `read`, not `agent`) | tombstone an entry (author, project admin or owner) → 204 |
| GET | `/api/v1/export` | yes | full JSON export (`projects`, `tasks`, `labels`, `views`, `reminders`, `sections`, `comments`, `time_entries`, `workspaces` (each with your role; for those you own, the members' ids and roles and the groups), `encryption`, and `userId`, the exporting account), every task with its `origin` (`null` when unset), including deleted items and the projects shared with you (with `role` and `owner_id`); never contains audit events or push subscriptions; reminders are personal, so only your own |
| POST | `/api/v1/import/preview` | yes | multipart `file` + options → dry run `{format, totals, rows, …}`, see [Import](#import) |
| POST | `/api/v1/import` | yes | multipart `file` + options → 202 `{job}`; the import runs in the background |
| GET | `/api/v1/import/jobs` | yes | `{jobs:[…]}`, newest first (last 50) |
| GET | `/api/v1/import/jobs/{id}` | yes | `{job}` with status, counts and row errors |
| POST | `/api/v1/import/jobs/{id}/undo` | yes | tombstone everything the job created → `{job}` (status `undone`); idempotent |

#### Integrations

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/webhooks` | yes | `{webhooks:[…], events:[…]}`, see [Webhooks](#webhooks) |
| POST | `/api/v1/webhooks` | yes | `{url, events, projectId?, enabled?}` → 201 `{webhook}` (includes `secret`, shown once) |
| GET | `/api/v1/webhooks/{id}` | yes | `{webhook}` (never the secret) |
| PATCH | `/api/v1/webhooks/{id}` | yes | partial `{url?, events?, projectId?, enabled?}` → `{webhook}` |
| DELETE | `/api/v1/webhooks/{id}` | yes | delete with its delivery log → 204 |
| POST | `/api/v1/webhooks/{id}/test` | yes | send a `ping` now → `{ok, delivery}` |
| GET | `/api/v1/webhooks/{id}/deliveries` | yes | `{deliveries:[…]}`, newest 100 |
| POST | `/api/v1/webhooks/{id}/deliveries/{did}/redeliver` | yes | queue the same body with a new id → 202 `{delivery}` |
| GET | `/api/v1/app-passwords` | yes | `{appPasswords:[…]}`, see [CalDAV and app passwords](#caldav-and-app-passwords) |
| POST | `/api/v1/app-passwords` | credential, fresh | `{name}` → 201 `{appPassword, secret}` (secret shown once) |
| DELETE | `/api/v1/app-passwords/{id}` | yes | revoke → 204 |
| GET | `/api/v1/email-inbox` | yes | your email-to-task address and settings, see [Email to task](#email-to-task) |
| PATCH | `/api/v1/email-inbox` | yes | `{enabled?, allowlist?}` → the same shape |
| POST | `/api/v1/email-inbox/rotate` | yes | new address; the old one stops working |
| * | `/dav/`, `/.well-known/caldav` | HTTP Basic with an app password | CalDAV (WebDAV methods), 404 while disabled; see [caldav.md](caldav.md) |
| POST | `/mcp` | bearer token only | Model Context Protocol endpoint, 404 while disabled; write tools only for `agent` tokens with both switches on; see [mcp.md](mcp.md) |

#### Administration (owner and admins)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/invitations` | owner, admin | `{invitations:[…]}`, see [Invitations](#invitations) |
| POST | `/api/v1/invitations` | owner, admin, credential, fresh | `{email?, expiresInHours?, send?}` → 201 `{invitation, link, sent?}` (link shown once; `send` mails it to `email`) |
| DELETE | `/api/v1/invitations/{id}` | owner, admin, credential | revoke a pending invitation → 204 |
| GET | `/api/v1/users` | owner, admin | `{users:[…]}`, see [User administration](#user-administration) |
| PUT | `/api/v1/users/{id}/role` | owner, credential, fresh | `{role: "admin"\|"member"}` → `{user}` |
| POST | `/api/v1/users/{id}/deactivate` | owner, admin, credential, fresh | → `{user}`; revokes sessions, tokens, pending invitations and reset links |
| POST | `/api/v1/users/{id}/reactivate` | owner, admin, credential, fresh | → `{user}` |
| DELETE | `/api/v1/users/{id}` | owner, admin, credential, fresh | `{confirmEmail}` → 204; deletes the account and its data |
| POST | `/api/v1/users/{id}/password-reset` | owner, admin, credential, fresh | `{expiresInHours?, send?}` → 201 `{expiresAt, link}` (link shown once), or with `send: true` 201 `{expiresAt, sent: true}` and the link mailed to the account |
| GET | `/api/v1/settings/smtp` | owner, credential | the [outgoing email](#outgoing-email) configuration without the password |
| PUT | `/api/v1/settings/smtp` | owner, credential, fresh | `{host?, port?, security?, username?, password?, from?}` → the same shape |
| POST | `/api/v1/settings/smtp/test` | owner | sends a test message to the owner → `{outcome: "sent"\|"failed", stage?, reply?}` |
| POST | `/api/v1/users/{id}/transfer-ownership` | owner, credential, fresh | `{password}` → `{user}` |
| POST | `/api/v1/members/{id}/mfa/reset` | owner, credential, fresh | remove a member's second factor, recovery codes and remembered browsers → 204 |
| GET | `/api/v1/settings/mfa` | owner | `{required: "none"\|"owner"\|"all"}` |
| PUT | `/api/v1/settings/mfa` | owner, credential, fresh | `{required}` → `{required}` |
| GET | `/api/v1/settings/oidc` | owner | provider configuration, secret masked, see [Single sign-on](#single-sign-on) |
| PUT | `/api/v1/settings/oidc` | owner, credential, fresh | change the provider configuration |
| POST | `/api/v1/settings/oidc/test` | owner | `{issuer?}` → `{ok, issuer, authorizationHost, tokenHost, endSessionSupported}` |
| GET | `/api/v1/settings/mcp` | yes | `{enabled, writes_enabled, endpoint}`: whether the [MCP endpoint](mcp.md) is on, whether assistants may make changes, and its URL |
| PUT | `/api/v1/settings/mcp` | owner | `{enabled?, writes_enabled?}` (at least one) → `{enabled, writes_enabled, endpoint}`; each change is recorded as `settings.changed` (`mcp.enabled`, `mcp.writes`) |
| GET | `/api/v1/settings/caldav` | yes | `{enabled, url, secure, encryption}` |
| PUT | `/api/v1/settings/caldav` | owner | `{enabled}` → the same shape |
| GET | `/api/v1/settings/webhooks` | owner | `{allowPrivate}` |
| PUT | `/api/v1/settings/webhooks` | owner | `{allowPrivate}` → `{allowPrivate}` |
| GET | `/api/v1/audit` | owner | `{events:[…], cursor}` newest first; filters `name`, `actor`, `target`, `outcome`, `from`, `to`, `cursor`, `limit≤200`, see [Audit log](#audit-log) |
| GET | `/api/v1/audit/export` | owner | the filtered log as `application/x-ndjson` download; records `audit.exported` |
| GET | `/api/v1/settings/audit` | owner | `{retentionDays, logIp}` |
| PUT | `/api/v1/settings/audit` | owner | `{retentionDays?: 7–3650, logIp?}` → settings; disabling `logIp` erases stored addresses |
| GET | `/api/v1/backups` | owner | backup status, see [Backups](#backups) |
| GET | `/api/v1/backups/settings` | owner | `{settings, secrets}` (secret presence flags only) |
| PUT | `/api/v1/backups/settings` | owner, credential | `{settings, secrets?}` → `{settings, secrets}` |
| POST | `/api/v1/backups/run` | owner | start a backup now → 202, or 409 `conflict` while one runs |
| POST | `/api/v1/backups/test` | owner | write and delete a probe object at the saved destination → 200 `{ok:true}` or 502 `destination_error` |
| GET | `/api/v1/backups/archives` | owner | archives in the destination, newest first, see [Restore](#restore-from-the-web-app) |
| GET | `/api/v1/backups/restore` | owner | staged restore, last restore outcome, safety copies, free space |
| POST | `/api/v1/backups/restore/uploads` | owner | raw archive body → 201 staged upload |
| POST | `/api/v1/backups/restore/prepare` | owner | `{source, passphrase?}` → verified preview |
| POST | `/api/v1/backups/restore` | owner, fresh session | `{id, confirm:"RESTORE"}` → 202, then the server restarts |
| DELETE | `/api/v1/backups/restore/{id}` | owner | cancel a staged restore → 204 |
| DELETE | `/api/v1/backups/restore/safety-copies/{name}` | owner, fresh session | delete a safety copy → 204 |

### Passkeys

Passkeys (WebAuthn) are an additional way to sign in; the password keeps working. They are only offered when `OPENTODO_BASE_URL` is `https://…` (or `http://localhost` / `127.0.0.1` for development). The relying-party id is the host of that URL and the expected origin is its `scheme://host[:port]`. `auth/status` reports `passkeysAvailable`. When it is `false`, every passkey route answers `409 passkeys_unavailable`.

Both ceremonies take two steps. The `options` route returns `{"publicKey": …}`, the JSON form of `PublicKeyCredentialCreationOptions` / `PublicKeyCredentialRequestOptions`, with a single-use challenge valid for five minutes. The browser runs `navigator.credentials.create()` or `get()` with those options, and the client posts the result back. **All binary fields are base64url strings** (padding optional), in the same shape that `PublicKeyCredential.toJSON()` produces:

```json
{
  "name": "Work laptop",
  "credential": {
    "id": "q2Xx…", "rawId": "q2Xx…", "type": "public-key",
    "response": {
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIi…",
      "attestationObject": "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVj…",
      "transports": ["internal", "hybrid"]
    }
  }
}
```

For sign-in, `response` carries `clientDataJSON`, `authenticatorData` and `signature`, and the body has no `name`. Sign-in uses discoverable credentials only (`allowCredentials` is empty), so the server finds the account from `rawId`. Registration asks for `residentKey: "required"`, `userVerification: "preferred"` and `attestation: "none"`. ES256, EdDSA (Ed25519) and RS256 keys are accepted.

| Code | Status | When |
| --- | --- | --- |
| `passkeys_unavailable` | 409 | the base URL is unset or not https/localhost |
| `passkey_challenge_invalid` | 400 | the challenge is expired, already used, issued to another account, or was a sign-in challenge used for registration (or the reverse) |
| `invalid_input` | 400 | origin, relying-party id, type or signature format does not match; credential already registered; empty name on rename |
| `bad_request` | 400 | a field is missing or is not base64url |
| `invalid_credentials` | 401 | sign-in with an unknown or deleted passkey, a bad signature, or a signature counter that went backwards (the passkey is then marked `suspiciousAt`) |
| `not_found` | 404 | rename or delete of a passkey id that is not yours |
| `rate_limited` | 429 | per address, 10 a minute in separate windows: failed `auth/login` passwords (successful sign-ins do not count), `auth/register` and sign-up links, password-reset routes, the invitation and project invite link preview and accept routes, `auth/passkey`, and `auth/passkey/options` (so the sign-in screen's autofill request never uses up password attempts). IPv6 addresses count per `/64` |
| `account_locked` | 429 | 10 failed passwords, two-factor codes or re-authentications for this account within 15 minutes, from any addresses; `Retry-After` gives the seconds until the window ends. Also answered by `auth/mfa` and `auth/reauth`. A successful sign-in clears the count |

The anonymous `auth/passkey` routes apply the same `Origin` check as `auth/login`. A successful passkey sign-in sets the same `opentodo_session` cookie as a password sign-in. Bearer tokens can list, rename and delete passkeys, but a CLI cannot run a ceremony.

### Two-factor authentication

Accounts can add a time-based one-time password (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30-second steps) from any authenticator app. The server generates and checks the codes with its own clock and contacts nothing, so keep the host's clock synchronised (NTP). A code is accepted one step (30 s) either side of the server's time. Each code completes at most one authentication.

**Profile.** `GET /api/v1/me`, `GET /api/v1/mfa` and `auth/status` (when signed in) carry:

```json
{ "mfa": { "enrolled": true, "recoveryCodesRemaining": 9, "policy": "owner", "required": true, "restricted": false } }
```

`required` means the owner's policy covers this account. `restricted` means the session may only enrol, because the account is required to have a second factor and has none yet. Bearer-token requests are never restricted.

**Enrolment.** `POST /mfa/totp/enroll` returns a fresh `secret` (base32) and its provisioning `uri` (`otpauth://totp/OpenTodo:<email>?secret=…&issuer=OpenTodo&algorithm=SHA1&digits=6&period=30`). The web app renders the QR code locally. Confirm within ten minutes with `POST /mfa/totp/confirm {"code":"123456"}`. The answer contains ten recovery codes such as `ABCDE-FGH23`, shown only this once and stored as SHA-256 hashes. A recovery code can stand in for an app code at sign-in (dash and case optional) and is used up by that sign-in.

**Two-step sign-in.** For an enrolled account, a correct password answers 200 with no cookie:

```bash
curl -sS -c jar -X POST "$OT/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…"}'
# {"challenge":"Zk3…","expiresAt":1760000300000,"mfaRequired":true}
curl -sS -c jar -X POST "$OT/api/v1/auth/mfa" -H 'Content-Type: application/json' \
  -d '{"challenge":"Zk3…","code":"492039","remember":true}'
# {"user":{…}} + opentodo_session cookie (+ ot_trust cookie)
```

A challenge lasts five minutes and allows five wrong codes. Each wrong code gets `401 mfa_code_invalid`; after the fifth, the challenge is gone and the next attempt gets `401 mfa_challenge_invalid`, which means "enter the password again". `remember: true` sets `ot_trust`, an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on https) limited to `/api/v1/auth` and valid for a fixed 30 days. While that cookie is present, the password step starts the session directly for that account on that browser. A passkey sign-in whose authenticator reports user verification (biometric or PIN) counts as two factors and is never asked for a code. A passkey without user verification answers with the same challenge as a password.

**Step-up.** For cookie sessions, the routes marked *fresh* in the table require a proof of identity within the last ten minutes. A sign-in counts, and so does `POST /auth/reauth` with `{"password":"…"}` or `{"code":"123456"}`. Otherwise they answer `403 reauth_required` and change nothing. The web app then shows a re-authentication dialog and repeats the request once. Bearer-token requests are never challenged, but on *credential* routes only an `admin` token is accepted (see [token scopes](#token-scopes)).

**Owner policy.** `PUT /settings/mfa {"required":"none"|"owner"|"all"}`. When the policy covers an account that has no second factor, sign-in still works. Every route except `GET /me`, `/mfa/*`, `/auth/reauth` and `/auth/logout` then answers `403 mfa_enrolment_required` until the account enrols. That includes `/sync`, so a device keeps its changes queued and uploads them after enrolment. An account the policy covers cannot turn its second factor off (`403 mfa_required_by_policy`).

**Recovery.** The owner resets a member's second factor with `POST /members/{id}/mfa/reset`. If the owner loses both their authenticator and their recovery codes, stop the server and run `opentodo mfa-reset [--data-dir DIR] <email>` on the host (see [SECURITY.md](../SECURITY.md)). Both are recorded as `mfa.reset`.

| Code | Status | When |
| --- | --- | --- |
| `mfa_code_invalid` | 400 | confirming enrolment with a wrong code or after the ten-minute window |
| `mfa_code_invalid` | 401 | wrong, reused or replayed code or recovery code at `auth/mfa` or `auth/reauth` |
| `mfa_challenge_invalid` | 401 | unknown, expired or exhausted sign-in challenge |
| `mfa_already_enrolled` | 409 | enrol or confirm when a second factor is already active |
| `mfa_not_enrolled` | 409 | disable or regenerate without a second factor |
| `mfa_required_by_policy` | 403 | disabling while the owner's policy covers the account |
| `mfa_enrolment_required` | 403 | any other route while the session is restricted |
| `reauth_required` | 403 | a *fresh* route on a cookie session older than ten minutes since its last proof |
| `invalid_credentials` | 401 | wrong password at `auth/reauth` |
| `invalid_input` | 400 | missing challenge or code, empty re-authentication body, unknown policy value, `auth/reauth` with a bearer token |
| `forbidden` | 403 | `settings/mfa` or a member reset by a non-owner |
| `not_found` | 404 | unknown member id or trusted device |
| `rate_limited` | 429 | more than 10 requests per minute per address to `auth/mfa`, or to `auth/reauth` (separate windows) |

Wrong codes are recorded as `mfa.challenge_failed` with a reason (`wrong_code`, `wrong_recovery_code`) and never the code. Enrolment, disabling and resets are recorded as `mfa.enrolled`, `mfa.disabled` and `mfa.reset`, and policy changes as `settings.changed` (`setting: mfa.required`). A completed sign-in is `login.succeeded` with method `password+totp`, `password+recovery_code`, `password+trusted_device` or `passkey+totp`.

### Single sign-on

The owner can connect one OpenID Connect provider (Authentik, Keycloak, Authelia, Zitadel, a hosted login service). It is off until configured; setup steps are in [self-hosting/sso.md](self-hosting/sso.md). When, and only when, a provider is configured, the server contacts that issuer's discovery document and the token and key endpoints it names (10-second timeout, no redirects followed).

**Status.** `auth/status` always carries `{"oidc":{"enabled":true,"displayName":"Home SSO","ssoOnly":false}}` (`enabled:false` when no provider is configured).

**Sign-in** is a browser navigation, not an API call: `GET /api/v1/auth/oidc/start` redirects to the provider with the authorization-code flow, PKCE (S256), a single-use `state` and a `nonce`, and sets a 10-minute `HttpOnly`, `SameSite=Lax` cookie `ot_oidc` (path `/api/v1/auth/oidc`) holding the signed flow state. The provider returns to `GET /api/v1/auth/oidc/callback`, which exchanges the code, verifies the identity token (RS256, PS256, ES256 or EdDSA signature from the provider's JWKS; issuer, audience, expiry, issued-at and nonce, with 60 seconds of clock leeway) and answers `303` to `/` with the usual `opentodo_session` cookie. The session counts as having passed the second factor: the provider applies its own policy, so an account with TOTP is not asked for a code. The owner's two-factor enrolment policy still applies to the session like any other.

The identity is matched by issuer and subject first; a first-time identity whose **verified** email equals an account's email is linked to that account, except when that account is the owner or an admin or has a second factor or a passkey: such an account links only from Settings while signed in (below), and the sign-in is refused with `oidc_link_required`; otherwise a `member` account is created only if open sign-up is on or the owner enabled `allowProvision`. Failures redirect to the sign-in screen with `?error=`:

| `error` | When |
| --- | --- |
| `oidc_failed` | the provider refused, the code exchange failed or the identity token failed a check (details only in the server log) |
| `oidc_email_unverified` | a first-time identity without an email marked verified |
| `oidc_link_required` | a first-time identity whose email belongs to the owner, an admin or an account with a second factor or passkey: sign in locally and link it from Settings → Account first |
| `signup_closed` | no matching account and provisioning is not allowed |

`start` while signed in **links** the provider identity to the current account instead (Settings → Account → Linked accounts) and returns to `/settings/account?linked=1`. If that identity is already linked to the same account, the flow is a fresh proof of identity for the session (the *fresh* routes work for ten minutes) and returns to `/settings/account?reauthenticated=1`.

The callback answers `400 oidc_state_invalid` (missing, forged, expired or already used state) and `409 identity_taken` (linking an identity that belongs to another account) as JSON; a browser navigation (`Accept: text/html`) is redirected to `/?error=<code>` or `/settings/account?error=<code>` instead, so people never see raw JSON.

**Owner settings.** `GET /api/v1/settings/oidc`:

```json
{
  "enabled": true, "issuer": "https://sso.example.com/application/o/opentodo", "clientId": "opentodo",
  "clientSecret": "••••a1b2", "clientSecretSet": true, "displayName": "Home SSO", "scopes": "openid email profile",
  "allowProvision": false, "ssoOnly": false, "providerLogout": false, "syncPictures": false,
  "redirectUri": "https://todo.example.com/api/v1/auth/oidc/callback", "baseUrlConfigured": true,
  "managedBy": { "issuer": "settings", "clientId": "settings", "clientSecret": "env", "displayName": "settings",
                 "scopes": "settings", "allowProvision": "settings", "ssoOnly": "settings", "providerLogout": "settings" }
}
```

`PUT` takes any subset of `issuer`, `clientId`, `clientSecret`, `displayName`, `scopes`, `allowProvision`, `ssoOnly`, `providerLogout`, `syncPictures` and returns the same shape. With `syncPictures: true` (off by default) a provider sign-in or link whose identity token carries a `picture` claim makes the server fetch that address through the outbound policy (5 seconds, 2 MB, PNG/JPEG/GIF) and store it as the account's [profile picture](#profile), 256×256 JPEG; an uploaded picture is never replaced, a synced or removed address is not fetched again, and a failed fetch changes nothing. A new issuer must be an https URL whose discovery document is reachable and names the same issuer, or the answer is `400 invalid_input` and the previous configuration stays. `clientSecret` is write-only: omit it (or send the masked value back) to keep it, send `""` to remove it. A field set by an `OPENTODO_OIDC_*` variable is reported as `managedBy: "env"` and cannot be changed (`400 invalid_input`). An empty `issuer` turns single sign-on off (links are kept). `PUT` needs a fresh session. `POST /api/v1/settings/oidc/test` with optional `{"issuer":"…"}` runs discovery and answers `{ok, issuer, authorizationHost, tokenHost, endSessionSupported}` or `400 invalid_input`. Changes are recorded as `settings.changed` (the secret as `(changed)`).

**SSO-only mode** (`ssoOnly: true`, effective only while a provider is configured): password and passkey sign-in, and registration through the password form, answer `403 sso_required` for every account except the owner (recorded as `login.failed` with reason `sso_required`). The owner keeps local sign-in as break-glass (the sign-in screen shows the password form at `/?owner=1`). Bearer tokens keep working.

**Linked identities.** `GET /api/v1/me/identities` → `{identities:[{id, issuer, email, createdAt, lastLoginAt}], provider:{enabled, displayName, ssoOnly}}`. `DELETE /api/v1/me/identities/{id}` → 204, or `409 last_credential` when the account would have no way left to sign in under the current mode (another identity counts while a provider is configured; a password or passkey counts unless SSO-only mode refuses it for this account). Linking and unlinking are recorded as `identity.linked` / `identity.unlinked`; a provider sign-in as `login.succeeded` with method `oidc`.

**Sign-out.** `POST /auth/logout` always deletes the local session. When `providerLogout` is on and the session started through the provider, it answers `200 {"redirect":"https://sso…/end-session?client_id=…&id_token_hint=…&post_logout_redirect_uri=https://todo.example.com/"}` instead of 204, and the web app follows it after clearing local data.

| Code | Status | When |
| --- | --- | --- |
| `oidc_disabled` | 404 | `auth/oidc/start` or `callback` while no provider is configured |
| `oidc_state_invalid` | 400 | callback with a missing, forged, expired or reused state |
| `identity_taken` | 409 | linking an identity that is linked to another account |
| `last_credential` | 409 | unlinking the account's last way to sign in |
| `sso_required` | 403 | password or passkey sign-in, or password registration, by a non-owner in SSO-only mode |
| `invalid_input` | 400 | issuer not https, discovery failed or names another issuer, client id missing, scopes without `openid`, changing an environment-managed field |
| `forbidden` | 403 | `settings/oidc` by a non-owner |
| `rate_limited` | 429 | more than 20 requests per minute per address to `auth/oidc/start` and `callback` together |

### Outgoing email

Optional SMTP, configured by the owner in **Settings → Server → Outgoing email** or with the `OPENTODO_SMTP_*` variables ([self-hosting/outgoing-email.md](self-hosting/outgoing-email.md)). Without it nothing is ever sent, `outgoingEmail.enabled` is false in the status, the routes that only send answer 404 `smtp_disabled` and `send` flags 409 `smtp_disabled`. Links in reset, sign-up and invitation emails are built from `OPENTODO_BASE_URL` only: without it those flows answer 409 `base_url_required` (open sign-up included) and send nothing, and the owner's `config_warnings` names `OPENTODO_BASE_URL`.

**Configuration** — `GET /api/v1/settings/smtp` (the owner's session or an `admin` token; other tokens get 403) →

```json
{"configured": true, "host": "smtp.example.com", "port": 587, "security": "starttls", "username": "todo",
 "passwordSet": true, "from": "OpenTodo <todo@example.com>", "managedBy": {"host": "settings", "from": "env", "…": "…"},
 "lastTest": {"at": 1760000000000, "outcome": "failed", "stage": "auth", "reply": "535 5.7.8 …"}}
```

`PUT` takes any of `host`, `port`, `security` (`tls`, `starttls`, `none`), `username`, `password` (`""` removes it) and `from` and answers the same shape. Errors: 400 `invalid_input` naming the field (port outside 1–65535, unknown security, a From that is not one address, a username without a password, `none` with a username), 409 `managed_by_env` for a field set by a variable. The password is never returned and is kept in `<data>/secrets/smtp.json`, outside backups.

**Test** — `POST /api/v1/settings/smtp/test` sends one message to the owner's address and answers 200 `{outcome: "sent", to}` or `{outcome: "failed", stage, reply}` with `stage` one of `connect`, `tls`, `auth`, `send`. 5 per 10 minutes (429 `rate_limited`).

**Messages** — plain text in the language of the request's `Accept-Language` (`en`, `de`, `fr`, `es`, `it`, `pt`, else English), one link each, never task content. At most 5 per kind and address per hour and 100 per hour in total; an authenticated request over a limit gets 429 `rate_limited`, a failed send 502 `email_failed` with nothing left pending. Sends are synchronous (15 seconds at most) and never retried.

**Forgot password** — `POST /api/v1/auth/password-reset` with `{"email": "…"}` always answers 202 after at least 200 ms; for an active account outside SSO-only mode it issues a 24-hour reset link (revoking earlier ones) and mails it. Use the link with the [reset routes](#user-administration).

**Verified sign-up** — with open sign-up and outgoing email, `POST /api/v1/auth/register` without an invitation answers 202 `{verificationRequired: true}` and mails a 24-hour link to `/verify/<token>`; an address that already has an account gets a message saying so, with the same answer. `GET /api/v1/auth/verify/{token}` previews `{email, expiresAt}`; `POST` creates the member account and starts a session (201 `{user}`). Unknown, expired, replaced and used tokens answer the same 404 `verification_invalid`.

### Weekly digest

An opt-in email per user on a chosen weekday and hour (OpenSpec `email-digest`): last week's completed, created, completed late and slipped counts, up to 15 overdue tasks, up to 15 tasks due in the next seven days, up to 10 projects without a next action ([Places](method/places.md#projects-without-a-next-action)), the last review and a link to `/review`. The numbers follow the same definitions as the device's Statistics ([statistics.md](statistics.md#statistics)).

`GET /api/v1/me/email-digest` →

```json
{"available": true, "encryption": false, "enabled": true, "weekday": 5, "hour": 7, "timeZone": "Europe/Zurich",
 "language": "de", "nextSendAt": 1761195600000, "lastOutcome": "sent", "lastSentFor": "2026-10-16", "lastAttemptAt": 1760590800000}
```

`weekday` is 0 (Sunday) to 6, `hour` 0–23 in `timeZone` (an IANA zone), `language` one of `en`, `de`, `fr`, `es`, `it`, `pt`. `available` is false without outgoing email (and on a demo); `encryption` is true for an account with end-to-end encryption. `lastOutcome` is `sent`, `skipped` (the relay failed for the whole six-hour retry window), `encrypted_account`, `rate_limited` or the failed stage. `PUT` takes any of the five editable fields; errors: 404 `smtp_disabled` without outgoing email, 409 `encryption_enabled` for an encrypted account (nothing is stored), 400 `invalid_input` naming the field. Turning on encryption (`PUT /api/v1/encryption/keys` creating the record) turns the digest off and answers `digestDisabled: true`. Sends are recorded as `email.sent` / `email.failed` with kind `digest`.

### Idempotency keys

`POST /api/v1/{collection}` (tasks, projects, labels, sections, views, reminders) accepts an optional `Idempotency-Key` header: 1 to 128 characters of letters, digits and `. _ : -`. The server derives the new entity's id and the ids of its operations from the key, your account and the collection, so a retry after a timeout cannot create a second entity:

- The first request applies and answers **201** with the entity.
- A repeat with the same content answers **200** with the stored entity (later edits included, a tombstone with `deleted_at` set) and the header `Idempotent-Replayed: true`. Nothing new is written.
- A repeat with different content (another title, a field added or left out) answers **409 `idempotency_conflict`** and changes nothing. Use a new key.
- A malformed key answers **400 `invalid_input`** naming `Idempotency-Key`. Unauthenticated and `read`-token requests are refused as usual (401, 403).

Keys are scoped to your account: the same key used by someone else names a different entity, and one person's key can never return, overwrite or collide with another person's entity (an instance-wide random salt also keeps the derived ids unguessable). There is no key table to expire: the operation log is the record, so a key stays usable for as long as the entity exists. After the entity is permanently deleted from the Trash, or its history purged by end-to-end encryption, the key answers 409. Devices never send the header and sync converges with keyed creates like with any other write. With an [`agent` token](#agent-tokens) the derivation also includes the token, so two tokens using the same key create two entities.

```bash
curl -s -X POST "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: run42-milk' \
  -H 'Content-Type: application/json' -d '{"title":"Buy milk"}'          # 201
curl -si -X POST "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: run42-milk' \
  -H 'Content-Type: application/json' -d '{"title":"Buy milk"}'          # 200, Idempotent-Replayed: true, same id
curl -s -X POST "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: run42-milk' \
  -H 'Content-Type: application/json' -d '{"title":"Buy bread"}'
# 409 {"error":{"code":"idempotency_conflict","message":"this Idempotency-Key was already used for a create with different content; …"}}
```

### Credential introspection

`GET /api/v1/me` carries an `auth` object describing the credential of the request. It never contains the secret.

| Field | When | Value |
| --- | --- | --- |
| `method` | always | `session` or `token` |
| `scope` | always | `full`, `read`, `agent` or `admin` (a session is `full`) |
| `token_id`, `token_name` | tokens | the token in use, as listed by `GET /api/v1/tokens` |
| `writes_allowed` | `agent` tokens | whether both assistant switches are on right now |
| `writes_denied` | `agent` tokens with writes off | `writes_disabled_by_owner` or `writes_disabled_by_user` |

```json
{"user":{…},"auth":{"method":"token","scope":"agent","token_id":"9f1c…","token_name":"desk-assistant","writes_allowed":true}}
```

`ot auth status` shows it. A revoked token gets 401 `unauthorized` and no `auth` object.

### Agent tokens

An `agent` token may write through REST on this fixed list of routes only, and only while the owner's **Assistants may make changes** and the user's **Changes to my tasks** are both on:

| Route | What an agent token may send |
| --- | --- |
| `POST /api/v1/tasks` | `title`, `description`, `project_id`, `section_id`, `parent_id`, `priority`, `due`, `labels`, `estimate_minutes`, `deadline`, `start`, `evening`, `blocked_by`, `location`, `recurrence`, `origin` |
| `PATCH /api/v1/tasks/{id}` | the same edit fields (not `parent_id`), `due`, `project_id`, `section_id`, `completed_at` (complete or reopen) and `deleted_at` (to the Trash, only tasks the same token created) |
| `DELETE /api/v1/tasks/{id}` | only tasks the same token created (to the Trash) |
| `POST /api/v1/projects` | `name`, `color`, `parent_id`, `icon` (`archived: false` is accepted) |
| `PATCH /api/v1/projects/{id}` | `name`, `color` |
| `POST /api/v1/labels` | `name`, `color` (an existing label of that name is returned with 200) |
| `POST /api/v1/tasks/{id}/comments` | `body`, `parent_id` (`mentions` is accepted and dropped: assistant comments notify nobody) |

These requests never reach the regular handlers: they are translated into calls of the same tool registry as the [MCP write tools](mcp.md#letting-an-assistant-make-changes) (one request is one write call) and applied in one batch through the operation log with device `agent:<token-id>`, so they show in history as "AI assistant (*token name*)", are recorded as `agent.write` in the audit log, share the token's limits with MCP (30 write calls a minute, 1,000 changed items a day; beyond that 429 `rate_limited` with `Retry-After`), and follow the same rules for end-to-end encrypted accounts. Responses have the usual REST shapes.

Refusals:

| Status | Code | When |
| --- | --- | --- |
| 403 | `writes_disabled_by_owner`, `writes_disabled_by_user` | a switch is off (recorded as a failed `agent.write`) |
| 403 | `insufficient_scope` | any other write route, or a field outside the list above (`assignee_id`, `position`, `archived`, restoring with `deleted_at: null`, …) |
| 403 | `forbidden`, `not_permitted` | the user's role in a shared project does not allow it; trashing a task the token did not create |
| 404 | `not_found` | unknown, deleted or invisible ids, and anything in a project [kept away from assistants](#keeping-a-project-away-from-assistants) (indistinguishable) |
| 409 | `encryption_enabled` | readable text (title, description, name, comment, location) for an end-to-end encrypted account |
| 400 | `invalid_input` | a value the tool refuses (with the tool's message) |

A `location` is `{name?, address?, lat?, lon?, place_id?}` with at least one key, or `null`; `{"place_id": "<id>"}` alone copies a saved location (unknown id: 404 `not_found`). A deadline sent this way moves the task's deadline reminders, as a session's edit does.

Every other write route (tokens, settings, sync, sharing and members, invitations, project invite links, encryption keys, imports, backups, webhooks, purging, archiving or deleting projects, user administration) answers 403 `insufficient_scope`, and the list is enforced by the matched route, so a route added later stays refused until it is added on purpose.

`GET /api/v1/places` lists your saved locations (`{places:[{id, name, address, geo:{lat, lon}, position, created_at}]}`), any token scope, so a client can set a task's location by name; saved locations are written through sync.

### Keeping a project away from assistants

The owner of a project, or an admin of a shared one, can keep it and its sub-projects away from every AI assistant surface: MCP (whatever the token's scope), the agent content routes above and the in-app assistant then act as if it did not exist. Ordinary REST with a session, a `full` or an `admin` token, sync, CalDAV, feeds and the export are unaffected. It is server access state like membership: never an operation, never exported.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/projects/{id}/agent-access` | session or `full` token, any member | `{kept_away, inherited_from}`; `inherited_from` is the nearest ancestor that is kept away, or `null` |
| PUT | `/api/v1/projects/{id}/agent-access` | session or `full` token, owner or admin of the project | `{kept_away: boolean}` → the same shape; recorded as `project.agent_access`; demo instances → 403 `demo_restricted` |

`read` and `agent` tokens get 403 `insufficient_scope`; a non-member or unknown id 404 `not_found`; an editor or viewer 403 `forbidden` on `PUT`; any other body 400 `invalid_input` naming `kept_away`. `GET /api/v1/me` carries `agent_excluded_projects`: the ids of every project you can see that is kept away, inherited ones included. A sub-project's own switch is kept when its parent's is turned off; purging the project removes it.

### Task fields

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | |
| `description` | string | the note as **Markdown** text (headings, `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, links, `-`/`1.` lists, `- [ ]`/`- [x]` check items). Readable and writable as plain text: a write here is folded into the rich-text document by the next app that opens the note. At most 64 KB |
| `notes_doc` | string | the note as a mergeable rich-text document: `""` or `"ydoc:v1:<base64>"` (at most 256 KB). Opaque; scripts normally ignore it and use `description`. `400 invalid_input` when it is not a valid envelope. See [sync.md](sync.md#mergeable-documents) |
| `project_id` | string or null | null = Inbox |
| `parent_id` | string or null | parent task for subtasks, any depth; see [Subtasks](#subtasks) |
| `priority` | 1–4 | 1 highest, 4 default |
| `due` | `{date:"YYYY-MM-DD", time?:"HH:MM", tz?:"Area/City"}` or null | floating date by default; with `tz` (an IANA zone, only together with `time`) a zoned time, the instant at that wall time in that zone. `400 invalid_input` for a date that does not exist (`2026-02-31`), a time outside 00:00–23:59, `tz` without `time` or an unknown zone. See [sync.md](sync.md#zoned-due-values) |
| `labels` | string[] | ids of existing, non-deleted labels; replaced as a whole on PATCH |
| `estimate_minutes` | integer 1–10080 or null | duration estimate in minutes; `0`, negatives, fractions and strings are rejected. The Day and Week calendar draws a task with a due time as a block of this length. CalDAV clients read and write it as `ESTIMATED-DURATION` |
| `deadline` | `"YYYY-MM-DD"` or null | the day the task must be finished by, separate from the planned `due` date; a bare date that exists, so `"next friday"`, `"2026-02-30"` or a time are refused with `invalid_input`. Editing `due` never changes it |
| `start` | `"someday"`, `"YYYY-MM-DD"` or null | `someday` parks the task (out of Today, Upcoming, Anytime and the counts); a date defers it until that day. Anything else is refused with `invalid_input`. The API writes exactly what you send: unlike the app, it does not clear `due` when parking or un-park a task that gets a `due` or a `recurrence`, so a parked task with a rule stays parked (a due or deadline that has come still shows it in Today) |
| `evening` | boolean | This Evening: the task is grouped below the day's tasks in Today; it says nothing about the time |
| `blocked_by` | array of task ids | the tasks this one waits for (at most 50, distinct, never its own id), in the same project sharing; a list that would make the task wait for itself, or an id of a task shared differently, is refused with `400 invalid_input` naming the id. See [Dependencies](sync.md#dependencies) |
| `recurrence` | string or null | recurrence rule, e.g. `every 3 days after completion` (see [recurrence.md](recurrence.md)); stored in canonical form, `400 invalid_input` when it does not parse or is over 200 characters |
| `series_id` | string or null | on a completed occurrence record or a detached copy: the id of its recurring series |
| `habit` | boolean | the recurring task is tracked as a habit: the app shows its streak and month history, computed on each device. Settable like any field; `400 invalid_input` for anything but `true` or `false`. Completing a habit through the API records a done day like any recurring task. See [recurrence.md](recurrence.md#habits) |
| `skipped` | boolean | set by the app on the occurrence record a skipped habit day writes (that record also has `series_id` and `completed_at`). Such records are returned in lists and the export like any task but are not completions: the app hides them from Completed and `completed` filters, and they never count towards `for N times` |
| `assignee_id` | string or null | account id of the assignee; see [Assignment and notifications](#assignment-and-notifications). `400 not_a_member` when it is not a member of the task's shared project (or not you, for a personal task) |
| `section_id` | string or null | section of the task's project; see [Sections](#sections). `400 invalid_input` for an unknown or deleted section or one of another project. Changing `project_id` without naming a section clears it |
| `origin` | object or null | where the task came from, null when unset: `{kind, provider?, id?, url?, title?}` with `kind` one of `url` (a page; needs `url`), `email` (needs `id`, the Message-ID), `issue` (needs `id`, e.g. `o/r#7` or `ENG-123`) or `import` (needs `id`, the source id). `provider` is 1–32 of `a-z`, `0-9` and `-` (`github`, `gitlab`, `jira`, `linear`, `todoist`…); `url` is `http` or `https` with a host, at most 2,048 bytes; `id` at most 512 and `title` at most 500 characters; no other member. Written as one value (last writer wins, never mixed), accepted on create and PATCH (`null` clears) for `full`, `admin` and `agent` tokens; anything else is `400 invalid_input` naming `origin`. The server writes what you send: it derives nothing from the URL and never requests it (`ot add --origin-url` and the MCP tools recognise issue links on their side). Returned by every read, the export and webhook payloads; an end-to-end encrypted account holds one ciphertext string here. See [Where a task came from](capture.md#where-a-task-came-from) |
| `ical_extra` | string or null | opaque iCalendar lines a CalDAV client sent that the app does not model (alarms the reminder model cannot express, `X-` properties…); kept so calendar apps do not lose them. Display alarms become reminders instead. See [caldav.md](caldav.md#what-maps-to-what) |
| `fields` | object | custom field values keyed by field definition id, always present (`{}` when none), values included for definitions that were deleted or belong to another project. On create and PATCH, a partial object: each key is validated against the live definitions of the task's project after the write and merged into the existing values, one operation per key; `null` clears a value. `400 invalid_input` naming the id for an unknown or foreign id or a value of the wrong type; a raw `fields.<id>` key is refused. See [Custom fields](#custom-fields) |
| `position` | number | sort order inside a list: ascending, ties by id; clients move a task by writing the midpoint between its new neighbours (see [docs/sync.md](sync.md#manual-order)) |
| `completed_at`, `deleted_at` | unix ms or null | |
| `completed_by` | string or null | account id of whoever completed the task; null when open or unknown (completions made before this field, imports, public links). A write that sets `completed_at` without it records you; one that clears `completed_at` clears it |
| `created_at` | unix ms | set by the server on create if missing |

### Tasks completed in a range

`GET /api/v1/tasks` takes `completed_after` and `completed_before` to list only tasks completed at or after the first and before the second. Each is a date `YYYY-MM-DD` (midnight at the start of that day in the zone named by `timezone`, UTC by default), an RFC 3339 time, or Unix milliseconds; either may be left out. With either one, open tasks are left out. An unparseable value, an unknown `timezone`, or the parameters on another collection answer `400 invalid_input` naming the parameter.

```sh
# What I finished last week (Monday to Sunday, Zurich time)
curl -sS -H "Authorization: Bearer $T" \
  "$BASE/api/v1/tasks?completed_after=2026-10-05&completed_before=2026-10-12&timezone=Europe/Zurich" \
  | jq -r '.tasks[] | "\(.completed_at) \(.title)"'
```

### Subtasks

A task becomes a subtask by setting `parent_id` to another task's id, to any depth. On `POST /tasks` and `PATCH /tasks/{id}` the server checks the value and answers `400 invalid_input` when:

- the parent does not exist or is deleted (`parent task not found`),
- the parent is in a different project than the task — the task's `project_id` after the write, so you can set both in one request (`parent must be in the same project`),
- the parent is the task itself or one of its descendants, which would form a cycle (`parent is a descendant of the task`).

`parent_id: null` detaches a task and is always accepted. Nothing changes on a rejected request. The sync endpoint never rejects an operation for tree reasons; see `docs/sync.md` for how clients converge.

The REST API writes exactly the fields you send. The cascades the web app performs (completing a parent completes its open descendants, deleting a parent tombstones the subtree, moving a parent moves the subtree) are ordinary per-task operations issued by the client; a script that wants the same result sends one request per task. A subtask whose parent is completed, deleted or missing is shown at the top level of its project by every client, so nothing becomes unreachable.

```bash
# Add a subtask under an existing task in the same project
curl -sS "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Book hotel","project_id":"<project-id>","parent_id":"<parent-task-id>"}'
```

### Recurring tasks

`POST` and `PATCH` store `recurrence` in canonical form (`"Every  2nd  Tuesday"` is stored as `"every 2nd tuesday"`). A `PATCH` that sets a non-null `completed_at` on an open recurring task behaves like completing it in the app:

- a completed *occurrence record* is created (id derived from the series id and the occurrence date, `series_id` set, `recurrence: null`, other fields copied from the task after the rest of the PATCH is applied),
- the task stays open and its `due` moves to the next occurrence (time and `tz` kept); the response is the task with the new `due`,
- when the end condition (`until` or `for N times`) is reached, the task is completed normally instead.

"Today" for catch-up and completion-relative rules is the server's local date (the container's time zone, UTC by default); the user's day start (`user_prefs.day_start`) is not applied here. The occurrence record is keyed by the occurrence's due date, never by the clock, so a completion between midnight and the day start records the same day as one made in the app; only where a completion-relative rule counts from can differ by a day in that window. Reopening a record (`completed_at: null`) turns it into a standalone task; the series is not moved back. Skip and "this occurrence only" are client actions: a script skips by PATCHing `due`.

```bash
# Make a task repeat, then complete the current occurrence
curl -sS -X PATCH "$OT/api/v1/tasks/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"recurrence":"every weekday","due":{"date":"2026-10-12"}}'
curl -sS -X PATCH "$OT/api/v1/tasks/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"completed_at":1760264400000}'
```

### Quick-add parse

`POST /api/v1/quick-add/parse` reads one line with the grammar of the app's quick add (OpenSpec `extension-v2`), so a client without the web parser can preview and save a line the same way. Body: `{"line": "…", "url"?: "…", "today"?: "YYYY-MM-DD", "now"?: "HH:MM"}`; send `today` and `now` from the device, which wins over the server's clock (that falls back to the email digest's time zone, else UTC). The line is read in the account's interface language, then the request's `Accept-Language`, then English, with the account's date order, week start and its projects and labels (encrypted names cannot be matched).

The answer is `{title, fields, chips, unmatched, origin}`:

- `fields` holds only what the line sets, in the form `POST /api/v1/tasks` takes: `due` (`{date, time?}`), `deadline`, `start` (`"someday"`), `evening`, `project_id`, `priority`, `estimate_minutes`, `recurrence`; plus `labels` as `[{id?, name}]` (no `id` for a label that does not exist yet: create it with `POST /api/v1/labels` first), `spent_minutes` (post one closed time entry ending now) and `reminders`, each `{kind: "relative", offset_minutes}` or `{kind: "absolute", date, time}` (a floating moment the client turns into `fire_at` in its own zone), to post with `POST /api/v1/reminders` once the task exists.
- `chips` are the preview chips, `{kind, text, start, end}`, in the account's language; `start` and `end` count UTF-16 code units of the line. Kinds: `due`, `deadline`, `evening`, `someday`, `project`, `label`, `priority`, `estimate`, `recurrence`, `reminder`, `unmatched`.
- `unmatched` lists the `#name` tokens that name no project; they stay in `title`.
- `origin` is the recognised origin of `url` (an `issue` origin for a GitHub, GitLab, Jira or Linear link, else a `url` origin), or `null` without a `url`. The server makes no request to that address.

Errors: `400 invalid_input` for a body that is not an object, a missing `line`, a line over 2,000 characters or a malformed `today`/`now`; `401` without credentials; `429 rate_limited` above 60 requests a minute per account. The results are pinned to the web parser by the shared vectors in `web/src/lib/nlp/quickadd.vectors.json`, like `ot add --natural`.

### Project fields

`name` (string), `color` (string, CSS colour), `position` (number, sort order among siblings), `archived` (boolean), `parent_id` (string or null, see [Sub-projects](#sub-projects)), `created_at`, `deleted_at`, and the project's note: `description` (Markdown) and `notes_doc` (its mergeable document), exactly as on tasks (see [Mergeable documents](sync.md#mergeable-documents)). A `PATCH` of `description` alone is folded into the document by the next device that opens the note. Editors of a shared project may write the two note fields; every other project field needs an admin or the owner.

### Sub-projects

A project becomes a sub-project by setting `parent_id` to another project's id, to any depth. On `POST /projects` and `PATCH /projects/{id}` the server checks the value and answers `400 invalid_input` when:

- the parent does not exist or is deleted (`parent project not found`),
- the parent is the project itself or one of its descendants, which would form a cycle (`parent is a descendant of the project`).

`parent_id: null` moves a project to the top level and is always accepted. Nothing changes on a rejected request. The sync endpoint never rejects an operation for tree reasons; see `docs/sync.md` for how clients converge when two devices move projects into each other concurrently.

The REST API writes exactly the fields you send. The cascades the web app performs (archiving a project archives its descendants, deleting one moves its direct sub-projects to its own parent and its open tasks to the Inbox) are ordinary per-project operations issued by the client; a script that wants the same result sends one request per project. A sub-project whose parent is archived, deleted or missing is shown at the top level by every client, so nothing becomes unreachable.

```bash
# Create a sub-project, then move it to the top level
curl -sS "$OT/api/v1/projects" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Q4 launch","parent_id":"<parent-project-id>"}'
curl -sS -X PATCH "$OT/api/v1/projects/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"parent_id":null}'
```

### Sections

A section is a named, ordered container inside one project (OpenSpec change `board-view`): a heading in the list view and a column on the board. Sections are soft-deleted like everything else, live in the sharing scope of their project (editors and up may write them, viewers read them) and appear in the export, deleted ones included.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | required, not blank |
| `project_id` | string | required on create: an existing, non-deleted project; cannot change afterwards (`400 invalid_input`) |
| `position` | number | ascending order within the project; defaults to now (last) |
| `color` | string or null | a `#rrggbb` colour shown before the name, `null` for none (the default); anything else is `400 invalid_input` |
| `icon` | string or null | a name from the icon catalogue (`web/src/ui/icons/catalogue.json`, such as `hourglass`), `null` for none (the default); an unknown name is `400 invalid_input`. Responses always carry both fields |
| `created_at` | number | set by the server when omitted |
| `deleted_at` | number or null | set by `DELETE` |

`DELETE /api/v1/sections/{id}` tombstones the section and, in the same batch, sets `section_id` to `null` on each of its open tasks, so they move to "No section". Unknown fields are refused with `400 invalid_input`; requests without credentials get `401 unauthorized`.

```sh
# Create a section, put a task in it, then move the task back to "No section"
curl -X POST -H "Authorization: Bearer $T" -d '{"name":"Doing","project_id":"<project>"}' $BASE/api/v1/sections
# 201 {"id":"…","name":"Doing","project_id":"<project>","position":1760000000000,"created_at":1760000000000,"color":null,"icon":null}
curl -X PATCH -H "Authorization: Bearer $T" -d '{"section_id":"<section>"}' $BASE/api/v1/tasks/$TASK
curl -X PATCH -H "Authorization: Bearer $T" -d '{"section_id":null}' $BASE/api/v1/tasks/$TASK
curl -X POST -H "Authorization: Bearer $T" -d '{"name":"Doing","project_id":"missing"}' $BASE/api/v1/sections
# 400 {"error":{"code":"invalid_input","message":"section.project_id references unknown or deleted project \"missing\""}}
```

### Custom fields

A custom field definition gives the tasks of one project a typed value (OpenSpec change `custom-fields`, see [the guide](custom-fields.md)). Definitions are soft-deleted like everything else, live in the sharing scope of their project (editors and up may write them, viewers read them) and appear in the export under `fields`, deleted ones included. Tasks carry their values in the `fields` object of [Task fields](#task-fields).

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | required, not blank, at most 100 characters, unique in the project ignoring case |
| `type` | string | required on create: `text`, `number`, `date`, `choice`, `link` or `checkbox`; cannot change afterwards |
| `project_id` | string | required on create: an existing, non-deleted project; cannot change afterwards |
| `options` | string | a choice field's options, one per line (at most 50 of 100 characters); `""` for every other type (the default) |
| `position` | number | ascending order within the project; defaults to now (last) |
| `created_at` | number | set by the server when omitted |
| `deleted_at` | number or null | set by `DELETE`; the values on tasks stay, hidden by the app |

A project has at most 30 live definitions; one more is refused with `400 invalid_input` naming the limit. Values must match their definition's type: text of at most 2,000 characters, a finite number, a date `"YYYY-MM-DD"`, one of a choice's options, an `http` or `https` link of at most 2,000 characters, or a boolean; `null` clears. Unknown fields are refused with `400 invalid_input`; requests without credentials get `401 unauthorized`.

```sh
# Define a number field, set a value on a task, then read it back
curl -X POST -H "Authorization: Bearer $T" -d '{"name":"Cost","type":"number","project_id":"<project>"}' $BASE/api/v1/fields
# 201 {"id":"<cost>","name":"Cost","type":"number","options":"","project_id":"<project>","position":1760000000000,"created_at":1760000000000}
curl -X PATCH -H "Authorization: Bearer $T" -d '{"fields":{"<cost>":120}}' $BASE/api/v1/tasks/$TASK
# 200 {…,"fields":{"<cost>":120}}
curl -X PATCH -H "Authorization: Bearer $T" -d '{"fields":{"<cost>":"cheap"}}' $BASE/api/v1/tasks/$TASK
# 400 {"error":{"code":"invalid_input","message":"task.fields: \"<cost>\" (Cost) must be a number"}}
```

### Label fields

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | required on create, must not be blank; uniqueness is advisory (the app refuses duplicates per device, the API accepts them so merges stay possible) |
| `color` | string | CSS colour; picked from the palette when omitted on create |
| `icon` | string or null | an icon name from the app's set, shown in the project's colour; null (the default) shows a colour dot. Clients that do not know the field ignore it |
| `position` | number | sidebar order; defaults to the creation time |
| `created_at`, `deleted_at` | unix ms (or null) | |

Tasks reference labels by id, so renaming a label is one PATCH and never rewrites tasks. Deleting a label through the API only sets its tombstone; tasks that still carry the id keep it (the app hides ids of deleted labels), and the app's own delete additionally removes the id from every carrying task.

### View fields

A saved view is a named filter query with presentation options (OpenSpec `custom-views`). The app pins views to the sidebar and composes dashboards from them; queries are evaluated on each device, the server only checks that they parse.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | required on create, must not be blank |
| `query` | string | required on create for list views; must parse under the grammar in [`docs/filters.md`](filters.md), otherwise 400 with the parser's message (`view.query: Unknown term "urgent" at position 6`); may be empty for dashboards |
| `kind` | `"list"` or `"dashboard"` | default `list`; cannot be changed after creation |
| `group_by` | `"project"`, `"due"`, `"priority"`, `"label"` or `"none"` | default `project` |
| `sort_by` | `"due"`, `"priority"`, `"position"`, `"created"` or `"title"` | default `due` (undated tasks last) |
| `sort_dir` | `"asc"` or `"desc"` | default `asc`; for `priority`, `desc` lists priority 1 first |
| `pinned` | boolean | shown in the sidebar's Favourites group (every view is listed in the Views group); default `false` |
| `position` | number | sidebar order; defaults to the creation time |
| `color` | string | CSS colour; default `#64748b` |
| `panels` | string[] | dashboards only: up to 6 ids of existing, non-deleted **list** views, no duplicates, never the dashboard itself; replaced as a whole on PATCH |
| `on_drop` | object or null | list views only: what a card dropped on a board column showing this view gets (OpenSpec `rule-boards`); `null` (the default) or an object with at most these keys: `add_labels` and `remove_labels` (up to 32 ids of existing, non-deleted labels each), `priority` (1–4), `due` (`"today"`, `"tomorrow"`, `"next-week"` or `"clear"`), `start` (`"someday"` or `"clear"`), `section` (`{"project_id":"…","section_id":"…"\|null}`, a section of that project or none) and `state` (`"complete"` or `"reopen"`). Unknown keys, values outside these sets and any rule on a dashboard are refused with 400 naming the field; replaced as a whole on PATCH; every representation and the export carry it, `null` when unset |
| `layout` | `"list"` or `"board"` | list views: how the app shows the results (OpenSpec change `views-and-display`), a board being one column per group; absent until set, read as `list` |
| `show_completed` | boolean | list views: the app also lists completed matches, unless the query names a state itself; absent until set, read as `false` |
| `hidden_props` | string[] | list views: row properties the app leaves out, from `date`, `project`, `labels`, `estimate`, `assignee`, `deadline`, `start` and `origin`; absent until set, read as none; replaced as a whole on PATCH |
| `created_at`, `deleted_at` | unix ms (or null) | |

Values outside the listed sets are rejected with 400 `invalid_input` on `POST` and `PATCH` and nothing is written. The sync endpoint, by contrast, accepts any string for `kind`, `group_by`, `sort_by`, `sort_dir` and `layout` so that a future option stays additive; clients show the default for a value they do not know (see `docs/sync.md`, "Saved views"). Deleting a view sets its tombstone only; dashboards that list it keep the id and the app shows a "View removed" placeholder in that panel. The start view each device opens on launch is a device setting and is not part of the API.

### Reminders and push

A reminder belongs to one task and fires at an instant (OpenSpec change `reminders`; data model in [`docs/sync.md`](sync.md#reminders), behaviour in [`docs/reminders.md`](reminders.md)).

| Field | Type | Notes |
| --- | --- | --- |
| `task_id` | string | required on create; must name an existing, non-deleted task |
| `kind` | `"relative"`, `"absolute"` or `"deadline"` | default `absolute` |
| `offset_minutes` | integer or null | relative: minutes from the task's due time; deadline: minutes from 09:00 on the task's deadline; negative = before (−525600…525600) |
| `fire_at` | unix ms or null | absolute: required. Relative: computed by the server from the task's due date when omitted (09:00 for a date-only due, in the zone offset the user's devices last reported, UTC until then; a zoned due in its own zone); null while the task has no due date. Deadline: computed the same way from 09:00 on the task's deadline; null while it has none |
| `delivered_at` | unix ms or null | written by the server when it pushed the reminder |
| `dismissed_at`, `created_at`, `deleted_at` | unix ms (or null) | |

`PATCH /api/v1/tasks/{id}` that changes `due` (including completing a recurring task, which moves the series) recomputes `fire_at` of the task's relative reminders in the same batch, with the same timestamp as the due op. A change to `deadline` does the same for the task's deadline reminders; `due` edits never move them.

**Push subscriptions** are per device and outside the op log and the export. `POST /api/v1/push/subscriptions` takes the browser's `PushSubscription.toJSON()` plus the device id:

```json
{"deviceId": "8c1f…", "endpoint": "https://fcm.googleapis.com/fcm/send/…",
 "keys": {"p256dh": "BCVx…", "auth": "BTBZ…"}, "includeContent": false}
```

It answers 201 `{"subscription": {"id", "deviceId", "includeContent", "createdAt", "lastOkAt", "lastError", "failures", "needsRenewal"}}`; the endpoint and keys are never returned. Posting again for the same device replaces its subscription (200). A body without an `https` endpoint URL, an uncompressed P-256 `p256dh` key or a 16-byte `auth` secret is rejected with 400 `invalid_input`. A subscription created with a browser session is deleted when that session signs out or is revoked; the push service answering 404/410 deletes it as well, and `needsRenewal` turns true after 5 consecutive failed sends. After 20 consecutive failed sends and a day without a delivery (since the last success, or since it was registered) the server stops sending to it; posting it again from the device ("Re-enable") starts it afresh. An account keeps at most 20 subscriptions: registering a new device beyond that replaces the one registered least recently. Reminders are sent for up to 8 accounts at a time, and one account's sends take at most 20 seconds per pass; what is left is sent on the next pass (every 30 seconds) while the reminder is less than an hour overdue. With `OPENTODO_PUSH=off` every `/api/v1/push/` route answers 404 `not_found`.

**Test push.** `POST /api/v1/push/test` with `{"deviceId": "…"}` sends one real push to the caller's subscription for that device, through the same encryption, VAPID signature and push service as a reminder, and records it in the subscription's delivery status (`lastOkAt`, `failures`, removal when gone). The payload is `{"type":"test","testId":"…","sentAt":…}` and carries no task data; the service worker always shows it as a system notification and reports receipt to the open page. A push-service outcome is a successful diagnostic, so it answers 200:

```json
{"outcome": "sent", "testId": "Zk3q…", "subscription": {"id": "…", "lastOkAt": 1760000000000, "failures": 0, …}}
{"outcome": "no_subscription", "subscription": null}
{"outcome": "gone", "subscription": null}
{"outcome": "failed", "status": 500, "error": "push service answered 500", "subscription": {…, "failures": 1}}
```

`gone` means the push service reported the subscription expired and the server removed it; enable notifications again on that device. `failed` without `status` means the push service could not be reached. Errors: 400 `bad_request` without `deviceId`, 401 `unauthorized`, 403 `insufficient_scope` for read and agent tokens, 429 `rate_limited` after 5 tests per account in 10 minutes (counted before anything is sent), 404 `not_found` with `OPENTODO_PUSH=off`, 403 `demo_restricted` on a demo instance.

`POST /api/v1/sync` accepts an optional `tzOffset` (minutes east of UTC, −840…840): the device's zone, used for the REST recomputation above.

### Invitations

Invitations let the owner admit one person with one single-use, expiring link while sign-up stays closed. Accounts with the `owner` or `admin` role may create, list or revoke them; a member gets 403 `forbidden`. Invitations always admit a `member`. Invitations are server-side account data: they are never written to the op log and never sync to devices.

**Create** — `POST /api/v1/invitations` with an optional body:

| Field | Type | Notes |
| --- | --- | --- |
| `email` | string | Bind the invitation to one address (matched case-insensitively at acceptance) |
| `expiresInHours` | integer 1–720 | Default 168 (seven days) |

Response (201):

```json
{
  "invitation": {
    "id": "…", "status": "pending", "email": "friend@example.com", "role": "member",
    "createdBy": "<owner id>", "createdByName": "Owner",
    "createdAt": 1760000000000, "expiresAt": 1760604800000,
    "acceptedAt": null, "acceptedBy": null, "revokedAt": null
  },
  "link": "https://todo.example.com/invite/oti_…"
}
```

The `link` contains the secret and is returned exactly once; the server stores only a hash. The link uses `OPENTODO_BASE_URL` when set, otherwise the request's origin (`X-Forwarded-Host` / `X-Forwarded-Proto` only from an address in `OPENTODO_TRUSTED_PROXIES`). A link sent by email (`send: true`) always uses `OPENTODO_BASE_URL`; without it the answer is 409 `base_url_required` and nothing is created. Bad input (`expiresInHours` outside 1–720, a malformed `email`) is a 400 `invalid_input`. Creation is limited to 20 per hour per account (429 `rate_limited`).

**List** — `GET /api/v1/invitations` → `{invitations: [...]}` with the same shape as above, newest first. `status` is one of `pending`, `accepted`, `expired`, `revoked`; an accepted entry carries `acceptedBy: {id, email, name}`. Secrets and links never appear in the list.

**Revoke** — `DELETE /api/v1/invitations/{id}` → 204. An already accepted invitation answers 409 `invitation_spent`; an unknown id 404 `not_found`. Revoking an invitation that is already revoked or expired is a no-op 204.

**Preview** — `GET /api/v1/invitations/{token}` needs no authentication and returns `{inviterName, email, expiresAt}` (`email` is `null` for an open invitation). Unknown, expired, revoked and accepted tokens all return the same 404 `invitation_invalid`. Rate limited per client IP like sign-in.

**Accept** — `POST /api/v1/auth/register` with `invitation` set to the secret:

```bash
curl -sS "$OT/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"friend@example.com","name":"Friend","password":"a long passphrase","invitation":"oti_…"}'
```

Creates a `member` account and starts a session even when `OPENTODO_ALLOW_SIGNUP` is false. The invitation is spent in the same transaction, so it can create at most one account; a second use returns 404 `invitation_invalid`. Errors: 403 `invitation_email_mismatch` when the invitation is bound to another address, 409 `email_taken`, 400 `invalid_input` for the password policy. In every error case the invitation stays pending.

### Profile

Every user changes their own name, email and picture. Profile data is server-side account data: never written to the op log, never synced. Members of shared projects see changes on their next sync. Changes are recorded as `account.name_changed`, `account.email_change_requested`, `account.email_changed` and `account.avatar_changed`, never with a name, an address or a picture.

**Read** — `GET /api/v1/me/profile` → `{"user": {…}, "avatarVersion": 2, "pendingEmail": "new@example.com", "emailManagedBy": "https://id.example.com", "emailByLink": true}`. `avatarVersion` is 0 without a picture. `pendingEmail` is set while a change waits for its link. `emailManagedBy` names the provider of an account that signs in only through single sign-on, which can't change its email here. `emailByLink` says whether a change waits for a link. Every route below answers the same document.

**Name** — `PATCH /api/v1/me/profile` with `{"name": "Raffaele"}`: 1 to 80 characters after trimming, no control characters (400 `invalid_input` otherwise). A session or a `full` token; refused on the demo.

**Email** — `POST /api/v1/me/email` with `{"email": "new@example.com"}`, from a session confirmed in the last ten minutes (403 `reauth_required`). With outgoing email and `OPENTODO_BASE_URL`, the address becomes pending, a 24-hour link `/confirm-email/<token>` goes to it and a notice goes to the old address. A newer request replaces the pending one, and `DELETE /api/v1/me/email` cancels it. Without outgoing email the change applies at once. The link's page calls `POST /api/v1/me/email/confirm` with `{"token": "…"}` from the same account: another account gets 403 `forbidden`, and an unknown, used or expired token gets 400 `invalid_token`. Other errors: 409 `email_taken`, 400 `invalid_input`, 403 `forbidden` (single sign-on only), 429 `rate_limited` (5 an hour), 502 `email_failed` (nothing changed). Sessions stay signed in.

**Picture** — `PUT /api/v1/me/avatar` with a 256×256 PNG or JPEG body of at most 512 KB (413 `too_large`; anything else is 400 `invalid_input`). The server re-encodes it as JPEG, so no metadata is kept, and stores it as `<data>/avatars/<user id>.jpg`. It is included in backups and in the ZIP export as `profile/picture.jpg`. `DELETE /api/v1/me/avatar` removes it. `GET /api/v1/users/{id}/avatar?v=<avatarVersion>` serves it to the account and to members of a project it shares (404 for anyone else and for no picture), cached for a year at the current version. Member lists carry each member's `avatarVersion`.

### User administration

The owner, and admins within narrower limits, administer the accounts on the server. User administration is server-side account data: never written to the op log, never synced, and every action needs a connection. Roles:

| Action | owner | admin | member |
| --- | --- | --- | --- |
| invite, list and revoke invitations; list users | yes | yes | no |
| deactivate, reactivate, reset or delete a `member` | yes | yes | no |
| the same on an `admin` | yes | no | no |
| anything on the owner | no | no | no |
| change role (`admin` ↔ `member`), transfer ownership | yes | no | no |
| change own password | yes | yes | yes |

Checks run in this order: acting on your own account gives 409 `self_action`; a role that does not allow the action gives 403 `forbidden` (a member gets 403 on every mutating `/users` route); a target in the wrong state gives 409 `account_deactivated` or `account_active`; an unknown id gives 404 `not_found`. Every mutating `/users` route and `/me/password` is *fresh*: a cookie session must have proved its identity in the last ten minutes (`403 reauth_required`, see [Two-factor authentication](#two-factor-authentication)). They are *credential* routes too: a bearer token needs the `admin` scope (a `full` token gets `403 insufficient_scope`) and is never challenged.

**List** — `GET /api/v1/users` → oldest first, never a credential:

```json
{"users": [
  {"id": "…", "email": "owner@example.com", "name": "Owner", "role": "owner",
   "createdAt": 1760000000000, "lastLoginAt": 1760090000000, "status": "active"},
  {"id": "…", "email": "m@example.com", "name": "m", "role": "member",
   "createdAt": 1760001000000, "lastLoginAt": null, "status": "deactivated"}
]}
```

`lastLoginAt` is the last session start (password, passkey, second step or registration); it is `null` for accounts that have not signed in since the upgrade. `status` is `active` or `deactivated`.

**Role** — `PUT /api/v1/users/{id}/role` with `{"role":"admin"}` or `{"role":"member"}` → `{user}`. `owner` or an unknown value is 400 `invalid_input`; a deactivated target is 409 `account_deactivated`. The new role applies to the target's next request without signing them out.

**Deactivate / reactivate** — `POST /api/v1/users/{id}/deactivate` → `{user}`. In one transaction the account is marked deactivated, all its sessions and API tokens are deleted, and its pending invitations and unused reset links are revoked; its open `/sync/events` streams are closed at once. Its data stays on the server. A correct password for it then gets 403 `account_deactivated` at sign-in (a wrong one still gets 401 `invalid_credentials`). `POST …/reactivate` lifts the block; revoked credentials are not restored. Deactivating a deactivated account is 409 `account_deactivated`; reactivating an active one is 409 `account_active`.

**Delete** — `DELETE /api/v1/users/{id}` with `{"confirmEmail":"m@example.com"}` (compared case-insensitively; missing or different is 400 `confirmation_mismatch`) → 204. In one transaction the account, its personal ops and fields, sessions, tokens, passkeys, reset links and the invitations it created are deleted. Shared projects it owned are deleted for every member (their devices purge them on the next sync); its memberships in other people's projects end, while the edits it made there stay part of those projects. Audit events about the account are kept with an email snapshot. Irreversible: backups are the recovery path.

**Reset links** — `POST /api/v1/users/{id}/password-reset` with optional `{"expiresInHours": 1–72}` (default 24) → 201:

```json
{"expiresAt": 1760086400000, "link": "https://todo.example.com/reset/otr_…"}
```

The link is returned once (only its hash is stored) and uses the same origin rules as invitation links. Nothing is emailed; the administrator copies it. A new link revokes earlier unused ones. A deactivated target is 409 `account_deactivated`; a bad expiry 400 `invalid_input`. The owner is never a target: on the server, `opentodo reset-owner-password` prints an owner reset link (see [docs/self-hosting/docker.md](self-hosting/docker.md#recovering-owner-access)).

`GET /api/v1/password-resets/{token}` (no authentication) → `{email, expiresAt}`. `POST /api/v1/password-resets/{token}` with `{"password":"…"}` → 204: the password is replaced, the link is spent, and every session and remembered browser (`ot_trust`) of the account is deleted in one transaction, so the second factor is asked again everywhere; API tokens are kept and no session is started. To revoke tokens and app passwords as well, use `POST /api/v1/me/sign-out-everywhere` after signing in. Used, expired, revoked and unknown tokens all give the same 404 `reset_invalid`; a password under 10 characters is 400 `invalid_input` and the link stays pending. Both routes share the per-address sign-in limit (10 per minute).

**Own password** — `POST /api/v1/me/password` with `{"currentPassword":"…","newPassword":"…"}` → 204. Your other sessions are signed out, the current one stays (a bearer-token request signs out every session), API tokens are kept. A wrong current password is 403 `invalid_credentials`; a short new one 400 `invalid_input`. Limited to 10 per hour per account.

**Transfer** — `POST /api/v1/users/{id}/transfer-ownership` with `{"password":"…"}` (the owner's) → `{user}` with `role: "owner"`. In one transaction the target becomes owner and the previous owner becomes admin; the database allows only one owner. A deactivated target is 409 `account_deactivated`, your own id 409 `self_action`, a wrong password 403 `invalid_credentials`, a sender who is not (or no longer) owner 403 `forbidden`.

Mutating `/users` requests are limited to 60 per hour per acting account (429 `rate_limited`).

```bash
# Issue a reset link for a member (a script with an admin token: never challenged)
curl -sS -X POST "$OT/api/v1/users/$ID/password-reset" -H "Authorization: Bearer $TOKEN"
# 201 {"expiresAt":1760086400000,"link":"https://todo.example.com/reset/otr_…"}

curl -sS -X POST "$OT/api/v1/users/$OWNER_ID/deactivate" -H "Authorization: Bearer $TOKEN"
# 409 {"error":{"code":"self_action","message":"you cannot do this to your own account"}}
```

### Backups

Scheduled backups of the whole server (see [backups.md](backups.md)). Every route needs authentication (401 `unauthorized`) and the `owner` role (403 `forbidden` for members). Backup settings, runs and secrets are server-level data: they never sync to devices and are not part of the export.

**Settings** — `GET /api/v1/backups/settings`:

```json
{
  "settings": {
    "destination": "s3",
    "local": { "dir": "" },
    "s3": { "endpoint": "https://s3.eu-central-1.amazonaws.com", "region": "eu-central-1", "bucket": "my-backups",
            "prefix": "opentodo", "accessKey": "AKIA…", "pathStyle": false },
    "webdav": { "url": "", "username": "", "allowHttp": false },
    "schedule": { "frequency": "daily", "time": "03:00", "weekday": 0 },
    "retention": { "keepLast": 7, "maxAgeDays": 0 },
    "compress": true,
    "scheduleSince": 1760000000000
  },
  "secrets": { "hasS3SecretKey": true, "hasWebdavPassword": false, "hasPassphrase": true }
}
```

| Field | Notes |
| --- | --- |
| `destination` | `local`, `s3` or `webdav` (default `local`) |
| `local.dir` | absolute path; empty means `<data>/backups` |
| `s3.*` | `endpoint` (http(s) URL), `bucket` and `accessKey` are required for `s3`; `region` defaults to `us-east-1`; `pathStyle` for MinIO, Garage and most self-hosted stores |
| `webdav.*` | `url` is required for `webdav`; plain `http://` is refused unless `allowHttp` is true (the password would travel unencrypted) |
| `schedule.frequency` | `off` (default), `hourly`, `daily`, `weekly`, in the server's time zone |
| `schedule.time` | `HH:MM`; `hourly` uses the minutes only |
| `schedule.weekday` | 0 (Sunday) … 6 (Saturday), for `weekly` |
| `retention.keepLast` | at least 1 (default 7) |
| `retention.maxAgeDays` | 0 = no age limit |
| `compress` | gzip the archive (default true) |
| `scheduleSince` | read-only: when the current schedule was set |

**Update** — `PUT /api/v1/backups/settings` (a session or an `admin` token: it holds the destination's secrets) replaces the settings. Secrets go in an optional `secrets` object: a key that is absent keeps the stored value, an empty string removes it, any other value replaces it.

```bash
curl -sS -X PUT "$OT/api/v1/backups/settings" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "settings": {"destination":"local","local":{"dir":""},"schedule":{"frequency":"daily","time":"03:00","weekday":0},
               "retention":{"keepLast":7,"maxAgeDays":0},"compress":true},
  "secrets": {"passphrase":"a long passphrase you will not forget"}
}'
```

Secrets are stored in `<data>/secrets/backup.json` (mode 0600) and are never returned: responses carry only the `has…` flags. Invalid input is a 400 `invalid_input` whose `error.field` names the setting (for example `s3.bucket` or `retention.keepLast`); the previous settings stay active.

**Status** — `GET /api/v1/backups`:

```json
{
  "enabled": true, "destination": "local", "encrypted": true,
  "schedule": { "frequency": "daily", "time": "03:00", "weekday": 0 },
  "running": null,
  "nextRunAt": 1760151600000,
  "lastRun": { "id": "…", "kind": "scheduled", "status": "succeeded", "startedAt": 1760065200000, "finishedAt": 1760065200412,
               "durationMs": 412, "bytes": 182344, "destination": "local: /data/backups",
               "archiveName": "opentodo-20261010-030000-4f1c0a9e.tar.gz.enc", "error": "" },
  "history": [ { "…": "the last 20 runs, newest first" } ]
}
```

`running` is the run in progress (or `null`); `status` is `running`, `succeeded` or `failed`; a failed run carries the destination's error in `error`. `nextRunAt` is `null` while the schedule is off. Runs are kept for 90 days.

**Run now** — `POST /api/v1/backups/run` → 202 `{"status":"started"}`; poll the status for the outcome. A request while a backup runs is a 409 `conflict` and starts nothing.

```bash
curl -sS -X POST "$OT/api/v1/backups/run" -H "Authorization: Bearer $TOKEN"
curl -sS "$OT/api/v1/backups" -H "Authorization: Bearer $TOKEN" | jq '.lastRun'
```

**Test destination** — `POST /api/v1/backups/test` writes a small `opentodo-probe-<ms>.txt` object to the saved destination and deletes it again → 200 `{"ok":true}`. A destination failure is a 502 `destination_error` whose message is the destination's own (for example `s3 put opentodo/opentodo-probe-…: 403 Forbidden AccessDenied: …`). The server contacts a remote destination only for a test, a run, the archive list or a restore.

#### Restore from the web app

The owner can restore the whole server from a backup without shell access (see [backups.md](backups.md#restore-from-the-web-app)). The flow is *prepare* (verify and preview, nothing changes), then *confirm* (the server restarts and applies it before reopening the database). Every route below needs the owner (403 `forbidden` otherwise, before anything is read or stored) and is refused on a demo instance.

**List archives** — `GET /api/v1/backups/archives` → `{"destination": "/data/backups", "archives": [{"name": "opentodo-20261013-030000-4f1c0a9e.tar.gz.enc", "size": 182344, "createdAt": 1791860400000, "encrypted": true}]}`. Objects that are not OpenTodo archives are left out. An unreachable destination is a 502 `destination_error` naming it without credentials.

**Upload** — `POST /api/v1/backups/restore/uploads` with the archive as the raw body (`Content-Type: application/octet-stream`) → 201 with the staged restore (below). The body is streamed to `<data>/tmp/restore/<id>/`. Errors: 400 `integrity` (not an OpenTodo archive; nothing is kept), 507 `insufficient_storage` (the free space cannot hold the archive plus twice the current database and a 64 MiB margin; the partial file is removed). A reverse proxy with a small body limit answers 413 before the request arrives.

```sh
curl -sS -X POST "$OT/api/v1/backups/restore/uploads" -b cookies.txt \
  -H 'Content-Type: application/octet-stream' --data-binary @opentodo-20261010-030000-4f1c0a9e.tar.gz
```

**Prepare** — `POST /api/v1/backups/restore/prepare` with exactly one source and an optional passphrase:

```json
{"source": {"archive": "opentodo-20261013-030000-4f1c0a9e.tar.gz.enc"}, "passphrase": "only for another server's archive"}
```

`source` is `{"archive": name}` (from the list), `{"upload": id}` or `{"safetyCopy": "opentodo.db.pre-restore-20261013-030000"}` (undo). Encrypted archives are tried with the stored backup passphrase when none is given. The response is the staged restore:

```json
{"id": "3f9c…", "source": "archive", "archive": "opentodo-20261013-030000-4f1c0a9e.tar.gz.enc", "size": 182344, "encrypted": true,
 "manifest": {"appVersion": "0.4.0", "schemaVersion": 31, "createdAt": "2026-10-13T03:00:00Z", …},
 "counts": {"accounts": 2, "projects": 7, "tasks": 214, "ops": 5120},
 "verified": true, "createdAt": 1791900000000, "expiresAt": 1791901800000}
```

Errors: 422 `passphrase_required` / `passphrase_invalid`, 409 `newer_schema` (names both versions), 400 `integrity` (the failed check; staged files are removed), 400 `invalid_input` with `field: "source"` (a path or a name that is not an archive; no destination is contacted), 404 `not_found`, 502 `destination_error`, 507 `insufficient_storage`, 429 `rate_limited` (the re-authentication limit, against passphrase guessing). Only one restore is staged at a time; preparing another replaces it, and an unconfirmed one expires after 30 minutes.

**Confirm** — `POST /api/v1/backups/restore` with `{"id": "3f9c…", "confirm": "RESTORE"}` → 202 `{"status": "restarting"}`. The server shuts down gracefully, applies the restore before the database reopens (safety copy `opentodo.db.pre-restore-<ts>`, new log generation) and starts again in the same process; poll `GET /healthz`. Errors: 400 `invalid_input` with `field: "confirm"`, 404 `not_found` (unknown or expired id), 409 `conflict` (a backup is running), 403 `reauth_required` (re-authenticate first) and 403 `session_required` for any API token: only a signed-in owner can restore.

**State** — `GET /api/v1/backups/restore` → `{"staged": {…} | null, "last": {"source", "archive", "actorId", "requestedAt", "finishedAt", "ok", "error"?, "safetyCopy"?} | null, "safetyCopies": [{"name", "size", "createdAt"}], "undoAvailable": true, "freeBytes": 51539607552, "uploadLimit": 51400000000}`. `freeBytes` and `uploadLimit` are -1 where the platform cannot tell. A restore that failed while applying left the previous database in place; `last.error` says why.

**Cancel** — `DELETE /api/v1/backups/restore/{id}` → 204; the staged files are removed. **Delete a safety copy** — `DELETE /api/v1/backups/restore/safety-copies/{name}` → 204 (fresh session, no API tokens; 400 `invalid_input` for a name that is not a safety copy).

### Audit log

The server records security-relevant events in its own database (never synced to devices, never part of `/api/v1/export`). The owner reads, filters and exports the log; every user reads their own access events. There is no route to modify or delete an event: `PATCH`/`DELETE /api/v1/audit/{id}` answer 404 `not_found`. Events are removed only by retention pruning (and addresses only by disabling address logging).

**Event shape** (list, export and activity):

```json
{
  "id": 412, "ts": 1760000000000, "name": "token.created", "outcome": "success",
  "actorId": "<user id>", "actorEmail": "owner@example.com",
  "targetId": null, "targetEmail": null,
  "ip": null, "userAgent": "Mozilla/5.0 …",
  "details": { "token_id": "…", "token_name": "laptop script" }
}
```

`actorId` is the account that acted (null for a failed sign-in); `targetId` is the account acted upon when different. `actorEmail` / `targetEmail` come from the live account, or from the email snapshot in `details.email` when the account no longer exists. `ip` is null unless the owner enabled address logging. `userAgent` is truncated to 200 bytes. `details` only ever carries the keys below: never task or project content, passwords, token or invitation secrets, one-time or recovery codes.

| Event | Outcome | Actor / target | `details` keys |
| --- | --- | --- | --- |
| `login.succeeded` | success | actor = user | `email`, `method` (`password`, `register`, `passkey`, `oidc`, or a two-step method such as `password+totp`) |
| `login.failed` | failure | target = account if it exists | `email` (existing accounts only), `reason` (`wrong_password`, `unknown_account`, `rate_limited`, `unknown_passkey`, `passkey_rejected`, `passkey_counter_regression`, `deactivated`) |
| `logout` | success | actor = user | |
| `token.created`, `token.revoked` | success | actor = user | `token_id`, `token_name`; `token.created` also `token_scope` (`full`, `read`, `agent` or `admin`) |
| `agent.write` | success or failure | actor = user | `tool`, `token_id`, `token_name`, `count` (items changed; 0 on failure), `reason` on failure (`writes_disabled_by_owner`, `writes_disabled_by_user`, `rate_limited`, `encryption_enabled`, `not_found`, `forbidden`, `scope_change`, `not_permitted`, `invalid_arguments`, …). One per MCP write tool call of an `agent` token, and one per tool a REST write of an `agent` token runs (`update_project` for a project rename); never content or entity ids |
| `relay.enabled` | success | actor = user | `relay_device_id`, `relay_device_label`. A device of an encrypted account opted in to answer AI connectors ([device relay](#device-relay)) |
| `relay.disabled` | success | actor = user | `relay_device_id`, `relay_device_label`, `reason` (`user`, `locked`, `signed_out`, `encryption_off`). Relayed calls themselves are never relay events; relayed writes are `agent.write` |
| `account.name_changed`, `account.email_change_requested`, `account.email_changed`, `account.avatar_changed` | success | actor = user | none: never the old or new name, email or picture ([profile](#profile)) |
| `app_password.created`, `app_password.revoked` | success | actor = user | `app_password_id`, `app_password_name` |
| `calendar_feed.created`, `calendar_feed.rotated`, `calendar_feed.revoked` | success | actor = user | none (the feed secret is never recorded) |
| `email_inbox.created`, `email_inbox.rotated` | success | actor = user | (never the secret) |
| `email_inbox.updated` | success | actor = user | `setting` (`enabled` or `allowlist`), `from`, `to` (true/false, or the number of allowlist entries; never the addresses) |
| `issue_connection.created`, `issue_connection.deleted` | success | actor = user | `connection_id`, `provider` (`github` or `gitlab`); never the host, token, filter or issue content |
| `issue_connection.updated` | success | actor = user | `connection_id`, `provider`, `setting`: the changed settings by name, comma-separated (`host`, `filter`, `project`, `labels`, `interval`, `name`, `enabled`, `token`), never a value. Polls and the tasks they write are not recorded |
| `notification_channel.created`, `notification_channel.deleted` | success | actor = user | `notification_channel_id`, `channel_kind` (`ntfy`, `pushover`, `gotify`, `webhook`); never the address, topic, token, user key or signing secret |
| `notification_channel.updated` | success | actor = user | `notification_channel_id`, `channel_kind`, `setting`: the changed settings by name, comma-separated (`name`, `url`, `topic`, `events`, `include_titles`, `enabled`, `token`, `user_key`, `secret`), never a value. Messages sent are not recorded |
| `invitation.created` | success | actor = owner | `invitation_id`, `invited_email` (bound email, if any) |
| `invitation.accepted` | success | actor = new member | `invitation_id`, `email` |
| `invitation.revoked` | success | actor = owner | `invitation_id` |
| `project_invite.created` | success | actor = creator | `project_invite_id`, `shared_project_id`, `project_role`, `invited_email` (bound email, if any) |
| `project_invite.revoked` | success | actor = project owner or admin | `project_invite_id`, `shared_project_id` |
| `project_invite.accepted` | success | actor = the account that joined (new or existing), target = the link's creator | `project_invite_id`, `shared_project_id`, `project_role` |
| `workspace.created`, `workspace.renamed`, `workspace.deleted` | success | actor = owner or admin (the server owner when an account deletion removed it) | `workspace` (id; `renamed` also covers icon and colour, never a value) |
| `workspace.transferred` | success | actor = previous owner (the deleting owner at account deletion), target = new owner | `workspace` |
| `workspace.member_added`, `workspace.member_role_changed`, `workspace.member_removed` | success | actor = owner or admin (the member when leaving), target = member | `workspace`, `workspace_role` or `from`, `to` |
| `workspace.group_created`, `workspace.group_deleted` | success | actor = owner or admin | `workspace`, `group` (ids, never names) |
| `workspace.group_member_added`, `workspace.group_member_removed` | success | actor = owner or admin, target = member | `workspace`, `group` |
| `project.grant_added`, `project.grant_changed`, `project.grant_removed` | success | actor = project owner or admin | `shared_project_id`, `group`, `project_role` or `from`, `to` |
| `workspace_invite.created`, `workspace_invite.revoked` | success | actor = workspace owner or admin | `workspace_invite_id`, `workspace`, `workspace_role`, `invited_email` (bound email, if any) |
| `workspace_invite.accepted` | success | actor = the account that joined, target = the link's creator | `workspace_invite_id`, `workspace`, `workspace_role` |
| `settings.changed` | success | actor = owner (the user for `encryption*`) | `setting` (`audit.retention_days`, `audit.log_ip`, `webhooks_allow_private`, `mfa.required`, `mcp.enabled`, `mcp.writes`, `agent.writes` (actor = the user), `caldav.enabled`, `integrations.issues`, `project_invites.members_create_accounts`, `oidc.*`, `smtp.*` (`smtp.password` only as `set` or empty), `encryption`, `encryption.keys`), `from`, `to` |
| `export.requested` | success | actor = user | `format` (`json`) |
| `audit.exported` | success | actor = owner | `format` (`ndjson`), `count` |
| `mfa.enrolled`, `mfa.disabled` | success | actor = user (or the owner, target = account) | `method` |
| `mfa.reset` | success | actor = owner (none from the command line), target = account | |
| `mfa.challenge_failed` | failure | target = account | `reason` (`wrong_code`, `wrong_recovery_code`; never the code) |
| `passkey.registered`, `passkey.deleted` | success | actor = user | `passkey_id`, `passkey_name` |
| `identity.linked`, `identity.unlinked` | success | actor = user | `provider` |
| `role.changed` | success | actor = owner, target = account | `from`, `to` (account roles, or `project.<role>` for project membership) |
| `user.deactivated`, `user.reactivated` | success | actor = owner or admin, target = account | |
| `user.deleted` | success | actor = owner or admin, target = account | `email` (snapshot) |
| `password.reset_issued` | success | actor = owner or admin (none from the server shell), target = account | `reset_id` |
| `password.reset_completed` | success | actor = account | `reset_id` |
| `email.sent` | success | actor = the account that caused it (none for anonymous requests), target = recipient account when known | `email_kind` (`verify_signup`, `password_reset`, `invitation`, `project_invite`, `test`), `email` (recipient); never the link |
| `email.failed` | failure | as `email.sent` | `email_kind`, `email`, `reason` (`connect`, `tls`, `auth`, `send`, `rate_limited`, `encrypted_account`) |
| `public_link.created` | success | actor = creator | `public_link_id`, `shared_project_id`, `link_rights` (`view` or `tick`); never the secret or the name |
| `public_link.revoked` | success | actor = owner or admin of the project | `public_link_id`, `shared_project_id` |
| `project.agent_access` | success | actor = owner or admin of the project | `access_project_id`, `from`, `to` (`allowed` or `kept_away`); never the project's name |
| `task_page.published` | success | actor = publisher | `task_page_id`, `link_rights` (`view`, `reply` or `tick`); never the secret, the label or a share key |
| `task_page.revoked` | success | actor = publisher, or owner or admin of the project (also when a page is replaced by a new one) | `task_page_id` |
| `password.changed` | success | actor = user | |
| `sessions.revoked` | success | actor = user | `session_count`, `device_count`, `token_count`, `app_password_count`: what "Sign out everywhere" ended |
| `owner.transferred` | success | actor = previous owner, target = new owner | `from` (`owner`), `to` (`admin`): the previous owner's role change |
| `backup.created` | success or failure | actor = owner for "Back up now", none for scheduled runs | `backup_id` (the run id), `reason` (`run_failed`) on failure |
| `backup.restored` | success | none after `opentodo restore`; the owner who confirmed a web restore | `backup_id` (the archive file name), recorded on the first start after the restore |
| `backup.restore_requested` | success | owner | `backup_id` (archive or safety copy name), `source` (`archive`, `upload` or `safety-copy` for an undo); recorded on the start that applies it |
| `backup.restore_failed` | failure | owner | `backup_id`, `reason` (`integrity`, `newer_schema`, `insufficient_storage`, `data_dir_in_use`, `apply_failed`); the server kept the previous database |
| `backup.safety_copy_deleted` | success | owner | `backup_id` (the safety copy file name) |

While sign-in is rate limited for an address, one `login.failed` event with reason `rate_limited` is recorded per window instead of one per refused attempt. Task and project edits are never audit events.

**List** — `GET /api/v1/audit` (owner) → `{events: [...], cursor}`, newest first. `cursor` is the id to pass as `?cursor=` for the next page, or `null` when there are no more. Query parameters, all optional:

| Parameter | Meaning |
| --- | --- |
| `name` | one event name from the table above |
| `actor`, `target` | an account id, or an email (matched case-insensitively) |
| `outcome` | `success` or `failure` |
| `from`, `to` | inclusive time bounds, Unix milliseconds or RFC 3339 |
| `cursor` | the `cursor` of the previous page |
| `limit` | page size 1–200, default 50 |

A malformed value is a 400 `invalid_input` whose message starts with the parameter name (`limit: must be between 1 and 200`).

```bash
# Failed sign-ins of the last 24 hours
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OT/api/v1/audit?name=login.failed&from=$(( ($(date +%s) - 86400) * 1000 ))"
```

**Export** — `GET /api/v1/audit/export` (owner) with the same filters except `cursor` and `limit` → every matching event as newline-delimited JSON (`application/x-ndjson`, `Content-Disposition: attachment; filename="opentodo-audit-YYYYMMDD.ndjson"`), one event object per line, newest first. The export records an `audit.exported` event.

**Settings** — `GET /api/v1/settings/audit` (owner) → `{"retentionDays": 90, "logIp": false}`. `PUT` the same object, both fields optional: `retentionDays` is an integer 7–3650 (otherwise 400 `invalid_input`), `logIp` turns client address logging on or off. Turning it off erases every stored address in the same transaction. Each changed value is recorded as `settings.changed`; lowering retention prunes expired events immediately, and the server also prunes at startup and hourly.

**Personal activity** — `GET /api/v1/me/activity` (any signed-in user) → `{events: [...]}`: the caller's own sign-ins, failed sign-ins against their account, sign-outs and credential and token events from the last 90 days, at most 100, newest first. Events about other accounts never appear.

### Sharing

A project owner shares a project with other accounts on the same server by exact email (OpenSpec `project-sharing`). Roles:

| Role | May |
| --- | --- |
| `viewer` | read the project and its tasks |
| `editor` | also create, edit, complete and delete tasks in the project |
| `admin` | also rename, recolour and archive the project; add, re-role and remove viewers and editors |
| `owner` | everything, including deleting the project, transferring ownership and managing admins; exactly one per project |

Every route requires a session or token. A caller who is not a member gets `404 not_found`, the same as for a project that does not exist; the member's email is looked up only after the caller's role was checked, so the routes cannot be used to probe for accounts. Labels and saved views stay personal.

```sh
# Share with an existing account as editor
curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"email":"bob@example.com","role":"editor"}' $BASE/api/v1/projects/$P/members
# 201 {"projectId":"…","role":"owner","ownerId":"…","members":[{"userId":"…","name":"Alice","email":"alice@example.com","role":"owner"},
#      {"userId":"…","name":"Bob","email":"bob@example.com","role":"editor"}]}

curl -X POST … -d '{"email":"nobody@example.com","role":"editor"}' $BASE/api/v1/projects/$P/members
# 404 {"error":{"code":"user_not_found","message":"no account with this email exists on this server"}}

curl -X DELETE -H "Authorization: Bearer $T" $BASE/api/v1/projects/$P/members/me    # as the owner
# 409 {"error":{"code":"owner_must_transfer","message":"the owner cannot leave the project; transfer ownership to another member first"}}

curl -X POST … -d '{"userId":"<bob>"}' $BASE/api/v1/projects/$P/transfer
# 200 membership; Bob is the owner, the previous owner an admin
```

Collections, single reads and the export include the shared projects and their tasks; a shared project carries the read-only keys `role` (yours) and `owner_id`. They are ignored when sent back in a write. REST writes are checked with the same role table as sync: a refused write answers `403 forbidden` and stores nothing. A task cannot change sharing scope: `PATCH` of `project_id` to a project shared differently (or to the Inbox from a shared project) answers `400 scope_change`; create a copy in the destination and delete the original instead, which is what the web app does.

Membership changes are recorded in the audit log as `role.changed` with `from`/`to` values such as `none` → `project.editor`.

### Project invite links

A project's owner or admin can invite someone with a single-use link instead of an email (OpenSpec `project-invite-links`). Opening the link adds the person to the project with the link's role; it can also create their account. Links are server-side account data: never written to the op log, never synced, and every route needs a connection.

**Create** — `POST /api/v1/projects/{id}/invites` (owner or admin of the project; a *fresh* session, like invitations; `read` and `agent` tokens get 403 `insufficient_scope`):

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `viewer`, `editor` or `admin` | required; `admin` only for the project's owner (an admin gets 403 `forbidden`) |
| `email` | string | Bind the link to one address (matched case-insensitively when it is used) |
| `expiresInHours` | integer 1–720 | Default 168 (seven days) |

```json
{
  "invite": {
    "id": "…", "projectId": "…", "role": "editor", "email": null,
    "createdBy": "<your id>", "createdByName": "Alice",
    "createdAt": 1760000000000, "expiresAt": 1760604800000
  },
  "link": "https://todo.example.com/invite/p/otp_…",
  "newAccounts": true
}
```

The `link` holds the secret and is returned exactly once; the server stores a hash. `newAccounts` says whether the link can create an account right now (see below). A viewer or editor gets 403 `forbidden`, a non-member 404 `not_found`; bad input is 400 `invalid_input` naming the field; 20 links per account per hour (429 `rate_limited`). An end-to-end encrypted account cannot create a link for a project it has not shared yet (409 `encryption_enabled`).

**List** — `GET /api/v1/projects/{id}/invites` → `{invites: [...]}`: the pending links of the project, newest first, same shape as above, never a secret.

**Revoke** — `DELETE /api/v1/projects/{id}/invites/{inviteId}` → 204 (any owner or admin of the project; repeating it is a no-op). An accepted link answers 409 `invitation_spent`, an unknown id 404 `not_found`.

**Preview** — `GET /api/v1/project-invites/{token}` needs no authentication:

```json
{"inviterName": "Alice", "projectName": "Home", "role": "editor", "email": null,
 "expiresAt": 1760604800000, "canCreateAccount": true}
```

`alreadyMember` (true or false) is added when the request carries a session. No ids are returned. Unknown, expired, revoked and used links, links to a deleted project, links whose creator was deactivated or can no longer grant the role (removed from the project, or no longer its owner or admin) all answer the same 404 `invitation_invalid`. Rate limited per client address together with sign-in.

**Join while signed in** — `POST /api/v1/project-invites/{token}/accept` (session or full token) → 200 `{projectId, role}`. The account becomes a member, the link is spent, and the devices of every member are woken to sync. Errors: 409 `already_member` (the link stays pending), 403 `invitation_email_mismatch`, 404 `invitation_invalid` (also when the creator lost the right since the preview, or another acceptance won).

**Join with a new account** — `POST /api/v1/auth/register` with `projectInvite`:

```bash
curl -sS "$OT/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"dora@example.com","name":"Dora","password":"a long passphrase","projectInvite":"otp_…"}'
# 201 {"user":{…,"role":"member"},"projectId":"…","role":"editor"} + session cookie
```

The account, the membership and the spend commit in one transaction, so a link creates at most one account. A link may create an account when its creator is the server owner or an admin, when open sign-up is on, or when the owner turned on **Invite new people** (`PUT /api/v1/settings/project-invites` `{"membersCanInviteNewPeople": true}`; off by default; any signed-in account can read it with `GET`). Otherwise the answer is 403 `project_invite_not_allowed` and the person signs in with an existing account first. In SSO-only mode registration answers 403 `sso_required`; the person signs in through the provider and then joins. Other errors as for invitations (`invitation_email_mismatch`, `email_taken`, `invalid_input`); in every error case the link stays pending.

### Workspaces

A workspace is a separate room with its own projects, labels, views and people (OpenSpec `workspaces`, guide: [workspaces](workspaces.md)). Every account has one default workspace (`"default": true`, named "Personal" until renamed), which cannot be deleted, left, transferred or given members (409 `default_workspace`). Projects, labels, views and tasks without a project carry `workspace_id` (null or absent = the default workspace; a task with a project follows its project); on a shared project only the owner may change it. Workspaces, members and groups are server data, never ops; every sync response carries `workspaces` (below).

Every route needs a session or a `full` or `admin` token (`read` and `agent` tokens: 403 `insufficient_scope`); writes answer 403 `demo_restricted` on a demo. A non-member gets 404 `not_found`. Roles: `owner` (one), `admin` (adds members, manages groups and links), `member` (reads, leaves).

| Method | Path | Body → answer |
| --- | --- | --- |
| `GET` | `/api/v1/workspaces` | → `{workspaces: [workspace]}` |
| `POST` | `/api/v1/workspaces` | `{name, icon?, color?}` → 201 workspace; 20 owned per account (409 `limit_reached`) |
| `GET`, `PATCH`, `DELETE` | `/api/v1/workspaces/{id}` | `PATCH {name?, icon?, color?}` (owner, admin); `DELETE` (owner) → 204, 409 `workspace_not_empty` while it has projects or other members |
| `POST` | `/api/v1/workspaces/{id}/leave`, `…/transfer` | leave → 204 (the owner: 409 `owner_must_transfer`); transfer `{userId}` (owner, to a member) → 200 |
| `GET`, `POST` | `/api/v1/workspaces/{id}/members` | `POST {email, role: member\|admin}` (admins add members) → 201; 404 `user_not_found`; 200 members |
| `PATCH`, `DELETE` | `/api/v1/workspaces/{id}/members/{userId}` | `{role}`; removing a member also removes every grant they hold on the workspace's projects |
| `GET`, `POST` | `/api/v1/workspaces/{id}/groups` | `POST {name}` → 201 `{id, name, members}`; names unique ignoring case (409 `group_exists`), 50 groups |
| `PATCH`, `DELETE` | `/api/v1/workspaces/{id}/groups/{groupId}` | rename `{name}`, delete |
| `PUT`, `DELETE` | `/api/v1/workspaces/{id}/groups/{groupId}/members/{userId}` | 100 members per group; only workspace members (409 `not_in_workspace`) |

A workspace:

```json
{"id": "…", "name": "Family", "icon": "house", "color": "#3b82f6", "default": false, "role": "owner", "ownerId": "…",
 "members": [{"userId": "…", "name": "Alice", "role": "owner"}], "groups": [{"id": "…", "name": "Adults", "members": ["…"]}]}
```

Members carry names, never emails. Limits are 409 `limit_reached` naming the limit; a hosted server may lower them per tenant. An end-to-end encrypted account can create, rename and delete its workspaces and move things between them, but adding members, creating groups or links, and granting groups answer 409 `encryption_enabled`.

**A created workspace is a closed directory**: a project in it can be shared only with its members (`POST /projects/{id}/members` with anyone else: 409 `not_in_workspace`; a project invite link accepted from outside: 404 `invitation_invalid`). In the default workspace projects share by email as before. A member of a shared project who is not in its workspace sees it in their default workspace.

**Group grants** — `POST /api/v1/projects/{id}/grants` `{groupId, role}` → 201 member list; `PATCH …/grants/{groupId}` `{role}`; `DELETE …/grants/{groupId}` → 204. The project's member rules apply (an admin grants viewer and editor), and only groups of the project's workspace (404 otherwise). A member's role is the highest of their direct grant and their groups'; the member list adds `via` (the groups a role comes from, `[]` for a direct grant) and `grants`. Changing a group changes every project it is on in the same request, without writing an op.

**Invite links** — `POST /api/v1/workspaces/{id}/invites` `{role: member|admin, email?, expiresInHours?, send?}` (owner or admin; `admin` links only by the owner) → 201 `{invite, link, newAccounts}` with a `/invite/w/otw_…` link, as [project invite links](#project-invite-links): 20 per hour, `GET` lists pending links, `DELETE …/invites/{inviteId}` revokes. `GET /api/v1/workspace-invites/{token}` (no authentication; 404 `invitation_invalid` on a demo) → `{inviterName, workspaceName, role, email, expiresAt, canCreateAccount, alreadyMember?}`; `POST …/accept` → `{workspaceId, role}` (409 `already_member`); `POST /api/v1/auth/register` with `workspaceInvite` creates the account under the project-link rule.

### Public links

A project's owner or an admin can publish the project as a list that anyone with the link can open without an account: read-only (`view`) or with checkboxes (`tick`). Links are reusable until revoked or expired, are server data (never synced, never exported) and need a connection.

**Create** — `POST /api/v1/projects/{id}/public-links` (a fresh session or a full token) with `{"rights": "tick", "name": "Grandma", "expiresInDays": 30}`: `rights` is `view` or `tick`, `name` an optional label of at most 60 characters shown only to the project's managers, `expiresInDays` 1–90 or absent for no expiry. 201:

```json
{"id": "01J…", "projectId": "…", "rights": "tick", "name": "Grandma", "createdBy": "…", "createdByName": "Alice",
 "createdAt": 1760000000000, "expiresAt": null, "lastUsedAt": null, "link": "https://todo.example.com/public/otl_…"}
```

The `link` carries the secret and is returned only here; the server keeps a hash. Errors: 400 `invalid_input` naming the field, 403 `forbidden` for viewers and editors, 404 `not_found` for non-members, 409 `encryption_enabled` for an unshared project of an account with end-to-end encryption, 429 `rate_limited` after 20 links an hour.

**List and revoke** — `GET` answers `{links: [...]}` with the active links (no secrets, with `lastUsedAt`); `DELETE …/public-links/{linkId}` revokes (204; 404 `not_found` for an unknown id).

**The list** — `GET /api/v1/public/{token}` needs no authentication and ignores a session cookie, so everyone gets the same answer: `projectName`, `projectColor`, `rights`, `sections` (`id`, `name`, `position`) and `tasks` with only `id`, `title`, `due`, `priority`, `section_id`, `parent_id`, `position` and `completed_at`: open tasks and those completed in the last 24 hours. No description, notes, labels or assignee are ever included.

**Tick** — `POST /api/v1/public/{token}/tick` with `{"taskId": "…", "completed": true}` completes (or with `false` reopens) a task of the list and answers `{taskId, completed_at}`. A repeating task records the occurrence and moves to its next date, as when the API completes it. The change is an ordinary op by the link's creator from the device `public:<link-id>`: history labels it "Public link (*name*)" for the project's owner and admins and "Public link" for everyone else, and activity shows "Public link" as the actor. Errors: 403 `forbidden` on a `view` link, 404 `not_found` for a task that is not on the list, 400 `invalid_input` without `completed`.

**Unusable links** — an unknown, expired or revoked secret, a creator who was deactivated or is no longer the project's owner or admin, a deleted or archived project, or an unshared project whose creator turned on encryption all answer the same 404 `link_invalid`. The link is not deleted: unarchiving the project or restoring the role makes it work again. Devices cannot send ops with a `public:` device (400 `invalid_op`).

**Limits and headers** — per link 120 reads and 60 ticks a minute, per client address 120 public requests a minute; an unknown secret counts against the sign-in window (10 a minute per address). Public responses and the `/public/…` page carry `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and the request log never shows the secret.

### Assignment and notifications

A task's `assignee_id` (OpenSpec `task-assignment`) is an ordinary task field: set it with `POST /api/v1/tasks` or `PATCH /api/v1/tasks/{id}`, clear it with `null`. In a shared project the assignee must be a current member; for a task in your Inbox or an unshared project it must be you. Viewers cannot assign (`403 forbidden`, like any write). A refused assignment answers `400 not_a_member` and stores nothing; the sync endpoint refuses the same operation individually with `rejected: [{"id":"…","reason":"not_a_member"}]`.

When a member leaves or is removed, or their account is deleted, the server clears `assignee_id` on every task of that project assigned to them with operations of its own (device `server:<boot id>`), so every member's devices see the tasks unassigned after their next sync.

Assigning a task to someone other than yourself creates an in-app notification for the assignee. Notifications are server-side account data: they are not part of the op log or the export. Read notifications older than 90 days are removed when the server starts and then once a day. Both routes require a session or token (`401 unauthorized`).

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/notifications` | your notifications, newest first (at most 200), and the unread count |
| `POST /api/v1/notifications/{id}/read` | mark one of yours read (idempotent); `204`, or `404 not_found` for an unknown id or another account's notification |

```sh
curl -X PATCH -H "Authorization: Bearer $T" -d '{"assignee_id":"<bob>"}' $BASE/api/v1/tasks/$TASK
# 200 task with "assignee_id":"<bob>"

curl -X PATCH … -d '{"assignee_id":"<carol, not a member>"}' $BASE/api/v1/tasks/$TASK
# 400 {"error":{"code":"not_a_member","message":"task.assignee_id: the assignee must be a member of the task's project (or yourself for a personal task)"}}

curl -H "Authorization: Bearer $BOB" $BASE/api/v1/notifications
# 200 {"notifications":[{"id":"…","kind":"assigned","payload":{"assigneeId":"<bob>","actorId":"<alice>",
#        "actorName":"Alice","taskId":"<task>","taskTitle":"Milk","projectId":"<p>","projectName":"Home",
#        "at":1760000000000},"createdAt":1760000000000,"readAt":null}],
#      "unread":1}

curl -X POST -H "Authorization: Bearer $BOB" $BASE/api/v1/notifications/$N/read
# 204
```

`projectId` and `projectName` are omitted for a task in the Inbox.

### Trash and history

Deleting (`DELETE /api/v1/{tasks|projects}/{id}`) is a tombstone: the item goes to the Trash and can be restored by writing `deleted_at: null` (`PATCH` accepts deleted items). Deleting a project leaves its tasks' `project_id` alone; clients hide those tasks until the project is restored or purged.

History is read from the operation log. Each change set groups the field writes made at one timestamp by one device (`server:<boot id>` for REST writes, `server` for those stored by older releases, `caldav:<id>` for calendar apps, `agent:<token-id>` for AI assistants); a change set written by an AI assistant also carries `device_label`: `"AI assistant (<token name>)"` when you own the token and it still exists, `"AI assistant"` otherwise. `from` is the previous value in timestamp order, and `lost: true` marks a write that arrived after a newer one and never became the stored value. Members of a shared project see the history of its tasks; nobody sees another account's personal items (404 `not_found`, as for unknown ids and purged items). Restoring an old value is an ordinary write, so it appears in the history too.

```sh
curl -sS "$OT/api/v1/tasks/$ID/history" -H "Authorization: Bearer $TOKEN"
# 200 {"entity":"task","id":"…","more":false,"changeSets":[
#   {"ts":1760090000000,"device":"3c54…","userId":"…","changes":[{"opId":"…","field":"title","from":null,"to":"Draft"}]},
#   {"ts":1760090500000,"device":"server","userId":"…","changes":[{"opId":"…","field":"title","from":"Draft","to":"Final"}]}]}

# Permanently delete a trashed task (its operations, values and reminders)
curl -sS -X DELETE "$OT/api/v1/tasks/$ID/purge" -H "Authorization: Bearer $TOKEN"
# 200 {"purged":{"tasks":1,"projects":0,"reminders":0,"sections":0,"comments":0,"attachments":0,"timeEntries":0}}
# 409 {"error":{"code":"not_deleted","message":"only items in the Trash can be permanently deleted; delete it first"}}
```

Purging a project also purges every task that references it; purging a task also purges its deleted subtasks and every time entry on it, other members' included (`timeEntries`). In a shared project the role table applies: editors may purge tasks, only the owner may purge the project (403 `forbidden`); emptying the Trash skips items your role cannot delete. Purge is final and cannot be undone. The server also purges items that have been in the Trash longer than `OPENTODO_TRASH_RETENTION_DAYS` (default 30, `0` disables); see [sync](sync.md#purge).

### Attachments

Attachments (OpenSpec `attachments`) are files or links on a task or one of its comments. Their metadata is an entity in the operation log (`attachment`, fields in [docs/sync.md](sync.md#attachments)); the bytes are files moved with these routes. Every route answers `404 not_found` for an attachment or task you cannot read. Uploads need a session or a full token (`read` tokens get `403`) and are limited to 120 per hour per account (`429 rate_limited`).

| Route | Does |
| --- | --- |
| `POST /api/v1/tasks/{id}/attachments` | Multipart `file` (and optional `comment_id`): stores the file and creates the attachment in one request. JSON `{"url": "https://…", "name"?: "…"}`: a link attachment. `201` with the attachment. Honours `Idempotency-Key` (a retry answers `200` with `Idempotent-Replayed: true`) |
| `GET /api/v1/tasks/{id}/attachments` | The task's attachments that are not removed, oldest first, each with `uploaded` |
| `PUT /api/v1/attachments/{id}/content` | The raw bytes of an attachment you created (from a device that queued it offline); `204`. The bytes must match the attachment's `size` and `sha256` |
| `GET /api/v1/attachments/{id}/content` | The file, with ranges and `If-None-Match`. `?download=1` forces a download |
| `PATCH /api/v1/attachments/{id}` | `{"name": "…"}`: rename (author only) |
| `DELETE /api/v1/attachments/{id}` | Remove (author, project admin or owner); `204` |
| `GET` / `PUT /api/v1/settings/attachments` | `{enabled, max_file_mb, quota_mb}`; changing them is for the owner (`max_file_mb` 1–2048, `quota_mb` 0 = unlimited). Changes are audited as `settings.changed` |

### Instance branding

The owner gives the server a name and a logo (**Settings → Server → Branding**). `GET /api/v1/auth/status` carries `"branding": {"name": "Acme Tasks", "logoVersion": 2}` for everyone (`name` empty and `logoVersion` 0 without branding), and the page and the web app manifest are served with the name in the title and the logo as favicon, touch icon and app icons, so an installed app shows them.

| Route | Does |
| --- | --- |
| `GET` / `PUT /api/v1/settings/branding` | Owner. `PUT {"name": "…"}`: up to 40 characters after trimming, no control characters, empty for OpenTodo's own name (400 `invalid_input` otherwise). Answers `{name, logoVersion}`; recorded as `settings.changed` (`branding.name`) |
| `PUT /api/v1/settings/branding/logo` | Owner. The raw bytes of a PNG or JPEG, at most 2 MB (413 `too_large`), at least 192 and at most 4096 pixels a side (400 `invalid_input`). The server crops the centre square and renders 32, 180, 192 and 512 px PNGs plus a maskable 512 px icon under `<data>/branding/`, bumps `logoVersion` and answers `{name, logoVersion}`; recorded as `settings.changed` (`branding.logo`) |
| `DELETE /api/v1/settings/branding/logo` | Owner. Removes the rendered files; `logoVersion` becomes 0 and the app's own icons return |
| `GET /branding/logo-{32,180,192,512}.png`, `GET /branding/logo-maskable-512.png` | Public, like the app's own icons. With `?v=<logoVersion>` cached for a year (`immutable`); without the current version `no-cache`. 404 without a logo |

Branding is refused on a demo instance like every server setting.

`GET /api/v1/me` includes `attachments: {enabled, max_file_bytes, quota_bytes, used_bytes}`.

**Downloads** are served with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Content-Disposition` with the file name, `Cache-Control: private, max-age=31536000, immutable` and the digest as `ETag`. Only images (PNG, JPEG, GIF, WebP, AVIF), PDF, plain text, audio and video are served inline with their type; everything else (HTML and SVG included) and every encrypted file is `application/octet-stream` with `attachment`.

Errors: `400 attachment_mismatch` (bytes do not match the size or digest), `413 attachment_too_large`, `403 quota_exceeded`, `403 attachments_disabled`, `409 already_uploaded`, `507 insufficient_storage`.

```sh
curl -sS -X POST "$OT/api/v1/tasks/$TASK/attachments" -H "Authorization: Bearer $TOKEN" -F file=@receipt.pdf
# 201 {"id":"…","name":"receipt.pdf","mime":"application/pdf","size":48213,"uploaded":true,…}
```

### Comments and activity

Comments (OpenSpec `comments-and-activity`) are threaded markdown notes on a task. They are stored in the operation log like tasks, in the task's sharing scope, so every route answers `404 not_found` for a task or comment you cannot read, exactly as for an unknown id. Anyone who can read the task may comment, viewers included. Only the author may edit a comment; the author, project admins and the owner may delete it (`403 forbidden` otherwise). `author_id`, `task_id` and the timestamps are set by the server and cannot be sent. `mentions` lists account ids; the server keeps only current members of the task's shared project (always none on a personal task) and notifies each newly mentioned member (`kind: "mentioned"` in `GET /api/v1/notifications`, payload `{recipientId, actorId, actorName, commentId, taskId, taskTitle, projectId?, projectName?, excerpt, at}`). Each account may create 60 comments a minute (`429 rate_limited`). Bodies are markdown; clients render a safe subset and the server never renders them. Whatever editor wrote it, a body stays one Markdown string: the app's editor writes headings, lists, `> ` quotes, fenced code, pipe tables, `![alt](attachment:<id>)` for an image attachment of the same task and `@name` for a mention, and keeps other text verbatim.

Every comment carries `reactions`, a map from each of the six names `thumbs_up`, `heart`, `check`, `eyes`, `party`, `question` to the account ids that chose it (every name present, lists sorted), and `my_reactions`, the caller's own list; the export shows the same form. `PUT /api/v1/comments/{id}/reactions` with `{"reactions":["thumbs_up"]}` replaces the caller's list through the operation log (an empty list removes them all); it counts toward the comment rate limit. A mention in a task's notes notifies with the same `kind: "mentioned"` and `source: "note"` (no `commentId`); a task's `note_mentions` lists the mentioned members, filtered to current members of its shared project like comment mentions.

```sh
curl -sS -X POST "$OT/api/v1/tasks/$TASK/comments" -H "Authorization: Bearer $TOKEN" \
  -d '{"body":"Whole or **skimmed**? @bob","mentions":["<bob>","<not a member>"]}'
# 201 {"author_id":"<you>","body":"Whole or **skimmed**? @bob","created_at":1760090000000,"deleted_at":null,
#      "edited_at":null,"id":"…","mentions":["<bob>"],"parent_id":null,"task_id":"<task>"}

curl -sS -X POST "$OT/api/v1/tasks/$TASK/comments" -H "Authorization: Bearer $BOB" -d '{"body":"Whole","parent_id":"<comment>"}'
# 201 reply; parent_id must be a comment on the same task (400 invalid_input otherwise)

curl -sS "$OT/api/v1/tasks/$TASK/comments" -H "Authorization: Bearer $TOKEN"
# 200 {"comments":[ …top-level comments by creation time, each followed by its replies… ]}

curl -sS -X PATCH "$OT/api/v1/comments/$C" -H "Authorization: Bearer $BOB" -d '{"body":"hijack"}'
# 403 {"error":{"code":"forbidden","message":"only the author can edit a comment; the author, project admins and the owner can delete it"}}

curl -sS -X DELETE "$OT/api/v1/comments/$C" -H "Authorization: Bearer $TOKEN"
# 204; the comment is no longer listed (devices show a placeholder in the thread)
```

Activity is derived from the operation log on request, never stored (see [sync](sync.md#activity) for the rule shared with the client). A task's activity covers the task and its comments; a project's covers its tasks, their comments and the project. Events are newest first; `cursor` is present when `more` is true and is passed back as `before` for the next page (pages never overlap). `actor` is the author's account id, `actorName` and `taskTitle` are resolved for display, `changes` lists each touched field with its old and new value (empty for comment events), `opIds` the operations the event folds.

```sh
curl -sS "$OT/api/v1/projects/$P/activity?limit=2" -H "Authorization: Bearer $TOKEN"
# 200 {"events":[
#   {"id":"…","kind":"completed","actor":"<bob>","actorName":"Bob","entity":"task","entityId":"<task>","taskId":"<task>",
#    "taskTitle":"Milk","ts":1760090500000,"opIds":["…"],"changes":[{"field":"completed_at","from":null,"to":1760090500000}]},
#   {"id":"…","kind":"commented","actor":"<you>","actorName":"Alice","entity":"comment","entityId":"<comment>",
#    "taskId":"<task>","taskTitle":"Milk","ts":1760090000000,"opIds":["…","…"],"changes":[]}],
#  "more":true,"cursor":"1760090000000:…"}
```

Kinds: `created`, `completed`, `reopened`, `deleted`, `restored`, `rescheduled`, `assigned`, `unassigned`, `moved`, `archived`, `unarchived`, `edited`, `commented`, `comment_edited`, `comment_deleted`. A malformed `before` or a `limit` outside 1–200 answers `400 invalid_input`.

### Time entries

A time entry (OpenSpec `time-tracking`, see [the guide](time-tracking.md)) is one stretch of work on a task, stored in the operation log in the task's sharing scope like a comment. Every route needs authentication (`401 unauthorized`). Reads are open to every token scope; the writes refuse `read` and `agent` tokens with `403 insufficient_scope` before anything is written, so an AI assistant can report tracked time but never start or change it. A task or entry you cannot read answers `404 not_found`, exactly as an unknown id. Viewers of a shared project cannot track; only the author changes an entry (`403 forbidden`), and the author, project admins and the owner may delete it. Writes wake your devices like every REST write.

An entry is returned as `{id, taskId, userId, startedAt, endedAt, minutes, note, deviceId, taskTitle, projectId, projectName}`: Unix milliseconds, `endedAt` `null` while it runs, `minutes` whole minutes up to the server time for a running one. A user has one running entry: a start closes the running one at the new start in the same batch. `endedAt` before `startedAt` (on create or by a PATCH) is `400 invalid_input` naming both fields.

```sh
curl -sS -X POST "$OT/api/v1/time-entries" -H "Authorization: Bearer $TOKEN" -d '{"taskId":"<task>"}'
# 201 {"id":"…","taskId":"<task>","userId":"<you>","startedAt":1760950800000,"endedAt":null,"minutes":0,"note":"",…}

curl -sS -X POST "$OT/api/v1/time-entries" -H "Authorization: Bearer $TOKEN" \
  -d '{"taskId":"<task>","startedAt":1760950800000,"endedAt":1760954400000,"note":"review"}'
# 201 … "minutes":60, "note":"review"

curl -sS -X POST "$OT/api/v1/time-entries/stop" -H "Authorization: Bearer $TOKEN"
# 404 {"error":{"code":"not_found","message":"no time entry is running"}} when nothing runs

curl -sS "$OT/api/v1/time-entries?from=2026-10-12&to=2026-10-18&tz=Europe/Berlin&format=csv" -H "Authorization: Bearer $TOKEN" -o week.csv
```

`GET /api/v1/time-entries` parameters, all optional: `task` (a task id), `from` and `to` (local days `YYYY-MM-DD` in `tz`, an IANA zone, UTC by default, with your day start; an entry belongs to the day it started), `running=true`, `limit` (1–500, default 100) and `cursor` (the `nextCursor` of the previous page). A bad day, zone or cursor is `400 invalid_input` naming the parameter. The JSON answer is `{entries, nextCursor?, serverTime}`.

With `format=csv` the answer is a `text/csv` download, `time-entries-<from>-<to>.csv`, with an `X-Row-Count` header. It starts with a UTF-8 byte-order mark and has a header row: `date,start,end,minutes,task,project,labels,note`, then one column per custom field of the projects present (the union by name, in the projects' field order). One row per live entry of a live task, oldest first; times `HH:MM` in `tz`, labels joined by `;`, an empty `end` and minutes up to now for a running entry, RFC 4180 quoting, and a leading apostrophe on a text starting with `=`, `+`, `-` or `@` so a spreadsheet never runs it as a formula. An end-to-end encrypted title, name or note reads `[encrypted]`. The web app's Statistics export writes the same file from local data.

### Activity feed

`GET /api/v1/activity` (OpenSpec `activity-feed`) returns events from every shared project the caller is a member of, newest first, with the same shape and the same cursor as the per-project route plus `projectId` and `projectName`. Each project's events are derived exactly as `GET /api/v1/projects/{id}/activity` derives them, so an event has the same id in both. Personal projects and the Inbox never appear (their activity is in the project view), nor do projects you are not a member of, even when named in `project`.

Query parameters, all optional:

- `cursor` — the `cursor` of the previous page (`before` is accepted too); pages never overlap.
- `limit` — 1–200, default 50.
- `project` — a project id; a project you are not a member of yields no events.
- `actor` — an account id.
- `kind` — a feed category: `completed` (completed, reopened), `created`, `commented` (commented, comment_edited, comment_deleted), `assigned` (assigned, unassigned), `rescheduled`, `other` (every other kind).

```sh
curl -sS "$OT/api/v1/activity?kind=completed&limit=1" -H "Authorization: Bearer $TOKEN"
# 200 {"events":[
#   {"id":"…","kind":"completed","actor":"<bob>","actorName":"Bob","entity":"task","entityId":"<task>","taskId":"<task>",
#    "taskTitle":"Milk","projectId":"<project>","projectName":"Home","ts":1760090500000,"opIds":["…"],
#    "changes":[{"field":"completed_at","from":null,"to":1760090500000}]}],
#  "more":true,"cursor":"1760090500000:…"}

curl -sS "$OT/api/v1/activity?cursor=junk" -H "Authorization: Bearer $TOKEN"
# 400 {"error":{"code":"invalid_input","message":"cursor must be a cursor returned by this route"}}
```

Without credentials the route answers `401 unauthorized`; an unknown `kind`, a malformed cursor or a `limit` outside 1–200 answers `400 invalid_input`. What a user has already seen is not stored by this route: it is the `project_prefs.feed_seen_at` field in the user's personal scope, written through sync like any other op (see [sync](sync.md#project-preferences-and-the-activity-feed)). REST clients may write it with `POST /api/v1/sync` but have no collection route for it.

### Import

Import tasks and projects from the app's own export, CSV, or JSON exports of other task managers. Formats, the CSV columns, mapping rules and limits are documented in [import.md](import.md). Every imported field is written to the operation log with server time and the device id `import`, so devices receive imports like any other write.

Uploads are `multipart/form-data` with a `file` part. Options go either in one `options` part holding JSON or in individual fields of the same names: `format`, `targetProject`, `timeZone`, `sections` (`section`|`label`|`ignore`, default `section`), `duplicates` (`skip`|`import`), `errors` (`skip_rows`|`abort`), `existing` (`skip`|`overwrite`). The file may be at most `OPENTODO_IMPORT_MAX_MB` (default 20 MB) and 50,000 rows; these routes do not use the 4 MB JSON body limit.

**Preview** — `POST /api/v1/import/preview` writes nothing and returns:

```json
{
  "format": "csv",
  "columns": { "recognised": ["title", "project", "priority"], "ignored": ["color"] },
  "options": { "timeZone": "Europe/Rome", "sections": "section", "duplicates": "skip", "errors": "skip_rows", "existing": "skip" },
  "totals": { "rows": 100, "create": 97, "update": 0, "skip": 0, "error": 3, "possibleDuplicates": 0,
              "warnings": 1, "newProjects": 1, "newLabels": 2, "newSections": 2, "recurring": 4, "reminders": 3,
              "entities": 104, "written": 0, "ops": 0 },
  "rows": [
    { "row": 2, "sourceId": "…", "kind": "task", "title": "Write report", "project": "Work", "outcome": "create" },
    { "row": 35, "kind": "task", "title": "Task 34", "outcome": "error", "reason": "invalid priority \"urgent!\" (expected 1-4 or p1-p4)" },
    { "row": 40, "kind": "task", "title": "Call mom", "outcome": "skip", "reason": "possible_duplicate" },
    { "row": 41, "kind": "task", "title": "Standup", "outcome": "create", "warnings": ["recurrence \"every 3 hours\" not supported; imported without a rule"] }
  ],
  "truncated": false,
  "notes": []
}
```

`kind` is `project`, `task`, `label`, `section`, `field`, `reminder` or `view`. `outcome` is `create`, `update`, `skip` (reason `exists`, `unchanged`, `deleted`, `already_imported`, `possible_duplicate` or `no_project`) or `error` (with `reason`). `newSections`, `fields` (custom field definitions), `recurring` (tasks with a recurrence rule) and `reminders` count what the import adds; `notes` holds file-level remarks, such as the number of comments in an own export that are not imported. `row` is the line in a CSV file or the position in a JSON array; `version` is set for an own export. At most 5,000 rows are listed, those needing attention first (`truncated: true`); `totals` always counts every row.

**Start** — `POST /api/v1/import` takes the same upload, re-checks it and returns 202:

```json
{ "job": { "id": "…", "format": "csv", "status": "running", "options": { … }, "totals": { … },
           "errors": [{ "row": 35, "reason": "invalid priority \"urgent!\" (expected 1-4 or p1-p4)" }],
           "createdAt": 1760000000000, "finishedAt": null, "undoneAt": null } }
```

**Status** — `GET /api/v1/import/jobs/{id}` returns `{job}`; `status` is `running`, `done`, `failed` (with `message`, e.g. the first bad row under `abort`, or a restart) or `undone`. `totals.written` and `totals.ops` grow while the job runs. `GET /api/v1/import/jobs` lists `{jobs}` with at most 20 errors each.

**Undo** — `POST /api/v1/import/jobs/{id}/undo` soft-deletes every project, task, label, section, reminder and saved view the job created and returns the job with status `undone`. Calling it again is a no-op.

Errors: 400 `invalid_input` (unknown option value, unknown time zone, a `targetProject` that is not yours; no job is created), 400 `unsupported_format` (names the supported formats), 400 `invalid_file` (recognised but unreadable), 400 `bad_request` (not multipart or no `file` part), 413 `too_large` (file or row limit), 409 `conflict` (another import or undo of yours is running), 404 `not_found` (unknown job or another account's job).

```bash
curl -sS "$OT/api/v1/import/preview" -H "Authorization: Bearer $TOKEN" -F file=@tasks.csv -F timeZone=Europe/Rome
JOB=$(curl -sS "$OT/api/v1/import" -H "Authorization: Bearer $TOKEN" -F file=@tasks.csv -F timeZone=Europe/Rome | jq -r .job.id)
curl -sS "$OT/api/v1/import/jobs/$JOB" -H "Authorization: Bearer $TOKEN" | jq .job.status
curl -sS -X POST "$OT/api/v1/import/jobs/$JOB/undo" -H "Authorization: Bearer $TOKEN"
```

### Calendar feeds

Other calendars shown in Day and Week, and your tasks as a calendar that calendar apps subscribe to (OpenSpec `calendar-feeds`). Everything here answers `404 feeds_disabled` while the owner's switch is off, and `403 demo_restricted` on the public demo. Read and agent tokens may use the `GET` routes only (`403 insufficient_scope` otherwise).

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` / `PUT` | `/api/v1/settings/calendar-feeds` | signed in / owner | `{enabled}`; off by default, `OPENTODO_CALENDAR_FEEDS=true` presets it on first start; a change is recorded as `settings.changed` |
| `GET` | `/api/v1/calendar-feeds/subscriptions` | session or token | `{subscriptions: [...]}` with status: `name`, `color`, `enabled`, `eventCount`, `lastSuccessAt`, `lastError` (`timeout`, `http_404`, `too_large`, `invalid_calendar`, `private_target`, …), `stoppedReason`, `warnings` |
| `POST` | `/api/v1/calendar-feeds/subscriptions` | session or full token | `{url, name?, color?}`; `webcal://` is read as `https://`; the address must not be on a private network unless the owner allows private targets for webhooks (`400 private_target`); at most 10 per account (`400 limit_reached`); fetched once before answering `201 {subscription}` |
| `PATCH` | `/api/v1/calendar-feeds/subscriptions/{id}` | session or full token | `{url?, name?, color?, enabled?}`; a new URL is checked and fetched; `enabled: true` restarts a subscription stopped for a private target |
| `DELETE` | `/api/v1/calendar-feeds/subscriptions/{id}` | session or full token | `204`, its events go with it |
| `POST` | `/api/v1/calendar-feeds/subscriptions/{id}/refresh` | session or full token | fetch now, `200 {subscription}` |
| `GET` | `/api/v1/calendar-feeds/events?from=YYYY-MM-DD&to=YYYY-MM-DD` | session or token | at most 92 days; `{events: [{id, subscriptionId, uid, summary, location, start, end, allDay, free}], subscriptions: [{id, name, color, enabled, lastSuccessAt}]}`; `start` and `end` are shaped like a task's `due` (`{date, time?, tz?}`; no `tz` means floating) |
| `GET` | `/api/v1/calendar-feeds/feed` | session or token | `{feed: {createdAt, lastUsedAt} \| null}` |
| `POST` | `/api/v1/calendar-feeds/feed` | session or full token, fresh sign-in | create or replace the feed URL: `201 {feed, url}`, the only time the URL is shown; recorded as `calendar_feed.created` or `calendar_feed.rotated` |
| `DELETE` | `/api/v1/calendar-feeds/feed` | session or full token | `204`, `404` when there is none; recorded as `calendar_feed.revoked` |
| `GET` | `/feeds/{secret}/tasks.ics` | the secret in the path | `text/calendar` with one `VEVENT` per open task due from 30 days ago to a year ahead; `ETag`, `Cache-Control: private, max-age=900` |

Hand-triggered fetches (create, a new URL, refresh) are limited to 12 per account per hour (`429 rate_limited`). The feed answers `404` for an unknown secret, and an address that tries 10 unknown secrets in a minute gets `429`; one feed URL may be fetched 60 times an hour (`429` with `Retry-After`). The secret is no bearer token or app password, and other routes refuse it. Background refreshes follow the calendar's own refresh hint (between 30 minutes and a day, an hour by default), back off from 30 minutes to 6 hours while a calendar fails, and stop for a private target until the subscription is enabled again. A changed calendar sends `event: calendar` on the live updates stream.

### Issue connections

GitHub and GitLab issues assigned to the account become tasks that follow the issue (OpenSpec `issue-connections`; guide: [issue-import.md](issue-import.md)). Every `/api/v1/issues` route answers `404 issues_disabled` while the owner's switch is off, and these routes and the setting answer `403 demo_restricted` on the public demo before authentication. Read and agent tokens may use the `GET` routes only (`403 insufficient_scope` otherwise). Connections are server data: never operations, never synced or exported.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` / `PUT` | `/api/v1/settings/issues` | signed in / owner | `{enabled}`, the setting `integrations.issues`; off by default; a change is recorded as `settings.changed` |
| `GET` | `/api/v1/issues/connections` | session or token | `{connections: [...]}`: `id`, `provider` (`github`, `gitlab`), `host`, `name`, `project_id` (null for the Inbox), `filter` (`{scope: "assigned"\|"repositories", repositories, labels}`), `map_labels`, `enabled`, `interval_minutes`, `state` (`off`, `pending`, `ok`, `failed`, `stopped`), `next_poll_at`, `last_poll_at`, `last_success_at`, `last_error`, `last_error_at`, `stopped_reason`, `account_login`, `can_read_issues`, `last_run` (`{created, completed, reopened, renamed, unlinked, partial}`), `task_count`, `token_set`. Never the token. |
| `POST` | `/api/v1/issues/connections` | session or full token, fresh sign-in | `{provider, host, token, name?, project_id?, filter?, map_labels?, interval_minutes?, enabled?}`; the token is checked at once; `201 {connection}` |
| `PATCH` | `/api/v1/issues/connections/{id}` | session or full token | any of the fields above except `provider`; a `token` needs a fresh sign-in (`403 reauth_required`) and clears a stop for a token reason; `enabled: true` clears any stop |
| `DELETE` | `/api/v1/issues/connections/{id}` | session or full token | `204`; the token is removed, the tasks stay |
| `POST` | `/api/v1/issues/connections/{id}/test` | session or full token | ask the provider for the token's account: `{ok, login, can_read_issues, reason?, connection}` |
| `POST` | `/api/v1/issues/connections/{id}/sync` | session or full token | poll now: `{ok, run, reason?, connection}`; `409 connection_stopped`, `409 connection_disabled`, or `409 provider_rate_limited` before the provider's reset, all without a request to the provider |

Validation answers `400 invalid_input` with the field in `error.field` (`provider`, `host`, `token`, `name`, `project_id`, `scope`, `repositories`, `labels`, `interval_minutes`): the host is an `https` URL of at most 2,048 characters (`http` only while the owner allows private network targets), the name at most 100 characters (the host by default), the project an active one you can add tasks to, at most 20 repositories and 10 labels, the interval 15 to 1,440 minutes (30 by default). A host on a private network is refused with `400 private_target` unless the owner allows private targets for webhooks. A sixth connection answers `409 limit_reached`; an encrypted account `409 encryption_enabled` on create and on `enabled: true`. Tests and syncs share a limit of 12 per account per hour (`429 rate_limited`).

Polls run on the jobs leader, at most two at a time: conditional requests (`If-None-Match`) with an updated-since cursor, at most 10 pages of 100 issues per poll, a 20-second timeout and a 2 MB limit per answer, no redirects followed. Tasks and labels are written through the op log with device `issues:<connection-id>`. Reasons on a connection: `unauthorized_provider`, `token_missing`, `private_target` and `encrypted_account` stop it; `redirect_refused`, `too_large`, `timeout`, `connection_failed`, `invalid_response`, `provider_not_found` and a hosted tenant's `limit_*` double the wait up to 6 hours; `provider_rate_limited` waits for the provider's reset. Enabling end-to-end encryption stops the account's connections and `PUT /api/v1/encryption/keys` lists their names in `issueConnectionsStopped`.

### Notification channels

A person's delivery channels: ntfy, Pushover, Gotify, or a signed webhook (OpenSpec `notification-channels`; guide: [notification-channels.md](notification-channels.md)). Every `/api/v1/notification-channels` route answers `404 channels_disabled` while the owner's switch is off; these routes and the setting answer `403 demo_restricted` on the public demo. Channels are server data: never operations, never synced or exported, and their tokens, user keys and signing secrets live in `<data>/secrets/notification-channels.json` only.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` / `PUT` | `/api/v1/settings/notification-channels` | signed in / owner | `{enabled}`, the setting `notifications.channels`; on by default; a change is recorded as `settings.changed` |
| `GET` | `/api/v1/notification-channels` | session or token | `{channels: [...], kinds, events}`: `id`, `kind`, `name`, `url`, `topic`, `events`, `includeTitles`, `enabled`, `disabledReason` (`too_many_failures`), `lang`, `tokenSet`, `userKeySet` (Pushover), `secretSet` (webhook), `lastOkAt`, `lastError`, `failures`, `createdAt`, `updatedAt`. Never a secret |
| `POST` | `/api/v1/notification-channels` | session or full token | `{kind, name?, url?, topic?, token?, userKey?, events?, includeTitles?, enabled?, lang?, origin?}` → `201 {channel, secret?}`; `secret` is a webhook channel's signing secret, shown only here |
| `PATCH` | `/api/v1/notification-channels/{id}` | session or full token | any field above except `kind`; `token` and `userKey` replace the stored ones; `rotateSecret: true` gives a webhook channel a new signing secret, returned once as `secret`; `enabled: true` clears a stop and the failure count |
| `DELETE` | `/api/v1/notification-channels/{id}` | session or full token | `204`; its secrets and queued messages are removed |
| `POST` | `/api/v1/notification-channels/{id}/test` | session or full token | send "Test from OpenTodo" now: `{delivered, statusCode?, error?}`; at most 12 per account per hour (`429 rate_limited`) |
| `GET` | `/api/v1/notification-channels/{id}/deliveries` | session or token | `{deliveries: [{id, event, status, attempts, nextAttemptAt, lastStatusCode, lastError, createdAt, deliveredAt}]}`, newest first, at most 50; `status` is `pending`, `retry`, `delivered`, `failed` or `skipped` (`rate_limited`) |

Validation answers `400 invalid_input` with the field in `error.field`:

| Field | Rule |
|---|---|
| `kind` | `ntfy`, `pushover`, `gotify` or `webhook`; it can't be changed later |
| `name` | at most 60 characters; the kind's name by default |
| `url` | an http(s) address of at most 2,048 characters; ntfy defaults to `https://ntfy.sh`, Pushover has none |
| `topic` | ntfy only: 1 to 64 letters, digits, `-` or `_` |
| `token` | required for Gotify and Pushover (the application token) |
| `userKey` | Pushover only, required |
| `events` | a non-empty subset of `reminder`, `assigned`, `mentioned`, `unblocked`, `page` |

Other errors:
- An address on a private network answers `400 private_target`, unless the owner allows private network targets for webhooks.
- A sixth channel answers `409 limit_reached`.

`lang` (`en`, `de`, `fr`, `es`, `it`, `pt`) picks the language of the messages, and `origin` the address of the links in them. `OPENTODO_BASE_URL` wins over `origin` when set.

A webhook channel POSTs `{"version":1, "id", "event", "createdAt", "title", "message", "body", "url", "task":{"id","title"?}, "actor":{"name"}?, "page":{"id"}?}`:
- `body` equals `message`, so Apprise's API server reads it as is.
- `task.title` and `actor` appear only when the channel includes titles and the account is not encrypted.
- The headers are `X-OpenTodo-Event: notification.<event>`, `X-OpenTodo-Delivery`, `X-OpenTodo-Timestamp` and `X-OpenTodo-Signature`, with the webhooks' `v1=` signature.

Delivery and limits:
- Messages are sent by one worker on the jobs leader, with a 10-second timeout each and no redirects followed.
- Failures are retried on the webhooks' schedule (about 27 hours), and 20 failed messages in a row turn a channel off.
- An account queues at most 60 messages per hour across its channels; more are logged as `skipped` and not sent.

### CalDAV and app passwords

The CalDAV endpoint itself (`/dav/`, `/.well-known/caldav`) speaks WebDAV/CalDAV, not this JSON API; see [caldav.md](caldav.md). It authenticates only with HTTP Basic (account email plus an app password). These JSON routes manage it; all require a session or token.

| Method | Path | Who | Body / result |
| --- | --- | --- | --- |
| `GET` | `/api/v1/app-passwords` | any user | `{"appPasswords":[{"id","name","createdAt","lastUsedAt","revokedAt"}]}`, newest first, revoked ones included; `lastUsedAt` is updated at most once a minute. Never the secret. |
| `POST` | `/api/v1/app-passwords` | any user, recent sign-in (`403 reauth_required` otherwise, like token creation) | `{"name":"iPhone"}` → `201 {"appPassword":{…},"secret":"otap_…"}`. The secret is shown only here. |
| `DELETE` | `/api/v1/app-passwords/{id}` | owner of the app password | `204`; `404 not_found` for an unknown, foreign or already revoked id. |
| `GET` | `/api/v1/settings/caldav` | any user | `{"enabled":false,"url":"https://todo.example.com/dav/","secure":true}`; `url` is what calendar apps are configured with, `secure` is false for plain http. |
| `PUT` | `/api/v1/settings/caldav` | owner | `{"enabled":true}` → the same shape. `400 invalid_input` without a boolean `enabled`, `403 forbidden` for members. Recorded as `settings.changed` (`caldav.enabled`). |

App passwords are refused by every `/api/v1` route, and API tokens, passwords and session cookies are refused by `/dav/`. Creating and revoking one records `app_password.created` / `app_password.revoked` in the audit log.

### Email to task

Each account can have a secret inbox address; mail sent to it becomes an Inbox task (see [email.md](email.md)). The feature exists only when the operator configured a mailbox with `OPENTODO_EMAIL_*`. All routes require a session or API token and act on the caller's account. No response ever contains the operator's mail server, mailbox user or password.

| Method | Path | Who | Body / result |
| --- | --- | --- | --- |
| `GET` | `/api/v1/email-inbox` | any user | `{"enabledByOperator":true,"address":"todo+k3f9…@example.com","enabled":true,"allowlist":[],"hourlyLimit":60}`. The first call creates the address (enabled). With no operator configuration: `{"enabledByOperator":false,"address":null,"enabled":false,"allowlist":[],"hourlyLimit":60}` and nothing is created. |
| `PATCH` | `/api/v1/email-inbox` | any user | `{"enabled":false}` and/or `{"allowlist":["me@example.org"]}` → the same shape. `allowlist` must be an array of at most 50 bare email addresses (stored lowercased, duplicates dropped; `[]` clears it), otherwise `400 invalid_input` and nothing changes. `409 email_disabled` when the operator has not configured email capture. |
| `POST` | `/api/v1/email-inbox/rotate` | any user | → the same shape with a new address; the old one stops working at once. `409 email_disabled` as above. |

Changes and rotations are limited to 30 per account per hour (`429 rate_limited`). They are recorded as `email_inbox.created`, `email_inbox.rotated` and `email_inbox.updated` in the audit log.

```sh
curl -s -H "Authorization: Bearer $TOKEN" https://todo.example.com/api/v1/email-inbox
# 200 {"enabledByOperator":true,"address":"todo+k3f9…@example.com","enabled":true,"allowlist":[],"hourlyLimit":60}
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"allowlist":["Me@Example.org"]}' https://todo.example.com/api/v1/email-inbox
# 200 {..., "allowlist":["me@example.org"], ...}
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"allowlist":"me@example.org"}' https://todo.example.com/api/v1/email-inbox
# 400 {"error":{"code":"invalid_input","message":"allowlist: allowlist must be a list of at most 50 email addresses"}}
```

Tasks created from mail are ordinary operations with the server's device `server:<boot id>` (title, description, priority 4, created_at, position; no project, no due date), so they arrive through `POST /api/v1/sync` like any other change.

### Webhooks

Outbound webhooks notify a URL you choose when your tasks and projects change. Event list, payload format, signature verification, retries and receiver recipes are in [docs/webhooks.md](webhooks.md); this section covers the management routes. Every route requires authentication and only ever sees the caller's own webhooks: another account's webhook id answers 404 `not_found`. Webhooks are server configuration: they never go through the op log, never sync and are not in the export.

**Create** — `POST /api/v1/webhooks`:

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string | `http://` or `https://`, at most 2,048 characters |
| `events` | string[] | non-empty subset of `task.created`, `task.updated`, `task.completed`, `task.reopened`, `task.deleted`, `project.created`, `project.updated`, `project.archived`, `project.deleted`, `import.completed`, `import.undone` |
| `projectId` | string or null | only events for this project (tasks in it, or the project itself) |
| `enabled` | boolean | default `true` |

```bash
curl -sS "$OT/api/v1/webhooks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://n8n.example.com/webhook/opentodo","events":["task.completed","task.created"]}'
```

Response (201):

```json
{
  "webhook": {
    "id": "…", "url": "https://n8n.example.com/webhook/opentodo", "events": ["task.created", "task.completed"],
    "projectId": null, "enabled": true, "disabledReason": null, "consecutiveFailures": 0,
    "createdAt": 1760000000000, "updatedAt": 1760000000000,
    "secret": "whsec_…"
  }
}
```

`secret` appears only in this response; store it in the receiver to verify signatures. Errors: 400 `invalid_input` naming the field (`url: url scheme must be http or https`, `events: unknown event "task.exploded"`, `events: choose at least one event`), 400 `private_target` when the host resolves only to loopback, private, link-local or other internal addresses and the owner has not allowed private targets, 409 `limit_reached` beyond 20 webhooks per account.

**Update** — `PATCH /api/v1/webhooks/{id}` with any of the fields above (`projectId: null` removes the filter). Changing `url` re-runs the private-target check. Setting `enabled: true` on a webhook the server disabled clears `disabledReason` and the failure counter.

**Read and delete** — `GET /api/v1/webhooks`, `GET /api/v1/webhooks/{id}`, `DELETE /api/v1/webhooks/{id}` (204, also deletes its delivery log and queue). `disabledReason` is `null`, or `too_many_failures` after 20 consecutive failed deliveries.

**Test** — `POST /api/v1/webhooks/{id}/test` sends a `ping` immediately (one attempt) and answers 200 `{ok, delivery}` whether or not the receiver accepted it; `ok` is true for a `2xx` answer.

**Delivery log** — `GET /api/v1/webhooks/{id}/deliveries` → `{deliveries: [...]}`, newest first, at most 100, entries older than 30 days pruned:

```json
{
  "id": "…", "webhookId": "…", "event": "task.completed", "status": "retry", "attempts": 1,
  "nextAttemptAt": 1760000030000, "statusCode": 503, "error": "HTTP 503", "responseExcerpt": "Service Unavailable",
  "durationMs": 41, "createdAt": 1760000000000, "deliveredAt": null
}
```

`status` is `pending`, `retry`, `delivered` or `failed`; `error` is `HTTP <code>`, `timeout`, `connection failed: …` or `private_target`; `responseExcerpt` holds the first kilobyte of the response body.

**Redeliver** — `POST /api/v1/webhooks/{id}/deliveries/{did}/redeliver` queues the same body under a new delivery id → 202 `{delivery}`. A delivery id that does not belong to that webhook answers 404 `not_found`.

**Owner policy** — `GET`/`PUT /api/v1/settings/webhooks` with `{"allowPrivate": true|false}` allows targets on private networks (Home Assistant or n8n on the LAN) for every account. Owner only: members get 403 `forbidden`. The optional `OPENTODO_WEBHOOKS_ALLOW_PRIVATE` environment variable presets it on the first start.

### End-to-end encryption

Optional per-account encryption of task content ([e2ee.md](e2ee.md) has the threat model). The server stores only the key record the browser produced and never decrypts. For an encrypted account, the content fields of personal data — task `title`, `description`, `ical_extra`, `notes_doc`, `origin` (the whole object as one ciphertext string); project, label and section `name`; view `name` and `query`; comment `body` — hold ciphertext strings in every REST read, the export and `/api/v1/sync`:

```
"enc:v1:" + base64url(nonce(12) || AES-256-GCM(utf8(plaintext)) || tag(16))
additional authenticated data = utf8(entity + "\0" + entityId + "\0" + field)
```

All other fields (`due`, `priority`, `completed_at`, `project_id`, `labels`, …) stay plaintext. Plaintext REST writes are accepted for an encrypted account; the next unlocked device re-writes them as ciphertext.

```sh
# Create the key record (version 1). Only wrapped keys and parameters: salt 16 bytes,
# wrapped keys 40 bytes each (AES-KW of a 256-bit key), base64url without padding.
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"version":1,"kdf":1,"salt":"AQEBAQEBAQEBAQEBAQEBAQ","iterations":600000,"wrappedByPassphrase":"…","wrappedByRecovery":"…"}' \
  https://todo.example.com/api/v1/encryption/keys
# 201 {"keys":{"version":1,"kdf":1,"salt":"…","iterations":600000,"wrappedByPassphrase":"…","wrappedByRecovery":"…","createdAt":1760000000000,"updatedAt":1760000000000}}
# again with version 1 (another device was first):
# 409 {"error":{"code":"encryption_conflict","message":"the encryption key record was created or changed by another device; unlock with the existing passphrase"}}
# a malformed record (for example 1000 iterations):
# 400 {"error":{"code":"invalid_input","message":"iterations must be between 600000 and 10000000"}}

# A REST read of an encrypted task: ciphertext title, plaintext due date
curl -H "Authorization: Bearer $TOKEN" https://todo.example.com/api/v1/tasks/<id>
# 200 {"id":"…","title":"enc:v1:oKGio6Slpqeoqaqron0SWSy4dh8xioWkMvJuPN5GjNypnM8","due":{"date":"2026-10-11"},"priority":1,…}

# Delete superseded content operations (plaintext history) for your account
curl -X POST -H "Authorization: Bearer $TOKEN" https://todo.example.com/api/v1/encryption/purge-history
# 200 {"purged":3,"notice":"Superseded content operations were deleted from the server. Backups made before this point, …"}
# without a key record: 409 {"error":{"code":"encryption_disabled",…}}
```

Replacing the record (passphrase change, recovery reset) and `DELETE` need a fresh re-authentication on cookie sessions (403 `reauth_required`). `GET /api/v1/me` and `GET /api/v1/auth/status` carry `"encryption":{"enabled":true,"keyVersion":2}` and `"minClientVersion":1`. The export adds `"encryption"`: the key record, or `null`. Refused for encrypted accounts with 409 `encryption_enabled`: the first share of a project (`POST /api/v1/projects/{id}/members` on an unshared project) and `POST /api/v1/app-passwords`; `/dav/` answers 403. `GET /api/v1/settings/caldav` adds `"encryption": true|false` for the caller.

### Device relay

For an account with end-to-end encryption, a device the user opted in answers the decrypt and encrypt steps of [MCP tool calls](mcp.md#encrypted-accounts) (OpenSpec `mcp-device-relay`). The server never holds the key; relayed text exists only in memory during the call and is never stored, logged or audited. Session cookies only (no API tokens); every route is refused on a demo instance.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/relay/devices` | `{devices: [{deviceId, label, enabledAt, online, thisSession}]}` |
| PUT | `/api/v1/relay/devices/{device}` | `{label}` → 204. Needs a recently confirmed session; binds the opt-in to this session. 409 `not_encrypted` without encryption, 409 `mcp_disabled` while the owner has MCP off. Recorded as `relay.enabled` |
| DELETE | `/api/v1/relay/devices/{device}?reason=user\|locked` | → 204; ends the device's stream. Recorded as `relay.disabled`. Signing out the session that opted in and turning encryption off also end it |
| GET | `/api/v1/relay/events?device=&key=` | Server-sent events for the opted-in device of this session only (403 `not_opted_in` otherwise). `key` is the device's ephemeral ECDH P-256 public key (uncompressed, base64url). The first event, `hello`, carries `{stream, key}`: the stream id and the server's key. Both sides derive an AES-256-GCM key with HKDF-SHA-256 (salt = stream id, info `opentodo relay v1`). Each `request` event is `{id, box}`: `box` is base64url(nonce ‖ AES-GCM of `{op, items, call, deadline}`) with `id` as associated data |
| POST | `/api/v1/relay/answers/{id}` | `{box}` sealed the same way, holding `{results: [{value} or {error}]}` or `{error: "device_limit"\|"declined_on_device"\|"locked"}` → 204; any other session, a second answer or a box that does not open → 404 `not_found` |

Limits: 60 relayed calls a minute and 4 at once per account, 2,000 values and 2 MB per request, deadlines of 20 s (reads) and 30 s (writes). The MCP tool errors are listed under [relay errors](mcp.md#encrypted-accounts).

### In-app assistant

The [in-app assistant](assistant.md) (OpenSpec `in-app-assistant`). Every route requires authentication. Settings, consent and usage are server state, never ops; conversations exist only on the device. Keys are write-only: no route ever returns one.

**Owner settings** — `GET /api/v1/settings/assistant` returns, for the owner:

```json
{
  "enabled": true, "active": true, "default_provider": "anthropic",
  "providers": {
    "anthropic":  {"enabled": true,  "model": "claude-opus-5-5", "key_set": true,  "label": "Anthropic (Claude)"},
    "openai":     {"enabled": false, "model": "",                "key_set": false, "label": "OpenAI"},
    "gemini":     {"enabled": false, "model": "",                "key_set": false, "label": "Google Gemini"},
    "compatible": {"enabled": false, "model": "", "base_url": "", "key_set": false, "label": "…"}
  },
  "allow_member_keys": false, "monthly_token_cap_per_user": 500000, "allow_private_endpoint": false,
  "cap_member_keys": false, "member_providers": ["anthropic", "openai", "gemini"], "own_key_members": 0,
  "anthropic_models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "default_model": "claude-opus-5-5"
}
```

`cap_member_keys` (default `false`): whether turns on a member's own key count toward `monthly_token_cap_per_user`; off, they are recorded but neither counted nor blocked. `member_providers` lists what members may choose for their own key (never `compatible`); `own_key_members` counts accounts whose turns use their own provider and key right now.

Members get a status without keys or base URL: `{enabled, provider, provider_label, model, allow_member_keys, monthly_token_cap_per_user, cap_member_keys}`. `PUT` (owner only, 403 `forbidden` otherwise; a session or an `admin` token, since it holds provider keys) takes the same fields (a provider object replaces that provider's settings) plus `keys`: `{"anthropic": "sk-…"}` sets a key, `""` removes it, an absent provider keeps it. Unknown fields are refused. Errors: 400 `invalid_input` naming the field (an unknown provider, a provider enabled without a model, a hosted provider without a key while member keys are off, the compatible provider without a valid `http(s)` base URL or with credentials in it, a disabled default provider, a negative cap); 400 `private_target` when the base URL resolves only to private, loopback, link-local or metadata addresses and `allow_private_endpoint` is off. A refused request changes nothing. Every changed value is audited as `settings.changed` (`assistant.<field>`; keys as `assistant.<provider>.key` from `unset` to `set` or back, never the value; a base URL by scheme and host only).

```bash
curl -sS -X PUT "$OT/api/v1/settings/assistant" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"default_provider":"compatible","allow_private_endpoint":true,
       "providers":{"compatible":{"enabled":true,"model":"llama3.1","base_url":"http://192.168.1.20:11434/v1"}}}'
```

**Test connection** — `POST /api/v1/settings/assistant/test` with `{"provider":"compatible"}` (owner only) sends one minimal request with one tool and answers 200 `{ok, code?, message, status?}`. It tests the values on screen: the optional `model`, `base_url`, `key` and `allow_private_endpoint` fields are used as given, and absent ones fall back to the saved settings (`key` absent uses the saved key, `""` means no key). The values pass the same checks as a save first (400 `invalid_input` naming the field, before any request); nothing is saved, audited or logged. `code` is `no_tool_support` when the endpoint refuses tool definitions but answers without them, `no_key`, `private_target`, `provider_auth`, `provider_rate_limited` or `provider_error`.

**Your consent, provider and key** — `GET /api/v1/me/assistant`:

```json
{
  "available": true, "enabled": true, "reason": "",
  "provider": "openai", "provider_label": "OpenAI", "model": "gpt-4.1-mini",
  "source": "own", "own_key_in_use": true,
  "server_provider": "anthropic", "server_provider_label": "Anthropic (Claude)", "server_model": "claude-opus-5-5",
  "consented": true, "consent": {"accepted_at": 1760000000000, "disclosure_version": 1, "provider": "openai"},
  "disclosure_version": 1, "fields": ["task titles and descriptions", "…"],
  "allow_member_keys": true, "own_key_set": true, "server_own_key_set": false, "operator_key_set": true,
  "own_provider": {"provider": "openai", "provider_label": "OpenAI", "model": "gpt-4.1-mini", "key_set": true},
  "member_providers": ["anthropic", "openai", "gemini"], "anthropic_models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  "cap_member_keys": false
}
```

`provider`, `provider_label` and `model` name what your turns use now: your own provider (`source: "own"`) while the owner allows member keys and your key for it is set, otherwise the owner's (`source: "server"`, the same as `server_provider`). `own_key_in_use` is true when your turns run on your own key, which includes a key you stored for the owner's provider. `own_provider` is your choice (`null` for the server's assistant); it is kept while the owner does not allow member keys, but not used. `own_key_set` and `server_own_key_set` say whether you stored a key for `provider` and for the owner's provider. `reason` is `disabled`, `no_provider` or `encryption_enabled` when `available` is false. `consented` is true only for the current disclosure version and `provider`, so switching providers asks again.

`PUT /api/v1/me/assistant` (sessions and full tokens) takes:

- `{"consent": true, "provider": "<the provider the disclosure named>"}`, or `{"consent": false}` to withdraw;
- `{"own_provider": "openai", "own_model": "gpt-4.1-mini", "own_key": "sk-…"}` to use your own provider: `anthropic`, `openai` or `gemini` (never `compatible`, and no base URL). Anthropic models must be one of `anthropic_models`; OpenAI and Gemini model ids are 1–100 characters of `A-Z a-z 0-9 . _ : -`. A key is required unless you already stored one for that provider. `own_model` alone changes the model of your provider;
- `{"own_provider": ""}` to go back to the server's assistant (the key you stored for the provider you had chosen is deleted);
- `{"own_key": "…"}`: sets the key of your own provider, or of the owner's provider when you have none (as before); `""` removes it (removing your own provider's key also goes back to the server's assistant).

Choosing a provider or storing a key needs the owner's "Let members bring their own key" (403 `forbidden` otherwise); removing either never does. Leaving a provider you chose deletes its key. Audited as `settings.changed`: `assistant.own_provider` (`server` or the provider name), `assistant.own_model`, `assistant.own_key.<provider>` (`unset`/`set`, never the key). Errors: 400 `invalid_input` naming `own_provider`, `own_model` or `own_key`; 409 `provider_changed` when `provider` is not the one in effect after the request, 409 `encryption_enabled`, 409 `assistant_disabled`. A refused request stores nothing. Deleting an account deletes its keys and choice.

**On-device assistant for encrypted accounts** (OpenSpec `in-app-assistant`, change `assistant-on-device`). The owner's settings carry `"device": {"enabled": false, "providers": [], "origins": []}`: `providers` among `anthropic`, `openai`, `gemini`, `compatible`; `origins` at most 10 model server origins, each `https://host[:port]` or `http://` with `localhost`, `127.0.0.1` or `[::1]` (400 `invalid_input` naming `device.providers` or `device.origins` otherwise; `compatible` needs an origin). It needs `enabled` but no server provider. The owner's view also lists `device_origins`, the API origin of each built-in provider. While it is on, the page's `Content-Security-Policy` `connect-src` lists `'self'`, the allowed providers' API origins and `origins`; otherwise `'self'` only (always on a demo instance). For an encrypted account, `GET /api/v1/me/assistant` then reports `available: true`, `mode: "device"` and `"device": {"available": true, "providers": [...], "origins": [...], "consented_provider": "anthropic", "anthropic_models": [...], "default_model": "claude-opus-5-5"}` (`mode` is `server` for a turn on the server, `""` while unavailable; `device` is present for every encrypted account). Consent is `PUT /api/v1/me/assistant {"consent": true, "provider": "device:anthropic"}`: only for an encrypted account and an allowed provider (403 `forbidden` otherwise), with no other field (400). The server never runs such a turn (`POST /api/v1/assistant/turn` still answers 409 `encryption_enabled`), never sees the device's key, model or base URL, and records no usage for it.

**Test your own provider** — `POST /api/v1/me/assistant/test` (optional body `{provider?, model?, key?}`; **signed-in sessions only**) sends one minimal request with one tool to the provider, model and key on screen, falling back to your saved choice for absent fields (a saved key is used only for the provider it was saved for), without saving anything and answers 200 `{ok, code?, message, status?}` like the owner's test (`provider_auth` says your key was rejected). Errors: 403 `session_required` for API tokens, 409 `assistant_disabled`, 403 `forbidden` while member keys are not allowed, 400 `invalid_input` when no provider is chosen or the provider or model is not allowed, 429 `rate_limited` with `Retry-After` after 5 tests in 10 minutes.

**Usage** — `GET /api/v1/me/assistant/usage` → `{month, input_tokens, output_tokens, total_tokens, turns, cap, resets_at, counted_tokens, cap_member_keys, own_key: {input_tokens, output_tokens, total_tokens, turns}}` for the current UTC month, counted from the provider's usage fields. `total_tokens` counts every turn, `own_key` the turns on your own key, and `counted_tokens` what is measured against `cap` (everything but `own_key` unless `cap_member_keys` is on).

**Skills** — `GET /api/v1/assistant/skills` → `{"skills": [{"id": "plan-week", "name": "Plan my week", "description": "…", "example": "…", "result": "changes"}]}`: the built-in skills `idea-to-project`, `plan-week`, `weekly-review`, `triage-inbox` and `break-down`, or an empty list when the assistant is not available to you (off, or an encrypted account). Ids are only ever added. Each turn that runs a skill is counted per month in `assistant_skill_usage`.

**A turn** — `POST /api/v1/assistant/turn`, **signed-in sessions only**:

```json
{"messages": [{"role": "user", "text": "move everything overdue to Friday"}], "timezone": "Europe/Rome", "view": "today", "selected": []}
```

`messages` is the device's conversation (at most 40, the last from the user; the whole body at most 256 KB); `timezone` is an IANA zone; `view` and `selected` are optional context. Optional (assistant skills): `skill`, a skill id from `GET /api/v1/assistant/skills`; `workday` `{startHour, endHour, dayLength}` (hours 0–24 with start before end, `dayLength` 15–1440 minutes), used by `plan-week`; and `"untrusted": true` on a user message that holds pasted text, which the server wraps as untrusted data and joins to the question (it cannot be the last message). Checks, in order, before any provider request: 404 `not_found` while the assistant is off; 403 `session_required` for API tokens; 409 `encryption_enabled`; 403 `consent_required`; 413 `too_large`; 400 `invalid_input`; 400 `unknown_skill`; 429 `assistant_quota` (with `resets_at`; not for a turn on your own key unless the owner turned on `cap_member_keys`); 409 `turn_in_progress` (one turn per person); 503 `assistant_busy` with `Retry-After` (8 turns server-wide); 409 `no_key`. Cookie requests from another origin get 403 `bad_origin`.

The answer is a `text/event-stream`:

```
event: status
data: {"text":"Looking at Today…"}

event: text
data: {"text":"I've proposed moving 12 tasks to Friday. "}

event: usage
data: {"input":2700,"output":360,"month_total":18240,"cap":500000,"own_key":false}

event: changeset
data: {"items":[{"entity":"task","entityId":"…","patch":{"due":{"date":"2026-10-16"}},"base":{"due":{"date":"2026-10-09"}},"shared":false}],"limit":50}

event: done
data: {"stop_reason":"end_turn","server_time":"2026-10-12T10:00:00Z"}
```

In `usage`, `month_total` is what counts toward the cap and `cap` is `0` for a turn the cap does not apply to (your own key while `cap_member_keys` is off); `own_key` marks a turn on your own key.

`changeset` comes at most once, only after `end_turn`, with at most 50 entities: `patch` is what to write, `base` the values it was planned on (for "changed since proposed"), `create` marks new entities, `shared` marks shared projects. The server never applies it: the app applies the confirmed part as ordinary ops with device `assistant:<device-id>`, which `/api/v1/sync` accepts and history labels "Assistant". `done.stop_reason` is `end_turn`, `max_tokens` (with a `message`; no change set), `refusal` (`message`: "The model declined this request."; no change set) or `round_limit` (more than 8 model calls). A failure ends the stream with `event: error` and `{code, message}`: `provider_auth`, `provider_rate_limited`, `provider_error` or `timeout`; never a key. Usage is recorded whatever the outcome.

### Hosted servers

A tenant of a host (see [host mode](self-hosting/host-mode.md)) answers like any server, with these differences. `GET /api/v1/auth/status` adds `"hosted": true`. Settings that belong to the operator answer `403 host_managed` before authentication: `/api/v1/settings/smtp*`, `/api/v1/settings/oidc*` and `/api/v1/backups*` for every method, and writes to `/api/v1/settings/mcp`, `/api/v1/settings/assistant*`, `/api/v1/settings/webhooks` and `/api/v1/settings/attachments`.

`GET /api/v1/export/archive` (owner, a session or an `admin` token, since the archive holds every account's credentials; a stale session gets `403 reauth_required`, a `full` token `403 insufficient_scope`) streams the whole server as a backup archive (`application/gzip`, the format `opentodo restore` reads) and records `export.requested` with format `archive`. Read and agent tokens get `403 insufficient_scope`. The route does not exist on a self-hosted server.

A tenant's limits refuse changes one at a time. On `/api/v1/sync` a refused op appears in `rejected` with reason `limit_storage`, `limit_ops_hour` or `limit_ops_total`; the rest of the batch is applied, and the server does not send its own value back for it, so the device keeps the change and sends it again later. A REST write answers `403` with the reason as code.

## Automation rules

Rules (OpenSpec `automation-rules`; guide: [automations.md](automations.md)) are the synced entity `rule`, personal like a label: `name` (content, encrypted for an encrypted account), `enabled`, `trigger`, `condition`, `actions` (each one whole value), `position`, `created_at`, `deleted_at`. Devices write them through `/api/v1/sync`; the REST routes below add id checks. The server runs them; their state (run log, watermarks, pauses) is server data, never operations. Every route answers `403 demo_restricted` on the public demo.

| Method | Path | Auth | Body / answer |
|---|---|---|---|
| `GET` | `/api/v1/rules` | signed in | `{rules: [...]}` |
| `POST` | `/api/v1/rules` | signed in, write | `{name, trigger, condition?, actions, enabled?}` → `201`; ids are resolved (live labels, projects, sections of that project, your webhooks), a project action into a shared project is refused (`400 invalid_input`), a `comment` action on an encrypted account answers `409 encryption_enabled`, a 51st rule `409 limit_reached` |
| `GET` / `PATCH` / `DELETE` | `/api/v1/rules/{id}` | signed in (writes: write) | like every collection |
| `GET` | `/api/v1/rules/{id}/runs` | signed in | `{runs: [...]}`, newest first, at most 100: `id`, `rule_id`, `occurrence` (the run key), `task_id`, `at`, `outcome` (`pending`, `applied`, `already_matched`, `skipped`, `stopped`, `failed`, `partial`), `reason`, `changes` (`[{task_id, fields}]`), `depth`; another account's rule answers `404 not_found` |
| `POST` | `/api/v1/rules/{id}/test` | signed in, write | `{task_id}` → `{matches, changes, skipped}`: the condition and the planned changes on one task now; nothing is written |
| `GET` | `/api/v1/me/rules` | signed in | `{enabled, paused, rules: {id: {last_run, runs_7d, paused_reason}}}` |
| `PUT` | `/api/v1/me/rules/paused` | signed in, write | `{paused}` → `{enabled, paused}`: pause or resume all your rules |
| `GET` / `PUT` | `/api/v1/settings/automations` | owner | `{enabled}` → `{enabled, locked, locked_by}`; `409 set_by_environment` while `OPENTODO_AUTOMATIONS` is set; a change is recorded as `settings.changed` (`automations.enabled`) |

`trigger` is `{kind}` with `kind` one of `task.created`, `task.completed`, `task.reopened`, `label.added` and `label.removed` (with `label_id`), `assigned.to_me`, `task.moved` (`project_id`, optional `section_id`), `due.reached`, `overdue`, `schedule` (`at` `HH:MM`, `weekdays` 1 Monday to 7 Sunday). `condition` is `null` or an object of predicates: `project` (`{in, descendants?}` or `"none"`), `section`, `labels` (`{any?, all?, none?}`), `priority` (`{in}`), `due` and `deadline` (`"none"`, `"set"`, `"today"`, `"overdue"`, `{within_days}`), `start`, `evening`, `blocked`, `assignee` (`"me"`, `"none"`, `"anyone"`), `origin`, `habit`, `estimate`, `tracked`. `actions` holds the on-drop keys of a board column plus `due: {in_days}`, `deadline` (`{in_days}` or `"clear"`), `assignee` (`"me"`, `"clear"`), `comment: {text}`, `notify: true`, `webhook: {webhook_id}`. Lists hold at most 32 ids; days are 0 to 365.

A rule's batch is written with device `rule:<rule-id>` (reserved: `/api/v1/sync` refuses it from devices) and the author as actor; the history labels it `Rule (<name>)` for its author. Limits: 60 runs a minute and 2,000 a day per account, 500 tasks per run; a rule refused three times in an hour by the per-minute limit is paused (`paused_reason: "runaway"`) until it is turned on again.

## Task pages

One task published as a page people without an account open at `/t/<secret>[/<label>]` (OpenSpec `task-pages`). The secret is 22 characters (128 bits), stored as a hash; the label is decoration and never used to find the page. A task has at most one active page; publishing again revokes the previous one in the same request. Pages are server data, never ops.

**Publish** — `POST /api/v1/tasks/{id}/page` with `{"rights": "reply", "label": "paint-the-fence", "expiresInDays": 30}`: `rights` is `view`, `reply` or `tick` (tick includes replying), `label` 1–40 lowercase letters, digits and hyphens, `expiresInDays` 1–90 or absent, `includeMap` (default true). For a task of an end-to-end encrypted personal scope the body must also carry `snapshot` (the page encrypted with a per-page share key, at most 256 KB) and `wrappedKey` (that key encrypted with the account key); the device appends the share key to the link after `#`, which browsers never send. A subtask answers 400; an editor or viewer 403 `forbidden`; a stranger 404; an account with 100 active pages 409 `limit_reached`; 20 publishes an hour per account, then 429.

**The page** — `GET /api/v1/pages/{secret}` needs no authentication, ignores a session cookie and sets none. A live page returns `id`, `title`, `description`, `due`, `deadline`, `completed_at`, `subtasks` (three levels, with `depth`), `links`, `files`, `location` (when `includeMap` is set and maps are on) and the `comments` written since publishing (`name`, `guest`, `body`, `createdAt`); never labels, the project, notes, the assignee, emails or account ids. An encrypted page returns `snapshot` and `snapshotAt`. Every unusable page (unknown, revoked, expired, its task deleted, the publisher deactivated or no longer allowed, an encrypted page without a snapshot) answers the same 404 `page_invalid`.

**Guests** — replies (`{name, body}`, 1–40 and 1–4000 characters) become comments by the publisher from the device `page:<page-id>` with `guest_name` and `page_id`; on an encrypted page they are `{ciphertext}` (16 KB at most) kept until a device imports and confirms them. Ticks complete or reopen the task or a subtask; reopening only within 24 hours. Limits per page: 120 reads and 60 ticks a minute, 20 replies an hour; 120 requests a minute per address; unknown secrets count against the address's sign-in limit. Responses carry `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and the request log redacts the secret.

## Examples

Create a task due tomorrow at 9:00 in a project:

```bash
curl -sS "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Call the plumber","priority":2,"project_id":"<project-id>","due":{"date":"2026-10-11","time":"09:00"}}'
```

A stand-up fixed to Berlin time (devices elsewhere show it converted to their zone, with `09:00 Berlin` as a hint):

```bash
curl -sS "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Stand-up","due":{"date":"2026-10-11","time":"09:00","tz":"Europe/Berlin"}}'
# 201 {..., "due":{"date":"2026-10-11","time":"09:00","tz":"Europe/Berlin"}, ...}
curl -sS -X PATCH "$OT/api/v1/tasks/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"due":{"date":"2026-10-11","tz":"Europe/Berlin"}}'
# 400 {"error":{"code":"invalid_input","message":"invalid op: task.due tz requires time"}}
```

Complete it:

```bash
curl -sS -X PATCH "$OT/api/v1/tasks/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"completed_at\": $(date +%s000)}"
```

List open tasks in the Inbox with `jq`:

```bash
curl -sS "$OT/api/v1/tasks" -H "Authorization: Bearer $TOKEN" | jq '.tasks[] | select(.project_id == null and .completed_at == null) | .title'
```

Create a label, then tag a task with it:

```bash
LABEL=$(curl -sS "$OT/api/v1/labels" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"errand"}' | jq -r .id)
curl -sS -X PATCH "$OT/api/v1/tasks/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"labels\":[\"$LABEL\"]}"
```

A `labels` value containing an id that is not an existing, non-deleted label is rejected with 400 `invalid_input` and the task is unchanged.

Rename a label (one request, no task is touched):

```bash
curl -sS -X PATCH "$OT/api/v1/labels/$LABEL" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"errands"}'
```

Save a view and pin it (the response carries `id`, `position` and the default grouping and sort; devices show it after their next sync):

```bash
curl -sS "$OT/api/v1/views" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Waiting","query":"@waiting","pinned":true}'
# 201 {"color":"#64748b","created_at":1760090000000,"group_by":"project","id":"…","kind":"list","name":"Waiting",
#      "on_drop":null,"panels":[],"pinned":true,"position":1760090000000,"query":"@waiting","sort_by":"due","sort_dir":"asc"}
```

Give it an on-drop rule, so a card dropped on its board column gets priority 1 and today's date (the date is resolved on the device that applies the drop):

```bash
curl -sS -X PATCH "$OT/api/v1/views/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"on_drop":{"priority":1,"due":"today"}}'
curl -sS -X PATCH "$OT/api/v1/views/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"on_drop":{"due":"friday"}}'
# 400 {"error":{"code":"invalid_input","message":"view.on_drop: due must be one of [today tomorrow next-week clear]"}}
```

Group it by due date with priority 1 first, then build a dashboard from it:

```bash
curl -sS -X PATCH "$OT/api/v1/views/<id>" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"group_by":"due","sort_by":"priority","sort_dir":"desc"}'
curl -sS "$OT/api/v1/views" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Morning","kind":"dashboard","panels":["<id>"],"pinned":true}'
```

An option outside the allowed set, or a query that does not parse, is refused and nothing is created:

```bash
curl -sS "$OT/api/v1/views" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"x","query":"p1","group_by":"colour"}'
# 400 {"error":{"code":"invalid_input","message":"view.group_by must be one of project, due, priority, label, none"}}
curl -sS "$OT/api/v1/views" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"x","query":"@work p1"}'
# 400 {"error":{"code":"invalid_input","message":"view.query: Expected \"\u0026\" or \"|\" before \"p1\" at position 7"}}
```

Export everything:

```bash
curl -sS "$OT/api/v1/export" -H "Authorization: Bearer $TOKEN" -o opentodo-export.json
```

The export includes saved views (`views`, deleted ones too) next to projects, tasks and labels. It resolves label ids: `tasks[].labels` holds ids and the top-level `labels` array (including deleted labels) carries their names and colours. Your preferences are in `user_prefs` (one row, `id` `"me"`): date and time formats, appearance, the promoted sidebar destinations, and `favourites`, the sidebar's Favourites group as an ordered, comma-separated list of `project:<id>`, `label:<id>` and `view:<id>` entries (see [sync](sync.md)).

Follow live updates (the response is a `text/event-stream` that stays open; `-N` disables curl's buffering):

```bash
curl -sSN "$OT/api/v1/sync/events?device=my-script" -H "Authorization: Bearer $TOKEN"
# : connected
# event: ops
# data: {"cursor":158}
# : ping
```

`device` is required (400 `bad_request` without it) and names the subscriber; operations pushed by that same device id through `POST /sync` do not wake it. Each `ops` event carries only the user's latest cursor; fetch the changes with a sync exchange or the REST reads.

## Behaviour notes

- Every write through this API is recorded in the operation log with server time. Connected devices are woken over the event stream and sync within a second or two; devices without a live stream pick the change up on their next poll (within 30 s), or immediately when they next edit or regain focus.
- Writes to unknown fields or with wrong types are rejected as a whole; nothing is partially applied.
- Deletes are tombstones. Use `include_deleted=true` or the export to see them.
- Request bodies are limited to 4 MB, except import uploads (`OPENTODO_IMPORT_MAX_MB`, default 20 MB); some routes set a smaller limit. A larger body is refused with 413 `too_large`.
- A JSON body is exactly one JSON value: anything after it but white space is refused with 400 `bad_request`. A field the route does not define is refused with 400 `bad_request` naming it (`invalid JSON body: unknown field "x"`), except on `POST /api/v1/sync` (ops may carry properties a newer client knows), the push subscription (the browser's `PushSubscription.toJSON()`) and the passkey `credential` (the browser's `PublicKeyCredential.toJSON()`). The entity routes (`/tasks`, `/projects`, …) check their fields themselves and answer 400 `invalid_input` for an unknown one. Error messages describe the problem in plain words, never the server's internal types.
- Password checks are limited to twice the server's CPU count at a time (at least 2). A sign-in, registration or password change that waits more than a second for one is answered 503 `busy` with `Retry-After`.
- Rate limits (per IP): `auth/login`, `auth/register`, `auth/passkey`, the invitation preview, the project invite link preview and accept routes, the password-reset routes, `auth/password-reset` and `auth/verify` share one window of 10 per minute; `auth/passkey/options`, `auth/mfa` and `auth/reauth` each have their own window of 10 per minute; `auth/oidc/start` and `auth/oidc/callback` share a window of 20 per minute; failed `/mcp` authentications count toward the login window. Per account: invitation creation 20 per hour, project invite link creation 20 per hour, mutating `/users` requests 60 per hour, `/me/password` 10 per hour, new comments 60 per minute, email-inbox changes 30 per hour.

### Error codes

Every error answers `{"error":{"code","message"}}`; some validation errors add `field`. Codes by area (the sections above give the details):

**General**

| Code | Status | Where |
| --- | --- | --- |
| `bad_request` | 400 | malformed JSON, an unknown field, data after the JSON value, or a missing required parameter (for example `device` on `/sync` or `/sync/events`); an import upload that is not multipart or has no `file` part |
| `invalid_input` | 400 | validation failure naming the field or parameter |
| `invalid_op` | 400 | `/api/v1/sync` batch with an op that fails schema validation (unknown entity or field, wrong type, an `entityId` outside the allowed characters), or a device id starting with the reserved `agent:`, `caldav:`, `issues:` or `rule:` (`assistant:` is a device prefix and is accepted); nothing in the batch is applied |
| `unauthorized` | 401 | any protected route without a valid session or token |
| `demo_expired` | 401 | demo instance: a session cookie that no longer resolves, because its sandbox was deleted (inactivity, maximum age or the nightly reset). Clients drop their local data and offer a new sandbox |
| `forbidden` | 403 | an action your account role or project role does not allow: invitation management or user administration by a member, an admin acting on an admin or the owner, a role change or transfer by a non-owner; owner settings (backups, audit, webhook policy, two-factor policy, single sign-on, MCP, CalDAV) or a member reset by a non-owner; a write, purge or membership change your project role does not allow; editing someone else's comment |
| `bad_origin` | 403 | cookie-authenticated write from another origin; any `/mcp` request whose `Origin` is not this server |
| `session_required` | 403 | `POST /api/v1/assistant/turn` with an API token: the assistant is used from the app while signed in; confirming a restore or deleting a safety copy with an API token |
| `unknown_skill` | 400 | `POST /api/v1/assistant/turn` naming a skill id the server does not have |
| `insufficient_scope` | 403 | a write route or `/api/v1/sync` called with a `read` or `agent` API token; `/api/v1/me/agent-access` with either |
| `demo_token` | 403 | `POST /api/v1/demo/sandbox` without a valid, unused creation token |
| `demo_restricted` | 403 | a feature a demo instance (`OPENTODO_DEMO=true`) refuses, before authentication: sign-up, invitations, user administration, password change and resets, tokens, app passwords, CalDAV, passkeys, two-factor, settings writes, backups, webhooks, email inbox, import, encryption, push, membership changes, project invite links (every method), `/mcp`, the assistant (`/api/v1/assistant/*`, `/api/v1/me/assistant*`), automation rules (`/api/v1/rules*`, `/api/v1/me/rules*`, `/api/v1/settings/automations`). See [demo instance](self-hosting/demo.md#what-is-switched-off) |
| `not_found` | 404 | unknown id, including another account's items, webhooks and deliveries, and items you cannot read; `/api/v1/push/*` with `OPENTODO_PUSH=off` |
| `conflict` | 409 | starting or undoing an import while another import of yours runs; `POST /backups/run` while a backup is running, or after a restore was confirmed; confirming a restore while a backup runs |
| `too_large` | 413 | a JSON request body over its limit (4 MB unless the route says otherwise); `/mcp` body over 1 MB; an assistant turn over 256 KB or 40 messages; import file over `OPENTODO_IMPORT_MAX_MB` or 50,000 rows |
| `rate_limited` | 429 | too many attempts in the window, see [Behaviour notes](#behaviour-notes) |
| `demo_limit` | 429 | demo instance: the sandbox used its write budget (600 ops per hour, 5,000 ops and 2 MB of values in total), or the database is above its size limit, on `/sync` or a REST write; nothing of the batch is applied. Demo instances also cap values at 4 KB (32 KB for task notes) with `invalid_input` / `invalid_op` |
| `internal` | 500 | unexpected server error (details only in the server log) |
| `unavailable` | 503 | backups or webhooks are not available on this server |
| `demo_busy` | 503 | demo instance: no new sandbox now (live cap reached with none idle for 15 minutes, or the database is above its size limit) |
| `host_managed` | 403 | hosted server: a setting the operator owns, see [Hosted servers](#hosted-servers) |
| `limit_storage`, `limit_ops_hour`, `limit_ops_total` | 403 | hosted server: a REST write over the tenant's storage, changes per hour or stored changes; on `/sync` the same codes are per-op `rejected` reasons |
| `limit_members` | 403 | hosted server: a new account (registration, sign-up confirmation, project invite link, single sign-on) over the tenant's member limit |
| `limit_import` | 413 | hosted server: an import file over the tenant's import size |
| `limit_requests` | 429 | hosted server: more requests per minute than the tenant's limit |
| `suspended` | 503 | hosted server: the operator suspended this tenant; its data is kept |
| `busy` | 503 | every password-check slot is in use (sign-in, registration, password change or reset); `/sync/events` over 20 streams from one address or 2,000 on the server; hosted server: every open tenant is in use. Try again after `Retry-After` |

**Sign-in, accounts and credentials**

| Code | Status | Where |
| --- | --- | --- |
| `invalid_credentials` | 401/403 | 401 for a wrong sign-in or passkey; 403 for a wrong current password at `/me/password` or `transfer-ownership` |
| `signup_closed` | 403 | registration without an invitation while sign-up is closed; first sign-in through the provider when provisioning is not allowed |
| `email_taken` | 409 | registration with an existing email |
| `invitation_email_mismatch` | 403 | registration email differs from the invitation's bound email |
| `invitation_invalid` | 404 | unknown, expired, revoked or already accepted invitation or project invite link; a project link whose project was deleted or whose creator can no longer grant its role |
| `project_invite_not_allowed` | 403 | registering through a project invite link that may not create accounts (see [Project invite links](#project-invite-links)) |
| `invitation_spent` | 409 | revoking an accepted invitation or project invite link |
| `reset_invalid` | 404 | unknown, used, expired or revoked password reset link |
| `self_action` | 409 | a `/users` action on your own account |
| `account_deactivated` | 403/409 | 403 at sign-in with the correct password of a deactivated account; 409 for an administrative action on a deactivated account |
| `account_active` | 409 | reactivating an active account |
| `confirmation_mismatch` | 400 | deleting an account without its email in `confirmEmail` |
| `reauth_required` | 403 | a *fresh* route on a cookie session that has not proved its identity in the last ten minutes |
| `mfa_code_invalid` | 400/401 | 400 confirming enrolment with a wrong or late code; 401 for a wrong, reused or replayed code or recovery code |
| `mfa_challenge_invalid` | 401 | unknown, expired or exhausted sign-in challenge: enter the password again |
| `mfa_already_enrolled` / `mfa_not_enrolled` | 409 | enrolling twice, or disabling/regenerating without a second factor |
| `mfa_required_by_policy` | 403 | turning off a second factor that the owner's policy requires |
| `mfa_enrolment_required` | 403 | any other route while the owner's policy requires a second factor this account has not set up |
| `passkeys_unavailable` | 409 | any passkey route when `OPENTODO_BASE_URL` is not https or localhost |
| `passkey_challenge_invalid` | 400 | passkey ceremony with an expired, reused or foreign challenge |
| `sso_required` | 403 | password or passkey sign-in (or password registration) by a non-owner while SSO-only mode is on |
| `oidc_disabled` | 404 | single sign-on routes while no provider is configured |
| `oidc_state_invalid` | 400 | provider callback with a missing, forged, expired or reused state |
| `identity_taken` | 409 | linking a provider identity that belongs to another account |
| `last_credential` | 409 | unlinking the last way to sign in to the account |
| `verification_invalid` | 404 | unknown, expired, replaced or used sign-up confirmation link |
| `smtp_disabled` | 404/409 | 404 on routes that only send (`auth/password-reset`, the SMTP test) and `/settings/smtp` on a server without outgoing email; 409 for a `send` flag while outgoing email is not configured |
| `email_failed` | 502 | the SMTP server refused or could not be reached while sending an invitation, project invite or reset by email; nothing was left pending |
| `managed_by_env` | 409 | changing an outgoing email field that an `OPENTODO_SMTP_*` variable sets |
| `base_url_required` | 409 | a password reset, open sign-up, invitation, project invite or reset sent by email on a server without `OPENTODO_BASE_URL`; nothing was created or sent |

**Data, sharing and features**

| Code | Status | Where |
| --- | --- | --- |
| `link_invalid` | 404 | an unknown, expired, revoked or no longer usable [public link](#public-links) |
| `scope_change` | 400 | `PATCH` of a task's `project_id` into another sharing scope |
| `not_a_member` | 400 | a task's `assignee_id` that is not a member of its project (or not you, for a personal task) |
| `user_not_found` | 404 | adding a project member by an email that has no account |
| `already_member` | 409 | adding an account that is already a member of the project, or accepting a project invite link as one |
| `owner_must_transfer` | 409 | the project owner leaving the project; the workspace owner leaving the workspace |
| `not_in_workspace` | 409 | adding someone to a project or group of a created workspace they are not a member of |
| `default_workspace` | 409 | deleting, leaving, transferring or adding members to a default workspace |
| `workspace_not_empty` | 409 | deleting a workspace that still has projects or other members |
| `group_exists` | 409 | a group name already used in the workspace (ignoring case) |
| `project_id_conflict` | 409 | sharing a project for the first time while another account has a project with the same id |
| `not_deleted` | 409 | purging a task or project that is not in the Trash |
| `unsupported_format` | 400 | import file in no supported format |
| `invalid_file` | 400 | import file recognised but unreadable |
| `private_target` | 400 | webhook URL on a private, loopback or link-local network while the owner has not allowed private targets |
| `limit_reached` | 409 | more than 20 webhooks, 5 issue connections or 50 automation rules on one account; a workspace limit (20 owned workspaces, 200 members, 50 groups, 100 per group) |
| `destination_error` | 502 | `POST /backups/test`, the archive list or preparing a restore when the destination refuses or cannot be reached |
| `passphrase_required` | 422 | preparing an encrypted archive without a passphrase when the stored one is missing |
| `passphrase_invalid` | 422 | preparing an encrypted archive with a passphrase that does not open it |
| `newer_schema` | 409 | preparing an archive made by a newer OpenTodo version |
| `integrity` | 400 | an uploaded or prepared file that is not an OpenTodo archive, or fails its checksum or database check |
| `insufficient_storage` | 507 | an upload or restore the free disk space cannot hold |
| `email_disabled` | 409 | changing or rotating the email-to-task address when the operator has not configured email capture |
| `encryption_disabled` | 404/409 | 404 for `GET`/`DELETE /api/v1/encryption/keys` without a key record; 409 for the history purge without one |
| `encryption_conflict` | 409 | `PUT /api/v1/encryption/keys` with a version that is not the stored version + 1 (another device created or changed the record) |
| `encryption_enabled` | 409 | sharing a project for the first time, creating a CalDAV app password, or creating or enabling an issue connection, while the account uses end-to-end encryption |
| `method_not_allowed` | 405 | `/mcp` with a method other than `POST` |
| `not_acceptable` | 406 | `/mcp` with an `Accept` header that admits only `text/event-stream` |
| `unsupported_protocol_version` | 400 | `/mcp` with an `MCP-Protocol-Version` header naming an unsupported version |
| `issues_disabled` | 404 | any `/api/v1/issues` route while the owner has not enabled [issue connections](#issue-connections) |
| `connection_stopped` | 409 | syncing an issue connection stopped for its token, its host or encryption |
| `connection_disabled` | 409 | syncing a disabled issue connection |
| `provider_rate_limited` | 409 | syncing an issue connection before the provider's rate-limit reset |

**In-app assistant**

| Code | Status | Where |
| --- | --- | --- |
| `consent_required` | 403 | an assistant turn before you accepted the disclosure for the current provider |
| `encryption_enabled` | 409 | an assistant turn or consent for an end-to-end encrypted account |
| `turn_in_progress` | 409 | a second assistant turn while your first is still answering |
| `no_key` | 409 | an assistant turn when the provider needs a key and none is stored |
| `provider_changed` | 409 | accepting a disclosure that named a provider no longer in effect |
| `assistant_disabled` | 409 | accepting the disclosure while the assistant is off |
| `assistant_quota` | 429 | an assistant turn at your monthly token allowance; `resets_at` names the reset date |
| `assistant_busy` | 503 | 8 assistant turns already running on the server; retry after `Retry-After` |
| `private_target` | 400 | the compatible endpoint's base URL resolves only to private addresses and private endpoints are not allowed |

CalDAV (`/dav/`) answers with WebDAV status codes and precondition elements instead of this envelope; MCP tool errors are JSON-RPC errors (see [mcp.md](mcp.md#protocol-details)).
