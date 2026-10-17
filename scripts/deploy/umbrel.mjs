// Umbrel App Store package (deploy/umbrel/), OpenSpec change platform-catalogs. Umbrel lists apps
// from getumbrel/umbrel-apps: a pull request adds the folder opentodo/ with umbrel-app.yml,
// docker-compose.yml and data/.gitkeep, which deploy/umbrel/upstream/opentodo/ holds file for file.
// Umbrel requires a released version pinned by digest (policy 'release-digest'), and users get an
// update only when the manifest `version` changes, so every release needs a pull request there
// (deploy/umbrel/README.md). The rules come from that repository's .agents/skills/umbrel-package-app
// and .tools/lint-apps.mjs.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkShared, listFiles, readText, ROOT } from './common.mjs'
import { parseYaml, YAML_COMPOSE, YAML_UMBREL_MANIFEST } from './yaml.mjs'

export const MANIFEST = 'deploy/umbrel/umbrel-app.yml'
export const COMPOSE = 'deploy/umbrel/docker-compose.yml'
export const UPSTREAM = 'deploy/umbrel/upstream/opentodo'
export const PR = 'deploy/umbrel/upstream/PR.md'
export const PORT = '8418' // the app_proxy port, unique across the Umbrel App Store (checked by its linter)
const APP_ID = 'opentodo'
const SERVICE = 'web'
const CATEGORIES = ['ai', 'automation', 'bitcoin', 'crypto', 'developer', 'files', 'finance', 'media', 'networking', 'social']
const FIELD_ORDER = [
  'manifestVersion', 'id', 'storage', 'environment', 'category', 'name', 'version', 'tagline', 'description', 'releaseNotes',
  'developer', 'website', 'dependencies', 'repo', 'support',
  'port', 'gallery', 'path',
  'defaultUsername', 'defaultPassword',
  'submitter', 'submission',
]
const NOTE_MAX = 300 // umbreld truncates longer environment notes
// Routes clients reach without Umbrel's login cookie, and what each is for. Every one must be a
// route OpenTodo serves (internal/httpapi) or a file of the web app (web/public, Vite's assets/).
const WHITELIST = {
  '/api/*': 'API tokens, the browser extension, sync clients',
  '/dav': 'CalDAV',
  '/dav/*': 'CalDAV',
  '/.well-known/caldav': 'CalDAV discovery',
  '/.well-known/caldav/*': 'CalDAV discovery',
  '/feeds/*': 'calendar feeds',
  '/mcp': 'MCP clients',
  '/public/*': 'public list links',
  '/assets/*': 'the web app files a public list page loads',
  '/appearance.js': 'the theme script a public list page loads',
}
const BLACKLIST = ['/api/v1/auth/register']

/**
 * Parses an Umbrel manifest with the shared strict YAML subset parser (scripts/deploy/yaml.mjs,
 * profile YAML_UMBREL_MANIFEST): string scalars, lists of maps, and folded `>-` text only
 * (single newlines fold to spaces, each blank line is a newline). Throws with a line number on
 * anything else.
 */
export const parseManifest = (text) => parseYaml(text, YAML_UMBREL_MANIFEST)

/** The top-level keys of a YAML text, in order. */
const topKeys = (text) => [...text.matchAll(/^([A-Za-z][\w-]*):/gm)].map((m) => m[1])

/** Every route pattern registered in internal/httpapi (tests excluded), without the method. */
export function routes(root = ROOT) {
  const dir = join(root, 'internal/httpapi')
  const out = new Set()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\.(?:Handle(?:Func)?|handle)\("(?:[A-Z]+ )?(\/[^"]*)"/g)) out.add(m[1])
  }
  return out
}

/** Whether a whitelist pattern names something OpenTodo serves. */
function servesPattern(pattern, served, root) {
  if (pattern === '/assets/*') return true // Vite's build output (web/vite.config.ts), always present
  if (!pattern.endsWith('*')) {
    if (served.has(pattern)) return true
    return existsSync(join(root, 'web/public', pattern.slice(1)))
  }
  const prefix = pattern.slice(0, -1) // "/api/" from "/api/*"
  return [...served].some((r) => r.startsWith(prefix) && r.length > prefix.length) || served.has(prefix)
}

