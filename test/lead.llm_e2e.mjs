// 端到端：用真实 LLM（OpenCode Go / deepseek-v4.1-flash）作为一方指挥官。
// 流程：装配剧本 → 生成态势提示词(nl.buildLLMPrompt) → POST 游戏代理 /api/llm/chat
//       → parseDecisionJSON 解析 → 命令灌回 world → 推进仿真验证被接受。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { buildLLMPrompt, parseDecisionJSON, describeSituation } from '../src/ai/nl.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const PROXY = process.env.PROXY || 'http://127.0.0.1:8787';

const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
w.advance(240);   // 让雷达/目视建立航迹
const st = w.visibleStateFor('AXIS');
console.log('态势：AXIS 有 ' + st.tracks.length + ' 条航迹，海况 ' + st.environment.seaState + '，能见度 ' + st.environment.visibilityNm + 'nm，光照 ' + st.environment.lightLevel.toFixed(2));
console.log('本地 AI 参谋简报（对照）：' + w.ai['AXIS'].local.lastReasoning.slice(0, 70));

const messages = buildLLMPrompt(w, 'AXIS', '请依据态势下达本周期指令，务必只输出 JSON。');
console.log('提示词规模：' + messages.length + ' 条消息，' + JSON.stringify(messages).length + ' 字符');
const t0 = Date.now();
let raw = null, err = null;
try {
  const res = await fetch(PROXY + '/api/llm/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 6000, temperature: 0.3 }),
  });
  const jj = await res.json();
  if (!res.ok) err = 'HTTP ' + res.status + '：' + JSON.stringify(jj).slice(0, 300);
  else {
    const m = jj.choices && jj.choices[0] && jj.choices[0].message;
    raw = (m && m.content && m.content.trim()) ? m.content : (m && m.reasoning_content) || '';
    console.log('上游：model=' + jj.model + ' finish=' + (jj.choices && jj.choices[0] && jj.choices[0].finish_reason) + ' 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
} catch (e) { err = String(e && e.message || e); }
if (err) { console.log('LLM 调用失败：' + err); process.exit(2); }
console.log('原始回复（前 420 字符）：\n' + String(raw).slice(0, 420));

const dec = parseDecisionJSON(raw);
if (!dec) { console.log('解析失败：模型没有给出可解析的决策 JSON'); process.exit(3); }
console.log('解析结果：reasoning=' + JSON.stringify(dec.reasoning || '').slice(0, 160));
console.log('命令 ' + (dec.commands || []).length + ' 条：' + JSON.stringify(dec.commands).slice(0, 500));

const before = w.commands.length;
w.ai['AXIS'].submitDecision(Object.assign({ reasoning: dec.reasoning || 'LLM' }, dec));
w.advance(60);
const issued = w.commands.slice(before);
const accepted = w.events.history.filter((e) => e.type === 'order.effective' && e.cmd && e.cmd.source === 'AI_REMOTE').length;
console.log('灌回仿真：新增命令 ' + issued.length + ' 条，生效 ' + accepted + ' 条');
for (const c of issued.slice(0, 6)) console.log('  ' + c.kind + ' ' + JSON.stringify(c.params || {}).slice(0, 90) + ' → 生效时刻 t+' + c.t_effective.toFixed(0) + 's');
const axis = w.afloatOf('AXIS');
console.log('AXIS 舰船状态：' + axis.map((s) => s.name + ' 航向' + Math.round(s.heading) + ' ' + s.speed.toFixed(1) + 'kn' + (s.commanded.firing ? ' 交战中' : '')).join(' | '));
console.log(accepted > 0 ? '✅ LLM 指挥官端到端可用' : '⚠️ 命令未生效（检查参数是否被白名单过滤）');
process.exit(accepted > 0 ? 0 : 4);
