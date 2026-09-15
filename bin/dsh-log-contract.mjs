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
import { loadSessionLog, validateSessionLog, resumeVerdict, migrationVerdict, assessmentScope, createPreWriter, repairSession, readSessionHeader, CONTRACT_RULES, ruleById, extractToolOutputs, auditToolCalls, hostCapability, HOST_MAX_FILE_VERSION, detectSupport } from '../lib/index.js';

/**
 * 同步写 fd——`process.stdout.write` 在**管道**下是异步的，紧跟着的
 * `process.exit()` 不会等待 flush：>~64KiB 的输出会丢尾，`--json` 因此变成非法 JSON
 * （实测在 3000 事件夹具与真实 14.5MB v3 会话上复现，stdout 56648B 处 "Unterminated string"）。
 * 这里直接同步写 fd 1/2（非阻塞管道 EAGAIN 时自旋重试），做到"先写完再 exit"。
 */
function writeAllSync(fd, text) {
  const buf = Buffer.from(String(text), 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      throw err;
    }
  }
}
const out = (text) => writeAllSync(1, text);
const errOut = (text) => writeAllSync(2, text);

const USAGE = `dsh-log-contract —— 日志契约守护（DSH session log contract guard）

用法：
  dsh-log-contract check <session-log> [--json] [--max-details N] [--resume] [--fail-on-migration] [--no-fail-on-migration]
      离线体检 + **迁移预检**（两个**独立维度**，互不蕴含）。session-log 支持 .jsonl 与 .jsonl.zstd。
      ⚠️ 口径边界：本工具只判定它实现的规则集。「ok」/「可加载」/「可继续」/「可压缩」
      **不代表**会话"可用"，**不代表**可安全编辑，也**不代表**官方升级路径会接受
      （迁移是独立维度，覆盖边界见 contracts 输出与 lib/contracts.js 的 G 段）。
      --json          输出机器可读 JSON 报告（含 host / assessable / assessmentScope / migration 字段）
      --max-details N 每条违规最多列 N 个缺失 seq（默认 8，--json 忽略）
      --resume        输出分层结论：可加载 / 可继续 / 可压缩（本工具规则集内）
                      + 迁移预检（官方 v0/v1/v2→当前格式会不会拒）；--json 时附带。
      --fail-on-migration     migration.ready===false（工具判"官方升级会拒"）时退出码 4。
                      **注意：默认已经是这个行为**（已把"报告与退出码不一致"的假阴性修掉）；
                      本开关是**显式别名**，便于 CI 把意图写进命令行。
      --no-fail-on-migration  **真 opt-out**：恢复 0.3.11 的行为——迁移 blocked 不再改退出码
                      （结构绿即 exit 0）。两者同时给时 **opt-out 优先**。若你的流水线依赖旧退出码，
                      用本开关；也可改读 --json 的 assessmentScope / migration.ready 自定门槛。
      评估范围 assessmentScope（顶层字段，与 migration.assessmentScope 同值）：
      'full' = 被检文件**已是当前官方格式（version=3）、无需迁移** ⇒ 工具规则集对该文件是完整的；
      'partial' = **需要迁移**（version<3）：迁移维度只覆盖 2 条规则，另有 6 类未覆盖 ⇒
      **不构成"官方升级会接受"**；'none' = 本宿主能力不足以评估（文件版本 > 宿主上限）。
      机器应判 assessmentScope == "full" 才可把绿读作完整评估（partial/none 都不该）。
      退出码：0 本工具认为可加载且无迁移阻断；1 有 error 级违规；3 不可在本宿主评估
              （被检文件版本 > 宿主支持上限，如 rc.7 宿主的 v3 文件——**不是** broken）；
              4 迁移预检 blocked（assessmentScope=partial 且 migration.ready=false；可用
              --no-fail-on-migration 退出该档）。

  dsh-log-contract fix <session-log> [--remove-markers] [--neutralize] [--neutralize-legacy-markers] [--clip-crossstep] [--drop-failed-turns] [--trim-last N] [--compact-last N] [--tail-renumber D] [--neutralize-orphan] [--extract-turn N] [--keep-ranges a-b,c-d] [--apply] [--backup-dir DIR] [--json]
      诊断 + 修复（2026-08 事故固化方案）。先做严格 seq 连续扫描 + 契约体检
      （含 W1/W2 wire 级悬空 tool 检查），再按需修复：
      --remove-markers 移除 retrace/message-editor marker 并全量重编号
                       （用于大范围遮蔽历史 / marker 漏盖 tool/result）
      --clip-crossstep 裁剪 assistant/message 的跨 step sourceEventSeqs（token-meter 不再抛 belongs to another step）
      --neutralize     原地中和 turn-null marker（type→retrace/marker +
                       ignorable:true，删 surfaceOp/sourceEventSeqs，seq/行数不变）
                       —— token-meter 不再刷屏，会话驻留也安全（2026-08-30 事故）
      --neutralize-legacy-markers
                       **一次性根治历史载体债**：只中和
                       assistant/message + data.editor 形态的历史 retrace marker
                       （新载体是 user/message + data.id，不在此列）。清理后，
                       写前校验不再需要"≤v2 历史 marker T1 降级"那条豁免。
      --drop-failed-turns 删除"本轮运行失败"的轮次（清失败报错气泡）
      --trim-last N    裁剪到最近 N 条 append 消息（保留所在 turn 结构）
      --trim-budget N  按 token 预算裁剪（L5）：自动选保留消息数使估算 ≤ N
                       （中文 ≈ 字符数×0.94，不是 ÷4；下限至少保留 5 条消息）
      --compact-last N 官方压缩：遮蔽旧 surface 节点，日志零删除（/compact 语义）
      --tail-renumber D 尾部 seq 统一平移（delta 是减数：要加 N 传 −N）
                       （修复多写入者/旧光标造成的尾部 seq 回归/间隙；从首个
                       可平移 seq 起）
      --neutralize-orphan 原地归零 fork 边界孤儿 inbox spliced（removedCount→0，
                       seq/行数不变 → 不再重复排队）
      --extract-turn N 双流交织恢复：只保留轮次 N + 无 turn 系统事件，其余
                       删除并全量重编号（--extract-turn-to M 把第二个同名
                       轮次改号为 M）
      --keep-ranges a-b,c-d 只保留 1-based 行区间（含端点），其余删除 +
                       全量重编号（header 行永远保留）
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
      否则打印前 3 条摘要。--min-size 过滤小输出（默认 50）。

  dsh-log-contract audit-report <session-log> [--json]
      考古审计报告：调用数 / 配对率 / 孤儿数 / 命令分布。

  dsh-log-contract contracts
      列出内置契约规则目录（含官方源码出处）。

  dsh-log-contract --version / --help
`;

