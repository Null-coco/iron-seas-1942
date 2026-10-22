// test/t13.terrain.test.mjs — 【A1】陆地遮蔽：视线（vision）与弹道（ballistics）
// 运行：/Users/zl/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node test/t13.terrain.test.mjs
//
// 覆盖：
//   1) 视线：观察者与目标之间隔一座岛 → 不发现、无 sensor.detect；
//      同几何无陆地（land 为空）→ 正常目视发现（对照）。
//   2) 已发现后目标转入岛后 → emit sensor.visual.blocked{blockedByLand:true}，
//      航迹无新观测 → 由 tracks 的失跟计时 emit sensor.lose。
//   3) 弹道：向岛屿对侧开火（弹丸落在岛上）→ emit gun.terrain，不产生 gun.hit / gun.nearmiss，
//      目标 stats.hitsTaken 不增加；无陆地对照 → 同一发炮弹变成 water splash（gun.miss）。
//   4) 水线以下落入陆地：同样按陆地弹着终止（不穿过陆地命中舰体）。
// 陆地来自 data/land.json 的 savo_island_1942（247 个环，萨沃岛/佛罗里达群岛一带真实岸线）。
// 注意：本测试只移动/停船，不起 AI（ai:false），并关闭雷达/声呐，只留目视与弹道，隔离验证。
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { landBlocksLOS, visualDetection } from '../src/sim/vision.js';
import { makeShell, solutionForRange, spawnProjectile, updateProjectiles } from '../src/sim/ballistics.js';

const j = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const db = ShipDatabase.fromMany([j('../data/ships_axis.json'), j('../data/ships_allied.json')]);
const landData = j('../data/land.json');

// ─────────────────────────────────────────────────────────────────────────────
let failures = 0;
function ok(cond, msg, extra) {
  if (cond) console.log('  ✓ ' + msg + (extra === undefined ? '' : '（' + extra + '）'));
  else { failures++; console.log('  ✗ FAIL: ' + msg + (extra === undefined ? '' : '（' + extra + '）')); }
}
function near(v, a, b) { return Number.isFinite(v) && v >= a && v <= b; }
function fmt(v, d = 0) { return Number.isFinite(v) ? v.toFixed(d) : String(v); }
function section(s) { console.log('\n' + s); }

// ── 萨沃岛剧本里的真实小岛（data/land.json: scenarios.savo_island_1942 第 2 环）──
// bbox x[15570,17030] y[57649,58995]，中心 (16300,58322)，世界米制坐标（原点 = 剧本 start.lat/lon）。
const ISLAND = { x: 16300, y: 58322 };
const OBSERVER_POS = { x: 16300, y: 61822 };  // 岛北 3.5 km 水面
const TARGET_BLOCKED_POS = { x: 16300, y: 53322 }; // 岛南 5.0 km 水面（连线穿过岛心，LOS 8.5 km）

// 自定义剧本：id 必须保持 savo_island_1942，World 才能按 id 取到 data/land.json 的岸线。
// 日期换成本地白天（史实开局是 01:50 夜战，目视看不见会掩盖"陆地遮蔽"），能见度 20 nmi。
function makeScenario() {
  return {
    id: 'savo_island_1942',
    nameZh: '陆地遮蔽探针（萨沃岛）',
    start: {
      lat: -9.1, lon: 159.72, date: '1942-08-07T02:30:00Z',
      env: { windKn: 4, windDirDeg: 160, visibilityNm: 20, cloudCover: 0.2, seaState: 2 },
    },
    sides: { ALLIED: { nameZh: '同盟国' }, AXIS: { nameZh: '轴心国' } },
    ships: [
      { id: 'obs', name: '观察舰', class: 'Takao', side: 'AXIS', x: OBSERVER_POS.x, y: OBSERVER_POS.y, heading: 180, speed: 0 },
      { id: 'tgt', name: '目标舰', class: 'Northampton', side: 'ALLIED', x: TARGET_BLOCKED_POS.x, y: TARGET_BLOCKED_POS.y, heading: 0, speed: 0 },
    ],
    objectives: [],
  };
}

