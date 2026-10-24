// The shortcut registry (OpenSpec change ux-overhaul, keyboard-shortcuts "One
// shortcut registry with scopes", design D5): every keyboard shortcut declared once,
// with its keys, its scope and the section it is listed under. The dispatcher in
// `web/src/app/shortcuts` resolves a key press against this table and the scopes
// on screen; the `?` cheat sheet, the keyboard guide (`make docs` writes it into
// docs/keyboard.md) and the command palette's shortcut column read the same rows,
// so the four never disagree. `shortcuts.test.ts` fails on two entries that bind
// the same keys in one scope, or in a scope and an ancestor scope, without an
// explicit `overrides`.

export type ShortcutSection = 'everywhere' | 'go' | 'tasks' | 'board' | 'calendar' | 'filter' | 'trash' | 'triage' | 'focus' | 'review' | 'display' | 'comments' | 'settings' | 'vim'

/**
 * Where a shortcut applies. The dispatcher runs the innermost active scope first:
 * `global` → `view` (one named view) → `list` | `calendar` → `board` | `timeline`
 * (a project's layouts) → `panel` → `editor`; `vim` sits on top of all of them
 * while the layer is on.
 */
export type ShortcutScope = 'global' | 'view' | 'list' | 'panel' | 'board' | 'timeline' | 'calendar' | 'editor' | 'vim'

/** One registry entry. */
export interface Shortcut {
  /** Stable id, `<scope or area>.<action>`; handlers register against it. */
  id: string
  /**
   * The chords that run the action, each as shown to people: `Shift+K`, `Ctrl+K`,
   * `⌘+K`, `Alt+Shift+↑`, `g i` (a sequence), `Esc`, `Space`. Alternatives of one
   * action are separate items and are shown joined by " / ".
   */
  keys: string[]
  /** What it does, the action first. */
  description: string
  /**
   * A short name (at most 24 characters) where space is short: the sequence spotlight
   * and the cheat sheet. Required for sequences. `Name|context` picks a catalog context.
   */
  label?: string
  section: ShortcutSection
  scope: ShortcutScope
  /** For the `view` scope: the route views it applies to. */
  views?: string[]
  /** The state it needs, shown after the keys in the sheet and the guide ("ticked tasks"). */
  when?: string
  /** Fires while a text field has focus (most shortcuts do not). */
  typing?: boolean
  /** Fires while a dialog is open (global shortcuts always do). */
  dialog?: boolean
  /** Does not call `preventDefault` after running (the key keeps its default too). */
  passive?: boolean
  /** Handled by the control itself (an input's Enter, the notes editor's keymap), never by the dispatcher; listed for the sheet and the guide. */
  local?: boolean
  /** Ids this entry deliberately shadows: a sibling in the same scope or an entry in an ancestor scope. */
  overrides?: string[]
  /** A row of the sheet and the guide that is not a key: a gesture, a typing rule. Never dispatched. */
  note?: boolean
  /** Dispatched but not listed (the per-scope Escape chain; one row says "Esc"). */
  hidden?: boolean
}

/** Section titles of the sheet and the keyboard guide, in order. */
export const SHORTCUT_SECTIONS: { id: ShortcutSection; title: string }[] = [
  { id: 'everywhere', title: 'Everywhere' },
  { id: 'go', title: 'Go to a view' },
  { id: 'tasks', title: 'Tasks in a list' },
  { id: 'board', title: 'Board and timeline' },
  { id: 'calendar', title: 'Day, Week, Month and Plan calendar' },
  { id: 'filter', title: 'Views and boards' },
  { id: 'trash', title: 'Trash and projects' },
  { id: 'triage', title: 'Process the Inbox' },
  { id: 'focus', title: 'Focus' },
  { id: 'review', title: 'Reviews' },
  { id: 'display', title: 'Display mode' },
  { id: 'comments', title: 'Comments and notes' },
  { id: 'settings', title: 'Settings' },
  { id: 'vim', title: 'Vim keybindings' },
]

/**
 * Which scopes a route view hosts: the conflict test uses it to tell whether a
 * `view` entry and a `list`, `board` or `calendar` entry can ever be active at the
 * same time (the Trash has no task list, so its `j` never meets the list's).
 */
export const VIEW_SCOPES: Record<string, ShortcutScope[]> = {
  inbox: ['list'], today: ['list'], upcoming: ['list'], anytime: ['list'], someday: ['list'], completed: ['list'], assigned: ['list'],
  project: ['list', 'board', 'timeline'], label: ['list'], filter: ['list'], view: ['list', 'board'], views: [], labels: [],
  // The Month view keys are its own `view` entries (month-and-timeline-views): it hosts no lane-and-blocks calendar.
  dashboard: [], day: ['calendar'], week: ['calendar'], month: [], plan: [], trash: [], feed: [], ask: [], import: [], settings: [], share: [], task: ['panel'], help: [],
  // Process the Inbox (inbox-triage): one card, no task list; its keys are `view` entries.
  triage: [],
  // Display mode (display-mode D5): no shell, no list; its keys are `view` entries.
  display: [],
  // The reviews (open-loops-method D6): the project walk's and the Daily check's keys are
  // `view` entries; the step lists pause their list keys while the walk owns the keyboard.
  review: [],
  // Open Loops (open-loops-method D9): Next and Waiting are lists; the Loop home is tiles.
  next: ['list'], waiting: ['list'], loop: [],
  // Focus (focus-mode D7): one task and a timer, no list; Space, Enter, b, n and Esc are its `view` entries.
  focus: [],
}

/** The scopes an entry in `scope` shadows when it binds the same keys (`vim` shadows every scope). */
export const SCOPE_ANCESTORS: Record<ShortcutScope, ShortcutScope[]> = {
  global: [],
  view: ['global'],
  list: ['view', 'global'],
  calendar: ['view', 'global'],
  board: ['list', 'view', 'global'],
  timeline: ['list', 'view', 'global'],
  panel: ['board', 'timeline', 'list', 'calendar', 'view', 'global'],
  editor: ['panel', 'board', 'timeline', 'list', 'calendar', 'view', 'global'],
  vim: ['editor', 'panel', 'board', 'timeline', 'list', 'calendar', 'view', 'global'],
}

