#!/usr/bin/env node
// T24 火炮弹药选择 + 副炮使用
//
// 需求（玩家反馈）：
//   ① 打装甲目标"穿不了也要用穿甲弹"——旧 AI 一见估算穿深不足就换 HE，实测丹麦海峡变体局
//      威尔士亲王打俾斯麦 533 发 HE、零穿透，等于白打。AP 即使打不穿主装甲带，仍可能跳弹
//      入要害/打进弹药库与动力舱；HE 对装甲带几乎无效。
//   ② AI 会用副炮——旧实现只有单通道 commanded.fireBattery，主副炮互斥，副炮永远闲置。
//
// 断言：
//   1) pickAmmo：对装甲目标（装甲带 >25mm）即使远距估算穿深不足也返回 AP；对软目标返回 HE。
//   2) 丹麦海峡场景 420s 内出现 role='secondary' 的齐射，且副炮炮弹来自对海副炮（不是高射炮）。
//   3) AP 发射数明显多于 HE（装甲目标优先穿甲弹）。
//
// 运行：node test/t24.secondary_ammo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { LocalAI } from '../src/ai/local_ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const DB = ShipDatabase.fromMany([readJson('data/ships_axis.json'), readJson('data/ships_allied.json')]);
let LAND = null, DEPTH = null;
try { LAND = readJson('data/land.json'); } catch (e) { LAND = null; }
try { DEPTH = readJson('data/depth.json'); } catch (e) { DEPTH = null; }

function makeWorld(scenarioId, seed) {
  const sc = (readJson('data/scenarios.json').scenarios || []).find((s) => s.id === scenarioId);
  return new World({
    scenario: sc, database: DB, seed, playerSide: 'ALLIED', ai: true, aiOpts: { backend: 'LOCAL' },
    buildFromScenario: true, landData: LAND, depthData: DEPTH,
  });
}

test('弹药选择：装甲目标远距穿深不足也用 AP；软目标才用 HE', () => {
  const w = makeWorld('denmark_strait_1941', 19420604);
  const hood = w.ship('hood');
  const ai = new LocalAI('ALLIED');
  // 20km 对战列舰：381mm 估算穿深远小于 323mm 装甲带，仍应选 AP
  assert.equal(ai.pickAmmo(hood, { classifiedAs: 'BB' }, 20000), 'AP', '远距打装甲目标应仍用 AP');
  // 5km 对驱逐舰（无装甲带）：HE
  assert.equal(ai.pickAmmo(hood, { classifiedAs: 'DD' }, 5000), 'HE', '软目标应用 HE');
  // 中距对重巡（106mm 带）：AP
  assert.equal(ai.pickAmmo(hood, { classifiedAs: 'CA' }, 12000), 'AP', '重巡也应 AP');
});

test('副炮：420s 内出现对海副炮齐射，且不误用高射炮', () => {
  const w = makeWorld('denmark_strait_1941', 19420604);
  const secondarySalvos = [];
  const batteryHit = new Set();
  const ammoCount = { AP: 0, HE: 0 };
  w.events.on('gun.salvo.away', (e) => { if (e.role === 'secondary') secondarySalvos.push({ t: +e.t.toFixed(0), ship: e.ship, guns: e.gunsFired }); });
  w.events.on('gun.fire', (e) => { batteryHit.add(e.battery); if (ammoCount[e.ammo] !== undefined) ammoCount[e.ammo]++; });
  while (!w.over && w.t < 420) w.step(0.1);
  console.log('  副炮齐射=' + secondarySalvos.length + ' ' + JSON.stringify(secondarySalvos.slice(0, 5)));
  console.log('  弹药 AP=' + ammoCount.AP + ' HE=' + ammoCount.HE);
  console.log('  开火炮塔=' + JSON.stringify([...batteryHit]));
  assert.ok(secondarySalvos.length >= 1, '420s 内应有副炮齐射（实际 ' + secondarySalvos.length + '）');
  const names = [...batteryHit];
  assert.ok(names.some((n) => /副炮/.test(n)), '应有对海副炮（副炮N）射击：' + JSON.stringify(names));
  assert.ok(!names.some((n) => /高射炮/.test(n)), '高射炮不应被当作副炮打水面目标：' + JSON.stringify(names));
  assert.ok(ammoCount.AP > ammoCount.HE, '装甲目标优先 AP（实际 AP=' + ammoCount.AP + ' HE=' + ammoCount.HE + '）');
});
