// test/t14.friendlyfire.test.mjs —— 【A2】敌我识别不确定 + 友军误伤（萨沃岛式）
// 运行：node test/t14.friendlyfire.test.mjs
//
// 1942 年没有 IFF：雷达只能测距测向，只有目视可能分辨敌我。夜间混战里
// "把友舰当敌舰打"必须可能发生（萨沃岛的精髓），但白天/近距识别清楚时不得误伤。
//
// 覆盖：
//  1) 目视识别证据的量级（白天近距 ≫ 夜间远距；雷达/声呐零信息量、无 IFF）；
//  2) 同阵营"不明接触"进入航迹表的条件（白天不产生；夜间编队外可能产生，
//     且雷达航迹的 misId=FRIEND_AS_HOSTILE、foeConfidence≈0、idSource=RADAR）；
//  3) 夜战误伤全链路（固定 seed）：低质量目视 → misId=FRIEND_AS_HOSTILE →
//     FIRE → gun.friendlyfire（双方/距离/原因/是否沉没）→ 真打真伤 + 轻微扣士气；
//  4) 白天/近距高置信：友舰航迹被纠正为 hostile=false，开火被拒，绝不产生 friendlyfire；
//  5) 向后兼容：hostile 旧语义（不明=敌舰 / 显式 hostile=false）、view 字段齐全、LOCAL AI 不崩。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RNG } from '../src/core/rng.js';
import { EventBus } from '../src/core/events.js';
import { Ship } from '../src/sim/ship.js';
import { ShipDatabase } from '../src/sim/data.js';
import { World } from '../src/sim/world.js';
import { TrackManager, ownFleetKnownRangeM, ownContactUncertainAt } from '../src/sim/tracks.js';
import { updateSensors, visualIdentityEvidence } from '../src/sim/sensors.js';
import { dist2d } from '../src/core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS  ' + msg + (detail !== undefined ? '   ' + detail : '')); }
  else { fail++; failures.push(msg + (detail !== undefined ? ' | ' + detail : '')); console.log('  FAIL  ' + msg + (detail !== undefined ? '   ' + detail : '')); }
}
const f2 = (v) => Number(v).toFixed(2);
const line = (s) => console.log('\n' + s);

// ── 舰船数据库（与剧本同源；缺文件则整测试跳过，避免假绿）─────────────────
let db = null;
try {
  db = ShipDatabase.fromMany([
    JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ships_axis.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ships_allied.json'), 'utf8')),
  ]);
} catch (e) {
  console.log('PENDING DATA：缺少 data/ships_*.json，无法构建真实舰船：' + e.message);
  process.exit(0);
}
function shipOf(cls, side, id, spec = {}) {
  const data = db.resolve(cls);
  if (!data) throw new Error('未知舰级 ' + cls);
  return new Ship(Object.assign({ id, side, name: spec.name || id }, spec), data, {});
}
const NIGHT_DATE = '1942-08-08T02:00:00Z';   // 无月夜（lightLevel≈0.01）
const DAY_DATE = '1942-08-08T14:00:00Z';     // 白天（lightLevel≈0.85）

