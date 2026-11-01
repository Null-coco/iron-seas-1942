#!/usr/bin/env node
// T23 回放分析器：把一份回放 JSON 变成可核对的战报（数字、发现、检查规则）
//
// 背景：sandbox_custom seed=604 暴露的"友军鱼雷击沉旗舰"是一份典型复盘素材。
// 人工逐条读 5,600 条事件不现实，所以把分析过程固化成 tools/replay-analyzer.mjs：
//   analyzeReplay() 只读事件 → 结构化模型；renderText/Markdown/Html 出报告；checkReplay() 做回归断言。
//
// 本测试用一份**合成回放**锁住口径（不依赖任何外部文件）：
//   1) 射击/命中/鱼雷/伤亡统计 = 事件计数，不重算物理；
//   2) 友军鱼雷、唯一沉没、殉爆、静默、判型漂移、重复碰撞都能被识别；
//   3) --check 规则：有友军鱼雷 / 超长静默 / 判型漂移 → 不通过；干净回放 → 通过；
//   4) text/markdown/html 三种渲染都包含关键结论，HTML 内联 SVG 且无外链。
//
// 运行：node test/t23.replay_analyzer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { analyzeReplay, checkReplay, fmtClock } from '../tools/analyzer/core.mjs';
import { renderText, renderMarkdown, renderHtml } from '../tools/analyzer/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 合成回放：2v2，轴心 X1 被僚舰 X2 的鱼雷打成殉爆 ─────────────────────────
function baseReplay() {
  const ev = [];
  let seq = 0;
  const E = (o) => { ev.push(Object.assign({ seq: ++seq }, o)); return o; };
  const snap = (t, list) => ({
    t, ships: list.map(([id, x, y, hd, sp, fl, af, fires]) => ({ id, x, y, hd, sp, list: 0, fl: fl || 0, af: af !== false, fires: fires || 0 })),
    env: { seaState: 1, windDir: 250, windKn: 2, visNm: 15 },
  });

  E({ type: 'sim.start', t: 0, scenario: 'sandbox_custom', seed: 604 });
  E({ type: 'env.change', t: 0.3, windKn: 2, windDirDeg: 250, seaState: 1, visibilityNm: 15 });

  // 双方开火：A1 10 发、A2 8 发、X1 5 发、X2 6 发
  const fire = (t, id, name, side, cal) => E({ type: 'gun.fire', t, ship: id, name, side, ammo: 'HE', caliberMM: cal, salvoId: 's' + seq });
  const salvo = (t, id, name, side, guns) => E({ type: 'gun.salvo.away', t, ship: id, name, side, gunsFired: guns, salvoId: 's' + seq });
  for (let i = 0; i < 10; i++) { const t = 20 + i * 10; salvo(t, 'a1', '衣阿华', 'ALLIED', 9); fire(t, 'a1', '衣阿华', 'ALLIED', 406); }
  for (let i = 0; i < 8; i++) { const t = 22 + i * 12; salvo(t, 'a2', '弗莱彻', 'ALLIED', 5); fire(t, 'a2', '弗莱彻', 'ALLIED', 127); }
  for (let i = 0; i < 5; i++) { const t = 25 + i * 8; salvo(t, 'x1', '大和', 'AXIS', 9); fire(t, 'x1', '大和', 'AXIS', 460); }
  for (let i = 0; i < 6; i++) { const t = 26 + i * 3; salvo(t, 'x2', '高雄', 'AXIS', 10); fire(t, 'x2', '高雄', 'AXIS', 203); }

  // 命中：A1→X1 两发、A2→X2 一发
  const hit = (t, by, byName, atkSide, ship, name, shipSide, cal) => E({
    type: 'gun.hit', t, byShip: by, byShipName: byName, ship, name, caliberMM: cal,
    hitPart: 'BELT', penetrated: true, hit: { kind: 'SHELL', side: atkSide, attackerSide: atkSide, attackerId: by, attackerName: byName, victimId: ship, shipSide },
  });
  hit(40, 'a1', '衣阿华', 'ALLIED', 'x1', '大和', 'AXIS', 406);
  hit(70, 'a1', '衣阿华', 'ALLIED', 'x1', '大和', 'AXIS', 406);
  hit(90, 'a2', '弗莱彻', 'ALLIED', 'x2', '高雄', 'AXIS', 127);

  // 鱼雷：X2 对 T5 发射 4 条，全部命中友舰 X1
  E({ type: 'torp.launch', t: 12.2, ship: 'x2', name: '高雄', side: 'AXIS', mount: 'torp0', tubes: 4, track: 'T5', bearingDeg: 265, spreadDeg: 8.2, accepted: true });
  for (let i = 0; i < 4; i++) {
    const t = 45.4 + i * 1.5;
    E({ type: 'torp.hit', t, ship: 'x1', name: '大和', shooter: 'x2', shooterName: '高雄', shooterSide: 'AXIS', friendly: true, torp: 'TP' + (11 + i), side: 'PORT', compartment: 7 + i, x_frac: 0.3 + i * 0.2, warheadKg: 490, tntKg: 620 });
  }

  // 伤亡 + 弹药库 + 沉没
  E({ type: 'dam.casualties', t: 45.4, ship: 'x1', name: '大和', victimSide: 'AXIS', killed: 78, crewNow: 2672, cause: 'TORPEDO' });
  E({ type: 'dam.dc', t: 50.5, ship: 'x1', name: '大和', victimSide: 'AXIS', priority: 'magazine', inflowM3s: 53.09, pumpM3s: 0.67, crewPct: 0.887, speedCapKn: 17.2 });
  E({ type: 'dam.flood', t: 50.5, ship: 'x1', name: '大和', victimSide: 'AXIS', compartment: 7, floodedM3: 1381, rateM3s: 53.09 });
  E({ type: 'dam.list', t: 80.9, ship: 'x1', name: '大和', victimSide: 'AXIS', list: 1.7, draft: 10.6, gm: 2.9, capsizeRisk: 0.04 });
  E({ type: 'dam.fire', t: 47, ship: 'x1', name: '大和', victimSide: 'AXIS', intensity: 0.33, cause: '鱼雷燃油/弹药引燃' });
  E({ type: 'dam.magazine', t: 82.8, ship: 'x1', name: '大和', victimSide: 'AXIS', result: 'detonation', killed: 2262, cause: '弹药库殉爆' });
  E({ type: 'ship.sink', t: 82.8, ship: 'x1', name: '大和', side: 'AXIS', cause: '弹药库殉爆', catastrophic: true, x: 3457, y: -72 });

  // 指挥：轴心 20 条指令里 12 条烟幕（触发 SMOKE_SPAM）
  for (let i = 0; i < 12; i++) E({ type: 'order.issue', t: 10 + i, cmd: { id: 'c' + i, side: 'AXIS', shipId: 'x2', kind: 'SMOKE', params: { on: true } } });
  for (let i = 0; i < 8; i++) E({ type: 'order.issue', t: 20 + i, cmd: { id: 'd' + i, side: 'AXIS', shipId: 'x2', kind: 'SET_COURSE', params: { heading: 200 } } });
  for (let i = 0; i < 4; i++) E({ type: 'order.issue', t: 12 + i, cmd: { id: 'e' + i, side: 'ALLIED', shipId: 'a1', kind: 'FIRE', params: {} } });

  // 判型漂移：同一航迹 T5 被轴心连续改判 BB → CA → CL
  E({ type: 'sensor.detect', t: 5, side: 'AXIS', ship: 'x2', target: 'T5', source: 'VISUAL', classifiedAs: 'UNKNOWN', x: 0, y: 0 });
  E({ type: 'ai.decision', t: 10, side: 'AXIS', phase: 'ENGAGE', commands: 1, reasoning: '【态势】集火UNKNOWN(T5)' });
  E({ type: 'ai.decision', t: 20, side: 'AXIS', phase: 'ENGAGE', commands: 1, reasoning: '【态势】集火BB(T5)' });
  E({ type: 'ai.decision', t: 120, side: 'AXIS', phase: 'ENGAGE', commands: 0, reasoning: '【态势】集火CA(T5)' });
  E({ type: 'ai.decision', t: 220, side: 'AXIS', phase: 'ENGAGE', commands: 0, reasoning: '【态势】集火CL(T5)' });

  // 重复碰撞：x1 / x2 两次
  E({ type: 'ship.collide', t: 75.1, a: 'x2', b: 'x1', rel: 5.8 });
  E({ type: 'ship.collide', t: 80.1, a: 'x2', b: 'x1', rel: 6.2 });

  return {
    version: 1, scenario: 'sandbox_custom', seed: 604, startedAt: 0, endedAt: 300,
    snapshots: [
      snap(0.1, [['a1', -500, 500, 45, 25], ['a2', 0, 0, 45, 25], ['x1', 4000, 400, 225, 24], ['x2', 4600, -100, 225, 24]]),
      snap(100, [['a1', -100, 900, 30, 25], ['a2', 300, 200, 50, 25], ['x1', 3457, -72, 248, 0, 1381, false], ['x2', 4200, -700, 180, 24]]),
      snap(200, [['a1', 200, 2000, 20, 25], ['a2', 800, 900, 60, 25], ['x1', 3457, -72, 248, 0, 1381, false], ['x2', 5000, -1200, 150, 26]]),
      snap(300, [['a1', 500, 3000, 10, 25], ['a2', 1200, 1500, 70, 25], ['x1', 3457, -72, 248, 0, 1381, false], ['x2', 5600, -1500, 140, 27]]),
    ],
    events: ev,
    commands: [],
    result: { over: false, winner: null, text: '' },
    retention: { limit: 60000, hardLimit: 120000, history: ev.length, totalEmitted: ev.length, droppedNoise: 0, droppedCritical: 0 },
  };
}

