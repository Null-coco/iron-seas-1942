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
for (const compact of [true, false]) {
  const ctx = new AIContext(w, 'AXIS', { compact });
  const built = ctx.build('只输出 JSON，不要输出思考过程。');
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:8787/api/llm/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: built.messages, max_tokens: compact ? 700 : 8000, temperature: 0.2 }),
  });
  const jj = await res.json();
  const ms = Date.now() - t0;
  const ch = jj.choices && jj.choices[0], msg = (ch && ch.message) || {};
  const dec = parseDecisionJSON(msg.content || msg.reasoning_content || '');
  console.log((compact ? '精简上下文' : '完整上下文') + '：提示词 ' + JSON.stringify(built.messages).length + ' 字符 / ' + built.messages.length + ' 条 → ' +
    (ms / 1000).toFixed(1) + 's，finish=' + (ch && ch.finish_reason) + '，模型=' + jj.model + '，' + (dec ? ('✓命令 ' + (dec.commands || []).length + ' 条：' + JSON.stringify((dec.commands || []).slice(0, 3)).slice(0, 200)) : '✗解析失败'));
}
