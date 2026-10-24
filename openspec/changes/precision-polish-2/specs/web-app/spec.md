## MODIFIED Requirements

### Requirement: Day page briefing

Today and Upcoming SHALL show a briefing under the title: a bold lead sentence, then at most one more sentence. The briefing SHALL be computed on the device from the local rows: the tasks of projects that are not archived, the in-app notification cache, the close of the day, the calendar grid's day length and the logical today. It SHALL need no network and no model, SHALL work offline, and SHALL follow changes from other devices as they sync and the clock as the day rolls over, like the list under it. Two devices with the same rows and the same day length SHALL show the same briefing. The briefing writes nothing.

On Today with tasks in the list, the briefing SHALL name at most three things that stand out, in this order:
- **Late:**
  - the overdue tasks Today lists, leaving out blocked tasks;
  - one late task is named with how many days late it is, counted from its due date, or from a passed deadline when that is older;
  - more than one is a count;
  - in the danger tone.
- **Load:**
  - when the estimates of Today's tasks (late ones included) exceed the day length, today's planned time against the day length;
  - otherwise, the first of the next seven days whose estimates reach the day length, by weekday;
  - in the warning tone.
- **Replies:**
  - unread notifications of a mention or a reply on a task page;
  - one is named by who answered and about which task, using the device's own copy of the title when the notification carries none;
  - more than one is a count.

The lead SHALL say how many things matter today, and the facts SHALL follow as one sentence. With nothing to name, the briefing SHALL say that nothing stands out, how many tasks are planned and, when there are estimates, the planned time.

When Today's list is empty, the lead SHALL be "All done for today." if the day was closed or a task was completed on the logical today, and otherwise that nothing is planned for today. It SHALL be followed by tomorrow: how many tasks Upcoming lists for tomorrow and the first of them by due time then priority, with its time; or that nothing is planned for tomorrow yet.

On Upcoming the lead SHALL say how many tasks the next seven days hold. When there are any, it SHALL be followed by:
- every one of those days that is already full, or that every day still has room;
- and tomorrow as above.

