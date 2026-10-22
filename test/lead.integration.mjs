// Lead 端到端集成测试：真实数据 + 真实剧本 + 双本地 AI，跑完整交战并体检真实感指标。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(__dirname, '..');
const j = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));

const db = ShipDatabase.fromMany([j('data/ships_axis.json'), j('data/ships_allied.json')]);
const scenFile = j('data/scenarios.json');
const scenarios = scenFile.scenarios || scenFile;
const want = process.argv[2];
const scen = want ? scenarios.find((s) => s.id === want) : scenarios[0];
if (!scen) { console.error('找不到剧本', want, '可用：' + scenarios.map((s) => s.id).join(',')); process.exit(1); }

const missing = [];
for (const s of (scen.ships || [])) if (!db.resolve(s.class || s.id)) missing.push(s.id + '/' + (s.class || '?'));
console.log('剧本：' + scen.id + ' / ' + scen.nameZh + ' 舰船 ' + (scen.ships || []).length + ' 艘，无法解析的舰级：' + (missing.length ? missing.join(',') : '无'));

let landData = null;
 try { landData = j('data/land.json'); } catch (e) { landData = null; }
const world = new World({ scenario: scen, database: db, seed: scen.seed || 20261017, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' }, landData });
console.log('装载成功：' + world.ships.length + ' 舰，海况 ' + world.env.seaState + '，风 ' + world.env.windKn + 'kn，能见度 ' + world.env.visibilityNm + 'nm，光照 ' + world.env.lightLevel.toFixed(3));

const DUR = +(process.argv[3] || 1800);
const t0 = Date.now();
let err = null;
try { world.advance(DUR); } catch (e) { err = e; }
const ms = Date.now() - t0;

const ev = world.events.history;
const count = {};
for (const e of ev) count[e.type] = (count[e.type] || 0) + 1;
const sunk = world.ships.filter((s) => !s.isAfloat);
const damaged = world.ships.filter((s) => s.floodedM3 > 10 || s.compartments.some((c) => c.fire > 0.05));
console.log('\n=== 结果 ===');
if (err) console.log('运行时异常：' + err.message + '\n' + String(err.stack).split('\n').slice(0, 4).join('\n'));
console.log('仿真 ' + world.t.toFixed(0) + 's / 墙钟 ' + ms + 'ms（' + (world.t / (ms / 1000)).toFixed(0) + 'x 实时）步数 ' + world.tickCount);
console.log('结束：' + (world.over ? world.resultText : '未结束') + ' 胜方 ' + (world.winner || '—'));
console.log('沉没：' + (sunk.length ? sunk.map((s) => s.name + '(' + s.side + ')').join(', ') : '无'));
console.log('受损：' + (damaged.length ? damaged.map((s) => s.name + ' 进水' + Math.round(s.floodedM3) + 'm³ 横倾' + s.list.toFixed(1) + '°').join(' | ') : '无'));
console.log('事件统计：' + Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, 24).map((k) => k + '=' + count[k]).join(' '));
const shots = world.ships.reduce((a, s) => a + s.stats.shotsFired, 0);
const hits = world.ships.reduce((a, s) => a + s.stats.hits, 0);
const torps = world.ships.reduce((a, s) => a + s.stats.torpedoesFired, 0);
const trackN = world.tracks ? world.tracks.tracks.length : 0;
console.log('弹药：发射齐射/次数 ' + shots + '，命中 ' + hits + '（命中率 ' + (shots ? (100 * hits / shots).toFixed(1) : '0') + '%），鱼雷 ' + torps + '，航迹 ' + trackN);
console.log('命令：' + world.commands.length + '，AI 决策事件 ' + (count['ai.decision'] || 0) + '，探测事件 ' + ((count['sensor.detect'] || 0) + (count['sensor.visual.spot'] || 0)));
const st = world.visibleStateFor('ALLIED');
console.log('玩家可见航迹 ' + st.tracks.length + ' 个（雾里看花测试：若与敌方实际舰数相等且误差=0，说明传感器没生效）');
console.log('样本：' + JSON.stringify(st.tracks.slice(0, 3)));
process.exit(err ? 2 : 0);
