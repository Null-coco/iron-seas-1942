// ============================================================================
// src/sim/spotting.js —— T4 着弹观测与校射
//
// 模型与依据：
//  1. 谁能看见水柱：观察舷侧/指挥仪高度（mastHeight 的 0.7 倍）+ 目标水柱高
//     （16" ≈ 50m）决定光学地平线 4.12*sqrt(h) nmi；再叠加能见度、烟幕遮蔽
//     （烟幕密度 >0.7 完全看不见）、照度（夜间/黄昏/照明弹）。1942 年夜间
//     无照明弹时基本无法观测水柱——夜战靠探照灯与照明弹。
//  2. 夹叉判定：用目标沿视线的投影尺度（舰长/舰宽随舷角投影）作为容差，
//     齐射落点同时出现在"近界以内"与"远界以外"即为夹叉；全部落在投影带内
//     视为命中/夹中。目标投影 = L*|cos(aspect)| + B*|sin(aspect)|。
//  3. 修正算法：真实火控的"阶梯-夹叉"法。
//       - RANGING：单次全修正（gain 0.8），单次限幅 600m（一战/二战射表步长）；
//       - BRACKET：出现夹叉后进入，减半步长（gain 0.4）；
//       - EFFECT：夹叉后连续效力射，每次只做小修正（gain 0.5）+ 方位蛇形修正。
//     修正量 = -观测平均误差 * gain；观测误差本身含测距/判读噪声（25~60m，
//     随距离与烟幕增大），因此修正不会一次到位——这就是真实校射需要 3~6 次
//     齐射才能夹叉的原因。命中（看到爆烟/命中闪光）也等价于夹叉。
//  4. 方位修正：按落点横向偏差的均值换算成 mil 修正（左右蛇形/单边修正），
//     同样受判读噪声与距离限制；雷达校射（1943+ 火控雷达）只能测距离，
//     不能测横向，故夜间/烟幕中只有距离修正。
//  5. 观察延迟：水柱落下后需 1.5~4s 判读报告，本实现每齐射只处理一次。
// ============================================================================
import { clamp, normDeg180, deg2rad, rad2deg, dist2d, bearing2d } from '../core/util.js';
import { DEG_PER_MIL } from './ballistics.js';
import { fcSpotFor } from './gunnery.js';

// 横向偏差（米/斜距）是弧度，换算成密位需 ×6400/2π ≈ 1018.6
const MIL_PER_RAD = 6400 / (2 * Math.PI);

const CLOSE_TIMEOUT_S = 75;    // 齐射观测超时（弹道飞行 ~30s + 判读）
const SALVO_SETTLE_S = 5;      // 最后一批水柱落水后等待判读
const OBS_READ_NOISE_M = 22;   // 基础判读噪声

// 场景照度（与 gunnery 相同口径；避免新增依赖，函数内重复实现）
function sceneIllumination(world, x, y) {
  const env = world.env;
  let l = env.lightLevel || 0;
  const flares = world.illuminationFlares || [];
  for (const f of flares) {
    const d = Math.hypot((f.x || 0) - x, (f.y || 0) - y);
    const r = Math.hypot(d, f.z || 300);
    const rad = (f.radiusM || 1200) * 2.2;
    if (r < rad) l = Math.max(l, (f.brightness || 0.8) * clamp(1 - r / rad, 0, 1) * 0.95);
  }
  return clamp(l, 0, 1.3);
}
function hasFCRadar(ship) {
  for (const s of ship.sensors || []) {
    if (s.srcKind !== 'RADAR' || s.destroyed || s.on === false) continue;
    const d = s.data || {};
    if (d.fireControl || d.hasFC || /Mk\s*(3|8|13|22|284|274)/i.test((d.nameZh || '') + (d.id || ''))) return true;
  }
  return false;
}
function usableDirector(ship) {
  for (const d of ship.directors || []) {
    if (!d.destroyed && (d.health === undefined || d.health > 0.2)) return d;
  }
  return null;
}

