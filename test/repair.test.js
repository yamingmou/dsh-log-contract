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
import { repairSession, strictScanText, removeMarkersText, dropFailedTurnsText, trimLastMessagesText, trimLastMessagesByBudget, estimateTokensText, tailRenumberText, neutralizeOrphanText, extractTurnText, keepRangesText } from '../lib/repair.js';
import { assistantMessage, markerEvent, toolResultMessage, userMessage, validSessionEvents, writeSession, writeRawSession } from './helpers.js';

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

describe('dropFailedTurnsText', () => {
  it('删除带 error reason 的 turn/end 完整轮次并重编号', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: 'completed' } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } },
      userMessage({ seq: 4 }),
      assistantMessage({ seq: 5 }),
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'error', error: { message: 'INVALID_REQUEST' } } } },
      userMessage({ seq: 7 }),
    ];
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const r = dropFailedTurnsText(text);
    expect(r.failedTurns).toBe(1);
    const scan = strictScanText(r.text);
    expect(scan.failures).toEqual([]);
    // 失败轮次（turn/start..turn/end 3..6）被删，剩余 seq 0,1,2,3(原7)
    const kept = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(kept.some((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'error')).toBe(false);
    expect(scan.count).toBe(4);
  });
});

describe('trimLastMessagesText', () => {
  it('裁剪到最近 N 条消息、移除 marker、重编号后严格连续', () => {
    const events = [];
    for (let i = 0; i < 6; i++) {
      events.push(userMessage({ seq: i * 2 }));
      events.push(assistantMessage({ seq: i * 2 + 1 }));
    }
    events.push(markerEvent({ seq: 12, start: 0, end: 3, shadowedSeqs: [0, 1, 2, 3] }));
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const r = trimLastMessagesText(text, 4);
    expect(r.kept).toBe(4);
    const scan = strictScanText(r.text);
    expect(scan.failures).toEqual([]);
    const kept = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(kept.some((e) => e.type === 'assistant/message' && e.surfaceOp?.op === 'replace')).toBe(false);
    const result = validateSessionLog(loadSessionLog(writeTemp(r.text)));
    expect(result.ok).toBe(true);
  });
});

function writeTemp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlc-trim-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, text);
  return file;
}

