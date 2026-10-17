// Dokploy template (deploy/dokploy/), OpenSpec change platform-catalogs. Dokploy reads a
// template from <base URL>/meta.json (the list) and <base URL>/blueprints/<id>/{docker-compose.yml,
// template.toml,<logo>}. deploy/dokploy/ is laid out that way, so its raw GitHub URL works as a
// self-hosted base URL, and deploy/dokploy/upstream/ holds byte-identical copies at the paths they
// take in Dokploy/templates. Dokploy's own rules (build-scripts/ in that repository): no ports,
// container_name or networks, the service named like the folder, a domain on that service and port,
// and a meta.json whose id is the folder name. The compose file is read with the repo's strict YAML
// subset parser; template.toml with the small strict TOML parser below.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkShared, readText, ROOT } from './common.mjs'
import { parseYaml as parseSubset, YAML_COMPOSE } from './yaml.mjs'

export const ID = 'opentodo'
const DIR = `deploy/dokploy/blueprints/${ID}`
const UP = `deploy/dokploy/upstream/blueprints/${ID}`
export const PATHS = {
  compose: `${DIR}/docker-compose.yml`,
  template: `${DIR}/template.toml`,
  meta: `${DIR}/meta.json`,
  logo: `${DIR}/opentodo.svg`,
  index: 'deploy/dokploy/meta.json',
  sourceLogo: 'deploy/coolify/opentodo.svg',
}
export const FILES = ['docker-compose.yml', 'template.toml', 'meta.json', 'opentodo.svg']
const DOCS = 'https://open-todo.app/docs/self-hosting/dokploy/'

// ---- strict TOML subset -------------------------------------------------------------------------

/**
 * Parses the TOML Dokploy templates use: [table], [[array.of.tables]], key = "basic string",
 * integer, true/false or [] (empty array), and # comments. Throws with a line number on anything else.
 */
export function parseToml(text) {
  const root = {}
  let cur = root
  text.split('\n').forEach((raw, i) => {
    const no = i + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    let m = /^\[\[([a-z_]+(?:\.[a-z_]+)*)\]\]$/.exec(line)
    if (m) {
      const parts = m[1].split('.')
      const parent = walk(parts.slice(0, -1), no)
      const k = parts.at(-1)
      if (parent[k] === undefined) parent[k] = []
      if (!Array.isArray(parent[k])) throw new Error(`line ${no}: ${m[1]} is not an array of tables`)
      cur = {}
      parent[k].push(cur)
      return
    }
    m = /^\[([a-z_]+(?:\.[a-z_]+)*)\]$/.exec(line)
    if (m) {
      const parts = m[1].split('.')
      const parent = walk(parts.slice(0, -1), no)
      const k = parts.at(-1)
      if (parent[k] !== undefined && (typeof parent[k] !== 'object' || Array.isArray(parent[k]) || parent[k].__defined)) {
        throw new Error(`line ${no}: table [${m[1]}] defined twice`)
      }
      parent[k] = parent[k] ?? {}
      Object.defineProperty(parent[k], '__defined', { value: true, enumerable: false })
      cur = parent[k]
      return
    }
    m = /^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line)
    if (!m) throw new Error(`line ${no}: expected key = value, got: ${line}`)
    if (Object.hasOwn(cur, m[1])) throw new Error(`line ${no}: duplicate key ${m[1]}`)
    cur[m[1]] = value(m[2], no)
  })
  return root

  function walk(parts, no) {
    let t = root
    for (const p of parts) {
      if (t[p] === undefined) t[p] = {}
      t = Array.isArray(t[p]) ? t[p].at(-1) : t[p]
      if (typeof t !== 'object' || t === null) throw new Error(`line ${no}: ${p} is not a table`)
    }
    return t
  }
}

