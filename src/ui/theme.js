// 主题系统 —— 单一事实来源是 index.html 里的 :root[data-theme="paper"|"dark"] 自定义属性。
// 这个模块只做三件事：
//   1) 读写/切换主题（持久化到 localStorage，切换后广播事件）；
//   2) 给 canvas 提供调色板 chartPalette()：从 CSS 变量读颜色，缓存到主题变化为止；
//   3) 提供 alpha() —— canvas 里大量颜色需要带可变透明度，不能写死 rgba 字面量。
//
// 约定：src/render/** 与 src/ui/** 里画布相关的颜色一律通过 chartPalette() 取，
// 不得再出现 #rrggbb / rgba(...) 字面量（alpha() 除外）。这样"纸面 / 夜间"两套主题
// 在 canvas 上自动生效，换皮只需要改 index.html 一处。

export const THEME_ATTR = "data-theme";
export const THEME_KEY = "ironseas_theme";
export const DEFAULT_THEME = "paper";
// 五套主题：纸面（默认）/ 海图（方案 A：图廓 + 宋体 + 直角）/ 印刷（方案 B：双色油墨）/ 夜间 / 高对比（无障碍）
export const THEMES = ["paper", "chart", "riso", "dark", "contrast"];
export const THEME_LABEL = { paper: "纸面", chart: "海图", riso: "印刷", dark: "夜间", contrast: "高对比" };

// key -> { var: CSS 自定义属性名, paper: 缺省值（CSS 未定义/未加载时的兜底） }
// 所有 key 都必须同时存在于 index.html 每一套主题块（paper/chart/riso/dark/contrast）里，
// 否则缺变量的主题会退回 paper 兜底色。
export const CHART_TOKENS = {
  // —— 海面 / 环境 ——
  seaTop:      { var: "--c-sea-top",      paper: "#f6efdd" },
  seaMid:      { var: "--c-sea-mid",      paper: "#f1e7d0" },
  seaBot:      { var: "--c-sea-bot",      paper: "#e7dbc0" },
  horizon:     { var: "--c-horizon",      paper: "#b9a373" },
  swell:       { var: "--c-swell",        paper: "#c9b992" },
  nightWash:   { var: "--c-night-wash",   paper: "#4a4130" },
  vignette:    { var: "--c-vignette",     paper: "#c3b394" },
  glare:       { var: "--c-glare",        paper: "#fffaf0" },

  // —— 陆地 / 水深 ——
  landA:       { var: "--c-land-a",       paper: "#e3d6b6" },
  landB:       { var: "--c-land-b",       paper: "#d6c69f" },
  landLine:    { var: "--c-land-line",    paper: "#8d7550" },
  shore:       { var: "--c-shore",        paper: "#a98f63" },
  // 等深带填色的整体浓度：夜间需要压暗海面，纸面要留住"米白纸"的亮，所以纸面调低
  depthAlphaScale: { var: "--c-depth-a-scale", paper: "0.35" },
  depthShallow:{ var: "--c-depth-shallow",paper: "#b09a6e" },
  depthMid:    { var: "--c-depth-mid",    paper: "#9d8760" },
  depthDeep:   { var: "--c-depth-deep",   paper: "#8a7550" },
  depth:       { var: "--c-depth",        paper: "#c4b18a" },
  depthStrong: { var: "--c-depth-strong", paper: "#a9926a" },
  depthText:   { var: "--c-depth-text",   paper: "#9d8863" },

  // —— 经纬网 ——
  grid:        { var: "--c-grid",         paper: "#6b5b3f" },
  gridStrong:  { var: "--c-grid-strong",  paper: "#6b5b3f" },
  gridAlpha:      { var: "--c-grid-a",        paper: "0.10" },
  gridAlphaStrong:{ var: "--c-grid-a-strong", paper: "0.22" },
  gridText:    { var: "--c-grid-text",    paper: "#9d8863" },

  // —— 墨水 / 文字 ——
  ink:         { var: "--c-ink",          paper: "#2c2519" },
  inkDim:      { var: "--c-ink-dim",      paper: "#6b5b3f" },
  inkFaint:    { var: "--c-ink-faint",    paper: "rgba(90,76,52,.5)" },

  // —— 双方兵力 ——
  allied:      { var: "--c-allied",       paper: "#2f5d7c" },
  axis:        { var: "--c-axis",         paper: "#a8402f" },
  unknown:     { var: "--c-unknown",      paper: "#7d7259" },
  nationUs:    { var: "--c-nation-us",    paper: "#2f5d7c" },
  nationUk:    { var: "--c-nation-uk",    paper: "#3f6b46" },
  nationJp:    { var: "--c-nation-jp",    paper: "#a8402f" },
  nationDe:    { var: "--c-nation-de",    paper: "#8a5a12" },
  nationIt:    { var: "--c-nation-it",    paper: "#6b4a7a" },
  nationFr:    { var: "--c-nation-fr",    paper: "#3a6b7a" },
  ownTrack:    { var: "--c-track-own",    paper: "#2f5d7c" },
  enemyTrack:  { var: "--c-track-enemy",  paper: "#a8402f" },
  uncertain:   { var: "--c-uncertain",    paper: "#8a7a56" },
  wake:        { var: "--c-wake",         paper: "rgba(120,105,75,.45)" },
  select:      { var: "--c-select",       paper: "#8a5a12" },

  // —— 版式风格开关（数值/字符串，不是颜色）——
  hatch:       { var: "--c-hatch",        paper: "#6b5b3f" },  // 陆地斜线填充色（印刷主题用）
  hatchAlpha:  { var: "--c-hatch-a",      paper: "0" },        // >0 才画斜线
  frameAlpha:  { var: "--c-frame-a",      paper: "0" },        // >0 才画图廓刻度（海图主题）
  depthDash:   { var: "--c-depth-dash",   paper: "0" },        // 1 = 等深线用虚线
  fontLabels:  { var: "--c-label-font",   paper: "mono" },     // 海图标注字族："mono" | "serif"

  // —— 效果 ——
  fire:        { var: "--c-fire",         paper: "#c0562a" },
  fireGlow:    { var: "--c-fire-glow",    paper: "#e0a05a" },
  smoke:       { var: "--c-smoke",        paper: "#8d8471" },
  light:       { var: "--c-light",        paper: "#e8c46a" },
  splash:      { var: "--c-splash",       paper: "#a99a78" },
  damage:      { var: "--c-damage",       paper: "#a8342a" },
};

