# Server code structure: split the long files and functions

## Why

An audit found the server hard to navigate where it matters most:

- **SEC-17.** `internal/httpapi/server.go` was about 2,000 lines: the router, the middleware, the sign-in and token handlers, invitations, sync, the REST collections, export and the rate limiter in one file. `New` was 194 lines, and its comments said routes had to be registered "before" the generic `{collection}` routes so that literal patterns "win". Go's `ServeMux` picks the most specific pattern whatever the registration order, so those comments taught a rule that does not exist.
- **CORE-22.** The write path had long functions: `checkKind` (196 lines, `internal/sync/ops.go`), `Service.apply` (166, `service.go`), `quickadd.Parse` (191) and the tenant wiring (153, `internal/tenant/tenant.go`).
- **INT-18.** The importer, CalDAV and agent tools had very long functions and files: `planForeign` (366 lines) in a 1,242-line `internal/importer/plan.go`, the Things, Todoist, CSV and TickTick readers (162 to 239 lines), CalDAV `Decode` (173) and a 1,252-line `internal/agenttools/write.go`.

Nothing kept a function or a file from growing again.

## What Changes

- `internal/httpapi/server.go` is split into `router.go` (every route registration, with a correct note on how the mux chooses), `middleware.go`, `ratelimit.go`, `auth_handlers.go`, `invitations.go`, `sync_handlers.go`, `collections.go` and `export.go`. `New` builds the server, wires the services and registers the routes in separate steps. Routes are still registered only through `routes.handle`, so the policy tests see every route.
- `Service.apply` runs as validate the batch, then per op admit, resolve and store, then finish (charge the write guard, commit, notify). The reader pool, the `blocked_by` graph cache and the server clock are kept as they are. `checkKind` looks up one check per value kind.
- `quickadd.Parse`, the tenant wiring, `config.Load`, the assistant turn handler, the importer's foreign planner and its Things, Todoist, CSV and TickTick readers, and CalDAV `Decode` are split into named steps. `plan.go`, `write.go` and `vtodo.go` are split by phase or entity.
- A repository check (`internal/codesize`) fails when a function in `internal/` is longer than 150 lines or a source file longer than 1,100 lines. Exceptions need an entry with a reason in its allow-list, which is empty today.

There is no behaviour change: routes, policies, the API, the op format and every message stay the same. Existing tests are the safety net, and table tests pin the new seams (the per-kind value checks and the optional boolean variables).

## Out of scope

- Splitting the remaining functions between 100 and 150 lines and test files.
- Changing what any handler, check or importer does.

## Roadmap

Advances the maintainability work behind every ROADMAP.md item; no feature item.

## Capabilities

### Modified Capabilities
- `self-hosting`: adds a requirement that the server code stays within size limits checked by the test suite.

## Impact

Go code under `internal/` only; no new dependency, no new environment variable, no migration. Binary size is unchanged.
