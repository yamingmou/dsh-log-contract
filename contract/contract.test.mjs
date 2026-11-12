/**
 * contract/contract.test.mjs —— Phase1 骨架单测（正例 + 负对照）
 *
 * 判据来源：/tmp/contract-D-exec.md §5（A1–A6）。
 * ⛔ 夹具为合成模型，不依赖真实会话日志（Phase1 只测 contract 层语义）。
 */

import { describe, it, expect } from 'vitest';
import {
  evaluate,
  shadowCompare,
  verdictOf,
  planOf,
  coverageOf,
  runInvariants,
} from './index.mjs';
import { CONTRACT_RULES } from '../lib/contracts.js';

const cleanModel = () => ({
  header: { type: 'session', version: 4, id: 's1', createdAt: 1 },
  events: [
    { seq: 1, type: 'a' },
    { seq: 2, type: 'b' },
  ],
  frames: { count: 2, torn: false, firstFrameHeaderOnly: true },
});

describe('A1 覆盖：57 条规则全部有归处', () => {
  it('真值目录 → unknown=0 / mapped+pending=total', () => {
    const cov = coverageOf();
    expect(cov.total).toBe(CONTRACT_RULES.length);
    expect(cov.ok).toBe(true);
    expect(cov.unknown).toEqual([]);
    expect(cov.mapped.length).toBe(Object.keys(
      // 与 rules.mjs 的 INVARIANT_OF 保持一致：7 条已映射
      { H1: 1, H2: 1, E1: 1, E2: 1, Z1: 1, Z4: 1, Z5: 1 },
    ).length);
    expect(cov.mapped.length + cov.pending.length).toBe(cov.total);
  });

  it('负对照：注入目录外规则 id QQ9 ⇒ 覆盖红', () => {
    const cov = coverageOf([...CONTRACT_RULES, { id: 'QQ9', layer: 'fake' }]);
    expect(cov.ok).toBe(false);
    expect(cov.unknown).toEqual(['QQ9']);
  });

  it('负对照：缺失规则（stale）⇒ 覆盖红', () => {
    const cov = coverageOf(CONTRACT_RULES.filter((r) => r.id !== 'H1'));
    expect(cov.ok).toBe(false);
    expect(cov.stale).toContain('H1');
  });
});

describe('A2 判定同义：ok ⇔ error==0', () => {
  it('正例：干净模型 → ok / 无 error', () => {
    const { verdict, findings } = evaluate(cleanModel());
    expect(findings).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.counts.error).toBe(0);
  });

  it('负对照：1 条 error ⇒ red', () => {
    const v = verdictOf([{ severity: 'error', ruleId: 'X' }]);
    expect(v.ok).toBe(false);
    expect(v.red).toBe(true);
    expect(v.counts.error).toBe(1);
  });
});

describe('A3 fail-closed：未知 severity 按 error 计', () => {
  it('负对照：severity=fatal ⇒ red', () => {
    const v = verdictOf([{ severity: 'fatal', ruleId: 'X' }]);
    expect(v.counts.error).toBe(1);
    expect(v.red).toBe(true);
  });
});

describe('A4 只读不写：read 模式零 writePath', () => {
  it('read 计划全部 writePath=false 且 writesAllowed=false', () => {
    const { verdict, planRead } = evaluate({
      ...cleanModel(),
      events: [{ seq: 1, type: 'a' }, { seq: 9, type: 'b' }], // 制造 E2
    });
    expect(verdict.ok).toBe(false);
    expect(planRead.actions.length).toBeGreaterThan(0);
    for (const a of planRead.actions) expect(a.writePath).toBe(false);
    expect(planRead.writesAllowed).toBe(false);
  });

  it('write 模式（Phase1 空可修集）仍不写', () => {
    const { verdict } = evaluate({ ...cleanModel(), header: { type: 'session', version: 99, id: 's', createdAt: 1 } });
    const p = planOf(verdict, { mode: 'write' });
    expect(p.writesAllowed).toBe(false);
    for (const a of p.actions) expect(a.writePath).toBe(false);
  });

  it('未知 mode ⇒ 抛错（不允许第三个状态）', () => {
    expect(() => planOf(verdictOf([]), { mode: 'auto' })).toThrow(/只允许 read\/write/);
  });
});

describe('A6 各不变量都能红（负对照逐条）', () => {
  const cases = [
    ['INV-HDR', { ...cleanModel(), header: { type: 'x', version: 99, id: '', createdAt: -1 } }, 'H1'],
    ['INV-SEQ', { ...cleanModel(), events: [{ seq: 1, type: 'a' }, { seq: 5, type: 'b' }] }, 'E2'],
    ['INV-FRAME', { ...cleanModel(), frames: { count: 0, torn: true, firstFrameHeaderOnly: false } }, 'Z1'],
  ];

  for (const [invId, model, ruleId] of cases) {
    it(`${invId} 能产出 ${ruleId} 级 finding`, () => {
      const findings = runInvariants(model);
      expect(findings.some((f) => f.invariantId === invId && f.ruleId === ruleId)).toBe(true);
    });
  }

  it('INV-RULES-MAPPED：覆盖失败时产 red', () => {
    const findings = runInvariants(cleanModel(), { rules: [...CONTRACT_RULES, { id: 'QQ9' }] });
    expect(findings.some((f) => f.invariantId === 'INV-RULES-MAPPED')).toBe(true);
  });

  it('INV-SEQ 单条 seq 非整数 ⇒ E1', () => {
    const findings = runInvariants({ ...cleanModel(), events: [{ seq: '1', type: 'a' }] });
    expect(findings.some((f) => f.invariantId === 'INV-SEQ' && f.ruleId === 'E1')).toBe(true);
  });
});

describe('A5 影子对比：不一致必可见', () => {
  const okVerdict = () => verdictOf([]);

  it('正例：双绿 ⇒ match', () => {
    const r = shadowCompare(okVerdict(), { ok: true, violations: [] });
    expect(r.match).toBe(true);
    expect(r.diffs).toEqual([]);
  });

  it('负对照：contract 绿 / legacy 红 ⇒ match=false 且有 ok-mismatch', () => {
    const r = shadowCompare(okVerdict(), { ok: false, violations: [{ ruleId: 'H1' }] });
    expect(r.match).toBe(false);
    expect(r.diffs.some((d) => d.kind === 'ok-mismatch')).toBe(true);
  });

  it('scope=covered 时未覆盖规则不计 diff；scope=all 时计入', () => {
    const legacy = { ok: true, violations: [{ ruleId: 'E3' }] }; // E3 不在 Phase1 覆盖表
    expect(shadowCompare(okVerdict(), legacy, { scope: 'covered' }).match).toBe(true);
    const all = shadowCompare(okVerdict(), legacy, { scope: 'all' });
    expect(all.match).toBe(false);
    expect(all.diffs.some((d) => d.kind === 'rule-only-legacy' && d.ruleId === 'E3')).toBe(true);
  });

  it('contract 有 legacy 无的 error ruleId ⇒ rule-only-contract', () => {
    const v = verdictOf([{ severity: 'error', ruleId: 'Z1' }]);
    const r = shadowCompare(v, { ok: false, violations: [{ ruleId: 'Z1' }] });
    // ok 同红、ruleId 同集合 ⇒ match
    expect(r.match).toBe(true);
    const r2 = shadowCompare(verdictOf([{ severity: 'error', ruleId: 'Z4' }]), { ok: false, violations: [{ ruleId: 'Z1' }] });
    expect(r2.diffs.some((d) => d.kind === 'rule-only-contract' && d.ruleId === 'Z4')).toBe(true);
  });
});
