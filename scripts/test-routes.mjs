/**
 * dsh-browser / scripts / test-routes.mjs
 *
 * Route + tool registration tests. Uses a fake `ctx`, a fake manager and a real
 * `http.createServer` that dispatches the registered exact routes; no DSH host
 * is booted and no browser is launched. Tool registration is imported through a
 * module-resolution hook that maps @deepseek-ai/dsh-tools to a tiny stub, so the
 * suite also runs on a bare checkout.
 *
 * Run from the workspace root:
 *   node --test dsh-browser/scripts/test-routes.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerBrowserRoutes } from '../lib/server/routes.js'
import { registerBrowserPrompt, browserPromptText } from '../lib/server/prompt.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

/** Fake manager with the subset used by routes. */
function createFakeManager() {
  const calls = { setMode: [], close: [], screenshot: [], clear: 0 }
  let mode = 'auto'
  let activity = [{ id: 'activity-1', at: Date.now(), kind: 'open', visible: false, title: 'Example', detail: 'test', status: 'ok' }]
  let screenshot
  return {
    calls,
    getMode: () => mode,
    setMode(next) {
      if (next !== 'auto' && next !== 'visible') throw new Error(`invalid browser mode: ${next}`)
      calls.setMode.push(next)
      mode = next
      return mode
    },
    getState() {
      return {
        mode,
        engine: { available: true, name: 'Microsoft Edge', path: 'C:\\Edge\\msedge.exe' },
        sessions: [],
        activity: activity.slice(),
        updatedAt: Date.now(),
      }
    },
    async close(args) {
      calls.close.push(args)
      return { closed: args.all === true ? 2 : 1 }
    },
    clearActivity() {
      calls.clear += 1
      activity = []
    },
    getScreenshot(sessionId) {
      calls.screenshot.push(sessionId)
      return screenshot
    },
    setScreenshot(value) {
      screenshot = value
    },
  }
}

/** Fake Connection gate: rejects via x-deny header. */
function createConnection() {
  return {
    requestRejection(req) {
      const deny = req.headers['x-deny']
      if (deny === '401') return 401
      if (deny === '403') return 403
      return undefined
    },
  }
}

