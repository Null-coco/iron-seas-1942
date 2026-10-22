// 用 OSM Overpass 按剧本抓取真实海岸线（细节远高于 Natural Earth 10m，含 <0.2km² 的屿礁）
// 用法：node tools/fetch-osm-coast.mjs [scenarioId...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const OUT = process.env.OSM_DIR || '/tmp/osm-coast';
fs.mkdirSync(OUT, { recursive: true });
const scenarios = JSON.parse(fs.readFileSync(path.join(R, 'data/scenarios.json'), 'utf8')).scenarios;
const only = process.argv.slice(2);
const MARGIN = +(process.env.OSM_MARGIN || 0.7);   // 度（≈78km）
const EP = process.env.OSM_EP || 'https://overpass-api.de/api/interpreter';

async function query(bbox, attempt) {
  const q = '[out:json][timeout:180];way["natural"="coastline"](' + bbox + ');out geom;';
  const url = EP + '?data=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'User-Agent': 'iron-seas-1942/1.0 (naval sim coastline build)', Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const txt = await res.text();
  if (txt.trim().startsWith('<')) throw new Error('非 JSON 响应（限流？）');
  return JSON.parse(txt);
}
for (const sc of scenarios) {
  if (only.length && only.indexOf(sc.id) < 0) continue;
  const ships = (sc.ships || []).filter((s) => s.lat !== undefined);
  if (!ships.length) continue;
  const out = path.join(OUT, sc.id + '.json');
  if (fs.existsSync(out) && fs.statSync(out).size > 5000 && !process.env.OSM_FORCE) { console.log(sc.id.padEnd(24) + ' 已存在，跳过'); continue; }
  const lats = ships.map((s) => s.lat), lons = ships.map((s) => s.lon);
  const bbox = [Math.min(...lats) - MARGIN, Math.min(...lons) - MARGIN, Math.max(...lats) + MARGIN, Math.max(...lons) + MARGIN].map((v) => v.toFixed(4)).join(',');
  const t0 = Date.now();
  let data = null, err = null;
  for (let a = 0; a < 3 && !data; a++) {
    try { data = await query(bbox, a); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 5000 + a * 10000)); }
  }
  if (!data) { console.log(sc.id.padEnd(24) + ' 失败：' + (err && err.message)); continue; }
  const ways = (data.elements || []).filter((e) => e.type === 'way' && e.geometry);
  const pts = ways.reduce((n, w) => n + w.geometry.length, 0);
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(sc.id.padEnd(24) + ' bbox ' + bbox + ' → way ' + String(ways.length).padStart(4) + ' 坐标点 ' + String(pts).padStart(6) +
    '  ' + (fs.statSync(out).size / 1048576).toFixed(1) + 'MB  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  await new Promise((r) => setTimeout(r, 2500));   // 对公共 API 客气一点
}
console.log('\n原始数据目录：' + OUT);
