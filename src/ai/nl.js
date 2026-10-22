// ============================================================================
// 【T5】src/ai/nl.js — 中文自然语言 → 结构化命令
// ----------------------------------------------------------------------------
// 设计（分层，逐层可单独测试）：
//   0) 归一化：NFKC（全角→半角）+ 去空白；中文数字 → 阿拉伯数字
//   1) 指代解析（deixis）："最近的目标""领头的战列舰""本舰/旗舰/全队"
//      必须只使用 world.visibleStateFor(side)（雾里看花：AI 只能看到航迹，
//      看不到真值），这是真实感红线之一。
//   2) 规则槽位匹配：按"意图优先级"匹配（停火先于开火、鱼雷先于火炮…），
//      语序无关，允许同义词与错别字容忍（模糊匹配）。
//   3) LLM 兜底：规则完全不命中时，调用注入的 llmCall(messages) → parseDecisionJSON。
//
// 二战设定：只产出契约 §3 中的命令 kind；不产生任何现代武器/数据链命令。
// 单位：航向/方位 度（0=北，顺时针）；速度 节；距离 米；时间 秒。
// 所有函数对 world === null 容错（便于 UI 在无世界时预解析）。
// ============================================================================
import { normDeg, normDeg180, clamp } from '../core/util.js';

// ---------------------------------------------------------------------------
// 中文数字
// ---------------------------------------------------------------------------
const CN_DIGIT = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 千: 1000, 万: 10000 };
const NUM_CHARS = '0-9零〇一壹二贰两叁三肆四伍五陆六柒七捌八玖九十拾百千万';
const NUM_RE = '[' + NUM_CHARS + ']+';

/** 中文/阿拉伯数字 → 阿拉伯数字。'三六零'→360，'零三零'→30，'二十'→20，'三百六十'→360 */
export function cnNumberToArabic(seg) {
  if (seg === undefined || seg === null) return null;
  const s = String(seg).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if ([...s].some((ch) => CN_UNIT[ch] !== undefined)) {
    // 位值制（含"十"的多字组合按位值解释）
    let total = 0, section = 0, num = 0, seen = false;
    for (const ch of s) {
      if (CN_DIGIT[ch] !== undefined) { num = CN_DIGIT[ch]; seen = true; continue; }
      const u = CN_UNIT[ch];
      if (u === undefined) return null;
      if (u === 10000) { section = (section + num) * u; total += section; section = 0; num = 0; }
      else { if (num === 0 && u === 10) num = 1; section += num * u; num = 0; }
      seen = true;
    }
    return seen ? total + section + num : null;
  }
  // 逐位读法（航向/舷号常用）：'零三零'→'030'→30，'三六零'→360
  let digits = '';
  for (const ch of s) {
    const d = CN_DIGIT[ch];
    if (d === undefined || d > 9) return null;
    digits += String(d);
  }
  return digits === '' ? null : parseInt(digits, 10);
}

/** 归一化：NFKC（全角→半角、兼容字符）、去空白、统一引号 */
export function normalizeText(text) {
  let s = String(text === undefined || text === null ? '' : text).normalize('NFKC');
  s = s.replace(/[\u201c\u201d\u2018\u2019]/g, '"');
  s = s.replace(/\s+/g, '');
  return s;
}

// ---------------------------------------------------------------------------
// 方位词
// ---------------------------------------------------------------------------
const COMPASS = [
  [/北东北|东北偏北/, 22.5], [/东东北|东北偏东/, 67.5],
  [/东南偏东|东东南/, 112.5], [/东南偏南|南南东/, 157.5],
  [/南南西|西南偏南/, 202.5], [/西南偏西|西西南/, 247.5],
  [/西北偏西|西西北/, 292.5], [/西北偏北|北北西/, 337.5],
  [/东北/, 45], [/东南/, 135], [/西南/, 225], [/西北/, 315],
  [/正北|向北|朝北|北/, 0], [/正东|向东|朝东|东/, 90],
  [/正南|向南|朝南|南/, 180], [/正西|向西|朝西|西/, 270],
];
export function compassToDeg(word) {
  const w = normalizeText(word);
  for (const [re, deg] of COMPASS) if (re.test(w)) return deg;
  return null;
}

// ---------------------------------------------------------------------------
// 世界可见信息（只读，容错）
// ---------------------------------------------------------------------------
export function visibleTracks(world, side) {
  if (!world || !side) return [];
  try {
    const st = world.visibleStateFor ? world.visibleStateFor(side) : null;
    if (st && Array.isArray(st.tracks)) return st.tracks;
  } catch { /* ignore */ }
  try { if (world.tracks && typeof world.tracks.visibleFor === 'function') { const arr = []; for (const s of world.afloatOf(side)) for (const t of world.tracks.visibleFor(s)) if (!arr.some((x) => x.id === t.id)) arr.push(t); return arr; } } catch { /* ignore */ }
  return [];
}
function ownShips(world, side) {
  if (!world || !side) return [];
  try { return world.afloatOf ? world.afloatOf(side) : (world.shipsOf ? world.shipsOf(side).filter((s) => s.isAfloat) : []); } catch { return []; }
}
function allShips(world, side) {
  if (!world || !side) return [];
  try { return world.shipsOf ? world.shipsOf(side) : []; } catch { return []; }
}

