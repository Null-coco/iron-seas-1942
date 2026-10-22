// vision.js — 【T2】目视发现、光学测距、烟幕生成/消散（1942 年光学火控与瞭望的物理基础）。
//
// ── 物理模型与依据 ──────────────────────────────────────────────────────────
// 1) 大气消光（Koschmieder 定律）：水平能见度 V 定义为 2% 对比度对应的距离，
//    消光系数 σ = −ln(0.02)/V = 3.912/V。目标固有对比度 C0 经大气衰减后
//    C(R) = C0·exp(−σ·R)，当 C(R) ≥ 人眼/望远镜对比度阈值（~2%，受目标张角与
//    乘员素质修正）时可发现。由此得到发现距离 R = ln(C0/C_th)/σ —— 与能见度近似成正比。
// 2) 目标固有对比度 C0 取决于光照：白天舰体在明亮海天背景前呈暗色剪影（C0≈0.5~0.6）；
//    夜间由月光、星光、探照灯、照明弹（starshell）、自身火灾照明；烟幕降低舰体对比度
//    但烟柱本身也有对比度；航速 >6 kn 的尾迹（白色扰动水）增加可发现性。
// 3) 观察高度与地平线：d = 4.12(√h_eye + √h_target) km（与雷达同一 4/3 地球折射模型）。
//    瞭望所/舰桥眼高取桅高的 0.55，目标可见高度取桅高的 0.85。
// 4) 重合式/立体式测距仪：基线测距基本公式 R = B/tanθ，微分得
//    dR = R²·dθ/B。角色散 dθ 由光学分辨与操作员判读精度决定：
//    重合式约 1.3″、立体式约 2.0″（乘员素质缩放），再乘舷角（艏艉向垂缘不清晰）、
//    横摇（基线倾斜）、海况、低对比度（接近能见极限）与烟幕的恶化因子。
//    例：B=15 m、R=15000 m、dθ≈1.4″ → dR ≈ 150~250 m，与历史射击训练数据同量级。
// 5) 烟幕：舰艇施放发烟（flags.smokeOn / smokeIntensity）或火灾产生烟团，
//    写入 env.smokeClouds（fog-of-war 状态），随风漂移、膨胀、指数消散；视觉 LOS 上的
//    烟团密度按特征遮蔽长度 220 m 折算光学厚度，雷达不受影响（RF 穿透烟尘）。
// 6) 陆地遮蔽：观察者与目标之间的岛屿/海角截断视线（LOS）时不可发现。Land 只有二维
//    海岸线（无海拔），遮挡按"连线是否穿越陆地"判定，采样步长 200 m，仅对 <=30 km 的
//    视线执行（性能）；被遮蔽时 visualDetection().blockedByLand=true，
//    visualObservation 返回 null 并（边沿触发）emit sensor.visual.blocked{blockedByLand:true}。
//    已建立的航迹不再获得新观测，由 tracks 的失跟计时自然 emit sensor.lose。
// 7) 随机数只走 world.rng。
import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, aspectAngle, deg2rad, rad2deg } from '../core/util.js';

const NMI_M = 1852;
const DEG = Math.PI / 180;
const C_THRESHOLD = 0.02;        // Koschmieder 2% 对比度阈值
const HORIZON_M_PER_SQRT_M = 4122; // 4/3 地球折射：4.12 km/√m
const SMOKE_L_CHAR_M = 220;      // 烟团特征遮蔽长度（m），density=1 时每 220 m 衰减 e 倍
const MAX_VISUAL_RANGE_M = 45000;

// ── 陆地遮蔽（Land）：岛屿/海角截断观察者→目标的视线 ─────────────────────────
// Land（src/sim/land.js）是二维海岸线栅格（无海拔）。这里只问"两点连线是否穿越陆地"，
// 地形数据全部交给 Land 的现有能力（isLandExact 精确点判定 + segmentBlocked 线段求交），
// 不在 vision 里自造地形。
// 性能红线：只对 <= 30 km 的视线做陆地判定（更远的目视本就被地平线/能见度压到极限，
// 且雷达已由 sensors.js 独立判遮蔽）；采样步长 200 m（< Land 栅格 400 m 的一半），
// 比栅格采样更细；尺寸小于步长、可能落在两个采样点之间的细礁/小屿，再交给
// Land.segmentBlocked 的精确环求交兜底。
const LAND_LOS_MAX_M = 30000;    // 超过此距离不做陆地遮蔽（性能）
const LAND_LOS_STEP_M = 200;     // 视线采样步长上限（m）
const LAND_LOS_FINE_M = 200;     // 小于此尺寸的小环需要精确求交兜底（m）

