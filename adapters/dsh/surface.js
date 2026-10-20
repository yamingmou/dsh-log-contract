/**
 * dsh-log-contract · adapters/dsh/surface.js
 *
 * DSH 专属：模型可见面（surface）的推导与改写语义。
 *
 * 契约层的不变量是「视图必须可重放、改写必须完整覆盖被遮蔽节点、改写必须单节点内容级、
 * 引用必须闭合且同作用域、视图节点键唯一」；DSH 的 replace 操作数形状、遮蔽集合、
 * 按文件版本的折叠择路、载体两段配对、wire 请求序列与 token 计量配对全部落在本文件。
 *
 * 客户端投影缓存（projcache）是渲染层缓存，不是落盘判定对象：本包不为它造判定，
 * 仅在适配器元数据里登记其归属（见 ADAPTER.projcache）。
 */
import { violation } from './rule-ids.js';
import { isSafeInt } from '../../contract/invariants.js';
import {
  SURFACE_TYPES,
  MODERN_SURFACE_TYPES,
  V4_SURFACE_TYPES,
  currentSurfaceTypes,
  MARKER_PREFIXES,
} from './vocab.js';
import { currentVocabulary } from './format-versions.js';

// ── v0/v1/v2 旧格式的视图终验（运行时折叠是 v3 语义，旧格式必须用等价实现）──────
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

/** Whether a runtime value is the exact positional-replacement shape（rc.7 `isLegacyReplaceOpShape`：start/end）。 */
function isLegacyReplaceOpShape(value) {
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
  if (!isLegacyReplaceOpShape(op)) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
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

// ── 视图改写与引擎/插件/wire 语义 ────────────────────────────────────────────
/** replace 操作数精确形状（镜像旧格式 isReplaceOp，lib/index.js:[n]-[n]）。 */
export function isReplaceOp(op) {
  return (
    typeof op === 'object' && op !== null &&
    Object.keys(op).length === 3 &&
    Object.hasOwn(op, 'op') && Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end') &&
    op.op === 'replace' && isSafeInt(op.start) && isSafeInt(op.end)
  );
}

/**
 * 按**被检文件版本**归一化 replace 操作数到内部 `{start,end}`。
 *
 * 一手依据：官方 replace 字段在 v3 改名——旧格式（v0/v1/v2）`{op,start,end}`，
 * v3 `{op,startSeq,endSeq}`（`dsh-session-format-v2-to-v3/lib/index.js:[n]-[n]`）。
 * 用错形状会得 null，由调用方归因为 S4（真实违规）。
 *
 * @param {unknown} op 待归一化的 surfaceOp
 * @returns {{start:number,end:number}|null}
 */
export function normalizeReplaceOp(op, version) {
  if (typeof op !== 'object' || op === null || Array.isArray(op)) return null;
  if (Object.keys(op).length !== 3 || op.op !== 'replace') return null;
  if (version >= 3) {
    return Object.hasOwn(op, 'startSeq') && Object.hasOwn(op, 'endSeq') && isSafeInt(op.startSeq) && isSafeInt(op.endSeq)
      ? { start: op.startSeq, end: op.endSeq }
      : null;
  }
  return Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end') && isSafeInt(op.start) && isSafeInt(op.end)
    ? { start: op.start, end: op.end }
    : null;
}

/**
 * 与官方同语义的 surface 增量重放，逐事件归因 S1–S7。
 * @param {Array<{event:object, lineNo?:number}>} events 按日志顺序的事件（带 loc 包装）
 */
export function replaySurface(events, version) {
  const violations = [];
  const nodes = [];
  let replaceGeneration = 0;

  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    const eligible = currentSurfaceTypes(version).has(event.type);
    const op = event.surfaceOp;
    const src = event.sourceEventSeqs;

    if (!eligible) {
      if (op !== undefined || src !== undefined) {
        // 宿主 `@deepseek-ai/dsh-session@0.1.5-rc.1` 对该形状是**刻意容忍**的:
        //   lib/index.js:[n] `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return;`
        //   同一函数的契约注释 lib/index.js:[n] —— "Unknown ignorable records retain opaque
        //   metadata and never change the surface."
        // ⇒ **未知**类型且 `ignorable===true` 的事件带 surfaceOp/sourceEventSeqs 是合法的不透明
        //   元数据（宿主接受，不报 S2）。
        //   "该未知类型有没有消费者"由 E7 以 **warning** 表达（策略层，非宿主契约）。
        const unknownIgnorable = !currentVocabulary(version).has(event.type) && event.ignorable === true;
        if (!unknownIgnorable) {
          violations.push(violation('S2', loc, `非 surface 类型 "${event.type}" 不得携带 surfaceOp/sourceEventSeqs`));
        }
      }
      continue;
    }
    if (op === undefined) {
      violations.push(violation('S1', loc, `surface 候选类型 "${event.type}" 必须携带 surfaceOp 标记`));
      continue;
    }

    if (op === 'append') {
      violations.push(...provenanceViolations(event, loc, []));
      nodes.push(event.seq);
      continue;
    }

    const normalized = normalizeReplaceOp(op, version);
    if (normalized === null) {
      violations.push(violation('S4', loc, 'replace 操作数必须精确为 {op:"replace", start, end}（v0/v1/v2）或 {op:"replace", startSeq, endSeq}（v3），且端点为非负安全整数'));
      continue;
    }
    const startIdx = nodes.indexOf(normalized.start);
    const endIdx = nodes.indexOf(normalized.end);
    if (startIdx === -1 || endIdx === -1) {
      violations.push(violation('S4', loc, `replace 范围 ${normalized.start}..${normalized.end} 不在当前 surface 中（start 存在=${startIdx !== -1}，end 存在=${endIdx !== -1}）`));
      continue;
    }
    if (startIdx > endIdx) {
      violations.push(violation('S4', loc, `replace start ${normalized.start}（index ${startIdx}）在 end ${normalized.end}（index ${endIdx}）之后`));
      continue;
    }
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
    violations.push(...provenanceViolations(event, loc, shadowedSeqs));
    violations.push(...toolResultRewriteViolations(event, loc, shadowedSeqs));
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
    replaceGeneration += 1;
  }

  return { violations, nodes, replaceGeneration };
}

