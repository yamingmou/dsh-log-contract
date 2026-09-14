/**
 * dsh-log-contract · lib/validate.js
 *
 * 离线体检引擎：对 `loadSessionLog` 的结果逐条跑契约规则，产出违规报告。
 *
 * 判定哲学（复盘事故 §四-1）：**持久化层以 fold 不抛为通过**，
 * 但为定位问题，先用与官方同语义的增量重放做逐事件归因（S1–S7），
 * 再跑 fold 终验（S8）——两套都绿才算过。
 * 终验按**被检文件 header.version** 选：v3 → 运行时官方 `foldSurface`；
 * v0/v1/v2 → 本地等价实现 `legacyFoldSurface`（0.1.5 的 foldSurface 是 v3 语义，对旧格式会误报）。
 */
import { ruleById } from './contracts.js';
import { normalizeEventSeqRanges } from './compat.js';
import { HOST_MAX_FILE_VERSION, MIGRATION_TARGET_VERSION, hostCapability, isAssessableFileVersion } from './vocab.js';
import { detectSupport } from './version-support.js';
import { runHostProbes } from './host-probes.js';
import { SOURCE_DRIFT } from './contracts.js';
import {
  CHUNK_ROW_TYPES,
  envelopeViolations,
  ignorableTypeViolations,
  engineViolations,
  finalFold,
  inboxReplayViolations,
  isSafeInt,
  migrationPrecheckViolations,
  nullTurnStepViolations,
  physicalOrderViolations,
  pluginViolations,
  replaySurface,
  stepKeyViolations,
  turnEndReasonViolations,
  violation,
  tokenMeterViolations,
  tokenMeterSourceViolations,
  toolPairingViolations,
  toolResultStructureViolations,
  wireViolations,
} from './checks.js';

/** 宿主能力闸触发时**跳过**的规则（v3/被检版本语义相关）——报告里显式列出，避免"静默通过"。 */
const VERSION_DEPENDENT_RULES = ['E3', 'E7', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'W1', 'W2', 'T1', 'T2', 'T3', 'T4', 'T5', 'G1', 'G2'];

/**
 * 对会话日志执行全量离线体检。
 *
 * @param {object} log `loadSessionLog()` 的返回值
 * @param {{ baseSeq?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   violations: Array,
 *   summary: object,
 *   surface: object,
 * }}
 */
