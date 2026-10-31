// ============================================================================
// 铁海 1942 · 损伤与损管系统 (damage.js)            T3 / damage-dc
// ----------------------------------------------------------------------------
// 物理模型与依据（每个经验系数量级都在注释里给出理由）：
//
// 1) 破口进水 —— 孔口出流（Torricelli / 伯努利）
//      Q = Cd · A · sqrt(2 g h)        Cd ≈ 0.62（锐缘孔口收缩系数）
//    h = 破口在当前水线以下的深度。舰体下沉(draft 增大)与横倾都会增大 h，
//    形成正反馈——这是未受控进水快速沉没的主因（日德兰、莱特湾的战例）。
//    舱内水面升到破口高度后进水停止；破口露出水面则反向排出（排水）。
//    关闭的舱室还有空气背压，用 ventFactor 近似通风能力。
//
// 2) 破口面积 —— 炮弹靠动能冲塞 + 少量装药爆破；鱼雷靠大装药撕裂舷侧
//    · 大和型 94 式 46cm/45：AP 弹重 1460 kg、初速 780 m/s、装药 17.5 kg；
//      HE 弹重 1360 kg、装药 81.6 kg（data/ships_axis.json）。
//    · AP 冲塞孔 ≈ 1.15 倍口径圆孔；HE/SAP 破口按装药量 A ≈ k·W^0.6 放大。
//    · 九三式酸氧鱼雷 610mm、九七式炸药 490 kg（TNT 当量 ≈ 780 kg）：
//      A ≈ 0.055·W^0.6 → 490 kg ≈ 2.3 m²。战史里一枚命中即可让驱逐舰
//      丧失全部动力甚至折断，此量级与之相符。
//
// 3) 稳性/横倾/纵倾 —— 由 ship.recomputeStability 统一计算：
//      tanθ = 横倾力矩 /(Δ·GM)，GM 随干舷损失折减。
//    本模块额外引入两个史实上极关键的因素：
//    · 低舷甲板边缘浸没后的 down-flooding（露天开口/通风筒/破舱口灌水），
//      可使横倾在数分钟内失控并倾覆；
//    · 反击水（counter-flooding）：向高舷注水对抗横倾，代价是牺牲储备浮力。
//
// 4) 火灾 —— 燃油/弹药火灾近似“燃料受控 + 通风供氧”：
//      dF/dt = k·fuel·(1−F) − 抑制
//    弹药库以温度积累风险 magRisk 表示，∫fire·dt 超阈即殉爆
//    （日德兰 1916 不倦/玛丽女王/无敌，1941 胡德，1943 陸奥，1945 大和）。
//    防闪爆门（batteries[].flashProtection）与弹药库注水是唯一可靠的抑制手段。
//
// 5) 水下爆炸舰体强度 —— 冲击因子 SF = W^(1/3)/R，用舰体特征尺度
//    R ≈ Δ^(1/3) 标定（几何相似律）。累计冲击形变达极限即舰体折断：
//    驱逐舰 3–4 枚九三式、战列舰十余枚，与战史相符。
//
// 6) 航速上限 —— 螺旋桨推进 P ∝ V³ → V/V0 = (P/P0)^(1/3)；
//    再乘进水增重 (Δ0/Δ)^(2/9)（同功率下阻力 ∝ Δ^(2/3)V² 的推论）、
//    横倾/纵倾、干舷损失、灭火分兵等折扣，写回 ship.speedCapKn。
//
// 单位：m, s, kg, m³, kn, deg；海水密度 1.025 t/m³。
// 确定性：所有随机数取自 world.rng；禁止 Math.random / DOM / 网络。
// 事件：dam.flood dam.fire dam.fire.out dam.magazine dam.subsystem dam.casualties
//       dam.list dam.flood.control dam.penetration dam.bounce
// ============================================================================
import { clamp, deg2rad } from '../core/util.js';
import { CompartmentKind } from './types.js';

// ---------------------------------------------------------------- 物理常数
const G = 9.80665;
const RHO_SEA_T = 1.025;                 // 海水密度 t/m³
const CD_ORIFICE = 0.62;                 // 锐缘孔口流量系数
const SQRT_2G = Math.sqrt(2 * G);
const PUMP_UTIL = 0.20;                  // 泵组实战可用排量（电源/吸口/管损/背压折扣；原 0.15 太保守，进水常压过泵速，船眼睁睁沉掉）
const VENT_OPEN = 1.0, VENT_CLOSED = 0.45;

// 舱壁设计水头：舱内压头超过舱深的该比例后，水密门/舱壁开始渗漏（渐进进水）
const BULKHEAD_LOAD_FRAC = 0.75;

// 火灾参数
const FIRE_GROWTH = 0.0045;              // /s，基础蔓延速率（燃油舱段更快）
const FIRE_SUPPRESS_PARTY = 0.011;       // /s·队，消防队灭火能力（1942 年损管教范：先隔断通风、再水幕降温、最后进入灭火）
const FIRE_SUPPRESS_SPRINKLER = 0.004;   // /s，弹药库喷淋
const FIRE_SUPPRESS_WATER = 0.06;        // /s，舱室已大半进水
const FIRE_FUEL_BURN = 0.00035;          // /s，燃料消耗（满火约 45 min 烧尽）
const MAG_RISK_RATE = 0.0065;            // /s，弹药库风险积累（fire=1 时）
const MAG_RISK_DECAY = 0.02;             // /s，无热源时风险自然消散
const MAG_FLOOD_DECAY = 0.05;            // /s，注水后风险快速归零
const CASUALTY_FIRE_RATE = 0.00040;      // /s，火场人员伤亡（比例）

// 损管优先级权重（任务紧迫度的乘子）
const DC_PRIORITY_WEIGHTS = {
  flooding: { flood: 1.00, fire: 0.55, magazine: 0.75, mobility: 0.35 },
  fire:     { flood: 0.50, fire: 1.00, magazine: 0.90, mobility: 0.30 },
  magazine: { flood: 0.70, fire: 0.85, magazine: 1.00, mobility: 0.25 },
  mobility: { flood: 0.60, fire: 0.50, magazine: 0.50, mobility: 1.00 },
};

// ---------------------------------------------------------------- 小工具
function dmgState(ship) {
  if (!ship.dmg) {
    ship.dmg = {
      hitCount: 0, torpHits: 0, shellHits: 0, nearMisses: 0, bounced: 0,
      casualties: 0, floatCasualties: 0,
      structural: 0,               // 累计冲击形变（>=1 折断）
      detonated: false, hullFailed: false, catastrophicLoss: false,
      counterFlooding: 0, counterFloodT: -1e9,
      fireIgnitions: 0, firesOut: 0,
      lastSummaryT: -1e9,
      engaged: false, plan: null, peakList: 0,
      stationsReady: false,
    };
    assignStations(ship);
  }
  return ship.dmg;
}

function ensureComp(c) {
  if (c.breachAreaM2 === undefined) c.breachAreaM2 = 0;
  if (c.sideBias === undefined) c.sideBias = 0;
  if (c.fireFuel === undefined) c.fireFuel = 1;
  if (c.magRisk === undefined) c.magRisk = 0;
  if (c.submerged === undefined) c.submerged = false;
  if (c.openVent === undefined) c.openVent = true;
  if (c.floodRateM3s === undefined) c.floodRateM3s = 0;
  if (c.integrity === undefined) c.integrity = 1;
  return c;
}

// 子系统/指挥仪/炮塔的纵向站位（x_frac 近似）。数据未给位置时按典型布置估。
function assignStations(ship) {
  const d = ship.dmg;
  if (d.stationsReady) return;
  const set = (list, kind, f) => {
    for (const s of list) if (s.kind === kind && s.station_frac === undefined) s.station_frac = f;
  };
  const boilers = ship.subsystems.filter((s) => s.kind === 'BOILER');
  boilers.forEach((s, i) => { if (s.station_frac === undefined) s.station_frac = 0.40 + ((i + 0.5) / boilers.length) * 0.16; });
  // 大和型主机布置：锅炉舱在 0.40–0.56，机舱/主减速器在 0.56–0.70
  const shafts = ship.subsystems.filter((s) => s.kind === 'SHAFT');
  shafts.forEach((s, i) => { if (s.station_frac === undefined) s.station_frac = 0.54 + ((i + 0.5) / shafts.length) * 0.16; });
  set(ship.subsystems, 'STEERING_GEAR', 0.925);
  set(ship.subsystems, 'ELECTRICAL', 0.50);
  set(ship.subsystems, 'PUMPS', 0.46);
  set(ship.subsystems, 'DC', 0.46);
  set(ship.subsystems, 'MAGAZINE_SPRINKLER', 0.50);
  ship.directors.forEach((dr, i) => {
    if (dr.station_frac === undefined) dr.station_frac = (dr.data && dr.data.positionFrac !== undefined) ? dr.data.positionFrac : (i === 0 ? 0.44 : 0.62);
  });
  ship.sensors.forEach((s) => {
    if (s.station_frac === undefined) s.station_frac = (s.data && s.data.positionFrac !== undefined) ? s.data.positionFrac : (s.srcKind === 'RADAR' ? 0.45 : 0.6);
  });
  ship.rangefinders.forEach((rf) => { if (rf.station_frac === undefined) rf.station_frac = 0.44; });
  // 主炮塔：常见 2 前 1 后 / 2 前 2 后布置
  const mains = ship.mainBatteries || [];
  const preset = { 1: [0.5], 2: [0.20, 0.80], 3: [0.18, 0.36, 0.82], 4: [0.18, 0.36, 0.64, 0.82], 5: [0.15, 0.32, 0.50, 0.68, 0.85] };
  const pf = preset[mains.length] || mains.map((_, i) => 0.15 + 0.7 * (i / Math.max(1, mains.length - 1)));
  mains.forEach((b, i) => { if (b.station_frac === undefined) b.station_frac = pf[i] !== undefined ? pf[i] : 0.5; });
  (ship.secondaryBatteries || []).forEach((b, i) => { if (b.station_frac === undefined) b.station_frac = 0.33 + 0.34 * ((i % 4) / 3); });
  (ship.torpedoMounts || []).forEach((m, i) => { if (m.station_frac === undefined) m.station_frac = 0.45 + (i === 0 ? -0.05 : 0.05); });
  d.stationsReady = true;
}

// ---------------------------------------------------------------- 命中几何
function isTorpedoHit(hit) {
  return !!(hit.isTorpedo || hit.kind === 'TORPEDO' || hit.weapon === 'TORPEDO' || hit.mine);
}
function sideBiasOf(hit, rng) {
  const b = sideBiasFromFields(hit);
  if (b !== 0) return b;
  return rng.chance(0.5) ? 1 : -1;    // 命中位置信息缺失时随机（契约 sideBias 不可用）
}
function ammoKindOf(hit) {
  const a = hit.ammoKind || hit.ammo || hit.shell || null;
  return a ? String(a).toUpperCase() : null;
}

// 破口面积 m²。炮弹：冲塞孔 + 装药爆破；鱼雷：大装药撕裂舷侧。
function holeAreaM2(hit, isTorp) {
  const W = Math.max(0, hit.warheadKg || 0);
  if (isTorp) {
    const charge = W > 0 ? W : (hit.tntKg ? hit.tntKg / 1.6 : 300);
    return clamp(0.055 * Math.pow(Math.max(60, charge), 0.6), 0.35, 12);
  }
  const cal = hit.caliberMM || 0;
  const ammo = ammoKindOf(hit) || 'AP';
  const k = ammo === 'HE' ? 0.085 : ammo === 'SAP' ? 0.055 : 0.030;
  const blast = W > 0 ? k * Math.pow(W, 0.6) : 0;
  const kinetic = cal > 0 ? 0.785 * Math.pow(1.15 * cal / 1000, 2) : 0;
  return clamp(blast + kinetic, 0.03, 8);
}

// 破口在水线下的参考深度。炮弹多命中舷侧水线带（T4 的命中判定含落角与投影），
// 鱼雷按定深（驱逐舰更浅）确定，避免引入不必要的随机性。
function breachDepthM(ship, hit, isTorp, rng) {
  let given = hit.depthM !== undefined ? hit.depthM : (hit.hitDepthM !== undefined ? hit.hitDepthM : undefined);
  if (given === undefined && hit.impact && hit.impact.z !== undefined) given = Math.max(0, -hit.impact.z);  // T4：z 为水线以上高度
  if (given === undefined && hit.detonation && hit.detonation.depthM !== undefined) given = Math.max(0, hit.detonation.depthM);
  if (given !== undefined) return given;
  if (isTorp) return clamp(ship.draftM * 0.45, 1.2, 5.5);
  return ship.draftM * 0.5 + rng.normal(0, 1.1);
}

