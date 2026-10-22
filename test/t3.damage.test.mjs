// ============================================================================
// test/t3.damage.test.mjs — 损伤与损管（T3）验收测试
//   node test/t3.damage.test.mjs
// 覆盖：
//   1) 460mm AP 命中大和舯部机舱 vs 艏部：进水与航速后果差异
//   2) 3 枚 610mm 九三式命中阳炎型驱逐舰：是否倾覆（及 4 枚折断的对照）
//   3) 弹药库火灾：有/无损管队时是否殉爆
//   4) 事件契约与 floodingReport 数值抽样
// 零依赖、确定性（固定 seed）。
// ============================================================================
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RNG } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { Ship } from '../src/sim/ship.js';
import { ShipDatabase } from '../src/sim/data.js';
import { applyHit, updateDamage, floodingReport, normalizeHit } from '../src/sim/damage.js';

const root = new URL('../', import.meta.url);
const db = ShipDatabase.fromMany([
  JSON.parse(fs.readFileSync(fileURLToPath(new URL('data/ships_axis.json', root)), 'utf8')),
  JSON.parse(fs.readFileSync(fileURLToPath(new URL('data/ships_allied.json', root)), 'utf8')),
]);

let fails = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + name + (detail !== undefined ? '   [' + detail + ']' : '')); }
  else { fails++; console.log('  \u2717 ' + name + '   ' + detail); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function makeWorld(seed) {
  const events = new EventBus(50000);
  const seen = [];
  events.onAny((e) => { if (/^dam\./.test(e.type) || e.type === 'ship.capsize' || e.type === 'ship.sink') seen.push(e); });
  const world = {
    t: 0, rng: new RNG(seed), events, ships: [], env: { seaState: 3, windKn: 12 },
    ship(id) { return this.ships.find((s) => s.id === id) || null; },
    _major() {},
  };
  world.seen = seen;
  return world;
}
function spawn(world, id, side, ref, extra = {}) {
  const data = db.resolve(ref);
  assert.ok(data, '未知舰船 ' + ref);
  const ship = new Ship(Object.assign({ id, side, speed: data.speedMax_kn || 20 }, extra), data);
  world.ships.push(ship);
  return ship;
}
function run(world, ship, seconds, dt = 0.1) {
  const steps = Math.round(seconds / dt);
  let peak = ship.floodedM3 || 0, peakList = Math.abs(ship.list || 0);
  for (let i = 0; i < steps; i++) {
    world.t += dt; updateDamage(ship, world, dt);
    if (ship.floodedM3 > peak) peak = ship.floodedM3;
    if (Math.abs(ship.list) > peakList) peakList = Math.abs(ship.list);
  }
  ship._peakFloodedM3 = peak; ship._peakList = peakList;
}
function countType(world, type) { return world.seen.filter((e) => e.type === type).length; }
function subsystemsDead(ship, kind) { return ship.subsystems.filter((s) => s.kind === kind && s.destroyed).length; }

// ---------------------------------------------------------------------------
section('1) 460mm AP 命中大和：舯部机舱 vs 艏部');

function yamatoHit(xf, hitExtra) {
  const world = makeWorld(19420604);
  const ship = spawn(world, 'yamato1', 'AXIS', 'class:Yamato');
  const hit = Object.assign({
    t: 0, targetShip: ship, x_frac: xf, sideBias: 1, penetrates: true,
    armorMM: 410, obliquityDeg: 15, ammoKind: 'AP', caliberMM: 460, shellMassKg: 1460,
    warheadKg: 17.5, energyMJ: 182, killerShipId: 'iowa', killerSide: 'ALLIED', killerName: 'Iowa',
  }, hitExtra || {});
  applyHit(world, hit);
  run(world, ship, 900);
  return { world, ship, rep: floodingReport(ship), peak: ship._peakFloodedM3, peakList: ship._peakList };
}

const mach = yamatoHit(0.60);          // 舯部机舱（MACHINERY）
const bow = yamatoHit(0.02);           // 艏部（BOW）
const mainHit = (r) => r.rep.breaches.reduce((a, b) => (!a || b.areaM2 > a.areaM2 ? b : a), null);
const bM = mainHit(mach), bB = mainHit(bow);
console.log('  机舱命中(命中点 x=0.60): 命中舱=' + (bM ? bM.i + '(' + bM.kind + ')' : '-') + ' 该舱进水=' + (bM ? bM.floodedM3 : 0) + 'm³ 破口=' + (bM ? bM.areaM2 : 0) + 'm²' +
  ' | 全舰进水=' + mach.rep.floodedM3 + 'm³ 横倾=' + mach.ship.list.toFixed(1) + '° 航速上限=' + mach.ship.speedCapKn.toFixed(1) + 'kn 锅炉损=' + subsystemsDead(mach.ship, 'BOILER') + ' 主轴损=' + subsystemsDead(mach.ship, 'SHAFT'));
console.log('  艏部命中(命中点 x=0.02): 命中舱=' + (bB ? bB.i + '(' + bB.kind + ')' : '-') + ' 该舱进水=' + (bB ? bB.floodedM3 : 0) + 'm³ 破口=' + (bB ? bB.areaM2 : 0) + 'm²' +
  ' | 全舰进水=' + bow.rep.floodedM3 + 'm³ 横倾=' + bow.ship.list.toFixed(1) + '° 航速上限=' + bow.ship.speedCapKn.toFixed(1) + 'kn 锅炉损=' + subsystemsDead(bow.ship, 'BOILER') + ' 主轴损=' + subsystemsDead(bow.ship, 'SHAFT'));

// 注意：断言"造成过进水"要看峰值。损管现在能真的把艏部小破口堵住并排干，
// 900 秒后的残水量可能为 0——那是损管起作用的证据，不是命中无效。
check('两处命中都造成进水（按峰值）', mach.peak > 0 && bow.peak > 0, Math.round(mach.peak) + ' / ' + Math.round(bow.peak) + ' m³');
check('损管能控制住艏部小破口（残水显著少于峰值）', bow.rep.floodedM3 < bow.peak * 0.6,
  '峰值 ' + Math.round(bow.peak) + ' → 残水 ' + Math.round(bow.rep.floodedM3) + ' m³');
check('舯部命中舱为 MACHINERY', !!bM && bM.kind === 'MACHINERY', bM && bM.kind);
check('艏部命中舱为 BOW', !!bB && bB.kind === 'BOW', bB && bB.kind);
check('舯部机舱命中摧毁锅炉与主轴', subsystemsDead(mach.ship, 'BOILER') + subsystemsDead(mach.ship, 'SHAFT') > 0,
  '锅炉 ' + subsystemsDead(mach.ship, 'BOILER') + ' / 主轴 ' + subsystemsDead(mach.ship, 'SHAFT'));
check('艏部命中不摧毁动力', subsystemsDead(bow.ship, 'BOILER') === 0 && subsystemsDead(bow.ship, 'SHAFT') === 0);
check('机舱命中进水多于艏部命中', mach.rep.floodedM3 > bow.rep.floodedM3 * 1.25, mach.rep.floodedM3 + ' > ' + bow.rep.floodedM3);
check('机舱命中航速上限显著低于艏部', mach.ship.speedCapKn < bow.ship.speedCapKn - 1.5,
  mach.ship.speedCapKn.toFixed(1) + ' vs ' + bow.ship.speedCapKn.toFixed(1) + ' kn');
check('机舱命中航速上限 ≤ 原最大航速的 85%', mach.ship.speedCapKn <= 27.5 * 0.85, mach.ship.speedCapKn.toFixed(1) + ' kn');
check('大和单发 460mm 命中不致沉没', mach.ship.isAfloat && !mach.ship.sinking);
check('emit dam.penetration', countType(mach.world, 'dam.penetration') === 1);
check('周期 dam.flood 事件被节流（5–10s 一条）', countType(mach.world, 'dam.flood') >= 55 && countType(mach.world, 'dam.flood') <= 190, countType(mach.world, 'dam.flood') + ' 条/900s');
check('emit dam.list 与 dam.dc（节流后）', countType(mach.world, 'dam.list') >= 55 && countType(mach.world, 'dam.list') <= 190 && countType(mach.world, 'dam.dc') >= 55);
check('写回 damageSpeedCapKn（T1 dynamics 的硬上限挂钩）', typeof mach.ship.damageSpeedCapKn === 'number' && mach.ship.damageSpeedCapKn > 0 && mach.ship.damageSpeedCapKn < 27.5, mach.ship.damageSpeedCapKn);
check('emit dam.subsystem（动力损失）', countType(mach.world, 'dam.subsystem') > 0);

// 事件字段契约
const dcEv = mach.world.seen.find((e) => e.type === 'dam.dc');
check('dam.dc 事件含 {t,ship,side,victimSide,compartment,value}',
  dcEv && dcEv.t !== undefined && dcEv.ship === 'yamato1' && dcEv.side === 'AXIS' && dcEv.victimSide === 'AXIS' && 'compartment' in dcEv && 'value' in dcEv);
const penEv = mach.world.seen.find((e) => e.type === 'dam.penetration');
check('dam.penetration 带 killerShipId/killerSide', penEv && penEv.killerShipId === 'iowa' && penEv.killerSide === 'ALLIED');

// ---------------------------------------------------------------------------
section('2) 3 枚 610mm 九三式命中阳炎型驱逐舰');

function ddTorpedoRun(n, seed = 777) {
  const world = makeWorld(seed);
  const dd = spawn(world, 'dd1', 'AXIS', 'class:Kagero');
  const xs = n === 4 ? [0.36, 0.44, 0.52, 0.60] : [0.42, 0.48, 0.54];
  for (let k = 0; k < n; k++) {
    applyHit(world, {
      t: 0, kind: 'TORPEDO', weapon: 'TORPEDO', targetShip: dd, target: 'dd1', x_frac: xs[k],
      side: 'STBD', sideBias: 1, isTorpedo: true, penetrates: true,
      warheadKg: 490, tntKg: 780, depthM: 2.0, caliberMM: 610,
      killerShipId: 'uss_a', killerSide: 'ALLIED', killerName: 'USS A',
    });
  }
  let capsizeT = null, breakT = null, sinkT = null;
  const dt = 0.1;
  for (let i = 0; i < 12000; i++) {
    world.t += dt;
    updateDamage(dd, world, dt);
    if (dd.capsized && capsizeT === null) capsizeT = world.t;
    if (dd.dmg.hullFailed && breakT === null) breakT = world.t;
    if (dd.sinking && sinkT === null) sinkT = world.t;
    if (!dd.isAfloat) break;
  }
  return { world, dd, capsizeT, breakT, sinkT, rep: floodingReport(dd) };
}

const tor3 = ddTorpedoRun(3);
console.log('  3 枚: 进水=' + tor3.rep.floodedM3 + 'm³(' + tor3.rep.floodedPct + '%) 横倾=' + tor3.dd.list.toFixed(1) + '°' +
  ' 结构损伤=' + tor3.rep.structural + ' capsize=' + tor3.dd.capsized + '@' + (tor3.capsizeT === null ? '-' : tor3.capsizeT.toFixed(0) + 's') +
  ' sinking=' + tor3.dd.sinking + ' speedCap=' + tor3.dd.speedCapKn.toFixed(1) + 'kn 幸存船员=' + Math.round(tor3.dd.crew) + '/' + tor3.dd.crew0);
check('3 枚九三式导致驱逐舰倾覆', tor3.dd.capsized === true, 'capsize@' + tor3.capsizeT);
check('倾覆时 list > 62°', Math.abs(tor3.dd.list) > 62, tor3.dd.list.toFixed(1) + '°');
check('驱逐舰失去航行能力', tor3.dd.speedCapKn < 5, tor3.dd.speedCapKn.toFixed(1) + ' kn');
check('进水超过储备浮力 25%', tor3.rep.floodedM3 > tor3.dd.reserveBuoyancyM3 * 0.25,
  tor3.rep.floodedM3 + ' / ' + Math.round(tor3.dd.reserveBuoyancyM3) + ' m³');
check('单舰 3 雷未达折断阈值(结构<1)', tor3.rep.structural < 1, tor3.rep.structural);
check('emit ship.capsize', countType(tor3.world, 'ship.capsize') === 1);
check('emit dam.flood.control（渐进/甲板灌水/反击水）', countType(tor3.world, 'dam.flood.control') > 0, countType(tor3.world, 'dam.flood.control') + ' 条');
check('鱼雷命中 emit dam.penetration/dam.casualties', countType(tor3.world, 'dam.penetration') === 3 && countType(tor3.world, 'dam.casualties') > 0);

const tor4 = ddTorpedoRun(4);
console.log('  4 枚: 结构损伤=' + tor4.rep.structural + ' hullFailed=' + tor4.dd.dmg.hullFailed + '@' + (tor4.breakT === null ? '-' : tor4.breakT.toFixed(0) + 's') +
  ' 进水=' + tor4.rep.floodedM3 + 'm³ capsize=' + tor4.dd.capsized);
check('4 枚九三式导致舰体折断（水下爆炸累计冲击）', tor4.dd.dmg.hullFailed === true, '结构=' + tor4.rep.structural);

// ---------------------------------------------------------------------------
section('3) 弹药库火灾：有/无损管队');

function magazineFireRun(withDC) {
  const world = makeWorld(31415);
  const ca = spawn(world, 'ca1', 'AXIS', 'class:Takao');
  const dc = ca.subsystems.find((s) => s.kind === 'DC');
  const spr = ca.subsystems.find((s) => s.kind === 'MAGAZINE_SPRINKLER');
  if (!withDC) { dc.destroyed = true; dc.parties = 0; spr.destroyed = true; }
  const mag = ca.compartments.find((c) => c.isMagazine);
  assert.ok(mag, 'Takao 应有弹药库舱室');
  applyHit(world, {
    t: 0, targetShip: ca, x_frac: mag.x_frac, sideBias: -1, penetrates: true, ammoKind: 'HE',
    caliberMM: 203, warheadKg: 8, energyMJ: 70, forceFire: true, fireIntensity: 0.3,
    killerShipId: 'uss_x', killerSide: 'ALLIED',
  });
  const dt = 0.1;
  let detT = null, maxRisk = 0, fireAt = null;
  for (let i = 0; i < 9000; i++) {
    world.t += dt;
    updateDamage(ca, world, dt);
    maxRisk = Math.max(maxRisk, mag.magRisk || 0);
    for (const c of ca.compartments) fireAt = Math.max(fireAt || 0, c.fire || 0);
    if (ca.dmg.detonated && detT === null) detT = world.t;
    if (!ca.isAfloat) break;
  }
  const fireSum = ca.compartments.reduce((a, c) => a + (c.fire || 0), 0);
  return { world, ca, mag, detT, maxRisk, fireAt, fireSum };
}

const fireDC = magazineFireRun(true);
console.log('  有损管队: 殉爆=' + (fireDC.ca.dmg.detonated) + ' 最大magRisk=' + fireDC.maxRisk.toFixed(2) +
  ' 结束时残余火=' + fireDC.fireSum.toFixed(3) + ' 注水=' + !!fireDC.mag.magFlooded + ' 船员=' + Math.round(fireDC.ca.crew) + '/' + fireDC.ca.crew0);
check('有损管队：弹药库不殉爆', fireDC.ca.dmg.detonated !== true, 'maxRisk=' + fireDC.maxRisk.toFixed(2));
check('有损管队：火灾被扑灭', fireDC.fireSum < 0.05, fireDC.fireSum.toFixed(3));
check('有损管队：emit dam.fire 与 dam.fire.out', countType(fireDC.world, 'dam.fire') > 0 && countType(fireDC.world, 'dam.fire.out') > 0);
check('有损管队：军舰仍浮航', fireDC.ca.isAfloat === true);

const fireNo = magazineFireRun(false);
console.log('  无损管队: 殉爆=' + (fireNo.ca.dmg.detonated === true) + '@' + (fireNo.detT === null ? '-' : fireNo.detT.toFixed(0) + 's') +
  ' 最大magRisk=' + fireNo.maxRisk.toFixed(2) + ' 舰船损毁=' + fireNo.ca.catastrophicLoss + ' 幸存船员=' + Math.round(fireNo.ca.crew) + '/' + fireNo.ca.crew0);
check('无损管队：火灾烧毁弹药库（殉爆）', fireNo.ca.dmg.detonated === true, 'maxRisk=' + fireNo.maxRisk.toFixed(2));
check('无损管队：emit dam.magazine(detonation)', fireNo.world.seen.some((e) => e.type === 'dam.magazine' && e.result === 'detonation'));
check('无损管队：emit ship.sink(catastrophic)', fireNo.world.seen.some((e) => e.type === 'ship.sink' && e.catastrophic));
check('殉爆后军舰失去浮力', fireNo.ca.isAfloat === false);

// 防闪爆门对直击弹药库风险的影响（大和主炮塔有防闪爆门）
const wMag = makeWorld(2718);
const yMag = spawn(wMag, 'ym', 'AXIS', 'class:Yamato');
const fMag = yMag.compartments.find((c) => c.isMagazine);
applyHit(wMag, {
  t: 0, targetShip: yMag, x_frac: fMag.x_frac, sideBias: 1, penetrates: true, ammoKind: 'AP',
  caliberMM: 460, warheadKg: 17.5, energyMJ: 182, killerShipId: 'uss_m', killerSide: 'ALLIED',
});
const magEv = wMag.seen.find((e) => e.type === 'dam.magazine');
console.log('  弹药库直击: ' + JSON.stringify(magEv && { result: magEv.result, magRisk: magEv.magRisk, flashProtected: magEv.flashProtected }));
check('弹药库直击 emit dam.magazine(hit)', !!magEv && magEv.result === 'hit');
check('大和弹药库受防闪爆门保护', !!magEv && magEv.flashProtected === true, magEv && String(magEv.flashProtected));
check('单发直击不立即殉爆', yMag.dmg.detonated !== true, 'magRisk=' + (magEv && magEv.magRisk));

// ---------------------------------------------------------------------------
section('4) floodingReport / 子系统映射抽样');
const rep = mach.rep;
console.log('  ' + JSON.stringify({ floodedM3: rep.floodedM3, floodedPct: rep.floodedPct, inflowM3s: rep.inflowM3s, pumpM3s: rep.pumpM3s, list: rep.list, draft: rep.draft, freeboard: rep.freeboard, casualties: rep.casualties, structural: rep.structural }));
check('floodingReport 含 floodedM3/freeboard/list', typeof rep.floodedM3 === 'number' && typeof rep.freeboard === 'number' && typeof rep.list === 'number');
check('floodingReport 排水泵排量合理(>0)', rep.pumpM3s > 0, rep.pumpM3s + ' m³/s');
check('船员伤亡已记录', rep.casualties > 0, rep.casualties + ' 人');

// 大和机舱进水速率与孔口出流量级核对：Q = Cd·A·sqrt(2gh)
const b0 = mach.rep.breaches.reduce((a, b) => (b.areaM2 > a.areaM2 ? b : a), mach.rep.breaches[0]);
const firstBreach = mach.world.seen.filter((e) => e.type === 'dam.flood' && e.result === 'breach')[0];
const expectQ = 0.62 * 0.387 * Math.sqrt(2 * 9.80665 * 5.2);
console.log('  命中舱破口 ' + b0.areaM2 + 'm²（' + b0.kind + '，' + b0.floodedM3 + 'm³）; Torricelli 校核 A=0.387m²/h=5.2m → ' + expectQ.toFixed(2) + ' m³/s（首周期实测 ' + firstBreach.rateM3s + ' m³/s）');
check('破口面积 0.3~1.0 m²（460mm AP）', b0.areaM2 > 0.3 && b0.areaM2 < 1.0, b0.areaM2 + ' m²');

// ---------------------------------------------------------------------------
section('5) normalizeHit 双来源兼容 + 事件节流（Lead 反馈项）');

// --- 5a) T4 ballistics 实际字段形状 ---
const w5 = makeWorld(20250606);
const y2 = spawn(w5, 'y2', 'AXIS', 'class:Yamato');
const t4hit = {
  kind: 'SHELL', t: 0, ship: 'y2', targetShip: y2,
  side: 'ALLIED', attackerId: 'iowa2', attackerSide: 'ALLIED', attackerName: 'USS Iowa',
  ammo: 'AP', caliberMM: 460, massKg: 1460,
  shell: { ammo: 'AP', caliberMM: 460, massKg: 1460, explosiveKg: 17.5, fuze: 0.03 },
  impact: { xFrac: 0.60, hitPart: 'BELT', obliquityDeg: 15, fallAngleDeg: 12, velocityMps: 500, z: -5.2, localAcross: 3.1 },
  armorMM: 410, penetrationMM: 460, penetrated: true, detonated: true,
  detonation: { xFrac: 0.63, depthM: 4.0 }, explosiveKg: 17.5, isNearMiss: false, passThrough: false, dud: false,
};
const nrm = normalizeHit(t4hit);
console.log('  normalizeHit(T4): ' + JSON.stringify({ x_frac: nrm.x_frac, depthM: nrm.depthM, warheadKg: nrm.warheadKg, caliberMM: nrm.caliberMM, shellMassKg: nrm.shellMassKg, energyMJ: nrm.energyMJ, ammoKind: nrm.ammoKind, sideBias: nrm.sideBias, killer: nrm.killerShipId }));
check('normalizeHit: x_frac ← impact.xFrac', nrm.x_frac === 0.60, nrm.x_frac);
check('normalizeHit: depthM ← impact.z', nrm.depthM === 5.2, nrm.depthM);
check('normalizeHit: warheadKg ← explosiveKg', nrm.warheadKg === 17.5, nrm.warheadKg);
check('normalizeHit: ammoKind ← ammo', nrm.ammoKind === 'AP', nrm.ammoKind);
check('normalizeHit: sideBias ← impact.localAcross', nrm.sideBias === 1, nrm.sideBias);
check('normalizeHit: killer ← attackerId/attackerSide', nrm.killerShipId === 'iowa2' && nrm.killerSide === 'ALLIED', nrm.killerShipId + '/' + nrm.killerSide);
check('normalizeHit: energyMJ = ½mv²', Math.abs(nrm.energyMJ - 182.5) < 0.6, nrm.energyMJ);
check('normalizeHit: not near-miss / not dud', nrm.isNearMiss === false && nrm.dud === false);
const r5 = applyHit(w5, t4hit);
check('T4 命中由 impact.xFrac 定位到机舱（非随机舱）', !!r5 && y2.compartments[r5.compartment].isMachinery, r5 && y2.compartments[r5.compartment].kind);
check('T4 命中破坏动力子系统', y2.subsystems.some((s) => s.destroyed && (s.kind === 'BOILER' || s.kind === 'SHAFT')));
check('T4 命中产生 dam.penetration', countType(w5, 'dam.penetration') === 1);

// --- 5b) T5 torpedo 实际字段形状（warheadKg = TNT 当量，chargeKg = 原始装药）---
const w5b = makeWorld(20250607);
const dd5 = spawn(w5b, 'dd5', 'AXIS', 'class:Kagero');
const t5hit = {
  kind: 'TORPEDO', t: 0, targetShip: dd5, x_frac: 0.48, compartmentIndex: dd5.compartmentAt(0.48).i,
  sideBias: 1, penetrates: true, armorMM: 0, obliquityDeg: 0, shellMassKg: 1200, caliberMM: 610,
  velocityMps: 24, energyMJ: 345, warheadKg: 780, chargeKg: 490,
  isTorpedo: true, isNearMiss: false, fuzeDelayS: 0, ammoKind: 'TORPEDO',
  killerShipId: 'uss_a', killerSide: 'ALLIED', killerName: 'USS A', side: 'STBD', depthM: 3.6,
};
const n5 = normalizeHit(t5hit);
check('normalizeHit(T5): 保留 x_frac/depthM/warheadKg', n5.x_frac === 0.48 && n5.depthM === 3.6 && n5.warheadKg === 780);
check('normalizeHit(T5): isTorpedo=true', n5.isTorpedo === true);
const r5b = applyHit(w5b, t5hit);
run(w5b, dd5, 60);
check('T5 命中造成大量进水(60s)', dd5.floodedM3 > 50, Math.round(dd5.floodedM3) + ' m³');

// --- 5c) 事件节流 ---
const w6 = makeWorld(4242);
const pristine = spawn(w6, 'dd6', 'AXIS', 'class:Kagero');
run(w6, pristine, 600);
check('未受损舰 600s 内零 dam.* 事件（不再每 tick emit）', w6.seen.length === 0, w6.seen.length + ' 条');
const w7 = makeWorld(4243);
const y3 = spawn(w7, 'y3', 'AXIS', 'class:Yamato');
applyHit(w7, Object.assign({}, t4hit, { targetShip: y3, ship: 'y3' }));
run(w7, y3, 600);
const cF = countType(w7, 'dam.flood'), cL = countType(w7, 'dam.list'), cD = countType(w7, 'dam.dc');
console.log('  受损大和 600s 事件: dam.flood=' + cF + ' dam.list=' + cL + ' dam.dc=' + cD);
check('受损舰周期事件 ≤ 每 5s 一条', cF <= 200 && cL <= 125 && cD <= 125, 'flood=' + cF + ' list=' + cL + ' dc=' + cD);
check('受损舰周期事件 ≥ 每 10s 兜底一条', cL >= 45 && cF >= 45, 'flood=' + cF + ' list=' + cL);

// ---------------------------------------------------------------------------
console.log('\n===============================');
console.log('通过 ' + passes + ' 项，失败 ' + fails + ' 项');
console.log('===============================');
process.exit(fails === 0 ? 0 : 1);
