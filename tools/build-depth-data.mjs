// 从 Natural Earth 10m 测深带（0/200/1000/.../10000m）裁剪出各剧本的水深带多边形。
// 用法：node tools/build-depth-data.mjs [bathyDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const DIR = process.argv[2] || '/tmp/bathy';
const scenarios = JSON.parse(fs.readFileSync(path.join(R, 'data/scenarios.json'), 'utf8')).scenarios;
const LAYERS = ['L_0', 'K_200', 'J_1000', 'I_2000', 'H_3000', 'G_4000', 'F_5000', 'E_6000', 'D_7000', 'C_8000', 'B_9000', 'A_10000'];

function plane(lat0, lon0) {
  const D = Math.PI / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * D * lat0) + 1.175 * Math.cos(4 * D * lat0);
  const mLon = 111412.84 * Math.cos(D * lat0) - 93.5 * Math.cos(3 * D * lat0);
  return { toXY(lon, lat) { return [(lon - lon0) * mLon, (lat - lat0) * mLat]; } };
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
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
  const out = []; for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function simplifyRing(pts, tol) {
  if (pts.length < 4) return pts;
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  if (!closed) return simplify(pts, tol);
  let k = 0, bd = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > bd) { bd = d; k = i; } }
  return simplify(pts.slice(0, k + 1), tol).concat(simplify(pts.slice(k), tol).slice(1));
}
function clipRing(ring, box) {
  let out = ring;
  const edges = [
    { ins: (p) => p[0] >= box[0], ix: (a, b) => [box[0], a[1] + (b[1] - a[1]) * (box[0] - a[0]) / (b[0] - a[0])] },
    { ins: (p) => p[0] <= box[2], ix: (a, b) => [box[2], a[1] + (b[1] - a[1]) * (box[2] - a[0]) / (b[0] - a[0])] },
    { ins: (p) => p[1] >= box[1], ix: (a, b) => [a[0] + (b[0] - a[0]) * (box[1] - a[1]) / (b[1] - a[1]), box[1]] },
    { ins: (p) => p[1] <= box[3], ix: (a, b) => [a[0] + (b[0] - a[0]) * (box[3] - a[1]) / (b[1] - a[1]), box[3]] },
  ];
  for (const e of edges) {
    if (!out.length) return [];
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const ci = e.ins(cur), pi = e.ins(prev);
      if (ci) { if (!pi) out.push(e.ix(prev, cur)); out.push(cur); }
      else if (pi) out.push(e.ix(prev, cur));
    }
  }
  return out;
}
const result = { _meta: { source: 'Natural Earth 10m bathymetry bands (0/200/1000…10000m)', note: '坐标为世界米制（原点=剧本 start.lat/lon），载入时栅格化为水深场', builtAt: new Date().toISOString() }, scenarios: {} };
for (const sc of scenarios) {
  const sp = sc.start || {};
  if (sp.lat === undefined) continue;
  const ships = (sc.ships || []).filter((s) => s.lat !== undefined);
  if (!ships.length) continue;
  const lats = ships.map((s) => s.lat), lons = ships.map((s) => s.lon);
  const box = [Math.min(...lons) - 2.4, Math.min(...lats) - 2.4, Math.max(...lons) + 2.4, Math.max(...lats) + 2.4];
  const P = plane(sp.lat, sp.lon);
  const cb = [box[0] - 1.6, box[1] - 1.6, box[2] + 1.6, box[3] + 1.6];
  const mBox = [cb[0], cb[1], cb[2], cb[3]].map((v, i) => (i % 2 === 0 ? P.toXY(v, sp.lat)[0] : P.toXY(sp.lon, v)[1]));
  const bands = [];
  let verts = 0;
  for (const L of LAYERS) {
    const file = path.join(DIR, 'b_' + L + '.geojson');
    if (!fs.existsSync(file)) continue;
    const geo = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const f of geo.features) {
      const depth = (f.properties && f.properties.depth) || 0;
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
      for (const poly of polys) {
        const ring = poly[0]; if (!ring || ring.length < 4) continue;
        let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
        for (const p of ring) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
        if (b < box[0] || a > box[2] || d < box[1] || c > box[3]) continue;
        const xy = ring.map((p) => P.toXY(p[0], p[1]));
        const cl = clipRing(xy, mBox);
        if (cl.length < 3) continue;
        const s = simplifyRing(cl, 300);
        if (s.length < 3) continue;
        bands.push({ depth, ring: s.map((p) => [Math.round(p[0]), Math.round(p[1])]) });
        verts += s.length;
      }
    }
  }
  result.scenarios[sc.id] = { bands };
  console.log(sc.id.padEnd(24) + ' 等深带 ' + String(bands.length).padStart(4) + ' 顶点 ' + String(verts).padStart(6) + ' 深度档 ' + [...new Set(bands.map((b) => b.depth))].sort((x, y) => x - y).join('/'));
}
fs.writeFileSync(path.join(R, 'data/depth.json'), JSON.stringify(result));
console.log('\n写入 data/depth.json ' + (fs.statSync(path.join(R, 'data/depth.json')).size / 1024).toFixed(0) + ' KB');
