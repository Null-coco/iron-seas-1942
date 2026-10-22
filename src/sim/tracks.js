// tracks.js — 【T2】航迹管理：多源数据融合（雷达/目视/声呐/无线电测向）、
// 置信度演变、失跟与重捕、型号识别、位置不确定椭圆、同方共享（含延迟与精度损失）。
//
// ── 模型与依据 ──────────────────────────────────────────────────────────────
// 1) 跟踪滤波：4 维状态 [x, y, vx, vy] 的卡尔曼滤波（匀速模型 + 加速度过程噪声）。
//    舰艇机动缓慢，过程噪声 q≈0.06 m²/s³；推测（无观测）时协方差随时间增长，
//    误差椭圆由 2×2 位置协方差特征值给出（1σ 长/短半轴与方位）。
// 2) 观测模型：
//    · 有距离+方位（雷达/光学测距/主动声呐）→ 极坐标观测转直角坐标，
//      协方差沿径向 σ_R、横向 R·σ_θ 旋转得到（横向误差随距离增长）。
//    · 仅方位（水听器、无线电测向 HFDF）→ EKF 方位观测，H = [cosθ/r, −sinθ/r, 0, 0]；
//      单条方位线只约束横向，需两条以上异舰方位线三角定位（协方差自然反映这一点）。
// 3) 数据融合：同一航迹由多源、多舰观测共同更新（CIC 集中式融合，1942 年由舰内
//    绘图室/旗舰汇总）；逆方差加权在卡尔曼更新中自然实现，置信度按来源与观测质量增长。
// 4) 同方共享：非本舰观测的航迹必须等"报告延迟"后才可见——舰内 CIC 记录 + 无线电语音
//    报告约 5 s；超出无线电地平线（4.12√h，舰桅高度）经中继再加世界 radioRelayPenaltyS
//    （默认 9 s）。共享视图的误差按报告龄期与中继放大，置信度打折——这就是"话音报告"
//    与"数据链"的区别（二战没有数据链）。
// 5) 失跟/重捕：无更新时置信度衰减、协方差膨胀；age>35 s 或置信度<0.22 触发 sensor.lose；
//    120 s 内仍参与关联（重捕），900 s 后删除。重捕成功 emit sensor.detect(reacquired)。
// 6) 型号识别：对目标特征（雷达 RCS、目视舷侧投影面积、桅高）做对数正态似然，
//    在 DD/CL/CA/BC/BB/CV 六类间求后验。观测越多、置信度越高，识别从 UNKNOWN →
//    粗分类（小型/中型/大型）→ 具体舰型演进；雷达只能给 RCS，目视给面积与桅高。
// 7) 随机数只走 world.rng（本模块不抽随机，观测噪声在传感器侧生成）。
import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, aspectAngle, deg2rad, rad2deg, mps2kn } from '../core/util.js';

let TSEQ = 0;

// ── 型号特征表（舷侧，与 sensors.js RCS_TABLE、vision.js 投影面积一致）──
const TYPE_PROFILE = {
  DD: { rcs: 1200, area: 950, mast: 22 },
  CL: { rcs: 2800, area: 1800, mast: 25 },
  CA: { rcs: 4200, area: 2400, mast: 30 },
  BC: { rcs: 8000, area: 3400, mast: 36 },
  BB: { rcs: 18000, area: 4700, mast: 42 },
  CV: { rcs: 22000, area: 3600, mast: 30 },
};
const TYPE_KEYS = Object.keys(TYPE_PROFILE);

// 各传感器一次观测对置信度的信息增益（目视确认最强：1942 年"看到才算数"）
const SRC_GAIN = { RADAR: 0.06, VISUAL: 0.10, SONAR: 0.06, HFDF: 0.03, WAKE: 0.05, SCRIPT: 0.25 };
// 观测信息量：置信度按信息量指数收敛（0.28 + 0.70(1−e^(−info/14))），不会几次观测就饱和
const SRC_INFO = { RADAR: 1.0, VISUAL: 1.25, SONAR: 0.8, HFDF: 0.4, WAKE: 0.7, SCRIPT: 2.0 };
// 判型信息量：识别需要持续观测 60–300 s；雷达只能估 RCS，目视信息更多
const SRC_ID_INFO = { RADAR: 0.35, VISUAL: 0.8, SONAR: 0.3, HFDF: 0.15, WAKE: 0.2, SCRIPT: 1.0 };
const VISIBLE_AGE_S = 150;   // 超过此龄的航迹不参与战术显示
const LOSE_AGE_S = 35;       // 无更新 35 s 判失跟
const REACQUIRE_AGE_S = 240; // 240 s 内仍可重捕
const REMOVE_AGE_S = 900;
const RADIO_HORIZON_M = 4122; // 4.12 km/√m

// ════════════════════════════════════════════════════════════════════════════
// 4×4 矩阵工具（行主序）
// ════════════════════════════════════════════════════════════════════════════
function I4() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function mul4(a, b) {
  const o = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
    o[i * 4 + j] = s;
  }
  return o;
}
function tr4(a) {
  const o = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) o[i * 4 + j] = a[j * 4 + i];
  return o;
}
function inv2(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [1e6, 0, 0, 1e6];
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id];
}

// 位置观测更新（K 为 4×2 行主序，R 为 2×2）
function joseph2(P, K, R) {
  const A = [
    1 - K[0], -K[1], 0, 0,
    -K[2], 1 - K[3], 0, 0,
    -K[4], -K[5], 1, 0,
    -K[6], -K[7], 0, 1,
  ];
  const Pn = mul4(mul4(A, P), tr4(A));
  for (let i = 0; i < 4; i++) {
    const ki0 = K[i * 2], ki1 = K[i * 2 + 1];
    for (let j = 0; j < 4; j++) {
      const kj0 = K[j * 2], kj1 = K[j * 2 + 1];
      Pn[i * 4 + j] += ki0 * R[0] * kj0 + ki0 * R[1] * kj1 + ki1 * R[2] * kj0 + ki1 * R[3] * kj1;
    }
  }
  return Pn;
}
// 方位观测更新（H=[h0,h1,0,0]，K 长度 4，σ² 为方位方差 rad²）
function joseph1(P, K, h0, h1, sigma2) {
  const A = I4();
  for (let i = 0; i < 4; i++) { A[i * 4 + 0] -= K[i] * h0; A[i * 4 + 1] -= K[i] * h1; }
  const Pn = mul4(mul4(A, P), tr4(A));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Pn[i * 4 + j] += K[i] * sigma2 * K[j];
  return Pn;
}

