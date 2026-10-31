## ADDED Requirements

### Requirement: Sortable custom field values
Project, label and saved-view task lists SHALL be able to order by a live Number or Date custom field. The stored sort SHALL identify its selected definition as `field:<definition-id>`. The device SHALL resolve the selected definition's decrypted name locally, then match it case-insensitively among the live definitions applicable to each task's project, including inherited definitions. The name SHALL NOT be included in synced sort values. If several definitions on one task's applicable field chain have the same name, the first in the existing applicable-field order SHALL supply that task's value. Number values SHALL be compared numerically and Date values SHALL be compared chronologically. If same-named definitions have different types across tasks, Number values SHALL sort before Date values, followed by Text values in both directions; descending SHALL reverse only values within each type. Text values SHALL compare using the same locale-aware comparison as Title with sensitivity 'base', with equal text using the existing default tie fallback. A task without an applicable definition or without a value SHALL sort after tasks with a value in either direction. A value that does not match the definition's sortable type SHALL be treated as missing for ordering. Renaming a selected definition SHALL retain its sort because the ID is stable. A deleted or unavailable selected definition SHALL fall back to the page's default order and retain the stored ID. The sort SHALL be derived on the device from synced definitions and task values, work offline and converge to the same order as those operations sync.

#### Scenario: Sort number values numerically across projects
- **WHEN** a saved view contains tasks in two projects that both define a Number field named "WSJF", with values 2 and 10
- **THEN** ordering by WSJF puts 2 before 10 ascending and 10 before 2 descending

#### Scenario: Match field names without regard to case
- **WHEN** one project defines the Number field "WSJF" and another defines the Number field "wsjf"
- **THEN** a list containing both projects offers one WSJF sort option and orders both projects' values together

#### Scenario: Sort dates chronologically
- **WHEN** tasks have values `2026-02-01` and `2026-11-01` in same-named Date fields
- **THEN** ascending order puts February before November and descending order puts November before February

#### Scenario: Missing values stay last in either direction
- **WHEN** a list is ordered by a Number field and one task has no matching definition or value
- **THEN** the task without a value appears after tasks with values in ascending and descending order

#### Scenario: Same-named fields with different types
- **WHEN** a saved view contains a Number field named "Score" in one project and a Date field named "score" in another
- **THEN** Order by offers Score once, Number values sort before Date values, followed by Text values in both directions; descending reverses only values within each type, and each task uses the first matching definition in its applicable-field order

#### Scenario: Resolve an inherited name clash
- **WHEN** a task's project has two applicable live definitions named "Size" after a project move
- **THEN** its value under the first definition in applicable-field order determines its position

#### Scenario: Same name with Number and Text definitions
- **WHEN** one project defines Number Score with value 10, another defines Text score with value "Alpha", and another task has no value
- **THEN** both directions put the number before the text before the missing value, reversing only the order within each type

#### Scenario: Parent field applies to sub-project tasks
- **WHEN** a parent project defines Number WSJF and its sub-project tasks have values in that inherited field
- **THEN** sorting by the inherited field's definition ID resolves its local name through fieldTree and orders the values numerically
