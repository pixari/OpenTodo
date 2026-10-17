#!/usr/bin/env node
// Refreshes the image digests that pinned platform templates carry (OpenSpec change
// platform-catalogs). Umbrel requires `ghcr.io/pixari/opentodo:<version>@sha256:<index digest>`;
// the digest only exists once the release job has published the image, so this runs after a
// release, not in the release preparation.
//
//   node scripts/deploy/pin.mjs           rewrite every pinned reference under deploy/ with the
//                                          registry's multi-arch index digest for its version
//   node scripts/deploy/pin.mjs --check   only report references whose digest is out of date
//
// Reads the public registry anonymously (ghcr.io token endpoint, then a HEAD on the manifest).

import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listFiles, loadFacts, ROOT } from './common.mjs'

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ')

/** The multi-arch index digest of <image>:<version> on ghcr.io. */
export async function indexDigest(image, version, fetchImpl = fetch) {
  const repo = image.replace(/^ghcr\.io\//, '')
  const tok = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`)
  if (!tok.ok) throw new Error(`ghcr.io token: HTTP ${tok.status}`)
  const { token } = await tok.json()
  const res = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${version}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${token}`, Accept: INDEX_TYPES },
  })
  if (!res.ok) throw new Error(`${image}:${version} is not published (HTTP ${res.status})`)
  const digest = res.headers.get('docker-content-digest')
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`${image}:${version}: no digest in the registry's answer`)
  return digest
}

/** Every `<image>:<x.y.z>@sha256:<hex>` reference in deploy/, with its file. */
export function pinnedRefs(root = ROOT, image = loadFacts(root).image) {
  const esc = image.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const re = new RegExp(`${esc}:(\\d+\\.\\d+\\.\\d+)@(sha256:[0-9a-f]{64})`, 'g')
  const refs = []
  for (const file of listFiles(join(root, 'deploy'))) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(re)) refs.push({ file, version: m[1], digest: m[2], ref: m[0] })
  }
  return refs
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check')
  const { image } = loadFacts()
  const refs = pinnedRefs()
  const want = new Map()
  for (const v of new Set(refs.map((r) => r.version))) want.set(v, await indexDigest(image, v))
  let stale = 0
  for (const r of refs) {
    const d = want.get(r.version)
    if (d === r.digest) continue
    stale++
    const rel = relative(ROOT, r.file)
    if (check) { console.error(`${rel}: ${r.version} is ${d}, the file says ${r.digest}`); continue }
    writeFileSync(r.file, readFileSync(r.file, 'utf8').replaceAll(r.ref, `${image}:${r.version}@${d}`))
    console.log(`${rel}: ${r.version} → ${d}`)
  }
  if (!stale) console.log(`pin: ${refs.length} pinned reference(s), all current`)
  if (check && stale) process.exit(1)
}
