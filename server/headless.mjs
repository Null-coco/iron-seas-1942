#!/usr/bin/env node
// ============================================================================
// 【T5】server/headless.mjs — Node 无头交战（回归用）
// ----------------------------------------------------------------------------
// 目的：不依赖浏览器，在 Node 里跑完整 World 主循环（双方 LOCAL AI），输出
//   (1) 机器可读 JSON（--out），(2) 人类可读中文战报，(3) 可选回放 JSON（--replay）。
//
// 数据来源（按优先级）：
//   data/ships_axis.json + data/ships_allied.json  （T8/外包交付的真实舰船数据）
//   若缺失 → 使用本文件内置的 4 艘 1942 年实舰参数（来源见各条注释），保证 CI 可跑。
//   data/scenarios.json 若缺失 → 使用内置 2 个小型剧本。
//
// 历史依据（内置数据，单位换算见 ARCHITECTURE §0.3）：
//   Fletcher (DD, US, 1942)：Loa 114.8 m，B 12.1 m，满载 2 924 t，5×127mm/38，10×533mm Mk15 鱼雷，36.5 kn
//   New Orleans 级 (CA, US, 1942)：Loa 179.2 m，B 18.8 m，满载 12 463 t，9×203mm/55，32.5 kn，SG 微波雷达
//   Furutaka 级 (CA, JP, 1942)：Loa 185.2 m，B 16.9 m，满载 ~10 340 t，6×203mm/50，8×610mm 九三式氧气鱼雷，34.5 kn
//   Yugumo 级 (DD, JP, 1942)：Loa 119.2 m，B 10.8 m，满载 2 520 t，6×127mm/50，8×610mm 九三式，35 kn
//   1942 年的日本舰艇基本无雷达，夜战靠探照灯+光学测距与九三式长矛鱼雷 —— 这是铁底湾夜战的真实面貌。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';

const __filename = fileURLToPath(import.meta.url);
export const ROOT_DEFAULT = path.resolve(path.dirname(__filename), '..');