function fail(message, code = 1) {
  errOut(`${message}\n`);
  process.exit(code);
}

function printViolations(violations, maxDetails = 8) {
  if (violations.length === 0) {
    out('  ✔ 无违规\n');
    return;
  }
  for (const v of violations) {
    const loc = [v.seq !== null ? `seq ${v.seq}` : null, v.lineNo !== null ? `line ${v.lineNo}` : null]
      .filter(Boolean).join(' / ');
    const head = `  [${v.severity}] ${v.id} ${loc ? `@ ${loc}` : ''}${v.eventType ? ` (${v.eventType})` : ''}`;
    out(`${head}\n      ${v.message}\n`);
    if (Array.isArray(v.missingSeqs) && v.missingSeqs.length > maxDetails) {
      out(`      …另有 ${v.missingSeqs.length - maxDetails} 个缺失 seq 未列出\n`);
    }
  }
}

/** 漂移抬头（2026-09-14）:漂移清单 + 未复核清单 + "勿据此跑 fix --apply"。 */
function driftLines(drift, probes) {
  if (!drift) return '';
  const host = probes ? `${probes.hostPackage}（SESSION_FORMAT_VERSION=${probes.sessionFormatVersion},词表 ${probes.knownTypes} 类）` : '未知';
  // 注:这里**刻意不用 ✅/⚠️ 之外的"通过"符号**——待迁移文件（assessmentScope=partial）的
  // 输出被测试钉死为"不得出现无条件绿的 ✅"，漂移行不能破坏那条纪律。
  const probeOk = (probes?.probes ?? []).filter((x) => x.ok).length;
  const probeTotal = (probes?.probes ?? []).length;
  let out = `   漂移检测：宿主 ${host} ｜ 行为探针 ${drift.probeVerified ? `全部与规则假设一致（${probeOk}/${probeTotal}）` : `${drift.unverifiedRules.length} 组不一致（${probeOk}/${probeTotal} 一致）`}\n`;
  if (drift.unverifiedRules.length > 0) {
    out += `     ⛔ **UNVERIFIED**（探针与规则假设不一致,结论不可采信）:${drift.unverifiedRules.join('、')}\n`;
  }
  out += `     出处未复核（已知债,仅告警）:${drift.driftedSources.join('、')}\n`;
  out += `     判定前提存疑（仅告警）:${drift.premiseStale.join('、')}${drift.undecidable.length ? `；无法判定:${drift.undecidable.join('、')}` : ''}\n`;
  if (drift.fixApplyBlocked) {
    out += '     ⛔ **禁止据此跑 `fix --apply`**（存在未验证规则:写入类动作不可逆）——先按 report 复核这些规则或显式确认。\n';
  }
  return out;
}

