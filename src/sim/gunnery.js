// ============================================================================
// src/sim/gunnery.js —— T4 火控（指挥仪解算 / 炮塔随动 / 齐射）
//
// 模型与依据：
//  1. 光学测距误差（体视/合像测距仪）：
//       sigma_R ≈ R^2 * sigma_theta / B
//     B 为基线（英制 15ft=4.57m，美制 Mk52 26.5ft=8.08m），sigma_theta 为
//     操作手/光学匹配的角误差（约 1 角秒量级）。20km/8m 基线 → sigma_R≈240m
//     （1.2% 距离），与二战火控测距仪在 20,000yd 上 ±200~300yd 的实测吻合。
//     误差含相关分量（测距仪标定/视差/目标型宽误判）与随机分量。
//  2. 方位变化率 + 测距变化率解目标运动：对过去 ~90s 的 (R,beta) 观测做
//     加权最小二乘直线拟合（等价于常速度 Kalman 的稳态解），得到目标绝对
//     位置与速度；解算误差由观测噪声、观测数、几何（R*beta_dot）决定，
//     并随时间外推放大（sigma_pos + sigma_v * TOF）。真实火控需 30~90s
//     才能稳定解算，本实现直接体现这一点。
//  3. 射击诸元：迭代求提前量（目标在 TOF 后位置 vs 本舰在 TOF 后位置），
//     弹丸初速矢量已含本舰速度，故瞄准点取两"未来位置"之差；仰角由弹道
//     射表反解；另有横风修正（侧风漂移 ≈ 0.65*w_cross*TOF）、膛线右旋漂移
//     （≈0.0015R）、校射修正（距离偏差/方位偏差）。
//  4. 炮塔随动：按 traverse/elev rate 转动，受电力、战损、炮手素质影响；
//     未对准（>0.35°，局部控制 >1.5°）不得开火。装填节拍由炮塔循环时间
//     （16"/50 ≈ 30s，8" ≈ 11s，5"/38 ≈ 4.5s）、炮手素质、膛线磨损决定。
//  5. 齐射：一个"齐射"= 全部可作战主炮塔同时开火；炮弹数受弹药基数限制，
//     遵守 ship.commanded.firing/targetTrackId/salvoes。
//  6. 指挥仪全毁 → 局部控制（炮塔瞄准镜/炮位测距仪）：方位误差 ~1.2°、
//     距离误差 ~10%、散布 ~4 倍，且无稳定平台（横摇直接进误差），这是
//     日德兰/AAR 里"失去火控后命中率骤降"的物理原因。
//  7. 膛线磨损（每发 WEAR_ACCUM_SCALE/寿命；寿命按口径取史实量级，见 barrelLifeRoundsFor）
//     当前 WEAR_ACCUM_SCALE = 0.01：一轮交战几乎不磨损。改回 1 即恢复史实磨损速率。
//     影响初速 → 射程；火控装订的初速与真实初速存在 ±2°C 药温估计误差。
// ============================================================================
import { clamp, normDeg, normDeg180, deg2rad, rad2deg, dist2d, bearing2d, kn2mps, mps2kn } from '../core/util.js';
import { MIL_DEG, DEG_PER_MIL, makeShell, effectiveMv, solutionForRange, penetrationDetail } from './ballistics.js';

// ---------------------------------------------------------------------------
// 友军误伤（friendly fire）记账
// ---------------------------------------------------------------------------
// 1942 年没有 IFF：夜间混战里把友舰当敌舰打是会真实发生的（萨沃岛）。
// 命中结算仍由 ballistics/damage 按 victim 处理（真打真伤）；本模块只订阅
// gun.hit，在"射手与被害舰同阵营"时补发一条 gun.friendlyfire 供战报/AAR/统计，
// 并轻微扣减双方士气。事件含双方、距离、原因（misId/识别置信度）与是否沉没。
function findFiringTrack(world, shooter, victimId) {
  const tm = world.tracks;
  if (!tm) return null;
  const cands = [];
  if (Array.isArray(tm.tracks)) {
    for (const tr of tm.tracks) {
      if (!tr || tr.dead || tr.side !== shooter.side) continue;
      if (tr._trueIds && tr._trueIds.has(victimId)) cands.push(tr);
    }
  }
  const want = shooter.commanded && shooter.commanded.targetTrackId;
  if (want) {
    const hitTr = cands.find((x) => x.id === want);
    if (hitTr) return hitTr;
  }
  if (cands.length) return cands[0];
  if (want && typeof tm.byId === 'function') return tm.byId(want) || null;
  return null;
}

export function ensureFriendlyFireHook(world) {
  if (!world || !world.events || typeof world.events.on !== 'function') return;
  if (world._friendlyFireHooked) return;
  world._friendlyFireHooked = true;
  // 被友军误击过的舰：若之后真的沉没，补发一条 followUp 事件，回答"是否沉没"
  world._ffStruck = world._ffStruck || new Map();
  world.events.on('ship.sink', (ev) => {
    if (!ev || !ev.ship) return;
    const rec = world._ffStruck.get(ev.ship);
    if (!rec) return;
    world._ffStruck.delete(ev.ship);
    world.events.emit('gun.friendlyfire', Object.assign({}, rec, {
      t: world.t, followUp: true, sunk: true, sinking: false,
      text: rec.text + ' → 该友舰随后沉没',
    }));
  });
  world.events.on('gun.hit', (ev) => {
    if (!ev || !ev.hit) return;
    const hit = ev.hit;
    const shooterId = ev.byShip || hit.attackerId || hit.killerShipId || null;
    const victimId = ev.ship || hit.victimId || null;
    if (!shooterId || !victimId || shooterId === victimId) return;
    const shooter = typeof world.ship === 'function' ? world.ship(shooterId) : null;
    const victim = typeof world.ship === 'function' ? world.ship(victimId) : null;
    if (!shooter || !victim) return;
    if (shooter.side !== victim.side) return;   // 正常命中，不是误伤
    const distM = dist2d(shooter.pos, victim.pos);
    const tr = findFiringTrack(world, shooter, victimId);
    const misId = tr ? (tr.misId || null) : null;
    const foeConfidence = (tr && typeof tr.foeConfidence === 'number') ? +tr.foeConfidence.toFixed(2) : null;
    const cause = misId === 'FRIEND_AS_HOSTILE' ? 'MISIDENTIFIED_FRIENDLY'
      : (tr ? 'FRIENDLY_IN_TRACK' : 'CROSSFIRE');
    const reason = cause === 'MISIDENTIFIED_FRIENDLY'
      ? '把友舰当成敌舰（敌我识别置信度 ' + (foeConfidence === null ? '未知' : foeConfidence.toFixed(2)) + '）'
      : (cause === 'FRIENDLY_IN_TRACK' ? '火控航迹落在友舰上' : '友舰进入射界/交叉火力');
    // 士气：误击己方舰艇对舰员的心理打击是真实存在的（轻微，不改伤害主链路）
    const before = { shooter: shooter.morale, victim: victim.morale };
    shooter.morale = clamp((shooter.morale === undefined ? 1 : shooter.morale) - 0.03, 0.15, 1);
    victim.morale = clamp((victim.morale === undefined ? 1 : victim.morale) - 0.05, 0.15, 1);
    if (shooter.stats) shooter.stats.friendlyFire = (shooter.stats.friendlyFire || 0) + 1;
    world._ffStruck = world._ffStruck || new Map();
    if (!world._ffStruck.has(victim.id)) {
      world._ffStruck.set(victim.id, {
        shooter: shooter.id, shooterName: shooter.name, shooterSide: shooter.side,
        victim: victim.id, victimName: victim.name, victimSide: victim.side, side: shooter.side,
        cause, misId, reason,
        text: shooter.name + ' 误击友舰 ' + victim.name + '（' + Math.round(distM) + 'm，' + reason + '）',
      });
    }
    world.events.emit('gun.friendlyfire', {
      t: world.t,
      shooter: shooter.id, shooterName: shooter.name, shooterSide: shooter.side,
      victim: victim.id, victimName: victim.name, victimSide: victim.side,
      ship: victim.id, name: victim.name, byShip: shooter.id, byShipName: shooter.name,
      side: shooter.side,
      rangeM: Math.round((hit.rangeM || 0) > 0 ? hit.rangeM : distM),
      distanceM: Math.round(distM),
      ammo: hit.ammo || null, caliberMM: hit.caliberMM || null,
      hitPart: (hit.impact && hit.impact.hitPart) || null,
      penetrated: !!hit.penetrated, damageKind: hit.kind || 'SHELL',
      cause, misId, trackId: tr ? tr.id : null, foeConfidence,
      idSource: tr ? (tr.idSource || 'NONE') : null,
      sinking: !!victim.sinking, sunk: !victim.isAfloat,
      morale: {
        shooter: +shooter.morale.toFixed(2), victim: +victim.morale.toFixed(2),
        before: { shooter: +(before.shooter === undefined ? 1 : before.shooter).toFixed(2), victim: +(before.victim === undefined ? 1 : before.victim).toFixed(2) },
      },
      reason,
      text: shooter.name + ' 误击友舰 ' + victim.name + '（' + Math.round(distM) + 'm，' + reason + '）',
    });
  });
}

