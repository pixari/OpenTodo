# Design

## Context

Mentions today (`comments-and-activity` D2, `editor-everywhere` D7): a comment's `mentions` and a task's `note_mentions` are lists of account ids, written by the device next to the Markdown text that holds the `@token`. At receipt the server keeps only ids that are current members of the task's shared project (`resolver.filterMentions`) and stores the filtered list. The author's device takes that list back from the same sync response. After the batch commits, `emitMentions` hands one `notify.Mentioned` per newly listed account to the sinks: the in-app list, the delivery channels, and push through the channels.

Workspaces (`workspaces` D4, D8) cache every workspace's members and groups (id, name, member ids) on the device through the sync response. The server keeps them in `groups` and `group_members`, and a project's workspace is the `workspace_id` of its root project.

The filter language is parsed on the client (`web/src/lib/filter/parse.ts`) and by a Go port that only validates saved views (`internal/filter`). Both run the examples of `docs/filters.md` and the builder's formatted fixtures (`internal/filter/testdata/formatted.txt`). Lists show the current workspace, using the `Partition` rules of `web/src/lib/workspaces.ts`.

## Goals / Non-Goals

**Goals**
- `@Group` in comments and notes notifies the group's members who can see the task, once each, through the existing sinks.
- No new op field, no new route, no migration.
- `workspace:` in the grammar on both sides, in the evaluator and in the builder.

**Non-Goals**
- Notifying people who join a group after the mention, mention lists that grow with the group, `@everyone`, group mentions in project notes, CLI or MCP commands for mentions.

## Decisions

### D1. A group is stored as `group:<group id>` in the existing mention lists
`comment.mentions` and `task.note_mentions` keep their kinds. A group entry is the string `group:` followed by the group's id (42 characters for a UUID, under the 64-character id limit of `note_mentions`).

Why the group's id and not the expanded people:
- The server decides who a group reaches, from its own directory, at the moment it notifies. A device's cached group can be stale, or forged.
- The stored value says what the author wrote. An edit that keeps `@Family` does not re-notify, and the editor can map the mark back to the group.
- Older clients treat the entry as an id they do not know: they never render ids, and the `@Family` text stays readable.

Alternative: expand on the device into member ids. Rejected for the reasons above, and because an edit by a device with a different cache would add or drop people silently.

Alternative: a new field `mention_groups`. Rejected: two lists to keep in step, the same echo logic twice, and nothing gained.

### D2. Filtering at receipt
`filterMentions` keeps a `group:` entry only when all of these hold:
- the scope is a shared project;
- the group exists, is not deleted, and belongs to the project's created workspace (`closedWorkspace` of the scope's project);
- the writer is a member of that workspace.

A personal scope keeps nothing, as before. Results are cached per batch like member checks. A dropped group goes back to the author's device through the existing echo of a modified op. The `@Family` text stays in the body as plain text there, because the device's chip map no longer resolves it to a mention.

### D3. Expansion when notifying
`emitMentions` and `emitNoteMentions` turn the old and new lists into people:
- Direct ids first, then each group's current members who are members of the task's project (`group_members` joined with `project_members`), in list order.
- People reached by the old list (direct or through its groups, at the current membership) are skipped, so editing a comment does not notify again.
- The author is skipped, and each person gets at most one event per change.
- A person reached only through a group gets `GroupID` and `GroupName` on the event (additive, `omitempty`). The in-app notification then reads "Alice mentioned Family on Paint the fence".

Delivery channels keep their message ("Alice mentioned you"). It stays true, and it needs no new strings in the six server catalogs. Comments written by an AI assistant never notify, as before.

### D4. On the device
`mentionTargets()` returns the project's members, followed by the groups of the project's workspace (`Partition.project`) that have at least one other member of the project. Each target is `{userId, name, email, group?}`, so the composer, the editor's suggest list and the Markdown parsers keep using one list:
- `userId` is `group:<id>` for a group, `email` is empty, and `group` holds the number of people it reaches.
- `mentionCandidates` ranks people first (at most six), then groups (at most three) that start with or contain the query.
- The token is the name without spaces, as for people. When a person and a group share a token, the person wins.
- The suggest list shows a group with the group icon and "Group · N people".
- The chip in a rendered comment is the mention chip with the group icon and a tooltip naming the group.
- In the editor, the mark carries `data-mention="group:<id>"`, styled as the same chip with a group outline.

