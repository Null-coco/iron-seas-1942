import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 7, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
const ai = w.ai['AXIS'];
const bs = w.ship('bismarck');
// 模拟一个"慢 LLM"：立即返回一条转向命令（stub），然后看本地执行官会不会覆盖它
ai.connectLLM('', { model: 'stub', maxTokens: 500, compact: true });
// 注意：connectLLM 会覆盖 llmCall，所以 stub 必须在它之后注入
try { ai.setLLMCall(async () => JSON.stringify({ reasoning: 'stub', intent: 'stub', commands: [{ shipId: 'bismarck', kind: 'SET_COURSE', params: { heading: 200 } }] })); } catch (e) { ai.llmCall = async () => JSON.stringify({ reasoning: 'stub', intent: 'stub', commands: [{ shipId: 'bismarck', kind: 'SET_COURSE', params: { heading: 200 } }] }); }
ai.intervalS = 1;
w.advance(20);
const cmdAfterLLM = bs.commanded.heading;
const dcOrders = w.commands.filter((c) => c.kind === 'DC_PRIORITY').length;
const localCourses = w.commands.filter((c) => c.kind === 'SET_COURSE' && c.source === 'AI_LOCAL').length;
const llmCourses = w.commands.filter((c) => c.kind === 'SET_COURSE' && c.source === 'AI_REMOTE').length;
w.advance(120);
console.log('LLM 下令后 20s：俾斯麦指令航向=' + Math.round(cmdAfterLLM) + '（期望 200）');
console.log('120s 后：指令航向=' + Math.round(bs.commanded.heading) + '（应仍为 200，未被本地执行官覆盖）');
console.log('命令统计：LLM 转向=' + llmCourses + ' 本地转向=' + localCourses + ' 损管=' + dcOrders + '（损管/规避应由执行官继续下）');
console.log('AI 状态：backend=' + ai.backend + ' 执行官=' + (ai.executiveMode !== false) + ' 本地AI命令数=' + ai.local.lastCommands);
console.log((Math.round(bs.commanded.heading) === 200 || Math.abs(bs.commanded.heading - 200) < 15) ? '✅ 外部指挥官的命令未被覆盖（执行官模式生效）' : '⚠️ 命令被覆盖了');
