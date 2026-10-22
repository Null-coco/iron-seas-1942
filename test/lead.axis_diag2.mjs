import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 1003, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const ai = w.ai['AXIS'].local || w.ai['AXIS'];
const bis = w.ships.find((s) => (s.id || '').indexOf('bismarck') >= 0);
for (let k = 0; k < 120; k++) {
  w.advance(10);
  if (k % 5) continue;
  const mem = ai.memFor ? ai.memFor(bis) : null;
  const br = w.shipsOf('ALLIED').filter((s) => s.isAfloat && (s.type === 'BB' || s.type === 'BC'));
  const near = br.sort((a, b) => Math.hypot(a.pos.x - bis.pos.x, a.pos.y - bis.pos.y) - Math.hypot(b.pos.x - bis.pos.x, b.pos.y - bis.pos.y))[0];
  const d = near ? Math.hypot(near.pos.x - bis.pos.x, near.pos.y - bis.pos.y) / 1000 : -1;
  const away = near ? Math.abs(((Math.atan2(bis.pos.x - near.pos.x, bis.pos.y - near.pos.y) * 57.3 + 360) % 360) - bis.heading) : -1;
  console.log('t=' + Math.round(w.t) + ' 速度上限 ' + bis.speedCapKn.toFixed(1) + ' 实际航速 ' + bis.speed.toFixed(1) + ' with=' + (mem && mem.withdraw ? 'Y' : 'n') + ' 距最近敌主力 ' + d.toFixed(1) + 'km 背离角差 ' + (away >= 0 ? away.toFixed(0) : '-') + '° 指挥仪 ' + (bis.directors || []).filter((x) => !x.destroyed).length + (w.over ? '  [结束 ' + (w.resultText || '') + ']' : ''));
  if (w.over) break;
}
