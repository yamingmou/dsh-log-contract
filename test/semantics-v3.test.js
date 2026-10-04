/**
 * dsh-log-contract · test/semantics-v3.test.js —— v2/v3 语义回归套件
 *
 * 为什么单独成文件：主套件长期只有 v0 夹具（`grep "version: *[23]" test/` 零命中），
 * v3 语义改动可以一路绿灯而不被发现。本文件补齐 v2/v3 夹具，逐条钉住**语义本体**：
 *
 *   C1  v3 `sourceEventSeqs` 区间编码（官方 `decodeSeqRanges`）——读取层 + 体检入口 + 写前入口；
 *   C2  `prewrite` 版本来源显式化（显式参数 > header.version > 事件形状推断），同进程交错不翻转；
 *   C3  v3 surface 类型（`system/message`）、v3 replace 字段名（`startSeq/endSeq`）、
 *       **按被检文件版本择路**（v3→官方 foldSurface / v0–v2→本地 legacy）、v2 词表与路由；
 *   compat  compat 边界：chunk 行 `dt` arity 校验、lossless-JSON `-0`/稀疏数组边界；
 *   CLI  `--json` 大报告必须仍是合法 JSON（CLI 子进程，真管道）。
 *
 * **宿主分层（诚实记录）**：`0.1.0-rc.7` 是 v0 时代宿主（`SESSION_FORMAT_VERSION=0`，
 * `KNOWN_SESSION_EVENT_TYPES` 无 `system/message`，`foldSurface` 是 v0 语义）——它**无法**
 * 提供 v3 语义。因此"需要 v3 运行时"的用例用 `itV3`（`it.skipIf(!HOST_V3)`）显式跳过并在
 * 报告里计数；**宿主无关**的用例（区间解码、版本推断、compat 边界、大 JSON、v2 本地路由）
 * 在两种宿主上都真跑。这比"让 v3 断言在旧宿主上假绿"诚实。
 *
 * 每条用例的注释都标出它钉住的那条语义（以及"改坏哪一处会让它变红"）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { loadSessionLog, validateSessionLog, resumeVerdict, migrationVerdict, createPreWriter, preWriterFromLog, HOST_MAX_FILE_VERSION } from '../lib/index.js';
import { V0_EVENT_TYPES, V2_EVENT_TYPES, inferFormatVersion, LEGACY_FORMAT_MAX_VERSION, MIGRATION_TARGET_VERSION, currentVocabulary } from '../lib/vocab.js';
import { isJsonValue, decodeSeqRanges, decodeStorageRecord } from '../lib/compat.js';
import { finalFold, wireViolations, normalizeReplaceOp } from '../lib/checks.js';
import { HEADER, validSessionEvents, markerEvent, userMessage, assistantMessage, turnEnd, faithfulFrameInfo } from './helpers.js';
import * as helpersForRc from './helpers.js';
import { neutralizeMarkersText as neutralizeLegacy } from '../lib/repair.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');

/** 宿主是否具备 v3 语义（0.1.5+）；rc.7 = false。 */
const HOST_V3 = SESSION_FORMAT_VERSION >= 3 && KNOWN_SESSION_EVENT_TYPES.has('system/message');
/** 需要 v3 运行时的用例：在 v0 时代宿主上跳过（不是假绿）。 */
const itV3 = (title, fn) => it.skipIf(!HOST_V3)(title, fn);

// ─────────────────────────────────────────────────────────────────────────────
// v2/v3 夹具（此前完全缺失）
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_V3 = { type: 'session', version: 3, id: 'v3-fixture', createdAt: 1, cwd: '/tmp' };
const HEADER_V2 = { type: 'session', version: 2, id: 'v2-fixture', createdAt: 1, cwd: '/tmp' };

/** v3 新增 surface 类型（官方 0.1.5 `SURFACE_EVENT_TYPES`）。 */
function systemMessage({ seq, turn = 0, step = 0, text = 'sys' } = {}) {
  return {
    type: 'system/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      // E9：宿主要求 system/message 的 source.kind==='plugin' 且 plugin 非空
      // （dsh-session@0.1.5-rc.1 lib/index.js:942-944）——夹具按宿主契约写,否则会被 E9 判红。
      message: { id: `s-${seq}`, role: 'system', source: { kind: 'plugin', plugin: 'test-plugin' }, content: [{ type: 'text', text }] },
    },
  };
}

