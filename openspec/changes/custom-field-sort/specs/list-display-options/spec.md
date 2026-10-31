## MODIFIED Requirements

### Requirement: Display options on project and label pages
A project page in the List layout and a label page SHALL offer the display panel of saved views (OpenSpec `custom-views` "Display panel") from a display button among the header's actions (in the phone bar's slots below 768 px), with **Group by** and **Order by** and the direction under **More options**, and without the layout, completed tasks and row properties parts. A project SHALL offer grouping by Section (default), None, Due date, Priority or Label; a label page by Project (default), None, Due date or Priority. Both SHALL offer ordering by Manual order, Priority, Due date, Created, Deadline, Title or a sortable Number or Date custom field (OpenSpec `custom-fields` "Sortable custom field values"), ascending or descending. Custom-field options SHALL be matched case-insensitively by name and shown once; if matching definitions have different types across tasks, Number values SHALL sort before Date values, followed by Text values in both directions, with values reversed within each type descending; missing values SHALL remain last in either direction. A choice SHALL apply at once. A project's Board and Timeline layouts SHALL not show the panel and SHALL be unchanged by it.

#### Scenario: Choose a custom field order on a project
- **WHEN** the user opens Display options on a project with a live Number field named "WSJF" and chooses WSJF
- **THEN** the project's list orders its tasks by their WSJF values and the choice is stored for that project only

#### Scenario: Choose a custom field order on a label page
- **WHEN** the user opens Display options on a label whose tasks span projects with same-named Number fields
- **THEN** Order by offers that field once and the label's tasks are ordered by the values from their respective project definitions

#### Scenario: Group a project by priority
- **WHEN** the user opens Display options on the project "Home" and chooses Group by Priority
- **THEN** the list shows the headings "Priority 1" and "Priority 2" with the project's tasks under them, and the choice is stored for "Home" only

#### Scenario: Choices of a label page
- **WHEN** the user opens Display options on the label "errand"
- **THEN** Group by offers Project, None, Due date and Priority, and Order by offers Manual order, Priority, Due date, Created, Deadline, Title and applicable Number and Date custom fields

#### Scenario: Board unchanged
- **WHEN** a project grouped by priority is switched to the Board layout
- **THEN** the board shows one column per section as before and the header shows no display button

### Requirement: Grouping and order of a project or label list
Grouping and order SHALL apply to a project's top-level tasks; each SHALL keep its subtasks under it in their manual order. Groups SHALL have the headings and order of a saved view's grouping (due date: Earlier, Today, Tomorrow, each later date, No date; priority: Priority 1 to 4; label: the labels in label order, then No label). A task SHALL be listed once: a task with several labels under the first of them in label order. Grouping by Section SHALL keep the project's sections with their headers, collapsing, adding and dropping, ordering the tasks inside each; None SHALL list the tasks without headings. Due date, deadline and custom-field orders SHALL list tasks without a value last in either direction; for priority, descending SHALL put priority 1 first. Equal custom-field values SHALL fall back to due date, priority, position and task id, in that order. A project's Later and Completed groups SHALL stay at the end. The defaults SHALL show what the pages showed before: a project by section in manual order, a label by project in manual order.

#### Scenario: Order inside sections by a custom field
- **WHEN** a project with sections is ordered by its Number field "Effort", descending
- **THEN** each section lists tasks with the greatest Effort first, tasks without Effort last, and the sections keep their order and headers

#### Scenario: Keep subtasks and Later tasks in place
- **WHEN** a project is ordered by a custom field and a top-level task has subtasks
- **THEN** its subtasks remain under it in manual order and the Later and Completed groups remain at the end

#### Scenario: Subtasks stay with their parent
- **WHEN** a project is grouped by priority and a priority-2 task has a priority-4 subtask
- **THEN** the subtask is listed under its parent in the "Priority 2" group, indented

#### Scenario: Order inside sections
- **WHEN** a project with sections is ordered by priority, descending
- **THEN** each section lists its priority-1 tasks first, and the sections keep their order and headers

#### Scenario: Several labels
- **WHEN** a project is grouped by label and a task carries "work" and "call", with "call" first in the label order
- **THEN** the task is listed once, under "call"
