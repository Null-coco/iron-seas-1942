// 侧栏面板 v4 —— 「结构只在必要时重建，数值走实时补丁」。
//
// 为什么这样写：v3 每 200ms 用 innerHTML 整块重建面板，用户按下鼠标到松开之间
// 节点被换掉，click 事件落到父节点上，于是「按钮点了没反应」。v4 的规则是：
//   1) 只有结构签名（选中舰、页签、舰船存活集合…）变化时才重建 DOM；
//   2) 所有高频数字都带 data-live 标记，用 patchLive() 直接改文本，不碰节点；
//   3) 指针按下或焦点在面板内时，绝不重建。
// 这样点击永远命中同一个元素。
import { esc } from "./esc.js";
import { NMI, fmtClockHM } from "../core/util.js";
import { LLM_PRESETS, LLM_MODELS } from "../ai/bridge.js";

export const TYPE_ZH = { BB: "战列舰", BC: "战列巡洋舰", CA: "重巡洋舰", CL: "轻巡洋舰", DD: "驱逐舰", CV: "航空母舰" };
const ROLE_ZH = { main: "主炮", secondary: "副炮", aa: "高射炮" };
const DC_ZH = { flooding: "堵漏排水", fire: "灭火", magazine: "弹药库注水", mobility: "抢修动力" };
const SIDE_ZH = { ALLIED: "同盟国", AXIS: "轴心国" };
const SIDE_CLS = { ALLIED: "info", AXIS: "bad" };
const ROLE_ZH2 = { CAPTAIN: "舰长", FLEET: "编队指挥官", DEPARTMENT: "部门（CIC/损管/轮机）" };

const pct = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100);
const barCls = (v) => (v > 0.6 ? "" : v > 0.3 ? "warn" : "bad");
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const bar = (v, cls) => '<div class="bar"><i class="' + (cls === undefined ? barCls(v) : cls) + '" style="width:' + pct(v) + '%"></i></div>';
const lvbar = (key, v, cls) => '<div class="bar"><i class="' + (cls === undefined ? barCls(v) : cls) + '" data-live="' + key + '" style="width:' + pct(v) + '%"></i></div>';
const lv = (key, text) => '<span data-live="' + key + '">' + text + '</span>';
const card = (title, hint, body) => '<div class="card"><h4>' + title + (hint ? "<em>" + hint + "</em>" : "") + "</h4>" + body + "</div>";
const stat = (label, value, unit) => '<div class="stat"><span>' + label + '</span><b>' + value + (unit ? "<small>" + unit + "</small>" : "") + "</b></div>";
const statL = (label, key, value, unit) => '<div class="stat"><span>' + label + '</span><b>' + lv(key, value) + (unit ? "<small>" + unit + "</small>" : "") + "</b></div>";

// ============================================================ 编队列表
function shipMeta(s) {
  return s.speed.toFixed(1) + "kn · 航向 " + String(s.heading).padStart(3, "0") + "° · 舵 " + s.rudder + "° · 舰员 " + Math.round(s.crewPct * 100) + "%";
}
// 紧凑行只保留"一眼要看的两个数"：航速与航向。舵角/舰员这类细节在选中后的详情卡里。
function shipMetaShort(s) {
  return s.speed.toFixed(1) + " kn · " + String(Math.round(s.heading)).padStart(3, "0") + "°";
}
// 状态点：完好 / 带伤 / 沉没。用 patchLive 的 {c: className} 通道实时换类名。
function shipDotCls(s, live) {
  const base = s.side === "AXIS" ? "frDot axis" : "frDot";
  if (!live || !live.isAfloat) return base + " dead";
  if (s.floodedPct > 1 || s.fires || Math.abs(s.list) > 8) return base + " hurt";
  return base;
}
function shipFlags(s, live) {
  if (!live || !live.isAfloat) return '<span class="pill bad">沉没</span>';
  const f = [];
  if (s.floodedPct > 1) f.push('<span class="pill warn">进水 ' + s.floodedPct + "%</span>");
  if (s.fires) f.push('<span class="pill bad">火灾 ' + s.fires + "</span>");
  if (Math.abs(s.list) > 8) f.push('<span class="pill bad">横倾 ' + Math.round(s.list) + "°</span>");
  if (live.commanded && live.commanded.firing) f.push('<span class="pill info">交战中</span>');
  if (!f.length) f.push('<span class="pill ok">完好</span>');
  return f.join(" ");
}
function fleetList(ctx, side) {
  const { world, state } = ctx;
  const list = ctx.st.ownShips.filter((s) => !side || s.side === side);
  if (!list.length) return '<div class="sub">没有可显示的舰船。</div>';
  const afloat = list.filter((s) => { const l = world.ship(s.id); return l && l.isAfloat; }).length;
  let h = '<div class="fleet">' +
    '<div class="fleetSum">共 ' + list.length + ' 艘 · 在航 ' + afloat + ' 艘</div>';
  for (const s of list) {
    const live = world.ship(s.id);
    const sel = s.id === state.selectedShipId ? " sel" : "";
    h += '<div class="fleetRow' + sel + '" data-act="select-ship" data-arg="' + esc(s.id) + '" title="点击选中 ' + esc(s.name) + '">' +
      '<span class="' + shipDotCls(s, live) + '" data-live="fld.' + esc(s.id) + '"></span>' +
      '<span class="frMain">' +
        '<span class="frLine"><span class="frName">' + esc(s.name) + '</span><span class="frType">' + (TYPE_ZH[s.type] || s.type) + "</span></span>" +
        '<span class="frFlags" data-live="flf.' + esc(s.id) + '">' + shipFlags(s, live) + "</span>" +
      "</span>" +
      '<span class="frMeta" data-live="fl.' + esc(s.id) + '">' + shipMetaShort(s) + "</span>" +
    "</div>";
  }
  return h + "</div>";
}
function fleetLive(ctx, side, out) {
  const { world } = ctx;
  for (const s of ctx.st.ownShips) {
    if (side && s.side !== side) continue;
    const live = world.ship(s.id);
    out["fl." + s.id] = shipMetaShort(s);
    out["flf." + s.id] = { h: shipFlags(s, live) };
    out["fld." + s.id] = { c: shipDotCls(s, live) };
  }
}