// 能否看见该处水柱
function canObserve(ship, world, x, y, rangeM) {
  if (ship.flags && ship.flags.spottingEnabled === false) return { ok: false, reason: 'DISABLED' };
  if (!usableDirector(ship)) return { ok: false, reason: 'NO_DIRECTOR' };
  const env = world.env;
  const visNm = (typeof env.horizontalVisibilityNm === 'function')
    ? env.horizontalVisibilityNm(ship) : (env.visibilityNm || 10);
  if (rangeM > visNm * 1852 * 1.1) return { ok: false, reason: 'VISIBILITY' };
  const illum = sceneIllumination(world, x, y);
  if (illum < 0.10) {
    // 夜间：1943 年后火控雷达可测距校射（但无法测横向）
    if (ship.year >= 1943 && hasFCRadar(ship)) return { ok: true, radarOnly: true };
    return { ok: false, reason: 'DARK' };
  }
  const smoke = (typeof env.smokeDensityAt === 'function') ? env.smokeDensityAt(x, y) : 0;
  const mid = (typeof env.smokeDensityAt === 'function')
    ? env.smokeDensityAt((ship.pos.x + x) / 2, (ship.pos.y + y) / 2) : 0;
  if (Math.max(smoke, mid) > 0.72) {
    if (ship.year >= 1943 && hasFCRadar(ship)) return { ok: true, radarOnly: true };
    return { ok: false, reason: 'SMOKE' };
  }
  // 光学地平线：观察高度 + 水柱高度
  const hObs = (ship.data && ship.data.mastHeight_m ? ship.data.mastHeight_m : 20) * 0.72;
  const horizon = 4.12 * Math.sqrt(Math.max(1.5, hObs) + 6) * 1852;
  if (rangeM > horizon * 1.25) {
    if (ship.year >= 1943 && hasFCRadar(ship)) return { ok: true, radarOnly: true };
    return { ok: false, reason: 'HORIZON' };
  }
  return { ok: true, radarOnly: false };
}

// 目标沿视线方向的投影半长（m）
function targetHalfExtent(ship, world, target, losBearingDeg) {
  if (!target) return 60;
  const d = target.data || {};
  const L = d.loa_m || 150, B = d.beam_m || 20;
  const aspect = Math.abs(normDeg180(losBearingDeg + 180 - (target.heading || 0)));
  const rad = deg2rad(aspect);
  const extent = L * Math.abs(Math.cos(rad)) + B * Math.abs(Math.sin(rad));
  return Math.max(B * 0.6, extent * 0.5);
}

function toNumber(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }

// 找一个齐射记录的目标舰
function resolveSalvoTarget(world, ship, rec) {
  if (rec.targetShipId) {
    const t = world.ship(rec.targetShipId);
    if (t && t.isAfloat) return t;
  }
  // 用落点/航迹位置找最近的敌舰
  let px = 0, py = 0, n = 0;
  for (const s of rec.splashes) { px += s.x; py += s.y; n++; }
  if (!n) return null;
  px /= n; py /= n;
  let best = null, bd = 1e9;
  for (const s of world.ships) {
    if (!s.isAfloat || s.side === ship.side) continue;
    const dd = dist2d(s.pos, { x: px, y: py });
    if (dd < bd) { bd = dd; best = s; }
  }
  return (best && bd < 1500) ? best : null;
}

