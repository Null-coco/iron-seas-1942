// World：仿真宿主。固定步长、确定性、可回放。
import { clamp, normDeg, normDeg180, mps2kn, kn2mps, dist2d, bearing2d, destPoint, nm2m } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { EventBus } from '../core/events.js';
import { GeoPlane } from '../core/geo.js';
import { Ship } from './ship.js';
import { Environment, seaStateFromWind } from './env.js';
import { TrackManager } from './tracks.js';
import { Land } from './land.js';
import { DepthField } from './depth.js';
import { updateKinematics } from './dynamics.js';
import { updateDamage, applyDamageControl, applyHit } from './damage.js';
import { updateSensors, deployChaff } from './sensors.js';
import { updateSpotting } from './spotting.js';
import { updateFireControl } from './gunnery.js';
import { updateProjectiles } from './ballistics.js';
import { updateTorpedoes, launchTorpedo } from './torpedo.js';
import { AICommander } from '../ai/bridge.js';

let WORLD_SEQ = 0;

// ---------------------------------------------------------------------------
// 事件历史保留策略（战报 / AAR / 回放的关键事件不丢）
// ---------------------------------------------------------------------------
// 旧实现直接 new EventBus(60000)：满 6 万条后按时间 FIFO 静默截断。40 分钟、20 舰的
// 第一次瓜岛局事件量正好触顶，最开头的 sim.start / 首轮命中 / 沉没被丢掉，
// exportReplay() 于是丢失回放开头、AAR 统计少算。
//
// 现在按「关键事件优先」保留：
//   · 关键事件（sim.* / victory.* / ship.* / torp.* / dam.* 以及
//     gun.hit|bounce|penetration|nearmiss|straddle、order.issue|effective|reject、
//     ai.fallback|error 等）永不被高频噪声挤出；
//   · 高频噪声（gun.fire / gun.miss / gun.salvo.away / fc.solution / fc.update /
//     fc.ladder / sensor.detect|lose|visual.* / ai.decision …）只在超限时按最旧优先
//     淘汰 —— 即"近期保留 + 低频化"，不改变短局（未触顶）的字节级行为；
//   · 关键事件本身超过 hardLimit(=2×limit) 这种极端情况才丢最旧关键事件，
//     并计入 droppedCritical 由 exportReplay().retention / 战报显式暴露，绝不静默。
const CRITICAL_EVENT_PREFIXES = ['sim.', 'victory.', 'ship.', 'torp.', 'dam.'];
const CRITICAL_EVENT_TYPES = new Set([
  'gun.hit', 'gun.penetration', 'gun.bounce', 'gun.nearmiss', 'gun.straddle', 'gun.terrain', 'gun.friendlyfire',
  'order.issue', 'order.effective', 'order.reject', 'sensor.chaff',
  'scenario.trigger', 'scenario.message',
  'ai.fallback', 'ai.error', 'ai.connected', 'ai.disconnected',
]);

// 关键事件判定：契约见 ARCHITECTURE §3 事件名；新增事件默认按噪声处理（仍保留近期窗口）
export function isCriticalEvent(type) {
  const s = String(type || '');
  for (const p of CRITICAL_EVENT_PREFIXES) if (s.startsWith(p)) return true;
  return CRITICAL_EVENT_TYPES.has(s);
}

class RetainingEventBus extends EventBus {
  constructor(limit = 60000) {
    super(limit);
    this.hardLimit = limit * 2;     // 关键事件的绝对上限（防止无限内存）
    this.emitted = {};              // 累计 emit 次数（按类型，不受历史截断影响 → 战报统计口径）
    this.kept = {};                 // 历史里实际保留的次数（按类型）
    this.droppedNoise = 0;          // 被淘汰的噪声事件数
    this.droppedCritical = 0;       // 被淘汰的关键事件数（>0 说明真正丢了信息）
    this.noiseCount = 0;            // 历史里当前噪声事件条数（用于 O(1) 判定"全是关键事件"）
    this.firstCriticalT = null;     // 第一个关键事件的仿真时刻（自检：应 <= 10s，正常为 0）
  }
  emit(type, payload = {}) {
    const critical = isCriticalEvent(type);
    const ev = { seq: ++this.seq, type, t: payload.t !== undefined ? payload.t : null, ...payload };
    this.emitted[type] = (this.emitted[type] || 0) + 1;
    this.kept[type] = (this.kept[type] || 0) + 1;
    if (critical && this.firstCriticalT === null) this.firstCriticalT = ev.t;
    if (!critical) this.noiseCount++;
    this.history.push(ev);
    // 1) 超限先从最旧的噪声事件开始淘汰；关键事件不动（history 按 seq 升序）
    //    noiseCount===0 时直接跳过扫描（全是关键事件，避免 O(n) 空转）
    while (this.history.length > this.limit && this.noiseCount > 0) {
      let i = 0;
      while (i < this.history.length && isCriticalEvent(this.history[i].type)) i++;
      if (i >= this.history.length) { this.noiseCount = 0; break; }   // 只剩关键事件 → 交给 hardLimit
      const [dropped] = this.history.splice(i, 1);
      this.kept[dropped.type]--;
      this.noiseCount--;
      this.droppedNoise++;
    }
    // 2) 极端兜底：关键事件自身超过 hardLimit 时丢最旧的关键事件并记账（绝不静默）
    while (this.history.length > this.hardLimit) {
      const dropped = this.history.shift();
      this.kept[dropped.type]--;
      if (isCriticalEvent(dropped.type)) this.droppedCritical++;
      else { this.noiseCount = Math.max(0, this.noiseCount - 1); this.droppedNoise++; }
    }
    const s = this.handlers.get(type); if (s) for (const f of s) { try { f(ev); } catch (e) { console.error('[event]', type, e); } }
    const a = this.handlers.get('*'); if (a) for (const f of a) { try { f(ev); } catch (e) { console.error('[event*]', type, e); } }
    return ev;
  }
  clear() {
    super.clear();
    this.emitted = {}; this.kept = {};
    this.droppedNoise = 0; this.droppedCritical = 0; this.noiseCount = 0; this.firstCriticalT = null;
  }
  totalEmitted() { return Object.keys(this.emitted).reduce((a, k) => a + this.emitted[k], 0); }
  // 战报/自检用：一目了然的保留账本
  retention() {
    return {
      limit: this.limit, hardLimit: this.hardLimit, history: this.history.length,
      totalEmitted: this.totalEmitted(), droppedNoise: this.droppedNoise, droppedCritical: this.droppedCritical,
      firstCriticalT: this.firstCriticalT, firstEventT: this.history.length ? this.history[0].t : null,
      emitted: Object.assign({}, this.emitted), kept: Object.assign({}, this.kept),
    };
  }
}