// withLand=false 时 World 得到空 Land（与"现在"的 land 全空行为一致）。
function makeWorld({ withLand = true, seed = 20240808 } = {}) {
  const w = new World({ scenario: makeScenario(), database: db, seed, playerSide: 'ALLIED', ai: false, landData: withLand ? landData : null });
  for (const s of w.ships) {
    s.speed = 0;
    // 隔离：关掉雷达/声呐/水听器，只留目视瞭望（雷达的陆地遮蔽是既有实现，不在本测试范围）
    for (const sen of s.sensors) sen.on = false;
  }
  return w;
}

function advance(w, seconds) { w.advance(seconds); return w; }

function detectionsBy(w, shipId) {
  return w.events.history.filter((e) => e.type === 'sensor.detect' && e.by === shipId);
}

// 固定弹道参数开一发（无散布），推进到弹丸消失，返回事件统计
function fireOnce(world, { shipId, bearingDeg, rangeM, ammo = 'AP', targetShipId = null }) {
  const ship = world.ship(shipId);
  const battery = (ship.mainBatteries && ship.mainBatteries[0]) || ship.batteries[0];
  const shell = makeShell(ship, battery, ammo);
  const sol = solutionForRange(shell, rangeM);
  spawnProjectile(world, {
    ship, battery, shell, ammo,
    elevDeg: sol.elevDeg, bearingDeg, rangeM,
    dispersionMil: 0, predictedTofS: sol.tofS,
    trackId: 'T-test', targetShipId,
  });
  let guard = 0;
  while (world.projectiles.length && guard++ < 3000) { world.t += 0.1; updateProjectiles(world, 0.1); }
  return sol;
}

