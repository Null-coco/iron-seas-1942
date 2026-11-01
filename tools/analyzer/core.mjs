// ============================================================================
// 回放分析器 · 纯分析层（不依赖浏览器 / 不依赖 sim 运行时）
// ----------------------------------------------------------------------------
// 输入：world.exportReplay() 产出的回放 JSON
//   { version, scenario, seed, startedAt, endedAt, snapshots, events, commands, result, retention }
// 输出：结构化分析模型（meta / ships / gunnery / damage / torpedo / orders / tracks / findings / timeline）
//
// 设计原则
//   1) 只读回放事件：战报口径与「当时到底发生了什么」一致，不重新推演物理；
//   2) 一切结论都要有证据：每条 finding 都带 t 与原始字段，便于回盘点回去；
//   3) 与 sim 解耦：本文件不 import src/sim/*，只吃 JSON，因此可离线分析任意来源的回放；
//   4) 缺数据不臆造：没有 data/ships_*.json 时按主炮口径推断舰种，拿不到的字段留 null。
//
// 用法见 tools/replay-analyzer.mjs；回归检查见 checkReplay()。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

export const SIDE_ZH = { ALLIED: '同盟国', AXIS: '轴心国', NEUTRAL: '中立' };
export const TYPE_ZH = { BB: '战列舰', BC: '战列巡洋舰', CA: '重巡洋舰', CL: '轻巡洋舰', DD: '驱逐舰', CV: '航空母舰', SS: '潜艇', MERCHANT: '商船', UNKNOWN: '不明' };
export const MAGAZINE_RESULT_ZH = { detonation: '殉爆', burn: '爆燃', flooded: '注水', flash: '炮塔闪爆', hit: '被命中', fire_threat: '受威胁' };

// ── 小工具 ──────────────────────────────────────────────────────────────────
export const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
export const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
export const fmtPct = (a, b, d = 1) => pct(a, b).toFixed(d) + '%';
export function fmtClock(t, withTenth = true) {
  if (!Number.isFinite(t)) return '—';
  let m = Math.floor(t / 60);
  if (!withTenth) {
    let sec = Math.round(t - m * 60);
    if (sec >= 60) { m += 1; sec = 0; }          // 59.6s 四舍五入成 60 时进位，避免出现 31:60
    return m + ':' + String(sec).padStart(2, '0');
  }
  let sec = t - m * 60;
  let ss = sec.toFixed(1);
  if (Number(ss) >= 60) { m += 1; ss = '0.0'; }  // 9.99s → "10.0"、59.99s → "60.0" 都要进位
  return m + ':' + (Number(ss) < 10 ? '0' : '') + ss;
}
export function fmtNum(n) { return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'; }
export const sideZh = (s) => SIDE_ZH[s] || s || '未知';
export const typeZh = (t) => TYPE_ZH[t] || t || '不明';

// ── 舰船数据库（可选）：从 data/ships_*.json 补舰种/吨位/乘员/主炮口径 ─────────
// 把一份 ships_*.json 的解析结果并进索引（Node 与浏览器共用）
export function shipDatabaseFromJson(raw, byName = new Map()) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.ships) ? raw.ships : []);
  for (const s of list) {
    if (!s || !s.nameZh) continue;
    const main = (s.guns || []).find((g) => g.role === 'main') || (s.guns || [])[0] || {};
    byName.set(s.nameZh, {
      type: s.type, class: s.class, nation: s.nation, year: s.year,
      displacementFull_t: s.displacementFull_t, crew: s.crew, speedMax_kn: s.speedMax_kn,
      belt_mm: s.armor && s.armor.belt_mm, mainBore_mm: main.bore_mm || main.caliber_mm || null,
      loa_m: s.loa_m, torp: (s.torpedoes || []).length,
    });
  }
  return byName;
}

export function loadShipDatabase(dataDir) {
  const byName = new Map();
  if (!dataDir) return byName;
  for (const f of ['ships_allied.json', 'ships_axis.json']) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch (e) { continue; }
    shipDatabaseFromJson(raw, byName);
  }
  return byName;
}

// 没有数据库时的舰种推断：按最大开火口径（二战主炮口径分布足够区分）
function inferType(bore) {
  if (!bore) return 'UNKNOWN';
  if (bore >= 380) return 'BB';
  if (bore >= 200) return 'CA';
  if (bore >= 140) return 'CL';
  return 'DD';
}

