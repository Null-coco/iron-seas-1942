import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { opticalRangefind } from '../src/sim/vision.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const landData = j('data/land.json'), depthData = j('data/depth.json');
const scn = (id) => j('data/scenarios.json').scenarios.find((s) => s.id === id);

// 1) 测距仪误差随距离
{
  const w = new World({ scenario: scn('denmark_strait_1941'), database: db, seed: 11, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData, depthData });
  const shooter = w.ship('hood') || w.shipsOf('ALLIED')[0];
  const tgt = w.shipsOf('AXIS')[0];
  console.log('== 光学测距误差（' + shooter.name + ' → ' + tgt.name + '）==');
  for (const km of [6, 8, 12, 16, 20]) {
    const errs = [];
    const orig = tgt.pos;
    for (let i = 0; i < 200; i++) {
      const ang = i * 0.031;
      tgt.pos = { x: shooter.pos.x + Math.sin(ang) * km * 1000, y: shooter.pos.y + Math.cos(ang) * km * 1000 };
      const r = opticalRangefind(shooter, tgt, w.env, w.rng);
      if (r && r.rangeM) errs.push(Math.abs(r.rangeM - km * 1000));
    }
    tgt.pos = orig;
    errs.sort((a, b) => a - b);
    console.log('  ' + String(km).padStart(2) + 'km：测距误差 中位 ' + errs[100].toFixed(0) + 'm  p90 ' + errs[180].toFixed(0) + 'm');
  }
}

// 2) 剧本实际命中率
console.log('\n== 剧本命中率 ==');
for (const id of ['denmark_strait_1941', 'savo_island_1942', 'first_guadalcanal_1942', 'north_cape_1943']) {
  const w = new World({ scenario: scn(id), database: db, seed: 20261018, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData, depthData });
  for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
  w.advance(1200);
  const fires = w.events.history.filter((e) => e.type === 'gun.fire' && e.rangeM);
  const hits = w.events.history.filter((e) => e.type === 'gun.hit').length;
  const mean = fires.length ? fires.reduce((a, f) => a + f.rangeM, 0) / fires.length / 1000 : 0;
  const band = { '<5': 0, '5-8': 0, '8-12': 0, '12-16': 0, '>16': 0 };
  for (const f of fires) { const k = f.rangeM / 1000; if (k < 5) band['<5']++; else if (k < 8) band['5-8']++; else if (k < 12) band['8-12']++; else if (k < 16) band['12-16']++; else band['>16']++; }
  console.log('  ' + id.padEnd(24) + ' 命中率 ' + (fires.length ? (100 * hits / fires.length).toFixed(1) : 0) + '%  均距 ' + mean.toFixed(1) + 'km  ' + JSON.stringify(band));
}
