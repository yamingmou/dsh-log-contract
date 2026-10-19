/**
 * dsh-log-contract · test/v4-gaps.test.js —— 0.3.19「v4 契约补充最小集」五条硬规则
 *
 * 来源：外部长期治理 V0→V4 的成员给出的最小集（5 条全是"不修就会在真件上反复出错"）。
 * 本文件逐条钉住：**正例 + 反例**，并给出真实会话语料上的读数（夹具缺失则显式 skip）。
 *
 *   G4  未知历史事件"声明式可忽略"（ignorable:true + 白名单；迁移不得硬拒）
 *   S10 sourceEventSeqs 元素类型硬断言（解码后必须非负整数；存储形态只允许官方区间对）
 *   I2  seedLength = 继承事件条数（不是字节数）；parentSession ∧ seedLength∈{缺失,0} 合法
 *   P5  carrier 两段配对（第 2 段 sourceEventSeqs 首元素 = 第 1 段 seq；读侧容错）
 *   A1  在位可还原只认结构化归档指针（archiveRef / archive / externalized.*；禁止文本 grep）
 *
 * **真实语料**（只读；仓内不写私有目录名）：
 *   - `DSH_LOG_CONTRACT_REAL_SESSIONS_DIR`：真实会话目录（默认 `<DSH_HOME>/sessions`）；
 *   - `DSH_LOG_CONTRACT_BACKUP_DIR`：v0 化石/备份目录（默认 `~/dsh-log-contract-backups`）；
 *   - `DSH_LOG_CONTRACT_ARCHIVE_ROOTS`：归档根（path.delimiter 分隔）。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveVerdict,
  collectArchivePointers,
  createPreWriter,
  loadSessionLog,
  migrationVerdict,
  validateSessionLog,
  verifyArchivePointers,
} from '../lib/index.js';
import {
  carrierPairingViolations,
  carrierWriteViolations,
  declarativeIgnorableViolations,
  rawSourceEventSeqViolations,
  seedLengthViolations,
  sourceEventSeqElementViolations,
} from '../lib/checks.js';
import { faithfulFrameInfo, HEADER, turnEnd, userMessage, writeRawSession } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');

const REAL_SESSIONS_DIR = process.env.DSH_LOG_CONTRACT_REAL_SESSIONS_DIR ?? path.join(os.homedir(), 'dsh-v3', 'sessions');
const BACKUP_DIR = process.env.DSH_LOG_CONTRACT_BACKUP_DIR ?? path.join(os.homedir(), 'dsh-log-contract-backups');
const ARCHIVE_ROOTS = (process.env.DSH_LOG_CONTRACT_ARCHIVE_ROOTS ?? '').split(path.delimiter).filter(Boolean);

/** 手搓 log 对象（与 `loadSessionLog` 同形；frameInfo 走官方分帧形状，避免平白触发 Z5）。 */
function logOf(header, events) {
  return {
    header,
    headerLine: 0,
    rows: events.map((e, i) => ({ lineNo: i + 1, value: e, decoded: [e], error: null })),
    events: events.map((e, i) => ({ seq: e.seq, event: e, lineNo: i + 1 })),
    frameInfo: faithfulFrameInfo({ eventRows: events.length }),
  };
}

const ids = (violations) => [...new Set(violations.map((v) => v.id))].sort();

/** 按压缩体积升序（真实语料测试先读小文件，避免被 1.5M 事件的巨件拖慢）。 */
function bySizeAsc(files) {
  return files
    .map((f) => ({ f, size: (() => { try { return fs.statSync(f).size; } catch { return Infinity; } })() }))
    .sort((a, b) => a.size - b.size)
    .map((x) => x.f);
}

/** 一个目录里的全部会话文件（递归；深度有界）。 */
function sessionFiles(dir, depth = 0, out = []) {
  if (!fs.existsSync(dir) || depth > 6) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) sessionFiles(full, depth + 1, out);
    else if (/\.jsonl\.zstd$/.test(name)) out.push(full);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// G4 · 未知历史事件的"声明式可忽略" + 白名单（最小集 ①）