// ── 真实 World（最小剧本，AI 可关；用于误伤全链路与兼容性）─────────────────
function makeWorld(opts = {}) {
  const scenario = {
    id: 't14_friendlyfire', nameZh: 'T14 敌我识别',
    start: { lat: 0, lon: 0, date: opts.date || NIGHT_DATE,
      env: { windKn: 4, windDirDeg: 160, visibilityNm: opts.visibilityNm || 6, cloudCover: 0.9, seaState: 2 } },
    sides: { ALLIED: { nameZh: '盟军', objective: '测试', orderDelay_s: 1 },
             AXIS: { nameZh: '轴心', objective: '测试', orderDelay_s: 1 } },
    ships: opts.ships, objectives: [],
  };
  return new World({ scenario, database: db, seed: opts.seed === undefined ? 19420604 : opts.seed,
    playerSide: 'ALLIED', ai: opts.ai === true, aiOpts: opts.ai ? { backend: 'LOCAL' } : undefined });
}
function standardShips() {
  return [
    { id: 'sf', name: '旧金山', class: 'NewOrleans', side: 'ALLIED', x: 0, y: 0, heading: 0, speed: 12, role: 'flagship', crewQuality: 0.9 },
    { id: 'atl', name: '亚特兰大', class: 'Atlanta', side: 'ALLIED', x: 4000, y: 0, heading: 180, speed: 12, role: 'line', crewQuality: 0.8 },
    { id: 'dd', name: '巴格利', class: 'Bagley', side: 'ALLIED', x: 900, y: 0, heading: 0, speed: 12, role: 'screen', crewQuality: 0.8 },
    { id: 'jp1', name: '青叶', class: 'Aoba', side: 'AXIS', x: 16000, y: 6000, heading: 270, speed: 24, role: 'flagship', crewQuality: 1.1 },
  ];
}
function silenceShips(world) {
  // 受控实验：关掉舰载传感器，只喂"瞭望报告"；同时把目视能见度压到 0，
  // 让航迹只由测试注入的观测驱动（避免多舰混战时的航迹合并干扰断言）。
  for (const s of world.ships) for (const sn of (s.sensors || [])) sn.on = false;
  world.env.baseVisibilityNm = 0.2;
}
function feedLookout(world, quality, targetId = 'atl', shipId = 'sf') {
  const tgt = world.ship(targetId), obs = world.ship(shipId);
  const dx = tgt.pos.x - obs.pos.x, dy = tgt.pos.y - obs.pos.y;
  const R = Math.hypot(dx, dy);
  const B = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return world.tracks.observe({
    side: obs.side, srcKind: 'VISUAL', shipId: obs.id, targetId: tgt.id,
    pos: { x: tgt.pos.x + world.rng.normal(0, 60), y: tgt.pos.y + world.rng.normal(0, 60) },
    rangeM: R + world.rng.normal(0, 40), bearingDeg: (B + world.rng.normal(0, 0.4) + 360) % 360,
    accuracyM: 60, accuracyDeg: 0.4, t: world.t,
    identity: { src: 'VISUAL', quality },   // 目视识别质量：夜暗远距=0.05，白天近距=0.8
  });
}