// 舰型大小序（"最大的目标"）
const TYPE_RANK = { BB: 6, BC: 5, CA: 4, CV: 3, CL: 2, DD: 1, UNKNOWN: 0 };
const TYPE_WORDS = [
  [/战列巡洋舰|战巡/, ['BC']],
  [/战列舰|主力舰|战舰/, ['BB', 'BC']],
  [/航空母舰|航母/, ['CV']],
  [/重巡洋舰|重巡|巡洋舰|巡洋/, ['CA', 'CL']],
  [/轻巡洋舰|轻巡/, ['CL']],
  [/驱逐舰|驱逐|雷击舰/, ['DD']],
];

function classifyType(tr) {
  return String(tr.classifiedAs || 'UNKNOWN').toUpperCase();
}
function trackTypeWords(s) {
  for (const [re, types] of TYPE_WORDS) if (re.test(s)) return types;
  return null;
}

/** 目标指代解析：返回 track（world.visibleStateFor 的可见航迹）或 null。 */
export function resolveTargetReference(text, world, side) {
  const s = normalizeText(text);
  const tracks = visibleTracks(world, side);
  if (!tracks.length) return null;
  let pool = tracks.slice();
  const typeWanted = trackTypeWords(s);
  if (typeWanted) {
    const filtered = pool.filter((t) => typeWanted.includes(classifyType(t)));
    if (filtered.length) pool = filtered;
  }
  const pickNearest = () => pool.slice().sort((a, b) => (a.rangeM || 0) - (b.rangeM || 0))[0] || null;
  if (/最近|最接近|距离最近|就近|离我|当前/.test(s)) return pickNearest();
  if (/领头|打头|前导|先锋|最前|带队/.test(s)) return leadingTrack(pool, world, side);
  if (/殿后|最后|最远|末尾/.test(s)) return trailingTrack(pool, world, side);
  if (/最大|最强|主力|吨位最大/.test(s)) {
    return pool.slice().sort((a, b) => (TYPE_RANK[classifyType(b)] - TYPE_RANK[classifyType(a)]) || ((a.rangeM || 0) - (b.rangeM || 0)))[0] || null;
  }
  if (/旗舰/.test(s)) {
    return pool.slice().sort((a, b) => ((TYPE_RANK[classifyType(b)] - TYPE_RANK[classifyType(a)]) || (b.confidence - a.confidence)))[0] || null;
  }
  // 第N个目标
  const mIdx = s.match(new RegExp('第(' + NUM_RE + ')(?:个|艘|条|号)?(?:目标|敌舰|舰|船|日舰)?'));
  if (mIdx) {
    const n = cnNumberToArabic(mIdx[1]);
    if (n && n >= 1 && n <= pool.length) {
      const sorted = pool.slice().sort((a, b) => (a.rangeM || 0) - (b.rangeM || 0));
      return sorted[n - 1];
    }
  }
  if (typeWanted) return pickNearest();
  return null;
}

/** "领头"：沿"我方旗舰→敌航迹质心"方向的投影最大者（纵队前导） */
function leadingTrack(pool, world, side) {
  const mine = ownShips(world, side);
  if (!mine.length) return pool.slice().sort((a, b) => (a.rangeM || 0) - (b.rangeM || 0))[0] || null;
  const fl = mine.find((s) => s.role === 'flagship') || mine[0];
  let cx = 0, cy = 0; for (const t of pool) { cx += t.pos.x; cy += t.pos.y; }
  cx /= pool.length; cy /= pool.length;
  let ax = cx - fl.pos.x, ay = cy - fl.pos.y;
  const L = Math.hypot(ax, ay) || 1; ax /= L; ay /= L;
  let best = pool[0], bv = -Infinity;
  for (const t of pool) { const v = (t.pos.x - fl.pos.x) * ax + (t.pos.y - fl.pos.y) * ay; if (v > bv) { bv = v; best = t; } }
  return best;
}
function trailingTrack(pool, world, side) {
  const lead = leadingTrack(pool, world, side);
  if (!lead) return null;
  const sorted = pool.slice().sort((a, b) => (a.rangeM || 0) - (b.rangeM || 0));
  return sorted[sorted.length - 1] || lead;
}

/** 本方舰指代：返回 {ships:[Ship...], fleet:boolean} 或 null */
export function resolveOwnShipReference(text, world, side) {
  const s = normalizeText(text);
  const mine = ownShips(world, side);
  const all = allShips(world, side);
  if (!all.length) return null;
  if (/全(?:部|体)|各舰|所有|编队|舰队|全队|全军/.test(s)) return { ships: mine.length ? mine : all, fleet: true };
  if (/旗舰/.test(s)) { const fl = all.find((x) => x.role === 'flagship') || all[0]; return { ships: [fl], fleet: false }; }
  // 专名（中文名/英文名）
  for (const ship of all) {
    if (ship.name && ship.name.length > 1 && s.includes(ship.name)) return { ships: [ship], fleet: false };
    if (ship.nameEn && ship.nameEn.length > 2 && s.toUpperCase().includes(ship.nameEn.toUpperCase())) return { ships: [ship], fleet: false };
    if (ship.className && ship.className.length > 2 && s.includes(ship.className)) return { ships: [ship], fleet: false };
  }
  for (const [re, types] of TYPE_WORDS) {
    if (re.test(s)) { const hit = all.filter((x) => types.includes(x.type)); return hit.length ? { ships: hit, fleet: hit.length > 1 } : null; }
  }
  return { ships: mine.length ? mine : all, fleet: true };
}

