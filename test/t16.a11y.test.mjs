// test/t16.a11y.test.mjs —— 可访问性 / 高对比主题 / 平板触控 / 减少动效（纯静态断言，零依赖）
//
// 覆盖（对应 task D1）：
//   A. ARIA 契约：左轨道（#rail）、右侧页签（#tabs）、底部动作条（#dock）、观战条（#spectateBar）
//      与顶栏（#top）的关键交互元素都有可访问名称（aria-label）或角色（role）；
//      页签是 tablist/tab/tabpanel + aria-selected，动作条是 toolbar + aria-expanded，
//      所有 aria-controls / aria-labelledby 指向真实存在的 id。
//   B. 焦点可见：:focus-visible 有 3px 描边（取 --accent 变量），鼠标点击不误亮。
//   C. 五套主题 token 对齐：paper / chart / riso / dark / contrast 的 --c-* 变量集合完全一致
//      （theme.js 的 CHART_TOKENS 逐项读同一批变量，少一个就会退回兜底色）；
//      contrast 同样显式声明 --fs-* / --r-*；theme.js 的 THEMES/THEME_LABEL 已注册 contrast；
//      顶栏有 data-theme-id="contrast" 按钮（沿用事件委托，不需要额外接线）。
//   D. 减少动效：存在 @media (prefers-reduced-motion: reduce) 且关闭 transition / animation。
//   E. 平板 / 触控：存在 ≤1024px 与 ≤820px 两条新断点，命中区 ≥44px、字号下限 ≥12px、海图容器自适应。
//
// 运行： node test/t16.a11y.test.mjs        （退出码 0 = 全部通过）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const THEME_JS_PATH = path.join(ROOT, 'src/ui/theme.js');

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2714 ' + label); }
  else { fail++; failures.push(label); console.log('  \u2716 ' + label); }
  return !!cond;
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const themeJs = fs.readFileSync(THEME_JS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 极简 HTML 扫描：按 id 取元素（index.html 手写，不引第三方解析器）
// script/style 的文本内容不参与标签扫描。
// ---------------------------------------------------------------------------
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    if (!m[1]) continue;
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

function indexElements(source) {
  const map = new Map();
  const stack = [];
  let i = 0;
  const lower = source.toLowerCase();
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(source);
    if (!m || m.index !== lt) { i = lt + 1; continue; }
    const closing = source.slice(lt, lt + 2) === '</';
    const tag = m[1].toLowerCase();
    const rawAttrs = m[2] || '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const end = lt + m[0].length;
    if (closing) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tag === tag) {
          const el = stack[s];
          stack.length = s;
          if (el.attrs.id) map.set(el.attrs.id, { tag: el.tag, attrs: el.attrs, inner: source.slice(el.contentStart, lt), outer: source.slice(el.start, end) });
          break;
        }
      }
      i = end;
      continue;
    }
    const el = { tag, attrs: parseAttrs(rawAttrs), start: lt, contentStart: end };
    if (tag === 'script' || tag === 'style') {
      const close = lower.indexOf('</' + tag, end);
      const stop = close < 0 ? source.length : close;
      if (el.attrs.id) map.set(el.attrs.id, { tag, attrs: el.attrs, inner: source.slice(end, stop), outer: source.slice(lt, stop) });
      const gt = close < 0 ? source.length : source.indexOf('>', close) + 1;
      i = gt;
      continue;
    }
    if (VOID_TAGS.has(tag) || selfClosing) {
      if (el.attrs.id) map.set(el.attrs.id, { tag, attrs: el.attrs, inner: '', outer: source.slice(lt, end) });
      i = end;
      continue;
    }
    stack.push(el);
    i = end;
  }
  return map;
}

const els = indexElements(html);
const buttonsIn = (region) => {
  const el = els.get(region);
  if (!el) return [];
  const out = [];
  const re = /<button\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(el.inner))) {
    out.push({ attrs: parseAttrs(m[1] || ''), text: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), raw: m[0] });
  }
  return out;
};
const hasAriaLabelOrRole = (b) => (b.attrs['aria-label'] !== undefined && String(b.attrs['aria-label']).trim() !== '') || b.attrs.role !== undefined;

