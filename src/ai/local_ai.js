// 【T6 所有者】本地规则 AI = 无外部智能体时的兜底指挥官，也是真实感的基准。
//
// ── 战术条令依据（1942 年战场实态） ──────────────────────────────────────────
// * 目标价值排序与火力分配：按舰种价值 × 威胁 × 命中概率打分，主力舰集火同一高价值目标
//   （日军「集中射撃」、美军「concentration of fire」都是 1942 年教范要求），驱逐舰另按
//   近距离威胁（对方 DD/CL）分配火力；弹药经济不许把主炮弹药浪费在射程外或概率极低的射击。
// * 抢占 T 字位（crossing the T）：我方航向取敌纵队航向 ±90°，以横阵对敌纵列，使全舷火力
//   可同时射击而敌方仅能以艏炮还击。这是 1916 年以来战列线交战的核心机动。
// * 免疫区（immunity zone）：以敌主炮口径估计的穿深曲线与本舰舷侧/甲板装甲求交，得到
//   「舷侧免疫下界 rBelt」与「甲板免疫上界 rDeck」；条令要求把交战距离保持在 [rBelt,rDeck]。
//   若 rBelt>rDeck（本舰对该敌无免疫区，如 1942 年各国新锐战列舰），则退化为远距交战并
//   优先烟幕/脱离。见 immuneZoneVs()。
// * 阵型与屏护：驱逐舰在威胁轴方向前出 3~4.5km，以方位角 0°±35°±70° 的扇形阵位屏护
//   主力舰（日军「警戒幕」/美军 screen station），并随威胁轴转向。
// * 烟幕掩护撤退：受伤或处于劣势时转向背离敌方并施放烟幕；烟幕也是驱逐舰雷击突击后
//   脱离的标准手段（日军水雷战队 1942 年多次使用）。
// * 雷击突击：驱逐舰/轻巡在 1000~16000m、目标舷角 60~120°（横越）时占位齐射，扇面宽度按
//   航迹方位误差与目标长度换算（覆盖目标可能位置），发射后转向脱离并施烟；保留后续管次。
//   舷角 90° 投影全长、命中概率最高（见 torpedo.js 命中几何），故要求在 60~120° 窗口开火。
// * 受伤舰退出：进水/火灾/横倾/失速/主炮损失加权成损伤分，超过阈值即 WITHDRAW+烟幕。
// * 损管优先级：弹药库受威胁 > 进水速率超过排水能力 > 火灾蔓延 > 机动性（能跑才有活路）。
//   B1：按主要损伤类型给出 flooding/fire/magazine/mobility，同优先级不重发（见 dcMode）。
// * B1 协同雷击：同一目标由 ≥2 舰编组齐射，各舰按目标航向/航速解提前角，扇面按航迹
//   误差裁开后互不重叠（见 TORPEDO_DOCTRINE / pickFanGroup）；单舰对同一目标只打一次。
// * B1 受损脱离：进水/储备浮力 ≥5%、航速上限 <72%、主炮损失 ≥2/3、横倾 ≥15° 任一达阈
//   即退出战列线、施烟、向远离敌方向脱离，并派就近僚舰到朝敌一侧 2.2km 屏护（见 DAMAGE_DOCTRINE）。
// * 避雷机动：1s 反应回路，一旦目视发现鱼雷航迹（航迹可见性差异极大，见 torpedo.js），
//   立即转向与鱼雷航向平行（comb the wakes）并加到全速，使艏艉线与雷迹平行、投影只有舰宽。
// * 夜间/低能见度保守机动：减速、收紧队形、不主动远距开火（炮口闪光暴露阵位），
//   搜索探照灯/照明弹只在近距离使用。
// * 指挥延迟：所有命令都经 world.issueCommand（side.orderDelay_s 生效），AI 不绕过指挥链。
//
// 硬约束：只用 world.rng 的随机数（本模块实际不掷随机数）；不发 DOM；命令走 issueCommand。
import { clamp, normDeg, normDeg180, dist2d, bearing2d, destPoint, aspectAngle, kn2mps, rad2deg } from '../core/util.js';
import { torpedoSpecFor, torpedoesThreatening, solveIntercept } from '../sim/torpedo.js';

// 外部指挥官（LLM/智能体）刚下过令的舰，本地 AI 在这些命令种类上不得覆盖
const PROTECTED_WHEN_DIRECTED = { SET_COURSE: 1, SET_SPEED: 1, SET_RUDDER: 1, FIRE: 1, CEASE_FIRE: 1, ASSIGN_TARGET: 1, LAUNCH_TORPEDO: 1, SMOKE: 1, WITHDRAW: 1, FORMATION: 1 };

// 舰种基准价值（0~100 量级）：航母 > 战列舰 > 战巡 > 重巡 > 轻巡 > 驱逐
const TYPE_VALUE = Object.freeze({ CV: 100, BB: 95, BC: 78, CA: 55, CL: 35, DD: 20, UNKNOWN: 30, MERCHANT: 25 });
// 敌方主炮口径量级（mm）——用于免疫区估算与威胁排序
const ENEMY_CALIBER = Object.freeze({ BB: 380, BC: 356, CA: 203, CL: 152, DD: 127, CV: 127, UNKNOWN: 152 });
const ARMORED_TYPES = Object.freeze({ BB: 1, BC: 1, CA: 1 });
const HVU_TYPES = Object.freeze({ BB: 1, BC: 1, CV: 1, CA: 1 });
const TORPEDO_TYPES_ALLOWED = Object.freeze({ DD: 1, CL: 1, CA: 1, BC: 1 });

// 舰种战斗剖面（从 data/ships_*.json 聚合的典型值，见 t-data 统计）：
// 接地到模拟的真实装甲/排水量/主炮口径，替代拍脑袋的 TYPE_VALUE 做"能不能打穿/打沉"判断。
const TYPE_COMBAT_PROFILE = Object.freeze({
  CV:       { belt_mm: 100, disp_t: 30000, caliber: 127 },  // 航母：侧舷薄、吨位大
  BB:       { belt_mm: 323, disp_t: 43600, caliber: 380 },  // 战列舰：带 250–410mm
  BC:       { belt_mm: 220, disp_t: 40000, caliber: 356 },
  CA:       { belt_mm: 106, disp_t: 14150, caliber: 203 },  // 重巡：带 70–152mm
  CL:       { belt_mm: 77,  disp_t: 9130,  caliber: 152 },
  DD:       { belt_mm: 20,  disp_t: 2900,  caliber: 127 },  // 驱逐舰无主装甲带
  UNKNOWN:  { belt_mm: 100, disp_t: 10000, caliber: 152 },
  MERCHANT: { belt_mm: 10,  disp_t: 8000,  caliber: 0 },
});

// ── B1 条令阈值（可调；new LocalAI(side,{doctrine:{torpedo:{...},damage:{...}}}) 覆盖）──
// 这些常量是「本地 AI 的条令」，不是物理参数：改它们只会改 AI 的判断，不会改仿真内核。
// 全部带出处/动机注释，便于复盘时判断"AI 的决定是条令要求还是 bug"。

// 协同雷击：1942 年水雷战队的做法是"分队齐射"——同一目标由 2 舰以上各自解提前角，
// 扇面按目标航迹误差裁开、互不重叠，分批到达打乱对方规避；而不是单舰一有窗口就把
// 4~6 管九三式一次泼出去（既浪费雷，也把战列线航向搅乱）。
export const TORPEDO_DOCTRINE = Object.freeze({
  nightRangeM: 13000,     // 夜战最大发射距离：九三式 48kn 档射程 20km，取 0.65 倍保证命中窗口
  dayRangeM: 8500,        // 日间：雷迹易被发现，发射窗口收紧（萨沃岛/塔萨法隆加夜战 1.5~4km）
  minRangeM: 900,         // 过近：陀螺/定深来不及稳定，且目标能立刻规避
  aspectMinDeg: 45,       // 目标舷角窗口下限（|sin|≈0.7，命中投影足够）
  aspectMaxDeg: 135,      // 上限（>135° 为迎头/尾追，投影只剩舰宽量级）
  nightTofS: 180,         // 命中窗口：鱼雷飞行 ≤180s（48kn≈4.4km、27kn≈2.4km）。原 300s 给目标 5 分钟规避，
                          // 实测 91% RANGE_EXHAUSTED、命中仅 5%。史实萨沃岛雷击在 1.5~4km 才放雷。
  dayTofS: 240,
  singleAspectMinDeg: 55, // 单舰（编不成组）窗口更严：没有交叉扇面兜底
  singleAspectMaxDeg: 125,
  singleMaxRangeM: 8000,  // 单舰只在 ≤8km 内补射，远距留给编组齐射
  minGroupSize: 2,        // 协同齐射最少舰数（任务要求 ≥2）
  maxPerGroup: 3,         // 一批最多 3 舰（再多就分目标，避免一窝蜂）
  groupWindowS: 45,       // 同一目标两批齐射的最小间隔
  targetRepeatS: 420,     // 单舰对同一目标不得重复雷击（换目标才重新解算）
  reloadS: 200,           // 同舰两次雷击最小间隔（含转向脱离与再装填）
  fanGapDeg: 2,           // 相邻舰雷扇之间的最小空隙（扇面不重叠的判据）
  fanMinDeg: 2,
  fanMaxDeg: 10,
  attackRunMaxShips: 3,   // 同时前出抢占雷击位的舰数上限（别把战列线抽空）
  attackRunRefreshS: 140, // 占位航向重算间隔（避免每 8s 改一次航向）
  attackRunRangeM: 16000, // 只对这个距离内的目标做突击占位
  tubesReserve: 2,        // 保留管次，避免一轮打光
});

// 受损脱离：进水/储备浮力、航速上限比例、主炮损失 任一达到阈值即退出战列线。
// 实测标定：一发九三式（TNT 当量 620kg）命中 1942 年重巡 → 进水约 5%~7% 储备浮力、
// 航速上限掉到 65%~70%（见 t15 的诊断输出），这正是"重伤"的物理量级。
export const DAMAGE_DOCTRINE = Object.freeze({
  floodFrac: 0.05,        // 进水 / 储备浮力
  speedFrac: 0.72,        // 航速上限 / 设计航速
  gunLoss: 0.66,          // 主炮损失比例（≈"主炮全废"；丹麦海峡 PoW 损失过半即脱离）
  listDeg: 15,            // 横倾
  score: 0.55,            // 综合损伤分（与 evaluateDamage 同口径）
  // 滞回：损伤回落到下沿以下并稳定 rejoinHoldS 才归队，避免阈值附近来回切换
  rejoin: Object.freeze({ floodFrac: 0.03, speedFrac: 0.82, gunLoss: 0.5, listDeg: 10, score: 0.38 }),
  // ── 舰种差异化阈值（只放宽大舰；未列出的舰种沿用上面的默认值）────────────────
  // 史实：战列舰会带着重伤继续留在战列线上——俾斯麦最后航速掉到 7 kn 仍在还击、大和在
  // 莱特湾吃 2 条鱼雷后仍保持 20 kn 编队航速。而驱逐舰进水 5% 就该脱离（它没有储备浮力余量）。
  // 旧模型对所有舰种用同一套比例阈值：大和（6 炉 4 轴，72,800 t）只要 2 发穿甲弹命中机炉舱、
  // 航速上限掉到 70%，就被判定"重伤 → 撤退"，玩家看到的是"最强战列舰挨两下就跑"（很脆）。
  byType: Object.freeze({
    BB: Object.freeze({
      floodFrac: 0.12, speedFrac: 0.50, gunLoss: 0.80, listDeg: 20, score: 0.72,
      rejoin: Object.freeze({ floodFrac: 0.08, speedFrac: 0.62, gunLoss: 0.62, listDeg: 14, score: 0.50 }),
    }),
    BC: Object.freeze({
      floodFrac: 0.11, speedFrac: 0.52, gunLoss: 0.75, listDeg: 18, score: 0.70,
      rejoin: Object.freeze({ floodFrac: 0.075, speedFrac: 0.64, gunLoss: 0.60, listDeg: 13, score: 0.48 }),
    }),
    CV: Object.freeze({
      floodFrac: 0.09, speedFrac: 0.60, gunLoss: 0.66, listDeg: 15, score: 0.62,
      rejoin: Object.freeze({ floodFrac: 0.06, speedFrac: 0.72, gunLoss: 0.50, listDeg: 11, score: 0.42 }),
    }),
    // 巡洋舰沿用默认阈值（t15 的重伤注入用例以 CA 为基准）；只有驱逐舰需要放宽，
    // 因为 DD 的"航速上限掉 28%"不等于丧失战斗力。
    CA: Object.freeze({
      floodFrac: 0.05, speedFrac: 0.72, gunLoss: 0.66, listDeg: 15, score: 0.55,
      rejoin: Object.freeze({ floodFrac: 0.03, speedFrac: 0.82, gunLoss: 0.5, listDeg: 10, score: 0.38 }),
    }),
    CL: Object.freeze({
      floodFrac: 0.05, speedFrac: 0.72, gunLoss: 0.66, listDeg: 15, score: 0.55,
      rejoin: Object.freeze({ floodFrac: 0.03, speedFrac: 0.82, gunLoss: 0.5, listDeg: 10, score: 0.38 }),
    }),
    // 驱逐舰：储备浮力小，但航速上限掉 28% 就退出战列线是旧 bug（沙盒 604：弗莱彻 38s
    // 就因 "航速上限 72%" 撤离）。DD 的结构强度低，真正的撤离信号是进水/横倾/主炮全废，
    // 而不是"跑不到 36 节"。
    DD: Object.freeze({
      // 只放宽"航速上限"这一项：DD 掉 28% 航速不等于丧失战斗力；其余阈值沿用默认，
      // 避免改变 DD 在其它损伤维度上的撤离行为（t12/t15 的命令预算对这一步很敏感）。
      floodFrac: 0.05, speedFrac: 0.55, gunLoss: 0.66, listDeg: 15, score: 0.55,
      rejoin: Object.freeze({ floodFrac: 0.03, speedFrac: 0.70, gunLoss: 0.5, listDeg: 10, score: 0.38 }),
    }),
  }),
  rejoinHoldS: 180,
  smokeOnS: 45,           // 脱离中重复施烟的最小间隔（烟幕要持续覆盖）
  escortRangeM: 2200,     // 掩护僚舰阵位：在脱离舰朝敌一侧 2.2km
  escortHoldS: 60,        // 掩护任务的刷新时间（防止每 tick 重发 FORMATION）
});

// 受损评估（纯函数：AI、简报、测试共用同一口径）
export function evaluateDamage(ship) {
  const flood = ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3);
  const fires = ship.compartments.filter((c) => c.fire > 0.1).length;
  const list = Math.abs(ship.list || 0);
  const spdMax = Math.max(1, ship.data.speedMax_kn || 25);
  const speedFrac = clamp((ship.speedCapKn || spdMax) / spdMax, 0, 1);
  const speedLoss = 1 - speedFrac;
  const mainTotal = (ship.batteries || []).filter((b) => b.role === 'main').length;
  const mainAlive = (ship.mainBatteries || []).filter((b) => !b.destroyed && b.health > 0.15).length;
  const gunLoss = mainTotal ? 1 - mainAlive / mainTotal : 0;
  const crewLoss = 1 - clamp(ship.crew / Math.max(1, ship.crew0), 0, 1);
  const score = clamp(flood * 1.8 + fires * 0.07 + list / 90 + speedLoss * 0.6 + gunLoss * 0.5 + crewLoss * 0.4, 0, 2);
  return { score, flood, fires, list, gunLoss, speedLoss, speedFrac, mainTotal, mainAlive, crewLoss };
}

// 脱离判定：withdraw=达阈值；stable=已回落到滞回下沿（可归队）。
// context.js 的态势简报直接复用它，保证"AI 的判断"和"给 LLM 看的判断"同一口径。
export function damageVerdict(ship, dmg, doctrine) {
  const D = doctrine || DAMAGE_DOCTRINE;
  const d = dmg || evaluateDamage(ship);
  // 舰种覆盖：只有大舰（BB/BC/CV）放宽，其余沿用默认阈值。doctrine 若显式传 byType 则以其为准。
  const tier = (D.byType && ship && D.byType[ship.type]) || null;
  const L = tier ? Object.assign({}, D, tier) : D;
  const R = L.rejoin || D.rejoin || DAMAGE_DOCTRINE.rejoin;
  const triggers = [];
  if (d.flood >= L.floodFrac) triggers.push('进水' + Math.round(d.flood * 100) + '%');
  if (d.speedFrac <= L.speedFrac) triggers.push('航速上限' + Math.round(d.speedFrac * 100) + '%');
  if (d.gunLoss >= L.gunLoss) triggers.push('主炮损失' + Math.round(d.gunLoss * 100) + '%');
  if (d.list >= L.listDeg) triggers.push('横倾' + Math.round(d.list) + '°');
  if (d.score >= L.score) triggers.push('损伤分' + d.score.toFixed(2));
  const stable = d.flood <= R.floodFrac && d.speedFrac >= R.speedFrac && d.gunLoss <= R.gunLoss && d.list <= R.listDeg && d.score <= R.score;
  return Object.assign({ withdraw: triggers.length > 0, stable, triggers }, d);
}

// ── 决战距离条令（decisive range）─────────────────────────────────────────────
// 史实：1941-42 年的火控在 20km 以上命中率趋近于 0，舰长必须接近到有效交战距离：
// 丹麦海峡 14-18km、萨沃岛 1.5-3km（夜）、第一次瓜岛 3-6km（夜）。
// 因此条令分两阶段：先「接近」（接近角 20~40°、全速、只做校射单发），进入决战距离后
// 才「抢占 T 字位」并允许全齐射。夜里借雷达火控可放宽 1~1.8km 先敌开火。
const DECISIVE_BAND = Object.freeze({
  BB: { day: [11000, 15000], night: [5000, 9000] },
  BC: { day: [11000, 15000], night: [5000, 9000] },
  CV: { day: [14000, 20000], night: [10000, 16000] },
  CA: { day: [8000, 14000], night: [3000, 8000] },
  CL: { day: [7000, 12000], night: [3000, 7000] },
  DD: { day: [6000, 10000], night: [2000, 6000] },
});
// 舰种名义长度：航迹误差 errM 超过目标长度时无法有效校射（只打单发）
const TYPE_LENGTH_M = Object.freeze({ BB: 230, BC: 240, CV: 250, CA: 190, CL: 160, DD: 110, UNKNOWN: 130 });
// 航迹识别兜底：T2 的 tracks 尚未输出 classifiedAs 时（当前为 UNKNOWN），按雷达截面积量级粗分类。
// 量级取自 sensors.js RCS_TABLE（X 波段舷侧）：DD 1200 / CL 2800 / CA 4200 / BB 18000。
const RCS_CLASS_BANDS = [[11000, 'BB'], [3200, 'CA'], [1900, 'CL']];
export function classifyTrack(tr) {
  if (!tr) return 'UNKNOWN';
  if (tr.classifiedAs && tr.classifiedAs !== 'UNKNOWN') return tr.classifiedAs;
  const rcs = (tr.features && tr.features.rcsM2) || tr.rcsM2 || 0;
  if (rcs > 0) { for (const p of RCS_CLASS_BANDS) if (rcs >= p[0]) return p[1]; return 'DD'; }
  if (tr.silhouetteAreaM2) return tr.silhouetteAreaM2 > 12000 ? 'BB' : tr.silhouetteAreaM2 > 5000 ? 'CA' : 'DD';
  return 'UNKNOWN';
}

