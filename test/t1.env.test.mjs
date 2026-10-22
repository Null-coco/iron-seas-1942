// T1（环境 + 舰体运动）测试：Node 原生 test runner，零依赖。
// 运行：/Users/zl/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node --test test/t1.env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { Environment, seaStateFromWind, beaufortForceFromWind, dayNightInfo, douglasFromHs, hsFromDouglas, significantWaveHeightFromWind } from '../src/sim/env.js';
import { naturalRollPeriodS, steadyTurnRateDegS, availablePowerFrac } from '../src/sim/dynamics.js';
import { kn2mps, deg2rad, normDeg180 } from '../src/core/util.js';

// ---------------- 测试用舰船数据（内联，避免依赖 data/ 文件） ----------------
function mkData(id, type, o = {}) {
  const disp = o.disp || 3300;
  return {
    id, nameZh: id, nameEn: id, class: id, nation: 'TEST', type, year: 1942,
    displacementStd_t: disp * 0.9, displacementFull_t: disp,
    loa_m: o.loa || 129.5, lwl_m: (o.loa || 129.5) * 0.97, beam_m: o.beam || 11.2, draft_m: o.draft || 4.1,
    gm_m: o.gm || 1.0, blockCoef: 0.5, power_shp: o.power || 75000,
    speedMax_kn: o.spd || 40.9, speedEcon_kn: 15, rangeEcon_nm: 6000, fuel_t: 500,
    turnRadiusAt20kn_m: o.turnR || 550, rudderAngleMax_deg: 35, rudderRate_deg_s: o.rudderRate || 3.5,
    mastHeight_m: 22, crew: 267,
    armor: { belt_mm: 20, beltLengthFrac: 0.4, deck_mm: 15 },
    guns: [], torpedoes: [], aa: [],
    sensors: { radar: [], sonar: [], hydro: [], rangefinders: [{ base_m: 3, type: 'coincidence' }], directors: [{ id: 'd1', hasFCComputer: true }] },
  };
}
const DD = mkData('test_dd', 'DD');
const CA = mkData('test_ca', 'CA', { loa: 203.8, beam: 20.4, draft: 6.3, disp: 15190, spd: 35.5, power: 130000, turnR: 700, gm: 1.6, rudderRate: 3 });

function makeWorld(data, spec, envOpts, seed = 42) {
  const db = ShipDatabase.fromObject({ ships: [data] });
  const scenario = {
    id: 't1', nameZh: 'T1', start: { lat: 30, lon: 150, date: '1942-06-01T12:00:00Z', env: envOpts },
    sides: { ALLIED: {}, AXIS: {} }, ships: [spec], objectives: [],
  };
  return new World({ scenario, database: db, seed, playerSide: 'ALLIED', ai: false });
}
const specFor = (id, heading = 0, speed = 0) => ({ id, class: id === 'CA1' ? 'test_ca' : 'test_dd', side: 'ALLIED', x: 0, y: 0, heading, speed });

// ================================================================ 环境
test('蒲福风级 ↔ 道格拉斯海况：8 级风给出合理海况', () => {
  assert.equal(seaStateFromWind(0), 0);
  const b8 = beaufortForceFromWind(37);
  assert.ok(Math.abs(b8 - 8) < 0.5, '37kn 应为蒲福 8 级，实际 ' + b8.toFixed(2));
  const ss8 = seaStateFromWind(37);
  assert.ok(Number.isInteger(ss8), '对外海况必须是整数，实际 ' + ss8);
  assert.ok(ss8 >= 5 && ss8 <= 7, '蒲福 8 级海况应落在 5~7，实际 ' + ss8);
  let prev = -1;
  for (let w = 0; w <= 64; w += 2) { const s = seaStateFromWind(w); assert.ok(s >= prev - 1e-9, '海况应随风单调'); prev = s; }
  assert.ok(seaStateFromWind(64) > 8, '12 级风应接近 9 级海况');
  console.log('[样例] 37kn → 蒲福 ' + b8.toFixed(2) + ' 级，Hs=' + significantWaveHeightFromWind(37).toFixed(2) + 'm → 道格拉斯 ' + ss8.toFixed(2) +
    '；25kn → 道格拉斯 ' + seaStateFromWind(25).toFixed(2) + '；64kn → 道格拉斯 ' + seaStateFromWind(64).toFixed(2));
  // 波高↔海况可逆
  for (const ss of [3, 5, 7, 9]) assert.ok(Math.abs(douglasFromHs(hsFromDouglas(ss)) - ss) < 0.02, '波高/海况往返一致 ss=' + ss);
});

