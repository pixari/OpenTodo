// Easypanel template (deploy/easypanel/), OpenSpec change platform-catalogs. Easypanel
// lists templates from easypanel-io/templates: templates/opentodo/ with meta.yaml (the
// listing and the form, whose schema defaults pick the image), index.ts (generate(),
// which returns the services) and assets/. deploy/easypanel/upstream/templates/opentodo/
// is that folder and must be identical. meta.yaml is parsed strictly
// (yaml.mjs); index.ts is read with strict patterns for the one app service it
// returns, so a template this checker does not understand fails instead of passing.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkShared, ROOT } from './common.mjs'
import { parseYaml } from './yaml.mjs'

export const DIR = 'deploy/easypanel'
export const UPSTREAM = 'deploy/easypanel/upstream/templates/opentodo'
export const FILES = ['meta.yaml', 'index.ts', 'assets/logo.svg', 'assets/screenshot.png']
/** The logo has one source in this repository. */
export const LOGO_SOURCE = 'deploy/coolify/opentodo.svg'
/** Tags that already exist in easypanel-io/templates (new tags are discouraged there). */
export const TAGS = ['Productivity', 'Task Management', 'To-Do List', 'Self-Hosted']
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function read(rel, root) {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p) : null
}

function readAll(dir, root) {
  return Object.fromEntries(FILES.map((f) => [f, read(join(dir, f), root)]))
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

const noSlash = (u) => String(u ?? '').replace(/\/$/, '')

export function checkMeta(text, facts) {
  let meta
  try {
    meta = parseYaml(text)
  } catch (e) {
    return { errors: [`meta.yaml is not in the supported YAML subset: ${e.message}`], meta: null }
  }
  const errors = []
  if (meta.name !== facts.name) errors.push(`meta.yaml: name must be ${facts.name}`)
  for (const k of ['description', 'instructions']) if (typeof meta[k] !== 'string' || meta[k].length < 40) errors.push(`meta.yaml: ${k} is required`)
  if (typeof meta.instructions === 'string' && !meta.instructions.includes('OPENTODO_SETUP_TOKEN')) {
    errors.push('meta.yaml: instructions must say where the setup token is (OPENTODO_SETUP_TOKEN)')
  }
  if (!Array.isArray(meta.changeLog) || !meta.changeLog.length || !meta.changeLog.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c.date)) && c.description)) {
    errors.push('meta.yaml: changeLog needs entries with a date (YYYY-MM-DD) and a description')
  }
  const links = new Map((meta.links ?? []).map((l) => [l.label, noSlash(l.url)]))
  for (const [label, url] of [['Website', facts.project], ['Documentation', facts.docs], ['Github', facts.repository]]) {
    if (links.get(label) !== noSlash(url)) errors.push(`meta.yaml: links needs ${label}: ${url}`)
  }
  if (!Array.isArray(meta.contributors) || !meta.contributors.every((c) => c.name && c.url)) errors.push('meta.yaml: contributors need a name and url')
  for (const k of ['benefits', 'features']) {
    if (!Array.isArray(meta[k]) || !meta[k].length || !meta[k].every((b) => b.title && b.description)) errors.push(`meta.yaml: ${k} need a title and description each`)
  }
  if (!Array.isArray(meta.tags) || !meta.tags.length) errors.push('meta.yaml: tags are required')
  else for (const t of meta.tags) if (!TAGS.includes(t)) errors.push(`meta.yaml: tag ${t} is not one of ${TAGS.join(', ')}`)
  const s = meta.schema ?? {}
  if (s.type !== 'object') errors.push('meta.yaml: schema.type must be object')
  if (JSON.stringify(s.required) !== JSON.stringify(['appServiceName', 'appServiceImage'])) errors.push('meta.yaml: schema.required must be [appServiceName, appServiceImage]')
  const props = s.properties ?? {}
  if (JSON.stringify(Object.keys(props)) !== JSON.stringify(['appServiceName', 'appServiceImage'])) errors.push('meta.yaml: schema.properties must be appServiceName and appServiceImage')
  if (props.appServiceName?.default !== 'opentodo') errors.push('meta.yaml: appServiceName must default to opentodo')
  for (const p of Object.values(props)) if (p.type !== 'string' || !p.title) errors.push('meta.yaml: every schema property needs type string and a title')
  return { errors, meta }
}

