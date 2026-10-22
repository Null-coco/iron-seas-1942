import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const scenario = {
  id: 'probe', nameZh: 'probe',
  start: { lat: 0, lon: 0, date: '1942-06-01T12:00:00Z', env: { windKn: 5, windDirDeg: 270, visibilityNm: 25 } },
  sides: { ALLIED: { nameZh: 'A' }, AXIS: { nameZh: 'B' } },
  ships: [
    { id: 'S1', name: '胡德', class: 'Hood', side: 'ALLIED', x: 0, y: 0, heading: 0, speed: 0, role: 'flagship', crewQuality: 1.0 },
    { id: 'T1', name: '俾斯麦', class: 'Bismarck', side: 'AXIS', x: 8000, y: 0, heading: 0, speed: 0, role: 'flagship', crewQuality: 1.0 },
  ], objectives: [],
};
const world = new World({ scenario, database: db, seed: 7, playerSide: 'ALLIED', ai: false });
const shooter = world.ship('S1'), target = world.ship('T1');
const tr = world.tracks.observe({ side: 'ALLIED', srcKind: 'SCRIPT', pos: { x: target.pos.x, y: target.pos.y }, courseDeg: 0, speedKn: 0, accuracyM: 5, accuracyDeg: 0.02, classifiedAs: 'BB', confidence: 1, t: 0 });
world.issueCommand({ shipId: 'S1', kind: 'FIRE', params: { trackId: tr.id, ammo: 'AP', salvoes: 9999 }, side: 'ALLIED', scope: 'SHIP' });
for (let i = 0; i < 6; i++) {
  world.advance(60);
  const evs = world.events.history.filter((e) => e.type.indexOf('gun.') === 0 || e.type.indexOf('fc.') === 0);
  const last = evs.slice(-2).map((e) => e.type + '(' + Object.keys(e).filter((k) => ['rangeM','tof','distM','miss', 'splashHeightM','penetrated','ammo'].indexOf(k) >= 0).map((k) => k + '=' + e[k]).join(',') + ')');
  console.log('t=' + world.t.toFixed(0) + ' 项目弹丸=' + world.projectiles.length + ' 水柱总数=' + world.splashes.length + ' 事件数=' + evs.length +
    ' shots=' + shooter.stats.shotsFired + ' hits=' + shooter.stats.hits + ' 炮座装填=' + shooter.batteries.map((b) => b.loaded + '/' + b.gunsPerMount + ',cyc=' + (b.cycleTimer || 0).toFixed(1)).join(' ') +
    ' 指挥仪=' + shooter.directors.map((d) => (d.trackingTrackId || '-') + '|' + (d.solution ? 'HAS SOL' : 'NOSOL') + '|' + (d.lastUpdateT || 0).toFixed(0)).join(' '));
  if (last.length) console.log('   最近事件: ' + last.join(' ; '));
}
const first = world.projectiles[0];
console.log('样例弹丸字段: ' + (first ? Object.keys(first).join(',') : '无'));
if (first) console.log('  值: tof=' + (world.t - first.t0).toFixed(1) + ' z=' + (first.z || first.pos?.z) + ' targetShipId=' + first.targetShipId + ' salvoId=' + first.salvoId);
console.log('全部事件类型: ' + JSON.stringify(world.events.history.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {})));
