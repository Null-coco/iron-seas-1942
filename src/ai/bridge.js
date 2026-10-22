// ============================================================================
// 【T5】src/ai/bridge.js — AI 桥接层（可插拔后端）
// ----------------------------------------------------------------------------
// 契约（ARCHITECTURE §4）：
//   class AICommander { constructor(side, world, opts); tick(world, dt); setBackend(name); submitDecision(decision) }
//
// 三种后端：
//   LOCAL  —— 进程内规则 AI（src/ai/local_ai.js, T6），无可变外部依赖，永远可用（兜底基准）。
//   REMOTE —— 外部智能体经 server/serve.mjs 的 WebSocket 中继接入：
//              服务器→智能体 {type:'state', t, side, payload}（1–2 Hz，只给该方可见信息）
//              智能体→服务器 {type:'commands', commands:[...]} / {type:'chat', text}
//              AI 决策由外部回传，经 submitDecision() 注入世界。
//   LLM    —— 直接调用注入的 llmCall(messages)（生产环境由 server/serve.mjs 的
//              POST /api/llm/chat 代理到 OpenAI 兼容端点；密钥只在服务器侧）。
//
// 真实感/工程要点：
//   1) tick() 绝不阻塞：网络 I/O 全部异步，决策未到达时用 LOCAL 兜底指挥，仿真照跑。
//   2) 心跳 + 超时回落：外部智能体静默超过 fallbackAfterS（默认 12s > 契约的 10s）
//      即回落 LOCAL 并 emit ai.fallback；任一消息到达即恢复并 emit ai.connected（重连计数 +1）。
//   3) 状态订阅节流：按仿真时间每 stateIntervalS（默认 0.6s ≈ 1.7Hz）推一次
//      world.visibleStateFor(side)；高倍时间压缩下再加墙上时钟护栏 maxStateHzWall（默认 4Hz），
//      避免把服务器打爆。只推"该方可见的航迹"，看不到真值 —— 雾里看花。
//   4) 命令白名单 + 参数强制：外部/LLM 的 JSON 先过 nl.normalizeCommand，未知 kind 丢弃。
//   5) 舰队级命令（无 shipId）经 nl.expandFleetCommands 展开为逐舰命令；world._applyOne 只认 shipId。
//   6) 指挥延迟由 world.issueCommand 统一施加（side.orderDelay_s + 舰队级 +5s + 超视距中继 +9s），
//      桥接层不绕过 C2 延迟。
//
// 事件（契约 §4）：ai.connected ai.disconnected ai.fallback ai.error ai.decision ai.chat
// ============================================================================
import { LocalAI } from './local_ai.js';
import { expandFleetCommands, normalizeCommand, buildLLMPrompt, parseDecisionJSON } from './nl.js';
import { AIContext } from './context.js';
import { clamp, normDeg } from '../core/util.js';

const BACKENDS = ['LOCAL', 'REMOTE', 'LLM'];

// ---- LLM 速度预设（实测数据来自 test/lead.llm_bench.mjs）----
//   fast     : mimo-v2.6-flash + 精简上下文 + 700 token  ≈ 10-15s/次（实测 13.9s 出 3 条命令）
//   balanced : mimo-v2.5       + 精简上下文 + 1200 token ≈ 20s/次（输出更完整）
//   deep     : deepseek-v4.1-flash + 完整上下文 + 8000 token ≈ 20-50s/次（推理最充分）
export const LLM_PRESETS = {
  // intervalS 是"上一次决策返回后多久发起下一次"，流水线化以最大化 LLM 吞吐
  // 实测（2026-10）：mimo-v2.5 是唯一稳定的**非思考**模型（reasoning_content 恒为 0，正文直接就是 JSON），
  // 15-20s 出 5-6 条命令；mimo-v2.6-flash 会思考但更快出结果；deepseek-v4.1-flash 思考最长最慢。
  fast: { nameZh: '快速·不思考', model: 'mimo-v2.5', maxTokens: 900, compact: true, timeoutS: 90, intervalS: 4 },
  balanced: { nameZh: '均衡·轻思考', model: 'mimo-v2.6-flash', maxTokens: 900, compact: true, timeoutS: 90, intervalS: 5 },
  deep: { nameZh: '深度·推理', model: 'deepseek-v4.1-flash', maxTokens: 8000, compact: false, timeoutS: 200, intervalS: 10 },
};
export const LLM_MODELS = ['mimo-v2.5', 'mimo-v2.6-flash', 'minimax-m3', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'space-bunny', 'qwen3.8-flash', 'kimi-k2.6'];
export function normalizeBackendName(name) {
  const n = String(name === undefined || name === null ? '' : name).trim().toUpperCase();
  if (BACKENDS.includes(n)) return n;
  if (n === 'RULE' || n === 'RULES' || n === 'INTERNAL' || n === 'OFF') return 'LOCAL';
  if (n === 'WS' || n === 'WEBSOCKET' || n === 'AGENT' || n === 'EXTERNAL') return 'REMOTE';
  if (n === 'AI' || n === 'CHAT' || n === 'LLM_BRIDGE') return 'LLM';
  return null;
}

