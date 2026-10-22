#!/usr/bin/env node
// ============================================================================
// 【T5】server/serve.mjs — 铁海 1942 服务器（零第三方依赖）
// ----------------------------------------------------------------------------
// 只用 Node 内置模块：node:http / node:fs / node:crypto / node:path / node:url
// （LLM 上游需要 TLS，故仅在真正代理时惰性 import('node:https')，见 llmChat。）
//
// 职责：
//   1) 静态文件服务（默认 http://127.0.0.1:8787，根目录 = 项目根）
//   2) 手写 RFC6455 WebSocket 服务 + 帧编解码
//        role=sim        浏览器=仿真宿主：上行 state/heartbeat，下行 commands
//        role=agent&side=AXIS|ALLIED  外部智能体：收该方可见 state，回 commands/chat
//      服务器只做中继，不介入决策；房间按 side 隔离（轴心看不到同盟的航迹）
//   3) SSE 只读流 GET /api/stream?role=agent&side=AXIS（与 WS 等价，便于 curl/脚本）
//   4) POST /api/orders   HTTP 注入命令（SSE 客户端的写通道）
//   5) POST /api/llm/chat OpenAI 兼容代理（密钥只留在服务器：环境变量或 config.json）
//   6) GET  /api/scenarios /api/health /api/agents
//   7) POST /api/replay 导出回放（GET /api/replay 列表/下载）
//
// 安全：config.json 永不静态下发；/api/health 只报告"是否已配置密钥"，绝不含密钥本体。
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DEFAULT = path.resolve(path.dirname(__filename), '..');
export const SERVER_NAME = 'iron-seas-1942';
export const SERVER_VERSION = '1.0.0';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8 * 1024 * 1024;   // 8 MiB，回放/态势足够
const AGENT_SIDES = ['ALLIED', 'AXIS'];

// ============================================================================
// 1. RFC6455 帧编解码（导出以便单元测试）
// ============================================================================
export function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/** 编码一个 WebSocket 帧。opts:{opcode(默认1=text), fin, mask, maskKey} */
export function encodeFrame(data, opts = {}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const opcode = opts.opcode === undefined ? 0x1 : opts.opcode;
  const fin = opts.fin !== false;
  const mask = !!opts.mask;
  const len = payload.length;
  if (len > MAX_FRAME) throw new Error('frame too large: ' + len);
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = opts.maskKey || crypto.randomBytes(4);
  const out = Buffer.concat([header, Buffer.from(key), payload]);
  const base = header.length + 4;
  for (let i = 0; i < payload.length; i++) out[base + i] ^= key[i & 3];
  return out;
}

/** 增量解码：返回 {frames:[{fin,opcode,payload,masked}], rest}。不完整帧留在 rest。 */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(MAX_FRAME)) throw new Error('frame too large');
      len = Number(big); p += 8;
    }
    let maskKey = null;
    if (masked) { if (buf.length - p < 4) break; maskKey = buf.subarray(p, p + 4); p += 4; }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    p += len;
    frames.push({ fin, opcode, payload, masked });
    off = p;
  }
  return { frames, rest: buf.subarray(off) };
}

