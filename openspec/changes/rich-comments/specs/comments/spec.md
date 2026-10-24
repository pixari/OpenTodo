## MODIFIED Requirements

### Requirement: Composer behaviour
The composer SHALL rest as a single line and expand when focused, when it holds a draft or a reply target, or when its shortcut is pressed. Expanded, it SHALL be the rich-text editor of this app (the one used for notes) with the editing features of `rich-text-editing` except Make subtask, SHALL grow with its content up to a limit, keep @-mention completion, show the submit key combination, sit in the shared composer frame (a bordered box with the field, the tools on the left and a round Send control on the right, the same frame the assistant composer is built to use), keep an unsent draft per task on the device while the task is not open, and show the reply target with a way to cancel it when replying. The frame's tools SHALL include a Mention control whenever the task has people or groups to mention, which inserts `@` at the caret (after a space when the caret follows other text) and opens the mention completion without losing the draft or the selection, in the rich editor and in the plain field alike. On a fine pointer, the tools SHALL include a Formatting toggle, announced as pressed while shown, that shows the editor's formatting row (bold, italic, link, bullet list, checklist and More); on touch screens the row SHALL keep appearing while the editor has focus. While the editor is still loading on a device that has never opened it, typed text SHALL be kept in a plain field and submitted as plain Markdown if the user submits first. The composer SHALL serialise to Markdown on submit within the documented subset, and editing an existing comment SHALL open its Markdown in the editor so that a comment opened and submitted unchanged keeps the same body. The stored body, the comment routes and the representation for other clients SHALL not change with the editor.

#### Scenario: Draft survives closing the panel
- **WHEN** the user types a comment, returns to the list without sending and reopens the task on the same device
- **THEN** the draft is still in the expanded composer, and it is not visible on other devices

#### Scenario: Cancel a reply
- **WHEN** the user chooses Reply on a comment and then cancels the reply target
- **THEN** the composer posts a new top-level comment instead

#### Scenario: Collapses when left empty
- **WHEN** the user focuses the composer, types nothing and moves focus elsewhere
- **THEN** the composer returns to its single resting line

#### Scenario: Formatting from the keyboard
- **WHEN** the user expands the composer, types `- ` and some text, selects a word and presses the bold shortcut, then submits with the key combination
- **THEN** the stored body is `- …**word**…` Markdown and the thread shows a bullet with the bold word, with no mouse interaction

#### Scenario: Unchanged edit is byte-identical
- **WHEN** the author opens Edit on a comment whose body uses only the documented subset and submits without changing anything
- **THEN** no operation is produced, because the serialised body equals the stored body

#### Scenario: Text outside the subset survives an edit
- **WHEN** the author edits a comment whose body contains `<details>` HTML and a footnote reference, changes one word elsewhere and submits
- **THEN** the HTML and the footnote text are still in the body verbatim, shown as text, and only the word changed

#### Scenario: Send control
- **WHEN** the composer is expanded and empty
- **THEN** its round Send control is disabled and named after the action ("Comment", "Reply", "Save"), and typing text enables it

#### Scenario: Mention from the button
- **WHEN** the user has typed "Thanks" in the composer of a task in a shared project and activates the Mention control
- **THEN** the text reads "Thanks @", the completion lists the project's people and then the workspace's groups, and picking Anna and posting stores "Thanks @Anna" with Anna's id in the mentions

#### Scenario: No one to mention
- **WHEN** the user opens the composer on a task in their Inbox
- **THEN** no Mention control is shown

#### Scenario: Formatting row on a computer
- **WHEN** the user on a computer activates the Formatting toggle, selects a word and activates Bold in the row
- **THEN** the word is bold, the toggle is announced as pressed, and activating the toggle again hides the row

#### Scenario: Plain-text API unchanged
- **WHEN** a script posts `{"body": "**done**, see @Anna"}` to a task's comments and reads the thread back
- **THEN** the body is returned as the same Markdown string, and the app shows "done" in bold with a mention chip for Anna
