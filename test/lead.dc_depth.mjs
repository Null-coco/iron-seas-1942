import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { applyHit, updateDamage, floodingReport } from '../src/sim/damage.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const landData = j('data/land.json'), depthData = j('data/depth.json');

// ── A. 损管对照：同一发鱼雷命中，损管队正常 vs 归零 ──
console.log('== A. 损管效果对照（重巡洋舰，1 枚 203mm 命中舯部机舱：中等破口）==');
for (const label of ['损管正常', '损管归零']) {
  const w = new World({ scenario: j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox'), database: db, seed: 7, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData, depthData });
  const s = w.shipsOf('ALLIED').find((x) => x.type === 'CA') || w.ships[0];
  const dc = s.subsystems.find((x) => x.kind === 'DC');
  if (label === '损管归零') { if (dc) { dc.parties = 0; dc.health = 0.001; } s.crewQuality = 0.35; }
  applyHit(w, { t: 0, targetShip: s, x_frac: 0.5, sideBias: 1, penetrates: true, armorMM: 20, obliquityDeg: 10, ammoKind: 'AP', caliberMM: 203, shellMassKg: 152, warheadKg: 6, energyMJ: 60, killerShipId: 'x', killerSide: 'ALLIED', killerName: 'test' });
  let peak = 0; const marks = [];
  for (let i = 0; i < 9000; i++) { w.t += 0.1; updateDamage(s, w, 0.1); peak = Math.max(peak, s.floodedM3); if (i === 1200 || i === 3000 || i === 6000) marks.push(Math.round(s.floodedM3)); }
  const rep = floodingReport(s);
  console.log('  ' + label + '：120s=' + marks[0] + ' / 300s=' + marks[1] + ' / 600s=' + marks[2] + ' / 900s=' + Math.round(rep.floodedM3) + 'm³（峰值 ' + Math.round(peak) + '）横倾 ' + s.list.toFixed(1) + '° 在航 ' + (s.isAfloat ? '是' : '否') + ' · 堵漏/反注水事件 ' + w.events.history.filter((e) => e.type === 'dam.breach.patched' || e.type === 'dam.counterflood').length + ' 条');
}

// ── B. 水深：浅滩搁浅与鱼雷触底 ──
console.log('\n== B. 水深 ==');
for (const id of ['surigao_strait_1944', 'savo_island_1942']) {
  const sc = j('data/scenarios.json').scenarios.find((s) => s.id === id);
  const w = new World({ scenario: sc, database: db, seed: 7, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData, depthData });
  const bb = w.ships.find((s) => s.type === 'BB') || w.ships[0];
  const dd = w.ships.find((s) => s.type === 'DD') || w.ships[1];
  console.log('  ' + id + '：水深场 ' + (w.depth.empty ? '空' : '有') + ' | BB ' + bb.name + ' 吃水 ' + bb.draftM.toFixed(1) + 'm 处水深 ' + w.depth.depthAt(bb.pos.x, bb.pos.y).toFixed(0) + 'm（龙骨下富余 ' + (w.depth.depthAt(bb.pos.x, bb.pos.y) - bb.draftM).toFixed(1) + 'm）| DD ' + dd.name + ' 吃水 ' + dd.draftM.toFixed(1) + 'm');
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(900);
  const shoal = w.events.history.filter((e) => e.type === 'ship.shoal').length;
  const ground = w.events.history.filter((e) => e.type === 'ship.grounding').length;
  const bottom = w.events.history.filter((e) => e.type === 'torp.bottom').length;
  const torp = w.events.history.filter((e) => e.type === 'torp.launch' || e.type === 'torpedo.launch' || e.type === 'torp.fire').length;
  const minDepth = Math.min(...w.ships.filter((s) => s.isAfloat).map((s) => w.depth.depthAt(s.pos.x, s.pos.y)));
  console.log('     900s：触底(浅滩) ' + shoal + ' 次 · 搁浅 ' + ground + ' 次 · 鱼雷触底 ' + bottom + ' 条 · 全场最小水深 ' + minDepth.toFixed(1) + 'm');
}
