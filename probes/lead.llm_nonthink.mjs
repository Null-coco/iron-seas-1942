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
const MODELS = process.argv.slice(2);
const rows = [];
for (const m of MODELS) {
  const t0 = Date.now();
  let out = { m, ms: -1, fin: '-', c: 0, r: 0, cmds: -1, err: '' };
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages, max_tokens: 900, temperature: 0.2, response_format: { type: 'json_object' } }) });
    const jj = await res.json();
    out.ms = Date.now() - t0;
    if (!res.ok) out.err = ((jj.error && jj.error.message) || '').slice(0, 60);
    else {
      const ch = jj.choices[0], msg = ch.message || {};
      out.fin = ch.finish_reason; out.c = (msg.content || '').length; out.r = (msg.reasoning_content || '').length;
      const dec = parseDecisionJSON(msg.content || msg.reasoning_content || '');
      out.cmds = dec ? (dec.commands || []).length : -1;
    }
  } catch (e) { out.ms = Date.now() - t0; out.err = String(e.message).slice(0, 50); }
  rows.push(out);
  console.log([out.m.padEnd(26), String((out.ms / 1000).toFixed(1) + 's').padStart(7), String(out.fin).padEnd(7), ('思考=' + (out.r > 0 ? out.r : '无')).padEnd(12), ('正文=' + out.c).padEnd(10), ('命令=' + out.cmds).padEnd(8), out.err].join(' '));
}
console.log('\n非思考且可用（按速度）:');
rows.filter((r) => r.r === 0 && r.cmds >= 0).sort((a, b) => a.ms - b.ms).forEach((r) => console.log('  ' + (r.ms / 1000).toFixed(1) + 's  ' + r.m + '  命令 ' + r.cmds));
