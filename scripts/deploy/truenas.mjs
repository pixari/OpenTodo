// TrueNAS Community Edition app (deploy/truenas/), OpenSpec change platform-catalogs.
// TrueNAS lists apps from its catalogue repository truenas/apps: one folder per app,
// ix-dev/community/opentodo/, with app.yaml (metadata), ix_values.yaml (images and
// constants), questions.yaml (the install form), item.yaml (generated from app.yaml),
// README.md and a Jinja docker-compose template rendered by TrueNAS's library.
// deploy/truenas/opentodo/ is that folder (without templates/library/, which their
// ci.py / copy-lib regenerates from lib_version); deploy/truenas/upstream/ is the
// same folder at its path in truenas/apps and must be identical.
//
// The YAML files are parsed strictly (yaml.mjs). The Jinja template is read
// line by line: every line that sets the image's behaviour must be one of the known
// forms, so a change to it fails here until this checker understands it.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkShared, readText, ROOT } from './common.mjs'
import { parseYaml } from './yaml.mjs'

export const APP = 'deploy/truenas/opentodo'
export const UPSTREAM = 'deploy/truenas/upstream/ix-dev/community/opentodo'
export const FILES = [
  'README.md',
  'app.yaml',
  'item.yaml',
  'ix_values.yaml',
  'questions.yaml',
  'templates/docker-compose.yaml',
  'templates/test_values/basic-values.yaml',
]
/** The default host port. Unique in truenas/apps (their .github/scripts/port_validation.py); re-check before submitting. */
export const PORT_DEFAULT = 30530
/** The id TrueNAS apps run as by default (the "apps" user), which OpenTodo's static binary accepts. */
export const RUN_AS = 568
export const MAINTAINER = { email: 'dev@truenas.com', name: 'truenas', url: 'https://www.truenas.com/' }
/**
 * Server settings the template sets itself instead of offering them: the listen address follows
 * the chosen port (TrueNAS apps listen on the port the user picks, so host networking works) and
 * the data directory is the mount. They are not in the variable catalogue (deploy/deploy.json),
 * so they are checked here and not passed to checkShared(); once the catalogue lists them
 * (with platformDefault for OPENTODO_ADDR) pass them on like the others.
 */
export const SERVER_SETTINGS = {
  OPENTODO_ADDR: '":%d"|format(values.network.web_port.port_number)',
  OPENTODO_DATA_DIR: '"/data"',
}

/** The fixed lines of the compose template (TrueNAS library calls); each must appear exactly once. */
export function requiredLines(facts) {
  const test = JSON.stringify(['CMD', ...facts.healthcheck]).replace(/","/g, '", "')
  return [
    '{% set c1 = tpl.add_container(values.consts.opentodo_container_name, "image") %}',
    '{% do c1.set_user(values.run_as.user, values.run_as.group) %}',
    `{% do c1.healthcheck.set_custom_test(${test}) %}`,
    '{% do c1.environment.add_user_envs(values.opentodo.additional_envs) %}',
    '{% do c1.add_port(values.network.web_port) %}',
    `{% do c1.add_storage("${facts.dataDir}", values.storage.data) %}`,
    '{% do perm_container.add_or_skip_action("data", values.storage.data, perms_config) %}',
    '{% do c1.depends.add_dependency(values.consts.perms_container_name, "service_completed_successfully") %}',
    '{% do tpl.portals.add(values.network.web_port) %}',
    '{{ tpl.render() | tojson }}',
  ]
}

