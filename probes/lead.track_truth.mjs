import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 19420604, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const recs = [];
const orig = w.tracks.observe.bind(w.tracks);
w.tracks.observe = (obs) => {
  const tr = orig(obs);
  if (tr && tr.pos && tr.side) {
    let best = 1e18, bn = null;
    for (const f of w.ships) { if (!f.isAfloat || f.side === tr.side) continue; const d = Math.hypot(tr.pos.x - f.pos.x, tr.pos.y - f.pos.y); if (d < best) { best = d; bn = f; } }
    if (bn) recs.push({ bo: !!tr.bearingOnly, errM: tr.errM, errDeg: tr.errDeg, conf: tr.confidence, pos: best, r: w.t });
  }
  return tr;
};
w.advance(4700);
const pc = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const bo = recs.filter((r) => r.bo), pt = recs.filter((r) => !r.bo);
console.log('航迹更新 ' + recs.length + ' 次：bearing-only ' + bo.length + '（' + (100 * bo.length / recs.length).toFixed(0) + '%）· 有定位 ' + pt.length);
console.log('有定位航迹的位置误差：中位 ' + pc(pt.map((r) => r.pos), 0.5).toFixed(0) + 'm  p90 ' + pc(pt.map((r) => r.pos), 0.9).toFixed(0) + 'm');
console.log('bearing-only 航迹位置误差：中位 ' + pc(bo.map((r) => r.pos), 0.5).toFixed(0) + 'm  p90 ' + pc(bo.map((r) => r.pos), 0.9).toFixed(0) + 'm  ← 这些位置是"假定 12km"捏出来的');
console.log('bearing-only 的 errM 中位 ' + pc(bo.map((r) => r.errM), 0.5).toFixed(0) + 'm（若远小于真实误差，说明不确定性在撒谎）');
console.log('所有航迹不同 ID 数：' + new Set(w.events.history.filter((e) => e.type === 'sensor.detect').map((e) => e.target)).size);