export class AICommander {
  /**
   * @param {'ALLIED'|'AXIS'} side
   * @param {import('../sim/world.js').World} world
   * @param {object} [opts]
   *   backend 'LOCAL'|'REMOTE'|'LLM'
   *   transport  function(msg)|{send(msg)}  出站消息通道（服务器 WS 或测试桩）
   *   llmCall    async ({messages,side,text}) => string   LLM 后端决策调用
   *   intervalS  决策周期（仿真秒），默认 8
   *   stateIntervalS 状态推送间隔（仿真秒），默认 0.6 ≈ 1.7Hz
   *   heartbeatS 心跳间隔（仿真秒），默认 5
   *   timeoutS   单次决策超时（墙上秒），默认 20
   *   fallbackAfterS 外部静默回落阈值（墙上秒），默认 12（契约要求 >10s）
   *   connectGraceS 从未接入时的回落宽限（墙上秒），默认 10
   *   maxStateHzWall 墙上时钟状态推送上限，默认 4Hz（0=不限）
   *   minDecisionIntervalS 决策注入最小间隔（仿真秒），默认 1.5，防命令风暴
   *   now () => ms  可注入时钟（测试确定性）
   */
  constructor(side, world, opts = {}) {
    this.side = side;
    this.world = world;
    // role 决定 submitDecision 的语义：
    //   'sim'   （默认）仿真宿主：把外部决策注入本进程的世界（world.issueCommand）
    //   'agent' 外部智能体：把决策经 transport 发给服务器，由 sim 宿主注入（避免回环）
    this.role = opts.role === 'agent' ? 'agent' : 'sim';
    const backend = normalizeBackendName(opts.backend);
    this.backend = backend || 'LOCAL';
    this.local = new LocalAI(side, opts.local || {});
    this.transport = opts.transport || (typeof opts.send === 'function' ? opts.send : null);
    this.llmCall = opts.llmCall || null;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.requestHook = opts.requestHook || null;
    this.stateHook = opts.stateHook || null;

    this.intervalS = opts.intervalS !== undefined ? opts.intervalS : 8;
    this.stateIntervalS = opts.stateIntervalS !== undefined ? opts.stateIntervalS : 0.6;
    this.heartbeatS = opts.heartbeatS !== undefined ? opts.heartbeatS : 5;
    this.timeoutS = opts.timeoutS !== undefined ? opts.timeoutS : 20;
    this.fallbackAfterS = opts.fallbackAfterS !== undefined ? opts.fallbackAfterS : 12;
    this.connectGraceS = opts.connectGraceS !== undefined ? opts.connectGraceS : 10;
    this.maxStateHzWall = opts.maxStateHzWall !== undefined ? opts.maxStateHzWall : 4;
    this.minDecisionIntervalS = opts.minDecisionIntervalS !== undefined ? opts.minDecisionIntervalS : 1.5;
    this.maxCommandsPerDecision = opts.maxCommandsPerDecision || 240;
    this.localShareWhenRemote = opts.localShareWhenRemote !== undefined ? opts.localShareWhenRemote : 1.0;
    // autoCommand=false：本地 AI 只做参谋，不下达任何命令（玩家手动指挥 / 外部指挥官指挥）
    this.autoCommand = opts.autoCommand !== undefined ? !!opts.autoCommand : true;
    this.name = opts.name || ('AI_' + side);

    this.accum = 0;
    this.stateAccum = 0;
    this.heartbeatAccum = 0;
    this.pendingRequest = false;
    this.lastRequestT = -1e9;
    this.lastRequestWall = -1e18;
    this.lastResponseT = -1e9;
    this.lastDecisionT = -1e9;

    const nowMs = this.now();
    this._createdWall = nowMs;
    this.lastRxWall = nowMs;
    this.lastTxWall = 0;
    this.lastStateWall = 0;
    this.lastHeartbeatWall = 0;

    // 连接状态机：IDLE(尚未接入) → CONNECTED → FALLBACK → CONNECTED(重连) …
    this.linkState = this.backend === 'LOCAL' ? 'LOCAL' : 'IDLE';
    this.fallbackActive = false;
    this.status = {
      side, backend: this.backend, connected: this.backend === 'LOCAL',
      linkState: this.linkState, fallbackActive: false, fallbacks: 0, reconnects: 0,
      decisions: 0, commandsIssued: 0, commandsRejected: 0, rateLimited: 0,
      statesSent: 0, heartbeats: 0, timeouts: 0, lastError: null,
      lastRxWall: this.lastRxWall, lastTxWall: 0, rttEstMs: null,
    };
    this._lastPingWall = 0;
    this._lastPingT = 0;
    // 便于 UI 直接取用
    this.lastState = null;
    this.lastReasoning = '';
    this.chatHistory = [];

    if (this.backend !== 'LOCAL') {
      if (this.backend === 'LLM' && this.llmCall) this._markConnected('llm-attached');
      else if (this.backend === 'REMOTE' && this.transport) this._markConnected('transport-attached');
    }
  }

