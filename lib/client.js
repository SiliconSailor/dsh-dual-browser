window.__ModuleLoader__.load({
  // Must equal the package name: client-modules identifies the browser module
  // by the resolved package.json `name`, and a mismatch leaves the slot
  // unregistered while the server half keeps working.
  id: "dsh-dual-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const { useState, useEffect, useRef } = React;
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    //#region constants
    /** Locale namespace registered with the host (`ctx.locale.register`). */
    const LOCALE_NAMESPACE = "dshBrowser";
    /** Panel id shared by the sidebar row and the keyed `main` page. */
    const PANEL_ID = "dsh-browser";
    /** Base path of the plugin's Web routes (contract §8). */
    const API_BASE = "/plugins/dsh-browser";
    /** Live-state poll interval while the panel is mounted and the tab is visible. */
    const POLL_INTERVAL_MS = 2000;
    /** The panel keeps the most recent activity rows only. */
    const ACTIVITY_LIMIT = 20;
    /** Single `<style>` element id; inserted exactly once. */
    const STYLE_ID = "dsh-browser-styles";
    const SVG_STROKE = {
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    };
    //#endregion

    //#region locale dictionaries (contract §10.4)
    const ru = {
      "panel.title": "Браузер",
      "page.title": "Агентский браузер",
      "page.subtitle": "Поиск в сети и просмотр страниц — скрытно или на виду.",
      "mode.label": "Режим браузера",
      "mode.auto": "Авто",
      "mode.visible": "Показывать всё",
      "mode.auto.desc": "Агент сам решает: для собственных исследований открывает скрытый браузер, а по вашей просьбе — видимый.",
      "mode.visible.desc": "Каждое открытие браузера видно на экране — скрытые запуски отключены.",
      "mode.saving": "Сохраняем…",
      "mode.saveError": "Не удалось сохранить режим",
      "status.engine": "Движок",
      "status.sessions": "Сеансы",
      "status.ready": "Готов",
      "status.missing": "Не найден",
      "status.hiddenIdle": "Скрытая сессия закроется после простоя",
      "sessions.title": "Сеансы",
      "sessions.empty": "Пока ничего не открывалось.",
      "sessions.emptyHint": "Попросите агента найти что-нибудь в сети.",
      "sessions.hidden": "Скрыто",
      "sessions.visible": "Видно",
      "activity.title": "Активность",
      "activity.empty": "Здесь появятся действия агента в браузере.",
      "activity.clear": "Очистить",
      "action.close": "Закрыть",
      "action.closeAll": "Закрыть все",
      "action.refresh": "Обновить",
      "action.failed": "Не удалось выполнить действие",
      "state.loading": "Загрузка…",
      "state.error": "Не удалось получить состояние",
      "state.retry": "Повторить",
      "footer.note": "Скрытые сеансы закрываются автоматически после простоя. Переключатель действует на все сеансы.",
      "kind.launch": "Запуск",
      "kind.open": "Открытие",
      "kind.search": "Поиск",
      "kind.read": "Чтение",
      "kind.click": "Клик",
      "kind.type": "Ввод",
      "kind.screenshot": "Снимок",
      "kind.close": "Закрытие",
      "kind.auto-close": "Автозакрытие",
      "kind.error": "Ошибка",
      "kind.mode": "Режим",
    };
    const en = {
      "panel.title": "Browser",
      "page.title": "Agent browser",
      "page.subtitle": "Web search and page viewing — hidden or in plain sight.",
      "mode.label": "Browser mode",
      "mode.auto": "Auto",
      "mode.visible": "Always visible",
      "mode.auto.desc": "The agent decides: hidden for its own research, visible when you ask to watch.",
      "mode.visible.desc": "Every browser launch is on screen — hidden launches are off.",
      "mode.saving": "Saving…",
      "mode.saveError": "Could not save the mode",
      "status.engine": "Engine",
      "status.sessions": "Sessions",
      "status.ready": "Ready",
      "status.missing": "Not found",
      "status.hiddenIdle": "Hidden session closes when idle",
      "sessions.title": "Sessions",
      "sessions.empty": "Nothing opened yet.",
      "sessions.emptyHint": "Ask the agent to look something up.",
      "sessions.hidden": "Hidden",
      "sessions.visible": "Visible",
      "activity.title": "Activity",
      "activity.empty": "The agent's browser actions will appear here.",
      "activity.clear": "Clear",
      "action.close": "Close",
      "action.closeAll": "Close all",
      "action.refresh": "Refresh",
      "action.failed": "Action failed",
      "state.loading": "Loading…",
      "state.error": "Could not load state",
      "state.retry": "Retry",
      "footer.note": "Hidden sessions close automatically when idle. The switch applies to all sessions.",
      "kind.launch": "Launch",
      "kind.open": "Open",
      "kind.search": "Search",
      "kind.read": "Read",
      "kind.click": "Click",
      "kind.type": "Type",
      "kind.screenshot": "Screenshot",
      "kind.close": "Close",
      "kind.auto-close": "Auto-close",
      "kind.error": "Error",
      "kind.mode": "Mode",
    };
    const dictionaries = { ru, en };
    const KIND_KEYS = [
      "launch",
      "open",
      "search",
      "read",
      "click",
      "type",
      "screenshot",
      "close",
      "auto-close",
      "error",
      "mode",
    ];
    //#endregion

    //#region styles
    /** All panel styles in one constant; injected as `<style id="dsh-browser-styles">`. */
    const PANEL_CSS = `
.dshb-root{height:100%;min-height:100%;overflow:auto;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif);font-size:13px;line-height:20px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.dshb-root *{box-sizing:border-box}
.dshb-inner{max-width:880px;margin:0 auto;padding:24px 24px 40px;display:flex;flex-direction:column;gap:20px}
.dshb-header{display:flex;align-items:flex-start;gap:12px;min-width:0}
.dshb-logo{width:32px;height:32px;flex:none;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-primary,#0f1115);display:inline-flex;align-items:center;justify-content:center;margin-top:1px}
.dshb-headerText{flex:1 1 auto;min-width:0}
.dshb-title{margin:0;font-size:16px;font-weight:500;line-height:22px;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-subtitle{margin:2px 0 0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}
.dshb-headerActions{flex:none;display:flex;align-items:center;gap:2px;margin-top:2px}
.dshb-iconButton{width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#61666b);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshb-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-textButton{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:13px;line-height:18px;padding:5px 8px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.dshb-textButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-textButton:disabled{opacity:.4;cursor:default;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c)}
.dshb-card{background:var(--dsw-alias-bg-layer-1,#ffffff);border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12));border-radius:var(--dsw-radius-md,12px)}
.dshb-modeCard{padding:16px}
.dshb-modeHead{display:flex;align-items:center;gap:10px;min-width:0}
.dshb-modeLabel{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-saving{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dshb-saving:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary,#0f1115);opacity:.5;animation:dshb-pulse 1.1s ease-in-out infinite}
.dshb-segment{display:inline-flex;align-items:center;gap:2px;margin-top:10px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.08))}
.dshb-segmentButton{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:13px;line-height:18px;font-weight:400;padding:5px 14px;min-width:84px;border-radius:calc(var(--dsw-radius-sm,8px) - 2px);cursor:pointer;transition:background-color .12s ease,color .12s ease;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
.dshb-segmentButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-segmentButtonActive,.dshb-segmentButtonActive:hover{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-inverted,#ffffff);font-weight:500}
.dshb-modeDesc{margin:10px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b)}
.dshb-inlineError{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ec1313)}
.dshb-inlineError svg{flex:none}
.dshb-status{padding:4px 0}
.dshb-statusRow{display:flex;align-items:center;gap:8px;min-height:36px;padding:7px 16px;font-size:13px;line-height:20px}
.dshb-statusRow + .dshb-statusRow{border-top:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12))}
.dshb-statusLabel{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#61666b)}
.dshb-statusValue{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary,#0f1115);font-weight:500;text-align:right}
.dshb-statusNote{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:17px}
.dshb-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#81858c)}
.dshb-dotSuccess{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dshb-dotWarn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dshb-dotError{background:var(--dsw-alias-state-error-primary,#ec1313)}
.dshb-dotIdle{background:var(--dsw-alias-label-tertiary,#81858c)}
.dshb-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshb-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px;min-height:20px}
.dshb-sectionTitle{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-sectionMeta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c)}
.dshb-list{padding:2px 0;overflow:hidden}
.dshb-session{display:flex;align-items:center;gap:10px;padding:9px 10px 9px 16px;min-height:52px}
.dshb-session + .dshb-session{border-top:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12))}
.dshb-sessionBody{flex:1 1 auto;min-width:0}
.dshb-sessionTitle{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshb-sessionUrl{margin-top:2px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshb-badge{flex:none;font-size:12px;line-height:16px;padding:1px 7px;border-radius:999px;border:.5px solid transparent;white-space:nowrap}
.dshb-badgeHidden{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 74%,var(--dsw-alias-label-primary,#0f1115));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 30%,transparent)}
.dshb-badgeVisible{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 68%,var(--dsw-alias-label-primary,#0f1115));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 30%,transparent)}
.dshb-close{width:26px;height:26px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshb-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dshb-empty{padding:28px 16px 30px;text-align:center}
.dshb-emptyTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b)}
.dshb-emptyHint{margin-top:4px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c)}
.dshb-activity{padding:4px 0;overflow:hidden}
.dshb-activityRow{display:flex;align-items:flex-start;gap:12px;padding:8px 16px;font-size:13px;line-height:20px}
.dshb-activityRow + .dshb-activityRow{border-top:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.12))}
.dshb-time{flex:none;width:54px;padding-top:1px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums;letter-spacing:.01em}
.dshb-activityBody{flex:1 1 auto;min-width:0}
.dshb-activityLine{display:flex;align-items:baseline;gap:8px;min-width:0}
.dshb-kind{flex:none;font-size:12px;line-height:17px;font-weight:500;color:var(--dsw-alias-label-secondary,#61666b)}
.dshb-activityTitle{min-width:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshb-activityUrl{margin-top:2px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshb-activityDetail{margin-top:2px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dshb-activityError .dshb-kind,.dshb-activityError .dshb-activityTitle,.dshb-activityError .dshb-activityDetail{color:var(--dsw-alias-state-error-primary,#ec1313)}
.dshb-state{padding:36px 16px 40px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.dshb-stateIcon{color:var(--dsw-alias-state-error-primary,#ec1313);display:inline-flex}
.dshb-stateText{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b)}
.dshb-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3,rgba(15,17,21,.16));border-top-color:var(--dsw-alias-label-tertiary,#81858c);animation:dshb-spin .8s linear infinite}
.dshb-retry{border:.5px solid var(--dsw-alias-border-l3,rgba(15,17,21,.16));background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:13px;line-height:18px;padding:5px 14px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;transition:background-color .12s ease}
.dshb-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.dshb-footer{padding:0 2px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c)}
.dshb-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0f1115);outline-offset:2px}
@keyframes dshb-spin{to{transform:rotate(360deg)}}
@keyframes dshb-pulse{0%,100%{opacity:.35}50%{opacity:.9}}
@media (prefers-reduced-motion:reduce){.dshb-root *{transition:none!important;animation:none!important}.dshb-spinner{border-top-color:var(--dsw-alias-label-tertiary,#81858c)}}
@media (max-width:640px){.dshb-inner{padding:18px 16px 32px;gap:16px}.dshb-segmentButton{min-width:0;padding:5px 12px}}
`;
    /** Insert the panel stylesheet once; safe to call from render and from tests. */
    function ensureStyles() {
      if (typeof document === "undefined" || document === null) return null;
      const existing = typeof document.getElementById === "function" ? document.getElementById(STYLE_ID) : null;
      if (existing !== null && existing !== undefined) return existing;
      if (typeof document.createElement !== "function") return null;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      const parent = document.head || document.body || null;
      if (parent !== null && typeof parent.appendChild === "function") parent.appendChild(style);
      return style;
    }
    //#endregion

    //#region icons
    /** Panel glyph: a globe in currentColor, sized by the caller (16px in the sidebar). */
    function BrowserIcon(props) {
      const size = props && typeof props.size === "number" && props.size > 0 ? props.size : 16;
      const active = props ? props.active === true : false;
      return jsxs("svg", {
        width: String(size),
        height: String(size),
        viewBox: "0 0 16 16",
        "aria-hidden": "true",
        focusable: "false",
        ...SVG_STROKE,
        strokeWidth: active ? 1.7 : 1.5,
        children: [
          jsx("circle", { cx: "8", cy: "8", r: "6.25" }),
          jsx("path", { d: "M1.75 8h12.5" }),
          jsx("path", { d: "M8 1.75c1.82 1.7 2.85 3.94 2.85 6.25S9.82 12.55 8 14.25C6.18 12.55 5.15 10.32 5.15 8S6.18 3.45 8 1.75Z" }),
        ],
      });
    }

    function IconRefresh16() {
      return jsxs("svg", {
        width: "16",
        height: "16",
        viewBox: "0 0 16 16",
        "aria-hidden": "true",
        focusable: "false",
        ...SVG_STROKE,
        children: [
          jsx("path", { d: "M2.75 8a5.25 5.25 0 0 1 10.5 0" }),
          jsx("path", { d: "M10.55 5.55 13.1 8l-2.55 2.45" }),
          jsx("path", { d: "M13.25 8a5.25 5.25 0 0 1-10.5 0" }),
          jsx("path", { d: "M5.45 10.45 2.9 8l2.55-2.45" }),
        ],
      });
    }

    function IconClose12() {
      return jsx("svg", {
        width: "12",
        height: "12",
        viewBox: "0 0 12 12",
        "aria-hidden": "true",
        focusable: "false",
        ...SVG_STROKE,
        strokeWidth: 1.4,
        children: jsx("path", { d: "m2.75 2.75 6.5 6.5M9.25 2.75l-6.5 6.5" }),
      });
    }

    function IconWarning16(props) {
      const size = props && typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return jsxs("svg", {
        width: String(size),
        height: String(size),
        viewBox: "0 0 16 16",
        "aria-hidden": "true",
        focusable: "false",
        ...SVG_STROKE,
        children: [
          jsx("path", { d: "M7.03 2.2 1.4 12.1a1.1 1.1 0 0 0 .96 1.65h11.28a1.1 1.1 0 0 0 .96-1.65L8.97 2.2a1.12 1.12 0 0 0-1.94 0Z" }),
          jsx("path", { d: "M8 6v3.1" }),
          jsx("path", { d: "M8 11.65v.1" }),
        ],
      });
    }
    //#endregion

    //#region translation
    function createBinder(dict) {
      return function t(key, params) {
        const raw = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
        if (typeof raw !== "string") return key;
        if (!params) return raw;
        return raw.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
      };
    }

    function detectLocale() {
      let language = "";
      try {
        if (typeof navigator !== "undefined" && navigator && typeof navigator.language === "string") language = navigator.language;
      } catch (error) {
        language = "";
      }
      return /^ru/i.test(language) ? "ru" : "en";
    }

    function resolveT(t) {
      return typeof t === "function" ? t : createBinder(dictionaries[detectLocale()]);
    }
    //#endregion

    //#region data helpers
    function normalizeMode(value) {
      if (value === "visible") return "visible";
      if (value === "auto") return "auto";
      return null;
    }

    function normalizeSnapshot(raw) {
      if (!raw || typeof raw !== "object") throw new Error("dsh-browser: invalid state payload");
      const engine = raw.engine && typeof raw.engine === "object" ? raw.engine : {};
      const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter((row) => row && typeof row === "object") : [];
      const activity = Array.isArray(raw.activity) ? raw.activity.filter((row) => row && typeof row === "object") : [];
      return {
        mode: normalizeMode(raw.mode) || "auto",
        engine: {
          available: engine.available === true,
          name: typeof engine.name === "string" ? engine.name : "",
          path: typeof engine.path === "string" ? engine.path : "",
        },
        sessions,
        activity,
        updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : Date.now(),
      };
    }

    function activeSessions(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.sessions)) return [];
      return snapshot.sessions.filter((session) => session.status !== "closed");
    }

    function hiddenActive(snapshot) {
      return activeSessions(snapshot).some((session) => session.visible === false);
    }

    function hostOf(url) {
      if (typeof url !== "string" || url === "") return "";
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch (error) {
        return "";
      }
    }

    function pad2(value) {
      return value < 10 ? "0" + value : String(value);
    }

    function formatClock(at) {
      const date = new Date(typeof at === "number" ? at : Number(at));
      if (Number.isNaN(date.getTime())) return "--:--:--";
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    }

    function sessionDotClass(status) {
      if (status === "launching") return "dshb-dot dshb-dotWarn";
      if (status === "error") return "dshb-dot dshb-dotError";
      if (status === "closed") return "dshb-dot dshb-dotIdle";
      if (status === "ready" || status === "busy") return "dshb-dot dshb-dotSuccess";
      return "dshb-dot dshb-dotIdle";
    }

    function engineLabel(t, engine) {
      if (!engine || engine.available !== true) return t("status.missing");
      const name = typeof engine.name === "string" ? engine.name.trim() : "";
      return name !== "" ? name : t("status.ready");
    }

    function errorMessage(error) {
      if (!error) return "";
      if (typeof error === "string") return error;
      if (typeof error.message === "string") return error.message;
      return String(error);
    }
    //#endregion

    //#region http + polling
    async function requestJson(fetchImpl, url, init) {
      if (typeof fetchImpl !== "function") throw new Error("dsh-browser: fetch is unavailable");
      const response = await fetchImpl(url, init);
      if (!response || response.ok !== true) {
        let detail = "";
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") detail = payload.error;
        } catch (error) {
          detail = "";
        }
        throw new Error(detail !== "" ? detail : "HTTP " + (response ? response.status : "?"));
      }
      if (response.status === 204) return null;
      const text = await response.text();
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error("dsh-browser: invalid JSON response");
      }
    }

    function createApi(fetchImpl) {
      const jsonHeaders = { accept: "application/json" };
      const postHeaders = { accept: "application/json", "content-type": "application/json" };
      return {
        getState(signal) {
          return requestJson(fetchImpl, API_BASE + "/state", { method: "GET", headers: jsonHeaders, cache: "no-store", signal });
        },
        setMode(mode, signal) {
          return requestJson(fetchImpl, API_BASE + "/mode", { method: "POST", headers: postHeaders, body: JSON.stringify({ mode }), signal });
        },
        closeSession(sessionId, signal) {
          return requestJson(fetchImpl, API_BASE + "/close", { method: "POST", headers: postHeaders, body: JSON.stringify({ sessionId }), signal });
        },
        closeAll(signal) {
          return requestJson(fetchImpl, API_BASE + "/close", { method: "POST", headers: postHeaders, body: JSON.stringify({ all: true }), signal });
        },
        clearActivity(signal) {
          return requestJson(fetchImpl, API_BASE + "/clear", { method: "POST", headers: postHeaders, body: JSON.stringify({}), signal });
        },
      };
    }

    /**
     * Poll the live state while the document is visible. Holds one AbortController;
     * a new load, a hidden tab, and stop() all abort the in-flight request.
     */
    function createPollController(options) {
      const doc = options.documentRef || null;
      const fetchImpl = options.fetchImpl;
      const intervalMs = typeof options.intervalMs === "number" && options.intervalMs > 0 ? options.intervalMs : POLL_INTERVAL_MS;
      const api = createApi(fetchImpl);
      let timer = null;
      let controller = null;
      let stopped = true;
      let started = false;

      function isVisible() {
        if (!doc) return true;
        if (typeof doc.visibilityState !== "string") return true;
        return doc.visibilityState === "visible";
      }
      function clearTimer() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
      function abort() {
        if (controller !== null) {
          try {
            controller.abort();
          } catch (error) {
            /* already aborted */
          }
          controller = null;
        }
      }
      function onVisibility() {
        if (stopped) return;
        if (!isVisible()) {
          clearTimer();
          abort();
          return;
        }
        refresh();
      }
      async function load() {
        if (stopped || !isVisible()) return;
        abort();
        const local = typeof AbortController === "function" ? new AbortController() : null;
        controller = local;
        try {
          const raw = await api.getState(local ? local.signal : undefined);
          if (stopped) return;
          if (controller === local) controller = null;
          options.onState(normalizeSnapshot(raw));
        } catch (error) {
          if (stopped) return;
          if (controller === local) controller = null;
          if (error && (error.name === "AbortError" || error.code === 20)) return;
          options.onError(error);
        }
      }
      function schedule() {
        clearTimer();
        if (stopped || !isVisible()) return;
        timer = setTimeout(() => {
          timer = null;
          load().then(schedule, schedule);
        }, intervalMs);
      }
      function refresh() {
        abort();
        clearTimer();
        const pending = load().then(
          () => {
            schedule();
          },
          () => {
            schedule();
          },
        );
        return pending;
      }
      function start() {
        if (!stopped) return;
        stopped = false;
        started = true;
        if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility);
        refresh();
      }
      function stop() {
        stopped = true;
        started = false;
        clearTimer();
        abort();
        if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibility);
      }
      return {
        start,
        stop,
        refresh,
        isVisible,
        isStarted: () => started,
      };
    }

    /**
     * Optimistic mode switch: render the new mode immediately, confirm with the
     * server, and roll back to the previous one when the POST fails.
     * Exported so the harness can prove the rollback without a DOM.
     */
    function runModeChange(options) {
      const api = options.api;
      const from = options.from;
      const to = options.to;
      const onMode = options.onMode;
      const onSaving = options.onSaving;
      const onError = options.onError;
      if (onSaving) onSaving(true);
      if (onError) onError(null);
      if (onMode) onMode(to);
      return api
        .setMode(to)
        .then((result) => {
          const confirmed = normalizeMode(result && result.mode) || to;
          if (onMode) onMode(confirmed);
          return confirmed;
        })
        .catch((error) => {
          if (onMode) onMode(from);
          if (onError) onError(error);
          return from;
        })
        .then((value) => {
          if (onSaving) onSaving(false);
          return value;
        });
    }
    //#endregion

    //#region pure views
    function SectionHead(props) {
      return jsxs("div", {
        className: "dshb-sectionHead",
        children: [
          jsx("h2", { className: "dshb-sectionTitle", children: props.title }),
          props.action ? props.action : props.meta ? jsx("span", { className: "dshb-sectionMeta", children: props.meta }) : null,
        ],
      });
    }

    function SessionRow(props) {
      const t = props.t;
      const session = props.session;
      const label = session.title || hostOf(session.url) || session.url || session.id || "—";
      const hidden = session.visible !== true;
      return jsxs("div", {
        className: "dshb-session",
        children: [
          jsx("span", { className: sessionDotClass(session.status), "aria-hidden": "true" }),
          jsxs("div", {
            className: "dshb-sessionBody",
            children: [
              jsx("div", { className: "dshb-sessionTitle", title: label, children: label }),
              typeof session.url === "string" && session.url !== "" ? jsx("div", { className: "dshb-sessionUrl", title: session.url, children: session.url }) : null,
            ],
          }),
          jsx("span", {
            className: "dshb-badge " + (hidden ? "dshb-badgeHidden" : "dshb-badgeVisible"),
            children: hidden ? t("sessions.hidden") : t("sessions.visible"),
          }),
          jsx("button", {
            type: "button",
            className: "dshb-close",
            title: t("action.close"),
            "aria-label": t("action.close") + ": " + label,
            onClick: () => props.onCloseSession(session.id),
            children: jsx(IconClose12, {}),
          }),
        ],
      });
    }

    function ActivityRow(props) {
      const t = props.t;
      const entry = props.entry;
      const kind = typeof entry.kind === "string" ? entry.kind : "";
      const kindText = KIND_KEYS.indexOf(kind) >= 0 ? t("kind." + kind) : kind;
      const title = typeof entry.title === "string" ? entry.title : "";
      const detail = typeof entry.detail === "string" && entry.detail !== title ? entry.detail : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const label = title !== "" ? title : hostOf(url);
      const failed = entry.status === "error" || kind === "error";
      return jsxs("div", {
        className: "dshb-activityRow" + (failed ? " dshb-activityError" : ""),
        children: [
          jsx("time", { className: "dshb-time", dateTime: Number.isFinite(Number(entry.at)) ? new Date(Number(entry.at)).toISOString() : undefined, children: formatClock(entry.at) }),
          jsxs("div", {
            className: "dshb-activityBody",
            children: [
              jsxs("div", {
                className: "dshb-activityLine",
                children: [
                  jsx("span", { className: "dshb-kind", children: kindText }),
                  label !== "" && label !== kindText ? jsx("span", { className: "dshb-activityTitle", title: label, children: label }) : null,
                ],
              }),
              url !== "" ? jsx("div", { className: "dshb-activityUrl", title: url, children: url }) : null,
              detail !== "" ? jsx("div", { className: "dshb-activityDetail", children: detail }) : null,
            ],
          }),
        ],
      });
    }

    /** Presentational page; the stateful wrapper below feeds it live data. */
    function BrowserPageView(props) {
      const t = props.t;
      const phase = props.phase || "ready";
      const snapshot = props.snapshot || null;
      const mode = props.mode === "visible" ? "visible" : "auto";
      const sessions = activeSessions(snapshot);
      const activity = snapshot && Array.isArray(snapshot.activity)
        ? snapshot.activity
            .slice()
            .sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0))
            .slice(0, ACTIVITY_LIMIT)
        : [];
      const engine = snapshot ? snapshot.engine : null;
      const engineReady = engine !== null && engine.available === true;

      const modeButton = (value, label) =>
        jsx("button", {
          type: "button",
          className: "dshb-segmentButton" + (mode === value ? " dshb-segmentButtonActive" : ""),
          "aria-pressed": mode === value,
          onClick: () => props.onSelectMode(value),
          children: label,
        });

      const header = jsxs("div", {
        className: "dshb-header",
        children: [
          jsx("span", { className: "dshb-logo", "aria-hidden": "true", children: jsx(BrowserIcon, { size: 20, active: true }) }),
          jsxs("div", {
            className: "dshb-headerText",
            children: [
              jsx("h1", { className: "dshb-title", children: t("page.title") }),
              jsx("p", { className: "dshb-subtitle", children: t("page.subtitle") }),
            ],
          }),
          jsxs("div", {
            className: "dshb-headerActions",
            children: [
              jsx("button", {
                type: "button",
                className: "dshb-iconButton",
                title: t("action.refresh"),
                "aria-label": t("action.refresh"),
                onClick: () => props.onRefresh(),
                children: jsx(IconRefresh16, {}),
              }),
              sessions.length > 0
                ? jsx("button", {
                    type: "button",
                    className: "dshb-textButton",
                    onClick: () => props.onCloseAll(),
                    children: t("action.closeAll"),
                  })
                : null,
            ],
          }),
        ],
      });

      if (phase === "loading") {
        return jsx("div", {
          className: "dshb-root",
          children: jsxs("div", {
            className: "dshb-inner",
            children: [
              header,
              jsxs("div", {
                className: "dshb-card dshb-state",
                role: "status",
                children: [
                  jsx("span", { className: "dshb-spinner", "aria-hidden": "true" }),
                  jsx("span", { className: "dshb-stateText", children: t("state.loading") }),
                ],
              }),
            ],
          }),
        });
      }

      if (phase === "error") {
        return jsx("div", {
          className: "dshb-root",
          children: jsxs("div", {
            className: "dshb-inner",
            children: [
              header,
              jsxs("div", {
                className: "dshb-card dshb-state",
                role: "alert",
                title: props.loadError || undefined,
                children: [
                  jsx("span", { className: "dshb-stateIcon", "aria-hidden": "true", children: jsx(IconWarning16, { size: 20 }) }),
                  jsx("span", { className: "dshb-stateText", children: t("state.error") }),
                  jsx("button", { type: "button", className: "dshb-retry", onClick: () => props.onRetry(), children: t("state.retry") }),
                ],
              }),
            ],
          }),
        });
      }

      const modeCard = jsxs("section", {
        className: "dshb-card dshb-modeCard",
        "aria-label": t("mode.label"),
        "aria-busy": props.savingMode === true ? "true" : undefined,
        children: [
          jsxs("div", {
            className: "dshb-modeHead",
            children: [
              jsx("span", { className: "dshb-modeLabel", children: t("mode.label") }),
              props.savingMode === true ? jsx("span", { className: "dshb-saving", role: "status", children: t("mode.saving") }) : null,
            ],
          }),
          jsxs("div", {
            className: "dshb-segment",
            role: "group",
            "aria-label": t("mode.label"),
            children: [modeButton("auto", t("mode.auto")), modeButton("visible", t("mode.visible"))],
          }),
          jsx("p", { className: "dshb-modeDesc", children: t(mode === "visible" ? "mode.visible.desc" : "mode.auto.desc") }),
          props.actionError
            ? jsxs("div", {
                className: "dshb-inlineError",
                role: "alert",
                children: [jsx(IconWarning16, { size: 14 }), jsx("span", { children: props.actionError })],
              })
            : null,
        ],
      });

      const statusRows = [
        jsxs(
          "div",
          {
            className: "dshb-statusRow",
            children: [
              jsx("span", { className: "dshb-statusLabel", children: t("status.engine") }),
              jsxs("span", {
                className: "dshb-statusValue",
                children: [
                  jsx("span", { className: engineReady ? "dshb-dot dshb-dotSuccess" : "dshb-dot dshb-dotError", "aria-hidden": "true" }),
                  jsx("span", { title: engine && engine.path ? engine.path : undefined, children: engineLabel(t, engine) }),
                ],
              }),
            ],
          },
          "status-engine",
        ),
        jsxs(
          "div",
          {
            className: "dshb-statusRow",
            children: [
              jsx("span", { className: "dshb-statusLabel", children: t("status.sessions") }),
              jsx("span", { className: "dshb-statusValue", children: String(sessions.length) }),
            ],
          },
          "status-sessions",
        ),
      ];
      if (hiddenActive(snapshot)) {
        statusRows.push(
          jsxs(
            "div",
            {
              className: "dshb-statusRow",
              children: [
                jsx("span", { className: "dshb-dot dshb-dotWarn", "aria-hidden": "true" }),
                jsx("span", { className: "dshb-statusNote", children: t("status.hiddenIdle") }),
              ],
            },
            "status-hidden-idle",
          ),
        );
      }
      const statusCard = jsx("section", { className: "dshb-card dshb-status", children: statusRows });

      const sessionsCard = jsxs("div", {
        className: "dshb-section",
        children: [
          jsx(SectionHead, { title: t("sessions.title") }),
          sessions.length === 0
            ? jsxs("div", {
                className: "dshb-card dshb-empty",
                children: [
                  jsx("div", { className: "dshb-emptyTitle", children: t("sessions.empty") }),
                  jsx("div", { className: "dshb-emptyHint", children: t("sessions.emptyHint") }),
                ],
              })
            : jsx("div", {
                className: "dshb-card dshb-list",
                children: sessions.map((session, index) =>
                  jsx(SessionRow, {
                    t,
                    session,
                    onCloseSession: props.onCloseSession,
                  }, String(session.id || index)),
                ),
              }),
        ],
      });

      const activityCard = jsxs("div", {
        className: "dshb-section",
        children: [
          jsx(SectionHead, {
            title: t("activity.title"),
            action: jsx("button", {
              type: "button",
              className: "dshb-textButton",
              onClick: () => props.onClearActivity(),
              disabled: activity.length === 0,
              children: t("activity.clear"),
            }),
          }),
          activity.length === 0
            ? jsx("div", { className: "dshb-card dshb-empty", children: jsx("div", { className: "dshb-emptyTitle", children: t("activity.empty") }) })
            : jsx("div", {
                className: "dshb-card dshb-activity",
                children: activity.map((entry, index) => jsx(ActivityRow, { t, entry }, String(entry.id || "row-" + index))),
              }),
        ],
      });

      return jsx("div", {
        className: "dshb-root",
        children: jsxs("div", {
          className: "dshb-inner",
          children: [header, modeCard, statusCard, sessionsCard, activityCard, jsx("div", { className: "dshb-footer", children: t("footer.note") })],
        }),
      });
    }
    //#endregion

    //#region stateful panel
    /** Live panel: polls `/state`, owns the optimistic mode switch and the action calls. */
    function BrowserPanel(props) {
      ensureStyles();
      const t = resolveT(props && props.t);
      const tRef = useRef(t);
      tRef.current = t;

      const [snapshot, setSnapshot] = useState(null);
      const [mode, setMode] = useState("auto");
      const [phase, setPhase] = useState("loading");
      const [loadError, setLoadError] = useState("");
      const [actionError, setActionError] = useState("");
      const [savingMode, setSavingMode] = useState(false);

      const pollRef = useRef(null);
      const savingRef = useRef(false);
      const hasDataRef = useRef(false);

      useEffect(() => {
        const fetchImpl = typeof fetch === "function" ? fetch : null;
        const poller = createPollController({
          fetchImpl,
          documentRef: typeof document !== "undefined" ? document : null,
          intervalMs: POLL_INTERVAL_MS,
          onState: (next) => {
            hasDataRef.current = true;
            setSnapshot(next);
            setPhase("ready");
            setLoadError("");
            if (!savingRef.current) setMode(next.mode);
          },
          onError: (error) => {
            if (hasDataRef.current) return;
            setPhase("error");
            setLoadError(errorMessage(error));
          },
        });
        pollRef.current = poller;
        poller.start();
        return () => {
          poller.stop();
          pollRef.current = null;
        };
      }, []);

      const refresh = () => {
        const poller = pollRef.current;
        if (!poller) return;
        if (!hasDataRef.current) setPhase("loading");
        setLoadError("");
        poller.refresh();
      };

      const selectMode = (next) => {
        const normalized = normalizeMode(next);
        if (!normalized || normalized === mode || savingRef.current) return;
        savingRef.current = true;
        const api = createApi(typeof fetch === "function" ? fetch : null);
        runModeChange({
          api,
          from: mode,
          to: normalized,
          onMode: (value) => setMode(value),
          onSaving: (saving) => setSavingMode(saving),
          onError: (error) => {
            setActionError(error ? tRef.current("mode.saveError") : "");
          },
        }).then(() => {
          savingRef.current = false;
          const poller = pollRef.current;
          if (poller) poller.refresh();
        });
      };

      const closeSession = (sessionId) => {
        if (!sessionId) return;
        setActionError("");
        const api = createApi(typeof fetch === "function" ? fetch : null);
        api
          .closeSession(sessionId)
          .catch(() => setActionError(tRef.current("action.failed")))
          .then(() => {
            const poller = pollRef.current;
            if (poller) poller.refresh();
          });
      };

      const closeAll = () => {
        setActionError("");
        const api = createApi(typeof fetch === "function" ? fetch : null);
        api
          .closeAll()
          .catch(() => setActionError(tRef.current("action.failed")))
          .then(() => {
            const poller = pollRef.current;
            if (poller) poller.refresh();
          });
      };

      const clearActivity = () => {
        setActionError("");
        setSnapshot((previous) => (previous ? { ...previous, activity: [] } : previous));
        const api = createApi(typeof fetch === "function" ? fetch : null);
        api.clearActivity().catch(() => {
          setActionError(tRef.current("action.failed"));
          const poller = pollRef.current;
          if (poller) poller.refresh();
        });
      };

      return jsx(BrowserPageView, {
        t,
        mode,
        snapshot,
        phase,
        loadError,
        actionError,
        savingMode,
        onSelectMode: selectMode,
        onRefresh: refresh,
        onRetry: refresh,
        onCloseSession: closeSession,
        onCloseAll: closeAll,
        onClearActivity: clearActivity,
      });
    }
    //#endregion

    //#region plugin entry
    /** Services the client half needs from the host. */
    const inject = ["slots", "locale", "layout"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { ru, en }), "dsh-browser: dictionaries");
      const t = ctx.locale.bind(LOCALE_NAMESPACE);
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 20,
            label: () => t("panel.title"),
            locale: LOCALE_NAMESPACE,
          },
          BrowserIcon,
        ),
      );
      ctx.slots.inject("main", () =>
        ctx.slots.register(
          {
            name: "main",
            key: PANEL_ID,
            locale: LOCALE_NAMESPACE,
          },
          BrowserPanel,
        ),
      );
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    // Test/preview hooks: the same component and strings the host renders.
    exports.BrowserIcon = BrowserIcon;
    exports.BrowserPanel = BrowserPanel;
    exports.BrowserPageView = BrowserPageView;
    exports.dictionaries = dictionaries;
    exports.createBinder = createBinder;
    exports.createApi = createApi;
    exports.createPollController = createPollController;
    exports.normalizeSnapshot = normalizeSnapshot;
    exports.runModeChange = runModeChange;
    exports.ensureStyles = ensureStyles;
    exports.panelCss = PANEL_CSS;
    exports.styleId = STYLE_ID;
    exports.localeNamespace = LOCALE_NAMESPACE;
    exports.panelId = PANEL_ID;
    exports.pollIntervalMs = POLL_INTERVAL_MS;
    return module.exports;
  },
});
