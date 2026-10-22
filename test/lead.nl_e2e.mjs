// 端到端模拟：在输入框打字 → 点"发送命令" → 看世界是否收到命令
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const ctxProxy = new Proxy({ canvas: { width: 1280, height: 720 } }, { get(t2, k) { if (k === 'canvas') return t2.canvas; if (typeof k === 'symbol') return undefined; return () => ctxProxy; }, set(t2, k, v) { t2[k] = v; return true; } });
function makeEl(tag) {
  const el = { tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [], childNodes: [], value: '', textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 120, width: 1280, height: 720,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; }, removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } return c; }, remove() {}, addEventListener() {}, removeEventListener() {}, focus() {}, click() { if (this.onclick) this.onclick({}); },
    getBoundingClientRect() { return { width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 }; }, querySelector() { return makeEl('div'); }, querySelectorAll() { return []; }, getContext() { return ctxProxy; },
    get firstChild() { return this.children[0] || null; }, set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick; } };
  return el;
}
const byId = new Map(); const bodyEl = makeEl('body');
globalThis.document = { getElementById(id) { if (!byId.has(id)) { const e = makeEl('div'); e.parentElement = bodyEl; byId.set(id, e); } return byId.get(id); }, createElement(tag) { return makeEl(tag); }, querySelectorAll() { return []; }, querySelector() { return makeEl('div'); }, addEventListener() {}, body: bodyEl };
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 1; }, location: { protocol: 'http:', host: '127.0.0.1:8787' }, __ironSeas: null };
globalThis.requestAnimationFrame = () => 1; globalThis.location = window.location; globalThis.prompt = () => '270';
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
globalThis.Blob = class {}; globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.fetch = async (url) => { const p = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\.\//, ''); const full = path.join(R, p); if (!fs.existsSync(full)) return { ok: false, status: 404, json: async () => null }; return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(full, 'utf8')) }; };
const { bootApp } = await import('../src/ui/app.js');
bootApp();
await new Promise((r) => setTimeout(r, 120));
const state = globalThis.window.__ironSeas;
state.startScenario(state.scenarios.find((s) => s.id === 'sandbox'), { mode: 'PLAY', side: 'ALLIED' });
const w = state.world;
state.selectedShipId = w.shipsOf('ALLIED')[0].id;
state.forcedPaneId = 'p-ai'; state.renderPanes(true);
const box = byId.get('aichat');
console.log('输入框存在: ' + !!box);
const before = w.commands.length;
for (const phrase of ['全队转向 240，24 节', '向最近的敌舰开火', '放烟幕']) {
  box.value = phrase;
  const n0 = w.commands.length;
  state.doAction('ai-send', null, { dataset: {} });
  await new Promise((r) => setTimeout(r, 30));
  const added = w.commands.slice(n0);
  console.log('  "' + phrase + '" → 新增 ' + added.length + ' 条命令：' + added.map((c) => c.kind + (c.shipId ? '@' + c.shipId : '') + '(scope=' + (c.scope || '-') + ')').join('、'));
}
console.log('总计新增 ' + (w.commands.length - before) + ' 条');
const eff = w.events.history.filter((e) => e.type === 'order.effective').length;
console.log('命令生效事件 ' + eff + ' 条');
w.advance(40);
console.log('推进 40s 后：' + w.shipsOf('ALLIED').map((s) => s.name + ' 指令航向' + Math.round(s.commanded.heading) + ' 速度' + s.commanded.speed.toFixed(0)).join(' | '));
