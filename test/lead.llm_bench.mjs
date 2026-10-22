// 模型延迟/可用性基准：用真实态势提示词跑一遍候选模型，看谁又快又能出可解析命令。
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
const MODELS = process.argv.slice(2);
const rows = [];
for (const m of MODELS) {
  const t0 = Date.now();
  let out = { model: m, ms: -1, finish: '-', content: 0, reasoning: 0, cmds: -1, err: '' };
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages, max_tokens: 1500, temperature: 0.2 }),
    });
    const jj = await res.json();
    out.ms = Date.now() - t0;
    if (!res.ok) { out.err = (jj.error && jj.error.message || JSON.stringify(jj)).slice(0, 90); }
    else {
      const ch = jj.choices && jj.choices[0];
      const msg = ch && ch.message || {};
      out.finish = ch && ch.finish_reason;
      out.content = (msg.content || '').length;
      out.reasoning = (msg.reasoning_content || '').length;
      const dec = parseDecisionJSON(msg.content || msg.reasoning_content || '');
      out.cmds = dec ? (dec.commands || []).length : -1;
    }
  } catch (e) { out.ms = Date.now() - t0; out.err = String(e.message).slice(0, 80); }
  rows.push(out);
  console.log([out.model.padEnd(28), String((out.ms / 1000).toFixed(1) + 's').padStart(7), (out.finish || '').padEnd(7),
    ('c=' + out.content).padEnd(9), ('r=' + out.reasoning).padEnd(9), ('命令=' + out.cmds).padEnd(8), out.err].join(' '));
}
console.log('\n按速度排序：');
rows.slice().sort((a, b) => a.ms - b.ms).forEach((r) => console.log('  ' + (r.ms / 1000).toFixed(1) + 's  ' + r.model + (r.cmds >= 0 ? '  ✓命令' + r.cmds : '  ✗' + (r.err || '解析失败'))));