let _cache = null;
let _cacheKey = "";
let _revision = 0;
const _listeners = new Set();

function doc() {
  return typeof document !== "undefined" ? document : null;
}

/** 读取 CSS 自定义属性（去空白）；拿不到时返回空串。 */
export function readToken(name) {
  const d = doc();
  if (!d || !d.documentElement || typeof getComputedStyle !== "function") return "";
  try {
    return String(getComputedStyle(d.documentElement).getPropertyValue(name) || "").trim();
  } catch (e) {
    return "";
  }
}

/** #rgb / #rrggbb / rgb(a) 一律转成 rgba(r,g,b,a)；无法解析时原样返回。 */
export function alpha(color, a) {
  const c = String(color || "").trim();
  const k = a === undefined ? 1 : a;
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) {
    const h = m[1];
    return "rgba(" + parseInt(h[0] + h[0], 16) + "," + parseInt(h[1] + h[1], 16) + "," + parseInt(h[2] + h[2], 16) + "," + k + ")";
  }
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) {
    const h = m[1];
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + k + ")";
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(",").map((x) => x.trim());
    if (p.length >= 3) return "rgba(" + p[0] + "," + p[1] + "," + p[2] + "," + k + ")";
  }
  return c;
}

/**
 * 画布调色板。每个 key 对应一个 CSS 变量；主题变化或缓存失效时重新读取。
 * 返回值额外带 alpha() 与 theme 字段，调用方可以直接 `const P = pal(); P.alpha(P.ink, .3)`。
 */
export function chartPalette() {
  const theme = getTheme();
  const key = theme + "|" + _revision;
  if (_cache && _cacheKey === key) return _cache;
  const p = { theme: theme, alpha: alpha };
  for (const name of Object.keys(CHART_TOKENS)) {
    const spec = CHART_TOKENS[name];
    p[name] = readToken(spec.var) || spec.paper;
  }
  _cache = p;
  _cacheKey = key;
  return p;
}

export function getTheme() {
  const d = doc();
  const attr = d && d.documentElement ? d.documentElement.getAttribute(THEME_ATTR) : null;
  return THEMES.indexOf(attr) >= 0 ? attr : DEFAULT_THEME;
}

export function setTheme(name, opts) {
  const next = THEMES.indexOf(name) >= 0 ? name : DEFAULT_THEME;
  const d = doc();
  if (d && d.documentElement) d.documentElement.setAttribute(THEME_ATTR, next);
  if (!opts || opts.persist !== false) {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式 */ }
  }
  _revision += 1;
  _cache = null;
  _cacheKey = "";
  // 顶栏四段主题按钮：点哪个就是哪个，当前项高亮（不用循环猜）
  if (d && d.querySelectorAll) {
    for (const b of d.querySelectorAll("[data-theme-id]")) {
      const on = b.getAttribute("data-theme-id") === next;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  // 兼容旧的单按钮形态（若存在）
  const btn = d && d.getElementById ? d.getElementById("btnTheme") : null;
  if (btn) {
    btn.textContent = THEME_LABEL[next] || next;
    btn.title = "界面主题：" + (THEME_LABEL[next] || next) + "（Shift+T 循环切换）";
  }
  for (const cb of _listeners) { try { cb(next); } catch (e) { /* 单个监听器出错不影响其它 */ } }
  try { if (typeof window !== "undefined" && window.dispatchEvent && typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent("ironseas:theme", { detail: { theme: next } })); } catch (e) { /* 无 window */ }
  return next;
}

export function toggleTheme() {
  return setTheme(getTheme() === "paper" ? "dark" : "paper");
}

/** Shift+T：纸面 → 海图 → 印刷 → 夜间 → 高对比 循环。 */
export function cycleTheme() {
  const i = THEMES.indexOf(getTheme());
  return setTheme(THEMES[(i + 1) % THEMES.length]);
}

export function onThemeChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/** 启动时调用：恢复上次选择、绑定顶栏按钮（事件委托，按钮晚于本函数出现也能生效）。 */
export function initTheme() {
  let saved = "";
  try { if (typeof localStorage !== "undefined") saved = localStorage.getItem(THEME_KEY) || ""; } catch (e) { saved = ""; }
  setTheme(THEMES.indexOf(saved) >= 0 ? saved : DEFAULT_THEME, { persist: false });
  const d = doc();
  if (d && d.addEventListener) {
    d.addEventListener("click", (e) => {
      const t = e.target && e.target.closest ? e.target.closest("[data-theme-id], #btnTheme") : null;
      if (!t) return;
      e.preventDefault();
      const id = t.getAttribute("data-theme-id");
      if (id) setTheme(id); else toggleTheme();
    });
    d.addEventListener("keydown", (e) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (String(e.key || "").toLowerCase() !== "t") return;
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      cycleTheme();
    });
  }
  if (typeof window !== "undefined") window.__ironseasSetTheme = setTheme;
  return getTheme();
}
