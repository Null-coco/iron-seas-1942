// ============================================================================
// 回放分析器 · 渲染层（text / markdown / html）
// ----------------------------------------------------------------------------
// 三种输出共用同一份分析模型；html 额外内联 SVG 图表，单文件可直接分享。
// 文案原则：只说模型里有证据的事；没有数据的列写「—」而不是猜。
// ============================================================================
import { fmtClock, fmtNum, fmtPct, round1, sideZh, typeZh, MAGAZINE_RESULT_ZH, pct } from './core.mjs';
import { trackChart, rangeChart, damageStrip, sideColor } from './svg.mjs';

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const SEV_ZH = { critical: '严重', major: '重大', minor: '次要', info: '提示' };
const SEV_COLOR = { critical: '#9d3126', major: '#a35a1b', minor: '#6b675e', info: '#5a6b7a' };

const TYPE_RANK = { BB: 0, BC: 1, CA: 2, CL: 3, DD: 4, CV: 5, SS: 6 };
export function sortShips(model) {
  const order = Object.keys(model.sides);
  return model.ships.slice().sort((a, b) => (order.indexOf(a.side) - order.indexOf(b.side))
    || ((TYPE_RANK[a.type] === undefined ? 9 : TYPE_RANK[a.type]) - (TYPE_RANK[b.type] === undefined ? 9 : TYPE_RANK[b.type]))
    || String(a.name).localeCompare(String(b.name), 'zh'));
}

// ── 纯文本（终端）───────────────────────────────────────────────────────────
export function renderText(model) {
  const L = [];
  const line = (s) => L.push(s === undefined ? '' : s);
  const rule = (ch = '─') => line(ch.repeat(72));
  line('');
  line('回放分析 · ' + model.meta.scenario + ' · 种子 ' + model.meta.seed);
  rule('═');
  line('时长 ' + round1(model.meta.duration) + ' s · 事件 ' + fmtNum(model.meta.events) + ' · 快照 ' + model.meta.snapshots + ' · 结局 ' + resultText(model));
  line('');
  line('结论：' + model.verdict.headline);
  line(model.verdict.summary);
  line('');
  rule();
  line('【发现】');
  for (const f of model.findings) {
    line(' [' + SEV_ZH[f.severity] + '] ' + f.code + ' · ' + f.title);
    if (f.detail) line('        ' + f.detail);
  }
  line('');
  rule();
  line('【射击】');
  line(pad('舰名', 10) + pad('舰种', 6) + pad('口径', 7) + pad('发射', 7) + pad('齐射', 6) + pad('命中', 6) + pad('命中率', 8) + '末次');
  for (const s of sortShips(model)) {
    const g = model.gunnery.byShip[s.id];
    if (!g.rounds) continue;
    line(pad(s.name, 10) + pad(typeZh(s.type), 6) + pad(s.caliber ? s.caliber + 'mm' : '—', 7) + pad(g.rounds, 7) + pad(g.salvos, 6) + pad(g.hits, 6) + pad(fmtPct(g.hits, g.rounds), 8) + fmtClock(g.lastFire));
  }
  line(pad('合计', 10) + pad('', 6) + pad('', 7) + pad(model.gunnery.rounds, 7) + pad('', 6) + pad(model.gunnery.hits, 6) + pad(fmtPct(model.gunnery.hits, model.gunnery.rounds), 8));
  line('');
  rule();
  line('【损伤】');
  for (const s of sortShips(model)) {
    const d = model.damage.byShip[s.id];
    if (!d || (!d.hitsTaken && !d.casualties && !d.sank && !d.torpHits)) continue;
    line(' ' + pad(s.name, 10) + ' 中弹 ' + pad(d.hitsTaken, 3) + ' 中雷 ' + pad((d.torpHitsTaken || 0) + (d.torpFriendlyHitsTaken ? '（友军' + d.torpFriendlyHitsTaken + '）' : ''), 6) + ' 阵亡 ' + pad(fmtNum(d.casualties), 6)
      + (d.sank ? ' 沉没 ' + fmtClock(d.sank.t) : (s.final && s.final.afloat === false ? ' 失去在航' : ' 在航')));
  }
  line(' 合计阵亡 ' + fmtNum(model.damage.totalCasualties) + ' 人');
  line('');
  rule();
  line('【鱼雷】');
  for (const t of Object.values(model.torpedo.byShooter)) {
    line(' ' + pad(t.name, 10) + ' 发射 ' + pad(t.fired, 3) + ' 命中 ' + pad(t.hits, 2) + (t.friendlyHits ? '（其中友军 ' + t.friendlyHits + '）' : ''));
  }
  const byReason = {};
  for (const m of model.torpedo.misses) byReason[m.reason || '?'] = (byReason[m.reason || '?'] || 0) + 1;
  if (Object.keys(byReason).length) line(' 未中原因：' + Object.entries(byReason).map(([k, v]) => k + ' ' + v).join(' · '));
  line('');
  rule();
  line('【时间线】');
  for (const x of model.timeline) line(' ' + pad(fmtClock(x.t), 8) + x.text);
  line('');
  return L.join('\n');
}

