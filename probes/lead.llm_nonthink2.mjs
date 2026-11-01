import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { AIContext } from '../src/ai/context.js';
import { parseDecisionJSON } from '../src/ai/nl.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 5, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
w.advance(200);
const messages = new AIContext(w, 'AXIS', { compact: true }).build('只输出 JSON，不要思考过程。').messages;
const cases = JSON.parse(process.argv[2]);
for (const [m, mt, temp] of cases) {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages, max_tokens: mt, temperature: temp === undefined ? 0.2 : temp, response_format: { type: 'json_object' } }) });
    const jj = await res.json();
    const ms = Date.now() - t0;
    if (!res.ok) { console.log((m + ' mt=' + mt + ' T=' + (temp === undefined ? 0.2 : temp)).padEnd(40) + (ms / 1000).toFixed(1) + 's ERR ' + ((jj.error && jj.error.message) || '').slice(0, 55)); continue; }
    const ch = jj.choices[0], msg = ch.message || {};
    const dec = parseDecisionJSON(msg.content || msg.reasoning_content || '');
    console.log((m + ' mt=' + mt + ' T=' + (temp === undefined ? 0.2 : temp)).padEnd(40) + (ms / 1000).toFixed(1) + 's ' + String(ch.finish_reason).padEnd(7) + ' 思考=' + String((msg.reasoning_content || '').length).padEnd(6) + ' 正文=' + String((msg.content || '').length).padEnd(6) + (dec ? '✓命令' + (dec.commands || []).length : '✗'));
  } catch (e) { console.log((m + ' mt=' + mt).padEnd(40) + ' ERR ' + String(e.message).slice(0, 50)); }
}
