#!/usr/bin/env node
// T20 友军鱼雷安全走廊：发射前必须判断"友舰随后会不会切进雷道"
//
// 回归背景（用户回放 sandbox_custom seed=604 暴露）：
//   高雄（大和的僚舰）向 265° 发射 4 条九二式鱼雷时，大和在扇面外 50°，旧 corridorClear
//   只看发射瞬间方位 → 判定安全放行。但大和 5 秒后接到"掉头朝西 270°"的命令、正好迎向
//   雷道，33 秒后 4 条鱼雷**全部命中自己的旗舰**（torp.hit friendly=true），大和再被一发
//   水线下 203mm 打进弹药库殉爆。玩家看到的就是"大和 83 秒就没了、非常脆"。
//
// 本测试锁住两点：
//   1) 几何判据：友舰当前在扇面外、但受令横穿雷道 → 必须拒绝发射（旧版会放行）；
//      友舰远在侧方 / 在雷道后方 → 放行（不能过度保守到无法雷击）。
//   2) 端到端：同 seed 复刻该沙盒阵位跑 300s，不得出现任何友军鱼雷命中。
//
// 运行：node test/t20.friendly_torp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { LocalAI } from '../src/ai/local_ai.js';
import { kn2mps, bearing2d, dist2d, normDeg180, clamp } from '../src/core/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const DB = ShipDatabase.fromMany([readJson('data/ships_axis.json'), readJson('data/ships_allied.json')]);
let LAND = null, DEPTH = null;
try { LAND = readJson('data/land.json'); } catch (e) { LAND = null; }
try { DEPTH = readJson('data/depth.json'); } catch (e) { DEPTH = null; }

// 沙盒坐标基准（与 src/ui/app.js 的 SBX_LAT0/LON0 一致）
const L0 = 30, O0 = -40;
const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(L0 * Math.PI / 180);
const toLL = (x, y) => ({ lat: +(L0 + y / mPerDegLat).toFixed(6), lon: +(O0 + x / mPerDegLon).toFixed(6) });

function buildWorld(shipSpecs, seed) {
  const ships = shipSpecs.map(([id, cls, side, x, y, hd, sp, role]) => {
    const p = toLL(x, y);
    return { id, name: id, class: cls, side, lat: p.lat, lon: p.lon, heading: hd, speed: sp, role, crewQuality: 1 };
  });
  const scenario = {
    id: 'sandbox_custom', nameZh: '沙盒演习', date: '1943-06-01', place: 'x',
    start: { lat: L0, lon: O0, date: '1943-06-01T12:00:00Z', env: { windKn: 0, windDirDeg: 250, visibilityNm: 15, seaState: 0 } },
    env: { windKn: 0, windDirDeg: 250, visibilityNm: 15, seaState: 0 },
    sides: {
      ALLIED: { nameZh: 'A', objective: 'x', orderDelay_s: 4, withdrawThreshold: 0.2 },
      AXIS: { nameZh: 'B', objective: 'y', orderDelay_s: 4, withdrawThreshold: 0.2 },
    },
    ships, objectives: [], sandbox: true, sandboxNoVictory: true,
  };
  return new World({
    scenario, database: DB, seed, playerSide: 'ALLIED', ai: true, aiOpts: { backend: 'LOCAL' },
    buildFromScenario: true, landData: LAND, depthData: DEPTH,
  });
}

// 旧版（只看发射瞬间方位）——用于对照，证明本用例确实能抓到旧 bug
function oldCorridorClear(world, dd, courseDeg, spread, runM) {
  const half = clamp(spread / 2 + 2, 2, 12) * Math.PI / 180;
  for (const f of world.shipsOf(dd.side)) {
    if (f.id === dd.id || !f.isAfloat) continue;
    const brg = bearing2d(dd.pos, f.pos);
    const d = dist2d(dd.pos, f.pos);
    if (d > runM + 1200) continue;
    if (Math.abs(normDeg180(brg - courseDeg)) * Math.PI / 180 < half + Math.atan2(30, Math.max(200, d))) return false;
  }
  return true;
}

