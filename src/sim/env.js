// 【T1 所有者】环境模型：风/海况/涌浪/能见度/昼夜月相/雨飑/烟幕/洋流。
//
// 物理模型与依据
// 1) 蒲福风级 B 与海面 10 m 风速：v = 0.836·B^1.5 (m/s)（WMO 蒲福风级标准关系，B=0..12）。
// 2) 风浪有效波高：Pierson–Moskowitz 充分成长谱 Hs = 0.21·U10²/g = 0.0214·U² (m)。
//    战役海区多为有限风区，乘"成长度"系数 0.65（开阔大洋 0.8~0.9，北海/中纬有限风区 0.5~0.7）。
// 3) 有效周期：Bretschneider 经验式 Ts ≈ 3.6·√Hs（深水，s/m^0.5）。
// 4) 道格拉斯海况：按 WMO 浪高级差 0/0.1/0.5/1.25/2.5/4/6/9/14 m 反查，返回 0~9 连续值（含级内插值）。
// 5) 太阳位置：Cooper 赤纬经验式 + 时角方程，日落时角取 -0.833°（蒙气差+日面半径）。
// 6) 月相：朔望月 29.530588853 d，以 2000-01-06 18:14 UT 朔为历元；月球黄经用平黄经+主摄动项简化。
// 7) 雾：露点近似 Td ≈ T-(100-RH)/5；平流雾（Td≥SST）与辐射雾（夜间静风高湿）。
// 8) 烟幕：高斯烟团模型，平流速度取 0.6×海面风（近水层风速约为桅顶风的 60%），
//    湍流扩散 σ(t)=√(2Kt)（K≈150 m²/s，近地面大气湍流扩散典型量级），浓度按质量守恒 ∝1/r 衰减。
// 9) 洋流：恒定流 + M2 半日潮（周期 12.4206 h）往复流。
// 10) 能见度：夜间物理能见度不变，但可用目视距离下降（目标主动照明由 illuminationFactor 处理）。
import { clamp, normDeg, normDeg180, rad2deg, deg2rad } from '../core/util.js';
import { RNG } from '../core/rng.js';

const MPS_PER_KN = 0.514444;
const SYNODIC_MONTH_D = 29.530588853;                   // 朔望月（天）
const NEW_MOON_EPOCH_D = 5.259722;                      // 2000-01-06 18:14 UT 相对 J2000 的日数（=朔）
const M2_PERIOD_S = 12.4206 * 3600;                     // 主太阴半日分潮 M2

function smoothstep(x, a, b) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------- 蒲福 / 道格拉斯
// 蒲福风级（连续值）← 风速
export function beaufortForceFromWind(windKn) {
  const u = Math.max(0, windKn) * MPS_PER_KN;
  return clamp(Math.pow(u / 0.836, 2 / 3), 0, 17);
}
// 蒲福风级 → 风速 (kn)
export function windKnFromBeaufort(force) {
  return 0.836 * Math.pow(clamp(force, 0, 12), 1.5) / MPS_PER_KN;
}
// 道格拉斯等级边界（m）：等级 i 位于 [B[i], B[i+1])
const DOUGLAS_BOUNDS = [0, 0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14, 20];
// 有效波高 (m) → 道格拉斯海况 0~9（级内连续插值，避免阶跃跳变）
// 注意等级与边界索引的对应：浪高落在 [B[i],B[i+1]) 时为第 (i+1) 级，0 级仅对应完全无浪。
export function douglasFromHs(hs) {
  const h = Math.max(0, hs);
  if (h <= 0) return 0;
  for (let i = 0; i < 9; i++) {
    if (h < DOUGLAS_BOUNDS[i + 1]) {
      const lo = DOUGLAS_BOUNDS[i], hi = DOUGLAS_BOUNDS[i + 1];
      return clamp((i + 1) + (h - lo) / (hi - lo), 0, 9);
    }
  }
  return 9;
}
// 道格拉斯海况 → 该级"代表浪高"（级中点 m）：用于场景初始化，避免恰好落在级边界上导致整数等级抖动
export function hsFromDouglasMid(state) {
  const s = clamp(state, 0, 9);
  if (s <= 0) return 0;
  const i = clamp(Math.round(s) - 1, 0, 8);
  return 0.5 * (DOUGLAS_BOUNDS[i] + DOUGLAS_BOUNDS[i + 1]);
}
// 道格拉斯海况 → 该级下界浪高 (m)（hsFromDouglas 的精确逆）
export function hsFromDouglas(state) {
  const s = clamp(state, 0, 9);
  if (s <= 0) return 0;
  const i = Math.min(8, Math.floor(s) - 1);
  const lo = DOUGLAS_BOUNDS[i], hi = DOUGLAS_BOUNDS[i + 1];
  return lo + (hi - lo) * (s - Math.floor(s));
}
// 充分成长风浪有效波高（可调成长度）
export function significantWaveHeightFromWind(windKn, develop = 0.65) {
  const u = Math.max(0, windKn) * MPS_PER_KN;
  return 0.0214 * u * u * develop;
}
// 风 → 道格拉斯海况（纯函数，对外返回整数等级 0~9；内部连续值用 douglasFromHs）
export function seaStateFromWind(windKn) {
  return clamp(Math.floor(douglasFromHs(significantWaveHeightFromWind(windKn))), 0, 9);
}

