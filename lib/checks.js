/**
 * dsh-log-contract · lib/checks.js
 *
 * 逐事件契约检查（共享层）：离线体检（validate.js）与写前校验（prewrite.js）
 * 复用同一套判定逻辑，保证"体检看到的问题 = 写入前拦下的问题"。
 *
 * 全部判定与 `@deepseek-ai/dsh-session@0.1.0-rc.7` 官方实现同语义，
 * 每条违规都挂 `lib/contracts.js` 中的规则 id 与官方源码出处。
 */
import { foldSurface, isJsonValue, isSurfaceEligibleType, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { ruleById } from './contracts.js';

export const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
export const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);
export const MARKER_PREFIXES = ['retrace', 'message-editor'];

/** 构造一条违规记录。 */
export function violation(id, eventOrLoc, message, extra = {}) {
  const rule = ruleById(id);
  const loc = eventOrLoc ?? {};
  return {
    id,
    severity: rule?.severity ?? 'error',
    layer: rule?.layer ?? 'unknown',
    seq: typeof loc.seq === 'number' ? loc.seq : null,
    lineNo: typeof loc.lineNo === 'number' ? loc.lineNo : null,
    eventType: loc.eventType ?? null,
    message,
    source: rule?.source ?? null,
    ...extra,
  };
}

export function isSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** 事件信封 shape：seq/type/time/data（E1/E3/E4/E5/E6）。 */
export function envelopeViolations(event, loc) {
  const out = [];
  if (!isSafeInt(event.seq)) {
    out.push(violation('E1', loc, `事件 seq 缺失或非法（${String(event.seq)}），必须为非负安全整数`));
  }
  if (typeof event.type !== 'string') {
    out.push(violation('E3', loc, `事件缺少 type 字符串（${String(event.type)}）`));
  } else if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
    out.push(violation('E3', loc, `type "${event.type}" 不在已知词汇表内且未带 ignorable 标记（可能由更新版本的 harness 写入）`));
  }
  if (!isJsonValue(event.data)) {
    out.push(violation('E4', loc, 'data 不是 lossless-JSON（函数/循环引用/非有限数等），写入热路径会拒绝'));
  }
  if (event.surfaceOp !== undefined && !isJsonValue(event.surfaceOp)) {
    out.push(violation('E4', loc, 'surfaceOp 不是 lossless-JSON'));
  }
  if (event.sourceEventSeqs !== undefined && !isJsonValue(event.sourceEventSeqs)) {
    out.push(violation('E4', loc, 'sourceEventSeqs 不是 lossless-JSON'));
  }
  if (event.type === 'request/header-delta') {
    out.push(violation('E5', loc, '使用已删除的遗留格式 request/header-delta，写入即被拒'));
  }
  if (event.type === 'request/header' && event.data?.reason === 'fallback') {
    out.push(violation('E5', loc, 'request/header 使用已删除的遗留 reason "fallback"'));
  }
  out.push(...messageShapeViolations(event, loc));
  return out;
}

