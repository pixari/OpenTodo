---
title: Command-line client
summary: The ot command: install, sign in, add and complete tasks, JSON output, exit codes, dry runs and safe use by AI agents.
audience: developer
section: Integrations
specs: [cli-client]
screens: []
order: 20
---
# Command-line client (`ot`)

`ot` is a small, statically linked client for the OpenTodo REST API. It is built for two audiences: people who live in a terminal (`ot add "Call the plumber" --due tomorrow`, `ot today`) and scripts, cron jobs and editor integrations that want stable JSON output and exit codes instead of hand-written `curl`.

It is an **online** client: it keeps no local copy of your tasks and makes no change when the server cannot be reached. The one exception is [`ot vault`](vault.md), which keeps a folder of Markdown files and its own sync state. Every write goes through the REST API, which records it in the operation log, so changes made with `ot` reach your phone and browser on their next sync and converge under the same per-field last-writer-wins rule as any other edit.

`ot rules list` lists your [automation rules](automations.md); `ot rules enable <id>` and `ot rules disable <id>` turn one on or off (an id prefix or the exact name works; `--dry-run` prints the request); `ot rules runs <id>` prints its run log. Rules are built in the app. A read token lists but cannot switch (exit 5).

## Install

Release assets are published for linux, macOS and Windows on amd64 and arm64 (`ot-<os>-<arch>`, with `SHA256SUMS`); download one, make it executable and put it on your `PATH`. Or build from source (Go 1.26+, no other dependency):

```bash
go install github.com/OpenTodoApp/opentodo/cmd/ot@latest   # into $(go env GOPATH)/bin; or @vX.Y.Z for a release
# or, from a checkout:
make cli                                              # -> bin/ot
```

`go install` works from a clean `GOPATH` with the module path as declared (`github.com/OpenTodoApp/opentodo`, the repository name in lower case); an older local Go downloads the required toolchain itself. There is no Homebrew tap or Scoop bucket yet: release assets and `go install` are the supported ways (package manager manifests may follow later).

The server container image does not include `ot`; it belongs on the machine you type on.

### Shell completion

`ot completion bash`, `ot completion zsh` and `ot completion fish` print a completion script. Install it once:

```bash
# bash (needs the bash-completion package, which most distributions and Homebrew ship)
mkdir -p ~/.local/share/bash-completion/completions
ot completion bash > ~/.local/share/bash-completion/completions/ot
# or, without bash-completion, in ~/.bashrc:
source <(ot completion bash)

# zsh: a directory on $fpath, before compinit runs in ~/.zshrc
mkdir -p ~/.zfunc
ot completion zsh > ~/.zfunc/_ot
#   in ~/.zshrc:  fpath=(~/.zfunc $fpath); autoload -U compinit; compinit

# fish
ot completion fish > ~/.config/fish/completions/ot.fish
```

Open a new shell afterwards. Tab then completes commands, subcommands, flags and fixed values (`--priority`, `--scope`), and reads names from the server of your profile: projects after `--project` and as `#Name` in an `ot add` title, labels after `--label` and as `@name`, workspaces after `--workspace`, and open task ids (with their titles in zsh and fish) after `ot done`, `edit`, `rm`, `time start` and `time log`; `ot reopen` offers completed ones. Profile names come from your config file, and `--out` or a vault folder complete as paths. A `--profile` or `--server` earlier on the line is respected.

The script is a thin wrapper: on each Tab it asks the `ot` on your `PATH` (`ot __complete`, a hidden command), which answers from the same command table as `ot help` and `ot schema`, so an upgraded `ot` completes its new flags without a new script. Names are read with one request that may take at most 2 seconds; when the server cannot be reached, you are signed out or the account is end-to-end encrypted, you get commands and flags but no names, and nothing is printed into your prompt. Nothing is cached on disk. Names with spaces or quotes are inserted quoted. In bash, values complete after `--flag value`, not `--flag=value`.

## Sign in

```bash
ot login https://todo.example.com
Email: you@example.com
Password:
Signed in to https://todo.example.com as you@example.com (profile "default").
Token "cli@laptop" stored in /home/you/.config/opentodo/config.json.
```

`ot login` signs in with your email and password, creates an API token named `cli@<hostname>`, signs the session out again and stores only the token. The password is never echoed and never stored. You will see the token in **Settings → Integrations → API tokens** in the web app, where it can also be revoked.

Other ways to get credentials in:

| Command | Purpose |
| --- | --- |
| `ot auth set-token <token> --server <url>` | Store a token you created in Settings or with `ot token create` |
| `ot auth status` | Show the server, the account, the token name and its scope (for an `agent` token also whether assistant writes are allowed right now) |
| `ot auth logout --yes` | Revoke the stored token on the server and remove it locally (asks on a terminal without `--yes`). A `read` or `agent` token cannot revoke itself: it is removed locally and you revoke it in Settings |

### Configuration file and profiles

The config file lives in the platform's user configuration directory (`$XDG_CONFIG_HOME/opentodo/config.json` or `~/.config/opentodo/config.json` on Linux, `~/Library/Application Support/opentodo/config.json` on macOS, `%AppData%\opentodo\config.json` on Windows). It is written with owner-only permissions (`0600`, directory `0700`).

```json
{
  "default": "home",
  "profiles": {
    "home": { "url": "https://todo.example.com", "token": "ot_…" },
    "work": { "url": "https://tasks.corp.example", "token": "ot_…" }
  }
}
```

