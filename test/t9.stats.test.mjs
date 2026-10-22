// ============================================================================
// test/t9.stats.test.mjs —— 命中统计口径验收（gun.hit / hitsTaken / nearMisses）
//   node test/t9.stats.test.mjs
//
// 背景（bug）：AAR 里「总命中」与逐舰「被命中」合计对不上（seed 19420604 丹麦海峡：
//   gun.hit=16、gun.nearmiss=12、逐舰 hitsTaken 合计 44 = 16*2+12）。根因两条：
//     1) ballistics.applyShipHit 与 damage.applyHit 各给受害者 hitsTaken +1（重复计数）；
//     2) 近失弹（isNearMiss）走 damage.applyHit 也被计入 hitsTaken。
// 期望口径（本测试锁定）：
//     Σ 全舰 stats.hitsTaken == gun.hit 事件数
//     Σ 全舰 stats.nearMisses == gun.nearmiss 事件数
//     Σ 攻击方 stats.hits    == gun.hit 事件数（含水下弹道命中）
//     鱼雷命中（torp.hit）也只计一次 hitsTaken（torpedo.js 曾与 applyHit 重复计数）
//     dmg.hitCount 不含近失；近失只进 dmg.nearMisses
//
// 测试用真实舰船数据（Iowa 406mm AP / Yamato），真实弹道积分与真实 damage.applyHit。
// 零依赖、确定性（固定 seed，散布=0）。
// ============================================================================
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RNG } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { Ship } from '../src/sim/ship.js';
import { ShipDatabase } from '../src/sim/data.js';
import { applyHit } from '../src/sim/damage.js';
import { makeShell, spawnProjectile, updateProjectiles, integrateTrajectory } from '../src/sim/ballistics.js';
import { launchTorpedo, updateTorpedoes } from '../src/sim/torpedo.js';