// 协方差稳定化：对称化 + 特征值下限，避免"巨径向方差+小横向方差"的方位-only 滤波
// 在数值上塌缩（1940s 绘图员靠人工平差，这里给数值一个物理下限）。
function stabilizeCov(P) {
  if (!P || P.length !== 16) return P;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(P[i])) return null;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const v = 0.5 * (P[i * 4 + j] + P[j * 4 + i]);
    P[i * 4 + j] = v; P[j * 4 + i] = v;
  }
  const P00 = P[0], P11 = P[5], P01 = P[1];
  const mean = 0.5 * (P00 + P11);
  const disc = Math.sqrt(Math.max(0, Math.pow(0.5 * (P00 - P11), 2) + P01 * P01));
  const l2 = mean - disc;
  if (l2 < 25) { const lift = 25 - l2; P[0] += lift; P[5] += lift; }
  if (P[10] < 1) P[10] = 1;
  if (P[15] < 1) P[15] = 1;
  return P;
}

// ════════════════════════════════════════════════════════════════════════════
export class TrackManager {
  constructor(world) {
    this.world = world;
    this.tracks = [];
    this._mergeAcc = 0;
  }

  _now() { return (this.world && this.world.t) || 0; }
  _ship(id) { return (this.world && typeof this.world.ship === 'function') ? this.world.ship(id) : null; }
  _emit(type, payload) {
    if (this.world && this.world.events && typeof this.world.events.emit === 'function') {
      try { this.world.events.emit(type, payload); } catch (e) { /* ignore */ }
    }
  }

  // ── 观测协方差（2×2，行主序）──────────────────────────────────────────────
  _obsCov(obs) {
    const sigR = (obs.accuracyM !== undefined && obs.accuracyM !== null) ? Math.max(10, obs.accuracyM) : null;
    if (sigR === null) return null;
    const sigB = deg2rad(Math.max(0.02, obs.accuracyDeg || 1));
    const R = (obs.rangeM !== undefined && obs.rangeM !== null) ? Math.abs(obs.rangeM)
      : Math.hypot(obs.pos.x - (obs.observerPos ? obs.observerPos.x : 0), obs.pos.y - (obs.observerPos ? obs.observerPos.y : 0));
    const cross = Math.max(30, R * sigB);
    const b = deg2rad(obs.bearingDeg || 0);
    const ux = Math.sin(b), uy = Math.cos(b);   // 径向
    const px = Math.cos(b), py = -Math.sin(b);  // 横向
    const Rxx = sigR * sigR * ux * ux + cross * cross * px * px;
    const Ryy = sigR * sigR * uy * uy + cross * cross * py * py;
    const Rxy = sigR * sigR * ux * uy + cross * cross * px * py;
    return [Rxx, Rxy, Rxy, Ryy];
  }

  // ── 观测入口（契约）────────────────────────────────────────────────────────
  observe(obs) {
    if (!obs || !obs.side) return null;
    const t = obs.t !== undefined ? obs.t : this._now();
    const observerPos = obs.observerPos || (obs.shipId ? ((this._ship(obs.shipId) || {}).pos) : null);
    const bearingOnly = obs.bearingOnly === true || obs.rangeM === null || obs.rangeM === undefined
      || (obs.accuracyM === null || obs.accuracyM === undefined);
    // 规范化观测位置：方位-only 时若给了 pos 也仅作猜测点
    let pos = obs.pos;
    if (!pos) {
      if (!observerPos || obs.bearingDeg === undefined) return null;
      const assumed = obs.rangeM !== null && obs.rangeM !== undefined ? obs.rangeM : 12000;
      pos = destPoint(observerPos, assumed, obs.bearingDeg);
    }

    // 距离-only 观测（无测向能力的早期雷达）：只修正已有航迹的距离；没有航迹则忽略
    if (obs.rangeOnly === true) {
      if (!observerPos || !(obs.rangeM > 0)) return null;
      const gate = Math.max(700, 3.0 * (obs.accuracyM || 100) + 0.5 * 400);
      let best = null, bd = Infinity;
      for (const tr of this.tracks) {
        if (tr.dead || tr.side !== obs.side) continue;
        if (t - tr.tLast > REACQUIRE_AGE_S) continue;
        const d = Math.abs(dist2d(observerPos, tr.pos) - obs.rangeM);
        if (d < gate && d < bd) { bd = d; best = tr; }
      }
      if (!best) return null;
      return this._updateRangeOnly(best, obs, t, observerPos);
    }

    const track = this._associate(obs, pos, bearingOnly, t, observerPos);
    if (track) return this._updateTrack(track, obs, pos, bearingOnly, t, observerPos);
    return this._createTrack(obs, pos, bearingOnly, t, observerPos);
  }

  // ── 关联：最近邻 + 协方差门限 ──────────────────────────────────────────────
  _associate(obs, pos, bearingOnly, t, observerPos) {
    let best = null, bestScore = Infinity;
    for (const tr of this.tracks) {
      if (tr.dead || tr.side !== obs.side) continue;
      const age = t - tr.tLast;
      if (age > REACQUIRE_AGE_S) continue;
      const dtPred = Math.max(0, age);
      const baseSigma = Math.sqrt(Math.max(1, tr.P[0] + tr.P[5]));
      if (bearingOnly) {
        if (!observerPos) continue;
        const predB = bearing2d(observerPos, tr.pos);
        const sigB = deg2rad(Math.max(0.3, obs.accuracyDeg || 3));
        const gate = deg2rad(Math.max(6.0, 3.5 * (obs.accuracyDeg || 3))); // 方位门限（含航向不确定性/三角定位）
        const dB = Math.abs(normDeg180(predB - (obs.bearingDeg || 0))) * Math.PI / 180;
        const predR = dist2d(observerPos, tr.pos);
        if (predR > 45000) continue;
        if (dB > gate) continue;
        // HFDF/水听器没有距离信息，用预测量级给更大门限：方位差越小越优先
        const score = dB / gate + (predR > 30000 ? 0.5 : 0);
        if (score < bestScore) { bestScore = score; best = tr; }
      } else {
        const d = dist2d(tr.pos, pos);
        const sigObs = Math.max(60, obs.accuracyM || 100);
        // 关键：位置散布的主导项是"横向（方位）误差"，不是距离误差。
        // 15km 处 8° 方位误差 = 2.1km 横向散布；只用距离误差(±100m)做门限必然关联失败。
        const obsRange = (obs.rangeM !== null && obs.rangeM !== undefined) ? obs.rangeM : (observerPos ? dist2d(observerPos, pos) : 0);
        const crossSig = obs.accuracyDeg ? obsRange * Math.tan(deg2rad(Math.min(45, obs.accuracyDeg))) : 0;
        const sigGate = Math.hypot(sigObs, crossSig);
        const maneuver = 0.6 * Math.max(1, Math.hypot(tr.vel.x, tr.vel.y)) * dtPred; // 目标可能机动
        const gate = Math.max(900, 3 * baseSigma + 2.5 * sigGate + maneuver + 200);
        if (d > gate) continue;
        const score = d / gate;
        if (score < bestScore) { bestScore = score; best = tr; }
      }
    }
    return best;
  }

