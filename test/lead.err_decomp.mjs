// 分解位置误差：距离误差 / 方位误差 / 是否是"幽灵接触"（附近根本没有敌舰）
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 19420604, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
// 每条探测：记录报告位置时的真实态势，便于逐项分解
const recs = [];
const origObserve = w.tracks.observe.bind(w.tracks);
w.tracks.observe = (obs) => {
  const r = origObserve(obs);
  if (r && obs.pos) {
    const obs2 = w.ship(obs.shipId);
    if (obs2) {
      let best = null, bd = 1e18;
      for (const f of w.ships) { if (!f.isAfloat || f.side === obs.side) continue; const d = Math.hypot(f.pos.x - obs2.pos.x, f.pos.y - obs2.pos.y); if (d < bd) { bd = d; best = f; } }
      if (best) {
        const repR = Math.hypot(obs.pos.x - obs2.pos.x, obs.pos.y - obs2.pos.y);
        const repB = (Math.atan2(obs.pos.x - obs2.pos.x, obs.pos.y - obs2.pos.y) * 57.2957795 + 360) % 360;
        const truB = (Math.atan2(best.pos.x - obs2.pos.x, best.pos.y - obs2.pos.y) * 57.2957795 + 360) % 360;
        const db2 = Math.abs(((repB - truB + 540) % 360) - 180);
        recs.push({ src: obs.srcKind, repR, trueR: bd, rangeErr: repR - bd, bearErr: db2, posErr: Math.hypot(obs.pos.x - best.pos.x, obs.pos.y - best.pos.y), t: w.t });
      }
    }
  }
  return r;
};
w.advance(4700);
const radar = recs.filter((r) => r.src === 'RADAR');
const pc = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const rangeErrs = radar.map((r) => Math.abs(r.rangeErr)), bearErrs = radar.map((r) => r.bearErr), posErrs = radar.map((r) => r.posErr);
console.log('RADAR 观测 ' + radar.length + ' 条');
console.log('  距离误差 |ΔR|：中位 ' + pc(rangeErrs, 0.5).toFixed(0) + 'm  p90 ' + pc(rangeErrs, 0.9).toFixed(0) + 'm');
console.log('  方位误差 |ΔB|：中位 ' + pc(bearErrs, 0.5).toFixed(2) + '°  p90 ' + pc(bearErrs, 0.9).toFixed(2) + '°  最大 ' + pc(bearErrs, 1).toFixed(2) + '°');
console.log('  位置误差：中位 ' + pc(posErrs, 0.5).toFixed(0) + 'm  p90 ' + pc(posErrs, 0.9).toFixed(0) + 'm');
console.log('  误差分解：距离项贡献(中位) ' + pc(rangeErrs, 0.5).toFixed(0) + 'm vs 方位项贡献(中位) ' + (pc(radar.map((r) => r.trueR), 0.5) * Math.tan(pc(bearErrs, 0.5) * Math.PI / 180)).toFixed(0) + 'm');
const big = radar.filter((r) => r.posErr > 8000);
console.log('  位置误差>8km 的观测：' + big.length + ' 条（占 ' + (100 * big.length / Math.max(1, radar.length)).toFixed(1) + '%）');
for (const b of big.slice(0, 5)) console.log('    报告距离 ' + (b.repR / 1000).toFixed(1) + 'km 真实距离 ' + (b.trueR / 1000).toFixed(1) + 'km 距离误差 ' + (b.rangeErr / 1000).toFixed(1) + 'km 方位误差 ' + b.bearErr.toFixed(1) + '° 位置误差 ' + (b.posErr / 1000).toFixed(1) + 'km');
const near = radar.filter((r) => r.repR < 20000);
console.log('  仅 20km 以内：位置误差中位 ' + pc(near.map((r) => r.posErr), 0.5).toFixed(0) + 'm，方位误差中位 ' + pc(near.map((r) => r.bearErr), 0.5).toFixed(2) + '°');
