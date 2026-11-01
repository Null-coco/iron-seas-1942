import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 1003, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const bySide = { AXIS: {}, ALLIED: {} };
let sample = null;
w.events.on('gun.hit', (e) => {
  const shooter = w.ship(e.byShip), tgt = w.ship(e.targetShipId);
  if (!shooter || !tgt) { if (!sample) sample = e; return; }
  const k = tgt.name;
  bySide[shooter.side][k] = (bySide[shooter.side][k] || 0) + 1;
});
w.advance(900);
console.log('轴心命中: ' + JSON.stringify(bySide.AXIS));
console.log('英军命中: ' + JSON.stringify(bySide.ALLIED));
if (sample) console.log('gun.hit 字段样例: ' + JSON.stringify(Object.keys(sample)) + ' ship=' + sample.ship + ' targetShipId=' + sample.targetShipId + ' byShip=' + sample.byShip);
const hood = w.ships.find((s) => (s.id||'').indexOf('hood') >= 0);
console.log('Hood 进水 ' + Math.round(hood.floodedM3) + ' 主炮 ' + hood.mainBatteries.filter(b=>!b.destroyed).length + '/' + hood.mainBatteries.length + ' 在航 ' + hood.isAfloat);
