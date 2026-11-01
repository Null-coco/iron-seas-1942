import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { buildLLMPrompt, parseDecisionJSON } from '../src/ai/nl.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
w.advance(240);
const messages = buildLLMPrompt(w, 'AXIS', '只输出 JSON，不要输出思考过程。');
const variants = [
  { name: 'A: max_tokens=6000', body: { messages, max_tokens: 6000, temperature: 0.2 } },
  { name: 'B: max_tokens=6000 + json_object', body: { messages, max_tokens: 6000, temperature: 0.2, response_format: { type: 'json_object' } } },
];
for (const v of variants) {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v.body) });
    const jj = await res.json();
    const m = jj.choices && jj.choices[0] && jj.choices[0].message;
    const content = (m && m.content) || '';
    const reasoning = (m && m.reasoning_content) || '';
    const dec = parseDecisionJSON(content || reasoning);
    console.log(v.name + ' → HTTP ' + res.status + ' finish=' + (jj.choices && jj.choices[0] && jj.choices[0].finish_reason) + ' 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    console.log('   content 长度 ' + content.length + '，reasoning 长度 ' + reasoning.length + '，解析=' + (dec ? ('成功，命令 ' + (dec.commands || []).length + ' 条') : '失败'));
    if (dec) console.log('   命令样例：' + JSON.stringify(dec.commands).slice(0, 260));
    else console.log('   content 前 200 字符：' + content.slice(0, 200).replace(/\n/g, ' '));
  } catch (e) { console.log(v.name + ' 异常：' + e.message); }
}