/** 镜像官方 assertProvenance（lib/index.js:[n]-[n]）。 */
export function provenanceViolations(event, loc, shadowedSeqs) {
  const out = [];
  const raw = event.sourceEventSeqs;
  const sources = new Set();
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      out.push(violation('S6', loc, `sourceEventSeqs 必须为数组（实际 ${typeof raw}）`));
      return out;
    }
    if (raw.length === 0 && event.type !== 'assistant/message') {
      out.push(violation('S6', loc, 'sourceEventSeqs 不得为空（除 assistant/message 外）'));
    }
    let nonEarlier;
    for (const source of raw) {
      if (!isSafeInt(source)) {
        out.push(violation('S6', loc, `sourceEventSeqs 必须稠密包含非负安全整数（非法值 ${String(source)}）`));
        continue;
      }
      if (sources.has(source)) {
        out.push(violation('S6', loc, `sourceEventSeqs 不得重复（${source}）`));
      }
      sources.add(source);
      if (nonEarlier === undefined && source >= event.seq) nonEarlier = source;
    }
    if (nonEarlier !== undefined) {
      out.push(violation('S6', loc, `sourceEventSeqs 必须引用更早事件：${nonEarlier} >= 当前 seq ${event.seq}`));
    }
  }
  const missing = shadowedSeqs.filter((seq) => !sources.has(seq));
  if (missing.length > 0) {
    out.push(violation('S5', loc, `surface replace: sourceEventSeqs 必须覆盖每个被替换节点；缺失 ${missing.join(', ')}（共 ${missing.length} 个）`, { missingSeqs: missing }));
  }
  return out;
}

/** 镜像官方 assertToolResultRewrite（lib/index.js:[n]-[n]）的判定核心。 */
export function toolResultRewriteViolations(event, loc, shadowedSeqs) {
  if (event.type !== 'tool/result') return [];
  const out = [];
  if (shadowedSeqs.length !== 1) {
    out.push(violation('S7', loc, `tool/result 替换必须恰好重写 1 个当前节点（实际 ${shadowedSeqs.length} 个）`));
  }
  return out;
}

/** M1 —— 客户端引擎层：turn/step 缺失（null）的 assistant/message 只能 replace。 */
export function engineViolations(event, loc) {
  const out = [];
  if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
    // turn/step 位于 event.data 层（正常消息 data.turn/data.step 为数字，
    // 插件 marker data.turn/data.step 为 null）
    const turn = event.data?.turn;
    const step = event.data?.step;
    if (turn == null || step == null) {
      out.push(violation('M1', loc, `assistant/message 以 append 进入 surface 但 data.turn/data.step 缺失（turn=${String(turn)}, step=${String(step)}）——只能以 replace 承载（插件 marker 定义），append 会触发客户端引擎崩溃（rt.js:[n]）`));
    }
  }
  return out;
}

