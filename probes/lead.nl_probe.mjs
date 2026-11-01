// 自然语言命令解析实测：看哪些说法解析不出来
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { parseChineseOrder, parseOrderSmart } from '../src/ai/nl.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 1, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
w.advance(120);
const phrases = ['全队转向240','转向240','航向240','左转30度','右转15度','右满舵','左满舵','正舵','全速前进','全速','24节','减速到12节','停车','向最近的敌舰开火','开火','齐射','停火','放烟幕','施放烟幕','开探照灯','雷达开机','鱼雷齐射','发射鱼雷','撤退','撤出战斗','损管优先灭火','优先堵漏','旗舰向俾斯麦开火','所有舰艇转向180','向T1开火','追击敌人','保持航向','加快到30节','右转90度然后全速','对最近的敌舰发射鱼雷'];
console.log('parseChineseOrder（我的 UI 目前用的）:');
let ok = 0;
for (const p of phrases) {
  let r = null, err = null;
  try { r = parseChineseOrder(p, w, 'ALLIED'); } catch (e) { err = String(e.message).slice(0, 40); }
  const n = r ? r.length : 0;
  if (n) ok++;
  console.log('  ' + (n ? '✓' : '✗') + ' ' + p.padEnd(18) + ' → ' + (err ? ('异常: ' + err) : JSON.stringify(r).slice(0, 110)));
}
console.log('解析成功 ' + ok + '/' + phrases.length);
console.log('\nparseOrderSmart 是否存在: ' + (typeof parseOrderSmart));