// ---------------------------------------------------------------- 昼夜与月相
function absoluteDays(year, dayOfYear) {
  const ms = Date.UTC(year, 0, 1) - Date.UTC(2000, 0, 1, 12, 0, 0);
  return ms / 86400000 + (dayOfYear - 1);
}
function moonState(lat, dayOfYear, tHours, year) {
  const d = absoluteDays(year, dayOfYear);
  const phase = (((d - NEW_MOON_EPOCH_D) / SYNODIC_MONTH_D) % 1 + 1) % 1;   // 0=朔 0.5=望
  const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;                    // 被照亮比例
  // 月球黄经/黄纬：平黄经 + 主要摄动（误差约 1°，足够照明与出没判断）
  const L = deg2rad(normDeg(218.316 + 13.176396 * d));
  const M = deg2rad(normDeg(134.963 + 13.064993 * d));
  const lon = L + deg2rad(6.289) * Math.sin(M);
  const latM = deg2rad(5.128) * Math.sin(deg2rad(normDeg(93.272 + 13.229350 * d)));
  const eps = deg2rad(23.4393);
  const decMoon = Math.asin(clamp(Math.sin(latM) * Math.cos(eps) + Math.cos(latM) * Math.sin(eps) * Math.sin(lon), -1, 1));
  // 月亮每天比太阳晚约 50 min 升起 → 时角滞后相位×360°
  const Hmoon = deg2rad(15 * (tHours - 12) - 360 * phase);
  const sinAlt = Math.sin(deg2rad(lat)) * Math.sin(decMoon) + Math.cos(deg2rad(lat)) * Math.cos(decMoon) * Math.cos(Hmoon);
  return { phase, illum, altDeg: rad2deg(Math.asin(clamp(sinAlt, -1, 1))), decDeg: rad2deg(decMoon) };
}
export function dayNightInfo(lat, dayOfYear, tHours, year = 1942) {
  const decl = 23.44 * Math.sin(deg2rad(360 / 365.24 * (dayOfYear - 81)));   // Cooper 赤纬经验式
  const H = deg2rad(15 * (tHours - 12));
  const sinAlt = Math.sin(deg2rad(lat)) * Math.sin(deg2rad(decl)) +
    Math.cos(deg2rad(lat)) * Math.cos(deg2rad(decl)) * Math.cos(H);
  const sunAltDeg = rad2deg(Math.asin(clamp(sinAlt, -1, 1)));
  // 日落时角：含 -0.833° 蒙气差与日面视半径
  const cosH0 = (Math.sin(deg2rad(-0.833)) - Math.sin(deg2rad(lat)) * Math.sin(deg2rad(decl))) /
    (Math.cos(deg2rad(lat)) * Math.cos(deg2rad(decl)));
  let halfDay = 12, polarDay = false, polarNight = false;
  if (cosH0 <= -1) { polarDay = true; halfDay = 12; }
  else if (cosH0 >= 1) { polarNight = true; halfDay = 0; }
  else halfDay = rad2deg(Math.acos(cosH0)) / 15;
  const m = moonState(lat, dayOfYear, tHours, year);
  return {
    sunriseH: 12 - halfDay, sunsetH: 12 + halfDay, sunAltDeg, declDeg: decl,
    moonIllum: m.illum, moonPhase: m.phase, moonAltDeg: m.altDeg, moonDecDeg: m.decDeg, polarDay, polarNight,
  };
}

