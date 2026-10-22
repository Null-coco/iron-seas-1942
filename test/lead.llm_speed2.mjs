import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { AIContext } from '../src/ai/context.js';
import { parseDecisionJSON } from '../src/ai/nl.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
w.advance(240);
const ctx = new AIContext(w, 'AXIS', { compact: true });
const messages = ctx.build('只输出 JSON，不要输出思考过程。').messages;
const run = async (label, model, extra, mt) => {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ model, messages, max_tokens: mt || 700, temperature: 0.2 }, extra || {})) });
    const jj = await res.json();
    const s = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    if (!res.ok) return console.log(label.padEnd(42) + s.padStart(7) + '  ' + ((jj.error && jj.error.message) || '').slice(0, 60));
    const ch = jj.choices[0], m = ch.message || {};
    const dec = parseDecisionJSON(m.content || m.reasoning_content || '');
    console.log(label.padEnd(42) + s.padStart(7) + ' finish=' + String(ch.finish_reason).padEnd(7) + ' c=' + String((m.content || '').length).padEnd(5) + ' r=' + String((m.reasoning_content || '').length).padEnd(6) + (dec ? '✓命令' + (dec.commands || []).length : '✗'));
  } catch (e) { console.log(label.padEnd(42) + ' ERR ' + String(e.message).slice(0, 50)); }
};
console.log('--- 关思考参数试验（mimo-v2.6-flash）---');
await run('mimo + thinking:disabled', 'mimo-v2.6-flash', { thinking: { type: 'disabled' } });
await run('mimo + chat_template_kwargs', 'mimo-v2.6-flash', { chat_template_kwargs: { thinking: false } });
await run('mimo + reasoning_effort=minimal', 'mimo-v2.6-flash', { reasoning_effort: 'minimal' });
await run('mimo + enable_thinking=false', 'mimo-v2.6-flash', { enable_thinking: false });
console.log('--- 候选模型（精简上下文 / 700 token）---');
await run('mimo-v2.5', 'mimo-v2.5');
await run('mimo-v2.5-pro', 'mimo-v2.5-pro');
await run('minimax-m3', 'minimax-m3');
await run('longcat-2.0', 'longcat-2.0');
await run('qwen3.7-plus', 'qwen3.7-plus');
await run('hy4-preview', 'hy4-preview');