// ---- 装填/随动默认值（数据库缺字段时） ----
const DEFAULT_CYCLE_S = [
  [406, 30], [381, 26], [356, 25], [305, 20], [283, 18], [203, 11],
  [180, 10], [155, 9], [152, 9], [133, 6], [127, 4.5], [120, 4], [105, 3.5], [76, 3],
];
const DEFAULT_TRAIN_RATE = [
  [406, 4], [381, 4], [356, 4], [305, 5], [283, 6], [203, 6], [155, 8], [152, 8], [127, 12], [105, 15],
];
const DEFAULT_ELEV_RATE = [
  [406, 12], [381, 10], [356, 10], [305, 12], [283, 12], [203, 12], [155, 15], [152, 15], [127, 20], [105, 22],
];
// 齐射级横摇/纵摇残余误差（稳定平台补偿后的残差，单位：度）。
// 标定目标（Lead 验收）：8km 静止目标 10~25% 命中，16km 4~10%，8km 横移 2~8%。
// 史实依据：主力舰齐射 50% 区距离向 ≈1.0~1.5%R、方向向 ≈0.5~0.8%R；
// 其中"单炮初速差/装药差"贡献图案散布，"齐射共享偏置"（横摇相位、视差、
// 弹道表误差、目标运动解算残差）贡献 salvo-to-salvo 系统散布。
const ROLL_ELEV_BASE_DEG = 0.024;   // 稳定平台基线残差（约 1.4 角分）
const ROLL_ELEV_SEA_DEG = 0.009;    // 每级海况附加
const ROLL_ELEV_AMP_DEG = 0.012;    // 每度横摇幅值附加
const ROLL_BEAR_BASE_DEG = 0.006;
const ROLL_BEAR_SEA_DEG = 0.002;
const ROLL_BEAR_AMP_DEG = 0.007;
// 近距离混战：目标进入该距离内，副炮与高射炮压平对海，所有炮一起开火。
// 史实：萨沃岛、苏里高的近距离遭遇战里，副炮/高射炮都在平射；远距离仍按主/副炮通道分配，
// 避免高射炮在 10 km 外白白消耗弹药。数值可调（调大 = 更早全炮开火）。
const CLOSE_ALL_GUNS_M = 3000;
function lookupRate(table, cal, dflt) {
  let best = dflt, bd = 1e9;
  for (const [c, v] of table) { const d = Math.abs(c - cal); if (d < bd) { bd = d; best = v; } }
  return best;
}
function batteryCaliber(battery) {
  const d = (battery && battery.data) || {};
  if (typeof d.caliber_mm === 'number') return d.caliber_mm;
  if (typeof d.caliberMM === 'number') return d.caliberMM;
  if (typeof d.caliber_in === 'number') return d.caliber_in * 25.4;
  return 203;
}
// 炮管寿命（全装药发数）：数据表里的 barrelLifeRounds 对小口径普遍偏低（8 吋 300~400、5 吋 1000~1500、
// 40mm 1500），实战里一轮交战就能把磨损条打满。按口径给一个史实量级下限：
// 16"/50 ≈ 290~350、12 吋 ≈ 350、8"/55 ≈ 700~1000、6"/47 ≈ 1200~1500、5"/38 ≈ 3000~4600、40mm ≈ 9000+。
function barrelLifeFloor(boreMM) {
  const b = boreMM || 200;
  if (b >= 400) return 200;
  if (b >= 350) return 260;
  if (b >= 280) return 350;
  if (b >= 200) return 700;
  if (b >= 150) return 1300;
  if (b >= 100) return 3500;
  return 9000;
}
// 磨损累积比例：1 = 史实（打完一个炮管寿命磨损 100%）；0.01 = 几乎不磨损
// （16 吋打 1000 发约 3%，5 吋打 1000 发约 0.3%）。改这一个常数即可切换标定。
const WEAR_ACCUM_SCALE = 0.01;
function barrelLifeRoundsFor(gun) {
  const d = gun || {};
  const bore = d.bore_mm || d.caliber_mm || d.caliberMM || 200;
  const data = d.barrelLifeRounds || d.barrelLife || 0;
  return Math.max(barrelLifeFloor(bore), data);
}
function batteryCycleS(ship, battery) {
  const d = (battery && battery.data) || {};
  let base = (typeof d.cycleTime_s === 'number' && d.cycleTime_s > 0) ? d.cycleTime_s
    : (typeof d.reloadTime_s === 'number' && d.reloadTime_s > 0) ? d.reloadTime_s
    : (typeof d.reload_s === 'number' && d.reload_s > 0) ? d.reload_s : 0;
  if (!base) {
    const rof = (typeof d.rof_rpm === 'number' && d.rof_rpm > 0) ? d.rof_rpm
      : (typeof d.roundsPerMin === 'number' && d.roundsPerMin > 0) ? d.roundsPerMin
      : (typeof d.rateOfFire_rpm === 'number' && d.rateOfFire_rpm > 0) ? d.rateOfFire_rpm : 0;
    if (rof) base = 60 / rof;
  }
  if (!base) base = lookupRate(DEFAULT_CYCLE_S, batteryCaliber(battery), 20);
  const q = clamp(ship.crewQuality || 0.85, 0.5, 1.25);
  const power = clamp(0.55 + 0.45 * (ship.electricalFrac === undefined ? 1 : ship.electricalFrac), 0.3, 1);
  return base / q / power * (1 + clamp(battery.wear || 0, 0, 1) * 0.05);
}
function batteryTrainRate(ship, battery) {
  const d = battery.data || {};
  if (typeof d.traverseRate_deg_s === 'number') return d.traverseRate_deg_s;
  if (typeof d.trainRate_deg_s === 'number') return d.trainRate_deg_s;
  return lookupRate(DEFAULT_TRAIN_RATE, batteryCaliber(battery), 6);
}
function batteryElevRate(ship, battery) {
  const d = battery.data || {};
  if (typeof d.elevRate_deg_s === 'number') return d.elevRate_deg_s;
  return lookupRate(DEFAULT_ELEV_RATE, batteryCaliber(battery), 12);
}
function elevLimits(battery) {
  const d = (battery && battery.data) || {};
  const lo = (typeof d.elevMin_deg === 'number') ? d.elevMin_deg
    : (typeof d.minElev_deg === 'number') ? d.minElev_deg : -5;
  const hi = (typeof d.elevMax_deg === 'number') ? d.elevMax_deg
    : (typeof d.maxElev_deg === 'number') ? d.maxElev_deg : 45;
  return { lo, hi };
}

// ---------------------------------------------------------------------------
// 状态初始化
// ---------------------------------------------------------------------------
function ensureFC(ship, world) {
  if (ship._fc) return ship._fc;
  const rng = world.rng;
  const fc = {
    powderTempC: 21 + rng.normal(0, 3),          // 发射药实际温度
    powderTempEstC: 0,                          // 火控估计（有误差）
    salvos: 0, lastSalvoT: -1e9,
    blind: false,
    localControl: false,
    nextSalvoLogClean: 0,
  };
  fc.powderTempEstC = fc.powderTempC + rng.normal(0, 0.7);   // 药温装订误差 ≈ ±0.7°C
  ship._fc = fc;
  if (!world.salvoes) world.salvoes = new Map();
  for (const d of ship.directors) ensureDirectorState(d);
  for (const b of ship.batteries) {
    if (!b._guns) {
      b._guns = [];
      for (let i = 0; i < Math.max(1, b.gunsPerMount || 1); i++) b._guns.push({ reloadT: 0 });
    }
    b.loaded = b._guns.filter((g) => g.reloadT <= 0).length;
    b._localState = null;
    b._localSol = null;
  }
  return fc;
}
function ensureDirectorState(d) {
  if (d._fc) return d._fc;
  d._fc = {
    trackId: null, obs: [], motion: null, solution: null,
    biasAng: 0, nextObsT: 0, lastSolveT: -1e9, lastEmitT: -1e9,
    spot: { rangeBiasM: 0, deflBiasMil: 0, tLast: -1e9, samples: 0, source: 'NONE', straddles: 0 },
    // 校射偏置按【目标航迹】分别保存。旧实现存在指挥仪上：AI 换目标后，为上一个目标
    // 累积的偏置（可达数百米）会直接套到新目标上，造成"多数齐射很准、少数极偏"的重尾散布。
    spotByTrack: new Map(),
    ladder: null, lostT: null,
  };
  return d._fc;
}

// 取某目标航迹的校射偏置（不存在则新建）。spotting.js 写入、computeSolution 读取都用它。
export function fcSpotFor(fc, trackId) {
  const blank = { rangeBiasM: 0, deflBiasMil: 0, tLast: -1e9, samples: 0, source: 'NONE', straddles: 0 };
  if (!fc) return Object.assign({}, blank);
  if (!fc.spotByTrack) fc.spotByTrack = new Map();
  const key = trackId || '__none__';
  let s = fc.spotByTrack.get(key);
  if (!s) { s = Object.assign({}, blank); fc.spotByTrack.set(key, s); }
  return s;
}
function resetDirector(d, trackId) {
  const st = ensureDirectorState(d);
  st.trackId = trackId;
  st.obs.length = 0;
  st.motion = null;
  st.solution = null;
  st.nextObsT = 0;
  st.lostT = null;
  st.biasAng = 0;
  // 换目标：只清梯次状态；校射偏置按目标航迹分别保存在 spotByTrack 里，
  // 切回旧目标时可直接复用（真实火控也是这样保存各目标解算数据的）。
  st.spot.rangeBiasM = 0;
  st.spot.deflBiasMil = 0;
  st.spot.samples = 0;
  st.spot.source = 'NONE';
  st.spot.straddles = 0;
  st.spot.tLast = -1e9;
  st.ladder = null;
}

// 目标舰解析：优先 track.targetId，否则取航迹位置最近的敌舰
export function resolveTargetShip(world, ship, track) {
  if (!track) return null;
  if (track.targetId) {
    const s = world.ship(track.targetId);
    if (s && s.isAfloat && s.side !== ship.side) return s;
  }
  let best = null, bd = 1e9;
  for (const s of world.ships) {
    if (!s.isAfloat || s.side === ship.side) continue;
    const d = dist2d(s.pos, track.pos);
    if (d < bd) { bd = d; best = s; }
  }
  const tol = Math.max(900, (track.errM || 120) * 5 + 400);
  return (best && bd < tol) ? best : null;
}

