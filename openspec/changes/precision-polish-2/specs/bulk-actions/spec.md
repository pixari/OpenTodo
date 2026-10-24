## MODIFIED Requirements

### Requirement: Labels on several tasks
`L` or Labels with tasks ticked SHALL open the label picker showing labels carried by every ticked task as checked. Picking a label SHALL remove it from each ticked task when every ticked task carries it, and otherwise SHALL add it to each ticked task that lacks it, deciding from the ticked tasks as stored at the moment of the pick, not from what the picker showed, so a pick made before the picker has read the tasks acts as the checked state would have shown. While the picker is open its checks SHALL follow the ticked tasks as read: they SHALL appear when the read of the current selection lands, SHALL change after each pick, and SHALL never show the labels of an earlier selection. Each task's label array SHALL be read immediately before it is written, inside the batch, and written whole, so sequential edits on one device never lose a label; concurrent writes converge per task by last-writer-wins as for a single task.

#### Scenario: Add a label to three tasks
- **WHEN** three tasks are ticked, one already carrying "errand", and the user picks "errand"
- **THEN** the two others gain "errand", the first keeps its labels unchanged, and the picker stays open

#### Scenario: Remove a common label
- **WHEN** every ticked task carries "waiting" and the user picks the checked "waiting"
- **THEN** "waiting" is removed from each ticked task and their other labels are kept

#### Scenario: Picked before the picker has read the tasks
- **WHEN** two ticked tasks both carry "errand" and the user opens the label picker and picks "errand" before its checked marks appear
- **THEN** "errand" is removed from both tasks

#### Scenario: Checks appear in an open picker
- **WHEN** two ticked tasks both carry "errand" and the user presses `L` before the menu has read them
- **THEN** "errand" becomes checked in the open picker as soon as the tasks are read, and after the user picks it, it is removed from both and its check goes away in the same picker
