/**
 * test/run-contract.test.mjs —— 运行时契约 R-3 / R-1 / R-2a
 *
 * 每条规则都给**正例（必须绿）**与**反例（必须红）**，并钉住报告面：
 * `check --json` 的 `schemaVersion` 递增与 `runContract` 段（只增字段，既有键不破坏）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUN_CONTRACT_RULES,
  RUN_CONTRACT_RULE_BY_ID,
  RUN_CONTRACT_FAMILY,
  assertFailClosed,
  assertFailureLatched,
  assertWriteOutcome,
  checkRunContract,
  isMissingInput,
  reasonMentions,
} from '../lib/run-contract.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');

describe('规则目录', () => {
  it('三条规则齐全，id/family/layer/severity 稳定', () => {
    expect(RUN_CONTRACT_RULES.map((r) => r.id)).toEqual(['R-3', 'R-1', 'R-2a']);
    for (const r of RUN_CONTRACT_RULES) {
      expect(r.family).toBe(RUN_CONTRACT_FAMILY);
      expect(r.severity).toBe('error');
      expect(r.layer).toBe('run');
      expect(typeof r.title).toBe('string');
      expect(r.description.length).toBeGreaterThan(20);
    }
    expect(RUN_CONTRACT_RULE_BY_ID['R-3'].title).toContain('缺失');
  });
});

describe('R-3 · 输入缺失 ⇒ 判不兼容（fail-closed）', () => {
  it('正例：输入齐全 ⇒ 绿', () => {
    const r = assertFailClosed({ required: ['a', 'b'], provided: { a: 1, b: 2 }, result: { compatible: true, reasons: [] } });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it('正例：缺 fileB ⇒ 拒绝且原因点名 ⇒ 绿', () => {
    const r = assertFailClosed({ required: ['a', 'fileB'], provided: { a: 1 }, result: { compatible: false, reasons: ['fileB missing'] } });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(['fileB']);
  });

  it('反例：缺输入却判兼容（fail-open）⇒ R-3 红', () => {
    const r = assertFailClosed({ required: ['a', 'fileB'], provided: { a: 1 }, result: { compatible: true } });
    expect(r.ok).toBe(false);
    expect(r.findings[0].id).toBe('R-3');
    expect(r.findings[0].input).toBe('fileB');
    expect(r.findings[0].message).toContain('缺失必须判不兼容');
  });

  it('反例：拒绝但原因不可见（未点名缺项）⇒ R-3 红', () => {
    const r = assertFailClosed({ required: ['fileB'], provided: {}, result: { compatible: false, reasons: ['bad input'] } });
    expect(r.ok).toBe(false);
    expect(r.findings[0].message).toContain('原因不可见');
  });

  it('缺失口径：缺键/undefined/null/空白串/NaN 都算缺失', () => {
    for (const v of [undefined, null, '', '   ', Number.NaN]) expect(isMissingInput(v)).toBe(true);
    for (const v of [0, false, [], 'x']) expect(isMissingInput(v)).toBe(false);
    const r = assertFailClosed({ required: ['x'], provided: { x: '' }, result: { compatible: true } });
    expect(r.ok).toBe(false);
  });

  it('反例（子串假通过）：required=[file] + reasons=[profile missing] ⇒ R-3 红（完整 token 匹配）', () => {
    const r = assertFailClosed({ required: ['file'], provided: {}, result: { compatible: false, reasons: ['profile missing'] } });
    expect(r.ok).toBe(false);
    expect(r.findings[0].message).toContain('完整 token');
    // 词边界正例：'file missing' 才算点名
    expect(reasonMentions('file missing', 'file')).toBe(true);
    expect(reasonMentions('profile missing', 'file')).toBe(false);
    expect(reasonMentions('fileB missing', 'fileB')).toBe(true);
  });
});

describe('R-1 · 失败置位，恢复不清零', () => {
  it('正例：从未失败 ⇒ 绿（latchedAt=null）', () => {
    const r = assertFailureLatched([{ phase: 'run', failed: false }, { phase: 'run', failed: false }]);
    expect(r.ok).toBe(true);
    expect(r.latchedAt).toBe(null);
  });

  it('正例：失败后恢复/重载仍为 true ⇒ 绿（置位保持）', () => {
    const r = assertFailureLatched([
      { phase: 'run', failed: false },
      { phase: 'run', failed: true },
      { phase: 'recover', failed: true },
      { phase: 'reload', failed: true },
      { phase: 'cache-clear', failed: true },
    ]);
    expect(r.ok).toBe(true);
    expect(r.latchedAt).toEqual({ index: 1, phase: 'run' });
  });

  it('反例：恢复路径把置位清零 ⇒ R-1 红（带 index/phase）', () => {
    const r = assertFailureLatched([{ phase: 'run', failed: true }, { phase: 'reload', failed: false }]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].id).toBe('R-1');
    expect(r.findings[0].index).toBe(1);
    expect(r.findings[0].phase).toBe('reload');
    expect(r.findings[0].message).toContain('不得清零');
  });

  it('边界：置位后 failed 缺省（未声明）不算清零 ⇒ 绿', () => {
    const r = assertFailureLatched([{ phase: 'run', failed: true }, { phase: 'recover' }]);
    expect(r.ok).toBe(true);
  });

  it('反例：多次清零 ⇒ 逐条红', () => {
    const r = assertFailureLatched([
      { phase: 'run', failed: true },
      { phase: 'reload', failed: false },
      { phase: 'run', failed: true },
      { phase: 'cache-clear', failed: false },
    ]);
    expect(r.ok).toBe(false);
    expect(r.findings.length).toBe(2);
  });
});

describe('R-2a · 写失败不得标完整', () => {
  it('正例：写成功 ⇒ 可标完整', () => {
    const r = assertWriteOutcome({ write: { ok: true }, artifact: { complete: true } });
    expect(r.ok).toBe(true);
  });

  it('正例：写失败 ⇒ 标 partial/unavailable ⇒ 绿', () => {
    for (const status of ['partial', 'unavailable', 'withdrawn']) {
      const r = assertWriteOutcome({ write: { ok: false, error: 'EIO' }, artifact: { complete: false, status } });
      expect(r.ok, status).toBe(true);
    }
  });

  it('反例：写失败却标完整 ⇒ R-2a 红', () => {
    const r = assertWriteOutcome({ write: { ok: false, error: 'EIO' }, artifact: { complete: true } });
    expect(r.ok).toBe(false);
    expect(r.findings[0].id).toBe('R-2a');
    expect(r.findings[0].message).toContain('标记为完整');
  });

  it('反例：写入结果未知（ok 缺省）+ status=complete ⇒ R-2a 红', () => {
    const r = assertWriteOutcome({ write: {}, artifact: { status: 'complete' } });
    expect(r.ok).toBe(false);
    expect(r.findings[0].id).toBe('R-2a');
  });

  it('正例：写成功但产物未标完整 ⇒ 绿（不要求必须完整）', () => {
    const r = assertWriteOutcome({ write: { ok: true }, artifact: { complete: false, status: 'partial' } });
    expect(r.ok).toBe(true);
  });
});

describe('checkRunContract · 汇总与"未提供≠通过"', () => {
  it('空输入 ⇒ 一条断言都没跑 ⇒ ok=null（unverifiable，不冒充通过）', () => {
    const rep = checkRunContract({});
    expect(rep.ok).not.toBe(true);
    expect(rep.ok).toBeNull();
    expect(rep.checks).toEqual([]);
    expect(rep.skipped).toEqual(['R-1', 'R-2a', 'R-3']);
  });

  it('只提供部分输入 ⇒ skipped 列出未跑断言，ok 只由已跑项决定', () => {
    const rep = checkRunContract({ history: [{ phase: 'run', failed: false }] });
    expect(rep.family).toBe(RUN_CONTRACT_FAMILY);
    expect(rep.checks.map((c) => c.id)).toEqual(['R-1']);
    expect(rep.skipped).toEqual(['R-2a', 'R-3']);
    expect(rep.ok).toBe(true);
  });

  it('任一断言红 ⇒ 汇总红 + findings 带规则号', () => {
    const rep = checkRunContract({
      history: [{ phase: 'run', failed: true }, { phase: 'reload', failed: false }],
      write: { ok: false },
      artifact: { complete: true },
      required: ['x'],
      provided: {},
      result: { compatible: true },
    });
    expect(rep.ok).toBe(false);
    expect(rep.findings.map((f) => f.id).sort()).toEqual(['R-1', 'R-2a', 'R-3']);
  });
});

describe('集成：check --json 的 runContract 段', () => {
  it('schemaVersion=4，runContract 段含三条规则，既有键不破坏', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-run-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1 }) + '\n');
    const res = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(res.stdout);
    expect(payload.schemaVersion).toBe('4');
    for (const k of ['ok', 'assessable', 'assessmentScope', 'host', 'support', 'migration', 'summary', 'violations', 'identity', 'errorContract']) {
      expect(Object.hasOwn(payload, k), `既有键 ${k} 丢了`).toBe(true);
    }
    expect(payload.runContract.family).toBe('run-contract');
    expect(payload.runContract.rules.map((r) => r.id)).toEqual(['R-3', 'R-1', 'R-2a']);
    expect(payload.runContract.note).toContain('RUN-CONTRACT');
  });
});
