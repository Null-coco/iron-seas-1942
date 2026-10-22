// AI 作战上下文层（Lead 维护）：给外部智能体/LLM 提供"真正的上下文"，而不是单帧快照。
// 组成：
//   1) 持久对话记忆：每个阵营一条会话，system + 历史决策轮次（含它自己的意图与命令），可压缩旧轮次。
//   2) 战况纪要：自上次决策以来该方可见的事件、命令生效情况、目标机动变化（距离变化率/是否转向）。
//   3) 航迹记忆：首次发现时间、历史距离与航向，用于判断"敌人在接近还是脱离、有没有机动"。
//   4) 约束与条令：任务、史实背景、可用命令、指挥延迟、无线电静默、弹药经济、二战红线。
// 只使用 world.visibleStateFor(side) 与事件可见性过滤 —— 绝不泄漏敌方真值。
import { NMI, fmtClockHM, normDeg } from '../core/util.js';

const CMD_SPEC = [
  'SET_COURSE{heading:0-359}  设定真航向',
  'SET_SPEED{kn:0-33}         设定航速',
  'SET_RUDDER{deg:-35..35}    直接操舵（-左 +右）',
  'FIRE{trackId,ammo:"AP"|"HE",salvoes:整数|null}  对指定航迹开火（null=持续）',
  'CEASE_FIRE{}               停火',
  'LAUNCH_TORPEDO{trackId,spreadDeg:1-8,tubes:1-5,speedIdx:0|1}  雷击（0=高速档 1=低速档）',
  'ASSIGN_TARGET{trackId,ammo} 指定本舰主目标',
  'SMOKE{on:true|false}       施放/停止烟幕',
  'SEARCHLIGHT{on,bearing}    探照灯（会暴露自己）',
  'RADAR{on} / SONAR{on}      雷达/声呐开关',
  'CHAFF{}                    施放箔条（干扰敌方雷达）',
  'STAR_SHELL{bearing,range}  发射照明弹',
  'DC_PRIORITY{mode:"flooding"|"fire"|"magazine"|"mobility"}  损管优先级',
  'WITHDRAW{}                 脱离战斗',
  'FORMATION{station:{bearingDeg,rangeM}}  编队阵位',
];

// dam.magazine 的 result → 给 LLM 看的中文措辞（result 取值见 src/sim/damage.js）
const MAGAZINE_RESULT_ZH = Object.freeze({
  detonation: '弹药库殉爆',
  burn: '弹药库爆燃',
  flash: '弹药库闪燃（炮塔传火）',
  hit: '弹药库被击穿',
  flooded: '弹药库注水（弹药报废，避免殉爆）',
  fire_threat: '弹药库受火势威胁',
});

export class AIContext {
  constructor(world, side, opts = {}) {
    this.world = world;
    this.side = side;
    this.maxTurns = opts.maxTurns || 8;          // 保留的历史决策轮次
    this.maxBriefChars = opts.maxBriefChars || 6000;  // 单次态势简报上限（超出则精简）
    this.compact = !!opts.compact;                    // 精简模式：给快模型用，输入更短 → 更快
    this.turns = [];          // [{t, user, assistant, intent, commands}]
    this.trackMem = new Map(); // trackId -> 记忆
    this.orderMem = [];        // 本阵营已下达命令（含生效时刻与是否生效）
    this.eventCursor = 0;      // 已消费的事件序号
    this.pendingEvents = [];   // 自上次决策以来可见的事件
    this.lastIntent = '';
    this.totalDecisions = 0;
    this.createdAt = world ? world.t : 0;
    const s = world && world.sides ? world.sides[side] : null;
    this.mission = (s && s.objective) || '';
  }

