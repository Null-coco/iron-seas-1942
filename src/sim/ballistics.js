// ============================================================================
// src/sim/ballistics.js  —— T4 弹道与穿深
//
// 物理模型与依据（参数标定见各常量注释）：
//  1. 3D 质点弹道 RK4 积分。运动方程：
//       m dv/dt = -0.5 * rho(h) * Cd(M) * A * |v_rel| * v_rel - m g k
//     其中 v_rel = v - wind(h)。外弹道标准质点模型（McCoy, Modern Exterior
//     Ballistics, 1999, ch.4）。忽略科氏力（<0.05% 射程）与弹体进动。
//  2. 大气：ISA 指数近似 rho = 1.225 * exp(-h/8500)，0~11km 内误差 <3%；
//     声速 a = sqrt(gamma R T)，对流层递减、平流层 216.65K。
//  3. 阻力系数随马赫数：亚音速 ~1.0 倍基准，跨音速(0.95~1.3Ma)约 2.3 倍
//     阻力峰（弹底激波/分离），超音速缓慢下降 —— G1/G7 阻力函数族的简化形状。
//  4. 弹形系数 i 由公开射程表反标定（见 CAL_FORM）。BC = m/(i d^2)。
//  5. 穿深：德马尔/汤普森经验式的现代拟合
//       P = C * m * v / d^1.75        (P:mm, m:kg, v:m/s, d:mm)
//     C = 27（AP 弹），由 46cm 九一式中弹 @20km 穿 416mm、40.6cm Mk8
//     @20kyd 穿 ~440mm 反标定；该形式对口径标度（弹重/面积比）的处理优于
//     经典 m^0.5 v / d^0.75 形式（后者在小口径严重高估）。
//     倾角等效：t_eff = t / cos^1.15(theta)，即 P_eff = P * cos^1.15(theta)。
//     跳弹（>58° 且穿深不足）、被帽破碎（shatter）、薄板过穿。
//  6. 引信：AP 底触发延迟 5~30ms（随口径），HE 瞬发；板厚 < 0.18P 时过穿不
//     引爆（二战大口径 AP 打驱逐舰常过穿不炸，历史真实）。
//  7. 近失弹：水柱高 ≈ 0.12*口径（16" ≈ 49m），水中爆炸在有效半径内对水下
//     舰体造成冲击损伤；记 NEARMISS 交 damage.applyHit。
//  8. 水中弹道：入水后 Cd≈1.8（空泡/横滚迅速失速），大口径 AP 可水下穿行
//     20~40m 后命中水线下舰体（历史：俾斯麦、胡德的水下命中）。
//  9. 陆地弹着：Land（src/sim/land.js）为二维岸线（栅格 + 小环精确判定，无海拔）。
//     弹丸落地（z 穿过地形面）时若水平位置在陆地 → 终止弹道、emit gun.terrain，
//     不调用 applyShipHit、不计命中/近失；水下弹道穿入陆地（礁盘/岸坡）同样按陆地弹着处理。
//     若 Land 将来提供 heightAt/elevationAt，则以其海拔作为地形面高度（照旧不在此造地形）。
// ============================================================================
import { clamp, deg2rad, rad2deg, normDeg, kn2mps } from '../core/util.js';
import { applyHit as damageApplyHit } from './damage.js';

const G = 9.80665;          // m/s^2
const RHO0 = 1.225;         // kg/m^3 ISA 海平面
const H_SCALE = 8500;       // m 密度标高
const T0K = 288.15;         // K
const LAPSE = 0.0065;       // K/m
const R_GAS = 287.05;       // J/(kg K)
const GAMMA = 1.4;
const RHO_WATER = 1025;

export const MIL_DEG = 360 / 6400;   // 1 mil（6400 密位制）= 0.05625°
export const DEG_PER_MIL = 6400 / 360;

let PROJ_SEQ = 0;

// ---------------------------------------------------------------------------
// 大气
// ---------------------------------------------------------------------------
export function airDensity(altM) {
  return RHO0 * Math.exp(-clamp(altM, -500, 25000) / H_SCALE);
}
export function soundSpeed(altM) {
  const T = Math.max(216.65, T0K - LAPSE * clamp(altM, -500, 25000));
  return Math.sqrt(GAMMA * R_GAS * T);
}
// 阻力形状因子（相对超声速平台值）；跨音速峰约 2.3。
export function cdMachShape(mach) {
  const m = clamp(mach, 0, 8);
  if (m < 0.60) return 1.02;
  if (m < 0.95) return 1.02 + (m - 0.60) / 0.35 * 0.22;
  if (m < 1.15) return 1.24 + (m - 0.95) / 0.20 * 1.10;   // 跨音速峰 2.34
  if (m < 1.60) return 2.34 - (m - 1.15) / 0.45 * 1.04;
  if (m < 2.50) return 1.30 - (m - 1.60) / 0.90 * 0.22;
  return 1.08 - Math.min(0.08, (m - 2.50) * 0.06);        // 高超声速平台
}

// ---------------------------------------------------------------------------
// 火炮/弹药默认参数（数据库缺字段时兜底）
// ---------------------------------------------------------------------------
// 典型二战舰炮初速（m/s），按口径查表（NavWeaps 各炮标称值）。
const CAL_MV = [
  [460, 780], [406, 762], [381, 785], [356, 762], [305, 790], [283, 855],
  [203, 853], [180, 830], [155, 812], [152, 812], [140, 840], [133, 800],
  [127, 792], [120, 808], [105, 850], [100, 880], [88, 890], [76, 900],
];
// 弹形系数 i：由公开最大射程反标定（16"/50 38.72km@45°、8"/55 27.4km@45°、
// 5"/38 16.7km@45°、15"/42 36.5km@45°）。
const CAL_FORM = [
  [460, 1.00], [406, 1.00], [381, 1.02], [356, 1.00], [305, 1.04],
  [203, 1.18], [180, 1.10], [155, 1.00], [152, 1.00], [133, 1.00],
  [127, 0.92], [120, 0.95], [105, 0.96], [100, 0.96], [88, 0.98], [76, 1.00],
];
function lookupCal(table, calMM, dflt) {
  if (!calMM || !isFinite(calMM)) return dflt;
  let best = table[0][1], bd = 1e9;
  for (const [c, v] of table) { const d = Math.abs(c - calMM); if (d < bd) { bd = d; best = v; } }
  return best;
}
export function defaultMvForCaliber(calMM) { return lookupCal(CAL_MV, calMM, 780); }
export function formFactorForCaliber(calMM) { return lookupCal(CAL_FORM, calMM, 1.0); }

// 弹种基础属性：质量系数、阻力基数、装药比、引信类型、哑弹率、穿甲品质
const AMMO_PROPS = {
  AP:   { massFrac: 1.00, cd0: 0.300, explosiveFrac: 0.015, fuze: 'BASE',   dud: 0.045, quality: 1.00 },
  SAP:  { massFrac: 0.96, cd0: 0.305, explosiveFrac: 0.035, fuze: 'BASE',   dud: 0.050, quality: 0.88 },
  HE:   { massFrac: 0.80, cd0: 0.330, explosiveFrac: 0.075, fuze: 'IMPACT', dud: 0.055, quality: 0.22 },
  AA:   { massFrac: 0.95, cd0: 0.330, explosiveFrac: 0.060, fuze: 'TIME',   dud: 0.050, quality: 0.20 },
  STAR: { massFrac: 0.55, cd0: 0.480, explosiveFrac: 0.050, fuze: 'TIME',   dud: 0.030, quality: 0.00 },
  ILLUM:{ massFrac: 0.55, cd0: 0.500, explosiveFrac: 0.040, fuze: 'TIME',   dud: 0.030, quality: 0.00 },
};

