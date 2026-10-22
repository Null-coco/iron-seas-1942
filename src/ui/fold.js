// 统一的"窗口收起"机制 —— 海图上的浮窗、侧栏里的每一张卡，都能收起来，
// 收起状态记在 localStorage.ironseas_fold，刷新 / 换剧本 / 面板重建后自动恢复。
//
// 设计取舍：不去改 app.js 与 panels.js 的既有渲染逻辑，而是"接管"：
//   · 任务卡、指挥台、信号日志、侧栏本来就有收起控件 → 只补上持久化；
//   · 战况条与侧栏里的每张卡没有收起控件 → 动态注入一个；
//   · 侧栏内容由 panels.js 高频重建 → 用 MutationObserver 在重建后重新接管。
// 这样收起功能只依赖"容器 + 标题"的形状，不会和面板刷新机制打架。

const KEY = "ironseas_fold";
const OBSERVED = { root: null, timer: null };

// 已有收起控件的窗口：id -> 既有按钮选择器 + 读取"当前是否已收起"的方法
const LEGACY = [
  { id: "mission", btn: '#mission em[data-act="mission-fold"]', get: () => hasClass("#mission", "folded") },
  { id: "dock", btn: "#btnDockToggle", get: () => hasClass("#dock", "collapsed") },
  { id: "log", btn: "#logToggle", get: () => hasClass("#logWrap", "open") },
  { id: "side", btn: "#btnSideToggle", get: () => hasClass("#app", "side-hidden") },
];

let state = {};
try { if (typeof localStorage !== "undefined") state = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { state = {}; }
function save() {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式 */ }
}

function doc() { return typeof document !== "undefined" ? document : null; }
function $(sel) { const d = doc(); return d && d.querySelector ? d.querySelector(sel) : null; }
function hasClass(sel, cls) { const el = $(sel); return !!(el && el.classList && el.classList.contains(cls)); }
function folded(id) { return !!state[id]; }

export function isFolded(id) { return folded(id); }
export function setFolded(id, on, opts) {
  state[id] = !!on;
  if (!opts || opts.persist !== false) save();
  applyAll();
}

function chevron() {
  const s = doc().createElement("span");
  s.className = "chev";
  s.setAttribute("aria-hidden", "true");
  return s;
}
function makeBtn(id, label) {
  const d = doc();
  const b = d.createElement("button");
  b.type = "button";
  b.className = "foldBtn";
  b.dataset.foldBtn = id;
  b.appendChild(chevron());
  b.title = label || "收起 / 展开";
  b.setAttribute("aria-label", b.title);
  return b;
}
function paint(btn, on) {
  if (!btn) return;
  btn.classList.toggle("folded", !!on);
  btn.setAttribute("aria-expanded", on ? "false" : "true");
}

// ---------- 注入式：战况条 ----------
function scanBattlebar() {
  const el = $("#battlebar");
  if (!el || !el.classList) return;
  let btn = el.querySelector('[data-fold-btn="battlebar"]');
  if (!btn) {
    btn = makeBtn("battlebar", "收起 / 展开战况条");
    btn.addEventListener("click", (e) => { e.stopPropagation(); setFolded("battlebar", !folded("battlebar")); });
    el.appendChild(btn);
  }
  const on = folded("battlebar");
  el.classList.toggle("folded", on);
  paint(btn, on);
}

// ---------- 注入式：侧栏里的每一张卡 ----------
function cardKey(el) {
  const head = el.querySelector(":scope > h4");
  const pane = el.closest ? el.closest(".pane") : null;
  const title = head ? String(head.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24) : "card";
  return "card:" + ((pane && pane.id) || "?") + ":" + title;
}
function scanCards(root) {
  const host = root || doc();
  if (!host || !host.querySelectorAll) return;
  for (const el of host.querySelectorAll(".card")) {
    const head = el.querySelector(":scope > h4");
    if (!head) continue;
    const key = cardKey(el);
    let btn = head.querySelector(":scope > .foldBtn");
    if (!btn) {
      btn = makeBtn(key, "收起 / 展开这张卡");
      btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); setFolded(key, !folded(key)); });
      head.appendChild(btn);
    }
    const on = folded(key);
    el.classList.toggle("folded", on);
    paint(btn, on);
  }
}

// ---------- 已有控件的窗口：接管 + 恢复状态 ----------
function adoptLegacy() {
  for (const it of LEGACY) {
    const btn = $(it.btn);
    if (!btn || btn.dataset.foldAdopted === "1") continue;
    btn.dataset.foldAdopted = "1";
    btn.addEventListener("click", () => {
      // 先让应用自己的处理器跑完，再记录结果状态
      setTimeout(() => { state[it.id] = it.get(); save(); }, 0);
    }, true);
  }
}
function restoreLegacy() {
  for (const it of LEGACY) {
    const btn = $(it.btn);
    if (!btn) continue;
    const want = state[it.id];
    if (want === undefined) continue;
    if (want !== it.get()) btn.click();   // 交给应用自己的收起逻辑，避免复制一份状态机
  }
}

function applyAll() {
  try {
    scanBattlebar();
    scanCards();
    adoptLegacy();
  } catch (e) { /* 收起失败不能拖垮界面 */ }
}

/** 启动时调用一次；之后面板重建会自动重新接管。 */
export function initFold() {
  const d = doc();
  if (!d) return;
  applyAll();
  restoreLegacy();
  applyAll();
  if (OBSERVED.root || typeof MutationObserver !== "function") return;
  const target = d.getElementById("app") || d.body;
  if (!target) return;
  OBSERVED.root = new MutationObserver(() => {
    if (OBSERVED.timer) return;
    OBSERVED.timer = setTimeout(() => { OBSERVED.timer = null; applyAll(); }, 60);
  });
  OBSERVED.root.observe(target, { childList: true, subtree: true });
  // 换剧本会重建海图浮窗
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("ironseas:scenario", () => setTimeout(applyAll, 30));
  }
}

if (typeof window !== "undefined") window.__ironseasFold = { isFolded, setFolded, initFold };