// env → { world, land }：visualDetection/visualObservation 的签名是冻结的（T2 契约只给
// env 与 rng，没有 world），所以由同模块的 updateSmokeClouds(world, dt) / deployChaff(world,...)
// 在每个 tick 把 world.land 登记到 world.env 上（两者每帧都在目视瞭望之前执行）。
const _worldCtxByEnv = new WeakMap();

export function bindWorldContext(world) {
  if (!world || !world.env) return;
  _worldCtxByEnv.set(world.env, { world, land: world.land || null });
  return world.land || null;
}

function asLand(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.segmentBlocked === 'function' || typeof x.isLandExact === 'function'
    || typeof x.isLand === 'function') return x;
  return null;
}

// 解析陆地对象：显式参数（Land 实例或 {land}/{world}）→ env 上登记的 world 上下文 → env.land
// → viewer.land。全部缺失时返回 null（= 无陆地，行为与旧实现完全一致）。
function resolveLand(env, viewer, extra) {
  const direct = asLand(extra);
  if (direct) return direct;
  if (extra && typeof extra === 'object') {
    const nested = asLand(extra.land) || asLand(extra._land) || asLand(extra.world && extra.world.land);
    if (nested) return nested;
  }
  if (env) {
    const ctx = _worldCtxByEnv.get(env);
    if (ctx && ctx.land) return ctx.land;
    const fromEnv = asLand(env.land) || asLand(env._land);
    if (fromEnv) return fromEnv;
  }
  if (viewer) {
    const fromViewer = asLand(viewer.land) || asLand(viewer._land) || asLand(viewer.world && viewer.world.land);
    if (fromViewer) return fromViewer;
  }
  return null;
}

