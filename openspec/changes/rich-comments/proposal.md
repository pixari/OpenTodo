# Proposal

## Why

Comments have used the notes' rich-text editor since `editor-everywhere`: bold, italics, lists, quotes, code, tables, images, links and @-mentions, with the `/` menu. On a computer none of it is visible. The comment box shows a placeholder and a paperclip; formatting needs the keyboard shortcuts or knowing about `/`; and a mention needs knowing to type `@`. The Precision design's comment box had a visible **@** button in its tool row, and the shared composer frame was built for it ("mention, attach, a skills menu"). Now that groups can be mentioned too (`group-mentions`), the button matters more: it is how people find out who they can reach. ROADMAP.md future idea "Rich text for comments" asked for the notes editor in comments "without losing the plain-text API". The editor is there; this change finishes the job in the interface.

## What Changes

- **A Mention button in the comment box.** The tool row of the comment composer gets an **@** button (named "Mention someone") when the task's project has people or groups to mention. It inserts `@` at the caret, with a space before it when needed, and opens the completion. In the rich editor and in the plain field alike, it keeps the focus and the draft.
- **A Formatting button.** On a computer, a **Formatting** toggle (the bold icon) in the same row shows the editor's formatting row: bold, italic, link, bullet list, checklist and **More** (headings, numbered list, quote, code block, table, image, date, strikethrough). Phones keep showing that row while the comment box has focus, as today. The toggle is pressed while the row is shown and is reachable with Tab.
- **Nothing changes in what is stored or served.** A comment stays one Markdown string in `comment.body`. The REST routes, MCP tools, the CLI, the export and other apps read and write it as before. No field is added, renamed or removed, and the server is unchanged. With end-to-end encryption the body stays a content field, encrypted like today.
- **Rendering stays as it is.** Existing comments render as before. Guest replies on task pages keep their plain text box and render with the same Markdown renderer.

Out of scope:
- A second stored representation of comments (a mergeable document like `notes_doc`). Comments are short, written by one person and replaced as a whole. The decision of `editor-everywhere` D1 stands, and this change records why (design D1).
- Rich text for guests on task pages, collaborative editing of comments, and mentions or formatting in the CLI and MCP (they keep Markdown).

ROADMAP.md: completes the future idea "Rich text for comments". No new environment variable, and no op-log change. Nothing here is **BREAKING**.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `comments`: "Composer behaviour" gains the Mention and Formatting controls in the composer's tool row.

## Impact

- Client: `web/src/app/task-detail/Composer.tsx`, `RichComposerField.tsx`, `web/src/app/EditorChrome.tsx` (the formatting row shown on request), the comment stories and their baselines, five translation catalogs.
- Docs: `docs/comments-and-activity.md`, `docs/formatting.md`, CHANGELOG.
- No server change, no dependency, no migration.