// ---------------------------------------------------------------- 环境
export class Environment {
  constructor(opts = {}) {
    this.lat = opts.lat !== undefined ? opts.lat : 0;
    this.lon = opts.lon !== undefined ? opts.lon : 0;
    this.rng = opts.rng || new RNG(opts.seed !== undefined ? opts.seed : 19420604);
    this.events = opts.events || null;                    // 若 world.js 注入 EventBus 则直接发事件
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.pendingEvents = [];                              // 未注入总线时暂存，由 dynamics 转发到 world.events
    this._t = 0;
    this._lastSmokeT = null;
    this._lastSmokeSyncT = null;

    const d = new Date(opts.date || '1942-06-01T12:00:00Z');
    this.startISO = isNaN(d.getTime()) ? '1942-06-01T12:00:00.000Z' : d.toISOString();
    const dd = isNaN(d.getTime()) ? new Date(Date.UTC(1942, 5, 1, 12)) : d;
    this.year = dd.getUTCFullYear();
    this.dayOfYear = Math.floor((Date.UTC(this.year, dd.getUTCMonth(), dd.getUTCDate()) - Date.UTC(this.year, 0, 1)) / 86400000) + 1;
    // 世界时 → 当地平太阳时（经度 15°/h）；昼夜/月相按舰所在经度计算
    this.utcHours0 = dd.getUTCHours() + dd.getUTCMinutes() / 60 + dd.getUTCSeconds() / 3600;
    this.tzOffsetH = this.lon / 15;
    this.tHours0 = ((this.utcHours0 + this.tzOffsetH) % 24 + 24) % 24;
    this.tHours = this.tHours0;
    this.timeOfDayH = this.tHours;

    // ---- 风（windDirDeg = 风的来向，气象习惯）----
    this.windKn = opts.windKn !== undefined ? opts.windKn : 12;
    this.windDirDeg = opts.windDirDeg !== undefined ? opts.windDirDeg : 270;
    this._windTargetKn = this.windKn;
    this._windTargetDirDeg = this.windDirDeg;
    this.gustKn = this.windKn;

    // ---- 海况：风浪 + 涌浪（能量平方和）----
    const hsEq = significantWaveHeightFromWind(this.windKn);
    this.hsWindSeaM = hsEq * 0.955;
    this.hsSwellM = opts.swellHeightM !== undefined ? opts.swellHeightM : hsEq * 0.30;
    this.swellDirDeg = opts.swellDirDeg !== undefined ? opts.swellDirDeg : this.windDirDeg;  // 来向
    this.swellPeriodS = opts.swellPeriodS !== undefined ? opts.swellPeriodS : 3.6 * Math.sqrt(Math.max(0.2, this.hsSwellM));
    if (opts.seaState !== undefined) {
      const H = hsFromDouglasMid(opts.seaState);   // 用级中点初始化，等级不会因微小变化在边界抖动
      this.hsWindSeaM = H * 0.955;
      this.hsSwellM = opts.swellHeightM !== undefined ? opts.swellHeightM : H * 0.30;
    }
    this._seaState = douglasFromHs(this.waveHeightM());

    // ---- 气象 / 能见度 ----
    this.baseVisibilityNm = opts.visibilityNm !== undefined ? opts.visibilityNm : 12;
    this.cloudCover = opts.cloudCover !== undefined ? opts.cloudCover : 0.4;
    this.seaTempC = opts.seaTempC !== undefined ? opts.seaTempC : this._defaultSeaTempC();
    this.airTempC = opts.airTempC !== undefined ? opts.airTempC : this.seaTempC + 1.5;
    this.humidity = opts.humidity !== undefined ? opts.humidity : 0.78;
    this.rainFactor = 1;
    this.fogDensity = opts.fogDensity !== undefined ? opts.fogDensity : 0;
    this.squallRatePerHour = opts.squallRatePerHour !== undefined ? opts.squallRatePerHour : 0.5;
    this.squalls = [];
    this.aoi = opts.aoi || { x: 0, y: 0, r: 30000 };

    // ---- 烟幕（格式：{x,y,r,density,source}，额外字段 age/t0 供内部演化）----
    // 单位：x/y 米（世界局部切平面）、r 米（烟团视觉半径，渲染直接按米换算像素）、density 0~1、source 字符串
    this.smokeClouds = [];
    this.smokeEnabled = opts.smoke !== false;

    // ---- 洋流 ----
    this.currentBaseKn = opts.currentKn !== undefined ? opts.currentKn : 0;
    this.currentBaseDirDeg = opts.currentDirDeg !== undefined ? opts.currentDirDeg : 0;
    this.currentKn = this.currentBaseKn;
    this.currentDirDeg = this.currentBaseDirDeg;
    this._tidePhase = this.rng.range(0, Math.PI * 2);

    // ---- 昼夜场 ----
    this._refreshDayNight();
    this._wasDay = this._isDaytime();
    this._lastChangeEmitT = -1e9;
    this._lastEmitWindKn = this.windKn;
    this._lastEmitSea = this._seaState;
  }

