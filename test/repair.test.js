/**
 * dsh-log-contract · test/repair.test.js
 *
 * 修复工具测试（2026-08 事故固化）：
 *  - W1 wire 悬空 tool（严格端点 INVALID_REQUEST 类）
 *  - strictScanText 严格 seq 连续
 *  - removeMarkersText 移除 retrace marker + 重编号
 *  - repairSession 干跑 / 应用（备份 + 正确 zstd 帧 + 结尾换行）
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { loadSessionLog } from '../lib/log-reader.js';
import { validateSessionLog } from '../lib/validate.js';
import { repairSession, strictScanText, removeMarkersText } from '../lib/repair.js';
import { assistantMessage, markerEvent, toolResultMessage, userMessage, writeSession } from './helpers.js';

function ids(result) {
  return result.violations.map((v) => v.id);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dlc-repair-'));
}

/** 带 tool-call block 的 assistant 消息（wire 检查需要）。 */
function assistantWithToolCall({ seq, turn = 0, step = 1, callId = 'call-1', name = 'bash' } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: `a-${seq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'test' },
        content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
      },
    },
  };
}

describe('W1 wire 悬空 tool', () => {
  it('marker 遮蔽 assistant(tool_calls) 但漏盖 tool/result → W1', () => {
    // user(0) → assistant-with-tool-call(1) → tool/result(2) → marker(3, 只遮蔽 [1..1])
    const events = [
      userMessage({ seq: 0 }),
      assistantWithToolCall({ seq: 1 }),
      toolResultMessage({ seq: 2, callId: 'call-1' }),
      markerEvent({ seq: 3, start: 1, end: 1, shadowedSeqs: [1] }),
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 0, reason: 'completed' } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(false);
    expect(ids(result)).toContain('W1');
  });

  it('完整 tool 回合（assistant(tool_calls) → tool 结果）零 W 违规', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantWithToolCall({ seq: 1 }),
      toolResultMessage({ seq: 2, callId: 'call-1' }),
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 0, reason: 'completed' } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(true);
    expect(ids(result).filter((id) => id.startsWith('W'))).toEqual([]);
  });
});

describe('strictScanText', () => {
  it('合法日志零失败且计数正确', () => {
    const file = writeSession([
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 0 } },
    ]);
    const text = fs.readFileSync(file, 'utf8');
    const r = strictScanText(text);
    expect(r.failures).toEqual([]);
    expect(r.count).toBe(3);
  });

  it('seq 倒退（重复 seq）被捕获', () => {
    const lines = [JSON.stringify({ type: 'session', version: 0, id: 'x' }), JSON.stringify(userMessage({ seq: 0 })), JSON.stringify(userMessage({ seq: 0 }))];
    const text = lines.join('\n') + '\n';
    const r = strictScanText(text);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures[0].got).toBe(0);
    expect(r.failures[0].expected).toBe(1);
  });
});

describe('removeMarkersText', () => {
  it('移除 retrace marker 并重编号后续事件与引用', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 1] }),
      userMessage({ seq: 3 }),
    ];
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const r = removeMarkersText(text);
    expect(r.removed).toBe(1);
    // 重编号后第 4 个事件（原 seq 3）应为 seq 2
    const lines = r.text.split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.seq).toBe(2);
    const scan = strictScanText(r.text);
    expect(scan.failures).toEqual([]);
  });
});

describe('repairSession', () => {
  it('干跑（--remove-markers 不落盘）报告可移除数与检查结果', () => {
    const dir = tmpdir();
    const file = writeSession(
      [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 1] }), userMessage({ seq: 3 })],
      { zstd: true },
    );
    const before = fs.readFileSync(file);
    const r = repairSession(file, { removeMarkers: true });
    expect(r.removed).toBe(1);
    expect(r.applied).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true); // 干跑不动文件
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('应用修复后文件可加载、无违规、结尾单个换行、帧结构正确', () => {
    const dir = tmpdir();
    const file = writeSession(
      [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 1] }), userMessage({ seq: 3 })],
      { zstd: true },
    );
    const r = repairSession(file, { removeMarkers: true, apply: true, backupDir: dir });
    expect(r.applied).toBe(true);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.backupPath)).toBe(true);
    // 解码验证：结尾单个换行 + 可加载 + 零违规
    const buf = fs.readFileSync(file);
    const plain = zstdDecompressSync(buf).toString('utf8');
    expect(plain.endsWith('\n')).toBe(true);
    expect(plain.endsWith('\n\n')).toBe(false);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(true);
    // 帧1 = header 行
    const header = plain.slice(0, plain.indexOf('\n') + 1);
    const f1 = buf.subarray(0, zstdFrameEnd(buf));
    expect(zstdDecompressSync(f1).toString('utf8')).toBe(header);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** 扫描首个 zstd 帧的结束偏移（简版，仅测试用）。 */
function zstdFrameEnd(buf) {
  const magic = 4247762216;
  let offset = 0;
  offset += 4;
  const descriptor = buf.readUInt8(offset);
  offset += 1;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const dictFlag = descriptor & 3;
  const dictBytes = dictFlag === 3 ? 4 : dictFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  offset += (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
  for (;;) {
    const bh = buf.readUInt32LE(offset);
    offset += 3;
    const last = (bh & 1) !== 0;
    offset += (bh >>> 3) & 0x1fffff;
    if (last) break;
  }
  if ((descriptor & 4) !== 0) offset += 4;
  return offset;
}
