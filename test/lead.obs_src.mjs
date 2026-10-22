import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
const w = new World({ scenario: sc, database: db, seed: 2000, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const srcCount = { AXIS: {}, ALLIED: {} };
const sig = { AXIS: [], ALLIED: [] };
// 直接插桩 takeObservation 的产物：读每个指挥仪的 st.obs
let n = 0;
const origStep = w.step.bind(w);
w.step = (dt) => {
  origStep(dt);
  if (++n % 50) return;
  for (const s of w.afloatOf('AXIS')) for (const d of (s.directors || [])) { const st = d._fc; if (st && st.obs && st.obs.length) { const o = st.obs[st.obs.length - 1]; srcCount.AXIS[o.src] = (srcCount.AXIS[o.src] || 0) + 1; sig.AXIS.push(o.sigmaPos); } }
  for (const s of w.afloatOf('ALLIED')) for (const d of (s.directors || [])) { const st = d._fc; if (st && st.obs && st.obs.length) { const o = st.obs[st.obs.length - 1]; srcCount.ALLIED[o.src] = (srcCount.ALLIED[o.src] || 0) + 1; sig.ALLIED.push(o.sigmaPos); } }
};
w.advance(900);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log('轴心观测来源: ' + JSON.stringify(srcCount.AXIS) + ' 平均σ ' + mean(sig.AXIS).toFixed(0) + 'm');
console.log('英军观测来源: ' + JSON.stringify(srcCount.ALLIED) + ' 平均σ ' + mean(sig.ALLIED).toFixed(0) + 'm');
const bis = w.ships.find((s) => (s.id || '').indexOf('bismarck') >= 0);
console.log('俾斯麦测距仪: ' + JSON.stringify((bis.rangefinders || []).map((r) => ({ base: r.base_m, type: r.type, destroyed: r.destroyed, health: r.health }))));
const hood = w.ships.find((s) => (s.id || '').indexOf('hood') >= 0);
console.log('胡德测距仪: ' + JSON.stringify((hood.rangefinders || []).map((r) => ({ base: r.base_m, type: r.type, destroyed: r.destroyed }))));
