// node --test scripts/deploy/truenas.test.mjs  (OpenSpec change platform-catalogs)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configVariables, loadFacts, readText } from './common.mjs'
import { APP, check, checkApp, checkUpstream, FILES } from './truenas.mjs'
import { parseYaml } from './yaml.mjs'

const facts = loadFacts()
const ctx = { facts, configVars: configVariables(), changelog: readText('CHANGELOG.md') }
const files = Object.fromEntries(FILES.map((f) => [f, readText(`${APP}/${f}`)]))
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected an error matching ${re}, got:\n${errors.join('\n')}`)
/** The app with one file changed by `fn`; the replaced text must exist. */
const edit = (file, from, to) => {
  assert.ok(files[file].includes(from), `${file} does not contain ${from}`)
  return { ...files, [file]: files[file].replace(from, to) }
}
const COMPOSE = 'templates/docker-compose.yaml'
const TEST = 'templates/test_values/basic-values.yaml'

test('truenas: the committed app passes', () => {
  assert.deepEqual(check(ctx), [])
  assert.deepEqual(checkApp(files, ctx), [])
})

test('truenas: image policy release, app_version follows the tag', () => {
  has(checkApp(edit('ix_values.yaml', 'tag: "0.6.1"', 'tag: "stable"'), ctx), /image must be ghcr\.io\/pixari\/opentodo:0\.6\.1/)
  has(checkApp(edit('ix_values.yaml', 'tag: "0.6.1"', 'tag: "latest"'), ctx), /image must be ghcr\.io\/pixari\/opentodo:0\.6\.1/)
  has(checkApp(edit('ix_values.yaml', 'tag: "0.6.1"', 'tag: "0.6.0"'), ctx), /app_version \(0\.6\.1\) must equal the image tag/)
  has(checkApp(edit('ix_values.yaml', 'tag: "0.6.1"', 'tag: 0.6'), ctx), /must be a quoted string/)
  has(checkApp(edit('ix_values.yaml', 'repository: ghcr.io/pixari/opentodo', 'repository: pixari/opentodo'), ctx), /image must be/)
})

test('truenas: port, listen address and data path', () => {
  has(checkApp(edit(TEST, 'port_number: 8080', 'port_number: 3000'), ctx), /port must be 8080, got 3000/)
  has(checkApp(edit(COMPOSE, '{% do c1.add_port(values.network.web_port) %}', '{% do c1.add_port(values.network.web_port, {"container_port": 8080}) %}'), ctx), /container_port/)
  has(checkApp(edit(COMPOSE, '":%d"|format(values.network.web_port.port_number)', '":8080"'), ctx), /OPENTODO_ADDR must be set to/)
  has(checkApp(edit('questions.yaml', 'default: 30530', 'default: 8080'), ctx), /must default to 30530/)
  has(checkApp(edit(COMPOSE, 'add_storage("/data", values.storage.data)', 'add_storage("/config", values.storage.data)'), ctx), /mounted on \/data/)
  has(checkApp(edit(COMPOSE, 'add_env("OPENTODO_DATA_DIR", "/data")', 'add_env("OPENTODO_DATA_DIR", "/config")'), ctx), /OPENTODO_DATA_DIR must be set to "\/data"/)
})

test('truenas: health check, user and maintainers', () => {
  has(checkApp(edit(COMPOSE, 'set_custom_test(["CMD", "/opentodo", "healthcheck"])', 'set_test("wget", {"port": 8080})'), ctx), /set_custom_test\(\["CMD", "\/opentodo", "healthcheck"\]\)/)
  has(checkApp(edit(COMPOSE, '{% do c1.set_user(values.run_as.user, values.run_as.group) %}\n', ''), ctx), /set_user/)
  has(checkApp(edit('questions.yaml', 'min: 568\n            default: 568', 'min: 568\n            default: 1000'), ctx), /run_as\.user must default to 568/)
  has(checkApp(edit('app.yaml', 'name: truenas', 'name: pixari'), ctx), /maintainers must stay truenas/)
  has(checkApp(edit('app.yaml', 'categories:\n- productivity', 'categories:\n- tools'), ctx), /categories must be \[productivity\]/)
})

test('truenas: variables', () => {
  const unknown = edit(COMPOSE, '{% do c1.environment.add_user_envs', '{% do c1.environment.add_env("OPENTODO_NOPE", values.opentodo.base_url) %}\n{% do c1.environment.add_user_envs')
  has(checkApp(unknown, ctx), /OPENTODO_NOPE is not read by internal\/config/)
  const notCatalogued = edit(COMPOSE, '{% do c1.environment.add_user_envs', '{% do c1.environment.add_env("OPENTODO_MCP", values.opentodo.base_url) %}\n{% do c1.environment.add_user_envs')
  has(checkApp(notCatalogued, ctx), /OPENTODO_MCP is not in the variable catalogue/)
  has(checkApp(edit(COMPOSE, '{% do c1.environment.add_env("OPENTODO_TRUSTED_PROXIES", values.opentodo.trusted_proxies) %}\n', ''), ctx), /OPENTODO_TRUSTED_PROXIES must be offered/)
  has(checkApp(edit(COMPOSE, 'values.opentodo.allow_signup)', '"true")'), ctx), /must come from a question/)
  has(checkApp(edit('questions.yaml', 'type: boolean\n            default: false', 'type: boolean\n            default: true'), ctx), /OPENTODO_ALLOW_SIGNUP defaults to "true", the catalogue says "false"/)
  has(checkApp(edit('questions.yaml', 'default: ""\n            private: true', 'default: ""\n            required: true\n            private: true'), ctx), /OPENTODO_SETUP_TOKEN must not be required/)
  has(checkApp(edit('questions.yaml', 'default: ""\n            private: true', 'default: ""'), ctx), /must be private: true/)
  has(checkApp(edit(TEST, '  trusted_proxies: ""\n', ''), ctx), /basic-values\.yaml: opentodo\.trusted_proxies is missing/)
})

test('truenas: metadata and strict YAML', () => {
  has(checkApp(edit('item.yaml', '- todo\n', ''), ctx), /item\.yaml must match app\.yaml/)
  has(checkApp(edit('app.yaml', 'lib_version_hash: ', 'lib_version_hash: x'), ctx), /lib_version_hash/)
  has(checkApp(edit('app.yaml', 'capabilities: []', 'capabilities:\n- description: x\n  name: NET_ADMIN'), ctx), /capabilities must be \[\]/)
  has(checkApp(edit('ix_values.yaml', 'images:', 'images: &a'), ctx), /not in the supported YAML subset/)
  has(checkApp(edit('app.yaml', 'title: OpenTodo', 'title: OpenTodo\ntitle: Other'), ctx), /duplicate key title/)
  has(checkApp({ ...files, 'README.md': null }, ctx), /README\.md is missing/)
})

test('truenas: the truenas/apps copy', () => {
  const list = [...FILES].sort()
  assert.deepEqual(checkUpstream(files, files, list), [])
  has(checkUpstream(files, { ...files, 'app.yaml': files['app.yaml'].replace('1.0.0', '1.0.1') }, list), /upstream\/ix-dev\/community\/opentodo\/app\.yaml must be identical/)
  has(checkUpstream(files, files, [...list, 'templates/rendered/docker-compose.yaml']), /not part of the app here/)
})

test('truenas-yaml: the subset it reads, and what it refuses', () => {
  assert.deepEqual(parseYaml('a:\n  b: "x"\n  c: [1, "two", [three]]\nd:\n- e: 1\n  f: true\n- plain\ng: |\n  one\n  two\nh:\n  folded\n  text\n"null": {}\n'), {
    a: { b: 'x', c: [1, 'two', ['three']] }, d: [{ e: 1, f: true }, 'plain'], g: 'one\ntwo\n', h: 'folded text', null: {},
  })
  assert.deepEqual(parseYaml("v: 0.6.1 # comment\nw: 'it''s'\nx: http://a/#b\n"), { v: '0.6.1', w: "it's", x: 'http://a/#b' })
  for (const bad of ['a: *x\n', 'a: {b: 1}\n', 'a:\n\tb: 1\n', 'a: 1\n  b: 2\n', 'a:\n  b: 1\n c: 2\n', 'a: "x\n', 'a: b: c\n']) {
    assert.throws(() => parseYaml(bad), undefined, JSON.stringify(bad))
  }
})
