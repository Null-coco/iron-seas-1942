import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
const w = new World({ scenario: sc, database: db, seed: 1003, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const axisAI = w.ai['AXIS'].local || w.ai['AXIS'];
console.log('轴心目标 id: ' + JSON.stringify(axisAI.objectiveTargetIds(w)));
const st = w.visibleStateFor('AXIS');
console.log('轴心可见航迹的 targetId 字段: ' + JSON.stringify((st.tracks || []).map((t) => ({ id: t.id, targetId: t.targetId, cls: t.classifiedAs })).slice(0, 4)));
const bis = w.ships.find((s) => (s.id || '').indexOf('bismarck') >= 0);
console.log('俾斯麦 id=' + bis.id + ' 初始航速 ' + bis.speed + ' 主炮 ' + bis.mainBatteries.length + ' 指挥仪 ' + (bis.directors || []).length);
let disableT = 0;
const hitsOn = {};
w.events.on('gun.hit', (e) => { if (e.ship === bis.id || e.targetShipId === bis.id) { const k = e.byShip || '?'; hitsOn[k] = (hitsOn[k] || 0) + 1; } });
for (let k = 0; k < 150; k++) {
  w.advance(10);
  const spd = bis.speedCapKn, mains = (bis.mainBatteries || []).filter((b) => !b.destroyed && b.health > 0.15).length;
  const dirs = (bis.directors || []).filter((d) => !d.destroyed && (d.health === undefined || d.health > 0.2)).length;
  if (k % 10 === 0) console.log('t=' + Math.round(w.t) + ' 俾斯麦 速度上限 ' + spd.toFixed(1) + ' 主炮 ' + mains + '/' + bis.mainBatteries.length + ' 指挥仪 ' + dirs + ' 进水 ' + Math.round(bis.floodedM3) + ' 横倾 ' + bis.list.toFixed(1) + ' | 命中来源 ' + JSON.stringify(hitsOn) + (w.over ? '  [结束:' + (w.resultText || '') + ']' : ''));
  if (w.over) break;
}
console.log('结束：' + (w.over ? w.resultText + ' 胜者 ' + w.winner : '未决') + ' | 俾斯麦在航 ' + bis.isAfloat + ' 速度上限 ' + bis.speedCapKn.toFixed(1) + ' 进水 ' + Math.round(bis.floodedM3));
