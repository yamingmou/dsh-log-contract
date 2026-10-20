/**
 * dsh-log-contract · adapters/dsh/event-shapes.js
 *
 * DSH 专属：事件形状判定（信封 / 消息 / 存储行 / 工具配对 / 可忽略标记 / 来源引用）。
 *
 * 平台无关的不变量在 contract/invariants.js；本文件负责把 DSH 记录**规范化**成
 * 契约层认识的记录视图，再交给不变量判定（序号存在性、负载无损、物理序单调等）。
 */
import { toPlatformViolations, violation } from './rule-ids.js';
import {
  isSafeInt,
  isPlainRecord,
  ordinalViolations,
  payloadLosslessViolations,
  physicalOrderViolations as physicalOrderInvariant,
} from '../../contract/invariants.js';
import { ENVELOPE_ALLOWED_KEYS, CHUNK_ROW_TYPES } from './vocab.js';
import { currentVocabulary } from './format-versions.js';

/** 事件信封 shape：seq/type/time/data（E1/E3/E4/E5/E6）。version = 被检文件版本。 */
export function envelopeViolations(event, loc, version) {
  const out = [];
  out.push(...toPlatformViolations(ordinalViolations([{ seq: event.seq, lineNo: loc.lineNo, eventType: loc.eventType }]).violations));
  if (typeof event.type !== 'string') {
    out.push(violation('E3', loc, `事件缺少 type 字符串（${String(event.type)}）`));
  } else if (!currentVocabulary(version).has(event.type) && event.ignorable !== true) {
    out.push(violation('E3', loc, `type "${event.type}" 不在已知词汇表内且未带 ignorable 标记（可能由更新版本的 harness 写入）`));
  }
  out.push(...toPlatformViolations(payloadLosslessViolations(event, loc, {
    required: ['data'],
    optional: ['surfaceOp', 'sourceEventSeqs'],
  }).violations));
  if (event.type === 'request/header-delta') {
    out.push(violation('E5', loc, '使用已删除的遗留格式 request/header-delta——写入会成功（宿主 append 不看 type）、下一次读取才炸；请改用当前格式'));
  }
  if (event.type === 'request/header' && event.data?.reason === 'fallback') {
    out.push(violation('E5', loc, 'request/header 使用已删除的遗留 reason "fallback"'));
  }
  // ── 确证漏检形状补成候选规则 ───────────────────────────────────────
  // E8 信封键白名单:宿主 `assertSessionEventEnvelope`（@deepseek-ai/dsh-session@0.1.5-rc.1
  //   lib/index.js:[n]-[n]）逐键 switch,只认 7 个键,其余一律 `invalid event envelope`。
  //   反例形状：宿主拒、旧契约漏检。
  if (typeof event === 'object' && event !== null) {
    const extra = Object.keys(event).filter((k) => !ENVELOPE_ALLOWED_KEYS.has(k));
    if (extra.length > 0) {
      out.push(violation('E8', loc, `事件信封含多余键 ${extra.join(', ')}——宿主只认 {${[...ENVELOPE_ALLOWED_KEYS].join(',')}}（dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]）`));
    }
  }
  // E10 request/header 的 data 字段约束:宿主 `validateSessionEventData`
  //   （dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]）——`header.system` 必须省略、
  //   空 tools / 空 adapterDefaults 必须省略。反例：宿主拒、旧契约漏检。
  if (event.type === 'request/header') {
    const header = event.data?.header;
    if (typeof header !== 'object' || header === null || Array.isArray(header)) {
      out.push(violation('E10', loc, 'request/header 的 data.header 必须是对象'));
    } else {
      if (Object.hasOwn(header, 'system')) out.push(violation('E10', loc, 'request/header 必须省略 header.system（系统提示改走 system/message）——宿主 lib/index.js:[n]'));
      if (Array.isArray(header.tools) && header.tools.length === 0) out.push(violation('E10', loc, 'request/header 必须省略空 tools——宿主 lib/index.js:[n]'));
      const defaults = header.adapterDefaults;
      if (typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults) && Object.keys(defaults).length === 0) {
        out.push(violation('E10', loc, 'request/header 必须省略空 adapterDefaults——宿主 lib/index.js:[n]-[n]'));
      }
    }
  }
  out.push(...messageShapeViolations(event, loc, version));
  return out;
}


