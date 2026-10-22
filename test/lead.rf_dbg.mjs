import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { opticalRangefind } from '../src/sim/vision.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 11, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData: j('data/land.json'), depthData: j('data/depth.json') });
w.advance(120);
const hood = w.ship('hood') || w.shipsOf('ALLIED')[0];
const bismarck = w.shipsOf('AXIS')[0];
console.log('观测者 ' + hood.name + ' 测距仪: ' + JSON.stringify((hood.rangefinders || []).map((r) => ({ base: r.base_m, type: r.type, destroyed: r.destroyed }))));
for (const km of [6, 8, 13]) {
  // 把目标放到指定距离
  const ang = 0.7;
  const old = { x: bismarck.pos.x, y: bismarck.pos.y };
  bismarck.pos = { x: hood.pos.x + Math.sin(ang) * km * 1000, y: hood.pos.y + Math.cos(ang) * km * 1000 };
  const r = opticalRangefind(hood, bismarck, w.env, w.rng);
  bismarck.pos = old;
  console.log(km + 'km: ' + JSON.stringify({ valid: r.valid, errM: Math.round(r.errM), errDeg: +(r.errDeg || 0).toFixed(2), detected: r.detected, type: r.type, base: r.baseM, theta: r.thetaArcsec }));
}
console.log('env: 光照 ' + w.env.lightLevel + ' 能见度 ' + w.env.visibilityNm + 'nm 海况 ' + w.env.seaState + ' 太阳高度 ' + w.env.sunAltDeg);
