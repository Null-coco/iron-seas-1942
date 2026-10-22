// 【T6 所有者】鱼雷武器系统：射击诸元、双档航速/射程、扇面齐射、定深、引信可靠性、
// 航迹可见性（压缩空气 vs 氧气）、命中判定与命中部位（舷侧 vs 艏艉）。
//
// ── 物理与战史依据 ───────────────────────────────────────────────────────────
// 1) 拦截三角 / 提前角（与美军 TDC、日军九七式射撃盤 同源）：
//    鱼雷是定速直航武器，必须解相对运动三角形求提前角 λ：
//        sin(λ) = (V_t / V_T) · sin(β)
//    β = 目标航向与「目标→发射舰」连线的夹角（目标航迹角）；命中点由 TOF 不动点迭代收敛：
//        τ ← |S − (T + V_t·τ)| / V_T
//    这里用 7 次迭代（初值 τ0 = 距离/V_T），与机械解算盘的收敛精度相当。
// 2) 陀螺角：ω = 鱼雷航向 − 发射管指向。机械陀螺受限于 |ω| ≤ 90°(Mk15)~110°(九三式)；
//    超出即无法射击（须先转向占位）。发射管可旋回时按「陀螺角最小」原则调舷。
// 3) 双档航速/射程：鱼雷定速航行，档位发射前设定。九三式改1：48kn/20000m、36kn/40000m；
//    Mk15：45kn/5500m、27kn/13000m。同一能量储备下航速越高耗量越大，射程近似 ∝ V^-3，
//    故两档不可兼得（史实九三式靠纯氧+酒精获得远超同代的 40km/36kn 组合）。
// 4) 航迹可见性：压缩空气（湿式加热器/蒸汽）鱼雷排出大量不凝气体，白昼良好能见度下
//    瞭望可在 2~4 km 发现白色航迹；氧气鱼雷（九三式）排气几乎全部溶于水，航迹极淡，
//    目视发现距离通常仅数百米。这是「被规避概率」差异的物理来源（comb the wakes）。
// 5) 可靠性（types.js reliabilityFor + 数据里的 dudRate）：哑弹（引信不动作）、深走
//    （航深偏大从船底通过）、提前爆炸（磁引信/定深器缺陷）。1942 年美制鱼雷 US_EARLY =
//    dud .45 / deepRun .30 / prem .20 —— 1942 年美军潜艇与驱逐舰鱼雷几乎不响，即此三项。
// 6) 命中几何：舰体视为 L×B 矩形，鱼雷航迹到舰体中线的最近距离 < B/2 即命中。
//    由此自然得到命中投影宽度 W = L·|sinγ| + B·|cosγ|（γ = 鱼雷航向与目标航向夹角）：
//    舷角 90°（broadside）投影全长、命中概率最高；艏艉方向只剩舰宽投影，概率最低，
//    且命中点集中在艏/艉（易撕掉艏部、打坏舵机/推进轴，后果交给 damage.applyHit 判定）。
// 7) 航行深度：定深按目标吃水设定（战列舰 5~6.5m，驱逐舰 2~3m）。实际航深 = 定深 +
//    国别系统偏差 + 随机误差 + 深走故障。实际航深 > 命中处吃水时从船底穿过 → 记 miss。
//    命中处吃水按平均吃水叠加纵倾修正。
//
// 命中对象形状遵守 ARCHITECTURE §3.1（applyHit 冻结契约）：
//   {t,targetShip,x_frac,compartmentIndex,sideBias,penetrates,armorMM,obliquityDeg,
//    shellMassKg,caliberMM,velocityMps,energyMJ,warheadKg,isTorpedo,isNearMiss,
//    fuzeDelayS,ammoKind,killerShipId,killerSide,killerName,...}
//   鱼雷：isTorpedo=true、必须带 sideBias（-1 左舷 / +1 右舷）、warheadKg 取 TNT 当量。
// 所有随机数走 world.rng；所有状态变化 emit 事件（torp.launch / torp.wake / torp.hit /
// torp.miss / torp.dud）。命令路径（world._applyOne → launchTorpedo({source:'CMD'})）由
// world.js 负责 emit torp.launch（含 accepted），本模块在 source==='CMD' 时不再重复 emit。

import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, kn2mps, deg2rad } from '../core/util.js';
import { reliabilityFor } from './types.js';
import { applyHit } from './damage.js';

let TORP_SEQ = 0;

// 航迹强度：1.0 = 白昼良好条件下 3km 量级可被发现；氧气/电动 ≈ 0.05~0.10（几乎无迹）
export const WAKE_STRENGTH = Object.freeze({
  OXYGEN: 0.10, ELECTRIC: 0.05, PEROXIDE: 0.30, HYDROGEN_PEROXIDE: 0.30,
  AIR: 1.0, COMPRESSED_AIR: 1.0, STEAM: 1.25,
});

