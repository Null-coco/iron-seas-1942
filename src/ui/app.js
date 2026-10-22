// ============================================================================
// 铁海 1942 — 应用主程序 v4
//
// 这一版修掉的「按钮点了没反应」根因（v3 的三个坑）：
//   1) 面板每 200ms 用 innerHTML 重整，按下与松开之间节点被替换 → click 丢失。
//      → 现在面板只在「结构签名」变化时重建，数值走 patchLive()，指针按下时绝不重建。
//   2) doAction() 里直接 `ship.id`，没有选中舰时抛 TypeError，被 window.onerror 吞掉。
//      → 现在有 ensureShip()：没有选中就自动落到旗舰，并给出明确提示。
//   3) 每个按钮各挂一个 onclick，面板一重建就得重挂。
//      → 现在全局只有一处委托监听（document 上的 click），节点怎么换都能命中。
//
// 另外修掉的「反人类」操作：
//   · prompt() 弹窗 → 自绘模态框（回车确认 / Esc 取消 / 数字校验）
//   · 输入框里打「240」，数字键 2 会触发 4× 时间压缩 → 输入时不响应全局快捷键
//   · 编队级命令只发给选中舰 → 现在展开到本方全部在航舰
//   · 没有选中舰时按钮静默失败 → 现在自动落到旗舰，并有回执提示
//   · 每条 AI 决策都弹提示条刷屏 → 只保留沉没/殉爆/胜负等真正重要的事件
//   · 日志过滤只对新行生效 → 现在保留事件并整表重放
// ============================================================================
import { World } from '../sim/world.js';
import { ShipDatabase } from '../sim/data.js';
import { ChartRenderer } from '../render/chart.js';
import { PANES, TYPE_ZH } from './panels.js';
import { esc } from './esc.js';
import { icon } from './icons.js';
import { LLM_PRESETS } from '../ai/bridge.js';
import { ReplayPlayer } from './replay.js';
import { buildAAR } from './aar.js';
import { parseOrderSmart } from '../ai/nl.js';
import { fmtClock, fmtClockHM, normDeg, bearing2d, NMI } from '../core/util.js';