export function validateSessionLog(log, opts = {}) {
  const { baseSeq = 0 } = opts;
  const violations = [];
  const { header, headerLine, rows, frameInfo } = log;
  // C1 防御（多入口一致）：即使调用方手搓 log 对象、未经 `loadSessionLog`，也在体检入口
  // 归一一次 v3 区间编码。正常路径（loadSessionLog 已展开）下这是幂等的恒等映射。
  const events = (log.events ?? []).map((e) => ({ ...e, event: normalizeEventSeqRanges(e.event) }));
  // 1.3 第二半：词表/折叠路径按**被检文件自身版本**选择（不按运行时）。
  // C2：版本是**本次调用的局部量**，显式传给每条按版本择路的判定——不再写模块级全局
  // （旧实现 `setFileFormatVersion()` 会被同进程后调用的 prewrite 读到，造成结论翻转）。
  const formatVersion = Number.isSafeInteger(header?.version) && header.version >= 0 ? header.version : 0;

  // ── 宿主能力闸（S2·安全）──────────────────────────────────────────────────
  // 被检文件版本 > 本宿主支持的最大文件版本 ⇒ 本宿主没有该版本的词表/折叠语义。继续按
  // 本宿主语义判定会产出**假阳性**（独立复核实测：rc.7 上同一真实 v3 文件 →
  // `S8×1 + E3×40 / verdict=broken / loadable:false`），危险是用户以为日志坏了去跑
  // `fix --apply`。改为：只跑与版本无关的结构检查 + 显式"不可在本宿主评估"档。
  if (!isAssessableFileVersion(formatVersion)) {
    return unassessableResult({ header, headerLine, rows, events, frameInfo, baseSeq, formatVersion });
  }

  // ── Z · 帧结构 ─────────────────────────────────────────────────────────
  if (frameInfo?.torn) {
    violations.push(violation('Z1', { lineNo: null }, `zstd 尾帧撕裂：可能是写入中的 in-flight 帧或文件被截断（帧数 ${frameInfo.frames}）`));
  }
  if (frameInfo?.error) {
    violations.push(violation('Z2', { lineNo: null }, frameInfo.error));
  }

  // ── H · header ─────────────────────────────────────────────────────────
  if (header === null) {
    violations.push(violation('H1', { lineNo: headerLine }, '首行不是合法 JSON —— 整个会话不可读'));
  } else {
    if (header.type !== 'session') {
      violations.push(violation('H1', { lineNo: headerLine }, `首行 type 必须为 "session"（实际 ${String(header.type)}）`));
    }
    if (![0, 1, 2, 3].includes(header.version)) {
      violations.push(violation('H2', { lineNo: headerLine }, `header.version 未知（实际 ${String(header.version)}）——已知 0/1/2/3；未知版本按 0 处理会误判，请先确认格式`));
    }
    if (typeof header.id !== 'string' || header.id === '') {
      violations.push(violation('H2', { lineNo: headerLine }, 'header.id 必须为非空字符串'));
    }
    if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
      violations.push(violation('H2', { lineNo: headerLine }, 'header.createdAt 必须为非负安全整数'));
    }
    if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !header.cwd.startsWith('/'))) {
      violations.push(violation('H2', { lineNo: headerLine }, 'header.cwd 若存在必须为绝对路径'));
    }
    if (header.origin !== undefined && header.origin !== 'subagent') {
      violations.push(violation('H2', { lineNo: headerLine }, `header.origin 只能为 "subagent"（实际 ${String(header.origin)}）`));
    }
  }

  // ── Z3 · 空文件体检（2026-09-09 T3 增量）──────────────────────────
  // 空态无覆盖:36 条规则全来自"有内容"事故,空会话文件应显式报(不管 DSH 编排层怎么处理)。
  // 有 header 但零事件 = 异常空会话(warning,不破坏 ok);连 header 都没有 → H1 已报。
  if (header !== null && events.length === 0) {
    violations.push(violation('Z3', { lineNo: headerLine }, `会话文件无任何事件（仅 header）——异常空会话（新建即空或写入未落盘）；空态不在任何有内容规则的覆盖下，显式报出供人判断`));
  }

  // ── R · 存储行 ─────────────────────────────────────────────────────────
  for (const row of rows) {
    if (row.error && row.value === null) {
      violations.push(violation('R1', { lineNo: row.lineNo }, '该行不是合法 JSON（损坏行）'));
    } else if (row.error && CHUNK_ROW_TYPES.has(row.value?.type)) {
      violations.push(violation('R2', { lineNo: row.lineNo }, `chunk 行 "${row.value.type}" 损坏：${row.error.message} —— 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）`));
    }
  }

  // ── E · 事件信封 + seq 连续性 ──────────────────────────────────────────
  let expectedSeq = baseSeq;
  let seqBroken = false;
  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    violations.push(...envelopeViolations(event, loc, formatVersion));
    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0) {
      if (event.seq !== expectedSeq) {
        const kind = event.seq < expectedSeq ? '倒退（backward）' : '缺口（gap）';
        violations.push(violation('E2', loc, `seq ${event.seq} 不连续：${kind}，期望 ${expectedSeq} —— 违反单写入者假设（N6）`));
        seqBroken = true;
        expectedSeq = event.seq + 1;
      } else {
        expectedSeq = event.seq + 1;
      }
    }
  }

  // ── S9 · 文件物理序 seq 单调（多写入者交织现场；E2 排序后检查看不到）──
  violations.push(...physicalOrderViolations(rows));

  // ── S · surface 增量重放（归因）+ 官方 foldSurface 终验 ────────────────
  const replay = replaySurface(events, formatVersion);
  violations.push(...replay.violations);

  const folded = finalFold(events.map((e) => e.event), formatVersion);

  // ── T · token meter 配对（事故根因 3 + 2026-08-30 两类刷屏）──
  violations.push(...tokenMeterViolations(events));
  violations.push(...tokenMeterSourceViolations(events));

  // ── T3/T4/T5 · 渲染/契约层（复盘 2026-09-02）：节点 key 唯一 + turn 缺失 + turn/end reason ──
  // 数据层"健康"≠ 客户端能渲染/能加载：check/官方加载/分页全绿仍可能白屏或加载失败。
  violations.push(...stepKeyViolations(events));
  violations.push(...nullTurnStepViolations(events));
  violations.push(...turnEndReasonViolations(events));

  // ── E7 · ignorable 未知 type 合法性（T2）────────────────────
  violations.push(...ignorableTypeViolations(events, formatVersion));

  // ── I1 · inbox seed 相对重放（fork 边界孤儿；交接书 L1）──────────────
  violations.push(...inboxReplayViolations(events, header));

  // ── P3/P4 · 考古契约（工具配对 + 输出结构）──
  violations.push(...toolPairingViolations(events));
  violations.push(...toolResultStructureViolations(events));
  if (folded.error) {
    violations.push(violation('S8', { lineNo: null }, `foldSurface 重放失败（按文件版本选：v3 官方 / v0–v2 本地等价）：${folded.error.message} —— 会话加载会被拒（SessionPersistenceCorruptionError）`));
  }

  // ── W · wire 消息流（严格端点拒绝的悬空 tool / 顺序破坏）──────────────
  violations.push(...wireViolations(events, formatVersion));

  // ── M / P ──────────────────────────────────────────────────────────────
  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    violations.push(...engineViolations(event, loc));
    violations.push(...pluginViolations(event, loc));
  }

  // ── C · 并发（仅当出现 seq 破坏时给出解释性告警）─────────────────────
  if (seqBroken) {
    violations.push(violation('C1', { lineNo: null }, 'seq 缺口/倒退是多写入者（≥2 个 Host 进程共享同一 session 目录）并发写的典型后果；离线体检无法观测竞态本身，但此痕迹需人工核查（N6）'));
  }

  // ── G · 迁移预检（**独立维度**：官方升级路径会不会拒；不进 ok/verdict）──────
  // 官方把 v0/v1/v2 升到当前格式时的规则集比本工具的"读取/折叠"规则集更严：本工具判
  // ok/compactable **不代表**官方迁移会接受。这里只加 migration 层 warning（见 contracts G1/G2）。
  violations.push(...migrationPrecheckViolations(events, formatVersion));

  // ── 汇总 ───────────────────────────────────────────────────────────────
  violations.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1) || (a.lineNo ?? -1) - (b.lineNo ?? -1));
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byLayer = {};
  for (const v of violations) {
    bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
    byLayer[v.layer] = (byLayer[v.layer] ?? 0) + 1;
  }
  const summary = {
    total: violations.length,
    bySeverity,
    byLayer,
    events: events.length,
    surfaceNodes: replay.nodes.length,
    replaceGeneration: replay.replaceGeneration,
    frames: frameInfo?.frames ?? 0,
    compressedBytes: frameInfo?.compressedBytes ?? 0,
    plaintextBytes: frameInfo?.plaintextBytes ?? 0,
    fileVersion: formatVersion,
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
    assessable: true,
  };

  const result = {
    ok: bySeverity.error === 0,
    assessable: true,
    violations,
    summary,
    surface: folded.surface ?? { nodes: replay.nodes, replacements: [] },
  };
  // 版本支持面（2026-09-14 用户要求第 1 条）：宿主版本 vs 测试基线 + 被检文件格式版本，
  // 给出 warnings/readOnly。只读档由入口（prewrite/fix）强制执行。
  result.support = detectSupport({ header, events });
  // R-D 漂移检测：行为探针（宿主自己的运行时函数当 oracle）+ R-F 出处/前提漂移清单。
  result.probes = hostProbes();
  result.drift = driftOf(result.probes);
  result.migration = migrationVerdict(result);
  result.assessmentScope = result.migration.assessmentScope;
  return result;
}