// ---------------------------------------------------------------------------
section('A. ARIA 契约：rail / tabs / dock / 观战条 / 顶栏');
// A1 左轨道
const rail = els.get('rail');
ok(!!rail, '#rail 存在');
ok(!!rail && (!!rail.attrs['aria-label'] || !!rail.attrs.role), '#rail 有 aria-label 或 role');
const railBtns = buttonsIn('rail');
ok(railBtns.length >= 7, '轨道按钮数量 >=7（实际 ' + railBtns.length + '）');
ok(railBtns.every(hasAriaLabelOrRole), '轨道内每个 button 都有 aria-label 或 role');
const railPaneBtns = railBtns.filter((b) => b.attrs['data-pane']);
ok(railPaneBtns.length === 5, '轨道有 5 个页签开关（data-pane）');
ok(railPaneBtns.length > 0 && railPaneBtns.every((b) => b.attrs['aria-pressed'] !== undefined && !!b.attrs['aria-controls']), '轨道页签开关带 aria-pressed + aria-controls');
ok(railBtns.some((b) => b.attrs.id === 'btnSideToggle' && b.attrs['aria-expanded'] !== undefined), '#btnSideToggle 带 aria-expanded（侧栏可收起状态可读）');

// A2 右侧页签
const tabs = els.get('tabs');
ok(!!tabs && tabs.attrs.role === 'tablist' && !!tabs.attrs['aria-label'], '#tabs 是 tablist 且有 aria-label');
const tabBtns = buttonsIn('tabs');
ok(tabBtns.length === 5, '页签数量 = 5（实际 ' + tabBtns.length + '）');
ok(tabBtns.length > 0 && tabBtns.every((b) => b.attrs.role === 'tab'), '每个页签 role="tab"');
ok(tabBtns.length > 0 && tabBtns.every((b) => b.attrs['aria-selected'] === 'true' || b.attrs['aria-selected'] === 'false'), '每个页签有 aria-selected');
ok(tabBtns.length > 0 && tabBtns.every((b) => !!b.attrs['aria-controls']), '每个页签有 aria-controls');
ok(tabBtns.length > 0 && tabBtns.every((b) => b.text.length > 0), '每个页签有可见文本（可访问名称）');
const panels = ['p-ship', 'p-fire', 'p-dam', 'p-intel', 'p-ai'].map((id) => els.get(id));
ok(panels.every((p) => p && p.attrs.role === 'tabpanel' && !!p.attrs['aria-labelledby']), '5 个面板都是 tabpanel 且 aria-labelledby 指回页签');

// A3 底部动作条
const dock = els.get('dock');
ok(!!dock && dock.attrs.role === 'toolbar' && !!dock.attrs['aria-label'], '#dock 是 toolbar 且有 aria-label');
const dockBtns = buttonsIn('dock');
ok(dockBtns.length >= 15, '动作条按钮数量 >=15（实际 ' + dockBtns.length + '）');
ok(dockBtns.length > 0 && dockBtns.every(hasAriaLabelOrRole), '动作条内每个 button 都有 aria-label 或 role');
const actBtns = dockBtns.filter((b) => b.attrs['data-dock-tab']);
ok(actBtns.length === 5, '动作条有 5 个动作层按钮（实际 ' + actBtns.length + '）');
ok(actBtns.length > 0 && actBtns.every((b) => b.attrs['aria-expanded'] !== undefined && !!b.attrs['aria-controls']), '动作层按钮带 aria-expanded + aria-controls');

// A4 观战条
const spec = els.get('spectateBar');
ok(!!spec && (!!spec.attrs.role || !!spec.attrs['aria-label']), '#spectateBar 有 role 或 aria-label');
const specBtns = buttonsIn('spectateBar');
ok(specBtns.length >= 8, '观战条按钮数量 >=8（实际 ' + specBtns.length + '）');
ok(specBtns.length > 0 && specBtns.every(hasAriaLabelOrRole), '观战条每个 button 都有 aria-label 或 role');

