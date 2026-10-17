#!/usr/bin/env node
// Checks the Coolify one-click service template (OpenSpec `coolify-template`).
//
//   node scripts/coolify-template-check.mjs           static checks, plus `docker compose config` when Docker is available
//   node scripts/coolify-template-check.mjs --smoke   also starts the image the way Coolify does and probes it
//   node scripts/coolify-template-check.mjs --smoke --image opentodo:ci
//                                                    the same smoke test with a locally built image in place of
//                                                    the template's (CI tests the image it is about to publish)
//
// Static checks: Coolify's header fields and their order, one `opentodo` service with no build/ports/
// container_name/restart, the stable image tag (deploy/deploy.json), SERVICE_URL_OPENTODO_8080 and
// OPENTODO_BASE_URL from SERVICE_URL_OPENTODO, every OPENTODO_* optional and read by internal/config, the /data
// volume, the `/opentodo healthcheck` health check, the logo, and identical upstream copies
// (deploy/coolify/upstream/). No dependencies: the template is parsed by the shared strict YAML subset parser (scripts/deploy/yaml.mjs).

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkImage, configVariables, latestRelease, loadFacts, readText as read, ROOT } from './deploy/common.mjs'
import { parseYaml as parseSubset, splitComment, YAML_COMPOSE } from './deploy/yaml.mjs'

export const PATHS = {
  template: 'deploy/coolify/opentodo.yaml',
  logo: 'deploy/coolify/opentodo.svg',
  upstreamTemplate: 'deploy/coolify/upstream/templates/compose/opentodo.yaml',
  upstreamLogo: 'deploy/coolify/upstream/public/svgs/opentodo.svg',
  docsLogo: 'deploy/coolify/upstream/coolify-docs/public/images/services/opentodo-logo.svg',
  changelog: 'CHANGELOG.md',
  configDir: 'internal/config',
}
const HEADER_ORDER = ['documentation', 'slogan', 'category', 'tags', 'logo', 'port']
const SERVICE = 'opentodo'
const PORT = '8080'
// Coolify's PR quality check (.github/workflows/pr-quality.yaml, max-added-comments) closes PRs adding more.
const MAX_COMMENT_LINES = 10

// ---- strict YAML subset (scripts/deploy/yaml.mjs, profile YAML_COMPOSE) ---------------------------------

/** Parses the YAML subset of Coolify templates: string scalars, no maps inside sequences, no block scalars. */
export const parseYaml = (text) => parseSubset(text, YAML_COMPOSE)
export { splitComment }

/** The `# key: value` header lines, in order (the same regex as Coolify's Generate\Services). */
export function parseHeader(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^#(.*?):(.*)$/.exec(line)
    if (m) out.push([m[1].trim(), m[2].trim()])
  }
  return out
}

// ---- inputs --------------------------------------------------------------------------------------------

/** The newest released version in CHANGELOG.md (`## [X.Y.Z] - date`). */
// Shared with every platform template (scripts/deploy/common.mjs, OpenSpec change unraid-template).
export { configVariables, latestRelease }

export function loadInputs(root = ROOT) {
  return {
    template: read(PATHS.template, root),
    logo: read(PATHS.logo, root),
    upstreamTemplate: read(PATHS.upstreamTemplate, root),
    upstreamLogo: read(PATHS.upstreamLogo, root),
    docsLogo: read(PATHS.docsLogo, root),
    changelog: read(PATHS.changelog, root),
    configVars: configVariables(root),
    facts: loadFacts(root),
  }
}

// ---- checks --------------------------------------------------------------------------------------------