// ── 主分析 ──────────────────────────────────────────────────────────────────
export function analyzeReplay(replay, opts = {}) {
  if (!replay || typeof replay !== 'object') throw new Error('回放为空或不是对象');
  const events = Array.isArray(replay.events) ? replay.events : [];
  const snapshots = Array.isArray(replay.snapshots) ? replay.snapshots : [];
  // 浏览器端没有 fs：只有显式给 dataDir 时才读盘，否则用调用方传入的 db（没有就空表）
  const db = opts.db || (opts.dataDir ? loadShipDatabase(opts.dataDir) : new Map());
  const startedAt = Number.isFinite(replay.startedAt) ? replay.startedAt : 0;
  const endedAt = Number.isFinite(replay.endedAt) ? replay.endedAt
    : (events.length ? events[events.length - 1].t : (snapshots.length ? snapshots[snapshots.length - 1].t : 0));
  const duration = Math.max(0, endedAt - startedAt);
  const result = Object.assign({ over: false, winner: null, text: '' }, replay.result || {});

  // ── 舰船注册表：从事件里「谁是谁」反推 ────────────────────────────────────
  const ships = new Map();
  function touch(id, patch = {}) {
    if (!id) return null;
    let s = ships.get(id);
    if (!s) {
      s = {
        id, name: id, side: null, type: null, class: null, nation: null, year: null,
        loa_m: null, displacementFull_t: null, crew: null, speedMax_kn: null, belt_mm: null,
        rounds: 0, salvos: 0, hits: 0, nearMisses: 0, bounces: 0, straddles: 0, ammo: {}, calibers: {},
        hitsTaken: 0, torpsFired: 0, torpHits: 0, torpFriendlyHits: 0, torpHitsTaken: 0, torpFriendlyHitsTaken: 0,
        casualties: 0, hitsTakenBySide: {}, hitsTakenByCaliber: {},
        floodingPeak: 0, floodedM3: 0, listPeak: 0, fires: 0, magazine: [], subsystems: [],
        firstFire: null, lastFire: null, fireTimes: [], withdrew: false, sank: null, capsized: false,
        final: null,
      };
      ships.set(id, s);
    }
    for (const k of Object.keys(patch)) if (patch[k] !== undefined && patch[k] !== null) s[k] = patch[k];
    return s;
  }
  const sideFromId = (id) => {
    const m = String(id).toLowerCase();
    if (m.includes('allied')) return 'ALLIED';
    if (m.includes('axis')) return 'AXIS';
    return null;
  };

  // ── 汇总容器 ──────────────────────────────────────────────────────────────
  const orders = { total: 0, bySide: {}, byKind: {} };
  const torpLaunches = [], torpHits = [], torpMisses = [], collisions = [];
  const aiDecisions = [];
  const trackCreated = new Map();
  const identitySeq = new Map();
  const sinkEvents = [], magazineEvents = [], hitLog = [], gunFFHits = [], fireOrders = [], ceaseOrders = [], seqGaps = [];
  let lastSeq = null;
  let gunFFEventCount = 0;
  const gunFireBySide = {}, gunHitBySide = {};
  let totalCasualties = 0;
  const timeline = [];
  let tlSeq = 0;
  const push = (t, kind, text, sev = 0, extra) => timeline.push(Object.assign({ t, kind, text, sev, seq: tlSeq++ }, extra || {}));

  // 判型漂移：从 AI 决策文本里抽「集火XX(T5)」/「→XX(T5)」
  const RE_CLS = /(?:集火|→)\s*(BB|BC|CA|CL|DD|CV|SS|UNKNOWN)\(T(\d+)\)/g;

  for (const e of events) {
    const t = e.t;
    if (typeof e.seq === 'number') {
      if (lastSeq !== null && e.seq !== lastSeq + 1) seqGaps.push({ prev: lastSeq, next: e.seq, t });
      lastSeq = e.seq;
    }
    switch (e.type) {
      case 'gun.fire': {
        const s = touch(e.ship, { name: e.name, side: e.side });
        if (!s) break;
        s.rounds++;
        s.ammo[e.ammo] = (s.ammo[e.ammo] || 0) + 1;
        s.calibers[e.caliberMM] = (s.calibers[e.caliberMM] || 0) + 1;
        if (s.firstFire === null) s.firstFire = t;
        s.lastFire = t;
        s.fireTimes.push(t);
        gunFireBySide[e.side] = (gunFireBySide[e.side] || 0) + 1;
        break;
      }
      case 'gun.salvo.away': {
        const s = touch(e.ship, { name: e.name, side: e.side });
        if (s) s.salvos++;
        break;
      }
      case 'gun.hit': {
        const attacker = touch(e.byShip, { name: e.byShipName });
        const victim = touch(e.ship, { name: e.name });
        if (e.hit && e.hit.shipSide) touch(e.ship, { side: e.hit.shipSide });
        if (e.hit && e.hit.attackerSide) touch(e.byShip, { side: e.hit.attackerSide });
        const atkSide = (e.hit && e.hit.attackerSide) || (attacker && attacker.side);
        if (attacker) {
          attacker.hits++;
          gunHitBySide[atkSide] = (gunHitBySide[atkSide] || 0) + 1;
          attacker.hitsByVictim = attacker.hitsByVictim || {};
          attacker.hitsByVictim[e.ship] = (attacker.hitsByVictim[e.ship] || 0) + 1;
        }
        if (victim) {
          victim.hitsTaken++;
          victim.hitsTakenBySide[atkSide] = (victim.hitsTakenBySide[atkSide] || 0) + 1;
          if (e.caliberMM) victim.hitsTakenByCaliber[e.caliberMM] = (victim.hitsTakenByCaliber[e.caliberMM] || 0) + 1;
        }
        const isFF = !!atkSide && !!victim && !!victim.side && atkSide === victim.side;
        if (isFF) {
          if (victim) victim.gunFriendlyFire = (victim.gunFriendlyFire || 0) + 1;
          gunFFHits.push({ t, byShip: e.byShip, byName: e.byShipName || e.byShip, ship: e.ship, name: e.name || e.ship, caliberMM: e.caliberMM });
        }
        hitLog.push({ t, kind: 'gun', ship: e.ship, byShip: e.byShip, bySide: atkSide, caliberMM: e.caliberMM, friendly: isFF });
        push(t, 'gun.hit', (e.byShipName || e.byShip || '?') + ' 命中 ' + (e.name || e.ship) + (e.caliberMM ? '（' + e.caliberMM + 'mm）' : ''), 66, { ship: e.ship });
        break;
      }
      case 'gun.nearmiss': { const s = touch(e.ship, { name: e.name }); if (s) s.nearMisses++; break; }
      case 'gun.bounce': { const s = touch(e.ship, { name: e.name }); if (s) s.bounces++; break; }
      case 'gun.straddle': { const s = touch(e.ship, { name: e.name }); if (s) s.straddles++; break; }
      case 'gun.friendlyfire': {
        touch(e.ship, { name: e.name });
        gunFFEventCount++;
        push(t, 'gun.friendlyfire', (e.killerName || e.byShip || '友舰') + ' 误击 ' + (e.name || e.ship) + (e.reason ? '：' + e.reason : ''), 95);
        break;
      }
      // ── 鱼雷 ──
      case 'torp.launch': {
        const s = touch(e.ship, { name: e.name, side: e.side });
        if (s) s.torpsFired += e.tubes || 0;
        torpLaunches.push({ t, ship: e.ship, name: e.name, side: e.side, mount: e.mount, tubes: e.tubes || 0, target: e.track || e.target || null, bearingDeg: e.bearingDeg, spreadDeg: e.spreadDeg, speedIdx: e.speedIdx, accepted: e.accepted !== false });
        push(t, 'torp.launch', (e.name || e.ship) + ' 发射 ' + (e.tubes || 0) + ' 雷（目标 ' + (e.track || e.target || '?') + '）', 30, { ship: e.ship });
        break;
      }
      case 'torp.hit': {
        const victim = touch(e.ship, { name: e.name });
        const shooter = touch(e.shooter, { name: e.shooterName });
        if (shooter) { shooter.torpHits++; if (e.friendly) shooter.torpFriendlyHits++; }
        if (victim) { victim.torpHitsTaken++; if (e.friendly) victim.torpFriendlyHitsTaken++; }
        torpHits.push({ t, ship: e.ship, name: e.name, shooter: e.shooter, shooterName: e.shooterName, friendly: !!e.friendly, torp: e.torp, side: e.side, compartment: e.compartment, xFrac: e.x_frac, depthM: e.depthM, warheadKg: e.warheadKg, tntKg: e.tntKg });
        hitLog.push({ t, kind: 'torp', ship: e.ship, byShip: e.shooter, bySide: e.shooterSide, friendly: !!e.friendly });
        push(t, 'torp.hit', (e.shooterName || e.shooter) + ' 的鱼雷命中 ' + (e.name || e.ship) + (e.friendly ? '（友军）' : ''), e.friendly ? 99 : 90);
        break;
      }
      case 'torp.dud': {
        push(t, 'torp.dud', (e.name || e.ship) + ' 被鱼雷命中但哑弹（' + (e.shooter || '?') + '）', 86);
        break;
      }
      case 'torp.miss': {
        torpMisses.push({ t, ship: e.ship, torp: e.torp, reason: e.reason, target: e.target, runM: e.runM });
        break;
      }
      // ── 损伤 ──
      case 'dam.casualties': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        const k = e.killed || 0;
        if (s) s.casualties += k;
        totalCasualties += k;
        if (s && e.crewNow !== undefined) s.crewNow = e.crewNow;
        break;
      }
      case 'dam.flood': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        if (s && e.floodedM3 !== undefined) s.floodedM3 = Math.max(s.floodedM3, e.floodedM3);
        break;
      }
      case 'dam.dc': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        if (!s) break;
        if (e.inflowM3s !== undefined) s.floodingPeak = Math.max(s.floodingPeak, e.inflowM3s);
        if (e.pumpM3s !== undefined) s.pumpM3s = e.pumpM3s;
        if (e.speedCapKn !== undefined) s.speedCapKn = e.speedCapKn;
        break;
      }
      case 'dam.list': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        if (!s) break;
        if (e.list !== undefined) s.listPeak = Math.max(s.listPeak, Math.abs(e.list));
        if (e.gm !== undefined) s.gm = e.gm;
        if (e.capsizeRisk !== undefined) s.capsizeRisk = Math.max(s.capsizeRisk || 0, e.capsizeRisk);
        break;
      }
      case 'dam.fire': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        if (s) s.fires++;
        push(t, 'dam.fire', (e.name || e.ship) + ' 起火（' + (e.cause || '命中') + '）', 60);
        break;
      }
      case 'dam.magazine': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        const rec = { t, ship: e.ship, name: e.name, result: e.result, killed: e.killed || 0, cause: e.cause, energyKg: e.energyKg };
        if (s) { s.magazine.push(rec); s.casualties += rec.killed; }
        magazineEvents.push(rec);
        totalCasualties += rec.killed;
        push(t, 'dam.magazine', (e.name || e.ship) + ' 弹药库' + (MAGAZINE_RESULT_ZH[e.result] || e.result || '受损') + (rec.killed ? '，' + fmtNum(rec.killed) + ' 人阵亡' : ''), 92);
        break;
      }
      case 'dam.subsystem': {
        const s = touch(e.ship, { name: e.name, side: e.victimSide });
        if (s && e.destroyed) s.subsystems.push({ t, name: e.subsystem || e.name, kind: e.kind });
        break;
      }
      case 'ship.sink': {
        const s = touch(e.ship, { name: e.name, side: e.side });
        if (s) s.sank = { t, cause: e.cause, catastrophic: !!e.catastrophic, energyKg: e.energyKg, x: e.x, y: e.y };
        sinkEvents.push({ t, ship: e.ship, name: e.name, cause: e.cause });
        push(t, 'ship.sink', (e.name || e.ship) + ' 沉没' + (e.cause ? '（' + e.cause + '）' : ''), 100);
        break;
      }
      case 'ship.capsize': {
        const s = touch(e.ship, { name: e.name, side: e.side });
        if (s) s.capsized = true;
        push(t, 'ship.capsize', (e.name || e.ship) + ' 倾覆', 96);
        break;
      }
      case 'ship.collide': {
        collisions.push({ t, a: e.a, b: e.b, relKn: e.rel });
        push(t, 'ship.collide', (e.a || '?') + ' 与 ' + (e.b || '?') + ' 相撞（相对速度 ' + round1(e.rel) + ' kn）', 55);
        break;
      }
      // ── 指挥 ──
      case 'order.issue': {
        const c = e.cmd || {};
        orders.total++;
        const side = c.side || 'UNKNOWN';
        orders.bySide[side] = orders.bySide[side] || {};
        orders.bySide[side][c.kind] = (orders.bySide[side][c.kind] || 0) + 1;
        orders.byKind[c.kind] = (orders.byKind[c.kind] || 0) + 1;
        if (c.shipId) touch(c.shipId, { side });
        if (c.kind === 'FIRE') fireOrders.push({ t, tEffective: c.t_effective !== undefined ? c.t_effective : t, shipId: c.shipId, trackId: c.params && c.params.trackId });
        if (c.kind === 'CEASE_FIRE') ceaseOrders.push({ t, shipId: c.shipId });
        if (c.kind === 'WITHDRAW') {
          const w = ships.get(c.shipId); if (w) w.withdrew = true;
          const s = ships.get(c.shipId);
          push(t, 'order.withdraw', (s ? s.name : c.shipId) + ' 奉命脱离', 70);
        }
        break;
      }
      case 'ai.decision': {
        aiDecisions.push({ t, side: e.side, phase: e.phase || null, commands: e.commands || 0, reasoning: e.reasoning || '' });
        const reason = e.reasoning || '';
        let m;
        RE_CLS.lastIndex = 0;
        while ((m = RE_CLS.exec(reason))) {
          const key = e.side + '|T' + m[2];
          const seq = identitySeq.get(key) || [];
          const last = seq[seq.length - 1];
          if (!last || last.label !== m[1]) seq.push({ t, label: m[1] });
          identitySeq.set(key, seq);
          const tid = 'T' + m[2];
          if (!trackCreated.has(tid)) trackCreated.set(tid, { id: tid, side: e.side, t, by: 'AI 判型', source: 'ai' });
        }
        break;
      }
      case 'sensor.detect': case 'sensor.identity': {
        const tid = e.target;
        if (tid && !trackCreated.has(tid)) trackCreated.set(tid, { id: tid, side: e.side, t, by: e.ship, source: e.source || e.src || '?' });
        break;
      }
      case 'victory.achieved': push(t, 'victory', '交战结束：' + (e.text || e.winner || ''), 100); break;
      default: break;
    }
  }

  // 老回放可能只有 gun.hit、没有独立的 gun.friendlyfire 事件：补一条时间线，避免误伤被漏掉
  if (!gunFFEventCount) {
    for (const h of gunFFHits.slice(0, 5)) push(h.t, 'gun.friendlyfire', h.byName + ' 误击友舰 ' + h.name + (h.caliberMM ? '（' + h.caliberMM + 'mm）' : ''), 95);
  }

  // ── 补全：舰名/阵营/舰种/最终状态 ──────────────────────────────────────────
  for (const s of ships.values()) {
    if (!s.name || s.name === s.id) {
      const named = events.find((e) => e.ship === s.id && e.name);
      if (named) s.name = named.name;
    }
    if (!s.side) s.side = sideFromId(s.id) || 'UNKNOWN';
    const bore = Math.max(0, ...Object.keys(s.calibers).map(Number));
    s.caliber = bore || null;
    const rec = db.get(s.name);
    if (rec) Object.assign(s, {
      type: rec.type, class: rec.class, nation: rec.nation, year: rec.year,
      loa_m: rec.loa_m, displacementFull_t: rec.displacementFull_t, crew: rec.crew,
      speedMax_kn: rec.speedMax_kn, belt_mm: rec.belt_mm,
    });
    if (!s.type) s.type = inferType(bore);
    if (!s.name) s.name = s.id;
    s.turretsDestroyed = s.subsystems.filter((x) => (x.kind === 'TURRET')).length;
    if (s.crew && s.crewNow !== undefined) s.crewLost = s.crew - s.crewNow;
    if (!s.casualties && s.crewLost > 0) s.casualties = s.crewLost;
  }

  // 最终快照
  const lastSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;
  if (lastSnap) {
    for (const sh of lastSnap.ships || []) {
      const s = ships.get(sh.id);
      if (!s) continue;
      s.final = { t: lastSnap.t, x: sh.x, y: sh.y, heading: sh.hd, speed: sh.sp, list: sh.list, flood: sh.fl, afloat: sh.af, fires: sh.fires };
      if (sh.af === false && !s.sank) s.lost = true;
    }
  }

  // ── 阵营汇总 ──────────────────────────────────────────────────────────────
  const sides = {};
  for (const s of ships.values()) {
    if (!s.side || s.side === 'UNKNOWN') continue;
    sides[s.side] = sides[s.side] || { id: s.side, ships: [], name: sideZh(s.side) };
    sides[s.side].ships.push(s.id);
  }

  // ── 射击/损伤总表 ─────────────────────────────────────────────────────────
  const gunnery = { rounds: 0, hits: 0, bySide: {}, byShip: {} };
  for (const v of Object.values(gunFireBySide)) gunnery.rounds += v;
  for (const v of Object.values(gunHitBySide)) gunnery.hits += v;
  for (const sid of Object.keys(sides)) gunnery.bySide[sid] = { rounds: gunFireBySide[sid] || 0, hits: gunHitBySide[sid] || 0 };
  for (const s of ships.values()) {
    gunnery.byShip[s.id] = { rounds: s.rounds, salvos: s.salvos, hits: s.hits, hitRate: pct(s.hits, s.rounds), nearMisses: s.nearMisses, bounces: s.bounces, straddles: s.straddles, calibers: s.calibers, ammo: s.ammo, firstFire: s.firstFire, lastFire: s.lastFire };
  }

  const damage = { totalCasualties, sunk: sinkEvents, magazines: magazineEvents, byShip: {}, friendlyTorpedoHits: torpHits.filter((h) => h.friendly).length };
  for (const s of ships.values()) {
    damage.byShip[s.id] = {
      hitsTaken: s.hitsTaken, hitsTakenBySide: s.hitsTakenBySide, hitsTakenByCaliber: s.hitsTakenByCaliber,
      torpFired: s.torpsFired, torpHits: s.torpHits, torpFriendlyHits: s.torpFriendlyHits, torpHitsTaken: s.torpHitsTaken, torpFriendlyHitsTaken: s.torpFriendlyHitsTaken,
      casualties: s.casualties, floodingPeak: s.floodingPeak, floodedM3: s.floodedM3, listPeak: s.listPeak,
      fires: s.fires, magazine: s.magazine, subsystemsDestroyed: s.subsystems,
      sank: s.sank, capsized: s.capsized, final: s.final,
    };
  }

  const torpedo = {
    launches: torpLaunches, hits: torpHits, misses: torpMisses,
    fired: torpLaunches.reduce((a, l) => a + l.tubes, 0),
    hitsCount: torpHits.length,
    friendlyHits: torpHits.filter((h) => h.friendly).length,
    byShooter: {},
  };
  for (const s of ships.values()) {
    if (!s.torpsFired) continue;
    torpedo.byShooter[s.id] = { name: s.name, side: s.side, fired: s.torpsFired, hits: s.torpHits, friendlyHits: s.torpFriendlyHits };
  }

  // ── 航迹：换号 / 判型漂移 ─────────────────────────────────────────────────
  const trackList = [...trackCreated.values()].sort((a, b) => a.t - b.t);
  const identity = [];
  for (const [key, seq] of identitySeq.entries()) {
    if (seq.length < 2) continue;
    const parts = key.split('|');
    identity.push({ side: parts[0], track: parts[1], changes: seq, labels: seq.map((x) => x.label) });
  }
  identity.sort((a, b) => b.changes.length - a.changes.length);
  const tracks = { created: trackList, bySide: {}, late: trackList.filter((x) => x.t > duration * 0.6), identityDrift: identity };
  for (const x of trackList) tracks.bySide[x.side] = (tracks.bySide[x.side] || 0) + 1;

  // ── 开火静默（每方最长无开火窗口） ────────────────────────────────────────
  const fireTimes = {};
  for (const e of events) if (e.type === 'gun.fire') (fireTimes[e.side] = fireTimes[e.side] || []).push(e.t);
  const silence = {};
  for (const sid of Object.keys(sides)) {
    const arr = (fireTimes[sid] || []).slice().sort((a, b) => a - b);
    const afloat = sides[sid].ships.filter((id) => { const s = ships.get(id); return !(s.sank || s.lost); });
    if (!arr.length || !afloat.length) { silence[sid] = { first: null, last: null, gap: duration, from: startedAt, to: endedAt, silentNow: true }; continue; }
    let gap = 0, from = arr[0], to = arr[0];
    for (let i = 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d > gap) { gap = d; from = arr[i - 1]; to = arr[i]; } }
    const tail = endedAt - arr[arr.length - 1];
    if (tail > gap) { gap = tail; from = arr[arr.length - 1]; to = endedAt; }
    silence[sid] = { first: arr[0], last: arr[arr.length - 1], gap, from, to, silentNow: tail >= gap };
  }

  const meta = {
    scenario: replay.scenario || replay.scenarioId || 'unknown', seed: replay.seed,
    version: replay.version, startedAt, endedAt, duration,
    events: events.length, snapshots: snapshots.length,
    result, retention: replay.retention || null,
    sandbox: /sandbox/i.test(String(replay.scenario || '')),
    sides: Object.keys(sides),
  };

  const findings = buildFindings({ meta, ships, sides, gunnery, damage, torpedo, orders, tracks, silence, collisions, gunFFHits, gunFFEventCount, fireOrders, ceaseOrders, seqGaps, frames: snapshots, aiDecisions });
  // 把事件里的舰船 id 统一换成舰名（回放里 torp.hit / ship.collide 只带 id，不带 name）
  const nameMap = new Map([...ships.values()].map((x) => [x.id, x.name]));
  const nameKeys = [...nameMap.keys()].sort((a, b) => b.length - a.length);
  const norm = (text) => { let out = String(text === undefined || text === null ? '' : text); for (const id of nameKeys) if (out.includes(id)) out = out.split(id).join(nameMap.get(id)); return out; };
  const tl = pickTimeline(timeline, 60).map((x) => Object.assign({}, x, { text: norm(x.text) }))
    .sort((a, b) => (a.t - b.t) || ((a.seq || 0) - (b.seq || 0)));
  for (const f of findings) {
    f.title = norm(f.title); f.detail = norm(f.detail);
    if (f.evidence) f.evidence = f.evidence.map((e) => Object.assign({}, e, { text: norm(e.text) }));
  }
  const verdict = buildVerdict({ meta, ships, damage, torpedo, gunnery });
  const score = scoreboard({ ships, sides, gunnery });

  const eventCounts = {};
  for (const e of events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;

  return {
    meta, sides, ships: [...ships.values()], gunnery, damage, torpedo, orders, frames: snapshots, eventCounts,
    ai: { decisions: aiDecisions, bySide: countBy(aiDecisions, (d) => d.side), phases: phaseSeq(aiDecisions) },
    tracks, silence, collisions, findings, verdict, timeline: tl, score, hitLog, seqGaps, fireOrders,
  };
}