test('友舰在扇面外、但受令横穿雷道 → 必须拒绝发射（旧版会放行）', () => {
  // 发射舰在原点；友舰在东北 45°、700m（扇面 8°/半宽约 6°，故不在扇面内），航向 270°（向西横穿）
  const w = buildWorld([
    ['dd', 'Takao', 'AXIS', 0, 0, 90, 25, 'flagship'],
    ['friend', 'Yamato', 'AXIS', 500, 500, 270, 25, 'line'],
  ], 604);
  const dd = w.ship('dd'), f = w.ship('friend');
  f.commanded.heading = 270; f.commanded.speed = 25;
  const ai = new LocalAI('AXIS');
  const COURSE = 0, SPREAD = 8, RUN = 6000, V = kn2mps(48);

  const brg = bearing2d(dd.pos, f.pos);
  assert.ok(Math.abs(normDeg180(brg - COURSE)) > 20, '前提：友舰当前应在扇面外（实际方位差 ' + Math.abs(normDeg180(brg - COURSE)).toFixed(0) + '°）');
  assert.equal(oldCorridorClear(w, dd, COURSE, SPREAD, RUN), true, '旧版静态检查会把这种几何判为安全（这正是 bug）');
  assert.equal(ai.corridorClear(w, dd, f, COURSE, SPREAD, RUN, V), false, '新版应拦截：友舰横穿雷道');
});

test('友舰远在侧方 / 在雷道后方 → 放行（不得过度保守）', () => {
  const w = buildWorld([
    ['dd', 'Takao', 'AXIS', 0, 0, 90, 25, 'flagship'],
    ['friend', 'Yamato', 'AXIS', 2500, 500, 270, 25, 'line'],
  ], 604);
  const dd = w.ship('dd'), f = w.ship('friend');
  const ai = new LocalAI('AXIS');
  const COURSE = 0, SPREAD = 8, RUN = 6000, V = kn2mps(48);
  f.pos = { x: 2500, y: 500 };
  assert.equal(ai.corridorClear(w, dd, f, COURSE, SPREAD, RUN, V), true, '侧方 2.5km 应放行');
  f.pos = { x: 300, y: -600 };   // 雷道后方
  assert.equal(ai.corridorClear(w, dd, f, COURSE, SPREAD, RUN, V), true, '雷道后方应放行');
});

test('端到端：沙盒 seed=604 阵位跑 300s，不得出现友军鱼雷命中', () => {
  // 与用户回放（sandbox_custom / seed 604）相同的 6 舰阵位
  const w = buildWorld([
    ['sbx_allied_1', 'Iowa', 'ALLIED', -495, 494, 45, 25, 'flagship'],
    ['sbx_allied_2', 'NewOrleans', 'ALLIED', 1, 1, 45, 25, 'line'],
    ['sbx_allied_3', 'Fletcher', 'ALLIED', 496, -492, 45, 25, 'screen'],
    ['sbx_axis_4', 'Yamato', 'AXIS', 4138, 492, 225, 25, 'flagship'],
    ['sbx_axis_5', 'Takao', 'AXIS', 4633, -1, 225, 25, 'line'],
    ['sbx_axis_6', 'Kagero', 'AXIS', 5128, -494, 225, 25, 'screen'],
  ], 604);
  const friendly = [];
  const sinks = [];
  w.events.on('torp.hit', (e) => { if (e.friendly) friendly.push({ t: +e.t.toFixed(1), victim: e.ship, shooter: e.shooter }); });
  w.events.on('ship.sink', (e) => { sinks.push({ t: +e.t.toFixed(1), name: e.name, cause: e.cause }); });
  while (!w.over && w.t < 300) w.step(0.1);
  console.log('  友军鱼雷命中=' + friendly.length + ' ' + JSON.stringify(friendly.slice(0, 8)));
  console.log('  沉没=' + JSON.stringify(sinks));
  assert.equal(friendly.length, 0, '不应出现友军鱼雷命中（旧版此场景 4 条全中旗舰）：' + JSON.stringify(friendly));
  // 本用例只验证"友军鱼雷走廊"。舰船是否沉没取决于交战结果——近距离 460 mm 打进弹药库会殉爆，
  // 属正常战果，不是走廊 bug。因此只断言"没有因友军鱼雷沉没"。
  const ffVictims = new Set(friendly.map((f) => f.victim));
  const sunkByFriendly = sinks.filter((s) => ffVictims.has(s.ship) || ffVictims.has(s.name));
  assert.equal(sunkByFriendly.length, 0, '不应有舰因友军鱼雷沉没：' + JSON.stringify(sunkByFriendly));
});
