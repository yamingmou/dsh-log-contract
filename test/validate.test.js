/**
 * dsh-log-contract · test/validate.test.js
 *
 * 离线体检规则测试：合法会话绿、逐条违规红。
 * 含复盘事故回归用例（S5 清空 sourceEventSeqs / M1 turn=null append）。
 */
import { describe, expect, it } from 'vitest';
import { loadSessionLog } from '../lib/log-reader.js';
import { validateSessionLog } from '../lib/validate.js';
import { tokenMeterSourceViolations } from '../lib/checks.js';
import {
  assistantMessage,
  markerEvent,
  toolResultMessage,
  turnEnd,
  userMessage,
  validSessionEvents,
  writeRawSession,
  writeSession,
} from './helpers.js';

function ids(result) {
  return result.violations.map((v) => v.id);
}

describe('合法会话', () => {
  it('迷你合法会话零违规', () => {
    const file = writeSession(validSessionEvents());
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.summary.events).toBe(3);
  });

  it('zstd 压缩会话零违规', () => {
    const file = writeSession(validSessionEvents(), { zstd: true });
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(true);
  });

  it('marker replace 完整覆盖 shadowed 节点 → 绿', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      turnEnd({ seq: 2 }),
      markerEvent({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] }),
      turnEnd({ seq: 4 }),
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(true);
  });
});

describe('事故回归用例（复盘 2026-08-25）', () => {
  it('第 1 轮：清空 sourceEventSeqs 的 replace → S5/S8 拦截', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      turnEnd({ seq: 2 }),
      markerEvent({ seq: 3, start: 0, end: 1, shadowedSeqs: [] }),
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(false);
    expect(ids(result)).toContain('S5');
    expect(ids(result)).toContain('S8');
  });

  it('S6：非 assistant/message 携带空 sourceEventSeqs → 违规', () => {
    const tr = toolResultMessage({ seq: 2 });
    tr.surfaceOp = { op: 'replace', start: 0, end: 1 };
    tr.sourceEventSeqs = [];
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), tr];
    const file = writeSession(events);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('S6');
  });

  it('第 2 轮：turn=null 的 assistant/message 以 append 进入 → M1 拦截', () => {
    const events = [
      userMessage({ seq: 0 }),
      // 缺少 data.turn/data.step 的 append
      { ...assistantMessage({ seq: 1 }), data: { turn: null, step: null, message: assistantMessage({ seq: 1 }).data.message } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(false);
    expect(ids(result)).toContain('M1');
  });
});

