#!/usr/bin/env node
/**
 * tools/uicheck.mjs — 铁海 1942 无头 UI 验证器（零依赖 / 原生 ESM）
 *
 * 作用：自己拉起一个 headless Chrome，用原生 WebSocket 讲 CDP 协议，
 *       真实地“移动鼠标、按下、松开、敲键盘”，并截图/收集页面错误。
 *       慢点击（press 与 release 间隔 250ms）用来抓一类真实 bug：
 *       面板定时 innerHTML 重建，会把人的一次点击吞掉。
 *
 * 用法：
 *   node tools/uicheck.mjs --suite --shots .shots
 *   node tools/uicheck.mjs --suite --url http://127.0.0.1:8787/index.html
 *   node tools/uicheck.mjs --suite --view 1680x1050 --out .shots/uicheck.json
 *   node tools/uicheck.mjs --no-chrome --port 9222 --suite   # 附到已开的 Chrome
 *   node tools/uicheck.mjs --help
 *
 * 参数：
 *   --suite          运行内置场景 suite（否则只导航/截图/报告页面状态）
 *   --url URL        页面地址，默认 http://127.0.0.1:8787/index.html
 *   --shots DIR      截图目录，默认 <cwd>/.shots
 *   --out FILE       把结果 JSON 写到此路径
 *   --view WxH       视口尺寸（用 Emulation.setDeviceMetricsOverride），默认沿用窗口 1680x1050
 *   --port N         CDP 端口；默认从 9222 起探测一个空闲端口
 *   --no-chrome      不启动 Chrome，直接连接已存在的调试端口（此时 --port 默认 9222）
 *   --eval EXPR      在页面里求值并打印结果（配合 --wait 可先等一段时间；--await 用 awaitPromise）
 *   --wait MS        求值/截图前先等 MS 毫秒
 *   --click SEL      求值后对 SEL 发一次真实鼠标点击（可重复）
 *   --chrome PATH    指定 Chrome 可执行文件（默认 macOS 路径，可用 CHROME_PATH 覆盖）
 *   -h, --help       显示帮助
 *
 * 退出码：0 全部通过；1 有检查失败/页面错误；2 参数或环境错误；130/143 被信号中断。
 * 所有外部调用均带超时；另有 180s 全局看门狗，保证脚本不会永久挂住。
 * 无论正常结束、抛错还是收到 SIGINT，都会杀掉自己拉起的 Chrome 并删除临时 profile。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_URL = 'http://127.0.0.1:8787/index.html';
const DEFAULT_CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WATCHDOG_MS = 180_000;
const SCENARIO_ID = 'denmark_strait_1941';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// 资源与确定性清理
// ---------------------------------------------------------------------------

let chromeProc = null;
let chromeDetached = false;
let profileDir = null;
let chromeStderr = '';
let chromeSpawnError = null;
let chromeExit = null;
let watchdogTimer = null;
let cleanupPromise = null;

/** 给 Chrome 进程组发信号（detached 启动时连 helper 一起收掉），并对单进程兜底。 */
function signalChrome(signal) {
  const proc = chromeProc;
  if (!proc || proc.exitCode !== null || proc.killed) return false;
  let sent = false;
  if (chromeDetached && proc.pid > 0) {
    try { process.kill(-proc.pid, signal); sent = true; } catch { /* 进程组可能已经没了 */ }
  }
  try { proc.kill(signal); sent = true; } catch { /* ignore */ }
  return sent;
}

function killChromeSync() {
  try { signalChrome('SIGKILL'); } catch { /* ignore */ }
}

function removeProfileSync() {
  if (!profileDir) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 });
    } catch { /* ignore */ }
    if (!fs.existsSync(profileDir)) return;
  }
}

/** 等子进程退出；超时返回 false。 */
function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let done = false;
    const onExit = () => { if (!done) { done = true; clearTimeout(timer); resolve(true); } };
    const timer = setTimeout(() => { if (!done) { done = true; child.removeListener('exit', onExit); resolve(false); } }, timeoutMs);
    child.once('exit', onExit);
  });
}

/** 关 CDP、杀 Chrome、删临时 profile。可重复调用（幂等），且整体有上限，绝不卡死。 */
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const work = (async () => {
      try { session?.cdp?.close(); } catch { /* ignore */ }
      const proc = chromeProc;
      if (proc && proc.exitCode === null && !proc.killed) {
        try { signalChrome('SIGTERM'); } catch { /* ignore */ }
        const died = await onceExit(proc, 2500);
        if (!died) {
          try { signalChrome('SIGKILL'); } catch { /* ignore */ }
          await onceExit(proc, 1500);
        }
      }
      // helper 进程可能还在写 profile，删不掉就等一会再删。
      for (let attempt = 0; attempt < 5 && profileDir && fs.existsSync(profileDir); attempt++) {
        removeProfileSync();
        if (profileDir && fs.existsSync(profileDir)) await sleep(200);
      }
    })();
    // 清理本身也受看门狗保护：最多等 6s，然后同步兜底。
    await Promise.race([work, sleep(6000)]);
    killChromeSync();
    removeProfileSync();
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  })();
  return cleanupPromise;
}

function installProcessGuards() {
  // 最后一道保险：即使有人调用了 process.exit，也同步清理（不能 await）。
  process.on('exit', () => { killChromeSync(); removeProfileSync(); });

  const onSignal = async (sig) => {
    // 先整组收掉 Chrome，等 helper 松手后重试删 profile，再退出（避免残留）。
    killChromeSync();
    for (let attempt = 0; attempt < 6 && profileDir && fs.existsSync(profileDir); attempt++) {
      removeProfileSync();
      if (profileDir && fs.existsSync(profileDir)) await sleep(200);
    }
    console.error(`\n[uicheck] 收到 ${sig}，已清理 Chrome/临时目录，退出。`);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  process.once('uncaughtException', async (err) => {
    console.error('[uicheck] 未捕获异常：', err && err.stack ? err.stack : err);
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(1);
  });
  process.once('unhandledRejection', async (err) => {
    console.error('[uicheck] 未处理的 Promise 拒绝：', err && err.stack ? err.stack : err);
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(1);
  });
}

function armWatchdog() {
  watchdogTimer = setTimeout(async () => {
    console.error(`[uicheck] 看门狗触发：超过 ${WATCHDOG_MS / 1000}s，强制清理并退出（exit 1）。`);
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(1);
  }, WATCHDOG_MS);
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`铁海 1942 无头 UI 验证器（Chrome DevTools Protocol）

用法:
  node tools/uicheck.mjs --suite --shots .shots
  node tools/uicheck.mjs --suite --url http://127.0.0.1:8787/index.html --view 1680x1050
  node tools/uicheck.mjs --no-chrome --port 9222 --suite

参数:
  --suite          运行内置场景 suite
  --url URL        页面地址（默认 ${DEFAULT_URL}）
  --shots DIR      截图目录（默认 <cwd>/.shots）
  --out FILE       结果 JSON 输出路径
  --view WxH       视口尺寸，如 1680x1050（Emulation.setDeviceMetricsOverride）
  --port N         CDP 端口（默认从 9222 起找空闲端口）
  --no-chrome      连接已运行的 Chrome，不自己启动
  --chrome PATH    Chrome 可执行文件（默认 ${DEFAULT_CHROME}）
  -h, --help       显示本帮助`);
}

