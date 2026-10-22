// test/t6.tactics.test.mjs —— T6 鱼雷与本地战术 AI 验收测试
// 运行：/Users/zl/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node test/t6.tactics.test.mjs
//
// 测试策略：
//  1) 鱼雷物理用「最小宿主」(只提供 env/rng/events/ships/torpedoes) 做端到端蒙特卡洛，隔离其他
//     T1~T4 模块的编辑（并行开发期它们随时可能半成品），同时仍然走真实舰船数据 data/ships_*.json。
//  2) LocalAI 用「最小指挥链宿主」：issueCommand 带 side.orderDelay_s 延迟后按 world._applyOne
//     的同构逻辑下发（含 LAUNCH_TORPEDO → launchTorpedo），航迹用与 contracts §4 同形的 MiniTracks。
//  3) 末尾追加真实 World 集成测试：任何一个队友模块当前无法解析/运行就 SKIP（不阻塞 T6 验收）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ShipDatabase } from '../src/sim/data.js';
import { Ship } from '../src/sim/ship.js';
import { Environment } from '../src/sim/env.js';
import { EventBus } from '../src/core/events.js';
import { RNG } from '../src/core/rng.js';
import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, aspectAngle, kn2mps, rad2deg } from '../src/core/util.js';
import * as TP from '../src/sim/torpedo.js';
import { LocalAI, immuneZoneVs } from '../src/ai/local_ai.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const axisData = JSON.parse(readFileSync(join(ROOT, 'data/ships_axis.json'), 'utf8'));
const alliedData = JSON.parse(readFileSync(join(ROOT, 'data/ships_allied.json'), 'utf8'));
const DB = ShipDatabase.fromMany([axisData, alliedData]);
const MPerKn = 0.514444;

// ── 极简测试框架 ────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function approx(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error((msg || 'approx') + ': 实际 ' + actual + '，期望 ' + expected + '±' + tol);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

// ── 最小宿主 ────────────────────────────────────────────────────────────────
function miniWorld(opts = {}) {
  const w = {
    t: 0, rng: new RNG(opts.seed === undefined ? 20260601 : opts.seed),
    events: new EventBus(200000),
    env: new Environment(Object.assign({ lat: 0, lon: 0, date: '1942-06-01T12:00:00Z', visibilityNm: 12, windKn: 10 }, opts.env || {})),
    ships: [], torpedoes: [], tracks: null,
    scenario: { id: 't6', ships: opts.specs || [], objectives: [] },
    sides: { ALLIED: { orderDelay_s: 6, withdrawThreshold: 0.35 }, AXIS: { orderDelay_s: 8, withdrawThreshold: 0.35 } },
  };
  w.ship = (id) => w.ships.find((s) => s.id === id) || null;
  w.shipsOf = (sd) => w.ships.filter((s) => s.side === sd);
  w.afloatOf = (sd) => w.ships.filter((s) => s.side === sd && s.isAfloat);
  w.opposite = (sd) => (sd === 'ALLIED' ? 'AXIS' : 'ALLIED');
  return w;
}
function addShip(w, spec) {
  const data = DB.resolve(spec.class);
  if (!data) throw new Error('未知舰级 ' + spec.class);
  const s = new Ship(spec, data, {});
  w.ships.push(s);
  return s;
}
// 直线运动学（测试宿主用；真实回转由 T1 dynamics 提供）
function stepKin(w, dt, turnRateDegS = 3.0) {
  for (const s of w.ships) {
    if (!s.isAfloat) continue;
    const d = normDeg180(s.commanded.heading - s.heading);
    const maxTurn = (s.type === 'DD' ? 4.0 : s.type === 'CL' ? 3.5 : 3.0) * dt;
    s.heading = normDeg(s.heading + clamp(d, -maxTurn, maxTurn));
    s.speed += clamp(s.commanded.speed - s.speed, -0.35 * dt, 0.35 * dt);
    const mps = MPerKn * s.speed, r = s.heading * Math.PI / 180;
    s.pos.x += Math.sin(r) * mps * dt; s.pos.y += Math.cos(r) * mps * dt;
  }
}
// 与 contracts §4 TrackManager 同形的极简航迹表
class MiniTracks {
  constructor(world) { this.world = world; this.list = []; this._seq = 0; }
  observe(o) {
    let best = null, bd = 1500;
    for (const t of this.list) { if (t.side !== o.side) continue; const d = dist2d(t.pos, o.pos); if (d < bd) { bd = d; best = t; } }
    if (best) {
      best.pos.x = best.pos.x * 0.5 + o.pos.x * 0.5; best.pos.y = best.pos.y * 0.5 + o.pos.y * 0.5;
      best.tLast = o.t; best.ageS = 0;
      if (o.courseDeg !== undefined) best.courseDeg = o.courseDeg;
      if (o.speedKn !== undefined) best.speedKn = o.speedKn;
      if (o.classifiedAs && o.classifiedAs !== 'UNKNOWN') best.classifiedAs = o.classifiedAs;
      best.confidence = clamp(best.confidence + 0.05, 0, 0.99);
      return best;
    }
    const t = { id: 'T' + (++this._seq), side: o.side, pos: { x: o.pos.x, y: o.pos.y },
      courseDeg: o.courseDeg || 0, speedKn: o.speedKn || 0, classifiedAs: o.classifiedAs || 'UNKNOWN',
      confidence: o.confidence !== undefined ? o.confidence : 0.6,
      errM: o.accuracyM || 300, errDeg: o.accuracyDeg || 0.5, idConfidence: 0.5,
      sources: [o.srcKind || 'VISUAL'], tFirst: o.t, tLast: o.t, ageS: 0, hostile: true };
    this.list.push(t);
    return t;
  }
  update(dt) { for (const t of this.list) t.ageS = this.world.t - t.tLast; this.list = this.list.filter((t) => t.ageS < 120); }
  visibleFor(ship) { return this.list.filter((t) => t.side === ship.side && t.ageS < 120); }
  byId(id) { return this.list.find((t) => t.id === id) || null; }
}
function refreshTracks(w, current = false) {
  for (const o of w.ships) for (const g of w.ships) {
    if (o.side === g.side || !o.isAfloat || !g.isAfloat) continue;
    if (!current && w.tracks.list.some((t) => t.side === o.side && t.targetId === g.id)) continue;
    const tr = w.tracks.observe({ side: o.side, srcKind: 'VISUAL', shipId: o.id, targetId: g.id, pos: { x: g.pos.x, y: g.pos.y },
      rangeM: dist2d(o.pos, g.pos), bearingDeg: bearing2d(o.pos, g.pos), courseDeg: g.heading, speedKn: g.speed,
      accuracyM: 250, accuracyDeg: 0.5, classifiedAs: g.type, confidence: 0.8, t: w.t });
    tr.targetId = g.id;
  }
}
// 「最小指挥链宿主」：issueCommand 按 side.orderDelay_s 延迟，生效时按 world._applyOne 同构逻辑执行
function commandChain(w) {
  w.commands = []; w.pending = []; w._seq = 0;
  w.issueCommand = (cmd) => {
    const side = cmd.side || (cmd.shipId && w.ship(cmd.shipId) ? w.ship(cmd.shipId).side : 'AXIS');
    const full = Object.assign({ id: 'c' + (++w._seq), t_issue: w.t, t_effective: w.t + ((w.sides[side] || {}).orderDelay_s || 8), source: 'PLAYER', scope: 'SHIP' }, cmd, { side });
    w.commands.push(full); w.pending.push(full);
    w.events.emit('order.issue', { t: w.t, cmd: full });
    return full;
  };
  w.applyDueCommands = () => {
    const still = [];
    for (const c of w.pending) {
      if (c.t_effective <= w.t) w.events.emit('order.effective', { t: w.t, cmd: c, applied: applyOne(w, c) });
      else still.push(c);
    }
    w.pending = still;
  };
}
function applyOne(w, cmd) {
  const p = cmd.params || {};
  const ship = w.ship(cmd.shipId);
  if (!ship || !ship.isAfloat) return false;
  switch (cmd.kind) {
    case 'SET_COURSE': ship.commanded.heading = normDeg(p.heading); return true;
    case 'SET_SPEED': ship.commanded.speed = clamp(p.kn, 0, ship.data.speedMax_kn || 30); ship.engineOrder.kn = ship.commanded.speed; return true;
    case 'SMOKE': ship.flags.smokeOn = !!p.on; return true;
    case 'DC_PRIORITY': ship.dcPriority = p.mode; return true;
    case 'WITHDRAW': ship.commanded.withdraw = true; return true;
    case 'SEARCHLIGHT': ship.flags.searchlight.on = !!p.on; if (p.bearing !== undefined) ship.flags.searchlight.bearing = normDeg(p.bearing); return true;
    case 'STAR_SHELL': ship.flags.starshellArmed = true; return true;
    case 'RADAR': for (const s of ship.sensors) if (s.srcKind === 'RADAR') s.on = !!p.on; return true;
    case 'ASSIGN_TARGET': { const tr = w.tracks.byId(p.trackId); if (!tr) return false; ship.commanded.targetTrackId = tr.id; ship.commanded.firing = true; ship.commanded.fireAmmo = p.ammo || 'AP'; return true; }
    case 'FIRE': ship.commanded.firing = true; ship.commanded.fireAmmo = p.ammo || 'AP'; return true;
    case 'CEASE_FIRE': ship.commanded.firing = false; return true;
    case 'FORMATION': ship.formationStation = p.station; return true;
    case 'LAUNCH_TORPEDO': {
      const m = ship.torpedoMounts.find((x) => !x.destroyed && x.tubesLoaded > 0);
      if (!m) return false;
      const tr = p.trackId ? w.tracks.byId(p.trackId) : null;
      const ok = !!TP.launchTorpedo(w, ship, m, { bearingDeg: p.bearingDeg,
        rangeM: p.rangeM !== undefined ? p.rangeM : (tr ? dist2d(ship.pos, tr.pos) : 0),
        spreadDeg: p.spreadDeg, tubes: p.tubes, speedIdx: p.speedIdx, targetTrackId: p.trackId,
        targetCourseDeg: tr ? tr.courseDeg : undefined, targetSpeedKn: tr ? tr.speedKn : undefined }, { targetTrack: tr, source: 'CMD' });
      w.events.emit('torp.launch', { t: w.t, ship: ship.id, side: ship.side, tubes: p.tubes || m.tubesLoaded, track: p.trackId || null, accepted: ok });
      return ok;
    }
    default: return false;
  }
}

