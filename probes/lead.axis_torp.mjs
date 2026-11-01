import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
for (let k = 0; k < 3; k++) {
  const w = new World({ scenario: sc, database: db, seed: 2000 + k, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1400);
  const la = w.events.history.filter((e) => e.type === 'torp.launch' && e.accepted);
  const axL = la.filter((e) => e.side === 'AXIS').length, alL = la.filter((e) => e.side === 'ALLIED').length;
  const thaw = w.events.history.filter((e) => e.type === 'torp.hit' || e.type === 'torpedo.hit');
  const hitsBy = {};
  for (const e of thaw) { const s = w.ship(e.ship || e.byShip); if (s) hitsBy[s.side] = (hitsBy[s.side] || 0) + 1; }
  const pe = w.ships.find((s) => (s.id || '').indexOf('prinz') >= 0);
  console.log('第 ' + (2000 + k) + ' 局：鱼雷发射 轴' + axL + ' 盟' + alL + ' | 命中 ' + JSON.stringify(hitsBy) + ' | 欧根鱼雷管 ' + (pe.torpedoMounts || []).map((m) => m.tubesLoaded + '/' + m.tubes).join(',') + ' 欧根在航 ' + pe.isAfloat);
  const hood = w.ships.find((s) => (s.id || '').indexOf('hood') >= 0);
  console.log('   胡德 ' + (hood.isAfloat ? '在航' : '沉没') + ' 进水 ' + Math.round(hood.floodedM3) + ' 主炮 ' + hood.mainBatteries.filter((b) => !b.destroyed).length + '/4');
}