  // ---------- 系统提示词：一次成型，之后只追加对话 ----------
  systemPrompt() {
    const w = this.world, sc = w.scenario || {};
    const s = (w.sides && w.sides[this.side]) || {};
    const sideZh = this.side === 'ALLIED' ? '同盟国' : '轴心国';
    const L = [];
    L.push('你是 1942 年' + sideZh + '海军编队指挥官（' + (s.nameZh || '') + '），在真实历史战役中指挥本编队作战。');
    L.push('战役：' + (sc.nameZh || sc.id) + '（' + (sc.date || '') + '，' + (sc.place || '') + '）');
    if (sc.historicalNote) L.push('史实背景：' + String(sc.historicalNote).slice(0, 400));
    L.push('你的任务：' + (this.mission || '按战术常规作战'));
    L.push('指挥延迟：你的命令约 ' + ((s.orderDelay_s !== undefined ? s.orderDelay_s : 8)) + ' 秒后生效；超视距还要更久。你必须按"命令会延迟"来思考，不能假设立刻生效。');
    L.push('');
    L.push('你只能依据"已知情报"决策：情报是雷达/目视/声呐的融合结果，带误差(errM/errDeg)、延迟(ageS)与置信度(confidence)；');
    L.push('判型可能是 UNKNOWN，夜间远距尤其不可靠。绝不能假设你知道敌舰的真实位置、航向、航速或损伤。');
    L.push('');
    L.push('可用命令（JSON 数组 commands，每条必须带 shipId 与 kind）：');
    for (const c of CMD_SPEC) L.push('  ' + c);
    if (this.compact) L.push('（精简模式：直接给出命令即可，不必长篇分析。）');
    L.push('另外可用 chat 字段向旗舰/参谋发一句中文电报（会显示在指挥所），reasoning 字段写你的战术判断（中文，供复盘）。');
    L.push('');
    if (!this.compact) L.push('条令要点（1942 年海战常识）：');
    L.push('  · 保持无线电静默，尽量用旗语/信号灯；只有必要时发报。');
    L.push('  · 主力舰日间接近到有效交战距离(11-18km)才全齐射，远距只做单发校射以节省弹药；夜间靠雷达火控接近到 5-9km。');
    L.push('  · 驱逐舰夜间前出 2-6km 抢占雷击阵位，发射后立即转向脱离并施放烟幕。');
    L.push('  · 弹药库附近起火优先注水；进水导致横倾时优先堵漏与反击水；航速是生命，动力舱受损优先抢修。');
    L.push('  · 避免被占据 T 字横头；受伤严重（航速骤降/横倾大）就退出战斗，不要送死。');
    L.push('');
    L.push('输出格式（严格 JSON，不要输出任何其他文字，不要输出思考过程）：');
    L.push('{"reasoning":"中文战术判断，150字内","chat":"可选电报","commands":[{"shipId":"...","kind":"SET_COURSE","params":{"heading":240},"note":"意图"}],"intent":"本阶段作战意图一句话"}');
    return L.join('\n');
  }

