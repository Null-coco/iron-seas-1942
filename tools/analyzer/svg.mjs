// ============================================================================
// 回放分析器 · 图表层（纯 SVG 字符串，无 DOM / 无依赖）
// ----------------------------------------------------------------------------
// 三张通用图：
//   trackChart()   航迹图：每舰一条轨迹 + 起终点 + 沉没点
//   rangeChart()   距离曲线：编队质心距 + 最近舰距 + 关键竖线
//   damageStrip()  中弹条带：每舰一行，按时间标出炮击/鱼雷命中（友军单独标色）
// 所有坐标来自回放快照；快照缺失时返回 null，由渲染层跳过该图。
// ============================================================================
import { fmtClock, fmtNum, round1, sideZh } from './core.mjs';

const SIDE_COLOR = { ALLIED: '#2f6fb2', AXIS: '#b23a2e', NEUTRAL: '#6b675e' };
const EXTRA_COLORS = ['#3f6b4a', '#a97b1e', '#6b4a8a', '#2f7f7a'];
export function sideColor(side, i = 0) { return SIDE_COLOR[side] || EXTRA_COLORS[i % EXTRA_COLORS.length]; }

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

function shipColor(model, ship, idx) {
  return sideColor(ship.side, Object.keys(model.sides).indexOf(ship.side));
}

