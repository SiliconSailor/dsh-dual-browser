/**
 * dsh-browser / server / routes
 *
 * Web routes for the left-sidebar browser panel. Routes are registered lazily:
 * the Web server may bind after this plugin, and a headless profile may never
 * provide one — tools must keep working either way. Every handler is wrapped
 * with the Connection gate copied inline, per the plugin contract (section 8).
 */

/** Service keys that can carry the Web route registry. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer']
/** Maximum accepted JSON request body (contract: 64 KB). */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Register the panel routes on the Web server when it is (or becomes) present.
 *
 * @param {object} ctx plugin context
 * @param {object} manager manager returned by createBrowserManager
 * @param {object} [config] resolved host config (unused today, kept for the stable seam)
 */
export function registerBrowserRoutes(ctx, manager, config = {}) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return

  let registered = false
  let webServer

  /** The Connection service may be absent in headless/seam-only assemblies. */
  const gate = () => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)

  /** JSON response with the no-store contract header. */
  const writeJson = (res, status, body, extraHeaders = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    })
    res.end(JSON.stringify(body))
  }

  /** 405 with the allow header, as required by the route contract. */
  const methodNotAllowed = (res, allow) => {
    writeJson(res, 405, { error: 'method not allowed' }, { allow })
  }

  /** Reject when the Connection gate denies the request (503/401/403). */
  const gateRejection = (req, res) => {
    const connection = gate()
    const rejection = connection === undefined ? 503 : connection.requestRejection(req)
    if (rejection === undefined) return false
    writeJson(res, rejection, {
      error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
    })
    return true
  }

  /** Read a JSON object no larger than MAX_BODY_BYTES. */
  const readJsonBody = (req, res) => new Promise((resolve) => {
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      writeJson(res, 413, { error: 'request body is too large' })
      req.resume?.()
      resolve(undefined)
      return
    }

    let size = 0
    let settled = false
    const chunks = []
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const fail = (status, message) => {
      if (settled) return
      settled = true
      cleanup()
      writeJson(res, status, { error: message })
      req.resume?.()
      resolve(undefined)
    }
    const onData = (chunk) => {
      if (settled) return
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > MAX_BODY_BYTES) {
        fail(413, 'request body is too large')
        return
      }
      chunks.push(part)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      let value
      try {
        value = raw === '' ? {} : JSON.parse(raw)
      } catch {
        writeJson(res, 400, { error: 'invalid JSON' })
        resolve(undefined)
        return
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        writeJson(res, 400, { error: 'body must be a JSON object' })
        resolve(undefined)
        return
      }
      resolve(value)
    }
    const onError = () => fail(400, 'invalid request body')
    const onAborted = () => fail(400, 'request body was aborted')

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })

  /** Register one handler route behind the gate, scoped to the plugin effect. */
  const route = (path, handler) => {
    const definition = {
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          if (gateRejection(req, res)) return
          await handler(req, res)
        } catch (error) {
          // A failing manager call must produce JSON, never a dropped socket.
          if (!res.headersSent) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : 'browser route failed' })
          } else {
            res.end()
          }
        }
      },
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => webServer.register(definition), `dsh-browser: ${path}`)
    } else {
      webServer.register(definition)
    }
  }

  /** Try to bind routes once; no-op while the Web server is absent. */
  const tryRegister = () => {
    if (registered) return
    const server = (typeof ctx.get === 'function' ? ctx.get(WEB_SERVER_KEYS[0]) : undefined)
      ?? (typeof ctx.get === 'function' ? ctx.get(WEB_SERVER_KEYS[1]) : undefined)
    if (server === undefined || server === null || typeof server.register !== 'function') return
    webServer = server
    registered = true

    route('/plugins/dsh-browser/state', async (req, res) => {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      writeJson(res, 200, manager.getState())
    })

    route('/plugins/dsh-browser/mode', async (req, res) => {
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const mode = body.mode
      if (mode !== 'auto' && mode !== 'visible') {
        writeJson(res, 400, { error: 'mode must be "auto" or "visible"' })
        return
      }
      try {
        const saved = manager.setMode(mode)
        writeJson(res, 200, { mode: saved })
      } catch (error) {
        writeJson(res, 400, { error: error instanceof Error ? error.message : 'could not save the mode' })
      }
    })

    route('/plugins/dsh-browser/close', async (req, res) => {
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
      const all = body.all === true
      if (sessionId === undefined && !all) {
        writeJson(res, 400, { error: 'sessionId or all is required' })
        return
      }
      const result = await manager.close({ sessionId, all })
      writeJson(res, 200, { closed: result.closed })
    })

    route('/plugins/dsh-browser/clear', async (req, res) => {
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      if (typeof manager.clearActivity === 'function') manager.clearActivity()
      writeJson(res, 200, { ok: true })
    })

    route('/plugins/dsh-browser/screenshot', async (req, res) => {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const screenshot = manager.getScreenshot(sessionId)
      if (screenshot === undefined) {
        writeJson(res, 404, { error: 'screenshot not found' })
        return
      }
      const bytes = Buffer.isBuffer(screenshot.bytes) ? screenshot.bytes : Buffer.from(screenshot.bytes)
      res.writeHead(200, {
        'content-type': screenshot.contentType ?? 'image/png',
        'cache-control': 'no-store',
        'content-length': String(bytes.length),
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    })
  }

  tryRegister()
  if (!registered && typeof ctx.on === 'function') {
    ctx.on('internal/service', (name) => {
      if (WEB_SERVER_KEYS.includes(name)) tryRegister()
    })
  }
}