describe('逐条违规规则', () => {
  it('E2：seq 缺口 → 违规 + C1 并发告警 + S8 终验失败', () => {
    const events = validSessionEvents().filter((e) => e.seq !== 1);
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(false);
    expect(ids(result)).toContain('E2');
    expect(ids(result)).toContain('C1');
    expect(ids(result)).toContain('S8');
  });

  it('E3：词汇表外 type 且无 ignorable → 违规', () => {
    const events = [...validSessionEvents(), { type: 'totally/unknown', seq: 3, time: 4, data: {} }];
    const file = writeSession(events);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('E3');
  });

  it('E3：词汇表外 type 带 ignorable 标记 → 放行', () => {
    const events = [...validSessionEvents(), { type: 'totally/unknown', seq: 3, time: 4, data: {}, ignorable: true }];
    const file = writeSession(events);
    expect(validateSessionLog(loadSessionLog(file)).ok).toBe(true);
  });

  it('E5：遗留 request/header-delta → 违规', () => {
    const events = [...validSessionEvents(), { type: 'request/header-delta', seq: 3, time: 4, data: {} }];
    const file = writeSession(events);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('E5');
  });

  it('E6：assistant/message 缺 model source → 违规', () => {
    const bad = assistantMessage({ seq: 1 });
    bad.data.message.source = { kind: 'model' }; // 缺 provider/model
    const events = [userMessage({ seq: 0 }), bad];
    const file = writeSession(events);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('E6');
  });

  it('S1：surface 候选类型缺 surfaceOp → 违规', () => {
    const noOp = { ...userMessage({ seq: 0 }) };
    delete noOp.surfaceOp;
    const file = writeSession([noOp]);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('S1');
  });

  it('S2：非 surface 类型携带 surfaceOp → 违规', () => {
    const events = [...validSessionEvents(), { type: 'turn/end', seq: 3, time: 4, data: { turn: 0, reason: 'completed' }, surfaceOp: 'append' }];
    const file = writeSession(events);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('S2');
  });

  it('S4：replace 范围不在 surface 中 → 违规', () => {
    const events = [userMessage({ seq: 0 }), markerEvent({ seq: 1, start: 9, end: 10, shadowedSeqs: [0] })];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('S4');
  });

  it('S6：sourceEventSeqs 重复 → 违规', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 0] }),
    ];
    const file = writeSession(events);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('S6');
  });

  it('S7：tool/result 替换多节点 → 违规', () => {
    // tool/result 以 replace 改写 [0,1] 两个节点 → S7（必须恰好 1 个）
    const tr = toolResultMessage({ seq: 2 });
    tr.surfaceOp = { op: 'replace', start: 0, end: 1 };
    tr.sourceEventSeqs = [0, 1];
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), tr];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('S7');
  });

  it('H1：首行非 JSON → 违规', () => {
    const file = writeRawSession(['not-json{{{', '{"a":1}']);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('H1');
  });

  it('H2：header.version 非 0 → 违规', () => {
    const file = writeSession(validSessionEvents(), { header: { type: 'session', version: 1, id: 'x', createdAt: 1 } });
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('H2');
  });

  it('R1：中间行非 JSON → 违规', () => {
    const file = writeRawSession([JSON.stringify({ type: 'session', version: 0, id: 'x', createdAt: 1 }), 'garbage{{']);
    expect(ids(validateSessionLog(loadSessionLog(file)))).toContain('R1');
  });

  it('R2：chunk 行形状损坏 → 违规', () => {
    const file = writeRawSession([
      JSON.stringify({ type: 'session', version: 0, id: 'x', createdAt: 1 }),
      JSON.stringify({ type: 'text-chunks', seq0: 0, time0: 1, data: { oops: true } }),
    ]);
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('R2');
  });

  it('Z1：zstd 尾帧撕裂 → 告警（文件当前不可读 → 整体 error）', () => {
    const file = writeSession(validSessionEvents(), { zstd: true, torn: true });
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('Z1');
    expect(result.ok).toBe(false); // 撕裂尾帧 = 当前不可读
  });

  it('P1：未知 marker 前缀 → 告警', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 1], id: 'renamed-plugin-edit-x' }),
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('P1');
  });

  it('P2：marker 自身 seq 进入自身 shadowed 集 → 违规', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 1, 2] }),
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('P2');
  });

  // ── T1 · token-meter 配对（2026-08-28 事故根因 3）─────────────────────
  it('T1：现代会话（step/start→assistant→step/end）零 T1 违规', () => {
    const events = [
      userMessage({ seq: 0 }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 1 } },
      assistantMessage({ seq: 2, turn: 0, step: 1 }),
      { type: 'step/end', seq: 3, time: 4, data: { turn: 0, step: 1 } },
      turnEnd({ seq: 4, turn: 0 }),
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.violations.filter((v) => v.id === 'T1')).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('T1：现代会话含 turn-null marker → error（/compact 会被拒）', () => {
    const events = [
      userMessage({ seq: 0 }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 1 } },
      assistantMessage({ seq: 2, turn: 0, step: 1 }),
      { type: 'step/end', seq: 3, time: 4, data: { turn: 0, step: 1 } },
      userMessage({ seq: 4 }),
      markerEvent({ seq: 5, start: 0, end: 2, shadowedSeqs: [0, 2] }), // turn-null replace
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    const t1 = result.violations.filter((v) => v.id === 'T1');
    expect(t1.length).toBeGreaterThan(0);
    expect(t1[0].severity).toBe('error');
    expect(result.ok).toBe(false);
  });

  it('T1：无 step/start 的简化日志不误报（远古/夹具结构）', () => {
    const events = validSessionEvents(); // 夹具：无 step/start
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.violations.filter((v) => v.id === 'T1')).toHaveLength(0);
  });

  it('T1：step/end 无匹配 step/start → error', () => {
    const events = [
      userMessage({ seq: 0 }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 9, step: 9 } }, // 不匹配
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(ids(result)).toContain('T1');
    expect(result.ok).toBe(false);
  });
});