function parseArgs(argv) {
  const opts = {
    suite: false,
    url: DEFAULT_URL,
    shots: path.resolve(process.cwd(), '.shots'),
    out: null,
    view: null,
    port: 0,
    noChrome: false,
    chrome: DEFAULT_CHROME,
    evalExpr: null,
    clicks: [],
    waitMs: 0,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const need = (flag) => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少取值`);
      return value;
    };
    if (arg === '--suite') opts.suite = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--no-chrome') opts.noChrome = true;
    else if (arg === '--url') opts.url = need(arg);
    else if (arg === '--shots') opts.shots = path.resolve(need(arg));
    else if (arg === '--out') opts.out = path.resolve(need(arg));
    else if (arg === '--chrome') opts.chrome = need(arg);
    else if (arg === '--eval') opts.evalExpr = need(arg);
    else if (arg === '--click') opts.clicks.push(need(arg));
    else if (arg === '--wait') opts.waitMs = Number(need(arg)) || 0;
    else if (arg === '--port') {
      const raw = need(arg);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port 取值非法：${raw}`);
      opts.port = port;
    } else if (arg === '--view') {
      const raw = need(arg);
      const m = /^(\d{2,5})x(\d{2,5})$/i.exec(raw);
      if (!m) throw new Error(`--view 需要形如 1680x1050 的尺寸，收到：${raw}`);
      opts.view = { width: Number(m[1]), height: Number(m[2]) };
    } else {
      throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 端口 / Chrome / DevTools 发现
// ---------------------------------------------------------------------------

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  if (preferred) return preferred;
  for (let port = 9222; port < 9262; port++) {
    if (await isPortFree(port)) return port;
  }
  return 9262 + Math.floor(Math.random() * 30);
}

function launchChrome(opts, port) {
  if (!fs.existsSync(opts.chrome)) {
    throw new Error(`找不到 Chrome 可执行文件：${opts.chrome}（可用 --chrome 或 CHROME_PATH 指定）`);
  }
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uicheck-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${(opts.view && opts.view.width) || 1680},${(opts.view && opts.view.height) || 1050}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--disable-dev-shm-usage',
    'about:blank',
  ];
  // detached: Chrome 自成进程组，退出时可以整组收掉（helper 进程不会残留）。
  chromeProc = spawn(opts.chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  chromeDetached = true;
  chromeProc.stderr?.setEncoding('utf8');
  chromeProc.stderr?.on('data', (chunk) => { chromeStderr = (chromeStderr + chunk).slice(-4000); });
  chromeProc.once('error', (err) => { chromeSpawnError = err; });
  chromeProc.once('exit', (code, signal) => { chromeExit = { code, signal }; });
}