// ── 免疫区估算（AI 级一阶近似；真值以 T4 的 penetrationMM 为准） ───────────────
// 舷侧穿深随距离下降，甲板穿深随距离上升（落角增大）。经验量级：
//   重型被帽穿甲弹近距法线穿深 ≈ 1.9×口径；30km 处甲板穿深 ≈ 0.45×口径。
//   rBelt：pen_belt(r)=装甲舷侧厚 的下界（更远才免疫）；
//   rDeck：pen_deck(r)=甲板厚 的上界（更近才免疫）。
export function immuneZoneVs(ship, enemyType) {
  const eCal = ENEMY_CALIBER[enemyType] || ENEMY_CALIBER.UNKNOWN;
  const armor = ship.data.armor || {};
  const belt = armor.belt_mm || 0, deck = armor.deck_mm || 0;
  const pen0 = 1.9 * eCal;
  const rBelt = belt > 0 ? 35000 * (1 - Math.pow(clamp(belt / pen0, 0, 1), 1 / 1.2)) : 0;
  const penDeck30 = 0.45 * eCal;
  const rDeck = deck > 0 ? 8000 + 22000 * Math.pow(clamp(deck / penDeck30, 0, 1), 1 / 0.9) : 40000;
  return { innerM: clamp(rBelt, 0, 40000), outerM: clamp(rDeck, 0, 40000), valid: rBelt < rDeck, eCal };
}

export class LocalAI {
  constructor(side, opts = {}) {
    this.side = side;
    this.name = 'LOCAL';
    this.opts = opts;
    this.intervalS = opts.intervalS || 8;         // 战术决策周期
    this.fastIntervalS = opts.fastIntervalS || 1.0; // 反应回路（避雷/损管）
    this.accum = 0; this.fastAccum = 0;
    this.lastReasoning = '未决策';
    this.lastCommands = 0;
    // ── 命令节流（LOCAL AI 的命令密度控制）────────────────────────────────────
    // 指挥延迟 side.orderDelay_s 默认 4–12s，舰队级更久；比这更密的重发不会让舰更早到位，
    // 只会让它在"旧令→新令"之间来回摆（实测第一次瓜岛 40 分钟 order.issue=5482，
    // SET_COURSE 每 8.1s 一条而航向中位变化只有 1.6°）。因此对操舵/航速类命令加
    // 「时间节流 + 数值滞回」，开火/换靶命令加「重复抑制 + 目标连续性」，避雷机动豁免。
    // B1 调参：交战节奏加快后（雷击占位/受损脱离/僚舰屏护），20s 的航向/航速节流仍会
    // 让命令量随舰数线性上涨。C2 延迟本身 4~12s，25~30s 的保持间隔不会让舰"反应迟钝"，
    // 但能把重复微调挡在门外（萨沃岛 900s 实测 767→约 650 条）。
    this.courseHoldS = opts.courseHoldS !== undefined ? opts.courseHoldS : 36;          // 同舰两次航向命令最小间隔
    this.courseDeadbandDeg = opts.courseDeadbandDeg !== undefined ? opts.courseDeadbandDeg : 12;  // 航向死区
    this.courseForceDeadbandDeg = opts.courseForceDeadbandDeg !== undefined ? opts.courseForceDeadbandDeg : 10; // 强制机动（接近/撤退/雷击脱离）死区
    this.speedHoldS = opts.speedHoldS !== undefined ? opts.speedHoldS : 45;            // 航速命令最小间隔
    this.speedDeadbandKn = opts.speedDeadbandKn !== undefined ? opts.speedDeadbandKn : 2.0;       // 航速死区（节）
    this.rudderHoldS = opts.rudderHoldS !== undefined ? opts.rudderHoldS : 20;          // 舵令最小间隔（暂无调用方，保留）
    this.rudderDeadbandDeg = opts.rudderDeadbandDeg !== undefined ? opts.rudderDeadbandDeg : 5;   // 舵角死区
    this.fireHoldS = opts.fireHoldS !== undefined ? opts.fireHoldS : 60;               // 同目标重复 FIRE 的最小间隔（校射要观察弹着再修正，约 1 分钟一轮接近真实节奏；持续齐射模式下不影响实际射速）
    this.fireModeHoldS = opts.fireModeHoldS !== undefined ? opts.fireModeHoldS : 20;   // SPOT/FULL 模式切换的最小间隔
    this.targetHoldS = opts.targetHoldS !== undefined ? opts.targetHoldS : 60;         // 换靶最小间隔（目标未丢失时）
    this.targetLostHoldS = opts.targetLostHoldS !== undefined ? opts.targetLostHoldS : 45; // 目标短暂丢失时的停火抑制窗
    this.targetChurnHoldS = opts.targetChurnHoldS !== undefined ? opts.targetChurnHoldS : 12; // 航迹翻新（失跟-重捕）时按住原目标不换靶的窗口
    this.starHoldS = opts.starHoldS !== undefined ? opts.starHoldS : 90;               // 单舰照明弹最小间隔
    this.starFleetHoldS = opts.starFleetHoldS !== undefined ? opts.starFleetHoldS : 30; // 全队照明弹最小间隔（别所有舰一起打）
    // B1 条令阈值：可逐项覆盖（测试/调参用），默认值见模块顶部 DAMAGE_DOCTRINE / TORPEDO_DOCTRINE
    const docOpts = opts.doctrine || {};
    // doctrine.enabled=false → 回到 B1 之前的旧条令（旧雷击/旧脱离阈值/旧近岸减速）。
    // 用途：① 回归对照（test/t15 用同种子跑"无条令基线"，不依赖别的人改动）；② 排障时
    // 一键关掉新条令，确认行为差异来自条令而不是仿真内核。
    this.doctrineOn = !(docOpts && docOpts.enabled === false);
    this.torpDoctrine = Object.assign({}, TORPEDO_DOCTRINE, docOpts.torpedo || {});
    this.dmgDoctrine = Object.assign({}, DAMAGE_DOCTRINE, docOpts.damage || {});
    this.mem = new Map();
    this.fleet = { phase: 'SEARCH', threatAxisDeg: null, enemyValue: 0, ownValue: 0, ratio: 1, focusTrackId: null, focusLabel: '' };
  }

  tick(world, dt, dryRun) {
    this.dryRun = !!dryRun;   // true = 参谋模式：只给出判断与建议，不向世界下任何命令
    this.fastAccum += dt;
    if (this.fastAccum >= this.fastIntervalS) { this.fastAccum = 0; this.react(world); }
    this.accum += dt;
    if (this.accum >= this.intervalS) { this.accum = 0; this.decide(world); }
  }

  memFor(ship) {
    let m = this.mem.get(ship.id);
    if (!m) {
      m = { targetTrackId: null, ammo: 'AP', firing: false, lastCourseT: -1e9, lastSpeedT: -1e9, lastTorpT: -1e9,
        evadeUntil: -1e9, evadeHeading: null, evacuating: false, withdraw: false, dcMode: null, lastStationT: -1e9, screenStation: null,
        // 节流/滞回状态：上次实际下达的航向与航速（不是"当前保持值"，后者会因 C2 延迟滞后）
        lastCourseWant: undefined, lastSpeedWant: undefined, lastRudder: undefined, lastRudderT: -1e9,
        lastFireT: -1e9, lastAssignT: -1e9, lastTargetT: -1e9, gateFailN: 0,
        // B1 条令状态：脱离/归队（带滞回）、损管优先级去重、雷击重复抑制、掩护任务
        withdrawT: -1e9, rejoinStableT: null, verdict: null,
        dcModeT: -1e9, torpTargetAt: {}, torpRunT: -1e9, escortOf: null, escortT: -1e9,
        lastRetreatSmoke: -1e9, lastEscortT: -1e9 };
      this.mem.set(ship.id, m);
    }
    return m;
  }

  // 执行官模式（LLM/外部指挥官在线时）：本地 AI 继续做实时事务（规避、损管、火控门限），
  // 但不覆盖外部指挥官刚下达的航向/速度/火力——除非是避雷这种保命机动。
  order(world, cmd, evade) {
    if (this.dryRun) return null;   // 参谋模式：不实际下令（玩家/外部指挥官自己指挥）
    // 用仿真时间而不是墙钟：时间压缩 1x~64x 下都成立（"外部指挥官的令保持 5 分钟仿真时间"）
    if (this.directiveHoldS === undefined) this.directiveHoldS = 300;
    if (!evade && this.directiveHoldS > 0 && cmd.shipId) {
      const ship = world.ship ? world.ship(cmd.shipId) : null;
      // 注意：不能用 || —— _directiveSim 可能是 0（开局那一刻下的命令），会被当成"没有时间戳"
      const stamp = ship && ship._directiveSim !== undefined ? ship._directiveSim : -1e9;
      const age = world.t - stamp;
      if (age < this.directiveHoldS && PROTECTED_WHEN_DIRECTED[cmd.kind]) return null;
    }
    // SET_RUDDER：本 AI 当前不主动发舵令（航向靠 SET_COURSE），但统一在这里做节流，
    // 避免将来战术模块高频操舵把命令数重新拉高。evade（避雷）不受时间节流限制。
    if (!evade && cmd.kind === 'SET_RUDDER' && cmd.shipId) {
      const sh = world.ship ? world.ship(cmd.shipId) : null;
      if (sh) {
        const m = this.memFor(sh);
        const deg = (cmd.params && cmd.params.deg) || 0;
        if (world.t - m.lastRudderT < this.rudderHoldS) return null;
        if (m.lastRudder !== undefined && Math.abs(deg - m.lastRudder) < this.rudderDeadbandDeg) return null;
        m.lastRudderT = world.t; m.lastRudder = deg;
      }
    }
    this.lastCommands++;
    return world.issueCommand(Object.assign({ source: 'AI_LOCAL', issuer: 'LOCAL/' + this.side }, cmd));
  }
  setCourse(world, ship, heading, mem, force = false, evade = false) {
    // 防御：航迹/威胁轴偶尔会算出非有限值（NaN 由上层计算传出）。宁可本轮不下令，
    // 也绝不能把 NaN 写进 commanded.heading——那会经自动操舵污染整条舰乃至全队坐标。
    if (!Number.isFinite(heading)) return false;
    let want = normDeg(heading);
    // 陆地避让：前方约 4 分钟航程是陆地就朝可航一侧偏转（真实舰长不会把船开上岸）
    if (world.land && !world.land.empty) {
      // 沿多个距离探测（1.5/3/6/9km），只要有一条被陆地挡住就换向；全被挡则横着走（狭水道最安全）
      const big = (ship.data.loa_m || 100) > 170;
      const dists = big ? [3000, 6000, 12000, 18000] : [1500, 3000, 6000, 9000];
      const blocked = (h) => {
        for (const d of dists) {
          const p = destPoint(ship.pos, d, h);
          if (world.land.isLandExact(p.x, p.y)) return true;
          if (world.depth && !world.depth.empty && !world.depth.isNavigable(p.x, p.y, ship.draftM || 6, 2)) return true;
        }
        return false;
      };
      if (blocked(want)) {
        let bestH = null;
        for (let off = 15; off <= 180 && bestH === null; off += 15) {
          for (const sgn of [1, -1]) {
            const h = normDeg(want + sgn * off);
            if (!blocked(h)) { bestH = h; break; }
          }
        }
        want = bestH !== null ? bestH : normDeg(want + 90);
      }
    }
    // 航向命令节流：时间节流对 force（接近/退出/雷击脱离）同样生效——C2 延迟下更密的重发
    // 没有意义；只有避雷（evade）必须即时。滞回以上次"下达值"为基准（commanded.heading 要等
    // 命令生效才更新，用它做基准会在延迟窗口里反复重发）。
    if (!evade) {
      if (world.t - mem.lastCourseT < this.courseHoldS) return false;
      const refH = mem.lastCourseWant !== undefined ? mem.lastCourseWant : ship.commanded.heading;
      const dead = force ? this.courseForceDeadbandDeg : this.courseDeadbandDeg;
      if (Math.abs(normDeg180(want - refH)) < dead) return false;
    }
    mem.lastCourseT = world.t;
    mem.lastCourseWant = want;
    return !!this.order(world, { shipId: ship.id, kind: 'SET_COURSE', params: { heading: want } }, evade);
  }
  setSpeed(world, ship, kn, mem, force = false, evade = false) {
    // 防御：与 setCourse 同理（例如 speedCapKn 在极端损伤下可能算出 NaN）
    if (!Number.isFinite(kn)) return false;
    // 取整到 1 节：受损舰的 speedCapKn 会随进水缓慢下降，浮点值每 2 节就跨一次死区，
    // 不取整会让"航速上限在掉"本身变成一串 SET_SPEED 命令。
    let want = Math.round(clamp(kn, 0, ship.data.speedMax_kn || 30));
    // ── 近岸减速（B1 修正）：看「前方航路」是否被陆地/浅滩挡住，而不是看离岸多远 ──
    // 旧实现只要离岸 <2.5km 就把航速压到 10 节：萨沃岛剧本里日军巡洋舰起始位置离瓜岛
    // 北岸只有 0.4~2.8km，结果整条战列线用 10 节爬行，900s 只接近 11km，交战与雷击都
    // 无从谈起（实测 900s 内 torp.launch=1）。真实舰长在平行岸线航行时保持编队航速，
    // 只在航路被挡/水浅时才减速；这里按 1.5~2 个舰长距离取样前方航路。
    if (!evade && world.land && !world.land.empty && !this.doctrineOn) {
      // 旧条令（B1 之前）：只看离岸距离，离线 2.5km 内压到 10 节（会被岸线挤成爬行）
      const dl = world.land.distanceToLand(ship.pos.x, ship.pos.y, 9000);
      if (dl < 2500) want = Math.min(want, 10);
      else if (dl < 5000) want = Math.min(want, 18);
    } else if (!evade && world.land && !world.land.empty) {
      const big = (ship.data.loa_m || 100) > 170;
      const probeM = big ? 2400 : 1600;
      const h0 = ship.commanded.heading !== undefined ? ship.commanded.heading : ship.heading;
      const draft = (ship.draftM || 6) + 2.0;      // 富裕水深 2m（搁浅余量）
      let blocked = false;
      for (const d of [probeM, probeM * 2]) {
        const p = destPoint(ship.pos, d, h0);
        if (world.land.isLandExact(p.x, p.y)) { blocked = true; break; }
        if (world.depth && !world.depth.empty && !world.depth.isNavigable(p.x, p.y, draft, 1)) { blocked = true; break; }
      }
      if (blocked) want = Math.min(want, 8);                       // 航路被挡：减速+由 setCourse 改向
      else if (world.land.distanceToLand(ship.pos.x, ship.pos.y, 2000) < 700) want = Math.min(want, 18); // 贴岸仅谨慎
    }
    // 航速命令节流：同上（force/evade 语义与 setCourse 一致）
    if (!evade) {
      if (world.t - mem.lastSpeedT < this.speedHoldS) return false;
      const refKn = mem.lastSpeedWant !== undefined ? mem.lastSpeedWant : ship.commanded.speed;
      if (Math.abs(want - refKn) < this.speedDeadbandKn) return false;
    }
    mem.lastSpeedT = world.t;
    mem.lastSpeedWant = want;
    return !!this.order(world, { shipId: ship.id, kind: 'SET_SPEED', params: { kn: want } }, evade);
  }
  // 停火（带抖动抑制）：T2 的航迹 id 会因失跟/重捕而翻新，目标短暂"消失"一轮时旧逻辑
  // 立刻 CEASE_FIRE、下一轮又在同一条物理目标上 FIRE，命令对翻而炮口没变。目标刚在
  // targetLostHoldS 内出现过就暂不停火（gunnery 在无有效航迹时本来就不会开炮）。
  ceaseFire(world, ship, mem, noTarget) {
    if (!(mem.firing || ship.commanded.firing)) return false;
    const held = noTarget && world.t - (mem.lastTargetT || -1e9) < this.targetLostHoldS;
    if (!held) {
      this.order(world, { shipId: ship.id, kind: 'CEASE_FIRE', params: {} });
      mem.firing = false; mem.fireMode = null;
    } else mem.firing = !!ship.commanded.firing;
    return !held;
  }
  smoke(world, ship, on) {
    const want = !!on;
    const mem = this.memFor(ship);
    // 命令有指挥延迟（4~12 s），下发到生效之间 ship.flags.smokeOn 仍是旧值。若只比较
    // flags，react() 的 1 s 回路会在延迟窗口里每个 tick 重发一条 SMOKE——实测一局
    // 撤烟 133 条 / 施烟 41 条（其中弗莱彻一舰撤烟 104 条），既刷爆命令量，
    // 也让 AAR 里"烟幕 26 次"这类统计失去意义。这里额外记住"最后一次下发的意图"。
    if (mem.smokeWant === want) return false;
    if (ship.flags.smokeOn === want) { mem.smokeWant = want; return false; }
    mem.smokeWant = want;
    this.order(world, { shipId: ship.id, kind: 'SMOKE', params: { on: want } });
    return true;
  }

