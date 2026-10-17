# Tasks

## 1. HTTP server (SEC-17)
- [x] 1.1 Split `internal/httpapi/server.go` into router, middleware, rate limiter, auth handlers, invitations, sync, collections and export files; `go test ./internal/httpapi/` passes
- [x] 1.2 Split `New` into `newServer`, `wireServices` and `registerRoutes`; replace the route-order comments with the mux's specificity rule; `TestEveryRouteDeclaresAPolicy`, `TestSecurityRoutePolicies` and `TestMuxPrefersSpecificPatternInAnyOrder` pass
- [x] 1.3 Split the assistant turn handler's request reading into `readTurn`; `go test ./internal/httpapi/` passes

## 2. Write path (CORE-22)
- [x] 2.1 Split `Service.apply` into validate, admit/resolve/store per op and finish (`internal/sync/apply.go`); `go test -race ./internal/sync/` passes
- [x] 2.2 Replace `checkKind`'s switch with per-kind checks; `TestKindChecksCoverEveryKind` and `TestCheckKindTable` pass
- [x] 2.3 Split `quickadd.Parse` into a parser with steps; `TestSharedVectors` passes
- [x] 2.4 Split the tenant wiring and `config.Load`; `go test ./internal/tenant/ ./internal/host/ ./internal/config/ ./cmd/...` and `TestOptionalBool` pass

## 3. Importer, CalDAV, agent tools (INT-18)
- [x] 3.1 Split `planForeign` into passes and `plan.go` into own-export and foreign-format files; `go test ./internal/importer/` passes
- [x] 3.2 Split the Things, Todoist, CSV and TickTick readers; `go test ./internal/importer/` passes
- [x] 3.3 Split CalDAV `Decode` and move decoding to `decode.go`; `go test ./internal/caldav/ ./internal/httpapi/` pass
- [x] 3.4 Split `internal/agenttools/write.go` into definitions, helpers, task tools and project tools; `go test ./internal/agenttools/` passes

## 4. Guard
- [x] 4.1 Add `internal/codesize` (150-line functions, 1,100-line files, allow-list with reasons); it fails on the code before this change and passes after
- [x] 4.2 `go vet ./...`, `make staticcheck`, `make fmt-check`, `go test ./...` and `go test -race` on the touched packages pass; `npx @fission-ai/openspec validate --all --strict` passes
