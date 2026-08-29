#!/usr/bin/env node
/**
 * dsh-log-contract · bin/dsh-log-contract.mjs
 *
 * CLI：日志契约守护（DSH session log contract guard）。
 *
 * 子命令：
 *   check <session-log>           离线体检：解码 + 全契约校验 + 违规报告
 *                                  （支持 .jsonl / .jsonl.zstd）
 *   prewrite <edit-file> --log <session-log>
 *                                 写前校验：edit 文件描述一次"拟写入"，
 *                                 在落盘前用三层契约判定 通过/拒绝
 *   contracts                     列出内置契约规则目录
 */
import fs from 'node:fs';
import { loadSessionLog, validateSessionLog, createPreWriter, repairSession, CONTRACT_RULES, ruleById, extractToolOutputs, auditToolCalls } from '../lib/index.js';

const USAGE = `dsh-log-contract —— 日志契约守护（DSH session log contract guard）

用法：
  dsh-log-contract check <session-log> [--json] [--max-details N]
      离线体检。session-log 支持 .jsonl 与 .jsonl.zstd。
      --json          输出机器可读 JSON 报告
      --max-details N 每条违规最多列 N 个缺失 seq（默认 8，--json 忽略）

  dsh-log-contract fix <session-log> [--remove-markers] [--neutralize] [--clip-crossstep] [--apply] [--backup-dir DIR] [--json]
      诊断 + 修复（2026-08 事故固化方案）。先做严格 seq 连续扫描 + 契约体检
      （含 W1/W2 wire 级悬空 tool 检查），再按需修复：
      --remove-markers 移除 retrace/message-editor marker 并全量重编号
                       （用于大范围遮蔽历史 / marker 漏盖 tool/result）
      --clip-crossstep 裁剪 assistant/message 的跨 step sourceEventSeqs（token-meter 不再抛 belongs to another step）
      --neutralize     原地中和 turn-null marker（type→retrace/marker +
                       ignorable:true，删 surfaceOp/sourceEventSeqs，seq/行数不变）
                       —— token-meter 不再刷屏，会话驻留也安全（2026-08-30 事故）
      --apply          备份后落盘（.zstd 走官方帧格式重建：帧1=header、
                       帧2=其余、带 checksum、单个结尾换行）
      不传 --apply 为干跑（只报告）。
      注意：若会话已被运行中的应用驻留，修复文件后需重启（强杀避免脏状态刷回）。

  dsh-log-contract prewrite <edit-file> --log <session-log> [--json]
      写前校验。edit-file 为 JSON，两种形状：
        { "append": { ...事件... } }            拟追加一个事件到日志尾部
        { "edit": [ ...事件列表... ] }          帧级手术后的完整事件列表
      判定通过/拒绝并列出全部违规（三层契约：持久化/引擎/插件）。

  dsh-log-contract extract <session-log> --pattern <regex> [--out DIR] [--min-size N] [--json]
      考古提取：按命令正则导出工具输出（只读）。--out 写到目录（保留原始文本），
      否则打印前 3 条摘要。--min-size 过滤小输出（默认 50，任务书口径）。

  dsh-log-contract audit-report <session-log> [--json]
      考古审计报告：调用数 / 配对率 / 孤儿数 / 命令分布。

  dsh-log-contract contracts
      列出内置契约规则目录（含官方源码出处）。

  dsh-log-contract --version / --help
`;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printViolations(violations, maxDetails = 8) {
  if (violations.length === 0) {
    process.stdout.write('  ✔ 无违规\n');
    return;
  }
  for (const v of violations) {
    const loc = [v.seq !== null ? `seq ${v.seq}` : null, v.lineNo !== null ? `line ${v.lineNo}` : null]
      .filter(Boolean).join(' / ');
    const head = `  [${v.severity}] ${v.id} ${loc ? `@ ${loc}` : ''}${v.eventType ? ` (${v.eventType})` : ''}`;
    process.stdout.write(`${head}\n      ${v.message}\n`);
    if (Array.isArray(v.missingSeqs) && v.missingSeqs.length > maxDetails) {
      process.stdout.write(`      …另有 ${v.missingSeqs.length - maxDetails} 个缺失 seq 未列出\n`);
    }
  }
}

function cmdCheck(args) {
  const json = args.includes('--json');
  const maxDetailsIdx = args.indexOf('--max-details');
  const maxDetails = maxDetailsIdx >= 0 && args[maxDetailsIdx + 1] ? Number(args[maxDetailsIdx + 1]) : 8;
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) fail(USAGE);

  let log;
  try {
    log = loadSessionLog(file);
  } catch (err) {
    fail(`读取失败：${err.message}`);
  }
  const result = validateSessionLog(log);
  const { summary, violations, ok } = result;

  if (json) {
    process.stdout.write(JSON.stringify({ file, ok, summary, violations }, null, 2) + '\n');
    process.exit(ok ? 0 : 1);
  }

  process.stdout.write(`\n📋 dsh-log-contract check —— ${file}\n`);
  process.stdout.write(`   事件 ${summary.events} ｜ surface 节点 ${summary.surfaceNodes} ｜ replace 代数 ${summary.replaceGeneration} ｜ 帧 ${summary.frames}（${(summary.compressedBytes / 1024).toFixed(1)}KiB → ${(summary.plaintextBytes / 1024).toFixed(1)}KiB）\n`);
  process.stdout.write(`   违规 ${summary.total}（error ${summary.bySeverity.error} / warning ${summary.bySeverity.warning}）\n\n`);
  printViolations(violations, maxDetails);
  process.stdout.write(`\n${ok ? '✅ 通过：官方 foldSurface 可重放，三层契约绿' : '❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）'}\n\n`);
  process.exit(ok ? 0 : 1);
}

