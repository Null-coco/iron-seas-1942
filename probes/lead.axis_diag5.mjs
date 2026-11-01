import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 1003, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const acc = { AXIS: [], ALLIED: [] };
w.events.on('gun.miss', (e) => {
  const t = w.ship(e.ship), sh = w.ship(e.byShip);
  if (!t || !sh || !t.isAfloat) return;
  const brg = Math.atan2(t.pos.x - sh.pos.x, t.pos.y - sh.pos.y);
  const dx = e.x - t.pos.x, dy = e.y - t.pos.y;
  acc[sh.side].push({ along: dx * Math.sin(brg) + dy * Math.cos(brg), cross: dx * Math.cos(brg) - dy * Math.sin(brg), r: Math.hypot(e.x - sh.pos.x, e.y - sh.pos.y) });
});
w.advance(900);
const pc = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
for (const side of ['AXIS', 'ALLIED']) {
  const s = acc[side];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.log(side + ' 弹着 ' + s.length + ' 发 | 沿射向均值 ' + mean(s.map((x) => x.along)).toFixed(0) + 'm 中位 ' + pc(s.map((x) => x.along), 0.5).toFixed(0) + 'm |p90| ' + pc(s.map((x) => Math.abs(x.along)), 0.9).toFixed(0) + 'm | 垂直均值 ' + mean(s.map((x) => x.cross)).toFixed(0) + 'm |p90| ' + pc(s.map((x) => Math.abs(x.cross)), 0.9).toFixed(0) + 'm | 平均射距 ' + (mean(s.map((x) => x.r)) / 1000).toFixed(1) + 'km');
}
