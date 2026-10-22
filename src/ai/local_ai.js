// 【T6 所有者】本地规则 AI = 无外部智能体时的兜底指挥官，也是真实感的基准。
//
// ── 战术条令依据（1942 年战场实态） ──────────────────────────────────────────
// * 目标价值排序与火力分配：按舰种价值 × 威胁 × 命中概率打分，主力舰集火同一高价值目标
//   （日军「集中射撃」、美军「concentration of fire」都是 1942 年教范要求），驱逐舰另按
//   近距离威胁（对方 DD/CL）分配火力；弹药经济不许把主炮弹药浪费在射程外或概率极低的射击。
// * 抢占 T 字位（crossing the T）：我方航向取敌纵队航向 ±90°，以横阵对敌纵列，使全舷火力
//   可同时射击而敌方仅能以艏炮还击。这是 1916 年以来战列线交战的核心机动。
// * 免疫区（immunity zone）：以敌主炮口径估计的穿深曲线与本舰舷侧/甲板装甲求交，得到
//   「舷侧免疫下界 rBelt」与「甲板免疫上界 rDeck」；条令要求把交战距离保持在 [rBelt,rDeck]。
//   若 rBelt>rDeck（本舰对该敌无免疫区，如 1942 年各国新锐战列舰），则退化为远距交战并
//   优先烟幕/脱离。见 immuneZoneVs()。
// * 阵型与屏护：驱逐舰在威胁轴方向前出 3~4.5km，以方位角 0°±35°±70° 的扇形阵位屏护
//   主力舰（日军「警戒幕」/美军 screen station），并随威胁轴转向。
// * 烟幕掩护撤退：受伤或处于劣势时转向背离敌方并施放烟幕；烟幕也是驱逐舰雷击突击后
//   脱离的标准手段（日军水雷战队 1942 年多次使用）。
// * 雷击突击：驱逐舰/轻巡在 1000~16000m、目标舷角 60~120°（横越）时占位齐射，扇面宽度按
//   航迹方位误差与目标长度换算（覆盖目标可能位置），发射后转向脱离并施烟；保留后续管次。
//   舷角 90° 投影全长、命中概率最高（见 torpedo.js 命中几何），故要求在 60~120° 窗口开火。
// * 受伤舰退出：进水/火灾/横倾/失速/主炮损失加权成损伤分，超过阈值即 WITHDRAW+烟幕。
// * 损管优先级：弹药库受威胁 > 进水速率超过排水能力 > 火灾蔓延 > 机动性（能跑才有活路）。
// * 避雷机动：1s 反应回路，一旦目视发现鱼雷航迹（航迹可见性差异极大，见 torpedo.js），
//   立即转向与鱼雷航向平行（comb the wakes）并加到全速，使艏艉线与雷迹平行、投影只有舰宽。
// * 夜间/低能见度保守机动：减速、收紧队形、不主动远距开火（炮口闪光暴露阵位），
//   搜索探照灯/照明弹只在近距离使用。
// * 指挥延迟：所有命令都经 world.issueCommand（side.orderDelay_s 生效），AI 不绕过指挥链。
//
// 硬约束：只用 world.rng 的随机数（本模块实际不掷随机数）；不发 DOM；命令走 issueCommand。
import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, aspectAngle, kn2mps, rad2deg } from '../core/util.js';
import { torpedoSpecFor, torpedoesThreatening, solveIntercept } from '../sim/torpedo.js';

// 外部指挥官（LLM/智能体）刚下过令的舰，本地 AI 在这些命令种类上不得覆盖
const PROTECTED_WHEN_DIRECTED = { SET_COURSE: 1, SET_SPEED: 1, SET_RUDDER: 1, FIRE: 1, CEASE_FIRE: 1, ASSIGN_TARGET: 1, LAUNCH_TORPEDO: 1, SMOKE: 1, WITHDRAW: 1, FORMATION: 1 };

// 舰种基准价值（0~100 量级）：航母 > 战列舰 > 战巡 > 重巡 > 轻巡 > 驱逐
const TYPE_VALUE = Object.freeze({ CV: 100, BB: 95, BC: 78, CA: 55, CL: 35, DD: 20, UNKNOWN: 30, MERCHANT: 25 });
// 敌方主炮口径量级（mm）——用于免疫区估算与威胁排序
const ENEMY_CALIBER = Object.freeze({ BB: 380, BC: 356, CA: 203, CL: 152, DD: 127, CV: 127, UNKNOWN: 152 });
const ARMORED_TYPES = Object.freeze({ BB: 1, BC: 1, CA: 1 });
const HVU_TYPES = Object.freeze({ BB: 1, BC: 1, CV: 1, CA: 1 });
const TORPEDO_TYPES_ALLOWED = Object.freeze({ DD: 1, CL: 1, CA: 1, BC: 1 });

// ── 决战距离条令（decisive range）─────────────────────────────────────────────
// 史实：1941-42 年的火控在 20km 以上命中率趋近于 0，舰长必须接近到有效交战距离：
// 丹麦海峡 14-18km、萨沃岛 1.5-3km（夜）、第一次瓜岛 3-6km（夜）。
// 因此条令分两阶段：先「接近」（接近角 20~40°、全速、只做校射单发），进入决战距离后
// 才「抢占 T 字位」并允许全齐射。夜里借雷达火控可放宽 1~1.8km 先敌开火。
const DECISIVE_BAND = Object.freeze({
  BB: { day: [11000, 15000], night: [5000, 9000] },
  BC: { day: [11000, 15000], night: [5000, 9000] },
  CV: { day: [14000, 20000], night: [10000, 16000] },
  CA: { day: [8000, 14000], night: [3000, 8000] },
  CL: { day: [7000, 12000], night: [3000, 7000] },
  DD: { day: [6000, 10000], night: [2000, 6000] },
});
// 舰种名义长度：航迹误差 errM 超过目标长度时无法有效校射（只打单发）
const TYPE_LENGTH_M = Object.freeze({ BB: 230, BC: 240, CV: 250, CA: 190, CL: 160, DD: 110, UNKNOWN: 130 });
// 航迹识别兜底：T2 的 tracks 尚未输出 classifiedAs 时（当前为 UNKNOWN），按雷达截面积量级粗分类。
// 量级取自 sensors.js RCS_TABLE（X 波段舷侧）：DD 1200 / CL 2800 / CA 4200 / BB 18000。
const RCS_CLASS_BANDS = [[11000, 'BB'], [3200, 'CA'], [1900, 'CL']];
export function classifyTrack(tr) {
  if (!tr) return 'UNKNOWN';
  if (tr.classifiedAs && tr.classifiedAs !== 'UNKNOWN') return tr.classifiedAs;
  const rcs = (tr.features && tr.features.rcsM2) || tr.rcsM2 || 0;
  if (rcs > 0) { for (const p of RCS_CLASS_BANDS) if (rcs >= p[0]) return p[1]; return 'DD'; }
  if (tr.silhouetteAreaM2) return tr.silhouetteAreaM2 > 12000 ? 'BB' : tr.silhouetteAreaM2 > 5000 ? 'CA' : 'DD';
  return 'UNKNOWN';
}

// ── 免疫区估算（AI 级一阶近似；真值以 T4 的 penetrationMM 为准） ───────────────
// 舷侧穿深随距离下降，甲板穿深随距离上升（落角增大）。经验量级：
//   重型被帽穿甲弹近距法线穿深 ≈ 1.9×口径；30km 处甲板穿深 ≈ 0.45×口径。
//   rBelt：pen_belt(r)=装甲舷侧厚 的下界（更远才免疫）；
//   rDeck：pen_deck(r)=甲板厚 的上界（更近才免疫）。
export function immuneZoneVs(ship, enemyType) {
  const eCal = ENEMY_CALIBER[enemyType] || ENEMY_CALIBER.UNKNOWN;
  const armor = ship.data.armor || {};
  const belt = armor.belt_mm || 0, deck = armor.deck_mm || 0;
  const pen0 = 1.9 * eCal;
  const rBelt = belt > 0 ? 35000 * (1 - Math.pow(clamp(belt / pen0, 0, 1), 1 / 1.2)) : 0;
  const penDeck30 = 0.45 * eCal;
  const rDeck = deck > 0 ? 8000 + 22000 * Math.pow(clamp(deck / penDeck30, 0, 1), 1 / 0.9) : 40000;
  return { innerM: clamp(rBelt, 0, 40000), outerM: clamp(rDeck, 0, 40000), valid: rBelt < rDeck, eCal };
}

