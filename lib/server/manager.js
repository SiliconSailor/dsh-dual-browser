/**
 * dsh-browser / server / manager
 *
 * Playwright driver, browser-session state and mode persistence for the
 * dsh-browser plugin. This module is intentionally standalone: it imports only
 * Node builtins and `playwright-core`, so it can be exercised with plain Node
 * (`node --test dsh-browser/scripts/test-manager.mjs`) without booting DSH.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'

/** Valid browser modes. */
const MODES = new Set(['auto', 'visible'])
/** Hard cap for page text returned by `read`. */
const MAX_TEXT_CHARS = 40000
/** Number of screenshot buffers kept in memory. */
const MAX_SCREENSHOT_BUFFERS = 4
/** Navigation / action budget for one Playwright call. */
const ACTION_TIMEOUT_MS = 30000
/** Search engines and their result-page URLs. */
const SEARCH_URLS = {
  duckduckgo: 'https://html.duckduckgo.com/html/?q=',
  bing: 'https://www.bing.com/search?q=',
}
/** Wait-until values accepted from tools/routes. */
const WAIT_UNTIL = new Set(['domcontentloaded', 'load', 'networkidle'])
/** Realistic desktop UA; headless Chromium's own UA trips DDG/Bing bot checks. */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0'
/** Browser launch arguments shared by both visibility classes. */
const BASE_LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=TranslateUI',
]

/** Defaults mirroring the host config declared in the contract. */
const DEFAULT_CONFIG = {
  mode: 'auto',
  searchEngine: 'duckduckgo',
  hiddenIdleMs: 45000,
  promptSectionOrder: 118,
  executablePath: undefined,
  outputDir: '.dsh-browser',
  maxActivity: 40,
  maxSessions: 8,
}

/** Format an error for logs/activity without assuming an Error instance. */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Clamp an integer option into [min, max], falling back to `fallback`. */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** Is this an HTTP(S) URL object? */
function isHttpUrl(url) {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/** Turn a bare host/path into an https URL and reject non-http(s) schemes. */
function normalizeUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') throw new Error('url is required')
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`invalid url: ${raw}`)
  }
  if (!isHttpUrl(parsed)) throw new Error(`unsupported url scheme: ${parsed.protocol} (only http/https are supported)`)
  return parsed.href
}

/** Resolve a DuckDuckGo HTML redirect (`//duckduckgo.com/l/?uddg=...`). */
function resolveDdgRedirect(href) {
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const url = new URL(absolute, 'https://duckduckgo.com')
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg')
      if (target) return target
    }
    return absolute
  } catch {
    return href
  }
}

/** Resolve a Bing click-tracking redirect (`/ck/a?...&u=a1<base64url>`). */
function resolveBingRedirect(href) {
  try {
    const url = new URL(href)
    if (!/(^|\.)bing\.com$/i.test(url.hostname)) return href
    const target = url.searchParams.get('u')
    if (target === null || !target.startsWith('a1')) return href
    const base64 = target.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

/** Normalize raw search rows: redirects, http(s) only, dedupe, cap. */
function normalizeSearchRows(rows, maxResults) {
  const results = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object' || typeof row.url !== 'string') continue
    const href = resolveBingRedirect(resolveDdgRedirect(row.url.trim()))
    if (href === '') continue
    let parsed
    try {
      parsed = new URL(href)
    } catch {
      continue
    }
    if (!isHttpUrl(parsed)) continue
    const url = parsed.href
    if (seen.has(url)) continue
    seen.add(url)
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : ''
    results.push({ title: title || url, url, snippet })
    if (results.length >= maxResults) break
  }
  return results
}

/** File-name slug for screenshots; ASCII-only and bounded. */
function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'page'
}

/** ISO-ish timestamp safe for Windows file names. */
function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Detect the browser executable in the contract's order. */
function detectEngine(config) {
  const candidates = []
  const push = (entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') return
    if (!candidates.includes(entry)) candidates.push(entry)
  }
  push(config.executablePath)
  push(process.env.DSH_BROWSER_PATH)
  push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
  push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        const base = path.basename(candidate).toLowerCase()
        const name = base.includes('msedge') ? 'Microsoft Edge' : base.includes('chrome') ? 'Google Chrome' : path.basename(candidate)
        return { available: true, name, path: candidate }
      }
    } catch {
      // keep probing
    }
  }
  return { available: false, name: 'none' }
}

