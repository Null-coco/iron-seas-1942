import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { visualDetection } from '../src/sim/vision.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 11, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
w.advance(120);
const hood = w.ship('hood') || w.shipsOf('ALLIED')[0];
const bismarck = w.shipsOf('AXIS')[0];
for (const km of [6, 8]) {
  const ang = 0.7, old = { x: bismarck.pos.x, y: bismarck.pos.y };
  bismarck.pos = { x: hood.pos.x + Math.sin(ang) * km * 1000, y: hood.pos.y + Math.cos(ang) * km * 1000 };
  const d = visualDetection(hood, bismarck, w.env);
  bismarck.pos = old;
  console.log(km + 'km: detected=' + d.detected + ' C0=' + (d.contrast0 || 0).toFixed(3) + ' cth=' + (d.contrastThreshold || 0).toFixed(4) + ' C@tgt=' + (d.contrastAtTarget || 0).toFixed(4) + ' detRange=' + Math.round(d.detectionRangeM) + 'm horizon=' + Math.round(d.horizonM) + 'm vis=' + (d.visibilityNm || 0).toFixed(1) + 'nm smoke=' + (d.smokeDensity || 0));
}
