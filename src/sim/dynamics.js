// 【T1 所有者】舰体运动学：主机响应、舵效与回转、耐波性、损伤/进水耦合。
//
// 物理模型与依据
// 1) 主机：轴功率 P 与航速的 Admiralty 关系 v ∝ P^(1/3)；阻力 R = C·v²，取 C = η·P_max/V_max³，
//    使满功率/满速时推力与阻力平衡。准推进系数 η≈0.58（1940 年代蒸汽轮机+螺旋桨典型值）。
//    纵向运动方程 m·dv/dt = T - R，T = η·P_avail/max(v, 0.35·V_max)（低速用系柱推力上限近似），
//    虚质量取 1.08×排水量（水面舰船纵向附连水约 5~10%）。
// 2) 锅炉/主轴：按子系统 health×powerFrac 求和，机舱进水/火灾按舱室进水比例折减功率；
//    蒸汽动力升汽慢、降汽快 → 可用功率份额带速率限制（升 0.012/s、降 0.05/s）。
// 3) 舵：舵角速率取数据 rudderRate_deg_s（2~4°/s，蒸汽/液压舵机）；舵机损毁→卡死在某个角度。
// 4) 回转：由数据 turnRadiusAt20kn_m（20 kn 满舵）得稳态回转率 ω20 = V20/R20；
//    Nomoto 一阶模型 K ∝ V（舵升力 ∝ V²，向心加速度 ∝ V·ω）→ ω = K·δ，R = V/ω 与航速无关。
//    舵效低速丧失用 a(V)=V²/(V²+V_ref²)（V_ref≈1.6 kn）刻画；回转首阶惯性 T ≈ 0.6·L/V。
// 5) 首浪失速：Froude 附加阻力经验式 R_add = 0.64·ρ·g·B²·h²/L（假定波高 h、波长≈舰长），
//    乘 λ/L 匹配因子与浪向因子（顶浪最不利、顺浪略有利）。
// 6) 横摇：固有周期 T = 2π·k_x/√(g·GM)，k_x≈0.40·B（含附连水惯性半径）；
//    受迫响应用单自由度幅频特性 RAO = 1/√((1-r²)²+(2ζr)²)，r=遭遇频率/固有频率，ζ≈0.10。
//    遭遇频率 ω_e = ω·(1+(V/c)cos μ)（μ 为浪来向与舰艏夹角；顶浪 ω_e 增大，顺浪减小）。
//    波面最大斜率 π·H/λ，限制 H/λ ≤ 1/7（陡度极限）。
// 7) 纵摇：固有周期经验式 T_p ≈ 0.7·√L，阻尼比 ζ≈0.15。
// 8) 回转外倾：离心力在重心作用、复原力矩在稳心，tanφ = (V·ω/g)·(KG-d/2)/GM。
// 9) 进水/纵倾/横倾耦合：湿面积增加、机舱淹水降功率、操纵性下降、自由液面/横倾产生偏航力矩。
import { clamp, normDeg, normDeg180, kn2mps, mps2kn, deg2rad, rad2deg } from '../core/util.js';

const SHP_W = 745.7;        // 1 轴马力 = 745.7 W（英制 shp）
const RHO_W = 1025;         // 海水密度 kg/m³
const G = 9.80665;
const ETA_P = 0.58;         // 准推进系数
const ADDED_MASS = 1.08;    // 纵向附连水系数
const RUDDER_REF_MPS = 0.8; // 舵效参考速度 ~1.6 kn
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- 动力系统
// 可用功率份额：锅炉产汽 × 主轴传递 × 机舱完整性 × 电气
export function availablePowerFrac(ship) {
  let boiler = 0, boilerCap = 0, shaft = 0, shaftCap = 0;
  for (const s of ship.subsystems || []) {
    const pf = s.powerFrac || 0;
    if (s.kind === 'BOILER') { boilerCap += pf; boiler += clamp(s.health || 0, 0, 1) * pf; }
    else if (s.kind === 'SHAFT') { shaftCap += pf; shaft += clamp(s.health || 0, 0, 1) * pf; }
  }
  let frac = (boilerCap > 0 ? boiler / boilerCap : 1) * (shaftCap > 0 ? shaft / shaftCap : 1);
  // 机舱（锅炉舱/轮机舱）进水会淹灭炉火、火灾会烧毁管路
  let n = 0, flooded = 0, burning = 0;
  for (const c of ship.compartments || []) {
    if (!c.isMachinery) continue;
    n++;
    flooded += c.volume_m3 > 0 ? clamp(c.flood_m3 / c.volume_m3, 0, 1) : 0;
    burning += clamp(c.fire || 0, 0, 1);
  }
  if (n > 0) {
    frac *= clamp(1 - 0.85 * (flooded / n), 0, 1);
    frac *= clamp(1 - 0.55 * (burning / n), 0, 1);
  }
  // 电气降级（燃油泵/鼓风机/舵机供电）
  frac *= clamp(0.55 + 0.45 * (ship.electricalFrac === undefined ? 1 : ship.electricalFrac), 0.30, 1);
  return clamp(frac, 0, 1);
}

