/**
 * test/read-tolerance.test.js —— R4 / R5 负对照套件（0.3.28）
 *
 * 事故形态（真实）：一个**截断 zstd 帧**的会话文件让会话读头抛 `ERR_OUT_OF_RANGE`，
 * 逐会话读头的"枚举/汇总类"能力整体失败（33 天内数百次）——**单文件损坏 ⇒ 整表失败**。
 * 根因有两个，各钉成一条规则 + 正反对照：
 *
 *   R4 读取/解析容错：单文件异常必须降级为结构化结果（null / 逐行 error 标记 /
 *      frameInfo 事实 + 可统计计数），**不得抛出**中断枚举与汇总。
 *      历史 bug：`scanZstdFrames` 块头只校验"剩 ≥3 字节"却 `readUInt32LE`（读 4 字节）
 *      ⇒ 恰剩 3 字节时抛 ERR_OUT_OF_RANGE。
 *   R5 汇总/枚举类 API 逐项隔离：单项异常只丢该项并**计数**（skipped），
 *      整体结果照常返回（per-item try/catch）。
 *
 * 每条 = 违规样本必须"判红"（结构化违规/计数，而不是抛栈）＋ 合规样本必须绿。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditToolCalls,
  extractToolOutputs,
  indexToolCalls,
  loadSessionLog,
  readSessionHeader,
  tailSeq,
  validateSessionLog,
} from '../lib/index.js';
import { scanZstdFrames } from '../lib/log-reader.js';
import { ruleById } from '../lib/contracts.js';
import {
  HEADER,
  toolResultMessage,
  userMessage,
  validSessionEvents,
  writeRawSession,
  writeSession,
  writeSessionFrames,
} from './helpers.js';

const ids = (violations) => [...new Set(violations.map((v) => v.id))].sort();

/** 追加一段"残缺 zstd 帧"字节（不压缩任何东西，只写字节）。 */
function withPartialTrailingFrame(file, partialBytes) {
  const buf = fs.readFileSync(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const out = path.join(dir, 'torn-partial.jsonl.zstd');
  fs.writeFileSync(out, Buffer.concat([buf, partialBytes]));
  return out;
}

describe('R4 · 读取/解析容错（单文件损坏 ⇒ 结构化降级，不得抛）', () => {
  it("R4 / R5 注册表绑定：error 级、persistence 层", () => {
    expect(ruleById('R4')?.severity).toBe('error');
    expect(ruleById('R4')?.layer).toBe('persistence');
    expect(ruleById('R5')?.severity).toBe('error');
    expect(ruleById('R5')?.layer).toBe('persistence');
  });

  // ── 违规样本（历史抛错形态）────────────────────────────────────────────
  it('R4 负对照①：尾帧块头恰剩 3 字节（ERR_OUT_OF_RANGE 形态）⇒ 帧扫描判 torn，不抛', () => {
    const healthy = writeSession(validSessionEvents(), { zstd: true });
    // magic(4) + descriptor(0x00) + window(1) + **块头残缺 3 字节** = 9 字节残帧。
    const partial = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x02, 0x03]);
    const torn = withPartialTrailingFrame(healthy, partial);
    const buf = fs.readFileSync(torn);
    let scanned;
    expect(() => { scanned = scanZstdFrames(buf); }).not.toThrow();
    expect(scanned.torn).toBe(true);          // 判红：撕裂尾帧被识别（不是抛栈）
    expect(scanned.frames.length).toBeGreaterThan(0); // 前面的完整帧仍在
  });

  it('R4 负对照②：同一截断文件 ⇒ 读头/全量读/尾部查询都返回结构化结果，不抛', () => {
    const healthy = writeSession(validSessionEvents(), { zstd: true });
    const partial = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x02, 0x03]);
    const torn = withPartialTrailingFrame(healthy, partial);

    let header = 'untouched';
    expect(() => { header = readSessionHeader(torn); }).not.toThrow();
    expect(header?.type).toBe('session');     // 结构化结果（可被聚合方统计）

    let log = null;
    expect(() => { log = loadSessionLog(torn); }).not.toThrow();
    expect(log.frameInfo.torn).toBe(true);
    expect(log.events.length).toBe(validSessionEvents().length); // 完整帧的事件都在

    let tail = 'untouched';
    expect(() => { tail = tailSeq(torn); }).not.toThrow();
    expect(typeof tail).toBe('number');

    const result = validateSessionLog(log);
    expect(result.violations.some((v) => v.id === 'Z1')).toBe(true); // 判红走规则
    expect(result.summary.tailStatus).toBe('interrupted');
  });

  it('R4 负对照③：截进首帧（一个完整帧都不剩）⇒ 结构化失败（Z2/H1 判红），不抛', () => {
    const torn = writeSessionFrames([JSON.stringify(HEADER)], { torn: 'head' });
    let header = 'untouched';
    expect(() => { header = readSessionHeader(torn); }).not.toThrow();
    expect(header).toBeNull();
    let tail = 'untouched';
    expect(() => { tail = tailSeq(torn); }).not.toThrow();
    expect(tail).toBeNull();
    const log = loadSessionLog(torn);
    expect(log.events).toHaveLength(0);
    const result = validateSessionLog(log);
    expect(result.ok).toBe(false);
    expect(ids(result.violations)).toEqual(expect.arrayContaining(['H1', 'Z2']));
    expect(result.summary.tailStatus).toBe('unknown');
  });

  it('R4 负对照④：损坏行 + 坏 chunk 行 ⇒ 逐行 error 标记（R1/R2 判红）+ 可统计，不抛', () => {
    const file = writeRawSession([
      JSON.stringify(HEADER),
      JSON.stringify(userMessage({ seq: 0 })),
      '{ 这行不是 JSON',
      JSON.stringify({ type: 'text-chunks', seq0: 1, time0: 2, data: { turn: 0 } }), // 坏 chunk 行
    ]);
    const log = loadSessionLog(file);
    expect(log.rows.filter((r) => r.error).length).toBe(2); // 可统计
    const result = validateSessionLog(log);
    expect(ids(result.violations)).toEqual(expect.arrayContaining(['R1', 'R2']));
    expect(result.summary.unreadableRows).toBe(2);          // R4"可统计"字段
  });

  // ── 合规样本（必须绿）──────────────────────────────────────────────────
  it('R4 正对照：健康样本 ⇒ 全绿、tailStatus=complete、unreadableRows=0', () => {
    const file = writeSession(validSessionEvents(), { zstd: true });
    const log = loadSessionLog(file);
    expect(readSessionHeader(file)?.type).toBe('session');
    expect(typeof tailSeq(file)).toBe('number');
    const result = validateSessionLog(log);
    expect(result.ok).toBe(true);
    expect(result.summary.tailStatus).toBe('complete');
    expect(result.summary.unreadableRows).toBe(0);
  });
});

