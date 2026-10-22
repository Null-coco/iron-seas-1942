import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
const w = new World({ scenario: sc, database: db, seed: 2000, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const salvos = { AXIS: new Map(), ALLIED: new Map() };
const hits = { AXIS: 0, ALLIED: 0 };
w.events.on('gun.miss', (e) => {
  const sh = w.ship(e.byShip), t2 = w.ship(e.targetShipId);
  if (!sh || !t2 || !t2.isAfloat) return;
  const brg = Math.atan2(t2.pos.x - sh.pos.x, t2.pos.y - sh.pos.y);
  const dx = e.x - t2.pos.x, dy = e.y - t2.pos.y;
  const m = salvos[sh.side], k = e.salvoId || 'x';
  if (!m.has(k)) m.set(k, { cross: [] });
  m.get(k).cross.push(dx * Math.cos(brg) - dy * Math.sin(brg));
});
w.events.on('gun.hit', (e) => { const sh = w.ship(e.byShip); if (sh) hits[sh.side] = (hits[sh.side] || 0) + 1; });
w.advance(1200);
const stat = (m) => {
  const means = [], intra = [];
  for (const [, v] of m) { if (v.cross.length < 2) continue; const mu = v.cross.reduce((a, b) => a + b, 0) / v.cross.length; means.push(mu); intra.push(Math.sqrt(v.cross.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, v.cross.length - 1))); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
  return { n: means.length, intra: mean(intra), inter: sd(means) };
};
for (const side of ['AXIS', 'ALLIED']) { const s = stat(salvos[side]); console.log(side + ' 齐射 ' + s.n + ' 齐射内σ ' + s.intra.toFixed(0) + 'm 齐射间σ ' + s.inter.toFixed(0) + 'm 命中 ' + hits[side]); }