  // -------------------------------------------------------------------------
  // 连接与后端切换
  // -------------------------------------------------------------------------
  _emit(type, payload) {
    const p = Object.assign({ t: this.world && this.world.t, side: this.side }, payload);
    try { if (this.world && this.world.events) this.world.events.emit(type, p); } catch { /* 事件不得影响主循环 */ }
    return p;
  }
  _error(msg, code) {
    this.status.lastError = msg;
    this._emit('ai.error', { backend: this.backend, message: msg, code: code || 'AI_ERROR' });
  }
  _markConnected(reason) {
    const wasFallback = this.fallbackActive;
    const hadLink = this.linkState === 'CONNECTED' || this._hadLink;
    this.linkState = 'CONNECTED';
    this.fallbackActive = false;
    this.status.connected = true;
    this.status.linkState = 'CONNECTED';
    this.status.fallbackActive = false;
    this.lastRxWall = this.now();
    if (this._hadLink) this.status.reconnects++;   // 非首次接通即计入重连
    this._hadLink = true;
    this._emit('ai.connected', { backend: this.backend, reason: reason || 'link-up', reconnects: this.status.reconnects, recovered: wasFallback });
  }
  _markFallback(reason) {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    this.linkState = 'FALLBACK';
    this.status.fallbackActive = true;
    this.status.fallbacks++;
    this.pendingRequest = false;
    this._emit('ai.fallback', {
      backend: this.backend, reason: reason || 'silent',
      fallbackAfterS: this.fallbackAfterS, fallbacks: this.status.fallbacks,
      silentS: +Math.max(0, (this.now() - this.lastRxWall) / 1000).toFixed(1),
      note: '外部智能体失联，回落进程内 LOCAL AI',
    });
  }
  detachTransport(reason) {
    if (this.backend === 'LOCAL') return;
    this.status.connected = false;
    this.linkState = 'IDLE';
    this._emit('ai.disconnected', { backend: this.backend, reason: reason || 'transport-lost' });
    // 掉线后立刻由 LOCAL 接管，不等超时
    this._markFallback('disconnected');
  }
  attachTransport(t, opts = {}) {
    this.transport = t;
    if (this.backend === 'LOCAL' && !opts.force) { /* LOCAL 不需通道 */ }
    this._markConnected('transport-attached');
    return this;
  }
  setTransport(t) { return this.attachTransport(t); }
  setLLMCall(fn) { this.llmCall = fn; if (this.backend === 'LLM') this._markConnected('llm-attached'); return this; }