// ── 发现（findings）──────────────────────────────────────────────────────────
function buildFindings(m) {
  const F = [];
  const add = (code, severity, title, detail, evidence) => F.push({ code, severity, title, detail, evidence: evidence || [] });
  const { meta, ships, sides, gunnery, damage, torpedo, orders, tracks, silence, collisions, fireOrders, ceaseOrders, seqGaps, frames, aiDecisions } = m;
  const sunk = [...ships.values()].filter((s) => s.sank);
  const friendlyTorp = torpedo.hits.filter((h) => h.friendly);

  if (friendlyTorp.length) {
    const by = {};
    for (const h of friendlyTorp) { const k = h.shooter + '->' + h.ship; by[k] = (by[k] || 0) + 1; }
    const detail = Object.entries(by).map(([k, n]) => {
      const ids = k.split('->');
      const sa = ships.get(ids[0]), sb = ships.get(ids[1]);
      return (sa ? sa.name : ids[0]) + ' → ' + (sb ? sb.name : ids[1]) + '：' + n + ' 雷';
    }).join('；');
    add('TORP_FRIENDLY_FIRE', 'critical',
      '友军鱼雷命中：' + friendlyTorp.length + ' 条鱼雷打在自己人身上',
      detail + '。首次 t=' + fmtClock(friendlyTorp[0].t) + '，末次 t=' + fmtClock(friendlyTorp[friendlyTorp.length - 1].t) + '。',
      friendlyTorp.map((h) => ({ t: h.t, text: (h.shooterName || h.shooter) + ' → ' + (h.name || h.ship) + '（' + h.torp + '）' })));
  }

  if (sunk.length === 1) {
    const s = sunk[0];
    const linked = friendlyTorp.some((h) => h.ship === s.id && h.t <= s.sank.t);
    if (linked) {
      add('ONLY_KILL_FRIENDLY', 'critical',
        '全场唯一沉没的军舰由友军鱼雷造成',
        (s.name || s.id) + ' 于 t=' + fmtClock(s.sank.t) + ' ' + (s.sank.cause || '沉没') + '；此前 ' + friendlyTorp.filter((h) => h.ship === s.id).length + ' 条友军鱼雷命中。全舰 ' + fmtNum(s.crew) + ' 人，阵亡 ' + fmtNum(s.casualties) + ' 人。',
        [{ t: s.sank.t, text: (s.name || s.id) + ' 沉没：' + (s.sank.cause || '') }]);
    }
  }

  for (const [sid, sil] of Object.entries(silence)) {
    if (!sil.last) continue;
    const afloatShips = sides[sid] ? sides[sid].ships.map((id) => ships.get(id)).filter((s) => s && !(s.sank || s.lost)) : [];
    const alive = afloatShips.length;
    // 全队已奉命撤离（或已在撤离途中）后的停火是条令，不是故障：不要报成"静默"
    if (afloatShips.length && afloatShips.every((s) => s.withdrew) && sil.silentNow) continue;
    if (alive > 0 && sil.gap >= Math.max(120, meta.duration * 0.15)) {
      add('SIDE_SILENCE', 'major',
        sideZh(sid) + ' 有 ' + Math.round(sil.gap) + ' 秒一炮未发',
        '最后一次开火 t=' + fmtClock(sil.last) + '，此后 ' + Math.round(meta.endedAt - sil.last) + ' 秒无主炮射击；当时仍有 ' + alive + ' 艘在航。',
        [{ t: sil.last, text: '最后一发' }, { t: meta.endedAt, text: '回放结束' }]);
    }
  }

  const drift = tracks.identityDrift.filter((x) => x.changes.length >= 3);
  if (drift.length) {
    const d = drift[0];
    add('TRACK_IDENTITY_DRIFT', 'major',
      '航迹判型漂移：' + d.track + ' 被改判 ' + (d.changes.length - 1) + ' 次（' + d.labels.join('→') + '）',
      drift.slice(0, 3).map((x) => sideZh(x.side) + ' ' + x.track + '：' + x.changes.map((c) => 't=' + Math.round(c.t) + 's ' + c.label).join('，')).join('；'),
      d.changes.map((c) => ({ t: c.t, text: d.track + ' → ' + c.label })));
  }

  if (tracks.late.length >= 4) {
    add('TRACK_CHURN', 'minor',
      '后半场新建 ' + tracks.late.length + ' 条航迹（' + tracks.late.map((x) => x.id).join('、') + '）',
      '同一批目标反复换号会让火控按 trackId 匹配的解算作废；t=' + Math.round(tracks.late[0].t) + 's 之后仍在持续新建航迹。',
      tracks.late.map((x) => ({ t: x.t, text: x.id + ' 由 ' + sideZh(x.side) + ' 建立' })));
  }

  const pair = {};
  for (const c of collisions) { const k = [c.a, c.b].sort().join('|'); (pair[k] = pair[k] || []).push(c); }
  for (const [k, list] of Object.entries(pair)) {
    if (list.length < 2) continue;
    const ids = k.split('|');
    const na = ships.get(ids[0]), nb = ships.get(ids[1]);
    add('COLLISION_REPEAT', 'minor',
      (na ? na.name : ids[0]) + ' 与 ' + (nb ? nb.name : ids[1]) + ' 相撞 ' + list.length + ' 次',
      '时间 ' + list.map((c) => Math.round(c.t) + 's').join(' / ') + '，相对速度 ' + list.map((c) => round1(c.relKn)).join('–') + ' kn；回放中没有对应的结构/进水损伤事件（碰撞是否应结算损伤需复核）。',
      list.map((c) => ({ t: c.t, text: '相撞 ' + round1(c.relKn) + ' kn' })));
  }

  for (const mg of damage.magazines) {
    if (mg.result !== 'detonation') continue;
    const before = torpedo.hits.filter((h) => h.ship === mg.ship && h.t <= mg.t && mg.t - h.t <= 180);
    add('MAGAZINE_DETONATION', 'major',
      (mg.name || mg.ship) + ' 弹药库殉爆' + (mg.killed ? '（' + fmtNum(mg.killed) + ' 人当场死亡）' : ''),
      't=' + fmtClock(mg.t) + (before.length ? '；此前 180 秒内有 ' + before.length + ' 条鱼雷命中该舰（' + before.map((h) => fmtClock(h.t) + (h.friendly ? ' 友军' : '')).join('、') + '）' : '') + '。',
      [{ t: mg.t, text: '弹药库' + (MAGAZINE_RESULT_ZH[mg.result] || mg.result) }]);
  }

  if (!meta.result.over || !meta.result.winner) {
    add('UNDECIDED', meta.sandbox ? 'info' : 'minor',
      '回放结束时未分胜负',
      'result=' + JSON.stringify(meta.result) + (meta.sandbox ? '；沙盒默认关闭胜负判定（sandboxNoVictory），战报到最后一秒也不会有赢家。' : '；可能因回放截断或剧本未设胜负条件。'),
      []);
  }

  for (const [sid, g] of Object.entries(gunnery.bySide)) {
    if (g.rounds >= 100 && pct(g.hits, g.rounds) < 5) {
      add('LOW_HIT_RATE', 'info',
        sideZh(sid) + ' 命中率 ' + fmtPct(g.hits, g.rounds) + '（' + fmtNum(g.rounds) + ' 发 / ' + g.hits + ' 中）',
        '低于 5% 的经验线；通常意味着「条令要求的交战距离」与「实际交战距离」脱节，或火控解算质量长期偏低。',
        []);
    }
  }

  for (const [sid, kinds] of Object.entries(orders.bySide)) {
    const total = Object.values(kinds).reduce((a, b) => a + b, 0);
    const smoke = kinds.SMOKE || 0;
    if (total >= 20 && smoke / total >= 0.5) {
      add('SMOKE_SPAM', 'info',
        sideZh(sid) + ' 的指令里有 ' + Math.round((smoke / total) * 100) + '% 是烟幕（' + smoke + '/' + total + '）',
        '烟幕同时遮断本方观测与火控，需确认 AI 的「被命中即施烟」没有变成自我致盲。',
        []);
    }
  }

  for (const s of ships.values()) {
    if (s.floodingPeak > 0 && s.pumpM3s > 0 && s.floodingPeak / s.pumpM3s >= 10) {
      add('DC_INFEASIBLE', 'minor',
        (s.name || s.id) + ' 进水 ' + round1(s.floodingPeak) + ' m³/s vs 排水 ' + round1(s.pumpM3s) + ' m³/s（' + Math.round(s.floodingPeak / s.pumpM3s) + ':1）',
        '损管再正确也无法改变结局；这类舰的存亡应主要由命中位置与舱段决定，而不是靠损管 AI 抢救。',
        []);
    }
  }

  for (const [sid, t] of Object.entries(torpedo.byShooter)) {
    const enemyHits = t.hits - t.friendlyHits;
    if (t.fired >= 4 && enemyHits === 0) {
      add('TORPEDO_WASTE', 'info',
        (t.name || sid) + ' 发射 ' + t.fired + ' 条鱼雷，0 命中敌方' + (t.friendlyHits ? '（' + t.friendlyHits + ' 条命中友军）' : ''),
        '鱼雷是稀缺资源；0 命中通常意味着射距/舷角/目标运动解算有问题，或安全走廊把可用窗口挤没了。',
        []);
    }
  }

  const gunFF = (m.gunFFEventCount || 0) || (m.gunFFHits ? m.gunFFHits.length : 0);
  if (gunFF > 0) {
    const list = (m.gunFFHits || []).slice(0, 3).map((h) => (h.byName || h.byShip) + ' → ' + (h.name || h.ship) + '（t=' + fmtClock(h.t) + '）').join('；');
    add('GUN_FRIENDLY_FIRE', 'major',
      '友军炮击误伤：' + gunFF + ' 次',
      (list ? '主要案例：' + list + '。' : '') + '炮击误伤通常来自火控航迹落在友舰上（识别/航迹问题），比鱼雷误伤更容易在混战中反复发生。',
      (m.gunFFHits || []).slice(0, 5).map((h) => ({ t: h.t, text: (h.byName || h.byShip) + ' → ' + (h.name || h.ship) })));
  }

  // ── 单舰在射程内长时间停火（全队静默之外的另一类：某艘舰自己哑了）────────
  const sideOfId = new Map([...ships.values()].map((x) => [x.id, x.side]));
  function minEnemyDist(shipId, t0, t1) {
    let best = Infinity, bestT = null;
    for (const f of (frames || [])) {
      if (f.t < t0 || f.t > t1) continue;
      const me = (f.ships || []).find((x) => x.id === shipId);
      if (!me || me.af === false) continue;
      for (const o of (f.ships || [])) {
        if (o.id === shipId || o.af === false) continue;
        if (sideOfId.get(o.id) === sideOfId.get(shipId)) continue;
        const d = Math.hypot(me.x - o.x, me.y - o.y) / 1000;
        if (d < best) { best = d; bestT = f.t; }
      }
    }
    return { km: best, t: bestT };
  }
  const silentShips = [];
  for (const sh of ships.values()) {
    if (sh.sank || sh.withdrew || (sh.turretsDestroyed || 0) >= 3 || !sh.fireTimes || sh.fireTimes.length < 2) continue;
    const ts = sh.fireTimes.slice().sort((a, b) => a - b);
    let gap = 0, from = ts[0], to = ts[0];
    for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; if (d > gap) { gap = d; from = ts[i - 1]; to = ts[i]; } }
    const tail = meta.endedAt - ts[ts.length - 1];
    if (tail > gap) { gap = tail; from = ts[ts.length - 1]; to = meta.endedAt; }
    if (gap < 300) continue;
    const ne = minEnemyDist(sh.id, from, to);
    if (!(ne.km <= 15)) continue;
    silentShips.push({ sh, gap, from, to, ne });
  }
  silentShips.sort((a, b) => b.gap - a.gap);
  if (silentShips.length) {
    const top = silentShips[0];
    const detail = silentShips.slice(0, 4).map((x) =>
      (x.sh.name || x.sh.id) + '：' + fmtClock(x.from) + '→' + fmtClock(x.to) + '（' + Math.round(x.gap) + ' 秒），期间最近敌舰 ' + round1(x.ne.km) + ' km'
    ).join('；') + '。这些舰主炮完好、未奉命脱离、仍在交战阶段，却长时间一炮未发——通常是「命中率门槛 × 远目标」把火力锁死，而不是没有目标。';
    add('SHIP_SILENT_IN_RANGE', top.gap >= 1200 ? 'major' : 'minor',
      silentShips.length + ' 艘军舰在射程内长时间停火（最长 ' + Math.round(top.gap) + ' 秒）',
      detail,
      silentShips.slice(0, 5).map((x) => ({ t: x.from, text: (x.sh.name || x.sh.id) + ' 静默开始（最近敌 ' + round1(x.ne.km) + ' km）' })));
  }

  // ── FIRE 指令空转：指令已生效，但该舰此后再没有打出过一发 ─────────────────
  if (fireOrders && fireOrders.length) {
    const stalled = [];
    for (const o of fireOrders) {
      const sh = ships.get(o.shipId);
      if (!sh || !sh.fireTimes || !sh.fireTimes.length) continue;
      if (!(o.tEffective > sh.lastFire + 1)) continue;
      if (o.tEffective > meta.endedAt - 30) continue;
      const ceasedSoon = (ceaseOrders || []).some((c) => c.shipId === o.shipId && c.t >= o.t && c.t - o.t <= 30);
      if (ceasedSoon) continue;
      stalled.push({ o, sh });
    }
    if (stalled.length) {
      add('FIRE_ORDER_STALLED', 'major',
        stalled.length + ' 条 FIRE 指令下达后一炮未发',
        stalled.slice(0, 3).map((x) => (x.sh.name || x.sh.id) + ' 在 ' + fmtClock(x.o.tEffective) + ' 奉命对 ' + (x.o.trackId || '?') + ' 开火，此后直到回放结束没有 gun.fire 记录').join('；') + '。指令被"接受"却没落到火控，AI 会以为自己在射击而不再重发。',
        stalled.slice(0, 5).map((x) => ({ t: x.o.tEffective, text: (x.sh.name || x.sh.id) + ' FIRE → ' + (x.o.trackId || '?') })));
    }
  }

  // ── 鱼雷效率：打得多、命中少、多数跑到射程尽头 ───────────────────────────
  if (torpedo.fired >= 20) {
    const rate = torpedo.hitsCount / torpedo.fired;
    const exhausted = torpedo.misses.filter((x) => x.reason === 'RANGE_EXHAUSTED').length;
    if (rate < 0.10 && exhausted >= Math.max(5, torpedo.misses.length * 0.5)) {
      add('TORPEDO_LOW_EFFICIENCY', 'minor',
        '鱼雷效率过低：' + torpedo.fired + ' 条仅命中 ' + torpedo.hitsCount + ' 条（' + fmtPct(torpedo.hitsCount, torpedo.fired) + '）',
        exhausted + ' 条鱼雷跑到射程尽头仍未命中（占未中记录 ' + fmtPct(exhausted, torpedo.misses.length || 1, 0) + '）。发射距离、提前角或目标机动估计存在系统偏差；也可能是慢速档（4–6 分钟飞行）给对手留了太多规避时间。',
        []);
    }
  }

  // ── 事件序号缺口（导出完整性）────────────────────────────────────────────
  if (seqGaps && seqGaps.length) {
    const r = meta.retention || {};
    add('EVENT_SEQ_GAP', 'info',
      '事件序号缺 ' + seqGaps.length + ' 处',
      '缺口位置：' + seqGaps.slice(0, 5).map((g) => g.prev + '→' + g.next).join('、') + (seqGaps.length > 5 ? '…' : '') +
      '。exportReplay() 会过滤 tick.major，但 retention 仍按全部 emit 计数（totalEmitted ' + fmtNum(r.totalEmitted) + ' vs 实际 ' + fmtNum(meta.events) + '），于是出现「0 丢弃 + 序号不连续」。建议 retention 记录被过滤数量。',
      seqGaps.slice(0, 5).map((g) => ({ t: g.t, text: '缺 seq ' + (g.prev + 1) })));
  }

  const sevRank = { critical: 0, major: 1, minor: 2, info: 3 };
  F.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]));
  return F;
}

