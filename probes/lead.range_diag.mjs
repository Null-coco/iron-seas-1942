import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'denmark_strait_1941');
const w = new World({ scenario: sc, database: db, seed: 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
const NMI = 1852;
console.log('舰船: ' + w.ships.map((s) => s.id + '/' + s.name + '(' + s.side + ')').join(', '));
let shots = 0, hits = 0;
for (let k = 0; k < 15; k++) {
  w.advance(120);
  const A = w.shipsOf('ALLIED')[0], B = w.shipsOf('AXIS')[0];
  const d = Math.hypot(A.pos.x - B.pos.x, A.pos.y - B.pos.y) / NMI;
  shots = w.ships.reduce((a, s) => a + s.stats.shotsFired, 0);
  hits = w.ships.reduce((a, s) => a + s.stats.hits, 0);
  const fireDist = w.events.history.filter((e) => e.type === 'gun.fire').slice(-40).map((e) => e.rangeM / NMI);
  const avgFire = fireDist.length ? (fireDist.reduce((a, b) => a + b, 0) / fireDist.length) : 0;
  const ai = w.ai['ALLIED'].local.lastReasoning.slice(0, 46);
  console.log('t=' + String(Math.round(w.t)).padStart(4) + 's 胡德↔俾斯麦=' + d.toFixed(1) + 'nmi 开火均距=' + avgFire.toFixed(1) + 'nmi 发/中=' + shots + '/' + hits + ' 航速 ' + A.speed.toFixed(1) + '/' + B.speed.toFixed(1) + ' 航向 ' + Math.round(A.heading) + '/' + Math.round(B.heading) + ' | ' + ai);
}
const g = await import('../src/ai/local_ai.js');
console.log('LocalAI 常量/条令关键字: ' + JSON.stringify(Object.keys(g)).join(','));