// 干净回放：没有友军鱼雷、双方全程有开火、航迹判型稳定
function cleanReplay() {
  const r = baseReplay();
  r.events = r.events.filter((e) => e.type !== 'torp.launch' && e.type !== 'torp.hit');
  // 让轴心在 220 秒后仍有开火，避免"超长静默"
  let seq = r.events.length;
  for (let t = 120; t <= 300; t += 10) {
    r.events.push({ seq: ++seq, type: 'gun.fire', t, ship: 'x2', name: '高雄', side: 'AXIS', ammo: 'HE', caliberMM: 203 });
    r.events.push({ seq: ++seq, type: 'gun.fire', t, ship: 'a1', name: '衣阿华', side: 'ALLIED', ammo: 'HE', caliberMM: 406 });
  }
  // 去掉判型漂移
  r.events = r.events.filter((e) => !(e.type === 'ai.decision' && /集火(C[AL]|BB)\(T5\)/.test(e.reasoning || '')));
  return r;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-analyzer-'));
const writeReplay = (name, obj) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
};

test('T23.1 统计口径 = 事件计数（射击/命中/鱼雷/伤亡/指令）', () => {
  const m = analyzeReplay(baseReplay());
  assert.equal(m.gunnery.rounds, 29, '10 + 8 + 5 + 6 发');
  assert.equal(m.gunnery.hits, 3);
  assert.equal(m.torpedo.fired, 4);
  assert.equal(m.torpedo.hitsCount, 4);
  assert.equal(m.torpedo.friendlyHits, 4);
  assert.equal(m.orders.total, 24, '12 烟幕 + 8 航向 + 4 开火');
  assert.equal(m.collisions.length, 2);
  assert.equal(m.damage.totalCasualties, 78 + 2262);
  assert.equal(m.damage.sunk.length, 1);
  assert.equal(m.ships.length, 4);
  const x1 = m.ships.find((s) => s.id === 'x1');
  assert.equal(x1.torpHitsTaken, 4, '被命中 4 雷');
  assert.equal(x1.casualties, 78 + 2262);
  assert.equal(x1.sank.t, 82.8);
  const x2 = m.ships.find((s) => s.id === 'x2');
  assert.equal(x2.torpHits, 4, '作为射手计入 4 命中');
});

