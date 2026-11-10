/**
 * Render the real dsh-browser panel markup + stylesheet into a standalone HTML
 * file and screenshot it with the system Edge in headless mode.
 *
 * Output: dsh-browser/_preview/panel.html and dsh-browser/_preview/panel.png (1200x1400).
 * Run: node dsh-browser/scripts/preview-panel.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const previewDir = path.join(root, "_preview");
const bundlePath = path.join(root, "lib", "client.js");
const htmlPath = path.join(previewDir, "panel.html");
const pngPath = path.join(previewDir, "panel.png");

const EDGE_CANDIDATES = [
  process.env.DSH_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Load the bundle exactly like the host loader does.
const registrations = [];
const fakeWindow = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
new Function("window", fs.readFileSync(bundlePath, "utf8"))(fakeWindow);
if (registrations.length !== 1) throw new Error("client bundle did not register exactly one factory");
const plugin = registrations[0].factory((id) => {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return jsxRuntime;
  throw new Error("unexpected require: " + id);
});

const now = Date.now();
const snapshot = plugin.normalizeSnapshot({
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
    {
      id: "a1",
      at: now - 2000,
      kind: "search",
      visible: false,
      title: "playwright core",
      detail: "DuckDuckGo · 6 результатов",
      url: "https://html.duckduckgo.com/html/?q=playwright+core",
      status: "ok",
    },
    {
      id: "a2",
      at: now - 12000,
      kind: "open",
      visible: true,
      title: "Example Domain",
      detail: "domcontentloaded",
      url: "https://example.com",
      status: "ok",
    },
    {
      id: "a3",
      at: now - 25000,
      kind: "read",
      visible: true,
      title: "JavaScript | MDN",
      detail: "12 480 символов",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
      status: "ok",
    },
    {
      id: "a4",
      at: now - 41000,
      kind: "screenshot",
      visible: false,
      title: "playwright-core docs",
      detail: ".dsh-browser/screenshots/2026-11-11-052145.png",
      status: "ok",
    },
    {
      id: "a5",
      at: now - 54000,
      kind: "mode",
      visible: false,
      title: "Переключено на «Авто»",
      detail: "Обновлён профиль",
      status: "ok",
    },
    {
      id: "a6",
      at: now - 70000,
      kind: "error",
      visible: false,
      title: "Не удалось открыть страницу",
      detail: "net::ERR_NAME_NOT_RESOLVED",
      url: "https://broken.invalid",
      status: "error",
    },
    {
      id: "a7",
      at: now - 92000,
      kind: "auto-close",
      visible: false,
      title: "Скрытая сессия закрыта",
      detail: "простой 45 с",
      status: "ok",
    },
    {
      id: "a8",
      at: now - 130000,
      kind: "click",
      visible: true,
      title: "Документация Playwright",
      detail: "a[href=\"/docs/api/class-browser\"]",
      url: "https://playwright.dev/docs/api/class-browser",
      status: "ok",
    },
    {
      id: "a9",
      at: now - 150000,
      kind: "launch",
      visible: false,
      title: "Скрытый браузер запущен",
      detail: "Chromium · headless",
      status: "ok",
    },
    {
      id: "a10",
      at: now - 170000,
      kind: "close",
      visible: true,
      title: "Example Domain",
      detail: "Закрыт сеанс visible-3",
      url: "https://example.com",
      status: "ok",
    },
  ],
});

const t = plugin.createBinder(plugin.dictionaries.ru);
const noop = () => {};
const markup = renderToStaticMarkup(
  React.createElement(plugin.BrowserPageView, {
    t,
    mode: "auto",
    snapshot,
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
  }),
);

// The preview page is deliberately theme-less: it proves the CSS fallbacks and
// mirrors the light DSH surfaces closely enough for a visual review.
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-browser · panel preview</title>
<style>html,body{margin:0;height:100%;background:#ffffff}#app{height:100%}</style>
<style id="${plugin.styleId}">${plugin.panelCss}</style>
</head>
<body>
<div id="app">${markup}</div>
</body>
</html>
`;

fs.mkdirSync(previewDir, { recursive: true });
fs.writeFileSync(htmlPath, html, "utf8");

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const executablePath = findBrowser();
if (!executablePath) throw new Error("no Chromium-based browser found for the preview screenshot");
console.log("preview: writing html " + htmlPath);
console.log("preview: launching " + executablePath);

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
  await page.waitForTimeout(200);
  const bodyHeight = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    panelWidth: document.querySelector(".dshb-inner") ? document.querySelector(".dshb-inner").getBoundingClientRect().width : 0,
    panelHeight: document.querySelector(".dshb-inner") ? document.querySelector(".dshb-inner").getBoundingClientRect().height : 0,
    header: !!document.querySelector(".dshb-title"),
    segment: document.querySelectorAll(".dshb-segmentButton").length,
    sessions: document.querySelectorAll(".dshb-session").length,
    activity: document.querySelectorAll(".dshb-activityRow").length,
  }));
  await page.screenshot({ path: pngPath, type: "png" });
  const size = pngSize(pngPath);
  console.log("preview: panel content " + JSON.stringify(bodyHeight));
  console.log("preview: wrote " + pngPath + " (" + (size ? size.width + "x" + size.height : "?") + ", " + fs.statSync(pngPath).size + " bytes)");
  if (bodyHeight.scrollHeight > 1400) console.warn("preview: content is taller than the 1400px viewport (scrollHeight=" + bodyHeight.scrollHeight + ")");
  if (bodyHeight.header !== true || bodyHeight.segment !== 2 || bodyHeight.sessions !== 3 || bodyHeight.activity !== 10) {
    throw new Error("preview sanity check failed: " + JSON.stringify(bodyHeight));
  }
  if (!size || size.width !== 1200 || size.height !== 1400) throw new Error("unexpected screenshot size");
} finally {
  await browser.close();
}
