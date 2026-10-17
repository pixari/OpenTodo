// Render Blueprint (deploy/render/render.yaml), OpenSpec change platform-catalogs.
// Render has no app store: people deploy a Blueprint from a Git repository, here with the
// "Deploy to Render" button, which opens https://dashboard.render.com/blueprint/new with
// repo= and path= (the Blueprint path field; the file need not be at the repository root).
// The fields below are the ones Render's Blueprint reference and its JSON Schema
// (https://render.com/docs/blueprint-spec, https://render.com/schema/render.yaml.json) define for
// a web service; anything else is refused, and so is a field the schema knows but this template
// must not use (a Git build, scaling, which a disk forbids, or the free plan, which has no disks).
// The YAML is parsed strictly by the repository's subset parser (yaml.mjs).

import { checkShared, isMap, readText, ROOT } from './common.mjs'
import { parseYaml } from './yaml.mjs'

export const BLUEPRINT = 'deploy/render/render.yaml'
export const DOCS = 'docs/self-hosting/render.md'
export const README = 'deploy/render/README.md'
/** The button target: Render's deploy URL with the repository and the Blueprint path in it. */
export const BUTTON_URL = 'https://render.com/deploy?repo=https://github.com/pixari/opentodo&path=deploy/render/render.yaml'

/** Every field of a web/worker/pserv service in render.yaml.json (serverService). */
export const SCHEMA_SERVICE_FIELDS = [
  'autoDeploy', 'autoDeployTrigger', 'branch', 'buildCommand', 'buildFilter', 'buildSource', 'disk', 'dockerCommand',
  'dockerContext', 'dockerfilePath', 'domain', 'domains', 'envVars', 'healthCheckPath', 'image', 'initialDeployHook',
  'ipAllowList', 'maintenanceMode', 'maxShutdownDelaySeconds', 'name', 'numInstances', 'plan', 'preDeployCommand',
  'previewPlan', 'previews', 'pullRequestPreviewsEnabled', 'region', 'registryCredential', 'renderSubdomainPolicy',
  'repo', 'rootDir', 'runtime', 'scaling', 'startCommand', 'type',
]
/** The ones this template may use. */
export const SERVICE_FIELDS = ['type', 'name', 'runtime', 'image', 'plan', 'region', 'healthCheckPath', 'disk', 'envVars']
export const ROOT_FIELDS = ['services', 'databases', 'envVarGroups', 'previews', 'projects', 'ungrouped', 'version', 'buildSources', 'previewsEnabled', 'previewsExpireAfterDays']
/** serverPlan in render.yaml.json; "free" has no persistent disk. */
export const PLANS = ['free', 'starter', 'standard', 'pro', 'pro plus', 'pro max', 'pro ultra', '0.5c-512mb', '1c-2g', '2c-4g', '2c-8g', '2c-16g', '4c-8g', '4c-16g', '4c-32g', '8c-16g', '8c-32g', '8c-64g', '12c-24g', '12c-48g', '12c-96g']
export const REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore']
/** Variables the template must set this way. */
const SERVICE_NAME = 'opentodo'
const KEY_VALUE_FIELDS = ['key', 'value', 'generateValue', 'sync', 'previewValue']
const FROM_SERVICE_FIELDS = ['name', 'type', 'property', 'envVarKey']


