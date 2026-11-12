/**
 * test/error-contract.test.mjs —— E1–E6 错误契约静态检查（每条规则正例 + 反例）
 *
 * ⚠️ 规则是启发式的：本测试钉住的是**判据的边界**（该红的红、不该红的不红），
 * 不是"所有真实代码都该被报"。夹具用单引号字符串拼装，避免模板转义干扰。
 */

import { describe, it, expect } from 'vitest';
import {
  scanSource,
  scanInvariantSentences,
  scanDeclaredKeysNoRead,
  validateWhitelist,
  checkErrorContract,
  ERROR_CONTRACT_RULES,
  ERROR_CONTRACT_RULE_BY_ID,
} from '../lib/error-contract.js';

const lines = (...xs) => xs.join('\n');
const ids = (findings) => findings.map((f) => f.id);

describe('规则目录', () => {
  it('6 条规则齐全且 id/severity 稳定', () => {
    expect(ERROR_CONTRACT_RULES.map((r) => r.id)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
    expect(ERROR_CONTRACT_RULES.every((r) => r.family === 'error-expression')).toBe(true);
    expect(ERROR_CONTRACT_RULES.every((r) => ['error', 'warning', 'info'].includes(r.severity))).toBe(true);
    expect(ERROR_CONTRACT_RULE_BY_ID.get('E3').falsePositiveRisk).toBe('medium');
    expect(ERROR_CONTRACT_RULE_BY_ID.get('E6').falsePositiveRisk).toBe('high');
  });
});

describe('E1 一个码多成因', () => {
  const POS = lines(
    'export function f(id, d) {',
    '  try { a() } catch (e) { throw new E(`x ${id} unavailable`, "NOT_RESUMABLE", { cause: e }) }',
    '  if (!d) throw new E(`y ${id} not continuable`, "NOT_RESUMABLE")',
    '}',
  );
  const NEG_SAME_MSG = lines(
    'export function f(id) {',
    '  if (!id) throw new E(`bad id ${id}`, "BAD_ID")',
    '  if (id < 0) throw new E(`bad id ${id}`, "BAD_ID")',
    '}',
  );
  const NEG_DISTINCT_CODES = lines(
    'export function f(id) {',
    '  if (!id) throw new E(`missing ${id}`, "MISSING_ID")',
    '  if (!Number.isInteger(id)) throw new E(`type ${id}`, "BAD_TYPE")',
    '}',
  );

  it('正例：同一 CODE ≥2 site 且 message 不同 ⇒ 红', () => {
    expect(ids(scanSource({ file: 'p.mjs', text: POS }))).toContain('E1');
  });
  it('反例：同码同 message ⇒ 不算多成因（另有 E2 语义）', () => {
    expect(ids(scanSource({ file: 'n.mjs', text: NEG_SAME_MSG }))).not.toContain('E1');
  });
  it('反例：不同码 ⇒ 不报 E1', () => {
    expect(ids(scanSource({ file: 'n2.mjs', text: NEG_DISTINCT_CODES }))).not.toContain('E1');
  });
});

describe('E2 message 是常量', () => {
  const POS = lines(
    'export function f(id) {',
    '  try { a() } catch (e) { throw new E(`sub ${id} is unavailable`, "NOT_RESUMABLE", { cause: e }) }',
    '  try { b() } catch (e) { throw new E(`sub ${id} is unavailable`, "NOT_RESUMABLE", { cause: e }) }',
    '}',
  );
  const NEG = lines(
    'export function f(id) {',
    '  if (!id) throw new E(`missing id ${id}`, "MISSING_ID")',
    '  if (!Number.isInteger(id)) throw new E(`bad type for ${id}`, "BAD_TYPE")',
    '}',
  );

  it('正例：同模板被 ≥2 site 共用（插值只含标识）⇒ 红', () => {
    expect(ids(scanSource({ file: 'p.mjs', text: POS }))).toContain('E2');
  });
  it('反例：单 site / 不同码 ⇒ 不报 E2', () => {
    expect(ids(scanSource({ file: 'n.mjs', text: NEG }))).not.toContain('E2');
  });
});

describe('E2 插值归一（N6 边界）', () => {
  const POS = lines(
    'export function f(d) {',
    '  if (!d) throw new E(`thing ${z} failed`, "X_FAILED")',
    '  if (d === 1) throw new E(`thing ${w} failed`, "X_FAILED")',
    '}',
  );
  it('插值变量名不同仍算同一模板 ⇒ 报 E2 且不报 E1', () => {
    const found = scanSource({ file: 'p.mjs', text: POS });
    expect(found.some((x) => x.id === 'E2')).toBe(true);
    expect(found.some((x) => x.id === 'E1')).toBe(false);
  });
});

describe('E3 终态词用于非终态因', () => {
  const POS = lines(
    'export function f() {',
    '  try { a() } catch (e) { throw new E(`x unavailable`, "NOT_RESUMABLE", { cause: e }) }',
    '}',
  );
  const NEG = lines(
    'export function f() {',
    '  try { a() } catch (e) { throw new E(`read failed: ${e.code}`, "READ_FAILED", { cause: e }) }',
    '}',
  );

  it('正例：NOT_* 码 + catch 内收编任意 error ⇒ 红', () => {
    expect(ids(scanSource({ file: 'p.mjs', text: POS }))).toContain('E3');
  });
  it('反例：非终态码（READ_FAILED）⇒ 不报 E3', () => {
    expect(ids(scanSource({ file: 'n.mjs', text: NEG }))).not.toContain('E3');
  });
});

describe('E4 cause 未透出', () => {
  const POS = lines(
    'export function f() {',
    '  try { a() } catch (e) { throw new E(`x unavailable`, "READ_FAILED", { cause: e }) }',
    '}',
  );
  const NEG = lines(
    'export function f() {',
    '  try { a() } catch (e) { throw new E(`read failed: ${e.code}`, "READ_FAILED", { cause: e }) }',
    '}',
  );

  it('正例：带 cause 但 message 无 cause 摘要 ⇒ 红', () => {
    expect(ids(scanSource({ file: 'p.mjs', text: POS }))).toContain('E4');
  });
  it('反例：message 引用 cause.code ⇒ 不报 E4', () => {
    expect(ids(scanSource({ file: 'n.mjs', text: NEG }))).not.toContain('E4');
  });
});

describe('E5 无条件成功（候选）', () => {
  const POS = lines(
    'async function addAttachments(list) {',
    '  for (const x of list) { this.items.push(x) }',
    '  return true',
    '}',
  );
  const NEG = lines(
    'async function addAttachments(list) {',
    '  if (!list) throw new Error("bad list")',
    '  return true',
    '}',
  );

  it('正例：async 全返回 true 且无 throw ⇒ 候选 E5', () => {
    expect(ids(scanSource({ file: 'p.mjs', text: POS }))).toContain('E5');
  });
  it('反例：有 throw 失败路径 ⇒ 不报 E5', () => {
    expect(ids(scanSource({ file: 'n.mjs', text: NEG }))).not.toContain('E5');
  });
  it('E5 只给 info（不阻断）', () => {
    const f = scanSource({ file: 'p.mjs', text: POS }).find((x) => x.id === 'E5');
    expect(f.severity).toBe('info');
  });
});

describe('E6 声称无执行点（候选）', () => {
  it('正例①：README 不变式句 ⇒ 候选', () => {
    const found = scanInvariantSentences({ file: 'README.md', text: 'The writer never emits partial lines.\n' });
    expect(found.length).toBe(1);
    expect(found[0].severity).toBe('info');
  });
  it('反例①：普通句子（无 never/always/guaranteed/must not）⇒ 不报', () => {
    expect(scanInvariantSentences({ file: 'README.md', text: 'This module reads session logs.\n' })).toHaveLength(0);
  });
  it('正例②：配置声明 key 无读取点 ⇒ 候选', () => {
    const found = scanDeclaredKeysNoRead({ keys: [{ name: 'thresholdRatio', line: 3 }], sources: [{ file: 'lib/x.js', text: 'const a = 1' }] });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('E6');
  });
  it('反例②：代码里有读取点 ⇒ 不报', () => {
    const found = scanDeclaredKeysNoRead({ keys: ['thresholdRatio'], sources: [{ file: 'lib/x.js', text: 'const a = config.thresholdRatio' }] });
    expect(found).toHaveLength(0);
  });
});

describe('白名单（fail-closed）与报告结构', () => {
  const POS = lines(
    'export function f() {',
    '  try { a() } catch (e) { throw new E(`x unavailable`, "NOT_RESUMABLE", { cause: e }) }',
    '}',
  );

  it('白名单命中 ⇒ 抑制（记入 suppressed）', () => {
    const rep = checkErrorContract({
      files: [{ file: 'p.mjs', text: POS }],
      whitelist: [{ rule: 'E3', file: 'p.mjs', reason: '夹具：白名单机制自测', expires: '2099-01-01' }],
    });
    expect(rep.summary.suppressed).toBeGreaterThan(0);
    expect(rep.findings.some((f) => f.id === 'E3')).toBe(false);
  });

  it('负例：白名单缺 expires ⇒ 不合法（fail-closed）', () => {
    const { ok, problems } = validateWhitelist([{ rule: 'E3', file: 'p.mjs', reason: 'x' }]);
    expect(ok).toBe(false);
    expect(problems.join(' ')).toContain('expires');
  });

  it('负例：白名单过期 ⇒ 不合法', () => {
    const { ok, problems } = validateWhitelist([{ rule: 'E3', file: 'p.mjs', reason: 'x', expires: '2000-01-01' }]);
    expect(ok).toBe(false);
    expect(problems.join(' ')).toContain('过期');
  });

  it('报告含 schemaVersion / rules(id,severity) / summary.byRule', () => {
    const rep = checkErrorContract({ files: [{ file: 'p.mjs', text: POS }], target: 'T1' });
    expect(rep.schemaVersion).toBe('1');
    expect(rep.family).toBe('error-expression');
    expect(rep.target).toBe('T1');
    expect(rep.rules.map((r) => r.id)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
    expect(rep.rules.every((r) => typeof r.severity === 'string')).toBe(true);
    expect(rep.summary.byRule.E3).toBeGreaterThan(0);
    expect(rep.findings.every((f) => f.evidence !== undefined)).toBe(true);
  });
});
