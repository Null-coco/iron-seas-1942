// 陆地：把剧本区域的真实海岸线变成可查询的对象（栅格化 + 点/线段查询 + 搁浅推离）。
// 数据来自 Natural Earth 10m（tools/build-land-data.mjs 按剧本裁剪、简化到 120m）。
// 用途：1) 航行不能穿越陆地（搁浅会损毁）；2) 陆地遮蔽视线与雷达；3) 海图绘制；4) AI 避让。
export class Land {
  constructor(scenarioLand, opts = {}) {
    this.rings = (scenarioLand && scenarioLand.rings) || [];
    this.cell = opts.cell || 400;          // 栅格边长（米）
    this.empty = this.rings.length === 0;
    this._rasterize();
  }
  _rasterize() {
    let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
    for (const ring of this.rings) for (const p of ring) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    if (!Number.isFinite(minX)) { this.empty = true; this.gw = 0; this.gh = 0; this.grid = new Uint8Array(0); return; }
    this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
    this.gw = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 1);
    this.gh = Math.max(1, Math.ceil((maxY - minY) / this.cell) + 1);
    const grid = new Uint8Array(this.gw * this.gh);
    // 扫描线填充（even-odd）
    for (const ring of this.rings) {
      const n = ring.length;
      for (let gy = 0; gy < this.gh; gy++) {
        const y = minY + gy * this.cell;
        const xs = [];
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const a = ring[j], b = ring[i];
          if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
        }
        if (!xs.length) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const gx0 = Math.max(0, Math.floor((xs[k] - minX) / this.cell));
          const gx1 = Math.min(this.gw - 1, Math.ceil((xs[k + 1] - minX) / this.cell));
          for (let gx = gx0; gx <= gx1; gx++) grid[gy * this.gw + gx] = 1;
        }
      }
    }
    this.grid = grid;
    // 细小岛礁索引：栅格边长 400m，小于一格的岛会被"跨过去"。这里为每个环建 bbox 索引，
    // isLand/segmentBlocked 在栅格判定为水之后，再用精确的射线法/线段求交兜底。
    // 性能红线：大环（如丹麦海峡那条 6 万顶点的岸线）逐点射线法代价极高，而大块陆地
    // 已被栅格精确覆盖；精确回退只需负责"小于约 2×2 栅格"的小环（栅格会跨过去的屿礁）。
    const maxSmallSpan = this.cell * 3;
    this.ringBoxes = [];
    for (const ring of this.rings) {
      let a = 1e18, b = 1e18, c = -1e18, d = -1e18;
      for (const p of ring) { if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; }
      if (c - a > maxSmallSpan || d - b > maxSmallSpan) continue;   // 大环交给栅格
      this.ringBoxes.push({ ring, a, b, c, d });
    }
    // 空间索引：把每个小环登记到它 bbox 覆盖的所有栅格，查询时只碰邻近小环
    // （萨沃 247 个环、苏里高 770 个环，逐个遍历是 O(n) 且每次雷达视线都要做一遍）
    this.ringGrid = new Map();
    this.ringBoxes.forEach((rb, idx) => {
      const gx0 = Math.floor((rb.a - this.minX) / this.cell), gx1 = Math.floor((rb.c - this.minX) / this.cell);
      const gy0 = Math.floor((rb.b - this.minY) / this.cell), gy1 = Math.floor((rb.d - this.minY) / this.cell);
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const k = gy * 100003 + gx;
        let arr = this.ringGrid.get(k);
        if (!arr) { arr = []; this.ringGrid.set(k, arr); }
        arr.push(idx);
      }
    });
  }
  _nearbyRings(x, y) {
    const gx = Math.floor((x - this.minX) / this.cell), gy = Math.floor((y - this.minY) / this.cell);
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = this.ringGrid.get((gy + dy) * 100003 + (gx + dx));
      if (arr) for (const i of arr) if (out.indexOf(i) < 0) out.push(i);
    }
    return out;
  }
  _pointInRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // 精确点判定：栅格命中即陆地；否则在 bbox 覆盖该点的小环里做射线法
  isLandExact(x, y) {
    if (this.empty) return false;
    if (this._cellAt(x, y) === 1) return true;
    for (const i of this._nearbyRings(x, y)) {
      const rb = this.ringBoxes[i];
      if (x < rb.a || x > rb.c || y < rb.b || y > rb.d) continue;
      if (this._pointInRing(rb.ring, x, y)) return true;
    }
    return false;
  }
  _cellAt(x, y) {
    const gx = Math.floor((x - this.minX) / this.cell), gy = Math.floor((y - this.minY) / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return 0;
    return this.grid[gy * this.gw + gx];
  }
  isLand(x, y) { return this.empty ? false : this._cellAt(x, y) === 1; }
  // 对外统一用精确判定（含细小岛礁）
  isLandAny(x, y) { return this.empty ? false : this.isLandExact(x, y); }
  // 到最近陆地的近似距离（米），最多搜 maxR 米
  distanceToLand(x, y, maxR = 12000) {
    if (this.empty) return maxR;
    if (this.isLand(x, y)) return 0;
    const maxC = Math.ceil(maxR / this.cell);
    const gx0 = Math.floor((x - this.minX) / this.cell), gy0 = Math.floor((y - this.minY) / this.cell);
    for (let r = 1; r <= maxC; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const dy of [-r, r]) {
          const gx = gx0 + dx, gy = gy0 + dy;
          if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) continue;
          if (this.grid[gy * this.gw + gx]) return r * this.cell;
        }
      }
      for (let dy = -r + 1; dy < r; dy++) {
        for (const dx of [-r, r]) {
          const gx = gx0 + dx, gy = gy0 + dy;
          if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) continue;
          if (this.grid[gy * this.gw + gx]) return r * this.cell;
        }
      }
    }
    return maxR;
  }
  // 视线/雷达是否被陆地遮挡（沿线采样）
  segmentBlocked(a, b) {
    if (this.empty) return false;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return false;
    const step = this.cell * 0.6;
    const n = Math.min(6000, Math.ceil(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.isLand(a.x + dx * t, a.y + dy * t)) return true;
    }
    // 栅格采样可能跨过细小岛礁：再用线段与小环的精确求交兜底
    const segMinX = Math.min(a.x, b.x), segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y), segMaxY = Math.max(a.y, b.y);
    // 只检查线段沿途栅格登记的小环（而不是全部环）
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const cand = [];
    const steps = Math.max(2, Math.ceil(len / this.cell));
    for (let i = 0; i <= steps; i++) {
      const t2 = i / steps;
      for (const idx of this._nearbyRings(a.x + dx * t2, a.y + dy * t2)) if (cand.indexOf(idx) < 0) cand.push(idx);
    }
    for (const i of cand) {
      const rb = this.ringBoxes[i];
      if (rb.c < segMinX || rb.a > segMaxX || rb.d < segMinY || rb.b > segMaxY) continue;
      const ring = rb.ring;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (this._segIntersect(a.x, a.y, b.x, b.y, ring[j][0], ring[j][1], ring[i][0], ring[i][1])) return true;
      }
    }
    return false;
  }
  _segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
  // 搁浅推离：把点挪到最近的水域（螺旋搜索），返回是否移动过
  pushOut(pos, maxR = 3000) {
    if (this.empty || !this.isLandExact(pos.x, pos.y)) return false;
    const step = this.cell;
    for (let r = 1; r * step <= maxR; r++) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const nx = pos.x + Math.cos(a) * r * step, ny = pos.y + Math.sin(a) * r * step;
        if (!this.isLandExact(nx, ny)) { pos.x = nx; pos.y = ny; return true; }
      }
    }
    return false;
  }
}