  _createTrack(obs, pos, bearingOnly, t, observerPos) {
    const now = t;
    {
      const tr = {
        id: 'T' + (++TSEQ),
        side: obs.side,
        pos: { x: pos.x, y: pos.y },
        vel: { x: 0, y: 0 },
        P: new Array(16).fill(0),
        courseDeg: 0, speedKn: 0, courseValid: false,
        errM: 0, errDeg: 1, errMajorM: 0, errMinorM: 0, errOrientationDeg: 0,
        confidence: 0.35, idConfidence: 0, classifiedAs: 'UNKNOWN', classProbs: null,
        sources: [], sourceShips: [], lastObsByShip: {}, obsTimesByShip: {}, firstObsByShip: {},
        hostile: obs.hostile === false ? false : true,
        tFirst: now, tLast: now, ageS: 0, hits: 0, lost: false,
        bearingOnly: !!bearingOnly, hasRange: !bearingOnly,
        info: 0, _idInfo: 0, _bias: {}, lastObsRangeM: null,
        _feat: {}, _trueIds: new Set(), rev: 0,
      };
      this._applyObservation(tr, obs, pos, bearingOnly, t, observerPos);
      this._updateConfidence(tr, obs);
      // 初始化协方差
      const cov = this._obsCov(obs);
      const P = new Array(16).fill(0);
      if (!bearingOnly && cov) {
        P[0] = cov[0]; P[1] = cov[1]; P[4] = cov[1]; P[5] = cov[3];
      } else {
        const b = deg2rad(obs.bearingDeg || 0);
        const ux = Math.sin(b), uy = Math.cos(b);
        const px = Math.cos(b), py = -Math.sin(b);
        const assumedR = 12000;
        const sr = 8000; // 径向完全未知（方位线只约束横向）
        const sc = Math.max(400, assumedR * deg2rad(Math.max(0.5, obs.accuracyDeg || 4)));
        P[0] = sr * sr * ux * ux + sc * sc * px * px;
        P[5] = sr * sr * uy * uy + sc * sc * py * py;
        P[1] = P[4] = sr * sr * ux * uy + sc * sc * px * py;
      }
      P[10] = P[15] = bearingOnly ? 625 : 324; // 速度先验 (25/18 m/s)²
      tr.P = stabilizeCov(P) || P;
      this._refreshUncertainty(tr);
      this._classify(tr);
      this.tracks.push(tr);
      this._emit('sensor.detect', {
        t: this.world ? this.world.t : now, side: tr.side, ship: obs.shipId || null,
        by: obs.shipId || null, source: obs.srcKind, src: obs.srcKind,
        target: tr.id, rangeM: obs.rangeM === undefined ? null : obs.rangeM,
        bearingDeg: obs.bearingDeg, errM: Math.round(tr.errM), errDeg: +tr.errDeg.toFixed(2),
        confidence: +tr.confidence.toFixed(2), classifiedAs: tr.classifiedAs,
        x: Math.round(tr.pos.x), y: Math.round(tr.pos.y), reacquired: false,
      });
      return tr;
    }
  }