test('T23.1b 时间格式：秒进位不出现 31:60 / 32:010', () => {
  assert.equal(fmtClock(0), '0:00.0');
  assert.equal(fmtClock(639.2), '10:39.2');
  assert.equal(fmtClock(1919.9999999993493), '32:00.0');
  assert.equal(fmtClock(1929.9999999993402), '32:10.0');
  assert.equal(fmtClock(59.96), '1:00.0');
  assert.equal(fmtClock(59.4, false), '0:59');
  assert.equal(fmtClock(59.6, false), '1:00');
});

test('T23.2 关键发现：友军雷击 / 唯一沉没 / 殉爆 / 静默 / 判型漂移 / 碰撞', () => {
  const m = analyzeReplay(baseReplay());
  const codes = m.findings.map((f) => f.code);
  for (const c of ['TORP_FRIENDLY_FIRE', 'ONLY_KILL_FRIENDLY', 'MAGAZINE_DETONATION', 'SIDE_SILENCE', 'TRACK_IDENTITY_DRIFT', 'COLLISION_REPEAT', 'DC_INFEASIBLE', 'SMOKE_SPAM', 'UNDECIDED']) {
    assert.ok(codes.includes(c), '缺少发现：' + c + '，实际 ' + codes.join(','));
  }
  assert.match(m.verdict.headline, /自己人/);
  const ff = m.findings.find((f) => f.code === 'TORP_FRIENDLY_FIRE');
  assert.equal(ff.severity, 'critical');
});

