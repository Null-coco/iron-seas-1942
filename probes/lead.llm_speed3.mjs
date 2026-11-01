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
const messages = new AIContext(w, 'AXIS', { compact: true }).build('只输出 JSON，不要输出思考过程。').messages;
const run = async (model, mt, reps) => {
  const lat = [];
  for (let i = 0; i < reps; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: mt, temperature: 0.2 }) });
      const jj = await res.json();
      const ms = Date.now() - t0; lat.push(ms);
      if (!res.ok) { console.log('  ' + model + ' mt=' + mt + ' ' + (ms / 1000).toFixed(1) + 's ERR ' + ((jj.error && jj.error.message) || '').slice(0, 60)); continue; }
      const ch = jj.choices[0], m = ch.message || {};
      const dec = parseDecisionJSON(m.content || m.reasoning_content || '');
      console.log('  ' + model.padEnd(16) + ' mt=' + String(mt).padEnd(5) + (ms / 1000).toFixed(1) + 's finish=' + String(ch.finish_reason).padEnd(7) + ' c=' + String((m.content || '').length).padEnd(5) + ' r=' + String((m.reasoning_content || '').length).padEnd(5) + (dec ? '✓命令' + (dec.commands || []).length : '✗'));
      if (i === 0 && dec && dec.commands && dec.commands.length) console.log('     样例：' + JSON.stringify(dec.commands.slice(0, 2)).slice(0, 170));
    } catch (e) { console.log('  ' + model + ' ERR ' + String(e.message).slice(0, 50)); }
  }
  if (lat.length) console.log('    平均 ' + (lat.reduce((a, b) => a + b, 0) / lat.length / 1000).toFixed(1) + 's（n=' + lat.length + '）');
};
console.log('--- minimax-m3 预算扫描 ---');
await run('minimax-m3', 1500, 2);
await run('minimax-m3', 2500, 2);
console.log('--- 对照 ---');
await run('mimo-v2.6-flash', 900, 2);