/** 版本支持面（2026-09-14 用户要求第 1 条）：一行摘要 + 逐条告警。
 *  `readOnly` = 未验证格式 ⇒ 只读（check 照跑结构层；prewrite/fix 直接拒绝）。 */
function supportLines(support) {
  if (!support) return '';
  let s = `   版本支持：${support.summary}\n`;
  s += `     测试基线：${support.baseline.hostPackage}@${support.baseline.hostVersion} ｜ 会话格式 v${support.baseline.sessionFormatVersion}`
    + `（已知 ${support.baseline.knownFormatVersions.join('/')}；peer ${support.baseline.peerRange}）\n`;
  for (const w of support.warnings ?? []) s += `     ⚠️  ${w}\n`;
  if (support.readOnly) s += '     ⛔ 未验证格式 ⇒ **只读**：不给出写入/修复结论（版本检测见 lib/version-support.js）\n';
  return s;
}

/** S2 横幅：被检文件版本 > 宿主支持上限 ⇒ "不可在本宿主评估"（**不是** broken）。 */
function notAssessableBanner(result) {
  const na = result.notAssessable ?? {};
  return `\n⚠️  不可在本宿主评估（not-assessable）\n`
    + `    被检文件 version=${na.fileVersion} ＞ 本宿主支持的最大文件版本 ${na.hostMaxFileVersion}\n`
    + `    宿主 @deepseek-ai/dsh-session@${na.hostPackage}\n`
    + `    原因：${na.reason}\n`
    + `    已跳过规则：${(na.skippedRules ?? []).join(', ')}\n`
    + `    已执行：结构层（Z/H/R/E1·E2·E4·E5·E6/S9/M/P/P3·P4/I1）；结构层结论 ${result.structuralOk ? '绿' : '有 error（见上）'}\n`
    + `    ⚠️ 这不表示日志损坏，也**不要**据此运行 fix --apply —— 请用 0.1.5+ 宿主评估。\n`
    + supportLines(result.support);
}

/** 迁移预检（独立维度）文本。
 * @param {object} mig `migrationVerdict()` 结果
 * @param {boolean} partial 待迁移文件（`migration.applies===true`）⇒ 迁移维度只部分覆盖，
 *   不得给无条件绿（2026-09-14 规格 (i)+(iii)）。
 */
