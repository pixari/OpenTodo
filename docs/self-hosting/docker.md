---
title: Running with Docker
summary: Docker Compose and docker run, reverse proxies, push, updates, managing users and recovering owner access.
audience: admin
specs: [self-hosting, user-administration, audit-log, invitations]
screens: []
order: 10
---
# Running OpenTodo with Docker

## Docker Compose

```bash
git clone https://github.com/pixari/opentodo.git
cd opentodo
cp .env.example .env        # optional
docker compose up -d
```

Open <http://localhost:8080>. The first visitor creates the owner account. From this machine or your local network (loopback and private addresses) that is all.

### The setup code

Opened from a public address while no owner exists, the setup screen asks for a **setup code**, so nobody on the internet can claim a fresh server before you do. The server generates the code when it starts without an owner and prints it once in its log:

```bash
docker logs opentodo            # or: docker compose logs opentodo
```

```text
level=WARN msg="No owner account exists yet. To create it from outside this server's local network, enter this setup code on the setup screen: ABCD-EFGH-IJKL-MNOP (from this machine or a private network no code is needed)." setup_code=ABCD-EFGH-IJKL-MNOP
```

Type it into the **Setup code** field (case and dashes do not matter). It works once: as soon as the owner exists it is discarded, and a restart without an owner prints a new one. Attempts count against the registration rate limit. On a platform without a terminal, open the container's logs in its panel.

Instead of the code you can set `OPENTODO_SETUP_TOKEN` (16+ characters) in `.env`, a secret you choose: the setup screen then asks for it from every address, including your own network, and no code is printed. It has no effect once the owner exists.

