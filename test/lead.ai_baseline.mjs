import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
console.log('剧本字段：' + Object.keys(sc).join(', '));
if (sc.objectives) console.log('objectives: ' + JSON.stringify(sc.objectives).slice(0, 300));
if (sc.victory) console.log('victory: ' + JSON.stringify(sc.victory).slice(0, 300));
const land = j('data/land.json'), dep = j('data/depth.json');
let agg = { bisAlive: 0, bisFlood: 0, bisDamage: 0, axisKills: 0, alliedKills: 0, peAlive: 0, winAxis: 0, winAllied: 0, none: 0, shots: 0, hits: 0, torp: 0 };
const rows = [];
for (const seed of [1, 2, 3, 4, 5]) {
  const w = new World({ scenario: sc, database: db, seed: 1000 + seed, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1500);
  const bis = w.ships.find((s) => s.name.indexOf('俾斯麦') >= 0 || s.id.indexOf('bismarck') >= 0);
  const pe = w.ships.find((s) => s.name.indexOf('欧根') >= 0 || s.id.indexOf('prinz') >= 0);
  const shots = w.ships.reduce((a, s) => a + s.stats.shotsFired, 0), hits = w.ships.reduce((a, s) => a + s.stats.hits, 0);
  const torp = w.events.history.filter((e) => e.type === 'torp.hit' || e.type === 'torpedo.hit').length;
  const axAlive = w.shipsOf('AXIS').filter((s) => s.isAfloat).length, alAlive = w.shipsOf('ALLIED').filter((s) => s.isAfloat).length;
  const axInit = w.shipsOf('AXIS').length, alInit = w.shipsOf('ALLIED').length;
  rows.push({ seed: 1000 + seed, bis: bis ? (bis.isAfloat ? '在航' : '沉没') : '-', bisFlood: bis ? Math.round(bis.floodedM3) : 0, pe: pe ? (pe.isAfloat ? '在航' : '沉没') : '-', axAlive: axAlive + '/' + axInit, alAlive: alAlive + '/' + alInit, hits: hits, shots, rate: (100 * hits / Math.max(1, shots)).toFixed(1), torp, winner: w.winner || '未决', result: (w.resultText || '').slice(0, 40) });
}
console.log('\n== 基线（当前 AI，轴心 5 局）==');
for (const r of rows) console.log('  seed ' + r.seed + ' | 俾斯麦 ' + r.bis + ' 进水 ' + r.bisFlood + 'm³ | 欧根 ' + r.pe + ' | 在航 轴' + r.axAlive + ' 盟' + r.alAlive + ' | 命中 ' + r.hits + '/' + r.shots + ' (' + r.rate + '%) 雷 ' + r.torp + ' | ' + r.winner + ' ' + r.result);
