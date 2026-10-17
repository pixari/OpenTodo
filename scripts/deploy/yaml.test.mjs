// node --test scripts/deploy/yaml.test.mjs  (OpenSpec change contributor-docs-and-template-checks)
// The one strict YAML subset parser every deploy template check uses, and its profiles.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT } from './common.mjs'
import { parseYaml, splitComment, YAML_CASAOS, YAML_COMPOSE, YAML_FULL, YAML_UMBREL_MANIFEST } from './yaml.mjs'

const PROFILES = { YAML_FULL, YAML_COMPOSE, YAML_CASAOS, YAML_UMBREL_MANIFEST }

test('yaml: every profile refuses what the subset does not cover', () => {
  const refused = {
    anchor: 'a: &x 1\n',
    alias: 'a: *x\n',
    tag: 'a: !!str 1\n',
    'flow map': 'a: {b: 1}\n',
    directive: 'a: %YAML\n',
    tab: 'a:\n\tb: 1\n',
    'CR line ending': 'a: 1\r\n',
    'duplicate key': 'a: 1\na: 2\n',
    'odd indentation': 'a:\n  b: 1\n c: 2\n',
    'indented value after a scalar': 'a: 1\n  b: 2\n',
    'unterminated quote': 'a: "x\n',
    'plain ": "': 'a: b: c\n',
    'keep chomping': 'a: |+\n  x\n',
  }
  for (const [name, profile] of Object.entries(PROFILES)) {
    for (const [what, text] of Object.entries(refused)) {
      assert.throws(() => parseYaml(text, profile), /line \d+:/, `${name} must refuse ${what}`)
    }
    assert.throws(() => parseYaml('a: &x 1\n', profile), /unsupported YAML.*not in the supported YAML subset/)
  }
})

test('yaml: every profile reads quotes, comments, flow sequences and folded plain text the same way', () => {
  const text = "a: 'it''s' # note\nb: \"q\\\"x\"\nc: [\"x\", 'y', [z]]\nd: http://a/#b\ne:\n  folded\n  text\nf: {}\ng:\n"
  for (const [name, profile] of Object.entries(PROFILES)) {
    assert.deepEqual(parseYaml(text, profile), { a: "it's", b: 'q"x', c: ['x', 'y', ['z']], d: 'http://a/#b', e: 'folded text', f: {}, g: null }, name)
  }
  assert.deepEqual(splitComment('  - A=${B:-x} # note'), ['  - A=${B:-x}', 'note'])
  assert.deepEqual(splitComment("  - it's # x"), ["  - it's", 'x'])
})

test('yaml: typed profiles resolve YAML 1.2 core scalars, string profiles keep the text', () => {
  const text = 'a: 8080\nb: true\nc: null\nd: 2.0\ne: "8080"\n'
  assert.deepEqual(parseYaml(text, YAML_FULL), { a: 8080, b: true, c: null, d: 2, e: '8080' })
  assert.deepEqual(parseYaml(text, YAML_CASAOS), { a: 8080, b: true, c: null, d: 2, e: '8080' })
  assert.deepEqual(parseYaml(text, YAML_COMPOSE), { a: '8080', b: 'true', c: 'null', d: '2.0', e: '8080' })
  assert.deepEqual(parseYaml(text, YAML_UMBREL_MANIFEST), { a: '8080', b: 'true', c: 'null', d: '2.0', e: '8080' })
})

test('yaml: block scalars only where the profile allows them, folded per the YAML spec', () => {
  const literal = 'a: |\n  one\n  two\n'
  const folded = 'a: >-\n  one\n  two\n\n\n  three\n'
  assert.equal(parseYaml(literal, YAML_FULL).a, 'one\ntwo\n')
  assert.equal(parseYaml(literal, YAML_CASAOS).a, 'one\ntwo\n')
  assert.equal(parseYaml('a: |-\n  one\n', YAML_CASAOS).a, 'one')
  assert.equal(parseYaml(folded, YAML_FULL).a, 'one two\n\nthree')
  assert.equal(parseYaml('a: >\n  one\n\n  two\n', YAML_FULL).a, 'one\ntwo\n')
  assert.equal(parseYaml(folded, YAML_UMBREL_MANIFEST).a, 'one two\n\nthree')
  assert.throws(() => parseYaml(literal, YAML_UMBREL_MANIFEST), /unsupported YAML: block scalar \| \(this file may use only >-\)/)
  assert.throws(() => parseYaml(folded, YAML_CASAOS), /unsupported YAML: block scalar >-/)
  assert.throws(() => parseYaml(literal, YAML_COMPOSE), /unsupported YAML: block scalar \| \(this file may use none\)/)
})

test('yaml: maps inside sequences and unquoted dates only where the profile allows them', () => {
  const items = 'a:\n  - b: "1"\n    c: 2\n  - [x, "y"]\n'
  assert.deepEqual(parseYaml(items, YAML_CASAOS), { a: [{ b: '1', c: 2 }, ['x', 'y']] })
  assert.deepEqual(parseYaml(items, YAML_UMBREL_MANIFEST), { a: [{ b: '1', c: '2' }, ['x', 'y']] })
  assert.throws(() => parseYaml(items, YAML_COMPOSE), /maps inside sequences/)
  assert.throws(() => parseYaml('a:\n  -\n    b: 1\n', YAML_COMPOSE), /maps inside sequences/)
  assert.deepEqual(parseYaml('a:\n  - A=${B:-x}\n  - opentodo-data:/data\n', YAML_COMPOSE), { a: ['A=${B:-x}', 'opentodo-data:/data'] })
  assert.equal(parseYaml('d: 2026-10-17\n', YAML_FULL).d, '2026-10-17')
  assert.throws(() => parseYaml('d: 2026-10-17\n', YAML_CASAOS), /quote dates/)
  assert.equal(parseYaml('d: "2026-10-17"\n', YAML_CASAOS).d, '2026-10-17')
})

test('yaml: no template checker carries its own YAML parser', () => {
  const dir = join(ROOT, 'scripts/deploy')
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'yaml.mjs').map((f) => join(dir, f)), join(ROOT, 'scripts/coolify-template-check.mjs')]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /function (parseYaml|parseManifest|parseScalar|splitComment|blockScalar)\b|function (scalar|literal|fold)\(/, `${f} must use scripts/deploy/yaml.mjs`)
  }
})
