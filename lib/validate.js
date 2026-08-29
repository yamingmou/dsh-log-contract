/**
 * dsh-log-contract · lib/validate.js
 *
 * 离线体检引擎：对 `loadSessionLog` 的结果逐条跑契约规则，产出违规报告。
 *
 * 判定哲学（复盘事故 §四-1）：**持久化层以官方 `foldSurface` 不抛为通过**，
 * 但为定位问题，先用与官方同语义的增量重放做逐事件归因（S1–S7），
 * 再跑官方 foldSurface 作终验（S8）——两套都绿才算过。
 */
import { ruleById } from './contracts.js';
import {
  CHUNK_ROW_TYPES,
  envelopeViolations,
  engineViolations,
  finalFold,
  isSafeInt,
  pluginViolations,
  replaySurface,
  violation,
  tokenMeterViolations,
  toolPairingViolations,
  toolResultStructureViolations,
  wireViolations,
} from './checks.js';

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
  const { header, headerLine, rows, events, frameInfo } = log;

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
    if (header.version !== 0) {
      violations.push(violation('H2', { lineNo: headerLine }, `header.version 必须为 0（实际 ${String(header.version)}）——格式版本演进无迁移机制（F1）`));
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
    violations.push(...envelopeViolations(event, loc));
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

  // ── S · surface 增量重放（归因）+ 官方 foldSurface 终验 ────────────────
  const replay = replaySurface(events);
  violations.push(...replay.violations);

  const folded = finalFold(events.map((e) => e.event));

  // ── T · token meter 配对（事故根因 3）──
  violations.push(...tokenMeterViolations(events));

  // ── P3/P4 · 考古契约（工具配对 + 输出结构）──
  violations.push(...toolPairingViolations(events));
  violations.push(...toolResultStructureViolations(events));
  if (folded.error) {
    violations.push(violation('S8', { lineNo: null }, `官方 foldSurface 重放失败：${folded.error.message} —— 会话加载会被拒（SessionPersistenceCorruptionError）`));
  }

  // ── W · wire 消息流（严格端点拒绝的悬空 tool / 顺序破坏）──────────────
  violations.push(...wireViolations(events));

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
  };

  return {
    ok: bySeverity.error === 0,
    violations,
    summary,
    surface: folded.surface ?? { nodes: replay.nodes, replacements: [] },
  };
}

export { ruleById };
