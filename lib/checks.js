/**
 * dsh-log-contract · lib/checks.js
 *
 * 逐事件契约检查（共享层）：离线体检（validate.js）与写前校验（prewrite.js）
 * 复用同一套判定逻辑，保证"体检看到的问题 = 写入前拦下的问题"。
 *
 * 全部判定与 `@deepseek-ai/dsh-session@0.1.0-rc.7` 官方实现同语义，
 * 每条违规都挂 `lib/contracts.js` 中的规则 id 与官方源码出处。
 */
import { isSurfaceEligibleType } from '@deepseek-ai/dsh-session';
import { isJsonValue } from './compat.js';
import { currentVocabulary, currentFold, V0_EVENT_TYPES } from './vocab.js';
import { ruleById } from './contracts.js';

export const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
/** v3 新增 `system/message`（官方 `SURFACE_EVENT_TYPES`，0.1.5 `lib/index.js:149-154`）。 */
export const MODERN_SURFACE_TYPES = new Set([...SURFACE_TYPES, 'system/message']);
export const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

/** 当前文件版本适用的 surface 候选类型集（v3 起含 system/message）。version = 被检文件版本。 */
export function currentSurfaceTypes(version) {
  return version >= 3 ? MODERN_SURFACE_TYPES : SURFACE_TYPES;
}
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

/** 事件信封 shape：seq/type/time/data（E1/E3/E4/E5/E6）。version = 被检文件版本。 */
export function envelopeViolations(event, loc, version) {
  const out = [];
  if (!isSafeInt(event.seq)) {
    out.push(violation('E1', loc, `事件 seq 缺失或非法（${String(event.seq)}），必须为非负安全整数`));
  }
  if (typeof event.type !== 'string') {
    out.push(violation('E3', loc, `事件缺少 type 字符串（${String(event.type)}）`));
  } else if (!currentVocabulary(version).has(event.type) && event.ignorable !== true) {
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
    out.push(violation('E5', loc, '使用已删除的遗留格式 request/header-delta——写入会成功（宿主 append 不看 type）、下一次读取才炸；请改用当前格式'));
  }
  if (event.type === 'request/header' && event.data?.reason === 'fallback') {
    out.push(violation('E5', loc, 'request/header 使用已删除的遗留 reason "fallback"'));
  }
  // ── R-G(2026-09-14 独立复核:3 例确证漏检补成候选规则)────────────────────
  // E8 信封键白名单:宿主 `assertSessionEventEnvelope`（@deepseek-ai/dsh-session@0.1.5-rc.1
  //   lib/index.js:852-861）逐键 switch,只认 7 个键,其余一律 `invalid event envelope`。
  //   实测变异 05:宿主拒、旧契约 0 违规。
  if (typeof event === 'object' && event !== null) {
    const extra = Object.keys(event).filter((k) => !ENVELOPE_ALLOWED_KEYS.has(k));
    if (extra.length > 0) {
      out.push(violation('E8', loc, `事件信封含多余键 ${extra.join(', ')}——宿主只认 {${[...ENVELOPE_ALLOWED_KEYS].join(',')}}（dsh-session@0.1.5-rc.1 lib/index.js:852-861）`));
    }
  }
  // E10 request/header 的 data 字段约束:宿主 `validateSessionEventData`
  //   （dsh-session@0.1.5-rc.1 lib/index.js:231-248）——`header.system` 必须省略、
  //   空 tools / 空 adapterDefaults 必须省略。实测变异 12:宿主拒、旧契约 0 违规。
  if (event.type === 'request/header') {
    const header = event.data?.header;
    if (typeof header !== 'object' || header === null || Array.isArray(header)) {
      out.push(violation('E10', loc, 'request/header 的 data.header 必须是对象'));
    } else {
      if (Object.hasOwn(header, 'system')) out.push(violation('E10', loc, 'request/header 必须省略 header.system（系统提示改走 system/message）——宿主 lib/index.js:237'));
      if (Array.isArray(header.tools) && header.tools.length === 0) out.push(violation('E10', loc, 'request/header 必须省略空 tools——宿主 lib/index.js:238'));
      const defaults = header.adapterDefaults;
      if (typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults) && Object.keys(defaults).length === 0) {
        out.push(violation('E10', loc, 'request/header 必须省略空 adapterDefaults——宿主 lib/index.js:239-240'));
      }
    }
  }
  out.push(...messageShapeViolations(event, loc));
  return out;
}

