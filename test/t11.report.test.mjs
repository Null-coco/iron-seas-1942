// test/t11.report.test.mjs —— 战报 / AAR / 事件历史修复回归（零依赖，原生 ESM）
//
// 覆盖（对应任务 task-2）：
//   A. EventBus 保留策略：关键事件永不被高频噪声挤出；噪声超限按最旧淘汰并记账（不静默）；
//      关键事件自身超 hardLimit 时才丢最旧并计入 droppedCritical。
//   B. 30–40 分钟长局（默认 first_guadalcanal_1942 / 2400s / 20 舰，可用环境变量
//      NAVAL_T11_SECONDS 缩短做冒烟）：
//      (a) exportReplay() 的关键事件从 t<10s 开始（旧版 60000 截断会让回放开头丢失）；
//      (b) 关键事件计数 == 历史可见计数（不被静默截断），且累计 emit 数单独可查；
//      (c) AAR 时间线里存在普通炮战命中 gun.hit（旧版只剩夹叉）；
//      (d) dam.magazine 文案按 result 本地化，'hit' 不得写成殉爆；
//      (e) headless 大事记不再混入 fc.solution / sensor.detect，命中率小节 total hits/shots 自洽。
//   C. checkObjectives：scenario.sandbox && scenario.sandboxNoVictory 时跳过编队全灭判定。
//
// 运行： node test/t11.report.test.mjs
//        NAVAL_T11_SECONDS=600 node test/t11.report.test.mjs     # 快速冒烟
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, isCriticalEvent } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { collectAAR, describeEvent, MAGAZINE_RESULT_ZH } from '../src/ui/aar.js';
import { buildReport } from '../server/headless.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label) => { if (cond) { pass++; console.log('  \u2714 ' + label); } else { fail++; failures.push(label); console.log('  \u2716 ' + label); } return !!cond; };
const section = (t) => console.log('\n=== ' + t + ' ===');

const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const scenFile = j('data/scenarios.json');
const scenarios = scenFile.scenarios || scenFile;

// ---------------------------------------------------------------------------
section('A. 事件历史保留策略（单元，瞬时）');
// 用空剧本的 World 拿到 RetainingEventBus 实例（World 构造本身 emit 了 sim.start）
const empty = new World({ scenario: { id: 'unit_empty', nameZh: '单元', objectives: [], sides: {}, ships: [] }, database: db, ai: false });
const bus = empty.events;
ok(typeof bus.retention === 'function' && bus.emitted && bus.limit === 60000, 'World 使用保留式事件总线（limit=60000，有 retention 账本）');
ok(isCriticalEvent('gun.hit') && isCriticalEvent('ship.sink') && isCriticalEvent('dam.magazine') && isCriticalEvent('torp.hit'), '关键事件判定：gun.hit/ship.sink/dam.magazine/torp.hit = 关键');
ok(isCriticalEvent('order.issue') && isCriticalEvent('victory.achieved') && isCriticalEvent('sim.start'), '关键事件判定：order.issue/victory.*/sim.* = 关键');
ok(!isCriticalEvent('fc.solution') && !isCriticalEvent('fc.update') && !isCriticalEvent('sensor.detect') && !isCriticalEvent('gun.fire') && !isCriticalEvent('gun.miss'), '高频噪声判定：fc.solution/fc.update/sensor.detect/gun.fire/gun.miss = 噪声');

// 小限额模拟长局：1 条关键事件 + 150 条噪声 + 1 条关键事件
bus.clear();
bus.limit = 100; bus.hardLimit = 200;
bus.emit('gun.hit', { t: 0, ship: 'a', name: 'A舰' });
for (let i = 0; i < 150; i++) bus.emit('fc.solution', { t: i * 0.1, ship: 'a' });
bus.emit('ship.sink', { t: 100, ship: 'b', name: 'B舰' });
ok(bus.history.length === 100, '噪声超限后历史长度收敛到 limit=100（实际 ' + bus.history.length + '）');
ok(bus.droppedCritical === 0, '关键事件零丢弃（droppedCritical=' + bus.droppedCritical + '）');
ok(bus.droppedNoise === 52, '噪声被淘汰并有账可查（droppedNoise=' + bus.droppedNoise + '，预期 52 = 152 条事件 - 100 上限）');
ok(bus.history[0].type === 'gun.hit' && bus.history[0].t === 0, 't=0 的首条关键事件仍在历史里（旧版会被 FIFO 截断丢弃）');
ok(bus.history.some((e) => e.type === 'ship.sink' && e.t === 100), '后到的沉没事件也在历史里');
ok(bus.emitted['fc.solution'] === 150 && bus.kept['fc.solution'] === 98, '累计 emit 与历史保留分别记账（fc.solution emit=150 kept=98）');
ok(bus.retention().firstCriticalT === 0, 'firstCriticalT=0（关键事件自开局起可追溯）');