/** Returns a list of problems; empty means the template follows the conventions. */
export function checkTemplate(input) {
  const errors = []
  const err = (msg) => errors.push(msg)
  const { template } = input
  if (!template) return [`${PATHS.template} is missing`]
  if (!template.endsWith('\n')) err('template must end with a newline (Coolify PR check: require-final-newline)')

  // Header
  const header = parseHeader(template)
  const keys = header.map(([k]) => k)
  if (keys.join(',') !== HEADER_ORDER.join(',')) {
    err(`header fields must be exactly ${HEADER_ORDER.join(', ')} in that order, got: ${keys.join(', ') || 'none'}`)
  }
  const h = Object.fromEntries(header)
  const lines = template.split('\n')
  if (!lines.slice(0, HEADER_ORDER.length).every((l) => l.startsWith('# '))) {
    err('the header comments must be the first lines of the file')
  }
  if (h.documentation && !/^https:\/\/\S+$/.test(h.documentation)) err('documentation must be an https URL')
  if (h.documentation?.includes('?')) err('documentation must not contain a query (Coolify appends ?utm_source=coolify.io)')
  if (h.slogan && (h.slogan.length < 10 || h.slogan.length > 120)) err('slogan must be 10-120 characters')
  if (h.category && !/^[a-z]+$/.test(h.category)) err('category must be one lowercase word')
  if (h.tags && !/^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(h.tags)) err('tags must be comma-separated lowercase words without spaces')
  if (h.logo && h.logo !== 'svgs/opentodo.svg') err('logo must be svgs/opentodo.svg')
  if (h.port && h.port !== PORT) err(`port must be ${PORT}`)

  // Comments (Coolify's PR check limits added comment lines)
  const commentLines = lines.filter((l) => splitComment(l)[1] !== null).length
  if (commentLines > MAX_COMMENT_LINES) err(`at most ${MAX_COMMENT_LINES} comment lines (Coolify PR check), got ${commentLines}`)

  let doc
  try {
    doc = parseYaml(template)
  } catch (e) {
    err(`template is not in the supported YAML subset: ${e.message}`)
    return errors
  }
  const topKeys = Object.keys(doc)
  if (topKeys.some((k) => k !== 'services' && k !== 'volumes')) err(`unexpected top-level keys: ${topKeys.join(', ')}`)
  const services = doc.services ?? {}
  if (Object.keys(services).join(',') !== SERVICE) err(`exactly one service named "${SERVICE}" expected`)
  const svc = services[SERVICE]
  if (!svc || typeof svc !== 'object') return errors

  for (const k of ['build', 'container_name', 'ports', 'restart', 'network_mode', 'privileged']) {
    if (Object.hasOwn(svc, k)) err(`service must not set "${k}" (Coolify templates use a published image and Coolify-managed ${k === 'build' ? 'builds' : k})`)
  }

  // Image
  // The stable tag every release moves (OpenSpec stable-image-tag), the same rule as every platform template.
  for (const e of checkImage(svc.image, input.facts ?? loadFacts())) err(e)

  // Environment
  const env = svc.environment
  if (!Array.isArray(env)) {
    err('environment must be a list of NAME or NAME=value entries')
  } else {
    const names = new Map()
    for (const entry of env) {
      if (typeof entry !== 'string') { err(`environment entry is not a string: ${JSON.stringify(entry)}`); continue }
      const eq = entry.indexOf('=')
      const name = eq < 0 ? entry : entry.slice(0, eq)
      if (names.has(name)) err(`environment variable ${name} is listed twice`)
      names.set(name, eq < 0 ? null : entry.slice(eq + 1))
      if (/\$\{[^}]*:?\?/.test(entry)) err(`${name} must not be required (no \${VAR:?}); OpenTodo needs no variables`)
    }
    if (!names.has(`SERVICE_URL_OPENTODO_${PORT}`) || names.get(`SERVICE_URL_OPENTODO_${PORT}`) !== null) {
      err(`environment must declare SERVICE_URL_OPENTODO_${PORT} (no value) so Coolify routes the domain to port ${PORT}`)
    }
    for (const n of names.keys()) {
      if (/^SERVICE_FQDN_/.test(n)) err(`use SERVICE_URL_* instead of the older ${n}`)
    }
    const base = names.get('OPENTODO_BASE_URL')
    if (!base || !/\$\{SERVICE_URL_OPENTODO\}/.test(base)) {
      err('OPENTODO_BASE_URL must come from ${SERVICE_URL_OPENTODO} (the URL without a port)')
    }
    for (const [n, v] of names) {
      if (!n.startsWith('OPENTODO_')) continue
      if (!input.configVars.has(n)) err(`${n} is not read by internal/config`)
      // The one variable Coolify fills itself (owner-bootstrap): a generated secret guards the first account.
      if (n === 'OPENTODO_SETUP_TOKEN') {
        if (v !== '${SERVICE_PASSWORD_SETUP}') err('OPENTODO_SETUP_TOKEN must be ${SERVICE_PASSWORD_SETUP} so every deploy gets a generated setup token')
        continue
      }
      const own = new RegExp(`^\\$\\{${n}:-`)
      if (v === null || !own.test(v)) err(`${n} must be written as ${n}=\${${n}:-default} so it is optional and shown in Coolify's UI`)
    }
    if (!names.has('OPENTODO_SETUP_TOKEN')) err('environment must set OPENTODO_SETUP_TOKEN=${SERVICE_PASSWORD_SETUP} so a fresh public deploy cannot be claimed by a stranger')
    for (const want of ['OPENTODO_ALLOW_SIGNUP', 'OPENTODO_TRUSTED_PROXIES']) {
      if (!names.has(want)) err(`environment must reference ${want} (values set in Coolify's UI reach a Compose service only when referenced)`)
    }
    if (names.get('OPENTODO_ALLOW_SIGNUP') && !/:-false\}$/.test(names.get('OPENTODO_ALLOW_SIGNUP'))) {
      err('OPENTODO_ALLOW_SIGNUP must default to false')
    }
  }

  // Volume
  const vols = svc.volumes
  if (!Array.isArray(vols) || !vols.includes('opentodo-data:/data')) err('volumes must include the named volume opentodo-data:/data')
  if (Array.isArray(vols) && vols.some((v) => /^[./~]/.test(v))) err('use named volumes, not bind mounts')

  // Health check
  const hc = svc.healthcheck
  if (!hc) {
    err('a healthcheck is required')
  } else {
    if (JSON.stringify(hc.test) !== JSON.stringify(['CMD', '/opentodo', 'healthcheck'])) {
      err('healthcheck.test must be ["CMD", "/opentodo", "healthcheck"] (the image has no shell or curl)')
    }
    for (const k of ['interval', 'timeout', 'retries']) if (hc[k] === undefined) err(`healthcheck.${k} is required`)
  }

  // Logo and upstream copies
  if (!input.logo) err(`${PATHS.logo} is missing`)
  else errors.push(...checkLogo(input.logo))
  if (input.upstreamTemplate !== template) err(`${PATHS.upstreamTemplate} must be identical to ${PATHS.template}`)
  if (input.upstreamLogo !== input.logo) err(`${PATHS.upstreamLogo} must be identical to ${PATHS.logo}`)
  if (input.docsLogo !== input.logo) err(`${PATHS.docsLogo} must be identical to ${PATHS.logo}`)
  return errors
}