function resultText(model) {
  const r = model.meta.result || {};
  if (r.winner) return sideZh(r.winner) + ' 获胜' + (r.text ? '（' + r.text + '）' : '');
  return (r.over ? '已结束（无胜方）' : '未分胜负') + (r.text ? '（' + r.text + '）' : '');
}
// 东亚宽字符按 2 列计，终端表格才不会歪
function dispWidth(str) { let w = 0; for (const ch of String(str)) w += (ch.codePointAt(0) > 0x2e7f ? 2 : 1); return w; }
function pad(v, n) { const s = String(v === undefined || v === null ? '' : v); return s + ' '.repeat(Math.max(0, n - dispWidth(s))); }

// ── Markdown ────────────────────────────────────────────────────────────────
export function renderMarkdown(model) {
  const L = [];
  const line = (s) => L.push(s === undefined ? '' : s);
  line('# 回放分析 · ' + model.meta.scenario + ' · 种子 ' + model.meta.seed);
  line('');
  line('> ' + model.verdict.headline);
  line('>');
  line('> ' + model.verdict.summary);
  line('');
  line('| 项目 | 值 |');
  line('| --- | --- |');
  line('| 剧本 | ' + model.meta.scenario + ' |');
  line('| 随机种子 | ' + dash(model.meta.seed) + ' |');
  line('| 时长 | ' + round1(model.meta.duration) + ' s |');
  line('| 事件 / 快照 | ' + fmtNum(model.meta.events) + ' / ' + model.meta.snapshots + ' |');
  line('| 结局 | ' + resultText(model) + ' |');
  line('');
  line('## 编成');
  line('');
  line('| 舰名 | 阵营 | 舰种 | 满载 | 乘员 | 主炮 |');
  line('| --- | --- | --- | --- | --- | --- |');
  for (const s of sortShips(model)) line('| ' + s.name + ' | ' + sideZh(s.side) + ' | ' + typeZh(s.type) + ' | ' + fmtNum(s.displacementFull_t) + (s.displacementFull_t ? ' t' : '') + ' | ' + fmtNum(s.crew) + ' | ' + (s.caliber ? s.caliber + ' mm' : '—') + ' |');
  line('');
  line('## 发现');
  line('');
  for (const f of model.findings) {
    line('### [' + SEV_ZH[f.severity] + '] ' + f.title);
    line('');
    line(f.detail || '');
    line('');
  }
  line('## 射击统计');
  line('');
  line('| 舰名 | 口径 | 发射 | 齐射 | 命中 | 命中率 | 首 / 末次开火 |');
  line('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of sortShips(model)) {
    const g = model.gunnery.byShip[s.id];
    if (!g.rounds) continue;
    line('| ' + s.name + ' | ' + (s.caliber || '—') + ' | ' + g.rounds + ' | ' + g.salvos + ' | ' + g.hits + ' | ' + fmtPct(g.hits, g.rounds) + ' | ' + fmtClock(g.firstFire) + ' / ' + fmtClock(g.lastFire) + ' |');
  }
  line('| **合计** | — | **' + model.gunnery.rounds + '** | — | **' + model.gunnery.hits + '** | **' + fmtPct(model.gunnery.hits, model.gunnery.rounds) + '** | — |');
  line('');
  line('## 损伤');
  line('');
  line('| 舰名 | 中弹 | 鱼雷 | 阵亡 | 结局 |');
  line('| --- | --- | --- | --- | --- |');
  for (const s of sortShips(model)) {
    const d = model.damage.byShip[s.id];
    line('| ' + s.name + ' | ' + d.hitsTaken + ' | ' + (d.torpHitsTaken || 0) + (d.torpFriendlyHitsTaken ? '（友军 ' + d.torpFriendlyHitsTaken + '）' : '') + ' | ' + fmtNum(d.casualties) + ' | ' + (d.sank ? fmtClock(d.sank.t) + ' 沉没' : (s.final && s.final.afloat === false ? '失去在航' : '在航')) + ' |');
  }
  line('');
  line('## 鱼雷台账');
  line('');
  line('| 时刻 | 舰名 | 管数 | 目标 | 结果 |');
  line('| --- | --- | --- | --- | --- |');
  const hitsByTorp = {};
  for (const h of model.torpedo.hits) hitsByTorp[h.torp] = h;
  for (const l of model.torpedo.launches) {
    const hit = model.torpedo.hits.filter((h) => Math.abs(h.t - l.t) < 0.5 && h.shooter === l.ship);
    line('| ' + fmtClock(l.t) + ' | ' + l.name + ' | ' + l.tubes + ' | ' + (l.target || '—') + ' | ' + (hit.length ? hit.map((h) => (h.friendly ? '命中友舰 ' : '命中 ') + h.name).join('、') : '见未中记录') + ' |');
  }
  line('');
  line('## 时间线');
  line('');
  for (const x of model.timeline) line('- ' + fmtClock(x.t) + '　' + x.text);
  line('');
  line('## 附录');
  line('');
  const r = model.meta.retention;
  if (r) line('- 事件保留：history ' + fmtNum(r.history) + ' / totalEmitted ' + fmtNum(r.totalEmitted) + '，丢弃噪声 ' + (r.droppedNoise || 0) + '，丢弃关键 ' + (r.droppedCritical || 0));
  line('- 事件类型：' + Object.entries(model.eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ' ' + v).join('、'));
  line('');
  return L.join('\n');
}

