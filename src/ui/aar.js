// 战后报告（AAR）：弹药消耗、命中率、夹叉率、进水与火灾时间线、关键事件，可导出。
import { esc } from './esc.js';
import { fmtClockHM } from '../core/util.js';

const SIDE_ZH = { ALLIED: '同盟国', AXIS: '轴心国' };
const TYPE_ZH = { BB: '战列舰', BC: '战列巡洋舰', CA: '重巡洋舰', CL: '轻巡洋舰', DD: '驱逐舰', CV: '航空母舰' };

// 弹药库事件 result → 中文文案（与 server/headless.mjs 的 MAGAZINE_RESULT_ZH 保持一致）。
// 旧版一律写"弹药库殉爆"：result='hit'（弹药库被命中但未殉爆）也被谎报成殉爆，
// 'burn'（爆燃）、'flooded'（注水）、'flash'（炮塔闪爆）同样被误写。
export const MAGAZINE_RESULT_ZH = {
  detonation: '殉爆', burn: '爆燃', flooded: '注水', flash: '炮塔闪爆', hit: '被命中', fire_threat: '受威胁',
};

export function magazineText(shipName, result) {
  return (shipName || '?') + ' 弹药库' + (MAGAZINE_RESULT_ZH[result] || '受损');
}

// 时间线事件与重要度：旧版只收 sink/magazine/straddle/torp.hit/fire，普通炮战只剩夹叉；
// 现在把沉没/倾覆、弹药库各结果、鱼雷命中/哑弹、穿甲、普通命中、起火、结局都收进来，
// 命中按"同一目标 5 秒内去重"，超长时按重要度取前 400 条再按时间排列。
const TIMELINE_RANK = {
  'victory.achieved': 100, 'ship.sink': 100, 'ship.capsize': 96, 'dam.magazine': 92,
  'torp.hit': 90, 'torp.dud': 86, 'gun.penetration': 78, 'dam.fire': 60, 'gun.hit': 66,
};
const TIMELINE_MAX = 400;
const GUN_HIT_DEDUPE_S = 5;
// 分类型配额：重炮战里 gun.penetration 可能上千条，按纯重要度排序会把 gun.hit 全部挤出 cap，
// 于是"普通交战只剩夹叉/穿甲"的老问题会以另一种形式复现。给高频类型设上限，保证各类都有代表。
const TIMELINE_QUOTA = {
  'gun.penetration': 120, 'gun.hit': 120, 'dam.fire': 60, 'torp.hit': 80, 'torp.dud': 40,
  'dam.magazine': 80, 'ship.sink': 40, 'ship.capsize': 20, 'victory.achieved': 5,
};

export function describeEvent(e, per) {
  const shipName = (per && per[e.ship] && per[e.ship].name) || e.name || e.ship || '?';
  const atkName = e.byShipName || (e.shooter && per && per[e.shooter] && per[e.shooter].name) || '';
  switch (e.type) {
    case 'ship.sink': return shipName + ' 沉没' + (e.cause ? '（' + e.cause + '）' : '');
    case 'ship.capsize': return shipName + ' 倾覆';
    case 'dam.magazine': return magazineText(shipName, e.result);
    case 'torp.hit': return shipName + ' 被鱼雷命中' + (atkName ? '（' + atkName + '）' : '');
    case 'torp.dud': return shipName + ' 被鱼雷命中但哑弹';
    case 'gun.penetration':
      return shipName + ' 被击穿' + (atkName ? '（' + atkName + (e.caliberMM ? ' ' + e.caliberMM + 'mm' : '') + '）' : '')
        + (e.penetrationMM ? '，穿深 ' + e.penetrationMM + 'mm / 装甲 ' + (e.armorMM || 0) + 'mm' : '');
    case 'gun.hit': return shipName + ' 被命中' + (atkName ? '（' + atkName + '）' : '');
    case 'dam.fire': return shipName + ' 起火（舱段 ' + (e.compartment === null || e.compartment === undefined ? '?' : e.compartment) + '）';
    case 'victory.achieved': return '交战结束：' + (e.text || e.winner);
    default: return e.type;
  }
}

