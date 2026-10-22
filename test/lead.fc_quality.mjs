import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
// 统计：开火时目标航迹的航向/航速是否可用
const stat = {};
const onFire = (e) => {
  const tr = e.trackId ? w.tracks.byId(e.trackId) : null;
  const key = !tr ? 'no-track' : (tr.courseValid ? 'courseValid' : (tr.speedKn > 0.5 ? 'speedOnly' : 'no-course'));
  stat[key] = stat[key] || { n: 0, r: 0 };
  stat[key].n++;
  if (e.rangeM) stat[key].r += e.rangeM;
};
w.events.on('gun.fire', onFire);
w.advance(1200);
const hits = w.events.history.filter((e) => e.type === 'gun.hit').length;
const fires = w.events.history.filter((e) => e.type === 'gun.fire').length;
console.log('开火 ' + fires + ' 命中 ' + hits + ' → ' + (100 * hits / fires).toFixed(1) + '%');
console.log('开火时目标航迹状态分布：');
for (const k of Object.keys(stat)) console.log('  ' + k.padEnd(12) + ' n=' + String(stat[k].n).padStart(5) + '  平均距离 ' + (stat[k].r / stat[k].n / 1000).toFixed(1) + 'km');
// 齐射 vs 单发
const salv = w.events.history.filter((e) => e.type === 'gun.salvo.away');
console.log('齐射事件 ' + salv.length + '，其中单发(salvoes=1) ' + salv.filter((e) => e.shells === 1 || e.guns === 1).length);
const fc = w.events.history.filter((e) => e.type === 'fc.solution');
const withLead = fc.filter((e) => e.deflectionMil !== undefined && Math.abs(e.deflectionMil) > 0.5).length;
console.log('火控解算 ' + fc.length + ' 次，带明显提前量的 ' + withLead + '（' + (100 * withLead / Math.max(1, fc.length)).toFixed(0) + '%）');
const sample = fc.slice(-3).map((e) => ({ range: Math.round(e.rangeM || 0), defl: e.deflectionMil, tof: e.timeOfFlightS }));
console.log('最近解算样例：' + JSON.stringify(sample));
const validTracks = w.tracks.tracks.filter((t) => t.courseValid).length;
console.log('当前航迹 ' + w.tracks.tracks.length + ' 条，其中航向航速可用 ' + validTracks + ' 条');