function numOf(obj, keys, dflt) {
  if (!obj) return dflt;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return dflt;
}

// 从炮塔数据构造弹丸描述子（缓存；wear/药温只影响初速，见 effectiveMv）
export function makeShell(ship, battery, ammoKind) {
  const ammo = AMMO_PROPS[ammoKind] ? ammoKind : 'AP';
  if (battery && battery._t4Shells && battery._t4Shells[ammo]) return battery._t4Shells[ammo];
  const g = (battery && battery.data) || {};
  const src = Object.assign({}, g, (g.gun && typeof g.gun === 'object') ? g.gun : {});
  let calMM = numOf(src, ['caliber_mm', 'caliberMM', 'caliberMm', 'bore_mm', 'boreMM'], 0);
  if (!calMM) {
    const calIn = numOf(src, ['caliber_in', 'caliberIn', 'size_in', 'bore_in'], 0);
    if (calIn) calMM = calIn * 25.4;
  }
  if (!calMM) calMM = (ship && ship.type === 'DD') ? 127 : 203;
  // 数据库中每炮按弹种给 {shells:{AP:{mass_kg,mv_mps,bursting_kg},HE:{...}}}
  const shellsData = (g.shells && typeof g.shells === 'object') ? g.shells : {};
  const sd = shellsData[ammo] || shellsData.AP || shellsData.HE || null;
  let massKg = numOf(src, ['shellMass_kg', 'shell_mass_kg', 'shellMassKg', 'projectile_kg', 'projectileMass_kg', 'shell_kg'], 0);
  if (!massKg && sd) massKg = numOf(sd, ['mass_kg', 'massKg', 'weight_kg'], 0);
  if (!massKg) {
    const lb = numOf(src, ['shellWeight_lb', 'shellMass_lb', 'projectileWeight_lb'], 0);
    if (lb) massKg = lb * 0.45359237;
  }
  const props = AMMO_PROPS[ammo];
  // 引信可靠性按国家区分（史实）：德国 38cm 的底发引信是二战最可靠的之一——丹麦海峡第 5 齐射
  // 击穿胡德后部弹药库即其体现；日本九一式为长延时（薄壳上易过穿不炸）；意大利与早期英国引信问题较多。
  const NATION_FUZE = { DE: 0.35, JP: 0.75, GB: 0.95, US: 1.00, IT: 1.35, FR: 1.00 };
  const nation = (ship && (ship.nation || (ship.data && ship.data.nation))) || null;
  if (!massKg) massKg = 1.75e-5 * Math.pow(calMM, 3) * props.massFrac;
  let mv = numOf(src, ['muzzleVelocity_mps', 'mv_mps', 'mvMps', 'initialVelocity_mps', 'muzzleVel_mps'], 0);
  if (!mv && sd) mv = numOf(sd, ['mv_mps', 'muzzleVelocity_mps', 'mv'], 0);
  if (!mv) {
    const fps = numOf(src, ['mv_ft_s', 'mv_fps', 'muzzleVelocity_fps', 'muzzleVelocity_ft_s'], 0);
    if (fps) mv = fps * 0.3048;
  }
  if (!mv) mv = defaultMvForCaliber(calMM);
  const form = numOf(src, ['formFactor', 'ballisticFormFactor'], 0) || formFactorForCaliber(calMM);
  const cd0 = numOf(src, ['cd0', 'dragCoefficient'], 0) || props.cd0;
  let explosiveKg = numOf(src, ['explosiveMass_kg', 'burstingCharge_kg', 'filler_kg'], 0);
  if (!explosiveKg && sd) explosiveKg = numOf(sd, ['bursting_kg', 'explosive_kg', 'filler_kg'], 0);
  if (!explosiveKg) explosiveKg = massKg * props.explosiveFrac;
  const caliberM = calMM / 1000;
  const shell = {
    ammo, caliberMM: calMM, massKg, mvMps: mv,
    areaM2: Math.PI * caliberM * caliberM / 4,
    cd0, formFactor: form, fuze: props.fuze, quality: props.quality,
    fuzeDelayS: props.fuze === 'BASE' ? (0.005 + calMM / 406 * 0.025) : 0.0015,
    armingDistM: Math.max(3, calMM * 0.05),
    dudChance: clamp(props.dud * (NATION_FUZE[nation] || 1), 0, 0.45), explosiveKg,
    tntKg: explosiveKg * numOf(src, ['tntEquivalent', 'tntFactor'], 1.0),
    // 炮的机械散布半宽（mil，数据库字段）：作为单炮附加角散布使用
    mechDispersionMil: numOf(src, ['dispersionHalfWidthMil', 'dispersion_mil', 'dispersionHalfWidth'], 0) || 1.5,
    tracer: false,
  };
  if (battery) { if (!battery._t4Shells) battery._t4Shells = {}; battery._t4Shells[ammo] = shell; }
  return shell;
}

// 初速修正：膛线磨损（0..1 → 最多 -6%）+ 发射药温度（每 +1°C ≈ +0.11%）
export function effectiveMv(battery, shell, powderTempC) {
  const wear = clamp((battery && battery.wear) || 0, 0, 1);
  const temp = (powderTempC === undefined || !isFinite(powderTempC)) ? 21 : powderTempC;
  return shell.mvMps * (1 - 0.06 * wear) * (1 + 0.0011 * (temp - 21));
}

// 单炮初速随机误差（装药重量/燃烧不一致）：σ ≈ 0.12%
export function mvJitterFraction() { return 0.0012; }

// ---------------------------------------------------------------------------
// 弹道积分（RK4）
// ---------------------------------------------------------------------------
function accelOf(z, vx, vy, vz, shell, wind) {
  const wx = wind ? wind.x : 0, wy = wind ? wind.y : 0;
  const altFac = 1 + clamp(z, 0, 12000) / 3000;
  const rx = vx - wx * altFac, ry = vy - wy * altFac, rz = vz;
  const v = Math.hypot(rx, ry, rz);
  const rho = airDensity(z);
  const mach = v / Math.max(1, soundSpeed(z));
  const k = 0.5 * rho * shell.cd0 * shell.formFactor * cdMachShape(mach) * shell.areaM2 / shell.massKg;
  const d = k * v;
  return { ax: -d * rx, ay: -d * ry, az: -G - d * rz };
}

