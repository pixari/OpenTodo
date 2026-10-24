# Design

## Context

`precision-polish` (0.11.0) fixed the bulk label pick and the larger-text faults on the screens Precision redrew. This change closes the rest of that list and the three briefing questions the owner left open ("you decide").

## Decisions

### D1. The open picker follows the menu's groups

`ActionMenu` stored the picker spec it opened with, so a picker's `selected` (the bulk labels' common set) was frozen at the moment `L` opened it, usually before the menu's live query had read the ticked tasks. The menu now stores the open picker's item id and renders the picker from the current groups on every render, falling back to the stored spec when the item is gone. The same holds for every picker of every action menu, which is what a reader expects of a live list.

`useBulkData` tags its read with the selection key it was made for; a read for another selection counts as no read. So a new selection never shows the previous selection's checks.

The add-or-remove decision stays at the pick, from the stored tasks (`precision-polish`); with D1 the checks shown and the action taken agree as soon as the read lands, which on a local IndexedDB read is a frame or two. Disabling the picker until the read lands was considered and refused: `L` opens the picker directly, and a disabled picker would make the shortcut do nothing on a fast keypress.

### D2. Larger text: wrap, base in rem, breakpoints in rem

The tour (`scripts/ux-audit/tour.mjs`, new `TEXT_SIZE`) sets Chromium's default font size through the DevTools protocol (`Page.setFontSizes`), the same effect as the browser's text size setting, and was run at 16, 20 and 24 px on Settings (all eleven sections and Workspaces), Statistics, Focus, the Loop home, the task page and the public task page, the command palette, quick add, the add menu, the bulk, project, section, label and view menus, the share, template, fields and duplicate dialogs, the label picker and When popover, sign-in and forgot-password, and display mode (Today, Upcoming, a project), at 360 and 1280 px in light. Findings that also appear at 16 px (a 5 px overlap of the sidebar's fold chevron and project row, the scrolled-under floating add button) are not text-size faults and are left.

Fixes, each keeping the default text size unchanged:
- Flex items that must keep a readable width get a rem flex basis (`flex-[1_1_14rem]`, `flex-[1_1_8rem]`) inside a wrapping row, so the row wraps instead of squeezing them: the Share dialog's email field and the workspace directory's person picker, the profile card's name (the role wraps under it).
- Fixed widths get `max-w-full` (branding name, rule trigger), rows that hold a label and a control wrap (rule fields).
- The palette's mode switch wraps (`flex-wrap`, `flex-auto`) instead of overlapping.
- The date picker's month grid is `table-fixed`, and on touch its day cells lose their padding: seven 44 px targets fit 324 px, the room a phone at 24 px leaves.
- Pixel breakpoints become rem: the stylesheet's display-mode columns (48 rem), board split (64 rem), the dialog card animation (40 rem, matching the script's sheet placement), the panel width (90 rem); the class breakpoints of the Statistics tiles (`min-[21.25rem]`) and the shortcut spotlight (`min-[25rem]`).
- The phone header's **Process {count}** keeps only its icon below 21 rem of viewport, like the desktop header's Process since 0.11 (`design-system` "Breakpoints follow the text size" already allows it).

Visual tests: the repository's visual regression runs on Storybook stories at the default text size (`make ui-check`); there is no pattern for a larger text size there, and adding one would double every baseline. The interaction tests cover the briefing and bulk changes; the larger-text check is the tour, now repeatable with `TEXT_SIZE`.

### D3. Briefing: three decisions

- **(a) "n tasks are late" ticks the rows.** A selection is something to act on at once (reschedule them all), where a passing highlight would only point. `briefing-links` already ticks them, the selection bar shows "2 selected" with Actions, and Escape clears the ticks. Nothing changes; a test pins the bar and Escape.
- **(b) One link per full day.** "Friday and Monday are already full" becomes two links, Friday and Monday, each opening Upcoming at its day (`openUpcomingDay`). The clause is built by the message layer as before: the day list goes through the language's list pattern (`Intl.ListFormat` outside English) with a private-use mark per day, the plural picks "is" or "are" from the count, and the marks are then replaced by the links, so the sentence stays one translated message in all six languages (checked: de, es, fr, it, pt use `{days}` as one unit with the plural on `n`; nothing in the catalogues changes). A clause that starts the sentence capitalises its first visible part ("Venerdì e lunedì…"). A single full day keeps linking its whole clause, as on Today ("Monday is already full"), so the link is the sentence part people read. Each day link is named "{day}, open in Upcoming".
- **(c) A switch in Settings.** **Settings → General → Briefing** with one row, **Show the briefing**: the same `user_prefs.briefing` field the day pages' menu writes, so either place changes both, on every device after sync. The card says it is synced ("On all your devices") and its Learn more opens the briefing guide's "Hide it" section (`settings/briefing`). The search index lists it.

## Data model

None. `user_prefs.briefing` exists since `briefing-links`.

## Interface budget

No chrome above a list changes; the Process button loses its word only below 21 rem. One new settings card in General; no new shortcut, no new sidebar destination.

## Size

No dependency. A few hundred bytes of JavaScript and CSS.

## Risks

- Re-reading the picker spec from the groups on each render changes nothing for pickers whose groups are stable; for one whose item disappears while open (a disabled-by-state item is still listed) the stored spec keeps it open.
