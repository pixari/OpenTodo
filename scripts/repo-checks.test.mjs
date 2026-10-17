// Repository checks for CI and release hygiene (OpenSpec change release-hygiene):
// the CI path filter, the patched Go toolchain shared by go.mod, CI and the
// Dockerfile, the root docker-compose.yml publishing on loopback by default, and
// migration numbering against the base branch (sync-convergence). The release
// gates (ci-release-gates): pinned actions and images, timeouts, publishing only
// after every gate, signed and attested artefacts, CI running `make check`.
// Contributor docs (contributor-docs-and-template-checks): every internal/ package
// and token scope named in AGENTS.md and docs/architecture.md.
// Run: node --test scripts/repo-checks.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const workflowFiles = () => readdirSync(path.join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`)

function changes(files) {
  const out = execFileSync('sh', [path.join(root, 'scripts/ci-changes.sh')], { input: files.join('\n') + '\n', encoding: 'utf8' })
  return Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')))
}

// path(s) → expected outputs of scripts/ci-changes.sh
const table = [
  [['internal/sync/ops.go'], { code: 'true', docs: 'false' }],
  [['web/src/app/App.tsx'], { code: 'true', docs: 'false' }],
  [['go.sum'], { code: 'true', docs: 'false' }],
  [['Dockerfile'], { code: 'true', docs: 'false' }],
  [['.github/workflows/ci.yml'], { code: 'true', docs: 'false' }],
  [['skills/opentodo-cli/SKILL.md'], { code: 'true', docs: 'false' }],
  [['skills/skills.go'], { code: 'true', docs: 'false' }],
  [['deploy/coolify/opentodo.yaml'], { code: 'true', docs: 'false' }],
  [['scripts/deploy/casaos.mjs'], { code: 'true', docs: 'false' }],
  [['scripts/deploy-check.mjs'], { code: 'true', docs: 'false' }],
  [['scripts/ci-changes.sh'], { code: 'true', docs: 'false' }],
  [['scripts/repo-checks.test.mjs'], { code: 'true', docs: 'false' }],
  [['docker-compose.yml'], { code: 'true', docs: 'false' }],
  [['scripts/coolify-template-check.mjs'], { code: 'true', docs: 'false' }],
  [['scripts/e2e-views.mjs'], { code: 'true', docs: 'false' }],
  [['.github/dependabot.yml'], { code: 'true', docs: 'false' }],
  [['.dockerignore'], { code: 'true', docs: 'false' }],
  [['docs/self-hosting/docker.md'], { code: 'false', docs: 'true' }],
  [['web/src/generated/help.json'], { code: 'false', docs: 'true' }],
  [['README.md'], { code: 'false', docs: 'true' }],
  [['CHANGELOG.md'], { code: 'false', docs: 'true' }],
  [['openspec/changes/x/proposal.md'], { code: 'false', docs: 'true' }],
  [['docs/api.md', 'web/src/generated/help.json'], { code: 'false', docs: 'true' }],
  [['docs/api.md', 'internal/httpapi/router.go'], { code: 'true', docs: 'true' }],
  [['skill/README.md'], { code: 'false', docs: 'false' }],
  [['LICENSE'], { code: 'false', docs: 'false' }],
]

for (const [files, want] of table) {
  test(`ci-changes: ${files.join(' + ')}`, () => {
    assert.deepEqual(changes(files), want)
  })
}

