// Ship：单舰状态容器。这里是所有系统的共享事实来源。
// 真实感要点：分舱室浮力/进水/火灾、子系统降级、稳性(list/trim/GM)、指挥仪-炮塔-弹药链。
import { clamp, normDeg, normDeg180, nm2m, mps2kn, kn2mps, destPoint } from '../core/util.js';
import { CompartmentKind, CrewQuality } from './types.js';

let SHIP_SEQ = 0;

export class Ship {
  constructor(spec, data, opts = {}) {
    this.uid = ++SHIP_SEQ;
    this.id = spec.id || (data.id + '_' + this.uid);
    this.name = spec.name || data.nameZh || data.nameEn || this.id;
    this.nameEn = data.nameEn || '';
    this.side = spec.side;
    this.type = data.type || 'DD';
    this.nation = data.nation || '';
    this.data = data;
    this.className = data.class || data.nameEn || '';
    this.year = spec.year || data.year || 1942;
    this.role = spec.role || 'line'; // line | flagship | screen

    // ---- 运动学 ----
    this.pos = { x: spec.x || 0, y: spec.y || 0 };
    this.heading = normDeg(spec.heading !== undefined ? spec.heading : 0);
    this.speed = spec.speed !== undefined ? spec.speed : 0; // kn
    this.rudder = 0; // deg, + 右
    this.turnRate = 0; // deg/s
    // 火力命令分主/副炮两套通道：主炮用 firing/targetTrackId/fireAmmo，
    // 副炮用 secFiring/secTargetTrackId/secAmmo。两边独立节流与目标，
    // 才能同时"主炮对主力舰、副炮补刀驱逐舰"（旧实现只有单通道，副炮永远闲置）。
    this.commanded = {
      heading: this.heading, speed: this.speed, rudder: null,
      firing: false, targetTrackId: null,
      secFiring: false, secTargetTrackId: null, secAmmo: 'HE', secSalvoes: Infinity,
    };
    this.engineOrder = { kn: this.speed, telegraph: 'STOP' };

    // ---- 姿态 ----
    this.roll = 0; this.pitch = 0; this.list = 0; this.trim = 0;
    this.draftM = data.draft_m || 6;
    this.draftOrigM = this.draftM;
    this.hullDepthM = (data.draft_m || 6) * 1.75;

    // ---- 乘员 ----
    this.crew0 = data.crew || 250;
    this.crew = this.crew0;
    this.crewQuality = spec.crewQuality !== undefined ? spec.crewQuality : CrewQuality.AVERAGE;
    this.morale = 1.0;

    // ---- 稳性 ----
    this.gm0M = data.gm_m || this.estimateGM();
    this.displacement_t = data.displacementFull_t || data.displacementStd_t || 2000;

    this._buildCompartments();
    this._buildBatteries();
    this._buildTorpedoes();
    this._buildSubsystems();
    this._buildSensors();

    // ---- 状态标志 ----
    this.isAfloat = true;
    this.sinking = false;
    this.capsized = false;
    this.sinkTimer = 0;
    this.sunkAt = null;
    this.speedCapKn = data.speedMax_kn || 20;
    this.flags = {
      smokeOn: false, smokeIntensity: 0, searchlight: { on: false, bearing: this.heading, health: 1 },
      radarOn: true, sonarOn: false, starshellArmed: false, engaged: false, illuminated: 0,
      onFire: 0, silent: false,
    };
    // hitsTaken：只统计真正的命中（被命中）；nearMisses：舷外近失弹，单独计数，不并入命中（AAR 口径）
    this.stats = { shotsFired: 0, hits: 0, hitsTaken: 0, nearMisses: 0, torpedoesFired: 0, torpHits: 0, straddles: 0, floodingM3: 0, firesOut: 0, kills: 0 };
    this.lastSpot = null;      // 最近一次弹着观测
    this.ladder = null;        // 校射梯次状态
    this.formationStation = spec.formationStation || null;
  }

