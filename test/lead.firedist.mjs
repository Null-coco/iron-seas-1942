import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
for (const id of ['sandbox', 'denmark_strait_1941', 'savo_island_1942']) {
  const sc = j('data/scenarios.json').scenarios.find((s) => s.id === id);
  const w = new World({ scenario: sc, database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1200);
  const fires = w.events.history.filter((e) => e.type === 'gun.fire' && e.rangeM);
  const buckets = { '<6km': 0, '6-10': 0, '10-14': 0, '14-18': 0, '18-22': 0, '>22km': 0 };
  for (const f of fires) {
    const k = f.rangeM / 1000;
    if (k < 6) buckets['<6km']++; else if (k < 10) buckets['6-10']++; else if (k < 14) buckets['10-14']++;
    else if (k < 18) buckets['14-18']++; else if (k < 22) buckets['18-22']++; else buckets['>22km']++;
  }
  const sunk = w.ships.filter((s) => !s.isAfloat).length;
  const shots = w.ships.reduce((a, s) => a + s.stats.shotsFired, 0), hits = w.ships.reduce((a, s) => a + s.stats.hits, 0);
  const mean = fires.length ? (fires.reduce((a, f) => a + f.rangeM, 0) / fires.length / 1000).toFixed(1) : '-';
  console.log(id.padEnd(24) + ' 开火' + String(fires.length).padStart(5) + ' 均距' + String(mean).padStart(5) + 'km 分布 ' + JSON.stringify(buckets) + ' 命中率 ' + (shots ? (100 * hits / shots).toFixed(1) : 0) + '% 沉没 ' + sunk);
}