describe('neutralizeMarkersText（2026-08-30 事故：turn-null marker 刷屏压垮 host）', () => {
  function markerSessionEvents() {
    return [
      userMessage({ seq: 0, text: 'hi' }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      assistantMessage({ seq: 2, turn: 1, step: 1 }),
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      // turn-null retrace marker（编辑重发，step 已关闭）：token-meter 会在此抛错 → 刷屏
      markerEvent({ seq: 4, start: 3, end: 3, shadowedSeqs: [3], id: 'retrace-edit-x' }),
      userMessage({ seq: 5, text: 'after' }),
    ];
  }

  it('中和 turn-null marker：type→retrace/marker + ignorable，删 surfaceOp，seq/行数不变', () => {
    const { neutralizeMarkersText } = require('../lib/repair.js');
    const events = markerSessionEvents();
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const beforeLines = text.split('\n').filter(Boolean).length;
    const r = neutralizeMarkersText(text);
    expect(r.neutralized).toBe(1);
    expect(r.seqs).toEqual([4]);
    const afterLines = r.text.split('\n').filter(Boolean).length;
    expect(afterLines).toBe(beforeLines); // 行数不变
    const kept = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const marker = kept.find((e) => e.seq === 4);
    expect(marker.type).toBe('retrace/marker');
    expect(marker.ignorable).toBe(true);
    expect(marker.surfaceOp).toBeUndefined();
    expect(marker.sourceEventSeqs).toBeUndefined();
    expect(marker.seq).toBe(4); // seq 不变
    expect(marker.time).toBe(5); // 时间不变
    expect(marker.data?.message?.id).toBe('retrace-edit-x'); // 内容保留
  });

  it('中和后 token-meter 折叠不再抛错（T1 0 违规）且 check 通过', () => {
    const events = markerSessionEvents();
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    // 中和前：T1 违规（token-meter 会抛）
    const before = validateSessionLog(loadSessionLog(file));
    expect(ids(before)).toContain('T1');
    // 中和后：T1 消失、foldSurface 可重放
    const { neutralizeMarkersText } = require('../lib/repair.js');
    const r = neutralizeMarkersText(text);
    const tmp = path.join(tmpdir(), 's.jsonl');
    fs.writeFileSync(tmp, r.text);
    const after = validateSessionLog(loadSessionLog(tmp));
    expect(after.violations.filter((v) => v.id === 'T1')).toHaveLength(0);
    expect(after.ok).toBe(true);
  });

  it('非 turn-null 的 assistant/message 不受影响', () => {
    const { neutralizeMarkersText } = require('../lib/repair.js');
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1, turn: 1, step: 1 }), // 合法消息，不中和
    ];
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const r = neutralizeMarkersText(text);
    expect(r.neutralized).toBe(0);
    const kept = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(kept.some((e) => e.type === 'retrace/marker')).toBe(false);
  });

  it('repairSession --neutralize 应用后 check 0 违规、seq 连续、备份存在', () => {
    const events = markerSessionEvents();
    const file = writeSession(events, { zstd: true });
    const result = repairSession(file, { neutralize: true, apply: true, backupDir: tmpdir() });
    expect(result.ok).toBe(true);
    expect(result.neutralized).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.backupPath).toBeTruthy();
    const re = validateSessionLog(loadSessionLog(file));
    expect(re.ok).toBe(true);
    expect(re.violations.filter((v) => v.id === 'T1')).toHaveLength(0);
  });

  it('真实夹具：89b3cb30 的 turn-null marker 被中和（regression 锁死事故现场）', () => {
    const { neutralizeMarkersText } = require('../lib/repair.js');
    const backup = path.join(process.env.HOME, 'opena-archive-2026-08/backups/backup-session-89b3cb30-pre-markerfix-20260830-043631.jsonl.zstd');
    if (!fs.existsSync(backup)) {
      console.warn('skip: backup fixture not present');
      return;
    }
    const { loadSessionLog } = require('../lib/log-reader.js');
    const log = loadSessionLog(backup);
    // 还原明文
    const { decompressZstd } = require('../lib/log-reader.js');
    const buf = decompressZstd(fs.readFileSync(backup));
    const text = buf.toString('utf8');
    const r = neutralizeMarkersText(text);
    expect(r.neutralized).toBeGreaterThanOrEqual(1);
    // 中和后的 seq 与备份中 turn-null marker 一致
    const turnNull = log.events.filter((x) => x.event.type === 'assistant/message' && (x.event.data?.turn == null || x.event.data?.step == null)).map((x) => x.event.seq);
    for (const s of turnNull) expect(r.seqs).toContain(s);
  }, 30000);
});

describe('clipCrossStepSourcesText（2026-08-30 第二类事故：resend 跨 step 引用）', () => {
  it('裁剪跨 step 的 sourceEventSeqs，保留同 step chunk', () => {
    const { clipCrossStepSourcesText } = require('../lib/repair.js');
    // step 7 的 chunk + step 9 的 chunk + assistant/message(step 9) 引用两者
    const events = [
      userMessage({ seq: 0, text: 'hi' }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 7 } },
      // step 7 的 chunk 行（独立行，seq 7 是展开后的值）
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 7, chunk: { type: 'text-chunks', chunks: [{ type: 'text', text: 'old' }] } } },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 7 } },
      { type: 'step/start', seq: 4, time: 5, data: { turn: 1, step: 9 } },
      { type: 'assistant/chunk', seq: 5, time: 6, data: { turn: 1, step: 9, chunk: { type: 'text-chunks', chunks: [{ type: 'text', text: 'new' }] } } },
      // resend 消息：引用 step 7 + step 9 的 chunk（跨 step → 官方 token-meter 645 行抛错）
      { type: 'assistant/message', seq: 6, time: 7, surfaceOp: 'append', sourceEventSeqs: [2, 5], data: { turn: 1, step: 9, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, message: { id: 'a-6', role: 'assistant', content: [{ type: 'text', text: 'new' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 9 } },
    ];
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const r = clipCrossStepSourcesText(text);
    expect(r.clipped).toBe(1);
    expect(r.seqs).toEqual([6]);
    const kept = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const msg = kept.find((e) => e.seq === 6);
    expect(msg.sourceEventSeqs).toEqual([5]); // 只保留 step 9 的 chunk
    // 回读验证官方判定通过
    const tmp = path.join(tmpdir(), 's.jsonl');
    fs.writeFileSync(tmp, r.text);
    const log = loadSessionLog(tmp);
    const evs = log.events.map((x) => x.event);
    let fail = false;
    for (const e of evs) {
      if (e.type !== 'assistant/message' || !e.sourceEventSeqs) continue;
      const seen = new Set();
      for (const s of e.sourceEventSeqs) {
        if (s >= e.seq || seen.has(s)) continue;
        seen.add(s);
        const src = evs[s];
        if (src?.type === 'assistant/chunk' && (src.data?.turn !== e.data?.turn || src.data?.step !== e.data?.step)) fail = true;
      }
    }
    expect(fail).toBe(false);
  });

  it('无跨 step 引用的正常消息不受影响', () => {
    const { clipCrossStepSourcesText } = require('../lib/repair.js');
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1, turn: 1, step: 1 }),
    ];
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    const r = clipCrossStepSourcesText(text);
    expect(r.clipped).toBe(0);
  });
});