export function checkManifest(text, ctx) {
  if (text === null) return { errors: [`${MANIFEST} is missing`], manifest: null }
  const errors = []
  if (!text.endsWith('\n')) errors.push('umbrel-app.yml must end with a newline')
  let m
  try {
    m = parseManifest(text)
  } catch (e) {
    return { errors: [...errors, `umbrel-app.yml is not in the supported YAML subset: ${e.message}`], manifest: null }
  }
  const keys = topKeys(text)
  const want = FIELD_ORDER.filter((k) => keys.includes(k))
  if (keys.join(',') !== want.join(',')) errors.push(`umbrel-app.yml fields must be in Umbrel's order: ${FIELD_ORDER.join(', ')}`)
  for (const k of FIELD_ORDER) if (!Object.hasOwn(m, k)) errors.push(`umbrel-app.yml needs ${k}`)
  for (const k of Object.keys(m)) if (!FIELD_ORDER.includes(k)) errors.push(`umbrel-app.yml: ${k} is not used by this package${k === 'icon' ? ' (the official App Store hosts icons itself)' : ''}`)

  if (m.manifestVersion !== '1') errors.push('manifestVersion must be 1 (the package needs no newer app-framework feature)')
  if (m.id !== APP_ID) errors.push(`id must be ${APP_ID}, the folder name`)
  if (m.storage?.dataRoot !== 'data' || Object.keys(m.storage ?? {}).length !== 1) errors.push('storage must be exactly { dataRoot: data }, so users can move the data folder')
  if (!CATEGORIES.includes(m.category)) errors.push(`category must be one of ${CATEGORIES.join(', ')}`)
  if (m.name !== ctx.facts.name) errors.push(`name must be ${ctx.facts.name}`)
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) errors.push('version must be the released version, such as 0.6.1')
  if (typeof m.tagline !== 'string' || !m.tagline || m.tagline.length > 60) errors.push('tagline must be a short line (60 characters at most)')
  if (typeof m.description !== 'string' || m.description.length < 100) errors.push('description must say what OpenTodo is and how the first account is created')
  else if (!/no default password/i.test(m.description)) errors.push('description must say there is no default password (the first visitor creates the owner)')
  if (typeof m.releaseNotes !== 'string') errors.push('releaseNotes must be a string ("" for the first submission)')
  if (m.website !== ctx.facts.project) errors.push(`website must be ${ctx.facts.project}`)
  if (m.repo !== ctx.facts.repository) errors.push(`repo must be ${ctx.facts.repository}`)
  if (m.support !== ctx.facts.support) errors.push(`support must be ${ctx.facts.support}`)
  if (!m.developer) errors.push('developer is required')
  if (!m.submitter) errors.push('submitter is required')
  if (!Array.isArray(m.dependencies) || m.dependencies.length) errors.push('dependencies must be [] (OpenTodo needs no other Umbrel app)')
  if (!Array.isArray(m.gallery) || m.gallery.length) errors.push('gallery must be [] (Umbrel adds the gallery images before merging)')
  if (m.port !== PORT) errors.push(`port must be ${PORT} (unique in the Umbrel App Store; change it here only after checking with its linter)`)
  if (m.path !== '') errors.push('path must be "" (OpenTodo opens at the root)')
  if (m.defaultUsername !== '' || m.defaultPassword !== '') errors.push('defaultUsername and defaultPassword must be "": the first visitor creates the owner account')
  if (!/^https:\/\/github\.com\/getumbrel\/umbrel-apps\/pull\/\d+$/.test(m.submission ?? '')) errors.push('submission must be the pull request URL in getumbrel/umbrel-apps')
  if (m.submission?.endsWith('/pull/0000') && m.releaseNotes !== '') errors.push('releaseNotes must be "" until the app is listed')

  // The essential settings are offered through umbrelOS's app settings (manifest `environment`).
  const variables = new Map()
  if (!Array.isArray(m.environment)) errors.push('environment must list the OPENTODO_* settings users may change')
  for (const e of m.environment ?? []) {
    if (typeof e !== 'object' || !e) { errors.push('environment entries must be maps'); continue }
    for (const k of Object.keys(e)) if (!['name', 'services', 'default', 'options', 'note'].includes(k)) errors.push(`environment ${e.name}: unknown key ${k}`)
    if (!/^OPENTODO_[A-Z0-9_]+$/.test(e.name ?? '')) errors.push(`environment: ${e.name} is not an OPENTODO_* variable`)
    if (variables.has(e.name)) errors.push(`environment: ${e.name} is listed twice`)
    if (JSON.stringify(e.services) !== JSON.stringify([SERVICE])) errors.push(`environment ${e.name}: services must be [${SERVICE}]`)
    if (typeof e.default !== 'string') errors.push(`environment ${e.name}: default must be a quoted string`)
    if (!e.note || e.note.length > NOTE_MAX) errors.push(`environment ${e.name}: note must be 1-${NOTE_MAX} characters (umbrelOS cuts longer ones)`)
    if (e.options !== undefined) {
      if (!Array.isArray(e.options) || new Set(e.options).size !== e.options.length) errors.push(`environment ${e.name}: options must be unique`)
      else if (!e.options.includes(e.default)) errors.push(`environment ${e.name}: the default must be one of the options`)
    }
    variables.set(e.name, { default: e.default ?? null, required: false })
  }
  return { errors, manifest: m, variables }
}