/**
 * 宿主能力闸的结果（S2）：被检文件版本 > 本宿主支持的最大版本。
 *
 * 只跑**与版本无关**的结构检查（Z 帧 / H header / R 行 / E1·E2·E4·E5·E6 信封不含 E3 词表 /
 * S9 物理序 / M·P / P3·P4 / I1），其余（S1–S8/W/T/E3/E7/G）显式跳过并在 `notAssessable.skippedRules`
 * 里列出。**ok 固定 false**（不认证），但 `structuralOk` 单独给出结构层结论——
 * 语义是"本宿主评估不了"，不是"日志坏了"。
 */
function unassessableResult({ header, headerLine, rows, events, frameInfo, baseSeq, formatVersion }) {
  const violations = [];
  const cap = hostCapability();
  const notAssessable = {
    fileVersion: formatVersion,
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
    hostPackage: cap.hostPackage,
    skippedRules: VERSION_DEPENDENT_RULES,
    reason: `被检文件 version=${formatVersion} 高于本宿主 @deepseek-ai/dsh-session@${cap.hostPackage} 支持的最大文件版本 ${HOST_MAX_FILE_VERSION}`
      + `（本宿主只有 ≤${HOST_MAX_FILE_VERSION} 的词表/折叠语义）⇒ 按本宿主语义判定会产出假阳性（如 S8/E3）。`
      + '这不表示日志损坏；请用 0.1.5+ 宿主评估。',
  };

  // ── Z · 帧结构（版本无关）──
  if (frameInfo?.torn) violations.push(violation('Z1', { lineNo: null }, `zstd 尾帧撕裂：可能是写入中的 in-flight 帧或文件被截断（帧数 ${frameInfo.frames}）`));
  if (frameInfo?.error) violations.push(violation('Z2', { lineNo: null }, frameInfo.error));

  // ── H · header（版本无关）──
  if (header === null) {
    violations.push(violation('H1', { lineNo: headerLine }, '首行不是合法 JSON —— 整个会话不可读'));
  } else {
    if (header.type !== 'session') violations.push(violation('H1', { lineNo: headerLine }, `首行 type 必须为 "session"（实际 ${String(header.type)}）`));
    if (![0, 1, 2, 3].includes(header.version)) violations.push(violation('H2', { lineNo: headerLine }, `header.version 未知（实际 ${String(header.version)}）`));
    if (typeof header.id !== 'string' || header.id === '') violations.push(violation('H2', { lineNo: headerLine }, 'header.id 必须为非空字符串'));
    if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) violations.push(violation('H2', { lineNo: headerLine }, 'header.createdAt 必须为非负安全整数'));
    if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !header.cwd.startsWith('/'))) violations.push(violation('H2', { lineNo: headerLine }, 'header.cwd 若存在必须为绝对路径'));
    if (header.origin !== undefined && header.origin !== 'subagent') violations.push(violation('H2', { lineNo: headerLine }, `header.origin 只能为 "subagent"（实际 ${String(header.origin)}）`));
  }
  if (header !== null && events.length === 0) violations.push(violation('Z3', { lineNo: headerLine }, '会话文件无任何事件（仅 header）——异常空会话'));

  // ── R · 存储行（版本无关）──
  for (const row of rows) {
    if (row.error && row.value === null) violations.push(violation('R1', { lineNo: row.lineNo }, '该行不是合法 JSON（损坏行）'));
    else if (row.error && CHUNK_ROW_TYPES.has(row.value?.type)) violations.push(violation('R2', { lineNo: row.lineNo }, `chunk 行 "${row.value.type}" 损坏：${row.error.message}`));
  }

  // ── E · 信封 + seq（E3 词表判定**跳过**：词表随被检版本而变，本宿主没有该版本词表）──
  let expectedSeq = baseSeq;
  let seqBroken = false;
  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    violations.push(...envelopeViolations(event, loc, formatVersion).filter((v) => v.id !== 'E3'));
    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0) {
      if (event.seq !== expectedSeq) {
        violations.push(violation('E2', loc, `seq ${event.seq} 不连续：${event.seq < expectedSeq ? '倒退（backward）' : '缺口（gap）'}，期望 ${expectedSeq}`));
        seqBroken = true;
        expectedSeq = event.seq + 1;
      } else expectedSeq = event.seq + 1;
    }
  }
  violations.push(...physicalOrderViolations(rows));
  violations.push(...inboxReplayViolations(events, header));
  violations.push(...toolPairingViolations(events));
  violations.push(...toolResultStructureViolations(events));
  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    violations.push(...engineViolations(event, loc));
    violations.push(...pluginViolations(event, loc));
  }
  if (seqBroken) violations.push(violation('C1', { lineNo: null }, 'seq 缺口/倒退是多写入者并发写的典型后果（N6）'));

  violations.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1) || (a.lineNo ?? -1) - (b.lineNo ?? -1));
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byLayer = {};
  for (const v of violations) {
    bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
    byLayer[v.layer] = (byLayer[v.layer] ?? 0) + 1;
  }
  const result = {
    ok: false,                 // 不认证（**不是**"broken"——语义见 notAssessable.reason）
    assessable: false,
    structuralOk: bySeverity.error === 0,
    notAssessable,
    violations,
    summary: {
      total: violations.length,
      bySeverity,
      byLayer,
      events: events.length,
      surfaceNodes: null,
      replaceGeneration: null,
      frames: frameInfo?.frames ?? 0,
      compressedBytes: frameInfo?.compressedBytes ?? 0,
      plaintextBytes: frameInfo?.plaintextBytes ?? 0,
      fileVersion: formatVersion,
      hostMaxFileVersion: HOST_MAX_FILE_VERSION,
      assessable: false,
    },
    surface: null,
  };
  result.support = detectSupport({ header, events });
  result.probes = hostProbes();
  result.drift = driftOf(result.probes);
  result.migration = migrationVerdict(result);
  result.assessmentScope = result.migration.assessmentScope;
  return result;
}