export function checkLogo(svg) {
  const errors = []
  if (Buffer.byteLength(svg) > 4096) errors.push('logo must be under 4 KB')
  if (!/^<svg[\s>]/.test(svg.trim())) errors.push('logo must be a bare <svg> element')
  const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg)
  if (!vb || vb[1] !== vb[2]) errors.push('logo must have a square viewBox="0 0 N N"')
  if (/<script|<foreignObject|\son\w+=|href="(?!#)|url\((?!#)|<image/i.test(svg)) errors.push('logo must not contain scripts, external references or embedded images')
  if (!/<title>[^<]+<\/title>/.test(svg)) errors.push('logo must have a <title>')
  if (!svg.endsWith('\n')) errors.push('logo must end with a newline')
  return errors
}

// ---- Docker ------------------------------------------------------------------------------------------

function dockerAvailable() {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
    spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
}

// Stands in for the secret Coolify generates for ${SERVICE_PASSWORD_SETUP}.
const SMOKE_SETUP_TOKEN = 'smoke-setup-token-0123456789'

// Values Coolify writes into the service's .env for a domain of https://todo.example.test.
function coolifyEnv(extra = {}) {
  return {
    ...process.env,
    SERVICE_URL_OPENTODO: 'https://todo.example.test',
    SERVICE_FQDN_OPENTODO: 'todo.example.test',
    SERVICE_URL_OPENTODO_8080: 'https://todo.example.test:8080',
    SERVICE_FQDN_OPENTODO_8080: 'todo.example.test:8080',
    SERVICE_PASSWORD_SETUP: SMOKE_SETUP_TOKEN,
    ...extra,
  }
}

// Coolify declares the named volumes a template mounts (coolify-docs: "Coolify adds declarations for the named
// volumes referenced by the services"); plain docker compose needs them spelled out.
const VOLUMES_OVERRIDE = 'volumes:\n  opentodo-data:\n'