function obsIntervalS(ship, d) {
  // 真实火控测距/标图节拍：熟练舰员 8s，差舰员 12s（不是连续采样）
  const q = clamp(ship.crewQuality || 0.85, 0.5, 1.25);
  return clamp(9.0 / q, 6.0, 14.0);
}
// ---------------------------------------------------------------------------
// 指挥仪观测
// ---------------------------------------------------------------------------
// 指挥仪观测 = 一部传感器，分两条通道：
//  ① 光学通道（昼间/能见度好/无烟幕）：指挥仪的光学瞄准线**持续压在真船上**，
//     误差来自仪器本身——方位 ±0.15~0.4°、测距仪 ±R²σθ/B（见 vision.js opticalRangefind）。
//     关键：这不是"读真值作弊"，而是和 T2 的雷达/光学模型同性质的目标量测。
//  ② 雷达通道（夜暗/烟幕/超视距/光学损毁）：退化为融合航迹定位 + 火控自身测量噪声。
// 旧实现把"航迹的融合位置误差"当成每次齐射重新抽取的白噪声（σ=1.0×errM≈200~600m），
// 等于每打一发都把瞄准点重掷一次——这是命中率被压到 1/3~1/4 的根因。
function takeObservation(ship, d, world, targetShip, track) {
  if (!track) return false;
  const st = ensureDirectorState(d);
  const now = world.t;
  const rng = world.rng;
  const errM = Math.max(30, track.errM || 150);
  let ox, oy, src, sig;
  const opt = (targetShip && targetShip.isAfloat)
    ? opticalRangefind(ship, targetShip, world.env, rng) : null;
  if (opt && opt.valid !== false && opt.rangeM > 0 && Number.isFinite(opt.rangeM) && Number.isFinite(opt.bearingDeg)) {
    // 光学：以真几何 + 仪器误差重建观测量
    const br = deg2rad(opt.bearingDeg);
    ox = ship.pos.x + Math.sin(br) * opt.rangeM;
    oy = ship.pos.y + Math.cos(br) * opt.rangeM;
    src = 'OPTICAL';
    sig = Math.max(15, opt.errM || 40);
  } else {
    // 雷达/标图：融合航迹 + 火控自身测量噪声（火控雷达直接测距测向，优于标图融合位置）
    st.trackBiasX = (st.trackBiasX || 0) * 0.99 + rng.normal(0, 0.03 * errM);
    st.trackBiasY = (st.trackBiasY || 0) * 0.99 + rng.normal(0, 0.03 * errM);
    ox = track.pos.x + st.trackBiasX + rng.normal(0, 0.30 * errM + 10);
    oy = track.pos.y + st.trackBiasY + rng.normal(0, 0.30 * errM + 10);
    src = 'RADAR';
    sig = errM;
  }
  st.obs.push({ t: now, x: ox, y: oy, sigmaPos: Math.max(15, sig), src });
  // 集中式火控：舰级共享"最佳瞄准点"（取本次观测里精度最高的），所有指挥仪用同一个基准
  if (!ship._fcAim || now - ship._fcAim.t > 20 || sig < (ship._fcAim.sigma || 1e9)) {
    ship._fcAim = { x: ox, y: oy, t: now, sigma: sig, src };
  }
  st.obs = st.obs.filter((o) => now - o.t <= 100);
  if (st.obs.length > 40) st.obs.splice(0, st.obs.length - 40);
  return true;
}

// 目标运动滤波：加权最小二乘拟合绝对位置直线 → 速度
function fitMotion(ship, d, world, now) {
  const st = ensureDirectorState(d);
  st.obs = st.obs.filter((o) => now - o.t <= 100);
  if (st.obs.length < 4) { st.motion = null; return null; }
  let sw = 0, stw = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
  const pts = [];
  for (const o of st.obs) {
    const sigma = Math.max(20, o.sigmaPos || Math.hypot(o.sigmaR || 100, (o.sigmaB || 0.005) * 20000));
    const w = 1 / (sigma * sigma);
    pts.push({ t: o.t, x: o.x, y: o.y, w });
    sw += w; stw += w * o.t; sx += w * o.x; sy += w * o.y;
    stt += w * o.t * o.t; stx += w * o.t * o.x; sty += w * o.t * o.y;
  }
  const tmean = stw / sw;
  const Sxx = stt - sw * tmean * tmean;
  if (Sxx < 1e-3) { st.motion = null; return null; }
  const xmean = sx / sw, ymean = sy / sw;
  const vx = (stx - sw * tmean * xmean) / Sxx;
  const vy = (sty - sw * tmean * ymean) / Sxx;
  const x0 = xmean + vx * (now - tmean);
  const y0 = ymean + vy * (now - tmean);
  // 残差与斜率标准误差
  let ss = 0;
  for (const p of pts) {
    const ex = p.x - (xmean + vx * (p.t - tmean));
    const ey = p.y - (ymean + vy * (p.t - tmean));
    ss += p.w * (ex * ex + ey * ey);
  }
  const dof = Math.max(1, pts.length - 2);
  const sigmaFit = Math.sqrt(ss / dof);
  const sigmaV = Math.sqrt(1 / Math.max(1e-9, Sxx));
  const span = now - pts[0].t;
  const speed = Math.hypot(vx, vy);
  const quality = clamp(pts.length / 10, 0.15, 1) * clamp(1 - sigmaFit / 150, 0.1, 1) * clamp(span / 45, 0.25, 1);
  st.motion = {
    x: x0, y: y0, vx, vy,
    courseDeg: normDeg(rad2deg(Math.atan2(vx, vy))),
    speedKn: mps2kn(speed),
    sigmaPosM: sigmaFit, sigmaVelMps: sigmaV,
    n: pts.length, spanS: span, tFit: now, quality,
    source: st.obs[st.obs.length - 1].src,
  };
  // ── 集中式火控计算机 ──────────────────────────────────────────────────────
  // 真实火控是一台集中式解算器（德制 C/38、英制 Admiralty Fire Control Table），
  // 各指挥仪/测距仪的观测汇入**同一套**目标运动解算。旧实现让每个指挥仪各自拟合，
  // 两台指挥仪对同一目标能解出相差 40 密位（≈6.6°）的提前量 —— 这是齐射间横向
  // 散布 1.5km、轴心命中率被压到 1/10 的直接原因。这里把最好的拟合共享到舰级。
  const cur = ship._fcMotion;
  if (!cur || now - cur.tFit > 8 || st.motion.n > (cur.n || 0) || (st.motion.quality > (cur.quality || 0) + 0.08)) {
    ship._fcMotion = Object.assign({}, st.motion, { tFit: now, dirId: d.id });
  }
  return st.motion;
}

// 风分量（相对射向）。crossWind：右正；alongWind：顺风为正（m/s）
function crossWindMps(world, bearingDeg) {
  const env = world.env;
  const wkn = env.windKn || 0;
  const wdir = deg2rad((env.windDirDeg || 0) + 180);   // 风的去向
  const wx = kn2mps(wkn) * Math.sin(wdir), wy = kn2mps(wkn) * Math.cos(wdir);
  const b = deg2rad(bearingDeg);
  const right = { x: Math.cos(b), y: -Math.sin(b) };   // 射向右侧单位向量
  return wx * right.x + wy * right.y;
}
function alongWindMps(world, bearingDeg) {
  const env = world.env;
  const wkn = env.windKn || 0;
  const wdir = deg2rad((env.windDirDeg || 0) + 180);
  const wx = kn2mps(wkn) * Math.sin(wdir), wy = kn2mps(wkn) * Math.cos(wdir);
  const b = deg2rad(bearingDeg);
  const fwd = { x: Math.sin(b), y: Math.cos(b) };
  return wx * fwd.x + wy * fwd.y;
}