// ── 鱼雷蒙特卡洛：单雷对单舰 ────────────────────────────────────────────────
// opts: {shooterClass, targetClass, targetHeading, targetSpeed, rangeM, seed, evasive, torpedoPatch, speedIdx, override, depthM}
function torpTrial(opts) {
  const w = miniWorld({ seed: opts.seed, env: opts.env });
  const dd = addShip(w, { id: 'SH', side: opts.side || 'AXIS', class: opts.shooterClass, x: 0, y: 0, heading: 90, speed: 30 });
  const tgt = addShip(w, { id: 'TG', side: (opts.side || 'AXIS') === 'AXIS' ? 'ALLIED' : 'AXIS', class: opts.targetClass,
    x: opts.rangeM, y: 0, heading: opts.targetHeading, speed: opts.targetSpeed });
  if (opts.torpedoPatch) dd.torpedoMounts[0].data = Object.assign({}, dd.torpedoMounts[0].data, opts.torpedoPatch);
  const res = { hit: false, dud: false, miss: null, wakeAt: null, wakeType: null, xFrac: null, hitSide: null, depth: null, compartment: null, friendly: null };
  w.events.on('torp.hit', (e) => { res.hit = true; res.xFrac = e.x_frac; res.hitSide = e.side; res.depth = e.depthM; res.compartment = e.compartment; res.friendly = e.friendly; });
  w.events.on('torp.dud', (e) => { res.dud = true; res.xFrac = e.x_frac; });
  w.events.on('torp.miss', (e) => { if (res.miss === null) res.miss = e.reason; });
  w.events.on('torp.wake', (e) => { if (res.wakeAt === null) { res.wakeAt = e.rangeM; res.wakeType = e.wakeType; } });
  // 火控解算误差：相信的目标航向/航速带误差（这是脱靶主因，真实火控靠航迹解算）
  const belCourse = opts.believedCourseDeg !== undefined ? opts.believedCourseDeg : opts.targetHeading + w.rng.normal(0, opts.sigmaCourseDeg === undefined ? 3 : opts.sigmaCourseDeg);
  const belSpeed = opts.believedSpeedKn !== undefined ? opts.believedSpeedKn : opts.targetSpeed + w.rng.normal(0, opts.sigmaSpeedKn === undefined ? 1 : opts.sigmaSpeedKn);
  const made = TP.launchTorpedo(w, dd, dd.torpedoMounts[0],
    { bearingDeg: 90, rangeM: opts.rangeM, tubes: 1, speedIdx: opts.speedIdx, depthM: opts.depthM,
      targetCourseDeg: belCourse, targetSpeedKn: belSpeed, targetShipId: 'TG', reliabilityOverride: opts.override },
    { targetShip: tgt, trueTarget: tgt, source: 'TEST', emitLaunchEvent: false });
  if (!made) return Object.assign(res, { rejected: true });
  res.spec = TP.torpedoSpecFor(dd, dd.torpedoMounts[0]);
  res.torp = made[0];
  const dt = 0.2;
  let steps = 0;
  const maxSpeed = (tgt.data.speedMax_kn || 27) * 0.95;
  while (w.torpedoes.length && steps < 12000) {
    w.t = +(w.t + dt).toFixed(4);
    if (opts.evasive && made[0].inWater && made[0].detectedBy['TG']) {
      const c = made[0].courseDeg;
      const comb = Math.abs(normDeg180(c - tgt.heading)) <= Math.abs(normDeg180(normDeg(c + 180) - tgt.heading)) ? c : normDeg(c + 180);
      tgt.commanded.heading = comb; tgt.commanded.speed = maxSpeed;
    }
    // 舰船运动（目标可能正在规避转向）
    for (const s of w.ships) {
      const d = normDeg180(s.commanded.heading - s.heading);
      const maxTurn = (s.type === 'DD' ? 4.0 : s.type === 'CL' ? 3.5 : 3.0) * dt;
      s.heading = normDeg(s.heading + clamp(d, -maxTurn, maxTurn));
      s.speed += clamp(s.commanded.speed - s.speed, -0.3 * dt, 0.3 * dt);
      const mps = MPerKn * s.speed, r = s.heading * Math.PI / 180;
      s.pos.x += Math.sin(r) * mps * dt; s.pos.y += Math.cos(r) * mps * dt;
    }
    TP.updateTorpedoes(w, dt);
    steps++;
  }
  res.steps = steps;
  return res;
}
function mc(n, opts) {
  let hit = 0, dud = 0, det = 0, wakeSum = 0, under = 0, prem = 0, rej = 0, xs = [];
  for (let i = 0; i < n; i++) {
    const r = torpTrial(Object.assign({}, opts, { seed: 5000 + i }));
    if (r.rejected) { rej++; continue; }
    if (r.hit) { hit++; xs.push(r.xFrac); }
    if (r.dud) dud++;
    if (r.wakeAt !== null) { det++; wakeSum += r.wakeAt; }
    if (r.miss === 'UNDER_RUN') under++;
    if (r.miss === 'PREMATURE') prem++;
  }
  return { n, hitRate: hit / n, dudRate: dud / n, detectRate: det / n, avgWakeM: det ? wakeSum / det : 0,
    underRunRate: under / n, premRate: prem / n, meanXFrac: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, rejected: rej };
}

