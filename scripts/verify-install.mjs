#!/usr/bin/env node
/**
 * dsh-browser / scripts / verify-install.mjs
 *
 * Self-check for the packaged plugin, run BEFORE it is installed into a live
 * profile. It does not need a running host, a browser, or network access:
 *
 *   1. package manifest  — name, exports, `dsh.bundle.patch`, `dsh.client`,
 *      runtime dependencies, `files` entries (all must exist);
 *   2. bundle patch       — insert row id/name, config values, no `disabled`;
 *   3. syntax             — `node --check` for every `lib/**\/*.js` file;
 *   4. host entry         — stable imports, exactly one manager factory call;
 *   5. locale             — ru/en dictionaries cover the contract key set;
 *   6. profile-dir chain  — DSH_PROFILE_DIR → DSH_HOME/profiles/DSH_PROFILE;
 *   7. fake-ctx boots     — full host (tools + prompt + routes + dispose),
 *      headless host (lazy routes on `internal/service`), minimal host
 *      (no tools/systemPrompt/webServer at all).
 *
 * `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` live inside the
 * application's `app.asar` and are only resolvable at runtime through the
 * host's `linkedProfileRoots`, so this script maps them to tiny recording
 * stubs with a Node resolve hook (same pattern as scripts/test-routes.mjs).
 * Run it from anywhere:
 *
 *   node dsh-browser/scripts/verify-install.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { register } from 'node:module'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirs = []

/** Recorded checks, printed in order at the end. */
const checks = []
/** @type {string[]} */
const failures = []

/**
 * Run one named check.
 * @param {string} title human-readable check name
 * @param {() => void | Promise<void>} body assertion body
 */