// ============================================================ 舰况
export function renderShipPane(ctx) {
  const { world, state, st } = ctx;
  const spec = !!st.spectate;
  let h = "";
  if (spec) {
    h += card('同盟国编队 <span class="pill info">观战·全知</span>', "点击查看详情", fleetList(ctx, "ALLIED"));
    h += card("轴心国编队", "点击查看详情", fleetList(ctx, "AXIS"));
  } else {
    h += card("我方编队 <span class=\"pill gold\">" + esc((SIDE_ZH[state.side] || "")) + "</span>", "点击选中", fleetList(ctx, state.side));
  }
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) {
    return h + '<div class="sect-tip">在海图上点选一艘舰，或点上面的编队列表。选中后，底部<b>指挥台</b>的全部按钮都作用于这艘舰。</div>';
  }
  const d = sel.data;
  const gm = sel.effectiveGMm || sel.gm0M || 0;
  const spdMax = Math.max(1, d.speedMax_kn || 30);
  const spdK = clamp01(sel.speed / spdMax);
  const rudK = clamp01((sel.rudder + 35) / 70);
  const listK = clamp01((sel.list + 40) / 80);
  const floodK = clamp01(sel.floodedM3 / Math.max(1, sel.reserveBuoyancyM3));
  const mainAmmo = (sel.mainBatteries || []).reduce((a, b) => a + b.ammo.AP + b.ammo.HE, 0);
  const torps = (sel.torpedoMounts || []).reduce((a, m) => a + (m.destroyed ? 0 : m.tubesLoaded), 0);
  const fires = sel.compartments.filter((c) => c.fire > 0.05).length;

  h += card(esc(sel.name) + ' <span class="pill ' + (SIDE_CLS[sel.side] || "") + '">' + (SIDE_ZH[sel.side] || sel.side) + "</span>", esc(sel.className || ""),
    '<div class="stats">' +
      statL("航速", "sh.spd", sel.speed.toFixed(1), "kn") +
      statL("航向", "sh.hdg", String(Math.round(sel.heading)).padStart(3, "0"), "°") +
      statL("航速上限", "sh.cap", sel.speedCapKn.toFixed(1), "kn") +
      statL("回转率", "sh.turn", sel.turnRate.toFixed(2), "°/s") +
      statL("横倾", "sh.list", sel.list.toFixed(1), "°") +
      statL("纵倾", "sh.trim", sel.trim.toFixed(1), "°") +
      statL("吃水", "sh.draft", sel.draftM.toFixed(2), "m") +
      statL("干舷", "sh.free", sel.freeboardM.toFixed(2), "m") +
    "</div>" +
    '<div style="margin-top:9px">' + lvbar("sh.spdBar", spdK, spdK < 0.4 ? "bad" : spdK < 0.7 ? "warn" : "") + "</div>" +
    '<div class="sub dim" style="margin-top:3px">舵 ' + lv("sh.rud", (sel.rudder > 0 ? "右 " : sel.rudder < 0 ? "左 " : "正 ") + Math.abs(sel.rudder).toFixed(0) + "°") +
      " · 进水 " + lv("sh.flood", Math.round(sel.floodedM3) + " m³") +
      (fires ? ' · <span style="color:var(--red)">火灾 ' + fires + " 处</span>" : "") + "</div>");

  h += card("舰体与人员", "",
    '<div class="kv">' +
      "<span>舰种 / 国籍</span><span>" + (TYPE_ZH[sel.type] || sel.type) + " · " + esc(sel.nation) + " · " + sel.year + "</span>" +
      "<span>排水量</span><span>" + (d.displacementFull_t || "?") + " t</span>" +
      "<span>稳性 GM</span><span>" + lv("sh.gm", gm.toFixed(2)) + " m</span>" +
      "<span>舰员</span><span>" + lv("sh.crew", Math.round(sel.crew) + " / " + sel.crew0 + " · 素质 " + sel.crewQuality.toFixed(2)) + "</span>" +
      "<span>排水能力</span><span>" + sel.pumpCapacity.toFixed(0) + " m³/min · 损管 " + sel.dcParties + " 组</span>" +
      "<span>主炮弹药</span><span>" + lv("sh.ammo", mainAmmo + " 发") + " · 鱼雷 " + lv("sh.torp", torps + " 管") + "</span>" +
      "<span>当前指令</span><span>" + lv("sh.cmd", Math.round(sel.commanded.heading) + "° / " + sel.commanded.speed.toFixed(0) + "kn" + (sel.commanded.firing ? " / 射击中" : "")) + "</span>" +
    "</div>");

  const pending = world.pending.filter((c) => c.shipId === sel.id).slice(0, 6);
  if (pending.length) {
    h += card("待生效命令", '指挥延迟 ' + Math.round(pending[0].t_effective - world.t) + "s",
      pending.map((c) => '<div class="row"><span class="n">' + esc(c.kind) + '</span><span class="v">' + esc(JSON.stringify(c.params || {}).slice(0, 30)) + " · t+" + Math.max(0, Math.round(c.t_effective - world.t)) + "s</span></div>").join(""));
  }

  if (spec) {
    return h + '<div class="sect-tip">观战模式不能下达命令。顶栏「镜头」可切导播 / 自由 / 跟随任一方。</div>';
  }

  const ai = world.ai[state.side];
  const auto = ai ? ai.autoCommand !== false : false;
  const role = state.role;
  let cmd = '<div class="grid2" style="margin-bottom:7px">' +
    '<div class="abtn' + (auto ? " on" : "") + '" data-act="ai-auto">' + (auto ? "自动指挥：开" : "自动指挥：关") + "</div>" +
    '<div class="abtn" data-act="ai-now">让 AI 立即决策</div></div>';
  cmd += '<div class="sub dim" style="margin-bottom:7px">' + (auto
    ? "AI 会替你打；你下的命令优先，5 分钟仿真时间内不会被覆盖。"
    : "AI 只当参谋：不再下达命令，全部由你指挥。") + "</div>";
  if (role === "CAPTAIN") {
    cmd += '<div class="grid2">' +
      '<div class="abtn gold" data-act="course">设定航向…</div><div class="abtn" data-act="rudder" data-arg="0">舵回正</div>' +
      '<div class="abtn" data-act="rudder" data-arg="15">右舵 15°</div><div class="abtn" data-act="rudder" data-arg="-15">左舵 15°</div>' +
      '<div class="abtn" data-act="rudder" data-arg="35">右满舵</div><div class="abtn" data-act="rudder" data-arg="-35">左满舵</div></div>' +
      '<div class="grid3" style="margin-top:6px">' +
      '<div class="abtn" data-act="speed" data-arg="0">停车</div><div class="abtn" data-act="speed" data-arg="12">12 节</div><div class="abtn" data-act="speed" data-arg="20">20 节</div>' +
      '<div class="abtn" data-act="speed" data-arg="26">26 节</div><div class="abtn" data-act="speed" data-arg="30">30 节</div><div class="abtn gold" data-act="speed" data-arg="full">全速</div></div>' +
      '<div class="grid2" style="margin-top:6px">' +
      '<div class="abtn" data-act="smoke" data-arg="toggle">烟幕 开/关</div><div class="abtn" data-act="chaff">施放箔条</div>' +
      '<div class="abtn" data-act="searchlight" data-arg="toggle">探照灯 开/关</div><div class="abtn" data-act="radar" data-arg="toggle">雷达 开/关</div>' +
      '<div class="abtn" data-act="follow" data-arg="on">镜头跟随本舰</div><div class="abtn" data-act="follow" data-arg="off">取消跟随</div></div>' +
      '<div class="grid2" style="margin-top:6px"><div class="abtn" data-act="withdraw">撤出战斗</div><div class="abtn" data-act="ceasefire">全炮停火</div></div>';
  } else if (role === "FLEET") {
    cmd += '<div class="sub dim">命令作用于本方全部在航舰；经旗舰中继有指挥延迟（本剧本约 ' +
      (world.sides[state.side] ? world.sides[state.side].orderDelay_s : "?") + " 秒，超视距再加 " + world.radioRelayPenaltyS + " 秒）。</div>" +
      '<div class="grid2" style="margin-top:7px">' +
      '<div class="abtn gold" data-act="course">全队转向…</div><div class="abtn" data-act="speed" data-arg="20">全队 20 节</div>' +
      '<div class="abtn" data-act="fire" data-arg="AP">全队开火</div><div class="abtn" data-act="withdraw">全队撤退</div></div>';
  } else {
    cmd += '<div class="sub dim">部门层：直接干预损管与设备，不经过舰长决策。</div><div class="grid2" style="margin-top:7px">' +
      '<div class="abtn" data-act="dc" data-arg="flooding">优先堵漏</div><div class="abtn" data-act="dc" data-arg="fire">优先灭火</div>' +
      '<div class="abtn" data-act="dc" data-arg="magazine">弹药库注水</div><div class="abtn" data-act="dc" data-arg="mobility">抢修动力</div></div>';
  }
  h += card("指挥层级 · " + (ROLE_ZH2[role] || role), "顶栏可切换", cmd);
  h += '<div class="sub dim">快捷键：空格暂停 · 1~4 变速 · Tab 切页签 · ←/→ 选舰 · ↑/↓ 选目标 · G 跟随 · C 取消 · F 取景 · T 换目标 · Esc 取消 · 右键海图下令</div>';
  return h;
}

