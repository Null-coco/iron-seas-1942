import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: sc.seed || 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
const log = (s) => fs.appendFileSync('/tmp/den2.log', s + '\n');
for (let k = 0; k < 90; k++) {
  const t0 = Date.now();
  w.advance(20);
  const ms = Date.now() - t0;
  log('t=' + Math.round(w.t) + ' 段 ' + (ms / 1000).toFixed(2) + 's 鱼雷 ' + w.torpedoes.length + ' 弹丸 ' + (w.projectiles || []).length + ' 沉没 ' + w.ships.filter((s) => !s.isAfloat).length + ' 事件 ' + w.events.history.length);
  if (ms > 30000) { log('!! 单段 >30s，停止'); break; }
}
log('DONE');
