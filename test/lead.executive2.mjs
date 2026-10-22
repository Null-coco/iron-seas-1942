import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 7, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
const ai = w.ai['AXIS'];
ai.connectLLM('', { model: 'stub' });
let calls = 0;
ai.setLLMCall(async () => { calls++; return JSON.stringify({ reasoning: 'stub', intent: 'stub', commands: [{ shipId: 'bismarck', kind: 'SET_COURSE', params: { heading: 200 } }] }); });
ai.intervalS = 1;
const bs = w.ship('bismarck');
for (let i = 0; i < 8; i++) { w.advance(5); await tick(); }
const afterLLM = { hd: Math.round(bs.commanded.heading), stamp: bs._directiveSim, t: Math.round(w.t), remote: w.commands.filter((c) => c.source === 'AI_REMOTE').length };
ai.intervalS = 1e9;                      // 不再有新决策，测试"保持窗"
const localBefore = w.commands.filter((c) => c.source === 'AI_LOCAL' && c.shipId === 'bismarck' && c.kind === 'SET_COURSE').length;
for (let i = 0; i < 10; i++) { w.advance(10); await tick(); }
const localAfter = w.commands.filter((c) => c.source === 'AI_LOCAL' && c.shipId === 'bismarck' && c.kind === 'SET_COURSE').length;
console.log('LLM 决策落地：llmCall=' + calls + ' 次，AI_REMOTE 命令=' + afterLLM.remote + ' 条，俾斯麦指令航向=' + afterLLM.hd + '（期望 200），stamp t=' + Math.round(afterLLM.stamp));
console.log('保持窗内（+100s）：指令航向=' + Math.round(bs.commanded.heading) + '，本地 AI 对该舰的转向命令新增 ' + (localAfter - localBefore) + ' 条（期望 0）');
console.log('其他实时事务仍在跑：损管命令=' + w.commands.filter((c) => c.kind === 'DC_PRIORITY').length + ' 条，本地 AI 总命令=' + ai.local.lastCommands);
console.log((afterLLM.remote > 0 && Math.abs(bs.commanded.heading - 200) < 12 && (localAfter - localBefore) === 0) ? '✅ 执行官模式正确：外部指挥官的命令被保持，本地 AI 只管实时事务' : '⚠️ 行为不符预期');