// ---------------------------------------------------------------------------
// 内置舰船数据（data/ 缺失时的后备；带来源注释，方便审计量级）
// ---------------------------------------------------------------------------
export const FALLBACK_SHIPS = [
  {
    id: 'us_fletcher', nameEn: 'USS Fletcher', nameZh: '弗莱彻号', nation: 'US', type: 'DD', class: 'Fletcher', year: 1942,
    loa_m: 114.8, beam_m: 12.1, draft_m: 4.1, displacementFull_t: 2924, blockCoef: 0.52,
    crew: 273, gm_m: 1.05, mastHeight_m: 22, speedMax_kn: 36.5, rudderAngleMax_deg: 35, turnRadiusAt20kn_m: 620,
    armor: { belt_mm: 13, deck_mm: 13, beltLengthFrac: 0.5 },
    guns: [
      { role: 'main', count: 5, mountLabel: 'Mk12 5"/38 单装', gunsPerMount: 1, caliber_mm: 127, shell_mass_kg: 25, muzzleVelocity_mps: 792, rateOfFire_rpm: 15, elevMin_deg: -15, elevMax_deg: 85, traverseRate_deg_s: 14, elevRate_deg_s: 16, ammo: { AP: 200, HE: 1500 } },
      { role: 'secondary', count: 2, mountLabel: '博福斯 40mm 双联', gunsPerMount: 2, caliber_mm: 40, shell_mass_kg: 0.9, muzzleVelocity_mps: 881, elevMin_deg: -7, elevMax_deg: 85, traverseRate_deg_s: 30, elevRate_deg_s: 24, ammo: { HE: 2000 } },
    ],
    torpedoes: [{ mountLabel: '五联装 533mm 鱼雷管', tubes: 5, reloads: 1, diameter_mm: 533, nation: 'US', speed_kn: 36, range_m: 9000, warhead_kg: 290, wake: 'VISIBLE', speedIdxHigh_kn: 36, speedIdxLow_kn: 27 }],
    sensors: {
      radar: [{ id: 'sg', nameZh: 'SG 对海雷达', type: 'MICROWAVE', freq_MHz: 3000, peakPower_kw: 50, gain_dB: 30, antennaHeight_m: 22, minRange_m: 200, pdBase: 0.8 }],
      sonar: [{ id: 'qc', nameZh: 'QC 声呐', type: 'ACTIVE', freq_kHz: 24 }],
      hydro: [{ id: 'jp', nameZh: 'JP 水听器' }],
      rangefinders: [{ base_m: 4.5, type: 'stereoscopic', mount: 'director' }],
      directors: [{ id: 'mk37', nameZh: 'Mk37 主炮指挥仪', hasFCComputer: true, stabilized: true, channels: 2 }],
    },
  },
  {
    id: 'us_sanfrancisco', nameEn: 'USS San Francisco', nameZh: '旧金山号', nation: 'US', type: 'CA', class: 'New Orleans', year: 1942,
    loa_m: 179.2, beam_m: 18.8, draft_m: 6.9, displacementFull_t: 12463, blockCoef: 0.54,
    crew: 930, gm_m: 1.25, mastHeight_m: 32, speedMax_kn: 32.5, rudderAngleMax_deg: 35, turnRadiusAt20kn_m: 750,
    armor: { belt_mm: 127, deck_mm: 57, beltLengthFrac: 0.55, turret_mm: 203, barbette_mm: 127 },
    guns: [
      { role: 'main', count: 3, mountLabel: 'Mk14 8"/55 三联装', gunsPerMount: 3, caliber_mm: 203, shell_mass_kg: 118, muzzleVelocity_mps: 853, rateOfFire_rpm: 3.5, elevMin_deg: -5, elevMax_deg: 41, traverseRate_deg_s: 5, elevRate_deg_s: 8, ammo: { AP: 400, HE: 250 } },
      { role: 'secondary', count: 4, mountLabel: '5"/25 单装', gunsPerMount: 1, caliber_mm: 127, shell_mass_kg: 24, muzzleVelocity_mps: 657, elevMin_deg: -10, elevMax_deg: 85, traverseRate_deg_s: 12, elevRate_deg_s: 15, ammo: { HE: 400 } },
    ],
    torpedoes: [],
    sensors: {
      radar: [{ id: 'sg2', nameZh: 'SG 对海雷达', type: 'MICROWAVE', freq_MHz: 3000, peakPower_kw: 50, gain_dB: 30, antennaHeight_m: 30, minRange_m: 200, pdBase: 0.85 }, { id: 'fc', nameZh: 'Mk3 火控雷达', type: 'MICROWAVE', freq_MHz: 3000, gain_dB: 26, antennaHeight_m: 28, minRange_m: 400 }],
      sonar: [], hydro: [{ id: 'jp2', nameZh: 'JP 水听器' }],
      rangefinders: [{ base_m: 8.5, type: 'stereoscopic', mount: 'director' }],
      directors: [{ id: 'mk34', nameZh: 'Mk34 主炮指挥仪', hasFCComputer: true, stabilized: true, channels: 2 }],
    },
  },
  {
    id: 'jp_furutaka', nameEn: 'IJN Furutaka', nameZh: '古鹰号', nation: 'JP', type: 'CA', class: 'Furutaka', year: 1942,
    loa_m: 185.2, beam_m: 16.9, draft_m: 5.6, displacementFull_t: 10340, blockCoef: 0.53,
    crew: 639, gm_m: 1.15, mastHeight_m: 34, speedMax_kn: 34.5, rudderAngleMax_deg: 35, turnRadiusAt20kn_m: 720,
    armor: { belt_mm: 76, deck_mm: 35, beltLengthFrac: 0.5, turret_mm: 25 },
    guns: [
      { role: 'main', count: 3, mountLabel: '三年式 20cm 双联装', gunsPerMount: 2, caliber_mm: 203, shell_mass_kg: 110, muzzleVelocity_mps: 835, rateOfFire_rpm: 4, elevMin_deg: -5, elevMax_deg: 40, traverseRate_deg_s: 4, elevRate_deg_s: 6, ammo: { AP: 300, HE: 200 } },
      { role: 'secondary', count: 4, mountLabel: '十年式 12cm 单装', gunsPerMount: 1, caliber_mm: 120, shell_mass_kg: 23, muzzleVelocity_mps: 825, elevMin_deg: -10, elevMax_deg: 75, traverseRate_deg_s: 10, elevRate_deg_s: 12, ammo: { HE: 400 } },
    ],
    torpedoes: [{ mountLabel: '九三式 610mm 四联装', tubes: 4, reloads: 0, diameter_mm: 610, nation: 'JP', speed_kn: 48, range_m: 20000, warhead_kg: 490, wake: 'NONE', speedIdxHigh_kn: 48, speedIdxLow_kn: 36, oxygen: true }],
    sensors: {
      radar: [], sonar: [], hydro: [{ id: 'type93', nameZh: '九三式水听器' }],
      rangefinders: [{ base_m: 8.0, type: 'stereoscopic', mount: 'director' }],
      directors: [{ id: 'type94', nameZh: '九四式射击盘', hasFCComputer: true, stabilized: true, channels: 2 }],
    },
  },
  {
    id: 'jp_yugumo', nameEn: 'IJN Yugumo', nameZh: '夕云号', nation: 'JP', type: 'DD', class: 'Yugumo', year: 1942,
    loa_m: 119.2, beam_m: 10.8, draft_m: 3.8, displacementFull_t: 2520, blockCoef: 0.52,
    crew: 228, gm_m: 1.0, mastHeight_m: 24, speedMax_kn: 35, rudderAngleMax_deg: 35, turnRadiusAt20kn_m: 600,
    armor: { belt_mm: 0, deck_mm: 0, beltLengthFrac: 0.4 },
    guns: [
      { role: 'main', count: 3, mountLabel: '三年式 12.7cm 双联装', gunsPerMount: 2, caliber_mm: 127, shell_mass_kg: 23, muzzleVelocity_mps: 915, rateOfFire_rpm: 10, elevMin_deg: -7, elevMax_deg: 75, traverseRate_deg_s: 12, elevRate_deg_s: 14, ammo: { AP: 150, HE: 300 } },
    ],
    torpedoes: [{ mountLabel: '九三式 610mm 四联装', tubes: 4, reloads: 1, diameter_mm: 610, nation: 'JP', speed_kn: 48, range_m: 20000, warhead_kg: 490, wake: 'NONE', speedIdxHigh_kn: 48, speedIdxLow_kn: 36, oxygen: true }],
    sensors: {
      radar: [], sonar: [{ id: 'type93s', nameZh: '九三式声呐', type: 'ACTIVE' }], hydro: [{ id: 'type93h', nameZh: '九三式水听器' }],
      rangefinders: [{ base_m: 5.0, type: 'stereoscopic', mount: 'director' }],
      directors: [{ id: 'type94d', nameZh: '九四式射击盘', hasFCComputer: true, stabilized: true, channels: 1 }],
    },
  },
];