function cmdPrewrite(args) {
  const json = args.includes('--json');
  const logIdx = args.indexOf('--log');
  const file = args.find((a) => !a.startsWith('-') && a !== 'prewrite');
  if (!file || logIdx < 0 || !args[logIdx + 1]) fail(USAGE);

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`edit 文件读取/解析失败：${err.message}`);
  }
  if (typeof plan !== 'object' || plan === null) fail('edit 文件必须是 JSON 对象');

  let log;
  try {
    log = loadSessionLog(args[logIdx + 1]);
  } catch (err) {
    fail(`会话日志读取失败：${err.message}`);
  }
  const baseline = validateSessionLog(log);
  if (!baseline.ok) {
    // 基线已坏：写前校验无法在坏基线上给出可信结论
    fail(`基线会话已有 ${baseline.summary.bySeverity.error} 个 error 级违规，请先修复基线再校验写入（安全修复协议第 2 步：改前基线必须绿）`);
  }

  const prewriter = createPreWriter({ events: log.events.map((e) => e.event) });
  let result;
  if (Object.hasOwn(plan, 'append')) {
    result = prewriter.validateAppend(plan.append);
    result.op = 'append';
  } else if (Object.hasOwn(plan, 'edit')) {
    if (!Array.isArray(plan.edit)) fail('edit 必须为事件数组');
    result = prewriter.validateEdit(plan.edit);
    result.op = 'edit';
  } else {
    fail('edit 文件必须含 "append" 或 "edit" 键');
  }

  if (json) {
    process.stdout.write(JSON.stringify({ file, op: result.op, ok: result.ok, bySeverity: result.bySeverity, violations: result.violations }, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  process.stdout.write(`\n✍️  dsh-log-contract prewrite —— ${file}（op: ${result.op}，nextSeq: ${prewriter.nextSeq}）\n\n`);
  if (result.ok) {
    process.stdout.write('  ✅ 写入安全：三层契约全绿（持久化 foldSurface 可重放 / 引擎层无崩溃风险 / 插件 marker 语义自洽）\n');
    process.stdout.write(`     写入后 surface 节点 ${result.stateAfter.surfaceNodes} 个，nextSeq ${result.stateAfter.nextSeq}\n\n`);
    process.exit(0);
  }
  process.stdout.write('  ❌ 写入会被拒：\n');
  printViolations(result.violations);
  process.stdout.write('\n');
  process.exit(1);
}

function cmdContracts() {
  process.stdout.write('dsh-log-contract 契约规则目录（spec：59 条审计发现 + 官方源码逐行核对）\n\n');
  for (const r of CONTRACT_RULES) {
    process.stdout.write(`  ${r.id}  [${r.severity}/${r.layer}] ${r.title}\n      ${r.description}\n      出处: ${r.source}\n\n`);
  }
}

function cmdFix(args) {
  const json = args.includes('--json');
  const removeMarkers = args.includes('--remove-markers');
  const neutralize = args.includes('--neutralize');
  const clipCrossStep = args.includes('--clip-crossstep');
  const dropFailedTurns = args.includes('--drop-failed-turns');
  const trimIdx = args.indexOf('--trim-last');
  const trimLast = trimIdx >= 0 && args[trimIdx + 1] ? Number(args[trimIdx + 1]) : undefined;
  const compactIdx = args.indexOf('--compact-last');
  const compactLast = compactIdx >= 0 && args[compactIdx + 1] ? Number(args[compactIdx + 1]) : undefined;
  const apply = args.includes('--apply');
  const backupDirIdx = args.indexOf('--backup-dir');
  const backupDir = backupDirIdx >= 0 && args[backupDirIdx + 1] ? args[backupDirIdx + 1] : undefined;
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) fail(USAGE);

  const result = repairSession(file, { removeMarkers, neutralize, clipCrossStep, dropFailedTurns, trimLast, compactLast, apply, backupDir });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  process.stdout.write(`\n🔧 dsh-log-contract fix —— ${file}\n`);
  process.stdout.write(`   诊断：${result.issues.length === 0 ? '无问题' : result.issues.map((i) => `[${i.kind}] ${i.detail}`).join('\n         ')}\n`);
  if (result.applied) {
    process.stdout.write(`   已应用修复：移除 ${result.removed} 项，重编号 ${result.renumbered} 行，中和 ${result.neutralized} 个 turn-null marker，裁剪 ${result.clipped} 个跨 step 引用（seq ${(result.neutralizedSeqs ?? []).join(',')}）\n`);
    process.stdout.write(`   备份：${result.backupPath}\n`);
    process.stdout.write(`   修复后体检：error ${result.check.summary?.bySeverity?.error ?? '?'} ｜ surface ${result.check.summary?.surfaceNodes ?? '?'} 节点\n`);
  } else if (apply && !result.ok) {
    process.stdout.write('   ❌ 存在 error 级问题，拒绝应用（改前基线必须绿；先修基线或检查输出）\n');
  } else if (apply) {
    process.stdout.write('   （--apply 且无问题——无内容可修）\n');
  } else {
    process.stdout.write(`   （干跑模式：${result.removed} 项可移除、${result.renumbered} 行待重编号、${result.neutralized} 个 turn-null marker 可中和、${result.clipped} 个跨 step 引用可裁剪；加 --apply 落盘，--remove-markers / --neutralize / --clip-crossstep / --drop-failed-turns / --trim-last N 启用于对应修复）\n`);
  }
  process.stdout.write('\n');
  process.exit(result.ok ? 0 : 1);
}

function cmdExtract(args) {
  const json = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : undefined;
  const minIdx = args.indexOf('--min-size');
  const minSize = minIdx >= 0 && args[minIdx + 1] ? Number(args[minIdx + 1]) : 50;
  const patternIdx = args.indexOf('--pattern');
  const pattern = patternIdx >= 0 && args[patternIdx + 1] ? args[patternIdx + 1] : '';
  const file = args.find((a) => !a.startsWith('-'));
  if (!file || pattern === '') fail('extract 需要 <session-log> 与 --pattern <regex>');

  const log = loadSessionLog(file);
  const { pairs, total } = extractToolOutputs(log.events.map((e) => e.event), pattern, { minSize });
  if (json) {
    process.stdout.write(JSON.stringify({ file, pattern, matched: pairs.length, total, pairs: pairs.map((p) => ({ callId: p.callId, command: p.command, size: p.size })) }, null, 2) + '\n');
    process.exit(0);
  }
  process.stdout.write(`\n🔍 dsh-log-contract extract —— ${file}\n`);
  process.stdout.write(`   命令正则：/${pattern}/ ｜ 匹配 ${pairs.length} 个输出（共 ${total} 个工具调用，min-size ${minSize}）\n`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    let written = 0;
    for (const p of pairs) {
      const safe = p.callId.replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(`${outDir}/${safe}.txt`, p.text);
      written += 1;
    }
    process.stdout.write(`   已导出 ${written} 个输出到 ${outDir}\n`);
  } else {
    for (const p of pairs.slice(0, 3)) {
      process.stdout.write(`   - [${p.size}B] ${p.command.slice(0, 60)}… ${p.text.slice(0, 80).replace(/\n/g, ' ')}…\n`);
    }
    if (pairs.length > 3) process.stdout.write(`   … 其余 ${pairs.length - 3} 个（加 --out DIR 全部导出）\n`);
  }
  process.stdout.write('\n');
  process.exit(0);
}

function cmdAuditReport(args) {
  const json = args.includes('--json');
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) fail(USAGE);
  const log = loadSessionLog(file);
  const report = auditToolCalls(log.events.map((e) => e.event));
  if (json) {
    process.stdout.write(JSON.stringify({ file, ...report }, null, 2) + '\n');
    process.exit(0);
  }
  process.stdout.write(`\n📊 dsh-log-contract audit-report —— ${file}\n`);
  process.stdout.write(`   工具调用 ${report.calls} ｜ 结果 ${report.results} ｜ 孤儿 ${report.orphans} ｜ 配对率 ${(report.pairingRate * 100).toFixed(1)}%\n`);
  process.stdout.write(`   输出总字节 ${report.outputBytes}`);
  if (report.largest) process.stdout.write(` ｜ 最大 ${report.largest.size}B（${(report.largest.command || '?').slice(0, 40)}）`);
  process.stdout.write(`\n   命令分布（前 ${report.commands.top.length} 个去重）：\n`);
  for (const { command, count } of report.commands.top.slice(0, 8)) {
    process.stdout.write(`     ${String(count).padStart(4)}  ${(command || '(no-command)').slice(0, 70)}\n`);
  }
  process.stdout.write('\n');
  process.exit(0);
}

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`dsh-log-contract ${pkg.version}\n`);
  process.exit(0);
}
if (cmd === 'check') cmdCheck(args.slice(1));
else if (cmd === 'extract') cmdExtract(args.slice(1));
else if (cmd === 'audit-report') cmdAuditReport(args.slice(1));
else if (cmd === 'prewrite') cmdPrewrite(args.slice(1));
else if (cmd === 'fix') cmdFix(args.slice(1));
else if (cmd === 'contracts') cmdContracts();
else fail(`未知子命令 "${cmd}"\n\n${USAGE}`);
