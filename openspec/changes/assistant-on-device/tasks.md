# Tasks

## 1. Server

- [x] 1.1 `assistant.Settings.Device` with validation of providers and origins, audit of changes, relaxed main-switch check (`go test ./internal/httpapi -run 'DeviceAssistant|DeviceOrigin'`)
- [x] 1.2 Status: `mode`, `device` block for encrypted accounts; device consent through `PUT /api/v1/me/assistant`; the turn route still answers 409 for encrypted accounts (`TestDeviceAssistantSettings`)
- [x] 1.3 CSP `connect-src` from the device settings, cached per process, refreshed on save; the demo never widens it (`TestDeviceAssistantSettings`, `TestDeviceAssistantNeverOnDemo`)
- [x] 1.4 `SystemPrompt` split into the fixed `SystemRules`; `DeviceManifest()`; golden test writing `web/src/lib/assistantDevice/manifest.json`, `prompt.vectors.json` and `plan.vectors.json` (`go test ./internal/assistant -run Device`)

## 2. Browser

- [x] 2.1 Device settings record in `meta` (provider, model, base URL, key), checks against the owner's list (vitest `assistantDevice/providers.test.ts` "device setup checks")
- [x] 2.2 Read tools and planners over Dexie, pinned by `plan.vectors.json`; manifest coverage (vitest `assistantDevice/tools.test.ts`)
- [x] 2.3 Provider adapters over `fetch` (Anthropic Messages, Chat Completions) with SSE parsing and error mapping (vitest `assistantDevice/providers.test.ts`)
- [x] 2.4 The loop: prompt vectors, rounds, stop reasons, untrusted folding, change-set merge, events (vitest `assistantDevice/loop.test.ts` with a fake provider)
- [x] 2.5 Panel: setup form, device disclosure, locked state, turns through the device loop, apply with the assistant's device (happy-dom `app/assistantDevice.test.tsx`)
- [x] 2.6 Settings: owner group "On-device assistant for encrypted accounts", "On this device" row for encrypted accounts (docs screenshot `assistant-device-owner`, `npm run typecheck`)
- [x] 2.7 Service worker serves the app shell with the server's latest policy (`tsc -p tsconfig.sw.json`, `npm run build`)
- [x] 2.8 Skills from the manifest on the device (`assistantDevice/tools.test.ts` "offers each skill only its device tools")

## 3. Docs and checks

- [x] 3.1 `docs/assistant-encrypted.md`, the "On encrypted accounts" section of `docs/assistant.md`, privacy, owner, e2ee, API and Docker pages; CHANGELOG; translations in six languages (`make docs-check`, `make i18n-check`)
- [x] 3.2 `make openspec-validate`, `make check`
