import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'savo_island_1942');
const w = new World({ scenario: sc, database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const samples = [];
w.events.on('gun.miss', (e) => {
  if (!e.targetShipId || e.x === undefined) return;
  const t = w.ship(e.targetShipId);
  if (!t || !t.isAfloat) return;
  const sh = w.ship(e.byShip);
  if (!sh) return;
  // 沿射向分解：+ 表示越过目标（远弹），- 表示不足（近弹）
  const brg = Math.atan2(t.pos.x - sh.pos.x, t.pos.y - sh.pos.y);
  const dx = e.x - t.pos.x, dy = e.y - t.pos.y;
  const along = dx * Math.sin(brg) + dy * Math.cos(brg);     // 沿射向（+ = 远）
  const cross = dx * Math.cos(brg) - dy * Math.sin(brg);     // 垂直射向（+ = 右）
  samples.push({ along, cross, r: Math.hypot(e.x - sh.pos.x, e.y - sh.pos.y), t: w.t, tof: e.timeOfFlightS });
});
w.events.on('gun.hit', (e) => {
  const t = w.ship(e.ship); const sh = w.ship(e.byShip);
  if (!t || !sh) return;
  samples.push({ along: 0, cross: 0, r: Math.hypot(t.pos.x - sh.pos.x, t.pos.y - sh.pos.y), t: w.t, hit: true, tof: e.timeOfFlightS });
});
w.advance(1200);
const pc = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const miss = samples.filter((s) => !s.hit), hit = samples.filter((s) => s.hit);
console.log('弹着样本 ' + samples.length + '（命中 ' + hit.length + '，落水 ' + miss.length + '）');
const along = miss.map((s) => s.along), cross = miss.map((s) => s.cross);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log('沿射向误差（+远/-近）：均值 ' + mean(along).toFixed(0) + 'm  中位 ' + pc(along, 0.5).toFixed(0) + 'm  |p90| ' + pc(along.map(Math.abs), 0.9).toFixed(0) + 'm  σ ' + Math.sqrt(mean(along.map((x) => x * x)) - mean(along) ** 2).toFixed(0) + 'm');
console.log('垂直射向误差：均值 ' + mean(cross).toFixed(0) + 'm  中位 ' + pc(cross, 0.5).toFixed(0) + 'm  |p90| ' + pc(cross.map(Math.abs), 0.9).toFixed(0) + 'm  σ ' + Math.sqrt(mean(cross.map((x) => x * x)) - mean(cross) ** 2).toFixed(0) + 'm');
console.log('落点距离（相对射者）：中位 ' + pc(miss.map((s) => s.r), 0.5).toFixed(0) + 'm');
const near = miss.filter((s) => Math.abs(s.along) < 150 && Math.abs(s.cross) < 60);
console.log('若目标按 230m×30m 计，落点落在舰体投影内的比例：' + (100 * near.length / Math.max(1, miss.length)).toFixed(1) + '%（实际命中率 ' + (100 * hit.length / samples.length).toFixed(1) + '%）');
