# Design

## Context

`in-app-assistant` runs the agent loop on the server (`internal/assistant`): read tools over the materialised rows, write tools planned into a change set, streamed to the browser, which reviews and applies it through `mutateMany` (`web/src/lib/assistant.ts`, `undo.ts`). For an end-to-end encrypted account the server holds only ciphertext, so the turn route answers 409 `encryption_enabled`.

The device relay (`internal/relay`) lets an MCP client read an encrypted account through an opted-in device. The device decrypts and the plaintext reaches the server (sealed per stream, held in memory only), which hands it to the agent. Used for the in-app assistant, the server would then send the plaintext to a model provider with the operator's key: the server would see the content, which is what encryption promises it never does. So the relay is not reused.

The browser already holds the decrypted tables (Dexie; `e2eeSync.ts` decrypts on the way in and encrypts every outgoing op at one choke point). Running the loop there keeps the content on the device and on the path to the provider the user chose.

## Goals / Non-Goals

Goals: encrypted accounts get the assistant without the server seeing content or keys; the owner decides whether devices may call providers and which; the user's consent applies; the same review, apply and undo; tools that cannot drift from the registry.

Non-goals: on-device mode for plaintext accounts, key sync, server-side usage caps for on-device turns, MCP or relay changes.

## Decisions

### D1. Only for encrypted accounts

The mode exists to serve accounts whose content the server cannot read. A plaintext account already has the server assistant, which keeps keys out of the browser; offering both would double the configuration surface for no privacy gain (the server can read plaintext accounts anyway). The status route offers `mode: "device"` only when the account is encrypted. Recorded as a question for the owner.

### D2. Owner setting

`assistant.device = {enabled, providers, origins}` inside the existing `assistant` settings JSON (no migration, defaults off and empty).

