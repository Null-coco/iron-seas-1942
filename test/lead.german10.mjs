import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
// 初始态势
{
  const w = new World({ scenario: sc, database: db, seed: 1, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  console.log('== 初始态势（t=0）==');
  const ax = w.shipsOf('AXIS'), al = w.shipsOf('ALLIED');
  for (const s of ax) console.log('  轴 ' + s.name.padEnd(8) + ' 航向 ' + Math.round(s.heading) + '° 航速 ' + s.speed + 'kn');
  for (const s of al) {
    // 相对俾斯麦
    const bis = ax[0];
    const d = Math.hypot(s.pos.x - bis.pos.x, s.pos.y - bis.pos.y);
    const brg = (Math.atan2(s.pos.x - bis.pos.x, s.pos.y - bis.pos.y) * 57.2958 + 360) % 360;
    console.log('  盟 ' + s.name.padEnd(12) + ' 航向 ' + Math.round(s.heading) + '° 航速 ' + s.speed + 'kn  距俾斯麦 ' + (d / 1000).toFixed(1) + 'km 方位 ' + Math.round(brg) + '°');
  }
  const hood = al.find((s) => (s.id || '').indexOf('hood') >= 0);
  const bismarck = ax.find((s) => (s.id || '').indexOf('bismarck') >= 0);
  console.log('  胡德↔俾斯麦 初始距离 ' + (Math.hypot(hood.pos.x - bismarck.pos.x, hood.pos.y - bismarck.pos.y) / 1000).toFixed(1) + 'km');
  console.log('  双方接近速度约 ' + (hood.speed * 0.514 + bismarck.speed * 0.514).toFixed(0) + ' m/s（对头）');
}
// 10 局
let winAxis = 0, winAllied = 0, none = 0;
const rows = [];
const NG = +(process.argv[2] || 10);
for (let k = 0; k < NG; k++) {
  const w = new World({ scenario: sc, database: db, seed: 2000 + k, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1800);
  const hood = w.ships.find((s) => (s.id || '').indexOf('hood') >= 0);
  const pow = w.ships.find((s) => (s.id || '').indexOf('prince_of_wales') >= 0);
  const bis = w.ships.find((s) => (s.id || '').indexOf('bismarck') >= 0);
  const res = w.winner || '未决';
  if (res === 'AXIS') winAxis++; else if (res === 'ALLIED') winAllied++; else none++;
  const fires = w.events.history.filter((e) => e.type === 'gun.fire' && e.rangeM);
  const mean = fires.length ? fires.reduce((a, f) => a + f.rangeM, 0) / fires.length / 1000 : 0;
  rows.push({ k, res, text: (w.resultText || '').slice(0, 22), hood: hood.isAfloat ? '在航' : '沉没', hoodFlood: Math.round(hood.floodedM3), pow: pow.isAfloat ? '在航' : '沉没', bis: bis.isAfloat ? '在航' : '沉没', bisSpeed: bis.speedCapKn.toFixed(1), bisFlood: Math.round(bis.floodedM3), mean: mean.toFixed(1) });
}
console.log('\n== 10 局（轴心胜率基线）==');
for (const r of rows) console.log('  #' + r.k + ' ' + r.res.padEnd(8) + ' ' + r.text.padEnd(24) + ' | 胡德 ' + r.hood + '(' + r.hoodFlood + 'm³) PoW ' + r.pow + ' | 俾斯麦 ' + r.bis + ' 速上限 ' + r.bisSpeed + ' 进水 ' + r.bisFlood + ' | 均开火距 ' + r.mean + 'km');
console.log('轴心胜 ' + winAxis + ' / 盟军胜 ' + winAllied + ' / 未决 ' + none + '  → 胜率 ' + (100 * winAxis / NG) + '%');