const root = new URL('../', import.meta.url);
const db = ShipDatabase.fromMany([
  JSON.parse(fs.readFileSync(fileURLToPath(new URL('data/ships_axis.json', root)), 'utf8')),
  JSON.parse(fs.readFileSync(fileURLToPath(new URL('data/ships_allied.json', root)), 'utf8')),
]);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (detail !== undefined ? '   [' + detail + ']' : '')); }
  else { fail++; console.log('  \u2717 ' + name + '   ' + detail); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------------------------------------------------------- 极简世界宿主
function makeWorld(seed) {
  const events = new EventBus(50000);
  const seen = [];
  events.onAny((e) => seen.push(e));
  const world = {
    t: 0, rng: new RNG(seed), events, ships: [], projectiles: [], splashes: [], salvoes: new Map(),
    torpedoes: [],
    env: { windKn: 0, windDirDeg: 0, seaState: 2, lightLevel: 1, visibilityNm: 12, smokeDensityAt() { return 0; } },
    ship(id) { return this.ships.find((s) => s.id === id) || null; },
    _major() {},
  };
  world.seen = seen;
  return world;
}
function spawn(world, id, side, ref, x, y, heading = 0) {
  const data = db.resolve(ref);
  if (!data) throw new Error('未知舰船 ' + ref);
  const ship = new Ship({ id, side, x, y, heading, speed: 0 }, data);
  world.ships.push(ship);
  return ship;
}
const sum = (arr, f) => arr.reduce((a, s) => a + (f(s) || 0), 0);
const countType = (world, type) => world.seen.filter((e) => e.type === type).length;

// ===========================================================================
section('1) 真实弹道：命中 + 近失，Σ 统计必须与事件数一致');

const w = makeWorld(19420604);
const shooter = spawn(w, 'iowa', 'ALLIED', 'class:Iowa', 0, 0, 0);
const target = spawn(w, 'yamato', 'AXIS', 'class:Yamato', 0, 3000, 0);
const battery = shooter.mainBatteries[0];
const shell = makeShell(shooter, battery, 'AP');
// 用与实际弹道同一积分器（含炮口高度 z0）反解仰角：射表 solutionForRange 从 z=0 起算，
// 直接拿来打 3km 会因炮口高度多飞 400+ m —— 测试要用真实弹道，就不能引入这个系统偏差。
const z0 = 10;
function aimElev(targetRangeM, gunHeightM) {
  let lo = 0.01, hi = 6;
  for (let i = 0; i < 45; i++) {
    const mid = (lo + hi) / 2;
    const rr = integrateTrajectory(shell, mid, shell.mvMps, { z0: gunHeightM, dt: 0.02 });
    if (rr.rangeM < targetRangeM) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const aimElevDeg = aimElev(3000, z0);
const tof = integrateTrajectory(shell, aimElevDeg, shell.mvMps, { z0, dt: 0.02 }).tofS;
console.log('  406mm AP @3000m（炮口高 ' + z0 + 'm）：反解仰角 ' + aimElevDeg.toFixed(3) + '° 飞行时间 ' + tof.toFixed(1) + 's');

const shots = [];
function fire(bearingDeg, label) {
  const p = spawnProjectile(w, {
    ship: shooter, battery, targetShip: target, targetShipId: target.id,
    ammo: 'AP', bearingDeg, elevDeg: aimElevDeg, rangeM: 3000, z0, dispersionMil: 0,
  });
  shots.push({ p, label });
}
// 6 发瞄准舰体中线（期望命中），4 发偏置约 30m（期望舷外近失）
for (let i = 0; i < 6; i++) fire(0, 'aim');
const lateralM = 30;
const offsetDeg = Math.atan(lateralM / 3000) * 180 / Math.PI;
for (let i = 0; i < 4; i++) fire(offsetDeg, 'near');
console.log('  发射 ' + shots.length + ' 发（中线 6 发 / 侧偏 ' + lateralM + 'm≈' + offsetDeg.toFixed(3) + '° 4 发）');

// 以 0.1s 步长推进弹道直至全部落水/命中
for (let i = 0; i < 300 && w.projectiles.some((p) => p.alive); i++) {
  w.t += 0.1;
  updateProjectiles(w, 0.1);
}

const hitEvs = w.seen.filter((e) => e.type === 'gun.hit');
const nearEvs = w.seen.filter((e) => e.type === 'gun.nearmiss');
const hitsTaken = sum(w.ships, (s) => s.stats.hitsTaken);
const nearTaken = sum(w.ships, (s) => s.stats.nearMisses);
const attackerHits = shooter.stats.hits;
console.log('  gun.hit=' + hitEvs.length + ' gun.nearmiss=' + nearEvs.length +
  ' | ΣhitsTaken=' + hitsTaken + ' ΣnearMisses=' + nearTaken + ' 攻击方 hits=' + attackerHits +
  ' | 目标 hitsTaken=' + target.stats.hitsTaken + ' nearMisses=' + target.stats.nearMisses +
  ' attacker shotsFired=' + shooter.stats.shotsFired);
check('命中与近失都出现了（事件数都 > 0）', hitEvs.length > 0 && nearEvs.length > 0,
  'hit=' + hitEvs.length + ' nearmiss=' + nearEvs.length);
check('Σ全舰 hitsTaken == gun.hit 事件数（被命中不再重复计数、近失不入列）',
  hitsTaken === hitEvs.length, hitsTaken + ' vs ' + hitEvs.length);
check('Σ全舰 nearMisses == gun.nearmiss 事件数（近失单独计数）',
  nearTaken === nearEvs.length, nearTaken + ' vs ' + nearEvs.length);
check('Σ攻击方 stats.hits == gun.hit 事件数', attackerHits === hitEvs.length,
  attackerHits + ' vs ' + hitEvs.length);
check('旧口径会得到的错误值 2*hit+nearmiss 与实际不同（回归保护）',
  hitsTaken !== 2 * hitEvs.length + nearEvs.length,
  hitsTaken + ' ≠ ' + (2 * hitEvs.length + nearEvs.length));
check('目标舰统计口径：hitsTaken 与 nearMisses 分列、互不混入',
  target.stats.hitsTaken === hitEvs.length && target.stats.nearMisses === nearEvs.length,
  'hitsTaken=' + target.stats.hitsTaken + ' nearMisses=' + target.stats.nearMisses);
check('每发弹只产生一条命中/近失/落水类终局事件（无重复结算）',
  hitEvs.length + nearEvs.length <= shots.length && hitEvs.length + nearEvs.length === 6 + 4,
  '终局事件 ' + (hitEvs.length + nearEvs.length) + ' / 发射 ' + shots.length);
if (hitEvs.length > 0) {
  const e = hitEvs[0];
  console.log('  gun.hit 样例: ship=' + e.ship + ' byShip=' + e.byShip + ' xFrac=' + e.xFrac + ' penetrated=' + e.penetrated);
  check('gun.hit 事件带 ship/byShip（AAR 逐舰归属所需）', !!e.ship && !!e.byShip);
}

// ===========================================================================
section('2) damage.applyHit 直接调用：近失不涨 hitsTaken，命中才涨');

const w2 = makeWorld(777);
const victim = spawn(w2, 'victim', 'AXIS', 'class:Yamato', 0, 0, 0);
const before = { taken: victim.stats.hitsTaken, near: victim.stats.nearMisses };
const nearHit = {
  t: 0, targetShip: victim, x_frac: 0.5, sideBias: 1, isNearMiss: true,
  warheadKg: 18, energyMJ: 40, caliberMM: 406, shellMassKg: 1225,
  killerShipId: 'iowa', killerSide: 'ALLIED', killerName: 'USS Iowa',
};
const rNear = applyHit(w2, nearHit);
console.log('  近失后: hitsTaken=' + victim.stats.hitsTaken + ' nearMisses=' + victim.stats.nearMisses +
  ' dmg.nearMisses=' + victim.dmg.nearMisses + ' 返回=' + JSON.stringify(rNear));
check('直接调 applyHit(近失)：hitsTaken 不变', victim.stats.hitsTaken === before.taken,
  before.taken + ' → ' + victim.stats.hitsTaken);
check('直接调 applyHit(近失)：stats.nearMisses +1', victim.stats.nearMisses === before.near + 1,
  before.near + ' → ' + victim.stats.nearMisses);
check('直接调 applyHit(近失)：dmg.nearMisses 同步 +1', victim.dmg.nearMisses === 1, victim.dmg.nearMisses);
check('直接调 applyHit(近失)：dmg.hitCount 不算近失（只进 nearMisses）', victim.dmg.hitCount === 0, victim.dmg.hitCount);

// 非近失的跳弹同样算「被命中」（命中事件仍在，只是未击穿）
const bounceHit = {
  t: 0, targetShip: victim, x_frac: 0.5, sideBias: 1, penetrates: false,
  warheadKg: 18, energyMJ: 120, caliberMM: 406, shellMassKg: 1225,
  killerShipId: 'iowa', killerSide: 'ALLIED', killerName: 'USS Iowa',
};
applyHit(w2, bounceHit);
console.log('  跳弹后: hitsTaken=' + victim.stats.hitsTaken + ' nearMisses=' + victim.stats.nearMisses);
check('直接调 applyHit(未击穿命中)：hitsTaken +1（跳弹仍是命中）', victim.stats.hitsTaken === before.taken + 1,
  victim.stats.hitsTaken);
check('直接调 applyHit(未击穿命中)：nearMisses 不变', victim.stats.nearMisses === before.near + 1,
  victim.stats.nearMisses);
check('直接调 applyHit(未击穿命中)：dmg.hitCount == 1（命中计数与近失分离）', victim.dmg.hitCount === 1, victim.dmg.hitCount);

// ===========================================================================
section('3) 真实鱼雷命中（launchTorpedo → updateTorpedoes）：ΣhitsTaken 只 +1');

const w3 = makeWorld(20240604);
const dd3 = spawn(w3, 'kagero', 'AXIS', 'class:Kagero', 0, 0, 0);
const victim3 = spawn(w3, 'iowa', 'ALLIED', 'class:Iowa', 0, 2500, 90);
const mount3 = dd3.torpedoMounts[0];
const before3 = sum(w3.ships, (s) => s.stats.hitsTaken);
const fired = launchTorpedo(w3, dd3, mount3, {
  bearingDeg: 0, rangeM: 2500, spreadDeg: 0, tubes: 1,
  depthM: Math.max(3, victim3.draftM * 0.6),
  reliabilityOverride: { dud: 0, deepRun: 0, prem: 0 },   // 零哑弹/零深走/零提前爆，锁定「真命中」路径
}, { targetShip: victim3, trueTarget: victim3, source: 'TEST', emitLaunchEvent: false });
console.log('  发射: ' + (fired ? fired.length : 0) + ' 雷（' + dd3.name + ' 2500m 正横 Iowa，深度 ' +
  Math.max(3, victim3.draftM * 0.6).toFixed(1) + 'm）');
for (let i = 0; i < 2000 && w3.torpedoes.length; i++) {
  w3.t += 0.25;
  updateTorpedoes(w3, 0.25);
}
const torpHitEvs = w3.seen.filter((e) => e.type === 'torp.hit');
const after3 = sum(w3.ships, (s) => s.stats.hitsTaken);
const delta3 = after3 - before3;
const torpStats = victim3.dmg ? victim3.dmg.torpHits : 0;
console.log('  torp.hit=' + torpHitEvs.length + ' | ΣhitsTaken 增量=' + delta3 + '（旧实现会是 2）' +
  ' | 攻击方 torpHits=' + dd3.stats.torpHits + ' dmg.torpHits=' + torpStats);
check('鱼雷命中（torp.hit 事件出现）', torpHitEvs.length === 1, 'torp.hit=' + torpHitEvs.length);
check('鱼雷命中后 ΣhitsTaken 增量 == 1（每雷只记一次被命中）', delta3 === 1, delta3 + '（旧实现 2）');
check('攻击方 stats.torpHits == torp.hit 事件数', dd3.stats.torpHits === torpHitEvs.length,
  dd3.stats.torpHits + ' vs ' + torpHitEvs.length);
check('鱼雷命中不污染炮击命中数 stats.hits', dd3.stats.hits === 0, dd3.stats.hits);
check('鱼雷命中后 dmg.torpHits == 1', torpStats === 1, torpStats);

// ===========================================================================
console.log('\n===============================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('===============================');
process.exit(fail === 0 ? 0 : 1);