// ---------------------------------------------------------------------------
// 射击诸元解算（契约接口）
// ---------------------------------------------------------------------------
export function computeSolution(ship, director, track, world) {
  if (!ship || !director || !track) return null;
  const st = ensureDirectorState(director);
  const now = world.t;
  const fc = ship._fc || ensureFC(ship, world);
  // ---- 目标运动估计 ----
  let mx = track.pos.x, my = track.pos.y, mvx = 0, mvy = 0;
  let source = 'TRACK', quality = 0.3, sigmaPos = track.errM || 300, sigmaVel = 4;
  // 优先用舰级（集中式）运动解算：所有指挥仪共享同一套目标运动
  let mot = (ship._fcMotion && now - ship._fcMotion.tFit < 8) ? ship._fcMotion : null;
  if (!mot && st.motion && now - st.motion.tFit < 8) mot = st.motion;
  if (mot && now - mot.tFit < 60) {
    // 目标当前位置取"最近一次测距/标图定位"，速度取拟合值：
    // 单次定位误差（航迹/测距仪误差）会直接进入本齐射瞄准点——这正是
    // 传感器误差影响命中率的通道；长期平均会把这部分误差抹掉，不真实。
    const lastObs = (ship._fcAim && now - ship._fcAim.t < 8) ? ship._fcAim : (st.obs.length ? st.obs[st.obs.length - 1] : null);
    if (lastObs && now - lastObs.t < 45) {
      mx = lastObs.x + mot.vx * (now - lastObs.t);
      my = lastObs.y + mot.vy * (now - lastObs.t);
    } else { mx = mot.x; my = mot.y; }
    mvx = mot.vx; mvy = mot.vy;
    source = mot.source; quality = mot.quality;
    sigmaPos = mot.sigmaPosM; sigmaVel = mot.sigmaVelMps;
    // 目标运动基准必须来自 T2 航迹给出的估计航向/航速（含其误差），
    // 与位置拟合速度加权融合：航迹 course/speed 权重 0.75，拟合速度 0.25。
    // 这样"航迹航向故意偏 30°"必然把解算提前量带错（Lead 要求 1）。
    if (typeof track.courseDeg === 'number' && typeof track.speedKn === 'number' &&
        (track.ageS === undefined || track.ageS < 30)) {
      const spd = kn2mps(track.speedKn || 0);
      const tvx = spd * Math.sin(deg2rad(track.courseDeg));
      const tvy = spd * Math.cos(deg2rad(track.courseDeg));
      // 真实火控的提前量来自指挥仪**连续跟踪**得到的距离变化率与方位变化率（rate control），
      // 标图给出的航向/航速只作校核。原实现 0.75 权重压在航迹航向航速上，把标图误差
      // （航向 ±20~30°）直接变成提前量误差（15s 飞行时间 ≈ 100~150m）。
      mvx = 0.30 * tvx + 0.70 * mot.vx;
      mvy = 0.30 * tvy + 0.70 * mot.vy;
    }
  } else if (typeof track.courseDeg === 'number' && typeof track.speedKn === 'number') {
    const spd = kn2mps(track.speedKn || 0);
    mvx = spd * Math.sin(deg2rad(track.courseDeg));
    mvy = spd * Math.cos(deg2rad(track.courseDeg));
    mx = track.pos.x; my = track.pos.y;
  } else {
    return null;
  }
  // ---- 本舰速度 ----
  const hd = deg2rad(ship.heading || 0);
  const ospd = kn2mps(ship.speed || 0);
  const ovx = ospd * Math.sin(hd), ovy = ospd * Math.cos(hd);
  // ---- 弹药与初速（火控装订值，含药温估计误差） ----
  const ammo = (ship.commanded && ship.commanded.fireAmmo) || 'AP';
  let battery = null;
  for (const b of ship.mainBatteries || []) { if (!b.destroyed && b.health > 0.1 && hasAmmo(b, ammo)) { battery = b; break; } }
  if (!battery) { for (const b of ship.mainBatteries || []) { if (!b.destroyed) { battery = b; break; } } }
  if (!battery) { battery = (ship.batteries || [])[0]; }
  if (!battery) return null;
  const shell = makeShell(ship, battery, ammo);
  const mv = effectiveMv(battery, shell, fc.powderTempEstC);
  // ---- 迭代提前量 ----
  let tof = Math.max(6, dist2d(ship.pos, { x: mx, y: my }) / 500);
  let sol = null, range = 0, bearing = 0, aimX = 0, aimY = 0, outOfRange = false;
  for (let it = 0; it < 5; it++) {
    const tx = mx + mvx * tof, ty = my + mvy * tof;        // 目标未来位置
    const ox = ship.pos.x + ovx * tof, oy = ship.pos.y + ovy * tof;  // 本舰未来位置
    aimX = tx; aimY = ty;
    const dx = tx - ox, dy = ty - oy;
    range = Math.hypot(dx, dy);
    bearing = normDeg(rad2deg(Math.atan2(dx, dy)));
    // 横风漂移 + 膛线右旋漂移补偿（向右为正的横向漂移量）
    const windDrift = crossWindMps(world, bearing) * tof * 0.65;
    const spinDrift = 0.0015 * range;
    const lateralDrift = windDrift + spinDrift;
    if (range > 1) bearing = normDeg(bearing - rad2deg(lateralDrift / range));
    // 校射修正（取当前目标航迹自己的偏置）
    // 校射偏置按【主炮】隔离：副炮/近战炮的落点不能污染主炮梯次
    const spotKey = 'MAIN|' + ((track && track.id) ? track.id : st.trackId);
    const spotNow = fcSpotFor(st, spotKey);
    bearing = normDeg(bearing + spotNow.deflBiasMil * MIL_DEG);
    // 纵风修正：弹丸被气流携带 ≈ w_along * TOF（顺风加射程），火控按气象修正
    const alongDrift = alongWindMps(world, bearing) * tof * 0.85;
    const aimRange = Math.max(120, range + spotNow.rangeBiasM - alongDrift);
    sol = solutionForRange(shell, aimRange, mv);
    if (sol.outOfRange) { outOfRange = true; break; }
    if (Math.abs(sol.tofS - tof) < 0.2) { tof = sol.tofS; break; }
    tof = sol.tofS;
  }
  if (!sol) return null;
  const tofUsed = tof;
  // 视线上当前目标方位
  const presentBearing = bearing2d(ship.pos, { x: mx, y: my });
  const deflectionMil = normDeg180(bearing - presentBearing) * DEG_PER_MIL;
  // ---- 误差预算 ----
  const rangeErrBallistic = 0.0035 * range + 3;
  const sigmaRangeM = Math.hypot(sigmaPos, sigmaVel * tofUsed, rangeErrBallistic);
  const sigmaDeflM = Math.hypot(sigmaPos * 0.7, sigmaVel * tofUsed, 0.002 * range + 3);
  const gunDispMil = 0.9;
  const spreadMil = Math.hypot(sigmaRangeM / Math.max(300, range) * 1018.6,
    sigmaDeflM / Math.max(300, range) * 1018.6 * 0.85, gunDispMil);
  const ageS = now - (st.motion ? st.motion.tFit : now);
  const q = quality * Math.exp(-Math.max(0, ageS) / 90);
  const valid = !outOfRange && q > 0.05 && ageS < 35 && range > 300;
  const tgtShip = resolveTargetShip(world, ship, track);
  return {
    t: now,
    valid, outOfRange,
    bearingDeg: bearing,
    rangeM: range,
    deflectionMil,
    timeOfFlightS: tofUsed,
    spreadMil,
    elevDeg: clamp(sol.elevDeg, -5, 70),
    fallAngleDeg: sol.fallAngleDeg,
    vStrikeMps: sol.vStrikeMps,
    aimPos: { x: aimX, y: aimY },
    targetPos: { x: mx, y: my },
    targetCourseDeg: normDeg(rad2deg(Math.atan2(mvx, mvy))),
    targetSpeedKn: mps2kn(Math.hypot(mvx, mvy)),
    targetRangeRateMps: 0, // 由 filter 另行报告
    sigmaRangeM, sigmaDeflectionM: sigmaDeflM,
    quality: q, source, degraded: false,
    directorId: director.id || null, directorLabel: director.label || '',
    trackId: track.id, targetShipId: (tgtShip && tgtShip.id) || track.targetId || null,
    ammo, mvMps: mv, shellMassKg: shell.massKg, caliberMM: shell.caliberMM,
    corrections: { rangeM: st.spot.rangeBiasM, deflMil: st.spot.deflBiasMil, source: st.spot.source },
  };
}

function hasAmmo(battery, ammo) {
  return !!(battery && battery.ammo && (battery.ammo[ammo] || 0) > 0);
}
function pickAmmo(battery, requested) {
  if (!battery || !battery.ammo) return null;
  const chain = {
    AP: ['AP', 'SAP', 'HE'], SAP: ['SAP', 'AP', 'HE'], HE: ['HE', 'SAP', 'AP'],
    STAR: ['STAR', 'ILLUM', 'HE'], ILLUM: ['ILLUM', 'STAR', 'HE'], AA: ['AA', 'HE', 'SAP'],
  }[requested] || [requested, 'AP', 'HE'];
  for (const a of chain) if ((battery.ammo[a] || 0) > 0) return a;
  return null;
}

// ---------------------------------------------------------------------------
// 炮塔随动 / 装填
// ---------------------------------------------------------------------------
function updateReload(ship, battery, dt) {
  if (!battery._guns) return;
  let changed = false;
  for (const g of battery._guns) {
    if (g.reloadT > 0) { g.reloadT = Math.max(0, g.reloadT - dt); if (g.reloadT === 0) changed = true; }
  }
  const loaded = battery._guns.filter((g) => g.reloadT <= 0).length;
  if (loaded !== battery.loaded) { battery.loaded = loaded; changed = true; }
  battery.cycleTimer = Math.max(0, ...battery._guns.map((g) => g.reloadT));
  return changed;
}
function moveServo(ship, battery, world, dt) {
  const power = clamp(0.45 + 0.55 * (ship.electricalFrac === undefined ? 1 : ship.electricalFrac), 0.25, 1)
    * clamp(0.4 + 0.6 * (battery.health === undefined ? 1 : battery.health), 0.25, 1);
  const trainRate = batteryTrainRate(ship, battery) * power;
  const elevRate = batteryElevRate(ship, battery) * power;
  if (battery.targetTrain !== null && battery.targetTrain !== undefined) {
    const dTrain = normDeg180(battery.targetTrain - battery.train);
    battery.train = normDeg(battery.train + clamp(dTrain, -trainRate * dt, trainRate * dt));
  }
  if (battery.targetElev !== null && battery.targetElev !== undefined) {
    const lim = elevLimits(battery);
    const want = clamp(battery.targetElev, lim.lo, lim.hi);
    const dElev = want - battery.elev;
    battery.elev = clamp(battery.elev + clamp(dElev, -elevRate * dt, elevRate * dt), lim.lo, lim.hi);
  }
}
function servoAligned(ship, battery, sol, tolDeg) {
  if (!sol) return false;
  const dTrain = Math.abs(normDeg180(battery.train - sol.bearingDeg));
  const dElev = Math.abs(battery.elev - sol.elevDeg);
  return dTrain <= tolDeg && dElev <= Math.max(0.2, tolDeg * 0.75);
}