function gunEvents(world) {
  const pick = (t) => world.events.history.filter((e) => e.type === t);
  return {
    terrain: pick('gun.terrain'), hit: pick('gun.hit'), nearMiss: pick('gun.nearmiss'), miss: pick('gun.miss'),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
section('0. 数据与几何自检（萨沃岛真实岸线）');
// ═════════════════════════════════════════════════════════════════════════════
const wLand = makeWorld({ withLand: true });
const wOpen = makeWorld({ withLand: false });
const land = wLand.land;
ok(!!land && land.empty === false, 'savo_island_1942 的 Land 非空', 'rings=' + (land && land.rings ? land.rings.length : 0));
ok(!!wOpen.land && wOpen.land.empty === true, '无 landData 时 Land 为空（对照组）');
ok(!land.isLandExact(OBSERVER_POS.x, OBSERVER_POS.y) && !land.isLandExact(TARGET_BLOCKED_POS.x, TARGET_BLOCKED_POS.y),
  '观察者 / 目标位置都在水域');
ok(land.isLandExact(ISLAND.x, ISLAND.y), '岛屿中心点判定为陆地');
ok(landBlocksLOS(land, OBSERVER_POS, TARGET_BLOCKED_POS) === true,
  'landBlocksLOS(观察者→目标) = true（连线穿过岛屿）');
ok(landBlocksLOS(land, OBSERVER_POS, { x: OBSERVER_POS.x + 4000, y: OBSERVER_POS.y }) === false,
  '开阔水域的视线不被遮挡（landBlocksLOS = false）');
const dLOS = Math.hypot(TARGET_BLOCKED_POS.x - OBSERVER_POS.x, TARGET_BLOCKED_POS.y - OBSERVER_POS.y);
ok(near(dLOS, 8400, 8600), '观察者-目标距离 8.5 km（岛在正中）', fmt(dLOS) + ' m');

// ═════════════════════════════════════════════════════════════════════════════
section('1. 视线被岛屿截断 → 不发现；无岛对照 → 发现');
// ═════════════════════════════════════════════════════════════════════════════
const obs = wLand.ship('obs');
const tgt = wLand.ship('tgt');
const detBlocked = visualDetection(obs, tgt, wLand.env, land);   // 显式传 Land，不依赖帧内登记
ok(detBlocked.blockedByLand === true, 'visualDetection().blockedByLand = true');
ok(detBlocked.detected === false, '被陆地遮挡时 detected = false');
ok(detBlocked.detectionRangeM === 0, '被陆地遮挡时 detectionRangeM = 0（完全不可见）');
ok(detBlocked.rangeM === dLOS, '仍给出几何距离（供诊断/事件用）', fmt(detBlocked.rangeM) + ' m');

// 真实管线（World.step → updateSensors → processVisualWatch）跑 24 s（目视周期 2.2 s，约 10 次扫描）
advance(wLand, 24);
const detBlockedPipeline = detectionsBy(wLand, 'obs');
ok(detBlockedPipeline.length === 0, '有岛：24 s 内观察者没有任何 sensor.detect', 'detect=' + detBlockedPipeline.length);
const blockedEvents = wLand.events.history.filter((e) => e.type === 'sensor.visual.blocked');
ok(blockedEvents.length >= 1, '有岛：emit sensor.visual.blocked（边沿触发）', 'n=' + blockedEvents.length);
const be = blockedEvents.find((e) => e.ship === 'obs' && e.target === 'tgt');
ok(!!be && be.blockedByLand === true && be.source === 'VISUAL', 'blocked 事件带 blockedByLand:true / source=VISUAL');
ok(!!be && near(be.rangeM, 8400, 8600), 'blocked 事件含被遮挡时的距离', be ? be.rangeM + ' m' : 'none');

// 对照组：同一几何、同一个种子，只是没有陆地
const detOpen = visualDetection(wOpen.ship('obs'), wOpen.ship('tgt'), wOpen.env);
ok(detOpen.detected === true && detOpen.blockedByLand === false, '无岛：visualDetection().detected = true, blockedByLand = false',
  'detectionRangeM=' + fmt(detOpen.detectionRangeM) + ' m');
advance(wOpen, 24);
const detOpenPipeline = detectionsBy(wOpen, 'obs');
ok(detOpenPipeline.length >= 1, '无岛：24 s 内观察者目视发现目标（sensor.detect）', 'n=' + detOpenPipeline.length);
ok(wOpen.events.history.filter((e) => e.type === 'sensor.visual.blocked').length === 0, '无岛：不产生 blocked 事件');
// land 为空时 visualDetection 的输出与旧实现一致（关键字段）
const detOldStyle = visualDetection(wOpen.ship('obs'), wOpen.ship('tgt'), wOpen.env);
ok(detOldStyle.detected === true && Math.abs(detOldStyle.rangeM - dLOS) < 1 && near(detOldStyle.detectionRangeM, 20000, 40000),
  'land 为空：与旧实现一致（detected/rangeM/detectionRangeM 均为正常值）');

// ═════════════════════════════════════════════════════════════════════════════
section('2. 已发现后目标转入岛后 → sensor.visual.blocked + 航迹失跟（sensor.lose）');
// ═════════════════════════════════════════════════════════════════════════════
{
  const w = makeWorld({ withLand: true });
  const o = w.ship('obs'), t = w.ship('tgt');
  // 先找一处"观察者→目标"视线通畅的水域（岛北侧的清水面），保证先建立航迹
  let clearPos = null;
  for (let dx = -9000; dx <= 9000 && !clearPos; dx += 1000) {
    for (let dy = -9000; dy <= 9000; dy += 1000) {
      const p = { x: OBSERVER_POS.x + dx, y: OBSERVER_POS.y + dy };
      const d = Math.hypot(dx, dy);
      if (d < 6000 || d > 12000) continue;
      if (w.land.isLandExact(p.x, p.y)) continue;
      if (w.land.distanceToLand(p.x, p.y, 2000) < 600) continue;
      if (landBlocksLOS(w.land, OBSERVER_POS, p)) continue;
      clearPos = p;
      break;
    }
  }
  ok(!!clearPos, '找到岛北侧视线通畅的水域目标位置', clearPos ? '(' + Math.round(clearPos.x) + ',' + Math.round(clearPos.y) + ')' : 'none');
  t.pos = { x: clearPos.x, y: clearPos.y };
  const det0 = visualDetection(o, t, w.env, w.land);
  ok(det0.detected === true && det0.blockedByLand === false, '移入通畅水域后目视可发现');
  advance(w, 24);
  const detEvents = detectionsBy(w, 'obs');
  ok(detEvents.length >= 1, '先建立目视航迹（sensor.detect）', 'n=' + detEvents.length);
  const trackId = detEvents.length ? detEvents[0].target : null;
  const blockedBefore = w.events.history.filter((e) => e.type === 'sensor.visual.blocked').length;
  ok(blockedBefore === 0, '转入岛后之前没有 blocked 事件');

  // 目标驶入岛后（视线穿过岛屿）
  t.pos = { x: TARGET_BLOCKED_POS.x, y: TARGET_BLOCKED_POS.y };
  advance(w, 70);   // 失跟阈值 35 s，留足余量
  const blockedAfter = w.events.history.filter((e) => e.type === 'sensor.visual.blocked');
  ok(blockedAfter.length >= 1, '转入岛后 → emit sensor.visual.blocked', 'n=' + blockedAfter.length);
  const loses = w.events.history.filter((e) => e.type === 'sensor.lose' && e.by === 'obs');
  ok(loses.length >= 1, '航迹无新观测 → emit sensor.lose（tracks 失跟）', 'n=' + loses.length);
  const lose = loses.find((e) => !trackId || e.target === trackId) || loses[0];
  ok(!!lose && lose.ageS >= 35, '失跟年龄 ≥ 35 s', lose ? 'ageS=' + lose.ageS : 'none');
  ok(detectionsBy(w, 'obs').filter((e) => e.t > 25).length === 0, '进入岛后不再有新的 sensor.detect');
}

// ═════════════════════════════════════════════════════════════════════════════
section('3. 弹道：向岛屿对侧开火，弹丸落岛 → gun.terrain，不伤舰');
// ═════════════════════════════════════════════════════════════════════════════
{
  const wi = makeWorld({ withLand: true });
  const target = wi.ship('tgt');
  const hitsBefore = target.stats.hitsTaken;
  // 观察舰在岛北 3.5 km，朝正南（岛屿对侧目标方向）开火，仰角按"到岛心 3.5 km"装定：
  // 炮弹会落在岛上（而不是飞过岛去打对侧的船）——正是"落陆不伤舰"的判定点。
  const sol = fireOnce(wi, { shipId: 'obs', bearingDeg: 180, rangeM: 3500, targetShipId: 'tgt' });
  const gi = gunEvents(wi);
  console.log('  装定：仰角 ' + fmt(sol.elevDeg, 2) + '°，飞行 ' + fmt(sol.tofS, 1) + ' s；事件 gun.terrain=' + gi.terrain.length +
    ' gun.miss=' + gi.miss.length + ' gun.hit=' + gi.hit.length + ' gun.nearmiss=' + gi.nearMiss.length);
  ok(gi.terrain.length === 1, '落岛 → 恰好 1 条 gun.terrain 事件', 'n=' + gi.terrain.length);
  const te = gi.terrain[0] || {};
  ok(te.hitTerrain === true && te.ammo === 'AP', 'gun.terrain 带 hitTerrain:true / ammo');
  ok(wi.land.isLandExact(te.x, te.y) === true, '弹着点确实在陆地上', '(' + fmt(te.x) + ',' + fmt(te.y) + ')');
  ok(te.targetShipId === 'tgt', 'gun.terrain 保留 targetShipId（可归因到这次射击任务）');
  ok(gi.hit.length === 0, '没有 gun.hit（不调用 applyShipHit）', 'n=' + gi.hit.length);
  ok(gi.nearMiss.length === 0, '没有 gun.nearmiss（落陆不产生水中近失）', 'n=' + gi.nearMiss.length);
  ok(target.stats.hitsTaken === hitsBefore, '目标 hitsTaken 不增加', hitsBefore + ' → ' + target.stats.hitsTaken);
  ok(wi.splashes.length === 0, '落陆不生成水中水柱（splashes 为空）', 'n=' + wi.splashes.length);
  ok(wi.projectiles.length === 0, '弹丸终止（不再推进）');
  // 舰体无损：目标所有 compartment 完好
  ok((target.compartments || []).every((c) => (c.flood_m3 || 0) === 0 && (c.fire || 0) === 0), '目标舱室无进水/火灾');
}

// ═════════════════════════════════════════════════════════════════════════════
section('4. 无陆地对照：同一发炮弹落水 → gun.miss（行为与现在一致）');
// ═════════════════════════════════════════════════════════════════════════════
{
  const wo = makeWorld({ withLand: false });
  const target = wo.ship('tgt');
  const hitsBefore = target.stats.hitsTaken;
  const sol = fireOnce(wo, { shipId: 'obs', bearingDeg: 180, rangeM: 3500, targetShipId: 'tgt' });
  const go = gunEvents(wo);
  console.log('  装定：仰角 ' + fmt(sol.elevDeg, 2) + '°；事件 gun.terrain=' + go.terrain.length +
    ' gun.miss=' + go.miss.length + ' gun.hit=' + go.hit.length);
  ok(go.terrain.length === 0, '无陆地：不产生 gun.terrain');
  ok(go.miss.length === 1, '无陆地：同一发炮弹照旧落水（gun.miss）', 'n=' + go.miss.length);
  ok(go.hit.length === 0 && target.stats.hitsTaken === hitsBefore, '无陆地：落水点离目标 5 km，不命中/不受伤');
  ok(wo.splashes.length === 1, '无陆地：生成 1 个水柱', 'n=' + wo.splashes.length);
}

// ═════════════════════════════════════════════════════════════════════════════
section('5. 水线以下落入陆地：同样按陆地弹着终止（不穿过陆地）');
// ═════════════════════════════════════════════════════════════════════════════
{
  const ww = makeWorld({ withLand: true });
  const target = ww.ship('tgt');
  const ship = ww.ship('obs');
  const battery = (ship.mainBatteries && ship.mainBatteries[0]) || ship.batteries[0];
  const shell = makeShell(ship, battery, 'AP');
  const p = spawnProjectile(ww, { ship, battery, shell, ammo: 'AP', elevDeg: 1, bearingDeg: 180, rangeM: 3000, dispersionMil: 0 });
  // 模拟"水线下/水下"弹丸：直接放在岛心水面下 2 m（跳弹/入水后穿行的位置）
  p.x = ISLAND.x; p.y = ISLAND.y; p.z = -2; p.vx = 120; p.vy = -300; p.vz = -8; p.underwater = false;
  const evBefore = gunEvents(ww);
  let guard = 0;
  while (ww.projectiles.length && guard++ < 500) { ww.t += 0.1; updateProjectiles(ww, 0.1); }
  const ev = gunEvents(ww);
  const newTerrain = ev.terrain.length - evBefore.terrain.length;
  ok(newTerrain === 1, '水线以下弹丸落入陆地 → emit gun.terrain', 'n=' + newTerrain);
  ok(ev.hit.length === evBefore.hit.length && ev.nearMiss.length === evBefore.nearMiss.length,
    '水线下落陆同样不产生 gun.hit / gun.nearmiss');
  ok(target.stats.hitsTaken === 0, '目标 hitsTaken 仍为 0');
}

// ═════════════════════════════════════════════════════════════════════════════
section('6. 性能护栏：陆地视线判定只在 <= 30 km 做（远距离直接跳过）');
// ═════════════════════════════════════════════════════════════════════════════
{
  const nearer = { x: ISLAND.x, y: ISLAND.y + 10000 };
  // 20 km 的线仍做判定（穿过岛屿）
  const blocked20 = landBlocksLOS(land, nearer, { x: ISLAND.x, y: ISLAND.y - 10000 });
  ok(blocked20 === true, '20 km 视线（穿过岛）仍判定为遮挡');
  // 40 km 的模拟长线：landBlocksLOS 默认跳过（性能红线），显式放宽才判定
  const skipped = landBlocksLOS(land, { x: ISLAND.x, y: ISLAND.y + 30000 }, { x: ISLAND.x, y: ISLAND.y - 11000 });
  ok(skipped === false, '>30 km 默认跳过陆地判定（不因长线采样拖慢目视）', 'len=41km');
  const forced = landBlocksLOS(land, { x: ISLAND.x, y: ISLAND.y + 30000 }, { x: ISLAND.x, y: ISLAND.y - 11000 }, { maxRangeM: 60000 });
  ok(forced === true, '显式 maxRangeM=60 km 时仍能判定遮挡（能力保留）');
  // 视觉检测同样遵守 30 km 护栏：31 km 时不做陆地判定（不会因为地形而误判"不可见"）
  const wFar = makeWorld({ withLand: true });
  const o = wFar.ship('obs'), t = wFar.ship('tgt');
  // 把目标放到岛南 27.5 km（总距离 31 km），连线穿过岛
  t.pos = { x: ISLAND.x, y: ISLAND.y - 27500 };
  const detFar = visualDetection(o, t, wFar.env, wFar.land);
  ok(detFar.blockedByLand === false, '31 km 外的目视不做陆地遮蔽（性能护栏）', 'range=' + fmt(detFar.rangeM) + ' m');
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n' + (failures === 0 ? '✅ T13 全部测试通过' : '❌ 失败 ' + failures + ' 项'));
if (failures > 0) process.exitCode = 1;