Pick a profile with `--profile work` or `OPENTODO_PROFILE=work`; `ot login --profile work <url>` creates one. Precedence, highest first:

1. Flags: `--server <url>`
2. Environment: `OPENTODO_URL`, `OPENTODO_TOKEN` (handy for cron and CI; no config file needed)
3. The selected profile

`OPENTODO_CONFIG=/path/to/config.json` points at another config file. No command ever prints a stored token.

### Workspaces

Every command acts on one [workspace](workspaces.md): the account's default workspace, unless `--workspace <name or id>`, `OPENTODO_WORKSPACE` or the profile's `"workspace"` (written by `ot login --workspace Work`) names another. `ot list`, `ot inbox` and the other views show that workspace's tasks, and `ot add` without `--project` puts the task in its Inbox. `ot workspaces` lists them (`--json` for the full shape). An unknown name exits with code 2 and lists the workspaces you have.

## Tasks

```bash
ot today                       # due today or earlier, overdue first
ot today --all                 # with a Today limit: every task, no "Waiting for a slot" section
ot inbox                       # the Inbox: no project and no date
ot upcoming                    # due after today
ot list                        # every open task, soonest first
ot list --project Home         # one project (name or id)
ot list --completed            # most recently completed first
ot list --all --limit 20       # open and completed
ot list --completed-after 2026-10-05 --completed-before 2026-10-12   # completed that week
ot list --someday              # parked in Someday
ot list --anytime              # no due date, deadline or start
ot list --blocked --project Home   # waiting for an open task
ot list --available                # what can be done now: not blocked, not waiting for an earlier step
```