To add more people, keep sign-up closed and create single-use invitation links in **Settings → People → Members** (see [Adding people](../../README.md#adding-people)). `OPENTODO_ALLOW_SIGNUP=true` opens registration to anyone who can reach the server and is rarely what you want on a public URL. If you do open it, configure [outgoing email](outgoing-email.md) too: new accounts are then created only after the person confirms their address through a mailed link.

- Data lives in the named volume `opentodo-data`, mounted at `/data`.
- Change the host port with `OPENTODO_PORT` in `.env`, and the host address it is published on with `OPENTODO_BIND` (default `0.0.0.0`, every interface, so other devices on your network reach it). Behind a reverse proxy on the same machine, `OPENTODO_BIND=127.0.0.1` is the safer choice: only the proxy reaches the server.
- Every variable in the [configuration table](../../README.md#configuration) can be set in `.env`; the compose file passes them to the container. With `docker run`, pass them with `-e`.
- The compose file pulls `ghcr.io/pixari/opentodo:stable`, which every release moves. To stay on one release line use `:0.11` (its fixes only), to pin one version `:0.11.0`; `:latest` follows the main branch and carries unreleased changes; it reports its version as `dev+<commit>`, the commit it was built from. The running version is shown in **Settings → About**, at the bottom of the sign-in screen, at `/healthz` and in the startup log line `opentodo listening`.
- To build locally instead of pulling: replace `image: ghcr.io/pixari/opentodo:stable` with `build: .`.

## Plain `docker run`

```bash
docker run -d --name opentodo \
  -p 8080:8080 \
  -v opentodo-data:/data \
  -e OPENTODO_BASE_URL=https://todo.example.com \
  ghcr.io/pixari/opentodo:stable
```

## Behind a reverse proxy

OpenTodo speaks plain HTTP on 8080 and expects the proxy to terminate TLS. Set `OPENTODO_BASE_URL` to the public https URL so cookies are marked `Secure`, responses carry `Strict-Transport-Security` (one year, no `includeSubDomains`, no preload), the origin check matches and links point at the public address. With a base URL, a browser request must also be addressed to its host: a page under another name that happens to resolve to your server is treated as cross-site. **After moving to a new domain, update `OPENTODO_BASE_URL` too**: until you do, signing in and other requests from the new address are refused with "cross-site request rejected", the sign-in screen names the address the server is set up for, and the log has one warning per refused host (`refused a browser request for a host that is not OPENTODO_BASE_URL's` with `host=` and `base_url=`). Redirect the old domain to the new one at your proxy or DNS provider. Emailed links (password resets, sign-up confirmations, invitations) are only ever built from it, so without it [outgoing email](outgoing-email.md#set-the-base-url-first) sends none of them. Without a base URL, the links the app shows you (invite and reset links to copy, the CalDAV address, calendar feeds, public links) use the address of your own request, and cookies are still marked `Secure` whenever the request arrived over https.

**Which proxies are believed.** `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` and Cloudflare's `CF-Connecting-IP` count only when the connection comes from a trusted proxy. By default those are loopback, private and link-local addresses (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `169.254.0.0/16`, `fe80::/10`), which covers a proxy on the same machine or a container network (Traefik, Caddy, nginx, Coolify, Dokploy, Kubernetes ingress). From any other address the headers are ignored and the connection's address is the client, so a client that reaches the container directly cannot choose its own address. From a trusted proxy the client is the nearest untrusted `X-Forwarded-For` hop, read from the right: the address your proxy appended (Traefik, Caddy, and nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` append it). Make sure your proxy appends to or replaces the header rather than passing the client's through. Rate limits, the audit log, the demo sandbox limit and the [setup code](#the-setup-code) all use this address; IPv6 clients share a limit per `/64`.

**Brute-force limits.** Each anonymous route has its own window per address (password sign-in counts failures only, 10 a minute; registration, password resets, invitation links, public links, MCP requests without a valid token and passkey sign-in 10 a minute each). On top of that, 10 failed passwords, second-factor codes or re-authentications for one account within 15 minutes lock that account's sign-in for the rest of the window, from every address: the answer is 429 `account_locked` with `Retry-After`. A successful sign-in clears the count.

**`OPENTODO_TRUSTED_PROXIES`** replaces the default with your own list: IP addresses, CIDR prefixes and the keywords `private` (the default ranges above) and `cloudflare` (Cloudflare's published edge ranges, built in, no network request; it keeps the default ranges too). Behind Cloudflare's orange cloud every visitor would otherwise look like a Cloudflare address and share one rate-limit bucket; with `cloudflare`, a hop from a Cloudflare edge is attributed to its `CF-Connecting-IP` header, which also works when your proxy drops the incoming `X-Forwarded-For`.

```env
OPENTODO_TRUSTED_PROXIES=cloudflare
```

A proxy on a public address of yours is listed by address; add `private` when your reverse proxy on this machine or network should stay trusted (`private, 203.0.113.10`). A list that names no loopback or private address gets a configuration warning, because the local proxy is then no longer believed and every visitor would share its address. Entries may be separated by commas or spaces, and the keywords are case-insensitive (`cloudflare, 192.0.2.0/24` and `Cloudflare 192.0.2.0/24` are the same). **An invalid entry does not stop the server.** It is ignored, the valid entries still apply and the server starts and stays healthy. Ignoring an entry only ever trusts fewer hops, so a typo never lets a client choose its own address; if no entry is valid, the server behaves as if the variable were unset. The container log has one error line naming each ignored entry, what is accepted and what was applied, with a hint for a near miss of a keyword:

```text
level=ERROR msg="OPENTODO_TRUSTED_PROXIES: invalid entries ignored" invalid=cloudflar hint="did you mean \"cloudflare\"?" accepted="IP addresses, CIDR prefixes (such as 192.0.2.0/24) and the keywords \"private\" and \"cloudflare\", separated by commas or spaces" applied="none (loopback and private networks are trusted, as when unset)"
```

The owner also sees a **Server configuration warning** at the top of **Settings** and of **Settings → People**, naming the ignored value. Admins, members and API tokens do not see it. Correct the value and restart the container; the warning goes away.

### Email to task

[Email to task](../email.md) needs no port, proxy rule or DNS record: OpenTodo makes one outbound IMAP connection (TLS, port 993 by default) to the mailbox you configure with `OPENTODO_EMAIL_*`. If your host restricts outbound traffic, allow that one host and port. Keep the password in a Docker secret and point `OPENTODO_EMAIL_IMAP_PASSWORD_FILE` at it (example in the guide).

### Calendar apps (CalDAV) through the proxy

When the owner enables [CalDAV](../caldav.md), calendar apps use `/dav/` and `/.well-known/caldav` with WebDAV methods (`PROPFIND`, `REPORT`, `MKCALENDAR`, `PROPPATCH`). Most proxies (Caddy, Traefik, nginx) forward them unchanged; make sure no rule limits methods to GET/POST or blocks `/.well-known/`, and that the `Authorization` header is passed through. App passwords travel in every request, so serve CalDAV over https only.

### Passkeys need an https base URL

Passkeys (Settings → Account → Passkeys) are only offered when `OPENTODO_BASE_URL` is an `https://` URL; browsers refuse WebAuthn on plain-http origins. With no base URL or an `http://` LAN address, the server keeps working with passwords and simply hides passkeys (`auth/status` reports `passkeysAvailable: false`). For local development `http://localhost:8080` also works, because browsers treat localhost as secure.

On a plain-http network address (for example `http://192.168.1.10:8080` on a NAS or home server) tasks, projects, sync, sharing and attachments all work. A few features need what browsers only offer over HTTPS or on localhost: installing the app and working offline, push notifications, passkeys and end-to-end encryption. Put the server behind a reverse proxy with a certificate, or a tool such as Tailscale with HTTPS, to use them.

Passkeys are bound to the **host** of that URL (the relying-party id, for example `todo.example.com`). If you move the server to a new domain, existing passkeys stop matching: users sign in with their password and register new passkeys from Settings. Paths and ports do not matter, only the host. See [SECURITY.md](../../SECURITY.md) for the credential model.

Caddy example:

```
todo.example.com {
    reverse_proxy opentodo:8080
}
```

### Live updates through the proxy

Each open tab keeps one long-lived request open, `GET /api/v1/sync/events`, a server-sent event stream the server uses to tell devices "new changes, sync now". It needs nothing special from Caddy, Traefik (Coolify) or nginx with default settings, because the server already:

- sends `Cache-Control: no-cache` and `X-Accel-Buffering: no` (nginx honours the latter and stops buffering that response),
- flushes after every write and sends a `: ping` heartbeat every 25 s, below the usual 30–60 s idle timeouts,
- caps streams at 16 per account and closes them cleanly on shutdown.

Things to keep in mind:

- **Buffering.** If a proxy buffers whole responses (older nginx configs with `proxy_buffering on` and no respect for `X-Accel-Buffering`, or some CDN "optimisation" layers), the stream never opens. For nginx add `proxy_buffering off;` to the `location` that proxies OpenTodo, or at least `proxy_http_version 1.1;` and leave `X-Accel-Buffering` enabled.
- **Idle timeouts.** Any read/response timeout on the proxy shorter than 25 s will cut the stream (the client reconnects, but it is wasteful). The defaults of Caddy, Traefik and nginx (`proxy_read_timeout 60s`) are fine.
- **HTTP/2 is recommended.** Browsers allow only six HTTP/1.1 connections per origin, and every open tab holds one for the stream. Terminate TLS at the proxy with HTTP/2 (the default for Caddy and Traefik with https) and the streams are multiplexed over one connection. On plain HTTP/1.1 keep the number of open tabs small.

Troubleshooting "live updates disconnected" (the status pill says **Polling** instead of **Live**):

1. Open `https://todo.example.com/api/v1/sync/events?device=test` in a signed-in browser tab. You should see `: connected` immediately and `: ping` every 25 s. If the page keeps loading with nothing shown, the proxy is buffering.
2. If it works but drops after a fixed time, a timeout somewhere in the chain is shorter than the heartbeat; raise it above 25 s.
3. Nothing is lost either way: while the stream is down the app polls every 30 s exactly as before.

## Reminders and web push

Reminders are shown in the app on every device and, for devices that enable notifications in **Settings → Notifications**, sent as web push so a closed app still notifies. Nothing needs configuring: on first use the server generates a VAPID key pair at `<data>/push_vapid.pem` (mode 0600). Keep it with the database: it is included in backup archives and restored with them, and existing subscriptions only work with the key they were created for.

Push is the only outbound traffic that is on by default (webhooks, backups to S3 or WebDAV, single sign-on and email to task contact only what you configure; see [Privacy](../../README.md#privacy)). A push goes to the push service the user's own browser chose when it subscribed (Google, Mozilla, Apple…), carries an encrypted payload the push service cannot read, and by default contains only ids (the device opts in to task titles). Browsers require https for push, so set `OPENTODO_BASE_URL` to your public https URL (it is also sent as the VAPID contact). To forbid outbound traffic set `OPENTODO_PUSH=off`: the push routes answer 404, no push is sent, and reminders are still shown in the app.

## AI assistants (MCP)

The [MCP endpoint](../mcp.md) at `/mcp` is off until the owner enables it in **Settings → Integrations → AI assistants** (or `OPENTODO_MCP=true` presets it on the first start). It is read-only unless the owner also allows assistant changes (`OPENTODO_MCP_WRITES=true` presets that on the first start) and a user allows them for their account. It needs no extra port or container: assistants reach it through the same URL and reverse proxy as the app, with an API token in the `Authorization` header. Proxies that buffer or rewrite requests need nothing special, since every answer is a plain JSON response (no event stream). The server makes no outbound request for it. If your proxy logs request headers, exclude `Authorization`.

## In-app assistant

The [assistant](../assistant.md) is off until the owner turns it on in **Settings → Integrations → Assistant**. There is no environment variable for it: providers, models and keys are set in Settings, and keys are stored in `/data/secrets/assistant.json` (mode 0600), which backups never include. While it is off, the server makes no request to any model provider.

When it is on, the server makes outbound HTTPS requests only to the provider the owner enabled (and, when the owner lets members bring their own key, to the built-in host of the provider a member chose for their key) and only while someone is waiting for an answer (plus **Test connection**, for the owner and for a member's own provider):

| Provider | Host |
| --- | --- |
| Anthropic | `api.anthropic.com` |
| OpenAI | `api.openai.com` |
| Google Gemini | `generativelanguage.googleapis.com` |
| Compatible endpoint | the base URL the owner entered |

If your host restricts outbound traffic, allow that one host (or all three built-in hosts when members may use their own provider). Members can never enter a base URL. Requests to the three built-in hosts honour the usual `HTTPS_PROXY` environment variable. A compatible base URL is checked like a webhook target: it is resolved before every connection, private, loopback, link-local and cloud-metadata addresses are refused unless the owner ticks **Allow private endpoints** (needed for Ollama or LM Studio on your network), the connection goes to the address that was checked, redirects are never followed, and no proxy is used. Requests carry the conversation and the task data the assistant reads, nothing about your instance or other users.

The **on-device assistant for encrypted accounts** (off by default) makes no server request at all: the person's browser calls the provider they set up, with their own key. While the owner allows it, the page's Content-Security-Policy lets the app connect to the allowed providers' API origins and the model server origins the owner listed, so a proxy or browser policy that rewrites `Content-Security-Policy` must keep that `connect-src`. See [Assistant owner options](../assistant-owner-options.md#on-device-assistant-for-encrypted-accounts).

The answer streams to the browser as server-sent events on `POST /api/v1/assistant/turn`, like the live updates stream: a proxy that buffers responses delays the answer until it is complete (see [Live updates through the proxy](#live-updates-through-the-proxy) for the same settings). The server logs one line per answer with the provider, whether it ran on the member's own key, outcome, duration and token counts, never questions, answers or task text. Turns are limited to 8 at a time on the server, one per person, and each person's monthly token allowance (answers on a member's own key are outside the allowance unless the owner counts them).

## Bind mounts

The container runs as uid 65532 (distroless `nonroot`). A bind-mounted data directory must be writable by that user:

```bash
mkdir -p ./data && sudo chown 65532:65532 ./data
docker run -v "$PWD/data:/data" ...
```

## Backup and restore

Turn on scheduled backups in **Settings → Server** (owner only): consistent snapshots of the database, taken while the server runs, written to `/data/backups`, an S3-compatible bucket or a WebDAV share, with retention and optional encryption. Restore with the binary in the image while the container is stopped:

```bash
docker compose stop opentodo
docker compose run --rm --no-deps opentodo restore /data/backups/opentodo-20261010-030000-4f1c0a9e.tar.gz
docker compose start opentodo
```

Destinations, encryption, the archive format and the full restore procedure (including encrypted and downloaded archives) are in [docs/backups.md](../backups.md). Copying the `/data` volume while the container is stopped still works as a manual backup. A per-user JSON export is available from **Settings** in the app or `GET /api/v1/export` with an API token.

## Attachments

Files attached to tasks are stored under `/data/attachments/`, one file per attachment, owned by the container user like the rest of `/data`. They are part of backups and restores. The owner sets the size limits in **Settings → Server → Attachments**; `OPENTODO_ATTACHMENTS_MAX_FILE_MB` and `OPENTODO_ATTACHMENTS_QUOTA_MB` can preset them on the first start. See [docs/attachments.md](../attachments.md).

## Trash retention

Deleted tasks and projects stay in the Trash, restorable, for 30 days; then the server purges them for good (operations and values removed, a small marker kept so devices drop their copies). Set `OPENTODO_TRASH_RETENTION_DAYS` to change the period (`0` keeps the Trash until a user empties it). The job runs at startup and once a day. Purged data is gone from the live database, but older backup archives still contain it; restoring one brings back the items as they were when it was taken. See [docs/sync.md](../sync.md#purge).

## Audit log

The owner sees an audit log of sign-ins, failed sign-ins, sign-outs, credentials (API tokens, app passwords, passkeys, second factors), invitations, user administration, exports, backups and setting changes in **Settings → Account → Audit log** (API: [docs/api.md](../api.md#audit-log)). It is stored in `opentodo.db` inside `/data`, so it is part of every backup of the volume, and it never contains task content. Nothing needs configuring:

- **Retention** defaults to 90 days (7–3650, set in Settings). Expired events are pruned at startup, hourly and right after you lower the retention.
- **Client addresses** are not recorded unless you turn on address logging in Settings. Behind a trusted reverse proxy the address is the nearest untrusted `X-Forwarded-For` hop (the one the proxy appended; see [Which proxies are believed](#behind-a-reverse-proxy)), so make sure the proxy sets that header (Caddy, Traefik and nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` do). Turning address logging off erases every stored address immediately.
- **Disk use** is roughly 200 bytes per event: a household produces a few MB per year; a public server under credential stuffing records one `rate_limited` event per address per minute rather than one per attempt.
- **Export** the log as newline-delimited JSON from the same panel to archive it beyond the retention window.

## Two-factor authentication

Users turn on two-factor authentication in **Settings → Account → Two-factor authentication**. The owner can require it for themselves or for every account there. Nothing needs configuring, but two things are worth knowing:

- **Keep the host clock right.** Codes are checked against the server's own clock with 30 seconds of tolerance either way, so a host that drifts by a minute or more rejects valid codes. Docker uses the host's clock: make sure the host runs NTP (`timedatectl` should report `System clock synchronized: yes`; Raspberry Pi OS and every major distribution do this by default). The enrolment step catches large drift straight away with a "code does not match" message.
- **Owner locked out.** If the owner loses both their authenticator and their recovery codes, reset the second factor from the host while the container is stopped, then sign in with the password and enrol again:

  ```bash
  docker compose stop opentodo
  docker compose run --rm --no-deps opentodo mfa-reset owner@example.com
  docker compose start opentodo
  ```

  The command works only on the data volume (shell access to the host is the proof of ownership), refuses to run while the server holds it, and is recorded as `mfa.reset` in the audit log. Members who are locked out are reset by the owner through `POST /api/v1/members/{id}/mfa/reset` ([docs/api.md](../api.md#two-factor-authentication)).

## Managing users

The owner sees every account in **Settings → People → Users** with its role, status and last sign-in ([docs/api.md](../api.md#user-administration)). From there the owner makes trusted people **admins** (they can invite, and deactivate, reset or delete members, but never act on the owner or other admins), **deactivates** an account (signed out everywhere at once, API tokens and pending invitations revoked, data kept, sign-in blocked until reactivated), creates a **password reset link** for someone who forgot their password (single use, 24 hours, nothing is emailed: copy it and send it yourself), **deletes** an account and its data after typing its email, or **transfers ownership** to another account after re-entering the password (you become an admin). Every user changes their own password in **Settings → Account → Password**. Nothing needs configuring and no SQLite editing is ever needed.

### Recovering owner access

Nobody can reset the owner's password through the app. If the owner forgot it, print a reset link from the host, then open it in a browser and choose a new password:

```bash
docker compose exec opentodo /opentodo reset-owner-password
# password reset link for the owner owner@example.com (valid until 2026-10-11T09:00:00Z):
#
#   https://todo.example.com/reset/otr_…
```

The command needs only the data volume: shell access to the host is the proof of ownership. It opens no port, needs no configuration and works while the server runs (or with `docker compose run --rm --no-deps opentodo reset-owner-password` while it is stopped). The link starts with `OPENTODO_BASE_URL`; pass `--base-url https://…` otherwise. It works once, any earlier owner link stops working, and using it signs the owner out everywhere. It is recorded as `password.reset_issued` in the audit log. If the owner also lost their second factor, run `mfa-reset` as described above.

## Updating

`docker compose pull && docker compose up -d` replaces the container; the new version applies migrations at startup. Orchestrators that start the new container before stopping the old one (Coolify, Docker Swarm, Kubernetes with a shared volume on one node) work too: several server processes may use the data directory at once, and the background jobs (reminder push, webhooks, backups, email polling, Trash cleanup) run in only one of them and move to the newer one when the old one exits. Maintenance commands (`restore`, `mfa-reset`, `reset-owner-password` without a running server) still need every server stopped.

**Upgrading from 0.1.0 to 0.2.0:** 0.1.0 locked the data directory exclusively, so a 0.2.0 container cannot start beside it. Plain `docker compose up -d` already stops the old container first and needs nothing special. With an orchestrator that starts the new container first, stop the old one for this one upgrade (`docker compose down && docker compose up -d`, or **Stop** then **Deploy** in Coolify); from 0.2.0 on, updates roll without stopping. If you pinned a tag such as `ghcr.io/pixari/opentodo:0.1`, change it to `0.2` (or `0.2.0`).

## Verifying the image and downloads

From 0.7.0, releases are signed and carry their build record. The image is signed with [cosign](https://docs.sigstore.dev/) without a long-lived key: the signature names the GitHub workflow and tag that built it. Check it before you deploy a new version:

```bash
cosign verify ghcr.io/pixari/opentodo:<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/pixari/opentodo/\.github/workflows/ci\.yml@refs/(tags/v|heads/main)'
```

The image also carries a software bill of materials (SBOM) and SLSA build provenance. To read them:

```bash
docker buildx imagetools inspect ghcr.io/pixari/opentodo:<version> --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/pixari/opentodo:<version> --format '{{ json .Provenance }}'
```

Every file on a GitHub release (server and `ot` binaries, the extension and agent skill zips, the site bundle) has a build provenance attestation. Verify a download with the GitHub CLI, and compare it with `SHA256SUMS`:

```bash
gh attestation verify opentodo-linux-amd64 --repo pixari/opentodo
sha256sum --check --ignore-missing SHA256SUMS
```

Before an image is published, CI starts it the way Coolify does (health check, owner setup, closed sign-up, data surviving a recreate) and scans it for known vulnerabilities; a critical one with a fixed version stops the release.

## Health

`GET /healthz` returns `{"status":"ok","version":"..."}`. The image defines a `HEALTHCHECK` that runs `/opentodo healthcheck`, which works without curl or a shell.

## Resource usage

Idle memory is around 20 MB (18 MB measured on a fresh instance); the static binary is about 23 MB with the web app embedded, and the image adds only the distroless base (about 2 MB). A Raspberry Pi 3 or any 1 vCPU / 512 MB VPS is plenty.