  _updateTrack(tr, obs, pos, bearingOnly, t, observerPos) {
    const wasLost = tr.lost;
    this._applyObservation(tr, obs, pos, bearingOnly, t, observerPos);
    // 卡尔曼更新
    if (!bearingOnly && obs.accuracyM) {
      const Rm = this._obsCov(obs);
      if (Rm) {
        const S = [tr.P[0] + Rm[0], tr.P[1] + Rm[1], tr.P[1] + Rm[1], tr.P[5] + Rm[3]];
        const Si = inv2(S);
        const K = new Array(8);
        for (let i = 0; i < 4; i++) {
          const p0 = tr.P[i * 4 + 0], p1 = tr.P[i * 4 + 1];
          K[i * 2 + 0] = p0 * Si[0] + p1 * Si[2];
          K[i * 2 + 1] = p0 * Si[1] + p1 * Si[3];
        }
        const yx = pos.x - tr.pos.x, yy = pos.y - tr.pos.y;
        tr.pos.x += K[0] * yx + K[1] * yy;
        tr.pos.y += K[2] * yx + K[3] * yy;
        tr.vel.x += K[4] * yx + K[5] * yy;
        tr.vel.y += K[6] * yx + K[7] * yy;
        tr.P = stabilizeCov(joseph2(tr.P, K, Rm)) || tr.P;
        this._clampVelocity(tr);
        tr.hasRange = true;
        tr.bearingOnly = false;
      }
    } else if (observerPos && obs.bearingDeg !== undefined) {
      const dx = tr.pos.x - observerPos.x, dy = tr.pos.y - observerPos.y;
      const r = Math.max(30, Math.hypot(dx, dy));
      const theta = normDeg(rad2deg(Math.atan2(dx, dy)));
      const innov = normDeg180((obs.bearingDeg || 0) - theta) * Math.PI / 180; // rad
      const sigBase = deg2rad(Math.max(0.2, obs.accuracyDeg || 3));
      // 已有距离信息的航迹：方位-only 观测（水听器 2–5°、无线电测向 1–2°）只做小幅横向修正，
      // 既不能用它推速度，也不能让它把雷达/光学距离航迹拖走。
      const rangedTrack = tr.hasRange === true;
      // 方位-only 传感器对"已有距离"的航迹几乎没有信息量（雷达/光学方位更准），
      // 把它的等效误差放大 8 倍，使更新只做几十米级的横向微调。
      const sig = sigBase * (rangedTrack ? 8.0 : 1.0);
      const inconsistent = Math.abs(innov) > Math.max((rangedTrack ? 3 : 6) * sigBase, (rangedTrack ? 3 : 6) * Math.PI / 180);
      if (inconsistent) {
        // 与已有航迹位置矛盾：不更新（避免一次错误关联毁掉航迹），仅略微放宽协方差
        tr.P[0] += 9; tr.P[5] += 9;
      } else {
        const h0 = Math.cos(theta * Math.PI / 180) / r;
        const h1 = -Math.sin(theta * Math.PI / 180) / r;
        const PHt = new Array(4);
        for (let i = 0; i < 4; i++) PHt[i] = tr.P[i * 4 + 0] * h0 + tr.P[i * 4 + 1] * h1;
        const S = h0 * PHt[0] + h1 * PHt[1] + sig * sig;
        const K = new Array(4);
        for (let i = 0; i < 4; i++) K[i] = PHt[i] / Math.max(1e-12, S);
        if (rangedTrack) { K[2] *= 0.02; K[3] *= 0.02; } // 不用方位线推速度
        const maxStep = rangedTrack ? 90 : 2500;
        const step = Math.hypot(K[0] * innov, K[1] * innov);
        if (step > maxStep) { const sc = maxStep / step; for (let i = 0; i < 4; i++) K[i] *= sc; }
        tr.pos.x += K[0] * innov; tr.pos.y += K[1] * innov;
        tr.vel.x += K[2] * innov; tr.vel.y += K[3] * innov;
        this._clampVelocity(tr);
        tr.P = stabilizeCov(joseph1(tr.P, K, h0, h1, sig * sig)) || tr.P;
      }
    }
    tr.rev++;
    this._updateConfidence(tr, obs);
    this._refreshUncertainty(tr);
    this._classify(tr);
    if (wasLost) {
      tr.lost = false;
      this._emit('sensor.detect', {
        t: this.world ? this.world.t : t, side: tr.side, ship: obs.shipId || null,
        by: obs.shipId || null, source: obs.srcKind, src: obs.srcKind,
        target: tr.id, rangeM: obs.rangeM === undefined ? null : obs.rangeM,
        bearingDeg: obs.bearingDeg, errM: Math.round(tr.errM), errDeg: +tr.errDeg.toFixed(2),
        confidence: +tr.confidence.toFixed(2), classifiedAs: tr.classifiedAs,
        x: Math.round(tr.pos.x), y: Math.round(tr.pos.y), reacquired: true,
      });
    }
    return tr;
  }

  // 速度物理约束：无可靠方位变化率时不应显示几十节的"幽灵航速"
  _clampVelocity(tr) {
    const sp = Math.hypot(tr.vel.x, tr.vel.y);
    const max = 25; // 46.9 kn，超过任何 1942 年水面舰
    if (sp > max) { const sc = max / sp; tr.vel.x *= sc; tr.vel.y *= sc; }
  }

  // ── 距离-only 更新（无测向能力的早期雷达）：沿观测者-目标径向做一维卡尔曼修正 ──
  _updateRangeOnly(tr, obs, t, observerPos) {
    const wasLost = tr.lost;
    this._applyObservation(tr, obs, { x: tr.pos.x, y: tr.pos.y }, false, t, observerPos);
    const dx = tr.pos.x - observerPos.x, dy = tr.pos.y - observerPos.y;
    const r = Math.max(50, Math.hypot(dx, dy));
    const ux = dx / r, uy = dy / r;
    const sig = Math.max(20, obs.accuracyM || 100);
    const PHt = [
      tr.P[0] * ux + tr.P[1] * uy,
      tr.P[4] * ux + tr.P[5] * uy,
      tr.P[8] * ux + tr.P[9] * uy,
      tr.P[12] * ux + tr.P[13] * uy,
    ];
    const S = ux * PHt[0] + uy * PHt[1] + sig * sig;
    const K = PHt.map((v) => v / Math.max(1e-12, S));
    // 只有距离、没有方位变化率：不更新速度（否则会产生幽灵航速）
    K[2] = 0; K[3] = 0;
    const innov = Math.max(-4000, Math.min(4000, (obs.rangeM || r) - r));
    const step = Math.hypot(K[0] * innov, K[1] * innov);
    if (step > 500) { const sc = 500 / step; for (let i = 0; i < 2; i++) K[i] *= sc; }
    tr.pos.x += K[0] * innov; tr.pos.y += K[1] * innov;
    tr.P = stabilizeCov(joseph1(tr.P, K, ux, uy, sig * sig)) || tr.P;
    this._clampVelocity(tr);
    tr.rev++;
    this._updateConfidence(tr, obs);
    this._refreshUncertainty(tr);
    this._classify(tr);
    if (wasLost) {
      tr.lost = false;
      this._emit('sensor.detect', {
        t: this.world ? this.world.t : t, side: tr.side, ship: obs.shipId || null,
        by: obs.shipId || null, source: obs.srcKind, src: obs.srcKind,
        target: tr.id, rangeM: obs.rangeM, bearingDeg: null,
        errM: Math.round(tr.errM), errDeg: +tr.errDeg.toFixed(2),
        confidence: +tr.confidence.toFixed(2), classifiedAs: tr.classifiedAs,
        x: Math.round(tr.pos.x), y: Math.round(tr.pos.y), reacquired: true,
      });
    }
    return tr;
  }

