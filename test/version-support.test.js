/**
 * dsh-log-contract · test/version-support.test.js
 *
 * **版本支持面**（2026-09-14 用户要求第 1 条）：把"哪些宿主/会话格式被验证过"变成可执行断言。
 * 覆盖:测试基线常量、语义版本比较、宿主比基线新 ⇒ 告警、未验证格式 ⇒ 只读、
 * 无法识别格式 ⇒ 只读、已知旧格式 ⇒ 可评估（非只读）。
 */
import { describe, expect, it } from 'vitest';
import { TESTED_BASELINE, compareVersions, detectSupport } from '../lib/version-support.js';
import { validateSessionLog } from '../lib/validate.js';
import { loadSessionLog } from '../lib/log-reader.js';
import { HEADER, validSessionEvents, writeSession } from './helpers.js';

describe('版本支持面:测试基线是常量,不是散落的注释', () => {
  it('基线声明了宿主包/版本、peer 范围、会话格式基线与已知格式集合', () => {
    expect(TESTED_BASELINE.hostPackage).toBe('@deepseek-ai/dsh-session');
    expect(TESTED_BASELINE.hostVersion).toBe('0.1.5-rc.1');
    expect(TESTED_BASELINE.peerRange).toContain('0.1.0-rc.7');
    expect(TESTED_BASELINE.peerRange).toContain('0.1.5-rc.1');
    expect(TESTED_BASELINE.sessionFormatVersion).toBe(3);
    expect([...TESTED_BASELINE.knownFormatVersions]).toEqual([0, 1, 2, 3]);
  });

  it('语义版本比较:预发布 < 正式版;rc 序号可比;不可解析 → null', () => {
    expect(compareVersions('0.1.5-rc.1', '0.1.5-rc.1')).toBe(0);
    expect(compareVersions('0.1.5', '0.1.5-rc.1')).toBe(1);
    expect(compareVersions('0.1.5-rc.1', '0.1.5')).toBe(-1);
    expect(compareVersions('0.1.5-rc.2', '0.1.5-rc.1')).toBe(1);
    expect(compareVersions('0.1.10-rc.1', '0.1.9')).toBe(1);
    expect(compareVersions('unknown (x)', '0.1.5-rc.1')).toBe(null);
  });
});

describe('宿主版本检测:比基线新 ⇒ 明确告警(不是闷着按旧规则判)', () => {
  it('与基线同版 → baseline、无告警', () => {
    const s = detectSupport({ header: { version: 3 }, events: [], hostVersion: TESTED_BASELINE.hostVersion });
    expect(s.host.status).toBe('baseline');
    expect(s.host.tested).toBe(true);
    expect(s.warnings).toEqual([]);
    expect(s.readOnly).toBe(false);
  });

  it('宿主比基线新 → newer-than-baseline + 告警文案点名版本与基线', () => {
    const s = detectSupport({ header: { version: 3 }, events: [], hostVersion: '0.1.6-rc.1' });
    expect(s.host.status).toBe('newer-than-baseline');
    expect(s.host.newerThanBaseline).toBe(true);
    expect(s.warnings.join('\n')).toContain('0.1.6-rc.1');
    expect(s.warnings.join('\n')).toContain(TESTED_BASELINE.hostVersion);
    expect(s.warnings.join('\n')).toContain('未在该宿主上验证');
  });

  it('宿主比基线旧(仍在 peer 内) → older-than-baseline + 提示 v3 需要宿主能力', () => {
    const s = detectSupport({ header: { version: 3 }, events: [], hostVersion: '0.1.0-rc.7' });
    expect(s.host.status).toBe('older-than-baseline');
    expect(s.warnings.join('\n')).toContain('peer');
  });
});

describe('被检文件格式检测:未验证 ⇒ 只读', () => {
  it('v3(基线) → baseline、可写', () => {
    const s = detectSupport({ header: { version: 3 }, events: [] });
    expect(s.file).toMatchObject({ version: 3, source: 'header', status: 'baseline', known: true });
    expect(s.readOnly).toBe(false);
  });

  it('v0/v2(旧格式,本包自带词表与本地折叠支持) → legacy、可写', () => {
    expect(detectSupport({ header: { version: 0 }, events: [] }).file.status).toBe('legacy');
    const v2 = detectSupport({ header: { version: 2 }, events: [] });
    expect(v2.file.status).toBe('legacy');
    expect(v2.readOnly).toBe(false);
  });

  it('未知版本(v7)→ unverified + 只读 + 告警点名已知集合', () => {
    const s = detectSupport({ header: { version: 7 }, events: [] });
    expect(s.file.status).toBe('unverified');
    expect(s.file.known).toBe(false);
    expect(s.readOnly).toBe(true);
    expect(s.warnings.join('\n')).toContain('不在已知集合');
    expect(s.summary).toContain('只读');
  });

  it('无法识别格式(无 header.version 且事件无判别特征)→ 只读 + 明说"无法识别"', () => {
    const s = detectSupport({ header: null, events: [{ type: 'user/message', seq: 0 }] });
    expect(s.file.source).toBe('default');
    expect(s.readOnly).toBe(true);
    expect(s.warnings.join('\n')).toContain('无法识别');
  });

  it('无 header.version 但有判别形状 → 推断来源(inferred),不算未验证', () => {
    const s = detectSupport({ header: null, events: [{ type: 'system/message' }] });
    expect(s.file).toMatchObject({ version: 3, source: 'inferred' });
    expect(s.readOnly).toBe(false);
  });
});