describe('R5 · 汇总/枚举类 API 逐项隔离（per-item try/catch + 失败计数）', () => {
  const goodCall = (seq, callId) => ({
    type: 'tool/call',
    seq,
    time: seq + 1,
    data: { callId, arguments: JSON.stringify({ command: 'build-report' }) },
  });
  /** 违规样本：读取即抛的畸形事件（历史形态"一项坏 ⇒ 整批抛"）。 */
  const poison = {
    type: 'tool/result',
    seq: 1,
    time: 2,
    data: {
      get message() {
        throw new Error('poison event: field access throws');
      },
    },
  };

  it('R5 负对照：畸形事件只丢该项并计数（skipped≥1），其余项照常汇总', () => {
    const events = [goodCall(0, 'call-a'), poison, toolResultMessage({ seq: 3, callId: 'call-b' }), goodCall(4, 'call-b')];
    let audit = null;
    expect(() => { audit = auditToolCalls(events); }).not.toThrow();
    expect(audit.skipped).toBeGreaterThanOrEqual(1); // 判红：坏项被计数（可统计）
    expect(audit.calls).toBe(2);                    // 好项照常汇总

    let extract = null;
    expect(() => { extract = extractToolOutputs(events, 'build-report'); }).not.toThrow();
    expect(extract.skipped).toBeGreaterThanOrEqual(1);

    const indexed = indexToolCalls(events);
    expect(indexed.skipped).toBeGreaterThanOrEqual(1);
    expect(indexed.orphans).toContain('call-a');
  });

  it('R5 正对照：全部合规 ⇒ skipped=0、汇总完整', () => {
    const events = [goodCall(0, 'call-a'), toolResultMessage({ seq: 1, callId: 'call-a' })];
    const audit = auditToolCalls(events);
    expect(audit.skipped).toBe(0);
    expect(audit.calls).toBe(1);
    expect(audit.paired).toBe(1);
    expect(audit.pairingRate).toBe(1);
    expect(extractToolOutputs(events).skipped).toBe(0);
    expect(indexToolCalls(events).skipped).toBe(0);
  });
});