// 视线是否被陆地截断。a/b 为世界坐标点 {x,y}（米）。
// 返回 true = 陆地（山体/岛屿/岸线）挡住了视线，观测者看不到目标。
export function landBlocksLOS(land, a, b, opts = {}) {
  const L = asLand(land);
  if (!L || L.empty || !a || !b) return false;
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  const len = dist2d(a, b);
  if (!(len > 1)) return false;
  const maxRange = opts.maxRangeM || LAND_LOS_MAX_M;
  if (len > maxRange) return false;
  const step = Math.max(20, Math.min(LAND_LOS_STEP_M, opts.stepM || LAND_LOS_STEP_M));
  const n = Math.max(1, Math.ceil(len / step));
  const dx = (b.x - a.x) / n, dy = (b.y - a.y) / n;
  // 精确点判定（Land.isLandExact 含细小岛礁的环求交兜底）
  const isLand = typeof L.isLandExact === 'function' ? (x, y) => L.isLandExact(x, y)
    : (typeof L.isLandAny === 'function' ? (x, y) => L.isLandAny(x, y)
      : (typeof L.isLand === 'function' ? (x, y) => L.isLand(x, y) : null));
  if (!isLand) return false;
  for (let i = 1; i < n; i++) {
    if (isLand(a.x + dx * i, a.y + dy * i)) return true;
  }
  // 采样点之间可能整个跨过一座 < 200 m 的小屿：只对 bbox 与连线相交、且尺寸小于步长的
  // 小环调用 Land 的线段精确求交（大环采样必中，不会漏）。
  const boxes = Array.isArray(L.ringBoxes) ? L.ringBoxes : null;
  if (boxes && boxes.length && typeof L.segmentBlocked === 'function') {
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    for (const rb of boxes) {
      if (!rb) continue;
      if (rb.c < minX || rb.a > maxX || rb.d < minY || rb.b > maxY) continue;
      if (Math.max(rb.c - rb.a, rb.d - rb.b) >= LAND_LOS_FINE_M) continue; // 大环：采样已覆盖
      return L.segmentBlocked(a, b);
    }
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// 基础几何/光照辅助
// ════════════════════════════════════════════════════════════════════════════
export function visualHorizonM(hEyeM, hTargetM = 0) {
  return HORIZON_M_PER_SQRT_M * (Math.sqrt(Math.max(0, hEyeM || 0)) + Math.sqrt(Math.max(0, hTargetM || 0)));
}
function mastOf(ship) {
  return (ship && ship.data && ship.data.mastHeight_m) || (ship && ship.silhouetteHeightM) || 18;
}
function eyeHeightM(viewer) { return Math.max(2, mastOf(viewer) * 0.55); }
function targetVisibleHeightM(target) { return clamp(mastOf(target) * 0.85, 3, 45); }
function extinctionPerM(visM) { return 3.912 / Math.max(200, visM); }

// 舷侧投影面积（水线以上迎风面）：width = L·sin(舷角) + B·cos(舷角)
export function projectedSilhouetteAreaM2(target, aspectDeg) {
  const L = (target && target.data && target.data.loa_m) || 110;
  const B = (target && target.data && target.data.beam_m) || 12;
  const H = clamp(mastOf(target) * 0.72, 4, 40);
  const a = clamp(Math.abs(aspectDeg), 0, 180) * DEG;
  const width = L * Math.sin(a) + B * Math.cos(a);
  return Math.max(20, 0.55 * width * H);
}

function fireLevel(target) {
  if (!target) return 0;
  let f = clamp(Number(target.flags && target.flags.onFire) || 0, 0, 1);
  if (Array.isArray(target.compartments)) {
    const n = target.compartments.filter((c) => c && c.fire > 0.15).length;
    f = Math.max(f, clamp(n / 6, 0, 1));
  }
  return f;
}

function searchlightAlignment(viewer, bearingToTarget) {
  const sl = viewer && viewer.flags && viewer.flags.searchlight;
  if (!sl || !sl.on) return 0;
  const sB = sl.bearing !== undefined ? sl.bearing : ((viewer.heading || 0));
  const diff = Math.abs(normDeg180(sB - bearingToTarget));
  const halfBeam = 2.5; // 探照灯束宽约 5°
  return clamp(1 - diff / halfBeam, 0, 1);
}

function visibilityNmOf(env, viewer) {
  return (env && typeof env.horizontalVisibilityNm === 'function')
    ? env.horizontalVisibilityNm(viewer)
    : ((env && env.visibilityNm) || 12);
}

// LOS 上的平均烟幕密度（0~1）：沿视线采样 env.smokeDensityAt
function losSmokeDensity(env, from, to) {
  if (!env || typeof env.smokeDensityAt !== 'function' || !from || !to) return 0;
  const N = 7;
  let sum = 0;
  for (let i = 1; i <= N; i++) {
    const f = i / (N + 1);
    const d = env.smokeDensityAt(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
    sum += clamp(d || 0, 0, 1);
  }
  return sum / N;
}

// ════════════════════════════════════════════════════════════════════════════
// 目视发现（核心）：返回详细分解，供测试/AAR/UI 解释
// ════════════════════════════════════════════════════════════════════════════
// landOrOpts：可选。Land 实例，或 {land} / {world} / {stepM,maxRangeM}。省略时从 env
// （sensors.js 每帧登记）解析 world.land —— 旧调用 visualDetection(viewer, target, env) 不受影响。
export function visualDetection(viewer, target, env, landOrOpts) {
  const empty = {
    detected: false, rangeM: 0, bearingDeg: 0, aspectDeg: 0, detectionRangeM: 0,
    horizonM: 0, visibilityNm: 0, contrast0: 0, contrastAtTarget: 0, contrastThreshold: C_THRESHOLD,
    smokeDensity: 0, apparentAreaM2: 0, lightLevel: 0, blockedByLand: false,
    cues: { hull: 0, plume: 0, wake: 0, fire: 0, searchlight: 0 },
  };
  if (!viewer || !target || !viewer.pos || !target.pos) return empty;
  const range = dist2d(viewer.pos, target.pos);
  const bearing = bearing2d(viewer.pos, target.pos);
  if (range < 30) return Object.assign(empty, { detected: true, rangeM: range, bearingDeg: bearing, detectionRangeM: MAX_VISUAL_RANGE_M, horizonM: 1e9 });

  // —— 陆地遮蔽：观察者→目标连线被岛屿/海角截断 → 毫无可见性（不发现） ——
  const land = resolveLand(env, viewer, landOrOpts);
  const landMaxM = (landOrOpts && typeof landOrOpts === 'object' && Number.isFinite(landOrOpts.maxRangeM))
    ? landOrOpts.maxRangeM : LAND_LOS_MAX_M;
  if (land && !land.empty && range <= landMaxM
    && landBlocksLOS(land, viewer.pos, target.pos, landOrOpts)) {
    return Object.assign(empty, {
      detected: false, rangeM: range, bearingDeg: bearing,
      detectionRangeM: 0, visibilityNm: visibilityNmOf(env, viewer),
      horizonM: visualHorizonM(eyeHeightM(viewer), targetVisibleHeightM(target)),
      blockedByLand: true,
    });
  }

  const aspect = aspectAngle(target.heading || 0, bearing);
  const area = projectedSilhouetteAreaM2(target, aspect);
  const cq = clamp(viewer.crewQuality || 0.85, 0.5, 1.25);
  const seaState = env && env.seaState !== undefined ? env.seaState : 3;
  const moon = (env && env.moonIllum) || 0;
  const cloud = (env && env.cloudCover) || 0;
  const illumFactor = (env && typeof env.illuminationFactor === 'function')
    ? env.illuminationFactor(target)
    : (env && env.lightLevel !== undefined ? env.lightLevel : 1);

  // —— 环境光：白天 1，月夜最多约 0.1 ——
  const dayFactor = clamp(illumFactor / 0.8, 0, 1);
  const moonFactor = moon * clamp(1 - cloud * 0.6, 0.2, 1) * 0.10;
  const lightLevel = clamp(dayFactor + moonFactor, 0, 1.2);

  // —— 固有对比度 ——
  // 白天舰体暗色剪影 ≈0.55；夜间隔着海面反光仅有 2% 量级剪影
  // 舰体是暗剪影：对比度随环境光呈次线性下降，且晨昏仍有可观剪影（史实：黎明/黄昏是
  // 发现与突袭的黄金时段）。原来按 0.55×光照 线性归零，导致太阳高度 +3° 时 6km 外看不见战列舰。
  // 晨昏增益随微光淡出：太阳高度 -6°~+6° 时有明显剪影（twilight→1），全黑时回到纯剪影。
  const twilight = clamp((lightLevel - 0.02) / 0.10, 0, 1);
  let hull = 0.55 * Math.pow(clamp(lightLevel, 0, 1), 0.6) * (0.20 + 0.80 * twilight) + 0.02 + 0.05 * twilight;
  const fire = fireLevel(target);
  const targetSearchlight = !!(target.flags && target.flags.searchlight && target.flags.searchlight.on);
  const illuminated = clamp((target.flags && target.flags.illuminated) || 0, 0, 1);
  const viewerSL = searchlightAlignment(viewer, bearing) * clamp(1 - range / 9000, 0, 1);
  if (fire > 0) hull = Math.max(hull, 0.55 + 0.40 * fire);       // 火灾自发光
  if (targetSearchlight) hull = Math.max(hull, 0.70);            // 目标探照灯眩光
  if (illuminated > 0) hull = Math.max(hull, 0.15 + 0.55 * illuminated); // 照明弹照亮
  if (viewerSL > 0) hull = Math.max(hull, 0.50 + 0.35 * viewerSL);        // 我方探照灯照射
  // 舷角对剪影的影响：艏艉向投影面积小、对比略差
  const aspectContrast = 0.80 + 0.25 * Math.sin(clamp(aspect, 0, 180) * DEG);

  const smokeIntensity = clamp((target.flags && target.flags.smokeIntensity) || 0, 0, 1.6);
  const hullVisible = hull * aspectContrast * (1 - 0.80 * Math.min(1, smokeIntensity)); // 自身烟幕遮蔽舰体
  const plume = smokeIntensity > 0.08
    ? (0.10 + 0.16 * clamp(lightLevel, 0, 1)) * Math.min(1, smokeIntensity)     // 烟柱本身可见（出卖位置）
    : 0;
  const speed = target.speed || 0;
  const wake = speed > 6
    ? 0.10 * clamp(speed / 30, 0, 1) * clamp(0.5 + dayFactor, 0.4, 1)
      * clamp(1 - 0.07 * Math.max(0, seaState - 2), 0.25, 1)
    : 0;

  // 尾迹是紧邻舰体的明亮扰动水带，与舰体剪影叠加（夜间/低能见度时首先看到尾迹）
  const C0 = Math.max(hullVisible, plume) + 0.5 * wake;

  // —— 大气 + 烟幕消光 ——
  const visNm = visibilityNmOf(env, viewer);
  const ext = extinctionPerM(visNm * NMI_M);
  const smokeDensity = losSmokeDensity(env, viewer.pos, target.pos);
  const smokeExt = smokeDensity / SMOKE_L_CHAR_M;

  // —— 对比度阈值：目标越小越难看清；乘员素质影响判读 ——
  const cth = C_THRESHOLD
    * clamp(Math.sqrt(1500 / area), 0.6, 2.2)
    * clamp(1.25 - 0.35 * clamp((cq - 0.5) / 0.7, 0, 1), 0.85, 1.2)
    * clamp(1 + 0.04 * Math.max(0, seaState - 3), 1, 1.25); // 海况差、目标摇荡增加判读难度

  const horizon = visualHorizonM(eyeHeightM(viewer), targetVisibleHeightM(target));
  const contrastAtTarget = C0 * Math.exp(-(ext + smokeExt) * range);

  let detectionRangeM = 0;
  if (C0 > cth) {
    detectionRangeM = Math.log(C0 / cth) / Math.max(1e-9, ext + smokeExt);
    detectionRangeM = Math.min(detectionRangeM, horizon, MAX_VISUAL_RANGE_M);
  }
  const detected = C0 > cth && range <= detectionRangeM && contrastAtTarget >= cth;
  return {
    detected, rangeM: range, bearingDeg: bearing, aspectDeg: aspect, blockedByLand: false,
    detectionRangeM: Math.max(0, detectionRangeM), horizonM: horizon, visibilityNm: visNm,
    contrast0: C0, contrastAtTarget, contrastThreshold: cth,
    smokeDensity, apparentAreaM2: area, lightLevel,
    extinctionPerM: ext,
    cues: { hull: hullVisible, plume, wake, fire, searchlight: viewerSL },
  };
}

// 契约：目视发现距离（米）
export function visualDetectRange(viewer, target, env) {
  return visualDetection(viewer, target, env).detectionRangeM;
}

// ════════════════════════════════════════════════════════════════════════════
// 光学测距（重合式 / 立体式）
// ════════════════════════════════════════════════════════════════════════════
function selectRangefinder(viewer) {
  if (!viewer || !Array.isArray(viewer.rangefinders) || !viewer.rangefinders.length) return null;
  let best = null, bestScore = -1;
  for (const rf of viewer.rangefinders) {
    if (!rf || rf.destroyed) continue;
    const health = rf.health === undefined ? 1 : rf.health;
    if (health <= 0.2) continue;
    const score = (rf.mount === 'director' ? 10 : 0) + (rf.base_m || 3) + health;
    if (score > bestScore) { bestScore = score; best = rf; }
  }
  return best;
}

// 契约：返回 {rangeM, errM, bearingDeg, errDeg}（另含诊断字段）
export function opticalRangefind(viewer, target, env, rng) {
  const det = visualDetection(viewer, target, env);
  const R = det.rangeM;
  const bearing = det.bearingDeg;
  const rand = (rng && typeof rng.normal === 'function') ? rng : { normal: () => 0 };
  const rf = selectRangefinder(viewer);
  if (!rf) {
    return {
      rangeM: Math.max(200, R), errM: Math.max(800, 0.25 * R), bearingDeg: bearing,
      errDeg: 2.5, valid: false, type: 'none', baseM: 0, trueRangeM: R,
      sigmaRangeM: Math.max(800, 0.25 * R), sigmaBearingDeg: 2.5, thetaArcsec: 0,
    };
  }
  const base = Math.max(0.5, rf.base_m || 3);
  const type = rf.type || 'coincidence';
  const cq = clamp(viewer.crewQuality || 0.85, 0.5, 1.25);
  const seaState = (env && env.seaState !== undefined) ? env.seaState : 3;
  // 防御：这些字段在 visualDetection 的不同返回路径上不一定都有，缺一个就会让 sigmaR 变 NaN，
  // 而 NaN 会一路污染到航迹位置，最后让火控/AI 完全失效（实测表现为"一炮不发"）。
  const aspect = Number.isFinite(det.aspectDeg) ? det.aspectDeg : 90;
  const roll = Math.abs(viewer.roll || 0) || 0;
  const list = Math.abs(viewer.list || 0) || 0;

  // 角色散基准：重合式 1.0″、立体式 1.6″（乘员素质 0.85 时约 1.0×；差则放大 25%）。
  // 由 dR=R²·dθ/B 校验：B=4.5 m、R=8 km、dθ≈1.1″ → ±75 m；R=15 km → ±260 m；R=20 km → ±470 m。
  let thetaArcsec = (type === 'stereoscopic' ? 1.35 : 0.85)
    * clamp(1.6 - 0.7 * cq, 0.7, 1.25);
  // 舷角：艏艉向目标可用垂缘少，判读变差（90° 最好）
  const aspectFactor = 0.95 + 0.30 * (1 - Math.sin(clamp(aspect, 0, 180) * DEG));
  // 横摇/倾斜使测距仪基线偏离水平，两端像高不一致；海况加剧
  const rollFactor = 1 + 0.020 * roll + 0.020 * seaState;
  // 接近能见极限时对比度低、判读恶化
  const detRange = (Number.isFinite(det.detectionRangeM) && det.detectionRangeM > 0) ? det.detectionRangeM : 1;
  const rv = clamp(R / Math.max(1000, detRange), 0, 1);
  const contrastFactor = 1 + 1.2 * Math.pow(rv, 4);
  const smokeFactor = 1 + 2.0 * (Number.isFinite(det.smokeDensity) ? det.smokeDensity : 0);
  // 光照/照明条件（决定光学测距是否可用：夜暗无照明时看不见，就等于没有光学通道）
  const litLevel = Number.isFinite(det.lightLevel) ? det.lightLevel : 1;
  const litTarget = !!(target && target.flags && ((target.flags.searchlight && target.flags.searchlight.on)
    || (target.flags.illuminated || 0) > 0.05)) || !!(target && (target.compartments || []).some((c) => (c.fire || 0) > 0.1));
  const visibleFactor = det.detected ? 1 : 2;   // 未达"发现"阈值时判读更差，但不再 ×3 灾难性放大

  // 各项误差相乘容易失控：实测乘性系数最高到 4.9×，把 8km 的设计值 75m 抬成 257m。
  // 上限 1.7 保持"舷角差/横摇大/低对比度会更差"的相对关系，但不至于失真。
  const factor = Math.min(1.7, aspectFactor * rollFactor * contrastFactor * smokeFactor * visibleFactor);
  const sigTheta = thetaArcsec * (Math.PI / (180 * 3600)) * factor;
  // dR = R²·dθ/B；再加刻度校准残差 0.4%·R 与舰体倾斜引起的基线投影误差
  let sigmaR = (R * R * sigTheta) / base + 0.002 * R + 0.5 * list;
  if (!Number.isFinite(sigmaR) || sigmaR < 1) sigmaR = Math.max(30, 0.01 * R);
  if (!det.detected) sigmaR = Math.max(sigmaR, 0.015 * R);   // 兜底从 5%R 收到 1.5%R（12km: 600m → 180m）
  // 方位读数误差：望远镜方位圈 ~0.03°，横摇/海况/低对比度恶化
  let sigmaB = (0.060 + 0.020 * roll + 0.015 * seaState) * (1 + 0.5 * rv) * (det.detected ? 1 : 3);
  if (!Number.isFinite(sigmaB) || sigmaB <= 0) sigmaB = 0.3;

  const measuredR = Math.max(200, R + (Number.isFinite(sigmaR) ? rand.normal(0, sigmaR) : 0));
  const measuredB = normDeg(bearing + (Number.isFinite(sigmaB) ? rand.normal(0, sigmaB) : 0));
  return {
    rangeM: measuredR,
    errM: sigmaR,
    bearingDeg: measuredB,
    errDeg: sigmaB,
    // 光学测距可用性：测距手是对着"已发现的目标"读距离，不需要每次重新满足"发现"的对比度阈值，
    // 但夜暗无照明时确实看不见（所以保留光照/照明条件）。旧条件要求 det.detected → 丹麦海峡
    // 黎明时德军全部退回性能很差的对海雷达（σ≈600m），炮术被压到几乎零命中。
    valid: (!det.blockedByLand && R > 200 && R < 38000 && R <= (det.horizonM || 40000) * 0.98
      && R <= (det.visibilityNm || 12) * 1852 * 1.35 && sigmaR < 5000
      && (litLevel > 0.03 || litTarget || R < 4000)),
    type, baseM: base, trueRangeM: R,
    sigmaRangeM: sigmaR, sigmaBearingDeg: sigmaB, thetaArcsec,
    detectionRangeM: det.detectionRangeM, contrastAtTarget: det.contrastAtTarget,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 目视观测 → world.tracks.observe() 的观测包（供 sensors.js 调用）
// ════════════════════════════════════════════════════════════════════════════
// 陆地遮蔽的边沿状态：viewer → Set(targetId)，用于只在"刚被挡住/刚恢复"时各发一次事件
const _landBlockedByViewer = new WeakMap();

function reportLandBlocked(viewer, target, det, env) {
  if (!viewer) return;
  let set = _landBlockedByViewer.get(viewer);
  if (!set) { set = new Set(); _landBlockedByViewer.set(viewer, set); }
  const key = (target && target.id) || target;
  if (set.has(key)) return;              // 边沿触发：连续遮蔽只报一次
  set.add(key);
  const ctx = env ? _worldCtxByEnv.get(env) : null;
  const world = ctx && ctx.world;
  if (!world) return;                    // 无 world（纯函数测试）时只记状态，不发事件
  emit(world, 'sensor.visual.blocked', {
    t: world.t, side: viewer.side, ship: viewer.id, target: key,
    source: 'VISUAL', blockedByLand: true,
    rangeM: Math.round(det.rangeM), bearingDeg: Math.round(det.bearingDeg),
  });
}

function clearLandBlocked(viewer, target) {
  if (!viewer) return;
  const set = _landBlockedByViewer.get(viewer);
  if (!set) return;
  set.delete((target && target.id) || target);
}

export function visualObservation(viewer, target, env, rng, landOrOpts) {
  const det = visualDetection(viewer, target, env, landOrOpts);
  if (det.blockedByLand) {               // 陆地挡住视线：不产生观测；已有航迹由 tracks 失跟
    reportLandBlocked(viewer, target, det, env);
    return null;
  }
  clearLandBlocked(viewer, target);
  if (!det.detected) return null;
  const rand = (rng && typeof rng.normal === 'function') ? rng : { normal: () => 0 };
  const basis = clamp(0.45 + 0.25 * clamp(det.contrastAtTarget / Math.max(0.01, det.contrastThreshold), 0, 2) / 2, 0.4, 0.85);

  let rangeM = null;
  let accuracyM = null;
  let accuracyDeg = clamp(0.35 + 0.10 * (env && env.seaState !== undefined ? env.seaState : 3), 0.3, 2.0);
  let bearingObs = det.bearingDeg;
  let bearingOnly = true;

  const rf = selectRangefinder(viewer);
  const canRange = !!rf && det.rangeM <= 32000 && det.contrastAtTarget >= det.contrastThreshold * 1.1;
  if (canRange) {
    const sol = opticalRangefind(viewer, target, env, rng);
    if (sol && sol.valid) {
      rangeM = sol.rangeM;
      accuracyM = sol.errM;
      accuracyDeg = sol.errDeg;
      bearingObs = sol.bearingDeg;
      bearingOnly = false;
    }
  }
  if (bearingOnly) bearingObs = normDeg(bearingObs + rand.normal(0, accuracyDeg));

  const pos = destPoint(viewer.pos, rangeM === null ? Math.min(30000, Math.max(1000, det.rangeM)) : rangeM, bearingObs);
  return {
    srcKind: 'VISUAL',
    sensorKind: 'VISUAL',
    observerPos: { x: viewer.pos.x, y: viewer.pos.y },
    pos,
    rangeM,
    bearingDeg: bearingObs,
    accuracyM,
    accuracyDeg,
    bearingOnly,
    confidence: basis,
    classifiedAs: 'UNKNOWN',
    features: {
      areaM2: Math.max(10, det.apparentAreaM2 * Math.exp(rand.normal(0, 0.30))),
      areaSigmaLog: 0.30,
      mastM: Math.max(3, mastOf(target) * Math.exp(rand.normal(0, 0.22))),
      mastSigmaLog: 0.22,
      aspectDeg: det.aspectDeg,
    },
  };
}


// ════════════════════════════════════════════════════════════════════════════
// 箔条（window / chaff）：从舰尾投放，随风漂移、膨胀、指数衰减。
// 供 world._applyOne 的 CHAFF 命令调用（契约新增，T2 提供实现）。
// ════════════════════════════════════════════════════════════════════════════
export function deployChaff(world, ship, opts = {}) {
  if (!world || !ship || !world.env) return null;
  bindWorldContext(world);
  const env = world.env;
  if (!Array.isArray(env.chaffClouds)) env.chaffClouds = [];
  const DEGL = Math.PI / 180;
  const windDir = (((env.windDirDeg !== undefined ? env.windDirDeg : 270) + 180) % 360) * DEGL;
  const windMps = (env.windKn !== undefined ? env.windKn : 10) * 0.514444 * 0.7;
  const cloud = {
    x: ship.pos.x + (opts.offsetM || 0) * Math.sin((ship.heading || 0) * DEGL),
    y: ship.pos.y + (opts.offsetM || 0) * Math.cos((ship.heading || 0) * DEGL),
    r: opts.rM || 350,
    rcsM2: opts.rcsM2 || 2500,
    density: 1,
    t0: world.t,
    decayS: opts.decayS || 420,
    vx: Math.sin(windDir) * windMps,
    vy: Math.cos(windDir) * windMps,
    drogue: !!opts.drogue,
    side: ship.side,
    shipId: ship.id,
  };
  env.chaffClouds.push(cloud);
  if (env.chaffClouds.length > 600) env.chaffClouds.splice(0, 200);
  return cloud;
}

// ════════════════════════════════════════════════════════════════════════════
// 烟幕：生成、漂移、扩散、消散（写入 world.env.smokeClouds）
// ════════════════════════════════════════════════════════════════════════════
function emit(world, type, payload) {
  if (world && world.events && typeof world.events.emit === 'function') {
    try { world.events.emit(type, payload); } catch (e) { /* ignore */ }
  }
}

export function updateSmokeClouds(world, dt) {
  if (!world || !world.env) return;
  bindWorldContext(world);   // 把 world.land 登记到 env，供本帧稍后的目视瞭望做陆地遮蔽
  const env = world.env;
  if (!Array.isArray(env.smokeClouds)) env.smokeClouds = [];
  const rng = world.rng;
  const DEGL = Math.PI / 180;
  const windDir = (((env.windDirDeg !== undefined ? env.windDirDeg : 270) + 180) % 360) * DEGL;
  const windMps = (env.windKn !== undefined ? env.windKn : 10) * 0.514444;

  // 1) 已存在烟团：漂移、膨胀、指数消散
  const keep = [];
  for (const c of env.smokeClouds) {
    if (!c) continue;
    c.age = (c.age || 0) + dt;
    c.x += (c.vx || 0) * dt;
    c.y += (c.vy || 0) * dt;
    c.r += (c.growthMps || 6) * dt;
    c.density *= Math.exp(-dt / Math.max(20, c.decayS || 180));
    if (c.density > 0.02 && c.age < (c.lifeS || 600)) keep.push(c);
  }
  env.smokeClouds = keep.length > 1400 ? keep.slice(-1400) : keep;

  // 2) 新烟团：发烟命令、火灾、损管烟雾
  if (!rng) return;
  for (const ship of (world.ships || [])) {
    if (!ship || !ship.isAfloat || !ship.pos) continue;
    const si = ship.flags ? clamp(ship.flags.smokeIntensity || 0, 0, 1.6) : 0;
    const burning = fireLevel(ship);
    const emitting = si > 0.06 || burning > 0.15;
    ship._smokeAcc = (ship._smokeAcc || 0) + dt;
    const interval = 1.6;
    if (emitting) {
      let guard = 0;
      while (ship._smokeAcc >= interval && env.smokeClouds.length < 1400 && guard++ < 4) {
        ship._smokeAcc -= interval;
        const n = si > 0.4 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          // 烟囱/战损位置（艉部烟囱附近）附近生成，随机偏移
          const along = (ship.data && ship.data.loa_m ? ship.data.loa_m : 100) * 0.18;
          const hd = (ship.heading || 0) * DEGL;
          const bx = ship.pos.x + Math.sin(hd) * along + rng.normal(0, 40);
          const by = ship.pos.y + Math.cos(hd) * along + rng.normal(0, 40);
          env.smokeClouds.push({
            x: bx, y: by,
            r: 35 + rng.range(0, 40),
            density: clamp(0.30 + 0.55 * Math.min(1.2, si + burning * 0.5), 0.2, 1.0),
            growthMps: 4 + rng.range(0, 4),
            vx: Math.sin(windDir) * windMps * 0.75,
            vy: Math.cos(windDir) * windMps * 0.75,
            age: 0,
            decayS: 120 + rng.range(0, 120),
            lifeS: 260 + rng.range(0, 240),
            source: ship.id,
          });
        }
      }
    } else {
      ship._smokeAcc = Math.min(ship._smokeAcc, interval);
    }
    if (emitting && !ship._smokeEmitting) {
      ship._smokeEmitting = true;
      emit(world, 'sensor.smoke', { t: world.t, side: ship.side, ship: ship.id, on: true, intensity: +(si + burning).toFixed(2) });
    } else if (!emitting && ship._smokeEmitting) {
      ship._smokeEmitting = false;
      emit(world, 'sensor.smoke', { t: world.t, side: ship.side, ship: ship.id, on: false, intensity: 0 });
    }
  }
}
