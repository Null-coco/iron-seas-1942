// sensors.js — 【T2】1940 年代传感器：雷达 / 声呐 / 水听器，以及"观测→航迹"入口。
//
// ── 物理模型与依据（真实感 > 性能 > 画面）────────────────────────────────────
// 1) 雷达方程（双程）：  Pr = Pt·G²·λ²·σ / ((4π)³·R⁴) · F⁴
//    F 为海面多径传播因子：F² = 1 + ρ² − 2ρ·cosφ，φ = 4π·h_r·h_t/(λ·R)（反射波半波损失）。
//    海面粗糙度按 Rayleigh 参数降低镜面反射：ρ = exp(−2(2π·σ_h·sinψ/λ)²)。
//    舰船有 0~桅顶的垂直尺度，F⁴ 沿目标高度取 5 点平均，避免单点相消造成假零点。
// 2) 标定锚点：数据表 ships_*.json 给出每型雷达对战列舰的标称发现距离 detectBB_nm
//    （1942 年实装指标，例：日本 22 号电探 13 nmi、13 号电探 18 nmi）。
//    以 "Pr(R_ref) = 显示门限" 为锚，其他目标按 R ∝ (σ·F⁴)^(1/4) 缩放。
//    这样做是因为 1940 年代雷达的实际作用距离由荧光屏/操作员门限、海杂波与地平线决定，
//    而不是热噪声极限（理想方程会把 1200 m² 的驱逐舰算到 100 km 以外）。
// 3) 地平线：d = √(2·k·Re·h)，标准大气 k=4/3 → d[km] = 4.12·√(h[m])；
//    收发两端相加 d = 4.12(√h_r + √h_t) km。契约中 "4.12·√h nmi" 为单位笔误，
//    4.12 对应 km（nmi 形式是 2.23·√h）；测试同时给出两种单位。
// 4) 海杂波：σ0 经验式，基准 −35 dB @ 海况4、擦地角 1°、S 波段；
//    海况每升一级 +2 dB；随擦地角按 sinψ^0.5；随频率 +5·log10(f/3GHz)。
//    杂波单元面积 = θ_az·ΔR·R，ΔR = c·τ/2（脉冲宽度决定距离分辨）。
//    目标回波须高出杂波尖峰 k 倍（k≈3~6，海尖峰峰值因子）才能稳定发现。
// 5) 扫描周期：天线转速决定重访；受损后转速下降。每扫描一次按 Swerling-I 起伏目标的
//    Logistic 近似给出发现概率 Pd（检测余量 0 dB 时 Pd=0.5，±6 dB 完成过渡）。
// 6) 声呐：主动 SL−2TL+TS−(NL−DI) ≥ DT；TL = 20log10R + α·R（Thorp 吸收，20 kHz≈4 dB/km）；
//    被动 SL−TL−(NL−DI) ≥ DT；自噪随航速上升，空化后额外 +6~12 dB；温跃层附加损失。
//    主/被动距离用数据表 range_nm（对潜参考目标）标定，再按 TS/NL 差值缩放。
// 7) 箔条（window）：云团 RCS 计入同一分辨单元的杂波，并与目标争夺显示；还会产生假回波。
//    噪声干扰：雷达方程中按 J/N 抬高检测门限（sensor.jammed / env.radarJamDb / env.jammers）。
// 8) 随机数只走 world.rng；所有可观测状态变化 emit 事件（sensor.detect/lose 由 tracks 发）。
//
// 导出（契约签名不变，另有辅助导出供 T4/测试使用）：
//   updateSensors(ship, world, dt)
//   radarDetectRange(ship, radar, target, env)   // 米
//   radarHorizonM(hRadarM, hTargetM), radarHorizonNm(...), RCS_TABLE, estimateRCS,
//   deployChaff(world, ship, opts), updateChaffClouds(env, t, dt), radiatedNoiseDb(target)
import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, aspectAngle, deg2rad, rad2deg } from '../core/util.js';
import { visualObservation, updateSmokeClouds, deployChaff } from './vision.js';
import { ownFleetKnownRangeM, ownContactUncertainAt } from './tracks.js';
// 箔条投放由 vision.js 实现（契约 CHAFF 命令的落点），此处再导出以保持 T2 旧调用兼容
export { deployChaff };

const NMI_M = 1852;
const C_MPS = 299792458;
const DEG = Math.PI / 180;

// 标称"对 BB 发现距离"的参考几何：目标为战列舰，取上层建筑有效散射高度 16 m（约 0.4×40 m 桅高）。
const REF_BB_HEIGHT_M = 16;
const BEYOND_HORIZON_LOSS_DB_PER_KM = 0.8;