export function liveShipPane(ctx, out) {
  const { world, state, st } = ctx;
  const spec = !!st.spectate;
  if (spec) { fleetLive(ctx, "ALLIED", out); fleetLive(ctx, "AXIS", out); }
  else fleetLive(ctx, state.side, out);
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return out;
  const spdMax = Math.max(1, sel.data.speedMax_kn || 30);
  const spdK = clamp01(sel.speed / spdMax);
  const floodK = clamp01(sel.floodedM3 / Math.max(1, sel.reserveBuoyancyM3));
  const mainAmmo = (sel.mainBatteries || []).reduce((a, b) => a + b.ammo.AP + b.ammo.HE, 0);
  const torps = (sel.torpedoMounts || []).reduce((a, m) => a + (m.destroyed ? 0 : m.tubesLoaded), 0);
  out["sh.spd"] = sel.speed.toFixed(1);
  out["sh.hdg"] = String(Math.round(sel.heading)).padStart(3, "0");
  out["sh.cap"] = sel.speedCapKn.toFixed(1);
  out["sh.turn"] = sel.turnRate.toFixed(2);
  out["sh.list"] = sel.list.toFixed(1);
  out["sh.trim"] = sel.trim.toFixed(1);
  out["sh.draft"] = sel.draftM.toFixed(2);
  out["sh.free"] = sel.freeboardM.toFixed(2);
  out["sh.spdBar"] = { w: spdK, c: spdK < 0.4 ? "bad" : spdK < 0.7 ? "warn" : "" };
  out["sh.rud"] = (sel.rudder > 0 ? "右 " : sel.rudder < 0 ? "左 " : "正 ") + Math.abs(sel.rudder).toFixed(0) + "°";
  out["sh.flood"] = Math.round(sel.floodedM3) + " m³";
  out["sh.gm"] = (sel.effectiveGMm || sel.gm0M || 0).toFixed(2);
  out["sh.crew"] = Math.round(sel.crew) + " / " + sel.crew0 + " · 素质 " + sel.crewQuality.toFixed(2);
  out["sh.ammo"] = mainAmmo + " 发";
  out["sh.torp"] = torps + " 管";
  out["sh.cmd"] = Math.round(sel.commanded.heading) + "° / " + sel.commanded.speed.toFixed(0) + "kn" + (sel.commanded.firing ? " / 射击中" : "");
  return out;
}
export function sigShipPane(ctx) {
  const { world, state, st } = ctx;
  const list = ctx.st.ownShips
    .filter((s) => st.spectate || s.side === state.side)
    .map((s) => s.id + (world.ship(s.id).isAfloat ? "a" : "d"))
    .join(",");
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  return [st.spectate ? "S" : "P", state.side, state.role, state.selectedShipId, world.pending.length,
    list, sel ? (world.ai[state.side] ? (world.ai[state.side].autoCommand !== false ? 1 : 0) : 0) : 0].join("|");
}

