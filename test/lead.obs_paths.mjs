import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 19420604, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
const stat = {};
const orig = w.tracks.observe.bind(w.tracks);
w.tracks.observe = (obs) => {
  const o = w.ship(obs.shipId);
  const key = [obs.srcKind || obs.sensorKind || '?', obs.rangeOnly ? 'rangeOnly' : (obs.bearingOnly ? 'bearingOnly' : 'point')].join('/');
  stat[key] = stat[key] || { n: 0, zero: 0, nullR: 0, rSum: 0, hasPos: 0 };
  const s = stat[key]; s.n++;
  if (obs.rangeM === null || obs.rangeM === undefined) s.nullR++;
  else s.rSum += obs.rangeM;
  if (obs.pos) { s.hasPos++; if (o && Math.hypot(obs.pos.x - o.pos.x, obs.pos.y - o.pos.y) < 5) s.zero++; }
  return orig(obs);
};
w.advance(4700);
console.log('观测路径统计（n / pos 与观察者同点 / rangeM 为空 / 平均报告距离）:');
for (const k of Object.keys(stat).sort((a, b) => stat[b].n - stat[a].n)) {
  const s = stat[k];
  console.log('  ' + k.padEnd(22) + ' n=' + String(s.n).padStart(6) + '  同点=' + String(s.zero).padStart(6) + '  无距离=' + String(s.nullR).padStart(5) + '  平均距离=' + (s.rSum / Math.max(1, s.n - s.nullR) / 1000).toFixed(1) + 'km');
}