  // ---------- 每周期态势简报 ----------
  buildSituation(userText) {
    const w = this.world;
    const st = w.visibleStateFor(this.side);
    const L = [];
    L.push('=== 态势 ' + fmtClockHM(w.t) + '（当地时间 ' + (st.environment.timeOfDayH || 0).toFixed(2) + 'h，光照 ' + st.environment.lightLevel.toFixed(2) +
      '，海况 ' + st.environment.seaState + '，风 ' + st.environment.windKn + 'kn/' + st.environment.windDirDeg + '°，能见度 ' + st.environment.visibilityNm + 'nm）===');

    L.push('【我方编队】');
    for (const s of st.ownShips) {
      const dmg = [];
      if (s.floodedPct > 0.5) dmg.push('进水' + s.floodedPct + '%');
      if (s.fires) dmg.push('火灾' + s.fires + '处');
      if (Math.abs(s.list) > 3) dmg.push('横倾' + s.list + '°');
      if (s.crewPct < 0.98) dmg.push('舰员' + Math.round(s.crewPct * 100) + '%');
      const dead = s.batteries.filter((b) => b.destroyed).map((b) => b.label);
      if (dead.length) dmg.push('炮座损毁:' + dead.join(','));
      const gunAmmo = s.batteries.filter((b) => b.role === 'main').reduce((a, b) => a + b.ammo.AP + b.ammo.HE, 0);
      const torps = (s.torpedoes || []).reduce((a, m) => a + (m.destroyed ? 0 : m.loaded), 0);
      L.push('  ' + s.id + ' ' + s.name + '（' + s.type + '）位置(' + Math.round(s.pos.x) + ',' + Math.round(s.pos.y) + ') 航向' + s.heading + ' 航速' + s.speed +
        'kn 航速上限' + s.speedCapKn + ' 舵' + s.rudder + '° 主炮弹药' + gunAmmo + '发 鱼雷' + torps + '管' +
        (dmg.length ? ' 损伤:' + dmg.join('/') : ' 无损伤') +
        ' 当前命令:航向' + s.commanded.heading + '/速度' + s.commanded.speed + (s.commanded.firing ? '/射击中(' + (s.commanded.targetTrackId || '未指定目标') + ')' : '/未开火') +
        ' 损管优先:' + ((s.dc && s.dc.priority) || 'flooding'));
    }

    L.push('【已知敌情/航迹】' + (st.tracks.length ? '' : '（暂无目标）'));
    const trackLimit = this.compact ? 10 : 999;
    for (const t of st.tracks.slice(0, trackLimit)) {
      const mem = this.trackMem.get(t.id);
      let extra = '';
      if (mem) {
        const nowR = mem.nowRangeM !== undefined ? mem.nowRangeM : t.rangeM;
        const dRange = (nowR - mem.lastRangeM) / 1000;
        const dt = Math.max(1, (mem.nowT !== undefined ? mem.nowT : w.t) - mem.lastT);
        const closingKn = -(dRange * 1000 / dt) / 0.514444;
        extra = ' | 变化:距离' + (dRange >= 0 ? '+' : '') + dRange.toFixed(1) + 'km/' + Math.round(dt) + 's(≈' + (closingKn >= 0 ? '接近' : '远离') + Math.abs(closingKn).toFixed(1) + 'kn)';
        if (mem.lastCourse !== undefined && Math.abs(((t.courseDeg - mem.lastCourse + 540) % 360) - 180) > 15) extra += ' 已转向';
        if (t.confidence > mem.lastConf + 0.15) extra += ' 判型改善';
      }
      const spd = (!t.speedKn || t.speedKn <= 0.5) ? '航速未知(未解算) 航向未知' : ('航速' + t.speedKn + 'kn 推断航向' + t.courseDeg);
      L.push('  ' + t.id + ' 判型' + t.classifiedAs + ' 距离' + (t.rangeM / NMI).toFixed(1) + 'nm 方位' + t.bearingDeg + '° ' + spd +
        ' 置信' + t.confidence + ' 误差±' + t.errM + 'm/±' + t.errDeg + '° 来源' + (t.sources || []).join('+') +
        ' 最后更新' + Math.round(t.ageS) + 's前' + (mem ? ' 首次发现' + Math.round(w.t - mem.firstSeen) + 's前' + extra : ''));
    }

    if (this.pendingEvents.length) {
      L.push('【自上次决策以来的战况】');
      const evLimit = this.compact ? 8 : 24;
      for (const e of this.pendingEvents.slice(-evLimit)) L.push('  ' + fmtClockHM(e.t) + ' ' + e.text);
    }
    if (this.orderMem.length) {
      L.push('【我下达过的命令（最近）】');
      for (const o of this.orderMem.slice(-10)) L.push('  ' + fmtClockHM(o.t_issue) + ' ' + o.kind + ' ' + (o.shipId || '全队') + ' ' + JSON.stringify(o.params || {}) + ' → 生效于' + fmtClockHM(o.t_effective) + (o.accepted === false ? '（被拒）' : ''));
    }
    if (this.lastIntent) L.push('【上周期我的意图】' + String(this.lastIntent).slice(0, this.compact ? 60 : 400));
    L.push('');
    L.push('【本周期要求】' + (userText || '依据以上态势下达本周期命令；如果计划未变，也要重申关键命令或明确说明保持。'));
    return L.join('\n');
  }

  // ---------- 组装完整 messages（含历史对话） ----------
  build(userText) {
    this._absorb();
    const sys = this.systemPrompt();
    const situation = this.buildSituation(userText);
    const msgs = [{ role: 'system', content: sys }];
    // 历史轮次：压缩成简短回顾，避免上下文无限膨胀
    if (this.turns.length && !this.compact) {
      const lines = [];
      for (const tn of this.turns.slice(-this.maxTurns)) {
        lines.push('[' + fmtClockHM(tn.t) + '] 意图:' + (tn.intent || '未说明') + ' | 命令:' + (tn.commands || []).map((c) => c.kind + (c.shipId ? '@' + c.shipId : '')).join(','));
        if (tn.assistant) lines.push('    我方电报/判断摘要:' + String(tn.assistant).replace(/\s+/g, ' ').slice(0, 160));
      }
      msgs.push({ role: 'user', content: '【既往决策回顾（从早到晚）】\n' + lines.join('\n') });
      if (this.turns.length && this.turns[this.turns.length - 1].assistant) {
        msgs.push({ role: 'assistant', content: String(this.turns[this.turns.length - 1].assistant).slice(0, 2000) });
      }
    }
    msgs.push({ role: 'user', content: situation });
    return { messages: msgs, system: sys, situation };
  }