// 用真实 60000 上限复现 40 分钟长局的截断压力：1 条 t=0 关键事件 + 61000 条噪声 + 1 条沉没
const busReal = new World({ scenario: { id: 'unit_overflow', nameZh: '单元', objectives: [], sides: {}, ships: [] }, database: db, ai: false }).events;
busReal.clear();
busReal.emit('gun.hit', { t: 0, ship: 'a', name: 'A舰' });
for (let i = 0; i < 61000; i++) busReal.emit('fc.solution', { t: i * 0.04, ship: 'a' });
busReal.emit('ship.sink', { t: 2400, ship: 'b', name: 'B舰' });
ok(busReal.history.length === 60000, '真实上限 60000：历史收敛到 60000（实际 ' + busReal.history.length + '）');
ok(busReal.droppedNoise === 1002 && busReal.droppedCritical === 0, '淘汰的 1002 条全是噪声，关键事件零丢失（droppedNoise=' + busReal.droppedNoise + '，droppedCritical=' + busReal.droppedCritical + '）');
ok(busReal.history[0].type === 'gun.hit' && busReal.history[0].t === 0, '旧版此处会把 t=0 的 gun.hit 截断丢弃；现在仍在历史首条');
ok(busReal.history.some((e) => e.type === 'ship.sink' && e.t === 2400), 't=2400s 的沉没事件也在历史里');
ok(busReal.retention().firstCriticalT === 0, '真实上限下 firstCriticalT 仍为 0（回放/战报可从开局复盘）');

// 全是关键事件的极端情况：超 hardLimit 才丢，且 counted
bus.clear(); bus.limit = 50; bus.hardLimit = 100;
for (let i = 0; i < 130; i++) bus.emit('ship.speed', { t: i, ship: 'a', speedKn: i });
ok(bus.history.length === 100, '关键事件超过 hardLimit(100) 后历史收敛到 hardLimit（实际 ' + bus.history.length + '）');
ok(bus.droppedCritical === 30 && bus.droppedNoise === 0, '只丢最旧关键事件且显式记账（droppedCritical=' + bus.droppedCritical + '）');
ok(bus.totalEmitted() === 130 && bus.emitted['ship.speed'] === 130, '累计 emit 不受历史淘汰影响（ship.speed=130）');

// 高密度 AAR 时间线：415 条穿透 + 100 条普通命中（不同目标间隔 >5s）+ 3 条沉没
// 旧排序会把 cap=400 全给穿透，gun.hit 一条不进；分类型配额必须保证普通命中仍可见。
const fakeHistory = [];
for (let i = 0; i < 415; i++) fakeHistory.push({ type: 'gun.penetration', t: 600 + i * 2, ship: 'a', name: 'A舰', byShipName: 'B舰', caliberMM: 203, penetrationMM: 60, armorMM: 0 });
for (let i = 0; i < 100; i++) fakeHistory.push({ type: 'gun.hit', t: 100 + i * 6, ship: 'a', name: 'A舰', byShipName: 'B舰' });
for (let i = 0; i < 3; i++) fakeHistory.push({ type: 'ship.sink', t: 2300 + i, ship: 'a' + i, name: 'A' + i + '舰' });
const fakeEmitted = {};
for (const e of fakeHistory) fakeEmitted[e.type] = (fakeEmitted[e.type] || 0) + 1;
const fakeWorld = {
  events: { history: fakeHistory, emitted: fakeEmitted, retention: () => ({ firstCriticalT: 100, droppedCritical: 0, totalEmitted: fakeHistory.length, history: fakeHistory.length, droppedNoise: 0 }) },
  ships: [], commands: [], t: 2400, winner: null, resultText: '',
};
const fakeAAR = collectAAR(fakeWorld);
const fakePen = fakeAAR.timeline.filter((x) => x.type === 'gun.penetration').length;
ok(fakeAAR.timeline.some((x) => x.type === 'gun.hit'), '高密度穿甲（415 条）下 AAR 时间线仍保留 gun.hit（分类型配额，穿透不挤掉普通命中）');
ok(fakePen <= 120, '穿透条目受配额限制（' + fakePen + ' <= 120）');
ok(fakeAAR.timeline.length <= 400, 'AAR 时间线总长 <= 400（实际 ' + fakeAAR.timeline.length + '）');
ok(fakeAAR.timeline.some((x) => x.type === 'ship.sink'), 'AAR 时间线保留沉没事件');

