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
 * S9 —— 文件物理序 seq 单调（2026-08-30 事故固化；交接书 L2）。
 *
 * 按**文件物理行序**（非 seq 排序）要求展开后的事件 seq 严格单调递增。
 * 单进程 append 不可能写出非单调物理序（appendCore 断言 seq==cursor+i 且按
 * id 串行化）——非单调 = 多写入者/旧光标回放交织的现场特征（526f1835 物理序
 * 734056→733539→735470）。E2 只查「排序后连续」，排序会掩盖物理序倒退；
 * S9 补「物理序单调」盲区。
 *
 * @param rows - loadSessionLog 的 rows（物理行序，每行含 decoded 数组）。
 * @returns S9 违规列表（error 级）。
 */
export function physicalOrderViolations(rows) {
  const out = [];
  let prevSeq = -1;
  let prevLineNo = null;
  for (const row of rows) {
    if (!Array.isArray(row.decoded) || row.decoded.length === 0) continue;
    for (const event of row.decoded) {
      if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) continue; // E1 处理
      if (event.seq < prevSeq) {
        out.push(violation('S9', { seq: event.seq, lineNo: row.lineNo, eventType: event.type }, `文件物理序 seq 倒退：${prevSeq}（line ${prevLineNo}）→ ${event.seq}（line ${row.lineNo}）——非单调 = 多写入者/旧光标回放交织（单进程 append 不可能写出），会话加载会被拒`));
        return out; // 首个倒退即现场特征，报一次足够（后续乱序都源自此）
      }
      prevSeq = event.seq;
      prevLineNo = row.lineNo;
    }
  }
  return out;
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

/**
 * P3 —— tool/call ↔ tool/result 配对完整性（考古任务书 B1）。
 * 每个 tool/call 的 `data.callId` 必须能在 tool/result 的
 * `data.message.source.callId` 中找到配对；孤儿 call（无 result）告警——
 * 中断/失败轮次可能产生孤儿（合法但要审计）。warning 级：不破坏日志。
 */
export function toolPairingViolations(events) {
  const out = [];
  const calls = new Map(); // callId → { command, loc }
  const results = new Set();
  for (const { event, lineNo } of events) {
    if (event.type === 'tool/call') {
      const callId = event.data?.callId;
      if (typeof callId === 'string' && callId !== '') {
        let command = '';
        try {
          const args = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments;
          command = typeof args?.command === 'string' ? args.command.slice(0, 120) : '';
        } catch { /* 参数解析失败不阻断配对检查 */ }
        calls.set(callId, { command, loc: { seq: event.seq, lineNo, eventType: event.type } });
      }
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      if (typeof callId === 'string' && callId !== '') results.add(callId);
    }
  }
  for (const [callId, { command, loc }] of calls) {
    if (!results.has(callId)) {
      out.push(violation('P3', loc, `tool/call ${callId}（命令 ${command || '(未知)'}）没有配对的 tool/result——孤儿调用（中断/失败未落结果），考古提取将缺该输出`));
    }
  }
  return out;
}

/**
 * 递归检查 content 的可提取性：任意标量（string/number/boolean/null）都是合法
 * 元数据（如 isError、toolCallId）——只有 "text 字段存在但值非 string" 才是
 * 考古提取会漏数据的结构异常（extractText 依赖 text 为 string）。
 */
function findUnparsableContent(node, path) {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || node === null) return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = findUnparsableContent(node[i], `${path}[${i}]`);
      if (r !== null) return r;
    }
    return null;
  }
  if (typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, 'text') && typeof node.text !== 'string') {
      return `${path}.text（${String(node.text)}，非 string）`;
    }
    for (const key of Object.keys(node)) {
      if (key === 'text') continue;
      const r = findUnparsableContent(node[key], `${path}.${key}`);
      if (r !== null) return r;
    }
    return null;
  }
  return `${path}（${String(node)}）`;
}

/**
 * P4 —— tool/result 输出结构契约（考古任务书 B2）。
 * `data.message.content` 必须可递归解析（list[dict{type:text,text}] 或等价）；
 * 不可解析片段 = 考古提取将漏数据。空 content（失败/无输出）合法。warning 级。
 */
export function toolResultStructureViolations(events) {
  const out = [];
  for (const { event, lineNo } of events) {
    if (event.type !== 'tool/result') continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const callId = event.data?.message?.source?.callId;
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    const bad = findUnparsableContent(content, 'content');
    if (bad !== null) {
      out.push(violation('P4', loc, `tool/result ${callId ?? '?'} 的 content 含不可解析片段（${bad}）——考古提取将漏数据`));
    }
  }
  return out;
}

/**
 * T1 —— token-meter 配对（复刻 @deepseek-ai/dsh-token-meter 的 _foldEvent 状态机，
 * 2026-08-28 事故根因 3 固化）：
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
  // 定义，不做配对检查（避免对旧结构误报；真实事故会话都是现代结构）。
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
 * T2 —— token-meter 的 sourceEventSeqs 引用必须同 turn/step（2026-08-30 第二类
 * 刷屏事故固化）。
 *
 * 镜像官方 `_estimateProviderAssistant`（dsh-token-meter lib/index.js:634-650）：
 * `assistant/message` 的每个 `sourceEventSeqs` 若指向 `assistant/chunk`，其
 * turn/step 必须与消息自身一致；跨 step 引用 → 官方抛
 * `token meter: assistant/message at seq N source seq M belongs to another step`
 * （lib/index.js:645）。
 *
 * 事故现场：DSH resend/regenerate 在 agent 仍开着 step 时被触发，会把旧 step 的
 * chunk 全部引用进新 assistant/message（526f1835 seq 936047 跨 step 7/8/9）→
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
    if (event.data?.usage === void 0) continue; // 无 usage 不触发 _estimateProviderAssistant（官方 :592 前提）——replace marker（S5 遮蔽语义，sourceEventSeqs 含非 chunk 节点）合法
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
        out.push(violation('T2', { seq: event.seq, lineNo, eventType: event.type }, `assistant/message at seq ${event.seq} source seq ${s} is not assistant/chunk（实际 ${src ? src.event.type : 'MISSING'}）——token meter 折叠会抛错（_estimateProviderAssistant :644 对非 chunk 引用直接 throw），/compact 与压力测量永久失败`));
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
export function wireViolations(events) {
  const out = [];
  // 先折叠 surface（append 入列；replace 移除 [start..end] 并将 marker 自身入列）
  const nodes = [];
  const bySeq = new Map();
  for (const { event, lineNo } of events) {
    bySeq.set(event.seq, { event, lineNo });
    if (!SURFACE_TYPES.has(event.type)) continue;
    const op = event.surfaceOp;
    if (op === 'append') {
      nodes.push(event.seq);
    } else if (op && isReplaceOp(op)) {
      const s = nodes.indexOf(op.start);
      const e = nodes.indexOf(op.end);
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