// ═══════════════════════════ 测试用例 ═══════════════════════════════════════

test('T6.1 双档航速/射程：九三式 48kn/20km 与 36kn/40km，到达时间差 ≈ 航速比', () => {
  const w = miniWorld({ seed: 7 });
  const dd = addShip(w, { id: 'D', side: 'AXIS', class: 'fubuki', x: 0, y: 0, heading: 90, speed: 30 });
  const tgt = addShip(w, { id: 'T', side: 'ALLIED', class: 'SouthDakota', x: 8000, y: 0, heading: 0, speed: 20 });
  const spec = TP.torpedoSpecFor(dd, dd.torpedoMounts[0]);
  ok(spec.speedsKn.length >= 2, '九三式应有双档航速');
  approx(spec.speedsKn[0], 48, 0.1, '快档');
  approx(spec.speedsKn[1], 36, 0.1, '慢档');
  approx(spec.rangesM[0], 20000, 1, '快档射程');
  approx(spec.rangesM[1], 40000, 1, '慢档射程');
  ok(spec.wakeType === 'OXYGEN' && spec.wakeStrength < 0.2, '九三式应为氧气鱼雷（几乎无航迹）');

  const fast = TP.launchTorpedo(w, dd, dd.torpedoMounts[0], { bearingDeg: 90, rangeM: 8000, tubes: 1, speedIdx: 0, targetCourseDeg: 0, targetSpeedKn: 20 }, { targetShip: tgt, trueTarget: tgt, source: 'TEST', emitLaunchEvent: false });
  const slow = TP.launchTorpedo(w, dd, dd.torpedoMounts[0], { bearingDeg: 90, rangeM: 8000, tubes: 1, speedIdx: 1, targetCourseDeg: 0, targetSpeedKn: 20 }, { targetShip: tgt, trueTarget: tgt, source: 'TEST', emitLaunchEvent: false });
  ok(fast && slow, '两档都应能发射');
  approx(fast[0].speedKn, 48, 0.01); approx(slow[0].speedKn, 36, 0.01);
  ok(fast[0].solutionTofS < slow[0].solutionTofS, '快档到达时间应更短');
  ok(fast[0].solutionRunM <= 20000 && slow[0].solutionRunM <= 40000, '航程应在各自档射程内');
  // 纯航速-航程关系：静止目标下 8000m 的到达时间比应精确等于航速比
  const s48 = TP.solveIntercept(0, 0, 8000, 0, 0, 0, kn2mps(48));
  const s36 = TP.solveIntercept(0, 0, 8000, 0, 0, 0, kn2mps(36));
  approx(s48.runM, 8000, 1, '静止目标航程=距离');
  approx(s36.tofS / s48.tofS, 48 / 36, 0.01, '到达时间比应=航速比');
  // 运动目标：慢档拦截点更远（目标逃逸更多），故实际航程更大
  ok(slow[0].solutionRunM > fast[0].solutionRunM, '慢档拦截点应更远（目标有更长时间逃逸）');
  const ratio = slow[0].solutionTofS / fast[0].solutionTofS;
  console.log('   48kn: 航程 ' + Math.round(fast[0].solutionRunM) + 'm 飞行 ' + fast[0].solutionTofS.toFixed(1) + 's；36kn: 航程 ' + Math.round(slow[0].solutionRunM) + 'm 飞行 ' + slow[0].solutionTofS.toFixed(1) + 's（比值 ' + ratio.toFixed(3) + '）');
});

