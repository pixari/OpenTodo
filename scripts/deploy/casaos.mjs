// CasaOS / ZimaOS app store template (deploy/casaos/docker-compose.yml), OpenSpec change
// platform-catalogs. The store (IceWhaleTech/CasaOS-AppStore) takes one folder per app,
// Apps/OpenTodo/, with the compose file and its icon, thumbnail and screenshots;
// deploy/casaos/upstream/ holds that folder file for file. The store refuses moving tags
// and pins digests itself, and installs only update when x-casaos.version changes, so the
// image names the latest release (policy 'release') and the version must equal its tag.
//
// The compose file is parsed by the shared strict YAML subset parser (scripts/deploy/yaml.mjs)
// with the YAML_CASAOS profile: typed scalars, literal block scalars only, dates quoted.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkShared, isMap, pngSize, readText, ROOT, same } from './common.mjs'
import { parseYaml as parseSubset, YAML_CASAOS } from './yaml.mjs'

export const TEMPLATE = 'deploy/casaos/docker-compose.yml'
export const UPSTREAM_DIR = 'deploy/casaos/upstream/Apps/OpenTodo'
export const UPSTREAM_TEMPLATE = `${UPSTREAM_DIR}/docker-compose.yml`
export const ICON_SOURCE = 'deploy/coolify/opentodo.svg'
export const CDN = 'https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@main/Apps/OpenTodo/'
export const APP_ID = 'app.open-todo.opentodo'
export const DATA_SOURCE = '/DATA/AppData/$AppID/data'
export const UPSTREAM_FILES = ['docker-compose.yml', 'icon.png', 'icon.svg', 'screenshot-1.png', 'screenshot-2.png', 'thumbnail.png']
export const CATEGORIES = ['Media', 'Productivity', 'Home', 'Networking', 'AI', 'Finance', 'Social', 'Developer', 'Others']

// ---- strict YAML subset (scripts/deploy/yaml.mjs, profile YAML_CASAOS) -------------------

export const parseYaml = (text) => parseSubset(text, YAML_CASAOS)

// ---- checks ---------------------------------------------------------------------------

export { pngSize }

