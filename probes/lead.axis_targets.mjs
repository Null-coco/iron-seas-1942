import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
for (let k = 0; k < 2; k++) {
  const w = new World({ scenario: sc, database: db, seed: 2000 + k, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  const byVictim = {}, targetLog = [];
  w.events.on('gun.hit', (e) => { const sh = w.ship(e.byShip), v = w.ship(e.ship); if (sh && sh.side === 'AXIS' && v) byVictim[v.name] = (byVictim[v.name] || 0) + 1; });
  for (let i = 0; i < 18; i++) {
    w.advance(100);
    const ax = w.afloatOf('AXIS');
    const ai = w.ai['AXIS'].local || w.ai['AXIS'];
    const pic = ai.picture(w, ax);
    const tg = ax.map((s) => s.name + '→' + (s.commanded.targetTrackId || '-'));
    targetLog.push('t=' + Math.round(w.t) + ' ' + tg.join(' ') + ' 焦点=' + (ai.fleet.focusTrackId || '-') + ' 航迹: ' + pic.map((e) => e.tr.id + ':' + e.classifiedAs + '@' + Math.round(e.rangeM / 1000) + 'km').slice(0, 5).join(' '));
  }
  console.log('== 第 ' + (2000 + k) + ' 局 ==');
  for (const l of targetLog.slice(0, 10)) console.log('  ' + l);
  console.log('  轴心命中分布: ' + JSON.stringify(byVictim));
  const al = w.afloatOf('ALLIED');
  console.log('  盟军在航: ' + al.map((s) => s.name + '(' + Math.round(s.heading) + '° ' + s.speed.toFixed(0) + 'kn)').join('、'));
}