// ============================================================================
// 2. 配置加载（密钥只在服务器）
// ============================================================================
export function loadConfig(opts = {}) {
  const root = path.resolve(opts.root || ROOT_DEFAULT);
  let file = {};
  for (const p of [path.join(root, 'config.json'), path.join(root, 'server', 'config.json')]) {
    try { if (fs.existsSync(p)) { file = JSON.parse(fs.readFileSync(p, 'utf8')); break; } } catch (e) { /* 配置损坏则忽略 */ }
  }
  const llmFile = file.llm || {};
  const env = process.env;
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  return {
    root,
    host: pick(opts.host, env.HOST, file.host, '127.0.0.1'),
    port: Number(pick(opts.port, env.PORT, file.port, 8787)),
    // ---- LLM（OpenAI 兼容） ----
    // 显式 opts.apiKey = 空串 可强制"未配置"（测试用）；否则 opts > env > config.json
    apiKey: opts.apiKey !== undefined ? String(opts.apiKey) : String(pick(env.LLM_API_KEY, env.OPENAI_API_KEY, env.DEEPSEEK_API_KEY, llmFile.apiKey, file.apiKey) || ''),
    baseUrl: String(pick(opts.baseUrl, env.LLM_BASE_URL, llmFile.baseUrl, 'https://api.deepseek.com/v1')),
    model: String(pick(opts.model, env.LLM_MODEL, llmFile.model, 'deepseek-chat')),
    // 自定义上游头（例如 OpenCode Go 要求的 x-opencode-session）与自定义 UA。
    // 文档要求客户端用自己的名字标识、并为每个会话提供稳定 session id。
    userAgent: String(pick(opts.userAgent, env.LLM_USER_AGENT, llmFile.userAgent, SERVER_NAME + '/' + SERVER_VERSION)),
    llmHeaders: Object.assign({}, (llmFile.headers && typeof llmFile.headers === 'object') ? llmFile.headers : {}, (opts.headers && typeof opts.headers === 'object') ? opts.headers : {}),
    llmTimeoutMs: Number(pick(opts.llmTimeoutMs, env.LLM_TIMEOUT_MS, llmFile.timeoutMs, 60000)),
    // mock：无网络/无密钥时用于测试与离线演示（返回确定性 OpenAI 形状响应）
    mock: opts.mock !== undefined ? !!opts.mock : (env.LLM_MOCK === '1' || llmFile.mock === true),
    // 可选：连接令牌（config.json {"token":"..."}），为空则不限。
    // 注意 pick() 会把 '' 也当"未提供"，所以必须显式 || ''，否则会得到字符串 "undefined"（曾导致 WS 全员 401）。
    token: opts.token !== undefined ? String(opts.token) : String(pick(env.SERVER_TOKEN, file.token) || ''),
    staticDeny: ['config.json', 'server/config.json', '.env', '.git'],
    dataDir: pick(opts.dataDir, file.dataDir, path.join(root, 'data')),
    replayDir: pick(opts.replayDir, file.replayDir, path.join(root, 'replays')),
    quiet: !!opts.quiet,
  };
}

// ============================================================================
// 3. 工具
// ============================================================================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};
function json(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  }, extra));
  res.end(body);
}
function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSONBody(req, limit) {
  const txt = await readBody(req, limit);
  if (!txt) return {};
  try { return JSON.parse(txt); } catch (e) { throw new Error('非法 JSON：' + e.message); }
}
function nowMs() { return Date.now(); }

// ============================================================================
// 4. WebSocket 连接
// ============================================================================
let CONN_SEQ = 0;
class WsConn {
  constructor(socket, req) {
    this.id = 'C' + (++CONN_SEQ);
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.fragOp = 0; this.frags = [];
    this.closed = false;
    this.role = null; this.side = null; this.name = '';
    this.connectedAt = nowMs(); this.lastSeen = nowMs();
    this.remote = (req.socket && req.socket.remoteAddress) || '';
    this.counts = { rx: 0, tx: 0, states: 0, commands: 0, chats: 0 };
    this.registered = false;
    this._lastPong = nowMs();
    try { socket.setNoDelay(true); } catch { /* ignore */ }
  }
  describe() {
    return {
      id: this.id, role: this.role, side: this.side, name: this.name, remote: this.remote,
      connectedAt: this.connectedAt, lastSeen: this.lastSeen,
      ageS: +((nowMs() - this.connectedAt) / 1000).toFixed(1),
      idleS: +((nowMs() - this.lastSeen) / 1000).toFixed(1),
      counts: this.counts,
    };
  }
  send(data, opcode = 0x1) {
    if (this.closed) return false;
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      this.socket.write(encodeFrame(payload, { opcode }));
      this.counts.tx++;
      return true;
    } catch { this.destroy(); return false; }
  }
  ping() { if (!this.closed) { try { this.socket.write(encodeFrame(Buffer.alloc(0), { opcode: 0x9 })); } catch { this.destroy(); } } }
  pong(payload) { if (!this.closed) { try { this.socket.write(encodeFrame(payload || Buffer.alloc(0), { opcode: 0xA })); } catch { this.destroy(); } } }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const r = Buffer.from(String(reason), 'utf8');
      const payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code & 0xffff, 0); r.copy(payload, 2);
      this.socket.write(encodeFrame(payload, { opcode: 0x8 }));
    } catch { /* ignore */ }
    try { this.socket.end(); } catch { /* ignore */ }
    setTimeout(() => this.destroy(), 1500).unref?.();
  }
  destroy() { try { this.socket.destroy(); } catch { /* ignore */ } }
}

