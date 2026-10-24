## ADDED Requirements

### Requirement: Expanded rows
A task list row SHALL be able to show the task's details directly under it, inside the list, and hide them again, without opening the task page. This SHALL apply to the list layout of Inbox, Today, Upcoming, Anytime, Someday, Completed, Assigned, projects, labels, places, the Filter view and saved views; board cards, the timeline, calendar and Plan rows, the review screens, Close the day and dashboards SHALL NOT expand. With a row selected, → SHALL unfold its subtasks when they are folded and otherwise show its details; ← SHALL hide its details when shown, otherwise fold its subtasks, otherwise select its parent; Esc SHALL hide the details after closing any picker or panel and before clearing the selection; Enter SHALL still open the task page and Space SHALL still tick. On a fine pointer from 768 px the revealed actions SHALL offer Show details (Hide details while shown); on a coarse pointer or below 768 px every row SHALL end with a disclosure button with a target of at least 44 by 44 CSS pixels on touch, which a tap toggles and which SHALL NOT open the task, while a horizontal drag starting on it remains the row's swipe. The details SHALL be indented under the title, on the row's own surface with no border, and SHALL show, in this order: the notes rendered and clamped to about four lines with Show more and Show less when longer; the task's facts in the task panel's words, only those with a value (do date, evening, repeat, deadline, start, reminders, project, section, parent, origin, location, priority, estimate, labels, assignee, blocked by, blocks); the subtasks with their checkboxes, unless the list already shows them as rows under the task; the comment and attachment counts; and Open task. Ticking a subtask there SHALL be the only change made in place and SHALL write the same operation as on the task page, so it works offline and converges per field; viewers of a shared project SHALL see the checkboxes disabled. At most one row of a list SHALL be expanded: expanding another row SHALL hide the first, and moving the cursor SHALL NOT. The expanded row SHALL be kept only while the list is shown: leaving it or reloading SHALL hide it, and nothing SHALL be stored or synced. Ticking SHALL NOT change it; no row SHALL show details while a drag runs or while it is edited in place; a completed row that leaves takes its details with it. The row's open control and the disclosure SHALL expose `aria-expanded` and control the details, a group named after the task; → and ← SHALL leave focus on the row; Tab SHALL reach the details' controls after the row's own. The details SHALL fade in within the ui duration, and appear without motion under reduced motion. Only the expanded row SHALL load the details, and opening or closing them SHALL re-render only the rows that change.

#### Scenario: Expand with the keyboard
- **WHEN** Today lists "Pay rent" with notes and two labels, the user selects it with `j` and presses →
- **THEN** its notes, its facts and Open task appear under the row, focus stays on the row, and its open control is announced as expanded

#### Scenario: Collapse with the keyboard
- **WHEN** the details of the selected row are shown and the user presses ←
- **THEN** the details are hidden and the selection stays on the row

#### Scenario: Folded subtasks first
- **WHEN** a project row has folded subtasks and the user presses → twice
- **THEN** the first press shows the subtask rows and the second shows the details, which leave out the subtask list because the rows are shown

#### Scenario: Esc hides the details
- **WHEN** the details of the selected row are shown, no picker or panel is open, and the user presses Esc
- **THEN** the details are hidden and the row stays selected; a second Esc clears the selection

#### Scenario: Tap on a phone
- **WHEN** a 360 px wide Inbox row is tapped on its disclosure button
- **THEN** the details open under it, the task page does not open, and a second tap hides them

#### Scenario: Swipe still works
- **WHEN** on a touch screen the user drags a row 100 px to the right starting on its disclosure button
- **THEN** the task is completed as with any swipe and the details do not open

#### Scenario: Show details on hover
- **WHEN** the pointer is over a row on a 1280 px screen and the user clicks Show details in the revealed actions
- **THEN** the details open under the row and the action now reads Hide details

#### Scenario: Tick a subtask in place
- **WHEN** the details of a task in Today show its subtasks and the user ticks the first one while offline
- **THEN** the subtask is completed at once, the row's progress count updates, and other devices converge on it after the next sync