// ── 传感器级最小世界（t2 风格）：只驱动指定舰的传感器，隔离其它舰 ───────────
function fakeEnv(cfg = {}) {
  const env = {
    lightLevel: cfg.light !== undefined ? cfg.light : 1,
    seaState: cfg.sea !== undefined ? cfg.sea : 2,
    visibilityNm: cfg.vis !== undefined ? cfg.vis : 20,
    windKn: 4, windDirDeg: 160, cloudCover: 0.5, swellHeightM: 0.5,
    rainFactor: 1, fogDensity: 0,
    smokeClouds: [], chaffClouds: [], squalls: [],
    illuminationFactor() { return env.lightLevel; },
    horizontalVisibilityNm() { return env.visibilityNm; },
    smokeDensityAt() { return 0; },
  };
  return env;
}
function sensorWorld(cfg) {
  const w = {
    t: 0, rng: new RNG(cfg.seed === undefined ? 7788 : cfg.seed),
    events: new EventBus(20000), env: fakeEnv(cfg), ships: [],
    reportDelayS: 5, radioRelayPenaltyS: 9,
  };
  w.tracks = new TrackManager(w);
  w.ship = (id) => w.ships.find((s) => s.id === id) || null;
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════
line('=== 1. 目视识别证据：只有目视有信息量（1942 无 IFF）===');
{
  const sf = shipOf('NewOrleans', 'ALLIED', 'sf', { x: 0, y: 0, heading: 0, speed: 10, crewQuality: 0.9 });
  const atl = shipOf('Atlanta', 'ALLIED', 'atl', { x: 3000, y: 0, heading: 180, speed: 10, crewQuality: 0.8 });
  const envDay = fakeEnv({ light: 1, sea: 2 });
  const envNight = fakeEnv({ light: 0.01, sea: 2 });
  const dayEv = visualIdentityEvidence(sf, atl, envDay, new RNG(1), { rangeM: 3000, features: { aspectDeg: 90 } });
  const nightEv = visualIdentityEvidence(sf, atl, envNight, new RNG(1), { rangeM: 5000, features: { aspectDeg: 90 } });
  console.log('  白天 3 km 目视质量=' + f2(dayEv.quality) + '（可辨认距离 ' + dayEv.recogRangeM + ' m，光照 ' + dayEv.lightLevel + '）');
  console.log('  夜暗 5 km 目视质量=' + f2(nightEv.quality) + '（可辨认距离 ' + nightEv.recogRangeM + ' m，光照 ' + nightEv.lightLevel + '）');
  ok(dayEv.quality > 0.5, '白天近距目视识别质量 > 0.5（能看清舰型/旗号）', f2(dayEv.quality));
  ok(nightEv.quality < 0.15, '夜暗远距目视识别质量 < 0.15（只看见影子）', f2(nightEv.quality));
  ok(dayEv.quality > nightEv.quality * 3, '白天识别质量至少是夜间的 3 倍（夜间难辨敌我）', f2(dayEv.quality / Math.max(1e-6, nightEv.quality)) + '×');
  ok(nightEv.iff === false && dayEv.iff === false, '识别证据明确标注 iff=false（1942 无 IFF）');
  ok(ownFleetKnownRangeM(0.01) < 3600 && ownFleetKnownRangeM(1) === 12000,
    '编队识别距离：无月夜≈' + Math.round(ownFleetKnownRangeM(0.01)) + ' m，白天=' + ownFleetKnownRangeM(1) + ' m');
  ok(ownContactUncertainAt(0.01) === true && ownContactUncertainAt(0.9) === false,
    '光照 < 0.35 才可能把友舰当不明接触（白天不会）');
}

// ═══════════════════════════════════════════════════════════════════════════
line('=== 2. 同阵营"不明接触"：白天不产生；夜间雷达航迹无 IFF、可能被当敌舰 ===');
{
  // (a) 白天：编队识别可靠，友舰不进入航迹表
  const wDay = sensorWorld({ light: 0.9, vis: 20, sea: 2, seed: 21 });
  const sfD = shipOf('NewOrleans', 'ALLIED', 'sf', { x: 0, y: 0, heading: 0, speed: 10, crewQuality: 0.9 });
  const atlD = shipOf('Atlanta', 'ALLIED', 'atl', { x: 4000, y: 0, heading: 180, speed: 10, crewQuality: 0.8 });
  wDay.ships.push(sfD, atlD);
  for (let i = 0; i < 1200; i++) { wDay.t += 0.1; updateSensors(sfD, wDay, 0.1); wDay.tracks.update(0.1); }
  const dayOwnTracks = wDay.tracks.tracks.filter((t) => t.side === 'ALLIED' && t._trueIds && t._trueIds.has('atl'));
  ok(dayOwnTracks.length === 0, '白天友舰（4 km）不会成为航迹（编队识别可靠 → 无 fallback 假目标）',
    '航迹数=' + dayOwnTracks.length + '，全部航迹=' + wDay.tracks.tracks.length);

  // (b) 夜间 + 雷达只能（目视不可见）：友舰可能成为雷达不明接触，且雷达不给任何敌我信息
  let found = 0, first = null, firstWorld = null, anyIdentityEvent = false;
  for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
    const wN = sensorWorld({ light: 0.01, vis: 0.3, sea: 2, seed });
    const sfN = shipOf('NewOrleans', 'ALLIED', 'sf', { x: 0, y: 0, heading: 0, speed: 10, crewQuality: 0.9 });
    const atlN = shipOf('Atlanta', 'ALLIED', 'atl', { x: 4500, y: 0, heading: 180, speed: 10, crewQuality: 0.8 });
    // 只留雷达：关掉声呐/水听器，目视被能见度 0.3 nmi 完全挡住
    for (const s of [sfN, atlN]) for (const sn of (s.sensors || [])) if (sn.srcKind !== 'RADAR') sn.on = false;
    wN.ships.push(sfN, atlN);
    for (let i = 0; i < 900 && !(wN.tracks.tracks.some((t) => t.side === 'ALLIED' && t._trueIds && t._trueIds.has('atl'))); i++) {
      wN.t += 0.1; updateSensors(sfN, wN, 0.1); wN.tracks.update(0.1);
    }
    const tr = wN.tracks.tracks.find((t) => t.side === 'ALLIED' && t._trueIds && t._trueIds.has('atl'));
    if (tr) { found++; if (!first) { first = tr; firstWorld = wN; } }
    if (wN.events.history.some((e) => e.type === 'sensor.identity')) anyIdentityEvent = true;
  }
  ok(found >= 1, '夜间 40 个固定 seed 中至少一个 seed 产生友舰"不明接触"（误伤可能发生）', found + '/40 seed');
  if (first) {
    console.log('  首个实例：' + first.id + ' idSource=' + first.idSource + ' foeConfidence=' + f2(first.foeConfidence) +
      ' hostile=' + first.hostile + ' misId=' + first.misId + ' hits=' + first.hits);
    ok(first.idSource === 'RADAR', '该航迹只由雷达建立（目视不可见）', first.idSource);
    ok(first.foeConfidence === 0, '雷达对敌我判断零信息量：foeConfidence=0', f2(first.foeConfidence));
    ok(first.misId === 'FRIEND_AS_HOSTILE', '雷达航迹把友舰记为 FRIEND_AS_HOSTILE', String(first.misId));
    ok(first.hostile === true, '不明目标按 1942 条令先当敌舰（hostile=true）', String(first.hostile));
    ok(anyIdentityEvent, '识别状态变化 emit sensor.identity 事件');
  } else {
    ok(false, '夜间友舰不明接触：16 个 seed 均未出现（识别模型可能过保守）');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
line('=== 3. 夜战误伤全链路（固定 seed）：misId=FRIEND_AS_HOSTILE → FIRE → gun.friendlyfire ===');
{
  const SEED = 1;
  const w = makeWorld({ seed: SEED, date: NIGHT_DATE, ships: standardShips() });
  silenceShips(w);
  feedLookout(w, 0.05);
  for (let i = 0; i < 200; i++) w.step(0.1);   // 20 s：建立低质量目视航迹

  const tr = w.tracks.tracks.find((t) => t._trueIds && t._trueIds.has('atl'));
  ok(!!tr, '建立友舰航迹（瞭望把友舰当成不明接触）');
  if (!tr) { console.log('  无法继续：没有友舰航迹'); }
  else {
    console.log('  误判航迹：' + tr.id + ' trueSide=' + tr.trueSide + ' hostile=' + tr.hostile +
      ' foeConfidence=' + f2(tr.foeConfidence) + ' misId=' + tr.misId + ' idSource=' + tr.idSource);
    ok(tr.misId === 'FRIEND_AS_HOSTILE', '(a) 航迹 misId=FRIEND_AS_HOSTILE', String(tr.misId));
    ok(tr.hostile === true, '(a) 误判航迹被视为敌舰（hostile=true）', String(tr.hostile));
    ok(tr.foeConfidence < 0.5, '(a) 敌我判定置信度低（夜暗远距，识别不清楚）', f2(tr.foeConfidence));
    const identEv = w.events.history.find((e) => e.type === 'sensor.identity' && e.misId === 'FRIEND_AS_HOSTILE');
    ok(!!identEv, '(a) emit sensor.identity（misId=FRIEND_AS_HOSTILE）', identEv ? 't=' + Number(identEv.t).toFixed(1) : '无');

    // 玩家/本舰按"这是敌舰"对其开火
    w.issueCommand({ shipId: 'sf', kind: 'FIRE', params: { trackId: tr.id, ammo: 'AP', salvoes: 9999 }, side: 'ALLIED', scope: 'SHIP' });
    let ff = null, nextFeed = 0;
    for (let i = 0; i < 3600 && !ff; i++) {
      if (w.t >= nextFeed) { feedLookout(w, 0.05); nextFeed = w.t + 5; }
      w.step(0.1);
      ff = w.events.history.find((e) => e.type === 'gun.friendlyfire' && !e.followUp);
    }
    const atl = w.ship('atl'), sf = w.ship('sf');
    ok(!!ff, '(a) 命中后 emit gun.friendlyfire（真打真伤）',
      ff ? 't=' + ff.t.toFixed(1) + 's，dist=' + ff.distanceM + 'm' : '未发生');
    if (ff) {
      console.log('  事件：' + ff.shooter + '→' + ff.victim + ' dist=' + ff.distanceM + 'm range=' + ff.rangeM +
        'm cause=' + ff.cause + ' misId=' + ff.misId + ' ammo=' + ff.ammo + ' hitPart=' + ff.hitPart +
        ' penetrated=' + ff.penetrated + ' sunk=' + ff.sunk + ' sinking=' + ff.sinking + ' fQ=' + ff.foeConfidence);
      ok(ff.shooter === 'sf' && ff.victim === 'atl', '事件含双方（射手 sf / 被害 atl）', ff.shooter + '→' + ff.victim);
      ok(ff.shooterSide === 'ALLIED' && ff.shooterSide === ff.victimSide, '双方同阵营（这才是"误伤"）');
      ok(ff.distanceM > 2500 && ff.distanceM < 7000, '事件含双方距离', ff.distanceM + ' m');
      ok(ff.rangeM > 0 && ff.ammo === 'AP', '事件含射击距离与弹种', ff.rangeM + ' m / ' + ff.ammo);
      ok(ff.cause === 'MISIDENTIFIED_FRIENDLY' && ff.misId === 'FRIEND_AS_HOSTILE', '事件含原因（把友舰当敌舰）', ff.cause + '/' + ff.misId);
      ok(typeof ff.sunk === 'boolean' && typeof ff.sinking === 'boolean', '事件含"是否沉没"字段', 'sunk=' + ff.sunk + ' sinking=' + ff.sinking);
      ok(ff.trackId === tr.id && ff.foeConfidence !== null && ff.foeConfidence < 0.5, '事件回指误判航迹与低识别置信度', 'trackId=' + ff.trackId);
      const hitEv = w.events.history.find((e) => e.type === 'gun.hit' && (e.ship === 'atl' || (e.hit && e.hit.victimId === 'atl')));
      ok(!!hitEv, '真实命中事件 gun.hit（伤害按既有链路结算）', hitEv ? 't=' + Number(hitEv.t).toFixed(1) : '无');
      ok(hitEv && hitEv.seq < ff.seq, '先 gun.hit 后 gun.friendlyfire（同一命中结算）', hitEv ? hitEv.seq + '<' + ff.seq : '');
      ok(atl.stats.hitsTaken >= 1, '被害友舰 hitsTaken 增加（真打真伤）', atl.stats.hitsTaken + ' 次');
      ok(sf.stats.friendlyFire >= 1, '射手 stats.friendlyFire 记账', sf.stats.friendlyFire + ' 次');
      ok(sf.morale < 1 && atl.morale < 1, '误击轻微扣减双方士气', 'sf=' + f2(sf.morale) + ' atl=' + f2(atl.morale));
      ok(ff.morale && typeof ff.morale.shooter === 'number' && typeof ff.morale.victim === 'number', '事件含士气变化');
      ok(atl.isAfloat, '本场景友舰未沉没（首轮误伤不致命，sunk=false 自洽）', 'isAfloat=' + atl.isAfloat);
    }
    // 固定 seed 下应可复现
    const w2 = makeWorld({ seed: SEED, date: NIGHT_DATE, ships: standardShips() });
    silenceShips(w2); feedLookout(w2, 0.05);
    for (let i = 0; i < 200; i++) w2.step(0.1);
    const tr2 = w2.tracks.tracks.find((t) => t._trueIds && t._trueIds.has('atl'));
    w2.issueCommand({ shipId: 'sf', kind: 'FIRE', params: { trackId: tr2.id, ammo: 'AP', salvoes: 9999 }, side: 'ALLIED', scope: 'SHIP' });
    let ff2 = null; nextFeed = 0;
    for (let i = 0; i < 3600 && !ff2; i++) {
      if (w2.t >= nextFeed) { feedLookout(w2, 0.05); nextFeed = w2.t + 5; }
      w2.step(0.1);
      ff2 = w2.events.history.find((e) => e.type === 'gun.friendlyfire' && !e.followUp);
    }
    ok(!!ff2 && ff2.t === ff?.t, '固定 seed 可复现（同样是 t=' + (ff ? ff.t.toFixed(1) : '?') + 's 的误伤）',
      ff2 ? 't=' + ff2.t.toFixed(1) : '未复现');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
line('=== 4. 白天/近距高置信：认清了就不打（不产生 friendlyfire）===');
{
  const w = makeWorld({ seed: 7, date: DAY_DATE, ships: standardShips() });
  silenceShips(w);
  feedLookout(w, 0.8);                       // 白天近距：高质量目视识别
  for (let i = 0; i < 300; i++) { if (i % 20 === 0) feedLookout(w, 0.8); w.step(0.1); }
  const tr = w.tracks.tracks.find((t) => t._trueIds && t._trueIds.has('atl'));
  ok(!!tr, '白天建立友舰航迹（用于验证"认出后不打"）');
  if (tr) {
    console.log('  白天航迹：hostile=' + tr.hostile + ' foeConfidence=' + f2(tr.foeConfidence) +
      ' misId=' + tr.misId + ' idSource=' + tr.idSource);
    ok(tr.hostile === false, '连续高质量目视后纠正为友舰（hostile=false）', String(tr.hostile));
    ok(tr.misId === null, '误判被纠正（misId=null）', String(tr.misId));
    ok(tr.foeConfidence >= 0.35, '敌我判定置信度高（认清了）', f2(tr.foeConfidence));
    ok(w.events.history.some((e) => e.type === 'sensor.identity' && e.hostile === false), 'emit sensor.identity（改判为友舰）');

    w.issueCommand({ shipId: 'sf', kind: 'FIRE', params: { trackId: tr.id, ammo: 'AP', salvoes: 9999 }, side: 'ALLIED', scope: 'SHIP' });
    for (let i = 0; i < 1200; i++) { if (i % 20 === 0) feedLookout(w, 0.8); w.step(0.1); }
    const atl = w.ship('atl'), sf = w.ship('sf');
    const hold = w.events.history.filter((e) => e.type === 'fc.update' && e.kind === 'TARGET_FRIENDLY');
    ok(w.events.history.filter((e) => e.type === 'gun.friendlyfire').length === 0, '(b) 白天/近距不产生 gun.friendlyfire',
      '误伤事件=' + w.events.history.filter((e) => e.type === 'gun.friendlyfire').length);
    ok(atl.stats.hitsTaken === 0, '(b) 友舰未被命中', 'hitsTaken=' + atl.stats.hitsTaken);
    ok(sf.stats.shotsFired === 0, '(b) 已确认友舰的航迹被拒绝开火（0 发）', 'shots=' + sf.stats.shotsFired);
    ok(hold.length >= 1, '(b) emit fc.update kind=TARGET_FRIENDLY（识别为友舰 → 停火）', hold.length + ' 次');
    ok(sf.commanded.firing === false, '(b) 射击命令被撤销（commanded.firing=false）', String(sf.commanded.firing));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
line('=== 5. 向后兼容：hostile 旧语义 / view 字段 / LOCAL AI 不崩 ===');
{
  const w = makeWorld({ seed: 99, date: DAY_DATE, ships: standardShips() });
  silenceShips(w);
  // 旧语义 1：不明目标默认当敌舰（雷达观测，identity 明确标注"无 IFF/零信息量"）
  const radarTr = w.tracks.observe({
    side: 'ALLIED', srcKind: 'RADAR', shipId: 'sf', targetId: 'jp1',
    pos: { x: 16000, y: 6000 }, rangeM: 17000, bearingDeg: 70, accuracyM: 80, accuracyDeg: 1.0, t: 0,
    identity: { src: 'RADAR', quality: 0, iff: false },
  });
  ok(radarTr && radarTr.hostile === true, '雷达发现的不明目标：hostile=true（旧语义"不明即敌"）', String(radarTr && radarTr.hostile));
  ok(radarTr && radarTr.misId === null, '真值为敌舰时 misId=null（不是误判）', String(radarTr && radarTr.misId));
  ok(radarTr && radarTr.idSource === 'RADAR', '识别来源记录为 RADAR（不冒充目视）', radarTr && radarTr.idSource);
  ok(radarTr && radarTr.foeConfidence === 0, '雷达不产生敌我置信度（1942 无 IFF）', radarTr && radarTr.foeConfidence);
  // 完全不带 identity 的旧式观测（剧本/第三方调用）：不得崩溃，来源记为 NONE
  const legacyTr = w.tracks.observe({
    side: 'ALLIED', srcKind: 'VISUAL', shipId: 'dd', targetId: 'jp1',
    pos: { x: 26000, y: 0 }, rangeM: 26000, bearingDeg: 90, accuracyM: 200, accuracyDeg: 1.0, t: 0,
  });
  ok(legacyTr && legacyTr.idSource === 'NONE' && legacyTr.hostile === true, '无 identity 的旧式观测仍可用（idSource=NONE，不崩）',
    legacyTr ? legacyTr.idSource + '/hostile=' + legacyTr.hostile : 'null');
  ok(radarTr && typeof radarTr.idConfidence === 'number', 'idConfidence（型号识别）字段仍在（AI/UI 旧读取点）', radarTr && radarTr.idConfidence);

  // 旧语义 2：显式 hostile=false 被尊重（剧本/测试旧调用）
  const scriptTr = w.tracks.observe({
    side: 'ALLIED', srcKind: 'SCRIPT', shipId: 'sf', targetId: 'atl',
    pos: { x: 4000, y: 0 }, rangeM: 4000, bearingDeg: 90, accuracyM: 30, accuracyDeg: 0.2, t: 0, hostile: false,
  });
  ok(scriptTr && scriptTr.hostile === false, '显式 hostile=false 的观测保持友舰语义', String(scriptTr && scriptTr.hostile));
  ok(scriptTr && scriptTr.misId === null, '已确认为友舰 → 无误判', String(scriptTr && scriptTr.misId));

  // 玩家可见视图：认知字段齐全，且不泄漏真值 misId
  const views = w.tracks.visibleFor(w.ship('sf'));
  ok(views.length >= 2, 'visibleFor 返回航迹（AI/UI 视图）', views.length + ' 条');
  const bad = views.filter((v) => typeof v.hostile !== 'boolean' || typeof v.foeConfidence !== 'number' ||
    typeof v.idConfidence !== 'number' || typeof v.idSource !== 'string' || v.hasIFF !== false);
  ok(bad.length === 0, '视图字段齐全：hostile/foeConfidence/idConfidence/idSource/hasIFF', bad.length + ' 条不合法');
  ok(views.every((v) => v.misId === undefined), '战术视图不泄漏 misId（战场上看不到真值）');

  // LOCAL AI：在真实 World 里跑一段，AI 读 hostile/idConfidence 不崩
  const aiShips = [
    { id: 'sf2', name: '旧金山', class: 'NewOrleans', side: 'ALLIED', x: 0, y: 0, heading: 90, speed: 18, role: 'flagship', crewQuality: 0.9 },
    { id: 'jp2', name: '青叶', class: 'Aoba', side: 'AXIS', x: 12000, y: 2000, heading: 270, speed: 20, role: 'flagship', crewQuality: 1.1 },
  ];
  const wAI = makeWorld({ seed: 5, date: DAY_DATE, ships: aiShips, ai: true });
  let aiError = null;
  try {
    for (let i = 0; i < 400; i++) wAI.step(0.1);
  } catch (e) { aiError = e; }
  ok(!aiError, 'LOCAL AI 读取新航迹字段 40 s 不崩', aiError ? String(aiError && aiError.message) : '无异常');
  const st = wAI.visibleStateFor('ALLIED');
  console.log('  AI 可见状态：航迹 ' + st.tracks.length + ' 条，己方 ' + st.ownShips.length + ' 艘' +
    (st.tracks[0] ? '，首条 hostile=' + st.tracks[0].hostile + ' idConfidence=' + st.tracks[0].idConfidence : ''));
  ok(st.tracks.every((t) => typeof t.hostile === 'boolean'), 'visibleStateFor 的 hostile 仍是布尔（旧语义）');
  ok(wAI.events.history.filter((e) => e.type === 'ai.error').length === 0, 'AI 未产生 ai.error',
    wAI.events.history.filter((e) => e.type === 'ai.error').length + ' 条');
  ok(Object.keys(wAI.ai || {}).length === 2, '双方 AI 指挥器存在', Object.keys(wAI.ai || {}).join('/'));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n================ T14 汇总 ================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('T14 全部通过 ✅');
}
