// test/t12.ai.test.mjs — LOCAL AI 命令节流 + 弹药库事件文案（task-3）
//
// 覆盖：
//   1) 命令密度：first_guadalcanal_1942 跑 600s（World + 双方 LOCAL AI，真实数据），
//      统计 order.issue。修复前同剧本同种子 600s 为 923 条（约 46 条/舰，40 分钟长局
//      实测 5482 条、平均 274 条/舰）；修复后要求总量降到 1/3 以下，且操舵类命令
//      （SET_COURSE/SET_SPEED/SET_RUDDER）每舰平均 <= 8 条/600s。
//   2) 仍在接战：gun.fire > 0 且至少 1 次 gun.hit（证明节流没有把 AI 降成"不打的观众"）。
//   3) 健壮性：全程无异常抛出、无 ai.error。
//   4) 文案：AIContext 对 dam.magazine 按 result 区分措辞，未知 result 写"弹药库异常"，
//      不再把所有弹舱事件都写成"弹药库殉爆！"（那会污染 LLM 提示词）。
//
// 运行：node test/t12.ai.test.mjs   （node:test，原生 ESM，零依赖；本机约 4s）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { LocalAI } from '../src/ai/local_ai.js';
import { AIContext } from '../src/ai/context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function loadScenario(id) {
  const doc = readJson('data/scenarios.json');
  const list = doc.scenarios || doc;
  const scen = list.find((s) => s.id === id);
  assert.ok(scen, '缺少剧本 ' + id);
  return scen;
}

function makeWorld(scenarioId, seed) {
  const db = ShipDatabase.fromMany([readJson('data/ships_axis.json'), readJson('data/ships_allied.json')]);
  let landData = null;
  try { landData = readJson('data/land.json'); } catch (e) { landData = null; }
  return new World({
    scenario: loadScenario(scenarioId), database: db, seed,
    playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData,
  });
}

const SECONDS = 600;
// 修复前基线（同剧本、同种子、同 LOCAL AI）：600s 内 order.issue = 923 条。
const BASELINE_ISSUE_600S = 923;

test('LOCAL AI 600s 命令节流：总量 < 基线 1/3，操舵命令 <= 8 条/舰，且仍在接战', () => {
  // 种子与"修复前基线"测量时一致（20261017）：923 条/600s / 20 舰
  const world = makeWorld('first_guadalcanal_1942', 20261017);
  const shipCount = world.ships.length;
  assert.ok(shipCount >= 18, 'first_guadalcanal_1942 应有 20 艘舰（实际 ' + shipCount + '）');

  let thrown = null, aiErrors = 0;
  world.events.on('ai.error', () => { aiErrors++; });
  try { world.advance(SECONDS); } catch (e) { thrown = e; }
  assert.equal(thrown, null, 'AI 运行不应抛异常：' + (thrown && thrown.message));

  const ev = world.events.history;
  const issues = ev.filter((e) => e.type === 'order.issue');
  const count = (type) => ev.filter((e) => e.type === type).length;
  const issuesPerShip600 = issues.length / shipCount;
  const steering = issues.filter((e) => e.cmd && (e.cmd.kind === 'SET_COURSE' || e.cmd.kind === 'SET_SPEED' || e.cmd.kind === 'SET_RUDDER')).length;
  const steeringPerShip = steering / shipCount;

  console.log('  仿真 ' + world.t.toFixed(0) + 's / ' + shipCount + ' 舰：order.issue=' + issues.length +
    '（' + issuesPerShip600.toFixed(1) + ' 条/舰，基线 ' + (BASELINE_ISSUE_600S / shipCount).toFixed(1) + ' 条/舰）' +
    ' 操舵类=' + steering + '（' + steeringPerShip.toFixed(1) + ' 条/舰）');
  const kinds = {};
  for (const e of issues) kinds[e.cmd.kind] = (kinds[e.cmd.kind] || 0) + 1;
  console.log('  命令构成：' + Object.keys(kinds).sort().map((k) => k + '=' + kinds[k]).join(' '));
  console.log('  接战：gun.fire=' + count('gun.fire') + ' gun.hit=' + count('gun.hit') + ' torp.launch=' + count('torp.launch') + ' ai.error=' + aiErrors);

  // (a) 命令密度：总量必须低于修复前基线的 1/3（回归保护），操舵类每舰平均 <= 8 条/600s
  assert.ok(issues.length < BASELINE_ISSUE_600S / 3,
    'order.issue 应低于基线 1/3（' + Math.round(BASELINE_ISSUE_600S / 3) + '），实际 ' + issues.length);
  assert.ok(steeringPerShip <= 8,
    'SET_COURSE/SET_SPEED/SET_RUDDER 每舰平均应 <= 8 条/600s，实际 ' + steeringPerShip.toFixed(1));
  // 单舰尖峰保护：不允许某一艘舰把命令数拉回旧量级
  const perShip = new Map();
  for (const e of issues) { const id = e.cmd.shipId || 'FLEET'; perShip.set(id, (perShip.get(id) || 0) + 1); }
  const worst = Math.max.apply(null, Array.from(perShip.values()));
  assert.ok(worst <= 30, '单舰 600s 命令数应 <= 30，实际最高 ' + worst);

  // (b) 仍在接战：有射击、有命中
  assert.ok(count('gun.fire') > 0, '节流后 AI 仍必须开火');
  assert.ok(count('gun.hit') >= 1, '节流后 AI 仍必须打出命中');
  // (c) 无异常
  assert.equal(aiErrors, 0, '不应出现 ai.error');
});

test('dam.magazine 文案按 result 区分，不再一律写"弹药库殉爆"', () => {
  const world = makeWorld('first_guadalcanal_1942', 19421942);
  const ctx = new AIContext(world, 'ALLIED');
  const text = (result, magRisk) => ctx._describe({ type: 'dam.magazine', result, ship: '测试舰', name: '测试舰', magRisk });
  const cases = [
    ['detonation', '殉爆'],
    ['burn', '爆燃'],
    ['flooded', '注水'],
    ['flash', '闪燃'],
    ['hit', '击穿'],
    ['fire_threat', '火势'],
  ];
  for (const [result, want] of cases) {
    const s = text(result, 0.4);
    assert.ok(s.includes(want), result + ' 应描述为含"' + want + '"（实际：' + s + '）');
    if (result !== 'detonation' && result !== 'burn') assert.ok(!s.includes('殉爆') || s.includes('避免殉爆'), result + ' 不应写成殉爆（实际：' + s + '）');
  }
  const unknown = text('something_new', 0.2);
  assert.ok(unknown.includes('弹药库异常'), '未知 result 应写"弹药库异常"（实际：' + unknown + '）');
  assert.ok(/风险\d+%/.test(text('fire_threat', 0.42)), '应带 magRisk 百分比提示');
  console.log('  文案样例：' + cases.map((c) => text(c[0], 0.4)).join(' ｜ ') + ' ｜ ' + unknown);
});