  // ── 置信度：按信息量缓慢收敛，并按夜色/距离/来源封顶 ─────────────────────
  _updateConfidence(tr, obs) {
    const w = SRC_INFO[obs.srcKind] !== undefined ? SRC_INFO[obs.srcKind] : 0.7;
    tr.info = (tr.info || 0) + w;
    const idW = SRC_ID_INFO[obs.srcKind] !== undefined ? SRC_ID_INFO[obs.srcKind] : 0.2;
    tr._idInfo = (tr._idInfo || 0) + idW * ((obs.rangeM !== null && obs.rangeM !== undefined) ? 1 : 0.45);
    const env = this.world && this.world.env;
    const light = (env && env.lightLevel !== undefined) ? env.lightLevel : 1;
    let cap = 0.95;
    if (light < 0.08) cap = 0.85; // 无月/暗夜：即使是雷达航迹也难 100% 确认
    const R = tr.lastObsRangeM;
    if (R) {
      if (R > 25000) cap = Math.min(cap, 0.88);
      else if (R > 15000) cap = Math.min(cap, 0.92);
    }
    if (tr.bearingOnly && !tr.hasRange) cap = 0.60;
    const conf = 0.28 + 0.70 * (1 - Math.exp(-(tr.info || 0) / 14));
    // 平滑上升：单次高置信观测不会让航迹瞬间跳到 0.98
    tr.confidence = clamp(Math.max(tr.confidence * 0.85, Math.min(conf, cap)), 0, cap);
  }

  // ── 各传感器的系统误差下限（多次观测平均不掉的部分）──────────────────────
  // 1941 年火控/绘图室的现实：雷达测距精确（25–75 m）但方位标定差（1–3°）；
  // 重合式测距仪随机误差可平均，但折射/基线/装订残差 ~0.2%R+20 m 是系统性的；
  // 水听器/无线电测向只有方位线，位置误差以千米计。
  _observationBias(obs) {
    if (!obs) return null;
    const R = (obs.rangeM !== null && obs.rangeM !== undefined && Number.isFinite(obs.rangeM))
      ? Math.abs(obs.rangeM)
      : (obs.observerPos ? Math.max(500, dist2d(obs.observerPos, obs.pos)) : 8000);
    const sigR = Math.max(20, obs.accuracyM || 80);
    switch (obs.srcKind) {
      case 'RADAR':
        if (obs.rangeOnly) return { m: Math.max(25, 0.5 * sigR), deg: 180 }; // 无方位信息，不参与方位下限
        return {
          m: Math.sqrt(Math.pow(Math.max(25, 0.5 * sigR), 2) + Math.pow(R * deg2rad(1.0), 2)),
          deg: Math.max(0.8, (obs.accuracyDeg || 1.5) * 0.7),
        };
      case 'VISUAL':
        if (obs.bearingOnly) return { m: Math.max(700, 0.10 * R), deg: 0.5 };
        return {
          m: Math.sqrt(Math.pow(Math.max(20, 0.0025 * R + 0.5 * sigR), 2) + Math.pow(R * deg2rad(0.2), 2)),
          deg: 0.25,
        };
      case 'SONAR':
        return obs.bearingOnly
          ? { m: Math.max(1200, 0.12 * R), deg: 2.5 }
          : { m: Math.sqrt(Math.pow(Math.max(60, 0.02 * R), 2) + Math.pow(R * deg2rad(2.0), 2)), deg: 2.0 };
      case 'HFDF':
        return { m: Math.max(1200, 0.12 * R), deg: 1.0 };
      default:
        return { m: Math.max(80, 0.02 * R), deg: 0.8 };
    }
  }

  _biasFloor(tr) {
    const list = Object.keys(tr._bias || {}).map((k) => tr._bias[k]).filter(Boolean);
    if (!list.length) return { m: 40, deg: 0.5 };
    let m = Infinity, deg = Infinity;
    for (const b of list) { m = Math.min(m, b.m); deg = Math.min(deg, b.deg); }
    if (!Number.isFinite(m)) m = 40;
    if (!Number.isFinite(deg)) deg = 0.5;
    if (tr._bias.RADAR || tr._bias.SONAR) deg = Math.max(deg, 0.8);
    m = Math.max(m, 50);   // 1941 年绘图室标绘精度下限 ~50 m
    deg = Math.max(deg, 0.6);
    if (tr.bearingOnly && !tr.hasRange) { m = Math.max(m, 1200); deg = Math.max(deg, 1.5); }
    return { m, deg };
  }

  // 把观测元数据写入航迹（与滤波分开，创建/更新共用）
  _applyObservation(tr, obs, pos, bearingOnly, t, observerPos) {
    const srcKey = obs.sensorKind || obs.srcKind; // 区分主动声呐 SONAR 与被动水听器 HYDRO
    if (!tr.sources.includes(srcKey)) tr.sources.push(srcKey);
    if (obs.shipId && !tr.sourceShips.includes(obs.shipId)) tr.sourceShips.push(obs.shipId);
    if (obs.shipId) {
      tr.lastObsByShip[obs.shipId] = t;
      if (tr.firstObsByShip[obs.shipId] === undefined) tr.firstObsByShip[obs.shipId] = t;
      const hist = tr.obsTimesByShip[obs.shipId] || (tr.obsTimesByShip[obs.shipId] = []);
      hist.push(t);
      if (hist.length > 80) hist.shift();
    }
    if (obs.targetId) tr._trueIds.add(obs.targetId);
    tr.hits += 1;
    tr.tLast = Math.max(tr.tLast, t);
    tr.ageS = Math.max(0, t - tr.tLast);
    tr.lost = false;
    if (!bearingOnly) { tr.hasRange = true; tr.bearingOnly = false; }
    if (obs.rangeM !== null && obs.rangeM !== undefined && Number.isFinite(obs.rangeM)) tr.lastObsRangeM = Math.abs(obs.rangeM);
    const bias = this._observationBias(obs);
    if (bias) tr._bias[obs.srcKind] = bias;
    this._accumulateFeatures(tr, obs, pos);
  }