/** Every shortcut, in the order the sheet and the guide list them within a section. */
export const SHORTCUTS: Shortcut[] = [
  // ---- everywhere
  { id: 'global.palette', keys: ['Ctrl+K', '⌘+K'], description: 'Search and commands: find any task, project, label, view or setting, or run a command by name (also while typing, except in notes)', section: 'everywhere', scope: 'global', typing: true, dialog: true },
  // Global since moments-and-onboarding D11: a list's own quick add where there is one, else the command bar in Add mode.
  { id: 'list.quick-add', keys: ['q'], description: 'Quick add a task (the command bar in Add mode on screens without a quick add)', section: 'everywhere', scope: 'global' },
  // The command bar's prefixes (moments-and-onboarding D7): characters typed into the bar, not shortcuts.
  { id: 'note.bar-prefixes', keys: ['+ · > · ? (first character in the command bar)'], description: 'Add a task, run a command, ask the assistant; the same character again returns to Search', section: 'everywhere', scope: 'global', note: true },
  { id: 'palette.add-task', keys: ['Ctrl+Enter', '⌘+Enter'], description: 'In the command bar: add what you typed as a task', section: 'everywhere', scope: 'global', local: true },
  { id: 'palette.add-open', keys: ['Shift+Enter'], description: 'In the command bar\'s Add mode: add the task and open it', section: 'everywhere', scope: 'global', local: true },
  { id: 'palette.fields', keys: ['↓', '↑'], description: 'In the command bar\'s Add mode: move over the fields; Tab edits the highlighted one', section: 'everywhere', scope: 'global', local: true },
  { id: 'global.assistant', keys: ['Shift+I'], description: 'Open the assistant (when the server owner has turned it on): ask about your tasks, review proposed changes; Enter sends, Esc closes', section: 'everywhere', scope: 'global' },
  { id: 'assistant.review', keys: ['Enter', 'Esc'], description: 'Apply the checked changes / discard the proposal; Space toggles an item', section: 'everywhere', scope: 'global', local: true, when: 'proposed changes', overrides: ['list.open', 'list.escape', 'calendar.escape', 'month.open', 'month.escape', 'plan.open', 'plan.escape', 'feed.open', 'dashboard.open', 'trash.confirm', 'trash.escape', 'dashboard.escape', 'share.escape', 'panel.escape', 'task.escape', 'list.archive-offer'] },
  { id: 'list.dictate', keys: ['Shift+V'], description: 'Dictate into quick add (turn voice capture on in Settings first); Esc or a pause stops, Enter saves', section: 'everywhere', scope: 'list' },
  { id: 'list.dictate-stop', keys: ['Esc'], description: 'Stop dictating', section: 'everywhere', scope: 'list', hidden: true, typing: true, overrides: ['list.escape', 'panel.escape'] },
  { id: 'global.row-menu', keys: ['.', 'Shift+F10', 'Menu'], description: 'Open the menu of the focused row: a label, view, section heading or project', section: 'everywhere', scope: 'global', local: true },
  { id: 'labels.rename', keys: ['F2'], description: 'Rename the label in place; Alt+↑ / Alt+↓ move it, Alt+Shift+↑ / ↓ to the top / bottom', section: 'everywhere', scope: 'view', views: ['labels'], local: true, when: 'focused label' },
  { id: 'list.escape', keys: ['Esc'], description: 'Close the panel or the picker, else clear the selection', section: 'everywhere', scope: 'list', typing: true },
  { id: 'global.help', keys: ['?'], description: 'Toggle this cheat sheet', section: 'everywhere', scope: 'global' },
  { id: 'global.sidebar', keys: ['['], description: 'Collapse or expand the sidebar (from 1024 px)', section: 'everywhere', scope: 'global' },
  { id: 'global.undo-bulk', keys: ['Ctrl+Z', '⌘+Z'], description: 'Undo the last bulk action', section: 'everywhere', scope: 'global', when: 'while its notice is shown' },

  // ---- go to
  { id: 'go.inbox', keys: ['g i'], label: 'Inbox', description: 'Go to Inbox', section: 'go', scope: 'global' },
  { id: 'go.today', keys: ['g t'], label: 'Today', description: 'Go to Today', section: 'go', scope: 'global' },
  { id: 'go.upcoming', keys: ['g u'], label: 'Upcoming', description: 'Go to Upcoming', section: 'go', scope: 'global' },
  { id: 'go.anytime', keys: ['g n'], label: 'Anytime', description: 'Go to Anytime', section: 'go', scope: 'global' },
  { id: 'go.someday', keys: ['g o'], label: 'Someday', description: 'Go to Someday', section: 'go', scope: 'global' },
  { id: 'go.assigned', keys: ['g a'], label: 'Assigned to me', description: 'Go to Assigned to me', section: 'go', scope: 'global' },
  { id: 'go.completed', keys: ['g c'], label: 'Completed', description: 'Go to Completed', section: 'go', scope: 'global' },
  { id: 'go.labels', keys: ['g l'], label: 'Labels', description: 'Go to Labels', section: 'go', scope: 'global' },
  { id: 'go.projects', keys: ['g Shift+P'], label: 'All projects', description: 'Go to All projects: every project with its health, find a project, archived projects', section: 'go', scope: 'global' },
  { id: 'go.filter', keys: ['g f'], label: 'New view', description: 'Open New view: build a query, then save it as a view', section: 'go', scope: 'global' },
  { id: 'go.views', keys: ['g v'], label: 'Views', description: 'Go to Views: saved views and boards', section: 'go', scope: 'global' },
  { id: 'go.day', keys: ['g d'], label: 'Day', description: 'Go to the Calendar as Day (the sidebar opens it as last used)', section: 'go', scope: 'global' },
  { id: 'go.week', keys: ['g w'], label: 'Week', description: 'Go to the Calendar as Week', section: 'go', scope: 'global' },
  { id: 'go.month', keys: ['g m'], label: 'Month', description: 'Go to the Calendar as Month', section: 'go', scope: 'global' },
  // The Plan (planner-view D1): `g p` is the Inbox's triage and `g Shift+P` All projects, so the Calendar's plan takes the shifted C.
  { id: 'go.plan', keys: ['g Shift+C'], label: 'Plan', description: 'Go to the Calendar as Plan: the next days as columns with their capacity', section: 'go', scope: 'global' },
  { id: 'go.trash', keys: ['g x'], label: 'Trash', description: 'Go to the Trash', section: 'go', scope: 'global' },
  { id: 'go.triage', keys: ['g p'], label: 'Process Inbox', description: 'Process the Inbox one task at a time', section: 'go', scope: 'global' },
  { id: 'go.feed', keys: ['g h'], label: 'Updates', description: 'Go to Updates: what changed in your shared projects', section: 'go', scope: 'global' },
  { id: 'go.ask', keys: ['g k'], label: 'Assistant', description: 'Go to the Assistant page: the conversation and its skills (when the assistant is on)', section: 'go', scope: 'global' },
  { id: 'go.settings', keys: ['g s'], label: 'Settings', description: 'Go to Settings', section: 'go', scope: 'global' },
  { id: 'go.import', keys: ['g Shift+I'], label: 'Import data', description: 'Go to Settings → Data → Import data', section: 'go', scope: 'global' },
  { id: 'go.help', keys: ['g ?'], label: 'Help', description: 'Open Help: the user guide, offline, with search', section: 'go', scope: 'global' },
  // Weekly review and Statistics (stats-and-review).
  { id: 'go.review', keys: ['g r'], label: 'Review', description: 'Go to the weekly Review', section: 'go', scope: 'global' },
  { id: 'go.stats', keys: ['g Shift+S'], label: 'Statistics', description: 'Go to Statistics: what you completed, created and let slip', section: 'go', scope: 'global' },
  { id: 'go.loop', keys: ['g Shift+L'], label: 'Loop home', description: 'Go to the Loop home: the five moves of Open Loops at a glance', section: 'go', scope: 'global' },
  { id: 'go.next', keys: ['g Shift+N'], label: 'Next|method', description: 'Go to Next: the next action of every project, by context', section: 'go', scope: 'global' },
  { id: 'go.waiting', keys: ['g Shift+W'], label: 'Waiting|method', description: 'Go to Waiting: what is assigned to someone else or blocked', section: 'go', scope: 'global' },
  { id: 'go.daily', keys: ['g Shift+R'], label: 'Daily check|method', description: 'Go to the Daily check: the Inbox, what is open from earlier, today\'s focus', section: 'go', scope: 'global' },
  // Close the day (close-the-day D6): `g d` is the Day calendar and `Shift+D` alone duplicates in a list; a `g` sequence meets neither.
  { id: 'go.close', keys: ['g Shift+D'], label: 'Close the day', description: 'Close the day: how it went, carry over what is left, a line for tomorrow', section: 'go', scope: 'global' },
  { id: 'go.focus', keys: ['g Shift+F'], label: 'Focus', description: 'Go to Focus: one task, a timer, a break when you need one', section: 'go', scope: 'global' },
  { id: 'go.find', keys: ['g /'], label: 'Find in sidebar', description: 'Find a project, label or filter in the sidebar (opens the sidebar when it is collapsed or a drawer)', section: 'go', scope: 'global' },

  // ---- tasks in a list
  { id: 'list.down', keys: ['j', '↓'], description: 'Move the selection down', section: 'tasks', scope: 'list' },
  { id: 'list.up', keys: ['k', '↑'], description: 'Move the selection up', section: 'tasks', scope: 'list' },
  { id: 'list.open', keys: ['Enter'], description: 'Open the selected task; accept "complete parent too?"', section: 'tasks', scope: 'list' },
  { id: 'list.complete', keys: ['c'], description: 'Complete / reopen the selected task (and its subtasks), or the ticked tasks', section: 'tasks', scope: 'list' },
  { id: 'list.add-subtask', keys: ['a'], description: 'Add a subtask to the selected task', section: 'tasks', scope: 'list' },
  { id: 'list.assign', keys: ['Shift+A'], description: 'Assign the selected task, or the ticked tasks (type to find a member, Enter assigns)', section: 'tasks', scope: 'list' },
  { id: 'list.indent', keys: ['Tab'], description: 'Indent the selected task under the previous sibling', section: 'tasks', scope: 'list' },
  { id: 'list.outdent', keys: ['Shift+Tab'], description: 'Outdent the selected task', section: 'tasks', scope: 'list' },
  { id: 'list.move-up', keys: ['Alt+↑'], description: 'Move the selected task, or the focused sidebar project, one place up within its list (it stays selected)', section: 'tasks', scope: 'list' },
  { id: 'list.move-down', keys: ['Alt+↓'], description: 'Move it one place down', section: 'tasks', scope: 'list' },
  { id: 'list.move-top', keys: ['Alt+Shift+↑'], description: 'Move it to the top of its list', section: 'tasks', scope: 'list' },
  { id: 'list.move-bottom', keys: ['Alt+Shift+↓'], description: 'Move it to the bottom of its list', section: 'tasks', scope: 'list' },
  { id: 'note.drag', keys: ['Drag (touch: press and hold, then move)'], description: 'Reorder tasks in project lists, boards and the Inbox, and projects in the sidebar; drop on the middle of a row to nest it; Esc cancels', section: 'tasks', scope: 'list', note: true },
  { id: 'note.swipe', keys: ['Swipe a task (touch)'], description: 'Right completes, left schedules; the same two actions start the task\'s menu', section: 'tasks', scope: 'list', note: true },
  { id: 'note.hold', keys: ['Press and hold a task (touch)'], description: 'Tick it and show every checkbox; Select tasks in the page menu does the same, Done hides them', section: 'tasks', scope: 'list', note: true },
  { id: 'note.sorted-views', keys: ['Today, Upcoming, Assigned, Completed, labels, filters'], description: 'Sorted by date (or their own rule): no drag or Alt moves there', section: 'tasks', scope: 'list', note: true },
  // Expanded rows (row-expand D1): → shows more, ← shows less; the details open after folded subtasks unfold and close before they fold.
  { id: 'list.expand', keys: ['→'], label: 'Show details', description: 'Show the details of the selected task under its row (unfold its subtasks first when they are folded), or the sub-projects of the focused sidebar project', section: 'tasks', scope: 'list' },
  { id: 'list.collapse', keys: ['←'], label: 'Hide details', description: 'Hide the details of the selected task, else fold its subtasks (or go to its parent), or the sub-projects of the focused sidebar project', section: 'tasks', scope: 'list' },
  { id: 'project.move', keys: ['m'], description: 'Move the current project under another project or to the top level', section: 'trash', scope: 'view', views: ['project'] },
  // The Inbox's primary action (inbox-split D3): Process, one task at a time; `g p` still goes there from anywhere.
  { id: 'inbox.process', keys: ['p'], label: 'Process', description: 'In the Inbox: process its tasks one at a time', section: 'tasks', scope: 'view', views: ['inbox'] },
  { id: 'project.view-mode', keys: ['v'], description: 'Cycle the current project through list, board and timeline (remembered per project on this device)', section: 'tasks', scope: 'view', views: ['project'] },
  { id: 'project.share', keys: ['Shift+S'], description: 'Share the current project: add members by email, change roles, remove, leave, transfer', section: 'tasks', scope: 'view', views: ['project'] },
  // Custom fields (custom-fields): define the project's fields; editors and above.
  { id: 'project.fields', keys: ['Shift+F'], description: 'Manage the custom fields of the current project: add, rename, reorder, delete', section: 'tasks', scope: 'view', views: ['project'] },
  // The project note (project-notes D4): Shift+P is free in every scope a project hosts; Shift+N defers a task.
  { id: 'project.note', keys: ['Shift+P'], description: 'Edit the current project’s note (Esc saves and closes it)', section: 'tasks', scope: 'view', views: ['project'] },
  { id: 'list.priority', keys: ['1', '2', '3', '4'], description: 'Set the priority of the selected task, or of the ticked tasks', section: 'tasks', scope: 'list' },
  { id: 'list.labels', keys: ['Shift+L'], description: 'Labels of the selected task, or of the ticked tasks (type to find, Enter adds or creates); or drag the task onto a label in the sidebar', section: 'tasks', scope: 'list' },
  { id: 'list.edit-inline', keys: ['F2'], label: 'Edit in place', description: 'Edit the selected task\'s title in place, with its date, priority, labels and project under it; Enter saves, Esc cancels, Shift+Enter opens the details', section: 'tasks', scope: 'list' },
  { id: 'list.estimate', keys: ['e'], description: 'Edit the estimate of the selected task (type 20, 45m, 1h30; Enter)', section: 'tasks', scope: 'list' },
  // Time tracking (time-tracking D5): `y` is free in the list scope; the Inbox
  // triage's `y` is a view entry on a route without a task list.
  { id: 'list.track', keys: ['y'], description: 'Start or stop tracking time on the selected task', section: 'tasks', scope: 'list' },
  { id: 'list.deadline', keys: ['d'], description: 'Set the deadline of the selected task (type fri, 2026-11-06; Enter)', section: 'tasks', scope: 'list' },
  { id: 'list.blocked-by', keys: ['b'], description: 'Choose the tasks the selected task waits for (Blocked by)', section: 'tasks', scope: 'list' },
  { id: 'list.duplicate', keys: ['Shift+D'], description: 'Duplicate the selected task and its subtasks', section: 'tasks', scope: 'list' },
  { id: 'list.park', keys: ['n'], description: 'Park the selected task in Someday, or bring it back', section: 'tasks', scope: 'list' },
  { id: 'list.tick', keys: ['x', 'Space'], description: 'Tick the selected task for a bulk action (Space with Vim keybindings on)', section: 'tasks', scope: 'list' },
  { id: 'list.extend-down', keys: ['Shift+↓'], description: 'Extend the ticked range down', section: 'tasks', scope: 'list' },
  { id: 'list.extend-up', keys: ['Shift+↑'], description: 'Extend the ticked range up', section: 'tasks', scope: 'list' },
  { id: 'list.select-all', keys: ['Ctrl+A', '⌘+A'], description: 'Tick every task in the list', section: 'tasks', scope: 'list', when: 'once something is ticked' },
  { id: 'list.actions', keys: ['.'], description: 'Actions for the ticked tasks (or the selected one): complete, priority, labels, date, move, assign, Trash', section: 'tasks', scope: 'list', overrides: ['global.row-menu'] },
  { id: 'list.defer', keys: ['Shift+N'], description: 'Defer the selected task: type its start date, Enter', section: 'tasks', scope: 'list' },
  { id: 'list.evening', keys: ['Shift+E'], description: 'Toggle This Evening on the selected task', section: 'tasks', scope: 'list' },
  { id: 'list.schedule', keys: ['s'], description: 'Schedule the selected task: Day view in placement mode', section: 'tasks', scope: 'list', overrides: ['filter.save'] },
  { id: 'list.row-actions', keys: ['Tab'], description: 'From a task, reach its Schedule, Priority and More actions (wide screens with a mouse; in a tree list Tab indents)', section: 'tasks', scope: 'list', local: true },
  { id: 'list.skip', keys: ['Shift+K'], description: 'Skip the current occurrence of the selected recurring task', section: 'tasks', scope: 'list', when: 'recurring task' },
  { id: 'list.detach', keys: ['Shift+O'], description: 'Recurring task: this occurrence only (standalone copy, series moves on)', section: 'tasks', scope: 'list' },
  { id: 'list.delete', keys: ['Delete', 'Backspace'], description: 'Move the selected task (and its subtasks), or the ticked tasks, to the Trash', section: 'tasks', scope: 'list' },
  { id: 'panel.zone', keys: ['z'], description: 'Fix a timed due to your time zone, or release it to a floating time', section: 'tasks', scope: 'panel', when: 'task panel open' },
  { id: 'panel.priority', keys: ['1', '2', '3', '4'], description: 'Set the priority of the open task while the panel has focus', section: 'tasks', scope: 'panel', hidden: true, overrides: ['list.priority'] },
  { id: 'panel.track', keys: ['y'], description: 'Start or stop tracking time on the open task while the panel has focus', section: 'tasks', scope: 'panel', hidden: true, overrides: ['list.track'] },
  { id: 'panel.skip', keys: ['Shift+K'], description: 'Skip the current occurrence of the open recurring task', section: 'tasks', scope: 'panel', hidden: true, overrides: ['list.skip'] },
  { id: 'panel.escape', keys: ['Esc'], description: 'Close the panel', section: 'tasks', scope: 'panel', hidden: true, overrides: ['list.escape', 'calendar.escape', 'task.escape'] },
  // The task page (task-full-page): step through the list it was opened from, and back to it.
  { id: 'task.next', keys: ['j'], description: 'On a task page: open the next task of the list it was opened from', section: 'tasks', scope: 'view', views: ['task'] },
  { id: 'task.prev', keys: ['k'], description: 'On a task page: open the previous task of that list', section: 'tasks', scope: 'view', views: ['task'] },
  { id: 'task.escape', keys: ['Esc'], description: 'On a task page: back to the list, with the task selected where it was', section: 'tasks', scope: 'view', views: ['task'] },
  { id: 'list.archive-offer', keys: ['Enter'], description: 'Archive the project after completing its last task; any other key dismisses the offer', section: 'trash', scope: 'list', when: 'archive offered', overrides: ['list.open'] },

  // ---- board
  { id: 'board.column-prev', keys: ['h', '←'], description: 'Select the first task of the previous column; j / k move within a column', section: 'board', scope: 'board', overrides: ['list.collapse'] },
  { id: 'board.column-next', keys: ['l', '→'], description: 'Select the first task of the next column', section: 'board', scope: 'board', overrides: ['list.expand'] },
  { id: 'board.move-prev', keys: ['Shift+←'], description: 'Move the selected task to the previous column (it stays selected)', section: 'board', scope: 'board' },
  { id: 'board.move-next', keys: ['Shift+→'], description: 'Move the selected task to the next column', section: 'board', scope: 'board' },
  { id: 'board.add', keys: ['a'], description: 'Add a task to the selected task’s column', section: 'board', scope: 'board', overrides: ['list.add-subtask'] },
  { id: 'board.down', keys: ['j', '↓'], description: 'Select the next card in the column', section: 'board', scope: 'board', hidden: true, overrides: ['list.down'] },
  { id: 'board.up', keys: ['k', '↑'], description: 'Select the previous card in the column', section: 'board', scope: 'board', hidden: true, overrides: ['list.up'] },
  { id: 'board.indent', keys: ['Tab', 'Shift+Tab'], description: 'Nothing on a board: cards are not nested', section: 'board', scope: 'board', hidden: true, overrides: ['list.indent', 'list.outdent'], passive: true },

  // ---- timeline (a project's third layout, month-and-timeline-views; j / k / Enter stay the list's)
  { id: 'timeline.shift', keys: ['←', '→'], description: 'Timeline: move the selected task’s dates one day earlier / later', section: 'board', scope: 'timeline', overrides: ['list.collapse', 'list.expand'] },
  { id: 'timeline.deadline', keys: ['Shift+←', 'Shift+→'], description: 'Timeline: move the selected task’s deadline one day (from the due date when it has none)', section: 'board', scope: 'timeline' },
  { id: 'timeline.range-prev', keys: ['['], description: 'Timeline: show the previous week (or four with the week zoom)', section: 'board', scope: 'timeline', overrides: ['global.sidebar'] },
  { id: 'timeline.range-next', keys: [']'], description: 'Timeline: show the next week (or four)', section: 'board', scope: 'timeline' },
  { id: 'timeline.today', keys: ['t'], description: 'Timeline: back to today', section: 'board', scope: 'timeline' },

  // ---- calendar
  { id: 'calendar.next', keys: ['j'], description: 'Select the next task (lane, then blocks)', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.prev', keys: ['k'], description: 'Select the previous task', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.nudge', keys: ['↑', '↓'], description: 'Move the selected task 15 minutes earlier / later (a lane task gets a time); with nothing selected, select the first task', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.shift-day', keys: ['←', '→'], description: 'Move the selected task one day earlier / later', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.estimate', keys: ['Shift+↑', 'Shift+↓'], description: 'Shorten / lengthen the estimate by 15 minutes', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.unschedule', keys: ['u'], description: 'Unschedule the selected task (keep the date)', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.place', keys: ['p'], description: 'Placement mode for the selected task: arrows move the ghost, Enter places it, Esc cancels', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.open', keys: ['Enter'], description: 'Open the selected task', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.edit-estimate', keys: ['e'], description: 'Edit the estimate of the selected task', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.complete', keys: ['c'], description: 'Complete the selected task', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.range-prev', keys: ['['], description: 'Previous day or week', section: 'calendar', scope: 'calendar', overrides: ['global.sidebar'] },
  { id: 'calendar.range-next', keys: [']'], description: 'Next day or week', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.today', keys: ['t'], description: 'Back to today', section: 'calendar', scope: 'calendar' },
  { id: 'calendar.escape', keys: ['Esc'], description: 'Cancel placing or a drag, close the "+N" list or the panel, else clear the selection', section: 'calendar', scope: 'calendar', hidden: true, typing: true },
  // The Month view (month-and-timeline-views): a grid of due dates with a focused day, no lane or blocks.
  { id: 'month.move', keys: ['←', '→', '↑', '↓'], description: 'In Month: move the focused day; with a task selected, move it a day or a week (keeps its time)', section: 'calendar', scope: 'view', views: ['month'] },
  { id: 'month.focus', keys: ['Shift+←', 'Shift+→', 'Shift+↑', 'Shift+↓'], description: 'In Month: move the focused day while a task is selected', section: 'calendar', scope: 'view', views: ['month'], hidden: true },
  { id: 'month.next', keys: ['j'], description: 'In Month: select the next task of the month', section: 'calendar', scope: 'view', views: ['month'] },
  { id: 'month.prev', keys: ['k'], description: 'In Month: select the previous task', section: 'calendar', scope: 'view', views: ['month'] },
  { id: 'month.open', keys: ['Enter'], description: 'In Month: open the selected task', section: 'calendar', scope: 'view', views: ['month'] },
  { id: 'month.quick-add', keys: ['q'], description: 'In Month: add a task due on the focused day', section: 'calendar', scope: 'view', views: ['month'], overrides: ['list.quick-add'] },
  { id: 'month.range-prev', keys: ['['], description: 'In Month: previous month', section: 'calendar', scope: 'view', views: ['month'], overrides: ['global.sidebar'] },
  { id: 'month.range-next', keys: [']'], description: 'In Month: next month', section: 'calendar', scope: 'view', views: ['month'] },
  { id: 'month.today', keys: ['t'], description: 'In Month: back to today', section: 'calendar', scope: 'view', views: ['month'] },
  { id: 'month.escape', keys: ['Esc'], description: 'In Month: close the "+N more" list or the panel, else clear the selection', section: 'calendar', scope: 'view', views: ['month'], hidden: true },
  // The Plan (planner-view D6): the Month's model over the span's columns; projected and event rows are never selected.
  { id: 'plan.move', keys: ['←', '→', '↑', '↓'], description: 'In Plan: move the focused day; with a task selected, move it a day or a week (keeps its time)', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.focus', keys: ['Shift+←', 'Shift+→', 'Shift+↑', 'Shift+↓'], description: 'In Plan: move the focused day while a task is selected', section: 'calendar', scope: 'view', views: ['plan'], hidden: true },
  { id: 'plan.next', keys: ['j'], description: 'In Plan: select the next task, column by column (projected and event rows are skipped)', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.prev', keys: ['k'], description: 'In Plan: select the previous task', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.open', keys: ['Enter'], description: 'In Plan: open the selected task', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.complete', keys: ['c'], description: 'In Plan: complete the selected task', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.quick-add', keys: ['q'], description: 'In Plan: add a task due on the focused day', section: 'calendar', scope: 'view', views: ['plan'], overrides: ['list.quick-add'] },
  { id: 'plan.range-prev', keys: ['['], description: 'In Plan: the span one week earlier', section: 'calendar', scope: 'view', views: ['plan'], overrides: ['global.sidebar'] },
  { id: 'plan.range-next', keys: [']'], description: 'In Plan: the span one week later', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.today', keys: ['t'], description: 'In Plan: back to today', section: 'calendar', scope: 'view', views: ['plan'] },
  { id: 'plan.escape', keys: ['Esc'], description: 'In Plan: close the panel, else clear the selection', section: 'calendar', scope: 'view', views: ['plan'], hidden: true },

  // ---- filter, saved views and dashboards
  { id: 'filter.jump', keys: ['Enter', 'Esc'], description: 'In New view: jump from the query to the first result / back to the query', section: 'filter', scope: 'view', views: ['filter'], local: true, typing: true },
  { id: 'filter.save', keys: ['s'], description: 'Save the query as a view, pinned to the sidebar', section: 'filter', scope: 'view', views: ['filter'], when: 'in New view results' },
  { id: 'view.edit-query', keys: ['/'], description: 'Edit the query of a saved view; Enter saves it, Esc discards', section: 'filter', scope: 'list', when: 'in a saved view' },
  { id: 'dashboard.panels', keys: ['Tab', 'Shift+Tab'], description: 'On a dashboard: move between panels; j / k inside a panel, Enter opens, o opens the view', section: 'filter', scope: 'view', views: ['dashboard'] },
  { id: 'dashboard.down', keys: ['j', '↓'], description: 'Select the next task in the focused dashboard panel', section: 'filter', scope: 'view', views: ['dashboard'], hidden: true },
  { id: 'dashboard.up', keys: ['k', '↑'], description: 'Select the previous task in the focused dashboard panel', section: 'filter', scope: 'view', views: ['dashboard'], hidden: true },
  { id: 'dashboard.open', keys: ['Enter'], description: 'Open the selected task of the dashboard panel, else its view', section: 'filter', scope: 'view', views: ['dashboard'], hidden: true },
  { id: 'dashboard.open-view', keys: ['o'], description: 'Open the focused dashboard panel’s view', section: 'filter', scope: 'view', views: ['dashboard'], hidden: true },
  { id: 'dashboard.complete', keys: ['c'], description: 'Complete the selected task of the dashboard panel', section: 'filter', scope: 'view', views: ['dashboard'], hidden: true },
  { id: 'dashboard.escape', keys: ['Esc'], description: 'Clear the dashboard selection', section: 'filter', scope: 'view', views: ['dashboard'], hidden: true },
  { id: 'dashboard.move-prev', keys: ['Shift+←'], description: 'On a board: move the selected card to the previous panel that has a rule, applying it (the card stays selected)', section: 'filter', scope: 'view', views: ['dashboard'] },
  { id: 'dashboard.move-next', keys: ['Shift+→'], description: 'On a board: move the selected card to the next panel that has a rule, applying it', section: 'filter', scope: 'view', views: ['dashboard'] },
  { id: 'filter.history', keys: ['↑', '↓'], description: 'In the query of New view: recall recent queries on this device', section: 'filter', scope: 'view', views: ['filter'], local: true, typing: true },

  // ---- trash, projects and updates
  { id: 'trash.down', keys: ['j'], description: 'In the Trash: select the next item', section: 'trash', scope: 'view', views: ['trash'] },
  { id: 'trash.up', keys: ['k'], description: 'In the Trash: select the previous item', section: 'trash', scope: 'view', views: ['trash'] },
  { id: 'trash.restore', keys: ['r'], description: 'In the Trash: restore the selected item', section: 'trash', scope: 'view', views: ['trash'] },
  { id: 'trash.purge', keys: ['Delete'], description: 'In the Trash: delete the selected item permanently (Enter confirms, Esc cancels)', section: 'trash', scope: 'view', views: ['trash'] },
  { id: 'trash.confirm', keys: ['Enter'], description: 'Confirm deleting permanently', section: 'trash', scope: 'view', views: ['trash'], hidden: true },
  { id: 'trash.escape', keys: ['Esc'], description: 'Cancel deleting permanently', section: 'trash', scope: 'view', views: ['trash'], hidden: true },
  { id: 'feed.down', keys: ['j', '↓'], description: 'In Updates: select the next change', section: 'trash', scope: 'view', views: ['feed'] },
  { id: 'feed.up', keys: ['k', '↑'], description: 'In Updates: select the previous change', section: 'trash', scope: 'view', views: ['feed'] },
  { id: 'feed.open', keys: ['Enter'], description: 'In Updates: open the task of the selected change (Tab reaches the filters)', section: 'trash', scope: 'view', views: ['feed'] },
  { id: 'share.escape', keys: ['Esc'], description: 'Leave the shared page without saving it as a task', section: 'trash', scope: 'view', views: ['share'], hidden: true, typing: true },

  // ---- Focus (focus-mode D7): one task and a timer; the panel's Esc runs first while it is open.
  { id: 'focus.toggle', keys: ['Space'], description: 'Start or pause the session', section: 'focus', scope: 'view', views: ['focus'] },
  { id: 'focus.complete', keys: ['Enter'], description: 'Complete the task and end the session', section: 'focus', scope: 'view', views: ['focus'] },
  { id: 'focus.break', keys: ['b'], description: 'Take a break now, or end the break', section: 'focus', scope: 'view', views: ['focus'] },
  { id: 'focus.next', keys: ['n'], description: "Next task of today's focus", section: 'focus', scope: 'view', views: ['focus'] },
  { id: 'focus.escape', keys: ['Esc'], description: 'Back to the previous view (the session keeps running)', section: 'focus', scope: 'view', views: ['focus'], hidden: true },

  // ---- Process the Inbox (inbox-triage): one Inbox task at a time, a key per decision; every decision but Labels moves on to the next task.
  { id: 'triage.today', keys: ['t'], description: 'Due today, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.schedule', keys: ['s'], description: 'Schedule: pick a choice or a day, or type a date (fri, 3/11) and press Enter, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.relative', keys: ['1', '2', '3', '4', '5', '6'], description: 'In the scheduling sheet of a task with a deadline: on the deadline, 1 day, 3 days, 1 week, 2 weeks or 1 month before', section: 'triage', scope: 'view', views: ['triage'], dialog: true, overrides: ['vim.priority'] },
  { id: 'triage.move', keys: ['m'], description: 'Move to a project, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.delegate', keys: ['a'], description: 'Delegate: move into a shared project and assign it to someone there, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.labels', keys: ['l'], description: 'Labels (does not move on, so you can add a label and then decide)', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.someday', keys: ['y'], description: 'Park in Someday, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.complete', keys: ['c'], description: 'Complete, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.trash', keys: ['Delete', 'Backspace'], description: 'Move to the Trash, then the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.skip', keys: ['j', 'Space'], description: 'Skip to the next task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.back', keys: ['k'], description: 'Back to the previous task', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.open', keys: ['Enter'], description: 'Open the task’s panel to edit anything else', section: 'triage', scope: 'view', views: ['triage'] },
  { id: 'triage.escape', keys: ['Esc'], description: 'Close the panel, else back to the Inbox with this task selected', section: 'triage', scope: 'view', views: ['triage'] },
  // ---- the reviews (open-loops-method D6): the weekly review's project walk and the Daily check
  { id: 'review.prev-step', keys: ['['], description: 'Weekly review: the previous step', section: 'review', scope: 'view', views: ['review'], overrides: ['global.sidebar'] },
  { id: 'review.next-step', keys: [']'], description: 'Weekly review: the next step', section: 'review', scope: 'view', views: ['review'] },
  { id: 'review.walk-reviewed', keys: ['r'], description: 'Project walk: mark the project reviewed, then the next one', section: 'review', scope: 'view', views: ['review'] },
  { id: 'review.walk-add', keys: ['q'], description: 'Project walk: add a next action to the project', section: 'review', scope: 'view', views: ['review'], overrides: ['list.quick-add'] },
  { id: 'review.walk-open', keys: ['Enter'], description: 'Project walk: open the project', section: 'review', scope: 'view', views: ['review'] },
  { id: 'review.walk-archive', keys: ['a'], description: 'Project walk: archive the project, then the next one', section: 'review', scope: 'view', views: ['review'] },
  { id: 'review.walk-skip', keys: ['j', 'Space'], description: 'Project walk: skip to the next project', section: 'review', scope: 'view', views: ['review'] },
  { id: 'review.walk-back', keys: ['k'], description: 'Project walk: back to the previous project', section: 'review', scope: 'view', views: ['review'] },
  { id: 'review.focus', keys: ['f'], description: 'Daily check: put the selected task in today\'s focus (up to three), or take it out', section: 'review', scope: 'view', views: ['review'] },
  // Close the day's carry-over (close-the-day D4): on the selected row. The screen's
  // rows pass the list's `y` (time tracking) through, so `y` reaches this entry there.
  { id: 'close.tomorrow', keys: ['t'], description: 'Close the day: carry the task on the card over to tomorrow', section: 'review', scope: 'view', views: ['review'] },
  { id: 'close.pick', keys: ['p'], description: 'Close the day: pick a day for the task on the card', section: 'review', scope: 'view', views: ['review'] },
  { id: 'close.someday', keys: ['y'], description: 'Close the day: move the task on the card to Someday', section: 'review', scope: 'view', views: ['review'] },
  { id: 'close.keep', keys: ['h'], description: 'Close the day: keep the task on the card in Today', section: 'review', scope: 'view', views: ['review'] },
  { id: 'close.done', keys: ['d'], description: 'Close the day: the task on the card was done already (completed with the carry-over)', section: 'review', scope: 'view', views: ['review'], overrides: ['vim.delete'] },

  // ---- display mode (display-mode D5): the shell's shortcuts (`g` sequences, `q`, `?`) are not active there
  { id: 'display.down', keys: ['j', '↓', '→'], description: 'Move the focus to the next row, across the day columns', section: 'display', scope: 'view', views: ['display'] },
  { id: 'display.up', keys: ['k', '↑', '←'], description: 'Move the focus to the previous row', section: 'display', scope: 'view', views: ['display'] },
  { id: 'display.first', keys: ['Home'], description: 'Focus the first row', section: 'display', scope: 'view', views: ['display'] },
  { id: 'display.last', keys: ['End'], description: 'Focus the last row', section: 'display', scope: 'view', views: ['display'] },
  { id: 'display.toggle', keys: ['Space', 'Enter'], description: 'Complete or reopen the focused task (only where you may edit it)', section: 'display', scope: 'view', views: ['display'] },
  { id: 'display.exit', keys: ['Esc'], description: 'Leave display mode for the same view in the app', section: 'display', scope: 'view', views: ['display'] },

  // ---- settings
  { id: 'settings.search', keys: ['/'], description: 'Settings: focus the search field, which finds sections and single settings by name', section: 'settings', scope: 'view', views: ['settings'] },
  { id: 'settings.invite-copy', keys: ['Enter'], description: 'Settings → People → Members: copy the invite link created in this session', section: 'settings', scope: 'view', views: ['settings'], local: true, when: 'focused invitation' },
  { id: 'settings.invite-revoke', keys: ['Delete'], description: 'Settings → People → Members: revoke the focused pending invitation', section: 'settings', scope: 'view', views: ['settings'], local: true, when: 'focused invitation' },
  // The profile picture dialog's cropper (settings-refresh D11): handled by the cropper itself, only inside its dialog.
  { id: 'settings.picture-pan', keys: ['←', '→', '↑', '↓'], description: 'Settings → Account → Profile, picture dialog: move the picture inside the circle', section: 'settings', scope: 'view', views: ['settings'], local: true, dialog: true, when: 'in the picture dialog' },
  { id: 'settings.picture-zoom', keys: ['+', '-'], description: 'Settings → Account → Profile, picture dialog: zoom in or out', section: 'settings', scope: 'view', views: ['settings'], local: true, dialog: true, when: 'in the picture dialog' },
  { id: 'settings.user-actions', keys: ['d', 'r', 'Delete'], description: 'Settings → People → Users: deactivate or reactivate, create a reset link, delete the focused user (each confirms)', section: 'settings', scope: 'view', views: ['settings'], local: true, when: 'focused user' },
  { id: 'settings.audit-export', keys: ['e'], description: 'Settings → Server → Audit log: export with the current filters while the table has focus', section: 'settings', scope: 'view', views: ['settings'], local: true, when: 'focused table' },
  { id: 'settings.passkeys', keys: ['Tab'], description: 'Settings → Account → Passkeys: add, rename (Enter saves, Esc cancels) or remove passkeys', section: 'settings', scope: 'view', views: ['settings'], local: true },

  // ---- comments and notes
  { id: 'panel.comment', keys: ['Shift+C'], description: 'Comment on the open task: switch to the Comments tab and focus the composer (markdown; @ completes members, ↑ / ↓ and Enter pick)', section: 'comments', scope: 'panel' },
  { id: 'editor.send', keys: ['Ctrl+Enter', '⌘+Enter'], description: 'Post the comment, reply or edit; Esc cancels or leaves the field', section: 'comments', scope: 'editor', local: true, typing: true, when: 'in a comment' },
  { id: 'panel.thread', keys: ['Tab', 'Enter'], description: 'In the Comments tab: reach Reply, Edit and Delete; in the Activity tab: expand a group or load older activity', section: 'comments', scope: 'panel', local: true, when: 'in the thread' },
  { id: 'panel.tabs', keys: ['←', '→'], description: 'Switch between Comments, Activity and History in the task panel', section: 'comments', scope: 'panel', local: true, when: 'on the task tabs' },
  { id: 'project.activity', keys: ['Shift+H'], description: 'Show or hide the project activity; Tab reaches the person and kind filters', section: 'comments', scope: 'view', views: ['project'] },
  { id: 'editor.inline', keys: ['Ctrl+B', 'Ctrl+I', 'Ctrl+Shift+X', 'Ctrl+E', 'Ctrl+K'], description: 'In the notes and comments: bold, italic, strikethrough, inline code, link (⌘ on a Mac)', section: 'comments', scope: 'editor', local: true, typing: true },
  { id: 'editor.heading', keys: ['Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Alt+0'], description: 'In the notes and comments: heading 1–3 / normal text', section: 'comments', scope: 'editor', local: true, typing: true },
  { id: 'editor.lists', keys: ['Ctrl+Shift+8', 'Ctrl+Shift+7', 'Ctrl+Shift+9'], description: 'In the notes: bullet, numbered, check list; Ctrl+Enter ticks a check item; Tab / Shift+Tab indent', section: 'comments', scope: 'editor', local: true, typing: true },
  { id: 'editor.subtask', keys: ['Ctrl+Shift+Enter', '⌘+Shift+Enter'], description: 'In a task\'s notes: make the check-list line a subtask (Ctrl+Z takes it back)', section: 'comments', scope: 'editor', local: true, typing: true, when: 'on a check-list line' },
  { id: 'editor.slash', keys: ['/'], description: 'In the notes and comments: the command menu (headings, lists, table, quote, code, link, image, date, mention); ↑ / ↓ move, Enter applies, Esc closes', section: 'comments', scope: 'editor', local: true, typing: true, when: 'at the start of a line or after a space' },
  { id: 'editor.table', keys: ['Tab', 'Shift+Tab'], description: 'In a table: next / previous cell; Tab in the last cell adds a row', section: 'comments', scope: 'editor', local: true, typing: true, when: 'in a table' },
  { id: 'note.markdown', keys: ['- · 1. · # · [ ] · > · ``` · **x** (typed in the notes)'], description: 'Markdown typing becomes formatting (``` and Enter starts a code block); Shift+Enter is a line break, Esc leaves the notes', section: 'comments', scope: 'editor', note: true },

  // ---- vim (listed while the layer is on)
  { id: 'vim.count', keys: ['3j', '5k', '2↓'], description: 'Count: move the selection that many tasks (clamped)', section: 'vim', scope: 'vim', note: true },
  { id: 'vim.first', keys: ['g g'], label: 'First task', description: 'Select the first task; 4gg selects the fourth', section: 'vim', scope: 'vim' },
  { id: 'vim.last', keys: ['Shift+G'], description: 'Select the last task; 4G selects the fourth', section: 'vim', scope: 'vim' },
  { id: 'vim.move-down', keys: ['Shift+J'], description: 'Move the selected task down one place (with a count, that many; manually ordered views only)', section: 'vim', scope: 'vim' },
  { id: 'vim.move-up', keys: ['Shift+K'], description: 'Move the selected task up one place', section: 'vim', scope: 'vim', overrides: ['list.skip', 'panel.skip'] },
  { id: 'vim.delete', keys: ['d d'], label: 'Delete task', description: 'Delete the selected task (d alone does nothing after 1 s)', section: 'vim', scope: 'vim', overrides: ['list.deadline'] },
  { id: 'vim.complete', keys: ['x'], description: 'Complete / reopen the selected task (same as c); Space ticks', section: 'vim', scope: 'vim', overrides: ['list.tick'] },
  { id: 'vim.open-below', keys: ['o'], description: 'Quick add; in project lists and the Inbox the new task lands after the selection', section: 'vim', scope: 'vim', overrides: ['dashboard.open-view'] },
  { id: 'vim.insert', keys: ['i'], description: 'Open the selected task and edit its title (Insert mode)', section: 'vim', scope: 'vim' },
  { id: 'vim.priority', keys: ['1', '2', '3', '4'], description: 'Priority, applied after 1 s or at the next key (a digit followed by a motion is a count)', section: 'vim', scope: 'vim', overrides: ['list.priority', 'panel.priority'] },
  { id: 'vim.leave-field', keys: ['Esc'], description: 'In a field: leave it and return to Normal mode; the text is kept, the panel stays open. In Normal mode Esc closes the panel and clears the selection as usual', section: 'vim', scope: 'vim', typing: true, overrides: ['list.escape', 'list.dictate-stop', 'calendar.escape', 'month.escape', 'plan.escape', 'panel.escape', 'trash.escape', 'dashboard.escape', 'share.escape', 'triage.escape', 'focus.escape', 'task.escape', 'display.exit'] },
  { id: 'vim.command', keys: [':'], description: 'Open the command line (Tab completes, Enter runs, Esc cancels)', section: 'vim', scope: 'vim' },
]

/** Quick add syntax shown at the end of the sheet and the guide. */
export const QUICK_ADD_SYNTAX: [string, string][] = [
  ['tomorrow · next Wed · 3 Feb · at 3pm', 'Due date and time (6 languages)'],
  ['#project @label p1 +30m', 'Project, label, priority, estimate'],
  ['# or @, then a few letters', 'Suggests projects or labels; Enter or Tab picks, #Home/Docs picks a sub-project'],
  ['every Monday · remind me 30 min before', 'Repeat and remind (6 languages)'],
  ['"quoted text"', 'Keep text literally'],
  ['Backspace ×2 (end of line)', 'Highlight, then dismiss the last chip'],
]

// ---------------------------------------------------------------- display

/** The keys of an entry as one string: alternatives joined by " / ", then the state in parentheses. */
export function displayKeys(s: Pick<Shortcut, 'keys' | 'when'>): string {
  const keys = s.keys.join(' / ')
  return s.when ? `${keys} (${s.when})` : keys
}

/** The label's catalog message and context (`Next|method`); falls back to the description. */
export function labelMessage(s: Pick<Shortcut, 'label' | 'description'>): { message: string; context?: string } {
  if (!s.label) return { message: s.description }
  const bar = s.label.lastIndexOf('|')
  return bar < 0 ? { message: s.label } : { message: s.label.slice(0, bar), context: s.label.slice(bar + 1) }
}

/** Groups of the sequence spotlight (shortcut-spotlight D3), by id; the rest are Tools. */
export type SpotlightGroup = 'views' | 'calendar' | 'method' | 'tools'
const SPOTLIGHT_GROUPS: Record<string, SpotlightGroup> = {
  'go.inbox': 'views', 'go.today': 'views', 'go.upcoming': 'views', 'go.anytime': 'views', 'go.someday': 'views', 'go.assigned': 'views',
  'go.completed': 'views', 'go.labels': 'views', 'go.projects': 'views', 'go.filter': 'views', 'go.views': 'views', 'go.trash': 'views', 'go.feed': 'views',
  'go.day': 'calendar', 'go.week': 'calendar', 'go.month': 'calendar', 'go.plan': 'calendar',
  'go.triage': 'method', 'go.review': 'method', 'go.loop': 'method', 'go.next': 'method', 'go.waiting': 'method', 'go.daily': 'method',
  'go.close': 'method', 'go.focus': 'method', 'go.stats': 'method',
}
export function spotlightGroup(id: string): SpotlightGroup {
  return SPOTLIGHT_GROUPS[id] ?? 'tools'
}

/** The second half of a sequence as shown on a keycap ("t", "Shift+P"). */
export function chordText(c: Chord): string {
  const named: Record<string, string> = { escape: 'Esc', enter: 'Enter', ' ': 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }
  const key = named[c.key] ?? (c.key.length === 1 ? (c.shift && !c.symbol && /[a-z]/.test(c.key) ? c.key.toUpperCase() : c.key) : c.key)
  const mods = [c.ctrl === 'ctrl' ? 'Ctrl' : c.ctrl === 'meta' ? '⌘' : c.ctrl === 'either' ? 'Ctrl' : '', c.alt ? 'Alt' : '', c.shift && !c.symbol ? 'Shift' : ''].filter(Boolean)
  return [...mods, key].join('+')
}

/** The entry with this id. */
export function shortcut(id: string): Shortcut {
  const s = SHORTCUTS.find((x) => x.id === id)
  if (!s) throw new Error(`unknown shortcut ${id}`)
  return s
}

/** The keys of an entry for a tooltip or a menu item ("Shift+S"), alternatives joined by " / ". */
export function keysOf(id: string): string {
  return shortcut(id).keys.join(' / ')
}

/** The rows the sheet and the guide list: not hidden; vim rows only while the layer is on. */
export function listedShortcuts(vim = false): Shortcut[] {
  return SHORTCUTS.filter((s) => !s.hidden && (vim || s.scope !== 'vim'))
}

// ---------------------------------------------------------------- chords

export interface Chord {
  /** `e.key`, lower-cased for letters and named keys; symbols as typed. */
  key: string
  ctrl: 'ctrl' | 'meta' | 'either' | false
  alt: boolean
  shift: boolean
  /** A symbol typed with Shift on some layouts (`?`, `:`): the Shift state is not compared. */
  symbol: boolean
}

const NAMED: Record<string, string> = {
  esc: 'escape', escape: 'escape', enter: 'enter', tab: 'tab', space: ' ', delete: 'delete', del: 'delete', backspace: 'backspace',
  '↑': 'arrowup', '↓': 'arrowdown', '←': 'arrowleft', '→': 'arrowright', menu: 'contextmenu', f2: 'f2', f10: 'f10', home: 'home', end: 'end',
}

/** Parses one chord ("Alt+Shift+↑", "⌘+K", "?") into what the dispatcher compares; `null` for a note. */
export function parseChord(text: string): Chord | null {
  const parts = text.split('+')
  if (parts.length > 1 && parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] += '+' }
  const keyText = parts.pop()!
  let ctrl: Chord['ctrl'] = false
  let alt = false
  let shift = false
  for (const m of parts) {
    const mod = m.trim().toLowerCase()
    if (mod === 'ctrl') ctrl = ctrl === 'meta' ? 'either' : 'ctrl'
    else if (mod === '⌘' || mod === 'cmd' || mod === 'meta') ctrl = ctrl === 'ctrl' ? 'either' : 'meta'
    else if (mod === 'ctrl/⌘') ctrl = 'either'
    else if (mod === 'alt') alt = true
    else if (mod === 'shift') shift = true
    else return null
  }
  const lower = keyText.trim().toLowerCase()
  const named = NAMED[lower]
  if (named) return { key: named, ctrl, alt, shift, symbol: false }
  if (keyText.length !== 1) return null
  const letter = /[a-z]/i.test(keyText)
  const digit = /[0-9]/.test(keyText)
  // A capital on its own (`L`, `G`) means Shift; with Ctrl, ⌘ or Alt it is the usual spelling (`Ctrl+K`).
  if (letter) return { key: keyText.toLowerCase(), ctrl, alt, shift: shift || (!ctrl && !alt && keyText !== keyText.toLowerCase()), symbol: false }
  return { key: keyText, ctrl, alt, shift, symbol: !digit }
}

/** Parses a sequence ("g i", "g Shift+I", "d d") into chords; `null` when any part is not a key. */
export function parseKeys(text: string): Chord[] | null {
  const out: Chord[] = []
  for (const part of text.split(' ')) {
    if (!part) return null
    const c = parseChord(part)
    if (!c) return null
    out.push(c)
  }
  return out.length ? out : null
}

/** Something that looks enough like a KeyboardEvent to match a chord. */
export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** Whether a key press is this chord. */
export function matchesChord(c: Chord, e: KeyLike): boolean {
  const letter = e.key.length === 1 && /[a-z]/i.test(e.key)
  const key = e.key.toLowerCase()
  if (c.key !== key) return false
  const ctrl = !!e.ctrlKey, meta = !!e.metaKey
  if (c.ctrl === false && (ctrl || meta)) return false
  if (c.ctrl === 'ctrl' && !(ctrl && !meta)) return false
  if (c.ctrl === 'meta' && !(meta && !ctrl)) return false
  if (c.ctrl === 'either' && !(ctrl || meta)) return false
  if (c.alt !== !!e.altKey) return false
  if (c.symbol) return true
  // A capital letter is the shifted key whatever the modifier flag says (Caps Lock, a
  // synthetic press); a lower-case one needs Shift off.
  if (letter) {
    const upper = e.key !== key
    return c.shift ? upper || !!e.shiftKey : !upper && !e.shiftKey
  }
  return c.shift === !!e.shiftKey
}

/** The chord sequences of an entry, parsed once; notes have none. */
const parsed = new Map<string, Chord[][]>()
export function chordsOf(s: Shortcut): Chord[][] {
  let out = parsed.get(s.id)
  if (!out) {
    out = s.note ? [] : s.keys.map((k) => parseKeys(k)).filter((c): c is Chord[] => !!c)
    parsed.set(s.id, out)
  }
  return out
}

/** A canonical string of a chord sequence, for comparing bindings. */
export function chordKey(seq: Chord[]): string {
  return seq.map((c) => `${c.ctrl || ''}${c.alt ? '+alt' : ''}${!c.symbol && c.shift ? '+shift' : ''}+${c.key}`).join(' ')
}

/** Whether two sequences collide: the same keys, or one is the start of the other (`d` and `d d`). */
export function sequencesClash(a: Chord[], b: Chord[]): boolean {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (chordKey([a[i]]) !== chordKey([b[i]])) return false
  return true
}