// ============================================================ 火控
export function renderFirePane(ctx) {
  const { world, state } = ctx;
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return '<div class="sect-tip">先选择一艘舰（观战模式下可点任意一方）。</div>';
  // 356px 的侧栏塞不下 8 列表格（表头会被挤成竖排单字）。
  // 状态改用彩色圆点放在炮座名前，磨损并进「已射」，压成 4 列。
  let rows = "";
  for (const b of sel.batteries) {
    const dot = b.destroyed ? "bad" : b.jammed ? "warn" : b.health < 0.6 ? "warn" : "ok";
    const tip = b.destroyed ? "损毁" : b.jammed ? "卡死" : b.health < 0.6 ? "受损" : "可用";
    rows += '<tr><td class="nm"><span class="dot ' + dot + '" title="' + tip + '"></span>' + esc(b.label) +
      '<div class="tblsub">' + (ROLE_ZH[b.role] || b.role) + " " + b.gunsPerMount + "×" + (b.data.bore_mm || "?") + "mm</div></td>" +
      '<td class="n" data-live="fb.' + esc(b.id) + '.ld">' + b.loaded + "/" + b.gunsPerMount + "</td>" +
      '<td class="n"><span data-live="fb.' + esc(b.id) + '.ap">' + b.ammo.AP + '</span> / <span data-live="fb.' + esc(b.id) + '.he">' + b.ammo.HE + "</span></td>" +
      '<td class="n"><span data-live="fb.' + esc(b.id) + '.fired">' + b.roundsFired + '</span><div class="tblsub">磨损 ' + (b.wear !== undefined ? pct(b.wear) + "%" : "—") + "</div></td></tr>";
  }
  let h = card("火炮与射击指挥", esc(sel.name) + " · " + sel.batteries.length + " 座",
    '<table class="tbl"><thead><tr><th>炮座</th><th class="n">装填</th><th class="n">AP / HE</th><th class="n">已射</th></tr></thead><tbody>' + rows + "</tbody></table>");

  let dirs = "";
  for (const dir of sel.directors) {
    const sol = dir.solution;
    dirs += '<div class="row"><span class="n">' + esc(dir.label) + '</span><span class="v">' +
      (dir.destroyed ? '<span class="pill bad">损毁</span>' : dir.hasFCComputer ? '<span class="pill info">火控计算机</span>' : '<span class="pill">仅光学</span>') + "</span></div>";
    if (sol) {
      dirs += '<div class="kv" style="margin:5px 0 9px">' +
        "<span>目标</span><span>" + esc(sol.trackId || dir.trackingTrackId || "—") + "</span>" +
        "<span>距离</span><span>" + (sol.rangeM ? Math.round(sol.rangeM) + " m" : "—") + "</span>" +
        "<span>方向修正</span><span>" + (sol.deflectionMil !== undefined ? sol.deflectionMil.toFixed(1) + " mil" : "—") + "</span>" +
        "<span>飞行时间</span><span>" + (sol.timeOfFlightS !== undefined ? sol.timeOfFlightS.toFixed(1) + " s" : "—") + "</span>" +
        "<span>散布</span><span>" + (sol.spreadMil !== undefined ? sol.spreadMil.toFixed(2) + " mil" : "—") + "</span></div>";
    } else dirs += '<div class="sub dim" style="margin-bottom:8px">未解算（需要选定目标并跟踪 30~90 秒）</div>';
  }
  h += card("射击指挥仪与解算", "", dirs || '<div class="sub dim">本舰无射击指挥仪。</div>');

  let sens = "";
  for (const s of sel.sensors) {
    const info = [];
    if (s.data && s.data.detectBB_nm) info.push("对大型目标 " + s.data.detectBB_nm + "nm");
    if (s.data && s.data.wavelength_cm) info.push(s.data.wavelength_cm + "cm");
    sens += '<div class="row"><span class="n">' + esc(s.label) + '</span><span class="v">' +
      (s.destroyed ? '<span class="pill bad">损毁</span>' : s.on ? '<span class="pill ok">开机</span>' : '<span class="pill">关机</span>') +
      (s.jammed ? ' <span class="pill warn">受干扰</span>' : "") + '</span></div>' +
      (info.length ? '<div class="sub dim" style="margin:-2px 0 6px">' + info.join(" · ") + "</div>" : "");
  }
  h += card("雷达与声呐", "", sens || '<div class="sub dim">本舰无电子设备（1941 年的意大利舰即如此）。</div>');

  if (!ctx.st.spectate) {
    h += card("火力控制", state.selectedTrackId ? "目标 " + esc(state.selectedTrackId) : "未选目标",
      '<div class="grid2">' +
      '<div class="abtn gold" data-act="fire" data-arg="AP">开火 · 穿甲弹</div><div class="abtn" data-act="fire" data-arg="HE">开火 · 榴弹</div>' +
      '<div class="abtn" data-act="ceasefire">全炮停火</div><div class="abtn" data-act="torp-all">全管紧急放雷</div></div>' +
      (state.selectedTrackId ? "" : '<div class="sub dim" style="margin-top:6px">先在「情报」页或海图上点选目标航迹，才能开火。</div>'));

    // ── 鱼雷控制 ────────────────────────────────────────────────────────────
    const mounts = sel.torpedoMounts || [];
    const loaded = mounts.reduce((a, m) => a + (m.destroyed ? 0 : m.tubesLoaded), 0);
    const inWater = (world.torpedoes || []).filter((t) => t.alive && t.side === state.side).length;
    const st = state.torp || (state.torp = { depth: 'MED', speed: 'HIGH', tubes: 4, spread: 6 });
    const seg = (act, key, val, label, on) => '<div class="abtn' + (on ? " on" : "") + '" data-act="' + act + '" data-arg="' + key + ':' + val + '">' + label + "</div>";
    let mrows = "";
    for (const m of mounts) {
      mrows += "<tr><td class=\"nm\">" + esc(m.label) + "</td><td class=\"n\">" +
        (m.destroyed ? '<span class="pill bad">损毁</span>' : m.tubesLoaded + "/" + m.tubes) + "</td><td class=\"n\">" + (m.reloads || 0) + "</td>" +
        "<td class=\"n\">" + (m.destroyed ? "—" : (m.tubesLoaded > 0 ? '<span class="pill ok">待发</span>' : '<span class="pill warn">装填</span>')) + "</td>" +
        "<td class=\"n\">" + (m.destroyed || m.tubesLoaded <= 0 ? "—" : '<span class="abtn" data-act="torp-mount" data-arg="' + m.id + '">单管射</span>') + "</td></tr>";
    }
    h += card("鱼雷", loaded + " 管待发 · " + inWater + " 条在航",
      (mounts.length ? '<table class="tbl"><thead><tr><th>发射管</th><th class="n">装填</th><th class="n">再装</th><th class="n">状态</th><th class="n">发射</th></tr></thead><tbody>' + mrows + "</tbody></table>"
        : '<div class="sub dim">本舰无鱼雷发射管（1941 年的意大利战列舰即如此）。</div>') +
      '<div class="sub" style="margin-top:9px">定深（越大越不易从船底通过，但浅水会触底）</div>' +
      '<div class="grid4">' + seg("torp-set", "depth", "SHALLOW", "浅 2m", st.depth === "SHALLOW") + seg("torp-set", "depth", "MED", "中 4m", st.depth === "MED") + seg("torp-set", "depth", "DEEP", "深 6m", st.depth === "DEEP") + "</div>" +
      '<div class="sub" style="margin-top:7px">航速档（高速近射 / 低速远射）</div>' +
      '<div class="grid2">' + seg("torp-set", "speed", "HIGH", "高速", st.speed === "HIGH") + seg("torp-set", "speed", "LOW", "低速·远射程", st.speed === "LOW") + "</div>" +
      '<div class="sub" style="margin-top:7px">管数 / 扇面</div>' +
      '<div class="grid4">' + seg("torp-set", "tubes", "1", "1 管", st.tubes === 1) + seg("torp-set", "tubes", "2", "2 管", st.tubes === 2) + seg("torp-set", "tubes", "4", "4 管", st.tubes === 4) + seg("torp-set", "tubes", "99", "全管", st.tubes >= 90) + "</div>" +
      '<div class="grid4" style="margin-top:4px">' + seg("torp-set", "spread", "3", "窄 3°", st.spread === 3) + seg("torp-set", "spread", "6", "中 6°", st.spread === 6) + seg("torp-set", "spread", "10", "宽 10°", st.spread === 10) + seg("torp-set", "spread", "16", "极宽 16°", st.spread === 16) + "</div>" +
      '<div class="grid2" style="margin-top:8px">' +
      '<div class="abtn gold" data-act="torp-fire">按目标航迹齐射</div><div class="abtn" data-act="torp-bearing">按当前舷角射</div></div>' +
      '<div class="sub dim" style="margin-top:6px">1942 年鱼雷无制导：解算靠拦截三角，误差来自航迹航向/航速与定深。日军九三式无航迹（难被发现），美军 Mk 15 有明显航迹且 1942 年哑弹率高。</div>');
  }
  return h;
}
export function liveFirePane(ctx, out) {
  const { world, state } = ctx;
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return out;
  for (const b of sel.batteries) {
    out["fb." + b.id + ".ld"] = b.loaded + "/" + b.gunsPerMount;
    out["fb." + b.id + ".ap"] = String(b.ammo.AP);
    out["fb." + b.id + ".he"] = String(b.ammo.HE);
    out["fb." + b.id + ".fired"] = String(b.roundsFired);
  }
  return out;
}
export function sigFirePane(ctx) {
  const { world, state } = ctx;
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return "none";
  return [state.selectedShipId, state.selectedTrackId,
    sel.batteries.map((b) => b.id + (b.destroyed ? "D" : b.jammed ? "J" : b.health < 0.6 ? "H" : "")).join(""),
    sel.sensors.map((s) => s.id + (s.on ? "1" : "0") + (s.destroyed ? "D" : "")).join(""),
    sel.directors.map((d) => d.id + (d.solution ? "S" : "-") + (d.destroyed ? "D" : "")).join("")].join("|");
}

