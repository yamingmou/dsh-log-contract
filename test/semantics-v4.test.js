/**
 * dsh-log-contract · test/semantics-v4.test.js —— v4 语义回归套件
 *
 * 为什么单独成文件：v4（DSH 0.2.x，`SESSION_FORMAT_VERSION = 4`）改了三处消息形状，而写前校验
 * `createPreWriter().validateAppend()` 会把形状规则跑在**整份日志**上——规则体停在 v3 时，
 * 真实 v4 会话里每个 `tool/result`（E6）与 `system/message`（E9）都会让**任何**写入被拒。
 * 本文件逐条钉住 v4 语义本体（与 `semantics-v3.test.js` 同一写法）：
 *
 *   V1  v4 形状（官方 dsh-session@0.2.0-rc.2 `assertMessageEventShape` + 原生 v4 准入）：
 *       `tool/result` role `tool` + `message.toolCallId`；`system/message` source `system-prompt`；
 *       新 surface 类型 `developer/message`；任何 `plugin` source 被拒；
 *   V2  按被检文件版本择路：同一份 v4 日志按 v3 判 ⇒ E6/E9（证明规则是"换判据"，不是"放宽"）；
 *   V3  写前：retrace 两段结构 marker（`compaction/prune` 审计 + `user/message` replace）在 v4
 *       日志上通过；非法区间仍被拒；
 *   V4  版本推断：无 header 时由 v4 判别形状推出 4；
 *   CLI  v4 文件 `check` 退出码 0。
 *
 * **宿主分层**：需要 v4 运行时（词表含 `developer/message`、官方 `foldSurface` 为 v4 语义）的用例用
 * `itV4`（`it.skipIf(!HOST_V4)`）显式跳过并在报告里计数；宿主无关的用例在任何宿主上都真跑。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_FORMAT_VERSION, isSurfaceEligibleType } from '@deepseek-ai/dsh-session';
import { validateSessionLog, createPreWriter } from '../lib/index.js';
import { inferFormatVersion } from '../lib/vocab.js';
import { currentSurfaceTypes, messageShapeViolations } from '../lib/checks.js';
import { faithfulFrameInfo } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');

/** 宿主是否具备 v4 语义（0.2.x）。 */
const HOST_V4 = SESSION_FORMAT_VERSION >= 4 && isSurfaceEligibleType('developer/message');
/** 需要 v4 运行时的用例：在 v3 及更早宿主上跳过（不是假绿）。 */
const itV4 = (title, fn) => it.skipIf(!HOST_V4)(title, fn);

// ─────────────────────────────────────────────────────────────────────────────
// v4 夹具（形状逐项对齐 dsh-session@0.2.0-rc.2 实际写出的事件）
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_V4 = { type: 'session', version: 4, id: 'v4-fixture', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: '/tmp' };
const MODEL = { kind: 'model', provider: 'deepseek', model: 'test' };

function systemMessage({ seq, source = { kind: 'system-prompt' } } = {}) {
  return {
    type: 'system/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: `s-${seq}`, role: 'system', source, content: [{ type: 'text', text: 'sys' }] } },
  };
}

function userMessage({ seq, text = 'hi', source = { kind: 'user' } } = {}) {
  return {
    type: 'user/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { id: `u-${seq}`, role: 'user', source, content: [{ type: 'text', text }] },
  };
}

function assistantMessage({ seq, content = [{ type: 'text', text: 'yo' }] } = {}) {
  return {
    type: 'assistant/message', seq, time: seq + 1, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: `a-${seq}`, role: 'assistant', source: MODEL, content } },
  };
}

function toolCallMessage({ seq, callId = 'call-1' } = {}) {
  return assistantMessage({ seq, content: [{ type: 'tool-call', toolCallId: callId, toolName: 'read', input: {} }] });
}

