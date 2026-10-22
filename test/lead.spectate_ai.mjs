// 验证观战模式下"双方 AI 可独立修改"
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 5, playerSide: null, aiOpts: { backend: 'LOCAL' } });
const A = w.ai['ALLIED'], X = w.ai['AXIS'];
console.log('初始：ALLIED=' + A.backend + ' AXIS=' + X.backend + ' 自动指挥=' + A.autoCommand + '/' + X.autoCommand);
// 模拟 UI 动作（data-side 区分阵营）
X.applyPreset('deep');
A.applyPreset('fast');
A.autoCommand = false;
console.log('设置后：ALLIED=' + A.backend + '/' + (A.preset || '-') + ' 自动指挥=' + A.autoCommand + ' | AXIS=' + X.backend + '/' + (X.preset || '-') + ' 自动指挥=' + X.autoCommand);
console.log('模型：ALLIED=' + (A.llmModel || '-') + ' AXIS=' + (X.llmModel || '-') + ' | 周期：' + A.intervalS + 's / ' + X.intervalS + 's');
const ok = (A.preset === 'fast' && X.preset === 'deep' && A.autoCommand === false && X.autoCommand === true && A.intervalS !== X.intervalS);
console.log(ok ? '✅ 双方 AI 可独立配置（后端/预设/模型/自动指挥互不影响）' : '⚠️ 双方配置未隔离');