  estimateGM() {
    const b = this.data.beam_m || 10, d = this.data.draft_m || 4, cb = this.data.blockCoef || 0.55;
    // GM ≈ (B^2 / (12*d)) * (Cw^2/Cb) 的经验近似，再加干舷影响
    return clamp((b * b) / (12 * d) * (0.75 / cb) * 0.35, 0.4, 5.5);
  }

  _buildCompartments() {
    const L = this.data.loa_m || 100;
    const n = clamp(Math.round(L / 11), 8, 32);
    const beam = this.data.beam_m || 10;
    const disp = this.displacement_t || 2000;
    this.compartments = [];
    // 舯部更丰满的横剖面分布
    let wsum = 0; const w = [];
    for (let i = 0; i < n; i++) {
      const xf = (i + 0.5) / n;
      const s = Math.sin(Math.PI * clamp(xf, 0, 1));
      const wi = 0.55 + 0.75 * Math.pow(s, 0.7);
      w.push(wi); wsum += wi;
    }
    const armor = this.data.armor || {};
    for (let i = 0; i < n; i++) {
      const xf = (i + 0.5) / n;
      const vol = (disp / 1.025) * (w[i] / wsum); // m^3 排水体积
      const beltBand = Math.abs(xf - 0.5) <= (armor.beltLengthFrac || 0.45) / 2;
      let kind = CompartmentKind.CREW;
      if (xf < 0.10) kind = CompartmentKind.BOW;
      else if (xf > 0.94) kind = CompartmentKind.STERN;
      else if (xf >= 0.33 && xf <= 0.40) kind = CompartmentKind.MAGAZINE;   // 前弹药库
      else if (xf > 0.40 && xf <= 0.56) kind = CompartmentKind.BOILER;
      else if (xf > 0.56 && xf <= 0.70) kind = CompartmentKind.MACHINERY;
      else if (xf > 0.70 && xf <= 0.76) kind = CompartmentKind.MAGAZINE;   // 后弹药库
      else if (xf > 0.90 && xf <= 0.94) kind = CompartmentKind.STEERING;
      this.compartments.push({
        i, x_frac: xf, length_m: L / n, volume_m3: vol,
        flood_m3: 0, integrity: 1, fire: 0, kind,
        belt_mm: beltBand ? (armor.belt_mm || 0) : Math.min(armor.belt_mm || 0, 25),
        deck_mm: xf > 0.10 && xf < 0.94 ? (armor.deck_mm || 0) : Math.min(armor.deck_mm || 0, 20),
        isMagazine: kind === CompartmentKind.MAGAZINE,
        isMachinery: kind === CompartmentKind.MACHINERY || kind === CompartmentKind.BOILER,
        isSteering: kind === CompartmentKind.STEERING,
        isBridge: false, crewHere: Math.round(this.crew0 / n), breachedAt: null, dcAssigned: 0,
      });
    }
    // 桥楼：大约 45% 处上层建筑
    this.bridgeCompartmentIndex = Math.floor(n * 0.45);
  }

  _buildBatteries() {
    this.batteries = [];
    const guns = this.data.guns || [];
    let idx = 0;
    for (const g of guns) {
      const count = g.count || 1;
      for (let c = 0; c < count; c++) {
        const label = (g.mountLabel || 'M') + (count > 1 ? (c + 1) : '');
        const isMain = g.role === 'main';
        this.batteries.push({
          id: 'bat' + (idx++), data: g, label, role: g.role || 'secondary',
          gunsPerMount: g.gunsPerMount || 1,
          train: normDeg(this.heading + (isMain && c % 2 === 0 ? 0 : 0)),
          elev: (g.elevMin_deg || 0) + 2,
          targetTrain: null, targetElev: null,
          health: 1, jammed: false, destroyed: false, crewLoss: 0,
          ammo: Object.assign({ AP: isMain ? 300 : 100, HE: isMain ? 150 : 400, STAR: 20, ILLUM: 10 }, g.ammo || {}),
          loaded: (g.gunsPerMount || 1),            // 已装填炮数
          cycleTimer: 0, roundsFired: 0,
          wear: 0,                                  // 0..1 膛线磨损（影响初速）
          trainspeed: g.traverseRate_deg_s || 3,
          elevspeed: g.elevRate_deg_s || 8,
          directed: null,                           // 由哪个指挥仪控制
          lastFireT: -999,
          flashProtection: g.flashProtection !== false,
          magazineFlooded: false, magazineOnFire: false,
        });
      }
    }
    // 主炮交给第一个有火控计算机的指挥仪
    this.mainBatteries = this.batteries.filter((b) => b.role === 'main');
    this.secondaryBatteries = this.batteries.filter((b) => b.role !== 'main');
  }

