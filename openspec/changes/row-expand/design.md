# Design

## Context

Precision rows (`precision-rows`, `precision-phone`) made every list row one line and moved the facts a row cannot hold to the task page. The task page and the docked panel already render every fact: `FacetLine` and `useFacetParts` (the panel's When, Where, How and Who lines), `Subtasks` (a checklist), `Markdown` (rendered notes). The list's keyboard is `useListShortcuts` (task lists) and `useListKeys` (the Filter view and saved views); the registry in `lib/shortcuts.ts` drives the cheat sheet, the guide and the palette.

## Decisions

### D1. The key: → shows more, ← shows less

- **Free keys in a list are few.** Space ticks (`list.tick`, bulk-actions; the Vim layer relies on it since `x` completes there), and every free letter would be one more thing to learn. → and ← already mean "expand" and "collapse" on a row, but only on a tree row with subtasks; in Today, Upcoming, labels, Views and on every task without subtasks they do nothing.
- **Progressive disclosure, like an outline:** → on a task whose subtasks are folded unfolds them (unchanged); otherwise → shows the details. ← closes the details first, then folds the subtasks, then moves to the parent (unchanged). So the old behaviour is untouched where it applied, and the new one fills the places where the keys did nothing.
- **Esc** closes the details after the pickers and the panel, before it clears the selection.
- **Enter** still opens the task page; Space still ticks.
- **The board** keeps ← and → for columns (its scope overrides the list's), so details are a list feature only.
- **Why not Space?** It would take ticking away from the Vim layer and change bulk-actions' documented key. Recorded as a question for the owner.

### D2. The affordance

- **Fine pointer from 768 px:** the revealed actions (`RowActionCluster`) gain **Show details** / **Hide details** as their first button (`chevron-down`, turned while open), with → in its tooltip. The cluster grows from three to four 24 px targets; a narrow row's trailing group keeps 8 rem for it instead of 7.
- **Touch, and windows under 768 px:** every row ends with one quiet chevron button (`data-row-expand`, `text-faint`, 16 px glyph, 44 px target on a coarse pointer). It is a button, so a tap toggles the details and a horizontal drag that starts on it is still the row's swipe (the swipe takes a row only after 12 px of horizontal movement; a tap never moves). The row's click handler ignores clicks on its own controls, so the tap does not open the task. Always rendered (not only when there is something to show), so the property cell before it lines up down the list.
- **Hidden when it cannot apply:** board cards, compact rows, a departing row, the row being edited in place, and while a drag runs.

### D3. What the details show

Indented under the title column (past the leading slot, the checkbox and the time column), in the row's own surface, no border or card ("quiet, no new boxes"), in this order:

1. **Notes**, rendered with `Markdown`, clamped to about four lines with **Show more** / **Show less** when longer. No editor: the notes are read here.
2. **Facts** as the panel's facet lines (`FacetLine` read-only over `useFacetParts`): When (do date, evening, repeat, deadline, start, reminders), Where (project, section, parent, origin, location), How (priority, estimate, labels), Who (assignee, blocked by, blocks). Only parts with a value; the When line is left out when nothing is scheduled. The words are the panel's, so a fact reads the same in the list, the panel and the page.
3. **Subtasks** with their checkboxes (`Subtasks`, bare), unless the list already shows them as rows under the task (a tree list with the task unfolded). Ticking one completes it through the same op as on the task page; there is no add line (`a` adds a subtask in the list).
4. **One closing line:** the comment and attachment counts (as words with their icons) and **Open task** (the same as Enter).

- **Editable in place:** ticking subtasks only. Viewers of a shared project see the checkboxes disabled.
- **Why not `TaskFacts` (the page's facts column)?** Its labelled grid and group headings are the page's layout and would make each expanded row a small page; the facet lines are one line per facet.
- **The details are a lazy chunk** (`RowDetails`), loaded on first expand; until it arrives nothing is drawn under the row.

### D4. One row at a time, not remembered

- The list keeps one `expandedId`. Expanding another row closes the first; moving the cursor does not close it (the details stay where the user opened them).
- Kept in the view's state only: leaving the list, reloading or switching projects closes it. Nothing is written to IndexedDB, preferences or the op log.
- **Multi-select:** ticking does not change it; the expanded row ticks like any other. **Drag:** while a drag runs no row shows details, so drop zones are measured on one-line rows. **Completion:** a departing row loses its details with it. **Inline editing:** the row being edited shows no details (the editor has its own fields).
- **Large lists:** lists are not virtualised; each row gets a boolean `expanded`, so opening or closing re-renders only the rows that change, and only the open row mounts the details and their live queries.

### D5. Accessibility and motion

- The row's open control and the disclosure carry `aria-expanded` and `aria-controls` pointing at the details (`role="group"`, named "Details of {title}"). Focus stays on the row's open control when → or ← is used; Tab from it reaches the revealed actions, the disclosure, then the details' controls (Show more, subtask checkboxes, Open task), then the next row.
- The details fade in over the ui duration (`row-fade-in`); with reduced motion they appear at once. No height animation, so nothing below jumps twice.
- Clicks and pointer-downs inside the details stay there: they never open the task, start a drag or a swipe.

## Data model

None. Presentation only: no op field, no column, no sync, no migration.

## Interface budget

- Chrome above the list: unchanged (0 new rows).
- Task properties visible by default: unchanged; the details show only on request.
- Sidebar destinations and scroll regions: unchanged.
- Shortcuts: no new key; the → and ← entries of the registry change their descriptions, and the conflict test keeps passing.

## Size

One lazily loaded chunk of a few KB (it reuses the panel's facet code, already in the bundle). No dependency; container image and memory unchanged.

## Risks / Trade-offs

- **→ does two things on a parent with folded subtasks.** The first press unfolds, the second shows details; the cheat sheet says so.
- **A chevron on every touch row** costs about 24 px of a phone row's width; the single property cell keeps its place.
- **The facts are read-only.** Tapping a fact does nothing; the page edits it. This keeps the list free of popovers.
