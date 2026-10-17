// Cosmos Cloud marketplace servapp (deploy/cosmos/), OpenSpec change platform-catalogs.
// The official store (azukaar/cosmos-servapps-official) takes one folder per app,
// servapps/OpenTodo/, with description.json, cosmos-compose.json, icon.png and a
// screenshots/ folder; deploy/cosmos/upstream/ holds that folder file for file.
//
// Both files are parsed as JSON (Cosmos renders cosmos-compose.json with whiskers before
// parsing it; this one uses no {if} blocks, so it is valid JSON on disk and the check
// refuses anything that is not). Cosmos proxies the app itself (a SERVAPP route), so no
// port is published: the container port is the one in the route target.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkShared, isMap, pngSize, readText, ROOT, same } from './common.mjs'

export const DESCRIPTION = 'deploy/cosmos/description.json'
export const COMPOSE = 'deploy/cosmos/cosmos-compose.json'
export const UPSTREAM_DIR = 'deploy/cosmos/upstream/servapps/OpenTodo'
export const ICON_URL = 'https://azukaar.github.io/cosmos-servapps-official/servapps/OpenTodo/icon.png'
export const MIN_VERSION = '0.22.23' // {RootProtocol} needs it
export const HOST = '{Hostnames.{StaticServiceName}.{StaticServiceName}.host}'
export const BASE_URL = `{RootProtocol}://${HOST}`
const DESCRIPTION_KEYS = ['description', 'image', 'longDescription', 'name', 'repository', 'supported_architectures', 'tags']
const SERVICE_KEYS = ['container_name', 'environment', 'image', 'labels', 'restart', 'routes', 'volumes']
const UPSTREAM_FILES = ['cosmos-compose.json', 'description.json', 'icon.png', 'screenshots']

const parse = (text, label) => {
  try { return [JSON.parse(text), null] } catch (e) { return [null, `${label} is not valid JSON: ${e.message}`] }
}

export function checkDescription(text, ctx) {
  if (text === null) return [`${DESCRIPTION} is missing`]
  const [d, bad] = parse(text, DESCRIPTION)
  if (bad) return [bad]
  if (!isMap(d)) return [`${DESCRIPTION} must be an object`]
  const errors = []
  const keys = Object.keys(d).sort()
  if (!same(keys, DESCRIPTION_KEYS)) errors.push(`description.json must have exactly ${DESCRIPTION_KEYS.join(', ')}, got: ${keys.join(', ')}`)
  if (d.name !== ctx.facts.name) errors.push(`description.json: name must be ${ctx.facts.name}`)
  if (d.repository !== ctx.facts.repository) errors.push(`description.json: repository must be ${ctx.facts.repository}`)
  if (d.image !== `${ctx.facts.image}:${ctx.facts.tag}`) errors.push(`description.json: image must be ${ctx.facts.image}:${ctx.facts.tag}, the image the compose file runs`)
  if (!same(d.supported_architectures, ['amd64', 'arm64'])) errors.push('description.json: supported_architectures must be ["amd64", "arm64"], the image platforms')
  if (typeof d.description !== 'string' || !d.description) errors.push('description.json: description is needed')
  if (typeof d.longDescription !== 'string' || !d.longDescription.startsWith('<p>')) errors.push('description.json: longDescription must be HTML paragraphs')
  if (!Array.isArray(d.tags) || !d.tags.length || !d.tags.every((t) => typeof t === 'string' && /^[a-z0-9-]+$/.test(t))) errors.push('description.json: tags must be lowercase words')
  return errors
}

