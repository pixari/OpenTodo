// CapRover one-click app (deploy/caprover/opentodo.yml), OpenSpec change platform-catalogs.
// The format is caprover/one-click-apps' v4: a Docker Compose subset with captainVersion 4 and a
// caproverOneClickApp section (variables, instructions, display data). CapRover substitutes every
// variable id in the stringified template (split/join, in declaration order, after $$cap_appname),
// reads only image, environment (a map), volumes, ports, depends_on, hostname, command and cap_add of
// a service plus caproverExtra, and turns a volume whose source does not start with "/" into a named
// volume. deploy/caprover/upstream/ holds byte-identical copies at the paths they take in that
// repository (public/v4/apps/<name>.yml, public/v4/logos/<name>.png). Their PR checklist asks for a
// fixed version rather than a moving tag, so the image is the release, chosen by a version variable.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkShared, readText, ROOT } from './common.mjs'
import { parseYaml } from './yaml.mjs'

export const NAME = 'opentodo'
export const TEMPLATE = 'deploy/caprover/opentodo.yml'
export const UPSTREAM = 'deploy/caprover/upstream'
export const UPSTREAM_APP = `${UPSTREAM}/public/v4/apps/${NAME}.yml`
export const UPSTREAM_LOGO = `${UPSTREAM}/public/v4/logos/${NAME}.png`
export const LOGO_SOURCE = 'web/public/pwa-512.png'
export const PR = `${UPSTREAM}/PR.md`
export const DOCS = 'https://open-todo.app/docs/self-hosting/caprover/'
export const VERSION_VAR = '$$cap_opentodo_version'
export const IMAGE = `ghcr.io/pixari/opentodo:${VERSION_VAR}`
const BUILTINS = ['$$cap_appname', '$$cap_root_domain']
const SERVICE_KEYS = ['image', 'environment', 'volumes', 'caproverExtra']
const APP_KEYS = ['variables', 'instructions', 'displayName', 'isOfficial', 'description', 'documentation']
const VAR_KEYS = ['id', 'label', 'defaultValue', 'description', 'validRegex']

/** The validRegex check CapRover's form runs (OneClickVariablesSection.tsx): "/body/flags". */
export function capRegex(validRegex) {
  const parts = /\/(.*)\/(.*)/.exec(validRegex)
  if (!parts) throw new Error(`validRegex must be written /.../flags, got ${validRegex}`)
  return new RegExp(parts[1], parts[2])
}

