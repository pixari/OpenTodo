// Runtipi app (deploy/runtipi/), OpenSpec change platform-catalogs. Runtipi's official app store no
// longer takes new apps, so OpenTodo has its own store, the repository pixari/opentodo-runtipi
// (made from runtipi/example-appstore), whose content is deploy/runtipi/upstream/ file for file.
// The app is apps/opentodo/: config.json, a native docker-compose.yml (x-runtipi schema 2) and
// metadata/. Policy 'release': Runtipi offers an update when config.json changes, so the image
// names the release (Renovate in the store repository bumps it, see deploy/runtipi/README.md).

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkShared, latestRelease, listFiles, readText, ROOT } from './common.mjs'
import { parseYaml as parseSubset, YAML_COMPOSE } from './yaml.mjs'

export const DIR = 'deploy/runtipi'
export const UPSTREAM = 'deploy/runtipi/upstream'
export const APP_FILES = ['config.json', 'docker-compose.yml', 'metadata/description.md', 'metadata/logo.jpg']
export const STORE_FILES = [
  '.github/workflows/renovate.yml', '.github/workflows/test.yml', '.gitignore', 'LICENSE', 'README.md',
  '__tests__/apps.test.ts', 'bun.lock', 'config.js', 'package.json', 'renovate.json',
  'scripts/__tests__/update-config.test.ts', 'scripts/update-config.ts', 'tsconfig.json',
]
export const PORT = 8400
const ID = 'opentodo'
const INIT = 'opentodo-init'
const MIN_TIPI = '4.7.0' // the first Runtipi that reads a native docker-compose.yml
const CATEGORIES = ['network', 'media', 'development', 'automation', 'social', 'utilities', 'photography', 'security', 'featured', 'books', 'data', 'music', 'finance', 'gaming', 'ai']
const FIELD_TYPES = ['text', 'password', 'email', 'number', 'fqdn', 'ip', 'fqdnip', 'url', 'random', 'boolean']
const REQUIRED = ['name', 'id', 'available', 'short_desc', 'author', 'port', 'categories', 'description', 'tipi_version', 'version', 'source', 'exposable']

export function checkConfig(text, ctx, now = Date.now()) {
  if (text === null) return { errors: [`${DIR}/config.json is missing`] }
  const errors = []
  let c
  try {
    c = JSON.parse(text)
  } catch (e) {
    return { errors: [`config.json is not JSON: ${e.message}`] }
  }
  // scripts/update-config.ts rewrites the file this way; keeping it so makes Renovate's diffs small.
  if (text !== `${JSON.stringify(c, null, 2)}\n`) errors.push('config.json must be formatted as JSON.stringify(config, null, 2) plus a newline')
  for (const k of REQUIRED) if (c[k] === undefined) errors.push(`config.json needs ${k}`)
  if (c.id !== ID) errors.push(`id must be ${ID}, the folder name`)
  if (c.name !== ctx.facts.name) errors.push(`name must be ${ctx.facts.name}`)
  if (c.available !== true) errors.push('available must be true')
  if (c.exposable !== true) errors.push('exposable must be true, so OpenTodo can get a domain and https')
  if (c.dynamic_config !== true) errors.push('dynamic_config must be true (the compose file uses x-runtipi)')
  if (c.port !== PORT) errors.push(`port must be ${PORT}`)
  if (!Array.isArray(c.categories) || !c.categories.length || c.categories.some((x) => !CATEGORIES.includes(x))) errors.push(`categories must be from ${CATEGORIES.join(', ')}`)
  if (!Number.isInteger(c.tipi_version) || c.tipi_version < 1) errors.push('tipi_version must be a positive integer (raised on every change users should get)')
  if (c.source !== ctx.facts.repository) errors.push(`source must be ${ctx.facts.repository}`)
  if (c.website !== ctx.facts.project) errors.push(`website must be ${ctx.facts.project}`)
  for (const k of ['short_desc', 'description', 'author']) if (typeof c[k] !== 'string' || !c[k]) errors.push(`${k} must be a non-empty string`)
  if (JSON.stringify([...(c.supported_architectures ?? [])].sort()) !== '["amd64","arm64"]') errors.push('supported_architectures must be amd64 and arm64')
  if (c.min_tipi_version !== MIN_TIPI) errors.push(`min_tipi_version must be ${MIN_TIPI}, the first Runtipi that reads docker-compose.yml`)
  for (const k of ['created_at', 'updated_at']) {
    if (!Number.isInteger(c[k]) || c[k] >= now || new Date(c[k]).getFullYear() < 2023) errors.push(`${k} must be a past timestamp in milliseconds`)
  }
  if (c.updated_at < c.created_at) errors.push('updated_at must not be before created_at')
  if (ctx.changelog) {
    const r = latestRelease(ctx.changelog)
    const v = `${r.major}.${r.minor}.${r.patch}`
    if (c.version !== v) errors.push(`version must be ${v}, the latest release in CHANGELOG.md`)
  }
  const fields = new Map()
  for (const f of c.form_fields ?? []) {
    if (!FIELD_TYPES.includes(f.type)) errors.push(`form field ${f.env_variable}: unknown type ${f.type}`)
    if (!f.label || !f.hint) errors.push(`form field ${f.env_variable}: needs a label and a hint`)
    if (f.required !== false) errors.push(`form field ${f.env_variable}: must not be required (OpenTodo needs no settings)`)
    if (fields.has(f.env_variable)) errors.push(`form field ${f.env_variable} appears twice`)
    fields.set(f.env_variable, f)
  }
  return { errors, config: c, fields }
}

