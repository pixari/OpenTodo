---
title: End-to-end encryption
summary: What encryption hides from the server and what it does not, the threat model, devices, recovery and limits.
audience: user
section: Reference
specs: [end-to-end-encryption]
screens: [settings/encryption]
order: 70
---
# End-to-end encryption

Optional, per account, off by default (OpenSpec change `e2ee`). When it is on, your devices encrypt the *content* of your tasks before it is synced, so the server, its backups and every server-side integration hold only ciphertext for it. Sync, offline use and conflict-free merging keep working because ciphertext travels through the unchanged operation log as an ordinary string value.

Turn it on in **Settings → Account → End-to-end encryption**.

[Automation rules](automations.md) work with encryption: their conditions and actions use ids and dates. Only the comment action is unavailable.

## What is encrypted, what is not

Encrypted, in your personal data (Inbox, your own projects, labels, saved views):

| Entity | Encrypted fields |
| --- | --- |
| task | `title`, `description`, `ical_extra`, `notes_doc` (the rich-text note document, encrypted as one opaque string; its ciphertext must fit the 256 KB document limit, so an encrypted note document is capped at about 196 KB), `origin` (where the task came from: the whole object, serialised as JSON and encrypted into one ciphertext string, because its title, link and id name the page, mail or issue; the server accepts that string wherever it accepts the object) |
| project | `name`, `description` and `notes_doc` (the project's note) |
| label | `name` |
| section | `name` |
| saved view | `name`, `query` |
| comment | `body` (your comments on your own tasks) |
| attachment | `name`, `mime` (the file type), `url` (a link's address), and the file itself, as an encrypted file (see below) |
| custom field | the field's `name` and `options`, and every text, link, date and choice value on a task (`fields.<id>` with a string value) |
| time entry | `note` (the [time entry](time-tracking.md)'s note) |
| review | `tomorrow_note` (the line for tomorrow you leave when you [close the day](method/rhythms.md#close-the-day)) |

When a view sorts by a custom field, its plaintext sort setting carries only `field:<definition-id>`. The device resolves that id to the decrypted field name and matches definitions locally; the field name remains encrypted and never enters the operation log.
Everything else stays **plaintext**, because views sort and group by it, reminders and calendars schedule with it, and the server needs it to merge and authorize: `due` (date, time, zone), `priority`, `completed_at`, `deleted_at`, `created_at`, `position`, `project_id`, `parent_id`, `section_id`, `labels` (the list of label ids on a task), `recurrence`, `estimate_minutes`, `energy`, `assignee_id`, number and checkbox values of [custom fields](custom-fields.md), a custom field's `type` and `project_id`, project `color` and `archived`, reminder times, the review record's times and today's focus (`completed_at`, `daily_at`, `monthly_at`, `closed_at`, `focus_date`, `focus`), a time entry's `task_id`, `user_id`, `started_at`, `ended_at`, `device_id`, `created_at` and `deleted_at` (so the server can total and export tracked time; its CSV and AI assistants show `[encrypted]` for the note), an attachment's `size` and `sha256` (of the encrypted file) and `encrypted` flag, a comment's reactions (`reactions.<account id>`: who reacted with which of six names) and a task's `note_mentions` (the members its notes mention; the mention itself, like every table and image in the note, stays inside the encrypted `notes_doc`), and all timestamps and device ids of operations. An image embedded in a note or comment names its attachment; the device downloads the encrypted file and decrypts it to show it, and a locked device shows "Encrypted image".

Empty values (`""`) and `null` are not encrypted. The length of a ciphertext reveals the approximate length of the text.

**Shared projects are never encrypted.** A project that was shared before you enabled encryption, and projects other people share with you, stay plaintext for every member. While encryption is on you cannot share a project that is not shared yet (409 `encryption_enabled`): the members would hold no key.

## Threat model

Protected against:

- Someone who reads the server's disk, database file, backups (local, S3, WebDAV) or database dumps: they see ciphertext for the fields above.
- The server operator browsing the data, and server-side integrations (CalDAV, the MCP endpoint, webhooks, the REST API with an API token): they see ciphertext or a placeholder.
- A server or a bug moving a ciphertext to another field or task: the value is bound to `entity`, `entityId` and `field` and fails authentication; the app shows "[Cannot decrypt]" and keeps the operation.

Not protected against (honest limits):

- **Metadata.** Everything in the plaintext list above, plus how many tasks, projects and labels you have, when you edit what, from how many devices, and the approximate length of each text.
- **A malicious or compromised server serving tampered JavaScript.** The web app is delivered by the same server it protects you from. A server that changes the code can capture the passphrase or the key on the next load. This is inherent to web-delivered end-to-end encryption; a future change may verify release signatures in the service worker.
- **Your devices.** The device is the trust boundary: local storage (IndexedDB) holds plaintext and the account key (as a non-extractable `CryptoKey`). Malware, a browser extension with access to the page, or someone with your unlocked device can read everything. "Lock this device" forgets the key and pauses sync but leaves already synced data in local storage; **Sign out** clears local data.
- **Weak passphrases.** The server holds the passphrase-wrapped key. Someone with that record can try passphrases offline; PBKDF2 with 600,000 iterations slows this down but is not memory-hard. Use a long passphrase (at least 12 characters are required). The app refuses a key record whose iteration count is below 100,000 or above 10,000,000 and stays locked with an error, so a broken or hostile server can neither weaken the derivation nor hang the device.
- **Rollback of a value.** The authenticated data binds a ciphertext to its entity, id and field, but not to a version or time. A server can serve an older ciphertext of the *same* field again (for example the title a task had last month, or a whole older state from a backup), and the app cannot tell: it decrypts correctly and wins by its clock as usual. Encryption guarantees that the server cannot read or forge content, not that it shows you the latest content.
- **Turning encryption off by forgetting the key record.** A server cannot switch a device back to plaintext: a missing key record (a server restored from a backup made before encryption, another device that turned encryption off, or a hostile server) pauses sync on every device that encrypts until you choose (see [Devices, locking and offline use](#devices-locking-and-offline-use)). If you choose to turn encryption off there, the server sees your content in plaintext again.
- **Plaintext that existed before.** Content written before encryption was enabled, or written in plaintext later (REST, email), stays in older backups and in the server's history until you purge it (see below).
- **Your account itself.** Encryption protects content, not access: anyone who can sign in can delete, reschedule or tombstone your (encrypted) tasks, and can read the plaintext fields.

## How it works

Key hierarchy, all generated and used in the browser with the built-in Web Crypto API (no dependency):

- **Account key**: 256 random bits, AES-256-GCM. Kept on each unlocked device as a non-extractable key in IndexedDB.
- **Passphrase key**: PBKDF2-HMAC-SHA-256 over your passphrase (NFC-normalised) with a 16-byte random salt and 600,000 iterations, producing an AES-KW key.
- **Recovery key**: 256 random bits, shown once as 56 base32 characters in 14 groups of four (52 for the key, 4 for a checksum). HKDF-SHA-256 (fixed salt, info `opentodo/e2ee/recovery-kek/v1`) turns it into an AES-KW key.
- The account key is wrapped (AES-KW, RFC 3394) under both. The **key record** — `{version, kdf, salt, iterations, wrappedByPassphrase, wrappedByRecovery}` — is the only key material the server stores (`encryption_keys` table). It never receives the passphrase, the recovery key or the account key.

Value format (a string in the existing op value):

```
"enc:v1:" + base64url( nonce(12 bytes) || AES-256-GCM(utf8(plaintext)) || tag(16 bytes) )
additional authenticated data = utf8(entity + "\0" + entityId + "\0" + field)
```

Nonces are 96 random bits per encryption. Known-answer vectors shared by the Go and browser test suites are in [`web/src/lib/e2ee.vectors.json`](../web/src/lib/e2ee.vectors.json).

Attached files are encrypted on the device in 1 MiB chunks, so a large file is never held in memory twice:

```
header  = "OTAT1" || chunk size (4 bytes, big-endian) || file prefix (8 random bytes)
chunk i = AES-256-GCM(chunk i of the file) || tag(16 bytes)
nonce i = file prefix || i (3 bytes, big-endian) || 0x01 on the last chunk, else 0x00
additional authenticated data = utf8("attachment\0" + attachment id + "\0") || header
```

The id in every chunk binds the bytes to their attachment, and the marked last chunk means a cut-off file is detected. The server stores and serves the encrypted file as opaque bytes (always as a download), and its `size` and `sha256` describe the encrypted file, never the original. Opening a file downloads it to the device, checks and decrypts every chunk, and only then shows it: a chunk that fails the check means nothing is shown. An encrypted file is about 16 bytes per MiB larger than the original, so a file just under the per-file limit can be refused once encrypted. Thumbnails are not shown for encrypted images.

Where it happens on the device:

- Every edit is applied locally in plaintext and queued. The sync engine encrypts content fields **at the single point where operations leave the device** (just before upload), so nothing reaches the server in plaintext whichever path created the operation (edits, re-seeding after a server restore, the migration, encrypt-on-sight).
- Incoming operations are decrypted before they are applied, so search, filters and views work on plaintext locally.
- Convergence is unchanged: winners are chosen by `(timestamp, device)`, never by value. Two ciphertexts of the same text differ, which does not matter.

Content larger than 48,000 bytes (UTF-8) in one field is refused before an operation is created, because its ciphertext would exceed the server's 64 KiB value limit.

## Devices, locking and offline use

- **New device**: sign in, then enter the passphrase (or the recovery key) on the unlock screen. Nothing is pulled or pushed before that; the sync status reads **Locked**. Afterwards the device works offline and does not ask again.
- **Wrong passphrase**: an error, and after 5 failures within a minute further attempts are delayed for the rest of that minute (on this device).
- **Lock this device** (Settings): forgets the key and pauses sync until unlocked.
- **The command-line client**: `ot encryption unlock` unwraps the key with the passphrase (or `--recovery`) on your computer and keeps it in an owner-only file next to the CLI's configuration, so [`ot mcp --decrypt`](cli.md#mcp-bridge-and-encryption) can let a local AI assistant read and write your text. The passphrase and the key never reach the server; the assistant's AI provider does receive the plaintext it reads. `ot encryption lock` deletes the key file, and a passphrase change elsewhere makes it stale until you unlock again.
- **Offline unlock** works once the device has seen the key record.
- **Unlock with a fingerprint** (Android app): see [below](#unlock-with-a-fingerprint).
- A device that did not know encryption had been enabled notices the first ciphertext it receives, checks the key record and locks itself without applying the batch.
- **Key record missing**: only you can turn encryption off on a device, never an answer from the server. When the server says it has no key record while the device encrypts (the server was restored from an older backup, another device turned encryption off, or the server misbehaves), the device stops syncing and nothing leaves it, not even the re-send after a server restore. A screen explains it and offers three choices: **Restore the key record from this device** (uploads the copy the device kept; same passphrase and recovery key; a device without the key asks for the passphrase first), **Turn off encryption on this device** (your content is uploaded in plaintext again), or **Sign out**.

### Unlock with a fingerprint

In the [Android app](android-app.md), on a phone with a fingerprint or face unlock, the unlock screen offers **Unlock with fingerprint or face next time**. After you unlock with the passphrase, the app keeps a copy of the account key encrypted by Android's keystore under a key that opens only with your fingerprint or face; from then on the unlock screen shows **Unlock with fingerprint or face**, and the passphrase still works. The copy never leaves the phone. It is deleted when you sign out, change or reset the passphrase on this phone, turn encryption off, or when the account key changes; Android makes it unusable when fingerprints or faces are added or removed. **Lock this device** keeps it, so the next unlock can use the fingerprint.

## Passphrase change, recovery, losing both

- **Change passphrase** (needs the current one and a fresh sign-in confirmation): re-wraps the account key; content is not re-encrypted; other devices keep working; new devices use the new passphrase.
- **Reset with the recovery key** (forgotten passphrase): sets a new passphrase and issues a **new recovery key**; the old one stops working.
- **Lost both**: the content cannot be recovered by anyone, including the server owner — there is no server-side reset. Settings and the unlock screen offer only to turn encryption off and delete the encrypted content: the key record is removed and every item whose content cannot be decrypted is moved to the Trash as it syncs. Plaintext fields (dates, structure) are kept.

## Enabling, plaintext that appears later, purging, disabling

- **Enabling** re-writes every content field of your personal data as ciphertext through ordinary operations, with progress in Settings; the job is resumable after a reload. 500 tasks produce roughly 1,500 operations. A link attachment cannot change its address on the server, so each personal link is replaced by a copy with the address and name encrypted, and the plaintext link moves to the Trash. Then each attached file is downloaded, encrypted and uploaded again as a new attachment that replaces the plaintext one ("Encrypting your files: 3 of 40 files"). This part needs a connection: it stops when the network goes and continues after the next sync, and files not done yet keep their old form meanwhile.
- **Plaintext written later** — through the REST API, the CLI, email-to-task or an import — is accepted by the server and shown with a small "not yet encrypted" marker; the next unlocked device that syncs it re-writes it as ciphertext ("encrypt-on-sight"). Two devices doing that at once produce two ciphertexts of the same text; one wins and nothing is re-written again.
- **Purge plaintext history** (`POST /api/v1/encryption/purge-history`) deletes the superseded operations of the content fields in your personal data, including the plaintext from before encryption. Winners stay, so every device still converges. The deletion runs with SQLite `secure_delete`, then the database is vacuumed and the write-ahead log truncated. Revision history for those fields is gone afterwards. **Backups made before the purge, and copies of the database, may still contain plaintext**: delete them if that matters to you.
- **Disabling** (needs an unlocked device and a fresh sign-in confirmation) first re-uploads every encrypted file decrypted, while encryption is still on, and waits until the last one is stored on the server, so no file becomes unreadable. Then it deletes the key record, so other devices stop encrypting, and re-writes all content as plaintext, replacing each encrypted link with a plaintext copy. Devices that still hold the key decrypt ciphertext that arrives late and re-write it as plaintext too.

## Server-side reads and integrations

Workspace names, members and groups are server data in plaintext, like project members; with encryption on you can create [workspaces](workspaces.md) and move things between them, but not add members, groups or invite links yet.

The server cannot decrypt. Each feature that needs content degrades explicitly:

| Feature | Behaviour for an encrypted account |
| --- | --- |
| REST API reads | Return the ciphertext string in content fields, plaintext elsewhere. Scripts need the key to decrypt (format above). |
| REST API writes | Accepted in plaintext; encrypted on sight by the next unlocked device. |
| Occurrences of repeating tasks | A device copies and encrypts the content into an [occurrence record](recurrence.md#one-occurrence-alone) itself, since a ciphertext belongs to one task id. The records the server writes (a REST completion, the occurrence routes, assistants) carry no title or notes; the next unlocked device fills them in from the series. |
| Export (`GET /api/v1/export`) | Ciphertext content, plaintext scheduling fields, and the wrapped key record under `encryption`, enough to decrypt elsewhere with the passphrase. Importing it into another account keeps the ids (so the binding still matches), but that account needs the same key record to decrypt. |
| Import | Writes plaintext like REST; duplicate detection by name/title cannot match encrypted labels and projects, so an import may create duplicates. |
| Backups | Hold ciphertext and the wrapped key record (plus any plaintext not yet purged). |
| CalDAV | Refused: `/dav/` answers 403 for the account and creating an app password answers 409 `encryption_enabled`. Calendar clients can neither read ciphertext nor write it back, and placeholders would overwrite real titles. |
| Calendar feed URL | Encrypted titles appear as "Encrypted item" in calendar apps; dates, times, estimates and recurrence are served as stored. |
| Subscribed calendars | Events fetched from other calendars are stored on the server unencrypted, like any data the server fetches for the account. The settings panel says so. |
| MCP (assistants) | Encrypted titles, descriptions, project, label, section and custom field names and text values of custom fields read as "Encrypted item" with `"encrypted": true`; `search_tasks` never matches them. Dates, priorities and structure are still reported. A task's origin is left out (`origin: null`). Text arguments of write tools accept only ciphertext envelopes and plain text is refused with `encryption_enabled`; scheduling, completing, moving, priorities, labels, colours, icons and order still work. On your own computer, [`ot mcp --decrypt`](mcp.md#encrypted-accounts-on-your-computer) decrypts and encrypts for an assistant (see below). For a cloud connector, a device you opt in can [answer for it](mcp.md#cloud-connectors-through-your-device): the key stays on that device, but the text the connector asks for passes through the server's memory, never stored, logged or audited, capped at 5,000 values an hour by the device. |
| In-app assistant | The server never runs it for an encrypted account. When the owner allows it, it runs [on your device](assistant-encrypted.md): the device reads its own decrypted tasks and calls the provider you set up there with your own key; the server sees no content and no key. |
| Issue connections | Refused: creating or enabling a GitHub or GitLab connection answers 409 `encryption_enabled`, because every poll would write issue titles and bodies into the history in plaintext. Turning encryption on stops the account's connections (`encrypted_account`) and the encryption screen names them; tasks already created stay and are re-written as ciphertext like the rest. See [Issue import](issue-import.md). |
| Email to task | Creates plaintext Inbox tasks (the mail crossed mail servers in the clear anyway); encrypted on sight; purge removes the plaintext operations. |
| Webhooks | Payloads carry the stored value: ciphertext for encrypted fields. |
| Reminder pushes | An encrypted title is never put in the push payload, even for devices that opted in to content; the notification shows the content-free text. |
| Notifications (assignment, mention) | Use "Encrypted item" instead of a ciphertext title (only relevant if ciphertext ever reaches a shared project). |
| Revision history, activity | Served as stored; the web app decrypts values for display. |
| Sharing | First share of a project refused with 409 `encryption_enabled`. |
| Filters | Evaluated on the device on plaintext; nothing server-side. |
| Markdown vault | [`ot vault`](vault.md) decrypts on your computer with the key stored by `ot encryption unlock` and encrypts what it sends, so the server sees ciphertext; the vault's files hold plaintext. It refuses to sync without the key (`encryption_enabled`). |

## API

See [api.md](api.md#end-to-end-encryption): `GET`/`PUT`/`DELETE /api/v1/encryption/keys`, `POST /api/v1/encryption/purge-history`, `encryption` and `minClientVersion` in `GET /api/v1/me` and `GET /api/v1/auth/status`.