export function checkBlueprint(text, ctx) {
  if (text === null) return [`${BLUEPRINT} is missing`]
  const errors = []
  if (!text.endsWith('\n')) errors.push('render.yaml must end with a newline')
  let doc
  try {
    doc = parseYaml(text)
  } catch (e) {
    return [`render.yaml is not in the supported YAML subset: ${e.message}`]
  }
  if (!isMap(doc)) return ['render.yaml must be a map with services']
  for (const k of Object.keys(doc)) {
    if (!ROOT_FIELDS.includes(k)) errors.push(`render.yaml: "${k}" is not a Blueprint root field`)
    else if (k !== 'services') errors.push(`render.yaml: only services, no "${k}" (OpenTodo needs no database or group)`)
  }
  if (!Array.isArray(doc.services) || doc.services.length !== 1) return [...errors, 'render.yaml: services must hold exactly one service']
  const s = doc.services[0]
  if (!isMap(s)) return [...errors, 'render.yaml: the service must be a map']
  for (const k of Object.keys(s)) {
    if (!SCHEMA_SERVICE_FIELDS.includes(k)) errors.push(`service: "${k}" is not a Render Blueprint field`)
    else if (!SERVICE_FIELDS.includes(k)) {
      const why = { numInstances: ' (a service with a disk runs one instance)', scaling: ' (a service with a disk cannot scale)' }[k] ?? ''
      errors.push(`service: this template does not use "${k}"${why}`)
    }
  }
  if (s.type !== 'web') errors.push('service: type must be web (reachable on its onrender.com address)')
  if (s.name !== SERVICE_NAME) errors.push(`service: name must be ${SERVICE_NAME}`)
  if (s.runtime !== 'image') errors.push('service: runtime must be image (pull the released image, no build)')
  let image = null
  if (!isMap(s.image) || Object.keys(s.image).join() !== 'url' || typeof s.image.url !== 'string') {
    errors.push('service: image must be { url: <image> } (a public image needs no creds)')
  } else image = s.image.url
  if (!PLANS.includes(s.plan)) errors.push(`service: plan must be one of Render's plan ids (${PLANS.join(', ')}), got ${s.plan}`)
  else if (s.plan === 'free') errors.push('service: plan cannot be free: Free web services have no persistent disk, and the data would be lost on every restart')
  if (s.region !== undefined && !REGIONS.includes(s.region)) errors.push(`service: region must be one of ${REGIONS.join(', ')}`)
  if (s.healthCheckPath !== '/healthz') errors.push('service: healthCheckPath must be /healthz')

  let dataTarget = null
  const d = s.disk
  if (!isMap(d)) errors.push('service: a disk is required, or the database is lost on every deploy')
  else {
    for (const k of Object.keys(d)) if (!['name', 'mountPath', 'sizeGB'].includes(k)) errors.push(`disk: "${k}" is not a disk field`)
    if (typeof d.name !== 'string' || !d.name) errors.push('disk: name is required')
    if (d.sizeGB !== undefined && (!Number.isInteger(d.sizeGB) || d.sizeGB < 1)) errors.push('disk: sizeGB must be a whole number of at least 1')
    dataTarget = d.mountPath ?? null
  }

  let port = null
  const variables = new Map()
  const seen = new Set()
  for (const e of Array.isArray(s.envVars) ? s.envVars : []) {
    if (!isMap(e) || typeof e.key !== 'string' || !e.key) { errors.push('envVars: every entry needs a key (no fromGroup)'); continue }
    const name = e.key
    if (seen.has(name)) errors.push(`envVars: ${name} is listed twice`)
    seen.add(name)
    let def
    let platformValue = false
    if ('fromService' in e) {
      for (const k of Object.keys(e)) if (k !== 'key' && k !== 'fromService') errors.push(`envVars ${name}: "${k}" cannot go with fromService`)
      const f = e.fromService
      if (!isMap(f)) { errors.push(`envVars ${name}: fromService must be a map`); continue }
      for (const k of Object.keys(f)) if (!FROM_SERVICE_FIELDS.includes(k)) errors.push(`envVars ${name}: fromService."${k}" is not a field`)
      platformValue = true
      if (name === 'OPENTODO_BASE_URL') {
        if (f.name !== SERVICE_NAME || f.type !== 'web' || f.envVarKey !== 'RENDER_EXTERNAL_URL' || 'property' in f) {
          errors.push(`envVars OPENTODO_BASE_URL: must reference the service itself, fromService { name: ${SERVICE_NAME}, type: web, envVarKey: RENDER_EXTERNAL_URL } (its https onrender.com address)`)
        }
      } else errors.push(`envVars ${name}: only OPENTODO_BASE_URL comes from fromService`)
    } else {
      for (const k of Object.keys(e)) {
        if (!KEY_VALUE_FIELDS.includes(k)) errors.push(`envVars ${name}: "${k}" is not an envVars field${k === 'fromDatabase' ? ' (OpenTodo has no database service)' : ''}`)
      }
      if ('previewValue' in e) errors.push(`envVars ${name}: no previewValue (no preview environments)`)
      if (e.generateValue !== undefined) {
        if (e.generateValue !== true || 'value' in e || 'sync' in e) errors.push(`envVars ${name}: generateValue: true stands alone`)
        if (name !== 'OPENTODO_SETUP_TOKEN') errors.push(`envVars ${name}: only OPENTODO_SETUP_TOKEN is generated`)
        platformValue = true
      } else if (e.sync !== undefined) {
        errors.push(`envVars ${name}: give a value instead of sync: false (Render prompts for those only when the Blueprint is created)`)
      } else if (typeof e.value !== 'string') {
        errors.push(`envVars ${name}: value must be a quoted string`)
      } else def = e.value
    }
    if (name === 'OPENTODO_SETUP_TOKEN' && e.generateValue !== true) errors.push('envVars OPENTODO_SETUP_TOKEN: must be generateValue: true, so every service gets its own token')
    if (name === 'OPENTODO_BASE_URL' && !('fromService' in e)) errors.push('envVars OPENTODO_BASE_URL: must come from the service (fromService, RENDER_EXTERNAL_URL)')
    if (name === 'PORT') { port = def ?? null; continue }
    if (!name.startsWith('OPENTODO_')) { errors.push(`envVars: ${name} is not read by OpenTodo`); continue }
    variables.set(name, { default: def, required: false, platformValue })
  }
  if (!seen.has('PORT')) errors.push('envVars: PORT must be set to the container port, so Render routes to it')
  errors.push(...checkShared({ image, port, dataTarget, variables, policy: 'stable' }, ctx))
  return errors
}

/** The README and the guide must carry the button URL. */
export function checkLinks(readme, docs) {
  const errors = []
  if (readme === null) errors.push(`${README} is missing`)
  else if (!readme.includes(BUTTON_URL)) errors.push(`${README} must link the Deploy to Render button: ${BUTTON_URL}`)
  if (docs === null) errors.push(`${DOCS} is missing`)
  else if (!docs.includes(BUTTON_URL)) errors.push(`${DOCS} must link the Deploy to Render button: ${BUTTON_URL}`)
  return errors
}

export function check(ctx, root = ROOT) {
  return [...checkBlueprint(readText(BLUEPRINT, root), ctx), ...checkLinks(readText(README, root), readText(DOCS, root))]
}

export const summary = 'Blueprint with one image web service, stable tag, PORT, /data disk on a paid plan, /healthz, self-referenced base URL and generated setup token'
