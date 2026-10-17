# Design

## D1. Consolidate the hand-written parser rather than adopt the `yaml` package

The repository has no root `package.json`; the deploy checks run with plain `node` and no install step (`make deploy-check`, the CI Checks job). Adopting `yaml` (about 700 KB unpacked, no dependencies) would add a root `package.json`, a lockfile, Dependabot coverage and an `npm ci` to the Checks job, only to read a few dozen files. It would also accept all of YAML 1.2, so the checks would have to re-implement the refusals the platforms need (no anchors, no block scalars in Coolify-style compose files, no `|` in the Umbrel manifest) on top of it. The TrueNAS parser already read every file the other three read, so it became the base: about 240 lines, standard library only.

## D2. Profiles instead of separate parsers

The four parsers differed in two ways. Some differences were deliberate limits of a platform's file and stay as profile options: string scalars (Coolify-style compose files and the Umbrel manifest compare `"8080"`), allowed block scalar headers, maps inside sequences (refused in Coolify-style compose files), quoted dates (CasaOS). The rest were accidents of each implementation (key characters, comment and quote handling, escape processing, nested flow sequences, folded plain text, empty `key:` values) and now follow one rule. Where that rule accepts more than an old parser did, it accepts only YAML it reads correctly; where it refuses more (`a: b: c` in a compose file, `|+` anywhere), the old reading was wrong.

Folded block scalars now follow the YAML spec (a blank line becomes a newline), as the Umbrel parser did; the TrueNAS parser's double-space folding is gone. No committed TrueNAS-profile file uses `>`.

## D3. Proof of no change

Before switching, every YAML file under `deploy/` was parsed with each old parser and with the new parser under the matching profile. Every file a checker reads parses to the same value; the only differences are files the old parsers refused, and the Umbrel manifest under the full profile (the fold fix), which no checker reads that way.

## D4. Docs completeness as a repo check

The check walks `internal/` for directories holding `.go` files (skipping `testdata` and `dist`) and requires each path in backticks in `AGENTS.md`, and a `| \`name\` |` row (top-level packages) or a backticked mention (sub-packages) in `docs/architecture.md`. It also compares the token scopes in `AGENTS.md` with the `Scope*` constants in `internal/auth/service.go`. It runs in `make repo-check`, already part of `make check` and CI.