  // ── 特征累积（用于型号识别）───────────────────────────────────────────────
  _accumulateFeatures(tr, obs, pos) {
    const f = obs.features;
    if (!f) return;
    const add = (key, logVal, sigmaLog) => {
      if (logVal === undefined || logVal === null || !Number.isFinite(logVal)) return;
      const varM = Math.max(0.0004, Math.pow(sigmaLog || 0.3, 2));
      const node = tr._feat[key] || { v: 0, w: 0, var: 0 };
      const prec = 1 / varM;
      node.v = (node.v * node.w + logVal * prec) / (node.w + prec);
      node.w += prec;
      node.var = 1 / node.w;
      tr._feat[key] = node;
    };
    // 从观察者到目标的方位 = 目标"被看到的舷角"（0=艏向观察者）
    let aspect = 60, aspectUnknown = true;
    if (tr.courseValid) {
      const bToObs = bearing2d(tr.pos, pos);
      aspect = aspectAngle(tr.courseDeg, bToObs);
      aspectUnknown = false;
    }
    if (f.rcsM2 > 0) {
      const af = 0.30 + 0.70 * Math.pow(Math.sin(clamp(aspect, 0, 180) * Math.PI / 180), 2);
      add('logRcs', Math.log(f.rcsM2 / Math.max(0.12, af)), f.rcsSigmaLog || 0.4);
    }
    if (f.areaM2 > 0) {
      const aRad = clamp(aspect, 0, 180) * Math.PI / 180;
      const ratio = Math.max(0.15, Math.sin(aRad) + 0.12 * Math.cos(aRad)); // 投影/舷侧
      const extra = aspectUnknown ? 0.25 : 0.03;
      add('logArea', Math.log(f.areaM2 / ratio), Math.sqrt(Math.pow(f.areaSigmaLog || 0.3, 2) + extra * extra));
    }
    if (f.mastM > 0) add('logMast', Math.log(f.mastM), f.mastSigmaLog || 0.3);
  }

  // ── 型号识别：对数正态似然 → 后验 ────────────────────────────────────────
  _classify(tr) {
    const f = tr._feat;
    if (!f || (!f.logRcs && !f.logArea && !f.logMast)) {
      if (tr.classifiedAs === 'UNKNOWN') tr.idConfidence = 0;
      return;
    }
    const lls = {};
    let maxLl = -Infinity, used = 0;
    for (const k of TYPE_KEYS) {
      const P = TYPE_PROFILE[k];
      let ll = 0;
      if (f.logRcs) ll -= 0.5 * Math.pow(f.logRcs.v - Math.log(P.rcs), 2) / (f.logRcs.var + 0.30 * 0.30);
      if (f.logArea) ll -= 0.5 * Math.pow(f.logArea.v - Math.log(P.area), 2) / (f.logArea.var + 0.35 * 0.35);
      if (f.logMast) ll -= 0.5 * Math.pow(f.logMast.v - Math.log(P.mast), 2) / (f.logMast.var + 0.25 * 0.25);
      lls[k] = ll;
      if (ll > maxLl) maxLl = ll;
      used++;
    }
    if (!used) return;
    let sum = 0;
    const probs = {};
    for (const k of TYPE_KEYS) { probs[k] = Math.exp(lls[k] - maxLl); sum += probs[k]; }
    for (const k of TYPE_KEYS) probs[k] /= sum;
    let top = TYPE_KEYS[0];
    for (const k of TYPE_KEYS) if (probs[k] > probs[top]) top = k;
    // 判型置信度 = 后验概率 × 信息量门控 × 观测时长门控，再按距离/夜色封顶。
    // 1942 年判型主要靠目视识别（舰影、桅杆、烟囱、炮塔数），雷达 RCS 只能给"大小"，
    // 因此需要持续观测 1–5 分钟才敢下结论；夜间/远距离识别置信度封顶。
    const dur = Math.max(0, tr.tLast - tr.tFirst);
    const idGate = clamp((tr._idInfo || 0) / 60, 0.05, 1);
    const durGate = clamp(dur / 180, 0.05, 1);
    const env = this.world && this.world.env;
    const light = (env && env.lightLevel !== undefined) ? env.lightLevel : 1;
    let idCap = 0.95;
    if (light < 0.08) idCap = 0.70;                     // 无月/暗夜：判型不可靠
    else if (light < 0.25) idCap = 0.82;                // 月光/晨昏
    const obsR = tr.lastObsRangeM || 0;
    if (obsR > 20000) idCap = Math.min(idCap, 0.70);
    else if (obsR > 12000) idCap = Math.min(idCap, 0.82);
    tr.classProbs = probs;
    tr.idConfidence = clamp(probs[top] * idGate * durGate, 0, idCap);
    if (tr.idConfidence >= 0.50 && dur >= 60) {
      tr.classifiedAs = top;
    } else if (tr.idConfidence >= 0.18 && dur >= 20) {
      // 1942 年识别习惯：先分小型/中型/大型，再定舰型
      const size = f.logRcs ? Math.exp(f.logRcs.v) : (f.logArea ? Math.exp(f.logArea.v) / 0.55 : 4200);
      tr.classifiedAs = size < 2200 ? 'DD' : (size < 8000 ? 'CA' : 'BB');
    } else {
      tr.classifiedAs = 'UNKNOWN';
    }
  }

  // ── 不确定度椭圆（1σ）─────────────────────────────────────────────────────
  _refreshUncertainty(tr) {
    const P00 = tr.P[0], P11 = tr.P[5], P01 = tr.P[1];
    const mean = 0.5 * (P00 + P11);
    const disc = Math.sqrt(Math.max(0, Math.pow(0.5 * (P00 - P11), 2) + P01 * P01));
    const l1 = Math.max(1, mean + disc), l2 = Math.max(1, mean - disc);
    tr.errMajorM = Math.sqrt(l1);
    tr.errMinorM = Math.sqrt(l2);
    tr.errOrientationDeg = normDeg(rad2deg(0.5 * Math.atan2(2 * P01, P00 - P11)));
    const rawErrM = Math.sqrt(P00 + P11);
    const floor = this._biasFloor(tr);
    tr.errRawM = rawErrM;                       // 纯滤波协方差（调试用）
    tr.errM = Math.max(rawErrM, floor.m);       // 融合估计不确定度：不得低于传感器系统误差下限
    tr.errMajorM = Math.max(tr.errMajorM, tr.errM * 0.55);
    tr.errMinorM = Math.max(tr.errMinorM, tr.errM * 0.30);
    const velSigma = Math.sqrt(Math.max(0, tr.P[10] + tr.P[15]));
    const speed = Math.hypot(tr.vel.x, tr.vel.y);
    const plausible = speed > 0.5 && speed <= 25;
    tr.courseValid = velSigma < 6 && tr.hits >= 3 && plausible;
    tr.speedKn = tr.courseValid ? speed * 1.94384 : 0;   // 不可信时不给航速（避免幽灵航速）
    tr.courseDeg = tr.courseValid ? normDeg(rad2deg(Math.atan2(tr.vel.x, tr.vel.y))) : 0;
    tr.velSigmaMps = velSigma;
    // 方位误差（供显示）= 横向位置误差 ÷ 距离。
    // 【修复】原式 rad2deg(errMinorM / 1000) 把"米/1000"当成弧度，量纲错误，
    // 使报出的方位误差被放大 R/1000 倍（8km 处约 8 倍、15km 处约 15 倍），并顶到 90° 上限。
    const refR = Math.max(500, tr.lastObsRangeM || tr.rangeM || 15000);
    tr.errDeg = Math.max(floor.deg, clamp(rad2deg(tr.errMinorM / refR), 0.05, 45));
  }

