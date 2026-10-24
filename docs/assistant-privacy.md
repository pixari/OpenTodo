---
title: What the assistant sends and keeps
summary: What is sent to the model provider and when you agree to it, where conversations live, how tokens are counted, and how encrypted accounts use the assistant on their own device.
audience: user
section: Guides
specs: []
screens: []
order: 80
---
# What the assistant sends and keeps

<picture><source srcset="images/assistant-phone-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/assistant-phone-light.webp" alt="On a phone the assistant fills the screen: the proposal with its checkboxes and buttons, and the message box at the bottom."></picture>

The [assistant](assistant.md) sends your task content to a model provider only after you have agreed, keeps conversations on your device, and counts every answer against a monthly allowance.

## Before your first message

The panel first shows what will be sent and to whom:

- the provider and model the owner chose, or the provider you chose with your own key,
- what may be sent: task titles and descriptions; project, section and label names; due dates, priorities and completion; comments; the names, types and links of attachments (never the files); names of members of shared projects; your display name, today's date and your time zone; and the messages you type.

In a shared project that includes text other members wrote. Select **Accept and continue** to start. Nothing is sent to any provider before you accept. If the provider changes later (the owner switches, you choose [your own](assistant-settings.md#use-your-own-provider-and-key), or the owner stops allowing members' own keys), the assistant asks you again. You can withdraw consent in **Settings → Integrations → Assistant**.

## Conversations stay on this device

Conversations are stored only in this browser: never synced, never sent to other people, not in exports or backups. The panel keeps the last 50 conversations for up to 30 days. **History** lists them (also offline), **New** starts another, and **Clear conversations** deletes them (also **Settings → Integrations → Assistant → Clear conversations on this device**, which asks you to confirm). Signing out deletes them too. The server keeps nothing of a conversation after it has answered.

Offline you can read earlier conversations and apply or undo a proposal that already arrived; asking needs a connection.

## Costs and limits

Each answer shows how many tokens it used and how much of your monthly allowance that is ("1,240 tokens · this month 18% of your limit"); **Settings → Integrations → Assistant** shows the month so far. The owner sets the allowance (500,000 tokens per person per month by default). When you reach it, the assistant says when it resets (the first day of the next month, UTC). One answer at a time per person.

Answers on your own key are paid by you, so they do not count toward the allowance and are never stopped by it ("1,240 tokens · your key"); Settings shows them separately. The owner can choose to count them as well.

## End-to-end encrypted accounts

If your account uses [end-to-end encryption](e2ee.md), the server never runs the assistant for you: it holds no key to your tasks, and relaying them in plain text through the server would break what encryption promises.

When the server owner allows it, the assistant runs [on your device](assistant-encrypted.md) instead. Your device sends what you type and the task data a question needs directly to the provider you set up there, with your own key; the OpenTodo server receives only your consent (which provider you accepted, not the key, the model or the address) and nothing of the conversation. The key is kept in this browser only and deleted at sign-out. Usage is shown on the device and never reported.

When the owner does not allow it, the panel explains that the assistant cannot read encrypted tasks, offers no consent step, and links to **Settings → Account → Encryption**, where you can turn encryption off if you want to use the server's assistant (your tasks are then stored without end-to-end encryption).

## Demo instance

The assistant is switched off on the public demo.
