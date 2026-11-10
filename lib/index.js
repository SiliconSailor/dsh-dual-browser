/**
 * dsh-dual-browser — host entry.
 *
 * The agent browser for DeepSeek Harness: one Playwright engine with two
 * visibility classes (hidden/headless and visible/headed), eight `browser_*`
 * tools, five JSON Web routes for the left-sidebar panel, and one
 * system-prompt section that teaches the model the visibility contract.
 *
 * This module is the only wiring layer. The browser itself lives in
 * `./server/manager.js` (plain Node + playwright-core), the tool
 * registrations in `./server/tools.js`, the panel routes in
 * `./server/routes.js`, and the prompt section in `./server/prompt.js`; the
 * client half is the prebuilt bundle `./client.js` (registered through the
 * package manifest `dsh.client`).
 *
 * Mount (bundle patch `cordis.patch.yml`, applied automatically once the
 * package is listed in the profile's `dsh.profile.bundles`):
 *
 * ```yaml
 * - insert:
 *     - id: dsh-dual-browser
 *       name: dsh-dual-browser
 *       config:
 *         mode: auto
 * ```
 *
 * @module dsh-browser
 */

import os from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createBrowserManager } from './server/manager.js'
import { registerBrowserTools } from './server/tools.js'
import { registerBrowserRoutes } from './server/routes.js'
import { registerBrowserPrompt } from './server/prompt.js'

/**
 * Node-resolvable package name (`package.json` name, cordis row `name`).
 *
 * Routes, the client bundle id and the data directories keep the historical
 * `dsh-browser` prefix: they are the feature's stable namespace, not the npm
 * package identity, so renaming the package never breaks a running panel.
 */
export const name = 'dsh-dual-browser'

/**
 * Required cordis service: the browser tools are the product, so the plugin
 * waits for the tool registry instead of mounting a half-empty row (cordis
 * refuses service-property access on a plugin that does not declare it).
 * The system prompt and the Web server stay optional — see {@link apply}.
 */
export const inject = ['tools']

/**
 * Host configuration (contract §4). Every key is optional: the defaults below
 * are the shipped behaviour, and a profile may override any of them in its
 * `cordis.patch.yml` row.
 */
export const Config = z.object({
  /** `auto` lets the agent pick visibility per action; `visible` forces every launch on screen. */
  mode: z.union([z.const('auto'), z.const('visible')]).default('auto'),
  /** Search backend used by `browser_search`. */
  searchEngine: z.union([z.const('duckduckgo'), z.const('bing')]).default('duckduckgo'),
  /** Idle timeout after which hidden sessions close themselves, in milliseconds. */
  hiddenIdleMs: z.natural().min(1000).default(45000),
  /** Placement of the usage section in the global system prompt. */
  promptSectionOrder: z.natural().default(118),
  /** Explicit browser executable; empty falls back to Edge → Chrome → DSH_BROWSER_PATH. */
  executablePath: z.string(),
  /** Directory for PNG screenshots, resolved against the process working directory. */
  outputDir: z.string().default('.dsh-browser'),
  /** Activity-feed entries kept in memory. */
  maxActivity: z.natural().min(10).default(40),
  /** Upper bound on concurrently open browser sessions. */
  maxSessions: z.natural().min(1).default(8),
})

/** Default screenshots root when the host config omits `outputDir`. */
const DEFAULT_OUTPUT_DIR = '.dsh-browser'

/** Is this a non-empty string? */
function nonEmpty(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * Read a service without assuming the host provides `ctx.get` (fake contexts
 * in tests implement only the interfaces they need).
 * @param {object} ctx plugin context
 * @param {string} serviceName cordis service name
 * @returns {unknown} the service, or `undefined` when it is absent
 */
function getService(ctx, serviceName) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') return ctx.get(serviceName)
  return ctx[serviceName]
}

