import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { Land } from '../src/sim/land.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const landData = j('data/land.json');
for (const id of ['surigao_strait_1944', 'savo_island_1942', 'casablanca_1942', 'denmark_strait_1941']) {
  const sc = j('data/scenarios.json').scenarios.find((s) => s.id === id);
  const w = new World({ scenario: sc, database: db, seed: 7, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData });
  const land = w.land;
  const startOnLand = w.ships.filter((s) => land.isLand(s.pos.x, s.pos.y)).length;
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(900);
  const endOnLand = w.ships.filter((s) => s.isAfloat && land.isLand(s.pos.x, s.pos.y)).length;
  const grounded = w.events.history.filter((e) => e.type === 'ship.grounding').length;
  const det = w.events.history.filter((e) => e.type === 'sensor.detect').length;
  // 最近陆地距离（当前）
  const minDist = Math.min(...w.ships.filter((s) => s.isAfloat).map((s) => land.distanceToLand(s.pos.x, s.pos.y, 60000)));
  console.log(id.padEnd(24) + ' 陆地多边形 ' + String(land.rings.length).padStart(3) +
    ' | 开局在陆 ' + startOnLand + ' → 900s 后在陆 ' + endOnLand + ' 搁浅事件 ' + grounded +
    ' | 探测 ' + String(det).padStart(4) + ' | 距最近陆地 ' + (minDist / 1000).toFixed(1) + 'km');
}