async function check(title, body) {
  try {
    await body()
    checks.push({ title, ok: true })
    console.log(`ok   ${title}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    checks.push({ title, ok: false, detail })
    failures.push(`${title}: ${detail}`)
    console.log(`FAIL ${title}\n     ${detail}`)
  }
}

/** Create a temporary directory that is removed before the script exits. */
function temporaryDirectory(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

/** Read and parse a JSON file. */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ---------------------------------------------------------------------------
// Stub resolution: the DSH runtime packages are not installed in this checkout
// ---------------------------------------------------------------------------

/**
 * Register a resolve hook that maps the two runtime-only packages to recording
 * stubs, and return the directory holding them.
 *
 * The schemastery stub records the authored shape so the script can assert the
 * contract's config keys, their kinds, defaults and bounds without the real
 * package; the tools stub keeps the authored tool definition object.
 */
async function registerRuntimeStubs() {
  const dir = temporaryDirectory('dsh-browser-verify-stubs-')
  const schemastery = path.join(dir, 'schemastery-stub.mjs')
  const tools = path.join(dir, 'dsh-tools-stub.mjs')
  const hook = path.join(dir, 'resolve-hook.mjs')

  fs.writeFileSync(schemastery, [
    '// Recording stub for @deepseek-ai/schemastery (structure assertions only).',
    '// `.default/.min/.max/.required` stay callable so the host entry reads',
    '// naturally; the recorded values live on `meta`.',
    'function schema(kind, meta = {}) {',
    '  const make = (extra) => schema(kind, { ...meta, ...extra })',
    '  return {',
    '    kind,',
    '    meta,',
    '    default: (value) => make({ default: value }),',
    '    min: (value) => make({ min: value }),',
    '    max: (value) => make({ max: value }),',
    '    required: () => make({ required: true }),',
    '  }',
    '}',
    'export const z = {',
    "  object: (shape) => schema('object', { shape }),",
    "  union: (variants) => schema('union', { variants }),",
    "  const: (value) => schema('const', { value }),",
    "  string: () => schema('string'),",
    "  natural: () => schema('natural'),",
    "  boolean: () => schema('boolean'),",
    "  array: (item) => schema('array', { item }),",
    '}',
    'export default z',
    '',
  ].join('\n'))
  fs.writeFileSync(tools, [
    '// Minimal @deepseek-ai/dsh-tools stub: definition identity is enough here.',
    'export function defineTool(options) {',
    '  return { ...options }',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(hook, [
    "import { pathToFileURL } from 'node:url'",
    `const schemastery = pathToFileURL(${JSON.stringify(schemastery)}).href`,
    `const tools = pathToFileURL(${JSON.stringify(tools)}).href`,
    'const MAPPING = new Map([',
    "  ['@deepseek-ai/schemastery', schemastery],",
    "  ['@deepseek-ai/dsh-tools', tools],",
    '])',
    'export async function resolve(specifier, context, next) {',
    '  const mapped = MAPPING.get(specifier)',
    '  if (mapped !== undefined) return { url: mapped, shortCircuit: true }',
    '  return next(specifier, context)',
    '}',
    '',
  ].join('\n'))

  register(pathToFileURL(hook))
  return dir
}

// The host entry imports these two packages while it loads, so the hook has to
// be registered before the dynamic import below.
await registerRuntimeStubs()

/** Host entry module (imported once; every boot reuses its `apply`). */
let indexModule
try {
  indexModule = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`dsh-dual-browser verify-install: cannot load lib/index.js: ${detail}`)
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const manifest = readJson(path.join(ROOT, 'package.json'))
const patchFile = path.join(ROOT, 'cordis.patch.yml')
/** Files declared in package.json `files`, resolved on disk. */
const declaredFiles = {
  lib: path.join(ROOT, 'lib'),
  locale: path.join(ROOT, 'locale'),
  'cordis.patch.yml': patchFile,
  'README.md': path.join(ROOT, 'README.md'),
}

await check('manifest: package identity', () => {
  assert.equal(manifest.name, 'dsh-dual-browser', 'package name must be dsh-dual-browser (bundle row + client module id)')
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+/, 'version must be semver')
  assert.equal(manifest.type, 'module', 'package must be ESM (type: module)')
  assert.equal(manifest.main, 'lib/index.js', 'main must point at the host entry')
  assert.equal(manifest.engines?.node !== undefined, true, 'engines.node is required')
})

await check('manifest: exports ., ./client, ./cordis.patch.yml, ./package.json', () => {
  const exported = manifest.exports ?? {}
  for (const key of ['.', './client', './cordis.patch.yml', './package.json']) {
    assert.equal(typeof exported[key], 'string', `exports["${key}"] must be a path string`)
    const target = path.resolve(ROOT, exported[key])
    assert.equal(fs.existsSync(target), true, `exports["${key}"] target ${exported[key]} does not exist`)
  }
  assert.equal(path.resolve(ROOT, exported['.']), path.join(ROOT, 'lib', 'index.js'))
  assert.equal(path.resolve(ROOT, exported['./client']), path.join(ROOT, 'lib', 'client.js'))
  assert.equal(path.resolve(ROOT, exported['./cordis.patch.yml']), patchFile)
})

await check('manifest: dsh.bundle.patch points at the bundle patch', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(fs.existsSync(patchFile), true, 'cordis.patch.yml is missing')
})

await check('manifest: dsh.client declares the web client and its client packages', () => {
  const client = manifest.dsh?.client
  assert.ok(client !== null && typeof client === 'object', 'dsh.client is required for the panel half')
  assert.equal(client.platform, 'web', 'the panel is a web client bundle')
  assert.ok(Array.isArray(client.inject), 'dsh.client.inject must be an array')
  for (const dependency of [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ]) {
    assert.ok(client.inject.includes(dependency), `dsh.client.inject must declare ${dependency}`)
  }
  for (const entry of client.inject) {
    assert.ok(entry.startsWith('@deepseek-ai/'), `dsh.client.inject entries must be client packages, found ${entry}`)
  }
})

await check('manifest: playwright-core is the only runtime dependency', () => {
  const runtime = Object.keys(manifest.dependencies ?? {})
  assert.deepEqual(runtime, ['playwright-core'], 'contract §2 allows no runtime dependency besides playwright-core')
  assert.equal(typeof manifest.dependencies['playwright-core'], 'string', 'pin playwright-core to a version range')
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    assert.equal(typeof range, 'string', `peer ${peer} must use a version range`)
    assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `peer ${peer} must be optional (host-provided)`)
  }
})

await check('manifest: files entries exist on disk (lib, locale, patch, README)', () => {
  assert.ok(Array.isArray(manifest.files), 'files must be an array')
  for (const entry of ['lib', 'locale', 'cordis.patch.yml', 'README.md']) {
    assert.ok(manifest.files.includes(entry), `files must include ${entry}`)
    assert.equal(fs.existsSync(declaredFiles[entry]), true, `declared file ${entry} is missing on disk`)
  }
})

// ---------------------------------------------------------------------------
// Bundle patch
// ---------------------------------------------------------------------------

await check('patch: insert row id/name dsh-dual-browser', () => {
  const text = fs.readFileSync(patchFile, 'utf8')
  assert.match(text, /^-\s+insert:\s*$/m, 'the patch must insert the plugin row')
  assert.match(text, /^\s+-\s+id:\s*dsh-dual-browser\s*$/m, 'row id must be dsh-dual-browser')
  assert.match(text, /^\s+name:\s*['"]dsh-dual-browser['"]\s*$/m, 'row name must be the package name dsh-dual-browser')
  assert.doesNotMatch(text, /^\s+disabled:\s*true\s*$/m, 'the row must not be disabled')
})

await check('patch: config mirrors contract §4 defaults', () => {
  const text = fs.readFileSync(patchFile, 'utf8')
  const expected = {
    mode: 'auto',
    searchEngine: 'duckduckgo',
    hiddenIdleMs: '45000',
    promptSectionOrder: '118',
  }
  for (const [key, value] of Object.entries(expected)) {
    const pattern = new RegExp(`^\\s+${key}:\\s*['"]?${value}['"]?\\s*$`, 'm')
    assert.match(text, pattern, `config.${key} must be ${value}`)
  }
})

await check('patch: no stale manual-enable / rejected-CLI instruction', () => {
  const text = fs.readFileSync(patchFile, 'utf8')
  assert.doesNotMatch(text, /then enable the bundle/i, 'the bundle enables itself on install; drop the manual enable step')
  assert.doesNotMatch(text, /dsh plugin --profile desktop add/, 'the desktop profile CLI is rejected; document install_bundle only')
})

// ---------------------------------------------------------------------------
// Syntax + host entry structure
// ---------------------------------------------------------------------------

await check('syntax: node --check passes for every lib/**/*.js', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full)
    }
  }
  walk(path.join(ROOT, 'lib'))
  assert.ok(files.length >= 6, `expected the host entry, the client bundle and the server modules, found ${files.length}`)
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${path.relative(ROOT, file)} does not parse: ${result.stderr?.trim()}`)
  }
})

const entrySource = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')

await check('entry: imports exactly the four server modules of contract §3', () => {
  const relative = [...entrySource.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1])
  assert.deepEqual(
    relative.sort(),
    ['./server/manager.js', './server/prompt.js', './server/routes.js', './server/tools.js'],
    'lib/index.js must import only the four stable server modules',
  )
  for (const name of ['createBrowserManager', 'registerBrowserTools', 'registerBrowserRoutes', 'registerBrowserPrompt']) {
    assert.match(entrySource, new RegExp(`import\\s*\\{[^}]*${name}[^}]*\\}`), `${name} must be imported by name`)
  }
})

await check('entry: one manager factory call, disposed through ctx.effect', () => {
  const calls = [...entrySource.matchAll(/=\s*createBrowserManager\(/g)]
  assert.equal(calls.length, 1, `createBrowserManager must be called exactly once, found ${calls.length}`)
  assert.match(entrySource, /ctx\.effect\(\(\)\s*=>\s*\(\)\s*=>\s*manager\.dispose\(\)/, 'the manager must be disposed by a ctx.effect')
  assert.match(entrySource, /registerBrowserRoutes\(ctx, manager, settings\)/, 'routes must be registered unconditionally (they self-lazily bind)')
})

await check('entry: declares the tools service dependency via inject', () => {
  assert.deepEqual(indexModule.inject, ['tools'], 'cordis refuses `ctx.tools` access without a declared inject')
  assert.doesNotMatch(entrySource, /ctx\.tools\b/, 'only lib/server/tools.js may touch ctx.tools')
  assert.doesNotMatch(entrySource, /ctx\.systemPrompt\b/, 'the system prompt is optional and accessed through the service seam')
})

await check('entry: exports name/Config/apply and the profile-dir resolver', async () => {
  assert.equal(indexModule.name, 'dsh-dual-browser')
  assert.equal(typeof indexModule.apply, 'function', 'apply(ctx, config) is the host entry')
  assert.equal(typeof indexModule.resolveProfileDir, 'function', 'resolveProfileDir must be exported for verification')
  assert.ok(indexModule.Config !== undefined && indexModule.Config !== null, 'Config (schemastery) must be exported')
})

// ---------------------------------------------------------------------------
// Locale dictionaries
// ---------------------------------------------------------------------------

/** Locale keys required by contract §10.4 (the client bundle may add keys). */
const CONTRACT_LOCALE_KEYS = [
  'panel.title', 'page.title', 'page.subtitle',
  'mode.label', 'mode.auto', 'mode.visible', 'mode.auto.desc', 'mode.visible.desc', 'mode.saving',
  'status.engine', 'status.sessions', 'status.ready', 'status.missing', 'status.hiddenIdle',
  'sessions.title', 'sessions.empty', 'sessions.emptyHint', 'sessions.hidden', 'sessions.visible',
  'activity.title', 'activity.empty', 'activity.clear',
  'action.close', 'action.closeAll', 'action.refresh',
  'state.loading', 'state.error', 'state.retry', 'footer.note',
  'kind.launch', 'kind.open', 'kind.search', 'kind.read', 'kind.click', 'kind.type',
  'kind.screenshot', 'kind.close', 'kind.auto-close', 'kind.error', 'kind.mode',
]

const ruDictionary = readJson(path.join(ROOT, 'locale', 'ru.json'))
const enDictionary = readJson(path.join(ROOT, 'locale', 'en.json'))

await check('locale: ru/en have the same keys and no empty strings', () => {
  const ruKeys = Object.keys(ruDictionary).sort()
  const enKeys = Object.keys(enDictionary).sort()
  assert.deepEqual(ruKeys, enKeys, 'ru.json and en.json key sets must match')
  for (const [locale, dictionary] of [['ru', ruDictionary], ['en', enDictionary]]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`)
      assert.ok(value.trim() !== '', `${locale}.${key} must not be empty`)
    }
  }
})

