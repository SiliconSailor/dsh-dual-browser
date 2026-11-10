/**
 * dsh-browser / scripts / test-manager.mjs
 *
 * Real-browser smoke tests for lib/server/manager.js. Uses a real headless or
 * headed Edge/Chrome process (detected through the manager's own engine probe)
 * and plain `node:test`; no network mocks and no test framework dependency.
 *
 * Run from the workspace root:
 *   node --test dsh-browser/scripts/test-manager.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createBrowserManager, internals } from '../lib/server/manager.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EXAMPLE_URL = 'https://example.com'

/** Unique temporary directory; never shared between managers/tests. */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Build a manager rooted in an isolated profile and output directory. */
function makeManager(prefix, config = {}) {
  const root = tempDir(prefix)
  return createBrowserManager({
    config: { hiddenIdleMs: 60000, ...config },
    profileDir: path.join(root, 'profile'),
    outputDir: path.join(root, 'output'),
  })
}

/**
 * Edge/Chrome processes that descend from this test process. Playwright spawns
 * the browser directly, so after disposal this set must be empty. Processes
 * belonging to the user's own browser are not descendants and are ignored.
 */
function browserDescendants() {
  const script = "$ErrorActionPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress"
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const parsed = raw.trim() === '' ? [] : JSON.parse(raw)
  const processes = Array.isArray(parsed) ? parsed : [parsed]
  const children = new Map()
  for (const entry of processes) {
    const parent = entry.ParentProcessId
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(entry)
  }
  const found = []
  const queue = [process.pid]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of children.get(parent) ?? []) {
      queue.push(child.ProcessId)
      if (/^(msedge|chrome)\.exe$/i.test(child.Name)) found.push(child)
    }
  }
  return found
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 250) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`condition was not met within ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Network failures are the only permitted skip reason in this suite. */
function isNetworkFailure(error) {
  return /net::ERR|ERR_INTERNET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|NS_ERROR|Timeout .* exceeded/i.test(String(error?.message ?? error))
}

test('manager exposes the contract API and detects a real browser engine', async () => {
  const manager = makeManager('dsh-b-manager-api-')
  try {
    for (const name of [
      'getState', 'getMode', 'setMode', 'search', 'open', 'read', 'click',
      'type', 'screenshot', 'close', 'getScreenshot', 'dispose',
    ]) {
      assert.equal(typeof manager[name], 'function', `${name} must be a function`)
    }
    assert.equal(manager.getMode(), 'auto')
    const state = manager.getState()
    assert.equal(state.mode, 'auto')
    assert.equal(state.engine.available, true, `browser engine must be available: ${JSON.stringify(state.engine)}`)
    assert.match(state.engine.name, /Microsoft Edge|Google Chrome/)
    assert.ok(fs.existsSync(state.engine.path), 'engine path must exist')
    assert.deepEqual(state.sessions, [])
    assert.ok(Array.isArray(state.activity))
    assert.equal(typeof state.updatedAt, 'number')
  } finally {
    await manager.dispose()
  }
})

test('mode persists atomically in <profileDir>/plugin-data/dsh-browser/settings.json', async () => {
  const root = tempDir('dsh-b-mode-')
  const profileDir = path.join(root, 'profile')
  const settingsPath = path.join(profileDir, 'plugin-data', 'dsh-browser', 'settings.json')
  const config = { mode: 'auto', hiddenIdleMs: 60000 }
  const first = createBrowserManager({ config, profileDir, outputDir: path.join(root, 'output') })
  try {
    assert.equal(first.getMode(), 'auto')
    assert.equal(first.setMode('visible'), 'visible')
    assert.equal(first.getMode(), 'visible')
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).mode, 'visible')
    assert.deepEqual(first.resolveVisibility(false), { visible: true, forced: true })
    assert.deepEqual(first.resolveVisibility(true), { visible: true, forced: false })
    assert.throws(() => first.setMode('nonsense'), /invalid browser mode/)
  } finally {
    await first.dispose()
  }

  // A new manager for the same profile must see the persisted mode, not config.mode.
  const second = createBrowserManager({ config: { ...config, mode: 'auto' }, profileDir, outputDir: path.join(root, 'output') })
  try {
    assert.equal(second.getMode(), 'visible')
    assert.equal(second.setMode('auto'), 'auto')
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).mode, 'auto')
    assert.deepEqual(second.resolveVisibility(undefined), { visible: false, forced: false })
    assert.deepEqual(second.resolveVisibility(true), { visible: true, forced: false })
    // No temporary files may be left behind by atomic writes.
    const leftovers = fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await second.dispose()
  }

  // config.mode is the fallback for a fresh profile.
  const third = createBrowserManager({ config: { ...config, mode: 'visible' }, profileDir: path.join(root, 'fresh'), outputDir: path.join(root, 'output') })
  try {
    assert.equal(third.getMode(), 'visible')
  } finally {
    await third.dispose()
  }
})

test('hidden browser opens example.com, reads text, screenshots, and closes cleanly', async () => {
  const manager = makeManager('dsh-b-hidden-', { hiddenIdleMs: 60000 })
  try {
    const snapshot = await manager.open({ url: EXAMPLE_URL })
    assert.equal(snapshot.visible, false)
    assert.equal(snapshot.sessionId, 'hidden-1')
    assert.match(snapshot.url, /^https:\/\/example\.com\/?$/)
    assert.match(snapshot.title, /Example/i)
    assert.ok(snapshot.textPreview.length > 0, 'open must return a text preview')

    const state = manager.getState()
    assert.equal(state.sessions.length, 1)
    assert.equal(state.sessions[0].visible, false)
    assert.equal(state.sessions[0].status, 'ready')
    assert.equal(state.sessions[0].id, snapshot.sessionId)
    assert.equal(state.activity[0].kind, 'open')
    assert.equal(state.activity[0].visible, false)
    assert.ok(state.activity.some((entry) => entry.kind === 'launch'))

    const read = await manager.read({ maxChars: 8000 })
    assert.equal(read.sessionId, snapshot.sessionId)
    assert.match(read.url, /^https:\/\/example\.com\/?$/)
    assert.match(read.title, /Example/i)
    assert.ok(read.text.length > 0, 'read must return page text')
    // example.com currently serves localized documentation text; the H1
    // "Example Domain" lives in <title>, so accept either casing of "domain".
    assert.match(read.text, /domain/i)
    assert.equal(read.truncated, false)

    const clipped = await manager.read({ maxChars: 20 })
    assert.equal(clipped.text.length, 20)
    assert.equal(clipped.truncated, true)

    const withLinks = await manager.read({ maxChars: 8000, includeLinks: true })
    assert.ok(Array.isArray(withLinks.links), 'includeLinks must return an array')
    assert.ok(withLinks.links.length <= 50)
    for (const link of withLinks.links) assert.match(link, /^https?:\/\//)

    const shot = await manager.screenshot({ sessionId: snapshot.sessionId, label: 'smoke' })
    assert.ok(path.isAbsolute(shot.path), 'screenshot path must be absolute')
    assert.match(shot.path, /screenshots[\\/]/)
    assert.equal(shot.sessionId, snapshot.sessionId)
    assert.ok(fs.existsSync(shot.path), 'screenshot file must exist')
    const bytes = fs.readFileSync(shot.path)
    assert.ok(bytes.length > 100)
    assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE)
    const stored = manager.getScreenshot(snapshot.sessionId)
    assert.equal(stored.contentType, 'image/png')
    assert.equal(stored.bytes.length, bytes.length)

    const kinds = manager.getState().activity.map((entry) => entry.kind)
    for (const kind of ['launch', 'open', 'read', 'screenshot']) assert.ok(kinds.includes(kind), `activity must include ${kind}`)

    const closed = await manager.close({ sessionId: snapshot.sessionId })
    assert.equal(closed.closed, 1)
    assert.deepEqual(manager.getState().sessions, [])

    // The close row is labelled by the closed session, never by the kind verb.
    const closeEntry = manager.getState().activity.find((entry) => entry.kind === 'close')
    assert.ok(closeEntry, 'activity must include the close record')
    assert.notEqual(closeEntry.title, 'Закрытие')
    assert.equal(closeEntry.title, snapshot.title)
    assert.equal(closeEntry.detail, `Закрыт сеанс ${snapshot.sessionId}`)

    // No-op closes carry no title: detail alone explains what happened.
    assert.deepEqual(await manager.close({}), { closed: 0 })
    const idleClose = manager.getState().activity.find((entry) => entry.kind === 'close')
    assert.equal(idleClose.title, '')
    assert.equal(idleClose.detail, 'Нет открытых сеансов')

    assert.deepEqual(await manager.close({ sessionId: 'missing-1' }), { closed: 0 })
    const missingClose = manager.getState().activity.find((entry) => entry.kind === 'close')
    assert.equal(missingClose.title, '')
    assert.match(missingClose.detail, /уже закрыт/)
    await waitFor(() => browserDescendants().length === 0, 10000)
  } finally {
    await manager.dispose()
  }
})

test('hidden browser auto-closes after hiddenIdleMs of inactivity', async () => {
  const manager = makeManager('dsh-b-idle-', { hiddenIdleMs: 1500 })
  try {
    await manager.open({ url: EXAMPLE_URL })
    assert.equal(manager.getState().sessions.length, 1)
    const closed = await waitFor(() => {
      const state = manager.getState()
      return state.sessions.length === 0 && state.activity.some((entry) => entry.kind === 'auto-close')
    }, 12000)
    assert.equal(closed, true)
    const autoClose = manager.getState().activity.find((entry) => entry.kind === 'auto-close')
    assert.equal(autoClose.visible, false)
    await waitFor(() => browserDescendants().length === 0, 10000)
  } finally {
    await manager.dispose()
  }
})

test('search works through DuckDuckGo HTML and Bing and normalizes results', async (t) => {
  const synthetic = internals.normalizeSearchRows([
    { title: 'A', url: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x', snippet: 'a' },
    { title: 'A duplicate', url: 'https://example.com/a', snippet: 'dup' },
    { title: 'Mail', url: 'mailto:someone@example.com', snippet: '' },
    { title: 'B', url: '/relative', snippet: 'b' },
    { title: 'C', url: 'https://example.org/c', snippet: 'c' },
    { title: 'D', url: 'https://example.net/d', snippet: 'd' },
  ], 3)
  assert.deepEqual(synthetic.map((row) => row.url), ['https://example.com/a', 'https://example.org/c', 'https://example.net/d'])
  assert.equal(internals.resolveDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F'), 'https://example.com/')

  for (const engine of ['duckduckgo', 'bing']) {
    await t.test(`${engine} search`, async (t) => {
      const manager = makeManager(`dsh-b-${engine}-`, { searchEngine: engine })
      try {
        let result
        try {
          result = await manager.search({ query: '  DeepSeek Harness  ', maxResults: 4 })
        } catch (error) {
          if (isNetworkFailure(error)) {
            t.skip(`reason=network (${error.message})`)
            return
          }
          throw error
        }
        assert.equal(result.query, 'DeepSeek Harness')
        assert.equal(result.visible, false)
        assert.ok(result.results.length > 0, `${engine} must return at least one result`)
        assert.ok(result.results.length <= 4, 'maxResults must cap the list')
        assert.equal(new Set(result.results.map((row) => row.url)).size, result.results.length, 'results must be deduped')
        for (const row of result.results) {
          assert.equal(typeof row.title, 'string')
          assert.ok(row.title.length > 0)
          assert.match(row.url, /^https?:\/\//)
          assert.doesNotMatch(row.url, /duckduckgo\.com\/l\//, 'DDG redirects must be resolved')
          assert.equal(typeof row.snippet, 'string')
        }
        assert.equal(typeof result.truncated, 'boolean')

        // The search row is labelled by the (trimmed) query itself; the kind
        // column already carries the verb, so no "Поиск:" prefix may remain.
        const searchEntry = manager.getState().activity.find((entry) => entry.kind === 'search')
        assert.ok(searchEntry, 'activity must include the search record')
        assert.equal(searchEntry.title, 'DeepSeek Harness')
        assert.doesNotMatch(searchEntry.title, /^Поиск/)
        assert.equal(searchEntry.detail, `${engine === 'bing' ? 'Bing' : 'DuckDuckGo'}: найдено ${result.results.length}`)

        assert.ok(manager.getState().sessions.some((session) => session.visible === false))
        await manager.close({ all: true })
        assert.deepEqual(manager.getState().sessions, [])
        const closeEntry = manager.getState().activity.find((entry) => entry.kind === 'close')
        assert.ok(closeEntry, 'activity must include the close record')
        assert.notEqual(closeEntry.title, 'Закрытие')
        assert.equal(closeEntry.title, '')
      } finally {
        await manager.dispose()
      }
    })
  }

  if (internals.normalizeSearchRows([{ title: 'x', url: 'https://example.com/x', snippet: '' }], 1).length !== 1) {
    assert.fail('positive control for search normalization failed')
  }
})

test('visible browser opens headed, survives idling, and dispose leaves no processes', async () => {
  const manager = makeManager('dsh-b-visible-', { hiddenIdleMs: 500 })
  try {
    const snapshot = await manager.open({ url: `${EXAMPLE_URL}/?visible=1`, visible: true })
    assert.equal(snapshot.visible, true)
    assert.equal(manager.getState().sessions[0].visible, true)

    // A visible browser must never be auto-closed by the hidden idle timer.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(manager.getState().sessions.length, 1, 'visible sessions must stay open when idle')
    assert.equal(browserDescendants().length > 0, true, 'a headed browser process should be running')

    // In visible mode, visible=false is ignored and forced visible.
    manager.setMode('visible')
    assert.deepEqual(manager.resolveVisibility(false), { visible: true, forced: true })
    const forced = await manager.open({ url: `${EXAMPLE_URL}/?forced=1`, visible: false })
    assert.equal(forced.visible, true)
    const forcedSession = manager.getState().sessions.find((session) => session.id === forced.sessionId)
    assert.equal(forcedSession.visible, true)

    const closed = await manager.close({ all: true })
    assert.ok(closed.closed >= 2)
    assert.deepEqual(manager.getState().sessions, [])
  } finally {
    await manager.dispose()
  }
  await waitFor(() => browserDescendants().length === 0, 15000)
})

test('dispose is idempotent and makes the manager unusable', async () => {
  const manager = makeManager('dsh-b-dispose-')
  await manager.dispose()
  await manager.dispose()
  assert.deepEqual(manager.getState().sessions, [])
  await assert.rejects(() => manager.open({ url: EXAMPLE_URL }), /disposed/)
})
