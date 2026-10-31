---
title: Group and order a list
summary: Group a project's or a label's tasks by section, date, priority or label and order them by priority, date, deadline or title, kept for each project and label.
audience: user
section: Guides
specs: [list-display-options, custom-views, manual-ordering, task-list-presentation]
screens: []
order: 18
---
# Group and order a list

<picture><source srcset="images/group-and-order-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/group-and-order-light.webp" alt="The Home renovation project grouped by priority, with the Display options panel open showing Group by Priority and Order by Manual order."></picture>

A project list and label page have **Display options**, the sliders button at the right of the header. [Saved views](saved-views.md) use the same panel. Changes apply at once.

## Group by

- In a project: **Section** (the default), **None**, **Due date**, **Priority** or **Label**.
- On a label's page: **Project** (the default), **None**, **Due date** or **Priority**.

Due date groups read *Earlier*, *Today*, *Tomorrow*, later dates and *No date*. A task with several labels appears under the first in your label order. Section groups keep their headings, folding and **+** buttons.

## Order by

**Manual order** (the default, the order you drag tasks into), **Priority**, **Due date**, **Created**, **Deadline** or **Title**. **More options** holds the direction; for priority, *descending* puts priority 1 first. Tasks without a date or deadline come last either way.

Number and Date fields also appear in **Order by**. Same-named fields match across a label's projects without regard to case. When types differ, numbers precede dates and text in either direction; direction reverses values within each type and missing values stay last. Text fields from other projects take part too. The setting stores the definition ID, so renames follow it and encrypted names never sync.

Subtasks stay under their parent in the order you gave them, and a project's **Later** and **Completed** groups stay at the end.

A new task goes at the end of manual order, or at the top if **Add new tasks: At the top of the list** is set in Settings → Capture → Quick add (see [Where new tasks go](quick-add.md#where-new-tasks-go)). Other orders place it by their value; the setting breaks ties.

## Kept for each project and label

The choice is kept for each project and each label, follows you to your other devices and stays after a restart. In a shared project it is yours only: other members keep their own.

## Drag while another order is shown

Dragging a task between others in a project or on a label's page, or moving it with <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>, while another order is shown switches the page back to **Manual order**, then moves the task. The grouping stays. A project's board and timeline keep their own layout; the button shows in the list layout only.

## Your own order on a label page or saved view

A label page and a [saved view](saved-views.md) keep their **own** manual order. Moving *Post office* above *Pharmacy* on the *errand* label does not move either task in its project. You can order tasks from a shared read-only project on your label pages and views.

- Drag a task above or below another one in the same group (on a phone, press and hold, then move), or select it and press <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> for the top or bottom of its group. With Vim keys on, <kbd>Shift</kbd>+<kbd>J</kbd> / <kbd>K</kbd> work too.
- Each move shows **Order changed** with **Undo**.
- Tasks you never moved follow the ones you placed, in their project order, so a new task appears after them.
- The order is kept for up to 500 tasks per page, follows you to your other devices and works offline. If you reorder the same page on two devices while offline, the device that syncs last wins.

Today, Upcoming, Anytime, Someday, Assigned to me, Completed and places have fixed orders. **New view** offers Manual order after the view is saved.