describe('T2 token-meter 源引用（2026-08-30 跨 step 刷屏事故固化）', () => {
  function chunkRow(seq, turn, step, text) {
    return {
      type: 'assistant/chunk',
      seq,
      time: seq + 1,
      data: { turn, step, chunk: { type: 'text-chunks', chunks: [{ type: 'text', text }] } },
    };
  }

  it('同 step 的 sourceEventSeqs → 不报 T2', () => {
    const events = [
      userMessage({ seq: 0 }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 9 } },
      chunkRow(2, 1, 9, 'new'),
      { type: 'assistant/message', seq: 3, time: 4, surfaceOp: 'append', sourceEventSeqs: [2], data: { turn: 1, step: 9, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'new' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 9 } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.violations.filter((v) => v.id === 'T2')).toHaveLength(0);
  });

  it('跨 step 的 sourceEventSeqs → T2 error（每事件只报首条）', () => {
    const events = [
      userMessage({ seq: 0 }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 7 } },
      chunkRow(2, 1, 7, 'old'),
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 7 } },
      { type: 'step/start', seq: 4, time: 5, data: { turn: 1, step: 9 } },
      chunkRow(5, 1, 9, 'new'),
      // resend 消息：sourceEventSeqs 混入 step 7 + step 9 的 chunk（跨 step → 官方 645 行抛错）
      { type: 'assistant/message', seq: 6, time: 7, surfaceOp: 'append', sourceEventSeqs: [2, 5], data: { turn: 1, step: 9, message: { id: 'a6', role: 'assistant', content: [{ type: 'text', text: 'new' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 9 } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    const t2 = result.violations.filter((v) => v.id === 'T2');
    expect(t2).toHaveLength(1); // 每事件只报首条（官方抛一次即停）
    expect(t2[0].seq).toBe(6);
    expect(t2[0].severity).toBe('error');
    expect(result.ok).toBe(false);
  });

  it('真实夹具：526f1835 clip 前备份报 T2@936047', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { decompressZstd } = require('../lib/log-reader.js');
    const bdir = path.join(process.env.HOME, 'opena-archive-2026-08/backups');
    const before = path.join(bdir, 'backup-session-2026-08-29-21-03-13.jsonl.zstd');
    if (!fs.existsSync(before)) {
      console.warn('skip: fixture not present');
      return;
    }
    const text = decompressZstd(fs.readFileSync(before)).toString('utf8');
    const tmp = path.join(os.tmpdir(), 't2-real.jsonl');
    fs.writeFileSync(tmp, text);
    const log = loadSessionLog(tmp);
    const t2 = tokenMeterSourceViolations(log.events);
    expect(t2.length).toBeGreaterThanOrEqual(1);
    expect(t2[0].seq).toBe(936047);
  });
});

describe('W1 wire 流（2026-08-29 重启回归：折叠必须与官方同位置语义）', () => {
  // 官方 applySurfacePlan：splice(startIdx, endIdx-startIdx+1, markerSeq)——marker 插在遮蔽范围开头。
  // 旧 wireViolations 折叠：splice 删除后 push 到末尾 → marker 位置漂移 → 后续 replace 的
  // indexOf 范围错位 → 本应被遮蔽的 tool/result marker 逃逸 → 悬空 tool 误报。
  it('W1：compaction replace 遮蔽 tool/result marker → 不误报（回归锁定）', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      { type: 'tool/result', seq: 2, time: 3, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 't-2', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] } } },
      userMessage({ seq: 3, text: 'more' }),
      // tool/result replace marker：遮蔽 seq2，data 与原文一致仅 text 变化（官方 assertToolResultRewrite 要求）
      { type: 'tool/result', seq: 4, time: 5, surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2], data: { turn: 0, step: 0, message: { id: 't-2', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'edited' }] }] } } },
      // compaction 式 user/message replace：遮蔽 [0..3]（此刻 surface 为 [0,1,4,3]）
      { type: 'user/message', seq: 5, time: 6, surfaceOp: { op: 'replace', start: 0, end: 3 }, sourceEventSeqs: [0, 1, 4, 3], data: { id: 'u-5', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.violations.filter((v) => v.id === 'W1')).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('W1：append 的 tool/result 前面没有 assistant tool-call → 仍报（检测不削弱）', () => {
    const events = [
      userMessage({ seq: 0 }),
      { type: 'tool/result', seq: 1, time: 2, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 't-1', role: 'user', source: { kind: 'tool', callId: 'call-x' }, content: [{ type: 'tool-result', toolCallId: 'call-x', content: [{ type: 'text', text: 'ok' }] }] } } },
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    const w1 = result.violations.filter((v) => v.id === 'W1');
    expect(w1.length).toBeGreaterThan(0);
    expect(w1[0].severity).toBe('error');
    expect(result.ok).toBe(false);
  });
});

