// Kubernetes Helm chart (deploy/helm/opentodo), published as an OCI artifact to
// oci://ghcr.io/pixari/charts/opentodo by .github/workflows/helm.yml and listed on Artifact Hub.
// Image policy 'release': the chart's version and appVersion are the latest release in
// CHANGELOG.md and the image tag defaults to appVersion, so `helm upgrade` to a newer chart is
// what moves an install to a newer release (a moving tag would never restart the pod).
// Chart.yaml, values.yaml and artifacthub-repo.yml are read with the strict YAML parser
// (yaml.mjs), values.schema.json with JSON.parse; the templates are Go templates, so
// they are checked as text for the rules that matter (one replica, Recreate, non-root, fsGroup,
// read-only root, probes, port, /data). When helm is installed (or HELM names it), helm lint
// --strict and helm template run too; without it the check works offline.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkShared, latestRelease, readText, ROOT } from './common.mjs'
import { parseYaml } from './yaml.mjs'

export const DIR = 'deploy/helm/opentodo'
export const CHART = `${DIR}/Chart.yaml`
export const VALUES = `${DIR}/values.yaml`
export const SCHEMA = `${DIR}/values.schema.json`
export const DEPLOYMENT = `${DIR}/templates/deployment.yaml`
export const ARTIFACTHUB = 'deploy/helm/artifacthub-repo.yml'
export const WORKFLOW = '.github/workflows/helm.yml'
export const OCI = 'oci://ghcr.io/pixari/charts'
const RAW = 'https://raw.githubusercontent.com/pixari/opentodo/main/'
const TEMPLATES = ['_helpers.tpl', 'deployment.yaml', 'service.yaml', 'pvc.yaml', 'secret.yaml', 'ingress.yaml', 'NOTES.txt']

function parse(text, name, errors) {
  if (text === null) { errors.push(`${name} is missing`); return null }
  if (!text.endsWith('\n')) errors.push(`${name} must end with a newline`)
  try {
    return parseYaml(text)
  } catch (e) {
    errors.push(`${name} is not in the supported YAML subset: ${e.message}`)
    return null
  }
}

const release = (changelog) => {
  const r = latestRelease(changelog)
  return `${r.major}.${r.minor}.${r.patch}`
}