  _defaultSeaTempC() {
    // 粗糙的季节性海温：赤道 28℃，高纬递减；北半球 9 月最暖
    const latFactor = Math.cos(deg2rad(this.lat)) * 0.5 + 0.5;
    const season = Math.sin(deg2rad(360 / 365 * (this.dayOfYear - 110))) * (this.lat >= 0 ? 1 : -1);
    return 6 + 22 * latFactor + 3 * season * Math.abs(this.lat) / 90;
  }

  _refreshDayNight() {
    const dn = dayNightInfo(this.lat, this.dayOfYear, this.tHours, this.year);
    this.sunriseH = dn.sunriseH; this.sunsetH = dn.sunsetH;
    this.sunAltDeg = dn.sunAltDeg; this.moonIllum = dn.moonIllum;
    this.moonAltDeg = dn.moonAltDeg; this.moonPhase = dn.moonPhase;
    this.declDeg = dn.declDeg; this.polarDay = dn.polarDay; this.polarNight = dn.polarNight;
    return dn;
  }
  _isDaytime() {
    if (this.polarDay) return true;
    if (this.polarNight) return false;
    const h = this.tHours;
    return this.sunriseH < this.sunsetH
      ? (h >= this.sunriseH && h < this.sunsetH)
      : !(h >= this.sunsetH && h < this.sunriseH);
  }

