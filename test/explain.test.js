/**
 * test/explain.test.js —— `explain <ruleId>` 子命令（CLI 解读规则）
 *
 * 钉住四条约束：
 *   ① 未知 id ⇒ 非零退出 + 明确提示（含 `contracts` 指路）；
 *   ② `--json` 输出**稳定键集**（EXPLAIN_KEYS：id/found/title/severity/layer/
 *      source/criteria/examples/relatedCommands/doc），未知 id 时同键、值为空；
 *   ③ `--help` 列出 explain；
 *   ④ 不改既有行为（contracts/--version 照常）。
 *
 * 另钉两条"必须变"的反例（改坏必红）：
 *   · **单一权威**：criteria 必须逐字 === `lib/contracts.js` 的 description
 *     （谁在 explain 里另写/复制判据文本，这里立刻红）；
 *   · **正反例指针**必须来自 test/ 扫描（含 id 的用例文件+标题），不是硬编码。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_RULES, ruleById, explainRule, EXPLAIN_KEYS, examplePointers } from '../lib/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');
const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });

describe('explain · 数据层（单一权威 + 稳定结构）', () => {
  it("单一权威：criteria/title/severity/layer/source 逐字等于规则注册表（⛔ 不复制判据文本）", () => {
    const info = explainRule('E5');
    const rule = ruleById('E5');
    expect(info.found).toBe(true);
    expect(info.criteria).toBe(rule.description);   // 判据原文引用，不是副本
    expect(info.title).toBe(rule.title);
    expect(info.severity).toBe(rule.severity);
    expect(info.layer).toBe(rule.layer);
    expect(info.source).toBe(rule.source);
  });

  it('全部注册规则可解释，且输出键集稳定（EXPLAIN_KEYS 恒存在）', () => {
    expect(CONTRACT_RULES.length).toBeGreaterThan(0);
    for (const rule of CONTRACT_RULES) {
      const info = explainRule(rule.id);
      expect(info.found, `${rule.id} 必须可解释`).toBe(true);
      for (const key of EXPLAIN_KEYS) {
        expect(Object.hasOwn(info, key), `${rule.id} 缺稳定键 ${key}`).toBe(true);
      }
      expect(info.criteria).toBe(rule.description);
      expect(info.relatedCommands.length).toBeGreaterThan(0);
    }
  });

  it('未知 id：found=false，其余稳定键仍在（值为空/null）并带 error/hint', () => {
    const info = explainRule('ZZZ9');
    expect(info.found).toBe(false);
    expect(info.id).toBe('ZZZ9');
    for (const key of EXPLAIN_KEYS) {
      expect(Object.hasOwn(info, key), `未知 id 也必须有稳定键 ${key}`).toBe(true);
    }
    expect(info.title).toBeNull();
    expect(info.criteria).toBeNull();
    expect(info.error).toBe('unknown-rule');
    expect(info.knownCount).toBe(CONTRACT_RULES.length);
    expect(info.hint).toContain('contracts');
  });

  it('正/反例指针来自 test/ 扫描（E5 至少有 1 条反例指针），大小写不敏感也能命中', () => {
    const pointers = examplePointers('E5');
    expect(pointers.negative.length).toBeGreaterThan(0);
    expect(pointers.negative[0]).toContain('test/');
    expect(explainRule('e5').found).toBe(true);
    expect(explainRule('e5').id).toBe('E5');
  });
});

describe('explain · CLI（正例 E5 / 反例未知 id / --json / --help）', () => {
  it('正例：explain E5 ⇒ exit 0，输出标题/判据/正反例指针/相关命令', () => {
    const res = run('explain', 'E5');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('explain —— E5');
    expect(res.stdout).toContain('禁用遗留词汇');               // 标题（引自注册表）
    expect(res.stdout).toContain('request/header-delta');       // 判据原文片段
    expect(res.stdout).toContain('正/反例指针');
    expect(res.stdout).toContain('test/');                      // 指针指向测试/夹具
    expect(res.stdout).toContain('相关命令');
    expect(res.stdout).toContain('dsh-log-contract check');
    expect(res.stdout).toContain('docs/CONTRACTS.md');
  });

  it('反例：未知 id ⇒ 非零退出 + 明确提示（含 contracts 指路）', () => {
    const res = run('explain', 'ZZZ9');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('未知规则 id');
    expect(res.stderr).toContain('ZZZ9');
    expect(res.stderr).toContain('contracts');
  });

  it('--json 正例：键集稳定、id/title 正确、criteria 与注册表一致', () => {
    const res = run('explain', 'E5', '--json');
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    for (const key of EXPLAIN_KEYS) {
      expect(Object.hasOwn(payload, key), `--json 缺稳定键 ${key}`).toBe(true);
    }
    expect(payload.id).toBe('E5');
    expect(payload.found).toBe(true);
    expect(payload.title).toBe(ruleById('E5').title);
    expect(payload.criteria).toBe(ruleById('E5').description);
    expect(payload.examples).toHaveProperty('negative');
    expect(payload.relatedCommands.length).toBeGreaterThan(0);
  });

  it('--json 反例：未知 id ⇒ 非零退出，同键稳定结构（found:false、title:null）', () => {
    const res = run('explain', 'ZZZ9', '--json');
    expect(res.status).not.toBe(0);
    const payload = JSON.parse(res.stdout);
    for (const key of EXPLAIN_KEYS) {
      expect(Object.hasOwn(payload, key), `未知 id 的 --json 缺稳定键 ${key}`).toBe(true);
    }
    expect(payload.id).toBe('ZZZ9');
    expect(payload.found).toBe(false);
    expect(payload.title).toBeNull();
    expect(payload.error).toBe('unknown-rule');
  });

  it('不改既有行为：--help 列出 explain；contracts/--version 照常', () => {
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('explain <ruleId>');

    const contracts = run('contracts');
    expect(contracts.status).toBe(0);
    expect(contracts.stdout).toContain('契约规则目录');
    for (const id of ['H1', 'E5', 'Z6', 'A1']) expect(contracts.stdout).toContain(id);

    const version = run('--version');
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^dsh-log-contract \d+\.\d+\.\d+/);
  });
});
