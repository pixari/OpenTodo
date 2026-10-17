# Design: server code structure

## Decisions

**D1. Files by concern, one router.** `server.go` keeps the `Server` type, `New` and the error helpers. Every route is registered from `router.go`, directly or through the existing `register*Routes` functions, always via `routes.handle`, so `routeTable` and `policy_test.go` still see every route. The router comment states the Go 1.22 rule: the most specific pattern wins regardless of order, and two patterns where neither is more specific panic at registration.

**D2. `New` in three steps.** `newServer` builds the struct and the importer limits, the options run, `wireServices` connects the services. `wireServices` receives `New`'s `cfg` and `log` arguments rather than reading the fields, because test options may replace those fields and the original code used the arguments.

**D3. Apply as a batch object.** `applyBatch` holds the state that `apply` kept in locals (resolver, purge checker, quota admission, change tracker, refused and rewritten ops, byte count, result). `applyOne` returns an error to end the batch; a strict rejection clears the result first, exactly as the old `return ApplyResult{}, err` did. `finish` keeps the order: write guard charge, restore ops, cursor, audience, commit, quota, then observers and events after commit.

**D4. Value checks as a table.** `kindChecks` maps each kind to its check; nullable kinds are wrapped by `orNull`. A test fails if a kind has no entry, and a table test pins the accepted values and error messages (it passes against the code before the split as well).

**D5. Side-effect order is kept.** The importer allots ids, positions and implicit labels as rows are read; the split passes (`projects`, `projectParents`, `sections`, `tasks`, `dependencies`, `changes`) run in the original order, and each task row still draws its id before its fields. The tenant wiring keeps building services in the same order and assigns the tenant's fields only once everything was built.

**D6. The check.** `internal/codesize` is a test-only package that parses every non-test Go file under `internal/` with `go/parser`: functions over 150 lines (func line to closing brace) and files over 1,100 lines fail unless listed with a reason; a listed entry that is no longer over the limit fails too, so the list only shrinks. It runs with `go test ./...` (CI's Go job, `make check`).

## Data model

None. No op field, table or migration changes.

## Size

No dependency; binary size unchanged.