function pickTimeline(ev, world, per) {
  const cand = [];
  const lastHitT = new Map();
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    const rank = TIMELINE_RANK[e.type];
    if (rank === undefined) continue;
    const t = e.t === null ? world.t : e.t;
    if (e.type === 'gun.hit') {          // 同一目标 5s 内的连续命中只留第一条
      const key = e.ship || e.name || '?';
      const prev = lastHitT.get(key);
      if (prev !== undefined && t - prev < GUN_HIT_DEDUPE_S) continue;
      lastHitT.set(key, t);
    }
    cand.push({ e, i, rank, t });
  }
  cand.sort((a, b) => b.rank - a.rank || b.i - a.i);
  const picked = [];
  const used = {};
  for (const c of cand) {
    if (picked.length >= TIMELINE_MAX) break;
    const quota = TIMELINE_QUOTA[c.e.type];
    if (quota !== undefined && (used[c.e.type] || 0) >= quota) continue;
    used[c.e.type] = (used[c.e.type] || 0) + 1;
    picked.push(c);
  }
  picked.sort((a, b) => a.i - b.i);
  return picked.map(({ e, t }) => ({ t, type: e.type, text: describeEvent(e, per) }));
}

export function collectAAR(world) {
  const bus = world.events || {};
  const ev = bus.history || [];
  const counts = {};
  for (const e of ev) counts[e.type] = (counts[e.type] || 0) + 1;
  const kept = Object.assign({}, counts);
  // 统计口径：优先用 EventBus 累计 emit 次数（事件历史按"关键事件优先"保留，噪声会被淘汰），
  // 避免长局里因历史截断把统计少算成"没发生"。
  if (bus.emitted) for (const k of Object.keys(bus.emitted)) counts[k] = bus.emitted[k];
  const per = {};
  for (const s of world.ships) {
    per[s.id] = {
      name: s.name, side: s.side, type: s.type, shots: s.stats.shotsFired, hits: s.stats.hits,
      taken: s.stats.hitsTaken, nearMisses: 0,
      torps: s.stats.torpedoesFired, torpHits: s.stats.torpHits,
      straddles: s.stats.straddles, flooding: Math.round(s.floodedM3), sunk: !s.isAfloat,
      killed: world.commands.filter((c) => c.shipId === s.id).length,
    };
  }
  // 近失弹单独计列（gun.nearmiss）；"被命中"口径以 sim 层 stats.hitsTaken 为准
  for (const e of ev) if (e.type === 'gun.nearmiss' && e.ship && per[e.ship]) per[e.ship].nearMisses++;
  const timeline = pickTimeline(ev, world, per);
  return {
    counts, kept, per, timeline, duration: world.t, winner: world.winner, text: world.resultText,
    retention: typeof bus.retention === 'function' ? bus.retention() : null,
  };
}