function fuelFactor(ship, c) {
  if (c.isMagazine) return 1.70;
  if (c.kind === CompartmentKind.BOILER) return 1.45;   // 重油 + 高温
  if (c.kind === CompartmentKind.MACHINERY) return 1.35;
  if (c.kind === CompartmentKind.TANK) return 0.35;
  if (c.kind === CompartmentKind.BOW || c.kind === CompartmentKind.STERN) return 0.60;
  return 1.00;
}

function magazineCompartments(ship) {
  if (!ship._magComps) ship._magComps = ship.compartments.filter((c) => c.isMagazine);
  return ship._magComps;
}
// 弹药库供给哪些炮塔：按炮塔站位就近的弹药库（扬弹机链路）
// 炮塔 → 对应弹药库（扬弹机链路）
function magazineForBattery(ship, b) {
  const mags = magazineCompartments(ship);
  const sf = b.station_frac !== undefined ? b.station_frac : 0.5;
  let best = null, bd = 9e9;
  for (const m of mags) { const dd = Math.abs(m.x_frac - sf); if (dd < bd) { bd = dd; best = m; } }
  return best;
}
function fedBatteries(ship, mag) {
  const mags = magazineCompartments(ship);
  return ship.batteries.filter((b) => {
    if (b.mountType === 'aa') return false;
    let best = null, bd = 9e9;
    for (const m of mags) { const dd = Math.abs(m.x_frac - b.station_frac); if (dd < bd) { bd = dd; best = m; } }
    return best === mag;
  });
}
function magFlashProtected(ship, c) {
  let best = null, bd = 9e9;
  for (const b of (ship.mainBatteries || [])) { const dd = Math.abs(b.station_frac - c.x_frac); if (dd < bd) { bd = dd; best = b; } }
  return !!(best && best.flashProtection);
}
function sprinklerHealth(ship) {
  const s = ship.subsystems.find((x) => x.kind === 'MAGAZINE_SPRINKLER');
  return s && !s.destroyed ? s.health : 0;
}
function dcSubsystem(ship) { return ship.subsystems.find((x) => x.kind === 'DC') || null; }

// ---------------- 命中对象归一化（兼容 ballistics 与 torpedo 两套字段） ----------------
// ballistics(T4) 发 {kind:'SHELL', ship(受害者id), impact:{xFrac,z,obliquityDeg,velocityMps,localAcross},
//   armorMM, penetrated, detonated, detonation:{xFrac,depthM}, explosiveKg, passThrough, dud, attackerId/Side ...}
// torpedo(T5) 发 {kind:'TORPEDO', targetShip, x_frac, compartmentIndex, sideBias, depthM, warheadKg(TNT当量),
//   chargeKg, isTorpedo, killerShipId/Side ...}
// 本函数把两套字段折叠成契约 §3.1 的规范 Hit；不消耗随机数（可重复调用）。
function pick() { for (let i = 0; i < arguments.length; i++) { const v = arguments[i]; if (v !== undefined && v !== null) return v; } return undefined; }
function sideBiasFromFields(raw) {
  if (raw.sideBias !== undefined && raw.sideBias !== null && raw.sideBias !== 0) return Math.sign(raw.sideBias);
  const imp = raw.impact || {}, ent = raw.entry || {};
  const across = pick(imp.localAcross, imp.across, ent.across);
  if (across !== undefined && across !== 0) return Math.sign(across);
  const s = String(raw.side || '').toUpperCase();
  if (s === 'PORT' || s === 'LEFT' || s === 'P') return -1;
  if (s === 'STBD' || s === 'STARBOARD' || s === 'RIGHT' || s === 'S') return 1;
  return 0;
}
export function normalizeHit(raw) {
  if (!raw) return null;
  const imp = raw.impact || {}, sh = raw.shell || {};
  const isTorp = isTorpedoHit(raw);
  const n = Object.assign({}, raw);
  n.isTorpedo = isTorp;
  n.x_frac = pick(raw.x_frac, raw.xFrac, imp.xFrac, raw.detonation && raw.detonation.xFrac);
  n.compartmentIndex = pick(raw.compartmentIndex, raw.compartment);
  n.sideBias = sideBiasFromFields(raw);
  n.penetrates = raw.penetrates !== undefined ? raw.penetrates : (raw.penetrated !== undefined ? raw.penetrated : true);
  n.warheadKg = pick(raw.warheadKg, raw.explosiveKg, sh.explosiveKg, 0);
  n.tntKg = pick(raw.tntKg, raw.tntEquivalentKg, raw.warheadKg, 0);
  n.caliberMM = pick(raw.caliberMM, sh.caliberMM, raw.diameterMm, 0);
  n.shellMassKg = pick(raw.shellMassKg, raw.massKg, sh.massKg, 0);
  n.velocityMps = pick(raw.velocityMps, imp.velocityMps, 0);
  n.obliquityDeg = pick(raw.obliquityDeg, imp.obliquityDeg, imp.fallAngleDeg, 0);
  n.energyMJ = pick(raw.energyMJ, (n.shellMassKg > 0 && n.velocityMps > 0) ? 0.5 * n.shellMassKg * n.velocityMps * n.velocityMps / 1e6 : undefined, 0);
  n.ammoKind = ammoKindOf(raw) || (isTorp ? 'TORPEDO' : null);
  n.isNearMiss = !!(raw.isNearMiss || raw.nearMiss);
  n.depthM = pick(raw.depthM, raw.hitDepthM,
    imp.z !== undefined ? Math.max(0, -imp.z) : undefined,
    raw.detonation && raw.detonation.depthM !== undefined ? Math.max(0, raw.detonation.depthM) : undefined);
  n.dud = !!raw.dud || raw.detonated === false;
  n.passThrough = !!raw.passThrough;
  n.killerShipId = pick(raw.killerShipId, raw.attackerId, raw.shooterId, raw.killer && raw.killer.id);
  n.killerSide = pick(raw.killerSide, raw.attackerSide, raw.shooterSide, raw.killerShip && raw.killerShip.side);
  n.killerName = pick(raw.killerName, raw.attackerName, raw.shooterName, raw.killer && raw.killer.name, raw.killerShip && raw.killerShip.name);
  n.hitPart = pick(imp.hitPart, raw.hitPart, raw.part);
  n.penetrationMM = pick(raw.penetrationMM, raw.effectivePenMM, 0);
  n.detonationXFrac = raw.detonation ? raw.detonation.xFrac : undefined;
  n.hitDepthReal = imp.z !== undefined ? Math.max(0, -imp.z) : n.depthM;
  return n;
}

// ---------------------------------------------------------------- 事件
function ev(world, ship, hit, type, extra) {
  const base = {
    t: world.t, ship: ship.id, name: ship.name,
    side: ship.side, victimSide: ship.side,
    killerShipId: hit ? (hit.killerShipId || (hit.killerShip && hit.killerShip.id) || null) : null,
    killerSide: hit ? (hit.killerSide || (hit.killerShip && hit.killerShip.side) || null) : null,
    killerName: hit ? (hit.killerName || (hit.killerShip && hit.killerShip.name) || null) : null,
    compartment: null, value: null,
  };
  return world.events.emit(type, Object.assign(base, extra || {}));
}