const ROLE_ZH = { CAPTAIN: '舰长', FLEET: '编队指挥官', DEPARTMENT: '部门（CIC/损管/轮机）' };
const KIND_ZH = {
  SET_COURSE: '转向', SET_SPEED: '变速', SET_RUDDER: '用舵', FIRE: '开火', CEASE_FIRE: '停火',
  LAUNCH_TORPEDO: '雷击', ASSIGN_TARGET: '指定目标', SMOKE: '烟幕', RADAR: '雷达', SONAR: '声呐',
  SEARCHLIGHT: '探照灯', STAR_SHELL: '照明弹', DC_PRIORITY: '损管', DAMAGE_CONTROL: '损管',
  FLOOD_MAGAZINE: '弹药库注水', COUNTERFLOOD: '对称注水', PLUG: '堵漏', WITHDRAW: '撤退',
  FORMATION: '编队阵位', CHAFF: '箔条', CHAT: '通话', SET_SCREEN: '屏护阵位', PLOT_COURSE: '预定航向',
};
const COMMAND_ACTS = new Set(['speed', 'course', 'course-set', 'rudder', 'fire', 'ceasefire', 'torp',
  'smoke', 'radar', 'searchlight', 'dc', 'withdraw', 'chaff']);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function bootApp() {
  const $ = (id) => document.getElementById(id);
  const state = {
    db: null, scenarios: [], world: null, chart: null,
    side: 'ALLIED', role: 'CAPTAIN', mode: 'PLAY', spectate: false,
    timeScale: 1, paused: false,
    selectedShipId: null, selectedTrackId: null,
    cameraMode: 'FREE', dirTarget: null, dirHold: 0, pendingStart: null,
    replay: null, remote: null, agentUrl: null,
    cmdLog: [], logEntries: [], logFilter: 'all',
    forcedPaneId: null, panelSig: {}, keepChat: '', missionFolded: false,
    pointerDown: false, pointerGraceUntil: 0, lastPaneBuild: 0, lastPaneTick: 0,
  };

  const canvas = $('chart');
  const logEl = $('log');
  const clockEl = $('clock');

  // ============================================================ 错误面
  function reportError(msg) {
    let el = $('errbar');
    if (!el) return;
    el.innerHTML = '<span class="x" data-act="err-close">' + icon('close') + '</span>' + esc('运行错误：' + msg) + '\n（把这段文字发给开发者；仿真会继续尝试运行）';
    el.classList.add('on');
    if (typeof console !== 'undefined' && console.error) console.error('[ironseas]', msg);
  }
  window.addEventListener('error', (e) => reportError((e.message || 'unknown') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0)));
  window.addEventListener('unhandledrejection', (e) => reportError(String((e.reason && e.reason.message) || e.reason || 'unhandled rejection')));

  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
  const setOn = (id, on) => { const el = $(id); if (el) el.classList.toggle('on', !!on); };

  // ============================================================ 提示条 / 日志
  // 同一条消息（例如同一艘舰连续几个舱段殉爆）只保留一条并在后面累加次数，
  // 否则提示条会堆成一列一模一样的红框。
  const liveToasts = new Map();
  function toast(text, kind) {
    const host = $('toasts');
    if (!host || !text) return;
    const shown = liveToasts.get(text);
    if (shown && shown.el && shown.el.parentNode) {
      shown.n += 1;
      shown.el.textContent = text + '（×' + shown.n + '）';
      if (shown.timer) clearTimeout(shown.timer);
      shown.timer = setTimeout(() => { try { host.removeChild(shown.el); } catch (e) { /* 已移除 */ } liveToasts.delete(text); },
        kind === 'ok' ? 4200 : 6000);
      return;
    }
    const d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = text;
    host.appendChild(d);
    while (host.childNodes && host.childNodes.length > 4 && host.firstChild) host.removeChild(host.firstChild);
    const rec = { el: d, n: 1, timer: null };
    rec.timer = setTimeout(() => { try { host.removeChild(d); } catch (e) { /* 已移除 */ } liveToasts.delete(text); },
      kind === 'ok' ? 4200 : 6000);
    liveToasts.set(text, rec);
  }

  function logPass(meta) {
    return state.logFilter === 'all' || meta.group === state.logFilter || meta.group === 'sys';
  }
  function logAdd(html, meta, tSim) {
    if (!logEl || !html) return;
    const t = tSim === undefined || tSim === null ? (state.world ? state.world.t : 0) : tSim;
    const entry = { t, html, cls: (meta && meta.cls) || '', group: (meta && meta.group) || 'sys' };
    state.logEntries.push(entry);
    if (state.logEntries.length > 600) state.logEntries.shift();
    if (!logPass(entry)) return;
    appendLogLine(entry);
  }
  function appendLogLine(entry) {
    const d = document.createElement('div');
    d.className = 'ev ' + entry.cls;
    d.innerHTML = '<time>' + fmtClockHM(entry.t) + '</time><span class="m">' + entry.html + '</span>';
    logEl.appendChild(d);
    while (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    setText('logCount', state.logEntries.length + ' 条');
    // 底部常驻一行：时间 + 语义标签 + 正文（取最新一条）
    const tagEl = d.querySelector('.evtag');
    const tagWrap = $('logLastTag');
    if (tagWrap) {
      tagWrap.textContent = tagEl ? tagEl.textContent : '系统';
      tagWrap.className = 'evtag ' + (tagEl && tagEl.className ? (tagEl.className.split(' ')[1] || 'sys') : 'sys');
    }
    setText('logLastT', fmtClockHM(entry.t));
    const msg = String(d.textContent || '').replace(/^\s*\S+\s*/, '').replace(/\s+/g, ' ').trim();
    setText('logLastMsg', msg || '…');
  }
  function rebuildLog() {
    if (!logEl) return;
    logEl.innerHTML = '';
    for (const e of state.logEntries.slice(-400)) if (logPass(e)) appendLogLine(e);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function logLocal(text) { logAdd('<b>系统</b> ' + esc(text), { cls: 'sys', group: 'sys' }); }

  function recordCmd(cmd, effective) {
    if (!cmd) return;
    const found = state.cmdLog.find((c) => c.id === cmd.id);
    if (found) { if (effective) found.effective = true; return; }
    state.cmdLog.push({
      id: cmd.id, t: cmd.t_issue, tEff: cmd.t_effective,
      by: cmd.source === 'PLAYER' ? '你' : 'AI', isMine: cmd.source === 'PLAYER',
      shipId: cmd.shipId || null, kind: cmd.kind, params: cmd.params || {}, effective: !!effective,
    });
    if (state.cmdLog.length > 60) state.cmdLog.shift();
  }

  // ============================================================ 事件分级
  function eventMeta(ev) {
    const t = ev.type;
    if (/^ship\.(sink|capsize)$/.test(t)) return { cls: 'sink', group: 'combat', toast: (ev.name || ev.ship) + ' 沉没' };
    if (/^victory/.test(t)) return { cls: 'sink', group: 'combat', toast: ev.text || '交战结束', gold: true };
    if (/^dam\.magazine/.test(t)) {
      const r = ev.result;
      if (r === 'detonation') return { cls: 'sink', group: 'damage', toast: (ev.name || ev.ship) + ' 弹药库殉爆！', gold: true };
      if (r === 'burn') return { cls: 'hit', group: 'damage', toast: (ev.name || ev.ship) + ' 弹药库爆燃！' };
      return { cls: 'fire', group: 'damage' };
    }
    if (/^dam\./.test(t)) return { cls: 'fire', group: 'damage' };
    if (/^gun\.(hit|penetration|bounce|nearmiss|straddle)$/.test(t)) return { cls: 'hit', group: 'combat' };
    if (/^torp\./.test(t)) return { cls: 'hit', group: 'combat' };
    if (/^gun\./.test(t)) return { cls: '', group: 'combat' };
    if (/^sensor\./.test(t)) return { cls: 'det', group: 'combat' };
    if (/^ai\./.test(t)) return { cls: 'ai', group: 'ai' };
    if (/^order\./.test(t)) return { cls: 'cmd', group: 'cmd' };
    return { cls: 'sys', group: 'sys' };
  }

  // ---------------- 命令参数 → 中文短语（纯函数，不读全局状态） ----------------
  // 覆盖 src/sim/ship.js applyOrder / src/sim/world.js _applyOne /
  // src/sim/damage.js applyDamageControl / src/ai/nl.js COMMAND_SPEC 里出现的全部
  // 命令 kind 与真实参数名；未知 key 退化为 key=value，绝不输出 { } 或引号。
  const AMMO_ZH = { AP: '穿甲弹', HE: '榴弹', SAP: '半穿甲弹', STAR: '照明弹', ILLUM: '照明弹', AA: '防空弹' };
  const DC_MODE_ZH = { flooding: '堵漏排水', fire: '灭火', magazine: '弹药库注水', mobility: '恢复机动' };
  const DC_ACT_ZH = { FLOOD: '灌注弹药库', FLOOD_MAGAZINE: '灌注弹药库', MAGAZINE_FLOOD: '灌注弹药库', COUNTERFLOOD: '对称注水', PLUG: '堵漏', PUMP: '排水', ABANDON: '弃舱' };
  const BATTERY_ZH = { main: '主炮', secondary: '副炮', aa: '防空炮' };
  const ON_KEY_ZH = { radar: '雷达', sonar: '声呐', searchlight: '探照灯', smoke: '烟幕' };
  const ON_KIND_ZH = { SMOKE: '烟幕', RADAR: '雷达', SEARCHLIGHT: '探照灯', SONAR: '声呐' };
  const isOn = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === '开' || v === '是';
  // 渲染成纯文本：剥离 { } [ ] 与引号，避免任何「原始 JSON」观感
  const plain = (v) => String(v === undefined || v === null ? '?' : v).replace(/[{}[\]"]/g, '').replace(/\s+/g, ' ').trim() || '?';
  const valText = (v) => {
    if (v === null || v === undefined) return '?';
    if (Array.isArray(v)) return v.map(valText).join('/');
    if (typeof v === 'object') return Object.keys(v).map((k) => plain(k) + ' ' + valText(v[k])).join(' · ');
    return plain(v);
  };
  const intOf = (v) => (isFinite(+v) ? String(Math.round(+v)) : plain(v));
  const degOf = (v) => (isFinite(+v) ? String(((Math.round(+v) % 360) + 360) % 360) : plain(v));
  const km1 = (v) => (isFinite(+v) ? (+v / 1000).toFixed(1) : plain(v));
  const rudderPhrase = (v) => {
    if (!isFinite(+v)) return '舵 ' + plain(v);
    const d = Math.round(+v);
    if (d === 0) return '舵 正';
    return '舵 ' + (d > 0 ? '右 ' : '左 ') + Math.abs(d) + '°';
  };
  const boolPhrase = (label, v) => label + ' ' + (isOn(v) ? '开' : '关');
  function paramPhrase(kind, k, v) {
    switch (k) {
      case 'heading': case 'course': return '转向 ' + degOf(v) + '°';
      case 'kn': case 'speed': return +v === 0 ? '停车' : '航速 ' + intOf(v) + ' 节';
      case 'deg': case 'rudder': return rudderPhrase(v);
      case 'trackId': case 'targetTrackId': case 'track': return '目标 ' + plain(v);
      case 'ammo': return AMMO_ZH[String(v).toUpperCase()] || plain(v);
      case 'mode': {
        const up = String(v).toUpperCase();
        if (AMMO_ZH[up]) return AMMO_ZH[up];
        const low = String(v).toLowerCase();
        if (DC_MODE_ZH[low]) return '损管优先 ' + DC_MODE_ZH[low];
        return '模式 ' + plain(v);
      }
      case 'dcPriority': case 'priority': return '损管优先 ' + (DC_MODE_ZH[String(v).toLowerCase()] || plain(v));
      case 'action': return DC_ACT_ZH[String(v).toUpperCase()] || '损管动作 ' + plain(v);
      case 'on': return boolPhrase(ON_KIND_ZH[kind] || KIND_ZH[kind] || '开关', v);
      case 'radar': case 'sonar': case 'searchlight': case 'smoke': return boolPhrase(ON_KEY_ZH[k], v);
      case 'tubes': return intOf(v) + ' 管齐射';
      case 'spreadDeg': return '扇面 ' + (isFinite(+v) ? (+v).toFixed(1) : plain(v)) + '°';
      case 'speedIdx': return '档位 ' + (isFinite(+v) ? String(Math.round(+v) + 1) : plain(v));
      case 'salvoes': return (v === Infinity || v === 'Infinity' || v === null) ? '持续射击' : intOf(v) + ' 轮齐射';
      case 'battery': return BATTERY_ZH[String(v).toLowerCase()] || plain(v);
      case 'bearing': case 'bearingDeg': return '方位 ' + degOf(v) + '°';
      case 'rangeM': case 'range': return '距离 ' + km1(v) + 'km';
      case 'compartment': case 'compartmentIndex': return '舱段 ' + intOf(v);
      case 'scope': return String(v).toUpperCase() === 'FLEET' ? '全队' : '本舰';
      case 'station': {
        const st = v && typeof v === 'object' ? v : {};
        const bits = [];
        if (st.bearingDeg !== undefined) bits.push('方位 ' + degOf(st.bearingDeg) + '°');
        if (st.rangeM !== undefined) bits.push('距离 ' + km1(st.rangeM) + 'km');
        return bits.length ? '编队阵位 ' + bits.join(' ') : '编队阵位 ' + valText(v);
      }
      case 'text': return '通话 ' + plain(v);
      default: return null;
    }
  }
  function describeParams(kind, params) {
    const verb = KIND_ZH[kind] || (kind ? plain(kind) : '命令');
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
    if (!p) return verb;
    const parts = [];
    let known = 0;
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v === undefined || k === 'note') continue;   // note 是解析器附注，不是命令参数
      const phr = paramPhrase(kind, k, v);
      if (phr) { parts.push(phr); known++; } else parts.push(plain(k) + '=' + valText(v));
    }
    if (!parts.length) return verb;
    return known ? parts.join(' · ') : verb + ' ' + parts.join(' · ');
  }

  // ---------------- 事件 → 日志行（HTML；插值一律过 esc） ----------------
  // 语义标签约定见 index.html 的 .evtag（sink/hit/fire/done/det/ai/cmd/sys）。
  const tag = (mod, label) => '<span class="evtag ' + mod + '">' + label + '</span> ';

  function describeEvent(ev) {
    const t = ev.type;
    const n = (v) => esc(v === undefined || v === null ? '?' : v);
    const cmdText = (kind, params) => esc(describeParams(kind, params));
    const shipName = (c) => {
      const w = state.world;
      return c.shipId && w && w.ship(c.shipId) ? w.ship(c.shipId).name : c.shipId || '全队';
    };
    if (t === 'gun.hit') return tag('hit', '命中') + n(ev.name || ev.ship) + ' 被 ' + n(ev.killerName || '敌舰') + ' 击中（' + n(ev.armorMM) + 'mm 装甲，落角 ' + n(ev.obliquityDeg) + '°）';
    if (t === 'gun.penetration') return tag('hit', '命中') + n(ev.ship) + ' 第 ' + n(ev.compartment) + ' 舱段被击穿';
    if (t === 'gun.bounce') return tag('hit', '跳弹') + n(ev.ship) + ' 舷侧弹开了炮弹';
    if (t === 'gun.nearmiss') return tag('hit', '近失') + n(ev.ship) + ' 舷侧被水柱冲击';
    if (t === 'gun.straddle') return tag('hit', '夹叉') + n(ev.ship) + ' 的火力覆盖目标';
    if (t === 'torp.launch') return tag('cmd', '雷击') + n(ev.name || ev.ship) + ' ' + n(ev.tubes) + ' 管' + (ev.accepted === false ? '（被拒）' : '');
    if (t === 'torp.hit') return tag('hit', '命中') + n(ev.ship) + ' 被鱼雷命中（装药 ' + n(ev.warheadKg) + 'kg）';
    if (t === 'torp.dud') return tag('hit', '哑弹') + n(ev.ship) + ' 被鱼雷击中但未爆';
    if (t === 'dam.flood') return tag('fire', '损伤') + '进水：' + n(ev.ship) + ' 舱段 ' + n(ev.compartment) + '（累计 ' + Math.round(ev.value || 0) + ' m³）';
    if (t === 'dam.fire') return tag('fire', '损伤') + '火灾：' + n(ev.ship) + ' 舱段 ' + n(ev.compartment);
    if (t === 'dam.magazine') {
      const r = ev.result;
      const label = r === 'detonation' ? '弹药库殉爆' : r === 'burn' ? '弹药库爆燃' :
        r === 'flooded' ? '弹药库注水（弹药报废）' : r === 'flash' ? '炮塔闪爆传火' :
          r === 'fire_threat' ? '弹药库受火势威胁' : '弹药库被命中';
      return tag('fire', '损伤') + label + '：' + n(ev.name || ev.ship) +
        (ev.energyKg ? '（当量 ' + (ev.energyKg / 1000).toFixed(1) + ' 吨，冲击半径 ' + Math.round(ev.radiusM) + 'm）' : '') +
        (ev.magRisk !== undefined && r !== 'detonation' && r !== 'burn' ? '（风险 ' + Math.round(100 * ev.magRisk) + '%）' : '') +
        (ev.killed ? ' 阵亡 ' + ev.killed : '');
    }
    if (t === 'dam.casualties') return tag('fire', '损伤') + '人员伤亡：' + n(ev.ship) + ' −' + Math.round(ev.value || 0);
    if (t === 'dam.subsystem') return tag('fire', '损伤') + '设备损毁：' + n(ev.ship) + ' ' + n(ev.name || ev.kind);
    if (t === 'ship.sink') return tag('sink', '沉没') + n(ev.name || ev.ship) + '（横倾 ' + Math.round(ev.list || 0) + '°）';
    if (t === 'ship.capsize') return tag('sink', '倾覆') + n(ev.name || ev.ship);
    if (t === 'sensor.detect') return tag('det', '发现') + n(ev.by) + ' 用 ' + n(ev.source) + ' 在 ' + (ev.rangeM ? (ev.rangeM / NMI).toFixed(1) : '?') + 'nm 发现 ' + n(ev.target);
    if (t === 'order.issue') {
      const c = ev.cmd || {};
      const who = c.source === 'PLAYER' ? '<span class="who">你</span>' : '<span class="who">AI</span>';
      const delay = Math.max(0, Math.round((c.t_effective || ev.t) - ev.t));
      return who + ' 下令 <b>' + cmdText(c.kind, c.params) + '</b> → ' + n(shipName(c)) + '（' + delay + 's 后生效）';
    }
    if (t === 'order.effective') {
      const c = ev.cmd || {};
      if (ev.applied === false) return tag('fire', '失效') + '命令未生效（目标不可用）：' + cmdText(c.kind, c.params);
      return tag('done', '生效') + cmdText(c.kind, c.params) + ' → ' + n(shipName(c));
    }
    if (t === 'order.reject') {
      const c = ev.cmd || {};
      const kind = c.kind || ev.kind;
      return tag('fire', '失效') + '命令被拒：' + n(KIND_ZH[kind] || kind || '?') + (ev.reason ? '（' + n(ev.reason) + '）' : '');
    }
    if (t === 'ai.decision') {
      const d = (ev.commandsDetail || []).map((c) => (KIND_ZH[c.kind] || c.kind) + (c.shipId ? '@' + c.shipId : '')).join('、');
      return '<span class="who">AI</span> 决策（' + n(ev.backend) + '，' + n(ev.commands) + ' 条' + (ev.rejected ? '，拒绝 ' + n(ev.rejected) : '') + '）' + (d ? '：' + n(d) : '') + ' ｜ ' + n(String(ev.reasoning || '').slice(0, 70));
    }
    if (t === 'ai.chat') return tag('ai', '通话') + 'AI[' + n(ev.side) + ']：' + n(String(ev.text || '').slice(0, 90));
    if (t === 'ai.fallback') return tag('ai', '掉线') + 'AI 掉线回落：' + n(ev.side) + ' → 本地规则（' + n(ev.reason) + '）';
    if (t === 'victory.achieved') return tag('sink', '交战结束') + n(ev.text || ev.winner);
    return null;
  }

  // ============================================================ 数据
  async function loadJSON(url) {
    try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch (e) { if (typeof console !== 'undefined' && console.warn) console.warn('[data] 加载失败', url, e); return null; }
  }
  async function loadAll() {
    const [ax, al, sc, ld, dp] = await Promise.all([
      loadJSON('./data/ships_axis.json'), loadJSON('./data/ships_allied.json'), loadJSON('./data/scenarios.json'),
      loadJSON('./data/land.json'), loadJSON('./data/depth.json'),
    ]);
    state.landData = ld || null;
    state.depthData = dp || null;
    const parts = [];
    if (ax) parts.push(ax);
    if (al) parts.push(al);
    state.db = ShipDatabase.fromMany(parts);
    state.scenarios = (sc && (sc.scenarios || sc)) || [];
    setText('hud', '舰级数据 ' + state.db.list.length + ' 条 · 剧本 ' + state.scenarios.length + ' 个');
  }

  function currentState() {
    const w = state.world;
    if (!w) return null;
    try { return state.spectate ? w.spectatorState() : w.visibleStateFor(state.side); }
    catch (e) { reportError('态势构建失败：' + e.message); return null; }
  }

  // ============================================================ 模态框
  function closeModal() { const m = $('modal'); if (m) { m.classList.remove('on'); m.innerHTML = ''; } }
  function openModal(html, onMount) {
    const m = $('modal');
    if (!m) return;
    m.innerHTML = '<div class="box">' + html + '</div>';
    m.classList.add('on');
    if (onMount) onMount(m);
    const inp = m.querySelector ? m.querySelector('input') : null;
    if (inp && inp.focus) { inp.focus(); if (inp.select) inp.select(); }
  }
  function askNumber(title, hint, def, min, max, onOk) {
    openModal(
      '<h3>' + esc(title) + '</h3><p>' + esc(hint) + '</p>' +
      '<input id="modalNum" type="number" value="' + def + '" min="' + min + '" max="' + max + '" step="1">' +
      '<div class="acts"><button class="btn" id="modalCancel">取消</button>' +
      '<button class="btn primary" id="modalOk">确认</button></div>',
      (m) => {
        const box = m.querySelector('#modalNum');
        const commit = () => {
          let v = box ? parseFloat(box.value) : NaN;
          if (!isFinite(v)) v = def;
          v = ((Math.round(v) % 360) + 360) % 360;
          closeModal();
          onOk(v);
        };
        if (box) box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
        });
        const ok = m.querySelector('#modalOk');
        if (ok) ok.addEventListener('click', commit);
        const cancel = m.querySelector('#modalCancel');
        if (cancel) cancel.addEventListener('click', closeModal);
      });
  }

  // ============================================================ 剧本 / 帮助 / 战报
  function overlay(html) { const ov = $('overlay'); if (!ov) return; $('overlayCard').innerHTML = html; ov.classList.add('on'); }
  function hideOverlay() { const ov = $('overlay'); if (ov) ov.classList.remove('on'); }

  function showHelp() {
    const K = (k, v) => '<div class="kbdrow"><span>' + v + '</span><kbd>' + k + '</kbd></div>';
    overlay(
      '<h2>铁海 1942</h2>' +
      '<div class="lead">二战海战模拟器。你看到的只有「我们所知道的」——航迹带误差与延迟，未探测到的敌舰不会出现在海图上。</div>' +
      '<div class="grid2" style="gap:26px">' +
        '<div><h4>海图</h4>' +
          K('拖拽', '平移海图') + K('滚轮', '缩放') + K('左键', '选择舰船 / 航迹') +
          K('右键', '上下文命令菜单') + K('双击小地图', '跳转视野') + K('悬停', '查看舰船 / 航迹详情') + K('F', '自动取景（框住双方）') +
        '</div>' +
        '<div><h4>指挥</h4>' +
          K('空格', '暂停 / 继续') + K('1 2 3 4', '1× / 4× / 16× / 64×') + K('← →', '切换己方舰') +
          K('↑ ↓', '切换目标航迹') + K('G / C', '跟随选中舰 / 取消跟随') + K('T', '切换目标') +
          K('Esc', '关弹窗 / 取消选择') + K('Tab', '切换右侧页签') +
        '</div>' +
      '</div>' +
      '<h4 style="margin-top:20px">怎么打</h4>' +
      '<div class="sub">' +
        '<b>1. 选舰</b>：海图上点一下，或用「舰况」页的编队列表。底部指挥台的按钮全部作用于选中的舰。' +
        '<b>2. 选目标</b>：在「情报」页点一行航迹，或海图上点航迹符号。' +
        '<b>3. 下令</b>：点按钮，或直接在底部输入中文口令（「全队转向 240」「24 节」「向最近的敌舰开火」「放烟幕」）。' +
        '命令有<b>指挥延迟</b>（4~12 秒，编队级 +5 秒，超视距中继再 +9 秒），右侧「指令回执」能看到倒计时。' +
      '</div>' +
      '<h4 style="margin-top:16px">三级指挥层级（顶栏切换）</h4>' +
      '<div class="sub"><b>舰长</b>：命令只作用于选中的那一艘。<b>编队指挥官</b>：命令展开到本方全部在航舰，经旗舰中继有额外延迟。' +
      '<b>部门</b>：直接干预损管优先级与雷达/探照灯等设备。</div>' +
      '<h4 style="margin-top:16px">真实感红线</h4>' +
      '<div class="sub">光学测距误差随距离平方增长；雷达受地平线、海杂波与箔条限制；命中按位置决定进水 / 火灾 / 殉爆；' +
      '横倾超过 60° 会倾覆；海况影响航速与射击；鱼雷会哑弹；1942 年的美军鱼雷尤其如此。</div>' +
      '<h4 style="margin-top:16px">AI</h4>' +
      '<div class="sub">默认双方都由 AI 自动指挥，你下的命令优先（5 分钟仿真时间内不会被覆盖）。想完全自己打，' +
      '在「AI」页把「自动指挥」关掉。敌方后端可切<b>本地规则 / 外部智能体 / 大模型</b>。</div>' +
      '<div style="margin-top:20px;display:flex;gap:8px"><button class="btn primary" data-act="close-overlay">开始</button>' +
      '<button class="btn" data-act="open-scenarios">选择战役</button></div>');
  }

  function showScenarios() {
    const list = state.scenarios.length ? state.scenarios : [{ id: 'sandbox_empty', nameZh: '（未找到剧本数据）', description: '请确认 data/scenarios.json 已生成', ships: [] }];
    const cur = (state.pendingStart && state.pendingStart.mode) || (state.spectate ? 'SPECTATE' : (state.side === 'AXIS' ? 'PLAY_AXIS' : 'PLAY_ALLIED'));
    let h = '<h2>选择战役</h2><div class="lead">全部剧本出自真实战史：双方编成、初始阵位、天气与时刻按史料录入。天气与时刻会直接改变交战结果。</div>';
    h += '<div style="display:flex;gap:10px;margin:0 0 16px;align-items:center;flex-wrap:wrap">' +
      '<span class="rolehint">模式</span><div class="seg">' +
      '<button class="modebtn' + (cur === 'PLAY_ALLIED' ? ' on' : '') + '" data-act="set-mode" data-arg="PLAY_ALLIED">参战 · 同盟国</button>' +
      '<button class="modebtn' + (cur === 'PLAY_AXIS' ? ' on' : '') + '" data-act="set-mode" data-arg="PLAY_AXIS">参战 · 轴心国</button>' +
      '<button class="modebtn' + (cur === 'SPECTATE' ? ' on' : '') + '" data-act="set-mode" data-arg="SPECTATE">观战 · AI 对战</button>' +
      '</div><span class="rolehint" id="modeHint">' + (cur === 'SPECTATE' ? '双方均由 AI 指挥，你只看不打' : '本方由你指挥，敌方由 AI 指挥') + '</span></div>';
    h += '<div class="scens">' +
      '<div class="scen" data-act="open-sandbox-setup">' +
      '<div class="t">沙盒模式<span class="tag">自定义</span></div>' +
      '<div class="d">真正自由：自己定双方编成、初始距离与方位、天气与当地时间；开打后顶栏「沙盒」还能随时增删舰船、修复、补弹、改环境。</div>' +
      '<div class="f"><span class="tag">无历史约束</span><span>胜负可关</span><span>随时增删舰</span></div></div>';
    for (const s of list) {
      const ships = s.ships || [];
      const a = ships.filter((x) => x.side === 'ALLIED').length, b = ships.filter((x) => x.side === 'AXIS').length;
      const env = s.env || {};
      const night = (env.lightLevel !== undefined ? env.lightLevel : 1) < 0.2;
      h += '<div class="scen" data-act="start-scen" data-arg="' + esc(s.id) + '">' +
        '<div class="t">' + esc(s.nameZh || s.id) + '<span class="tag' + (night ? ' night' : '') + '">' + esc(s.date || '') + '</span></div>' +
        '<div class="d">' + esc(s.historicalNote || s.description || '') + '</div>' +
        '<div class="f"><span class="tag">' + esc(s.place || '') + '</span><span>兵力 ' + a + ' vs ' + b + '</span>' +
        (env.windKn !== undefined ? '<span>风 ' + env.windKn + 'kn</span>' : '') +
        (env.visibilityNm !== undefined ? '<span>能见度 ' + env.visibilityNm + 'nm</span>' : '') +
        (night ? '<span style="color:#dccfff">夜战</span>' : '') + '</div></div>';
    }
    h += '</div>';
    h += '<div class="lead" style="margin:16px 0 0">提示：海图上只有「我们知道的」目标。未探测到的敌舰不会显示——这是本作与普通海战游戏最大的区别。</div>';
    h += '<div style="margin-top:16px"><button class="btn" data-act="close-overlay">关闭</button></div>';
    overlay(h);
  }

  function showAAR() {
    overlay(buildAAR(state.world));
  }
  function exportFile(w, kind) {
    let data, name;
    if (kind === 'aar') { data = JSON.stringify(buildAARData(w), null, 1); name = w.scenario.id + '-aar.json'; }
    else { data = JSON.stringify(w.exportReplay()); name = w.scenario.id + '-replay.json'; }
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }

  // ============================================================ 沙盒模式
  const SBX_LAT0 = 30, SBX_LON0 = -40, SBX_TZ_H = SBX_LON0 / 15;
  function sbxDefaultDraft() {
    return {
      side: 'ALLIED',
      allied: { BB: 'Iowa', CA: 'NewOrleans', DD: 'Fletcher' },
      axis: { BB: 'Bismarck', CA: 'Takao', DD: 'Kagero' },
      rangeNm: 12, bearingDeg: 90, headingDeg: 90, speedKn: 18,
      visNm: 15, seaState: 3, windKn: 12, hour: 9, victory: false,
    };
  }
  function sbxNations(side) { return side === 'ALLIED' ? ['US', 'UK', 'FR', 'NL'] : ['DE', 'JP', 'IT']; }
  function sbxClassOptions(side, type, cur) {
    const db = state.db;
    if (!db) return '';
    const ns = sbxNations(side);
    let h = '<option value="">—</option>';
    for (const s of db.list) {
      if (s.type !== type || ns.indexOf(s.nation) < 0) continue;
      h += '<option value="' + esc(s.class) + '"' + (s.class === cur ? ' selected' : '') + '>' + esc(s.nameZh) + ' · ' + esc(s.nation) + '</option>';
    }
    return h;
  }
  function sbxNum(id, def) {
    const el = $(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : def;
  }
  function sbxVal(id, def) { const el = $(id); return el ? el.value : def; }
  function showSandboxSetup() {
    const d = state.sandboxDraft || (state.sandboxDraft = sbxDefaultDraft());
    let h = '<h2>沙盒模式</h2><div class="lead">自己定双方编成、初始阵位、天气与时刻。不设历史剧本约束；开打后可用顶栏「沙盒」随时增删舰船、修复、补弹、改环境。</div>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center"><span class="rolehint">你指挥</span><div class="seg">' +
      '<button class="role' + (d.side === 'ALLIED' ? ' on' : '') + '" data-act="sbx-side" data-arg="ALLIED">同盟国</button>' +
      '<button class="role' + (d.side === 'AXIS' ? ' on' : '') + '" data-act="sbx-side" data-arg="AXIS">轴心国</button></div></div>';
    const sideRow = (side, label) => {
      const s = side === 'ALLIED' ? d.allied : d.axis;
      return '<div style="flex:1;min-width:260px"><h4>' + label + '</h4>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<label>战列舰<br><select id="sbx_' + side + '_BB">' + sbxClassOptions(side, 'BB', s.BB) + '</select></label>' +
        '<label>巡洋舰<br><select id="sbx_' + side + '_CA">' + sbxClassOptions(side, 'CA', s.CA) + '</select></label>' +
        '<label>驱逐舰<br><select id="sbx_' + side + '_DD">' + sbxClassOptions(side, 'DD', s.DD) + '</select></label>' +
        '</div></div>';
    };
    h += '<div style="display:flex;gap:22px;flex-wrap:wrap">' + sideRow('ALLIED', '同盟国编成') + sideRow('AXIS', '轴心国编成') + '</div>';
    const num = (id, label, val, min, max, step) => '<label style="display:inline-block;margin:6px 14px 0 0">' + label +
      ' <input id="' + id + '" type="number" value="' + val + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '" style="width:78px"></label>';
    h += '<div style="margin:10px 0 4px">' +
      num('sbxRange', '初始距离 nm', d.rangeNm, 2, 40, 0.5) +
      num('sbxBearing', '敌方位 °', d.bearingDeg, 0, 359) +
      num('sbxHeading', '航向 °', d.headingDeg, 0, 359) +
      num('sbxSpeed', '航速 kn', d.speedKn, 0, 32) +
      num('sbxVis', '能见度 nm', d.visNm, 1, 40, 0.5) +
      num('sbxSea', '海况 0-6', d.seaState, 0, 6) +
      num('sbxWind', '风 kn', d.windKn, 0, 40) +
      num('sbxHour', '当地时间 h', d.hour, 0, 23) +
      '</div>';
    h += '<div style="margin:6px 0 14px"><label><input id="sbxVictory" type="checkbox"' + (d.victory ? ' checked' : '') + '> 启用胜负判定（默认关闭：全灭也不结束，方便继续试验）</label></div>';
    h += '<div style="display:flex;gap:8px"><button class="btn primary" data-act="sbx-start">开始沙盒</button>' +
      '<button class="btn" data-act="sbx-default">恢复默认</button>' +
      '<button class="btn" data-act="open-scenarios">返回剧本</button></div>';
    overlay(h);
  }
  function buildSandboxScenario(d, cls) {
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(SBX_LAT0 * Math.PI / 180);
    const toLL = (x, y) => ({ lat: +(SBX_LAT0 + y / mPerDegLat).toFixed(6), lon: +(SBX_LON0 + x / mPerDegLon).toFixed(6) });
    const brg = d.bearingDeg * Math.PI / 180;
    const rangeM = d.rangeNm * 1852;
    const cx = Math.sin(brg) * rangeM, cy = Math.cos(brg) * rangeM;
    const hd = d.headingDeg * Math.PI / 180;
    const ships = [];
    state._sbxSeq = state._sbxSeq || 0;
    const sideSpec = (side, baseX, baseY, heading) => {
      const picks = [cls[side].BB, cls[side].CA, cls[side].DD].filter(Boolean);
      picks.forEach((c, i) => {
        const data = state.db.resolve(c);
        if (!data) return;
        const off = (i - (picks.length - 1) / 2) * 700;
        const p = toLL(baseX + off * Math.cos(hd), baseY - off * Math.sin(hd));
        state._sbxSeq++;
        ships.push({
          id: 'sbx_' + side.toLowerCase() + '_' + state._sbxSeq,
          name: data.nameZh, class: data.class, side,
          lat: p.lat, lon: p.lon, heading: heading, speed: d.speedKn,
          role: i === 0 ? 'flagship' : (i === picks.length - 1 ? 'screen' : 'line'), crewQuality: 1,
        });
      });
    };
    sideSpec('ALLIED', 0, 0, d.headingDeg);
    sideSpec('AXIS', cx, cy, (d.headingDeg + 180) % 360);
    const localH = ((Math.round(d.hour) % 24) + 24) % 24;
    const utcH = ((localH - SBX_TZ_H) % 24 + 24) % 24;
    const uh = Math.floor(utcH), um = Math.round((utcH - uh) * 60);
    const date = '1943-06-01T' + String(uh).padStart(2, '0') + ':' + String(um).padStart(2, '0') + ':00Z';
    const env = { windKn: d.windKn, windDirDeg: 250, visibilityNm: d.visNm, cloudCover: 0.35, seaState: d.seaState };
    return {
      id: 'sandbox_custom', nameZh: '沙盒演习', date: '1943-06-01',
      place: '北大西洋中部（30°N 40°W）· 自定义',
      historicalNote: '非历史剧本：由沙盒设置面板生成，双方编成与阵位可自定。',
      start: { lat: SBX_LAT0, lon: SBX_LON0, date, env: Object.assign({}, env) },
      env,
      sides: {
        ALLIED: { nameZh: '同盟国特混编队', objective: '沙盒自由对抗（无历史目标）', orderDelay_s: 4, withdrawThreshold: 0.2 },
        AXIS: { nameZh: '轴心国特混编队', objective: '沙盒自由对抗（无历史目标）', orderDelay_s: 4, withdrawThreshold: 0.2 },
      },
      ships,
      objectives: [],
      sandbox: true,
      sandboxNoVictory: !d.victory,
      _timeNote: '沙盒：当地时间由设置面板给出。',
    };
  }
  function sbxStart() {
    const d = state.sandboxDraft || sbxDefaultDraft();
    d.rangeNm = sbxNum('sbxRange', d.rangeNm);
    d.bearingDeg = sbxNum('sbxBearing', d.bearingDeg);
    d.headingDeg = sbxNum('sbxHeading', d.headingDeg);
    d.speedKn = sbxNum('sbxSpeed', d.speedKn);
    d.visNm = sbxNum('sbxVis', d.visNm);
    d.seaState = sbxNum('sbxSea', d.seaState);
    d.windKn = sbxNum('sbxWind', d.windKn);
    d.hour = sbxNum('sbxHour', d.hour);
    const vic = $('sbxVictory');
    d.victory = !!(vic && vic.checked);
    d.allied = { BB: sbxVal('sbx_ALLIED_BB', ''), CA: sbxVal('sbx_ALLIED_CA', ''), DD: sbxVal('sbx_ALLIED_DD', '') };
    d.axis = { BB: sbxVal('sbx_AXIS_BB', ''), CA: sbxVal('sbx_AXIS_CA', ''), DD: sbxVal('sbx_AXIS_DD', '') };
    const cls = { ALLIED: d.allied, AXIS: d.axis };
    const scen = buildSandboxScenario(d, cls);
    if (!scen.ships.length) { toast('至少要给双方各选一艘舰', 'gold'); return; }
    hideOverlay();
    startScenario(scen, { mode: 'PLAY', side: d.side });
    logLocal('沙盒：已按你的设置生成战场（无剧本约束）');
    toast('沙盒开始：顶栏「沙盒」可随时增删舰', 'ok');
  }
  function openSandboxConsole() {
    const w = state.world;
    if (!w) { toast('先开始一局', 'gold'); return; }
    if (!w.scenario.sandbox) { toast('当前不是沙盒剧本', 'gold'); return; }
    const s = selectedLiveShip();
    let opts = '';
    for (const x of (state.db ? state.db.list : [])) opts += '<option value="' + esc(x.class) + '">' + esc(x.nameZh) + ' · ' + esc(x.type) + ' · ' + esc(x.nation) + '</option>';
    const sideCnt = (side) => side + ' ' + w.afloatOf(side).length + '/' + w.shipsOf(side).length + ' 在航';
    let h = '<h2>沙盒控制台</h2><div class="sub" style="margin-bottom:10px">' +
      esc(w.scenario.nameZh || '') + ' · 交战 ' + fmtClock(w.t) + ' · ' + (state.paused ? '已暂停' : '运行中') +
      ' · ' + sideCnt('ALLIED') + ' / ' + sideCnt('AXIS') + ' · 胜负判定：' + (w.scenario.sandboxNoVictory ? '关闭' : '开启') + '</div>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      '<button class="btn" data-act="sbx-pause">' + (state.paused ? '继续' : '暂停') + '</button>' +
      '<button class="btn" data-act="sbx-victory">' + (w.scenario.sandboxNoVictory ? '启用胜负判定' : '关闭胜负判定') + '</button>' +
      '<button class="btn" data-act="sbx-autocmd">' + ((w.ai && w.ai[state.side] && w.ai[state.side].autoCommand) ? '关闭本方 AI 自动指挥' : '开启本方 AI 自动指挥') + '</button>' +
      '<button class="btn" data-act="sbx-setup">重开一局（改设置）</button>' +
      '<button class="btn" data-act="sbx-close">关闭</button></div>';
    h += '<h3>加一艘舰</h3><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<select id="sbxSpawnSide"><option value="ALLIED">同盟国</option><option value="AXIS">轴心国</option></select>' +
      '<select id="sbxSpawnClass">' + opts + '</select>' +
      '<label>方位 <input id="sbxSpawnBrg" type="number" value="90" min="0" max="359" style="width:70px"></label>' +
      '<label>距离 nm <input id="sbxSpawnDist" type="number" value="8" min="0.5" max="40" step="0.5" style="width:80px"></label>' +
      '<label>航速 kn <input id="sbxSpawnSpeed" type="number" value="15" min="0" max="35" style="width:70px"></label>' +
      '<button class="btn primary" data-act="sbx-spawn">生成</button></div>';
    h += '<h3 style="margin-top:14px">当前选中：' + (s ? esc(s.name) : '（未选择）') + '</h3><div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button class="btn" data-act="sbx-repair"' + (s ? '' : ' disabled') + '>修复如新</button>' +
      '<button class="btn" data-act="sbx-ammo"' + (s ? '' : ' disabled') + '>弹药补满</button>' +
      '<button class="btn" data-act="sbx-remove"' + (s ? '' : ' disabled') + '>移除该舰</button>' +
      '<button class="btn" data-act="sbx-follow">镜头对准它</button></div>';
    h += '<h3 style="margin-top:14px">环境</h3><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<label>能见度 nm <input id="sbxEnvVis" type="number" value="' + (w.env.visibilityNm || 15) + '" min="1" max="40" step="0.5" style="width:80px"></label>' +
      '<label>风 kn <input id="sbxEnvWind" type="number" value="' + (w.env.windKn || 12) + '" min="0" max="40" style="width:60px"></label>' +
      '<button class="btn" data-act="sbx-env">应用</button></div>';
    h += '<div class="lead" style="margin-top:12px">沙盒默认不判胜负；「修复」= 用同舰级的新舰体替换，位置与航向不变。</div>';
    openModal(h);
  }
  function sbxSpawn() {
    const w = state.world;
    if (!w) return;
    const side = sbxVal('sbxSpawnSide', 'ALLIED');
    const cls = sbxVal('sbxSpawnClass', '');
    if (!cls) { toast('先选一个舰级', 'gold'); return; }
    const brg = sbxNum('sbxSpawnBrg', 90), dist = Math.max(200, sbxNum('sbxSpawnDist', 8) * 1852), spd = sbxNum('sbxSpawnSpeed', 15);
    const ref = w.afloatOf(side)[0] || w.afloatOf(w.opposite(side))[0] || w.ships[0];
    const bx = ref ? ref.pos.x : 0, by = ref ? ref.pos.y : 0;
    const rad = brg * Math.PI / 180;
    const data = state.db.resolve(cls);
    if (!data) { toast('无法解析舰级：' + cls, 'gold'); return; }
    state._sbxSeq = (state._sbxSeq || 0) + 1;
    const ship = w.addShipById(cls, {
      id: 'sbx_' + side.toLowerCase() + '_' + state._sbxSeq, name: data.nameZh, side,
      x: bx + Math.sin(rad) * dist, y: by + Math.cos(rad) * dist,
      heading: brg, speed: spd, role: 'line', crewQuality: 1,
    });
    logLocal('沙盒：' + (side === 'ALLIED' ? '同盟国' : '轴心国') + ' 加入 ' + ship.name);
    toast('已加入 ' + ship.name, 'ok');
    openSandboxConsole();
  }
  function sbxReplaceSelected(label) {
    const w = state.world, s = selectedLiveShip();
    if (!w || !s) { toast('先选一艘己方舰', 'gold'); return null; }
    const cls = s.className || (s.data && s.data.class);
    const spec = { id: s.id, name: s.name, side: s.side, x: s.pos.x, y: s.pos.y, heading: s.heading, speed: Math.min(12, s.speed || 0), role: s.role, crewQuality: s.crewQuality };
    const idx = w.ships.indexOf(s);
    if (idx >= 0) w.ships.splice(idx, 1);
    let ns = null;
    try { ns = w.addShipById(cls, spec); } catch (e) { toast('修复失败：' + e.message, 'gold'); return null; }
    state.selectedShipId = ns.id;
    logLocal('沙盒：' + ns.name + ' ' + label);
    return ns;
  }
  function sbxRepair() { if (sbxReplaceSelected('已修复如新')) openSandboxConsole(); }
  function sbxAmmo() {
    const s = selectedLiveShip();
    if (!s) { toast('先选一艘己方舰', 'gold'); return; }
    const guns = (s.data && s.data.guns) || [];
    for (const b of s.batteries || []) {
      const spec = guns.find((g) => g.role === b.role) || null;
      if (spec && spec.ammo) for (const k of Object.keys(spec.ammo)) b.ammo[k] = spec.ammo[k];
    }
    logLocal('沙盒：' + s.name + ' 弹药补满');
    toast('弹药已补满', 'ok');
    openSandboxConsole();
  }
  function sbxRemove() {
    const w = state.world, s = selectedLiveShip();
    if (!w || !s) { toast('先选一艘己方舰', 'gold'); return; }
    const idx = w.ships.indexOf(s);
    if (idx >= 0) w.ships.splice(idx, 1);
    logLocal('沙盒：移除 ' + s.name);
    state.selectedShipId = null;
    openSandboxConsole();
  }
  function sbxEnv() {
    const w = state.world;
    if (!w) return;
    const vis = sbxNum('sbxEnvVis', w.env.visibilityNm || 15);
    const wind = sbxNum('sbxEnvWind', w.env.windKn || 12);
    w.env.baseVisibilityNm = vis;
    w.env.windKn = wind;
    w.env._windTargetKn = wind;
    logLocal('沙盒：环境改为能见度 ' + vis + 'nm、风 ' + wind + 'kn');
    toast('环境已更新', 'ok');
    openSandboxConsole();
  }

  // ============================================================ 开局
  function startScenario(scen, opts) {
    hideOverlay();
    closeModal();
    if (!scen) return;
    const o = opts || {};
    state._aarShown = false;
    if (o.mode) state.mode = o.mode;
    if (o.side) state.side = o.side;
    state.spectate = state.mode === 'SPECTATE';
    try {
      state.world = new World({
        scenario: scen, database: state.db, seed: scen.seed || 19420604,
        playerSide: state.spectate ? null : state.side,
        aiOpts: { backend: 'LOCAL' }, landData: state.landData, depthData: state.depthData,
      });
    } catch (e) { reportError('剧本装载失败：' + e.message); return; }
    for (const s of ['ALLIED', 'AXIS']) {
      const ai = state.world.ai[s];
      if (ai) ai.autoCommand = true;
    }
    if (o.followCam === undefined) { /* 保持默认 */ }
    show('segCam', state.spectate);
    setOn('btnSpectate', state.spectate);
    { const appEl = $('app'); if (appEl) appEl.classList.toggle('spectate', state.spectate); }
    state.cameraMode = state.spectate ? 'DIRECTOR' : 'FREE';
    markCamButtons();
    if (state.chart && state.chart.destroy) { try { state.chart.destroy(); } catch (e) { /* ignore */ } }
    state.chart = new ChartRenderer(canvas, state.world, {});
    state.chart.showAll = state.spectate;
    state.chart.onSelectSink = null;
    state.dirTarget = null; state.dirHold = 0;
    const flag = state.world.shipsOf(state.spectate ? 'ALLIED' : state.side).find((s) => s.role === 'flagship')
      || state.world.afloatOf(state.spectate ? 'ALLIED' : state.side)[0];
    state.selectedShipId = flag ? flag.id : null;
    state.selectedTrackId = null;
    state.chart.follow = null;
    state.cmdLog = [];
    state.logEntries = [];
    state.panelSig = {};
    state.lastPaneBuild = 0;
    if (logEl) logEl.innerHTML = '';
    rebuildChrome();
    bindWorldEvents();
    try { state.chart.fitToContacts(state.world.visibleStateFor(state.spectate ? 'ALLIED' : state.side), 1.25); } catch (e) { /* 取景失败不影响开局 */ }
    logLocal('交战开始：' + (scen.nameZh || scen.id) + ' · ' + (scen.date || '') + ' · ' + (scen.place || ''));
    logLocal(state.spectate ? '观战模式：双方由 AI 指挥，你只看不打。' : '你是 ' + state.world.sides[state.side].nameZh + ' 指挥官。任务：' + state.world.sides[state.side].objective);
    forcePanes();
  }

  function bindWorldEvents() {
    const w = state.world;
    if (!w) return;
    w.events.onAny((ev) => {
      const line = describeEvent(ev);
      if (!line) return;
      const meta = eventMeta(ev);
      if (ev.type === 'order.issue') {
        const cs = ev.cmd && ev.cmd.side;
        if (!(state.spectate || !cs || cs === state.side)) return;
        recordCmd(ev.cmd, false);
        const c = ev.cmd || {};
        if (c.kind === 'SET_COURSE' && c.shipId && state.chart) {
          const sh = w.ship(c.shipId);
          if (sh && sh.side === state.side) state.chart.flashOrder(sh.pos.x, sh.pos.y, c.params && c.params.heading);
        }
      }
      if (ev.type === 'order.effective') {
        const cs = ev.cmd && ev.cmd.side;
        if (state.spectate || !cs || cs === state.side) recordCmd(ev.cmd, true);
        else return;
      }
      // 弹药库殉爆/爆燃：海图上放火球 + 冲击环（按当量决定尺寸）
      if (ev.type === 'dam.magazine' && (ev.result === 'detonation' || ev.result === 'burn') && state.chart && ev.x !== undefined) {
        state.chart.addBoom(ev.x, ev.y, ev.energyKg);
        toast((ev.name || '舰船') + (ev.result === 'detonation' ? ' 弹药库殉爆！' : ' 弹药库爆燃') + '（' + ((ev.energyKg || 0) / 1000).toFixed(1) + ' 吨当量）', 'gold');
      }
      logAdd(line, meta, ev.t);
      if (meta.toast) toast(meta.toast, meta.gold ? 'gold' : undefined);
    });
  }

  // ============================================================ 主循环
  let acc = 0, last = (typeof performance !== 'undefined' ? performance.now() : 0);
  function frame(now) {
    // 顶层绝不抛异常：这个函数就是 rAF 回调本身，一旦抛出去就不会再排下一帧，
    // 主循环会永久停摆（表现为"点了没反应、时间不动"）。所以每段都自带兜底。
    try {
      const dtReal = Math.min(0.25, (now - last) / 1000);
      last = now;
      const w = state.world;
      if (w && !state.paused && !state.replay) {
        acc += dtReal * state.timeScale;
        let steps = 0;
        const maxSteps = 1200;
        while (acc >= w.dt && steps < maxSteps) {
          try { w.step(w.dt); } catch (e) { reportError('仿真步进异常：' + (e && e.message)); acc = 0; break; }
          acc -= w.dt; steps++;
          if (w.over) { state.paused = true; setPauseLabel(); onBattleEnd(); break; }
        }
        if (steps >= maxSteps) acc = 0;
      }
      if (state.replay) state.replay.tick(dtReal);
      try { render(); } catch (e) { reportError('渲染帧异常：' + (e && e.message)); }
    } catch (e) {
      reportError('主循环异常：' + (e && e.message));
    } finally {
      requestAnimationFrame(frame);
    }
  }

  function onBattleEnd() {
    const w = state.world;
    if (!w) return;
    logLocal('交战结束：' + w.resultText + '（用时 ' + fmtClockHM(w.t) + '）');
    if (!state._aarShown) { state._aarShown = true; showAAR(); }
  }

  // 观战缩放：近战推近、远战拉远；每帧只走 2%，避免镜头抽搐
  function easeSpectateZoom(chart, s, w) {
    let near = 1e9;
    for (const e of w.afloatOf(w.opposite(s.side))) near = Math.min(near, Math.hypot(e.pos.x - s.pos.x, e.pos.y - s.pos.y));
    const target = near < 3000 ? 0.34 : near < 8000 ? 0.22 : near < 16000 ? 0.13 : 0.075;
    chart.cam.scale += (target - chart.cam.scale) * 0.02;
  }
  // 导播：按"最近 15 秒有没有开火/挨打"给分，而不是累计开火数（累计值打一会儿就都差不多了）
  function updateDirector(w) {
    const chart = state.chart;
    if (!chart) return;
    if (!state._act) state._act = new Map();
    const now = w.t;
    for (const s of w.ships) {
      const a = state._act.get(s.id) || { shots: (s.stats && s.stats.shotsFired) || 0, hits: (s.stats && s.stats.hitsTaken) || 0, t: -999 };
      const shots = (s.stats && s.stats.shotsFired) || 0;
      const hits = (s.stats && s.stats.hitsTaken) || 0;
      if (shots > a.shots || hits > a.hits) a.t = now;
      a.shots = shots; a.hits = hits;
      state._act.set(s.id, a);
    }
    state.dirHold -= 1;
    if (state.dirHold > 0 && state.dirTarget) {
      const s = w.ship(state.dirTarget);
      if (s && s.isAfloat) { chart.centerOn(s.pos); easeSpectateZoom(chart, s, w); return; }
    }
    let best = null, bestScore = -1e9;
    for (const s of w.ships) {
      if (!s.isAfloat) continue;
      const a = state._act.get(s.id) || { t: -999 };
      const recency = Math.max(0, 15 - (now - a.t));
      let near = 1e9;
      for (const e of w.afloatOf(w.opposite(s.side))) near = Math.min(near, Math.hypot(e.pos.x - s.pos.x, e.pos.y - s.pos.y));
      const score = recency * 150 - Math.min(near, 40000) / 40 + (s.role === 'flagship' ? 80 : 0);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best) { state.dirTarget = best.id; state.dirHold = 260; chart.centerOn(best.pos); easeSpectateZoom(chart, best, w); }
  }

  // ============================================================ 渲染
  function render() {
    const w = state.world;
    if (!w) return;
    const st = currentState();
    if (!st) return;
    const chart = state.chart;
    if (!chart) return;
    if (chart.follow) {
      const s = w.ship(chart.follow);
      if (s && s.isAfloat) chart.centerOn(s.pos);
      else chart.follow = null;
    } else if (state.spectate && state.cameraMode === 'DIRECTOR') updateDirector(w);
    else if (state.spectate && (state.cameraMode === 'ALLIED' || state.cameraMode === 'AXIS')) {
      const fl = w.afloatOf(state.cameraMode)[0];
      if (fl) chart.centerOn(fl.pos);
    }
    chart.selectedId = state.selectedShipId;
    chart.selectedTrackId = state.selectedTrackId;
    chart.draw(st);
    patchChrome(st);
    updatePickable();
    const now = performance.now();
    if (now - state.lastPaneTick > 180) {
      state.lastPaneTick = now;
      try { renderPanes(); } catch (e) { reportError('面板渲染异常：' + (e && e.message)); }
    }
  }

  // ---------- 常驻界面（全部走"改文本"，不重建节点） ----------
  function buildMission() {
    const el = $('mission');
    if (!el) return;
    el.innerHTML = '<div class="t"><span id="msName">—</span><em data-act="mission-fold">收起</em></div>' +
      '<div class="m" id="msSub"></div><div class="o" id="msObj"></div>' +
      '<div class="o plain" id="msForce"></div><div class="o plain" id="msEnv"></div>';
  }
  function buildBattleBar() {
    const el = $('battlebar');
    if (!el) return;
    const cell = (cls, label, id) => '<div class="b ' + cls + '"><i>' + label + '</i><b id="' + id + '">—</b><div class="s2" id="' + id + 's"></div></div>';
    el.innerHTML = cell('us', '同盟国', 'bbA') + cell('them', '轴心国', 'bbX') + cell('', '交战时长', 'bbT') +
      cell('', '命中/发射', 'bbH') + cell('', '已知航迹', 'bbK') +
      '<div class="b hidden" id="bbE"><i>已延长</i><b id="bbEv">0′</b><div class="s2">交战时间</div></div>';
  }
  // v5：选中舰仪表已经合进底部指挥台的舰船卡片（#cShip），不再单独浮一个卡片压在海图上
  function rebuildChrome() {
    buildMission();
    buildBattleBar();
    const w = state.world;
    show('btnSandbox', !!(w && w.scenario && w.scenario.sandbox));
  }

  function selectedLiveShip() {
    const w = state.world;
    if (!w || !state.selectedShipId) return null;
    const s = w.ship(state.selectedShipId);
    if (!s || !s.isAfloat) return null;
    if (!state.spectate && s.side !== state.side) return null;
    return s;
  }
  // 命令对象：没选中就落到旗舰（绝不静默失败）
  function ensureShip(quiet) {
    const w = state.world;
    if (!w) return null;
    let s = selectedLiveShip();
    if (s) return s;
    const pool = state.spectate ? w.afloatOf('ALLIED') : w.afloatOf(state.side);
    s = pool.find((x) => x.role === 'flagship') || pool[0] || null;
    if (s) {
      state.selectedShipId = s.id;
      if (!quiet) logLocal('未选中舰船，命令已落到旗舰 ' + s.name);
    }
    return s;
  }

  function patchChrome(st) {
    const w = state.world;
    if (!w) return;
    const env = st.environment;
    const envT = (w.env && w.env.tHours !== undefined) ? w.env.tHours : null;
    if (envT !== null) {
      const lh = ((envT % 24) + 24) % 24;
      const lhh = String(Math.floor(lh)).padStart(2, '0');
      const lmm = String(Math.floor((lh % 1) * 60)).padStart(2, '0');
      setText('clock', lhh + ':' + lmm + ' 当地 · ' + fmtClock(w.t) + (w.over ? ' 结束' : '') + ' ×' + state.timeScale);
      const cel = $('clock');
      if (cel) cel.title = '当地时间（仿真）' + lhh + ':' + lmm + ' · 已交战 ' + fmtClock(w.t) + ' · ' + state.timeScale + ' 倍速';
    } else {
      setText('clock', fmtClock(w.t) + (w.over ? ' 结束' : '') + '  ×' + state.timeScale);
    }
    setText('cSea', env.seaState + ' 级');
    setText('cWind', env.windKn + 'kn ' + String(env.windDirDeg).padStart(3, '0') + '°');
    setText('cVis', env.visibilityNm + 'nm');
    setText('cLight', (env.lightLevel * 100).toFixed(0) + '%' + (env.lightLevel < 0.2 ? ' 夜' : env.lightLevel < 0.5 ? ' 晨昏' : ' 昼'));
    const ext = (w.timeExtensionS || 0);
    show('chipExt', ext > 0);
    if (ext > 0) setText('cExt', Math.round(ext / 60) + '′');

    // 任务卡
    const spec = !!st.spectate;
    setText('msName', w.scenario.nameZh || w.scenario.id);
    setText('msSub', spec ? ('观战 · ' + (w.scenario.date || '') + ' · ' + (w.scenario.place || ''))
      : (((w.sides[state.side] || {}).nameZh || '') + ' · ' + (w.scenario.date || '') + ' · ' + (w.scenario.place || '')));
    setText('msObj', spec ? '双方均由 AI 指挥；顶栏可切镜头与观战视角。' : ('任务：' + (((w.sides[state.side] || {}).objective) || '—')));
    const foeSide = spec ? 'AXIS' : w.opposite(state.side);
    const sunk = w.shipsOf(foeSide).filter((s) => !s.isAfloat).length;
    const total = w.shipsOf(foeSide).length;
    const own = spec ? w.ships.filter((s) => s.isAfloat).length : w.afloatOf(state.side).length;
    setText('msForce', (spec ? '双方在航 ' + own + ' 艘' : '我方在航 ' + own + ' 艘') + ' · 敌方已沉 ' + sunk + '/' + total + ' · 已知航迹 ' + st.tracks.length + ' 个');
    setText('msEnv', '海况 ' + env.seaState + ' · 风 ' + env.windKn + 'kn/' + String(env.windDirDeg).padStart(3, '0') + '° · 能见度 ' + env.visibilityNm + 'nm · 光照 ' +
      (env.lightLevel * 100).toFixed(0) + '%' + (env.lightLevel < 0.2 ? '（夜）' : env.lightLevel < 0.5 ? '（晨昏）' : '（昼）') + ' · 当地 ' + (env.timeOfDayH || 0).toFixed(2) + 'h');
    const mel = $('mission');
    if (mel) mel.classList.toggle('folded', !!state.missionFolded);
    const fem = mel && mel.querySelector ? mel.querySelector('em') : null;
    if (fem) fem.textContent = state.missionFolded ? '展开' : '收起';

    // 战况条
    const cnt = (side) => ({ alive: w.afloatOf(side).length, sunk: w.shipsOf(side).filter((s) => !s.isAfloat).length });
    const a = cnt('ALLIED'), x = cnt('AXIS');
    setText('bbA', a.alive + ' 在航'); setText('bbAs', '沉没 ' + a.sunk);
    setText('bbX', x.alive + ' 在航'); setText('bbXs', '沉没 ' + x.sunk);
    setText('bbT', fmtClockHM(w.t)); setText('bbTs', '×' + state.timeScale + (state.paused ? ' · 暂停' : ''));
    const shots = w.ships.reduce((n, s) => n + s.stats.shotsFired, 0);
    const hits = w.ships.reduce((n, s) => n + s.stats.hits, 0);
    setText('bbH', hits + '/' + shots); setText('bbHs', '命中率 ' + (shots ? (100 * hits / shots).toFixed(1) : '0') + '%');
    setText('bbK', String(st.tracks.length)); setText('bbKs', spec ? '全知视角' : '本方情报');
    show('bbE', ext > 0);
    if (ext > 0) setText('bbEv', Math.round(ext / 60) + '′');

    // 缩放 / 航迹数：放进顶栏芯片（原来压在海图左下角，现在被指挥台盖住了）
    const chart = state.chart;
    setText('hud', '1px≈' + Math.round(chart.mPerPx) + 'm · 航迹 ' + st.tracks.length + (chart.follow ? ' · 跟随' : ''));

    // ---- 指挥台：选中舰卡片 + 四项仪表 + 航速滑杆 + 设备开关 ----
    const cs = selectedLiveShip();
    const chip = $('cShip');
    if (cs) {
      if (chip) { chip.classList.remove('none'); chip.classList.toggle('axis', cs.side === 'AXIS'); }
      const d = cs.data;
      const floodK = clamp01(cs.floodedM3 / Math.max(1, cs.reserveBuoyancyM3));
      const fires = cs.compartments.filter((c) => c.fire > 0.05).length;
      setText('cShipName', cs.name);
      setText('cShipMeta', (cs.className || '') + ' · ' + (TYPE_ZH[cs.type] || cs.type) + ' · ' + (cs.nation || '') +
        ' · 舰员 ' + Math.round(100 * cs.crew / cs.crew0) + '%' + (fires ? ' · 火灾 ' + fires : ''));
      setText('csSpeed', cs.speed.toFixed(1) + ' kn');
      setText('csHeading', String(Math.round(cs.heading)).padStart(3, '0') + '°');
      setText('csRudder', (cs.rudder > 0 ? '右' : cs.rudder < 0 ? '左' : '正') + Math.abs(cs.rudder).toFixed(0) + '°');
      setText('csFlood', Math.round(cs.floodedM3) + ' m³');
      setClass('csFlood', floodK > 0.3 ? 'bad' : floodK > 0.1 ? 'warn' : '');
      const sl = $('speedSlider');
      if (sl) {
        const mx = Math.max(1, Math.round(d.speedMax_kn || 32));
        if (String(sl.max) !== String(mx)) sl.max = String(mx);
        if (document.activeElement !== sl) sl.value = String(Math.round(cs.commanded.speed));
      }
      setText('speedValue', Math.round(cs.commanded.speed) + ' kn');
      setOn('btnSmoke', cs.flags && cs.flags.smokeOn);
      setOn('btnRadar', cs.sensors && cs.sensors.some((x) => x.srcKind === 'RADAR' && x.on));
      setOn('btnLight', !!(cs.flags && cs.flags.searchlight && cs.flags.searchlight.on));
    } else {
      if (chip) { chip.classList.add('none'); chip.classList.remove('axis'); }
      setText('cShipName', state.spectate ? '观战模式' : '未选择舰船');
      setText('cShipMeta', state.spectate ? '双方由 AI 指挥，你不能下令' : '在海图上点选一艘己方舰');
      setText('csSpeed', '—'); setText('csHeading', '—'); setText('csRudder', '—'); setText('csFlood', '—');
      setClass('csFlood', '');
      setText('speedValue', '—');
      setOn('btnSmoke', false); setOn('btnRadar', false); setOn('btnLight', false);
    }
    // 顶栏剧本名
    setText('topScen', (w.scenario.nameZh || w.scenario.id) + (spec ? ' · 观战' : ''));

    const needTrack = !state.selectedTrackId;
    Array.prototype.forEach.call(document.querySelectorAll('[data-need-track]'), (b) => { b.disabled = needTrack; });
    const inp = $('inpCourse');
    if (inp && document.activeElement !== inp && cs && !inp.value) inp.placeholder = String(Math.round(cs.heading)).padStart(3, '0');
  }
  function setClass(id, cls) {
    const el = $(id);
    if (el && el.className !== (cls || '')) el.className = cls || '';
  }

  // ============================================================ 面板（签名 + 实时补丁）
  function activePaneId() {
    const b = document.querySelector('[data-pane].on');
    if (b && b.dataset && b.dataset.pane && PANES[b.dataset.pane]) return b.dataset.pane;
    return 'p-ship';
  }
  function pointerActive() {
    return state.pointerDown || performance.now() < state.pointerGraceUntil;
  }
  function focusInside(el) {
    const ae = document.activeElement;
    return !!(ae && el && el.contains && el.contains(ae));
  }
  function paneCtx() {
    const w = state.world;
    const st = currentState();
    if (!w || !st) return null;
    return { world: w, state, st };
  }
  function safeSig(def, ctx) {
    try { return String(def.sig ? def.sig(ctx) : ''); } catch (e) { return 'err:' + e.message; }
  }
  function renderPanes(force) {
    const ctx = paneCtx();
    if (!ctx) return;
    const paneId = (state.forcedPaneId && PANES[state.forcedPaneId]) ? state.forcedPaneId : activePaneId();
    const def = PANES[paneId];
    const el = $(paneId);
    if (!def || !el) return;
    const now = performance.now();
    const sig = safeSig(def, ctx);
    const interacting = pointerActive() || focusInside(el);
    const stale = now - (state.lastPaneBuild || 0) > 3000;
    const empty = !el.innerHTML;
    const needBuild = force || empty || sig !== state.panelSig[paneId] || stale;
    if (needBuild && (force || !interacting)) {
      const scroll = el.scrollTop;
      const hadChat = paneId === 'p-ai' && document.activeElement && document.activeElement.id === 'aichat';
      const box = $('aichat');
      if (box) state.keepChat = box.value;
      el.innerHTML = def.render(ctx);
      state.panelSig[paneId] = sig;
      state.lastPaneBuild = now;
      el.scrollTop = scroll || 0;
      if (paneId === 'p-ai') {
        const nb = $('aichat');
        if (nb) {
          if (state.keepChat) nb.value = state.keepChat;
          if (hadChat && nb.focus) { nb.focus(); }
        }
      }
    }
    if (def.live) {
      let map = null;
      try { map = def.live(ctx, {}); } catch (e) { map = null; }
      if (map) patchLive(el, map);
    }
  }
  function forcePanes() {
    for (const id in PANES) state.panelSig[id] = null;
    state.lastPaneBuild = 0;
    renderPanes(true);
  }
  function patchLive(root, map) {
    for (const k in map) {
      const v = map[k];
      let node = null;
      try { node = root.querySelector('[data-live="' + k + '"]'); } catch (e) { node = null; }
      if (!node || !node.style) continue;
      if (v && typeof v === 'object') {
        if (v.h !== undefined) node.innerHTML = v.h;
        if (v.t !== undefined) node.textContent = v.t;
        if (v.w !== undefined) node.style.width = Math.round(clamp01(v.w) * 100) + '%';
        if (v.c !== undefined) node.className = v.c;
      } else if (node.textContent !== String(v)) {
        node.textContent = String(v);
      }
    }
  }

  // ============================================================ 命令
  function feedback(kind, targetLabel, cmd) {
    const w = state.world;
    const delay = cmd ? Math.max(0, Math.round((cmd.t_effective || w.t) - w.t)) : 0;
    toast('已下达 ' + (KIND_ZH[kind] || kind) + ' → ' + targetLabel + '（' + delay + 's 后生效）', 'ok');
  }
  function issuePer(kind, paramsFn) {
    const w = state.world;
    if (!w) return;
    const cur = ensureShip();
    if (!cur) { toast('没有可指挥的舰船', 'info'); return; }
    const fleet = state.role === 'FLEET' && kind !== 'DC_PRIORITY';
    const targets = fleet ? w.afloatOf(state.side) : [cur];
    let lastCmd = null, n = 0;
    for (const t of targets) {
      const params = paramsFn(t);
      if (!params) continue;
      lastCmd = w.issueCommand({ shipId: t.id, kind, params, scope: fleet ? 'FLEET' : 'SHIP' }, { source: 'PLAYER' });
      n++;
    }
    if (!n) { toast('该命令当前不可用', 'info'); return; }
    feedback(kind, fleet && n > 1 ? ('全队 ' + n + ' 艘舰') : cur.name, lastCmd);
    forcePanes();
  }

  function toggleFlag(act) {
    const cur = ensureShip();
    if (!cur) return;
    if (act === 'smoke') return cur.flags && cur.flags.smokeOn;
    if (act === 'searchlight') return !!(cur.flags && cur.flags.searchlight && cur.flags.searchlight.on);
    if (act === 'radar') return cur.sensors.some((x) => x.kind === 'radar' && x.on);
    return false;
  }

  function toggleLog(force) {
    const wrap = $('logWrap');
    if (!wrap) return;
    const open = force === undefined ? wrap.classList.toggle('open') : (force ? true : false);
    if (force !== undefined) wrap.classList.toggle('open', !!force);
    setText('logToggle', open ? '收起日志' : '全部日志 ›');
    setTimeout(() => { if (state.chart) state.chart.resize(); }, 30);
  }
  // 沉浸模式：只留海图（H 键或轨道按钮）
  function toggleImmersive(force) {
    const app = $('app');
    if (!app) return;
    const on = force === undefined ? !app.classList.contains('immersive') : !!force;
    app.classList.toggle('immersive', on);
    setTimeout(() => { if (state.chart) state.chart.resize(); }, 60);
    if (on) toast('沉浸模式：按 H 退出', 'info');
  }
  // 观战：在双方舰船之间循环跟随（[ / ] 或观战条按钮）
  function cycleSpectateShip(dir) {
    const w = state.world;
    if (!w || !state.chart) return;
    const list = w.ships.filter((s) => s.isAfloat);
    if (!list.length) return;
    let i = list.findIndex((s) => s.id === state.chart.follow);
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    const s = list[i];
    state.chart.follow = s.id;
    state.selectedShipId = s.id;
    state.cameraMode = 'FREE';
    markCamButtons();
    toast('跟随：' + s.name + '（' + (s.side === 'ALLIED' ? '同盟' : '轴心') + '）', 'info');
  }
  function toggleDock() {
    const d = $('dock');
    if (!d) return;
    d.classList.toggle('collapsed');
    const b = $('btnDockToggle');
    if (b) b.textContent = d.classList.contains('collapsed') ? '▴' : '▾';
  }
  function toggleSide() {
    const app = $('app');
    if (!app) return;
    app.classList.toggle('side-hidden');
    setTimeout(() => { if (state.chart) state.chart.resize(); }, 30);
  }

  function doAction(act, arg, el) {
    const w = state.world;
    if (act === 'err-close') { const e = $('errbar'); if (e) e.classList.remove('on'); return; }
    if (act === 'modal-cancel') { closeModal(); return; }
    if (act === 'close-overlay') { hideOverlay(); return; }
    if (act === 'open-scenarios') { hideOverlay(); showScenarios(); return; }
    if (act === 'open-sandbox-setup') { hideOverlay(); showSandboxSetup(); return; }
    if (act === 'open-sandbox') { openSandboxConsole(); return; }
    if (act === 'sbx-close') { closeModal(); return; }
    if (act === 'sbx-side') {
      if (state.sandboxDraft) state.sandboxDraft.side = arg;
      const card = $('overlayCard');
      if (card) Array.prototype.forEach.call(card.querySelectorAll('[data-act="sbx-side"]'), (b) => b.classList.toggle('on', b.dataset.arg === arg));
      return;
    }
    if (act === 'sbx-default') { state.sandboxDraft = sbxDefaultDraft(); showSandboxSetup(); return; }
    if (act === 'sbx-start') { sbxStart(); return; }
    if (act === 'sbx-setup') { closeModal(); showSandboxSetup(); return; }
    if (act === 'sbx-pause') { state.paused = !state.paused; setPauseLabel(); openSandboxConsole(); return; }
    if (act === 'sbx-victory') { if (w) w.scenario.sandboxNoVictory = !w.scenario.sandboxNoVictory; openSandboxConsole(); return; }
    if (act === 'sbx-autocmd') {
      const ai = w && w.ai ? w.ai[state.side] : null;
      if (ai) { ai.autoCommand = !ai.autoCommand; toast('本方 AI 自动指挥：' + (ai.autoCommand ? '开' : '关'), 'ok'); }
      openSandboxConsole();
      return;
    }
    if (act === 'sbx-spawn') { sbxSpawn(); return; }
    if (act === 'sbx-repair') { sbxRepair(); return; }
    if (act === 'sbx-ammo') { sbxAmmo(); return; }
    if (act === 'sbx-remove') { sbxRemove(); return; }
    if (act === 'sbx-env') { sbxEnv(); return; }
    if (act === 'sbx-follow') { const f = selectedLiveShip(); if (f && state.chart && state.chart.centerOn) state.chart.centerOn(f.pos.x, f.pos.y); closeModal(); return; }
    if (act === 'set-mode') {
      state.pendingStart = { mode: arg };
      Array.prototype.forEach.call(document.querySelectorAll('.modebtn'), (x) => x.classList.toggle('on', x.dataset.arg === arg));
      const mh = $('modeHint');
      if (mh) mh.textContent = arg === 'SPECTATE' ? '双方均由 AI 指挥，你只看不打' : '本方由你指挥，敌方由 AI 指挥';
      return;
    }
    if (act === 'start-scen') {
      const s = state.scenarios.find((x) => x.id === arg);
      if (!s) { toast('剧本不存在：' + arg, 'gold'); return; }
      const m = (state.pendingStart && state.pendingStart.mode) || 'PLAY_ALLIED';
      if (m === 'SPECTATE') startScenario(s, { mode: 'SPECTATE' });
      else startScenario(s, { mode: 'PLAY', side: m === 'PLAY_AXIS' ? 'AXIS' : 'ALLIED' });
      return;
    }
    if (act === 'set-pane') {
      const pane = arg;
      Array.prototype.forEach.call(document.querySelectorAll('[data-pane]'), (x) => x.classList.toggle('on', x.dataset.pane === pane));
      Array.prototype.forEach.call(document.querySelectorAll('.pane'), (x) => x.classList.toggle('on', x.id === pane));
      forcePanes();
      return;
    }
    if (act === 'toggle-log') { toggleLog(); return; }
    if (act === 'toggle-dock') { toggleDock(); return; }
    if (act === 'toggle-side') { toggleSide(); return; }
    if (act === 'help') { showHelp(); return; }
    if (act === 'spectate') {
      const w0 = state.world;
      if (!w0) { state.pendingStart = { mode: 'SPECTATE' }; showScenarios(); return; }
      const next = state.spectate ? 'PLAY' : 'SPECTATE';
      startScenario(w0.scenario, { mode: next, side: state.side });
      toast(next === 'SPECTATE' ? '已切换为观战模式' : '已切回参战模式', 'info');
      return;
    }
    if (act === 'replay-start') {
      if (!state.world || !state.chart) return;
      try {
        state.replay = new ReplayPlayer(state.world.exportReplay(), state.chart, () => { });
        logLocal('进入回放：时间轴与事件跳转见回放面板');
      } catch (err) { toast('回放不可用：' + err.message, 'gold'); }
      return;
    }
    // ---- 以下都需要一个已加载的战局 ----
    if (!w) return;
    if (act === 'mission-fold') { state.missionFolded = !state.missionFolded; return; }
    if (act === 'export-aar') { exportFile(w, 'aar'); return; }
    if (act === 'export-replay') { exportFile(w, 'replay'); return; }
    if (act === 'replay-close') { if (state.replay) { state.replay.destroy(); state.replay = null; } forcePanes(); return; }
    if (act === 'extend') { hideOverlay(); extendBattle(); return; }

    if (act === 'select-ship' && arg) {
      const s = w.ship(arg);
      if (s) {
        if (!state.spectate && s.side !== state.side) return;
        state.selectedShipId = arg;
        forcePanes();
      }
      return;
    }
    if (act === 'select-track' && arg) { state.selectedTrackId = arg; forcePanes(); return; }
    if (act === 'follow') { state.chart.follow = arg === 'off' ? null : (state.selectedShipId || null); return; }

    if (act === 'ai-backend') { setBackend(arg, el && el.dataset ? el.dataset.side : null); forcePanes(); return; }
    if (act === 'ai-preset') {
      const sd = (el && el.dataset && el.dataset.side) || state.side;
      const ai = w.ai[sd];
      const p = ai && ai.applyPreset(arg);
      if (p) { logLocal(sd + ' AI 速度预设：' + p.nameZh + '（' + p.model + '，周期 ' + p.intervalS + 's）'); toast('AI 预设：' + p.nameZh, 'info'); }
      forcePanes();
      return;
    }
    if (act === 'ai-model') {
      const sd = (el && el.dataset && el.dataset.side) || state.side;
      const ai = w.ai[sd];
      const sel = $('aiModelSel_' + sd) || $('aiModelSel');
      if (ai && sel && sel.value) {
        const p = LLM_PRESETS[ai.preset || 'fast'] || { maxTokens: 900, compact: true, timeoutS: 120 };
        ai.connectLLM(location.origin, { model: sel.value, maxTokens: p.maxTokens, compact: p.compact, timeoutS: p.timeoutS });
        logLocal('AI 模型切换为 ' + sel.value);
        toast('AI 模型：' + sel.value, 'info');
      }
      forcePanes();
      return;
    }
    if (act === 'ai-auto') {
      const sd = (el && el.dataset && el.dataset.side) || state.side;
      const ai = w.ai[sd];
      if (ai) {
        ai.autoCommand = !(ai.autoCommand !== false);
        logLocal(sd + (ai.autoCommand ? ' 自动指挥：开启' : ' 自动指挥：关闭（AI 仅作参谋）'));
        toast(ai.autoCommand ? 'AI 自动指挥已开启' : 'AI 自动指挥已关闭，现在全部听你的', 'info');
      }
      forcePanes();
      return;
    }
    if (act === 'ai-now') {
      const sd = (el && el.dataset && el.dataset.side) || state.side;
      const ai = w.ai[sd];
      if (ai) { ai.pendingRequest = false; ai.accum = 1e9; logLocal('已要求 ' + sd + ' 的 AI 立即决策（' + ai.backend + '）'); toast('已请求 AI 立即决策', 'info'); }
      forcePanes();
      return;
    }
    if (act === 'ai-ctx-reset') {
      const sd = (el && el.dataset && el.dataset.side) || state.side;
      const ai = w.ai[sd];
      if (ai && ai.context) { ai.context.reset(); logLocal(sd + ' 的 AI 上下文记忆已清空'); }
      forcePanes();
      return;
    }
    if (act === 'ai-send') { sendChat(); return; }

    // ---------- 战术命令 ----------
    if (!COMMAND_ACTS.has(act)) return;
    if (state.spectate) { toast('观战模式不能下达命令', 'info'); return; }
    const cur = ensureShip();
    if (!cur) { toast('没有可指挥的舰船', 'info'); return; }
    switch (act) {
      case 'speed': {
        const kn = arg === 'full' ? (cur.data.speedMax_kn || 30) : +arg;
        issuePer('SET_SPEED', () => ({ kn }));
        break;
      }
      case 'course-set': {
        const inp = $('inpCourse');
        const raw = inp ? inp.value : '';
        let v = parseFloat(raw);
        if (!isFinite(v)) { toast('请输入 0-359 的航向', 'gold'); if (inp && inp.focus) inp.focus(); return; }
        v = ((Math.round(v) % 360) + 360) % 360;
        if (inp) inp.value = '';
        issuePer('SET_COURSE', () => ({ heading: v }));
        if (state.chart) state.chart.flashOrder(cur.pos.x, cur.pos.y, v);
        break;
      }
      case 'course': {
        askNumber('设定航向', '真方位 0-359（0 = 正北，顺时针）。' + (state.role === 'FLEET' ? '当前是编队层级，命令会下发给全队。' : ''),
          Math.round(cur.heading), 0, 359, (v) => {
            issuePer('SET_COURSE', () => ({ heading: v }));
            if (state.chart) state.chart.flashOrder(cur.pos.x, cur.pos.y, v);
          });
        break;
      }
      case 'rudder': issuePer('SET_RUDDER', () => ({ deg: +arg })); break;
      case 'fire': {
        if (!state.selectedTrackId) { toast('先在「情报」页选一个目标航迹', 'gold'); return; }
        issuePer('FIRE', () => ({ trackId: state.selectedTrackId, ammo: arg || 'AP', salvoes: Infinity }));
        break;
      }
      case 'ceasefire': issuePer('CEASE_FIRE', () => ({})); break;
      case 'torp': {
        if (!state.selectedTrackId) { toast('先在「情报」页选一个目标航迹', 'gold'); return; }
        issuePer('LAUNCH_TORPEDO', () => ({ trackId: state.selectedTrackId, spreadDeg: 3, tubes: +arg || 4 }));
        break;
      }
      case 'torp-set': {
        const kv = String(arg || '').split(':');
        if (!state.torp) state.torp = { depth: 'MED', speed: 'HIGH', tubes: 4, spread: 6 };
        state.torp[kv[0]] = (kv[0] === 'depth' || kv[0] === 'speed') ? kv[1] : Number(kv[1]);
        state.renderPanes(true);
        break;
      }
      case 'torp-mount': case 'torp-fire': case 'torp-bearing': case 'torp-all': {
        const tset = state.torp || (state.torp = { depth: 'MED', speed: 'HIGH', tubes: 4, spread: 6 });
        const depthM = tset.depth === 'SHALLOW' ? 2 : tset.depth === 'DEEP' ? 6 : 4;
        const speedIdx = tset.speed === 'LOW' ? 1 : 0;
        const tubes = tset.tubes >= 90 ? undefined : tset.tubes;
        issuePer('LAUNCH_TORPEDO', (s) => {
          const params = { depthM, speedIdx, spreadDeg: tset.spread, tubes };
          if (act === 'torp-mount') { params.mount = arg; return params; }
          if (act === 'torp-all') { params.tubes = undefined; return params; }   // 全部装填管
          if (act === 'torp-bearing') {
            // 无航迹也能射：按当前舷角方向、假定 8km 估距解算（真实就是靠估距与舷角）
            params.bearingDeg = (((s.heading + 90) % 360) + 360) % 360;
            params.rangeM = 8000;
            return params;
          }
          if (!state.selectedTrackId) { toast('先在「情报」页选一个目标航迹，或用「按当前舷角射」', 'gold'); return null; }
          params.trackId = state.selectedTrackId;
          return params;
        });
        break;
      }
      case 'smoke': issuePer('SMOKE', (s) => ({ on: arg === 'toggle' ? !(s.flags && s.flags.smokeOn) : arg === '1' })); break;
      case 'radar': issuePer('RADAR', (s) => ({ on: arg === 'toggle' ? !s.sensors.some((x) => x.srcKind === 'RADAR' && x.on) : arg === '1' })); break;
      case 'searchlight': issuePer('SEARCHLIGHT', (s) => ({ on: arg === 'toggle' ? !(s.flags && s.flags.searchlight && s.flags.searchlight.on) : arg === '1', bearing: s.heading })); break;
      case 'chaff': issuePer('CHAFF', () => ({})); break;
      case 'dc': issuePer('DC_PRIORITY', () => ({ mode: arg })); break;
      case 'withdraw': issuePer('WITHDRAW', () => ({})); break;
      default: break;
    }
  }

  function setBackend(name, side) {
    const w = state.world;
    if (!w) return;
    const sd = side || state.side;
    const ai = w.ai[sd];
    if (!ai) return;
    if (name === 'REMOTE') connectRemote(sd);
    else if (name === 'LLM') {
      const p = LLM_PRESETS[ai.preset || 'fast'] || { maxTokens: 700, compact: true, timeoutS: 75, model: '' };
      ai.connectLLM(location.origin, { maxTokens: p.maxTokens, compact: p.compact, timeoutS: p.timeoutS });
      logLocal(sd + ' 的 LLM 后端已启用：' + (ai.llmModel || p.model));
      toast('AI 后端：大模型 ' + (ai.llmModel || p.model), 'info');
    } else {
      ai.setBackend(name);
      w.events.emit('ai.connected', { t: w.t, side: sd, backend: name });
      toast('AI 后端：' + name, 'info');
    }
  }

  function connectRemote(side) {
    const w = state.world;
    if (!w) return;
    const sd = side || state.side;
    const ai = w.ai[sd];
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?role=sim&side=' + sd;
    try {
      const ws = new WebSocket(url);
      state.remote = ws;
      ws.onopen = () => {
        ai.setBackend('REMOTE');
        ws.send(JSON.stringify({ type: 'hello', role: 'sim', side: sd, scenario: w.scenario.id }));
        ai.requestHook = (st) => { try { ws.send(JSON.stringify({ type: 'state', side: sd, t: w.t, payload: st })); } catch (e) { /* 忽略发送失败 */ } };
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'commands') ai.submitDecision({ commands: m.commands || [], reasoning: m.reasoning || '外部智能体' });
          else if (m.type === 'chat') w.issueCommand({ side: state.side, kind: 'CHAT', params: { text: m.text }, issuer: '外部智能体' }, {});
        } catch (e) { /* 忽略坏消息 */ }
      };
      ws.onerror = () => logLocal('外部智能体连接失败，回落到本地规则 AI');
      ws.onclose = () => { ai.setBackend('LOCAL'); logLocal('外部智能体断开，回落本地规则 AI'); };
    } catch (e) { logLocal('WebSocket 不可用：' + e.message); }
  }

  async function sendChat() {
    const w = state.world;
    if (!w) return;
    const box = $('inpOrder') || $('aichat');
    if (!box) return;
    const text = String(box.value || '').trim();
    if (!text) return;
    box.value = '';
    if (state.spectate) { toast('观战模式不能下达命令', 'info'); return; }
    const aiC = w.ai[state.side];
    const llmCall = aiC && typeof aiC.llmCall === 'function' ? aiC.llmCall : null;
    let smart = { commands: [], via: 'RULES' };
    try { smart = await parseOrderSmart(text, w, state.side, { llmCall }); }
    catch (e) { smart = { commands: [], via: 'LLM_ERROR', error: e.message }; }
    const parsed = smart.commands || [];
    if (smart.via === 'LLM') logAdd('规则未命中，已由<b>大模型理解</b>出 ' + parsed.length + ' 条命令' + (smart.reasoning ? '：' + esc(String(smart.reasoning).slice(0, 80)) : ''), { cls: 'cmd mine', group: 'cmd' });
    else if (smart.via === 'LLM_FAILED' || smart.via === 'LLM_ERROR') logAdd('规则未命中，且模型未给出可执行命令' + (smart.error ? '（' + esc(String(smart.error).slice(0, 60)) + '）' : '') + '：请换一种说法，例如「全队转向 240」「24 节」「向最近的敌舰开火」', { cls: 'cmd', group: 'cmd' });
    else if (!parsed.length && !llmCall) logAdd('规则未命中。当前 AI 后端是本地规则，无法理解自由说法——把 AI 切到「大模型」就能随便说；或用这些说法：全队转向 240 / 24 节 / 左转 30 度 / 向最近的敌舰开火 / 鱼雷齐射 / 放烟幕 / 停火 / 撤退', { cls: 'cmd', group: 'cmd' });
    const cmds = [];
    const explicitFleet = /全队|全体|编队|各舰|全员/.test(text);
    const fleetLevel = state.role === 'FLEET' || explicitFleet;
    for (const c of parsed) {
      const wantFleet = c.scope === 'FLEET' && fleetLevel && c.kind !== 'DC_PRIORITY' && c.kind !== 'DAMAGE_CONTROL';
      if (wantFleet) for (const s of w.afloatOf(state.side)) cmds.push(Object.assign({ side: state.side }, c, { shipId: s.id, scope: 'FLEET' }));
      else {
        const flag = w.shipsOf(state.side).find((s) => s.role === 'flagship' && s.isAfloat) || w.afloatOf(state.side)[0];
        cmds.push(Object.assign({ side: state.side }, c, { shipId: c.shipId || state.selectedShipId || (flag && flag.id), scope: 'SHIP' }));
      }
    }
    logAdd('<span class="who">你</span> 下达：' + esc(text), { cls: 'cmd mine', group: 'cmd' });
    if (cmds.length) {
      logAdd('已执行 ' + cmds.length + ' 条命令：' + esc(cmds.map((c) => KIND_ZH[c.kind] || c.kind).join('、')) + (smart.via === 'RULES' ? '（规则解析）' : '（模型理解）') + '；命令按指挥延迟生效', { cls: 'cmd mine', group: 'cmd' });
      for (const c of cmds) w.issueCommand(c, { source: 'PLAYER' });
      toast('口令已解析为 ' + cmds.length + ' 条命令', 'ok');
    } else {
      toast('没听懂这条口令，换个说法试试', 'gold');
    }
    w.issueCommand({ side: state.side, kind: 'CHAT', params: { text }, issuer: '你' }, {});
    const ai = w.ai[state.side];
    if (ai && ai.backend === 'LLM') {
      ai.__userText = text;
      ai.accum = 1e9;
      ai.pendingRequest = false;
      logLocal('已把命令交给 LLM 参谋，正在等待决策（推理模型可能需 20-60s）…');
    }
    forcePanes();
  }

  function extendBattle() {
    const w = state.world;
    if (!w) return;
    const r = w.extendBattle(1800);
    state.paused = false;
    state._aarShown = false;
    setPauseLabel();
    logLocal('交战延长 ' + Math.round(r.addedS / 60) + ' 分钟（累计 ' + Math.round(r.totalS / 60) + ' 分钟）' + (r.resumed ? ' · 已恢复被判定结束的交战' : ''));
    toast('交战延长 30 分钟' + (r.resumed ? ' · 战斗继续' : ''), 'gold');
  }

  // ============================================================ 输入
  function setupInput() {
    let dragging = false, steering = false, lastX = 0, lastY = 0, moved = 0;
    const inMinimap = (s) => {
      const r = state.chart && state.chart.minimapRect;
      return !!(r && s.x >= r.x && s.x <= r.x + r.w && s.y >= r.y && s.y <= r.y + r.h);
    };
    const localPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const p = localPos(e);
      if (e.button === 0 && state.chart && inMinimap(p)) {
        const wp = state.chart._mapToWorld ? state.chart._mapToWorld(p) : null;
        if (wp) { state.chart.follow = null; state.chart.camTarget = wp; }
        return;
      }
      if (e.button === 0) {
        // 拖拽设航向：在"选中的那艘舰"身上按下左键 → 拖出一条航向线，松手即转向。
        // 在海图别处按下仍然是平移。这是导航类游戏最自然的手势。
        const hit = state.chart ? state.chart.pick(p, state.pickableIds) : null;
        if (hit && hit.id === state.selectedShipId && !state.spectate) {
          steering = true; moved = 0;
          state.chart.steer = { from: { x: hit.obj.pos.x, y: hit.obj.pos.y }, heading: hit.obj.heading, x: p.x, y: p.y };
          showSteerHint(p.x, p.y, hit.obj.heading);
          try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 可选 */ }
          return;
        }
        dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
        if (state.chart) state.chart.follow = null;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 可选 */ }
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (steering && state.chart) {
        const p = localPos(e);
        const s = selectedLiveShip();
        if (!s) return;
        const h = normDeg(bearing2d(s.pos, state.chart.screenToWorld(p)));
        state.chart.steer.heading = h; state.chart.steer.x = p.x; state.chart.steer.y = p.y;
        moved += 1;
        showSteerHint(p.x, p.y, h, s.speed);
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (state.chart) { state.chart.cam.x -= dx / state.chart.cam.scale; state.chart.cam.y += dy / state.chart.cam.scale; }
    });
    window.addEventListener('pointerup', (e) => {
      if (steering) {
        steering = false;
        hideSteerHint();
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 可选 */ }
        const s = selectedLiveShip();
        const h = state.chart && state.chart.steer ? state.chart.steer.heading : null;
        if (state.chart) state.chart.steer = null;
        if (s && h !== null && h !== undefined && moved > 2) {
          issuePer('SET_COURSE', () => ({ heading: Math.round(h) }));
          if (state.chart) state.chart.flashOrder(s.pos.x, s.pos.y, h);
        }
        return;
      }
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 可选 */ }
      const p = localPos(e);
      if (inMinimap(p)) return;
      if (moved < 5 && state.chart) {
        const st = currentState();
        const tr = state.chart.pickTrack(p, st ? st.tracks : []);
        if (tr) state.selectedTrackId = tr.id;
        else {
          const hit = state.chart.pick(p, state.pickableIds);
          if (hit) state.selectedShipId = hit.id;
          else { state.selectedShipId = null; }
        }
        forcePanes();
      }
    });
    // 航速滑杆：拖动时实时预览，松手才真正下令（避免拖一次发几十条命令）
    const slider = $('speedSlider');
    if (slider) {
      slider.addEventListener('input', () => { setText('speedValue', Math.round(+slider.value) + ' kn'); });
      slider.addEventListener('change', () => { issuePer('SET_SPEED', () => ({ kn: Math.round(+slider.value) })); });
    }

    const hideCtx = () => { const m = $('ctxmenu'); if (m) { m.classList.remove('on'); m.innerHTML = ''; } };
    window.addEventListener('pointerdown', (e) => {
      state.pointerDown = true;
      if (e.target && e.target.closest && !e.target.closest('#ctxmenu')) hideCtx();
    }, true);
    window.addEventListener('pointerup', () => {
      state.pointerDown = false;
      state.pointerGraceUntil = performance.now() + 400;
    }, true);
    window.addEventListener('pointercancel', () => { state.pointerDown = false; state.pointerGraceUntil = performance.now() + 400; }, true);

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = localPos(e);
      showCtxMenu(p.x, p.y, state.chart.screenToWorld(p));
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.chart.zoomAt(localPos(e), e.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { passive: false });

    const cm = $('ctxmenu');
    if (cm) cm.addEventListener('click', (e) => {
      const it = e.target && e.target.closest ? e.target.closest('.it') : null;
      if (!it) return;
      const idx = +it.dataset.i;
      const fn = state._ctxItems && state._ctxItems[idx];
      hideCtx();
      if (fn) fn();
    });

    const palInput = $('palInput');
    if (palInput) {
      palInput.addEventListener('input', () => { state.palIndex = 0; renderPaletteList(); });
      palInput.addEventListener('keydown', (e) => {
        const n = (state.palItems || []).length;
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); state.palIndex = Math.min(n - 1, state.palIndex + 1); renderPaletteList(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); state.palIndex = Math.max(0, state.palIndex - 1); renderPaletteList(); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runPaletteItem(state.palIndex); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
      });
    }

    const inpOrder = $('inpOrder');
    if (inpOrder) inpOrder.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
    const inpCourse = $('inpCourse');
    if (inpCourse) inpCourse.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAction('course-set'); } });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', () => { if (state.chart) state.chart.resize(); });
    if (typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver(() => { if (state.chart) state.chart.resize(); });
        ro.observe(canvas.parentElement || canvas);
      } catch (e) { /* 不支持就算了 */ }
    }
  }

  function isTyping() {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = String(ae.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable === true;
  }

  function setPauseLabel() { const b = $('btnPause'); if (b) b.textContent = state.paused ? '继续' : '暂停'; }
  function markTimeButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('.ts'), (b) => b.classList.toggle('on', +b.dataset.ts === state.timeScale));
  }
  function markRoleButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('.role'), (b) => b.classList.toggle('on', b.dataset.role === state.role));
  }
  function markCamButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('.cam'), (b) => b.classList.toggle('on', b.dataset.cam === state.cameraMode));
  }

  function onKeyDown(e) {
    const k = e.key;
    const w = state.world;
    // ⌘K / Ctrl+K：命令面板
    if ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'K')) {
      e.preventDefault();
      if (paletteOpen()) closePalette(); else openPalette();
      return;
    }
    setOn('btnPalette', paletteOpen());
    // Esc 永远可用：先关命令面板，再关弹窗，再关菜单，最后取消选择
    if (k === 'Escape') {
      if (paletteOpen()) { closePalette(); return; }
      const mm = $('moreMenu');
      if (mm && mm.classList.contains('on')) { hideMoreMenu(); return; }
      hideSteerHint();
      const m = $('modal');
      if (m && m.classList.contains('on')) { closeModal(); return; }
      const ov = $('overlay');
      if (ov && ov.classList.contains('on')) { hideOverlay(); return; }
      const cm = $('ctxmenu');
      if (cm && cm.classList.contains('on')) { cm.classList.remove('on'); return; }
      state.selectedShipId = null;
      if (state.chart) state.chart.follow = null;
      forcePanes();
      return;
    }
    // 在输入框里打字时，绝不响应全局快捷键（v3 在这里把「240」的 2 当成 4× 变速）
    if (isTyping()) return;
    if (k === ' ' || e.code === 'Space') {
      state.paused = !state.paused; setPauseLabel(); e.preventDefault(); return;
    }
    if (!w || !state.chart) return;
    if (k === 'Tab') {
      e.preventDefault();
      const tabs = Array.prototype.slice.call(document.querySelectorAll('#tabs button'));   // 只有档案页签参与 Tab 循环
      if (!tabs.length) return;
      const i = tabs.findIndex((b) => b.classList.contains('on'));
      const n = tabs[(i + 1) % tabs.length];
      if (n) doAction('set-pane', n.dataset.pane);
      return;
    }
    if (k === 'h' || k === 'H') { toggleImmersive(); e.preventDefault(); return; }
    if (k === '/') {   // 直接打开"口令"层并聚焦输入框
      const dt = document.querySelector('[data-dock-tab="order"]');
      if (dt) dt.click();
      e.preventDefault();
      return;
    }
    if (k === '[') { cycleSpectateShip(-1); return; }
    if (k === ']') { cycleSpectateShip(1); return; }
    if (k >= '1' && k <= '4') { state.timeScale = [1, 4, 16, 64][+k - 1]; markTimeButtons(); return; }
    if (k === '+' || k === '=') { state.chart.zoomAt({ x: state.chart.w / 2, y: state.chart.h / 2 }, 1.3); return; }
    if (k === '-' || k === '_') { state.chart.zoomAt({ x: state.chart.w / 2, y: state.chart.h / 2 }, 1 / 1.3); return; }
    if (k === 'g' || k === 'G') { if (state.selectedShipId) { state.chart.follow = state.selectedShipId; toast('镜头跟随 ' + ((w.ship(state.selectedShipId) || {}).name || ''), 'info'); } return; }
    if (k === 'c' || k === 'C') { state.chart.follow = null; return; }
    if (k === 't' || k === 'T') {
      const st = currentState();
      if (st && st.tracks.length) {
        const i = st.tracks.findIndex((x) => x.id === state.selectedTrackId);
        state.selectedTrackId = st.tracks[(i + 1) % st.tracks.length].id;
        toast('目标：' + state.selectedTrackId, 'info');
        forcePanes();
      }
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const own = (state.spectate ? w.afloatOf('ALLIED') : w.afloatOf(state.side));
      if (own.length) {
        const i = own.findIndex((s) => s.id === state.selectedShipId);
        const n = own[(i + (k === 'ArrowRight' ? 1 : own.length - 1)) % own.length];
        state.selectedShipId = n.id;
        if (state.chart.follow) state.chart.follow = n.id;
        forcePanes();
      }
      e.preventDefault();
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const st = currentState();
      if (st && st.tracks.length) {
        const i = st.tracks.findIndex((x) => x.id === state.selectedTrackId);
        const step = k === 'ArrowDown' ? 1 : -1;
        state.selectedTrackId = st.tracks[(i + step + st.tracks.length * 2) % st.tracks.length].id;
        forcePanes();
      }
      e.preventDefault();
      return;
    }
    if (k === 'f' || k === 'F') { state.chart.follow = null; state.chart.fitToContacts(currentState(), 1.4); return; }
  }

  // ============================================================ 右键菜单
  function showCtxMenu(sx, sy, wp) {
    const w = state.world;
    const m = $('ctxmenu');
    if (!w || !m || !wp) return;
    const ship = selectedLiveShip();
    const items = [];
    if (state.spectate) {
      const near = w.ships.filter((s) => s.isAfloat).sort((a, b) => Math.hypot(a.pos.x - wp.x, a.pos.y - wp.y) - Math.hypot(b.pos.x - wp.x, b.pos.y - wp.y))[0];
      items.push({ hd: '观战' });
      if (near) items.push({ t: '镜头跟随 ' + near.name, a: () => { state.chart.follow = near.id; state.cameraMode = 'FREE'; markCamButtons(); } });
      items.push({ t: '居中此处', a: () => { state.chart.follow = null; state.chart.camTarget = { x: wp.x, y: wp.y }; } });
      items.push({ t: '自动导播', a: () => { state.cameraMode = 'DIRECTOR'; state.chart.follow = null; markCamButtons(); } });
    } else if (!ship) {
      items.push({ hd: '先选择一艘己方舰' });
      items.push({ t: '取景全战场', k: 'F', a: () => state.chart.fitToContacts(currentState(), 1.25) });
    } else {
      const brg = normDeg(bearing2d(ship.pos, wp));
      const dist = Math.hypot(wp.x - ship.pos.x, wp.y - ship.pos.y);
      items.push({ hd: ship.name });
      items.push({ t: '转向 ' + String(Math.round(brg)).padStart(3, '0') + '°（' + (dist / NMI).toFixed(2) + 'nm）', a: () => { doAction('course'); } });
      items.push({ t: '直接朝此方向', k: '右键', a: () => { issuePer('SET_COURSE', () => ({ heading: brg })); state.chart.flashOrder(wp.x, wp.y, brg); } });
      items.push({ t: '全速前进', a: () => issuePer('SET_SPEED', (s) => ({ kn: s.data.speedMax_kn || 30 })) });
      items.push({ t: '停车', a: () => issuePer('SET_SPEED', () => ({ kn: 0 })) });
      items.push({ sep: 1 });
      if (state.selectedTrackId) {
        items.push({ t: '向 ' + state.selectedTrackId + ' 开火（AP）', a: () => issuePer('FIRE', () => ({ trackId: state.selectedTrackId, ammo: 'AP', salvoes: Infinity })) });
        items.push({ t: '雷击 ' + state.selectedTrackId, a: () => issuePer('LAUNCH_TORPEDO', () => ({ trackId: state.selectedTrackId, spreadDeg: 3, tubes: 4 })) });
      }
      items.push({ t: '全炮停火', a: () => issuePer('CEASE_FIRE', () => ({})) });
      items.push({ sep: 1 });
      items.push({ t: (ship.flags && ship.flags.smokeOn) ? '停止烟幕' : '施放烟幕', a: () => issuePer('SMOKE', (s) => ({ on: !(s.flags && s.flags.smokeOn) })) });
      items.push({ t: '施放箔条', a: () => issuePer('CHAFF', () => ({})) });
      items.push({ t: (ship.flags && ship.flags.searchlight && ship.flags.searchlight.on) ? '关探照灯' : '探照灯（正前）', a: () => issuePer('SEARCHLIGHT', (s) => ({ on: !(s.flags && s.flags.searchlight && s.flags.searchlight.on), bearing: s.heading })) });
      items.push({ sep: 1 });
      items.push({ t: '镜头跟随本舰', k: 'G', a: () => { state.chart.follow = ship.id; } });
      items.push({ t: '取消选择', k: 'Esc', a: () => { state.selectedShipId = null; state.chart.follow = null; forcePanes(); } });
    }
    state._ctxItems = items.map((it) => it.a);
    m.innerHTML = items.map((it, i) => it.sep ? '<div class="sep"></div>'
      : it.hd ? '<div class="hd">' + esc(it.hd) + '</div>'
        : '<div class="it" data-i="' + i + '">' + esc(it.t) + (it.k ? '<kbd>' + it.k + '</kbd>' : '') + '</div>').join('');
    m.classList.add('on');
    const host = canvas.parentElement.getBoundingClientRect();
    let x = sx, y = sy;
    if (x + m.offsetWidth > host.width - 8) x = host.width - m.offsetWidth - 8;
    if (y + m.offsetHeight > host.height - 8) y = host.height - m.offsetHeight - 8;
    m.style.left = Math.max(6, x) + 'px';
    m.style.top = Math.max(6, y) + 'px';
  }

  // ============================================================ 拖拽设航向提示
  function showSteerHint(sx, sy, heading, speed) {
    const el = $('steerHint');
    if (!el) return;
    el.textContent = '航向 ' + String(Math.round(heading)).padStart(3, '0') + '°' + (speed !== undefined ? '　' + speed.toFixed(1) + ' kn' : '');
    el.classList.add('on');
    el.style.left = Math.max(8, sx + 16) + 'px';
    el.style.top = Math.max(8, sy - 34) + 'px';
  }
  function hideSteerHint() { const el = $('steerHint'); if (el) el.classList.remove('on'); }

  // ============================================================ 顶栏「更多」菜单
  function showMoreMenu() {
    const m = $('moreMenu');
    const btn = $('btnMore');
    if (!m || !btn) return;
    const items = [
      { t: '导出战报 JSON', a: 'export-aar', i: 'export' },
      { t: '导出完整回放', a: 'export-replay', i: 'export' },
      { sep: 1 },
      { t: '回放本场交战', a: 'replay-start', i: 'time' },
      { t: '收起 / 展开信号日志', a: 'toggle-log', i: 'log' },
      { t: '收起 / 展开指挥台', a: 'toggle-dock', i: 'orders' },
      { t: '收起 / 展开侧栏', a: 'toggle-side', i: 'panel' },
      { sep: 1 },
      { t: '延长交战 +30 分钟', a: 'extend', i: 'time' },
      { t: '切换观战模式（AI 对战）', a: 'spectate', i: 'spectate' },
      { sep: 1 },
      { t: '操作说明与快捷键', a: 'help', i: 'help' },
      { t: '选择战役剧本', a: 'open-scenarios', i: 'scenario' },
    ];
    m.innerHTML = items.map((it) => it.sep ? '<div class="sep"></div>'
      : '<div class="it" data-act="' + it.a + '"><span class="mi"><span class="ico">' + icon(it.i) + '</span>' + esc(it.t) + '</span></div>').join('');
    const r = btn.getBoundingClientRect();
    const host = (canvas.parentElement || document.body).getBoundingClientRect();
    m.classList.add('on');
    const w = m.offsetWidth || 210;
    m.style.left = Math.max(6, Math.min(r.left - host.left + r.width - w, host.width - w - 8)) + 'px';
    m.style.top = (r.bottom - host.top + 6) + 'px';
  }
  function hideMoreMenu() { const m = $('moreMenu'); if (m) m.classList.remove('on'); }

  // ============================================================ 命令面板（⌘K）
  // 现代界面里"随手够得着一切"的关键：一个输入框搜剧本 / 舰船 / 命令。
  function paletteItems(query) {
    const w = state.world;
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    const hit = (txt) => !q || String(txt).toLowerCase().indexOf(q) >= 0;
    const push = (group, title, desc, icon, run, kb) => { if (hit(title) || hit(desc) || hit(group)) out.push({ group, title, desc, icon, run, kb }); };

    if (w) {
      for (const s of (state.spectate ? w.ships : w.afloatOf(state.side))) {
        if (!s.isAfloat) continue;
        push('舰船', s.name, (TYPE_ZH[s.type] || s.type) + ' · ' + s.speed.toFixed(1) + 'kn · ' + String(Math.round(s.heading)).padStart(3, '0') + '°', icon('ship'),
          () => { state.selectedShipId = s.id; forcePanes(); toast('已选中 ' + s.name, 'info'); });
      }
      if (!state.spectate) {
        push('命令', '设定航向…', '输入 0-359 真方位', icon('course'), () => doAction('course'));
        for (const kn of [0, 12, 20, 26, 30]) push('命令', kn === 0 ? '停车' : '航速 ' + kn + ' 节', '作用于选中舰', icon('speed'), () => doAction('speed', String(kn)));
        push('命令', '全速前进', '按舰级最高航速', icon('speed'), () => doAction('speed', 'full'));
        push('命令', '开火（穿甲弹）', state.selectedTrackId ? '目标 ' + state.selectedTrackId : '需先选目标航迹', icon('fire'), () => doAction('fire', 'AP'));
        push('命令', '开火（榴弹）', state.selectedTrackId ? '目标 ' + state.selectedTrackId : '需先选目标航迹', icon('fire'), () => doAction('fire', 'HE'));
        push('命令', '全炮停火', '', icon('ceasefire'), () => doAction('ceasefire'));
        push('命令', '鱼雷齐射', state.selectedTrackId ? '目标 ' + state.selectedTrackId : '需先选目标航迹', icon('torpedo'), () => doAction('torp', '4'));
        push('命令', '施放 / 停止烟幕', '', icon('smoke'), () => doAction('smoke', 'toggle'));
        push('命令', '雷达开机 / 关机', '', icon('radar'), () => doAction('radar', 'toggle'));
        push('命令', '探照灯开机 / 关机', '', icon('searchlight'), () => doAction('searchlight', 'toggle'));
        push('命令', '优先堵漏排水', '损管部门', icon('dc'), () => doAction('dc', 'flooding'));
        push('命令', '优先灭火', '损管部门', icon('dc'), () => doAction('dc', 'fire'));
        push('命令', '撤出战斗', '', icon('withdraw'), () => doAction('withdraw'));
      }
      const st = currentState();
      for (const t of ((st && st.tracks) || [])) {
        push('目标航迹', t.id + ' · ' + (t.classifiedAs || '?'), (t.rangeM / NMI).toFixed(2) + 'nm · 方位 ' + String(Math.round(t.bearingDeg)).padStart(3, '0') + '° · 置信 ' + Math.round(t.confidence * 100) + '%', icon('target'),
          () => { state.selectedTrackId = t.id; forcePanes(); toast('目标：' + t.id, 'info'); });
      }
    }
    push('界面', '战役剧本…', '选择并开始一场交战', icon('scenario'), () => doAction('open-scenarios'));
    for (const [id, name] of [['p-ship', '舰况'], ['p-fire', '火控'], ['p-dam', '损管'], ['p-intel', '情报'], ['p-ai', 'AI']]) {
      push('界面', '打开「' + name + '」面板', '', icon('panel'), () => doAction('set-pane', id));
    }
    for (const ts of [1, 4, 16, 64]) push('界面', '时间压缩 ' + ts + '×', '', icon('time'), () => { state.timeScale = ts; markTimeButtons(); });
    push('界面', state.paused ? '继续' : '暂停', '', icon('pause'), () => { state.paused = !state.paused; setPauseLabel(); });
    push('界面', '收起 / 展开信号日志', '', icon('log'), () => doAction('toggle-log'));
    push('界面', '收起 / 展开指挥台', '', icon('orders'), () => doAction('toggle-dock'));
    push('界面', '收起 / 展开侧栏', '', icon('panel'), () => doAction('toggle-side'));
    push('界面', '自动取景（框住双方）', '快捷键 F', icon('frame'), () => { if (state.chart) { state.chart.follow = null; state.chart.fitToContacts(currentState(), 1.25); } });
    push('界面', '观战模式（AI 对战）', '', icon('spectate'), () => doAction('spectate'));
    push('界面', '操作说明与快捷键', '', icon('help'), () => doAction('help'));
    push('界面', '导出战报 JSON', '', icon('export'), () => doAction('export-aar'));
    push('界面', '导出完整回放', '', icon('export'), () => doAction('export-replay'));
    return out.slice(0, 60);
  }
  function openPalette(prefill) {
    const box = $('palette');
    const inp = $('palInput');
    if (!box || !inp) return;
    box.classList.add('on');
    inp.value = prefill || '';
    state.palIndex = 0;
    renderPaletteList();
    if (inp.focus) inp.focus();
    if (inp.select) inp.select();
  }
  function closePalette() { const box = $('palette'); if (box) box.classList.remove('on'); }
  function paletteOpen() { const box = $('palette'); return !!(box && box.classList.contains('on')); }
  function renderPaletteList() {
    const listEl = $('palList');
    const inp = $('palInput');
    if (!listEl) return;
    const items = paletteItems(inp ? inp.value : '');
    state.palItems = items;
    if (state.palIndex >= items.length) state.palIndex = Math.max(0, items.length - 1);
    if (!items.length) { listEl.innerHTML = '<div class="palEmpty">没有匹配的项目</div>'; return; }
    let lastGroup = '';
    listEl.innerHTML = items.map((it, i) => {
      const head = it.group !== lastGroup ? '<div class="palEmpty" style="padding:10px 12px 4px;text-align:left;font-size:11px">' + esc(it.group) + '</div>' : '';
      lastGroup = it.group;
      return head + '<div class="palItem' + (i === state.palIndex ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ico">' + (it.icon || '•') + '</span><span class="txt"><span class="tt">' + esc(it.title) + '</span>' +
        (it.desc ? '<span class="dd">' + esc(it.desc) + '</span>' : '') + '</span>' +
        (it.kb ? '<span class="kb">' + esc(it.kb) + '</span>' : '') + '</div>';
    }).join('');
    const sel = listEl.querySelector ? listEl.querySelector('.palItem.sel') : null;
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  function runPaletteItem(i) {
    const items = state.palItems || [];
    const it = items[i];
    closePalette();
    if (it && it.run) { try { it.run(); } catch (e) { reportError('命令执行失败：' + e.message); } }
  }

  // ============================================================ 全局委托（唯一的点击入口）
  function setupDelegation() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      // 页签
      const tab = t.closest('[data-pane]');
      if (tab && tab.dataset && tab.dataset.pane) { doAction('set-pane', tab.dataset.pane); return; }
      // 日志过滤
      const flt = t.closest('#logHead .f');
      if (flt && flt.dataset) {
        const f = flt.dataset.filter || 'all';
        state.logFilter = f;
        Array.prototype.forEach.call(document.querySelectorAll('#logHead .f'), (x) => x.classList.toggle('on', x === flt));
        rebuildLog();
        return;
      }
      // 命令面板
      if (t.closest('#palette')) {
        const item = t.closest('.palItem');
        if (item && item.dataset) { runPaletteItem(+item.dataset.i); return; }
        if (t.id === 'palette') { closePalette(); return; }
        return;
      }
      const moreItem = t.closest('#moreMenu .it');
      if (moreItem && moreItem.dataset && moreItem.dataset.act) { hideMoreMenu(); doAction(moreItem.dataset.act); return; }
      if (t.closest('#btnMore')) { const m = $('moreMenu'); if (m && m.classList.contains('on')) hideMoreMenu(); else showMoreMenu(); return; }
      if (!t.closest('#moreMenu')) hideMoreMenu();
      // 顶栏
      if (t.closest('#btnPause')) { state.paused = !state.paused; setPauseLabel(); return; }
      if (t.closest('#btnExtend')) { extendBattle(); return; }
      if (t.closest('#btnHelp')) { showHelp(); return; }
      if (t.closest('#btnScenarios')) { showScenarios(); return; }
      if (t.closest('#btnAAR')) { if (state.world) showAAR(); return; }
      if (t.closest('#btnPalette')) { openPalette(); return; }
      if (t.closest('#btnDockToggle')) { doAction('toggle-dock'); return; }
      if (t.closest('#btnSideToggle')) { doAction('toggle-side'); return; }
      // 底部动作条：点一个主按钮展开它的参数层（再点收起）
      const dt = t.closest('[data-dock-tab]');
      if (dt) {
        const key = dt.dataset.dockTab;
        const pop = document.querySelector('#dock .dockPop[data-pop="' + key + '"]');
        const willOpen = !!(pop && !pop.classList.contains('open'));
        for (const p of document.querySelectorAll('#dock .dockPop')) p.classList.toggle('open', p === pop && willOpen);
        for (const b of document.querySelectorAll('#dock .act')) b.classList.toggle('on', willOpen && b === dt);
        if (willOpen && key === 'order') { const inp = $('inpOrder'); if (inp) setTimeout(() => inp.focus(), 0); }
        return;
      }
      if (t.closest('#btnImmersive') || t.closest('#btnImmersive2')) { toggleImmersive(); return; }
      if (t.closest('#btnExitSpectate')) { doAction('spectate'); return; }
      if (t.closest('#btnPrevShip')) { cycleSpectateShip(-1); return; }
      if (t.closest('#btnNextShip')) { cycleSpectateShip(1); return; }
      if (t.closest('#logToggle') || t.closest('#logToggle2')) { toggleLog(); return; }
      if (t.closest('#logClear')) { state.logEntries = []; if (logEl) logEl.innerHTML = ''; setText('logCount', '0 条'); return; }
      if (t.closest('#btnReplay')) {
        if (!state.world) return;
        try {
          state.replay = new ReplayPlayer(state.world.exportReplay(), state.chart, () => { });
          logLocal('进入回放：时间轴与事件跳转见回放面板');
        } catch (err) { toast('回放不可用：' + err.message, 'gold'); }
        return;
      }
      const zin = t.closest('#btnZin'), zout = t.closest('#btnZout');
      if (zin || zout) { if (state.chart) state.chart.zoomAt({ x: state.chart.w / 2, y: state.chart.h / 2 }, zin ? 1.35 : 1 / 1.35); return; }
      const ts = t.closest('.ts');
      if (ts && ts.dataset) { state.timeScale = +ts.dataset.ts; markTimeButtons(); return; }
      const role = t.closest('.role');
      if (role && role.dataset) {
        state.role = role.dataset.role;
        markRoleButtons();
        logLocal('指挥层级：' + (ROLE_ZH[state.role] || state.role) + (state.role === 'FLEET' ? '（命令作用于全队，延迟更大）' : state.role === 'DEPARTMENT' ? '（直接干预损管与设备）' : '（命令只作用于选中舰）'));
        forcePanes();
        return;
      }
      const cam = t.closest('.cam');
      if (cam && cam.dataset) { state.cameraMode = cam.dataset.cam; markCamButtons(); state.chart && (state.chart.follow = null); return; }
      if (t.closest('#btnSpectate')) {
        const w = state.world;
        if (!w) { state.pendingStart = { mode: 'SPECTATE' }; showScenarios(); return; }
        const next = state.spectate ? 'PLAY' : 'SPECTATE';
        state._aarShown = false;
        startScenario(w.scenario, { mode: next, side: state.side });
        toast(next === 'SPECTATE' ? '已切换为观战模式' : '已切换为参战模式', 'info');
        return;
      }
      if (t.closest('#btnSendOrder')) { sendChat(); return; }
      if (t.closest('#errbar .x')) { const e2 = $('errbar'); if (e2) e2.classList.remove('on'); return; }
      // 模态框背景
      if (t.id === 'modal') { closeModal(); return; }
      // 通用动作
      const act = t.closest('[data-act]');
      if (act && act.dataset && act.dataset.act) {
        doAction(act.dataset.act, act.dataset.arg, act);
        return;
      }
    });
    const side = $('selSide');
    if (side) side.addEventListener('change', () => {
      state.side = side.value;
      if (state.world) {
        state._aarShown = false;
        startScenario(state.world.scenario, { mode: state.spectate ? 'SPECTATE' : 'PLAY', side: state.side });
        toast('已切换阵营：' + (state.side === 'AXIS' ? '轴心国' : '同盟国'), 'info');
      }
    });
  }

  // ============================================================ 深链（截图 / 自动化）
  function applyDeepLink() {
    const q = new URLSearchParams(location.search);
    if (!q.toString()) return false;
    if (q.get('side')) state.side = String(q.get('side')).toUpperCase();
    if (q.get('mode')) state.mode = String(q.get('mode')).toUpperCase() === 'SPECTATE' ? 'SPECTATE' : 'PLAY';
    const scenId = q.get('scen');
    if (!scenId) return false;
    const s = state.scenarios.find((x) => x.id === scenId) || state.scenarios[0];
    if (!s) return false;
    state._aarShown = false;
    startScenario(s, { mode: state.mode, side: state.side });
    if (q.get('role')) { state.role = String(q.get('role')).toUpperCase(); markRoleButtons(); forcePanes(); }
    if (q.get('pane')) doAction('set-pane', String(q.get('pane')));
    if (q.get('cam')) { state.cameraMode = String(q.get('cam')).toUpperCase(); markCamButtons(); }
    if (q.get('nolock') === '1' && state.chart) state.chart.follow = null;
    if (q.get('advance') && state.world) {
      const target = +q.get('advance') || 0;
      const budget = performance.now() + 9000;
      while (state.world.t < target && performance.now() < budget && !state.world.over) state.world.step(state.world.dt);
      if (state.chart) {
        state.chart.follow = null;
        state.chart.fitToContacts(state.world.visibleStateFor(state.spectate ? 'ALLIED' : state.side), 1.25);
      }
    }
    if (q.get('ts')) { state.timeScale = +q.get('ts') || 1; markTimeButtons(); }
    if (q.get('pause') === '1') { state.paused = true; setPauseLabel(); }
    if (q.get('menu') === '1') {
      setTimeout(() => {
        try {
          const r = canvas.getBoundingClientRect();
          const c = { x: r.width * 0.44, y: r.height * 0.52 };
          showCtxMenu(c.x, c.y, state.chart.screenToWorld(c));
        } catch (e) { /* 截图用，失败无所谓 */ }
      }, 80);
    }
    if (q.get('boom')) {   // 演示/自检：在海图上放一次殉爆特效
      setTimeout(() => { try { const own = w.afloatOf(state.side)[0]; if (own && state.chart) state.chart.addBoom(own.pos.x, own.pos.y, +(q.get('boom') || 9000)); } catch (e) {} }, 400);
    }
    if (q.get('say')) {
      setTimeout(() => {
        try { const box = $('inpOrder'); if (box) { box.value = q.get('say'); sendChat(); } } catch (e) { /* 忽略 */ }
      }, 150);
    }
    return true;
  }

  // ============================================================ 启动
  function updatePickable() {
    const w = state.world;
    if (!w) { state.pickableIds = null; return; }
    if (state.spectate) { state.pickableIds = null; return; }
    const ids = {};
    for (const s of w.afloatOf(state.side)) ids[s.id] = 1;
    state.pickableIds = ids;
  }

  function boot() {
    markTimeButtons();
    markRoleButtons();
    markCamButtons();
    setupDelegation();
    setupInput();
    let firstRun = true;
    try { firstRun = !localStorage.getItem('ironseas_seen_v4'); localStorage.setItem('ironseas_seen_v4', '1'); } catch (e) { firstRun = true; }
    if (!applyDeepLink()) { if (firstRun) showHelp(); else showScenarios(); }
    const sp = $('splash');
    if (sp && sp.classList) { sp.classList.add('off'); setTimeout(() => { try { sp.remove(); } catch (e) { /* 已移除 */ } }, 600); }
    requestAnimationFrame(frame);
  }

  loadAll().then(() => {
    boot();
  }).catch((e) => {
    reportError('初始化失败：' + (e && e.message));
    boot();
  });

  // ---------- 测试 / 自动化钩子 ----------
  state.startScenario = startScenario;
  state.doAction = doAction;
  state.showScenarios = showScenarios;
  state.showHelp = showHelp;
  state.showAAR = showAAR;
  state.renderOnce = render;
  state.renderPanes = renderPanes;
  state.forcePanes = forcePanes;
  window.__ironSeas = state;
}

function buildAARData(w) {
  return {
    scenario: w.scenario.id, seed: w.seed, durationS: w.t, winner: w.winner, text: w.resultText,
    ships: w.ships.map((s) => s.status()), commands: w.record.commands.length, snapshots: w.record.snapshots.length,
  };
}