export function buildAAR(world) {
  const a = collectAAR(world);
  const win = world.winner === 'ALLIED' || world.winner === 'AXIS' ? (SIDE_ZH[world.winner] || world.winner) : (world.winner || '未分胜负');
  const summary = String(world.resultText || '').trim();
  let h = '<h2>战报 · ' + esc(world.scenario.nameZh || world.scenario.id) + '</h2>';
  h += '<div class="lead">结局：<b style="color:var(--brass-2)">' + esc(win) + '</b>' +
    (summary ? ' —— ' + esc(summary) : '') +
    ' · 历时 ' + fmtClockHM(a.duration) + ' · 随机种子 ' + world.seed + '</div>';

  const ids = Object.keys(a.per);
  const sunkA = ids.filter((id) => a.per[id].sunk && a.per[id].side === 'ALLIED').length;
  const sunkX = ids.filter((id) => a.per[id].sunk && a.per[id].side === 'AXIS').length;
  let shots = 0, hits = 0, straddles = 0;
  for (const id of ids) { shots += a.per[id].shots; hits += a.per[id].hits; straddles += a.per[id].straddles; }
  h += '<div class="grid2" style="gap:10px;margin:4px 0 16px">' +
    '<div class="stat"><span>同盟国损失</span><b class="n">' + sunkA + '<small>艘</small></b></div>' +
    '<div class="stat"><span>轴心国损失</span><b class="n">' + sunkX + '<small>艘</small></b></div>' +
    '<div class="stat"><span>命中 / 发射</span><b class="n">' + hits + '<small>/ ' + shots + '</small></b></div>' +
    '<div class="stat"><span>命中率 / 夹叉</span><b class="n">' + (shots ? (100 * hits / shots).toFixed(1) : '0') + '<small>% / ' + straddles + '</small></b></div>' +
    '</div>';

  // 逐舰表：被命中列之后新增"近失"列（以 sim 层 stats.hitsTaken 为被命中口径，近失单列不混算）
  h += '<h4>逐舰明细</h4><table><thead><tr><th>舰名</th><th>阵营</th><th>舰种</th><th class="n">发射</th><th class="n">命中</th><th class="n">被命中</th><th class="n">近失</th><th class="n">鱼雷/命中</th><th class="n">夹叉</th><th class="n">进水m³</th><th>结局</th></tr></thead><tbody>';
  for (const id of ids) {
    const p = a.per[id];
    h += '<tr><td class="nm">' + esc(p.name) + '</td><td>' + esc(SIDE_ZH[p.side] || p.side) + '</td><td>' + esc(TYPE_ZH[p.type] || p.type) + '</td>' +
      '<td class="n">' + p.shots + '</td><td class="n">' + p.hits + '</td><td class="n">' + p.taken + '</td><td class="n">' + p.nearMisses + '</td><td class="n">' + p.torps + '/' + p.torpHits + '</td>' +
      '<td class="n">' + p.straddles + '</td><td class="n">' + p.flooding + '</td>' +
      '<td>' + (p.sunk ? '<span class="pill bad">沉没</span>' : '<span class="pill ok">在航</span>') + '</td></tr>';
  }
  h += '</tbody></table>';
  h += '<div class="small" style="margin-top:4px">被命中 = 本舰被弹（不含近失；口径以 sim 层 stats.hitsTaken 为准）。近失 = 舷外水中爆炸（gun.nearmiss），会造成舷侧变形与进水但不计入被命中。</div>';

  h += '<h4>关键事件时间线</h4><div class="tl">';
  if (a.timeline.length) for (const e of a.timeline) h += '<div>' + fmtClockHM(e.t) + ' · ' + esc(e.text) + '</div>';
  else h += '<div>本次交战没有记录到关键事件。</div>';
  h += '</div>';

  h += '<h4 style="margin-top:16px">事件统计</h4><div class="small">';
  const keys = Object.keys(a.counts).sort((x, y) => a.counts[y] - a.counts[x]).slice(0, 22);
  for (const k of keys) h += '<span class="tag" style="margin:2px 3px 2px 0;display:inline-block">' + esc(k) + ' ' + a.counts[k] + '</span>';
  h += '</div>';
  if (a.retention) {
    const r = a.retention;
    h += '<div class="small" style="margin-top:6px">事件历史保留：累计 emit ' + r.totalEmitted + ' 条 / 历史 ' + r.history + ' 条（噪声淘汰 ' + r.droppedNoise + '，关键丢失 ' + r.droppedCritical + '）'
      + ' · 首个关键事件 T+' + (r.firstCriticalT === null ? '—' : r.firstCriticalT) + 's</div>';
    if (r.droppedCritical > 0) h += '<div class="small" style="color:var(--bad,#c33)">警示：有 ' + r.droppedCritical + ' 条关键事件因历史上限被丢弃，战报统计可能不完整。</div>';
  }

  h += '<h4 style="margin-top:16px">对照历史</h4><div class="small">' + esc(world.scenario.historicalNote || '（本剧本未提供史实注记）') + '</div>';
  h += '<div class="acts">' +
    '<button class="btn primary" data-act="extend">继续交战 +30 分钟</button>' +
    '<button class="btn" data-act="export-aar">导出战报 JSON</button>' +
    '<button class="btn" data-act="export-replay">导出完整回放</button>' +
    '<button class="btn" data-act="close-overlay">关闭</button>' +
    '</div>';
  h += '<div class="small" style="margin-top:10px">把导出的回放交给 AI 可以复盘：用 GET /api/stream 订阅，或直接喂给智能体（协议见 AI_INTERFACE.md）。</div>';
  return h;
}