/** 行为探针只跑一次（宿主在同一进程内不变）。 */
let probesMemo;
function hostProbes() {
  if (probesMemo === undefined) {
    try {
      probesMemo = runHostProbes();
    } catch (err) {
      probesMemo = { hostPackage: 'unknown', sessionFormatVersion: null, knownTypes: 0, verified: false, probes: [], unverifiedRules: ['<probe-run-failed>'], error: String(err?.message ?? err) };
    }
  }
  return probesMemo;
}

/**
 * R-D/R-F 合并出的**漂移报告**（`check` 抬头与 `--json` 共用）。
 *   · `unverifiedRules` —— 行为探针在本宿主上**不成立**的规则（宿主语义与规则假设不符）;
 *   · `driftedSources`  —— 出处停在 rc.7、未在 0.1.5 上复核（R-F，机读清单）;
 *   · `premiseStale`    —— 判定前提已不成立/无法判定（复核 §1）;
 *   · `fixApplyBlocked` —— 只要任一非空,就**不得据此跑 `fix --apply`**（R-E）。
 */
export function driftOf(probes) {
  const p = probes ?? hostProbes();
  const unverifiedRules = [...new Set(p.unverifiedRules ?? [])];
  const driftedSources = [...SOURCE_DRIFT.drifted];
  const premiseStale = [...SOURCE_DRIFT.premiseStale];
  return {
    probeVerified: p.verified === true,
    unverifiedRules,
    driftedSources,
    premiseStale,
    undecidable: [...SOURCE_DRIFT.undecidable],
    // `fix --apply` 的**硬前提**只看行为探针（宿主语义与规则假设不一致时才禁止写入类动作）;
    // 出处/前提清单（R-F）是**已知文档债**，会显式告警但不阻断修复流程 —— 否则只要历史
    // 清单非空,"修一个坏会话"这条主路径就永久不可用（见报告"我未照做之处"）。
    fixApplyBlocked: unverifiedRules.length > 0,
    note: SOURCE_DRIFT.note,
  };
}