export function checkCompose(text, ctx, root = ROOT) {
  if (text === null) return { errors: [`${COMPOSE} is missing`] }
  const errors = []
  if (!text.endsWith('\n')) errors.push('docker-compose.yml must end with a newline')
  let doc
  try {
    doc = parseYaml(text, YAML_COMPOSE)
  } catch (e) {
    return { errors: [...errors, `docker-compose.yml is not in the supported YAML subset: ${e.message}`] }
  }
  if (topKeys(text).join(',') !== 'version,services') errors.push('docker-compose.yml must have exactly version and services at the top')
  if (doc.version !== '3.7') errors.push('compose version must be "3.7" like every Umbrel package')
  const services = doc.services ?? {}
  if (Object.keys(services).sort().join(',') !== ['app_proxy', SERVICE].join(',')) errors.push(`services must be app_proxy and ${SERVICE}`)

  const proxy = services.app_proxy ?? {}
  if (Object.keys(proxy).join(',') !== 'environment') errors.push('app_proxy must only set environment (umbrelOS provides the proxy)')
  const env = proxy.environment ?? {}
  if (Array.isArray(env)) errors.push('app_proxy.environment must be a map')
  if (env.APP_HOST !== `${APP_ID}_${SERVICE}_1`) errors.push(`APP_HOST must be ${APP_ID}_${SERVICE}_1`)
  if (env.APP_PORT !== String(ctx.facts.port)) errors.push(`APP_PORT must be ${ctx.facts.port}`)
  if (Object.hasOwn(env, 'PROXY_AUTH_ADD')) errors.push('PROXY_AUTH_ADD must not be set: Umbrel login stays on (owners can turn it off per app)')
  const white = (env.PROXY_AUTH_WHITELIST ?? '').split(',').filter(Boolean)
  const served = routes(root)
  for (const p of Object.keys(WHITELIST)) if (!white.includes(p)) errors.push(`PROXY_AUTH_WHITELIST must include ${p} (${WHITELIST[p]})`)
  for (const p of white) {
    if (!Object.hasOwn(WHITELIST, p)) errors.push(`PROXY_AUTH_WHITELIST: ${p} is not a route clients need without Umbrel login`)
    else if (!servesPattern(p, served, root)) errors.push(`PROXY_AUTH_WHITELIST: OpenTodo serves nothing at ${p} (internal/httpapi, web/public)`)
  }
  const black = (env.PROXY_AUTH_BLACKLIST ?? '').split(',').filter(Boolean)
  if (black.join(',') !== BLACKLIST.join(',')) errors.push(`PROXY_AUTH_BLACKLIST must be ${BLACKLIST.join(',')}, so creating an account stays behind Umbrel login`)
  for (const p of black) if (!served.has(p)) errors.push(`PROXY_AUTH_BLACKLIST: OpenTodo has no route ${p}`)

  const web = services[SERVICE] ?? {}
  const allowed = ['image', 'user', 'restart', 'stop_grace_period', 'environment', 'volumes']
  for (const k of Object.keys(web)) if (!allowed.includes(k)) errors.push(`${SERVICE}: ${k} is not allowed (${k === 'ports' ? 'app_proxy publishes the port' : k === 'networks' ? 'umbrelOS sets the network' : 'not needed on Umbrel'})`)
  if (web.user !== '1000:1000') errors.push(`${SERVICE}: user must be "1000:1000", the owner of Umbrel's app data`)
  if (web.restart !== 'on-failure') errors.push(`${SERVICE}: restart must be on-failure`)
  const vols = web.volumes ?? []
  if (vols.length !== 1 || !/^\$\{APP_DATA_DIR\}\/data:[^:]+$/.test(vols[0] ?? '')) errors.push(`${SERVICE}: the only volume must be \${APP_DATA_DIR}/data:${ctx.facts.dataDir}`)
  const variables = new Map()
  const webEnv = web.environment ?? {}
  if (Array.isArray(webEnv)) errors.push(`${SERVICE}.environment must be a map`)
  else for (const [k, v] of Object.entries(webEnv)) variables.set(k, { default: v, required: false })
  return {
    errors,
    image: web.image,
    appPort: env.APP_PORT,
    dataTarget: vols.length === 1 ? (vols[0] ?? '').split(':').at(-1) : null,
    variables,
  }
}