// ── HTML ────────────────────────────────────────────────────────────────────
export const REPORT_CSS = [
  ':root{--paper:#f7f4ec;--paper2:#fbf9f4;--ink:#1d232b;--muted:#6b675e;--rule:#d8d2c2;--red:#9d3126;--blue:#2f6fb2;--gold:#a97b1e}',
  '*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Songti SC","Noto Serif SC","Source Han Serif SC","Times New Roman",serif;font-size:15px;line-height:1.8}',
  '.wrap{max-width:1040px;margin:0 auto;padding:52px 36px 72px}',
  '.kicker{font-family:"PingFang SC",sans-serif;font-size:11px;letter-spacing:.3em;color:var(--muted)}',
  'h1{font-size:38px;margin:12px 0 4px;line-height:1.2}.sub{font-size:14px;color:var(--muted);letter-spacing:.05em}',
  '.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 24px;margin:24px 0 30px;font-family:"PingFang SC",sans-serif;font-size:12.5px}',
  '.meta b{display:block;font-size:10.5px;letter-spacing:.16em;color:var(--muted);font-weight:600}',
  '.meta div{border-top:1px solid var(--rule);padding-top:6px}',
  '.kpi{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--rule);background:var(--paper2);margin:0 0 34px}',
  '.kpi>div{padding:14px 10px;border-right:1px solid var(--rule);text-align:center}',
  '.kpi>div:last-child{border-right:none}.kpi .n{font-family:"SF Mono",Menlo,monospace;font-size:22px;font-weight:600;line-height:1.2}',
  '.kpi .l{font-family:"PingFang SC",sans-serif;font-size:10.5px;color:var(--muted);letter-spacing:.1em}',
  'section{margin:0 0 40px}h2{font-size:12.5px;font-family:"PingFang SC",sans-serif;letter-spacing:.2em;color:var(--muted);margin:0 0 4px;display:flex;gap:10px;align-items:baseline}',
  'h2 .no{font-family:"SF Mono",Menlo,monospace;color:var(--red);letter-spacing:0}h2::after{content:"";flex:1;height:1px;background:var(--rule);transform:translateY(-3px)}',
  'h3{font-size:18px;margin:20px 0 6px}p{margin:0 0 12px;text-align:justify}',
  '.lede{font-size:18px;line-height:1.75;margin:4px 0 14px}.lede b{color:var(--red)}',
  'table{width:100%;border-collapse:collapse;margin:12px 0;font-family:"PingFang SC",sans-serif;font-size:12.5px;background:var(--paper2)}',
  'caption{caption-side:top;text-align:left;font-size:11px;letter-spacing:.14em;color:var(--muted);padding-bottom:6px}',
  'th,td{padding:7px 9px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}',
  'th{font-size:10.5px;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid #b9b2a1;background:#f1ede3;white-space:nowrap}',
  'td.num,th.num{text-align:right;font-family:"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}',
  'tr.total td{border-top:1px solid #b9b2a1;font-weight:600;background:#f1ede3}',
  '.tag{display:inline-block;font-size:10px;letter-spacing:.06em;padding:1px 5px;border:1px solid currentColor;border-radius:2px;font-family:"PingFang SC",sans-serif;white-space:nowrap}',
  'figure{margin:20px 0 28px;break-inside:avoid}figcaption{font-family:"PingFang SC",sans-serif;font-size:11.5px;color:var(--muted);margin-top:8px;line-height:1.7}',
  '.fig{border:1px solid var(--rule);background:var(--paper2)}',
  '.finding{border-left:3px solid var(--rule);padding:10px 0 10px 16px;margin:0 0 14px}',
  '.finding h4{margin:0 0 4px;font-size:15px;font-family:"PingFang SC",sans-serif}.finding p{margin:0;font-size:13.5px;color:#3b3830}',
  '.finding .ev{font-family:"SF Mono",Menlo,monospace;font-size:11.5px;color:var(--muted);margin-top:4px}',
  '.tl{list-style:none;padding:0;margin:10px 0}.tl li{display:grid;grid-template-columns:86px 1fr;gap:12px;padding:6px 0;border-bottom:1px dotted var(--rule);font-family:"PingFang SC",sans-serif;font-size:13px}',
  '.tl .t{font-family:"SF Mono",Menlo,monospace;font-size:12px;color:var(--muted)}',
  '.note{background:var(--paper2);border:1px solid var(--rule);padding:14px 18px;margin:18px 0;font-family:"PingFang SC",sans-serif;font-size:13px;line-height:1.75}',
  '.cols{display:grid;grid-template-columns:1fr 1fr;gap:26px}.cols h4{margin-top:0}',
  'footer{margin-top:48px;border-top:1px solid var(--rule);padding-top:14px;font-family:"PingFang SC",sans-serif;font-size:11px;color:var(--muted)}',
  '@media screen and (max-width:820px){.wrap{padding:28px 18px 48px}h1{font-size:28px}.meta{grid-template-columns:1fr 1fr}.kpi{grid-template-columns:repeat(2,1fr)}.kpi>div:nth-child(2n){border-right:none}.cols{grid-template-columns:1fr}}',
  '@page{size:A4;margin:14mm 12mm}',
  '@media print{body{background:#fff;font-size:10pt}figure,table,.finding{break-inside:avoid}.wrap{padding:0}}',
].join('\n');