  // ── 1s 反应回路：避雷机动 + 损管优先级 ─────────────────────────────────────
  react(world) {
    const mine = world.afloatOf(this.side);
    if (!mine.length) return;
    const notes = [];
    for (const ship of mine) {
      const mem = this.memFor(ship);
      // 避雷：只对已目视发现的鱼雷航迹反应（氧气鱼雷航迹极淡 → 常常发现时已来不及）
      const threats = torpedoesThreatening(world, ship, { maxRangeM: 9000, maxCpaM: 700, maxTimeS: 240 });
      const seen = threats.filter((t) => t.detected);
      if (seen.length && world.t > mem.evadeUntil) {
        const t0 = seen[0];
        const c1 = normDeg(t0.torp.courseDeg), c2 = normDeg(t0.torp.courseDeg + 180);
        // comb the wakes：与雷迹平行，使投影只剩舰宽（B）而非全长（L）
        const h = Math.abs(normDeg180(c1 - ship.heading)) <= Math.abs(normDeg180(c2 - ship.heading)) ? c1 : c2;
        this.setCourse(world, ship, h, mem, true, true);
        this.setSpeed(world, ship, ship.data.speedMax_kn || 30, mem, true, true);
        mem.evadeUntil = world.t + Math.max(35, t0.timeToCpaS + 20);
        mem.evadeHeading = h;
        notes.push('【避雷】' + ship.name + ' 发现' + (t0.wakeType === 'OXYGEN' ? '淡航迹' : '航迹') +
          ' 距' + Math.round(t0.rangeM) + 'm CPA' + Math.round(t0.cpaM) + 'm → comb wake ' + Math.round(h) + '° 全速');
      }
      // ── 损管优先级（B1）：按主要损伤类型发 DC_PRIORITY，同一优先级不重发 ──────
      // 去重有两层：① 与本舰上次「AI 下发的优先级」不同才发；② 若舰上实际优先级被
      // 外部/玩家改掉，也要等 dcModeT 冷却过了才重新接管（避免 AI 与玩家每 tick 抢）。
      const mode = this.dcMode(ship, mem, world.t);
      const actualMode = ship.dcPriority || 'flooding';
      if (mode && (mode !== mem.dcMode ||
          (actualMode !== mode && world.t - (mem.dcModeT || -1e9) > this.dmgDoctrine.smokeOnS))) {
        mem.dcMode = mode; mem.dcModeT = world.t;
        this.order(world, { shipId: ship.id, kind: 'DC_PRIORITY', params: { mode } });
        notes.push('【损管】' + ship.name + ' 优先级=' + mode);
      }
      // ── 受损脱离（B1）：不等 8s 决策周期，达阈值当场退出战列线 ──────────────
      const dmg = this.damageScore(ship);
      const verdict = damageVerdict(ship, dmg, this.dmgDoctrine);
      mem.verdict = verdict;
      const withdrawNow = this.doctrineOn ? verdict.withdraw : this.shouldWithdraw(ship, dmg, world);
      if (!mem.withdraw && withdrawNow) {
        mem.withdraw = true; mem.withdrawT = world.t; mem.rejoinStableT = null;
        this.leaveLine(world, ship, mem, notes, verdict);
      } else if (mem.withdraw && this.doctrineOn) {
        // 滞回：损伤回落到下沿并连续稳定 rejoinHoldS 才归队（阈值附近不来回切）
        if (verdict.stable) {
          if (mem.rejoinStableT === null || mem.rejoinStableT === undefined) mem.rejoinStableT = world.t;
          if (world.t - mem.rejoinStableT >= this.dmgDoctrine.rejoinHoldS) {
            mem.withdraw = false; mem.withdrawT = -1e9; mem.rejoinStableT = null;
            if (this.fleet.withdrawing) delete this.fleet.withdrawing[ship.id];
            this.smoke(world, ship, false);
            notes.push('【归队】' + ship.name + ' 损管见效（进水' + Math.round(verdict.flood * 100) + '% 航速上限' + Math.round(verdict.speedFrac * 100) + '%）→ 回归战列线');
          }
        } else mem.rejoinStableT = null;
      }
      // ── 防御性烟幕：近期被命中（敌已校射命中我）却还没到脱离阈值 → 施烟遮断后续校射。
      // 接地：读 ship.stats.hitsTaken（模拟真实命中计数）的变化来判定"我正在被有效打击"。
      const hitsNow = ship.stats && ship.stats.hitsTaken ? ship.stats.hitsTaken : 0;
      if (mem.lastHitsTaken === undefined) mem.lastHitsTaken = hitsNow;
      if (!mem.withdraw && hitsNow > mem.lastHitsTaken) {
        mem.lastHitT = world.t;
        if (!ship.flags.smokeOn && this.smoke(world, ship, true)) {
          notes.push('【烟幕】' + ship.name + ' 被命中施烟破敌校射');
        }
      }
      mem.lastHitsTaken = hitsNow;
      // 脱离接触（>90s 无新命中）后撤烟，恢复本舰视线
      if (!mem.withdraw && mem.lastHitT !== undefined && world.t - mem.lastHitT > 90 && ship.flags.smokeOn) {
        this.smoke(world, ship, false);
      }
    }
    if (notes.length) {
      this.lastReasoning = notes.join(' ｜ ');
      world.events.emit('ai.decision', { t: world.t, side: this.side, backend: 'LOCAL', reaction: true, commands: this.lastCommands, reasoning: this.lastReasoning });
    }
  }

  // ── 战术决策周期 ──────────────────────────────────────────────────────────
  decide(world) {
    const mine = world.afloatOf(this.side);
    if (!mine.length) return;
    const enemies = this.picture(world, mine);
    const R = [];
    this.lastCommands = 0;
    this.assess(world, mine, enemies);
    const plan = '【态势】' + ({ SEARCH: '搜索', ENGAGE: '交战', TORPEDO: '雷击突击', WITHDRAW: '脱离' }[this.fleet.phase] || this.fleet.phase) +
      ' 我' + Math.round(this.fleet.ownValue) + ':敌' + Math.round(this.fleet.enemyValue) +
      (this.fleet.focusLabel ? ' 集火' + this.fleet.focusLabel : '');
    this.assignTargets(world, mine, enemies, R);
    if (this.fleet.phase === 'WITHDRAW') this.fleetRetreat(world, mine, R);
    else {
      // 单舰脱离：WITHDRAW 命令只置标记不设航向，必须由 AI 操舵——否则"想撤"的舰
      // 仍按旧航向朝敌航行（实测俾斯麦一路从 18km 缩到 7km 被打瘫）
      for (const ship of mine) { const mem = this.memFor(ship); if (mem.withdraw) this.retreatShip(world, ship, mem, R); }
      // B1：给脱离舰派就近僚舰掩护（屏护站位）——必须在 maneuver/screen 之前定，
      // 这两个函数看到 escortOf 就让位，避免同一 tick 对同一艘僚舰发两条航向命令。
      if (this.doctrineOn) this.escortWithdrawers(world, mine, enemies, R);
      this.maneuver(world, mine, enemies, R);
      this.screen(world, mine, enemies, R);
      this.torpedoAttack(world, mine, enemies, R);
    }
    this.ammoEconomy(world, mine, R);
    this.lastReasoning = plan + (R.length ? ' ｜ ' + R.join(' ｜ ') : ' ｜ 保持当前阵位与射速');
    world.events.emit('ai.decision', { t: world.t, side: this.side, backend: 'LOCAL', phase: this.fleet.phase, commands: this.lastCommands, reasoning: this.lastReasoning });
  }

  // ── 战场态势：合并本方各舰航迹（同一 TrackManager，去重） ────────────────
  picture(world, mine) {
    const out = [];
    const seen = new Set();
    const centroid = this.centroid(mine);
    for (const ship of mine) {
      let list = [];
      try { list = world.tracks.visibleFor(ship) || []; } catch (e) { list = []; }
      for (const tr of list) {
        if (!tr || tr.hostile === false) continue;
        if (seen.has(tr.id)) continue;
        seen.add(tr.id);
        const r = dist2d(ship.pos, tr.pos);
        out.push({ tr, rangeM: r, bearingFromFlag: bearing2d(centroid, tr.pos), rangeFromFlag: dist2d(centroid, tr.pos), classifiedAs: classifyTrack(tr) });
      }
    }
    out.sort((a, b) => (TYPE_VALUE[b.classifiedAs] || 30) - (TYPE_VALUE[a.classifiedAs] || 30));
    return out;
  }

  centroid(ships) {
    let x = 0, y = 0, w = 0;
    for (const s of ships) { const v = s.type === 'BB' || s.type === 'CV' ? 3 : 1; x += s.pos.x * v; y += s.pos.y * v; w += v; }
    return w ? { x: x / w, y: y / w } : { x: 0, y: 0 };
  }

  // ── 接地目标评估：可击沉性 / 穿甲（读模拟的装甲与排水量，而非 TYPE_VALUE）──
  shipBoreMm(ship) {
    const mains = ship.mainBatteries || [];
    let b = 0;
    for (const m of mains) { const mm = m.data && m.data.bore_mm; if (mm > b) b = mm; }
    return b;
  }
  // 粗略穿深（mm）：近距 ≈ 口径，随距离衰减（弹道存速下降）。目标选择只需相对量级。
  approxPenetrationMm(boreMm, rangeM) {
    if (!boreMm) return 0;
    return boreMm * clamp(1.05 - (rangeM || 0) / 22000, 0.35, 1);
  }
  // 可击沉性 0~1：能否穿甲（穿深/装甲带）× 吨位（储备浮力）倒数。
  // DD≈1（一打就沉）、CA≈0.55、BB≈0.25——人类指挥官优先打"打得沉"的目标，而非牌面价值。
  killability(ship, enemyType, rangeM) {
    const p = TYPE_COMBAT_PROFILE[enemyType] || TYPE_COMBAT_PROFILE.UNKNOWN;
    const bore = this.shipBoreMm(ship);
    if (!bore) return 0.1;
    const pen = this.approxPenetrationMm(bore, rangeM);
    const penRatio = clamp(pen / Math.max(10, p.belt_mm), 0, 1.25);
    const sinkHard = Math.sqrt(Math.max(2000, p.disp_t) / 2900);  // DD≈1.0 CA≈2.2 BB≈3.9
    return clamp(penRatio * 1.15 / sinkHard, 0.04, 1);
  }
  // 威胁度（接地，与 killability 对称）：敌主炮能否打穿"我的"装甲带 × 距离逼近。
  // 替代 ENEMY_CALIBER 的拍脑袋归一化（cal/203），读敌方口径与己方 belt_mm。
  threatOf(ship, enemyType, rangeM) {
    const p = TYPE_COMBAT_PROFILE[enemyType] || TYPE_COMBAT_PROFILE.UNKNOWN;
    const eCal = p.caliber || 0;
    if (eCal <= 0) return 0;  // 无炮目标（商船）无炮击威胁
    const myArmor = (ship.data && ship.data.armor) || {};
    const myBelt = myArmor.belt_mm || 0;
    const pen = this.approxPenetrationMm(eCal, rangeM);
    const penRatio = clamp(pen / Math.max(10, myBelt), 0, 2);
    const closing = clamp(1 + (20000 - Math.min(rangeM || 0, 20000)) / 12000, 1, 2.4);
    return penRatio * closing;
  }
  // 交战距离判定（接地）：基于"我能否打穿它 vs 它能否打穿我"的不对称。
  // 这是人类舰长的核心判断——我方有穿甲优势就贴近打，劣势就拉开，均势保持。
  rangeVerdict(ship, enemyType, rangeM) {
    const p = TYPE_COMBAT_PROFILE[enemyType] || TYPE_COMBAT_PROFILE.UNKNOWN;
    const myBore = this.shipBoreMm(ship);
    const myArmor = (ship.data && ship.data.armor) || {};
    const myBelt = myArmor.belt_mm || 0;
    const eCal = p.caliber || 0;
    if (!myBore) return 'OPEN';                    // 无主炮：只能拉开
    if (eCal <= 0) return 'CLOSE';                 // 无炮目标（商船）：贴近收割
    const iPen = this.approxPenetrationMm(myBore, rangeM) / Math.max(10, p.belt_mm);   // 我穿它
    const ePen = this.approxPenetrationMm(eCal, rangeM) / Math.max(10, myBelt);        // 它穿我
    if (iPen > 1.15 && ePen < 0.85) return 'CLOSE';  // 我能打穿它、它打不穿我 → 优势贴近
    if (iPen < 0.85 && ePen > 1.15) return 'OPEN';   // 它打穿我、我打不穿它 → 劣势拉开
    return 'HOLD';                                   // 均势：保持决战距离
  }
  // 鱼雷威胁（接地）：有鱼雷的敌舰（DD/CL/CA/BC）在雷击窗口内威胁陡增——
  // 鱼雷能沉任何舰、与装甲无关，所以不能只看"它打不打得穿我"。
  // 史实：萨沃岛/塔萨法隆加夜战里，驱逐舰在 1.5~4km 一轮九三式雷就重创了重巡。
  torpedoThreatOf(ship, enemyType, rangeM) {
    if (!TORPEDO_TYPES_ALLOWED[enemyType]) return 0;
    const lo = 1500, hi = 8500;   // 雷击窗口（夜战更近、日间更远，取交集近似）
    if (rangeM < lo || rangeM > hi) return 0;
    const prox = clamp(1 - (rangeM - lo) / (hi - lo), 0, 1);  // 越近越危险（规避窗口越小）
    return 0.8 + 1.2 * prox;      // 0.8~2.0 的额外威胁
  }

  trackValue(e) {
    const base = TYPE_VALUE[e.classifiedAs] || 30;
    const conf = e.tr.confidence !== undefined ? e.tr.confidence : 0.5;
    const idc = e.tr.idConfidence !== undefined ? e.tr.idConfidence : 0.3;
    return base * (0.55 + 0.45 * conf) * (0.75 + 0.35 * idc);
  }
  label(e) { return (e.tr.classifiedAs || 'UNKNOWN') + (e.tr.id ? '(' + e.tr.id + ')' : ''); }

  // ── 全局态势判断：兵力比与阶段 ────────────────────────────────────────────
  assess(world, mine, enemies) {
    let own = 0;
    for (const s of mine) own += (TYPE_VALUE[s.type] || 25) * clamp(1 - this.damageScore(s).score * 0.55, 0.25, 1);
    let enemy = 0;
    for (const e of enemies) enemy += this.trackValue(e);
    this.fleet.ownValue = own;
    this.fleet.enemyValue = enemy;
    this.fleet.ratio = own / Math.max(1, enemy);
    // 威胁轴：按价值加权的敌方位圆均值
    let sx = 0, sy = 0;
    for (const e of enemies) { const v = this.trackValue(e); sx += Math.sin(e.bearingFromFlag * Math.PI / 180) * v; sy += Math.cos(e.bearingFromFlag * Math.PI / 180) * v; }
    this.fleet.threatAxisDeg = (sx || sy) ? normDeg(Math.atan2(sx, sy) * 180 / Math.PI) : null;
    // 敌方纵队航向（价值加权圆均值）与前导舰：雷击条令优先打战列线前导舰
    let cx = 0, cy = 0;
    for (const e of enemies) { const v = this.trackValue(e); const c = (e.tr.courseDeg || 0) * Math.PI / 180; cx += Math.sin(c) * v; cy += Math.cos(c) * v; }
    this.fleet.enemyCourseDeg = (cx || cy) ? normDeg(Math.atan2(cx, cy) * 180 / Math.PI) : null;
    this.fleet.vanTrackId = null;
    if (this.fleet.enemyCourseDeg !== null && enemies.length) {
      const ux = Math.sin(this.fleet.enemyCourseDeg * Math.PI / 180), uy = Math.cos(this.fleet.enemyCourseDeg * Math.PI / 180);
      let proj = -1e18;
      for (const e of enemies) { const pj = e.tr.pos.x * ux + e.tr.pos.y * uy; if (pj > proj) { proj = pj; this.fleet.vanTrackId = e.tr.id; } }
    }
    // 集火目标：射程内「价值高 × 可击沉」者（接地：用旗舰 killability 作舰队穿甲能力代理）
    let focus = null, best = -1;
    const prevFocus = this.fleet.focusTrackId;
    const flagShip = mine.find((s) => s.role === 'flagship') || mine[0];
    for (const e of enemies) {
      const inRange = e.rangeFromFlag < 26000;
      const pHit = flagShip ? this.estimateHitProb(flagShip, e, e.rangeFromFlag, world) : 0.05;
      // 集火焦点必须"打得到"：命中概率 <1.2% 的目标（如 22km 外的高价值雷达回波）
      // 别挂成全队焦点，否则主力舰跟着一个打不到、也无火控解算的目标走，白白停火。
      if (inRange && pHit < 0.012) continue;
      const kill = flagShip ? this.killability(flagShip, e.classifiedAs, e.rangeFromFlag) : 0.5;
      // 战列舰对敌主力舰：有敌方 BB/BC 在射程内时，不把火力浪费在巡洋舰/驱逐舰上
      // （旧打分里 7 km 的 CA 命中率高、击沉性好，会抢走全部火炮——史实俾斯麦打的是胡德/威尔士亲王）。
      const capPresent = enemies.some((x) => (x.classifiedAs === 'BB' || x.classifiedAs === 'BC') && x.rangeFromFlag <= (flagShip ? this.mainRange(flagShip) * 1.1 : 20000));
      if (capPresent && e.classifiedAs !== 'BB' && e.classifiedAs !== 'BC') continue;
      let sc = this.trackValue(e) * (inRange ? 1 : 0.4) * (0.4 + 1.2 * kill) * (0.3 + 4.0 * pHit);
      if (this.isObjectiveTarget(world, e.tr)) {
        sc *= 3.0;                                    // 任务目标是胜利条件：优先集火
        const pref2 = this.objectivePreferredId(world);
        const set2 = e.tr._trueIds;
        if (pref2 && set2 && set2.has(pref2)) sc *= 1.7;   // 锁定最好打沉的那艘（胡德）
        // 可击沉性：战巡（胡德）薄甲板、储备浮力小，比新式战列舰（威尔士亲王）容易击沉得多。
        // 任务只要求击沉任意一艘，所以应当集中打"最可能沉"的那艘，而不是价值最高的。
        if (e.classifiedAs === 'BC') sc *= 1.55;
        // 锁定：已锁定的任务目标在它沉没/丢失前不换（避免两台舰在两条航迹间来回搬火力）
        if (e.tr.id === prevFocus) sc *= 2.2;
      }
      if (e.tr.id === prevFocus) sc *= 1.25;          // 焦点迟滞：别让识别抖动把全队火力来回搬
      if (sc > best) { best = sc; focus = e; }
    }
    this.fleet.focusTrackId = focus ? focus.tr.id : null;
    this.fleet.focusLabel = focus ? this.label(focus) : '';
    const anyClose = enemies.some((e) => e.rangeFromFlag < 26000);
    const forced = this.fleetForcedWithdraw(world, own, enemy);
    // 滞回：航迹 churn 会让"敌值"在几秒内 80↔130 抖动，若每次 tick 直接翻 phase，
    // 舰队会在「脱离→交战→脱离」间反复横跳（sandbox 后半段就是这种振荡）。
    if (forced) {
      this.fleet._wdVotes = (this.fleet._wdVotes || 0) + 1;
      if (this.fleet._wdVotes >= 2) this.fleet.phase = 'WITHDRAW';
    } else {
      this.fleet._wdVotes = 0;
      if (this.fleet.phase === 'WITHDRAW') {
        this.fleet._reVotes = (this.fleet._reVotes || 0) + 1;
        if (this.fleet._reVotes >= 3) { this.fleet.phase = anyClose ? 'ENGAGE' : 'SEARCH'; this.fleet._reVotes = 0; }
      } else {
        this.fleet.phase = anyClose ? 'ENGAGE' : 'SEARCH';
      }
    }
    // 撤离/突破任务：有 EXIT 目标且（没有其它进攻目标 / 已被迫撤退）→ 全队向撤离区机动。
    // 旧实现只在 world.checkObjectives 里判定 EXIT、AI 从不导航，所以马塔潘、科曼多尔这类
    // "轴心只能靠撤离获胜"的剧本从结构上就不可能赢——AI 永远在原地对射直到被击沉。
    const exitObj = this.exitObjective(world);
    this._exit = exitObj;
    if (exitObj) {
      const offensive = this.hasOffensiveObjective(world);
      // DISENGAGE（撤离判据）任务：先按正常条令接战，只有被打到 WITHDRAW 才转撤离——
      // 否则一开局就背敌逃跑，马塔潘会变成"全程追击、零交战"（实测 3000 s 只 19 次命中）。
      // EXIT（抵达某海域）任务才允许从一开始就导航过去。
      const wantExit = exitObj.mode === 'DISENGAGE'
        ? (this.fleet.phase === 'WITHDRAW')
        : (!offensive || this.fleet.phase === 'WITHDRAW');
      if (wantExit) this.fleet.phase = 'EXIT';
    }
  }
  // 任务姿态：进攻性任务（突入/击沉/封锁）不允许因"兵力劣势"全队撤退——
  // 史实苏里高：西村舰队明知劣势仍必须突入莱特湾；旧逻辑用通用"打不过就撤"，
  // 导致轴心在 t≈300 s 就全队背敌，整场 40 分钟只打出几十发命中。
  hasOffensiveObjective(world) {
    const objs = (world.scenario && world.scenario.objectives) || [];
    for (const o of objs) {
      if (o.side !== this.side) continue;
      const t = o.condition && o.condition.type;
      if (t === 'SINK' || t === 'SINK_ANY' || t === 'SINK_COUNT' || t === 'DISABLE') return true;
    }
    return false;
  }
  exitObjective(world) {
    const objs = (world.scenario && world.scenario.objectives) || [];
    for (const o of objs) {
      if (o.side !== this.side) continue;
      const c = o.condition || {};
      if (c.type === 'EXIT') {
        const area = c.area || { x: 0, y: 0, r: 3000 };
        return { mode: 'AREA', area, any: c.any !== false };
      }
      if (c.type === 'DISENGAGE') return { mode: 'DISENGAGE', distanceM: c.distanceM || 25000, seconds: c.seconds || 600 };
    }
    return null;
  }