  // ---------- 记忆更新 ----------
  remember(rawText, decision) {
    const w = this.world;
    this.totalDecisions++;
    const intent = (decision && decision.intent) || (decision && decision.reasoning ? String(decision.reasoning).slice(0, 120) : '');
    this.lastIntent = intent || this.lastIntent;
    this.turns.push({
      t: w.t, user: this._lastSituation || '', assistant: rawText || '',
      intent, commands: (decision && decision.commands) || [],
    });
    if (this.turns.length > this.maxTurns * 2) this.turns.splice(0, this.turns.length - this.maxTurns);
    this._snapshotTracks(true);
  }

  // 吸收自上次决策以来的事件与命令
  _absorb() {
    const w = this.world;
    if (!w || !w.events) return;
    const hist = w.events.history;
    const from = this.eventCursor;
    for (let i = hist.length - 1; i >= 0; i--) {
      const e = hist[i];
      if (e.seq <= from) break;
      if (!this._visible(e)) continue;
      const txt = this._describe(e);
      if (txt) this.pendingEvents.push({ t: e.t !== null && e.t !== undefined ? e.t : w.t, text: txt });
    }
    this.eventCursor = hist.length ? hist[hist.length - 1].seq : 0;
    if (this.pendingEvents.length > 200) this.pendingEvents.splice(0, this.pendingEvents.length - 200);
    // 命令记录
    if (w.commands) {
      for (const c of w.commands) {
        if (c.side !== this.side) continue;
        if (this.orderMem.some((x) => x.id === c.id)) continue;
        this.orderMem.push({ id: c.id, t_issue: c.t_issue, t_effective: c.t_effective, kind: c.kind, shipId: c.shipId, params: c.params, accepted: c.accepted });
      }
      if (this.orderMem.length > 60) this.orderMem.splice(0, this.orderMem.length - 60);
    }
    this._snapshotTracks();
  }

  // commit=false: 只记录当前值用于显示; commit=true: 提交为上次决策基线,
  // 这样变化率反映整个决策间隔(例如 150s), 而不是两次 build 之间的 1s。
  _snapshotTracks(commit) {
    const w = this.world;
    if (!w || !w.tracks) return;
    const own = w.afloatOf(this.side);
    const ref = own.length ? own[0].pos : { x: 0, y: 0 };
    for (const t of w.tracks.visibleFor({ side: this.side, pos: ref })) {
      const mem = this.trackMem.get(t.id);
      const dist = Math.hypot(t.pos.x - ref.x, t.pos.y - ref.y);
      if (!mem) this.trackMem.set(t.id, { firstSeen: w.t, lastT: w.t, lastRangeM: dist, lastCourse: t.courseDeg, lastConf: t.confidence, nowRangeM: dist, nowT: w.t });
      else {
        mem.nowRangeM = dist; mem.nowT = w.t;
        if (commit) { mem.lastT = w.t; mem.lastRangeM = dist; mem.lastCourse = t.courseDeg; mem.lastConf = t.confidence; }
      }
    }
  }

  _visible(e) {
    if (e.side) return e.side === this.side;
    if (e.killerSide || e.victimSide) return e.killerSide === this.side || e.victimSide === this.side;
    return false; // 不确定可见性的事件不喂给 AI（宁缺勿泄）
  }