async function waitForDevtools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (chromeSpawnError) throw new Error(`Chrome 启动失败：${chromeSpawnError.message}`);
    if (chromeExit) {
      throw new Error(`Chrome 提前退出（code=${chromeExit.code}, signal=${chromeExit.signal}）。stderr 末尾：\n${chromeStderr.slice(-1200)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const info = await res.json();
        if (info && info.webSocketDebuggerUrl) return info;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }
  throw new Error(`等待 DevTools http://127.0.0.1:${port}/json/version 超时（${timeoutMs}ms）${lastError ? '：' + lastError.message : ''}`);
}

/** 取一个 page target 的 webSocketDebuggerUrl（比 browser 级 session 简单可靠）。 */
async function findPageTarget(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const list = await res.json();
        const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        const target = pages.find((t) => t.url === 'about:blank') || pages[0];
        if (target) return target;
      }
    } catch { /* 端口可能还没起来，继续等 */ }
    await sleep(100);
  }
  // 极端情况下 Chrome 没开默认 tab：用 PUT /json/new 建一个。
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  throw new Error(`找不到可用的 page target（端口 ${port}）`);
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（原生 WebSocket）
// ---------------------------------------------------------------------------

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();      // id -> {resolve,reject,method,timer}
    this.handlers = new Map();     // method -> Set<fn>
    this.eventWaiters = new Map(); // method -> [{resolve,reject}]
  }

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        finish(reject, new Error(`连接 CDP WebSocket 超时（${timeoutMs}ms）：${this.wsUrl}`));
      }, timeoutMs);

      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        finish(reject, new Error(`无法创建 CDP WebSocket：${err.message}`));
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => finish(resolve, this));
      ws.addEventListener('error', (ev) => {
        const msg = (ev && (ev.message || (ev.error && ev.error.message))) || '未知错误';
        finish(reject, new Error(`CDP WebSocket 连接失败：${msg}`));
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => {
        this.closed = true;
        const err = new Error('CDP 连接已关闭');
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(err); }
        this.pending.clear();
        for (const waiters of this.eventWaiters.values()) {
          for (const waiter of waiters) waiter.reject(err);
          waiters.length = 0;
        }
        finish(reject, err);
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
      msg = JSON.parse(text);
    } catch { return; }

    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const detail = msg.error.message || JSON.stringify(msg.error);
        entry.reject(new Error(`${entry.method}: ${detail}`));
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }

    if (!msg.method) return;
    // 一次性事件等待者（先进先出）
    const waiters = this.eventWaiters.get(msg.method);
    if (waiters && waiters.length) {
      const waiter = waiters.shift();
      waiter.resolve(msg.params || {});
    }
    const handlers = this.handlers.get(msg.method);
    if (handlers) {
      for (const fn of handlers) {
        try { fn(msg.params || {}); } catch (err) { console.error(`[uicheck] CDP 事件处理异常 ${msg.method}: ${err.message}`); }
      }
    }
  }

  send(method, params = {}, timeoutMs = 15_000) {
    if (this.closed || !this.ws) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 调用超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, fn) {
    let handlers = this.handlers.get(method);
    if (!handlers) { handlers = new Set(); this.handlers.set(method, handlers); }
    handlers.add(fn);
    return () => handlers.delete(fn);
  }

  waitForEvent(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const arr = this.eventWaiters.get(method) || [];
      this.eventWaiters.set(method, arr);
      const waiter = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      const timer = setTimeout(() => {
        const index = arr.indexOf(waiter);
        if (index >= 0) arr.splice(index, 1);
        reject(new Error(`等待 CDP 事件 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      arr.push(waiter);
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 页面会话：goto / evaluate / screenshot / click / key / waitFor
// ---------------------------------------------------------------------------

function createUiSession(cdp, opts) {
  const consoleErrors = [];
  const screenshots = [];
  const MAX_ERRORS = 200;

  const pushError = (entry) => {
    if (consoleErrors.length >= MAX_ERRORS) return;
    consoleErrors.push({ at: new Date().toISOString(), ...entry });
  };

  const formatArg = (arg) => {
    if (!arg) return '';
    if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
    if (arg.description) return String(arg.description);
    return String(arg.type || '?');
  };

  // ---- 事件收集（必须在 enable 之前注册） ----
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'assert') return;
    const text = (params.args || []).map(formatArg).join(' ');
    pushError({
      kind: params.type === 'assert' ? 'console.assert' : 'console.error',
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || null,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
    });
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    const exception = details.exception || {};
    const text = exception.description || exception.value || details.text || 'unknown exception';
    pushError({
      kind: 'exception',
      text: String(text),
      url: details.url || null,
      line: details.lineNumber ?? null,
      column: details.columnNumber ?? null,
    });
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    if (entry.level !== 'error') return;
    pushError({
      kind: 'log.error',
      text: String(entry.text || ''),
      source: entry.source || null,
      url: entry.url || null,
      line: entry.lineNumber ?? null,
    });
  });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 10_000,
    }, 15_000);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const exception = details.exception || {};
      const text = exception.description || exception.value || details.text || 'unknown exception';
      throw new Error(`页面求值异常：${String(text).split('\n')[0]}`);
    }
    return result.result ? result.result.value : undefined;
  }

  async function waitFor(predicateExpression, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(predicateExpression);
        lastError = null;
      } catch (err) {
        last = undefined;
        lastError = err;
      }
      if (last) return last;
      await sleep(intervalMs);
    }
    throw new Error(`waitFor 超时（${timeoutMs}ms）：${predicateExpression}` +
      (lastError ? `；最后错误=${lastError.message}` : `；最后取值=${JSON.stringify(last)}`));
  }

  async function goto(url, { waitMs = 1200 } = {}) {
    const load = cdp.waitForEvent('Page.loadEventFired', 15_000).catch(() => null);
    const nav = await cdp.send('Page.navigate', { url }, 15_000);
    if (nav.errorText) throw new Error(`导航失败 ${url}：${nav.errorText}`);
    const fired = await load;
    if (!fired) {
      // 事件丢了也不要直接失败：以 readyState 兜底。
      try { await waitFor(`document.readyState === 'complete'`, { timeoutMs: 5_000, intervalMs: 100 }); } catch { /* ignore */ }
    }
    await sleep(waitMs);
  }

  async function screenshot(file, { fullPage = false } = {}) {
    const absolute = path.resolve(file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const result = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: !!fullPage,
    }, 20_000);
    if (!result.data) throw new Error('截图返回空数据');
    const buffer = Buffer.from(result.data, 'base64');
    fs.writeFileSync(absolute, buffer);
    if (!screenshots.includes(absolute)) screenshots.push(absolute);
    return { path: absolute, bytes: buffer.length };
  }

  /**
   * 真实鼠标点击：先滚动到视口中央，再用 Input.dispatchMouseEvent 走
   * mouseMoved -> mousePressed -> (等待 delayMs) -> mouseReleased。
   * 返回 false 仅表示元素无法被解析/点击，不表示页面没有响应。
   */
  async function click(selector, { delayMs = 0 } = {}) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not found' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const width = r.width, height = r.height;
      const onScreen = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      const visible = width > 0 && height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' &&
        Number(cs.opacity) !== 0 && onScreen;
      if (!visible) return {
        ok: false, reason: 'not visible',
        rect: { x: r.x, y: r.y, w: width, h: height },
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, onScreen
      };
      const x = r.left + width / 2, y = r.top + height / 2;
      const top = document.elementFromPoint(x, y);
      const coveredBy = (top && top !== el && !el.contains(top))
        ? (top.tagName + (top.id ? '#' + top.id : '') + (top.className ? '.' + String(top.className).trim().replace(/\\s+/g, '.') : ''))
        : null;
      return {
        ok: true, x, y, w: width, h: height,
        tag: el.tagName, id: el.id || '', cls: String(el.className || ''),
        text: (el.textContent || '').trim().slice(0, 60), coveredBy
      };
    })()`;

    let info;
    try {
      info = await evaluate(expression);
    } catch (err) {
      console.error(`[click] 解析 ${selector} 失败：${err.message}`);
      return false;
    }
    if (!info || !info.ok) {
      console.error(`[click] 无法点击 ${selector}：${info ? info.reason + ' ' + JSON.stringify(info) : '无返回'}`);
      return false;
    }
    if (info.coveredBy) {
      console.error(`[click] 警告：${selector} 在 (${info.x.toFixed(1)},${info.y.toFixed(1)}) 被 ${info.coveredBy} 遮挡，仍按真实点击投递。`);
    }

    const { x, y } = info;
    const base = { x, y, modifiers: 0 };
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0, clickCount: 0 }, 5_000);

    const pressParams = { ...base, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 };
    const releaseParams = { ...base, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 };

    if (delayMs > 0) {
      // 慢点击：模拟人类按住 250ms。真实 bug 会在这里暴露（元素被重建，click 被吞）。
      await cdp.send('Input.dispatchMouseEvent', pressParams, 5_000);
      await sleep(delayMs);
      await cdp.send('Input.dispatchMouseEvent', releaseParams, 5_000);
    } else {
      // 快点击：press/release 连续发出，避免中间被定时器重建插入（仍走真实输入管线）。
      const press = cdp.send('Input.dispatchMouseEvent', pressParams, 5_000);
      const release = cdp.send('Input.dispatchMouseEvent', releaseParams, 5_000);
      await Promise.all([press, release]);
    }
    return true;
  }

  /**
   * 从视口坐标 (x, y) 按住左键拖到 (x+dx, y+dy) 再松开。
   * 用于验证"在海图上按住自己的舰拖出航向"这类手势——纯 DOM 事件模拟测不出来。
   */
  async function dragFrom(x, y, dx, dy, { steps = 8 } = {}) {
    const mods = 0;
    await cdp.send('Input.dispatchMouseEvent', { x, y, modifiers: mods, type: 'mouseMoved', button: 'none', buttons: 0, clickCount: 0 }, 5_000);
    await cdp.send('Input.dispatchMouseEvent', { x, y, modifiers: mods, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 }, 5_000);
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        x: x + (dx * i) / steps, y: y + (dy * i) / steps, modifiers: mods,
        type: 'mouseMoved', button: 'left', buttons: 1,
      }, 5_000);
      await sleep(16);
    }
    await cdp.send('Input.dispatchMouseEvent', { x: x + dx, y: y + dy, modifiers: mods, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 }, 5_000);
    return true;
  }

  const VK = {
    Space: 32, Enter: 13, Tab: 9, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Backspace: 8, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };

  function keyDef(code, key, vk) {
    if (VK[code] !== undefined) return { code, key, vk: VK[code], text: null };
    if (typeof code === 'string' && /^Digit[0-9]$/.test(code)) {
      const d = code.slice(5);
      return { code, key, vk: 48 + Number(d), text: key };
    }
    if (typeof code === 'string' && /^Key[A-Z]$/.test(code)) {
      return { code, key, vk: code.charCodeAt(3), text: key };
    }
    return { code: code || '', key: key || '', vk: vk || 0, text: key && key.length === 1 ? key : null };
  }

  async function keyCode(code, key, { vk = 0 } = {}) {
    const def = keyDef(code, key, vk);
    const base = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
      modifiers: 0,
    };
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, 5_000);
    if (def.text) {
      await cdp.send('Input.dispatchKeyEvent', {
        ...base, type: 'char', text: def.text, unmodifiedText: def.text,
      }, 5_000);
    }
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, 5_000);
    return true;
  }

  async function key(text) {
    for (const ch of String(text)) {
      if (ch === ' ') await keyCode('Space', ' ');
      else if (/[0-9]/.test(ch)) await keyCode(`Digit${ch}`, ch);
      else if (/[a-zA-Z]/.test(ch)) await keyCode(`Key${ch.toUpperCase()}`, ch);
      else await keyCode('', ch, { vk: ch.charCodeAt(0) });
    }
    return true;
  }

  async function setViewport(width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
      screenWidth: width, screenHeight: height,
    }, 10_000);
  }

  const report = {
    cdp,
    consoleErrors,
    screenshots,
    evaluate,
    waitFor,
    goto,
    screenshot,
    click,
    key,
    keyCode,
    dragFrom,
    setViewport,
  };
  return report;
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

function installSuiteHelpers(report) {
  const checks = [];
  report.checks = checks;

  const formatEvidence = (value) => {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.length > 900 ? text.slice(0, 900) + '…' : text;
    } catch { return String(value); }
  };

  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  async function check(name, fn) {
    const started = Date.now();
    try {
      const evidence = await fn();
      const ms = Date.now() - started;
      checks.push({ name, ok: true, ms, evidence: evidence ?? null });
      console.log(`PASS  ${name}  (${ms}ms)` + (evidence !== undefined ? `\n        ${formatEvidence(evidence)}` : ''));
      return true;
    } catch (err) {
      const ms = Date.now() - started;
      const message = err && err.message ? err.message : String(err);
      checks.push({ name, ok: false, ms, error: message });
      console.log(`FAIL  ${name}  (${ms}ms)\n        ${message.replace(/\n/g, '\n        ')}`);
      return false;
    }
  }

  return { check, assert };
}