/** P 层 —— 插件 marker 语义（retrace 等以 assistant/message replace 承载的 marker）。 */
export function pluginViolations(event, loc) {
  const out = [];
  const isMarkerReplace = event.type === 'assistant/message' && event.surfaceOp && event.surfaceOp !== 'append' && event.data?.editor !== undefined;
  if (!isMarkerReplace) return out;
  const id = event.data?.message?.id;
  const known = typeof id === 'string' && MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`));
  if (!known) {
    out.push(violation('P1', loc, `marker id "${String(id)}" 前缀不在已知列表（${MARKER_PREFIXES.join('/')}-）——改名后未登记遗留前缀，旧 marker 隐藏语义将断裂（软兼容丢失）`));
  }
  const src = event.sourceEventSeqs;
  if (Array.isArray(src) && src.includes(event.seq)) {
    out.push(violation('P2', loc, `marker 自身 seq ${event.seq} 出现在自身 sourceEventSeqs（shadowed 集）——自指语义错误（marker 节点被隐藏逻辑跳过，不应被自己隐藏）`));
  }
  return out;
}

/**
 * T3 —— step 节点 key 冲突。
 *
 * 客户端渲染消息列表 = 从事件流构建节点，节点 key = `data.turn:data.step`
 * （React 列表 key）。同 turn 内两个 step/start 的 step 号相同 → key 冲突 →
 * React 渲染死循环 → 空白渲染（正常轮与编辑块复用同一 step 号即可触发；
 * 同类冲突可成批出现在同一日志，修复方式为整块重编号）。
 *
 * 判定：扫 step/start，`data.turn:data.step` 组合重复 = error。
 * - 无任何 step/start 的日志跳过（与 T1 同款宽松）；
 * - turn/step 为 null/undefined 的 step/start 不参与 key 判定（那是 T4 的域，
 *   且 null 自身已是致命）。
 *
 * @param events - 行序事件流（`{event, lineNo}`）。
 * @returns T3 违规列表。
 */
export function stepKeyViolations(events) {
  const out = []
  if (!events.some(({ event }) => event.type === 'step/start')) return out
  const seen = new Map() // `${turn}:${step}` → { seq, lineNo }
  for (const { event, lineNo } of events) {
    if (event.type !== 'step/start') continue
    const turn = event.data?.turn
    const step = event.data?.step
    if (turn === null || turn === undefined || step === null || step === undefined) continue // T4 域
    const key = `${String(turn)}:${String(step)}`
    const prev = seen.get(key)
    if (prev !== undefined) {
      out.push(violation('T3', { seq: event.seq, lineNo, eventType: event.type }, `step 节点 key ${key} 冲突：seq ${prev.seq} 与 seq ${event.seq} 的 step/start 同 turn 同 step——客户端 React 渲染死循环空白渲染（渲染层失败；修复：同 turn 内 step 递增，不得复用；整块重编号）`))
    } else {
      seen.set(key, { seq: event.seq, lineNo })
    }
  }
  return out
}

/**
 * T4 —— step/消息本体 turn 缺失（null/undefined）。
 *
 * 客户端渲染状态机对 turn=null 的 step/消息**无法归属任何 turn** → 渲染死循环 →
 * 空白渲染「载入历史」（编辑块的 step/start+marker+step/end turn 全 null 即触发；
 * step 包裹/消息本体的 null-turn 判为致命）。
 *
 * 判定：`step/start|step/end|assistant/message` 的 `data.turn === null/undefined` = error。
 * - user/message 天然不带 turn（坐标来自外层 step），不查；
 * - assistant/chunk 坐标可能天然缺失，不查；
 * - retrace/marker（neutralize 产物，ignorable）不查。
 *
 * @param events - 行序事件流（`{event, lineNo}`）。
 * @returns T4 违规列表。
 */
export function nullTurnStepViolations(events) {
  const out = []
  for (const { event, lineNo } of events) {
    if (event.type !== 'step/start' && event.type !== 'step/end' && event.type !== 'assistant/message') continue
    const turn = event.data?.turn
    if (turn === null || turn === undefined) {
      out.push(violation('T4', { seq: event.seq, lineNo, eventType: event.type }, `${event.type} 的 data.turn 为 ${String(turn)}（缺失）——客户端渲染状态机无法归属任何 turn → 渲染死循环空白渲染（step/消息本体必须带真实 turn 号）`))
    }
  }
  return out
}

/**
 * T5 —— turn/end 缺 reason.kind（malformed turn/end）。
 *
 * 官方 agent-loop 写 turn/end 恒带 `reason: { kind }`（dsh-agent-loop/lib/index.js:[n]；
 * kind ∈ completed|max-tokens|blocked|aborted|error|interrupted，中断恢复补
 * interrupted，见 dsh-session interruptedTurnClosers）。官方 validation 强制
 * reason.kind 存在——缺失 = malformed → 会话加载失败
 * （SessionPersistenceCorruptionError "malformed pre-react-loop turn/end"）。
 *
 * 判定：turn/end 的 `data.reason?.kind` 缺失/非字符串 = error。
 *
 * @param events - 行序事件流（`{event, lineNo}`）。
 * @returns T5 违规列表。
 */
export function turnEndReasonViolations(events) {
  const out = []
  for (const { event, lineNo } of events) {
    if (event.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (!reason || typeof reason.kind !== 'string') {
      out.push(violation('T5', { seq: event.seq, lineNo, eventType: event.type }, `turn/end 缺 data.reason.kind（reason=${JSON.stringify(reason)}）——官方 validation 拒绝 → 会话加载失败（malformed turn/end；turn/end 必须带 reason.kind，镜像 dsh-agent-loop:[n]）`))
    }
  }
  return out
}

/**
 * T1 —— token-meter 配对（复刻 @deepseek-ai/dsh-token-meter 的 _foldEvent 状态机）：
 * - `step/start` 打开一个 step（记录 turn/step）；
 * - `step/end` 必须匹配当前打开的 step/start，否则抛错；
 * - `assistant/message` 必须匹配当前打开的 step/start（turn/step 完全一致），否则抛错；
 * - `user/message` / `tool/result` 不检查（token meter 不配对）。
 *
 * 违反 = token meter 折叠抛错 → 该会话 `/compact` 与压力测量永久失败。
 * 已知命中：retrace 的 turn/step=null 编辑/撤回 marker（空 assistant/message replace）——
 * foldSurface 认可其合法性（M1 只约束 append 形态），但 token meter 崩溃。这是
 * M1 规则的盲区：M1 没约束"replace 也必须过 token meter"。
 *
 * @param events - 行序事件流（`{event, lineNo}`）。
 * @returns T1 违规列表。
 */
export function tokenMeterViolations(events) {
  const out = [];
  // 无任何 step/start 的日志：现代 DSH 每个 assistant 回合必有 step/start，
  // 完全没有说明是极早期格式或简化日志——token-meter 的 step 配对兼容性未
  // 定义，不做配对检查（避免对旧结构误报；现代会话均有 step/start）。
  if (!events.some(({ event }) => event.type === 'step/start')) return out;
  let stepStart = undefined;
  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    if (event.type === 'step/start') {
      if (stepStart !== undefined) {
        out.push(violation('T1', loc, `step/start at seq ${event.seq} arrived before turn ${stepStart.turn}/step ${stepStart.step} ended——token meter 折叠会抛错`));
      }
      stepStart = { turn: event.data?.turn, step: event.data?.step };
    } else if (event.type === 'step/end') {
      if (stepStart === undefined || stepStart.turn !== event.data?.turn || stepStart.step !== event.data?.step) {
        out.push(violation('T1', loc, `step/end at seq ${event.seq} has no matching step/start event（turn=${String(event.data?.turn)}, step=${String(event.data?.step)}）——token meter 折叠会抛错`));
      }
      stepStart = undefined;
    } else if (event.type === 'assistant/message') {
      const turn = event.data?.turn;
      const step = event.data?.step;
      if (stepStart === undefined || stepStart.turn !== turn || stepStart.step !== step) {
        const open = stepStart === undefined ? '无打开的 step' : `打开的 step 为 turn ${stepStart.turn}/step ${stepStart.step}`;
        out.push(violation('T1', loc, `assistant/message at seq ${event.seq} has no matching step/start event（turn=${String(turn)}, step=${String(step)}；${open}）——token meter 折叠会抛错，/compact 与压力测量永久失败（retrace 的 turn-null 编辑/撤回 marker 即命中此条）`));
      }
    }
  }
  return out;
}

/**
 * T2 —— token-meter 的 sourceEventSeqs 引用必须同 turn/step。
 *
 * 镜像官方 `_estimateProviderAssistant`（dsh-token-meter lib/index.js:[n]-[n]）：
 * `assistant/message` 的每个 `sourceEventSeqs` 若指向 `assistant/chunk`，其
 * turn/step 必须与消息自身一致；跨 step 引用 → 官方抛
 * `token meter: assistant/message at seq N source seq M belongs to another step`
 * （lib/index.js:[n]）。
 *
 * 成因：DSH resend/regenerate 在 agent 仍开着 step 时被触发，会把旧 step 的
 * chunk 全部引用进新 assistant/message（chunk 源引用跨 step）→
 * 离线 check（T1）全绿但实机 token-meter 崩溃 → 同样刷屏压垮 host。
 *
 * @param events - 行序事件流（`{event, lineNo}`）。
 * @returns T2 违规列表（error 级，token-meter 实机必崩）。
 */
export function tokenMeterSourceViolations(events) {
  const out = [];
  const bySeq = new Map();
  for (const { event, lineNo } of events) bySeq.set(event.seq, { event, lineNo });
  for (const { event, lineNo } of events) {
    if (event.type !== 'assistant/message' || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) continue;
    const turn = event.data?.turn;
    const step = event.data?.step;
    if (turn == null || step == null) continue; // turn-null marker 由 T1 覆盖
    if (event.data?.usage === void 0) continue; // 无 usage 不触发 _estimateProviderAssistant（官方 :[n] 前提）——replace marker（S5 遮蔽语义，sourceEventSeqs 含非 chunk 节点）合法
    const seen = new Set();
    for (const s of event.sourceEventSeqs) {
      if (s >= event.seq) {
        out.push(violation('T2', { seq: event.seq, lineNo, eventType: event.type }, `assistant/message at seq ${event.seq} source seq ${s} is not earlier——token meter 折叠会抛错（_estimateProviderAssistant）`));
        break;
      }
      if (seen.has(s)) {
        out.push(violation('T2', { seq: event.seq, lineNo, eventType: event.type }, `assistant/message at seq ${event.seq} repeats source seq ${s}——token meter 折叠会抛错`));
        break;
      }
      seen.add(s);
      const src = bySeq.get(s);
      if (!src || src.event.type !== 'assistant/chunk') {
        out.push(violation('T2', { seq: event.seq, lineNo, eventType: event.type }, `assistant/message at seq ${event.seq} source seq ${s} is not assistant/chunk（实际 ${src ? src.event.type : 'MISSING'}）——token meter 折叠会抛错（_estimateProviderAssistant :[n] 对非 chunk 引用直接 throw），/compact 与压力测量永久失败`));
        break; // 官方抛一次即停（consumedEvents 不前进），只报首条
      }
      if (src.event.data?.turn !== turn || src.event.data?.step !== step) {
        out.push(violation('T2', { seq: event.seq, lineNo, eventType: event.type }, `assistant/message at seq ${event.seq} source seq ${s} belongs to another step（消息 turn ${turn}/step ${step}，源 turn ${String(src.event.data?.turn)}/step ${String(src.event.data?.step)}）——token meter 折叠会抛错，/compact 与压力测量永久失败（DSH resend 在 step 未关时跨 step 引用）`));
        break; // 官方抛一次即停（consumedEvents 不前进），只报首条
      }
    }
  }
  return out;
}

/**
 * I1 —— inbox seed 相对重放（交接书 L1；镜像 dsh-agent lib/types/inbox.js）。
 *
 * 复刻官方 Inbox：从 `header.seedLength` 起重放 `agent/inbox/spliced`，
 * next-turn/next-step 双队列；每条 splice 校验
 * `start + removedCount <= 队列长` 且不产生重复 message id。违反 =
 * `resume failed: invalid persisted inbox splice at seq N`（fork 边界孤儿：
 * fork 时"移除父待处理提示词"的 removedCount=1 在子会话 seed 相对空 inbox 上非法）。
 *
 * @param events - 行序事件流（`{event, lineNo}`）。
 * @param header - 日志 header（取 seedLength）。
 * @returns I1 违规列表（error 级，resume 会被拒）。
 */
export function inboxReplayViolations(events, header) {
  const out = [];
  const seedLength = header?.seedLength;
  if (typeof seedLength !== 'number' || !Number.isSafeInteger(seedLength) || seedLength < 0) {
    // 无 seedLength（非 fork 会话）→ Inbox 从 0 重放，语义等同全量；仍做队列校验
  }
  const state = { 'next-turn': [], 'next-step': [] };
  const startSeq = seedLength ?? 0;
  for (const { event, lineNo } of events) {
    if (event.seq < startSeq) continue;
    if (event.type !== 'agent/inbox/spliced') continue;
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    const splice = event.data;
    if (!splice || typeof splice.target !== 'string' || !['next-turn', 'next-step'].includes(splice.target)) {
      out.push(violation('I1', loc, `spliced 缺合法 target（next-turn/next-step）：${JSON.stringify(splice)?.slice(0, 80)}`));
      continue;
    }
    const inbox = state[splice.target];
    const removedCount = splice.removedCount ?? 0;
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || splice.start + removedCount > inbox.length) {
      out.push(violation('I1', loc, `invalid inbox splice @seq ${event.seq}：target=${splice.target} start=${splice.start} removedCount=${removedCount} 但队列长 ${inbox.length}（seedLength=${seedLength}）——resume 会被拒（fork 边界孤儿 spliced 即此形态，removedCount 指向 seed 相对空 inbox）`));
      continue;
    }
    const inserted = Array.isArray(splice.inserted) ? splice.inserted : [];
    const candidate = inbox.slice(0, splice.start).concat(inserted, inbox.slice(splice.start + removedCount));
    const ids = new Set();
    const other = splice.target === 'next-turn' ? state['next-step'] : state['next-turn'];
    for (const message of [...candidate, ...other]) {
      const id = message?.id ?? message?.message?.id;
      if (id === undefined) continue;
      if (ids.has(id)) {
        out.push(violation('I1', loc, `message "${id}" 已在待处理队列中（target=${splice.target}）——resume 会被拒（重复 pending id）`));
        break;
      }
      ids.add(id);
    }
    inbox.splice(splice.start, removedCount, ...inserted);
  }
  return out;
}

/** 从事件推导 wire 消息（与 dsh-session deriveEventMessage 同语义）。 */
export function deriveWireMessage(event) {
  if (event.type === 'user/message') {
    return { role: 'user', content: event.data?.content ?? [] };
  }
  if (event.type === 'assistant/message') {
    const m = event.data?.message;
    if (!m || !Array.isArray(m.content) || m.content.length === 0) return null;
    return { role: 'assistant', content: m.content };
  }
  if (event.type === 'tool/result') {
    return { role: 'tool', content: event.data?.message?.content ?? [] };
  }
  return null;
}

/**
 * Wire 级校验（W1/W2）：按 surface 顺序展开模型请求消息流，
 * 检查 tool 消息是否悬空（缺前置 assistant tool-call）以及 user 文本
 * 是否插在 tool_calls 与结果之间。strict 端点（MiMo 等）直接 INVALID_REQUEST。
 * @param events - 展开后的完整事件流（含 chunk 展开）。
 * @returns 违规列表。
 */
export function wireViolations(events, version) {
  const out = [];
  // 先折叠 surface（append 入列；replace 移除 [start..end] 并将 marker 自身入列）
  const nodes = [];
  const bySeq = new Map();
  for (const { event, lineNo } of events) {
    bySeq.set(event.seq, { event, lineNo });
    if (!currentSurfaceTypes(version).has(event.type)) continue;
    const op = event.surfaceOp;
    if (op === 'append') {
      nodes.push(event.seq);
    } else if (op !== undefined) {
      const normalized = normalizeReplaceOp(op, version);
      const s = normalized === null ? -1 : nodes.indexOf(normalized.start);
      const e = normalized === null ? -1 : nodes.indexOf(normalized.end);
      if (s !== -1 && e !== -1 && s <= e) nodes.splice(s, e - s + 1, event.seq);
      else nodes.push(event.seq);
    }
  }
  // 展开 wire 流
  const wire = [];
  for (const seq of nodes) {
    const rec = bySeq.get(seq);
    if (!rec) continue;
    const m = deriveWireMessage(rec.event);
    if (m === null) continue;
    if (m.role === 'assistant') {
      wire.push({ role: 'assistant', tc: m.content.filter((b) => b.type === 'tool-call').length, seq, lineNo: rec.lineNo });
    } else if (m.role === 'user') {
      const text = m.content.some((b) => b.type === 'text');
      const trs = m.content.filter((b) => b.type === 'tool-result').length;
      if (text) wire.push({ role: 'user', seq, lineNo: rec.lineNo });
      for (let i = 0; i < trs; i++) wire.push({ role: 'tool', seq, lineNo: rec.lineNo });
    } else {
      wire.push({ role: m.role, seq, lineNo: rec.lineNo });
    }
  }
  let pending = 0;
  let pendingSeq = null;
  for (const w of wire) {
    if (w.role === 'assistant') {
      pending = w.tc;
      pendingSeq = pending > 0 ? w.seq : null;
    } else if (w.role === 'tool') {
      if (pending <= 0) {
        out.push(violation('W1', { seq: w.seq, lineNo: w.lineNo }, `wire: tool 消息 @seq ${w.seq} 悬空——surface 中没有未满足的 assistant tool-call（严格端点会 INVALID_REQUEST）`));
      } else {
        pending--;
        if (pending === 0) pendingSeq = null;
      }
    } else if (w.role === 'user' && pending > 0) {
      out.push(violation('W2', { seq: w.seq, lineNo: w.lineNo }, `wire: user 文本 @seq ${w.seq} 插在 assistant tool_calls（@seq ${pendingSeq}）与其 tool 结果之间——严格端点会拒绝该序列`));
    }
  }
  return out;
}

// ── P5 · carrier 两段配对 ──────────────────────────────────────────────

/** 第 1 段（审计段）：`compaction/prune` + `data.shadowedRange`/`shadowedSeqs`（插件两段载体）。 */
export function isCarrierAuditSegment(event) {
  if (!event || event.type !== 'compaction/prune') return false;
  const data = event.data;
  if (!data || typeof data !== 'object') return false;
  const range = data.shadowedRange;
  return typeof range === 'object' && range !== null && isSafeInt(range.start) && isSafeInt(range.end) && Array.isArray(data.shadowedSeqs);
}

/** 从 surfaceOp 取 replace 的 [start,end]（按文件版本择路：v3+ startSeq/endSeq）。 */
export function surfaceReplaceRange(op, version) {
  if (!op || typeof op !== 'object' || op.op !== 'replace') return null;
  if (version >= 3) {
    return isSafeInt(op.startSeq) && isSafeInt(op.endSeq) ? { start: op.startSeq, end: op.endSeq } : null;
  }
  return isSafeInt(op.start) && isSafeInt(op.end) ? { start: op.start, end: op.end } : null;
}

/** 审计段与载体的区间是否一致（配对的结构证据）。 */
export function carrierRangesMatch(audit, carrier, version) {
  const range = audit?.data?.shadowedRange;
  const op = surfaceReplaceRange(carrier?.surfaceOp, version);
  return Boolean(range && op && range.start === op.start && range.end === op.end);
}

/**
 * P5 —— carrier 两段配对（读侧）。
 *
 * 现行写法：`sourceEventSeqs = [审计段 seq, ...被遮蔽节点]`；
 * 第 2 段 = 紧随审计段的 surface replace。规则：
 * - 审计段 seq 在 **首元素** ⇒ 通过（现役）；
 * - 在 **末元素** ⇒ 通过（旧顺序，读侧容错），给 warning（不静默）；
 * - 在中间位 / 载体紧邻审计段却**完全没引用**它 ⇒ error（配对失败 / 孤儿审计段）。
 * 官方 compaction 的 `compaction/summary` 引用是另一形状（`[compaction/start, summary, …]`），
 * 审计段类型限定 `compaction/prune` 天然不误报。
 *
 * @param {Array<{event:object,lineNo?:number}>} events 行序事件
 * @param {{version?:number}} [opts] 被检文件版本（决定 replace 字段名）
 * @returns P5 违规列表
 */
export function carrierPairingViolations(events, { version = 0 } = {}) {
  const out = [];
  const list = events ?? [];
  const audits = new Map();
  for (const { event, lineNo } of list) {
    if (isCarrierAuditSegment(event) && isSafeInt(event.seq)) audits.set(event.seq, { event, lineNo });
  }
  if (audits.size === 0) return out;
  for (let idx = 0; idx < list.length; idx++) {
    const { event, lineNo } = list[idx];
    if (!event || !event.surfaceOp || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') continue;
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    const src = event.sourceEventSeqs;
    if (!Array.isArray(src)) continue; // S6/S10 负责
    const refs = [];
    for (let i = 0; i < src.length; i++) {
      const audit = audits.get(src[i]);
      if (audit && src[i] < event.seq) refs.push({ audit, pos: i });
    }
    // 读侧**两种写法都认**（两种都在真实日志中出现过）：
    //   ① 现役：`[审计段 seq, ...被遮蔽节点]`（审计段 seq 在首位）；
    //   ② 早期：`[区间起点, ...被遮蔽节点]`（**不引用**审计段 seq；"区间起点"= replace 范围起点）。
    // 两种都不报；其余（审计段 seq 在中间位、或首元素既非审计段也非区间起点）= 配对失败。
    const range = surfaceReplaceRange(event.surfaceOp, version);
    const legacyStartFirst = range !== null && src[0] === range.start;
    if (refs.length > 0) {
      for (const { audit, pos } of refs) {
        if (pos === 0 || legacyStartFirst) continue; // 现役 / 早期写法
        out.push(violation('P5', loc, `carrier 两段配对：审计段 seq ${audit.event.seq} 出现在 sourceEventSeqs 第 ${pos} 位，且首元素既不是审计段 seq 也不是区间起点（${String(src[0])} ≠ ${String(range?.start)}）——读侧只认两种写法：[审计段, ...]（现役）或 [区间起点, ...]（早期）`));
      }
      continue;
    }
    const prev = idx > 0 ? list[idx - 1] : undefined;
    if (prev && isCarrierAuditSegment(prev.event) && carrierRangesMatch(prev.event, event, version)) {
      if (legacyStartFirst) continue; // 早期写法：区间起点开头、不引用审计段 ⇒ 读侧容错
      out.push(violation('P5', loc, `carrier 两段配对失败（孤儿审计段）：紧邻的审计段 seq ${prev.event.seq}（compaction/prune，区间 ${prev.event.data.shadowedRange.start}..${prev.event.data.shadowedRange.end}）既未被本载体 sourceEventSeqs 引用，首元素也不是区间起点（${String(src[0])} ≠ ${prev.event.data.shadowedRange.start}）——第 2 段首元素必须是第 1 段 seq（现役）或区间起点（早期写法）`));
    }
  }
  return out;
}

/**
 * P5 —— 写侧（现役写法严格校验）。`events` = 已存在事件 + 拟写事件（拟写事件在最后）。
 * 判据：拟写载体若紧邻审计段，`sourceEventSeqs[0]` 必须等于该审计段 seq；任何被引用的
 * 审计段 seq 都必须出现在首元素。
 * @param {Array<object>} events 完整事件列表（拟写事件在末尾）
 * @param {{version?:number}} [opts]
 * @returns P5 违规列表（error 级 = 写入被拒）
 */
export function carrierWriteViolations(events, { version = 3 } = {}) {
  const out = [];
  const list = events ?? [];
  if (list.length === 0) return out;
  const candidate = list[list.length - 1];
  if (!candidate || !candidate.surfaceOp || typeof candidate.surfaceOp !== 'object' || candidate.surfaceOp.op !== 'replace') return out;
  const src = candidate.sourceEventSeqs;
  if (!Array.isArray(src)) return out; // S6/S10 负责
  const loc = { seq: candidate.seq, lineNo: null, eventType: candidate.type };
  const audits = new Map();
  for (const event of list) if (isCarrierAuditSegment(event) && isSafeInt(event.seq)) audits.set(event.seq, event);
  // ① 紧邻审计段（最强的配对证据）：首元素必须就是它。
  const prev = list[list.length - 2];
  if (isCarrierAuditSegment(prev) && carrierRangesMatch(prev, candidate, version)) {
    if (src[0] !== prev.seq) {
      out.push(violation('P5', loc, `carrier 两段配对（写侧）：紧邻审计段 seq ${prev.seq}（compaction/prune），第 2 段 sourceEventSeqs 首元素必须是它（实际首元素 ${String(src[0])}）——写入被拒`));
    }
    return out;
  }
  // ② 其余情况：任何被引用的审计段 seq 都必须在首元素（写侧严格）。
  for (let i = 1; i < src.length; i++) {
    const audit = audits.get(src[i]);
    if (audit && src[i] < candidate.seq) {
      out.push(violation('P5', loc, `carrier 两段配对（写侧）：审计段 seq ${audit.seq} 出现在 sourceEventSeqs 第 ${i} 位，但现役写法要求首元素 = 第 1 段 seq——写入被拒`));
      break;
    }
  }
  return out;
}