  /** 运行期切换后端。'LOCAL' | 'REMOTE' | 'LLM' */
  setBackend(name) {
    const nb = normalizeBackendName(name);
    if (!nb) { this._error('未知 AI 后端：' + name, 'BAD_BACKEND'); return this.backend; }
    const prev = this.backend;
    if (nb === prev) { this._emit('ai.connected', { backend: nb, reason: 'noop' }); return nb; }
    this.backend = nb;
    this.status.backend = nb;
    this.pendingRequest = false;
    this.accum = 0; this.stateAccum = 0;
    if (nb === 'LOCAL') {
      this.linkState = 'LOCAL'; this.fallbackActive = false;
      this.status.connected = true; this.status.linkState = 'LOCAL'; this.status.fallbackActive = false;
      this._emit('ai.connected', { backend: 'LOCAL', reason: 'switched', from: prev });
    } else {
      this.linkState = 'IDLE'; this.fallbackActive = false;
      this.status.linkState = 'IDLE'; this.status.fallbackActive = false;
      const ready = nb === 'LLM' ? !!this.llmCall : !!this.transport;
      if (ready) this._markConnected('switched');
      else {
        this.status.connected = false;
        this._emit('ai.connected', { backend: nb, reason: 'switched-pending-link', from: prev, pending: true });
        this._error('后端 ' + nb + ' 已选中但尚无可用通道，暂由 LOCAL 兜底', 'NO_LINK');
      }
    }
    return nb;
  }
  get activeBackend() { return this.fallbackActive ? 'LOCAL' : this.backend; }

  // -------------------------------------------------------------------------
  // 出站
  // -------------------------------------------------------------------------
  _send(msg) {
    this.lastTxWall = this.now();
    this.status.lastTxWall = this.lastTxWall;
    try {
      if (typeof this.transport === 'function') { this.transport(msg); return true; }
      if (this.transport && typeof this.transport.send === 'function') { this.transport.send(msg); return true; }
    } catch (e) { this._error('发送失败：' + (e && e.message || e), 'SEND_FAIL'); }
    if (this.stateHook && msg && msg.type === 'state') { try { this.stateHook(msg); } catch { /* ignore */ } }
    return false;
  }

  /** 组装节流后的可见态势快照 */
  buildState() {
    if (!this.world || typeof this.world.visibleStateFor !== 'function') return null;
    try {
      const state = this.world.visibleStateFor(this.side);
      // 外部智能体与 LLM 共享同一套真正的上下文（历史决策/战况/命令/航迹机动记忆）
      if (!this.context) this.context = new AIContext(this.world, this.side, this.contextOpts || {});
      try {
        const exp = this.context.exportForAgent();
        if (!this._doctrineSent) { exp.doctrine = this.context.systemPrompt(); this._doctrineSent = true; }
        state.context = exp;
      } catch (e) { this.status.contextError = String(e && e.message || e); }
      return state;
    } catch (e) { this._error('visibleStateFor 失败：' + (e && e.message || e), 'STATE_FAIL'); return null; }
  }

  /** 状态订阅：按 stateIntervalS（默认 0.6s≈1.7Hz）节流推送 */
  sendState(force) {
    if (!this.world) return null;
    const nowMs = this.now();
    if (!force && this.maxStateHzWall > 0) {
      const minGap = 1000 / this.maxStateHzWall;
      if (nowMs - this.lastStateWall < minGap) return null;
    }
    const state = this.buildState();
    if (!state) return null;
    this.lastState = state;
    this.lastStateWall = nowMs;
    const msg = { type: 'state', t: this.world.t, side: this.side, backend: this.backend, seq: this.status.statesSent + 1, payload: state };
    this._send(msg);
    this.status.statesSent++;
    return msg;
  }

  sendHeartbeat() {
    if (!this.world) return;
    const msg = { type: 'heartbeat', t: this.world.t, side: this.side, backend: this.backend, seq: this.status.heartbeats + 1, wall: this.now() };
    this._send(msg);
    this.status.heartbeats++;
    this._lastPingWall = this.now();
    this._lastPingT = this.world.t;
  }

  /** 外发聊天（服务器中继给玩家/其他智能体） */
  sendChat(text) {
    const t = String(text === undefined || text === null ? '' : text);
    if (!t) return null;
    this.chatHistory.push({ t: this.world ? this.world.t : 0, dir: 'out', text: t });
    if (this.chatHistory.length > 200) this.chatHistory.splice(0, 50);
    this._send({ type: 'chat', t: this.world ? this.world.t : 0, side: this.side, from: this.name, text: t });
    return t;
  }

  /** 收到外部聊天：写入世界聊天日志（经 C2 延迟）并 emit ai.chat */
  receiveChat(text, from) {
    const t = String(text === undefined || text === null ? '' : text);
    if (!t) return;
    this.chatHistory.push({ t: this.world ? this.world.t : 0, dir: 'in', from: from || 'REMOTE', text: t });
    this.lastRxWall = this.now();
    // agent 角色：聊天要发给服务器（服务器再中继给 sim/玩家），不注入本地世界
    if (this.role === 'agent') { this._send({ type: 'chat', side: this.side, from: from || this.name, text: t }); return; }
    if (this.linkState !== 'CONNECTED' && this.backend !== 'LOCAL') this._markConnected('chat');
    try {
      this.world.issueCommand({ side: this.side, kind: 'CHAT', params: { text: t }, issuer: from || '外部智能体', source: 'AI_REMOTE' }, {});
    } catch (e) { this._error('聊天注入失败：' + (e && e.message || e), 'CHAT_FAIL'); }
  }