// 海况 → 风速反查（SET_ENV 触发器用；env 的海况由风浪谱导出，不能直接写 seaState）
function windKnForSeaState(target) {
  let best = 12, bestD = 1e9;
  for (let w = 0; w <= 60; w += 0.5) {
    const d = Math.abs(seaStateFromWind(w) - target);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

export class World {
  constructor(opts = {}) {
    this.uid = ++WORLD_SEQ;
    this.scenario = opts.scenario || { id: 'sandbox', nameZh: '沙盒', objectives: [], sides: {} };
    this.database = opts.database;
    this.seed = opts.seed === undefined ? 19420604 : opts.seed;
    this.rng = new RNG(this.seed);
    this.events = new RetainingEventBus(60000);
    this.t = 0;
    this.tickCount = 0;
    this.dt = 0.1;
    this.timeScale = 1;
    this.paused = false;
    this.over = false;
    this.winner = null;
    this.resultText = '';
    this.playerSide = opts.playerSide || 'ALLIED';
    this.ships = [];
    this.projectiles = [];
    this.torpedoes = [];
    this.splashes = [];       // 落水水柱（视觉与校射共用）
    this.salvoes = new Map();  // 齐射记录（ballistics/spotting 共用，用于夹叉判定与观测）
    this.commands = [];
    this.pending = [];
    this.chatLog = [];
    this.orderDelay = { ALLIED: 6, AXIS: 8 };
    this.radioRelayPenaltyS = 9;
    this.timeExtensionS = 0;      // 玩家累计延长的交战时长
    this.holdObjectivesUntil = -1; // 在此之前不因战役目标判定结束（舰队全灭仍然结束）
    this._triggersFired = new Set();   // scenario.triggers 已触发记账（once 语义）

    const sp = this.scenario.start || {};
    this.geo = new GeoPlane(sp.lat !== undefined ? sp.lat : 0, sp.lon !== undefined ? sp.lon : 0);
    this.env = new Environment(Object.assign({ lat: sp.lat || 0, lon: sp.lon || 0, seed: this.seed, date: sp.date || '1942-06-01T12:00:00Z' }, sp.env || {}));
    this.tracks = new TrackManager(this);
    // 陆地（真实海岸线，Natural Earth 10m 按剧本裁剪）：宿主加载 data/land.json 后经 opts.landData 传入
    const landEntry = opts.landData ? ((opts.landData.scenarios && opts.landData.scenarios[this.scenario.id]) || opts.landData) : null;
    this.land = new Land(landEntry);
    // 水深场：宿主加载 data/depth.json 后经 opts.depthData 传入
    const depthEntry = opts.depthData ? ((opts.depthData.scenarios && opts.depthData.scenarios[this.scenario.id]) || opts.depthData) : null;
    this.depth = new DepthField(depthEntry, this.land);

    this.sides = {};
    for (const s of ['ALLIED', 'AXIS']) {
      const meta = (this.scenario.sides && this.scenario.sides[s]) || {};
      this.sides[s] = {
        side: s, nameZh: meta.nameZh || (s === 'ALLIED' ? '同盟国' : '轴心国'),
        objective: meta.objective || '', orderDelay_s: meta.orderDelay_s !== undefined ? meta.orderDelay_s : this.orderDelay[s],
        aiBackend: meta.aiBackend || 'LOCAL', withdrawThreshold: meta.withdrawThreshold !== undefined ? meta.withdrawThreshold : 0.35,
      };
    }

    this.record = { seed: this.seed, scenarioId: this.scenario.id, startedAt: this.t, snapshots: [], events: [], commands: [], finalAt: null };
    this.stepCounter = 0;
    this._lastSnapshotT = -1e9;
    this._lastMajorT = -1e9;
    this._eventMirror = [];
    this.events.onAny((ev) => { this._eventMirror.push({ seq: ev.seq, type: ev.type, t: ev.t === null ? this.t : ev.t }); if (this._eventMirror.length > 4000) this._eventMirror.splice(0, 800); });

    if (opts.buildFromScenario !== false) this.buildFromScenario();
    this.ai = {};
    if (opts.ai !== false) {
      for (const s of ['ALLIED', 'AXIS']) this.ai[s] = new AICommander(s, this, Object.assign({ backend: this.sides[s].aiBackend }, opts.aiOpts));
    }
    this.events.emit('sim.start', { t: 0, scenario: this.scenario.id, seed: this.seed });
  }

  // ---------------- 剧本装配 ----------------
  buildFromScenario() {
    const list = this.scenario.ships || [];
    for (const spec of list) {
      const data = this.database ? this.database.resolve(spec.class || spec.shipClass || spec.id) : null;
      if (!data) { console.warn('[world] 未知舰船:', spec.class || spec.id); continue; }
      let x = spec.x, y = spec.y;
      if (spec.lat !== undefined && spec.lon !== undefined) { const p = this.geo.fromLatLon(spec.lat, spec.lon); x = p.x; y = p.y; }
      const ship = new Ship(Object.assign({}, spec, { x: x || 0, y: y || 0 }), data, {});
      if (spec.ammo) for (const b of ship.batteries) Object.assign(b.ammo, spec.ammo[b.role] || {});
      this.ships.push(ship);
    }
    // 开局位置若落在陆地（港口/岸线误差），移到最近水域并广播
    for (const s of this.ships) {
      if (this.land && this.land.pushOut(s.pos, 4000)) {
        this.events.emit('ship.grounded', { t: 0, ship: s.id, name: s.name, side: s.side, note: '开局位于陆地，已移至最近水域', moved: true });
      }
    }
    return this;
  }

  addShipById(classRef, spec) {
    const data = this.database.resolve(classRef);
    if (!data) throw new Error('未知舰船: ' + classRef);
    const ship = new Ship(spec, data, {});
    this.ships.push(ship);
    return ship;
  }

  // ---------------- 主循环 ----------------
  step(dt) {
    dt = clamp(dt || this.dt, 0.001, 0.25);
    this.t += dt;
    this.tickCount++;
    this.env.step(dt, this);   // 传入 world 让环境层更新烟幕源（T1 契约）
    this.applyDueCommands();

    for (const s of this.ships) {
      if (s.isAfloat) updateDamage(s, this, dt);
    }
    for (const s of this.ships) {
      if (!s.isAfloat) { this._progressSinking(s, dt); continue; }
      // 关键：进水/倾覆导致 sinking=true 时 isAfloat 仍为 true，必须同样推进沉没计时，
      // 否则军舰会永远停在 80° 横倾而不沉（T6 在萨沃岛剧本中发现）。
      if (s.sinking) this._progressSinking(s, dt);
      updateKinematics(s, this, dt);
    }
    this._checkGrounding(dt);
    this._resolveCollisions(dt);
    for (const s of this.ships) if (s.isAfloat) updateSensors(s, this, dt);
    this.tracks.update(dt);
    for (const s of this.ships) if (s.isAfloat) updateFireControl(s, this, dt);
    updateProjectiles(this, dt);
    updateTorpedoes(this, dt);
    for (const s of this.ships) if (s.isAfloat) updateSpotting(s, this, dt);
    this._updateSmoke(dt);
    this.aiTick(dt);
    this._evalTriggers();
    this._record(dt);
    this.checkObjectives();
  }

  // 外部以固定步长推进：advance(simSeconds)
  advance(simSeconds) {
    let left = simSeconds;
    let guard = 0;
    while (left > 1e-6 && guard++ < 200000) {
      const h = Math.min(this.dt, left);
      this.step(h);
      left -= h;
      if (this.over) break;
    }
    return this;
  }

  // 搁浅：位置落在陆地上 → 立即失速、推离、按撞击速度造成艏部破损与进水
  _checkGrounding(dt) {
    if (!this.land || this.land.empty) return;
    for (const s of this.ships) {
      if (!s.isAfloat) continue;
      const onLand = this.land.isLandExact(s.pos.x, s.pos.y);
      // 浅滩搁浅：水深不足吃水 + 富裕水深（战列舰吃水 10m，驱逐舰 4m，差别就在这里体现）
      const draft = s.draftM || 6;
      const depthHere = this.depth && !this.depth.empty ? this.depth.depthAt(s.pos.x, s.pos.y) : 9999;
      const onShoal = !onLand && depthHere < draft + 0.3;
      if (!onLand && !onShoal) { s._grounded = false; s._aground = false; continue; }
      const spd = s.speed;
      s.speed = 0;
      s._grounded = true;
      const moved = onLand ? this.land.pushOut(s.pos, 2000) : false;
      if (onShoal && !s._aground) {
        s._aground = true;
        this.events.emit('ship.shoal', { t: this.t, ship: s.id, name: s.name, side: s.side, depthM: +depthHere.toFixed(1), draftM: +draft.toFixed(1) });
        this._major(s.name + ' 触底（水深 ' + depthHere.toFixed(1) + 'm < 吃水 ' + draft.toFixed(1) + 'm）');
      }
      if (spd > 2 && this.t - (s._lastGroundDmg || -1e9) > 20) {
        s._lastGroundDmg = this.t;
        const c = s.compartments[0];
        c.integrity = Math.max(0, c.integrity - 0.25);
        c.breached = true;
        this.events.emit('ship.grounding', { t: this.t, ship: s.id, name: s.name, side: s.side, speedKn: +spd.toFixed(1), moved });
        this._major(s.name + ' 搁浅');
      }
    }
  }

  _resolveCollisions(dt) {
    for (let i = 0; i < this.ships.length; i++) {
      const a = this.ships[i]; if (!a.isAfloat) continue;
      for (let j = i + 1; j < this.ships.length; j++) {
        const b = this.ships[j]; if (!b.isAfloat) continue;
        const d = dist2d(a.pos, b.pos);
        const ra = (a.data.loa_m || 100) / 2, rb = (b.data.loa_m || 100) / 2;
        if (d < (ra + rb) * 0.6) {
          // 真实相对速度用速度矢量之差：旧实现 |vA|-|vB|+2 把横越相撞（两舰各 20 kn、
          // 航向相反）算成 2 kn，于是碰撞永远只是减速。实测 sandbox 种子 604 里
          // 高雄与阳炎 75–101 s 相撞 6 次、相对速度 5.8–9.5 kn，却零损伤结算。
          const DEG = Math.PI / 180;
          const vax = kn2mps(a.speed) * Math.sin(a.heading * DEG), vay = kn2mps(a.speed) * Math.cos(a.heading * DEG);
          const vbx = kn2mps(b.speed) * Math.sin(b.heading * DEG), vby = kn2mps(b.speed) * Math.cos(b.heading * DEG);
          const relMps = Math.hypot(vax - vbx, vay - vby);
          const relKn = mps2kn(relMps);
          this.events.emit('ship.collide', { t: this.t, a: a.id, b: b.id, rel: +(relKn * 0.514).toFixed(2), relKn: +relKn.toFixed(1), relMps: +relMps.toFixed(2) });
          a.speed *= 0.4; b.speed *= 0.4;
          const p = destPoint(a.pos, ra * 0.6, bearing2d(a.pos, b.pos));
          a.pos = { x: a.pos.x - (p.x - a.pos.x) * 0.6, y: a.pos.y - (p.y - a.pos.y) * 0.6 };
          // ── 碰撞损伤结算 ────────────────────────────────────────────────
          // 相对速度 > 4 kn 才造成实质破损（低速擦碰仍只减速）。走与炮弹/鱼雷同一条
          // damage.applyHit 管线，破口/进水/结构强度/子系统降级口径保持一致。
          // 同一对舰 15 s 内只结算一次，避免两舰贴住时每个 0.1 s 都吃一次伤害。
          if (relKn <= 4) continue;
          const pair = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
          this._collidePairAt = this._collidePairAt || new Map();
          if (this.t - (this._collidePairAt.get(pair) || -1e9) < 15) continue;
          this._collidePairAt.set(pair, this.t);
          const equivKg = clamp(8 * relKn, 40, 320);   // 相撞当量：40–320 kg TNT（随相对速度）
          for (const [self, other] of [[a, b], [b, a]]) {
            const brg = bearing2d(self.pos, other.pos);
            const xf = clamp(0.5 + 0.16 * Math.cos((brg - self.heading) * DEG), 0.12, 0.88);
            try {
              applyHit(this, {
                kind: 'COLLISION', ship: self.id, xFrac: xf, hitPart: 'BELT',
                penetrates: true, armorMM: 0, penetrationMM: 9999,
                caliberMM: 300, shellMassKg: 2000, energyMJ: 0.5 * 2000 * relMps * relMps / 1e6,
                warheadKg: equivKg, tntKg: equivKg, ammoKind: 'AP',
                sideBias: Math.sign(Math.sin((brg - self.heading) * DEG)) || 1,
                depthM: 1.5, isCollision: true,
                killerShipId: other.id, killerSide: other.side, killerName: other.name,
              });
            } catch (e) { /* 碰撞损伤结算失败不应中断仿真 */ }
          }
        }
      }
    }
  }

  _progressSinking(ship, dt) {
    if (!ship.sinking || ship.sunkAt !== null) return;
    ship.sinkTimer += dt;
    ship.speed = clamp(ship.speed - dt * 0.35, 0, 99);
    ship.list = clamp(ship.list + Math.sign(ship.list || 1) * dt * 1.6, -89, 89);
    const tSink = 40 + (ship.displacement_t || 2000) / 900;
    if (ship.sinkTimer > tSink) {
      ship.isAfloat = false; ship.sunkAt = this.t;
      this.events.emit('ship.sink', { t: this.t, ship: ship.id, name: ship.name, side: ship.side, x: ship.pos.x, y: ship.pos.y, list: ship.list });
      this._major(ship.name + ' 沉没');
    }
  }

  _updateSmoke(dt) {
    for (const s of this.ships) {
      if (!s.isAfloat) continue;
      let target = 0;
      if (s.flags.smokeOn) target += 0.85;
      const burning = s.compartments.filter((c) => c.fire > 0.15).length;
      target += clamp(burning / 6, 0, 0.9);
      if (s.damageSmoke) target += s.damageSmoke;
      s.flags.smokeIntensity = s.flags.smokeIntensity + (clamp(target, 0, 1.6) - s.flags.smokeIntensity) * clamp(dt * 0.25, 0, 1);
    }
  }

  // ---------------- 指挥链 ----------------
  issueCommand(cmd, opts = {}) {
    const side = cmd.side || (cmd.shipId ? (this.ship(cmd.shipId) || {}).side : null);
    const meta = this.sides[side] || { orderDelay_s: 8 };
    let delay = meta.orderDelay_s;
    const ship = cmd.shipId ? this.ship(cmd.shipId) : null;
    if (cmd.scope === 'FLEET') delay += 5;
    if (ship) {
      const flag = this.ships.find((s) => s.side === side && s.role === 'flagship' && s.isAfloat);
      if (flag && flag !== ship) {
        const d = dist2d(flag.pos, ship.pos);
        const radioHorizon = 4.12 * Math.sqrt((flag.data.mastHeight_m || 20) + (ship.data.mastHeight_m || 20)) * 1852 * 1.05;
        if (d > radioHorizon) delay += this.radioRelayPenaltyS;
      }
    }
    const full = Object.assign({ id: 'c' + (this.commands.length + 1), t_issue: this.t, t_effective: this.t + delay, source: 'PLAYER', issuer: '旗舰' }, cmd, { side });
    // 玩家/外部指挥官的命令视为"上级指令"：本地 AI 在保持窗内不得覆盖（LocalAI.order 读取 _directiveSim）
    if (full.source !== 'AI_LOCAL') {
      if (full.shipId) { const sh = this.ship(full.shipId); if (sh) sh._directiveSim = this.t; }
      else for (const s of this.shipsOf(side)) s._directiveSim = this.t;
    }
    this.commands.push(full);
    this.pending.push(full);
    this.record.commands.push({ t: this.t, kind: full.kind, shipId: full.shipId, params: full.params, source: full.source, t_effective: full.t_effective });
    this.events.emit('order.issue', { t: this.t, cmd: full, delay });
    return full;
  }

  applyDueCommands() {
    if (!this.pending.length) return;
    const still = [];
    for (const c of this.pending) {
      if (c.t_effective <= this.t) {
        const applied = this._applyOne(c);
        this.events.emit('order.effective', { t: this.t, cmd: c, applied });
      } else still.push(c);
    }
    this.pending = still;
  }

  _applyOne(cmd) {
    if (cmd.kind === 'CHAFF') {
      const ship = this.ship(cmd.shipId);
      if (!ship || !ship.isAfloat) return false;
      const cloud = deployChaff(this, ship, cmd.params || {});
      this.events.emit('sensor.chaff', { t: this.t, ship: ship.id, side: ship.side, x: ship.pos.x, y: ship.pos.y, ok: !!cloud });
      return !!cloud;
    }
    if (cmd.kind === 'DC_PRIORITY' || cmd.kind === 'DAMAGE_CONTROL' || cmd.kind === 'FLOOD_MAGAZINE' || cmd.kind === 'COUNTERFLOOD' || cmd.kind === 'PLUG') {
      const ship = this.ship(cmd.shipId);
      if (!ship || !ship.isAfloat) return false;
      try { return !!applyDamageControl(ship, cmd); } catch (e) { return ship.applyOrder(cmd); }
    }
    if (cmd.kind === 'CHAT') {
      this.chatLog.push({ t: this.t, side: cmd.side, from: cmd.issuer || 'AI', text: (cmd.params && cmd.params.text) || '' });
      this.events.emit('ai.chat', { t: this.t, side: cmd.side, from: cmd.issuer, text: (cmd.params && cmd.params.text) || '' });
      return true;
    }
    if (cmd.kind === 'LAUNCH_TORPEDO') {
      const ship = this.ship(cmd.shipId);
      if (!ship || !ship.isAfloat) return false;
      const p = cmd.params || {};
      const tr = p.trackId ? this.tracks.byId(p.trackId) : null;
      const bearingTo = p.bearingDeg !== undefined ? p.bearingDeg : (tr ? bearing2d(ship.pos, tr.pos) : null);
      // 选管：显式指定则用之；否则选"最指向目标"的那一舷（真实做法：打能指向的舷侧）
      let mount = null;
      if (p.mount !== undefined && p.mount !== null) {
        mount = ship.torpedoMounts.find((m) => !m.destroyed && m.tubesLoaded > 0 && (m.id === p.mount || m.label === p.mount));
      }
      if (!mount) {
        let bestD = 1e9;
        for (const m of ship.torpedoMounts) {
          if (m.destroyed || m.tubesLoaded <= 0) continue;
          if (bearingTo === null) { mount = m; break; }
          const rel = normDeg180(bearingTo - ship.heading);
          const off = m.offsetDeg !== undefined ? m.offsetDeg : (m.id === 'torp0' ? 90 : -90);
          const d = Math.abs(normDeg180(rel - off));
          if (d < bestD) { bestD = d; mount = m; }
        }
      }
      if (!mount) return false;
      const sol = {
        bearingDeg: p.bearingDeg, rangeM: p.rangeM !== undefined ? p.rangeM : (tr ? dist2d(ship.pos, tr.pos) : 0),
        spreadDeg: p.spreadDeg, tubes: p.tubes, speedIdx: p.speedIdx, depthM: p.depthM,
        targetTrackId: p.trackId, targetCourseDeg: tr ? tr.courseDeg : undefined, targetSpeedKn: tr ? tr.speedKn : undefined,
      };
      const ok = !!launchTorpedo(this, ship, mount, sol, { targetTrack: tr, source: 'CMD' });
      this.events.emit('torp.launch', { t: this.t, ship: ship.id, side: ship.side, name: ship.name, mount: mount.id, mountLabel: mount.label,
        tubes: sol.tubes || mount.tubesLoaded, track: sol.targetTrackId || null, depthM: sol.depthM || null, speedIdx: sol.speedIdx !== undefined ? sol.speedIdx : null,
        spreadDeg: sol.spreadDeg || null, bearingDeg: sol.bearingDeg !== undefined ? sol.bearingDeg : null, accepted: ok });
      return ok;
    }
    if (cmd.kind === 'ASSIGN_TARGET') {
      const ship = this.ship(cmd.shipId); if (!ship) return false;
      const tr = this.tracks.byId(cmd.params.trackId);
      if (tr) { ship.commanded.targetTrackId = tr.id; ship.commanded.firing = true; ship.commanded.fireAmmo = cmd.params.ammo || 'AP'; }
      return true;
    }
    const ship = this.ship(cmd.shipId);
    if (!ship || !ship.isAfloat) return false;
    return ship.applyOrder(cmd);
  }

  ship(id) { return this.ships.find((s) => s.id === id) || null; }
  shipsOf(side) { return this.ships.filter((s) => s.side === side); }
  afloatOf(side) { return this.ships.filter((s) => s.side === side && s.isAfloat); }
  sideOf(shipId) { const s = this.ship(shipId); return s ? s.side : null; }
  opposite(side) { return side === 'ALLIED' ? 'AXIS' : 'ALLIED'; }

  // ---------------- AI ----------------
  aiTick(dt) {
    if (!this.ai) return;
    for (const k of Object.keys(this.ai)) { try { this.ai[k].tick(this, dt); } catch (e) { console.error('[ai]', k, e); } }
  }

  // ---------------- 记录 / 回放 ----------------
  _record(dt) {
    if (this.t - this._lastSnapshotT >= 5) {
      this._lastSnapshotT = this.t;
      this.record.snapshots.push(this.snapshot());
      if (this.record.snapshots.length > 20000) this.record.snapshots.splice(0, 2000);
    }
  }
  snapshot() {
    return {
      t: +this.t.toFixed(2),
      ships: this.ships.map((s) => ({
        id: s.id, x: +s.pos.x.toFixed(1), y: +s.pos.y.toFixed(1), hd: +s.heading.toFixed(1),
        sp: +s.speed.toFixed(2), list: +s.list.toFixed(1), fl: Math.round(s.floodedM3),
        af: s.isAfloat, fires: s.compartments.filter((c) => c.fire > 0.05).length,
      })),
      env: { seaState: +this.env.seaState.toFixed(1), windDir: Math.round(this.env.windDirDeg), windKn: +this.env.windKn.toFixed(1), visNm: +this.env.visibilityNm.toFixed(1) },
    };
  }
  exportReplay() {
    const tickMajorExcluded = (this.events.emitted && this.events.emitted['tick.major']) || 0;
    const evs = this.events.history.filter((e) => e.type !== 'tick.major');
    // 过滤 tick.major 后重排 seq：否则回放事件序号出现缺口（tick.major 占了 seq 但被滤掉），
    // 与 retention.totalEmitted 对不上，会让做完整性校验的人怀疑回放被动过手脚。
    for (let i = 0; i < evs.length; i++) evs[i] = Object.assign({}, evs[i], { seq: i + 1 });
    // 自检：关键事件必须从 t=0 起就在回放里（旧版 60000 截断会让首个关键事件晚到几分钟）
    let firstCriticalT = null;
    for (const e of evs) if (isCriticalEvent(e.type)) { firstCriticalT = e.t === null ? 0 : e.t; break; }
    const retention = typeof this.events.retention === 'function'
      ? Object.assign(this.events.retention(), { firstCriticalT, tickMajorExcluded, replayEvents: evs.length })
      : { firstCriticalT, history: evs.length };
    return { version: 1, scenario: this.scenario.id, seed: this.seed, startedAt: 0, endedAt: this.t, snapshots: this.record.snapshots, events: evs, commands: this.record.commands, result: { over: this.over, winner: this.winner, text: this.resultText }, retention };
  }

  _major(text) {
    if (this.t - this._lastMajorT < 1) return;
    this._lastMajorT = this.t;
    this.events.emit('tick.major', { t: this.t, text });
  }

  // ---------------- 胜负 ----------------
  // 延长交战：+seconds 秒；若交战已结束则恢复继续打
  extendBattle(seconds) {
    const add = Math.max(60, Math.round(seconds || 1800));
    this.timeExtensionS = (this.timeExtensionS || 0) + add;
    this.holdObjectivesUntil = this.t + add;
    const resumed = this.over;
    this.over = false; this.winner = null; this.resultText = ''; this.record.finalAt = null;
    this.events.emit('sim.extended', { t: this.t, addedS: add, totalS: this.timeExtensionS, resumed });
    this._major('交战延长 ' + Math.round(add / 60) + ' 分钟');
    return { addedS: add, totalS: this.timeExtensionS, holdUntil: this.holdObjectivesUntil, resumed };
  }

  checkObjectives() {
    if (this.over) return;
    // 沙盒模式（sandbox+sandboxNoVictory）：不按「编队全灭 / 战役目标」自动判定胜负，
    // 由玩家显式结束或外部指令收尾；其他剧本行为完全不变。
    if (this.scenario && this.scenario.sandbox && this.scenario.sandboxNoVictory) return;
    const objs = this.scenario.objectives || [];
    for (const side of ['ALLIED', 'AXIS']) {
      const mine = this.shipsOf(side);
      const alive = mine.filter((s) => s.isAfloat);
      if (mine.length > 0 && alive.length === 0) return this._finish(this.opposite(side), (this.sides[side].nameZh) + ' 编队全灭');
    }
    if (this.t < (this.holdObjectivesUntil || -1)) return;   // 玩家选择了延长交战：暂不按战役目标结束
    for (const o of objs) {
      if (o.active === false) continue;        // 未激活的目标不参与判定（由 ACTIVATE_OBJECTIVE 触发器激活）
      if (!this._objectiveMet(o)) continue;
      this._finish(o.result || o.side, o.text || '达成战役目标');
      return;
    }
  }

  // ---------------- 剧本触发器（scenario.triggers） ----------------
  // 结构：[{ id, at?: 仿真秒, when?: 条件, whenAll?: [条件], whenAny?: [条件], once?: true, action }]
  // 条件复用 objectives 的 condition schema（SINK/SINK_ANY/DISABLE/SINK_COUNT/SURVIVE/EXIT/PROTECT）。
  // 动作：ORDER（source:'SCRIPT' 命令）/ SET_ENV（风、风向、能见度、海况）/ ACTIVATE_OBJECTIVE / MESSAGE。
  _evalTriggers() {
    const list = this.scenario && this.scenario.triggers;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      if (!tr) continue;
      const id = tr.id || ('tr' + i);
      if (tr.once !== false && this._triggersFired.has(id)) continue;
      let fire = false;
      if (tr.at !== undefined) fire = this.t >= tr.at;
      else if (tr.when) fire = this._conditionMet(tr.when);
      else if (tr.whenAll) fire = tr.whenAll.every((c) => this._conditionMet(c));
      else if (tr.whenAny) fire = tr.whenAny.some((c) => this._conditionMet(c));
      if (!fire) continue;
      this._triggersFired.add(id);
      this._applyTrigger(tr, id);
    }
  }
  _conditionMet(cond) {
    if (!cond || !cond.type) return false;
    try { return !!this._objectiveMet({ condition: cond, side: cond.side || 'ALLIED' }); } catch (e) { return false; }
  }
  _applyTrigger(tr, id) {
    const a = tr.action || {};
    this.events.emit('scenario.trigger', { t: this.t, id, kind: a.kind || 'NONE' });
    if (a.kind === 'ORDER') {
      const issuer = a.issuer || '剧本';
      const params = a.params || {};
      if (a.shipId) {
        const s = this.ship(a.shipId);
        if (s && s.isAfloat) this.issueCommand({ side: s.side, shipId: s.id, kind: a.order, params, scope: a.scope || 'SHIP', source: 'SCRIPT', issuer }, {});
      } else if (a.side) {
        for (const s of this.afloatOf(a.side)) this.issueCommand({ side: s.side, shipId: s.id, kind: a.order, params, scope: a.scope || 'SHIP', source: 'SCRIPT', issuer }, {});
      }
    } else if (a.kind === 'SET_ENV') {
      const env = this.env;
      if (a.windKn !== undefined) { env.windKn = a.windKn; env._windTargetKn = a.windKn; }
      if (a.windDirDeg !== undefined) env.windDirDeg = a.windDirDeg;
      if (a.visibilityNm !== undefined) env.baseVisibilityNm = a.visibilityNm;
      if (a.seaState !== undefined) { const w = windKnForSeaState(a.seaState); env.windKn = w; env._windTargetKn = w; }
      this.events.emit('env.change', { t: this.t, kind: 'TRIGGER', windKn: env.windKn, windDirDeg: env.windDirDeg, visibilityNm: env.visibilityNm });
    } else if (a.kind === 'ACTIVATE_OBJECTIVE') {
      const objs = this.scenario.objectives || [];
      const o = a.id !== undefined ? objs.find((x) => x.id === a.id) : objs[a.index || 0];
      if (o) o.active = true;
    } else if (a.kind === 'MESSAGE') {
      const text = a.text || '';
      this.events.emit('scenario.message', { t: this.t, text, id });
      this._major(text);
    }
  }

  _objectiveMet(o) {
    const c = o.condition || {};
    const targets = (c.shipIds || []).map((id) => this.ship(id)).filter(Boolean);
    switch (c.type) {
      case 'SINK': return targets.length > 0 && targets.every((s) => !s.isAfloat);
      case 'SINK_ANY': return targets.some((s) => !s.isAfloat);
      case 'DISABLE': return targets.length > 0 && targets.every((s) => !s.isAfloat || s.speedCapKn < 8 || s.floodedM3 > s.reserveBuoyancyM3 * 0.5);
      case 'SINK_COUNT': {
        const opp = this.shipsOf(this.opposite(o.side)).filter((s) => !s.isAfloat).length;
        return opp >= (c.n || 1);
      }
      case 'SURVIVE': return this.t >= (c.seconds || 600) && this.afloatOf(o.side).length > 0;
      case 'DISENGAGE': {
        // 脱离接触：本方仍有舰在航，且连续 N 秒内最近敌舰都 > distanceM → 视为成功撤离。
        // 用于"放弃任务/撤回基地"类剧本：旧 EXIT 区域常在 100 km 外，40 分钟的战斗根本走不到，
        // 于是轴心在这些剧本里从结构上就无法获胜（马塔潘、科曼多尔、苏里高）。
        const own = this.shipsOf(o.side).filter((s) => s.isAfloat);
        if (!own.length) return false;
        const foes = this.shipsOf(this.opposite(o.side)).filter((s) => s.isAfloat);
        if (!foes.length) return true;
        let minD = Infinity;
        for (const a of own) for (const b of foes) minD = Math.min(minD, dist2d(a.pos, b.pos));
        if (minD < (c.distanceM || 25000)) { this._disengageT = null; return false; }
        if (this._disengageT === undefined || this._disengageT === null) this._disengageT = this.t;
        return (this.t - this._disengageT) >= (c.seconds || 600);
      }
      case 'EXIT': {
        const area = c.area || { x: 0, y: 0, r: 3000 };
        const ships = this.shipsOf(o.side).filter((s) => s.isAfloat);
        if (!ships.length) return false;
        if (c.any) return ships.some((s) => dist2d(s.pos, area) < (area.r || 3000));
        return ships.every((s) => dist2d(s.pos, area) < (area.r || 3000));
      }
      case 'PROTECT': {
        const guarded = (c.shipIds || []).map((id) => this.ship(id)).filter(Boolean);
        return guarded.length > 0 && guarded.some((s) => s.isAfloat) && this.t >= (c.seconds || 600);
      }
      default: return false;
    }
  }

  _finish(winner, text) {
    this.over = true; this.winner = winner; this.resultText = text;
    this.record.finalAt = this.t;
    this.events.emit('victory.achieved', { t: this.t, winner, text });
    this.events.emit('sim.end', { t: this.t, winner, text });
  }

  // ---------------- 雾里看花的对外状态（AI 与 UI 共用） ----------------
  visibleStateFor(side) {
    const own = this.shipsOf(side);
    const tracks = [];
    for (const ship of own) {
      if (!ship.isAfloat) continue;
      for (const tr of this.tracks.visibleFor(ship)) {
        if (tracks.some((x) => x.id === tr.id)) continue;
        tracks.push({
          id: tr.id, pos: { x: Math.round(tr.pos.x), y: Math.round(tr.pos.y) },
          courseDeg: Math.round(tr.courseDeg), speedKn: +tr.speedKn.toFixed(1),
          classifiedAs: tr.classifiedAs, confidence: +tr.confidence.toFixed(2),
          ageS: +tr.ageS.toFixed(1), errM: Math.round(tr.errM), errDeg: Math.round(tr.errDeg),
          sources: tr.sources.slice(), rangeM: Math.round(dist2d(ship.pos, tr.pos)),
          bearingDeg: Math.round(normDeg(bearing2d(ship.pos, tr.pos))),
          idConfidence: +tr.idConfidence.toFixed(2), hostile: tr.hostile !== false,
        });
      }
    }
    const env = {
      seaState: +this.env.seaState.toFixed(1), windDirDeg: Math.round(this.env.windDirDeg), windKn: +this.env.windKn.toFixed(1),
      visibilityNm: +this.env.visibilityNm.toFixed(1), lightLevel: +this.env.lightLevel.toFixed(2),
      sunriseH: this.env.sunriseH, sunsetH: this.env.sunsetH, moonIllum: this.env.moonIllum,
      timeOfDayH: +((this.env.timeOfDayH !== undefined ? this.env.timeOfDayH : (this.env.tHours || 0))).toFixed(2),
    };
    const recentEvents = [];
    for (let i = this._eventMirror.length - 1; i >= 0 && recentEvents.length < 40; i--) {
      const e = this._findEvent(this._eventMirror[i].seq);
      if (!e) continue;
      if (this._eventVisibleTo(e, side)) recentEvents.push({ t: +this.t.toFixed(1), type: e.type, data: this._eventDigest(e) });
    }
    return {
      t: +this.t.toFixed(1), side,
      scenario: { id: this.scenario.id, nameZh: this.scenario.nameZh, mission: this.sides[side].objective },
      ownShips: own.map((s) => Object.assign(s.status(), {
        commanded: { heading: Math.round(s.commanded.heading), speed: +s.commanded.speed.toFixed(1), firing: !!s.commanded.firing, targetTrackId: s.commanded.targetTrackId || null },
        torpedoes: s.torpedoMounts.map((m) => ({ id: m.id, label: m.label, loaded: m.tubesLoaded, reloads: m.reloads, destroyed: m.destroyed })),
        dc: { priority: s.dcPriority || 'flooding', parties: s.dcParties, pumpCapacity_m3_min: +s.pumpCapacity.toFixed(1) },
        effectiveGM: +(s.effectiveGMm || 0).toFixed(2),
      })),
      tracks,
      environment: env,
      battle: { extendedS: this.timeExtensionS || 0, objectivesHoldUntil: this.holdObjectivesUntil || -1, over: this.over },
      recentEvents,
      timeScale: this.timeScale,
    };
  }

  // 观战模式：全知态势（双方舰船真值 + 双方航迹 + 环境）。仅供观战 UI 使用，不喂给任何 AI。
  spectatorState() {
    const tracks = [];
    for (const t of this.tracks.tracks) {
      // 观战：算"到最近敌方舰"的距离与方位（全知信息，仅用于观战 UI）
      let best = 1e18, brg = 0;
      for (const s of this.ships) {
        if (!s.isAfloat || s.side === t.side) continue;
        const d = Math.hypot(s.pos.x - t.pos.x, s.pos.y - t.pos.y);
        if (d < best) { best = d; brg = normDeg(Math.atan2(t.pos.x - s.pos.x, t.pos.y - s.pos.y) * 57.2957795); }
      }
      t._specRange = best < 1e17 ? Math.round(best) : 0;
      t._specBearing = best < 1e17 ? Math.round(brg) : 0;
      tracks.push({
        id: t.id, side: t.side, pos: { x: Math.round(t.pos.x), y: Math.round(t.pos.y) },
        courseDeg: Math.round(t.courseDeg), speedKn: +t.speedKn.toFixed(1),
        classifiedAs: t.classifiedAs, confidence: +t.confidence.toFixed(2), ageS: +t.ageS.toFixed(1),
        errM: Math.round(t.errM), errDeg: Math.round(t.errDeg), sources: t.sources.slice(),
        hostile: t.hostile !== false,
        rangeM: t._specRange || 0, bearingDeg: t._specBearing || 0, idConfidence: +(t.idConfidence || 0).toFixed(2),
      });
    }
    return {
      t: +this.t.toFixed(1), side: null, spectate: true,
      scenario: { id: this.scenario.id, nameZh: this.scenario.nameZh, mission: '' },
      ownShips: this.ships.map((s) => Object.assign(s.status(), {
        commanded: { heading: Math.round(s.commanded.heading), speed: +s.commanded.speed.toFixed(1), firing: !!s.commanded.firing, targetTrackId: s.commanded.targetTrackId || null },
        torpedoes: s.torpedoMounts.map((m) => ({ id: m.id, label: m.label, loaded: m.tubesLoaded, reloads: m.reloads, destroyed: m.destroyed })),
        dc: { priority: s.dcPriority || 'flooding', parties: s.dcParties, pumpCapacity_m3_min: +s.pumpCapacity.toFixed(1) },
        effectiveGM: +(s.effectiveGMm || 0).toFixed(2),
      })),
      tracks,
      environment: {
        seaState: +this.env.seaState.toFixed(1), windDirDeg: Math.round(this.env.windDirDeg), windKn: +this.env.windKn.toFixed(1),
        visibilityNm: +this.env.visibilityNm.toFixed(1), lightLevel: +this.env.lightLevel.toFixed(2),
        sunriseH: this.env.sunriseH, sunsetH: this.env.sunsetH, moonIllum: this.env.moonIllum,
        timeOfDayH: +((this.env.timeOfDayH !== undefined ? this.env.timeOfDayH : (this.env.tHours || 0))).toFixed(2),
      },
      battle: { extendedS: this.timeExtensionS || 0, objectivesHoldUntil: this.holdObjectivesUntil || -1, over: this.over },
      recentEvents: [],
      timeScale: this.timeScale,
    };
  }

  // 按 seq 从 history 尾部反向查找（history 按 seq 升序；噪声事件被保留策略淘汰时返回 null）
  _findEvent(seq) {
    const h = this.events.history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].seq === seq) return h[i];
      if (h[i].seq < seq) return null;
    }
    return null;
  }

  _eventVisibleTo(e, side) {
    if (e.side) return e.side === side;
    if (e.killerSide) return e.killerSide === side || e.victimSide === side;
    return true;
  }
  _eventDigest(e) {
    const d = {};
    for (const k of ['ship', 'name', 'target', 'text', 'side', 'killerSide', 'victimSide', 'rangeM', 'hit', 'compartment', 'result', 'source', 'confidence']) if (e[k] !== undefined) d[k] = e[k];
    return d;
  }
}
