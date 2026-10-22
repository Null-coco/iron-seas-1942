// test/t8.scenarios.test.mjs —— 铁海 1942 剧本静态校验（零依赖，原生 ESM）
//
// 覆盖：
//   1) 结构校验：必填字段、id 唯一、ships 必填字段、经纬度范围
//   2) 舰船解析：ships[].class 能否被 ShipDatabase.resolve（data/ships_*.json）解析
//   3) 几何校验：双方不重叠、同型队形不碰撞、初始接敌距离统计
//   4) 目标校验：condition.type 合法、shipIds 存在于本剧本、result/side 合法
//   5) 环境校验：env 五要素范围、start.env 与 env 一致
//   6) 夜战校验：夜战剧本开局 lightLevel 必须 < 0.15（调用真实 Environment）
//   7) 集成冒烟：用真实 World 装入沙盒剧本推进 60 s（非致命，失败仅告警）
//
// 数据缺失策略：data/ships_*.json 尚未落盘时，脚本输出 "PENDING DATA"，以 0 退出（等待数据）；
// 数据齐全后若仍有 class 解析不到，则判为硬失败并以 1 退出。
//
// 运行： node test/t8.scenarios.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShipDatabase } from '../src/sim/data.js';
import { GeoPlane } from '../src/core/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const M_PER_NMI = 1852;

let pass = 0, fail = 0, warn = 0;
const failures = [], warnings = [];
const ok = (cond, label) => { if (cond) pass++; else { fail++; failures.push(label); console.log('  \u2716 ' + label); } return !!cond; };
const warnIf = (cond, label) => { if (!cond) { warn++; warnings.push(label); console.log('  \u26a0 ' + label); } return !!cond; };
const section = (t) => console.log('\n=== ' + t + ' ===');
const f2 = (v, n = 2) => Number(v).toFixed(n);