/** Parses the template and returns what it describes, or throws on anything outside the format. */
export function checkTemplate(text, ctx) {
  if (text === null) return { errors: [`${TEMPLATE} is missing`] }
  const errors = []
  if (!text.endsWith('\n')) errors.push('the template must end with a newline')
  let doc
  try {
    doc = parseYaml(text)
  } catch (e) {
    return { errors: [...errors, `${TEMPLATE} is not in the supported YAML subset: ${e.message}`] }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['the template must be a YAML map'] }
  for (const k of Object.keys(doc)) if (!['captainVersion', 'services', 'caproverOneClickApp'].includes(k)) errors.push(`top-level "${k}" is not part of a v4 one-click app`)
  if (doc.captainVersion !== 4) errors.push('captainVersion must be 4')

  // ---- the service --------------------------------------------------------------------------
  const names = Object.keys(doc.services ?? {})
  if (names.length !== 1 || names[0] !== '$$cap_appname') errors.push(`one service, named $$cap_appname (got: ${names.join(', ') || 'none'})`)
  const svc = doc.services?.$$cap_appname ?? {}
  for (const k of Object.keys(svc)) {
    if (k === 'ports') errors.push('service: no "ports": CapRover proxies the app on containerHttpPort, a published port would bypass it')
    else if (!SERVICE_KEYS.includes(k)) errors.push(`service: "${k}" is not used (CapRover reads only image, environment, volumes and caproverExtra here)`)
  }
  if (svc.image !== IMAGE) errors.push(`service: image must be ${IMAGE}, so the version variable chooses the release`)
  const extra = svc.caproverExtra ?? {}
  for (const k of Object.keys(extra)) if (k !== 'containerHttpPort') errors.push(`caproverExtra: "${k}" is not needed`)
  if (typeof extra.containerHttpPort !== 'string') errors.push("caproverExtra.containerHttpPort must be a quoted string such as '8080'")
  const vols = svc.volumes ?? []
  const vol = vols.length === 1 && typeof vols[0] === 'string' ? /^\$\$cap_appname-data:(\/[^:]*)$/.exec(vols[0]) : null
  if (!vol) errors.push('service: mount exactly one named volume, $$cap_appname-data:/data (a source starting with / would be a host path, created owned by root)')
  const env = svc.environment
  if (env === null || typeof env !== 'object' || Array.isArray(env)) errors.push('service: environment must be a map of NAME: value (CapRover reads its keys)')

  // ---- variables ----------------------------------------------------------------------------
  const app = doc.caproverOneClickApp ?? {}
  for (const k of Object.keys(app)) if (!APP_KEYS.includes(k)) errors.push(`caproverOneClickApp: unexpected "${k}"`)
  const vars = new Map()
  for (const v of Array.isArray(app.variables) ? app.variables : []) {
    if (v === null || typeof v !== 'object') { errors.push('variables: every entry is a map'); continue }
    for (const k of Object.keys(v)) if (!VAR_KEYS.includes(k)) errors.push(`variable ${v.id}: unexpected "${k}"`)
    if (!/^\$\$cap_[a-z0-9_]+$/.test(v.id ?? '')) { errors.push(`variable id must be $$cap_ followed by lowercase letters, digits and _, got ${v.id}`); continue }
    if (vars.has(v.id)) errors.push(`variable ${v.id} is declared twice`)
    if (!v.label) errors.push(`variable ${v.id} needs a label`)
    if (!v.description) errors.push(`variable ${v.id} needs a description`)
    const def = v.defaultValue === undefined ? '' : v.defaultValue
    if (typeof def !== 'string') errors.push(`variable ${v.id}: defaultValue must be a string (quote it), got ${JSON.stringify(def)}`)
    let re = null
    if (v.validRegex !== undefined) {
      try { re = capRegex(String(v.validRegex)) } catch (e) { errors.push(`variable ${v.id}: ${e.message}`) }
    }
    const generated = /^\$\$cap_gen_random_hex\((\d+)\)$/.exec(def)
    if (generated && Number(generated[1]) > 256) errors.push(`variable ${v.id}: CapRover drops $$cap_gen_random_hex above 256`)
    const sample = generated ? 'f'.repeat(Number(generated[1])) : def
    if (re && !re.test(sample)) errors.push(`variable ${v.id}: its default ${JSON.stringify(def)} does not match its validRegex ${v.validRegex}`)
    vars.set(v.id, { ...v, def, re, generated, required: re !== null && !re.test('') && def === '' })
  }
  if (!vars.size) errors.push('caproverOneClickApp.variables must list the settings')
  // CapRover replaces ids with split/join one after another: an id inside another id would corrupt it.
  const ids = [...BUILTINS, ...vars.keys()]
  for (const a of ids) for (const b of ids) if (a !== b && b.startsWith(a)) errors.push(`variable ids must not be prefixes of each other: ${a} and ${b}`)
  // Every $$cap_ token is declared or built in, and every declared variable is used.
  const used = new Set([...text.matchAll(/\$\$cap_[a-z0-9_]+(?:\(\d+\))?/g)].map((m) => m[0].replace(/\(\d+\)$/, '')))
  for (const u of used) if (!vars.has(u) && !BUILTINS.includes(u) && u !== '$$cap_gen_random_hex') errors.push(`${u} is used but not declared`)
  const body = text.replace(/^ *- id: .*$/gm, '')
  for (const id of vars.keys()) if (!body.includes(id)) errors.push(`variable ${id} is declared but never used`)

  // ---- the version variable and the image -----------------------------------------------------
  const ver = vars.get(VERSION_VAR)
  let image = null
  if (!ver) errors.push(`declare ${VERSION_VAR}, the image tag`)
  else {
    image = IMAGE.replace(VERSION_VAR, ver.def)
    if (!ver.re) errors.push(`${VERSION_VAR} needs a validRegex`)
    else for (const t of ['latest', 'stable', 'main', '']) if (ver.re.test(t)) errors.push(`${VERSION_VAR}: its validRegex must refuse "${t}" (CapRover's checklist asks for a fixed version)`)
  }

  // ---- the OPENTODO_* settings --------------------------------------------------------------
  const variables = new Map()
  const catalogue = new Map(ctx.facts.variables.map((v) => [v.name, v]))
  for (const [name, value] of Object.entries(env && typeof env === 'object' ? env : {})) {
    const id = `$$cap_${name.toLowerCase()}`
    if (value !== id) { errors.push(`environment: ${name} must be ${id}, a form field`); continue }
    const v = vars.get(id)
    if (!v) continue // reported above as undeclared
    variables.set(name, { default: v.generated ? '' : v.def, required: v.required })
    const entry = catalogue.get(name)
    if (entry && v.description !== entry.description) errors.push(`variable ${id}: the description must be the catalogue's (deploy/deploy.json)`)
  }
  const token = vars.get('$$cap_opentodo_setup_token')
  if (token && !(token.generated && Number(token.generated[1]) >= 16)) errors.push('$$cap_opentodo_setup_token must default to $$cap_gen_random_hex(N) with N >= 16, generated per install')
  if (token?.re && token.re.test('short')) errors.push('$$cap_opentodo_setup_token: the validRegex must refuse tokens shorter than 16 characters')
  // A new CapRover app is served over plain http: an https base URL there makes the session cookie
  // Secure, the browser drops it and sign-in fails; so the field starts empty and the end
  // instructions say when to set it.
  const base = vars.get('$$cap_opentodo_base_url')
  if (base && base.def !== '') errors.push('$$cap_opentodo_base_url must start empty: CapRover serves a new app over plain http')
  const allow = vars.get('$$cap_opentodo_allow_signup')
  if (allow?.re && (!allow.re.test('true') || !allow.re.test('false') || allow.re.test('yes'))) errors.push('$$cap_opentodo_allow_signup: validRegex must accept exactly true and false')

  // ---- display data and instructions --------------------------------------------------------
  if (app.displayName !== ctx.facts.name) errors.push(`displayName must be ${ctx.facts.name}`)
  if (app.isOfficial !== false) errors.push('isOfficial must be false (the image is not from a verified publisher)')
  if (app.description !== ctx.facts.summary) errors.push('description must be the summary in deploy/deploy.json')
  if (typeof app.description === 'string' && app.description.length > 200) errors.push('description must be at most 200 characters (their validator)')
  if (app.documentation !== DOCS) errors.push(`documentation must be ${DOCS}`)
  const ins = app.instructions ?? {}
  for (const k of Object.keys(ins)) if (!['start', 'end'].includes(k)) errors.push(`instructions: unexpected "${k}"`)
  if (typeof ins.start !== 'string' || !ins.start) errors.push('instructions.start is required')
  if (typeof ins.end !== 'string' || !ins.end) errors.push('instructions.end is required')
  else {
    if (!ins.end.includes('$$cap_opentodo_setup_token')) errors.push('instructions.end must show the generated setup token ($$cap_opentodo_setup_token)')
    if (!ins.end.includes('OPENTODO_BASE_URL') || !ins.end.includes('https://$$cap_appname.$$cap_root_domain')) errors.push('instructions.end must say to set OPENTODO_BASE_URL to https://$$cap_appname.$$cap_root_domain after enabling HTTPS')
    if (!ins.end.includes(DOCS)) errors.push(`instructions.end must link the guide ${DOCS}`)
  }

  return { errors, image, port: extra.containerHttpPort ?? null, dataTarget: vol ? vol[1] : null, variables }
}