export class LocalAI {
  constructor(side, opts = {}) {
    this.side = side;
    this.name = 'LOCAL';
    this.opts = opts;
    this.intervalS = opts.intervalS || 8;         // 战术决策周期
    this.fastIntervalS = opts.fastIntervalS || 1.0; // 反应回路（避雷/损管）
    this.accum = 0; this.fastAccum = 0;
    this.lastReasoning = '未决策';
    this.lastCommands = 0;
    // ── 命令节流（LOCAL AI 的命令密度控制）────────────────────────────────────
    // 指挥延迟 side.orderDelay_s 默认 4–12s，舰队级更久；比这更密的重发不会让舰更早到位，
    // 只会让它在"旧令→新令"之间来回摆（实测第一次瓜岛 40 分钟 order.issue=5482，
    // SET_COURSE 每 8.1s 一条而航向中位变化只有 1.6°）。因此对操舵/航速类命令加
    // 「时间节流 + 数值滞回」，开火/换靶命令加「重复抑制 + 目标连续性」，避雷机动豁免。
    this.courseHoldS = opts.courseHoldS !== undefined ? opts.courseHoldS : 20;          // 同舰两次航向命令最小间隔
    this.courseDeadbandDeg = opts.courseDeadbandDeg !== undefined ? opts.courseDeadbandDeg : 8;   // 航向死区
    this.courseForceDeadbandDeg = opts.courseForceDeadbandDeg !== undefined ? opts.courseForceDeadbandDeg : 8; // 强制机动（接近/撤退/雷击脱离）死区
    this.speedHoldS = opts.speedHoldS !== undefined ? opts.speedHoldS : 20;            // 航速命令最小间隔
    this.speedDeadbandKn = opts.speedDeadbandKn !== undefined ? opts.speedDeadbandKn : 1.5;       // 航速死区（节）
    this.rudderHoldS = opts.rudderHoldS !== undefined ? opts.rudderHoldS : 20;          // 舵令最小间隔（暂无调用方，保留）
    this.rudderDeadbandDeg = opts.rudderDeadbandDeg !== undefined ? opts.rudderDeadbandDeg : 5;   // 舵角死区
    this.fireHoldS = opts.fireHoldS !== undefined ? opts.fireHoldS : 60;               // 同目标重复 FIRE 的最小间隔（校射要观察弹着再修正，约 1 分钟一轮接近真实节奏；持续齐射模式下不影响实际射速）
    this.fireModeHoldS = opts.fireModeHoldS !== undefined ? opts.fireModeHoldS : 20;   // SPOT/FULL 模式切换的最小间隔
    this.targetHoldS = opts.targetHoldS !== undefined ? opts.targetHoldS : 60;         // 换靶最小间隔（目标未丢失时）
    this.targetLostHoldS = opts.targetLostHoldS !== undefined ? opts.targetLostHoldS : 45; // 目标短暂丢失时的停火抑制窗
    this.starHoldS = opts.starHoldS !== undefined ? opts.starHoldS : 90;               // 单舰照明弹最小间隔
    this.starFleetHoldS = opts.starFleetHoldS !== undefined ? opts.starFleetHoldS : 30; // 全队照明弹最小间隔（别所有舰一起打）
    this.mem = new Map();
    this.fleet = { phase: 'SEARCH', threatAxisDeg: null, enemyValue: 0, ownValue: 0, ratio: 1, focusTrackId: null, focusLabel: '' };
  }

  tick(world, dt, dryRun) {
    this.dryRun = !!dryRun;   // true = 参谋模式：只给出判断与建议，不向世界下任何命令
    this.fastAccum += dt;
    if (this.fastAccum >= this.fastIntervalS) { this.fastAccum = 0; this.react(world); }
    this.accum += dt;
    if (this.accum >= this.intervalS) { this.accum = 0; this.decide(world); }
  }

  memFor(ship) {
    let m = this.mem.get(ship.id);
    if (!m) {
      m = { targetTrackId: null, ammo: 'AP', firing: false, lastCourseT: -1e9, lastSpeedT: -1e9, lastTorpT: -1e9,
        evadeUntil: -1e9, evadeHeading: null, evacuating: false, withdraw: false, dcMode: null, lastStationT: -1e9, screenStation: null,
        // 节流/滞回状态：上次实际下达的航向与航速（不是"当前保持值"，后者会因 C2 延迟滞后）
        lastCourseWant: undefined, lastSpeedWant: undefined, lastRudder: undefined, lastRudderT: -1e9,
        lastFireT: -1e9, lastAssignT: -1e9, lastTargetT: -1e9, gateFailN: 0 };
      this.mem.set(ship.id, m);
    }
    return m;
  }

  // 执行官模式（LLM/外部指挥官在线时）：本地 AI 继续做实时事务（规避、损管、火控门限），
  // 但不覆盖外部指挥官刚下达的航向/速度/火力——除非是避雷这种保命机动。
  order(world, cmd, evade) {
    if (this.dryRun) return null;   // 参谋模式：不实际下令（玩家/外部指挥官自己指挥）
    // 用仿真时间而不是墙钟：时间压缩 1x~64x 下都成立（"外部指挥官的令保持 5 分钟仿真时间"）
    if (this.directiveHoldS === undefined) this.directiveHoldS = 300;
    if (!evade && this.directiveHoldS > 0 && cmd.shipId) {
      const ship = world.ship ? world.ship(cmd.shipId) : null;
      // 注意：不能用 || —— _directiveSim 可能是 0（开局那一刻下的命令），会被当成"没有时间戳"
      const stamp = ship && ship._directiveSim !== undefined ? ship._directiveSim : -1e9;
      const age = world.t - stamp;
      if (age < this.directiveHoldS && PROTECTED_WHEN_DIRECTED[cmd.kind]) return null;
    }
    // SET_RUDDER：本 AI 当前不主动发舵令（航向靠 SET_COURSE），但统一在这里做节流，
    // 避免将来战术模块高频操舵把命令数重新拉高。evade（避雷）不受时间节流限制。
    if (!evade && cmd.kind === 'SET_RUDDER' && cmd.shipId) {
      const sh = world.ship ? world.ship(cmd.shipId) : null;
      if (sh) {
        const m = this.memFor(sh);
        const deg = (cmd.params && cmd.params.deg) || 0;
        if (world.t - m.lastRudderT < this.rudderHoldS) return null;
        if (m.lastRudder !== undefined && Math.abs(deg - m.lastRudder) < this.rudderDeadbandDeg) return null;
        m.lastRudderT = world.t; m.lastRudder = deg;
      }
    }
    this.lastCommands++;
    return world.issueCommand(Object.assign({ source: 'AI_LOCAL', issuer: 'LOCAL/' + this.side }, cmd));
  }
  setCourse(world, ship, heading, mem, force = false, evade = false) {
    let want = normDeg(heading);
    // 陆地避让：前方约 4 分钟航程是陆地就朝可航一侧偏转（真实舰长不会把船开上岸）
    if (world.land && !world.land.empty) {
      // 沿多个距离探测（1.5/3/6/9km），只要有一条被陆地挡住就换向；全被挡则横着走（狭水道最安全）
      const big = (ship.data.loa_m || 100) > 170;
      const dists = big ? [3000, 6000, 12000, 18000] : [1500, 3000, 6000, 9000];
      const blocked = (h) => {
        for (const d of dists) {
          const p = destPoint(ship.pos, d, h);
          if (world.land.isLandExact(p.x, p.y)) return true;
          if (world.depth && !world.depth.empty && !world.depth.isNavigable(p.x, p.y, ship.draftM || 6, 2)) return true;
        }
        return false;
      };
      if (blocked(want)) {
        let bestH = null;
        for (let off = 15; off <= 180 && bestH === null; off += 15) {
          for (const sgn of [1, -1]) {
            const h = normDeg(want + sgn * off);
            if (!blocked(h)) { bestH = h; break; }
          }
        }
        want = bestH !== null ? bestH : normDeg(want + 90);
      }
    }
    // 航向命令节流：时间节流对 force（接近/退出/雷击脱离）同样生效——C2 延迟下更密的重发
    // 没有意义；只有避雷（evade）必须即时。滞回以上次"下达值"为基准（commanded.heading 要等
    // 命令生效才更新，用它做基准会在延迟窗口里反复重发）。
    if (!evade) {
      if (world.t - mem.lastCourseT < this.courseHoldS) return false;
      const refH = mem.lastCourseWant !== undefined ? mem.lastCourseWant : ship.commanded.heading;
      const dead = force ? this.courseForceDeadbandDeg : this.courseDeadbandDeg;
      if (Math.abs(normDeg180(want - refH)) < dead) return false;
    }
    mem.lastCourseT = world.t;
    mem.lastCourseWant = want;
    return !!this.order(world, { shipId: ship.id, kind: 'SET_COURSE', params: { heading: want } }, evade);
  }
  setSpeed(world, ship, kn, mem, force = false, evade = false) {
    let want = clamp(kn, 0, ship.data.speedMax_kn || 30);
    // 近岸减速：真实舰长在浅水/狭水道会主动减速（既避免搁浅，也减少操舵迟滞）
    if (!evade && world.land && !world.land.empty) {
      const dl = world.land.distanceToLand(ship.pos.x, ship.pos.y, 9000);
      if (dl < 2500) want = Math.min(want, 10);
      else if (dl < 5000) want = Math.min(want, 18);
    }
    // 航速命令节流：同上（force/evade 语义与 setCourse 一致）
    if (!evade) {
      if (world.t - mem.lastSpeedT < this.speedHoldS) return false;
      const refKn = mem.lastSpeedWant !== undefined ? mem.lastSpeedWant : ship.commanded.speed;
      if (Math.abs(want - refKn) < this.speedDeadbandKn) return false;
    }
    mem.lastSpeedT = world.t;
    mem.lastSpeedWant = want;
    return !!this.order(world, { shipId: ship.id, kind: 'SET_SPEED', params: { kn: want } }, evade);
  }
  // 停火（带抖动抑制）：T2 的航迹 id 会因失跟/重捕而翻新，目标短暂"消失"一轮时旧逻辑
  // 立刻 CEASE_FIRE、下一轮又在同一条物理目标上 FIRE，命令对翻而炮口没变。目标刚在
  // targetLostHoldS 内出现过就暂不停火（gunnery 在无有效航迹时本来就不会开炮）。
  ceaseFire(world, ship, mem, noTarget) {
    if (!(mem.firing || ship.commanded.firing)) return false;
    const held = noTarget && world.t - (mem.lastTargetT || -1e9) < this.targetLostHoldS;
    if (!held) {
      this.order(world, { shipId: ship.id, kind: 'CEASE_FIRE', params: {} });
      mem.firing = false; mem.fireMode = null;
    } else mem.firing = !!ship.commanded.firing;
    return !held;
  }
  smoke(world, ship, on) {
    if (ship.flags.smokeOn === !!on) return false;
    this.order(world, { shipId: ship.id, kind: 'SMOKE', params: { on: !!on } });
    return true;
  }