function buildVerdict(m) {
  const sunk = [...m.ships.values()].filter((s) => s.sank);
  const friendlySink = sunk.filter((s) => m.torpedo.hits.some((h) => h.ship === s.id && h.friendly && h.t <= s.sank.t));
  let headline;
  if (friendlySink.length && friendlySink.length === sunk.length && sunk.length === 1) headline = '唯一沉没的军舰是被自己人击沉的';
  else if (friendlySink.length) headline = '有 ' + friendlySink.length + ' 艘军舰的沉没与友军火力直接相关';
  else if (sunk.length) headline = '共 ' + sunk.length + ' 艘军舰沉没';
  else headline = '没有军舰沉没';
  const parts = [];
  parts.push('「' + (m.meta.scenario || '未知剧本') + '」种子 ' + (m.meta.seed === undefined ? '?' : m.meta.seed) + '，历时 ' + Math.round(m.meta.duration) + ' 秒，' + m.ships.size + ' 艘参战');
  parts.push('沉没 ' + sunk.length + ' 艘，阵亡 ' + fmtNum(m.damage.totalCasualties) + ' 人');
  if (m.torpedo.fired) parts.push('鱼雷 ' + m.torpedo.fired + ' 条 / 命中 ' + m.torpedo.hitsCount + (m.torpedo.friendlyHits ? '（其中 ' + m.torpedo.friendlyHits + ' 条是友军）' : ''));
  if (m.gunnery.rounds) parts.push('炮弹 ' + fmtNum(m.gunnery.rounds) + ' 发 / 命中 ' + m.gunnery.hits + '（' + fmtPct(m.gunnery.hits, m.gunnery.rounds) + '）');
  return { headline, summary: parts.join('；') + '。' };
}