/**
 * Page-side text extraction. Serialized by Playwright, so it must be
 * self-contained. `limit` bounds the returned text (caller asks for cap + 1 to
 * detect truncation); `includeLinks` also returns deduped absolute http(s).
 */
function extractPageText({ limit, includeLinks }) {
  const root = document.querySelector('article, main, [role="main"]') || document.body
  if (!root) return { text: '', title: document.title, url: location.href, links: [] }

  const clone = root.cloneNode(true)
  clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form,button,input,select,textarea,[aria-hidden="true"]').forEach((node) => node.remove())

  const blockTags = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ])

  let out = ''
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue || ''
      return
    }
    if (node.nodeType !== 1) return
    const block = blockTags.has(node.tagName)
    if (block) out += '\n'
    for (const child of node.childNodes) walk(child)
    if (block) out += '\n'
  }
  walk(clone)

  const normalized = out
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const links = []
  if (includeLinks) {
    const seen = new Set()
    for (const anchor of clone.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href')
      if (!href) continue
      let absolute
      try {
        absolute = new URL(href, document.baseURI).href
      } catch {
        continue
      }
      if (!/^https?:/i.test(absolute) || seen.has(absolute)) continue
      seen.add(absolute)
      links.push(absolute)
      if (links.length >= 50) break
    }
  }

  return { text: normalized.slice(0, limit), title: document.title, url: location.href, links }
}

/** Page-side search-result extraction for DuckDuckGo HTML and Bing. */
function extractSearchResults({ engine, limit }) {
  const rows = []
  if (engine === 'bing') {
    for (const item of document.querySelectorAll('li.b_algo')) {
      const anchor = item.querySelector('h2 a')
      if (!anchor) continue
      const snippet = item.querySelector('.b_caption p')
      rows.push({
        title: anchor.textContent || '',
        url: anchor.getAttribute('href') || '',
        snippet: snippet ? snippet.textContent || '' : '',
      })
      if (rows.length >= limit) break
    }
  } else {
    for (const anchor of document.querySelectorAll('a.result__a')) {
      const result = anchor.closest('.result')
      const snippet = result ? result.querySelector('.result__snippet') : null
      rows.push({
        title: anchor.textContent || '',
        url: anchor.getAttribute('href') || '',
        snippet: snippet ? snippet.textContent || '' : '',
      })
      if (rows.length >= limit) break
    }
  }
  return rows
}

/**
 * Create the dsh-browser manager.
 *
 * @param {object} [options]
 * @param {object} [options.config] host config (section 4 defaults apply)
 * @param {object} [options.logger] logger with debug/warn/info methods
 * @param {string} [options.profileDir] DSH profile root for settings.json
 * @param {string} [options.outputDir] screenshot root (absolute or cwd-relative)
 * @returns {object} manager API described in the contract, section 6
 */