function value(v, no) {
  if (v === '[]') return []
  if (v === 'true' || v === 'false') return v === 'true'
  if (/^-?\d+$/.test(v)) return Number(v)
  const m = /^"((?:[^"\\]|\\["\\])*)"$/.exec(v)
  if (m) return m[1].replace(/\\(["\\])/g, '$1')
  throw new Error(`line ${no}: only "strings", integers, booleans and [] are supported, got: ${v}`)
}

// ---- checks -------------------------------------------------------------------------------------

/** Each compose environment entry: NAME=${NAME:-default} (or ${NAME}). */
function readEnvironment(list, errors) {
  const env = new Map()
  for (const entry of list ?? []) {
    const m = typeof entry === 'string' ? /^([A-Z0-9_]+)=\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$/.exec(entry) : null
    if (!m || m[1] !== m[2]) {
      errors.push(`compose environment entries must be NAME=\${NAME:-default}, got: ${entry}`)
      continue
    }
    if (env.has(m[1])) errors.push(`compose sets ${m[1]} twice`)
    env.set(m[1], m[3] ?? '')
  }
  return env
}

export function checkCompose(text, facts) {
  if (text === null) return { errors: [`${PATHS.compose} is missing`] }
  const errors = []
  let doc
  try {
    doc = parseSubset(text, YAML_COMPOSE)
  } catch (e) {
    return { errors: [`${PATHS.compose} is not in the supported YAML subset: ${e.message}`] }
  }
  for (const k of Object.keys(doc)) if (!['services', 'volumes'].includes(k)) errors.push(`compose: top-level "${k}" is not allowed (Dokploy manages networks; no version key)`)
  const names = Object.keys(doc.services ?? {})
  if (names.length !== 1 || names[0] !== ID) errors.push(`compose must have exactly one service, named "${ID}" like the blueprint folder (got: ${names.join(', ') || 'none'})`)
  const svc = doc.services?.[ID] ?? {}
  for (const k of ['ports', 'container_name', 'networks', 'build', 'network_mode']) {
    if (svc[k] !== undefined) errors.push(`compose: "${k}" is not allowed in Dokploy templates`)
  }
  const allowed = ['image', 'pull_policy', 'restart', 'expose', 'environment', 'volumes', 'healthcheck']
  for (const k of Object.keys(svc)) if (!allowed.includes(k)) errors.push(`compose: unexpected service key "${k}"`)
  if (svc.restart !== 'unless-stopped') errors.push('compose: restart must be unless-stopped')
  // Dokploy runs `docker compose up`, which does not pull an image it already has: without this a
  // redeploy would keep the old release under the moving stable tag.
  if (svc.pull_policy !== 'always') errors.push('compose: pull_policy must be always, so Deploy fetches the release the stable tag points at')
  const expose = (svc.expose ?? []).map(String)
  if (expose.length !== 1) errors.push('compose: expose exactly one port')
  const hc = svc.healthcheck ?? {}
  if (JSON.stringify(hc.test) !== JSON.stringify(['CMD', ...facts.healthcheck])) errors.push(`compose: healthcheck test must be ${JSON.stringify(['CMD', ...facts.healthcheck])} (the image has no shell)`)
  const vols = svc.volumes ?? []
  const data = vols.length === 1 && typeof vols[0] === 'string' ? /^opentodo-data:(\/[^:]*)$/.exec(vols[0]) : null
  if (!data) errors.push('compose: mount exactly one named volume, opentodo-data:/data (Dokploy backs up named volumes, not bind mounts)')
  if (!doc.volumes || !Object.hasOwn(doc.volumes, 'opentodo-data')) errors.push('compose: declare the opentodo-data volume at the top level')
  const env = readEnvironment(svc.environment, errors)
  return { errors, image: svc.image, port: expose[0] ?? null, dataTarget: data ? data[1] : null, env }
}

export function checkTemplateToml(text, compose, facts) {
  if (text === null) return { errors: [`${PATHS.template} is missing`] }
  const errors = []
  let t
  try {
    t = parseToml(text)
  } catch (e) {
    return { errors: [`${PATHS.template} is not in the supported TOML subset: ${e.message}`] }
  }
  const vars = t.variables ?? {}
  if (vars.main_domain !== '${domain}') errors.push('template.toml: variables.main_domain must be "${domain}"')
  if (!/^\$\{password:(\d+)\}$/.test(vars.setup_token ?? '') || Number(/\d+/.exec(vars.setup_token)[0]) < 16) {
    errors.push('template.toml: variables.setup_token must be "${password:N}" with N >= 16 (OPENTODO_SETUP_TOKEN needs 16+ characters)')
  }
  const domains = t.config?.domains
  if (!Array.isArray(domains) || domains.length !== 1) {
    errors.push('template.toml: one [[config.domains]] entry')
  } else {
    const d = domains[0]
    if (d.serviceName !== ID) errors.push(`template.toml: the domain's serviceName must be "${ID}", the compose service`)
    if (String(d.port) !== String(facts.port)) errors.push(`template.toml: the domain's port must be ${facts.port}, got ${d.port}`)
    else if (compose.port !== null && String(d.port) !== compose.port) errors.push('template.toml: the domain port must be the port the compose file exposes')
    if (d.host !== '${main_domain}') errors.push('template.toml: the domain host must be "${main_domain}"')
  }
  const env = t.config?.env
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return { errors: [...errors, 'template.toml: [config.env] must be a table of NAME = "value"'] }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') errors.push(`template.toml: ${k} must be a string`)
    if (compose.env && !compose.env.has(k)) errors.push(`template.toml sets ${k}, which the compose file does not pass to the container`)
  }
  for (const k of compose.env?.keys() ?? []) if (!Object.hasOwn(env, k)) errors.push(`compose passes ${k}, which template.toml does not set (Dokploy's Environment tab would not show it)`)
  if (env.OPENTODO_SETUP_TOKEN !== undefined && env.OPENTODO_SETUP_TOKEN !== '${setup_token}') errors.push('template.toml: OPENTODO_SETUP_TOKEN must be "${setup_token}" (generated per install)')
  // Dokploy's template domains are plain http (sslip.io, no certificate): an https base URL there
  // makes the session cookie Secure, so the browser drops it and sign-in fails. An http one is no
  // better (links and the push contact go stale once the domain gets https), so it starts empty.
  if (env.OPENTODO_BASE_URL !== undefined && env.OPENTODO_BASE_URL !== '') errors.push('template.toml: OPENTODO_BASE_URL must start empty: the generated domain is plain http')
  return { errors, env }
}

export function checkMeta(text, facts, root = ROOT) {
  if (text === null) return { errors: [`${PATHS.meta} is missing`] }
  const errors = []
  let m
  try {
    m = JSON.parse(text)
  } catch (e) {
    return { errors: [`${PATHS.meta} is not JSON: ${e.message}`] }
  }
  if (!text.endsWith('\n')) errors.push('meta.json must end with a newline')
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return { errors: ['meta.json must be one JSON object'] }
  const keys = ['id', 'name', 'version', 'description', 'logo', 'links', 'tags']
  for (const k of Object.keys(m)) if (!keys.includes(k)) errors.push(`meta.json: unexpected field "${k}"`)
  for (const k of keys) if (m[k] === undefined || m[k] === '') errors.push(`meta.json: "${k}" is required`)
  if (m.id !== ID) errors.push(`meta.json: id must be "${ID}", the folder name`)
  if (m.name !== facts.name) errors.push(`meta.json: name must be ${facts.name}`)
  if (m.version !== facts.tag) errors.push(`meta.json: version must be "${facts.tag}", the image tag`)
  if (m.description !== facts.summary) errors.push('meta.json: description must be the summary in deploy/deploy.json')
  if (m.logo !== 'opentodo.svg') errors.push('meta.json: logo must be opentodo.svg')
  const want = { github: facts.repository, website: facts.project, docs: DOCS }
  if (JSON.stringify(m.links) !== JSON.stringify(want)) errors.push(`meta.json: links must be ${JSON.stringify(want)}`)
  if (!Array.isArray(m.tags) || m.tags.length === 0 || m.tags.some((t) => !/^[a-z0-9-]+$/.test(t))) errors.push('meta.json: tags must be a non-empty list of lowercase tags')
  const logo = readText(PATHS.logo, root)
  if (logo === null) errors.push(`${PATHS.logo} is missing`)
  else if (logo !== readText(PATHS.sourceLogo, root)) errors.push(`${PATHS.logo} must be identical to ${PATHS.sourceLogo}`)
  return { errors, meta: m }
}

/** deploy/dokploy/meta.json is the list a self-hosted base URL serves, as Dokploy's generate-meta.js writes it. */
export function checkIndex(text, meta) {
  if (text === null) return [`${PATHS.index} is missing (the list a base URL serves)`]
  return text === JSON.stringify([meta], null, 2) + '\n' ? [] : [`${PATHS.index} must be [<${PATHS.meta}>] as Dokploy's generate-meta.js writes it`]
}

export function checkUpstream(root = ROOT) {
  const errors = []
  for (const f of FILES) {
    const up = readText(`${UP}/${f}`, root)
    if (up === null) errors.push(`${UP}/${f} is missing`)
    else if (up !== readText(`${DIR}/${f}`, root)) errors.push(`${UP}/${f} must be identical to ${DIR}/${f}`)
  }
  if (existsSync(join(root, 'deploy/dokploy/upstream/meta.json'))) errors.push('deploy/dokploy/upstream/meta.json must not exist: Dokploy/templates generates it and rejects a committed one')
  if (!existsSync(join(root, 'deploy/dokploy/upstream/PR.md'))) errors.push('deploy/dokploy/upstream/PR.md is missing')
  return errors
}

export function checkAll(files, ctx, root = ROOT) {
  const compose = checkCompose(files.compose, ctx.facts)
  if (!compose.env) return compose.errors
  const toml = checkTemplateToml(files.template, compose, ctx.facts)
  const meta = checkMeta(files.meta, ctx.facts, root)
  const errors = [...compose.errors, ...toml.errors, ...meta.errors]
  if (meta.meta) errors.push(...checkIndex(files.index, meta.meta))
  const variables = new Map()
  for (const [name, def] of compose.env) {
    const set = toml.env?.[name]
    // What Dokploy writes into .env wins over the compose fallback; both must agree for catalogue defaults.
    if (set !== undefined && !/\$\{/.test(set) && set !== def) errors.push(`${name}: template.toml sets ${JSON.stringify(set)} but the compose fallback is ${JSON.stringify(def)}`)
    variables.set(name, { default: def, required: false })
  }
  errors.push(...checkShared({ image: compose.image, port: compose.port, dataTarget: compose.dataTarget, variables, policy: 'stable' }, ctx))
  return errors
}

export function check(ctx, root = ROOT) {
  const files = {
    compose: readText(PATHS.compose, root),
    template: readText(PATHS.template, root),
    meta: readText(PATHS.meta, root),
    index: readText(PATHS.index, root),
  }
  return [...checkAll(files, ctx, root), ...checkUpstream(root)]
}

export const summary = 'compose rules, stable tag pulled on deploy, domain, generated setup token, empty base URL, meta, base-URL list and upstream copy'