export function checkCompose(text, ctx) {
  if (text === null) return [`${COMPOSE} is missing`]
  const [doc, bad] = parse(text, COMPOSE)
  if (bad) return [bad]
  if (!isMap(doc)) return [`${COMPOSE} must be an object`]
  const errors = []
  if (!text.endsWith('\n')) errors.push('cosmos-compose.json must end with a newline')
  const top = Object.keys(doc).sort()
  if (!same(top, ['cosmos-installer', 'minVersion', 'services'])) errors.push(`cosmos-compose.json must have exactly cosmos-installer, minVersion and services, got: ${top.join(', ')}`)
  if (doc.minVersion !== MIN_VERSION) errors.push(`minVersion must be "${MIN_VERSION}" ({RootProtocol} needs it)`)

  // The setup token is generated ({Passwords.0}, 24 characters) and shown once after the install.
  const post = doc['cosmos-installer']?.['post-install']
  if (!Array.isArray(post) || !post.some((m) => typeof m?.label === 'string' && m.label.includes('{Passwords.0}') && m.label.includes(HOST))) {
    errors.push('cosmos-installer.post-install must show the address and the setup token ({Passwords.0})')
  }

  const services = isMap(doc.services) ? doc.services : {}
  if (!same(Object.keys(services), ['{ServiceName}'])) errors.push('services must be exactly one service, {ServiceName}')
  const svc = isMap(services['{ServiceName}']) ? services['{ServiceName}'] : {}
  const keys = Object.keys(svc).sort()
  if (!same(keys, SERVICE_KEYS)) errors.push(`the service must have exactly ${SERVICE_KEYS.join(', ')}, got: ${keys.join(', ')}`)
  if (svc.container_name !== '{ServiceName}') errors.push('container_name must be {ServiceName}')
  if (svc.restart !== 'unless-stopped') errors.push('restart must be unless-stopped')

  const labels = isMap(svc.labels) ? svc.labels : {}
  if (labels['cosmos-auto-update'] !== 'true') errors.push('the cosmos-auto-update label must be "true", so Cosmos installs each release of the stable tag')
  if (labels['cosmos-force-network-secured'] !== 'true') errors.push('the cosmos-force-network-secured label must be "true"')
  if (labels['cosmos-icon'] !== ICON_URL) errors.push(`the cosmos-icon label must be ${ICON_URL}`)
  const persistent = String(labels['cosmos-persistent-env'] ?? '').split(',').map((s) => s.trim()).sort()
  if (!same(persistent, ['OPENTODO_BASE_URL', 'OPENTODO_SETUP_TOKEN'])) errors.push('the cosmos-persistent-env label must keep OPENTODO_BASE_URL and OPENTODO_SETUP_TOKEN on reinstall')

  const vols = Array.isArray(svc.volumes) ? svc.volumes : []
  let dataTarget = null
  if (vols.length !== 1 || !same(Object.keys(vols[0] ?? {}).sort(), ['source', 'target', 'type']) || vols[0].type !== 'volume' || vols[0].source !== '{ServiceName}-data') {
    errors.push('volumes must be one named volume, {ServiceName}-data')
  } else {
    dataTarget = vols[0].target
  }

  const routes = Array.isArray(svc.routes) ? svc.routes : []
  let port = null
  if (routes.length !== 1) {
    errors.push('routes must be exactly one route')
  } else {
    const r = routes[0]
    const m = /^http:\/\/\{ServiceName\}:(\d+)$/.exec(r.target ?? '')
    if (!m) errors.push('the route target must be http://{ServiceName}:<port>')
    else port = Number(m[1])
    if (r.name !== '{ServiceName}') errors.push('the route name must be {ServiceName} (the base URL reads its host)')
    if (r.mode !== 'SERVAPP') errors.push('the route mode must be SERVAPP')
    if (r.useHost !== true) errors.push('the route must set useHost: true, so the install asks for the hostname')
  }

  const variables = new Map()
  if (!Array.isArray(svc.environment)) {
    errors.push('environment must be an array of "NAME=value"')
  } else {
    for (const e of svc.environment) {
      const eq = typeof e === 'string' ? e.indexOf('=') : -1
      if (eq < 1) { errors.push(`environment entry ${JSON.stringify(e)} must be NAME=value`); continue }
      const name = e.slice(0, eq)
      if (variables.has(name)) errors.push(`${name} is set twice`)
      variables.set(name, { default: e.slice(eq + 1), required: false })
    }
  }
  if (variables.has('OPENTODO_BASE_URL') && variables.get('OPENTODO_BASE_URL').default !== BASE_URL) errors.push(`OPENTODO_BASE_URL must be ${BASE_URL}, the address Cosmos serves`)
  if (variables.has('OPENTODO_SETUP_TOKEN') && variables.get('OPENTODO_SETUP_TOKEN').default !== '{Passwords.0}') errors.push('OPENTODO_SETUP_TOKEN must be {Passwords.0}, a password Cosmos generates')

  errors.push(...checkShared({ image: svc.image, port, dataTarget, variables, policy: 'stable' }, ctx))
  return errors
}

/** deploy/cosmos/upstream/servapps/OpenTodo/: identical copies, the icon and the screenshots. */
export function checkUpstream(root = ROOT) {
  const dir = join(root, UPSTREAM_DIR)
  if (!existsSync(dir)) return [`${UPSTREAM_DIR} is missing`]
  const errors = []
  const files = readdirSync(dir).sort()
  for (const f of UPSTREAM_FILES) if (!files.includes(f)) errors.push(`${UPSTREAM_DIR}/${f} is missing${f === 'screenshots' ? ' (the store deploy crashes without it)' : ''}`)
  for (const f of files) if (!UPSTREAM_FILES.includes(f)) errors.push(`${UPSTREAM_DIR}/${f} is not part of the servapp folder`)
  for (const [copy, source] of [['description.json', DESCRIPTION], ['cosmos-compose.json', COMPOSE]]) {
    if (files.includes(copy) && readText(`${UPSTREAM_DIR}/${copy}`, root) !== readText(source, root)) errors.push(`${UPSTREAM_DIR}/${copy} must be identical to ${source}`)
  }
  if (files.includes('icon.png')) {
    const s = pngSize(readFileSync(join(dir, 'icon.png')))
    if (!(s && s.width === s.height && s.width >= 128)) errors.push('icon.png must be a square PNG, at least 128 pixels')
  }
  const shots = join(dir, 'screenshots')
  if (existsSync(shots) && statSync(shots).isDirectory()) {
    const list = readdirSync(shots).sort()
    if (!list.length) errors.push('screenshots/ needs at least one screenshot')
    for (const f of list) {
      if (!/^\d+\.png$/.test(f) || !pngSize(readFileSync(join(shots, f)))) errors.push(`screenshots/${f} must be a PNG named 1.png, 2.png, ...`)
    }
  }
  return errors
}

export function check(ctx, root = ROOT) {
  return [
    ...checkDescription(readText(DESCRIPTION, root), ctx),
    ...checkCompose(readText(COMPOSE, root), ctx),
    ...checkUpstream(root),
  ]
}

export const summary = 'stable tag, route port, named volume, generated setup token, base URL, labels, description, icon, screenshots and upstream copy'
