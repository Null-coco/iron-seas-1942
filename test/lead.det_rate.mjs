import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
let det = 0, hoodLost = 0, runs = 12;
for (let k = 0; k < runs; k++) {
  const w = new World({ scenario: sc, database: db, seed: 5000 + k, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1200);
  const d = w.events.history.filter((e) => e.type === 'dam.magazine' && e.result === 'detonation').length;
  det += d;
  const hood = w.ships.find((s) => (s.id || '').indexOf('hood') >= 0);
  if (hood && !hood.isAfloat) hoodLost++;
}
console.log(runs + ' 局：殉爆 ' + det + ' 次，胡德被击沉 ' + hoodLost + ' 次');