// ---------------------------------------------------------------- 命中处理
export function applyHit(world, rawHit) {
  if (!world || !rawHit) return null;
  const hit = normalizeHit(rawHit);
  const ship = resolveShip(world, hit);
  if (!ship || !ship.isAfloat) return null;
  // 调试/标定用：不可损伤目标（沙盒"无敌"或火控标定测试，避免目标被击伤后几何变化干扰收敛）
  if (ship._invulnerable) return null;
  if (ship.dmg && ship.dmg.detonated) return null;
  const d = dmgState(ship);
  const rng = world.rng;
  const isTorp = isTorpedoHit(hit);
  const near = !!hit.isNearMiss;
  const pen = hit.penetrates !== false;
  ship.flags.engaged = true;
  // 统计口径：hitsTaken 只统计真正的命中；近失弹（水柱/水中冲击）单独计入 nearMisses。
  // 旧实现把近失也当命中，加上 ballistics 的重复计数，AAR「被命中」合计 = gun.hit*2 + gun.nearmiss。
  // 碰撞（isCollision）造成的破口/进水不计入「被命中」口径——它不是被炮弹/鱼雷命中，
  // 否则 AAR 的命中/发射统计与命中率会把自撞算成敌人战果。
  if (!near && !hit.isCollision) {
    ship.stats.hitsTaken++;   // 唯一的「被命中」计数入口（ballistics/torpedo 不再自行累加）
    d.hitCount++;             // 近失只进 d.nearMisses，不进命中计数
  }
  if (isTorp) d.torpHits++; else if (pen) d.shellHits++;

  // ---- 舱室定位：优先 compartmentIndex / compartment，否则用 x_frac ----
  const comps = ship.compartments;
  let c = null;
  const ci = hit.compartmentIndex !== undefined ? hit.compartmentIndex : hit.compartment;
  if (ci !== undefined && comps[ci]) c = comps[ci];
  else {
    const xf = hit.x_frac;                     // normalizeHit 已折叠 x_frac/xFrac/impact.xFrac/detonation
    if (xf !== undefined) c = ship.compartmentAt(xf);
    else c = comps[rng.int(0, comps.length - 1)];
  }
  if (!c) return null;
  ensureComp(c);
  const sideBias = sideBiasOf(hit, rng);
  const isMagazine = !!c.isMagazine;
  const armorMM = hit.armorMM || 0;

  // ---- 近失弹：水柱与水中弹道造成的舷侧变形、铆钉渗漏与冲击 ----
  if (near) {
    d.nearMisses++;
    if (ship.stats) ship.stats.nearMisses = (ship.stats.nearMisses || 0) + 1;
    applyNearMiss(world, ship, hit, c, d, isTorp);
    return { compartment: c.i, nearMiss: true };
  }

  // ---- 未击穿：跳弹/被装甲挡住 ----
  if (!pen) {
    d.bounced++;
    const sev0 = clamp(0.12 + (hit.energyMJ || 0) / 600, 0.05, 0.35);
    c.integrity = clamp(c.integrity - sev0 * 0.5, 0.05, 1);
    applyCasualties(world, ship, hit, c, d, 0.18 * sev0, 'HE_SPLINTER');
    // 水线附近未击穿也可能因铆钉渗漏少量进水
    const depth = breachDepthM(ship, hit, isTorp, rng);
    if (depth > 0 && (hit.energyMJ || 0) > 30 && rng.chance(0.35)) {
      c.breachAreaM2 += 0.015;
      c.breachDepthM = c.breachDepthM !== undefined ? Math.max(c.breachDepthM, depth) : depth;
      c.sideBias = c.sideBias || sideBias;
      c.breached = true;
    }
    if ((hit.energyMJ || 0) > 60 && rng.chance(0.18)) igniteFire(world, ship, hit, c, d, 0.12, '跳弹引燃');
    // ── 炮塔直接命中但未击穿 ────────────────────────────────────────────────
    // 旧实现未穿透就直接 return，炮塔"没被穿透"= 完全没事，于是史实胡德的死法
    // （炮塔中弹 → 火焰沿扬弹机窜入弹药库 → 3 分钟殉爆）在模型里根本不存在：
    // 丹麦海峡变体局里胡德挨了 72 发（含 2 发 380mm 直接命中炮塔，均被 305mm/炮塔装甲挡住）
    // 却始终不殉爆，只能被进水慢慢淹 28 分钟。
    // 这里补上"未击穿也会伤炮塔 + 低概率闪爆传火"这条链，概率远低于击穿（每发 2%~7%）。
    if (!isTorp && hit.hitPart === 'TURRET') {
      const mainsB = (ship.mainBatteries || []).slice().sort((a, b2) => Math.abs(a.station_frac - c.x_frac) - Math.abs(b2.station_frac - c.x_frac));
      const tb = mainsB[0];
      if (tb && Math.abs(tb.station_frac - c.x_frac) <= 0.07) {
        tb.health = clamp(tb.health - 0.5 * sev0 * 3, 0, 1);
        tb.crewLoss = clamp((tb.crewLoss || 0) + 0.1 * sev0, 0, 1);
        if (tb.health <= 0.05) tb.destroyed = true;
        ev(world, ship, hit, 'dam.subsystem', {
          compartment: c.i, kind: 'TURRET', name: tb.label,
          value: +tb.health.toFixed(2), health: +tb.health.toFixed(2), destroyed: tb.destroyed, cause: '炮塔被弹（未击穿）',
        });
        const magB = magazineForBattery(ship, tb);
        if (magB) {
          const prot = !!tb.flashProtection && (magB.flashProtection !== false);
          const risk = (prot ? 0.05 : 0.12) * clamp(sev0 * 4, 0.4, 1.4);
          magB.magRisk = clamp((magB.magRisk || 0) + risk, 0, 1.2);
          if (risk > 0.015) {
            ev(world, ship, hit, 'dam.magazine', {
              compartment: magB.i, x_frac: +magB.x_frac.toFixed(3), result: 'flash',
              value: +magB.magRisk.toFixed(2), magRisk: +magB.magRisk.toFixed(2),
              flashProtected: prot, cause: '炮塔被弹闪爆传火',
            });
          }
          if (magB.magRisk >= 1) explodeMagazine(world, ship, magB, d);
        }
      }
    }
    emitBounce(world, ship, hit, c, armorMM);
    return { compartment: c.i, penetrates: false };
  }

  // ---- 击穿船体 ----
  const area = holeAreaM2(hit, isTorp);
  const depth = breachDepthM(ship, hit, isTorp, rng);
  const submergedHole = depth > 0.05;
  c.breached = true;
  c.breachedAt = world.t;
  c.sideBias = (c.sideBias || 0) !== 0 ? c.sideBias : sideBias;
  c.integrity = clamp(c.integrity - (0.15 + 0.45 * clamp(area / 2.5, 0, 1)), 0.05, 1);
  if (submergedHole) {
    c.breachDepthM = c.breachDepthM !== undefined ? Math.min(c.breachDepthM, depth) : depth;
    c.breachAreaM2 += area;
    c._floodSignaled = false;
    if (!c.openVent) c.openVent = true;
  } else {
    c.breachAboveWater = true;
  }

  // 鱼雷爆炸的冲击与鞭状振动会撕裂相邻舱壁、震开未锁的水密门——破口不会停在命中舱。
  // 史实：一条 610mm 九三式往往同时灌满机舱与相邻舱室；"只淹一个舱"等于把鱼雷当炮弹打。
  if (isTorp && submergedHole) {
    const Wt = hit.warheadKg || hit.tntKg || 300;
    // 防雷纵舱壁（TDS）与分舱密度：主力舰能把爆炸能量限制在舷侧，巡洋舰次之，驱逐舰几乎没有
    const tdsFactor = (ship.type === 'BB' || ship.type === 'BC') ? 0.45 : ship.type === 'CV' ? 0.5 : (ship.type === 'CA' || ship.type === 'CL') ? 0.75 : 0.75;
    // 小舰分舱少：同样 ±2 个舱位对驱逐舰等于半条船，只扩散到相邻一舱
    const reach = ship.type === 'DD' ? 1 : 2;
    const spread = clamp(0.25 + Wt / 1100, 0.25, 0.8) * tdsFactor;   // 490kg → 0.70 × TDS 系数
    for (const j of [c.i - reach, c.i - 1, c.i + 1, c.i + reach]) {
      const nb = ship.compartments[j];
      if (!nb || j === c.i) continue;
      ensureComp(nb);
      const f = spread / Math.abs(j - c.i);
      nb.integrity = clamp(nb.integrity - 0.6 * f, 0.05, 1);
      nb.breachAreaM2 += 0.28 * f * tdsFactor;
      nb.breachDepthM = nb.breachDepthM !== undefined ? Math.min(nb.breachDepthM, depth) : depth;
      nb.sideBias = (nb.sideBias || 0) !== 0 ? nb.sideBias : sideBias;
      nb.breached = true;
      nb._floodSignaled = false;
      if (!nb.openVent) nb.openVent = true;
    }
  }

  let sev = clamp(0.35 + (hit.energyMJ || 0) / 140 + (isTorp ? 0.5 : 0), 0.25, 1.6);
  // 大口径穿甲弹"过穿"薄板：底引信未必起爆，但 300mm+ 的弹体在舰内穿行本身就是灾难性的
  // （大破口、火灾、成片伤亡）。旧实现只乘 0.70，等于铁棍穿纸——近战里战列舰的 AP
  // 打不动巡洋舰上层建筑，反而被 8 吋速射压制。用等效毁伤补偿，不改弹道/观测行为。
  const overPenCal = hit.caliberMM || hit.caliber_mm || (hit.shell && hit.shell.caliberMM) || 0;
  if (hit.passThrough && !isTorp && overPenCal >= 280) sev = Math.max(sev, 1.25);
  // 哑弹（未起爆）与穿而炸（pass-through）：舰内爆破效应大减
  if (hit.dud && !isTorp) sev *= 0.55;
  else if (hit.passThrough && !isTorp) sev *= 0.70;

  // 水下爆炸冲击：即使防雷纵舱壁（TDS）挡住，也会因鞭状振动损坏主机
  if (isTorp) {
    const W = hit.tntKg ? hit.tntKg : (hit.warheadKg || 300);
    const SF = Math.pow(Math.max(20, W), 1 / 3) / Math.pow(Math.max(500, ship.displacement_t || 2000), 1 / 3);
    d.structural += clamp(0.45 * SF, 0, 1.0);
    applyWhipping(world, ship, hit, c, d, sev, rng);
    emitPenetration(world, ship, hit, c, area, armorMM, sev);
    if (d.structural >= 1) { hullFailure(world, ship, c, d); return { compartment: c.i, hullFailure: true }; }
  } else {
    const W = hit.warheadKg || 0;
    const SF = Math.pow(Math.max(3, W), 1 / 3) / Math.pow(Math.max(500, ship.displacement_t || 2000), 1 / 3);
    d.structural += clamp(0.45 * SF * 0.25, 0, 0.3);   // 炮弹对总纵强度影响小
    emitPenetration(world, ship, hit, c, area, armorMM, sev);
  }

  // 弹药库直击
  if (isMagazine) magazineDirectHit(world, ship, hit, c, d, sev, rng);

  // 子系统级联损失
  damageSubsystems(world, ship, hit, c, d, sev, isTorp, rng);

  // 引信延迟：炮弹穿入后在更深的舱段起爆（T4 给出 detonation.xFrac/depthM）
  if (!isTorp && hit.detonationXFrac !== undefined) {
    const c2 = ship.compartmentAt(hit.detonationXFrac);
    if (c2 && c2 !== c) {
      ensureComp(c2);
      c2.integrity = clamp(c2.integrity - 0.25, 0.05, 1);
      const d2 = hit.detonation && hit.detonation.depthM !== undefined ? hit.detonation.depthM : 0;
      if (d2 > 0.05) {
        c2.breachAreaM2 += area * 0.3;
        c2.breachDepthM = c2.breachDepthM !== undefined ? Math.min(c2.breachDepthM, d2) : d2;
        c2.sideBias = (c2.sideBias || 0) !== 0 ? c2.sideBias : sideBias;
        c2.breached = true;
      }
      damageSubsystems(world, ship, hit, c2, d, sev * 0.6, false, rng);
      applyCasualties(world, ship, hit, c2, d, 0.15 * clamp(sev, 0, 1.4), 'SHELL_INTERNAL');
      if (rng.chance(clamp(0.12 * sev, 0, 0.5))) igniteFire(world, ship, hit, c2, d, 0.18, '引信延迟在相邻舱段起爆');
    }
  }

  // 人员伤亡
  const ammo = ammoKindOf(hit);
  let lethality = ammo === 'HE' ? 0.55 : ammo === 'SAP' ? 0.42 : 0.30;
  if (isTorp) lethality = 0.80;
  if (hit.dud && !isTorp) lethality *= 0.45;
  else if (hit.passThrough && !isTorp) lethality *= 0.65;
  applyCasualties(world, ship, hit, c, d, lethality * clamp(sev, 0, 1.4), isTorp ? 'TORPEDO' : 'SHELL');

  // 引燃：轮机油舱/弹药库最危险（hit.forceFire 供剧本/脚本强制点火）
  if (hit.forceFire) igniteFire(world, ship, hit, c, d, hit.fireIntensity !== undefined ? hit.fireIntensity : 0.3, '命中引燃(脚本)');
  let igniteP = 0.06 * sev * fuelFactor(ship, c);
  if (isTorp) igniteP = 0.55;
  if (ammo === 'HE') igniteP *= 1.7;
  if (hit.dud && !isTorp) igniteP *= 0.15;
  else if (hit.passThrough && !isTorp) igniteP *= 0.5;
  if (rng.chance(clamp(igniteP, 0, 0.95))) igniteFire(world, ship, hit, c, d, clamp(0.15 + 0.35 * sev * 0.6, 0.1, 0.8), isTorp ? '鱼雷燃油/弹药引燃' : '命中引燃');

  d.engaged = true;
  return { compartment: c.i, penetrates: true, areaM2: area, depthM: depth };
}

function resolveShip(world, hit) {
  const cand = hit.targetShip || hit.targetShipId || hit.target || hit.targetId || hit.victimId ||
    (typeof hit.ship === 'string' ? hit.ship : (hit.ship && hit.ship.compartments ? hit.ship : null));
  if (!cand) return null;
  if (typeof cand === 'string') return world.ship ? world.ship(cand) : null;
  if (cand.compartments) return cand;
  if (cand.id && world.ship) return world.ship(cand.id);
  return null;
}

function emitPenetration(world, ship, hit, c, area, armorMM, sev) {
  ev(world, ship, hit, 'dam.penetration', {
    compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: Math.round(armorMM || 0),
    armorMM: armorMM || 0, obliquityDeg: hit.obliquityDeg || 0, ammoKind: ammoKindOf(hit),
    energyMJ: hit.energyMJ !== undefined ? +(+hit.energyMJ).toFixed(1) : null,
    holeAreaM2: +area.toFixed(3), severity: +sev.toFixed(2), kind: isTorpedoHit(hit) ? 'TORPEDO' : 'SHELL',
    hitPart: hit.hitPart || null, shellMassKg: hit.shellMassKg || 0, velocityMps: +(hit.velocityMps || 0).toFixed(0),
    penetrationMM: hit.penetrationMM || 0, dud: !!hit.dud, passThrough: !!hit.passThrough,
  });
}
function emitBounce(world, ship, hit, c, armorMM) {
  ev(world, ship, hit, 'dam.bounce', {
    compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: Math.round(armorMM || 0),
    armorMM: armorMM || 0, obliquityDeg: hit.obliquityDeg || 0, ammoKind: ammoKindOf(hit),
    energyMJ: hit.energyMJ !== undefined ? +(+hit.energyMJ).toFixed(1) : null,
  });
}

// 近失弹：水柱冲击 + 舷侧变形/铆钉渗漏，不形成大破口
function applyNearMiss(world, ship, hit, c, d, isTorp) {
  const rng = world.rng;
  const E = hit.energyMJ || 0;
  const sev = clamp(0.1 + E / 500, 0.05, 0.5);
  c.integrity = clamp(c.integrity - sev * 0.4, 0.1, 1);
  const depth = breachDepthM(ship, hit, isTorp, rng);
  if (depth > 0) {
    c.breachAreaM2 += 0.01 + 0.05 * sev;      // 铆钉/焊缝渗漏
    c._floodSignaled = false;
    c.breachDepthM = c.breachDepthM !== undefined ? Math.min(c.breachDepthM, depth) : depth;
    c.sideBias = c.sideBias || sideBiasOf(hit, rng);
    c.breached = true;
    ev(world, ship, hit, 'dam.flood', {
      compartment: c.i, x_frac: +c.x_frac.toFixed(3), result: 'near_miss_leak',
      value: +c.breachAreaM2.toFixed(3), areaM2: +c.breachAreaM2.toFixed(3), depthM: +depth.toFixed(2),
    });
  }
  if (E > 25 || isTorp) shockSubsystems(world, ship, hit, c, d, clamp(sev * 0.7, 0.05, 0.5), rng);
  applyCasualties(world, ship, hit, c, d, 0.05 * sev, 'NEAR_MISS');
  d.engaged = true;
}

// 鱼雷冲击（鞭状振动）：TDS 未破也会打坏锅炉/主轴/舵机
function applyWhipping(world, ship, hit, c, d, sev, rng) {
  const W = hit.tntKg ? hit.tntKg : (hit.warheadKg || 300);
  const p = clamp(W / 900, 0.15, 0.85);
  shockSubsystems(world, ship, hit, c, d, p, rng);
}
function shockSubsystems(world, ship, hit, c, d, p, rng) {
  const near = ship.subsystems
    .filter((s) => s.kind === 'BOILER' || s.kind === 'SHAFT' || s.kind === 'STEERING_GEAR' || s.kind === 'ELECTRICAL')
    .map((s) => ({ s, dist: Math.abs((s.station_frac !== undefined ? s.station_frac : 0.5) - c.x_frac) }))
    .sort((a, b) => a.dist - b.dist);
  for (const { s, dist } of near.slice(0, 3)) {
    if (rng.next() > p * clamp(1 - dist * 3, 0.15, 1)) continue;
    damageSystem(world, ship, hit, s, clamp(0.25 + 0.5 * p, 0.15, 0.8), '水下爆炸冲击');
  }
}

