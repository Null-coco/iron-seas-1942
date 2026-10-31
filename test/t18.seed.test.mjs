#!/usr/bin/env node
// T18 随机种子：可复现 + 可更改（UI「开局菜单种子」/ 沙盒 / 深链 ?seed= 都走这条契约）
//
// 契约（UI 与内核共同的约定）：
//   1) World({seed}) 采用显式种子；不传则用默认 19420604（与 RNG/headless 一致）；
//   2) 同剧本 + 同种子 + 同步长 → 完全复现（同一场战局）；
//   3) 换种子 → 不再是同一场战局（随机事件分叉）；
//   4) 导出的回放里 seed 与 world.seed 一致（复盘时能填回菜单）。
//
// 运行：node test/t18.seed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function loadScenario(id) {
  const doc = readJson('data/scenarios.json');
  const list = doc.scenarios || doc;
  const scen = list.find((s) => s.id === id);
  assert.ok(scen, '缺少剧本 ' + id);
  return scen;
}

function makeWorld(scenId, seed) {
  const db = ShipDatabase.fromMany([readJson('data/ships_axis.json'), readJson('data/ships_allied.json')]);
  let landData = null, depthData = null;
  try { landData = readJson('data/land.json'); } catch (e) { landData = null; }
  try { depthData = readJson('data/depth.json'); } catch (e) { depthData = null; }
  return new World({
    scenario: loadScenario(scenId), database: db, seed,
    playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData, depthData,
  });
}

// 战局指纹：时间 + 逐舰状态 + 事件/命令计数。同种子必须逐字节一致。
function fingerprint(w) {
  return JSON.stringify({
    t: +w.t.toFixed(3),
    ships: w.ships.map((s) => [s.id, +s.floodedM3.toFixed(2), +s.speed.toFixed(3), +s.heading.toFixed(2), s.isAfloat]),
    events: w.events.history.length,
    commands: w.commands.length,
  });
}

function runFingerprint(seed, seconds) {
  const w = makeWorld('denmark_strait_1941', seed);
  w.advance(seconds);
  return { world: w, fp: fingerprint(w) };
}

test('World 采用显式种子；不传时用默认 19420604', () => {
  const wDefault = makeWorld('denmark_strait_1941', undefined);
  assert.equal(wDefault.seed, 19420604, '默认种子应为 19420604');
  assert.equal(wDefault.exportReplay().seed, 19420604, '回放里的种子应与 world.seed 一致');

  const wSet = makeWorld('denmark_strait_1941', 777001);
  assert.equal(wSet.seed, 777001, '应记住显式传入的种子');
  assert.equal(wSet.exportReplay().seed, 777001, '回放种子应等于显式种子');
});

test('同剧本 + 同种子 → 完全复现（UI 复盘/分享"这一局"的前提）', () => {
  const a = runFingerprint(424242, 180);
  const b = runFingerprint(424242, 180);
  assert.equal(a.fp, b.fp, '同种子两次运行必须逐项一致');
});

test('换种子 → 不再是同一场战局（改种子确实换了随机序列）', () => {
  // 取不同种子分别跑；只要存在一对结果不同，即证明种子真的参与演算。
  const s1 = runFingerprint(111, 180).fp;
  const s2 = runFingerprint(222, 180).fp;
  assert.notEqual(s1, s2, '不同种子应产生不同战局（否则改种子没有意义）');
});

test('种子经回放/报告可回填（导出 → 再按该种子开局 → 同一战局）', () => {
  const first = runFingerprint(909090, 120);
  const replay = first.world.exportReplay();
  assert.equal(replay.version, 1);
  assert.ok(replay.seed === 909090, '回放必须带上种子');
  // 用回放里的种子重开：应得到与首局相同的指纹（同剧本、同步长）
  const again = runFingerprint(replay.seed, 120);
  assert.equal(again.fp, first.fp, '按回放种子重开应复现同一战局');
});