await check('locale: contract §10.4 keys are covered', () => {
  const keys = new Set(Object.keys(ruDictionary))
  const missing = CONTRACT_LOCALE_KEYS.filter((key) => !keys.has(key))
  assert.deepEqual(missing, [], `missing locale keys: ${missing.join(', ')}`)
  assert.match(ruDictionary['panel.title'], /[А-Яа-я]/, 'ru.json must be Russian')
  assert.doesNotMatch(enDictionary['panel.title'], /[А-Яа-я]/, 'en.json must be English')
})

// ---------------------------------------------------------------------------
// Profile directory resolution (contract §4)
// ---------------------------------------------------------------------------

const savedEnvironment = {
  DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  DSH_HOME: process.env.DSH_HOME,
  DSH_PROFILE: process.env.DSH_PROFILE,
}

/** Restore one environment key (undefined deletes it). */
function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

await check('profileDir: DSH_PROFILE_DIR wins, then DSH_HOME/DSH_PROFILE, then profileContext, then ~/.dsh', () => {
  const explicit = path.join(os.tmpdir(), 'dsh-browser-explicit-profile')
  process.env.DSH_PROFILE_DIR = explicit
  assert.equal(indexModule.resolveProfileDir({}), path.resolve(explicit))

  delete process.env.DSH_PROFILE_DIR
  const home = path.join(os.tmpdir(), 'dsh-browser-home')
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'test'
  assert.equal(indexModule.resolveProfileDir({}), path.join(path.resolve(home), 'profiles', 'test'))

  delete process.env.DSH_HOME
  delete process.env.DSH_PROFILE
  const contextDir = path.join(os.tmpdir(), 'dsh-browser-context-profile')
  const contextCtx = { get: (name) => (name === 'profileContext' ? { name: 'custom', dir: contextDir } : undefined) }
  assert.equal(indexModule.resolveProfileDir(contextCtx), path.resolve(contextDir))

  assert.equal(
    indexModule.resolveProfileDir(undefined),
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
  )
})