  // ================= 派生量 =================
  get beaufortForce() { return beaufortForceFromWind(this.windKn); }
  // 有效浪高（风浪与涌浪按能量平方和合成，即合同中的 swellHeightM）
  get swellHeightM() { return this.waveHeightM(); }
  waveHeightM() { return Math.sqrt(this.hsWindSeaM * this.hsWindSeaM + this.hsSwellM * this.hsSwellM); }
  get windSeaHeightM() { return this.hsWindSeaM; }
  // 能量加权有效周期：风浪用 Bretschneider，涌浪用自身周期
  get wavePeriodS() {
    const e1 = this.hsWindSeaM * this.hsWindSeaM, e2 = this.hsSwellM * this.hsSwellM;
    const T1 = 3.6 * Math.sqrt(Math.max(0.1, this.hsWindSeaM));
    const T2 = this.swellPeriodS;
    return (T1 * e1 + T2 * e2) / Math.max(1e-6, e1 + e2);
  }
  // 合成浪的来向（能量加权矢量平均）
  get waveFromDeg() {
    const e1 = this.hsWindSeaM * this.hsWindSeaM, e2 = this.hsSwellM * this.hsSwellM;
    const t1 = this.windDirDeg + 180, t2 = this.swellDirDeg + 180;   // 传播去向
    const x = e1 * Math.sin(deg2rad(t1)) + e2 * Math.sin(deg2rad(t2));
    const y = e1 * Math.cos(deg2rad(t1)) + e2 * Math.cos(deg2rad(t2));
    if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return this.windDirDeg;
    return normDeg(rad2deg(Math.atan2(x, y)) + 180);
  }
  // 对外暴露的道格拉斯海况：整数 0~9（Lead 要求，UI/AI 契约按整数解读）
  get seaState() { return clamp(Math.floor(this._seaState), 0, 9); }
  // 内部连续海况（级内插值，仅用于平滑过渡/调试，不对外）
  get seaStateContinuous() { return this._seaState; }
  // 光照 0（漆黑）~1（正午）：太阳高度角 + 民用晨昏蒙影 + 月光（云量折减）
  get lightLevel() {
    const alt = this.sunAltDeg;
    const sunL = alt > 0 ? Math.pow(clamp(Math.sin(deg2rad(alt)), 0, 1), 0.8) : 0;
    const twilight = alt <= 0 ? 0.10 * clamp(1 + alt / 6, 0, 1) : 0;    // 民用晨昏蒙影 0~-6°
    const moonL = 0.10 * this.moonIllum * clamp(this.moonAltDeg / 40, 0, 1) * (1 - 0.7 * this.cloudCover);
    return clamp(Math.max(sunL * 0.98 + twilight, moonL), 0.01, 1);
  }
  // 当前水平能见度（含雾、大范围降水；不含本舰烟幕与局部飑）
  get visibilityNm() {
    return Math.max(0.05, this.baseVisibilityNm * (1 - 0.97 * this.fogDensity) * this.rainFactor);
  }
  // 考虑烟幕/雨飑/夜间后的"可用目视距离"
  horizontalVisibilityNm(ship) {
    let vis = this.visibilityNm;
    if (ship && ship.pos) {
      vis *= (1 - 0.92 * this.smokeDensityAt(ship.pos.x, ship.pos.y));
      for (const s of this.squalls) {
        const d = Math.hypot(s.x - ship.pos.x, s.y - ship.pos.y);
        if (d < s.r) {
          const w = clamp(1 - (d / s.r) * (d / s.r), 0, 1);
          vis = vis * (1 - w) + Math.min(vis, s.visNm) * w;
        }
      }
    }
    // 夜间可用目视距离下降（物理能见度未变）。但晨昏不是黑夜：太阳高度 +3° 时舰体仍是清晰
    // 暗剪影（史实黎明/黄昏是发现与突袭的黄金时段），所以用次线性曲线而不是线性砍半。
    const night = 0.45 + 0.55 * Math.pow(clamp(this.lightLevel, 0, 1), 0.5);
    return Math.max(0.05, vis * night);
  }
  // 月光/照明弹/探照灯/自身火灾对被观测者可见性的加成（0.02~2.0）
  illuminationFactor(ship) {
    let f = 0.02 + 0.98 * this.lightLevel;
    if (ship) {
      const sl = ship.flags && ship.flags.searchlight;
      if (sl && sl.on && (sl.health === undefined || sl.health > 0)) f += 0.55;
      if (ship.flags) f += clamp(ship.flags.illuminated || 0, 0, 1) * 0.50;
      let fire = 0;
      if (ship.compartments) for (const c of ship.compartments) if (c.fire > 0.05) fire += c.fire;
      f += clamp(fire, 0, 1) * 0.80;
    }
    return clamp(f, 0.02, 2.0);
  }
  // 烟幕遮蔽率 0~1：独立烟团按 (1-τ) 连乘合成不透明度
  smokeDensityAt(x, y) {
    let occ = 0;
    for (const c of this.smokeClouds) {
      const dx = c.x - x, dy = c.y - y;
      const d2 = dx * dx + dy * dy;
      const sig = Math.max(8, c.r / 1.6);                 // r 定义为视觉边缘 ≈1.6σ
      const tau = c.density * Math.exp(-d2 / (2 * sig * sig));
      if (tau < 0.002) continue;
      occ = 1 - (1 - occ) * (1 - clamp(tau, 0, 1));
    }
    return clamp(occ, 0, 1);
  }
  // 洋流（恒定流 + M2 半日潮往复流）
  currentAt(x, y) {
    const k = this.currentKn * (1 + 0.15 * Math.sin((x + y) / 12000));
    const v = Math.max(0, k) * MPS_PER_KN;
    return { dirDeg: this.currentDirDeg, kn: Math.max(0, k), vx: Math.sin(deg2rad(this.currentDirDeg)) * v, vy: Math.cos(deg2rad(this.currentDirDeg)) * v };
  }