/** deploy/umbrel/upstream/opentodo/ is the package folder as it goes into getumbrel/umbrel-apps. */
export function checkUpstream(root = ROOT) {
  const errors = []
  const dir = join(root, UPSTREAM)
  if (!existsSync(dir)) return [`${UPSTREAM}/ is missing`]
  const want = ['data/.gitkeep', 'docker-compose.yml', 'umbrel-app.yml']
  const have = listFiles(dir).map((f) => relative(dir, f)).sort()
  if (have.join(',') !== want.join(',')) errors.push(`${UPSTREAM}/ must hold exactly ${want.join(', ')} (no icon or gallery files), got: ${have.join(', ')}`)
  if (readText(MANIFEST, root) !== readText(`${UPSTREAM}/umbrel-app.yml`, root)) errors.push(`${UPSTREAM}/umbrel-app.yml must be identical to ${MANIFEST}`)
  if (readText(COMPOSE, root) !== readText(`${UPSTREAM}/docker-compose.yml`, root)) errors.push(`${UPSTREAM}/docker-compose.yml must be identical to ${COMPOSE}`)
  const keep = readText(`${UPSTREAM}/data/.gitkeep`, root)
  if (keep !== null && keep !== '') errors.push(`${UPSTREAM}/data/.gitkeep must be empty`)
  if (readText(PR, root) === null) errors.push(`${PR} (the pull request text) is missing`)
  return errors
}

export function check(ctx, root = ROOT) {
  const man = checkManifest(readText(MANIFEST, root), ctx)
  const comp = checkCompose(readText(COMPOSE, root), ctx, root)
  const errors = [...man.errors, ...comp.errors]
  if (man.manifest && comp.image) {
    const tag = /:(\d+\.\d+\.\d+)@/.exec(comp.image)?.[1]
    if (tag && tag !== man.manifest.version) errors.push(`the manifest version ${man.manifest.version} must equal the image tag ${tag} (Umbrel offers updates when version changes)`)
  }
  if (man.manifest && comp.variables) {
    const variables = new Map([...(man.variables ?? []), ...comp.variables])
    errors.push(...checkShared({ image: comp.image, port: comp.appPort, dataTarget: comp.dataTarget, variables, policy: 'release-digest' }, ctx))
  }
  return [...errors, ...checkUpstream(root)]
}

export const summary = 'manifest fields and order, version = pinned image tag and digest, app_proxy and auth routes, 1000:1000, data path, settings and upstream copy'