// A5 顶栏主题按钮 + 纯图标按钮
const top = els.get('top');
ok(!!top, '#top 存在');
const themeBtn = html.match(/<button[^>]*data-theme-id="contrast"[^>]*>([^<]*)<\/button>/);
ok(!!themeBtn && themeBtn[1].trim() === '高对比', '顶栏有「高对比」按钮（data-theme-id="contrast"）');
const themeIds = [...html.matchAll(/data-theme-id="([a-z]+)"/g)].map((x) => x[1]);
ok(['paper', 'chart', 'riso', 'dark', 'contrast'].every((id) => themeIds.includes(id)), '顶栏五个主题按钮齐全（' + themeIds.join('/') + '）');
ok(themeIds.length === 5, 'data-theme-id 恰好 5 个（实际 ' + themeIds.length + '）');
const themeSeg = html.match(/<div class="seg" id="segTheme"[^>]*>/);
ok(!!themeSeg && /role="group"/.test(themeSeg[0]) && /aria-label=/.test(themeSeg[0]), '#segTheme 是 role="group" 且有 aria-label');
for (const id of ['btnPalette', 'btnMore']) {
  const el = els.get(id);
  ok(!!el && !!el.attrs['aria-label'], '#' + id + '（纯图标按钮）有 aria-label');
}

// A6 aria-controls / aria-labelledby 全部指向真实 id
const allIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
const refs = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((x) => x[1]);
const refLabels = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((x) => x[1]);
const badRefs = refs.filter((r) => !allIds.has(r));
ok(refs.length > 0 && badRefs.length === 0, 'aria-controls 全部指向存在的 id（' + refs.length + ' 个引用，坏引用 ' + badRefs.length + '）');
ok(refLabels.length === 5 && refLabels.every((r) => allIds.has(r)), 'aria-labelledby（面板→页签）全部指向存在的 id');