The parts of the briefing SHALL lead to what they name. A task the briefing names (one late task, the task a reply is about, tomorrow's first task) SHALL open that task's page, returning to the page it was opened from. A count of late tasks SHALL tick exactly those tasks in Today's list, as bulk selection does, and scroll to the first; from any other page it SHALL open Today first. The ticks SHALL be an ordinary selection: the selection bar SHALL offer its actions and Escape SHALL clear it. A full day SHALL open Upcoming scrolled to that day; where the briefing names several full days, each day's name SHALL be its own link to that day, inside the one sentence the language's list pattern and plural build, while a single full day links its whole clause. Replies that are not about one named task SHALL open the notifications. Each part SHALL keep its tone, SHALL be reachable with the keyboard, SHALL be underlined on hover and keyboard focus, and SHALL have an accessible name that says where it leads. Following a part writes nothing.

The day page's menu on Today and Upcoming SHALL offer to hide the briefing and, once hidden, to show it again, and Settings → General SHALL offer the same choice as a "Show the briefing" switch. The choice SHALL be a synced preference of the account (`user_prefs.briefing`, "hidden" or shown): it SHALL work offline, reach the account's other devices with sync and converge by last-writer-wins; an empty or unknown value SHALL read as shown. With the briefing hidden the day head SHALL keep its title and date. The Daily check SHALL keep its opening sentence either way.

#### Scenario: Three things
- **WHEN** "Renew the passport" was due two days ago, Monday's estimates fill the eight-hour day, and Mia's unread mention is about "Boiler"
- **THEN** Today's briefing reads "Three things matter today. Renew the passport is 2 days late, Monday is already full, and Mia answered about Boiler."
- **AND** the late part is in the danger tone, the full day in the warning tone, and the titles are shown as written

#### Scenario: A calm day
- **WHEN** Today lists two tasks for today with 45 minutes estimated, nothing is late, no later day is full and no reply is unread
- **THEN** the briefing reads "Nothing stands out today. 2 tasks are planned, about 45m in all."

#### Scenario: Today past the day length
- **WHEN** today's tasks hold nine hours of estimates and the day length is eight hours
- **THEN** the briefing names today's nine hours against the eight-hour day instead of a later full day

#### Scenario: Blocked late task
- **WHEN** the only late task waits for an open blocker
- **THEN** the briefing names nothing late

#### Scenario: All done
- **WHEN** the user completed the last task of Today, and tomorrow holds four tasks, the first "Standup" at 09:30
- **THEN** the briefing reads "All done for today. Tomorrow starts with 4 tasks; the first is Standup at 9:30 AM." in the user's time format

#### Scenario: A clear day
- **WHEN** nothing was due today and nothing was completed today
- **THEN** the briefing starts "Nothing is planned for today." and goes on with tomorrow

#### Scenario: Upcoming
- **WHEN** the next seven days hold six tasks, Friday and Monday are full and tomorrow holds one task, "Groceries"
- **THEN** Upcoming's briefing reads "6 tasks in the next seven days. Friday and Monday are already full. Tomorrow starts with one task; the first is Groceries."

#### Scenario: Offline and after sync
- **WHEN** the device is offline and another device completed the late task earlier
- **THEN** the briefing still names it until the completion syncs, and drops it as soon as it arrives, without a reload

#### Scenario: Reply read
- **WHEN** the user opens the task the unread reply was about
- **THEN** the reply leaves the briefing

#### Scenario: Open the late tasks
- **WHEN** Today's briefing reads "Two things matter today. 2 tasks are late and Mia answered about Boiler." and the user activates "2 tasks are late"
- **THEN** exactly those two tasks are ticked in Today's list, the first is scrolled into view, the selection bar offers its actions, and nothing was changed

#### Scenario: The late tasks stay a selection
- **WHEN** the user activates "2 tasks are late" and then presses Escape
- **THEN** the selection bar showed "2 selected" with its actions, and Escape clears both ticks and the bar

#### Scenario: Open a named task
- **WHEN** the user activates "Renew the passport" in the briefing and then presses Escape
- **THEN** the task's page opens, and Escape returns to Today

#### Scenario: Open a full day
- **WHEN** the user activates "Monday is already full" on Today
- **THEN** Upcoming opens scrolled to Monday's group

#### Scenario: Open one of several full days
- **WHEN** Upcoming's briefing reads "Friday and Monday are already full." and the user activates "Monday"
- **THEN** Upcoming scrolls to Monday's group; "Friday" and "Monday" are separate links named "Friday, open in Upcoming" and "Monday, open in Upcoming"

#### Scenario: Several full days in another language
- **WHEN** the interface is in Italian and Friday and Monday are full
- **THEN** the clause reads "Venerdì e lunedì sono già al completo" with "Venerdì" and "lunedì" as the two links

#### Scenario: Open the replies
- **WHEN** the briefing says "3 replies are waiting" and the user activates it on a phone
- **THEN** the drawer opens with the notifications list open

#### Scenario: Keyboard
- **WHEN** the user tabs into the briefing
- **THEN** each part is a stop in reading order, underlined while focused, and announced with where it leads

#### Scenario: Hide the briefing
- **WHEN** the user chooses "Hide briefing" in Today's menu while offline
- **THEN** Today shows its title and date without the sentence, Upcoming does too, and after sync the user's other devices hide it as well

#### Scenario: Show it again
- **WHEN** the briefing is hidden and the user chooses "Show briefing" in Upcoming's menu
- **THEN** the sentence is back on Today and Upcoming

#### Scenario: Daily check while hidden
- **WHEN** the briefing is hidden and the user opens the Daily check
- **THEN** the Daily check still opens with Today's briefing

#### Scenario: The switch in Settings
- **WHEN** the user turns off "Show the briefing" in Settings → General while offline
- **THEN** Today and Upcoming show their title and date without the sentence, the day pages' menu offers "Show briefing", and after sync the user's other devices hide it as well
