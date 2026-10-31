// ============================================================================
// test/t10.magazine.test.mjs —— 弹药库事件语义验收（殉爆 detonation vs 风险事件）
//   node test/t10.magazine.test.mjs
//
// 背景（bug）：UI 把任何 dam.magazine 都叫「殉爆」，而 sim 层其实有 6 类 result：
//   hit        直击弹药库但未引爆（只累积 magRisk）
//   flash      炮塔/扬弹机闪爆传火（累积 magRisk）
//   fire_threat 火灾烘烤，风险过 0.3 的预警
//   flooded    弹药库注水（弹药报废、避免殉爆）
//   burn       近空弹药库爆燃（重创，不保证立即沉没）
//   detonation 满库殉爆（必须立即沉没）
// 本测试锁定 sim 层语义：
//   1) result=detonation 的 dam.magazine 必须伴随 ship.sink 且 ship.isAfloat=false / sunkAt 置位；
//   2) result=hit / flash / fire_threat / flooded 绝不能造成沉没（!sinking && isAfloat && !d.detonated）；
//   3) result=burn 只置 sinking=true（由 world._progressSinking 按 sinkTimer 推进实际沉没），
//      不得在这里发 ship.sink（旧实现发了 ship.sink 却仍 isAfloat=true，world 之后会二次发同一条）。
//
// 测试用真实舰船数据（Yamato / Takao）与真实 damage.applyHit + updateDamage。
// 零依赖、确定性（固定 seed）。
// ============================================================================
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RNG } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { Ship } from '../src/sim/ship.js';
import { ShipDatabase } from '../src/sim/data.js';
import { applyHit, updateDamage } from '../src/sim/damage.js';

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

const KNOWN_RESULTS = new Set(['hit', 'flash', 'fire_threat', 'flooded', 'burn', 'detonation']);

function makeWorld(seed) {
  const events = new EventBus(50000);
  const seen = [];
  events.onAny((e) => seen.push(e));
  const world = {
    t: 0, rng: new RNG(seed), events, ships: [],
    ship(id) { return this.ships.find((s) => s.id === id) || null; },
    _major() {},
  };
  world.seen = seen;
  return world;
}
function spawn(world, id, side, ref, extra = {}) {
  const data = db.resolve(ref);
  if (!data) throw new Error('未知舰船 ' + ref);
  const ship = new Ship(Object.assign({ id, side, x: 0, y: 0, heading: 0, speed: 0 }, extra), data);
  world.ships.push(ship);
  return ship;
}
const magOf = (ship) => ship.compartments.find((c) => c.isMagazine);
const magEvents = (world) => world.seen.filter((e) => e.type === 'dam.magazine');
const sinkEvents = (world) => world.seen.filter((e) => e.type === 'ship.sink');

// 直击某舰弹药库的炮弹命中（460mm AP 量级；warheadKg=爆炸装药）
function magazineHit(ship, extra = {}) {
  const mag = magOf(ship);
  return Object.assign({
    t: 0, targetShip: ship, x_frac: mag.x_frac, sideBias: 1, penetrates: true,
    armorMM: 200, obliquityDeg: 10, ammoKind: 'AP', caliberMM: 460, shellMassKg: 1460,
    warheadKg: 17.5, energyMJ: 182, killerShipId: 'iowa', killerSide: 'ALLIED', killerName: 'USS Iowa',
  }, extra);
}

// ===========================================================================
section('1) 强制直击弹药库 → result=detonation 必沉（ship.sink + isAfloat=false）');

{
  const world = makeWorld(19420604);
  const y = spawn(world, 'yamato', 'AXIS', 'class:Yamato');
  const mag = magOf(y);
  mag.magRisk = 0.95;                     // 强制：单发直击把剩余风险推过 1 → 必爆
  applyHit(world, magazineHit(y));

  const evs = magEvents(world);
  const det = evs.find((e) => e.result === 'detonation');
  const sinks = sinkEvents(world);
  console.log('  dam.magazine: ' + JSON.stringify(evs.map((e) => ({ result: e.result, name: e.name, magRisk: e.magRisk, cause: e.cause }))));
  console.log('  ship.sink: ' + JSON.stringify(sinks.map((e) => ({ ship: e.ship, catastrophic: e.catastrophic, cause: e.cause }))) +
    ' | isAfloat=' + y.isAfloat + ' sunkAt=' + y.sunkAt + ' detonated=' + y.dmg.detonated);
  check('命中触发 dam.magazine(result=detonation)', !!det, det && det.result);
  check('dam.magazine 事件带 name/result/magRisk', !!det && det.name === y.name && typeof det.magRisk === 'number',
    det && (det.name + '/' + det.result + '/' + det.magRisk));
  check('殉爆后 ship.isAfloat=false', y.isAfloat === false, String(y.isAfloat));
  check('殉爆后 ship.sinking=true 且 sunkAt 已置位', y.sinking === true && y.sunkAt !== null,
    'sinking=' + y.sinking + ' sunkAt=' + y.sunkAt);
  check('殉爆 emit ship.sink(catastrophic) 且只发一次（无重复沉没事件）',
    sinks.length === 1 && sinks[0].catastrophic === true && sinks[0].ship === y.id,
    'ship.sink=' + sinks.length + ' 条');
  const iMag = world.seen.indexOf(det), iSink = world.seen.indexOf(sinks[0]);
  check('dam.magazine(detonation) 先于 ship.sink（因果顺序）', iMag >= 0 && iSink > iMag, iMag + ' < ' + iSink);
}