// 返回 { rangeM, tofS, fallAngleDeg, vStrikeMps, apexM, driftM }
// stopAtGround 时在 z=0 处线性插值落点。dt 默认 0.15s（射表足够精度）。
export function integrateTrajectory(shell, elevDeg, mv, opts = {}) {
  const dt = opts.dt || 0.15;
  const maxT = opts.maxT || 240;
  const wind = opts.wind || null;
  const e = deg2rad(elevDeg);
  const st = [0, 0, opts.z0 || 0, mv * Math.cos(e), 0, mv * Math.sin(e)];
  let t = 0, apex = st[2];
  const der = (s) => {
    const a = accelOf(s[2], s[3], s[4], s[5], shell, wind);
    return [s[3], s[4], s[5], a.ax, a.ay, a.az];
  };
  let prev = st.slice();
  while (t < maxT) {
    const k1 = der(st);
    const s2 = st.map((v, i) => v + 0.5 * dt * k1[i]);
    const k2 = der(s2);
    const s3 = st.map((v, i) => v + 0.5 * dt * k2[i]);
    const k3 = der(s3);
    const s4 = st.map((v, i) => v + dt * k3[i]);
    const k4 = der(s4);
    prev = st.slice();
    for (let i = 0; i < 6; i++) st[i] += dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    t += dt;
    if (st[2] > apex) apex = st[2];
    if (st[2] <= 0 && opts.stopAtGround !== false) {
      const f = prev[2] / Math.max(1e-6, prev[2] - st[2]);
      const rx = prev[0] + (st[0] - prev[0]) * f;
      const ry = prev[1] + (st[1] - prev[1]) * f;
      const rvx = prev[3] + (st[3] - prev[3]) * f;
      const rvy = prev[4] + (st[4] - prev[4]) * f;
      const rvz = prev[5] + (st[5] - prev[5]) * f;
      return {
        rangeM: Math.hypot(rx, ry), tofS: t - dt * (1 - f),
        fallAngleDeg: rad2deg(Math.atan2(-rvz, Math.hypot(rvx, rvy))),
        vStrikeMps: Math.hypot(rvx, rvy, rvz), apexM: apex, driftM: ry,
      };
    }
  }
  return {
    rangeM: Math.hypot(st[0], st[1]), tofS: t,
    fallAngleDeg: rad2deg(Math.atan2(-st[5], Math.hypot(st[3], st[4]))),
    vStrikeMps: Math.hypot(st[3], st[4], st[5]), apexM: apex, driftM: st[1],
  };
}

// ---------------------------------------------------------------------------
// 射表（每弹种/初速一份，LRU 缓存）
// ---------------------------------------------------------------------------
const _tables = new Map();
const TABLE_MAX = 32;
function tableKey(shell, mv) {
  return shell.massKg.toFixed(1) + '|' + shell.caliberMM.toFixed(1) + '|' + shell.cd0.toFixed(3) + '|' +
    shell.formFactor.toFixed(3) + '|' + mv.toFixed(0) + '|' + (shell.quality > 0.5 ? 'AP' : 'HE');
}
const ELEV_STEPS = (() => {
  const out = [];
  for (let e = 0.25; e <= 15.0001; e += 0.25) out.push(+e.toFixed(4));
  for (let e = 15.5; e <= 30.0001; e += 0.5) out.push(+e.toFixed(4));
  for (let e = 31; e <= 70.0001; e += 1) out.push(+e.toFixed(4));
  return out;
})();

export function rangeTableFor(shell, mv) {
  const v = (mv === undefined || !isFinite(mv)) ? shell.mvMps : mv;
  const key = tableKey(shell, v);
  const hit = _tables.get(key);
  if (hit) return hit;
  const rows = [];
  let maxRow = null;
  for (const e of ELEV_STEPS) {
    const r = integrateTrajectory(shell, e, v, { dt: 0.2, maxT: 300 });
    const row = { elevDeg: e, rangeM: r.rangeM, tofS: r.tofS, fallAngleDeg: r.fallAngleDeg, vStrikeMps: r.vStrikeMps, apexM: r.apexM };
    rows.push(row);
    if (!maxRow || row.rangeM > maxRow.rangeM) maxRow = row;
  }
  const table = { key, shell, mv: v, rows, maxRow, maxRangeM: maxRow.rangeM };
  _tables.set(key, table);
  if (_tables.size > TABLE_MAX) { const first = _tables.keys().next().value; _tables.delete(first); }
  return table;
}

// 距离 → 仰角/飞行时间/落角/落速（插值）。超出最大射程返回 maxRow 且 outOfRange。
export function solutionForRange(shell, rangeM, mv) {
  const table = rangeTableFor(shell, mv);
  const rows = table.rows;
  const R = Math.max(0, rangeM);
  if (R <= rows[0].rangeM) {
    const r0 = rows[0];
    const f = r0.rangeM > 1 ? R / r0.rangeM : 0;
    return { elevDeg: r0.elevDeg * f, tofS: r0.tofS * f, fallAngleDeg: r0.fallAngleDeg,
      vStrikeMps: r0.vStrikeMps, rangeM: R, apexM: r0.apexM * f, outOfRange: false, maxRangeM: table.maxRangeM };
  }
  if (R >= table.maxRangeM) {
    const mr = table.maxRow;
    return { elevDeg: mr.elevDeg, tofS: mr.tofS, fallAngleDeg: mr.fallAngleDeg,
      vStrikeMps: mr.vStrikeMps, rangeM: mr.rangeM, apexM: mr.apexM, outOfRange: true, maxRangeM: table.maxRangeM };
  }
  let i = 0;
  for (; i < rows.length - 1; i++) if (rows[i + 1].rangeM >= R) break;
  const a = rows[i], b = rows[Math.min(i + 1, rows.length - 1)];
  const span = b.rangeM - a.rangeM;
  const f = span > 1e-6 ? clamp((R - a.rangeM) / span, 0, 1) : 0;
  const lerp = (p, q) => p + (q - p) * f;
  return {
    elevDeg: lerp(a.elevDeg, b.elevDeg), tofS: lerp(a.tofS, b.tofS),
    fallAngleDeg: lerp(a.fallAngleDeg, b.fallAngleDeg), vStrikeMps: lerp(a.vStrikeMps, b.vStrikeMps),
    rangeM: R, apexM: lerp(a.apexM, b.apexM), outOfRange: false, maxRangeM: table.maxRangeM,
  };
}

export function solutionForElevation(shell, elevDeg, mv) {
  const table = rangeTableFor(shell, mv);
  const rows = table.rows;
  const e = clamp(elevDeg, rows[0].elevDeg, rows[rows.length - 1].elevDeg);
  let i = 0;
  for (; i < rows.length - 1; i++) if (rows[i + 1].elevDeg >= e) break;
  const a = rows[i], b = rows[Math.min(i + 1, rows.length - 1)];
  const f = b.elevDeg > a.elevDeg ? clamp((e - a.elevDeg) / (b.elevDeg - a.elevDeg), 0, 1) : 0;
  const lerp = (p, q) => p + (q - p) * f;
  return {
    elevDeg: e, rangeM: lerp(a.rangeM, b.rangeM), tofS: lerp(a.tofS, b.tofS),
    fallAngleDeg: lerp(a.fallAngleDeg, b.fallAngleDeg), vStrikeMps: lerp(a.vStrikeMps, b.vStrikeMps),
    apexM: lerp(a.apexM, b.apexM), outOfRange: false, maxRangeM: table.maxRangeM,
  };
}

// ---------------------------------------------------------------------------
// 穿深
// ---------------------------------------------------------------------------
const DE_MARRE_C = 27;      // 标定常数：46cm AP @20km ≈ 416mm，40.6cm @20kyd ≈ 440mm
const OBLIQ_EXP = 1.15;     // 倾角等效指数（被帽归一化后 1.1~1.2）

// 名义穿深 P0（法向入射，mm），未考虑倾角
export function penetrationAtNormal(shellMassKg, caliberMM, velocityMps, quality) {
  if (velocityMps <= 0 || caliberMM <= 0 || shellMassKg <= 0) return 0;
  const q = (quality === undefined) ? 1 : quality;
  return DE_MARRE_C * q * shellMassKg * velocityMps / Math.pow(caliberMM, 1.75);
}

// 契约接口：返回该弹在此倾角下可击穿的等效法向装甲厚度（mm）
export function penetrationMM(armorMM, obliquityDeg, shellMassKg, caliberMM, velocityMps) {
  const P0 = penetrationAtNormal(shellMassKg, caliberMM, velocityMps, 1.0);
  const ob = deg2rad(clamp(obliquityDeg, 0, 89.5));
  let P = P0 * Math.pow(Math.cos(ob), OBLIQ_EXP);
  // 极薄板（相对口径 < 0.1）存在冲塞效应，等效更易穿透
  if (armorMM > 0 && armorMM < caliberMM * 0.10) P *= 1.10;
  return P;
}

