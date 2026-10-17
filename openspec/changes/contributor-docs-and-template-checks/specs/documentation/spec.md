## ADDED Requirements

### Requirement: Contributor guide names every server package
`AGENTS.md` SHALL name every Go package under `internal/` with what it does, and `docs/architecture.md` SHALL have a row for every top-level package under `internal/` and mention each sub-package. `AGENTS.md` SHALL list exactly the API token scopes the server defines and SHALL describe what each package can write, so an agent does not treat a package with write paths as read-only. A repository check run by `make check` and CI SHALL fail when any of this drifts.

#### Scenario: A new package without documentation
- **WHEN** a change adds `internal/foo` without naming it in `AGENTS.md` or adding a row to `docs/architecture.md`
- **THEN** `make check` fails and names `internal/foo`

#### Scenario: A new token scope
- **WHEN** `internal/auth` gains a token scope that `AGENTS.md` does not list
- **THEN** `make check` fails until the scope list matches

#### Scenario: MCP described as read-only
- **WHEN** `AGENTS.md` describes `internal/mcp` as read-only
- **THEN** `make check` fails, because the MCP server has write tools for `agent` tokens