  missionAggressive(world) {
    const objs = (world.scenario && world.scenario.objectives) || [];
    for (const o of objs) {
      if (o.side !== this.side) continue;
      const t = o.condition && o.condition.type;
      if (t === 'EXIT' || t === 'SINK' || t === 'SINK_ANY' || t === 'SINK_COUNT' || t === 'DISABLE') return true;
    }
    return false;
  }

  // 舰队级撤退判据：兵力比低于剧本阈值 / 半数以上军舰重伤 / 旗舰重伤
  fleetForcedWithdraw(world, own, enemy) {
    const mine = world.afloatOf(this.side);
    if (!mine.length) return false;
    const aggressive = this.missionAggressive(world);
    const ratio = own / Math.max(1, enemy);
    const th = (world.sides && world.sides[this.side] && world.sides[this.side].withdrawThreshold) || 0.35;
    // 进攻任务：只有被打到接近崩溃（<阈值一半）才撤，否则继续压上
    if (enemy > 30 && ratio < th) return aggressive ? ratio < th * 0.5 : true;
    const hurt = mine.filter((s) => this.damageScore(s).score > 0.5).length;
    if (hurt / mine.length >= (aggressive ? 0.75 : 0.5) && ratio < 0.95) return true;
    const flag = mine.find((s) => s.role === 'flagship') || mine[0];
    // 旗舰重伤只在"舰队已处于劣势"时触发全队撤退；若战局占优（ratio≥1）不应因
    // 一艘旗舰受伤就让整队脱离——否则 sandbox 里会看到旗舰队在均势下提前全队撤退、
    // 后半段一炮不放（"脱离 全队背敌…撤退"）。
    if (flag && this.damageScore(flag).score > 0.85 && ratio < (aggressive ? 0.6 : 1.0)) return true;
    // 任务已达成（如已击沉一艘敌方主力舰）而对手仍有战力 → 见好就收，保存实力
    if (this.objectiveAchieved(world) && ratio < 1.8) return true;
    return false;
  }

  damageScore(ship) {
    // 口径统一到模块级 evaluateDamage（AI / 简报 / 测试共用）
    return evaluateDamage(ship);
  }
  shouldWithdraw(ship, dmg, world) {
    // 任务已达成的舰：带伤就撤（保留破交本钱），不再原地硬拼
    if (world && this.objectiveAchieved(world)) {
      if (dmg.score > 0.35 || dmg.flood > 0.12 || dmg.list > 8) return true;
    }
    // B1 阈值表（进水% / 航速上限 / 主炮损失 / 横倾 / 综合损伤分，见 DAMAGE_DOCTRINE）
    if (this.doctrineOn) {
      if (damageVerdict(ship, dmg, this.dmgDoctrine).withdraw) return true;
    } else {
      // 旧阈值（B1 之前）：只对"明显要沉/已经瘫痪"的损伤反应，这正是旧 AI 挨打不走的缺口
      const spdMax = Math.max(1, ship.data.speedMax_kn || 25);
      if (clamp((ship.speedCapKn || spdMax) / spdMax, 0, 1) < 0.62) return true;
      if (dmg.score > 0.6 || dmg.flood > 0.33 || dmg.list > 18) return true;
      const heavy = ship.type === 'BB' || ship.type === 'BC' || ship.type === 'CA';
      if (heavy && dmg.gunLoss > 0.5) return true;
    }
    // 火控是"还能不能还手"的硬指标：指挥仪全毁（非驱逐舰）或只剩一台也要脱离
    // （史实：丹麦海峡 PoW 主炮损失过半、火控受损即脱离，没有主力舰在原地挨打）
    const dirs = ship.directors || [];
    const dirsAlive = dirs.filter((d) => !d.destroyed && (d.health === undefined || d.health > 0.2)).length;
    const heavyUnit = ship.type === 'BB' || ship.type === 'BC' || ship.type === 'CA';
    if (heavyUnit && dirs.length && dirsAlive === 0) return true;
    if (heavyUnit && dirs.length >= 2 && dirsAlive <= 1) return true;
    return false;
  }

  // ── 受损脱离条令（B1）：退出战列线 → 施烟 → 向本方/远离敌方向脱离 ──────────
  leaveLine(world, ship, mem, notes, verdict) {
    const v = verdict || mem.verdict || damageVerdict(ship, this.damageScore(ship), this.dmgDoctrine);
    this.order(world, { shipId: ship.id, kind: 'WITHDRAW', params: {} });
    const h = this.retreatHeading(world, ship);
    this.setCourse(world, ship, h, mem, true);
    // 航速：按「剩余航速上限」而非设计航速下令（动力舱已损时命令 30 节只会让它掉队）
    const kn = Math.min(ship.data.speedMax_kn || 30, ship.speedCapKn || (ship.data.speedMax_kn || 30));
    this.setSpeed(world, ship, kn, mem, true);
    if (this.smoke(world, ship, true) && notes) notes.push('【烟幕】' + ship.name + ' 施放烟幕掩护脱离');
    mem.lastRetreatSmoke = world.t;
    this.fleet.withdrawing = this.fleet.withdrawing || {};
    this.fleet.withdrawing[ship.id] = world.t;
    if (notes) notes.push('【退出】' + ship.name + ' 判定重伤（' + v.triggers.join('/') + '）→ 脱离战列线 航向' + Math.round(h) + '° 施烟');
  }
  // 威胁方位（用于避开敌人、派僚舰掩护）：优先用编队威胁轴，其次用最近敌舰方位
  threatBearing(world, ship) {
    if (this.fleet.threatAxisDeg !== null && this.fleet.threatAxisDeg !== undefined) return this.fleet.threatAxisDeg;
    let best = null, bd = 1e9;
    for (const f of world.afloatOf(world.opposite(this.side))) {
      const d = dist2d(ship.pos, f.pos);
      if (d < bd) { bd = d; best = f; }
    }
    return best ? bearing2d(ship.pos, best.pos) : null;
  }

  // ── 任务感知（战役目标）────────────────────────────────────────────────────
  // 读剧本 objectives 的机器可读条件（SINK / SINK_ANY / DISABLE），据此决定"打谁、
  // 打沉之后要不要继续拼"。史实：吕特晏斯在击沉胡德后选择脱离保舰，而不是原地耗到被打瘫。
  myObjectives(world) {
    if (this._objCache !== undefined && this._objWorld === world) return this._objCache;
    const objs = (world && world.scenario && world.scenario.objectives) || [];
    this._objCache = objs.filter((o) => o.side === this.side);
    this._objWorld = world;
    return this._objCache;
  }
  objectiveTargetIds(world) {
    const ids = [];
    for (const o of this.myObjectives(world)) {
      const c = o.condition || {};
      if (c.type === 'SINK' || c.type === 'SINK_ANY' || c.type === 'DISABLE') {
        for (const id of (c.shipIds || [])) if (ids.indexOf(id) < 0) ids.push(id);
      }
    }
    return ids;
  }
  objectiveAchieved(world) {
    for (const o of this.myObjectives(world)) { if (world._objectiveMet && world._objectiveMet(o)) return true; }
    return false;
  }
  // 任务目标里"最好打沉"的那条：按真实舰种排序（战巡 > 老式战列舰 > 新式战列舰）
  objectivePreferredId(world) {
    const ids = this.objectiveTargetIds(world);
    let best = null, bestRank = -1;
    for (const id of ids) {
      const s = world.ship ? world.ship(id) : null;
      if (!s) continue;
      const rank = s.type === 'BC' ? 3 : s.type === 'CV' ? 2 : (s.armor && s.armor.deck_mm && s.armor.deck_mm < 120) ? 2 : 1;
      if (rank > bestRank) { bestRank = rank; best = id; }
    }
    return best;
  }
  isObjectiveTarget(world, track) {
    if (!track) return false;
    const ids = this.objectiveTargetIds(world);
    if (!ids.length) return false;
    // T2 航迹把真实舰种收在 _trueIds（Set）里：命中识别后才知道打的是不是任务目标
    const set = track._trueIds;
    if (set && typeof set.has === 'function') {
      for (const id of ids) if (set.has(id)) return true;
      return false;
    }
    const sid = track.targetId || track.targetShipId || null;
    return !!(sid && ids.indexOf(sid) >= 0);
  }

  // ── 火力分配 ──────────────────────────────────────────────────────────────
  estimateHitProb(ship, e, rangeM, world) {
    const mains = ship.mainBatteries || [];
    if (!mains.length) return 0.02;
    let maxR = 0;
    for (const b of mains) maxR = Math.max(maxR, (b.data && b.data.maxRange_m) || 20000);
    if (rangeM > maxR) return 0;
    // 接地：用模拟 fireSalvo 的散布口径（单炮 0.7%R+38 / 0.38%R+16）+ 齐射级横摇/运动误差，
    // 对目标舰体投影（长×宽）求 2D 高斯命中率。替代 0.26·(1-frac)^1.6 的拍脑袋曲线——
    // 旧曲线 8km 处估 ~11%，比实测 ~3% 高约 3 倍，导致 AI 的"该不该打/打谁"判断失真。
    const L = TYPE_LENGTH_M[e.classifiedAs] || 130;
    const W = L * 0.13;                                     // 典型长宽比 ~7.7
    const sigmaRange = 0.011 * rangeM + 60;                 // 距离向 1σ（含齐射仰角/目标运动）
    const sigmaDefl = 0.009 * rangeM + 40;                  // 方向向 1σ（含齐射方位/目标运动）
    let p = (L * W) / (2 * Math.PI * sigmaRange * sigmaDefl);
    const brg = bearing2d(ship.pos, e.tr.pos);
    const aspect = aspectAngle(e.tr.courseDeg || 0, brg) * Math.PI / 180;
    p *= 0.62 + 0.55 * Math.abs(Math.sin(aspect));           // 舷侧投影大
    p *= clamp(1.15 - (e.tr.speedKn || 15) * 0.012, 0.7, 1.1);
    const fc = ship.fireControlOperational ? 1 : 0.35;
    p *= fc;
    const sea = world.env && world.env.seaState !== undefined ? world.env.seaState : 2;
    p *= clamp(1 - 0.05 * sea, 0.6, 1);
    p *= clamp(0.65 + 0.35 * (ship.crewQuality || 0.85) / 0.85, 0.6, 1.15);
    // 本舰剧烈横摇时测距/解算变差
    p *= clamp(1 - Math.abs(ship.roll || 0) * 0.012, 0.7, 1);
    return clamp(p, 0, 0.5);
  }

  // ── 决战距离/条令带 ────────────────────────────────────────────────────────
  decisiveBand(ship, enemyType, world) {
    const env = (world && world.env) || {};
    const light = env.lightLevel !== undefined ? env.lightLevel : 1;
    let visNm = env.visibilityNm !== undefined ? env.visibilityNm : 12;
    if (env.horizontalVisibilityNm) { try { visNm = env.horizontalVisibilityNm(ship); } catch (e2) { /* 保持默认 */ } }
    // 昼夜判定用太阳高度角（比光照强度更稳）：< -6° 为夜战，-6°~+6° 为晨昏微光（取日间带的 0.75）
    const sunAlt = env.sunAltDeg !== undefined && env.sunAltDeg !== null ? env.sunAltDeg : null;
    const night = sunAlt !== null ? sunAlt < -6 : (light < 0.10);
    const dusk = !night && (sunAlt !== null ? sunAlt < 6 : light < 0.35);
    const T = DECISIVE_BAND[ship.type] ? ship.type : 'DD';
    let band = (night ? DECISIVE_BAND[T].night : DECISIVE_BAND[T].day.map((v) => v * (dusk ? 0.75 : 1))).slice();
    // 能见度上限：看不见就打不准——交战带外沿不超过有效水平能见度的 1.4 倍
    const visM = visNm * 1852;
    const visCap = clamp(visM * 1.4, 4000, 30000);
    band[1] = Math.min(band[1], visCap);
    band[0] = Math.min(band[0], band[1] * 0.8);
    const radar = (ship.sensors || []).some((s) => s.srcKind === 'RADAR' && s.on && !s.destroyed && (!s.data || s.data.hasRange !== false));
    if (night && radar) band = [band[0] + 1200, band[1] + 1800];   // 夜间雷达火控优势：先敌开火
    else if (night && !radar) band = [band[0] * 0.85, band[1] * 0.60]; // 无雷达的夜战条令：必须逼近
    // （史实：萨沃岛日军无雷达，靠夜视光学与探照灯逼近到 1.5~3km 才开火；有雷达的美舰在 8~10km 先发现）
    const iz = immuneZoneVs(ship, enemyType);
    if (iz.valid) {                                                 // 决战距离内再讲免疫区
      const lo = Math.max(band[0], iz.innerM * 1.02), hi = Math.min(band[1], iz.outerM * 0.98);
      if (lo <= hi) band = [lo, hi];
    }
    // 日间主力舰（BB/BC）不得把交战距离压进 10km 以内（史实 14-18km；近于 10km 会进入
    // 对方驱逐舰雷击窗口）。夜战/晨昏另有条令，不在此列。
    if (!night && (ship.type === 'BB' || ship.type === 'BC')) {
      band[0] = Math.max(band[0], 10000);
      band[1] = Math.max(band[1], 13000);
    }
    return { min: band[0], max: band[1], night, visNm, radar, iz, label: night ? '夜战' : '日间' };
  }

  // ── 火控质量门限 ──────────────────────────────────────────────────────────
  // 判据：读模拟刚算出的火控解算质量（quality），而不是 AI 自己估的命中率。
  // 人类指挥官看的是"我的火控锁没锁、解算稳不稳、航迹准不准"，而不是一个拍脑袋的百分比。
  currentSolution(ship, track) {
    const dirs = ship.directors || [];
    for (const d of dirs) {
      if (!d || d.destroyed || (d.health !== undefined && d.health <= 0.2)) continue;
      const sol = d.solution || (d._fc && d._fc.solution);
      if (!sol) continue;
      if (sol.trackId === track.id) return sol;
      // 航迹 id 翻新（失跟-重捕）时同一真实目标的新旧航迹 id 不同：火控还在追旧 id、
      // AI 已指向新 id → 按"真实舰 id"匹配，避免 fireGate 长期卡在"火控锁定中"。
      if (sol.targetShipId && track.trueIds && Array.isArray(track.trueIds) && track.trueIds.includes(sol.targetShipId)) return sol;
    }
    return null;
  }

  fireGate(ship, e, r, world) {
    const tr = e.tr || {};
    const bat = (ship.mainBatteries || [])[0];
    if (!bat || bat.destroyed || bat.health < 0.2) return { fire: false, reason: '主炮不可用' };
    if (r > this.mainRange(ship) * 0.95) return { fire: false, reason: '超出主炮射程' };
    const age = tr.ageS !== undefined ? tr.ageS : 0;
    if (age > 40) return { fire: false, reason: '航迹过旧 ' + Math.round(age) + 's' };
    const ammo = this.pickAmmo(ship, e, r);
    const totalAmmo = (bat.ammo.AP || 0) + (bat.ammo.HE || 0);
    const load = bat.data && bat.data.ammo ? ((bat.data.ammo.AP || 0) + (bat.data.ammo.HE || 0)) : 0;
    const ammoFrac = load ? totalAmmo / load : 1;
    const targetLen = TYPE_LENGTH_M[e.classifiedAs] || 130;
    // 识别：航迹给出舰种，或中近距离（≤20km，目视可辨舰型/桅高）且置信度可接受。
    // 旧值 15km 在苏里高这类 20~30km 战列线对射里会让双方全程判"识别不足"而不开火。
    const identified = e.classifiedAs !== 'UNKNOWN' || (r <= 20000 && (tr.confidence === undefined || tr.confidence >= 0.35));
    const goodSolution = (tr.errM === undefined || tr.errM <= Math.max(targetLen, 250)) && (tr.errDeg === undefined || tr.errDeg <= 3);
    const band = this.decisiveBand(ship, e.classifiedAs, world);
    const rel = r / Math.max(1000, band.max);
    const inBand = rel <= 1.35;          // 带内/带外沿都算"有效交战距离"

    // 读模拟的真实火控解算（updateFireControl 已在本 tick 算好，存于 director.solution）
    const sol = this.currentSolution(ship, tr);
    const q = sol ? sol.quality : 0;
    // 远距无效射击：估命中率 <0.6% 且距离 >14 km 时不再开火（省弹，也让 AI 有动力接近）。
    // 例外：有对海雷达火控且解算稳定（q≥0.8）——史实苏里高/瓜岛的美舰就是靠雷达在 14~18 km 打准。
    // 旧行为在苏里高实测：2400 s 打出 2,800+ 发、命中 <60（大部分是 16 km 外的无效射击）。
    const radarFC = (ship.sensors || []).some((s) => s.srcKind === 'RADAR' && s.on && !s.destroyed && (!s.data || s.data.hasRange !== false));
    if (r > 14000 && !(radarFC && q >= 0.8) && this.estimateHitProb(ship, e, r, world) < 0.006) {
      return { fire: false, ammo, reason: '远距命中率过低，接近再打' };
    }

    // 人类式分层：
    //  1) 火控还没锁上这条航迹 → 打一发校射建立解算（"开火试探"，先校射再齐射）；
    //  2) 解算质量足够（quality 收敛）→ 全齐射；
    //  3) 解算质量不足 → 单发校射继续收敛；
    //  4) 识别不足 / 航迹误差大 → 也只打校射，不倾泻。
    if (!sol) {
      // 纯方位航迹（水听器/声呐无测距）永远算不出火控解算 → 不下开火令。
      // 否则 FIRE 命令"被接受"（order.effective applied=true）但火控永远解不出弹道，
      // 一发 gun.fire 都不产生——AI 却以为自己在射击、不再重发，整舰"假射击"几十分钟。
      if (tr.bearingOnly === true || tr.hasRange === false) return { fire: false, ammo, reason: '纯方位航迹，无法解算' };
      // 还没建立解算时先打一发校射来"喂"解算（这正是校射的意义）。
      // 只有"远距 + 识别不足"才压住火力（避免 20km 外对不明目标乱放暴露阵位）。
      const mainR = this.mainRange(ship);
      if (!identified && r > Math.min(20000, mainR * 0.8)) return { fire: false, ammo, reason: '识别不足，火控未锁定' };
      if (ammoFrac < 0.1) return { fire: false, ammo, reason: '弹药不足' };
      return { fire: true, ammo, salvoes: 1, mode: 'SPOT', reason: '火控锁定中，单发校射' };
    }
    const fullQ = (inBand ? 0.24 : 0.5) * (band.night ? 1.25 : 1.0);   // 带内 0.24 即可全齐射；带外要更稳才倾泻。夜战再 +25%（炮口闪光暴露阵位，史实条令）
    // 未识别舰种但解算已收敛 -> 允许齐射：远距编队里"UNKNOWN"是常态，
    // 若一律只打单发，整条战列线会长期停在低射速的校射状态。
    if (!identified && q < 0.6) return { fire: true, ammo, salvoes: 1, mode: 'SPOT', reason: '识别不足' };
    if (!goodSolution) return { fire: true, ammo, salvoes: 1, mode: 'SPOT', reason: '航迹误差大，单发校射' };
    if (ammoFrac < 0.25) return { fire: true, ammo, salvoes: 1, mode: 'SPOT', reason: '弹药不足，节约校射' };
    if (q >= fullQ) return { fire: true, ammo, salvoes: Infinity, mode: 'FULL', reason: '解算质量' + (100 * q).toFixed(0) + '% 全齐射' };
    if (q >= 0.12) return { fire: true, ammo, salvoes: 1, mode: 'SPOT', reason: '解算质量' + (100 * q).toFixed(0) + '% 单发校射' };
    return { fire: false, ammo, reason: '解算质量' + (100 * q).toFixed(0) + '% 过低' };
  }