/** Reads the one app service of index.ts. */
export function readIndex(text) {
  const errors = []
  const need = (re, what) => {
    const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
    if (all.length !== 1) errors.push(`index.ts: expected exactly one ${what}, found ${all.length}`)
    return all[0] ?? null
  }
  need(/^import \{ Output, randomString, Services \} from "~templates-utils";$/m, 'import from ~templates-utils')
  need(/^import \{ Input } from "\.\/meta";$/m, 'import of Input from ./meta')
  need(/^export function generate\(input: Input\): Output \{$/m, 'generate(input: Input): Output')
  need(/services\.push\(\{/, 'services.push (one service)')
  need(/^ {4}type: "app",$/m, 'type: "app"')
  need(/^ {6}serviceName: input\.appServiceName,$/m, 'serviceName: input.appServiceName')
  need(/^ {8}type: "image",\n {8}image: input\.appServiceImage,$/m, 'image source from input.appServiceImage')
  need(/^ {2}return \{ services \};$/m, 'return { services }')
  const secrets = new Map()
  for (const m of text.matchAll(/^ {2}const ([a-zA-Z]+) = (.*);$/gm)) {
    const r = /^randomString\((\d+)\)$/.exec(m[2])
    if (m[1] === 'services' && m[2] === '[]') continue
    if (!r) { errors.push(`index.ts: const ${m[1]} must be randomString(<length>), got ${m[2]}`); continue }
    if (Number(r[1]) < 16) errors.push(`index.ts: ${m[1]} needs at least 16 characters`)
    secrets.set(m[1], Number(r[1]))
    if (text.split(m[1]).length - 1 < 2) errors.push(`index.ts: ${m[1]} is unused`)
  }
  const env = new Map()
  const block = need(/^ {6}env: \[\n((?: {8}`[^`\n]*`,\n)+) {6}\]\.join\("\\n"\),$/m, 'env: [ `NAME=value`, ... ].join("\\n")')
  if (block) {
    for (const line of block[1].trimEnd().split('\n')) {
      const m = /^ {8}`([A-Z][A-Z0-9_]*)=([^`]*)`,$/.exec(line)
      if (!m) { errors.push(`index.ts: env line not understood: ${line.trim()}`); continue }
      if (env.has(m[1])) errors.push(`index.ts: ${m[1]} is set twice`)
      env.set(m[1], m[2])
    }
  }
  const domains = need(/^ {6}domains: \[\n {8}\{\n {10}host: "\$\(EASYPANEL_DOMAIN\)",\n {10}port: (\d+),\n {8}\},\n {6}\],$/m, 'domain ($(EASYPANEL_DOMAIN) and a port)')
  const mounts = need(/^ {6}mounts: \[\n {8}\{\n {10}type: "volume",\n {10}name: "([a-z0-9-]+)",\n {10}mountPath: "([^"]+)",\n {8}\},\n {6}\],$/m, 'volume mount')
  return { errors, env, secrets, port: domains ? Number(domains[1]) : null, volume: mounts?.[1] ?? null, dataTarget: mounts?.[2] ?? null }
}

export function checkTemplate(files, ctx, root = ROOT) {
  const { facts } = ctx
  const errors = []
  for (const f of FILES) if (files[f] === null) errors.push(`${DIR}/${f} is missing`)
  if (errors.length) return errors
  const metaText = files['meta.yaml'].toString('utf8')
  const indexText = files['index.ts'].toString('utf8')
  for (const [f, t] of [['meta.yaml', metaText], ['index.ts', indexText]]) if (!t.endsWith('\n')) errors.push(`${f} must end with a newline`)
  const { errors: metaErrors, meta } = checkMeta(metaText, facts)
  errors.push(...metaErrors)
  const idx = readIndex(indexText)
  errors.push(...idx.errors)

  const variables = new Map()
  for (const [name, value] of idx.env) {
    if (!name.startsWith('OPENTODO_')) { errors.push(`index.ts sets ${name}, which OpenTodo does not read`); continue }
    const secret = /^\$\{([a-zA-Z]+)\}$/.exec(value)
    if (secret && !idx.secrets.has(secret[1])) errors.push(`index.ts: ${name} uses \${${secret[1]}}, which is not a generated secret`)
    variables.set(name, { default: value, required: false, platformValue: Boolean(secret) || value.includes('$(') })
  }
  if (idx.env.has('OPENTODO_BASE_URL') && idx.env.get('OPENTODO_BASE_URL') !== 'https://$(PRIMARY_DOMAIN)') {
    errors.push('index.ts: OPENTODO_BASE_URL must be https://$(PRIMARY_DOMAIN) (Easypanel serves its domains over https)')
  }
  if (idx.env.has('OPENTODO_SETUP_TOKEN') && !/^\$\{[a-zA-Z]+\}$/.test(idx.env.get('OPENTODO_SETUP_TOKEN'))) {
    errors.push('index.ts: OPENTODO_SETUP_TOKEN must be generated (randomString), never hardcoded')
  }
  if (idx.volume !== 'data') errors.push('index.ts: the volume must be named data')

  if (!files['assets/screenshot.png'].subarray(0, 8).equals(PNG)) errors.push('assets/screenshot.png is not a PNG')
  const logo = read(LOGO_SOURCE, root)
  if (!logo || !files['assets/logo.svg'].equals(logo)) errors.push(`assets/logo.svg must be identical to ${LOGO_SOURCE}`)

  errors.push(...checkShared({
    image: meta?.schema?.properties?.appServiceImage?.default ?? null,
    port: idx.port,
    dataTarget: idx.dataTarget,
    variables,
    policy: 'release',
  }, ctx))
  return errors
}

export function checkUpstream(files, upstreamFiles, upstreamList) {
  const errors = []
  for (const f of FILES) {
    if (!upstreamFiles[f] || !files[f] || !upstreamFiles[f].equals(files[f])) errors.push(`${UPSTREAM}/${f} must be identical to ${DIR}/${f}`)
  }
  const extra = upstreamList.filter((f) => !FILES.includes(f))
  if (extra.length) errors.push(`${UPSTREAM} has files that are not part of the template: ${extra.join(', ')} (meta.ts is generated by their build)`)
  return errors
}

export function check(ctx, root = ROOT) {
  const files = readAll(DIR, root)
  const errors = checkTemplate(files, ctx, root)
  const extra = listFiles(join(root, DIR)).filter((f) => !FILES.includes(f) && f !== 'README.md' && !f.startsWith('upstream/'))
  if (extra.length) errors.push(`${DIR} has unexpected files: ${extra.join(', ')}`)
  return [...errors, ...checkUpstream(files, readAll(UPSTREAM, root), listFiles(join(root, UPSTREAM)))]
}

export const summary = 'release tag, port, /data volume, generated setup token, https base URL, meta.yaml, assets and upstream copy'
