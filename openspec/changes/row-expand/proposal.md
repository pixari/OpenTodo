# Proposal

## Why

Since 0.11.0 (Precision) every task list shows one line per task, and Enter or a click opens the task as a full page. A user asked on Reddit for "one line, with a key to expand a row when I need the details". Today the only way to read a task's notes, its subtasks or the facts the row leaves out is to leave the list, and on a phone the row keeps a single property.

## What Changes

- **Expand a row in place.** A task's details open directly under its row, inside the list, and close again; the list does not move away and nothing else on screen changes.
- **The key is → (and ← closes).** → on the selected task first unfolds its subtasks when they are folded (as today), otherwise it shows the details; ← first closes the details, then folds the subtasks, then goes to the parent (as today). In date-sorted lists, where → and ← did nothing, they open and close the details. Esc also closes them. Space keeps ticking.
- **A pointer and touch affordance.** On a fine pointer from 768 px, the row's revealed actions gain a fourth action, **Show details** (first in the cluster); elsewhere (touch, and narrow windows) every row ends with a quiet chevron button with a 44 px target, which a swipe does not trigger.
- **What the details show, read-mostly:** the notes rendered (about four lines, then **Show more**), the facts in the task panel's words (When, Where, How, Who: dates, start, deadline, repeat, reminders, project, section, parent, location, origin, priority, estimate, labels, assignee, blocked by), the subtasks with their checkboxes when the list does not already show them as rows, the comment and attachment counts, and **Open task**. Ticking a subtask is the only edit in place; every other change still happens on the task page.
- **One row at a time**, lists only, not remembered: it closes when the list is left or reloaded.

Out of scope:
- Board cards, the timeline, the calendar and Plan, the review screens, Close the day, dashboards and the method screens (they keep their own keys and shapes).
- Editing facts in place (dates, labels, priority): the inline editor (F2) and the task page do that.
- Remembering which row was open across sessions or devices.

ROADMAP: this advances the Precision follow-up for list reading (no separate ROADMAP item; recorded as `row-expand`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `task-list-presentation`:
  - ADDED "Expanded rows": the details under a row, the key, the affordance, what they show, one at a time, accessibility and motion;
  - MODIFIED "Revealed row actions": four actions, Show details first.

## Impact

- **Web:** `app/TaskRow.tsx` (the expanded prop, the disclosure, the details slot), a new `app/task-list/RowDetails.tsx` built from the task page's parts (`FacetLine`, `useFacetParts`, `Subtasks`, `Markdown`), `app/task-list/RowActionCluster.tsx`, `app/task-list/useListShortcuts.ts`, `app/useListKeys.ts`, `app/task-list/ListGroups.tsx`, `app/TaskListView.tsx`, `app/FilterView.tsx`, `app/SavedViewView.tsx`, `lib/shortcuts.ts` (the → and ← descriptions), `index.css` (the phone slot), new strings in six languages.
- **Server, API, sync, data:** none. No op field, nothing synced, no migration, no environment variable.
- **Bundle:** the details are a lazily loaded chunk; the list's own code grows by under 2 KB. No dependency.