  assignTargets(world, mine, enemies, R) {
    if (!enemies.length) {
      for (const s of mine) {
        const mem = this.memFor(s);
        this.ceaseFire(world, s, mem, true);
      }
      return;
    }
    // 火力分配：统计每条敌舰当前被我方几艘舰集火。史实教范要"集中射撃"，但不是 5 艘打 1 艘
    // 驱逐舰、战列舰却无人问——这里做的是"分配"而不是"扎堆"。
    const engaged = new Map();
    for (const s2 of mine) {
      const m2 = this.memFor(s2);
      if (m2 && m2.firing && m2.targetTrackId) engaged.set(m2.targetTrackId, (engaged.get(m2.targetTrackId) || 0) + 1);
    }
    const spreadOK = mine.length >= enemies.length;   // 我方舰数不占优时不铺开，改为集中火力
    // 接地：舰数占优还不够，得有穿甲能力才铺开——否则集中火力集火一个（打不穿就攒伤害）
    const flagShip2 = mine.find((s) => s.role === 'flagship') || mine[0];
    let avgKill = 0;
    if (flagShip2 && enemies.length) {
      for (const e2 of enemies) avgKill += this.killability(flagShip2, e2.classifiedAs, e2.rangeFromFlag !== undefined ? e2.rangeFromFlag : dist2d(flagShip2.pos, e2.tr.pos));
      avgKill /= enemies.length;
    }
    const canSpread = spreadOK && avgKill > 0.4;
    const envA = (world && world.env) || {};
    const nightA = (envA.sunAltDeg !== undefined && envA.sunAltDeg !== null) ? envA.sunAltDeg < -6 : ((envA.lightLevel || 1) < 0.10);
    for (const ship of mine) {
      const mem = this.memFor(ship);
      if (mem.withdraw) {
        this.ceaseFire(world, ship, mem, false);
        continue;
      }
      let best = null, bestScore = -1;
      let bestFree = null, bestFreeScore = -1;   // 未达集火上限的目标（优先）
      for (const e of enemies) {
        const r = dist2d(ship.pos, e.tr.pos);
        const pHit = this.estimateHitProb(ship, e, r, world);
        // "值不值得打"的下限：旧值 1.2% 会让 10~20km 的驱逐舰/远距主力舰全部被过滤，
        // 整支舰队因为"估计打不中"而完全沉默（实测苏里高轴心 5km 打 1744 发只有 7 中，
        // 因为大部分时间一个目标都不选）。真实条令是"在有效射程内就校射压制"。
        if (pHit < 0.004) continue;
        const v = this.trackValue(e);
        // 威胁：敌主炮口径量级 × 逼近程度（对方越近威胁越大）
        // 威胁（接地：敌口径能否打穿我方装甲带 × 逼近程度）
        // 威胁（接地：敌炮能否打穿我方装甲 × 逼近 + 鱼雷窗口威胁）
        const threat = this.threatOf(ship, e.classifiedAs, r) + this.torpedoThreatOf(ship, e.classifiedAs, r);
        // 可击沉性（接地：能否穿甲 × 吨位倒数）——人类指挥官不会把炮弹浪费在打不穿的目标上
        const kill = this.killability(ship, e.classifiedAs, r);
        let score = v * (0.55 + 0.6 * threat) * (0.25 + 3.2 * pHit) * (0.4 + 1.2 * kill);
        // 补刀：航迹航速明显低于舰种典型值 → 目标已重伤（进水/动力损），集中火力了结它
        const typSpd = ({ CV: 30, BB: 28, BC: 30, CA: 32, CL: 33, DD: 35, UNKNOWN: 28 })[e.classifiedAs] || 28;
        if (e.tr.speedKn !== undefined && e.tr.speedKn > 0 && e.tr.speedKn < typSpd * 0.55) score *= 1.45;
        // 但已明显失能（航速塌到 ~0，正在下沉/弃舰）就别再浪费弹药——转去打还在动的目标
        if (e.tr.speedKn !== undefined && e.tr.speedKn < 3) score *= 0.30;
        const nEng = engaged.get(e.tr.id) || 0;
        // 任务目标（胜利条件）优先；同类里优先更好打沉的（战巡 > 新式战列舰）
        if (this.isObjectiveTarget(world, e.tr)) {
          score *= 1.70;
          if (e.classifiedAs === 'BC') score *= 1.45;
          // 按真实舰种锁定"最好打沉的"（胡德是战巡，装甲与储备浮力都远不如新式战列舰）
          const pref = this.objectivePreferredId(world);
          if (pref) { const set = e.tr._trueIds; if (set && set.has(pref)) score *= 1.60; }
          if (e.tr.id === this.fleet.focusTrackId) score *= 1.30;
        } else if (this.objectiveTargetIds(world).length && (e.classifiedAs === 'BB' || e.classifiedAs === 'BC' || e.classifiedAs === 'CV')) {
          score *= 0.55;   // 有明确任务目标时，别把火力浪费在另一艘主力舰/巡洋舰上
        }
        // 劣势时集中火力：把全队压在编队焦点目标上，而不是分散成两处各打各的
        if (!canSpread && e.tr.id === this.fleet.focusTrackId) score *= 1.45;
        if (nEng === 0) score *= canSpread ? 1.30 : 0.85;                      // 占优且能穿甲才铺开分配
        else if (nEng >= 3) score *= 0.45;                                     // 最多 3 艘集火同一目标
        else if (nEng >= 2 && !HVU_TYPES[e.classifiedAs]) score *= 0.55;        // 非高价值目标不扎堆
        if (e.tr.id === this.fleet.focusTrackId) score *= 1.25;               // 集火加成
        if (mem.targetTrackId === e.tr.id) score *= 1.25;                     // 目标连续性（抑制识别抖动导致的换目标）
        else score *= 0.78;                                                    // 换目标惩罚
        if (ship.type === 'DD' && ARMORED_TYPES[e.classifiedAs]) score *= 0.4; // 驱逐舰不硬拼装甲目标
        // 巡洋舰不拿自己的舷侧去换战列舰的炮弹（远距对射纯亏），优先打同级或驱逐舰
        const heavyMe = ship.type === 'BB' || ship.type === 'BC' || ship.type === 'CV';
        if (!heavyMe && (e.classifiedAs === 'BB' || e.classifiedAs === 'BC') && r > 10000) score *= 0.25;
        if (ship.type === 'DD' && (e.classifiedAs === 'DD' || e.classifiedAs === 'CL') && r < 11000) score *= 1.5;
        if (ship.type === 'BB' && e.classifiedAs === 'DD' && r > 12000) score *= 0.5;
        if (score > bestScore) { bestScore = score; best = { e, r, pHit }; }
        // 硬上限：同一目标最多 3 艘舰集火（高价值目标放宽到 4），其余舰转向次优目标
        const cap = HVU_TYPES[e.classifiedAs] ? 4 : 3;
        if ((engaged.get(e.tr.id) || 0) < cap && score > bestFreeScore) { bestFreeScore = score; bestFree = { e, r, pHit }; }
      }
      if (bestFree) best = bestFree;
      // 关键：在同一轮分配里立即记账，否则所有舰都看到"空"而扎堆同一个目标
      if (best) { const bid = best.e.tr.id; engaged.set(bid, (engaged.get(bid) || 0) + 1); }
      if (!best) {
        this.ceaseFire(world, ship, mem, true);
        continue;
      }
      mem.lastTargetT = world.t;          // 目标短暂消失时的停火抑制依赖这个时间戳
      const gate = this.fireGate(ship, best.e, best.r, world);
      if (!gate.fire) {
        // 停火判据需要连续两轮一致：单轮解算抖动（距离/误差/概率在门限附近摆动）不改变火力状态
        mem.gateFailN = (mem.gateFailN || 0) + 1;
        if (mem.gateFailN >= 2) this.ceaseFire(world, ship, mem, false);
        if (mem.gateReason !== gate.reason) { mem.gateReason = gate.reason; R.push('【控火】' + ship.name + '→' + this.label(best.e) + ' ' + gate.reason + ' → 暂不开火'); }
        continue;
      }
      mem.gateFailN = 0;
      // 目标连续性节流：T2 航迹 id 会随传感器更新不断翻新（T2→T6→T17…），若每轮都按
      // "最佳目标"重发 ASSIGN_TARGET，只是在纸面上换靶——火力没变、命令却翻倍。当前目标
      // 仍在视野内时，至少 targetHoldS（默认 60s）不换靶；目标丢失/沉没才立即重选。
      if (mem.targetTrackId && mem.targetTrackId !== best.e.tr.id) {
        const curStill = enemies.some((x) => x.tr.id === mem.targetTrackId);
        if (curStill && world.t - mem.lastAssignT < this.targetHoldS) continue;
        // B1：当前目标「刚失跟」（航迹 id 翻新 / 烟幕·陆地 LOS 遮断）时按住 targetChurnHoldS
        // 不换靶：T2 航迹在海岸/烟幕附近会反复失跟-重捕，旧逻辑每次都用新 id 重发 FIRE
        // （实测第一次瓜岛 600s FIRE 命令 188 条）。但不能按 targetLostHoldS(45s) 那么久：
        // 45s 会让舰在失跟窗口里对真正的新目标也不开火，实测萨沃岛 gun.hit 从 127 掉到 39。
        // 【修复】原用 lastTargetT（每 tick 都刷新）导致 world.t-lastTargetT≈0 < 12s 恒成立，
        // 目标一失跟就永久卡在"不换靶"→ 整场停火（丹麦海峡盟军四舰各只打 8-16 发）。
        // 改用 lastAssignT（最后一次真正指派目标的时间），12s 后才允许换靶重打。
        if (!curStill && world.t - (mem.lastAssignT || -1e9) < this.targetChurnHoldS) continue;
      }
      const targetChanged = mem.targetTrackId !== best.e.tr.id || mem.ammo !== gate.ammo;
      // 夜间照明：目标在夜暗中未被识别时打照明弹（史实：日军在萨沃岛大量使用照明弹与探照灯）。
      // 全队协调：不是每艘舰各自每 45s 打一轮（实测 20 艘舰 10 分钟能刷 82 条照明命令）。
      if (nightA && best.e.classifiedAs === 'UNKNOWN' && best.r < 14000 &&
          (world.t - (mem.lastStar || -1e9)) > this.starHoldS &&
          (world.t - (this.fleet.lastStarT || -1e9)) > this.starFleetHoldS) {
        const starBat = (ship.mainBatteries || []).find((b) => !b.destroyed && b.data && b.data.ammo && (b.data.ammo.STAR || 0) > 0);
        if (starBat) {
          this.order(world, { shipId: ship.id, kind: 'FIRE', params: { trackId: best.e.tr.id, ammo: 'STAR', salvoes: 1, battery: 'main' } });
          mem.lastStar = world.t;
          this.fleet.lastStarT = world.t;
          R.push('【照明】' + ship.name + ' 发射照明弹照亮 ' + this.label(best.e) + '（' + (best.r / 1000).toFixed(1) + 'km）');
        }
      }
      // 开火命令抑制：单发校射（salvoes=1）打完后 commanded.firing 会翻 false，旧逻辑下一
      // 个 8s 决策周期就重发一次 FIRE；目标/弹种/模式都没变时这只是重复命令。现在同目标
      // 至少隔 fireHoldS（默认 60s）才重发，目标/弹种变化仍然立即生效（持续齐射模式下
      // commanded.firing 一直为 true，gunnery 的实际射速不受这条限制影响）。
      const fireModeChanged = mem.fireMode !== gate.mode;
      // 注意不能只看 mem.firing：目标航迹翻新后 commanded.targetTrackId 可能仍指向已消亡的旧航迹，
      // 此时 gunnery 会清掉 commanded.firing（见 updateFireControl 的 TARGET_LOST 分支），
      // 但更需要 AI 侧主动重发 FIRE——所以 targetChanged 也要能打破"看起来正在射击"的状态。
      if (!mem.firing || !ship.commanded.firing || fireModeChanged || targetChanged) {
        const modeCooldownOk = world.t - mem.lastFireT >= this.fireModeHoldS;
        if (targetChanged || (fireModeChanged && modeCooldownOk) || world.t - mem.lastFireT >= this.fireHoldS) {
          // 首次指定目标单独发 ASSIGN_TARGET（保留"指定目标"这一可读事件）；此后换靶时
          // FIRE 命令本身已带 trackId+ammo，再发 ASSIGN_TARGET 纯属重复。
          if (mem.targetTrackId === null) {
            this.order(world, { shipId: ship.id, kind: 'ASSIGN_TARGET', params: { trackId: best.e.tr.id, ammo: gate.ammo } });
          }
          this.order(world, { shipId: ship.id, kind: 'FIRE', params: { trackId: best.e.tr.id, ammo: gate.ammo, salvoes: gate.salvoes } });
          if (targetChanged) R.push('【火力】' + ship.name + '→' + this.label(best.e) + ' ' + (best.r / 1000).toFixed(1) + 'km ' + gate.reason + ' 用' + gate.ammo);
          mem.targetTrackId = best.e.tr.id; mem.ammo = gate.ammo; mem.lastAssignT = world.t;
          mem.firing = true; mem.fireMode = gate.mode; mem.lastFireT = world.t;
          // ── 副炮 ────────────────────────────────────────────────────────
          // 主炮对付装甲目标时副炮并不闲着：近距/中小目标用副炮补刀（射速快、弹道平）。
          // 走独立命令通道（battery:'secondary'），有自己的目标/弹药/节流，不阻塞主炮齐射。
          // 只算对海副炮（role='secondary'），不含高射炮（role='aa'）
          const secBats = (ship.secondaryBatteries || []).filter((b2) => b2.role === 'secondary'
            && !b2.destroyed && (b2.health === undefined || b2.health > 0.15)
            && (((b2.ammo && b2.ammo.HE) || 0) + ((b2.ammo && b2.ammo.AP) || 0)) > 0);
          if (secBats.length) {
            const secRange = Math.max.apply(null, secBats.map((b2) => (b2.data && b2.data.maxRange_m) || 10000));
            const secInRange = best.r <= secRange * 0.9;
            const secTargetChanged = mem.secTargetTrackId !== best.e.tr.id;
            if (secInRange && (secTargetChanged || world.t - (mem.lastSecFireT || -1e9) >= 60)) {
              this.order(world, {
                shipId: ship.id, kind: 'FIRE',
                params: { trackId: best.e.tr.id, ammo: 'HE', salvoes: Infinity, battery: 'secondary' },
              });
              mem.lastSecFireT = world.t; mem.secTargetTrackId = best.e.tr.id;
              if (secTargetChanged) R.push('【副炮】' + ship.name + ' 副炮对' + this.label(best.e) + ' ' + (best.r / 1000).toFixed(1) + 'km 开火');
            }
          }
          if (gate.mode === 'SPOT') R.push('【控火】' + ship.name + ' ' + gate.reason + '（节约弹药，待距离缩短/解算收敛）');
        } else {
          // 被节流：跟随实际 commanded 状态，避免把"已在持续射击"误记成"还需要下令"
          mem.firing = !!ship.commanded.firing;
        }
      }
      mem.gateReason = null;
    }
  }

  pickAmmo(ship, e, rangeM) {
    const b = (ship.mainBatteries || [])[0];
    const ap = b ? b.ammo.AP : 0, he = b ? b.ammo.HE : 0;
    const prof = TYPE_COMBAT_PROFILE[e.classifiedAs] || TYPE_COMBAT_PROFILE.UNKNOWN;
    // 弹药选择：
    //  · 软目标（无主装甲带，带 ≤25 mm）：HE——AP 会过穿、引信不触发；
    //  · 装甲目标：**一律首选穿甲弹**。即使当前距离的估算穿深不足，AP 仍有跳弹/部分穿透/
    //    打进弹药库与动力舱的机会，而 HE 对装甲带几乎无效——实测丹麦海峡变体局里
    //    威尔士亲王打俾斯麦 533 发 HE、零穿透，等于白打。穿深不足时更该用 AP 去赌要害，
    //    而不是用 HE 洗甲板。
    let want = (prof.belt_mm <= 25) ? 'HE' : 'AP';
    if (want === 'AP' && ap <= 0) want = he > 0 ? 'HE' : 'AP';
    if (want === 'HE' && he <= 0) want = ap > 0 ? 'AP' : 'HE';
    return want;
  }