  _buildTorpedoes() {
    this.torpedoMounts = [];
    const ts = this.data.torpedoes || [];
    ts.forEach((t, i) => {
      this.torpedoMounts.push({
        id: 'torp' + i, data: t, label: t.mountLabel || ('鱼雷发射管' + (i + 1)),
        offsetDeg: (i === 0 ? 90 : -90),   // 相对舰艏的舷侧偏角：打哪一舷由它决定
        tubes: t.tubes || 4, tubesLoaded: t.tubes || 4, reloads: t.reloads || 0,
        train: normDeg(this.heading + (i === 0 ? 90 : -90)), targetTrain: null,
        health: 1, destroyed: false, reloadTimer: 0, reloadTimeS: 60 / (this.crewQuality || 0.85),
        launched: 0, spreadFired: 0,
      });
    });
  }

  _buildSubsystems() {
    this.subsystems = [];
    const add = (kind, name, hp = 1, extra = {}) => { this.subsystems.push(Object.assign({ kind, name, health: hp, destroyed: false }, extra)); return this.subsystems[this.subsystems.length - 1]; };
    // 动力：按功率拆成 N 组
    const nBoiler = this.type === 'DD' ? 3 : this.type === 'CV' ? 8 : 6;
    for (let i = 0; i < nBoiler; i++) add('BOILER', '锅炉 #' + (i + 1), 1, { powerFrac: 1 / nBoiler });
    const nShaft = this.type === 'DD' ? 2 : 4;
    for (let i = 0; i < nShaft; i++) add('SHAFT', '主轴 #' + (i + 1), 1, { powerFrac: 1 / nShaft });
    add('STEERING_GEAR', '舵机', 1, { jamAngle: null });
    add('ELECTRICAL', '发电机与配电', 1, { capacityFrac: 1 });
    add('PUMPS', '排水泵组', 1, { capacity_m3_min: Math.max(20, Math.round((this.crew0 || 250) / 6)) });
    add('DC', '损管队', 1, { parties: clamp(Math.round((this.data.crew || 250) / 90), 1, 12), deployedTo: null });
    add('MAGAZINE_SPRINKLER', '弹药库注水与消防', 1, {});
    // 射击指挥仪
    this.directors = [];
    const dirs = (this.data.sensors && this.data.sensors.directors) || [];
    if (dirs.length === 0) dirs.push({ id: 'dir0', nameZh: '主射击指挥仪', hasFCComputer: true, stabilized: true, channels: 1 });
    dirs.forEach((d, i) => {
      this.directors.push({
        id: 'dir' + i, data: d, label: d.nameZh || ('射击指挥仪 ' + (i + 1)),
        health: 1, destroyed: false, hasFCComputer: d.hasFCComputer !== false,
        stabilized: d.stabilized !== false, channels: d.channels || 1,
        trackingTrackId: null, solution: null, lastUpdateT: -999, ladder: null,
        operators: Math.round(6 * this.crewQuality),
      });
    });
  }