// 小型剧本：铁底湾前哨遭遇战（1942-11-13 夜，第一次瓜岛海战前后的遭遇战设定）
export const FALLBACK_SCENARIOS = [
  {
    id: 't5_skirmish',
    nameZh: '【内置】铁底湾前哨遭遇战',
    date: '1942-11-13T01:30:00Z',
    start: { lat: -9.25, lon: 159.8 },
    env: { windKn: 8, windDirDeg: 135, visibilityNm: 4, seaState: 2, cloudCover: 0.7 },
    sides: {
      ALLIED: { nameZh: '同盟国', objective: '阻止日军编队突入铁底湾', orderDelay_s: 5, aiBackend: 'LOCAL', withdrawThreshold: 0.3 },
      AXIS: { nameZh: '轴心国', objective: '突入铁底湾并击退美舰', orderDelay_s: 7, aiBackend: 'LOCAL', withdrawThreshold: 0.3 },
    },
    ships: [
      { id: 'sf', class: 'id:us_sanfrancisco', side: 'ALLIED', role: 'flagship', x: 0, y: 0, heading: 90, speed: 18, crewQuality: 1.0, name: '旧金山号' },
      { id: 'fletcher', class: 'id:us_fletcher', side: 'ALLIED', role: 'screen', x: -400, y: -900, heading: 95, speed: 22, crewQuality: 0.9, name: '弗莱彻号' },
      { id: 'furutaka', class: 'id:jp_furutaka', side: 'AXIS', role: 'flagship', x: 14000, y: 900, heading: 270, speed: 20, crewQuality: 1.1, name: '古鹰号' },
      { id: 'yugumo', class: 'id:jp_yugumo', side: 'AXIS', role: 'screen', x: 14600, y: -200, heading: 265, speed: 24, crewQuality: 1.05, name: '夕云号' },
    ],
    objectives: [
      { side: 'ALLIED', result: 'ALLIED', text: '击沉任意一艘日舰', condition: { type: 'SINK_ANY', shipIds: ['furutaka', 'yugumo'] } },
      { side: 'AXIS', result: 'AXIS', text: '击沉任意一艘美舰', condition: { type: 'SINK_ANY', shipIds: ['sf', 'fletcher'] } },
    ],
  },
  {
    id: 't5_sandbox',
    nameZh: '【内置】单舰炮术沙盒',
    date: '1942-06-01T12:00:00Z',
    start: { lat: 0, lon: 0 },
    env: { windKn: 12, windDirDeg: 270, visibilityNm: 12, seaState: 3 },
    sides: {
      ALLIED: { nameZh: '同盟国', objective: '单舰对抗', orderDelay_s: 4, aiBackend: 'LOCAL' },
      AXIS: { nameZh: '轴心国', objective: '单舰对抗', orderDelay_s: 4, aiBackend: 'LOCAL' },
    },
    ships: [
      { id: 'sf', class: 'id:us_sanfrancisco', side: 'ALLIED', role: 'flagship', x: 0, y: 0, heading: 90, speed: 20, name: '旧金山号' },
      { id: 'furutaka', class: 'id:jp_furutaka', side: 'AXIS', role: 'flagship', x: 12000, y: 0, heading: 270, speed: 20, name: '古鹰号' },
    ],
    objectives: [
      { side: 'ALLIED', result: 'ALLIED', text: '击沉古鹰号', condition: { type: 'SINK_ANY', shipIds: ['furutaka'] } },
      { side: 'AXIS', result: 'AXIS', text: '击沉旧金山号', condition: { type: 'SINK_ANY', shipIds: ['sf'] } },
    ],
  },
];

