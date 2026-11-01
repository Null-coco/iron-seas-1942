// 验证"AI 有真正的上下文"：连续两轮真实 LLM 决策，第二轮必须带着第一轮的记忆（历史/战况/命令/目标机动）。
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
const PROXY = 'http://127.0.0.1:8787';
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
const ctx = new AIContext(w, 'AXIS', {});
const fails = [];
const call = async (messages, label) => {
  const t0 = Date.now();
  const res = await fetch(PROXY + '/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, max_tokens: 12000, temperature: 0.2 }) });
  const jj = await res.json();
  if (!res.ok) { fails.push(label + ' HTTP ' + res.status); return null; }
  const m = jj.choices[0].message;
  const content = (m.content || '').trim() ? m.content : (m.reasoning_content || '');
  const dec = parseDecisionJSON(content);
  console.log(label + '：finish=' + jj.choices[0].finish_reason + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，解析=' + (dec ? '成功(' + (dec.commands || []).length + '命令)' : '失败'));
  return { content, dec };
};

w.advance(120);
// ---- 第 1 轮 ----
let b = ctx.build('请依据态势下达本周期命令。');
console.log('第1轮上下文：' + b.messages.length + ' 条消息 / ' + JSON.stringify(b.messages).length + ' 字符');
console.log('系统提示词前 200 字：' + b.system.slice(0, 200).replace(/\n/g, ' '));
let r1 = await call(b.messages, '第1轮');
if (!r1 || !r1.dec) { console.log('第1轮失败，终止'); process.exit(2); }
console.log('  意图：' + (r1.dec.intent || r1.dec.reasoning || '').slice(0, 120));
console.log('  命令：' + JSON.stringify(r1.dec.commands).slice(0, 260));
ctx._lastSituation = b.situation;
ctx.remember(r1.content, r1.dec);
w.ai['AXIS'].submitDecision(Object.assign({ reasoning: r1.dec.reasoning || 'LLM' }, r1.dec));
w.advance(150);   // 打一会儿，产生战况/命令生效/目标机动

// ---- 第 2 轮 ----
b = ctx.build('上一周期的命令效果如何？继续保持还是改变计划？');
console.log('\n第2轮上下文：' + b.messages.length + ' 条消息 / ' + JSON.stringify(b.messages).length + ' 字符');
const st2 = ctx.stats();
console.log('记忆统计：轮次' + st2.turns + ' 战况事件' + st2.events + ' 我的命令' + st2.orders + ' 航迹记忆' + st2.tracks);
const checks = [
  ['系统提示词含任务与命令表', /你的任务|可用命令/.test(b.system)],
  ['含既往决策回顾', /既往决策回顾/.test(JSON.stringify(b.messages))],
  ['含自上次以来的战况', /自上次决策以来的战况/.test(b.situation)],
  ['含我的命令记录', /我下达过的命令/.test(b.situation)],
  ['含上周期意图', /上周期我的意图/.test(b.situation)],
  ['航迹含距离变化率', /距离[+-]/.test(b.situation)],
  ['消息数多于第1轮', b.messages.length > 2],
];
for (const [n, ok] of checks) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (!ok) fails.push(n); }
console.log('\n发给 AI 的第 2 轮态势简报（节选）：\n' + b.situation.slice(0, 1400));
const r2 = await call(b.messages, '第2轮');
if (r2 && r2.dec) {
  console.log('\n第2轮模型的 reasoning（看它是否引用历史）：\n' + String(r2.dec.reasoning || '').slice(0, 600));
  console.log('第2轮命令：' + JSON.stringify(r2.dec.commands).slice(0, 300));
}
console.log('\n' + (fails.length ? ('失败 ' + fails.length + ' 项：' + fails.join(' / ')) : '✅ 上下文验证全部通过'));
process.exit(fails.length ? 3 : 0);
