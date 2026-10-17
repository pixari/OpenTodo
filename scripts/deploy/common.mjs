// Shared rules for every platform template in deploy/<platform>/ (OpenSpec change
// unraid-template). A platform checker (scripts/deploy/<platform>.mjs) parses its
// own format and passes what it found to checkShared(); the facts every template
// must agree on are in deploy/deploy.json.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function readText(rel, root = ROOT) {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** Every file under `dir`, recursively, as absolute paths. */
export function listFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? listFiles(p) : [p]
  })
}

export const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Width and height of a PNG file, or null when it is not one. */
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export function loadFacts(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'deploy/deploy.json'), 'utf8'))
}

/** The newest released version in CHANGELOG.md. */
export function latestRelease(changelog) {
  const m = /^## \[(\d+)\.(\d+)\.(\d+)\]/m.exec(changelog)
  if (!m) throw new Error('CHANGELOG.md has no released version')
  return { major: m[1], minor: m[2], patch: m[3] }
}

/** Every OPENTODO_* name written as a string literal in internal/config (tests excluded). */
export function configVariables(root = ROOT) {
  const dir = join(root, 'internal/config')
  const names = new Set()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/"(OPENTODO_[A-Z0-9_]+)"/g)) names.add(m[1])
  }
  return names
}

/** Problems with the catalogue itself: names the server does not read, duplicates. */
export function checkFacts(facts, configVars) {
  const errors = []
  const seen = new Set()
  for (const v of facts.variables ?? []) {
    if (seen.has(v.name)) errors.push(`deploy/deploy.json lists ${v.name} twice`)
    seen.add(v.name)
    if (!configVars.has(v.name)) errors.push(`deploy/deploy.json lists ${v.name}, which internal/config does not read`)
    if (typeof v.default !== 'string') errors.push(`deploy/deploy.json: ${v.name} needs a string default ("" for none)`)
    if (!v.description) errors.push(`deploy/deploy.json: ${v.name} needs a description`)
  }
  return errors
}

/**
 * The image a template names (OpenSpec changes stable-image-tag and platform-catalogs).
 * policy 'stable' (default): <image>:<tag from deploy.json>, the tag every release moves.
 * policy 'release': <image>:<latest release in CHANGELOG.md>, for stores that refuse moving tags.
 * policy 'release-digest': the same plus @sha256:<digest> of that release (Umbrel); the digest itself
 * is refreshed after a release by `node scripts/deploy/pin.mjs` and only its shape is checked here.
 */
export function checkImage(image, facts, policy = 'stable', changelog = null) {
  if (policy === 'stable') {
    const want = `${facts.image}:${facts.tag}`
    return image === want ? [] : [`image must be ${want} (the tag every release moves), got: ${image}`]
  }
  if (!changelog) return ['CHANGELOG.md is needed to check a pinned image']
  const rel = latestRelease(changelog)
  const version = `${rel.major}.${rel.minor}.${rel.patch}`
  const want = `${facts.image}:${version}`
  if (policy === 'release') {
    return image === want ? [] : [`image must be ${want}, the latest release in CHANGELOG.md (this store refuses moving tags), got: ${image}`]
  }
  if (policy === 'release-digest') {
    return new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@sha256:[0-9a-f]{64}$`).test(image ?? '')
      ? []
      : [`image must be ${want}@sha256:<index digest>, the latest release pinned by digest (run node scripts/deploy/pin.mjs after the release), got: ${image}`]
  }
  return [`unknown image policy ${policy}`]
}

/** The release job must keep publishing the tag the templates name. */
export function checkPublishesTag(ciWorkflow, facts) {
  if (ciWorkflow === null) return ['.github/workflows/ci.yml is missing']
  const re = new RegExp(`type=raw,value=${facts.tag},enable=\\$\\{\\{[^}]*refs/tags/v`)
  return re.test(ciWorkflow) ? [] : [`the image job in .github/workflows/ci.yml no longer publishes the "${facts.tag}" tag on releases, but every template names it`]
}

/**
 * The rules every template shares. `found` is what the platform checker read:
 *   { image, port, dataTarget, variables: Map<name, { default, required, platformValue }> }
 * `platformValue` marks a value the platform fills (Coolify's ${SERVICE_URL_*}), compared only
 * for catalogue entries without platformDefault.
 */
export function checkShared(found, { facts, changelog, configVars }) {
  const errors = [...checkImage(found.image, facts, found.policy, changelog)]
  if (String(found.port) !== String(facts.port)) errors.push(`the container port must be ${facts.port}, got ${found.port}`)
  if (found.dataTarget !== facts.dataDir) errors.push(`the data must be mounted on ${facts.dataDir}, got ${found.dataTarget}`)
  const catalogue = new Map((facts.variables ?? []).map((v) => [v.name, v]))
  for (const [name, v] of found.variables) {
    if (!name.startsWith('OPENTODO_')) continue
    if (!configVars.has(name)) { errors.push(`${name} is not read by internal/config`); continue }
    const entry = catalogue.get(name)
    if (!entry) { errors.push(`${name} is not in the variable catalogue (deploy/deploy.json); add it there first`); continue }
    if (v.required) errors.push(`${name} must not be required: OpenTodo needs no variables`)
    if (!entry.platformDefault && v.default !== entry.default) {
      errors.push(`${name} defaults to ${JSON.stringify(v.default)}, the catalogue says ${JSON.stringify(entry.default)}`)
    }
  }
  for (const entry of catalogue.values()) {
    if (entry.essential && !found.variables.has(entry.name)) errors.push(`${entry.name} must be offered (essential in deploy/deploy.json)`)
  }
  return errors
}
