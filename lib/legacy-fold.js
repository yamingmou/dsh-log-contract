/**
 * dsh-log-contract · lib/legacy-fold.js —— **v0/v1/v2 旧格式的 surface 终验器**
 *
 * 为什么需要这个文件（一手证据，2026-09-14）：
 *
 * 官方 `@deepseek-ai/dsh-session` 的 `foldSurface` 在 0.1.5-rc.1 里换成了 **v3 语义**，
 * 它**不是** rc.7（v0 语义）的超集，而是一个**不同格式**的校验器：
 * - replace 操作数字段改名：rc.7 `{op,start,end}` → 0.1.5 `{op,startSeq,endSeq}`
 *   （0.1.5 `lib/index.js:279`：`isReplaceOp` 要求 startSeq/endSeq ⇒ 旧 marker 直接
 *   “carries an invalid replace surfaceOp”）；
 * - provenance 收紧：0.1.5 `lib/index.js:285` 起对 `assistant/message` **一律**禁止
 *   `sourceEventSeqs`（“embeds its source stream and cannot carry sourceEventSeqs”）；
 *   rc.7 允许（空数组仅限 assistant/message）。
 *
 * App 2.0.9 的真实文件版本分布证明旧格式仍在线上：App 内置
 * `dsh-session-format-v0-to-v1` / `v1-to-v2` / `v2-to-v3` 三个迁移包，
 * `SESSION_FORMAT_VERSION = 3`；且 `v2-to-v3/lib/index.js:361-371` 明示 **v2 仍是
 * `{start,end}`**、由迁移改名为 `startSeq/endSeq`。
 *
 * ⇒ 结论：**用运行时的 v3 `foldSurface` 去终验 v0/v1/v2 文件必然误报**；旧格式必须用
 *   本文件这份等价实现（rc.7 `foldSurface` 的逐条移植，语义等价、同样 fail-loud）。
 *
 * 移植源：`@deepseek-ai/dsh-session@0.1.0-rc.7` `lib/index.js:229-455`
 * （`isSurfaceEligibleType` / `isEventSeq` / `isReplaceOp` / `surfaceOpOf` /
 * `assertProvenance` / `replacementRange` / `isDeepEqualJson` / `assertToolResultRewrite` /
 * `planSurfaceEvent` / `applySurfacePlan` / `foldSurface`）。
 *
 * 与官方相同的点：**抛错即拒绝**（官方加载期 `SessionPersistenceCorruptionError` 同源
 * 判据）；事件按 `index` 作为期望 seq（`baseSeq = 0`），与官方 `foldSurface(events)` 一致。
 */

/** v0/v1/v2 的 surface 候选类型（官方 rc.7 `SURFACE_EVENT_TYPES`，3 条）。 */
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/** Whether an event type can join the model-visible surface（rc.7 `isSurfaceEligibleType`）。 */
export function isLegacySurfaceEligibleType(type) {
  return SURFACE_EVENT_TYPES.has(type);
}

/** Whether a runtime value is a non-negative safe event sequence（rc.7 `isEventSeq`）。 */
function isEventSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a runtime value is the exact positional-replacement shape（rc.7 `isReplaceOp`：start/end）。 */
function isReplaceOp(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const op = value;
  return (
    Object.keys(op).length === 3 &&
    Object.hasOwn(op, 'op') && Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end') &&
    op.op === 'replace' && isEventSeq(op.start) && isEventSeq(op.end)
  );
}

/** Validate event-local surface eligibility and return its operation（rc.7 `surfaceOpOf`）。 */
function surfaceOpOf(event) {
  if (!SURFACE_EVENT_TYPES.has(event.type)) {
    if (event.surfaceOp !== undefined) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
    if (event.sourceEventSeqs !== undefined) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
    return undefined;
  }
  const op = event.surfaceOp;
  if (op === undefined) throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
  if (op === 'append') return op;
  if (op === null || typeof op !== 'object' || Array.isArray(op)) throw new Error(`session event "${event.type}" carries an invalid surfaceOp`);
  if (!isReplaceOp(op)) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
  return op;
}