// ---------------------------------------------------------------------------
// Fake host contexts
// ---------------------------------------------------------------------------

/** Tool registry stand-in: records every authored definition. */
function createFakeTools() {
  return {
    registered: [],
    register(tool) {
      this.registered.push(tool)
    },
  }
}

/** System-prompt stand-in: records every section. */
function createFakeSystemPrompt() {
  return {
    sections: [],
    section(section) {
      this.sections.push(section)
    },
  }
}

/** Web server stand-in: records exact route registrations. */
function createFakeWebServer() {
  return {
    routes: [],
    register(definition) {
      this.routes.push(definition)
    },
  }
}

/** Connection gate that always allows the request. */
function createFakeConnection() {
  return {
    requestRejection() {
      return undefined
    },
  }
}

/**
 * Cordis-shaped fake context. Implemented surface: `get`, `on`/emit,
 * `effect`, `inject`, and the services passed in `services`.
 *
 * @param {object} [options]
 * @param {Map<string, unknown>} [options.services]
 * @param {boolean} [options.inject] provide an `inject` seam
 */
function createFakeCtx(options = {}) {
  const services = options.services ?? new Map()
  const context = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effects: [],
    listeners: new Map(),
    injected: [],
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
    },
    on(event, callback) {
      const list = context.listeners.get(event) ?? []
      list.push(callback)
      context.listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const callback of [...(context.listeners.get(event) ?? [])]) callback(...args)
    },
    effect(callback, label) {
      const disposer = callback()
      context.effects.push({ label, disposer })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    /** Run every collected effect disposer, newest first (cordis order). */
    async dispose() {
      for (const frame of [...context.effects].reverse()) {
        if (typeof frame.disposer === 'function') await frame.disposer()
      }
      context.effects.length = 0
    },
  }
  if (options.inject !== false) {
    // Mirrors cordis: `ctx.inject(deps, callback)` starts a child plugin whose
    // context declares `deps`; when they are already available it loads at
    // once, otherwise it waits for the service to bind.
    context.inject = (dependencies, callback) => {
      const available = dependencies.every((name) => services.get(name) !== undefined)
      if (available) callback(context)
      else context.injected.push({ dependencies, callback })
      return () => {}
    }
  }
  // Cordis exposes services both through `ctx.get(name)` and as properties on
  // the context; the plugin uses both, so the fake must too.
  for (const serviceName of ['tools', 'systemPrompt', 'webServer', 'connection', 'profileContext']) {
    Object.defineProperty(context, serviceName, {
      configurable: true,
      enumerable: true,
      get: () => services.get(serviceName),
    })
  }
  return context
}

