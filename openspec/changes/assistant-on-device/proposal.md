# Proposal

## Why

The in-app assistant runs its loop on the server. For an account with end-to-end encryption the server holds no key, so it cannot read the tasks and the assistant is switched off for those accounts ("Encrypted accounts" in `in-app-assistant`). The device relay (`mcp-device-relay`) does not help here: it decrypts on a device and hands plaintext back to the server, which then sends it to a model provider. That is acceptable for an MCP client the user starts on purpose, but it is exactly what end-to-end encryption promises not to do.

The owner wants "AI on your terms" for encrypted accounts as well. The way to keep the promise is to run the assistant on the device that already holds the key: the browser reads its own decrypted tables, calls a model provider the user chose with the user's own key (or a model server the user runs, such as Ollama or LM Studio), and applies reviewed changes through the op log like today. The server sees nothing of the content and never touches the key.

This advances the ROADMAP "Future ideas" item **In-app assistant for end-to-end encrypted accounts**.

## What Changes

- **Owner switch "On-device assistant for encrypted accounts"**, off by default, in the assistant settings: which providers a device may call (Anthropic, OpenAI, Google Gemini, a model server) and, for model servers, an allow-list of up to 10 origins (`https://…`, or `http://localhost…` for a model on the user's own computer). It needs the assistant's main switch, but no server provider or key. Forced off on the demo instance.
- **Content Security Policy:** while the switch is on, `connect-src` adds exactly the origins of the allowed providers and the owner's list, never a wildcard. The service worker serves the app shell with the server's latest policy, so a change takes effect on the next page load.
- **On-device mode in the panel for encrypted accounts:** instead of "the assistant can't read encrypted tasks", an encrypted account on a server that allows it sets up the assistant on this device: provider, model, its own key (or a model server URL from the owner's list), with "Test connection". The key is stored only in this browser's local database, never synced, never sent to the OpenTodo server, deleted at sign-out and removable at any time.
- **Consent** is still recorded per user on the server (`PUT /api/v1/me/assistant` with provider `device:<name>`); the disclosure says the content goes directly from this device to the named provider and that the server sees none of it.
- **The loop runs in the browser:** the same fixed instructions, limits (8 rounds, 50 changed items, refusal and truncation checks), untrusted-text marking and skills as the server's loop. Read tools read the device's decrypted tables (kept-away projects left out); write tools only plan a change set, shown in the existing review card and applied through `mutateMany` with device `assistant:<device-id>`, undoable in one step. The tool definitions come from the shared registry as a generated manifest checked by a test, and the planners are pinned to the server's by shared vectors.
- **Tool subset on the device:** today summary, list projects, list, get and search tasks; create, update, complete, reopen, schedule, move and trash tasks (trash only for tasks created in the same proposal), create project and label, add comment. Custom field values, recurrence rules, locations and origins are not offered on the device (the arguments are pruned from the shared definitions).
- **Usage stays on the device:** each answer shows its token count marked "your key"; nothing is reported to the server and the owner's monthly allowance does not apply.
- **Requests use `fetch`** with streaming, no SDK in the browser: Anthropic's Messages API with the `anthropic-dangerous-direct-browser-access` header, and the Chat Completions format for OpenAI, Gemini and model servers.

Out of scope:
- On-device mode for accounts without encryption (they keep the server's assistant).
- Syncing the provider key between devices.
- Reporting on-device usage to the server or capping it.
- Per-user Content-Security-Policy entries (the policy is per server; design D3).
- Custom field values, recurrence, locations and origins in on-device proposals; section and favourite tools stay out as in the server assistant.
- The relay, MCP and the server's assistant are unchanged.

No new environment variable, no op-log change, no migration (the setting is a new key in the existing `assistant` settings JSON). Not breaking.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `in-app-assistant`: "Encrypted accounts" gains the on-device mode; new requirements for the owner switch, device setup and key storage, consent, the device loop and tools, provider requests, and device-local usage.
- `self-hosting`: "Security headers" and "No telemetry" allow the browser to reach the provider origins the owner allowed for the on-device assistant.