// 舱室内机械随命中被摧毁（锅炉/主轴按站位）
function damageSubsystems(world, ship, hit, c, d, sev, isTorp, rng) {
  const x = c.x_frac;
  const span = (c.length_m / Math.max(1, ship.data.loa_m || 100)) * (isTorp ? 1.5 : 0.9) + 0.02;
  const boilers = ship.subsystems.filter((s) => s.kind === 'BOILER')
    .sort((a, b) => Math.abs(a.station_frac - x) - Math.abs(b.station_frac - x));
  const shafts = ship.subsystems.filter((s) => s.kind === 'SHAFT')
    .sort((a, b) => Math.abs(a.station_frac - x) - Math.abs(b.station_frac - x));
  // 大舰子系统有装甲与冗余：同样的命中对它们造成的相对损伤更小。
  // 史实：俾斯麦在最后一场战斗里挨了 90+ 发（多数在 3~5km 直射）才被自沉，而驱逐舰 2~3 发就会失去动力。
  // 旧模型对所有人都用同一套系数 → 俾斯麦中 14 发就丢 3 座主炮、速度上限掉到 10 节，明显失真。
  const baseResist = ship.type === 'BB' ? 0.42 : ship.type === 'BC' ? 0.50
    : ship.type === 'CV' ? 0.55 : ship.type === 'CA' ? 0.72 : 1.0;
  // 弹径越大破坏越大：460mm 命中仍能直接废掉一座锅炉/主轴（大和级），15 吋约 0.7 倍，8 吋约 0.5 倍。
  const calMM = hit.caliberMM || hit.caliber_mm || 200;
  const resist = baseResist + (1 - baseResist) * clamp((calMM - 280) / 180, 0, 1);

  if (c.isMachinery) {
    // 单发炮弹的爆炸范围只够毁掉"一个设备组"：一枚 16 吋 AP 的装药只有十几公斤，
    // 而战列舰的锅炉间距约 7~10 m、且分置于彼此独立的机炉舱。旧模型对炮弹取 nb=2、
    // 半径 rB=0.10（大和 263 m 即 26 m）→ 一发穿透弹同时打坏两台锅炉，2~3 发就把动力打到
    // 63%，速度上限跌破 AI 的 72% 退出线，于是"大和挨几发就判重伤撤退"。
    // 鱼雷（数百公斤装药、鞭状振动）才允许连带相邻设备组。
    const nb = isTorp ? 3 : 1, ns = isTorp ? 2 : 1;
    const rB = isTorp ? 0.14 : 0.055, rS = isTorp ? 0.10 : 0.05;
    for (const s of boilers.slice(0, nb)) if (Math.abs(s.station_frac - x) <= rB) damageSystem(world, ship, hit, s, clamp(sev, 0.4, 1) * resist, '机炉舱命中');
    for (const s of shafts.slice(0, ns)) if (Math.abs(s.station_frac - x) <= rS) damageSystem(world, ship, hit, s, clamp(sev, 0.4, 1) * resist, '机炉舱命中');
    const elec = ship.subsystems.find((s) => s.kind === 'ELECTRICAL');
    if (elec && Math.abs(elec.station_frac - x) <= 0.18) damageSystem(world, ship, hit, elec, 0.25 * sev * resist, '机舱命中');
    const pumps = ship.subsystems.find((s) => s.kind === 'PUMPS');
    if (pumps && Math.abs(pumps.station_frac - x) <= 0.22) damageSystem(world, ship, hit, pumps, 0.3 * sev * resist, '机舱命中');
  }
  // 舵机舱
  if (c.isSteering || x > 0.88) {
    const st = ship.subsystems.find((s) => s.kind === 'STEERING_GEAR');
    if (st) {
      damageSystem(world, ship, hit, st, 0.9 * sev * resist, '舵机舱命中');
      if (st.destroyed && st.jamAngle === null) st.jamAngle = rng.chance(0.5) ? 25 : -25;
    }
  }
  // 舰桥/指挥仪/雷达：只有命中上层建筑/舰桥/炮塔的穿透弹才可能波及这些暴露设备。
  // 旧实现按"x 落在 0.33~0.62"一刀切——舷侧装甲带（BELT）的穿透弹在舰内爆炸也能 2~3 发
  // 打光指挥仪与雷达，大和就是这样在 3 分钟内失去全部火控、几乎一发没还手。
  const hitPartKind = hit.hitPart || '';
  const hitSuper = hitPartKind === 'SUPERSTRUCTURE' || hitPartKind === 'BRIDGE' || hitPartKind === 'TURRET';
  if (hitSuper && x > 0.33 && x < 0.62) {
    const dirs = ship.directors.slice().sort((a, b) => Math.abs(a.station_frac - x) - Math.abs(b.station_frac - x));
    // 指挥仪塔：重型装甲（100~150mm）+ 体积小。史实上俾斯麦的主指挥仪直到最后阶段才被打掉，
    // 而旧模型 2~3 发就让一艘战列舰彻底丧失火控——这会让一方瞬间"变瞎"，双方都受害。
    // 主力舰指挥仪塔是重点防护部位（100~150mm 装甲 + 体积小）：8 吋在近距也很难击穿，
    // 15 吋以上命中才有真正的机会。没有这层区分时，重巡 3 分钟就能打瞎一艘战列舰的火控。
    const dirCal = hit.caliberMM || hit.caliber_mm || 203;
    const dirMul = (ship.type === 'BB' || ship.type === 'BC')
      ? 0.15 * clamp(Math.pow(dirCal / 381, 2), 0.08, 1)     // 8 吋 ≈0.04，11 吋 ≈0.08，15 吋 0.15
      : 0.35;
    if (dirs[0] && Math.abs(dirs[0].station_frac - x) <= 0.10) damageSystem(world, ship, hit, dirs[0], 0.8 * sev * resist * dirMul, '指挥仪命中');
    const sens = ship.sensors.slice().sort((a, b) => Math.abs(a.station_frac - x) - Math.abs(b.station_frac - x));
    const sensMul = (ship.type === 'BB' || ship.type === 'BC') ? clamp(Math.pow(dirCal / 381, 2), 0.06, 1) : 1;
    if (sens[0] && Math.abs(sens[0].station_frac - x) <= 0.1) {
      sens[0].health = clamp(sens[0].health - 0.7 * sev * resist * sensMul, 0, 1);
      if (sens[0].health <= 0.05) { sens[0].health = 0; sens[0].destroyed = true; }
      ev(world, ship, hit, 'dam.subsystem', { compartment: c.i, kind: 'SENSOR', name: sens[0].label, value: +sens[0].health.toFixed(2), health: +sens[0].health.toFixed(2), destroyed: sens[0].destroyed, cause: '命中' });
    }
    const rf = ship.rangefinders[0];
    // 主力舰测距仪装在装甲炮塔/指挥仪上：8 吋难以打坏，大口径才有机会
    const rfMul = (ship.type === 'BB' || ship.type === 'BC') ? clamp(Math.pow(dirCal / 381, 2), 0.06, 1) : 1;
    if (rf) { rf.health = clamp(rf.health - 0.5 * sev * resist * 0.5 * rfMul, 0, 1); if (rf.health <= 0.05) rf.destroyed = true; }
  }
  // 喷淋/注水设备
  const spr = ship.subsystems.find((s) => s.kind === 'MAGAZINE_SPRINKLER');
  if (spr) {
    const mags = magazineCompartments(ship);
    if (mags.some((m) => Math.abs(m.x_frac - x) <= 0.12)) damageSystem(world, ship, hit, spr, 0.5 * sev * resist, '弹药库附近命中');
  }
  // 炮塔：直接命中炮塔（TURRET）才重创；其它部位的穿透弹只在炮座附近造成轻微波及。
  // 旧实现不看命中部位、按 ±0.07（大和 263m → 18m）一刀切，2 发舷侧穿透就能毁一座炮塔，
  // 3 艘围攻下大和的 3 座主炮在 200 秒内全部报废——这就是"大和又脆又不还手"的直接原因。
  const directTurret = hitPartKind === 'TURRET';
  const turretReach = directTurret ? 0.07 : 0.04;
  const mains = (ship.mainBatteries || []).slice().sort((a, b) => Math.abs(a.station_frac - x) - Math.abs(b.station_frac - x));
  if (mains[0] && Math.abs(mains[0].station_frac - x) <= turretReach) {
    const b = mains[0];
    const turretMul = directTurret ? (isTorp ? 0.9 : 0.7) : (isTorp ? 0.25 : 0.15);
    // 主力舰主炮塔正面装甲 300~400mm：8 吋炮弹几乎不可能打坏炮塔，
    // 只有大口径（>=280mm）才按全额伤害。旧模型不区分口径，重巡能靠"擦边命中"磨掉战列舰主炮。
    const turCal = hit.caliberMM || hit.caliber_mm || 203;
    const turCalMul = (ship.type === 'BB' || ship.type === 'BC')
      ? clamp(Math.pow(turCal / 381, 3), 0.01, 1)            // 8 吋 ≈0.15，11 吋 ≈0.24，15 吋 1.0
      : 1;
    b.health = clamp(b.health - turretMul * turCalMul * sev * resist, 0, 1);
    b.crewLoss = clamp((b.crewLoss || 0) + 0.15 * sev, 0, 1);
    if (b.health <= 0.05) b.destroyed = true;
    ev(world, ship, hit, 'dam.subsystem', { compartment: c.i, kind: 'TURRET', name: b.label, value: +b.health.toFixed(2), health: +b.health.toFixed(2), destroyed: b.destroyed, cause: '炮塔中弹' });
    // ── 炮塔内闪爆 → 传火至弹药库 ──────────────────────────────────────────
    // 这是主力舰最致命的机理：日德兰三艘战巡（玛丽女王/无敌/不倦）与胡德都是炮塔中弹后
    // 火焰沿扬弹机窜入弹药库。防闪爆门（flashProtection）完善时几乎不会发生；一旦被破坏
    // 或本身就没有，单发就可能引爆。旧模型完全没有这条链路——所以胡德永远不会殉爆。
    if (directTurret && (hit.penetrates || hit.penetrated)) {
      const mag = magazineForBattery(ship, b);
      if (mag) {
        const protectedFlash = !!b.flashProtection && (mag.flashProtection !== false);
        const risk = (protectedFlash ? 0.02 : 0.10) * clamp(sev, 0.4, 1.4);
        mag.magRisk = clamp((mag.magRisk || 0) + risk, 0, 1.2);
        if (risk > 0.05) ev(world, ship, hit, 'dam.magazine', { compartment: mag.i, x_frac: +mag.x_frac.toFixed(3), result: 'flash', value: +mag.magRisk.toFixed(2), magRisk: +mag.magRisk.toFixed(2), flashProtected: protectedFlash, cause: '炮塔闪爆传火' });
        if (mag.magRisk >= 1) explodeMagazine(world, ship, mag, d);
      }
    }
  }
  // 鱼雷发射管
  for (const m of (ship.torpedoMounts || [])) {
    if (Math.abs(m.station_frac - x) <= 0.06 + span) {
      m.health = clamp(m.health - sev * resist, 0, 1);
      if (m.health <= 0.05) { m.health = 0; m.destroyed = true; m.tubesLoaded = 0; }
      ev(world, ship, hit, 'dam.subsystem', { compartment: c.i, kind: 'TORPEDO_MOUNT', name: m.label, value: +m.health.toFixed(2), health: +m.health.toFixed(2), destroyed: m.destroyed, cause: '发射管被弹' });
      // 鱼雷殉爆（战史中驱逐舰的致命伤之一）
      if (isTorp && m.destroyed && rng.chance(0.15)) igniteFire(world, ship, hit, c, d, 0.5, '鱼雷发射管殉爆');
      break;
    }
  }
}