/** Validate cited source-event seqs against prior log entries and the replacement range（rc.7 `assertProvenance`）。 */
function assertProvenance(event, shadowedSeqs) {
  const raw = event.sourceEventSeqs;
  const sources = new Set();
  if (raw !== undefined) {
    if (!Array.isArray(raw)) throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`);
    if (raw.length === 0 && event.type !== 'assistant/message') throw new Error('sourceEventSeqs must not be empty except on assistant/message');
    let nonEarlierSource;
    for (const source of raw) {
      if (!isEventSeq(source)) throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`);
      sources.add(source);
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source;
    }
    if (sources.size !== raw.length) throw new Error('sourceEventSeqs must not contain duplicates');
    if (nonEarlierSource !== undefined) throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`);
  }
  const missing = shadowedSeqs.filter((seq) => !sources.has(seq));
  if (missing.length > 0) throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
}

/** Locate one replacement range without mutating the current fold state（rc.7 `replacementRange`）。 */
function replacementRange(state, op) {
  const startIdx = state.nodes.indexOf(op.start);
  if (startIdx === -1) throw new Error(`surface replace: start seq ${op.start} not found in surface`);
  const endIdx = state.nodes.indexOf(op.end);
  if (endIdx === -1) throw new Error(`surface replace: end seq ${op.end} not found in surface`);
  if (startIdx > endIdx) throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`);
  return { startIdx, endIdx, shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1) };
}

/** Deep structural equality over the session-event JSON value domain（rc.7 `isDeepEqualJson`）。 */
function isDeepEqualJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => isDeepEqualJson(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualJson(a[key], b[key]));
}

/** Restrict a tool-result replacement to one current result's content（rc.7 `assertToolResultRewrite`）。 */
function assertToolResultRewrite(event, shadowedSeqs, events, baseSeq) {
  if (event.type !== 'tool/result') return;
  if (shadowedSeqs.length !== 1) throw new Error('tool/result surface replacement must rewrite exactly one current node');
  for (const originalSeq of shadowedSeqs) {
    const original = events[originalSeq - baseSeq];
    if (original?.type !== 'tool/result') throw new Error('tool/result surface replacement must target a current tool/result');
    const originalRest = { ...original.data };
    const replacementRest = { ...event.data };
    const originalResult = original.data.message.content[0];
    const replacementResult = event.data.message.content[0];
    originalRest.message = { ...original.data.message, content: [{ ...originalResult, content: null }] };
    replacementRest.message = { ...event.data.message, content: [{ ...replacementResult, content: null }] };
    if (!isDeepEqualJson(originalRest, replacementRest)) throw new Error('tool/result surface replacement may change only content');
  }
}

/** Validate one event at its replay boundary and prepare its atomic fold transition（rc.7 `planSurfaceEvent`）。 */
function planSurfaceEvent(state, event, expectedSeq, events, baseSeq) {
  if (event.seq !== expectedSeq) throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`);
  const surfaceOp = surfaceOpOf(event);
  if (surfaceOp === undefined) return undefined;
  if (surfaceOp === 'append') {
    assertProvenance(event, []);
    return { kind: 'append', seq: event.seq };
  }
  const range = replacementRange(state, surfaceOp);
  assertProvenance(event, range.shadowedSeqs);
  assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);
  return { kind: 'replace', seq: event.seq, start: surfaceOp.start, end: surfaceOp.end, ...range };
}

/** Commit one previously validated surface transition（rc.7 `applySurfacePlan`）。 */
function applySurfacePlan(state, plan) {
  if (plan?.kind === 'append') state.nodes.push(plan.seq);
  else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
    state.replaceGeneration += 1;
  }
  if (plan?.kind !== 'replace') return undefined;
  return { seq: plan.seq, start: plan.start, end: plan.end, shadowedSeqs: plan.shadowedSeqs };
}

/** Apply one event and return replacement metadata only when one occurred（rc.7 `applySurfaceEvent`）。 */
function applySurfaceEvent(state, event, expectedSeq, events, baseSeq) {
  return applySurfacePlan(state, planSurfaceEvent(state, event, expectedSeq, events, baseSeq));
}

/**
 * Replay a complete session log through the **v0/v1/v2** canonical surface fold.
 *
 * @param events - session events in contiguous seq order（seq 从 0 起，与官方 `foldSurface` 同约定）。
 * @returns {{ nodes: number[], replacements: Array<{seq:number,start:number,end:number,shadowedSeqs:number[]}> }}
 * @throws when an event violates surface metadata, source-event references, range, or tool-result rewrite rules.
 */
export function legacyFoldSurface(events) {
  const state = { nodes: [], replaceGeneration: 0 };
  const replacements = [];
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(state, event, index, events, 0);
    if (replacement !== undefined) replacements.push(replacement);
  }
  return { nodes: [...state.nodes], replacements };
}