/** Minimal readable request for a route handler. */
function createRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  request.method = method
  request.url = url
  request.headers = headers
  return request
}

/** Minimal ServerResponse stand-in. */
function createResponse() {
  const response = {
    headersSent: false,
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers = {}) {
      response.statusCode = status
      response.headers = { ...response.headers, ...headers }
      response.headersSent = true
      return response
    },
    setHeader(name, value) {
      response.headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) response.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      response.ended = true
      return response
    },
  }
  return response
}

/** Dispatch one registered exact route. */
async function dispatch(route, options) {
  const response = createResponse()
  await route.handler(createRequest(options), response)
  const raw = Buffer.concat(response.chunks).toString('utf8')
  return { status: response.statusCode, headers: response.headers, text: raw, json: raw === '' ? undefined : JSON.parse(raw) }
}

/** Every browser_* tool name in registration order (contract §7). */
const EXPECTED_TOOL_NAMES = [
  'browser_status',
  'browser_search',
  'browser_open',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_close',
]
/** Every panel route (contract §8). */
const EXPECTED_ROUTES = [
  '/plugins/dsh-browser/state',
  '/plugins/dsh-browser/mode',
  '/plugins/dsh-browser/close',
  '/plugins/dsh-browser/clear',
  '/plugins/dsh-browser/screenshot',
]

// ---------------------------------------------------------------------------
// Config schema shape (recording schemastery stub)
// ---------------------------------------------------------------------------

