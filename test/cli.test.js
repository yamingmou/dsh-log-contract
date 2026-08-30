/**
 * dsh-log-contract · test/cli.test.js
 *
 * CLI 冒烟测试：子命令、退出码、JSON 输出。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { validSessionEvents, markerEvent, writeSession } from './helpers.js';

const require = createRequire(import.meta.url);
const BIN = require.resolve('../bin/dsh-log-contract.mjs');

function run(args, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: err.stdout ?? '' };
  }
}

function writeEdit(plan) {
  const file = writeSession(validSessionEvents()).replace(/session\.jsonl$/, 'edit.json');
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

describe('CLI', () => {
  it('--version 输出版本号', () => {
    const { code, out } = run(['--version']);
    expect(code).toBe(0);
    expect(out).toMatch(/^dsh-log-contract \d+\.\d+\.\d+/);
  });

  it('contracts 列出契约目录（含 S5 核心规则）', () => {
    const { code, out } = run(['contracts']);
    expect(code).toBe(0);
    expect(out).toContain('S5');
    expect(out).toContain('写前校验');
  });

  it('check 合法会话 → 退出码 0', () => {
    const file = writeSession(validSessionEvents());
    const { code, out } = run(['check', file]);
    expect(code).toBe(0);
    expect(out).toContain('✅ 通过');
  });

  it('check 违规会话 → 退出码 1 且列出违规', () => {
    const file = writeSession([
      validSessionEvents()[0],
      validSessionEvents()[1],
      markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [] }),
    ]);
    const { code, out } = run(['check', file]);
    expect(code).toBe(1);
    expect(out).toContain('S5');
    expect(out).toContain('❌ 未通过');
  });

  it('check --json 输出机器可读报告', () => {
    const file = writeSession(validSessionEvents());
    const { code, out } = run(['check', file, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.summary.events).toBe(3);
  });

  it('check --resume 输出三档结论（合法会话全绿）', () => {
    const file = writeSession(validSessionEvents());
    const { code, out } = run(['check', file, '--resume']);
    expect(code).toBe(0);
    expect(out).toContain('可加载');
    expect(out).toContain('可继续');
    expect(out).toContain('可压缩');
    expect(out).toContain('可安全继续使用');
  });

  it('check --resume --json 附带 verdict 字段', () => {
    const file = writeSession(validSessionEvents());
    const { code, out } = run(['check', file, '--resume', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.resume.verdict).toBe('compactable');
    expect(parsed.resume.loadable).toBe(true);
    expect(parsed.resume.compactable).toBe(true);
  });

  it('prewrite append 合法 → 退出码 0', () => {
    const log = writeSession(validSessionEvents());
    const edit = writeEdit({
      append: { type: 'user/message', surfaceOp: 'append', data: { id: 'u-new', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } },
    });
    const { code, out } = run(['prewrite', edit, '--log', log]);
    expect(code).toBe(0);
    expect(out).toContain('✅ 写入安全');
  });

  it('prewrite 违约 append → 退出码 1 且列出违规', () => {
    const log = writeSession(validSessionEvents());
    const edit = writeEdit({ append: markerEvent({ seq: 3, start: 0, end: 1, shadowedSeqs: [] }) });
    const { code, out } = run(['prewrite', edit, '--log', log]);
    expect(code).toBe(1);
    expect(out).toContain('S5');
  });
});
