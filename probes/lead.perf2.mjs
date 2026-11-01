import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 5, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
let prev = Date.now();
for (const mark of [60, 120, 300, 600, 900, 1200, 1500, 1800]) {
  const t0 = Date.now();
  w.advance(mark - (w.t || 0));
  const ms = Date.now() - t0;
  const torps = (w.torpedoes || []).length;
  const flares = (w.illuminationFlares || []).length;
  const sunk = w.ships.filter((s) => !s.isAfloat).length;
  console.log('t=' + String(mark).padStart(4) + 's  本段 ' + (ms / 1000).toFixed(1) + 's  (' + (ms / Math.max(1, mark - 0)).toFixed(0) + 'ms/段)  事件 ' + w.events.history.length + ' 鱼雷 ' + torps + ' 照明弹 ' + flares + ' 沉没 ' + sunk + ' 航迹 ' + w.tracks.tracks.length + ' 弹丸 ' + (w.projectiles || []).length);
}