// ============================================================ 损管
export function renderDamagePane(ctx) {
  const { world, state } = ctx;
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return '<div class="sect-tip">先选择一艘舰。</div>';
  const floodK = Math.min(1, sel.floodedM3 / Math.max(1, sel.reserveBuoyancyM3));
  const depthHere = world && world.depth && !world.depth.empty ? world.depth.depthAt(sel.pos.x, sel.pos.y) : null;
  const shoalWarn = depthHere !== null && depthHere < sel.draftM + 2;
  let h = card("损管总览", esc(sel.name) + " · " + (DC_ZH[sel.dcPriority || "flooding"] || "—"),
    '<div class="stats">' +
      statL("进水", "dm.flood", Math.round(sel.floodedM3), "m³") +
      statL("储备浮力", "dm.reserve", Math.round(sel.reserveBuoyancyM3), "m³") +
      statL("横倾", "dm.list", sel.list.toFixed(1), "°") +
      statL("干舷", "dm.free", sel.freeboardM.toFixed(2), "m") +
      statL("泵排量", "dm.pump", sel.pumpCapacity.toFixed(0), "m³/min") +
      stat("损管队", sel.dcParties, "组") +
      (depthHere !== null ? statL("水深", "dm.depth", depthHere.toFixed(0), "m") : "") +
      (depthHere !== null ? stat("龙骨下", (depthHere - sel.draftM).toFixed(1), "m") : "") +
    "</div>" +
    '<div style="margin-top:9px">' + lvbar("dm.floodBar", floodK, floodK > 0.3 ? "bad" : floodK > 0.1 ? "warn" : "") + "</div>" +
    '<div class="sub dim" style="margin-top:4px">进水占储备浮力 ' + lv("dm.floodPct", pct(floodK) + "%") +
      (Math.abs(sel.list) > 15 ? ' · <b style="color:var(--red)">横倾危险</b>' : "") +
      (shoalWarn ? ' · <b style="color:var(--amber)">浅水：龙骨下仅 ' + (depthHere - sel.draftM).toFixed(1) + "m</b>" : "") + "</div>");

  let rows = "";
  for (const c of sel.compartments) {
    if (c.flood_m3 < 1 && c.fire < 0.02 && c.integrity > 0.99) continue;
    const kind = c.isMagazine ? "弹药库" : c.isMachinery ? "动力舱" : c.isSteering ? "舵机舱" : c.kind === "BOW" ? "艏部" : c.kind === "STERN" ? "艉部" : "舱室";
    const patch = c.patch > 0.02 ? '<span class="pill ok">' + pct(c.patch) + "%</span>" : c.counterflooded ? '<span class="pill warn">反注水</span>' : "—";
    rows += '<tr><td class="n">' + c.i + '</td><td class="nm">' + kind + '</td><td class="n">' + pct(c.integrity) + "%</td>" +
      '<td class="n" data-live="dc.' + c.i + '.f">' + Math.round(c.flood_m3) + "</td>" +
      '<td class="n" data-live="dc.' + c.i + '.x">' + (c.fire > 0.02 ? '<span class="pill bad">' + pct(c.fire) + "%</span>" : "—") + "</td>" +
      '<td class="n">' + patch + "</td></tr>";
  }
  h += card("受损舱段", rows ? "" : "全舰水密完好",
    rows ? '<table class="tbl"><thead><tr><th class="n">#</th><th>部位</th><th class="n">完整</th><th class="n">进水</th><th class="n">火</th><th class="n">堵漏</th></tr></thead><tbody>' + rows + "</tbody></table>"
      : '<div class="sub">未检测到进水、火灾或结构破损。</div>');

  let subs = "";
  for (const s of sel.subsystems) {
    subs += '<div class="row"><span class="n">' + esc(s.name) + '</span><span class="v">' + (s.destroyed ? '<span class="pill bad">损毁</span>' : pct(s.health) + "%") + "</span></div>" + bar(s.health);
  }
  h += card("关键设备", "", subs || '<div class="sub dim">无数据。</div>');

  if (!ctx.st.spectate) {
    h += card("损管指令", "",
      '<div class="grid2">' +
      '<div class="abtn' + ((sel.dcPriority || "flooding") === "flooding" ? " on" : "") + '" data-act="dc" data-arg="flooding">优先堵漏排水</div>' +
      '<div class="abtn' + (sel.dcPriority === "fire" ? " on" : "") + '" data-act="dc" data-arg="fire">优先灭火</div>' +
      '<div class="abtn' + (sel.dcPriority === "magazine" ? " on" : "") + '" data-act="dc" data-arg="magazine">弹药库注水</div>' +
      '<div class="abtn' + (sel.dcPriority === "mobility" ? " on" : "") + '" data-act="dc" data-arg="mobility">抢修动力</div></div>' +
      '<div class="sub dim" style="margin-top:8px">横倾超过 60° 会倾覆；弹药库持续燃烧可能殉爆；损管队同时只能干一件事。' +
      "<b>堵漏</b>需要数分钟才见效（破口越大越慢），堵住后进水率随之下降；横倾过大时损管会自动<b>反注水</b>扶正（代价是吃水增加）。</div>");
  }
  return h;
}
export function liveDamagePane(ctx, out) {
  const { world, state } = ctx;
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return out;
  const floodK = Math.min(1, sel.floodedM3 / Math.max(1, sel.reserveBuoyancyM3));
  const depthHere = world && world.depth && !world.depth.empty ? world.depth.depthAt(sel.pos.x, sel.pos.y) : null;
  out["dm.flood"] = String(Math.round(sel.floodedM3));
  out["dm.reserve"] = String(Math.round(sel.reserveBuoyancyM3));
  out["dm.list"] = sel.list.toFixed(1);
  out["dm.free"] = sel.freeboardM.toFixed(2);
  out["dm.pump"] = sel.pumpCapacity.toFixed(0);
  if (depthHere !== null) out["dm.depth"] = depthHere.toFixed(0);
  out["dm.floodBar"] = { w: floodK, c: floodK > 0.3 ? "bad" : floodK > 0.1 ? "warn" : "" };
  out["dm.floodPct"] = pct(floodK) + "%";
  for (const c of sel.compartments) {
    out["dc." + c.i + ".f"] = String(Math.round(c.flood_m3));
    out["dc." + c.i + ".x"] = { h: c.fire > 0.02 ? '<span class="pill bad">' + pct(c.fire) + "%</span>" : "—" };
  }
  return out;
}
export function sigDamagePane(ctx) {
  const { world, state } = ctx;
  const sel = state.selectedShipId ? world.ship(state.selectedShipId) : null;
  if (!sel) return "none";
  const dmg = sel.compartments.filter((c) => c.flood_m3 >= 1 || c.fire >= 0.02 || c.integrity <= 0.99).map((c) => c.i + (c.counterflooded ? "c" : "") + (c.patch > 0.02 ? "p" : "")).join(",");
  return [state.selectedShipId, sel.dcPriority, dmg,
    sel.subsystems.map((s) => s.kind + s.destroyed).join(""), ctx.st.spectate ? 1 : 0].join("|");
}

