## MODIFIED Requirements

### Requirement: Breakpoints follow the text size
Every layout decision a script makes from the viewport width (phone or desktop header, drawer or sidebar, the task split, two-column settings, toast and overlay placement) SHALL use the same rem breakpoints as the stylesheet (40, 48 and 64 rem), so a browser text size other than the default moves script and stylesheet breakpoints together. The stylesheet's own media queries and the breakpoints written into class names SHALL be in rem as well. At a browser text size of 20 and 24 px, at 360 and 1280 px wide, the screens SHALL show no content running off the screen, no control squeezed below a readable width and no overlapping controls caused by the text size: where a row cannot hold its parts, the parts SHALL wrap (a field to its own line, a badge under a name, a mode switch to a second line) rather than shrink. This holds for the screens of `precision-polish` and for Settings in every section, Statistics, Focus, the Loop home, the task page, the command palette and quick add, the dialogs and menus, sign-in and display mode. At the default text size of 16 px the layout SHALL be unchanged. A control whose label would push a page title off a phone at a large text size MAY keep only its icon below 21 rem of viewport, keeping its accessible name; this includes the phone header's Process with its count.

#### Scenario: Large text between 768 and 960 px
- **WHEN** the browser's text size is 20 px and the window is 900 px wide
- **THEN** the app uses the phone layout with the drawer, as the stylesheet does, and the sidebar is reachable from the menu button

#### Scenario: Large text on a 1100 px window
- **WHEN** the browser's text size is 20 px and the Inbox is opened in a 1100 px window
- **THEN** selecting a task opens its page instead of docking it beside the list, because the detail pane is not shown below 64 rem

#### Scenario: Process on a phone with large text
- **WHEN** the Inbox is opened at 360 px with the browser's text size at 24 px
- **THEN** the Process button shows its icon only, its accessible name is still "Process", and the page title "Inbox" is readable beside it

#### Scenario: Date picker on a phone with large text
- **WHEN** the When popover is opened at 360 px with the browser's text size at 24 px
- **THEN** all seven weekday columns of the month grid are on screen, each day still a 44 px touch target

#### Scenario: Share dialog with large text
- **WHEN** the Share dialog is opened at 360 px with the browser's text size at 24 px
- **THEN** the email field takes its own line and the role and Share sit under it

#### Scenario: Statistics with large text
- **WHEN** Statistics is opened at 360 px with the browser's text size at 20 px
- **THEN** the tiles are one column, and at the default text size they stay two columns
