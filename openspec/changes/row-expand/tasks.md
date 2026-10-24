## 1. Rows

- [x] 1.1 `RowDetails` (D3): notes clamp, facet lines, subtasks, counts and Open task, lazily loaded; verify `rowExpand.test.tsx`
- [x] 1.2 `TaskRow` expanded state and disclosure (D2, D5): `expanded`/`onExpand`, `aria-expanded`/`aria-controls`, the touch button, the cluster's Show details; verify `rowExpand.test.tsx` and the existing row action tests
- [x] 1.3 One expanded row per list (D4) in `TaskListView`, the Filter view and saved views; hidden while dragging and while editing in place; verify `rowExpand.test.tsx`
- [x] 1.4 Keys (D1): → and ← in `useListShortcuts` and `useListKeys`, Esc; registry descriptions; verify `shortcuts.test.ts` and `rowExpand.test.tsx`

## 2. Docs, strings and checks

- [x] 2.1 Strings in all six languages; verify `make i18n-check`
- [x] 2.2 `docs/expand-a-row.md` (new, with its screenshot), `docs/interface-guide.md`, `docs/work-from-the-list.md`, `docs/tasks-and-projects.md`, `make docs` for `docs/keyboard.md`, CHANGELOG under Unreleased; verify `make docs-check`
- [x] 2.3 Story and visual check at 360 px and 1280 px, light and dark; verify `make ui-check` and screenshots of the running app
- [x] 2.4 `make check`, `npm test` and `npm run build` in web/, pull request green