function damageSystem(world, ship, hit, s, amount, cause) {
  if (!s || s.destroyed) return;
  // 同一发命中的两次结算（命中舱 c + 引信延迟在相邻舱 c2 起爆）不得重复损坏同一设备。
  // 旧实现里同一台锅炉可能被 c 与 c2 各打一遍，放大成"一发毁两台锅炉"。
  if (hit) {
    if (!hit._subsHit) hit._subsHit = new Set();
    if (hit._subsHit.has(s)) return;
    hit._subsHit.add(s);
  }
  const before = s.health;
  s.health = clamp(s.health - amount, 0, 1);
  if (s.health <= 0.05) { s.health = 0; s.destroyed = true; }
  if (before - s.health > 0.02) {
    ev(world, ship, hit, 'dam.subsystem', {
      kind: s.kind, name: s.name || s.id, value: +s.health.toFixed(2),
      health: +s.health.toFixed(2), destroyed: s.destroyed, cause, subsystem: s.kind,
    });
  }
}

// 弹药库直击：防闪爆门与注水决定是否殉爆
function magazineDirectHit(world, ship, hit, c, d, sev, rng) {
  const W = hit.warheadKg || 0;
  const protectedFlash = magFlashProtected(ship, c);
  let risk = 0.25 + clamp(W / 120, 0, 0.5) + rng.range(0, 0.15);
  if (protectedFlash) risk *= 0.5;
  // 单发命中即引爆：防闪爆完善的舰约 8~12%，无防闪爆/老式战巡 25~35%（胡德、玛丽女王）。
  // 旧模型只靠"累积风险到 1"，需要 4~6 发弹药库命中——等于胡德永远不会爆。
  // 单发即引爆的现实量级：二战舰船防闪爆普遍完善，多数弹药库命中只是起火/进水。
  // 战史：日德兰式老式战巡（无防闪爆）约 1/4~1/3，二战新舰即便被打穿弹药库也多为烧毁而非爆。
  const pDet = (protectedFlash ? 0.04 : 0.16) * clamp(sev, 0.4, 1.3);
  if (rng.chance(pDet)) { explodeMagazine(world, ship, c, d); return; }
  c.magRisk = clamp((c.magRisk || 0) + risk * clamp(sev, 0.3, 1.4), 0, 1.2);
  ev(world, ship, hit, 'dam.magazine', {
    compartment: c.i, x_frac: +c.x_frac.toFixed(3), result: 'hit', value: +c.magRisk.toFixed(2),
    magRisk: +c.magRisk.toFixed(2), flashProtected: protectedFlash, warheadKg: W, magazine: true,
  });
  if (c.magRisk >= 1) explodeMagazine(world, ship, c, d);
}

// ---------------------------------------------------------------- 火灾
function igniteFire(world, ship, hit, c, d, intensity, cause) {
  ensureComp(c);
  const before = c.fire;
  c.fire = clamp(Math.max(c.fire, intensity), 0, 1);
  if (c.fire > 0.01 && before <= 0.01) {
    d.fireIgnitions++;
    ship.flags.onFire = 1;
    const ammo = hit ? ammoKindOf(hit) : null;
    ev(world, ship, hit, 'dam.fire', {
      compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: +c.fire.toFixed(2),
      intensity: +c.fire.toFixed(2), cause, ammoKind: ammo, kind: c.kind,
      magazine: !!c.isMagazine,
    });
  } else if (c.fire > before) {
    ev(world, ship, hit, 'dam.fire', { compartment: c.i, value: +c.fire.toFixed(2), intensity: +c.fire.toFixed(2), cause: cause + '(扩大)', magazine: !!c.isMagazine });
  }
}

// ---------------------------------------------------------------- 人员伤亡
export function applyCasualties(world, ship, hit, c, d, frac, cause) {
  if (!(frac > 0)) return 0;
  const here = c.crewHere || 0;
  const n = Math.floor(here * clamp(frac, 0, 0.95));
  if (n <= 0) return 0;
  c.crewHere = Math.max(0, here - n);
  ship.crew = Math.max(0, ship.crew - n);
  d.casualties += n;
  ship.morale = clamp(ship.morale - n / Math.max(1, ship.crew0) * 2.2, 0.15, 1);
  ev(world, ship, hit, 'dam.casualties', {
    compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: n, killed: n,
    crewNow: Math.round(ship.crew), crewPct: +(ship.crew / Math.max(1, ship.crew0)).toFixed(3), cause,
  });
  return n;
}

// ---------------------------------------------------------------- 弹药库殉爆
function explodeMagazine(world, ship, c, d) {
  if (d.detonated) return;
  d.detonated = true; d.catastrophicLoss = true;
  const side = c.sideBias || 1;
  // ── 爆炸当量 ∝ 该弹药库剩余的发射药 + 装药量 ──────────────────────────────
  // 战史差异极大：满库殉爆（胡德/陸奥/大和）舰体瞬间解体、火球数百米；
  // 而战斗尾声弹药已打空时，往往只是大火与进水（并非必然立即沉没）。
  // 旧实现不看弹药量——空库与满库都是"70% 阵亡 + 立即沉没"，既没有梯度，威力也显得偏小。
  const fed = (typeof fedBatteries === 'function') ? fedBatteries(ship, c) : (ship.mainBatteries || []);
  let energyKg = 120;   // 弹库自身 + 起爆管的最低当量
  for (const b of fed) {
    const n = b.ammo ? (b.ammo.AP || 0) + (b.ammo.HE || 0) + 0.5 * (b.ammo.STAR || 0) : 0;
    const mass = (b.data && (b.data.shellMass_kg || b.data.shell_mass_kg)) || 100;
    energyKg += n * (0.28 * mass + 0.03 * mass);   // 发射药≈28%弹重，装药≈3%弹重
  }
  const sevE = clamp(energyKg / 60000, 0.06, 1);     // 6 万 kg ≈ 大型战列舰满库
  const radiusM = 150 + 400 * Math.cbrt(sevE);       // 冲击波/破片杀伤半径（满库约 550m，与胡德→PoW 的 500m 量级相符）
  const nearEmpty = energyKg < 1500;                 // 弹药几乎打空：多为大火+结构崩塌
  const nAdj = nearEmpty ? 1 : 1 + Math.round(3 * sevE);
  for (let k = 1; k <= nAdj; k++) for (const j of [c.i - k, c.i + k]) {
    const cc = ship.compartments[j]; if (!cc) continue;
    ensureComp(cc);
    cc.flood_m3 = cc.volume_m3 * (nearEmpty ? 0.6 : 1);
    cc.breachAreaM2 = Math.max(cc.breachAreaM2, 8 * sevE);
    cc.sideBias = cc.sideBias || side;
    cc.integrity = 0; cc.submerged = true;
  }
  for (const s of ship.subsystems) { s.health = 0; s.destroyed = true; }
  for (const b of ship.batteries) { b.health = 0; b.destroyed = true; b.ammo.AP = 0; b.ammo.HE = 0; }
  for (const dr of ship.directors) { dr.health = 0; dr.destroyed = true; }
  for (const se of ship.sensors) { se.health = 0; se.destroyed = true; }
  for (const m of ship.torpedoMounts) { m.health = 0; m.destroyed = true; m.tubesLoaded = 0; }
  const killed = Math.floor(ship.crew * (nearEmpty ? (0.25 + 0.2 * sevE) : (0.45 + 0.5 * sevE)));
  ship.crew -= killed; d.casualties += killed;
  for (const cc of ship.compartments) cc.crewHere = Math.round((cc.crewHere || 0) * (nearEmpty ? 0.5 : 0.25));
  ship.morale = 0.05;
  ship.speedCapKn = 0; ship.damageSpeedCapKn = 0; ship.speed = 0; ship.commanded.speed = 0;
  ship.sinking = true; ship.catastrophicLoss = true;
  ship._magBlastEnergyKg = Math.round(energyKg);
  // 冲击波/破片波及邻近舰船（冲击波超压 ∝ E^(1/3)，随距离 1.6 次方衰减）
  for (const o of world.ships) {
    if (o === ship || !o.isAfloat) continue;
    const dd = Math.hypot(o.pos.x - ship.pos.x, o.pos.y - ship.pos.y);
    if (dd > radiusM) continue;
    const f = Math.pow(1 - dd / radiusM, 1.6);
    const c0 = o.compartments && o.compartments[0];
    if (c0) { ensureComp(c0); c0.breachAreaM2 += 0.06 * f; c0.breached = true; }
    const lost = Math.floor((o.crew || 0) * 0.05 * f);
    o.crew = Math.max(0, (o.crew || 0) - lost);
    if (f > 0.5 && o.compartments && o.compartments[2]) {
      try { igniteFire(world, o, null, o.compartments[2], {}, 0.45 * f, '邻近舰殉爆冲击'); } catch (e) { /* 保底 */ }
    }
    world.events.emit('dam.blast', { t: world.t, ship: o.id, name: o.name, from: ship.id,
      distM: Math.round(dd), energyKg: Math.round(energyKg), radiusM: Math.round(radiusM), factor: +f.toFixed(2), crewLost: lost });
  }
  ev(world, ship, null, 'dam.magazine', {
    compartment: c.i, x_frac: +c.x_frac.toFixed(3), result: nearEmpty ? 'burn' : 'detonation', value: 1,
    magRisk: 1, killed, cause: nearEmpty ? '弹药库爆燃' : '弹药库殉爆', magazine: true,
    energyKg: Math.round(energyKg), radiusM: Math.round(radiusM), x: Math.round(ship.pos.x), y: Math.round(ship.pos.y),
  });
  // 满库殉爆（result=detonation）：舰体瞬间解体，必须同时 isAfloat=false + sunkAt，
  // 并在此刻 emit ship.sink（world._progressSinking 见到 sunkAt 已置位便不会重复发）。
  // 近空库爆燃（result=burn）：重创但不保证立即沉没——只置 sinking=true，把实际沉没交给
  // world._progressSinking 按 sinkTimer 推进（进水/横倾继续演化）。旧实现在 burn 分支也立刻
  // emit ship.sink，却仍保持 isAfloat=true 且不置 sunkAt，于是 world 之后会二次 emit 同一条沉没事件。
  if (!nearEmpty) {
    world.events.emit('ship.sink', {
      t: world.t, ship: ship.id, name: ship.name, side: ship.side, x: ship.pos.x, y: ship.pos.y,
      list: ship.list, cause: '弹药库殉爆', catastrophic: true,
      energyKg: Math.round(energyKg), radiusM: Math.round(radiusM),
    });
    ship.isAfloat = false; ship.sunkAt = world.t;
  }
  if (typeof world._major === 'function') world._major(ship.name + (nearEmpty ? ' 弹药库爆燃' : ' 弹药库殉爆'));
}

// 舰体折断：累计冲击形变超限
function hullFailure(world, ship, c, d) {
  if (d.hullFailed) return;
  d.hullFailed = true; d.catastrophicLoss = true;
  for (const cc of ship.compartments) {
    ensureComp(cc);
    if (Math.abs(cc.i - c.i) <= 2) { cc.flood_m3 = cc.volume_m3; cc.submerged = true; }
    cc.integrity = clamp(cc.integrity - 0.3, 0, 1);
  }
  for (const s of ship.subsystems) { if (world.rng.chance(0.6)) { s.health = 0; s.destroyed = true; } }
  const killed = Math.floor(ship.crew * 0.4);
  ship.crew -= killed; d.casualties += killed;
  ship.sinking = true; ship.speedCapKn = 0; ship.damageSpeedCapKn = 0; ship.commanded.speed = 0;
  ev(world, ship, null, 'dam.flood', {
    compartment: c.i, result: 'hull_failure', value: +d.structural.toFixed(2), structural: +d.structural.toFixed(2),
    cause: '水下爆炸累计冲击导致舰体折断', killed,
  });
  if (typeof world._major === 'function') world._major(ship.name + ' 舰体折断');
}