// 评估一次齐射：落点 → 距离/方位偏差 → 夹叉 → 修正
function evaluateSalvo(ship, world, rec) {
  const now = world.t;
  // 只有主炮齐射参与主炮校射：副炮/近战炮的弹道与射程完全不同，混进来会让
  // 梯次修正被 1~1.5 km 的副炮落点误差带跑（实测 3 km 上主炮仰角 ±0.3°、
  // 落点 ±500 m 振荡，命中率反而低于远距）。副炮各自有局部解算，无需主梯次。
  if ((rec.role || 'main') !== 'main') {
    rec.observed = true; rec.observedAt = now;
    return;
  }
  const st = ensureSpotState(ship);
  const target = resolveSalvoTarget(world, ship, rec);
  const baseRange = target ? dist2d(ship.pos, target.pos) : toNumber(rec.rangeM, 15000);
  const losBearing = target ? bearing2d(ship.pos, target.pos) : 0;
  const halfExtent = targetHalfExtent(ship, world, target, losBearing);
  // 观测条件（逐水柱判断；以齐射中心近似）
  let cx = 0, cy = 0, n = 0;
  for (const s of rec.splashes) { cx += s.x; cy += s.y; n++; }
  if (n) { cx /= n; cy /= n; } else { cx = ship.pos.x; cy = ship.pos.y; }
  const obsRange = dist2d(ship.pos, { x: cx, y: cy });
  const canSee = canObserve(ship, world, cx, cy, Math.max(obsRange, baseRange));
  if (!canSee.ok) {
    rec.observed = true;
    rec.observedAt = now;
    st.lastSpot = {
      t: now, salvoId: rec.id, observed: false, reason: canSee.reason,
      salvoes: rec.id, targetShipId: target ? target.id : null,
    };
    ship.lastSpot = st.lastSpot;
    world.events.emit('fc.update', {
      t: now, ship: ship.id, side: ship.side, kind: 'SPOT_BLIND',
      salvoId: rec.id, reason: canSee.reason, targetShipId: target ? target.id : null,
    });
    return;
  }
  const q = clamp(ship.crewQuality || 0.85, 0.5, 1.25);
  const radarOnly = !!canSee.radarOnly;
  const sigmaRead = (radarOnly ? 55 : OBS_READ_NOISE_M) + 0.0016 * baseRange;
  const sigmaLat = (radarOnly ? 1e9 : (OBS_READ_NOISE_M * 0.8 + 0.0018 * baseRange)) / q;
  const deltas = [];
  let latSum = 0, latN = 0, hits = rec.hits || 0;
  for (const s of rec.splashes) {
    if (s.observed) continue;
    s.observed = true;
    const r = dist2d(ship.pos, s);
    const b = bearing2d(ship.pos, s);
    const delta = (r - baseRange) + world.rng.normal(0, sigmaRead / q);
    deltas.push(delta);
    if (!radarOnly) {
      const dB = normDeg180(b - losBearing);
      const lat = deg2rad(dB) * baseRange + world.rng.normal(0, Math.min(sigmaLat, 200));
      latSum += lat; latN++;
    }
  }
  // 命中/爆炸本身就是最可靠的一次着弹观测（水柱只是没打中时的替代手段）。
  // 旧实现只有"全命中、没有任何水柱"时才补一个 delta；混合齐射里那几发命中
  // 完全不参与距离修正——穿甲弹改为舰内起爆后水柱变少，校射就明显变差（t4 回归）。
  // 这里给每次有命中的齐射补一条"命中观测"：偏差 ~0（半目标投影的 1/4 作为读取噪声）。
  if (hits > 0) {
    deltas.push(world.rng.normal(0, Math.max(20, halfExtent * 0.25)));
    if (!radarOnly) { latSum += world.rng.normal(0, Math.min(sigmaLat, 200) * 0.5); latN++; }
  }
  if (!deltas.length && hits <= 0) {
    // 全部命中或数据缺失：视为夹叉命中
    if (hits > 0) {
      deltas.push(world.rng.normal(0, halfExtent * 0.35));
    } else {
      rec.observed = true;
      return;
    }
  }
  let meanRangeErr = 0;
  for (const d of deltas) meanRangeErr += d;
  meanRangeErr /= Math.max(1, deltas.length);
  let minD = Infinity, maxD = -Infinity;
  for (const d of deltas) { if (d < minD) minD = d; if (d > maxD) maxD = d; }
  const meanLat = latN > 0 ? latSum / latN : 0;
  // 夹叉：近失界与远界同时被跨越（投影带 ±halfExtent）
  const shortHit = deltas.some((d) => d < -halfExtent * 0.85);
  const overHit = deltas.some((d) => d > halfExtent * 0.85);
  const straddleByBracket = shortHit && overHit;
  const straddleByInside = deltas.length > 0 && deltas.every((d) => Math.abs(d) <= halfExtent * 1.25);
  // 平均弹着点落在目标投影带内，也算"覆盖/夹叉"（真实火控的 on-for-range）
  const straddleByMean = Math.abs(meanRangeErr) <= halfExtent * 0.9;
  const straddle = hits > 0 || straddleByBracket || (straddleByInside && deltas.length >= 2) || straddleByMean;
  const spreadM = deltas.length > 1 ? (maxD - minD) : 0;
  rec.observed = true;
  rec.observedAt = now;
  rec.meanRangeErrM = meanRangeErr;
  rec.meanLateralM = meanLat;
  rec.straddle = straddle;
  // ---- 校射修正 ----
  // 真实做法：不追逐单次齐射的散布（横摇/装药随机），而是按"最近数次齐射
  // 的平均偏差"修正，并设死区（偏差小于目标投影尺度时不修正，视为已夹叉）。
  const ladder = st.directorLadder || (st.directorLadder = { state: 'RANGING', straddles: 0, salvos: 0, lastCorrM: 0, lastCorrMil: 0 });
  ladder.salvos++;
  if (!st.errHist) st.errHist = [];
  st.errHist.push({ t: now, r: meanRangeErr, lat: meanLat, radarOnly });
  if (st.errHist.length > 6) st.errHist.shift();
  const recent = st.errHist.slice(-4);
  const smoothR = recent.reduce((a, x) => a + x.r, 0) / recent.length;
  const smoothLat = recent.reduce((a, x) => a + x.lat, 0) / recent.length;
  // 死区：目标投影尺度 + 齐射自身散布的一半（真实"夹叉即停修"）
  const deadR = Math.max(halfExtent * 0.9, spreadM * 0.5, 45);
  const deadL = Math.max(baseRange * 0.004, 25);
  let gain = ladder.state === 'RANGING' ? 0.6 : (ladder.state === 'BRACKET' ? 0.45 : 0.3);
  let newState = ladder.state;
  if (straddle) {
    ladder.straddles++;
    st.spot.straddles = ladder.straddles;
    newState = 'EFFECT';
  } else if (Math.abs(smoothR) > deadR * 2.2) {
    newState = 'BRACKET';
  } else if (ladder.state === 'RANGING') {
    newState = 'BRACKET';
  }
  const dir = usableDirector(ship);
  // 校射修正落在指挥仪状态上（computeSolution 读取）
  // 校射偏置按【目标航迹】存取：换目标后不会把上一个目标的偏置套过来
  const spotKey = 'MAIN|' + ((dir && dir._fc && dir._fc.trackId) || rec.trackId || rec.targetShipId || 'NA');
  const spot = fcSpotFor((dir && dir._fc) ? dir._fc : st, spotKey);
  let corrM = 0;
  if (Math.abs(smoothR) > deadR) corrM = clamp(-smoothR * gain, -400, 400);
  spot.rangeBiasM = clamp(spot.rangeBiasM + corrM, -1200, 1200);
  let corrMil = 0;
  if (!radarOnly && latN > 0 && Math.abs(smoothLat) > deadL) {
    // 横向偏差(m) / 斜距 → 弧度 → 密位；取反修正（右偏则左修）
    corrMil = clamp(-(smoothLat / Math.max(500, baseRange)) * MIL_PER_RAD * gain, -12, 12);
    // 偏转修正累积上限收紧：±40 密位 = 2.3°，在 8km 处就是 320m 的横向偏置且会来回摆。
    // 真实火控的横向修正量级只有几密位（校射主要修正距离）。
    spot.deflBiasMil = clamp(spot.deflBiasMil + corrMil, -14, 14);
  }
  spot.tLast = now;
  spot.samples++;
  spot.source = radarOnly ? 'RADAR' : 'OPTICAL';
  ladder.state = newState;
  ladder.lastCorrM = corrM;
  ladder.lastCorrMil = corrMil;
  ladder.t = now;
  ship.ladder = ladder;
  const spotSummary = {
    t: now, salvoId: rec.id, observed: true, radarOnly,
    targetShipId: target ? target.id : null,
    meanRangeErrM: meanRangeErr, meanLateralM: meanLat,
    spreadM, straddle, minRangeErrM: minD, maxRangeErrM: maxD,
    correctionM: corrM, correctionMil: corrMil,
    totalBiasM: spot.rangeBiasM, totalBiasMil: spot.deflBiasMil,
    ladderState: newState, straddles: ladder.straddles, salvoes: ladder.salvos,
    halfExtentM: halfExtent,
  };
  st.lastSpot = spotSummary;
  ship.lastSpot = spotSummary;
  rec.spot = spotSummary;
  if (straddle) {
    if (ship.stats) ship.stats.straddles = (ship.stats.straddles || 0) + 1;
    if (target && target.stats) target.stats.straddled = (target.stats.straddled || 0) + 1;
    world.events.emit('gun.straddle', {
      t: now, ship: ship.id, name: ship.name, side: ship.side,
      targetShipId: target ? target.id : null, salvoId: rec.id,
      rangeM: Math.round(baseRange), meanRangeErrM: Math.round(meanRangeErr),
      spreadM: Math.round(spreadM), hit: hits > 0, straddles: ladder.straddles,
      ladderState: newState,
    });
  }
  world.events.emit('fc.update', {
    t: now, ship: ship.id, side: ship.side, kind: 'SPOT',
    director: dir ? dir.id : null, salvoId: rec.id,
    targetShipId: target ? target.id : null,
    meanRangeErrM: Math.round(meanRangeErr), meanLateralM: Math.round(meanLat),
    correctionM: Math.round(corrM), correctionMil: +corrMil.toFixed(1),
    rangeBiasM: Math.round(spot.rangeBiasM), deflBiasMil: +spot.deflBiasMil.toFixed(1),
    ladderState: newState, straddle, observed: true, radarOnly,
    salvoes: ladder.salvos, straddles: ladder.straddles,
  });
  world.events.emit('fc.ladder', {
    t: now, ship: ship.id, side: ship.side, director: dir ? dir.id : null,
    state: newState, salvoId: rec.id, targetShipId: target ? target.id : null,
    meanRangeErrM: Math.round(meanRangeErr), correctionM: Math.round(corrM),
    correctionMil: +corrMil.toFixed(1), straddle,
    salvoes: ladder.salvos, straddles: ladder.straddles,
  });
}