/**
 * Resolve the DSH profile directory that holds `<profileDir>/plugin-data/dsh-browser/settings.json`
 * (contract §4): `DSH_PROFILE_DIR` → `DSH_HOME ?? ~/.dsh` + `profiles` + `DSH_PROFILE ?? desktop`.
 *
 * The desktop host also publishes a `profileContext` service with the exact
 * directory it booted. It is consulted only for the values the environment
 * left unspecified (never overriding `DSH_PROFILE_DIR`/`DSH_HOME`/`DSH_PROFILE`),
 * so a profile launched with a custom name or home still finds its settings
 * file instead of writing into a guessed `~/.dsh/profiles/desktop`.
 *
 * Exported for the verification script; not part of the cross-module contract.
 *
 * @param {object} [ctx] plugin context (may be omitted)
 * @returns {string} absolute profile directory
 */
export function resolveProfileDir(ctx) {
  const explicit = process.env.DSH_PROFILE_DIR
  if (nonEmpty(explicit)) return resolve(explicit)

  const home = process.env.DSH_HOME
  const profileName = process.env.DSH_PROFILE
  const profileContext = getService(ctx ?? {}, 'profileContext')
  const contextDir = profileContext !== null && typeof profileContext === 'object' ? profileContext.dir : undefined

  if (!nonEmpty(home) && !nonEmpty(profileName) && nonEmpty(contextDir)) return resolve(contextDir)

  const base = nonEmpty(home) ? resolve(home) : join(os.homedir(), '.dsh')
  const fallbackName = nonEmpty(profileName)
    ? profileName
    : profileContext !== null && typeof profileContext === 'object' && nonEmpty(profileContext.name)
      ? profileContext.name
      : 'desktop'
  return join(base, 'profiles', fallbackName)
}

/**
 * Register the usage section once the system-prompt service exists. That
 * service is not required for the plugin (a composition without it still has
 * working browser tools), so it is never declared in `inject`. It is bound as
 * a child plugin through `ctx.inject`, which hands back a context that declares
 * the dependency — cordis refuses service-property access otherwise, so the
 * system-prompt service must not be read from this fiber.
 *
 * @param {object} ctx plugin context
 * @param {object} manager browser manager
 * @param {object} config resolved host config
 */
function onSystemPrompt(ctx, manager, config) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => registerBrowserPrompt(promptCtx, manager, config))
    return
  }
  // Host without the injection seam (tests, embedded assemblies): bind
  // directly when the service is present.
  if (typeof ctx.get === 'function' && ctx.get('systemPrompt') !== undefined) {
    registerBrowserPrompt(ctx, manager, config)
    return
  }
  ctx.logger?.debug?.('[dsh-browser] no system-prompt service; the usage section stays unregistered')
}

/**
 * Mount dsh-browser on the host composition.
 *
 * @param {object} ctx cordis plugin context
 * @param {object} [config] resolved host config (see {@link Config})
 */
export function apply(ctx, config = {}) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const logger = ctx.logger ?? console
  const profileDir = resolveProfileDir(ctx)
  const outputDir = resolve(process.cwd(), nonEmpty(settings.outputDir) ? settings.outputDir : DEFAULT_OUTPUT_DIR)

  // One engine per mounted plugin: it owns both browser classes, the session
  // map, the activity feed and the persisted mode. Created eagerly (no browser
  // process is launched until the first tool call) so every surface below
  // shares the same instance, and disposed with the plugin fiber so no hidden
  // browser survives unload.
  const manager = createBrowserManager({ config: settings, logger, profileDir, outputDir })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => manager.dispose(), 'dsh-browser: dispose browser engine')
  } else if (typeof ctx.on === 'function') {
    // Best-effort fallback for a host without `ctx.effect`: dispose on unload
    // events only, never on normal traffic.
    ctx.on('dispose', () => { void manager.dispose() })
  }

  // `tools` is a declared dependency, so it is always available here.
  registerBrowserTools(ctx, manager, settings)
  onSystemPrompt(ctx, manager, settings)

  // The route module owns its own laziness (it binds now when a Web server is
  // present and retries on `internal/service` otherwise), so it is always
  // called: a headless profile keeps the tools and simply has no routes.
  registerBrowserRoutes(ctx, manager, settings)

  logger.debug?.(`[dsh-browser] mounted: profile=${profileDir} output=${outputDir} mode=${manager.getMode()}`)
}