  // ================= 主循环 =================
  step(dt, world = null) {
    this._t += dt;
    if (world) this.updateSquallAOI(world);
    this.tHours = ((this.tHours0 + this._t / 3600) % 24 + 24) % 24;
    this.timeOfDayH = this.tHours;
    this._refreshDayNight();
    this._stepSunEvents();
    this._stepWind(dt);
    this._stepSea(dt);
    this._stepAirAndFog(dt);
    this._stepSqualls(dt);
    this._stepCurrent();
    if (this.smokeEnabled) this.stepSmoke(dt, world);
  }

  _stepWind(dt) {
    // 天气尺度慢变 + 阵风（确定性 OU 过程，本环境独立随机流，与场景种子同源）
    this._windTargetKn = clamp(this._windTargetKn + this.rng.normal(0, 0.35) * Math.sqrt(dt / 60), 0, 75);
    this.windKn = clamp(this.windKn + (this._windTargetKn - this.windKn) * clamp(dt / 1800, 0, 1) + this.rng.normal(0, 0.10) * Math.sqrt(dt), 0, 80);
    this._windTargetDirDeg = normDeg(this._windTargetDirDeg + this.rng.normal(0, 0.6) * Math.sqrt(dt / 60));
    this.windDirDeg = normDeg(this.windDirDeg + normDeg180(this._windTargetDirDeg - this.windDirDeg) * clamp(dt / 900, 0, 1));
    this.gustKn = this.windKn * (1 + clamp(this.rng.normal(0, 0.12), -0.4, 0.6));
  }

  _stepSea(dt) {
    const hsEq = significantWaveHeightFromWind(this.windKn) * 0.955;
    // 风浪成长慢（大洋充分成长需数小时），衰减更慢；作战时间尺度取 40~60 min 历时常数
    const tau = hsEq > this.hsWindSeaM ? 2400 : 3600;
    this.hsWindSeaM += (hsEq - this.hsWindSeaM) * clamp(dt / tau, 0, 1);
    this.hsSwellM = clamp(this.hsSwellM * Math.exp(-dt / 21600), 0, 20);       // 涌浪数小时衰减
    this.swellDirDeg = normDeg(this.swellDirDeg + normDeg180(this.windDirDeg - this.swellDirDeg) * clamp(dt / 7200, 0, 1));
    this.swellPeriodS = clamp(this.swellPeriodS, 3.0, 20);
    const before = this._seaState;
    this._seaState = douglasFromHs(this.waveHeightM());
    const dtEmit = this._t - this._lastChangeEmitT;
    if (dtEmit > 60 && (Math.abs(this.windKn - this._lastEmitWindKn) >= 6 || Math.abs(this._seaState - this._lastEmitSea) >= 0.8)) {
      this._lastChangeEmitT = this._t;
      this._emit('env.change', {
        windKn: +this.windKn.toFixed(1), windDirDeg: Math.round(this.windDirDeg),
        seaState: clamp(Math.floor(this._seaState), 0, 9), swellHeightM: +this.waveHeightM().toFixed(2),
        visibilityNm: +this.visibilityNm.toFixed(1),
      });
      this._lastEmitWindKn = this.windKn; this._lastEmitSea = before;
    }
  }