#### Scenario: One at a time
- **WHEN** the details of one row are shown and the user expands another row
- **THEN** the first row's details are hidden and the second row's are shown

#### Scenario: Long notes
- **WHEN** a task's notes are twenty lines long and its details are shown
- **THEN** about four lines are shown with Show more, which shows the rest in place

#### Scenario: Not remembered
- **WHEN** a row's details are shown and the user goes to another list and back
- **THEN** no row is expanded and nothing was written to the device's data or synced

#### Scenario: Viewer
- **WHEN** a viewer of a shared project expands a task with subtasks
- **THEN** the details show the subtasks with disabled checkboxes and no fact can be edited

#### Scenario: Drag
- **WHEN** a row's details are shown and the user starts dragging any row of the list
- **THEN** the details are hidden while the drag runs and the drop zones are those of one-line rows

#### Scenario: Board
- **WHEN** a project is shown as a board and the user presses → with a card selected
- **THEN** the selection moves to the next column and no card expands

#### Scenario: Reduced motion
- **WHEN** reduced motion is requested and the user presses →
- **THEN** the details appear at once without fading

## MODIFIED Requirements

### Requirement: Revealed row actions
On a fine pointer from 768 px wide, a row SHALL hold four actions at its right edge, shown while the pointer is over the row or focus is inside it as one small floating cluster on the popover surface: over the end of the property column of a one-line row, and in the place of the trailing group of a narrower row, which keeps room for them: Show details, which shows the task's details under the row as → does (Hide details while they are shown, see "Expanded rows"); Schedule, which opens the same Do on popover as `s` anchored to the row; Priority, which opens the same priority choice as `1` to `4`; and More, which opens the row menu as `.` does. The actions SHALL be real buttons at all times, reachable by Tab from the row's open control and back with Shift+Tab, named with their key in their tooltips, with targets of at least 24 by 24 CSS pixels and 8 px apart (WCAG 2.2 2.5.8), and SHALL never be obscured by the sticky page header, the selection bar or a toast when focused (WCAG 2.2 2.4.11). `j` and `k` SHALL keep moving focus from open control to open control, skipping the actions. Revealing the actions SHALL NOT change the row's height, move the title or the properties, or hide the counts or the properties from assistive technology. On coarse pointers and below 768 px the actions SHALL NOT be rendered; the row menu stays reachable by `.`, the Menu key and long press, and the row's disclosure button shows the details. Every action writes through the same path as its keyboard equivalent, so it works offline and converges per field. A viewer's row SHALL offer Show details only.

#### Scenario: Reveal on hover
- **WHEN** the pointer enters a row with two comments on a 1280 px screen
- **THEN** Show details, Schedule, Priority and More appear in a floating cluster at the row's right edge, the "2" beside the title stays, and the title does not move

#### Scenario: Reveal on focus
- **WHEN** the user presses `j` to focus a row's open control and then Tab
- **THEN** focus moves to Show details, the four actions are visible, Tab moves on to Schedule, Priority and More, Shift+Tab returns, and `j` from the open control skips them

#### Scenario: Schedule from the row
- **WHEN** the user activates Schedule on a row and picks Tomorrow
- **THEN** the task is due tomorrow, the row re-sorts or stays as the view requires, and a toast offers Undo, exactly as `s` then Tomorrow would

#### Scenario: Priority from the row
- **WHEN** the user activates Priority and chooses P1 while offline
- **THEN** the checkbox ring turns P1 at once and the change reaches other devices after the next sync

#### Scenario: Touch screen
- **WHEN** a row is shown on a coarse pointer at 1024 px
- **THEN** no action buttons are rendered, the counts stay, and a long press selects the row so its actions are in the phone bar (bulk-actions "Select with a pointer or on touch")

#### Scenario: Focus not obscured
- **WHEN** the focused More button of the last visible row sits under where a toast appears, and a toast appears
- **THEN** the list scrolls or the toast is placed so that the whole button stays visible

#### Scenario: Viewer of a shared project
- **WHEN** the user is a viewer and hovers a row
- **THEN** only Show details appears, because the row has no edits to offer
