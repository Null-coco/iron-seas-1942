// Lead 冒烟测试：不依赖 data/ 文件，用内联舰船数据验证冻结内核（Ship/World/事件/RNG/AI 桩）。
import { World } from '../src/sim/world.js';
import { ShipDatabase } from '../src/sim/data.js';

function mk(id, nameZh, type, loa, beam, draft, disp, spd, guns) {
  return {
    id, nameZh, nameEn: id, class: id, nation: 'TEST', type, year: 1942,
    displacementStd_t: disp * 0.9, displacementFull_t: disp, loa_m: loa, lwl_m: loa * 0.97, beam_m: beam, draft_m: draft,
    gm_m: 1.6, blockCoef: 0.58, power_shp: disp * 2, speedMax_kn: spd, speedEcon_kn: 15, rangeEcon_nm: 6000, fuel_t: 3000,
    turnRadiusAt20kn_m: loa * 3.2, rudderAngleMax_deg: 35, rudderRate_deg_s: 3, mastHeight_m: 30, crew: Math.round(disp / 25),
    armor: { belt_mm: 300, beltHeight_m: 3, beltInclined_deg: 0, beltLengthFrac: 0.5, deck_mm: 100, turretFace_mm: 350,
      turretSide_mm: 200, turretTop_mm: 150, barbette_mm: 300, conningTower_mm: 300, bulkhead_mm: 200, tps_depth_m: 3, tpsBulkhead_mm: 40 },
    guns,
    torpedoes: [{ mountLabel: '四联装', tubes: 4, caliber_mm: 610, name: '测试鱼雷', warhead_kg: 300, speed_kn: [45, 35], range_m: [15000, 30000], wakeVisible: false, dudRate: 0.1, reloads: 0 }],
    aa: [], crew: Math.round(disp / 25),
    sensors: {
      radar: [{ id: 'r1', nameZh: '测试雷达', band: 'S', wavelength_cm: 100, peakKW: 10, gain_dBi: 28, prf_hz: 500, pulseWidth_us: 3, detectBB_nm: 20, hasBearing: true, hasRange: true, year: 1942 }],
      sonar: [], hydro: [{ id: 'h', passive: true, sensitivity: 1 }],
      rangefinders: [{ base_m: 6, type: 'coincidence', mount: 'director' }],
      directors: [{ id: 'd1', nameZh: '测试方位盘', hasFCComputer: true, stabilized: true, channels: 2 }],
    },
  };
}
const gun = (role, n, cal) => ({
  id: role, mountLabel: role === 'main' ? '主炮' : '副炮', role, mountType: 'turret', count: n, gunsPerMount: 2,
  bore_mm: cal, cal: 45, elevMin_deg: -5, elevMax_deg: 40, elevRate_deg_s: 8, traverseRate_deg_s: 4,
  ratePerMin: 2, dispersionHalfWidthMil: 1.6, maxRange_m: 35000, ammo: { AP: 200, HE: 200, STAR: 20 },
  shells: { AP: { name: 'AP', mass_kg: 900, mv_mps: 780, bursting_kg: 12 }, HE: { name: 'HE', mass_kg: 800, mv_mps: 800, bursting_kg: 50 } },
});

const db = ShipDatabase.fromObject({ ships: [
  mk('test_bb', '测试战列舰', 'BB', 220, 30, 9, 35000, 28, [gun('main', 3, 380), gun('secondary', 6, 152)]),
  mk('test_ca', '测试重巡', 'CA', 180, 20, 7, 12000, 32, [gun('main', 3, 203), gun('secondary', 4, 127)]),
]});

const scenario = {
  id: 'smoke', nameZh: '冒烟测试',
  start: { lat: 30.0, lon: 150.0, date: '1942-06-01T12:00:00Z', env: { windKn: 14, windDirDeg: 270, visibilityNm: 14 } },
  sides: { ALLIED: { nameZh: '同盟国', objective: '测试' }, AXIS: { nameZh: '轴心国', objective: '测试' } },
  ships: [
    { id: 'A1', name: '测试战列舰', class: 'test_bb', side: 'ALLIED', x: 0, y: 0, heading: 90, speed: 20, role: 'flagship' },
    { id: 'B1', name: '测试重巡', class: 'test_ca', side: 'AXIS', x: 12000, y: 3000, heading: 270, speed: 24, role: 'flagship' },
  ],
  objectives: [],
};

const world = new World({ scenario, database: db, seed: 42, playerSide: 'ALLIED', aiOpts: { backend: 'LOCAL' } });
const t0 = Date.now();
world.advance(600);
const ms = Date.now() - t0;
const A = world.ship('A1'), B = world.ship('B1');
const st = world.visibleStateFor('ALLIED');
console.log(JSON.stringify({
  ok: true,
  simSeconds: world.t,
  wallMs: ms,
  steps: world.tickCount,
  ships: world.ships.map((s) => ({ id: s.id, name: s.name, afloat: s.isAfloat, pos: { x: Math.round(s.pos.x), y: Math.round(s.pos.y) }, hd: Math.round(s.heading), sp: +s.speed.toFixed(1), flooded: Math.round(s.floodedM3) })),
  distanceBetween: Math.round(Math.hypot(B.pos.x - A.pos.x, B.pos.y - A.pos.y)),
  commandsIssued: world.commands.length,
  events: world.events.history.length,
  eventTypes: Array.from(new Set(world.events.history.map((e) => e.type))).slice(0, 20),
  playerTracks: st.tracks.length,
  snapshots: world.record.snapshots.length,
  env: { seaState: +world.env.seaState.toFixed(1), windKn: world.env.windKn, light: +world.env.lightLevel.toFixed(3) },
}, null, 2));
