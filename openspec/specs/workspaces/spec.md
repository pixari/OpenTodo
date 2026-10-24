# workspaces Specification

## Purpose
Lets one account keep separate rooms on one server, each with its own projects, labels, views, members and groups, so that work and home stay apart and a project can be shared with a group of people in one step, without changing how data syncs or who can see what.

## Requirements

### Requirement: Workspace entity
A workspace SHALL have an id, a name of 1 to 60 characters, an optional icon from the app's icon set, an optional colour, an owner account, a creation time and an optional deletion time. Every account SHALL have exactly one *default workspace*, created by the server when the account is created (and once, at upgrade, for every existing account), named "Personal" until renamed, which SHALL NOT be deletable. Workspaces, their membership and their groups SHALL be server-side data: they are never written to the operation log, they change only through authenticated routes, and they are delivered to every device of each member through the sync exchange and cached locally, so the sidebar, pickers and counts work offline from the cache.

#### Scenario: Existing account after upgrade
- **WHEN** a server with three accounts is upgraded and each account syncs
- **THEN** each account has one default workspace holding every project, label, view and task it had, named "Personal", and nothing else about the account's data or ids has changed

#### Scenario: Create a workspace
- **WHEN** a signed-in user posts `{"name":"Work"}` to `/api/v1/workspaces`
- **THEN** the response is 201 with the workspace's `id`, `name`, `role: "owner"` and empty `members` and `groups` lists, and the user's other devices receive it on their next sync

#### Scenario: Create while offline
- **WHEN** the device is offline and the user opens "New workspace"
- **THEN** the form says a connection is needed, and no workspace is created locally

#### Scenario: Default workspace cannot be deleted
- **WHEN** the owner deletes their default workspace
- **THEN** the response is 409 `default_workspace` and nothing changes

#### Scenario: Invalid name
- **WHEN** the body carries an empty name, a name over 60 characters or an icon outside the catalogue
- **THEN** the response is 400 `invalid_input` naming the field

#### Scenario: Anonymous request
- **WHEN** a request without credentials reaches any workspace route
- **THEN** the response is 401 `unauthorized`

### Requirement: What belongs to a workspace
A project, a label, a saved view and a task without a project SHALL each carry an additive `workspace_id` field, written and synced as an ordinary operation and converging by last-writer-wins; absent or null SHALL mean the account's default workspace. A task with a project SHALL belong to its project's workspace, whatever its own `workspace_id` says. Sections, custom fields, comments, attachments, reminders and time entries SHALL belong to their task's or project's workspace. Favourites and promoted destinations SHALL be read per workspace from the existing preference values (an entry whose item is in another workspace is ignored there, never rewritten). A device that has not received a workspace named by an entity SHALL show that entity in the default workspace until the workspace arrives, and SHALL write nothing.

#### Scenario: Older client ignores the field
- **WHEN** a client from before this change syncs an account with two workspaces
- **THEN** it lists every project, label and task in one sidebar as before, and the ops it writes carry no `workspace_id`, so its new projects land in the default workspace

#### Scenario: New project in the current workspace
- **WHEN** the user is in "Work" and creates a project "Website"
- **THEN** the project's `workspace_id` is "Work"'s id, it appears in the Work sidebar at once, offline too, and on other devices after sync in Work and nowhere else

#### Scenario: Task follows its project
- **WHEN** a task whose own `workspace_id` names "Personal" is moved into the project "Website" of "Work"
- **THEN** it appears in Work's "Website" and in no view of Personal, and its own `workspace_id` is not rewritten

#### Scenario: Concurrent moves converge
- **WHEN** device A moves the label "errand" to "Work" offline while device B moves it to "Family" offline, and both sync
- **THEN** every device shows the label in the workspace of the write with the greater timestamp

#### Scenario: Unknown workspace
- **WHEN** a project arrives whose `workspace_id` names a workspace this device has not received
- **THEN** the project is listed in the default workspace, no operation is written, and it moves to its workspace once that workspace arrives in a sync response

