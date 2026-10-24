## ADDED Requirements

### Requirement: Group mentions
In a comment or in a task's notes on a task of a shared project in a created workspace, a member SHALL be able to mention a group of that workspace as `@` followed by the group's name without spaces. The mention completion SHALL offer, after the people, the groups of the task's workspace that reach at least one other member of the project, each marked as a group with the number of people it reaches. A group mention SHALL be stored as the entry `group:<group id>` in the comment's `mentions` or the task's `note_mentions`, beside the account ids, so that no operation field is added. The server SHALL keep such an entry only when the group exists in the project's workspace and the writer is a member of that workspace, and SHALL drop it otherwise, like the mention of a non-member. When it notifies, the server SHALL expand each newly listed group to its current members who are members of the task's project, never anyone else. Each person SHALL get at most one notification per change, however many times they are reached, never the author. A person reached only through a group SHALL be told the group's name. A person already reached by the previous value SHALL not be notified again by an edit. Mentions written by an AI assistant SHALL notify nobody. A group mention SHALL render as a chip with the group icon in the thread and in the notes, offline too, from the cached directory. Group ids SHALL be plaintext like account ids for an encrypted account, while the text stays encrypted. Mentions SHALL work offline: the comment or note is written at once and the server filters and notifies when it arrives. The stored lists SHALL converge by last-writer-wins like any field.

#### Scenario: Mention a group in a comment
- **WHEN** Alice writes "@Adults the fence is done" on a task of House, shared with the group Adults (Alice, Bob, Carol) in Family, and picks Adults in the completion
- **THEN** the comment's `mentions` holds `group:<Adults' id>`, and Bob and Carol each receive one notification reading "Alice mentioned Adults on Paint the fence" after their next sync, while Alice receives none

#### Scenario: Only people who can see the task
- **WHEN** Alice mentions the group Adults on a task of Trip, a project shared with Bob but not with Carol, who is in Adults
- **THEN** Bob is notified, and Carol is not notified and learns nothing about the comment

#### Scenario: Mentioned twice
- **WHEN** a comment mentions `@Bob`, `@Adults` and `@Parents`, and Bob is in both groups
- **THEN** Bob receives exactly one notification, the one for the direct mention

#### Scenario: Group from another workspace
- **WHEN** a device submits a comment on a task in Family whose `mentions` holds the id of a group of Work
- **THEN** the entry is dropped from the stored list, the comment is stored, and nobody is notified through that group

#### Scenario: Personal task
- **WHEN** a user mentions a group on a task in their Inbox
- **THEN** the stored list is empty and nobody is notified

#### Scenario: Group mention in notes
- **WHEN** Bob types `@Adults` in the notes of a task of House, picks the group and the note saves
- **THEN** the task's `note_mentions` holds the group's entry, Alice and Carol are notified once each with the notes as the source, and a later edit of the notes that keeps the mention notifies nobody again

#### Scenario: Picker order
- **WHEN** Alice types `@a` in a comment on a task of House, where Anna is a member and the group Adults exists
- **THEN** the completion lists Anna first and Adults after the people, marked as a group of three people

#### Scenario: Offline
- **WHEN** Alice mentions Adults in a comment while offline and reconnects an hour later
- **THEN** the chip shows at once on her device, and Bob and Carol are notified after the comment reaches the server

#### Scenario: Older client
- **WHEN** a client from before this change shows a comment that mentions a group
- **THEN** it shows `@Adults` as text, sends no change to the mention list, and nothing else differs

#### Scenario: Encrypted account
- **WHEN** an account with end-to-end encryption mentions a group in a comment
- **THEN** the body stays ciphertext on the server, the group entry is stored in plaintext beside the ids, and the group's members are notified exactly as for an account without encryption
