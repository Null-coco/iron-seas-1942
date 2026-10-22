import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 5, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
w.advance(1300);
console.log('到 1300s：鱼雷 ' + w.torpedoes.length + ' 事件 ' + w.events.history.length);
for (let k = 0; k < 10; k++) {
  const t0 = Date.now();
  w.advance(5);
  console.log('  +5s → t=' + Math.round(w.t) + ' 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's 鱼雷 ' + w.torpedoes.length);
}