// 损伤/进水后的可用最大航速（由 v ∝ P^(1/3) 推得）
export function speedCapKnFor(ship, powerFrac) {
  const vMax = (ship.data && ship.data.speedMax_kn) || 30;
  const pf = powerFrac === undefined ? availablePowerFrac(ship) : powerFrac;
  let cap = vMax * Math.cbrt(clamp(pf, 0, 1));
  const floodFrac = clamp((ship.floodedM3 || 0) / Math.max(1, ship.reserveBuoyancyM3 || 1), 0, 2);
  cap *= clamp(1 - 0.22 * floodFrac, 0.25, 1);                       // 湿面积/排水量增加
  cap *= clamp(1 - 0.008 * Math.abs(ship.trim || 0), 0.60, 1);       // 纵倾增加阻力
  cap *= clamp(1 - 0.006 * Math.abs(ship.list || 0), 0.60, 1);       // 横倾不对称阻力
  if (ship.damageSpeedCapKn !== undefined) cap = Math.min(cap, ship.damageSpeedCapKn);
  return clamp(cap, 0, vMax);
}

// 横摇固有周期（s）
export function naturalRollPeriodS(ship) {
  const D = ship.data || {};
  const B = D.beam_m || 10;
  const GM = Math.max(0.15, ship.effectiveGMm || ship.gm0M || D.gm_m || 1.5);
  const kx = 0.40 * B;                                              // 惯性半径 ≈0.40B（含附连水）
  return 2 * Math.PI * kx / Math.sqrt(G * GM);
}

// 稳态回转角速度（deg/s）
export function steadyTurnRateDegS(ship, speedKn, rudderDeg) {
  const D = ship.data || {};
  const rudderMax = D.rudderAngleMax_deg || 35;
  const r20 = Math.max(60, D.turnRadiusAt20kn_m || 500);
  const v = kn2mps(Math.max(0, speedKn));
  const v20 = kn2mps(20);
  if (v <= 0.05) return 0;
  const omega20 = v20 / r20;                                        // rad/s @20kn 满舵
  const K20 = omega20 / deg2rad(rudderMax);
  const a = (v * v) / (v * v + RUDDER_REF_MPS * RUDDER_REF_MPS);    // 低速舵效
  const floodFrac = clamp((ship.floodedM3 || 0) / Math.max(1, ship.reserveBuoyancyM3 || 1), 0, 2);
  const maneuver = clamp(1 - 0.30 * floodFrac - 0.006 * Math.abs(ship.list || 0), 0.25, 1);
  return rad2deg(K20 * (v / v20) * a * maneuver * deg2rad(clamp(rudderDeg, -rudderMax, rudderMax)));
}

