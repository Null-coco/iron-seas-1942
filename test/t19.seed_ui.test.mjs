#!/usr/bin/env node
// T19 随机种子 UI：菜单控件（随机/默认/手填）→ 开局 world.seed 确实被改变
//
// 用最小 DOM 垫片真实跑 bootApp()，验证的是"用户点的那个按钮"而不是内部函数：
//   · 剧本菜单渲染出 seedInput + 「随机种子」「改用默认」两个按钮；
//   · 点随机 → 输入框变成数字，state.seedOverride 同步；
//   · 点改用默认 → 清空，回落剧本默认；
//   · 填 123456789 再点剧本 → world.seed === 123456789；
//   · 留空点剧本 → 19420604（剧本默认）；
//   · 切观战/换阵营重开 → 沿用当前局种子（看的是同一场战局）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');

// ── 最小 DOM 垫片（与 test/lead.uiboot.mjs 同一套思路）──
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
function elFor() { const e = makeEl('div'); e.parentElement = bodyEl; return e; }
globalThis.document = {
  getElementById(id) { if (!byId.has(id)) byId.set(id, elFor()); return byId.get(id); },
  createElement(tag) { return makeEl(tag); },
  querySelectorAll() { return []; }, querySelector() { return makeEl('div'); },
  addEventListener() {}, body: bodyEl,
};
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
globalThis.window = {
  devicePixelRatio: 1, addEventListener() {}, removeEventListener() {},
  requestAnimationFrame(cb) { return 1; }, location: { protocol: 'http:', host: '127.0.0.1:8787', search: '' }, __ironSeas: null,
};
globalThis.requestAnimationFrame = () => 1;
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
bootApp();
await new Promise((r) => setTimeout(r, 150));
const state = globalThis.window.__ironSeas;
assert.ok(state && state.doAction, 'bootApp 应暴露 state.doAction 测试钩子');
const $ = (id) => document.getElementById(id);

test('剧本菜单渲染出随机种子控件（输入框 + 随机 + 改用默认）', () => {
  state.showScenarios();
  const html = $('overlayCard').innerHTML;
  assert.ok(html.includes('id="seedInput"'), '菜单应含种子输入框');
  assert.ok(html.includes('data-act="seed-random"'), '菜单应含「随机种子」按钮');
  assert.ok(html.includes('data-act="seed-default"'), '菜单应含「改用默认」按钮');
  assert.ok(html.includes('同种子可复现'), '应有复现说明');
});

test('点「随机种子」写入输入框并同步 seedOverride；「改用默认」清空', () => {
  state.showScenarios();
  const inp = $('seedInput');
  inp.value = '';
  state.doAction('seed-random');
  assert.match(String(inp.value), /^\d+$/, '随机后输入框应是数字');
  assert.equal(state.seedOverride, Number(inp.value), 'seedOverride 应等于输入框值');
  state.doAction('seed-default');
  assert.equal(inp.value, '', '改用默认后输入框应清空');
  assert.equal(state.seedOverride, null, '改用默认后 seedOverride 应为 null');
});

test('按输入种子开局：world.seed 与输入一致；留空则用剧本默认', () => {
  state.showScenarios();
  const inp = $('seedInput');
  inp.value = '123456789';
  state.doAction('start-scen', 'denmark_strait_1941');
  assert.ok(state.world, '应已开局');
  assert.equal(state.world.seed, 123456789, 'world.seed 应等于手填种子');

  // 第二局：清空输入 → 剧本默认
  state.showScenarios();
  inp.value = '';
  state.doAction('start-scen', 'denmark_strait_1941');
  assert.equal(state.world.seed, 19420604, '留空应回落到默认种子 19420604');
});

test('非法种子被拒绝且不误开局（保持原战局）', () => {
  state.showScenarios();
  const inp = $('seedInput');
  inp.value = '-5';
  const before = state.world && state.world.seed;
  state.doAction('start-scen', 'denmark_strait_1941');
  assert.equal(state.world.seed, before, '负种子应被拒绝，战局不变');
});

test('切观战/换阵营重开沿用当前种子（同一场战局）', () => {
  state.showScenarios();
  const inp = $('seedInput');
  inp.value = '31415926';
  state.doAction('start-scen', 'denmark_strait_1941');
  assert.equal(state.world.seed, 31415926);
  // 切观战：不显式传种子 → 沿用当前局
  state.startScenario(state.world.scenario, { mode: 'SPECTATE' });
  assert.equal(state.world.seed, 31415926, '切观战不应换种子');
  // 换阵营重开：同样沿用
  state.startScenario(state.world.scenario, { mode: 'PLAY', side: 'AXIS' });
  assert.equal(state.world.seed, 31415926, '换阵营不应换种子');
});
