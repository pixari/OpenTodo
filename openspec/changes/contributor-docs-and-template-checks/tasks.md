# Tasks

## 1. One YAML parser (OPS-18)
- [x] 1.1 `scripts/deploy/yaml.mjs` with profiles `YAML_FULL`, `YAML_COMPOSE`, `YAML_CASAOS`, `YAML_UMBREL_MANIFEST`
- [x] 1.2 Coolify, CasaOS, Umbrel, TrueNAS and every other checker use it; remove the old parsers and `truenas-yaml.mjs`
- [x] 1.3 Move the copied helpers (`isMap`, `same`, `pngSize`, `listFiles`, `readText`/`ROOT`) into `scripts/deploy/common.mjs`
- [x] 1.4 `scripts/deploy/yaml.test.mjs`: refusals shared by every profile, quoting and folding, typed and string scalars, per-profile limits, no checker with its own parser
- [x] 1.5 Compare every `deploy/` YAML file's parse before and after; `make deploy-check` passes with every existing assertion

## 2. Contributor docs (OPS-19, INT-21)
- [x] 2.1 `AGENTS.md` Layout names every `internal/` package; MCP write tools described; outbound rule lists every target
- [x] 2.2 `docs/architecture.md` rows for the missing packages; `README.md` privacy list adds SMTP and calendar subscriptions; `deploy/README.md` points to the shared parser
- [x] 2.3 `scripts/repo-checks.test.mjs`: every package in `AGENTS.md` and `docs/architecture.md`, token scopes match `internal/auth`, MCP not called read-only
- [x] 2.4 CHANGELOG