// 史实鱼雷型号数据（口径/战雷头/两档航速射程/航迹/陀螺极限/深走偏差）
// depthBiasM/depthSigmaM 取 1942 各国定型产品的工程统计量级：
//   美制 Mk14/15 实测航深比设定深 3~4m（1942），日制九三式在 ±0.3m 内。
export const TORPEDO_TYPES = Object.freeze({
  '93': { nameZh: '九三式酸素魚雷(長矛)', nation: 'JP', diameter_mm: 610, warheadKg: 490, tntKg: 620, massKg: 2700,
    speedsKn: [48, 36], rangesM: [20000, 40000], wake: 'OXYGEN', gyroMaxDeg: 110,
    depthBiasM: 0.15, depthSigmaM: 0.25, gyroSigmaDeg: 0.30, dudRate: 0.06 },
  '95': { nameZh: '九五式(潜射)', nation: 'JP', diameter_mm: 533, warheadKg: 405, tntKg: 510, massKg: 1700,
    speedsKn: [45, 35], rangesM: [9000, 12000], wake: 'OXYGEN', gyroMaxDeg: 90,
    depthBiasM: 0.2, depthSigmaM: 0.3, gyroSigmaDeg: 0.35, dudRate: 0.06 },
  'mk15': { nameZh: 'Mk 15 (驱逐舰)', nation: 'US', diameter_mm: 533, warheadKg: 224, tntKg: 290, massKg: 1700,
    speedsKn: [45, 27], rangesM: [5500, 13000], wake: 'AIR', gyroMaxDeg: 90,
    depthBiasM: 1.2, depthSigmaM: 0.6, gyroSigmaDeg: 0.5, dudRate: 0.25 },
  'mk9': { nameZh: 'Mark IX (英)', nation: 'UK', diameter_mm: 533, warheadKg: 340, tntKg: 400, massKg: 1700,
    speedsKn: [41, 35], rangesM: [9144, 13716], wake: 'AIR', gyroMaxDeg: 90,
    depthBiasM: 0.6, depthSigmaM: 0.4, gyroSigmaDeg: 0.45, dudRate: 0.12 },
  'g7a': { nameZh: 'G7a (德)', nation: 'DE', diameter_mm: 533, warheadKg: 280, tntKg: 320, massKg: 1530,
    speedsKn: [44, 40, 30], rangesM: [5000, 7500, 14000], wake: 'STEAM', gyroMaxDeg: 90,
    depthBiasM: 0.5, depthSigmaM: 0.4, gyroSigmaDeg: 0.4, dudRate: 0.15 },
  'si270': { nameZh: 'Si 270 (意)', nation: 'IT', diameter_mm: 533, warheadKg: 270, tntKg: 300, massKg: 1700,
    speedsKn: [44, 36, 30], rangesM: [4000, 8000, 12000], wake: 'AIR', gyroMaxDeg: 90,
    depthBiasM: 0.5, depthSigmaM: 0.4, gyroSigmaDeg: 0.5, dudRate: 0.18 },
});

export function defaultTorpedoType(nation) {
  if (nation === 'JP') return '93';
  if (nation === 'UK') return 'mk9';
  if (nation === 'DE') return 'g7a';
  if (nation === 'IT') return 'si270';
  return 'mk15'; // US 及其他
}

function normWake(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? 'AIR' : 'OXYGEN';   // 数据字段 wakeVisible
  const s = String(v).toUpperCase();
  if (s.indexOf('氧') >= 0 || s.indexOf('OXY') >= 0) return 'OXYGEN';
  if (s.indexOf('电') >= 0 || s.indexOf('ELECTRIC') >= 0) return 'ELECTRIC';
  if (s.indexOf('过氧化') >= 0 || s.indexOf('PEROX') >= 0) return 'PEROXIDE';
  if (s.indexOf('蒸汽') >= 0 || s.indexOf('STEAM') >= 0) return 'STEAM';
  if (s.indexOf('AIR') >= 0 || s.indexOf('空气') >= 0) return 'AIR';
  return null;
}
function toArr(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) { const a = v.map(Number).filter((x) => isFinite(x) && x > 0); return a.length ? a : null; }
  const n = Number(v); return isFinite(n) && n > 0 ? [n] : null;
}
function pickNum(o, keys) {
  for (const k of keys) { if (o[k] !== undefined && o[k] !== null && isFinite(Number(o[k]))) return Number(o[k]); }
  return null;
}
function typeKeyFromName(name) {
  const s = String(name || '');
  if (s.indexOf('九三') >= 0 || /(^|[^0-9])93([^0-9]|$)/.test(s)) return '93';
  if (s.indexOf('九五') >= 0) return '95';
  if (/mk\s*15/i.test(s)) return 'mk15';
  if (/mk\s*ix|mark\s*ix/i.test(s)) return 'mk9';
  if (/g7a/i.test(s)) return 'g7a';
  if (/si\s*270/i.test(s)) return 'si270';
  return null;
}