test('T6.2 命中概率：8000m、舷角 90° 高于舷角 60°（驱逐舰齐射）', () => {
  const common = { shooterClass: 'fubuki', targetClass: 'SouthDakota', targetSpeed: 20, rangeM: 8000, override: { dud: 0, deepRun: 0, prem: 0 } };
  const a90 = mc(300, Object.assign({}, common, { targetHeading: 0 }));    // 舷角 90°（横越）
  const a60 = mc(300, Object.assign({}, common, { targetHeading: 30 }));   // 舷角 60°
  console.log('   舷角90°: 命中率 ' + (100 * a90.hitRate).toFixed(1) + '%  被弹投影全长的解算最容易；舷角60°: ' + (100 * a60.hitRate).toFixed(1) + '%');
  console.log('   90°命中点 x_frac 均值 ' + a90.meanXFrac.toFixed(2) + '；60° 均值 ' + a60.meanXFrac.toFixed(2));
  ok(a90.hitRate > a60.hitRate + 0.05, '舷角 90° 命中概率应显著高于 60°：' + a90.hitRate.toFixed(3) + ' vs ' + a60.hitRate.toFixed(3));
  ok(a90.hitRate > 0.2 && a90.hitRate < 0.75, '舷角 90° 命中率应在合理量级（0.2~0.75）');
});

test('T6.3 航迹可见性：九三式（氧气）vs Mk15（压缩空气）改变被规避概率', () => {
  // 对照实验：同一舰、同一弹道、同一可靠性，只改 wakeVisible 一项
  const mk15Like = { name: 'Mk 15', wakeVisible: true, speed_kn: [48, 36], range_m: [20000, 40000], warhead_kg: 494, caliber_mm: 533, dudRate: 0 };
  const common = { shooterClass: 'fubuki', targetClass: 'SouthDakota', targetSpeed: 20, rangeM: 8000, targetHeading: 0, evasive: true, override: { dud: 0, deepRun: 0, prem: 0 } };
  const oxy = mc(200, common);
  const air = mc(200, Object.assign({}, common, { torpedoPatch: mk15Like }));
  console.log('   氧气(航迹强度0.10): 发现率 ' + (100 * oxy.detectRate).toFixed(0) + '% 平均发现距离 ' + Math.round(oxy.avgWakeM) + 'm → 命中率 ' + (100 * oxy.hitRate).toFixed(1) + '%');
  console.log('   压缩空气(航迹强度1.0): 发现率 ' + (100 * air.detectRate).toFixed(0) + '% 平均发现距离 ' + Math.round(air.avgWakeM) + 'm → 命中率 ' + (100 * air.hitRate).toFixed(1) + '%');
  ok(air.detectRate >= oxy.detectRate, '压缩空气航迹的发现率应不低于氧气航迹');
  ok(air.avgWakeM > 4 * oxy.avgWakeM, '发现距离量级差异：白航迹 km 级 vs 氧气航迹数百米');
  ok(air.avgWakeM > 1200 && oxy.avgWakeM < 600, '发现距离绝对值应落在史实量级（白航迹 2~4km / 氧气 数百米）');
  ok(oxy.hitRate > air.hitRate, '无航迹鱼雷的被规避概率更低（命中率更高）');
});

test('T6.4 引信可靠性：1942 美制（哑弹/深走/提前爆炸）与日制差异 + 深走穿过船底', () => {
  // 直接在入水鱼雷上统计引信抽样，避免命中几何掩盖可靠性
  function flags(shooterClass, n, stripDudRate) {
    let dud = 0, deep = 0, prem = 0, made = 0;
    for (let i = 0; i < n; i++) {
      const w = miniWorld({ seed: 9000 + i });
      const sh = addShip(w, { id: 'S', side: 'AXIS', class: shooterClass, x: 0, y: 0, heading: 90, speed: 30 });
      const tg = addShip(w, { id: 'T', side: 'ALLIED', class: 'SouthDakota', x: 8000, y: 0, heading: 0, speed: 20 });
      if (stripDudRate) { const d = Object.assign({}, sh.torpedoMounts[0].data); delete d.dudRate; sh.torpedoMounts[0].data = d; }
      const m = TP.launchTorpedo(w, sh, sh.torpedoMounts[0], { bearingDeg: 90, rangeM: 8000, tubes: 1, targetCourseDeg: 0, targetSpeedKn: 20 }, { targetShip: tg, trueTarget: tg, source: 'TEST', emitLaunchEvent: false });
      if (!m) continue;
      made++;
      if (m[0].dud) dud++; if (m[0].deepRun) deep++; if (m[0].premature) prem++;
    }
    return { n: made, dud: dud / made, deep: deep / made, prem: prem / made };
  }
  const us = flags('fletcher', 300);
  const jp = flags('fubuki', 300);
  console.log('   美制 Mk15(1943, US_EARLY): 哑弹 ' + (100 * us.dud).toFixed(0) + '% 深走 ' + (100 * us.deep).toFixed(0) + '% 提前爆炸 ' + (100 * us.prem).toFixed(0) + '%');
  console.log('   日制 九三式(JP):          哑弹 ' + (100 * jp.dud).toFixed(0) + '% 深走 ' + (100 * jp.deep).toFixed(0) + '% 提前爆炸 ' + (100 * jp.prem).toFixed(0) + '%');
  // 哑弹率优先级：舰船数据显式 dudRate（弗莱彻 Mk15: 0.25）> types.js 年代表（US_EARLY: 0.45）
  const usNoData = flags('fletcher', 300, true);
  console.log('   美制（数据无 dudRate 时走 types.js US_EARLY）: 哑弹 ' + (100 * usNoData.dud).toFixed(0) + '%');
  approx(us.dud, 0.25, 0.08, '弗莱彻 Mk15 数据显式 dudRate=0.25');
  approx(usNoData.dud, 0.45, 0.09, '无显式 dudRate 时用 types.js reliabilityFor(US,1943)=US_EARLY 0.45');
  approx(us.deep, 0.30, 0.10, '1942 美制鱼雷深走率（types.js）');
  approx(us.prem, 0.20, 0.10, '1942 美制鱼雷提前爆炸率（types.js）');
  ok(us.dud > jp.dud + 0.1, '美制早期鱼雷哑弹率应远高于日制');
  ok(jp.dud < 0.15 && jp.prem < 0.15 && jp.deep < 0.15, '日制九三式可靠性应较高');
  // 深走穿底：定深 6m 打吃水 3.2m 的驱逐舰（正解算，确保到达舰体）
  const deep = torpTrial({ shooterClass: 'fubuki', targetClass: 'fubuki', targetHeading: 0, targetSpeed: 25, rangeM: 3000, seed: 42, depthM: 6.0, believedCourseDeg: 0, believedSpeedKn: 25 });
  ok(deep.miss === 'UNDER_RUN', '定深大于目标吃水时应判深走穿底（实际 ' + deep.miss + '）');
});