- Available to a user when the assistant's main switch is on, `device.enabled` is on, at least one provider is allowed, the account is encrypted and the server is not a demo. The main switch no longer requires an enabled server provider when the device switch is on (an owner whose people all use encryption should not need an operator key); `Active()` (server turns) is unchanged, so plaintext accounts on such a server read "no provider".
- Providers: `anthropic`, `openai`, `gemini`, `compatible`. `compatible` needs at least one origin.
- Origins: at most 10; `https://host[:port]`, or `http://` only for `localhost`, `127.0.0.1` and `[::1]` (a model on the user's own computer; any other plain-http origin would be mixed content from an https page and leak the key on the network). No path, query, user info or wildcard; stored lower-case. Audited like every other assistant setting (`assistant.device.*`).
- Demo: `assistantSettings` already forces the main switch off on a demo, and the settings route is `demoDenied`, so nothing changes there and the policy is never widened.

### D3. Content Security Policy per server, not per user

`connect-src` becomes `'self'` plus the built-in API origins of the allowed providers (`https://api.anthropic.com`, `https://api.openai.com`, `https://generativelanguage.googleapis.com`) plus the owner's origins, only while the mode is available on the server. Nothing is added otherwise; there is never a wildcard.

Per-user entries (the user's own origin only) were considered and rejected: the app shell is precached by the service worker and served offline, so its headers cannot depend on who is signed in; the server would also have to store each user's endpoint and look up the session on every static request. An owner allow-list is static per server, cheap (the value is cached for 30 seconds per process, refreshed on save, so a rolling update converges), and keeps the owner in control of which third-party hosts pages may talk to.

Trade-off, documented: the allowed origins are reachable from every page of that server, for every account. The policy is defence in depth against injected script; an attacker who can run script in the page could send data to an allowed provider with their own key (Anthropic and OpenAI both have file APIs). Keeping the list to what the owner chose bounds that. Off by default.

### D4. The service worker serves the latest policy

Workbox serves navigations from the precached `index.html`, whose headers were stored at install time, so a policy change would otherwise wait for the next release. The navigation handler now replaces the cached response's `Content-Security-Policy` with the last policy the server sent, and refreshes that copy in the background from the server (a `HEAD /` without cache) on every navigation (stale-while-revalidate). The value only ever comes from the server's own response, so the page cannot weaken it. When a request is blocked (the first load after the owner's change still has the old policy), the panel's message says to reload the page.

### D5. Where the key lives: this device only

The device settings (provider, model, model server URL, key) are one record in the local database's `meta` table: not synced, never sent to the OpenTodo server, deleted at sign-out with the rest of `meta`, removable in Settings and the panel.

Alternatives: encrypting the record with the account key and syncing it as a new content field. Rejected for now: it adds an op field and puts the (encrypted) key in the op log, exports and backups for a convenience (typing the key once per device). Wrapping it with a non-extractable device key was also rejected as security theatre: the wrapping key would sit in the same database. The device is already the trust boundary for the decrypted tables (e2ee design D4), and the key is exposed to the page's script by nature of the mode (the browser makes the request). The disclosure says so.

### D6. Consent

Consent stays server state through the existing route: `PUT /api/v1/me/assistant {consent: true, provider: "device:<name>"}`, accepted only for an encrypted account while the mode is available and `<name>` is allowed. The status reports `device.consented_provider`. Choosing another provider on the device asks again. The server learns which provider kind the user chose (not the key, model or URL); that keeps one consent record and the "withdraw" control in Settings working as today.

### D7. The loop runs in the browser and speaks the same events

`web/src/lib/assistantDevice/loop.ts` mirrors `loop.go`: the fixed instructions, at most 8 model calls, 8,192 output tokens per call, 50 changed entities per proposal, pause/refusal/truncation/unknown stop handling with the same messages, pasted text folded into the next user message as `untrusted_text`, status lines per tool, the draft overlay so later plans see earlier ones, and the merge of the draft into one change per entity with `base` values for stale detection. It emits the same `TurnEvent`s as the server stream, so the panel's review, apply (`mutateMany`, device `assistant:<device-id>`), auto-apply and undo are reused without change. Usage events carry `own_key: true` and no cap.

A locked device (no key in memory) has no plaintext to read: the panel asks to unlock first. A turn does not need the OpenTodo server: with a model server on the same computer it works offline.

### D8. One tool registry: a generated manifest and shared vectors

The browser must not invent a second toolset. `internal/assistant.DeviceManifest()` builds a JSON manifest from the registry: the subset of tools, each with its registry description and input schema pruned to the supported arguments, plus the strict-mode and Gemini forms of the schema (`strictSchema`, so the browser need not port it), the fixed instructions, the device note, the untrusted notice and note, limits, refusal and cut-off messages, the skills with their instructions and tools, and the built-in provider endpoints. A Go test compares it with `web/src/lib/assistantDevice/manifest.json` (rewritten with `-update`), like the icon catalogue. A vitest checks that every manifest tool has a device implementation and the reverse.

`SystemPrompt` is split so its fixed text is one constant; prompt vectors (`prompt.vectors.json`, generated by Go) pin the browser's assembly of the dynamic lines (name, date, zone, view, selection, skill, working day).

Planner parity is pinned by `plan.vectors.json`: a small account (projects, labels, tasks) and calls with their expected change sets, generated by running `Registry.Plan` in Go and asserted by the browser planner over the same rows in fake IndexedDB. Timestamps are normalised.

Subset (justified by what the review card can describe, what the device holds and what the skills need):

- Reads: `today_summary`, `list_projects` (without `workspace`), `list_tasks` (without paging, completion ranges and `workspace`; at most 200 results), `get_task`, `search_tasks` (without paging and `workspace`).
- Writes: `create_tasks` and `update_tasks` without `fields`, `recurrence`, `location`, `origin_url`, `workspace_id` and `client_request_id`; `complete_tasks` (recurring tasks roll forward through the app's own `planCompletion`), `reopen_tasks`, `schedule_tasks`, `move_tasks`, `trash_tasks` (only tasks created earlier in the same proposal, as on the server), `create_project` (name, colour, parent), `create_label`, `add_comment` (without replies).
- Not offered: time entries, icons and workspaces (reads the panel rarely needs), the section and favourite tools (already excluded in the app), custom fields, recurrence, locations and origins (need ports of validators the device does not have yet: `internal/location`, the custom field parser, the origin recogniser). The device instructions say these cannot be changed here.

### D9. Provider requests with `fetch`

No SDK in the browser (bundle size, AGENTS rule 6): two small adapters over `fetch` with streamed server-sent events.

- Anthropic: `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01` and `anthropic-dangerous-direct-browser-access: true` (Anthropic's opt-in for browser CORS). Same request as the server: strict tools, `tool_choice` auto, adaptive thinking, effort `medium`, prompt caching; thinking and tool-use blocks of a round go back unchanged.
- OpenAI, Gemini (Google's OpenAI-compatible endpoint) and model servers: `POST <base>/chat/completions` with `stream`, `stream_options.include_usage`, tools and `tool_choice` auto; `Authorization: Bearer` when a key is set (optional for a model server).
- CORS: Anthropic answers browser requests with the header above; OpenAI's API answers cross-origin requests; Google's endpoint is expected to, but this cannot be verified without a key, so "Test connection" on the device is the check. Ollama needs `OLLAMA_ORIGINS` set to the app's origin, LM Studio its CORS switch; browsers may ask the user before a page reaches `localhost`. Documented.
- Errors are mapped to the server's codes (`provider_auth`, `provider_rate_limited`, `provider_error`); a request blocked by the policy or CORS says so. The key never appears in a message.

### D10. Usage stays local

Token counts are shown per answer ("· your key") and summed per thread as today. Nothing is reported: the provider bills the user's own key, the owner's allowance exists to protect the operator key, and a report from the browser could not be trusted anyway. The usage route and meter are unchanged (they count server turns).

### D11. Skills

The built-in skills (instructions and tool lists) are in the manifest; on the device a skill offers the intersection of its tools with the device subset. `GET /api/v1/assistant/skills` is unchanged (empty for encrypted accounts); the device reads the manifest instead.

## Data model

- Setting `assistant.device` (owner settings JSON): additive, default off.
- Consent rows reuse `assistant_consent` with provider `device:<name>`.
- Device: one `meta` record `assistant.device` (not synced). No op field, no migration.

## Interface budget

The panel keeps its layout: the setup form takes the place of the "can't read encrypted tasks" text, then the consent, then the conversation (no new chrome rows, no new shortcut). Settings → Integrations → Assistant gains one row group "On this device" for encrypted accounts and one owner group "On-device assistant"; no new sidebar destination, no new scroll region.

## Size

No dependency. The loop, planners and adapters (`loop` chunk, 30.5 KB, 10.5 KB gzip) and the manifest (`manifest` chunk, 41.7 KB, 7.2 KB gzip) are separate lazy chunks, loaded only when an encrypted account in device mode sends a turn, tests a connection or lists skills; the manifest and the loop never reach the main chunk. The setup form, the device hook and the device settings record (about 7 KB minified, under 3 KB gzip) sit with the panel body that the build already places in the main chunk. The Go binary grows only by the manifest builder and the CSP cache; no runtime memory change on the server.

The service worker's cached policy lives in a small Cache Storage entry (`opentodo-policy`). Script running in the page could write it, as it could already rewrite the precached shell itself, so this adds no new capability for an injected script.

## Risks

- The provider key is readable by the page's script (by nature of the mode). Mitigations: strict CSP, the owner's allow-list, device-only storage, removal at sign-out, the disclosure.
- Provider CORS rules can change; the mode then fails with a clear error and nothing else breaks.
- Drift between Go and the browser planners: limited by the manifest test and the shared vectors; arguments the device cannot validate are not offered.