// ════════════════════════════════════════════════════════════════════════════
// 0. 地平线（雷达与光学共用 4/3 地球折射模型）
// ════════════════════════════════════════════════════════════════════════════
export function radarHorizonM(hRadarM, hTargetM = 0) {
  const hr = Math.max(0, Number(hRadarM) || 0);
  const ht = Math.max(0, Number(hTargetM) || 0);
  // d = √(2·(4/3)·Re·h) → 4122·√h [m]，即 4.12·√h km
  return 4122 * (Math.sqrt(hr) + Math.sqrt(ht));
}
export function radarHorizonNm(hRadarM, hTargetM = 0) {
  return radarHorizonM(hRadarM, hTargetM) / NMI_M;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 目标雷达截面积 RCS（m²）与几何
// ════════════════════════════════════════════════════════════════════════════
// 量级依据：X 波段舷侧，驱逐舰 ~10³ m²、重巡 ~4×10³ m²、战列舰 ~2×10⁴ m²。
// 数值最终以 detectBB_nm 为锚标定，因此重要的是相对比例而非绝对值。
export const RCS_TABLE = Object.freeze({
  SS: 150, DD: 1200, CL: 2800, CA: 4200, BC: 8000, BB: 18000, CV: 22000,
});

export function estimateRCS(target, aspectDeg) {
  const base = RCS_TABLE[target && target.type] || 1200;
  const a = ((Number(aspectDeg) || 0) % 360 + 360) % 360;
  const s = Math.sin(a * DEG);
  // 舷侧（90°）最大；艏艉（0°）约 −5 dB（0.30 倍）——舰体侧面与上层建筑的大平板回波
  const aspectFactor = 0.30 + 0.70 * s * s;
  const loa = (target && target.data && target.data.loa_m) || 110;
  const sizeFactor = clamp(Math.sqrt(loa / 110), 0.6, 1.35);
  return base * aspectFactor * sizeFactor;
}

// 雷达"看到"的目标有效高度：上层建筑/桅杆的反回波重心，约为桅高的 0.4。
export function targetRadarHeightM(target) {
  const mast = (target && target.data && target.data.mastHeight_m) || (target && target.silhouetteHeightM) || 18;
  return clamp(0.4 * mast, 3, 26);
}

function antennaHeightM(ship, spec) {
  const mast = (ship && ship.data && ship.data.mastHeight_m) || (ship && ship.silhouetteHeightM) || 20;
  return clamp(mast * (spec.mountHeightFrac || 0.92), 3, 60);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 雷达参数归一化（数据表字段缺失时的合理回退）
// ════════════════════════════════════════════════════════════════════════════
function radarData(radar) {
  if (!radar) return {};
  return radar.data && typeof radar.data === 'object' ? radar.data : radar;
}

export function radarSpecOf(radar) {
  if (radar && radar._t2spec) return radar._t2spec;
  const d = radarData(radar);
  const wl = clamp((d.wavelength_cm || (d.band === 'VHF' ? 150 : 10)) / 100, 0.02, 3.0);
  const gainDb = d.gain_dBi !== undefined ? d.gain_dBi : (wl > 0.5 ? 18 : 26);
  const G = Math.pow(10, gainDb / 10);
  const peakKW = d.peakKW !== undefined ? d.peakKW : 10;
  const pulseUs = d.pulseWidth_us || (wl > 0.5 ? 8 : 2);
  const rangeResM = C_MPS * pulseUs * 1e-6 / 2;
  const apertureM2 = G * wl * wl / (4 * Math.PI);
  const diamM = Math.sqrt(4 * apertureM2 / Math.PI);
  // θ3dB ≈ 1.02·λ/D（均匀照射圆口径），限幅到 0.6°~45°
  const beamRad = clamp(1.02 * wl / Math.max(0.15, diamM), 0.6 * DEG, 45 * DEG);
  // 标称对 BB 发现距离：数据缺失时按雷达方程相对 22 号电探（2 kW / 30 dBi / 10 cm / 13 nmi）缩放
  const refNm = d.detectBB_nm || d.detectBB_nmi ||
    13 * Math.pow((peakKW / 2) * Math.pow(G / 1000, 2) * Math.pow(wl / 0.1, 2), 0.25);
  const spec = {
    name: d.nameZh || (radar && radar.label) || d.id || 'radar',
    wavelengthM: wl,
    gainDb, gain: G, peakKW, pulseUs, rangeResM,
    beamRad,
    beamDeg: rad2deg(beamRad),
    refRangeM: refNm * NMI_M,
    refNm,
    scanPeriodS: d.scanPeriod_s || (wl > 0.5 ? 8 : 5),
    sectorDeg: d.searchSector_deg || 360,
    hasBearing: d.hasBearing !== false,
    hasRange: d.hasRange !== false,
    // 数据里没有天线口径时，按波段给一个史实量级的口径估计（10cm≈1.8m、50cm≈2.4m、80cm≈3.0m）
    bearingAccDeg: d.bearingAcc_deg !== undefined ? d.bearingAcc_deg
      : clamp(rad2deg(clamp(1.02 * wl / (wl <= 0.15 ? 1.8 : (wl <= 0.6 ? 2.4 : 3.0)), 0.6 * DEG, 45 * DEG)) * 0.28, 0.3, 8),
    // 1940 年代脉冲雷达测距精度 ≈ c·τ/2 的一小部分 + 显示器刻度误差，典型 25–75 m
    rangeAccM: d.rangeAcc_m !== undefined ? d.rangeAcc_m : clamp(0.15 * rangeResM, 25, 80),
    mountHeightFrac: d.mountHeightFrac || 0.92,
    minRangeM: d.minRange_m || Math.max(300, rangeResM * 1.2),
    // 硬上限：任何情况下不超过标称探测距离的 1.35 倍（否则会出现 50km 上的"接触"）
    maxRangeM: d.maxRange_m || Math.min(400000, refNm * NMI_M * 1.35),
    bandGHz: 0.3 / wl,
    year: d.year || 1942,
  };
  if (radar && typeof radar === 'object') radar._t2spec = spec;
  return spec;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. 多径 F⁴：双程海面反射干涉，按目标垂直尺度平均
// ════════════════════════════════════════════════════════════════════════════
function multipathF4(spec, hRadar, hTarget, R, env) {
  const wl = spec.wavelengthM;
  const r = Math.max(50, R);
  const rough = (env && env.swellHeightM) ? env.swellHeightM : 1.0;
  const grazing = Math.atan2(Math.max(2, hRadar + hTarget), r);
  // Rayleigh 粗糙度：σ_h 取有效浪高的一半
  const roughPhase = 2 * Math.PI * (rough * 0.5) * Math.sin(grazing) / wl;
  const rho = Math.exp(-2 * roughPhase * roughPhase);
  let sum = 0;
  const N = 5;
  for (let i = 1; i <= N; i++) {
    const h = Math.max(0.5, hTarget * i / N);
    const phase = 2 * Math.PI * (2 * hRadar * h) / (wl * r);
    const F2 = Math.max(0.02, 1 + rho * rho - 2 * rho * Math.cos(phase));
    sum += F2 * F2;
  }
  return clamp(sum / N, 0.02, 16);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. 海杂波与箔条
// ════════════════════════════════════════════════════════════════════════════
function seaStateOf(env) {
  if (!env) return 4;
  if (env.seaState !== undefined) return clamp(env.seaState, 0, 9);
  return 4;
}

function clutterSigma0(env, spec, grazing) {
  const ss = seaStateOf(env);
  const fGHz = 0.3 / spec.wavelengthM;
  const sinPsi = clamp(Math.sin(grazing), 1e-4, 0.6);
  const gFactor = clamp(sinPsi / Math.sin(1 * DEG), 0.05, 30);
  // 基准 −35 dB @ SS4、ψ=1°、3 GHz
  const db = -35 + 2.0 * (ss - 4)
    + 5 * Math.log10(clamp(fGHz, 0.03, 12) / 3)
    + 5 * Math.log10(gFactor);
  return Math.pow(10, db / 10);
}

function clutterCrestFactor(env) {
  // 海尖峰峰值/均值：海况越高越尖（K 分布形状参数下降）
  return 3.0 + 0.5 * Math.max(0, seaStateOf(env) - 4);
}

function clutterCellPerM(spec) {
  return spec.beamRad * Math.max(spec.rangeResM, 30);
}

function chaffRcsOnLine(env, ship, target, spec) {
  const clouds = env && Array.isArray(env.chaffClouds) ? env.chaffClouds : null;
  if (!clouds || !clouds.length || !ship || !target) return 0;
  const ax = ship.pos.x, ay = ship.pos.y;
  const dx = target.pos.x - ax, dy = target.pos.y - ay;
  const L2 = dx * dx + dy * dy || 1;
  const targetR = Math.sqrt(L2);
  let extra = 0;
  for (const c of clouds) {
    if (!c) continue;
    const tt = clamp(((c.x - ax) * dx + (c.y - ay) * dy) / L2, 0, 1);
    const px = ax + tt * dx, py = ay + tt * dy;
    const d = Math.hypot(c.x - px, c.y - py);
    const beamCross = Math.max(120, spec.beamRad * Math.hypot(px - ax, py - ay));
    if (d > (c.r || 300) + beamCross) continue;
    const cloudR = Math.hypot(px - ax, py - ay);
    const cell = Math.max(200, spec.rangeResM * 1.5);
    const rangeOverlap = clamp(1 - Math.abs(cloudR - targetR) / (3 * cell), 0, 1);
    const lateral = clamp(1 - d / Math.max(1, (c.r || 300) + beamCross), 0.1, 1);
    const density = c.density !== undefined ? c.density : 1;
    extra += (c.rcsM2 || 2000) * density * rangeOverlap * lateral;
  }
  return extra;
}

// 箔条云投放：见 vision.js 的 deployChaff（此处只负责逐帧漂移/衰减）
export function updateChaffClouds(env, t, dt) {
  if (!env || !Array.isArray(env.chaffClouds) || !env.chaffClouds.length) return;
  const keep = [];
  for (const c of env.chaffClouds) {
    const age = Math.max(0, t - (c.t0 || 0));
    c.x += (c.vx || 0) * dt;
    c.y += (c.vy || 0) * dt;
    c.r += 6 * dt;
    c.density = Math.exp(-age / Math.max(40, c.decayS || 420));
    if (c.density > 0.02 && age < 1200) keep.push(c);
  }
  env.chaffClouds = keep;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. 噪声干扰
// ════════════════════════════════════════════════════════════════════════════
function jamDbFor(ship, radar, spec, env) {
  let db = 0;
  if (radar && radar.jammed) db += clamp(Number(radar.jammed) || 0, 0, 45);
  if (env && env.radarJamDb) db += clamp(Number(env.radarJamDb) || 0, 0, 45);
  const jammers = env && Array.isArray(env.jammers) ? env.jammers : null;
  if (jammers) {
    const fGHz = spec.bandGHz;
    for (const j of jammers) {
      if (!j || !j.pos) continue;
      if (j.bandGHzMin !== undefined && fGHz < j.bandGHzMin) continue;
      if (j.bandGHzMax !== undefined && fGHz > j.bandGHzMax) continue;
      const d = Math.max(200, dist2d(ship.pos, j.pos));
      const base = j.strengthDb !== undefined ? j.strengthDb : 18;
      db += base + 20 * Math.log10(Math.min(1, 6000 / d));
    }
  }
  return clamp(db, 0, 45);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. 雷达检测余量 / 发现距离
// ════════════════════════════════════════════════════════════════════════════
function sensitivityMarginDb(spec, env, hRadar, hTarget, R, sigmaT) {
  const refR = spec.refRangeM;
  const f4 = multipathF4(spec, hRadar, hTarget, R, env);
  const f4ref = multipathF4(spec, hRadar, REF_BB_HEIGHT_M, refR, env);
  const sigmaRatio = sigmaT / RCS_TABLE.BB;
  const fRatio = clamp(f4 / Math.max(1e-4, f4ref), 0.08, 12);
  let margin = 10 * Math.log10(Math.max(1e-9, sigmaRatio * Math.pow(refR / Math.max(1, R), 4) * fRatio));
  const horizon = radarHorizonM(hRadar, hTarget);
  if (R > horizon) margin -= BEYOND_HORIZON_LOSS_DB_PER_KM * (R - horizon) / 1000;
  return margin;
}

function clutterMarginDb(spec, env, hRadar, hTarget, R, sigmaT, chaffRcs = 0) {
  const grazing = Math.atan2(Math.max(2, (hRadar || 0) + (hTarget || 0)), Math.max(80, R));
  const sigma0 = clutterSigma0(env, spec, grazing);
  const sigmaC = sigma0 * clutterCellPerM(spec) * Math.max(1, R) + Math.max(0, chaffRcs);
  const k = clutterCrestFactor(env);
  return 10 * Math.log10(Math.max(1e-3, sigmaT) / Math.max(1e-3, k * sigmaC));
}

function detectionProbability(marginDb) {
  // Swerling-I 起伏 + 荧光屏操作员门限的 Logistic 近似：margin=0 dB → Pd=0.5。
  // 6 dB 的过渡宽度相当于中等目标单次扫描的起伏损失，长期观测由多扫描累积。
  if (!Number.isFinite(marginDb)) return 0.01;
  return clamp(1 / (1 + Math.exp(-marginDb / 6)), 0.01, 0.995);
}

// 给定几何下的"发现距离"（米）。返回 0 表示不可发现（盲区/被完全遮蔽）。
// 约定：Pd=0.5 处为发现距离，与扫描周期/起伏无关，便于 AI 与玩家判断。
export function radarDetectRange(ship, radar, target, env) {
  if (!ship || !radar || !target || !ship.pos || !target.pos) return 0;
  const spec = radarSpecOf(radar);
  const bearing = bearing2d(ship.pos, target.pos);
  const aspect = aspectAngle(target.heading || 0, bearing2d(target.pos, ship.pos));
  const sigmaT = estimateRCS(target, aspect);
  const hRadar = antennaHeightM(ship, spec);
  const hTarget = targetRadarHeightM(target);

  // 6.1 灵敏度极限：R = R_ref · (σ/σ_BB · F⁴/F⁴_ref)^(1/4)，迭代 3 次处理 F⁴ 随 R 的变化
  let Rs = spec.refRangeM * Math.pow(sigmaT / RCS_TABLE.BB, 0.25);
  for (let i = 0; i < 3; i++) {
    const f4 = multipathF4(spec, hRadar, hTarget, Math.max(80, Rs), env);
    const f4ref = multipathF4(spec, hRadar, REF_BB_HEIGHT_M, spec.refRangeM, env);
    const ratio = clamp(f4 / Math.max(1e-4, f4ref), 0.08, 12);
    Rs = spec.refRangeM * Math.pow(Math.max(1e-9, (sigmaT / RCS_TABLE.BB) * ratio), 0.25);
  }
  let R = Rs;
  // 6.2 杂波极限：σ_t ≥ k·σ0·θ·ΔR·R ⇒ R ≤ σ_t/(k·σ0·θ·ΔR)
  const cellPerM = clutterCellPerM(spec);
  for (let i = 0; i < 3; i++) {
    const chaff = chaffRcsOnLine(env, ship, target, spec);
    const grazing = Math.atan2(Math.max(2, hRadar + hTarget), Math.max(80, R));
    const s0 = clutterSigma0(env, spec, grazing);
    const k = clutterCrestFactor(env);
    const denom = Math.max(1e-9, k * s0 * cellPerM);
    const Rc = (sigmaT - k * chaff) / denom;
    if (Rc <= 0) return 0;
    R = Math.min(R, Rc);
  }
  // 6.3 地平线（允许 30% 绕射区，实际探测概率由 updateSensors 的余量决定）
  const horizon = radarHorizonM(hRadar, hTarget);
  R = Math.min(R, horizon * 1.30);
  // 6.4 硬件极限与盲区
  R = Math.min(R, spec.maxRangeM);
  if (R < spec.minRangeM) return 0;
  // 6.5 噪声干扰等效降低作用距离：R ∝ 10^(−J/40)
  const jam = jamDbFor(ship, radar, spec, env);
  if (jam > 0) R *= Math.pow(10, -jam / 40);
  return Math.max(0, Math.round(R));
}

function rangeSigmaM(spec, R) {
  return Math.sqrt(spec.rangeAccM * spec.rangeAccM + Math.pow(0.0025 * R, 2));
}

// 方位精度（1σ，度）。史实量级：SG ≈ ±1°，271/284 型 ≈ ±2-4°，FuMO 23/22 ≈ ±3-5°，
// 22 号电探更差（可靠性差、操作员判读误差大）。低信噪比时波瓣展宽，但不应无限放大。
function bearingSigmaDeg(spec, marginDb) {
  if (!spec.hasBearing) return 25;
  let s = Math.max(0.25, spec.bearingAccDeg);
  if (marginDb < 8) s *= 1 + 2.0 * clamp((8 - marginDb) / 20, 0, 1);   // 最多展宽 3 倍
  return clamp(s, 0.25, 10);
}

function emitEvent(world, type, payload) {
  if (world && world.events && typeof world.events.emit === 'function') {
    try { world.events.emit(type, payload); } catch (e) { /* 事件消费者异常不应中断仿真 */ }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. 雷达传感器：按扫描周期逐目标判定 → world.tracks.observe()
// ════════════════════════════════════════════════════════════════════════════
function processRadar(ship, radar, world, dt) {
  const env = world.env;
  const rng = world.rng;
  if (!rng || radar.destroyed) return;
  const spec = radarSpecOf(radar);
  const health = radar.health === undefined ? 1 : radar.health;
  if (!radar.on || health <= 0.05) {
    radar._scanAcc = 0;
    if (radar._wasOn) {
      radar._wasOn = false;
      emitEvent(world, 'sensor.radar.on', { t: world.t, side: ship.side, ship: ship.id, sensor: radar.id, label: radar.label, on: false });
    }
    return;
  }
  if (!radar._wasOn) {
    radar._wasOn = true;
    emitEvent(world, 'sensor.radar.on', { t: world.t, side: ship.side, ship: ship.id, sensor: radar.id, label: radar.label, on: true, spec: spec.name });
  }
  // 天线转速与健康度：受损后转速下降（重访延迟增大）
  const period = Math.max(0.8, spec.scanPeriodS / clamp(health, 0.2, 1));
  radar._scanAcc = (radar._scanAcc || 0) + dt;
  if (radar._scanAcc < period) return;
  radar._scanAcc = 0;
  radar._scanCount = (radar._scanCount || 0) + 1;
  radar._lastScanT = world.t;

  const jam = jamDbFor(ship, radar, spec, env);
  radar.jammed = jam;
  if (jam > 0.5 && !(radar._jamPrev > 0.5)) {
    emitEvent(world, 'sensor.radar.jam', { t: world.t, side: ship.side, ship: ship.id, sensor: radar.id, jamDb: +jam.toFixed(1), label: radar.label });
  }
  radar._jamPrev = jam;

  const sector = radar.searchSectorDeg || spec.sectorDeg || 360;
  const hRadar = antennaHeightM(ship, spec);
  let anyDetect = false;

  for (const target of world.ships) {
    if (!target || target === ship || !target.isAfloat) continue;
    // 同阵营舰船：雷达没有 IFF（1942），但 CIC 通常掌握本编队友舰位置，不因雷达起批；
    // 只有在"编队识别范围外 + CIC 把握不足"时，友舰才作为不明接触进入航迹
    // （一旦成了航迹，雷达继续用距离/方位保持跟踪——这正是夜间误伤能持续的证据链）。
    if (target.side === ship.side && !sameSideContactAllowed(ship, target, world, rng)) continue;
    const R = dist2d(ship.pos, target.pos);
    if (R < spec.minRangeM || R > spec.maxRangeM) continue;
    // 陆地遮蔽：雷达波不能穿透山体/岸线（真实海战中岛屿与海角是天然的雷达盲区）
    if (world.land && !world.land.empty && world.land.segmentBlocked(ship.pos, target.pos)) continue;
    const bearing = bearing2d(ship.pos, target.pos);
    const rel = normDeg180(bearing - ship.heading);
    if (sector < 359 && Math.abs(rel) > sector / 2) continue;
    const aspect = aspectAngle(target.heading || 0, bearing2d(target.pos, ship.pos));
    const sigmaT = estimateRCS(target, aspect);
    const hTarget = targetRadarHeightM(target);
    const chaff = chaffRcsOnLine(env, ship, target, spec);
    let margin = Math.min(
      sensitivityMarginDb(spec, env, hRadar, hTarget, R, sigmaT),
      clutterMarginDb(spec, env, hRadar, hTarget, R, sigmaT, chaff),
    );
    margin -= jam;
    const pd = detectionProbability(margin);
    if (!rng.chance(pd)) continue;

    const sigmaR0 = rangeSigmaM(spec, R);
    // 无测向能力的雷达（如日本 13 号电探）：只能报告"某距离上有目标"，不能起批新航迹，
    // 仅用于修正已有航迹的距离（否则会凭空捏造方位、造成大量假航迹）。
    if (!spec.hasBearing) {
      const rcsOnly = sigmaT * Math.exp(rng.normal(0, 0.4));
      world.tracks.observe({
        side: ship.side, srcKind: 'RADAR', sensorKind: 'RADAR', shipId: ship.id, targetId: target.id,
        sensorId: radar.id, observerPos: { x: ship.pos.x, y: ship.pos.y },
        pos: { x: ship.pos.x, y: ship.pos.y },
        rangeM: Math.max(spec.minRangeM * 0.5, R + rng.normal(0, sigmaR0)),
        bearingDeg: null, accuracyM: sigmaR0, accuracyDeg: 180, rangeOnly: true,
        confidence: clamp(0.40 + 0.25 * clamp(margin / 20, 0, 1), 0.3, 0.8),
        classifiedAs: 'UNKNOWN', identity: { src: 'RADAR', quality: 0, iff: false },
        features: { rcsM2: Math.max(30, rcsOnly), rcsSigmaLog: 0.45 },
        t: world.t,
      });
      continue;
    }

    // —— 生成带测量误差的观测 ——
    const sigmaR = rangeSigmaM(spec, R);
    const sigmaB = bearingSigmaDeg(spec, margin);
    const measuredR = Math.max(spec.minRangeM * 0.5, R + rng.normal(0, sigmaR));
    const measuredB = normDeg(bearing + rng.normal(0, sigmaB));
    const pos = destPoint(ship.pos, measuredR, measuredB);
    const rcsMeas = sigmaT * Math.exp(rng.normal(0, 0.35));
    const obs = {
      side: ship.side,
      srcKind: 'RADAR',
      sensorKind: 'RADAR',
      shipId: ship.id,
      targetId: target.id,
      sensorId: radar.id,
      observerPos: { x: ship.pos.x, y: ship.pos.y },
      pos,
      rangeM: spec.hasRange ? measuredR : null,
      bearingDeg: measuredB,
      accuracyM: spec.hasRange ? sigmaR : null,
      accuracyDeg: sigmaB,
      bearingOnly: !spec.hasRange,
      confidence: clamp(0.50 + 0.30 * clamp(margin / 20, 0, 1), 0.35, 0.9),
      classifiedAs: 'UNKNOWN',
      // 1942 年的雷达没有 IFF：只能测距/测向，敌我识别零信息量
      identity: { src: 'RADAR', quality: 0, iff: false },
      features: {
        rcsM2: Math.max(30, rcsMeas),
        rcsSigmaLog: 0.35,
        aspectDeg: aspect,
      },
      t: world.t,
    };
    const track = world.tracks.observe(obs);
    if (track) {
      anyDetect = true;
      radar.lastDetectT = world.t;
      radar.targetId = target.id;
      radar._detectCount = (radar._detectCount || 0) + 1;
      if (!radar._detectTimes) radar._detectTimes = [];
      radar._detectTimes.push(+world.t.toFixed(2));
      if (radar._detectTimes.length > 64) radar._detectTimes.shift();
    }
  }

  // 箔条假回波：云团本身被显示成目标（1943 年后各方大量使用 window）
  const clouds = env && Array.isArray(env.chaffClouds) ? env.chaffClouds : [];
  for (const c of clouds) {
    if (!c || !rng.chance(0.15)) continue;
    const R = dist2d(ship.pos, c);
    if (R < spec.minRangeM || R > spec.maxRangeM) continue;
    const bearing = bearing2d(ship.pos, c);
    const rel = normDeg180(bearing - ship.heading);
    if (sector < 359 && Math.abs(rel) > sector / 2) continue;
    const sigmaR = Math.max(200, 0.02 * R);
    const sigmaB = Math.max(1.5, spec.bearingAccDeg);
    const measuredR = Math.max(100, R + rng.normal(0, sigmaR));
    const measuredB = normDeg(bearing + rng.normal(0, sigmaB));
    world.tracks.observe({
      side: ship.side, srcKind: 'RADAR', sensorKind: 'RADAR', shipId: ship.id, targetId: null,
      observerPos: { x: ship.pos.x, y: ship.pos.y },
      pos: destPoint(ship.pos, measuredR, measuredB),
      rangeM: measuredR, bearingDeg: measuredB, accuracyM: sigmaR, accuracyDeg: sigmaB,
      confidence: 0.22, classifiedAs: 'UNKNOWN',
      features: { rcsM2: (c.rcsM2 || 2000) * (c.density || 1), rcsSigmaLog: 0.9 },
      t: world.t, chaff: true,
    });
  }
  if (anyDetect) radar._lastAnyDetectT = world.t;
}

// ════════════════════════════════════════════════════════════════════════════
// 敌我识别证据（1942 年没有 IFF）：只有目视可能分辨敌我
// ════════════════════════════════════════════════════════════════════════════
// 判型/敌我靠舰影轮廓、烟囱与炮塔布局、旗号；这些细节的"可辨认距离"远小于
// "发现距离"，且随光照、海况、舷角（舷侧投影最大）、舰员素质急剧变化。
const RECOG_RANGE_DAY_M = { DD: 5200, CL: 6200, CA: 7000, BC: 8200, BB: 9000, CV: 12000 };

// 返回 { src:'VISUAL', quality:0..1, ... }：quality 是"这一眼能不能看清它是谁"的质量，
// 由 tracks.js 累积成 foeConfidence（敌我判定置信度），并决定会不会认错。
export function visualIdentityEvidence(ship, target, env, rng, obs) {
  const e = env || {};
  const light = clamp(e.lightLevel !== undefined ? e.lightLevel : 1, 0, 1);
  const sea = clamp(e.seaState !== undefined ? e.seaState : 3, 0, 9);
  const R = (obs && obs.rangeM !== null && obs.rangeM !== undefined) ? Math.abs(obs.rangeM)
    : (obs && obs.pos && ship && ship.pos ? dist2d(ship.pos, obs.pos) : 12000);
  const type = (target && (target.type || (target.data && target.data.type))) || 'CA';
  const recogDayM = RECOG_RANGE_DAY_M[type] || 7000;
  const tf = (target && target.flags) || {};
  const litTarget = !!((tf.searchlight && tf.searchlight.on) || (tf.illuminated || 0) > 0.05 || tf.onFire)
    || !!(target && Array.isArray(target.compartments) && target.compartments.some((c) => (c.fire || 0) > 0.1));
  const effLight = clamp(light + (litTarget ? 0.55 : 0), 0, 1);
  // 夜色下可辨认距离只剩白天的 28%（无月）→ 100%（正午/照明）
  const nightFactor = 0.28 + 0.72 * Math.pow(effLight, 0.5);
  const recogRangeM = Math.max(600, recogDayM * nightFactor);
  const rangeFactor = clamp(1 - Math.pow(clamp(R / recogRangeM, 0, 1), 2), 0.04, 1);
  const aspect = (obs && obs.features && Number.isFinite(obs.features.aspectDeg)) ? obs.features.aspectDeg : 90;
  const aspectFactor = 0.55 + 0.45 * Math.sin(clamp(aspect, 0, 180) * Math.PI / 180);  // 舷侧投影最清楚
  const seaFactor = clamp(1 - 0.035 * sea, 0.6, 1);       // 横摇/纵摇让舰影跳动
  const crewFactor = clamp(0.65 + 0.45 * clamp((ship && ship.crewQuality) || 0.85, 0.5, 1.25), 0.8, 1.2);
  // 水平能见度（雾/雨）直接决定能不能看清舰体细节
  const visNm = (typeof e.horizontalVisibilityNm === 'function') ? e.horizontalVisibilityNm(ship)
    : (e.visibilityNm !== undefined ? e.visibilityNm : 12);
  const visFactor = clamp(visNm / 12, 0.4, 1);
  // 同型舰更难分辨（萨沃岛：驱逐舰对驱逐舰、巡洋舰对巡洋舰的舰影极易混淆）
  const sameType = !!(ship && target && ship.type && target.type && ship.type === target.type);
  const typeFactor = sameType ? 0.85 : 1.0;
  const jitter = (rng && typeof rng.normal === 'function') ? Math.exp(rng.normal(0, 0.22)) : 1;
  const quality = clamp(rangeFactor * aspectFactor * seaFactor * crewFactor * visFactor * typeFactor * jitter, 0, 0.95);
  return {
    src: 'VISUAL', quality, rangeM: Math.round(R), aspectDeg: Math.round(aspect),
    lightLevel: +light.toFixed(3), seaState: sea, recogRangeM: Math.round(recogRangeM),
    illuminated: litTarget, iff: false,
  };
}

// 同阵营舰船会不会被 CIC/瞭望当成"来历不明的接触"：
//   · 白天（光照 ≥ 0.35）编队识别可靠 → 永不；
//   · 夜里只有超出编队识别距离、且 CIC 对友舰位置把握不足时才会：
//     每艘友舰每 600 s 只掷一次"把握"（避免把整支舰队都变成假目标）；
//   · 探照灯/起火/被照亮的友舰更容易被认出，反而不成为不明接触。
function ownContactIsConfused(ship, target, world, rng) {
  if (!world || !world.env) return false;
  const light = clamp(world.env.lightLevel !== undefined ? world.env.lightLevel : 1, 0, 1);
  if (!ownContactUncertainAt(light)) return false;       // 白天编队识别可靠
  const R = dist2d(ship.pos, target.pos);
  if (R <= ownFleetKnownRangeM(light)) return false;      // 编队内，认识
  const tf = target.flags || {};
  if ((tf.searchlight && tf.searchlight.on) || (tf.illuminated || 0) > 0.05) return false;
  // 规模护栏：同一阵营同时最多只有 1 条"被当成不明接触的友舰"航迹。
  // 误伤必须是偶发的悲剧，而不是每艘友舰都变成假目标（否则 AI/UI 全是幽灵目标）。
  let ownPhantoms = 0;
  const list = (world.tracks && world.tracks.tracks) || [];
  for (const tr of list) {
    if (!tr || tr.dead || tr.side !== ship.side) continue;
    if (tr.trueSide !== ship.side) continue;
    if (tr.ageS !== undefined && tr.ageS > 600) continue;
    ownPhantoms++;
  }
  if (ownPhantoms >= 1) return false;
  // 编队内的友舰有邻舰/队形可作参照，不会被当成不明接触；
  // 只有"离群"的舰艇（附近 8 km 内没有别的同阵营舰）才可能犯这种错。
  let matesNear = 0;
  const fleet = (world && Array.isArray(world.ships)) ? world.ships : [];
  for (const s of fleet) {
    if (!s || s === ship || s === target || !s.isAfloat || s.side !== ship.side) continue;
    if (dist2d(ship.pos, s.pos) < 8000 || dist2d(target.pos, s.pos) < 8000) { matesNear++; break; }
  }
  if (matesNear > 0) return false;
  // 每场交战、每个阵营只发生一次"指挥事故"：某艘友舰被 CIC 当成来历不明的接触。
  // 1942 年这种认错是偶发的（萨沃岛），不应让整支舰队都变成幽灵目标。
  if (!world._ownContactIncident) world._ownContactIncident = new Map();
  let st = world._ownContactIncident.get(ship.side);
  if (!st) {
    let melee = 0;
    for (const tr of list) {
      if (!tr || tr.dead) continue;
      if (tr.ageS !== undefined && tr.ageS > 120) continue;
      if (dist2d(tr.pos, target.pos) < 20000) melee++;
    }
    const prob = clamp(0.18 + 0.35 * (1 - light / 0.35) + 0.05 * Math.max(0, melee - 1), 0.15, 0.55);
    const allowed = !!(rng && typeof rng.chance === 'function' ? rng.chance(prob) : false);
    st = { allowed, targetId: null, t: world.t, prob };
    world._ownContactIncident.set(ship.side, st);
  }
  if (!st.allowed) return false;
  if (!st.targetId) st.targetId = target.id;   // 只对那一艘友舰"犯糊涂"
  return target.id === st.targetId;
}

// 同阵营目标能否被传感器处理：已经是"不明接触"航迹的继续跟踪；否则按 CIC 把握掷骰
function sameSideContactAllowed(ship, target, world, rng) {
  if (!world.tracks || typeof world.tracks.hasOwnContact !== 'function') return false;
  if (world.tracks.hasOwnContact(ship.side, target.id)) return true;
  return ownContactIsConfused(ship, target, world, rng);
}

// ════════════════════════════════════════════════════════════════════════════
// 8. 目视瞭望（调用 vision.js 的目视发现与光学测距）→ world.tracks.observe()
// ════════════════════════════════════════════════════════════════════════════
function processVisualWatch(ship, world, dt) {
  const env = world.env;
  const rng = world.rng;
  if (!env || !rng) return;
  const cq = ship.crewQuality || 0.85;
  const period = 2.2 / clamp(cq, 0.5, 1.2); // 训练有素的瞭望更勤
  ship._visScanAcc = (ship._visScanAcc || 0) + dt;
  if (ship._visScanAcc < period) return;
  ship._visScanAcc = 0;
  if (!ship._visSpotted) { ship._visSpotted = new Set(); ship._visLastSpot = new Map(); }
  for (const target of world.ships) {
    if (!target || target === ship || !target.isAfloat) continue;
    // 同阵营舰船：白天/编队内不会成为航迹；夜间编队外可能被当成不明接触（萨沃岛式误伤的根源）
    if (target.side === ship.side && !sameSideContactAllowed(ship, target, world, rng)) continue;
    const obs = visualObservation(ship, target, env, rng);
    if (!obs) continue;
    obs.side = ship.side;
    obs.shipId = ship.id;
    obs.targetId = target.id;
    obs.t = world.t;
    // 目视识别证据：只有目视能给敌我判断提供信息（雷达/声呐没有 IFF）
    obs.identity = visualIdentityEvidence(ship, target, env, rng, obs);
    if (target.side === ship.side) obs.trueSide = target.side;
    const track = world.tracks.observe(obs);
    if (!track) continue;
    const prev = ship._visLastSpot.get(target.id);
    if (!ship._visSpotted.has(target.id) || (prev !== undefined && world.t - prev > 60)) {
      emitEvent(world, 'sensor.visual.spot', {
        t: world.t, side: ship.side, ship: ship.id, target: target.id, trackId: track.id,
        rangeM: obs.rangeM === null ? null : Math.round(obs.rangeM),
        bearingDeg: Math.round(obs.bearingDeg), confidence: +track.confidence.toFixed(2),
      });
      ship._visSpotted.add(target.id);
    }
    ship._visLastSpot.set(target.id, world.t);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 9. 声呐 / 水听器
// ════════════════════════════════════════════════════════════════════════════
// Thorp 吸收系数（dB/km），f 单位 kHz
function thorpDbPerKm(fKHz) {
  const f = Math.max(0.1, fKHz);
  return 0.11 * f * f / (1 + f * f) + 44 * f * f / (4100 + f * f) + 2.75e-4 * f * f + 0.003;
}
// 海洋环境噪声（1–10 kHz 风关噪声，Wenz 曲线近似），dB re µPa²/Hz
function ambientNoiseDb(seaState) {
  return 46 + 7 * clamp(seaState, 0, 9);
}
// 自噪：螺旋桨/水动力噪声随航速上升；空化起始后宽频噪声陡增
function selfNoiseDb(speedKn) {
  const s = Math.max(0, speedKn);
  let db = 38 + 30 * Math.log10(Math.max(1, s) / 6);
  if (s > 16) db += 10 * Math.log10(1 + (s - 16) / 5);
  return db;
}
function noiseLevelDb(seaState, speedKn) {
  return 10 * Math.log10(Math.pow(10, ambientNoiseDb(seaState) / 10) + Math.pow(10, selfNoiseDb(speedKn) / 10));
}

// 目标辐射噪声源级 SL（dB re µPa@1m）。螺旋桨噪声 ~ v³，空化后更陡。
export function radiatedNoiseDb(target) {
  const disp = (target && (target.displacement_t || (target.data && target.data.displacementFull_t))) || 2000;
  const speed = Math.max(0, (target && target.speed) || 0);
  let sl = 128 + 10 * Math.log10(Math.max(200, disp) / 2000);
  sl += 30 * Math.log10(Math.max(3, speed) / 3);
  const cavSpeed = 14 + 5 * Math.log10(Math.max(2000, disp) / 2000);
  if (speed > cavSpeed) sl += 10 * Math.log10(1 + (speed - cavSpeed) / 4); // 空化噪声
  return sl;
}

// 目标强度 TS（dB）：舰体水线附近的大尺度回波，舷侧 > 艏艉
function targetStrengthDb(target) {
  const base = ({ DD: 14, CL: 17, CA: 19, BC: 21, BB: 23, CV: 24 })[target && target.type] || 15;
  const bearing = target && target._sonarAspect !== undefined ? target._sonarAspect : 90;
  const s = Math.sin(clamp(bearing, 0, 180) * DEG);
  return base + 10 * Math.log10(clamp(0.4 + 0.6 * s * s, 0.2, 1));
}

function sonarSpecOf(sensor) {
  const d = (sensor && sensor.data) ? sensor.data : {};
  // passive:true 的水听器即使没写 active:false 也按被动处理（水听器没有发射机）
  const active = d.active !== false && d.passive !== true;
  return {
    active,
    freqKHz: d.freq_khz || (active ? 20 : 2),
    beamDeg: d.beamWidth_deg || (active ? 8 : 20),
    rangeRefM: (d.range_nm || (active ? 2 : 12)) * NMI_M,
    diDb: d.di_db !== undefined ? d.di_db : (active ? 12 : 10),
    dtDb: d.dt_db !== undefined ? d.dt_db : 6,
    pingIntervalS: d.pingInterval_s || 4,
    scanPeriodS: d.scanPeriod_s || (active ? 4 : 1.5),
    sensitivity: d.sensitivity || 1,
    maxRangeM: (d.maxRange_nm ? d.maxRange_nm * NMI_M : (active ? 12000 : 40000)),
    minRangeM: d.minRange_m || (active ? 150 : 100),
  };
}

// 温跃层：目标位于层下、声源在层上时，声线被折射遮蔽（典型附加损失 10~15 dB 单程）
function thermoclineLossDb(env, targetDepthM, sourceDepthM = 0) {
  const layer = (env && env.thermoclineDepthM) || 60;
  if ((targetDepthM || 0) > layer && (sourceDepthM || 0) < layer) return 12;
  return 0;
}

function solveTL(targetTL, alphaDbPerKm) {
  // 解 20log10R + α·R/1000 = targetTL（TL 单调递增）
  let lo = 10, hi = 60000;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    const tl = 20 * Math.log10(mid) + alphaDbPerKm * mid / 1000;
    if (tl < targetTL) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function activeSonarRangeM(sensor, env, ship, target, tsDb) {
  const sp = sonarSpecOf(sensor);
  const alpha = thorpDbPerKm(sp.freqKHz);
  const refR = sp.rangeRefM;
  const TLref = 20 * Math.log10(refR) + alpha * refR / 1000;
  const NLref = noiseLevelDb(3, 8);
  const speed = Math.max(0, ship.speed || 0);
  const NL = noiseLevelDb(seaStateOf(env), speed);
  const extra = thermoclineLossDb(env, target._depthM || 0, ship._depthM || 0);
  // 本舰高速自噪：>18 kn 后每节损失检测余量（单程等效）；>20 kn 对水面目标基本失效
  const speedLoss = Math.max(0, speed - 18) * 5.0;
  // 声呐方程差分：2TL(R) − 2TL(R_ref) = (TS − TS_ref) − (NL − NL_ref) − 温跃层 − 自噪
  const targetTL = TLref + 0.5 * ((tsDb - 10) - (NL - NLref) - extra - speedLoss);
  let R = Math.max(0, solveTL(targetTL, alpha));
  // 水面舰艇不是 ASDIC 的设计目标：艇体回波弱、声束下压，有效距离通常 1–3 km
  const surfaceCap = 1000 + 1300 * clamp((tsDb - 10) / 13, 0, 1);
  R = Math.min(R, surfaceCap);
  if (speed >= 20) return 0; // 高航速自噪/气泡遮蔽：主动声呐对水面目标失效
  return R;
}

function passiveRangeM(sensor, env, viewer, target) {
  const sp = sonarSpecOf(sensor);
  const alpha = thorpDbPerKm(sp.freqKHz);
  const NL = noiseLevelDb(seaStateOf(env), viewer.speed || 0);
  const SL = radiatedNoiseDb(target) + 10 * Math.log10(Math.max(0.1, sp.sensitivity));
  const extra = thermoclineLossDb(env, target._depthM || 0, viewer._depthM || 0);
  // 本舰高速时无法安静听测（螺旋桨自噪 + 舰体流噪）
  const speedLoss = Math.max(0, (viewer.speed || 0) - 16) * 4.0;
  const maxTL = SL - (NL - sp.diDb) - sp.dtDb - extra - speedLoss;
  if (maxTL <= 0) return 0;
  return Math.max(0, solveTL(maxTL, alpha));
}

// 供测试/UI 使用：当前几何下声呐/水听器对目标的各项距离极限
export function sonarDetectionRanges(sensor, env, ship, target) {
  if (!sensor || !ship || !target) return null;
  const sp = sonarSpecOf(sensor);
  const ts = targetStrengthDb(target);
  return {
    type: sp.active ? 'ACTIVE' : 'PASSIVE',
    activeRangeM: sp.active ? activeSonarRangeM(sensor, env, ship, target, ts) : 0,
    passiveRangeM: passiveRangeM(sensor, env, ship, target),
    surfaceCapM: 1000 + 1300 * clamp((ts - 10) / 13, 0, 1),
    thermoclineLossDb: thermoclineLossDb(env, target._depthM || 0, ship._depthM || 0),
    noiseLevelDb: noiseLevelDb(seaStateOf(env), ship.speed || 0),
    ownSpeedKn: ship.speed || 0,
    targetStrengthDb: ts,
  };
}

function processActiveSonar(ship, sensor, world, dt) {
  const env = world.env;
  const rng = world.rng;
  if (!rng || sensor.destroyed || sensor.on === false) return;
  const sp = sonarSpecOf(sensor);
  const health = sensor.health === undefined ? 1 : sensor.health;
  sensor._pingAcc = (sensor._pingAcc || 0) + dt;
  if (sensor._pingAcc < sp.pingIntervalS / clamp(health, 0.2, 1)) return;
  sensor._pingAcc = 0;
  for (const target of world.ships) {
    if (!target || target === ship || !target.isAfloat) continue;
    if (target.side === ship.side && !sameSideContactAllowed(ship, target, world, rng)) continue;
    const R = dist2d(ship.pos, target.pos);
    if (R < sp.minRangeM || R > sp.maxRangeM) continue;
    const aspect = aspectAngle(target.heading || 0, bearing2d(target.pos, ship.pos));
    target._sonarAspect = aspect;
    const ts = targetStrengthDb(target);
    const limit = activeSonarRangeM(sensor, env, ship, target, ts);
    if (limit <= 0) continue;
    const margin = 40 * Math.log10(limit / Math.max(1, R));
    if (!rng.chance(detectionProbability(margin))) continue;
    const sigmaB = clamp(sp.beamDeg / 4, 0.5, 12);
    const sigmaR = Math.max(30, 0.02 * R);
    const measuredR = Math.max(20, R + rng.normal(0, sigmaR));
    const measuredB = normDeg(bearing2d(ship.pos, target.pos) + rng.normal(0, sigmaB));
    world.tracks.observe({
      side: ship.side, srcKind: 'SONAR', sensorKind: 'SONAR', shipId: ship.id, targetId: target.id, sensorId: sensor.id,
      observerPos: { x: ship.pos.x, y: ship.pos.y },
      pos: destPoint(ship.pos, measuredR, measuredB),
      rangeM: measuredR, bearingDeg: measuredB, accuracyM: sigmaR, accuracyDeg: sigmaB,
      confidence: 0.45, classifiedAs: 'UNKNOWN', identity: { src: 'SONAR', quality: 0, iff: false }, t: world.t,
    });
    sensor.lastDetectT = world.t;
  }
}

function processHydrophone(ship, sensor, world, dt) {
  const env = world.env;
  const rng = world.rng;
  if (!rng || sensor.destroyed || sensor.on === false) return;
  const sp = sonarSpecOf(sensor);
  sensor._scanAcc = (sensor._scanAcc || 0) + dt;
  if (sensor._scanAcc < sp.scanPeriodS) return;
  sensor._scanAcc = 0;
  for (const target of world.ships) {
    if (!target || target === ship || !target.isAfloat) continue;
    if (target.side === ship.side && !sameSideContactAllowed(ship, target, world, rng)) continue;
    const R = dist2d(ship.pos, target.pos);
    if (R < sp.minRangeM || R > sp.maxRangeM) continue;
    const limit = passiveRangeM(sensor, env, ship, target);
    if (limit <= 0 || R > limit) continue;
    const margin = 40 * Math.log10(limit / Math.max(1, R));
    if (!rng.chance(detectionProbability(margin))) continue;
    const sigmaB = clamp(sp.beamDeg / 5, 0.8, 8) * (margin < 6 ? 1.6 : 1);
    const measuredB = normDeg(bearing2d(ship.pos, target.pos) + rng.normal(0, sigmaB));
    // 水听器只有方位：pos 只是沿方位线的猜测点，径向不确定度极大（由 tracks EKF 处理）
    world.tracks.observe({
      side: ship.side, srcKind: 'SONAR', sensorKind: 'HYDRO', shipId: ship.id, targetId: target.id, sensorId: sensor.id,
      observerPos: { x: ship.pos.x, y: ship.pos.y },
      pos: destPoint(ship.pos, 12000, measuredB),
      rangeM: null, bearingDeg: measuredB, accuracyM: null, accuracyDeg: sigmaB,
      bearingOnly: true, passive: true, confidence: 0.30, classifiedAs: 'UNKNOWN',
      identity: { src: 'HYDRO', quality: 0, iff: false }, t: world.t,
    });
    sensor.lastDetectT = world.t;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 10. 世界级效果（每 tick 只执行一次：烟幕云、箔条云）
// ════════════════════════════════════════════════════════════════════════════
function updateWorldEffects(world, dt) {
  if (!world || world._t2EffectsT === world.t) return;
  world._t2EffectsT = world.t;
  try { updateSmokeClouds(world, dt); } catch (e) { /* T1 env 可能尚未就绪 */ }
  try { updateChaffClouds(world.env, world.t, dt); } catch (e) { /* 同上 */ }
}

// ════════════════════════════════════════════════════════════════════════════
// 11. 契约入口
// ════════════════════════════════════════════════════════════════════════════
export function updateSensors(ship, world, dt) {
  if (!ship || !world || !ship.isAfloat) return;
  updateWorldEffects(world, dt);
  const sensors = Array.isArray(ship.sensors) ? ship.sensors : [];
  for (const sensor of sensors) {
    if (!sensor || sensor.destroyed || (sensor.health !== undefined && sensor.health <= 0.05)) continue;
    if (sensor.srcKind === 'RADAR') processRadar(ship, sensor, world, dt);
    else if (sensor.srcKind === 'SONAR') {
      const d = sensor.data || {};
      if (d.active === false || d.passive === true) processHydrophone(ship, sensor, world, dt);
      else processActiveSonar(ship, sensor, world, dt);
    } else if (sensor.srcKind === 'HYDRO') processHydrophone(ship, sensor, world, dt);
  }
  processVisualWatch(ship, world, dt);
}
