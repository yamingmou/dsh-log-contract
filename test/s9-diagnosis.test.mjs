/**
 * dsh-log-contract · test/s9-diagnosis.test.mjs
 *
 * S9 诊断增强（0.3.37）：**判定不变**（物理行序非单调 = error，仍只报首个倒退），
 * 但输出分类诊断 + 置信度 + 判定式 + 提示：
 *   - old-cursor-replay：回卷到旧区间/旧坐标，之后继续单调整上升；
 *   - concurrent-writer：同一 seq 重复且内容不同，或 ≥2 次回卷 + ≥2 次回升（交错）；
 *   - format-mix：同一物理流混有 legacy（v0–v2）与 modern（v3+）形态，尤其与声明版本矛盾。
 *
 * 每类都给正例 + 反例；另锁「判定不变」（S9 error/只报一条/原 message 仍在）与
 * `check --json` 的 schemaVersion=3（v2 引入 S9 诊断；v3 加 identity 段）+ 新字段。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { physicalOrderViolations, S9_CATEGORIES } from '../lib/checks.js';
import { validateSessionLog } from '../lib/validate.js';

const BIN = fileURLToPath(new URL('../bin/dsh-log-contract.mjs', import.meta.url));

const plain = (seq, extra = {}) => ({ type: 'todo/write', seq, time: seq + 1, data: { n: seq }, ...extra });

/** 物理行序夹具：每个事件一行（decoded 单事件）。 */
const rowsOf = (events) => events.map((event, i) => ({ lineNo: i + 1, value: event, decoded: [event], error: null }));

/** `{event,lineNo}` 包装（physicalOrderViolations 的另一种入口形状）。 */
const diagnose = (events, opts = {}) => physicalOrderViolations(rowsOf(events), opts);

const HEADER_V0 = { type: 'session', version: 0, id: 's9-fixture', createdAt: 1 };

/** 手搓 loadSessionLog 形状：rows 保留物理序，events 按 seq 排序（与真实读取一致）。 */
function logOf(header, physicalEvents) {
  const sorted = [...physicalEvents].sort((a, b) => a.seq - b.seq);
  return {
    header,
    headerLine: 0,
    rows: rowsOf(physicalEvents),
    events: sorted.map((event, i) => ({ seq: event.seq, event, lineNo: i + 1 })),
    frameInfo: { frames: 2, torn: false, compressedBytes: 0, plaintextBytes: 0, firstFrameOneLine: true, firstFrameLines: 1 },
  };
}

describe('S9 判定不变（原行为回归）', () => {
  it('物理序单调 ⇒ 0 违规（正例）', () => {
    expect(diagnose([plain(0), plain(1), plain(2)])).toEqual([]);
  });

  it('物理序倒退 ⇒ 仍为 S9 error、仍只报 1 条、原 message 仍在（反例）', () => {
    const v = diagnose([plain(0), plain(1), plain(2), plain(3), plain(1), plain(4)]);
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('S9');
    expect(v[0].severity).toBe('error');
    expect(v[0].message).toContain('文件物理序 seq 倒退');
    expect(v[0].seq).toBe(1); // 首个倒退事件的 seq
  });

  it('多次倒退也只报 1 条（不因诊断改成逐条报）', () => {
    const v = diagnose([plain(0), plain(10), plain(1), plain(11), plain(2), plain(12)]);
    expect(v).toHaveLength(1);
  });
});