Human output is a compact table: an id prefix, priority, due date and time (overdue dates are marked and shown in red on a terminal), project and title, plus an `ORIGIN` column (the issue id or the page's host) when a listed task has an [origin](capture.md#where-a-task-came-from) and a `BY` column with the deadline when one has a deadline (a passed deadline is marked overdue), and an `ENERGY` column when a listed task has an energy; `--json` always carries `energy` (null for none). The due cell adds `(someday)`, `starts <date>` (for a multi-day task its days instead: `3–5 Nov`, `30 Oct – 2 Nov`, or with the years when they differ), `evening` (or `morning`, `afternoon`) and `waiting` when they apply. Dates are evaluated in your local time zone. A task fixed to a time zone (see [sync.md](sync.md#zoned-due-values)) is shown converted to your zone with the original as a hint, e.g. `2026-10-11 00:00 (09:00 Berlin)`; `ot edit --due/--time` on it takes the date and time as shown and keeps the zone, and `--time ""` releases it to a floating date. Tasks of archived projects stay out of the cross-project views, as in the web app.

Custom-field sorting is available in the web app and saved views; `ot list` has no sort flag for it (see [Group and order](group-and-order.md)).

```
ID        P   DUE                 PROJECT  TITLE
8c2a91f0  P2  2026-10-08 overdue  Home     Pay rent
3f1d7a22  P1  2026-10-10 09:00             Call the plumber
```

With a [Today limit](today-limit.md) on, `ot today` prints the tasks in the slots, then a **Waiting for a slot** heading and the waiting tasks in fill order (the first comes in next), with the app's rule: today's focus, the tasks you let in, Earlier oldest first, then the rest by when they were created. `--all` prints every task in one table, and `--json` adds `waiting_for_slot` to each task while the limit is on.

### Add and edit

```bash
ot add "Call the plumber" --project Home --due tomorrow --time 09:00 --priority 2
ot add "Read the sync design" --label reading --label work --note "docs/sync.md"
ot edit 8c2a --priority 1 --due friday
ot edit 8c2a --due none --project none --note ""     # clear values
ot add "Backup check" --due monday --time 09:00 --repeat "every week" --remind "30 min before"
ot edit 8c2a --repeat none                           # stop repeating, keep the date
ot add --natural "Water plants every Monday remind me at 8 #home"
ot add "Fix the login timeout" --origin-url https://github.com/o/r/issues/7
ot edit 8c2a --origin-url none                       # forget where it came from
ot add "Quarterly report" --start monday --deadline 2026-11-06
ot edit 8c2a --start someday                         # park it, keep the due date
ot add "Install shelves" --blocked-by 91f0 --location Home
ot edit 8c2a --evening=false --blocked-by none --location none
ot edit 8c2a --start 2026-11-03 --due 2026-11-05 --span   # a trip from 3 to 5 November
ot add --done "Fixed the printer"                    # log a win: created already completed
```

| Flag | Meaning |
| --- | --- |
| `--project <name-or-id>` | Project; `none` (edit) takes the task out of its project (into the Inbox while it has no date) |
| `--due <when>` | `YYYY-MM-DD`, `today`, `tomorrow` or an English weekday name (next occurrence; `monday` on a Monday means next week); `none` (edit) clears the date |
| `--time HH:MM` | Due time, 24-hour; with `ot add` and no `--due` the date is today |
| `--priority 1..4` | 1 is highest, 4 is the default |
| `--label <l>` | Repeatable; a label name (case-insensitive) or id. Unknown names create the label. With `ot edit` the given labels replace the list |
| `--note <text>` | Description; `--note ""` clears it |
| `--title <text>` | New title (`ot edit` only) |
| `--repeat <rule>` | Recurrence rule in any spelling of the [rule grammar](recurrence.md) (`"Every Week"`, `"every mon, wed"`), checked locally and sent in canonical form; `none` (edit) clears the rule and keeps the date |
| `--origin-url <url>` | Where the task comes from: an `http` or `https` URL, sent as the task's [origin](capture.md#where-a-task-came-from). A GitHub, GitLab, Jira or Linear issue link becomes `{kind: "issue", provider, id}` (`o/r#7`, `ENG-123`), derived on your machine with the same table as the web app; any other link is a `url` origin. `ot` never requests the URL. Another scheme (`ftp:`, `file:`) exits 2 before any request; `none` (edit) clears the origin |
| `--deadline <when>` | The day the task must be finished by, separate from the due date; same words as `--due`; `none` (edit) clears it |
| `--start <when>` | `someday` parks the task; a date (same words as `--due`) defers it until that day; `none` (edit) clears it. The due date is kept |
| `--evening` | Put the task in This Evening; `--evening=false` takes it out |
| `--span`, `--no-span` | Draw the task across the days from its start date to its due date, both included (a trip, a conference); a span needs `--start` and `--due` with the start before the due date, otherwise it shows on its due date as before. `--no-span` takes it back to one day and keeps the start date. Both together exit 2 before any request |
| `--part <part>` | The [part of the day](day-parts.md): `morning`, `afternoon`, `evening` (This Evening) or `none`; written with the evening flag, so `--part afternoon` takes an evening task out of This Evening. Another word exits 2 before any request. It wins over `--evening` |
| `--energy <level>` | The task's energy: `deep`, `medium` or `low` (any case); `none` clears it. Another word exits 2 before any request |
| `--blocked-by <ref>` | Repeatable: a task this one waits for, by id or unique id prefix (an ambiguous prefix exits 1 listing the candidates, before any write). With `ot edit` the list is replaced; `none` clears it |
| `--location <where>` | A saved location's name (case-insensitive) or id, sent with its current name, address and coordinates; or `lat,lon`; `none` (edit) clears it. An unknown name exits 1 before any write |
| `--remind <phrase>` | `ot add` only, repeatable: a reminder without the reminder word, either an offset (`"30 min before"`, `"1 day before"`, `"2 hours after"`) or a moment (`"at 9"`, `"tomorrow at 9"`, `"20 Oct at 9"`). It is resolved like a quick-add reminder: relative to the task's due time (09:00 for a date-only due), or absolute in your local time zone when the task has no due date. An offset on an undated task waits for a due date, and the command says so |
| `--natural` | `ot add` only: read the title like the app's [quick add](quick-add.md): dates and times, `#project`, `@label`, `p1`–`p4`, `+30m`, `30m/2h` (time spent and an estimate), `every …` rules and `remind me …` reminders, in six languages, and `~deep`, `~medium`, `~low` while your account has Energy levels on. Explicit flags win over what the line says; an unknown `#name` stays in the title |
| `--done` | `ot add` only: [log a win](today-limit.md#log-a-win), a task created already completed now by you in the one request, so it counts in Completed and your statistics like any completion. `--repeat` and `--remind` are usage errors with it (a win does not repeat or remind), and with `--natural` a rule or reminder phrase in the title is left out |
| `--lang <codes>` | Languages for `--natural` and `--remind`, e.g. `de,en`. Default: the language of `LC_ALL`, `LC_MESSAGES` or `LANG`; English is always active |
| `--no-default-reminder` | `ot add` and `ot edit`: add no [default reminder](default-reminders.md). Without it, a command that sets a due date asks the server for your default reminder (`?default_reminder=true`); `--remind` (or a `remind me …` phrase with `--natural`) also leaves it out, since you chose your own. With an `agent` token the server always applies your defaults |
| `--idempotency-key <key>` | `ot add` only: a retry with the same key returns the same task, see [Retry-safe creates](#retry-safe-creates). Reminders send `<key>.r1`, `<key>.r2`, …, so a retry also converges to one set of reminders |

`ot add` prints the new task's id (the whole task with `--json`, `origin` included). Priority, time, date, rule, origin URL and reminder phrases are validated locally before any request is sent. Reminders are created after the task with one `POST /api/v1/reminders` each (a dry run lists them, referring to the planned task as `(planned-1)`); if one fails, the command exits 1 and names the created task so you can add the reminder by hand. A `30m/2h` token in a `--natural` line also logs the time already spent: one `POST /api/v1/time-entries` after the task, ending now (`<key>.t` with an idempotency key).

`--natural` uses the same grammar as the web app, pinned by shared test cases, with two differences because `ot` cannot read your preferences: weeks start on Monday (`next week`), and numeric dates such as `3/11` follow the first language (day first in German, month first in English) rather than your date-format setting.

### Complete, reopen, delete

```bash
ot done 8c2a 3f1d          # one or more references
ot reopen 8c2a
ot rm 8c2a                 # asks on a terminal
ot rm 8c2a --yes           # required off a terminal and with --json
```

A `<ref>` is a full task id or an id prefix that matches exactly one non-deleted task. An ambiguous prefix changes nothing, exits with code 2 and lists the candidates; with several references all are resolved before anything is changed. Scripts should use full ids from `--json`. `ot rm` is a soft delete: the task becomes a tombstone that still appears in the export.

A task that is already in the requested state (`ot done` on a completed task, `ot reopen` on an open one) is reported as `unchanged`, keeps its completion time and nothing is sent; the command still exits 0. `ot edit` with values equal to the current ones sends nothing either.

### Repeating tasks ahead

```bash
ot task occurrences 8c2a                                # today and the 30 days after
ot task occurrences 8c2a --from 2026-10-12 --to 2026-10-18 --json
ot task occurrence 8c2a 2026-10-19 skip                 # skip one occurrence
ot task occurrence 8c2a 2026-10-14 edit --time 19:00   # move one occurrence alone
ot task occurrence 8c2a 2026-10-15 complete            # complete one early
ot task split 8c2a --from 2026-10-14 --time 19:00       # 19:00 from Wednesday on
```

`ot task occurrences <ref>` lists a repeating task's current occurrence and the [projected](recurrence.md#projected-occurrences) ones after it in a range, as a table of DATE, TIME and STATE (`current`, `projected`, or `open`, `done` and `skipped` for an occurrence that has a record). `--from` and `--to` take `YYYY-MM-DD`, `today`, `yesterday` or a weekday; the range is at most 366 days and lists at most 31 projected dates. The dates are the ones the app draws on the calendar ([`GET /api/v1/tasks/{id}/occurrences`](api.md#a-series-dates-ahead)); it only reads, so a `read` token will do. A task without a rule exits 1 with `not_recurring`.

`ot task occurrence <ref> <date> complete|skip|edit` acts on one occurrence alone ([one occurrence alone](recurrence.md#one-occurrence-alone)): `complete` and `skip` that date, `edit` moves it (`--due <day>`, `--time HH:MM` or `none`) or renames it (`--title`); a new day without `--time` keeps the series' time. `<date>` takes `YYYY-MM-DD`, `today`, `tomorrow` or a weekday. It prints the occurrence's record (`--json`: the task). A date that is not an occurrence exits 1 with `not_an_occurrence`. It writes through [`POST /api/v1/tasks/{id}/occurrences/{date}/complete`](api.md#one-occurrence-alone) and its siblings, so it needs a `full` token.

`ot task split <ref> --from <date>` changes a repeating task from one of its later occurrences on ([This and following](recurrence.md#this-and-following)): `--time HH:MM` (or `none`), `--rule <rule>` and `--title <text>` give the change, at least one of them. The task ends the day before `--from`, and the new task that continues it is printed (`--json`: the task). The current occurrence, or a date that is not an occurrence, exits 1 with `not_an_occurrence`. It writes through [`POST /api/v1/tasks/{id}/split`](api.md#this-and-following), so it needs a `full` token.

## Projects

```bash
ot project list [--all]                 # --all includes archived projects
ot project add "Garden" [--color "#22c55e"] [--idempotency-key <key>]
ot project rename Garden "Back garden"
ot project move Garden --workspace Family  # only the project's owner
ot project archive Garden [--undo]
ot project rm Garden [--yes]
```

Projects are referenced by name (case-insensitive), full id or unique id prefix. `ot project list` shows every workspace's projects with a WORKSPACE column and each project's FLOW (`parallel`, `sequential` or `area`, see [Sequential projects and areas](project-flows.md)), and STATUS `archived` or `maintenance` ([Review intervals and maintenance](review-intervals.md)); `--workspace` narrows it to one.

## Notes

[Notes](notes.md) from the shell: standalone notes, the notes of tasks and the notes of projects, read and written as Markdown.

```bash
ot notes                                   # every note, newest change first (same as ot notes list)
ot notes list --source task --project Home # note, task, project or all; --standalone is --source note
ot notes list --label work --limit 20
ot notes search plumber                    # every word in the title or text, title matches first
ot notes show 3fa1                         # the text, then text appended that no device merged yet
ot notes add "Wi-Fi" --project Home --label home --body "- network: home" [--idempotency-key wifi-1]
ot notes add "Meeting" --body-file agenda.md       # or --body-file - for standard input
ot notes edit 3fa1 --title "Wi-Fi at home" --project none --label none
ot notes edit 3fa1 --body-file notes.md            # replaces the text, see below
ot notes append Meeting "- decided: ship Friday"   # adds at the end, replaces nothing
ot notes rm 3fa1 [--yes]                   # to the Trash
ot notes to-task "Call the plumber"        # a task with the note's title, text, project and labels; prints its id
ot task note 8c2a                          # a task's note as Markdown
ot task note 8c2a --set "New plan" | --file plan.md | --file - | --append "- called, no answer" | --clear
```

A note `<ref>` is a full id, a unique id prefix, a title (ignoring case) or a unique title prefix; an ambiguous one changes nothing and exits 2 with the candidates. `ot notes show` accepts the id of a task or project note from the list too; `edit`, `append`, `rm` and `to-task` act on standalone notes, and `ot task note` on a task's note (a task id, unique id prefix or title). The list prints KIND (`note`, `task`, `project`; `task (done)` and `project (archived)` are marked), id prefix, title (`Untitled note` when a note has none), project and when its text last changed; `ot notes search` adds a MATCH column with the text around the first match. Search runs on your machine over the notes the server returned, with the matching of the app: every word must occur in the title or the text, case and accents ignored, a quoted phrase as one; title matches first.

Text is Markdown. What a note shows is its text followed by anything appended that no device has merged into it yet; the next device that opens the note turns the Markdown into formatted content. **A replacement** (`edit --body`, `edit --body-file`, `task note --set`, `--file` and `--clear`) carries the version `ot` read: when someone changed the note in the app after that (or another write came first), the server refuses it with `body_changed`, exit 1, and nothing changes. Read it again and retry. **An append** (`ot notes append`, `ot task note --append`) never replaces anything, so it is safe while someone edits the same note on a phone: every device adds the text at the end once. A note holds at most 100 appends no device has merged yet (`too_many_appends`). `ot task note` takes one of `--set`, `--file`, `--append` and `--clear` per call; two exit 2 before anything is sent.

Every write supports `--dry-run` and is refused by `--read-only`; `rm` needs `--yes` off a terminal and with `--json`, like `ot rm`. Note writes go through the REST routes and need a `full` token: a `read` token reads only, and an `agent` token writes notes through [MCP](mcp.md) instead (`ot task note --set` on a task it may edit is allowed). The CLI is online: a write reaches the server, then every device on its next sync.

On an [end-to-end encrypted](e2ee.md) account `ot notes` and `ot task note` decrypt on your machine after `ot encryption unlock`, and seal every title, text and append for its note or task before sending, as `ot vault` does (a new note is created first and its sealed title and text written right after, since a sealed value names its note's id; `to-task` seals the title, text and document for the task id it chose). Without the key the list shows `(encrypted)`, `show` says the note is encrypted, and text writes stop with `encryption_enabled`, exit 5, before anything is sent; `rm` and project or label changes still work. Labels named with `--label` must exist on an encrypted account (`ot` would otherwise send the new name readable). `to-task` refuses a note with appends no device has merged yet: open it in the app once, then run it again.

## Time

[Time tracking](time-tracking.md) from the shell: start and stop a running entry, log past work, list and export entries.

```bash
ot time start 8c2a [--note "review"]     # stops the running entry first
ot time stop                             # exit 1 when nothing runs
ot time log 8c2a 1h30 --on yesterday --note "review"
ot time log 8c2a --from 09:00 --to 09:25 [--on 2026-10-12]
ot time list --from 2026-10-12 --to 2026-10-18 [--task 8c2a] [--running] [--limit 50]
ot time export --from 2026-10-12 --to 2026-10-18 -o week.csv
```

A duration is `45m`, `1h30`, `1.5h` or `90` (minutes); anything else exits 2 before a request. Without `--on` a duration ends now; on another day (`--on yesterday`, a weekday meaning the last one, or `YYYY-MM-DD`) it ends at 17:00 local time. `--from` and `--to` are times on that day. `start`, `stop` and `log` write, so `--dry-run`, `--read-only` and token scope apply: a `read` token exits 5 (`insufficient_scope`) before anything is sent, while `list` and `export` work with it. `ot time list` prints the id prefix, day, `09:00–09:25`, duration, task and project, newest first; `--json` prints the [`time_entry`](#machine-readable-help-ot-schema) objects (`endedAt: null` while running). `ot time export` downloads the server's CSV for those local days in your time zone; with `-o` and `--json` it reports the file and the row count. A weekly export for cron:

```bash
0 18 * * 5  ot time export --from monday --to today -o "$HOME/time/week-$(date +\%F).csv"
```

## Calendar frames

Your [frames](frames.md), the recurring background windows of the Day and Week calendar:

```bash
ot frames                                                     # id, title, days, time, planning source
ot frames add "Deep work" --days mon-fri --from 09:00 --to 11:00 [--color "#3b82f6"] [--source label:<id>]
ot frames rm 7f3a [--yes]                                     # an id, id prefix or the exact title
```

`--days` takes `mon-fri`, `mon,wed,fri`, `weekdays`, `weekend`, `daily` or ISO digits (`1` Monday to `7` Sunday); without it a frame repeats on weekdays, from 09:00 to 10:00. The end must be after the start on the same day; the server refuses anything else with `invalid_input` (exit 1). `--source` is the list the app opens with Plan from this frame: `project:<id>`, `label:<id>` or `view:<id>`. `add` and `rm` write, so `--dry-run`, `--read-only` and token scope apply (a `read` or `agent` token exits 5). `--json` prints the [`frame`](#machine-readable-help-ot-schema) objects; an encrypted account's titles are ciphertext and the table shows `(encrypted)`.

## Calendar slots

Your [slots](slots.md), blocks of the Day and Week calendar that hold a checklist of small tasks:

```bash
ot slots [--from monday --to friday]                          # id, title, date, time, number of tasks
ot slots add "Admin" --date 2026-11-04 --at 16:00 --for 45m [--color "#14b8a6"]
ot slots put 7f3a 9c1e 4b20                                    # a slot (id, id prefix or title), then tasks
ot slots rm 7f3a [--yes]                                      # its tasks stay on that day without a time
```

`--date` takes `YYYY-MM-DD`, `today`, `tomorrow` or a weekday name (default today); `--for` a length from 15 minutes to 8 hours in 15-minute steps (default `30m`). `put` adds the tasks at the end of the slot and, in the same batch, sets each one's date to the slot's day without a time and takes it out of your other slots of that day; a slot holds at most 20 tasks, and a task you may not edit (a viewer of its project) is refused with `forbidden` and nothing changes. `add`, `put` and `rm` write, so `--dry-run`, `--read-only` and token scope apply (a `read` or `agent` token exits 5). `--json` prints the [`slot`](#machine-readable-help-ot-schema) objects; an encrypted account's titles are ciphertext and the table shows `(encrypted)`.

## Issue connections

Your [issue import](issue-import.md) connections, once the server owner has turned the feature on:

```bash
ot issues list               # id, name, provider, host, state, last poll, tasks; never a token
ot issues list --json        # the connections as the API returns them, with token_set
ot issues sync 7f3a          # poll one connection now: created 3, completed 1, reopened 0, renamed 2
ot issues sync               # every enabled connection
ot issues sync 7f3a --dry-run   # print the request, run nothing
```

`ot issues sync` writes, so `--read-only` and a `read` or `agent` token refuse it before any poll (exit 5). It exits 5 with `issues_disabled` while the owner has not enabled issue connections, and 1 when a connection is stopped (`connection_stopped`), the provider's rate limit applies (`provider_rate_limited`), the hourly limit of 12 checks and syncs is reached (`rate_limited`) or the poll fails (`poll_failed`). Connections are added and changed in Settings → Integrations → Issues.

## Tokens and export

`--scope` is `full` (the default), `read` or `agent`; anything else exits with code 2 before a request is sent. Creating a token is a [credential route](api.md#token-scopes): `ot token create` needs an `admin` token in the profile (the token `ot login` stores is `full`, so run `ot login` again to mint a new one, or create it in Settings → Integrations → API tokens). An `admin` token can only be created in the web app, from a recently confirmed session; with it, scripts can also manage second factors, other tokens, app passwords, accounts and server secrets. A `full` token gets exit 5 (`insufficient_scope`) on those routes. An `agent` token is for an [AI assistant](mcp.md#letting-an-assistant-make-changes): it reads everything and can create and edit tasks, projects, labels and comments (through the MCP write tools or `ot`, see [Using ot from an agent](#using-ot-from-an-agent)), and only while both assistant switches are on (the owner's and yours, in Settings → Integrations → AI assistants).

```bash
ot token list                           # with each token's scope
ot token create backup-script           # prints the secret once, with a notice on stderr
ot token create reporting --scope read  # read-only: refused on every change
ot token create desk-assistant --scope agent   # for an AI assistant that may make changes
ot token revoke backup-script --yes     # by name, id or id prefix
ot export                               # full JSON export (including tombstones) to stdout
ot export --out opentodo-$(date +%F).json
```

## Import

`ot import <file>` sends a file to the server's importer, the same one as **Settings → Data → Import data**: an OpenTodo export, a CSV file or another app's export (the [formats](import.md#formats)). It starts the job, waits until it has finished and prints what was created, skipped and failed; `--json` prints the job ([schema](#machine-readable-help-ot-schema) `import_job`). With `--dry-run` it only asks for the preview, which writes nothing, and prints its totals and notes (in `--json`, under `preview` in the dry-run document).

`--workspace` (or `OPENTODO_WORKSPACE`, or the profile's workspace) chooses the [workspace](import.md#workspace) the import goes into. Without one, the server's default applies: the default workspace, or an OpenTodo export's own workspaces.

```bash
ot import todoist-backup.zip --workspace Work --dry-run   # what would happen
ot import todoist-backup.zip --workspace Work             # import, wait, print the counts
ot import tasks.csv --duplicates import --time-zone Europe/Rome
ot import opentodo-export.json --existing overwrite       # restore, keeping the export's workspaces
```

`--format` forces a format id instead of detection, `--existing skip|overwrite` applies to an OpenTodo export, `--duplicates skip|import` to possible duplicates, and `--time-zone` (default: this machine's zone) to date-times written with a zone. Imports need a `full` or `admin` token: `read` and `agent` tokens and read-only mode exit 5 before the file is sent. A failed job exits 1 with `import_failed`; undo an import in the app under **Past imports**.

## MCP bridge and encryption

`ot mcp` bridges an MCP client that only speaks stdio (Claude Desktop, Claude Code) to the server's [MCP endpoint](mcp.md); see [MCP](mcp.md#3-connect-an-assistant) for the client configuration. It starts with a `read` token, or an `agent` token for an assistant that may make changes through the server's write switches; a `full` token needs `--allow-full-token`, and `--read-only` accepts only a `read` token.

For an account with [end-to-end encryption](e2ee.md), `ot mcp --decrypt` lets that assistant read and write your text: it decrypts results and encrypts what the assistant writes on your computer, with the account key stored by `ot encryption unlock`. The server still receives only ciphertext; your AI provider receives the plaintext, and the bridge says so on stderr when it starts.

```bash
ot encryption unlock                       # asks for the encryption passphrase, no echo
ot encryption unlock --recovery            # or the recovery key
ot encryption unlock --passphrase-file ~/.otpass
ot encryption status                       # locked, unlocked, stale or not_encrypted
ot encryption lock                         # delete the stored key
ot mcp --decrypt                           # the bridge, decrypting on this machine
```

`ot encryption unlock` fetches the wrapped key record with the profile's token, checks its key-derivation settings as devices do, unwraps the key locally and stores it with its key version in an owner-only file (`keys/<profile>.json` next to the configuration file, the same protection as the token). The passphrase, the recovery key and the key itself are never sent or printed. After 5 failed attempts within a minute it waits before trying again. A passphrase with accented or other non-ASCII characters may need `--recovery`, since `ot` does not normalise Unicode the way the browser does. Lock the key on a shared machine.

The note tools work through the bridge too: `create_note`, `update_note` and `append_to_note` have their text sealed here (an append for the field of the append id the bridge chooses), `list_notes`, `get_note` and the `opentodo://notes` resources come back decrypted, and the bridge answers `search_notes` itself: it reads the notes with `list_notes`, decrypts them and matches the query on your machine, so the server never receives it. `note_to_task` is refused with a pointer to `ot notes to-task`, which seals the note again for the new task.

`ot mcp --decrypt` refuses to start, without prompting, when no key is stored or the stored one is out of date (`stale`: the passphrase or key changed on another device); run `ot encryption unlock` again. Custom field text and task origins are not encrypted by the bridge: the server refuses them for an encrypted account.

## Markdown vault

`ot vault` keeps a folder of Markdown files, one per project, in two-way sync with the account; it is the one command group that keeps local state (the files and `<dir>/.opentodo/`). It is a sync device of its own and needs a `full` token; with `--read-only` it pulls and writes the files but sends nothing. See [Markdown vault](vault.md).

```bash
ot vault init ~/Notes/Tasks [--adopt]
ot vault sync [<dir>] [--dry-run] [--read-only] [--json]
ot vault status [<dir>] [--json]
ot vault watch [<dir>]
```

## Scripting: JSON output and exit codes

Every command accepts `--json`. Stdout then holds only JSON, with the same field names as the [REST API](api.md): an array for lists, the entity for single results, and the error envelope on failure. The shapes are documented as JSON Schemas with an **`output_version`** (currently `1`, reported by `ot version --json` and `ot schema`). Within a version fields are only added; a breaking change would need a new version you opt into.

| Command | `--json` output (schema) |
| --- | --- |
| `list`, `today`, `inbox`, `upcoming` | array of `task` |
| `add`, `edit` | `task` |
| `done`, `reopen`, `rm` | `task_result` (one reference) or an array of them: the task plus `ref` (what you typed) and `status` (`completed`, `reopened`, `deleted` or `unchanged`) |
| `project list` / `add`, `rename`, `archive`, `rm` | array of `project` / `project` |
| `token list` / `create` / `revoke` | array of `token` / `token_created` (`{token, secret}`) / `token` |
| `notes list`, `notes search` | array of `note`: `{kind, id, title, project_id, project, label_ids, updated_at, body_version, encrypted}`, `search` adds `snippet` (`[{text, mark}]`) |
| `notes show`, `add`, `edit`, `task note` | `note_text`: `{kind, id, title, text, appends, body_version, project_id, label_ids, encrypted}` |
| `notes append`, `task note --append` | `note_append`: `{entity, entity_id, append_id, body_version}` |
| `task occurrences` | `occurrences`: `{series_id, rule, capped, occurrences: [{date, time?, tz?, state, record_id?, due?}]}` |
| `task occurrence` | `task`: the occurrence's record |
| `notes rm` / `notes to-task` | `note_result` (the `note` plus `ref` and `status`) or an array of them / `task` |
| any write command with `--dry-run` | `dry_run` |
| any failure | `error`: `{"error":{"code":"…","message":"…","exit":N}}` |

On failure the envelope goes to stdout as before (server envelopes keep their `code` and `message`; `exit` is added) and stderr gets one line starting with `ot:`, so harnesses that only show stderr see what went wrong. Without `--json` errors go to stderr only.

```bash
ot list --json --today | jq -r '.[] | "\(.priority) \(.title)"'
ot add "Nightly backup check" --json | jq -r .id
```

Exit codes:

| Code | Meaning | What a script should do |
| --- | --- | --- |
| 0 | Success, including "already in that state" | continue |
| 1 | The server rejected the request or failed (its message is printed verbatim) | read `error.code`; retry only `internal` or `rate_limited` |
| 2 | Usage or local validation error (bad flag, invalid priority or date, ambiguous reference, missing configuration, a destructive command without `--yes`) | fix the command |
| 3 | Authentication or configuration error (wrong password, revoked token, unreadable config file) | sign in again |
| 4 | The server could not be reached within the timeout (15 s) | retry later |
| 5 | Not permitted: `insufficient_scope`, `forbidden`, `not_permitted`, `writes_disabled_by_owner`, `writes_disabled_by_user`, `encryption_enabled` or `read_only` | do not retry; change the token, the switch or the role |

### Machine-readable help: `ot schema`

`ot schema` (or `ot help --json`) prints every command with its arguments, flags and their types, whether it writes or is destructive, whether it supports `--dry-run` and `--idempotency-key`, its output schema, the exit codes, the error codes and every JSON Schema. It is generated from the same table as `ot help`, needs no configuration and no server, and exits 0 offline.

```bash
ot schema | jq '.commands[] | select(.writes) | .name'
ot schema | jq '.schemas.task'
```

### Non-interactive by default

Without a terminal on stdin and stdout, `ot` never prompts and colour is off (also with `NO_COLOR`). The destructive commands `ot rm`, `ot project rm`, `ot token revoke` and `ot auth logout` then need `--yes`, and so do they with `--json` even on a terminal; without it they exit 2 with code `confirmation_required` before sending any request. On a terminal without `--json` they ask. `ot login` reads the password from stdin when stdin is not a terminal.

### Dry run

Every command that writes accepts `--dry-run`. It resolves references and current values with reads (so an ambiguous prefix still exits 2), validates, and prints the requests it would send and the resolved targets, then exits as a real run would. Nothing that writes is sent, nothing changes on the server or on any device, and the config file is not touched. An unreachable server exits 4.

```bash
ot done 8c2a 91f0 --dry-run --json
# {"command":"done","dry_run":true,"requests":[{"method":"PATCH","path":"/api/v1/tasks/8c2a…","body":{"completed_at":1760…}},…],
#  "targets":[{"ref":"8c2a","id":"8c2a…","title_preview":"Pay rent","status":"completed"},…]}
```

A label that `ot add --label` would create appears as a planned `POST /api/v1/labels`, and the planned task refers to it as `(planned-1)`. `ot login --dry-run` shows the three requests of a sign-in without prompting for the password.

### Retry-safe creates

`ot add` and `ot project add` take `--idempotency-key <key>` (1 to 128 characters of letters, digits and `. _ : -`), sent as the [`Idempotency-Key`](api.md#idempotency-keys) header. Running the same command again with the same key prints the same entity and creates nothing; the same key with different content exits 1 with `idempotency_conflict`. Because the ids derive from the key, a retry after a timeout converges to one task on every device.

```bash
ot add "Buy milk" --idempotency-key run42-milk --json    # creates
ot add "Buy milk" --idempotency-key run42-milk --json    # same task, nothing new
```

### Read-only mode

`--read-only`, or the optional `OPENTODO_READ_ONLY=1`, makes every write command fail before any request with code `read_only` and exit 5; reads work as usual. With a `read` token, `ot` refuses writes itself (exit 5, `insufficient_scope`): it learns the token's scope from `GET /api/v1/me` once per run, before its first write. With an `agent` token it refuses locally what the server would refuse (for example `ot project archive` or `ot token create`); the server checks again regardless.

### Cron example

A nightly export kept for 30 days, using environment variables instead of a config file:

```cron
# m h dom mon dow  command
0 3 * * *  OPENTODO_URL=https://todo.example.com OPENTODO_TOKEN=ot_… /usr/local/bin/ot export --out /backups/opentodo-$(date +\%F).json && find /backups -name 'opentodo-*.json' -mtime +30 -delete
```

Or add a reminder task every Monday morning:

```cron
0 8 * * 1  OPENTODO_URL=… OPENTODO_TOKEN=… /usr/local/bin/ot add "Weekly review" --due today --time 17:00 --priority 2 >/dev/null
```

## Limits

- Online only, apart from `ot vault`: no offline queue, no local cache. Offline capture is what the web app and PWA are for.
- `--due` understands a fixed set of words; the natural-language quick-add grammar lives in the web client.
- Rate limits on `auth/login` apply (10 per minute per address); `ot auth set-token` avoids them entirely.
- Shell completion covers bash, zsh and fish; there is no PowerShell script.

## Using ot from an agent

`ot` is a dependable tool for coding agents and automation harnesses. The short version, which the skill file below spells out for the agent itself:

1. **Give the agent an `agent` token**, not a full one: create it in Settings → Integrations → API tokens (or `ot token create "my assistant" --scope agent` with an admin token in your profile), then on the agent's machine `ot auth set-token <token> --server <url>`. Turn on **Assistants may make changes** (owner) and **Changes to my tasks** (you) in Settings → Integrations → AI assistants. With that token `ot` can list everything and create and edit tasks, projects, labels and comments, complete and reopen tasks, and move to the Trash only tasks the same token created. Writes carry the device `agent:<token-id>`, show in history as "AI assistant (*token name*)", are audited as `agent.write` and share the token's [limits](mcp.md#limits) with MCP. Tokens, settings, sharing, members, encryption, imports and backups stay out of reach (exit 5). `ot auth status` shows the scope and whether writes are allowed right now. A `full` token works too, with everything that implies; a `read` token for an agent that only looks.
2. **Use `--json`** everywhere, and `ot schema` to discover commands and output shapes.
3. **Use `--dry-run`** before a write that touches more than one task, and **`--idempotency-key`** on creates.
4. **Handle exit codes:** stop and ask on 3, do not retry 5, retry 4 later.
5. **Off a terminal, destructive commands need `--yes`.**
6. **`--read-only`** (or `OPENTODO_READ_ONLY=1`) for an agent that must never change anything, whatever its token allows.

### The agent skill file

`ot skill` prints `SKILL.md`, a skill file that teaches an agent to use `ot` carefully: read first, always `--json`, preview with `--dry-run`, retry-safe creates, stop on exit 5, never run `token`, `auth` or `export` commands unless asked, and treat task titles, descriptions and comments as untrusted data rather than instructions. It is embedded in the binary, so it always matches the version you run, and every release also ships it as `opentodo-agent-skill.zip` (a folder `opentodo-cli/` with `SKILL.md`) next to the `ot-<os>-<arch>` binaries. Unpack it where your agent harness looks for skills, or save the output of `ot skill`.

### Migrating scripts

Two changes in this version can affect existing scripts:

- **`--yes` off a terminal.** `ot rm`, `ot project rm`, `ot token revoke` and `ot auth logout` used to proceed silently when stdout was not a terminal or `--json` was given. They now exit 2 without `--yes`. Add `--yes` to scripts that delete on purpose.
- **Exit code 5.** A refusal for scope, role, switch or encryption (for example 403 `insufficient_scope`) used to exit 1 and now exits 5. Scripts that test for "non-zero" are unaffected; scripts that test for exactly 1 should also accept 5.

`--json` errors also gained the `exit` field and a stderr line, and `ot done`/`ot reopen`/`ot rm` add `ref` and `status` to each printed task; both are additive.