// ---------------------------------------------------------------- 主更新
export function updateDamage(ship, world, dt) {
  if (!ship || !ship.isAfloat) return;
  if (!(dt > 0)) return;
  const d = dmgState(ship);
  // 未受损：不做演算、也不产生事件（脚本直接改 compartments 的情况也能被 hasActiveDamage 捕获）
  if (!d.engaged && !hasActiveDamage(ship, d)) return;
  d.engaged = true;
  const step = Math.min(dt, 0.25);
  ensureCompartments(ship);

  const plan = allocateDC(ship, world, d);
  const inflow = updateFlooding(ship, world, d, plan, step);
  updateFires(ship, world, d, plan, step);
  const det = updateMagazines(ship, world, d, plan, step);
  if (det) return;                       // 已殉爆，后续不再演算
  repairMachinery(ship, world, d, plan, step);

  // 稳性：横倾/纵倾/吃水/倾覆由 ship.recomputeStability 统一计算
  const wasCapsized = ship.capsized;
  ship.recomputeStability(world.rng);
  if (ship.capsized && !wasCapsized) {
    world.events.emit('ship.capsize', {
      t: world.t, ship: ship.id, name: ship.name, side: ship.side, victimSide: ship.side,
      list: +ship.list.toFixed(1), floodedM3: Math.round(ship.floodedM3), compartment: null, value: +ship.list.toFixed(1),
    });
    if (typeof world._major === 'function') world._major(ship.name + ' 倾覆');
  }
  d.peakList = Math.max(d.peakList, Math.abs(ship.list));

  const active = hasActiveDamage(ship, d);
  writeBack(ship, world, d, plan, inflow, active);

  // 连续量的 dam.* 汇总事件：最多每 5 s 一次、且必须超过变化阈值；静止时 10 s 一次兜底
  if (active) {
    const since = world.t - d.lastSummaryT;
    if (since >= 5) {
      const changed = Math.abs(ship.floodedM3 - (d.sumFloodM3 || 0)) > 2
        || Math.abs(inflow - (d.sumInflow || 0)) > 0.15
        || Math.abs(ship.list - (d.sumList || 0)) > 0.5
        || Math.abs(ship.trim - (d.sumTrim || 0)) > 0.5
        || d.casualties !== (d.sumCasualties || 0)
        || (plan && plan.parties !== d.sumParties)
        || (plan && (plan.allocation.flood !== d.sumAllocFlood || plan.allocation.fire !== d.sumAllocFire || plan.allocation.magazine !== d.sumAllocMagazine));
      if (changed || since >= 10) {
        d.lastSummaryT = world.t;
        d.sumFloodM3 = ship.floodedM3; d.sumInflow = inflow; d.sumList = ship.list; d.sumTrim = ship.trim;
        d.sumCasualties = d.casualties; d.sumParties = plan ? plan.parties : 0;
        d.sumAllocFlood = plan ? plan.allocation.flood : 0;
        d.sumAllocFire = plan ? plan.allocation.fire : 0;
        d.sumAllocMagazine = plan ? plan.allocation.magazine : 0;
        emitSummary(ship, world, d, plan, inflow);
      }
    }
  }
}

// 连续损伤是否仍在发展（决定是否需要周期汇总事件）
function hasActiveDamage(ship, d) {
  if (ship.floodedM3 > 0.5) return true;               // 仍有实质进水
  if (ship.sinking || ship.capsized || d.detonated || d.hullFailed) return true;
  for (const c of ship.compartments) {
    if ((c.fire || 0) > 0.005 || (c.magRisk || 0) > 0.02) return true;
  }
  return false;                                        // 已封堵/排干：停止周期事件
}

function ensureCompartments(ship) {
  for (const c of ship.compartments) ensureComp(c);
}

// ---------------- 损管队分配 ----------------
function allocateDC(ship, world, d) {
  const dc = dcSubsystem(ship);
  const alive = clamp(ship.crew / Math.max(1, ship.crew0), 0, 1);
  const parties = (dc && !dc.destroyed) ? Math.floor(dc.parties * alive) : 0;
  const dcEff = (dc && !dc.destroyed ? dc.health : 0) * (ship.crewQuality || 0.85) * (0.72 + 0.28 * clamp(ship.morale, 0, 1));
  const priority = ship.dcPriority || 'flooding';
  const W = DC_PRIORITY_WEIGHTS[priority] || DC_PRIORITY_WEIGHTS.flooding;

  const tasks = [];
  for (const c of ship.compartments) {
    ensureComp(c);
    if (c.breachAreaM2 > 0.01) {
      const urgency = clamp(c.floodRateM3s / 4, 0.08, 1.4) + (c.flood_m3 > c.volume_m3 * 0.5 ? 0.3 : 0);
      tasks.push({ kind: 'flood', c, score: W.flood * urgency });
    }
    if (c.fire > 0.003) tasks.push({ kind: 'fire', c, score: W.fire * c.fire });
    if (c.isMagazine && (c.fire > 0.02 || c.magRisk > 0.05)) {
      tasks.push({ kind: 'magazine', c, score: W.magazine * Math.max(c.fire, c.magRisk) * 1.15 });
    }
    if (priority === 'mobility' && c.isMachinery && (c.flood_m3 > 0 || c.fire > 0.02)) {
      tasks.push({ kind: 'mobility', c, score: W.mobility * (0.5 + clamp(c.flood_m3 / Math.max(1, c.volume_m3), 0, 1)) });
    }
  }
  tasks.sort((a, b) => b.score - a.score);
  let left = parties;
  const allocation = { flood: 0, fire: 0, magazine: 0, mobility: 0 };
  const byComp = new Map();
  for (const task of tasks) {
    if (left <= 0) break;
    let demand = 1;
    if (task.kind === 'fire') demand = Math.max(1, Math.ceil(task.c.fire * 3.2));
    else if (task.kind === 'magazine') demand = 2;
    else if (task.kind === 'flood') demand = task.c.breachAreaM2 > 1.2 ? 2 : 1;
    const n = Math.min(left, demand);
    left -= n;
    task.parties = n;
    allocation[task.kind] += n;
    if (!byComp.has(task.c.i)) byComp.set(task.c.i, { flood: 0, fire: 0, magazine: 0, mobility: 0 });
    byComp.get(task.c.i)[task.kind] += n;
  }
  d.plan = { priority, parties, committed: parties - left, spare: left, allocation, byComp, tasks, dcEff, alive };
  return d.plan;
}

// ---------------- 进水 ----------------
function updateFlooding(ship, world, d, plan, dt) {
  const compDepth = Math.max(2, ship.hullDepthM * 0.9);
  const halfBeam = (ship.data.beam_m || 10) * 0.5;
  const settle = Math.max(0, ship.draftM - ship.draftOrigM);
  const heelSin = Math.sin(deg2rad(clamp(ship.list, -70, 70)));

  const pumpTotal = Math.max(0, ship.pumpCapacity / 60 * PUMP_UTIL * ship.electricalFrac); // m³/s
  const pumpParties = plan ? plan.spare : 0;
  const totalFlood = ship.floodedM3;

  let inflowSum = 0;
  const ready = [];
  for (const c of ship.compartments) {
    ensureComp(c);
    const frac = c.volume_m3 > 0 ? c.flood_m3 / c.volume_m3 : 0;
    // ── 堵漏/支撑 ────────────────────────────────────────────────────────────
    // 真实损管的核心动作：用堵漏垫、木楔、支柱、水泥箱逐步封堵破口，进水率随之下降。
    // 破口越大越难完全封堵（maxPatch 随面积下降），且舱内水位越高越难作业。
    if (c.breachAreaM2 > 0.01) {
      const pf = plan && plan.byComp.get(c.i) ? plan.byComp.get(c.i).flood : 0;
      if (pf > 0) {
        const maxPatch = clamp(0.92 - 0.06 * c.breachAreaM2, 0.35, 0.92);
        // 速率按史实标定：2 个损管队封堵 0.3m² 破口约需 3~5 分钟（堵漏垫/木楔/支柱/水泥箱逐步作业），
        // 破口越大越慢；舱内水位越高越难下手。
        const rate = 0.0030 * pf * ((plan && plan.dcEff) || 0.6) * (1 - 0.6 * frac) / (1 + c.breachAreaM2);
        const before = c.patch || 0;
        c.patch = clamp(before + rate * dt, 0, maxPatch);
        for (const th of [0.25, 0.5, 0.75]) {
          if (before < th && c.patch >= th) {
            ev(world, ship, null, 'dam.breach.patched', { compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: +c.patch.toFixed(2), result: '堵漏进度 ' + Math.round(100 * c.patch) + '%', parties: pf });
          }
        }
      }
    }
    let outside = -99, inside = frac * compDepth, net = 0;
    const A = Math.min(c.breachAreaM2 * (1 - (c.patch || 0)), 12);   // 有效破口 = 原始破口 × (1 - 已封堵比例)
    if (A > 0.0005 && c.breachDepthM !== undefined) {
      outside = c.breachDepthM + settle + heelSin * halfBeam * (c.sideBias || 0);
      const vent = c.openVent === false ? VENT_CLOSED : VENT_OPEN;
      const dh = outside - inside;
      // 水下破口只进不出：静水压始终由舷外指向舱内，被动倒流不成立。
      // 旧实现在 inside > outside 时让水从破口流回海里，等于给所有破舱自动排水。
      if (dh > 0.02) net = CD_ORIFICE * SQRT_2G * A * Math.sqrt(dh) * vent;
    }
    c.floodRateM3s = net;
    if (net > 0.002) inflowSum += net;
    ready.push({ c, net, frac });
  }

  // ── 反注水扶正 ────────────────────────────────────────────────────────────
  // 横倾过大时向高舷舱室注水以减小横倾（真实损管手段）。代价是吃水增加、储备浮力下降，
  // 所以只在进水未失控时使用——这正是"损管是一门取舍"的体现。
  if (Math.abs(ship.list) > 12 && plan && plan.spare > 0 && !ship._counterfloodDone) {
    const highSide = ship.list > 0 ? -1 : 1;
    const reserve = ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3);
    if (reserve < 0.55) {
      const cand = ship.compartments.find((c) => (c.sideBias || 0) * highSide > 0.15 && !c.magFlooded && c.flood_m3 < c.volume_m3 * 0.75);
      if (cand) {
        const rate = 0.28 * plan.spare * ((plan && plan.dcEff) || 0.6);
        const add = Math.min(rate * dt, cand.volume_m3 - cand.flood_m3);
        if (add > 0) {
          cand.flood_m3 += add;
          cand.counterflooded = true;
          if (!ship._cfReported || world.t - ship._cfReported > 30) {
            ship._cfReported = world.t;
            ev(world, ship, null, 'dam.counterflood', { compartment: cand.i, x_frac: +cand.x_frac.toFixed(3), value: +add.toFixed(2), listDeg: +ship.list.toFixed(1), result: '反注水扶正' });
          }
        }
      }
    }
  }

  // 泵排水：按进水量比例分配；注水的弹药库保持灌满不再泵出
  if (pumpTotal > 0 && totalFlood > 0.01) {
    const boost = 1 + 0.05 * Math.min(3, pumpParties);   // 损管队协助接管/清滤网（最多 +15%）
    const removable = Math.min(totalFlood, pumpTotal * boost * dt);
    let weightSum = 0;
    for (const r of ready) if (!r.c.magFlooded && r.c.flood_m3 > 0.001) weightSum += r.c.flood_m3;
    if (weightSum > 0) {
      for (const r of ready) {
        if (r.c.magFlooded || r.c.flood_m3 <= 0.001) continue;
        const share = r.c.flood_m3 / weightSum;
        const suction = Math.min(1, r.c.flood_m3 / 0.5);   // 舱底接近抽干时吸口失真空，效率骤降
        r.c.flood_m3 = Math.max(0, r.c.flood_m3 - removable * share * suction);
      }
    }
  }

  // 进水累积
  for (const r of ready) {
    const c = r.c;
    const before = c.flood_m3;
    c.flood_m3 = clamp(c.flood_m3 + r.net * dt, 0, c.volume_m3);
    if (c.breached && !c._floodSignaled && r.net > 0.005 && c.flood_m3 > 0.05) {
      c._floodSignaled = true;      // 每个新破口只即时播报一次，持续进水交给周期汇总
      ev(world, ship, null, 'dam.flood', {
        compartment: c.i, x_frac: +c.x_frac.toFixed(3), result: 'breach',
        value: +r.net.toFixed(3), rateM3s: +r.net.toFixed(3), areaM2: +c.breachAreaM2.toFixed(3),
        depthM: +(c.breachDepthM || 0).toFixed(2), floodedM3: Math.round(ship.floodedM3),
        sideBias: c.sideBias || 0, kind: c.kind,
      });
    }
    if (c.flood_m3 > c.volume_m3 * 0.98) c.submerged = true;
  }

  plugBreaches(ship, world, d, plan, dt);
  progressiveFlooding(ship, world, d, dt, compDepth);
  downFlooding(ship, world, d, dt);
  counterFlooding(ship, world, d, plan, dt);

  return inflowSum;
}