test('T23.3 无数据库时按口径推断舰种，有数据库时补吨位/乘员', () => {
  const m = analyzeReplay(baseReplay());
  const a1 = m.ships.find((s) => s.id === 'a1');
  assert.equal(a1.type, 'BB', '406mm → 战列舰');
  const m2 = analyzeReplay(baseReplay(), { dataDir: path.join(ROOT, 'data') });
  const iowa = m2.ships.find((s) => s.name === '衣阿华');
  assert.equal(iowa.type, 'BB');
  assert.ok(iowa.displacementFull_t > 50000);
  assert.ok(iowa.crew > 2000);
});

test('T23.4 回归检查：坏回放不通过，干净回放通过', () => {
  const bad = checkReplay(analyzeReplay(baseReplay()));
  assert.equal(bad.ok, false);
  const failed = bad.rows.filter((r) => !r.ok).map((r) => r.rule);
  assert.ok(failed.includes('friendly-torpedo'));
  assert.ok(failed.includes('no-long-silence'));
  assert.ok(failed.includes('track-stability'));

  const good = checkReplay(analyzeReplay(cleanReplay()));
  assert.equal(good.ok, true, JSON.stringify(good.rows));
});

test('T23.5 渲染：text / markdown / html 都带结论，HTML 内联 SVG 且无外链', () => {
  const m = analyzeReplay(baseReplay());
  const text = renderText(m);
  assert.match(text, /友军鱼雷命中/);
  const md = renderMarkdown(m);
  assert.match(md, /^# 回放分析/m);
  assert.match(md, /TORP_FRIENDLY_FIRE|友军鱼雷命中/);
  const html = renderHtml(m);
  assert.match(html, /<svg/);
  assert.match(html, /自己人/);
  assert.ok(!/<img|src="http/.test(html), 'HTML 不应有外链图片');
  assert.ok(html.includes('中弹条带'), '应包含损伤条带图注');
});

test('T23.6 CLI：--check 退出码 / --format=md --out 写文件', () => {
  const badFile = writeReplay('bad.json', baseReplay());
  const goodFile = writeReplay('good.json', cleanReplay());
  const cli = path.join(ROOT, 'tools/replay-analyzer.mjs');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const bad = run([badFile, '--check']);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /FAIL.*friendly-torpedo/);

  const good = run([goodFile, '--check', '--quiet']);
  assert.equal(good.status, 0, good.stdout + good.stderr);

  const out = path.join(tmp, 'report.md');
  const r = run([badFile, '--format=md', '--out=' + out]);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /友军鱼雷|自己人/);

  const json = run([badFile, '--format=json']);
  assert.equal(json.status, 0, json.stderr);
  const model = JSON.parse(json.stdout);
  assert.equal(model.gunnery.rounds, 29);
  assert.equal(model.torpedo.friendlyHits, 4);
});

