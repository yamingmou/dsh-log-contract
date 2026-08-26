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
import { loadSessionLog, validateSessionLog, createPreWriter, repairSession, CONTRACT_RULES, ruleById } from '../lib/index.js';

const USAGE = `dsh-log-contract —— 日志契约守护（DSH session log contract guard）

用法：
  dsh-log-contract check <session-log> [--json] [--max-details N]
      离线体检。session-log 支持 .jsonl 与 .jsonl.zstd。
      --json          输出机器可读 JSON 报告
      --max-details N 每条违规最多列 N 个缺失 seq（默认 8，--json 忽略）

  dsh-log-contract fix <session-log> [--remove-markers] [--apply] [--backup-dir DIR] [--json]
      诊断 + 修复（2026-08 事故固化方案）。先做严格 seq 连续扫描 + 契约体检
      （含 W1/W2 wire 级悬空 tool 检查），再按需修复：
      --remove-markers 移除 retrace/message-editor marker 并全量重编号
                       （用于大范围遮蔽历史 / marker 漏盖 tool/result）
      --apply          备份后落盘（.zstd 走官方帧格式重建：帧1=header、
                       帧2=其余、带 checksum、单个结尾换行）
      不传 --apply 为干跑（只报告）。
      注意：若会话已被运行中的应用驻留，修复文件后需重启（强杀避免脏状态刷回）。

  dsh-log-contract prewrite <edit-file> --log <session-log> [--json]
      写前校验。edit-file 为 JSON，两种形状：
        { "append": { ...事件... } }            拟追加一个事件到日志尾部
        { "edit": [ ...事件列表... ] }          帧级手术后的完整事件列表
      判定通过/拒绝并列出全部违规（三层契约：持久化/引擎/插件）。

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
  const apply = args.includes('--apply');
  const backupDirIdx = args.indexOf('--backup-dir');
  const backupDir = backupDirIdx >= 0 && args[backupDirIdx + 1] ? args[backupDirIdx + 1] : undefined;
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) fail(USAGE);

  const result = repairSession(file, { removeMarkers, apply, backupDir });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  process.stdout.write(`\n🔧 dsh-log-contract fix —— ${file}\n`);
  process.stdout.write(`   诊断：${result.issues.length === 0 ? '无问题' : result.issues.map((i) => `[${i.kind}] ${i.detail}`).join('\n         ')}\n`);
  if (result.applied) {
    process.stdout.write(`   已应用修复：移除 ${result.removed} 个 marker，重编号 ${result.renumbered} 行\n`);
    process.stdout.write(`   备份：${result.backupPath}\n`);
    process.stdout.write(`   修复后体检：error ${result.check.summary?.bySeverity?.error ?? '?'} ｜ surface ${result.check.summary?.surfaceNodes ?? '?'} 节点\n`);
  } else if (apply && !result.ok) {
    process.stdout.write('   ❌ 存在 error 级问题，拒绝应用（改前基线必须绿；先修基线或检查输出）\n');
  } else if (apply) {
    process.stdout.write('   （--apply 且无问题——无内容可修）\n');
  } else {
    process.stdout.write(`   （干跑模式：${result.removed} 个 marker 可移除、${result.renumbered} 行待重编号；加 --apply 落盘，--remove-markers 启用于移除）\n`);
  }
  process.stdout.write('\n');
  process.exit(result.ok ? 0 : 1);
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
else if (cmd === 'prewrite') cmdPrewrite(args.slice(1));
else if (cmd === 'fix') cmdFix(args.slice(1));
else if (cmd === 'contracts') cmdContracts();
else fail(`未知子命令 "${cmd}"\n\n${USAGE}`);