function scoreboard(m) {
  const bySide = {};
  for (const [sid, s] of Object.entries(m.sides)) {
    const ships = s.ships.map((id) => m.ships.get(id));
    bySide[sid] = {
      ships: ships.length,
      afloat: ships.filter((x) => !(x.sank || x.lost)).length,
      sunk: ships.filter((x) => x.sank).length,
      hits: m.gunnery.bySide[sid] ? m.gunnery.bySide[sid].hits : 0,
      rounds: m.gunnery.bySide[sid] ? m.gunnery.bySide[sid].rounds : 0,
      torpHits: ships.reduce((a, x) => a + x.torpHits, 0),
      friendlyTorpHits: ships.reduce((a, x) => a + x.torpFriendlyHits, 0),
      casualties: ships.reduce((a, x) => a + x.casualties, 0),
    };
  }
  return bySide;
}

// ── 时间线取样 ──────────────────────────────────────────────────────────────
function pickTimeline(list, max) {
  const rank = { 'ship.sink': 100, 'dam.magazine': 92, 'gun.friendlyfire': 95, 'torp.hit': 90, 'ship.capsize': 96, 'order.withdraw': 70, 'torp.dud': 86, 'gun.hit': 66, 'dam.fire': 60, 'torp.launch': 30, 'ship.collide': 55, 'victory': 100 };
  // 同一目标 5 秒内的连续炮击只留第一条（与 AAR 的去重口径一致），否则近战刷屏
  const lastHit = new Map();
  const dedup = [];
  for (const x of list) {
    if (x.kind === 'gun.hit') {
      const prev = lastHit.get(x.ship);
      if (prev !== undefined && x.t - prev < 5) continue;
      lastHit.set(x.ship, x.t);
    }
    dedup.push(x);
  }
  const sorted = dedup.sort((a, b) => (rank[b.kind] || 0) - (rank[a.kind] || 0) || b.t - a.t);
  const out = [], quota = {};
  for (const x of sorted) {
    if (out.length >= max) break;
    const q = quota[x.kind] || 0;
    const lim = x.kind === 'gun.hit' ? 8 : x.kind === 'torp.launch' ? 6 : x.kind === 'dam.fire' ? 5 : 10;
    if (q >= lim) continue;
    quota[x.kind] = q + 1;
    out.push(x);
  }
  return out.sort((a, b) => a.t - b.t);
}

