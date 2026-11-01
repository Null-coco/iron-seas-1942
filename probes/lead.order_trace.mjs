import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { parseChineseOrder } from '../src/ai/nl.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 1, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
w.advance(120);
const sd = w.ship('sandbox_sd');
// 完全复刻 app.js sendChat 的展开逻辑
const parsed = parseChineseOrder('全队转向 240，24 节', w, 'ALLIED');
const cmds = [];
for (const c of parsed) {
  if (c.scope === 'FLEET') { for (const s of w.afloatOf('ALLIED')) cmds.push(Object.assign({ side: 'ALLIED' }, c, { shipId: s.id, scope: 'FLEET' })); }
  else cmds.push(Object.assign({ side: 'ALLIED' }, c, { shipId: c.shipId || sd.id }));
}
console.log('解析出 ' + parsed.length + ' 条 → 展开为 ' + cmds.length + ' 条；第一条 ' + JSON.stringify(cmds[0]));
for (const c of cmds) w.issueCommand(c, { source: 'PLAYER' });
console.log('下达后：sd 指令航向 ' + Math.round(sd.commanded.heading) + ' _directiveSim=' + (sd._directiveSim === undefined ? 'undefined' : Math.round(sd._directiveSim)));
const n0 = w.commands.length;
for (let i = 0; i < 8; i++) {
  w.advance(5);
  const landed = w.commands.slice(n0).filter((c) => c.shipId === sd.id && c.t_effective <= w.t && c.t_effective > w.t - 5.1);
  console.log('t=' + Math.round(w.t) + ' 指令航向=' + Math.round(sd.commanded.heading) + ' 舵=' + sd.rudder.toFixed(0) + ' 速度=' + sd.commanded.speed.toFixed(0) + ' | 本 5s 生效: ' + (landed.map((c) => c.source + '/' + c.kind + '/' + JSON.stringify(c.params)).join(' ') || '无'));
}
const all = w.commands.slice(n0).filter((c) => c.shipId === sd.id);
console.log('总命令 ' + all.length + ' 条，其中 AI_LOCAL ' + all.filter((c) => c.source === 'AI_LOCAL').length + ' 条');