/** v3 replace marker：`{op:'replace', startSeq, endSeq}`（v3 字段名）。 */
function v3Replace({ seq, startSeq, endSeq, shadowed, text = 'edited' } = {}) {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowed,
    data: { id: `r-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

/** v0/v1/v2 replace marker：`{op:'replace', start, end}`（旧字段名）。 */
function legacyReplace({ seq, start, end, shadowed, text = 'edited' } = {}) {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: shadowed,
    data: { id: `r-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

/** v2/v3 顶层 `assistant/attempt`（流内嵌在 data.stream）。 */
function attemptEvent({ seq, turn = 0, step = 1 } = {}) {
  return { type: 'assistant/attempt', seq, time: seq + 1, data: { turn, step, stream: [] } };
}

/** 旧格式顶层 chunk 行展开后的事件（v2 dispositions 已剔除 `assistant/chunk`）。 */
function chunkEvent({ seq, turn = 0, step = 1 } = {}) {
  return {
    type: 'assistant/chunk',
    seq,
    time: seq + 1,
    data: { turn, step, chunk: { type: 'text-delta', index: 0, text: 'x' } },
  };
}

/**
 * 手搓一个 `loadSessionLog` 形状的 log（rows 与 events 都按单行直出）。
 *
 * `frameInfo` 走 `faithfulFrameInfo()`：**与官方写盘形状一致**（帧 1 = header 独占，
 * 事件按批次分帧）。此前这里写死 `frames: 1`，等于声明"整份日志压成 1 帧"——
 * 那是宿主从不产出的形状，会平白触发 Z5（2026-09-16 真机事故后新增的规则）。
 */
function logOf(header, events) {
  return {
    header,
    headerLine: 0,
    rows: events.map((e, i) => ({ lineNo: i + 1, value: e, decoded: [e], error: null })),
    events: events.map((e, i) => ({ seq: e.seq, event: e, lineNo: i + 1 })),
    frameInfo: faithfulFrameInfo({ eventRows: events.length }),
  };
}

const uniqueIds = (result) => [...new Set(result.violations.map((v) => v.id))];

/**
 * S7（C1 三入口强化）：在**每一种宿主**上断言能真实成立的最强结论。
 * - v3 宿主（0.1.5+）：区间编码展开正确 ⇒ 必须 `ok===true` 且零违规；
 * - v0 时代宿主（rc.7）：读取层仍能展开区间（宿主无关），但 v3 语义不可评估 ⇒
 *   `validateSessionLog` 必须给**显式** `not-assessable`（不是 broken）。
 * 这样原用例不再止步于 `not.toContain`（那种断言在"结果整条被跳过/换档"时也会绿）。
 */
function expectC1ReadOk(result) {
  expect(uniqueIds(result)).not.toContain('S5');
  expect(uniqueIds(result)).not.toContain('S6');
  if (HOST_V3) {
    expect(uniqueIds(result)).toEqual([]);
    expect(result.ok).toBe(true);
  } else {
    expect(result.assessable).toBe(false);
    expect(result.notAssessable?.fileVersion).toBe(3);
    expect(resumeVerdict(result).verdict).toBe('not-assessable');
  }
}

/**
 * S7：写前入口没有宿主能力闸（C2 的显式版本只决定词表/折叠选择）。
 * v3 宿主上区间编码展开后必须 `ok===true`；v0 时代宿主上 v3 事件会被**本宿主的 v0
 * foldSurface** 拒绝（宿主能力产物，不是区间解码失败）⇒ 只断言与解码强相关的 S5/S6 缺席。
 */
function expectC1PrewriteOk(r) {
  expect(uniqueIds(r)).not.toContain('S5');
  expect(uniqueIds(r)).not.toContain('S6');
  if (HOST_V3) {
    expect(uniqueIds(r)).toEqual([]);
    expect(r.ok).toBe(true);
  }
}

function writeJsonl(header, events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-v3-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 · v3 区间编码
// ─────────────────────────────────────────────────────────────────────────────
describe('C1 · v3 sourceEventSeqs 区间编码（官方 decodeSeqRanges）', () => {
  it('decodeSeqRanges：数字+闭区间混合 → 稠密；非法形态 fail-loud', () => {
    expect(decodeSeqRanges([3, [5, 7], 9])).toEqual([3, 5, 6, 7, 9]);
    expect(decodeSeqRanges([[0, 1]])).toEqual([0, 1]);
    expect(decodeSeqRanges([1])).toEqual([1]);
    expect(() => decodeSeqRanges([[5, 3]])).toThrow(/start <= end/);
    expect(() => decodeSeqRanges([1, 'x'])).toThrow(/pairs/);
    expect(() => decodeSeqRanges([1, [2, 3], 2])).toThrow(/strictly increasing/);
    expect(() => decodeSeqRanges(-0)).toThrow(/must be an array/);
    expect(() => decodeSeqRanges([-0])).toThrow(/SessionSeq/);
  });

  it('读取层 loadSessionLog 展开区间编码（S7：展开 + 逐宿主最强断言）', () => {
    // 与真实 v3 会话同形：replace 的 sourceEventSeqs 用 `[[0,1]]` 区间对压缩
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];
    const file = writeJsonl(HEADER_V3, events);
    const log = loadSessionLog(file);
    expect(log.events[2].event.sourceEventSeqs).toEqual([0, 1]);          // 已展开
    expectC1ReadOk(validateSessionLog(log));                              // S7：第 1 个入口（读取层）
  });

  itV3('展开后 validateSessionLog 通过（需 v3 宿主）', () => {
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];
    const log = loadSessionLog(writeJsonl(HEADER_V3, events));
    const result = validateSessionLog(log);
    expect(uniqueIds(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary.surfaceNodes).toBe(1);                          // 0,1 被 2 替换
  });

  it('体检入口对手搓 log 也归一（S7：v3 宿主 ok===true / 旧宿主显式 not-assessable）', () => {
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];
    const result = validateSessionLog(logOf(HEADER_V3, events));
    // 反例（体检入口不归一）→ 未展开的 `[[0,1]]` 会报 S6（并连带 S5）
    expectC1ReadOk(result);
  });

  it('写前入口（createPreWriter 直接吃 events）也归一（S7：v3 宿主 ok===true）', () => {
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];
    const pw = createPreWriter({ events, formatVersion: 3 });
    const r = pw.validateEdit(events);
    expect(pw.formatVersion).toBe(3);
    expectC1PrewriteOk(r);
  });

  it('写前**基座**含区间编码 → validateAppend 归一（S7：v3 宿主 ok===true）', () => {
    // 反例：构造期不归一 → 基座未展开 → S6/S5
    const base = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];
    const pw = createPreWriter({ events: base, formatVersion: 3 });
    const r = pw.validateAppend(userMessage({ seq: 4 }));
    expectC1PrewriteOk(r);
  });

  itV3('未展开的区间编码喂官方 foldSurface 必抛（证明"解码"不是可选）', () => {
    const events = [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];
    expect(finalFold(events, 3).error).toBeTruthy();
    const expanded = events.map((e) => (e.sourceEventSeqs ? { ...e, sourceEventSeqs: decodeSeqRanges(e.sourceEventSeqs) } : e));
    expect(finalFold(expanded, 3).error).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 · prewrite 版本来源显式化
// ─────────────────────────────────────────────────────────────────────────────
describe('C2 · prewrite 版本来源（显式参数 / header 推断 / 不依赖模块级全局）', () => {
  const v3Events = () => [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })];

  itV3('v3 事件喂 prewrite（不传 header）→ 自行推断 v3，无 E3/S2/S8', () => {
    // 反例：全新进程 createPreWriter({events: realV3}) 若不自行推断版本 → ok=false + 10 条 E3/S2/S8
    const events = v3Events();
    const pw = createPreWriter({ events });
    expect(pw.formatVersion).toBe(3);
    const r = pw.validateEdit(events);
    expect(uniqueIds(r)).not.toContain('E3');
    expect(uniqueIds(r)).not.toContain('S2');
    expect(uniqueIds(r)).not.toContain('S8');
    expect(r.ok).toBe(true);
  });

  it('header.version 优先于事件形状推断', () => {
    const events = v3Events();
    expect(createPreWriter({ events, header: { version: 0 } }).formatVersion).toBe(0);
    expect(createPreWriter({ events, header: { version: 3 } }).formatVersion).toBe(3);
    expect(createPreWriter({ events: validSessionEvents(), header: { version: 2 } }).formatVersion).toBe(2);
  });

  it('显式 formatVersion 优先于 header', () => {
    expect(createPreWriter({ events: v3Events(), header: { version: 0 }, formatVersion: 3 }).formatVersion).toBe(3);
    expect(createPreWriter({ events: validSessionEvents(), formatVersion: 0 }).formatVersion).toBe(0);
  });

  it('显式 formatVersion=3 + v0 形状 marker → 按 v3 语义拒绝（参数真的生效）', () => {
    const pw = createPreWriter({ events: validSessionEvents(), formatVersion: 3 });
    const r = pw.validateAppend(markerEvent({ seq: 3, start: 1, end: 1, shadowedSeqs: [1] }));
    expect(r.ok).toBe(false);
    expect(uniqueIds(r)).toContain('S4');   // 旧 {start,end} 在 v3 语义下是非法 replace surfaceOp
  });

  it('同进程交错：先 validate(v3) 再 prewrite(v0)，结论不翻转', () => {
    // 旧实现：validate(v3) 写模块级 fileVersion=3 → 下面的 v0 marker 被按 v3 判 → S4+S8。
    // 现在版本是本次调用的局部量；此断言在两种宿主上都必须成立。
    validateSessionLog(logOf(HEADER_V3, v3Events()));
    const pw = createPreWriter({ events: validSessionEvents() });
    expect(pw.formatVersion).toBe(0);
    const r = pw.validateAppend(markerEvent({ seq: 3, start: 1, end: 1, shadowedSeqs: [1] }));
    expect(r.ok).toBe(true);
    expect(uniqueIds(r)).toEqual([]);
  });

  it('preWriterFromLog 从 log.header 取版本', () => {
    expect(preWriterFromLog(logOf(HEADER_V3, v3Events())).formatVersion).toBe(3);
    expect(preWriterFromLog(logOf(HEADER, validSessionEvents())).formatVersion).toBe(0);
  });

  it('inferFormatVersion 判据', () => {
    expect(inferFormatVersion([v3Replace({ seq: 0, startSeq: 0, endSeq: 0, shadowed: [] })])).toBe(3);
    expect(inferFormatVersion([systemMessage({ seq: 0 })])).toBe(3);
    expect(inferFormatVersion([legacyReplace({ seq: 0, start: 0, end: 0, shadowed: [] })])).toBe(0);
    expect(inferFormatVersion([chunkEvent({ seq: 0 })])).toBe(0);
    expect(inferFormatVersion([attemptEvent({ seq: 0 })])).toBe(2);
    expect(inferFormatVersion([attemptEvent({ seq: 0 }), chunkEvent({ seq: 1 })])).toBe(2);
    expect(inferFormatVersion([])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 · v3 surface 类型 / replace 字段名 / 按文件版本择路
// ─────────────────────────────────────────────────────────────────────────────
describe('C3 · v3 surface 类型（system/message）', () => {
  itV3('system/message 是 v3 surface 类型：append 不报 E3/S2', () => {
    // 反例：把 system/message 从 v3 surface 集去掉 → 该事件被当非 surface 却带 surfaceOp → S2
    const result = validateSessionLog(logOf(HEADER_V3, [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })]));
    expect(uniqueIds(result)).not.toContain('S2');
    expect(uniqueIds(result)).not.toContain('E3');
    expect(result.ok).toBe(true);
  });

  itV3('system/message 缺 surfaceOp → S1（surface 候选必须带标记），而不是 E3', () => {
    const broken = { ...systemMessage({ seq: 0 }), surfaceOp: undefined };
    const result = validateSessionLog(logOf(HEADER_V3, [broken, userMessage({ seq: 1 }), turnEnd({ seq: 2 })]));
    expect(uniqueIds(result)).toContain('S1');
    expect(uniqueIds(result)).not.toContain('E3');
  });
});

describe('C3 · v3 replace 字段名（startSeq/endSeq）', () => {
  it('normalizeReplaceOp 按版本读字段名（宿主无关）', () => {
    // v3：只认 startSeq/endSeq
    expect(normalizeReplaceOp({ op: 'replace', startSeq: 1, endSeq: 0 }, 3)).toEqual({ start: 1, end: 0 });
    expect(normalizeReplaceOp({ op: 'replace', start: 0, end: 1 }, 3)).toBeNull();
    // v0/v1/v2：只认 start/end
    expect(normalizeReplaceOp({ op: 'replace', start: 0, end: 1 }, 0)).toEqual({ start: 0, end: 1 });
    expect(normalizeReplaceOp({ op: 'replace', start: 0, end: 1 }, 2)).toEqual({ start: 0, end: 1 });
    expect(normalizeReplaceOp({ op: 'replace', startSeq: 0, endSeq: 1 }, 0)).toBeNull();
    expect(normalizeReplaceOp({ op: 'append' }, 3)).toBeNull();
  });

  itV3('v3 replace {startSeq,endSeq} → 通过（对调端点、或按旧字段名读 → 变红）', () => {
    const result = validateSessionLog(logOf(HEADER_V3, [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [0, 1] }),
      turnEnd({ seq: 3 }),
    ]));
    expect(result.ok).toBe(true);
    expect(result.summary.replaceGeneration).toBe(1);
  });

  itV3('v3 replace 端点对调（startSeq > endSeq）→ S4', () => {
    const result = validateSessionLog(logOf(HEADER_V3, [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      v3Replace({ seq: 2, startSeq: 1, endSeq: 0, shadowed: [0, 1] }),
      turnEnd({ seq: 3 }),
    ]));
    expect(uniqueIds(result)).toContain('S4');
  });

  itV3('v3 文件里用旧 {start,end} → S4（v3 分支若按旧字段名读，该断言即反向）', () => {
    const result = validateSessionLog(logOf(HEADER_V3, [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      legacyReplace({ seq: 2, start: 0, end: 1, shadowed: [0, 1] }),
      turnEnd({ seq: 3 }),
    ]));
    expect(uniqueIds(result)).toContain('S4');
  });
});

describe('C3 · 按被检文件版本择路（v3→官方 foldSurface / v0–v2→本地 legacy）', () => {
  // 同一事件形状：`assistant/message` 携带 sourceEventSeqs。
  // v3 官方语义明确禁止（"embeds its source stream"）→ 必须 S8；
  // v0/v1/v2 旧语义允许 → 必须通过。这一对是"按版本择路"整条不变式的牙齿。
  const shape = () => {
    const a = assistantMessage({ seq: 1 });
    a.sourceEventSeqs = [0]; // helpers.assistantMessage 不转发额外字段，手工挂上
    return [userMessage({ seq: 0 }), a, turnEnd({ seq: 2 })];
  };

  itV3('v3：assistant/message 带 sourceEventSeqs → S8（用官方折叠）', () => {
    // 三个反例都在这对用例上暴露：折叠永用官方 / 永用本地 / 无视 header 版本
    const result = validateSessionLog(logOf(HEADER_V3, shape()));
    expect(uniqueIds(result)).toContain('S8');
    expect(result.ok).toBe(false);
  });

  it('v0：同一形状 → 通过（用本地等价折叠；宿主无关）', () => {
    const result = validateSessionLog(logOf(HEADER, shape()));
    expect(uniqueIds(result)).not.toContain('S8');
    expect(result.ok).toBe(true);
  });

  itV3('finalFold 直接暴露择路差异', () => {
    const events = shape();
    expect(finalFold(events, 3).error?.message ?? '').toMatch(/embeds its source stream/);
    expect(finalFold(events, 0).error).toBeFalsy();
    expect(finalFold(events, 2).error).toBeFalsy();
  });

  it('版本边界常量 = 2（v2 仍是旧格式；退回 1 会让 v2 用例变红）', () => {
    expect(LEGACY_FORMAT_MAX_VERSION).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 · wire 归因也按 v3 字段名
// ─────────────────────────────────────────────────────────────────────────────
describe('C3 · wire 归因也按 v3 字段名', () => {
  // 形状：assistant(tool-call) → user 文本 → `{op:'replace',startSeq:0,endSeq:0}` 遮蔽该 assistant。
  // v3 正确归因：assistant 节点被 replace 掉 ⇒ wire 里没有未满足的 tool-call ⇒ 无 W2。
  // 反例（wire 退回 isReplaceOp 读 start/end）: v3 replace 不被识别 ⇒ 节点残留 ⇒ 出现 W2。
  it('v3 replace 在 wire 层被识别 → 无 W2；同一形状按 v0 语义则产生 W2', () => {
    const amTool = (seq) => ({
      type: 'assistant/message', seq, time: seq + 1, surfaceOp: 'append',
      data: { turn: 0, step: 1, message: { id: `a-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'd', model: 't' }, content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'x', args: {} }] } },
    });
    const events = [amTool(0), userMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 0, shadowed: [0] })];
    const wrapped = events.map((event) => ({ event }));
    expect(wireViolations(wrapped, 3).map((v) => v.id)).toEqual([]);
    expect(wireViolations(wrapped, 0).map((v) => v.id)).toEqual(['W2', 'W2']); // 旧字段名在 v0 语义下非法 replace → 节点残留
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 · v2 词表与路由
// ─────────────────────────────────────────────────────────────────────────────
describe('C3 · v2 词表与路由', () => {
  it('v2 词表含 assistant/attempt、不含 assistant/chunk', () => {
    expect(V2_EVENT_TYPES.has('assistant/attempt')).toBe(true);
    expect(V2_EVENT_TYPES.has('assistant/chunk')).toBe(false);
    // v0 词表仍含 chunk（vendored 口径不变）
    expect(V0_EVENT_TYPES.has('assistant/chunk')).toBe(true);
    expect(currentVocabulary(2)).toBe(V2_EVENT_TYPES);
    expect(currentVocabulary(1)).toBe(V0_EVENT_TYPES);
  });

  itV3('v3 词表 = 运行时 KNOWN：有 system/message，无顶层 assistant/chunk（需 v3 宿主）', () => {
    expect(currentVocabulary(3).has('system/message')).toBe(true);
    expect(currentVocabulary(3).has('assistant/attempt')).toBe(true);
    expect(currentVocabulary(3).has('assistant/chunk')).toBe(false);
  });

  it('v2 assistant/attempt → 无 E3；v2 assistant/chunk → 有 E3', () => {
    const attempt = validateSessionLog(logOf(HEADER_V2, [userMessage({ seq: 0 }), attemptEvent({ seq: 1 }), turnEnd({ seq: 2 })]));
    expect(uniqueIds(attempt)).not.toContain('E3');
    expect(attempt.ok).toBe(true);

    const chunk = validateSessionLog(logOf(HEADER_V2, [userMessage({ seq: 0 }), chunkEvent({ seq: 1 }), turnEnd({ seq: 2 })]));
    expect(uniqueIds(chunk)).toContain('E3');
  });

  it('v2 用旧 {start,end} replace → 通过（把 v2 当新格式 → S4/S8）', () => {
    const result = validateSessionLog(logOf(HEADER_V2, [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      legacyReplace({ seq: 2, start: 0, end: 1, shadowed: [0, 1] }),
      turnEnd({ seq: 3 }),
    ]));
    expect(uniqueIds(result)).not.toContain('S4');
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compat 边界 · chunk 行 dt arity / lossless-JSON
// ─────────────────────────────────────────────────────────────────────────────
describe('compat 边界（chunk 行 dt arity / lossless-JSON）', () => {
  it('chunk 行 dt 长度与成员数不匹配 → decodeStorageRecord 抛错', () => {
    const row = { type: 'text-chunks', seq0: 0, time0: 0, data: { turn: 0, step: 1, index: 0, dt: [], texts: ['a', 'b'] } };
    expect(() => decodeStorageRecord(row)).toThrow(/dt length/);
    const ok = { type: 'text-chunks', seq0: 0, time0: 0, data: { turn: 0, step: 1, index: 0, dt: [5], texts: ['a', 'b'] } };
    expect(decodeStorageRecord(ok)).toHaveLength(2);
  });

  it('chunk 行 dt 非安全整数 → 抛错', () => {
    const row = { type: 'text-chunks', seq0: 0, time0: 0, data: { turn: 0, step: 1, index: 0, dt: [1.5], texts: ['a', 'b'] } };
    expect(() => decodeStorageRecord(row)).toThrow(/dt must be an array of safe integers/);
  });

  it('isJsonValue 拒绝 -0 与稀疏数组', () => {
    expect(isJsonValue(-0)).toBe(false);
    expect(isJsonValue(0)).toBe(true);
    expect(isJsonValue([1, , 3])).toBe(false); // eslint-disable-line no-sparse-arrays
    expect(isJsonValue([1, 2, 3])).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    const cyclic = {}; cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 · 宿主能力闸（rc.7 上 v3 文件不得被判 broken）
// ─────────────────────────────────────────────────────────────────────────────
describe('S2 · 宿主能力闸（被检版本 > 宿主上限 ⇒ not-assessable）', () => {
  const v3Log = () => logOf(HEADER_V3, [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })]);

  it('同一 v3 输入：v3 宿主可评估；v0 时代宿主给 not-assessable（不是 broken）', () => {
    const result = validateSessionLog(v3Log());
    if (HOST_V3) {
      expect(result.assessable).toBe(true);
      expect(result.summary.hostMaxFileVersion).toBeGreaterThanOrEqual(3);
      expect(result.notAssessable).toBeUndefined();
    } else {
      // S2 核心：rc.7 上不得再出现 broken；也不得产出被检版本语义的假阳性
      expect(result.assessable).toBe(false);
      expect(result.notAssessable.fileVersion).toBe(3);
      expect(result.notAssessable.hostMaxFileVersion).toBe(HOST_MAX_FILE_VERSION);
      expect(result.notAssessable.reason).toMatch(/高于|0\.1\.5/);
      expect(result.notAssessable.skippedRules).toContain('S8');
      expect(uniqueIds(result)).not.toContain('S8');
      expect(uniqueIds(result)).not.toContain('E3');
      expect(result.ok).toBe(false);              // 不认证
      const v = resumeVerdict(result);
      expect(v.verdict).toBe('not-assessable');
      expect(v.verdict).not.toBe('broken');
      expect(v.loadable).toBe(false);
      expect(v.notAssessable).toBeTruthy();
    }
  });

  it('宿主能力常量与宿主包版本可见', () => {
    expect(HOST_MAX_FILE_VERSION).toBe(HOST_V3 ? SESSION_FORMAT_VERSION : 0);
    if (HOST_V3) expect(HOST_MAX_FILE_VERSION).toBeGreaterThanOrEqual(3);
    const result = validateSessionLog(v3Log());
    expect(result.summary.hostMaxFileVersion).toBe(HOST_MAX_FILE_VERSION);
  });

  it('CLI：v3 文件在 v3 宿主退出码 0；在 v0 时代宿主退出码 3 且 --json 含 host/assessable/notAssessable', () => {
    const file = writeJsonl(HEADER_V3, [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })]);
    const json = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const payload = JSON.parse(json.stdout);
    expect(payload.host.hostMaxFileVersion).toBe(HOST_MAX_FILE_VERSION);
    expect(payload.host.hostPackage).toBeTruthy();
    if (HOST_V3) {
      expect(payload.assessable).toBe(true);
      expect(json.status).toBe(0);
    } else {
      expect(payload.assessable).toBe(false);
      expect(json.status).toBe(3);
      expect(payload.notAssessable.fileVersion).toBe(3);
      expect(payload.notAssessable.reason).toBeTruthy();
      const text = spawnSync(process.execPath, [CLI, 'check', file], { encoding: 'utf8' });
      expect(text.status).toBe(3);
      expect(text.stdout).toContain('不可在本宿主评估');
      expect(text.stdout).not.toContain('broken');
    }
  });

  it.skipIf(HOST_V3)('CLI fix --apply 在本宿主拒绝修复 v3 文件（不落盘）', () => {
    const file = writeJsonl(HEADER_V3, [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })]);
    const before = fs.readFileSync(file);
    const res = spawnSync(process.execPath, [CLI, 'fix', file, '--apply'], { encoding: 'utf8' });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('拒绝修复');
    expect(Buffer.compare(before, fs.readFileSync(file))).toBe(0);   // 文件未被改
  });

  it.skipIf(HOST_V3)('CLI prewrite 在本宿主拒绝评估 v3 基线', () => {
    const logFile = writeJsonl(HEADER_V3, [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-edit-'));
    const editFile = path.join(dir, 'edit.json');
    fs.writeFileSync(editFile, JSON.stringify({ append: userMessage({ seq: 3 }) }));
    const res = spawnSync(process.execPath, [CLI, 'prewrite', editFile, '--log', logFile], { encoding: 'utf8' });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('不可在本宿主评估');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S1 · 迁移预检（独立维度）——payload 规则 + 覆盖边界
// ─────────────────────────────────────────────────────────────────────────────
describe('S1 · 迁移预检（官方升级路径，独立维度）', () => {
  function descriptorEvent({ seq, version = 2 } = {}) {
    return { type: 'subagent/descriptor', seq, time: seq + 1, data: { turn: 0, step: 0, id: 'sub-1', version } };
  }
  function unknownIgnorable({ seq } = {}) {
    return { type: 'retrace/marker', seq, time: seq + 1, ignorable: true, data: { note: 'x' } };
  }

  it('G1：v0 源 descriptor version≠3 → 迁移 blocked；但 ok 不受影响（warning 层）', () => {
    // 官方判据：@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:1584-1586
    const result = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), descriptorEvent({ seq: 1, version: 2 }), turnEnd({ seq: 2 })]));
    const g1 = result.violations.filter((v) => v.id === 'G1');
    expect(g1).toHaveLength(1);
    expect(g1[0].layer).toBe('migration');
    expect(g1[0].severity).toBe('warning');
    expect(result.ok).toBe(true);                       // 迁移维度与"可加载"互不蕴含
    const mig = migrationVerdict(result);
    expect(mig.applies).toBe(true);
    expect(mig.ready).toBe(false);
    expect(mig.blocked.map((v) => v.id)).toEqual(['G1']);
  });

  it('G1：descriptor version=3 → 迁移预检通过', () => {
    const result = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), descriptorEvent({ seq: 1, version: 3 }), turnEnd({ seq: 2 })]));
    expect(result.violations.filter((v) => v.id === 'G1')).toHaveLength(0);
    expect(migrationVerdict(result).ready).toBe(true);
  });

  it('G1 只约束 v0 源；v2 源官方容忍（不报 G1）', () => {
    const result = validateSessionLog(logOf(HEADER_V2, [userMessage({ seq: 0 }), descriptorEvent({ seq: 1, version: 2 }), turnEnd({ seq: 2 })]));
    expect(result.violations.filter((v) => v.id === 'G1')).toHaveLength(0);
  });

  it('G2：v0 源词表外 ignorable 事件 → 迁移 blocked；E3 豁免**不改**', () => {
    const result = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), unknownIgnorable({ seq: 1 }), turnEnd({ seq: 2 })]));
    expect(uniqueIds(result)).not.toContain('E3');      // 读取路径的 ignorable 豁免保持
    const g2 = result.violations.filter((v) => v.id === 'G2');
    expect(g2).toHaveLength(1);
    expect(g2[0].message).toMatch(/即使 ignorable|unknown historical/);
    expect(migrationVerdict(result).ready).toBe(false);
  });

  it('迁移预检覆盖边界显式：implemented 3 条、uncovered 非空、note 标注判据版本', () => {
    const mig = migrationVerdict(validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), turnEnd({ seq: 1 })])));
    expect(mig.coverage.implemented.length).toBe(3);   // G1/G2 + G3(title messageSeqs)
    expect(mig.coverage.uncovered.length).toBeGreaterThanOrEqual(4);
    expect(mig.coverage.note).toMatch(/0\.1\.5-rc\.2/);
    expect(mig.ready).toBe(true);                       // 该 v0 输入无 G 违规
  });

  // ── G3（config fixture：session/title 的 messageSeqs 引用约束）────────────────
  const turnStart = ({ seq, turn }) => ({ type: 'turn/start', seq, time: seq + 1, data: { turn } });
  const titleEvent = ({ seq, kind = 'llm', messageSeqs = [] }) => ({
    type: 'session/title', seq, time: seq + 1, data: { title: 't', source: { kind }, messageSeqs },
  });

  it('G3：v0 源 session/title 的 messageSeqs 必须引用更早的人类 user/message', () => {
    // 正例：用户标题 + 空 messageSeqs；引用 seq0 的人类 user/message 都合法
    const ok1 = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), titleEvent({ seq: 1, kind: 'user', messageSeqs: [] })]));
    expect(ok1.violations.filter((v) => v.id === 'G3')).toHaveLength(0);
    const ok2 = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), titleEvent({ seq: 1, kind: 'llm', messageSeqs: [0] })]));
    expect(ok2.violations.filter((v) => v.id === 'G3')).toHaveLength(0);
    // 反例 A：非用户标题却空 messageSeqs
    const bad1 = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 }), titleEvent({ seq: 1, kind: 'llm', messageSeqs: [] })]));
    expect(bad1.violations.filter((v) => v.id === 'G3').map((v) => v.message).join('|')).toMatch(/empty exactly for a user title/);
    // 反例 B：引用 assistant/message（非人类 user）
    const bad2 = validateSessionLog(logOf(HEADER, [assistantMessage({ seq: 0 }), titleEvent({ seq: 1, kind: 'llm', messageSeqs: [0] })]));
    expect(bad2.violations.filter((v) => v.id === 'G3').map((v) => v.message).join('|')).toMatch(/human user\/message/);
    // 非 v0 文件不受 G3 约束
    const v2 = validateSessionLog(logOf(HEADER_V2, [assistantMessage({ seq: 0 }), titleEvent({ seq: 1, kind: 'llm', messageSeqs: [0] })]));
    expect(v2.violations.filter((v) => v.id === 'G3')).toHaveLength(0);
  });

  it('G4（不实现）留档：turn/start 状态机在原始 v0 上会误报已 seed 会话 ⇒ 归未覆盖', () => {
    // 该用例是"我们**没有** G4"的守卫：任何在原始 v0 上重启 turn 状态机的实现都会让 G4 出现。
    const r = validateSessionLog(logOf(HEADER, [turnStart({ seq: 0, turn: 2 })]));
    expect(r.violations.filter((v) => v.id === 'G4')).toHaveLength(0);
    expect(migrationVerdict(r).coverage.uncovered.join('|')).toMatch(/turn\/start/);
  });

  it('v3：宿主当前格式 = v3 → 迁移不适用；宿主已带 v3→v4 → 迁移适用（v3→v4 归未覆盖）', () => {
    if (!HOST_V3) return;                               // rc.7 上 v3 走 S2 闸，不适用
    const mig = migrationVerdict(validateSessionLog(logOf(HEADER_V3, [userMessage({ seq: 0 }), turnEnd({ seq: 1 })])));
    if (MIGRATION_TARGET_VERSION === 3) {
      expect(mig.applies).toBe(false);
      expect(mig.ready).toBeNull();
      expect(mig.reason).toMatch(/无需迁移/);
    } else {
      expect(mig.targetFileVersion).toBe(MIGRATION_TARGET_VERSION);
      expect(mig.applies).toBe(true);
      expect(mig.assessmentScope).toBe('partial');
      expect(mig.coverage.uncovered.join('|')).toMatch(/v3→v4/);
    }
  });

  it('迁移预检不进 prewrite 的 ok（写前只看当前可否写入）', () => {
    const events = [userMessage({ seq: 0 }), descriptorEvent({ seq: 1, version: 2 }), turnEnd({ seq: 2 })];
    const pw = createPreWriter({ events, formatVersion: 0 });
    const r = pw.validateAppend(userMessage({ seq: 3 }));
    expect(r.ok).toBe(true);
  });

  it('CLI --json 带 migration 字段；文本输出含迁移预检（独立维度）', () => {
    const file = writeJsonl(HEADER, [userMessage({ seq: 0 }), descriptorEvent({ seq: 1, version: 2 }), turnEnd({ seq: 2 })]);
    const json = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(json.stdout);
    expect(payload.migration.applies).toBe(true);
    expect(payload.migration.ready).toBe(false);
    expect(payload.migration.blocked.map((v) => v.id)).toContain('G1');
    expect(json.status).toBe(4);                                  // 迁移 blocked ⇒ 退出码 4
    const text = spawnSync(process.execPath, [CLI, 'check', file], { encoding: 'utf8' });
    expect(text.stdout).toContain('迁移预检');
    expect(text.stdout).toContain('blocked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S1 收窄（2026-09-14）
//   残余 27 例原先在人读/机读两面**同时全绿**（✅ + ok=true + ready=true + exit 0）。
// ─────────────────────────────────────────────────────────────────────────────
describe('S1 收窄：待迁移文件不给无条件绿 + assessmentScope + 退出码', () => {
  const descriptorV2 = (seq) => ({ type: 'subagent/descriptor', seq, time: seq + 1, data: { turn: 0, step: 0, id: 'sub-1', version: 2 } });
  const plainV0File = () => writeJsonl(HEADER, [userMessage({ seq: 0 }), turnEnd({ seq: 1 })]);
  const g1File = () => writeJsonl(HEADER, [userMessage({ seq: 0 }), descriptorV2(1), turnEnd({ seq: 2 })]);

  it('待迁移文件纯文本输出无任何 ✅，末行含"部分覆盖/未覆盖"', () => {
    const file = plainV0File();
    for (const extra of [[], ['--resume']]) {
      const res = spawnSync(process.execPath, [CLI, 'check', file, ...extra], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain('✅');
      expect(res.stdout).toMatch(/部分覆盖|未覆盖/);
    }
  });

  it('assessmentScope —— 待迁移(v0)=partial；v3 在 v3 宿主=full、在 v4 宿主=partial（待 v3→v4）', () => {
    const p0 = JSON.parse(spawnSync(process.execPath, [CLI, 'check', plainV0File(), '--json'], { encoding: 'utf8' }).stdout);
    expect(p0.migration.applies).toBe(true);
    expect(p0.assessmentScope).toBe('partial');
    expect(p0.migration.assessmentScope).toBe('partial');

    const v3file = writeJsonl(HEADER_V3, [systemMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })]);
    const p3 = JSON.parse(spawnSync(process.execPath, [CLI, 'check', v3file, '--json'], { encoding: 'utf8' }).stdout);
    if (HOST_V3 && MIGRATION_TARGET_VERSION === 3) {
      expect(p3.migration.applies).toBe(false);
      expect(p3.assessmentScope).toBe('full');
    } else if (HOST_V3) {
      expect(p3.migration.applies).toBe(true);
      expect(p3.assessmentScope).toBe('partial');
    } else {
      // rc.7：v3 文件不可评估（S2 闸）⇒ scope=none，而不是 full（不谎称完整评估）
      expect(p3.assessable).toBe(false);
      expect(p3.assessmentScope).toBe('none');
    }
  });

  it('migration.ready===false ⇒ 退出码 4（默认与 --fail-on-migration 均然）', () => {
    const file = g1File();
    expect(spawnSync(process.execPath, [CLI, 'check', file], { encoding: 'utf8' }).status).toBe(4);
    expect(spawnSync(process.execPath, [CLI, 'check', file, '--fail-on-migration'], { encoding: 'utf8' }).status).toBe(4);
    const js = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8' });
    expect(js.status).toBe(4);
    expect(JSON.parse(js.stdout).migration.ready).toBe(false);
  });

  it('① opt-out：--no-fail-on-migration 恢复旧退出码（0），且优先于 --fail-on-migration', () => {
    const file = g1File();
    // 真 opt-out：迁移 blocked 但结构绿 ⇒ 旧行为 exit 0
    expect(spawnSync(process.execPath, [CLI, 'check', file, '--no-fail-on-migration'], { encoding: 'utf8' }).status).toBe(0);
    // 与 --fail-on-migration 同时给 ⇒ opt-out 优先
    expect(spawnSync(process.execPath, [CLI, 'check', file, '--no-fail-on-migration', '--fail-on-migration'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync(process.execPath, [CLI, 'check', file, '--fail-on-migration', '--no-fail-on-migration'], { encoding: 'utf8' }).status).toBe(0);
    // opt-out 不改结论本身（migration.ready 仍为 false，只是退出码回旧）
    const js = spawnSync(process.execPath, [CLI, 'check', file, '--no-fail-on-migration', '--json'], { encoding: 'utf8' });
    expect(js.status).toBe(0);
    expect(JSON.parse(js.stdout).migration.ready).toBe(false);
  });

  it('扩类文本：uncovered[0] 同时含 "does not close" 与 "does not open"', () => {
    const p = JSON.parse(spawnSync(process.execPath, [CLI, 'check', plainV0File(), '--json'], { encoding: 'utf8' }).stdout);
    const u0 = p.migration.coverage.uncovered[0];
    expect(u0).toMatch(/does not close the prior turn/);
    expect(u0).toMatch(/does not open expected turn/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 · C1 三入口补 ok===true 伴随断言（原断言只到 not.toContain，偏弱）
// ─────────────────────────────────────────────────────────────────────────────
describe('S7 · C1 三入口在 v3 宿主上的强断言（ok===true）', () => {
  const events = () => [userMessage({ seq: 0 }), assistantMessage({ seq: 1 }), v3Replace({ seq: 2, startSeq: 0, endSeq: 1, shadowed: [[0, 1]] }), turnEnd({ seq: 3 })];

  itV3('读取层 loadSessionLog → validateSessionLog ok=true（区间编码已展开）', () => {
    const log = loadSessionLog(writeJsonl(HEADER_V3, events()));
    const result = validateSessionLog(log);
    expect(uniqueIds(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary.surfaceNodes).toBe(1);
  });

  itV3('体检入口手搓 log → ok=true', () => {
    const result = validateSessionLog(logOf(HEADER_V3, events()));
    expect(uniqueIds(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  itV3('写前入口 createPreWriter → validateEdit ok=true', () => {
    const pw = createPreWriter({ events: events(), formatVersion: 3 });
    const r = pw.validateEdit(events());
    expect(uniqueIds(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --json 大报告（真管道，>64KiB）
// ─────────────────────────────────────────────────────────────────────────────
describe('CLI --json 大报告必须是合法 JSON', () => {
  it('3000 条违规（stdout > 64KiB）仍可 JSON.parse', () => {
    const events = [];
    for (let i = 0; i < 3000; i++) {
      events.push({ type: 'bogus/type', seq: i, time: i + 1, data: { n: i } });
    }
    const file = writeJsonl(HEADER, events);
    // 违规 → exit 1；spawnSync 不因非零退出抛错，能拿到完整 stdout
    const res = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    expect(res.status).toBe(1);
    const stdout = res.stdout;
    expect(stdout.length).toBeGreaterThan(64 * 1024);           // 确认真的大到会触发管道截断
    const payload = JSON.parse(stdout);                          // 截断则此处抛 "Unterminated string"
    expect(payload.ok).toBe(false);
    expect(payload.violations.length).toBeGreaterThanOrEqual(3000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v3 形状/字段层漏检（2026-09-14）——补成候选规则并钉住
// 依据：`@deepseek-ai/dsh-session@0.1.5-rc.1` 真源码（行号见各条 source）。
// 每条的对照实验：宿主**拒**、旧契约 0 违规。
// ─────────────────────────────────────────────────────────────────────────────
describe('v3 形状/字段层漏检（候选规则 E8/E9/E10）', () => {
  const checkEvents = (events, header = HEADER_V3) => validateSessionLog({
    header, headerLine: 0, rows: [], events: events.map((event) => ({ event })), frameInfo: { frames: 0, torn: false },
  });
  const baseV3 = () => [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  ];

  itV3('E8：信封多余键 `extra` → error（宿主 assertSessionEventEnvelope 只认 7 键）', () => {
    const result = checkEvents([...baseV3(), { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', extra: 1, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [] } }]);
    expect(result.violations.map((v) => v.id)).toContain('E8');
    // 对照：无多余键 → 不报 E8
    const clean = checkEvents([...baseV3(), { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [] } }]);
    expect(clean.violations.map((v) => v.id)).not.toContain('E8');
  });

  itV3('E9：system/message 的 source 不是 plugin → error（宿主 :942-944）', () => {
    const bad = systemMessage({ seq: 1 });
    bad.data.message.source = { kind: 'user' };   // 反例形态
    const result = checkEvents([...baseV3(), bad]);
    expect(result.violations.map((v) => v.id)).toContain('E9');
    // 对照：plugin source + 非空 plugin → 不报
    const good = systemMessage({ seq: 1 });
    good.data.message.source = { kind: 'plugin', plugin: 'dsh-retrace' };
    const clean = checkEvents([...baseV3(), good]);
    expect(clean.violations.map((v) => v.id)).not.toContain('E9');
  });

  itV3('E10：request/header 带 header.system → error（宿主 :237）', () => {
    const bad = { type: 'request/header', seq: 1, time: 2, surfaceOp: 'append', data: { header: { system: 'you are…', tools: [] } } };
    const result = checkEvents([...baseV3(), bad]);
    const ids = result.violations.map((v) => v.id);
    expect(ids).toContain('E10');
    expect(ids.filter((id) => id === 'E10').length).toBeGreaterThanOrEqual(2); // system 与空 tools 两条
    // 对照：不带 system/空 tools → 不报 E10
    const good = { type: 'request/header', seq: 1, time: 2, surfaceOp: 'append', data: { header: { tools: [{ name: 't' }] } } };
    const clean = checkEvents([...baseV3(), good]);
    expect(clean.violations.map((v) => v.id)).not.toContain('E10');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 历史 marker 白名单收窄 + 版本门 + 一次性根治（2026-09-14）
// 旧判据"任意 data.editor"是"设计粗糙的豁口"（第三方同形状也能领豁免）。
// ─────────────────────────────────────────────────────────────────────────────
describe('历史 marker 白名单（收窄 + ≤v2 版本门 + 可见降级 + 一次性根治）', () => {
  const { markerEvent: mkMarker, validSessionEvents: validEvents, userMessage: mkUser, HEADER: H0 } = helpersForRc;

  it('可识别历史载体 + 写入通过 → legacyMarkerDebt 可见（kind/id/targetSeq/seq/formatVersion）', () => {
    const r = createPreWriter({ events: validEvents(), header: H0 })
      .validateAppend(mkMarker({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] }));
    expect(r.ok).toBe(true);
    expect(r.legacyMarkerDebt).toMatchObject({ kind: 'retrace', id: 'retrace-edit-x', targetSeq: 0, seq: 3, formatVersion: 0 });
  });

  it('第三方同形状（id 无 retrace 前缀）→ 不认（debt=null；旧判据会放行）', () => {
    const r = createPreWriter({ events: validEvents(), header: H0 })
      .validateAppend(mkMarker({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1], id: 'third-party-edit' }));
    expect(r.legacyMarkerDebt).toBe(null);
  });

  it('形状不符（editor.targetSeq ≠ op.start）→ 不认（debt=null）', () => {
    const ev = mkMarker({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] });
    ev.data.editor.targetSeq = 99;
    const r = createPreWriter({ events: validEvents(), header: H0 }).validateAppend(ev);
    expect(r.legacyMarkerDebt).toBe(null);
  });

  itV3('版本门：v3 文件上同一历史载体 → 不降级（debt=null；v3 上降级救不回任何写入）', () => {
    const r = createPreWriter({ events: validEvents(), header: { ...H0, version: 3 } })
      .validateAppend(mkMarker({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] }));
    expect(r.legacyMarkerDebt).toBe(null);
  });

  it('T1 降级真的生效且**只对可识别载体**：同样形状、只差 id 前缀 → warning vs error', () => {
    // 基座含 step/start（T1 才会做配对检查）+ 关闭的 step；marker 的 turn/step 与打开的不符 ⇒ T1 命中拟写事件自身
    const base = [
      mkUser({ seq: 0 }),
      { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 0, step: 1 } },
    ];
    const carrier = { seq: 3, start: 0, end: 2, shadowedSeqs: [0, 1, 2], turn: 7, step: 7 };
    const withRetraceId = createPreWriter({ events: base, header: H0 }).validateAppend(mkMarker(carrier));
    expect(withRetraceId.violations.filter((v) => v.id === 'T1').map((v) => v.severity)).toEqual(['warning']);
    const withThirdPartyId = createPreWriter({ events: base, header: H0 }).validateAppend(mkMarker({ ...carrier, id: 'third-party-edit' }));
    expect(withThirdPartyId.violations.filter((v) => v.id === 'T1').map((v) => v.severity)).toEqual(['error']);
  });

  it('一次性根治 `neutralizeMarkersText({onlyLegacy:true})`：只中和历史载体，新载体不动', () => {
    // 历史债的形态 = turn-null 的载体 marker（`neutralizeMarkersText` 的口径:turn/step 为 null）
    const legacy = JSON.stringify(mkMarker({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1], turn: null, step: null }));
    const modernCarrier = JSON.stringify({ type: 'user/message', seq: 4, time: 5, surfaceOp: 'replace', sourceEventSeqs: [0, 1, 3], data: { id: 'retrace-marker-xyz', role: 'user', source: { kind: 'user' }, content: [] } });
    const text = [JSON.stringify(mkUser({ seq: 0 })), JSON.stringify(mkUser({ seq: 1 })), legacy, modernCarrier, ''].join('\n');
    const r = neutralizeLegacy(text);
    expect(r.neutralized).toBe(1);
    const lines = r.text.split('\n');
    expect(JSON.parse(lines[2]).type).toBe('retrace/marker');
    expect(JSON.parse(lines[2]).ignorable).toBe(true);
    expect(JSON.parse(lines[2]).surfaceOp).toBeUndefined();
    expect(JSON.parse(lines[3]).type).toBe('user/message');   // 新载体原样保留
  });
});