### Requirement: The current workspace on a device
Each device SHALL remember the current workspace (never synced; the default workspace on a device that has not chosen one, or whose chosen workspace is gone). The sidebar's header row SHALL be the workspace control: the current workspace's icon or colour and name, opening a switcher that lists the user's workspaces with their Inbox and Today counts, marks the current one, and offers "New workspace" and "Manage workspaces". Every view, group, count, search and quick add SHALL show and act on the current workspace only: Inbox, Today, Upcoming, Calendar, Loop home, Next, Waiting, Anytime, Someday, Assigned to me, Completed, Updates, Trash, Filter, Review, Statistics, the Favourites, Projects, Labels and Filters groups, the labels overview, the archived projects list and the Plan. Switching SHALL keep the current view when it exists in the target workspace (the Inbox stays the Inbox) and open the Inbox otherwise. The switcher SHALL be reachable by keyboard from the sidebar and through the palette commands "Switch to workspace …" (one entry per workspace) and "New workspace"; no default key SHALL be assigned.

#### Scenario: Switch keeps the view
- **WHEN** the user is in Today of "Personal" with 4 tasks and switches to "Work"
- **THEN** Today shows Work's tasks due today, the sidebar's groups show Work's projects and labels, Inbox and Today counts are Work's, and the header reads "Work"

#### Scenario: Switch from a project
- **WHEN** the user is in the project "Garden" of "Personal" and switches to "Work"
- **THEN** the Inbox of Work opens, and switching back to Personal opens Personal's Inbox (the device does not return to "Garden")

#### Scenario: Remembered per device
- **WHEN** the user switches to "Work", reloads the app, and opens the app on another device
- **THEN** this device opens in Work and the other device opens in the workspace it last used

#### Scenario: Chosen workspace gone
- **WHEN** the device last used a workspace the user has since left or deleted
- **THEN** the app opens in the default workspace and a toast says the workspace is no longer available

#### Scenario: Offline switch
- **WHEN** the device is offline
- **THEN** the switcher lists the cached workspaces with their counts and switching works

#### Scenario: Palette crosses workspaces
- **WHEN** the user is in "Personal", opens the palette and types the title of a task that lives in "Work"
- **THEN** the task is listed with "Work" as its marker, and picking it switches the device to Work and opens the task

#### Scenario: Keyboard only
- **WHEN** the user focuses the workspace control with the keyboard, presses Enter, moves with the arrows and presses Enter on "Work"
- **THEN** the device switches to Work and focus lands on the page heading