export function checkCompose(text, ctx, fields = new Map()) {
  if (text === null) return { errors: [`${DIR}/docker-compose.yml is missing`] }
  const errors = []
  if (!text.endsWith('\n')) errors.push('docker-compose.yml must end with a newline')
  let doc
  try {
    doc = parseSubset(text, YAML_COMPOSE)
  } catch (e) {
    return { errors: [...errors, `docker-compose.yml is not in the supported YAML subset: ${e.message}`] }
  }
  if (Object.keys(doc).join(',') !== 'services,x-runtipi') errors.push('docker-compose.yml must have exactly services and x-runtipi at the top')
  if (doc['x-runtipi']?.schema_version !== '2') errors.push('x-runtipi.schema_version must be 2')
  const services = doc.services ?? {}
  if (Object.keys(services).sort().join(',') !== [ID, INIT].join(',')) errors.push(`services must be ${ID} (named after the app id) and ${INIT}`)
  const app = services[ID] ?? {}
  const init = services[INIT] ?? {}
  const vol = `\${APP_DATA_DIR}/data:${ctx.facts.dataDir}`

  for (const k of Object.keys(app)) {
    if (!['image', 'restart', 'environment', 'volumes', 'depends_on', 'healthcheck', 'x-runtipi'].includes(k)) {
      errors.push(`${ID}: ${k} is not allowed (${k === 'ports' ? 'Runtipi publishes the port from config.json' : k === 'user' ? `it runs as the image's user, which ${INIT} gives the data to` : 'Runtipi sets it'})`)
    }
  }
  const xr = app['x-runtipi'] ?? {}
  if (xr.is_main !== 'true') errors.push(`${ID}: x-runtipi.is_main must be true`)
  const vols = app.volumes ?? []
  if (vols.length !== 1 || !/^\$\{APP_DATA_DIR\}\/data:[^:]+$/.test(vols[0] ?? '')) errors.push(`${ID}: the only volume must be ${vol}`)
  if (JSON.stringify(app.healthcheck?.test) !== JSON.stringify(['CMD', ...ctx.facts.healthcheck])) errors.push(`${ID}: the health check must be ["CMD", ${ctx.facts.healthcheck.map((x) => JSON.stringify(x)).join(', ')}]`)
  if (app.depends_on?.[INIT]?.condition !== 'service_completed_successfully') errors.push(`${ID} must wait for ${INIT} (depends_on condition service_completed_successfully)`)
  if (app.restart !== 'unless-stopped') errors.push(`${ID}: restart must be unless-stopped`)

  // Runtipi creates the data folder owned by root and only makes it writable after the first
  // start, while the image runs as 65532: the init service hands the folder over first.
  const [uid] = ctx.facts.user.split(':')
  if (!/^busybox:\d+\.\d+\.\d+$/.test(init.image ?? '')) errors.push(`${INIT}: image must be busybox:<x.y.z> (a release tag Renovate can follow)`)
  if (JSON.stringify(init.command) !== JSON.stringify(['chown', '-R', ctx.facts.user, ctx.facts.dataDir])) errors.push(`${INIT}: command must be ["chown", "-R", "${ctx.facts.user}", "${ctx.facts.dataDir}"] (the image runs as ${uid})`)
  if (init.restart !== 'no') errors.push(`${INIT}: restart must be "no" (Runtipi would otherwise restart it after it finishes)`)
  if (JSON.stringify(init.volumes) !== JSON.stringify([vol])) errors.push(`${INIT}: volumes must be [${vol}]`)
  for (const k of Object.keys(init)) if (!['image', 'command', 'restart', 'volumes'].includes(k)) errors.push(`${INIT}: ${k} is not needed`)

  const variables = new Map()
  const env = app.environment ?? {}
  if (Array.isArray(env)) errors.push(`${ID}.environment must be a map`)
  else {
    for (const [name, value] of Object.entries(env)) {
      const m = new RegExp(`^\\$\\{${name}:-(.*)\\}$`).exec(value ?? '')
      if (!m) { errors.push(`${ID}: ${name} must be \${${name}:-<default>}, filled from its form field`); continue }
      const field = fields.get(name)
      if (!field) errors.push(`${ID}: ${name} has no form field in config.json`)
      else if (field.default !== undefined && String(field.default) !== m[1]) errors.push(`form field ${name}: default ${field.default} differs from the compose default ${m[1]}`)
      variables.set(name, { default: m[1], required: false })
    }
  }
  for (const name of fields.keys()) if (!variables.has(name)) errors.push(`form field ${name} is not used in docker-compose.yml`)
  return { errors, image: app.image, port: xr.internal_port, dataTarget: vols.length === 1 ? vols[0].split(':').at(-1) : null, variables, busybox: init.image }
}

/** Width and height of a baseline or progressive JPEG, from its first SOF marker. */
export function jpegSize(buf) {
  if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

/** The store repository: its own files, and identical copies of the app. */
export function checkUpstream(root = ROOT, compose = null) {
  const errors = []
  const up = join(root, UPSTREAM)
  if (!existsSync(up)) return [`${UPSTREAM}/ is missing`]
  const want = [...STORE_FILES, ...APP_FILES.map((f) => `apps/${ID}/${f}`)].sort()
  const have = listFiles(up).map((f) => relative(up, f)).filter((f) => !f.startsWith('node_modules/')).sort()
  for (const f of want) if (!have.includes(f)) errors.push(`${UPSTREAM}/${f} is missing`)
  for (const f of have) if (!want.includes(f)) errors.push(`${UPSTREAM}/${f} is not part of the store`)
  for (const f of APP_FILES) {
    const a = join(root, DIR, f)
    const b = join(up, 'apps', ID, f)
    if (existsSync(a) && existsSync(b) && !readFileSync(a).equals(readFileSync(b))) errors.push(`${UPSTREAM}/apps/${ID}/${f} must be identical to ${DIR}/${f}`)
  }
  let renovate
  try {
    renovate = JSON.parse(readText(`${UPSTREAM}/renovate.json`, root) ?? '')
  } catch {
    return [...errors, `${UPSTREAM}/renovate.json is not JSON`]
  }
  // Renovate must find both images, and run update-config.ts so config.json follows.
  const manager = renovate.customManagers?.find((m) => m.customType === 'regex')
  const pattern = manager?.managerFilePatterns?.[0]?.replace(/^\/|\/$/g, '')
  if (!pattern || !new RegExp(pattern).test(`apps/${ID}/docker-compose.yml`)) errors.push('renovate.json: the regex manager must match apps/<app>/docker-compose.yml')
  if (compose && manager?.matchStrings?.[0]) {
    const found = [...compose.matchAll(new RegExp(manager.matchStrings[0], 'g'))].map((m) => `${m.groups.depName}:${m.groups.currentValue}`)
    const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1])
    if (found.sort().join(',') !== images.sort().join(',')) errors.push(`renovate.json: matchStrings finds ${found.join(', ') || 'nothing'}, the compose file names ${images.join(', ')}`)
  }
  const cmds = renovate.postUpgradeTasks?.commands ?? []
  if (!cmds.some((c) => c.startsWith('bun ./scripts/update-config.ts {{packageFile}} {{newVersion}} {{depName}}'))) errors.push('renovate.json: postUpgradeTasks must run scripts/update-config.ts with the package file, new version and image')
  const allowed = readText(`${UPSTREAM}/config.js`, root) ?? ''
  if (!allowed.includes('update-config')) errors.push(`${UPSTREAM}/config.js must allow the update-config.ts command (self-hosted Renovate's allowedCommands)`)
  return errors
}