/**
 * 迁移预检结论（S1）——**独立维度**：官方把 v0/v1/v2 升到当前格式会不会拒。
 *
 * 与 `ok` / `loadable` / `resumable` / `compactable` **并列且互不蕴含**：
 * 本工具判 ok **不代表**官方迁移会接受（反之亦然）。只统计 `layer === 'migration'` 的违规
 * （G1/G2），并**显式声明覆盖边界**——未覆盖的官方迁移规则不等于通过。
 *
 * @param {object} result `validateSessionLog()` 的返回值
 */
export function migrationVerdict(result) {
  const violations = result?.violations ?? [];
  const fileVersion = result?.summary?.fileVersion ?? result?.notAssessable?.fileVersion ?? null;
  const coverage = {
    implemented: [
      'G1  v0 源：subagent/descriptor.data.version !== 3',
      'G2  v0 源：事件类型不在官方 v0 dispositions 内（含 ignorable:true）',
      'G3  v0 源：session/title 系列 messageSeqs 必须引用更早的人类 user/message（含"空 ⟺ 用户标题"）',
    ],
    uncovered: [
      // 2026-09-15 第五轮：`turn/start` 试做后在**真实语料**上被判定为"应用对象错"——
      // 官方状态机（assertReleasedArtifactRelationships）由 v1→v2 在**变换后的 v1/v2 artifact**
      // 上调用（v1-to-v2/lib/index.js:104），带 cut/继承切点处理；在原始 v0 上照抄会在已 seed
      // 的会话上狂报（实测样本：0.1.5 链并不以该规则拒它，原始 v0 上会报 19 条）。
      // ⇒ 忠实复现需先做 v0→v1→v2 变换；本轮不做，保持未覆盖。
      'turn/start 闭合/预期轮（官方 v1→v2 在**变换后** artifact 上判：does not close the prior turn / does not open expected turn）',
      'assistant/attempt 配对/闭合（migration refuses the transformed artifact）',
      'Session inheritedEventCut / 继承切点（官方在变换后 artifact 上按 cut 判；header 只有 seedLength）',
      'stored log corrupt（SessionFormatError）',
      'v0→v1 对其余事件的形状拒绝',
      'turn/end 无匹配 open turn / open step 穿越 / 未解析 tool / open compaction 穿越（官方同一状态机的其余分支）',
    ],
    note: '未覆盖 ≠ 通过：本维度只对 implemented 三条负责。官方判据版本：@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 + v1-to-v2@0.1.5-rc.2',
  };
  if (result?.assessable === false) {
    return { assessable: false, applies: null, ready: null, fileVersion, blocked: [], coverage, assessmentScope: 'none', reason: result?.notAssessable?.reason ?? null };
  }
  const blocked = violations.filter((v) => v.layer === 'migration');
  if (fileVersion !== null && fileVersion === MIGRATION_TARGET_VERSION) {
    return { assessable: true, applies: false, ready: null, fileVersion, targetFileVersion: MIGRATION_TARGET_VERSION, blocked, coverage, assessmentScope: 'full', reason: `被检文件已是当前官方格式（version=${fileVersion}），无需迁移` };
  }
  const applies = fileVersion !== null && fileVersion < MIGRATION_TARGET_VERSION;
  return {
    assessable: true,
    applies,
    ready: applies ? blocked.length === 0 : null,
    fileVersion,
    targetFileVersion: MIGRATION_TARGET_VERSION,
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
    blocked,
    coverage,
    // 2026-09-14 第四轮（最终复核）：待迁移文件（applies=true）**只**被 2 条 G 规则覆盖，
    // 另有 6 类官方迁移规则未覆盖 ⇒ 评估范围只能是 "partial"。工具无法逐文件知道
    // 本文件是否命中未覆盖类（那要先把 6 类实现出来或跑官方迁移），但它**知道**这件事。
    assessmentScope: applies ? 'partial' : 'full',
  };
}