  // ── 1s 反应回路：避雷机动 + 损管优先级 ─────────────────────────────────────
  react(world) {
    const mine = world.afloatOf(this.side);
    if (!mine.length) return;
    const notes = [];
    for (const ship of mine) {
      const mem = this.memFor(ship);
      // 避雷：只对已目视发现的鱼雷航迹反应（氧气鱼雷航迹极淡 → 常常发现时已来不及）
      const threats = torpedoesThreatening(world, ship, { maxRangeM: 9000, maxCpaM: 700, maxTimeS: 240 });
      const seen = threats.filter((t) => t.detected);
      if (seen.length && world.t > mem.evadeUntil) {
        const t0 = seen[0];
        const c1 = normDeg(t0.torp.courseDeg), c2 = normDeg(t0.torp.courseDeg + 180);
        // comb the wakes：与雷迹平行，使投影只剩舰宽（B）而非全长（L）
        const h = Math.abs(normDeg180(c1 - ship.heading)) <= Math.abs(normDeg180(c2 - ship.heading)) ? c1 : c2;
        this.setCourse(world, ship, h, mem, true, true);
        this.setSpeed(world, ship, ship.data.speedMax_kn || 30, mem, true, true);
        mem.evadeUntil = world.t + Math.max(35, t0.timeToCpaS + 20);
        mem.evadeHeading = h;
        notes.push('【避雷】' + ship.name + ' 发现' + (t0.wakeType === 'OXYGEN' ? '淡航迹' : '航迹') +
          ' 距' + Math.round(t0.rangeM) + 'm CPA' + Math.round(t0.cpaM) + 'm → comb wake ' + Math.round(h) + '° 全速');
      }
      // 损管优先级
      const mode = this.dcMode(ship, mem, world.t);
      if (mode && mode !== mem.dcMode) {
        mem.dcMode = mode;
        this.order(world, { shipId: ship.id, kind: 'DC_PRIORITY', params: { mode } });
        notes.push('【损管】' + ship.name + ' 优先级=' + mode);
      }
      // 受损加剧则立即退出（不等 8s 决策周期）
      const dmg = this.damageScore(ship);
      if (!mem.withdraw && this.shouldWithdraw(ship, dmg, world)) {
        mem.withdraw = true;
        this.order(world, { shipId: ship.id, kind: 'WITHDRAW', params: {} });
        const h = this.retreatHeading(world, ship);
        this.setCourse(world, ship, h, mem, true);
        this.setSpeed(world, ship, (ship.data.speedMax_kn || 30) * 0.95, mem, true);
        this.smoke(world, ship, true);
        notes.push('【退出】' + ship.name + ' 损伤分' + dmg.score.toFixed(2) + ' → 航向' + Math.round(h) + ' 施烟');
      }
    }
    if (notes.length) {
      this.lastReasoning = notes.join(' ｜ ');
      world.events.emit('ai.decision', { t: world.t, side: this.side, backend: 'LOCAL', reaction: true, commands: this.lastCommands, reasoning: this.lastReasoning });
    }
  }

  // ── 战术决策周期 ──────────────────────────────────────────────────────────
  decide(world) {
    const mine = world.afloatOf(this.side);
    if (!mine.length) return;
    const enemies = this.picture(world, mine);
    const R = [];
    this.lastCommands = 0;
    this.assess(world, mine, enemies);
    const plan = '【态势】' + ({ SEARCH: '搜索', ENGAGE: '交战', TORPEDO: '雷击突击', WITHDRAW: '脱离' }[this.fleet.phase] || this.fleet.phase) +
      ' 我' + Math.round(this.fleet.ownValue) + ':敌' + Math.round(this.fleet.enemyValue) +
      (this.fleet.focusLabel ? ' 集火' + this.fleet.focusLabel : '');
    this.assignTargets(world, mine, enemies, R);
    if (this.fleet.phase === 'WITHDRAW') this.fleetRetreat(world, mine, R);
    else {
      // 单舰脱离：WITHDRAW 命令只置标记不设航向，必须由 AI 操舵——否则"想撤"的舰
      // 仍按旧航向朝敌航行（实测俾斯麦一路从 18km 缩到 7km 被打瘫）
      for (const ship of mine) { const mem = this.memFor(ship); if (mem.withdraw) this.retreatShip(world, ship, mem, R); }
      this.maneuver(world, mine, enemies, R);
      this.screen(world, mine, enemies, R);
      this.torpedoAttack(world, mine, enemies, R);
    }
    this.ammoEconomy(world, mine, R);
    this.lastReasoning = plan + (R.length ? ' ｜ ' + R.join(' ｜ ') : ' ｜ 保持当前阵位与射速');
    world.events.emit('ai.decision', { t: world.t, side: this.side, backend: 'LOCAL', phase: this.fleet.phase, commands: this.lastCommands, reasoning: this.lastReasoning });
  }

  // ── 战场态势：合并本方各舰航迹（同一 TrackManager，去重） ────────────────
  picture(world, mine) {
    const out = [];
    const seen = new Set();
    const centroid = this.centroid(mine);
    for (const ship of mine) {
      let list = [];
      try { list = world.tracks.visibleFor(ship) || []; } catch (e) { list = []; }
      for (const tr of list) {
        if (!tr || tr.hostile === false) continue;
        if (seen.has(tr.id)) continue;
        seen.add(tr.id);
        const r = dist2d(ship.pos, tr.pos);
        out.push({ tr, rangeM: r, bearingFromFlag: bearing2d(centroid, tr.pos), rangeFromFlag: dist2d(centroid, tr.pos), classifiedAs: classifyTrack(tr) });
      }
    }
    out.sort((a, b) => (TYPE_VALUE[b.classifiedAs] || 30) - (TYPE_VALUE[a.classifiedAs] || 30));
    return out;
  }

  centroid(ships) {
    let x = 0, y = 0, w = 0;
    for (const s of ships) { const v = s.type === 'BB' || s.type === 'CV' ? 3 : 1; x += s.pos.x * v; y += s.pos.y * v; w += v; }
    return w ? { x: x / w, y: y / w } : { x: 0, y: 0 };
  }

  trackValue(e) {
    const base = TYPE_VALUE[e.classifiedAs] || 30;
    const conf = e.tr.confidence !== undefined ? e.tr.confidence : 0.5;
    const idc = e.tr.idConfidence !== undefined ? e.tr.idConfidence : 0.3;
    return base * (0.55 + 0.45 * conf) * (0.75 + 0.35 * idc);
  }
  label(e) { return (e.tr.classifiedAs || 'UNKNOWN') + (e.tr.id ? '(' + e.tr.id + ')' : ''); }

  // ── 全局态势判断：兵力比与阶段 ────────────────────────────────────────────
  assess(world, mine, enemies) {
    let own = 0;
    for (const s of mine) own += (TYPE_VALUE[s.type] || 25) * clamp(1 - this.damageScore(s).score * 0.55, 0.25, 1);
    let enemy = 0;
    for (const e of enemies) enemy += this.trackValue(e);
    this.fleet.ownValue = own;
    this.fleet.enemyValue = enemy;
    this.fleet.ratio = own / Math.max(1, enemy);
    // 威胁轴：按价值加权的敌方位圆均值
    let sx = 0, sy = 0;
    for (const e of enemies) { const v = this.trackValue(e); sx += Math.sin(e.bearingFromFlag * Math.PI / 180) * v; sy += Math.cos(e.bearingFromFlag * Math.PI / 180) * v; }
    this.fleet.threatAxisDeg = (sx || sy) ? normDeg(Math.atan2(sx, sy) * 180 / Math.PI) : null;
    // 敌方纵队航向（价值加权圆均值）与前导舰：雷击条令优先打战列线前导舰
    let cx = 0, cy = 0;
    for (const e of enemies) { const v = this.trackValue(e); const c = (e.tr.courseDeg || 0) * Math.PI / 180; cx += Math.sin(c) * v; cy += Math.cos(c) * v; }
    this.fleet.enemyCourseDeg = (cx || cy) ? normDeg(Math.atan2(cx, cy) * 180 / Math.PI) : null;
    this.fleet.vanTrackId = null;
    if (this.fleet.enemyCourseDeg !== null && enemies.length) {
      const ux = Math.sin(this.fleet.enemyCourseDeg * Math.PI / 180), uy = Math.cos(this.fleet.enemyCourseDeg * Math.PI / 180);
      let proj = -1e18;
      for (const e of enemies) { const pj = e.tr.pos.x * ux + e.tr.pos.y * uy; if (pj > proj) { proj = pj; this.fleet.vanTrackId = e.tr.id; } }
    }
    // 集火目标：射程内价值最高者
    let focus = null, best = -1;
    const prevFocus = this.fleet.focusTrackId;
    for (const e of enemies) {
      const inRange = e.rangeFromFlag < 26000;
      let sc = this.trackValue(e) * (inRange ? 1 : 0.4);
      if (this.isObjectiveTarget(world, e.tr)) {
        sc *= 1.8;                                    // 任务目标是胜利条件：优先集火
        const pref2 = this.objectivePreferredId(world);
        const set2 = e.tr._trueIds;
        if (pref2 && set2 && set2.has(pref2)) sc *= 1.7;   // 锁定最好打沉的那艘（胡德）
        // 可击沉性：战巡（胡德）薄甲板、储备浮力小，比新式战列舰（威尔士亲王）容易击沉得多。
        // 任务只要求击沉任意一艘，所以应当集中打"最可能沉"的那艘，而不是价值最高的。
        if (e.classifiedAs === 'BC') sc *= 1.55;
        // 锁定：已锁定的任务目标在它沉没/丢失前不换（避免两台舰在两条航迹间来回搬火力）
        if (e.tr.id === prevFocus) sc *= 2.2;
      }
      if (e.tr.id === prevFocus) sc *= 1.25;          // 焦点迟滞：别让识别抖动把全队火力来回搬
      if (sc > best) { best = sc; focus = e; }
    }
    this.fleet.focusTrackId = focus ? focus.tr.id : null;
    this.fleet.focusLabel = focus ? this.label(focus) : '';
    const anyClose = enemies.some((e) => e.rangeFromFlag < 26000);
    const forced = this.fleetForcedWithdraw(world, own, enemy);
    if (forced) this.fleet.phase = 'WITHDRAW';
    else if (anyClose) this.fleet.phase = 'ENGAGE';
    else this.fleet.phase = 'SEARCH';
  }
  // 舰队级撤退判据：兵力比低于剧本阈值 / 半数以上军舰重伤 / 旗舰重伤
  fleetForcedWithdraw(world, own, enemy) {
    const mine = world.afloatOf(this.side);
    if (!mine.length) return false;
    const ratio = own / Math.max(1, enemy);
    const th = (world.sides && world.sides[this.side] && world.sides[this.side].withdrawThreshold) || 0.35;
    if (enemy > 30 && ratio < th) return true;
    const hurt = mine.filter((s) => this.damageScore(s).score > 0.5).length;
    if (hurt / mine.length >= 0.5 && ratio < 0.95) return true;
    const flag = mine.find((s) => s.role === 'flagship') || mine[0];
    if (flag && this.damageScore(flag).score > 0.85) return true;
    // 任务已达成（如已击沉一艘敌方主力舰）而对手仍有战力 → 见好就收，保存实力
    if (this.objectiveAchieved(world) && ratio < 1.8) return true;
    return false;
  }