// 只出报告正文（浏览器页面直接插入；完整文档用 renderHtml）
export function renderReportBody(model, opts = {}) {
  const tracks = trackChart(model);
  const ranges = rangeChart(model);
  const strip = damageStrip(model);
  const ships = sortShips(model);
  const sideIds = Object.keys(model.sides);
  const critical = model.findings.filter((f) => f.severity === 'critical' || f.severity === 'major');
  const H = [];
  H.push('<div class="wrap">');
  // 报头
  H.push('<div class="kicker">REPLAY ANALYSIS · 回放分析</div>');
  H.push('<h1>' + esc(model.meta.scenario) + ' · 回放分析</h1>');
  H.push('<div class="sub">种子 ' + esc(dash(model.meta.seed)) + ' · 时长 ' + round1(model.meta.duration) + ' s · ' + fmtNum(model.meta.events) + ' 事件 · ' + model.meta.snapshots + ' 快照</div>');
  H.push('<div class="meta"><div><b>剧本</b>' + esc(model.meta.scenario) + '</div><div><b>随机种子</b>' + esc(dash(model.meta.seed)) + '</div>'
    + '<div><b>时长</b>' + round1(model.meta.duration) + ' s</div><div><b>结局</b>' + esc(resultText(model)) + '</div>'
    + '<div><b>参战 / 在航</b>' + model.ships.length + ' / ' + model.ships.filter((s) => !s.sank && !(s.final && s.final.afloat === false)).length + '</div>'
    + '<div><b>沉没</b>' + model.damage.sunk.length + ' 艘</div><div><b>阵亡</b>' + fmtNum(model.damage.totalCasualties) + ' 人</div>'
    + '<div><b>鱼雷 / 命中</b>' + model.torpedo.fired + ' / ' + model.torpedo.hitsCount + '</div></div>');
  // KPI
  H.push('<div class="kpi"><div><div class="n">' + Math.round(model.meta.duration) + ' s</div><div class="l">交战时长</div></div>'
    + '<div><div class="n" style="color:var(--red)">' + model.damage.sunk.length + '</div><div class="l">沉没军舰</div></div>'
    + '<div><div class="n">' + model.gunnery.hits + '<span style="font-size:12px;color:var(--muted);font-weight:400"> / ' + fmtNum(model.gunnery.rounds) + '</span></div><div class="l">命中 / 发射</div></div>'
    + '<div><div class="n" style="color:var(--red)">' + fmtNum(model.damage.totalCasualties) + '</div><div class="l">阵亡</div></div>'
    + '<div><div class="n" style="color:var(--blue)">' + (model.meta.result && model.meta.result.winner ? esc(sideZh(model.meta.result.winner)) : '0') + '</div><div class="l">' + (model.meta.result && model.meta.result.winner ? '胜方' : '分出的胜负') + '</div></div></div>');
  // 结论
  H.push('<section><h2><span class="no">01</span>结论</h2>');
  H.push('<p class="lede"><b>' + esc(model.verdict.headline) + '</b></p>');
  H.push('<p>' + esc(model.verdict.summary) + '</p>');
  if (critical.length) {
    H.push('<ul>');
    for (const f of critical.slice(0, 6)) H.push('<li><span class="tag" style="color:' + SEV_COLOR[f.severity] + '">' + SEV_ZH[f.severity] + '</span> ' + esc(f.title) + '</li>');
    H.push('</ul>');
  }
  H.push('</section>');
  // 编成
  H.push('<section><h2><span class="no">02</span>编成</h2><table><caption>参战序列</caption><thead><tr><th>舰名</th><th>阵营</th><th>舰种</th><th>国 / 年</th><th class="num">满载</th><th class="num">乘员</th><th class="num">航速</th><th class="num">主炮</th></tr></thead><tbody>');
  for (const s of ships) {
    H.push('<tr><td>' + esc(s.name) + '</td><td>' + esc(sideZh(s.side)) + '</td><td>' + esc(typeZh(s.type)) + '</td><td>' + esc([s.nation, s.year].filter(Boolean).join(' ') || '—') + '</td>'
      + '<td class="num">' + (s.displacementFull_t ? fmtNum(s.displacementFull_t) + ' t' : '—') + '</td><td class="num">' + fmtNum(s.crew) + '</td><td class="num">' + (s.speedMax_kn ? round1(s.speedMax_kn) + ' kn' : '—') + '</td><td class="num">' + (s.caliber ? s.caliber + ' mm' : '—') + '</td></tr>');
  }
  H.push('</tbody></table><p style="font-family:PingFang SC,sans-serif;font-size:11.5px;color:var(--muted)">舰种/吨位/乘员来自 data/ships_*.json；缺失时按主炮口径推断并标为「不明」。</p></section>');
  // 图
  H.push('<section><h2><span class="no">03</span>态势</h2>');
  if (tracks) H.push('<figure><div class="fig">' + tracks + '</div><figcaption><b>图 1　航迹图。</b>每条线为一艘舰的完整轨迹；空心圆 = 起点，方块 = 终点，红叉 = 沉没点。坐标单位 km。</figcaption></figure>');
  if (ranges) H.push('<figure><div class="fig">' + ranges + '</div><figcaption><b>图 2　交战距离。</b>实线为双方编队质心距，虚线为最近舰距；竖虚线标出沉没时刻。距离长期贴在 2–5 km 而 AI 条令要求 9–14 km，是命中率偏低的结构性原因之一。</figcaption></figure>');
  if (strip) H.push('<figure><div class="fig">' + strip + '</div><figcaption><b>图 3　中弹条带。</b>每行一艘舰；圆点 = 炮击命中（按来袭方着色），菱形 = 鱼雷命中，带圈的金色菱形 = 友军鱼雷，竖线 = 沉没时刻。右侧为该舰中弹 / 中雷总数。</figcaption></figure>');
  H.push('</section>');
  // 时间线
  H.push('<section><h2><span class="no">04</span>时间线</h2><ul class="tl">');
  for (const x of model.timeline) H.push('<li><span class="t">' + fmtClock(x.t) + '</span><span>' + esc(x.text) + '</span></li>');
  H.push('</ul></section>');
  // 数据
  H.push('<section><h2><span class="no">05</span>数据</h2>');
  H.push('<table><caption>表 1　射击统计</caption><thead><tr><th>舰名</th><th class="num">口径</th><th class="num">发射</th><th class="num">齐射</th><th class="num">命中</th><th class="num">命中率</th><th class="num">首 / 末次</th></tr></thead><tbody>');
  for (const s of ships) {
    const g = model.gunnery.byShip[s.id];
    if (!g.rounds) continue;
    H.push('<tr><td>' + esc(s.name) + '</td><td class="num">' + (s.caliber || '—') + '</td><td class="num">' + g.rounds + '</td><td class="num">' + g.salvos + '</td><td class="num">' + g.hits + '</td><td class="num">' + fmtPct(g.hits, g.rounds) + '</td><td class="num">' + fmtClock(g.firstFire) + ' / ' + fmtClock(g.lastFire) + '</td></tr>');
  }
  H.push('<tr class="total"><td>合计</td><td class="num">—</td><td class="num">' + fmtNum(model.gunnery.rounds) + '</td><td class="num">—</td><td class="num">' + model.gunnery.hits + '</td><td class="num">' + fmtPct(model.gunnery.hits, model.gunnery.rounds) + '</td><td class="num">—</td></tr></tbody></table>');

  H.push('<table><caption>表 2　中弹与损伤</caption><thead><tr><th>舰名</th><th class="num">中弹</th><th class="num">鱼雷</th><th class="num">阵亡</th><th>破损</th><th>结局</th></tr></thead><tbody>');
  for (const s of ships) {
    const d = model.damage.byShip[s.id];
    const dmgTxt = [];
    if (d.floodingPeak) dmgTxt.push('进水峰值 ' + round1(d.floodingPeak) + ' m³/s');
    if (d.listPeak) dmgTxt.push('横倾 ' + round1(d.listPeak) + '°');
    if (d.magazine && d.magazine.length) dmgTxt.push('弹药库' + d.magazine.map((m) => MAGAZINE_RESULT_ZH[m.result] || m.result).join('/'));
    if (d.subsystemsDestroyed && d.subsystemsDestroyed.length) dmgTxt.push('损毁子系统 ' + d.subsystemsDestroyed.length + ' 项');
    H.push('<tr><td>' + esc(s.name) + '</td><td class="num">' + d.hitsTaken + '</td><td class="num">' + d.torpHits + (d.torpFriendlyHits ? '（友军 ' + d.torpFriendlyHits + '）' : '') + '</td><td class="num">' + fmtNum(d.casualties) + '</td><td>' + esc(dmgTxt.join('；') || '—') + '</td><td>' + (d.sank ? '<span class="tag" style="color:var(--red)">' + fmtClock(d.sank.t) + ' 沉没</span>' : (s.final ? '<span class="tag" style="color:var(--blue)">在航 ' + round1(s.final.speed) + ' kn</span>' : '—')) + '</td></tr>');
  }
  H.push('</tbody></table>');

  H.push('<div class="cols"><div><h4>鱼雷台账</h4><table><thead><tr><th>时刻</th><th>舰名</th><th class="num">管</th><th>结果</th></tr></thead><tbody>');
  for (const l of model.torpedo.launches) {
    const hit = model.torpedo.hits.filter((h) => Math.abs(h.t - l.t) < 0.5 && h.shooter === l.ship);
    H.push('<tr><td class="num">' + fmtClock(l.t) + '</td><td>' + esc(l.name) + '</td><td class="num">' + l.tubes + '</td><td>' + esc(hit.length ? hit.map((h) => (h.friendly ? '友舰 ' : '') + h.name).join('、') : '未命中') + '</td></tr>');
  }
  H.push('</tbody></table></div><div><h4>指令统计</h4><table><thead><tr><th>阵营</th><th>指令</th><th class="num">次数</th></tr></thead><tbody>');
  for (const sid of sideIds) {
    const kinds = model.orders.bySide[sid] || {};
    const list = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [k, v] of list) H.push('<tr><td>' + esc(sideZh(sid)) + '</td><td>' + esc(k) + '</td><td class="num">' + v + '</td></tr>');
  }
  H.push('</tbody></table></div></div></section>');
  // 发现
  H.push('<section><h2><span class="no">06</span>发现</h2>');
  for (const f of model.findings) {
    H.push('<div class="finding" style="border-left-color:' + SEV_COLOR[f.severity] + '"><h4><span class="tag" style="color:' + SEV_COLOR[f.severity] + '">' + SEV_ZH[f.severity] + '</span> ' + esc(f.title) + ' <span style="font-family:SF Mono,Menlo,monospace;font-size:10.5px;color:#9a958a">' + f.code + '</span></h4>');
    if (f.detail) H.push('<p>' + esc(f.detail) + '</p>');
    if (f.evidence && f.evidence.length) H.push('<div class="ev">' + f.evidence.slice(0, 6).map((e) => fmtClock(e.t) + ' ' + esc(e.text)).join('　·　') + '</div>');
    H.push('</div>');
  }
  H.push('</section>');
  // 附录
  H.push('<section><h2><span class="no">07</span>附录</h2>');
  const r = model.meta.retention;
  if (r) H.push('<p>事件保留：history ' + fmtNum(r.history) + ' / totalEmitted ' + fmtNum(r.totalEmitted) + '；丢弃噪声 ' + (r.droppedNoise || 0) + '，丢弃关键 ' + (r.droppedCritical || 0) + '。</p>');
  H.push('<p>事件类型：' + esc(Object.entries(model.eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => k + ' ' + v).join('、')) + '</p>');
  H.push('<p>口径：命中率 = gun.hit / gun.fire；友军鱼雷 = torp.hit 且 friendly=true；判型漂移从 AI 决策文本的「集火XX(Tn)」抽取；阵亡含 dam.casualties 与 dam.magazine.killed。所有数字可回溯到回放事件。</p></section>');
  H.push('<footer>由回放分析器生成 · ' + esc(model.meta.scenario) + ' · 种子 ' + esc(dash(model.meta.seed)) + ' · ' + new Date().toISOString().slice(0, 10) + '</footer>');
  H.push('</div>');
  return H.join('\n');
}

// 完整单文件文档（CLI --format=html 用）
export function renderHtml(model, opts = {}) {
  const title = opts.title || ('回放分析 · ' + model.meta.scenario + ' · 种子 ' + model.meta.seed);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title><style>' + REPORT_CSS + '</style></head><body>'
    + renderReportBody(model, opts)
    + '</body></html>';
}
