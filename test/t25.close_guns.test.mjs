#!/usr/bin/env node
// T25：近距离混战——目标 ≤ CLOSE_ALL_GUNS_M 时副炮/高射炮压平，全炮开火；弹药按目标类型自动选。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);

let pass = 0, fail = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log('  \u2714 ' + l); } else { fail++; failures.push(l); console.log('  \u2716 ' + l); } return !!c; };
const section = (t) => console.log('\n=== ' + t + ' ===');

function makeWorld(ownClass, foeClass, sepM, seed) {
  const scen = {
    id: 'close_test', nameZh: '近距离测试', date: '1943-06-01',
    start: { lat: 30, lon: -40, date: '1943-06-01T12:00:00Z', env: { windKn: 8, visibilityNm: 20, seaState: 2 } },
    env: { windKn: 8, visibilityNm: 20, seaState: 2 },
    sides: { ALLIED: { nameZh: '同盟', objective: '测试', orderDelay_s: 1 }, AXIS: { nameZh: '轴心', objective: '测试', orderDelay_s: 1 } },
    ships: [
      { id: 'a1', name: '本方', class: ownClass, side: 'ALLIED', x: 0, y: 0, heading: 90, speed: 0, role: 'flagship' },
      { id: 'b1', name: '目标', class: foeClass, side: 'AXIS', x: sepM, y: 0, heading: 270, speed: 0, role: 'flagship' },
    ],
    objectives: [], triggers: [],
  };
  return new World({ scenario: scen, database: db, seed, ai: true, aiOpts: { backend: 'LOCAL' }, buildFromScenario: true });
}
function run(w, seconds) { const dt = 0.1; for (let i = 0; i < Math.round(seconds / dt); i++) w.step(dt); }
const fires = (w) => w.events.history.filter((e) => e.type === 'gun.fire');
const closeFires = (w) => fires(w).filter((e) => e.role === 'close');
const ammoCount = (arr) => arr.reduce((a, e) => { a[e.ammo] = (a[e.ammo] || 0) + 1; return a; }, {});

section('A. 2.5 km 对驱逐舰：全炮开火，弹药=HE（软目标）');
{
  const w = makeWorld('Iowa', 'Fletcher', 2500, 5);
  const a1 = w.ship('a1');
  console.log('  衣阿华炮组: ' + a1.batteries.map((b) => b.role + ':' + (b.data.bore_mm || '?') + 'mm').join(', '));
  run(w, 90);
  const f = fires(w);
  ok(f.length > 0, '有开火（' + f.length + ' 发）');
  ok(f.some((e) => e.role === 'main'), '主炮开火');
  const cf = closeFires(w);
  ok(cf.length > 0, '近距离全炮通道开火（' + cf.length + ' 发）');
  ok(cf.every((e) => e.targetShipId === 'b1'), '全炮通道每发都有明确目标 b1');
  ok(cf.every((e) => e.ammo === 'HE'), '对软目标全部 HE（' + JSON.stringify(ammoCount(cf)) + '）');
  const turrets = Math.max(0, ...w.events.history.filter((e) => e.type === 'gun.salvo.away' && e.role === 'close').map((e) => e.turrets || 0));
  ok(turrets >= 3, '齐射覆盖 ≥3 座非主炮炮塔（实际 ' + turrets + '）');
}

section('B. 15 km：全炮通道不参与');
{
  const w = makeWorld('Iowa', 'Fletcher', 15000, 6);
  run(w, 120);
  ok(fires(w).some((e) => e.role === 'main'), '主炮仍在开火');
  ok(closeFires(w).length === 0, '全炮通道零开火（' + closeFires(w).length + '）');
}

section('C. 2.5 km 对重巡：按穿深自动选弹（150mm AP / 105mm HE 混合）');
{
  const w = makeWorld('Bismarck', 'NewOrleans', 2500, 7);
  const own = w.ship('a1');
  console.log('  俾斯麦炮组: ' + own.batteries.map((b) => b.role + ':' + (b.data.bore_mm || '?') + 'mm').join(', '));
  run(w, 90);
  const cf = closeFires(w);
  const mix = ammoCount(cf);
  console.log('  全炮通道弹药构成: ' + JSON.stringify(mix));
  ok(cf.length > 0, '全炮通道开火（' + cf.length + ' 发）');
  ok((mix.AP || 0) > 0, '对重巡出现 AP（穿深足够的炮位，' + (mix.AP || 0) + ' 发）');
  ok((mix.HE || 0) > 0, '穿深不足的炮位仍用 HE（' + (mix.HE || 0) + ' 发）');
  const apBores = [...new Set(cf.filter((e) => e.ammo === 'AP').map((e) => e.caliberMM))];
  const heBores = [...new Set(cf.filter((e) => e.ammo === 'HE').map((e) => e.caliberMM))];
  ok(apBores.length === 0 || apBores.every((b) => b >= 150), 'AP 只出现在 ≥150mm 炮位（实际 ' + JSON.stringify(apBores) + '）');
  ok(heBores.length === 0 || heBores.every((b) => b <= 127), 'HE 出现在 ≤127mm 炮位（实际 ' + JSON.stringify(heBores) + '）');
}

console.log('\n=== 结果 ===');
console.log('  PASS ' + pass + ' / FAIL ' + fail + (fail === 0 ? '  \u2714 全部通过' : ''));
if (fail) { console.log('  失败项：'); for (const x of failures) console.log('    - ' + x); }
process.exit(fail === 0 ? 0 : 1);
