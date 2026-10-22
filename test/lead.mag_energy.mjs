import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
let det = 0, burn = 0, blasts = 0; const energies = [];
for (let k = 0; k < 12; k++) {
  const w = new World({ scenario: sc, database: db, seed: 5000 + k, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1200);
  for (const e of w.events.history) {
    if (e.type === 'dam.magazine' && e.result === 'detonation') { det++; energies.push(e.energyKg); }
    if (e.type === 'dam.magazine' && e.result === 'burn') burn++;
    if (e.type === 'dam.blast') blasts++;
  }
}
console.log('12 局：满库殉爆 ' + det + ' 次，近空库爆燃 ' + burn + ' 次，邻近舰受冲击 ' + blasts + ' 次');
console.log('殉爆当量: ' + JSON.stringify(energies));