// 完整穿深判定（含跳弹/破碎/引信/过穿）
export function penetrationDetail(armorMM, obliquityDeg, shell, velocityMps) {
  const v = Math.max(1, velocityMps);
  const P0 = penetrationAtNormal(shell.massKg, shell.caliberMM, v, shell.quality);
  const obRad = deg2rad(clamp(obliquityDeg, 0, 89.5));
  const cosO = Math.cos(obRad);
  const Peff = P0 * Math.pow(cosO, OBLIQ_EXP);
  const tEff = armorMM > 0 ? armorMM : 1e-6;
  const ratio = Peff / Math.max(1e-6, tEff);
  const out = {
    armorMM, obliquityDeg, normalPenMM: P0, effectivePenMM: Peff,
    effectiveArmorMM: tEff, ratio,
    penetrated: false, bounced: false, shattered: false, overmatched: false,
    detonated: false, passThrough: false, partial: false,
  };
  if (shell.quality <= 0.05) { out.partial = true; return out; }
  if (Peff >= tEff) {
    out.penetrated = true;
    if (tEff < P0 * 0.18) { out.passThrough = true; out.overmatched = true; }
    return out;
  }
  const oblDeg = rad2deg(obRad);
  if (oblDeg > 58 && ratio < 1.0) {
    const pBounce = clamp(0.15 + (oblDeg - 58) / 30 * 0.85 + (1 - ratio) * 0.25, 0, 0.95);
    if (pBounce > 0.5) out.bounced = true;
  }
  if (!out.bounced && oblDeg < 35 && tEff > P0 * 1.7) out.shattered = true;
  if (!out.bounced && !out.shattered) out.partial = true;
  return out;
}

// ---------------------------------------------------------------------------
// 舰体几何（命中判定与命中位置）
// ---------------------------------------------------------------------------
function shipDims(ship) {
  const d = ship.data || {};
  const loa = d.loa_m || d.length_m || (ship.type === 'DD' ? 100 : 200);
  const beam = d.beam_m || d.width_m || (ship.type === 'DD' ? 10 : 25);
  const draft = ship.draftM || d.draft_m || 6;
  // 满载干舷：战列舰通常只有吃水的 0.4~0.6 倍；Ship.freeboardM 由 hullDepth
  // (1.75*draft) 推得偏大，会让侧舷命中窗口过大，这里取 min 校正。
  const freeboard = Math.max(0.5, Math.min(ship.freeboardM || d.freeboard_m || draft * 0.6, draft * 0.55));
  return { loa, beam, draft, freeboard };
}
function superstructureHeight(ship) {
  const d = ship.data || {};
  if (d.superstructureHeight_m) return d.superstructureHeight_m;
  switch (ship.type) {
    case 'BB': case 'BC': return 14;
    case 'CV': return 20;
    case 'CA': return 11;
    case 'CL': return 10;
    case 'DD': return 6.5;
    default: return 9;
  }
}
function gunHeight(ship) {
  const d = ship.data || {};
  if (d.gunHeight_m) return d.gunHeight_m;
  const dims = shipDims(ship);
  return dims.draft + dims.freeboard * 0.55;
}

// 世界坐标 → 舰体局部 {along(艏正), across(右舷正), z}
function toShipLocal(ship, p) {
  const h = deg2rad(ship.heading);
  const s = Math.sin(h), c = Math.cos(h);
  const dx = p.x - ship.pos.x, dy = p.y - ship.pos.y;
  return { along: dx * s + dy * c, across: dx * c - dy * s, z: p.z };
}
function shipNormalWorld(ship, axis, sign) {
  const h = deg2rad(ship.heading);
  const s = Math.sin(h), c = Math.cos(h);
  if (axis === 0) return { x: s * sign, y: c * sign, z: 0 };
  if (axis === 1) return { x: c * sign, y: -s * sign, z: 0 };
  return { x: 0, y: 0, z: sign };
}