// ============================================================================
// 5. 服务器
// ============================================================================
export function createGameServer(opts = {}) {
  const cfg = loadConfig(opts);
  const { root, dataDir, replayDir } = cfg;
  const handlers = {}; // 事件回调（UI/测试可挂钩）

  const state = {
    startedAt: nowMs(),
    sims: new Set(),
    agents: new Map(AGENT_SIDES.map((s) => [s, new Set()])),
    sse: new Map(),
    lastState: { ALLIED: null, AXIS: null },
    lastCommands: [],
    replays: [],
    stats: { states: 0, commands: 0, chats: 0, llmCalls: 0, llmErrors: 0, errors: 0, fallbacks: 0 },
  };
  let SSE_SEQ = 0;

  fs.mkdirSync(replayDir, { recursive: true });

  // ---- 房间 ----
  function register(conn) {
    if (conn.registered) {
      state.sims.delete(conn);
      for (const set of state.agents.values()) set.delete(conn);
    }
    if (conn.role === 'sim') state.sims.add(conn);
    else if (conn.role === 'agent' && conn.side && state.agents.has(conn.side)) state.agents.get(conn.side).add(conn);
    conn.registered = true;
    if (typeof handlers.onRegister === 'function') { try { handlers.onRegister(conn); } catch { /* ignore */ } }
  }
  function unregister(conn) {
    state.sims.delete(conn);
    for (const set of state.agents.values()) set.delete(conn);
    conn.registered = false;
    if (typeof handlers.onUnregister === 'function') { try { handlers.onUnregister(conn); } catch { /* ignore */ } }
  }
  function peers() {
    const agents = {}; for (const [s, set] of state.agents) agents[s] = set.size;
    return { sim: state.sims.size, agents, sse: state.sse.size };
  }
  function broadcastState(side, msg) {
    let n = 0;
    const payload = JSON.stringify(msg);
    for (const set of [state.sims, side ? state.agents.get(side) : null]) {
      if (!set) continue;
      for (const c of set) { if (c.send(payload)) n++; }
    }
    for (const s of state.sse.values()) { if (s.side && side && s.side !== side) continue; if (s.write('event: state\ndata: ' + payload + '\n\n')) n++; }
    return n;
  }
  function deliverCommands(side, commands, meta = {}) {
    const msg = { type: 'commands', side, commands, chat: meta.chat, from: meta.from || 'HTTP', id: meta.id || ('ord' + crypto.randomBytes(4).toString('hex')), t: meta.t, reasoning: meta.reasoning, source: meta.source };
    let n = 0;
    for (const c of state.sims) if (c.send(msg)) n++;
    state.stats.commands += Array.isArray(commands) ? commands.length : 1;
    state.lastCommands.push({ at: nowMs(), side, count: Array.isArray(commands) ? commands.length : 1, delivered: n });
    if (state.lastCommands.length > 200) state.lastCommands.splice(0, 50);
    return { delivered: n, id: msg.id };
  }
  function relayChat(side, text, from) {
    const msg = { type: 'chat', side, text, from: from || 'agent', t: nowMs() };
    for (const c of state.sims) c.send(msg);
    for (const c of (state.agents.get(side) || [])) c.send(msg);
    state.stats.chats++;
  }

  // ---- WebSocket 消息分发 ----
  function handleWsMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') { conn.send({ type: 'error', code: 'BAD_JSON', message: '消息必须是 JSON 对象' }); return; }
    conn.lastSeen = nowMs();
    conn.counts.rx++;
    switch (String(msg.type || '')) {
      case 'hello': case 'register': {
        if (msg.role) conn.role = String(msg.role).toLowerCase();
        if (msg.side) conn.side = String(msg.side).toUpperCase();
        if (msg.name) conn.name = String(msg.name);
        register(conn);
        conn.send({
          type: 'welcome', id: conn.id, server: SERVER_NAME, version: SERVER_VERSION,
          role: conn.role, side: conn.side, t: nowMs(), peers: peers(),
          protocol: {
            upstream: ['state', 'request_decision', 'heartbeat'],
            downstream: ['commands', 'chat', 'heartbeat', 'welcome'],
          },
        });
        break;
      }
      case 'state': {
        const side = String(msg.side || conn.side || '').toUpperCase();
        if (!AGENT_SIDES.includes(side)) { conn.send({ type: 'error', code: 'BAD_SIDE', message: '缺少 side' }); return; }
        const record = { at: nowMs(), t: msg.t, side, backend: msg.backend, seq: msg.seq, payload: msg.payload !== undefined ? msg.payload : msg.state };
        state.lastState[side] = record;
        state.stats.states++;
        conn.counts.states++;
        const out = { type: 'state', side, t: msg.t, backend: msg.backend, seq: msg.seq, payload: record.payload };
        broadcastState(side, out);
        if (typeof handlers.onState === 'function') { try { handlers.onState(side, record); } catch { /* ignore */ } }
        break;
      }
      case 'request_decision': {
        const side = String(msg.side || conn.side || '').toUpperCase();
        const out = { type: 'request_decision', side, t: msg.t, backend: msg.backend, state: msg.state !== undefined ? msg.state : msg.payload };
        let n = 0;
        for (const c of (state.agents.get(side) || [])) if (c.send(out)) n++;
        for (const s of state.sse.values()) { if (s.side === side) { if (s.write('event: request_decision\ndata: ' + JSON.stringify(out) + '\n\n')) n++; } }
        if (typeof handlers.onRequest === 'function') { try { handlers.onRequest(side, out); } catch { /* ignore */ } }
        if (!n) conn.send({ type: 'notice', code: 'NO_AGENT', message: side + ' 方当前无外部智能体，仿真应回落 LOCAL' });
        break;
      }
      case 'commands': case 'orders': case 'decision': {
        const side = String(msg.side || conn.side || '').toUpperCase();
        const commands = msg.commands || msg.orders || (msg.decision && msg.decision.commands) || [];
        const meta = { from: conn.name || conn.id, chat: msg.chat || (msg.decision && msg.decision.chat), reasoning: msg.reasoning || (msg.decision && msg.decision.reasoning), source: msg.source || 'AI_REMOTE', t: msg.t };
        conn.counts.commands += Array.isArray(commands) ? commands.length : 0;
        const r = deliverCommands(side, commands, meta);
        conn.send({ type: 'ack', id: r.id, side, accepted: Array.isArray(commands) ? commands.length : 0, delivered: r.delivered });
        break;
      }
      case 'chat': {
        const side = String(msg.side || conn.side || '').toUpperCase();
        relayChat(side, String(msg.text || ''), msg.from || conn.name || conn.id);
        break;
      }
      case 'heartbeat': case 'ping': {
        conn.send({ type: 'pong', t: nowMs(), echo: msg.seq, t_sim: msg.t });
        break;
      }
      case 'pong': conn._lastPong = nowMs(); break;
      case 'fallback': state.stats.fallbacks++; if (typeof handlers.onFallback === 'function') { try { handlers.onFallback(msg); } catch { /* ignore */ } } break;
      case 'replay': saveReplay(msg.replay || msg.payload || msg, { from: conn.id, side: conn.side }); break;
      case 'bye': conn.close(1000, 'bye'); break;
      default: conn.send({ type: 'error', code: 'BAD_TYPE', message: '未知消息类型：' + msg.type });
    }
  }

  function onSocketData(conn, chunk) {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    if (conn.buf.length > MAX_FRAME * 2) { conn.close(1009, 'too big'); return; }
    let out;
    try { out = decodeFrames(conn.buf); } catch (e) { conn.close(1002, 'bad frame'); return; }
    conn.buf = out.rest;
    for (const f of out.frames) {
      if (f.opcode === 0x8) { conn.close(1000, 'peer close'); return; }
      if (f.opcode === 0x9) { conn.pong(f.payload); continue; }
      if (f.opcode === 0xA) { conn._lastPong = nowMs(); conn.lastSeen = nowMs(); continue; }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (f.fin) { dispatchText(conn, f.payload); }
        else { conn.fragOp = f.opcode; conn.frags = [f.payload]; }
        continue;
      }
      if (f.opcode === 0x0) {
        conn.frags.push(f.payload);
        if (f.fin) { const merged = Buffer.concat(conn.frags); conn.frags = []; dispatchText(conn, merged); }
        continue;
      }
      // 其他保留 opcode：忽略
    }
  }
  function dispatchText(conn, payload) {
    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); }
    catch { conn.send({ type: 'error', code: 'BAD_JSON', message: '非法 JSON' }); return; }
    try { handleWsMessage(conn, msg); }
    catch (e) { state.stats.errors++; conn.send({ type: 'error', code: 'HANDLER', message: String(e && e.message || e) }); }
  }

  // ---- HTTP ----
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => {
      state.stats.errors++;
      try { json(res, 500, { ok: false, error: String(e && e.message || e) }); } catch { /* ignore */ }
    });
  });

  async function handleHttp(req, res) {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = decodeURIComponent(u.pathname);
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    if (pathname.startsWith('/api/')) return handleApi(req, res, u, pathname, method);

    // 静态文件
    if (method !== 'GET' && method !== 'HEAD') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    return serveStatic(req, res, pathname);
  }

  // ---- API 路由 ----
  async function handleApi(req, res, u, pathname, method) {
    switch (pathname) {
      case '/api/health': {
        const ls = {};
        for (const s of AGENT_SIDES) ls[s] = state.lastState[s] ? { t: state.lastState[s].t, ageS: +((nowMs() - state.lastState[s].at) / 1000).toFixed(1) } : null;
        json(res, 200, {
          ok: true, server: SERVER_NAME, version: SERVER_VERSION, now: nowMs(),
          upS: +((nowMs() - state.startedAt) / 1000).toFixed(1),
          clients: peers(), stats: state.stats,
          lastState: ls,
          llm: { configured: !!cfg.apiKey, mock: cfg.mock, model: cfg.model, baseUrl: cfg.baseUrl, sessionHeader: Object.keys(cfg.llmHeaders || {}).indexOf('x-opencode-session') >= 0 },
          replayCount: state.replays.length,
        });
        return;
      }
      case '/api/agents': {
        const list = [];
        for (const c of state.sims) list.push(c.describe());
        for (const set of state.agents.values()) for (const c of set) list.push(c.describe());
        for (const s of state.sse.values()) list.push({ id: s.id, role: s.role, side: s.side, transport: 'sse', connectedAt: s.connectedAt, lastSeen: s.lastSeen, counts: s.counts });
        json(res, 200, { ok: true, peers: peers(), agents: list });
        return;
      }
      case '/api/scenarios': {
        const { scenarios, source } = loadScenarios();
        json(res, 200, { ok: true, source, count: scenarios.length, scenarios });
        return;
      }
      case '/api/orders': {
        if (method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
        let body;
        try { body = await readJSONBody(req); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
        const side = String(body.side || '').toUpperCase();
        if (!AGENT_SIDES.includes(side)) { json(res, 400, { ok: false, error: 'side 必须是 ALLIED 或 AXIS' }); return; }
        const commands = Array.isArray(body.commands) ? body.commands : (body.command ? [body.command] : []);
        const r = deliverCommands(side, commands, { from: body.from || 'HTTP', chat: body.chat, reasoning: body.reasoning, source: body.source || 'AI_REMOTE', t: body.t });
        if (body.chat) relayChat(side, String(body.chat), body.from || 'HTTP');
        json(res, 200, { ok: true, side, accepted: commands.length, delivered: r.delivered, id: r.id, sims: state.sims.size });
        return;
      }
      case '/api/llm/chat': {
        if (method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
        let body;
        try { body = await readJSONBody(req, 2 * 1024 * 1024); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
        state.stats.llmCalls++;
        const out = await llmChat(body, cfg);
        if (state.sse.size) { /* 可选：广播 LLM 调用统计 */ }
        json(res, out.status, out.body);
        return;
      }
      case '/api/stream': {
        if (method !== 'GET') { json(res, 405, { ok: false, error: 'GET only' }); return; }
        return handleSSE(req, res, u);
      }
      case '/api/replay': {
        if (method === 'POST') {
          let body;
          try { body = await readJSONBody(req, 32 * 1024 * 1024); } catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
          if (body && body.action === 'list') { json(res, 200, { ok: true, replays: state.replays }); return; }
          const rec = saveReplay(body.replay || body.payload || body, { from: 'HTTP' });
          json(res, 200, { ok: true, id: rec.id, file: rec.file, url: rec.url, bytes: rec.bytes, scenario: rec.scenario, endedAt: rec.endedAt, events: rec.events, snapshots: rec.snapshots });
          return;
        }
        // GET：列表或下载
        const id = u.searchParams.get('id');
        if (!id) { json(res, 200, { ok: true, replays: state.replays }); return; }
        const rec = state.replays.find((r) => r.id === id);
        if (!rec) { json(res, 404, { ok: false, error: '回放不存在' }); return; }
        try {
          const data = fs.readFileSync(rec.file, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': 'attachment; filename="' + path.basename(rec.file) + '"' });
          res.end(data);
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return;
      }
      case '/api/config': {
        // 只暴露非敏感配置
        json(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, llm: { configured: !!cfg.apiKey, mock: cfg.mock, model: cfg.model }, protocol: { stateHz: '1-2', fallbackAfterS: 12 } });
        return;
      }
      default: json(res, 404, { ok: false, error: '未知 API：' + pathname });
    }
  }

  function saveReplay(replay, meta = {}) {
    const scenario = (replay && replay.scenario) || 'unknown';
    const endedAt = (replay && (replay.endedAt !== undefined ? replay.endedAt : replay.t)) || 0;
    const id = 'r' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const safe = String(scenario).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    const file = path.join(replayDir, id + '-' + safe + '.json');
    const text = JSON.stringify(replay, null, 0);
    fs.writeFileSync(file, text);
    const rec = {
      id, file, url: '/api/replay?id=' + id, scenario, endedAt: +endedAt || 0,
      bytes: Buffer.byteLength(text),
      snapshots: Array.isArray(replay && replay.snapshots) ? replay.snapshots.length : 0,
      events: Array.isArray(replay && replay.events) ? replay.events.length : 0,
      commands: Array.isArray(replay && replay.commands) ? replay.commands.length : 0,
      result: (replay && replay.result) || null,
      savedAt: nowMs(), from: meta.from || 'unknown', side: meta.side || null,
    };
    state.replays.push(rec);
    if (state.replays.length > 500) state.replays.splice(0, 100);
    if (typeof handlers.onReplay === 'function') { try { handlers.onReplay(rec); } catch { /* ignore */ } }
    return rec;
  }

  function handleSSE(req, res, u) {
    const side = String(u.searchParams.get('side') || '').toUpperCase();
    const role = String(u.searchParams.get('role') || 'observer').toLowerCase();
    const id = 'S' + (++SSE_SEQ);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const entry = {
      id, role, side: AGENT_SIDES.includes(side) ? side : null, res, connectedAt: nowMs(), lastSeen: nowMs(),
      counts: { tx: 0 },
      write: (chunk) => { try { res.write(chunk); entry.counts.tx++; return true; } catch { return false; } },
    };
    state.sse.set(id, entry);
    entry.write('retry: 3000\n\n');
    entry.write('event: hello\ndata: ' + JSON.stringify({ type: 'hello', id, role, side: entry.side, server: SERVER_NAME, version: SERVER_VERSION, peers: peers(), t: nowMs() }) + '\n\n');
    if (entry.side && state.lastState[entry.side]) {
      entry.write('event: state\ndata: ' + JSON.stringify({ type: 'state', side: entry.side, t: state.lastState[entry.side].t, payload: state.lastState[entry.side].payload }) + '\n\n');
    }
    const ka = setInterval(() => {
      entry.lastSeen = nowMs();
      if (!entry.write(': ping ' + nowMs() + '\n\n')) { clearInterval(ka); state.sse.delete(id); }
    }, 15000);
    ka.unref?.();
    req.on('close', () => { clearInterval(ka); state.sse.delete(id); });
    if (typeof handlers.onSSE === 'function') { try { handlers.onSSE(entry); } catch { /* ignore */ } }
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    let abs = path.resolve(root, '.' + rel);
    if (!abs.startsWith(root)) { json(res, 403, { ok: false, error: 'forbidden' }); return; }
    const relCheck = path.relative(root, abs).split(path.sep).join('/');
    if (cfg.staticDeny.some((d) => relCheck === d || relCheck.startsWith(d + '/'))) { json(res, 403, { ok: false, error: 'forbidden' }); return; }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      if (rel === '/index.html') {
        const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><title>铁海 1942</title>'
          + '<body style="background:#0b1a22;color:#cfe;font-family:system-ui;padding:2rem">'
          + '<h1>铁海 1942 — 服务器已就绪</h1>'
          + '<p>静态根目录：' + root + '</p>'
          + '<p>index.html 尚未生成（UI 由 T7 交付）。</p>'
          + '<ul><li><a style="color:#6cf" href="/api/health">/api/health</a></li>'
          + '<li><a style="color:#6cf" href="/api/scenarios">/api/scenarios</a></li>'
          + '<li><a style="color:#6cf" href="/api/agents">/api/agents</a></li></ul></body></html>';
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': Buffer.byteLength(html) });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      json(res, 404, { ok: false, error: 'not found: ' + rel });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    try {
      const stat = fs.statSync(abs);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=30', 'Access-Control-Allow-Origin': '*' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(abs).pipe(res);
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
  }

  function loadScenarios() {
    const candidates = [path.join(dataDir, 'scenarios.json'), path.join(root, 'data', 'scenarios.json')];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
        const arr = Array.isArray(obj) ? obj : (obj.scenarios || []);
        if (arr.length) return { scenarios: arr, source: p };
      } catch (e) { /* 继续找 */ }
    }
    return { scenarios: FALLBACK_SCENARIO_META, source: 'builtin' };
  }

  // ---- 升级为 WebSocket ----
  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); } catch { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
    }
    if (cfg.token) {
      const tk = u.searchParams.get('token');
      if (tk !== cfg.token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    }
    const accept = wsAcceptKey(key);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const conn = new WsConn(socket, req);
    conn.role = (u.searchParams.get('role') || '').toLowerCase() || null;
    const side = (u.searchParams.get('side') || '').toUpperCase();
    if (AGENT_SIDES.includes(side)) conn.side = side;
    conn.name = u.searchParams.get('name') || '';
    if (conn.role) register(conn);
    if (head && head.length) onSocketData(conn, head);
    socket.on('data', (chunk) => onSocketData(conn, chunk));
    socket.on('error', () => unregister(conn));
    socket.on('close', () => unregister(conn));
    socket.on('end', () => { /* 等 close */ });
    conn.send({ type: 'hello', id: conn.id, server: SERVER_NAME, version: SERVER_VERSION, role: conn.role, side: conn.side, tokenRequired: !!cfg.token, t: nowMs() });
  });

  // 服务器主动心跳（30s ping，90s 无 pong 断开）
  const hb = setInterval(() => {
    const t = nowMs();
    for (const c of [...state.sims, ...[].concat(...[...state.agents.values()])]) {
      if (t - c._lastPong > 90000) { if (typeof c.close === 'function') c.close(1001, 'heartbeat timeout'); unregister(c); continue; }
      // WS 客户端有 ping()；SSE 客户端只写注释行保活（两者都注册进 state.sims）
      if (typeof c.ping === 'function') c.ping();
      else if (typeof c.write === 'function') { try { c.write(': ping ' + t + '\n\n'); } catch (e) { unregister(c); } }
    }
  }, 30000);
  hb.unref?.();

  function listen(options = {}) {
    const port = options.port !== undefined ? options.port : cfg.port;
    const host = options.host || cfg.host;
    return new Promise((resolve, reject) => {
      const onErr = (e) => { server.off('listening', onOk); reject(e); };
      const onOk = () => {
        server.off('error', onErr);
        const addr = server.address();
        resolve({ port: addr.port, host: addr.address, url: 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + addr.port });
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    });
  }
  function close() {
    return new Promise((resolve) => {
      clearInterval(hb);
      for (const c of state.sims) c.close(1001, 'server shutdown');
      for (const set of state.agents.values()) for (const c of set) c.close(1001, 'server shutdown');
      for (const s of state.sse.values()) { try { s.res.end(); } catch { /* ignore */ } }
      state.sse.clear();
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref?.();
    });
  }

  return {
    server, cfg, state, handlers, listen, close,
    peers, broadcastState, deliverCommands, relayChat, saveReplay, loadScenarios,
    handleWsMessage, register, unregister,
    get url() { const a = server.address(); return a ? 'http://' + cfg.host + ':' + a.port : null; },
  };
}

export async function startServer(opts = {}) {
  const g = createGameServer(opts);
  const info = await g.listen(opts);
  // 注意：g.url 是 getter（只有 getter），不能整体 Object.assign（Node 24 下会抛
  // "Cannot set property url of #<Object> which has only a getter"），逐键合并并跳过 url。
  for (const k of Object.keys(info)) { if (k === 'url') continue; try { g[k] = info[k]; } catch (e) { /* 只读字段忽略 */ } }
  if (!g.cfg.quiet) console.log('[serve] 铁海 1942 服务器已启动：' + info.url + '  (root=' + g.cfg.root + ')');
  return g;
}

// ============================================================================
// 6. LLM 代理（OpenAI 兼容）
// ============================================================================
function mockLLMResponse(body, cfg) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const wantsJSON = messages.some((m) => typeof m.content === 'string' && (m.content.indexOf('JSON') >= 0 || m.content.indexOf('commands') >= 0));
  const content = wantsJSON
    ? JSON.stringify({ reasoning: '（模拟后端）依据可见态势保持战列线，敌主力在右舷。', chat: '', commands: [{ kind: 'SET_COURSE', params: { heading: 270 } }, { kind: 'FIRE', params: { ammo: 'AP', salvoes: null } }] })
    : '（模拟后端）收到，按现行方针执行。';
  return {
    id: 'chatcmpl-mock-' + crypto.randomBytes(4).toString('hex'),
    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: (body && body.model) || cfg.model + '-mock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _mock: true,
  };
}