// 波浪附加阻力（N）：Froude 经验式 + 波长匹配 + 浪向因子（0°=顶浪）
export function addedResistanceN(ship, env, relFromBowDeg) {
  const D = ship.data || {};
  const B = D.beam_m || 10, L = D.loa_m || 100;
  const H = Math.max(0, (env && env.swellHeightM) || 0);
  if (H <= 0.05) return 0;
  const T = (env && env.wavePeriodS) || 3.6 * Math.sqrt(Math.max(0.2, H));
  const lambda = G * T * T / (2 * Math.PI);                          // 深水波长
  let R = 0.64 * RHO_W * G * B * B * H * H / L;                      // Froude 首浪附加阻力
  R *= clamp(1.5 * lambda / L, 0.20, 1.20);                          // λ≈L 时最剧烈
  const mu = Math.abs(normDeg180(relFromBowDeg));
  const c = Math.cos(deg2rad(mu));
  let f;
  if (mu <= 90) f = 0.15 + 0.85 * c * c;                             // 顶浪 1.0 → 横浪 0.15
  else { const t = (mu - 90) / 90; f = 0.15 - 0.30 * t * t; }        // 顺浪略有利，最低 -0.15（偏航/横甩损失限制实际增益）
  R *= f;
  R *= 1 + 0.8 * clamp(ship.freeboardLoss || 0, 0, 1);               // 干舷损失 → 上浪增阻
  return R;
}

// 把 env 暂存的事件转发到 world.events（world.js 暂未把 EventBus 注入 Environment）
function drainEnvEvents(env, world) {
  const q = env && env.pendingEvents;
  if (!q || !q.length) return;
  for (const e of q.splice(0, q.length)) {
    world.events.emit(e.type, Object.assign({ t: world.t }, e.data || {}));
  }
}