// ─────────────────────────────────────────────────────────────────────────────
describe('G4 · 未知历史事件声明式可忽略（ignorable:true + 白名单）', () => {
  const HEADER_V0 = { ...HEADER, version: 0 };
  const goalMarker = { type: 'retrace/goal-marker', seq: 1, time: 2, ignorable: true, data: { note: 'goal' } };

  it('正例：v0 源 unknown + ignorable（retrace/ 默认白名单）⇒ 迁移不硬拒，登记为 acceptedDrop', () => {
    const result = validateSessionLog(logOf(HEADER_V0, [userMessage({ seq: 0 }), goalMarker, turnEnd({ seq: 2 })]));
    // 读取路径：E3 的 ignorable 豁免保持（不报错），日志可加载
    expect(ids(result.violations)).not.toContain('E3');
    expect(ids(result.violations)).not.toContain('G4');
    expect(result.ok).toBe(true);
    // G2 事实预检仍保留（官方 v0→v1 会拒），但它不再阻断迁移
    const g2 = result.violations.filter((v) => v.id === 'G2');
    expect(g2).toHaveLength(1);
    expect(g2[0].ignorableRegistered).toBe(true);
    const mig = migrationVerdict(result);
    expect(mig.ready).toBe(true);
    expect(mig.acceptedDrops.registered).toHaveLength(1);
    expect(mig.acceptedDrops.unregistered).toHaveLength(0);
  });

  it('反例：unknown 但**没有** ignorable ⇒ 读路径 E3 error（硬拒）', () => {
    const bare = { type: 'retrace/goal-marker', seq: 1, time: 2, data: { note: 'goal' } };
    const result = validateSessionLog(logOf(HEADER_V0, [userMessage({ seq: 0 }), bare, turnEnd({ seq: 2 })]));
    expect(ids(result.violations)).toContain('E3');
    expect(result.ok).toBe(false);
  });

  it('反例：unknown + ignorable 但**未登记** ⇒ G4 warning 且迁移仍阻断（⛔ 不静默）', () => {
    const unknown = { type: 'third-party/checkpoint', seq: 1, time: 2, ignorable: true, data: { note: 'x' } };
    const result = validateSessionLog(logOf(HEADER_V0, [userMessage({ seq: 0 }), unknown, turnEnd({ seq: 2 })]));
    const g4 = result.violations.filter((v) => v.id === 'G4');
    expect(g4).toHaveLength(1);
    expect(g4[0].severity).toBe('warning');
    expect(migrationVerdict(result).ready).toBe(false);
  });

  it('正例：白名单从配置注入（opts）⇒ 未登记类型变成 acceptedDrop', () => {
    const unknown = { type: 'third-party/checkpoint', seq: 1, time: 2, ignorable: true, data: { note: 'x' } };
    const result = validateSessionLog(
      logOf(HEADER_V0, [userMessage({ seq: 0 }), unknown, turnEnd({ seq: 2 })]),
      { ignorableWhitelist: ['third-party/'] },
    );
    expect(result.violations.filter((v) => v.id === 'G4')).toHaveLength(0);
    const mig = migrationVerdict(result);
    expect(mig.ready).toBe(true);
    expect(mig.acceptedDrops.registered.map((d) => d.eventType)).toContain('third-party/checkpoint');
  });

  it('写侧：拟写 unknown + ignorable 不被硬拒（只可能给 G4 warning）；未知无 ignorable 仍拒（E3）', () => {
    const base = [userMessage({ seq: 0 }), turnEnd({ seq: 1 })];
    const appended = createPreWriter({ events: base, header: HEADER_V0 })
      .validateAppend({ type: 'third-party/checkpoint', time: 9, ignorable: true, data: { note: 'x' } });
    expect(appended.violations.filter((v) => v.severity === 'error')).toEqual([]);
    expect(appended.violations.filter((v) => v.id === 'G4')).toHaveLength(1);
    expect(appended.ok).toBe(true); // warning 不阻断写入

    const bare = createPreWriter({ events: base, header: HEADER_V0 })
      .validateAppend({ type: 'third-party/checkpoint', time: 9, data: { note: 'x' } });
    expect(bare.ok).toBe(false);
    expect(ids(bare.violations)).toContain('E3');
  });

  it('纯函数：白名单命中规则（精确 type / 前缀 / 未命中）', () => {
    const events = [{ event: { type: 'retrace/goal-marker', seq: 1, ignorable: true }, lineNo: 1 },
      { event: { type: 'vendor/x', seq: 2, ignorable: true }, lineNo: 2 }];
    const r = declarativeIgnorableViolations(events, 0);
    expect(r.registered.map((d) => d.type)).toEqual(['retrace/goal-marker']);
    expect(r.unregistered.map((d) => d.type)).toEqual(['vendor/x']);
    const injected = declarativeIgnorableViolations(events, 0, { ignorableWhitelist: ['vendor/x'] });
    expect(injected.unregistered).toEqual([]);
  });

  it('真实 v0 化石（存在则实测）：含 retrace/goal-marker + ignorable ⇒ registered，不阻断迁移', () => {
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((n) => n.includes('pre-migration-refuse') && /\.zstd$/.test(n)) : [];
    if (files.length === 0) {
      console.warn('skip: 真实 v0 化石不在本机（设置 DSH_LOG_CONTRACT_BACKUP_DIR）');
      return;
    }
    const log = loadSessionLog(path.join(BACKUP_DIR, files[0]));
    const result = validateSessionLog(log);
    const mig = migrationVerdict(result);
    expect(mig.acceptedDrops.registered.map((d) => d.eventType)).toContain('retrace/goal-marker');
    expect(result.violations.filter((v) => v.id === 'G4')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S10 · sourceEventSeqs 元素类型硬断言（最小集 ②）
// ─────────────────────────────────────────────────────────────────────────────
describe('S10 · sourceEventSeqs 元素必须是非负整数（解码后）', () => {
  const carrier = (sourceEventSeqs) => ({
    type: 'user/message', seq: 2, time: 3, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
    sourceEventSeqs,
    data: { id: 'r-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] },
  });

  it('正例：dense 非负整数 ⇒ 0 违规', () => {
    const events = [{ event: carrier([0, 1]), lineNo: 1 }];
    expect(sourceEventSeqElementViolations(events)).toEqual([]);
  });

  it('正例（真实存储形态）：官方区间对 [a,b] 是合法形态，解码后无违规', () => {
    const header = { ...HEADER, version: 3 };
    const lines = [
      JSON.stringify(header),
      JSON.stringify({ type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'u0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] } }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'b' }] } }),
      // v3 官方 encodeSeqRanges：连续 ≥3 压成 [start,end]；这里 [0,1] 是显式区间对写法
      JSON.stringify({ type: 'user/message', seq: 2, time: 3, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [[0, 1]], data: { id: 'r2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'c' }] } }),
    ];
    const file = writeRawSession(lines);
    const log = loadSessionLog(file);
    expect(ids(validateSessionLog(log).violations)).not.toContain('S10');
    expect(rawSourceEventSeqViolations(log.rows)).toEqual([]);
    expect(sourceEventSeqElementViolations(log.events)).toEqual([]);
  });

  it('反例（解码后仍是嵌套数组）：S10 error，并指认该事件 seq', () => {
    const events = [{ event: { ...carrier([[0, 1]]), seq: 5 }, lineNo: 9 }];
    const v = sourceEventSeqElementViolations(events);
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('S10');
    expect(v[0].severity).toBe('error');
    expect(v[0].seq).toBe(5);
    expect(v[0].message).toContain('嵌套数组');
  });

  it('反例（非整数元素：字符串/负数/小数）：S10 error', () => {
    for (const bad of [['1'], [-1], [1.5], [null], [undefined]]) {
      const v = sourceEventSeqElementViolations([{ event: { ...carrier(bad), seq: 3 }, lineNo: 1 }]);
      expect(v.map((x) => x.id)).toEqual(['S10']);
    }
  });

  it('反例（存储形态非法：[a,b,c] / [b,a]）：raw 层 S10 error', () => {
    const rows = (src) => [{ lineNo: 1, value: { type: 'user/message', seq: 2, sourceEventSeqs: src }, error: null }];
    expect(rawSourceEventSeqViolations(rows([[1, 2, 3]])).map((v) => v.id)).toEqual(['S10']);
    expect(rawSourceEventSeqViolations(rows([[5, 3]])).map((v) => v.id)).toEqual(['S10']);
    // 形态合法但非严格递增（两段相邻区间重叠）⇒ 官方 decodeSeqRanges 失败 ⇒ S10
    expect(rawSourceEventSeqViolations(rows([[0, 3], [2, 5]])).map((v) => v.id)).toEqual(['S10']);
  });

  it('覆盖面：非 surface / ignorable 未知事件上的坏 provenance 也判 S10（旧实现是真空区）', () => {
    const events = [{ event: { type: 'plugin/x', seq: 4, ignorable: true, sourceEventSeqs: [[1, 2]] }, lineNo: 2 }];
    expect(sourceEventSeqElementViolations(events).map((v) => v.id)).toEqual(['S10']);
  });

  it('写前：拟写事件带嵌套数组 ⇒ 写入被拒（S10 error）', () => {
    const base = [userMessage({ seq: 0 }), userMessage({ seq: 1 })];
    const r = createPreWriter({ events: base, header: { ...HEADER, version: 3 } })
      .validateAppend({ ...carrier([[0, 1, 2]]), seq: undefined });
    expect(r.ok).toBe(false);
    expect(ids(r.violations)).toContain('S10');
  });

  it('真实 v3/v4 语料（存在则实测）：合法区间对不被误报，S10 命中 0', { timeout: 120000 }, () => {
    if (!fs.existsSync(REAL_SESSIONS_DIR)) {
      console.warn('skip: 真实会话目录不存在（设置 DSH_LOG_CONTRACT_REAL_SESSIONS_DIR）');
      return;
    }
    const files = bySizeAsc(sessionFiles(REAL_SESSIONS_DIR)).slice(0, 30);
    let checked = 0;
    let rangePairs = 0;
    for (const file of files) {
      const log = loadSessionLog(file);
      if (![3, 4].includes(log.header?.version)) continue;
      checked++;
      const s10 = validateSessionLog(log).violations.filter((v) => v.id === 'S10');
      expect(s10).toEqual([]);
      for (const row of log.rows) {
        const src = row.value?.sourceEventSeqs;
        if (Array.isArray(src)) rangePairs += src.filter((x) => Array.isArray(x)).length;
      }
    }
    expect(checked).toBeGreaterThan(0);
    console.info(`[real] S10：${checked} 份真实 v3/v4，嵌套区间对 ${rangePairs} 处，S10=0（合法存储形态不误报）`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I2 · seedLength = 继承事件条数（最小集 ③）
// ─────────────────────────────────────────────────────────────────────────────
describe('I2 · seedLength 语义 = 继承事件条数（不是字节数）', () => {
  const v0 = (extra) => ({ ...HEADER, version: 0, ...extra });
  const events = () => [{ seq: 0, type: 'user/message' }, { seq: 1, type: 'turn/end' }, { seq: 2, type: 'step/end' }];

  it('正例：parentSession 有值 ∧ seedLength 缺失 ⇒ 合法（血缘 ≠ seeded；真实 712/760 属此类）', () => {
    const v = seedLengthViolations(v0({ parentSession: 'session-parent' }), events(), 0);
    expect(v).toEqual([]);
  });

  it('正例：parentSession 有值 ∧ seedLength === 0 ⇒ 合法（官方 isSeeded 只由字段是否存在决定）', () => {
    const v = seedLengthViolations(v0({ parentSession: 'session-parent', seedLength: 0 }), events(), 0);
    expect(v).toEqual([]);
  });

  it('正例：seedLength === 展开后事件数 ⇒ 合法（继承全部前缀）', () => {
    expect(seedLengthViolations(v0({ seedLength: 3 }), events(), 0)).toEqual([]);
  });

  it('反例：seedLength 超过展开后事件数（字节数口径）⇒ I2 error', () => {
    const v = seedLengthViolations(v0({ seedLength: 153113, parentSession: 'p' }), events(), 0);
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('I2');
    expect(v[0].severity).toBe('error');
    expect(v[0].message).toContain('继承事件条数');
  });

  it('反例：seedLength 非非负安全整数 ⇒ I2 error', () => {
    for (const bad of [-1, 1.5, '10', null]) {
      expect(seedLengthViolations(v0({ seedLength: bad }), events(), 0).map((x) => x.id)).toEqual(['I2']);
    }
  });

  it('反例：v4 会话头带 seedLength ⇒ I2 error（宿主 header 校验直接拒）', () => {
    const v = seedLengthViolations({ ...HEADER, version: 4, seedLength: 2 }, events(), 4);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('v4 会话头不得带 seedLength');
  });

  it('真实 v0 化石（存在则实测）：seedLength 与"继承事件条数"一致，且不可能是字节数/行数', { timeout: 120000 }, () => {
    const files = fs.existsSync(BACKUP_DIR)
      ? fs.readdirSync(BACKUP_DIR).filter((n) => /\.jsonl\.zstd$/.test(n))
      : [];
    let scanned = 0;
    let withSeed = 0;
    let overCount = 0;
    let byteRefutations = 0;
    for (const name of bySizeAsc(files.map((n) => path.join(BACKUP_DIR, n))).slice(0, 8)) {
      const log = loadSessionLog(name);
      if (log.header?.version !== 0) continue;
      scanned++;
      const seed = log.header?.seedLength;
      if (!Number.isSafeInteger(seed) || seed === 0) continue;
      withSeed++;
      // 判红分支：seedLength > 展开后事件数（本机真实语料 0 例 —— 如实计数，不制造红）
      if (seed > log.events.length) overCount++;
      // 字节口径反证：明文体积远大于 seedLength ⇒ seedLength 不可能是字节数
      if (seed < log.frameInfo.plaintextBytes / 2) byteRefutations++;
      // I2 只用 header + 展开后事件数（不走整份 fold：真实 v0 巨件会超时）
      expect(seedLengthViolations(log.header, log.events.map((e) => e.event), 0)).toEqual([]);
    }
    if (scanned === 0) {
      console.warn('skip: 本机没有真实 v0 化石（设置 DSH_LOG_CONTRACT_BACKUP_DIR）');
      return;
    }
    expect(withSeed).toBeGreaterThan(0);
    expect(overCount).toBe(0);
    expect(byteRefutations).toBe(withSeed);
    console.info(`[real] I2：${scanned} 份真实 v0 化石，${withSeed} 份带 seedLength；0 例超过展开后事件数；${byteRefutations}/${withSeed} 份明文体积 > 2×seedLength（字节口径被反证）`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5 · carrier 两段配对（最小集 ④）
// ─────────────────────────────────────────────────────────────────────────────
describe('P5 · carrier 两段配对（第 2 段 sourceEventSeqs 首元素 = 第 1 段 seq）', () => {
  const HEADER_V3 = { ...HEADER, version: 3 };
  /** 审计段：compaction/prune + shadowedRange/shadowedSeqs（真实两段载体第 1 段）。 */
  const audit = (seq, start, end, shadowed) => ({
    type: 'compaction/prune', seq, time: seq + 1,
    data: { shadowedRange: { start, end }, shadowedSeqs: shadowed, shadowedTokenCount: 0 },
  });
  const carrier = ({ seq, startSeq, endSeq, sourceEventSeqs }) => ({
    type: 'user/message', seq, time: seq + 1,
    surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs,
    data: { id: `carrier-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'edited' }] },
  });
  const base = () => [userMessage({ seq: 0 }), userMessage({ seq: 1 }), turnEnd({ seq: 2 })];

  it('正例（现役写法）：首元素 = 审计段 seq ⇒ 读侧 0 违规', () => {
    const events = [
      ...base(), audit(3, 0, 1, [0, 1]), carrier({ seq: 4, startSeq: 0, endSeq: 1, sourceEventSeqs: [3, 0, 1] }),
    ];
    expect(carrierPairingViolations(events.map((e, i) => ({ event: e, lineNo: i + 1 })), { version: 3 })).toEqual([]);
  });

  it('正例（早期写法，读侧容错）：首元素 = 区间起点、不引用审计段 seq ⇒ 0 违规', () => {
    // 真实语料里的 fix-line-tri-fold 载体即此写法（170+ 个）；读侧必须认，否则全成"孤儿"。
    const events = [
      ...base(), audit(3, 0, 1, [0, 1]), carrier({ seq: 4, startSeq: 0, endSeq: 1, sourceEventSeqs: [0, 1] }),
    ];
    expect(carrierPairingViolations(events.map((e, i) => ({ event: e, lineNo: i + 1 })), { version: 3 })).toEqual([]);
  });

  it('反例：审计段 seq 在中间位且首元素既非审计段也非区间起点 ⇒ P5 error', () => {
    const events = [
      ...base(),
      audit(3, 0, 2, [0, 1, 2]),
      carrier({ seq: 4, startSeq: 0, endSeq: 2, sourceEventSeqs: [2, 3, 0, 1] }),
    ];
    const v = carrierPairingViolations(events.map((e, i) => ({ event: e, lineNo: i + 1 })), { version: 3 });
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
  });

  it('反例：载体紧邻审计段、未引用它且首元素不是区间起点（孤儿审计段）⇒ P5 error', () => {
    const events = [
      ...base(),
      audit(3, 0, 2, [0, 1, 2]),
      carrier({ seq: 4, startSeq: 0, endSeq: 2, sourceEventSeqs: [2, 0, 1] }),
    ];
    const v = carrierPairingViolations(events.map((e, i) => ({ event: e, lineNo: i + 1 })), { version: 3 });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('孤儿审计段');
  });

  it('官方 compaction 形状（compaction/summary 引用）不是本条：不误报', () => {
    const events = [
      ...base(),
      { type: 'compaction/start', seq: 3, time: 4, data: { compactionId: 'c1', turn: 0 } },
      { type: 'compaction/summary', seq: 4, time: 5, data: { compactionId: 'c1', shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], summary: [] } },
      carrier({ seq: 5, startSeq: 0, endSeq: 1, sourceEventSeqs: [3, 4, 0, 1] }),
    ];
    expect(carrierPairingViolations(events.map((e, i) => ({ event: e, lineNo: i + 1 })), { version: 3 })).toEqual([]);
  });

  it('写侧（严格）：早期写法（区间起点开头）与末位审计段都被拒；现役写法通过', () => {
    const prefix = [...base(), audit(3, 0, 1, [0, 1])];
    for (const src of [[0, 1], [0, 1, 3]]) {
      const bad = createPreWriter({ events: prefix, header: HEADER_V3 })
        .validateAppend(carrier({ startSeq: 0, endSeq: 1, sourceEventSeqs: src }));
      expect(bad.ok).toBe(false);
      expect(ids(bad.violations)).toContain('P5');
    }

    const good = createPreWriter({ events: prefix, header: HEADER_V3 })
      .validateAppend(carrier({ startSeq: 0, endSeq: 1, sourceEventSeqs: [3, 0, 1] }));
    expect(good.violations.filter((v) => v.id === 'P5')).toEqual([]);
    expect(good.ok).toBe(true);
  });

  it('纯函数：写侧校验覆盖"审计段 seq 出现在非首位"', () => {
    const events = [...base(), audit(3, 0, 2, [0, 1, 2]), carrier({ seq: 4, startSeq: 0, endSeq: 2, sourceEventSeqs: [0, 3, 1, 2] })];
    const v = carrierWriteViolations(events, { version: 3 });
    expect(v.map((x) => x.id)).toEqual(['P5']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1 · 在位可还原只认结构化归档指针（最小集 ⑤）
// ─────────────────────────────────────────────────────────────────────────────
describe('A1 · 在位可还原（只认 archiveRef / archive / externalized.*，⛔ 禁止文本 grep）', () => {
  function makeArchive(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-archive-'));
    const file = path.join(dir, 'ext-1.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return { dir, file };
  }
  const sha16 = (line) => crypto.createHash('sha256').update(JSON.stringify(line)).digest('hex').slice(0, 16);
  const archived = (n, payload) => ({ type: 'assistant/message', seq: n, time: n + 1, data: { payload } });

  it('正例：externalized.archiveRef + archiveLine + sha256（短指纹） ⇒ 在位可还原', () => {
    const line = archived(0, '原始内容');
    const { dir } = makeArchive([line]);
    const events = [{
      seq: 5, type: 'assistant/message', time: 6, lineNo: 2,
      data: { externalized: { archiveRef: 'ext-1.jsonl', archiveLine: 1, sha256: sha16(line), originalBytes: 10 } },
    }];
    const verdict = archiveVerdict(events, { archiveRoots: [dir] });
    expect(verdict.verdict).toBe('restorable');
    expect(verdict.pointers).toBe(1);
    expect(verdict.restorable).toBe(1);
    expect(verdict.violations).toEqual([]);
  });

  it('正例：顶层 data.archive 绝对路径 + 全量 sha256 ⇒ 在位可还原', () => {
    const line = archived(1, 'x');
    const { file } = makeArchive([line]);
    const full = crypto.createHash('sha256').update(JSON.stringify(line)).digest('hex');
    const events = [{ seq: 9, type: 'fix-line/carrier', data: { archive: file, archiveLine: 1, sha256: full } }];
    const verdict = archiveVerdict(events, { archiveRoots: [path.dirname(file)] });
    expect(verdict.restorable).toBe(1);
    expect(verdict.verdict).toBe('restorable');
  });

  it('反例：归档行缺失 / sha 不符 ⇒ A1 error（真实落空）', () => {
    const line = archived(0, 'a');
    const { dir } = makeArchive([line, archived(1, 'b')]);
    const noLine = archiveVerdict([{ seq: 5, type: 'assistant/message', data: { externalized: { archiveRef: 'ext-1.jsonl', archiveLine: 9 } } }], { archiveRoots: [dir] });
    expect(noLine.lineMissing).toBe(1);
    expect(noLine.verdict).toBe('unrestorable');
    expect(noLine.violations.map((v) => v.id)).toEqual(['A1']);

    const badSha = archiveVerdict([{ seq: 6, type: 'assistant/message', data: { externalized: { archiveRef: 'ext-1.jsonl', archiveLine: 1, sha256: 'deadbeefdeadbeef' } } }], { archiveRoots: [dir] });
    expect(badSha.shaMismatch).toBe(1);
    expect(badSha.violations[0].id).toBe('A1');
  });

  it('反例：指针目标完全无法解析（归档不存在）⇒ A1 error（unrestorable）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-empty-'));
    const verdict = archiveVerdict([{ seq: 1, type: 'assistant/message', data: { externalized: { archiveRef: 'nope.jsonl.zst', archiveLine: 3 } } }], { archiveRoots: [dir] });
    expect(verdict.unresolved).toBe(1);
    expect(verdict.verdict).toBe('unrestorable');
  });

  it('⛔ 自由文本里的路径**绝不算**指针（两版文本口径全错的反证）', () => {
    const { file } = makeArchive([archived(0, 'x')]);
    const freeText = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `归档在 ${file} archive 第 1 行` }, { type: 'reasoning', text: 'archiveRef: ext-1.jsonl' }] } } },
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'archive=/tmp/ext-1.jsonl.zst；示例 archive 第 6 行' }] } },
    ];
    expect(collectArchivePointers(freeText.map((event) => ({ event })))).toEqual([]);
    const verdict = archiveVerdict(freeText.map((event) => ({ event, lineNo: 1 })), { archiveRoots: [path.dirname(file)] });
    expect(verdict.pointers).toBe(0);
    expect(verdict.violations).toEqual([]);
    expect(verdict.verdict).toBe('restorable'); // 0 指针 ⇒ 无落空
  });

  it('独立维度：未提供归档根 ⇒ unverifiable（不冒充通过、不产生违规）', () => {
    const verdict = archiveVerdict([{ seq: 1, type: 'assistant/message', data: { externalized: { archiveRef: 'x.jsonl.zst', archiveLine: 1 } } }]);
    expect(verdict.verdict).toBe('unverifiable');
    expect(verdict.assessable).toBe(false);
    expect(verdict.violations).toEqual([]);
    // 默认 validateSessionLog 不因外部归档状态改变 ok（v3 零回归）
    const result = validateSessionLog(logOf(HEADER, [userMessage({ seq: 0 })]));
    expect(result.archive.verdict).toBe('unverifiable');
    expect(result.summary.byLayer.archive ?? 0).toBe(0);
  });

  it('relocated：绝对路径失效但同名归档在归档根可解析 ⇒ warning（不在位）', () => {
    const line = archived(0, 'y');
    const { dir, file } = makeArchive([line]);
    const gone = path.join(os.tmpdir(), `gone-${Date.now()}`, 'ext-1.jsonl');
    const events = [{ seq: 7, type: 'fix-line/carrier', data: { archive: gone, archiveLine: 1, sha256: sha16(line) } }];
    const verdict = archiveVerdict(events, { archiveRoots: [dir] });
    expect(verdict.relocated).toBe(1);
    expect(verdict.missing).toBe(0);
    expect(verdict.violations.map((v) => v.severity)).toEqual(['warning']);
    expect(verifyArchivePointers(collectArchivePointers(events.map((event) => ({ event }))), { archiveRoots: [dir] }).relocated).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('CLI：--archive-root 打开 A1 维度；缺失行 ⇒ 退出码 1 且列出 A1', () => {
    const { dir } = makeArchive([archived(0, 'z')]);
    const header = { ...HEADER, version: 3 };
    const lines = [
      JSON.stringify(header),
      JSON.stringify(userMessage({ seq: 0 })),
      JSON.stringify({ type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: { turn: 0, step: 1, externalized: { archiveRef: 'ext-1.jsonl', archiveLine: 42 }, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } } }),
    ];
    const file = writeRawSession(lines);
    const res = spawnSync(process.execPath, [CLI, 'check', file, '--json', '--archive-root', dir], { encoding: 'utf8' });
    const payload = JSON.parse(res.stdout);
    expect(payload.archive.verdict).toBe('unrestorable');
    expect(payload.violations.some((v) => v.id === 'A1')).toBe(true);
    expect(res.status).toBe(1);
  });

  it('真实会话语料（需 DSH_LOG_CONTRACT_ARCHIVE_ROOTS）：结构化指针读数与落空分类', { timeout: 180000 }, () => {
    if (ARCHIVE_ROOTS.length === 0 || !fs.existsSync(REAL_SESSIONS_DIR)) {
      console.warn('skip: 未提供归档根或真实会话目录（设置 DSH_LOG_CONTRACT_ARCHIVE_ROOTS / DSH_LOG_CONTRACT_REAL_SESSIONS_DIR）');
      return;
    }
    const files = bySizeAsc(sessionFiles(REAL_SESSIONS_DIR));
    let pointers = 0;
    let restorable = 0;
    let relocated = 0;
    let missing = 0;
    let violations = 0;
    let duplicated = 0;
    let scanned = 0;
    for (const file of files.slice(0, 30)) {
      if (pointers > 0 && scanned >= 2) break;
      const log = loadSessionLog(file);
      if (![3, 4].includes(log.header?.version)) continue;
      scanned++;
      const verdict = archiveVerdict(log.events, { archiveRoots: ARCHIVE_ROOTS });
      pointers += verdict.pointers;
      restorable += verdict.restorable;
      relocated += verdict.relocated;
      missing += verdict.missing + verdict.lineMissing + verdict.shaMismatch + verdict.unresolved;
      duplicated += verdict.duplicated ?? 0;
      violations += verdict.violations.filter((v) => v.severity === 'error').length;
    }
    if (pointers === 0) {
      console.warn('skip: 抽样文件不含结构化归档指针（可把 DSH_LOG_CONTRACT_REAL_SESSIONS_DIR 指到含外置内容的会话目录）');
      return;
    }
    console.info(`[real] A1：${scanned} 份真实会话，结构化指针 ${pointers}（可还原 ${restorable} ／ relocated ${relocated} ／ 真实落空 ${missing}）；error 违规 ${violations}`);
    expect(restorable + relocated + missing + duplicated).toBe(pointers);
  });
});
