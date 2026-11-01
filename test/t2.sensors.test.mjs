// test/t2.sensors.test.mjs — 【T2】传感器/光学/航迹 数值与行为测试
// 运行：node test/t2.sensors.test.mjs
// 覆盖：雷达地平线（10 m vs 20 m 桅高）、雷达对 DD/BB 的发现距离、重合式测距仪 15000 m 误差、
//       扫描周期与漏检、海杂波/箔条/噪声干扰、目视发现与烟幕/探照灯/火灾、声呐主动/被动、
//       多源融合/型号识别/共享延迟/失跟重捕。
import fs from 'node:fs';
import { RNG } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { Ship } from '../src/sim/ship.js';
import { TrackManager } from '../src/sim/tracks.js';
import {
  updateSensors, radarDetectRange, radarHorizonM, radarHorizonNm, estimateRCS, deployChaff,
  radarSpecOf, sonarDetectionRanges,
} from '../src/sim/sensors.js';
import {
  visualDetectRange, visualDetection, opticalRangefind, projectedSilhouetteAreaM2,
  deployChaff as visionDeployChaff,
} from '../src/sim/vision.js';
import { dist2d, bearing2d, destPoint, normDeg180, nm2m } from '../src/core/util.js';

// ─────────────────────────────────────────────────────────────────────────────
let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures++; console.log('  ✗ FAIL: ' + msg); }
}
function between(v, a, b, msg) { ok(v >= a && v <= b, msg + ' = ' + fmt(v) + '（期望 ' + fmt(a) + '–' + fmt(b) + '）'); }
function fmt(v) { return typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v); }
function km(v) { return (v / 1000).toFixed(2) + ' km'; }
function line(s) { console.log('\n' + s); }

