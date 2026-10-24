---
title: Work from the list
summary: Add, complete and delete tasks, change them with one key, undo, and put them in the order you want, all without opening a task.
audience: user
section: Guides
specs: [task-management, manual-ordering, task-list-presentation]
order: 15
---
# Work from the list

<picture><source srcset="images/quick-add-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/quick-add-light.webp" alt="Quick add with the line Call Sam about the tiles tomorrow at 4pm #Home @call p2 +15m, and chips for the date, project, label, priority and estimate below it."></picture>

Most of the day happens in a list: the Inbox, Today or a project. You can do a lot there without opening a task.

## Add a task

Press <kbd>q</kbd> anywhere in a task list, type, and press <kbd>Enter</kbd>. The box stays focused so you can add several in a row.

You can fill in details as you type:

```
Order new taps friday #Home @errand p2 +20m
```

This creates "Order new taps", due Friday, in Home, with the label errand, priority 2 and a 20-minute estimate. Chips under the box show what was understood. The [quick add reference](quick-add.md) has every word and symbol it knows.

New tasks without a project land in the **Inbox**. Tasks added inside a project go into that project, and tasks added in **Today** are due today.

## Complete, reopen and delete

Click a task's circle or press <kbd>c</kbd>. On a phone, swipe right to complete, left to schedule; hold to select. Completed tasks move to **Completed**, where you can reopen them.

Deleting a task (the **Delete** button in the panel, or <kbd>Delete</kbd> in the list) moves it to the Trash, along with its subtasks. You can restore it from there. See [Trash and history](trash-and-history.md).

Completing, deleting, moving, rescheduling or parking a task shows a toast with **Undo** for a few seconds (<kbd>Ctrl</kbd>+<kbd>Z</kbd> outside a text field also undoes).

## What a row shows

A row leaves out what the view already says: no "Today" in Today, no date under an Upcoming day, no project inside that project. Times stand in a column before the titles (a deadline's countdown when there is no time). Dates are grey for later, darker for tomorrow, the accent for today and red when past; only P1 and P2 colour the circle. Labels are small chips, two at most and "+2". The project and counts end the row, faint until hovered.

With a mouse on a wide screen, hovering a row shows **Show details**, **Schedule**, **Priority** and **More**; <kbd>Tab</kbd> reaches them. On a touch screen, long-press a row to select it, or swipe it.

## Quick changes from the list

You don't have to open a task to change it. Select it and press:

| Key | Does |
| --- | --- |
| <kbd>1</kbd> to <kbd>4</kbd> | Set the priority |
| <kbd>c</kbd> | Complete or reopen |
| <kbd>L</kbd> | Add labels (type to search, <kbd>Enter</kbd> to add or create) |
| <kbd>e</kbd> | Set the estimate (`20`, `45m`, `1h30`) |
| <kbd>d</kbd> | Set the deadline (`fri`, `2026-11-06`) |
| <kbd>n</kbd> | Park in Someday, or bring back |
| <kbd>Shift</kbd>+<kbd>N</kbd> | Defer: type the start date |
| <kbd>Shift</kbd>+<kbd>E</kbd> | Toggle This Evening |
| <kbd>x</kbd> | Tick for a bulk action (see [Change several tasks at once](bulk-actions.md)) |
| <kbd>s</kbd> | Schedule it on the Day calendar |
| <kbd>Delete</kbd> | Move it to the Trash |

## Put things in order

In the Inbox and in projects, you decide the order. Drag a task to a new place (on a touch screen, press and hold first), or select it and press <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd>. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd> sends it to the top. Dropping a task on the middle of another one makes it a subtask. Projects in the sidebar can be reordered the same way.

Today, Upcoming, labels and filters sort themselves by date and priority; there a drag only goes to the sidebar (see [Drop on the sidebar](bulk-actions.md#drop-on-the-sidebar)).
