#!/usr/bin/env node
// ============================================================================
// 构建单文件版回放分析器（tools/replay-analyzer.html）
// ----------------------------------------------------------------------------
// 目的：不开终端也能复盘——浏览器里拖入 replay.json 就能看战报。
// 做法：**不复制分析逻辑**，直接把三个模块（core / svg / render）改写成浏览器可执行的
//       IIFE 片段注入 HTML 模板，保证 CLI 与网页永远同一套口径。
//
//   core.mjs   去掉 node:fs 依赖（loadShipDatabase 只在传 dataDir 时才会用到）
//   svg.mjs    去掉 import（依赖 core 的导出，已在外层解构）
//   render.mjs 拆出 REPORT_CSS / renderReportBody，网页直接复用
//
// 用法：
//   node tools/build-replay-analyzer-html.mjs            # 写 tools/replay-analyzer.html
//   node tools/build-replay-analyzer-html.mjs --check    # 只校验能否构建（不落盘）
//
// 回归：test/t23.replay_analyzer.test.mjs 会构建一次并校验无 import/export 残留、脚本可解析。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ANALYZER_DIR = path.join(__dirname, 'analyzer');
const TEMPLATE = path.join(ANALYZER_DIR, 'web', 'app.html');
const OUT = path.join(__dirname, 'replay-analyzer.html');

const SOURCES = [
  { file: 'core.mjs', global: '__CORE' },
  { file: 'svg.mjs', global: '__SVG' },
  { file: 'render.mjs', global: '__RENDER' },
];

// 把 ESM 模块改写成 IIFE，并把 export 名单返回给外层解构
export function moduleToIife(source, globalName) {
  const names = [];
  let code = source;
  // import 行整行去掉（三份模块的 import 都是单行单分号）
  code = code.replace(/^import\s+[^;]+;\s*$/gm, '');
  // export { a, b }; 形式
  code = code.replace(/^export\s*\{([^}]*)\}\s*;?\s*$/gm, (m, list) => {
    list.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => names.push(s.split(/\s+as\s+/).pop().trim()));
    return '';
  });
  // export const/let/var/function/class NAME
  code = code.replace(/^export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (m, kw, id) => {
    names.push(id);
    return kw + ' ' + id;
  });
  if (!names.length) throw new Error('模块没有导出：' + globalName);
  return 'var ' + globalName + ' = (function () {\n' + code + '\nreturn { ' + names.join(', ') + ' };\n})();\n'
    + 'var { ' + names.join(', ') + ' } = ' + globalName + ';\n';
}

export function buildModules() {
  return SOURCES.map((s) => moduleToIife(fs.readFileSync(path.join(ANALYZER_DIR, s.file), 'utf8'), s.global)).join('\n');
}

export function buildAnalyzerHtml() {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const renderSrc = fs.readFileSync(path.join(ANALYZER_DIR, 'render.mjs'), 'utf8');
  const m = renderSrc.match(/export const REPORT_CSS = (\[[\s\S]*?\])\.join\('\\n'\);/);
  if (!m) throw new Error('render.mjs 里找不到 REPORT_CSS');
  let css;
  try {
    // eslint-disable-next-line no-new-func
    css = new Function('return ' + m[1])();
    css = Array.isArray(css) ? css.join('\n') : String(css);
  } catch (e) {
    throw new Error('解析 REPORT_CSS 失败：' + e.message);
  }
  const modules = buildModules();
  let html = template;
  if (!html.includes('/*__REPORT_CSS__*/')) throw new Error('模板缺少 REPORT_CSS 占位符');
  if (!html.includes('/*__MODULES__*/')) throw new Error('模板缺少 MODULES 占位符');
  html = html.replace('/*__REPORT_CSS__*/', () => css);
  html = html.replace('/*__MODULES__*/', () => modules);
  const banner = '<!-- 由 tools/build-replay-analyzer-html.mjs 生成，请勿手改；源文件：tools/analyzer/{core,svg,render}.mjs -->\n';
  return banner + html;
}

export function writeAnalyzerHtml(outFile = OUT) {
  const html = buildAnalyzerHtml();
  fs.writeFileSync(outFile, html, 'utf8');
  return { file: outFile, bytes: Buffer.byteLength(html) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--check')) {
    const html = buildAnalyzerHtml();
    console.log('构建 OK：' + Buffer.byteLength(html) + ' 字节（未落盘）');
  } else {
    const r = writeAnalyzerHtml();
    console.log('已写入 ' + r.file + '（' + (r.bytes / 1024).toFixed(1) + ' KB）');
  }
}