// ---------------------------------------------------------------------------
// 数据装载（data/ 存在则优先用磁盘数据）
// ---------------------------------------------------------------------------
export function loadDatabase(root = ROOT_DEFAULT) {
  const dir = path.join(root, 'data');
  const files = [];
  try {
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (/^ships_.*\.json$/i.test(f)) files.push(path.join(dir, f));
  } catch { /* ignore */ }
  const objs = [];
  for (const f of files) {
    try { objs.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { console.warn('[headless] 读取失败 ' + f + ': ' + (e && e.message)); }
  }
  if (objs.length) {
    const db = ShipDatabase.fromMany(objs);
    if (db.list.length) return { database: db, source: dir, files, builtin: false };
    console.warn('[headless] data/ 中的舰船文件为空，改用内置数据');
  }
  return { database: ShipDatabase.fromObject({ ships: FALLBACK_SHIPS }), source: 'builtin', files: [], builtin: true };
}

export function loadScenarioList(root = ROOT_DEFAULT) {
  const p = path.join(root, 'data', 'scenarios.json');
  try {
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      const arr = Array.isArray(obj) ? obj : (obj.scenarios || []);
      if (arr.length) return { scenarios: arr, source: p, builtin: false };
    }
  } catch (e) { console.warn('[headless] scenarios.json 解析失败：' + (e && e.message)); }
  return { scenarios: FALLBACK_SCENARIOS, source: 'builtin', builtin: true };
}

export function loadScenario(root = ROOT_DEFAULT, id) {
  const list = loadScenarioList(root);
  const sc = (id && list.scenarios.find((s) => s.id === id)) || list.scenarios[0];
  return { scenario: sc, source: list.source, builtin: list.builtin };
}

// ---------------------------------------------------------------------------
// 无头交战
// ---------------------------------------------------------------------------
export async function runHeadless(opts = {}) {
  const root = path.resolve(opts.root || ROOT_DEFAULT);
  // --builtin：强制使用内置舰船数据 + 内置小型剧本（CI 确定性；不读 data/）
  const db = opts.database ? { database: opts.database, source: 'provided', builtin: false }
    : (opts.builtin ? { database: ShipDatabase.fromObject({ ships: FALLBACK_SHIPS }), source: 'builtin', builtin: true } : loadDatabase(root));
  const scPick = opts.scenario ? { scenario: opts.scenario, source: 'provided', builtin: false }
    : (opts.builtin ? { scenario: (FALLBACK_SCENARIOS.find((s) => s.id === opts.scenarioId) || FALLBACK_SCENARIOS[0]), source: 'builtin', builtin: true }
      : loadScenario(root, opts.scenarioId));
  const scenario = scPick.scenario;
  const seconds = opts.seconds !== undefined ? opts.seconds : 1800;
  const dt = opts.dt !== undefined ? opts.dt : 0.1;
  const seed = opts.seed !== undefined ? opts.seed : 19420604;
  const verbose = !!opts.verbose;
  const progressS = opts.progressS || 120;

  let landData = null, depthData = null;
  try { landData = JSON.parse(fs.readFileSync(path.join(ROOT_DEFAULT, 'data/land.json'), 'utf8')); } catch (e) { landData = null; }
  try { depthData = JSON.parse(fs.readFileSync(path.join(ROOT_DEFAULT, 'data/depth.json'), 'utf8')); } catch (e) { depthData = null; }
  const world = new World({
    scenario, database: db.database, seed, playerSide: opts.playerSide || 'ALLIED',
    ai: true,
    aiOpts: Object.assign({ backend: 'LOCAL' }, opts.aiOpts || {}),
    buildFromScenario: true,
    landData, depthData,
  });
  if (opts.sides) for (const s of ['ALLIED', 'AXIS']) { if (opts.sides[s]) world.sides[s].aiBackend = opts.sides[s]; }

  const wantShips = (scenario.ships || []).length;
  const loadedShips = world.ships.length;
  const t0 = Date.now();
  let steps = 0;
  let nextProgress = progressS;
  while (!world.over && world.t < seconds) {
    world.step(dt);
    steps++;
    if (verbose && world.t >= nextProgress) {
      nextProgress += progressS;
      console.log('[headless] T+' + world.t.toFixed(0) + 's  在役 ' + world.afloatOf('ALLIED').length + ' vs ' + world.afloatOf('AXIS').length
        + '  航迹 ' + world.tracks.tracks.length + '  弹丸 ' + world.projectiles.length + '  鱼雷 ' + world.torpedoes.length);
    }
    if (steps > (seconds / dt) + 1000) break; // 保险
  }
  const wallMs = Date.now() - t0;
  const replay = world.exportReplay();
  const report = buildReport(world, {
    scenario, seed, dt, seconds, steps, wallMs, dbSource: db.source, scenarioSource: scPick.source,
    wantShips, loadedShips, replay,
  });

  if (opts.replayPath) {
    fs.mkdirSync(path.dirname(path.resolve(opts.replayPath)), { recursive: true });
    fs.writeFileSync(opts.replayPath, JSON.stringify(replay));
    report.replayPath = path.resolve(opts.replayPath);
  }
  if (opts.outPath) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true });
    fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2));
    report.jsonPath = path.resolve(opts.outPath);
  }
  return { world, report, replay };
}