  _describe(e) {
    const t = e.type;
    if (t === 'gun.hit') return '命中：' + (e.name || e.ship) + ' 被击中（' + (e.hitPart || '') + '，' + (e.penetrated ? '击穿' : '未穿') + '）';
    if (t === 'gun.penetration') return '击穿装甲：' + e.ship + ' 舱段' + (e.compartment !== undefined ? e.compartment : '?');
    if (t === 'gun.bounce') return '跳弹：' + e.ship;
    if (t === 'gun.straddle') return '夹叉：' + e.ship;
    if (t === 'gun.nearmiss') return '近失弹：' + e.ship;
    if (t === 'torp.launch') return '我方发射鱼雷：' + (e.name || e.ship) + ' ' + (e.tubes || '?') + '管';
    if (t === 'torp.hit') return '鱼雷命中：' + e.ship;
    if (t === 'torp.dud') return '哑弹：' + e.ship;
    if (t === 'torp.wake') return '发现鱼雷航迹！' + (e.ship || '');
    if (t === 'dam.flood') return '进水：' + e.ship + ' 舱段' + e.compartment + '（累计' + Math.round(e.value || 0) + 'm³）';
    if (t === 'dam.fire') return '起火：' + e.ship + ' 舱段' + e.compartment;
    if (t === 'dam.magazine') {
      // 弹药库事件有多种结果（直击起火/注水/闪燃/受火势威胁/殉爆），过去一律写"殉爆"会
      // 把 LLM 的判断带偏（一艘只是弹舱进水也会被当成全舰爆炸）。按 e.result 分别措辞。
      const what = MAGAZINE_RESULT_ZH[e.result] || '弹药库异常';
      const risk = (e.magRisk !== undefined && e.magRisk !== null) ? '（风险' + Math.round(100 * e.magRisk) + '%）' : '';
      return what + risk + '：' + (e.name || e.ship);
    }
    if (t === 'dam.casualties') return '人员伤亡：' + e.ship + ' -' + Math.round(e.value || 0);
    if (t === 'dam.subsystem') return '设备损毁：' + e.ship + ' ' + (e.name || e.kind);
    if (t === 'ship.sink') return '★沉没：' + (e.name || e.ship);
    if (t === 'ship.capsize') return '★倾覆：' + (e.name || e.ship);
    if (t === 'sensor.detect') return '发现目标：' + (e.by || '') + ' 用' + (e.source || '') + ' 在' + (e.rangeM ? (e.rangeM / NMI).toFixed(1) + 'nm' : '') + '发现' + (e.target || '');
    if (t === 'sensor.lose') return '丢失目标：' + (e.target || '');
    if (t === 'order.effective') return '命令生效：' + (e.cmd && e.cmd.kind) + ' ' + (e.cmd && e.cmd.shipId || '');
    if (t === 'order.reject') return '命令被拒：' + (e.cmd && e.cmd.kind);
    if (t === 'ai.fallback') return '（系统）外部智能体掉线，已回落本地规则 AI';
    return null;
  }

  // 导出给外部智能体（REMOTE/SSE）：结构化历史 + 战况 + 命令 + 航迹记忆 + 简报文本
  exportForAgent() {
    this._absorb();
    const w = this.world;
    // 简报文本按 5 秒节流重建（1.7Hz 的状态推送不必每次重算）
    if (!this._briefCache || !w || w.t - this._briefCacheT > 5) {
      this._briefCache = this.buildSituation('');
      this._briefCacheT = w ? w.t : 0;
    }
    return {
      decisions: this.totalDecisions,
      lastIntent: this.lastIntent,
      turns: this.turns.slice(-6).map((t) => ({ t: Math.round(t.t), intent: t.intent, commands: (t.commands || []).map((c) => ({ kind: c.kind, shipId: c.shipId || null, params: c.params || {} })) })),
      events: this.pendingEvents.slice(-40).map((e) => ({ t: Math.round(e.t), text: e.text })),
      orders: this.orderMem.slice(-20).map((o) => ({ t_issue: Math.round(o.t_issue), t_effective: Math.round(o.t_effective), kind: o.kind, shipId: o.shipId || null, params: o.params || {}, accepted: o.accepted !== false })),
      trackMemory: Array.from(this.trackMem.entries()).map(([id, m]) => ({ id, firstSeenS: Math.round(m.firstSeen), lastRangeM: Math.round(m.lastRangeM || 0), lastCourseDeg: Math.round(m.lastCourse || 0), lastConfidence: +(m.lastConf || 0).toFixed(2) })),
      briefing: this._briefCache,
    };
  }

  stats() {
    return {
      decisions: this.totalDecisions, turns: this.turns.length, events: this.pendingEvents.length,
      orders: this.orderMem.length, tracks: this.trackMem.size, lastIntent: this.lastIntent,
    };
  }
  reset() { this.turns = []; this.pendingEvents = []; this.orderMem = []; this.trackMem.clear(); this.lastIntent = ''; this.eventCursor = 0; this.totalDecisions = 0; }
}