// ---------------------------------------------------------------------------
// 局部控制（指挥仪全毁时的降级）
// ---------------------------------------------------------------------------
function buildLocalSolution(ship, battery, world, track, ammoOverride) {
  const now = world.t;
  const fc = ship._fc || ensureFC(ship, world);
  let ls = battery._localState;
  if (!ls) {
    ls = battery._localState = {
      nextT: 0, bearingBiasDeg: world.rng.normal(0, 0.6),
      rangeBias: world.rng.normal(0, 0.04), elevBias: world.rng.normal(0, 0.25),
    };
  }
  if (now >= ls.nextT) {
    if (!track) { battery._localSol = null; return null; }
    const R = dist2d(ship.pos, track.pos);
    const B = bearing2d(ship.pos, track.pos);
    const ammo = pickAmmo(battery, ammoOverride || (ship.commanded && ship.commanded.fireAmmo) || 'AP');
    if (!ammo) { battery._localSol = null; return null; }
    const shell = makeShell(ship, battery, ammo);
    const mv = effectiveMv(battery, shell, fc.powderTempEstC);
    // 局部控制的测距精度与距离相关：近距离光学测距本可以达到 2~3%（点射/近战），
    // 远距离没有指挥仪集中解算则明显更差（沿用旧标定 ~10%）。
    const closeLocal = R <= 6000;
    // 火控冗余：指挥仪全毁后，舰桥/炮塔上的光学测距仪仍在，炮位可据此求射击诸元。
    // 有测距仪 → 局部控制明显好于"完全瞎打"（这也是史实：损失的只是集中解算，不是测距能力）。
    const rfOk = (ship.rangefinders || []).some((rf) => rf && !rf.destroyed && (rf.health === undefined || rf.health > 0.2));
    const errMul = rfOk ? (closeLocal ? 0.6 : 0.7) : 1;
    const bearing = normDeg(B + ls.bearingBiasDeg + world.rng.normal(0, (closeLocal ? 0.5 : 1.0) * errMul));
    const range = Math.max(300, R * (1 + ls.rangeBias + world.rng.normal(0, (closeLocal ? 0.04 : 0.10) * errMul)));
    const sol = solutionForRange(shell, range, mv);
    if (sol.outOfRange) { battery._localSol = null; ls.nextT = now + 6; return null; }
    const lim = elevLimits(battery);
    const elev = clamp(sol.elevDeg + ls.elevBias + world.rng.normal(0, 0.3) + Math.abs(ship.roll || 0) * 0.12, lim.lo, lim.hi);
    battery._localSol = {
      t: now, valid: true, outOfRange: false, degraded: true, source: rfOk ? 'LOCAL_RF' : 'LOCAL',
      bearingDeg: bearing, elevDeg: elev, rangeM: range,
      deflectionMil: normDeg180(bearing - B) * DEG_PER_MIL,
      timeOfFlightS: sol.tofS, fallAngleDeg: sol.fallAngleDeg,
      spreadMil: (closeLocal ? 30 : 55) * (rfOk ? 0.8 : 1),
      sigmaRangeM: (closeLocal ? 0.05 : 0.10) * range * (rfOk ? 0.75 : 1),
      sigmaDeflectionM: (closeLocal ? 0.02 : 0.035) * range * (rfOk ? 0.75 : 1),
      quality: (closeLocal ? 0.35 : 0.15) + (rfOk ? 0.1 : 0), ammo, mvMps: mv, directorId: null,
      directorLabel: rfOk ? '局部控制(测距仪)' : '局部控制',
      trackId: track ? track.id : null, targetShipId: null,
      targetCourseDeg: track.courseDeg || 0, targetSpeedKn: track.speedKn || 0,
      corrections: { rangeM: 0, deflMil: 0, source: 'NONE' },
    };
    ls.nextT = now + 5 + world.rng.range(0, 4);
  }
  return battery._localSol;
}

// ---------------------------------------------------------------------------
// 齐射
// ---------------------------------------------------------------------------
export function fireSalvo(ship, battery, solution, world, opts = {}) {
  if (!battery || battery.destroyed) return { fired: 0, salvoId: opts.salvoId || null };
  ensureFriendlyFireHook(world);
  if (!battery._guns) ensureFC(ship, world);
  const fc = ship._fc;
  const role = opts.role || null;
  const targetShipId = opts.targetShipId !== undefined ? opts.targetShipId : null;
  const trackId = opts.trackId !== undefined ? opts.trackId : null;
  const ammoWant = opts.ammo || (solution && solution.ammo) || 'AP';
  const ammo = pickAmmo(battery, ammoWant) || opts.ammo;
  if (!ammo) return { fired: 0, salvoId: opts.salvoId || null };
  const lightNow = (world.env && world.env.lightLevel !== undefined) ? world.env.lightLevel : 1;
  // —— 射界安全：不得穿过僚舰开火 ——
  // 实测沙盒 604：阳炎在 400-600m 上把旗舰大和打成了筛子（8 发 127mm）——
  // 航迹瞄准的是更远的敌舰，大和正好在射界上。真实舰长不会隔着僚舰开炮。
  if (lightNow > 0.45 && solution && Number.isFinite(solution.bearingDeg) && Number.isFinite(solution.rangeM)) {
    const brg = solution.bearingDeg * Math.PI / 180;
    const ux = Math.sin(brg), uy = Math.cos(brg);
    const maxR = solution.rangeM;
    let blockedBy = null, blockD = 1e9;
    for (const f of world.ships) {
      if (!f.isAfloat || f.side !== ship.side || f.id === ship.id) continue;
      const dx = f.pos.x - ship.pos.x, dy = f.pos.y - ship.pos.y;
      const along = dx * ux + dy * uy;
      const cross = Math.abs(dx * uy - dy * ux);
      if (along < 80 || along > maxR - 80) continue;
      if (cross <= 170 && along < blockD) { blockD = along; blockedBy = f; }
    }
    if (blockedBy) {
      if (!ship._losHoldNotified) {
        ship._losHoldNotified = true;
        world.events.emit('fc.update', {
          t: world.t, ship: ship.id, side: ship.side, kind: 'TARGET_FRIENDLY',
          trackId: solution.trackId || null,
          text: '射界被僚舰 ' + blockedBy.name + ' 遮挡（' + Math.round(blockD) + 'm），拒绝开火',
        });
      }
      return { fired: 0, salvoId: opts.salvoId || null };
    }
  }
  // —— 日间近距开火安全闸（主炮/副炮统一）——
  // 火控解算指向的航迹若就贴在一艘已知友舰上（≤220m），白天目视不可能认错：
  // 拒绝射击。夜间/烟幕保留 A2 的识别不确定性（误伤仍是战争的一部分）。
  if (lightNow > 0.45 && solution && (solution.trackId || solution.targetShipId)) {
    const tr = solution.trackId ? world.tracks.byId(solution.trackId) : null;
    const probePos = tr ? tr.pos : (solution.targetShipId ? (world.ship(solution.targetShipId) || {}).pos : null);
    if (probePos) {
      let nearFriend = null, bd = 1e9;
      for (const f of world.ships) {
        if (!f.isAfloat || f.side !== ship.side || f.id === ship.id) continue;
        const dd = dist2d(f.pos, probePos);
        if (dd < bd) { bd = dd; nearFriend = f; }
      }
      if (nearFriend && bd <= 220) {
        if (!ship._safetyHoldNotified) {
          ship._safetyHoldNotified = true;
          world.events.emit('fc.update', {
            t: world.t, ship: ship.id, side: ship.side, kind: 'TARGET_FRIENDLY',
            trackId: solution.trackId || null,
            text: '日间近距：射击航迹即僚舰 ' + nearFriend.name + '（' + Math.round(bd) + 'm），拒绝开火',
          });
        }
        return { fired: 0, salvoId: opts.salvoId || null };
      }
    }
  }
  const shell = makeShell(ship, battery, ammo);
  const mv = effectiveMv(battery, shell, fc ? fc.powderTempC : 21);
  const nGuns = Math.max(1, battery.gunsPerMount || 1);
  const pattern = opts.pattern || 'SALVO';
  world._t4SalvoSeq = (world._t4SalvoSeq || 0) + 1;
  const salvoId = opts.salvoId || (ship.id + '#S' + world._t4SalvoSeq);
  const baseTrainErr = opts.bearingOffsetDeg || 0;
  const baseElevErr = opts.elevOffsetDeg || 0;
  // ---- 单炮不可约散布（史实标定）----
  // 齐射落点分布的 50% 区（全宽）：距离向 ≈ 1.0~1.5% R，方向向 ≈ 0.5~0.8% R
  // （英美战列舰射表/丹麦海峡与太平洋实测统计；高斯 1σ = 50%区 / 1.349）。
  // 这里取距离 1σ≈0.75%R、方向 1σ≈0.36%R，归因于：各炮初速差（装药重量/药温/
  // 膛线磨损）、弹道系数差、炮口跳动与炮塔对齐残差。齐射级横摇/视差误差在
  // tryFire 中按海况与稳定平台状态另行注入（同一齐射内所有弹共享）。
  const R = solution ? Math.max(400, solution.rangeM) : 12000;
  const mechMil = (shell && shell.mechDispersionMil) || 1.5;
  const mechF = Math.sqrt(clamp(mechMil / 1.5, 0.55, 2.8));
  const degradeF = (solution && solution.degraded)
    ? (solution.source === 'LOCAL_RF' ? (solution.rangeM <= 6000 ? 1.6 : 2.8)
      : solution.source === 'LOCAL' ? (solution.rangeM <= 6000 ? 2.0 : 4.0) : 4.0)
    : 1.0;
  // 单炮 1σ：随距离近似线性 + 固定项（炮口跳动/装药差与距离无关部分）
  // 单炮 1σ ≈ (0.65%R + 36m)：对应 50% 区 ≈1.3~1.5%R@8km、~1.2%R@16km，
  // 落在史实 1.0~1.5%R 区间内（Lead 验收）
  // 远距散布的超线性增长：线性外推到 16 km 会高估命中率（实测 8.3% vs 史实 3~5%）。
  // R>10 km 后每 10 km 再放大约 40%，16 km 约 ×1.24 —— 与实测散布随距离的加速增长一致。
  const farF = 1 + Math.max(0, R - 10000) / 25000;
  const sigmaRangeM = (R * 0.0070 + 38) * mechF * degradeF * farF;
  const sigmaDeflM = (R * 0.0038 + 16) * mechF * degradeF * farF;
  // 距离偏差 → 仰角偏差（射表局部斜率 dθ/dR）
  let degPerM = 0.0012;
  if (solution) {
    const rlo = Math.max(200, R - 250), rhi = R + 250;
    const elo = solutionForRange(shell, rlo, mv).elevDeg;
    const ehi = solutionForRange(shell, rhi, mv).elevDeg;
    degPerM = (ehi - elo) / (rhi - rlo);
  }
  // 齐射内各炮按 pattern 分布（真实：单炮散布 + 齐射系统误差）
  let fired = 0;
  const tof = solution ? solution.timeOfFlightS : 0;
  for (let g = 0; g < nGuns; g++) {
    if ((battery.ammo[ammo] || 0) <= 0) break;
    if (battery._guns && battery._guns[g] && battery._guns[g].reloadT > 0) continue;
    const drM = world.rng.normal(0, sigmaRangeM);        // 该炮射程偏置（m）
    const ddM = world.rng.normal(0, sigmaDeflM);         // 该炮方向偏置（m）
    let elevOff = baseElevErr + drM * degPerM;
    let bearOff = baseTrainErr + rad2deg(ddM / Math.max(300, R));
    if (pattern === 'LADDER') {
      // 梯次：同一齐射内各炮按 0.5mil 阶梯（大编队校射常用）
      elevOff += (g - (nGuns - 1) / 2) * 0.5 * 0.85;
    } else if (pattern === 'SPLIT') {
      bearOff += (g % 2 === 0 ? -0.4 : 0.4);
    }
    battery.ammo[ammo] = Math.max(0, (battery.ammo[ammo] || 0) - 1);
    // 残余机械抖动（炮口跳动），主散布已由 drM/ddM 体现
    const dispersion = solution && solution.degraded ? (solution.source === 'LOCAL' ? 0.6 : 1.2) : 0.35;
    spawnProjectileLocal(world, {
      ship, battery, ammo, shell, mv,
      bearingDeg: solution ? solution.bearingDeg : battery.train,
      elevDeg: solution ? solution.elevDeg : battery.elev,
      dispersionMil: dispersion,
      bearingOffsetDeg: bearOff, elevOffsetDeg: elevOff,
      trackId: solution ? solution.trackId : null,
      targetShipId: solution ? solution.targetShipId : null,
      salvoId, gunIndex: g, rangeM: solution ? solution.rangeM : 0,
      predictedTofS: tof, powderTempC: fc ? fc.powderTempC : 21,
    });
    if (battery._guns && battery._guns[g]) {
      battery._guns[g].reloadT = batteryCycleS(ship, battery) * (0.95 + world.rng.next() * 0.1);
    }
    battery.roundsFired = (battery.roundsFired || 0) + 1;
    const barrelLife = barrelLifeRoundsFor(battery.data);
    battery.wear = clamp((battery.wear || 0) + WEAR_ACCUM_SCALE / barrelLife, 0, 1);
    battery.lastFireT = world.t;
    world.events.emit('gun.fire', {
      t: world.t, ship: ship.id, name: ship.name, side: ship.side,
      battery: battery.label, batteryId: battery.id, gun: g,
      ammo, caliberMM: shell.caliberMM, massKg: +shell.massKg.toFixed(1),
      bearingDeg: +((solution ? solution.bearingDeg : battery.train)).toFixed(2),
      elevDeg: +((solution ? solution.elevDeg : battery.elev)).toFixed(2),
      mvMps: +mv.toFixed(0), wear: +(battery.wear || 0).toFixed(3),
      role: role || (battery.role === 'main' ? 'main' : battery.role === 'aa' ? 'aa' : 'secondary'),
      targetShipId, trackId,
      salvoId, rangeM: solution ? Math.round(solution.rangeM) : 0,
    });
    fired++;
  }
  if (fired > 0) {
    battery.loaded = battery._guns ? battery._guns.filter((g) => g.reloadT <= 0).length : 0;
    if (battery._guns) battery.cycleTimer = Math.max(...battery._guns.map((g) => g.reloadT));
    // 单炮塔齐射事件（全炮塔齐射时由 tryFire 汇总为一条，见 emitSalvoEvent）
    if (opts.emitSalvoEvent !== false) {
      world.events.emit('gun.salvo.away', {
        t: world.t, ship: ship.id, name: ship.name, side: ship.side,
        battery: battery.label, batteryId: battery.id, ammo,
        gunsFired: fired, gunsInMount: nGuns,
        rangeM: solution ? Math.round(solution.rangeM) : 0,
        bearingDeg: solution ? +solution.bearingDeg.toFixed(2) : null,
        elevDeg: solution ? +solution.elevDeg.toFixed(2) : null,
        tofS: solution ? +solution.timeOfFlightS.toFixed(1) : null,
        spreadMil: solution ? +solution.spreadMil.toFixed(2) : null,
        targetTrackId: solution ? solution.trackId : null,
        targetShipId: solution ? solution.targetShipId : null,
        salvoId, degraded: !!(solution && solution.degraded),
        salvoNo: ship._fc ? ship._fc.salvos : 0,
      });
    }
    if (ship.stats) ship.stats.shotsFired = (ship.stats.shotsFired || 0) + fired;
  }
  return { fired, salvoId };
}