  _stepAirAndFog(dt) {
    // 海面气温的日变化（海洋性气候振幅小，约 ±2.5℃）
    const diurnal = 2.5 * Math.sin(deg2rad(15 * (this.tHours - 9)));
    this.airTempC = this.seaTempC + 1.5 + diurnal;
    const dew = this.airTempC - (1 - this.humidity) * 20;                       // Td ≈ T-(100-RH)/5
    const advection = smoothstep(dew - this.seaTempC, -1.5, 1.5);               // 暖湿空气流经冷海面
    const night = 1 - clamp(this.lightLevel * 3, 0, 1);
    const calm = clamp((8 - this.windKn) / 8, 0, 1);
    const radiation = clamp((this.humidity - 0.92) / 0.08, 0, 1) * night * calm; // 夜间辐射雾
    const target = clamp(Math.max(advection, radiation), 0, 1);
    const tau = target > this.fogDensity ? 900 : 2400;                          // 起雾快、消散慢
    this.fogDensity += (target - this.fogDensity) * clamp(dt / tau, 0, 1);
    // 大范围降水：云量与风力越大越可能降雨，能见度按 0.45~1 折减
    const rainTarget = 1 - 0.55 * clamp((this.cloudCover - 0.55) / 0.45, 0, 1) * (0.4 + 0.6 * clamp(this.windKn / 30, 0, 1));
    this.rainFactor += (rainTarget - this.rainFactor) * clamp(dt / 600, 0, 1);
  }

  _spawnSquall() {
    const c = this.aoi || { x: 0, y: 0, r: 30000 };
    const from = deg2rad(this.windDirDeg);                       // 上风侧生成
    const dist = c.r * this.rng.range(0.55, 1.25);
    const jitter = deg2rad(this.rng.range(-25, 25));
    const sq = {
      x: c.x + Math.sin(from + jitter) * dist,
      y: c.y + Math.cos(from + jitter) * dist,
      r: this.rng.range(900, 2200),
      visMinNm: this.rng.range(0.25, 1.6),
      visMaxNm: this.baseVisibilityNm * this.rng.range(0.5, 0.9),
      age: 0, dur: this.rng.range(1200, 2700), visNm: 0,
    };
    sq.visNm = sq.visMaxNm;
    this.squalls.push(sq);
    this._emit('env.squall', { x: sq.x, y: sq.y, r: sq.r, visNm: sq.visMinNm, dirDeg: this.windDirDeg, windKn: +this.windKn.toFixed(1) });
  }

  _stepSqualls(dt) {
    const drift = 0.65 * this.windKn * MPS_PER_KN;               // 飑线随平均风移动
    const toward = deg2rad(this.windDirDeg + 180);
    for (const s of this.squalls) {
      s.age += dt;
      s.x += Math.sin(toward) * drift * dt;
      s.y += Math.cos(toward) * drift * dt;
      s.r += 3.0 * dt;                                            // 边缘扩张 ~3 m/s
      const shape = Math.sin(Math.PI * clamp(s.age / s.dur, 0, 1));
      s.visNm = s.visMinNm + (s.visMaxNm - s.visMinNm) * (1 - shape);
    }
    this.squalls = this.squalls.filter((s) => s.age < s.dur);
    const p = 1 - Math.exp(-this.squallRatePerHour * dt / 3600);   // Poisson 生成
    if (this.rng.next() < p) this._spawnSquall();
  }

  _stepCurrent() {
    const s = Math.sin(2 * Math.PI * this._t / M2_PERIOD_S + this._tidePhase);
    this.currentKn = this.currentBaseKn * (0.35 + 0.65 * Math.abs(s));
    this.currentDirDeg = normDeg(this.currentBaseDirDeg + (s >= 0 ? 0 : 180));
  }