### Requirement: Links and notifications across workspaces
Opening an address that names an entity of another workspace (`?task=<id>`, `/project/<id>`, `/task/<id>`, a notification, a saved view's route) SHALL switch the device to that entity's workspace and open it, with a toast naming the switch. The address format SHALL not change. The bottom tab bar on phones SHALL act on the current workspace and SHALL be unchanged.

#### Scenario: Notification from another workspace
- **WHEN** the user is in "Personal" and opens a notification for a mention in a task of "Work"
- **THEN** the device switches to Work, the task opens, and a toast reads "Switched to Work"

#### Scenario: Shared link
- **WHEN** a user opens `/project/<id>` of a project in "Work" on a device currently in "Personal"
- **THEN** the project opens in Work

### Requirement: Workspace membership and roles
A workspace SHALL have exactly one `owner` (its creator until transferred) and any number of members with the role `admin` or `member`. In a workspace the user created, the owner and admins SHALL add an existing account by its exact email and change roles; the owner SHALL transfer ownership to a member and delete the workspace; any member but the owner SHALL leave; admins SHALL remove members, the owner anyone but themselves. The default workspace of an account SHALL have that account as its only member and SHALL accept no members. Membership SHALL be visible to every member and cached on each device; a device SHALL adopt the server's list on every sync. Removing a member SHALL also remove every project grant they hold in that workspace, directly or through its groups, with the effects of removal from those projects.

#### Scenario: Add by email
- **WHEN** the owner of "Family" adds `bob@example.com`, an existing account, as `member`
- **THEN** Bob is listed in Family's members on every member's devices after sync, Bob's devices receive the workspace, and Bob's sidebar offers Family in its switcher

#### Scenario: Unknown email
- **WHEN** a member is added by an email with no account on this server
- **THEN** the response is 404 `user_not_found` and does not reveal any account's existence

#### Scenario: Member of the default workspace
- **WHEN** a user tries to add someone to their default workspace
- **THEN** the response is 409 `default_workspace` and nothing changes

#### Scenario: Member cannot manage
- **WHEN** an account with the role `member` adds, removes or changes the role of a member, or creates a group
- **THEN** the response is 403 `forbidden`

#### Scenario: Remove a member who holds grants
- **WHEN** an admin removes Carol from "Family", where Carol was a direct editor of "Trip" and a member of the group "Adults" that is on "House"
- **THEN** Carol is no longer a member of Trip or House, her devices purge both projects on their next sync, her queued operations for them are refused, and the other members' data is unchanged

#### Scenario: Owner leaves
- **WHEN** the owner of a workspace tries to leave it
- **THEN** the response is 409 `owner_must_transfer`

#### Scenario: Transfer
- **WHEN** the owner transfers "Family" to Bob
- **THEN** Bob is the owner, the previous owner is an admin, both see the change after sync, and the ownership of the projects in the workspace is unchanged

#### Scenario: Delete a workspace
- **WHEN** the owner deletes "Family", which holds projects shared with two members
- **THEN** the response is 409 `workspace_not_empty` naming the count of projects and members until the projects are moved or deleted and the members removed, and deleting an empty workspace answers 204 and removes it from every device after sync

#### Scenario: Non-member
- **WHEN** an account that is not a member requests a workspace, its members or its groups
- **THEN** the response is 404 `not_found` that does not reveal the workspace's existence

#### Scenario: Deactivated or deleted account
- **WHEN** an account that is a member of three workspaces is deleted by the server owner
- **THEN** it is removed from every workspace and every grant, its default workspace and its personal data are deleted with it, and a workspace it owned is transferred to its oldest admin or, without one, deleted when empty and otherwise kept with the server owner as its owner

### Requirement: A created workspace is a closed directory
In a workspace the user created, a project in that workspace SHALL be shareable only with members and groups of that workspace: adding anyone else to the project, or accepting a project invite link to it from an account outside the workspace, SHALL be refused. The assignee picker, the mention completion and the "add member" picker in such a project SHALL offer only the workspace's members, by name, from the local cache. In the default workspace, projects SHALL keep today's rule: any account on the server can be added by its exact email. A member of a shared project who is not a member of the project's workspace SHALL see the project in their default workspace, so a project shared before this change, or moved later, stays reachable for everyone on it.

#### Scenario: Share with an outsider
- **WHEN** the owner of "Website" in "Work" adds `dan@example.com`, an account that is not a member of Work
- **THEN** the response is 409 `not_in_workspace` and Dan is not added

#### Scenario: Picker lists the directory
- **WHEN** an admin opens the share dialog of a project in "Work", which has eight members
- **THEN** the people picker lists those eight by name and avatar, filterable by typing, without an email field, and works offline from the cache

#### Scenario: Default workspace keeps today's rule
- **WHEN** a user adds `bob@example.com` to a project in their default workspace
- **THEN** Bob is added exactly as before this change, and Bob sees the project in his own default workspace

#### Scenario: Invite link from outside
- **WHEN** an account that is not a member of "Work" accepts a project invite link to a project in Work
- **THEN** the response is 409 `not_in_workspace`, nobody is added, and the invite screen says "Ask the workspace owner to add you first"

#### Scenario: Legacy share after a move
- **WHEN** Alice moves "Trip", shared with Bob, from her default workspace into "Family", of which Bob is not a member
- **THEN** Bob keeps seeing Trip in his default workspace with every task, and Alice sees it in Family

### Requirement: Groups
A workspace's owner and admins SHALL create, rename and delete groups and change their members, each group having a name of 1 to 60 characters unique in the workspace ignoring case, and members who are members of the workspace. Groups and their members SHALL be visible to every member of the workspace and cached on devices. A project in the workspace SHALL be shareable with a group through one grant with one role (`viewer`, `editor` or `admin`), and the share dialog SHALL list the workspace's groups beside its people. A person's effective role on a project SHALL be the highest of their direct grant and the grants of their groups. Changing a group's members or deleting a group SHALL change the effective membership of every project the group is on, with exactly the effects adding or removing a member has today, and SHALL write no operation.

#### Scenario: Share with a group
- **WHEN** the owner of "House" shares it with the group "Adults" (Alice, Bob, Carol) as `editor`
- **THEN** all three are editors of House, each sees it after their next sync with "via Adults" in the member list, and the project's history is replayed to the devices of those who were not members before

#### Scenario: Join a group
- **WHEN** an admin adds Dan to "Adults"
- **THEN** Dan becomes an editor of every project Adults is on, his devices receive them on their next sync, and no operation is written

#### Scenario: Leave a group with a direct grant
- **WHEN** Carol, a direct `viewer` of House and an `editor` through Adults, is removed from Adults
- **THEN** Carol is a viewer of House, her devices show it read-only after their next sync, and an edit she queued offline is refused with reason `forbidden`

#### Scenario: Highest role wins
- **WHEN** Bob is a direct `admin` of House and Adults is on House as `viewer`
- **THEN** Bob's effective role is `admin`, shown with both sources in the member list

#### Scenario: Delete a group
- **WHEN** the owner deletes "Adults", which is on House and Trip
- **THEN** members who had no other grant on those projects are removed from them and their devices purge the projects on their next sync, members with a direct grant keep that role, and the owner is never affected

#### Scenario: Duplicate group name
- **WHEN** an admin creates "adults" while "Adults" exists in the workspace
- **THEN** the response is 409 `group_exists`

#### Scenario: Member outside the workspace
- **WHEN** an admin adds to a group an account that is not a member of the workspace
- **THEN** the response is 409 `not_in_workspace` and the group is unchanged

#### Scenario: Group member list offline
- **WHEN** a member opens the share dialog of a project without a network
- **THEN** the groups and their members are listed from the cache and the grant controls are disabled with an explanation

### Requirement: Workspace invite links
The owner and admins of a created workspace SHALL create single-use links through `POST /api/v1/workspaces/{id}/invites` with role `member` or `admin` (`admin` only for the owner), an optional email and an expiry of 1 to 720 hours (default 168), optionally sent by email when outgoing email is configured; list them through `GET` and revoke through `DELETE .../invites/{inviteId}`. `GET /api/v1/workspace-invites/{token}` SHALL need no authentication and return the inviter's name, the workspace name, the role, the bound email, the expiry and whether an account may be created, with the same 404 for every invalid case. `POST .../accept` SHALL add the signed-in account; an account may be created through the link only when its creator is the server owner or an admin, when open sign-up is on, or when the owner's "Members can invite new people with project links" setting is on. Secrets SHALL be stored only as hashes, never logged or audited, and creation SHALL be limited to 20 per creator per hour with preview and acceptance rate limited per address like project invite links.

#### Scenario: Create and accept
- **WHEN** the owner creates a `member` link for "Family" and Bob, signed in, accepts it
- **THEN** Bob is a member of Family, the link is spent, and both their devices are woken to sync

#### Scenario: Already a member
- **WHEN** a member of the workspace accepts a link to it
- **THEN** the response is 409 `already_member` and the link stays pending

#### Scenario: Account created through the link
- **WHEN** an anonymous visitor opens a link created by the server owner on a server with closed sign-up
- **THEN** the acceptance screen offers registration, and the new account is a member of the workspace and has its own default workspace

#### Scenario: Member cannot create links
- **WHEN** an account with the role `member` in the workspace posts to the invites route
- **THEN** the response is 403 `forbidden`

#### Scenario: Limited token
- **WHEN** a `read` or `agent` token posts to the invites route
- **THEN** the response is 403 `insufficient_scope`

#### Scenario: Rate limit
- **WHEN** one account creates a 21st workspace link within an hour
- **THEN** the response is 429 `rate_limited`

### Requirement: Moving projects and tasks between workspaces
The owner of a project SHALL move it to another of their workspaces from the project's menu ("Move to workspace…"), which SHALL write one `workspace_id` operation on the project; its sections, fields and tasks follow without any operation, and labels on its tasks are re-matched by name to labels of the target workspace (a label with that name is reused, otherwise created there) as one batch with Undo. For a shared project only the owner may write `workspace_id`; the server SHALL refuse it from admins and editors. A task without a project SHALL be moved by choosing another workspace's "No project" or project in its project picker, which lists every workspace's projects grouped by workspace with the current workspace first. Moves work offline and converge like any operation.

#### Scenario: Move a project
- **WHEN** the owner moves "Garden" with 12 tasks carrying "errand" from "Personal" to "Family", which has no "errand" label
- **THEN** Garden and its 12 tasks appear in Family, an "errand" label exists in Family and the 12 tasks carry it, Personal's "errand" is unchanged, and Undo puts everything back

#### Scenario: Admin cannot move a shared project
- **WHEN** an admin of a shared project submits a `workspace_id` operation for it
- **THEN** the operation is refused with reason `forbidden` and the project stays where it was for everyone

#### Scenario: Move an Inbox task
- **WHEN** the user opens the project picker on a task in Personal's Inbox and picks "No project" under "Work"
- **THEN** the task's `workspace_id` becomes Work's id, it leaves Personal's Inbox and appears in Work's Inbox, offline too

#### Scenario: Move offline
- **WHEN** the device is offline and the user moves a project to another workspace
- **THEN** the sidebar reflects the move at once and the operations are uploaded when the network returns

### Requirement: Workspace routes
The API SHALL expose `GET`/`POST /api/v1/workspaces`, `GET`/`PATCH`/`DELETE /api/v1/workspaces/{id}`, `POST .../leave`, `POST .../transfer`, `GET`/`POST .../members`, `PATCH`/`DELETE .../members/{userId}`, `GET`/`POST .../groups`, `PATCH`/`DELETE .../groups/{groupId}`, `PUT`/`DELETE .../groups/{groupId}/members/{userId}`, and the invite routes above. All SHALL require a session or a `full` or `admin` token, apply the role rules above, return the JSON error envelope on failure, and be refused with 403 `demo_restricted` on a demo instance before authentication (except the anonymous preview, which answers 404 there). Project group grants SHALL go through `POST /api/v1/projects/{id}/grants` and `PATCH`/`DELETE .../grants/{groupId}` with the project's member-management rules. Every membership, role, group and transfer change SHALL be recorded as an audit event carrying ids only.

#### Scenario: List workspaces
- **WHEN** a user who owns "Personal" and "Work" and is a member of "Family" lists workspaces
- **THEN** the response lists the three with the user's role on each, each with its members and groups, the default workspace marked `default: true`

#### Scenario: Read token
- **WHEN** a `read` token posts to any workspace write route
- **THEN** the response is 403 `insufficient_scope`

#### Scenario: Demo
- **WHEN** a demo account posts to `/api/v1/workspaces`
- **THEN** the response is 403 `demo_restricted`

#### Scenario: Audit without content
- **WHEN** an admin adds Bob to a group
- **THEN** an audit event `workspace.group_member_added` is recorded with the workspace, group and user ids and never the names

### Requirement: Limits
An account SHALL own at most 20 workspaces; a workspace SHALL have at most 200 members and 50 groups; a group at most 100 members. A request that would exceed a limit SHALL be refused with 409 `limit_reached` naming the limit. In host mode the operator SHALL be able to lower each limit per tenant, with host-wide defaults, under the existing per-tenant limits.

#### Scenario: Too many workspaces
- **WHEN** a user who owns 20 workspaces creates another
- **THEN** the response is 409 `limit_reached` naming the workspace limit

#### Scenario: Tenant limit
- **WHEN** a host operator sets a tenant's members-per-workspace limit to 10 and a workspace there has 10 members
- **THEN** adding an eleventh answers 409 `limit_reached`, and reads and sync keep working

### Requirement: Workspaces settings page
Settings → Workspaces SHALL list the user's workspaces with their role, open each one to rename it, choose its icon and colour, manage members (add by email, change role, remove), groups (create, rename, members, delete), invite links (create with a role and an expiry, copy once, send by email when configured, revoke), transfer and delete, with every action reachable by keyboard and with the actions disabled and explained while offline. From 768 px the list SHALL be a column beside the open workspace, the open one marked by more than a hover tint and announced as current; below 768 px choosing a workspace SHALL open it as its own view with a Back action to the list. The open workspace SHALL start with a header showing its mark, its name and its number of members, followed by tabs: General (name, colour, icon, and Transfer, Delete or Leave in a separated danger zone), Members, Groups and, for the owner and admins, Invites; the default workspace SHALL show General only. Groups SHALL list each group's name, its members' avatars and their count, and opening a group SHALL offer rename, a searchable member picker, each member with Remove, and Delete behind a confirmation that names the projects shared with the group. A member who is neither owner nor admin SHALL see the member and group lists read-only and a Leave action. The page SHALL use the standard settings patterns, with one Help action.

#### Scenario: Owner manages a workspace
- **WHEN** the owner opens Settings → Workspaces → Family
- **THEN** the page shows the name, icon and colour controls, the members with roles, the groups with their members, the pending invite links, and Transfer and Delete in a separated danger zone

#### Scenario: Member sees it read-only
- **WHEN** a `member` of Family opens it in Settings
- **THEN** the members and groups are listed without controls and a Leave action is offered

#### Scenario: Phone width
- **WHEN** the page is opened on a 360 px wide screen
- **THEN** no horizontal scrolling is needed, the member rows wrap their role control under the name, and every control is at least 44 × 44 px

#### Scenario: Offline
- **WHEN** the page is opened without a network
- **THEN** the cached lists are shown and the controls are disabled with a line saying workspaces need a connection

#### Scenario: Which workspace is open
- **WHEN** the owner of Family and Work opens Family at 1280 px
- **THEN** Family's row in the list carries the current marker and is announced as current, Work's row only tints on hover, and the detail's header reads "Family" with its mark and "3 members"

#### Scenario: Drill down on a phone
- **WHEN** a member opens Settings → Workspaces at 360 px and chooses Family
- **THEN** the list is replaced by Family's detail with a Back action, and Back returns to the list with Family focused

#### Scenario: Edit a group
- **WHEN** an admin opens the group "Adults" in Family, renames it to "Grown-ups" and adds Dan through the member picker
- **THEN** the group is renamed, Dan is listed among its members with Remove, and the list row shows the new name and one more avatar

#### Scenario: Deleting a group asks first
- **WHEN** the owner chooses Delete on "Adults", which is shared on House and Trip
- **THEN** a confirmation names House and Trip as losing access through the group, and the group is deleted only after it is confirmed

#### Scenario: Invite an admin for a day
- **WHEN** the owner creates an invite link with the role Admin and the expiry 1 day
- **THEN** the link is created with role `admin` and an expiry 24 hours ahead, and the pending list shows it as an admin link with its expiry date

#### Scenario: An admin invites members only
- **WHEN** an admin opens the Invites tab
- **THEN** the role choice offers Member only

### Requirement: Sync delivers workspaces in a fixed number of queries
Every sync response SHALL carry the caller's workspaces (id, name, icon, colour, default flag, role, owner), the members of each (id, name, role) and the groups of each (id, name, member ids), read with a fixed number of queries however many workspaces, members and groups the caller has, in a stable order (workspaces by id, members owner first then by role and name, groups by name). Devices SHALL replace their cached lists with the response's on every exchange. The wake-up channel SHALL carry no workspace content; a membership or group change SHALL wake the devices of every affected account to sync.

#### Scenario: Three queries
- **WHEN** a user who belongs to 15 workspaces with 300 members and 40 groups in all syncs
- **THEN** the workspaces, members and groups are read with three queries, not one per workspace

#### Scenario: Woken on a change
- **WHEN** Bob is added to "Family" from Alice's device
- **THEN** Bob's open devices are woken, sync, and show Family in their switcher without a reload

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