function ensureSpotState(ship) {
  if (!ship._spotting) {
    ship._spotting = {
      lastSpot: null,
      directorLadder: { state: 'RANGING', straddles: 0, salvos: 0, lastCorrM: 0, lastCorrMil: 0, t: 0 },
      spot: { rangeBiasM: 0, deflBiasMil: 0, tLast: -1e9, samples: 0, source: 'NONE', straddles: 0 },
      processed: new Set(),
    };
    ship.ladder = ship._spotting.directorLadder;
  }
  return ship._spotting;
}

// ---------------------------------------------------------------------------
// 契约接口
// ---------------------------------------------------------------------------
export function updateSpotting(ship, world, dt) {
  if (!ship || !ship.isAfloat) return;
  const st = ensureSpotState(ship);
  if (!world.salvoes) return;
  const now = world.t;
  for (const rec of world.salvoes.values()) {
    if (rec.shipId !== ship.id) continue;
    if (rec.observed || st.processed.has(rec.id)) continue;
    // 齐射"落定"：全部弹丸落水/命中，或超时
    const landed = (rec.splashes.length + (rec.hits || 0)) >= Math.max(1, rec.shots);
    const lastT = rec.splashes.length ? Math.max(...rec.splashes.map((s) => s.t)) : rec.tFire;
    const settled = landed && (now - lastT) >= SALVO_SETTLE_S;
    const timeout = (now - rec.tFire) > CLOSE_TIMEOUT_S;
    if (!settled && !timeout) continue;
    st.processed.add(rec.id);
    evaluateSalvo(ship, world, rec);
  }
  // 清理已处理集合
  if (st.processed.size > 400) {
    const arr = Array.from(st.processed);
    for (let i = 0; i < arr.length - 200; i++) st.processed.delete(arr[i]);
  }
}
