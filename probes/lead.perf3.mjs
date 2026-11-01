import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 5, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const log = (s) => { fs.appendFileSync('/tmp/perf2.log', s + '\n'); };
for (let k = 0; k < 40; k++) {
  const t0 = Date.now();
  w.advance(50);
  const ms = Date.now() - t0;
  log('t=' + Math.round(w.t) + '  段 ' + (ms / 1000).toFixed(1) + 's 事件 ' + w.events.history.length + ' 鱼雷 ' + (w.torpedoes || []).length + ' 照明 ' + (w.illuminationFlares || []).length + ' 沉没 ' + w.ships.filter((s) => !s.isAfloat).length + ' 航迹 ' + w.tracks.tracks.length + ' 弹丸 ' + (w.projectiles || []).length + ' 舱段事件 ' + (w.events.history.filter((e) => String(e.type).indexOf('dam.') === 0).length));
  if (ms > 60000) { log('!! 单段超过 60s，停止'); break; }
}
log('DONE');