describe('L4 新原语（2026-08-30 任务书 §L4 收编 tools/）', () => {
  function sessionHeader(seedLength) {
    return { type: 'session', version: 0, id: 't', createdAt: 1, seedLength };
  }

  it('tailRenumberText：尾部 seq 统一平移（delta 是减数）', () => {
    const events = [
      { type: 'user/message', seq: 0, time: 11, data: { turn: 0, text: 'hi' } },
      { type: 'assistant/message', seq: 1, time: 12, data: { turn: 0, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } } },
      { type: 'turn/end', seq: 2, time: 13, data: { turn: 0, reason: 'completed' } },
    ];
    const file = writeRawSession([JSON.stringify(sessionHeader(0)), ...events.map((e) => JSON.stringify(e))]);
    const text = fs.readFileSync(file, 'utf8');
    // 全部 +5（delta=-5）：0,1,2 → 5,6,7
    const r = tailRenumberText(text, 0, -5);
    expect(r.changed).toBe(3);
    const outEvents = JSON.parse(r.text.split('\n')[1]);
    expect(outEvents.seq).toBe(5);
    // 平移后 check 仍绿（seq 连续 5,6,7 从 0 起会被判 gap——但 tailRenumber
    // 只平移不改结构，seq 连续性由调用方负责；这里验证映射正确）
    const last = JSON.parse(r.text.trim().split('\n').pop());
    expect(last.seq).toBe(7);
  });

  it('neutralizeOrphanText：孤儿 spliced removedCount→0（原地不动 seq/行数）', () => {
    const events = [
      { type: 'agent/inbox/spliced', seq: 10, time: 11, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'agent/inbox/spliced', seq: 11, time: 12, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'x' }] }] } },
    ];
    const file = writeRawSession([JSON.stringify(sessionHeader(10)), ...events.map((e) => JSON.stringify(e))]);
    const text = fs.readFileSync(file, 'utf8');
    const beforeLines = text.split('\n').length;
    const r = neutralizeOrphanText(text);
    expect(r.neutralized).toBe(1);
    expect(r.seqs).toEqual([10]);
    const afterLines = r.text.split('\n').length;
    expect(afterLines).toBe(beforeLines);
    const target = JSON.parse(r.text.split('\n')[1]);
    expect(target.data.removedCount).toBe(0);
    expect(target.seq).toBe(10); // seq 不变
  });

  it('extractTurnText：只保留目标轮次 + 无 turn 系统事件，其余删除重编号', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 11, data: { turn: 1, text: 'a' } },
      { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: 'completed' } },
      { type: 'turn/start', seq: 3, time: 13, data: { turn: 2 } },
      { type: 'user/message', seq: 4, time: 14, data: { turn: 2, text: 'b' } },
      { type: 'turn/end', seq: 5, time: 15, data: { turn: 2, reason: 'completed' } },
    ];
    const file = writeRawSession([JSON.stringify(sessionHeader(0)), ...events.map((e) => JSON.stringify(e))]);
    const text = fs.readFileSync(file, 'utf8');
    const r = extractTurnText(text, 2);
    expect(r.kept).toBeGreaterThan(0);
    // 只保留轮次 2 的 3 行 + header = 4 行
    expect(r.text.split('\n').filter((l) => l.trim()).length).toBe(4);
    // 重编号后 seq 连续 0,1,2
    const turns = r.text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(turns[1].data.turn).toBe(2);
    expect(turns[1].seq).toBe(0);
    expect(turns[3].seq).toBe(2);
  });

  it('keepRangesText：只保留指定行区间，其余删除重编号（header 恒保留）', () => {
    const events = [
      { type: 'user/message', seq: 0, time: 11, data: { turn: 0, text: 'a' } },
      { type: 'user/message', seq: 1, time: 12, data: { turn: 0, text: 'b' } },
      { type: 'user/message', seq: 2, time: 13, data: { turn: 0, text: 'c' } },
    ];
    const file = writeRawSession([JSON.stringify(sessionHeader(0)), ...events.map((e) => JSON.stringify(e))]);
    const text = fs.readFileSync(file, 'utf8');
    // 行 1=header, 2=seq0, 3=seq1, 4=seq2；保留 2-3 → seq 0,1
    const r = keepRangesText(text, '2-3');
    const kept = r.text.split('\n').filter((l) => l.trim());
    expect(kept.length).toBe(3); // header + 2 行
    expect(JSON.parse(kept[1]).seq).toBe(0);
    expect(JSON.parse(kept[2]).seq).toBe(1);
    expect(JSON.parse(kept[2]).data.text).toBe('b');
  });

  it('repairSession 干跑能检出 neutralize-orphan（62c5b531 夹具）', () => {
    const f = path.join(process.env.HOME, 'opena-archive-2026-08/backups/backup-session-62c5b531-pre-inboxfix-20260828-202840.jsonl.zstd');
    if (!fs.existsSync(f)) {
      console.warn('skip: fixture not present');
      return;
    }
    const r = repairSession(f, { neutralizeOrphan: true });
    expect(r.issues.some((i) => i.kind === 'neutralize-orphan')).toBe(true);
  }, 30000);
});

