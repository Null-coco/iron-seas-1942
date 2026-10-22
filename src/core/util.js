// 通用数学与单位换算。禁止依赖 DOM。
export const KN_TO_MPS = 0.514444;
export const MPS_TO_KN = 1 / KN_TO_MPS;
export const NMI = 1852;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const deg2rad = (d) => d * DEG;
export const rad2deg = (r) => r / DEG;
export const kn2mps = (k) => k * KN_TO_MPS;
export const mps2kn = (v) => v * MPS_TO_KN;
export const nm2m = (n) => n * NMI;
export const m2nm = (m) => m / NMI;
export const feet2m = (f) => f * 0.3048;
export const yd2m = (y) => y * 0.9144;

export function normDeg(d) { d %= 360; return d < 0 ? d + 360 : d; }
export function normDeg180(d) { d = normDeg(d); return d > 180 ? d - 360 : d; }
export function angleDiff(a, b) { return normDeg180(a - b); }
export function normMil(d) { return normDeg180(d); }

export function dist2d(a, b) { const dx = b.x - a.x, dy = b.y - a.y; return Math.hypot(dx, dy); }
export function bearing2d(from, to) { return normDeg(rad2deg(Math.atan2(to.x - from.x, to.y - from.y))); }
export function destPoint(from, rangeM, bearingDeg) {
  const r = deg2rad(bearingDeg);
  return { x: from.x + rangeM * Math.sin(r), y: from.y + rangeM * Math.cos(r) };
}
// 相对方位（右正左负）
export function relativeBearing(fromHeading, bearing) { return normDeg180(bearing - fromHeading); }
// 目标舷角（0=舰艏，180=舰艉）
export function aspectAngle(targetHeading, bearingToTarget) { return Math.abs(normDeg180(bearingToTarget + 180 - targetHeading)); }

export function sign(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }

// 小角度近似下：给定横向加速度与航速求回转率
export function turnRateFromAccel(accelMps2, speedMps) { return speedMps <= 0.5 ? 0 : rad2deg(accelMps2 / speedMps); }

export function fmt(v, digits = 0) { return Number(v).toFixed(digits); }
export function fmtClock(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
export function fmtClockHM(t) { const s = Math.max(0, Math.floor(t)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }
// 航向文字（真方位）
export function bearingText(d) { return String(Math.round(normDeg(d))).padStart(3, '0'); }
export function latLonText(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  const la = Math.abs(lat), lo = Math.abs(lon);
  const lfDeg = Math.floor(la), lfMin = (la - lfDeg) * 60;
  const loDeg = Math.floor(lo), loMin = (lo - loDeg) * 60;
  return lfDeg + '\u00b0' + lfMin.toFixed(1) + "'" + ns + ' ' + loDeg + '\u00b0' + loMin.toFixed(1) + "'" + ew;
}
export function sum(arr) { let s = 0; for (const v of arr) s += v; return s; }
export function movingAverage(prev, next, alpha) { return prev + (next - prev) * alpha; }