/** 宿主信封键白名单（assertSessionEventEnvelope，dsh-session@0.1.5-rc.1 lib/index.js:852-861）。 */
export const ENVELOPE_ALLOWED_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable']);

/** 镜像官方 assertMessageEventShape（lib/index.js:1242-1266）。 */
export function messageShapeViolations(event, loc) {
  const type = event.type;
  // R-G:把 v3 新增的 `system/message` 纳入形状检查（MESSAGE_ROLE_BY_TYPE:system/message → system,
  // dsh-session@0.1.5-rc.1 lib/index.js:917-926;source 要求 :942-944）。旧实现只查 user/assistant/tool
  // ⇒ 实测变异 03（system/message 的 source.kind='user'）宿主拒、旧契约 0 违规。
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result' && type !== 'system/message') return [];
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
  const expectedRole = type === 'assistant/message' ? 'assistant' : (type === 'system/message' ? 'system' : 'user');
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
  if (type === 'system/message') {
    // E9(R-G 候选规则):system/message 必须 plugin source（kind==='plugin' + plugin 非空）。
    // 宿主依据:dsh-session@0.1.5-rc.1 lib/index.js:942-944（"must have plugin source"）。
    if (source?.kind !== 'plugin' || typeof source.plugin !== 'string' || source.plugin === '') {
      out.push(violation('E9', loc, `${shape()}：system/message 必须带 plugin source（kind==='plugin' 且 plugin 非空）——宿主 lib/index.js:942-944`));
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

/** replace 操作数精确形状（镜像旧格式 isReplaceOp，lib/index.js:300-303）。 */
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
 * v3 `{op,startSeq,endSeq}`（`dsh-session-format-v2-to-v3/lib/index.js:361-371`）。
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
 * S9 —— 文件物理序 seq 单调（2026-08-30 事故固化；交接书 L2）。
 *
 * 按**文件物理行序**（非 seq 排序）要求展开后的事件 seq 严格单调递增。
 * 单进程 append 不可能写出非单调物理序（appendCore 断言 seq==cursor+i 且按
 * id 串行化）——非单调 = 多写入者/旧光标回放交织的现场特征（某真实会话：物理序
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
        // ── R-B(2026-09-14 独立复核,误报 S2)────────────────────────────────
        // 宿主 `@deepseek-ai/dsh-session@0.1.5-rc.1` 是**刻意容忍**的:
        //   lib/index.js:270 `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return;`
        //   同一函数的契约注释 lib/index.js:305 —— "Unknown ignorable records retain opaque
        //   metadata and never change the surface."
        // ⇒ **未知**类型且 `ignorable===true` 的事件带 surfaceOp/sourceEventSeqs 是合法的不透明
        //   元数据(宿主收;实测变异 06:宿主收、旧契约 S2/error)。这里不再报 S2。
        //   "该未知类型有没有消费者"由 E7 以 **warning** 表达(策略层,非宿主契约)。
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

/** 折叠终验：**按文件版本**择路（1.3 第二半 + 2026-09-14 复核补强）。
 *
 * - v3 文件 → 运行时导出的官方 `foldSurface`（与运行时同语义）；
 * - v0/v1/v2 文件 → 本地 `legacyFoldSurface`（rc.7 `foldSurface` 逐条移植）。
 *
 * 为什么旧格式不能借用官方实现的 `violations` 字段：官方 `foldSurface` **只抛不报**，
 * 旧口径下这里曾回退到 `replaySurface` 的 violations，但**没有任何调用方读它**
 * （validate.js / prewrite.js 只看 `folded.error`）⇒ S8 在旧格式上永不触发——这正是
 * 2026-09-14 六条失败里四条的真因。现在两条路径都是"抛错 = 拒绝"的同一种契约。 */
export function finalFold(events, version) {
  const fold = currentFold(version);
  try {
    return { surface: fold(events) };
  } catch (err) {
    return { error: err };
  }
}

/**
 * T3 —— step 节点 key 冲突（2026-09-02 · 渲染层白屏事故真正根因固化）。
 *
 * 客户端渲染消息列表 = 从事件流构建节点，节点 key = `data.turn:data.step`
 * （React 列表 key）。同 turn 内两个 step/start 的 step 号相同 → key 冲突 →
 * React 渲染死循环 → 白屏/不展示（实测：同一 turn 内正常轮的 step 95/1 与
 * 编辑块的 step 95/1 冲突；2026-09-02 全量扫描又发现多个同型冲突的会话，
 * 均整块重编号修复）。
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
      out.push(violation('T3', { seq: event.seq, lineNo, eventType: event.type }, `step 节点 key ${key} 冲突：seq ${prev.seq} 与 seq ${event.seq} 的 step/start 同 turn 同 step——客户端 React 渲染死循环白屏（渲染层事故；修复：同 turn 内 step 递增，不得复用；整块重编号）`))
    } else {
      seen.set(key, { seq: event.seq, lineNo })
    }
  }
  return out
}

/**
 * T4 —— step/消息本体 turn 缺失（null/undefined）（2026-09-01 · D8 事故固化）。
 *
 * 客户端渲染状态机对 turn=null 的 step/消息**无法归属任何 turn** → 渲染死循环 →
 * 白屏「载入历史」（实测：retrace 0.4.17 写的编辑块
 * step/start+marker+step/end turn 全 null；离线自查脚本把 step
 * 包裹/消息本体的 null-turn 判为致命）。
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
      out.push(violation('T4', { seq: event.seq, lineNo, eventType: event.type }, `${event.type} 的 data.turn 为 ${String(turn)}（缺失）——客户端渲染状态机无法归属任何 turn → 渲染死循环白屏（D8 事故；step/消息本体必须带真实 turn 号）`))
    }
  }
  return out
}

/**
 * T5 —— turn/end 缺 reason.kind（2026-09-02 · malformed turn/end 固化）。
 *
 * 官方 agent-loop 写 turn/end 恒带 `reason: { kind }`（dsh-agent-loop/lib/index.js:620；
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
      out.push(violation('T5', { seq: event.seq, lineNo, eventType: event.type }, `turn/end 缺 data.reason.kind（reason=${JSON.stringify(reason)}）——官方 validation 拒绝 → 会话加载失败（malformed turn/end；turn/end 必须带 reason.kind，镜像 dsh-agent-loop:620）`))
    }
  }
  return out
}

/**
 * E7 —— ignorable 未知 type 合法性（2026-09-09 T2 增量）。
 *
 * 盲区：E3 对"未知 type + ignorable:true"直接放行（容忍更新版本 harness 写入），
 * 但 ignorable 标记无合法性校验 = 后门——被读路径接纳却无人消费的未知事件 =
 * 静默垃圾（违 R3 精神）。补：未知 type + ignorable + **不在已知消费者白名单** →
 * warning"有被忽略的未知事件"。
 *
 * 已知消费者（不算垃圾，排除）：retrace 家族 marker（retrace/marker、retrace/goal-marker，
 * neutralize/插件产物，retrace 客户端识别消费）与旧前缀 message-editor。
 * 判定：type ∉ KNOWN && ignorable && 非已知插件前缀 → warning。
 */
const KNOWN_IGNORABLE_CONSUMERS = new Set(['retrace/marker', 'retrace/goal-marker'])
function isKnownIgnorableType(type) {
  if (typeof type !== 'string') return false
  if (KNOWN_IGNORABLE_CONSUMERS.has(type)) return true
  return type.startsWith('message-editor/') || type.startsWith('retrace/')
}
export function ignorableTypeViolations(events, version) {
  const out = []
  for (const { event, lineNo } of events) {
    if (typeof event?.type !== 'string' || event.ignorable !== true) continue
    if (currentVocabulary(version).has(event.type)) continue
    if (isKnownIgnorableType(event.type)) continue
    out.push(violation('E7', { seq: event.seq, lineNo, eventType: event.type }, `type "${event.type}" 不在已知词汇表且带 ignorable 标记、无已知消费者——被读路径接纳但无人消费 = 静默垃圾（ignorable 后门；若你的插件消费它，登记到 KNOWN_IGNORABLE_CONSUMERS）`))
  }
  return out
}

/**
 * P3 —— tool/call ↔ tool/result 配对完整性（考古 B1）。
 * 每个 tool/call 的 `data.callId` 必须能在 tool/result 的
 * `data.message.source.callId` 中找到配对；孤儿 call（无 result）告警——
 * 中断/失败轮次可能产生孤儿（合法但要审计）。warning 级：不破坏日志。
 */
export function toolPairingViolations(events) {
  const out = [];
  const calls = new Map(); // callId → { command, loc }
  const results = new Map(); // callId → loc（双向：孤儿 result 也要指认，2026-09-09 T1）
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
      if (typeof callId === 'string' && callId !== '') results.set(callId, { seq: event.seq, lineNo, eventType: event.type });
    }
  }
  for (const [callId, { command, loc }] of calls) {
    if (!results.has(callId)) {
      out.push(violation('P3', loc, `tool/call ${callId}（命令 ${command || '(未知)'}）没有配对的 tool/result——孤儿调用（中断/失败未落结果），考古提取将缺该输出`));
    }
  }
  // 双向（T1 增量）：孤儿 result = result 无对应 tool/call。
  // 折叠后 wire 流中无主 tool 消息 = provider 拒绝风险（W1/W2 同族、不同层）；
  // 与孤儿 call 同为 warning 级——合法场景（中断/修复产物）不破坏日志。
  for (const [callId, loc] of results) {
    if (!calls.has(callId)) {
      out.push(violation('P3', loc, `tool/result ${callId} 没有配对的 tool/call——孤儿结果（无主 tool 消息，wire 流 provider 拒绝风险；中断/修复产物合法但要审计），考古配对将无法归属`));
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
 * P4 —— tool/result 输出结构契约（考古 B2）。
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
 * chunk 全部引用进新 assistant/message（某真实会话的 chunk 源引用跨 step 7/8/9）→
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

/**
 * G · 迁移预检（payload 层 + 类型层）——**官方迁移会不会拒**，与"本工具能否读取/折叠"是
 * **两个独立维度**（见 contracts.js 的 LAYER.MIGRATION 段）。
 *
 * 覆盖（每条都有一手出处，官方 `@0.1.5-rc.2`）：
 * - **G1** `subagent/descriptor.data.version !== 3`
 * - **G2** 事件类型不在官方 v0 dispositions 内（含 `ignorable:true`）
 * - **G3** `session/title` / `session/title-llm-request` 的 `messageSeqs`（`v0-to-v1/lib/index.js:2543-2556`）
 *
 * 仍未覆盖（由 `migrationVerdict().coverage.uncovered` 显式列出，**不许**当通过）：
 * `turn/start`（闭合/预期轮）、继承切点、`assistant/attempt` 配对、`stored log corrupt`、
 * v0→v1 对其余事件的形状拒绝。
 *
 * **为什么 `turn/start` 不做（第五轮实测结论）**：官方那个状态机（`v0-to-v1:2270` 的
 * `assertReleasedArtifactRelationships`）**不是**在原始 v0 事件上跑的——它由 **v1→v2**
 * 以 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 调用在**变换后的 v1/v2 artifact** 上
 * （`v1-to-v2/lib/index.js:104`），并带 `cut`（继承切点）处理。第五轮实测：在原始 v0 上照抄该
 * 状态机会在**已 seed 的会话**上狂报（样本（某真实会话）：v0→v1 官方并不以该规则拒绝，
 * 而原始 v0 上会报 19 条），属"规则文本对、应用对象错"。要忠实复现必须先把 v0→v1→v2 的
 * 变换做出来 ⇒ 记未覆盖。
 *
 * 范围：三条都只约束 **v0 源文件**（官方 v0→v1 迁移的规则；v1/v2 源走别的迁移代码）。
 * severity 固定 warning、layer 固定 migration ⇒ 不进 ok / loadable / resumable / compactable。
 *
 * @param {Array<{event:object, lineNo?:number}>} events 已展开事件（带 loc 包装）
 * @param {number} version 被检文件版本
 */
export function migrationPrecheckViolations(events, version) {
  const out = [];
  if (version !== 0) return out;
  for (const { event, lineNo } of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'subagent/descriptor') {
      const dv = event.data?.version;
      if (dv !== 3) {
        out.push(violation('G1', { seq: event.seq, lineNo, eventType: event.type },
          `subagent/descriptor data.version=${JSON.stringify(dv)}（官方 v0→v1 迁移要求 === 3）—— 升级到当前格式时官方会拒绝：subagent/descriptor ${event.seq} uses unsupported descriptor version ${String(dv)}`));
      }
    }
    if (typeof event.type === 'string' && !V0_EVENT_TYPES.has(event.type)) {
      // 官方对"unknown historical event"一律拒（原文 even when ignorable）；E3 的 ignorable
      // 豁免只作用于**读取路径**，这里不改它，只在迁移维度表达。
      out.push(violation('G2', { seq: event.seq, lineNo, eventType: event.type },
        `type "${event.type}" 不在官方 v0 dispositions 内${event.ignorable === true ? '（即使 ignorable:true）' : ''}—— 官方迁移会拒：format v0 contains unknown historical event type`));
    }
  }
  // ── G3 · session/title 系列 messageSeqs（官方 v0→v1 `assertTitleSources`，:2543-2556）──
  // 判据：每个被引 seq 必须解析到更早的 `user/message`，且 `data.source.kind === 'user'`；
  // 另 `session/title` 的 `source.kind === 'user'` ⟺ `messageSeqs` 空。
  //
  // ⚠️ 应用面说明（第五轮实测，2026-09-15）：官方 `assertTitleSources` 与 `turn/start` 状态机
  //    同在 `assertReleasedArtifactRelationships` 里，而该函数被 **v1→v2** 以
  //    `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 调用在**变换后的 v1/v2 artifact** 上
  //    （`dsh-session-format-v1-to-v2/lib/index.js:104`），不是原始 v0 事件。
  //    对 `messageSeqs` 这类"按 seq 索引 + 事件类型/source 判定"的引用，变换保序保类型
  //    ⇒ 在原始 v0 上判是**必要条件的近似**；实测 281 个真实 v0 上 **0 误报**（round5/rule-probe）。
  const bySeq = new Map();
  for (const { event } of events) if (event && typeof event === 'object') bySeq.set(event.seq, event);
  for (const { event, lineNo } of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type !== 'session/title' && event.type !== 'session/title-llm-request') continue;
    const seqs = event.data?.messageSeqs;
    if (!Array.isArray(seqs)) {
      out.push(violation('G3', { seq: event.seq, lineNo, eventType: event.type },
        `${event.type} ${event.seq} 的 messageSeqs 必须是数组 —— 官方迁移会拒`));
      continue;
    }
    if (event.type === 'session/title') {
      const kind = event.data?.source?.kind;
      if ((seqs.length === 0) !== (kind === 'user')) {
        out.push(violation('G3', { seq: event.seq, lineNo, eventType: event.type },
          `session/title ${event.seq} messageSeqs must be empty exactly for a user title（官方原文；source.kind=${String(kind)}，seqs=${seqs.length}）`));
      }
    }
    for (const s of seqs) {
      const src = bySeq.get(s);
      if (!src || src.type !== 'user/message' || src.data?.source?.kind !== 'user') {
        out.push(violation('G3', { seq: event.seq, lineNo, eventType: event.type },
          `${event.type} ${event.seq} messageSeqs must cite earlier human user/message events（seq ${String(s)} 不是更早的人类 user/message）`));
      }
    }
  }
  return out;
}