// ===========================================================================
section('2) 近空弹药库爆燃 → result=burn：重创、sinking=true，但不得抢发 ship.sink');

{
  const world = makeWorld(31415);
  const y = spawn(world, 'yamato', 'AXIS', 'class:Yamato');
  // 弹药几乎打空 → 爆燃当量 <1500kg（注意 STAR 也计入当量：0.5×STAR 发数×弹重×31%）
  for (const b of y.batteries) { b.ammo.AP = 0; b.ammo.HE = 0; b.ammo.STAR = 0; b.ammo.ILLUM = 0; }
  const mag = magOf(y);
  mag.magRisk = 0.95;
  applyHit(world, magazineHit(y));

  const evs = magEvents(world);
  const burn = evs.find((e) => e.result === 'burn');
  console.log('  dam.magazine: ' + JSON.stringify(evs.map((e) => ({ result: e.result, energyKg: e.energyKg, killed: e.killed }))) +
    ' | sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' speedCap=' + y.speedCapKn.toFixed(1) +
    ' crew=' + Math.round(y.crew) + '/' + y.crew0);
  check('近空库爆燃触发 dam.magazine(result=burn)', !!burn, burn && burn.result);
  check('爆燃属于重创：sinking=true、失去动力、弹药与子系统全毁',
    y.sinking === true && y.speedCapKn === 0 && y.subsystems.every((s) => s.destroyed),
    'sinking=' + y.sinking + ' speedCap=' + y.speedCapKn);
  check('爆燃不立即判沉（isAfloat 仍为 true，等 world 推进 sinkTimer）', y.isAfloat === true, String(y.isAfloat));
  check('爆燃不在这里 emit ship.sink（旧 bug：发了沉没事件却仍 isAfloat=true，world 会二次发）',
    sinkEvents(world).length === 0, 'ship.sink=' + sinkEvents(world).length + ' 条');
  check('爆燃仍记录 d.detonated/catastrophicLoss（AAR 需要重大损失标记）',
    y.dmg.detonated === true && y.dmg.catastrophicLoss === true);
}

// ===========================================================================
section('3) 风险事件（hit / flash / fire_threat / flooded）绝不能造成沉没');

