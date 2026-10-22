// 修复后的同一套指标（对照用户那份 replay：误差中位 2284m / errDeg 均值 23.75° / 839 条航迹 / 命中率 3.0%）
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 19420604, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
w.advance(+(process.argv[2] || 4700));
const det = w.events.history.filter((e) => e.type === 'sensor.detect');
const ids = new Set(det.map((e) => e.target));
const radar = det.filter((e) => (e.source || e.src) === 'RADAR');
const degs = radar.map((e) => e.errDeg).sort((a, b) => a - b);
const errs = [];
let maxRange = 0;
for (const e of det) {
  maxRange = Math.max(maxRange, e.rangeM || 0);
  const obs = w.ship(e.by) || w.ship(e.ship);
  if (!obs) continue;
  let best = 1e18;
  for (const f of w.ships) { if (!f.isAfloat || f.side === e.side) continue; best = Math.min(best, Math.hypot(e.x - f.pos.x, e.y - f.pos.y)); }
  if (best < 1e17) errs.push(best);
}
errs.sort((a, b) => a - b);
const pc = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const shots = w.ships.reduce((a, s) => a + s.stats.shotsFired, 0), hits = w.ships.reduce((a, s) => a + s.stats.hits, 0);
console.log('时长 ' + Math.round(w.t) + 's · 探测 ' + det.length + ' 次 · 不同航迹 ID ' + ids.size + '（真实敌舰 4 艘）');
console.log('航迹位置误差：中位 ' + pc(errs, 0.5).toFixed(0) + 'm  p90 ' + pc(errs, 0.9).toFixed(0) + 'm  最大 ' + (errs[errs.length - 1] || 0).toFixed(0) + 'm');
console.log('雷达方位误差 errDeg：中位 ' + pc(degs, 0.5).toFixed(2) + '°  均值 ' + (degs.reduce((a, b) => a + b, 0) / Math.max(1, degs.length)).toFixed(2) + '°  最大 ' + (degs[degs.length - 1] || 0).toFixed(2) + '°');
console.log('最远探测距离：' + (maxRange / 1000).toFixed(1) + 'km');
console.log('开火 ' + shots + ' 命中 ' + hits + ' → 命中率 ' + (shots ? (100 * hits / shots).toFixed(1) : 0) + '%');
const alive = (s) => w.shipsOf(s).filter((x) => x.isAfloat).length;
console.log('在航：同盟 ' + alive('ALLIED') + '/4 · 轴心 ' + alive('AXIS') + '/4 · 倾覆 ' + w.ships.filter((s) => s.capsized).length + ' 艘');
