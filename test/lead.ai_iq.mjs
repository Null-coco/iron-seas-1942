import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { makeShell } from '../src/sim/ballistics.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const land = j('data/land.json'), dep = j('data/depth.json');
const scn = (id) => j('data/scenarios.json').scenarios.find((s) => s.id === id);

// A. 引信可靠性
{
  const w = new World({ scenario: scn('denmark_strait_1941'), database: db, seed: 3, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  console.log('== 主炮 AP 哑弹率 ==');
  for (const s of w.ships) {
    const b = (s.mainBatteries || [])[0];
    if (!b) continue;
    const sh = makeShell(s, b, 'AP');
    if (sh.caliberMM >= 200) console.log('  ' + s.name.padEnd(8) + ' ' + ((s.data && s.data.nation) || s.nation || '?') + ' ' + Math.round(sh.caliberMM) + 'mm  哑弹率 ' + (100 * sh.dudChance).toFixed(1) + '%');
  }
}
// B. 夜间照明弹 + 火力分配
{
  const w = new World({ scenario: scn('savo_island_1942'), database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: land, depthData: dep });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1200);
  const fires = w.events.history.filter((e) => e.type === 'gun.fire');
  const star = fires.filter((e) => e.ammo === 'STAR' || e.ammoKind === 'STAR').length;
  const hits = w.events.history.filter((e) => e.type === 'gun.hit').length;
  console.log('\n== 萨沃岛 1200s ==');
  console.log('  发射 ' + fires.length + ' 命中 ' + hits + ' 命中率 ' + (100 * hits / Math.max(1, fires.length)).toFixed(1) + '% · 照明弹 ' + star + ' 发');
  // 集火分布
  const perTrack = {};
  for (const s of w.ships) if (s.commanded && s.commanded.firing && s.commanded.targetTrackId) perTrack[s.commanded.targetTrackId] = (perTrack[s.commanded.targetTrackId] || 0) + 1;
  console.log('  当前集火分布：' + JSON.stringify(perTrack));
  const sunk = w.ships.filter((s) => !s.isAfloat).map((s) => s.name);
  console.log('  沉没：' + (sunk.length ? sunk.join('、') : '无'));
}