// 3a) 直击未引爆：result=hit
{
  const world = makeWorld(2718);
  const y = spawn(world, 'yamato', 'AXIS', 'class:Yamato');
  applyHit(world, magazineHit(y));
  const evs = magEvents(world);
  const hit = evs.find((e) => e.result === 'hit');
  console.log('  hit 事件: ' + JSON.stringify(hit && { result: hit.result, magRisk: hit.magRisk, flashProtected: hit.flashProtected }) +
    ' | sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
  check('直击未引爆 → dam.magazine(result=hit) 且带 name/result/magRisk',
    !!hit && hit.result === 'hit' && hit.name === y.name && typeof hit.magRisk === 'number',
    hit && (hit.name + '/' + hit.result + '/' + hit.magRisk));
  check('result=hit 不造成沉没（!sinking && isAfloat && !detonated）',
    y.sinking === false && y.isAfloat === true && y.dmg.detonated === false,
    'sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
}

// 3b) 炮塔闪爆传火 → result=flash
{
  const world = makeWorld(20240601);
  const y = spawn(world, 'yamato', 'AXIS', 'class:Yamato');
  y.mainBatteries[0].flashProtection = false;      // 强制：无防闪爆门（老式战巡情形）
  // 3b 的本意是"炮塔中弹 → 扬弹机闪爆传火"，因此必须显式标注命中部位为 TURRET：
  // damage.js 现在只在 hitPart=TURRET 时走闪爆传火链路（舷侧/甲板穿透不再按 x 位置波及炮塔）。
  applyHit(world, magazineHit(y, { x_frac: 0.19, hitPart: 'TURRET', warheadKg: 10, energyMJ: 30, caliberMM: 356 }));
  const evs = magEvents(world);
  const flash = evs.find((e) => e.result === 'flash');
  console.log('  flash 事件: ' + JSON.stringify(evs.map((e) => ({ result: e.result, magRisk: e.magRisk, flashProtected: e.flashProtected }))) +
    ' | sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
  check('炮塔闪爆传火 → dam.magazine(result=flash)', !!flash, flash && flash.result);
  check('result=flash 不造成沉没（!sinking && isAfloat && !detonated）',
    y.sinking === false && y.isAfloat === true && y.dmg.detonated === false,
    'sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
}

// 3c) 火灾烘烤预警 → result=fire_threat
{
  const world = makeWorld(20240602);
  const y = spawn(world, 'yamato', 'AXIS', 'class:Yamato');
  const mag = magOf(y);
  mag.magRisk = 0.31;                              // 已过 0.3 预警阈值
  updateDamage(y, world, 0.1);
  const evs = magEvents(world);
  const threat = evs.find((e) => e.result === 'fire_threat');
  console.log('  fire_threat 事件: ' + JSON.stringify(threat && { result: threat.result, magRisk: threat.magRisk }) +
    ' | sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
  check('火灾烘烤 → dam.magazine(result=fire_threat)', !!threat, threat && threat.result);
  check('result=fire_threat 不造成沉没（!sinking && isAfloat && !detonated）',
    y.sinking === false && y.isAfloat === true && y.dmg.detonated === false,
    'sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
}

// 3d) 弹药库注水 → result=flooded
{
  const world = makeWorld(20240603);
  const y = spawn(world, 'yamato', 'AXIS', 'class:Yamato');
  const mag = magOf(y);
  mag.fire = 0.5;                                  // 弹库起火 → 损管队弃弹注水
  let flooded = null;
  for (let i = 0; i < 20 && !flooded; i++) {
    world.t += 0.1;
    updateDamage(y, world, 0.1);
    flooded = magEvents(world).find((e) => e.result === 'flooded') || null;
  }
  console.log('  flooded 事件: ' + JSON.stringify(flooded && { result: flooded.result, magRisk: flooded.magRisk, parties: flooded.parties }) +
    ' | magFlooded=' + mag.magFlooded + ' sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
  check('弹库注水 → dam.magazine(result=flooded)', !!flooded, flooded && flooded.result);
  check('result=flooded 不造成沉没（!sinking && isAfloat && !detonated）',
    y.sinking === false && y.isAfloat === true && y.dmg.detonated === false,
    'sinking=' + y.sinking + ' isAfloat=' + y.isAfloat + ' detonated=' + y.dmg.detonated);
}

// ===========================================================================
section('4) 事件词汇表：dam.magazine 的 result 只能取 6 个已知语义');
// 两组对照世界：一组走到 detonation，一组只到 hit，检查 result 与浮力状态一一对应
{
  const wDet = makeWorld(19420604);
  const yDet = spawn(wDet, 'det1', 'AXIS', 'class:Yamato');
  magOf(yDet).magRisk = 0.95;
  applyHit(wDet, magazineHit(yDet));
  const wHit = makeWorld(2718);
  const yHit = spawn(wHit, 'hit1', 'AXIS', 'class:Yamato');
  applyHit(wHit, magazineHit(yHit));

  const all = [...magEvents(wDet), ...magEvents(wHit)];
  console.log('  抽样 result 集合: ' + JSON.stringify([...new Set(all.map((e) => e.result))]) +
    ' | det 组 isAfloat=' + yDet.isAfloat + ' hit 组 isAfloat=' + yHit.isAfloat);
  check('所有 dam.magazine 事件都有 result 且属于已知语义集合',
    all.length > 0 && all.every((e) => KNOWN_RESULTS.has(e.result)), all.length + ' 条');
  check('所有 dam.magazine 事件都带 name（受害舰名）',
    all.every((e) => typeof e.name === 'string' && e.name.length > 0));
  const detEvs = magEvents(wDet), hitEvs2 = magEvents(wHit);
  check('result=detonation 的世界里舰已失去浮力；result=hit 的世界里舰仍浮航',
    detEvs.some((e) => e.result === 'detonation') && yDet.isAfloat === false &&
    hitEvs2.some((e) => e.result === 'hit') && yHit.isAfloat === true && yHit.sinking === false,
    'det.isAfloat=' + yDet.isAfloat + ' hit.isAfloat=' + yHit.isAfloat);
}

// ===========================================================================
console.log('\n===============================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('===============================');
process.exit(fail === 0 ? 0 : 1);