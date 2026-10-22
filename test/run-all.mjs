#!/usr/bin/env node
// 铁海 1942 全量验收：所有单元/集成测试 + 端到端剧本 + UI 启动 + 无头模式。
// 用法：node test/run-all.mjs   （退出码 0 = 全部通过）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const NODE = process.execPath;

const steps = [
  ['内核冒烟（定步长/航速/位移/事件）', ['test/lead.smoke.mjs']],
  ['T1 环境与舰体运动', ['test/t1.env.test.mjs']],
  ['T2 传感器/光学/航迹', ['test/t2.sensors.test.mjs']],
  ['T3 损伤与损管', ['test/t3.damage.test.mjs']],
  ['T4 火控/弹道/校射', ['test/t4.gunnery.test.mjs']],
  ['T5 AI 桥接/服务器/NL', ['test/t5.ai.test.mjs']],
  ['T6 战术 AI 与鱼雷', ['test/t6.tactics.test.mjs']],
  ['T8 剧本与文档校验', ['test/t8.scenarios.test.mjs']],
  ['T9 命中统计口径', ['test/t9.stats.test.mjs'], 120000],
  ['T10 殉爆语义', ['test/t10.magazine.test.mjs'], 120000],
  ['T11 战报/AAR/事件保留', ['test/t11.report.test.mjs'], 1200000],
  ['T12 AI 命令节流', ['test/t12.ai.test.mjs'], 180000],
  ['T13 陆地遮蔽（视线/弹道）', ['test/t13.terrain.test.mjs'], 120000],
  ['T14 敌我识别与友军误伤', ['test/t14.friendlyfire.test.mjs'], 180000],
  ['T16 可访问性/高对比主题', ['test/t16.a11y.test.mjs'], 120000],
  ['T17 剧本触发器', ['test/t17.triggers.test.mjs'], 120000],
  ['火控探针 8km 静止（史实 15-25%）', ['test/lead.gunnery_probe.mjs', '8000'], 25000],
  ['集成：丹麦海峡 1941（日间远距）', ['test/lead.integration.mjs', 'denmark_strait_1941', '900'], 120000],
  ['集成：萨沃岛 1942（夜间近距）', ['test/lead.integration.mjs', 'savo_island_1942', '600'], 120000],
  ['UI 启动（DOM 垫片下 600 帧）', ['test/lead.uiboot.mjs'], 120000],
  ['无头整场战斗', ['server/headless.mjs'], 180000],
];
const rows = [];
let failed = 0;
for (const [name, args, timeout] of steps) {
  const t0 = Date.now();
  const r = spawnSync(NODE, args, { cwd: R, encoding: 'utf8', timeout: timeout || 120000, maxBuffer: 32 * 1024 * 1024 });
  const ok = r.status === 0;
  if (!ok) failed++;
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.split('\n').filter((l) => /命中率|沉没|受损|PASS|FAIL|通过|失败|✅|❌|✗|✖|simSeconds|帧数/.test(l)).slice(-3).join(' | ');
  rows.push({ name, ok, ms: Date.now() - t0, tail: tail.slice(0, 300) });
  console.log((ok ? '✅' : '❌') + ' ' + name.padEnd(34) + ' ' + String(Date.now() - t0).padStart(6) + 'ms  ' + (ok ? '' : '← ' + tail.slice(0, 160)));
}
console.log('\n' + '='.repeat(78));
for (const r of rows) if (r.tail) console.log('  ' + r.name + '\n     ' + r.tail);
console.log('='.repeat(78));
console.log(failed ? ('验收失败：' + failed + '/' + rows.length + ' 项未通过') : ('验收全绿：' + rows.length + '/' + rows.length + ' 项通过'));
process.exit(failed ? 1 : 0);