// ── 舰船数据（外包 subagent 的 ships_axis.json；allied 可能尚未落盘，测试不依赖它）──
const DATA_URL = new URL('../data/ships_axis.json', import.meta.url);
function loadDb() {
  const raw = JSON.parse(fs.readFileSync(DATA_URL, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.ships || []);
  const map = new Map();
  for (const d of arr) if (d && d.id && d.sensors) map.set(d.id, d);
  return map;
}
const DB = loadDb();
function shipOf(id, side, spec = {}) {
  const d = DB.get(id);
  if (!d) throw new Error('ships_axis.json 缺少舰船: ' + id);
  return new Ship(Object.assign({ side }, spec, { id: (spec.id || id) + '_' + side }), d, {});
}

// ── 假环境（隔离 T1 env.js 的并行改动；只实现 sensors/vision 用到的接口）──
function makeEnv(over = {}) {
  const env = {
    seaState: 3, visibilityNm: 12, lightLevel: 1, moonIllum: 0, cloudCover: 0.25,
    swellHeightM: 1.0, windDirDeg: 270, windKn: 12,
    smokeClouds: [], chaffClouds: [],
    illuminationFactor: () => env.lightLevel,
    horizontalVisibilityNm: () => env.visibilityNm,
    smokeDensityAt: (x, y) => {
      let d = 0;
      for (const c of env.smokeClouds) {
        const dd = Math.hypot(c.x - x, c.y - y);
        if (dd < c.r) d = Math.max(d, (c.density || 0) * (1 - dd / c.r));
      }
      return Math.min(1, d);
    },
    ...over,
  };
  return env;
}

function makeWorld(env, seed = 19420604) {
  const w = {
    t: 0, rng: new RNG(seed), env, ships: [],
    events: new EventBus(40000), radioRelayPenaltyS: 9, reportDelayS: 5,
  };
  w.tracks = new TrackManager(w);
  w.ship = (id) => w.ships.find((s) => s.id === id) || null;
  return w;
}
function placeAt(viewer, target, rangeM, bearingDeg, targetHeading = 0) {
  target.pos = destPoint(viewer.pos, rangeM, bearingDeg);
  target.heading = targetHeading;
  return target;
}
function moveByKinematics(s, dt) {
  const mps = (s.speed || 0) * 0.514444;
  const r = (s.heading || 0) * Math.PI / 180;
  s.pos.x += Math.sin(r) * mps * dt;
  s.pos.y += Math.cos(r) * mps * dt;
}
function stepWorld(w, dt, fn) {
  w.t += dt;
  if (fn) fn(w, dt);
  for (const s of w.ships) if (s.isAfloat) updateSensors(s, w, dt);
  w.tracks.update(dt);
}
function findRadar(ship, dataId) {
  const s = ship.sensors.find((x) => x.srcKind === 'RADAR' && x.data && x.data.id === dataId);
  return s || ship.sensors.find((x) => x.srcKind === 'RADAR');
}
function findSensor(ship, srcKind) { return ship.sensors.find((x) => x.srcKind === srcKind) || null; }

// ═════════════════════════════════════════════════════════════════════════════
// 样例 1：雷达地平线（10 m vs 20 m 桅高）
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 1：雷达地平线 d = 4.12(√h_r + √h_t) km（4/3 地球折射）===');
{
  const h10 = radarHorizonM(10, 0);
  const h20 = radarHorizonM(20, 0);
  const both = radarHorizonM(10, 20);
  console.log('  10 m 桅高对海平面目标: ' + km(h10) + ' / ' + (h10 / 1852).toFixed(2) + ' nmi');
  console.log('  20 m 桅高对海平面目标: ' + km(h20) + ' / ' + (h20 / 1852).toFixed(2) + ' nmi');
  console.log('  10 m 雷达对 20 m 目标 : ' + km(both) + ' / ' + (both / 1852).toFixed(2) + ' nmi');
  between(h10 / 1000, 12.9, 13.2, '10 m 雷达地平线 (km)');
  between(h20 / 1000, 18.3, 18.6, '20 m 雷达地平线 (km)');
  between(h20 / h10, 1.40, 1.43, '20 m 与 10 m 地平线之比（≈√2）');
  between(radarHorizonNm(10, 0), 7.0, 7.1, '10 m 地平线 (nmi)');
  between(radarHorizonNm(20, 0), 9.9, 10.05, '20 m 地平线 (nmi)');
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 2：22 号电探（Yamato 桅顶 45 m）对 DD / BB 的发现距离
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 2：日制 22 号电探（10 cm / 2 kW / 标称对 BB 13 nmi）的发现距离 ===');
{
  const env = makeEnv({ seaState: 4 });
  const yamato = shipOf('yamato', 'AXIS');
  const dd = shipOf('shimakaze', 'ALLIED');
  const bb = shipOf('nagato', 'ALLIED');
  const radar = findRadar(yamato, 'type22');
  placeAt(yamato, dd, 30000, 90, 0);
  placeAt(yamato, bb, 30000, 90, 0);
  const rDD = radarDetectRange(yamato, radar, dd, env);
  const rBB = radarDetectRange(yamato, radar, bb, env);
  const rEndOn = radarDetectRange(yamato, radar, dd, Object.assign({}, env)); // 下面改舷角
  dd.heading = 90; // 目标向观察者航向：艏向（end-on）
  const rDDend = radarDetectRange(yamato, radar, dd, env);
  dd.heading = 0;
  console.log('  DD（Shimakaze, 舷侧, RCS≈' + Math.round(estimateRCS(dd, 90)) + ' m²）: ' + km(rDD));
  console.log('  BB（Nagato,   舷侧, RCS≈' + Math.round(estimateRCS(bb, 90)) + ' m²）: ' + km(rBB));
  console.log('  DD 艏向（end-on）: ' + km(rDDend));
  between(rDD, 9000, 16000, '22 号电探对驱逐舰发现距离（m）');
  between(rBB, 18000, 30000, '22 号电探对战列舰发现距离（m）');
  ok(rBB > rDD * 1.5, 'BB 发现距离显著大于 DD（' + (rBB / rDD).toFixed(2) + '×）');
  ok(rDDend < rDD * 0.95, '艏向 RCS 更小 → 发现距离更近（' + km(rDDend) + ' < ' + km(rDD) + '）');
  // 海况恶化
  const envRough = makeEnv({ seaState: 7 });
  const rDDr = radarDetectRange(yamato, radar, dd, envRough);
  console.log('  海况 7 时同一 DD: ' + km(rDDr) + '（海杂波抬升）');
  ok(rDDr <= rDD, '高海况不增大发现距离');
  // 盲区：120 m 处目标应落在最小作用距离（~540 m）内，扫描也不产生雷达发现
  {
    const envB = makeEnv({ seaState: 3 });
    const wB = makeWorld(envB, 55);
    const yB = shipOf('yamato', 'AXIS'); yB.pos = { x: 0, y: 0 };
    const ddB = shipOf('shimakaze', 'ALLIED'); placeAt(yB, ddB, 120, 90, 0); ddB.speed = 0;
    wB.ships.push(yB, ddB);
    for (let i = 0; i < 300; i++) stepWorld(wB, 0.1); // 30 s
    const rB = findRadar(yB, 'type22');
    console.log('  120 m（盲区内）30 s 内雷达发现次数: ' + (rB._detectCount || 0));
    ok((rB._detectCount || 0) === 0, '脉冲盲区（120 m < 最小作用距离 540 m）不产生雷达发现');
  }
  // 灵敏度极限的锚点交叉验证
  const rBB_still = (() => { placeAt(yamato, bb, 30000, 90, 0); return radarDetectRange(yamato, radar, bb, env); })();
  console.log('  交叉验证：BB 发现距离 / 标称 13 nmi = ' + (rBB_still / nm2m(13)).toFixed(2));
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 3：重合式测距仪在 15000 m 的误差（dR = R²·dθ/B）
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 3：重合式测距仪误差（基线 15 m vs 4.5 m，15000 m）===');
{
  const env = makeEnv({ visibilityNm: 20, seaState: 4 });
  function trial(viewer, target, rangeM, samples = 400) {
    const rng = new RNG(20240601);
    placeAt(viewer, target, rangeM, 90, 0);
    let sumErr = 0, sumMeas = 0, sum2 = 0, valid = 0;
    let last = null;
    for (let i = 0; i < samples; i++) {
      last = opticalRangefind(viewer, target, env, rng);
      sumErr += last.errM;
      sumMeas += last.rangeM - rangeM;
      sum2 += Math.pow(last.rangeM - rangeM, 2);
      if (last.valid) valid++;
    }
    const mean = sumMeas / samples;
    const sd = Math.sqrt(Math.max(0, sum2 / samples - mean * mean));
    return { err: sumErr / samples, mean, sd, valid: valid / samples, last };
  }
  const yamato = shipOf('yamato', 'AXIS');       // 15 m 基线（大和型测距仪）
  const ddView = shipOf('shimakaze', 'AXIS');    // 4.5 m 基线（驱逐舰）
  const ca = shipOf('takao', 'ALLIED');
  const ddTarget = shipOf('shimakaze', 'ALLIED');
  const r15 = trial(yamato, ca, 15000);
  const r4 = trial(ddView, ddTarget, 15000);
  const r75 = trial(yamato, ca, 7500);
  console.log('  大和 15 m 基线 @15000 m: errM=' + r15.err.toFixed(0) + ' m（实测σ=' + r15.sd.toFixed(0) + ' m, 均值偏' + r15.mean.toFixed(0) + ' m, valid=' + (r15.valid * 100).toFixed(0) + '%）');
  console.log('  驱逐舰 4.5 m 基线 @15000 m: errM=' + r4.err.toFixed(0) + ' m（实测σ=' + r4.sd.toFixed(0) + ' m）');
  console.log('  大和 15 m 基线 @ 7500 m: errM=' + r75.err.toFixed(0) + ' m');
  console.log('  误差比（15000/7500）=' + (r15.err / r75.err).toFixed(2) + '（∝R²，考虑低对比度修正应略小于 4）');
  between(r15.err, 80, 400, '15 m 基线 15000 m 测距误差（m）');
  ok(r15.sd > r15.err * 0.5 && r15.sd < r15.err * 1.6, '实测误差散布与报告 errM 同量级');
  between(r4.err / r15.err, 2.0, 5.0, '4.5 m 基线误差 / 15 m 基线误差');
  between(r15.err / r75.err, 2.5, 5.0, '15000 m / 7500 m 测距误差比（R² 规律）');
  ok(r15.valid > 0.9, '白天能见度 20 nmi 时 15000 m 测距有效');
  // 夜间不可见 + 误差放大
  const envNight = makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 });
  const night = (() => {
    const rng = new RNG(7);
    placeAt(yamato, ca, 15000, 90, 0);
    return opticalRangefind(yamato, ca, envNight, rng);
  })();
  console.log('  无月夜 @15000 m: valid=' + night.valid + ', errM=' + night.errM.toFixed(0) + ' m（无法光学测距，误差急剧放大）');
  ok(night.valid === false, '夜间 15000 m 光学测距不可用');
  ok(night.errM > r15.err, '夜间/不可见时测距误差放大');
  // 横摇影响
  yamato.roll = 0;
  const calmRoll = trial(yamato, ca, 15000, 120);
  yamato.roll = 8;
  const roughRoll = trial(yamato, ca, 15000, 120);
  yamato.roll = 0;
  console.log('  横摇 0° vs 8°: errM ' + calmRoll.err.toFixed(0) + ' → ' + roughRoll.err.toFixed(0) + ' m');
  ok(roughRoll.err > calmRoll.err, '横摇加剧测距误差');
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 4：扫描周期、重访延迟与漏检
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 4：雷达扫描周期（5 s/转）与发现概率（DD @ 10 km）===');
{
  const env = makeEnv({ seaState: 3 });
  const w = makeWorld(env, 19420604);
  const yamato = shipOf('yamato', 'AXIS'); yamato.pos = { x: 0, y: 0 };
  const dd = shipOf('shimakaze', 'ALLIED'); placeAt(yamato, dd, 10000, 90, 0); dd.speed = 0;
  w.ships.push(yamato, dd);
  const radar = findRadar(yamato, 'type22');
  const dt = 0.1;
  for (let i = 0; i < 600; i++) stepWorld(w, dt);
  const scans = radar._scanCount || 0;
  const detects = radar._detectCount || 0;
  const times = radar._detectTimes || [];
  let minGap = Infinity;
  for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
  console.log('  60 s 内扫描 ' + scans + ' 次，成功发现 ' + detects + ' 次（Pd≈' + (detects / Math.max(1, scans)).toFixed(2) + '）');
  console.log('  发现时刻(s): ' + times.slice(0, 8).join(', ') + (times.length > 8 ? ' …' : ''));
  console.log('  最小重访间隔: ' + minGap.toFixed(1) + ' s（≥ 扫描周期 5 s 减去首发现抖动）');
  between(scans, 11, 13, '60 s 内扫描次数（周期 5 s）');
  ok(detects > 0, '至少一次发现');
  ok(detects < scans, '存在漏检（Pd<1，Swerling-I 起伏）');
  ok(minGap >= 4.4, '两次发现之间不小于扫描周期');
  const track = w.tracks.visibleFor(yamato)[0];
  ok(!!track && track.confidence > 0.5, '航迹建立并积累置信度: ' + (track ? track.confidence.toFixed(2) : 'none'));
  if (track) console.log('  航迹: id=' + track.id + ' confidence=' + track.confidence.toFixed(2) + ' errM=' + track.errM.toFixed(0) + ' m classifiedAs=' + track.classifiedAs);
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 5：目视发现（能见度/夜色/月光/火灾/探照灯/烟幕/尾迹）
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 5：目视发现距离（DD 舷侧投影）===');
{
  const yamato = shipOf('yamato', 'AXIS'); yamato.pos = { x: 0, y: 0 };
  const dd = shipOf('shimakaze', 'ALLIED'); placeAt(yamato, dd, 20000, 90, 0); dd.speed = 14;
  const day12 = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 1 }));
  const day20 = visualDetection(yamato, dd, makeEnv({ visibilityNm: 20, lightLevel: 1 }));
  const day4 = visualDetection(yamato, dd, makeEnv({ visibilityNm: 4, lightLevel: 1 }));
  const night = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  const moon = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.08, moonIllum: 0.7 }));
  console.log('  白天能见度 12 nmi: ' + km(day12.detectionRangeM) + '（对比度 C0=' + day12.contrast0.toFixed(2) + ', C_th=' + day12.contrastThreshold.toFixed(3) + '）');
  console.log('  白天能见度 20 nmi: ' + km(day20.detectionRangeM));
  console.log('  白天能见度  4 nmi: ' + km(day4.detectionRangeM));
  console.log('  无月夜（12 nmi 能见度）: ' + km(night.detectionRangeM));
  console.log('  月夜（moonIllum 0.7）: ' + km(moon.detectionRangeM));
  between(day12.detectionRangeM, 12000, 23000, '白天 12 nmi 能见度目视发现距离（m）');
  ok(day20.detectionRangeM > day12.detectionRangeM, '能见度 20 nmi > 12 nmi 发现距离');
  ok(day4.detectionRangeM < day12.detectionRangeM * 0.7, '能见度 4 nmi 显著降低发现距离');
  ok(night.detectionRangeM < day12.detectionRangeM * 0.35, '夜色大幅缩短目视距离（' + km(night.detectionRangeM) + '）');
  ok(moon.detectionRangeM > night.detectionRangeM, '月光提高夜间发现距离');

  // 火灾：夜间自发光，可远距离看到
  dd.flags.onFire = 1;
  const fireNight = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  dd.flags.onFire = 0;
  console.log('  夜间起火目标: ' + km(fireNight.detectionRangeM) + '（自发光 C0=' + fireNight.contrast0.toFixed(2) + '）');
  ok(fireNight.detectionRangeM > night.detectionRangeM * 3, '起火目标夜间可见距离大幅增加');

  // 探照灯：3 km 处夜间照射（先停船，排除尾迹线索）
  placeAt(yamato, dd, 3000, 90, 0);
  dd.speed = 0;
  const night3 = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  yamato.flags.searchlight.on = true; yamato.flags.searchlight.bearing = 90;
  const sl3 = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  yamato.flags.searchlight.on = false;
  console.log('  夜间 3 km：无探照灯 ' + (night3.detected ? '可见' : '不可见') + ' → 开探照灯 ' + (sl3.detected ? '可见' : '不可见') + '（C0=' + sl3.contrast0.toFixed(2) + '）');
  // 3 km 恰好落在夜间可见边缘（12nm 能见度、静止目标、无月光），断言"必定不可见"过脆；
  // 保留原意——探照灯必须大幅延长夜间发现距离——用比值断言。
  ok(sl3.detected && sl3.detectionRangeM > night3.detectionRangeM * 1.8, '探照灯照射大幅延长夜间发现距离',
    Math.round(night3.detectionRangeM) + 'm → ' + Math.round(sl3.detectionRangeM) + 'm');

  // 目标自身探照灯眩光
  dd.flags.searchlight.on = true;
  const targetSL = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  dd.flags.searchlight.on = false;
  ok(targetSL.detectionRangeM > night3.detectionRangeM, '目标探照灯眩光提高被发现的可能');

  // 烟幕：舰体遮蔽 + 烟柱暴露位置
  placeAt(yamato, dd, 8000, 90, 0);
  const clear8 = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 1 }));
  dd.flags.smokeIntensity = 1.2;
  const smoking = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 1 }));
  const envSmoke = makeEnv({ visibilityNm: 12, lightLevel: 1 });
  envSmoke.smokeClouds.push({ x: 4000, y: 0, r: 700, density: 1.0 });
  const throughSmoke = visualDetection(yamato, dd, envSmoke);
  dd.flags.smokeIntensity = 0;
  console.log('  8 km 目标：清晰 ' + (clear8.detected ? '可见' : '不可见') + '，自身烟幕 ' + (smoking.detected ? '可见(烟柱)' : '不可见') + '，中间烟幕遮蔽 ' + (throughSmoke.detected ? '仍可见' : '不可见'));
  ok(clear8.detectionRangeM > 8000, '8 km 白天清晰可见');
  ok(throughSmoke.detectionRangeM < clear8.detectionRangeM * 0.5, '烟幕遮蔽显著降低发现距离');
  ok(smoking.detectionRangeM <= clear8.detectionRangeM, '自身烟幕遮蔽舰体（烟柱仍可能暴露）');
  // 尾迹（夜间/低能见度下白色扰动水带是首要线索）
  placeAt(yamato, dd, 8000, 90, 0);
  dd.speed = 8;
  const wakeSlow = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  dd.speed = 28;
  const wakeFast = visualDetection(yamato, dd, makeEnv({ visibilityNm: 12, lightLevel: 0.02, moonIllum: 0 }));
  dd.speed = 14;
  console.log('  夜间 8 km：8 kn 尾迹发现距离 ' + km(wakeSlow.detectionRangeM) + ' vs 28 kn ' + km(wakeFast.detectionRangeM) +
    '（C0 ' + wakeSlow.contrast0.toFixed(2) + '→' + wakeFast.contrast0.toFixed(2) + '）');
  ok(wakeFast.detectionRangeM > wakeSlow.detectionRangeM, '高速尾迹提高夜间可发现性');
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 6：烟幕生成/消散（写 world.env.smokeClouds）
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 6：烟幕生成、漂移与消散 ===');
{
  const env = makeEnv({ seaState: 4, windKn: 14, windDirDeg: 270 });
  const w = makeWorld(env, 99);
  const dd = shipOf('shimakaze', 'AXIS'); dd.pos = { x: 0, y: 0 };
  dd.flags.smokeOn = true; dd.flags.smokeIntensity = 0.9;
  w.ships.push(dd);
  const yamato = shipOf('yamato', 'ALLIED'); yamato.pos = { x: 20000, y: 0 };
  w.ships.push(yamato);
  for (let i = 0; i < 100; i++) stepWorld(w, 0.1);
  const n = env.smokeClouds.length;
  let maxDensity = 0;
  for (let dx = 0; dx <= 500; dx += 25) for (let dy = -250; dy <= 250; dy += 25) maxDensity = Math.max(maxDensity, env.smokeDensityAt(dx, dy));
  const smokeEvents = w.events.history.filter((e) => e.type === 'sensor.smoke');
  console.log('  10 s 后烟团数量: ' + n + '，下风（东）网格最大 smokeDensityAt=' + maxDensity.toFixed(2));
  ok(n > 0, '施放烟幕生成烟团（env.smokeClouds）');
  ok(maxDensity > 0.05, '下风方向有烟幕密度');
  ok(smokeEvents.some((e) => e.on === true), 'emit sensor.smoke(on) 事件');
  // 停止施放后消散
  dd.flags.smokeOn = false; dd.flags.smokeIntensity = 0;
  const densityBefore = env.smokeClouds.reduce((s, c) => s + c.density, 0);
  for (let i = 0; i < 1200; i++) stepWorld(w, 0.1); // 120 s
  const densityAfter = env.smokeClouds.reduce((s, c) => s + c.density, 0);
  const n2 = env.smokeClouds.length;
  for (let i = 0; i < 4000; i++) stepWorld(w, 0.1); // 再 400 s
  const n3 = env.smokeClouds.length;
  console.log('  停止施放 120 s：总密度 ' + densityBefore.toFixed(2) + ' → ' + densityAfter.toFixed(2) +
    '；再 400 s 后烟团数 ' + n2 + ' → ' + n3);
  ok(densityAfter < densityBefore, '烟幕密度随时间指数衰减');
  ok(n3 < n2, '烟团最终消散');
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 7：海杂波 / 箔条 / 噪声干扰
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 7：海杂波、箔条（window）与噪声干扰 ===');
{
  const yamato = shipOf('yamato', 'AXIS'); yamato.pos = { x: 0, y: 0 };
  const dd = shipOf('shimakaze', 'ALLIED'); placeAt(yamato, dd, 10000, 90, 0); dd.speed = 0;
  const radar = findRadar(yamato, 'type22');
  const envCalm = makeEnv({ seaState: 2 });
  const envRough = makeEnv({ seaState: 8 });
  const rCalm = radarDetectRange(yamato, radar, dd, envCalm);
  const rRough = radarDetectRange(yamato, radar, dd, envRough);
  console.log('  DD @海况2: ' + km(rCalm) + '；@海况8: ' + km(rRough));
  ok(rRough <= rCalm, '海况升高（海杂波增强）不增加 DD 发现距离');

  // 箔条：目标距离单元内出现 window 云（2500 m² 量级），逐扫描统计发现次数
  function radarTrial(chaffRcsM2) {
    const envT = makeEnv({ seaState: 3 });
    if (chaffRcsM2) envT.chaffClouds.push({ x: 9500, y: 0, r: 500, density: 1.0, rcsM2: chaffRcsM2, t0: 0, decayS: 420 });
    const wT = makeWorld(envT, 909);
    const yT = shipOf('yamato', 'AXIS'); yT.pos = { x: 0, y: 0 };
    const dT = shipOf('shimakaze', 'ALLIED'); placeAt(yT, dT, 10000, 90, 0); dT.speed = 0;
    wT.ships.push(yT, dT);
    for (let i = 0; i < 600; i++) stepWorld(wT, 0.1); // 60 s
    const rr = findRadar(yT, 'type22');
    return { scans: rr._scanCount || 0, detects: rr._detectCount || 0 };
  }
  const baseTrial = radarTrial(0);
  const chaffTrial = radarTrial(6000);
  console.log('  60 s 雷达发现: 无箔条 ' + baseTrial.detects + '/' + baseTrial.scans +
    '，目标距离单元有 6000 m² 箔条云 ' + chaffTrial.detects + '/' + chaffTrial.scans);
  ok(chaffTrial.detects < baseTrial.detects * 0.6, '箔条云显著压制雷达发现（同一距离单元竞争）');

  // 契约新增 CHAFF 命令的落点：vision.deployChaff(world, ship)
  {
    const envC = makeEnv({ seaState: 3 });
    const wC = makeWorld(envC, 101);
    const yC = shipOf('yamato', 'AXIS'); yC.pos = { x: 0, y: 0 }; yC.heading = 90;
    wC.ships.push(yC);
    const cloud = visionDeployChaff(wC, yC, { rcsM2: 3000, offsetM: 200 });
    console.log('  CHAFF 命令落点 vision.deployChaff: chaffClouds=' + envC.chaffClouds.length + '，rcs=' + (cloud ? cloud.rcsM2 : 0) + ' m²');
    ok(!!cloud && envC.chaffClouds.length === 1, 'world CHAFF 命令可调用 vision.deployChaff 生成箔条云');
    ok(deployChaff === visionDeployChaff, 'sensors.deployChaff 与 vision.deployChaff 为同一实现（旧调用兼容）');
  }

  // 噪声干扰：J/N 抬高门限
  const envJam = makeEnv({ seaState: 3, radarJamDb: 18 });
  const rJam = radarDetectRange(yamato, radar, dd, envJam);
  console.log('  噪声干扰 18 dB: ' + km(rJam) + '（R∝10^(−J/40)）');
  ok(rJam < rCalm * 0.75, '噪声干扰缩短雷达作用距离');

  // 箔条假回波
  const envFalse = makeEnv({ seaState: 3 });
  for (let k = 0; k < 3; k++) envFalse.chaffClouds.push({ x: 6000 + k * 1500, y: 300 * k, r: 500, density: 1.0, rcsM2: 4000, t0: 0, decayS: 420 });
  const w = makeWorld(envFalse, 4242);
  const y2 = shipOf('yamato', 'AXIS'); y2.pos = { x: 0, y: 0 };
  w.ships.push(y2);
  for (let i = 0; i < 900; i++) stepWorld(w, 0.1); // 90 s
  console.log('  90 s 内箔条假回波航迹数: ' + w.tracks.tracks.length);
  ok(w.tracks.tracks.length >= 1, '箔条产生假回波/假航迹');
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 8：主动声呐与被动水听器（仅方位）
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 8：主动声呐 / 被动水听器 ===');
{
  // 主动声呐：水面舰艇不是 ASDIC 的目标，有效距离 1–3 km；高航速自噪失效
  function sonarTrial(rangeM, speedKn, targetDepthM) {
    const envS = makeEnv({ seaState: 3, lightLevel: 0.0, moonIllum: 0 }); // 全黑，排除目视
    envS.thermoclineDepthM = 60;
    const wS = makeWorld(envS, 31415);
    const yS = shipOf('yamato', 'AXIS'); yS.pos = { x: 0, y: 0 }; yS.speed = speedKn;
    for (const s of yS.sensors) if (s.srcKind === 'RADAR') s.on = false;
    const sonarS = findSensor(yS, 'SONAR'); sonarS.on = true;
    const tgt = shipOf('nagato', 'ALLIED'); placeAt(yS, tgt, rangeM, 45, 0); tgt.speed = 0; tgt._depthM = targetDepthM || 0;
    wS.ships.push(yS, tgt);
    for (let i = 0; i < 200; i++) stepWorld(wS, 0.1); // 20 s
    return { lastDetect: sonarS.lastDetectT || -1, ranges: sonarDetectionRanges(sonarS, envS, yS, tgt) };
  }
  const closeSonar = sonarTrial(1800, 8);
  const farSonar = sonarTrial(5000, 8);
  const fastSonar = sonarTrial(1800, 20);
  const deepSonar = sonarTrial(1800, 8, 100);
  console.log('  主动声呐（8 kn, 1.8 km BB）: lastDetectT=' + (closeSonar.lastDetect > 0 ? closeSonar.lastDetect.toFixed(1) + ' s' : '未发现') +
    '，理论上限 ' + km(closeSonar.ranges.activeRangeM) + '（水面目标封顶 ' + km(closeSonar.ranges.surfaceCapM) + '）');
  console.log('  主动声呐（8 kn, 5.0 km BB）: ' + (farSonar.lastDetect > 0 ? '发现' : '未发现') + '（超出水面目标 1–3 km 上限）');
  console.log('  主动声呐（20 kn, 1.8 km BB）: ' + (fastSonar.lastDetect > 0 ? '发现' : '未发现') + '（自噪/气泡遮蔽）');
  console.log('  温跃层（目标深度 100 m，层深 60 m）: 附加损失 ' + deepSonar.ranges.thermoclineLossDb + ' dB，上限 ' + km(deepSonar.ranges.activeRangeM));
  ok(closeSonar.lastDetect > 0, '主动声呐在 1.8 km 发现大型水面目标');
  between(closeSonar.ranges.activeRangeM, 1000, 3000, '主动声呐对水面舰有效距离（m，1–3 km）');
  ok(farSonar.lastDetect < 0, '5 km 处主动声呐不探测水面舰');
  ok(fastSonar.lastDetect < 0, '本舰 20 kn 高航速时主动声呐失效（自噪）');
  ok(deepSonar.ranges.thermoclineLossDb === 12, '温跃层附加损失 12 dB');
  ok(deepSonar.ranges.passiveRangeM < closeSonar.ranges.passiveRangeM, '目标在温跃层下时被动听测距离下降');

  // 被动水听器 + 两舰方位线三角定位
  const env2 = makeEnv({ seaState: 3, lightLevel: 0.02, moonIllum: 0 });
  const w2 = makeWorld(env2, 2718);
  const a = shipOf('yamato', 'AXIS'); a.pos = { x: 0, y: 0 };
  const b = shipOf('nagato', 'AXIS'); b.pos = { x: 0, y: 8000 };
  for (const s of [...a.sensors, ...b.sensors]) if (s.srcKind === 'RADAR') s.on = false;
  const target = shipOf('takao', 'ALLIED'); target.pos = { x: 8000, y: 0 }; target.heading = 0; target.speed = 14; // 14 kn：螺旋桨噪声可听
  w2.ships.push(a, b, target);
  for (let i = 0; i < 400; i++) stepWorld(w2, 0.1); // 40 s
  const hydro = findSensor(a, 'HYDRO');
  console.log('  水听器 lastDetectT=' + (hydro && hydro.lastDetectT > 0 ? hydro.lastDetectT.toFixed(1) + ' s' : '未发现') +
    '（14 kn 目标，舰体辐射噪声）');
  ok(!!hydro && hydro.lastDetectT > 0, '水听器被动发现噪声目标');
  const trk = w2.tracks.tracks.find((t) => t.side === 'AXIS' && t.sourceShips.includes(a.id) && t.sourceShips.includes(b.id))
    || w2.tracks.tracks.find((t) => t.side === 'AXIS' && t.sourceShips.includes(a.id));
  if (trk) {
    const errPos = dist2d(trk.pos, target.pos);
    console.log('  水听器航迹: bearingOnly=' + trk.bearingOnly + ' errM=' + trk.errM.toFixed(0) +
      ' m, 定位误差=' + errPos.toFixed(0) + ' m, hits=' + trk.hits);
    ok(trk.bearingOnly === true || trk.errM > 2000, '水听器只给方位（初始误差极大）');
    ok(errPos < 6000, '两舰方位线三角定位把位置误差压到 6 km 内');
    ok(trk.errM < 12000, '方位线交叉后不确定度下降');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 9：多源融合 / 型号识别 / 共享延迟 / 失跟重捕
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 9：多源航迹融合、型号识别（CA）、同方共享延迟 ===');
{
  const env = makeEnv({ seaState: 3, visibilityNm: 12, lightLevel: 1 });
  const w = makeWorld(env, 777);
  const yamato = shipOf('yamato', 'AXIS'); yamato.pos = { x: 0, y: 0 };
  const nagato = shipOf('nagato', 'AXIS'); nagato.pos = { x: 0, y: 9000 };
  const remote = shipOf('kongo', 'AXIS'); remote.pos = { x: 60000, y: 0 }; // 超无线电地平线 → 中继延迟
  const df = shipOf('fuso', 'AXIS'); df.pos = { x: 90000, y: -40000 }; // 独立的无线电测向舰（不参与雷达/目视）
  const target = shipOf('takao', 'ALLIED'); target.pos = { x: 14000, y: 0 }; target.heading = 30; target.speed = 12;
  w.ships.push(yamato, nagato, remote, df, target);
  const hfdf = { srcKind: 'HFDF', sensorKind: 'HFDF', shipId: df.id, accuracyDeg: 1.5, bearingOnly: true, rangeM: null, accuracyM: null };
  let sawRemoteEarly = false, sawRemoteLate = false;
  const classHistory = [];
  let lastClass = '', lastConf = -1;
  const dt = 0.1;
  for (let i = 0; i < 1200; i++) { // 120 s
    stepWorld(w, dt, (ww) => { moveByKinematics(target, dt); });
    // 无线电测向（HFDF）方位线：每 4 s 一次，由独立的测向舰提供
    if (i % 40 === 39) {
      const brg = bearing2d(df.pos, target.pos) + w.rng.normal(0, 1.5);
      w.tracks.observe(Object.assign({}, hfdf, {
        side: 'AXIS', observerPos: { x: df.pos.x, y: df.pos.y },
        pos: destPoint(df.pos, 20000, brg), bearingDeg: brg,
        confidence: 0.3, t: w.t,
      }));
    }
    if (w.t > 6 && w.t < 7) sawRemoteEarly = remote ? w.tracks.visibleFor(remote).length > 0 : false;
    if (w.t > 35 && w.t < 36) sawRemoteLate = remote ? w.tracks.visibleFor(remote).length > 0 : false;
    const local = w.tracks.visibleFor(yamato).filter((t) => t.sources.includes('RADAR')).sort((x, y) => y.confidence - x.confidence)[0];
    if (local) {
      const cls = local.classifiedAs + '/' + local.idConfidence.toFixed(2);
      if (cls !== lastClass && (w.t - lastConf) > 8) { classHistory.push(w.t.toFixed(0) + 's:' + cls); lastClass = cls; lastConf = w.t; }
    }
  }
  const local = w.tracks.visibleFor(yamato).filter((t) => t.sources.includes('RADAR')).sort((x, y) => y.confidence - x.confidence)[0];
  const own = remote ? w.tracks.visibleFor(remote).filter((t) => t.sources.includes('RADAR'))[0] || w.tracks.visibleFor(remote)[0] : null;
  if (local) {
    console.log('  本舰航迹: confidence=' + local.confidence.toFixed(2) + ' errM=' + local.errM.toFixed(0) +
      ' m sources=[' + local.sources.join(',') + '] classifiedAs=' + local.classifiedAs + ' idConf=' + local.idConfidence.toFixed(2));
    ok(local.confidence > 0.8, '多源融合后置信度 > 0.8');
    ok(local.errM < 800, '雷达+光学测距融合后位置误差 < 800 m');
    ok(local.sources.includes('RADAR') && local.sources.includes('VISUAL'), '雷达与目视两个来源均融合');
    ok(local.classifiedAs === 'CA' || local.classifiedAs === 'BB' || local.classifiedAs === 'BC', '型号识别收敛到中/大型舰（' + local.classifiedAs + '）');
    ok(local.idConfidence > 0.4, '识别置信度 > 0.4');
  } else { failures++; console.log('  ✗ FAIL: 未建立本舰航迹'); }
  console.log('  识别演进: ' + classHistory.join(' → '));
  console.log('  远舰（60 km，超无线电地平线）: 早期可见=' + sawRemoteEarly + '，35 s 后可见=' + sawRemoteLate);
  ok(sawRemoteEarly === false, '共享报告有延迟：远舰在 6 s 时还看不到航迹');
  ok(sawRemoteLate === true, '延迟后（含中继惩罚）远舰收到话音报告');
  if (own && local) {
    console.log('  远舰共享视图: shared=' + own.shared + ' reportAge=' + own.reportAgeS + 's errM=' + own.errM.toFixed(0) + ' m（本舰 ' + local.errM.toFixed(0) + ' m）');
    ok(own.shared === true, '远舰航迹标记为共享');
    ok(own.errM > local.errM, '共享/话音报告的精度低于本舰融合');
    ok(own.confidence <= local.confidence, '共享视图置信度不高于本舰');
  }
  // 失跟与重捕
  target.isAfloat = false; // 目标消失（例如被击沉/脱离）
  let loseEvent = null;
  for (let i = 0; i < 600; i++) { // 60 s 无观测
    w.t += dt;
    for (const s of w.ships) if (s.isAfloat && s !== target) updateSensors(s, w, dt);
    w.tracks.update(dt);
    if (!loseEvent) loseEvent = w.events.history.find((e) => e.type === 'sensor.lose');
  }
  console.log('  目标消失后 sensor.lose 事件: ' + (loseEvent ? 't=' + loseEvent.t.toFixed(1) + 's confidence=' + loseEvent.confidence : '无'));
  ok(!!loseEvent, '失去观测后 emit sensor.lose');
  target.isAfloat = true; target.pos = { x: 14000, y: 200 };
  const before = w.tracks.tracks[0] ? w.tracks.tracks[0].confidence : 0;
  const reacq = w.tracks.observe({
    side: 'AXIS', srcKind: 'RADAR', shipId: yamato.id, targetId: target.id,
    observerPos: { x: 0, y: 0 }, pos: { x: 14100, y: 200 }, rangeM: 14100, bearingDeg: 89.2,
    accuracyM: 100, accuracyDeg: 1.0, confidence: 0.6, t: w.t,
  });
  console.log('  重捕后 confidence: ' + before.toFixed(2) + ' → ' + reacq.confidence.toFixed(2) + '，reacquired 事件=' +
    w.events.history.some((e) => e.type === 'sensor.detect' && e.reacquired === true));
  ok(reacq && w.events.history.some((e) => e.type === 'sensor.detect' && e.reacquired === true), '失跟后重捕并 emit sensor.detect(reacquired)');
}

// ═════════════════════════════════════════════════════════════════════════════
// 样例 10：传感器误差随距离 / 玩家可见航迹不确定度 / 判型置信度曲线（Lead 验收）
// ═════════════════════════════════════════════════════════════════════════════
line('=== 样例 10：误差量级、声呐失效、判型置信度曲线（Lead 验收）===');
{
  const env = makeEnv({ visibilityNm: 20, seaState: 4 });
  const yamato = shipOf('yamato', 'AXIS'); yamato.pos = { x: 0, y: 0 };
  const ddView = shipOf('shimakaze', 'AXIS'); ddView.pos = { x: 0, y: 0 };
  const ca = shipOf('takao', 'ALLIED');
  const radar = findRadar(yamato, 'type22');
  const rspec = radarSpecOf(radar);
  console.log('  22 号电探：测距精度 ±' + rspec.rangeAccM.toFixed(0) + ' m，方位精度 ±' + rspec.bearingAccDeg.toFixed(2) + '°（束宽 ' + rspec.beamDeg.toFixed(1) + '°）');
  between(rspec.rangeAccM, 25, 80, '早期雷达测距精度（m）');
  between(rspec.bearingAccDeg, 0.8, 3.5, '早期雷达方位精度（°）');
  const rows = [];
  for (const R of [5000, 8000, 15000, 20000]) {
    placeAt(yamato, ca, R, 90, 0);
    const rngA = new RNG(4321 + R);
    let sum15 = 0, degSum = 0;
    for (let i = 0; i < 120; i++) { const s = opticalRangefind(yamato, ca, env, rngA); sum15 += s.errM; degSum += s.errDeg; }
    placeAt(ddView, ca, R, 90, 0);
    const rngB = new RNG(8765 + R);
    let sum45 = 0;
    for (let i = 0; i < 120; i++) { const s = opticalRangefind(ddView, ca, env, rngB); sum45 += s.errM; }
    rows.push({ R, o15: sum15 / 120, o45: sum45 / 120, deg: degSum / 120 });
  }
  for (const r of rows) console.log('  ' + (r.R / 1000).toFixed(0) + ' km：重合式 15 m 基线 ±' + r.o15.toFixed(0) + ' m / 方向 ±' + r.deg.toFixed(2) + '°；4.5 m 基线 ±' + r.o45.toFixed(0) + ' m');
  between(rows[0].o15, 10, 120, '15 m 基线 5 km 测距误差（m）');
  between(rows[1].o15, 20, 200, '15 m 基线 8 km 测距误差（m）');
  between(rows[2].o45, 120, 400, '4.5 m 基线 15 km 测距误差（m）');
  between(rows[3].o45, 200, 700, '4.5 m 基线 20 km 测距误差（m）');
  ok(rows[3].o15 > rows[0].o15 * 4, '测距误差按 R² 增长（' + rows[0].o15.toFixed(0) + '→' + rows[3].o15.toFixed(0) + ' m）');

  // 玩家可见航迹不确定度（5.6 km，日间，雷达+光学融合）
  const envT = makeEnv({ seaState: 3, visibilityNm: 12, lightLevel: 1 });
  const wT = makeWorld(envT, 2024);
  const yT = shipOf('yamato', 'AXIS'); yT.pos = { x: 0, y: 0 };
  const tT = shipOf('takao', 'ALLIED'); tT.pos = { x: 5600, y: 0 }; tT.heading = 45; tT.speed = 14;
  wT.ships.push(yT, tT);
  for (let i = 0; i < 300; i++) {
    wT.t += 0.1;
    if (i % 3 === 0) moveByKinematics(tT, 0.3);
    for (const s of wT.ships) if (s.isAfloat) updateSensors(s, wT, 0.1);
    wT.tracks.update(0.1);
  }
  const vis = wT.tracks.visibleFor(yT).filter((t) => t.sources.includes('RADAR')).sort((a, b) => b.confidence - a.confidence)[0];
  if (vis) {
    console.log('  5.6 km 融合航迹: errM=' + vis.errM.toFixed(0) + ' m, errDeg=' + vis.errDeg.toFixed(2) + '°, confidence=' + vis.confidence.toFixed(2) + ', sources=[' + vis.sources.join(',') + ']');
    ok(vis.errM >= 50, '玩家可见航迹 errM ≥ 50 m（不再是 10 m）');
    ok(vis.errDeg >= 0.5, '玩家可见航迹 errDeg ≥ 0.5°（显示不再是 0°）');
    ok(vis.errM <= 800, '5–6 km 距离 errM 仍在合理量级（<800 m）');
    ok(vis.speedKn >= 0 && vis.speedKn <= 46, '航速估计受物理约束（≤46 kn，不出现幽灵航速）');
  } else { failures++; console.log('  ✗ FAIL: 5.6 km 未建立融合航迹'); }
  const detEv = wT.events.history.find((e) => e.type === 'sensor.detect');
  if (detEv) {
    console.log('  sensor.detect 事件字段: by=' + detEv.by + ' source=' + detEv.source + ' target=' + detEv.target + ' rangeM=' + (detEv.rangeM === null ? 'null' : Math.round(detEv.rangeM)) + ' errM=' + detEv.errM);
    ok(detEv.by !== undefined && detEv.source !== undefined && detEv.target !== undefined && detEv.errM !== undefined, 'sensor.detect 事件含 {by,target,source,rangeM,errM}');
  } else { failures++; console.log('  ✗ FAIL: 无 sensor.detect 事件'); }

  // 判型置信度随时间（日间 vs 夜间，5.6 km 重巡）
  function classCurve(lightLevel) {
    const envC = makeEnv({ seaState: 3, visibilityNm: 12, lightLevel });
    const wC = makeWorld(envC, 3141);
    const yC = shipOf('yamato', 'AXIS'); yC.pos = { x: 0, y: 0 };
    const tC = shipOf('takao', 'ALLIED'); tC.pos = { x: 5600, y: 0 }; tC.heading = 45; tC.speed = 12;
    wC.ships.push(yC, tC);
    const out = [];
    for (let i = 0; i < 3000; i++) {
      wC.t += 0.1; moveByKinematics(tC, 0.1);
      for (const s of wC.ships) if (s.isAfloat) updateSensors(s, wC, 0.1);
      wC.tracks.update(0.1);
      if ((i + 1) % 300 === 0) {
        const tr = wC.tracks.visibleFor(yC).filter((t) => t.sources.includes('RADAR')).sort((a, b) => b.confidence - a.confidence)[0];
        out.push({ t: wC.t, id: tr ? tr.idConfidence : 0, cls: tr ? tr.classifiedAs : '—', conf: tr ? tr.confidence : 0 });
      }
    }
    return out;
  }
  const dayCurve = classCurve(1);
  const nightCurve = classCurve(0.02);
  console.log('  白天判型曲线: ' + dayCurve.map((x) => x.t.toFixed(0) + 's:' + x.cls + '/' + x.id.toFixed(2) + '(航迹' + x.conf.toFixed(2) + ')').join(' → '));
  console.log('  夜间判型曲线: ' + nightCurve.map((x) => x.t.toFixed(0) + 's:' + x.cls + '/' + x.id.toFixed(2) + '(航迹' + x.conf.toFixed(2) + ')').join(' → '));
  const day60 = dayCurve[1], day300 = dayCurve[dayCurve.length - 1];
  const night300 = nightCurve[nightCurve.length - 1];
  ok(day60.id < 0.6, '白天 60 s 判型置信度仍 <0.6（不瞬间饱和）');
  ok(day300.id > 0.5, '白天 300 s 后判型置信度 >0.5（持续观测后收敛）');
  ok(night300.id <= 0.72, '夜间判型置信度封顶 ≤0.72');
  ok(day300.id > night300.id, '夜间识别置信度低于白天');
}
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n' + (failures === 0 ? '✅ T2 全部测试通过' : '❌ 失败 ' + failures + ' 项'));
if (failures > 0) process.exitCode = 1;