export function checkTemplate(text, ctx) {
  if (text === null) return [`${TEMPLATE} is missing`]
  const errors = []
  if (!text.endsWith('\n')) errors.push('the compose file must end with a newline')
  let doc
  try {
    doc = parseYaml(text)
  } catch (e) {
    return [...errors, `the compose file is not in the supported YAML subset: ${e.message}`]
  }
  for (const k of Object.keys(doc)) if (!['name', 'services', 'x-casaos'].includes(k)) errors.push(`unexpected top-level key ${k}`)
  if (doc.name !== 'opentodo') errors.push('the top-level name must be opentodo (the store requires ^[a-z0-9_-]+$)')

  const services = isMap(doc.services) ? doc.services : {}
  const names = Object.keys(services).sort()
  if (!same(names, ['opentodo', 'opentodo-init'])) errors.push(`services must be opentodo and opentodo-init, got: ${names.join(', ')}`)
  const svc = isMap(services.opentodo) ? services.opentodo : {}
  const init = isMap(services['opentodo-init']) ? services['opentodo-init'] : {}

  // The app service.
  if (svc.container_name !== 'opentodo') errors.push('opentodo: container_name must be opentodo')
  if (svc.restart !== 'unless-stopped') errors.push('opentodo: restart must be unless-stopped')
  if (svc.network_mode !== 'bridge') errors.push('opentodo: network_mode must be bridge')
  if (svc.user !== undefined) errors.push('opentodo: do not set user; the image runs as 65532 and the init service prepares /data for it')
  if (!same(svc.depends_on, { 'opentodo-init': { condition: 'service_completed_successfully' } })) {
    errors.push('opentodo: depends_on must wait for opentodo-init with condition service_completed_successfully')
  }
  if (!same(svc.healthcheck?.test, ['CMD', ...ctx.facts.healthcheck])) errors.push(`opentodo: healthcheck.test must be ["CMD", ${ctx.facts.healthcheck.map((s) => JSON.stringify(s)).join(', ')}]`)
  const ports = Array.isArray(svc.ports) ? svc.ports : []
  let port = null
  let published = null
  if (ports.length !== 1 || !isMap(ports[0])) {
    errors.push('opentodo: ports must be exactly one entry in the long syntax (target, published, protocol)')
  } else {
    port = ports[0].target
    published = ports[0].published
    if (typeof port !== 'number') errors.push('opentodo: ports[0].target must be a number')
    if (typeof published !== 'string' || !/^\d+$/.test(published)) errors.push('opentodo: ports[0].published must be a quoted port number')
    else if (published === String(ctx.facts.port)) errors.push(`opentodo: publish another port than ${ctx.facts.port}, which many CasaOS apps already use`)
    if (ports[0].protocol !== 'tcp') errors.push('opentodo: ports[0].protocol must be tcp')
  }
  const dataVolume = (v) => same(Object.keys(v ?? {}).sort(), ['source', 'target', 'type']) && v.type === 'bind' && v.source === DATA_SOURCE
  const vols = Array.isArray(svc.volumes) ? svc.volumes : []
  let dataTarget = null
  if (vols.length !== 1 || !dataVolume(vols[0])) errors.push(`opentodo: volumes must be one bind mount of ${DATA_SOURCE}`)
  else dataTarget = vols[0].target

  const env = svc.environment
  const variables = new Map()
  if (!isMap(env)) {
    errors.push('opentodo: environment must be a map of NAME: "value"')
  } else {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value !== 'string') errors.push(`opentodo: the value of ${name} must be a quoted string`)
      variables.set(name, { default: String(value ?? ''), required: false })
    }
  }

  // The service's x-casaos block: a description for every variable, the port and the volume.
  const sx = isMap(svc['x-casaos']) ? svc['x-casaos'] : {}
  const envs = new Map((Array.isArray(sx.envs) ? sx.envs : []).map((e) => [e?.container, e?.description?.en_US]))
  for (const name of variables.keys()) {
    const entry = ctx.facts.variables.find((v) => v.name === name)
    if (!envs.has(name)) errors.push(`opentodo: x-casaos.envs needs a description of ${name}`)
    else if (entry && envs.get(name) !== entry.description) errors.push(`opentodo: the description of ${name} must be the catalogue's (deploy/deploy.json)`)
  }
  for (const name of envs.keys()) if (!variables.has(name)) errors.push(`opentodo: x-casaos.envs describes ${name}, which is not in environment`)
  const xPorts = Array.isArray(sx.ports) ? sx.ports : []
  if (xPorts.length !== 1 || xPorts[0]?.container !== String(port) || !xPorts[0]?.description?.en_US) errors.push('opentodo: x-casaos.ports must describe the container port (as a quoted string)')
  const xVols = Array.isArray(sx.volumes) ? sx.volumes : []
  if (xVols.length !== 1 || xVols[0]?.container !== dataTarget || !xVols[0]?.description?.en_US) errors.push('opentodo: x-casaos.volumes must describe the data volume')

  // The one-shot init service: Docker creates the bind source as root; the image has no shell.
  if (typeof init.image !== 'string' || !/^busybox:\d+\.\d+\.\d+$/.test(init.image)) errors.push('opentodo-init: image must be busybox pinned to a version, such as busybox:1.37.0')
  if (init.user !== '0:0') errors.push('opentodo-init: user must be "0:0"')
  if (!same(init.command, ['chown', '-R', ctx.facts.user, ctx.facts.dataDir])) errors.push(`opentodo-init: command must be ["chown", "-R", "${ctx.facts.user}", "${ctx.facts.dataDir}"]`)
  if (init.restart !== 'no') errors.push('opentodo-init: restart must be "no"')
  if (init.network_mode !== 'none') errors.push('opentodo-init: network_mode must be none')
  if (!same(init.volumes, svc.volumes)) errors.push('opentodo-init: volumes must be the same bind mount as opentodo')

  // The store metadata.
  const x = isMap(doc['x-casaos']) ? doc['x-casaos'] : {}
  const f = ctx.facts
  const want = {
    id: APP_ID, main: 'opentodo', index: '/', scheme: 'http', category: 'Productivity',
    icon: `${CDN}icon.svg`, thumbnail: `${CDN}thumbnail.png`,
    website: f.project, repo: f.repository, support: f.support, docs: f.docs,
  }
  for (const [k, v] of Object.entries(want)) if (x[k] !== v) errors.push(`x-casaos.${k} must be ${v}`)
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(String(x.id ?? ''))) errors.push('x-casaos.id must be reverse-domain')
  if (x.category && !CATEGORIES.includes(x.category)) errors.push(`x-casaos.category must be one of ${CATEGORIES.join(', ')}`)
  if (typeof x.port_map !== 'string') errors.push('x-casaos.port_map must be a quoted string')
  else if (x.port_map !== published) errors.push('x-casaos.port_map must equal the published port')
  if (!same(x.screenshot_link, [`${CDN}screenshot-1.png`, `${CDN}screenshot-2.png`])) errors.push(`x-casaos.screenshot_link must list ${CDN}screenshot-1.png and screenshot-2.png`)
  if (x.title?.en_US !== f.name) errors.push(`x-casaos.title.en_US must be ${f.name}`)
  for (const k of ['tagline', 'description', 'release_notes']) if (!x[k]?.en_US) errors.push(`x-casaos.${k}.en_US is needed`)
  if (!x.tips?.before_install?.en_US) errors.push('x-casaos.tips.before_install.en_US is needed (who becomes the owner)')
  for (const k of ['author', 'developer']) if (typeof x[k] !== 'string' || !x[k]) errors.push(`x-casaos.${k} is needed`)
  if (!same(x.architectures, ['amd64', 'arm64'])) errors.push('x-casaos.architectures must be [amd64, arm64], the image platforms')
  if (typeof x.update_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.update_at)) errors.push('x-casaos.update_at must be a quoted YYYY-MM-DD date')
  // Installs only update when version changes, so it must name the image's release.
  const tag = typeof svc.image === 'string' ? svc.image.split(':')[1] : undefined
  if (typeof x.version !== 'string') errors.push('x-casaos.version must be a quoted string')
  else if (x.version !== tag) errors.push(`x-casaos.version must equal the image tag (${tag}), so installs are offered the update`)

  errors.push(...checkShared({ image: svc.image, port, dataTarget, variables, policy: 'release' }, ctx))
  return errors
}