// 线段 vs 轴对齐盒（slab 法）。返回 {t, axis, sign}：
// sign=+1 表示从盒的“正方向面”进入（如 z 轴从上方进入），-1 反之。
function segBoxHit(a, b, min, max) {
  let tmin = 0, tmax = 1, axis = -1, sign = 0;
  const av = [a.along, a.across, a.z];
  const bv = [b.along, b.across, b.z];
  const mn = [min.along, min.across, min.z];
  const mx = [max.along, max.across, max.z];
  for (let ax = 0; ax < 3; ax++) {
    const d = bv[ax] - av[ax];
    if (Math.abs(d) < 1e-9) {
      if (av[ax] < mn[ax] || av[ax] > mx[ax]) return null;
      continue;
    }
    let t1 = (mn[ax] - av[ax]) / d, t2 = (mx[ax] - av[ax]) / d;
    let sg = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = ax; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return { t: 0, axis: 2, sign: bv[2] < av[2] ? 1 : -1 };
  return { t: tmin, axis, sign };
}

// 命中舰船：返回最近命中 {ship,t,entry,axis,sign,kind,dims}
function findShipHit(world, prev, cur, shooter) {
  let best = null;
  for (const ship of world.ships) {
    if (!ship.isAfloat || ship === shooter) continue;
    const dims = shipDims(ship);
    const ssH = superstructureHeight(ship);
    const dx = cur.x - ship.pos.x, dy = cur.y - ship.pos.y;
    if (Math.hypot(dx, dy) > dims.loa * 0.75 + 400) continue;
    const a = toShipLocal(ship, prev), b = toShipLocal(ship, cur);
    // 上层建筑是"窄而集中"的实体（舰桥/烟囱/炮塔群），不能用一个覆盖全舯部的
    // 大盒子近似，否则平弹道掠过舰体上方的近失弹会被误判为命中。
    const superBox = {
      min: { along: -dims.loa * 0.09, across: -dims.beam * 0.18, z: dims.freeboard },
      max: { along: dims.loa * 0.07, across: dims.beam * 0.18, z: dims.freeboard + ssH * 0.5 },
    };
    const hullBox = {
      min: { along: -dims.loa * 0.5, across: -dims.beam * 0.5, z: -dims.draft * 0.92 },
      max: { along: dims.loa * 0.5, across: dims.beam * 0.5, z: dims.freeboard },
    };
    let h = segBoxHit(a, b, hullBox.min, hullBox.max);
    let kind = 'HULL';
    const hs = segBoxHit(a, b, superBox.min, superBox.max);
    if (hs && (!h || hs.t <= h.t)) { h = hs; kind = 'SUPER'; }
    if (!h) continue;
    const entry = {
      along: a.along + (b.along - a.along) * h.t,
      across: a.across + (b.across - a.across) * h.t,
      z: a.z + (b.z - a.z) * h.t,
    };
    if (!best || h.t < best.t) best = { ship, t: h.t, entry, axis: h.axis, sign: h.sign, kind, dims };
  }
  return best;
}

function resolveHitPart(hit, fx) {
  const { entry, axis, sign, kind, dims } = hit;
  const ship = hit.ship;
  const armor = (ship.data && ship.data.armor) || {};
  const comp = ship.compartmentAt(clamp(fx, 0, 1));
  // 炮塔/炮座命中：按"炮塔站位 ±4.5% 舰长"判定，且横向必须落在舰体中部。
  // 旧实现只在两段硬编码区间 + 仅上层建筑命中才算炮塔，实测 77 发命中里炮塔占 0%——
  // 而史实上主力舰交战中炮塔/炮座命中约占 10~20%（PoW 被一发 15 吋打坏炮塔、俾斯麦 A/B 炮塔先后中弹）。
  for (const b of (ship.mainBatteries || [])) {
    const sf = (b.station_frac !== undefined) ? b.station_frac
      : (b.data && b.data.positionFrac !== undefined ? b.data.positionFrac : null);
    if (sf === null) continue;
    if (Math.abs(fx - sf) <= 0.045 && Math.abs(entry.across) < dims.beam * 0.34) {
      return { part: 'TURRET', armorMM: armor.turret_mm || armor.barbette_mm || 50, turretId: b.id };
    }
  }
  if (kind === 'SUPER') {
    const nearTurret = (fx > 0.22 && fx < 0.40) || (fx > 0.58 && fx < 0.78);
    if (nearTurret && Math.abs(entry.across) < dims.beam * 0.30) {
      return { part: 'TURRET', armorMM: armor.turret_mm || armor.barbette_mm || 50 };
    }
    if (fx > 0.42 && fx < 0.52) return { part: 'BRIDGE', armorMM: armor.ct_mm || armor.superstructure_mm || 20 };
    return { part: 'SUPERSTRUCTURE', armorMM: armor.superstructure_mm || 15 };
  }
  if (axis === 2) {
    if (sign > 0) return { part: 'DECK', armorMM: comp.deck_mm || armor.deck_mm || 20 };  // 自上而下穿甲板
    return { part: 'BOTTOM', armorMM: 12 };
  }
  if (entry.z < 0.8) return { part: 'UNDERWATER', armorMM: 0 };
  if (axis === 0) return { part: sign > 0 ? 'BOW' : 'STERN', armorMM: Math.min(comp.belt_mm || 20, 30) };
  return { part: 'BELT', armorMM: comp.belt_mm || armor.belt_mm || 25 };
}

// 弹道速度与装甲面法向的夹角（0=垂直入射，90=掠射）
function obliquityFor(ship, hit, fallAngleDeg, velocity) {
  if (hit.axis === 2) return clamp(90 - fallAngleDeg, 0, 89.5);  // 水平板
  const n = shipNormalWorld(ship, hit.axis, hit.sign);
  const vmag = Math.max(1e-6, Math.hypot(velocity.x, velocity.y, velocity.z));
  const cosO = Math.abs((velocity.x * n.x + velocity.y * n.y + velocity.z * n.z) / vmag);
  return rad2deg(Math.acos(clamp(cosO, 0, 1)));
}

// ---------------------------------------------------------------------------
// 水柱 / 近失
// ---------------------------------------------------------------------------
function splashHeightM(shell) {
  const base = shell.caliberMM * 0.12;
  return shell.ammo === 'HE' ? base * 1.25 : base;
}
function _salvoRecord(world, salvoId) {
  if (!salvoId || !world.salvoes) return null;
  return world.salvoes.get(salvoId) || null;
}
function pushSplash(world, p, shell, fallAngleDeg) {
  if (!world.splashes) world.splashes = [];
  const h = splashHeightM(shell);
  const splash = {
    id: 'sp' + (++PROJ_SEQ), t: world.t, x: p.x, y: p.y,
    heightM: h, radiusM: h * 0.55, caliberMM: shell.caliberMM, ammo: shell.ammo,
    shipId: p.shipId, side: p.side, trackId: p.trackId, targetShipId: p.targetShipId,
    salvoId: p.salvoId, shooterName: (p.owner && p.owner.name) || p.shipId,
    observed: false, ageS: 0,
  };
  world.splashes.push(splash);
  if (world.splashes.length > 240) world.splashes.splice(0, world.splashes.length - 240);
  world.events.emit('gun.miss', {
    t: world.t, ship: p.shipId, side: p.side, byShip: p.shipId,
    shooterName: splash.shooterName,
    x: +p.x.toFixed(1), y: +p.y.toFixed(1), splashHeightM: +h.toFixed(1),
    ammo: shell.ammo, caliberMM: shell.caliberMM, fallAngleDeg: +fallAngleDeg.toFixed(1),
    trackId: p.trackId || null, targetShipId: p.targetShipId || null, salvoId: p.salvoId || null,
    timeOfFlightS: +((world.t - p.t0)).toFixed(2),
  });
  const rec = _salvoRecord(world, p.salvoId);
  if (rec) rec.splashes.push(splash);
  return splash;
}
// 近失有效半径（m）：水中爆炸对舰体水下结构造成冲击损伤的范围
function nearMissRadiusM(shell) {
  const base = 4 + shell.caliberMM / 14;
  return shell.ammo === 'HE' ? base * 1.5 : base;
}

// 舰船到点 (x,y) 的"舷外距离"（点到舰体水平轮廓的距离）
function hullDistance(ship, x, y) {
  const dims = shipDims(ship);
  const loc = toShipLocal(ship, { x, y, z: 0 });
  const da = Math.max(0, Math.abs(loc.along) - dims.loa * 0.5);
  const dc = Math.max(0, Math.abs(loc.across) - dims.beam * 0.5);
  return Math.hypot(da, dc);
}

// ---------------------------------------------------------------------------
// 陆地弹着（Land）
// ---------------------------------------------------------------------------
// 统一走 Land 的现有精确判定（isLandExact 含细小岛礁兜底），不在 ballistics 里造地形。
// 低于此高度（m）才做陆地判定：弹丸在 600 m 以上绝不可能撞上二战太平洋的岛屿岸线，
// 而这样能把绝大多数空中段的 isLandExact 调用省掉（性能）。
const LAND_CHECK_ALT_M = 600;

function landAt(land, x, y) {
  if (!land || land.empty) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (typeof land.isLandExact === 'function') return land.isLandExact(x, y);
  if (typeof land.isLandAny === 'function') return land.isLandAny(x, y);
  if (typeof land.isLand === 'function') return land.isLand(x, y);
  return false;
}

// 地形面高度（米）：Land 无海拔 → 0（落到海平面即落到岸线）。有海拔查询能力时用其返回值。
function landSurfaceM(land, x, y) {
  if (!land) return 0;
  const f = typeof land.heightAt === 'function' ? land.heightAt
    : (typeof land.elevationAt === 'function' ? land.elevationAt : null);
  if (!f) return 0;
  const h = Number(f.call(land, x, y));
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}

function terrainImpact(world, p, x, y, z, opts = {}) {
  const shell = p.shell;
  const speed = opts.speed !== undefined ? opts.speed : Math.hypot(p.vx, p.vy, p.vz);
  const fallAngle = opts.fallAngleDeg !== undefined ? opts.fallAngleDeg
    : rad2deg(Math.atan2(-p.vz, Math.hypot(p.vx, p.vy)));
  world.events.emit('gun.terrain', {
    t: world.t, ship: p.shipId, side: p.side, byShip: p.shipId,
    shooterName: (p.owner && p.owner.name) || p.shipId,
    x: +x.toFixed(1), y: +y.toFixed(1), z: +(z || 0).toFixed(1),
    ammo: shell.ammo, caliberMM: shell.caliberMM,
    fallAngleDeg: (Number.isFinite(fallAngle) ? +fallAngle.toFixed(1) : null),
    impactSpeedMps: +speed.toFixed(0), underwater: !!opts.underwater, hitTerrain: true,
    trackId: p.trackId || null, targetShipId: p.targetShipId || null, salvoId: p.salvoId || null,
    timeOfFlightS: +((world.t - p.t0)).toFixed(2),
  });
  const rec = _salvoRecord(world, p.salvoId);
  if (rec) rec.terrainHits = (rec.terrainHits || 0) + 1;
  p.alive = false;
}

// ---------------------------------------------------------------------------
// spawnProjectile
// ---------------------------------------------------------------------------
export function spawnProjectile(world, spec) {
  const ship = spec.ship;
  const battery = spec.battery || null;
  const shell = spec.shell || makeShell(ship, battery, spec.ammo || 'AP');
  const mv = (spec.mv && isFinite(spec.mv)) ? spec.mv : effectiveMv(battery, shell, spec.powderTempC);
  const rng = world.rng;
  const dispMil = (spec.dispersionMil === undefined) ? 1.1 : spec.dispersionMil;
  const bearing = normDeg(spec.bearingDeg + (spec.bearingOffsetDeg || 0));
  const elev = clamp(spec.elevDeg + (spec.elevOffsetDeg || 0), -6, 85);
  // 注意：MIL_DEG 是"度/密位"，散布角直接以度为单位叠加
  const dBearDeg = rng.normal(0, dispMil * MIL_DEG);
  const dElevDeg = rng.normal(0, dispMil * 0.85 * MIL_DEG);
  const mvActual = mv * (1 + rng.normal(0, mvJitterFraction()));
  const dirH = deg2rad(normDeg(bearing + dBearDeg));
  const e = deg2rad(elev + dElevDeg);
  const hd = deg2rad(ship.heading);
  const shipVel = kn2mps(ship.speed || 0);
  const z0 = spec.z0 || gunHeight(ship);
  const v = {
    x: mvActual * Math.cos(e) * Math.sin(dirH) + shipVel * Math.sin(hd),
    y: mvActual * Math.cos(e) * Math.cos(dirH) + shipVel * Math.cos(hd),
    z: mvActual * Math.sin(e),
  };
  const p = {
    id: 'pr' + (++PROJ_SEQ), type: 'SHELL',
    t0: world.t, x: ship.pos.x, y: ship.pos.y, z: z0,
    vx: v.x, vy: v.y, vz: v.z,
    shell, ammo: shell.ammo, side: ship.side, shipId: ship.id,
    trackId: spec.trackId || null, targetShipId: spec.targetShipId || null,
    salvoId: spec.salvoId || null, batteryId: battery ? battery.id : null,
    gunIndex: spec.gunIndex || 0, owner: ship,
    alive: true, underwater: false, phase: 'AIR',
    fuseTimeS: spec.fuseTimeS || (shell.fuze === 'TIME' ? (spec.predictedTofS || 20) * (0.92 + rng.next() * 0.1) : null),
    predictedTofS: spec.predictedTofS || 0,
    shotRangeM: spec.rangeM || 0,
    mvActual, dispersionMil: dispMil, trail: [],
  };
  const rec = _salvoRecord(world, p.salvoId);
  if (rec) rec.shots++;
  if (!world.projectiles) world.projectiles = [];
  world.projectiles.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// 命中结算
// ---------------------------------------------------------------------------
function applyShipHit(world, p, hit, prev, cur) {
  const shell = p.shell;
  const rng = world.rng;
  const ship = hit.ship;
  const dims = hit.dims;
  const fx = clamp(hit.entry.along / dims.loa + 0.5, 0, 1);
  const partInfo = resolveHitPart(hit, fx);
  const velocity = { x: p.vx, y: p.vy, z: p.vz };
  const speed = Math.hypot(p.vx, p.vy, p.vz);
  const fallAngle = rad2deg(Math.atan2(-p.vz, Math.hypot(p.vx, p.vy)));
  const ob = obliquityFor(ship, hit, fallAngle, velocity);
  const det = penetrationDetail(partInfo.armorMM, ob, shell, speed);
  if (det.penetrated && !det.passThrough) det.detonated = true;
  else if (shell.ammo === 'HE' || shell.ammo === 'AA') det.detonated = true;
  else if (det.partial && !det.bounced && !det.shattered && rng.chance(0.5 + shell.quality * 0.3)) det.detonated = true;
  if (partInfo.part === 'UNDERWATER' || partInfo.part === 'BOTTOM') { det.penetrated = true; det.passThrough = false; det.detonated = true; }
  if (shell.fuze === 'TIME') det.detonated = true;
  const dud = rng.chance(shell.dudChance);
  if (dud) det.detonated = false;
  // 起爆位置：穿甲后沿弹道在舰体内前进 v*delay
  let detX = fx, detDepth = 0;
  if (det.detonated && det.penetrated && !det.passThrough) {
    const travel = Math.min(Math.max(6, speed * shell.fuzeDelayS), dims.loa * 0.35);
    detDepth = travel;
    const hx = Math.sin(deg2rad(ship.heading)), hy = Math.cos(deg2rad(ship.heading));
    const alongVel = (p.vx * hx + p.vy * hy) / Math.max(1, speed);
    detX = clamp(fx + alongVel * travel / dims.loa, 0, 1);
  }
  const hitObj = {
    kind: 'SHELL', t: world.t,
    side: p.side, attackerSide: p.side, attackerId: p.shipId, attackerName: (p.owner && p.owner.name) || p.shipId,
    victimId: ship.id, ship: ship.id, shipSide: ship.side, name: ship.name, targetId: ship.id,
    ammo: shell.ammo, caliberMM: shell.caliberMM, massKg: shell.massKg,
    shell: { ammo: shell.ammo, caliberMM: shell.caliberMM, massKg: shell.massKg, explosiveKg: shell.explosiveKg, fuze: shell.fuze },
    impact: {
      x: cur.x, y: cur.y, z: cur.z, xFrac: fx, hitPart: partInfo.part,
      obliquityDeg: ob, fallAngleDeg: fallAngle, velocityMps: speed,
      localAlong: hit.entry.along, localAcross: hit.entry.across, localZ: hit.entry.z,
    },
    armorMM: partInfo.armorMM, effectiveArmorMM: det.effectiveArmorMM, penetrationMM: det.effectivePenMM,
    penetrated: det.penetrated, passThrough: det.passThrough, overmatched: det.overmatched,
    bounced: det.bounced, shattered: det.shattered, partial: det.partial, detonated: det.detonated, dud,
    detonation: det.detonated ? { xFrac: detX, depthM: detDepth } : null,
    explosiveKg: shell.explosiveKg, tntEquivalentKg: shell.tntKg,
    // ---- 与 damage.js（T3）applyHit 的兼容字段 ----
    penetrates: det.penetrated, energyMJ: 0.5 * shell.massKg * speed * speed / 1e6,
    tntKg: shell.tntKg, warheadKg: shell.explosiveKg,
    killerShipId: p.shipId, killerSide: p.side, killerName: (p.owner && p.owner.name) || '',
    targetShipId: ship.id, targetShip: ship,
    sideBias: Math.sign(hit.entry.across) || 1,
    depthM: Math.max(0, -hit.entry.z),
    rangeM: p.shotRangeM || 0, timeOfFlightS: world.t - p.t0, isNearMiss: false,
  };
  const rec = _salvoRecord(world, p.salvoId);
  if (rec) { rec.hits++; if (det.penetrated) rec.penetrations = (rec.penetrations || 0) + 1; }
  // 命中/被命中的唯一计数入口在 damage.applyHit（受害者 hitsTaken）与这里（攻击方 hits）；
  // 旧实现还在 ballistics 里给受害者 hitsTaken 再 +1，导致 AAR「被命中」恰为真实命中的 2 倍。
  if (p.owner && p.owner.stats) p.owner.stats.hits = (p.owner.stats.hits || 0) + 1;
  const payload = {
    t: world.t, ship: ship.id, name: ship.name, victimSide: ship.side,
    killerSide: p.side, byShip: p.shipId, byShipName: (p.owner && p.owner.name) || '',
    ammo: shell.ammo, caliberMM: shell.caliberMM, hitPart: partInfo.part,
    penetrated: det.penetrated,
    penetratedType: det.bounced ? 'BOUNCE' : (det.shattered ? 'SHATTER' : (det.partial ? 'PARTIAL' : 'PENETRATE')),
    armorMM: partInfo.armorMM, penetrationMM: Math.round(det.effectivePenMM),
    obliquityDeg: +ob.toFixed(1), xFrac: +fx.toFixed(3), detonated: det.detonated,
    dud, damageKind: 'SHELL', hit: hitObj,
  };
  world.events.emit('gun.hit', payload);
  if (det.penetrated) world.events.emit('gun.penetration', payload);
  else if (det.bounced) world.events.emit('gun.bounce', payload);
  try { damageApplyHit(world, hitObj); } catch (e) { console.error('[ballistics] applyHit', e); }
  p.alive = false;
  return hitObj;
}

// ---------------------------------------------------------------------------
// 水下弹道 / 入水
// ---------------------------------------------------------------------------
function checkUnderwaterShipHit(world, p) {
  for (const ship of world.ships) {
    if (!ship.isAfloat || ship === p.owner) continue;
    const dims = shipDims(ship);
    const loc = toShipLocal(ship, p);
    if (Math.abs(loc.along) < dims.loa * 0.5 && Math.abs(loc.across) < dims.beam * 0.5 &&
        loc.z > -dims.draft * 0.92 && loc.z < 0.5) {
      return { ship, loc, dims };
    }
  }
  return null;
}

function waterImpact(world, p, prev) {
  const f = prev.z > 0 ? prev.z / Math.max(1e-6, prev.z - p.z) : 0;
  const wx = prev.x + (p.x - prev.x) * f;
  const wy = prev.y + (p.y - prev.y) * f;
  const shell = p.shell;
  const fallAngle = rad2deg(Math.atan2(-(prev.vz + (p.vz - prev.vz) * f), Math.hypot(p.vx, p.vy)));
  const impactSpeed = Math.hypot(p.vx, p.vy, p.vz);
  p.x = wx; p.y = wy; p.z = 0;
  const splash = pushSplash(world, p, shell, fallAngle);
  splash.fallAngleDeg = fallAngle;
  splash.impactSpeedMps = impactSpeed;
  // 近失：舷外距离
  let nearest = null, nd = 1e9;
  for (const ship of world.ships) {
    if (!ship.isAfloat || ship === p.owner) continue;
    const d = hullDistance(ship, wx, wy);
    if (d < nd) { nd = d; nearest = ship; }
  }
  const nmr = nearMissRadiusM(shell);
  if (nearest && nd < nmr) {
    const victim = nearest;
    const hitObj = {
      kind: 'NEARMISS', t: world.t,
      side: p.side, attackerSide: p.side, attackerId: p.shipId,
      victimId: victim.id, ship: victim.id, shipSide: victim.side, name: victim.name,
      targetId: victim.id, ammo: shell.ammo, caliberMM: shell.caliberMM, massKg: shell.massKg,
      nearMissDistanceM: Math.max(0, nd),
      impact: { x: wx, y: wy, z: 0, xFrac: 0.5, hitPart: 'WATERLINE', fallAngleDeg: fallAngle, velocityMps: impactSpeed, obliquityDeg: 0 },
      explosiveKg: shell.explosiveKg, tntEquivalentKg: shell.tntKg,
      penetrated: false, bounced: false, shattered: false, detonated: true, dud: false,
      // damage.js 兼容
      penetrates: false, energyMJ: 0.5 * shell.massKg * impactSpeed * impactSpeed / 1e6,
      tntKg: shell.tntKg, warheadKg: shell.explosiveKg,
      killerShipId: p.shipId, killerSide: p.side, killerName: (p.owner && p.owner.name) || '',
      targetShipId: victim.id, targetShip: victim, sideBias: 0, depthM: 1.5,
      rangeM: p.shotRangeM || 0, timeOfFlightS: world.t - p.t0, isNearMiss: true,
    };
    world.events.emit('gun.nearmiss', {
      t: world.t, ship: victim.id, name: victim.name, victimSide: victim.side, killerSide: p.side,
      byShip: p.shipId, distanceM: +nd.toFixed(1), ammo: shell.ammo, caliberMM: shell.caliberMM, hit: hitObj,
    });
    try { damageApplyHit(world, hitObj); } catch (e) { /* T3 桩 */ }
    const rec = _salvoRecord(world, p.salvoId); if (rec) rec.nearMisses = (rec.nearMisses || 0) + 1;
    p.alive = false;
    return;
  }
  // 水中弹道：大口径 AP/SAP 可水下穿行 20~40m
  if (shell.ammo === 'AP' || shell.ammo === 'SAP') {
    let ux = p.x, uy = p.y, uz = -0.5;
    let uvx = p.vx, uvy = p.vy, uvvz = Math.min(p.vz, -3);
    const dt = 0.01;
    for (let i = 0; i < 500; i++) {
      const v = Math.hypot(uvx, uvy, uvvz);
      if (v < 15) break;
      const k = 0.5 * RHO_WATER * 1.8 * shell.areaM2 / shell.massKg;
      const d = k * v;
      uvx -= d * uvx * dt; uvy -= d * uvy * dt; uvvz -= (d * uvvz + G * 0.15) * dt;
      ux += uvx * dt; uy += uvy * dt; uz += uvvz * dt;
      if (uz < -40) break;
      p.x = ux; p.y = uy; p.z = Math.max(uz, -40);
      // 水线以下弹道穿入陆地（礁盘/岸坡）：同样按陆地弹着终止，不结算舰体命中
      if (landAt(world.land, ux, uy)) {
        terrainImpact(world, p, ux, uy, Math.max(0, uz), {
          speed: Math.hypot(uvx, uvy, uvvz), fallAngleDeg: fallAngle, underwater: true,
        });
        return;
      }
      const uw = checkUnderwaterShipHit(world, p);
      if (uw) {
        const fx = clamp(uw.loc.along / uw.dims.loa + 0.5, 0, 1);
        const hitObj = {
          kind: 'UNDERWATER', t: world.t,
          side: p.side, attackerSide: p.side, attackerId: p.shipId,
          victimId: uw.ship.id, ship: uw.ship.id, shipSide: uw.ship.side, name: uw.ship.name,
          targetId: uw.ship.id, ammo: shell.ammo, caliberMM: shell.caliberMM, massKg: shell.massKg,
          impact: { x: ux, y: uy, z: uz, xFrac: fx, hitPart: 'UNDERWATER', obliquityDeg: 0, fallAngleDeg: fallAngle, velocityMps: Math.hypot(uvx, uvy, uvvz), localAlong: uw.loc.along, localAcross: uw.loc.across, localZ: uz },
          armorMM: 0, effectiveArmorMM: 0, penetrationMM: 9999,
          penetrated: true, bounced: false, shattered: false, detonated: true, dud: false,
          explosiveKg: shell.explosiveKg, tntEquivalentKg: shell.tntKg,
          detonation: { xFrac: fx, depthM: 3 + Math.abs(uz) },
          penetrates: true, energyMJ: 0.5 * shell.massKg * 400 * 400 / 1e6,
          tntKg: shell.tntKg, warheadKg: shell.explosiveKg,
          killerShipId: p.shipId, killerSide: p.side, killerName: (p.owner && p.owner.name) || '',
          targetShipId: uw.ship.id, targetShip: uw.ship, sideBias: Math.sign(uw.loc.across) || 1,
          depthM: 3 + Math.abs(uz),
          rangeM: p.shotRangeM || 0, timeOfFlightS: world.t - p.t0, isNearMiss: false,
        };
        world.events.emit('gun.hit', {
          t: world.t, ship: uw.ship.id, name: uw.ship.name, victimSide: uw.ship.side,
          killerSide: p.side, byShip: p.shipId, ammo: shell.ammo, caliberMM: shell.caliberMM,
          hitPart: 'UNDERWATER', penetrated: true, penetratedType: 'PENETRATE',
          armorMM: 0, penetrationMM: 9999, obliquityDeg: 0, xFrac: +fx.toFixed(3), detonated: true,
          dud: false, damageKind: 'UNDERWATER', hit: hitObj,
        });
        // 水下弹道命中同样是 gun.hit：攻击方命中数必须计入，否则「攻击方 stats.hits 之和 == gun.hit 数」不成立
        if (p.owner && p.owner.stats) p.owner.stats.hits = (p.owner.stats.hits || 0) + 1;
        try { damageApplyHit(world, hitObj); } catch (e) { /* ignore */ }
        const rec = _salvoRecord(world, p.salvoId); if (rec) rec.hits++;
        p.alive = false;
        return;
      }
    }
  }
  p.alive = false;
}

// 定时引信（照明弹/星弹）：空中爆开，提供战场照明
function timedBurst(world, p) {
  const shell = p.shell;
  const burstAlt = Math.max(150, p.z);
  if (!world.illuminationFlares) world.illuminationFlares = [];
  const dur = 45 + world.rng.range(0, 25);
  world.illuminationFlares.push({
    id: 'fl' + p.id, t: world.t, x: p.x, y: p.y, z: burstAlt,
    durationS: dur, brightness: shell.ammo === 'STAR' ? 1.0 : 0.75,
    radiusM: 1200, side: p.side,
  });
  if (world.illuminationFlares.length > 40) world.illuminationFlares.splice(0, world.illuminationFlares.length - 40);
  world.events.emit('env.change', {
    t: world.t, kind: shell.ammo === 'STAR' ? 'STAR_SHELL' : 'ILLUM', side: p.side,
    ship: p.shipId, x: +p.x.toFixed(0), y: +p.y.toFixed(0), z: +burstAlt.toFixed(0), durationS: +dur.toFixed(0),
  });
  p.alive = false;
  return true;
}

// ---------------------------------------------------------------------------
// updateProjectiles
// ---------------------------------------------------------------------------
export function updateProjectiles(world, dt) {
  if (!world.projectiles || world.projectiles.length === 0) { _ageSplashes(world, dt); return; }
  const sub = Math.max(1, Math.ceil(dt / 0.05));
  const h = dt / sub;
  const wind = {
    x: kn2mps(world.env.windKn || 0) * Math.sin(deg2rad((world.env.windDirDeg || 0) + 180)),
    y: kn2mps(world.env.windKn || 0) * Math.cos(deg2rad((world.env.windDirDeg || 0) + 180)),
  };
  for (const p of world.projectiles) {
    if (!p.alive) continue;
    for (let s = 0; s < sub && p.alive; s++) {
      if (p.fuseTimeS !== null && world.t + h - p.t0 >= p.fuseTimeS) { timedBurst(world, p); break; }
      const prev = { x: p.x, y: p.y, z: p.z };
      const shell = p.shell;
      const der = (st) => {
        const a = accelOf(st[2], st[3], st[4], st[5], shell, wind);
        return [st[3], st[4], st[5], a.ax, a.ay, a.az];
      };
      const st = [p.x, p.y, p.z, p.vx, p.vy, p.vz];
      const k1 = der(st);
      const s2 = st.map((v, i) => v + 0.5 * h * k1[i]);
      const k2 = der(s2);
      const s3 = st.map((v, i) => v + 0.5 * h * k2[i]);
      const k3 = der(s3);
      const s4 = st.map((v, i) => v + h * k3[i]);
      const k4 = der(s4);
      for (let i = 0; i < 6; i++) st[i] += h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      p.x = st[0]; p.y = st[1]; p.z = st[2]; p.vx = st[3]; p.vy = st[4]; p.vz = st[5];
      if (p.trail && p.trail.length < 160) p.trail.push({ t: world.t, x: p.x, y: p.y, z: p.z });
      if (!p.underwater) {
        const hit = findShipHit(world, prev, { x: p.x, y: p.y, z: p.z }, p.owner);
        if (hit) { applyShipHit(world, p, hit, prev, { x: p.x, y: p.y, z: p.z }); break; }
        // —— 陆地弹着：弹丸落入陆地（岸线/岛屿）→ 终止弹道，不调用 applyShipHit、不计命中 ——
        if (p.z <= LAND_CHECK_ALT_M) {
          const overLand = landAt(world.land, p.x, p.y);
          const surfZ = overLand ? landSurfaceM(world.land, p.x, p.y) : 0;
          if (overLand && p.z <= surfZ) {
            terrainImpact(world, p, p.x, p.y, surfZ);
            break;
          }
          if (p.z <= 0) {
            // 步进可能跨过岸线：用 z=0 插值落点再判一次陆地，避免"落在岛尖的水柱"
            const f = prev.z > 0 ? prev.z / Math.max(1e-6, prev.z - p.z) : 0;
            const ix = prev.x + (p.x - prev.x) * f, iy = prev.y + (p.y - prev.y) * f;
            if (landAt(world.land, ix, iy)) {
              terrainImpact(world, p, ix, iy, Math.max(0, landSurfaceM(world.land, ix, iy)));
              break;
            }
            p.underwater = true;
            waterImpact(world, p, prev);
            break;
          }
        }
      }
      if (p.t0 && world.t - p.t0 > 260) { p.alive = false; break; }
    }
  }
  world.projectiles = world.projectiles.filter((p) => p.alive);
  _ageSplashes(world, dt);
}

function _ageSplashes(world, dt) {
  if (world.splashes) {
    for (const s of world.splashes) s.ageS = world.t - s.t;
    const kept = world.splashes.filter((s) => s.ageS < 120);
    if (kept.length !== world.splashes.length) world.splashes = kept;
  }
  if (world.illuminationFlares) world.illuminationFlares = world.illuminationFlares.filter((f) => world.t - f.t < f.durationS);
  if (world.salvoes) {
    for (const [id, rec] of world.salvoes) {
      rec.ageS = world.t - rec.tFire;
      if (rec.ageS > 300) world.salvoes.delete(id);
    }
  }
}

// 供 UI/AAR 使用的数值查询
export function shellReport(shell, rangeM) {
  const s = solutionForRange(shell, rangeM);
  const p = penetrationAtNormal(shell.massKg, shell.caliberMM, s.vStrikeMps, 1.0);
  return {
    ammo: shell.ammo, caliberMM: shell.caliberMM, massKg: +shell.massKg.toFixed(1),
    mvMps: +shell.mvMps.toFixed(0), rangeM: Math.round(rangeM),
    elevDeg: +s.elevDeg.toFixed(2), tofS: +s.tofS.toFixed(1), fallAngleDeg: +s.fallAngleDeg.toFixed(1),
    vStrikeMps: +s.vStrikeMps.toFixed(0), normalPenMM: +p.toFixed(0),
  };
}