// 堵漏/加固：把破口面积压下来（大破口只能部分封堵）
function plugBreaches(ship, world, d, plan, dt) {
  if (!plan || plan.committed <= 0) return;
  for (const [ci, a] of plan.byComp) {
    const n = (a.flood || 0);
    if (n <= 0) continue;
    const c = ship.compartments[ci];
    if (!c || c.breachAreaM2 <= 0.02) continue;
    // 堵漏只能在尚未完全淹没的舱室进行（人员需能接近破口）；大破口只能局部封堵
    if (c.flood_m3 / Math.max(1, c.volume_m3) > 0.6) continue;
    // 堵漏速率：460mm 破口需数小时才能基本封堵（史实上靠堵漏垫/木楔/水泥箱）
    const eff = plan.dcEff * n / (1 + 0.6 * c.breachAreaM2);
    c.breachAreaM2 = Math.max(0.02, c.breachAreaM2 - 0.00012 * eff * dt);   // m²/s
    if (!c._plugReported && c.breachAreaM2 <= 0.35) {
      c._plugReported = true;
      ev(world, ship, null, 'dam.flood.control', {
        compartment: c.i, action: 'plug', result: 'breach_plugged',
        value: +c.breachAreaM2.toFixed(3), areaM2: +c.breachAreaM2.toFixed(3), parties: n,
      });
    }
  }
}

// 渐进进水：舱内水压超过舱壁承载后向相邻舱室渗漏（水密门未关/舱壁变形）
function progressiveFlooding(ship, world, d, dt, compDepth) {
  for (const c of ship.compartments) {
    if (!c.breached) continue;                 // 只有与海/破口连通的舱室才能向外传水
    const frac = c.volume_m3 > 0 ? c.flood_m3 / c.volume_m3 : 0;
    if (frac < BULKHEAD_LOAD_FRAC) continue;
    const overload = (frac - BULKHEAD_LOAD_FRAC) / (1 - BULKHEAD_LOAD_FRAC);
    const srcDepth = frac * compDepth;
    for (const j of [c.i - 1, c.i + 1]) {
      const nb = ship.compartments[j]; if (!nb) continue;
      ensureComp(nb);
      const nbFrac = nb.flood_m3 / Math.max(1, nb.volume_m3);
      if (nbFrac > 0.99) continue;
      // 按水头驱动渗漏（而不是凭经验慢慢涨破口面积）：完整舱壁只有小渗漏，
      // 受冲击变形/水密门未关的舱壁成倍放大——这才是"渐进进水"的真实机理。
      const nbDepth = nbFrac * compDepth;
      const dh = srcDepth - nbDepth;
      if (dh <= 0.05) continue;
      const leakArea = (0.015 + 0.16 * (1 - clamp(nb.integrity, 0, 1))) * (0.4 + 0.6 * overload);
      const flow = CD_ORIFICE * SQRT_2G * leakArea * Math.sqrt(dh);
      nb.flood_m3 = clamp(nb.flood_m3 + flow * dt, 0, nb.volume_m3);
      nb.breachAreaM2 = Math.max(nb.breachAreaM2, leakArea);
      if (nb.sideBias === 0) nb.sideBias = c.sideBias || 0;
      if (nb.breachDepthM === undefined) nb.breachDepthM = Math.max(0.5, compDepth * 0.45);
      nb.breached = true;
      if (!nb._progReported) {
        nb._progReported = true;
        nb._floodSignaled = false;
        ev(world, ship, null, 'dam.flood.control', {
          compartment: nb.i, action: 'progressive', result: 'bulkhead_leak',
          value: +nb.breachAreaM2.toFixed(4), from: c.i, integrity: +nb.integrity.toFixed(2),
        });
      }
    }
  }
}

// 低舷甲板边缘浸没后的 down-flooding：露天开口/通风筒/破舱口灌水 → 快速倾覆
function downFlooding(ship, world, d, dt) {
  const list = Math.abs(ship.list);
  if (list < 9 || ship.capsized) return;
  const sgn = ship.list > 0 ? 1 : -1;
  const beam = ship.data.beam_m || 10;
  const immersion = Math.sin(deg2rad(list)) * beam * 0.5 - ship.freeboardM;
  if (immersion <= 0) return;
  for (const c of ship.compartments) {
    ensureComp(c);
    if (c.sideBias !== sgn) continue;
    if (c.flood_m3 / Math.max(1, c.volume_m3) > 0.95) continue;
    // 只有与已进水区相邻的舱室会通过开口串水
    let near = false;
    for (const j of [c.i - 1, c.i + 1]) {
      const nb = ship.compartments[j];
      if (nb && nb.flood_m3 > nb.volume_m3 * 0.25) { near = true; break; }
    }
    if (!near) continue;
    if (c.breachDepthM === undefined) c.breachDepthM = Math.max(0.4, ship.draftM * 0.4);
    c.breachAreaM2 = Math.min(2.6, c.breachAreaM2 + 0.02 * immersion * dt);
    c.breached = true;
    if (!c._downReported) {
      c._downReported = true;
      c._floodSignaled = false;
      ev(world, ship, null, 'dam.flood.control', {
        compartment: c.i, action: 'down_flood', result: 'deck_edge_immersion',
        value: +immersion.toFixed(2), list: +ship.list.toFixed(1), sideBias: sgn,
      });
    }
  }
}

// 反击水：向高舷注水对抗横倾（牺牲储备浮力，需人手开阀）
function counterFlooding(ship, world, d, plan, dt) {
  if (ship.capsized) return;
  const list = ship.list;
  if (Math.abs(list) < 7) { d.counterFlooding = 0; return; }
  const priority = plan ? plan.priority : 'flooding';
  if (priority !== 'flooding' && priority !== 'magazine') return;
  if (!plan || plan.spare < 1) return;                       // 人手不足时优先堵漏
  if (ship.floodedM3 > ship.reserveBuoyancyM3 * 0.5) return; // 储备浮力不足，禁止反击水
  const low = list > 0 ? 1 : -1;
  const high = -low;
  let used = 0;
  const order = ship.compartments
    .filter((c) => !c.isMagazine && c.sideBias !== low && c.flood_m3 < c.volume_m3 * 0.35 && c.integrity > 0.5)
    .sort((a, b) => Math.abs(a.x_frac - 0.5) - Math.abs(b.x_frac - 0.5));
  for (const c of order) {
    if (used >= 2) break;
    ensureComp(c);
    c.sideBias = high;
    c.breachAreaM2 = Math.max(c.breachAreaM2, 0.05);
    if (c.breachDepthM === undefined) c.breachDepthM = Math.max(0.5, ship.draftM * 0.5);
    c.breached = true;
    const rate = 0.45;                    // 反击水阀全开 ≈ 0.45 m³/s
    c.flood_m3 = Math.min(c.volume_m3, c.flood_m3 + rate * dt);
    if (c._counterFloodOn !== true) { c._counterFloodOn = true; c._floodSignaled = false; }
    used++;
  }
  if (used > 0) {
    d.counterFlooding = used;
    if (world.t - d.counterFloodT > 10) {
      d.counterFloodT = world.t;
      ev(world, ship, null, 'dam.flood.control', {
        compartment: null, action: 'counter_flood', result: 'list_correction',
        value: +ship.list.toFixed(1), list: +ship.list.toFixed(1), compartments: used,
      });
    }
  } else d.counterFlooding = 0;
}

// ---------------- 火灾 ----------------
function updateFires(ship, world, d, plan, dt) {
  const rng = world.rng;
  const sprinkler = sprinklerHealth(ship);
  let fireLoad = 0;
  for (const c of ship.compartments) {
    ensureComp(c);
    if (c.fire <= 0.001) {
      if (c.fire > 0) {
        c.fire = 0; d.firesOut++;
        ev(world, ship, null, 'dam.fire.out', {
          compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: 0, result: 'extinguished', by: 'DC',
        });
      }
      continue;
    }
    fireLoad += c.fire;
    const p = (plan && plan.byComp.get(c.i)) || null;
    const fireParties = p ? p.fire : 0;
    const magParties = p ? p.magazine : 0;
    const frac = c.flood_m3 / Math.max(1, c.volume_m3);
    let suppress = 0;
    if (fireParties > 0 && plan) suppress += FIRE_SUPPRESS_PARTY * fireParties * plan.dcEff;
    if (magParties > 0 && plan) suppress += FIRE_SUPPRESS_PARTY * 0.5 * magParties * plan.dcEff;
    if (c.isMagazine && sprinkler > 0) suppress += FIRE_SUPPRESS_SPRINKLER * sprinkler;
    if (frac > 0.35 || c.magFlooded) suppress += FIRE_SUPPRESS_WATER;
    const growth = FIRE_GROWTH * fuelFactor(ship, c) * (1 - c.fire) * (c.fireFuel > 0 ? 1 : 0);
    c.fireFuel = Math.max(0, c.fireFuel - FIRE_FUEL_BURN * c.fire * dt);
    const before = c.fire;
    c.fire = clamp(c.fire + (growth - suppress) * dt, 0, 1);
    c.integrity = clamp(c.integrity - 0.0015 * c.fire * dt, 0.05, 1);
    d.floatCasualties += (c.crewHere || 0) * CASUALTY_FIRE_RATE * c.fire * dt;
    if (d.floatCasualties >= 1) {
      const n = Math.floor(d.floatCasualties);
      d.floatCasualties -= n;
      const killed = Math.min(n, c.crewHere || 0);
      c.crewHere = Math.max(0, (c.crewHere || 0) - killed);
      ship.crew = Math.max(0, ship.crew - n);
      d.casualties += n;
      ship.morale = clamp(ship.morale - n / Math.max(1, ship.crew0) * 2, 0.15, 1);
      ev(world, ship, null, 'dam.casualties', {
        compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: n, killed: n,
        crewNow: Math.round(ship.crew), cause: '火灾伤亡',
      });
    }
    // 火灾蔓延到相邻舱室（闪燃/串火）
    if (c.fire > 0.45 && rng.next() < 0.0012 * c.fire * fuelFactor(ship, c) * dt * 60) {
      const j = rng.chance(0.5) ? c.i - 1 : c.i + 1;
      const nb = ship.compartments[j];
      if (nb && nb.fire < 0.05 && nb.integrity < 0.95) igniteFire(world, ship, null, nb, d, 0.15, '火灾蔓延');
    }
    // 火灾烧毁机舱设备
    if (c.fire > 0.6 && c.isMachinery && rng.next() < 0.0006 * c.fire * dt * 60) {
      const sys = ship.subsystems.filter((s) => (s.kind === 'BOILER' || s.kind === 'SHAFT') && !s.destroyed && Math.abs(s.station_frac - c.x_frac) < 0.09);
      if (sys.length) damageSystem(world, ship, null, sys[rng.int(0, sys.length - 1)], 0.4, '机舱火灾');
    }
    // 熄灭判定
    if (c.fire <= 0.001 || c.fireFuel <= 0) {
      c.fire = 0;
      let reason = 'dc';
      if (c.magFlooded || frac > 0.35) reason = 'flood';
      else if (c.isMagazine && sprinkler > 0) reason = 'sprinkler';
      else if (c.fireFuel <= 0) reason = 'fuel_exhausted';
      d.firesOut++;
      ev(world, ship, null, 'dam.fire.out', {
        compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: 0, result: reason,
        by: fireParties > 0 ? 'DC' : reason, parties: fireParties,
      });
    } else if (before < 0.5 && c.fire >= 0.5) {
      ev(world, ship, null, 'dam.fire', {
        compartment: c.i, x_frac: +c.x_frac.toFixed(3), value: 0.5, intensity: +c.fire.toFixed(2),
        cause: '火灾扩大', magazine: !!c.isMagazine,
      });
    }
  }
  ship.flags.onFire = fireLoad > 0.01 ? 1 : 0;
}

// ---------------- 弹药库 ----------------
function updateMagazines(ship, world, d, plan, dt) {
  const sprinkler = sprinklerHealth(ship);
  let detonated = false;
  for (const c of magazineCompartments(ship)) {
    ensureComp(c);
    const flash = magFlashProtected(ship, c);
    const p = (plan && plan.byComp.get(c.i)) || null;
    const magParties = p ? p.magazine : 0;
    // 注水：风险高时的最后手段（损失弹药，保住军舰）
    if (!c.magFlooded && (c.fire > 0.4 || c.magRisk > 0.45) && magParties > 0) {
      c.magFlooded = true;
      c.openVent = false;
      c.breachAreaM2 = Math.max(c.breachAreaM2, 0.4);
      if (c.breachDepthM === undefined) c.breachDepthM = Math.max(0.5, ship.draftM * 0.5);
      c.breached = true;
      for (const b of fedBatteries(ship, c)) { b.magazineFlooded = true; b.ammo.AP = 0; b.ammo.HE = 0; }
      ev(world, ship, null, 'dam.magazine', {
        compartment: c.i, x_frac: +c.x_frac.toFixed(3), result: 'flooded',
        value: +c.magRisk.toFixed(2), magRisk: +c.magRisk.toFixed(2), parties: magParties,
        note: '弹药库注水，弹药报废但避免殉爆',
      });
    }
    // 相邻火灾对弹舱的烘烤
    let heat = c.fire;
    for (const j of [c.i - 1, c.i + 1]) {
      const nb = ship.compartments[j];
      if (nb && nb.fire > 0) heat += 0.4 * nb.fire;
    }
    if (c.magFlooded) {
      c.magRisk = Math.max(0, c.magRisk - MAG_FLOOD_DECAY * dt);
    } else if (heat > 0.05) {
      const factor = (flash ? 0.8 : 1.1) * (sprinkler > 0 ? 0.85 : 1.15);
      c.magRisk = clamp(c.magRisk + MAG_RISK_RATE * heat * factor * dt, 0, 1.2);
    } else {
      c.magRisk = Math.max(0, c.magRisk - MAG_RISK_DECAY * dt);
    }
    if (!c._warned30 && c.magRisk >= 0.3) {
      c._warned30 = true;
      ev(world, ship, null, 'dam.magazine', {
        compartment: c.i, x_frac: +c.x_frac.toFixed(3), result: 'fire_threat',
        value: +c.magRisk.toFixed(2), magRisk: +c.magRisk.toFixed(2), fire: +c.fire.toFixed(2), magazine: true,
      });
    }
    if (c.magRisk >= 1) { explodeMagazine(world, ship, c, d); detonated = true; break; }
  }
  return detonated;
}

