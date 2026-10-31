## 1. Sort model and stored options

- [x] 1.1 Add dynamic field:<definition-id> options to project, label, saved-view and New view display controls; verify defaults and ID writes in listDisplay.test.ts, listDisplayPanel.test.tsx and views.test.ts.
- [x] 1.2 Match names case-insensitively against live, applicable definitions, including inherited fields; resolve each task by applicable-field order; verify cross-project and inheritance behavior in `views.test.ts` and `listDisplay.test.ts`.
- [x] 1.3 Compare Number values numerically, Date values chronologically and Number before Date before Text across matching types; verify ascending, descending, missing-last and tie behavior in `views.test.ts`.
- [x] 1.4 Accept canonical UUID field sort values on saved-view create and patch, preserve them, and reject field names or malformed IDs; verify with go test ./internal/httpapi.

## 2. List behavior and regression coverage

- [x] 2.1 Apply custom-field ordering within existing view groups and project sections while preserving subtasks, Later and Completed placement.
- [x] 2.2 Verify project moves switch a project using a custom-field sort back to Manual order before moving the task.
- [x] 2.3 Add behavior tests for number/date/text ordering, both directions, missing values, ties, same-named fields across projects, case-insensitive matching, inherited-name resolution and unknown stored values.
- [x] 2.4 Verify project lists, label pages, saved views and New view in `viewsAndDisplay.test.tsx` and `listDisplayPanel.test.tsx`, including API create and patch.

## 3. Documentation and checks

- [x] 3.1 Update project, label, saved-view, API, CLI and E2EE documentation for definition IDs, local name matching and encrypted field names; add the custom-fields cross-reference and Unreleased changelog entry.
- [x] 3.2 Run relevant tests, `make check`, and the required UI checks; record any environment limitations.
