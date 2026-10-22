#!/usr/bin/env node
// 黄金种子基线：固定 seed 跑几局，把 winner/沉没/命中/鱼雷/殉爆 落盘为基线。
// 用法：node tools/golden.mjs --update   （重生成 test/golden/baseline.json）
//       node tools/golden.mjs             （只打印当前值，供比对）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { loadDatabase, loadScenario } from '../server/headless.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test/golden/baseline.json');

export const CASES = [
  { scenario: 'denmark_strait_1941', seed: 19420604, seconds: 900 },
  { scenario: 'denmark_strait_1941', seed: 7, seconds: 900 },
  { scenario: 'savo_island_1942', seed: 19420604, seconds: 900 },
  { scenario: 'savo_island_1942', seed: 11, seconds: 900 },
];

export function runCase(c, db, landData, depthData) {
  const sc = loadScenario(ROOT, c.scenario).scenario;
  const world = new World({ scenario: sc, database: db.database, seed: c.seed, playerSide: 'ALLIED', ai: true, aiOpts: { backend: 'LOCAL' }, buildFromScenario: true, landData, depthData });
  while (!world.over && world.t < c.seconds) world.step(0.1);
  const e = world.events.history;
  const n = (t) => e.filter((x) => x.type === t).length;
  return {
    scenario: c.scenario, seed: c.seed, seconds: c.seconds,
    t: +world.t.toFixed(1), winner: world.winner || 'NONE',
    sinks: n('ship.sink'), gunHits: n('gun.hit'), torpHits: n('torp.hit'), magazine: n('dam.magazine'),
    friendlyFire: n('gun.friendlyfire'),
    shipsAfloat: world.ships.filter((s) => s.isAfloat).length, shipsTotal: world.ships.length,
  };
}

export function runAll() {
  const db = loadDatabase(ROOT);
  let landData = null, depthData = null;
  try { landData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/land.json'), 'utf8')); } catch (e) { landData = null; }
  try { depthData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/depth.json'), 'utf8')); } catch (e) { depthData = null; }
  return CASES.map((c) => runCase(c, db, landData, depthData));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rows = runAll();
  if (process.argv.includes('--update')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1));
    console.log('已写入 ' + OUT);
  }
  for (const r of rows) console.log(JSON.stringify(r));
}
