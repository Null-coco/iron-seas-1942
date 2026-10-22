// 水深场：真实等深带（Natural Earth 10m bathymetry）+ 近岸陆架坡度细化。
// 为什么需要细化：0m 等深带覆盖的是 0~200m 的大陆架，单看带宽无法判断"能不能过"。
// 因此用"离岸距离 × 陆架坡度"给出近岸水深估计，与带宽取小值——这样浅滩才真的会搁浅战列舰。
export class DepthField {
  constructor(scenarioDepth, land, opts = {}) {
    this.bands = (scenarioDepth && scenarioDepth.bands) || [];
    this.land = land || null;
    this.cell = opts.cell || 400;
    // 近岸陆架坡度：实测 400m 离岸 ≈10m、2km ≈20m、10km ≈68m、20km ≈128m。
    // 取 6 m/km 是折中：海峡中央（数公里离岸）给到 20~60m，符合苏里高/爪哇海实况；
    // 过陡（12 m/km）会把海峡中央也判成浅滩，让战列舰开局就触底。
    this.shelfSlope = opts.shelfSlope !== undefined ? opts.shelfSlope : 0.006;
    this.empty = this.bands.length === 0;
    this._rasterize();
  }
  _rasterize() {
    if (this.empty) { this.gw = 0; this.gh = 0; this.grid = new Uint16Array(0); this.deepDefault = 4000; return; }
    let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18, maxDepth = 0;
    for (const b of this.bands) for (const p of b.ring) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      if (b.depth > maxDepth) maxDepth = b.depth;
    }
    this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
    this.gw = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 1);
    this.gh = Math.max(1, Math.ceil((maxY - minY) / this.cell) + 1);
    this.deepDefault = maxDepth + 1000;
    const grid = new Uint16Array(this.gw * this.gh);   // 0 = 无数据
    for (const b of this.bands) {                      // 由浅到深绘制，深带覆盖浅带
      const ring = b.ring, n = ring.length;
      for (let gy = 0; gy < this.gh; gy++) {
        const y = minY + gy * this.cell;
        const xs = [];
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const a = ring[j], c = ring[i];
          if ((a[1] > y) !== (c[1] > y)) xs.push(a[0] + (y - a[1]) * (c[0] - a[0]) / (c[1] - a[1]));
        }
        if (!xs.length) continue;
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const gx0 = Math.max(0, Math.floor((xs[k] - minX) / this.cell));
          const gx1 = Math.min(this.gw - 1, Math.ceil((xs[k + 1] - minX) / this.cell));
          for (let gx = gx0; gx <= gx1; gx++) {
            const idx = gy * this.gw + gx;
            if (b.depth > grid[idx]) grid[idx] = b.depth;   // 取最深（等深带互不重叠，保险起见）
          }
        }
      }
    }
    this.grid = grid;
  }
  // 带宽给出的水深
  bandDepthAt(x, y) {
    if (this.empty) return this.deepDefault;
    const gx = Math.floor((x - this.minX) / this.cell), gy = Math.floor((y - this.minY) / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return this.deepDefault;
    const d = this.grid[gy * this.gw + gx];
    return d === 0 ? this.deepDefault : d;
  }
  // 实际水深：与"离岸距离 × 陆架坡度"取小（近岸浅滩）
  depthAt(x, y) {
    const band = this.bandDepthAt(x, y);
    if (!this.land || this.land.empty) return band;
    // 陆架模型在 12km 处已饱和（8 + 12000×0.006 = 80m），再远由等深带决定；
    // 搜 40km 会让开阔海域每次查询扫描数万个栅格——这是丹麦海峡那种"远洋剧本"的性能陷阱。
    const dl = this.land.distanceToLand(x, y, 12000);
    const shelf = 8 + dl * this.shelfSlope;
    return Math.min(band, shelf);
  }
  // 该点对本舰是否可航（吃水 + 富裕水深）
  isNavigable(x, y, draftM, clearance = 1.0) { return this.depthAt(x, y) >= draftM + clearance; }
}
