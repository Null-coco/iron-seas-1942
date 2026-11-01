import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const run = (label, opts) => {
  const w = new World(Object.assign({ scenario: sc, database: db, seed: 5, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') }, opts));
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1340);
  const t0 = Date.now();
  w.advance(25);
  const ms = Date.now() - t0;
  console.log(label.padEnd(30) + ' t=1365 段耗时 ' + (ms / 1000).toFixed(1) + 's  鱼雷 ' + w.torpedoes.length);
  return ms;
};
run('全开', {});
run('无水深场', { depthData: null });
run('无陆地（连带水深退化）', { landData: null, depthData: null });
