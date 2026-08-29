/**
 * dsh-log-contract · lib/archaeology.js
 *
 * 会话日志考古（任务书 dsh-会话日志考古-插件任务与方法.md）——两插件共享：
 * retrace 的考古界面/导出（A1-A4）与 log-contract 的 extract/audit-report
 * （B3/B4）都消费这里的纯函数。**只读不写**（纪律 §8.1）。
 *
 * 核心事实（§2）：
 * - tool/call 的 `data.callId` ↔ tool/result 的 `data.message.source.callId`
 *   配对（不可用"上一个 call"推断）；
 * - tool/call 的 `data.arguments`（JSON 串）含 `command`（命令考古）；
 * - tool/result 的 `data.message.content` 是嵌套 text 结构（输出考古）。
 */
/** 元数据字段：不参与考古文本提取。 */
const META_KEYS = new Set([
  'type', 'toolCallId', 'isError', 'id', 'role', 'source', 'name', 'status',
  'usage', 'provider', 'model', 'callId', 'kind', 'version', 'error',
  'title', 'timestamp', 'threadId', 'messageId', 'sessionId', 'plugin',
]);

/**
 * 递归提取 content 中的全部 text（保留顺序，换行连接）。
 * 只收集 `{type:'text', text}` 块与裸字符串；`tool-result` 之类的类型标签、
 * toolCallId/isError 等元数据字段一律跳过——避免提取到类型名而非内容。
 */
export function extractText(content) {
  const parts = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      if (node.type === 'text' && typeof node.text === 'string') {
        parts.push(node.text);
        return;
      }
      for (const key of Object.keys(node)) {
        if (META_KEYS.has(key)) continue;
        if (key === 'text' && typeof node[key] === 'string') {
          parts.push(node[key]);
          continue;
        }
        walk(node[key]);
      }
    }
  };
  walk(content);
  return parts.join('\n');
}

/** 解析 tool/call 的 arguments（JSON 串容错）。 */
export function toolCommandOf(event) {
  if (event?.type !== 'tool/call') return '';
  try {
    const args = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments;
    return typeof args?.command === 'string' ? args.command : '';
  } catch {
    return '';
  }
}

/**
 * 提取会话内工具调用 → 输出 的配对表（考古 A1/A2/B3 的基础）。
 *
 * @param events - 会话事件数组（按日志顺序）。
 * @returns {{
 *   calls: Map<callId, { command: string, callSeq: number }>,
 *   outputs: Map<callId, { text: string, size: number, resultSeq: number }>,
 *   orphans: string[],          // 无 result 的 callId（P3 同源）
 * }}
 */
export function indexToolCalls(events) {
  const calls = new Map();
  const outputs = new Map();
  for (const event of events) {
    if (event.type === 'tool/call') {
      const callId = event.data?.callId;
      if (typeof callId === 'string' && callId !== '') {
        calls.set(callId, { command: toolCommandOf(event), callSeq: event.seq });
      }
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      if (typeof callId === 'string' && callId !== '') {
        const text = extractText(event.data?.message?.content);
        outputs.set(callId, { text, size: text.length, resultSeq: event.seq });
      }
    }
  }
  const orphans = [...calls.keys()].filter((callId) => !outputs.has(callId));
  return { calls, outputs, orphans };
}

/**
 * 按命令正则导出工具输出（考古 A2/B3）。
 *
 * @param events - 会话事件数组。
 * @param pattern - 命令正则（字符串或 RegExp；字符串按子串匹配，空则全量）。
 * @param opts.minSize - 输出最小字节数过滤（默认 0；任务书用 50 过滤噪声）。
 * @returns {{ pairs: Array<{ callId, command, text, size }>, matched: number, total: number }}
 */
export function extractToolOutputs(events, pattern = '', { minSize = 0 } = {}) {
  const { calls, outputs } = indexToolCalls(events);
  const re = pattern instanceof RegExp ? pattern : (pattern ? new RegExp(pattern) : null);
  const pairs = [];
  for (const [callId, call] of calls) {
    const matched = re === null || re.test(call.command);
    if (!matched) continue;
    const output = outputs.get(callId);
    if (!output || output.size < minSize) continue;
    pairs.push({ callId, command: call.command, text: output.text, size: output.size });
  }
  return { pairs, matched: pairs.length, total: calls.size };
}

/**
 * 会话考古审计报告（B4）：调用数 / 配对率 / 孤儿数 / 命令分布。
 *
 * @param events - 会话事件数组。
 * @returns {{
 *   calls, results, paired, orphans, pairingRate,
 *   commands: { top: Array<{ command, count }>, distinct },
 *   outputBytes, largest: { callId, command, size } | null,
 * }}
 */
export function auditToolCalls(events) {
  const { calls, outputs, orphans } = indexToolCalls(events);
  const commandCounts = new Map();
  for (const call of calls.values()) {
    const key = call.command || '(no-command)';
    commandCounts.set(key, (commandCounts.get(key) ?? 0) + 1);
  }
  const top = [...commandCounts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);
  let outputBytes = 0;
  let largest = null;
  for (const [callId, output] of outputs) {
    outputBytes += output.size;
    if (!largest || output.size > largest.size) {
      largest = { callId, command: calls.get(callId)?.command ?? '', size: output.size };
    }
  }
  const paired = outputs.size;
  return {
    calls: calls.size,
    results: outputs.size,
    paired,
    orphans: orphans.length,
    pairingRate: calls.size > 0 ? paired / calls.size : 0,
    commands: { top: top.slice(0, 15), distinct: top.length },
    outputBytes,
    largest,
  };
}
