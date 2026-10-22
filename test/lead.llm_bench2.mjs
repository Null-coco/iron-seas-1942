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
const full = buildLLMPrompt(w, 'AXIS', '只输出 JSON，不要输出思考过程。');
// 精简版提示词：只保留 system 指令 + 一句压缩态势（模拟"快速模式"）
const compact = [
  full[0],
  { role: 'user', content: '时间 ' + w.t.toFixed(0) + 's 海况' + w.env.seaState + ' 能见度' + w.env.visibilityNm + 'nm 光照' + w.env.lightLevel.toFixed(2) + '\n' +
    '我方：' + w.afloatOf('AXIS').map((s) => s.id + ' ' + s.name + ' 航向' + Math.round(s.heading) + ' ' + s.speed.toFixed(0) + 'kn 进水' + Math.round(s.floodedM3) + 'm³').join('；') + '\n' +
    '航迹：' + w.visibleStateFor('AXIS').tracks.map((t) => t.id + ' ' + t.classifiedAs + ' ' + (t.rangeM / 1852).toFixed(1) + 'nm 方位' + t.bearingDeg + '° 置信' + t.confidence).join('；') +
    '\n只输出 JSON：{"reasoning":"...","commands":[...],"intent":"..."}' },
];
const cases = [
  ['mimo-v2.6-flash', compact, 700],
  ['mimo-v2.6-flash', compact, 1200],
  ['mimo-v2.6-flash', full, 900],
  ['mimo-v2.5', compact, 900],
  ['hy3', compact, 900],
  ['space-bunny', compact, 900],
  ['grok-4.6', compact, 900],
  ['claude-haiku-5-5', compact, 900],
];
for (const [m, msgs, mt] of cases) {
  const t0 = Date.now();
  let line = m.padEnd(20) + ' mt=' + String(mt).padEnd(5) + (msgs === compact ? 'compact' : 'full   ');
  try {
    const res = await fetch('http://127.0.0.1:8787/api/llm/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: msgs, max_tokens: mt, temperature: 0.2 }),
    });
    const jj = await res.json();
    const s = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    if (!res.ok) { console.log(line + ' ' + s + '  ' + ((jj.error && jj.error.message) || '').slice(0, 70)); continue; }
    const ch = jj.choices[0], msg = ch.message || {};
    const dec = parseDecisionJSON(msg.content || msg.reasoning_content || '');
    console.log(line + ' ' + s.padStart(7) + ' finish=' + String(ch.finish_reason).padEnd(7) + ' c=' + String((msg.content || '').length).padEnd(5) + ' r=' + String((msg.reasoning_content || '').length).padEnd(6) + (dec ? '✓命令' + (dec.commands || []).length : '✗'));
  } catch (e) { console.log(line + ' ERR ' + String(e.message).slice(0, 60)); }
}