test('昼夜：日出日落、太阳高度角与月相', () => {
  const eq = dayNightInfo(0, 172, 12);
  assert.ok(Math.abs(eq.sunriseH - 6) < 0.25, '赤道夏至日出≈06:00，实际 ' + eq.sunriseH.toFixed(2));
  assert.ok(Math.abs(eq.sunsetH - 18) < 0.25);
  assert.ok(eq.sunAltDeg > 63 && eq.sunAltDeg < 70, '赤道夏至正午高度角≈66.6°，实际 ' + eq.sunAltDeg.toFixed(1));
  const lat40sum = dayNightInfo(40, 172, 12);
  assert.ok(lat40sum.sunsetH - lat40sum.sunriseH > 14, '40°N 夏至昼长 >14h，实际 ' + (lat40sum.sunsetH - lat40sum.sunriseH).toFixed(2));
  const lat40win = dayNightInfo(40, 355, 12);
  assert.ok(lat40win.sunsetH - lat40win.sunriseH < 10, '40°N 冬至昼长 <10h');
  assert.ok(dayNightInfo(78, 172, 12).polarDay, '78°N 夏至极昼');
  // 月相：2000-01-06 为朔，2000-01-21 为望
  assert.ok(dayNightInfo(0, 6, 12, 2000).moonIllum < 0.02, '朔日月面照明应≈0');
  assert.ok(dayNightInfo(0, 21, 12, 2000).moonIllum > 0.95, '望日月面照明应≈1');
});

test('Environment：光照、雾与夜间可用能见度', () => {
  const noon = new Environment({ lat: 0, lon: 0, date: '1942-06-21T12:00:00Z', seed: 1 });
  const night = new Environment({ lat: 0, lon: 0, date: '1942-06-21T00:00:00Z', seed: 1 });
  assert.ok(noon.lightLevel > 0.9, '正午光照 ' + noon.lightLevel.toFixed(3));
  assert.ok(night.lightLevel < 0.20, '午夜光照 ' + night.lightLevel.toFixed(3));
  assert.ok(Math.abs(noon.timeOfDayH - 12) < 0.01, '经度 0 时 timeOfDayH=UTC 小时');
  const fog = new Environment({ lat: 0, lon: 0, date: '1942-06-21T12:00:00Z', seed: 1, visibilityNm: 12, fogDensity: 0.8 });
  assert.ok(fog.visibilityNm < 3, '浓雾能见度应 <3nmi，实际 ' + fog.visibilityNm.toFixed(2));
  const dayShip = { pos: { x: 0, y: 0 } };
  assert.ok(noon.horizontalVisibilityNm(dayShip) <= noon.visibilityNm + 1e-9);
  assert.ok(night.horizontalVisibilityNm(dayShip) < noon.horizontalVisibilityNm(dayShip), '夜间可用目视距离应小于白天');
});

test('烟幕：平流漂移、湍流扩散与遮蔽率', () => {
  const env = new Environment({ lat: 0, lon: 0, date: '1942-06-01T12:00:00Z', seed: 3, windKn: 20, windDirDeg: 270, seaState: 3 });
  const c = env.spawnSmoke(0, 0, 0.8, { r: 80 });
  assert.ok(Math.abs(env.smokeDensityAt(0, 0) - 0.8) < 1e-6, '烟团中心遮蔽率=浓度');
  for (let i = 0; i < 600; i++) env.stepSmoke(1);
  assert.ok(c.x > 2500, '西风(270°)应把烟团吹向东(+x)，实际 x=' + c.x.toFixed(0));
  assert.ok(Math.abs(c.y) < 50, '侧向无漂移，实际 y=' + c.y.toFixed(1));
  assert.ok(c.r > 300, '湍流扩散应使半径增长，实际 r=' + c.r.toFixed(0));
  assert.ok(c.density < 0.35 && c.density > 0.02, '浓度应被稀释，实际 ' + c.density.toFixed(3));
  assert.ok(env.smokeDensityAt(c.x, c.y) > env.smokeDensityAt(0, 0), '源区应已稀释');
  // 多个烟团按 (1-τ) 连乘，不得 >1
  env.spawnSmoke(0, 0, 0.9, { r: 50 }); env.spawnSmoke(0, 0, 0.9, { r: 50 });
  assert.ok(env.smokeDensityAt(0, 0) <= 1);
});