// ---------------------------------------------------------------------------
section('B. 键盘焦点可见');
const focusRule = html.match(/:focus-visible\s*\{[^}]*\}/);
ok(!!focusRule, '存在 :focus-visible 规则');
ok(!!focusRule && /outline\s*:\s*3px solid var\(--accent\)/.test(focusRule[0]), ':focus-visible 用 3px 描边且取 var(--accent)（主题变量，非写死颜色）');
ok(/:focus:not\(:focus-visible\)\s*\{\s*outline\s*:\s*none/.test(html), '鼠标点击不亮焦点环（:focus:not(:focus-visible){outline:none}）');
ok(/aria-keyshortcuts="Space"/.test(html), '暂停按钮标注 aria-keyshortcuts（空格）');

// ---------------------------------------------------------------------------
section('C. 五套主题 token 对齐 + contrast 注册');
const themeBlocks = {};
for (const m of html.matchAll(/:root\s*\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
  themeBlocks[m[1]] = m[2];
}
const THEME_NAMES = ['paper', 'chart', 'riso', 'dark', 'contrast'];
for (const name of THEME_NAMES) ok(!!themeBlocks[name], 'index.html 有 :root[data-theme="' + name + '"] 变量块');
const cVars = {};
for (const name of THEME_NAMES) {
  cVars[name] = new Set([...(themeBlocks[name] || '').matchAll(/(--c-[a-z0-9-]+)\s*:/g)].map((x) => x[1]));
}
const baseSet = cVars.paper;
ok(baseSet.size === 52, 'paper 的 --c-* 变量数 = 52（实际 ' + baseSet.size + '）');
for (const name of THEME_NAMES.slice(1)) {
  const missing = [...baseSet].filter((v) => !cVars[name].has(v));
  const extra = [...cVars[name]].filter((v) => !baseSet.has(v));
  ok(missing.length === 0 && extra.length === 0, name + ' 的 --c-* 集合与 paper 完全一致（缺 ' + missing.length + ' / 多 ' + extra.length + (missing.length ? '：缺 ' + missing.slice(0, 4).join(',') : '') + '）');
}
const contrastBlock = themeBlocks.contrast || '';
const fsVars = [...contrastBlock.matchAll(/(--fs-[0-9])\s*:/g)].map((x) => x[1]);
// 注意 --r（无后缀）与 --r-lg / --r-2 / --r-s / --r-xs / --r-pill 都要算进来
const rVars = new Set([...contrastBlock.matchAll(/(--r(?:-[a-z0-9]+)?)\s*:/g)].map((x) => x[1]));
const R_NAMES = ['--r-lg', '--r', '--r-2', '--r-s', '--r-xs', '--r-pill'];
ok(fsVars.length === 6, 'contrast 显式声明 6 个 --fs-*（实际 ' + fsVars.length + '）');
ok(R_NAMES.every((n) => rVars.has(n)) && rVars.size === 6, 'contrast 显式声明 6 个 --r-*（实际 ' + [...rVars].join('/') + '）');
ok(/--bg:\s*#0{3,6}\b/.test(contrastBlock) || /--bg:\s*black/.test(contrastBlock), 'contrast 背景是纯黑');
ok(/--text:\s*#f{3,6}\b/.test(contrastBlock), 'contrast 前景是纯白');
ok(/--c-ink:\s*#f{3,6}\b/.test(contrastBlock), 'contrast 的 --c-ink（canvas 文字）是纯白');
const themesLine = (themeJs.match(/export const THEMES\s*=\s*(\[[^\]]*\])/) || [])[1] || '';
ok(/["']contrast["']/.test(themesLine), "theme.js 的 THEMES 已加入 'contrast'");
ok(/contrast\s*:\s*["'][^"']+["']/.test(themeJs), 'theme.js 的 THEME_LABEL 有 contrast 文案');
ok(/data-theme-id/.test(themeJs), 'theme.js 仍按 [data-theme-id] 事件委托切换主题（顶栏按钮无需额外接线）');

// ---------------------------------------------------------------------------
section('D. 减少动效');
const rm = html.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
ok(!!rm, '存在 @media (prefers-reduced-motion: reduce)');
ok(!!rm && /transition\s*:\s*none\s*!important/.test(rm[0]), '减少动效时 transition:none !important');
ok(!!rm && /animation\s*:\s*none\s*!important/.test(rm[0]), '减少动效时 animation:none !important');
ok(!!rm && /scroll-behavior\s*:\s*auto/.test(rm[0]), '减少动效时关闭平滑滚动');

// ---------------------------------------------------------------------------
section('E. 平板 / 触控断点（1024px、820px）');
const media1024 = html.match(/@media\s*\(max-width:\s*1024px\)\s*\{([\s\S]*?)\n\}/);
const media820 = html.match(/@media\s*\(max-width:\s*820px\)\s*\{([\s\S]*?)\n\}/);
ok(!!media1024, '存在 max-width:1024px 断点');
ok(!!media820, '存在 max-width:820px 断点');
const newBreakpoints = (html.match(/@media\s*\(max-width:\s*(?:1024|820)px\)/g) || []).length;
ok(newBreakpoints >= 2, '新增断点数量 >=2（实际 ' + newBreakpoints + '）');
for (const [name, m] of [['1024px', media1024], ['820px', media820]]) {
  const body = m ? m[1] : '';
  ok(/44px/.test(body), name + ' 断点内命中区 >=44px（出现 44px）');
  ok(/--fs-1:\s*12px/.test(body), name + ' 断点内字号下限 >=12px（--fs-1:12px）');
  ok(/#chartWrap|#dock|#main/.test(body), name + ' 断点内含海图容器 / 主区自适应规则');
}
ok(/#rail button\{[^}]*width:44px[^}]*height:44px/.test(html.replace(/\n/g, ' ')) || /#rail button\s*\{[^}]*width:44px[^}]*height:44px/.test(html.replace(/\n/g, ' ')), '轨道按钮在触控断点内为 44x44 命中区');
ok(/#tabs button\{[^}]*height:44px/.test(html.replace(/\n/g, ' ')) || /#tabs button\s*\{[^}]*height:44px/.test(html.replace(/\n/g, ' ')), '页签在触控断点内行高 44px');

// ---------------------------------------------------------------------------
section('结果');
console.log('  PASS ' + pass + ' / FAIL ' + fail + (fail === 0 ? '  \u2714 全部通过' : ''));
if (fail) { console.log('  失败项：'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 ? 0 : 1);