### D5. End-to-end encryption
As for people: the mention ids are plaintext (`mentions`, `note_mentions` are not content fields), and the body or notes are ciphertext. A group's name is directory data the server already holds in plaintext, so naming it in a notification reveals nothing new. The excerpt follows the existing rule.

### D6. The `workspace:` term
- **Grammar.** `"workspace:" name` like `origin:`: the rest of the word, or the next bare word or quoted string (`workspace: Home`, `workspace:"Side projects"`, case-insensitive prefix). An empty name is an error: `Expected a workspace name after "workspace:" at position N`, the same text in Go and TypeScript.
- **Evaluation.** The name is matched against the device's cached workspaces, ignoring case. A task matches when its workspace (the `Partition` rules: its project's root, else its parent task's, else its own `workspace_id`, unknown or null reading as the default) is one with that name. An unknown name warns "No workspace named …" and matches nothing, like a label.
- **Scope.** A query with a `workspace:` term anywhere is evaluated over every workspace's tasks, projects and labels. A query without one keeps the current workspace (the `workspaces` rule).
  - Why: the term is useless if it can only narrow the current workspace, and a filter "across my workspaces" is what was asked for.
  - The sidebar count of a saved view follows the same rule.
- **Builder.** A **Workspace** condition with a choice of the cached workspaces. It is offered when the account has more than one workspace, or when the condition being edited is one. The words are "Workspace is Home".
- **Server.** The Go parser accepts the term and nothing else changes: the server does not evaluate filters. The `ot` CLI and MCP see the query text as before.

### Data-model impact
- No new field. `comment.mentions` and `task.note_mentions` may hold `group:<id>` entries (documented in `docs/sync.md` and `docs/api.md`).
- `notify.Mentioned` gains optional `groupId` and `groupName` in its stored payload.
- No table, no migration, no route.

### Dependencies and footprint
No dependency. Server memory and image size are unchanged. One query per group mention when notifying, and one per distinct group at receipt, cached per batch. Client: a few hundred bytes in the main bundle (filter term, builder kind). The picker changes are in the lazy editor chunk.

### Interface budget
No new chrome row, sidebar destination or scroll region:
- Group entries go in the existing mention list, after people.
- The builder gains one condition kind in its existing dialog.
- No new shortcut.

## Implementation notes (apply step)

- **Server.** The group rules live in `internal/sync/groupmentions.go`: `keepMention` (receipt, cached in the resolver's assignable map under a `group` key), `reach` (expansion, one query per group), and `newlyMentioned` in `comments.go`, shared by comment and note mentions. An expansion query that fails leaves that group out, because notifying is best effort like the sinks.
- **Writer check.** The writer must be a member of the group's workspace. A person shared on a project before it moved into a workspace (`workspaces` "Legacy share after a move") cannot mention its groups. They cannot see them in their cache either.
- **Scope of a `workspace:` query.** `filterScope` in `web/src/lib/filter/evaluate.ts` swaps in every workspace's tasks, projects and labels. `compile` uses it for name resolution, and `runFilter`, `compileView`/`runView`/`evaluateViews`, the Filter view and the palette use it to choose what they iterate. `web/src/app/useWorkspaceFilter.ts` builds the data from the live snapshots, with the `Partition` over every project and task. With one workspace there is nothing to widen, but `workspace: Personal` still matches.
- **Builder.** The Workspace condition is a select of the cached workspace names. The dialog's "Filter on" list offers it after Origin.
- **Chip.** `MarkdownView` takes `mentionGroups` (the tokens that are groups) and renders the chip with the `users` icon. The editor styles `.mention[data-mention^="group:"]` with an outline. `mentionChipsOf` keeps the person when a person and a group share a token.
- **Story.** `Task/Comments/GroupMention`, with its four baselines generated in the pinned Playwright image.

## Risks / Trade-offs

- [A large group spams] → A group can hold at most 100 people (workspace limits). Expansion is limited to project members, and each person gets one notification per change.
- [Rename makes old `@token` text stale] → The same as renaming a person. The stored id still names the group, and the text is what the author wrote.
- [Token collision between a person and a group] → The person wins, deterministically, on every device.
- [A query naming a workspace is heavier] → It evaluates every workspace's tasks, the same set the palette already reads.

## Migration Plan

None. Old clients keep working. They show `@Family` as text and send no group ids.

## Open Questions

None blocking. Whether a delivery-channel message should name the group is left for later. It would need new strings in the server's six catalogs.
