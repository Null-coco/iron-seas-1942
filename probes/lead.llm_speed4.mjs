import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { parseDecisionJSON } from '../src/ai/nl.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
w.advance(240);
const st = w.visibleStateFor('AXIS');
const own = w.afloatOf('AXIS');
const ultra = [
  { role: 'system', content: '你是1942年德国海军编队指挥官。只输出一行JSON：{"reasoning":"<40字","commands":[{"shipId","kind","params"}],"intent":"<20字"}。可用kind：SET_COURSE{heading} SET_SPEED{kn} FIRE{trackId,ammo} CEASE_FIRE LAUNCH_TORPEDO{trackId,tubes} SMOKE{on} WITHDRAW。' },
  { role: 'user', content: '我方：' + own.map((s) => s.id + ' ' + s.name + ' 航向' + Math.round(s.heading) + ' ' + s.speed.toFixed(0) + 'kn').join('；') +
    '。目标航迹：' + st.tracks.map((t) => t.id + ' ' + t.classifiedAs + ' ' + (t.rangeM / 1852).toFixed(1) + 'nm 方位' + t.bearingDeg + '° 置信' + t.confidence).join('；') + '。下达本周期命令。' },
];
const short = [
  { role: 'system', content: '你是1942年德国海军编队指挥官，在丹麦海峡作战。只输出 JSON，不要思考过程：{"reasoning":"<60字","commands":[{"shipId","kind","params","note"}],"intent":"<30字"}。命令表：SET_COURSE{heading} SET_SPEED{kn} SET_RUDDER{deg} FIRE{trackId,ammo:"AP"|"HE",salvoes} CEASE_FIRE ASSIGN_TARGET{trackId} LAUNCH_TORPEDO{trackId,spreadDeg,tubes} SMOKE{on} RADAR{on} SEARCHLIGHT{on,bearing} CHAFF{} DC_PRIORITY{mode} WITHDRAW。原则：远距只校射、近距全齐射；夜战靠雷达接近到5-9km；驱逐舰前出2-6km雷击。' },
  { role: 'user', content: '时间' + w.t.toFixed(0) + 's 光照' + w.env.lightLevel.toFixed(2) + ' 能见度' + w.env.visibilityNm + 'nm。我方：' + own.map((s) => s.id + ' ' + s.name + ' 航向' + Math.round(s.heading) + ' ' + s.speed.toFixed(0) + 'kn 进水' + Math.round(s.floodedM3) + 'm³').join('；') + '。航迹：' + st.tracks.map((t) => t.id + ' ' + t.classifiedAs + ' ' + (t.rangeM / 1852).toFixed(1) + 'nm 方位' + t.bearingDeg + '°').join('；') + '。' },
];
const run = async (label, messages, model, mt) => {
  const lat = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch('http://127.0.0.1:8787/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: mt, temperature: 0.2 }) });
      const jj = await res.json();
      const ms = Date.now() - t0; lat.push(ms);
      if (!res.ok) { console.log('  ' + label + ' ' + (ms / 1000).toFixed(1) + 's ERR ' + ((jj.error && jj.error.message) || '').slice(0, 50)); continue; }
      const ch = jj.choices[0], m = ch.message || {};
      const dec = parseDecisionJSON(m.content || m.reasoning_content || '');
      console.log('  ' + label.padEnd(34) + ' 输入' + String(JSON.stringify(messages).length).padStart(5) + '字符 ' + (ms / 1000).toFixed(1) + 's finish=' + String(ch.finish_reason).padEnd(7) + ' c=' + String((m.content || '').length).padEnd(5) + (dec ? '✓命令' + (dec.commands || []).length : '✗'));
    } catch (e) { console.log('  ' + label + ' ERR ' + String(e.message).slice(0, 40)); }
  }
  if (lat.length) console.log('    平均 ' + (lat.reduce((a, b) => a + b, 0) / lat.length / 1000).toFixed(1) + 's');
};
await run('极简提示词 mimo-v2.6-flash mt=500', ultra, 'mimo-v2.6-flash', 500);
await run('极简提示词 mimo-v2.5 mt=500', ultra, 'mimo-v2.5', 500);
await run('短提示词 mimo-v2.6-flash mt=700', short, 'mimo-v2.6-flash', 700);
await run('短提示词 mimo-v2.5 mt=700', short, 'mimo-v2.5', 700);
