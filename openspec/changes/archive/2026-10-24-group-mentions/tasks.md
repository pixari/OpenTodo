# Tasks

## 1. Server: group mentions

- [x] 1.1 `internal/sync/comments.go`: `filterMentions` keeps `group:<id>` entries of a group in the scope project's created workspace when the writer is a member of that workspace (D2), cached per batch; verify `go test ./internal/sync -run Mention`: kept, other workspace dropped, deleted group dropped, personal scope empty, non-member writer dropped, echo of the filtered value
- [x] 1.2 Expansion when notifying (D3) in `emitMentions` and `emitNoteMentions`: direct ids, then group members who are project members, old list skipped, author skipped, one event per person, `GroupID`/`GroupName` on `notify.Mentioned` for people reached only through a group; verify tests: one notification each for Bob and Carol, none for a group member outside the project, one for a person mentioned directly and through two groups, none on an edit that keeps the group, note mentions alike, assistant comments notify nobody

## 2. Server: filter term

- [x] 2.1 `internal/filter`: the `workspace:` token and term with the shared message for a missing name (D6); verify `go test ./internal/filter` with the docs examples, the formatted fixtures and the error table
- [x] 2.2 Saved views through the API accept `workspace:` and reject a missing name with 400; verify a test in `internal/httpapi` (views)

## 3. Client: group mentions

- [x] 3.1 `web/src/lib/comments.ts`: `mentionTargets` (members, then groups of the project's workspace reaching another member), group ids, `mentionCandidates` people then groups; verify `npx vitest run src/lib/comments` (new tests)
- [x] 3.2 Comment composer (plain and rich), the editor's suggest list and the notes editor use the targets; a group shows with its icon and size; verify `npx vitest run src/app/task-detail` picking a group writes `group:<id>` in `mentions`, and a notes test writes it in `note_mentions`
- [x] 3.3 The group chip in rendered comments and in the editor; the notification list names the group; verify vitest for the chip and the notification text, and a story in `comments.stories.tsx`

## 4. Client: filter term

- [x] 4.1 Parser, printer, builder formatter and evaluator: `workspace:` token and node, `namesWorkspace`, the workspace predicate from the partition, a warning for an unknown name; verify `npx vitest run src/lib/filter` (docs examples, round-trip, fixtures regenerated with `UPDATE_FIXTURES=1`)
- [x] 4.2 Every-workspace evaluation when a query names a workspace in the Filter view, saved views, sidebar counts and dashboards; verify `npx vitest run src/lib/views` with two workspaces
- [x] 4.3 Builder: the Workspace condition and its words; verify `npx vitest run src/app/filter`

## 5. Docs, catalogs, release

- [x] 5.1 Strings in the five shipped catalogs; verify `node scripts/i18n-check.mjs`
- [x] 5.2 `docs/workspaces.md`, `docs/comments-and-activity.md`, `docs/filters.md` (grammar, table, example, error), `docs/api.md` and `docs/sync.md` (`group:` entries), CHANGELOG under Unreleased, ROADMAP row; verify `make docs-check`
- [x] 5.3 Run `make check`; open the pull request and get CI green
