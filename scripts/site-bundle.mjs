// Builds the site bundle (OpenSpec change site-bundle): everything the public
// website needs from this repository, as one versioned archive. Layout v1 (D1):
//
//   opentodo-site-bundle-<version>/
//     manifest.json      schema 1: version, date, commit, importFormats, facts, screenshots
//     docs/              the generated docs website
//     shots/             product screenshots (WebP), from docs/screenshots/site
//     tokens/tokens.css  the --ot-* colour tokens, light and dark, no Tailwind
//     icons/icons.svg    SVG sprite of the bundled Lucide icons and the website-only ones
//                        (web/src/ui/icons/site-icons.json), plus names.json and the licence
//     changelog.json     CHANGELOG.md as data
//     README.md          this layout and the stability rule
//
//   node scripts/site-bundle.mjs [--version V] [--out DIR] [--bin PATH] [--no-archive]
//
// --version  defaults to the git description (a tag on a release commit)
// --out      the bundle directory's parent (default dist); the archive is written next to it
// --bin      an opentodo binary to ask for its import formats; without it `go run` is used
//
// Optional facts from the environment: SITE_FACT_DOCKER_IMAGE_MB (the docker job's
// image size). No new dependency: Node's standard library and the system `tar`.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
export const repoRoot = resolve(dirname(here), '..')

/** Bundle layout version; README.md states the stability rule. */
export const LAYOUT = 1
/** Manifest schema; fields are only ever added (spec "Feature manifest"). */
export const MANIFEST_SCHEMA = 1

/**
 * The screenshots the website may use. The docs check fails when one is missing
 * from docs/screenshots/site (site-bundle 2.3), so a release never ships without them.
 */
export const SCREENSHOTS = [
  'assistant', 'board', 'comments', 'dashboard', 'feed', 'filter', 'help', 'history', 'mobile-dark',
  'mobile-detail', 'notifications', 'project', 'quick-add', 'reminders', 'settings-ai', 'settings-backups',
  'settings-caldav', 'settings-email', 'settings-encryption', 'settings-keyboard', 'settings-security',
  'settings-sso', 'settings-users', 'settings-voice', 'settings-webhooks', 'share', 'shortcuts', 'today',
  'today-dark', 'trash', 'upcoming', 'week',
]
export const SHOTS_DIR = 'docs/screenshots/site'

// ---- tokens (D4) ----

function block(css, selector) {
  const at = css.indexOf(selector)
  if (at < 0) throw new Error(`token block not found: ${selector}`)
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`unterminated block: ${selector}`)
}

const declarations = (body) => [...body.matchAll(/--ot-[\w-]+:\s*[^;]+;/g)].map((m) => m[0].replace(/\s+/g, ' '))

/** The three --ot-* blocks of index.css (light, dark by preference, dark by attribute) as a standalone stylesheet. */
export function tokensCss(indexCss, version) {
  const light = declarations(block(indexCss, ':root, [data-theme="light"] {'))
  const darkMedia = declarations(block(indexCss, '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"])'))
  const darkAttr = declarations(block(indexCss, ':root[data-theme="dark"], [data-theme="dark"] {'))
  const lines = (ds, indent) => ds.map((d) => `${indent}${d}`).join('\n')
  return `/* OpenTodo colour tokens ${version}, generated from web/src/index.css (site bundle layout v${LAYOUT}).
   Light by default; dark follows the system preference unless [data-theme="light"]
   is set on an ancestor, and [data-theme="dark"] forces it. */
:root, [data-theme="light"] {
${lines(light, '  ')}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${lines(darkMedia, '    ')}
  }
}
:root[data-theme="dark"], [data-theme="dark"] {
${lines(darkAttr, '  ')}
}
`
}

// ---- icons (D4) ----