  damageScore(ship) {
    const flood = ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3);
    const fires = ship.compartments.filter((c) => c.fire > 0.1).length;
    const list = Math.abs(ship.list || 0);
    const speedLoss = 1 - clamp((ship.speedCapKn || 0) / Math.max(1, ship.data.speedMax_kn || 25), 0, 1);
    const mainTotal = (ship.batteries || []).filter((b) => b.role === 'main').length;
    const mainAlive = (ship.mainBatteries || []).filter((b) => !b.destroyed && b.health > 0.15).length;
    const gunLoss = mainTotal ? 1 - mainAlive / mainTotal : 0;
    const crewLoss = 1 - clamp(ship.crew / Math.max(1, ship.crew0), 0, 1);
    const score = clamp(flood * 1.8 + fires * 0.07 + list / 90 + speedLoss * 0.6 + gunLoss * 0.5 + crewLoss * 0.4, 0, 2);
    return { score, flood, fires, list, gunLoss, speedLoss };
  }
  shouldWithdraw(ship, dmg, world) {
    // 任务已达成的舰：带伤就撤（保留破交本钱），不再原地硬拼
    if (world && this.objectiveAchieved(world)) {
      if (dmg.score > 0.35 || dmg.flood > 0.12 || dmg.list > 8) return true;
    }
    // ── 机动性 / 火控是"生存与任务能力"的硬指标 ──────────────────────────────
    // 史实：被拦截的破交舰一旦掉速就再无生路（俾斯麦最后正是被鱼雷机打掉舵机后失速）。
    // 旧判据只看损伤分/进水/横倾，对"速度上限 27→10 节""指挥仪全毁"毫无反应，
    // 于是一路打到被判定"丧失机动能力"——这是本剧本里轴心 AI 最大的智力缺口。
    const spdMax = Math.max(1, ship.data.speedMax_kn || 25);
    const speedFrac = clamp((ship.speedCapKn || spdMax) / spdMax, 0, 1);
    if (speedFrac < 0.62) return true;                       // 掉速到六成以下：再打下去必被判定瘫痪
    const dirs = ship.directors || [];
    const dirsAlive = dirs.filter((d) => !d.destroyed && (d.health === undefined || d.health > 0.2)).length;
    if (dirs.length && dirsAlive === 0 && ship.type !== 'DD') return true;   // 火控全毁：已无法有效还击
    // 火力大幅削弱即脱离：史实丹麦海峡 PoW 打了 6 分钟、10 门主炮只剩 2 门就脱离，
    // 没有哪艘主力舰会在主炮损失过半时继续原地对射。这条对双方都适用。
    const heavyUnit = ship.type === 'BB' || ship.type === 'BC' || ship.type === 'CA';
    if (heavyUnit && dmg.gunLoss > 0.5) return true;
    if (heavyUnit && dirs.length >= 2 && dirsAlive <= 1) return true;        // 指挥仪只剩一台
    return dmg.score > 0.6 || dmg.flood > 0.33 || dmg.list > 18 || (dmg.gunLoss > 0.6 && ship.type === 'BB');
  }

  // ── 任务感知（战役目标）────────────────────────────────────────────────────
  // 读剧本 objectives 的机器可读条件（SINK / SINK_ANY / DISABLE），据此决定"打谁、
  // 打沉之后要不要继续拼"。史实：吕特晏斯在击沉胡德后选择脱离保舰，而不是原地耗到被打瘫。
  myObjectives(world) {
    if (this._objCache !== undefined && this._objWorld === world) return this._objCache;
    const objs = (world && world.scenario && world.scenario.objectives) || [];
    this._objCache = objs.filter((o) => o.side === this.side);
    this._objWorld = world;
    return this._objCache;
  }
  objectiveTargetIds(world) {
    const ids = [];
    for (const o of this.myObjectives(world)) {
      const c = o.condition || {};
      if (c.type === 'SINK' || c.type === 'SINK_ANY' || c.type === 'DISABLE') {
        for (const id of (c.shipIds || [])) if (ids.indexOf(id) < 0) ids.push(id);
      }
    }
    return ids;
  }
  objectiveAchieved(world) {
    for (const o of this.myObjectives(world)) { if (world._objectiveMet && world._objectiveMet(o)) return true; }
    return false;
  }
  // 任务目标里"最好打沉"的那条：按真实舰种排序（战巡 > 老式战列舰 > 新式战列舰）
  objectivePreferredId(world) {
    const ids = this.objectiveTargetIds(world);
    let best = null, bestRank = -1;
    for (const id of ids) {
      const s = world.ship ? world.ship(id) : null;
      if (!s) continue;
      const rank = s.type === 'BC' ? 3 : s.type === 'CV' ? 2 : (s.armor && s.armor.deck_mm && s.armor.deck_mm < 120) ? 2 : 1;
      if (rank > bestRank) { bestRank = rank; best = id; }
    }
    return best;
  }
  isObjectiveTarget(world, track) {
    if (!track) return false;
    const ids = this.objectiveTargetIds(world);
    if (!ids.length) return false;
    // T2 航迹把真实舰种收在 _trueIds（Set）里：命中识别后才知道打的是不是任务目标
    const set = track._trueIds;
    if (set && typeof set.has === 'function') {
      for (const id of ids) if (set.has(id)) return true;
      return false;
    }
    const sid = track.targetId || track.targetShipId || null;
    return !!(sid && ids.indexOf(sid) >= 0);
  }

  // ── 火力分配 ──────────────────────────────────────────────────────────────
  estimateHitProb(ship, e, rangeM, world) {
    const mains = ship.mainBatteries || [];
    if (!mains.length) return 0.02;
    let maxR = 0;
    for (const b of mains) maxR = Math.max(maxR, (b.data && b.data.maxRange_m) || 20000);
    if (rangeM > maxR) return 0;
    const frac = rangeM / maxR;
    // 一阶命中概率：近距约 20~25%，随距离按 (1-frac)^1.6 衰减；横越目标与低速目标更易命中
    let p = 0.26 * Math.pow(clamp(1 - frac, 0, 1), 1.6);
    const brg = bearing2d(ship.pos, e.tr.pos);
    const aspect = aspectAngle(e.tr.courseDeg || 0, brg) * Math.PI / 180;
    p *= 0.62 + 0.55 * Math.abs(Math.sin(aspect));           // 舷侧投影大
    p *= clamp(1.15 - (e.tr.speedKn || 15) * 0.012, 0.7, 1.1);
    const size = (e.classifiedAs === 'BB' || e.classifiedAs === 'CV') ? 1.25 : (e.classifiedAs === 'DD' ? 0.85 : 1.0);
    p *= size;
    const fc = ship.fireControlOperational ? 1 : 0.35;
    p *= fc;
    const sea = world.env && world.env.seaState !== undefined ? world.env.seaState : 2;
    p *= clamp(1 - 0.05 * sea, 0.6, 1);
    p *= clamp(0.65 + 0.35 * (ship.crewQuality || 0.85) / 0.85, 0.6, 1.15);
    // 本舰剧烈横摇时测距/解算变差
    p *= clamp(1 - Math.abs(ship.roll || 0) * 0.012, 0.7, 1);
    return clamp(p, 0, 0.5);
  }

  // ── 决战距离/条令带 ────────────────────────────────────────────────────────
  decisiveBand(ship, enemyType, world) {
    const env = (world && world.env) || {};
    const light = env.lightLevel !== undefined ? env.lightLevel : 1;
    let visNm = env.visibilityNm !== undefined ? env.visibilityNm : 12;
    if (env.horizontalVisibilityNm) { try { visNm = env.horizontalVisibilityNm(ship); } catch (e2) { /* 保持默认 */ } }
    // 昼夜判定用太阳高度角（比光照强度更稳）：< -6° 为夜战，-6°~+6° 为晨昏微光（取日间带的 0.75）
    const sunAlt = env.sunAltDeg !== undefined && env.sunAltDeg !== null ? env.sunAltDeg : null;
    const night = sunAlt !== null ? sunAlt < -6 : (light < 0.10);
    const dusk = !night && (sunAlt !== null ? sunAlt < 6 : light < 0.35);
    const T = DECISIVE_BAND[ship.type] ? ship.type : 'DD';
    let band = (night ? DECISIVE_BAND[T].night : DECISIVE_BAND[T].day.map((v) => v * (dusk ? 0.75 : 1))).slice();
    // 能见度上限：看不见就打不准——交战带外沿不超过有效水平能见度的 1.4 倍
    const visM = visNm * 1852;
    const visCap = clamp(visM * 1.4, 4000, 30000);
    band[1] = Math.min(band[1], visCap);
    band[0] = Math.min(band[0], band[1] * 0.8);
    const radar = (ship.sensors || []).some((s) => s.srcKind === 'RADAR' && s.on && !s.destroyed && (!s.data || s.data.hasRange !== false));
    if (night && radar) band = [band[0] + 1200, band[1] + 1800];   // 夜间雷达火控优势：先敌开火
    else if (night && !radar) band = [band[0] * 0.85, band[1] * 0.60]; // 无雷达的夜战条令：必须逼近
    // （史实：萨沃岛日军无雷达，靠夜视光学与探照灯逼近到 1.5~3km 才开火；有雷达的美舰在 8~10km 先发现）
    const iz = immuneZoneVs(ship, enemyType);
    if (iz.valid) {                                                 // 决战距离内再讲免疫区
      const lo = Math.max(band[0], iz.innerM * 1.02), hi = Math.min(band[1], iz.outerM * 0.98);
      if (lo <= hi) band = [lo, hi];
    }
    return { min: band[0], max: band[1], night, visNm, radar, iz, label: night ? '夜战' : '日间' };
  }

  // ── 火控质量门限：航迹质量不足以支撑命中时不倾泻弹药 ──────────────────────
  // 判据：距离（决战距离±）/航迹误差 errM,errDeg/识别置信度/航迹新鲜度/弹药余量。
  // 不合格 → 停火，或只打一发校射（史实：远距单发修正，等距离缩短再全齐射）。
  fireGate(ship, e, r, world) {
    const tr = e.tr || {};
    const bat = (ship.mainBatteries || [])[0];
    if (!bat || bat.destroyed || bat.health < 0.2) return { fire: false, reason: '主炮不可用' };
    if (r > this.mainRange(ship) * 0.95) return { fire: false, reason: '超出主炮射程' };
    const age = tr.ageS !== undefined ? tr.ageS : 0;
    if (age > 40) return { fire: false, reason: '航迹过旧 ' + Math.round(age) + 's' };
    const band = this.decisiveBand(ship, e.classifiedAs, world);
    const p = this.estimateHitProb(ship, e, r, world);
    const ammo = this.pickAmmo(ship, e, r);
    const totalAmmo = (bat.ammo.AP || 0) + (bat.ammo.HE || 0);
    const load = bat.data && bat.data.ammo ? ((bat.data.ammo.AP || 0) + (bat.data.ammo.HE || 0)) : 0;
    const ammoFrac = load ? totalAmmo / load : 1;
    const targetLen = TYPE_LENGTH_M[e.classifiedAs] || 130;
    // 识别：航迹给出舰种，或近距离（≤15km，目视可辨舰型/桅高）且置信度可接受
    const identified = e.classifiedAs !== 'UNKNOWN' || (r <= 15000 && (tr.confidence === undefined || tr.confidence >= 0.35));
    const goodSolution = (tr.errM === undefined || tr.errM <= Math.max(targetLen, 250)) && (tr.errDeg === undefined || tr.errDeg <= 3);
    const rel = r / Math.max(1000, band.max);
    let pFull = rel <= 1.05 ? 0.02 : 0.05;          // 只有进入决战距离才允许全齐射
    // 停火门限：昼间可放宽到决战带 1.35 倍；夜间无雷达必须贴到决战带内（史实萨沃岛日军
    // 1.5~3km 才开火），有雷达才允许在带外沿先敌开火——这正是"雷达火控优势"的体现。
    // 注意：night / radar 只能从 decisiveBand() 的返回值里取。原先误写成裸的
    // `night` / `radar`，会抛 ReferenceError 把整个 LocalAI.tick 打断 —— 表现就是
    // "AI 一旦要开火就彻底不动了"（T6.7: ai.decision 0 条）。
    const holdMul = band.night ? (band.radar ? 1.20 : 1.02) : 1.35;
    let pHold = rel > holdMul ? 0.03 : 0.006;
    // 开火滞回：已经在打的舰不因一次解算抖动就停火（否则 FIRE/CEASE_FIRE 每 8s 对翻，
    // 命令数翻倍而实际射速不变）。停火门槛放宽 30%，重新开火仍用原门槛。
    const engagedNow = !!ship.commanded.firing;
    if (engagedNow) pHold *= 0.7;
    if (!identified) pFull = Math.max(pFull, 0.05);
    if (!goodSolution) pFull = Math.max(pFull, 0.05);
    if (ammoFrac < 0.25) { pFull = Math.max(pFull, 0.05); pHold = Math.max(pHold, 0.02); }
    if (p < pHold) return { fire: false, ammo, p, reason: '命中概率' + (100 * p).toFixed(1) + '% 过低（' + (r / 1000).toFixed(1) + 'km）' };
    if (p < pFull || !identified || !goodSolution) {
      const why = [];
      if (!identified) why.push('识别不足');
      if (!goodSolution) why.push('解算误差大');
      if (p < pFull) why.push('命中概率仅' + (100 * p).toFixed(1) + '%');
      return { fire: true, ammo, salvoes: 1, mode: 'SPOT', p, reason: '单发校射（' + why.join('/') + '）' };
    }
    return { fire: true, ammo, salvoes: Infinity, mode: 'FULL', p, reason: '命中概率' + (100 * p).toFixed(1) + '% 全齐射' };
  }

  assignTargets(world, mine, enemies, R) {
    if (!enemies.length) {
      for (const s of mine) {
        const mem = this.memFor(s);
        this.ceaseFire(world, s, mem, true);
      }
      return;
    }
    // 火力分配：统计每条敌舰当前被我方几艘舰集火。史实教范要"集中射撃"，但不是 5 艘打 1 艘
    // 驱逐舰、战列舰却无人问——这里做的是"分配"而不是"扎堆"。
    const engaged = new Map();
    for (const s2 of mine) {
      const m2 = this.memFor(s2);
      if (m2 && m2.firing && m2.targetTrackId) engaged.set(m2.targetTrackId, (engaged.get(m2.targetTrackId) || 0) + 1);
    }
    const spreadOK = mine.length >= enemies.length;   // 我方舰数不占优时不铺开，改为集中火力
    const envA = (world && world.env) || {};
    const nightA = (envA.sunAltDeg !== undefined && envA.sunAltDeg !== null) ? envA.sunAltDeg < -6 : ((envA.lightLevel || 1) < 0.10);
    for (const ship of mine) {
      const mem = this.memFor(ship);
      if (mem.withdraw) {
        this.ceaseFire(world, ship, mem, false);
        continue;
      }
      let best = null, bestScore = -1;
      let bestFree = null, bestFreeScore = -1;   // 未达集火上限的目标（优先）
      for (const e of enemies) {
        const r = dist2d(ship.pos, e.tr.pos);
        const pHit = this.estimateHitProb(ship, e, r, world);
        if (pHit < 0.012) continue;
        const v = this.trackValue(e);
        // 威胁：敌主炮口径量级 × 逼近程度（对方越近威胁越大）
        const cal = ENEMY_CALIBER[e.classifiedAs] || 152;
        const closing = clamp(1 + (20000 - Math.min(r, 20000)) / 12000, 1, 2.4);
        const threat = (cal / 203) * closing;
        let score = v * (0.55 + 0.6 * threat) * (0.25 + 3.2 * pHit);
        const nEng = engaged.get(e.tr.id) || 0;
        // 任务目标（胜利条件）优先；同类里优先更好打沉的（战巡 > 新式战列舰）
        if (this.isObjectiveTarget(world, e.tr)) {
          score *= 1.70;
          if (e.classifiedAs === 'BC') score *= 1.45;
          // 按真实舰种锁定"最好打沉的"（胡德是战巡，装甲与储备浮力都远不如新式战列舰）
          const pref = this.objectivePreferredId(world);
          if (pref) { const set = e.tr._trueIds; if (set && set.has(pref)) score *= 1.60; }
          if (e.tr.id === this.fleet.focusTrackId) score *= 1.30;
        } else if (this.objectiveTargetIds(world).length && (e.classifiedAs === 'BB' || e.classifiedAs === 'BC' || e.classifiedAs === 'CV')) {
          score *= 0.55;   // 有明确任务目标时，别把火力浪费在另一艘主力舰/巡洋舰上
        }
        // 劣势时集中火力：把全队压在编队焦点目标上，而不是分散成两处各打各的
        if (!spreadOK && e.tr.id === this.fleet.focusTrackId) score *= 1.45;
        if (nEng === 0) score *= spreadOK ? 1.30 : 0.85;                      // 占优时才铺开分配
        else if (nEng >= 3) score *= 0.45;                                     // 最多 3 艘集火同一目标
        else if (nEng >= 2 && !HVU_TYPES[e.classifiedAs]) score *= 0.55;        // 非高价值目标不扎堆
        if (e.tr.id === this.fleet.focusTrackId) score *= 1.25;               // 集火加成
        if (mem.targetTrackId === e.tr.id) score *= 1.25;                     // 目标连续性（抑制识别抖动导致的换目标）
        else score *= 0.78;                                                    // 换目标惩罚
        if (ship.type === 'DD' && ARMORED_TYPES[e.classifiedAs]) score *= 0.4; // 驱逐舰不硬拼装甲目标
        // 巡洋舰不拿自己的舷侧去换战列舰的炮弹（远距对射纯亏），优先打同级或驱逐舰
        const heavyMe = ship.type === 'BB' || ship.type === 'BC' || ship.type === 'CV';
        if (!heavyMe && (e.classifiedAs === 'BB' || e.classifiedAs === 'BC') && r > 10000) score *= 0.25;
        if (ship.type === 'DD' && (e.classifiedAs === 'DD' || e.classifiedAs === 'CL') && r < 11000) score *= 1.5;
        if (ship.type === 'BB' && e.classifiedAs === 'DD' && r > 12000) score *= 0.5;
        if (score > bestScore) { bestScore = score; best = { e, r, pHit }; }
        // 硬上限：同一目标最多 3 艘舰集火（高价值目标放宽到 4），其余舰转向次优目标
        const cap = HVU_TYPES[e.classifiedAs] ? 4 : 3;
        if ((engaged.get(e.tr.id) || 0) < cap && score > bestFreeScore) { bestFreeScore = score; bestFree = { e, r, pHit }; }
      }
      if (bestFree) best = bestFree;
      // 关键：在同一轮分配里立即记账，否则所有舰都看到"空"而扎堆同一个目标
      if (best) { const bid = best.e.tr.id; engaged.set(bid, (engaged.get(bid) || 0) + 1); }
      if (!best) {
        this.ceaseFire(world, ship, mem, true);
        continue;
      }
      mem.lastTargetT = world.t;          // 目标短暂消失时的停火抑制依赖这个时间戳
      const gate = this.fireGate(ship, best.e, best.r, world);
      if (!gate.fire) {
        // 停火判据需要连续两轮一致：单轮解算抖动（距离/误差/概率在门限附近摆动）不改变火力状态
        mem.gateFailN = (mem.gateFailN || 0) + 1;
        if (mem.gateFailN >= 2) this.ceaseFire(world, ship, mem, false);
        if (mem.gateReason !== gate.reason) { mem.gateReason = gate.reason; R.push('【控火】' + ship.name + '→' + this.label(best.e) + ' ' + gate.reason + ' → 暂不开火'); }
        continue;
      }
      mem.gateFailN = 0;
      // 目标连续性节流：T2 航迹 id 会随传感器更新不断翻新（T2→T6→T17…），若每轮都按
      // "最佳目标"重发 ASSIGN_TARGET，只是在纸面上换靶——火力没变、命令却翻倍。当前目标
      // 仍在视野内时，至少 targetHoldS（默认 60s）不换靶；目标丢失/沉没才立即重选。
      if (mem.targetTrackId && mem.targetTrackId !== best.e.tr.id) {
        const curStill = enemies.some((x) => x.tr.id === mem.targetTrackId);
        if (curStill && world.t - mem.lastAssignT < this.targetHoldS) continue;
      }
      const targetChanged = mem.targetTrackId !== best.e.tr.id || mem.ammo !== gate.ammo;
      // 夜间照明：目标在夜暗中未被识别时打照明弹（史实：日军在萨沃岛大量使用照明弹与探照灯）。
      // 全队协调：不是每艘舰各自每 45s 打一轮（实测 20 艘舰 10 分钟能刷 82 条照明命令）。
      if (nightA && best.e.classifiedAs === 'UNKNOWN' && best.r < 14000 &&
          (world.t - (mem.lastStar || -1e9)) > this.starHoldS &&
          (world.t - (this.fleet.lastStarT || -1e9)) > this.starFleetHoldS) {
        const starBat = (ship.mainBatteries || []).find((b) => !b.destroyed && b.data && b.data.ammo && (b.data.ammo.STAR || 0) > 0);
        if (starBat) {
          this.order(world, { shipId: ship.id, kind: 'FIRE', params: { trackId: best.e.tr.id, ammo: 'STAR', salvoes: 1, battery: 'main' } });
          mem.lastStar = world.t;
          this.fleet.lastStarT = world.t;
          R.push('【照明】' + ship.name + ' 发射照明弹照亮 ' + this.label(best.e) + '（' + (best.r / 1000).toFixed(1) + 'km）');
        }
      }
      // 开火命令抑制：单发校射（salvoes=1）打完后 commanded.firing 会翻 false，旧逻辑下一
      // 个 8s 决策周期就重发一次 FIRE；目标/弹种/模式都没变时这只是重复命令。现在同目标
      // 至少隔 fireHoldS（默认 60s）才重发，目标/弹种变化仍然立即生效（持续齐射模式下
      // commanded.firing 一直为 true，gunnery 的实际射速不受这条限制影响）。
      const fireModeChanged = mem.fireMode !== gate.mode;
      if (!mem.firing || !ship.commanded.firing || fireModeChanged) {
        const modeCooldownOk = world.t - mem.lastFireT >= this.fireModeHoldS;
        if (targetChanged || (fireModeChanged && modeCooldownOk) || world.t - mem.lastFireT >= this.fireHoldS) {
          // 首次指定目标单独发 ASSIGN_TARGET（保留"指定目标"这一可读事件）；此后换靶时
          // FIRE 命令本身已带 trackId+ammo，再发 ASSIGN_TARGET 纯属重复。
          if (mem.targetTrackId === null) {
            this.order(world, { shipId: ship.id, kind: 'ASSIGN_TARGET', params: { trackId: best.e.tr.id, ammo: gate.ammo } });
          }
          this.order(world, { shipId: ship.id, kind: 'FIRE', params: { trackId: best.e.tr.id, ammo: gate.ammo, salvoes: gate.salvoes } });
          if (targetChanged) R.push('【火力】' + ship.name + '→' + this.label(best.e) + ' ' + (best.r / 1000).toFixed(1) + 'km ' + gate.reason + ' 用' + gate.ammo);
          mem.targetTrackId = best.e.tr.id; mem.ammo = gate.ammo; mem.lastAssignT = world.t;
          mem.firing = true; mem.fireMode = gate.mode; mem.lastFireT = world.t;
          if (gate.mode === 'SPOT') R.push('【控火】' + ship.name + ' ' + gate.reason + '（节约弹药，待距离缩短/解算收敛）');
        } else {
          // 被节流：跟随实际 commanded 状态，避免把"已在持续射击"误记成"还需要下令"
          mem.firing = !!ship.commanded.firing;
        }
      }
      mem.gateReason = null;
    }
  }

  pickAmmo(ship, e, rangeM) {
    const b = (ship.mainBatteries || [])[0];
    const ap = b ? b.ammo.AP : 0, he = b ? b.ammo.HE : 0;
    let want = ARMORED_TYPES[e.classifiedAs] ? 'AP' : 'HE';
    if (want === 'AP' && ap < 30) want = he > 0 ? 'HE' : 'AP';
    if (want === 'HE' && he < 30) want = ap > 0 ? 'AP' : 'HE';
    return want;
  }

  // ── 机动：T 字位 / 免疫区 / 夜间保守 ──────────────────────────────────────
  maneuver(world, mine, enemies, R) {
    const hvuPresent = mine.some((s) => HVU_TYPES[s.type] && !this.memFor(s).withdraw);
    for (const ship of mine) {
      const mem = this.memFor(ship);
      if (mem.withdraw) continue;
      if (world.t < mem.evadeUntil) continue;               // 避雷机动优先
      // 屏护舰的航路由 screen() 安排（占位/前出），只有在无屏护对象时才自行机动
      if (hvuPresent && (ship.type === 'DD' || ship.type === 'CL')) continue;
      const light = world.env && world.env.lightLevel !== undefined ? world.env.lightLevel : 1;
      const night = light < 0.15;
      // 目标
      // 机动目标用「编队焦点」（稳定，含迟滞）；开火目标仍可用各舰自己的解算目标
      let e = null;
      if (this.fleet.focusTrackId) e = enemies.find((x) => x.tr.id === this.fleet.focusTrackId) || null;
      if (!e && mem.targetTrackId) e = enemies.find((x) => x.tr.id === mem.targetTrackId) || null;
      if (!e) e = enemies.find((x) => dist2d(ship.pos, x.tr.pos) < 26000) || null;
      if (!e) { this.searchMove(world, ship, mem, night); continue; }

      const r = dist2d(ship.pos, e.tr.pos);
      const enemyCourse = e.tr.courseDeg !== undefined ? e.tr.courseDeg : bearing2d(ship.pos, e.tr.pos);
      const band = this.decisiveBand(ship, e.classifiedAs, world);
      const brgEnemy = bearing2d(ship.pos, e.tr.pos);
      const usable = (ship.mainBatteries || []).length > 0 && r < Math.max(20000, 1.05 * this.mainRange(ship));
      let desired, phase;
      if (!usable) {
        desired = brgEnemy; phase = 'APPROACH';
      } else if (r > band.max) {
        // ── 接近阶段：以 25° 接近角向目标机动（保持舷侧火力、同时快速缩短距离），全速
        //    选侧必须锁定：每 8s 决策来回翻侧会让接近率腰斩（实测 20m/s → 5m/s）
        if (mem.sideSign === undefined || world.t - (mem.sideSignT || -1e9) > 300) {
          const cA = normDeg(brgEnemy + 20), cB = normDeg(brgEnemy - 20);
          const dA = Math.min(Math.abs(normDeg180(cA - normDeg(enemyCourse + 90))), Math.abs(normDeg180(cA - normDeg(enemyCourse - 90))));
          const dB = Math.min(Math.abs(normDeg180(cB - normDeg(enemyCourse + 90))), Math.abs(normDeg180(cB - normDeg(enemyCourse - 90))));
          const pick = dA <= dB ? 1 : -1;
          // 只有当前锁定侧已经把我们带偏 >100° 时才换侧（换侧＝掉头，接近率损失极大）
          const cur = normDeg(brgEnemy + (mem.sideSign || pick) * 20);
          mem.sideSign = (mem.sideSign !== undefined && Math.abs(normDeg180(cur - ship.heading)) < 100) ? mem.sideSign : pick;
          mem.sideSignT = world.t;
        }
        phase = 'APPROACH';
        desired = normDeg(brgEnemy + mem.sideSign * 20);
      } else if (r < band.min) {
        // ── 过近（危险区）：越陷越深就直接转背敌方向拉开，浅则只偏 25°
        phase = 'OPEN';
        const tCross = normDeg(enemyCourse + 90);
        const away = normDeg(brgEnemy + 180);
        const urgency = clamp((band.min - r) / Math.max(1, band.min * 0.5), 0, 1);
        const pull = 25 + urgency * 95;
        desired = normDeg(tCross + clamp(normDeg180(away - tCross), -pull, pull));
      } else {
        // ── 交战阶段：抢占 T 字位（横阵对敌纵列），并向决战距离内沿（有效命中距离）收缩
        phase = 'ENGAGE';
        const cA = normDeg(enemyCourse + 90), cB = normDeg(enemyCourse - 90);
        if (mem.crossSign === undefined || world.t - (mem.crossSignT || -1e9) > 240 || mem.crossSignTrack !== mem.targetTrackId) {
          let bestH = cA, bestCost = 1e9;
          for (const h of [cA, cB]) {
            const r240 = this.predictRange(ship, h, e, 240);
            let cost = Math.abs(normDeg180(h - ship.heading)) * 0.5;
            if (r240 < band.min) cost += (band.min - r240) / 300;
            if (r240 > band.max) cost += (r240 - band.max) / 300;
            if (cost < bestCost) { bestCost = cost; bestH = h; }
          }
          mem.crossSign = bestH === cA ? 1 : -1; mem.crossSignT = world.t; mem.crossSignTrack = mem.targetTrackId;
        }
        desired = mem.crossSign > 0 ? cA : cB;
        if (r > band.min) {   // 仍偏远：向敌压近（最多 40°），把距离收到决战距离内沿
          const pull = clamp(10 + (r - band.min) / 200, 0, 40);
          desired = normDeg(desired + clamp(normDeg180(brgEnemy - desired), -pull, pull));
        }
      }
      mem.phase = phase;
      if (this.setCourse(world, ship, desired, mem, phase === 'APPROACH' && r > band.max * 1.4)) {
        const tag = phase === 'APPROACH' ? '接近' : (phase === 'ENGAGE' ? '交战(T字位)' : '拉开');
        R.push('【' + tag + '】' + ship.name + ' 航向' + Math.round(normDeg(desired)) +
          ' 决战距离' + (band.min / 1000).toFixed(0) + '-' + (band.max / 1000).toFixed(0) + 'km' + (band.night ? '(夜)' : '') +
          ' 现距' + (r / 1000).toFixed(1) + 'km');
      }
      // 航速：接近阶段全速；夜间远距（尚无接触）保守减速；受损限速
      const maxKn = Math.min(ship.data.speedMax_kn || 30, ship.speedCapKn || 30);
      let wantKn;
      if (phase === 'APPROACH') wantKn = maxKn * 0.95;
      else if (phase === 'ENGAGE') wantKn = maxKn * 0.9;
      else wantKn = maxKn * 0.8;
      if (night && r > band.max * 1.8) { wantKn = maxKn * 0.72; if (this.setSpeed(world, ship, wantKn, mem)) R.push('【夜间】' + ship.name + ' 隐密接近 ' + wantKn.toFixed(0) + '节（远距无接触，降低航迹暴露）'); }
      else this.setSpeed(world, ship, wantKn, mem);
      // 夜战照明：近距离用探照灯，中距用照明弹
      if (night) {
        if (r < 4500 && !ship.flags.searchlight.on) {
          this.order(world, { shipId: ship.id, kind: 'SEARCHLIGHT', params: { on: true, bearing: bearing2d(ship.pos, e.tr.pos) } });
          R.push('【照明】' + ship.name + ' 探照灯照射' + this.label(e) + '（' + (r / 1000).toFixed(1) + 'km，暴露阵位换取命中）');
        } else if (r >= 4500 && r < 9000 && !ship.flags.starshellArmed) {
          this.order(world, { shipId: ship.id, kind: 'STAR_SHELL', params: { bearing: bearing2d(ship.pos, e.tr.pos), range: r } });
          R.push('【照明】' + ship.name + ' 照明弹 ' + (r / 1000).toFixed(1) + 'km');
        }
      }
    }
  }

  mainRange(ship) {
    let mx = 0;
    for (const b of ship.mainBatteries || []) mx = Math.max(mx, (b.data && b.data.maxRange_m) || 20000);
    return mx || 20000;
  }
  // 拦截航向：向目标未来位置（拦截点）航行——雷击占位/接近用
  interceptHeading(ship, targetTrack, ownSpeedMps) {
    const eCourse = targetTrack.courseDeg || 0, eV = kn2mps(targetTrack.speedKn || 15);
    let p = { x: targetTrack.pos.x, y: targetTrack.pos.y };
    for (let i = 0; i < 4; i++) {
      const t = dist2d(ship.pos, p) / Math.max(1, ownSpeedMps);
      p = destPoint(targetTrack.pos, eV * t, eCourse);
    }
    return bearing2d(ship.pos, p);
  }
  predictRange(ship, heading, e, seconds) {
    const shipV = kn2mps(Math.min(ship.commanded.speed || ship.speed, ship.data.speedMax_kn || 30));
    const eSpeed = e.tr.speedKn !== undefined ? e.tr.speedKn : 18;
    const eCourse = e.tr.courseDeg !== undefined ? e.tr.courseDeg : 0;
    const p1 = destPoint(ship.pos, shipV * seconds, heading);
    const p2 = destPoint(e.tr.pos, kn2mps(eSpeed) * seconds, eCourse);
    return dist2d(p1, p2);
  }

  searchMove(world, ship, mem, night) {
    // 无接触：沿最后已知敌向/剧本目标搜索，各舰保持阵位（雷达搜索）
    let h = ship.commanded.heading;
    if (this.fleet.threatAxisDeg !== null) h = this.fleet.threatAxisDeg;
    else {
      const sc = world.scenario || {};
      const obj = (sc.objectives || []).find((o) => o.side === this.side && o.condition && o.condition.area);
      if (obj && obj.condition.area) h = bearing2d(ship.pos, obj.condition.area);
    }
    this.setCourse(world, ship, h, mem);
    const kn = (ship.data.speedMax_kn || 30) * (night ? 0.7 : 0.85);
    this.setSpeed(world, ship, kn, mem);
    if (!(ship.sensors || []).some((s) => s.srcKind === 'RADAR' && s.on) && (ship.sensors || []).some((s) => s.srcKind === 'RADAR')) {
      this.order(world, { shipId: ship.id, kind: 'RADAR', params: { on: true } });
    }
  }

  // ── 阵型与屏护（驱逐舰前出） ──────────────────────────────────────────────
  screen(world, mine, enemies, R) {
    const hvu = mine.filter((s) => HVU_TYPES[s.type] && !this.memFor(s).withdraw).sort((a, b) => (TYPE_VALUE[b.type] || 0) - (TYPE_VALUE[a.type] || 0));
    const escorts = mine.filter((s) => (s.type === 'DD' || s.type === 'CL') && !this.memFor(s).withdraw);
    if (!hvu.length || !escorts.length) return;
    const axis = this.fleet.threatAxisDeg !== null ? this.fleet.threatAxisDeg : hvu[0].heading;
    const flag = hvu[0];
    const stations = [0, -32, 32, -64, 64, -100, 100];
    escorts.forEach((dd, i) => {
      const mem = this.memFor(dd);
      if (world.t < mem.evadeUntil) return;
      if (mem.attacking && world.t < mem.attacking) return;   // 正在雷击突击：由 torpedoAttack 指挥
      if (world.t - mem.lastTorpT < 90) return;      // 刚完成雷击，正在脱离/再装填
      const off = stations[i % stations.length];
      const stationBearing = normDeg(axis + off);
      const rangeM = dd.type === 'CL' ? 4500 : (i % 2 === 0 ? 2800 : 3600);
      const goal = destPoint(flag.pos, rangeM, stationBearing);
      const d = dist2d(dd.pos, goal);
      if (!mem.screenStation || Math.abs(normDeg180(mem.screenStation.bearingDeg - stationBearing)) > 10) {
        mem.screenStation = { bearingDeg: normDeg(stationBearing), rangeM };
        this.order(world, { shipId: dd.id, kind: 'FORMATION', params: { station: mem.screenStation } });
      }
      if (d > 900) {
        const h = bearing2d(dd.pos, goal);
        if (this.setCourse(world, dd, h, mem)) {
          R.push('【屏护】' + dd.name + ' 前出阵位 方位' + Math.round(normDeg(stationBearing)) + ' ' + (rangeM / 1000).toFixed(1) + 'km（威胁轴' + Math.round(axis) + '°）');
        }
        this.setSpeed(world, dd, dd.data.speedMax_kn * 0.9, mem);
      }
    });
  }

  // ── 雷击突击 ──────────────────────────────────────────────────────────────
  torpedoAttack(world, mine, enemies, R) {
    if (!enemies.length) return;
    for (const dd of mine) {
      const mem = this.memFor(dd);
      if (mem.withdraw || world.t < mem.evadeUntil) continue;
      if (!TORPEDO_TYPES_ALLOWED[dd.type]) continue;
      const mounts = (dd.torpedoMounts || []).filter((m) => !m.destroyed && m.health > 0.2 && m.tubesLoaded > 0);
      if (!mounts.length) continue;
      if (world.t - mem.lastTorpT < 200) continue;     // 攻击周期（含脱离与再装填）
      const mount = mounts[0];
      const spec = torpedoSpecFor(dd, mount);
      const maxSettingM = Math.max.apply(null, spec.rangesM);
      const band = this.decisiveBand(dd, 'CA', world);
      const night = band.night;
      // 雷击窗口：夜战 1.2~6.5km、日间 2~8.5km。史实（萨沃岛 1.5-3km、塔萨法隆加 2-4km）
      // 都是接近到极近距离横越齐射；几千米外放雷基本全脱靶。
      const winMin = night ? 1200 : 2000, winMax = night ? 6500 : 8500;
      let target = null, tsol = null, bestScore = -1;
      for (const e of enemies) {
        const r = dist2d(dd.pos, e.tr.pos);
        if (r < 500 || r > Math.min(maxSettingM * 0.9, 18000)) continue;
        // 舷角窗口 60~120°（横越）——命中投影最大、提前量解算最稳
        const aspect = aspectAngle(e.tr.courseDeg || 0, bearing2d(e.tr.pos, dd.pos));
        if (aspect < 60 || aspect > 120) continue;
        const tof = solveIntercept(dd.pos.x, dd.pos.y, e.tr.pos.x, e.tr.pos.y, e.tr.courseDeg || 0, kn2mps(e.tr.speedKn || 15), kn2mps(spec.speedsKn[0])).tofS;
        if (tof > (night ? 300 : 420)) continue;        // 航程太长＝目标有充足规避时间
        let score = this.trackValue(e);
        if (e.tr.id === this.fleet.vanTrackId) score *= 1.35;               // 优先战列线前导舰
        if (ARMORED_TYPES[e.classifiedAs] || e.classifiedAs === 'CV') score *= 1.25;
        if (r >= winMin && r <= winMax) score *= 1.6;                        // 已在窗口内
        if (aspect > 70 && aspect < 110) score *= 1.2;
        if (e.tr.id === mem.torpedoTargetId) score *= 0.6;
        score /= Math.max(1, tof / 120);
        if (score > bestScore) { bestScore = score; target = e; tsol = { r, tof, aspect }; }
      }
      if (!target) continue;
      if (tsol.r > winMax) {
        // ── 突击占位阶段：按拦截航向压到雷击窗口，全速（占位期间由本函数指挥，屏护让位）
        const h = this.interceptHeading(dd, target.tr, kn2mps(spec.speedsKn[0]) * 0.92);
        mem.attacking = world.t + 120;
        if (this.setCourse(world, dd, h, mem)) {
          R.push('【雷击】' + dd.name + ' 突击占位 航向' + Math.round(h) + '→' + this.label(target) + ' ' + (tsol.r / 1000).toFixed(1) +
            'km 舷角' + Math.round(tsol.aspect) + '°（窗口 ' + (winMin / 1000).toFixed(1) + '-' + (winMax / 1000).toFixed(1) + 'km 全速）');
        }
        this.setSpeed(world, dd, dd.data.speedMax_kn || 30, mem);
        continue;
      }
      // 友舰安全走廊：射向 ±(扇面/2+2°) 内、航程+1000m 内不得有本舰队友
      const trackCourse = bearing2d(dd.pos, target.tr.pos);
      const errM = target.tr.errM !== undefined ? target.tr.errM : 400;
      const spread = clamp(rad2deg(2.2 * Math.atan2(errM, Math.max(1000, tsol.r))) + 2, 2, 12);
      if (!this.corridorClear(world, dd, target, trackCourse, spread, tsol.r)) continue;
      // 管数：高价值目标 6 管，一般 4 管；保留至少 2 管
      const loaded = mount.tubesLoaded;
      let tubes = ARMORED_TYPES[target.classifiedAs] || target.classifiedAs === 'CV' ? Math.min(loaded, 6) : Math.min(loaded, 4);
      tubes = Math.max(1, Math.min(tubes, loaded - (loaded > 4 ? 2 : 0)));
      // 档位：按「实际拦截点航程」选能到达的最快档（目标逃逸时拦截点更远，必须用拦截三角算）
      let speedIdx = spec.speedsKn.length - 1;
      {
        const eCourse = target.tr.courseDeg || 0, eV = kn2mps(target.tr.speedKn || 15);
        for (let i = 0; i < spec.speedsKn.length; i++) {
          const s = solveIntercept(dd.pos.x, dd.pos.y, target.tr.pos.x, target.tr.pos.y, eCourse, eV, kn2mps(spec.speedsKn[i]));
          if (s.runM <= spec.rangesM[i] * 0.98) { speedIdx = i; break; }
        }
      }
      // 协同雷击：同一目标若 30 秒内已有友舰放过雷，则错开再放——多批次先后到达会打乱
      // 对方的规避（史实日军水雷战队就是分批放雷），而不是所有管一次泼出去。
      if (!this.fleet.torpAt) this.fleet.torpAt = {};
      const lastAt = this.fleet.torpAt[target.tr.id] || -1e9;
      if (world.t - lastAt < 30) continue;
      // 不把鱼雷浪费在已经明显失能的目标上（航速塌到 4 节以下说明已被打残，留着打新目标）
      if (target.tr.speedKn !== undefined && target.tr.speedKn > 0 && target.tr.speedKn < 4 && !ARMORED_TYPES[target.classifiedAs]) continue;
      this.order(world, { shipId: dd.id, kind: 'LAUNCH_TORPEDO', params: { trackId: target.tr.id, spreadDeg: +spread.toFixed(1), tubes, speedIdx } });
      this.fleet.torpAt[target.tr.id] = world.t;
      mem.lastTorpT = world.t; mem.torpedoTargetId = target.tr.id;
      mem.attacking = world.t + 90;                    // 发射后 90s 脱离/再装填（屏护让位）
      R.push('【雷击】' + dd.name + '→' + this.label(target) + ' ' + (tsol.r / 1000).toFixed(1) + 'km 舷角' + Math.round(tsol.aspect) +
        '° 发射' + tubes + '雷 ' + spec.speedsKn[speedIdx] + '节 扇面' + spread.toFixed(1) + '° 预计命中' + Math.round(tsol.tof) + 's（' + spec.wakeType + '航迹）');
      // 发射后转向脱离：与射向垂直（横过后再拉开），并施烟掩护
      const away = normDeg(trackCourse + 180 + (Math.abs(normDeg180(trackCourse + 90 - dd.heading)) < Math.abs(normDeg180(trackCourse - 90 - dd.heading)) ? 75 : -75));
      this.setCourse(world, dd, away, mem, true);
      this.setSpeed(world, dd, dd.data.speedMax_kn || 30, mem, true);
      if (tsol.r < 12000) this.smoke(world, dd, true);
    }
  }

  corridorClear(world, dd, target, courseDeg, spread, runM) {
    const half = clamp(spread / 2 + 2, 2, 12) * Math.PI / 180;
    for (const f of world.shipsOf(this.side)) {
      if (f.id === dd.id || !f.isAfloat) continue;
      const brg = bearing2d(dd.pos, f.pos);
      const d = dist2d(dd.pos, f.pos);
      if (d > runM + 1200) continue;
      if (Math.abs(normDeg180(brg - courseDeg)) * Math.PI / 180 < half + Math.atan2(30, Math.max(200, d))) return false;
    }
    return true;
  }

  // ── 弹药经济 ──────────────────────────────────────────────────────────────
  ammoEconomy(world, mine, R) {
    for (const ship of mine) {
      const mem = this.memFor(ship);
      const b = (ship.mainBatteries || [])[0];
      if (!b) continue;
      const total = (b.ammo.AP || 0) + (b.ammo.HE || 0);
      const avail = b.data && b.data.ammo ? ((b.data.ammo.AP || 0) + (b.data.ammo.HE || 0)) : 1;
      if (total / Math.max(1, avail) < 0.18 && !mem.ammoLow) {
        mem.ammoLow = true;
        R.push('【弹药】' + ship.name + ' 主炮弹药仅剩' + total + '发（' + Math.round(100 * total / avail) + '%）→ 只打 12000m 内有把握的目标');
      }
    }
  }

  // ── 撤退 ──────────────────────────────────────────────────────────────────
  retirementAxis(world) { return this.fleet.threatAxisDeg !== null ? normDeg(this.fleet.threatAxisDeg + 180) : null; }
  retreatHeading(world, ship) {
    let h = this.retirementAxis(world);
    if (h === null) {
      const sc = world.scenario || {};
      const start = (sc.ships || []).find((s) => s.id === ship.id) || {};
      if (start.x !== undefined && (start.x !== 0 || start.y !== 0)) h = bearing2d(ship.pos, { x: start.x, y: start.y });
      else h = normDeg(ship.heading + 90);
    }
    return h;
  }
  // 单舰脱离操舵：背离威胁轴、全速、烟幕掩护
  retreatShip(world, ship, mem, R) {
    const foes = world.afloatOf(world.opposite(this.side));
    if (!foes.length) return;
    let threat = null, best = -1;
    for (const f of foes) {
      const d = dist2d(ship.pos, f.pos);
      const v = (TYPE_VALUE[f.type] || 30) / Math.max(1000, d);
      if (v > best) { best = v; threat = f; }
    }
    if (!threat) return;
    const away = bearing2d(threat.pos, ship.pos);
    if (this.setCourse(world, ship, away, mem, true)) R.push('【脱离】' + ship.name + ' 背离威胁 航向' + Math.round(away) + '°');
    this.setSpeed(world, ship, ship.data.speedMax_kn || 30, mem);
    if (!(ship.flags && ship.flags.smokeOn) && world.t - (mem.lastRetreatSmoke || -1e9) > 45) {
      this.order(world, { shipId: ship.id, kind: 'SMOKE', params: { on: true } });
      mem.lastRetreatSmoke = world.t;
    }
  }

  fleetRetreat(world, mine, R) {
    for (const ship of mine) {
      const mem = this.memFor(ship);
      // 注意：不能因为 mem.withdraw 就跳过——那些正是最需要操舵撤离的舰。
      // （旧代码在这里 continue，导致"已决定撤退"的舰反而没人管航向，继续朝敌航行。）
      const h = this.retreatHeading(world, ship);
      this.setCourse(world, ship, h, mem);
      this.setSpeed(world, ship, (ship.data.speedMax_kn || 30) * 0.9, mem);
      const threats = world.tracks.visibleFor(ship) || [];
      if (threats.some((t) => dist2d(ship.pos, t.pos) < 24000)) this.smoke(world, ship, true);
    }
    if (R) R.push('【脱离】全队背敌 ' + Math.round(this.retirementAxis(world) || 0) + '° 撤退，烟幕掩护');
  }

  // ── 损管优先级 ────────────────────────────────────────────────────────────
  dcMode(ship, mem, tNow) {
    const comps = ship.compartments || [];
    const magThreat = comps.some((c) => c.isMagazine && (c.fire > 0.03 || (c.breached && c.flood_m3 < c.volume_m3 * 0.15)));
    if (magThreat) return 'magazine';
    // 进水速率（m^3/s）是否超过排水泵能力：超过就全力堵漏/排水
    if (mem && mem.prevFlood !== undefined && mem.prevFloodT !== undefined) {
      const dtEff = Math.max(0.5, tNow - mem.prevFloodT);
      const rate = (ship.floodedM3 - mem.prevFlood) / dtEff;
      mem.prevFlood = ship.floodedM3; mem.prevFloodT = tNow;
      if (rate > ship.pumpCapacity / 60 * 1.15) return 'flooding';
    } else if (mem) { mem.prevFlood = ship.floodedM3; mem.prevFloodT = tNow; }
    const fires = comps.filter((c) => c.fire > 0.05).length;
    if (fires >= 1 && !ship.compartments.some((c) => c.breached)) return 'fire';
    if (Math.abs(ship.list || 0) > 6 || ship.floodedM3 > 0) return 'flooding';
    if (fires > 0) return 'fire';
    const engine = (ship.subsystems || []).filter((s) => (s.kind === 'BOILER' || s.kind === 'SHAFT' || s.kind === 'STEERING_GEAR') && s.health < 0.5).length;
    if (engine) return 'mobility';
    return null;
  }
}