  // ---- 烟幕：生成 / 漂移 / 扩散 / 稀释 ----
  spawnSmoke(x, y, density, opts = {}) {
    const c = {
      x, y, r: opts.r !== undefined ? opts.r : 60, density: clamp(density, 0, 1),
      source: opts.source || 'CANISTER', t0: this._t, age: 0,
    };
    this.smokeClouds.push(c);
    return c;
  }
  stepSmoke(dt, world = null) {
    this._advanceSmoke(dt);
    if (world) this.stepSmokeSources(world);
  }
  // 仅同步舰船烟源（world.js 已调用 env.step(dt) 推进烟团时，dynamics 只补充烟源，避免重复平流）
  stepSmokeSources(world) {
    if (this._lastSmokeSyncT === this._t) return;
    this._lastSmokeSyncT = this._t;
    this._syncShipSmoke(world);
  }
  _advanceSmoke(dt) {
    const drift = 0.6 * this.windKn * MPS_PER_KN;                // 近水层风约为桅顶风的 60%
    const toward = deg2rad(this.windDirDeg + 180);
    const K = 150;                                               // 湍流扩散系数 m²/s
    for (const c of this.smokeClouds) {
      c.age += dt;
      c.x += Math.sin(toward) * drift * dt;
      c.y += Math.cos(toward) * drift * dt;
      const rPrev = c.r;
      c.r = Math.sqrt(c.r * c.r + 2 * K * dt);                    // σ(t)=√(2Kt)
      if (rPrev > 1e-6) c.density *= (rPrev / c.r) * Math.exp(-dt / 600);   // 稀释 + 沉降
    }
    this.smokeClouds = this.smokeClouds.filter((c) => c.density > 0.02 && c.age < 1500);
    if (this.smokeClouds.length > 180) {
      this.smokeClouds.sort((a, b) => b.density - a.density);
      this.smokeClouds.length = 180;
    }
  }
  _syncShipSmoke(world) {
    if (!world || !world.ships) return;
    for (const s of world.ships) {
      if (!s.isAfloat) continue;
      const inten = clamp((s.flags && s.flags.smokeIntensity) || 0, 0, 1.6);
      let anchor = this.smokeClouds.find((c) => c.source === 'ship:' + s.id);
      if (inten < 0.05) { if (anchor) anchor.source = 'trail'; continue; }
      const density = clamp(0.15 + 0.75 * inten, 0, 1);
      if (anchor && Math.hypot(anchor.x - s.pos.x, anchor.y - s.pos.y) > Math.max(250, anchor.r * 0.9)) {
        anchor.source = 'trail'; anchor = null;                  // 拖出烟迹，另起新烟团
      }
      if (anchor) { anchor.x = s.pos.x; anchor.y = s.pos.y; anchor.density = Math.max(anchor.density, density); }
      else this.spawnSmoke(s.pos.x, s.pos.y, density, { r: 55, source: 'ship:' + s.id });
    }
  }
  updateSquallAOI(world) {
    if (!world || !world.ships || !world.ships.length) return;
    let x = 0, y = 0, n = 0;
    for (const s of world.ships) { if (!s.isAfloat) continue; x += s.pos.x; y += s.pos.y; n++; }
    if (n) this.aoi = { x: x / n, y: y / n, r: 30000 };
  }

  _stepSunEvents() {
    const day = this._isDaytime();
    if (day !== this._wasDay) {
      this._wasDay = day;
      if (day) this._emit('env.sunrise', { timeOfDayH: +this.tHours.toFixed(2), sunriseH: this.sunriseH, sunsetH: this.sunsetH });
      else this._emit('env.sunset', { timeOfDayH: +this.tHours.toFixed(2), sunriseH: this.sunriseH, sunsetH: this.sunsetH, moonIllum: +this.moonIllum.toFixed(2) });
    }
  }

  _emit(type, data = {}) {
    if (this.events && typeof this.events.emit === 'function') { this.events.emit(type, Object.assign({ t: this._t }, data)); return; }
    if (this.onEvent) { this.onEvent(type, Object.assign({ t: this._t }, data)); return; }
    this.pendingEvents.push({ type, t: this._t, data });
    if (this.pendingEvents.length > 256) this.pendingEvents.splice(0, this.pendingEvents.length - 256);
  }
}