// 由舰船数据解析鱼雷档案（data/ships_*.json：mountLabel/tubes/caliber_mm/warhead_kg/
// speed_kn[两档]/range_m[两档]/wakeVisible/gyro/reloads/dudRate/depthSetting_m）
export function torpedoSpecFor(ship, mount) {
  const t = (mount && mount.data) || {};
  const nation = ship.nation || (ship.side === 'AXIS' ? 'JP' : 'US');
  const year = ship.year || 1942;
  let key = String(t.type || t.id || t.model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key || !TORPEDO_TYPES[key]) key = typeKeyFromName(t.name || t.nameZh || t.mountLabel) || defaultTorpedoType(nation);
  const base = TORPEDO_TYPES[key] || TORPEDO_TYPES.mk15;

  let speedsKn = toArr(t.speedsKn || t.speeds_kn || t.speedKn || t.speed_kn);
  let rangesM = toArr(t.rangesM || t.ranges_m || t.rangeM || t.range_m);
  const table = t.speedRange || t.speed_range;
  if (Array.isArray(table) && table.length) {
    speedsKn = table.map((p) => Number(p.speedKn !== undefined ? p.speedKn : p.kn)).filter((x) => isFinite(x) && x > 0);
    rangesM = table.map((p) => Number(p.rangeM !== undefined ? p.rangeM : (p.range_m !== undefined ? p.range_m : p.range))).filter((x) => isFinite(x) && x > 0);
  }
  if (!speedsKn || !speedsKn.length) speedsKn = base.speedsKn.slice();
  if (!rangesM || !rangesM.length) rangesM = base.rangesM.slice();
  // 长度对齐（只给一档时按能量关系外推另一档）
  const n = Math.max(speedsKn.length, rangesM.length);
  while (speedsKn.length < n) speedsKn.push(speedsKn[speedsKn.length - 1] * 0.8);
  while (rangesM.length < n) rangesM.push(rangesM[rangesM.length - 1] * 1.9);
  // 统一按航速降序排列（index 0 = 最快档；同一档的射程随航速下降而增大）
  const pairs = speedsKn.map((kn, i) => ({ kn, rangeM: rangesM[i] })).sort((a, b) => b.kn - a.kn);
  speedsKn = pairs.map((p) => p.kn); rangesM = pairs.map((p) => p.rangeM);

  // 航迹：数据里 wakeVisible:false（日制纯氧）= 几乎无迹；true = 压缩空气/蒸汽白航迹
  let wakeType = normWake(t.wake !== undefined ? t.wake : (t.wakeType !== undefined ? t.wakeType : t.wakeVisible));
  if (!wakeType) wakeType = base.wake;

  let minDepthM = 1.0, maxDepthM = 8.0;
  const dsr = toArr(t.depthSetting_m || t.depthSettingM || t.depthSettings_m);
  if (dsr && dsr.length) { minDepthM = Math.min.apply(null, dsr); maxDepthM = Math.max.apply(null, dsr); }
  else {
    const mn = pickNum(t, ['minDepth_m', 'minDepthM']); const mx = pickNum(t, ['maxDepth_m', 'maxDepthM']);
    if (mn !== null) minDepthM = mn; if (mx !== null) maxDepthM = mx;
  }
  // 哑弹率来源：舰船数据显式给出（DATA）> 型号表（TYPE）；两者都没有时由 types.js 年代表
  // reliabilityFor(nation, year) 提供（1942 US_EARLY 0.45 → 1944 US_LATE 0.08）
  const dudFromData = pickNum(t, ['dudRate', 'dud_rate']);

  return {
    key, nameZh: t.name || t.nameZh || base.nameZh,
    nation, year, wakeType,
    wakeStrength: WAKE_STRENGTH[wakeType] !== undefined ? WAKE_STRENGTH[wakeType] : 1.0,
    speedsKn, rangesM,
    settings: speedsKn.map((kn, i) => ({ speedKn: kn, rangeM: rangesM[i] })).sort((a, b) => b.speedKn - a.speedKn),
    diameterMm: pickNum(t, ['caliber_mm', 'diameter_mm', 'diameterMm']) || base.diameter_mm,
    warheadKg: pickNum(t, ['warhead_kg', 'warheadKg', 'charge_kg']) || base.warheadKg,
    tntKg: pickNum(t, ['tnt_kg', 'tntKg']) || base.tntKg,
    massKg: pickNum(t, ['mass_kg', 'massKg']) || base.massKg,
    gyroMaxDeg: pickNum(t, ['gyroMax_deg', 'gyroMaxDeg']) || base.gyroMaxDeg,
    hasGyro: t.gyro === undefined ? true : !!t.gyro,
    dudRate: dudFromData !== null ? dudFromData : base.dudRate,
    dudRateSource: dudFromData !== null ? 'DATA' : 'TYPE',
    depthBiasM: pickNum(t, ['depthBias_m', 'depthBiasM']) !== null ? pickNum(t, ['depthBias_m', 'depthBiasM']) : base.depthBiasM,
    depthSigmaM: pickNum(t, ['depthSigma_m', 'depthSigmaM']) || base.depthSigmaM,
    gyroSigmaDeg: pickNum(t, ['gyroSigma_deg', 'gyroSigmaDeg']) || base.gyroSigmaDeg,
    minDepthM, maxDepthM,
  };
}

