# Tasks

## 1. Composer controls

- [x] 1.1 Mention control (D2): an `at-sign` icon button "Mention someone" in the comment composer's tool row when there are mention targets; it inserts `@` (after a space when needed) at the caret in the rich editor (`RichComposerField` handle) and in the plain field, and opens the completion; verify `npx vitest run src/app/task-detail` (rich and plain: the button, the list with people then groups, the posted body and mentions; no button on a personal task)
- [x] 1.2 Formatting toggle (D3): `EditorToolbar` forced mode, a pressed-state toggle on fine pointers only, Bold from the row on a selection; verify a vitest that toggles the row, applies bold and hides it again
- [x] 1.3 Guest replies and rendering unchanged (D4): verify the existing task page and comment rendering tests pass unchanged, plus a test that a body posted through the API renders with bold and a mention chip

## 2. Stories, docs, catalogs, release

- [x] 2.1 Comment stories show the tool row with the new controls; baselines regenerated in the pinned Playwright image; verify `make ui-lint`
- [x] 2.2 Strings in the five shipped catalogs; verify `node scripts/i18n-check.mjs`
- [x] 2.3 `docs/comments-and-activity.md`, `docs/formatting.md`, CHANGELOG under Unreleased, ROADMAP future idea removed; verify `make docs-check`
- [x] 2.4 Run `make check`; open the pull request and get CI green
