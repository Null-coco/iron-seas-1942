#!/usr/bin/env node
// T17：剧本触发器（scenario.triggers）——时间/条件触发、目标激活、脚本命令、环境变化。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label) => { if (cond) { pass++; console.log('  \u2714 ' + label); } else { fail++; failures.push(label); console.log('  \u2716 ' + label); } return !!cond; };
const section = (t) => console.log('\n=== ' + t + ' ===');

function makeScenario(triggers, objectives) {
  return {
    id: 'trig_test', nameZh: '触发器测试', date: '1943-06-01',
    start: { lat: 30, lon: -40, date: '1943-06-01T12:00:00Z', env: { windKn: 10, visibilityNm: 15, seaState: 3 } },
    env: { windKn: 10, visibilityNm: 15, seaState: 3 },
    sides: {
      ALLIED: { nameZh: '同盟', objective: '测试', orderDelay_s: 1 },
      AXIS: { nameZh: '轴心', objective: '测试', orderDelay_s: 1 },
    },
    ships: [
      { id: 'a1', name: '测试舰A', class: 'Fletcher', side: 'ALLIED', x: 0, y: 0, heading: 0, speed: 10, role: 'flagship' },
      { id: 'b1', name: '测试舰B', class: 'Kagero', side: 'AXIS', x: 8000, y: 0, heading: 180, speed: 10, role: 'flagship' },
    ],
    objectives: objectives || [],
    triggers,
  };
}
function run(world, seconds) { const dt = 0.1; for (let i = 0; i < Math.round(seconds / dt); i++) world.step(dt); }
const count = (w, type) => w.events.history.filter((e) => e.type === type).length;

section('A. at 时间触发器：准时且只触发一次');
{
  const w = new World({ scenario: makeScenario([{ id: 'm1', at: 5, action: { kind: 'MESSAGE', text: 'hello' } }]), database: db, seed: 1, ai: false });
  run(w, 3);
  ok(count(w, 'scenario.message') === 0, 't<at 时不触发');
  run(w, 5);
  ok(count(w, 'scenario.message') === 1, 'at 后触发一次（count=' + count(w, 'scenario.message') + '）');
  ok(count(w, 'scenario.trigger') === 1, 'scenario.trigger 事件一次');
  const msg = w.events.history.find((e) => e.type === 'scenario.message');
  ok(msg && msg.text === 'hello', '消息文本正确');
  run(w, 10);
  ok(count(w, 'scenario.message') === 1, 'once 语义：不重复触发');
}

section('B. when 条件触发器：条件满足后触发');
{
  const w = new World({ scenario: makeScenario([{ id: 's1', when: { type: 'SINK', side: 'AXIS', shipIds: ['b1'] }, action: { kind: 'MESSAGE', text: 'b sunk' } }]), database: db, seed: 2, ai: false });
  run(w, 5);
  ok(count(w, 'scenario.message') === 0, '条件未满足不触发');
  w.ship('b1').isAfloat = false;
  run(w, 1);
  ok(count(w, 'scenario.message') === 1, '沉没条件满足后触发');
}

section('C. ACTIVATE_OBJECTIVE：未激活目标不判负');
{
  const objs = [{ id: 'o1', active: false, side: 'ALLIED', result: 'ALLIED', text: '活到 1 秒', condition: { type: 'SURVIVE', side: 'ALLIED', seconds: 1 } }];
  const w = new World({ scenario: makeScenario([{ id: 'act', at: 20, action: { kind: 'ACTIVATE_OBJECTIVE', id: 'o1' } }], objs), database: db, seed: 3, ai: false });
  run(w, 10);
  ok(!w.over, '目标未激活：不判胜负');
  run(w, 12);
  ok(w.over && w.winner === 'ALLIED', '激活后参与判定（over=' + w.over + ' winner=' + w.winner + '）');
}

section('D. ORDER：脚本命令下达并生效');
{
  const w = new World({ scenario: makeScenario([{ id: 'ord', at: 2, action: { kind: 'ORDER', shipId: 'a1', order: 'SET_COURSE', params: { heading: 90 } } }]), database: db, seed: 4, ai: false });
  run(w, 3);
  const cmd = w.commands.find((c) => c.kind === 'SET_COURSE');
  ok(!!cmd && cmd.source === 'SCRIPT', '命令 source=SCRIPT');
  ok(!!cmd && cmd.shipId === 'a1', '命令目标正确');
  run(w, 5);
  ok(Math.abs(w.ship('a1').commanded.heading - 90) < 1e-6, '命令已生效（heading=' + w.ship('a1').commanded.heading + '）');
}

section('E. SET_ENV：风与能见度');
{
  const w = new World({ scenario: makeScenario([{ id: 'env', at: 1, action: { kind: 'SET_ENV', visibilityNm: 3, windKn: 25 } }]), database: db, seed: 5, ai: false });
  run(w, 2);
  ok(Math.abs(w.env.baseVisibilityNm - 3) < 1e-9, '能见度已改');
  ok(Math.abs(w.env.windKn - 25) < 3, '风速已改（windKn=' + w.env.windKn.toFixed(1) + '，含湍流演化）');
}

section('F. 无触发器：零开销、无触发器事件');
{
  const w = new World({ scenario: makeScenario([]), database: db, seed: 6, ai: false });
  run(w, 10);
  ok(count(w, 'scenario.trigger') === 0, '无 scenario.trigger 事件');
  ok(!w.over, '无目标不判负');
}

section('G. 剧本数据：丹麦海峡/萨沃岛已带触发器');
{
  const sc = j('data/scenarios.json');
  const list = sc.scenarios || sc;
  const ds = list.find((s) => s.id === 'denmark_strait_1941');
  const savo = list.find((s) => s.id === 'savo_island_1942');
  ok(ds && Array.isArray(ds.triggers) && ds.triggers.length >= 2, '丹麦海峡 triggers=' + (ds && ds.triggers ? ds.triggers.length : 0));
  ok(savo && Array.isArray(savo.triggers) && savo.triggers.length >= 2, '萨沃岛 triggers=' + (savo && savo.triggers ? savo.triggers.length : 0));
}

console.log('\n=== 结果 ===');
console.log('  PASS ' + pass + ' / FAIL ' + fail + (fail === 0 ? '  \u2714 全部通过' : ''));
if (fail) { console.log('  失败项：'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 ? 0 : 1);