// ── 火控解算：TOF 不动点迭代 + 提前角 ────────────────────────────────────────
// 返回 {intercept,tofS,runM,trackCourseDeg,losDeg,leadDeg}
export function solveIntercept(sx, sy, tx, ty, targetCourseDeg, targetSpeedMps, torpSpeedMps) {
  const Cd = deg2rad(targetCourseDeg);
  const vx = Math.sin(Cd) * targetSpeedMps, vy = Math.cos(Cd) * targetSpeedMps;
  let tof = dist2d({ x: sx, y: sy }, { x: tx, y: ty }) / Math.max(1e-3, torpSpeedMps);
  let px = tx, py = ty, runM = 0;
  for (let i = 0; i < 7; i++) {
    px = tx + vx * tof; py = ty + vy * tof;
    runM = Math.hypot(px - sx, py - sy);
    tof = runM / Math.max(1e-3, torpSpeedMps);
  }
  const trackCourseDeg = normDeg(bearing2d({ x: sx, y: sy }, { x: px, y: py }));
  const losDeg = bearing2d({ x: sx, y: sy }, { x: tx, y: ty });
  return { intercept: { x: px, y: py }, tofS: tof, runM, trackCourseDeg, losDeg, leadDeg: normDeg180(trackCourseDeg - losDeg) };
}

// ── 命中几何：舰体水线面（艏↔艉长 L，舯部半宽 B/2，艏艉收窄） ────────────────
// 水线面不是矩形：舯部最宽，艏柱/艉端收窄到约 0.28×半宽。这样命中投影宽度自然趋于
// 经典式 W = L·|sinγ| + B·|cosγ|（γ = 鱼雷航向与目标航向夹角），而不是矩形/圆头近似的过估。
export function hullHitTest(ship, p, tolM = 1.0) {
  const L = ship.data.loa_m || 100, B = ship.data.beam_m || 10;
  const hd = deg2rad(ship.heading);
  const hx = Math.sin(hd), hy = Math.cos(hd);
  const dx = p.x - ship.pos.x, dy = p.y - ship.pos.y;
  const along = dx * hx + dy * hy;                       // + 指向艏
  const across = dx * Math.cos(hd) - dy * Math.sin(hd);  // + 右舷
  const halfL = L / 2;
  const u = clamp((along + halfL) / L, 0, 1);
  const halfW = (B / 2) * clamp(0.28 + 0.72 * Math.pow(Math.sin(Math.PI * u), 0.55), 0.22, 1);
  const dAlong = Math.abs(along) > halfL ? Math.abs(along) - halfL : 0;
  const dist = Math.hypot(dAlong, across);
  const hit = dist <= halfW + tolM;
  // 命中处吃水：平均吃水 + 纵倾对端部的修正
  const trimRad = deg2rad(ship.trim || 0);
  const draftLocal = Math.max(0.5, ship.draftM + (along / Math.max(1, halfL)) * Math.tan(trimRad) * halfL * 0.5);
  return {
    // x_frac 约定 0=舰艏、1=舰艉；along 以舰艏为正，故需反号
    hit, dist, along, across, halfWidthM: halfW, x_frac: clamp((halfL - along) / L, 0, 1),
    distFromBowM: clamp(halfL - along, 0, L),
    side: across >= 0 ? 'STBD' : 'PORT', sideBias: across >= 0 ? 1 : -1,
    draftLocalM: draftLocal,
  };
}

// ── 航迹可见性 ──────────────────────────────────────────────────────────────
// 基准：白昼、能见度 12nmi、海况≤3、普通瞭望素质下，压缩空气鱼雷航迹约 3.4km 可被发现。
export const WAKE_BASE_DETECT_M = 3400;

export function wakeDetectRangeM(world, viewer, tp) {
  const env = world.env;
  if (!env) return 0;
  const base = WAKE_BASE_DETECT_M * (tp.wakeStrength !== undefined ? tp.wakeStrength : 1.0);
  const light = clamp(env.lightLevel !== undefined ? env.lightLevel : 1, 0, 1);
  const lightFactor = 0.10 + 0.90 * Math.pow(light, 0.7);   // 夜间瞭望效率骤降
  let visNm = env.visibilityNm !== undefined ? env.visibilityNm : 12;
  if (env.horizontalVisibilityNm) { try { visNm = env.horizontalVisibilityNm(viewer); } catch (e) { /* 用默认 */ } }
  const visFactor = clamp((visNm || 12) / 12, 0.15, 1.3);
  const sea = env.seaState !== undefined ? env.seaState : 2;
  const seaFactor = clamp(1 - 0.055 * sea, 0.35, 1);        // 白浪/碎浪淹没航迹
  const lookout = clamp((viewer.crewQuality || 0.85) / 0.85, 0.6, 1.3);
  let smoke = 0;
  if (env.smokeDensityAt) { try { smoke = clamp(env.smokeDensityAt(viewer.pos.x, viewer.pos.y), 0, 1); } catch (e) { smoke = 0; } }
  return base * lightFactor * visFactor * seaFactor * lookout * (1 - 0.9 * smoke);
}