  // -------------------------------------------------------------------------
  // 决策注入
  // -------------------------------------------------------------------------
  /**
   * 外部/LLM 决策注入。
   * @param {{commands?:Array, chat?:string, reasoning?:string, source?:string}} decision
   * @returns {Array} 实际下达的 world 命令
   */
  submitDecision(decision) {
    if (!decision) { this._error('空决策', 'EMPTY_DECISION'); return []; }
    if (this.backend !== 'LOCAL') this._markConnected('decision');
    this.pendingRequest = false;
    this.status.connected = true;
    this.lastResponseT = this.world ? this.world.t : 0;
    this.status.decisions++;

    // 速率限制（防命令风暴；仿真时间计）
    const t = this.world ? this.world.t : 0;
    if (this.minDecisionIntervalS > 0 && t - this.lastDecisionT < this.minDecisionIntervalS && !decision.force) {
      this.status.rateLimited++;
      return [];
    }
    this.lastDecisionT = t;

    let incoming = decision;
    if (Array.isArray(decision)) incoming = { commands: decision };
    const rawCmds = (incoming.commands || incoming.orders || []);
    const normalized = [];
    let rejected = 0;
    for (const c of rawCmds.slice(0, this.maxCommandsPerDecision)) {
      const n = normalizeCommand(c);
      if (n) normalized.push(n); else rejected++;
    }
    this.status.commandsRejected += rejected;

    const source = incoming.source && String(incoming.source).startsWith('AI') ? incoming.source : 'AI_REMOTE';

    // ---- agent 角色：只负责把决策送到服务器；舰队展开由 sim 宿主完成 ----
    if (this.role === 'agent') {
      const payload = {
        type: 'commands', side: this.side, commands: normalized,
        chat: incoming.chat || '', reasoning: incoming.reasoning || '', source, issuer: this.name,
      };
      const sent = this._send(payload);
      if (!sent) this._error('决策未发出：无可用出站通道', 'NO_LINK');
      if (incoming.chat) this.chatHistory.push({ t, dir: 'out', text: String(incoming.chat) });
      if (incoming.reasoning) this.lastReasoning = String(incoming.reasoning);
      this._emit('ai.decision', {
        backend: this.backend, role: 'agent', decisions: this.status.decisions,
        commands: normalized.length, rejected, rateLimited: this.status.rateLimited,
        reasoning: this.lastReasoning || '', sent,
      });
      return normalized;
    }

    const expanded = expandFleetCommands(this.world, this.side, normalized);
    // 外部/LLM 常只给 kind+params 而不给 shipId：默认落到该方旗舰，否则命令会被静默丢弃
    const flagShip = this.world ? (this.world.shipsOf(this.side).find((s) => s.role === 'flagship' && s.isAfloat) || this.world.afloatOf(this.side)[0] || null) : null;
    const issued = [];
    for (const c of expanded) {
      try {
        // 注意：world.issueCommand(cmd, opts) 目前忽略 opts，source 必须写进命令对象本身
        const full = Object.assign({ side: this.side, issuer: incoming.issuer || this.name, source }, c);
        if (!full.shipId && flagShip && full.scope !== 'FLEET') full.shipId = flagShip.id;
        // 标记：该舰刚收到外部指挥官的指令，本地执行官在 directiveHoldMs 内不得覆盖
        if (source !== 'AI_LOCAL') {
          const stamp = this.world.t;
          if (full.shipId) { const sh = this.world.ship(full.shipId); if (sh) sh._directiveSim = stamp; }
          else for (const sh of this.world.afloatOf(this.side)) sh._directiveSim = stamp;
        }
        issued.push(this.world.issueCommand(full, { source }));
      } catch (e) { this._error('命令下达失败：' + (e && e.message || e), 'CMD_FAIL'); }
    }
    this.status.commandsIssued += issued.length;

    if (incoming.chat) this.receiveChat(incoming.chat, incoming.issuer || this.name);
    if (incoming.reasoning) { this.lastReasoning = String(incoming.reasoning); }
    this._emit('ai.decision', {
      backend: this.backend, decisions: this.status.decisions, commands: issued.length,
      rejected, rateLimited: this.status.rateLimited, reasoning: this.lastReasoning || '',
      // 供 UI 展示"AI 到底下了什么令"
      commandsDetail: expanded.slice(0, 12).map((c) => ({ shipId: c.shipId || null, kind: c.kind, params: c.params || {} })),
    });
    return issued;
  }

