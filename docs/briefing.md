---
title: The briefing
summary: The sentence under the title of Today and Upcoming - what is late, a full day, replies waiting, and how tomorrow starts - worked out on your device; each part opens what it names, and you can hide it.
audience: user
section: Guides
specs: [web-app, localization, weekly-review]
screens: [settings/briefing#hide-it]
order: 22
---
# The briefing

<picture><source srcset="images/today-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/today-light.webp" alt="The Today view with its title, the date and the briefing sentence above the list."></picture>

Under the title, [Today](today-and-upcoming.md) says in a sentence or two what stands out: "**Three things matter today.** Renew the passport is 2 days late, Monday is already full, and Mia answered about Boiler." It names at most three things, in this order:

- **What is late**, in red: the task and how many days late it is when there is one, otherwise how many. Tasks waiting for another task are left out.
- **A full day**, in amber: today when its estimates go past your day length, otherwise the first day of the coming week that is already full.
- **Replies waiting for you:** who answered about which task, or how many. Opening the task clears it.

When nothing stands out it says so, with how many tasks are planned and the time they add up to.

## Open what it names

Each part of the sentence leads to what it talks about. Click or tap it, or reach it with <kbd>Tab</kbd>; a part is underlined when you point at it.

- **A task's name** ("Renew the passport", the task a reply is about, tomorrow's first task) opens the task. <kbd>Esc</kbd> brings you back.
- **A count of late tasks** ("2 tasks are late") selects exactly those tasks in Today's list and scrolls to them, so the selection bar can reschedule them in one go; <kbd>Esc</kbd> clears the selection. From the Daily check it opens Today first.
- **A full day** ("Monday is already full") opens Upcoming at that day. When several days are full ("Friday and Monday are already full"), each day's name is its own link.
- **Replies** ("3 replies are waiting") open your notifications.

Following a part changes nothing.

## Hide it

Choose **Hide briefing** in the menu (<kbd>…</kbd>) of Today or Upcoming, or turn off **Show the briefing** in **Settings → General → Briefing**. The title and the date stay. The choice belongs to your account, so your other devices hide it too once they sync; **Show briefing** in the same menu, or the switch, brings it back. The Daily check always opens with the sentence.

## When Today is empty

Once you have completed the last task, or [closed the day](method/rhythms.md#close-the-day), it reads **All done for today.** and tells you how tomorrow starts: "Tomorrow starts with 4 tasks; the first is Standup at 9:30 AM." On a day with nothing planned and nothing done it reads **Nothing is planned for today.** instead.

## Upcoming and the Daily check

Upcoming's briefing counts the tasks of the next seven days, names the days that are already full (or says every day still has room), and says how tomorrow starts. The [Daily check](method/rhythms.md#daily-check) opens with the same sentence as Today.

## Where it comes from

Your device works the briefing out from your own tasks, so it works offline, needs no connection and is never written by an AI. It changes as you work and as your other devices sync. The day length is the one in **Settings → General → Calendar grid**, set per device. The sentence follows your interface language; task titles and names stay as you wrote them.
