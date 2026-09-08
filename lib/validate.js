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
  ignorableTypeViolations,
  engineViolations,
  finalFold,
  inboxReplayViolations,
  isSafeInt,
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

  // ── Z3 · 空文件体检（2026-09-09 反向挑刺 T3 增量）──────────────────────────
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

  // ── S9 · 文件物理序 seq 单调（多写入者交织现场；E2 排序后检查看不到）──
  violations.push(...physicalOrderViolations(rows));

  // ── S · surface 增量重放（归因）+ 官方 foldSurface 终验 ────────────────
  const replay = replaySurface(events);
  violations.push(...replay.violations);

  const folded = finalFold(events.map((e) => e.event));

  // ── T · token meter 配对（事故根因 3 + 2026-08-30 两类刷屏）──
  violations.push(...tokenMeterViolations(events));
  violations.push(...tokenMeterSourceViolations(events));

  // ── T3/T4/T5 · 渲染/契约层（复盘 2026-09-02）：节点 key 唯一 + turn 缺失 + turn/end reason ──
  // 数据层"健康"≠ 客户端能渲染/能加载：check/官方加载/分页全绿仍可能白屏或加载失败。
  violations.push(...stepKeyViolations(events));
  violations.push(...nullTurnStepViolations(events));
  violations.push(...turnEndReasonViolations(events));

  // ── E7 · ignorable 未知 type 合法性（反向挑刺 T2）────────────────────
  violations.push(...ignorableTypeViolations(events));

  // ── I1 · inbox seed 相对重放（fork 边界孤儿；交接书 L1）──────────────
  violations.push(...inboxReplayViolations(events, header));

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
 *   verdict: 'loadable' | 'resumable' | 'compactable' | 'broken',
 *   loadable: boolean, resumable: boolean, compactable: boolean,
 *   blocking: { loadable: Array, resumable: Array, compactable: Array },
 * }}
 */
export function resumeVerdict(result) {
  const { ok, violations = [] } = result;
  // 三档各自的「阻断规则集」——按任务书 §L3 档位定义：
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
  // 注意：不能用 result.ok（它把 T1/T2/T3/T4/I1 也计为 error）——三档判定按任务书定义，
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
    loadable,
    resumable,
    compactable,
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