  _buildSensors() {
    const S = this.data.sensors || {};
    this.sensors = [];
    (S.radar || []).forEach((r, i) => this.sensors.push({
      id: 'radar' + i, srcKind: 'RADAR', data: r, label: r.nameZh || r.id || ('雷达' + (i + 1)),
      health: 1, destroyed: false, on: true, targetId: null, jammed: 0, searchSectorDeg: 360, lastDetectT: -999,
    }));
    (S.sonar || []).forEach((s, i) => this.sensors.push({
      id: 'sonar' + i, srcKind: 'SONAR', data: s, label: s.nameZh || ('声呐' + (i + 1)),
      health: 1, destroyed: false, on: false, targetId: null, lastDetectT: -999,
    }));
    (S.hydro || []).forEach((s, i) => this.sensors.push({
      id: 'hydro' + i, srcKind: 'HYDRO', data: s, label: '水听器', health: 1, destroyed: false, on: true, targetId: null,
    }));
    this.rangefinders = ((S.rangefinders) || []).map((rf, i) => ({
      id: 'rf' + i, base_m: rf.base_m || 4, type: rf.type || 'coincidence', mount: rf.mount || 'director',
      health: 1, destroyed: false,
    }));
    if (this.rangefinders.length === 0) this.rangefinders.push({ id: 'rf0', base_m: 3, type: 'coincidence', mount: 'director', health: 1, destroyed: false });
  }

  // ---------- 派生量 ----------
  get floodedM3() { let s = 0; for (const c of this.compartments) s += c.flood_m3; return s; }
  // 储备浮力 = 水线以上可灌满的船体体积。旧式 (disp/1.025)*1.35 把整个船体体积当成储备浮力，
  // 而舱室体积之和恰好等于排水体积 → total > 0.95*reserve 永远不成立（灌满也沉不了）。
  // 按船体几何：总船体体积 ≈ 排水体积 × (hullDepth/draft)，故水线以上 ≈ 排水体积 × (hullDepth/draft − 1)。
  get reserveBuoyancyM3() {
    const dispVol = (this.displacement_t || 2000) / 1.025;
    const above = Math.max(0.3, this.hullDepthM / Math.max(0.5, this.draftOrigM) - 1);
    return dispVol * above;
  }
  get freeboardM() { return Math.max(0, this.hullDepthM - this.draftM); }
  get activeBoilers() { return this.subsystems.filter((s) => s.kind === 'BOILER' && !s.destroyed).length; }
  get activeShafts() { return this.subsystems.filter((s) => s.kind === 'SHAFT' && !s.destroyed).length; }
  get electricalFrac() { const e = this.subsystems.find((s) => s.kind === 'ELECTRICAL'); return e ? e.health : 0; }
  get steeringOK() { const s = this.subsystems.find((x) => x.kind === 'STEERING_GEAR'); return !!(s && !s.destroyed); }
  get dcParties() { const d = this.subsystems.find((x) => x.kind === 'DC'); return d ? d.parties : 0; }
  get pumpCapacity() { const p = this.subsystems.find((x) => x.kind === 'PUMPS'); return p ? p.capacity_m3_min * p.health : 0; }
  get mainBatteryOperational() { const m = this.mainBatteries || []; return m.filter((b) => !b.destroyed && b.health > 0.15 && b.ammo.AP + b.ammo.HE > 0); }
  get fireControlOperational() { return this.directors.filter((d) => !d.destroyed).length > 0; }
  get silhouetteHeightM() { return (this.data.mastHeight_m || 20); }
  get silhouetteAreaM2() { return (this.data.loa_m || 100) * (this.data.beam_m || 10) * 0.55 + (this.data.mastHeight_m || 20) * 0.0; }