const countBy = (arr, fn) => arr.reduce((acc, x) => { const k = fn(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
function phaseSeq(decisions) {
  const out = [];
  for (const d of decisions) {
    if (!d.phase) continue;
    const last = out[out.length - 1];
    if (!last || last.side !== d.side || last.phase !== d.phase) out.push({ t: d.t, side: d.side, phase: d.phase });
  }
  return out;
}

// ── 回归检查（--check）──────────────────────────────────────────────────────
export const CHECK_RULES = {
  'friendly-torpedo': '回放中不得出现友军鱼雷命中',
  'no-long-silence': '任何一方在仍有军舰在航时，不得出现 ≥120 秒的开火静默',
  'track-stability': '同一航迹的判型改判不得超过 2 次',
};
export function checkReplay(model, rules = Object.keys(CHECK_RULES)) {
  const rows = [];
  for (const r of rules) {
    if (r === 'friendly-torpedo') {
      const n = model.findings.find((f) => f.code === 'TORP_FRIENDLY_FIRE');
      rows.push({ rule: r, ok: !n, detail: n ? n.title : '无友军鱼雷命中' });
    } else if (r === 'no-long-silence') {
      const f = model.findings.filter((x) => x.code === 'SIDE_SILENCE');
      rows.push({ rule: r, ok: !f.length, detail: f.length ? f.map((x) => x.title).join('；') : '无超长静默' });
    } else if (r === 'track-stability') {
      const bad = model.tracks.identityDrift.filter((x) => x.changes.length - 1 > 2);
      rows.push({ rule: r, ok: !bad.length, detail: bad.length ? bad.map((x) => x.track + ':' + x.labels.join('→')).join('；') : '航迹判型稳定' });
    } else {
      rows.push({ rule: r, ok: true, detail: '（未知规则，跳过）' });
    }
  }
  return { ok: rows.every((x) => x.ok), rows };
}