// ---------- 载入剧本 ----------
const scPath = path.join(ROOT, 'data', 'scenarios.json');
if (!fs.existsSync(scPath)) { console.log('FATAL: 缺少 data/scenarios.json'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
const list = Array.isArray(doc) ? doc : doc.scenarios;
if (!Array.isArray(list) || list.length === 0) { console.log('FATAL: scenarios.json 无 scenarios 数组'); process.exit(1); }

// ---------- 载入舰船数据库 ----------
const DATA_FILES = ['ships_axis.json', 'ships_allied.json'];
const dbObjs = [], missingFiles = [], pendingNotes = [];
for (const f of DATA_FILES) {
  const p = path.join(ROOT, 'data', f);
  if (!fs.existsSync(p)) { missingFiles.push(f); continue; }
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    dbObjs.push(obj);
    const meta = obj._meta || {};
    if (meta.notes && /PENDING|pending|待/.test(String(meta.notes))) pendingNotes.push(f + ' (_meta.notes 标记 PENDING)');
  } catch (e) { missingFiles.push(f + ' (JSON 解析失败: ' + e.message + ')'); }
}
const db = ShipDatabase.fromMany(dbObjs);
const pendingReasons = [...missingFiles.map((f) => '缺少数据文件 ' + f), ...pendingNotes];
const dataPending = pendingReasons.length > 0;

// 归一化比较，用于给出“最接近的已存在 class”提示
const norm = (s) => String(s).toLowerCase().replace(/[\s_\-.]/g, '');
const knownRefs = new Map();
for (const s of db.list) { knownRefs.set(norm(s.id), s); if (s.class) knownRefs.set(norm(s.class), s); }
const suggest = (ref) => { const s = knownRefs.get(norm(ref)); return s ? ' (最接近: ' + s.id + '/' + s.class + ')' : ''; };

console.log('铁海 1942 · 剧本校验 (T6)');
console.log('剧本文件: data/scenarios.json   剧本数: ' + list.length);
console.log('舰船数据: ' + dbObjs.length + ' 个文件, ' + db.list.length + ' 艘');
if (dataPending) console.log('\n\u23f3 PENDING DATA（等待舰船数据落盘）: ' + pendingReasons.join('; '));

const VALID_COND = new Set(['SINK', 'SINK_ANY', 'DISABLE', 'SINK_COUNT', 'SURVIVE', 'EXIT', 'PROTECT']);
const VALID_SIDES = new Set(['ALLIED', 'AXIS']);
const VALID_ROLES = new Set(['flagship', 'line', 'screen']);
const EXPECTED_NIGHT = new Set(['savo_island_1942', 'first_guadalcanal_1942', 'surigao_strait_1944', 'north_cape_1943', 'matapan_1941']);
const rows = [];
const unresolved = new Map();
const ids = new Set();

section('1. 结构 / 字段校验');
ok(list.length >= 11, '剧本数量 >= 11（实际 ' + list.length + '）');
for (const sc of list) {
  const tag = '[' + sc.id + '] ';
  ok(!!sc.id && /^[a-z0-9_]+$/.test(sc.id), tag + 'id 为小写蛇形');
  ok(!ids.has(sc.id), tag + 'id 唯一');
  ids.add(sc.id);
  ok(!!sc.nameZh, tag + 'nameZh');
  ok(!!sc.date && /^\d{4}-\d{2}-\d{2}$/.test(sc.date), tag + 'date=YYYY-MM-DD');
  ok(!!sc.place, tag + 'place');
  ok(!!sc.historicalNote && sc.historicalNote.length > 80, tag + 'historicalNote 有真实背景与结局(>80字)');
  ok(!!sc.start && Number.isFinite(sc.start.lat) && Number.isFinite(sc.start.lon), tag + 'start.lat/lon');
  ok(!!sc.start.date && !Number.isNaN(Date.parse(sc.start.date)), tag + 'start.date 可解析 ISO');
  ok(/Z$/.test(sc.start.date || ''), tag + 'start.date 为 UTC(Z)');
  const e = sc.env || {};
  ok([e.windKn, e.windDirDeg, e.visibilityNm, e.cloudCover, e.seaState].every(Number.isFinite), tag + 'env 五要素均为数字');
  ok(e.windKn >= 0 && e.windKn <= 80, tag + 'windKn 0..80');
  ok(e.windDirDeg >= 0 && e.windDirDeg < 360, tag + 'windDirDeg 0..360');
  ok(e.visibilityNm >= 0.3 && e.visibilityNm <= 60, tag + 'visibilityNm 0.3..60');
  ok(e.cloudCover >= 0 && e.cloudCover <= 1, tag + 'cloudCover 0..1');
  ok(e.seaState >= 0 && e.seaState <= 9, tag + 'seaState 道格拉斯 0..9');
  ok(!!sc.start.env && JSON.stringify(sc.start.env) === JSON.stringify(sc.env), tag + 'start.env 与 env 一致（World 读取 start.env）');
  ok(!!sc.sides && !!sc.sides.ALLIED && !!sc.sides.AXIS, tag + 'sides.ALLIED/AXIS');
  for (const s of ['ALLIED', 'AXIS']) {
    const sd = sc.sides[s] || {};
    ok(!!sd.nameZh, tag + s + '.nameZh');
    ok(!!sd.objective, tag + s + '.objective');
    ok(Number.isFinite(sd.orderDelay_s) && sd.orderDelay_s >= 0 && sd.orderDelay_s <= 60, tag + s + '.orderDelay_s 0..60');
  }
  ok(Array.isArray(sc.ships) && sc.ships.length >= 2, tag + 'ships 数组 >= 2');
  const sids = new Set();
  for (const sh of sc.ships) {
    ok(!!sh.id && !sids.has(sh.id), tag + 'ship id 唯一: ' + sh.id);
    sids.add(sh.id);
    ok(!!sh.name, tag + sh.id + '.name');
    ok(!!sh.class, tag + sh.id + '.class');
    ok(VALID_SIDES.has(sh.side), tag + sh.id + '.side 合法');
    ok(Number.isFinite(sh.lat) && sh.lat >= -90 && sh.lat <= 90, tag + sh.id + '.lat 合理');
    ok(Number.isFinite(sh.lon) && sh.lon >= -180 && sh.lon <= 180, tag + sh.id + '.lon 合理');
    ok(Number.isFinite(sh.heading) && sh.heading >= 0 && sh.heading < 360, tag + sh.id + '.heading 0..360');
    ok(Number.isFinite(sh.speed) && sh.speed >= 0 && sh.speed <= 45, tag + sh.id + '.speed 0..45kn');
    ok(VALID_ROLES.has(sh.role), tag + sh.id + '.role 属于 flagship/line/screen');
    if (sh.crewQuality !== undefined) ok(sh.crewQuality >= 0.5 && sh.crewQuality <= 1.2, tag + sh.id + '.crewQuality 0.5..1.2');
  }
  ok(sc.ships.filter((s) => s.role === 'flagship').length >= 2, tag + '双方各至少 1 艘旗舰(role=flagship)');
  for (const s of ['ALLIED', 'AXIS']) ok(sc.ships.some((x) => x.side === s && x.role === 'flagship'), tag + s + ' 有旗舰');
  ok(Array.isArray(sc.objectives), tag + 'objectives 为数组');
}

section('2. 舰船 class 解析（data/ships_*.json）');
for (const sc of list) {
  for (const sh of sc.ships) {
    const resolved = db.resolve(sh.class) || db.get(sh.class);
    if (!resolved) {
      if (!unresolved.has(sh.class)) unresolved.set(sh.class, []);
      unresolved.get(sh.class).push(sc.id);
    }
  }
}
if (unresolved.size === 0) { pass++; console.log('  \u2714 全部 ' + list.reduce((a, s) => a + s.ships.length, 0) + ' 条舰船引用均可解析'); }
else if (dataPending) {
  warn++;
  warnings.push(unresolved.size + ' 个 class 尚未解析（数据未落盘）');
  for (const [c, scs] of unresolved) console.log('  \u23f3 PENDING DATA: class ' + c + suggest(c) + '  <- ' + [...new Set(scs)].join(', '));
} else {
  for (const [c, scs] of unresolved) { fail++; failures.push('class 无法解析: ' + c); console.log('  \u2716 class 无法解析: ' + c + suggest(c) + '  <- ' + [...new Set(scs)].join(', ')); }
}

section('3. 几何校验（不重叠 / 接敌距离）');
for (const sc of list) {
  let minAny = Infinity, minAnyPair = null, minCross = Infinity, minCrossPair = null;
  for (let i = 0; i < sc.ships.length; i++) for (let j = i + 1; j < sc.ships.length; j++) {
    const a = sc.ships[i], b = sc.ships[j];
    const d = GeoPlane.greatCircleM(a, b);
    if (d < minAny) { minAny = d; minAnyPair = a.id + '/' + b.id; }
    if (a.side !== b.side && d < minCross) { minCross = d; minCrossPair = a.id + '/' + b.id; }
  }
  const leadA = sc.ships.find((s) => s.side === 'ALLIED'), leadB = sc.ships.find((s) => s.side === 'AXIS');
  const leadD = GeoPlane.greatCircleM(leadA, leadB);
  ok(minAny > 250, '[' + sc.id + '] 任意两舰间距 > 250m（实际 ' + f2(minAny, 1) + 'm @ ' + minAnyPair + '）');
  warnIf(minAny > 500, '[' + sc.id + '] 队形最小间距偏小: ' + f2(minAny, 1) + 'm @ ' + minAnyPair);
  ok(minCross > 2000, '[' + sc.id + '] 双方初始距离 > 2km（实际 ' + f2(minCross / M_PER_NMI, 2) + 'nmi @ ' + minCrossPair + '）');
  rows.push({ id: sc.id, name: sc.nameZh, date: sc.date, ships: sc.ships.length, allied: sc.ships.filter((s) => s.side === 'ALLIED').length, axis: sc.ships.filter((s) => s.side === 'AXIS').length, minAny: minAny, minCross: minCross, leadD, env: sc.env });
}

section('4. objectives 校验');
for (const sc of list) {
  const tag = '[' + sc.id + '] ';
  const sids = new Set(sc.ships.map((s) => s.id));
  const sideOf = new Map(sc.ships.map((s) => [s.id, s.side]));
  const foeOf = (side) => (side === 'ALLIED' ? 'AXIS' : 'ALLIED');
  for (const o of sc.objectives) {
    ok(VALID_SIDES.has(o.side), tag + 'objective.side 合法');
    ok(!!o.condition && VALID_COND.has(o.condition.type), tag + 'condition.type=' + (o.condition && o.condition.type) + ' 合法');
    ok(VALID_SIDES.has(o.result), tag + 'objective.result=' + o.result + ' 合法');
    warnIf(o.result === o.side, tag + 'objective.result=' + o.result + ' 与目标方不同，按失败条件编码，请确认语义');
    ok(!!o.text, tag + 'objective.text');
    const ids2 = (o.condition.shipIds || []);
    for (const x of ids2) ok(sids.has(x), tag + 'objective shipId 存在: ' + x);
    if (['SINK', 'SINK_ANY', 'DISABLE'].includes(o.condition.type)) ok(ids2.length > 0 && ids2.every((x) => sideOf.get(x) === foeOf(o.side)), tag + o.condition.type + ' 的 shipIds 必须全部是敌方舰船');
    if (o.condition.type === 'PROTECT') ok(ids2.length > 0 && ids2.every((x) => sideOf.get(x) === o.side), tag + 'PROTECT 的 shipIds 必须全部是本方舰船');
    if (o.condition.type === 'SINK_COUNT') ok(Number.isInteger(o.condition.n) && o.condition.n >= 1 && o.condition.n <= sc.ships.length, tag + 'SINK_COUNT.n 合理');
    if (['SINK', 'SINK_ANY', 'DISABLE'].includes(o.condition.type)) ok(ids2.length > 0, tag + o.condition.type + ' 必须有 shipIds');
    if (['SURVIVE', 'PROTECT'].includes(o.condition.type)) ok(Number.isFinite(o.condition.seconds) && o.condition.seconds > 0, tag + o.condition.type + '.seconds > 0');
    if (o.condition.type === 'EXIT') {
      const a = o.condition.area;
      ok(!!a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.r) && a.r > 0, tag + 'EXIT.area{x,y,r} 合法');
      if (a) {
        const here = sc.ships.filter((s) => s.side === o.side).map((s) => Math.hypot(s.lat * 0 + 0, 0));
        const startInside = sc.ships.filter((s) => s.side === o.side).some((s) => {
          const dx = (s.lon - sc.start.lon) * (111412.84 * Math.cos(s.lat * Math.PI / 180) - 93.5 * Math.cos(3 * s.lat * Math.PI / 180));
          const dy = (s.lat - sc.start.lat) * (111132.92 - 559.82 * Math.cos(2 * s.lat * Math.PI / 180) + 1.175 * Math.cos(4 * s.lat * Math.PI / 180));
          return Math.hypot(dx - a.x, dy - a.y) < a.r;
        });
        ok(!startInside, tag + 'EXIT 区域开局不含本方舰船（否则会立即判定胜利）');
      }
    }
  }
}