/** upstream/ holds exactly the files a pull request to caprover/one-click-apps adds, plus PR.md. */
export function checkUpstream(template, root = ROOT) {
  const errors = []
  const up = readText(UPSTREAM_APP, root)
  if (up === null) errors.push(`${UPSTREAM_APP} is missing`)
  else if (up !== template) errors.push(`${UPSTREAM_APP} must be identical to ${TEMPLATE}`)
  const logo = join(root, UPSTREAM_LOGO)
  if (!existsSync(logo)) errors.push(`${UPSTREAM_LOGO} is missing (their validator requires public/v4/logos/<name>.png)`)
  else if (!readFileSync(logo).equals(readFileSync(join(root, LOGO_SOURCE)))) errors.push(`${UPSTREAM_LOGO} must be identical to ${LOGO_SOURCE}`)
  if (!existsSync(join(root, PR))) errors.push(`${PR} is missing`)
  const want = new Set([UPSTREAM_APP, UPSTREAM_LOGO, PR])
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
  if (existsSync(join(root, UPSTREAM))) {
    for (const f of walk(join(root, UPSTREAM))) {
      const rel = relative(root, f).split('\\').join('/')
      if (!want.has(rel)) errors.push(`${rel} is not part of the pull request (upstream/ holds only the app, its logo and PR.md)`)
    }
  }
  return errors
}

export function check(ctx, root = ROOT) {
  const text = readText(TEMPLATE, root)
  const t = checkTemplate(text, ctx)
  const errors = [...t.errors]
  if (t.variables) errors.push(...checkShared({ image: t.image, port: t.port, dataTarget: t.dataTarget, variables: t.variables, policy: 'release' }, ctx))
  if (text !== null) errors.push(...checkUpstream(text, root))
  return errors
}

export const summary = 'v4 format, release in the version variable, port, named volume, form fields and their regexes, generated setup token, empty base URL, logo and upstream copy'
