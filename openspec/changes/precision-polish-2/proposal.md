# Proposal

## Why

A second polish round after 0.11.0 (Precision):

- **Bulk label picker race.** `precision-polish` made a pick decide add or remove from the ticked tasks as stored, but the picker's checkmarks still come from the copy the menu held when the picker opened. Opened with `L` before the menu has read the ticked tasks, the picker shows no checks for the whole time it is open, and after a pick it does not show the change; the menu could also show an earlier selection's checks for a moment.
- **Larger text sizes on the remaining screens.** 0.11.0 checked Today, Inbox, a project, Upcoming, All projects, Trash and the weekly review with the browser's text size at 20 and 24 px. A tour of the other screens (Settings in every section, Statistics, Focus, the Loop home, the task page, the command palette and quick add, the main dialogs and menus, sign-in and display mode) at 360 and 1280 px found: the date picker's month grid running off a phone at 24 px; the Share dialog's email field squeezed to two letters beside the role and Share; the Settings profile card cutting the name to "Ada L…" beside the role; the palette's mode switch overlapping "Commands" and "Ask"; Statistics keeping two narrow tile columns that wrap every note word by word; the Inbox's phone header showing "Process 3" beside a title cut to "I" (the phone bar of `precision-phone` came after the 0.11 fix); and a few stylesheet and class breakpoints still in pixels (display mode's columns, the dialog's sheet animation, the wide panel width, Statistics' and the shortcut spotlight's two columns).
- **Three briefing decisions** the owner left open:
  - whether "n tasks are late" ticks the rows or only highlights them;
  - whether Upcoming's "Friday and Monday are already full" links once (to the first day) or once per day;
  - whether Settings has its own switch for the briefing.

## What Changes

- **Bulk labels.** The open label picker follows the menu's read of the ticked tasks: its checks appear when the read lands and change after each pick. Until the read for the current selection lands, it checks nothing rather than an earlier selection's labels. A pick is still decided from the tasks as stored.
- **Larger text sizes.** The faults above are fixed with wrapping, flex bases in rem and rem breakpoints; the audit tour gains a `TEXT_SIZE` setting so the check can be repeated (`TEXT_SIZE=24 make ux-audit`).
- **Briefing decisions:**
  - "n tasks are late" keeps ticking the rows (a selection you can act on at once); the selection bar offers its actions and Escape clears it. This already holds, so nothing changes; a test pins it.
  - Several full days are one link each, each opening that day in Upcoming. The sentence keeps the language's own list pattern and plural; the links are the day names inside it. A single full day still links its whole clause.
  - **Settings → General → Briefing** gets a **Show the briefing** switch: the same synced preference as Hide briefing in the day pages' menu.
- **ROADMAP.md** is brought up to date: Workspaces and groups, the design refresh steps, the Claude plugin and Precision (0.11.0) shipped; the Next table lists the five changes now in progress (`row-expand`, `group-mentions`, `rich-comments`, `ot-completion`, `assistant-on-device`), and the future ideas they cover are removed. The Android app waits for the owner.

Out of scope: new copy beyond the Briefing card and its link labels, new screens, a visual-regression suite at a larger text size (the repository's visual tests run on Storybook stories at the default size; the larger-text check stays a tour), and the Android app.

This follows up the "Precision redesign" ROADMAP item.

No data model change, no migration, no new environment variable. Not breaking.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bulk-actions`: "Labels on several tasks": the open picker's checks follow the stored tasks.
- `web-app`: "Day page briefing": one link per full day; the Settings switch.
- `settings-navigation`: "Account and General section contents": General holds the Briefing card.
- `design-system`: "Breakpoints follow the text size": the stylesheet's own and the class breakpoints are in rem too, and the remaining screens hold at 20 and 24 px.

## Impact

- Web only: `web/src/app` (bulk/BulkActions, menus/ActionMenu, Briefing, PreferencesPanels, SettingsView, settingsIndex, palette/BarParts, review/StatsView, shortcuts/Spotlight, task-list/ListChrome, ShareDialog, ShareDirectory, BrandingPanel, rules/RuleFields, datetime/DateField), `web/src/lib/settingsCopy.ts`, `web/src/index.css`; `scripts/ux-audit/tour.mjs` (`TEXT_SIZE`).
- Docs: `docs/briefing.md`, `ROADMAP.md`, CHANGELOG.
- Bundle size: no dependency; a few hundred bytes.