await check('config: schemastery schema matches contract §4', () => {
  const schema = indexModule.Config
  assert.equal(schema.kind, 'object', 'Config must be a schemastery object')
  const shape = schema.meta.shape
  assert.deepEqual(
    Object.keys(shape).sort(),
    ['executablePath', 'hiddenIdleMs', 'maxActivity', 'maxSessions', 'mode', 'outputDir', 'promptSectionOrder', 'searchEngine'],
    'Config must declare exactly the eight contract keys',
  )
  assert.equal(shape.mode.kind, 'union')
  assert.deepEqual(shape.mode.meta.variants.map((variant) => variant.meta.value), ['auto', 'visible'])
  assert.equal(shape.mode.meta.default, 'auto')
  assert.equal(shape.searchEngine.kind, 'union')
  assert.deepEqual(shape.searchEngine.meta.variants.map((variant) => variant.meta.value), ['duckduckgo', 'bing'])
  assert.equal(shape.searchEngine.meta.default, 'duckduckgo')
  assert.equal(shape.hiddenIdleMs.kind, 'natural')
  assert.equal(shape.hiddenIdleMs.meta.min, 1000)
  assert.equal(shape.hiddenIdleMs.meta.default, 45000)
  assert.equal(shape.promptSectionOrder.kind, 'natural')
  assert.equal(shape.promptSectionOrder.meta.default, 118)
  assert.equal(shape.executablePath.kind, 'string')
  assert.equal(shape.executablePath.meta.default, undefined, 'executablePath falls back to engine detection, not to a path')
  assert.equal(shape.outputDir.kind, 'string')
  assert.equal(shape.outputDir.meta.default, '.dsh-browser')
  assert.equal(shape.maxActivity.kind, 'natural')
  assert.equal(shape.maxActivity.meta.min, 10)
  assert.equal(shape.maxActivity.meta.default, 40)
  assert.equal(shape.maxSessions.kind, 'natural')
  assert.equal(shape.maxSessions.meta.min, 1)
  assert.equal(shape.maxSessions.meta.default, 8)
})

// ---------------------------------------------------------------------------
// Boot A — full host: tools + prompt + routes + dispose
// ---------------------------------------------------------------------------

const profileDir = temporaryDirectory('dsh-browser-verify-profile-')
process.env.DSH_PROFILE_DIR = profileDir

/** Settings file the manager persists the mode into (§4). */
const settingsPath = path.join(profileDir, 'plugin-data', 'dsh-browser', 'settings.json')

/** The live manager handle is reached through a registered tool. */
let bootA = undefined