  // ── 机动：T 字位 / 免疫区 / 夜间保守 ──────────────────────────────────────
  maneuver(world, mine, enemies, R) {
    const hvuPresent = mine.some((s) => HVU_TYPES[s.type] && !this.memFor(s).withdraw);
    const centroid = this.centroid(mine);   // 编队形心（用于战斗凝聚力安全网）
    for (const ship of mine) {
      const mem = this.memFor(ship);
      if (mem.withdraw) continue;
      // 战斗凝聚力安全网：任何非撤离舰离编队形心过远（>25km）就掉头归队。
      // 防止"前出掩护/雷击脱离"等任务把单舰带出战场一去不回（沙盒实测奥班农曾离队 29km）。
      if (mine.length > 1) {
        const dc = dist2d(ship.pos, centroid);
        if (dc > 25000 && this.setCourse(world, ship, bearing2d(ship.pos, centroid), mem)) {
          R.push('【归队】' + ship.name + ' 距编队' + Math.round(dc / 1000) + 'km → 掉头归队');
          continue;
        }
      }
      if (world.t < mem.evadeUntil) continue;               // 避雷机动优先
      // B1：正在雷击突击/发射后脱离的舰由 torpedoAttack 指挥，战列线机动让位
      if (mem.attacking && world.t < mem.attacking) continue;
      // B1：被派去掩护脱离舰的僚舰由 escortWithdrawers() 指挥
      if (mem.escortOf && world.t - (mem.escortT || -1e9) < 90) continue;
      // 屏护舰的航路由 screen() 安排（占位/前出），只有在无屏护对象时才自行机动
      if (hvuPresent && (ship.type === 'DD' || ship.type === 'CL')) continue;
      // B1：发射鱼雷后的转向脱离（与射向垂直，横过后再拉开），由 fireTorpedoes 记下
      if (mem.torpTurn && world.t < mem.torpTurn.until) {
        if (this.setCourse(world, ship, mem.torpTurn.h, mem)) R.push('【雷击·脱离】' + ship.name + ' 发射后转向 ' + Math.round(mem.torpTurn.h) + '°');
        this.setSpeed(world, ship, ship.data.speedMax_kn || 30, mem);
        continue;
      }
      const light = world.env && world.env.lightLevel !== undefined ? world.env.lightLevel : 1;
      const night = light < 0.15;
      // 目标
      // 机动目标用「编队焦点」（稳定，含迟滞）；开火目标仍可用各舰自己的解算目标
      let e = null;
      if (this.fleet.focusTrackId) e = enemies.find((x) => x.tr.id === this.fleet.focusTrackId) || null;
      if (!e && mem.targetTrackId) e = enemies.find((x) => x.tr.id === mem.targetTrackId) || null;
      if (!e) e = enemies.find((x) => dist2d(ship.pos, x.tr.pos) < 26000) || null;
      if (!e) { this.searchMove(world, ship, mem, night); continue; }

      const r = dist2d(ship.pos, e.tr.pos);
      const enemyCourse = e.tr.courseDeg !== undefined ? e.tr.courseDeg : bearing2d(ship.pos, e.tr.pos);
      const band = this.decisiveBand(ship, e.classifiedAs, world);
      // 接地：按穿甲不对称微调交战带——我能打穿它/它打不穿我 → 贴近；反之 → 拉开
      const verdict = this.rangeVerdict(ship, e.classifiedAs, r);
      if (verdict === 'CLOSE') { band.min *= 0.85; band.max *= 0.90; }
      else if (verdict === 'OPEN') { band.min *= 1.20; band.max *= 1.30; }
      const brgEnemy = bearing2d(ship.pos, e.tr.pos);
      const usable = (ship.mainBatteries || []).length > 0 && r < Math.max(20000, 1.05 * this.mainRange(ship));
      let desired, phase;
      if (this.fleet.phase === 'EXIT' && this._exit) {
        phase = 'EXIT';
        desired = this._exit.mode === 'DISENGAGE'
          ? normDeg(bearing2d(ship.pos, e.tr.pos) + 180)   // 背敌脱离，直到拉开安全距离
          : bearing2d(ship.pos, this._exit.area);
      } else if (!usable) {
        desired = brgEnemy; phase = 'APPROACH';
      } else if (r > band.max * (mem.phase === 'APPROACH' ? 1.0 : 1.14)) {
        // ── 接近阶段：以 25° 接近角向目标机动（保持舷侧火力、同时快速缩短距离），全速
        //    选侧必须锁定：每 8s 决策来回翻侧会让接近率腰斩（实测 20m/s → 5m/s）
        if (mem.sideSign === undefined || world.t - (mem.sideSignT || -1e9) > 300) {
          const cA = normDeg(brgEnemy + 20), cB = normDeg(brgEnemy - 20);
          const dA = Math.min(Math.abs(normDeg180(cA - normDeg(enemyCourse + 90))), Math.abs(normDeg180(cA - normDeg(enemyCourse - 90))));
          const dB = Math.min(Math.abs(normDeg180(cB - normDeg(enemyCourse + 90))), Math.abs(normDeg180(cB - normDeg(enemyCourse - 90))));
          const pick = dA <= dB ? 1 : -1;
          // 只有当前锁定侧已经把我们带偏 >100° 时才换侧（换侧＝掉头，接近率损失极大）
          const cur = normDeg(brgEnemy + (mem.sideSign || pick) * 20);
          mem.sideSign = (mem.sideSign !== undefined && Math.abs(normDeg180(cur - ship.heading)) < 100) ? mem.sideSign : pick;
          mem.sideSignT = world.t;
        }
        phase = 'APPROACH';
        desired = normDeg(brgEnemy + mem.sideSign * 20);
      } else if (r < 4000 && (ship.type === 'CA' || ship.type === 'CL' || ship.type === 'DD')) {
        // ── 近距离遭遇（≤4 km）：教条上的"拉开"已无意义——背敌转向只会把炮尾对敌、
        //    半舷火力全废（实测：俾斯麦全程艏向 0~20°，8 门主炮只有 4 门能打，
        //    30 分钟被诺福克打出 221:6 的命中比）。这里改为转舷侧全炮对敌，
        //    先把对方打瘫再谈距离；舷侧一旦选定就锁定，避免每几秒翻一次。
        phase = 'BROWL';
        // 舷侧锁定：只有目标方位相对上次锁定变化 >60°（目标绕过正横）才重新选舷，
        // 避免每几秒翻一次导致原地来回掉头。
        if (mem.brawlSign === undefined || Math.abs(normDeg180(brgEnemy - (mem.brawlBrg === undefined ? brgEnemy : mem.brawlBrg))) > 60) {
          const bA = normDeg(brgEnemy + 90), bB = normDeg(brgEnemy - 90);
          mem.brawlSign = Math.abs(normDeg180(bA - ship.heading)) <= Math.abs(normDeg180(bB - ship.heading)) ? 1 : -1;
          mem.brawlBrg = brgEnemy;
        }
        desired = normDeg(brgEnemy + mem.brawlSign * 90);
      } else if (r < band.min * (mem.phase === 'OPEN' ? 1.0 : 0.86)) {
        // ── 过近（危险区）：越陷越深就直接转背敌方向拉开，浅则只偏 25°
        phase = 'OPEN';
        const tCross = normDeg(enemyCourse + 90);
        const away = normDeg(brgEnemy + 180);
        const urgency = clamp((band.min - r) / Math.max(1, band.min * 0.5), 0, 1);
        const pull = 25 + urgency * 95;
        desired = normDeg(tCross + clamp(normDeg180(away - tCross), -pull, pull));
      } else {
        // ── 交战阶段：抢占 T 字位（横阵对敌纵列），并向决战距离内沿（有效命中距离）收缩
        phase = 'ENGAGE';
        const cA = normDeg(enemyCourse + 90), cB = normDeg(enemyCourse - 90);
        const costOf = (h) => {
          const r240 = this.predictRange(ship, h, e, 240);
          let cost = Math.abs(normDeg180(h - ship.heading)) * 0.5;
          if (r240 < band.min) cost += (band.min - r240) / 300;
          if (r240 > band.max) cost += (r240 - band.max) / 300;
          return cost;
        };
        if (mem.crossSign === undefined || mem.crossSignTrack !== mem.targetTrackId) {
          mem.crossSign = costOf(cA) <= costOf(cB) ? 1 : -1;
          mem.crossSignT = world.t; mem.crossSignTrack = mem.targetTrackId;
        } else if (world.t - (mem.crossSignT || -1e9) > 240) {
          // 换舷＝一次大角度掉头：只有另一侧明显更优（≥30%）才换，否则保持当前舷侧。
          const cur = mem.crossSign > 0 ? costOf(cA) : costOf(cB);
          const alt = mem.crossSign > 0 ? costOf(cB) : costOf(cA);
          if (alt < cur * 0.7) mem.crossSign = -mem.crossSign;
          mem.crossSignT = world.t;
        }
        desired = mem.crossSign > 0 ? cA : cB;
        if (r > band.min) {   // 仍偏远：向敌压近（最多 40°），把距离收到决战距离内沿
          const pull = clamp(10 + (r - band.min) / 200, 0, 40);
          desired = normDeg(desired + clamp(normDeg180(brgEnemy - desired), -pull, pull));
        }
      }
      mem.phase = phase;
      if (this.setCourse(world, ship, desired, mem, phase === 'APPROACH' && r > band.max * 1.4)) {
        const tag = phase === 'APPROACH' ? '接近' : phase === 'BROWL' ? '近战·舷侧齐射' : phase === 'EXIT' ? '撤离/突破' : (phase === 'ENGAGE' ? '交战(T字位)' : '拉开');
        R.push('【' + tag + '】' + ship.name + ' 航向' + Math.round(normDeg(desired)) +
          ' 决战距离' + (band.min / 1000).toFixed(0) + '-' + (band.max / 1000).toFixed(0) + 'km' + (band.night ? '(夜)' : '') +
          ' 现距' + (r / 1000).toFixed(1) + 'km');
      }
      // 航速：接近阶段全速；夜间远距（尚无接触）保守减速；受损限速
      const maxKn = Math.min(ship.data.speedMax_kn || 30, ship.speedCapKn || 30);
      let wantKn;
      if (phase === 'EXIT') wantKn = maxKn;
      else if (phase === 'APPROACH') wantKn = maxKn * 0.95;
      else if (phase === 'ENGAGE') wantKn = maxKn * 0.9;
      else wantKn = maxKn * 0.8;
      if (night && r > band.max * 1.8) { wantKn = maxKn * 0.72; if (this.setSpeed(world, ship, wantKn, mem)) R.push('【夜间】' + ship.name + ' 隐密接近 ' + wantKn.toFixed(0) + '节（远距无接触，降低航迹暴露）'); }
      else this.setSpeed(world, ship, wantKn, mem);
      // 夜战照明：近距离用探照灯，中距用照明弹
      if (night) {
        if (r < 4500 && !ship.flags.searchlight.on) {
          this.order(world, { shipId: ship.id, kind: 'SEARCHLIGHT', params: { on: true, bearing: bearing2d(ship.pos, e.tr.pos) } });
          R.push('【照明】' + ship.name + ' 探照灯照射' + this.label(e) + '（' + (r / 1000).toFixed(1) + 'km，暴露阵位换取命中）');
        } else if (r >= 4500 && r < 9000 && !ship.flags.starshellArmed) {
          this.order(world, { shipId: ship.id, kind: 'STAR_SHELL', params: { bearing: bearing2d(ship.pos, e.tr.pos), range: r } });
          R.push('【照明】' + ship.name + ' 照明弹 ' + (r / 1000).toFixed(1) + 'km');
        }
      }
    }
  }

  mainRange(ship) {
    let mx = 0;
    for (const b of ship.mainBatteries || []) mx = Math.max(mx, (b.data && b.data.maxRange_m) || 20000);
    return mx || 20000;
  }
  // 拦截航向：向目标未来位置（拦截点）航行——雷击占位/接近用
  interceptHeading(ship, targetTrack, ownSpeedMps) {
    const eCourse = targetTrack.courseDeg || 0, eV = kn2mps(targetTrack.speedKn || 15);
    let p = { x: targetTrack.pos.x, y: targetTrack.pos.y };
    for (let i = 0; i < 4; i++) {
      const t = dist2d(ship.pos, p) / Math.max(1, ownSpeedMps);
      p = destPoint(targetTrack.pos, eV * t, eCourse);
    }
    return bearing2d(ship.pos, p);
  }
  predictRange(ship, heading, e, seconds) {
    const shipV = kn2mps(Math.min(ship.commanded.speed || ship.speed, ship.data.speedMax_kn || 30));
    const eSpeed = e.tr.speedKn !== undefined ? e.tr.speedKn : 18;
    const eCourse = e.tr.courseDeg !== undefined ? e.tr.courseDeg : 0;
    const p1 = destPoint(ship.pos, shipV * seconds, heading);
    const p2 = destPoint(e.tr.pos, kn2mps(eSpeed) * seconds, eCourse);
    return dist2d(p1, p2);
  }

  searchMove(world, ship, mem, night) {
    // 无接触：沿最后已知敌向/剧本目标搜索，各舰保持阵位（雷达搜索）
    let h = ship.commanded.heading;
    if (this.fleet.threatAxisDeg !== null) h = this.fleet.threatAxisDeg;
    else {
      const sc = world.scenario || {};
      const obj = (sc.objectives || []).find((o) => o.side === this.side && o.condition && o.condition.area);
      if (obj && obj.condition.area) h = bearing2d(ship.pos, obj.condition.area);
    }
    this.setCourse(world, ship, h, mem);
    const kn = (ship.data.speedMax_kn || 30) * (night ? 0.7 : 0.85);
    this.setSpeed(world, ship, kn, mem);
    if (!(ship.sensors || []).some((s) => s.srcKind === 'RADAR' && s.on) && (ship.sensors || []).some((s) => s.srcKind === 'RADAR')) {
      this.order(world, { shipId: ship.id, kind: 'RADAR', params: { on: true } });
    }
  }

  // ── 阵型与屏护（驱逐舰前出） ──────────────────────────────────────────────
  screen(world, mine, enemies, R) {
    const hvu = mine.filter((s) => HVU_TYPES[s.type] && !this.memFor(s).withdraw).sort((a, b) => (TYPE_VALUE[b.type] || 0) - (TYPE_VALUE[a.type] || 0));
    const escorts = mine.filter((s) => (s.type === 'DD' || s.type === 'CL') && !this.memFor(s).withdraw);
    if (!hvu.length || !escorts.length) return;
    const axis = this.fleet.threatAxisDeg !== null ? this.fleet.threatAxisDeg : hvu[0].heading;
    const flag = hvu[0];
    const stations = [0, -32, 32, -64, 64, -100, 100];
    escorts.forEach((dd, i) => {
      const mem = this.memFor(dd);
      if (world.t < mem.evadeUntil) return;
      if (mem.attacking && world.t < mem.attacking) return;   // 正在雷击突击：由 torpedoAttack 指挥
      if (mem.escortOf && world.t - (mem.escortT || -1e9) < 90) return; // 被派去掩护脱离舰
      if (world.t - mem.lastTorpT < 90) return;      // 刚完成雷击，正在脱离/再装填
      const off = stations[i % stations.length];
      const stationBearing = normDeg(axis + off);
      const rangeM = dd.type === 'CL' ? 4500 : (i % 2 === 0 ? 2800 : 3600);
      const goal = destPoint(flag.pos, rangeM, stationBearing);
      const d = dist2d(dd.pos, goal);
      // FORMATION 只是"阵位记录"（UI/指挥所/AAR 读），实际机动仍由下面的 SET_COURSE 执行。
      // 威胁轴抖动 >10° 就重发会让 FORMATION 变成命令风暴（实测第一次瓜岛 600s 399 条）。
      // 因此这里要求「阵位角变化 >25° 或距离变化 >500m」且每舰至少隔 90s 才重发一条。
      const stationChanged = !mem.screenStation ||
        Math.abs(normDeg180(mem.screenStation.bearingDeg - stationBearing)) > 25 ||
        Math.abs(mem.screenStation.rangeM - rangeM) > 500;
      if (stationChanged && world.t - (mem.lastFormationT || -1e9) > 90) {
        mem.screenStation = { bearingDeg: normDeg(stationBearing), rangeM };
        mem.lastFormationT = world.t;
        this.order(world, { shipId: dd.id, kind: 'FORMATION', params: { station: mem.screenStation } });
      }
      if (d > 900) {
        const h = bearing2d(dd.pos, goal);
        if (this.setCourse(world, dd, h, mem)) {
          R.push('【屏护】' + dd.name + ' 前出阵位 方位' + Math.round(normDeg(stationBearing)) + ' ' + (rangeM / 1000).toFixed(1) + 'km（威胁轴' + Math.round(axis) + '°）');
        }
        this.setSpeed(world, dd, dd.data.speedMax_kn * 0.9, mem);
      }
    });
  }

  // ── 掩护脱离舰（B1）：就近僚舰前出到脱离舰「朝敌一侧」2.2km 屏护 ───────────
  // 史实：重伤舰撤离时由就近驱逐舰/轻巡挡在追兵与伤舰之间（烟幕+屏护阵位）。
  // 这里用 FORMATION 记录阵位（供指挥所/AAR 读取），实际操纵仍走 SET_COURSE/SET_SPEED；
  // 每 escortHoldS 才重新评估，阵位变化 >12°/300m 才重发 FORMATION，避免命令风暴。
  escortWithdrawers(world, mine, enemies, R) {
    const D = this.dmgDoctrine;
    const withdrawing = mine.filter((s) => this.memFor(s).withdraw);
    if (!withdrawing.length) return;
    const escorts = mine.filter((s) => (s.type === 'DD' || s.type === 'CL') && !this.memFor(s).withdraw);
    if (!escorts.length) return;
    const used = new Set();
    for (const w of withdrawing) {
      const wmem = this.memFor(w);
      let esc = null;
      // 已指派的僚舰仍然有效（没有沉没/没有退出/没被别人占用）就沿用，避免来回换
      if (wmem.escortId) esc = escorts.find((e) => e.id === wmem.escortId && !used.has(e.id)) || null;
      if (!esc) {
        let bestD = 1e9;
        for (const e of escorts) {
          if (used.has(e.id)) continue;
          const mem = this.memFor(e);
          if (mem.withdraw || world.t < mem.evadeUntil) continue;
          const d = dist2d(e.pos, w.pos);
          if (d < bestD) { bestD = d; esc = e; }
        }
        if (esc) { wmem.escortId = esc.id; wmem.escortT = world.t; }
      }
      if (!esc) continue;
      used.add(esc.id);
      const emem = this.memFor(esc);
      emem.escortOf = w.id; emem.escortT = world.t;
      const threatBrg = this.threatBearing(world, w);
      if (threatBrg === null) continue;
      const stationBearing = normDeg(threatBrg);          // 站在伤舰与敌人之间
      const rangeM = D.escortRangeM;
      const goal = destPoint(w.pos, rangeM, stationBearing);
      const changed = !emem.screenStation || emem.screenFor !== w.id ||
        Math.abs(normDeg180(emem.screenStation.bearingDeg - stationBearing)) > 12 ||
        Math.abs(emem.screenStation.rangeM - rangeM) > 300;
      if (changed && world.t - (emem.lastEscortT || -1e9) > D.escortHoldS) {
        emem.screenStation = { bearingDeg: stationBearing, rangeM };
        emem.screenFor = w.id; emem.lastEscortT = world.t;
        this.order(world, { shipId: esc.id, kind: 'FORMATION', params: { station: emem.screenStation } });
        if (R) R.push('【掩护】' + esc.name + ' → 脱离舰 ' + w.name + ' 的朝敌一侧 ' + (rangeM / 1000).toFixed(1) + 'km 屏护阵位');
      }
      if (dist2d(esc.pos, goal) > 700 && world.t - (emem.lastEscortCourseT || -1e9) > 45) {
        emem.lastEscortCourseT = world.t;
        const h = bearing2d(esc.pos, goal);
        if (this.setCourse(world, esc, h, emem)) R.push('【掩护】' + esc.name + ' 前出掩护 ' + w.name + ' 航向' + Math.round(h) + '°');
        this.setSpeed(world, esc, (esc.data.speedMax_kn || 30) * 0.95, emem);
      }
    }
  }

