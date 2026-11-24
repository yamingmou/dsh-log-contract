/**
 * test/archive-init.test.mjs —— R-2b②（初始化中）读端行为
 *
 * 钉住「读不到 ≠ 没有」：归档索引/读端**暂不可读（可能尚未就绪）**时，
 * 结论必须落到 `unverifiable`（可见的 notReady / unavailable），⛔ 不得推成"内容缺失"（unrestorable），
 * 也不得把空结果当成"没有归档"。同时保留原有内容级判定（缺行/不可读之外的失败仍判红）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveVerdict } from '../lib/archive.js';

const tmpArchive = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-init-'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), content);
  return dir;
};

const pointerEvent = (ref, line) => ({
  type: 'user/message',
  seq: 0,
  time: 1,
  data: { archiveRef: ref, archiveLine: line },
});

describe('R-2b② · 归档读端：初始化中不得按空值推"没有"', () => {
  it('反例：initialized=false ⇒ 显式 not-initialized 降级（unverifiable，不冒充、不报缺失）', () => {
    const r = archiveVerdict([pointerEvent('a.jsonl', 1)], { archiveRoots: [path.join(os.tmpdir(), 'definitely-not-there')], initialized: false });
    expect(r.verdict).toBe('unverifiable');
    expect(r.notInitialized).toBe(true);
    expect(r.reason).toBe('not-initialized');
    expect(r.notReady).toBe(true);
    expect(r.missing).toBe(0);
    expect(r.violations).toEqual([]);
  });

  it('反例：读端暂不可读（索引未就绪）⇒ unverifiable + notReady，不判内容缺失', () => {
    const dir = tmpArchive('one\ntwo\n');
    const r = archiveVerdict([pointerEvent('a.jsonl', 1)], {
      archiveRoots: [dir],
      readLines: () => { throw new Error('EAGAIN: resource not ready'); },
    });
    expect(r.verdict).toBe('unverifiable');
    expect(r.notReady).toBe(true);
    expect(r.unavailable).toBeGreaterThan(0);
    expect(r.missing).toBe(0);      // ⛔ "读不到"不得计入内容缺失
    expect(r.lineMissing).toBe(0);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.every((v) => v.severity === 'warning')).toBe(true);
    expect(r.violations[0].message).toContain('暂不可读');
  });

  it('正例：就绪且内容齐 ⇒ restorable（原有语义不变）', () => {
    const dir = tmpArchive('hello\nworld\n');
    const r = archiveVerdict([pointerEvent('a.jsonl', 2)], { archiveRoots: [dir] });
    expect(r.verdict).toBe('restorable');
    expect(r.restorable).toBe(1);
    expect(r.unavailable).toBe(0);
    expect(r.notReady).toBe(false);
  });

  it('正例（反面对照）：内容级失败（行缺失）仍判 unrestorable，不被"未就绪"吞掉', () => {
    const dir = tmpArchive('only-one-line\n');
    const r = archiveVerdict([pointerEvent('a.jsonl', 9)], { archiveRoots: [dir] });
    expect(r.verdict).toBe('unrestorable');
    expect(r.lineMissing).toBe(1);
  });
});