/** v4 `tool/result`：role `tool`、`message.toolCallId`、content 直接是结果数组（无包装块）。 */
function toolResult({ seq, callId = 'call-1', message = {} } = {}) {
  return {
    type: 'tool/result', seq, time: seq + 1, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: { id: `t-${seq}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }], ...message },
    },
  };
}

function developerMessage({ seq, role = 'developer', surfaceOp = 'append' } = {}) {
  const event = {
    type: 'developer/message', seq, time: seq + 1,
    data: { turn: 1, step: 1, message: { id: `d-${seq}`, role, source: { kind: 'tool-registry' }, content: [{ type: 'tool-removal', toolName: 'read' }] } },
  };
  return surfaceOp === null ? event : { ...event, surfaceOp };
}

function turnEnd({ seq } = {}) {
  return { type: 'turn/end', seq, time: seq + 1, data: { turn: 1, reason: { kind: 'completed' } } };
}

/** 一轮真实形状的 v4 会话：system → user → tool-call → tool/result → assistant → developer → turn/end。 */
function v4Events() {
  return [
    systemMessage({ seq: 0 }),
    userMessage({ seq: 1 }),
    toolCallMessage({ seq: 2 }),
    toolResult({ seq: 3 }),
    assistantMessage({ seq: 4 }),
    developerMessage({ seq: 5 }),
    turnEnd({ seq: 6 }),
  ];
}

/** retrace 两段结构第 1 段：`compaction/prune` 审计（data 精确三成员）。 */
function auditEvent({ seq, start, end, shadowedSeqs }) {
  return { type: 'compaction/prune', seq, time: seq + 1, data: { shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount: 0 } };
}

/** retrace 两段结构第 2 段：`user/message` replace（source model，provenance 首元素 = 审计 seq）。不带 seq，由 validateAppend 赋值。 */
function carrierEnvelope({ startSeq, endSeq, auditSeq, shadowedSeqs }) {
  return {
    type: 'user/message',
    time: 100,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [auditSeq, ...shadowedSeqs],
    data: { role: 'user', id: 'retrace-edit-v4', source: MODEL, content: [{ type: 'text', text: '[retrace] edited' }] },
  };
}

function logOf(header, events) {
  return {
    header,
    headerLine: 0,
    rows: events.map((e, i) => ({ lineNo: i + 1, value: e, decoded: [e], error: null })),
    events: events.map((e, i) => ({ seq: e.seq, event: e, lineNo: i + 1 })),
    frameInfo: faithfulFrameInfo({ eventRows: events.length }),
  };
}

function writeJsonl(header, events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-v4-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [header, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const ids = (violations) => [...new Set(violations.map((v) => v.id))].sort();
const errorIds = (result) => ids(result.violations.filter((v) => v.severity === 'error'));
const shapeIds = (event) => ids(messageShapeViolations(event, { seq: event.seq }, 4));

// ─────────────────────────────────────────────────────────────────────────────
// V1 · v4 消息形状
// ─────────────────────────────────────────────────────────────────────────────
describe('V1 · v4 消息形状（官方 assertMessageEventShape + 原生 v4 准入）', () => {
  itV4('健康 v4 会话 → ok，无 E3/E6/E9/S1/S2/S8，支持面 = baseline', () => {
    const result = validateSessionLog(logOf(HEADER_V4, v4Events()));
    expect(errorIds(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.support.file).toMatchObject({ version: 4, status: 'baseline' });
    expect(result.support.readOnly).toBe(false);
  });

  it('v4 surface 候选类型含 developer/message；v3 不含（宿主无关）', () => {
    expect(currentSurfaceTypes(4).has('developer/message')).toBe(true);
    expect(currentSurfaceTypes(3).has('developer/message')).toBe(false);
    for (const t of ['system/message', 'user/message', 'assistant/message', 'tool/result']) expect(currentSurfaceTypes(4).has(t)).toBe(true);
  });

  it('合法 v4 形状逐条 0 违规（宿主无关）', () => {
    for (const event of v4Events()) expect(shapeIds(event)).toEqual([]);
  });

  it('tool/result：v3 的 role user + tool-result 包装块 → E6', () => {
    const v3Shaped = toolResult({ seq: 3, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } });
    expect(shapeIds(v3Shaped)).toEqual(['E6']);
  });

  it('tool/result：message.toolCallId 与 source.callId 不一致 → E6', () => {
    expect(shapeIds(toolResult({ seq: 3, message: { toolCallId: 'call-2' } }))).toEqual(['E6']);
  });

  it('tool/result：role tool 但残留 tool-result 包装块 → E6（文件读取路径会拒）', () => {
    expect(shapeIds(toolResult({ seq: 3, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] } }))).toEqual(['E6']);
  });

  it('tool/result：isError 非布尔 / 带 data.error 而 isError !== true → E6', () => {
    expect(shapeIds(toolResult({ seq: 3, message: { isError: 'yes' } }))).toEqual(['E6']);
    const errored = toolResult({ seq: 3 });
    errored.data.error = { name: 'ToolError', message: 'x' };
    expect(shapeIds(errored)).toEqual(['E6']);
    errored.data.message.isError = true;
    expect(shapeIds(errored)).toEqual([]);
  });

  it('system/message：v3 的 plugin source → E9（且 plugin source 本身 → E6）', () => {
    expect(shapeIds(systemMessage({ seq: 0, source: { kind: 'plugin', plugin: 'p' } }))).toEqual(['E6', 'E9']);
    expect(shapeIds(systemMessage({ seq: 0, source: { kind: 'user' } }))).toEqual(['E9']);
  });

  it('任何消息的 plugin source → E6（v4 把插件包装改写成生产者自有 kind）', () => {
    expect(shapeIds(userMessage({ seq: 1, source: { kind: 'plugin', plugin: 'compact' } }))).toEqual(['E6']);
    expect(shapeIds(userMessage({ seq: 1, source: { kind: 'compact-checkpoint' } }))).toEqual([]);
  });

  it('developer/message：role 不是 developer → E6', () => {
    expect(shapeIds(developerMessage({ seq: 5, role: 'system' }))).toEqual(['E6']);
  });

  itV4('developer/message 缺 surfaceOp → S1（v4 surface 候选必须带标记）', () => {
    const events = v4Events();
    events[5] = developerMessage({ seq: 5, surfaceOp: null });
    expect(errorIds(validateSessionLog(logOf(HEADER_V4, events)))).toContain('S1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V2 · 按被检文件版本择路（换判据，不是放宽）
// ─────────────────────────────────────────────────────────────────────────────
describe('V2 · 按被检文件版本择路', () => {
  it('同一份 v4 事件按 v3 形状判 → tool/result E6、system/message E9（v3 规则未被放宽）', () => {
    const [sys, , , tool] = v4Events();
    expect(ids(messageShapeViolations(tool, { seq: tool.seq }, 3))).toEqual(['E6']);
    expect(ids(messageShapeViolations(sys, { seq: sys.seq }, 3))).toEqual(['E9']);
  });

  it('不传 version（旧调用方）→ 仍走 v0–v3 形状', () => {
    const tool = v4Events()[3];
    expect(ids(messageShapeViolations(tool, { seq: tool.seq }))).toEqual(['E6']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V3 · 写前：retrace 两段结构 marker 在 v4 日志上
// ─────────────────────────────────────────────────────────────────────────────
describe('V3 · 写前校验在 v4 日志上（retrace 两段结构 marker）', () => {
  // 遮蔽 user(1) … assistant(4) 这一轮（surface 节点 1,2,3,4），审计段落在 seq 7。
  const span = { startSeq: 1, endSeq: 4, shadowedSeqs: [1, 2, 3, 4] };
  const planned = () => [...v4Events(), auditEvent({ seq: 7, start: 1, end: 4, shadowedSeqs: span.shadowedSeqs })];

  itV4('header.version = 4 → 编辑/撤回 marker 通过（修复前：整份日志的 E6/E9 让它 marker-rejected）', () => {
    const pw = createPreWriter({ events: planned(), header: HEADER_V4 });
    expect(pw.formatVersion).toBe(4);
    const r = pw.validateAppend(carrierEnvelope({ ...span, auditSeq: 7 }));
    expect(r.violations.filter((v) => v.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  itV4('无 header（只给 events）→ 由 v4 判别形状推出 4，同样通过', () => {
    const pw = createPreWriter({ events: planned() });
    expect(pw.formatVersion).toBe(4);
    expect(pw.validateAppend(carrierEnvelope({ ...span, auditSeq: 7 })).ok).toBe(true);
  });

  itV4('强制按 v3 判同一份 v4 日志 → 被拒且归因 E6/E9（复现修复前的 marker-rejected）', () => {
    const r = createPreWriter({ events: planned(), formatVersion: 3 }).validateAppend(carrierEnvelope({ ...span, auditSeq: 7 }));
    expect(r.ok).toBe(false);
    expect(errorIds(r)).toEqual(expect.arrayContaining(['E6', 'E9']));
  });

  itV4('非法区间（端点不在当前 surface）→ 仍被拒（S4）', () => {
    const r = createPreWriter({ events: planned(), header: HEADER_V4 }).validateAppend(carrierEnvelope({ startSeq: 1, endSeq: 6, auditSeq: 7, shadowedSeqs: [1, 2, 3, 4, 5, 6] }));
    expect(r.ok).toBe(false);
    expect(errorIds(r)).toContain('S4');
  });

  itV4('provenance 漏掉被遮蔽节点 → 仍被拒（S5）', () => {
    const r = createPreWriter({ events: planned(), header: HEADER_V4 }).validateAppend(carrierEnvelope({ ...span, auditSeq: 7, shadowedSeqs: [1, 2, 3] }));
    expect(r.ok).toBe(false);
    expect(errorIds(r)).toContain('S5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V4 · 版本推断
// ─────────────────────────────────────────────────────────────────────────────
describe('V4 · 无 header 时的版本推断（宿主无关）', () => {
  it('developer/message / role tool 的 tool/result / system-prompt source → 4', () => {
    expect(inferFormatVersion([developerMessage({ seq: 0 })])).toBe(4);
    expect(inferFormatVersion([toolResult({ seq: 0 })])).toBe(4);
    expect(inferFormatVersion([systemMessage({ seq: 0 })])).toBe(4);
  });

  it('只有 v3 判别特征（plugin source 的 system/message、role user 的 tool/result）→ 3', () => {
    const v3Tool = toolResult({ seq: 1, message: { role: 'user' } });
    expect(inferFormatVersion([systemMessage({ seq: 0, source: { kind: 'plugin', plugin: 'p' } }), v3Tool])).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI · v4 文件', () => {
  itV4('check 健康 v4 文件 → 退出码 0、--json 里 support.file = v4 baseline', () => {
    const file = writeJsonl(HEADER_V4, v4Events());
    const res = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(res.stdout);
    expect(payload.support.file).toMatchObject({ version: 4, status: 'baseline' });
    expect(res.status).toBe(0);
  });
});