test('雨飑：生成、漂移与局部能见度下降', () => {
  const env = new Environment({ lat: 10, lon: 150, date: '1942-08-01T12:00:00Z', seed: 11, windKn: 18, windDirDeg: 90, seaState: 4, squallRatePerHour: 12, visibilityNm: 10 });
  for (let i = 0; i < 3600; i++) env.step(1);
  assert.ok(env.squalls.length >= 2, '12 次/小时的生成率下 1h 应至少有 2 个飑，实际 ' + env.squalls.length);
  const sq = env.squalls[0];
  assert.ok(sq.r > 2200, '飑的边缘应随生命史扩张，实际 r=' + sq.r.toFixed(0));
  const atSquall = env.horizontalVisibilityNm({ pos: { x: sq.x, y: sq.y } });
  const farAway = env.horizontalVisibilityNm({ pos: { x: sq.x + 200000, y: sq.y } });
  assert.ok(atSquall < farAway, '飑内可用能见度应低于远处：' + atSquall.toFixed(2) + ' vs ' + farAway.toFixed(2));
});

test('洋流：M2 半日潮往复流', () => {
  const env = new Environment({ lat: 0, lon: 0, date: '1942-06-01T12:00:00Z', seed: 5, currentKn: 2, currentDirDeg: 45 });
  const seen = new Set();
  let minKn = 99, maxKn = -1;
  for (let i = 0; i < 7 * 3600; i++) { env.step(1); seen.add(Math.round(env.currentDirDeg / 45) * 45); minKn = Math.min(minKn, env.currentKn); maxKn = Math.max(maxKn, env.currentKn); }
  assert.ok(seen.has(45) && seen.has(225), '7h 内潮流应换向，seen=' + Array.from(seen).join(','));
  assert.ok(minKn >= 2 * 0.35 - 1e-6 && maxKn <= 2 + 1e-6, '流速应在 0.7~2.0kn 之间');
  const c = env.currentAt(0, 0);
  assert.ok(Math.abs(c.vx * c.vx + c.vy * c.vy - Math.pow(c.kn * 0.514444, 2)) < 1e-6, '流速矢量一致');
});

// ================================================================ 舰体运动
test('首浪失速：DD 在 25kn+ 顶浪与顺浪的差异', () => {
  const mk = (heading, seaState, windKn) => {
    const w = makeWorld(DD, specFor('D1', heading, 20), { windKn, windDirDeg: 0, swellDirDeg: 0, seaState, visibilityNm: 10 }, 5);
    const s = w.ship('D1');
    s.commanded.speed = 30;
    w.advance(900);
    return s.speed;
  };
  const head = mk(0, 7, 40);        // 浪来向正北，舰艏正北 → 顶浪
  const follow = mk(180, 7, 40);    // 顺浪
  const calm = mk(0, 0, 0);
  assert.ok(head < 28.0, '顶浪实测失速后应低于 28kn，实际 ' + head.toFixed(2));
  assert.ok(follow - head > 2.0, '顺浪应比顶浪快 >2kn：顺 ' + follow.toFixed(2) + ' / 顶 ' + head.toFixed(2));
  assert.ok(head < calm - 2.0, '顶浪应比静水有明显失速：静水 ' + calm.toFixed(2) + ' / 顶浪 ' + head.toFixed(2));
  assert.ok(follow <= 31.0, '顺浪不得凭空超过车钟 30kn 太多');
  console.log('[样例] DD 车钟30kn：静水 ' + calm.toFixed(2) + 'kn / 顶浪 ' + head.toFixed(2) + 'kn / 顺浪 ' + follow.toFixed(2) + 'kn（海况7, 40kn 风）');
});