// 本舰当前面临的鱼雷威胁（含是否已被目视发现）——供 AI 避雷机动与测试复用
export function torpedoesThreatening(world, ship, opts = {}) {
  const maxRangeM = opts.maxRangeM || 10000;
  const maxCpaM = opts.maxCpaM || 800;
  const maxTimeS = opts.maxTimeS || 300;
  const out = [];
  const hv = deg2rad(ship.heading);
  const hx = Math.sin(hv) * kn2mps(ship.speed), hy = Math.cos(hv) * kn2mps(ship.speed);
  for (const tp of world.torpedoes || []) {
    if (!tp.alive || !tp.inWater || tp.shooterId === ship.id) continue;
    const dx = tp.pos.x - ship.pos.x, dy = tp.pos.y - ship.pos.y;
    const rangeM = Math.hypot(dx, dy);
    if (rangeM > maxRangeM) continue;
    const tv = deg2rad(tp.courseDeg);
    const rvx = Math.sin(tv) * tp.speedMps - hx, rvy = Math.cos(tv) * tp.speedMps - hy;
    const vv = rvx * rvx + rvy * rvy;
    const tcpa = vv > 1e-6 ? -(dx * rvx + dy * rvy) / vv : 0;
    if (tcpa < 0 || tcpa > maxTimeS) continue;
    const cpaM = Math.hypot(dx + rvx * tcpa, dy + rvy * tcpa);
    if (cpaM > maxCpaM) continue;
    out.push({ torp: tp, rangeM, cpaM, timeToCpaS: tcpa, detected: tp.detectedBy && tp.detectedBy[ship.id] === true, wakeType: tp.wakeType });
  }
  out.sort((a, b) => a.timeToCpaS - b.timeToCpaS);
  return out;
}

