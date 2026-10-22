import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 11, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
// 直接调一次 fireGate，看有没有异常
const ai = w.ai['ALLIED'].local || w.ai['ALLIED'];
w.advance(300);
const fires = w.events.history.filter((e) => e.type === 'gun.fire').length;
const decs = w.events.history.filter((e) => e.type === 'ai.decision').length;
console.log('300s：开火 ' + fires + ' 次，AI 决策 ' + decs + ' 次');
const st = w.visibleStateFor('ALLIED');
console.log('可见航迹 ' + (st.tracks || []).length + ' 条');
for (const tr of (st.tracks || []).slice(0, 3)) console.log('  ' + tr.id + ' ' + tr.classifiedAs + ' ' + (tr.rangeM / 1852).toFixed(2) + 'nm errM=' + tr.errM + ' errDeg=' + tr.errDeg);
// 手动跑一次 fireGate
try {
  const ship = w.shipsOf('ALLIED')[0];
  const e = (st.tracks || [])[0];
  if (e) {
    const g = ai.fireGate(ship, e, e.rangeM, w);
    console.log('fireGate 结果: ' + JSON.stringify(g));
  } else console.log('没有航迹可测 fireGate');
} catch (err) { console.log('fireGate 抛异常: ' + err.message + '\n' + String(err.stack).split('\n').slice(1, 4).join('\n')); }