describe('版本支持面接到 validateSessionLog(端到端)', () => {
  it('合法 v0 会话 → support.file.status=legacy、无 warnings、非只读', () => {
    const file = writeSession(validSessionEvents(), { header: HEADER });
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.support).toBeTruthy();
    expect(result.support.file.status).toBe('legacy');
    expect(result.support.host.status).toBe('baseline');   // 本机宿主 = 基线
    expect(result.support.readOnly).toBe(false);
    expect(result.support.summary).toContain('宿主 @deepseek-ai/dsh-session@');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R-D/R-F（2026-09-14 独立复核裁定）:行为探针 + 出处/前提漂移的机读标注
// ─────────────────────────────────────────────────────────────────────────────
import { runHostProbes, PROBES } from '../lib/host-probes.js';
import { SOURCE_DRIFT, CONTRACT_RULES, ruleById } from '../lib/contracts.js';
import { driftOf } from '../lib/validate.js';

describe('R-D · 行为探针（宿主运行时自身当 oracle）', () => {
  it('探针集非空且覆盖 6 组关键语义（S4/S6/E6/E9/S2/E8/E10 被背书）', () => {
    const r = runHostProbes();
    expect(r.probes.length).toBeGreaterThanOrEqual(6);
    expect(r.hostPackage).toBeTruthy();
    const covered = new Set(r.probes.flatMap((p) => p.rules));
    for (const id of ['S4', 'S6', 'E6', 'E9', 'S2', 'E8', 'E10']) expect(covered.has(id)).toBe(true);
  });

  it('闭环:探针不一致 ⇒ 其背书的规则**必须**出现在 unverifiedRules（反之不出现）', () => {
    const r = runHostProbes();
    const expected = [...new Set(r.probes.filter((p) => !p.ok).flatMap((p) => p.rules))].sort();
    expect(r.unverifiedRules).toEqual(expected);
    expect(r.verified).toBe(expected.length === 0);
  });

  it('元测试：探针**真能抓漂移** —— 把期望反过来 ⇒ 对应规则被标 UNVERIFIED（不是永远绿）', () => {
    const drifted = runHostProbes([{ ...PROBES[0], id: 'meta-drift', rules: ['S4'], run: () => false }]);
    expect(drifted.verified).toBe(false);
    expect(drifted.unverifiedRules).toContain('S4');
    // 对照:期望正确 ⇒ 不标
    const healthy = runHostProbes([{ ...PROBES[0], id: 'meta-ok', rules: ['S4'], run: () => true }]);
    expect(healthy.unverifiedRules).toEqual([]);
  });

  it('driftOf：fixApplyBlocked 只由**未验证规则**驱动（出处债不阻断修复流程）', () => {
    expect(driftOf({ verified: true, unverifiedRules: [] }).fixApplyBlocked).toBe(false);
    expect(driftOf({ verified: false, unverifiedRules: ['S4'] }).fixApplyBlocked).toBe(true);
    expect(driftOf({ verified: true, unverifiedRules: [] }).premiseStale.length).toBeGreaterThan(0); // 债仍在,但不是硬闸
  });
});

describe('R-F · 出处/前提漂移是机读标注（不再只是人读字符串）', () => {
  it('漂移清单与前提存疑清单非空且点名复核给的条目', () => {
    for (const id of ['T2', 'P1', 'P2', 'C1', 'I1', 'G3', 'R2', 'R3', 'E5', 'E6']) expect(SOURCE_DRIFT.drifted).toContain(id);
    for (const id of ['T2', 'P1', 'P2', 'C1']) expect(SOURCE_DRIFT.premiseStale).toContain(id);
    expect(SOURCE_DRIFT.undecidable).toContain('T3');
  });

  it('规则对象上带机读字段（sourceVerified/premiseStale），且清单与字段一致', () => {
    for (const id of SOURCE_DRIFT.premiseStale) {
      const rule = ruleById(id);
      if (!rule) continue;                       // T3 在注册表里存在与否以实际为准
      expect(rule.premiseStale).toBe(true);
      expect(rule.sourceVerified).toBe(false);
    }
    for (const id of SOURCE_DRIFT.drifted) {
      const rule = ruleById(id);
      if (rule) expect(rule.sourceVerified).toBe(false);
    }
    // 新加的三条候选规则有 candidate 标记
    for (const id of ['E8', 'E9', 'E10']) expect(ruleById(id)?.candidate).toBe(true);
    expect(CONTRACT_RULES.length).toBeGreaterThanOrEqual(44);
  });

  it('check 结果里 drift 与 probes 都在（抬头与 --json 的数据源）', () => {
    const r = validateSessionLog({
      header: { type: 'session', version: 3, id: 'x', createdAt: 1 }, headerLine: 0, rows: [],
      events: [], frameInfo: { frames: 0, torn: false },
    });
    expect(r.probes.probes.length).toBeGreaterThanOrEqual(6);
    expect(r.drift.driftedSources).toEqual([...SOURCE_DRIFT.drifted]);
    expect(typeof r.drift.fixApplyBlocked).toBe('boolean');
  });
});
