import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 1003, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const salvos = { AXIS: new Map(), ALLIED: new Map() };
w.events.on('gun.miss', (e) => {
  const sh = w.ship(e.byShip), t = w.ship(e.targetShipId);
  if (!sh || !t || !t.isAfloat) return;
  const brg = Math.atan2(t.pos.x - sh.pos.x, t.pos.y - sh.pos.y);
  const dx = e.x - t.pos.x, dy = e.y - t.pos.y;
  const cross = dx * Math.cos(brg) - dy * Math.sin(brg);
  const m = salvos[sh.side];
  const key = e.salvoId || 'x';
  if (!m.has(key)) m.set(key, { cross: [], track: e.trackId, t: w.t });
  m.get(key).cross.push(cross);
});
w.advance(900);
const stats = (m) => {
  const means = [], intra = [];
  for (const [, v] of m) {
    if (v.cross.length < 2) continue;
    const mu = v.cross.reduce((a, b) => a + b, 0) / v.cross.length;
    means.push(mu);
    const va = v.cross.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, v.cross.length - 1);
    intra.push(Math.sqrt(va));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
  return { n: means.length, intra: mean(intra), inter: sd(means) };
};
for (const side of ['AXIS', 'ALLIED']) { const s = stats(salvos[side]); console.log(side + '：齐射数 ' + s.n + ' 齐射内横向σ ' + s.intra.toFixed(0) + 'm，齐射间均值σ ' + s.inter.toFixed(0) + 'm'); }
