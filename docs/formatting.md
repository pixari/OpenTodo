---
title: Format notes and comments
summary: Headings, lists, quotes, code, tables, images and mentions in notes and comments, the / command menu, and turning a checklist line into a subtask.
audience: user
section: Guides
specs: [rich-text-editing, comments, attachments]
screens: []
order: 15
---
# Format notes and comments

<picture><source srcset="images/task-detail-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/task-detail-light.webp" alt="The task panel with formatted notes under the title and the comments below."></picture>

Notes and comments use the same editor, so everything here works in both (except **Make subtask**, which only notes have). Everything also works offline.

## Type to format

Start a line with `- ` for a bullet list, `1. ` for a numbered list, `[ ] ` for a checklist, `# ` for a heading or `> ` for a quote. Type ```` ``` ```` and press <kbd>Enter</kbd> for a code block: inside it, what you type stays exactly as typed. Select text and press <kbd>Ctrl</kbd>+<kbd>B</kbd> for bold, <kbd>Ctrl</kbd>+<kbd>I</kbd> for italic or <kbd>Ctrl</kbd>+<kbd>K</kbd> for a link (<kbd>⌘</kbd> on a Mac).

## The / menu

Type `/` at the start of a line or after a space to open a menu of everything the editor can insert: headings, lists, a table, a quote, a code block, a link, an image, today's date and a mention. Keep typing to filter it (`/tab` finds the table), move with <kbd>↑</kbd> and <kbd>↓</kbd>, press <kbd>Enter</kbd> to insert, or <kbd>Esc</kbd> to keep what you typed.

On a phone, a row of buttons (bold, italic, link, lists and **More**) sits above the text while you write. In the comment box on a computer, the **Formatting** button shows the same row, and the **@** button starts a mention.

## Tables

Choose **Table** from the `/` menu. <kbd>Tab</kbd> moves to the next cell and adds a row at the end; <kbd>Shift</kbd>+<kbd>Tab</kbd> goes back. Right-click a cell, or type `/` in it, to add or delete rows and columns or turn the header row off. A table holds up to 10 columns and 100 rows of plain text per cell, and scrolls sideways on a narrow screen.

## Images

Paste a screenshot, drop a picture, or choose **Image** from the `/` menu. The file becomes one of the task's [attachments](attachments.md) and shows where you put it. Select it to type a description for screen readers. A picture whose file was removed shows **Removed image**. Pasting a web address of a picture adds a link, never the picture: OpenTodo loads nothing from other sites. With end-to-end encryption the picture is decrypted on your device; on a locked device it reads **Encrypted image**.

## Mention someone

In a shared project, type `@` and a few letters of a member's name and pick them. Mentioning someone in a task's notes sends them a notification "mentioned you in the notes of …" once; later edits don't notify them again. After the people, the list offers the [groups of the workspace](workspaces.md#mention-a-group), shown with a group icon: `@Adults` notifies everyone in the group who can see the task.

## Make a checklist line a subtask

In a task's notes, put the caret on a checklist line and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> (or choose **Make subtask** from the `/` menu). The line becomes a link to a new subtask with its text; a ticked line makes a completed subtask. The link always shows the subtask's current title. <kbd>Ctrl</kbd>+<kbd>Z</kbd> right after takes both back.

## What other apps see

Notes and comments are stored as Markdown text too, so the API, the command line, exports and email show them as `| pipe | tables |`, `> quotes`, fenced code, `![name](attachment:…)` for pictures and `@name` for mentions.
