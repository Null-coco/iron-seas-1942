import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { applyHit } from '../src/sim/damage.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const land = j('data/land.json'), dep = j('data/depth.json');
// 受控：反复对弹药库施加穿透命中，直到殉爆；统计当量、半径、阵亡、邻近舰冲击
const results = [];
for (let trial = 0; trial < 40; trial++) {
  const w = new World({ scenario: sc, database: db, seed: 9000 + trial, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  const bis = w.ships.find((s) => (s.id || '').indexOf('bismarck') >= 0);
  const mag = bis.compartments.find((c) => c.isMagazine);
  if (!mag) continue;
  let done = false;
  for (let i = 0; i < 30 && !done; i++) {
    applyHit(w, { t: w.t, targetShip: bis, x_frac: mag.x_frac, sideBias: 1, penetrates: true, penetrated: true,
      armorMM: 100, obliquityDeg: 10, ammoKind: 'AP', caliberMM: 356, shellMassKg: 721, warheadKg: 22, energyMJ: 120,
      killerShipId: 'k', killerSide: 'ALLIED', killerName: 'test' });
    w.advance(0.2);
    for (const e of w.events.history) {
      if (e.type === 'dam.magazine' && (e.result === 'detonation' || e.result === 'burn') && !done) {
        done = true;
        const blasts = w.events.history.filter((x) => x.type === 'dam.blast');
        results.push({ trial, result: e.result, energyKg: e.energyKg, radiusM: e.radiusM, killed: e.killed, crewPct: Math.round(100 * bis.crew / bis.crew0), afloat: bis.isAfloat, blasts: blasts.length, blastMax: blasts.length ? Math.max(...blasts.map((b) => b.energyKg || 0)) : 0 });
      }
    }
  }
}
console.log('受控弹药库命中试验：命中即爆 ' + results.filter((r) => r.result === 'detonation').length + '/' + results.length + ' 次');
for (const r of results.slice(0, 6)) console.log('  ' + r.result + ' 当量 ' + r.energyKg + 'kg 半径 ' + r.radiusM + 'm 阵亡 ' + r.killed + ' 存活船员 ' + r.crewPct + '% 在航 ' + r.afloat + ' 邻近舰冲击 ' + r.blasts + ' 次');