// ============================================================ 情报
// 航迹卡片：374px 的侧栏放不下 10 列表格（表头会被挤成竖排单字）。
// 改成两行摘要 + 一个置信度徽标，点击整卡即指定为目标。
function trackItem(t, spec, selected) {
  const conf = Math.round(t.confidence * 100);
  const cls = conf > 70 ? "ok" : conf > 40 ? "warn" : "bad";
  const id = esc(t.id);
  return '<div class="item' + (selected ? " sel" : "") + '" data-act="select-track" data-arg="' + id + '" title="点击指定为射击目标">' +
    '<div class="t"><b>' + id + "</b><span>" +
      (spec ? '<span class="pill ' + (SIDE_CLS[t.side] || "") + '">' + (SIDE_ZH[t.side] || "?") + "</span> " : "") +
      '<span class="pill ' + cls + '" data-live="tk.' + id + '.cf">' + conf + "%</span></span></div>" +
    '<div class="m" data-live="tk.' + id + '.r1">' + trackLine1(t, spec) + "</div>" +
    '<div class="m" data-live="tk.' + id + '.r2">' + trackLine2(t) + "</div></div>";
}
// 观战是全知视角：航迹的 rangeM 是"到最近敌舰"的距离，不是"到我方某舰"；标题必须写清楚
function trackLine1(t, spec) {
  return (spec ? "距最近敌 " : "距离 ") + (t.rangeM ? (t.rangeM / NMI).toFixed(2) + "nm" : "—") +
    " · 方位 " + (t.bearingDeg ? String(Math.round(t.bearingDeg)).padStart(3, "0") + "°" : "—") +
    " · 航向 " + t.courseDeg + "° · " + (t.speedKn > 0.5 ? t.speedKn + "kn" : "航速未知");
}
function trackLine2(t) {
  return "判型 " + (TYPE_ZH[t.classifiedAs] || t.classifiedAs || "未识别") + " · 误差 ±" + t.errM + "m · " + Math.round(t.ageS) + "s 前更新";
}

export function renderIntelPane(ctx) {
  const { state, st } = ctx;
  const spec = !!st.spectate;
  let h = "";
  if (!st.tracks.length) {
    h = card("情报 · 已探测航迹", "0 个",
      '<div class="sub">当前没有目标航迹。<b>未探测到的敌舰不会出现在海图上</b>——这正是本作与普通海战游戏最大的区别：你只能打你"看得见"的东西。</div>' +
      '<div class="sub dim" style="margin-top:6px">提高发现概率：开雷达 / 放照明弹 / 用探照灯 / 靠近。夜战与浓雾下光学测距几乎不可用。</div>');
  } else {
    let items = "";
    for (const t of st.tracks) items += trackItem(t, spec, state.selectedTrackId === t.id);
    h = card("情报 · 已探测航迹", spec ? st.tracks.length + " 个（全知）" : st.tracks.length + " 个 · 点击指定目标",
      '<div class="list">' + items + "</div>" +
      '<div class="sub dim" style="margin-top:8px">判型随观察时间与距离收敛：未识别 → 驱逐舰 → 巡洋舰 → 战列舰。误差椭圆表示"我们其实不知道它具体在哪"。</div>');
  }
  const env = st.environment;
  h += card("环境", "影响发现、射击与航速",
    '<div class="stats">' + stat("海况", env.seaState, "级") + stat("风", env.windKn, "kn") +
    stat("能见度", env.visibilityNm, "nm") + stat("光照", (env.lightLevel * 100).toFixed(0), "%") + "</div>" +
    '<div class="kv" style="margin-top:9px"><span>风来向</span><span>' + String(env.windDirDeg).padStart(3, "0") + "°</span>" +
    "<span>当地时间</span><span>" + (env.timeOfDayH || 0).toFixed(2) + " h</span>" +
    "<span>日出 / 日落</span><span>" + env.sunriseH.toFixed(1) + " / " + env.sunsetH.toFixed(1) + " h</span>" +
    "<span>月照</span><span>" + (env.moonIllum * 100).toFixed(0) + "%</span></div>" +
    '<div class="sub dim" style="margin-top:8px">光照低于 20% 视为夜战：光学测距与目视发现距离大幅下降，探照灯与照明弹重新变成关键装备。</div>');
  return h;
}
export function liveIntelPane(ctx, out) {
  const spec = !!ctx.st.spectate;
  for (const t of ctx.st.tracks) {
    const conf = Math.round(t.confidence * 100);
    out["tk." + t.id + ".cf"] = { h: '<span class="pill ' + (conf > 70 ? "ok" : conf > 40 ? "warn" : "bad") + '">' + conf + "%</span>" };
    out["tk." + t.id + ".r1"] = trackLine1(t, spec);
    out["tk." + t.id + ".r2"] = trackLine2(t);
  }
  return out;
}
export function sigIntelPane(ctx) {
  return ctx.st.tracks.map((t) => t.id + t.classifiedAs + (t.side || "")).join(",") + "|" + (ctx.st.spectate ? 1 : 0) + "|" + ctx.state.selectedTrackId;
}