test('T23.7 单文件 HTML：构建成功 / 无外链 / 内联模块可直接执行', async () => {
  const { buildAnalyzerHtml } = await import('../tools/build-replay-analyzer-html.mjs');
  const html = buildAnalyzerHtml();
  assert.match(html, /^<!-- 由 tools\/build-replay-analyzer-html\.mjs 生成/);
  assert.ok(html.includes('id="drop"'), '应有拖放区');
  assert.ok(html.includes('id="paste"'), '应有粘贴文本框');
  assert.ok(html.includes("addEventListener('paste'"), '应有全局粘贴监听');
  assert.ok(html.includes('__analyzerPaste'), '应有粘贴入口（测试/调试钩子）');
  assert.ok(html.includes('?replay='), '应支持 ?replay= 载入');
  assert.ok(!/<script[^>]+src=/.test(html), '不应有外部脚本');
  assert.ok(!/<link[^>]+href=/.test(html), '不应有外部样式');

  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m && m[1].length > 1000, '应内联模块脚本');
  const code = m[1];
  assert.ok(!/^\s*(import|export)\s/m.test(code), '模块里不应残留 import/export 声明');

  // 把内联模块放进函数作用域执行：能分析、能出正文，说明打包没丢依赖
  const factory = new Function(code + '\nreturn { analyzeReplay: analyzeReplay, checkReplay: checkReplay, renderReportBody: renderReportBody, renderHtml: renderHtml };');
  const api = factory();
  const model = api.analyzeReplay(baseReplay());
  assert.equal(model.gunnery.rounds, 29);
  assert.equal(model.torpedo.friendlyHits, 4);
  assert.ok(api.renderReportBody(model).includes('友军鱼雷'));
  assert.ok(api.checkReplay(model).rows.some((r) => r.rule === 'friendly-torpedo' && !r.ok));
});

