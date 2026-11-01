// 火控探针：受控条件下测落点分布，判断命中率低的根因（系统偏差 vs 散布 vs 解算错误）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);

const RANGE = +(process.argv[2] || 8000);
const MOVING = process.argv[3] === 'move';
const scenario = {
  id: 'probe', nameZh: '火控探针',
  start: { lat: 0, lon: 0, date: '1942-06-01T12:00:00Z', env: { windKn: 8, windDirDeg: 270, visibilityNm: 20 } },
  sides: { ALLIED: { nameZh: 'A' }, AXIS: { nameZh: 'B' } },
  ships: [
    { id: 'S1', name: '胡德', class: 'Hood', side: 'ALLIED', x: 0, y: 0, heading: 0, speed: MOVING ? 20 : 0, role: 'flagship', crewQuality: 1.0 },
    { id: 'T1', name: '俾斯麦', class: 'Bismarck', side: 'AXIS', x: RANGE, y: 0, heading: 0, speed: MOVING ? 24 : 0, role: 'flagship', crewQuality: 1.0 },
  ],
  objectives: [],
};
const world = new World({ scenario, database: db, seed: 7, playerSide: 'ALLIED', ai: false });
const shooter = world.ship('S1'), target = world.ship('T1');
// 手动给指挥仪一条完美航迹，排除传感器因素
const perfectTrack = world.tracks.observe({ side: 'ALLIED', srcKind: 'SCRIPT', pos: { x: target.pos.x, y: target.pos.y }, courseDeg: target.heading, speedKn: target.speed, accuracyM: 5, accuracyDeg: 0.02, classifiedAs: 'BB', confidence: 1, t: 0 });
world.issueCommand({ shipId: 'S1', kind: 'FIRE', params: { trackId: perfectTrack.id, ammo: 'AP', salvoes: 9999 }, side: 'ALLIED', scope: 'SHIP' });
world.advance(20);
for (let k = 0; k < 60; k++) { perfectTrack.pos.x = target.pos.x; perfectTrack.pos.y = target.pos.y; perfectTrack.tLast = world.t; world.advance(10); }

const splashes = (world.splashes || []).filter((s) => s.targetShipId === 'T1' && s.shipId === 'S1');
const evHits = world.events.history.filter((e) => e.type === 'gun.hit' && e.ship === 'T1');
const shooterShots = shooter.stats.shotsFired, shooterHits = shooter.stats.hits;
// 落点相对目标中心的距离
const dists = splashes.map((s) => Math.hypot(s.x - target.pos.x, s.y - target.pos.y));
dists.sort((a, b) => a - b);
const mean = dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
const med = dists[Math.floor(dists.length / 2)] || 0;
const fc = shooter.directors[0] ? shooter.directors[0].solution : null;
console.log(JSON.stringify({
  rangeM: RANGE, moving: MOVING,
  shotsRecorded: shooterShots, hitsRecorded: shooterHits, hitEvents: evHits.length,
  splashes: splashes.length,
  missDistM: { mean: +mean.toFixed(1), median: +med.toFixed(1), p10: +(dists[Math.floor(dists.length * 0.1)] || 0).toFixed(1), p90: +(dists[Math.floor(dists.length * 0.9)] || 0).toFixed(1), max: +(dists[dists.length - 1] || 0).toFixed(1) },
  targetLen: target.data.loa_m, targetBeam: target.data.beam_m,
  solution: fc ? { rangeM: Math.round(fc.rangeM || 0), bearingDeg: +(fc.bearingDeg || 0).toFixed(2), tof: +(fc.timeOfFlightS || 0).toFixed(1), deflectionMil: fc.deflectionMil } : null,
  actualLOS: { range: Math.round(Math.hypot(target.pos.x - shooter.pos.x, target.pos.y - shooter.pos.y)), bearing: +(Math.atan2(target.pos.x - shooter.pos.x, target.pos.y - shooter.pos.y) * 57.2958).toFixed(2) },
  splashSample: splashes.slice(0, 3).map((s) => ({ dx: Math.round(s.x - target.pos.x), dy: Math.round(s.y - target.pos.y), tof: s.timeOfFlightS })),
}, null, 1));