  recomputeStability(rng) {
    if (!this.isAfloat) return;
    const disp = this.displacement_t || 2000;
    const beam = this.data.beam_m || 10;
    const loa = this.data.loa_m || 100;
    let fwd = 0, total = 0, asymM3 = 0;
    for (const c of this.compartments) {
      if (c.flood_m3 <= 0) continue;
      total += c.flood_m3;
      fwd += c.flood_m3 * (c.x_frac - 0.5) * loa;          // 纵倾力矩（+ 前）
      // 只有"偏在一侧"的进水体积才产生横倾力矩；贯通全宽的舱室进水只损失浮力，不产生横倾
      const sb = Math.abs(c.sideBias || 0);
      if (sb > 0) asymM3 += c.flood_m3 * Math.min(1, sb);
    }
    // 自由液面效应：大量进水显著折减稳性——这才是翻船的主因，而不是"力臂=半个舰宽"
    const floodFrac = clamp(total / Math.max(1, this.reserveBuoyancyM3), 0, 1.4);
    const freeSurface = clamp(0.28 * floodFrac, 0, 0.75);
    const gm = Math.max(0, this.gm0M * (1 - freeSurface) * clamp(1 - this.freeboardLoss, 0.35, 1));
    this.effectiveGMm = gm;
    // 横倾：tan(list) = 力矩 / (Δ · GM)；等效力臂取 0.12×舰宽（舷侧舱室量级）
    const listTorque = asymM3 * beam * 0.12;
    const listRad = Math.atan2(listTorque, Math.max(1e-3, disp * Math.max(0.15, gm)));
    const targetList = clamp(listRad * 57.2958, -85, 85);
    this.list = clamp(this.list * 0.65 + targetList * 0.35, -85, 85);
    const trimM = fwd / Math.max(1, disp);
    this.trim = clamp(this.trim * 0.7 + (trimM / loa) * 57.2958 * 0.3, -20, 20);
    // 水线面面积由排水量/吃水反推（A_wp ≈ ∇/T），比经验式 0.75·L·B 更贴近本模型的船体
    const waterplaneM2 = Math.max(1, ((this.displacement_t || 2000) / 1.025) / Math.max(0.5, this.draftOrigM));
    this.draftM = this.draftOrigM + (total / 1.025) / waterplaneM2;
    // 沉没：储备浮力耗尽或干舷消失
    if (this.draftM >= this.hullDepthM * 0.97 && !this.capsized) this.sinking = true;
    if (total > this.reserveBuoyancyM3 * 0.95) this.sinking = true;
    // 倾覆：稳性丧失（GM→0）且横倾持续，或横倾极端
    if (!this.capsized) {
      const unstable = gm < 0.35 && Math.abs(this.list) > 28;
      if (unstable || Math.abs(this.list) > 74) {
        this.capsized = true; this.sinking = true;
        return { event: 'ship.capsize' };
      }
    }
    return null;
  }
  get freeboardLoss() { return clamp((this.draftM - this.draftOrigM) / Math.max(1, this.hullDepthM - this.draftOrigM), 0, 0.95); }

  damageSubsystem(kind, index, amount) {
    const list = this.subsystems.filter((s) => s.kind === kind);
    const s = list[index]; if (!s) return null;
    s.health = clamp(s.health - amount, 0, 1);
    if (s.health <= 0.05) { s.destroyed = true; s.health = 0; }
    return s;
  }

