import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
// 找出慢窗口：每 20s 计时，打印
let slowAt = 0;
for (let k = 0; k < 100; k++) {
  const t0 = Date.now();
  w.advance(20);
  const ms = Date.now() - t0;
  fs.appendFileSync('/tmp/savo2.log', 't=' + Math.round(w.t) + ' 段 ' + (ms / 1000).toFixed(2) + 's 鱼雷 ' + w.torpedoes.length + ' 弹丸 ' + (w.projectiles || []).length + ' 事件 ' + w.events.history.length + '\n');
  if (ms > 20000) { slowAt = w.t; break; }
}
console.log('慢窗口结束于 t=' + slowAt);
