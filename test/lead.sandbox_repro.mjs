// 复现用户那份 AAR（sandbox / seed 19420604），检查双方是否真的在打、是否还会 25% 就翻
import fs from 'node:fs';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const sc = j('data/scenarios.json').scenarios.find((s) => s.id === 'sandbox');
const w = new World({ scenario: sc, database: db, seed: 19420604, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
for (const s of ['ALLIED', 'AXIS']) w.ai[s].autoCommand = true;   // 双方都自动指挥
const DUR = +(process.argv[2] || 4700);
const t0 = Date.now();
w.advance(DUR);
const bySrc = w.commands.reduce((a, c) => { a[c.source] = (a[c.source] || 0) + 1; return a; }, {});
console.log('仿真 ' + Math.round(w.t) + 's / ' + ((Date.now() - t0) / 1000).toFixed(1) + 's 墙钟 · 命令来源 ' + JSON.stringify(bySrc));
console.log('结局：' + (w.over ? w.resultText : '未判定') + ' 胜方 ' + (w.winner || '—'));
for (const s of w.ships) {
  const mainAmmo = s.batteries.filter((b) => b.role === 'main').reduce((a, b) => a + b.ammo.AP + b.ammo.HE, 0);
  console.log(['  ' + s.name.padEnd(6), s.side.padEnd(7), s.type.padEnd(3),
    '在航=' + (s.isAfloat ? '是' : '否'), '倾覆=' + (s.capsized ? '是' : '否'),
    '进水=' + (100 * s.floodedM3 / s.reserveBuoyancyM3).toFixed(1) + '%', '横倾=' + s.list.toFixed(1) + '°',
    '发射=' + String(s.stats.shotsFired).padStart(5), '命中=' + String(s.stats.hits).padStart(3),
    '鱼雷=' + String(s.stats.torpedoesFired).padStart(3), '主炮弹药=' + String(mainAmmo).padStart(5),
    '航速=' + s.speed.toFixed(1)].join(' '));
}
const shots = w.ships.reduce((a, s) => a + s.stats.shotsFired, 0), hits = w.ships.reduce((a, s) => a + s.stats.hits, 0);
const sunkA = w.shipsOf('ALLIED').filter((s) => !s.isAfloat).length, sunkX = w.shipsOf('AXIS').filter((s) => !s.isAfloat).length;
const neverFired = w.ships.filter((s) => s.stats.shotsFired === 0).map((s) => s.name);
console.log('总发射 ' + shots + ' 命中 ' + hits + '（' + (shots ? (100 * hits / shots).toFixed(1) : 0) + '%）· 沉没 同盟' + sunkA + '/轴心' + sunkX);
console.log('一炮未发的舰：' + (neverFired.length ? neverFired.join('、') : '无'));