test('go.mod pins a patched toolchain that the Dockerfile and every setup-go step use', () => {
  const toolchain = read('go.mod').match(/^toolchain go(\d+\.\d+\.\d+)$/m)
  assert.ok(toolchain, 'go.mod must have a `toolchain go1.N.P` line')
  const docker = read('Dockerfile').match(/^FROM .*\bgolang:(\d+\.\d+\.\d+)-alpine@sha256:/m)
  assert.equal(docker?.[1], toolchain[1], 'the Dockerfile golang image must name the go.mod toolchain')
  const ci = read('.github/workflows/ci.yml')
  for (const f of workflowFiles()) {
    const steps = read(f).split(/\n\s*- uses: actions\/setup-go@/).slice(1)
    for (const s of steps) assert.match(s, /^\S+(?: # v[\d.]+)?\n\s+with:\n\s+go-version-file: go\.mod\n/, `${f}: setup-go must read go.mod`)
  }
  assert.ok(ci.includes('actions/setup-go@'))
  assert.match(ci, /go run golang\.org\/x\/vuln\/cmd\/govulncheck@v\d+\.\d+\.\d+ \.\/\.\.\./, 'CI runs a pinned govulncheck')
})

test('the root docker-compose.yml publishes on every interface unless OPENTODO_BIND says otherwise', () => {
  const ports = read('docker-compose.yml').match(/^\s+ports:\n((?:\s+#.*\n)*)\s+- "([^"]+)"/m)
  assert.ok(ports)
  assert.equal(ports[2], '${OPENTODO_BIND:-0.0.0.0}:${OPENTODO_PORT:-8080}:8080')
  assert.match(ports[1], /OPENTODO_BIND=127\.0\.0\.1/, 'the comment explains the safer setting behind a proxy')
  assert.match(read('.env.example'), /^#? ?OPENTODO_BIND=/m)
})

test('SECURITY.md names the X-Forwarded-For hop the code uses (the nearest untrusted one)', () => {
  const s = read('SECURITY.md')
  assert.doesNotMatch(s, /first `X-Forwarded-For`/)
  assert.match(s, /nearest untrusted `X-Forwarded-For` hop/)
  assert.match(s, /OPENTODO_TRUSTED_PROXIES/)
})

// Schema migrations (OpenSpec change sync-convergence): the store runs only
// files numbered above the database's version, so a file added on a branch with
// a number at or below one already on main would never run on an upgraded
// server. (Duplicate numbers are refused by internal/store's tests.)
const migrationsDir = 'internal/store/migrations'
const migrationNumber = (name) => Number.parseInt(name.split('_')[0], 10)

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

test('migrations added on a branch are numbered above every migration on the base branch', (t) => {
  const base = process.env.MIGRATIONS_BASE || 'origin/main'
  try {
    git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)
  } catch {
    t.skip(`${base} is not available (shallow clone)`)
    return
  }
  const onBase = git('ls-tree', '--name-only', base, `${migrationsDir}/`).split('\n').filter((p) => p.endsWith('.sql'))
  const highest = Math.max(0, ...onBase.map((p) => migrationNumber(path.basename(p))))
  const added = git('diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', `${migrationsDir}/`)
    .split('\n').filter((p) => p.endsWith('.sql'))
  for (const p of added) {
    const v = migrationNumber(path.basename(p))
    assert.ok(v > highest, `${p} must be numbered above ${highest}, the highest migration on ${base}: renumber it`)
  }
})

// ---- Release gates (OpenSpec change ci-release-gates) ------------------------------------------

/** The jobs of a workflow: id → the job's indented block (a line-based reader for our own files). */
function jobsOf(text) {
  const lines = text.split('\n')
  const out = {}
  let cur = null
  for (const l of lines.slice(lines.indexOf('jobs:') + 1)) {
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (m) { cur = m[1]; out[cur] = ''; continue }
    if (/^\S/.test(l)) break
    if (cur) out[cur] += l + '\n'
  }
  return out
}
const needsOf = (block) => {
  const v = block.match(/^ {4}needs: (.+)$/m)?.[1].trim()
  if (!v) return []
  return v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()) : [v]
}
const makePrereqs = (target) => {
  const m = read('Makefile').match(new RegExp(`^${target}:(.*)$`, 'm'))
  assert.ok(m, `Makefile has a ${target} target`)
  return m[1].trim().split(/\s+/).filter(Boolean)
}

test('every action is pinned to a full commit SHA with its release in a comment', () => {
  for (const f of workflowFiles()) {
    for (const [, ref, rest] of read(f).matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)) {
      if (ref.startsWith('./')) continue
      assert.match(ref, /^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/, `${f}: ${ref} must be pinned to a commit SHA`)
      assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${f}: ${ref} needs a "# vX.Y.Z" comment naming the release`)
    }
  }
})

test('every workflow has a concurrency group and every job a timeout', () => {
  for (const f of workflowFiles()) {
    const text = read(f)
    assert.match(text, /^concurrency:\n {2}group: /m, `${f}: concurrency group`)
    for (const [id, block] of Object.entries(jobsOf(text))) {
      assert.match(block, /^ {4}timeout-minutes: \d+$/m, `${f}: job ${id} needs timeout-minutes`)
    }
  }
  // Pull requests cancel superseded runs; main and tags never cancel a run in progress.
  assert.match(read('.github/workflows/ci.yml'), /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/)
})

test('base and job images are pinned by digest', () => {
  const dockerfile = read('Dockerfile')
  const stages = [...dockerfile.matchAll(/^FROM .* AS (\S+)$/gm)].map((m) => m[1])
  for (const [, from] of dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)) {
    if (stages.includes(from)) continue
    assert.match(from, /^[\w.\/-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `Dockerfile: ${from} must be tag@sha256:digest`)
  }
  const pinned = read('Makefile').match(/^PLAYWRIGHT_IMAGE := (.+)$/m)?.[1].replace('$(PLAYWRIGHT_VERSION)', read('Makefile').match(/^PLAYWRIGHT_VERSION := (\S+)$/m)[1])
  assert.match(pinned ?? '', /@sha256:[0-9a-f]{64}$/, 'Makefile PLAYWRIGHT_IMAGE is pinned by digest')
  for (const f of workflowFiles()) {
    for (const [, image] of read(f).matchAll(/^\s+container: (\S+)$/gm)) {
      assert.match(image, /@sha256:[0-9a-f]{64}$/, `${f}: container ${image} must be pinned by digest`)
      assert.equal(image, pinned, `${f}: container image matches the Makefile's PLAYWRIGHT_IMAGE (same baselines)`)
    }
  }
})

test('the image, stable tag and release are published only after every gate', () => {
  const jobs = jobsOf(read('.github/workflows/ci.yml'))
  const publishing = ['docker', 'release']
  for (const p of publishing) assert.ok(jobs[p], `ci.yml has a ${p} job`)
  const gates = Object.keys(jobs).filter((j) => !publishing.includes(j))
  for (const g of gates) {
    assert.ok(needsOf(jobs.docker).includes(g), `the docker (publish) job must need ${g}`)
    assert.ok(needsOf(jobs.release).includes(g), `the release job must need ${g}`)
  }
  assert.ok(needsOf(jobs.release).includes('docker'), 'the release waits for the image')
  assert.match(jobs.docker, /^ {4}if: github\.event_name != 'pull_request'$/m, 'pull requests never publish')
  assert.match(jobs.docker, /type=raw,value=stable,/, 'stable moves only in the gated publish job')
})

test('the image under test is the one built in the run, scanned and smoke-tested', () => {
  const ci = read('.github/workflows/ci.yml')
  const jobs = jobsOf(ci)
  assert.match(jobs.image, /^ {10}load: true$/m, 'the image job loads the built image into Docker')
  assert.match(jobs.image, /^ {10}push: false$/m)
  assert.match(jobs.image, /anchore\/scan-action@[0-9a-f]{40}/, 'the image job scans the image')
  assert.match(jobs.image, /^ {10}severity-cutoff: critical$/m, 'scan fails on critical')
  assert.match(jobs.image, /^ {10}fail-build: true$/m)
  assert.match(jobs.image, /^ {10}only-fixed: true$/m, 'scan counts findings with a fix')
  assert.match(jobs.image, /coolify-template-check\.mjs --smoke --image opentodo:ci/, 'smoke test runs the built image')
  for (const f of workflowFiles()) {
    for (const [line] of read(f).matchAll(/^.*--smoke\b.*$/gm)) {
      assert.match(line, /--image /, `${f}: a smoke test must name the image under test, not the published one`)
    }
  }
})

test('published artefacts are signed and attested, with OIDC only where needed', () => {
  const ci = read('.github/workflows/ci.yml')
  const jobs = jobsOf(ci)
  assert.match(jobs.docker, /^ {10}provenance: mode=max$/m)
  assert.match(jobs.docker, /^ {10}sbom: true$/m)
  assert.match(jobs.docker, /sigstore\/cosign-installer@/)
  assert.match(jobs.docker, /cosign sign --yes "\$\{image\}@\$\{DIGEST\}"/, 'the pushed digest is signed')
  assert.match(jobs.release, /actions\/attest-build-provenance@/)
  assert.match(jobs.release, /^ {6}attestations: write$/m)
  for (const f of workflowFiles()) {
    const text = read(f)
    const top = text.slice(0, text.indexOf('\njobs:'))
    assert.doesNotMatch(top, /id-token|attestations/, `${f}: OIDC and attestation permissions belong on the jobs that need them`)
    for (const [id, block] of Object.entries(jobsOf(text))) {
      if (/id-token: write/.test(block)) assert.ok(f.endsWith('ci.yml') && ['docker', 'release'].includes(id), `${f}: ${id} must not ask for id-token`)
    }
  }
})

// What `make check` runs outside `make ci-checks`, and the CI step that runs it instead.
const checkElsewhere = {
  lint: ['go vet ./...', 'npm run typecheck'],
  test: ['go test ./...', 'npm test', 'make extension'],
  'docs-check': ['npm run docs:check'],
  staticcheck: ['make staticcheck'],
  'web-lint': ['npm run lint'],
}

test('CI runs every part of make check', () => {
  const ci = read('.github/workflows/ci.yml')
  assert.match(jobsOf(ci).checks ?? '', /run: make ci-checks$/m, 'the checks job runs make ci-checks')
  const ciChecks = makePrereqs('ci-checks')
  for (const t of makePrereqs('check')) {
    if (ciChecks.includes(t)) continue
    assert.ok(checkElsewhere[t], `make check runs ${t}: add it to ci-checks (or to checkElsewhere with the CI step that runs it)`)
    for (const step of checkElsewhere[t]) assert.ok(ci.includes(step), `CI runs ${step} (for make ${t})`)
  }
  for (const t of ciChecks) assert.ok(makePrereqs('check').includes(t), `ci-checks runs ${t}, which make check must run too`)
  assert.ok(ciChecks.includes('fmt-check'), 'gofmt gate')
  assert.match(read('Makefile'), /^fmt-check:\n\t.*gofmt -l /m)
})

test('the OpenSpec CLI runs at one exact version', () => {
  const version = read('Makefile').match(/^OPENSPEC_VERSION := (\d+\.\d+\.\d+)$/m)?.[1]
  assert.ok(version, 'Makefile pins OPENSPEC_VERSION to an exact version')
  for (const f of ['Makefile', 'AGENTS.md', 'CLAUDE.md', 'README.md', ...workflowFiles()]) {
    if (!existsSync(path.join(root, f))) continue
    for (const [use] of read(f).matchAll(/@fission-ai\/openspec(?:@\S+)?/g)) {
      assert.ok(use === '@fission-ai/openspec@$(OPENSPEC_VERSION)' || use === `@fission-ai/openspec@${version}`, `${f}: ${use} must be the pinned version`)
    }
  }
})

test('browser end-to-end checks run in CI and the race detector nightly', () => {
  const jobs = jobsOf(read('.github/workflows/ci.yml'))
  assert.match(jobs.layout, /run: make e2e$/m, 'the layout job runs make e2e')
  const e2e = read('Makefile').match(/^e2e:[^\n]*\n((?:\t.*\n)+)/m)?.[1] ?? ''
  assert.match(e2e, /e2e-smoke e2e-views/, 'make e2e runs the two-device and saved-view scripts')
  const nightly = read('.github/workflows/nightly.yml')
  assert.match(nightly, /^ {2}schedule:\n {4}- cron: /m)
  assert.match(nightly, /go test -race /)
})

test('Dependabot keeps every pinned ecosystem current', () => {
  const d = read('.github/dependabot.yml')
  for (const [eco, dir] of [['gomod', '/'], ['npm', '/web'], ['github-actions', '/'], ['docker', '/']]) {
    const entry = d.match(new RegExp(`- package-ecosystem: ${eco}\\n {4}directory: ${dir.replace('/', '\\/')}\\n((?: {4}.*\\n|\\s*\\n)*)`))
    assert.ok(entry, `dependabot.yml updates ${eco} in ${dir}`)
    assert.match(entry[1], /interval: weekly/, `${eco} weekly`)
    assert.match(entry[1], /groups:/, `${eco} grouped`)
  }
})

test('sensitive paths have a code owner and SECURITY.md names private reporting', () => {
  const owners = read('.github/CODEOWNERS')
  for (const p of ['/.github/', '/Dockerfile', '/internal/auth/', '/internal/httpapi/', '/internal/e2ee/', '/internal/store/migrations/']) {
    assert.match(owners, new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+@pixari$`, 'm'), `CODEOWNERS covers ${p}`)
  }
  assert.match(read('SECURITY.md'), /https:\/\/github\.com\/pixari\/opentodo\/security\/advisories\/new/)
})

/** Paths the .dockerignore excludes (the subset of its syntax we use: names, dir/, *.ext at the root, !negation). */
function dockerIgnored(file) {
  const rules = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  let ignored = false
  for (const r of rules) {
    const neg = r.startsWith('!')
    const pat = (neg ? r.slice(1) : r).replace(/\/$/, '')
    const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '(?:/.*)?$')
    if (re.test(file)) ignored = !neg
  }
  return ignored
}

test('.dockerignore leaves out what the image does not need and keeps what the Dockerfile copies', () => {
  const copies = [...read('Dockerfile').matchAll(/^COPY (?!--from)(?:--\S+ )*(.+) \S+$/gm)].flatMap((m) => m[1].split(/\s+/))
  assert.ok(copies.length >= 4)
  for (const c of copies) {
    const p = c.replace(/\/$/, '')
    assert.ok(!dockerIgnored(p), `.dockerignore excludes ${p}, which the Dockerfile copies`)
  }
  for (const p of ['web/src/ui/__screenshots__/button-light.png', 'docs/screenshots/demo.gif', 'scripts/e2e-smoke.mjs', 'deploy/coolify/opentodo.yaml', 'web/node_modules/x']) {
    assert.ok(dockerIgnored(p), `.dockerignore should exclude ${p}`)
  }
  // Files inside copied folders that the web build needs stay in.
  for (const p of ['web/src/main.tsx', 'web/package-lock.json', 'internal/web/web.go', 'go.sum']) assert.ok(!dockerIgnored(p), `${p} stays in the build context`)
})

// ---- contributor docs (OpenSpec change contributor-docs-and-template-checks) ----

/** Every Go package under internal/ (a directory holding .go files), as `internal/<path>`. */
function internalPackages(dir = 'internal') {
  const out = []
  const entries = readdirSync(path.join(root, dir), { withFileTypes: true })
  if (entries.some((e) => e.isFile() && e.name.endsWith('.go'))) out.push(dir)
  for (const e of entries) {
    if (e.isDirectory() && !['testdata', 'dist', 'node_modules'].includes(e.name)) out.push(...internalPackages(`${dir}/${e.name}`))
  }
  return out
}

test('AGENTS.md names every internal/ package', () => {
  const agents = read('AGENTS.md')
  const pkgs = internalPackages()
  assert.ok(pkgs.length > 30, `expected the internal/ packages, found ${pkgs.length}`)
  const missing = pkgs.filter((p) => !agents.includes('`' + p + '`'))
  assert.deepEqual(missing, [], 'add each package to the Layout section of AGENTS.md as `internal/<path>` with what it does')
})

test('docs/architecture.md has a row for every internal/ package', () => {
  const arch = read('docs/architecture.md')
  const missing = []
  for (const p of internalPackages()) {
    const [, top, ...sub] = p.split('/')
    if (sub.length === 0 ? !arch.includes('| `' + top + '` |') : !arch.includes('`' + sub.join('/') + '`')) missing.push(p)
  }
  assert.deepEqual(missing, [], 'add a row (or, for a sub-package, a mention in its parent row) to "Server packages" in docs/architecture.md')
})

test('AGENTS.md lists every API token scope and does not call the MCP server read-only', () => {
  const agents = read('AGENTS.md')
  const scopes = [...read('internal/auth/service.go').matchAll(/^\s*Scope[A-Z]\w*\s*=\s*"([a-z]+)"/gm)].map((m) => m[1])
  assert.ok(scopes.length >= 4, `expected the token scopes, found ${scopes.join(', ')}`)
  const listed = agents.match(/API tokens have a scope (`[a-z]+`(?:\|`[a-z]+`)*)/)
  assert.ok(listed, 'AGENTS.md names the token scopes as `a`|`b`|...')
  assert.deepEqual(listed[1].split('|').map((s) => s.slice(1, -1)).sort(), [...scopes].sort())
  assert.doesNotMatch(agents, /`internal\/mcp` read-only/, 'the MCP server has write tools (agent tokens)')
  assert.match(agents, /`internal\/mcp`[^;]*write tools/)
})