test('功率-航速：v ∝ P^(1/3)（主轴/锅炉受损）', () => {
  const w = makeWorld(DD, specFor('D1', 0, 30), { windKn: 0, seaState: 0, visibilityNm: 10 }, 9);
  const s = w.ship('D1');
  s.damageSubsystem('SHAFT', 0, 1);            // DD 双轴，损一轴 → 50% 功率
  s.commanded.speed = 40.9;
  assert.ok(Math.abs(availablePowerFrac(s) - 0.5) < 0.02, '损一轴后可用功率应≈0.5，实际 ' + availablePowerFrac(s).toFixed(3));
  w.advance(2400);
  const expect = 40.9 * Math.cbrt(0.5);
  assert.ok(Math.abs(s.speed - expect) < 0.9, '50% 功率稳态航速应≈' + expect.toFixed(2) + 'kn，实际 ' + s.speed.toFixed(2));

  const w2 = makeWorld(DD, specFor('D1', 0, 30), { windKn: 0, seaState: 0, visibilityNm: 10 }, 9);
  const s2 = w2.ship('D1');
  s2.damageSubsystem('BOILER', 0, 1); s2.damageSubsystem('BOILER', 1, 1);   // DD 三锅炉，损二 → 1/3 功率
  s2.commanded.speed = 40.9;
  w2.advance(2400);
  const e2 = 40.9 * Math.cbrt(1 / 3);
  assert.ok(Math.abs(s2.speed - e2) < 0.9, '1/3 功率稳态航速应≈' + e2.toFixed(2) + 'kn，实际 ' + s2.speed.toFixed(2));
  console.log('[样例] 损一轴(50%功率)稳态 ' + s.speed.toFixed(2) + 'kn（理论 ' + expect.toFixed(2) + '）；损二锅炉(33%功率)稳态 ' + s2.speed.toFixed(2) + 'kn（理论 ' + e2.toFixed(2) + '）');
});

test('回转：35° 舵角 20kn 的回转率与回转半径（对比 turnRadiusAt20kn_m）', () => {
  const w = makeWorld(CA, specFor('CA1', 0, 20), { windKn: 8, seaState: 1, visibilityNm: 10 }, 7);
  const s = w.ship('CA1');
  s.commanded.rudder = 35;
  w.advance(420);
  assert.ok(Math.abs(s.rudder - 35) < 0.01, '舵应到 35°，实际 ' + s.rudder.toFixed(2));
  const h1 = s.heading, v1 = s.speed;
  w.advance(60);
  const rate = Math.abs(normDeg180(s.heading - h1)) / 60;         // deg/s
  const radius = kn2mps(s.speed) / deg2rad(rate);
  const expectRate = 20 * 0.514444 / 700 * 57.2958;               // 数据值 20kn/700m
  assert.ok(s.turnRate > 0, '右舵应向右转（航向增加）');
  assert.ok(Math.abs(rate - expectRate) / expectRate < 0.15,
    '回转率应接近数据值 ' + expectRate.toFixed(3) + ' deg/s，实际 ' + rate.toFixed(3));
  assert.ok(Math.abs(radius - 700) / 700 < 0.15, '回转半径应接近 700m，实际 ' + radius.toFixed(0) + 'm');
  assert.ok(s.speed < 20, '满舵回转应掉速，实际 ' + s.speed.toFixed(2));
  assert.ok(Math.abs(steadyTurnRateDegS(s, s.speed, 35) - s.turnRate) < 0.15, '稳态解应与实测回转率一致');
  console.log('[样例] CA(数据 R20=700m) 35°舵：实测回转率 ' + rate.toFixed(3) + ' deg/s（理论 ' + expectRate.toFixed(3) + '），回转半径 ' + radius.toFixed(0) + 'm，回转中航速 ' + s.speed.toFixed(2) + 'kn');
});