function migrationLine(mig, partial = false) {
  if (!mig) return '';
  if (mig.assessable === false) return `   迁移预检：不可评估（本宿主能力不足）\n`;
  if (mig.applies === false) return `   迁移预检：— 不适用（${mig.reason ?? ''}）\n`;
  const n = mig.blocked?.length ?? 0;
  let s = mig.ready
    ? (partial
      ? `   迁移预检（独立维度，≠"可用/可升级"）：⚠️ 仅覆盖 ${mig.coverage.implemented.length} 条规则；另有 ${mig.coverage.uncovered.length} 类未覆盖（未覆盖 ≠ 通过）—— **不构成"升级会接受"**\n`
      : `   迁移预检（独立维度，≠"可用/可升级"）：✅ 通过（仅限本工具覆盖范围）\n`)
    : `   迁移预检（独立维度，≠"可用/可升级"）：❌ blocked（${n} 项：官方升级路径会拒）\n`;
  for (const v of (mig.blocked ?? []).slice(0, 5)) {
    s += `     [${v.id}] seq ${v.seq ?? '-'}${v.eventType ? ` (${v.eventType})` : ''} — ${String(v.message).slice(0, 130)}\n`;
  }
  if (n > 5) s += `     …另有 ${n - 5} 项\n`;
  s += `     覆盖边界：已覆盖 ${mig.coverage.implemented.length} 条；未覆盖 ${mig.coverage.uncovered.length} 类官方迁移规则（未覆盖 ≠ 通过；判据 ${mig.coverage.note}）\n`;
  // 规格 (iii)：把未覆盖类名直接列出来，人不必开 --json 才知道边界。
  if (partial) {
    for (const [i, c] of (mig.coverage.uncovered ?? []).entries()) s += `       ${i + 1}. ${c}\n`;
  }
  return s;
}