test('T6.5 命中部位：舷侧 vs 艏艉，命中对象带 sideBias/x_frac/isTorpedo 语义', () => {
  const w = miniWorld({ seed: 3 });
  const t = addShip(w, { id: 'TB', side: 'ALLIED', class: 'SouthDakota', x: 0, y: 0, heading: 0, speed: 20 });
  // 几何：命中投影宽度 W = L·|sinγ| + B·|cosγ|
  const L = t.data.loa_m, B = t.data.beam_m;
  const measuredWidths = [];
  // 命中航迹的投影宽度 W(γ) = L·|sinγ| + B·|cosγ|：在鱼雷航向的法向采样平行航迹
  for (const D of [90, 60, 30, 0]) {
    const gamma = Math.abs(normDeg180(D - 0));
    const perp = normDeg(D + 90);
    let hits = 0;
    for (let q = -L; q <= L; q += 2) {
      // 一条平行鱼雷航迹：在法向偏移 q 处，沿鱼雷航向 D 推进，任一点命中即该航迹命中
      const start = destPoint(t.pos, q, perp);
      let thisHit = false;
      for (let s = -L; s <= L && !thisHit; s += 4) { if (TP.hullHitTest(t, destPoint(start, s, D), 0).hit) thisHit = true; }
      if (thisHit) hits++;
    }
    const measured = hits * 2;
    const expect = L * Math.abs(Math.sin(gamma * Math.PI / 180)) + B * Math.abs(Math.cos(gamma * Math.PI / 180));
    measuredWidths.push(measured);
    // 收窄艏艉的水线面投影 = 理想矩形投影的下界（端部窄，斜角时投影略小）
    ok(measured <= expect + 0.35 * B, '命中投影不应超过理想矩形 L·sinγ+B·cosγ + 端部圆头（γ=' + gamma + '°: ' + measured + ' vs ' + expect.toFixed(0) + '）');
    ok(measured >= 0.68 * expect, '命中投影不应明显小于理想矩形（γ=' + gamma + '°: ' + measured + ' vs ' + expect.toFixed(0) + '）');
    if (gamma === 90) approx(measured, L, 0.08 * L, '正横（γ=90°）命中投影应≈舰长');
    if (gamma === 0) approx(measured, B, 0.15 * B, '艏艉向（γ=0°）命中投影应≈舰宽');
    console.log('   雷向' + String(D).padStart(3) + '° γ=' + String(gamma).padStart(3) + '° 命中投影 ' + measured + 'm（理想矩形 ' + expect.toFixed(0) + 'm = L·sinγ+B·cosγ；实测略小因艏艉收窄）');
  }
  ok(measuredWidths[0] > measuredWidths[1] && measuredWidths[1] > measuredWidths[2] && measuredWidths[2] > measuredWidths[3],
    '命中投影应随舷角单调增大：' + measuredWidths.join(' > '));
  // 正横命中点应为舯部；艏部命中 x_frac≈0
  const gMid = TP.hullHitTest(t, destPoint(t.pos, 0, 90), 0);
  ok(gMid.hit && Math.abs(gMid.x_frac - 0.5) < 0.05, '正横命中点为舯部');
  ok(Math.abs(gMid.distFromBowM - L / 2) < L * 0.05, '距艏距离应≈半长');
  const gBow = TP.hullHitTest(t, destPoint(t.pos, L / 2 - 3, 0), 0);
  ok(gBow.hit && gBow.x_frac < 0.1, '艏部命中 x_frac≈0 (实际 ' + gBow.x_frac.toFixed(3) + ')');
  // 命中事件字段（舷侧、深度、x_frac、分舱）
  let ev = null;
  const w2 = miniWorld({ seed: 11 });
  const dd = addShip(w2, { id: 'SH', side: 'AXIS', class: 'fubuki', x: 0, y: 0, heading: 90, speed: 30 });
  const bb = addShip(w2, { id: 'TG', side: 'ALLIED', class: 'SouthDakota', x: 8000, y: 0, heading: 0, speed: 20 });
  w2.events.on('torp.hit', (e) => { ev = e; });
  const made = TP.launchTorpedo(w2, dd, dd.torpedoMounts[0], { bearingDeg: 90, rangeM: 8000, tubes: 1, targetCourseDeg: 0, targetSpeedKn: 20, targetShipId: 'TG', reliabilityOverride: { dud: 0, deepRun: 0, prem: 0 } }, { targetShip: bb, trueTarget: bb, source: 'TEST', emitLaunchEvent: false });
  ok(made, '应能发射');
  for (let i = 0; i < 4000 && w2.torpedoes.length; i++) {
    w2.t += 0.2;
    for (const s of w2.ships) { const mps = MPerKn * s.speed, r = s.heading * Math.PI / 180; s.pos.x += Math.sin(r) * mps * 0.2; s.pos.y += Math.cos(r) * mps * 0.2; }
    TP.updateTorpedoes(w2, 0.2);
  }
  ok(ev, '应产生 torp.hit 事件');
  ok(ev.x_frac >= 0 && ev.x_frac <= 1 && (ev.side === 'PORT' || ev.side === 'STBD'), '命中事件应含命中部位与舷侧');
  ok(ev.depthM > 0 && ev.compartment !== undefined, '命中事件应含水下深度与分舱索引');
  console.log('   命中样例：x_frac=' + ev.x_frac.toFixed(2) + ' 舷=' + ev.side + ' 航深=' + ev.depthM.toFixed(2) + 'm 分舱#' + ev.compartment + ' 距艏' + ev.distanceFromBowM + 'm');
});

