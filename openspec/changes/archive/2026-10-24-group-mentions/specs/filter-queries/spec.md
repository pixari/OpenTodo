## ADDED Requirements

### Requirement: Workspace terms
The grammar SHALL accept `workspace: name`, with the name bare or quoted and the prefix in any case, matching tasks of the workspace of that name, ignoring case, among the workspaces cached on the device. A task's workspace SHALL be decided by the workspace rules: its project's workspace, else its parent task's, else its own `workspace_id`, an absent, null or unknown value meaning the default workspace. A query containing a `workspace:` term SHALL be evaluated over the tasks, projects and labels of every workspace, and a query without one over the current workspace only, in the Filter view, in saved views and in their sidebar counts. An unknown workspace name SHALL warn and match nothing. A missing name SHALL be a syntax error. The Go parser that validates saved views SHALL accept and reject the same queries with the same messages, pinned by the shared examples. The filter builder SHALL offer a Workspace condition, choosing among the cached workspaces, reading "Workspace is Home", when the account has more than one workspace or the condition being edited is one. Evaluation SHALL work offline from the local data, and results SHALL follow a task moved to another workspace on any device after sync.

#### Scenario: Everything due this week at home and at work
- **WHEN** the user is in "Personal" and runs `(workspace: Home | workspace: Work) & due = this week`
- **THEN** the results list the tasks due this week of both workspaces, and none of Personal's

#### Scenario: Quoted name
- **WHEN** the user runs `workspace:"Side projects" & p1`
- **THEN** the results are the priority-1 tasks of the workspace named "Side projects"

#### Scenario: Inbox task of a workspace
- **WHEN** a task without a project carries the `workspace_id` of "Home" and the user runs `workspace: home & no project`
- **THEN** that task is listed

#### Scenario: Without the term
- **WHEN** the user is in "Work" and runs `due <= today`
- **THEN** only Work's tasks are listed, as before this change

#### Scenario: Unknown workspace
- **WHEN** the user runs `workspace: Garage` and no cached workspace has that name
- **THEN** the view lists nothing and shows the warning "No workspace named "Garage""

#### Scenario: Missing name
- **WHEN** the user types `workspace: & p1`
- **THEN** the Filter view shows `Expected a workspace name after "workspace:" at position 1`, and saving a view with that query through the API answers 400 with the same message

#### Scenario: Saved view counts follow
- **WHEN** a saved filter `workspace: Home & today` is pinned in the sidebar of "Personal" and a task of Home becomes due today on another device
- **THEN** after sync the view's count in Personal's sidebar goes up by one

#### Scenario: Build it without typing
- **WHEN** the user opens + Condition in the filter builder, chooses Workspace and picks Home
- **THEN** the formula reads `workspace: Home` and the chip reads "Workspace is Home"

#### Scenario: Offline
- **WHEN** the device is offline and the user runs `workspace: Work & @errand`
- **THEN** the results come from the local data: Work's tasks carrying a label named errand