describe('old-cursor-replay（回卷到旧区间，正/反例）', () => {
  it('正例：回卷到旧坐标后连续 +1（旧块回放）⇒ old-cursor-replay，置信度 0.85', () => {
    const v = diagnose([plain(0), plain(1), plain(2), plain(6), plain(7), plain(3), plain(4), plain(5), plain(8)]);
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
    expect(v[0].confidence).toBe(0.85);
    expect(v[0].basis).toContain('backwardSteps=1');
    expect(v[0].basis).toContain('contiguousRun=2');
    expect(v[0].hint).toContain('loaded=no');
    expect(v[0].diagnosis.category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
  });

  it('正例（无连续回放）：单次回卷后直接跳走 ⇒ old-cursor-replay，置信度 0.6', () => {
    const v = diagnose([plain(0), plain(1), plain(2), plain(5), plain(6), plain(3), plain(7)]);
    expect(v[0].category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
    expect(v[0].confidence).toBe(0.6);
  });

  it('反例：交错流（≥2 回卷 + ≥2 回升）不得判成 old-cursor-replay', () => {
    const v = diagnose([plain(0), plain(10), plain(1), plain(11), plain(2), plain(12)]);
    expect(v[0].category).not.toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
  });
});

describe('concurrent-writer（重复/交错，正/反例）', () => {
  it('正例：同一 seq 重复且内容不同 ⇒ concurrent-writer，置信度 0.9', () => {
    const v = diagnose([
      plain(0), plain(1), plain(2), plain(3),
      { type: 'user/message', seq: 2, time: 99, data: { other: true } }, // 同 seq、不同内容
      plain(5),
    ]);
    expect(v[0].category).toBe(S9_CATEGORIES.CONCURRENT_WRITER);
    expect(v[0].confidence).toBe(0.9);
    expect(v[0].basis).toContain('contentDuplicates=1');
  });

  it('正例：两条单调流交错（1 回卷/1 回升 ×2）⇒ concurrent-writer，置信度 0.8', () => {
    const v = diagnose([plain(0), plain(10), plain(1), plain(11), plain(2), plain(12)]);
    expect(v[0].category).toBe(S9_CATEGORIES.CONCURRENT_WRITER);
    expect(v[0].confidence).toBe(0.8);
    expect(v[0].basis).toContain('directionReversals=2');
  });

  it('反例：同 seq 重复但内容相同（旧块原样回放）⇒ 不判 concurrent-writer', () => {
    const same = plain(2);
    const v = diagnose([plain(0), plain(1), plain(2), plain(3), { ...same }, plain(5)]);
    expect(v).toHaveLength(1);
    expect(v[0].category).not.toBe(S9_CATEGORIES.CONCURRENT_WRITER);
    expect(v[0].category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
  });

  it('反例：只有 1 次回卷/1 次回升 ⇒ 不判 concurrent-writer', () => {
    const v = diagnose([plain(0), plain(1), plain(2), plain(5), plain(6), plain(3), plain(4), plain(5), plain(8)]);
    expect(v[0].category).not.toBe(S9_CATEGORIES.CONCURRENT_WRITER);
  });
});

describe('format-mix（跨版本重放，正/反例）', () => {
  const modernReplace = (seq, text = 'x') => ({
    type: 'user/message', seq, time: seq + 1,
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    data: { id: `r-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
  const legacyChunk = (seq) => ({ type: 'assistant/chunk', seq, time: seq + 1, data: { turn: 0, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } });

  it('正例：header v3 但物理流混入 legacy assistant/chunk ⇒ format-mix，置信度 0.85', () => {
    const v = diagnose([plain(0), modernReplace(3), legacyChunk(2), plain(4)], { version: 3 });
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe(S9_CATEGORIES.FORMAT_MIX);
    expect(v[0].confidence).toBe(0.85);
    expect(v[0].basis).toContain('declaredVersion=3');
    expect(v[0].basis).toContain('legacy');
    expect(v[0].message).toContain('跨版本重放');
  });

  it('正例（回卷点跨代）：同一 v3 文件里 legacy 与 modern 形态并存且回卷点跨代 ⇒ format-mix', () => {
    const v = diagnose([modernReplace(0), modernReplace(1), modernReplace(2), modernReplace(10), legacyChunk(3)], { version: 3 });
    expect(v[0].category).toBe(S9_CATEGORIES.FORMAT_MIX);
  });

  it('反例：header v3、只有 modern 形态 + 普通回卷 ⇒ old-cursor-replay（不误判 format-mix）', () => {
    const v = diagnose([modernReplace(0), modernReplace(1), modernReplace(6), modernReplace(2), modernReplace(3)], { version: 3 });
    expect(v[0].category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
  });

  it('反例：legacy 文件（v2）里只有 legacy 形态 + 回卷 ⇒ 不判 format-mix', () => {
    const v = diagnose([legacyChunk(0), legacyChunk(1), legacyChunk(5), legacyChunk(2), legacyChunk(3)], { version: 2 });
    expect(v[0].category).not.toBe(S9_CATEGORIES.FORMAT_MIX);
  });
});

describe('集成：validateSessionLog / check --json', () => {
  it('validateSessionLog：S9 带诊断字段，schemaVersion 已达 v3，判定仍 error', () => {
    const result = validateSessionLog(logOf(HEADER_V0, [plain(0), plain(2), plain(1)]));
    const s9 = result.violations.filter((v) => v.id === 'S9');
    expect(s9).toHaveLength(1);
    expect(s9[0].severity).toBe('error');
    expect(s9[0].category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
    expect(typeof s9[0].confidence).toBe('number');
    expect(s9[0].hint).toContain('loaded=no');
    expect(result.schemaVersion).toBe('6');
    const round = JSON.parse(JSON.stringify(result.violations));
    expect(round.find((v) => v.id === 'S9').category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
  });

  it('check --json：schemaVersion=3 + S9 的 category/confidence/hint/basis 可机读', () => {
    const dir = mkdtempSync(join(tmpdir(), 's9-cli-'));
    const file = join(dir, 'session.jsonl');
    const lines = [JSON.stringify(HEADER_V0), JSON.stringify(plain(0)), JSON.stringify(plain(2)), JSON.stringify(plain(1))];
    writeFileSync(file, lines.join('\n') + '\n');
    const r = spawnSync(process.execPath, [BIN, 'check', file, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(r.stdout);
    expect(payload.schemaVersion).toBe('6');
    const s9 = payload.violations.find((v) => v.id === 'S9');
    expect(s9.category).toBe(S9_CATEGORIES.OLD_CURSOR_REPLAY);
    expect(s9.confidence).toBeGreaterThan(0);
    expect(s9.hint).toContain('loaded=no');
    expect(s9.basis).toContain('backwardSteps=1');
    expect(r.status).toBe(1); // 判定不变：有 error ⇒ 非 0
  });

  it('check 文本：打印分类/置信度/判定式与"loaded=no 重载"提示', () => {
    const dir = mkdtempSync(join(tmpdir(), 's9-cli-txt-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, [JSON.stringify(HEADER_V0), JSON.stringify(plain(0)), JSON.stringify(plain(2)), JSON.stringify(plain(1))].join('\n') + '\n');
    const r = spawnSync(process.execPath, [BIN, 'check', file], { encoding: 'utf8' });
    expect(r.stdout).toContain('诊断：old-cursor-replay');
    expect(r.stdout).toContain('置信度');
    expect(r.stdout).toContain('loaded=no');
    expect(r.status).toBe(1);
  });
});