/**
 * OpenAI 兼容 chat/completions 代理。
 * 返回 {status, body}。密钥仅取服务器配置，绝不回传。
 */
export async function llmChat(body, cfg) {
  if (cfg.mock) return { status: 200, body: mockLLMResponse(body || {}, cfg) };
  if (!cfg.apiKey) {
    return { status: 503, body: { error: { message: 'LLM 未配置：请设置环境变量 LLM_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY，或在 config.json 写入 llm.apiKey；也可设 LLM_MOCK=1 使用模拟后端。', code: 'NO_API_KEY', type: 'configuration_error' } } };
  }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { status: 400, body: { error: { message: 'messages 必须是非空数组', code: 'BAD_REQUEST', type: 'invalid_request_error' } } };
  }
  const payload = {
    model: body.model || cfg.model,
    messages: body.messages.map((m) => ({ role: String(m.role || 'user'), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
    temperature: body.temperature !== undefined ? body.temperature : 0.4,
    max_tokens: body.max_tokens !== undefined ? body.max_tokens : 800,
    stream: false,
  };
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.stop !== undefined) payload.stop = body.stop;
  if (body.response_format !== undefined) payload.response_format = body.response_format;
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  let base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = new URL(base + '/chat/completions');
  // 仅在此处惰性加载 TLS 模块；模块顶层保持 http/fs/crypto/path/url 最小依赖集
  const mod = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const lib = mod.default || mod;
  return new Promise((resolve) => {
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json', 'Content-Length': data.length,
        Authorization: 'Bearer ' + cfg.apiKey, 'User-Agent': cfg.userAgent || (SERVER_NAME + '/' + SERVER_VERSION),
      }, cfg.llmHeaders || {}),
      timeout: cfg.llmTimeoutMs,
    }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { error: { message: text.slice(0, 2000), code: 'UPSTREAM_BAD_JSON' } }; }
        resolve({ status: up.statusCode || 502, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('上游超时')); });
    req.on('error', (e) => resolve({ status: 502, body: { error: { message: '上游请求失败：' + (e && e.message || e), code: 'UPSTREAM_ERROR', type: 'api_error' } } }));
    req.write(data);
    req.end();
  });
}

// ============================================================================
// 7. 无剧本文件时的后备剧本元数据（serve 只用于 /api/scenarios 列表）
// ============================================================================
export const FALLBACK_SCENARIO_META = [
  { id: 't5_skirmish', nameZh: '【内置】铁底湾前哨遭遇战', date: '1942-11-13T01:30:00Z', sides: { ALLIED: { nameZh: '同盟国' }, AXIS: { nameZh: '轴心国' } }, shipCount: 4, builtin: true },
  { id: 't5_sandbox', nameZh: '【内置】单舰炮术沙盒', date: '1942-06-01T12:00:00Z', sides: { ALLIED: { nameZh: '同盟国' }, AXIS: { nameZh: '轴心国' } }, shipCount: 2, builtin: true },
];

// ============================================================================
// 8. CLI
// ============================================================================
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') opt.port = Number(args[++i]);
    else if (a === '--host') opt.host = args[++i];
    else if (a === '--root') opt.root = args[++i];
    else if (a === '--mock') opt.mock = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node server/serve.mjs [--port 8787] [--host 127.0.0.1] [--root .] [--mock]');
      process.exit(0);
    }
  }
  const g = await startServer(opt);
  const shutdown = async () => { console.log('\n[serve] 正在关闭…'); await g.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