  compartmentAt(x_frac) {
    let best = this.compartments[0], bd = 9e9;
    for (const c of this.compartments) { const d = Math.abs(c.x_frac - x_frac); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  // ---------- 命令 ----------
  applyOrder(cmd) {
    const p = cmd.params || {};
    switch (cmd.kind) {
      // 契约防护：命令参数必须是有限数。NaN/Infinity 一旦进入 commanded.heading，会经
      // 自动操舵（err = normDeg180(commanded.heading - heading)）污染 rudder/turnRate/heading/pos，
      // 再由编队形心（centroid）扩散到全队，一 tick 内整支舰队坐标变 NaN。这里直接拒收非法命令。
      case 'SET_COURSE': {
        if (!Number.isFinite(p.heading)) return false;
        this.commanded.heading = normDeg(p.heading); this.commanded.rudder = null; return true;
      }
      case 'SET_SPEED': {
        if (!Number.isFinite(p.kn)) return false;
        this.commanded.speed = clamp(p.kn, 0, this.data.speedMax_kn || 30); this.engineOrder.kn = this.commanded.speed; return true;
      }
      case 'SET_RUDDER': {
        if (!Number.isFinite(p.deg)) return false;
        this.commanded.rudder = clamp(p.deg, -(this.data.rudderAngleMax_deg || 35), (this.data.rudderAngleMax_deg || 35)); return true;
      }
      case 'FIRE': {
        // battery='secondary' 走副炮通道，不覆盖主炮的射击状态
        if (p.battery === 'secondary') {
          this.commanded.secFiring = true;
          this.commanded.secTargetTrackId = p.trackId || this.commanded.secTargetTrackId;
          this.commanded.secAmmo = p.ammo || 'HE';
          this.commanded.secSalvoes = p.salvoes === undefined ? Infinity : p.salvoes;
        } else {
          this.commanded.firing = true;
          this.commanded.targetTrackId = p.trackId || this.commanded.targetTrackId;
          this.commanded.fireAmmo = p.ammo || 'AP';
          this.commanded.salvoes = p.salvoes === undefined ? Infinity : p.salvoes;
          this.commanded.fireBattery = p.battery || 'main';
        }
        return true;
      }
      case 'CEASE_FIRE': this.commanded.firing = false; this.commanded.secFiring = false; return true;
      case 'SMOKE': this.flags.smokeOn = !!p.on; return true;
      case 'SEARCHLIGHT': this.flags.searchlight.on = !!p.on; if (p.bearing !== undefined) this.flags.searchlight.bearing = normDeg(p.bearing); return true;
      case 'RADAR': for (const s of this.sensors) if (s.srcKind === 'RADAR') s.on = !!p.on; this.flags.radarOn = !!p.on; return true;
      case 'SONAR': for (const s of this.sensors) if (s.srcKind === 'SONAR') s.on = !!p.on; return true;
      case 'STAR_SHELL': this.flags.starshellArmed = true; return true;
      case 'DC_PRIORITY': this.dcPriority = p.mode || 'flooding'; return true;
      case 'WITHDRAW': this.commanded.withdraw = true; return true;
      default: return false;
    }
  }

  status() {
    return {
      id: this.id, name: this.name, side: this.side, type: this.type, class: this.className,
      pos: { x: Math.round(this.pos.x), y: Math.round(this.pos.y) },
      heading: Math.round(this.heading), speed: +this.speed.toFixed(1), rudder: Math.round(this.rudder),
      list: +this.list.toFixed(1), trim: +this.trim.toFixed(1), draft: +this.draftM.toFixed(2),
      isAfloat: this.isAfloat, sinking: this.sinking, capsized: this.capsized,
      floodedM3: Math.round(this.floodedM3), floodedPct: +(100 * this.floodedM3 / this.reserveBuoyancyM3).toFixed(1),
      fires: this.compartments.filter((c) => c.fire > 0.05).length,
      crew: Math.round(this.crew), crewPct: +(this.crew / this.crew0).toFixed(2),
      batteries: this.batteries.map((b) => ({ id: b.id, label: b.label, role: b.role, destroyed: b.destroyed, health: +b.health.toFixed(2), ammo: b.ammo })),
      subsystems: this.subsystems.map((s) => ({ kind: s.kind, name: s.name, health: +s.health.toFixed(2), destroyed: s.destroyed })),
      directors: this.directors.map((d) => ({ id: d.id, label: d.label, destroyed: d.destroyed, health: +d.health.toFixed(2), target: d.trackingTrackId })),
      sensors: this.sensors.map((s) => ({ id: s.id, label: s.label, kind: s.srcKind, on: s.on, destroyed: s.destroyed, health: +s.health.toFixed(2) })),
      speedCapKn: +this.speedCapKn.toFixed(1),
    };
  }
}
