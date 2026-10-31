## MODIFIED Requirements

### Requirement: Grouping and sort options
A list view SHALL group its results by project, due date, priority, label or none, and sort within groups by due date, priority, position, created time, deadline, title or a sortable Number or Date custom field, ascending or descending, as stored on the view; under a deadline sort or a custom-field sort, tasks without a value SHALL come last in either direction. A custom-field sort SHALL be stored as `field:<definition-id>` and resolve the selected definition's decrypted name on the device, then match live definitions case-insensitively among each task's applicable fields, including inherited parent-project fields. Definition IDs are non-content metadata, so the operation log SHALL NOT contain the field name. Renaming the selected definition SHALL keep the sort attached to its ID; a deleted or unavailable definition SHALL use the default order while retaining the ID. Equal custom-field values SHALL fall back to due date, priority, position and task id in that order. Defaults SHALL be grouping by project and sort by due date ascending with undated tasks last. Options SHALL be changeable from the view's display panel with the keyboard; sort direction is under More options. The New view page SHALL group and sort the same way, so a saved view shows what was seen before saving.

#### Scenario: Sort by a custom Number field
- **WHEN** the user orders "Work tomorrow" by the Number field "WSJF", descending
- **THEN** each group shows tasks with the greatest WSJF value first and tasks without a value last

#### Scenario: Sort by a custom Date field
- **WHEN** the user orders "Work tomorrow" by the Date field "Review date", ascending
- **THEN** each group shows the earliest review date first and tasks without a value last

#### Scenario: Equal field values use the default order
- **WHEN** two tasks have the same value for the selected custom field
- **THEN** they are ordered by due date, then priority, then position and task id

#### Scenario: Group by due date
- **WHEN** the user sets grouping to due date on "Work tomorrow"
- **THEN** results are shown under "Earlier", "Today" and "Tomorrow" headings in that order

#### Scenario: Sort by priority descending within groups
- **WHEN** sort is set to priority with descending direction
- **THEN** within each group priority-1 tasks come first and priority-4 last

#### Scenario: Same order before and after saving
- **WHEN** the user groups the New view page's results by priority and orders them by title, then saves the view
- **THEN** the saved view shows the same groups in the same order

#### Scenario: Sort by deadline
- **WHEN** the user orders "Work tomorrow" by deadline
- **THEN** tasks with the nearest deadline come first and tasks without a deadline last

#### Scenario: Manual order after saving
- **WHEN** the user saves a view from the New view page and then chooses Order by Manual order on it
- **THEN** the view lists its tasks by their positions until the user moves one, after which the moved order is kept on the view

### Requirement: Views API and export
The API SHALL expose `/api/v1/views` with list, get, create, patch and delete following the collection conventions: authentication required, soft delete, write-through to the operation log, unknown fields rejected. Create SHALL require a name and a query that parses; option values outside the allowed sets SHALL be rejected, except that sort_by SHALL also accept a custom-field sort in the form `field:<definition-id>` with a canonical UUID. The API SHALL preserve the ID without resolving or transmitting the field name; the client resolves it from local live definitions. layout SHALL be list or board, show_completed a boolean and hidden_props a list of row properties (date, project, labels, estimate, assignee, deadline, start, origin); a view created without them reads as the list layout with completed matches hidden and every property shown. on_drop SHALL be accepted on list views only, as null or an object whose keys and values are those of the on-drop rule, with label ids that exist and are not deleted and a section that belongs to the named project; it SHALL be replaced as a whole on patch. The export SHALL include a views array with deleted views, each view carrying on_drop.

#### Scenario: Create a view via the API
- **WHEN** a script POSTs `{"name":"Waiting","query":"@waiting","pinned":true}` to `/api/v1/views` with a bearer token
- **THEN** the response is 201 with the view including `id`, `position`, defaults for grouping and sort, `on_drop` null, and devices show it after their next sync

#### Scenario: Unauthenticated request
- **WHEN** a request without credentials lists or creates views
- **THEN** the response is 401 `unauthorized`

#### Scenario: Invalid option value
- **WHEN** a create body sets `group_by` to "colour"
- **THEN** the response is 400 `invalid_input` and the view remains unchanged

#### Scenario: Create a view ordered by a custom field
- **WHEN** an authenticated client creates a view with sort_by set to `field:0a4f7d89-6c12-4b63-8a91-2e35c47d8091`
- **THEN** the API stores and returns the same field definition ID as the view's sort value

#### Scenario: Patch a view's custom-field order
- **WHEN** an authenticated client patches a view with sort_by set to `field:0a4f7d89-6c12-4b63-8a91-2e35c47d8091`
- **THEN** the API stores and returns the same field definition ID as the view's sort value

#### Scenario: Reject a custom-field name or malformed ID
- **WHEN** a create or patch body sets sort_by to `field:WSJF` or a malformed UUID
- **THEN** the response is 400 `invalid_input` and the view remains unchanged

#### Scenario: Set a rule via the API
- **WHEN** a script PATCHes `{"on_drop":{"priority":1,"due":"today"}}` on a list view with a bearer token
- **THEN** the response is 200 with the view carrying that rule, and a card dropped into a panel showing the view on any device after sync gets priority 1 and today's date

#### Scenario: Invalid rule
- **WHEN** a patch body sets `on_drop` to `{"priority":5}`, to `{"due":"friday"}`, to `{"add_labels":["<unknown id>"]}`, to `{"colour":"red"}`, or sets any rule on a view of kind `dashboard`
- **THEN** the response is 400 `invalid_input` naming the field and nothing is written

#### Scenario: Export carries rules
- **WHEN** the user downloads the export after giving a saved filter a rule
- **THEN** the view appears in `views` with its `on_drop` object, and views without a rule carry `"on_drop": null`

#### Scenario: Display options via the API
- **WHEN** a script PATCHes `{"layout":"board","hidden_props":["estimate"]}` on a list view with a bearer token
- **THEN** the response is 200 with the view carrying both values, and devices show the view as a board without estimates after their next sync

#### Scenario: Invalid display option
- **WHEN** a patch body sets `layout` to "grid" or `hidden_props` to `["colour"]`
- **THEN** the response is 400 `invalid_input` naming the field and nothing is written