await check('boot(full): registers eight browser_* tools bound to one manager', async () => {
  const tools = createFakeTools()
  const systemPrompt = createFakeSystemPrompt()
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({
    services: new Map([
      ['tools', tools],
      ['systemPrompt', systemPrompt],
      ['webServer', webServer],
      ['connection', createFakeConnection()],
    ]),
  })

  indexModule.apply(ctx, {
    mode: 'auto',
    searchEngine: 'duckduckgo',
    hiddenIdleMs: 45000,
    promptSectionOrder: 118,
    outputDir: path.join(profileDir, 'shots'),
    maxActivity: 40,
    maxSessions: 8,
  })

  assert.deepEqual(tools.registered.map((tool) => tool.name), EXPECTED_TOOL_NAMES)
  for (const tool of tools.registered) {
    assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`)
    assert.ok(tool.description.length > 40, `${tool.name} description must state the visibility rule`)
    assert.ok(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name} needs a parameter map`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute()`)
  }

  const statusTool = tools.registered.find((tool) => tool.name === 'browser_status')
  const state = await statusTool.execute({}, {})
  assert.equal(state.mode, 'auto', 'fresh profile starts in auto mode')
  assert.equal(typeof state.engine.available, 'boolean', 'engine availability must be reported')
  if (state.engine.available) assert.equal(typeof state.engine.name, 'string')
  assert.deepEqual(state.sessions, [], 'no session exists before the first call')
  assert.equal(Object.hasOwn(state, 'activity'), false, 'browser_status omits the activity feed (§7)')

  bootA = { ctx, tools, systemPrompt, webServer }
})

await check('boot(full): registers the dsh-browser:usage prompt section with the live mode', () => {
  const sections = bootA.systemPrompt.sections
  assert.equal(sections.length, 1, 'exactly one usage section')
  const section = sections[0]
  assert.equal(section.name, 'dsh-browser:usage')
  assert.equal(section.order, 118)
  assert.equal(typeof section.text, 'function', 'the text must be dynamic so it follows the mode')
  const text = section.text()
  assert.match(text, /mode=auto/)
  assert.match(text, /untrusted/i)
  assert.match(text, /browser_search/)
})

await check('boot(full): registers five exact panel routes inside ctx.effect', () => {
  const routes = bootA.webServer.routes
  assert.deepEqual(routes.map((route) => route.path), EXPECTED_ROUTES)
  for (const route of routes) {
    assert.equal(route.kind, 'exact', `${route.path} must be an exact route`)
    assert.equal(typeof route.handler, 'function')
  }
  const labels = bootA.ctx.effects.map((frame) => frame.label)
  assert.ok(labels.includes('dsh-browser: dispose browser engine'), 'the manager dispose effect must be registered')
  for (const routePath of EXPECTED_ROUTES) {
    assert.ok(labels.includes(`dsh-browser: ${routePath}`), `route ${routePath} must be scoped to a plugin effect`)
  }
  assert.equal(bootA.ctx.effects.length, 6, 'one dispose effect + five route effects')
})

await check('boot(full): GET /state answers the panel contract', async () => {
  const route = bootA.webServer.routes.find((entry) => entry.path === '/plugins/dsh-browser/state')
  const response = await dispatch(route, { method: 'GET', url: '/plugins/dsh-browser/state' })
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.json.mode, 'auto')
  assert.ok(Array.isArray(response.json.activity), 'the panel needs the activity feed')
  assert.ok(Array.isArray(response.json.sessions))

  const wrongMethod = await dispatch(route, { method: 'POST', url: '/plugins/dsh-browser/state' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')
})

await check('boot(full): POST /mode persists into <profileDir>/plugin-data/dsh-browser/settings.json', async () => {
  const route = bootA.webServer.routes.find((entry) => entry.path === '/plugins/dsh-browser/mode')
  const response = await dispatch(route, {
    method: 'POST',
    url: '/plugins/dsh-browser/mode',
    headers: { 'content-length': String(Buffer.byteLength('{"mode":"visible"}')) },
    body: '{"mode":"visible"}',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { mode: 'visible' })
  assert.equal(fs.existsSync(settingsPath), true, `settings file must be written at ${settingsPath}`)
  assert.deepEqual(readJson(settingsPath), { mode: 'visible' }, 'mode persists atomically as JSON')

  const invalid = await dispatch(route, {
    method: 'POST',
    url: '/plugins/dsh-browser/mode',
    body: '{"mode":"sometimes"}',
  })
  assert.equal(invalid.status, 400)

  const promptText = bootA.systemPrompt.sections[0].text()
  assert.match(promptText, /mode=visible/, 'the prompt section must follow the persisted mode')

  const back = await dispatch(route, {
    method: 'POST',
    url: '/plugins/dsh-browser/mode',
    body: '{"mode":"auto"}',
  })
  assert.equal(back.status, 200)
  assert.match(bootA.systemPrompt.sections[0].text(), /mode=auto/)
})

await check('boot(full): POST /close, /clear and screenshot 404 follow the contract', async () => {
  const close = bootA.webServer.routes.find((entry) => entry.path === '/plugins/dsh-browser/close')
  const noArgs = await dispatch(close, { method: 'POST', url: '/plugins/dsh-browser/close', body: '{}' })
  assert.equal(noArgs.status, 400, 'close requires sessionId or all')
  const allClosed = await dispatch(close, { method: 'POST', url: '/plugins/dsh-browser/close', body: '{"all":true}' })
  assert.equal(allClosed.status, 200)
  assert.equal(typeof allClosed.json.closed, 'number')

  const clear = bootA.webServer.routes.find((entry) => entry.path === '/plugins/dsh-browser/clear')
  const cleared = await dispatch(clear, { method: 'POST', url: '/plugins/dsh-browser/clear' })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.json, { ok: true })

  const screenshot = bootA.webServer.routes.find((entry) => entry.path === '/plugins/dsh-browser/screenshot')
  const missing = await dispatch(screenshot, { method: 'GET', url: '/plugins/dsh-browser/screenshot?sessionId=nope' })
  assert.equal(missing.status, 404)
})

await check('boot(full): dispose runs every effect without leaking a browser', async () => {
  let rejected = 0
  for (const frame of [...bootA.ctx.effects].reverse()) {
    if (typeof frame.disposer !== 'function') continue
    try {
      await frame.disposer()
    } catch {
      rejected += 1
    }
  }
  assert.equal(rejected, 0, 'no effect disposer may throw')
  bootA.ctx.effects.length = 0
  // No browser was ever launched, so disposal has nothing left to kill; the
  // assertion that matters is that the engine call resolved and the plugin can
  // be unloaded while the process keeps running.
  assert.equal(fs.existsSync(settingsPath), true)
})

// ---------------------------------------------------------------------------
// Boot B — headless host without a Web server: lazy routes
// ---------------------------------------------------------------------------

await check('boot(headless): no Web server means no routes and no failure; routes bind on internal/service', async () => {
  const tools = createFakeTools()
  const systemPrompt = createFakeSystemPrompt()
  const ctx = createFakeCtx({
    services: new Map([
      ['tools', tools],
      ['systemPrompt', systemPrompt],
      ['connection', createFakeConnection()],
    ]),
  })

  indexModule.apply(ctx, {})
  assert.deepEqual(tools.registered.map((tool) => tool.name), EXPECTED_TOOL_NAMES, 'tools must work without a Web server')
  assert.equal(systemPrompt.sections.length, 1)
  assert.equal(ctx.effects.length, 1, 'only the dispose effect is registered before the server binds')

  const webServer = createFakeWebServer()
  ctx.provide('webServer', webServer)
  ctx.emit('internal/service', 'webServer')
  assert.deepEqual(webServer.routes.map((route) => route.path), EXPECTED_ROUTES, 'routes must bind when the server appears')

  ctx.emit('internal/service', 'httpServer')
  assert.equal(webServer.routes.length, EXPECTED_ROUTES.length, 'a second binding event must not duplicate routes')

  await ctx.dispose()
})

// ---------------------------------------------------------------------------
// Boot C — minimal host: no tools/systemPrompt/inject
// ---------------------------------------------------------------------------

await check('boot(minimal): applying without tools/systemPrompt/webServer is silent, not fatal', async () => {
  const services = new Map()
  const ctx = createFakeCtx({ services, inject: false })
  assert.doesNotThrow(() => indexModule.apply(ctx, {}), 'a headless composition must still mount')
  assert.equal(ctx.effects.length, 1, 'only the manager dispose effect')
  assert.deepEqual(ctx.injected, [], 'without an injection seam nothing is deferred')
  await ctx.dispose()
})

await check('boot(deferred): the prompt section binds when systemPrompt appears later', async () => {
  const tools = createFakeTools()
  const ctx = createFakeCtx({ services: new Map([['tools', tools]]) })
  indexModule.apply(ctx, {})

  assert.deepEqual(tools.registered.map((tool) => tool.name), EXPECTED_TOOL_NAMES, 'tools are ready immediately (declared inject)')
  assert.deepEqual(ctx.injected.map((entry) => entry.dependencies), [['systemPrompt']], 'only the optional prompt service is deferred')

  const systemPrompt = createFakeSystemPrompt()
  const lateCtx = createFakeCtx({ services: new Map([['systemPrompt', systemPrompt]]) })
  for (const entry of ctx.injected) entry.callback(lateCtx)
  assert.equal(systemPrompt.sections.length, 1, 'the prompt section registers when the service binds later')
  assert.equal(systemPrompt.sections[0].name, 'dsh-browser:usage')

  await ctx.dispose()
  await lateCtx.dispose()
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

for (const dir of temporaryDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

for (const [key, value] of Object.entries(savedEnvironment)) restoreEnvironment(key, value)

const passed = checks.filter((entry) => entry.ok).length
console.log('')
console.log(`dsh-browser verify-install: ${passed}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error('failed checks:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
}