/** Chart.yaml: metadata, the release version, Artifact Hub annotations. Returns the appVersion. */
export function checkChart(text, ctx, root = ROOT) {
  const errors = []
  const c = parse(text, CHART, errors)
  if (!c) return { errors, appVersion: null }
  const f = ctx.facts
  const want = ctx.changelog ? release(ctx.changelog) : null
  if (c.apiVersion !== 'v2') errors.push('Chart.yaml: apiVersion must be v2')
  if (c.name !== 'opentodo') errors.push('Chart.yaml: name must be opentodo')
  if (c.type !== 'application') errors.push('Chart.yaml: type must be application')
  if (c.description !== f.summary) errors.push(`Chart.yaml: description must be the summary in deploy/deploy.json: ${f.summary}`)
  if (c.home !== f.project) errors.push(`Chart.yaml: home must be ${f.project}`)
  if (!Array.isArray(c.sources) || !c.sources.includes(f.repository)) errors.push(`Chart.yaml: sources must list ${f.repository}`)
  if (c.icon !== RAW + f.icon) errors.push(`Chart.yaml: icon must be ${RAW + f.icon}`)
  else if (!existsSync(join(root, f.icon))) errors.push(`the icon ${f.icon} does not exist`)
  if (typeof c.kubeVersion !== 'string' || !c.kubeVersion) errors.push('Chart.yaml: kubeVersion is required')
  if (typeof c.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.appVersion)) errors.push('Chart.yaml: appVersion must be a quoted release version such as "0.6.1"')
  if (String(c.version) !== String(c.appVersion)) errors.push(`Chart.yaml: version (${c.version}) must equal appVersion (${c.appVersion}): the chart is published from the release tag`)
  if (want && c.appVersion !== want) errors.push(`Chart.yaml: appVersion must be ${want}, the latest release in CHANGELOG.md (got ${c.appVersion})`)
  if (/^\s*appVersion: [^"]/m.test(text)) errors.push('Chart.yaml: quote appVersion ("0.6.1"); the publish workflow matches it quoted')

  const a = c.annotations ?? {}
  if (a['artifacthub.io/license'] !== 'AGPL-3.0-only') errors.push('Chart.yaml: artifacthub.io/license must be AGPL-3.0-only')
  if (a['artifacthub.io/prerelease'] !== 'false') errors.push('Chart.yaml: artifacthub.io/prerelease must be "false" (release candidates are not published)')
  const yamlAnnotation = (key) => {
    if (typeof a[key] !== 'string') { errors.push(`Chart.yaml: ${key} is required`); return [] }
    try {
      const v = parseYaml(a[key])
      if (Array.isArray(v)) return v
    } catch (e) {
      errors.push(`Chart.yaml: ${key} is not YAML: ${e.message}`)
      return []
    }
    errors.push(`Chart.yaml: ${key} must be a YAML list`)
    return []
  }
  const links = yamlAnnotation('artifacthub.io/links')
  if (!links.some((l) => l.name === 'support' && l.url === f.support)) errors.push(`Chart.yaml: artifacthub.io/links needs a "support" link to ${f.support}`)
  const images = yamlAnnotation('artifacthub.io/images')
  const image = `${f.image}:${c.appVersion}`
  if (images.length !== 1 || images[0].image !== image) errors.push(`Chart.yaml: artifacthub.io/images must list exactly ${image}`)
  else if (JSON.stringify(images[0].platforms) !== JSON.stringify(['linux/amd64', 'linux/arm64'])) errors.push('Chart.yaml: artifacthub.io/images platforms must be linux/amd64 and linux/arm64')
  return { errors, appVersion: c.appVersion }
}

/** values.yaml against the schema's top level, the image, the variables and the defaults that matter. */
export function checkValues(text, schemaText, appVersion, ctx) {
  const errors = []
  const v = parse(text, VALUES, errors)
  let schema = null
  if (schemaText === null) errors.push(`${SCHEMA} is missing`)
  else {
    try { schema = JSON.parse(schemaText) } catch (e) { errors.push(`${SCHEMA} is not JSON: ${e.message}`) }
  }
  if (!v) return { errors, found: null }
  if (schema) {
    if (schema.additionalProperties !== false) errors.push('values.schema.json: the top level must set additionalProperties: false, so a mistyped value fails the install')
    const props = Object.keys(schema.properties ?? {})
    for (const k of Object.keys(v)) if (!props.includes(k)) errors.push(`values.yaml: ${k} is not in values.schema.json`)
    for (const k of props) if (!Object.hasOwn(v, k)) errors.push(`values.yaml: ${k} from values.schema.json has no default`)
    for (const k of ['replicaCount', 'replicas', 'strategy']) if (props.includes(k)) errors.push(`values.schema.json: ${k} must not be a value: SQLite needs one writer`)
    if (schema.properties?.image?.properties?.tag?.not?.const !== 'latest') errors.push('values.schema.json: image.tag must refuse latest')
  }
  const img = v.image ?? {}
  if (img.repository !== ctx.facts.image) errors.push(`values.yaml: image.repository must be ${ctx.facts.image}`)
  if (img.tag !== '') errors.push('values.yaml: image.tag must be "" so the image follows the chart\'s appVersion')
  if (img.pullPolicy !== 'IfNotPresent') errors.push('values.yaml: image.pullPolicy must be IfNotPresent (the tag is a fixed release)')
  const variables = new Map()
  const env = v.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env)) errors.push('values.yaml: env must be a map of OPENTODO_* names to strings')
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') errors.push(`values.yaml: env.${name} must be a string ("${value}")`)
    if (name === 'OPENTODO_SETUP_TOKEN') errors.push('values.yaml: OPENTODO_SETUP_TOKEN comes from setupToken (a Secret), not env')
    variables.set(name, { default: String(value), required: false })
  }
  if (!Array.isArray(v.extraEnv) || v.extraEnv.length) errors.push('values.yaml: extraEnv must default to []')
  const st = v.setupToken ?? {}
  if (st.generate !== true) errors.push('values.yaml: setupToken.generate must default to true')
  if (st.existingSecret !== '') errors.push('values.yaml: setupToken.existingSecret must default to ""')
  if (!st.secretKey) errors.push('values.yaml: setupToken.secretKey is required')
  variables.set('OPENTODO_SETUP_TOKEN', { default: '', required: false })
  const p = v.persistence ?? {}
  if (p.enabled !== true) errors.push('values.yaml: persistence.enabled must default to true')
  if (p.keep !== true) errors.push('values.yaml: persistence.keep must default to true (helm uninstall keeps the data)')
  if (p.accessMode !== 'ReadWriteOnce') errors.push('values.yaml: persistence.accessMode must default to ReadWriteOnce')
  if (String(v.service?.port) !== String(ctx.facts.port)) errors.push(`values.yaml: service.port must be ${ctx.facts.port}`)
  if (v.ingress?.enabled !== false) errors.push('values.yaml: ingress.enabled must default to false')
  return { errors, found: { image: `${img.repository}:${img.tag || appVersion}`, variables } }
}