describe('L5 trim 预算校准（2026-08-30 任务书 §L5）', () => {
  it('estimateTokensText：1000 中文字符 ≈ 940 tokens（×0.94，不是 ÷4）', () => {
    const text = JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '中'.repeat(1000) }] } });
    const est = estimateTokensText(text + '\n');
    // 940（字符×0.94）+ 12（envelope 开销）= 952
    expect(est.tokens).toBeGreaterThanOrEqual(940);
    expect(est.tokens).toBeLessThanOrEqual(960);
    expect(est.cjk).toBe(1000);
  });

  it('estimateTokensText：ASCII 文本密度远低于中文（×0.25）', () => {
    const text = JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'a'.repeat(1000) }] } });
    const est = estimateTokensText(text + '\n');
    // 1000×0.25 + 12 = 262
    expect(est.tokens).toBeLessThanOrEqual(280);
    expect(est.other).toBe(1000);
  });

  it('trimLastMessagesByBudget：预算不足时自动选保留数且 ≤ 预算', () => {
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push(userMessage({ seq: i * 2, text: '中'.repeat(100) }));
      events.push(assistantMessage({ seq: i * 2 + 1, text: '答'.repeat(100) }));
    }
    const file = writeSession(events);
    const text = fs.readFileSync(file, 'utf8');
    // 每条消息 ≈ 100×0.94+12 = 106 tokens；40 条 ≈ 4240 → 预算 600 只够 ~5 条
    const r = trimLastMessagesByBudget(text, 600);
    expect(r.estimatedTokens).toBeLessThanOrEqual(600);
    expect(r.kept).toBeGreaterThanOrEqual(5); // 下限保护
    expect(r.removed).toBeGreaterThan(0);
    // 裁剪后 check 绿（seq 重编号连续）
    const tmp = path.join(os.tmpdir(), `lc-l5-${Date.now()}.jsonl`);
    fs.writeFileSync(tmp, r.text);
    const after = validateSessionLog(loadSessionLog(tmp));
    expect(after.ok).toBe(true);
  });

  it('trimLastMessagesByBudget：预算充足时不裁剪', () => {
    const file = writeSession(validSessionEvents());
    const text = fs.readFileSync(file, 'utf8');
    const r = trimLastMessagesByBudget(text, 1_000_000);
    expect(r.removed).toBe(0);
    expect(r.kept).toBe(2); // validSessionEvents = user + assistant 两条消息（turnEnd 不计）
  });
});