  /** 处理来自服务器的协议消息（app.js / 测试可直接调用） */
  handleMessage(msg) {
    if (!msg) return;
    const type = String(msg.type || '');
    switch (type) {
      case 'hello': case 'welcome': this._markConnected('hello'); break;
      case 'heartbeat': case 'ping': {
        this.lastRxWall = this.now();
        if (this.linkState !== 'CONNECTED' && this.backend !== 'LOCAL') this._markConnected('heartbeat');
        if (type === 'ping') this._send({ type: 'pong', t: this.world ? this.world.t : 0, side: this.side, echo: msg.echo });
        break;
      }
      case 'pong': {
        this.lastRxWall = this.now();
        if (msg.echo !== undefined && this._lastPingWall) this.status.rttEstMs = Math.max(0, this.now() - this._lastPingWall);
        break;
      }
      case 'state': this.lastPeerState = msg.payload !== undefined ? msg.payload : msg; break;   // 服务器中继的可见态势
      case 'request_decision': {
        // sim 主机请求本周期决策：记录态势，等待外部/上层调用 submitDecision()
        this.lastPeerState = msg.state !== undefined ? msg.state : (msg.payload !== undefined ? msg.payload : this.lastPeerState);
        this.lastRequestT = msg.t !== undefined ? msg.t : this.lastRequestT;
        this.lastRxWall = this.now();
        this.pendingRequest = true;
        if (this.linkState !== 'CONNECTED' && this.backend !== 'LOCAL') this._markConnected('request');
        if (typeof this.onDecisionRequest === 'function') { try { this.onDecisionRequest(this.lastPeerState, msg); } catch (e) { this._error(String(e && e.message || e), 'DECISION_HOOK'); } }
        break;
      }
      case 'commands': case 'orders': this.submitDecision({ commands: msg.commands || msg.orders, chat: msg.chat, reasoning: msg.reasoning, source: msg.source, issuer: msg.issuer, force: !!msg.force }); break;
      case 'decision': this.submitDecision(msg.decision || msg); break;
      case 'chat': this.receiveChat(msg.text, msg.from || msg.issuer); break;
      case 'error': this._error(msg.message || '远端错误', msg.code || 'REMOTE_ERROR'); break;
      case 'notice': this.status.lastNotice = { code: msg.code || 'NOTICE', message: msg.message || '' }; break;
      case 'bye': this.detachTransport('bye'); break;
      // 前向兼容（AI_INTERFACE §11）：未知消息类型静默忽略，只计数
      default: this.status.unknownMsgs = (this.status.unknownMsgs || 0) + 1; break;
    }
  }