/**
 * 评估范围（S1 收窄后的机器可判字段）。
 * - `'partial'`：被检文件需要迁移（`migration.applies === true`）⇒ 迁移维度只覆盖 2 条规则，
 *   另有 6 类未覆盖；`ok`/`loadable`/`compactable` **不构成**"官方升级会接受"。
 * - `'full'`：被检文件已是当前官方格式（无需迁移）⇒ 迁移维度不适用，结构维度为全集。
 * - `'none'`：本宿主能力不足以评估该文件版本（S2 闸）⇒ 不给任何档位结论。
 * @param {object} result `validateSessionLog()` 的返回值
 * @returns {'full'|'partial'|'none'}
 */
export function assessmentScope(result) {
  return result?.migration?.assessmentScope
    ?? result?.assessmentScope
    ?? migrationVerdict(result).assessmentScope;
}

/**
 * resumeVerdict —— `check --resume` 三档结论（L3）。
 *
 * 回答用户「这个会话还能不能用」，三档蕴含（可压缩 ⊂ 可继续 ⊂ 可加载）：
 *   ✅ 可加载  loadable    —— 结构规则全绿（S1-S9/E 系列/W1/W2 等 error 级全清）
 *   ✅ 可继续  resumable   —— 结构绿 + I1（inbox 重放）绿
 *   ✅ 可压缩  compactable —— 前两档绿 + T1/T2（token-meter 配对）绿
 *
 * 纯聚合输出，不新增校验逻辑：直接复用 validateSessionLog 的 violations
 * 按规则 id 分组判定（2026-08-30 事故：离线 check 全绿但实机 token-meter 崩
 * 的教训——T1/T2 必须单独看，不能只看 error 总数）。
 *
 * @param {{ok: boolean, violations: Array, summary: object}} result validateSessionLog 的返回值
 * @returns {{
 *   verdict: 'loadable' | 'resumable' | 'compactable' | 'broken' | 'not-assessable',
 *   assessable: boolean,
 *   loadable: boolean, resumable: boolean, compactable: boolean,
 *   migration: object,
 *   blocking: { loadable: Array, resumable: Array, compactable: Array },
 * }}
 */
