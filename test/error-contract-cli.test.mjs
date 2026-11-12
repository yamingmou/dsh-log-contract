/**
 * test/error-contract-cli.test.mjs —— `error-contract` 子命令的 CLI 级用例
 *
 * 覆盖 L1 返修清单：
 *   N1 路径归一化（尾斜杠 // 与无斜杠结果一致；白名单两种形式都能命中）
 *   N2 退出码（无法判定 ⇒ 2）
 *   N3 E6① 的 CLI 可达（--keys / --config）
 *   N7 官方包夹具：存在则锁 NOT_RESUMABLE 的 E1/E2；不存在则 skip
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/dsh-log-contract.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, [BIN, 'error-contract', ...args], { encoding: 'utf8' });

const FIXTURE = [
  'export function f(id, d) {',
  '  try { a() } catch (e) { throw new E(`sub ${id} is unavailable`, "NOT_RESUMABLE", { cause: e }) }',
  '  if (!d) throw new E(`sub ${id} not continuable`, "NOT_RESUMABLE")',
  '}',
].join('\n');

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'ec-cli-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'bad2.mjs'), FIXTURE);
  writeFileSync(join(dir, 'ok.mjs'), 'export const a = 1;\n');
  return dir;
}

describe('N1 路径归一化', () => {
  it('尾斜杠与无斜杠：findings.file 不含 // 且两侧一致', () => {
    const dir = makeTree();
    try {
      const a = run([dir, '--json']);
      const b = run([`${dir}/`, '--json']);
      expect(a.status).toBe(b.status);
      const ja = JSON.parse(a.stdout);
      const jb = JSON.parse(b.stdout);
      expect(ja.findings.map((f) => f.file)).toEqual(jb.findings.map((f) => f.file));
      expect(ja.findings.every((f) => !f.file.includes('//'))).toBe(true);
      expect(ja.findings.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('白名单在「带尾斜杠调用 + 白名单写另一种形式」时仍能命中', () => {
    const dir = makeTree();
    try {
      const wl = join(dir, 'wl.json');
      writeFileSync(wl, JSON.stringify({ entries: [{ rule: 'E3', file: `${dir}/sub//bad2.mjs`, reason: '归一化用例', expires: '2099-01-01' }] }));
      const r = run([`${dir}/`, '--whitelist', wl, '--json']);
      const j = JSON.parse(r.stdout);
      const e3 = j.findings.filter((f) => f.id === 'E3');
      expect(e3).toHaveLength(0);
      expect(j.summary.suppressed).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('N2 退出码：无法判定 ⇒ 2', () => {
  it('非法 target ⇒ 2', () => {
    expect(run(['/tmp', '--target', 'XX']).status).toBe(2);
  });
  it('路径不存在 ⇒ 2', () => {
    expect(run(['/tmp/definitely-not-here-xyz']).status).toBe(2);
  });
  it('无路径参数 ⇒ 2', () => {
    expect(run([]).status).toBe(2);
  });
});

describe('N3 E6① CLI 可达（--keys / --config）', () => {
  it('--keys 声明 key 无读取点 ⇒ E6 候选', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-keys-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
      const r = run([dir, '--keys', 'thresholdRatio', '--json']);
      const j = JSON.parse(r.stdout);
      expect(j.findings.some((f) => f.id === 'E6')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--config 从 YAML config: 段派生 key 并检查读取点', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-cfg-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), 'export const a = config.thresholdRatio;\n');
      writeFileSync(join(dir, 'cordis.patch.yml'), 'config:\n  thresholdRatio: 0.8\n  missingKey: 1\n');
      const r = run([dir, '--config', join(dir, 'cordis.patch.yml'), '--json']);
      const j = JSON.parse(r.stdout);
      const e6 = j.findings.filter((f) => f.id === 'E6').map((f) => f.evidence.key);
      expect(e6).toContain('missingKey');
      expect(e6).not.toContain('thresholdRatio');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('N8 显式排除（--exclude）', () => {
  it('扫仓库根 + --exclude test,contract ⇒ 只报 lib/ 下的命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-excl-'));
    try {
      mkdirSync(join(dir, 'lib'), { recursive: true });
      mkdirSync(join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'lib', 'a.mjs'), FIXTURE);
      writeFileSync(join(dir, 'test', 'b.mjs'), FIXTURE);
      const all = JSON.parse(run([dir, '--json']).stdout);
      expect(new Set(all.findings.map((f) => f.file))).toContain(join(dir, 'test', 'b.mjs'));
      const only = JSON.parse(run([dir, '--exclude', 'test', '--json']).stdout);
      expect(only.findings.every((f) => f.file.includes('/lib/'))).toBe(true);
      expect(only.findings.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 官方夹具定位（N7 复评②）：env 优先，再按「App 安装树 / ~/opena 下 lab-* 工作树」多候选，
 *  找不到就 skip（⛔ 不硬编码单一机器路径，换机不静默误绿也不报错）。 */
function findOfficialFixture() {
  const res = (p) => (p && existsSync(p) ? p : null);
  const env = process.env.DSH_SUBAGENT_PKG;
  if (env) {
    const asFile = res(env);
    if (asFile) return asFile;
    const asDir = res(join(env, 'lib', 'index.js'));
    if (asDir) return asDir;
  }
  const fixed = [
    '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-subagent/lib/index.js',
    join(homedir(), 'opena', 'dsh-lab-016a2', 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'index.js'),
  ].map(res).filter(Boolean);
  if (fixed.length) return fixed[0];
  try {
    const roots = fs.readdirSync(join(homedir(), 'opena')).filter((n) => n.startsWith('dsh-lab-'));
    for (const r of roots) {
      const hit = res(join(homedir(), 'opena', r, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'index.js'));
      if (hit) return hit;
    }
  } catch { /* 无 ~/opena 也不崩：走 skip */ }
  return null;
}
const OFFICIAL = findOfficialFixture();

describe.skipIf(!existsSync(OFFICIAL))('N7 官方包夹具（存在才跑）', () => {
  it('T2 扫官方 dsh-subagent ⇒ E1 命中 NOT_RESUMABLE、E2 命中共用模板', () => {
    const r = run([OFFICIAL, '--target', 'T2', '--json']);
    expect(r.status).toBe(0); // T2 只登记 ⇒ 不阻断
    const j = JSON.parse(r.stdout);
    const e1 = j.findings.filter((f) => f.id === 'E1' && /NOT_RESUMABLE/.test(f.message));
    const e2 = j.findings.filter((f) => f.id === 'E2' && /NOT_RESUMABLE/.test(f.message));
    expect(e1.length).toBeGreaterThan(0);
    expect(e2.length).toBeGreaterThan(0);
  });
});
