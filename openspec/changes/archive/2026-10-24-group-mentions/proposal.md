# Proposal

## Why

Workspaces brought groups ("Adults", "Design team") and sharing a project with a group in one step. Two things people ask for next were recorded as follow-ups of `workspaces` (ROADMAP.md "Workspaces and groups"):

- Telling a whole group about something. Today a comment that should reach the four adults of a household mentions four people, one by one, and a fifth person added to the group later is never part of that habit.
- Filtering by workspace. Every list shows the current workspace, and the filter language cannot name one, so "everything due this week, at work and at home" is two switches and two lists.

## What Changes

- **Group mentions.** In a comment or in a task's notes, `@Family` mentions the workspace group Family:
  - The mention picker offers the groups of the task's workspace after the people.
  - A group mention reads as a group chip in the thread and in the notes.
  - It notifies every member of the group who can see the task, through the existing notification paths (the in-app list, delivery channels, push). Nobody outside the project is ever notified.
  - A person mentioned twice (directly and through a group, or through two groups) gets one notification. The one they get through a group names it: "Alice mentioned Family on Paint the fence".
- **Stored as the group's id.** The mention lists that exist today (`comment.mentions`, `task.note_mentions`) carry the group as `group:<group id>`, next to member ids. The server keeps a group only when it belongs to the project's workspace and the writer is a member of that workspace, and expands it to people only when it notifies. No new field; the op log stays additive.
- **A `workspace:` filter term.** `workspace: Home`, `workspace:"Side projects"` matches the tasks of the named workspace, ignoring case. A query that names a workspace looks at every workspace's tasks, so `workspace: Work | workspace: Home` lists both; a query without one keeps showing the current workspace only. Tasks without a project belong to a workspace through their own `workspace_id`.
  - The TypeScript parser and evaluator and the Go parser that validates saved views accept the same term with the same messages, pinned by the shared examples.
  - The filter builder gets a **Workspace** condition ("Workspace is Home").

Out of scope:
- Mentioning a whole project ("@everyone") or a workspace.
- Showing the members of a group inside the chip, or notifying people who join a group after the mention.
- Group mentions in project notes (project notes have no mentions yet).
- Mentions or workspace filters in the CLI and MCP beyond what they already do. Saved views written through the API are validated by the Go parser, so they accept `workspace:` without further change. A comment written through the REST API may carry `group:<id>` in `mentions`. Comments written by an AI assistant still never notify anyone.
- `workspace:` in quick add, and server-side evaluation of filters (the server still only validates).

ROADMAP.md: completes the two follow-ups recorded on the "Workspaces and groups" row (`workspaces`). No new environment variable. The op log stays additive: no new field, and a value older clients do not understand is an id they ignore. Nothing here is **BREAKING**.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workspaces`: a new requirement, group mentions: what is stored, who is notified, how the picker and the chip look.
- `filter-queries`: a new requirement, workspace terms, in the grammar, the evaluator, the Go validator and the builder.

## Impact

- Server: `internal/sync/comments.go` (filtering `group:` ids at receipt, expanding them when notifying), `internal/notify` (an optional group on `Mentioned`), `internal/filter` (the term).
- Client: `web/src/lib/comments.ts` (groups as mention targets, candidates), `web/src/app/EditorChrome.tsx`, `web/src/app/task-detail/Composer.tsx`, `web/src/app/task-detail/CommentsTab.tsx`, `web/src/app/NotesEditor.tsx`, `web/src/app/MarkdownView.tsx` (the group chip), `web/src/app/NotificationBell.tsx`, `web/src/lib/filter/*` (parser, evaluator, builder), `web/src/app/filter/*`, the Filter view, saved views and sidebar counts (every workspace's tasks when a query names a workspace), five translation catalogs.
- Docs: `docs/workspaces.md`, `docs/comments-and-activity.md`, `docs/filters.md`, `docs/api.md`, `docs/sync.md`, CHANGELOG.
- No dependency, no migration, no new route.