// ── 发射 ────────────────────────────────────────────────────────────────────
// sol: {bearingDeg, rangeM, spreadDeg, tubes, speedIdx, depthM, targetTrackId,
//       targetCourseDeg, targetSpeedKn, targetPos, reliabilityOverride, tubeTrainDeg}
// opts: {targetTrack, targetShip, trueTarget, source:'CMD'|'AI'|'TEST', emitLaunchEvent}
export function launchTorpedo(world, ship, mount, sol = {}, opts = {}) {
  if (!ship || !ship.isAfloat || !mount || mount.destroyed || mount.health <= 0.05) return null;
  if ((mount.tubesLoaded || 0) <= 0) return null;

  const spec = torpedoSpecFor(ship, mount);
  const targetTrack = opts.targetTrack || (sol.targetTrackId && world.tracks ? world.tracks.byId(sol.targetTrackId) : null);
  const trueTarget = opts.trueTarget || opts.targetShip || null;
  const rng = world.rng;

  // 目标位置与运动要素：解算用「相信值」（来自航迹/sol），可与真值有偏差——这是脱靶主因
  let tgt = sol.targetPos || (targetTrack ? targetTrack.pos : (trueTarget ? trueTarget.pos : null));
  if (!tgt) {
    if (sol.bearingDeg === undefined || sol.rangeM === undefined) {
      world.events.emit('order.reject', { t: world.t, ship: ship.id, side: ship.side, kind: 'LAUNCH_TORPEDO', reason: '无目标方位与距离，无法解算' });
      return null;
    }
    tgt = destPoint(ship.pos, sol.rangeM, sol.bearingDeg);
  }
  const rangeToTargetM = sol.rangeM !== undefined ? sol.rangeM : dist2d(ship.pos, tgt);
  const believedCourseDeg = sol.targetCourseDeg !== undefined ? sol.targetCourseDeg
    : (targetTrack && targetTrack.courseDeg !== undefined ? targetTrack.courseDeg : (trueTarget ? trueTarget.heading : 0));
  const believedSpeedKn = sol.targetSpeedKn !== undefined ? sol.targetSpeedKn
    : (targetTrack && targetTrack.speedKn !== undefined ? targetTrack.speedKn : (trueTarget ? trueTarget.speed : 0));

  // ── 1. 选档：必须覆盖「实际拦截点航程」而非直线距离。
  //    目标背向逃逸时拦截点远于直线距离，故逐档解拦截三角，取能到达的最快档
  //    （无档位可及时取最大射程档，随后仍可能被拒绝）。
  const speedsKn = spec.speedsKn, rangesM = spec.rangesM;
  let idx = sol.speedIdx;
  let solv = null;
  if (idx === undefined || idx === null) {
    idx = speedsKn.length - 1;
    for (let i = 0; i < speedsKn.length; i++) {
      const s = solveIntercept(ship.pos.x, ship.pos.y, tgt.x, tgt.y, believedCourseDeg, kn2mps(believedSpeedKn), kn2mps(speedsKn[i]));
      if (s.runM <= rangesM[i] * 1.02) { idx = i; solv = s; break; }
    }
  }
  idx = clamp(Math.round(idx), 0, speedsKn.length - 1);
  const speedKn = speedsKn[idx], maxRangeM = rangesM[idx], torpSpeedMps = kn2mps(speedKn);

  // ── 2. 拦截解算
  if (!solv) solv = solveIntercept(ship.pos.x, ship.pos.y, tgt.x, tgt.y, believedCourseDeg, kn2mps(believedSpeedKn), torpSpeedMps);
  if (solv.runM > maxRangeM * 1.02) {
    world.events.emit('order.reject', { t: world.t, ship: ship.id, side: ship.side, kind: 'LAUNCH_TORPEDO',
      reason: '超出选定档射程', rangeM: Math.round(solv.runM), maxRangeM, speedKn });
    return null;
  }

  // ── 3. 发射管指向与陀螺角（可旋回则调舷到最小陀螺角）
  const td = mount.data || {};
  const arcs = td.trainArcs || td.trainArcsDeg || null;
  const fixedOffset = pickNum(td, ['trainOffset_deg', 'trainOffsetDeg', 'fixedOffsetDeg']);
  let tubeTrainDeg;
  if (spec.hasGyro === false || fixedOffset !== null) {
    tubeTrainDeg = normDeg(ship.heading + (fixedOffset !== null ? fixedOffset : 90));
  } else if (Array.isArray(arcs) && arcs.length) {
    let best = null, bd = 1e9;
    for (const a of arcs) {
      const c = normDeg(ship.heading + (a.centerDeg !== undefined ? a.centerDeg : a[0]));
      const hw = a.halfWidthDeg !== undefined ? a.halfWidthDeg : (a[1] !== undefined ? a[1] : 90);
      const cand = normDeg(c + clamp(normDeg180(solv.trackCourseDeg - c), -hw, hw));
      const d = Math.abs(normDeg180(solv.trackCourseDeg - cand));
      if (d < bd) { bd = d; best = cand; }
    }
    tubeTrainDeg = best !== null ? best : solv.trackCourseDeg;
  } else {
    tubeTrainDeg = solv.trackCourseDeg;
  }
  if (sol.tubeTrainDeg !== undefined) tubeTrainDeg = normDeg(sol.tubeTrainDeg);

  const tubes = clamp(sol.tubes !== undefined ? Math.round(sol.tubes) : Math.min(mount.tubesLoaded, 4), 1, mount.tubesLoaded || 1);

  // ── 4. 定深：按目标吃水（未给则按舰种估计）
  let setDepthM = sol.depthM;
  if (setDepthM === undefined || setDepthM === null) {
    const draft = (trueTarget && trueTarget.draftM) || (targetTrack && targetTrack.draftM) || estimateTargetDraft(targetTrack, trueTarget);
    setDepthM = clamp(draft * 0.62, spec.minDepthM, Math.min(spec.maxDepthM, draft * 1.1));
  }
  setDepthM = clamp(setDepthM, spec.minDepthM, spec.maxDepthM);

  // ── 5. 引信可靠性：深走/提前爆炸取 types.js 年代表；哑弹率优先用舰船数据显式值，
  //    否则一律用 reliabilityFor(nation, year)（1942 美制 0.45 / 日制 0.06）
  const rel = reliabilityFor(ship.nation || spec.nation, ship.year || spec.year);
  const relEff = sol.reliabilityOverride || {
    dud: spec.dudRateSource === 'DATA' ? spec.dudRate : rel.dud,
    deepRun: rel.deepRun, prem: rel.prem,
  };

  // ── 6. 扇面：spreadDeg 均分给各管（覆盖目标位置/航向不确定性），逐管 2.5s 间歇发射
  const spread = sol.spreadDeg || 0;
  const interval = sol.tubeIntervalS !== undefined ? sol.tubeIntervalS : 2.5;
  const made = [];
  for (let k = 0; k < tubes; k++) {
    const fan = tubes === 1 ? 0 : (-spread / 2 + spread * k / (tubes - 1));
    const dud = rng.chance(relEff.dud || 0);
    const deep = rng.chance(relEff.deepRun || 0);
    const prem = rng.chance(relEff.prem || 0);
    const depthActualM = Math.max(0.5, setDepthM + rng.normal(spec.depthBiasM, spec.depthSigmaM) + (deep ? rng.range(2.5, 5.0) : 0));
    const courseDeg = normDeg(solv.trackCourseDeg + fan + rng.normal(0, spec.gyroSigmaDeg));
    const gyroAngleDeg = normDeg180(courseDeg - tubeTrainDeg);
    if (Math.abs(gyroAngleDeg) > spec.gyroMaxDeg + 1e-6) {
      world.events.emit('order.reject', { t: world.t, ship: ship.id, side: ship.side, kind: 'LAUNCH_TORPEDO',
        reason: '陀螺角超出机械极限', gyroAngleDeg: +gyroAngleDeg.toFixed(1), gyroMaxDeg: spec.gyroMaxDeg });
      continue;
    }
    const tp = {
      id: 'TP' + (++TORP_SEQ), kind: 'TORPEDO',
      side: ship.side, nation: ship.nation || spec.nation, year: ship.year || spec.year,
      shooterId: ship.id, shooterName: ship.name, mountId: mount.id,
      weapon: spec.nameZh,
      pos: { x: ship.pos.x, y: ship.pos.y },
      spawnAt: world.t + k * interval, launchedAt: null,
      inWater: false, alive: true, done: false,
      courseDeg, speedKn, speedMps: torpSpeedMps * rng.range(0.995, 1.005),
      maxRangeM, runM: 0,
      setDepthM, depthActualM,
      wakeType: spec.wakeType, wakeStrength: spec.wakeStrength,
      warheadKg: spec.warheadKg, tntKg: spec.tntKg, massKg: spec.massKg, diameterMm: spec.diameterMm,
      gyroAngleDeg, tubeTrainDeg, spreadOffDeg: fan,
      targetTrackId: sol.targetTrackId || (targetTrack ? targetTrack.id : null),
      targetShipId: (opts.targetShip && opts.targetShip.id) || sol.targetShipId || null,
      dud, deepRun: deep, premature: prem,
      premAtM: prem ? Math.max(300, solv.runM * rng.range(0.55, 0.95)) : null,
      solutionRunM: solv.runM, solutionTofS: solv.tofS,
      detectedBy: {}, track: [], missReported: false, minDistToTarget: 1e9,
    };
    tp.track.push({ x: tp.pos.x, y: tp.pos.y });
    world.torpedoes.push(tp);
    made.push(tp);
  }
  if (!made.length) return null;

  mount.tubesLoaded = Math.max(0, (mount.tubesLoaded || 0) - made.length);
  mount.launched = (mount.launched || 0) + made.length;
  mount.reloadTimer = mount.reloadTimeS || 60;
  ship.stats.torpedoesFired = (ship.stats.torpedoesFired || 0) + made.length;

  // 命令路径由 world 统一 emit（含 accepted），避免重复事件；直呼路径由本模块 emit
  if (opts.emitLaunchEvent !== false && opts.source !== 'CMD') {
    world.events.emit('torp.launch', {
      t: world.t, ship: ship.id, name: ship.name, side: ship.side, mount: mount.id,
      tubes: made.length, speedKn, maxRangeM, spreadDeg: spread,
      gyroAngleDeg: +made[0].gyroAngleDeg.toFixed(1), setDepthM: +setDepthM.toFixed(2),
      wake: spec.wakeType, wakeStrength: spec.wakeStrength, warheadKg: spec.warheadKg, tntKg: spec.tntKg,
      runM: Math.round(solv.runM), tofS: Math.round(solv.tofS), leadDeg: +solv.leadDeg.toFixed(1),
      target: made[0].targetShipId || null, speedIdx: idx,
    });
  }
  return made;
}