/** 镜像官方 assertMessageEventShape（lib/index.js:1242-1266）。 */
export function messageShapeViolations(event, loc) {
  const type = event.type;
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return [];
  const out = [];
  const data = event.data;
  const record = typeof data === 'object' && data !== null ? data : undefined;
  const message = type === 'user/message' ? record : record?.message;
  const shape = () => `（seq ${event.seq}）消息形状`;
  if (typeof message !== 'object' || message === null) {
    out.push(violation('E6', loc, `${shape()}：缺少 message 对象`));
    return out;
  }
  if (typeof message.id !== 'string' || message.id === '') {
    out.push(violation('E6', loc, `${shape()}：id 必须为非空字符串`));
  }
  const expectedRole = type === 'assistant/message' ? 'assistant' : 'user';
  if (message.role !== expectedRole) {
    out.push(violation('E6', loc, `${shape()}：role 必须为 "${expectedRole}"，实际 ${String(message.role)}`));
  }
  const source = message.source;
  if (typeof source !== 'object' || source === null || typeof source.kind !== 'string' || source.kind === '') {
    out.push(violation('E6', loc, `${shape()}：source.kind 缺失或非法`));
  }
  if (!Array.isArray(message.content)) {
    out.push(violation('E6', loc, `${shape()}：content 必须为数组`));
  }
  if (type === 'assistant/message') {
    if (source?.kind !== 'model' || typeof source.provider !== 'string' || source.provider === '' || typeof source.model !== 'string' || source.model === '') {
      out.push(violation('E6', loc, `${shape()}：assistant/message 必须带 model source（provider/model 非空）`));
    }
  }
  if (type === 'tool/result') {
    if (source?.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
      out.push(violation('E6', loc, `${shape()}：tool/result 必须带 tool source（callId 非空）`));
    }
    const content = message.content;
    const block = Array.isArray(content) ? content[0] : undefined;
    if (content?.length !== 1 || typeof block !== 'object' || block === null || block.type !== 'tool-result' || !Array.isArray(block.content)) {
      out.push(violation('E6', loc, `${shape()}：必须恰含一个 tool-result block`));
    } else if (block.toolCallId !== source?.callId) {
      out.push(violation('E6', loc, `${shape()}：block.toolCallId 与 source.callId 不匹配`));
    }
  }
  return out;
}

/** replace 操作数精确形状（镜像 isReplaceOp，lib/index.js:300-303）。 */
export function isReplaceOp(op) {
  return (
    typeof op === 'object' && op !== null &&
    Object.keys(op).length === 3 &&
    Object.hasOwn(op, 'op') && Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end') &&
    op.op === 'replace' && isSafeInt(op.start) && isSafeInt(op.end)
  );
}

/**
 * 与官方同语义的 surface 增量重放，逐事件归因 S1–S7。
 * @param {Array<{event:object, lineNo?:number}>} events 按日志顺序的事件（带 loc 包装）
 */
export function replaySurface(events) {
  const violations = [];
  const nodes = [];
  let replaceGeneration = 0;

  for (const { event, lineNo } of events) {
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    const eligible = SURFACE_TYPES.has(event.type);
    const op = event.surfaceOp;
    const src = event.sourceEventSeqs;

    if (!eligible) {
      if (op !== undefined || src !== undefined) {
        violations.push(violation('S2', loc, `非 surface 类型 "${event.type}" 不得携带 surfaceOp/sourceEventSeqs`));
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

    if (!isReplaceOp(op)) {
      violations.push(violation('S4', loc, 'replace 操作数必须精确为 {op:"replace", start, end}（start/end 为非负安全整数）'));
      continue;
    }
    const startIdx = nodes.indexOf(op.start);
    const endIdx = nodes.indexOf(op.end);
    if (startIdx === -1 || endIdx === -1) {
      violations.push(violation('S4', loc, `replace 范围 ${op.start}..${op.end} 不在当前 surface 中（start 存在=${startIdx !== -1}，end 存在=${endIdx !== -1}）`));
      continue;
    }
    if (startIdx > endIdx) {
      violations.push(violation('S4', loc, `replace start ${op.start}（index ${startIdx}）在 end ${op.end}（index ${endIdx}）之后`));
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

/** 镜像官方 assertProvenance（lib/index.js:320-337）。 */
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

/** 镜像官方 assertToolResultRewrite（lib/index.js:369-395）的判定核心。 */
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
    // turn/step 位于 event.data 层（实证：正常消息 data.turn/data.step 为数字，
    // 插件 marker data.turn/data.step 为 null —— 复盘事故第 2 轮）
    const turn = event.data?.turn;
    const step = event.data?.step;
    if (turn == null || step == null) {
      out.push(violation('M1', loc, `assistant/message 以 append 进入 surface 但 data.turn/data.step 缺失（turn=${String(turn)}, step=${String(step)}）——只能以 replace 承载（插件 marker 定义），append 会触发客户端引擎崩溃（rt.js:6816）`));
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

/** 官方 foldSurface 终验；不抛返回折叠结果，抛则返回 { error }。 */
export function finalFold(events) {
  try {
    return { surface: foldSurface(events) };
  } catch (err) {
    return { error: err };
  }
}
