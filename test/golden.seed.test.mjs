#!/usr/bin/env node
// 黄金种子回归：物理/数值改动后，固定 seed 的对局结果不应漂移出容差。
// 基线用 node tools/golden.mjs --update 生成。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll, CASES } from '../tools/golden.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, 'golden/baseline.json');
let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log('  \u2714 ' + l); } else { fail++; failures.push(l); console.log('  \u2716 ' + l); } return !!c; };

if (!fs.existsSync(BASE)) {
  console.log('  [SKIP] 还没有基线：先运行 node tools/golden.mjs --update');
  process.exit(0);
}
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const rows = runAll();
ok(rows.length === CASES.length, '用例数一致（' + rows.length + '/' + CASES.length + '）');
for (let i = 0; i < rows.length; i++) {
  const b = base.rows[i], r = rows[i];
  const tag = r.scenario + '@' + r.seed;
  if (!b) { ok(false, tag + '：基线缺失'); continue; }
  ok(r.winner === b.winner, tag + ' 胜方一致（' + b.winner + ' → ' + r.winner + '）');
  ok(Math.abs(r.sinks - b.sinks) <= 1, tag + ' 沉没数 ±1（' + b.sinks + ' → ' + r.sinks + '）');
  const hitTol = Math.max(6, Math.round(b.gunHits * 0.35));
  ok(Math.abs(r.gunHits - b.gunHits) <= hitTol, tag + ' 命中数 ±' + hitTol + '（' + b.gunHits + ' → ' + r.gunHits + '）');
  ok(Math.abs(r.shipsAfloat - b.shipsAfloat) <= 1, tag + ' 在航数 ±1（' + b.shipsAfloat + ' → ' + r.shipsAfloat + '）');
}
console.log('\n=== 结果 ===');
console.log('  PASS ' + pass + ' / FAIL ' + fail + (fail === 0 ? '  \u2714 全部通过' : ''));
if (fail) { console.log('  失败项：'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 ? 0 : 1);
