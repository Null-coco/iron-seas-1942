// 浸泡测试：多剧本跑满，检查 NaN / 不变量 / 异常
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const scenarios = j('data/scenarios.json').scenarios;
const ids = process.argv.slice(2);
const bad = [];
let totalEvents = 0, totalShips = 0;
for (const id of ids) {
  const sc = scenarios.find((s) => s.id === id);
  if (!sc) continue;
  let w = null, err = null;
  try {
    w = new World({ scenario: sc, database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
    for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
    const DUR = +(process.env.DUR || 900);
    for (let k = 0; k < DUR / 50; k++) {
      w.advance(50);
      // 每 50 秒检查一次不变量
      for (const s of w.ships) {
        const nums = { x: s.pos.x, y: s.pos.y, hd: s.heading, sp: s.speed, list: s.list, trim: s.trim, draft: s.draftM, crew: s.crew, flood: s.floodedM3 };
        for (const key of Object.keys(nums)) if (!Number.isFinite(nums[key])) bad.push(id + ' t=' + Math.round(w.t) + ' ' + s.name + '.' + key + '=NaN');
        if (s.heading < -0.001 || s.heading > 360.001) bad.push(id + ' ' + s.name + ' 航向越界 ' + s.heading);
        if (s.speed < -0.001 || s.speed > 60) bad.push(id + ' ' + s.name + ' 航速越界 ' + s.speed);
        if (Math.abs(s.list) > 90.1) bad.push(id + ' ' + s.name + ' 横倾越界 ' + s.list);
        if (s.crew < -0.001) bad.push(id + ' ' + s.name + ' 舰员为负 ' + s.crew);
        if (s.floodedM3 < -0.001) bad.push(id + ' ' + s.name + ' 进水为负 ' + s.floodedM3);
      }
      for (const p of w.projectiles) if (!Number.isFinite(p.pos ? p.pos.x : p.x)) bad.push(id + ' 弹丸坐标为 NaN');
      for (const t of w.torpedoes) if (!Number.isFinite(t.pos.x)) bad.push(id + ' 鱼雷坐标为 NaN');
      for (const tr of w.tracks.tracks) if (!Number.isFinite(tr.pos.x)) bad.push(id + ' 航迹坐标为 NaN');
    }
    totalEvents += w.events.history.length; totalShips += w.ships.length;
    const sunk = w.ships.filter((s) => !s.isAfloat).length;
    const shots = w.ships.reduce((a, s) => a + s.stats.shotsFired, 0), hits = w.ships.reduce((a, s) => a + s.stats.hits, 0);
    console.log('  ' + id.padEnd(26) + ' t=' + Math.round(w.t) + 's 事件=' + w.events.history.length + ' 沉没=' + sunk + '/' + w.ships.length + ' 命中率=' + (shots ? (100 * hits / shots).toFixed(1) : 0) + '% 航迹=' + w.tracks.tracks.length);
  } catch (e) { err = e; console.log('  ' + id.padEnd(26) + ' 抛异常：' + e.message + ' @ ' + String(e.stack).split('\n')[1]); bad.push(id + ' 异常 ' + e.message); }
}
console.log('\n浸泡完成：' + ids.length + ' 剧本 / ' + totalShips + ' 舰 / ' + totalEvents + ' 事件');
console.log(bad.length ? ('❌ 发现 ' + bad.length + ' 个不变量问题：\n  ' + bad.slice(0, 12).join('\n  ')) : '✅ 无不变量问题（无 NaN / 无越界 / 无异常）');