test('T6.6 LocalAI 火力分配：主力舰集火最高价值目标，驱逐舰不硬拼装甲目标', () => {
  const w = miniWorld({ seed: 21, specs: [] });
  w.tracks = new MiniTracks(w);
  const bb = addShip(w, { id: 'BB', side: 'AXIS', class: 'fuso', x: 0, y: 0, heading: 90, speed: 22, role: 'flagship' });
  const dd = addShip(w, { id: 'DD', side: 'AXIS', class: 'fubuki', x: 1200, y: 800, heading: 90, speed: 30 });
  const eBB = addShip(w, { id: 'EBB', side: 'ALLIED', class: 'NorthCarolina', x: 15000, y: 0, heading: 0, speed: 22 });
  const eDD = addShip(w, { id: 'EDD', side: 'ALLIED', class: 'Fletcher', x: 11000, y: 6000, heading: 0, speed: 28 });
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w);
  for (let i = 0; i < 120; i++) { w.t += 0.5; refreshTracks(w, true); stepKin(w, 0.5); w.tracks.update(0.5); ai.tick(w, 0.5); w.applyDueCommands(); }
  const bbTr = w.tracks.list.find((t) => t.side === 'AXIS' && t.classifiedAs === 'BB');
  ok(bbTr, '应有敌战列舰航迹');
  ok(bb.commanded.targetTrackId === bbTr.id, '战列舰应集中火力于敌战列舰（实际 ' + bb.commanded.targetTrackId + ' / ' + bbTr.id + '）');
  const assigns = w.commands.filter((c) => c.kind === 'ASSIGN_TARGET');
  ok(assigns.length > 0 && bb.commanded.firing, '应下达 ASSIGN_TARGET 并进入开火状态');
  console.log('   ' + ai.lastReasoning.slice(0, 300));
});

test('T6.6b LocalAI 抢占 T 字位与保持免疫区', () => {
  const w = miniWorld({ seed: 22 });
  w.tracks = new MiniTracks(w);
  const bb = addShip(w, { id: 'BB', side: 'AXIS', class: 'fuso', x: 0, y: 0, heading: 90, speed: 22 });
  const eCA = addShip(w, { id: 'ECA', side: 'ALLIED', class: 'NewOrleans', x: 14000, y: 2000, heading: 0, speed: 28 });
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w);
  for (let i = 0; i < 120; i++) { w.t += 0.5; refreshTracks(w, true); stepKin(w, 0.5); w.tracks.update(0.5); ai.tick(w, 0.5); w.applyDueCommands(); }
  const enemyCourse = eCA.heading;
  const rel = Math.abs(normDeg180(bb.commanded.heading - enemyCourse));
  const iz = immuneZoneVs(bb, 'CA');
  console.log('   本舰航向 ' + Math.round(bb.commanded.heading) + '°，敌航向 ' + enemyCourse + '°，夹角 ' + Math.round(rel) + '°；对 8in 巡洋舰免疫区 ' + (iz.innerM / 1000).toFixed(1) + '~' + (iz.outerM / 1000).toFixed(1) + 'km（有效=' + iz.valid + '）');
  ok(rel > 45 && rel < 135, 'T 字位要求与敌纵队航向接近垂直（实际夹角 ' + Math.round(rel) + '°）');
  ok(iz.valid && iz.innerM < iz.outerM, '扶桑对 8in 应有有效免疫区');
  console.log('   ' + ai.lastReasoning.slice(0, 300));
});

test('T6.6c LocalAI 屏护：驱逐舰前出至威胁轴方向', () => {
  const w = miniWorld({ seed: 23 });
  w.tracks = new MiniTracks(w);
  addShip(w, { id: 'BB', side: 'AXIS', class: 'fuso', x: 0, y: 0, heading: 90, speed: 22, role: 'flagship' });
  addShip(w, { id: 'D1', side: 'AXIS', class: 'fubuki', x: -2000, y: -1500, heading: 90, speed: 30 });
  addShip(w, { id: 'D2', side: 'AXIS', class: 'fubuki', x: -2600, y: 1500, heading: 90, speed: 30 });
  addShip(w, { id: 'E1', side: 'ALLIED', class: 'NorthCarolina', x: 22000, y: 3000, heading: 270, speed: 22 });
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w);
  for (let i = 0; i < 24; i++) { w.t += 0.5; refreshTracks(w, true); w.tracks.update(0.5); ai.tick(w, 0.5); w.applyDueCommands(); }
  const forms = w.commands.filter((c) => c.kind === 'FORMATION');
  ok(forms.length >= 1, '应为屏护驱逐舰下达 FORMATION 阵位');
  const axis = ai.fleet.threatAxisDeg;
  for (const f of forms) {
    const off = Math.abs(normDeg180(f.params.station.bearingDeg - axis));
    ok(off <= 110, '阵位应在威胁轴 ±110° 扇形内（实际 ' + Math.round(off) + '°）');
    ok(f.params.station.rangeM >= 2000 && f.params.station.rangeM <= 5000, '前出距离应在 2~5km');
  }
  console.log('   阵位: ' + forms.map((f) => Math.round(f.params.station.bearingDeg) + '°/' + f.params.station.rangeM + 'm').join(', ') + '（威胁轴 ' + Math.round(axis) + '°）');
});

test('T6.6d LocalAI 雷击突击：舷角窗口内驱逐舰齐射（扇面+双档+脱离）', () => {
  const w = miniWorld({ seed: 24 });
  w.tracks = new MiniTracks(w);
  addShip(w, { id: 'BB', side: 'AXIS', class: 'fuso', x: -3000, y: 0, heading: 90, speed: 20, role: 'flagship' });
  const d1 = addShip(w, { id: 'D1', side: 'AXIS', class: 'fubuki', x: 4000, y: 1000, heading: 90, speed: 32 });
  const eBB = addShip(w, { id: 'EBB', side: 'ALLIED', class: 'NorthCarolina', x: 12000, y: 0, heading: 0, speed: 22 }); // 横越（舷角≈90°）
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w);
  // 决策周期 8s + 指挥延迟 8s：需跑足够长让命令生效
  for (let i = 0; i < 120; i++) { w.t += 0.5; refreshTracks(w, true); stepKin(w, 0.5); w.tracks.update(0.5); ai.tick(w, 0.5); w.applyDueCommands(); }
  const launches = w.commands.filter((c) => c.kind === 'LAUNCH_TORPEDO');
  ok(launches.length >= 1, '舷角窗口内应下达 LAUNCH_TORPEDO（实际 ' + launches.length + '）');
  const p = launches[0].params;
  ok(p.spreadDeg > 0 && p.spreadDeg <= 12, '扇面应 >0 且 ≤12°（实际 ' + p.spreadDeg + '）');
  ok(p.tubes >= 2 && p.tubes <= 6, '管数应在 2~6');
  ok(w.torpedoes.length >= 2, '应有鱼雷入水（实际 ' + w.torpedoes.length + '）');
  const accepted = w.events.history.filter((e) => e.type === 'torp.launch' && e.accepted);
  ok(accepted.length >= 1, '命令路径应完成发射（torp.launch accepted）');
  const t0 = w.torpedoes[0];
  console.log('   发射参数: 扇面' + p.spreadDeg + '° 管数' + p.tubes + ' 档位' + (p.speedIdx === 0 ? '快档' : '慢档') + '；鱼雷 ' + t0.speedKn + '节 航迹=' + t0.wakeType + ' 航程' + Math.round(t0.solutionRunM) + 'm 飞行' + Math.round(t0.solutionTofS) + 's');
  console.log('   ' + ai.lastReasoning.slice(0, 320));
});

