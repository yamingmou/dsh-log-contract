/**
 * dsh-log-contract · lib/prewrite.js
 *
 * ★ 写前校验（pre-write validation）——本工具的第一公民。
 *
 * 复盘事故（2026-08-25）第 1 轮失败就是"违约写入没被拦"：surface-replace
 * 的 `sourceEventSeqs` 被清空后写入，会话加载直接抛
 * `SessionPersistenceCorruptionError`。如果写入前先校验，会话根本不会被改坏。
 *
 * 本模块把"三层契约"（持久化 / 客户端引擎 / 插件语义）固化为可执行检查：
 * - `createPreWriter({ events }).validateAppend(candidate)` —— 追加写入前校验：
 *   拟写事件在进入日志之前，先与当前日志的折叠状态比对（官方 append 的
 *   SurfaceManager.validateNext 同思路：validate first, commit later）。
 * - `createPreWriter({ events }).validateEdit(editedEvents)` —— 帧级手术校验：
 *   修改后的完整事件列表端到端重放（安全修复协议第 2 步"改后确认"）。
 *
 * 所有判定复用 `lib/checks.js`（与离线体检同一套逻辑），
 * 保证"体检看到的问题 = 写入前拦下的问题"。
 */
import { envelopeViolations, engineViolations, finalFold, isSafeInt, pluginViolations, replaySurface, violation } from './checks.js';

/** 把一个"拟写事件"规整为带 seq 的事件；seq 未携带时按追加位置赋值。 */
function normalizeCandidate(candidate, nextSeq) {
  return candidate.seq === undefined ? { ...candidate, seq: nextSeq } : candidate;
}

/**
 * 基于当前日志事件列表建立写前校验器。
 *
 * @param {{ events: Array<object>, baseSeq?: number }} input 当前日志的已解码事件
 *   （按日志顺序；无 seq 字段的事件按位置补 seq，用于窗口校验）。
 * @returns {{
 *   events: Array, nextSeq: number,
 *   validateAppend(candidate, opts?): { ok, violations, stateAfter },
 *   validateEdit(editedEvents, opts?): { ok, violations, stateAfter },
 * }}
 */
export function createPreWriter(input = {}) {
  const { baseSeq = 0 } = input;
  let events = [...input.events];
  // 窗口校验支持"无 seq 的原始事件列表"：按位置补齐 seq 与 time。
  let nextSeq = baseSeq;
  events = events.map((e) => {
    const normalized = e.seq === undefined ? { ...e, seq: nextSeq } : e;
    nextSeq = Math.max(nextSeq, normalized.seq + 1);
    return normalized;
  });

  const runChecks = (candidateEvents, tailHint) => {
    const violations = [];
    // E2 —— 全列表 seq 严格连续（含拟写事件）；tailHint 时给 append-only 语境
    let expected = baseSeq;
    for (let i = 0; i < candidateEvents.length; i++) {
      const event = candidateEvents[i];
      if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0) {
        if (event.seq !== expected) {
          const kind = event.seq < expected ? '倒退（backward）' : '缺口（gap）';
          const tail = tailHint !== undefined && i === candidateEvents.length - 1 ? ' —— 只能追加到日志尾部（append-only，N6）' : '';
          violations.push(violation('E2', { seq: event.seq, eventType: event.type }, `seq ${event.seq} 不连续：${kind}，期望 ${expected}${tail}`));
          expected = event.seq + 1;
        } else {
          expected = event.seq + 1;
        }
      }
    }
    // E1/E3/E4/E5/E6 + M1 + P1/P2 —— 逐事件
    for (const event of candidateEvents) {
      const loc = { seq: event.seq, lineNo: null, eventType: event.type };
      violations.push(...envelopeViolations(event, loc));
      violations.push(...engineViolations(event, loc));
      violations.push(...pluginViolations(event, loc));
    }
    // S1–S7 —— 与官方同语义的增量重放（含拟写事件）
    const replay = replaySurface(candidateEvents.map((event) => ({ event })));
    violations.push(...replay.violations);
    // S8 —— 官方 foldSurface 终验
    const folded = finalFold(candidateEvents);
    if (folded.error) {
      violations.push(violation('S8', { lineNo: null }, `官方 foldSurface 重放失败：${folded.error.message} —— 会话加载会被拒（SessionPersistenceCorruptionError）`));
    }
    const bySeverity = { error: 0, warning: 0, info: 0 };
    for (const v of violations) bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
    return {
      ok: bySeverity.error === 0,
      violations,
      bySeverity,
      surface: folded.surface ?? { nodes: replay.nodes, replacements: [] },
      nextSeq: candidateEvents.length ? candidateEvents[candidateEvents.length - 1].seq + 1 : baseSeq,
    };
  };

  return {
    events,
    get nextSeq() {
      return nextSeq;
    },

    /**
     * 追加写入前校验：candidate 将以 nextSeq 进入日志。
     * candidate 可携带 seq（必须等于 nextSeq）或不携带（自动赋 nextSeq）。
     */
    validateAppend(candidate, opts = {}) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        return {
          ok: false,
          violations: [violation('E1', {}, '拟写事件必须是普通对象（会话事件信封）')],
          bySeverity: { error: 1, warning: 0, info: 0 },
          surface: null,
          nextSeq,
        };
      }
      const normalized = normalizeCandidate(candidate, nextSeq);
      const after = [...events, normalized];
      const result = runChecks(after, nextSeq);      result.stateAfter = {
        events: after,
        nextSeq: result.nextSeq,
        surfaceNodes: result.surface?.nodes ?? [],
      };
      return result;
    },

    /**
     * 帧级手术校验：editedEvents 是"写入后将存在的完整事件列表"。
     * 用于安全修复协议第 2 步（改后确认）：必须与"改前基线
     * （validateSessionLog 通过）"双绿才允许落盘。
     */
    validateEdit(editedEvents) {
      if (!Array.isArray(editedEvents)) {
        return {
          ok: false,
          violations: [violation('E1', {}, 'editedEvents 必须是事件数组')],
          bySeverity: { error: 1, warning: 0, info: 0 },
          surface: null,
          nextSeq,
        };
      }
      const result = runChecks(editedEvents, undefined);
      result.stateAfter = {
        events: editedEvents,
        nextSeq: result.nextSeq,
        surfaceNodes: result.surface?.nodes ?? [],
      };
      return result;
    },
  };
}

/**
 * 一站式便利：加载会话日志 → 建立写前校验器。
 * @param {import('./log-reader.js').loadSessionLog} log `loadSessionLog()` 结果
 */
export function preWriterFromLog(log) {
  const events = (log.events ?? []).map((e) => e.event);
  return createPreWriter({ events });
}