test('T23.8 新检测项：单舰静默 / FIRE 空转 / 鱼雷低效 / 序号缺口', () => {
  const ev = [];
  let seq = 0;
  const E = (o) => { seq += 1; ev.push(Object.assign({ seq }, o)); };
  E({ type: 'sim.start', t: 0, scenario: 'rules_test', seed: 1 });
  // 故意制造一个序号缺口（模拟 exportReplay 过滤 tick.major）
  E({ type: 'gun.fire', t: 20, ship: 'a1', name: '测试舰', side: 'ALLIED', ammo: 'HE', caliberMM: 127 });
  E({ type: 'gun.fire', t: 40, ship: 'a1', name: '测试舰', side: 'ALLIED', ammo: 'HE', caliberMM: 127 });
  seq += 1; // 跳过 seq，制造缺口
  E({ type: 'gun.fire', t: 60, ship: 'a1', name: '测试舰', side: 'ALLIED', ammo: 'HE', caliberMM: 127 });
  E({ type: 'gun.fire', t: 100, ship: 'a1', name: '测试舰', side: 'ALLIED', ammo: 'HE', caliberMM: 127 });
  // 之后全程静默，但敌舰一直在 3 km 内 → SHIP_SILENT_IN_RANGE
  E({ type: 'order.issue', t: 700, cmd: { id: 'f1', side: 'ALLIED', shipId: 'a1', kind: 'FIRE', t_effective: 704, params: { trackId: 'T9' } } });
  // 鱼雷低效：24 管、0 命中、全部射程耗尽
  for (let i = 0; i < 6; i++) E({ type: 'torp.launch', t: 10 + i, ship: 'a1', name: '测试舰', side: 'ALLIED', tubes: 4, track: 'T9' });
  for (let i = 0; i < 24; i++) E({ type: 'torp.miss', t: 200 + i, ship: 'a1', side: 'ALLIED', reason: 'RANGE_EXHAUSTED', runM: 20000 });
  const snap = (tt) => ({ t: tt, ships: [
    { id: 'a1', x: 0, y: 0, hd: 0, sp: 20, list: 0, fl: 0, af: true, fires: 0 },
    { id: 'x1', x: 3000, y: 0, hd: 180, sp: 20, list: 0, fl: 0, af: true, fires: 0 },
  ] });
  const replay = {
    version: 1, scenario: 'rules_test', seed: 1, startedAt: 0, endedAt: 1500,
    snapshots: [snap(0), snap(300), snap(600), snap(900), snap(1200), snap(1500)],
    events: ev, commands: [], result: { over: false, winner: null, text: '' },
    retention: { limit: 60000, totalEmitted: ev.length + 1, history: ev.length, droppedNoise: 0, droppedCritical: 0 },
  };
  const model = analyzeReplay(replay);
  const codes = model.findings.map((f) => f.code);
  assert.ok(codes.includes('SHIP_SILENT_IN_RANGE'), codes.join(','));
  assert.ok(codes.includes('FIRE_ORDER_STALLED'), codes.join(','));
  assert.ok(codes.includes('TORPEDO_LOW_EFFICIENCY'), codes.join(','));
  assert.ok(codes.includes('EVENT_SEQ_GAP'), codes.join(','));
  const silent = model.findings.find((f) => f.code === 'SHIP_SILENT_IN_RANGE');
  assert.equal(silent.severity, 'major');
  assert.match(silent.detail, /3 km/);
});

test('T23.9 已全员撤离后的停火不算 SIDE_SILENCE', () => {
  const ev = [];
  let seq = 0;
  const E = (o) => { seq += 1; ev.push(Object.assign({ seq }, o)); };
  E({ type: 'sim.start', t: 0, scenario: 'wd_test', seed: 2 });
  E({ type: 'gun.fire', t: 10, ship: 'a1', name: '甲舰', side: 'ALLIED', ammo: 'HE', caliberMM: 127 });
  E({ type: 'gun.fire', t: 20, ship: 'a1', name: '甲舰', side: 'ALLIED', ammo: 'HE', caliberMM: 127 });
  E({ type: 'order.issue', t: 30, cmd: { id: 'w1', side: 'ALLIED', shipId: 'a1', kind: 'WITHDRAW', params: {} } });
  E({ type: 'order.issue', t: 31, cmd: { id: 'w2', side: 'ALLIED', shipId: 'a1', kind: 'CEASE_FIRE', params: {} } });
  const snap = { t: 0, ships: [{ id: 'a1', x: 0, y: 0, hd: 0, sp: 10, list: 0, fl: 0, af: true, fires: 0 }] };
  const replay = {
    version: 1, scenario: 'wd_test', seed: 2, startedAt: 0, endedAt: 900,
    snapshots: [snap], events: ev, commands: [], result: { over: false, winner: null, text: '' },
    retention: { limit: 60000, totalEmitted: ev.length, history: ev.length, droppedNoise: 0, droppedCritical: 0 },
  };
  const model = analyzeReplay(replay);
  assert.ok(!model.findings.some((f) => f.code === 'SIDE_SILENCE'), '撤离后的静默不应报 SIDE_SILENCE');
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