  // -------------------------------------------------------------------------
  // 主循环（非阻塞）
  // -------------------------------------------------------------------------
  tick(world, dt) {
    if (world) this.world = world;
    const w = this.world;
    if (!w) return;
    const nowMs = this.now();

    // ---- LOCAL：直接委托，零桥接开销 ----
    if (this.backend === 'LOCAL') {
      // autoCommand=false 时本地 AI 只当参谋（不下令），把指挥权完整留给玩家/外部指挥官
      try { this.local.tick(w, dt, this.autoCommand === false); } catch (e) { this._error('LOCAL AI 异常：' + (e && e.message || e), 'LOCAL_FAIL'); }
      this.status.linkState = 'LOCAL';
      return;
    }

    // ---- 连接健康 ----
    const silentS = (nowMs - this.lastRxWall) / 1000;
    if (this.linkState === 'CONNECTED') {
      if (silentS > this.fallbackAfterS) this._markFallback('silent');
    } else if (this.linkState === 'IDLE') {
      if ((nowMs - this._createdWall) / 1000 > this.connectGraceS) this._markFallback('no-agent');
    }

    // ---- 未接通/已回落：LOCAL 兜底指挥（保证仿真不停摆） ----
    if (this.linkState !== 'CONNECTED') {
      try { this.local.tick(w, dt * this.localShareWhenRemote, this.autoCommand === false); } catch (e) { this._error('LOCAL 兜底异常：' + (e && e.message || e), 'LOCAL_FAIL'); }
    } else if (this.executiveMode !== false) {
      // 外部/LLM 指挥官在线：本地 AI 作为"执行官"继续处理规避、损管、火控门限等实时事务，
      // 但不覆盖外部指挥官刚下达的航向/速度/火力（见 LocalAI.order 的 directiveHoldMs）。
      try { this.local.tick(w, dt * this.localShareWhenRemote, this.autoCommand === false); } catch (e) { this._error('执行官模式异常：' + (e && e.message || e), 'LOCAL_FAIL'); }
    }

    // ---- 状态订阅节流推送（1–2Hz） ----
    this.stateAccum += dt;
    if (this.linkState === 'CONNECTED' && this.stateAccum >= this.stateIntervalS) {
      this.stateAccum = 0;
      this.sendState(false);
    }

    // ---- 心跳 ----
    this.heartbeatAccum += dt;
    if (this.linkState === 'CONNECTED' && this.heartbeatAccum >= this.heartbeatS) {
      this.heartbeatAccum = 0;
      this.sendHeartbeat();
    }

    // ---- 决策请求周期 ----
    this.accum += dt;
    if (this.linkState === 'CONNECTED') {
      if (this.pendingRequest && (nowMs - this.lastRequestWall) / 1000 > this.timeoutS) {
        this.pendingRequest = false;
        this.status.timeouts++;
        this._emit('ai.error', { backend: this.backend, code: 'DECISION_TIMEOUT', message: '决策超时 ' + this.timeoutS + 's，等待外部智能体重试' });
      }
      if (!this.pendingRequest && this.accum >= this.intervalS) {
        this.accum = 0;
        this._requestDecision();
      }
    }
  }

  _requestDecision() {
    const w = this.world;
    const state = this.buildState();
    if (!state) return;
    this.lastState = state;
    this.pendingRequest = true;
    this.lastRequestT = w.t;
    this.lastRequestWall = this.now();

    if (this.backend === 'LLM') { this._requestLLM(state); return; }
    // REMOTE：服务器中继 request（也支持旧式 requestHook 桩）
    const msg = { type: 'request_decision', t: w.t, side: this.side, backend: this.backend, state };
    let ok = false;
    if (typeof this.transport === 'function') ok = this._send(msg);
    else if (this.transport && typeof this.transport.send === 'function') ok = this._send(msg);
    else if (this.stateHook) { try { this.stateHook(msg); ok = true; } catch (e) { this._error(String(e && e.message || e), 'STATE_HOOK'); } }
    if (!ok && this.requestHook) {
      try { this.requestHook(state); ok = true; } catch (e) { this._error(String(e && e.message || e), 'REQ_HOOK'); }
    }
    if (!ok) { this.pendingRequest = false; this._error('无可用出站通道', 'NO_LINK'); }
  }

  _requestLLM(state) {
    if (!this.llmCall) { this.pendingRequest = false; return; }
    // 带持久记忆的作战上下文（历史决策/战况/命令/航迹机动），而不是单帧快照
    if (!this.context) this.context = new AIContext(this.world, this.side, this.contextOpts || {});
    const userText = state && state.__userText ? state.__userText : '请依据态势下达本周期指令';
    let messages;
    try {
      const built = this.context.build(userText);
      messages = built.messages;
      this.context._lastSituation = built.situation;
      this.lastContextStats = { messages: messages.length, chars: JSON.stringify(messages).length };
      this.lastContextPreview = { system: built.system, situation: built.situation, messages: messages.length };
    } catch (e) {
      this._error('上下文构建失败，退回单帧简报：' + (e && e.message || e), 'CTX_FAIL');
      messages = buildLLMPrompt(this.world, this.side, userText);
    }
    Promise.resolve()
      .then(() => this.llmCall({ messages, side: this.side, state }))
      .then((raw) => {
        if (!this.pendingRequest && !raw) return;
        const dec = typeof raw === 'string' ? parseDecisionJSON(raw) : (raw && raw.commands ? raw : parseDecisionJSON(raw));
        if (!dec) { this.pendingRequest = false; this._error('LLM 返回无法解析', 'LLM_PARSE'); return; }
        try { if (this.context) this.context.remember(typeof raw === 'string' ? raw : JSON.stringify(raw), dec); } catch (e) { /* 记忆失败不影响决策 */ }
        this.submitDecision(Object.assign({ reasoning: dec.reasoning }, dec));
      })
      .catch((e) => {
        this.pendingRequest = false;
        this._error('LLM 调用失败：' + (e && e.message || e), 'LLM_FAIL');
      });
  }