// ============================================================ AI
function cmdChain(world, state) {
  const log = (state.cmdLog || []).slice(-14).reverse();
  if (!log.length) {
    return '<div class="sub">还没有指令。在底部指挥台用中文下达（例：全队转向 240 / 24 节 / 向最近的敌舰开火），这里会逐条显示回执。</div>';
  }
  return log.map((c) => {
    const nm = c.shipId && world.ship(c.shipId) ? world.ship(c.shipId).name : c.shipId || "全队";
    const left = Math.max(0, Math.round(c.tEff - world.t));
    const stt = c.effective ? '<span class="s done">已生效</span>' : '<span class="s wait">待 ' + left + "s</span>";
    return '<div class="cmdrow"><time>' + fmtClockHM(c.t) + '</time><span class="who ' + (c.isMine ? "mine" : "ai") + '">' + esc(c.by) + "</span>" +
      '<span class="k">' + esc(c.kind) + '</span><span class="p">' + esc(JSON.stringify(c.params)) + " → " + esc(nm) + "</span>" + stt + "</div>";
  }).join("");
}
function aiControls(world, side, ai) {
  if (!ai) return '<div class="sub">未启用。</div>';
  const stt = ai.status || {};
  const auto = ai.autoCommand !== false;
  const preset = ai.preset || "fast";
  const curModel = ai.llmModel || (LLM_PRESETS[preset] && LLM_PRESETS[preset].model) || "";
  const sa = ' data-side="' + side + '"';
  let h = '<div class="row"><span class="n"><span class="pill ' + (SIDE_CLS[side] || "") + '">' + SIDE_ZH[side] + '</span></span><span class="v">' + esc(ai.backend) + (auto ? "" : " · 参谋") + (stt.connected ? " · 已连接" : "") + "</span></div>";
  const bk = ["LOCAL", "REMOTE", "LLM"], bz = ["本地规则", "外部智能体", "大模型"];
  h += '<div class="grid3" style="margin-top:6px">' + bk.map((b, i) => '<div class="abtn' + (ai.backend === b ? " on" : "") + '" data-act="ai-backend" data-arg="' + b + '"' + sa + ">" + bz[i] + "</div>").join("") + "</div>";
  h += '<div class="grid3" style="margin-top:5px">' + ["fast", "balanced", "deep"].map((k) => '<div class="abtn' + (preset === k ? " on" : "") + '" data-act="ai-preset" data-arg="' + k + '"' + sa + ">" + LLM_PRESETS[k].nameZh + "</div>").join("") + "</div>";
  h += '<div class="grid2" style="margin-top:5px"><select id="aiModelSel_' + side + '" class="btn" style="padding:4px 6px">' +
    LLM_MODELS.map((m) => '<option value="' + m + '"' + (m === curModel ? " selected" : "") + ">" + m + "</option>").join("") +
    '</select><div class="abtn" data-act="ai-model"' + sa + ">应用模型</div></div>";
  h += '<div class="grid3" style="margin-top:5px">' +
    '<div class="abtn' + (auto ? " on" : "") + '" data-act="ai-auto"' + sa + ">" + (auto ? "自动指挥 开" : "自动指挥 关") + "</div>" +
    '<div class="abtn" data-act="ai-now"' + sa + ">立即决策</div>" +
    '<div class="abtn" data-act="ai-ctx-reset"' + sa + ">清空记忆</div></div>";
  h += '<div class="kv" style="margin-top:7px"><span>决策 / 回落</span><span>' + (stt.decisions || 0) + " / " + (stt.fallbacks || 0) + "</span>" +
    "<span>上次 / 平均</span><span>" + (stt.lastLatencyMs ? (stt.lastLatencyMs / 1000).toFixed(1) + "s / " + ((stt.avgLatencyMs || 0) / 1000).toFixed(1) + "s" : "—") + "</span>" +
    "<span>周期 / 超时</span><span>" + ai.intervalS + "s / " + ai.timeoutS + "s</span></div>";
  h += '<div class="sub dim" style="margin-top:5px">' + esc(String(ai.local && ai.local.lastReasoning ? ai.local.lastReasoning : "（暂无决策理由）").slice(0, 150)) + "</div>";
  return h;
}

