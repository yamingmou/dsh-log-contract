/**
 * test/rules-self-test.test.js —— 规则自检（rules self-test，0.3.28）
 *
 * 机制侧有"每道闸必须有必须变的负对照"的自检；本文件把同一纪律搬进**契约规则**：
 *
 *   ① 注册表完整性：每条规则 id 唯一，且 title/layer/severity/source/description 齐全；
 *   ② 判定绑定：`violation(id)` 挂载的 severity/layer/source 与注册表**逐条一致**
 *      （防"id 拼错 ⇒ 静默落回 error/unknown"这类失配）；
 *   ③ 判定覆盖：每条规则要么在测试里有对照（正或反），要么显式列入
 *      `NON_EMITTING_RULES` 并给出"判定落在哪里"的理由——⛔ 不允许"登记了但没人判"；
 *   ④ 规则行为契约 R4/R5 的负对照本体在 test/read-tolerance.test.js（这里只核绑定）。
 *
 * 违规样本必须判红、合规样本必须绿：本文件自身的"负对照"是注入测试——
 * 往注册表里塞一条缺字段的规则 / 让 violation() 挂错 severity，本文件必须变红。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_RULES, ruleById } from '../lib/contracts.js';
import { violation } from '../lib/checks.js';
import { envelopeViolations, nullTurnStepViolations } from '../lib/checks.js';
import { validateSessionLog } from '../lib/index.js';
import { faithfulFrameInfo } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = path.join(ROOT, 'test');
const LIB_DIR = path.join(ROOT, 'lib');

/**
 * 登记在册但**没有独立违规码**的规则（显式声明判定落点，不算漏判）。
 * 新增规则若无法独立判红，必须在这里给出理由——否则本文件判红。
 */
const NON_EMITTING_RULES = {
  R3: 'chunk 行展开越界由解码层抛出、统一报 R2（同一 fail-loud 判定点）',
  R4: '读取/解析入口的行为契约，判在 test/read-tolerance.test.js（负对照 = 截断/损坏文件必须结构化降级、不得抛）',
  R5: '汇总类 API 的行为契约，判在 test/read-tolerance.test.js（负对照 = 畸形事件必须只丢该项并计数 skipped）',
  S3: 'append 的 sourceEventSeqs 契约由 S5/S6 实现（assertProvenance 拆分为两条违规码），不重复报码',
};

const VALID_LAYERS = new Set(['persistence', 'engine', 'plugin', 'concurrency', 'framing', 'migration', 'archive']);
const VALID_SEVERITIES = new Set(['error', 'warning', 'info']);