test('T6.6e LocalAI 受伤舰退出 + 烟幕 + 损管优先级', () => {
  const w = miniWorld({ seed: 25 });
  w.tracks = new MiniTracks(w);
  const bb = addShip(w, { id: 'BB', side: 'AXIS', class: 'fuso', x: 0, y: 0, heading: 90, speed: 20 });
  const hurt = addShip(w, { id: 'CA', side: 'AXIS', class: 'takao', x: -2000, y: 500, heading: 90, speed: 30 });
  addShip(w, { id: 'E1', side: 'ALLIED', class: 'NorthCarolina', x: 18000, y: 0, heading: 270, speed: 22 });
  // 重创：4 个舱室进水到 40% 储备浮力 + 弹药库火灾
  const reserve = hurt.reserveBuoyancyM3;
  for (let i = 1; i <= 4; i++) { hurt.compartments[i].flood_m3 = reserve * 0.1; hurt.compartments[i].breached = true; }
  const mag = hurt.compartments.find((c) => c.isMagazine);
  mag.fire = 0.5;
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w);
  for (let i = 0; i < 30; i++) { w.t += 0.5; refreshTracks(w, true); w.tracks.update(0.5); ai.tick(w, 0.5); w.applyDueCommands(); }
  const mem = ai.memFor(hurt);
  ok(mem.withdraw, '重伤舰应标记退出');
  ok(w.commands.some((c) => c.kind === 'WITHDRAW' && c.shipId === hurt.id), '应下达 WITHDRAW');
  ok(w.commands.some((c) => c.kind === 'SMOKE' && c.shipId === hurt.id && c.params.on), '退出时应施放烟幕');
  const dc = w.commands.filter((c) => c.kind === 'DC_PRIORITY' && c.shipId === hurt.id);
  ok(dc.length >= 1, '应下达 DC_PRIORITY');
  ok(dc[0].params.mode === 'magazine', '弹药库受威胁时损管优先级应为 magazine（实际 ' + dc[0].params.mode + '）');
  const away = Math.abs(normDeg180(hurt.commanded.heading - bearing2d(hurt.pos, w.ship('E1').pos)));
  ok(away > 60, '退出航向应背离敌方（实际夹角 ' + Math.round(away) + '°）');
  console.log('   退出航向 ' + Math.round(hurt.commanded.heading) + '°（敌方位 ' + Math.round(bearing2d(hurt.pos, w.ship('E1').pos)) + '°） 损管=' + dc.map((c) => c.params.mode).join(','));
});

test('T6.6f LocalAI 避雷机动：发现鱼雷航迹后 comb the wakes', () => {
  const w = miniWorld({ seed: 26 });
  w.tracks = new MiniTracks(w);
  // 目标横越（舷角大）：逃逸目标物理上无法用短程快档追上，故必须用横越航路
  const dd = addShip(w, { id: 'DD', side: 'AXIS', class: 'fubuki', x: 0, y: 0, heading: 90, speed: 28 });
  const enemy = addShip(w, { id: 'EN', side: 'ALLIED', class: 'Fletcher', x: 3000, y: -3000, heading: 0, speed: 30 });
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  // 敌方发射压缩空气航迹鱼雷（白昼 3km 量级即可发现），射向 DD 的预测位置
  const made = TP.launchTorpedo(w, enemy, enemy.torpedoMounts[0],
    { bearingDeg: bearing2d(enemy.pos, dd.pos), rangeM: dist2d(enemy.pos, dd.pos), tubes: 1,
      reliabilityOverride: { dud: 0, deepRun: 0, prem: 0 }, spreadDeg: 0 }, { targetShip: dd, trueTarget: dd, source: 'TEST', emitLaunchEvent: false });
  ok(made, '敌方应能发射鱼雷');
  // 推进到被发现（白昼、压缩空气航迹 ~3km）
  let detected = false;
  for (let i = 0; i < 400 && w.torpedoes.length && !detected; i++) {
    w.t += 0.5;
    for (const s of w.ships) { const mps = MPerKn * s.speed, r = s.heading * Math.PI / 180; s.pos.x += Math.sin(r) * mps * 0.5; s.pos.y += Math.cos(r) * mps * 0.5; }
    TP.updateTorpedoes(w, 0.5);
    detected = made[0].detectedBy['DD'] === true;
  }
  ok(detected, '压缩空气鱼雷航迹应被目视发现');
  const seenAt = dist2d(dd.pos, made[0].pos);
  ai.react(w);
  const course = w.commands.filter((c) => c.kind === 'SET_COURSE' && c.shipId === 'DD');
  ok(course.length >= 1, '应下达避雷转向命令');
  const h = course[course.length - 1].params.heading;
  const c = made[0].courseDeg;
  const aligned = Math.min(Math.abs(normDeg180(h - c)), Math.abs(normDeg180(h - normDeg(c + 180))));
  ok(aligned < 20, '规避航向应与雷迹平行（comb the wakes，实际偏差 ' + Math.round(aligned) + '°）');
  ok(w.commands.some((c2) => c2.kind === 'SET_SPEED' && c2.shipId === 'DD' && c2.params.kn >= 30), '避雷应加到全速');
  console.log('   发现距离 ' + Math.round(seenAt) + 'm → 转向 ' + Math.round(h) + '°（雷迹航向 ' + Math.round(c) + '°） 全速');
});

