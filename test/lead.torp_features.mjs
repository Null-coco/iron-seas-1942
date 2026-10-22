import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 42, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
w.advance(60);
const dd = w.ships.find((s) => (s.torpedoMounts || []).length && s.type === 'DD');
console.log('== 发射管：' + dd.name + ' ==');
for (const m of dd.torpedoMounts) console.log('  ' + m.id + ' ' + m.label + ' 装填 ' + m.tubesLoaded + '/' + m.tubes + ' 舷侧偏角 ' + m.offsetDeg + '°');

// A. 按舷侧选管：目标放在右舷 vs 左舷
const tgt = w.shipsOf('AXIS')[0];
const test = (bearingDeg, label) => {
  tgt.pos = { x: dd.pos.x + Math.sin(bearingDeg * Math.PI / 180) * 6000, y: dd.pos.y + Math.cos(bearingDeg * Math.PI / 180) * 6000 };
  const before = w.torpedoes.length;
  w.issueCommand({ side: dd.side, shipId: dd.id, kind: 'LAUNCH_TORPEDO', params: { trackId: null, bearingDeg, rangeM: 6000, tubes: 2, spreadDeg: 6, depthM: 4, speedIdx: 0 } }, { source: 'PLAYER' });
  w.advance(25);   // 指挥延迟后命令才生效
  const launched = w.torpedoes.slice(before);
  const ev = w.events.history.filter((e) => e.type === 'torp.launch').slice(-1)[0];
  console.log('  ' + label + '（目标方位 ' + Math.round(bearingDeg) + '°，舰艏 ' + Math.round(dd.heading) + '°）→ 选用 ' + (ev ? ev.mountLabel : '未发射') + '，射出 ' + launched.length + ' 雷，定深 ' + (launched[0] ? launched[0].setDepthM.toFixed(1) : '-') + 'm');
};
dd.torpedoMounts.forEach((m) => { m.tubesLoaded = m.tubes; });
test((dd.heading + 90) % 360, '右舷');
dd.torpedoMounts.forEach((m) => { m.tubesLoaded = m.tubes; });
test((dd.heading - 90 + 360) % 360, '左舷');

// B. 参数是否被采纳（定深/管数/扇面/档位）
dd.torpedoMounts.forEach((m) => { m.tubesLoaded = m.tubes; });
const before = w.torpedoes.length;
w.issueCommand({ side: dd.side, shipId: dd.id, kind: 'LAUNCH_TORPEDO', params: { bearingDeg: (dd.heading + 90) % 360, rangeM: 7000, tubes: 3, spreadDeg: 10, depthM: 6, speedIdx: 1 } }, { source: 'PLAYER' });
w.advance(25);
const sal = w.torpedoes.slice(before);
console.log('\n== 参数验证 ==');
console.log('  射出 ' + sal.length + ' 雷 · 定深 ' + (sal[0] ? sal[0].setDepthM.toFixed(1) + 'm' : '-') + ' · 航速 ' + (sal[0] ? (sal[0].speedMps / 0.514444).toFixed(0) + 'kn' : '-') + ' · 航向散布 ' + sal.map((t) => Math.round(t.courseDeg)).join('/') + '（应约 ' + Math.round((dd.heading + 90) % 360) + '°±10°）');
const ev2 = w.events.history.filter((e) => e.type === 'torp.launch').slice(-1)[0];
console.log('  回执：' + JSON.stringify({ mount: ev2.mountLabel, tubes: ev2.tubes, depth: ev2.depthM, speedIdx: ev2.speedIdx, spread: ev2.spreadDeg }));

// C. AI 协同：是否错开发射
const w2 = new World({ scenario: sc, database: db, seed: 7, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
for (const s of ['ALLIED', 'AXIS']) w2.ai[s].autoCommand = true;
w2.advance(1500);
const evs = w2.events.history.filter((e) => e.type === 'torp.launch' && e.accepted);
const byTrack = {};
for (const e of evs) { const k = e.track || '?'; byTrack[k] = byTrack[k] || []; byTrack[k].push(Math.round(e.t)); }
console.log('\n== AI 雷击（萨沃岛 1500s）==');
console.log('  发射批次 ' + evs.length + ' 次 · 涉及航迹 ' + Object.keys(byTrack).length + ' 条');
let staggered = 0, sameT = 0;
for (const k of Object.keys(byTrack)) { const ts = byTrack[k].sort((a, b) => a - b); for (let i = 1; i < ts.length; i++) { if (ts[i] - ts[i - 1] >= 30) staggered++; else sameT++; } }
console.log('  同一目标相邻批次间隔 ≥30s（错开）: ' + staggered + ' 次 · <30s: ' + sameT + ' 次');
const duds = w2.events.history.filter((e) => e.type === 'torp.dud').length;
const hits = w2.events.history.filter((e) => e.type === 'torp.hit' || e.type === 'torpedo.hit').length;
const bottom = w2.events.history.filter((e) => e.type === 'torp.bottom').length;
console.log('  命中 ' + hits + ' · 哑弹 ' + duds + ' · 触底 ' + bottom);