export function createBrowserManager(options = {}) {
  const config = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(options.config ?? {})) {
    if (value !== undefined) config[key] = value
  }
  const logger = options.logger ?? console
  const profileDir = typeof options.profileDir === 'string' && options.profileDir !== ''
    ? path.resolve(options.profileDir)
    : path.resolve('.dsh-browser-profile')
  const outputDir = path.resolve(options.outputDir ?? config.outputDir ?? '.dsh-browser')
  const settingsPath = path.join(profileDir, 'plugin-data', 'dsh-browser', 'settings.json')
  const engine = detectEngine(config)

  const sessions = new Map()
  const activity = []
  const screenshotBuffers = new Map()

  let mode = loadMode()
  let updatedAt = Date.now()
  let sessionCounter = 0
  let activityCounter = 0
  let disposed = false

  let hiddenBrowser
  let visibleBrowser
  let hiddenLaunching
  let visibleLaunching
  let hiddenClosing = false
  let visibleClosing = false
  let idleTimer

  /** Read the persisted mode, falling back to config.mode for a fresh profile. */
  function loadMode() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && MODES.has(parsed.mode)) return parsed.mode
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.debug?.(`[dsh-browser] could not read settings: ${errorMessage(error)}`)
    }
    return MODES.has(config.mode) ? config.mode : 'auto'
  }

  /** Persist the mode atomically (write temp file, then rename). */
  function persistMode(next) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const temporary = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ mode: next }, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, settingsPath)
    } catch (error) {
      try {
        fs.unlinkSync(temporary)
      } catch {
        // best effort cleanup
      }
      throw error
    }
  }

  /** Append one activity entry (newest first, capped). */
  function record(kind, fields = {}) {
    const entry = {
      id: `activity-${++activityCounter}`,
      at: Date.now(),
      kind,
      visible: fields.visible === true,
      title: typeof fields.title === 'string' ? fields.title : '',
      detail: typeof fields.detail === 'string' ? fields.detail : '',
      status: fields.status === 'error' ? 'error' : 'ok',
    }
    if (fields.sessionId !== undefined) entry.sessionId = fields.sessionId
    if (fields.url !== undefined) entry.url = fields.url
    activity.unshift(entry)
    if (activity.length > config.maxActivity) activity.length = config.maxActivity
    updatedAt = Date.now()
    return entry
  }

  /** Record one failure entry. */
  function recordError(visible, title, error, extra = {}) {
    record('error', {
      visible,
      title,
      detail: errorMessage(error),
      status: 'error',
      ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
      ...(extra.url !== undefined ? { url: extra.url } : {}),
    })
  }

  function assertUsable() {
    if (disposed) throw new Error('browser manager has been disposed')
  }

  /** Contract visibility resolution. */
  function resolveVisibility(requested) {
    if (mode === 'visible') return { visible: true, forced: requested === false }
    return { visible: requested === true, forced: false }
  }

  function launchArgs(visible) {
    const args = [...BASE_LAUNCH_ARGS]
    if (visible) args.push('--lang=ru-RU')
    args.push('--window-size=1440,900')
    return args
  }

  /** All sessions, newest first. */
  function sortedSessions(filterVisible) {
    return [...sessions.values()]
      .filter((session) => filterVisible === undefined || session.visible === filterVisible)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  function mostRecentSession(filterVisible) {
    return sortedSessions(filterVisible)[0]
  }

  function toSessionState(session) {
    return {
      id: session.id,
      visible: session.visible,
      url: session.url,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastAction: session.lastAction,
    }
  }

  function clearIdleTimer() {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  /** (Re)arm the hidden idle timer; unref keeps the host event loop free. */
  function armIdleTimer() {
    clearIdleTimer()
    if (disposed || hiddenBrowser === undefined) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      void closeHiddenAfterIdle()
    }, config.hiddenIdleMs)
    idleTimer.unref?.()
  }

  function beginHiddenOperation() {
    clearIdleTimer()
  }

  function endHiddenOperation() {
    if (!disposed) armIdleTimer()
  }

  /** Close the hidden browser because the idle window expired. */
  async function closeHiddenAfterIdle() {
    if (disposed || hiddenBrowser === undefined) return
    const hadSessions = sortedSessions(false).length
    await closeBrowser(false)
    for (const session of [...sessions.values()]) {
      if (!session.visible) sessions.delete(session.id)
    }
    record('auto-close', {
      visible: false,
      title: 'Скрытый браузер',
      detail: hadSessions > 0
        ? `Скрытый браузер закрыт после ${config.hiddenIdleMs} мс простоя (сеансов: ${hadSessions})`
        : `Скрытый браузер закрыт после ${config.hiddenIdleMs} мс простоя`,
    })
  }

  /** Launch (once) the Chromium process for one visibility class. */
  async function ensureBrowser(visible) {
    assertUsable()
    const existing = visible ? visibleBrowser : hiddenBrowser
    if (existing !== undefined) return existing
    const launching = visible ? visibleLaunching : hiddenLaunching
    if (launching !== undefined) return launching
    if (!engine.available) {
      throw new Error('browser engine not found: set DSH_BROWSER_PATH or install Microsoft Edge/Google Chrome')
    }

    const promise = chromium.launch({
      executablePath: engine.path,
      headless: !visible,
      args: launchArgs(visible),
    })
    if (visible) visibleLaunching = promise
    else hiddenLaunching = promise

    try {
      const browser = await promise
      if (disposed) {
        await browser.close().catch(() => {})
        throw new Error('browser manager has been disposed')
      }
      browser.on('disconnected', () => {
        const current = visible ? visibleBrowser : hiddenBrowser
        const closing = visible ? visibleClosing : hiddenClosing
        if (visible) visibleBrowser = undefined
        else hiddenBrowser = undefined
        if (!visible) clearIdleTimer()
        for (const session of [...sessions.values()]) {
          if (session.visible === visible) sessions.delete(session.id)
        }
        if (!closing && !disposed) {
          recordError(visible, visible ? 'Видимый браузер' : 'Скрытый браузер', new Error('browser process ended unexpectedly'))
        }
      })
      if (visible) visibleBrowser = browser
      else hiddenBrowser = browser
      record('launch', {
        visible,
        title: visible ? 'Видимый браузер' : 'Скрытый браузер',
        detail: visible ? 'Запущен видимый браузер' : 'Запущен скрытый браузер',
      })
      if (!visible) armIdleTimer()
      logger.debug?.(`[dsh-browser] launched ${visible ? 'visible' : 'hidden'} browser via ${engine.path}`)
      return browser
    } catch (error) {
      if (error instanceof Error && (error.message === 'browser manager has been disposed' || error.message.startsWith('browser launch failed'))) {
        throw error
      }
      throw new Error(`browser launch failed: ${errorMessage(error)}`)
    } finally {
      if (visible) visibleLaunching = undefined
      else hiddenLaunching = undefined
    }
  }

  /** Attach page event listeners; navigation must not create activity entries. */
  function attachPageEvents(session) {
    const { page } = session
    const refreshTitle = () => {
      page.title().then((title) => {
        session.title = title
        session.updatedAt = Date.now()
        updatedAt = Date.now()
      }).catch(() => {})
    }
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      session.url = frame.url()
      session.updatedAt = Date.now()
      updatedAt = Date.now()
      refreshTitle()
    })
    page.on('domcontentloaded', refreshTitle)
    page.on('load', refreshTitle)
    page.on('console', (message) => {
      const type = message.type()
      if (type === 'error' || type === 'warning') {
        logger.debug?.(`[dsh-browser] console ${type}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => {
      logger.warn?.(`[dsh-browser] page error: ${errorMessage(error)}`)
    })
    page.on('close', () => {
      if (sessions.get(session.id) === session) {
        sessions.delete(session.id)
        updatedAt = Date.now()
      }
    })
  }

  /** Close one session's context; safe when already gone. */
  async function closeSessionInternal(session) {
    if (sessions.get(session.id) !== session) return false
    sessions.delete(session.id)
    session.status = 'closed'
    session.updatedAt = Date.now()
    updatedAt = Date.now()
    try {
      await session.context.close()
    } catch (error) {
      logger.debug?.(`[dsh-browser] context close failed: ${errorMessage(error)}`)
    }
    return true
  }

  /** Close one browser class, suppressing its disconnected handler. */
  async function closeBrowser(visible) {
    const browser = visible ? visibleBrowser : hiddenBrowser
    if (browser === undefined) return
    if (visible) {
      visibleClosing = true
      visibleBrowser = undefined
    } else {
      hiddenClosing = true
      hiddenBrowser = undefined
      clearIdleTimer()
    }
    try {
      await browser.close()
    } catch (error) {
      logger.debug?.(`[dsh-browser] browser close failed: ${errorMessage(error)}`)
    } finally {
      if (visible) visibleClosing = false
      else hiddenClosing = false
    }
  }

  /** Create a context+page session for a visibility class. */
  async function createSession(visible) {
    if (sessions.size >= config.maxSessions) await evictOneSession()
    const browser = await ensureBrowser(visible)
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: DEFAULT_USER_AGENT,
      locale: 'ru-RU',
    })
    const page = await context.newPage()
    const now = Date.now()
    const session = {
      id: `${visible ? 'visible' : 'hidden'}-${++sessionCounter}`,
      visible,
      browser,
      context,
      page,
      status: 'launching',
      url: '',
      title: '',
      createdAt: now,
      updatedAt: now,
      lastAction: 'launch',
      queue: Promise.resolve(),
    }
    attachPageEvents(session)
    sessions.set(session.id, session)
    updatedAt = now
    return session
  }

  /** Make room for a new session by dropping the least recently used one. */
  async function evictOneSession() {
    const candidates = sortedSessions()
    const victim = candidates.find((session) => session.status !== 'busy') ?? candidates[0]
    if (victim === undefined) return
    const visible = victim.visible
    await closeSessionInternal(victim)
    if (mostRecentSession(visible) === undefined) await closeBrowser(visible)
  }

  /** Reuse the most recent session of a class when it fits, else create one. */
  async function acquireSession(visible, url) {
    const existing = mostRecentSession(visible)
    if (existing !== undefined && (url === undefined || existing.url === url)) {
      return { session: existing, created: false }
    }
    if (existing !== undefined && url === undefined) return { session: existing, created: false }
    return { session: await createSession(visible), created: true }
  }

  /** Serialize operations per session (independent sessions stay parallel). */
  function runSessionAction(session, action, fn) {
    const run = session.queue.then(
      () => executeLocked(session, action, fn),
      () => executeLocked(session, action, fn),
    )
    session.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async function executeLocked(session, action, fn) {
    if (disposed) throw new Error('browser manager has been disposed')
    if (!sessions.has(session.id)) throw new Error(`no open browser session: ${session.id}`)
    if (session.page.isClosed()) {
      sessions.delete(session.id)
      throw new Error(`no open browser session: ${session.id}`)
    }
    session.status = 'busy'
    session.lastAction = action
    session.updatedAt = Date.now()
    updatedAt = Date.now()
    try {
      const result = await fn()
      session.status = 'ready'
      session.updatedAt = Date.now()
      updatedAt = Date.now()
      return result
    } catch (error) {
      session.status = 'error'
      session.updatedAt = Date.now()
      updatedAt = Date.now()
      throw error
    }
  }

  /** Read a compact snapshot of the current page (preview text capped at 1200). */
  async function takeSnapshot(session) {
    const info = await session.page.evaluate(extractPageText, { limit: 1201, includeLinks: false })
    const textPreview = String(info.text ?? '').slice(0, 1200)
    session.url = info.url || session.page.url()
    session.title = info.title || session.title
    session.updatedAt = Date.now()
    return {
      sessionId: session.id,
      visible: session.visible,
      url: session.url,
      title: session.title,
      textPreview,
    }
  }

  /** Resolve a session by id or pick the most recent one. */
  function pickSession(sessionId) {
    if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
      const session = sessions.get(String(sessionId))
      if (session === undefined) throw new Error(`no open browser session: ${sessionId}`)
      return session
    }
    const session = mostRecentSession()
    if (session === undefined) throw new Error('no open browser session')
    return session
  }

  /** Wait briefly for a navigation initiated by click/type, never fail on it. */
  async function settleNavigation(page) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
    } catch {
      // Navigation may not happen at all; the snapshot below is authoritative.
    }
  }

  function getState() {
    return {
      mode,
      engine: {
        available: engine.available,
        name: engine.name,
        ...(engine.path !== undefined ? { path: engine.path } : {}),
      },
      sessions: sortedSessions().map(toSessionState),
      activity: activity.map((entry) => ({ ...entry })),
      updatedAt,
    }
  }

  function getMode() {
    return mode
  }

  function setMode(next) {
    if (!MODES.has(next)) throw new Error(`invalid browser mode: ${String(next)} (expected "auto" or "visible")`)
    persistMode(next)
    mode = next
    record('mode', {
      visible: next === 'visible',
      title: next === 'visible' ? 'Показывать всё' : 'Авто',
      detail: `Режим браузера: ${next}`,
    })
    return mode
  }

  async function search({ query, maxResults = 6, visible, signal } = {}) {
    assertUsable()
    const normalizedQuery = typeof query === 'string' ? query.trim() : ''
    if (normalizedQuery === '') throw new Error('search query is required')
    const limit = clampInt(maxResults, 6, 1, 10)
    const { visible: useVisible } = resolveVisibility(visible)
    const engineName = config.searchEngine === 'bing' ? 'bing' : 'duckduckgo'
    if (!useVisible) beginHiddenOperation()

    let created = false
    let session
    try {
      const acquired = await acquireSession(useVisible)
      session = acquired.session
      created = acquired.created
      const result = await runSessionAction(session, 'search', async () => {
        const target = `${SEARCH_URLS[engineName]}${encodeURIComponent(normalizedQuery)}`
        await session.page.goto(target, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS, signal })
        // Result markup is static on both engines, but give slow HTML responses
        // a short grace period instead of reading a half-built list.
        await session.page.waitForSelector(
          engineName === 'bing' ? 'li.b_algo h2 a' : 'a.result__a',
          { timeout: 5000 },
        ).catch(() => {})
        const rows = await session.page.evaluate(extractSearchResults, { engine: engineName, limit: limit * 3 })
        const results = normalizeSearchRows(rows, limit)
        const truncated = rows.length > results.length
        session.url = session.page.url()
        session.title = await session.page.title().catch(() => session.title)
        return { query: normalizedQuery, sessionId: session.id, visible: useVisible, results, truncated }
      })
      record('search', {
        visible: useVisible,
        sessionId: session.id,
        title: normalizedQuery,
        detail: `${engineName === 'bing' ? 'Bing' : 'DuckDuckGo'}: найдено ${result.results.length}`,
        url: session.url,
      })
      return result
    } catch (error) {
      if (created && session !== undefined) await closeSessionInternal(session)
      recordError(useVisible, `Поиск: ${normalizedQuery}`, error, { sessionId: session?.id, url: session?.url })
      throw error
    } finally {
      if (!useVisible) endHiddenOperation()
    }
  }

  async function open({ url, visible, waitUntil = 'domcontentloaded', signal } = {}) {
    assertUsable()
    const normalized = normalizeUrl(url)
    if (!WAIT_UNTIL.has(waitUntil)) {
      throw new Error(`unsupported waitUntil: ${String(waitUntil)} (expected domcontentloaded, load or networkidle)`)
    }
    const { visible: useVisible } = resolveVisibility(visible)
    if (!useVisible) beginHiddenOperation()

    let created = false
    let session
    try {
      const acquired = await acquireSession(useVisible, normalized)
      session = acquired.session
      created = acquired.created
      const snapshot = await runSessionAction(session, 'open', async () => {
        await session.page.goto(normalized, { waitUntil, timeout: ACTION_TIMEOUT_MS, signal })
        return takeSnapshot(session)
      })
      record('open', {
        visible: useVisible,
        sessionId: session.id,
        title: snapshot.title || normalized,
        detail: 'Открыта страница',
        url: snapshot.url,
      })
      return snapshot
    } catch (error) {
      if (created && session !== undefined) await closeSessionInternal(session)
      recordError(useVisible, `Открытие: ${normalized}`, error, { sessionId: session?.id, url: normalized })
      throw error
    } finally {
      if (!useVisible) endHiddenOperation()
    }
  }

  async function read({ sessionId, maxChars = 8000, includeLinks = false, signal } = {}) {
    assertUsable()
    const cap = clampInt(maxChars, 8000, 1, MAX_TEXT_CHARS)
    const session = pickSession(sessionId)
    if (!session.visible) beginHiddenOperation()
    try {
      const result = await runSessionAction(session, 'read', async () => {
        const info = await session.page.evaluate(extractPageText, { limit: cap + 1, includeLinks: includeLinks === true })
        const fullText = String(info.text ?? '')
        const truncated = fullText.length > cap
        const text = fullText.slice(0, cap)
        session.url = info.url || session.page.url()
        session.title = info.title || session.title
        const value = { sessionId: session.id, url: session.url, title: session.title, text, truncated }
        if (includeLinks === true) value.links = Array.isArray(info.links) ? info.links.slice(0, 50) : []
        return value
      })
      record('read', {
        visible: session.visible,
        sessionId: session.id,
        title: result.title || session.url,
        detail: `Прочитано символов: ${result.text.length}${result.truncated ? ' (обрезано)' : ''}`,
        url: result.url,
      })
      return result
    } catch (error) {
      recordError(session.visible, 'Чтение страницы', error, { sessionId: session.id, url: session.url })
      throw error
    } finally {
      if (!session.visible) endHiddenOperation()
    }
  }

  async function click({ sessionId, selector, text, index = 0, signal } = {}) {
    assertUsable()
    const hasSelector = typeof selector === 'string' && selector.trim() !== ''
    const hasText = typeof text === 'string' && text.trim() !== ''
    if (hasSelector === hasText) throw new Error('browser click requires exactly one of selector or text')
    const session = pickSession(sessionId)
    if (!session.visible) beginHiddenOperation()
    try {
      const snapshot = await runSessionAction(session, 'click', async () => {
        const position = clampInt(index, 0, 0, 10000)
        const locator = hasSelector
          ? session.page.locator(selector.trim())
          : session.page.getByText(text.trim())
        const target = locator.nth(position)
        await target.click({ timeout: 15000, signal })
        await settleNavigation(session.page)
        return takeSnapshot(session)
      })
      record('click', {
        visible: session.visible,
        sessionId: session.id,
        title: snapshot.title || snapshot.url,
        detail: hasSelector ? `Клик: ${selector.trim()}` : `Клик по тексту: ${text.trim()}`,
        url: snapshot.url,
      })
      return snapshot
    } catch (error) {
      recordError(session.visible, 'Клик', error, { sessionId: session.id, url: session.url })
      throw error
    } finally {
      if (!session.visible) endHiddenOperation()
    }
  }

  async function type({ sessionId, selector, text, submit = false, clear = false, signal } = {}) {
    assertUsable()
    const targetSelector = typeof selector === 'string' ? selector.trim() : ''
    if (targetSelector === '') throw new Error('browser_type selector is required')
    if (typeof text !== 'string') throw new Error('browser_type text is required')
    const session = pickSession(sessionId)
    if (!session.visible) beginHiddenOperation()
    try {
      const snapshot = await runSessionAction(session, 'type', async () => {
        const locator = session.page.locator(targetSelector).first()
        await locator.click({ timeout: 15000, signal })
        if (clear === true) await locator.fill(text, { timeout: 15000, signal })
        else await locator.pressSequentially(text, { timeout: 15000, signal })
        if (submit === true) {
          await locator.press('Enter', { timeout: 15000, signal })
          await settleNavigation(session.page)
        }
        return takeSnapshot(session)
      })
      record('type', {
        visible: session.visible,
        sessionId: session.id,
        title: snapshot.title || snapshot.url,
        detail: `Ввод в ${targetSelector}${submit ? ' + Enter' : ''}`,
        url: snapshot.url,
      })
      return snapshot
    } catch (error) {
      recordError(session.visible, 'Ввод текста', error, { sessionId: session.id, url: session.url })
      throw error
    } finally {
      if (!session.visible) endHiddenOperation()
    }
  }

  async function screenshot({ sessionId, fullPage = false, label, signal } = {}) {
    assertUsable()
    const session = pickSession(sessionId)
    if (!session.visible) beginHiddenOperation()
    try {
      const buffer = await runSessionAction(session, 'screenshot', async () => {
        return session.page.screenshot({ type: 'png', fullPage: fullPage === true, signal })
      })
      const url = session.page.url() || session.url
      const title = await session.page.title().catch(() => session.title)
      session.url = url
      session.title = title || session.title
      const directory = path.join(outputDir, 'screenshots')
      fs.mkdirSync(directory, { recursive: true })
      const base = `${fileTimestamp()}-${slugify(label || title || url)}`
      let file = path.join(directory, `${base}.png`)
      let suffix = 2
      while (fs.existsSync(file)) {
        file = path.join(directory, `${base}-${suffix}.png`)
        suffix += 1
      }
      fs.writeFileSync(file, buffer)
      screenshotBuffers.delete(session.id)
      screenshotBuffers.set(session.id, { bytes: buffer, contentType: 'image/png' })
      while (screenshotBuffers.size > MAX_SCREENSHOT_BUFFERS) {
        const oldest = screenshotBuffers.keys().next().value
        screenshotBuffers.delete(oldest)
      }
      record('screenshot', {
        visible: session.visible,
        sessionId: session.id,
        title: title || session.url,
        detail: fullPage === true ? 'Снимок всей страницы' : 'Снимок экрана',
        url,
      })
      return { path: path.resolve(file), url, title: title || session.title, sessionId: session.id }
    } catch (error) {
      recordError(session.visible, 'Снимок страницы', error, { sessionId: session.id, url: session.url })
      throw error
    } finally {
      if (!session.visible) endHiddenOperation()
    }
  }

  async function close({ sessionId, all = false } = {}) {
    assertUsable()
    const targets = []
    if (all === true) {
      targets.push(...sessions.values())
    } else if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
      const session = sessions.get(String(sessionId))
      if (session === undefined) {
        record('close', { title: '', detail: `Сеанс ${String(sessionId)} уже закрыт` })
        return { closed: 0 }
      }
      targets.push(session)
    } else {
      const latest = mostRecentSession()
      if (latest === undefined) {
        record('close', { title: '', detail: 'Нет открытых сеансов' })
        return { closed: 0 }
      }
      targets.push(latest)
    }

    let closed = 0
    for (const session of targets) {
      if (await closeSessionInternal(session)) closed += 1
    }

    if (all === true) {
      await closeBrowser(true)
      await closeBrowser(false)
    } else {
      for (const visible of new Set(targets.map((session) => session.visible))) {
        if (mostRecentSession(visible) === undefined) await closeBrowser(visible)
      }
    }

    const first = targets[0]
    record('close', {
      visible: first?.visible === true,
      sessionId: all === true ? undefined : first?.id,
      title: all === true ? '' : (first?.title || first?.url || ''),
      detail: all === true ? `Закрыто сеансов: ${closed}` : `Закрыт сеанс ${first?.id ?? ''}`,
      url: first?.url,
    })
    return { closed }
  }

  function clearActivity() {
    activity.length = 0
    updatedAt = Date.now()
  }

  function getScreenshot(sessionId) {
    if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
      return screenshotBuffers.get(String(sessionId))
    }
    const keys = [...screenshotBuffers.keys()]
    const last = keys[keys.length - 1]
    return last === undefined ? undefined : screenshotBuffers.get(last)
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    clearIdleTimer()
    const remaining = [...sessions.values()]
    sessions.clear()
    for (const session of remaining) {
      session.status = 'closed'
      try {
        await session.context.close()
      } catch {
        // already gone
      }
    }
    await Promise.allSettled([closeBrowser(true), closeBrowser(false)])
    // A launch that was already in flight may finish after disposal started;
    // await it and close whatever it produced so no browser process survives.
    const pending = [hiddenLaunching, visibleLaunching].filter((promise) => promise !== undefined)
    if (pending.length > 0) {
      await Promise.allSettled(pending)
      await Promise.allSettled([closeBrowser(true), closeBrowser(false)])
    }
    hiddenLaunching = undefined
    visibleLaunching = undefined
  }

  return {
    getState,
    getMode,
    setMode,
    resolveVisibility,
    search,
    open,
    read,
    click,
    type,
    screenshot,
    close,
    clearActivity,
    getScreenshot,
    dispose,
  }
}

export const internals = {
  detectEngine,
  normalizeUrl,
  normalizeSearchRows,
  resolveDdgRedirect,
  resolveBingRedirect,
  slugify,
}