export function resumeVerdict(result) {
  const { ok, violations = [] } = result;
  // 宿主能力闸（S2）：本宿主评估不了 ⇒ 新档位 `not-assessable`（**不是** broken）。
  // 三档 loadable/resumable/compactable 一律 false（不认证），原因在 notAssessable.reason。
  if (result?.assessable === false) {
    return {
      verdict: 'not-assessable',
      assessable: false,
      loadable: false,
      resumable: false,
      compactable: false,
      notAssessable: result.notAssessable ?? null,
      migration: result.migration ?? migrationVerdict(result),
      blocking: { loadable: [], resumable: [], compactable: [] },
      violationsByTier: { structural: [], inbox: [], tokenMeter: [] },
    };
  }
  // 三档各自的「阻断规则集」——按 L3 档位定义：
  //   可加载：结构层（PERSISTENCE/FRAMING）+ 引擎层非 I1/T1/T2/T3/T4 的 error；
  //   可继续：+ I1（inbox 重放）；
  //   可压缩：+ T1/T2/T3/T4（token-meter 配对 + 渲染层节点 key/turn）。
  const byId = {};
  for (const v of violations) {
    if (v.severity !== 'error') continue;
    (byId[v.id] ??= []).push(v);
  }
  const has = (id) => (byId[id]?.length ?? 0) > 0;

  // 可加载阻断 = 除 I1/T1/T2/T3/T4 外的所有 error 违规（结构/信封/物理序/工具配对等）。
  // 注意：不能用 result.ok（它把 T1/T2/T3/T4/I1 也计为 error）——三档判定按 L3 定义，
  // T1/T2/T3/T4 只影响「可压缩」档、I1 只影响「可继续」档。
  const loadableBlockers = violations.filter(
    (v) => v.severity === 'error' && !['I1', 'T1', 'T2', 'T3', 'T4', 'T5'].includes(v.id),
  ).map((v) => v.id);
  const loadable = loadableBlockers.length === 0;

  const resumableBlockers = loadable ? (has('I1') ? ['I1'] : []) : [];
  const resumable = loadable && !has('I1');

  const compactableBlockers = resumable
    ? (has('T1') || has('T2') || has('T3') || has('T4') || has('T5') ? ['T1', 'T2', 'T3', 'T4', 'T5'].filter((id) => has(id)) : [])
    : [];
  const compactable = resumable && !has('T1') && !has('T2') && !has('T3') && !has('T4') && !has('T5');

  // 最差档位
  const verdict = !loadable ? 'broken' : !resumable ? 'loadable' : !compactable ? 'resumable' : 'compactable';

  return {
    verdict,
    assessable: true,
    loadable,
    resumable,
    compactable,
    migration: result.migration ?? migrationVerdict(result),
    blocking: {
      loadable: [...new Set(loadableBlockers)],
      resumable: resumableBlockers,
      compactable: compactableBlockers,
    },
    violationsByTier: {
      structural: [...new Set(loadableBlockers)],
      inbox: has('I1') ? ['I1'] : [],
      tokenMeter: has('T1') || has('T2') || has('T3') || has('T4') || has('T5') ? ['T1', 'T2', 'T3', 'T4', 'T5'].filter((id) => has(id)) : [],
    },
  };
}

export { ruleById };