// ── 航迹图 ──────────────────────────────────────────────────────────────────
export function trackChart(model, opts = {}) {
  const frames = model.frames || [];
  if (!frames.length) return null;
  const W = opts.width || 1180;
  const H = opts.height || 760;
  const mx = 56, my = 44;
  const pts = [];
  for (const f of frames) for (const s of (f.ships || [])) pts.push(s);
  if (!pts.length) return null;
  const xmin = Math.min(...pts.map((p) => p.x)) - 400, xmax = Math.max(...pts.map((p) => p.x)) + 400;
  const ymin = Math.min(...pts.map((p) => p.y)) - 400, ymax = Math.max(...pts.map((p) => p.y)) + 400;
  const sc = Math.min((W - 2 * mx) / (xmax - xmin), (H - 2 * my - 28) / (ymax - ymin));
  const ox = mx + ((W - 2 * mx) - (xmax - xmin) * sc) / 2;
  const oy = my + ((H - 2 * my - 28) - (ymax - ymin) * sc) / 2;
  const X = (x) => ox + (x - xmin) * sc;
  const Y = (y) => H - oy - (y - ymin) * sc;
  const o = [];
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="航迹图">');
  o.push('<rect width="' + W + '" height="' + H + '" fill="#fbf9f4"/>');
  o.push('<rect x="' + (mx - 14) + '" y="' + (my - 14) + '" width="' + (W - 2 * mx + 28) + '" height="' + (H - 2 * my + 20) + '" fill="#f2efe6" stroke="#d8d2c2"/>');
  for (let k = Math.ceil(xmin / 1000) * 1000; k <= xmax; k += 1000) {
    o.push('<line x1="' + n1(X(k)) + '" y1="' + n1(Y(ymin)) + '" x2="' + n1(X(k)) + '" y2="' + n1(Y(ymax)) + '" stroke="#e3ddcf"/>');
    if (k > xmin + 200 && k < xmax - 200) o.push('<text x="' + n1(X(k)) + '" y="' + n1(Y(ymin) + 15) + '" font-size="10" fill="#9a958a" text-anchor="middle">' + (k / 1000) + '</text>');
  }
  for (let k = Math.ceil(ymin / 1000) * 1000; k <= ymax; k += 1000) {
    o.push('<line x1="' + n1(X(xmin)) + '" y1="' + n1(Y(k)) + '" x2="' + n1(X(xmax)) + '" y2="' + n1(Y(k)) + '" stroke="#e3ddcf"/>');
    if (k > ymin + 200 && k < ymax - 200) o.push('<text x="' + n1(X(xmin) - 8) + '" y="' + n1(Y(k) + 3) + '" font-size="10" fill="#9a958a" text-anchor="end">' + (k / 1000) + '</text>');
  }
  o.push('<text x="' + n1(X(xmin)) + '" y="' + n1(Y(ymin) + 30) + '" font-size="10" fill="#8a857a">km（东→ / 北↑）</text>');

  const sunkIds = new Set(model.ships.filter((s) => s.sank).map((s) => s.id));
  // 简易标签避让：终点常常挤在一起（沉没点、追击终点），按候选位置找空位
  const placed = [];
  const dispW = (str) => { let w = 0; for (const ch of String(str)) w += (ch.codePointAt(0) > 0x2e7f ? 11.5 : 6.5); return w; };
  function placeLabel(x, y, text) {
    const w = dispW(text), h = 13;
    const cands = [[9, -8], [9, 10], [-9, -8], [-9, 10], [9, 24], [-9, 24], [9, -24], [-9, -24], [26, -8], [-26, -8], [26, 18], [-26, 18]];
    for (const c of cands) {
      const anchor = c[0] < 0 ? 'end' : 'start';
      const lx = x + c[0], ly = y + c[1];
      const box = { x: anchor === 'end' ? lx - w : lx, y: ly - h + 3, w, h };
      if (!placed.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) {
        placed.push(box);
        return { lx, ly, anchor };
      }
    }
    return { lx: x + 9, ly: y - 8, anchor: 'start' };
  }
  for (const sh of model.ships) {
    const track = [];
    for (const f of frames) { const s = (f.ships || []).find((x) => x.id === sh.id); if (s) track.push(s); }
    if (!track.length) continue;
    const col = shipColor(model, sh);
    const big = sunkIds.has(sh.id) || sh.type === 'BB' || sh.type === 'BC';
    const d = track.map((p, i) => (i ? 'L' : 'M') + n1(X(p.x)) + ',' + n1(Y(p.y))).join(' ');
    o.push('<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' + (big ? 2.6 : 1.6) + '" opacity="' + (big ? 0.95 : 0.6) + '" stroke-linejoin="round"/>');
    const st = track[0], en = track[track.length - 1];
    o.push('<circle cx="' + n1(X(st.x)) + '" cy="' + n1(Y(st.y)) + '" r="3.2" fill="#fbf9f4" stroke="' + col + '" stroke-width="1.4"/>');
    if (sunkIds.has(sh.id)) o.push('<rect x="' + n1(X(en.x) - 3) + '" y="' + n1(Y(en.y) - 3) + '" width="6" height="6" fill="' + col + '"/>');
    else o.push('<rect x="' + n1(X(en.x) - 3) + '" y="' + n1(Y(en.y) - 3) + '" width="6" height="6" fill="' + col + '"/>');
    // 标签放在终点：开局时全队挤在一起，终点通常已经散开；沉没舰由下方的红叉标注接管
    if (sunkIds.has(sh.id)) continue;
    const lp = placeLabel(X(en.x), Y(en.y), sh.name);
    o.push('<text x="' + n1(lp.lx) + '" y="' + n1(lp.ly) + '" font-size="11.5" fill="' + col + '" font-weight="600" text-anchor="' + lp.anchor + '">' + esc(sh.name) + '</text>');
  }
  for (const sh of model.ships) {
    if (!sh.sank) continue;
    const en = frames.length ? (frames[frames.length - 1].ships || []).find((x) => x.id === sh.id) : null;
    const px = sh.sank.x !== undefined ? X(sh.sank.x) : (en ? X(en.x) : null);
    const py = sh.sank.y !== undefined ? Y(sh.sank.y) : (en ? Y(en.y) : null);
    if (px === null) continue;
    const sinkTxt = sh.name + ' · ' + fmtClock(sh.sank.t) + ' 沉没';
    const lp = placeLabel(px, py, sinkTxt);
    o.push('<g><line x1="' + n1(px - 7) + '" y1="' + n1(py - 7) + '" x2="' + n1(px + 7) + '" y2="' + n1(py + 7) + '" stroke="#b23a2e" stroke-width="2.2"/>'
      + '<line x1="' + n1(px + 7) + '" y1="' + n1(py - 7) + '" x2="' + n1(px - 7) + '" y2="' + n1(py + 7) + '" stroke="#b23a2e" stroke-width="2.2"/>'
      + '<text x="' + n1(lp.lx) + '" y="' + n1(lp.ly) + '" font-size="11" fill="#b23a2e" font-weight="700" text-anchor="' + lp.anchor + '">' + esc(sinkTxt) + '</text></g>');
  }
  // 图例
  const sideIds = Object.keys(model.sides);
  o.push('<g transform="translate(' + (mx - 6) + ',' + (my - 8) + ')"><rect width="220" height="' + (18 + sideIds.length * 20) + '" fill="#fbf9f4" opacity=".92" stroke="#d8d2c2"/>');
  sideIds.forEach((sid, i) => {
    o.push('<line x1="12" y1="' + (18 + i * 20) + '" x2="44" y2="' + (18 + i * 20) + '" stroke="' + sideColor(sid, i) + '" stroke-width="2.2"/>');
    o.push('<text x="52" y="' + (22 + i * 20) + '" font-size="11.5" fill="#333">' + esc(sideZh(sid)) + '</text>');
  });
  o.push('</g>');
  // 比例尺
  const barM = 2000;
  o.push('<line x1="' + n1(W - 250) + '" y1="' + n1(H - 26) + '" x2="' + n1(W - 250 + barM * sc) + '" y2="' + n1(H - 26) + '" stroke="#1d232b" stroke-width="1.8"/>');
  o.push('<text x="' + n1(W - 250 + barM * sc / 2) + '" y="' + n1(H - 32) + '" font-size="10.5" fill="#1d232b" text-anchor="middle">2 km</text>');
  o.push('</svg>');
  return o.join('\n');
}