function composeConfigEnv(file, extra) {
  const dir = mkdtempSync(join(tmpdir(), 'opentodo-coolify-'))
  try {
    const override = join(dir, 'override.yaml')
    writeFileSync(override, VOLUMES_OVERRIDE)
    const out = execFileSync('docker', ['compose', '-f', file, '-f', override, 'config', '--format', 'json'], { env: coolifyEnv(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(out).services[SERVICE].environment
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function composeConfigCheck(file = join(ROOT, PATHS.template)) {
  const errors = []
  const env = composeConfigEnv(file, {})
  if (env.OPENTODO_BASE_URL !== 'https://todo.example.test') errors.push(`docker compose config: OPENTODO_BASE_URL resolved to ${env.OPENTODO_BASE_URL}, want the service URL`)
  if (env.OPENTODO_ALLOW_SIGNUP !== 'false') errors.push('docker compose config: OPENTODO_ALLOW_SIGNUP must resolve to false')
  const over = composeConfigEnv(file, { OPENTODO_BASE_URL: 'https://second.example.test', OPENTODO_TRUSTED_PROXIES: 'cloudflare' })
  if (over.OPENTODO_BASE_URL !== 'https://second.example.test') errors.push('docker compose config: an operator-set OPENTODO_BASE_URL must win over the service URL')
  if (over.OPENTODO_TRUSTED_PROXIES !== 'cloudflare') errors.push('docker compose config: OPENTODO_TRUSTED_PROXIES set in the environment must reach the container')
  return errors
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { last = e }
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}

/**
 * Starts the template with docker compose the way Coolify does (named volume, health check, `up -d --force-recreate`),
 * with a host port added by an override file, and checks: healthy, /healthz, owner setup on first visit, closed
 * sign-up afterwards, the https base URL (passkeys, Secure cookie), and data surviving a recreate.
 */
/** The compose override the smoke test adds: a loopback host port, the named volume and, optionally, another image. */
export function smokeOverride(port, image) {
  return `services:\n  ${SERVICE}:\n${image ? `    image: ${JSON.stringify(image)}\n    pull_policy: never\n` : ''}    ports:\n      - "127.0.0.1:${port}:8080"\n${VOLUMES_OVERRIDE}`
}

export async function smoke(file = join(ROOT, PATHS.template), { image } = {}) {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'opentodo-coolify-'))
  const override = join(dir, 'override.yaml')
  writeFileSync(override, smokeOverride(port, image))
  const project = `opentodo-coolify-check-${process.pid}`
  const env = coolifyEnv({ OPENTODO_TRUSTED_PROXIES: 'cloudflare' })
  const compose = (...args) => execFileSync('docker', ['compose', '-p', project, '-f', file, '-f', override, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const base = `http://127.0.0.1:${port}`
  const origin = 'https://todo.example.test'
  const steps = []
  const ok = (msg) => { steps.push(msg); console.log(`  ok  ${msg}`) }
  try {
    compose('up', '-d', '--force-recreate', ...(image ? [] : ['--quiet-pull']))
    const id = compose('ps', '-q', SERVICE).trim()
    const t0 = Date.now()
    await waitFor(() => execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id], { encoding: 'utf8' }).trim() === 'healthy', 60000, 'the container to become healthy')
    ok(`container healthy after ${((Date.now() - t0) / 1000).toFixed(1)} s (template health check: /opentodo healthcheck)`)
    const cenv = JSON.parse(execFileSync('docker', ['inspect', '-f', '{{json .Config.Env}}', id], { encoding: 'utf8' }))
    for (const want of ['OPENTODO_BASE_URL=https://todo.example.test', 'OPENTODO_ALLOW_SIGNUP=false', 'OPENTODO_TRUSTED_PROXIES=cloudflare', `OPENTODO_SETUP_TOKEN=${SMOKE_SETUP_TOKEN}`]) {
      if (!cenv.includes(want)) throw new Error(`container environment lacks ${want}`)
    }
    ok('container environment: OPENTODO_BASE_URL from the service URL, sign-up closed, OPENTODO_TRUSTED_PROXIES and the generated setup token passed through')
    const health = await (await fetch(`${base}/healthz`)).json()
    if (health.status !== 'ok') throw new Error(`/healthz: ${JSON.stringify(health)}`)
    ok(`/healthz ok (version ${health.version})`)
    let st = await (await fetch(`${base}/api/v1/auth/status`)).json()
    if (!st.setupRequired) throw new Error('fresh deploy does not report setupRequired')
    if (!st.passkeysAvailable || st.passkeyDomain !== 'todo.example.test') throw new Error(`passkeys not bound to the domain: ${JSON.stringify({ a: st.passkeysAvailable, d: st.passkeyDomain })}`)
    ok('fresh deploy: setup required, passkeys available for todo.example.test')
    const reg = (email, setupToken) => fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, name: 'Smoke', password: 'correct horse battery staple', ...(setupToken ? { setupToken } : {}) }) })
    // Images older than owner-bootstrap ignore the token: check the guard only where the server announces it.
    if (st.setupTokenRequired) {
      const r0 = await reg('stranger@example.test')
      const body0 = await r0.json().catch(() => ({}))
      if (r0.status !== 403 || body0?.error?.code !== 'setup_token_invalid') throw new Error(`registration without the setup token: HTTP ${r0.status} ${JSON.stringify(body0)}`)
      ok('a stranger without the setup token cannot create the owner (setup_token_invalid)')
    } else {
      ok('image predates the setup token (no setupTokenRequired in auth status); guard not checked')
    }
    const r1 = await reg('owner@example.test', SMOKE_SETUP_TOKEN)
    if (r1.status !== 200 && r1.status !== 201) throw new Error(`owner registration: HTTP ${r1.status} ${await r1.text()}`)
    const cookie = r1.headers.get('set-cookie') ?? ''
    if (!/;\s*Secure/i.test(cookie)) throw new Error(`session cookie is not Secure: ${cookie}`)
    ok('the operator with the setup token becomes the owner; session cookie is Secure')
    const r2 = await reg('someone@example.test')
    const body2 = await r2.json().catch(() => ({}))
    if (r2.status !== 403 || body2?.error?.code !== 'signup_closed') throw new Error(`second registration: HTTP ${r2.status} ${JSON.stringify(body2)}`)
    ok('second visitor is refused (signup_closed)')
    compose('up', '-d', '--force-recreate')
    const id2 = compose('ps', '-q', SERVICE).trim()
    if (id2 === id) throw new Error('container was not recreated')
    await waitFor(() => execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id2], { encoding: 'utf8' }).trim() === 'healthy', 60000, 'the recreated container to become healthy')
    st = await waitFor(async () => (await fetch(`${base}/api/v1/auth/status`)).json(), 20000, 'auth status after recreate')
    if (st.setupRequired) throw new Error('data lost on recreate: setup is required again')
    ok('recreated like a Coolify redeploy: owner still exists (data on the opentodo-data volume)')
    return steps
  } finally {
    spawnSync('docker', ['compose', '-p', project, '-f', file, '-f', override, 'down', '-v'], { env, stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- main --------------------------------------------------------------------------------------------

async function main() {
  const wantSmoke = process.argv.includes('--smoke')
  const imageArg = process.argv.indexOf('--image')
  const localImage = imageArg > 0 ? process.argv[imageArg + 1] : undefined
  if (imageArg > 0 && !localImage) { console.error('--image needs an image reference'); process.exit(1) }
  const errors = checkTemplate(loadInputs())
  if (errors.length) {
    console.error(`Coolify template check failed (${PATHS.template}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log('Coolify template: conventions, release tag, variables, health check, volume, logo and upstream copies ok')
  if (!dockerAvailable()) {
    if (wantSmoke) { console.error('--smoke needs Docker with the compose plugin'); process.exit(1) }
    console.log('Docker not available: skipped `docker compose config` and the smoke test')
    return
  }
  const cfgErrors = composeConfigCheck()
  if (cfgErrors.length) {
    for (const e of cfgErrors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log('docker compose config: valid; base URL from the service URL, operator override and pass-through ok')
  if (wantSmoke && localImage) {
    if (spawnSync('docker', ['image', 'inspect', localImage], { stdio: 'ignore' }).status !== 0) {
      console.error(`--image ${localImage}: no such local image (build it first)`)
      process.exit(1)
    }
    console.log(`Smoke test (local image ${localImage} in place of the template's):`)
    await smoke(undefined, { image: localImage })
  } else if (wantSmoke) {
    // On a release commit the template already names the new line before CI has published its image.
    const image = parseYaml(readFileSync(join(ROOT, PATHS.template), 'utf8')).services[SERVICE].image
    if (spawnSync('docker', ['manifest', 'inspect', image], { stdio: 'ignore' }).status !== 0 &&
        spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
      console.log(`Smoke test skipped: ${image} is not published (yet)`)
      return
    }
    console.log(`Smoke test (${image}):`)
    await smoke()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
