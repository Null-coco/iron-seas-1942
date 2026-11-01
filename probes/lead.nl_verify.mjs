import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { parseOrderSmart, parseChineseOrder } from '../src/ai/nl.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');

// A) 开局 t=0 下的命令是否被 AI 覆盖（|| 的坑）
{
  const w = new World({ scenario: sc, database: db, seed: 3, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  const sd = w.ship('sandbox_sd');
  w.issueCommand({ side: 'ALLIED', shipId: sd.id, kind: 'SET_COURSE', params: { heading: 240 }, scope: 'SHIP' }, { source: 'PLAYER' });
  console.log('A) t=0 下命令：_directiveSim=' + sd._directiveSim);
  w.advance(60);
  const aiCmds = w.commands.filter((c) => c.shipId === sd.id && c.source === 'AI_LOCAL' && c.kind === 'SET_COURSE').length;
  console.log('A) 60s 后指令航向=' + Math.round(sd.commanded.heading) + '（期望 240）· AI 对该舰的转向命令 ' + aiCmds + ' 条（期望 0）');
  console.log((Math.round(sd.commanded.heading) === 240 && aiCmds === 0) ? '   ✅ 开局命令不再被覆盖' : '   ⚠️ 仍被覆盖');
}

// B) 规则未命中 → 模型兜底
{
  const w = new World({ scenario: sc, database: db, seed: 3, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
  w.advance(120);
  const phrase = '追击敌人';
  const r1 = parseChineseOrder(phrase, w, 'ALLIED');
  console.log('B) 自由说法「' + phrase + '」规则解析 → ' + r1.length + ' 条');
  const stub = async () => JSON.stringify({ reasoning: '避开强敌', commands: [{ kind: 'SMOKE', params: { on: true } }, { kind: 'SET_COURSE', params: { heading: 120 } }, { kind: 'SET_SPEED', params: { kn: 24 } }] });
  const r2 = await parseOrderSmart(phrase, w, 'ALLIED', { llmCall: stub });
  console.log('B) 模型兜底 → via=' + r2.via + '，命令 ' + r2.commands.length + ' 条：' + JSON.stringify(r2.commands));
  console.log((r2.via === 'LLM' && r2.commands.length === 3) ? '   ✅ 规则未命中时模型能接手' : '   ⚠️ 兜底未生效');
}