export function renderAIPane(ctx) {
  const { world, state, st } = ctx;
  const spec = !!st.spectate;
  if (spec) {
    let h = card('同盟国 AI <span class="pill violet">观战</span>', "可独立设置", aiControls(world, "ALLIED", world.ai["ALLIED"]));
    h += card("轴心国 AI", "可独立设置", aiControls(world, "AXIS", world.ai["AXIS"]));
    h += card("指令回执", "谁下的令 → 什么令 → 给谁 → 何时生效", cmdChain(world, state));
    h += '<div class="sub dim">双方可分别选择后端（本地规则 / 外部智能体 / 大模型）、速度预设与模型。「自动指挥 关」会让该方停手只当参谋。</div>';
    return h;
  }
  const ai = world.ai[state.side];
  if (!ai) return '<div class="sub">本局未启用 AI 控制。</div>';
  const stt = ai.status || {};
  let h = card("AI 后端", "运行中可热切换",
    '<div class="grid3">' +
    '<div class="abtn' + (ai.backend === "LOCAL" ? " on" : "") + '" data-act="ai-backend" data-arg="LOCAL">本地规则</div>' +
    '<div class="abtn' + (ai.backend === "REMOTE" ? " on" : "") + '" data-act="ai-backend" data-arg="REMOTE">外部智能体</div>' +
    '<div class="abtn' + (ai.backend === "LLM" ? " on" : "") + '" data-act="ai-backend" data-arg="LLM">大模型</div></div>' +
    '<div class="kv" style="margin-top:9px"><span>连接状态</span><span>' + (stt.connected ? '<span class="pill ok">已连接</span>' : '<span class="pill">未连接</span>') + "</span>" +
    "<span>本队指挥权</span><span>" + (ai.autoCommand === false ? '<span class="pill warn">玩家手动</span>' : '<span class="pill info">AI 自动</span>') + "</span>" +
    "<span>决策 / 回落</span><span>" + (stt.decisions || 0) + " / " + (stt.fallbacks || 0) + "</span></div>");

  const preset = ai.preset || "fast";
  let pres = '<div class="grid3">';
  for (const k of ["fast", "balanced", "deep"]) pres += '<div class="abtn' + (preset === k ? " on" : "") + '" data-act="ai-preset" data-arg="' + k + '">' + LLM_PRESETS[k].nameZh + "</div>";
  pres += "</div>";
  const curModel = ai.llmModel || (LLM_PRESETS[preset] && LLM_PRESETS[preset].model) || "";
  pres += '<div class="row" style="margin-top:8px"><span class="n">当前模型</span><span class="v">' + esc(curModel) + "</span></div>";
  pres += '<div class="grid2" style="margin-top:6px"><select id="aiModelSel" class="btn" style="padding:5px 6px">' +
    LLM_MODELS.map((m) => '<option value="' + m + '"' + (m === curModel ? " selected" : "") + ">" + m + "</option>").join("") +
    '</select><div class="abtn" data-act="ai-model">应用模型</div></div>';
  pres += '<div class="kv" style="margin-top:8px"><span>上次耗时</span><span>' + (stt.lastLatencyMs ? (stt.lastLatencyMs / 1000).toFixed(1) + "s" : "—") + "</span>" +
    "<span>平均耗时</span><span>" + (stt.avgLatencyMs ? (stt.avgLatencyMs / 1000).toFixed(1) + "s" : "—") + "</span>" +
    "<span>决策周期</span><span>" + ai.intervalS + " s</span>" +
    "<span>上下文模式</span><span>" + (ai.context && ai.context.compact ? "精简（快）" : "完整（深）") + "</span></div>" +
    '<div class="sub" style="margin-top:6px">' + lv("ai.think", stt.thinkingSince ? "AI 思考中…" : "空闲（每 " + ai.intervalS + " 秒一次决策）") + "</div>" +
    '<div class="sub dim" style="margin-top:4px">LLM 思考期间由<b>本地 AI 担任执行官</b>：继续避雷、损管、火控门限，但不会覆盖外部指挥官的航向与火力。</div>';
  h += card("AI 速度", LLM_PRESETS[preset] ? "当前：" + LLM_PRESETS[preset].nameZh : "", pres);

  const ctxStats = ai.context ? ai.context.stats() : null;
  const lcs = ai.lastContextStats;
  h += card("作战上下文 · 持久记忆", "", ctxStats
    ? '<div class="stats">' + stat("决策轮次", ctxStats.decisions) + stat("保留历史", ctxStats.turns, "轮") + stat("待吸收战况", ctxStats.events, "条") + stat("我的命令", ctxStats.orders, "条") + "</div>" +
      '<div class="sub" style="margin-top:8px">航迹记忆 <b>' + ctxStats.tracks + "</b> 个目标" + (lcs ? " · 上次请求 <b>" + lcs.messages + "</b> 条消息 / " + lcs.chars + " 字符" : "") + "</div>" +
      '<div class="sub" style="margin-top:4px">上周期意图：<b>' + esc(ctxStats.lastIntent || "（无）") + "</b></div>"
    : '<div class="sub">切到 LLM 后端后，每周期会把「历史决策 + 自上次以来的战况 + 我的命令记录 + 目标机动变化」一起发给模型。</div>');
  const prev = ai.lastContextPreview;
  h += '<details style="margin:-4px 0 13px"><summary>' + (prev ? "查看发给 AI 的完整上下文" : "当前态势简报预览") + '</summary><div class="ctxbox">' +
    esc(prev ? prev.system + "\n\n──────────\n\n" + prev.situation : "") + "</div></details>";
  h += '<div class="grid3" style="margin-bottom:13px"><div class="abtn gold" data-act="ai-now">立即决策</div><div class="abtn" data-act="ai-ctx-reset">清空记忆</div>' +
    '<div class="abtn' + (ai.autoCommand === false ? " on" : "") + '" data-act="ai-auto">' + (ai.autoCommand === false ? "开启自动指挥" : "关闭自动指挥") + "</div></div>";
  h += card("指令回执", "谁下的令 → 什么令 → 给谁 → 何时生效", cmdChain(world, state));
  h += card("与 AI 对话", "中文自然语言 · 规则没命中时交给大模型理解",
    '<textarea id="aichat" placeholder="例：全队转向 240，24 节，向最近的敌舰开火；释放烟幕掩护">' + (state.keepChat || "") + "</textarea>" +
    '<div class="grid2" style="margin-top:6px"><div class="abtn gold" data-act="ai-send">发送给参谋</div><div class="abtn" data-act="ai-backend" data-arg="LOCAL">重置为本地规则</div></div>');
  let chat = "";
  for (const c of world.chatLog.slice(-14)) chat += '<div class="chatline' + (c.from === "你" ? " me" : "") + '"><span class="who">' + esc(c.from) + "：</span>" + esc(c.text) + "</div>";
  h += card("通信记录", "", chat || '<div class="sub">暂无对话。</div>');
  return h;
}
export function liveAIPane(ctx, out) {
  const { world, state } = ctx;
  const ai = world.ai[state.side];
  if (!ai) return out;
  const stt = ai.status || {};
  if (stt.thinkingSince) out["ai.think"] = "AI 思考中… " + Math.round((Date.now() - stt.thinkingSince) / 1000) + "s（本地 AI 执行官代管中，上次 " + (stt.lastLatencyMs ? (stt.lastLatencyMs / 1000).toFixed(1) + "s" : "—") + "）";
  else if (stt.lastLatencyMs) out["ai.think"] = "空闲 · 上次决策耗时 " + (stt.lastLatencyMs / 1000).toFixed(1) + "s · 平均 " + ((stt.avgLatencyMs || 0) / 1000).toFixed(1) + "s";
  return out;
}
export function sigAIPane(ctx) {
  const { world, state, st } = ctx;
  if (st.spectate) {
    const a = world.ai["ALLIED"], x = world.ai["AXIS"];
    const f = (ai) => (ai ? [ai.backend, ai.preset, ai.llmModel, ai.autoCommand !== false ? 1 : 0, ai.status && ai.status.connected ? 1 : 0].join(",") : "-");
    return "S|" + f(a) + "|" + f(x) + "|" + (state.cmdLog || []).length;
  }
  const ai = world.ai[state.side];
  if (!ai) return "none";
  return [state.side, ai.backend, ai.preset, ai.llmModel, ai.autoCommand !== false ? 1 : 0,
    ai.status && ai.status.connected ? 1 : 0, ai.context ? 1 : 0, ai.lastContextStats ? 1 : 0,
    (state.cmdLog || []).length, world.chatLog.length, ai.lastContextPreview ? 1 : 0].join("|");
}

// ============================================================ 注册表
export const PANES = {
  "p-ship": { render: renderShipPane, live: liveShipPane, sig: sigShipPane },
  "p-fire": { render: renderFirePane, live: liveFirePane, sig: sigFirePane },
  "p-dam": { render: renderDamagePane, live: liveDamagePane, sig: sigDamagePane },
  "p-intel": { render: renderIntelPane, live: liveIntelPane, sig: sigIntelPane },
  "p-ai": { render: renderAIPane, live: liveAIPane, sig: sigAIPane },
};

// 旧签名保留：外部（测试/自动化）仍按名字调用单个渲染器
export const renderShipPaneHTML = renderShipPane;