function estimateTargetDraft(track, ship) {
  if (ship && ship.draftM) return ship.draftM;
  const cls = (track && track.classifiedAs) || 'DD';
  return ({ CV: 9, BB: 9.5, BC: 8.5, CA: 6.5, CL: 5.5, DD: 3.4, UNKNOWN: 5 }[cls]) || 5;
}

// ── 每步推进 ────────────────────────────────────────────────────────────────
export function updateTorpedoes(world, dt) {
  const list = world.torpedoes;
  if (!list || !list.length) return;
  for (const tp of list) {
    if (!tp.alive) continue;
    if (world.t < tp.spawnAt) continue;
    if (!tp.inWater) { tp.inWater = true; tp.launchedAt = world.t; }

    const stepLen = tp.speedMps * dt;
    // 提前爆炸（磁引信/定深器缺陷）
    if (tp.premAtM !== null && tp.runM + stepLen >= tp.premAtM) {
      tp.pos = destPoint(tp.pos, Math.max(0, tp.premAtM - tp.runM), tp.courseDeg);
      world.events.emit('torp.miss', { t: world.t, ship: tp.shooterId, side: tp.side, torp: tp.id, target: tp.targetShipId,
        reason: 'PREMATURE', x: Math.round(tp.pos.x), y: Math.round(tp.pos.y), runM: Math.round(tp.runM) });
      tp.alive = false; tp.done = true;
      continue;
    }

    // 分小步推进（每步 ≤2m，防止高速穿过舰体/艏艉薄段）
    const sub = Math.max(1, Math.ceil(stepLen / 2));
    const subLen = stepLen / sub;
    for (let s = 0; s < sub && tp.alive; s++) {
      tp.pos = destPoint(tp.pos, subLen, tp.courseDeg);
      tp.runM += subLen;
      if (s % 10 === 0) { tp.track.push({ x: tp.pos.x, y: tp.pos.y }); if (tp.track.length > 40) tp.track.shift(); }

      // 浅水触底：定深超过当地水深 → 撞海床（二战鱼雷在浅水区很常见，苏里高/爪哇海尤其）
      if (world.depth && !world.depth.empty) {
        const dHere = world.depth.depthAt(tp.pos.x, tp.pos.y);
        if (dHere < tp.depthActualM + 1.0) {
          world.events.emit('torp.bottom', { t: world.t, ship: tp.shooterId, side: tp.side, torp: tp.id, target: tp.targetShipId,
            depthM: +dHere.toFixed(1), setDepthM: +tp.depthActualM.toFixed(1), x: Math.round(tp.pos.x), y: Math.round(tp.pos.y), runM: Math.round(tp.runM) });
          tp.alive = false; tp.done = true; tp.bottomed = true;
          break;
        }
      }

      for (const ship of world.ships) {           // 鱼雷不分敌我：混战中同样会打到自己人
        if (!ship.isAfloat || ship.id === tp.shooterId) continue;
        const g = hullHitTest(ship, tp.pos, 1.0);
        if (ship.id === tp.targetShipId) tp.minDistToTarget = Math.min(tp.minDistToTarget, g.dist);
        if (!g.hit) continue;
        if (tp.depthActualM > g.draftLocalM + 0.4) {   // 从船底通过（深走/定深过大）
          if (!tp.missReported) {
            tp.missReported = true;
            world.events.emit('torp.miss', { t: world.t, ship: tp.shooterId, side: tp.side, torp: tp.id, target: ship.id,
              reason: 'UNDER_RUN', depthM: +tp.depthActualM.toFixed(2), targetDraftM: +g.draftLocalM.toFixed(2) });
          }
          continue;
        }
        resolveHit(world, tp, ship, g);
        break;
      }
      if (tp.runM >= tp.maxRangeM) {
        world.events.emit('torp.miss', { t: world.t, ship: tp.shooterId, side: tp.side, torp: tp.id, target: tp.targetShipId,
          reason: 'RANGE_EXHAUSTED', runM: Math.round(tp.runM) });
        tp.alive = false; tp.done = true; break;
      }
    }
    if (!tp.alive) continue;

    // 航迹目视发现：首次发现 emit torp.wake（供 AI 避雷与 AAR）
    for (const ship of world.ships) {
      if (!ship.isAfloat || ship.id === tp.shooterId || tp.detectedBy[ship.id]) continue;
      const r = wakeDetectRangeM(world, ship, tp);
      const d = dist2d(ship.pos, tp.pos);
      if (d <= r) {
        tp.detectedBy[ship.id] = true;
        world.events.emit('torp.wake', { t: world.t, ship: ship.id, name: ship.name, side: ship.side, torp: tp.id,
          shooter: tp.shooterId, wakeType: tp.wakeType, wakeStrength: tp.wakeStrength,
          rangeM: Math.round(d), detectRangeM: Math.round(r),
          bearingDeg: Math.round(normDeg(bearing2d(ship.pos, tp.pos))) });
      }
    }

    // 已越过预定命中点仍未命中 → 记一次 miss（继续航行，可能打到后续舰）
    if (!tp.missReported && tp.targetShipId && tp.runM > tp.solutionRunM + 600) {
      tp.missReported = true;
      world.events.emit('torp.miss', { t: world.t, ship: tp.shooterId, side: tp.side, torp: tp.id, target: tp.targetShipId,
        reason: 'MISSED', cpaM: Math.round(tp.minDistToTarget), runM: Math.round(tp.runM) });
    }
  }
  world.torpedoes = list.filter((t) => t.alive);
}

