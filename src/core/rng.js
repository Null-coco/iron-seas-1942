// 确定性随机数（mulberry32 + Box-Muller）。禁止在仿真中使用 Math.random()。
export class RNG {
  constructor(seed = 19420604) { this.seed0 = seed >>> 0; this.s = seed >>> 0; this._spare = null; }
  reset(seed) { this.s = (seed === undefined ? this.seed0 : seed) >>> 0; this._spare = null; }
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this.next() < p; }
  // 标准正态（两枚缓存）
  normal(mu = 0, sigma = 1) {
    if (this._spare !== null) { const v = this._spare; this._spare = null; return mu + sigma * v; }
    let u = 0, v = 0, s = 0;
    do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * f;
    return mu + sigma * u * f;
  }
  // 圆内均匀点（用于散布椭圆）
  gauss2() { return { x: this.normal(), y: this.normal() }; }
  exponential(lambda) { return -Math.log(1 - this.next()) / lambda; }
  rayleigh(sigma) { return sigma * Math.sqrt(-2 * Math.log(1 - this.next())); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  state() { return this.s; }
  setState(s) { this.s = s >>> 0; this._spare = null; }
}