// ── 距离曲线 ────────────────────────────────────────────────────────────────
export function rangeChart(model, opts = {}) {
  const frames = model.frames || [];
  if (frames.length < 2) return null;
  const W = opts.width || 1180, H = opts.height || 290, mx = 62, my = 36;
  const dur = Math.max(1, model.meta.duration);
  const sideIds = Object.keys(model.sides);
  const series = [];
  for (const f of frames) {
    const groups = {};
    for (const s of (f.ships || [])) { const sh = model.ships.find((x) => x.id === s.id); if (!sh || sh.sank) continue; (groups[sh.side] = groups[sh.side] || []).push(s); }
    const ids = Object.keys(groups);
    if (!ids.length) continue;
    let near = Infinity;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      for (const a of groups[ids[i]]) for (const b of groups[ids[j]]) {
        const d = Math.hypot(a.x - b.x, a.y - b.y) / 1000;
        if (d < near) near = d;
      }
    }
    let cent = null;
    if (ids.length >= 2) {
      const c = (g) => [g.reduce((a, p) => a + p.x, 0) / g.length, g.reduce((a, p) => a + p.y, 0) / g.length];
      const c0 = c(groups[ids[0]]), c1 = c(groups[ids[1]]);
      cent = Math.hypot(c0[0] - c1[0], c0[1] - c1[1]) / 1000;
    }
    series.push({ t: f.t, near: Number.isFinite(near) ? near : null, cent });
  }
  if (!series.length) return null;
  let maxKm = 0;
  for (const s of series) { if (s.near) maxKm = Math.max(maxKm, s.near); if (s.cent) maxKm = Math.max(maxKm, s.cent); }
  maxKm = Math.max(2, Math.ceil(maxKm / 2) * 2);
  const X = (t) => mx + (t / dur) * (W - 2 * mx);
  const Y = (km) => H - my - (km / maxKm) * (H - 2 * my);
  const o = [];
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="交战距离曲线">');
  o.push('<rect width="' + W + '" height="' + H + '" fill="#fbf9f4"/>');
  for (let km = 0; km <= maxKm; km += 1) {
    o.push('<line x1="' + mx + '" y1="' + n1(Y(km)) + '" x2="' + (W - mx) + '" y2="' + n1(Y(km)) + '" stroke="#e3ddcf"/>');
    if (km % 2 === 0) o.push('<text x="' + (mx - 8) + '" y="' + n1(Y(km) + 3) + '" font-size="10" fill="#9a958a" text-anchor="end">' + km + '</text>');
  }
  for (let t = 0; t <= dur; t += Math.max(30, Math.round(dur / 8 / 30) * 30)) {
    o.push('<text x="' + n1(X(t)) + '" y="' + (H - my + 16) + '" font-size="10" fill="#9a958a" text-anchor="middle">' + Math.round(t) + 's</text>');
  }
  const line = (key, col, dash) => {
    const pts = series.filter((s) => s[key] !== null);
    if (pts.length < 2) return;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + n1(X(p.t)) + ',' + n1(Y(p[key]))).join(' ');
    o.push('<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.8"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>');
  };
  line('cent', '#2f6fb2', null);
  line('near', '#b23a2e', '5 4');
  for (const sh of model.ships) {
    if (!sh.sank) continue;
    o.push('<line x1="' + n1(X(sh.sank.t)) + '" y1="' + my + '" x2="' + n1(X(sh.sank.t)) + '" y2="' + (H - my) + '" stroke="#b23a2e" stroke-width="1" stroke-dasharray="2 3" opacity=".8"/>');
    o.push('<text x="' + n1(X(sh.sank.t) + 4) + '" y="' + (my + 14) + '" font-size="10" fill="#b23a2e">' + esc(sh.name) + ' 沉没</text>');
  }
  o.push('<g transform="translate(' + (W - 300) + ',' + (my + 4) + ')"><rect width="286" height="38" fill="#fbf9f4" opacity=".92" stroke="#d8d2c2"/>'
    + '<line x1="12" y1="14" x2="42" y2="14" stroke="#2f6fb2" stroke-width="1.7"/><text x="48" y="18" font-size="10.5">编队质心距</text>'
    + '<line x1="140" y1="14" x2="170" y2="14" stroke="#b23a2e" stroke-width="1.7" stroke-dasharray="5 4"/><text x="176" y="18" font-size="10.5">最近舰距</text></g>');
  o.push('<text x="' + mx + '" y="' + (my - 12) + '" font-size="11" fill="#6b675e">距离 km</text>');
  o.push('</svg>');
  return o.join('\n');
}

