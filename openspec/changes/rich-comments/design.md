# Design

## Context

`editor-everywhere` (D1, D2) made the expanded comment composer the notes editor, mounted on a Markdown body:
- `RichComposerField` parses the body once and writes `renderMarkdown` of the document back on every change.
- An unchanged document gives back the original text, byte for byte.
- The editor chunk is lazy. Until it loads, the composer is a plain textarea with its own `@` completion.

The shared `ComposerFrame` (task-full-page D6) has a tool row meant for "mention, attach, a skills menu". The comment composer only puts the paperclip there. The editor's formatting row (`EditorToolbar`) shows only on a coarse pointer while the editor has focus.

Task notes are different. They are a Yjs document (`notes_doc`) with a Markdown projection (`description`), because several people edit one note concurrently.

## Goals / Non-Goals

**Goals**
- Make what the comment editor can do visible on a computer: mentions (people and groups) and formatting.
- Keep comments' stored format, API, rendering and guest replies exactly as they are.

**Non-Goals**
- A mergeable comment document, rich guest replies, changes to the server.

## Decisions

### D1. Comments stay Markdown in `body`; no `notes_doc` for comments
Notes need a mergeable document because a note is long-lived, shared and edited by several people at once: two edits must merge, not overwrite each other. A comment is written by one author, edited only by that author, and replaced as a whole (comments D2, last-writer-wins on `body`). A document would add a second representation to keep in step, a projection for the API, a fold for plain-text writers (REST, MCP, CLI, email), and a bigger encrypted payload, and it would buy nothing a comment needs. The editor already round-trips its Markdown subset exactly and keeps text outside it verbatim. Decision: keep `comment.body` as the only representation, add nothing to the op schema, and keep the REST, MCP and CLI plain-text API unchanged.

### D2. A Mention button in the tool row
`Composer` renders an icon button "Mention someone" (`at-sign`) in `ComposerFrame`'s tools, before the paperclip, when it has mention targets.
- **Rich editor.** The button calls a `mention()` handle on `RichComposerField`. It focuses the editor, inserts `@`, with a space first when the character before the caret is not a space or the start of a block, and lets the suggest plugin open the list as for a typed `@`.
- **Plain field.** It inserts the same text at the textarea's caret, moves the caret after it, and the existing completion opens.
- **Focus.** The button does not take focus on press (`onMouseDown` preventDefault), so the selection survives. The composer expands when the button is used.

### D3. A Formatting toggle on fine pointers
`RichComposerField` accepts `toolbar: boolean`. `EditorToolbar` gains a `forced` mode that shows the row whatever the pointer and whether or not the editor has focus. `Composer` renders a toggle button "Formatting" (`bold` icon, `aria-pressed`) in the tool row on a fine pointer. It is not rendered on touch, where the row already appears while the editor has focus.
- The state is kept per composer instance and not stored. A comment box opens quiet, which matches the Precision look.
- The toggle is shown whenever the composer uses the rich editor. Pressed while the editor chunk is still loading, it takes effect when the editor arrives. The plain field, used by stories with fixed baselines and as the fallback, has no toggle.

### D4. Guests and rendering
The public task page keeps its plain `Textarea` and renders bodies with `MarkdownView`. Nothing in this change touches it, and a test pins that a guest reply is posted as typed. Thread rendering is unchanged: the same `Markdown` component, the same subset.

### Data-model impact
None. No op field, no route, no migration. `comment.body` remains a content field for end-to-end encryption (`internal/e2ee.ContentFields`, `CONTENT_FIELDS`).

### Dependencies and footprint
None. A few hundred bytes in the main bundle (two buttons in `Composer`) and in the lazy editor chunk (the forced toolbar mode).

### Interface budget
The two buttons sit in the composer frame's existing tool row. No new row of chrome, no new scroll region, no new sidebar destination. No new shortcut: the editor's own keys (Ctrl/⌘+B, I, K, `/`, `@`) are unchanged and listed in the cheat sheet.

## Implementation notes (apply step)

- `RichComposerField` exposes `mention()` on its handle, and `EditorToolbar` takes `always`. The Formatting toggle uses the `bold` icon: the icon set has no text icon, and adding one would mean a catalogue change for a single button.
- In the plain field, the Mention control renders the new text synchronously (`flushSync`) and places the caret after the `@`. The plain completion's pick now also sets its caret state when it moves the caret, so a pick followed right away by Ctrl+Enter sends instead of reopening the list.
- The docs screenshots show the comment box at rest, a single line without the tool row, so they are unchanged. The three `Task/Comments` stories got new baselines from the pinned Playwright image.

## Risks / Trade-offs

- [More icons in a quiet box] → Only two, both icon buttons in the row that already holds the paperclip and Send, and Formatting does not exist on touch.
- [Inserted `@` lands in the middle of a word] → A space is inserted first when needed, so the suggest plugin, which needs a word start, always opens.

## Migration Plan

None.

## Open Questions

None.