/** An SVG sprite: one <symbol id="icon-NAME"> per bundled Lucide icon. */
export function iconSprite(lucideTs, siteIcons = {}) {
  const json = /export const ICONS = (\{[\s\S]*?\n\})/.exec(lucideTs)?.[1]
  if (!json) throw new Error('ICONS not found in lucide.ts')
  // The app's icons plus the website-only ones (site-bundle-server-facts D2); an
  // app icon wins if both name the same icon.
  const icons = { ...siteIcons, ...JSON.parse(json.replace(/,\s*\}$/, '}')) }
  const symbols = Object.keys(icons).sort().map((name) =>
    `  <symbol id="icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</symbol>`)
  return `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Lucide icons (ISC licence, see LICENSE-lucide.txt). Use: <svg><use href="icons.svg#icon-inbox"/></svg> -->\n${symbols.join('\n')}\n</svg>\n`
}

// ---- changelog ----

/** CHANGELOG.md as [{version, date, intro, sections: {Added: [markdown, ...]}}], newest first. */
export function parseChangelog(md) {
  const out = []
  const releases = md.split(/^## /m).slice(1)
  for (const chunk of releases) {
    const [head, ...rest] = chunk.split('\n')
    const m = /^\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/.exec(head)
    if (!m) continue
    const body = rest.join('\n')
    const parts = body.split(/^### /m)
    const entry = { version: m[1], date: m[2] ?? null, intro: parts[0].trim(), sections: {} }
    for (const part of parts.slice(1)) {
      const [title, ...lines] = part.split('\n')
      const items = []
      for (const line of lines) {
        if (/^[-*] /.test(line)) items.push(line.slice(2).trim())
        else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += '\n' + line.trim()
      }
      entry.sections[title.trim()] = items
    }
    out.push(entry)
  }
  return out
}

// ---- manifest (D5) ----

function git(...args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

export function importFormats(bin) {
  const out = bin
    ? execFileSync(bin, ['--print-formats'], { encoding: 'utf8' })
    : execFileSync('go', ['run', './cmd/opentodo', '--print-formats'], { cwd: repoRoot, encoding: 'utf8' })
  const formats = JSON.parse(out)
  if (!Array.isArray(formats) || !formats.every((f) => typeof f === 'string')) throw new Error('--print-formats did not print a list of names')
  return formats
}

const mb = (bytes) => Math.round((bytes / (1 << 20)) * 10) / 10

/** Reads one fact from a file of the repository; a pattern that no longer matches fails the build naming the file. */
function factFrom(root, rel, re, pick = (m) => m[1]) {
  const m = readFileSync(join(root, rel), 'utf8').match(re)
  if (!m) throw new Error(`site bundle fact: ${rel} no longer matches ${re}`)
  return pick(m)
}

/** Server facts the website shows, each from its one source (site-bundle-server-facts D1). */
export function serverFacts(root = repoRoot) {
  return {
    architectures: factFrom(root, '.github/workflows/ci.yml', /^\s*platforms:\s*(\S+)\s*$/m, (m) => m[1].split(',')),
    port: Number(factFrom(root, 'Dockerfile', /^EXPOSE\s+(\d+)/m)),
    dataDir: factFrom(root, 'Dockerfile', /^VOLUME\s+\["([^"]+)"\]/m),
    database: factFrom(root, 'go.mod', /^\s*(?:require\s+)?(modernc\.org\/sqlite|github\.com\/mattn\/go-sqlite3)\s/m, () => 'SQLite'),
    license: factFrom(root, 'LICENSE', /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/, () => 'AGPL-3.0'),
    exportFormat: factFrom(root, 'internal/httpapi/export.go', /"format": "(opentodo-export)", "version": \d+/),
    exportFormatVersion: Number(factFrom(root, 'internal/httpapi/export.go', /"format": "opentodo-export", "version": (\d+)/)),
  }
}

export function buildManifest({ version, date, commit, formats, binBytes, dockerMB, docsPages }) {
  const vocab = readdirSync(join(repoRoot, 'web/src/lib/nlp/vocab')).filter((n) => /^[a-z]{2}\.ts$/.test(n)).map((n) => n.slice(0, 2)).sort()
  const specs = readdirSync(join(repoRoot, 'openspec/specs')).filter((n) => statSync(join(repoRoot, 'openspec/specs', n)).isDirectory())
  const facts = {
    quickAddLanguages: vocab,
    specCount: specs.length,
    docsPages,
    importFormatCount: formats.length,
    ...serverFacts(),
  }
  if (binBytes) facts.binaryMB = mb(binBytes)
  if (dockerMB) facts.dockerImageMB = Number(dockerMB)
  return {
    schema: MANIFEST_SCHEMA,
    layout: LAYOUT,
    version,
    date,
    commit,
    importFormats: formats,
    screenshots: SCREENSHOTS.map((n) => `shots/${n}.webp`),
    facts,
  }
}

/** A minimal structural check of a manifest; the node test uses it. */
export function validateManifest(m) {
  const problems = []
  const want = { schema: 'number', layout: 'number', version: 'string', date: 'string', commit: 'string', importFormats: 'object', screenshots: 'object', facts: 'object' }
  for (const [k, t] of Object.entries(want)) if (typeof m[k] !== t || m[k] === null) problems.push(`${k}: expected ${t}`)
  if (m.schema !== MANIFEST_SCHEMA) problems.push(`schema: expected ${MANIFEST_SCHEMA}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? '')) problems.push('date: expected YYYY-MM-DD')
  if (!Array.isArray(m.importFormats) || !m.importFormats.every((f) => typeof f === 'string')) problems.push('importFormats: expected a list of names')
  for (const [k, v] of Object.entries(m.facts ?? {})) if (!['number', 'string', 'boolean'].includes(typeof v) && !Array.isArray(v)) problems.push(`facts.${k}: unsupported type`)
  return problems
}

/** Screenshots named by the bundle that are missing from docs/screenshots/site. */
export function missingScreenshots(root = repoRoot) {
  return SCREENSHOTS.filter((n) => !existsSync(join(root, SHOTS_DIR, `${n}.webp`))).map((n) => `${SHOTS_DIR}/${n}.webp`)
}

const README = (version) => `# OpenTodo site bundle ${version}

Everything the OpenTodo website needs from a release, built by CI from the
tagged commit. Layout version ${LAYOUT}.

| Path | What it is |
|---|---|
| \`manifest.json\` | schema ${MANIFEST_SCHEMA}: \`version\`, \`date\`, \`commit\`, \`importFormats\` (formats this version imports), \`screenshots\`, \`facts\` (named values the website may show: \`quickAddLanguages\`, \`specCount\`, \`docsPages\`, \`importFormatCount\`, the server facts \`architectures\`, \`port\`, \`dataDir\`, \`database\`, \`license\`, \`exportFormat\` and \`exportFormatVersion\`, and \`binaryMB\` / \`dockerImageMB\` when measured) |
| \`docs/\` | the documentation website, served under \`/docs/\` |
| \`shots/\` | product screenshots, WebP; \`-dark\` names are the dark theme |
| \`tokens/tokens.css\` | the \`--ot-*\` colour tokens for light and dark, standalone CSS |
| \`icons/icons.svg\` | SVG sprite of the icon set (\`<use href="icons.svg#icon-inbox"/>\`), with \`names.json\` and \`LICENSE-lucide.txt\` (ISC) |
| \`changelog.json\` | \`[{version, date, intro, sections: {Added: [markdown, ...]}}]\`, newest first |

## Stability

Paths change only in a release whose changelog says so, and a path that is
renamed or removed stays in the bundle for at least one more release. Manifest
fields are only ever added: a website built against schema ${MANIFEST_SCHEMA} keeps
reading every field it knew.
`

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

export async function buildBundle({ version, out = 'dist', bin, archive = true }) {
  const name = `opentodo-site-bundle-${version}`
  const outAbs = resolve(repoRoot, out)
  const dir = join(outAbs, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  // docs/: the docs site, built straight into the bundle (build.mjs --site).
  const { buildAll } = await import('../web/scripts/docs/build.mjs')
  // Repository-relative, also when --out is an absolute path outside the repository.
  const siteRel = relative(repoRoot, join(outAbs, name, 'docs')).split('\\').join('/')
  const { files, problems, sorted } = await buildAll(repoRoot, { site: siteRel })
  if (problems.length) throw new Error(`docs build failed:\n  ${problems.join('\n  ')}`)
  for (const [path, content] of files) {
    if (!path.startsWith(siteRel + '/')) continue
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true })
    writeFileSync(join(repoRoot, path), content)
  }

  // shots/
  const missing = missingScreenshots()
  if (missing.length) throw new Error(`screenshots missing (run scripts/screenshots.mjs): ${missing.join(', ')}`)
  copyDir(join(repoRoot, SHOTS_DIR), join(dir, 'shots'))

  // tokens/, icons/
  mkdirSync(join(dir, 'tokens'))
  writeFileSync(join(dir, 'tokens/tokens.css'), tokensCss(readFileSync(join(repoRoot, 'web/src/index.css'), 'utf8'), version))
  mkdirSync(join(dir, 'icons'))
  const iconsDir = join(repoRoot, 'web/src/ui/icons')
  const siteIcons = JSON.parse(readFileSync(join(iconsDir, 'site-icons.json'), 'utf8'))
  writeFileSync(join(dir, 'icons/icons.svg'), iconSprite(readFileSync(join(iconsDir, 'lucide.ts'), 'utf8'), siteIcons))
  const appNames = JSON.parse(readFileSync(join(iconsDir, 'names.json'), 'utf8'))
  writeFileSync(join(dir, 'icons/names.json'), JSON.stringify([...appNames, ...Object.keys(siteIcons).filter((n) => !appNames.includes(n))], null, 2) + '\n')
  copyFileSync(join(iconsDir, 'LICENSE-lucide.txt'), join(dir, 'icons/LICENSE-lucide.txt'))

  // changelog.json, manifest.json, README.md
  const changelog = parseChangelog(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'))
  writeFileSync(join(dir, 'changelog.json'), JSON.stringify(changelog, null, 2) + '\n')
  const released = changelog.find((c) => c.version === version.replace(/^v/, ''))
  const date = released?.date ?? (git('log', '-1', '--format=%cs') || new Date().toISOString().slice(0, 10))
  const binPath = bin ? resolve(repoRoot, bin) : undefined
  const manifest = buildManifest({
    version, date, commit: git('rev-parse', 'HEAD') || 'unknown', formats: importFormats(binPath),
    binBytes: binPath && existsSync(binPath) ? statSync(binPath).size : 0,
    dockerMB: process.env.SITE_FACT_DOCKER_IMAGE_MB, docsPages: sorted.length,
  })
  const problemsM = validateManifest(manifest)
  if (problemsM.length) throw new Error(`manifest: ${problemsM.join('; ')}`)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), README(version))

  let archivePath = null
  if (archive) {
    archivePath = join(outAbs, `${name}.tar.gz`)
    // Stable order and owner so the archive does not depend on who built it.
    execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', archivePath, '-C', outAbs, name])
  }
  return { dir, archive: archivePath, manifest }
}

function arg(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

if (process.argv[1] === here) {
  const argv = process.argv.slice(2)
  const version = arg(argv, '--version') ?? (git('describe', '--tags', '--always', '--dirty') || 'dev')
  try {
    const res = await buildBundle({ version, out: arg(argv, '--out') ?? 'dist', bin: arg(argv, '--bin'), archive: !argv.includes('--no-archive') })
    console.log(`site bundle ${version}: ${res.dir}${res.archive ? `\n  archive ${res.archive}` : ''}`)
  } catch (err) {
    console.error(`site bundle: ${err.message}`)
    process.exit(1)
  }
}