describe('S9 文件物理序 seq 单调（2026-08-30 固化；交接书 L2）', () => {
  it('物理序单调递增 → 不报 S9', () => {
    const events = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      turnEnd({ seq: 2 }),
    ];
    const file = writeSession(events);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.violations.filter((v) => v.id === 'S9')).toHaveLength(0);
  });

  it('物理序 seq 倒退（交织现场）→ S9 error', () => {
    // 手工写一个物理序倒退的日志：seq 2 出现在 seq 1 之前
    const lines = [
      JSON.stringify({ type: 'session', version: 0, id: 't', createdAt: 1 }),
      JSON.stringify(userMessage({ seq: 0 })),
      JSON.stringify({ type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm' } } } }),
      JSON.stringify(assistantMessage({ seq: 1 })),
    ];
    const file = writeRawSession(lines);
    const log = loadSessionLog(file);
    const { physicalOrderViolations } = require('../lib/checks.js');
    const v = physicalOrderViolations(log.rows);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].id).toBe('S9');
    expect(v[0].severity).toBe('error');
  });

  it('真实夹具：526f1835 交织备份报 S9，修复后 0', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { physicalOrderViolations } = require('../lib/checks.js');
    const bdir = path.join(process.env.HOME, 'opena-archive-2026-08/backups');
    const interleaved = fs.readdirSync(bdir).find((f) => f.includes('526f1835-pre-keepranges'));
    if (!interleaved) {
      console.warn('skip: interleaved fixture not present');
      return;
    }
    const log = loadSessionLog(path.join(bdir, interleaved));
    expect(physicalOrderViolations(log.rows).length).toBeGreaterThanOrEqual(1);
    const fixed = loadSessionLog(path.join(process.env.HOME, '.dsh/sessions/--Users-maxwell-opena--/session-526f1835-e93d-4f5f-9ebf-4d64586d392b/session.jsonl.zstd'));
    expect(physicalOrderViolations(fixed.rows)).toEqual([]);
  });
});

describe('I1 inbox seed 相对重放（交接书 L1；fork 边界孤儿）', () => {
  function sessionHeader(seedLength) {
    return { type: 'session', version: 0, id: 't', createdAt: 1, seedLength };
  }

  it('合法 spliced（start+removedCount 在队列内）→ 不报 I1', () => {
    const events = [
      { type: 'agent/inbox/spliced', seq: 10, time: 11, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }] } },
      { type: 'agent/inbox/spliced', seq: 11, time: 12, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    ];
    const file = writeRawSession([
      JSON.stringify(sessionHeader(10)),
      ...events.map((e) => JSON.stringify(e)),
    ]);
    const log = loadSessionLog(file);
    const { inboxReplayViolations } = require('../lib/checks.js');
    expect(inboxReplayViolations(log.events, log.header)).toEqual([]);
  });

  it('fork 边界孤儿（removedCount=1 但 seed 相对空 inbox）→ I1 error', () => {
    const events = [
      // seedLength=10，从 seq 10 起；第一条 spliced 就 removedCount=1 → 队列空 → 非法
      { type: 'agent/inbox/spliced', seq: 10, time: 11, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    ];
    const file = writeRawSession([
      JSON.stringify(sessionHeader(10)),
      ...events.map((e) => JSON.stringify(e)),
    ]);
    const result = validateSessionLog(loadSessionLog(file));
    const i1 = result.violations.filter((v) => v.id === 'I1');
    expect(i1.length).toBeGreaterThanOrEqual(1);
    expect(i1[0].seq).toBe(10);
    expect(i1[0].severity).toBe('error');
  });

  it('真实夹具：62c5b531 fork 孤儿备份报 I1@347704', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { inboxReplayViolations } = require('../lib/checks.js');
    const f = path.join(process.env.HOME, 'opena-archive-2026-08/backups/backup-session-62c5b531-pre-inboxfix-20260828-202840.jsonl.zstd');
    if (!fs.existsSync(f)) {
      console.warn('skip: fixture not present');
      return;
    }
    const log = loadSessionLog(f);
    const v = inboxReplayViolations(log.events, log.header);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].seq).toBe(347704);
  });
});