  // ── 雷击条令（B1）：协同扇面齐射 + 突击占位 ────────────────────────────────
  // 单舰「有窗口就放雷」既浪费 4~6 管九三式，也把战列线航向搅乱。这里按 1942 年水雷战队
  // 的做法组织攻击：
  //   1) 同一目标由 ≥2 舰编组，各舰按目标航向/航速解提前角（solveIntercept）；
  //   2) 每舰扇面宽度由航迹误差换算后按邻舰夹角裁开，保证扇面互不重叠（pickFanGroup）；
  //   3) 同一目标两批齐射间隔 ≥ groupWindowS；单舰对同一目标只打一次（targetRepeatS）；
  //   4) 进不了窗口的舰按「目标舷侧射击位」突击占位（限流、限数量），而不是原地等目标靠近。
  torpedoAttack(world, mine, enemies, R) {
    if (!this.doctrineOn) return this.torpedoAttackLegacy(world, mine, enemies, R);
    if (!enemies.length) return;
    const D = this.torpDoctrine;
    const night = this.isNight(world);
    const ctx = { night, winMax: night ? D.nightRangeM : D.dayRangeM, tofMax: night ? D.nightTofS : D.dayTofS };
    // 1) 候选射手：未退出、未避雷、有装填、冷却已到
    const shooters = [];
    for (const s of mine) {
      const mem = this.memFor(s);
      if (mem.withdraw || world.t < mem.evadeUntil) continue;
      if (!TORPEDO_TYPES_ALLOWED[s.type]) continue;
      const mounts = (s.torpedoMounts || []).filter((m) => !m.destroyed && m.health > 0.2 && m.tubesLoaded > 0);
      if (!mounts.length) continue;
      if (world.t - mem.lastTorpT < D.reloadS) continue;
      shooters.push({ ship: s, mem, mount: mounts[0], spec: torpedoSpecFor(s, mounts[0]) });
    }
    if (!shooters.length) return;
    // 2) 解算所有「射手→目标」射位（提前角/航程/舷角/命中窗口/友舰安全走廊）
    const shots = [];
    for (const sh of shooters) for (const e of enemies) {
      const c = this.torpShotCandidate(world, sh, e, ctx);
      if (c) shots.push(c);
    }
    const salvoed = new Set();
    if (shots.length) {
      // 3) 按目标聚合成组，优先价值高、命中窗口好的目标
      const byTarget = new Map();
      for (const c of shots) {
        if (!byTarget.has(c.targetId)) byTarget.set(c.targetId, { targetId: c.targetId, target: c.target, shots: [] });
        byTarget.get(c.targetId).shots.push(c);
      }
      const groups = Array.from(byTarget.values()).sort((a, b) => this.torpGroupScore(b) - this.torpGroupScore(a));
      let salvos = 0;
      for (const g of groups) {
        if (salvos >= 2) break;                                       // 一个决策周期最多两批齐射
        if (world.t - ((this.fleet.torpGroupAt || {})[g.targetId] || -1e9) < D.groupWindowS) continue;
        const pool = g.shots.filter((c) => !salvoed.has(c.ship.id) &&
          world.t - ((c.mem.torpTargetAt || {})[c.targetId] || -1e9) > D.targetRepeatS);
        const chosen = this.pickFanGroup(pool, D);
        if (chosen.length < D.minGroupSize) continue;                  // 编不成组 → 交给单舰/占位
        let fired = 0;
        for (const c of chosen) if (this.fireTorpedoes(world, c, R, { group: true, planned: chosen })) { salvoed.add(c.ship.id); fired++; }
        if (fired) { this.fleet.torpGroupAt = this.fleet.torpGroupAt || {}; this.fleet.torpGroupAt[g.targetId] = world.t; salvos++; }
      }
      // 4) 单舰近距补射（编不成组 / 剩余射手）：舷角与距离门限更严
      for (const c of shots) {
        if (salvoed.has(c.ship.id)) continue;
        if (c.r > D.singleMaxRangeM) continue;
        if (c.aspect < D.singleAspectMinDeg || c.aspect > D.singleAspectMaxDeg) continue;
        if (world.t - ((this.fleet.torpGroupAt || {})[c.targetId] || -1e9) < D.groupWindowS) continue;
        if (world.t - ((c.mem.torpTargetAt || {})[c.targetId] || -1e9) <= D.targetRepeatS) continue;
        if (this.fireTorpedoes(world, c, R, { group: false })) {
          this.fleet.torpGroupAt = this.fleet.torpGroupAt || {};
          this.fleet.torpGroupAt[c.targetId] = world.t;
          salvoed.add(c.ship.id);
        }
      }
    }
    // 5) 剩余射手：按目标舷侧射击位突击占位（限流，避免每 8s 一条航向命令）
    this.torpedoRunOrders(world, mine, enemies, shooters.filter((sh) => !salvoed.has(sh.ship.id)), ctx, R);
  }

  // ── 雷击（B1 之前的旧条令；doctrine.enabled=false 时启用，供 t15 做同种子对照）──
  // 历史行为：单舰各自找窗口（夜 1.2~6.5km、日 2~8.5km，舷角 60~120°），同一目标 30s 内
  // 只有一舰能放雷。没有编组、没有扇面去重、也没有"单舰不重复打同一目标"的抑制。
  // ── 雷击突击 ──────────────────────────────────────────────────────────────
  torpedoAttackLegacy(world, mine, enemies, R) {
    if (!enemies.length) return;
    for (const dd of mine) {
      const mem = this.memFor(dd);
      if (mem.withdraw || world.t < mem.evadeUntil) continue;
      if (!TORPEDO_TYPES_ALLOWED[dd.type]) continue;
      const mounts = (dd.torpedoMounts || []).filter((m) => !m.destroyed && m.health > 0.2 && m.tubesLoaded > 0);
      if (!mounts.length) continue;
      if (world.t - mem.lastTorpT < 200) continue;     // 攻击周期（含脱离与再装填）
      const mount = mounts[0];
      const spec = torpedoSpecFor(dd, mount);
      const maxSettingM = Math.max.apply(null, spec.rangesM);
      const band = this.decisiveBand(dd, 'CA', world);
      const night = band.night;
      // 雷击窗口：夜战 1.2~6.5km、日间 2~8.5km。史实（萨沃岛 1.5-3km、塔萨法隆加 2-4km）
      // 都是接近到极近距离横越齐射；几千米外放雷基本全脱靶。
      const winMin = night ? 1200 : 2000, winMax = night ? 6500 : 8500;
      let target = null, tsol = null, bestScore = -1;
      for (const e of enemies) {
        const r = dist2d(dd.pos, e.tr.pos);
        if (r < 500 || r > Math.min(maxSettingM * 0.9, 18000)) continue;
        // 舷角窗口 60~120°（横越）——命中投影最大、提前量解算最稳
        const aspect = aspectAngle(e.tr.courseDeg || 0, bearing2d(e.tr.pos, dd.pos));
        if (aspect < 60 || aspect > 120) continue;
        const tof = solveIntercept(dd.pos.x, dd.pos.y, e.tr.pos.x, e.tr.pos.y, e.tr.courseDeg || 0, kn2mps(e.tr.speedKn || 15), kn2mps(spec.speedsKn[0])).tofS;
        if (tof > (night ? 300 : 420)) continue;        // 航程太长＝目标有充足规避时间
        let score = this.trackValue(e);
        if (e.tr.id === this.fleet.vanTrackId) score *= 1.35;               // 优先战列线前导舰
        if (ARMORED_TYPES[e.classifiedAs] || e.classifiedAs === 'CV') score *= 1.25;
        if (r >= winMin && r <= winMax) score *= 1.6;                        // 已在窗口内
        if (aspect > 70 && aspect < 110) score *= 1.2;
        if (e.tr.id === mem.torpedoTargetId) score *= 0.6;
        score /= Math.max(1, tof / 120);
        if (score > bestScore) { bestScore = score; target = e; tsol = { r, tof, aspect }; }
      }
      if (!target) continue;
      if (tsol.r > winMax) {
        // ── 突击占位阶段：按拦截航向压到雷击窗口，全速（占位期间由本函数指挥，屏护让位）
        const h = this.interceptHeading(dd, target.tr, kn2mps(spec.speedsKn[0]) * 0.92);
        mem.attacking = world.t + 120;
        if (this.setCourse(world, dd, h, mem)) {
          R.push('【雷击】' + dd.name + ' 突击占位 航向' + Math.round(h) + '→' + this.label(target) + ' ' + (tsol.r / 1000).toFixed(1) +
            'km 舷角' + Math.round(tsol.aspect) + '°（窗口 ' + (winMin / 1000).toFixed(1) + '-' + (winMax / 1000).toFixed(1) + 'km 全速）');
        }
        this.setSpeed(world, dd, dd.data.speedMax_kn || 30, mem);
        // 进攻性烟幕：突击占位时已进入敌炮有效射程（<10km）却还没到雷击窗口，
        // 施烟遮断敌方目视/光学，掩护驱逐舰高速逼近——史实日军雷击突击的常规手段。
        if (tsol.r < 10000 && !dd.flags.smokeOn && this.smoke(world, dd, true)) {
          R.push('【烟幕】' + dd.name + ' 突击占位施烟（' + (tsol.r / 1000).toFixed(1) + 'km）');
        }
        continue;
      }
      // 友舰安全走廊：射向 ±(扇面/2+2°) 内、航程+1000m 内不得有本舰队友
      const trackCourse = bearing2d(dd.pos, target.tr.pos);
      const errM = target.tr.errM !== undefined ? target.tr.errM : 400;
      const spread = clamp(rad2deg(2.2 * Math.atan2(errM, Math.max(1000, tsol.r))) + 2, 2, 12);
      if (!this.corridorClear(world, dd, target, trackCourse, spread, tsol.r, kn2mps(spec.speedsKn[0]))) continue;
      // 管数：高价值目标 6 管，一般 4 管；保留至少 2 管
      const loaded = mount.tubesLoaded;
      let tubes = ARMORED_TYPES[target.classifiedAs] || target.classifiedAs === 'CV' ? Math.min(loaded, 6) : Math.min(loaded, 4);
      tubes = Math.max(1, Math.min(tubes, loaded - (loaded > 4 ? 2 : 0)));
      // 档位：按「实际拦截点航程」选能到达的最快档（目标逃逸时拦截点更远，必须用拦截三角算）
      let speedIdx = spec.speedsKn.length - 1;
      {
        const eCourse = target.tr.courseDeg || 0, eV = kn2mps(target.tr.speedKn || 15);
        for (let i = 0; i < spec.speedsKn.length; i++) {
          const s = solveIntercept(dd.pos.x, dd.pos.y, target.tr.pos.x, target.tr.pos.y, eCourse, eV, kn2mps(spec.speedsKn[i]));
          if (s.runM <= spec.rangesM[i] * 0.98) { speedIdx = i; break; }
        }
      }
      // 协同雷击：同一目标若 30 秒内已有友舰放过雷，则错开再放——多批次先后到达会打乱
      // 对方的规避（史实日军水雷战队就是分批放雷），而不是所有管一次泼出去。
      if (!this.fleet.torpAt) this.fleet.torpAt = {};
      const lastAt = this.fleet.torpAt[target.tr.id] || -1e9;
      if (world.t - lastAt < 30) continue;
      // 不把鱼雷浪费在已经明显失能的目标上（航速塌到 4 节以下说明已被打残，留着打新目标）
      if (target.tr.speedKn !== undefined && target.tr.speedKn > 0 && target.tr.speedKn < 4 && !ARMORED_TYPES[target.classifiedAs]) continue;
      this.order(world, { shipId: dd.id, kind: 'LAUNCH_TORPEDO', params: { trackId: target.tr.id, spreadDeg: +spread.toFixed(1), tubes, speedIdx } });
      this.fleet.torpAt[target.tr.id] = world.t;
      mem.lastTorpT = world.t; mem.torpedoTargetId = target.tr.id;
      mem.attacking = world.t + 90;                    // 发射后 90s 脱离/再装填（屏护让位）
      R.push('【雷击】' + dd.name + '→' + this.label(target) + ' ' + (tsol.r / 1000).toFixed(1) + 'km 舷角' + Math.round(tsol.aspect) +
        '° 发射' + tubes + '雷 ' + spec.speedsKn[speedIdx] + '节 扇面' + spread.toFixed(1) + '° 预计命中' + Math.round(tsol.tof) + 's（' + spec.wakeType + '航迹）');
      // 发射后转向脱离：与射向垂直（横过后再拉开），并施烟掩护
      const away = normDeg(trackCourse + 180 + (Math.abs(normDeg180(trackCourse + 90 - dd.heading)) < Math.abs(normDeg180(trackCourse - 90 - dd.heading)) ? 75 : -75));
      this.setCourse(world, dd, away, mem, true);
      this.setSpeed(world, dd, dd.data.speedMax_kn || 30, mem, true);
      if (tsol.r < 12000) this.smoke(world, dd, true);
    }
  }

  isNight(world) {
    const e = (world && world.env) || {};
    if (e.sunAltDeg !== undefined && e.sunAltDeg !== null) return e.sunAltDeg < -6;
    return (e.lightLevel !== undefined ? e.lightLevel : 1) < 0.10;
  }

  // 单个射位是否成立：射程/舷角/命中窗口/档位/友舰走廊
  torpShotCandidate(world, sh, e, ctx) {
    const D = this.torpDoctrine;
    const ship = sh.ship, spec = sh.spec, tr = e.tr || {};
    if (!tr.pos) return null;
    const r = dist2d(ship.pos, tr.pos);
    if (r < D.minRangeM || r > ctx.winMax) return null;
    const eSpeedKn = tr.speedKn !== undefined ? tr.speedKn : 15;
    const eCourse = tr.courseDeg !== undefined ? tr.courseDeg : 0;
    // 舷角：目标航向 vs「目标→本舰」方位；90° 时鱼雷航向与目标航向接近垂直，命中投影最大
    const aspect = aspectAngle(eCourse, bearing2d(tr.pos, ship.pos));
    if (aspect < D.aspectMinDeg || aspect > D.aspectMaxDeg) return null;
    // 提前角解算：瞄准目标未来位置（舰速 + 鱼雷速求交）
    const solFast = solveIntercept(ship.pos.x, ship.pos.y, tr.pos.x, tr.pos.y, eCourse, kn2mps(eSpeedKn), kn2mps(spec.speedsKn[0]));
    if (solFast.tofS > ctx.tofMax) return null;                       // 命中窗口：目标有充分规避时间就不打
    if (solFast.runM > Math.max.apply(null, spec.rangesM) * 0.98) return null;
    // 档位：选能覆盖实际拦截点航程的最快档（目标逃逸时拦截点更远，必须用拦截三角算）
    let speedIdx = -1;
    for (let i = 0; i < spec.speedsKn.length; i++) {
      const s2 = solveIntercept(ship.pos.x, ship.pos.y, tr.pos.x, tr.pos.y, eCourse, kn2mps(eSpeedKn), kn2mps(spec.speedsKn[i]));
      if (s2.runM <= spec.rangesM[i] * 0.98) { speedIdx = i; break; }
    }
    if (speedIdx < 0) return null;
    // 不把鱼雷浪费在已经明显失能的目标上（航速塌到 4 节以下说明已被打残，留着打新目标）
    if (eSpeedKn > 0 && eSpeedKn < 4 && !ARMORED_TYPES[e.classifiedAs] && e.classifiedAs !== 'CV') return null;
    // 扇面宽度：目标位置横向不确定度（航迹 errM）换算成角度 + 2° 余量
    const errM = tr.errM !== undefined ? tr.errM : 400;
    const spreadBase = clamp(rad2deg(2.2 * Math.atan2(errM + 150, Math.max(1000, solFast.runM))) + 2, D.fanMinDeg, D.fanMaxDeg);
    // 友舰安全走廊：射向 ±(扇面/2+2°)、航程+1200m 内不得有队友；
    // 另按鱼雷实际档速做相对运动 CPA 预测，拦住"友舰随后切进雷道"的误伤
    if (!this.corridorClear(world, ship, e, solFast.trackCourseDeg, spreadBase, solFast.runM, kn2mps(spec.speedsKn[speedIdx]))) return null;
    const score = this.torpShotScore(e, r, aspect, solFast.tofS, spec, speedIdx);
    return { ship, mem: sh.mem, mount: sh.mount, spec, target: e, targetId: tr.id,
      r, aspect, tofS: solFast.tofS, courseDeg: normDeg(solFast.trackCourseDeg), speedIdx, spreadBase, score };
  }

  torpShotScore(e, r, aspect, tofS, spec, speedIdx) {
    let s = this.trackValue(e);
    if (e.tr.id === this.fleet.vanTrackId) s *= 1.30;                        // 优先战列线前导舰
    if (ARMORED_TYPES[e.classifiedAs] || e.classifiedAs === 'CV') s *= 1.20; // 主力舰价值
    s *= 0.70 + 0.60 * Math.sin(clamp(aspect, 0, 180) * Math.PI / 180);      // 舷角越接近 90° 命中投影越大
    if (e.tr.id === this.fleet.focusTrackId) s *= 1.10;                      // 与火力焦点一致
    s /= Math.max(1, tofS / 150);                                            // 飞行时间越短越可靠
    if (spec.speedsKn.length > 1 && spec.speedsKn[speedIdx] === spec.speedsKn[0]) s *= 1.0;
    return s;
  }

  torpGroupScore(g) {
    const top = g.shots.slice().sort((a, b) => b.score - a.score).slice(0, this.torpDoctrine.maxPerGroup);
    return top.reduce((a, c) => a + c.score, 0) + top.length * 2;             // 组内舰数也加分（协同优先）
  }