/** deploy/casaos/upstream/Apps/OpenTodo/: the template copy and the store assets. */
export function checkUpstream(template, root = ROOT) {
  const dir = join(root, UPSTREAM_DIR)
  if (!existsSync(dir)) return [`${UPSTREAM_DIR} is missing`]
  const errors = []
  const files = readdirSync(dir).sort()
  for (const f of UPSTREAM_FILES) if (!files.includes(f)) errors.push(`${UPSTREAM_DIR}/${f} is missing`)
  for (const f of files) if (!UPSTREAM_FILES.includes(f)) errors.push(`${UPSTREAM_DIR}/${f} is not part of the store folder`)
  if (files.includes('docker-compose.yml') && readText(UPSTREAM_TEMPLATE, root) !== template) errors.push(`${UPSTREAM_TEMPLATE} must be identical to ${TEMPLATE}`)
  if (files.includes('icon.svg') && readText(`${UPSTREAM_DIR}/icon.svg`, root) !== readText(ICON_SOURCE, root)) errors.push(`${UPSTREAM_DIR}/icon.svg must be identical to ${ICON_SOURCE}`)
  const size = (f) => (files.includes(f) ? pngSize(readFileSync(join(dir, f))) : null)
  const icon = size('icon.png')
  if (files.includes('icon.png') && !(icon && icon.width === 256 && icon.height === 256)) errors.push('icon.png must be a 256x256 PNG')
  const thumb = size('thumbnail.png')
  if (files.includes('thumbnail.png') && !(thumb && Math.abs(thumb.width / thumb.height - 1176 / 663) < 0.02 && thumb.width >= 1000)) errors.push('thumbnail.png must be a PNG of about 1176x663')
  for (const f of ['screenshot-1.png', 'screenshot-2.png']) {
    const s = size(f)
    if (files.includes(f) && !(s && s.width === 1280)) errors.push(`${f} must be a PNG 1280 pixels wide`)
  }
  return errors
}

export function check(ctx, root = ROOT) {
  const template = readText(TEMPLATE, root)
  if (template === null) return [`${TEMPLATE} is missing`]
  return [...checkTemplate(template, ctx), ...checkUpstream(template, root)]
}

export const summary = 'release tag and x-casaos.version, port, AppData bind and init, variables, store metadata, assets and upstream copy'
