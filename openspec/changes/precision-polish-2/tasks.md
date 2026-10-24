## 1. Bulk label picker

- [x] 1.1 `ActionMenu` renders the open picker from the current groups by item id (D1); verified by `web/src/app/bulk/bulk.test.tsx` "L then errand adds it…" (the check appears after the pick) and "a picker opened before the read marks the common label once the read lands", both failing without the change.
- [x] 1.2 `useBulkData` tags its read with the selection key, so another selection's checks never show; verified by the same tests and `npm test`.

## 2. Larger text sizes

- [x] 2.1 `scripts/ux-audit/tour.mjs` takes `TEXT_SIZE` (Chromium's default font size through DevTools); verified by running the tour at 16, 20 and 24 px on the screens of the proposal at 360 and 1280 px.
- [x] 2.2 Fix the faults (D2): date picker grid, Share dialog and workspace directory fields, profile card, palette modes, Statistics tiles, spotlight columns, stylesheet media queries, branding and rule fields, the phone header's Process; verified by re-running the tour at 24 px (the When popover, Share, Settings, the palette, the Inbox and Statistics) and `npm test`, `npm run build`.

## 3. Briefing

- [x] 3.1 (a) Pin "n tasks are late" as a selection: `web/src/app/briefingLinks.test.tsx` checks the bar ("2 selected", Actions) and that Escape clears it.
- [x] 3.2 (b) One link per full day built inside the translated sentence; verified by `web/src/app/Briefing.test.tsx` (English links and labels, three days, and the clause in de, es, fr, it, pt).
- [x] 3.3 (c) Settings → General → Briefing with "Show the briefing" (`settingsCopy`, `PreferencesPanels`, `settingsIndex`); verified by `briefingLinks.test.tsx` "the switch and the day pages' menu are one synced preference" and the settings copy and search tests.

## 4. Docs

- [x] 4.1 `docs/briefing.md`: per-day links, the Settings switch, `settings/briefing` screen; `make docs` regenerates Help; verified by `make docs-check`.
- [x] 4.2 ROADMAP.md brought up to date (shipped items, Precision, the five changes in progress, future ideas trimmed, Android waiting for the owner).
- [x] 4.3 CHANGELOG "Unreleased" entries for the bulk picker, larger text and the briefing.
- [x] 4.4 `make check` passes.