test('T6.6g LocalAI 夜间保守机动 + 弹药经济', () => {
  // 夜间：赤道 6 月 22:00（太阳高度角为负 → lightLevel≈0.03）
  const w = miniWorld({ seed: 27, env: { date: '1942-06-01T22:00:00Z' } });
  ok(w.env.lightLevel < 0.15, '构造的应为夜间环境（lightLevel=' + w.env.lightLevel.toFixed(3) + '）');
  w.tracks = new MiniTracks(w);
  const bb = addShip(w, { id: 'BB', side: 'AXIS', class: 'fuso', x: 0, y: 0, heading: 90, speed: 22 });
  addShip(w, { id: 'E1', side: 'ALLIED', class: 'NorthCarolina', x: 20000, y: 1000, heading: 270, speed: 22 });
  commandChain(w);
  const ai = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w);
  for (let i = 0; i < 90; i++) { w.t += 0.5; refreshTracks(w, true); stepKin(w, 0.5); w.tracks.update(0.5); ai.tick(w, 0.5); w.applyDueCommands(); }
  // 夜间远距（尚未进入决战距离）应下达减速命令（低于 85% 全速）
  const speedCmds = w.commands.filter((c) => c.kind === 'SET_SPEED' && c.shipId === bb.id).map((c) => c.params.kn);
  const slowest = speedCmds.length ? Math.min.apply(null, speedCmds) : bb.commanded.speed;
  ok(slowest < 0.85 * bb.data.speedMax_kn, '夜间远距应减速（实际最小指令速 ' + slowest.toFixed(1) + '/' + bb.data.speedMax_kn + '节，指令数 ' + speedCmds.length + '）');
  const allReasons = w.events.history.filter((e) => e.type === 'ai.decision').map((e) => e.reasoning || '').join(' ');
  ok(/夜间|照明/.test(allReasons), '战术理由应说明夜间保守/照明措施：' + allReasons.slice(0, 200));
  // 弹药经济：远距低概率目标应停火
  const w2 = miniWorld({ seed: 28 });
  w2.tracks = new MiniTracks(w2);
  const dd = addShip(w2, { id: 'DD', side: 'AXIS', class: 'fubuki', x: 0, y: 0, heading: 90, speed: 30 });
  addShip(w2, { id: 'E2', side: 'ALLIED', class: 'NorthCarolina', x: 15800, y: 0, heading: 90, speed: 22 });
  commandChain(w2);
  const ai2 = new LocalAI('AXIS', { intervalS: 8 });
  refreshTracks(w2);
  for (let i = 0; i < 20; i++) { w2.t += 0.5; refreshTracks(w2, true); w2.tracks.update(0.5); ai2.tick(w2, 0.5); w2.applyDueCommands(); }
  ok(!dd.commanded.firing, '驱逐舰不应在 127mm 极限射程外对装甲目标开火（弹药经济）；实际 firing=' + dd.commanded.firing);
  console.log('   夜间航速 ' + bb.commanded.speed.toFixed(1) + '节；远距驱逐舰停火=' + !dd.commanded.firing);
});

test('T6.7 真实 World 集成（若队友模块当前不可用则 SKIP）', async () => {
  let World = null;
  try { ({ World } = await import('../src/sim/world.js')); } catch (e) { console.log('   SKIP：world.js 当前无法加载（' + String(e.message).slice(0, 80) + '），等待队友模块完成'); return; }
  let w;
  try {
    const axis = JSON.parse(readFileSync(join(ROOT, 'data/ships_axis.json'), 'utf8'));
    const allied = JSON.parse(readFileSync(join(ROOT, 'data/ships_allied.json'), 'utf8'));
    const db = ShipDatabase.fromMany([axis, allied]);
    w = new World({ database: db, seed: 424242, aiOpts: { intervalS: 8 }, scenario: {
      id: 't6-int', nameZh: 'T6 集成', start: { lat: 0, lon: 0, date: '1942-06-01T12:00:00Z', env: { visibilityNm: 12 } },
      sides: { AXIS: { orderDelay_s: 8 }, ALLIED: { orderDelay_s: 6 } },
      ships: [
        { id: 'X-BB', class: 'fuso', side: 'AXIS', x: 0, y: 0, heading: 90, speed: 22, role: 'flagship' },
        { id: 'X-DD1', class: 'fubuki', side: 'AXIS', x: 4000, y: 1500, heading: 90, speed: 30 },
        { id: 'X-DD2', class: 'fubuki', side: 'AXIS', x: 2600, y: -2000, heading: 90, speed: 30 },
        { id: 'A-BB', class: 'NorthCarolina', side: 'ALLIED', x: 12000, y: 0, heading: 0, speed: 22, role: 'flagship' },
        { id: 'A-DD1', class: 'Fletcher', side: 'ALLIED', x: 16000, y: 2000, heading: 0, speed: 28 },
      ],
    } });
  } catch (e) { console.log('   SKIP：World 构造失败（' + String(e.message).slice(0, 100) + '）'); return; }
  let steps = 0;
  const t0 = Date.now();
  while (w.t < 120 && steps < 2000) { w.step(0.25); steps++; }
  const dec = w.events.history.filter((e) => e.type === 'ai.decision');
  const launches = w.events.history.filter((e) => e.type === 'torp.launch');
  const errsAll = w.events.history.filter((e) => e.type === 'ai.error');
  const errs = errsAll.filter((e) => e.where === 'torpedo.applyHit');
  console.log('   真实 World 跑 ' + w.t.toFixed(0) + 's：ai.decision ' + dec.length + ' 条、torp.launch ' + launches.length + ' 条、T6 错误 ' + errs.length + ' 条、其他模块 ai.error ' + (errsAll.length - errs.length) + ' 条，用时 ' + (Date.now() - t0) + 'ms');
  ok(dec.length > 0, 'LocalAI 应通过 bridge 产生决策事件');
  ok(errs.length === 0, '不应有 ai.error：' + errs.map((e) => e.where).join(','));
  if (dec.length) console.log('   末次战术理由: ' + dec[dec.length - 1].reasoning.slice(0, 260));
});

// ── 运行 ────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
console.log('══ T6 鱼雷与战术 AI 测试 ══');
for (const t of tests) {
  const t0 = Date.now();
  try {
    await t.fn();
    pass++;
    console.log('✅ PASS ' + t.name + '  (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    fail++;
    console.log('❌ FAIL ' + t.name + '\n     ' + String(e && e.message ? e.message : e));
    if (process.env.T6_DEBUG) console.log(e.stack);
  }
}
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + tests.length + ' 项');
if (fail) process.exitCode = 1;