// ---------------------------------------------------------------------------
section('B. 长局回放 / 战报 / AAR');
const SECONDS = Number(process.env.NAVAL_T11_SECONDS || 2400);
const scen = scenarios.find((s) => s.id === 'first_guadalcanal_1942') || scenarios[0];
const seed = scen.seed || 20261017;
console.log('  剧本：' + scen.id + ' / ' + scen.nameZh + ' · ' + scen.ships.length + ' 舰 · 仿真 ' + SECONDS + 's · seed=' + seed);
const t0 = Date.now();
const world = new World({ scenario: scen, database: db, seed, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
const dt = 0.1;
let marks = 0;
while (!world.over && world.t < SECONDS) {
  world.step(dt);
  if (world.t - marks >= 600) { marks = world.t; console.log('  … T+' + Math.round(world.t) + 's 事件 ' + world.events.history.length + ' 累计 ' + world.events.totalEmitted() + ' 在役 ' + world.afloatOf('ALLIED').length + ' vs ' + world.afloatOf('AXIS').length); }
}
const wallMs = Date.now() - t0;
const replay = world.exportReplay();
const bus2 = world.events;
const emitted = bus2.emitted;
const keptFromReplay = {};
for (const e of replay.events) keptFromReplay[e.type] = (keptFromReplay[e.type] || 0) + 1;
const totalEmitted = bus2.totalEmitted();
console.log('  仿真 ' + world.t.toFixed(0) + 's / 墙钟 ' + (wallMs / 1000).toFixed(1) + 's · 事件累计 emit ' + totalEmitted + ' / 历史 ' + bus2.history.length + ' / 回放 ' + replay.events.length);
console.log('  事件账本：' + JSON.stringify({ droppedNoise: replay.retention.droppedNoise, droppedCritical: replay.retention.droppedCritical, firstCriticalT: replay.retention.firstCriticalT }));
console.log('  高危事件：ship.sink=' + (emitted['ship.sink'] || 0) + ' dam.magazine=' + (emitted['dam.magazine'] || 0) + ' torp.hit=' + (emitted['torp.hit'] || 0) + ' gun.hit=' + (emitted['gun.hit'] || 0) + ' gun.penetration=' + (emitted['gun.penetration'] || 0));

// (a) 关键事件从 t=0/t<10s 开始，回放第一帧不是半局
if (SECONDS >= 2000) {
  // 量级门槛（2 万+）：本用例要验证的是"大批量事件下的保留策略"，不是精确条数。
  // 对局走向随 AI/损伤模型变化（本轮修复后实测 2.4 万~4.2 万），取 2 万作为"足够大"的
  // 保守下界（上限 6 万的截断路径另有分支覆盖）。
  ok(totalEmitted >= 20000, '长局事件累计 emit ' + totalEmitted + ' 条（>=2 万，数万条量级足以验证保留策略）');
  if (totalEmitted > bus2.limit) {
    // 回放会**有意**剔除 tick.major（高频节拍噪声），所以回放条数 = 历史保留数 − tick.major 数。
    // 旧断言假设两者相等，只有在事件量恰好触顶、且当局产生了 tick.major 时才会暴露（本轮修复后
    // 开火量上升，事件首次越过 6 万上限触发这条路径）。
    const tickMajor = bus2.history.filter((e) => e.type === 'tick.major').length;
    const expectReplay = bus2.history.length - tickMajor;
    ok(bus2.droppedNoise > 0 && replay.events.length === expectReplay, '超过上限：噪声被淘汰 ' + bus2.droppedNoise + ' 条，历史保留 ' + bus2.history.length + ' 条（tick.major ' + tickMajor + ' 条不入回放）→ 回放 ' + replay.events.length + ' 条，关键事件不受影响');
  } else {
    ok(bus2.history.length === totalEmitted && bus2.droppedNoise === 0, '本局累计 ' + totalEmitted + ' 条尚未触 6 万上限：全部事件保留（旧版同样不截断），保留账本一致');
  }
} else {
  console.log('  · 冒烟模式（NAVAL_T11_SECONDS=' + SECONDS + '）事件量未触顶，跳过淘汰量断言');
}
ok(replay.events.length > 0 && replay.events[0].type === 'sim.start' && replay.events[0].t === 0, '回放首条事件 = sim.start@t=0（旧版 40 分钟局会把开头整段丢掉）');
ok(replay.retention.firstCriticalT <= 10, '回放首个关键事件 t=' + replay.retention.firstCriticalT + 's <= 10s');
ok(replay.events.some((e) => e.type === 'sim.start'), '回放包含 sim.start');
ok(replay.events.length >= Math.min(40000, totalEmitted * 0.7), '回放事件量未被静默掏空（' + replay.events.length + ' 条）');

// (b) 关键事件计数 == 历史可见计数
let criticalTypes = 0, criticalMismatch = [];
for (const k of Object.keys(emitted)) {
  if (!isCriticalEvent(k)) continue;
  criticalTypes++;
  const vis = keptFromReplay[k] || 0;
  if (vis !== emitted[k]) criticalMismatch.push(k + ' emit=' + emitted[k] + ' 回放=' + vis);
  if (k === 'tick.major') continue;
}
ok(criticalTypes > 8, '本局出现的关键事件类型 ' + criticalTypes + ' 类');
ok(criticalMismatch.length === 0, '全部关键事件 累计 emit == 回放可见（无静默截断）' + (criticalMismatch.length ? '：' + criticalMismatch.join('; ') : ''));
ok(replay.retention.droppedCritical === 0, 'droppedCritical=0（没有任何关键事件因上限被丢）');
ok((keptFromReplay['gun.hit'] || 0) === (emitted['gun.hit'] || 0) && (keptFromReplay['ship.sink'] || 0) === (emitted['ship.sink'] || 0), 'gun.hit/ship.sink 计数逐类对齐（' + (emitted['gun.hit'] || 0) + ' / ' + (emitted['ship.sink'] || 0) + '）');

// (c) AAR 时间线包含普通炮战命中
const aar = collectAAR(world);
const gunHits = emitted['gun.hit'] || 0;
ok(gunHits > 0, '本局有炮术命中（gun.hit=' + gunHits + '）');
ok(aar.timeline.some((e) => e.type === 'gun.hit'), 'AAR 时间线含 gun.hit（旧版过滤只剩夹叉）');
ok(aar.timeline.some((e) => e.type === 'gun.penetration') || (emitted['gun.penetration'] || 0) === 0, 'AAR 时间线含穿甲事件（若有击穿）');
ok(aar.timeline.length > 0 && aar.timeline.length <= 400, 'AAR 时间线非空且不超过 400 条（实际 ' + aar.timeline.length + '）');
ok(aar.counts['gun.hit'] === gunHits, 'AAR 事件统计用累计 emit（gun.hit=' + aar.counts['gun.hit'] + '）');
ok(aar.retention && aar.retention.firstCriticalT <= 10, 'AAR 带事件保留账本，首个关键事件 t=' + (aar.retention && aar.retention.firstCriticalT) + 's');

// (d) dam.magazine 文案按 result 本地化，'hit' 不得写成殉爆
const expectMag = { detonation: '殉爆', burn: '爆燃', flooded: '注水', flash: '炮塔闪爆', hit: '被命中', fire_threat: '受威胁' };
let magTextOk = true;
for (const k of Object.keys(expectMag)) {
  const text = describeEvent({ type: 'dam.magazine', ship: 'x', name: '试验舰', result: k }, { x: { name: '试验舰' } });
  const good = text.includes(expectMag[k]) && (k === 'detonation' || !text.includes('殉爆'));
  if (!good) { magTextOk = false; console.log('    文案不符：result=' + k + ' → ' + text); }
}
ok(magTextOk, "dam.magazine 六种 result 文案正确（detonation=殉爆/burn=爆燃/flooded=注水/flash=炮塔闪爆/hit=被命中/fire_threat=受威胁）");
ok(!describeEvent({ type: 'dam.magazine', ship: 'x', name: '试验舰', result: 'hit' }, {}).includes('殉爆'), "result='hit' 的文案不含『殉爆』");
let realMagBad = 0, realMagN = 0;
for (const e of bus2.history) {
  if (e.type !== 'dam.magazine') continue;
  realMagN++;
  const text = describeEvent(e, aar.per);
  if (e.result === 'hit' && text.includes('殉爆')) realMagBad++;
  if (MAGAZINE_RESULT_ZH[e.result] && !text.includes(MAGAZINE_RESULT_ZH[e.result])) realMagBad++;
}
ok(realMagBad === 0, '本局真实 dam.magazine 事件（' + realMagN + ' 条）文案与 result 一致，无『一律殉爆』');

// (e) headless 大事记不再被 fc.solution/sensor.detect 刷屏；命中率小节自洽
const report = buildReport(world, { scenario: scen, seed, dt, seconds: SECONDS, steps: world.tickCount, wallMs, dbSource: 'data', scenarioSource: 'data', wantShips: scen.ships.length, loadedShips: world.ships.length, replay });
const badTypes = report.timeline.filter((e) => e.type === 'fc.solution' || e.type === 'fc.update' || e.type === 'sensor.detect' || e.type === 'gun.fire' || e.type === 'gun.miss');
ok(badTypes.length === 0, 'headless 大事记不含 fc.solution/fc.update/sensor.detect/gun.fire/gun.miss（实际混入 ' + badTypes.length + ' 条）');
ok(report.timeline.length > 0 && report.timeline.length <= 200, 'headless 大事记按重要度筛选且 <=200 条（实际 ' + report.timeline.length + ' 条）');
ok(report.timeline.some((e) => e.type === 'ship.sink') || (emitted['ship.sink'] || 0) === 0, 'headless 大事记含沉没事件');
ok(report.timeline.every((e) => e.text && e.text.length > 0), 'headless 大事记每条都有中文叙事文本');
const g = report.gunnery;
const shipsHits = report.ships.reduce((a, s) => a + s.hits, 0);
const shipsShots = report.ships.reduce((a, s) => a + s.shotsFired, 0);
ok(g && g.total.hits === shipsHits && g.total.shots === shipsShots, '命中率小节 total = 逐舰求和（' + g.total.hits + '/' + g.total.shots + '）');
ok(g.ALLIED.hits + g.AXIS.hits === g.total.hits, '命中率小节 双方命中之和 = 合计');
ok(report.counts.events === totalEmitted && report.counts.eventsHistory === bus2.history.length, 'headless 统计口径：累计 emit ' + report.counts.events + ' / 历史 ' + report.counts.eventsHistory);
ok(report.retention && report.retention.firstCriticalT <= 10 && report.retention.droppedCritical === 0, 'headless 报告带事件保留账本且关键事件零丢失');

// ---------------------------------------------------------------------------
section('C. checkObjectives 沙盒分支');
const sbSpec = JSON.parse(JSON.stringify(scenarios.find((s) => s.id === 'sandbox') || scen));
sbSpec.sandbox = true; sbSpec.sandboxNoVictory = true;
const wSandbox = new World({ scenario: sbSpec, database: db, seed: 7, ai: false });
for (const s of wSandbox.ships) if (s.side === 'ALLIED') s.isAfloat = false;
wSandbox.checkObjectives();
ok(!wSandbox.over, 'sandbox+sandboxNoVictory：编队全灭也不自动判负（over=' + wSandbox.over + '）');
const plainScen = JSON.parse(JSON.stringify(scenarios.find((s) => s.id === 'denmark_strait_1941') || scen));
delete plainScen.sandbox;
delete plainScen.sandboxNoVictory;
const wPlain = new World({ scenario: plainScen, database: db, seed: 7, ai: false });
for (const s of wPlain.ships) if (s.side === 'ALLIED') s.isAfloat = false;
wPlain.checkObjectives();
ok(wPlain.over && wPlain.winner === 'AXIS', '普通剧本：编队全灭仍然判负（over=' + wPlain.over + ' winner=' + wPlain.winner + '）');

// ---------------------------------------------------------------------------
section('结果');
console.log('  PASS ' + pass + ' / FAIL ' + fail + (fail === 0 ? '  \u2714 全部通过' : ''));
if (fail) { console.log('  失败项：'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 ? 0 : 1);