// ── 中弹条带 ────────────────────────────────────────────────────────────────
export function damageStrip(model, opts = {}) {
  const hits = model.hitLog || [];
  if (!hits.length) return null;
  const W = opts.width || 1180;
  const rows = model.ships.slice().sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name, 'zh') : String(a.side).localeCompare(String(b.side))));
  const rowH = 26, top = 46, bottom = 30;
  const H = top + rows.length * rowH + bottom;
  const mx = 150, mr = 40;
  const dur = Math.max(1, model.meta.duration);
  const X = (t) => mx + (t / dur) * (W - mx - mr);
  const col = (sid, i) => sideColor(sid, i);
  const o = [];
  o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="中弹时间条带">');
  o.push('<rect width="' + W + '" height="' + H + '" fill="#fbf9f4"/>');
  for (let t = 0; t <= dur; t += Math.max(30, Math.round(dur / 10 / 30) * 30)) {
    o.push('<line x1="' + n1(X(t)) + '" y1="' + (top - 8) + '" x2="' + n1(X(t)) + '" y2="' + (top + rows.length * rowH) + '" stroke="#eee9dc"/>');
    o.push('<text x="' + n1(X(t)) + '" y="' + (H - 10) + '" font-size="10" fill="#9a958a" text-anchor="middle">' + Math.round(t) + 's</text>');
  }
  const sideIds = Object.keys(model.sides);
  rows.forEach((sh, i) => {
    const y = top + i * rowH + rowH / 2;
    o.push('<line x1="' + (mx - 8) + '" y1="' + y + '" x2="' + (W - mr) + '" y2="' + y + '" stroke="#e3ddcf"/>');
    o.push('<text x="' + (mx - 14) + '" y="' + (y + 4) + '" font-size="11.5" fill="#1d232b" text-anchor="end">' + esc(sh.name) + '</text>');
    const dmg = model.damage.byShip[sh.id] || {};
    o.push('<text x="' + (W - mr + 6) + '" y="' + (y + 4) + '" font-size="10" fill="#8a857a">' + (dmg.hitsTaken || 0) + ' 中' + (dmg.torpHits ? ' / ' + dmg.torpHits + ' 雷' : '') + '</text>');
    if (sh.sank) {
      const px = X(sh.sank.t);
      o.push('<line x1="' + n1(px) + '" y1="' + (y - 9) + '" x2="' + n1(px) + '" y2="' + (y + 9) + '" stroke="#b23a2e" stroke-width="1.4"/>');
      o.push('<text x="' + n1(px + 3) + '" y="' + (y - 11) + '" font-size="9.5" fill="#b23a2e">沉没</text>');
    }
  });
  for (const h of hits) {
    const idx = rows.findIndex((s) => s.id === h.ship);
    if (idx < 0) continue;
    const y = top + idx * rowH + rowH / 2;
    const x = X(h.t);
    if (h.kind === 'torp') {
      const c = h.friendly ? '#7a4a00' : '#9d3126';
      o.push('<path d="M' + n1(x) + ' ' + (y - 5) + ' l5 5 -5 5 -5 -5 z" fill="' + (h.friendly ? '#d9a13b' : c) + '" stroke="#1d232b" stroke-width=".6"/>');
      if (h.friendly) o.push('<circle cx="' + n1(x) + '" cy="' + y + '" r="7" fill="none" stroke="#7a4a00" stroke-width=".9"/>');
    } else {
      const c = col(h.bySide, sideIds.indexOf(h.bySide));
      o.push('<circle cx="' + n1(x) + '" cy="' + y + '" r="2.1" fill="' + c + '" opacity=".8"/>');
    }
  }
  // 图例
  o.push('<g transform="translate(' + (mx + 6) + ',10)"><circle cx="5" cy="5" r="2.4" fill="#b23a2e"/><text x="13" y="9" font-size="10.5" fill="#555">炮击命中（按来袭方着色）</text>'
    + '<path d="M' + 190 + ' 1 l5 5 -5 5 -5 -5 z" fill="#9d3126"/><text x="202" y="9" font-size="10.5" fill="#555">鱼雷命中</text>'
    + '<path d="M' + 280 + ' 1 l5 5 -5 5 -5 -5 z" fill="#d9a13b" stroke="#1d232b" stroke-width=".6"/><circle cx="280" cy="6" r="6.4" fill="none" stroke="#7a4a00" stroke-width=".8"/><text x="292" y="9" font-size="10.5" fill="#555">友军鱼雷</text></g>');
  o.push('</svg>');
  return o.join('\n');
}
