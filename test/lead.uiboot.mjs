// UI 启动测试：用最小 DOM 垫片在 Node 里真正跑 bootApp()，验证主循环/面板/海图不崩。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');

const ctxProxy = new Proxy({ canvas: { width: 1280, height: 720 } }, {
  get(t, k) {
    if (k === 'canvas') return t.canvas;
    if (typeof k === 'symbol') return undefined;
    return () => ctxProxy;
  },
  set(t, k, v) { t[k] = v; return true; },
});
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [], childNodes: [],
    value: '', textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 120, width: 1280, height: 720,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } return c; },
    remove() {}, addEventListener() {}, removeEventListener() {}, focus() {}, click() { if (this.onclick) this.onclick({}); },
    getBoundingClientRect() { return { width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 }; },
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    getContext() { return ctxProxy; },
    get firstChild() { return this.children[0] || null; },
    set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick; },
  };
  return el;
}
const byId = new Map();
const bodyEl = makeEl('body');
function elFor(id) { const e = makeEl('div'); e.parentElement = bodyEl; return e; }
let rafCb = null;
globalThis.document = {
  getElementById(id) { if (!byId.has(id)) byId.set(id, elFor(id)); return byId.get(id); },
  createElement(tag) { return makeEl(tag); },
  querySelectorAll() { return []; },
  querySelector() { return makeEl('div'); },
  addEventListener() {},
  body: bodyEl,
};
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
globalThis.window = {
  devicePixelRatio: 1, addEventListener() {}, removeEventListener() {},
  requestAnimationFrame(cb) { rafCb = cb; return 1; },
  location: { protocol: 'http:', host: '127.0.0.1:8787' },
  __ironSeas: null,
};
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.location = window.location;
globalThis.prompt = () => '270';
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
globalThis.Blob = class { constructor(a) { this.a = a; } };
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.fetch = async (url) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\.\//, '');
  const full = path.join(R, p);
  if (!fs.existsSync(full)) return { ok: false, status: 404, json: async () => null };
  const txt = fs.readFileSync(full, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
};

const { bootApp } = await import('../src/ui/app.js');
const errors = [];
process.on('uncaughtException', (e) => { errors.push('uncaught: ' + e.message); });
bootApp();
await new Promise((r) => setTimeout(r, 120));
const state = globalThis.window.__ironSeas;
if (!state) { console.error('FAIL: bootApp 没有暴露 state'); process.exit(1); }
console.log('数据加载：舰级 ' + (state.db ? state.db.list.length : 0) + ' 条，剧本 ' + state.scenarios.length + ' 个');
if (!state.db || !state.db.list.length) { console.error('FAIL: 舰船数据库为空'); process.exit(1); }
const scen = state.scenarios.find((s) => s.id === 'denmark_strait_1941') || state.scenarios[0];
state.startScenario(scen);
console.log('剧本启动：' + scen.id + '，舰船 ' + state.world.ships.length + ' 艘');
state.timeScale = 64;
let frames = 0, t0 = Date.now();
for (let i = 0; i < 600; i++) {
  if (!rafCb) break;
  const cb = rafCb; rafCb = null;
  try { cb(performance.now() + i * 16); frames++; } catch (e) { errors.push('frame' + i + ': ' + e.message + ' @ ' + String(e.stack).split('\n')[1]); break; }
  if (i % 20 === 0) await new Promise((r) => setImmediate(r));
}
await new Promise((r) => setTimeout(r, 200));
const panes = [];
for (const id of ['p-ship', 'p-fire', 'p-dam', 'p-ai', 'p-intel']) {
  try { state.forcedPaneId = id; state.renderPanes(true); panes.push(id + '=' + (byId.get(id) ? byId.get(id).innerHTML.length : 0)); } catch (e) { panes.push(id + '=ERR:' + e.message); errors.push('pane ' + id + ': ' + e.message); }
}
state.forcedPaneId = null;
const logLen = byId.get('log') ? byId.get('log').children.length : 0;
console.log('帧数 ' + frames + '，仿真时间 ' + state.world.t.toFixed(0) + 's，墙钟 ' + (Date.now() - t0) + 'ms');
console.log('面板渲染字符数：' + panes.join(' '));
console.log('日志行数 ' + logLen + '，航迹 ' + state.world.tracks.tracks.length + '，事件 ' + state.world.events.history.length);
// 交互路径：选中舰船 + 选中航迹 + 各面板重渲染
try {
  const own = state.world.shipsOf('ALLIED')[0];
  state.selectedShipId = own.id;
  const st = state.world.visibleStateFor('ALLIED');
  state.selectedTrackId = st.tracks.length ? st.tracks[0].id : null;
  state.renderPanes();
  console.log('交互路径 OK：选定 ' + own.name + '，航迹 ' + (state.selectedTrackId || '无'));
  console.log('损管面板片段：' + (byId.get('p-dam').innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
  console.log('火控面板片段：' + (byId.get('p-fire').innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
} catch (e) { errors.push('interaction: ' + e.message); }
console.log(errors.length ? ('发现 ' + errors.length + ' 个运行时错误：\n  ' + errors.slice(0, 8).join('\n  ')) : '没有运行时错误 ✓');
process.exit(errors.length ? 2 : 0);
