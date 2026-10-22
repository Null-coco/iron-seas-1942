// 从 Natural Earth 10m 海岸线裁剪出各剧本区域内的陆地，转成世界米制坐标并简化。
// 用法：node tools/build-land-data.mjs /tmp/ne10_land.geojson /tmp/ne10_minor.geojson
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const NMI = 1852;

const landFile = process.argv[2] || '/tmp/ne10_land.geojson';
const minorFile = process.argv[3] || '/tmp/ne10_minor.geojson';
const scenarios = JSON.parse(fs.readFileSync(path.join(R, 'data/scenarios.json'), 'utf8')).scenarios;

function plane(lat0, lon0) {
  const D = Math.PI / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * D * lat0) + 1.175 * Math.cos(4 * D * lat0);
  const mLon = 111412.84 * Math.cos(D * lat0) - 93.5 * Math.cos(3 * D * lat0);
  return {
    toXY(lon, lat) { return [(lon - lon0) * mLon, (lat - lat0) * mLat]; },
  };
}
// 道格拉斯-普克简化（输入为 [x,y] 数组）。
// 注意：GeoJSON 的环是闭合的（首尾同点），直接以首尾为基线会得到 0 长度基线，
// 于是所有点都被判为"在线上"、整条环被压成 2 个点。闭合环必须先在最远点处切开。
function simplifyRing(pts, tol) {
  if (pts.length < 4) return pts;
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  if (!closed) return simplify(pts, tol);
  let k = 0, bd = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > bd) { bd = d; k = i; }
  }
  const a = simplify(pts.slice(0, k + 1), tol);
  const b = simplify(pts.slice(k), tol);
  const out = a.concat(b.slice(1));
  return out;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function collectRings(geo, box, out) {
  for (const f of geo.features) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
    for (const poly of polys) {
      const ring = poly[0]; if (!ring || ring.length < 4) continue;
      let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
      for (const c of ring) { if (c[0] < minLon) minLon = c[0]; if (c[0] > maxLon) maxLon = c[0]; if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1]; }
      if (maxLon < box[0] || minLon > box[2] || maxLat < box[1] || minLat > box[3]) continue;
      out.push(ring);
    }
  }
}
// 矩形裁剪（Sutherland–Hodgman）。clip 区域是凸的，安全。
function clipRing(ring, box) {
  let out = ring;
  const edges = [
    { inside: (p) => p[0] >= box[0], intersect: (a, b) => [box[0], a[1] + (b[1] - a[1]) * (box[0] - a[0]) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= box[2], intersect: (a, b) => [box[2], a[1] + (b[1] - a[1]) * (box[2] - a[0]) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= box[1], intersect: (a, b) => [a[0] + (b[0] - a[0]) * (box[1] - a[1]) / (b[1] - a[1]), box[1]] },
    { inside: (p) => p[1] <= box[3], intersect: (a, b) => [a[0] + (b[0] - a[0]) * (box[3] - a[1]) / (b[1] - a[1]), box[3]] },
  ];
  for (const e of edges) {
    if (!out.length) return [];
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const curIn = e.inside(cur), prevIn = e.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(e.intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) out.push(e.intersect(prev, cur));
    }
  }
  return out;
}
// ── OSM 海岸线：把 way 按端点 node id 拼接成闭合环；无法闭合的开链沿 bbox 边界闭合 ──
const OSM_DIR = process.env.OSM_DIR || '/tmp/osm-coast';
function perimeterS(p, box) {
  const [x0, y0, x1, y1] = box;
  const W = x1 - x0, H = y1 - y0, P = 2 * (W + H);
  if (p[1] <= y0) return Math.max(0, Math.min(W, p[0] - x0));
  if (p[0] >= x1) return W + Math.max(0, Math.min(H, p[1] - y0));
  if (p[1] >= y1) return W + H + Math.max(0, Math.min(W, x1 - p[0]));
  return W + H + W + Math.max(0, Math.min(H, y1 - p[1]));
}
function perimeterPt(s, box) {
  const [x0, y0, x1, y1] = box, W = x1 - x0, H = y1 - y0, P = 2 * (W + H);
  s = ((s % P) + P) % P;
  if (s <= W) return [x0 + s, y0];
  if (s <= W + H) return [x1, y0 + (s - W)];
  if (s <= W + H + W) return [x1 - (s - W - H), y1];
  return [x0, y1 - (s - W - H - W)];
}
function perimeterPath(a, b, box, dir) {
  const P = 2 * ((box[2] - box[0]) + (box[3] - box[1]));
  const step = P / 240;
  let s = perimeterS(a, box);
  const sb = perimeterS(b, box);
  const out = [];
  for (let guard = 0; guard < 400; guard++) {
    s = ((s + dir * step) % P + P) % P;
    out.push(perimeterPt(s, box));
    const d = ((sb - s) * dir + P) % P;
    if (d < step * 1.5) break;
  }
  return out;
}
// 带符号面积（逆时针为正）。OSM 海岸线约定"沿 way 左侧为陆地"，故陆地环必为正面积。
function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return a / 2;
}
function polyArea(pts) { return Math.abs(signedArea(pts)); }
function osmRingsFor(id, box) {
  const file = path.join(OSM_DIR, id + '.json');
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ways = (data.elements || []).filter((e) => e.type === 'way' && e.nodes && e.geometry && e.geometry.length > 1);
  const byNode = new Map();
  ways.forEach((w, i) => {
    for (const n of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(i);
    }
  });
  const used = new Uint8Array(ways.length);
  const rings = [], openChains = [];
  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = ways[i].nodes.slice();
    let geom = ways[i].geometry.map((g) => [g.lon, g.lat]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const end of ['tail', 'head']) {
        const nodeId = end === 'tail' ? chain[chain.length - 1] : chain[0];
        for (const j of (byNode.get(nodeId) || [])) {
          if (used[j]) continue;
          const w = ways[j];
          const rev = w.nodes[0] !== nodeId;
          const n2 = rev ? w.nodes.slice().reverse() : w.nodes.slice();
          const g2 = (rev ? w.geometry.slice().reverse() : w.geometry).map((g) => [g.lon, g.lat]);
          if (end === 'tail') { chain = chain.concat(n2.slice(1)); geom = geom.concat(g2.slice(1)); }
          else { chain = n2.slice(0, -1).concat(chain); geom = g2.slice(0, -1).concat(geom); }
          used[j] = 1; grew = true; break;
        }
        if (grew) break;
      }
    }
    if (chain[0] === chain[chain.length - 1] && geom.length >= 4) rings.push(geom);
    else if (geom.length >= 2) openChains.push(geom);
  }
  // 开链沿 bbox 边界闭合。方向不能靠"面积大小"猜（会把整片海吞成陆地，导致舰船全在岸上）：
  // 按 OSM 约定，陆地环必须是逆时针（正面积），据此在两个闭合方向里挑正确的一个。
  const boxArea = Math.abs((box[2] - box[0]) * (box[3] - box[1]));
  for (const g of openChains) {
    const a = g[g.length - 1], b = g[0];
    const cw = g.concat(perimeterPath(a, b, box, +1));
    const ccw = g.concat(perimeterPath(a, b, box, -1));
    const aCW = signedArea(cw), aCCW = signedArea(ccw);
    let pick;
    if (aCW > 0 && aCCW <= 0) pick = cw;
    else if (aCCW > 0 && aCW <= 0) pick = ccw;
    else pick = Math.abs(aCW) <= Math.abs(aCCW) ? cw : ccw;   // 同号时取较小者，避免吞掉整片海
    if (polyArea(pick) > boxArea * 0.5) continue;             // 仍然异常大：丢弃，宁可少画不可画错
    rings.push(pick);
  }
  return rings;
}
const land = JSON.parse(fs.readFileSync(landFile, 'utf8'));
const minor = JSON.parse(fs.readFileSync(minorFile, 'utf8'));
const result = { _meta: { source: 'Natural Earth 10m land + minor islands', note: '按剧本裁剪并简化到 120m，坐标为世界米制（原点=剧本 start.lat/lon）', builtAt: new Date().toISOString() }, scenarios: {} };
let onLandWarn = [];
for (const sc of scenarios) {
  const sp = sc.start || {};
  if (sp.lat === undefined || sp.lon === undefined) continue;
  const ships = (sc.ships || []).filter((s) => s.lat !== undefined);
  if (!ships.length) continue;
  let minLat = 1e9, maxLat = -1e9, minLon = 1e9, maxLon = -1e9;
  for (const s of ships) { minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat); minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon); }
  const margin = 2.4;   // 度：约 260km（让海岸出现在战术图边缘；海峡型剧本本就靠岸）
  const box = [minLon - margin, minLat - margin, maxLon + margin, maxLat + margin];
  let rings = [];
  let source = 'NE10m';
  const osm = osmRingsFor(sc.id, box);
  if (osm && osm.length) { rings = osm; source = 'OSM'; }
  else { collectRings(land, box, rings); collectRings(minor, box, rings); }
  const P = plane(sp.lat, sp.lon);
  const out = [];
  let verts = 0;
  // 裁剪框比战术区域再外扩 1.6°（≈180km）：否则裁剪边会在图上留下一条笔直的假岸线
  const cb = [box[0] - 1.6, box[1] - 1.6, box[2] + 1.6, box[3] + 1.6];
  const mBox = [cb[0], cb[1], cb[2], cb[3]].map((v, i) => (i % 2 === 0 ? P.toXY(v, sp.lat)[0] : P.toXY(sp.lon, v)[1]));
  for (const ring of rings) {
    const xy = ring.map((c) => P.toXY(c[0], c[1]));
    const clipped = clipRing(xy, mBox);
    if (clipped.length < 4) continue;
    // 简化容差按尺度自适应：大块陆地 120m；小岛最多用到其尺度/20（保形，不把小岛磨成三角）
    let rMinX = 1e18, rMinY = 1e18, rMaxX = -1e18, rMaxY = -1e18;
    for (const p of clipped) { if (p[0] < rMinX) rMinX = p[0]; if (p[0] > rMaxX) rMaxX = p[0]; if (p[1] < rMinY) rMinY = p[1]; if (p[1] > rMaxY) rMaxY = p[1]; }
    const diag = Math.hypot(rMaxX - rMinX, rMaxY - rMinY);
    const tol = Math.min(120, Math.max(12, diag / 20));
    const s = simplifyRing(clipped, tol);
    // 不丢弃任何岛礁：哪怕只有 3 个点（礁石、小屿对航海与雷达遮蔽都是真实存在的）
    if (s.length < 3) continue;
    // 只剔除"严格退化"的零面积三角形（3 点共线，裁剪/简化的副产物，不是岛）；
    // 实测这批共 634 个，面积 0 m²、跨度仅 11~46m。真实屿礁哪怕 10m×10m 也有 100 m²，不受影响。
    if (polyArea(s) < 1) continue;
    out.push(s.map((p) => [Math.round(p[0]), Math.round(p[1])]));
    verts += s.length;
  }
  result.scenarios[sc.id] = { rings: out };
  // 检查是否有舰船开局就在陆地上
  const inside = (x, y) => {
    let c = false;
    for (const ring of out) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (((ring[i][1] > y) !== (ring[j][1] > y)) && (x < (ring[j][0] - ring[i][0]) * (y - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0])) c = !c;
      }
    }
    return c;
  };
  const bad = [];
  for (const s of ships) { const [x, y] = P.toXY(s.lon, s.lat); if (inside(x, y)) bad.push(s.name || s.id); }
  if (bad.length) onLandWarn.push(sc.id + ': ' + bad.join('、'));
  console.log(sc.id.padEnd(26) + ' [' + source.padEnd(6) + '] 多边形 ' + String(out.length).padStart(4) + ' 顶点 ' + String(verts).padStart(6) + (bad.length ? ('  ⚠️ 开局在陆地: ' + bad.join('、')) : ''));
}
fs.mkdirSync(path.join(R, 'data'), { recursive: true });
fs.writeFileSync(path.join(R, 'data/land.json'), JSON.stringify(result));
console.log('\n写入 data/land.json ' + (fs.statSync(path.join(R, 'data/land.json')).size / 1024).toFixed(0) + ' KB');
if (onLandWarn.length) console.log('⚠️ 需要调整的剧本：\n  ' + onLandWarn.join('\n  '));