// ---------------------------------------------------------------------------
// 命令构造
// ---------------------------------------------------------------------------
function withScope(cmd, ships, fleet) {
  if (fleet || !ships || ships.length === 0) return Object.assign({ scope: 'FLEET' }, cmd);
  if (ships.length === 1) return Object.assign({ shipId: ships[0].id, scope: 'SHIP' }, cmd);
  return Object.assign({ scope: 'FLEET', shipIds: ships.map((s) => s.id) }, cmd);
}

/**
 * 中文命令解析主入口。
 * @returns {Array<{kind:string,params:object,scope:'SHIP'|'FLEET',shipId?:string,note?:string}>}
 *  命令按契约 §3 schema；未指定舰则 scope='FLEET'（由 expandFleetCommands 展开为各舰命令）。
 */
export function parseChineseOrder(text, world, side) {
  const raw = String(text === undefined || text === null ? '' : text);
  const s = normalizeText(raw);
  const cmds = [];
  if (!s) return cmds;
  const push = (c) => { cmds.push(c); };

  const ownRef = resolveOwnShipReference(s, world, side);
  const ownShips_ = ownRef ? ownRef.ships : [];
  const isFleet = ownRef ? ownRef.fleet : true;
  const ownTypes = ownShips_.filter(Boolean).map((x) => x.type);
  const refShip = ownShips_[0] || null;
  const wantShips = () => (ownShips_.length ? ownShips_ : ownShips(world, side));

  // ---- 0) 聊天/旗语（最高优先，避免被"射击"等词误伤） ----
  const chatM = s.match(/(?:说|问|告知|通报|电告|发报|旗语|呼叫)[:：]?(.+)/);
  if (chatM && !/(开火|射击|鱼雷|齐射)/.test(s)) { push({ kind: 'CHAT', params: { text: chatM[1] }, scope: 'FLEET', note: '自然语言聊天' }); return cmds; }

  // ---- 1) 损管优先（"优先堵漏"/"损管优先"） ----
  if (/损管|堵漏|排水|进水|灭火|殉爆|弹药库注水|抢修/.test(s) && /优先|先行|重点|首先|立即|抓紧/.test(s)) {
    let mode = 'flooding';
    if (/灭火|火灾|失火|火势/.test(s)) mode = 'fire';
    else if (/弹药库|殉爆/.test(s)) mode = 'magazine';
    else if (/机动|动力|主机|航速|锅炉|主轴/.test(s)) mode = 'mobility';
    push(withScope({ kind: 'DC_PRIORITY', params: { mode }, note: '损管优先级→' + mode }, wantShips(), isFleet));
    return cmds;
  }

  // ---- 2) 撤退 ----
  if (/撤退|撤离|脱离|退出战斗|转进|撤出|退出战区|避战/.test(s)) {
    push(withScope({ kind: 'WITHDRAW', params: {}, note: '脱离接触' }, wantShips(), isFleet));
    return cmds;
  }

  // ---- 3) 鱼雷 ----
  if (/鱼雷|雷击|放雷/.test(s)) {
    const tr = resolveTargetReference(s, world, side);
    const spread = /齐射|全部|所有|全管/.test(s) ? 6 : 4;
    const tubes = /单发|一发|一枚/.test(s) ? 1 : (ownTypes.includes('DD') ? 4 : 3);
    let bearing;
    if (/左舷|左舷侧/.test(s) && refShip) bearing = normDeg(refShip.heading - 90);
    if (/右舷|右舷侧/.test(s) && refShip) bearing = normDeg(refShip.heading + 90);
    const am = s.match(new RegExp('(' + NUM_RE + ')\\s*(?:枚|条|发)'));
    const n = am ? cnNumberToArabic(am[1]) : tubes;
    push(withScope({
      kind: 'LAUNCH_TORPEDO',
      params: { trackId: tr ? tr.id : null, bearing: bearing !== undefined ? bearing : undefined, spreadDeg: spread, tubes: n, speedIdx: 'HIGH' },
      note: '鱼雷齐射：' + n + ' 管，扇面 ' + spread + '°' + (tr ? '，对航迹 ' + tr.id : ''),
    }, (/全队|各舰|全(?:部|体)/.test(s) || ownShips_.length > 1) ? wantShips() : wantShips(), isFleet));
    if (!/之后|然后|接着/.test(s)) return cmds;
  }

  // ---- 4) 停火 ----
  if (/停火|停止射击|停射|停炮|哑火|别打|不要开火/.test(s)) {
    push(withScope({ kind: 'CEASE_FIRE', params: {}, note: '停火' }, wantShips(), isFleet));
    if (!/(然后|接着|并|再)/.test(s)) return cmds;
  }

  // ---- 5) 开火/齐射 ----
  if (/(开火|射击|炮击|拦阻|覆盖|齐射|火力压制|攻击|炮轰|击沉|试射|校射)/.test(s) && !/鱼雷|雷击/.test(s)) {
    const tr = resolveTargetReference(s, world, side);
    let ammo = 'AP';
    if (/高爆|榴弹|爆破弹|HE/i.test(s)) ammo = 'HE';
    else if (/半穿甲|SAP/i.test(s)) ammo = 'SAP';
    else if (/照明弹|星弹/.test(s)) ammo = 'ILLUM';
    let salvoes = Infinity;
    const sm = s.match(new RegExp('(' + NUM_RE + ')\\s*(?:轮|次|组)'));
    if (sm) { const n = cnNumberToArabic(sm[1]); if (n) salvoes = n; }
    if (/单发|试射|一发/.test(s)) salvoes = 1;
    push(withScope({
      kind: 'FIRE',
      params: { trackId: tr ? tr.id : null, ammo, salvoes, battery: /副炮|高炮/.test(s) ? 'secondary' : 'main' },
      note: '对' + (tr ? tr.id + '(' + (tr.classifiedAs || 'UNKNOWN') + ' @' + Math.round((tr.rangeM || 0) / 1000) + 'km)' : '最近航迹') + ' ' + ammo + ' 射击',
    }, wantShips(), isFleet));
    if (!(/然后|接着|再|并/.test(s) || /航向|转向|航速|速度|节|舵/.test(s))) return cmds;
  }

  // ---- 6) 指定目标 ----
  if (/指定目标|分配目标|目标为|主要目标/.test(s)) {
    const tr = resolveTargetReference(s, world, side);
    if (tr) push(withScope({ kind: 'ASSIGN_TARGET', params: { trackId: tr.id, ammo: /高爆|榴弹/.test(s) ? 'HE' : 'AP' }, note: '指定目标 ' + tr.id }, wantShips(), isFleet));
  }

  // ---- 7) 烟幕 ----
  if (/烟幕|放烟|拉烟|施放烟|烟障/.test(s)) {
    const off = /停(?:止)?|关(?:闭)?|散(?:去)?|不再/.test(s) && !/开(?:始)?放烟/.test(s);
    push(withScope({ kind: 'SMOKE', params: { on: !off }, note: off ? '停止施放烟幕' : '施放烟幕' }, wantShips(), isFleet));
  }

  // ---- 8) 探照灯 ----
  if (/探照灯|照射|照(?:亮|射)/.test(s)) {
    const off = /关(?:闭|掉)?|熄(?:灭)?|停止照射|不要照/.test(s);
    let bearing;
    const cw = s.match(/(?:方位|朝向|照向|向)([^,，。;；]{1,6}?)(?:方向|方位)?(?:度)?(?:开|亮|照|$)/);
    if (cw) { const c = compassToDeg(cw[1]); if (c !== null) bearing = c; }
    if (bearing === undefined) {
      const nm = s.match(new RegExp('(?:方位|方向|转到|照向)(' + NUM_RE + ')'));
      if (nm) { const d0 = cnNumberToArabic(nm[1]); if (d0 !== null && d0 >= 0 && d0 <= 360) bearing = normDeg(d0); }
    }
    push(withScope({ kind: 'SEARCHLIGHT', params: { on: !off, bearing: bearing !== undefined ? bearing : undefined }, note: off ? '关闭探照灯' : '开启探照灯' + (bearing !== undefined ? ' 方位' + Math.round(bearing) : '') }, wantShips(), isFleet));
  }

  // ---- 9) 雷达 / 声呐 / 照明弹 ----
  if (/雷达/.test(s)) {
    const off = /关(?:闭|机|掉)?|停(?:机|用)|静默|停止/.test(s);
    push(withScope({ kind: 'RADAR', params: { on: !off }, note: off ? '雷达关机/静默' : '雷达开机' }, wantShips(), isFleet));
  }
  if (/声呐|声纳|水听器|听音/.test(s)) {
    const off = /关(?:闭|机|掉)?|停(?:机|用)|停止/.test(s);
    push(withScope({ kind: 'SONAR', params: { on: !off }, note: off ? '声呐关机' : '声呐开机' }, wantShips(), isFleet));
  }
  if (/照明弹|星弹/.test(s)) {
    let bearing; let range;
    const bm = s.match(/(?:方位|方向)([0-9]{1,3})/); if (bm) bearing = +bm[1];
    const rm = s.match(/([0-9]{1,2}(?:\.\d)?)\s*(?:公里|千米|km)/i); if (rm) range = +rm[1] * 1000;
    push(withScope({ kind: 'STAR_SHELL', params: { bearing, range }, note: '发射照明弹' }, wantShips(), isFleet));
  }

  // ---- 10) 舵角（先于航向判断，避免"左转/右舵"混淆） ----
  if (/(左|右)(?:满舵|舵|转舵)/.test(s)) {
    const side_ = /左/.test(s) ? -1 : 1;
    let deg;
    const dm = s.match(new RegExp('(?:舵|转舵)(?:为|至|到)?(' + NUM_RE + ')'));
    if (dm) { const d0 = cnNumberToArabic(dm[1]); if (d0 !== null && d0 <= 40) deg = d0; }
    else if (/满舵/.test(s)) deg = refShip ? (refShip.data.rudderAngleMax_deg || 35) : 35;
    else deg = 10;
    push(withScope({ kind: 'SET_RUDDER', params: { deg: side_ * Math.abs(deg) }, note: (side_ < 0 ? '左舵 ' : '右舵 ') + Math.abs(deg) + '°' }, wantShips(), isFleet));
  } else if (/正舵|回舵|舵正|舵归零/.test(s)) {
    push(withScope({ kind: 'SET_RUDDER', params: { deg: 0 }, note: '正舵' }, wantShips(), isFleet));
  }

  // ---- 11) 航向 ----
  {
    const m = s.match(new RegExp('(?:航向|转向|改向|改航|取|转至|驶向|朝向|course)(?:为|至|到)?(' + NUM_RE + '|东北|东南|西南|西北|北|东|南|西)(?:度|°)?'));
    const rel = s.match(/(左|右)转([0-9]{1,3})/);
    if (m) {
      const numStr = m[1];
      let deg = compassToDeg(numStr);
      if (deg === null) deg = cnNumberToArabic(numStr);
      if (deg !== null && deg >= 0) {
        deg = normDeg(deg);
        push(withScope({ kind: 'SET_COURSE', params: { heading: deg }, note: '航向 ' + String(Math.round(deg)).padStart(3, '0') }, wantShips(), isFleet));
      }
    } else if (rel) {
      const base = refShip ? refShip.heading : 0;
      const delta = (rel[1] === '左' ? -1 : 1) * (+rel[2]);
      push(withScope({ kind: 'SET_COURSE', params: { heading: normDeg(base + delta) }, note: '相对转向 ' + rel[1] + delta + '°' }, wantShips(), isFleet));
    }
  }

  // ---- 12) 速度 ----
  {
    let kn = null, note = null;
    const m = s.match(new RegExp('(' + NUM_RE + ')\\s*(?:节|kn|海里每小时)', 'i'));
    if (m) { kn = cnNumberToArabic(m[1]); note = '航速 ' + kn + ' 节'; }
    else if (/全速|最大航速|最高航速|增速至最大|开到最大/.test(s)) { kn = refShip ? (refShip.data.speedMax_kn || 30) : 30; note = '全速'; }
    else if (/半速/.test(s)) { kn = refShip ? (refShip.data.speedMax_kn || 30) * 0.5 : 15; note = '半速'; }
    else if (/巡航|经济航速/.test(s)) { kn = refShip ? (refShip.data.speedMax_kn || 30) * 0.62 : 12; note = '巡航速度'; }
    else if (/微速|慢速|低速/.test(s)) { kn = 5; note = '微速'; }
    else if (/停车|停船|停机|停车漂航|停止前进/.test(s)) { kn = 0; note = '停车'; }
    else if (/倒车|后退/.test(s)) { kn = 0; note = '倒车（仿真下限 0 节）'; }
    else if (/(增速|加速)/.test(s) && refShip) { kn = clamp(refShip.speed + 5, 0, refShip.data.speedMax_kn || 30); note = '增速 +5 节'; }
    else if (/(减速|降低航速)/.test(s) && refShip) { kn = clamp(refShip.speed - 5, 0, refShip.data.speedMax_kn || 30); note = '减速 -5 节'; }
    if (kn !== null && kn !== undefined) {
      const mx = refShip ? (refShip.data.speedMax_kn || 30) : 35;
      push(withScope({ kind: 'SET_SPEED', params: { kn: clamp(kn, 0, mx) }, note }, wantShips(), isFleet));
    }
  }

  // ---- 13) 编队 ----
  {
    const fm = s.match(/(?:编队|队形|跟随|占据|阵位)(?:为|至|到)?([0-9]{1,3})?(?:度|°)?(?:方位)?(?:距离)?([0-9]+)?/);
    if (fm && /编队|队形|跟随|阵位/.test(s)) {
      const bearing = fm[1] ? normDeg(+fm[1]) : 0;
      const rangeM = fm[2] ? +fm[2] : 800;
      push(withScope({ kind: 'FORMATION', params: { station: { bearingDeg: bearing, rangeM } }, note: '编队阵位' }, wantShips(), isFleet));
    }
  }

  return cmds;
}