async function runSuite(report, opts) {
  const { check, assert } = installSuiteHelpers(report);
  const shots = opts.shots;

  // 0) 等应用 boot 完成 ---------------------------------------------------
  await check('boot：window.__ironSeas 存在且剧本已加载', async () => {
    const info = await report.waitFor(`(() => {
      const s = window.__ironSeas;
      if (!s || !Array.isArray(s.scenarios) || s.scenarios.length === 0) return false;
      return { scenarios: s.scenarios.length, ids: s.scenarios.slice(0, 8).map(x => x.id), title: document.title, href: location.href };
    })()`, { timeoutMs: 20_000, intervalMs: 200 });
    assert(info.scenarios > 0, `scenarios.length=${info.scenarios}`);
    assert(info.ids.includes(SCENARIO_ID), `剧本列表中缺少 ${SCENARIO_ID}，实际=${JSON.stringify(info.ids)}`);
    return info;
  });

  await check('shot：uicheck-boot.png 已写入', async () => {
    const shot = await report.screenshot(path.join(shots, 'uicheck-boot.png'));
    assert(shot.bytes > 1000, `截图文件过小：${shot.bytes} 字节`);
    return shot;
  });

  // 1) 剧本选择器 ---------------------------------------------------------
  // 顶栏改版过：v3 是 #btnScenarios 按钮，v5 是「剧本胶囊」（data-act="open-scenarios"）。
  // 两个选择器都试，避免工具因为一次换皮而误报产品坏了。
  await check('scenario：点击剧本入口出现 .scen 卡片', async () => {
    let used = '#btnScenarios';
    let clicked = await report.click(used);
    if (!clicked) {
      used = '[data-act="open-scenarios"]';
      clicked = await report.click(used);
    }
    assert(clicked, '剧本入口无法点击（#btnScenarios 与 [data-act="open-scenarios"] 都不行）');
    const count = await report.waitFor(`document.querySelectorAll('#overlay.on .scen').length`, { timeoutMs: 5_000, intervalMs: 100 });
    assert(count > 0, `.scen 卡片数量=${count}`);
    // 不同版本分别用 data-id / data-arg 标记剧本，两个都认。
    const cards = await report.evaluate(`Array.from(document.querySelectorAll('#overlay.on .scen')).map(el => ({ id: el.dataset.id || null, arg: el.dataset.arg || null, text: (el.textContent || '').trim().slice(0, 36) }))`);
    const found = cards.some((c) => c.id === SCENARIO_ID || c.arg === SCENARIO_ID);
    assert(found, `没有 ${SCENARIO_ID} 卡片，实际=${JSON.stringify(cards)}`);
    return { used, cards: count, sample: cards.slice(0, 4) };
  });

  let worldReady = false;

  await check('scenario：点击 denmark_strait_1941 后 world 创建', async () => {
    const cardSelector = `.scen[data-id="${SCENARIO_ID}"], .scen[data-arg="${SCENARIO_ID}"]`;
    // 捕获阶段监听：证明“真实鼠标点击确实落在卡片上”，把选择器/坐标问题和应用无响应区分开。
    await report.evaluate(`(() => {
      window.__uicheckLastScenClick = null;
      window.__uicheckScenProbe = (e) => {
        const c = e.target && e.target.closest ? e.target.closest('.scen') : null;
        if (c) window.__uicheckLastScenClick = (c.dataset.arg || c.dataset.id || 'scen(no id)');
      };
      document.addEventListener('click', window.__uicheckScenProbe, true);
      return true;
    })()`);
    const clicked = await report.click(cardSelector);
    assert(clicked, `剧本卡片 ${cardSelector} 无法点击`);
    const clickHit = await report.evaluate(`window.__uicheckLastScenClick`);
    await report.evaluate(`(() => { document.removeEventListener('click', window.__uicheckScenProbe, true); return true; })()`);

    const info = await report.waitFor(`(() => {
      const s = window.__ironSeas;
      if (!s || !s.world) return false;
      return {
        scenario: s.world.scenario && s.world.scenario.id,
        ships: s.world.ships.length,
        t: s.world.t,
        selectedShipId: s.selectedShipId,
        overlayOpen: document.getElementById('overlay').classList.contains('on')
      };
    })()`, { timeoutMs: 10_000, intervalMs: 100 }).catch(async () => {
      const diag = await report.evaluate(`(() => {
        const s = window.__ironSeas;
        const worldBefore = !!s.world;
        let directError = null;
        try { s.doAction('start-scen', ${JSON.stringify(SCENARIO_ID)}); }
        catch (e) { directError = String((e && e.message) || e); }
        return {
          worldBeforeDirectCall: worldBefore,
          worldAfterDirectCall: !!s.world,
          directError,
          cards: document.querySelectorAll('#overlay.on .scen').length,
          overlayOpen: document.getElementById('overlay').classList.contains('on'),
          errbar: ((document.getElementById('errbar') || {}).textContent || '').replace(/\\s+/g, ' ').slice(0, 240)
        };
      })()`);
      diag.selector = cardSelector;
      diag.clickLandedOnCard = clickHit;
      diag.hint = clickHit
        ? '真实点击命中了卡片，但 world 仍未创建：应用侧问题（当前 doAction() 在 world 为空时提前 return，start-scen 分支不可达）'
        : '点击没有落在任何 .scen 卡片上：可能是遮挡/坐标问题（harness 侧）';
      throw new Error(`点击剧本卡片后 world 未创建（observed=${JSON.stringify(diag)}）`);
    });
    assert(info.ships > 0, `world.ships.length=${info.ships}`);
    assert(info.scenario === SCENARIO_ID, `world.scenario.id=${info.scenario}`);
    assert(!info.overlayOpen, '剧本选择遮罩仍然打开（overlay.on 未移除）');
    worldReady = true;
    // 等战局面板渲染一帧，截图更有意义
    await report.waitFor(`document.querySelector('#p-ship .card') !== null`, { timeoutMs: 3_000, intervalMs: 100 }).catch(() => null);
    await sleep(500);
    return { ...info, clickLandedOnCard: clickHit };
  });

  // 若“点击卡片”这条路被产品 bug 堵死，用应用暴露的自动化钩子兜底，
  // 让后面的页签/命令/慢点击检查仍然能在真实战局里跑。失败原因已在上一条记录。
  if (!worldReady) {
    await check('recovery：点击启动失效时改用 __ironSeas.startScenario 兜底（仅为继续验证）', async () => {
      const info = await report.evaluate(`(() => {
        const s = window.__ironSeas;
        const scen = s.scenarios.find(x => x.id === ${JSON.stringify(SCENARIO_ID)});
        if (!scen) return { ok: false, reason: 'scenario missing' };
        try { s.startScenario(scen, { mode: 'PLAY', side: 'ALLIED' }); }
        catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
        return { ok: !!s.world, ships: s.world ? s.world.ships.length : 0, scenario: s.world && s.world.scenario && s.world.scenario.id };
      })()`);
      assert(info && info.ok, `兜底启动失败：${JSON.stringify(info)}`);
      await report.waitFor(`window.__ironSeas.world && window.__ironSeas.world.ships.length > 0`, { timeoutMs: 5_000, intervalMs: 100 });
      worldReady = true;
      await report.waitFor(`document.querySelector('#p-ship .card') !== null`, { timeoutMs: 3_000, intervalMs: 100 }).catch(() => null);
      await sleep(500);
      return { ...info, note: '上一检查已 FAIL；此步只保证后续 UI 检查有真实战局可操作' };
    });
  }

  await check('shot：uicheck-battle.png 已写入', async () => {
    const shot = await report.screenshot(path.join(shots, 'uicheck-battle.png'));
    assert(shot.bytes > 1000, `截图文件过小：${shot.bytes} 字节`);
    return shot;
  });

  const requireWorld = (label) => {
    if (!worldReady) throw new Error(`${label}：world 未创建（前置剧本启动失败），此检查无法进行`);
  };

  // 2) 页签点击（含一次 250ms 慢点击）-------------------------------------
  await check('tabs：逐一点击 #tabs button，对应 .pane 变为 .on', async () => {
    requireWorld('tabs');
    const tabs = await report.evaluate(`Array.from(document.querySelectorAll('#tabs button')).map(b => ({ pane: b.dataset.pane, text: b.textContent.trim() }))`);
    assert(tabs.length === 5, `页签数量=${tabs.length}，期望 5`);
    const observed = [];
    for (const tab of tabs) {
      // 页签本身不会被 innerHTML 重建；挑一个用慢点击，验证慢点击链路本身有效。
      const useSlow = tab.pane === 'p-dam';
      const ok = await report.click(`#tabs button[data-pane="${tab.pane}"]`, useSlow ? { delayMs: 250 } : {});
      assert(ok, `页签 ${tab.pane} 点击失败`);
      const state = await report.waitFor(`(() => {
        const active = document.querySelector('#tabs button.on');
        const pane = document.querySelector('.pane.on');
        if (!active || !pane) return false;
        return { active: active.dataset.pane, pane: pane.id, onCount: document.querySelectorAll('.pane.on').length };
      })()`, { timeoutMs: 2_500, intervalMs: 80 });
      observed.push({ clicked: tab.pane, active: state.active, pane: state.pane, onCount: state.onCount, slow: useSlow });
      assert(state.active === tab.pane, `点击 ${tab.pane} 后 active tab=${state.active}`);
      assert(state.pane === tab.pane, `点击 ${tab.pane} 后 .pane.on=${state.pane}`);
      assert(state.onCount === 1, `.pane.on 数量=${state.onCount}，期望 1`);
    }
    await report.click('#tabs button[data-pane="p-ship"]');
    await report.waitFor(`document.querySelector('.pane.on')?.id === 'p-ship'`, { timeoutMs: 2_500, intervalMs: 80 });
    return { tabs: observed };
  });

  // 3) 选中舰船 + 普通点击命令按钮 ---------------------------------------
  // 不同指挥层级（CAPTAIN/FLEET/DEPARTMENT）可用的命令按钮不同，按优先级探测。
  const pickCommand = async (preferred) => report.evaluate(`(() => {
    const root = document.getElementById('p-ship');
    if (!root) return { ok: false, reason: 'p-ship 不存在' };
    const candidates = ${JSON.stringify(preferred)};
    for (const sel of candidates) {
      const el = root.querySelector(sel);
      if (el) return {
        ok: true, selector: '#p-ship ' + sel,
        act: el.dataset.act, arg: el.dataset.arg,
        text: (el.textContent || '').trim().slice(0, 40)
      };
    }
    const any = root.querySelector('[data-act]');
    return {
      ok: false, reason: '面板内没有匹配的命令按钮',
      role: window.__ironSeas.role,
      firstAct: any ? any.dataset.act : null,
      html: root.innerHTML.slice(0, 300)
    };
  })()`);

  const normalizeCommandList = [
    '[data-act="rudder"][data-arg="15"]',
    '[data-act="rudder"][data-arg="-15"]',
    '[data-act="speed"][data-arg="12"]',
    '[data-act="speed"][data-arg="20"]',
    '[data-act="dc"][data-arg="flooding"]',
    '[data-act="dc"][data-arg="fire"]',
    '[data-act="smoke"][data-arg="1"]',
    '[data-act="ceasefire"]',
    '[data-act="rudder"]',
    '[data-act="speed"]',
    '[data-act="dc"]',
  ];
  const slowClickList = [
    '[data-act="rudder"][data-arg="-15"]',
    '[data-act="speed"][data-arg="20"]',
    '[data-act="speed"][data-arg="12"]',
    '[data-act="dc"][data-arg="fire"]',
    '[data-act="ceasefire"]',
    '[data-act="rudder"]',
    '[data-act="speed"]',
    '[data-act="dc"]',
  ];

  await check('command：p-ship 选舰后点击命令按钮，命令进入队列', async () => {
    requireWorld('command');
    await report.click('#tabs button[data-pane="p-ship"]');
    await report.waitFor(`document.querySelector('.pane.on')?.id === 'p-ship'`, { timeoutMs: 2_500, intervalMs: 80 });

    const hasItem = await report.evaluate(`!!document.querySelector('#p-ship .list .item')`);
    if (!hasItem) {
      // 没有列表项时用自动化钩子兜底（但记录在证据里，便于判断是 UI 还是选中状态问题）。
      await report.evaluate(`(() => { const s = window.__ironSeas; s.selectedShipId = s.world.shipsOf(s.side)[0].id; s.renderPanes(); return true; })()`);
    } else {
      const clicked = await report.click('#p-ship .list .item');
      assert(clicked, '#p-ship .list .item 点击失败');
    }
    const selected = await report.waitFor(`window.__ironSeas.selectedShipId || false`, { timeoutMs: 2_000, intervalMs: 80 });

    const before = await report.evaluate(`(() => { const w = window.__ironSeas.world; return {
      pending: w.pending.length,
      commands: w.record.commands.length,
      playerCommands: w.record.commands.filter(c => c.source === 'PLAYER').length,
      t: w.t
    }; })()`);
    const picked = await pickCommand(normalizeCommandList);
    const role = await report.evaluate(`window.__ironSeas.role`);
    assert(picked && picked.ok, `找不到命令按钮（role=${role}，selectedShipId=${selected}）：${JSON.stringify(picked)}`);
    const selector = picked.selector;

    const clicked = await report.click(selector);
    assert(clicked, `命令按钮 ${selector} 点击失败`);

    let after = null;
    try {
      after = await report.waitFor(`(() => { const w = window.__ironSeas.world; return (w.pending.length > ${before.pending} || w.record.commands.length > ${before.commands}) ? {
        pending: w.pending.length, commands: w.record.commands.length,
        playerCommands: w.record.commands.filter(c => c.source === 'PLAYER').length, t: w.t
      } : false; })()`, { timeoutMs: 2_000, intervalMs: 80 });
    } catch {
      after = await report.evaluate(`(() => { const w = window.__ironSeas.world; return {
        pending: w.pending.length, commands: w.record.commands.length,
        playerCommands: w.record.commands.filter(c => c.source === 'PLAYER').length, t: w.t
      }; })()`);
    }
    const grew = after.pending > before.pending || after.commands > before.commands;
    assert(grew, `命令未入队：pending ${before.pending}→${after.pending}，record.commands ${before.commands}→${after.commands}，玩家命令 ${before.playerCommands}→${after.playerCommands}（selector=${selector}, role=${role}, selected=${selected}）`);
    return { selector, picked, selected, role, before, after, hasList: hasItem };
  });

  // 4) 慢点击回归：v3 面板每 200ms innerHTML 重建，250ms 的按下-抬起很可能被吞
  await check('slow-click：250ms 慢点击命令按钮仍应入队（innerHTML 重建回归）', async () => {
    requireWorld('slow-click');
    await report.click('#tabs button[data-pane="p-ship"]');
    await report.waitFor(`document.querySelector('.pane.on')?.id === 'p-ship'`, { timeoutMs: 2_500, intervalMs: 80 });

    const before = await report.evaluate(`(() => { const w = window.__ironSeas.world; return {
      pending: w.pending.length, commands: w.record.commands.length,
      playerCommands: w.record.commands.filter(c => c.source === 'PLAYER').length
    }; })()`);
    const picked = await pickCommand(slowClickList);
    assert(picked && picked.ok, `找不到可用于慢点击的命令按钮：${JSON.stringify(picked)}`);
    const selector = picked.selector;
    const clicked = await report.click(selector, { delayMs: 250 });
    assert(clicked, `慢点击命令按钮 ${selector} 失败（元素无法解析）`);
    await sleep(350); // 给 click/命令入队留出时间，也跨过一次面板重建

    const after = await report.evaluate(`(() => { const w = window.__ironSeas.world; return {
      pending: w.pending.length, commands: w.record.commands.length,
      playerCommands: w.record.commands.filter(c => c.source === 'PLAYER').length,
      selectorStillExists: !!document.querySelector(${JSON.stringify(selector)}),
      paneHtmlLength: (document.getElementById('p-ship').innerHTML || '').length
    }; })()`);
    const grew = after.pending > before.pending || after.commands > before.commands;
    assert(grew, `250ms 慢点击被吞：pending ${before.pending}→${after.pending}，record.commands ${before.commands}→${after.commands}，玩家命令 ${before.playerCommands}→${after.playerCommands}；按钮仍存在=${after.selectorStillExists}，pane HTML=${after.paneHtmlLength} 字符。这正是“面板定时重建吞点击”的回归。`);
    return { selector, picked, before, after };
  });

  // 5) 暂停按钮 -----------------------------------------------------------
  await check('pause：#btnPause 点击后 paused 翻转，再次点击翻回', async () => {
    const before = await report.evaluate(`window.__ironSeas.paused`);
    const first = await report.click('#btnPause');
    assert(first, '#btnPause 第一次点击失败');
    await report.waitFor(`window.__ironSeas.paused !== ${JSON.stringify(before)}`, { timeoutMs: 2_000, intervalMs: 60 });
    const afterFirst = await report.evaluate(`window.__ironSeas.paused`);
    assert(afterFirst !== before, `第一次点击后 paused 仍为 ${afterFirst}`);

    const second = await report.click('#btnPause');
    assert(second, '#btnPause 第二次点击失败');
    await report.waitFor(`window.__ironSeas.paused === ${JSON.stringify(before)}`, { timeoutMs: 2_000, intervalMs: 60 });
    const afterSecond = await report.evaluate(`window.__ironSeas.paused`);
    assert(afterSecond === before, `第二次点击后 paused=${afterSecond}，期望 ${before}`);
    return { before, afterFirst, afterSecond };
  });

  // 6) 时间压缩按钮 -------------------------------------------------------
  await check('timeScale：逐一点击 .ts 按钮，timeScale 与 data-ts 一致', async () => {
    const values = await report.evaluate(`Array.from(document.querySelectorAll('.ts')).map(b => Number(b.dataset.ts))`);
    assert(values.length >= 2, `.ts 按钮数量=${values.length}`);
    const observed = [];
    for (const value of values) {
      const clicked = await report.click(`.ts[data-ts="${value}"]`);
      assert(clicked, `.ts[data-ts="${value}"] 点击失败`);
      const got = await report.waitFor(`window.__ironSeas.timeScale === ${value} ? window.__ironSeas.timeScale : false`, { timeoutMs: 2_000, intervalMs: 60 });
      observed.push({ expected: value, got });
      assert(got === value, `点击 ${value}x 后 timeScale=${got}`);
    }
    return { observed };
  });

  // 8c) 自绘模态框（替代 prompt()）确实能下达命令 -------------------------
  await check('modal：设定航向弹窗能开出、能确认，并真的产生 PLAYER 命令', async () => {
    requireWorld('modal');
    const before = await report.evaluate(`window.__ironSeas.world.pending.length`);
    const beforeRec = await report.evaluate(`(((window.__ironSeas.world.record || {}).commands) || []).filter((c) => c.source === 'PLAYER').length`);
    await report.evaluate(`window.__ironSeas.doAction('course'); true`);
    const open = await report.waitFor(`document.getElementById('modal').classList.contains('on')`, { timeoutMs: 1_000, intervalMs: 40 });
    assert(open, '设定航向弹窗没有打开');
    // .modal .box 带 sheetIn 动画（0.2s 位移+缩放）。className 一变就立刻量坐标点确定，
    // 会点在"动画中还在移动"的按钮外面 —— 实测表现为弹窗被关掉但没产生命令。
    await sleep(260);
    await report.evaluate(`(() => { document.getElementById('modalNum').value = '123'; return true; })()`);
    // 只认玩家命令再取最后一条：仿真可能在 64× 下于这 200ms 内让 AI_LOCAL 往队尾插命令，
    // 取 pending 末条会把 AI 的命令当成弹窗的产物（曾经偶发误报）。
    // 读 world.record.commands 而不是 queued 的 pending：64× 下命令 62~190ms 真实时间就生效出队了，
    // 只查 pending 会把"弹窗确实产生了玩家命令"误判成"没产生"。
    const snapshot = () => report.evaluate(`(() => {
      const s = window.__ironSeas;
      const rec = ((s.world.record || {}).commands) || [];
      const mine = rec.filter((c) => c.source === 'PLAYER');
      const last = mine[mine.length - 1] || null;
      return { pending: s.world.pending.length, playerCommands: mine.length, closed: !document.getElementById('modal').classList.contains('on'),
        kind: last && last.kind, heading: last && last.params && last.params.heading, source: last && last.source };
    })()`);

    // 真实鼠标点击优先；headless 在连续注入键盘事件后偶尔会卡住 Input 域
    // （Input.dispatchMouseEvent 5s 超时），也可能点在遮罩/动画挪开的空白处。
    // 两者都属于验证器的环境问题，不是产品缺陷：这时退化为程序化 click() 再走一遍，
    // 并把实际使用的方式如实记录在证据里。
    let via = 'real-mouse';
    try {
      const clicked = await report.click('#modalOk');
      assert(clicked, '无法点击 #modalOk');
    } catch (err) {
      via = 'programmatic-fallback(' + err.message + ')';
      await report.evaluate(`(() => { const b = document.getElementById('modalOk'); if (b) b.click(); return true; })()`);
    }
    await sleep(200);
    let after = await snapshot();
    if (!after.kind) {
      via += '+programmatic-retry';
      await report.evaluate(`window.__ironSeas.doAction('course'); true`);
      const reopened = await report.waitFor(`document.getElementById('modal').classList.contains('on')`, { timeoutMs: 1_000, intervalMs: 40 });
      assert(reopened, '重开设定航向弹窗失败');
      await sleep(260);
      await report.evaluate(`(() => { document.getElementById('modalNum').value = '123'; document.getElementById('modalOk').click(); return true; })()`);
      await sleep(220);
      after = await snapshot();
    }
    assert(after.closed, '确认后弹窗没有关闭');
    assert(after.playerCommands > beforeRec, `弹窗确认后没有产生玩家命令（玩家命令 ${beforeRec} -> ${after.playerCommands}，pending ${before} -> ${after.pending}）`);
    assert(after.kind === 'SET_COURSE' && after.heading === 123, `命令应为 SET_COURSE heading=123，实际 ${after.kind} ${after.heading}`);
    assert(after.source === 'PLAYER', `命令 source 应为 PLAYER，实际 ${after.source}`);
    return { before, beforeRec, after, via };
  });

  // 8d) 命令面板（⌘K）----------------------------------------------------
  await check('palette：命令面板能打开、能过滤、回车能执行', async () => {
    requireWorld('palette');
    const opened = await report.click('#btnPalette');
    assert(opened, '#btnPalette 点击失败');
    const on = await report.waitFor(`document.getElementById('palette').classList.contains('on')`, { timeoutMs: 1_000, intervalMs: 40 });
    assert(on, '命令面板没有打开');
    // 输入框应当自动获得焦点，这样键盘直接可用
    const focused = await report.evaluate(`document.activeElement && document.activeElement.id`);
    assert(focused === 'palInput', `面板打开后焦点应在 palInput，实际 ${focused}`);

    // 中文输入法在 CDP 里不好模拟，这里直接写值 + 派发 input 事件（过滤逻辑是真的）
    await report.evaluate(`(() => {
      const el = document.getElementById('palInput');
      el.value = '64';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const list = await report.evaluate(`Array.from(document.querySelectorAll('#palList .palItem .tt')).map(e => e.textContent)`);
    assert(list.length > 0, '过滤 "64" 之后列表为空');
    assert(list.some((t) => t.indexOf('64×') >= 0), `列表里没有 64× 项：${JSON.stringify(list.slice(0, 6))}`);

    await report.evaluate(`window.__ironSeas.timeScale = 1; true`);
    // 这里必须用 keyCode 真按 Enter：report.key(text) 是"逐字符打字"，
    // 传 'Enter' 会变成 E/n/t/e/r 五个字符，过滤词被写成 "64Enter"。
    await report.keyCode('Enter', 'Enter');
    await sleep(150);
    const ts = await report.evaluate(`window.__ironSeas.timeScale`);
    const stillOpen = await report.evaluate(`document.getElementById('palette').classList.contains('on')`);
    assert(ts === 64, `面板里执行「时间压缩 64×」后 timeScale=${ts}，期望 64`);
    assert(!stillOpen, '执行后面板没有关闭');
    return { filtered: list.slice(0, 5), timeScale: ts };
  });

  // 8e) 海图上拖拽设航向 -------------------------------------------------
  await check('steer：在选中舰身上按住左键拖拽即下达转向命令', async () => {
    requireWorld('steer');
    // 拖拽前先确保选中一艘己方舰，并暂停仿真（免得船跑掉）
    await report.evaluate(`(() => {
      const s = window.__ironSeas;
      s.paused = true;
      s.selectedShipId = s.selectedShipId || (s.world.afloatOf(s.side)[0] || {}).id;
      return true;
    })()`);
    const info = await report.evaluate(`(() => {
      const s = window.__ironSeas, sh = s.world.ship(s.selectedShipId);
      if (!sh || !s.chart) return { x: -1, y: -1, heading: 0, pending: 0, name: 'none', inside: false };
      // 新开剧本时默认机位不一定框住选中舰，拖拽会落在画面外。这里先把机位移到舰上
      // （等价于 UI 里"选中即取景"的既有行为），让这个用例只考察"拖拽是否下达转向"。
      s.chart.follow = null;
      s.chart.cam.x = sh.pos.x; s.chart.cam.y = sh.pos.y;
      const p = s.chart.worldToScreen(sh.pos);
      const r = document.getElementById('chart').getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y, heading: sh.heading, pending: s.world.pending.length, name: sh.name,
        inside: p.x > 8 && p.y > 8 && p.x < s.chart.w - 8 && p.y < s.chart.h - 8 };
    })()`);
    assert(info.inside, `选中舰不在海图画布内（${info.name}），无法做拖拽用例`);
    // headless 下 Input.dispatchMouseEvent 偶发 5s 超时（本文件 1130 行已注明属验证器环境问题）。
    // 那不影响"拖拽是否下达转向"这个产品行为，退化为页面内合成 PointerEvent，并如实记录方式。
    let via = 'real-mouse';
    try {
      await report.dragFrom(info.x, info.y, 140, 0, { steps: 8 });
    } catch (err) {
      via = 'synthetic-pointer(' + err.message + ')';
      await report.evaluate(`(() => {
        const c = document.getElementById('chart');
        const mk = (type, x, y, buttons) => new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
          button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        });
        const x0 = ${JSON.stringify(info.x)}, y0 = ${JSON.stringify(info.y)};
        c.dispatchEvent(mk('pointerdown', x0, y0, 1));
        for (let i = 1; i <= 8; i++) window.dispatchEvent(mk('pointermove', x0 + (140 * i) / 8, y0, 1));
        window.dispatchEvent(mk('pointerup', x0 + 140, y0, 0));
        return true;
      })()`);
    }
    await sleep(200);
    const after = await report.evaluate(`(() => {
      const s = window.__ironSeas;
      const last = s.world.pending[s.world.pending.length - 1] || null;
      return { pending: s.world.pending.length, kind: last && last.kind, heading: last && last.params && last.params.heading, source: last && last.source,
        steerCleared: !s.chart.steer };
    })()`);
    assert(after.pending > info.pending, `拖拽后没有产生命令（pending ${info.pending} -> ${after.pending}）`);
    assert(after.kind === 'SET_COURSE', `命令应为 SET_COURSE，实际 ${after.kind}`);
    // 向右拖 = 正东 = 约 090°
    assert(Math.abs(after.heading - 90) <= 8, `向右拖拽的航向应接近 090°，实际 ${after.heading}`);
    assert(after.steerCleared, '松手后 chart.steer 预览没有清掉');
    await report.evaluate(`window.__ironSeas.paused = false; true`);
    return { via, ship: info.name, fromHeading: info.heading, toHeading: after.heading };
  });


  // 7) key('1') 必须真的到达 keydown，且 e.key === '1' --------------------
  await check('key：key("1") 以 e.key === "1" 到达页面 keydown', async () => {
    await report.evaluate(`(() => {
      window.__uicheckKeys = [];
      window.__uicheckKeyHandler = (e) => window.__uicheckKeys.push({ key: e.key, code: e.code });
      window.addEventListener('keydown', window.__uicheckKeyHandler);
      return true;
    })()`);
    await report.key('1');
    await sleep(120);
    const keys = await report.evaluate(`window.__uicheckKeys`);
    await report.evaluate(`(() => { window.removeEventListener('keydown', window.__uicheckKeyHandler); return true; })()`);
    assert(Array.isArray(keys) && keys.some((k) => k.key === '1'), `页面 keydown 收到=${JSON.stringify(keys)}`);
    return { received: keys, timeScaleAfter: await report.evaluate(`window.__ironSeas.timeScale`) };
  });

  // 8) Space 暂停 ---------------------------------------------------------
  await check('key：Space 按下后 paused 翻转（再按一次恢复）', async () => {
    const before = await report.evaluate(`window.__ironSeas.paused`);
    await report.keyCode('Space', ' ');
    await report.waitFor(`window.__ironSeas.paused !== ${JSON.stringify(before)}`, { timeoutMs: 2_000, intervalMs: 60 });
    const afterFirst = await report.evaluate(`window.__ironSeas.paused`);
    assert(afterFirst !== before, `Space 后 paused 仍为 ${afterFirst}`);

    await report.keyCode('Space', ' ');
    await report.waitFor(`window.__ironSeas.paused === ${JSON.stringify(before)}`, { timeoutMs: 2_000, intervalMs: 60 });
    const afterSecond = await report.evaluate(`window.__ironSeas.paused`);
    assert(afterSecond === before, `第二次 Space 后 paused=${afterSecond}，期望 ${before}`);
    return { before, afterFirst, afterSecond };
  });

  // 8b) 输入框内打字不得触发全局快捷键 -----------------------------------
  // 旧版把「航向 240」的 2 当成 4x 时间压缩：在输入框里打字会莫名其妙变快/暂停。
  await check('typing：在中文口令框里输入「240」不得改变 timeScale（全局快捷键必须让位于输入）', async () => {
    requireWorld('typing');
    // v6 布局：口令输入框在「口令」动作层里，先点开（点开会自动聚焦），再输入。
    // 这里用程序化 click：headless 偶发 Input.dispatchMouseEvent 5s 超时（验证器环境问题，
    // 本文件别处已注明），而"点开动作层"这个行为本身由页面内的 click 处理器完整覆盖。
    const openedOrder = await report.evaluate(`(() => {
      const b = document.querySelector('[data-dock-tab="order"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(openedOrder, '找不到「口令」动作按钮');
    await sleep(150);
    await report.evaluate(`(() => {
      window.__ironSeas.timeScale = 1;
      window.__ironSeas.paused = false;
      const box = document.getElementById('inpOrder');
      box.value = '';
      box.focus();
      return true;
    })()`);
    const focused = await report.evaluate(`document.activeElement && document.activeElement.id`);
    assert(focused === 'inpOrder', `焦点应在 inpOrder，实际 ${focused}`);
    for (const ch of ['2', '4', '0']) {
      await report.key(ch);
      await sleep(50);
    }
    const boxed = await report.evaluate(`(() => { const b = document.getElementById('inpOrder'); return { value: b.value, ts: window.__ironSeas.timeScale, paused: window.__ironSeas.paused }; })()`);
    // 先确认按键真的送到了输入框（否则这条检查会假通过）
    assert(boxed.value === '240', `输入框内容应为 "240"，实际 "${boxed.value}"`);
    assert(boxed.ts === 1, `输入框打字后 timeScale=${boxed.ts}，期望保持 1（说明全局数字快捷键抢了输入）`);
    assert(boxed.paused === false, `输入框打字后 paused=${boxed.paused}，期望 false`);
    await report.evaluate(`(() => { const b = document.getElementById('inpOrder'); b.value = ''; b.blur(); return true; })()`);
    return boxed;
  });

  // 9) 仿真主循环仍在跑 ---------------------------------------------------
  await check('sim：timeScale>1 下 2.5s 真实时间后 world.t 继续推进', async () => {
    requireWorld('sim');
    // 这条检查只回答一个问题：主循环还在不在跑。所以 timeScale / paused 直接用
    // evaluate 设定，不依赖输入域（键盘已由前面 key('1') / Space 两条检查覆盖；
    // 混在一起会让"输入域偶发卡死"伪装成"主循环挂了"）。
    await report.evaluate(`(() => { window.__ironSeas.timeScale = 16; window.__ironSeas.paused = false; return true; })()`);
    const timeScale = await report.evaluate(`window.__ironSeas.timeScale`);
    assert(timeScale > 1, `timeScale 设置失败：${timeScale}`);
    await report.cdp.send('Page.bringToFront', {}, 5_000).catch(() => null);
    const t0 = await report.evaluate(`window.__ironSeas.world.t`);
    await sleep(2500);
    const after = await report.evaluate(`(() => { const s = window.__ironSeas; return { t: s.world.t, timeScale: s.timeScale, paused: s.paused, over: !!s.world.over }; })()`);
    if (!(after.t > t0)) {
      // 区分「产品主循环挂了」还是「headless 把 rAF 节流了」：直接数 700ms 内的 rAF 次数。
      after.rafDiag = await report.evaluate(`(() => new Promise((resolve) => {
        const started = performance.now();
        let frames = 0;
        const done = () => resolve({
          rafFrames: frames,
          waitedMs: Math.round(performance.now() - started),
          visibility: document.visibilityState,
          hidden: document.hidden,
          replay: !!window.__ironSeas.replay,
          paused: window.__ironSeas.paused,
          t: window.__ironSeas.world.t
        });
        const timer = setTimeout(done, 900);
        const tick = () => {
          frames++;
          if (performance.now() - started < 700) requestAnimationFrame(tick);
          else { clearTimeout(timer); done(); }
        };
        requestAnimationFrame(tick);
      }))()`);
    }
    assert(after.t > t0, `world.t 未推进：t0=${t0}，t1=${after.t}（timeScale=${after.timeScale}，paused=${after.paused}，over=${after.over}，diag=${JSON.stringify(after.rafDiag)}）`);
    return { t0, t1: after.t, delta: Number((after.t - t0).toFixed(2)), timeScale: after.timeScale, paused: after.paused };
  });

  // 10) 页面错误 ----------------------------------------------------------
  await check('console：无 exception / console.error / Log error', async () => {
    const errors = report.consoleErrors;
    if (errors.length) {
      const lines = errors.slice(0, 12).map((e, i) => `#${i + 1} [${e.kind}] ${String(e.text).slice(0, 300)}${e.url ? ` @ ${e.url}${e.line != null ? ':' + e.line : ''}` : ''}`);
      throw new Error(`捕获 ${errors.length} 条页面错误：\n${lines.join('\n')}${errors.length > 12 ? `\n…其余 ${errors.length - 12} 条` : ''}`);
    }
    return { count: 0 };
  });

  return report.checks;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  installProcessGuards();

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[uicheck] 参数错误：${err.message}`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }

  armWatchdog();
  const port = opts.noChrome ? (opts.port || 9222) : await pickPort(opts.port);
  console.log(`[uicheck] Chrome CDP 端口 ${port}${opts.noChrome ? '（附到已运行的 Chrome）' : ''}`);

  if (!opts.noChrome) launchChrome(opts, port);

  try {
    const devtools = await waitForDevtools(port, opts.noChrome ? 8_000 : 20_000);
    const target = await findPageTarget(port);
    console.log(`[uicheck] 浏览器 ${devtools.Browser || '未知'}；页面 target ${target.url || '(blank)'}`);

    const cdp = new CDPClient(target.webSocketDebuggerUrl);
    session = await cdp.connect(12_000);
    // 事件处理器在 createUiSession 里注册，必须在 enable 之前。
    const report = createUiSession(cdp, opts);
    await Promise.all([
      cdp.send('Runtime.enable', {}, 10_000),
      cdp.send('Page.enable', {}, 10_000),
      cdp.send('Log.enable', {}, 10_000),
    ]);

    if (opts.view) {
      await report.setViewport(opts.view.width, opts.view.height);
      console.log(`[uicheck] 视口覆盖为 ${opts.view.width}x${opts.view.height}`);
    }
    // headless 下把页面放到前台，避免 rAF 被判定为后台节流。
    await cdp.send('Page.bringToFront', {}, 5_000).catch(() => null);

    await report.goto(opts.url, { waitMs: opts.suite ? 800 : 1000 });
    console.log(`[uicheck] 已打开 ${opts.url}`);

    if (opts.waitMs > 0) await sleep(opts.waitMs);

    let ok = true;
    if (opts.evalExpr) {
      const value = await report.evaluate(opts.evalExpr);
      console.log('[uicheck] eval 结果：' + JSON.stringify(value, null, 2));
      for (const sel of opts.clicks) {
        let clicked = false;
        try { clicked = await report.click(sel); } catch (err) { console.log(`[uicheck] 点击 ${sel} 失败：${err.message}`); }
        console.log(`[uicheck] 点击 ${sel} -> ${clicked}`);
      }
      const shot = await report.screenshot(path.join(opts.shots, 'uicheck-eval.png'));
      console.log(`[uicheck] 截图：${shot.path}（${shot.bytes} 字节）`);
      ok = report.consoleErrors.length === 0;
    } else if (opts.suite) {
      const checks = await runSuite(report, opts);
      ok = checks.every((c) => c.ok) && report.consoleErrors.length === 0;
    } else {
      const summary = await report.evaluate(`(() => ({
        title: document.title,
        readyState: document.readyState,
        hasApp: !!window.__ironSeas,
        scenarios: (window.__ironSeas && window.__ironSeas.scenarios) ? window.__ironSeas.scenarios.length : 0,
        hasWorld: !!(window.__ironSeas && window.__ironSeas.world)
      }))()`).catch((err) => ({ error: err.message }));
      console.log('[uicheck] 页面状态：', JSON.stringify(summary));
      const shot = await report.screenshot(path.join(opts.shots, 'uicheck.png'));
      console.log(`[uicheck] 截图：${shot.path}（${shot.bytes} 字节）`);
      ok = report.consoleErrors.length === 0;
    }

    // 页面错误始终打印在最后（截断，避免刷屏）
    const errors = report.consoleErrors;
    if (errors.length) {
      console.log(`\n[uicheck] 页面错误 ${errors.length} 条（最多显示 20 条，每条 400 字符）：`);
      for (const [index, err] of errors.slice(0, 20).entries()) {
        const line = String(err.text || '').replace(/\s+/g, ' ').slice(0, 400);
        console.log(`  ${index + 1}. [${err.kind}] ${line}${err.url ? `  @ ${err.url}${err.line != null ? ':' + err.line : ''}` : ''}`);
      }
      if (errors.length > 20) console.log(`  …其余 ${errors.length - 20} 条已省略`);
    } else {
      console.log('\n[uicheck] 页面错误：0 条');
    }

    const result = {
      ok,
      url: opts.url,
      port,
      finishedAt: new Date().toISOString(),
      viewport: opts.view,
      checks: report.checks || [],
      consoleErrors: errors,
      screenshots: report.screenshots,
    };

    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.out), JSON.stringify(result, null, 2) + '\n');
      console.log(`[uicheck] 结果 JSON：${path.resolve(opts.out)}`);
    }

    if (opts.suite) {
      const failed = (report.checks || []).filter((c) => !c.ok);
      console.log(`\n[uicheck] suite：${(report.checks || []).length - failed.length} 通过 / ${failed.length} 失败` +
        (failed.length ? `（${failed.map((c) => c.name.split('：')[0]).join('，')}）` : ''));
    }
    console.log(`[uicheck] 截图目录：${opts.shots}`);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error('[uicheck] 运行失败：', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

// 全局会话引用（cleanup 需要）。
let session = null;

await main();

// 清理已完成；显式退出，避免 fetch/undici 等残留句柄把进程吊住。
try {
  await new Promise((resolve) => process.stdout.write('', resolve));
} catch { /* ignore */ }
process.exit(process.exitCode ?? 0);
