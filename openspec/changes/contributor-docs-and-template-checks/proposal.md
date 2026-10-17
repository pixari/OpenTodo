# Contributor docs and template checks: one YAML parser, a complete package map

## Why

An operations and integration audit found three maintenance gaps in what contributors and agents rely on:

- **OPS-18.** The deploy template checks carried four hand-written YAML parsers (`scripts/coolify-template-check.mjs`, `scripts/deploy/casaos.mjs`, `scripts/deploy/truenas-yaml.mjs` and the Umbrel manifest parser in `scripts/deploy/umbrel.mjs`) plus copied helpers. They accepted different things and two of them misread valid YAML: the Coolify parser kept `'it''s'` and `"a\"b"` unescaped and read `a: b: c` as the string `b: c`; the TrueNAS parser folded `>` text with blank lines into double spaces and treated `|+` as `|`.
- **OPS-19.** `AGENTS.md` named 16 of the 40 Go packages under `internal/` (missing `outbound`, `tenant`, `host`, `webauthn`, `audit`, `assistant`, `agenttools`, `webhook`, `importer`, `mail` and others); `docs/architecture.md` had no row for 10 top-level packages; the outbound-request rule in `AGENTS.md` left out SMTP, model providers and calendar subscriptions. Nothing caught it.
- **INT-21.** `AGENTS.md` described `internal/mcp` as a read-only MCP server; it has write tools behind the owner's and the user's switches and `agent` tokens.

## What Changes

- One strict YAML subset parser, `scripts/deploy/yaml.mjs`, used by every template check. What a platform's file may use is a named profile (`YAML_FULL`, `YAML_COMPOSE`, `YAML_CASAOS`, `YAML_UMBREL_MANIFEST`): typed or string scalars, the allowed block scalar headers, maps inside sequences, quoted dates. Everything outside the subset (anchors, aliases, tags, flow maps, directives, tabs, CR line endings, duplicate keys, odd indentation, `|+`/`>+`) is refused by every profile with a line number. The old parsers and `truenas-yaml.mjs` are removed; the copied helpers (`isMap`, `same`, `pngSize`, the recursive file listing, `read`/`ROOT` in the Coolify check) live in `scripts/deploy/common.mjs`. Shared tests in `scripts/deploy/yaml.test.mjs`, including one that fails when a checker defines its own YAML parser.
- `AGENTS.md`'s Layout names every `internal/` package, grouped by area, and describes the MCP server's write tools; the outbound rule lists every target. `docs/architecture.md` gets the missing rows; `README.md`'s privacy list gains SMTP and calendar subscriptions.
- `scripts/repo-checks.test.mjs` fails when an `internal/` package is not named in `AGENTS.md` or has no row in `docs/architecture.md`, when the token scope list in `AGENTS.md` differs from `internal/auth`, or when `AGENTS.md` calls the MCP server read-only.

No server, client, template or image changes; every committed template parses to the same values as before.

## Capabilities

### Modified Capabilities
- `self-hosting`: the template conformance check reads YAML with one shared strict parser.
- `documentation`: the contributor guide and architecture page name every server package, checked in CI.

## Impact

- `scripts/deploy/yaml.mjs` (new), `scripts/deploy/yaml.test.mjs` (new), `scripts/deploy/truenas-yaml.mjs` (removed), `scripts/deploy/{common,casaos,umbrel,cosmos,dokploy,runtipi,render,synology,helm,truenas,easypanel,caprover,pin}.mjs`, `scripts/coolify-template-check.mjs`, `scripts/deploy/truenas.test.mjs` (import path).
- `AGENTS.md`, `docs/architecture.md`, `README.md`, `deploy/README.md`, `scripts/repo-checks.test.mjs`, `CHANGELOG.md`.
- No dependency added (see design.md).