  // -------------------------------------------------------------------------
  // 便捷接线（浏览器/Node 通用）
  // -------------------------------------------------------------------------
  /**
   * 用浏览器/Node 的 WebSocket 接入 server/serve.mjs。
   * @param {string} url ws://127.0.0.1:8787/ws?role=agent&side=AXIS
   */
  connectWebSocket(url, opts = {}) {
    const role = opts.role || 'agent';
    this.role = role === 'agent' ? 'agent' : 'sim';
    const WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) { this._error('当前环境无 WebSocket 实现', 'NO_WS'); return null; }
    let ws;
    try { ws = new WS(url); } catch (e) { this._error('WebSocket 连接失败：' + (e && e.message || e), 'WS_ERROR'); return null; }
    this.ws = ws;
    this.transport = (msg) => {
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
        else this._pending = msg;   // 未 OPEN 时暂存最近一条
      } catch (e) { this._error('WebSocket 发送失败：' + (e && e.message || e), 'WS_SEND'); }
    };
    ws.onopen = () => {
      this._markConnected('ws-open');
      this._send({ type: 'hello', role: role, side: this.side, name: this.name, backend: this.backend });
      if (this._pending) { this._send(this._pending); this._pending = null; }
      if (opts.publishState) this.sendState(true);   // 仅 sim 宿主需要主动推态势
    };
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { this._error('服务器消息非 JSON', 'WS_PARSE'); return; }
      this.handleMessage(m);
    };
    ws.onerror = () => this._error('WebSocket 错误', 'WS_ERROR');
    ws.onclose = (ev) => { this.detachTransport('ws-close:' + ((ev && ev.code) || 0)); };
    return ws;
  }

  /** 配置 LLM 后端：经 server 的 POST /api/llm/chat 代理（密钥留在服务器） */
  connectLLM(baseUrl, opts = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (base) this._llmBase = base;
    if (opts.compact !== undefined) {
      this.contextOpts = Object.assign({}, this.contextOpts, { compact: !!opts.compact });
      if (this.context) this.context.compact = !!opts.compact;
    }
    const fetchFn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) { this._error('当前环境无 fetch 实现', 'NO_FETCH'); return this; }
    this.llmCall = async ({ messages }) => {
      const t0 = this.now();
      this.status.thinkingSince = t0;
      try { return await this._llmFetch(fetchFn, base, messages, opts); }
      finally {
        this.status.lastLatencyMs = this.now() - t0;
        this.status.thinkingSince = null;
        if (!this._lat) this._lat = [];
        this._lat.push(this.status.lastLatencyMs);
        if (this._lat.length > 12) this._lat.shift();
        this.status.avgLatencyMs = Math.round(this._lat.reduce((a, b) => a + b, 0) / this._lat.length);
      }
    };
    if (opts.model) this.llmModel = opts.model;
    if (this.backend !== 'LLM') this.setBackend('LLM'); else this._markConnected('llm-attached');
    return this;
  }

  async _llmFetch(fetchFn, base, messages, opts) {
    {
      const res = await fetchFn(base + '/api/llm/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model: opts.model, temperature: opts.temperature, max_tokens: opts.maxTokens || 6000 }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error('LLM 代理 ' + res.status + '：' + ((j && j.error && j.error.message) || ''));
      if (j && j.choices && j.choices[0] && j.choices[0].message) {
        const m = j.choices[0].message;
        // 推理模型（如 deepseek-v4.1-flash）可能把内容放在 reasoning_content；
        // 若 content 为空则回退，否则决策会被当成空回复而回落本地 AI。
        const c = m.content && String(m.content).trim();
        return c ? m.content : (m.reasoning_content || '');
      }
      if (typeof j === 'string') return j;
      return JSON.stringify(j);
    }
  }

  /** 应用速度预设：切换模型/预算/上下文精简度/决策周期 */
  applyPreset(name) {
    const p = LLM_PRESETS[name];
    if (!p) return null;
    this.preset = name;
    this.intervalS = p.intervalS;
    this.timeoutS = p.timeoutS;
    this.connectLLM(this._llmBase || '', { model: p.model, maxTokens: p.maxTokens, compact: p.compact, timeoutS: p.timeoutS });
    return p;
  }

  toJSON() {
    return Object.assign({ name: this.name, side: this.side, backend: this.backend, activeBackend: this.activeBackend }, this.status, {
      lastReasoning: this.lastReasoning,
    });
  }
}

export default AICommander;