// ---------------------------------------------------------------------------
// 战报
// ---------------------------------------------------------------------------
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

// 弹药库事件 result → 中文文案（与 src/ui/aar.js 的 MAGAZINE_RESULT_ZH 保持一致）
// 旧版一律写"弹药库殉爆"，把 result='hit'（弹药库被命中但未殉爆）也当成殉爆，属错误叙事。
export const MAGAZINE_RESULT_ZH = {
  detonation: '殉爆', burn: '爆燃', flooded: '注水', flash: '炮塔闪爆', hit: '被命中', fire_threat: '受威胁',
};

// 大事记：按重要度筛选（沉没/殉爆/爆燃 > 鱼雷命中/哑弹 > 穿透 > 失能 …），同权重取最近发生的。
// 旧版 majorTypes 里混入 fc.solution / sensor.detect 两类高频噪声，导致末 200 条几乎全是火控解算。
const MAJOR_RANK = {
  'sim.end': 100, 'victory.achieved': 100,
  'ship.sink': 98, 'dam.magazine': 95, 'ship.capsize': 94, 'dam.blast': 92,
  'torp.hit': 90, 'torp.dud': 86, 'gun.penetration': 76, 'dam.subsystem': 66,
  'ship.collide': 62, 'ship.grounding': 60, 'dam.fire': 50,
  'ship.shoal': 40, 'order.reject': 36, 'ai.fallback': 45,
  'dam.flood': 30, 'gun.straddle': 20,   // 进水/夹叉是高频摘要，只在重要事件不足 200 条时补齐
};
const MAJOR_MAX = 200;

function shipNameOf(world, id) {
  const s = id && world && typeof world.ship === 'function' ? world.ship(id) : null;
  return (s && s.name) || id || '';
}

// 事件 → 中文叙事（战报大事记用；dam.subsystem 事件的 e.name 是子系统名，舰名要从 e.ship 解析）
export function describeMajor(e, world) {
  const victim = shipNameOf(world, e.ship) || e.name || '';
  switch (e.type) {
    case 'ship.sink': return victim + ' 沉没' + (e.cause ? '（' + e.cause + '）' : '');
    case 'ship.capsize': return victim + ' 倾覆（横倾 ' + (e.list === undefined ? '?' : e.list) + '°）';
    case 'dam.magazine': return victim + ' 弹药库' + (MAGAZINE_RESULT_ZH[e.result] || '受损');
    case 'dam.blast': return victim + ' 遭 ' + (shipNameOf(world, e.from) || e.from) + ' 殉爆冲击（' + (e.distM || 0) + 'm）';
    case 'torp.hit': return victim + ' 被鱼雷命中' + (e.shooter ? '（' + shipNameOf(world, e.shooter) + '）' : '');
    case 'torp.dud': return victim + ' 被鱼雷命中但哑弹';
    case 'gun.penetration': return victim + ' 被击穿' + (e.byShipName ? '（' + e.byShipName + ' ' + (e.caliberMM || '?') + 'mm）' : '');
    case 'gun.straddle': return victim + ' 对 ' + (shipNameOf(world, e.targetShipId) || '目标') + ' 形成夹叉（偏差 ' + (e.meanRangeErrM || 0) + 'm）';
    case 'dam.subsystem': return victim + ' 的 ' + (e.name || e.kind || '子系统') + (e.destroyed ? ' 被摧毁' : ' 受损');
    case 'dam.flood': {
      if (!e.aggregate) return victim + ' 进水（舱段 ' + (e.compartment === null || e.compartment === undefined ? '?' : e.compartment) + '）';
      return victim + ' 进水 ' + (e.floodedM3 !== undefined ? e.floodedM3 : e.value) + 'm³（' + (e.floodedPct || 0) + '%，进水率 ' + (e.rateM3s || 0) + 'm³/s，破口 ' + (e.breaches || 0) + ' 处）';
    }
    case 'dam.fire': return victim + ' 起火（舱段 ' + (e.compartment === null || e.compartment === undefined ? '?' : e.compartment) + '）';
    case 'ship.collide': return (shipNameOf(world, e.a) || e.a) + ' 与 ' + (shipNameOf(world, e.b) || e.b) + ' 碰撞';
    case 'ship.grounding': return victim + ' 搁浅';
    case 'ship.shoal': return victim + ' 触底（水深 ' + (e.depthM || '?') + 'm）';
    case 'order.reject': return shipNameOf(world, e.ship) + ' 命令被拒：' + (e.reason || e.kind || '');
    case 'ai.fallback': return (e.side || '') + ' AI 回落：' + (e.reason || e.text || '');
    case 'victory.achieved': return '交战结束：' + (e.text || e.winner || '');
    case 'sim.end': return '仿真结束：' + (e.text || e.winner || '');
    default: return e.type;
  }
}

