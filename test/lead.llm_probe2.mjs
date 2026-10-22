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
  ['max_tokens=12000', { messages, max_tokens: 12000, temperature: 0.2 }],
  ['thinking disabled', { messages, max_tokens: 3000, temperature: 0.2, chat_template_kwargs: { thinking: false } }],
  ['reasoning_effort=low', { messages, max_tokens: 3000, temperature: 0.2, reasoning_effort: 'low' }],
];
for (const [name, body] of variants) {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const jj = await res.json();
    if (!res.ok) { console.log(name + ' → HTTP ' + res.status + ' ' + JSON.stringify(jj).slice(0, 160)); continue; }
    const m = jj.choices && jj.choices[0] && jj.choices[0].message;
    const content = (m && m.content) || '';
    const reasoning = (m && m.reasoning_content) || '';
    const dec = parseDecisionJSON(content || reasoning);
    console.log(name + ' → finish=' + (jj.choices && jj.choices[0] && jj.choices[0].finish_reason) + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's content=' + content.length + ' reasoning=' + reasoning.length + ' 解析=' + (dec ? '成功/' + (dec.commands || []).length + '命令' : '失败'));
    if (dec) console.log('    ' + JSON.stringify(dec.commands).slice(0, 200));
  } catch (e) { console.log(name + ' 异常 ' + e.message); }
}