function readAll(dir, root) {
  const out = {}
  for (const f of FILES) out[f] = readText(join(dir, f), root)
  return out
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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Reads the env lines of the compose template: name -> the Jinja expression it is set to. */
export function readEnv(template) {
  const env = new Map()
  const errors = []
  for (const [no, line] of template.split('\n').entries()) {
    if (!line.includes('add_env(')) continue
    const m = /^\s*\{% do c1\.environment\.add_env\("([A-Z0-9_]+)", (.+)\) %\}$/.exec(line)
    if (!m) { errors.push(`docker-compose.yaml line ${no + 1}: add_env must be {% do c1.environment.add_env("NAME", value) %}`); continue }
    if (env.has(m[1])) errors.push(`docker-compose.yaml: ${m[1]} is set twice`)
    env.set(m[1], m[2])
  }
  return { env, errors }
}

export function checkApp(files, ctx) {
  const { facts } = ctx
  const errors = []
  for (const f of FILES) if (files[f] === null) errors.push(`${APP}/${f} is missing`)
  if (errors.length) return errors
  for (const f of FILES) if (!files[f].endsWith('\n')) errors.push(`${f} must end with a newline`)
  const y = {}
  for (const f of FILES.filter((f) => f.endsWith('.yaml') && f !== 'templates/docker-compose.yaml')) {
    try {
      y[f] = parseYaml(files[f])
    } catch (e) {
      errors.push(`${f} is not in the supported YAML subset: ${e.message}`)
    }
  }
  if (errors.length) return errors
  const app = y['app.yaml']
  const values = y['ix_values.yaml']
  const item = y['item.yaml']
  const questions = y['questions.yaml']
  const test = y['templates/test_values/basic-values.yaml']

  // app.yaml
  const want = { name: 'opentodo', train: 'community', title: facts.name, home: facts.project, changelog_url: `${facts.repository}/releases` }
  for (const [k, v] of Object.entries(want)) if (app[k] !== v) errors.push(`app.yaml: ${k} must be ${v}, got ${app[k]}`)
  const image = values.images?.image
  if (typeof image?.tag !== 'string') errors.push('ix_values.yaml: images.image.tag must be a quoted string')
  if (String(app.app_version) !== image?.tag) errors.push(`app.yaml: app_version (${app.app_version}) must equal the image tag in ix_values.yaml (${image?.tag})`)
  if (!eq(app.categories, ['productivity'])) errors.push('app.yaml: categories must be [productivity]')
  if (!eq(app.maintainers, [MAINTAINER])) errors.push('app.yaml: maintainers must stay truenas (dev@truenas.com), as for every catalogue app')
  if (!/^\d+\.\d+\.\d+$/.test(String(app.version))) errors.push('app.yaml: version must be x.y.z')
  if (!/^\d+\.\d+\.\d+$/.test(String(app.lib_version))) errors.push('app.yaml: lib_version must be x.y.z')
  if (!/^[0-9a-f]{64}$/.test(String(app.lib_version_hash))) errors.push('app.yaml: lib_version_hash must be the 64-hex hash ci.py writes')
  if (!eq(app.capabilities, [])) errors.push('app.yaml: capabilities must be [] (OpenTodo needs none)')
  if (!eq(app.host_mounts, [])) errors.push('app.yaml: host_mounts must be []')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(app.date_added))) errors.push('app.yaml: date_added must be YYYY-MM-DD')
  if (!/^https:\/\/media\.sys\.truenas\.net\/apps\/opentodo\/icons\/icon\.(svg|png)$/.test(String(app.icon))) {
    errors.push('app.yaml: icon must be the TrueNAS CDN URL https://media.sys.truenas.net/apps/opentodo/icons/icon.svg (the reviewer uploads it)')
  }
  if (!Array.isArray(app.sources) || !app.sources.includes(facts.repository)) errors.push(`app.yaml: sources must include ${facts.repository}`)
  if (!Array.isArray(app.keywords) || app.keywords.length === 0) errors.push('app.yaml: keywords are required')
  if (!app.description) errors.push('app.yaml: description is required')
  const ctxs = app.run_as_context
  if (!Array.isArray(ctxs) || ctxs.length !== 1 || ctxs[0].uid !== RUN_AS || ctxs[0].gid !== RUN_AS) {
    errors.push(`app.yaml: run_as_context must be one entry with uid and gid ${RUN_AS}`)
  }

  // item.yaml is generated from app.yaml by their generate_metadata.py.
  const itemWant = { categories: app.categories, icon_url: app.icon, screenshots: app.screenshots, tags: app.keywords }
  if (!eq(item, itemWant)) errors.push('item.yaml must match app.yaml (categories, icon, screenshots, keywords); run their .github/scripts/generate_metadata.py')

  // ix_values.yaml
  if (!values.images?.container_utils_image?.repository) errors.push('ix_values.yaml: images.container_utils_image is needed by the permissions container')
  if (values.consts?.opentodo_container_name !== 'opentodo') errors.push('ix_values.yaml: consts.opentodo_container_name must be opentodo')
  if (!values.consts?.perms_container_name) errors.push('ix_values.yaml: consts.perms_container_name is required')

  // questions.yaml
  const q = new Map((questions.questions ?? []).map((x) => [x.variable, x]))
  const attrs = (x) => new Map((x?.schema?.attrs ?? []).map((a) => [a.variable, a]))
  const settings = attrs(q.get('opentodo'))
  if (!settings.has('additional_envs')) errors.push('questions.yaml: opentodo.additional_envs is required (every other OPENTODO_* variable goes there)')
  const runAs = attrs(q.get('run_as'))
  for (const k of ['user', 'group']) if (runAs.get(k)?.schema?.default !== RUN_AS) errors.push(`questions.yaml: run_as.${k} must default to ${RUN_AS}`)
  const webPort = attrs(attrs(q.get('network')).get('web_port'))
  const portDefault = webPort.get('port_number')?.schema?.default
  if (portDefault !== PORT_DEFAULT) errors.push(`questions.yaml: network.web_port.port_number must default to ${PORT_DEFAULT} (unique in truenas/apps), got ${portDefault}`)
  if (webPort.has('container_port')) errors.push('questions.yaml: no container_port: OpenTodo listens on the chosen port')
  if (attrs(q.get('storage')).get('data')?.schema?.type !== 'dict') errors.push('questions.yaml: storage.data is required')

  // The compose template.
  const template = files['templates/docker-compose.yaml']
  const lines = template.split('\n')
  for (const l of requiredLines(facts)) {
    const n = lines.filter((x) => x.trim() === l).length
    if (n !== 1) errors.push(`docker-compose.yaml must contain this line exactly once: ${l}`)
  }
  if (/container_port/.test(template)) errors.push('docker-compose.yaml: no container_port: the container listens on the chosen port (OPENTODO_ADDR)')
  const storage = lines.filter((l) => /add_storage\(/.test(l) && !/store\.mount_path/.test(l))
  if (storage.length !== 1) errors.push('docker-compose.yaml: one data mount (add_storage) besides the additional storage loop')
  const { env, errors: envErrors } = readEnv(template)
  errors.push(...envErrors)
  const variables = new Map()
  for (const [name, expr] of env) {
    if (!name.startsWith('OPENTODO_')) { errors.push(`docker-compose.yaml sets ${name}, which OpenTodo does not read`); continue }
    if (name in SERVER_SETTINGS) {
      if (expr !== SERVER_SETTINGS[name]) errors.push(`docker-compose.yaml: ${name} must be set to ${SERVER_SETTINGS[name]}, got ${expr}`)
      continue
    }
    const m = /^values\.opentodo\.([a-z_]+)$/.exec(expr)
    if (!m) { errors.push(`docker-compose.yaml: ${name} must come from a question (values.opentodo.<setting>), got ${expr}`); continue }
    const attr = settings.get(m[1])
    if (!attr) { errors.push(`questions.yaml: opentodo.${m[1]} (for ${name}) is missing`); continue }
    const s = attr.schema ?? {}
    const entry = facts.variables.find((v) => v.name === name)
    if (!attr.description) errors.push(`questions.yaml: opentodo.${m[1]} needs a description`)
    if (entry?.secret && s.private !== true) errors.push(`questions.yaml: opentodo.${m[1]} holds a secret and must be private: true`)
    if (s.type === 'boolean' && typeof s.default !== 'boolean') errors.push(`questions.yaml: opentodo.${m[1]} needs a boolean default`)
    if (!(m[1] in (test.opentodo ?? {}))) errors.push(`basic-values.yaml: opentodo.${m[1]} is missing`)
    variables.set(name, { default: s.default === undefined ? undefined : String(s.default), required: s.required === true })
  }
  for (const name of Object.keys(SERVER_SETTINGS)) if (!env.has(name)) errors.push(`docker-compose.yaml must set ${name}`)

  // The test values are what their CI renders and starts. The template sets OPENTODO_ADDR from
  // the chosen port, so the container listens on it: the test values choose the image's port.
  const testPort = test.network?.web_port?.port_number
  if (test.run_as?.user !== RUN_AS || test.run_as?.group !== RUN_AS) errors.push(`basic-values.yaml: run_as must be ${RUN_AS}:${RUN_AS}`)
  if (test.storage?.data?.type !== 'ix_volume') errors.push('basic-values.yaml: storage.data must be an ix_volume')

  // README.md (shown in the TrueNAS app page)
  if (!files['README.md'].includes(facts.project)) errors.push(`README.md must link ${facts.project}`)

  errors.push(...checkShared({
    image: image ? `${image.repository}:${image.tag}` : null,
    port: testPort,
    dataTarget: storage.length === 1 ? /add_storage\("([^"]*)"/.exec(storage[0])?.[1] : null,
    variables,
    policy: 'release',
  }, ctx))
  return errors
}

/** The truenas/apps folder: identical files, nothing generated (library, rendered output) kept here. */
export function checkUpstream(files, upstreamFiles, upstreamList) {
  const errors = []
  for (const f of FILES) if (upstreamFiles[f] !== files[f]) errors.push(`${UPSTREAM}/${f} must be identical to ${APP}/${f}`)
  const extra = upstreamList.filter((f) => !FILES.includes(f))
  if (extra.length) errors.push(`${UPSTREAM} has files that are not part of the app here: ${extra.join(', ')} (templates/library/ is regenerated by their ci.py when submitting)`)
  return errors
}

export function check(ctx, root = ROOT) {
  const files = readAll(APP, root)
  const errors = checkApp(files, ctx)
  const extra = listFiles(join(root, APP)).filter((f) => !FILES.includes(f))
  if (extra.length) errors.push(`${APP} has unexpected files: ${extra.join(', ')}`)
  return [...errors, ...checkUpstream(files, readAll(UPSTREAM, root), listFiles(join(root, UPSTREAM)))]
}

export const summary = 'release tag = app_version, port, /data, run as 568, health check, questions, metadata and upstream copy'
