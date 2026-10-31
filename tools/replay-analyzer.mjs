#!/usr/bin/env node
// ============================================================================
// 回放分析器 · CLI
// ----------------------------------------------------------------------------
// 吃一份 world.exportReplay() 产出的回放 JSON，输出战报（终端 / Markdown / HTML）。
// 不依赖浏览器、不启动仿真：纯离线复盘，可对任何来源的回放做 AAR。
//
// 用法：
//   node tools/replay-analyzer.mjs <replay.json>                    # 终端摘要
//   node tools/replay-analyzer.mjs <replay.json> --format=md         # Markdown
//   node tools/replay-analyzer.mjs <replay.json> --format=html --out report.html
//   node tools/replay-analyzer.mjs <replay.json> --check             # 回归检查（失败退出码 1）
//   node tools/replay-analyzer.mjs <replay.json> --json              # 结构化分析模型
//
// 选项：
//   --format=text|md|html|json   输出格式（默认按 --out 扩展名推断，否则 text）
//   --out=<file>                 写文件；缺省写 stdout
//   --data-dir=<dir>             舰船数据库目录（默认 <repo>/data），用于补舰种/吨位/乘员
//   --title=<str>                HTML 标题
//   --check[=rule1,rule2]        回归检查；默认三条规则见 core.mjs CHECK_RULES
//   --quiet                      只输出检查结果 / 错误
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeReplay, checkReplay, CHECK_RULES, fmtNum, sideZh } from './analyzer/core.mjs';
import { renderText, renderMarkdown, renderHtml } from './analyzer/render.mjs';

// 管道被下游提前关闭（| head）时安静退出，而不是抛 EPIPE 堆栈
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function usage(code = 0) {
  const lines = [
    '用法: node tools/replay-analyzer.mjs <replay.json> [选项]',
    '',
    '选项:',
    '  --format=text|md|html|json  输出格式（默认按 --out 扩展名推断，否则 text）',
    '  --out=<file>                写文件（缺省 stdout）',
    '  --data-dir=<dir>            舰船数据库目录（默认 ' + path.join(ROOT, 'data') + '）',
    '  --title=<str>               HTML 标题',
    '  --check[=a,b,c]             回归检查，不通过时退出码 1',
    '  --json                      等价于 --format=json',
    '  --quiet                     只输出检查结果',
    '',
    '检查规则: ' + Object.entries(CHECK_RULES).map(([k, v]) => k + '（' + v + '）').join('；'),
  ];
  console.log(lines.join('\n'));
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { positional: [], format: null, out: null, dataDir: path.join(ROOT, 'data'), title: null, check: false, checkRules: null, quiet: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') usage(0);
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--json') opts.format = 'json';
    else if (a.startsWith('--format=')) opts.format = a.slice(9);
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice(11);
    else if (a.startsWith('--title=')) opts.title = a.slice(8);
    else if (a === '--check') { opts.check = true; }
    else if (a.startsWith('--check=')) { opts.check = true; opts.checkRules = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a.startsWith('--')) { console.error('未知参数: ' + a); usage(2); }
    else opts.positional.push(a);
  }
  return opts;
}

function inferFormat(opts) {
  if (opts.format) return opts.format;
  if (opts.out) {
    const ext = path.extname(opts.out).toLowerCase();
    if (ext === '.html' || ext === '.htm') return 'html';
    if (ext === '.md' || ext === '.markdown') return 'md';
    if (ext === '.json') return 'json';
  }
  return 'text';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.positional.length) usage(2);
  const file = path.resolve(opts.positional[0]);
  let replay;
  try { replay = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('读取回放失败: ' + file + '\n' + (e && e.message ? e.message : e)); process.exit(2); }
  if (!replay || !Array.isArray(replay.events)) { console.error('不是有效回放：缺少 events 数组'); process.exit(2); }

  const model = analyzeReplay(replay, { dataDir: opts.dataDir });

  if (opts.check) {
    const res = checkReplay(model, opts.checkRules || undefined);
    if (!opts.quiet) console.log('回放：' + file + '\n剧本：' + model.meta.scenario + ' · 种子 ' + model.meta.seed + '\n');
    for (const row of res.rows) console.log((row.ok ? '  PASS  ' : '  FAIL  ') + row.rule + ' — ' + row.detail);
    console.log('');
    console.log(res.ok ? '检查通过' : '检查未通过（' + res.rows.filter((r) => !r.ok).length + ' 项）');
    process.exit(res.ok ? 0 : 1);
  }

  const format = inferFormat(opts);
  let out;
  if (format === 'text') out = renderText(model);
  else if (format === 'md' || format === 'markdown') out = renderMarkdown(model);
  else if (format === 'html') out = renderHtml(model, { title: opts.title });
  else if (format === 'json') out = JSON.stringify(stripHeavy(model), null, 1);
  else { console.error('未知输出格式: ' + format); process.exit(2); }

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.out), out, 'utf8');
    if (!opts.quiet) {
      const st = fs.statSync(path.resolve(opts.out));
      console.log('已写入 ' + path.resolve(opts.out) + '（' + (st.size / 1024).toFixed(1) + ' KB）');
      console.log(model.verdict.headline + ' — ' + fmtNum(model.meta.events) + ' 事件 · ' + model.findings.length + ' 条发现');
    }
  } else {
    process.stdout.write(out);
    if (format !== 'text') process.stdout.write('\n');
  }
}

// --format=json 时去掉体积大且可重算的原始帧/命中日志
function stripHeavy(model) {
  const { frames, hitLog, ...rest } = model;
  return Object.assign({}, rest, { frameCount: frames ? frames.length : 0, hitCount: hitLog ? hitLog.length : 0 });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { main, parseArgs, inferFormat };