/** v4 消息类事件 → 期望 role（dsh-session@0.2.0-rc.2 `MESSAGE_ROLE_BY_TYPE`，`src/index.ts:[n]-[n]`）。 */
const V4_MESSAGE_ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
};

/**
 * 镜像官方 assertMessageEventShape（lib/index.js:[n]-[n]）。**按被检文件版本**择路：
 * v0–v3 → 旧形状（下方原逻辑）；v4 → `v4MessageShapeViolations`。
 */
export function messageShapeViolations(event, loc, version) {
  if (version >= 4) return v4MessageShapeViolations(event, loc);
  const type = event.type;
  // 把 v3 新增的 `system/message` 纳入形状检查（MESSAGE_ROLE_BY_TYPE:system/message → system,
  // dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n];source 要求 :[n]-[n]）。旧实现只查 user/assistant/tool
  // ⇒ 反例（system/message 的 source.kind='user'）宿主拒、旧契约漏检。
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
    // E9(候选规则):system/message 必须 plugin source（kind==='plugin' + plugin 非空）。
    // 宿主依据:dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]（"must have plugin source"）。
    if (source?.kind !== 'plugin' || typeof source.plugin !== 'string' || source.plugin === '') {
      out.push(violation('E9', loc, `${shape()}：system/message 必须带 plugin source（kind==='plugin' 且 plugin 非空）——宿主 lib/index.js:[n]-[n]`));
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

/**
 * v4 消息形状。两层一手依据：
 * - 运行时 load 路径：dsh-session@0.2.0-rc.2 `assertMessageEventShape`（`src/index.ts:[n]-[n]`）——
 *   role 表、system-prompt source、model source、tool source + `toolCallId` 匹配；
 * - 文件读取路径：`dsh-session-format-v3-to-v4` 原生 v4 准入（`src/tool-role.ts:89-[n]`、
 *   `src/message-sources.ts:9`）——残留 `tool-result` 包装块、非布尔 `isError`、`data.error` 而
 *   `isError !== true`、`source.kind === 'plugin'` 一律 SessionFormatError ⇒ 会话从盘上读不回来。
 *   `adoptSessionEvent` 不查这几条，所以只看运行时会漏掉"写得进、读不回"的形状。
 *
 * 与 v3 的差异（v3→v4 迁移 `tool-role.ts` / `sources.ts` 的逐项改写）：
 * - 新增 `developer/message`（role `developer`）；
 * - `tool/result`：role `tool`；去掉 `tool-result` 包装块，content 直接是结果数组；
 *   `message.toolCallId` 必须等于 `source.callId`；`isError` 若存在必须为布尔；
 * - `system/message`：source.kind 必须为 `system-prompt`（v3 是 plugin 包装）；
 * - 任何消息的 source.kind 都不得为 `plugin`（v4 把插件包装改写成生产者自有 kind）。
 */
function v4MessageShapeViolations(event, loc) {
  const type = event.type;
  const expectedRole = V4_MESSAGE_ROLE_BY_TYPE[type];
  if (expectedRole === undefined) return [];
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
  if (message.role !== expectedRole) {
    out.push(violation('E6', loc, `${shape()}：role 必须为 "${expectedRole}"，实际 ${String(message.role)}`));
  }
  const source = message.source;
  if (typeof source !== 'object' || source === null || typeof source.kind !== 'string' || source.kind === '') {
    out.push(violation('E6', loc, `${shape()}：source.kind 缺失或非法`));
  } else if (source.kind === 'plugin') {
    out.push(violation('E6', loc, `${shape()}：v4 不再接受 plugin source（kind==='plugin'）——v3→v4 迁移把它改写为生产者自有 kind`));
  }
  if (!Array.isArray(message.content)) {
    out.push(violation('E6', loc, `${shape()}：content 必须为数组`));
  }
  if (type === 'assistant/message') {
    if (source?.kind !== 'model' || typeof source.provider !== 'string' || source.provider === '' || typeof source.model !== 'string' || source.model === '') {
      out.push(violation('E6', loc, `${shape()}：assistant/message 必须带 model source（provider/model 非空）`));
    }
  }
  if (type === 'system/message' && source?.kind !== 'system-prompt') {
    out.push(violation('E9', loc, `${shape()}：system/message 必须带 system-prompt source（kind==='system-prompt'）——dsh-session@0.2.0-rc.2 src/index.ts:[n]-[n]`));
  }
  if (type === 'tool/result') {
    if (source?.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
      out.push(violation('E6', loc, `${shape()}：tool/result 必须带 tool source（callId 非空）`));
    } else if (message.toolCallId !== source.callId) {
      out.push(violation('E6', loc, `${shape()}：message.toolCallId 与 source.callId 不匹配`));
    }
    if (Array.isArray(message.content) && message.content.some((b) => typeof b === 'object' && b !== null && b.type === 'tool-result')) {
      out.push(violation('E6', loc, `${shape()}：v4 tool/result 不得再含 tool-result 包装块（content 直接是结果数组）`));
    }
    if (message.isError !== undefined && typeof message.isError !== 'boolean') {
      out.push(violation('E6', loc, `${shape()}：isError 若存在必须为布尔`));
    }
    if (record?.error !== undefined && message.isError !== true) {
      out.push(violation('E6', loc, `${shape()}：带 data.error 时 message.isError 必须为 true`));
    }
  }
  return out;
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
  const results = new Map(); // callId → loc（双向：孤儿 result 也要指认）
  for (const { event, lineNo } of events) {
    if (event.type === 'tool/call') {
      const callId = event.data?.callId;
      if (typeof callId === 'string' && callId !== '') {
        let command = '';
        try {
          const args = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments;
          command = typeof args?.command === 'string' ? args.command.slice(0, [n]) : '';
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
  // 双向：孤儿 result = result 无对应 tool/call。
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
 * E7 —— ignorable 未知 type 合法性。
 *
 * 盲区：E3 对"未知 type + ignorable:true"直接internal（容忍更新版本 harness 写入），
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
 * S10 —— `sourceEventSeqs` 元素类型硬断言。
 *
 * 嵌套 `[a,b]` 会被投影层／`restore` **静默放过** ⇒ 契约层必须判红。但 `[a,b]` 本身是
 * v3+ 的**官方存储形态**（`encodeSeqRanges` 把连续 ≥3 的 run 压成闭区间对，可被官方
 * `decodeSeqRanges` 展开）⇒ 不能把合法的区间对当违规。判红点收严为两层：
 *   ① **存储形态**（`rawSourceEventSeqViolations`，看 `log.rows[].value`）：元素只能是
 *      非负安全整数或 `[start,end]`（start ≤ end），且必须能被官方 `decodeSeqRanges`
 *      解出且严格递增；否则 S10 error（解码层失败 = 投影/restore 会把它当 seq）。
 *   ② **解码形态**（`sourceEventSeqElementViolations`，看已归一事件）：解码后仍出现
 *      数组/非整数 = S10 error。
 * 覆盖面比 S6 宽：**所有事件**（含非 surface 类型与 `ignorable` 未知插件事件）都判——
 * 旧实现里非 surface 事件的 `sourceEventSeqs` 只在 S2 里被顺带提一句，`ignorable` 未知
 * 事件连 S2 都豁免 ⇒ 这类事件上的坏 provenance 是真空区。
 *
 * @param {Array<{event:object,lineNo?:number}>} events 已归一（区间已展开）的事件
 * @returns S10 违规列表
 */
export function sourceEventSeqElementViolations(events) {
  const out = [];
  for (const { event, lineNo } of events ?? []) {
    if (!event || typeof event !== 'object') continue;
    const src = event.sourceEventSeqs;
    if (src === undefined) continue;
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    if (!Array.isArray(src)) {
      out.push(violation('S10', loc, `sourceEventSeqs 必须是数组（实际 ${typeof src}）——元素必须是非负整数`));
      continue;
    }
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isSafeInt(v)) continue;
      if (Array.isArray(v)) {
        out.push(violation('S10', loc, `sourceEventSeqs[${i}] 解码后仍是嵌套数组 ${JSON.stringify(v).slice(0, 80)}——元素必须是非负整数（投影/restore/重写路径会把它静默当成 seq）`));
      } else {
        out.push(violation('S10', loc, `sourceEventSeqs[${i}] 不是非负安全整数（${String(v)}，${typeof v}）——元素必须是非负整数`));
      }
    }
  }
  return out;
}

/** 单个元素是否为官方区间对 `[start,end]`（`decodeSeqRanges` 的存储形态，start ≤ end）。 */
export function isSeqRangePair(value) {
  return Array.isArray(value) && value.length === 2 && isSafeInt(value[0]) && isSafeInt(value[1]) && value[0] <= value[1];
}

/**
 * S10 · 存储形态层（见上）。只读 `loadSessionLog()` 的 `rows`（`value` = JSON.parse 原文）。
 * @param {Array<{lineNo:number,value:object|null}>} rows
 * @returns S10 违规列表
 */
export function rawSourceEventSeqViolations(rows) {
  const out = [];
  for (const row of rows ?? []) {
    const value = row?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const src = value.sourceEventSeqs;
    if (src === undefined) continue;
    const loc = { seq: Number.isSafeInteger(value.seq) ? value.seq : null, lineNo: row.lineNo, eventType: value.type };
    if (!Array.isArray(src)) {
      out.push(violation('S10', loc, `sourceEventSeqs 必须是数组（实际 ${typeof src}）`));
      continue;
    }
    let bad = null;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isSafeInt(v) || isSeqRangePair(v)) continue;
      bad = { i, v };
      break;
    }
    if (bad !== null) {
      const shape = Array.isArray(bad.v) ? `嵌套数组 ${JSON.stringify(bad.v).slice(0, 80)}` : `${String(bad.v)}（${typeof bad.v}）`;
      out.push(violation('S10', loc, `sourceEventSeqs[${bad.i}] 存储形态非法：${shape}——只允许非负安全整数或官方区间对 [start,end]（start ≤ end）`));
      continue;
    }
    // 形态合法但官方解码器解不出（区间对逆序 / 越界 / 非严格递增）⇒ 同样是契约违规。
    try {
      decodeSeqRanges(src);
    } catch (err) {
      out.push(violation('S10', loc, `sourceEventSeqs 无法按官方区间编码解码：${err.message}——投影/restore 会把它静默当成 seq`));
    }
  }
  return out;
}


/** Whether a value is a JSON-visible record (object, not null, not array)（rc.7 `isRecord`）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** Exact-key check: `value` has every key in `keys` and nothing else（rc.7 `hasExactKeys`）。 */
function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}


//#region decodeStorageRecord —— rc.7 validateRow/expandRow 的移植
/** Throw the uniform malformed-row diagnostic（rc.7 `malformed`）。 */
function malformed(tag, why) {
  throw new Error(`malformed ${tag} storage row: ${why}`);
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload（rc.7 `validateRunData`）。 */
function validateRunData(tag, data, payloadKey) {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') malformed(tag, 'turn/step/index must be numbers');
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== 'string')) malformed(tag, `${payloadKey} must be a non-empty string array`);
  const dt = data.dt;
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap))) malformed(tag, 'dt must be an array of safe integers');
  if (dt.length !== payload.length - 1) malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`);
  return payload;
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation（rc.7 `validateRow`）。 */
function validateRow(value, tag) {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) malformed(tag, 'envelope must be exactly {type, seq0, time0, data}');
  if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0) malformed(tag, 'seq0 must be a non-negative safe integer');
  if (!Number.isSafeInteger(value.time0)) malformed(tag, 'time0 must be a safe integer');
  const data = value.data;
  if (!isRecord(data)) malformed(tag, 'data must be an object');
  let payload;
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']);
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}');
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) malformed(tag, 'id (and name when present) must be strings');
    payload = validateRunData(tag, data, 'args');
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) malformed(tag, 'data must be exactly {turn, step, index, dt, texts}');
    payload = validateRunData(tag, data, 'texts');
  }
  if (!Number.isSafeInteger(value.seq0 + payload.length - 1)) malformed(tag, 'member seqs must stay safe integers');
  let time = value.time0;
  for (const gap of data.dt) {
    time += gap;
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers');
  }
  return value;
}

/** Expand a validated row back into its exact original events, in order（rc.7 `expandRow`）。 */
function expandRow(row) {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts;
  const events = [];
  let time = row.time0;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1];
    let chunk;
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] };
        break;
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] };
        break;
      case 'tool-call-chunks':
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...Object.hasOwn(row.data, 'name') ? { name: row.data.name } : {},
          argumentsDelta: members[k],
        };
        break;
      /* v8 ignore next 4 -- validateRow only returns the three row tags */
      default:
        throw new Error(`chunk-rows received unsupported row ${String(row)}`);
    }
    events.push({ type: 'assistant/chunk', seq: row.seq0 + k, time, data: { turn: row.data.turn, step: row.data.step, chunk } });
  }
  return events;
}

/**
 * 存储行解码：chunk 行校验后展开为完整事件序列，其他行原样返回（rc.7 `decodeStorageRecord`）。
 * 损坏的 chunk 行**抛错**（fail-loud）——调用方（log-reader）据此落 `row.error` → R2。
 * @param {unknown} value 已 JSON.parse 的一行
 * @returns {unknown[]} 事件数组
 */
export function decodeStorageRecord(value) {
  if (!isRecord(value)) return [value];
  const tag = value.type;
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [value];
  return expandRow(validateRow(value, tag));
}

//#region decodeSeqRanges —— v3 storage-form 区间编码解码（0.1.5 `lib/types/seq-ranges.js` 逐条移植）
// 为什么本地化：`decodeSeqRanges` 只在 0.1.5+ 从包根导出；`0.1.0-rc.7` 上为 `undefined`
// （见 vocab.js 的双宿主声明）。本包 peer 允许两个版本 ⇒ 必须在两种宿主上都能解码。
//
// 语义（官方 `seq-ranges.js:34-73`）：`sourceEventSeqs` 的 JSON 存储形态是"数字 + 闭区间对"
// 混合数组，例 `[3, [[n]], [n] …]` ⇒ 内存形态 `[[n]…]`。
// v3 持久化层对连续段用区间对压缩（真实 v3 会话中 1 个 `user/message` replace
// 的 `sourceEventSeqs` 可由区间对展开为稠密序列）。**不解码 = 拿物理未展开的序列
// 喂 S5/S6 与官方 foldSurface ⇒ 真实健康会话被误判 S5/S6/S8 + `--resume` broken。**

/** 非负安全整数（rc.7/0.1.5 `assertSeq`）。 */
function assertSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('sourceEventSeqs must contain non-negative safe integers');
}
/** 带 Session 序号 brand 的断言（官方 `SessionSeq`；额外拒绝 `-0`）。 */
function sessionSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/**
 * 展开 JSON 存储形态的 `sourceEventSeqs`（官方 `decodeSeqRanges` 逐条移植）。
 * 任一形态非法即抛 `TypeError`（fail-loud：调用方据此报 S6/E4，不静默当稠密序列）。
 * @param {unknown} value 已 JSON.parse 的 `sourceEventSeqs`
 * @param {number} [maxEntries] 该事件允许的最大成员数
 * @returns {number[]} 内存稠密序列
 */
export function decodeSeqRanges(value, maxEntries = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value)) throw new TypeError('sourceEventSeqs must be an array');
  const decoded = [];
  let hasRange = false;
  for (const entry of value) {
    if (typeof entry === 'number') {
      assertSeq(entry);
      if (decoded.length >= maxEntries) throw new TypeError('sourceEventSeqs exceeds its event sequence');
      decoded.push(sessionSeq(entry));
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('sourceEventSeqs range entries must be [start, end] pairs');
    }
    const start = entry[0];
    const end = entry[1];
    assertSeq(start);
    assertSeq(end);
    if (end < start) throw new TypeError('sourceEventSeqs ranges require start <= end');
    if (end - start + 1 > maxEntries - decoded.length) {
      throw new TypeError('sourceEventSeqs range exceeds its event sequence');
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(sessionSeq(seq));
    hasRange = true;
  }
  if (hasRange && !decoded.every((v, i) => i === 0 || v > decoded[i - 1])) {
    throw new TypeError('sourceEventSeqs ranges must be strictly increasing');
  }
  return decoded;
}

/**
 * 把一个已解码事件的 storage-form `sourceEventSeqs` 归一成内存稠密序列。
 * - 无 `sourceEventSeqs` / 非对象 → 原样返回（同一引用）；
 * - 解码成功 → 返回**新对象**（不修改入参；调用方须使用返回值）；
 * - 解码失败 → 原样返回，保留存储形态交由 S6/E4 报违规（读取层不崩、不吞错）。
 */
export function normalizeEventSeqRanges(event) {
  if (!isRecord(event) || event.sourceEventSeqs === undefined) return event;
  let expanded;
  try {
    expanded = decodeSeqRanges(event.sourceEventSeqs);
  } catch {
    return event;
  }
  return { ...event, sourceEventSeqs: expanded };
}
//#endregion


/**
 * R2 —— 存储行损坏（聚合行展开失败 = 整段 run 丢失且加载失败）。
 * @param {Array<{lineNo:number, value:object|null, error:Error|null}>} rows
 * @returns {Array<object>} R2 判定
 */
export function chunkRowMalformationViolations(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!row?.error || row.value === null) continue;
    if (!CHUNK_ROW_TYPES.has(row.value?.type)) continue;
    out.push(violation('R2', { lineNo: row.lineNo }, `chunk 行 "${row.value.type}" 损坏：${row.error.message} —— 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）`));
  }
  return out;
}

/**
 * 把物理存储行展开成**物理顺序**的规范化记录视图（供物理序不变量判定）。
 * @param {Array<{lineNo:number, decoded: object[]|null}>} rows
 * @returns {Array<{seq:unknown, lineNo:number, eventType:unknown}>}
 */
export function physicalSequence(rows) {
  const entries = [];
  for (const row of rows ?? []) {
    if (!Array.isArray(row?.decoded) || row.decoded.length === 0) continue;
    for (const event of row.decoded) {
      entries.push({ seq: event.seq, lineNo: row.lineNo, eventType: event.type });
    }
  }
  return entries;
}

/**
 * S9 —— 文件物理序序号单调（适配器包装：物理行 → 规范化记录视图）。
 * @param {Array<{lineNo:number, decoded: object[]|null}>} rows
 * @returns {Array<object>} S9 判定
 */
export function physicalOrderViolations(rows) {
  return toPlatformViolations(physicalOrderInvariant(physicalSequence(rows)).violations);
}