/** The Deployment template: the rules that keep SQLite safe and the pod locked down. */
export function checkDeployment(text, ctx) {
  if (text === null) return { errors: [`${DEPLOYMENT} is missing`], port: null, dataTarget: null }
  const errors = []
  const [uid, gid] = ctx.facts.user.split(':')
  const need = (re, msg) => { if (!re.test(text)) errors.push(`deployment.yaml: ${msg}`) }
  need(/^  replicas: 1$/m, 'replicas must be fixed at 1 (SQLite has one writer)')
  need(/^  strategy:\n    type: Recreate$/m, 'strategy must be Recreate, so the old pod stops before the new one opens the database')
  need(/^        runAsNonRoot: true$/m, 'the pod must set runAsNonRoot: true')
  need(new RegExp(`^        runAsUser: ${uid}$`, 'm'), `the pod must run as user ${uid}`)
  need(new RegExp(`^        runAsGroup: ${gid}$`, 'm'), `the pod must run as group ${gid}`)
  need(new RegExp(`^        fsGroup: ${gid}$`, 'm'), `the pod must set fsGroup: ${gid} so the volume is writable`)
  need(/^            readOnlyRootFilesystem: true$/m, 'the container must set readOnlyRootFilesystem: true')
  need(/^            allowPrivilegeEscalation: false$/m, 'the container must set allowPrivilegeEscalation: false')
  need(/^              drop: \["ALL"\]$/m, 'the container must drop all capabilities')
  need(/^          image: \{\{ include "opentodo\.image" \. \| quote \}\}$/m, 'the image must come from the opentodo.image helper')
  for (const probe of ['startupProbe', 'livenessProbe', 'readinessProbe']) {
    need(new RegExp(`^          ${probe}:\\n            httpGet:\\n              path: /healthz\\n              port: http$`, 'm'), `${probe} must GET /healthz on the http port`)
  }
  for (const k of ['.Values.replicaCount', '.Values.strategy', 'hostPath']) if (text.includes(k)) errors.push(`deployment.yaml: must not use ${k}`)
  const port = /^            - name: http\n              containerPort: (\d+)$/m.exec(text)?.[1] ?? null
  if (!port) errors.push('deployment.yaml: needs one container port named http')
  const dataTarget = /^            - name: data\n              mountPath: (\S+)$/m.exec(text)?.[1] ?? null
  if (!dataTarget) errors.push('deployment.yaml: needs the data volume mount')
  need(/^            - name: tmp\n              mountPath: \/tmp$/m, 'needs an emptyDir on /tmp (the root filesystem is read-only)')
  need(/^            - name: OPENTODO_BASE_URL\n              value: \{\{ include "opentodo\.baseUrl" \. \| quote \}\}$/m, 'OPENTODO_BASE_URL must come from the opentodo.baseUrl helper')
  need(/^            - name: OPENTODO_SETUP_TOKEN\n              valueFrom:\n                secretKeyRef:$/m, 'OPENTODO_SETUP_TOKEN must come from a Secret')
  need(/\{\{- range \$name, \$value := \.Values\.env \}\}/, 'must pass every entry of .Values.env')
  return { errors, port, dataTarget }
}