function cmdCheck(args) {
  const json = args.includes('--json');
  const resume = args.includes('--resume');
  // `--fail-on-migration` 是**默认已生效行为**的显式别名；
  // `--no-fail-on-migration` 是**真 opt-out**（恢复旧行为：迁移 blocked 不再改退出码）。
  // 两者同时给 ⇒ opt-out 优先（help/README 写明）。
  const failOnMigration = args.includes('--fail-on-migration');
  const noFailOnMigration = args.includes('--no-fail-on-migration');
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
  const notAssessable = result.assessable === false;
  const migration = result.migration ?? migrationVerdict(result);
  // 机器可判的评估范围（partial = 待迁移文件，迁移维度只部分覆盖）。
  const scope = result.assessmentScope ?? assessmentScope(result);
  const partial = scope === 'partial';
  const migBlocked = migration?.applies === true && migration.ready === false;
  // 默认：`ready===false` ⇒ 非 0（修掉的假阴性）。
  // `--fail-on-migration` = 显式别名（同默认）；`--no-fail-on-migration` = 真 opt-out（恢复旧行为）。
  const migGate = !noFailOnMigration && (migBlocked || (failOnMigration && migration?.ready === false));
  // 退出码：3 不可评估 > 1 结构 error > 4 迁移 blocked > 0。
  const exitCode = notAssessable ? 3 : (!ok ? 1 : (migGate ? 4 : 0));

  if (json) {
    const payload = { file, ok, assessable: !notAssessable, assessmentScope: scope, host: hostCapability(), support: result.support ?? null, probes: result.probes ?? null, drift: result.drift ?? null, migration, summary, violations };
    if (notAssessable) payload.notAssessable = result.notAssessable;
    if (resume) payload.resume = resumeVerdict(result);
    out(JSON.stringify(payload, null, 2) + '\n');
    process.exit(exitCode);
  }

  if (notAssessable) {
    out(notAssessableBanner(result));
    printViolations(violations, maxDetails);
    process.exit(3);
  }

  if (resume) {
    const v = resumeVerdict(result);
    const tier = v.verdict;
    // partial（待迁移文件）时不用 ✅：避免"全局绿"被读成"官方升级会接受"——用中性 ✔。
    const passMark = partial ? '✔' : '✅';
    const icons = { loadable: `${passMark} 可加载`, resumable: `${passMark} 可继续`, compactable: `${passMark} 可压缩`, broken: '❌ 不可用' };
    out(`\n📋 dsh-log-contract check --resume —— ${file}\n`);
    out(`   事件 ${summary.events} ｜ surface 节点 ${summary.surfaceNodes} ｜ replace 代数 ${summary.replaceGeneration} ｜ 帧 ${summary.frames}（${(summary.compressedBytes / 1024).toFixed(1)}KiB → ${(summary.plaintextBytes / 1024).toFixed(1)}KiB）\n`);
    out(`   违规 ${summary.total}（error ${summary.bySeverity.error} / warning ${summary.bySeverity.warning}）\n\n`);
    out(`   分层结论（**本工具规则集内**，不代表"可用"，也不代表官方升级会接受）：\n`);
    const tiers = [
      ['可加载 loadable', v.loadable, '会话能被 DSH 读入（结构规则 S1-S9/E/W 全绿）', v.blocking.loadable],
      ['可继续 resumable', v.resumable, 'resume/followup 可用（结构 + I1 inbox 重放绿）', v.blocking.resumable],
      ['可压缩 compactable', v.compactable, '/compact 与压力测量可用（前两档 + T1/T2 token-meter 配对绿）', v.blocking.compactable],
    ];
    for (const [name, pass, desc, blockers] of tiers) {
      const mark = pass ? passMark : '❌';
      out(`     ${mark} ${name} — ${desc}\n`);
      if (blockers.length > 0) out(`        阻断: ${[...new Set(blockers)].join(', ')}\n`);
    }
    out(supportLines(result.support));
    out(driftLines(result.drift, result.probes));
    out(migrationLine(migration, partial));
    out(`\n   结论: ${icons[tier]}${migBlocked
      ? '（本工具规则集内）—— 但**迁移预检 blocked**：不得据此宣称"可升级"'
      : partial
        ? '（本工具规则集内）—— 但**迁移维度仅部分覆盖**（assessmentScope=partial）：不得据此宣称"可升级"'
        : v.verdict === 'compactable' ? ' —— 本工具规则集内可安全继续使用' : v.verdict === 'broken' ? ' —— 见上方违规明细（error 级 = 会话不可读/不可写）' : ' —— 部分能力受限'}\n\n`);
    printViolations(violations, maxDetails);
    process.exit(exitCode);
  }

  out(`\n📋 dsh-log-contract check —— ${file}\n`);
  out(`   事件 ${summary.events} ｜ surface 节点 ${summary.surfaceNodes} ｜ replace 代数 ${summary.replaceGeneration} ｜ 帧 ${summary.frames}（${(summary.compressedBytes / 1024).toFixed(1)}KiB → ${(summary.plaintextBytes / 1024).toFixed(1)}KiB）\n`);
  out(`   违规 ${summary.total}（error ${summary.bySeverity.error} / warning ${summary.bySeverity.warning}）\n`);
  out(supportLines(result.support));
  out(driftLines(result.drift, result.probes));
  out(migrationLine(migration, partial));
  out('\n');
  printViolations(violations, maxDetails);
  out(`\n${ok
    ? (migBlocked
      ? '⚠️ 本工具认为可加载（结构层绿），但**迁移预检 blocked** —— 不得据此宣称"可用/可升级"；详见上方迁移预检'
      : partial
        ? '⚠️ 本工具规则集内未发现违规；**迁移维度仅部分覆盖**（assessmentScope=partial，不代表官方升级会接受）—— 详见上方迁移预检的覆盖边界'
        : '✅ 通过（本工具规则集内：结构层绿）')
    : '❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）'}\n\n`);
  process.exit(exitCode);
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
  // 版本支持面（2026-09-14 用户要求第 1 条）：**未验证格式 ⇒ 只读**，不得给出写入结论。
  if (baseline.support?.readOnly) {
    fail(`未验证的会话格式（来源 ${baseline.support.file.source}，版本 v${baseline.support.file.version}）——按只读处理，写前校验无法给出可信结论。`
      + ` ${baseline.support.warnings?.[0] ?? ''}`, 3);
  }
  // S2：本宿主评估不了的文件**不能**给出写前结论（否则会拿假阳性去拦合法写入）
  if (baseline.assessable === false) {
    fail(`不可在本宿主评估该会话（${baseline.notAssessable?.reason ?? '宿主能力不足'}）——写前校验无法给出可信结论；请用 0.1.5+ 宿主`, 3);
  }
  if (!baseline.ok) {
    // 基线已坏：写前校验无法在坏基线上给出可信结论
    fail(`基线会话已有 ${baseline.summary.bySeverity.error} 个 error 级违规，请先修复基线再校验写入（安全修复协议第 2 步：改前基线必须绿）`);
  }

  // C2：把被检文件的 header 显式交给 prewriter（版本不再靠模块级全局；缺省也能自行推断）
  const prewriter = createPreWriter({ events: log.events.map((e) => e.event), header: log.header });
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
    out(JSON.stringify({ file, op: result.op, ok: result.ok, bySeverity: result.bySeverity, legacyMarkerDebt: result.legacyMarkerDebt ?? null, violations: result.violations }, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  out(`\n✍️  dsh-log-contract prewrite —— ${file}（op: ${result.op}，nextSeq: ${prewriter.nextSeq}）\n\n`);
  if (result.legacyMarkerDebt) {
    // 「降级可见」:历史 marker 债不只是 warning 里的一句话,这里显式打印并给出根治命令。
    const d = result.legacyMarkerDebt;
    out(`  ⚠️  检测到**历史 marker 载体**（${d.kind} 形态，id=${d.id}，targetSeq=${d.targetSeq}，seq=${d.seq}）：\n`);
    out(`     T1 已按 ≤v${d.formatVersion <= 2 ? 2 : d.formatVersion} 白名单降级为 warning（仅历史载体、仅旧格式文件）——\n`);
    out('     但**压缩（/compact）前仍需清理**，否则 token-meter 自检会拦：一次性根治 →\n');
    out(`     \`dsh-log-contract fix <log> --neutralize-legacy-markers --apply\`（备份后原地中和，seq/行数不变）\n\n`);
  }
  if (result.ok) {
    out('  ✅ 写入安全：三层契约全绿（持久化 foldSurface 可重放 / 引擎层无崩溃风险 / 插件 marker 语义自洽）\n');
    out(`     写入后 surface 节点 ${result.stateAfter.surfaceNodes} 个，nextSeq ${result.stateAfter.nextSeq}\n\n`);
    process.exit(0);
  }
  out('  ❌ 写入会被拒：\n');
  printViolations(result.violations);
  out('\n');
  process.exit(1);
}

function cmdContracts() {
  out('dsh-log-contract 契约规则目录（spec：官方源码逐行核对 + 实测事故固化）\n\n');
  for (const r of CONTRACT_RULES) {
    const flags = [
      r.candidate ? '候选规则' : null,
      r.sourceVerified === false ? '出处未复核' : null,
      r.premiseStale ? '判定前提存疑' : null,
    ].filter(Boolean).join(' / ');
    out(`  ${r.id}  [${r.severity}/${r.layer}] ${r.title}${flags ? `  ⟪${flags}⟫` : ''}\n      ${r.description}\n      出处: ${r.source}\n\n`);
  }
}

function cmdFix(args) {
  const json = args.includes('--json');
  const removeMarkers = args.includes('--remove-markers');
  const neutralize = args.includes('--neutralize');
  // 一次性根治路径:只中和**历史载体**(assistant/message + data.editor)的 retrace marker
  const neutralizeLegacyMarkers = args.includes('--neutralize-legacy-markers');
  const clipCrossStep = args.includes('--clip-crossstep');
  const dropFailedTurns = args.includes('--drop-failed-turns');
  const trimIdx = args.indexOf('--trim-last');
  const trimLast = trimIdx >= 0 && args[trimIdx + 1] ? Number(args[trimIdx + 1]) : undefined;
  const budgetIdx = args.indexOf('--trim-budget');
  const trimBudget = budgetIdx >= 0 && args[budgetIdx + 1] ? Number(args[budgetIdx + 1]) : undefined;
  const compactIdx = args.indexOf('--compact-last');
  const compactLast = compactIdx >= 0 && args[compactIdx + 1] ? Number(args[compactIdx + 1]) : undefined;
  // L4 新原语（2026-08-30 收编外部验证工具）
  const tailIdx = args.indexOf('--tail-renumber');
  const tailRenumberDelta = tailIdx >= 0 && args[tailIdx + 1] ? Number(args[tailIdx + 1]) : undefined;
  const neutralizeOrphan = args.includes('--neutralize-orphan');
  const extractIdx = args.indexOf('--extract-turn');
  const extractTurn = extractIdx >= 0 && args[extractIdx + 1] ? Number(args[extractIdx + 1]) : undefined;
  const extractToIdx = args.indexOf('--extract-turn-to');
  const extractTurnTo = extractToIdx >= 0 && args[extractToIdx + 1] ? Number(args[extractToIdx + 1]) : undefined;
  const keepRangesIdx = args.indexOf('--keep-ranges');
  const keepRanges = keepRangesIdx >= 0 && args[keepRangesIdx + 1] ? args[keepRangesIdx + 1] : undefined;
  const apply = args.includes('--apply');
  const backupDirIdx = args.indexOf('--backup-dir');
  const backupDir = backupDirIdx >= 0 && args[backupDirIdx + 1] ? args[backupDirIdx + 1] : undefined;
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) fail(USAGE);

  // S2 安全闸：本宿主评估不了的文件**不许**修。危害路径（实测指出）：rc.7 上把健康 v3
  // 日志报成 broken → 用户以为日志坏了去跑 `fix --apply` ⇒ 在健康日志上动手。这里直接拒绝。
  const head = readSessionHeader(file);
  const fileVersion = Number.isSafeInteger(head?.version) ? head.version : 0;
  // 版本支持面：未验证格式 ⇒ 只读（不得修），与 S2 宿主能力闸并列。
  const support = detectSupport({ header: head });
  if (support.readOnly) {
    fail(`未验证的会话格式（来源 ${support.file.source}，版本 v${support.file.version}）——按只读处理，拒绝修复。`
      + ` ${support.warnings?.[0] ?? ''}`, 3);
  }
  if (fileVersion > HOST_MAX_FILE_VERSION) {
    fail(`拒绝修复：被检文件 version=${fileVersion} 高于本宿主 @deepseek-ai/dsh-session@${hostCapability().hostPackage} 支持的最大版本 ${HOST_MAX_FILE_VERSION}`
      + ` —— 本宿主评估不了该文件（不是"日志坏了"）。请用 0.1.5+ 宿主修复。`, 3);
  }

  const result = repairSession(file, { removeMarkers, neutralize, neutralizeLegacyMarkers, clipCrossStep, dropFailedTurns, trimLast, trimBudget, compactLast, tailRenumberDelta, neutralizeOrphan, extractTurn, extractTurnTo, keepRanges, apply, backupDir });
  if (json) {
    out(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  out(`\n🔧 dsh-log-contract fix —— ${file}\n`);
  out(`   诊断：${result.issues.length === 0 ? '无问题' : result.issues.map((i) => `[${i.kind}] ${i.detail}`).join('\n         ')}\n`);
  if (result.applied) {
    out(`   已应用修复：移除 ${result.removed} 项，重编号 ${result.renumbered} 行，中和 ${result.neutralized} 个 turn-null marker，裁剪 ${result.clipped} 个跨 step 引用（seq ${(result.neutralizedSeqs ?? []).join(',')}）\n`);
    out(`   备份：${result.backupPath}\n`);
    out(`   修复后体检：error ${result.check.summary?.bySeverity?.error ?? '?'} ｜ surface ${result.check.summary?.surfaceNodes ?? '?'} 节点\n`);
  } else if (apply && !result.ok) {
    out('   ❌ 存在 error 级问题，拒绝应用（改前基线必须绿；先修基线或检查输出）\n');
  } else if (apply) {
    out('   （--apply 且无问题——无内容可修）\n');
  } else {
    out(`   （干跑模式：${result.removed} 项可移除、${result.renumbered} 行待重编号、${result.neutralized} 个 turn-null marker 可中和、${result.clipped} 个跨 step 引用可裁剪；加 --apply 落盘，--remove-markers / --neutralize / --clip-crossstep / --drop-failed-turns / --trim-last N / --trim-budget N / --tail-renumber D / --neutralize-orphan / --extract-turn N / --keep-ranges a-b,c-d 启用于对应修复）\n`);
  }
  out('\n');
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
    out(JSON.stringify({ file, pattern, matched: pairs.length, total, pairs: pairs.map((p) => ({ callId: p.callId, command: p.command, size: p.size })) }, null, 2) + '\n');
    process.exit(0);
  }
  out(`\n🔍 dsh-log-contract extract —— ${file}\n`);
  out(`   命令正则：/${pattern}/ ｜ 匹配 ${pairs.length} 个输出（共 ${total} 个工具调用，min-size ${minSize}）\n`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    let written = 0;
    for (const p of pairs) {
      const safe = p.callId.replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(`${outDir}/${safe}.txt`, p.text);
      written += 1;
    }
    out(`   已导出 ${written} 个输出到 ${outDir}\n`);
  } else {
    for (const p of pairs.slice(0, 3)) {
      out(`   - [${p.size}B] ${p.command.slice(0, 60)}… ${p.text.slice(0, 80).replace(/\n/g, ' ')}…\n`);
    }
    if (pairs.length > 3) out(`   … 其余 ${pairs.length - 3} 个（加 --out DIR 全部导出）\n`);
  }
  out('\n');
  process.exit(0);
}

function cmdAuditReport(args) {
  const json = args.includes('--json');
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) fail(USAGE);
  const log = loadSessionLog(file);
  const report = auditToolCalls(log.events.map((e) => e.event));
  if (json) {
    out(JSON.stringify({ file, ...report }, null, 2) + '\n');
    process.exit(0);
  }
  out(`\n📊 dsh-log-contract audit-report —— ${file}\n`);
  out(`   工具调用 ${report.calls} ｜ 结果 ${report.results} ｜ 孤儿 ${report.orphans} ｜ 配对率 ${(report.pairingRate * 100).toFixed(1)}%\n`);
  out(`   输出总字节 ${report.outputBytes}`);
  if (report.largest) out(` ｜ 最大 ${report.largest.size}B（${(report.largest.command || '?').slice(0, 40)}）`);
  out(`\n   命令分布（前 ${report.commands.top.length} 个去重）：\n`);
  for (const { command, count } of report.commands.top.slice(0, 8)) {
    out(`     ${String(count).padStart(4)}  ${(command || '(no-command)').slice(0, 70)}\n`);
  }
  out('\n');
  process.exit(0);
}

const args = process.argv.slice(2);
const cmd = args[0];
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  out(USAGE);
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  out(`dsh-log-contract ${pkg.version}\n`);
  process.exit(0);
}
if (cmd === 'check') cmdCheck(args.slice(1));
else if (cmd === 'extract') cmdExtract(args.slice(1));
else if (cmd === 'audit-report') cmdAuditReport(args.slice(1));
else if (cmd === 'prewrite') cmdPrewrite(args.slice(1));
else if (cmd === 'fix') cmdFix(args.slice(1));
else if (cmd === 'contracts') cmdContracts();
else fail(`未知子命令 "${cmd}"\n\n${USAGE}`);