  // ── 推测与生命周期 ────────────────────────────────────────────────────────
  _predict(tr, dt) {
    if (dt <= 0) return;
    const F = [1, 0, dt, 0, 0, 1, 0, dt, 0, 0, 1, 0, 0, 0, 0, 1];
    const P = mul4(mul4(F, tr.P), tr4(F));
    const q = tr.bearingOnly ? 0.20 : 0.06; // 加速度谱密度 m²/s³
    const q11 = q * dt * dt * dt / 3, q12 = q * dt * dt / 2, q22 = q * dt;
    P[0] += q11; P[5] += q11;
    P[10] += q22; P[15] += q22;
    P[1] += q12; P[4] += q12; P[2] += q12; P[8] += q12;   // 位置-速度相关
    P[6] += q12; P[9] += q12; P[7] += q12; P[13] += q12;
    tr.P = stabilizeCov(P) || P;
    tr.pos.x += tr.vel.x * dt;
    tr.pos.y += tr.vel.y * dt;
  }

  // ── 每帧：推测、置信度衰减、失跟、重捕窗口、合并重复航迹 ─────────────────
  update(dt) {
    dt = dt || 0;
    const t = this._now();
    for (const tr of this.tracks) {
      if (tr.dead) continue;
      this._predict(tr, dt);
      tr.ageS = Math.max(0, t - tr.tLast);
      const decay = tr.bearingOnly ? 0.0060 : 0.0035; // 每秒置信度衰减
      tr.confidence = clamp(tr.confidence - decay * dt, 0, 0.995);
      tr.idConfidence = Math.max(0, tr.idConfidence - 0.0015 * dt);
      this._refreshUncertainty(tr);
      if (!tr.lost && (tr.ageS > LOSE_AGE_S || tr.confidence < 0.22)) {
        tr.lost = true;
        this._emit('sensor.lose', {
          t, side: tr.side, target: tr.id, ship: tr.sourceShips[0] || null,
          by: tr.sourceShips[0] || null, source: tr.sources[0] || null,
          ageS: +tr.ageS.toFixed(1), confidence: +tr.confidence.toFixed(2),
          rangeM: tr.lastObsRangeM || null, errM: Math.round(tr.errM), errDeg: +tr.errDeg.toFixed(2),
        });
      }
    }
    // 每 4 s 合并重复航迹（雷达/目视各自起批造成的重影）
    this._mergeAcc += dt;
    if (this._mergeAcc >= 4) { this._mergeAcc = 0; this._mergeDuplicates(); }
    this.tracks = this.tracks.filter((tr) => !tr.dead && tr.ageS < REMOVE_AGE_S);
  }

