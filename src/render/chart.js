// 战术海图渲染 v2：只画"我们所知道的"世界。视觉目标——像一块真实的 1942 年战术标图桌。
import { clamp, normDeg, normDeg180, dist2d, bearing2d, NMI } from "../core/util.js";
import { chartPalette } from "../ui/theme.js";

// 阵营 / 国籍配色：模块级常量拿不到 CSS 变量，必须按主题现取（P 由调用方传入）。
function sideColor(side, P) {
  if (side === "ALLIED") return P.allied;
  if (side === "AXIS") return P.axis;
  return P.unknown;      // 未标注阵营
}
function nationColor(nat, P) {
  if (nat === "US") return P.nationUs;
  if (nat === "UK") return P.nationUk;
  if (nat === "JP") return P.nationJp;
  if (nat === "DE") return P.nationDe;
  if (nat === "IT") return P.nationIt;
  if (nat === "FR") return P.nationFr;
  return null;           // 未知国籍 -> 调用方回退到阵营色
}
const TYPE_LETTER = { BB: "B", BC: "B", CA: "C", CL: "C", DD: "D", CV: "V" };

export class ChartRenderer {
  constructor(canvas, world, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = world;
    this.cam = { x: 0, y: 0, scale: 0.14 };   // px/m：默认约 12km 视野，战列舰约 35px
    this.follow = opts.follow || null;
    this.selectedId = null;
    this.selectedTrackId = null;
    this.showUncertainty = true;
    this.showGrid = true;
    this.trails = new Map();      // shipId -> [{x,y}] 尾迹
    this.hover = null;            // {x,y} 屏幕坐标
    this.booms = [];              // 弹药库殉爆特效 {x,y,t,energyKg,r}
    this.time = 0;
    this.dpr = 1;
    this._bindHover();
    this.resize();
  }

  _bindHover() {
    const c = this.canvas;
    this._onMove = (e) => {
      const r = c.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this._onLeave = () => { this.hover = null; };
    c.addEventListener("mousemove", this._onMove);
    c.addEventListener("mouseleave", this._onLeave);
  }
  // 换剧本时会 new 一个新的 ChartRenderer；不摘掉旧监听会在同一张画布上叠加，越打越卡
  destroy() {
    const c = this.canvas;
    if (this._onMove) c.removeEventListener("mousemove", this._onMove);
    if (this._onLeave) c.removeEventListener("mouseleave", this._onLeave);
    this._onMove = null; this._onLeave = null;
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    const r = host.getBoundingClientRect ? host.getBoundingClientRect() : { width: 1280, height: 720 };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(320, Math.floor(r.width * this.dpr));
    this.canvas.height = Math.max(240, Math.floor(r.height * this.dpr));
    this.w = r.width; this.h = r.height;
  }

  // 字体族只查一次：getComputedStyle 会强制样式重算，放在每帧每标签里是真实的性能问题
  _font(size, kind) {
    const k = kind === "sans" ? "sans" : "mono";
    if (!this._fontCache) this._fontCache = {};
    if (this._fontCache[k] === undefined) {
      let fam = "";
      try {
        // 海图主题要求"老图鉴"的衬线标注：通过 --c-label-font 这个字符串 token 切换，
        // 换皮只改 CSS，绘制代码不需要 if(theme)。
        const P = this._pal || chartPalette();
        if (String(P.fontLabels || "mono") === "serif" && (k === "sans" || kind === "label")) {
          fam = '"Songti SC","Noto Serif SC","Source Han Serif SC",serif';
        }
        if (!fam && typeof getComputedStyle === "function" && typeof document !== "undefined" && document.documentElement) {
          fam = String(getComputedStyle(document.documentElement).getPropertyValue(k === "sans" ? "--sans" : "--mono") || "").trim();
        }
      } catch (e) { fam = ""; }
      this._fontCache[k] = fam || (k === "sans"
        ? '-apple-system,BlinkMacSystemFont,"Noto Sans SC","PingFang SC",sans-serif'
        : 'ui-monospace,"SF Mono",Menlo,Consolas,monospace');
    }
    return size + "px " + this._fontCache[k];
  }

  static pt(o) { return o && o.pos ? o.pos : o; }
  worldToScreen(raw) {
    const p = ChartRenderer.pt(raw);
    return { x: (p.x - this.cam.x) * this.cam.scale + this.w / 2, y: this.h / 2 - (p.y - this.cam.y) * this.cam.scale };
  }
  screenToWorld(s) {
    return { x: (s.x - this.w / 2) / this.cam.scale + this.cam.x, y: (this.h / 2 - s.y) / this.cam.scale + this.cam.y };
  }
  zoomAt(screen, factor) {
    const before = this.screenToWorld(screen);
    this.cam.scale = clamp(this.cam.scale * factor, 0.0008, 1.5);
    const after = this.screenToWorld(screen);
    this.cam.x += before.x - after.x; this.cam.y += before.y - after.y;
  }
  centerOn(p, instant) {
    if (instant) { this.cam.x = p.x; this.cam.y = p.y; this.camTarget = null; return; }
    this.camTarget = { x: p.x, y: p.y };
  }
  _easeCamera() {
    if (!this.camTarget) return;
    const k = 0.12;
    this.cam.x += (this.camTarget.x - this.cam.x) * k;
    this.cam.y += (this.camTarget.y - this.cam.y) * k;
    if (Math.hypot(this.camTarget.x - this.cam.x, this.camTarget.y - this.cam.y) < 5) { this.cam.x = this.camTarget.x; this.cam.y = this.camTarget.y; this.camTarget = null; }
  }
  // 命令回执：在海图上闪一下目标位置与航向
  flashOrder(x, y, heading) { this.flash = { x: x, y: y, h: heading, t0: this.time }; }
  // 自动取景：把己方舰与已知航迹一起框进来（解决"开局一片空海"）
  fitToContacts(state, pad) {
    const w = this.world;
    if (!w) return false;
    const k = pad || 1.22;
    let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18, n = 0;
    const acc = (p) => { if (!p) return; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); n++; };
    const mine = (state && state.side) || null;
    let oMinX = 1e18, oMinY = 1e18, oMaxX = -1e18, oMaxY = -1e18, on = 0;
    for (const s of w.ships) {
      if (!s.isAfloat) continue; if (mine && s.side !== mine) continue;
      acc(s.pos); oMinX = Math.min(oMinX, s.pos.x); oMaxX = Math.max(oMaxX, s.pos.x); oMinY = Math.min(oMinY, s.pos.y); oMaxY = Math.max(oMaxY, s.pos.y); on++;
    }
    if (!on) return false;
    // 己方编队的尺度；接触最多把视野外扩到己方尺度的 2.4 倍（保证己方始终清晰可见）
    // 下限放宽到 12km、cap 提到 2.6 倍：否则 14km 外的敌舰会被排除在取景之外，
    // 玩家看到的就是一片空海（这是"海图很空"的根因）。
    const ownSpan = Math.max(12000, Math.max(oMaxX - oMinX, oMaxY - oMinY));
    const cap = ownSpan * 2.6;
    for (const t of ((state && state.tracks) || [])) {
      if (!t.pos) continue;
      if (Math.abs(t.pos.x - (oMinX + oMaxX) / 2) > cap || Math.abs(t.pos.y - (oMinY + oMaxY) / 2) > cap) continue;
      acc(t.pos);
    }
    if (!n) return false;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanX = Math.max(4000, (maxX - minX)) * k;
    const spanY = Math.max(4000, (maxY - minY)) * k;
    this.cam.x = cx; this.cam.y = cy;
    // 取景的下界必须足够低，否则"框住整支编队"这件事根本不成立：丹麦海峡里两艘巡洋舰
    // 离战巡 ~26nm，按 1.25 倍留白需要 ≈0.010 px/m，一旦被抬到 0.035 就会把大半支编队
    // 挤出屏幕 —— 玩家看到的就是"空海 + 找不到自己的船"。
    // 舰体本身有最小像素长度（Math.max(14, loa*sc)），所以缩放再小也不会看不见。
    this.cam.scale = clamp(Math.min(this.w / spanX, this.h / spanY), 0.004, 0.45);
    return true;
  }
  get mPerPx() { return 1 / this.cam.scale; }