/** artifacthub-repo.yml: only the keys Artifact Hub reads. */
export function checkArtifactHub(text) {
  const errors = []
  const doc = parse(text, ARTIFACTHUB, errors)
  if (!doc) return errors
  for (const k of Object.keys(doc)) if (!['repositoryID', 'owners', 'ignore'].includes(k)) errors.push(`${ARTIFACTHUB}: unknown key ${k}`)
  if (doc.repositoryID !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(doc.repositoryID)) errors.push(`${ARTIFACTHUB}: repositoryID must be the UUID Artifact Hub shows`)
  return errors
}

/** The publishing workflow: release tags only, the OCI registry, packages: write, PR lint. */
export function checkWorkflow(text) {
  if (text === null) return [`${WORKFLOW} is missing`]
  const errors = []
  const need = (s, msg) => { if (!text.includes(s)) errors.push(`${WORKFLOW}: ${msg}`) }
  need('tags: ["v*"]', 'must run on v* tags')
  need("!contains(github.ref_name, '-')", 'must skip release candidates')
  need('packages: write', 'needs packages: write to push to GHCR')
  need('helm push', 'must push the chart with helm push')
  need('ghcr.io/${{ github.repository_owner }}/charts', `must push to ${OCI}`)
  need('application/vnd.cncf.artifacthub.repository-metadata.layer.v1.yaml', 'must push artifacthub-repo.yml for Artifact Hub')
  need('"deploy/helm/**"', 'must lint pull requests that touch deploy/helm')
  return errors
}

/** helm lint and helm template, when helm is installed. Returns null when it is not. */
export function runHelm(appVersion, ctx, root = ROOT, helm = process.env.HELM || 'helm') {
  if (spawnSync(helm, ['version', '--short'], { stdio: 'ignore' }).status !== 0) return null
  const errors = []
  const dir = join(root, DIR)
  const lint = spawnSync(helm, ['lint', '--strict', dir], { encoding: 'utf8' })
  if (lint.status !== 0) errors.push(`helm lint --strict failed:\n${lint.stdout}${lint.stderr}`)
  const variants = [[], ['--set', 'ingress.enabled=true', '--set', 'ingress.tls[0].secretName=t', '--set', 'setupToken.existingSecret=s', '--set', 'persistence.existingClaim=c']]
  for (const extra of variants) {
    const r = spawnSync(helm, ['template', 'opentodo', dir, ...extra], { encoding: 'utf8' })
    if (r.status !== 0) { errors.push(`helm template ${extra.join(' ')} failed: ${r.stderr}`); continue }
    if (!r.stdout.includes(`image: "${ctx.facts.image}:${appVersion}"`)) errors.push(`helm template: the Deployment must run ${ctx.facts.image}:${appVersion}`)
    if ((r.stdout.match(/^kind: Deployment$/gm) ?? []).length !== 1) errors.push('helm template must render exactly one Deployment')
  }
  return errors
}

export function check(ctx, root = ROOT) {
  const errors = []
  for (const t of TEMPLATES) if (!existsSync(join(root, DIR, 'templates', t))) errors.push(`${DIR}/templates/${t} is missing`)
  if (!existsSync(join(root, DIR, 'README.md'))) errors.push(`${DIR}/README.md is missing (Artifact Hub shows it)`)
  const chart = checkChart(readText(CHART, root), ctx, root)
  errors.push(...chart.errors)
  const values = checkValues(readText(VALUES, root), readText(SCHEMA, root), chart.appVersion, ctx)
  errors.push(...values.errors)
  const dep = checkDeployment(readText(DEPLOYMENT, root), ctx)
  errors.push(...dep.errors)
  errors.push(...checkArtifactHub(readText(ARTIFACTHUB, root)))
  errors.push(...checkWorkflow(readText(WORKFLOW, root)))
  if (values.found) {
    errors.push(...checkShared({ ...values.found, port: dep.port, dataTarget: dep.dataTarget, policy: 'release' }, ctx))
  }
  if (chart.appVersion && !errors.length) errors.push(...(runHelm(chart.appVersion, ctx, root) ?? []))
  return errors
}

export const summary = 'release version, image, one replica with Recreate, non-root and read-only, probes, PVC on /data, variables, Artifact Hub metadata, publish workflow (and helm lint/template when helm is installed)'