// ---------------- 机动优先时的应急抢修 ----------------
function repairMachinery(ship, world, d, plan, dt) {
  if (!plan || plan.allocation.mobility <= 0) return;
  const eff = plan.dcEff * plan.allocation.mobility;
  for (const s of ship.subsystems) {
    if (s.kind !== 'BOILER' && s.kind !== 'SHAFT') continue;
    if (s.health >= 0.7) continue;
    if (s.destroyed && s.health <= 0.05) continue;   // 已彻底损毁者不可修复
    s.health = clamp(s.health + 0.004 * eff * dt, 0, 0.7);
  }
}

// ---------------- 写回派生状态 ----------------
function writeBack(ship, world, d, plan, inflow, active) {
  const damaged = active || ship.subsystems.some((s) => s.destroyed);
  if (damaged) {
    const cap = computeSpeedCap(ship, d);
    // T1 dynamics 每步重算 ship.speedCapKn，并优先遵守 ship.damageSpeedCapKn（min 合成）
    ship.damageSpeedCapKn = cap;
    d.damageCapSet = true;
    if (ship.maxSpeedKn === undefined) ship.speedCapKn = cap;   // 无 dynamics 时（单测/无头）自行写回
  } else if (d.damageCapSet) {
    delete ship.damageSpeedCapKn;
    d.damageCapSet = false;
    if (ship.maxSpeedKn === undefined) ship.speedCapKn = ship.data.speedMax_kn || ship.speedCapKn;
  }

  const fireLoad = ship.compartments.reduce((a, c) => a + (c.fire || 0), 0);
  ship.damageSmoke = clamp(fireLoad * 0.3 + (d.detonated || d.hullFailed ? 0.5 : 0), 0, 1);

  const maxMagRisk = magazineCompartments(ship).reduce((a, c) => Math.max(a, c.magRisk || 0), 0);
  const ls = Math.abs(ship.list);
  const pumpTotal = ship.pumpCapacity / 60 * PUMP_UTIL * ship.electricalFrac;
  ship.dcStatus = {
    priority: plan ? plan.priority : (ship.dcPriority || 'flooding'),
    parties: plan ? plan.parties : 0,
    committed: plan ? plan.committed : 0,
    spare: plan ? plan.spare : 0,
    allocation: plan ? Object.assign({}, plan.allocation) : { flood: 0, fire: 0, magazine: 0, mobility: 0 },
    efficiency: plan ? +plan.dcEff.toFixed(2) : 0,
    crewsAlivePct: +(ship.crew / Math.max(1, ship.crew0)).toFixed(3),
    casualties: d.casualties,
    pumpRateM3s: +pumpTotal.toFixed(3),
    inflowM3s: +inflow.toFixed(3),
    netM3s: +(inflow - pumpTotal).toFixed(3),
    counterFlooding: d.counterFlooding,
    magazineFlooded: magazineCompartments(ship).some((c) => c.magFlooded),
    maxMagazineRisk: +maxMagRisk.toFixed(2),
    capsizeRisk: +clamp(ls / 62 + ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3) * 0.35, 0, 1).toFixed(2),
    structural: +d.structural.toFixed(2),
    floodedPct: +(100 * ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3)).toFixed(1),
  };
}

// 航速上限：P ∝ V³ → V/V0 = (P/P0)^(1/3)，再叠加进水增重/横倾/纵倾/干舷/火灾折扣
function computeSpeedCap(ship, d) {
  const maxKn = ship.data.speedMax_kn || 20;
  const boilers = ship.subsystems.filter((s) => s.kind === 'BOILER');
  const shafts = ship.subsystems.filter((s) => s.kind === 'SHAFT');
  const boilerFrac = boilers.length ? boilers.reduce((a, s) => a + (s.destroyed ? 0 : clamp(s.health, 0, 1)), 0) / boilers.length : 1;
  const shaftFrac = shafts.length ? shafts.reduce((a, s) => a + (s.destroyed ? 0 : clamp(s.health, 0, 1)), 0) / shafts.length : 1;
  const propulsion = Math.min(1, shaftFrac * 1.15) * boilerFrac;
  let cap = maxKn * Math.pow(Math.max(0.01, propulsion), 1 / 3);

  // 进水增重：同功率下 V ∝ Δ^(-2/9)
  const deltaRatio = 1 + ship.floodedM3 * RHO_SEA_T / Math.max(1, ship.displacement_t);
  cap *= Math.pow(1 / deltaRatio, 2 / 9);

  // 横倾：螺旋桨/舵露出水面，推进与操纵效率骤降
  const list = Math.abs(ship.list);
  cap *= 1 - Math.min(0.5, Math.pow(list / 60, 1.6) * 0.6);
  // 纵倾（按 ship.js 约定 trim<0 为艏倾，艏倾阻力更大）
  const bowDown = Math.max(0, -ship.trim), sternDown = Math.max(0, ship.trim);
  cap *= 1 - Math.min(0.25, bowDown * 0.012) - Math.min(0.12, sternDown * 0.006);
  // 干舷损失 → 上浪
  cap *= 1 - clamp(ship.freeboardLoss * 0.5, 0, 0.35);
  // 灭火/堵漏占用人手对机舱的影响
  const fireLoad = ship.compartments.reduce((a, c) => a + (c.fire || 0), 0);
  cap *= 1 - Math.min(0.2, fireLoad * 0.05);
  if (!ship.steeringOK) cap *= 0.9;
  if (d.detonated || d.hullFailed) cap = 0;
  return clamp(cap, 0, maxKn);
}

function emitSummary(ship, world, d, plan, inflow) {
  const fires = ship.compartments.filter((c) => c.fire > 0.05);
  const breaches = ship.compartments.filter((c) => c.breachAreaM2 > 0.01);
  const submerged = ship.compartments.filter((c) => c.submerged).length;
  const pumpTotal = ship.pumpCapacity / 60 * PUMP_UTIL * ship.electricalFrac;
  ev(world, ship, null, 'dam.flood', {
    compartment: breaches.length === 1 ? breaches[0].i : null, aggregate: true,
    value: Math.round(ship.floodedM3), floodedM3: Math.round(ship.floodedM3),
    floodedPct: +(100 * ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3)).toFixed(1),
    rateM3s: +inflow.toFixed(2), pumpM3s: +pumpTotal.toFixed(2),
    breaches: breaches.length, submerged,
    freeboard: +ship.freeboardM.toFixed(2), draft: +ship.draftM.toFixed(2),
    compartments: breaches.slice(0, 8).map((c) => ({ i: c.i, x_frac: +c.x_frac.toFixed(3), m3: Math.round(c.flood_m3), areaM2: +c.breachAreaM2.toFixed(3), side: c.sideBias })),
  });
  ev(world, ship, null, 'dam.list', {
    compartment: null, value: +ship.list.toFixed(1), list: +ship.list.toFixed(1), trim: +ship.trim.toFixed(1),
    draft: +ship.draftM.toFixed(2), gm: +(ship.effectiveGMm || 0).toFixed(2),
    capsizeRisk: ship.dcStatus ? ship.dcStatus.capsizeRisk : 0, peakList: +d.peakList.toFixed(1),
  });
  ev(world, ship, null, 'dam.dc', {
    compartment: null, value: plan ? plan.parties : 0,
    priority: plan ? plan.priority : 'flooding', parties: plan ? plan.parties : 0,
    committed: plan ? plan.committed : 0, spare: plan ? plan.spare : 0,
    allocation: plan ? plan.allocation : null, efficiency: plan ? +plan.dcEff.toFixed(2) : 0,
    inflowM3s: +inflow.toFixed(2), pumpM3s: +pumpTotal.toFixed(2),
    counterFlooding: d.counterFlooding, casualties: d.casualties,
    crewPct: +(ship.crew / Math.max(1, ship.crew0)).toFixed(3),
    speedCapKn: +ship.speedCapKn.toFixed(1), fires: fires.length,
  });
}

// ---------------------------------------------------------------- 对外报告
export function floodingReport(ship) {
  if (!ship) return null;
  const d = ship.dmg || { casualties: 0, structural: 0 };
  const breaches = ship.compartments
    .filter((c) => (c.breachAreaM2 || 0) > 0.01)
    .map((c) => ({
      i: c.i, x_frac: +c.x_frac.toFixed(2), kind: c.kind, floodedM3: Math.round(c.flood_m3),
      volumeM3: Math.round(c.volume_m3), areaM2: +(c.breachAreaM2 || 0).toFixed(3),
      rateM3s: +(c.floodRateM3s || 0).toFixed(3), side: c.sideBias || 0, fire: +(c.fire || 0).toFixed(2),
      submerged: !!c.submerged,
    }));
  return {
    floodedM3: Math.round(ship.floodedM3),
    freeboard: +ship.freeboardM.toFixed(2),
    list: +ship.list.toFixed(1),
    trim: +ship.trim.toFixed(1),
    draft: +ship.draftM.toFixed(2),
    reserveM3: Math.round(ship.reserveBuoyancyM3),
    floodedPct: +(100 * ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3)).toFixed(1),
    inflowM3s: +breaches.reduce((a, b) => a + Math.max(0, b.rateM3s), 0).toFixed(2),
    pumpM3s: +(ship.pumpCapacity / 60 * PUMP_UTIL * ship.electricalFrac).toFixed(2),
    breaches, capsizeRisk: ship.dcStatus ? ship.dcStatus.capsizeRisk : 0,
    casualties: d.casualties, structural: +((d.structural) || 0).toFixed(2), sinking: !!ship.sinking,
  };
}

// ---------------------------------------------------------------- 损管指令桥接
// DAMAGE_CONTROL / DC_PRIORITY：ship.applyOrder 未实现 DAMAGE_CONTROL 分支；
// Lead 可让 world._applyOne 在 return false 前调用本函数（导出签名不影响契约）。
export function applyDamageControl(ship, cmd) {
  if (!ship || !cmd) return false;
  const p = cmd.params || {};
  const action = String(p.action || p.mode || cmd.kind || '').toUpperCase();
  const d = dmgState(ship);
  if (action === 'DC_PRIORITY' || action === 'PRIORITY' || cmd.kind === 'DC_PRIORITY') {
    const mode = p.mode || p.priority;
    if (DC_PRIORITY_WEIGHTS[mode]) { ship.dcPriority = mode; return true; }
  }
  const ci = p.compartment !== undefined ? p.compartment : p.compartmentIndex;
  const c = (ci !== undefined && ship.compartments[ci]) ? ship.compartments[ci] : null;
  if (action === 'FLOOD' || action === 'FLOOD_MAGAZINE' || action === 'MAGAZINE_FLOOD') {
    if (!c || !c.isMagazine) return false;
    c.magFlooded = true; c.breached = true;
    c.breachAreaM2 = Math.max(c.breachAreaM2, 0.4);
    if (c.breachDepthM === undefined) c.breachDepthM = Math.max(0.5, ship.draftM * 0.5);
    for (const b of fedBatteries(ship, c)) { b.magazineFlooded = true; b.ammo.AP = 0; b.ammo.HE = 0; }
    return true;
  }
  if (action === 'COUNTERFLOOD') { ship.dcPriority = ship.dcPriority || 'flooding'; d.counterFloodT = -1e9; return true; }
  if (action === 'PLUG' || action === 'PUMP' || action === 'SHORE') return !!c;
  if (action === 'ABANDON') { if (c) c.openVent = true; return !!c; }
  return false;
}