// 大事记筛选：先按重要度取前 MAJOR_MAX 条（同类取最近），再按时间排序输出
function pickMajorEvents(history, world) {
  const cand = [];
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    const rank = MAJOR_RANK[e.type];
    if (rank === undefined) continue;
    cand.push({ e, rank, i, t: e.t === null ? world.t : e.t });
  }
  cand.sort((a, b) => b.rank - a.rank || b.i - a.i);
  cand.length = Math.min(cand.length, MAJOR_MAX);
  cand.sort((a, b) => a.i - b.i);
  return cand.map(({ e, t }) => ({
    t: +t.toFixed(1), type: e.type,
    ship: e.name || shipNameOf(world, e.ship) || null, target: e.target || e.targetShipId || null,
    text: describeMajor(e, world),
    rangeM: e.rangeM !== undefined ? Math.round(e.rangeM) : undefined, compartment: e.compartment, winner: e.winner,
  }));
}

export function buildReport(world, meta = {}) {
  const bus = world.events;
  const history = bus.history;
  // 统计口径：优先用 EventBus 的累计 emit 次数（不受历史保留策略影响，绝不因截断少算）；
  // 同时给出历史里实际保留的条数，两者差值为被淘汰的噪声事件。
  const evKept = {};
  for (const e of history) evKept[e.type] = (evKept[e.type] || 0) + 1;
  const evEmitted = bus.emitted ? Object.assign({}, bus.emitted) : Object.assign({}, evKept);
  const totalEmitted = bus.emitted ? Object.keys(evEmitted).reduce((a, k) => a + evEmitted[k], 0) : history.length;
  const timeline = pickMajorEvents(history, world);
  // 近失弹单独统计（damage.js 里 gun.nearmiss → 舷侧非接触损伤），与被命中口径分开
  const nearMissByShip = {};
  for (const e of history) if (e.type === 'gun.nearmiss' && e.ship) nearMissByShip[e.ship] = (nearMissByShip[e.ship] || 0) + 1;
  const ships = world.ships.map((s) => ({
    id: s.id, name: s.name, side: s.side, type: s.type, nation: s.nation,
    isAfloat: s.isAfloat, sinking: s.sinking, capsized: s.capsized, sunkAt: s.sunkAt === null ? null : +s.sunkAt.toFixed(1),
    speed: +s.speed.toFixed(2), speedCapKn: +s.speedCapKn.toFixed(1), heading: +s.heading.toFixed(1),
    pos: { x: Math.round(s.pos.x), y: Math.round(s.pos.y) },
    floodedM3: Math.round(s.floodedM3), floodedPct: +(100 * s.floodedM3 / s.reserveBuoyancyM3).toFixed(1),
    list: +s.list.toFixed(1), fires: s.compartments.filter((c) => c.fire > 0.05).length,
    crew: Math.round(s.crew), crewPct: +(s.crew / Math.max(1, s.crew0)).toFixed(2),
    hits: s.stats ? s.stats.hits : 0, hitsTaken: s.stats ? s.stats.hitsTaken : 0,
    nearMisses: nearMissByShip[s.id] || 0,
    shotsFired: s.stats ? s.stats.shotsFired : 0, straddles: s.stats ? s.stats.straddles : 0,
    torpedoesFired: s.stats ? s.stats.torpedoesFired : 0, torpHits: s.stats ? s.stats.torpHits : 0,
    mainAmmo: s.mainBatteries.reduce((a, b) => a + (b.ammo.AP || 0) + (b.ammo.HE || 0), 0),
    subsystemsDown: s.subsystems.filter((x) => x.destroyed).length,
    batteriesDown: s.batteries.filter((b) => b.destroyed).length,
  }));
  // 交战双方命中率（total hits/shots）——只看炮术命中，鱼雷另列
  const blankG = () => ({ hits: 0, shots: 0, nearMisses: 0, torpsFired: 0, torpHits: 0 });
  const gunnery = { ALLIED: blankG(), AXIS: blankG(), total: blankG() };
  for (const s of ships) {
    const g = gunnery[s.side] || (gunnery[s.side] = blankG());
    for (const k of [g, gunnery.total]) {
      k.hits += s.hits; k.shots += s.shotsFired; k.nearMisses += s.nearMisses;
      k.torpsFired += s.torpedoesFired; k.torpHits += s.torpHits;
    }
  }
  const digest = JSON.stringify({
    seed: world.seed, t: +world.t.toFixed(2), winner: world.winner, over: world.over,
    ships: ships.map((s) => [s.id, s.isAfloat, s.floodedM3, s.list, s.speed]),
    events: totalEmitted, eventsHistory: history.length, snaps: world.record.snapshots.length,
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    server: 'iron-seas-1942/headless',
    scenario: { id: world.scenario.id, nameZh: world.scenario.nameZh, source: meta.scenarioSource || 'builtin' },
    seed: world.seed, dt: meta.dt, secondsBudget: meta.seconds, simSeconds: +world.t.toFixed(1),
    steps: meta.steps, wallMs: meta.wallMs, speedup: meta.wallMs > 0 ? +(world.t / (meta.wallMs / 1000)).toFixed(1) : null,
    over: world.over, winner: world.winner, resultText: world.resultText || (world.over ? '' : '未决（到达时间上限）'),
    database: { source: meta.dbSource, shipsLoaded: meta.loadedShips, shipsWanted: meta.wantShips },
    ships,
    gunnery,
    counts: {
      ships: world.ships.length, afloat: world.ships.filter((s) => s.isAfloat).length,
      tracks: world.tracks.tracks.length, commands: world.commands.length, pending: world.pending.length,
      projectiles: world.projectiles.length, torpedoes: world.torpedoes.length,
      snapshots: world.record.snapshots.length,
      events: totalEmitted, eventsHistory: history.length,
      eventsDroppedNoise: bus.droppedNoise || 0, eventsDroppedCritical: bus.droppedCritical || 0,
    },
    events: evEmitted,
    eventsKept: evKept,
    retention: typeof bus.retention === 'function' ? bus.retention() : null,
    timeline,
    digest: hashStr(digest),
  };
}

export function formatReport(r) {
  const L = [];
  const line = '='.repeat(78);
  L.push(line);
  L.push('  铁海 1942 — 无头交战战报 (headless)');
  L.push(line);
  L.push('剧本：' + r.scenario.nameZh + '  [' + r.scenario.id + ']  (' + r.scenario.source + ')');
  L.push('种子：' + r.seed + '   步长：' + r.dt + 's   仿真时长：' + r.simSeconds + 's / 上限 ' + r.secondsBudget + 's');
  L.push('步数：' + r.steps + '   实时耗时：' + r.wallMs + ' ms   加速比：' + r.speedup + 'x   状态摘要：' + r.digest);
  L.push('舰船数据：' + r.database.source + '（载入 ' + r.database.shipsLoaded + '/' + r.database.shipsWanted + ' 艘）');
  L.push('结局：' + (r.over ? ('已判定 → ' + (r.winner || '?') + '（' + r.resultText + '）') : ('未决 → ' + r.resultText)));
  L.push('');
  L.push('【舰艇终态】  (命中=我方命中敌舰 / 被弹=被命中 / 近失=水中近失（独立统计，不计入被弹）/ 主炮弹药余量)');
  L.push('  ' + pad('舰名', 12) + pad('方', 8) + pad('型', 4) + pad('状态', 8) + pad('航速', 7) + pad('进水%', 7) + pad('横倾°', 7) + pad('火灾', 5) + pad('命中', 5) + pad('被弹', 5) + pad('近失', 5) + pad('击发', 5) + pad('鱼雷', 5) + pad('弹药', 6));
  for (const s of r.ships) {
    const st = s.isAfloat ? (s.sinking ? '下沉中' : '在役') : (s.capsized ? '倾覆' : '沉没');
    L.push('  ' + pad(s.name, 12) + pad(s.side, 8) + pad(s.type, 4) + pad(st, 8) + pad(s.speed.toFixed(1), 7) + pad(s.floodedPct.toFixed(1), 7)
      + pad(s.list.toFixed(1), 7) + pad(s.fires, 5) + pad(s.hits, 5) + pad(s.hitsTaken, 5) + pad(s.nearMisses || 0, 5) + pad(s.shotsFired, 5) + pad(s.torpedoesFired, 5) + pad(s.mainAmmo, 6));
  }
  L.push('');
  // 交战双方命中率：炮术命中/发射（total hits/shots），鱼雷单列；口径来自 sim 层 stats
  L.push('【交战双方命中率】  (炮术 命中/发射；鱼雷单列；近失不计入命中)');
  L.push('  ' + pad('方', 8) + pad('命中', 6) + pad('发射', 7) + pad('命中率', 9) + pad('近失', 6) + pad('鱼雷发射', 10) + pad('鱼雷命中', 10));
  const gRows = [['同盟国', r.gunnery && r.gunnery.ALLIED], ['轴心国', r.gunnery && r.gunnery.AXIS], ['合计', r.gunnery && r.gunnery.total]];
  for (const [label, g] of gRows) {
    if (!g) continue;
    const rate = g.shots ? (100 * g.hits / g.shots).toFixed(1) + '%' : '—';
    L.push('  ' + pad(label, 8) + pad(g.hits, 6) + pad(g.shots, 7) + pad(rate, 9) + pad(g.nearMisses, 6) + pad(g.torpsFired, 10) + pad(g.torpHits, 10));
  }
  L.push('');
  L.push('【大事记（重要事件 · 最多 ' + MAJOR_MAX + ' 条，按重要度筛选）】');
  for (const e of r.timeline) {
    L.push('  T+' + e.t.toFixed(1).padStart(8) + '  ' + pad(e.type, 16) + (e.text ? '  ' + e.text : (e.ship ? ' ' + e.ship : ''))
      + (e.target ? ' → ' + e.target : '') + (e.rangeM !== undefined ? '  距离 ' + e.rangeM + 'm' : '') + (e.winner ? '  胜者 ' + e.winner : ''));
  }
  L.push('');
  L.push('【事件计数（累计 emit；历史保留数不同时注明）】');
  const keys = Object.keys(r.events).sort();
  for (const k of keys) {
    const kept = r.eventsKept ? r.eventsKept[k] : r.events[k];
    L.push('  ' + pad(k, 22) + r.events[k] + (kept !== r.events[k] ? '  （历史保留 ' + kept + '）' : ''));
  }
  L.push('');
  L.push('【摘要】舰船 ' + r.counts.ships + '（在役 ' + r.counts.afloat + '） 航迹 ' + r.counts.tracks + ' 命令 ' + r.counts.commands
    + ' 事件 累计 ' + r.counts.events + ' / 历史 ' + r.counts.eventsHistory + ' 快照 ' + r.counts.snapshots + ' 弹丸 ' + r.counts.projectiles + ' 鱼雷 ' + r.counts.torpedoes);
  if (r.retention) {
    L.push('事件保留账本：首个关键事件 T+' + (r.retention.firstCriticalT === null ? '—' : r.retention.firstCriticalT) + 's · 噪声淘汰 ' + r.retention.droppedNoise
      + ' 条 · 关键事件丢失 ' + r.retention.droppedCritical + ' 条' + (r.retention.droppedCritical === 0 ? '（关键事件从 t=0 起完整保留）' : '（警示：有真实信息丢失）'));
  }
  L.push(line);
  return L.join('\n');
}
function pad(v, n) { const s = String(v); const w = (s.match(/[\u4e00-\u9fff]/g) || []).length; return s + ' '.repeat(Math.max(1, n - s.length - w)); }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = { root: ROOT_DEFAULT };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scenario' || a === '-s') opt.scenarioId = args[++i];
    else if (a === '--seconds' || a === '-t') opt.seconds = Number(args[++i]);
    else if (a === '--dt') opt.dt = Number(args[++i]);
    else if (a === '--seed') opt.seed = Number(args[++i]);
    else if (a === '--out' || a === '-o') opt.outPath = args[++i];
    else if (a === '--replay') opt.replayPath = args[++i];
    else if (a === '--root') opt.root = args[++i];
    else if (a === '--builtin') opt.builtin = true;
    else if (a === '--json') opt.jsonOnly = true;
    else if (a === '--verbose' || a === '-v') opt.verbose = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node server/headless.mjs [--scenario id] [--seconds 1800] [--dt 0.1] [--seed 19420604]');
      console.log('        [--out report.json] [--replay replay.json] [--json] [--verbose] [--list] [--builtin]');
      process.exit(0);
    }
  }
  if (opt.list) {
    const l = loadScenarioList(opt.root);
    console.log('剧本来源：' + l.source);
    for (const s of l.scenarios) console.log('  ' + s.id + '  ' + (s.nameZh || '') + (s.builtin ? '  [内置]' : ''));
    process.exit(0);
  }
  const { report } = await runHeadless(opt);
  if (opt.jsonOnly) console.log(JSON.stringify(report));
  else console.log(formatReport(report));
  if (opt.outPath) console.error('[headless] JSON 已写入 ' + path.resolve(opt.outPath));
  if (opt.replayPath) console.error('[headless] 回放已写入 ' + path.resolve(opt.replayPath));
}
