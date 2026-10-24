/// <reference lib="webworker" />
// The app's service worker (OpenSpec change attachments, design D9): Workbox
// precaching and the navigation fallback, as the generated worker had, the
// reminder push handling (push-sw.js), and one route of its own: the share
// sheet's POST /share with files, handed to the page through IndexedDB.
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { entryFromForm, entrySize, putInboxEntry, SHARE_MAX_BYTES, shareRequestAllowed } from './lib/shareInbox'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] }

// Reminder push, notification actions and the shown set (OpenSpec `reminders`).
importScripts('push-sw.js')

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Nothing under /api/ (in particular the live event stream) or /healthz is ever
// answered by the app shell or stored in a cache.
// A task page (/t/, task-pages D8) is its own document from the server, never the app.
// The app shell is precached with the headers it had at install time, but the
// server's Content-Security-Policy follows the owner's settings (the on-device
// assistant's provider origins, assistant-on-device D4). Navigations get the
// latest policy the server sent, refreshed in the background on every one.
const shell = createHandlerBoundToURL('index.html')
const POLICY_CACHE = 'opentodo-policy'
const POLICY_KEY = '/__policy'

async function refreshPolicy(): Promise<void> {
  try {
    const res = await fetch('/', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
    const policy = res.ok ? res.headers.get('Content-Security-Policy') : null
    if (policy) await (await caches.open(POLICY_CACHE)).put(POLICY_KEY, new Response(policy))
  } catch {
    // Offline: the last policy stays.
  }
}

registerRoute(new NavigationRoute(async (opts) => {
  const res = await shell(opts)
  const refresh = refreshPolicy()
  if ('waitUntil' in opts.event) (opts.event as ExtendableEvent).waitUntil(refresh)
  const stored = await (await caches.open(POLICY_CACHE)).match(POLICY_KEY).catch(() => undefined)
  const policy = stored ? await stored.text() : ''
  if (!policy) return res
  const headers = new Headers(res.headers)
  headers.set('Content-Security-Policy', policy)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}, { denylist: [/^\/api\//, /^\/healthz/, /^\/t\//] }))

registerRoute(
  ({ url, request }) => url.pathname === '/share' && request.method === 'POST',
  async ({ request }) => {
    // Only the share sheet or the app itself may hand over a share, and only up
    // to a size cap; anything else opens the app without storing a thing.
    if (!shareRequestAllowed(request.headers)) return Response.redirect('/', 303)
    const id = crypto.randomUUID()
    const entry = entryFromForm(await request.formData(), id)
    if (entrySize(entry) > SHARE_MAX_BYTES) return Response.redirect('/', 303)
    await putInboxEntry(entry)
    return Response.redirect(`/share?inbox=${encodeURIComponent(id)}`, 303)
  },
  'POST',
)
