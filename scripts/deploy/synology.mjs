// Synology DSM 7.2+ Container Manager project (deploy/synology/docker-compose.yml), OpenSpec
// change platform-catalogs. Synology has no store for containers: Package Center lists Synology's
// and third-party packages (native .spk builds, SynoCommunity among them), not compose apps. People
// create a Project in Container Manager with the path /volume1/docker/opentodo and paste this file.
//
// Rules from how DSM runs it: a relative bind mount ./data (the project path is the compose
// directory, so it is /volume1/docker/opentodo/data) that the user creates in File Station
// first; the container runs as the DSM account that owns that folder (user: "<uid>:<gid>",
// 1026:100 for the first account DSM creates), because shared folders belong to DSM users and
// not to the image's 65532; pull_policy: always, so Project -> Action -> Build pulls the moved
// stable tag (Container Manager shows no update notice for ghcr.io images). The YAML is parsed
// strictly by the repository's subset parser (yaml.mjs).

import { checkShared, isMap, readText, ROOT } from './common.mjs'
import { parseYaml } from './yaml.mjs'

export const TEMPLATE = 'deploy/synology/docker-compose.yml'
export const DOCS = 'docs/self-hosting/synology.md'
/** The uid:gid the template runs as: the first DSM account (1026) and DSM's "users" group (100). */
export const DEFAULT_USER = '1026:100'
export const PROJECT_PATH = '/volume1/docker/opentodo'
const SERVICE_KEYS = ['image', 'container_name', 'pull_policy', 'user', 'restart', 'ports', 'environment', 'volumes', 'healthcheck']
const HEALTH_KEYS = ['test', 'interval', 'timeout', 'retries', 'start_period']

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function checkTemplate(text, ctx) {
  if (text === null) return [`${TEMPLATE} is missing`]
  const { facts } = ctx
  const errors = []
  if (!text.endsWith('\n')) errors.push('the compose file must end with a newline')
  let doc
  try {
    doc = parseYaml(text)
  } catch (e) {
    return [`the compose file is not in the supported YAML subset: ${e.message}`]
  }
  if (!isMap(doc) || Object.keys(doc).join() !== 'services') {
    return [...errors, 'the compose file has only services (no version:, no named volumes or networks: the data is a bind mount)']
  }
  const names = Object.keys(doc.services ?? {})
  if (names.join() !== 'opentodo') return [...errors, 'one service, opentodo']
  const s = doc.services.opentodo
  for (const k of Object.keys(s)) if (!SERVICE_KEYS.includes(k)) errors.push(`service: unexpected key "${k}"`)
  for (const k of SERVICE_KEYS) if (s[k] === undefined) errors.push(`service: "${k}" is required`)
  if (s.container_name !== 'opentodo') errors.push('container_name must be opentodo (the name Container Manager lists)')
  if (s.pull_policy !== 'always') errors.push('pull_policy must be always, so Build pulls the current stable image')
  if (s.restart !== 'unless-stopped') errors.push('restart must be unless-stopped')
  if (typeof s.user !== 'string' || !/^\d+:\d+$/.test(s.user)) errors.push('user must be a quoted "uid:gid"')
  else if (s.user !== DEFAULT_USER) errors.push(`user must be "${DEFAULT_USER}" (the first DSM account and the users group, not the image's ${facts.user}); the guide tells people how to put theirs`)

  let port = null
  if (!Array.isArray(s.ports) || s.ports.length !== 1 || typeof s.ports[0] !== 'string') errors.push('ports: publish exactly one port, as a quoted "host:container"')
  else {
    const m = /^(\d+):(\d+)$/.exec(s.ports[0])
    if (!m) errors.push('ports: "host:container", without a host IP or protocol')
    else {
      port = m[2]
      if (m[1] !== m[2]) errors.push('ports: the default host port is the container port, 8080')
    }
  }
  let dataTarget = null
  if (!Array.isArray(s.volumes) || s.volumes.length !== 1 || typeof s.volumes[0] !== 'string') errors.push('volumes: exactly one bind mount, ./data:/data')
  else {
    const [src, target, ...rest] = s.volumes[0].split(':')
    dataTarget = target ?? null
    if (src !== './data') errors.push(`volumes: the source must be ./data, the data folder in the project path (${PROJECT_PATH}/data), got ${src}`)
    if (rest.length) errors.push('volumes: no mount options')
  }
  const h = s.healthcheck
  if (!isMap(h)) errors.push('healthcheck is required')
  else {
    for (const k of Object.keys(h)) if (!HEALTH_KEYS.includes(k)) errors.push(`healthcheck: unexpected key "${k}"`)
    if (!eq(h.test, ['CMD', ...facts.healthcheck])) errors.push(`healthcheck: test must be ${JSON.stringify(['CMD', ...facts.healthcheck])} (the image has no shell)`)
  }

  const variables = new Map()
  if (!isMap(s.environment)) errors.push('environment must be a map of NAME: "value"')
  else {
    for (const [name, value] of Object.entries(s.environment)) {
      if (typeof value !== 'string') { errors.push(`environment ${name}: quote the value ("${value}")`); continue }
      if (!name.startsWith('OPENTODO_')) { errors.push(`environment: ${name} is not read by OpenTodo`); continue }
      const entry = facts.variables.find((v) => v.name === name)
      if (entry?.secret && value !== '') errors.push(`environment ${name}: never ship a default secret`)
      if (name === 'OPENTODO_BASE_URL' && value !== '') errors.push('environment OPENTODO_BASE_URL must be empty: the project starts on plain http, where an https address breaks sign-in')
      variables.set(name, { default: value, required: false })
    }
  }
  errors.push(...checkShared({ image: s.image, port, dataTarget, variables, policy: 'stable' }, ctx))
  return errors
}

/** The guide must show the template it describes, line for line. */
export function checkDocs(docs, template) {
  if (docs === null) return [`${DOCS} is missing`]
  if (template === null) return []
  const block = template.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => '   ' + l).join('\n')
  return docs.includes(block) ? [] : [`${DOCS} must show ${TEMPLATE} (without its comments) in its install steps, indented by three spaces`]
}

export function check(ctx, root = ROOT) {
  const template = readText(TEMPLATE, root)
  return [...checkTemplate(template, ctx), ...checkDocs(readText(DOCS, root), template)]
}

export const summary = 'Container Manager project: stable tag with pull_policy always, DSM user, port 8080, ./data bind mount on /data, health check, restart policy'
