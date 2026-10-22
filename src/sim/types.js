// 公共类型与常量（JSDoc 形式，运行期只是冻结对象）。
export const Side = Object.freeze({ ALLIED: 'ALLIED', AXIS: 'AXIS' });
export const ShipType = Object.freeze({ BB: 'BB', BC: 'BC', CA: 'CA', CL: 'CL', DD: 'DD', CV: 'CV' });
export const AmmoKind = Object.freeze({ AP: 'AP', HE: 'HE', SAP: 'SAP', STAR: 'STAR', ILLUM: 'ILLUM', AA: 'AA' });
export const CmdKind = Object.freeze({
  SET_COURSE: 'SET_COURSE', SET_SPEED: 'SET_SPEED', SET_RUDDER: 'SET_RUDDER',
  FIRE: 'FIRE', CEASE_FIRE: 'CEASE_FIRE', LAUNCH_TORPEDO: 'LAUNCH_TORPEDO',
  SMOKE: 'SMOKE', SEARCHLIGHT: 'SEARCHLIGHT', RADAR: 'RADAR', SONAR: 'SONAR',
  STAR_SHELL: 'STAR_SHELL', DC_PRIORITY: 'DC_PRIORITY', DAMAGE_CONTROL: 'DAMAGE_CONTROL',
  FORMATION: 'FORMATION', WITHDRAW: 'WITHDRAW', ASSIGN_TARGET: 'ASSIGN_TARGET',
  SET_SCREEN: 'SET_SCREEN', PLOT_COURSE: 'PLOT_COURSE', LAUNCH_AIRCRAFT: 'LAUNCH_AIRCRAFT',
  CHAT: 'CHAT',
});
export const SrcKind = Object.freeze({ RADAR: 'RADAR', VISUAL: 'VISUAL', SONAR: 'SONAR', HFDF: 'HFDF', SCRIPT: 'SCRIPT', WAKE: 'WAKE' });
export const OrderSource = Object.freeze({ PLAYER: 'PLAYER', AI_REMOTE: 'AI_REMOTE', AI_LOCAL: 'AI_LOCAL', SCRIPT: 'SCRIPT' });
export const Role = Object.freeze({ CAPTAIN: 'CAPTAIN', FLEET: 'FLEET', DEPARTMENT: 'DEPARTMENT' });
export const CompartmentKind = Object.freeze({
  BOW: 'BOW', MAGAZINE: 'MAGAZINE', MACHINERY: 'MACHINERY', BOILER: 'BOILER',
  TURRET: 'TURRET', BRIDGE: 'BRIDGE', STEERING: 'STEERING', CREW: 'CREW', TANK: 'TANK', STERN: 'STERN',
});
// 船员素质：0.6=匆忙征召 0.8=普通 1.0=训练有素 1.15=精锐（影响装填、损管、测距、校射）
export const CrewQuality = Object.freeze({ POOR: 0.65, AVERAGE: 0.85, GOOD: 1.0, VETERAN: 1.15 });
// 弹药/鱼雷的引信可靠性年代修正（1942-43 美军鱼雷的惨痛教训）
export const TorpedoReliability = Object.freeze({
  US_EARLY: { dud: 0.45, deepRun: 0.30, prem: 0.20 },
  US_MID: { dud: 0.25, deepRun: 0.12, prem: 0.08 },
  US_LATE: { dud: 0.08, deepRun: 0.04, prem: 0.03 },
  JP: { dud: 0.06, deepRun: 0.05, prem: 0.05 },
  UK: { dud: 0.12, deepRun: 0.08, prem: 0.06 },
  DE: { dud: 0.15, deepRun: 0.10, prem: 0.10 },
  IT: { dud: 0.18, deepRun: 0.12, prem: 0.12 },
  FR: { dud: 0.15, deepRun: 0.10, prem: 0.10 },
});
export function reliabilityFor(nation, year) {
  if (nation === 'US') { if (year <= 1943) return TorpedoReliability.US_EARLY; if (year <= 1944) return TorpedoReliability.US_MID; return TorpedoReliability.US_LATE; }
  if (nation === 'JP') return TorpedoReliability.JP;
  if (nation === 'UK') return TorpedoReliability.UK;
  if (nation === 'DE') return TorpedoReliability.DE;
  if (nation === 'IT') return TorpedoReliability.IT;
  if (nation === 'FR') return TorpedoReliability.FR;
  return TorpedoReliability.US_MID;
}