/** Fake exact-route registry matching the host WebServer contract. */
function createFakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** Fake plugin context with get/effect/on/logger. */
function createFakeCtx(services = {}) {
  const registry = new Map(Object.entries(services))
  const listeners = new Map()
  const effects = []
  return {
    effects,
    services: registry,
    get(name) {
      return registry.get(name)
    },
    setService(name, value) {
      registry.set(name, value)
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return disposer
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
}

/** Serve the fake route table over real HTTP; unmatched paths answer 404. */
async function startFakeHost(routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = routes.get(url.pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    try {
      await route.handler(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Register routes against a context whose Web server is already (or not yet) bound. */
async function setupRoutes({ withWebServer = true, withConnection = true } = {}) {
  const manager = createFakeManager()
  const webServer = createFakeWebServer()
  const services = {}
  if (withWebServer) services.webServer = webServer
  if (withConnection) services.connection = createConnection()
  const ctx = createFakeCtx(services)
  registerBrowserRoutes(ctx, manager, { promptSectionOrder: 118 })
  if (!withWebServer) {
    ctx.setService('webServer', webServer)
    ctx.emit('internal/service', 'webServer')
  }
  const host = await startFakeHost(webServer.routes)
  return { ctx, manager, webServer, host }
}

test('routes register lazily and GET state answers JSON with no-store', async () => {
  const manager = createFakeManager()
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({ connection: createConnection() })
  registerBrowserRoutes(ctx, manager, {})
  assert.equal(webServer.routes.size, 0, 'no routes before the Web server exists')

  ctx.setService('webServer', webServer)
  ctx.emit('internal/service', 'webServer')
  assert.deepEqual(
    [...webServer.routes.keys()].sort(),
    [
      '/plugins/dsh-browser/clear',
      '/plugins/dsh-browser/close',
      '/plugins/dsh-browser/mode',
      '/plugins/dsh-browser/screenshot',
      '/plugins/dsh-browser/state',
    ],
  )
  // Duplicate service events must not attempt a second registration.
  ctx.emit('internal/service', 'webServer')
  assert.equal(webServer.routes.size, 5)

  const host = await startFakeHost(webServer.routes)
  try {
    const response = await fetch(`${host.base}/plugins/dsh-browser/state`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type'), /application\/json/)
    const body = await response.json()
    assert.equal(body.mode, 'auto')
    assert.equal(body.engine.available, true)
    assert.ok(Array.isArray(body.sessions))

    const wrongMethod = await fetch(`${host.base}/plugins/dsh-browser/state`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET')
    assert.equal(wrongMethod.headers.get('cache-control'), 'no-store')
  } finally {
    await host.close()
  }
})

test('POST mode validates and persists the mode', async () => {
  const { host, manager } = await setupRoutes()
  try {
    const ok = await fetch(`${host.base}/plugins/dsh-browser/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'visible' }),
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await ok.json(), { mode: 'visible' })
    assert.equal(manager.getMode(), 'visible')
    assert.deepEqual(manager.calls.setMode, ['visible'])

    const invalid = await fetch(`${host.base}/plugins/dsh-browser/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sometimes' }),
    })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error, /mode/)

    const malformed = await fetch(`${host.base}/plugins/dsh-browser/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(malformed.status, 400)

    const tooLarge = await fetch(`${host.base}/plugins/dsh-browser/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto', padding: 'x'.repeat(70 * 1024) }),
    })
    assert.equal(tooLarge.status, 413)
    assert.equal(tooLarge.headers.get('cache-control'), 'no-store')

    const wrongMethod = await fetch(`${host.base}/plugins/dsh-browser/mode`)
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'POST')
  } finally {
    await host.close()
  }
})

test('POST close validates arguments and closes sessions', async () => {
  const { host, manager } = await setupRoutes()
  try {
    const missing = await fetch(`${host.base}/plugins/dsh-browser/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /sessionId or all/)

    const all = await fetch(`${host.base}/plugins/dsh-browser/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    assert.equal(all.status, 200)
    assert.deepEqual(await all.json(), { closed: 2 })
    assert.deepEqual(manager.calls.close.at(-1), { sessionId: undefined, all: true })

    const one = await fetch(`${host.base}/plugins/dsh-browser/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'hidden-1' }),
    })
    assert.equal(one.status, 200)
    assert.deepEqual(await one.json(), { closed: 1 })
    assert.deepEqual(manager.calls.close.at(-1), { sessionId: 'hidden-1', all: false })

    const wrongMethod = await fetch(`${host.base}/plugins/dsh-browser/close`)
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'POST')
  } finally {
    await host.close()
  }
})

test('POST clear empties the activity feed', async () => {
  const { host, manager } = await setupRoutes()
  try {
    const response = await fetch(`${host.base}/plugins/dsh-browser/clear`, { method: 'POST' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(manager.calls.clear, 1)
    assert.deepEqual(manager.getState().activity, [])
  } finally {
    await host.close()
  }
})

test('screenshot route serves PNG or 404 and rejects wrong methods', async () => {
  const { host, manager } = await setupRoutes()
  try {
    const missing = await fetch(`${host.base}/plugins/dsh-browser/screenshot?sessionId=hidden-1`)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.deepEqual(manager.calls.screenshot.at(-1), 'hidden-1')

    manager.setScreenshot({ bytes: PNG, contentType: 'image/png' })
    const response = await fetch(`${host.base}/plugins/dsh-browser/screenshot?sessionId=hidden-1`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(body, PNG)

    const wrongMethod = await fetch(`${host.base}/plugins/dsh-browser/screenshot`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET')
  } finally {
    await host.close()
  }
})

test('connection gate answers 503 without a connection service and 401/403 when denied', async () => {
  const manager = createFakeManager()
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({ webServer })
  registerBrowserRoutes(ctx, manager, {})
  const host = await startFakeHost(webServer.routes)
  try {
    const unavailable = await fetch(`${host.base}/plugins/dsh-browser/state`)
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.headers.get('cache-control'), 'no-store')

    ctx.setService('connection', createConnection())
    const unauthorized = await fetch(`${host.base}/plugins/dsh-browser/state`, { headers: { 'x-deny': '401' } })
    assert.equal(unauthorized.status, 401)
    const forbidden = await fetch(`${host.base}/plugins/dsh-browser/state`, { headers: { 'x-deny': '403' } })
    assert.equal(forbidden.status, 403)
    const ok = await fetch(`${host.base}/plugins/dsh-browser/state`)
    assert.equal(ok.status, 200)
  } finally {
    await host.close()
  }
})

test('httpServer fallback and no-web-server assemblies stay harmless', async () => {
  const manager = createFakeManager()
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({ httpServer: webServer, connection: createConnection() })
  registerBrowserRoutes(ctx, manager, {})
  assert.equal(webServer.routes.size, 5)

  const headlessCtx = createFakeCtx({})
  assert.doesNotThrow(() => registerBrowserRoutes(headlessCtx, manager, {}))
})

// ---------------------------------------------------------------------------
// Tools + prompt registration (imported through a resolver stub for dsh-tools)
// ---------------------------------------------------------------------------

/**
 * Load lib/server/tools.js with @deepseek-ai/dsh-tools resolved to a tiny stub.
 * The stub keeps the authored definition object, which is enough to assert the
 * contract's fixed names/parameters/descriptions and to call execute().
 */
async function importToolsWithStub() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-b-tools-hook-'))
  const stubPath = path.join(dir, 'dsh-tools-stub.mjs')
  const hookPath = path.join(dir, 'resolve-hook.mjs')
  fs.writeFileSync(stubPath, [
    'export function defineTool(options) {',
    '  return { ...options }',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(hookPath, [
    "import { pathToFileURL } from 'node:url';",
    `const stub = pathToFileURL(${JSON.stringify(stubPath)}).href;`,
    'export async function resolve(specifier, context, next) {',
    "  if (specifier === '@deepseek-ai/dsh-tools') return { url: stub, shortCircuit: true };",
    '  return next(specifier, context);',
    '}',
    '',
  ].join('\n'))
  register(pathToFileURL(hookPath))
  return import(pathToFileURL(path.join(root, 'lib', 'server', 'tools.js')).href)
}

/** Fake manager for tool execution assertions. */
function createToolManager() {
  const calls = { search: [], open: [], read: [], click: [], type: [], screenshot: [], close: [], status: 0 }
  let mode = 'auto'
  return {
    calls,
    getMode: () => mode,
    setMode(next) { mode = next },
    getState() {
      calls.status += 1
      return {
        mode,
        engine: { available: true, name: 'Microsoft Edge', path: 'C:\\Edge\\msedge.exe' },
        sessions: [{ id: 'hidden-1', visible: false, url: 'https://example.com/', title: 'Example', status: 'ready', createdAt: 1, updatedAt: 2, lastAction: 'open' }],
        activity: [{ id: 'a', at: 1, kind: 'open', visible: false, title: 'Example', detail: 'x', status: 'ok' }],
        updatedAt: 3,
      }
    },
    async search(args) {
      calls.search.push(args)
      return { query: args.query, sessionId: 'hidden-1', visible: false, results: [{ title: 'Example', url: 'https://example.com/', snippet: 's' }], truncated: false }
    },
    async open(args) {
      calls.open.push(args)
      return { sessionId: 'hidden-1', visible: args.visible === true, url: 'https://example.com/', title: 'Example', textPreview: 'preview' }
    },
    async read(args) {
      calls.read.push(args)
      return { sessionId: 'hidden-1', url: 'https://example.com/', title: 'Example', text: 'hello page', truncated: false }
    },
    async click(args) {
      calls.click.push(args)
      return { sessionId: 'hidden-1', visible: false, url: 'https://example.com/', title: 'Example', textPreview: 'preview' }
    },
    async type(args) {
      calls.type.push(args)
      return { sessionId: 'hidden-1', visible: false, url: 'https://example.com/', title: 'Example', textPreview: 'preview' }
    },
    async screenshot(args) {
      calls.screenshot.push(args)
      return { path: 'C:\\tmp\\shot.png', url: 'https://example.com/', title: 'Example', sessionId: 'hidden-1' }
    },
    async close(args) {
      calls.close.push(args)
      return { closed: 1 }
    },
  }
}

test('tools register the exact fixed set with contract parameters', async () => {
  const { registerBrowserTools, BROWSER_TOOL_NAMES } = await importToolsWithStub()
  const ctx = { tools: { register(tool) { this.registered.push(tool) }, registered: [] } }
  const manager = createToolManager()
  registerBrowserTools(ctx, manager, {})
  const tools = ctx.tools.registered
  assert.deepEqual(tools.map((tool) => tool.name), [
    'browser_status', 'browser_search', 'browser_open', 'browser_read',
    'browser_click', 'browser_type', 'browser_screenshot', 'browser_close',
  ])
  assert.deepEqual(tools.map((tool) => tool.name), BROWSER_TOOL_NAMES)
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.equal(byName.browser_status.description, 'Show the browser mode (auto/visible), engine availability, and open browser sessions.')
  assert.equal(byName.browser_search.parameters.query.required, true)
  assert.equal(byName.browser_search.parameters.maxResults.type, 'integer')
  assert.equal(byName.browser_open.parameters.url.required, true)
  assert.deepEqual(byName.browser_open.parameters.waitUntil.enum, ['domcontentloaded', 'load', 'networkidle'])
  assert.equal(byName.browser_read.parameters.maxChars.type, 'integer')
  assert.equal(byName.browser_read.parameters.includeLinks.type, 'boolean')
  assert.equal(byName.browser_click.parameters.index.type, 'integer')
  assert.equal(byName.browser_type.parameters.selector.required, true)
  assert.equal(byName.browser_type.parameters.text.required, true)
  assert.equal(byName.browser_screenshot.parameters.fullPage.type, 'boolean')
  assert.equal(byName.browser_close.parameters.all.type, 'boolean')
  for (const name of ['browser_read', 'browser_click', 'browser_type', 'browser_screenshot']) {
    assert.match(byName[name].description, /visibility follows the global browser mode/i)
  }
})

test('tools implement the visibility rule and untrusted-content notice', async () => {
  const { registerBrowserTools, UNTRUSTED_NOTICE } = await importToolsWithStub()
  const ctx = { tools: { register(tool) { this.registered.push(tool) }, registered: [] } }
  const manager = createToolManager()
  registerBrowserTools(ctx, manager, {})
  const byName = Object.fromEntries(ctx.tools.registered.map((tool) => [tool.name, tool]))

  const status = await byName.browser_status.execute({}, { signal: undefined })
  assert.equal(status.mode, 'auto')
  assert.equal(status.activity, undefined, 'status output excludes the activity feed')
  assert.equal(manager.calls.status, 1)

  const search = await byName.browser_search.execute({ query: 'q', maxResults: 3 }, { signal: undefined })
  assert.equal(search.forcedVisible, false)
  assert.equal(search.visible, false)

  const openVisible = await byName.browser_open.execute({ url: 'example.com', visible: true }, { signal: undefined })
  assert.equal(openVisible.forcedVisible, false)
  assert.equal(manager.calls.open.at(-1).visible, true)

  manager.setMode('visible')
  const forcedSearch = await byName.browser_search.execute({ query: 'q', visible: false }, { signal: undefined })
  assert.equal(forcedSearch.forcedVisible, true)
  const forcedOpen = await byName.browser_open.execute({ url: 'example.com', visible: false }, { signal: undefined })
  assert.equal(forcedOpen.forcedVisible, true)
  const normalOpen = await byName.browser_open.execute({ url: 'example.com' }, { signal: undefined })
  assert.equal(normalOpen.forcedVisible, false)

  const read = await byName.browser_read.execute({ maxChars: 1000 }, { signal: undefined })
  assert.ok(read.text.startsWith(UNTRUSTED_NOTICE), 'page text must carry the untrusted notice')
  assert.match(read.text, /hello page/)
  assert.equal(Object.hasOwn(read, 'links'), false)

  await assert.rejects(() => byName.browser_click.execute({}, { signal: undefined }), /exactly one of selector or text/)
  await assert.rejects(
    () => byName.browser_click.execute({ selector: 'a', text: 'b' }, { signal: undefined }),
    /exactly one of selector or text/,
  )
  const clicked = await byName.browser_click.execute({ selector: 'a' }, { signal: undefined })
  assert.equal(clicked.sessionId, 'hidden-1')
  assert.equal(Object.hasOwn(clicked, 'forcedVisible'), false)

  await byName.browser_type.execute({ selector: 'input', text: 'hi' }, { signal: undefined })
  assert.equal(manager.calls.type.at(-1).clear, true, 'tool default clear=true')
  assert.equal(manager.calls.type.at(-1).submit, undefined)

  const shot = await byName.browser_screenshot.execute({ label: 'x' }, { signal: undefined })
  assert.equal(shot.path, 'C:\\tmp\\shot.png')

  const closed = await byName.browser_close.execute({ all: true }, { signal: undefined })
  assert.deepEqual(closed, { closed: 1 })
  assert.deepEqual(manager.calls.close.at(-1), { sessionId: undefined, all: true })

  const rendered = byName.browser_search.output.render({}, search)
  assert.equal(Array.isArray(rendered), true)
  assert.equal(rendered[0].type, 'text')
})

test('prompt section uses promptSectionOrder and the current mode', () => {
  const manager = createToolManager()
  const sections = []
  const ctx = { systemPrompt: { section(section) { sections.push(section) } } }
  registerBrowserPrompt(ctx, manager, { promptSectionOrder: 77 })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-browser:usage')
  assert.equal(sections[0].order, 77)
  const autoText = sections[0].text({ scope: {}, toolSet: [] })
  assert.match(autoText, /dsh-browser/)
  assert.match(autoText, /mode=auto/)
  manager.setMode('visible')
  const visibleText = sections[0].text({ scope: {}, toolSet: [] })
  assert.match(visibleText, /mode=visible/)
  assert.match(browserPromptText('visible'), /mode=visible/)
  assert.match(browserPromptText('auto'), /mode=auto/)

  assert.doesNotThrow(() => registerBrowserPrompt({}, manager, {}))
})