describe('规则自检 · 注册表完整性与判定绑定', () => {
  it('每条规则 id 唯一，字段齐全（title/layer/severity/source/description）', () => {
    const seen = new Set();
    for (const rule of CONTRACT_RULES) {
      expect(seen.has(rule.id), `规则 id 重复：${rule.id}`).toBe(false);
      seen.add(rule.id);
      expect(typeof rule.title, `${rule.id} 缺 title`).toBe('string');
      expect(rule.title.length, `${rule.id} title 为空`).toBeGreaterThan(0);
      expect(VALID_LAYERS.has(rule.layer), `${rule.id} layer 非法：${rule.layer}`).toBe(true);
      expect(VALID_SEVERITIES.has(rule.severity), `${rule.id} severity 非法：${rule.severity}`).toBe(true);
      expect(typeof rule.source, `${rule.id} 缺 source`).toBe('string');
      expect(rule.source.length, `${rule.id} source 为空`).toBeGreaterThan(0);
      expect(typeof rule.description, `${rule.id} 缺 description`).toBe('string');
      expect(rule.description.length, `${rule.id} description 为空`).toBeGreaterThan(0);
    }
  });

  it('violation(id) 挂载的 severity/layer/source 与注册表逐条一致（防 id 拼错静默失配）', () => {
    for (const rule of CONTRACT_RULES) {
      const v = violation(rule.id, {}, 'rules self-test');
      expect(v.severity, `${rule.id} severity 绑定失配`).toBe(rule.severity);
      expect(v.layer, `${rule.id} layer 绑定失配`).toBe(rule.layer);
      expect(v.source, `${rule.id} source 绑定失配`).toBe(rule.source);
      expect(v.id).toBe(rule.id);
    }
    // 注入负对照：不存在的 id 不得伪装成注册规则
    const bogus = violation('ZZ9', {}, 'injected');
    expect(ruleById('ZZ9')).toBeUndefined();
    expect(bogus.layer).toBe('unknown');
  });

  it('判定覆盖：每条规则都有测试对照/绑定断言，或显式列入 NON_EMITTING_RULES 并给出理由', () => {
    // 口径如实：本闸检查"测试里存在以该规则 id 做断言的引用"（正/反对照或绑定断言）；
    // 不解析断言强度——对照的红/绿强度由各规则自己的负对照用例负责。
    const testTexts = fs.readdirSync(TEST_DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(TEST_DIR, f), 'utf8'));
    const missing = [];
    for (const rule of CONTRACT_RULES) {
      const quoted = [`'${rule.id}'`, `"${rule.id}"`, `\`${rule.id}\``];
      const covered = testTexts.some((t) => quoted.some((q) => t.includes(q)));
      if (covered) continue;
      const reason = NON_EMITTING_RULES[rule.id];
      if (!reason || reason.length < 10) missing.push(rule.id);
    }
    expect(missing, `以下规则既无测试对照也无 NON_EMITTING_RULES 理由：${missing.join(', ')}`).toEqual([]);
  });

  it('lib 里每个 violation(\'ID\') 都在注册表里（防"报了没登记"）', () => {
    const registered = new Set(CONTRACT_RULES.map((r) => r.id));
    const emitted = new Set();
    for (const f of fs.readdirSync(LIB_DIR).filter((x) => x.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
      for (const m of text.matchAll(/violation\(\s*'([A-Z]\d+)'/g)) emitted.add(m[1]);
    }
    const unregistered = [...emitted].filter((id) => !registered.has(id));
    expect(unregistered, `报了没登记的违规码：${unregistered.join(', ')}`).toEqual([]);
  });
});

describe('规则自检 · 补齐缺对照规则的负对照（E1 / E4 / T4）', () => {
  it('E1 负对照：seq 缺失/非法（负数）⇒ E1 error；非负安全整数 ⇒ 绿', () => {
    const bad = { type: 'user/message', seq: -1, time: 1, surfaceOp: 'append', data: {} };
    const good = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: {} };
    const badVs = envelopeViolations(bad, { seq: -1 }, 3);
    expect(badVs.some((v) => v.id === 'E1')).toBe(true);
    expect(badVs.find((v) => v.id === 'E1').severity).toBe('error');
    expect(envelopeViolations(good, { seq: 0 }, 3).some((v) => v.id === 'E1')).toBe(false);
  });

  it("E4 负对照：data 非 lossless-JSON（NaN）⇒ E4 error；合法 data ⇒ 绿", () => {
    const bad = {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { id: 'u-0', role: 'user', source: { kind: 'user' }, content: [], n: Number.NaN },
    };
    const good = {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { id: 'u-0', role: 'user', source: { kind: 'user' }, content: [] },
    };
    const badVs = envelopeViolations(bad, { seq: 0 }, 3);
    expect(badVs.some((v) => v.id === 'E4')).toBe(true);
    expect(badVs.find((v) => v.id === 'E4').severity).toBe('error');
    expect(envelopeViolations(good, { seq: 0 }, 3).some((v) => v.id === 'E4')).toBe(false);
  });

  it('T4 负对照：step/start 的 data.turn 缺失 ⇒ T4 error；带 turn ⇒ 绿', () => {
    const wrap = (event) => [{ event, lineNo: 1 }];
    const bad = { type: 'step/start', seq: 4, data: { turn: null, step: 1 } };
    const good = { type: 'step/start', seq: 4, data: { turn: 3, step: 1 } };
    const badVs = nullTurnStepViolations(wrap(bad));
    expect(badVs.some((v) => v.id === 'T4')).toBe(true);
    expect(badVs.find((v) => v.id === 'T4').severity).toBe('error');
    expect(nullTurnStepViolations(wrap(good)).some((v) => v.id === 'T4')).toBe(false);
  });

  it('Z3 负对照（含 v4）：空壳会话（有 header 无事件）在 v0 与 v4 下都必须判 Z3', () => {
    for (const version of [0, 4]) {
      const log = {
        header: { type: 'session', version, id: 'empty-shell', createdAt: 1 },
        headerLine: 0,
        rows: [],
        events: [],
        frameInfo: faithfulFrameInfo({ eventRows: 0 }),
      };
      const result = validateSessionLog(log);
      const z3 = result.violations.filter((v) => v.id === 'Z3');
      expect(z3.length, `v${version} 空壳会话必须报 Z3`).toBe(1);
      expect(z3[0].severity).toBe('warning');
    }
  });
});