// 命中结算：按 ARCHITECTURE §3.1 组装 Hit，交给 damage.applyHit
function resolveHit(world, tp, ship, g) {
  tp.alive = false; tp.done = true;
  const friendly = ship.side === tp.side;
  const shooter = world.ship ? world.ship(tp.shooterId) : null;
  const comp = ship.compartmentAt ? ship.compartmentAt(g.x_frac) : null;
  const hit = {
    t: world.t, targetShip: ship, x_frac: +g.x_frac.toFixed(3),
    compartmentIndex: comp ? comp.i : undefined,
    sideBias: g.sideBias,
    penetrates: true,                              // 鱼雷战斗部直接撕开舷侧/水下船壳
    armorMM: comp && comp.belt_mm !== undefined ? comp.belt_mm : (ship.data.armor && ship.data.armor.belt_mm) || 0,
    obliquityDeg: 0,                               // 水下命中近似垂直入射
    shellMassKg: tp.massKg, caliberMM: tp.diameterMm,
    velocityMps: +tp.speedMps.toFixed(2),
    energyMJ: +(0.5 * tp.massKg * tp.speedMps * tp.speedMps / 1e6).toFixed(2),
    warheadKg: tp.tntKg,                           // 按 TNT 当量计（原始装药见 chargeKg）
    tntKg: tp.tntKg, chargeKg: tp.warheadKg,
    isTorpedo: true, isNearMiss: false, fuzeDelayS: 0, ammoKind: 'TORPEDO',
    killerShipId: tp.shooterId, killerSide: tp.side, killerName: tp.shooterName,
    friendlyHit: friendly, torp: tp.id, side: g.side, depthM: +tp.depthActualM.toFixed(2),
    distanceFromBowM: Math.round(g.distFromBowM), wake: tp.wakeType,
  };
  // 被命中数不在本模块计数：命中对象统一交给 damage.applyHit，由它做唯一的 hitsTaken 计数
  // （旧实现在这里 +1、applyHit 里再 +1，鱼雷命中在 AAR 里同样翻倍）。本模块只记攻击方鱼雷命中数。
  if (shooter) shooter.stats.torpHits = (shooter.stats.torpHits || 0) + 1;

  if (tp.dud) {
    world.events.emit('torp.dud', { t: world.t, ship: ship.id, name: ship.name, side: ship.side, torp: tp.id,
      shooter: tp.shooterId, x_frac: hit.x_frac, side: g.side, depthM: hit.depthM, reason: 'DUD' });
    return;
  }
  world.events.emit('torp.hit', { t: world.t, ship: ship.id, name: ship.name, side: ship.side, shooter: tp.shooterId,
    shooterSide: tp.side, torp: tp.id, x_frac: hit.x_frac, side: g.side, depthM: hit.depthM,
    compartment: hit.compartmentIndex, warheadKg: tp.warheadKg, tntKg: tp.tntKg, friendly,
    distanceFromBowM: hit.distanceFromBowM });
  try {
    applyHit(world, hit);
  } catch (e) {
    // 不让 T3 的异常炸掉整个仿真；事件保留线索便于联调
    world.events.emit('ai.error', { t: world.t, ship: tp.shooterId, where: 'torpedo.applyHit', error: String(e && e.message ? e.message : e) });
  }
}