test('横摇：固有周期与浪向响应（横浪 >> 顶浪）', () => {
  const tDD = naturalRollPeriodS({ data: DD, gm0M: 1.0 });
  assert.ok(tDD > 8 && tDD < 10, 'DD(GM=1m,B=11.2m) 横摇周期应≈9s，实际 ' + tDD.toFixed(2));
  const tBig = naturalRollPeriodS({ data: { beam_m: 38.9, gm_m: 3 }, gm0M: 3 });
  assert.ok(tBig > 16 && tBig < 20, '大型 BB(GM=3m,B=38.9m) 横摇周期应≈18s，实际 ' + tBig.toFixed(2));

  const rollMax = (heading) => {
    const w = makeWorld(DD, specFor('D1', heading, 15), { windKn: 30, windDirDeg: 0, swellDirDeg: 0, seaState: 5, visibilityNm: 10 }, 13);
    const s = w.ship('D1');
    s.commanded.speed = 15;
    let mx = 0;
    for (let i = 0; i < 600; i++) { w.advance(1); if (i > 200) mx = Math.max(mx, Math.abs(s.roll)); }
    return mx;
  };
  const beam = rollMax(90);
  const head = rollMax(0);
  assert.ok(beam > 5, '横浪中 DD 应有明显横摇，实际 ' + beam.toFixed(2) + '°');
  assert.ok(beam > head + 3, '横浪横摇应远大于顶浪：横 ' + beam.toFixed(2) + '° / 顶 ' + head.toFixed(2) + '°');
  console.log('[样例] 横摇固有周期：DD ' + tDD.toFixed(2) + 's，BB(GM3m/B38.9m) ' + tBig.toFixed(2) + 's；海况5 横浪最大横摇 ' + beam.toFixed(2) + '° / 顶浪 ' + head.toFixed(2) + '°');
});

test('确定性：同种子两次运行完全一致', () => {
  const run = () => {
    const w = makeWorld(DD, specFor('D1', 20, 18), { windKn: 22, windDirDeg: 200, seaState: 4, visibilityNm: 10 }, 202);
    const s = w.ship('D1');
    s.commanded.heading = 110;
    w.advance(600);
    return JSON.stringify({
      ship: { x: s.pos.x, y: s.pos.y, h: s.heading, sp: s.speed, roll: s.roll, pitch: s.pitch, rud: s.rudder, cap: s.speedCapKn },
      env: { w: w.env.windKn, wd: w.env.windDirDeg, ws: w.env.hsWindSeaM, sw: w.env.hsSwellM, sea: w.env.seaState, vis: w.env.visibilityNm, fog: w.env.fogDensity },
    });
  };
  assert.equal(run(), run());
});

test('管线：事件发射、烟雾云生成、visibleStateFor 字段齐全', () => {
  const w = makeWorld(DD, specFor('D1', 0, 12), { windKn: 15, windDirDeg: 300, seaState: 3, visibilityNm: 10 }, 77);
  const s = w.ship('D1');
  s.commanded.heading = 120;
  s.flags.smokeOn = true;
  w.env.pendingEvents.push({ type: 'env.squall', t: 0, data: { x: 1, y: 2, r: 500, visNm: 1 } });
  w.advance(300);
  const types = new Set(w.events.history.map((e) => e.type));
  assert.ok(types.has('ship.course'), '应发射 ship.course，实际 ' + Array.from(types).join(','));
  assert.ok(types.has('ship.speed'), '应发射 ship.speed');
  assert.ok(types.has('env.squall'), 'env 暂存事件应由 dynamics 转发到 world.events');
  assert.equal(w.env.pendingEvents.length, 0, '转发后暂存队列应清空');
  assert.ok(w.env.smokeClouds.length > 0, '发烟舰应生成 smokeClouds');
  assert.ok(w.env.smokeDensityAt(s.pos.x, s.pos.y) > 0.1, '发烟舰位置应有烟幕遮蔽');
  assert.ok(Number.isInteger(w.env.seaState) && w.env.seaState >= 0 && w.env.seaState <= 9, 'Environment.seaState 必须是整数，实际 ' + w.env.seaState);
  assert.equal(w.env.seaState, 3, '场景 seaState=3 应稳定上报为 3（级中点初始化），实际 ' + w.env.seaState);
  for (const c of w.env.smokeClouds) {
    assert.ok(c.r > 20 && c.r < 8000, '烟团半径单位为米（20~8000m），实际 ' + c.r);
    assert.ok(typeof c.source === 'string' && c.density >= 0 && c.density <= 1, 'smokeClouds 元素格式 {x,y,r,density,source}');
  }
  const st = w.visibleStateFor('ALLIED');
  for (const k of ['seaState', 'windDirDeg', 'windKn', 'visibilityNm', 'lightLevel', 'sunriseH', 'sunsetH', 'moonIllum', 'timeOfDayH']) {
    assert.ok(st.environment[k] !== undefined && Number.isFinite(st.environment[k]), 'visibleStateFor 缺少 ' + k);
  }
  assert.ok(st.environment.timeOfDayH >= 0 && st.environment.timeOfDayH < 24);
  assert.ok(st.environment.lightLevel >= 0 && st.environment.lightLevel <= 1);
});
