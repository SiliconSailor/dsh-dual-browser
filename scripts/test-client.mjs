/**
 * dsh-browser client bundle checks (contract §11).
 *
 * Loads `lib/client.js` exactly like the host's module loader does, applies the
 * plugin to a recording fake context, renders the panel with react-dom/server,
 * and exercises the polling/optimistic-mode helpers without a DOM.
 *
 * Run: node dsh-browser/scripts/test-client.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bundlePath = path.join(root, "lib", "client.js");

let passed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(() => {
        passed += 1;
        console.log("  ok  " + name);
      });
    }
    passed += 1;
    console.log("  ok  " + name);
  } catch (error) {
    console.error("  FAIL " + name);
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONTRACT_KEYS = [
  "panel.title",
  "page.title",
  "page.subtitle",
  "mode.label",
  "mode.auto",
  "mode.visible",
  "mode.auto.desc",
  "mode.visible.desc",
  "mode.saving",
  "status.engine",
  "status.sessions",
  "status.ready",
  "status.missing",
  "status.hiddenIdle",
  "sessions.title",
  "sessions.empty",
  "sessions.emptyHint",
  "sessions.hidden",
  "sessions.visible",
  "activity.title",
  "activity.empty",
  "activity.clear",
  "action.close",
  "action.closeAll",
  "action.refresh",
  "state.loading",
  "state.error",
  "state.retry",
  "footer.note",
  "kind.launch",
  "kind.open",
  "kind.search",
  "kind.read",
  "kind.click",
  "kind.type",
  "kind.screenshot",
  "kind.close",
  "kind.auto-close",
  "kind.error",
  "kind.mode",
];

const ALLOWED_TOKENS = new Set([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l3",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-brand-primary",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-label-primary-inverted",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-radius-sm",
  "--dsw-radius-md",
  "--dsw-font-family",
]);

//#region load the bundle like the host does
const registrations = [];
const fakeWindow = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};
const source = fs.readFileSync(bundlePath, "utf8");
new Function("window", source)(fakeWindow);

assert.equal(registrations.length, 1, "bundle must register exactly one factory");
const registration = registrations[0];
assert.equal(registration.id, "dsh-browser");
assert.equal(typeof registration.factory, "function");

const requiredModules = [];
const fakeRequire = (id) => {
  requiredModules.push(id);
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return jsxRuntime;
  throw new Error("unexpected require: " + id);
};
const plugin = registration.factory(fakeRequire);

console.log("bundle envelope");
await check("id is dsh-browser and the factory returns apply/inject", () => {
  assert.equal(typeof plugin.apply, "function");
  assert.ok(Array.isArray(plugin.inject));
  assert.deepEqual(plugin.inject, ["slots", "locale", "layout"]);
});
await check("requires only react and react/jsx-runtime", () => {
  const unique = [...new Set(requiredModules)].sort();
  assert.deepEqual(unique, ["react", "react/jsx-runtime"]);
  assert.ok(requiredModules.every((id) => id === "react" || id === "react/jsx-runtime"));
  assert.ok(!requiredModules.some((id) => id.startsWith("@deepseek-ai/")), "no @deepseek-ai imports allowed");
});
//#endregion

//#region apply(ctx) registrations
console.log("apply(ctx)");
const localeRegistrations = [];
const slotRegistrations = [];
const injections = [];
const effects = [];
const selectedLocale = "ru";
const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
      return () => {};
    },
    bind(namespace) {
      const entry = localeRegistrations.find((row) => row.namespace === namespace);
      const dict = entry ? entry.dictionaries[selectedLocale] : {};
      return (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key);
    },
  },
  slots: {
    inject(name, factory) {
      injections.push(name);
      factory();
      return () => {};
    },
    register(options, component) {
      slotRegistrations.push({ options, component });
      return () => {};
    },
  },
  get() {
    return undefined;
  },
};
plugin.apply(ctx);

await check("registers the dshBrowser dictionaries through ctx.effect", () => {
  assert.deepEqual(effects, ["dsh-browser: dictionaries"]);
  assert.equal(localeRegistrations.length, 1);
  assert.equal(localeRegistrations[0].namespace, "dshBrowser");
  assert.deepEqual(Object.keys(localeRegistrations[0].dictionaries).sort(), ["en", "ru"]);
});
await check("registers sidebar.panellist and main exactly once", () => {
  assert.deepEqual(injections, ["sidebar.panellist", "main"]);
  assert.equal(slotRegistrations.length, 2);
});
await check("sidebar.panellist entry uses id dsh-browser, order 20, locale and label", () => {
  const entry = slotRegistrations.find((row) => row.options.name === "sidebar.panellist");
  assert.ok(entry, "sidebar.panellist registration missing");
  assert.equal(entry.options.id, "dsh-browser");
  assert.equal(entry.options.order, 20);
  assert.equal(entry.options.locale, "dshBrowser");
  assert.equal(typeof entry.options.label, "function");
  assert.equal(entry.options.label(), "Браузер");
  assert.equal(entry.component, plugin.BrowserIcon);
});
await check("main entry uses key dsh-browser and the live panel component", () => {
  const entry = slotRegistrations.find((row) => row.options.name === "main");
  assert.ok(entry, "main registration missing");
  assert.equal(entry.options.key, "dsh-browser");
  assert.equal(entry.options.locale, "dshBrowser");
  assert.equal(entry.component, plugin.BrowserPanel);
});
//#endregion

//#region dictionaries
console.log("locale dictionaries");
await check("ru and en carry every contract key (and the same key set)", () => {
  const ru = plugin.dictionaries.ru;
  const en = plugin.dictionaries.en;
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  for (const key of CONTRACT_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(ru, key), "ru missing " + key);
    assert.ok(Object.prototype.hasOwnProperty.call(en, key), "en missing " + key);
    assert.equal(typeof ru[key], "string");
    assert.ok(ru[key].length > 0, "ru empty " + key);
    assert.ok(en[key].length > 0, "en empty " + key);
  }
});
await check("ru is the default binder language and unknown keys fall back to the key", () => {
  assert.equal(plugin.createBinder(plugin.dictionaries.ru)("panel.title"), "Браузер");
  assert.equal(plugin.createBinder(plugin.dictionaries.en)("panel.title"), "Browser");
  assert.equal(plugin.createBinder(plugin.dictionaries.ru)("no.such.key"), "no.such.key");
});
//#endregion

//#region icon
console.log("icon");
await check("globe icon is a 16px currentColor svg that honours size/active", () => {
  const markup = renderToStaticMarkup(React.createElement(plugin.BrowserIcon, { size: 16, active: true }));
  assert.match(markup, /^<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"/);
  assert.match(markup, /stroke="currentColor"/);
  assert.match(markup, /<circle/);
  assert.match(markup, /<path/);
  const resized = renderToStaticMarkup(React.createElement(plugin.BrowserIcon, { size: 18 }));
  assert.match(resized, /width="18" height="18"/);
  assert.match(resized, /stroke-width="1.5"/);
});
//#endregion

//#region presentational page
console.log("panel markup");
const now = Date.now();
const fixture = plugin.normalizeSnapshot({
  mode: "auto",
  engine: { available: true, name: "Microsoft Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
  sessions: [
    {
      id: "visible-1",
      visible: true,
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
      title: "JavaScript | MDN",
      status: "ready",
      createdAt: now - 120000,
      updatedAt: now - 30000,
      lastAction: "read",
    },
    {
      id: "hidden-2",
      visible: false,
      url: "https://html.duckduckgo.com/html/?q=playwright+core",
      title: "playwright core at DuckDuckGo",
      status: "busy",
      createdAt: now - 60000,
      updatedAt: now - 12000,
      lastAction: "search",
    },
    {
      id: "visible-3",
      visible: true,
      url: "https://example.com",
      title: "Example Domain",
      status: "launching",
      createdAt: now - 4000,
      updatedAt: now - 4000,
      lastAction: "launch",
    },
  ],
  activity: [
    { id: "a1", at: now - 2000, kind: "search", visible: false, title: "playwright core", detail: "DuckDuckGo · 6 результатов", url: "https://html.duckduckgo.com/html/?q=playwright+core", status: "ok" },
    { id: "a2", at: now - 12000, kind: "open", visible: true, title: "Example Domain", detail: "domcontentloaded", url: "https://example.com", status: "ok" },
    { id: "a3", at: now - 25000, kind: "read", visible: true, title: "JavaScript | MDN", detail: "12 480 символов", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript", status: "ok" },
    { id: "a4", at: now - 41000, kind: "screenshot", visible: false, title: "playwright-core docs", detail: ".dsh-browser/screenshots/2026-11-11-052145.png", status: "ok" },
    { id: "a5", at: now - 54000, kind: "mode", visible: false, title: "Режим: авто", detail: "Обновлён профиль", status: "ok" },
    { id: "a6", at: now - 70000, kind: "error", visible: false, title: "Не удалось открыть страницу", detail: "net::ERR_NAME_NOT_RESOLVED", url: "https://broken.invalid", status: "error" },
    { id: "a7", at: now - 92000, kind: "auto-close", visible: false, title: "Скрытая сессия закрыта", detail: "простой 45 с", status: "ok" },
    { id: "a8", at: now - 130000, kind: "close", visible: true, title: "Example Domain", detail: "Закрыт сеанс visible-3", status: "ok" },
  ],
});
const noop = () => {};
const ruBinder = plugin.createBinder(plugin.dictionaries.ru);
const viewProps = {
  t: ruBinder,
  mode: "auto",
  snapshot: fixture,
  phase: "ready",
  loadError: "",
  actionError: "",
  savingMode: false,
  onSelectMode: noop,
  onRefresh: noop,
  onRetry: noop,
  onCloseSession: noop,
  onCloseAll: noop,
  onClearActivity: noop,
};
const markup = renderToStaticMarkup(React.createElement(plugin.BrowserPageView, viewProps));

await check("renders header, mode switch, status, sessions and activity in Russian", () => {
  for (const needle of [
    "Агентский браузер",
    "Поиск в сети и просмотр страниц",
    "Режим браузера",
    "Авто",
    "Показывать всё",
    "Агент сам решает",
    "Движок",
    "Microsoft Edge",
    "Сеансы",
    "JavaScript | MDN",
    "Скрыто",
    "Видно",
    "Активность",
    "Очистить",
    "Закрыть все",
    "Скрытая сессия закроется после простоя",
    "Поиск",
    "Автозакрытие",
    "Скрытые сеансы закрываются автоматически",
  ]) {
    assert.ok(markup.includes(needle), "missing text: " + needle);
  }
});
await check("mode control is a pressed segmented group with two options", () => {
  assert.match(markup, /role="group" aria-label="Режим браузера"/);
  assert.equal((markup.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((markup.match(/aria-pressed="false"/g) || []).length, 1);
  assert.match(markup, /class="dshb-segmentButton dshb-segmentButtonActive" aria-pressed="true">Авто</);
});
await check("sessions expose badges, close buttons and the close-all action", () => {
  assert.equal((markup.match(/aria-label="Закрыть: /g) || []).length, 3);
  assert.equal((markup.match(/class="dshb-badge dshb-badgeHidden"/g) || []).length, 1);
  assert.equal((markup.match(/class="dshb-badge dshb-badgeVisible"/g) || []).length, 2);
  assert.ok(markup.includes(">Сеансы<"));
  assert.match(markup, />Закрыть все</);
});
await check("activity rows show HH:MM:SS times and error colouring", () => {
  assert.ok((markup.match(/class="dshb-time"/g) || []).length >= 8);
  assert.match(markup, /\d{2}:\d{2}:\d{2}/);
  assert.match(markup, /dshb-activityRow dshb-activityError/);
});
await check("activity rows suppress a label that repeats the kind verb", () => {
  const duplicateFixture = plugin.normalizeSnapshot({
    mode: "auto",
    engine: { available: true, name: "Microsoft Edge" },
    sessions: [],
    activity: [
      // Defensive case: a legacy/future record whose title is the verb itself.
      { id: "dup-close", at: now, kind: "close", visible: false, title: "Закрытие", detail: "", status: "ok" },
      { id: "dup-search", at: now - 1000, kind: "search", visible: false, title: "Поиск", detail: "", status: "ok" },
    ],
  });
  const duplicateMarkup = renderToStaticMarkup(
    React.createElement(plugin.BrowserPageView, { ...viewProps, snapshot: duplicateFixture }),
  );
  assert.ok(!duplicateMarkup.includes('title="Закрытие"'), "close label must not repeat the kind");
  assert.ok(!duplicateMarkup.includes('title="Поиск"'), "search label must not repeat the kind");
  assert.equal((duplicateMarkup.match(/class="dshb-activityTitle"/g) || []).length, 0, "both labels must be suppressed");
  assert.equal((duplicateMarkup.match(/>Закрытие</g) || []).length, 1, "the kind verb still renders exactly once");
  assert.equal((duplicateMarkup.match(/>Поиск</g) || []).length, 1, "the kind verb still renders exactly once");
});
await check("no raw locale keys leak into the markup", () => {
  for (const key of ["mode.auto", "sessions.hidden", "activity.clear", "status.engine", "page.title"]) {
    assert.ok(!markup.includes(key), "raw key rendered: " + key);
  }
});
await check("English binder localizes the same panel", () => {
  const enMarkup = renderToStaticMarkup(
    React.createElement(plugin.BrowserPageView, { ...viewProps, t: plugin.createBinder(plugin.dictionaries.en) }),
  );
  for (const needle of ["Agent browser", "Browser mode", "Always visible", "Sessions", "Activity", "Hidden", "Visible", "Close all"]) {
    assert.ok(enMarkup.includes(needle), "missing en text: " + needle);
  }
  assert.ok(!enMarkup.includes("Режим браузера"));
});
await check("empty state renders both hints and disables Clear", () => {
  const emptyMarkup = renderToStaticMarkup(
    React.createElement(plugin.BrowserPageView, {
      ...viewProps,
      snapshot: plugin.normalizeSnapshot({ mode: "auto", engine: { available: false }, sessions: [], activity: [] }),
    }),
  );
  assert.ok(emptyMarkup.includes("Пока ничего не открывалось."));
  assert.ok(emptyMarkup.includes("Попросите агента найти что-нибудь в сети."));
  assert.ok(emptyMarkup.includes("Здесь появятся действия агента в браузере."));
  assert.match(emptyMarkup, /class="dshb-textButton" disabled=""/);
  assert.ok(emptyMarkup.includes("Не найден"));
});
await check("error state offers Retry and loading state shows the spinner text", () => {
  const errorMarkup = renderToStaticMarkup(
    React.createElement(plugin.BrowserPageView, { ...viewProps, snapshot: null, phase: "error", loadError: "HTTP 503" }),
  );
  assert.ok(errorMarkup.includes("Не удалось получить состояние"));
  assert.ok(errorMarkup.includes("Повторить"));
  assert.match(errorMarkup, /role="alert"/);
  const loadingMarkup = renderToStaticMarkup(
    React.createElement(plugin.BrowserPageView, { ...viewProps, snapshot: null, phase: "loading" }),
  );
  assert.ok(loadingMarkup.includes("Загрузка…"));
  assert.match(loadingMarkup, /dshb-spinner/);
});
//#endregion

//#region optimistic mode + http contract
console.log("mode switch + http");
await check("mode POST targets the plugin route with a JSON body", async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ mode: "visible" }), json: async () => ({ mode: "visible" }) };
  };
  const response = await plugin.createApi(fakeFetch).setMode("visible");
  assert.deepEqual(response, { mode: "visible" });
  assert.equal(captured.url, "/plugins/dsh-browser/mode");
  assert.equal(captured.init.method, "POST");
  assert.deepEqual(JSON.parse(captured.init.body), { mode: "visible" });
  assert.equal(captured.init.headers["content-type"], "application/json");
});
await check("getState polls /state with no-store and close/clear map to their routes", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  };
  const api = plugin.createApi(fakeFetch);
  await api.getState();
  await api.closeSession("hidden-2");
  await api.closeAll();
  await api.clearActivity();
  assert.equal(calls[0].url, "/plugins/dsh-browser/state");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[1].url, "/plugins/dsh-browser/close");
  assert.deepEqual(JSON.parse(calls[1].init.body), { sessionId: "hidden-2" });
  assert.deepEqual(JSON.parse(calls[2].init.body), { all: true });
  assert.equal(calls[3].url, "/plugins/dsh-browser/clear");
});
await check("mode change is optimistic and confirmed by the server", async () => {
  const modes = [];
  const savings = [];
  const errors = [];
  const final = await plugin.runModeChange({
    api: { setMode: async (mode) => ({ mode }) },
    from: "auto",
    to: "visible",
    onMode: (mode) => modes.push(mode),
    onSaving: (saving) => savings.push(saving),
    onError: (error) => errors.push(error),
  });
  assert.equal(final, "visible");
  assert.deepEqual(modes, ["visible", "visible"]);
  assert.deepEqual(savings, [true, false]);
  assert.deepEqual(errors, [null]);
});
await check("failed mode change rolls back and reports the error", async () => {
  const modes = [];
  const errors = [];
  const final = await plugin.runModeChange({
    api: { setMode: () => Promise.reject(new Error("HTTP 500")) },
    from: "auto",
    to: "visible",
    onMode: (mode) => modes.push(mode),
    onSaving: () => {},
    onError: (error) => errors.push(error),
  });
  assert.equal(final, "auto");
  assert.deepEqual(modes, ["visible", "auto"]);
  assert.equal(errors[0], null, "starting the switch clears the previous error");
  assert.equal(errors.length, 2);
  assert.equal(errors[1].message, "HTTP 500");
});
//#endregion

//#region polling
console.log("polling");
await check("polls only while visible, stops on hide, aborts on stop", async () => {
  const listeners = new Map();
  const fakeDoc = {
    visibilityState: "visible",
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  let requests = 0;
  let aborts = 0;
  const pending = [];
  const fakeFetch = (url, init) => {
    requests += 1;
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject, init });
      const signal = init && init.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          aborts += 1;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
    });
  };
  const states = [];
  const errors = [];
  const poller = plugin.createPollController({
    fetchImpl: fakeFetch,
    documentRef: fakeDoc,
    intervalMs: 15,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });

  fakeDoc.visibilityState = "hidden";
  poller.start();
  await sleep(40);
  assert.equal(requests, 0, "must not poll while the tab is hidden");

  fakeDoc.visibilityState = "visible";
  listeners.get("visibilitychange")();
  await sleep(10);
  assert.equal(requests, 1, "visibilitychange must resume polling");

  pending[0].resolve({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ mode: "auto", engine: { available: true, name: "Microsoft Edge" }, sessions: [], activity: [], updatedAt: Date.now() }),
  });
  await sleep(10);
  assert.equal(states.length, 1);
  assert.equal(states[0].mode, "auto");
  assert.equal(states[0].engine.name, "Microsoft Edge");

  await sleep(30);
  assert.ok(requests >= 2, "poll interval must fire again");
  assert.equal(listeners.size, 1);

  // Hiding the tab mid-request aborts it and stops the loop.
  fakeDoc.visibilityState = "hidden";
  listeners.get("visibilitychange")();
  assert.ok(aborts >= 1, "hiding the tab must abort the in-flight request");
  const requestsWhileHidden = requests;
  await sleep(40);
  assert.equal(requests, requestsWhileHidden, "no requests while hidden");

  // Coming back re-arms the loop; stop() then aborts and unsubscribes.
  fakeDoc.visibilityState = "visible";
  listeners.get("visibilitychange")();
  await sleep(10);
  assert.ok(requests > requestsWhileHidden, "visible tab resumes polling");

  poller.stop();
  assert.ok(aborts >= 2, "stop() must abort the in-flight request");
  const requestsAtStop = requests;
  await sleep(40);
  assert.equal(requests, requestsAtStop, "no requests after stop()");
  assert.equal(listeners.size, 0, "visibility listener must be removed");
  assert.equal(errors.length, 0, "abort must not surface as a polling error");
  assert.equal(plugin.pollIntervalMs, 2000);
});
//#endregion

//#region styles
console.log("styles");
await check("injects the single style element and uses token vars with fallbacks only", async () => {
  const appended = [];
  const byId = new Map();
  const fakeDocument = {
    visibilityState: "visible",
    head: {
      appendChild(element) {
        appended.push(element);
        byId.set(element.id, element);
      },
    },
    getElementById(id) {
      return byId.has(id) ? byId.get(id) : null;
    },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), id: "", textContent: "" };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const previousDocument = Object.prototype.hasOwnProperty.call(globalThis, "document") ? globalThis.document : undefined;
  globalThis.document = fakeDocument;

  Object.defineProperty(globalThis, "navigator", { value: { language: "ru-RU" }, configurable: true, writable: true });

  try {
    plugin.ensureStyles();
    plugin.ensureStyles();
    assert.equal(appended.length, 1, "style element must be inserted once");
    assert.equal(appended[0].id, "dsh-browser-styles");
    assert.ok(appended[0].textContent.includes(".dshb-root"));
    assert.ok(appended[0].textContent.includes("prefers-reduced-motion"));
    assert.ok(appended[0].textContent.includes(":focus-visible"));

    const panelMarkup = renderToStaticMarkup(React.createElement(plugin.BrowserPanel, {}));
    assert.ok(panelMarkup.includes("Агентский браузер"), "local binder must default to ru for ru-RU");
    assert.ok(panelMarkup.includes("Загрузка…"));
    assert.equal(appended.length, 1, "rendering the panel must not insert a second style tag");
    assert.equal(byId.size, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  const css = plugin.panelCss;
  const withoutFallback = css.match(/var\(--[a-z0-9-]+\)/g) || [];
  assert.deepEqual(withoutFallback, [], "every var() needs a fallback");
  const tokenNames = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
  assert.ok(tokenNames.length > 10);
  for (const name of tokenNames) {
    assert.ok(name.startsWith("--dsw-"), "non-design token used: " + name);
    assert.ok(ALLOWED_TOKENS.has(name), "token outside the contract allow-list: " + name);
  }
  assert.ok(!/url\(/.test(css), "no external assets");
  assert.ok(!/@import/.test(css));
  assert.ok(!/#[0-9a-fA-F]{3,8}\s*;?\s*}/.test(css), "no bare hex literal as a declaration value");
});
//#endregion

console.log("");
console.log("test-client: " + passed + " checks passed");