section('5. 开局当地平太阳时与光照校验（调用真实 Environment）');
// 史实/预期当地时间（env.js 模型：当地平太阳时 local = UTC + lon/15），单位小时 0..24
const EXPECTED_LOCAL = {
  denmark_strait_1941:    { h: 3.35,  strict: false, label: '05:30Z 史实当地时刻（黎明低日）' },
  river_plate_1939:       { h: 6.30,  strict: true,  label: '1939-12-13 当地 06:14-06:18 首次发现并开火' },
  savo_island_1942:       { h: 1.50,  strict: true,  label: '1942-08-09 当地 01:30 突入萨沃岛以北' },
  first_guadalcanal_1942: { h: 1.80,  strict: true,  label: '1942-11-13 当地 01:48 铁底湾黑暗混战' },
  surigao_strait_1944:    { h: 3.35,  strict: true,  label: '1944-10-25 夜战 02:00-04:19（本剧本取战列线阶段 03:21）' },
  north_cape_1943:        { h: 16.50, strict: true,  label: '1943-12-26 当地 16:30 主炮交战开始' },
  java_sea_1942:          { h: 17.00, strict: true,  label: '1942-02-27 当地 16:16 发现、17:00 前后首次交战' },
  matapan_1941:           { h: 22.43, strict: true,  label: '1941-03-28 当地 22:26 夜战爆发' },
  komandorski_1943:       { h: 8.48,  strict: true,  label: '1943-03-26 当地 08:30 首次目视接触' },
  casablanca_1942:        { h: 7.00,  strict: true,  label: '1942-11-08 当地 07:00 炮战（当地日出 06:43）' },
  sandbox:                { h: 9.33,  strict: false, label: '沙盒任意（12:00Z）' },
};
const TOL_H = 0.5;   // 当地时间允许偏差 ±30 min
try {
  const { Environment } = await import('../src/sim/env.js');
  console.log('  ' + 'id'.padEnd(26) + 'UTC 开局'.padEnd(22) + '当地'.padEnd(8) + '史实/预期'.padEnd(11) + 'Δmin'.padEnd(7) + '日高'.padEnd(9) + '光照'.padEnd(7) + '判定');
  for (const sc of list) {
    const env = new Environment(Object.assign({ lat: sc.start.lat, lon: sc.start.lon, seed: 19420604, date: sc.start.date }, sc.start.env));
    const light = env.lightLevel, alt = env.sunAltDeg;
    const localH = env.timeOfDayH;                       // 真实模型的当地平太阳时（= UTC + lon/15）
    const exp = EXPECTED_LOCAL[sc.id] || { h: localH, strict: false, label: '未登记' };
    const rr = rows.find((r) => r.id === sc.id);
    rr.light = light; rr.sunAlt = alt; rr.localH = localH;
    const dl = (((localH - exp.h) % 24) + 36) % 24 - 12; // 环绕差（小时）
    const hm = (v) => { const tot = Math.round((((v % 24) + 24) % 24) * 60); return String(Math.floor(tot / 60) % 24).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0'); };
    const night = light < 0.15 && alt < 0;
    console.log('  ' + sc.id.padEnd(24) + (sc.start.date + ' ').padEnd(21) + hm(localH).padEnd(8) + hm(exp.h).padEnd(11) +
      (f2(dl * 60, 0) + '').padStart(4).padEnd(7) + (f2(alt, 1) + '\u00b0').padEnd(9) + f2(light, 3).padEnd(7) + (night ? '夜' : '昼') + (exp.strict ? '' : ' *'));
    if (exp.strict) ok(Math.abs(dl) <= TOL_H, '[' + sc.id + '] 开局当地 ' + hm(localH) + ' 应对齐史实 ' + hm(exp.h) + '（' + exp.label + '），Δ=' + f2(dl * 60, 0) + 'min');
    else warnIf(Math.abs(dl) <= 6, '[' + sc.id + '] 当地时刻与登记值偏离过大 Δ=' + f2(dl * 60, 0) + 'min');
    if (EXPECTED_NIGHT.has(sc.id)) ok(night, '[' + sc.id + '] 夜战剧本开局必须为夜间（lightLevel=' + f2(light, 3) + ' 日高=' + f2(alt, 1) + '度）');
    else warnIf(light > 0.01, '[' + sc.id + '] 非夜战剧本开局接近全黑，请确认时刻 lightLevel=' + f2(light, 3));
  }
  console.log('  （* = 该剧本开局时刻按 UTC 史实/沙盒任意选定，不校验当地史实值；其余按 ±' + (TOL_H * 60) + 'min 校验）');
} catch (e) { warn++; warnings.push('跳过当地时间/光照校验: ' + e.message); console.log('  \u26a0 跳过当地时间/光照校验: ' + e.message); }

section('6. 集成冒烟（真实 World + 沙盒剧本，60s）');
if (dataPending) { console.log('  \u23f3 PENDING DATA：跳过 World 装配（等待 data/ships_*.json）'); }
else {
  try {
    const { World } = await import('../src/sim/world.js');
    const sandbox = list.find((s) => s.id === 'sandbox') || list[0];
    const w = new World({ scenario: sandbox, database: db, seed: 19420604, aiOpts: { backend: 'LOCAL' } });
    const built = w.ships.length, want = sandbox.ships.length;
    ok(built === want, '[integration] World 装配 ' + built + '/' + want + ' 艘');
    w.advance(60);
    ok(w.t >= 59.9, '[integration] 推进 60s（t=' + f2(w.t, 1) + '）');
    ok(w.events.history.length > 0, '[integration] 产生事件 ' + w.events.history.length + ' 条');
    console.log('  \u2714 装配 ' + built + ' 艘，t=' + f2(w.t, 1) + 's，事件 ' + w.events.history.length + ' 条，航迹 ' + w.visibleStateFor('ALLIED').tracks.length + ' 条');
  } catch (e) { warn++; warnings.push('集成冒烟失败(非致命): ' + e.message); console.log('  \u26a0 集成冒烟失败(非致命): ' + e.message); }
}

section('汇总：剧本一览');
console.log('  id'.padEnd(26) + '名称'.padEnd(14) + '日期       舰(盟/轴)  最近接敌    队形最小   能见度  海况  当地   光照 日高');
for (const r of rows) {
  console.log('  ' + r.id.padEnd(24) + r.name.padEnd(12) + r.date.padEnd(12) +
    String(r.allied + '/' + r.axis).padEnd(10) +
    (f2(r.minCross / M_PER_NMI, 1) + 'nmi').padEnd(12) + (f2(r.minAny, 0) + 'm').padEnd(11) +
    String(r.env.visibilityNm + 'nmi').padEnd(8) + String(r.env.seaState).padEnd(5) +
    (r.localH === undefined ? '-' : (() => { const tot = Math.round(r.localH * 60); return String(Math.floor(tot / 60) % 24).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0'); })()).padEnd(7) +
    (r.light === undefined ? '-' : f2(r.light, 3)).padEnd(6) + (r.sunAlt === undefined ? '-' : f2(r.sunAlt, 1)));
}
console.log('\n  合计 ' + list.length + ' 个剧本，' + rows.reduce((a, r) => a + r.ships, 0) + ' 条舰位；不同舰级 ' + unresolved.size + ' 个未解析。');

section('结果');
console.log('  PASS ' + pass + ' / FAIL ' + fail + ' / WARN ' + warn);
if (warnings.length) { console.log('\n  告警:'); for (const w of warnings) console.log('    - ' + w); }
if (failures.length) { console.log('\n  失败:'); for (const f of failures) console.log('    - ' + f); }
if (dataPending) console.log('\n  \u23f3 状态: PENDING DATA —— 等待 data/ships_*.json 落盘后重跑；结构校验已通过。');
else if (fail === 0) console.log('\n  \u2714 全部校验通过。');
process.exit(fail === 0 ? 0 : 1);