  // 扇面编组：按分数依次纳入，每舰扇面裁到「与已纳入邻舰的雷道夹角 - 间隙」之内，
  // 保证任意两舰扇面不重叠；夹角太小的舰本轮不参加（换目标/等下一批）。
  pickFanGroup(pool, D) {
    const sorted = pool.slice().sort((a, b) => b.score - a.score);
    const chosen = [];
    for (const c of sorted) {
      let cap = c.spreadBase;
      let ok = true;
      for (const p of chosen) {
        const sep = Math.abs(normDeg180(c.courseDeg - p.courseDeg));
        const room = 2 * (sep - D.fanGapDeg) - p.spreadDeg;                   // 解 spread_c ≤ 2(sep-gap) - spread_p
        if (room < cap) cap = room;
        if (room < D.fanMinDeg) { ok = false; break; }
      }
      if (!ok) continue;
      chosen.push(Object.assign({}, c, { spreadDeg: clamp(cap, D.fanMinDeg, D.fanMaxDeg) }));
      if (chosen.length >= D.maxPerGroup) break;
    }
    return chosen;
  }

  // 执行发射：管数按目标价值、保留管次；发射后转向脱离并近距施烟
  fireTorpedoes(world, c, R, opts) {
    const D = this.torpDoctrine;
    const ship = c.ship, mem = c.mem, mount = c.mount, target = c.target;
    if (!mount || mount.destroyed || mount.tubesLoaded <= 0) return false;
    const loaded = mount.tubesLoaded;
    const hvu = ARMORED_TYPES[target.classifiedAs] || target.classifiedAs === 'CV';
    let tubes = hvu ? Math.min(loaded, 6) : Math.min(loaded, 4);
    tubes = Math.max(1, Math.min(tubes, loaded - (loaded > 4 ? D.tubesReserve : 0)));
    if (opts && opts.group && tubes < 2) return false;                         // 齐射至少要 2 管
    const spread = clamp(c.spreadDeg !== undefined ? c.spreadDeg : c.spreadBase, D.fanMinDeg, D.fanMaxDeg);
    const cmd = this.order(world, { shipId: ship.id, kind: 'LAUNCH_TORPEDO',
      params: { trackId: target.tr.id, spreadDeg: +spread.toFixed(1), tubes, speedIdx: c.speedIdx, bearingDeg: Math.round(c.courseDeg) } });
    if (!cmd) return false;
    mem.torpTargetAt = mem.torpTargetAt || {};
    mem.torpTargetAt[target.tr.id] = world.t;
    mem.lastTorpT = world.t; mem.torpedoTargetId = target.tr.id;
    mem.attacking = world.t + 90;                                              // 发射后 90s 脱离/再装填（屏护让位）
    const mode = (opts && opts.group) ? '协同齐射' : '单舰雷击';
    R.push('【雷击·' + mode + '】' + ship.name + '→' + this.label(target) + ' ' + (c.r / 1000).toFixed(1) + 'km 舷角' +
      Math.round(c.aspect) + '° 提前角' + this.leadAngleOf(c) + '° 发射' + tubes + '雷 ' + c.spec.speedsKn[c.speedIdx] + '节 扇面' +
      spread.toFixed(1) + '° 预计命中' + Math.round(c.tofS) + 's（' + c.spec.wakeType + '航迹）');
    // 发射后转向脱离：与射向垂直（横过后再拉开），近距才施烟掩护（远距没被看清，别自蔽）
    const trackCourse = bearing2d(ship.pos, target.tr.pos);
    const away = normDeg(trackCourse + 180 + (Math.abs(normDeg180(trackCourse + 90 - ship.heading)) < Math.abs(normDeg180(trackCourse - 90 - ship.heading)) ? 75 : -75));
    mem.torpTurn = { h: away, until: world.t + 60 };                            // maneuver() 在下一个周期执行转向
    if (c.r < 8000) this.smoke(world, ship, true);
    return true;
  }
  leadAngleOf(c) {
    const tr = c.target.tr || {};
    const los = bearing2d(c.ship.pos, tr.pos || c.ship.pos);
    return Math.round(normDeg180(c.courseDeg - los));
  }

  // 突击占位：尚未进窗口的雷击舰，抢占「目标舷侧射击位」——射向与目标航向接近垂直，
  // 使舷角进入 45~135° 窗口。限 3 舰、每舰每 attackRunRefreshS 只重算一次航向。
  torpedoRunOrders(world, mine, enemies, shooters, ctx, R) {
    const D = this.torpDoctrine;
    let n = 0;
    for (const sh of shooters) {
      if (n >= D.attackRunMaxShips) break;
      const ship = sh.ship, mem = sh.mem;
      if (mem.withdraw || world.t < mem.evadeUntil) continue;
      if (world.t - (mem.torpRunT || -1e9) < D.attackRunRefreshS) continue;
      let target = null, best = -1;
      for (const e of enemies) {
        const r = dist2d(ship.pos, e.tr.pos);
        if (r < D.minRangeM || r > D.attackRunRangeM) continue;
        const v = this.trackValue(e) / Math.max(1500, r);
        if (v > best) { best = v; target = e; }
      }
      if (!target) continue;
      const h = this.torpedoRunHeading(ship, target, sh.spec);
      if (h === null) continue;
      const ok = this.setCourse(world, ship, h, mem, true);
      this.setSpeed(world, ship, ship.data.speedMax_kn || 30, mem);
      if (ok) {
        mem.torpRunT = world.t; mem.attacking = world.t + D.attackRunRefreshS;
        R.push('【雷击·占位】' + ship.name + ' 突击占位 航向' + Math.round(h) + '→' + this.label(target) +
          '（' + (dist2d(ship.pos, target.tr.pos) / 1000).toFixed(1) + 'km，抢占目标舷侧雷击位）');
        n++;
      }
    }
  }
  // 目标舷侧射击位：目标未来位置 + 正横 2.6km + 航向前方 1.2km（迭代 3 次算目标运动）
  torpedoRunHeading(ship, target, spec) {
    const tr = target.tr || {};
    if (tr.pos === undefined) return null;
    if (tr.courseDeg === undefined || tr.speedKn === undefined || tr.speedKn <= 0) {
      return this.interceptHeading(ship, tr, kn2mps(spec.speedsKn[0]) * 0.92);
    }
    const course = normDeg(tr.courseDeg);
    const rel = bearing2d(tr.pos, ship.pos);
    const side = Math.abs(normDeg180(rel - normDeg(course + 90))) <= Math.abs(normDeg180(rel - normDeg(course - 90))) ? 1 : -1;
    const beamDeg = normDeg(course + side * 90);
    const beamM = 2600, aheadM = 1200;
    const ownV = kn2mps(Math.max(18, (ship.data.speedMax_kn || 30) * 0.95));
    let aim = null;
    for (let i = 0; i < 3; i++) {
      const base = i === 0 ? tr.pos : destPoint(tr.pos, kn2mps(tr.speedKn) * (dist2d(ship.pos, aim) / ownV), course);
      aim = destPoint(destPoint(base, aheadM, course), beamM, beamDeg);
    }
    return bearing2d(ship.pos, aim);
  }

  // 友舰安全走廊：射界内不得有友舰。
  // 【两条判据都必须有】旧实现只看"发射瞬间"的友舰方位——实测 Denmark 沙盒里高雄对西发射 4 条
  // 九三式时，大和在扇面外 50°（判安全），但大和随后接到"掉头朝西"的命令，正好迎向雷道；
  // 鱼雷飞了 33 秒后 4 条**全部命中自己的旗舰**（torp.hit friendly=true），大和再中一发水线下
  // 203mm 就打穿弹药库殉爆。所以必须叠加"相对运动 CPA"：按友舰当前/受令航向航速外推，
  // 判断它在鱼雷飞行窗口内会不会切进雷道。
  corridorClear(world, dd, target, courseDeg, spread, runM, torpSpeedMps) {
    const half = clamp(spread / 2 + 2, 2, 12) * Math.PI / 180;
    const vTorp = (torpSpeedMps && isFinite(torpSpeedMps) && torpSpeedMps > 1) ? torpSpeedMps : 18;
    const tMax = clamp(runM / vTorp, 1, 240);           // 鱼雷到达射程末端的最长时间
    const dirX = Math.sin(courseDeg * Math.PI / 180), dirY = Math.cos(courseDeg * Math.PI / 180);
    for (const f of world.shipsOf(this.side)) {
      if (f.id === dd.id || !f.isAfloat) continue;
      const d = dist2d(dd.pos, f.pos);
      if (d > runM + 1200) continue;
      // (1) 发射瞬间：友舰已落在雷道扇面内
      const brg = bearing2d(dd.pos, f.pos);
      if (Math.abs(normDeg180(brg - courseDeg)) * Math.PI / 180 < half + Math.atan2(30, Math.max(200, d))) return false;
      // (2) 友舰位于雷道前方时，按"鱼雷到达它所需时间"估计它最多能横向收多少：
      //     即使发射瞬间它在扇面外，只要它能在鱼雷到达前把横向距离压进安全距离，就拒绝。
      //     这正是丹麦海峡沙盒里"高雄 4 雷打中大和"的几何：发射时大和在扇面外 50°，
      //     但 5 秒后它接到掉头朝西的命令，33 秒后正好横在雷道上，4 条雷全部命中。
      const rx = f.pos.x - dd.pos.x, ry = f.pos.y - dd.pos.y;
      const along = rx * dirX + ry * dirY;                 // 沿雷道的纵向距离（+ = 前方）
      if (along > 0 && along < runM + 600) {
        const lateral = Math.abs(rx * dirY - ry * dirX);    // 横向偏移
        const tf = along / vTorp;                           // 鱼雷到达该纵向位置的时间
        const vmax = kn2mps(Math.max(20, (f.data && f.data.speedMax_kn) || 25));
        const reach = Math.min(lateral, vmax * tf);         // 友舰可能朝雷道收缩的横向距离（上界）
        const safe = 220 + 0.55 * ((f.data && f.data.loa_m) || 100);   // 大和 263m → 365m
        if (lateral - reach < safe) return false;
      }
      // (3) 相对运动 CPA（补充判据）：两者航向接近平行、鱼雷从后追赶时，CPA 会很小
      const fh = (f.commanded && f.commanded.heading !== undefined && f.commanded.heading !== null) ? f.commanded.heading : f.heading;
      const fkn = (f.commanded && f.commanded.speed !== undefined && f.commanded.speed !== null) ? f.commanded.speed : f.speed;
      const fv = kn2mps(clamp(fkn || 0, 0, 40));
      const ux = fv * Math.sin(fh * Math.PI / 180) - vTorp * dirX;
      const uy = fv * Math.cos(fh * Math.PI / 180) - vTorp * dirY;
      const uu = ux * ux + uy * uy;
      let tc = 0;
      if (uu > 1e-6) tc = clamp(-(rx * ux + ry * uy) / uu, 0, tMax);
      const cpa = Math.hypot(rx + ux * tc, ry + uy * tc);
      const safeCpa = 180 + 0.45 * ((f.data && f.data.loa_m) || 100);
      if (cpa < safeCpa) return false;
    }
    return true;
  }

  // ── 弹药经济 ──────────────────────────────────────────────────────────────
  ammoEconomy(world, mine, R) {
    for (const ship of mine) {
      const mem = this.memFor(ship);
      const b = (ship.mainBatteries || [])[0];
      if (!b) continue;
      const total = (b.ammo.AP || 0) + (b.ammo.HE || 0);
      const avail = b.data && b.data.ammo ? ((b.data.ammo.AP || 0) + (b.data.ammo.HE || 0)) : 1;
      if (total / Math.max(1, avail) < 0.18 && !mem.ammoLow) {
        mem.ammoLow = true;
        R.push('【弹药】' + ship.name + ' 主炮弹药仅剩' + total + '发（' + Math.round(100 * total / avail) + '%）→ 只打 12000m 内有把握的目标');
      }
    }
  }

  // ── 撤退 ──────────────────────────────────────────────────────────────────
  retirementAxis(world) { return this.fleet.threatAxisDeg !== null ? normDeg(this.fleet.threatAxisDeg + 180) : null; }
  retreatHeading(world, ship) {
    const away = this.retirementAxis(world);   // 威胁轴反向 = 远离敌人
    const sc = world.scenario || {};
    const start = (sc.ships || []).find((s) => s.id === ship.id) || {};
    let home = null;
    if (start.x !== undefined && (start.x !== 0 || start.y !== 0)) home = bearing2d(ship.pos, { x: start.x, y: start.y });
    if (away === null) return home !== null ? home : normDeg(ship.heading + 90);
    // 「向本方远离敌方向」：本方就在撤退方向上（±70°）时回自己的航道
    if (home !== null && Math.abs(normDeg180(home - away)) < 70) return home;
    const mates = world.afloatOf(this.side).filter((s) => s.id !== ship.id && !this.memFor(s).withdraw);
    if (mates.length) {
      let cx = 0, cy = 0;
      for (const m of mates) { cx += m.pos.x; cy += m.pos.y; }
      const toMates = bearing2d(ship.pos, { x: cx / mates.length, y: cy / mates.length });
      // 朝本方主力靠拢，但绝不朝敌（与"远离威胁轴"夹角 <=75°）
      if (Math.abs(normDeg180(toMates - away)) < 75) return toMates;
    }
    return away;
  }
  // 单舰脱离操舵：背离最近/最大威胁、按剩余航速上限全速、烟幕掩护
  retreatShip(world, ship, mem, R) {
    const foes = world.afloatOf(world.opposite(this.side));
    if (!foes.length) return;
    let threat = null, best = -1;
    for (const f of foes) {
      const d = dist2d(ship.pos, f.pos);
      const v = (TYPE_VALUE[f.type] || 30) / Math.max(1000, d);
      if (v > best) { best = v; threat = f; }
    }
    if (!threat) return;
    const away = bearing2d(threat.pos, ship.pos);
    // 脱离是"持续状态"：航向/航速用更长的节流（60s / 90s），不要按交战时的 25s 重发。
    // 撤离中的舰每 25s 一条航向命令会把命令数抬回风暴量级（实测萨沃岛 B1 474 条里有
    // 相当一部分是撤退舰在刷航向/航速）。
    if (world.t - (mem.lastRetreatCourseT || -1e9) > 60) {
      mem.lastRetreatCourseT = world.t;
      if (this.setCourse(world, ship, away, mem, true)) R.push('【脱离】' + ship.name + ' 背离威胁 航向' + Math.round(away) + '°');
    }
    if (world.t - (mem.lastRetreatSpeedT || -1e9) > 90) {
      mem.lastRetreatSpeedT = world.t;
      const kn = Math.floor(Math.min(ship.data.speedMax_kn || 30, ship.speedCapKn || (ship.data.speedMax_kn || 30)));
      this.setSpeed(world, ship, kn, mem);
    }
    // 烟幕要持续覆盖：烟团在漂移/消散，每 smokeOnS 重新发一次（而不是只在第一次）
    if (world.t - (mem.lastRetreatSmoke || -1e9) > this.dmgDoctrine.smokeOnS) {
      if (this.smoke(world, ship, true)) { mem.lastRetreatSmoke = world.t; if (R) R.push('【烟幕】' + ship.name + ' 持续发烟掩护脱离'); }
      else mem.lastRetreatSmoke = world.t;
    }
  }

  fleetRetreat(world, mine, R) {
    for (const ship of mine) {
      const mem = this.memFor(ship);
      // 注意：不能因为 mem.withdraw 就跳过——那些正是最需要操舵撤离的舰。
      // （旧代码在这里 continue，导致"已决定撤退"的舰反而没人管航向，继续朝敌航行。）
      const h = this.retreatHeading(world, ship);
      this.setCourse(world, ship, h, mem);
      this.setSpeed(world, ship, (ship.data.speedMax_kn || 30) * 0.9, mem);
      const threats = world.tracks.visibleFor(ship) || [];
      if (threats.some((t) => dist2d(ship.pos, t.pos) < 24000)) this.smoke(world, ship, true);
    }
    if (R) R.push('【脱离】全队背敌 ' + Math.round(this.retirementAxis(world) || 0) + '° 撤退，烟幕掩护');
  }

  // ── 损管优先级（B1）──────────────────────────────────────────────────────
  // 按「主要损伤类型」排序，而不是"只要进过水就永远 flooding"：
  //   弹药库受威胁（殉爆风险）> 大量进水/横倾（沉没风险）> 火灾（会蔓延到弹药库）
  //   > 机动性（能跑才有一切）。
  // 去重由 react() 负责：同一 mode 不重发；被外部/玩家改掉也至少隔 smokeOnS 再接管。
  dcMode(ship, mem, tNow) {
    const comps = ship.compartments || [];
    // 1) 弹药库：起火 / 被击穿且尚未注水 / 殉爆风险(magRisk)升高 → 注水保命（最高优先，史实红线）
    // 原判据只看 fire 与 breach，漏了"被直击但未起火"的 magRisk：高雄 7 次弹药库被命中
    // （magRisk 0.04–0.09、无明火）就没触发 magazine 注水，只能干等殉爆概率累积。
    const magThreat = comps.some((c) => c.isMagazine && (c.fire > 0.03 || c.magRisk > 0.05 || (c.breached && c.flood_m3 < c.volume_m3 * 0.15)));
    if (magThreat) return 'magazine';
    // 2) 进水：进水速率是否超过排水泵能力 / 已到沉没风险量级 / 大横倾
    let rate = 0;
    if (mem && mem.prevFlood !== undefined && mem.prevFloodT !== undefined) {
      const dtEff = Math.max(0.5, tNow - mem.prevFloodT);
      rate = (ship.floodedM3 - mem.prevFlood) / dtEff;
      mem.prevFlood = ship.floodedM3; mem.prevFloodT = tNow;
    } else if (mem) { mem.prevFlood = ship.floodedM3; mem.prevFloodT = tNow; }
    const floodFrac = ship.floodedM3 / Math.max(1, ship.reserveBuoyancyM3);
    const pumpRate = (ship.pumpCapacity || 0) / 60;
    if (floodFrac > 0.10 || Math.abs(ship.list || 0) > 8 || (pumpRate > 0 && rate > pumpRate * 1.15)) return 'flooding';
    // 3) 火灾：多舱/大火势（火不扑会烧到弹药库与动力舱）
    let fireSum = 0, fireMax = 0;
    for (const c of comps) if (c.fire > 0.05) { fireSum += c.fire; if (c.fire > fireMax) fireMax = c.fire; }
    if (fireSum >= 0.6 || fireMax >= 0.35) return 'fire';
    // 4) 机动性：动力/轴系/舵机受损（掉速即失去阵位与规避能力）
    const engine = (ship.subsystems || []).filter((s) => (s.kind === 'BOILER' || s.kind === 'SHAFT' || s.kind === 'STEERING_GEAR') && !s.destroyed && (s.health === undefined || s.health < 0.5)).length;
    if (engine) return 'mobility';
    // 5) 一般进水/小火灾：仍按主要问题排（少量进水优先堵漏，小火灾其次）
    if (ship.floodedM3 > 0.5 || Math.abs(ship.list || 0) > 3) return 'flooding';
    if (fireSum > 0) return 'fire';
    return null;
  }
}