/**
 * 舰队级命令展开：把 scope='FLEET' 且无 shipId 的命令按本方在役舰展开为逐舰命令。
 * 由 bridge.submitDecision / UI 调用（world._applyOne 只认 shipId）。
 * 舰队级命令保留 scope='FLEET'，从而保留 world.issueCommand 的 +5s 指挥延迟（契约 §0.8）。
 */
export function expandFleetCommands(world, side, cmds) {
  const out = [];
  const ships = ownShips(world, side);
  for (const c of cmds || []) {
    if (!c || !c.kind) continue;
    if (c.kind === 'CHAT' || c.kind === 'SET_SCREEN') { out.push(c); continue; }
    if (c.shipId || (c.shipIds && c.shipIds.length)) {
      if (!c.shipId && c.shipIds) { for (const id of c.shipIds) out.push(Object.assign({}, c, { shipId: id, shipIds: undefined })); }
      else out.push(c);
      continue;
    }
    if (!ships.length) { out.push(c); continue; }
    for (const s of ships) out.push(Object.assign({}, c, { shipId: s.id }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM 兜底
// ---------------------------------------------------------------------------
const COMMAND_SPEC = [
  'SET_COURSE {heading:0-359}', 'SET_SPEED {kn:0-40}', 'SET_RUDDER {deg:-35..35}',
  'FIRE {trackId, ammo:"AP"|"HE"|"SAP", salvoes:数字或null表示持续}',
  'CEASE_FIRE {}', 'LAUNCH_TORPEDO {trackId|null, bearing, spreadDeg, tubes}',
  'SMOKE {on:bool}', 'SEARCHLIGHT {on:bool,bearing}', 'RADAR {on:bool}', 'SONAR {on:bool}',
  'STAR_SHELL {bearing,range}', 'DC_PRIORITY {mode:"flooding"|"fire"|"magazine"|"mobility"}',
  'WITHDRAW {}', 'ASSIGN_TARGET {trackId,ammo}', 'FORMATION {station:{bearingDeg,rangeM}}',
  'CHAT {text}',
];

/** 生成 LLM 提示（系统+用户）。返回可直接用于 /api/llm/chat 的 messages 数组。 */
export function buildLLMPrompt(world, side, text) {
  const sit = describeSituation(world, side);
  const system = [
    '你是 1942 年太平洋战场的舰队指挥官参谋。只输出 JSON，不要解释，不要 Markdown 代码块。',
    '输出格式：{"reasoning":"简短中文推演","chat":"可选的简短中文口令","commands":[{"kind":"...","params":{...},"shipId":"可选舰id"}]}',
    '可用 kind 与参数：' + COMMAND_SPEC.join('；') + '。',
    '红线：1942 年没有导弹、直升机、卫星、GPS、现代数据链；只能用舰炮、鱼雷、烟幕、探照灯、雷达(早期)、光学测距与灯光/旗语。',
    '只能依据给出的"可见态势"行动，不得假设未探测到的敌舰位置。舰队级命令省略 shipId。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: '【可见态势】\n' + sit + '\n\n【指挥官指令】\n' + String(text || '') + '\n\n请输出 JSON。' },
  ];
}

/** LLM 兜底解析：先规则，未命中再调 llmCall。返回 {commands, chat, reasoning, via} */
export async function parseOrderSmart(text, world, side, opts = {}) {
  const cmds = parseChineseOrder(text, world, side);
  if (cmds.length || !opts.llmCall) return { commands: cmds, via: 'RULES', chat: '', reasoning: '' };
  try {
    const messages = opts.messages || buildLLMPrompt(world, side, text);
    const raw = await opts.llmCall({ messages, side, text });
    const dec = parseDecisionJSON(raw);
    if (!dec) return { commands: [], via: 'LLM_FAILED', chat: '', reasoning: '' };
    return { commands: dec.commands, chat: dec.chat, reasoning: dec.reasoning, via: 'LLM' };
  } catch (e) {
    return { commands: [], via: 'LLM_ERROR', error: String((e && e.message) || e), chat: '', reasoning: '' };
  }
}

// ---------------------------------------------------------------------------
// 决策 JSON 解析（容错）
// ---------------------------------------------------------------------------
const KIND_ALIAS = {
  SET_COURSE: 'SET_COURSE', 航向: 'SET_COURSE', 转向: 'SET_COURSE', COURSE: 'SET_COURSE',
  SET_SPEED: 'SET_SPEED', 速度: 'SET_SPEED', 航速: 'SET_SPEED', SPEED: 'SET_SPEED',
  SET_RUDDER: 'SET_RUDDER', 舵: 'SET_RUDDER', 舵角: 'SET_RUDDER', RUDDER: 'SET_RUDDER',
  FIRE: 'FIRE', 开火: 'FIRE', 射击: 'FIRE', 炮击: 'FIRE',
  CEASE_FIRE: 'CEASE_FIRE', 停火: 'CEASE_FIRE', HOLD_FIRE: 'CEASE_FIRE',
  LAUNCH_TORPEDO: 'LAUNCH_TORPEDO', 鱼雷: 'LAUNCH_TORPEDO', 发射鱼雷: 'LAUNCH_TORPEDO', TORPEDO: 'LAUNCH_TORPEDO',
  SMOKE: 'SMOKE', 烟幕: 'SMOKE', 放烟: 'SMOKE',
  SEARCHLIGHT: 'SEARCHLIGHT', 探照灯: 'SEARCHLIGHT',
  RADAR: 'RADAR', 雷达: 'RADAR', SONAR: 'SONAR', 声呐: 'SONAR', 声纳: 'SONAR',
  STAR_SHELL: 'STAR_SHELL', 照明弹: 'STAR_SHELL',
  DC_PRIORITY: 'DC_PRIORITY', 损管: 'DC_PRIORITY',
  DAMAGE_CONTROL: 'DAMAGE_CONTROL',
  WITHDRAW: 'WITHDRAW', 撤退: 'WITHDRAW', RETREAT: 'WITHDRAW',
  ASSIGN_TARGET: 'ASSIGN_TARGET', 指定目标: 'ASSIGN_TARGET',
  FORMATION: 'FORMATION', 编队: 'FORMATION',
  SET_SCREEN: 'SET_SCREEN', PLOT_COURSE: 'PLOT_COURSE',
  CHAT: 'CHAT', 聊天: 'CHAT',
};

/** 单个命令归一化：kind 别名、参数类型强制、非法值丢弃 */
export function normalizeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  let kind = c.kind || c.type || c.command || c.action || '';
  const key = String(kind).trim();
  kind = KIND_ALIAS[key] || KIND_ALIAS[key.toUpperCase()] || KIND_ALIAS[key.toLowerCase()] ||
    KIND_ALIAS[Object.keys(KIND_ALIAS).find((k) => k.toUpperCase() === key.toUpperCase())] || null;
  if (!kind) return null;
  const p = Object.assign({}, c.params || c.args || {});
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (v !== undefined && v !== null && v !== '' && isFinite(+v) ? +v : undefined));
  switch (kind) {
    case 'SET_COURSE': { const h = num(p.heading !== undefined ? p.heading : p.course); if (h === undefined) return null; p.heading = normDeg(h); break; }
    case 'SET_SPEED': { const k = num(p.kn !== undefined ? p.kn : p.speed); if (k === undefined) return null; p.kn = clamp(k, 0, 45); break; }
    case 'SET_RUDDER': { const d = num(p.deg !== undefined ? p.deg : p.rudder); if (d === undefined) return null; p.deg = clamp(d, -40, 40); break; }
    case 'FIRE': {
      if (p.trackId === undefined) p.trackId = p.track || null;
      p.ammo = /^(AP|HE|SAP|STAR|ILLUM|AA)$/i.test(String(p.ammo || 'AP')) ? String(p.ammo || 'AP').toUpperCase() : 'AP';
      if (p.salvoes === undefined || p.salvoes === null || p.salvoes === 'Infinity' || p.salvoes === '') p.salvoes = Infinity;
      else if (isFinite(+p.salvoes)) p.salvoes = +p.salvoes;
      else p.salvoes = Infinity;
      break;
    }
    case 'LAUNCH_TORPEDO': {
      if (p.trackId === undefined) p.trackId = p.track || null;
      if (num(p.bearing) !== undefined) p.bearing = normDeg(num(p.bearing));
      p.spreadDeg = num(p.spreadDeg) !== undefined ? clamp(num(p.spreadDeg), 0, 20) : 4;
      p.tubes = num(p.tubes) !== undefined ? clamp(Math.round(num(p.tubes)), 1, 10) : 3;
      break;
    }
    case 'SMOKE': case 'SEARCHLIGHT': case 'RADAR': case 'SONAR': {
      let on = p.on;
      if (typeof on === 'string') on = /^(1|true|on|开|开启|yes|是)$/i.test(on);
      p.on = !!on;
      if (kind === 'SEARCHLIGHT' && num(p.bearing) !== undefined) p.bearing = normDeg(num(p.bearing));
      break;
    }
    case 'DC_PRIORITY': {
      const m = String(p.mode || 'flooding').toLowerCase();
      p.mode = ['flooding', 'fire', 'magazine', 'mobility'].includes(m) ? m : 'flooding';
      break;
    }
    case 'STAR_SHELL': {
      if (num(p.bearing) !== undefined) p.bearing = normDeg(num(p.bearing));
      if (num(p.range) !== undefined) p.range = Math.max(0, num(p.range));
      break;
    }
    case 'FORMATION': {
      const st = p.station || {};
      p.station = { bearingDeg: normDeg(num(st.bearingDeg) || 0), rangeM: Math.max(100, num(st.rangeM) || 800) };
      break;
    }
    case 'CHAT': if (typeof p.text !== 'string') return null; break;
    default: break;
  }
  const out = { kind, params: p, note: c.note || c.reason || '' };
  let shipId = c.shipId || c.ship || null;
  if (!shipId && Array.isArray(c.shipIds) && c.shipIds.length === 1) shipId = c.shipIds[0];
  if (shipId) out.shipId = String(shipId);
  if (Array.isArray(c.shipIds) && c.shipIds.length) out.shipIds = c.shipIds.map(String);
  if (c.scope === 'FLEET' || c.scope === 'SHIP') out.scope = c.scope;
  return out;
}

/** 把 LLM 返回的文本/对象统一成 {commands, chat, reasoning}；失败返回 null */
export function parseDecisionJSON(raw) {
  if (raw === undefined || raw === null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    let s = raw.trim();
    if (!s) return null;
    s = s.replace(/^\x60\x60\x60(?:json|JSON)?/, '').replace(/\x60\x60\x60\s*$/, '').trim();
    obj = tryJSON(s);
    if (!obj) {
      const start = s.indexOf('{');
      if (start >= 0) {
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
          if (ch === '"') { inStr = true; continue; }
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > 0) obj = tryJSON(s.slice(start, end + 1));
      }
    }
    if (!obj) return null;
  }
  if (Array.isArray(obj)) obj = { commands: obj };
  if (obj.decision && typeof obj.decision === 'object' && !obj.commands) {
    obj = Object.assign({}, obj.decision, { chat: obj.chat || obj.decision.chat, reasoning: obj.reasoning || obj.decision.reasoning });
  }
  const arr = obj.commands || obj.orders || obj.actions || null;
  const commands = [];
  if (Array.isArray(arr)) for (const c of arr) { const n = normalizeCommand(c); if (n) commands.push(n); }
  const chat = typeof obj.chat === 'string' ? obj.chat : (typeof obj.message === 'string' ? obj.message : '');
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : (typeof obj.thought === 'string' ? obj.thought : '');
  if (!commands.length && !chat && !reasoning) return null;
  return { commands, chat, reasoning };
}

function tryJSON(s) {
  try { return JSON.parse(s); } catch { /* 尝试修复尾逗号 */ }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 中文态势简报
// ---------------------------------------------------------------------------
const SIDE_ZH = { ALLIED: '同盟国', AXIS: '轴心国' };
const TYPE_ZH = { BB: '战列舰', BC: '战列巡洋舰', CA: '重巡洋舰', CL: '轻巡洋舰', DD: '驱逐舰', CV: '航空母舰', UNKNOWN: '未识别舰' };

export function typeZh(t) { return TYPE_ZH[String(t || 'UNKNOWN').toUpperCase()] || String(t || '未知'); }
export function fmtClock(t) {
  const s = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
function pad3(d) { return String(Math.round(normDeg(d || 0))).padStart(3, '0'); }

/** 生成中文态势简报（供 LLM 提示与 UI 显示）。只含该方可见信息。 */
export function describeSituation(world, side) {
  if (!world || !side) return '（无态势数据）';
  let st;
  try { st = world.visibleStateFor(side); } catch (e) { return '（态势不可用：' + (e && e.message) + '）'; }
  const L = [];
  L.push('== 铁海 1942 态势简报 ==');
  L.push('剧本：' + (st.scenario && (st.scenario.nameZh || st.scenario.id)) + '  方：' + (SIDE_ZH[side] || side) + '  仿真时刻：T+' + fmtClock(st.t));
  if (st.scenario && st.scenario.mission) L.push('任务：' + st.scenario.mission);
  const e = st.environment || {};
  L.push('环境：海况 ' + e.seaState + ' 级（道格拉斯），风 ' + e.windKn + ' 节 来向 ' + pad3(e.windDirDeg) + '°，能见度 ' + e.visibilityNm + ' 海里，光照 ' + e.lightLevel
    + '，日出 ' + (e.sunriseH !== undefined ? (+e.sunriseH).toFixed(1) : '?') + 'h 日落 ' + (e.sunsetH !== undefined ? (+e.sunsetH).toFixed(1) : '?') + 'h');
  L.push('');
  L.push('【本方编队】' + (st.ownShips ? st.ownShips.length : 0) + ' 舰：');
  for (const s of (st.ownShips || [])) {
    const dmg = [];
    if (s.floodedPct > 0.5) dmg.push('进水 ' + s.floodedPct + '%');
    if (s.fires) dmg.push('火灾 ' + s.fires + ' 处');
    if (Math.abs(s.list) > 2) dmg.push((s.list > 0 ? '右倾 ' : '左倾 ') + Math.abs(s.list) + '°');
    if (!s.isAfloat) dmg.push('已沉没'); else if (s.sinking) dmg.push('正在下沉');
    if (s.speedCapKn !== undefined && s.speed < s.speedCapKn - 2) dmg.push('速度受限≤' + s.speedCapKn + '节');
    const cmd = s.commanded || {};
    L.push('- ' + s.name + '（' + typeZh(s.type) + '，' + s.id + '）：航向 ' + pad3(s.heading) + '° 航速 ' + s.speed + ' 节'
      + '，已令 航向' + pad3(cmd.heading) + '°/' + (cmd.speed !== undefined ? cmd.speed : '?') + '节' + (cmd.firing ? ' 射击中' : '')
      + '，舵 ' + (s.rudder || 0) + '°，稳性 GM ' + (s.effectiveGM !== undefined ? s.effectiveGM : '?') + ' m'
      + (dmg.length ? '，损况：' + dmg.join('、') : '，损况良好'));
  }
  L.push('');
  const tr = st.tracks || [];
  L.push('【已探测目标】' + tr.length + ' 个航迹（雾里看花：仅有航迹，无真值）：');
  if (!tr.length) L.push('- 无');
  for (const t of tr) {
    L.push('- ' + t.id + '：方位 ' + pad3(t.bearingDeg) + '° 距离 ' + (t.rangeM / 1000).toFixed(1) + ' km，判型 ' + typeZh(t.classifiedAs)
      + '，航向 ' + pad3(t.courseDeg) + '° 航速 ' + t.speedKn + ' 节，置信 ' + t.confidence + '，识别度 ' + (t.idConfidence !== undefined ? t.idConfidence : '?')
      + '，误差 ±' + t.errM + 'm/±' + t.errDeg + '°，来源 ' + (t.sources || []).join('+') + '，更新于 ' + t.ageS + 's 前');
  }
  const evs = (st.recentEvents || []).slice(-8);
  if (evs.length) {
    L.push('');
    L.push('【近报】');
    for (const ev of evs) {
      const d = ev.data || {};
      const bits = [];
      for (const k of ['name', 'ship', 'target', 'text', 'result', 'compartment']) if (d[k] !== undefined) bits.push(k + '=' + d[k]);
      if (d.rangeM !== undefined) bits.push('距离 ' + Math.round(d.rangeM) + 'm');
      L.push('- T+' + fmtClock(ev.t) + ' ' + ev.type + ' ' + bits.join(' '));
    }
  }
  return L.join('\n');
}

export default { parseChineseOrder, parseOrderSmart, describeSituation, parseDecisionJSON, normalizeCommand, expandFleetCommands, buildLLMPrompt, resolveTargetReference, resolveOwnShipReference, visibleTracks };