export function updateKinematics(ship, world, dt) {
  const env = world.env || {};
  const D = ship.data || {};
  const vMax = D.speedMax_kn || 30;
  const rudderMax = D.rudderAngleMax_deg || 35;
  const rudderRate = D.rudderRate_deg_s || 3;

  // ---- 0. 每步一次：烟幕源同步 + env 事件转发 ----
  if (world._t1EnvHooked !== world.t) {
    world._t1EnvHooked = world.t;
    if (typeof env.stepSmokeSources === 'function') env.stepSmokeSources(world);
    else if (typeof env.stepSmoke === 'function') env.stepSmoke(0, world);
    drainEnvEvents(env, world);
  }

  // ---- 1. 舵机 ----
  const steerSub = (ship.subsystems || []).find((s) => s.kind === 'STEERING_GEAR');
  const steeringDead = !!(steerSub && steerSub.destroyed);
  let rudderWanted;
  if (steeringDead) {
    if (steerSub.jamAngle === null || steerSub.jamAngle === undefined) {
      // 真实海战中舵机损毁多为卡死在接近满舵的位置
      steerSub.jamAngle = world.rng.chance(0.65)
        ? (world.rng.chance(0.5) ? 1 : -1) * world.rng.range(rudderMax * 0.55, rudderMax)
        : ship.rudder;
      world.events.emit('ship.course', { t: world.t, ship: ship.id, rudderJamDeg: +steerSub.jamAngle.toFixed(1), headingDeg: +ship.heading.toFixed(1) });
    }
    rudderWanted = clamp(steerSub.jamAngle, -rudderMax, rudderMax);
    ship.rudder = rudderWanted;                                        // 卡死：不能动
  } else {
    if (ship.commanded.rudder !== null && ship.commanded.rudder !== undefined) {
      rudderWanted = clamp(ship.commanded.rudder, -rudderMax, rudderMax);
    } else {
      // 自动操舵：航向误差比例项 + 回转率阻尼项（老式舵手的"回舵"经验）
      const err = normDeg180(ship.commanded.heading - ship.heading);
      rudderWanted = clamp(0.9 * err - 1.6 * (ship.turnRate || 0), -rudderMax, rudderMax);
      if (Math.abs(err) < 1.5 && Math.abs(ship.turnRate || 0) < 0.05) rudderWanted = 0;
    }
    const dR = clamp(rudderWanted - ship.rudder, -rudderRate * dt, rudderRate * dt);
    ship.rudder = clamp(ship.rudder + dR, -rudderMax, rudderMax);
  }

  // ---- 2. 回转（Nomoto 一阶）----
  const vKn = Math.max(0, ship.speed);
  const vMps = kn2mps(vKn);
  const omegaCmd = clamp(steadyTurnRateDegS(ship, vKn, ship.rudder), -4.2, 4.2);
  const Tn = Math.max(3, 0.6 * (D.loa_m || 100) / Math.max(1, vMps));
  ship.turnRate = (ship.turnRate || 0) + (omegaCmd - (ship.turnRate || 0)) * clamp(dt / Tn, 0, 1);
  ship.heading = normDeg(ship.heading + ship.turnRate * dt);

  // ---- 3. 主机 / 纵向运动 ----
  const mach = availablePowerFrac(ship);
  ship.powerFracAvailable = mach;
  const cap = speedCapKnFor(ship, mach);
  ship.speedCapKn = cap;
  ship.maxSpeedKn = cap;
  const orderedKn = clamp(ship.commanded.speed, 0, vMax);
  const powerOrdered = clamp(Math.pow(orderedKn / vMax, 3), 0, 1);     // v ∝ P^(1/3) 反解
  const pPrev = ship._powerFrac === undefined ? 0 : ship._powerFrac;
  const rampRate = powerOrdered > pPrev ? 0.012 : 0.05;                // 升汽慢、降汽快
  ship._powerFrac = clamp(pPrev + clamp(powerOrdered - pPrev, -rampRate * dt, rampRate * dt), 0, 1);
  const pMaxW = (D.power_shp || 0) * SHP_W;
  const pAvailW = pMaxW * ship._powerFrac * mach;
  const vMaxMps = kn2mps(vMax);
  const C = vMaxMps > 0 ? ETA_P * pMaxW / Math.pow(vMaxMps, 3) : 0;    // R = C·v²
  const floodFrac = clamp((ship.floodedM3 || 0) / Math.max(1, ship.reserveBuoyancyM3 || 1), 0, 2);
  let R = C * vMps * vMps;
  R += addedResistanceN(ship, env, (env.waveFromDeg || 0) - ship.heading);
  const sinR = Math.sin(deg2rad(ship.rudder));
  R *= 1 + 1.05 * sinR * sinR;                                        // 满舵时阻力增加约 1 倍 → 掉速 25~35%
  R *= 1 + 0.8 * floodFrac + 0.05 * Math.abs(ship.trim || 0);         // 进水/纵倾增阻
  const T = ETA_P * pAvailW / Math.max(0.35 * vMaxMps, vMps);         // 系柱推力上限近似
  const mass = (ship.displacement_t || 2000) * 1000 * ADDED_MASS;
  let newV = ship.speed + mps2kn((T - R) / mass) * dt;
  if (newV > cap) newV = Math.max(cap, ship.speed - 0.4 * dt);        // 损伤后不能超速，只能缓慢衰减
  ship.speed = clamp(newV, 0, vMax);

  // ---- 4. 运动（含洋流漂移）----
  const cur = typeof env.currentAt === 'function' ? env.currentAt(ship.pos.x, ship.pos.y) : null;
  const vx = Math.sin(deg2rad(ship.heading)) * vMps + (cur ? cur.vx : 0);
  const vy = Math.cos(deg2rad(ship.heading)) * vMps + (cur ? cur.vy : 0);
  ship.pos.x += vx * dt;
  ship.pos.y += vy * dt;

  // ---- 5. 耐波性：横摇/纵摇 ----
  const H = Math.max(0, env.swellHeightM || 0);
  const Tw = env.wavePeriodS || 3.6 * Math.sqrt(Math.max(0.2, H));
  const lambda = Math.max(10, G * Tw * Tw / (2 * Math.PI));
  const alpha = Math.min(Math.PI * H / lambda, Math.PI / 7);          // 波面最大斜率，H/λ≤1/7
  const mu = Math.abs(normDeg180((env.waveFromDeg || 0) - ship.heading));
  const cWave = G * Tw / (2 * Math.PI);
  const omega = 2 * Math.PI / Tw;
  const omE = clamp(omega * (1 + (vMps / cWave) * Math.cos(deg2rad(mu))), 0.12 * omega, 4 * omega);
  const beamFactor = Math.abs(Math.sin(deg2rad(mu)));                 // 横浪激励最强
  const headFactor = Math.abs(Math.cos(deg2rad(mu)));                 // 顶/顺浪激励纵摇
  const omegaN = 2 * Math.PI / naturalRollPeriodS(ship);
  const r = omE / Math.max(1e-6, omegaN);
  const zetaRoll = 0.10;                                              // 舭龙骨/减摇水舱式阻尼
  let rao = Math.min(1 / Math.sqrt(Math.pow(1 - r * r, 2) + Math.pow(2 * zetaRoll * r, 2)), 1 / (2 * zetaRoll));
  const rollTarget = Math.min(alpha * beamFactor * rao, deg2rad(32)); // 大横摇 GZ 曲线变软，限幅
  ship._rollAmp = ship._rollAmp === undefined ? rollTarget : ship._rollAmp + (rollTarget - ship._rollAmp) * clamp(dt / 25, 0, 1);
  const Tp = 0.7 * Math.sqrt(D.loa_m || 100);                         // 纵摇固有周期经验式
  const rp = omE / (2 * Math.PI / Tp);
  const zetaPitch = 0.15;
  const raoP = Math.min(1 / Math.sqrt(Math.pow(1 - rp * rp, 2) + Math.pow(2 * zetaPitch * rp, 2)), 1 / (2 * zetaPitch));
  const pitchTarget = Math.min(alpha * headFactor * raoP * 0.6, deg2rad(14));
  ship._pitchAmp = ship._pitchAmp === undefined ? pitchTarget : ship._pitchAmp + (pitchTarget - ship._pitchAmp) * clamp(dt / 20, 0, 1);
  // 波场相位随舰位与时间演化（确定性，回放可复现）
  const k = 2 * Math.PI / lambda;
  // 相位只由舰位、波向与时间决定（不依赖全局 uid），保证同种子回放完全一致
  const psi = k * (ship.pos.x * Math.sin(deg2rad((env.waveFromDeg || 0) + 180)) + ship.pos.y * Math.cos(deg2rad((env.waveFromDeg || 0) + 180))) - omE * world.t;
  // 回转外倾：tanφ = (V·ω/g)·(KG-d/2)/GM
  const kg = D.kg_m || 0.55 * (ship.hullDepthM || 10);
  const lever = Math.max(0.5, kg - (ship.draftM || 5) / 2);
  const gm = Math.max(0.2, ship.effectiveGMm || ship.gm0M || D.gm_m || 1.5);
  const heelMag = Math.atan((vMps * Math.abs(ship.turnRate || 0) * DEG / G) * clamp(lever / gm, 0.4, 3.0));
  const heelTarget = -Math.sign(ship.turnRate || 0) * heelMag;
  ship._turnHeel = ship._turnHeel === undefined ? heelTarget : ship._turnHeel + (heelTarget - ship._turnHeel) * clamp(dt / 8, 0, 1);
  ship.roll = rad2deg(ship._rollAmp * Math.sin(psi)) + rad2deg(ship._turnHeel);
  ship.pitch = rad2deg(ship._pitchAmp * Math.sin(psi + 0.6)) + 0.05 * (ship.trim || 0);

  // ---- 6. 事件 ----
  if (ship._lastEmitSpeedKn === undefined) ship._lastEmitSpeedKn = ship.speed;
  if (Math.abs(ship.speed - ship._lastEmitSpeedKn) >= 1.0) {
    ship._lastEmitSpeedKn = ship.speed;
    world.events.emit('ship.speed', {
      t: world.t, ship: ship.id, speedKn: +ship.speed.toFixed(2),
      capKn: +ship.speedCapKn.toFixed(1), powerFrac: +ship._powerFrac.toFixed(3), machinery: +mach.toFixed(3),
    });
  }
  if (ship._lastEmitHeading === undefined) ship._lastEmitHeading = ship.heading;
  if (Math.abs(normDeg180(ship.heading - ship._lastEmitHeading)) >= 4) {
    ship._lastEmitHeading = ship.heading;
    world.events.emit('ship.course', {
      t: world.t, ship: ship.id, headingDeg: +ship.heading.toFixed(1),
      rudderDeg: +ship.rudder.toFixed(1), turnRateDegS: +ship.turnRate.toFixed(3),
    });
  }
}
