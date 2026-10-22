// 插桩：统计航迹关联为何失败（d vs gate）
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
import { TrackManager } from '../src/sim/tracks.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const stats = { calls: 0, hit: 0, noTrack: 0, ageFail: 0, gateFail: 0, ratios: [], created: 0, removed: 0, ageLimits: [] };
const origAssoc = TrackManager.prototype._associate;
TrackManager.prototype._associate = function (obs, pos, bearingOnly, t, observerPos) {
  stats.calls++;
  let best = null, bestScore = Infinity, reason = 'noTrack', bestRatio = 0, minD = Infinity, gateAtMin = 0;
  for (const tr of this.tracks) {
    if (tr.dead || tr.side !== obs.side) continue;
    const age = t - tr.tLast;
    if (age > 30) { stats.ageLimits.push(age); continue; }
    if (bearingOnly) {
      if (!observerPos) continue;
      const predB = Math.atan2(tr.pos.x - observerPos.x, tr.pos.y - observerPos.y) * 180 / Math.PI;
      const gate = Math.max(6.0, 3.5 * (obs.accuracyDeg || 3));
      const dB = Math.abs(((predB - (obs.bearingDeg || 0) + 540) % 360) - 180);
      const predR = Math.hypot(tr.pos.x - observerPos.x, tr.pos.y - observerPos.y);
      if (predR > 45000) continue;
      if (dB > gate) { if (dB / gate > bestRatio) { bestRatio = dB / gate; reason = 'gateFail'; } continue; }
      const score = dB / gate;
      if (score < bestScore) { bestScore = score; best = tr; reason = 'hit'; }
    } else {
      const d = Math.hypot(tr.pos.x - pos.x, tr.pos.y - pos.y);
      const baseSigma = Math.sqrt(Math.max(1, tr.P[0] + tr.P[5]));
      const sigObs = Math.max(60, obs.accuracyM || 100);
      const maneuver = 0.6 * Math.max(1, Math.hypot(tr.vel.x, tr.vel.y)) * age;
      const gate = Math.max(700, 3 * baseSigma + 2.5 * sigObs + maneuver + 200);
      if (d < minD) { minD = d; gateAtMin = gate; }
      if (d > gate) { if (d / gate > bestRatio) { bestRatio = d / gate; reason = 'gateFail'; } continue; }
      const score = d / gate;
      if (score < bestScore) { bestScore = score; best = tr; reason = 'hit'; }
    }
  }
  if (best) { stats.hit++; stats.ratios.push(bestScore); }
  else { if (reason === 'noTrack') stats.noTrack++; else stats.gateFail++; stats.ratios.push(bestRatio); if (minD < Infinity) stats.ageLimits.push(minD); }
  return best;
};
const w = new World({ scenario: sc, database: db, seed: 19420604, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;
w.advance(1200);
console.log('关联调用 ' + stats.calls + ' 次：命中 ' + stats.hit + '（' + (100 * stats.hit / Math.max(1, stats.calls)).toFixed(1) + '%）· 无航迹 ' + stats.noTrack + ' · 门外 ' + stats.gateFail);
console.log('航迹总数（当前存活）' + w.tracks.tracks.length + '，其中 dead=' + w.tracks.tracks.filter((t) => t.dead).length);
const bySide = {};
for (const t of w.tracks.tracks) bySide[t.side] = (bySide[t.side] || 0) + 1;
console.log('按阵营：' + JSON.stringify(bySide) + '（真实敌舰各 4 艘）');
const rs = stats.ratios.slice().sort((a, b) => a - b);
console.log('d/gate 比值：中位 ' + rs[Math.floor(rs.length / 2)] + ' p90 ' + rs[Math.floor(rs.length * 0.9)] + ' 最大 ' + rs[rs.length - 1]);
console.log('创建的航迹数 TSEQ=' + (w.tracks.tracks.reduce((m, t) => Math.max(m, +String(t.id).slice(1) || 0), 0)));
const lives = w.tracks.tracks.map((t) => t.tLast - t.tFirst).sort((a, b) => a - b);
console.log('存活航迹寿命：中位 ' + lives[Math.floor(lives.length / 2)] + 's');
