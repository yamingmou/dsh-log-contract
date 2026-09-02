/**
 * dsh-log-contract · test/helpers.js
 *
 * 测试夹具：构造合法/违规会话事件与临时日志文件。
 * 合法事件形状对齐官方 `assertMessageEventShape` 与 surface 契约。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

export const HEADER = { type: 'session', version: 0, id: 'test-session', createdAt: 1 };

export function userMessage({ seq, text = 'hi' } = {}) {
  // 实证形状：user/message 的 data 就是消息本体（无 turn/step）
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: { id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

export function assistantMessage({ seq, turn = 0, step = 1, text = 'yo', id = `a-${seq}` } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: { id, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text }] },
    },
  };
}

export function turnEnd({ seq, turn = 0, reason = { kind: 'completed' } } = {}) {
  return { type: 'turn/end', seq, time: seq + 1, data: { turn, reason } };
}

/** 插件 marker（retrace 式）：assistant/message replace，data.turn/step 为 null。 */
export function markerEvent({ seq, start, end, shadowedSeqs, id = 'retrace-edit-x', text = 'edited', turn = 1, step = 1 } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: shadowedSeqs,
    data: {
      turn,
      step,
      message: { id, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text }] },
      editor: { targetSeq: start, text },
    },
  };
}

/** tool/result 消息（data.turn/step + message 内嵌，role=user，tool source）。 */
export function toolResultMessage({ seq, turn = 0, step = 0, callId = 'call-1', text = 'ok' } = {}) {
  return {
    type: 'tool/result',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: `t-${seq}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  };
}

/** 一条迷你合法会话：user → assistant → turn/end。 */
export function validSessionEvents() {
  return [
    userMessage({ seq: 0 }),
    assistantMessage({ seq: 1 }),
    turnEnd({ seq: 2 }),
  ];
}

function linesFor(events) {
  return [JSON.stringify(HEADER), ...events.map((e) => JSON.stringify(e))];
}

/**
 * 写临时会话日志（默认明文 .jsonl；zstd 用 node:zlib 压缩）。
 * @returns 临时文件路径
 */
export function writeSession(events, { zstd = false, torn = false, header = HEADER } = {}) {
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  const text = lines.join('\n') + '\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const file = path.join(dir, zstd ? 'session.jsonl.zstd' : 'session.jsonl');
  if (zstd) {
    const compressed = zstdCompressSync(Buffer.from(text));
    fs.writeFileSync(file, torn ? compressed.subarray(0, Math.max(4, compressed.length - 7)) : compressed);
  } else {
    fs.writeFileSync(file, text);
  }
  return file;
}

/** 写一个原始行文本（用于 R1/R2 坏行夹具）。 */
export function writeRawSession(lines, { zstd = false } = {}) {
  const text = lines.join('\n') + '\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const file = path.join(dir, zstd ? 'session.jsonl.zstd' : 'session.jsonl');
  fs.writeFileSync(file, zstd ? zstdCompressSync(Buffer.from(text)) : text);
  return file;
}