export function check(ctx, root = ROOT, now = Date.now()) {
  const cfg = checkConfig(readText(`${DIR}/config.json`, root), ctx, now)
  const composeText = readText(`${DIR}/docker-compose.yml`, root)
  const comp = checkCompose(composeText, ctx, cfg.fields)
  const errors = [...cfg.errors, ...comp.errors]
  if (cfg.config && comp.image && !(comp.image.split(':')[1] ?? '').includes(cfg.config.version)) {
    errors.push(`the image tag must contain the config.json version ${cfg.config.version} (Runtipi's store test)`)
  }
  if (comp.variables) errors.push(...checkShared({ image: comp.image, port: comp.port, dataTarget: comp.dataTarget, variables: comp.variables, policy: 'release' }, ctx))
  const desc = readText(`${DIR}/metadata/description.md`, root)
  if (!desc?.startsWith('# OpenTodo\n')) errors.push(`${DIR}/metadata/description.md must start with "# OpenTodo"`)
  const logo = existsSync(join(root, DIR, 'metadata/logo.jpg')) ? readFileSync(join(root, DIR, 'metadata/logo.jpg')) : null
  const size = jpegSize(logo)
  if (!size) errors.push(`${DIR}/metadata/logo.jpg must be a JPEG`)
  else if (size.width !== size.height || size.width < 256) errors.push(`${DIR}/metadata/logo.jpg must be square, at least 256 px (got ${size.width}x${size.height})`)
  return [...errors, ...checkUpstream(root, composeText)]
}

export const summary = 'config.json fields and dates, release tag = version, x-runtipi, init chown, health check, form fields, logo and store copy'