  _mergeDuplicates() {
    const arr = this.tracks;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (!a || a.dead) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (!b || b.dead || b.side !== a.side) continue;
        if (b.ageS > REACQUIRE_AGE_S || a.ageS > REACQUIRE_AGE_S) continue;
        const d = dist2d(a.pos, b.pos);
        const gate = Math.max(450, 2.5 * Math.max(a.errM, b.errM));
        if (d > gate) continue;
        if (a.courseValid && b.courseValid) {
          if (Math.abs(normDeg180(a.courseDeg - b.courseDeg)) > 40) continue;
          if (Math.abs(a.speedKn - b.speedKn) > 9) continue;
        }
        const keep = a.tFirst <= b.tFirst ? a : b;
        const drop = keep === a ? b : a;
        const w = clamp(keep.confidence / Math.max(1e-3, keep.confidence + drop.confidence), 0.2, 0.8);
        keep.pos.x = keep.pos.x * w + drop.pos.x * (1 - w);
        keep.pos.y = keep.pos.y * w + drop.pos.y * (1 - w);
        keep.vel.x = keep.vel.x * w + drop.vel.x * (1 - w);
        keep.vel.y = keep.vel.y * w + drop.vel.y * (1 - w);
        keep.confidence = clamp(Math.max(keep.confidence, drop.confidence) + 0.05, 0, 0.99);
        keep.tFirst = Math.min(keep.tFirst, drop.tFirst);
        keep.tLast = Math.max(keep.tLast, drop.tLast);
        keep.hits += drop.hits;
        for (const s of drop.sources) if (!keep.sources.includes(s)) keep.sources.push(s);
        for (const s of drop.sourceShips) if (!keep.sourceShips.includes(s)) keep.sourceShips.push(s);
        for (const k of Object.keys(drop.lastObsByShip)) {
          keep.lastObsByShip[k] = Math.max(keep.lastObsByShip[k] || 0, drop.lastObsByShip[k]);
        }
        if (drop.obsTimesByShip) {
          for (const k of Object.keys(drop.obsTimesByShip)) {
            const merged = (keep.obsTimesByShip[k] || []).concat(drop.obsTimesByShip[k] || []).sort((a, b) => a - b);
            keep.obsTimesByShip[k] = merged.slice(-80);
          }
        }
        if (drop.firstObsByShip) {
          for (const k of Object.keys(drop.firstObsByShip)) {
            const a = keep.firstObsByShip[k], b = drop.firstObsByShip[k];
            keep.firstObsByShip[k] = a === undefined ? b : Math.min(a, b);
          }
        }
        keep._bias = Object.assign({}, drop._bias || {}, keep._bias || {});
        keep.info = Math.max(keep.info || 0, drop.info || 0);
        keep._idInfo = Math.max(keep._idInfo || 0, drop._idInfo || 0);
        for (const id of drop._trueIds) keep._trueIds.add(id);
        keep.P = keep.P.map((v, idx) => Math.max(v, drop.P[idx] * 0.5));
        drop.dead = true;
        if (drop === a) break;
      }
    }
    this.tracks = this.tracks.filter((tr) => !tr.dead);
  }

  // ── 同方共享：报告延迟 + 精度损失 ─────────────────────────────────────────
  _reportDelayS(observerShip, viewerShip) {
    const base = (this.world && this.world.reportDelayS !== undefined) ? this.world.reportDelayS : 5;
    if (!observerShip || !viewerShip || !observerShip.pos || !viewerShip.pos) return base + 3;
    const d = dist2d(observerShip.pos, viewerShip.pos);
    const h1 = Math.max(5, ((observerShip.data && observerShip.data.mastHeight_m) || 20) * 0.85);
    const h2 = Math.max(5, ((viewerShip.data && viewerShip.data.mastHeight_m) || 20) * 0.85);
    const horizon = RADIO_HORIZON_M * (Math.sqrt(h1) + Math.sqrt(h2));
    let delay = base;
    if (d > horizon) delay += (this.world && this.world.radioRelayPenaltyS !== undefined ? this.world.radioRelayPenaltyS : 9);
    return delay;
  }

  _sharedReport(tr, viewerShip) {
    // 话音报告是"排队到达"的：每次观测在 t+delay 时刻到达接收舰。
    // 只要有一条报告已到达即可见；取最新已到达的报告作为视图依据（其龄期=报告延迟）。
    const now = this._now();
    let best = null;
    for (const oid of tr.sourceShips) {
      if (!viewerShip || oid === viewerShip.id) continue;
      const oship = this._ship(oid);
      const delay = this._reportDelayS(oship, viewerShip);
      const hist = (tr.obsTimesByShip && tr.obsTimesByShip[oid]) || [];
      let found = false;
      for (let i = hist.length - 1; i >= 0; i--) {
        const tObs = hist[i];
        if (tObs + delay <= now) {
          if (!best || tObs > best.tObs) best = { observerId: oid, tObs, delay, readyT: tObs + delay };
          found = true;
          break;
        }
      }
      // 报告延迟长于历史窗口时，至少第一条报告已到达就可见（用首报时刻作为视图龄期）
      if (!found) {
        const t0 = tr.firstObsByShip && tr.firstObsByShip[oid];
        if (t0 !== undefined && t0 + delay <= now && (!best || t0 > best.tObs)) {
          best = { observerId: oid, tObs: t0, delay, readyT: t0 + delay };
        }
      }
    }
    if (!best) return null;
    return Object.assign(best, { ready: true, reportAgeS: Math.max(0, now - best.tObs) });
  }

  // 单舰视角（含共享延迟/精度损失）
  _viewFor(tr, ship) {
    const sharedInfo = this._sharedReport(tr, ship);
    const isOwner = ship && tr.sourceShips.includes(ship.id);
    if (!isOwner) {
      if (!sharedInfo || !sharedInfo.ready) return null;
    }
    const reportAgeS = isOwner ? Math.max(0, this._now() - tr.tLast) : sharedInfo.reportAgeS;
    const ageFactor = isOwner ? 1 : clamp(1.25 + reportAgeS / 300, 1.25, 2.2);
    const confFactor = isOwner ? 1 : clamp(0.90 - reportAgeS / 2000, 0.65, 0.9);
    // 观察者视角的横向误差 → 方位误差
    let errDeg = 1;
    if (ship && ship.pos) {
      const dx = tr.pos.x - ship.pos.x, dy = tr.pos.y - ship.pos.y;
      const R = Math.max(200, Math.hypot(dx, dy));
      const ux = dx / R, uy = dy / R;
      const px = -uy, py = ux; // 垂直于视线的单位向量
      const varCross = px * px * tr.P[0] + 2 * px * py * tr.P[1] + py * py * tr.P[5];
      errDeg = clamp(rad2deg(Math.sqrt(Math.max(4, varCross)) / R), 0.02, 45);
    } else {
      errDeg = tr.errDeg;
    }
    if (!isOwner) errDeg = clamp(errDeg * 1.3 + 0.15, 0.03, 45);
    const floor = this._biasFloor(tr);
    const errM = Math.max(floor.m, isOwner ? tr.errM : tr.errM * ageFactor + 80);
    const errDegOut = Math.max(floor.deg, errDeg);
    return {
      id: tr.id, side: tr.side,
      pos: { x: tr.pos.x, y: tr.pos.y },
      courseDeg: tr.courseDeg, speedKn: tr.speedKn, courseValid: tr.courseValid,
      classifiedAs: tr.classifiedAs, classProbs: tr.classProbs,
      confidence: clamp(isOwner ? tr.confidence : tr.confidence * confFactor, 0, 0.99),
      idConfidence: clamp(isOwner ? tr.idConfidence : tr.idConfidence * 0.9, 0, 0.99),
      sources: tr.sources.slice(),
      ageS: tr.ageS, errM, errDeg: errDegOut,
      errMajorM: Math.max(tr.errMajorM, errM * 0.55),
      errMinorM: Math.max(tr.errMinorM, errM * 0.30),
      errOrientationDeg: tr.errOrientationDeg,
      bearingOnly: tr.bearingOnly, hasRange: tr.hasRange,
      hostile: tr.hostile !== false,
      tFirst: tr.tFirst, tLast: tr.tLast,
      shared: !isOwner, reportAgeS: +reportAgeS.toFixed(1),
      sourceShips: tr.sourceShips.slice(),
    };
  }

  // ── 契约：某舰当前可见航迹（含共享延迟）───────────────────────────────────
  visibleFor(ship) {
    if (!ship || !ship.side) return [];
    const out = [];
    for (const tr of this.tracks) {
      if (tr.dead || tr.side !== ship.side) continue;
      if (tr.ageS > VISIBLE_AGE_S) continue;
      if (tr.confidence < 0.12) continue;
      const v = this._viewFor(tr, ship);
      if (v) out.push(v);
    }
    // 近者优先
    out.sort((a, b) => a.ageS - b.ageS);
    return out;
  }

  // ── 契约：按 id 取基础航迹（供火控/命令引用；不含共享降级）───────────────
  byId(id) {
    const tr = this.tracks.find((x) => x.id === id);
    if (!tr) return null;
    return tr;
  }
}