// 避免与 ballistics 循环依赖时的静态绑定问题：运行时惰性取用
import { spawnProjectile } from './ballistics.js';
import { opticalRangefind } from './vision.js';
function spawnProjectileLocal(world, spec) {
  return spawnProjectile(world, spec);
}

// ---------------------------------------------------------------------------
// 开火决策
// ---------------------------------------------------------------------------
function tryFire(ship, world, dt, primary, targetShip, track, opts = {}) {
  const fc = ship._fc;
  const now = world.t;
  // ── 主炮 / 副炮两条火力通道 ──
  // cmd 是该通道的命令视图（主炮 = ship.commanded；副炮 = 由 AI/玩家下发的 sec* 字段），
  // state 是该通道独立的节流/齐射状态（副炮用 fc.sec，不会阻塞主炮的齐射节奏）。
  const cmd = opts.cmd || (ship.commanded || {});
  const state = opts.fcState || fc;
  const role = opts.role || (cmd.fireBattery === 'secondary' ? 'secondary' : 'main');
  if (!cmd || !cmd.firing) return;
  if (cmd.salvoes !== undefined && cmd.salvoes <= 0) { cmd.firing = false; return; }
  // 已确认为友舰的航迹不得开火（识不清时照常开火，见 updateFireControl 的注释）
  if (track && track.hostile === false && !(cmd.overrideFriendly === true)) return;
  if (now - (state.lastSalvoT || -1e9) < 1.5) return;
  // 副炮通道只取 role='secondary'（5"/6" 等对海副炮）；高射炮（role='aa'）对海无效，
  // 不应被当成副炮打水面目标（否则会白白消耗防空弹药、事件里还出现"高射炮齐射"）。
  const allBats = (role === 'main'
    ? (ship.mainBatteries || [])
    : role === 'close'
      ? (ship.batteries || []).filter((b) => b.role === 'secondary' || b.role === 'aa')
      : (ship.secondaryBatteries || []).filter((b) => b.role === 'secondary'))
    .filter((b) => !b.destroyed && (b.health === undefined || b.health > 0.15));
  if (!allBats.length) return;
  const ammoReq = cmd.fireAmmo || ((role === 'secondary' || role === 'close') ? 'HE' : 'AP');
  // 按炮位选弹（近距离全炮通道用：按目标类型与预计穿深在 AP/HE 之间自动选）
  const ammoForBattery = typeof opts.ammoForBattery === 'function' ? opts.ammoForBattery : null;
  const wantAmmoOf = (b) => (ammoForBattery ? ammoForBattery(b) : ammoReq);
  // 可作战/有弹的炮塔
  const opBats = allBats.filter((b) => pickAmmo(b, wantAmmoOf(b)));
  if (!opBats.length) return;
  const ready = [];
  for (const b of opBats) {
    const loaded = (b._guns || []).filter((g) => g.reloadT <= 0).length;
    if (loaded < 1) continue;
    // 副炮用自己的局部解算（buildLocalSolution 按该炮塔口径求弹道）；主炮用主指挥仪解算
    const sol = role === 'main'
      ? ((primary && primary._fc && primary._fc.solution) ? primary._fc.solution : (b._localSol || null))
      : (b._localSol || null);
    if (!sol || sol.valid === false || sol.outOfRange) continue;
    if (!servoAligned(ship, b, sol, sol.degraded ? 1.6 : 0.4)) continue;
    ready.push({ b, sol, loaded });
  }
  if (!ready.length) { state.pendingSince = null; return; }
  // ---- 齐射序列化（真实校射流程：射击 → 着弹观测 → 修正 → 再射击）----
  // 前一次齐射未完成观测前不打下一发，避免"边打边修"造成的自激振荡
  // （多批弹同时在空中时，修正会追逐过期的落点误差而发散）。
  if (state.lastSalvoId && world.salvoes) {
    const prev = world.salvoes.get(state.lastSalvoId);
    if (prev && !prev.observed) {
      const tof = prev.tofS || 25;
      if (now - prev.tFire < tof + 30) return;
    }
  }
  // 齐射同步：真实炮塔按"全炮塔齐射"开火，等待全部就绪；若个别炮塔长期
  // 不能就位（战损/弹药耗尽/卡膛），最多等 18s 后以其余炮塔齐射。
  const allReady = ready.length === opBats.length;
  if (!allReady) {
    if (state.pendingSince === undefined || state.pendingSince === null) state.pendingSince = now;
    if (now - state.pendingSince < 18) return;
  }
  state.pendingSince = null;
  const salvoNo = ++state.salvos;
  const salvoId = ship.id + (role === 'secondary' ? '#T' : role === 'close' ? '#C' : '#S') + salvoNo;
  if (!world.salvoes) world.salvoes = new Map();
  const rec = {
    id: salvoId, t: now, tFire: now, shooterId: ship.id, shipId: ship.id, side: ship.side,
    role: role || 'main',
    targetShipId: targetShip ? targetShip.id : null, trackId: track ? track.id : null,
    aimRangeM: Math.round(ready[0].sol.rangeM), rangeM: Math.round(ready[0].sol.rangeM),
    aimBearingDeg: +ready[0].sol.bearingDeg.toFixed(2),
    tofS: +ready[0].sol.timeOfFlightS.toFixed(1),
    shots: 0, hits: 0, splashes: [], nearMisses: 0, penetrations: 0, ageS: 0,
  };
  world.salvoes.set(salvoId, rec);
  // ---- 齐射级系统误差 ----
  // 横摇/纵摇残余：稳定平台（陀螺垂直仪）补偿后的残差，与海况、横摇幅值、
  // 击发延迟相关；这是远距离命中率低的关键（横摇 1° ≈ 8km 处 15m 落点偏移）。
  const stabilized = !!(primary && primary.stabilized !== false);
  const rollAbs = Math.abs(ship.roll || 0);
  const seaState = world.env.seaState || 0;
  const sigmaRollElevDeg = stabilized
    ? (ROLL_ELEV_BASE_DEG + ROLL_ELEV_SEA_DEG * seaState) + ROLL_ELEV_AMP_DEG * rollAbs
    : (0.30 + 0.08 * seaState) + 0.60 * rollAbs;
  const sigmaRollBearDeg = stabilized
    ? (ROLL_BEAR_BASE_DEG + ROLL_BEAR_SEA_DEG * seaState) + ROLL_BEAR_AMP_DEG * rollAbs
    : (0.25 + 0.06 * seaState) + 0.40 * rollAbs;
  const degradedSalvo = !!(ready[0].sol && ready[0].sol.degraded);
  // 目标运动解算不确定性：方位变化率法在 30~90s 内收敛，收敛前的航向航速
  // 误差（尤其对高速机动目标）会在 TOF 外推时放大为落点偏差。以
  // σ = 0.18·V_target·TOF 建模（对静止目标为 0）。
  const solRef0 = ready[0].sol;
  const motionSigM = 0.45 * kn2mps(solRef0.targetSpeedKn || 0) * (solRef0.timeOfFlightS || 20);
  const rangeM0 = Math.max(500, solRef0.rangeM || 8000);
  const motionSigDeg = motionSigM / (0.075 * rangeM0);      // m → 仰角 deg（近似 dR/dθ≈0.075R）
  const motionSigBearDeg = rad2deg(motionSigM * 0.6 / rangeM0);
  const salvoBearErrDeg = degradedSalvo
    ? world.rng.normal(0, 0.9)
    : world.rng.normal(0, Math.hypot(sigmaRollBearDeg + 0.15 * MIL_DEG, motionSigBearDeg));
  const salvoElevErrDeg = degradedSalvo
    ? world.rng.normal(0, 0.7)
    : world.rng.normal(0, Math.hypot(sigmaRollElevDeg + 0.12 * MIL_DEG, motionSigDeg));
  let firedTotal = 0;
  const gunsPerTurret = [];
  for (const { b, sol } of ready) {
    const ammo = pickAmmo(b, wantAmmoOf(b));
    if (!ammo) continue;
    const res = fireSalvo(ship, b, sol, world, {
      ammo, salvoId, pattern: cmd.pattern || 'SALVO',
      bearingOffsetDeg: salvoBearErrDeg, elevOffsetDeg: salvoElevErrDeg,
      emitSalvoEvent: false, role,
      targetShipId: targetShip ? targetShip.id : null, trackId: track ? track.id : null,
    });
    firedTotal += res.fired;
    gunsPerTurret.push(res.fired);
  }
  if (!firedTotal) { world.salvoes.delete(salvoId); state.salvos--; return; }
  state.lastSalvoT = now;
  state.lastSalvoId = salvoId;
  // 全炮塔齐射汇总事件（契约 gun.salvo.away 以"齐射"为单位）
  const solRef = ready[0].sol;
  world.events.emit('gun.salvo.away', {
    t: now, ship: ship.id, name: ship.name, side: ship.side,
    battery: role === 'secondary' ? 'SECONDARY' : role === 'close' ? 'ALL_GUNS' : 'MAIN',
    batteryId: role === 'secondary' ? 'secondaryAll' : role === 'close' ? 'closeAll' : 'all',
    ammo: ammoForBattery ? 'MIXED' : pickAmmo(ready[0].b, ammoReq),
    gunsFired: firedTotal, turrets: ready.length, turretsOperational: opBats.length,
    gunsPerTurret,
    rangeM: Math.round(solRef.rangeM),
    bearingDeg: +solRef.bearingDeg.toFixed(2),
    elevDeg: +solRef.elevDeg.toFixed(2),
    tofS: +solRef.timeOfFlightS.toFixed(1),
    spreadMil: +solRef.spreadMil.toFixed(2),
    targetTrackId: solRef.trackId || null,
    targetShipId: targetShip ? targetShip.id : null,
    salvoId, degraded: !!solRef.degraded, salvoNo: state.salvos, role,
  });
  if (cmd.salvoes !== undefined && isFinite(cmd.salvoes)) {
    cmd.salvoes -= 1;
    if (cmd.salvoes <= 0) {
      cmd.salvoes = 0;
      cmd.firing = false;
      world.events.emit('fc.update', {
        t: now, ship: ship.id, side: ship.side, kind: 'SALVOES_EXHAUSTED',
        salvoes: state.salvos,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
export function updateFireControl(ship, world, dt) {
  if (!ship || !ship.isAfloat) return;
  ensureFriendlyFireHook(world);
  const fc = ensureFC(ship, world);
  const now = world.t;
  const cmd = ship.commanded || {};
  const trackId = cmd.targetTrackId || null;
  let track = trackId ? world.tracks.byId(trackId) : null;
  if (track && (track.side && track.side !== ship.side)) track = null;
  // —— 目标航迹已消亡（失跟超时被删 / 被合并掉）→ 必须清掉火力状态 ——
  // 否则形成死锁：gunnery 拿不到航迹而不开火，但 commanded.firing 仍为 true；
  // AI 侧看到 firing 为真就不再重发 FIRE，于是一直指着一个不存在的航迹 id，
  // 后半场"全队静默"（实测 sandbox 种子 604：轴心 t=166s 后再无一发）。
  // 清掉 targetTrackId 后，AI 下一轮决策会重新指派新航迹并重发 FIRE。
  if (!track) {
    if (cmd.firing || cmd.targetTrackId) {
      ship.commanded.firing = false;
      ship.commanded.targetTrackId = null;
      if (!ship._targetLostNotified) {
        ship._targetLostNotified = true;
        world.events.emit('fc.update', {
          t: now, ship: ship.id, side: ship.side, kind: 'TARGET_LOST',
          trackId, text: '目标航迹已消亡，停火并等待重新指派',
        });
      }
    }
  } else if (ship._targetLostNotified) {
    ship._targetLostNotified = false;
  }
  // —— 敌我识别闸门 ——
  // 识别不清楚（hostile=true、foeConfidence 低）时照常开火：那正是 1942 年夜间误伤的来源；
  // 但一旦目视看清舰型/旗号、确认是友舰（hostile=false），必须停火。
  // 玩家仍可用 commanded.overrideFriendly=true 强制（例如蓄意处置）。
  if (track && track.hostile === false && !(cmd.overrideFriendly === true)) {
    if (ship.commanded && ship.commanded.firing) {
      ship.commanded.firing = false;
      if (!ship._friendlyHoldNotified) {
        ship._friendlyHoldNotified = true;
        world.events.emit('fc.update', {
          t: now, ship: ship.id, side: ship.side, kind: 'TARGET_FRIENDLY',
          trackId: track.id, text: '目标已识别为友舰，停止射击',
          foeConfidence: track.foeConfidence !== undefined ? +track.foeConfidence.toFixed(2) : null,
          idSource: track.idSource || 'NONE',
        });
      }
    }
    track = null;
  } else if (track) {
    ship._friendlyHoldNotified = false;
  }
  // —— 日间近距编队识别：航迹贴着一艘已知友舰（≤220m）时，目视不可能认错 ——
  // 夜间/烟幕保留 A2 的"误伤是战争的一部分"；但白天 400-600m 上把自己的僚舰当目标打
  // （实测沙盒 604：阳炎 400-600m 对旗舰大和打出 7 发 127mm）不是识别不确定，是 bug。
  if (track && !(cmd.overrideFriendly === true)) {
    const light = (world.env && world.env.lightLevel !== undefined) ? world.env.lightLevel : 1;
    if (light > 0.45) {
      let nearFriend = null, bd = 1e9;
      for (const f of world.ships) {
        if (!f.isAfloat || f.side !== ship.side || f.id === ship.id) continue;
        const dd = dist2d(f.pos, track.pos);
        if (dd < bd) { bd = dd; nearFriend = f; }
      }
      if (nearFriend && bd <= 220) {
        if (ship.commanded && ship.commanded.firing) {
          ship.commanded.firing = false;
          if (!ship._formationFriendlyNotified) {
            ship._formationFriendlyNotified = true;
            world.events.emit('fc.update', {
              t: now, ship: ship.id, side: ship.side, kind: 'TARGET_FRIENDLY',
              trackId: track.id, text: '日间近距：航迹即僚舰 ' + nearFriend.name + '（' + Math.round(bd) + 'm），停止射击',
              foeConfidence: track.foeConfidence !== undefined ? +track.foeConfidence.toFixed(2) : null,
              idSource: track.idSource || 'NONE',
            });
          }
        }
        track = null;
      } else if (ship._formationFriendlyNotified) {
        ship._formationFriendlyNotified = false;
      }
    }
  }
  const trackFresh = !!(track && (track.ageS === undefined || track.ageS < 60));
  let targetShip = trackFresh ? resolveTargetShip(world, ship, track) : null;
  if (targetShip && !targetShip.isAfloat) { ship.commanded.firing = false; targetShip = null; }
  // 主指挥仪
  const dirs = ship.directors || [];
  const usable = dirs.filter((d) => !d.destroyed && (d.health === undefined || d.health > 0.2));
  let primary = usable.find((d) => d.hasFCComputer) || usable[0] || null;
  if (primary && primary.channels > 1) {
    // 多通道指挥仪可同时引导主/副炮，仍以 primary 为主
  }
  // 无指挥仪 → 全面局部控制
  if (!usable.length) {
    if (!fc.localControl) {
      fc.localControl = true;
      world.events.emit('fc.update', {
        t: now, ship: ship.id, side: ship.side, kind: 'LOCAL_CONTROL',
        text: '指挥仪全毁，转入局部控制', degraded: true,
      });
    }
    updateLocalControl(ship, world, dt, trackFresh ? track : null);
    tryFire(ship, world, dt, null, targetShip, track);
    if (targetShip && trackFresh && dist2d(ship.pos, targetShip.pos) <= CLOSE_ALL_GUNS_M) fireAllGunsClose(ship, world, dt, null, targetShip, track);
    return;
  }
  fc.localControl = false;
  for (const d of dirs) {
    const st = ensureDirectorState(d);
    if (d.destroyed || (d.health !== undefined && d.health <= 0.2)) {
      d.trackingTrackId = null; st.solution = null; continue;
    }
    if (!trackFresh) {
      d.trackingTrackId = null; st.solution = null;
      continue;
    }
    if (st.trackId !== track.id) {
      // 同一艘实舰的航迹 id 翻新（失跟-重捕/合并改号）时不要重置解算——否则每次换号
      // 都要从 quality 0.3 重新收敛，而 degraded 解算的散布是正常值的 4 倍
      // （实测苏里高/第一次瓜岛：AI 每 12~30 s 换一次航迹号，命中率被摊到 0.5%~1%）。
      const sameRealTarget = !!(targetShip && st.lastTrueId && st.lastTrueId === targetShip.id);
      if (!sameRealTarget) resetDirector(d, track.id);
    }
    d.trackingTrackId = track.id;
    // 观测节拍（测距仪连续跟踪，但火控记录/更新受人员节拍限制）
    if (now >= st.nextObsT) {
      takeObservation(ship, d, world, targetShip, track);
      st.nextObsT = now + obsIntervalS(ship, d);
    }
    fitMotion(ship, d, world, now);
    // 解算刷新（真实火控 ~2~4s 一次，含计算与传递延迟）
    if (now - st.lastSolveT >= 2.5) {
      const sol = computeSolution(ship, d, track, world);
      if (sol) {
        sol.targetShipId = targetShip ? targetShip.id : null;
        st.lastTrueId = targetShip ? targetShip.id : st.lastTrueId;
        st.solution = sol;
        d.solution = sol;          // 契约/UI 读取点：directors[i].solution
        st.lastSolveT = now;
        if (now - st.lastEmitT >= 4) {
          st.lastEmitT = now;
          world.events.emit('fc.solution', {
            t: now, ship: ship.id, name: ship.name, side: ship.side,
            director: d.id, directorLabel: d.label, trackId: track.id,
            targetShipId: sol.targetShipId,
            rangeM: Math.round(sol.rangeM), bearingDeg: +sol.bearingDeg.toFixed(2),
            elevDeg: +sol.elevDeg.toFixed(2), deflectionMil: +sol.deflectionMil.toFixed(1),
            tofS: +sol.timeOfFlightS.toFixed(1), spreadMil: +sol.spreadMil.toFixed(2),
            targetCourseDeg: Math.round(sol.targetCourseDeg), targetSpeedKn: +sol.targetSpeedKn.toFixed(1),
            quality: +sol.quality.toFixed(2), source: sol.source,
            sigmaRangeM: Math.round(sol.sigmaRangeM),
            corrRangeM: Math.round(sol.corrections.rangeM),
            corrDeflMil: +sol.corrections.deflMil.toFixed(1),
            valid: sol.valid,
          });
        }
        // 更新炮塔目标：只有主指挥仪能引导主炮（其余指挥仪为备份/高射，
        // 不能让后遍历到的指挥仪覆盖炮塔目标，否则炮塔瞄准与开火解算脱节）
        if (d === primary) {
          for (const b of ship.batteries) {
            if (b.destroyed || (b.health !== undefined && b.health <= 0.05)) continue;
            if (b.role === 'main') {
              b.targetTrain = sol.bearingDeg + (b.bearingOffsetDeg || 0);
              const lim = elevLimits(b);
              b.targetElev = clamp(sol.elevDeg + (b.elevOffsetDeg || 0), lim.lo, lim.hi);
            }
          }
        }
      } else {
        st.solution = null;
      }
    }
  }
  // 副炮：优先按"副炮自己的目标"建立局部解算（独立于主炮目标），
  // 没有副炮目标时沿用旧逻辑（无多通道指挥仪才转局部控制）。
  fc.sec = fc.sec || { lastSalvoT: -1e9, lastSalvoId: null, pendingSince: null, salvos: 0 };
  const secTrack = (cmd.secTargetTrackId ? world.tracks.byId(cmd.secTargetTrackId) : null) || null;
  const secTrackFresh = !!(secTrack && (secTrack.ageS === undefined || secTrack.ageS < 60));
  for (const b of ship.secondaryBatteries || []) {
    if (b.destroyed || (b.health !== undefined && b.health <= 0.05)) continue;
    if (secTrackFresh) {
      const ls = buildLocalSolution(ship, b, world, secTrack, cmd.secAmmo || 'HE');
      if (ls) { b.targetTrain = ls.bearingDeg; b.targetElev = ls.elevDeg; }
    } else if (!primary || primary.channels <= 1) {
      const ls = buildLocalSolution(ship, b, world, trackFresh ? track : null);
      if (ls) { b.targetTrain = ls.bearingDeg; b.targetElev = ls.elevDeg; }
    }
  }
  // ── 近距离混战：目标 ≤ CLOSE_ALL_GUNS_M 时，副炮与高射炮压平对海，全炮开火 ──
  // 远距离仍按主/副炮通道分配，避免高射炮在 10 km 外浪费弹药。
  const closeAllGuns = !!(targetShip && trackFresh && dist2d(ship.pos, targetShip.pos) <= CLOSE_ALL_GUNS_M);
  if (closeAllGuns) {
    for (const b of ship.batteries) {
      if (b.destroyed || (b.health !== undefined && b.health <= 0.05)) continue;
      if (b.role === 'main') continue;
      const ls = buildLocalSolution(ship, b, world, track, 'HE');
      if (ls) { b._localSol = ls; b.targetTrain = ls.bearingDeg; b.targetElev = ls.elevDeg; }
    }
  }
  // 炮塔随动 + 装填
  for (const b of ship.batteries) {
    if (b.destroyed || (b.health !== undefined && b.health <= 0.05)) continue;
    moveServo(ship, b, world, dt);
    updateReload(ship, b, dt);
  }
  tryFire(ship, world, dt, primary, targetShip, track);
  // ── 副炮通道 ──
  // 独立目标/弹药/节流；解算由上面 buildLocalSolution 按副炮口径给出。
  if (cmd.secFiring && !closeAllGuns) {
    if (secTrackFresh) {
      const secTarget = resolveTargetShip(world, ship, secTrack);
      const secCmd = { firing: true, salvoes: cmd.secSalvoes, fireAmmo: cmd.secAmmo || 'HE', pattern: 'SALVO' };
      tryFire(ship, world, dt, primary, secTarget, secTrack, { role: 'secondary', cmd: secCmd, fcState: fc.sec });
    } else if (!secTrack) {
      cmd.secFiring = false; cmd.secTargetTrackId = null;
    }
  }
  // 近距离全炮通道（副炮 + 高射炮压平）；与副炮共用节流状态，不会重复齐射。
  if (closeAllGuns) fireAllGunsClose(ship, world, dt, primary, targetShip, track);
}

// 近距离混战：所有非主炮（副炮 + 高射炮）一起打水面目标
function fireAllGunsClose(ship, world, dt, primary, targetShip, track) {
  const fc = ship._fc;
  if (!fc) return;
  fc.sec = fc.sec || { lastSalvoT: -1e9, lastSalvoId: null, pendingSince: null, salvos: 0 };
  const cmd = ship.commanded || {};
  const closeCmd = { firing: true, pattern: 'SALVO', overrideFriendly: cmd.overrideFriendly === true };
  tryFire(ship, world, dt, primary, targetShip, track, {
    role: 'close', cmd: closeCmd, fcState: fc.sec,
    ammoForBattery: (b) => closeAmmoFor(ship, b, targetShip, track),
  });
}

// 近距离全炮通道的自动选弹：目标类型 + 本炮在交战距离的预计穿深。
//   · 驱逐舰 / 轻巡 / 航母等软目标 → HE（毁伤上层建筑、点火、杀伤暴露人员）
//   · 重巡 / 战列舰 / 战巡：该炮在交战距离的 AP 预计穿深 ≥ 其舷侧装甲 90% → AP；否则 HE
//     （5 吋打不穿重巡装甲带时，AP 只会多几个洞，HE 的爆破与纵火收益更高）
function closeAmmoFor(ship, battery, targetShip, track) {
  if (!targetShip) return 'HE';
  const t = targetShip.type;
  if (t === 'DD' || t === 'CL' || t === 'CV') return 'HE';
  if (!pickAmmo(battery, 'AP')) return 'HE';
  const armor = (targetShip.data && targetShip.data.armor) || {};
  const belt = Math.max(20, armor.belt_mm || 0);
  const rangeM = track ? Math.max(300, dist2d(ship.pos, track.pos)) : 6000;
  const shell = makeShell(ship, battery, 'AP');
  const mv = effectiveMv(battery, shell, (ship._fc && ship._fc.powderTempC) || 21);
  const tab = solutionForRange(shell, rangeM, mv);
  const vStrike = (tab && tab.vStrikeMps) || mv;
  const det = penetrationDetail(belt, 15, shell, vStrike);   // 近距交火落角小，取 15° 代表
  return det.effectivePenMM >= belt * 0.9 ? 'AP' : 'HE';
}

// 无指挥仪时的局部控制更新
function updateLocalControl(ship, world, dt, track) {
  for (const b of ship.batteries) {
    if (b.destroyed || (b.health !== undefined && b.health <= 0.05)) continue;
    const ls = buildLocalSolution(ship, b, world, track);
    if (ls) { b.targetTrain = ls.bearingDeg; b.targetElev = ls.elevDeg; }
    else { b.targetTrain = null; b.targetElev = null; }
    moveServo(ship, b, world, dt);
    updateReload(ship, b, dt);
  }
}