  // ============================================================ 主绘制
  draw(state) {
    // 每帧取一次调色板（内部按主题缓存），存到 this._pal 供各绘制方法使用
    const P = chartPalette();
    this._pal = P;
    // 主题一换，字体族与陆地斜线 pattern 都失效
    if (this._themeSeen !== P.theme) {
      this._themeSeen = P.theme;
      this._fontCache = null;
      this._hatch = null;
      this._hatchKey = "";
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    const w = this.w, h = this.h;
    const light = state && state.environment ? state.environment.lightLevel : 1;
    this.night = light < 0.3;      // 夜间给接触加辉光，否则 1% 光照下海图无法使用
    const world = this.world;
    this.time += 0.016;
    this._easeCamera();
    this.dockH = this._dockHeight();
    this.zones = this._reservedZones();
    this._ocean(ctx, w, h, light);
    if (world) {
      this._depth(ctx);
      this._land(ctx);
      this._grid(ctx, w, h);
      // 夜色是"环境光"，必须画在单位之前。旧版把它画在最后，1% 光照的夜战剧本会把
      // 已经画好的舰船与航迹一并压黑，海图上什么都看不见（战术标图桌不该关灯）。
      this._night(ctx, w, h, light);
      if (this.showGrid) this._horizonCircle(ctx, state);
      this._frame(ctx, w, h);
      this._smoke(ctx, world);
      this._splashes(ctx, world);
      this._torpedoes(ctx, world, state);
      this._projectiles(ctx, world, state);
      this._booms(ctx);
      this._updateTrails(world);
      this._trails(ctx, world, state);
      this._ships(ctx, world, state);
      const tracks = (state && state.tracks) || [];
      this._tracks(ctx, tracks, world, state);
      this._selection(ctx, world, tracks);
      this._minimap(ctx, w, h, world, state);
    }
    this._orderFlash(ctx);
    this._steerPreview(ctx);
    this._scaleBar(ctx, w, h);
    this._compass(ctx, w, h);
    this._hover(ctx, state);
    ctx.restore();
  }

  // ---------- 海面 ----------
  _ocean(ctx, w, h, light) {
    const P = this._pal || chartPalette();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const night = light < 0.35;
    g.addColorStop(0, P.seaTop);
    g.addColorStop(0.52, P.seaMid);
    g.addColorStop(1, P.seaBot);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // 风浪纹理：一束与风向平行的极淡条纹，让"海"有方向感（屏幕空间，避免随缩放闪烁）
    const env = (this.world && this.world.env) || null;
    const wd = ((env ? env.windDirDeg : 0) + 180) * Math.PI / 180;
    const sea = (env ? env.seaState : 3) || 3;
    const dx = Math.sin(wd), dy = -Math.cos(wd);
    const px = -dy, py = dx;
    const span = Math.hypot(w, h);
    ctx.save();
    ctx.globalAlpha = (night ? 0.05 : 0.08) * clamp(0.55 + sea / 9, 0.55, 1.5);
    ctx.strokeStyle = P.swell;
    ctx.lineWidth = 1;
    const step = 27;
    const rows = Math.ceil((span * 1.5) / step);
    for (let i = -rows; i <= rows; i++) {
      const ox = w / 2 + px * i * step, oy = h / 2 + py * i * step;
      const off = ((i * 37) % 29) - 14;
      ctx.beginPath();
      ctx.moveTo(ox - dx * span * 0.5 + px * off, oy - dy * span * 0.5 + py * off);
      ctx.lineTo(ox + dx * span * 0.5 + px * off, oy + dy * span * 0.5 + py * off);
      ctx.stroke();
    }
    ctx.restore();
    const hz = ctx.createLinearGradient(0, 0, 0, h * 0.24);
    hz.addColorStop(0, P.alpha(P.horizon, night ? 0.10 : 0.12));
    hz.addColorStop(1, P.alpha(P.horizon, 0));
    ctx.fillStyle = hz; ctx.fillRect(0, 0, w, h * 0.24);
    // 四周轻压暗：把注意力收进海图中央。用单独的 vignette token —— nightWash 是给夜间压暗用的深色，
    // 纸面主题下拿它压暗会变成一圈明显的棕色暗环。
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.36, w / 2, h / 2, Math.max(w, h) * 0.8);
    vg.addColorStop(0, P.alpha(P.vignette, 0));
    vg.addColorStop(1, P.alpha(P.vignette, .30));
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }

  _night(ctx, w, h, light) {
    const P = this._pal || chartPalette();
    if (light >= 0.45) return;
    const k = clamp((0.45 - light) / 0.45, 0, 1);
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.18, w / 2, h / 2, Math.max(w, h) * 0.72);
    g.addColorStop(0, P.alpha(P.nightWash, 0));
    g.addColorStop(1, P.alpha(P.nightWash, 0.3 * k));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = P.alpha(P.nightWash, 0.1 * k);
    ctx.fillRect(0, 0, w, h);
  }

  // ---------- 图廓与刻度（海图主题；其他主题 --c-frame-a=0 时直接返回）----------
  _frame(ctx, w, h) {
    const P = this._pal || chartPalette();
    const a = Number(P.frameAlpha) || 0;
    if (a <= 0) return;
    const m1 = 6, m2 = 11;
    ctx.save();
    ctx.strokeStyle = P.alpha(P.ink, a * 0.75);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(m1, m1, w - m1 * 2, h - m1 * 2);
    ctx.strokeStyle = P.alpha(P.ink, a * 0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(m2, m2, w - m2 * 2, h - m2 * 2);
    // 沿图廓的刻度尺：每 5 格加长，像真的分度线
    ctx.strokeStyle = P.alpha(P.ink, a * 0.7);
    ctx.lineWidth = 1;
    const step = 62;
    let i = 0;
    for (let x = m1; x <= w - m1; x += step, i++) {
      const len = i % 5 === 0 ? 9 : 5;
      ctx.beginPath(); ctx.moveTo(x, m1); ctx.lineTo(x, m1 + len); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, h - m1); ctx.lineTo(x, h - m1 - len); ctx.stroke();
    }
    i = 0;
    for (let y = m1; y <= h - m1; y += step, i++) {
      const len = i % 5 === 0 ? 9 : 5;
      ctx.beginPath(); ctx.moveTo(m1, y); ctx.lineTo(m1 + len, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(w - m1, y); ctx.lineTo(w - m1 - len, y); ctx.stroke();
    }
    // 四角十字（制图套准用的那种）
    const cross = (x, y) => {
      ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y);
      ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
    };
    cross(m2, m2); cross(w - m2, m2); cross(m2, h - m2); cross(w - m2, h - m2);
    ctx.restore();
  }

  // ---------- 陆地斜线填充（印刷主题；--c-hatch-a=0 时不画）----------
  _hatchFill(ctx, P, ha) {
    const key = P.hatch + "|" + ha;
    if (this._hatch && this._hatchKey === key) return this._hatch;
    this._hatch = null;
    this._hatchKey = key;
    if (typeof document === "undefined" || !document.createElement) return null;
    const c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    const g = c.getContext("2d");
    if (!g) return null;
    g.strokeStyle = P.alpha(P.hatch, ha);
    g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(-3, 11); g.lineTo(11, -3); g.stroke();
    this._hatch = ctx.createPattern(c, "repeat");
    return this._hatch;
  }

  // ---------- 水深（真实等深带分层着色）----------
  _depth(ctx) {
    const P = this._pal || chartPalette();
    const w = this.world;
    if (!w || !w.depth || w.depth.empty) return;
    const bands = w.depth.bands;
    // 由深到浅绘制，浅色覆盖深色
    const sorted = bands.slice().sort((a, b) => b.depth - a.depth);
    ctx.save();
    for (const b of sorted) {
      const ring = b.ring;
      if (!ring || ring.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const p = this.worldToScreen({ x: ring[i][0], y: ring[i][1] });
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      const d = b.depth;
      // 0-200m 浅水偏青、越深越暗（与真实海图习惯一致）
      const aScale = Number(P.depthAlphaScale) || 1;
      const a = (d <= 200 ? 0.20 : d <= 1000 ? 0.13 : d <= 3000 ? 0.08 : 0.045) * aScale;
      // 分层填色必须是"往水里加一层水色"，不能用等深线的亮色：亮色叠加会把整片海洗成青色。
      const col = d <= 200 ? P.depthShallow : d <= 1000 ? P.depthMid : P.depthDeep;
      ctx.fillStyle = P.alpha(col, a);
      ctx.fill();
      if (d <= 200) { ctx.strokeStyle = P.alpha(P.depthStrong, .20); ctx.lineWidth = 1; ctx.stroke(); }
      // 海图/印刷主题：等深线画成虚线（老海图习惯）
      if (Number(P.depthDash) > 0) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = P.alpha(P.depth, .85);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  // ---------- 陆地（真实海岸线）----------
  _land(ctx) {
    const P = this._pal || chartPalette();
    const w = this.world;
    if (!w || !w.land || w.land.empty) return;
    const rings = w.land.rings;
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, P.alpha(P.landA, .98));
    g.addColorStop(1, P.alpha(P.landB, .98));
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const p = this.worldToScreen({ x: ring[i][0], y: ring[i][1] });
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      // 印刷主题：陆地只用"朱红斜线"表达，不靠灰阶
      const ha = Number(P.hatchAlpha) || 0;
      if (ha > 0) {
        const pat = this._hatchFill(ctx, P, ha);
        if (pat) { ctx.fillStyle = pat; ctx.fill(); }
      }
      // 岸外浅水：宽晕 + 亮海岸线（真实海图的习惯画法）
      ctx.strokeStyle = P.alpha(P.shore, .13); ctx.lineWidth = 8; ctx.stroke();
      ctx.strokeStyle = P.alpha(P.landLine, .55); ctx.lineWidth = 1.2; ctx.stroke();
    }
    ctx.restore();
  }

  // 底部悬浮指挥台会盖住海图下沿，标尺必须让开它
  _dockHeight() {
    if (typeof document === 'undefined' || !document.getElementById) return 0;
    const el = document.getElementById('dock');
    if (!el || !el.getBoundingClientRect) return 0;
    const r = el.getBoundingClientRect();
    if (!r || !r.height || r.height > this.h) return 0;
    return r.height + 24;
  }

  // ---------- 网格 ----------
  // 覆盖层（任务卡/战况条/仪表卡/HUD）会挡住海图，网格标注必须避开它们
  _reservedZones() {
    const zones = [];
    if (typeof document === 'undefined' || !document.getElementById) return zones;
    const cr = this.canvas && this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
    for (const id of ['mission', 'battlebar', 'dock', 'toasts']) {
      const el = document.getElementById(id);
      if (!el || !el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (!r || !r.width || r.width > this.w || r.height > this.h) continue;
      zones.push({ x: r.left - cr.left - 8, y: r.top - cr.top - 8, w: r.width + 16, h: r.height + 16 });
    }
    return zones;
  }
  _inZone(x, y) {
    const z = this.zones;
    if (!z || !z.length) return false;
    for (const r of z) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
    return false;
  }

  _grid(ctx, w, h) {
    const P = this._pal || chartPalette();
    const target = 150 * this.mPerPx;
    const steps = [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
    let grid = steps[steps.length - 1];
    for (const s of steps) if (s >= target) { grid = s; break; }
    this.gridM = grid;
    const tl = this.screenToWorld({ x: 0, y: 0 }), br = this.screenToWorld({ x: w, y: h });
    const x0 = Math.floor(tl.x / grid) * grid, x1 = Math.ceil(br.x / grid) * grid;
    const y0 = Math.floor(br.y / grid) * grid, y1 = Math.ceil(tl.y / grid) * grid;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = this._font(10, "mono");
    ctx.fillStyle = P.alpha(P.gridText, .7);
    let i = 0;
    for (let x = x0; x <= x1; x += grid, i++) {
      const p = this.worldToScreen({ x: x, y: 0 });
      // 网线浓度按主题走 token：纸面需要比夜间更明显的经纬网
      ctx.strokeStyle = i % 5 === 0
        ? P.alpha(P.gridStrong, Number(P.gridAlphaStrong) || .10)
        : P.alpha(P.grid, Number(P.gridAlpha) || .04);
      ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, h); ctx.stroke();
      if ((i % 5 === 0 || grid * this.cam.scale > 78) && p.x > 44 && p.x < w - 48) {
        const ly = 13;
        if (!this._inZone(p.x, ly)) ctx.fillText((x / NMI).toFixed(0) + "nm", p.x + 4, ly);
        else if (!this._inZone(p.x, h - 8)) ctx.fillText((x / NMI).toFixed(0) + "nm", p.x + 4, h - 8);
      }
    }
    i = 0;
    for (let y = y0; y <= y1; y += grid, i++) {
      const p = this.worldToScreen({ x: 0, y: y });
      // 网线浓度按主题走 token：纸面需要比夜间更明显的经纬网
      ctx.strokeStyle = i % 5 === 0
        ? P.alpha(P.gridStrong, Number(P.gridAlphaStrong) || .10)
        : P.alpha(P.grid, Number(P.gridAlpha) || .04);
      ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(w, p.y); ctx.stroke();
      const lx = 6;
      if ((i % 5 === 0 || grid * this.cam.scale > 78) && p.y > 18 && p.y < h - 18 && !this._inZone(lx, p.y)) {
        ctx.fillText((y / NMI).toFixed(0) + "nm", lx, p.y - 4);
      }
    }
    ctx.restore();
  }

  // 目视地平线（4.12√h km）：让玩家理解"看不见的地方"
  _horizonCircle(ctx, state) {
    const P = this._pal || chartPalette();
    const w = this.world;
    if (!w) return;
    const own = w.afloatOf((state && state.side) || "ALLIED");
    if (!own.length) return;
    const s = own[0];
    const R = 4.12 * Math.sqrt((s.data.mastHeight_m || 20) + 15) * 1000;
    const p = this.worldToScreen(s.pos);
    ctx.save();
    ctx.setLineDash([4, 7]);
    ctx.strokeStyle = P.alpha(P.uncertain, .22); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, R * this.cam.scale, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = P.alpha(P.uncertain, .42); ctx.font = "10px monospace";
    ctx.fillText("目视地平线 " + (R / 1000).toFixed(1) + "km", p.x + 6, p.y - R * this.cam.scale - 4);
    ctx.restore();
  }

  // ---------- 烟幕 ----------
  _smoke(ctx, world) {
    const P = this._pal || chartPalette();
    const clouds = (world.env && world.env.smokeClouds) || [];
    for (const c of clouds) {
      const p = this.worldToScreen(c);
      const r = Math.max(8, (c.r || 300) * this.cam.scale);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      const a = clamp((c.density || 0.5) * 0.42, 0, 0.5);
      g.addColorStop(0, P.alpha(P.smoke, a));
      g.addColorStop(1, P.alpha(P.smoke, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
    }
  }

  // ---------- 落水水柱 ----------
  _splashes(ctx, world) {
    const P = this._pal || chartPalette();
    for (const sp of (world.splashes || [])) {
      const age = world.t - (sp.t || 0);
      const life = sp.life || 14;
      if (age > life) continue;
      const k = 1 - age / life;
      const p = this.worldToScreen(sp);
      const base = Math.max(3, (sp.radiusM || 20) * this.cam.scale);
      const r = base * (1 + (1 - k) * 2.2);
      ctx.save();
      ctx.globalAlpha = k * 0.9;
      ctx.strokeStyle = P.alpha(P.splash, .85); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.stroke();
      const g = ctx.createRadialGradient(p.x, p.y - r * 0.4, 0, p.x, p.y, r * 1.5);
      g.addColorStop(0, P.alpha(P.splash, .55));
      g.addColorStop(1, P.alpha(P.splash, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.5, 0, 6.2832); ctx.fill();
      ctx.restore();
    }
  }

  // ---------- 鱼雷（只有可见航迹才画） ----------
  _torpedoes(ctx, world, state) {
    const P = this._pal || chartPalette();
    const mine = (state && state.side) || null;
    for (const t of (world.torpedoes || [])) {
      const p = this.worldToScreen(t);
      const visible = t.wakeVisible || t.side === mine;
      if (!visible) continue;
      const hd = (t.heading || 0) * Math.PI / 180;
      const back = { x: ChartRenderer.pt(t).x - Math.sin(hd) * 260, y: ChartRenderer.pt(t).y - Math.cos(hd) * 260 };
      const pb = this.worldToScreen(back);
      ctx.save();
      ctx.strokeStyle = t.side === mine ? P.alpha(P.ownTrack, .5) : P.alpha(P.enemyTrack, .55);
      ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pb.x, pb.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.side === mine ? P.alpha(P.ownTrack, .9) : P.alpha(P.enemyTrack, .9);
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, 6.2832); ctx.fill();
      ctx.restore();
    }
  }

  // ---------- 飞行中的炮弹（只画己方的曳光） ----------
  // 弹药库殉爆：火球 + 扩张冲击环（按当量决定尺寸，约 2.5 秒衰减）
  addBoom(x, y, energyKg) {
    const e = Math.max(200, energyKg || 1000);
    this.booms.push({ x, y, t: (typeof performance !== 'undefined' ? performance.now() : Date.now()), energyKg: e,
      r: 150 + 400 * Math.cbrt(Math.min(1, e / 60000)) });
    if (this.booms.length > 12) this.booms.shift();
  }
  _booms(ctx) {
    if (!this.booms.length) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const pxPerM = this.cam.scale;
    this.booms = this.booms.filter((b) => now - b.t < 2500);
    for (const b of this.booms) {
      const f = Math.min(1, (now - b.t) / 2500);
      const p = this.worldToScreen({ x: b.x, y: b.y });
      const rr = Math.max(6, b.r * pxPerM * (0.25 + 1.35 * f));
      ctx.save();
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,196,120,' + (0.55 * (1 - f)) + ')';
      ctx.lineWidth = Math.max(1, 3 * (1 - f)); ctx.stroke();
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(4, rr * 0.55));
      g.addColorStop(0, 'rgba(255,255,235,' + (0.9 * (1 - f)) + ')');
      g.addColorStop(0.45, 'rgba(255,170,70,' + (0.55 * (1 - f)) + ')');
      g.addColorStop(1, 'rgba(120,30,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, rr * 0.55), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  _projectiles(ctx, world, state) {
    const P = this._pal || chartPalette();
    const mine = state && state.side;
    if (!mine) return;
    ctx.save();
    for (const pr of (world.projectiles || [])) {
      if (pr.side !== mine) continue;
      const p = this.worldToScreen(pr);
      const hd = Math.atan2(pr.vy || 0, pr.vx || 0);
      const tail = { x: p.x - Math.cos(hd) * 9, y: p.y + Math.sin(hd) * 9 };
      const g = ctx.createLinearGradient(tail.x, tail.y, p.x, p.y);
      g.addColorStop(0, P.alpha(P.fireGlow, 0));
      g.addColorStop(1, P.alpha(P.fireGlow, .95));
      ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- 尾迹 ----------
  _updateTrails(world) {
    for (const s of world.ships) {
      if (!s.isAfloat) continue;
      let arr = this.trails.get(s.id);
      if (!arr) { arr = []; this.trails.set(s.id, arr); }
      const last = arr[arr.length - 1];
      if (!last || Math.hypot(s.pos.x - last.x, s.pos.y - last.y) > 25) {
        arr.push({ x: s.pos.x, y: s.pos.y });
        if (arr.length > 70) arr.shift();
      }
    }
  }
  _trails(ctx, world, state) {
    const P = this._pal || chartPalette();
    const mine = state && state.side;
    for (const s of world.ships) {
      if (!s.isAfloat) continue;
      const own = !mine || s.side === mine;
      const arr = this.trails.get(s.id) || [];
      if (arr.length < 2) continue;
      ctx.save();
      ctx.lineCap = "round";
      for (let i = 1; i < arr.length; i++) {
        const a = this.worldToScreen(arr[i - 1]), b = this.worldToScreen(arr[i]);
        const k = i / arr.length;
        ctx.strokeStyle = own ? P.alpha(P.ownTrack, 0.05 + k * 0.2) : P.alpha(P.enemyTrack, 0.05);
        ctx.lineWidth = 1 + k * 1.6;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------- 舰船 ----------
  _ships(ctx, world, state) {
    this._labels = [];
    const mine = state && state.side;
    for (const s of world.ships) {
      const isMine = !mine || s.side === mine;
      if (!s.isAfloat) {
        // 雾里看花：没见过/不是自己人的沉没位置不该出现在海图上
        if (isMine || this.showAll) this._wreck(ctx, s);
        continue;
      }
      if (!isMine && !this.showAll) continue;   // 非观战：绝不做上帝视角
      this._ship(ctx, s, s.id === this.selectedId, isMine);
    }
  }
  _ship(ctx, s, sel, isMine) {
    const P = this._pal || chartPalette();
    if (isMine === undefined) isMine = true;
    const p = this.worldToScreen(s);
    const sc = this.cam.scale;
    const len = Math.max(14, (s.data.loa_m || 100) * sc);
    const beam = Math.max(5, (s.data.beam_m || 10) * sc);
    const col = sideColor(s.side, P);
    const nat = nationColor(s.nation, P) || col;
    if (this.night) {
      const gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(16, len * 0.9));
      gg.addColorStop(0, P.alpha(P.glare, .16));
      gg.addColorStop(1, P.alpha(P.glare, 0));
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(16, len * 0.9), 0, 6.2832); ctx.fill();
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(s.heading * Math.PI / 180);
    const listK = clamp(Math.abs(s.list || 0) / 60, 0, 1);
    const bw = beam * (1 + listK * 0.25);
    // 舰体
    const hull = new Path2D();
    hull.moveTo(0, -len / 2);
    hull.lineTo(bw * 0.42, -len * 0.34);
    hull.lineTo(bw / 2, -len * 0.12);
    hull.lineTo(bw / 2, len * 0.34);
    hull.lineTo(bw * 0.3, len / 2);
    hull.lineTo(-bw * 0.3, len / 2);
    hull.lineTo(-bw / 2, len * 0.34);
    hull.lineTo(-bw / 2, -len * 0.12);
    hull.lineTo(-bw * 0.42, -len * 0.34);
    hull.closePath();
    if (isMine) {
      const g = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
      g.addColorStop(0, P.alpha(P.nightWash, .45));
      g.addColorStop(0.45, nat);
      g.addColorStop(1, P.alpha(P.glare, .28));
      ctx.shadowColor = P.alpha(P.nightWash, .6); ctx.shadowBlur = 6;
      ctx.fillStyle = g; ctx.fill(hull);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = sel ? P.select : P.alpha(P.nightWash, .85);
      ctx.lineWidth = sel ? 1.8 : 1.1; ctx.stroke(hull);
    } else {
      // 观战视角：敌方画成空心（明确区分"这是全知信息"）
      ctx.shadowColor = P.alpha(P.nightWash, .6); ctx.shadowBlur = 6;
      ctx.fillStyle = P.alpha(P.axis, .16); ctx.fill(hull);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = sel ? P.select : P.alpha(P.axis, .9);
      ctx.lineWidth = sel ? 1.8 : 1.3; ctx.stroke(hull);
    }
    // 甲板中线与上层建筑
    if (len > 22) {
      ctx.strokeStyle = P.alpha(P.glare, .28); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -len * 0.42); ctx.lineTo(0, len * 0.42); ctx.stroke();
      const nTur = Math.min(4, Math.max(1, Math.round(((s.mainBatteries || []).length || 1))));
      ctx.fillStyle = P.alpha(P.glare, .5);
      for (let i = 0; i < nTur; i++) {
        const y = -len * 0.3 + i * (len * 0.6 / Math.max(1, nTur - 1 || 1));
        ctx.beginPath(); ctx.arc(0, y, Math.max(1.2, beam * 0.16), 0, 6.2832); ctx.fill();
      }
    }
    ctx.restore();
    // 艏波
    const hd = s.heading * Math.PI / 180;
    const bx = p.x + Math.sin(hd) * len * 0.5, by = p.y - Math.cos(hd) * len * 0.5;
    const spdK = clamp(s.speed / Math.max(1, s.data.speedMax_kn || 30), 0, 1);
    if (spdK > 0.12 && len > 16) {
      ctx.save();
      ctx.strokeStyle = P.alpha(P.wake, 0.1 + spdK * 0.4);
      ctx.lineWidth = 1.3;
      const spread = len * (0.22 + spdK * 0.3);
      const back = len * (0.55 + spdK * 0.5);
      const a1 = hd + 0.55, a2 = hd - 0.55;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - Math.sin(a1) * back, by + Math.cos(a1) * back);
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - Math.sin(a2) * back, by + Math.cos(a2) * back);
      ctx.stroke();
      ctx.restore();
    }
    // 烟囱烟
    if (s.flags && s.flags.smokeIntensity > 0.06) {
      const sx = p.x - Math.sin(hd) * len * 0.12, sy = p.y + Math.cos(hd) * len * 0.12;
      const drift = (this.world && this.world.env ? (this.world.env.windDirDeg + 180) : 0) * Math.PI / 180;
      const L = 10 + s.flags.smokeIntensity * 34;
      const ex = sx + Math.sin(drift) * L, ey = sy - Math.cos(drift) * L;
      const sg = ctx.createLinearGradient(sx, sy, ex, ey);
      const a0 = clamp(0.16 + s.flags.smokeIntensity * 0.3, 0, 0.5);
      sg.addColorStop(0, P.alpha(P.smoke, a0));
      sg.addColorStop(1, P.alpha(P.smoke, 0));
      ctx.strokeStyle = sg; ctx.lineWidth = 3 + s.flags.smokeIntensity * 7; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    }
    // 火灾
    const fires = s.compartments ? s.compartments.filter((c) => c.fire > 0.05).length : 0;
    if (fires) {
      const fl = 0.5 + 0.5 * Math.sin(this.time * 9);
      const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12 + fires * 3);
      rg.addColorStop(0, P.alpha(P.fire, 0.32 + fl * 0.22));
      rg.addColorStop(1, P.alpha(P.fire, 0));
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(p.x, p.y, 12 + fires * 3, 0, 6.2832); ctx.fill();
    }
    // 探照灯
    if (s.flags && s.flags.searchlight && s.flags.searchlight.on) {
      const a = s.flags.searchlight.bearing * Math.PI / 180;
      const L = Math.min(560, 900 * this.cam.scale + 160);
      const ex = p.x + Math.sin(a) * L, ey = p.y - Math.cos(a) * L;
      const lg = ctx.createLinearGradient(p.x, p.y, ex, ey);
      lg.addColorStop(0, P.alpha(P.light, .34));
      lg.addColorStop(0.7, P.alpha(P.light, .08));
      lg.addColorStop(1, P.alpha(P.light, 0));
      ctx.save();
      ctx.strokeStyle = lg; ctx.lineWidth = 8; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.restore();
    }
    // 选中：角括号 + 脉冲环
    if (sel) {
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 3.4);
      ctx.save();
      ctx.strokeStyle = P.alpha(P.select, 0.45 + pulse * 0.45);
      ctx.lineWidth = 1.6;
      const R = Math.max(20, len * 0.62);
      const tick = R * 0.28;
      for (let q = 0; q < 4; q++) {
        const ang = q * Math.PI / 2 + Math.PI / 4;
        const cx = p.x + Math.cos(ang) * R, cy = p.y + Math.sin(ang) * R;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(ang) * tick, cy - Math.sin(ang) * tick);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang + 1.57) * tick * 0.7, cy + Math.sin(ang + 1.57) * tick * 0.7);
        ctx.stroke();
      }
      ctx.restore();
    }
    // 舰名（带简单防重叠：与已放置标签比较，冲突则上下错开）
    if (len > 14) {
      if (!this._labels) this._labels = [];
      const wantY = p.y - Math.max(17, len * 0.62);
      let ly = wantY;
      for (let tries = 0; tries < 4; tries++) {
        let hit = false;
        for (const l of this._labels) if (Math.abs(l.x - p.x) < 86 && Math.abs(l.y - ly) < 13) { hit = true; break; }
        if (!hit) break;
        ly = wantY - (tries + 1) * 13;
      }
      this._labels.push({ x: p.x, y: ly });
      if (ly !== wantY) {
        ctx.save();
        ctx.strokeStyle = P.alpha(P.ink, .28); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - len * 0.5); ctx.lineTo(p.x, ly + 4); ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.font = this._font(10.5, "sans");
      ctx.fillStyle = sel ? P.ink : P.alpha(P.ink, .88);
      ctx.textAlign = "center";
      ctx.fillText(s.name, p.x, ly);
      if (s.floodedM3 > s.reserveBuoyancyM3 * 0.08 || Math.abs(s.list) > 6) {
        ctx.fillStyle = P.alpha(P.damage, .85);
        ctx.fillText("进水" + Math.round(100 * s.floodedM3 / s.reserveBuoyancyM3) + "% 横倾" + Math.round(s.list) + "°", p.x, p.y + Math.max(20, len * 0.62) + 11);
      }
      ctx.restore();
    }
  }
  _wreck(ctx, s) {
    const P = this._pal || chartPalette();
    const p = this.worldToScreen(s);
    ctx.save();
    ctx.strokeStyle = P.alpha(P.inkFaint, .45); ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = P.alpha(P.inkFaint, .5); ctx.font = "9px monospace";
    ctx.fillText("沉没", p.x + 6, p.y + 3);
    ctx.restore();
  }

  // ---------- 航迹（标准海军符号 + 不确定性） ----------
  _tracks(ctx, tracks, world, state) {
    const P = this._pal || chartPalette();
    this._tlabels = [];
    const own = (world && state && state.side) ? world.afloatOf(state.side) : [];
    const ref = own.length ? own[0] : null;
    for (const t of tracks) {
      const p = this.worldToScreen(t);
      const sel = t.id === this.selectedTrackId;
      const hostile = t.side ? (t.side !== (state && state.side)) : (t.hostile !== false);
      const col = t.side === 'ALLIED' ? P.allied : (t.side === 'AXIS' ? P.axis : (hostile ? P.axis : P.unknown));
      if (this.night) {
        const gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 22);
        gg.addColorStop(0, P.alpha(P.glare, .18));
        gg.addColorStop(1, P.alpha(P.glare, 0));
        ctx.fillStyle = gg;
        ctx.beginPath(); ctx.arc(p.x, p.y, 22, 0, 6.2832); ctx.fill();
      }
      // 不确定性椭圆
      if (this.showUncertainty) {
        const r = Math.max(9, (t.errM || 500) * this.cam.scale);
        const a = clamp(0.07 + (t.confidence || 0.3) * 0.24, 0.06, 0.34);
        ctx.save();
        ctx.globalAlpha = a;
        const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        rg.addColorStop(0, P.uncertain); rg.addColorStop(1, P.alpha(P.uncertain, 0));
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * 0.8, 0, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = P.uncertain; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * 0.8, 0, 0, 6.2832); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      // 航迹符号：长菱形
      const sz = t.classifiedAs === "BB" || t.classifiedAs === "BC" ? 9 : (t.classifiedAs === "CA" || t.classifiedAs === "CL" ? 7.5 : 6);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(((t.courseDeg || 0)) * Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.5, 0); ctx.lineTo(0, sz); ctx.lineTo(-sz * 0.5, 0);
      ctx.closePath();
      ctx.fillStyle = sel ? P.select : col;
      ctx.globalAlpha = 0.9; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = P.alpha(P.nightWash, .7); ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      // 分类字母
      ctx.save();
      ctx.font = "bold 9px monospace";
      ctx.fillStyle = P.seaTop;
      ctx.textAlign = "center";
      ctx.fillText(TYPE_LETTER[t.classifiedAs] || "?", p.x, p.y + 3);
      ctx.restore();
      // 航向/航速矢量
      const crs = (t.courseDeg || 0) * Math.PI / 180;
      const vlen = 16 + Math.min(30, (t.speedKn || 0) * 1.1);
      ctx.save();
      ctx.strokeStyle = P.alpha(col, .55); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(crs) * vlen, p.y - Math.cos(crs) * vlen); ctx.stroke();
      ctx.restore();
      // 与本舰的方位线（这才是海图真正在用的东西）
      if (ref) {
        const rp = this.worldToScreen(ref.pos);
        ctx.save();
        ctx.strokeStyle = P.alpha(col, .16); ctx.setLineDash([1, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(rp.x, rp.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      // 标签
      // 大编队互殴时（萨沃岛、苏里高）几十个航迹同时挂三行标签会糊成一片。
      // 规则：始终画 ID；明细行（距离/方位/置信度条）只在"放大到看得清"或
      // "这条就是我选中的目标"时才画。
      const detail = this.cam.scale >= 0.05 || sel;
      const lw = detail ? 118 : 52;
      ctx.save();
      const lx = p.x + sz + 7;
      let ly = p.y - sz - 2;
      for (let tries = 0; tries < 6; tries++) {
        let hit = false;
        for (const l of this._tlabels) if (Math.abs(l.x - lx) < lw && Math.abs(l.y - ly) < 28) { hit = true; break; }
        if (!hit) break;
        ly += 30;
      }
      this._tlabels.push({ x: lx, y: ly });
      ctx.font = this._font(11, "sans");
      const idTxt = t.id + (detail ? " " + (t.classifiedAs || "?") : "");
      const idW = ctx.measureText(idTxt).width;
      // ID 加一个半透明药丸底：红字直接压在海图/陆地上读不清
      ctx.fillStyle = sel ? P.alpha(P.select, .92) : P.alpha(P.landA, .72);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(lx - 5, ly - 11, idW + 10, 15, 7); else ctx.rect(lx - 5, ly - 11, idW + 10, 15);
      ctx.fill();
      ctx.fillStyle = sel ? P.seaTop : P.alpha(P.ink, .94);
      ctx.fillText(idTxt, lx, ly);
      if (detail) {
        const conf = Math.round((t.confidence || 0) * 100);
        ctx.fillStyle = P.alpha(P.ink, .62);
        ctx.font = this._font(10.5, "sans");
        ctx.fillText((t.rangeM / NMI).toFixed(1) + " nm · " + String(t.bearingDeg).padStart(3, "0") + "°", lx, ly + 14);
        // 置信度条
        ctx.fillStyle = P.alpha(P.ink, .16);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(lx, ly + 19, 52, 3, 2); else ctx.rect(lx, ly + 19, 52, 3);
        ctx.fill();
        ctx.fillStyle = conf > 70 ? P.allied : (conf > 40 ? P.select : P.damage);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(lx, ly + 19, 52 * clamp(conf / 100, 0, 1), 3, 2); else ctx.rect(lx, ly + 19, 52 * clamp(conf / 100, 0, 1), 3);
        ctx.fill();
        ctx.fillStyle = P.alpha(P.ink, .5);
        ctx.fillText("置信 " + conf + "%", lx + 58, ly + 22);
      }
      ctx.restore();
    }
  }

  _selection(ctx, world, tracks) {
    const P = this._pal || chartPalette();
    const s = this.selectedId ? world.ship(this.selectedId) : null;
    if (!s) return;
    const p = this.worldToScreen(s.pos);
    ctx.save();
    ctx.strokeStyle = P.alpha(P.select, .6); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(26, (s.data.loa_m || 100) * this.cam.scale * 0.85), 0, 6.2832); ctx.stroke();
    ctx.restore();
  }

  // ---------- 小地图 ----------
  _minimap(ctx, w, h, world, state) {
    const P = this._pal || chartPalette();
    const MW = 232, MH = 150, pad = 14, foot = 26;
    const x0 = w - MW - pad, y0 = pad;          // 现代布局：小地图挪到右上角，把下方整条留给指挥台
    this.minimapRect = { x: x0, y: y0, w: MW, h: MH };
    let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
    const acc = (p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); };
    for (const s of world.ships) if (s.isAfloat) acc(s.pos);
    for (const t of ((state && state.tracks) || [])) acc(t.pos);
    if (minX > maxX) return;
    const mX = (maxX - minX) * 0.15 + 1500, mY = (maxY - minY) * 0.15 + 1500;
    minX -= mX; maxX += mX; minY -= mY; maxY += mY;
    const sx = MW / Math.max(1, maxX - minX), sy = MH / Math.max(1, maxY - minY);
    const k = Math.min(sx, sy);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const toMap = (p) => ({ x: x0 + MW / 2 + (p.x - cx) * k, y: y0 + MH / 2 - (p.y - cy) * k });
    this._mapToWorld = (mp) => ({ x: cx + (mp.x - (x0 + MW / 2)) / k, y: cy - (mp.y - (y0 + MH / 2)) / k });

    ctx.save();
    // 卡片底（含底部图例行）
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, MW, MH + foot, 12); else ctx.rect(x0, y0, MW, MH + foot);
    ctx.fillStyle = P.alpha(P.landA, .82);
    ctx.fill();
    ctx.strokeStyle = P.alpha(P.ink, .11); ctx.lineWidth = 1; ctx.stroke();

    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, MW, MH, 12); else ctx.rect(x0, y0, MW, MH);
    ctx.clip();
    ctx.fillStyle = P.alpha(P.seaBot, .7); ctx.fillRect(x0, y0, MW, MH);
    // 视口矩形
    const tl = this.screenToWorld({ x: 0, y: 0 }), br = this.screenToWorld({ x: w, y: h });
    const a = toMap(tl), b = toMap(br);
    ctx.strokeStyle = P.alpha(P.select, .75); ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
    const mine = state && state.side;
    for (const s of world.ships) {
      if (!s.isAfloat) continue;
      if (mine && s.side !== mine) continue;
      const p = toMap(s.pos);
      ctx.fillStyle = sideColor(s.side, P);
      ctx.beginPath(); ctx.arc(p.x, p.y, s.id === this.selectedId ? 3.6 : 2.4, 0, 6.2832); ctx.fill();
    }
    for (const t of ((state && state.tracks) || [])) {
      const p = toMap(t.pos);
      ctx.fillStyle = P.alpha(P.axis, .9);
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 6.2832); ctx.fill();
    }
    ctx.restore();

    // 尺幅：直接压在小地图左上角
    const cap = "战术概览 " + ((maxX - minX) / NMI).toFixed(0) + "×" + ((maxY - minY) / NMI).toFixed(0) + " nm";
    ctx.font = this._font(10, "sans");
    const cw = ctx.measureText(cap).width;
    ctx.fillStyle = P.alpha(P.ink, .8);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0 + 8, y0 + 8, cw + 14, 18, 8); else ctx.rect(x0 + 8, y0 + 8, cw + 14, 18);
    ctx.fill();
    ctx.fillStyle = P.alpha(P.seaTop, .92);
    ctx.fillText(cap, x0 + 15, y0 + 21);
    // 图例：卡片底部的独立一行
    ctx.font = this._font(9.5, "sans");
    ctx.fillStyle = P.alpha(P.inkDim, .95);
    ctx.fillText("◆航迹(含误差)　○水柱　⋯鱼雷　◌目视地平线", x0 + 12, y0 + MH + 17);
    ctx.restore();
  }

  _orderFlash(ctx) {
    const P = this._pal || chartPalette();
    if (!this.flash) return;
    const age = this.time - this.flash.t0;
    if (age > 1.6) { this.flash = null; return; }
    const k = 1 - age / 1.6;
    const p = this.worldToScreen(this.flash);
    ctx.save();
    ctx.strokeStyle = P.alpha(P.select, 0.9 * k);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8 + (1 - k) * 26, 0, 6.2832); ctx.stroke();
    if (this.flash.h !== undefined && this.flash.h !== null) {
      const a = this.flash.h * Math.PI / 180;
      ctx.strokeStyle = P.alpha(P.select, 0.75 * k);
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(a) * 90, p.y - Math.cos(a) * 90); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  _scaleBar(ctx, w, h) {
    const P = this._pal || chartPalette();
    const wantPx = 140;
    const nm = (wantPx * this.mPerPx) / NMI;
    const nice = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
    let pick = nice[nice.length - 1];
    for (const n of nice) if (n >= nm) { pick = n; break; }
    const px = (pick * NMI) / this.mPerPx;
    const x = 22, y = h - Math.max(26, (this.dockH || 0) + 30);   // 左下角，且让开底部指挥台
    ctx.save();
    ctx.strokeStyle = P.alpha(P.ink, .72); ctx.lineWidth = 1.4; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
    ctx.moveTo(x + px, y - 5); ctx.lineTo(x + px, y + 5);
    ctx.stroke();
    ctx.font = this._font(11, "sans");
    ctx.fillStyle = P.alpha(P.ink, .9);
    ctx.fillText(pick + " nm", x, y - 12);
    ctx.fillStyle = P.alpha(P.inkDim, .95);
    ctx.font = this._font(10, "sans");
    ctx.fillText("1px ≈ " + (this.mPerPx).toFixed(0) + " m", x + px + 12, y + 4);
    ctx.restore();
  }

  _compass(ctx, w, h) {
    const P = this._pal || chartPalette();
    const cx = w - 52, cy = h - 52, R = 26;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R + 9, 0, 6.2832);
    ctx.fillStyle = P.alpha(P.landA, .72); ctx.fill();
    ctx.strokeStyle = P.alpha(P.ink, .1); ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = P.alpha(P.ink, .14); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.stroke();
    // 北针
    ctx.fillStyle = P.select;
    ctx.beginPath(); ctx.moveTo(cx, cy - R * 0.82); ctx.lineTo(cx - 4.5, cy + 4); ctx.lineTo(cx + 4.5, cy + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = P.alpha(P.ink, .28);
    ctx.beginPath(); ctx.moveTo(cx, cy + R * 0.82); ctx.lineTo(cx - 4.5, cy + 4); ctx.lineTo(cx + 4.5, cy + 4); ctx.closePath(); ctx.fill();
    ctx.font = this._font(10, "sans"); ctx.textAlign = "center";
    ctx.fillStyle = P.alpha(P.ink, .85);
    ctx.fillText("N", cx, cy - R - 7);
    ctx.fillStyle = P.alpha(P.inkDim, .95);
    ctx.font = this._font(9.5, "sans");
    ctx.fillText("E", cx + R + 8, cy + 3.5); ctx.fillText("W", cx - R - 8, cy + 3.5); ctx.fillText("S", cx, cy + R + 12);
    ctx.restore();
  }

  // 拖拽设航向：从选中舰拉出一条虚线 + 角度环
  _steerPreview(ctx) {
    const P = this._pal || chartPalette();
    const st = this.steer;
    if (!st) return;
    const from = this.worldToScreen(st.from);
    const a = st.heading * Math.PI / 180;
    const L = 150;
    const ex = from.x + Math.sin(a) * L, ey = from.y - Math.cos(a) * L;
    ctx.save();
    ctx.strokeStyle = P.alpha(P.select, .95); ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = P.select;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.sin(a - 0.32) * 11, ey + Math.cos(a - 0.32) * 11);
    ctx.lineTo(ex - Math.sin(a + 0.32) * 11, ey + Math.cos(a + 0.32) * 11); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = P.alpha(P.select, .35); ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.arc(from.x, from.y, L, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  _hover(ctx, state) {
    const P = this._pal || chartPalette();
    if (!this.hover || !this.world) return;
    const p = this.hover;
    const wpt = this.screenToWorld(p);
    const own = (this.world && state && state.side) ? this.world.afloatOf(state.side) : [];
    const ref = own.length ? own[0] : null;
    // 鼠标下的舰船 / 航迹 → 富信息卡片
    const sHit = this.pick(p);
    const tHit = this.pickTrack(p, (state && state.tracks) || []);
    if (sHit || tHit) {
      const lines = [];
      if (sHit) {
        const s = sHit.obj;
        lines.push([s.name + '  ' + s.type + (s.isAfloat ? '' : '（已沉没）'), P.select]);
        if (s.isAfloat) {
          lines.push(['航向 ' + String(Math.round(s.heading)).padStart(3, '0') + '°  航速 ' + s.speed.toFixed(1) + 'kn  舵 ' + Math.round(s.rudder) + '°', P.ink]);
          lines.push(['进水 ' + Math.round(s.floodedM3) + 'm³ (' + (100 * s.floodedM3 / s.reserveBuoyancyM3).toFixed(0) + '%)  横倾 ' + s.list.toFixed(1) + '°  火灾 ' + s.compartments.filter((c) => c.fire > 0.05).length, s.floodedM3 > s.reserveBuoyancyM3 * 0.15 ? P.damage : P.inkDim]);
          lines.push(['舰员 ' + Math.round(100 * s.crew / s.crew0) + '%  主炮 ' + s.mainBatteries.filter((b) => !b.destroyed).length + '/' + s.mainBatteries.length + ' 座可用', P.inkDim]);
        }
      } else {
        lines.push([tHit.id + '  ' + (tHit.classifiedAs || '?'), P.axis]);
        lines.push(['距离 ' + (tHit.rangeM / NMI).toFixed(2) + 'nm  方位 ' + String(tHit.bearingDeg).padStart(3, '0') + '°', P.alpha(P.axis, .85)]);
        lines.push(['推断航向 ' + tHit.courseDeg + '°  航速 ' + (tHit.speedKn > 0.5 ? tHit.speedKn + 'kn' : '未知'), P.alpha(P.axis, .85)]);
        lines.push(['置信 ' + Math.round(tHit.confidence * 100) + '%  误差 ±' + tHit.errM + 'm  更新 ' + Math.round(tHit.ageS) + 's前', P.alpha(P.axis, .6)]);
        if (this.world) {
          const t = this.world.tracks.byId(tHit.id);
          if (t) lines.push(['来源 ' + (t.sources || []).join('+') + (t.courseValid ? '  解算已收敛' : '  解算未收敛'), P.inkDim]);
        }
      }
      ctx.save();
      ctx.font = this._font(12, 'sans');
      const bw = Math.max(...lines.map((l) => ctx.measureText(l[0]).width)) + 22;
      const bh = lines.length * 17 + 14;
      let bx = p.x + 16, by = p.y + 16;
      if (bx + bw > this.w - 8) bx = p.x - bw - 16;
      if (by + bh > this.h - 8) by = p.y - bh - 16;
      ctx.fillStyle = P.alpha(P.landA, .95);
      ctx.strokeStyle = P.alpha(P.ink, .13);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 11); else ctx.rect(bx, by, bw, bh);
      ctx.fill(); ctx.stroke();
      lines.forEach((l, i) => { ctx.fillStyle = l[1]; ctx.fillText(l[0], bx + 11, by + 21 + i * 17); });
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.strokeStyle = P.alpha(P.select, .5); ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x - 9, p.y); ctx.lineTo(p.x + 9, p.y);
    ctx.moveTo(p.x, p.y - 9); ctx.lineTo(p.x, p.y + 9);
    ctx.stroke();
    const lines = [];
    const ll = this.world.geo ? this.world.geo.toLatLon(wpt.x, wpt.y) : null;
    if (ll) lines.push(ll.lat.toFixed(3) + "° " + ll.lon.toFixed(3) + "°");
    if (ref) {
      const rng = dist2d(ref.pos, wpt), brg = normDeg(bearing2d(ref.pos, wpt));
      lines.push("距离 " + (rng / NMI).toFixed(2) + "nm  方位 " + String(Math.round(brg)).padStart(3, "0") + "°");
    if (this.world && this.world.depth && !this.world.depth.empty) {
      const d = this.world.depth.depthAt(wpt.x, wpt.y);
      lines.push("水深 " + d.toFixed(0) + " m" + (d < 30 ? "（浅水）" : ""));
    }
    }
    if (!lines.length) { ctx.restore(); return; }
    ctx.font = this._font(11.5, "sans");
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const bh = lines.length * 16 + 12;
    let bx = p.x + 14, by = p.y + 14;
    if (bx + bw > this.w - 6) bx = p.x - bw - 14;
    if (by + bh > this.h - 6) by = p.y - bh - 14;
    ctx.fillStyle = P.alpha(P.landA, .92);
    ctx.strokeStyle = P.alpha(P.ink, .12);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 10); else ctx.rect(bx, by, bw, bh);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = P.alpha(P.ink, .95);
    lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 19 + i * 16));
    ctx.restore();
  }

  // ---------- 拾取 ----------
  // allowIds：只允许点选"我方已知的舰"（非观战时绝不让人隔着雾点敌方舰）
  pick(screen, allowIds) {
    const world = this.world;
    if (!world) return null;
    let best = null, bd = 26;
    for (const s of world.ships) {
      if (!s.isAfloat) continue;
      if (allowIds && !allowIds[s.id]) continue;
      const p = this.worldToScreen(s.pos);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d < bd) { bd = d; best = { kind: "ship", id: s.id, obj: s }; }
    }
    return best;
  }
  pickTrack(screen, tracks) {
    let best = null, bd = 22;
    for (const t of tracks || []) {
      const p = this.worldToScreen(t.pos);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
}
