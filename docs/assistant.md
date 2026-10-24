---
title: AI assistant
summary: Plan and change your tasks by talking, with a model provider your server owner chooses. Every change is proposed for review and can be undone.
audience: user
section: Guides
specs: [in-app-assistant, assistant-skills]
screens: []
order: 76
card: assistant-chat
---
# AI assistant

<picture><source srcset="images/assistant-chat-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/assistant-chat-light.webp" alt="The assistant panel on the right of the Inbox. The question What is due today? is answered with a list of four tasks, three of them overdue, and a token count under the answer."></picture>

The assistant is a chat panel inside OpenTodo. Ask it "what is due today?", "move everything overdue to Friday", "break this task into steps" or "what did the team finish yesterday?". It reads your tasks to answer and **proposes** changes. Nothing changes until you review the proposal and apply it, and one step undoes it.

It is off until the server owner turns it on and chooses a model provider: Anthropic (Claude), OpenAI, Google Gemini or any server that speaks the OpenAI-compatible Chat Completions format, including a model on your own network. If the owner allows it, you can instead [use your own provider and key](assistant-settings.md#use-your-own-provider-and-key).

## Open the assistant

Press <kbd>Shift</kbd>+<kbd>I</kbd> or select **Ask** on **Today** for the panel beside your page, or open the **Assistant** page from the sidebar (<kbd>g</kbd> then <kbd>k</kbd>). They only appear when the assistant is available to you. See [Ask, review and undo](assistant-ask.md#open-the-assistant).

## Skills

Ready-made jobs: **Turn an idea into a project**, **Plan my week**, **Weekly review**, **Triage my inbox** and **Break this down**. Pick one from **Skills** under the message box, or start from a card on the Assistant page. What each does and may touch: [Skills, pasted notes and safety](assistant-skills.md#skills).

## Paste notes

Pasted meeting notes, emails or lists are kept apart as **pasted text**: material for the assistant, never instructions. See [Paste notes](assistant-skills.md#paste-notes).

## Before your first message

The panel shows which provider and model receive your task content and what may be sent; nothing goes out before you select **Accept and continue**. See [What is sent and kept](assistant-privacy.md#before-your-first-message).

## Use your own provider and key

When the owner allows it, **Settings → Integrations → Assistant** lets you choose Anthropic, OpenAI or Google Gemini with your own model and key instead of the server's assistant. See [Assistant settings](assistant-settings.md#use-your-own-provider-and-key).

## Ask and review

Type a question and press <kbd>Enter</kbd>. When you ask for changes, the answer ends with **Proposed changes**: every item is checked, you uncheck what you don't want, then **Apply** or **Discard**. One proposal holds at most 50 changes. See [Ask and review](assistant-ask.md#ask-and-review).

## Undo

After applying, **Undo** puts back every value the proposal changed and moves tasks it created to the Trash, in one step, also offline. See [Undo](assistant-ask.md#undo).

## Apply small changes without review

A switch in **Settings → Integrations → Assistant**, off by default, applies a proposal that only changes completion, due dates, priority or labels of at most 3 existing tasks at once, with an Undo notice. See [Assistant settings](assistant-settings.md#apply-small-changes-without-review).

## Conversations stay on this device

Conversations are stored only in this browser, never synced, exported or backed up. **History**, **New** and **Clear conversations** manage them. See [What is sent and kept](assistant-privacy.md#conversations-stay-on-this-device).

## Costs and limits

Each answer shows its tokens and its share of your monthly allowance; answers on your own key are not counted unless the owner says so. See [Costs and limits](assistant-privacy.md#costs-and-limits).

## Safety

You confirm every change, the assistant cannot touch sharing, members, settings or tokens, and text in tasks is treated as data, not instructions. See [Safety](assistant-skills.md#safety).

## On encrypted accounts

With end-to-end encryption on, the assistant can run on your own device with your own key, if the owner allows it. See [Assistant on encrypted accounts](assistant-encrypted.md).

## Demo instance

The assistant is switched off on the public demo.

## For the server owner

**Settings → Integrations → Assistant → Configure** is where the owner allows providers, enters models and keys, picks the provider everyone uses and turns the assistant on. See [Set up the assistant](assistant-setup.md) and [Assistant owner options](assistant-owner-options.md).
