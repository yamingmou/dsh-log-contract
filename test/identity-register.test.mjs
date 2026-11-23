/**
 * test/identity-register.test.mjs —— scripts/identity-register.mjs 的回归用例
 *
 * ID2「号可验」的**发布前一步**是"用产物实算摘要并登记"。本套件钉住该工具的四条行为
 * 边界 + 一条集成反例（全部在临时目录里跑**真实副本**，⛔ 不改仓）：
 *
 *   ① 幂等：同版本 `--print` 连跑两次 ⇒ 摘要/文件数/登记表路径完全一致，登记表字节与条目数不变；
 *   ② 写入路径幂等：不带 `--print` 连跑两次 ⇒ 登记表**字节不变**（不重复追加条目）；
 *   ③ 同号摘要变化告警：临时副本里改一个 `lib/` 文件 ⇒ 输出"同号摘要变化 … 应先换号"（ID1 视角），
 *      且仍按显式指令把该版本**唯一**条目更新为实算摘要（不新增条目）；
 *   ④ `--print` 只打印不写：登记表字节/条目不边、不新建登记表、不执行写路径（无告警）；
 *   ⑤ 缺省版本取 package.json；显式版本覆盖；两者都缺 ⇒ exit 1 + 明确报错；
 *   ⑥ 集成反例：伪造旧摘要 ⇒ 真实 CLI `check --json` 的 `identity.ok=false`
 *      （ID2 带 file:line 与 registered/computed 摘要）；**正例对照**同夹具换回实算摘要 ⇒ 绿
 *      （证明红不是"恒红"；另证 identity 段不参与 check 的 ok/退出码）。
 *
 * 夹具说明：`identity-register.mjs` 的 ROOT = 脚本自身目录的父 ⇒ 把**真实脚本**与
 * **真实 lib/identity.js** 复制进 `<-tmp>/scripts|lib`，登记表落在 `<tmp>/docs/`；
 * 集成反例把整个 `lib/`+`bin/` 复制进临时包（node_modules 用软链指向本仓），
 * 从而让真实 CLI 的 `packageRoot()` 落在临时包上。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRuntimeDigest, IDENTITY_REGISTRY, IDENTITY_FAMILY } from '../lib/identity.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REGISTER_SCRIPT = path.join(ROOT, 'scripts', 'identity-register.mjs');
const IDENTITY_MODULE = path.join(ROOT, 'lib', 'identity.js');

const roots = [];
const mkTmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writeFile = (root, rel, text) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
const readText = (file) => fs.readFileSync(file, 'utf8');
const sha256File = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const registryFile = (root) => path.join(root, IDENTITY_REGISTRY);

const DEFAULT_RUNTIME = {
  'lib/a.js': 'export const a = 1;\n',
  'lib/nested/b.js': 'export const b = 2;\n',
  'bin/c.mjs': '#!/usr/bin/env node\n',
};

/**
 * 造"包 + scripts/identity-register.mjs 真实副本"夹具。
 * `registry` 传对象/字符串；null = 不写登记表（docs/ 目录仍建，脚本自己不 mkdir）。
 */
function makePackage({ version = '1.0.0', runtime = DEFAULT_RUNTIME, registry = null } = {}) {
  const root = mkTmp('dsh-idreg-');
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture-pkg', version, type: 'module' }, null, 2) + '\n');
  for (const [rel, text] of Object.entries(runtime)) writeFile(root, rel, text);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  // 真实脚本 + 真实 identity 模块（脚本 import '../lib/identity.js' ⇒ 跑夹具自己的副本）
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(REGISTER_SCRIPT, path.join(root, 'scripts', 'identity-register.mjs'));
  writeFile(root, 'lib/identity.js', readText(IDENTITY_MODULE));
  if (registry !== null) {
    writeFile(root, IDENTITY_REGISTRY, typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2) + '\n');
  }
  return root;
}

/** 跑夹具里的 identity-register 脚本（cwd = 夹具根，ROOT 由脚本位置决定）。 */
const runRegister = (root, args = []) => spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'identity-register.mjs'), ...args],
  { encoding: 'utf8', cwd: root },
);

const parseJsonOut = (res) => {
  expect(res.status, `identity-register 退出码异常：stdout=${res.stdout} stderr=${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout);
};

const registryWith = (entries) => ({ schema: 1, family: IDENTITY_FAMILY, algorithm: 'x', entries });
const entriesOf = (root) => JSON.parse(readText(registryFile(root))).entries;

describe('① 幂等：同版本 --print 连跑两次', () => {
  it('两次输出逐字段一致（version/digest/files/registry），登记表条目数与字节不变', () => {
    const root = makePackage();
    const first = parseJsonOut(runRegister(root, ['--print', '1.0.0']));
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith([{ version: '1.0.0', digest: first.digest }]), null, 2) + '\n');
    const before = readText(registryFile(root));

    const a = parseJsonOut(runRegister(root, ['--print', '1.0.0']));
    const b = parseJsonOut(runRegister(root, ['--print', '1.0.0']));
    expect(b).toEqual(a);
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.files).toBe(Object.keys(DEFAULT_RUNTIME).length + 1); // + 夹具里复制的 lib/identity.js
    expect(a.registry).toBe(IDENTITY_REGISTRY);
    // 登记表：字节与条目数都不变（--print 连跑不产生第二份条目）
    expect(readText(registryFile(root))).toBe(before);
    expect(entriesOf(root)).toHaveLength(1);
  });

  it('写入路径同样幂等：连跑两次（不带 --print）⇒ 登记表字节不变、只有一条同号条目', () => {
    const root = makePackage();
    const w1 = runRegister(root, ['1.0.0']);
    expect(w1.status).toBe(0);
    const after1 = readText(registryFile(root));
    const w2 = runRegister(root, ['1.0.0']);
    expect(w2.status).toBe(0);
    expect(readText(registryFile(root))).toBe(after1); // 第二次不追加、不改字节
    const entries = entriesOf(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('1.0.0');
    expect(w2.stdout).toContain('✅');
  });
});

describe('② 同号摘要变化告警（ID1 视角；临时副本模拟同号改代码）', () => {
  it('改一个 lib 文件 ⇒ 输出"同号摘要变化 … 应先换号"，且仍只保留一条该版本条目', () => {
    const root = makePackage();
    const registered = parseJsonOut(runRegister(root, ['--print'])).digest;
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith([{ version: '1.0.0', digest: registered }]), null, 2) + '\n');

    // 同号改代码（只在临时副本里改；仓本体不动）
    writeFile(root, 'lib/a.js', 'export const a = 2; // 同号改代码\n');
    const res = runRegister(root, ['1.0.0']);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status).toBe(0);
    expect(output).toContain('同号摘要变化');
    expect(output).toContain('应先换号');
    expect(output).toContain(registered); // 旧摘要出现在告警里（人可核对）

    const entries = entriesOf(root);
    expect(entries).toHaveLength(1); // 不新增同号第二条（ID1 一物一号）
    const now = parseJsonOut(runRegister(root, ['--print', '1.0.0'])).digest;
    expect(entries[0].digest).toBe(now); // 记录的行为：按显式指令覆盖为实算摘要
    expect(entries[0].digest).not.toBe(registered);
  });

  it('反例（防噪音）：只改文档/测试、不动运行时代码 ⇒ 摘要不变、无告警', () => {
    const root = makePackage();
    const digest = parseJsonOut(runRegister(root, ['--print'])).digest;
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith([{ version: '1.0.0', digest }]), null, 2) + '\n');
    writeFile(root, 'docs/README.md', '# only docs\n');
    writeFile(root, 'test/x.test.mjs', '// only test\n');
    const res = runRegister(root, ['1.0.0']);
    expect(`${res.stdout}${res.stderr}`).not.toContain('同号摘要变化');
    expect(entriesOf(root)[0].digest).toBe(digest);
  });
});

describe('③ --print 只打印不写', () => {
  it('登记表已存在（含过期摘要）⇒ 字节不变、条目不增、不执行写路径（无告警）', () => {
    const root = makePackage();
    const stale = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith([{ version: '1.0.0', digest: stale, note: 'keep me' }]), null, 2) + '\n');
    const before = readText(registryFile(root));
    const beforeSha = sha256File(registryFile(root));

    const res = runRegister(root, ['--print', '1.0.0']);
    const payload = parseJsonOut(res);
    expect(payload.digest).not.toBe(stale); // 打印的是实算摘要
    expect(payload.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 没写：内容/sha 不变；也没走写路径（过期摘要不会触发写路径告警）
    expect(readText(registryFile(root))).toBe(before);
    expect(sha256File(registryFile(root))).toBe(beforeSha);
    expect(entriesOf(root)).toHaveLength(1);
    expect(entriesOf(root)[0].note).toBe('keep me');
    expect(`${res.stdout}${res.stderr}`).not.toContain('同号摘要变化');
  });

  it('登记表不存在 ⇒ --print 不创建它', () => {
    const root = makePackage();
    expect(fs.existsSync(registryFile(root))).toBe(false);
    const payload = parseJsonOut(runRegister(root, ['--print']));
    expect(payload.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fs.existsSync(registryFile(root))).toBe(false);
  });
});

describe('④ 版本来源：缺省取 package.json / 显式覆盖 / 都缺则红', () => {
  it('无位置参数 ⇒ version 取 package.json.version', () => {
    const root = makePackage({ version: '2.3.4' });
    expect(parseJsonOut(runRegister(root, ['--print'])).version).toBe('2.3.4');
    expect(parseJsonOut(runRegister(root, ['--print', '--print'])).version).toBe('2.3.4');
  });

  it('显式位置参数覆盖 package.json.version', () => {
    const root = makePackage({ version: '2.3.4' });
    expect(parseJsonOut(runRegister(root, ['--print', '9.9.9'])).version).toBe('9.9.9');
  });

  it('反例：package.json 缺 version 且无位置参数 ⇒ exit 1 + 明确报错（不猜、不写）', () => {
    const root = makePackage();
    writeFile(root, 'package.json', JSON.stringify({ name: 'fixture-pkg', type: 'module' }, null, 2) + '\n');
    const res = runRegister(root, ['--print']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('无法确定版本');
    expect(fs.existsSync(registryFile(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 集成反例：伪造旧摘要 ⇒ 真实 CLI 的 check --json identity.ok=false
// ---------------------------------------------------------------------------
/** 复制本仓 lib/+bin/ 到临时包（node_modules 软链回本仓），让 CLI 的 packageRoot() 落在这里。 */
function makeCliPackage({ version = '0.0.1', registry }) {
  const root = mkTmp('dsh-idreg-cli-');
  fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'bin'), path.join(root, 'bin'), { recursive: true });
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture-pkg', version, type: 'module' }, null, 2) + '\n');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registry, null, 2) + '\n');
  writeFile(root, 's.jsonl', JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1 }) + '\n');
  return root;
}

const runCheckJson = (root) => {
  const res = spawnSync(
    process.execPath,
    [path.join(root, 'bin', 'dsh-log-contract.mjs'), 'check', path.join(root, 's.jsonl'), '--json'],
    { encoding: 'utf8', cwd: root },
  );
  expect(res.stdout, `check --json 没有 stdout：stderr=${res.stderr}`).toBeTruthy();
  return { res, payload: JSON.parse(res.stdout) };
};

describe('⑤ 集成反例：伪造旧摘要 ⇒ check --json identity.ok=false', () => {
  it('伪造摘要 ⇒ identity.ok=false + ID2（file:line + registered/computed）；正例同夹具换回实算摘要 ⇒ 绿', () => {
    const version = '0.0.1';
    // 正例对照：先建夹具（lib/+bin/ 已复制）再算实算摘要回写 ⇒ identity 绿（证明下面的红不是恒红）
    const good = makeCliPackage({ version, registry: registryWith([]) });
    const goodDigest = computeRuntimeDigest({ root: good }).digest;
    writeFile(good, IDENTITY_REGISTRY, JSON.stringify(registryWith([{ version, digest: goodDigest }]), null, 2) + '\n');
    const positive = runCheckJson(good).payload;
    expect(positive.identity.ok).toBe(true);
    expect(positive.identity.findings).toEqual([]);

    // 反例：伪造"旧摘要"（同一版本号、第二份内容）
    const forged = 'sha256:forgedoldforgedoldforgedoldforgedoldforgedoldforgedoldforged';
    const bad = makeCliPackage({ version, registry: registryWith([{ version, digest: forged }]) });
    const { res, payload } = runCheckJson(bad);
    expect(payload.identity.ok).toBe(false);
    const id2 = payload.identity.findings.find((f) => f.id === 'ID2');
    expect(id2, `identity findings: ${JSON.stringify(payload.identity.findings)}`).toBeTruthy();
    expect(id2.file).toBe(IDENTITY_REGISTRY);
    expect(id2.message).toContain('登记摘要 ≠ 产物实算摘要');
    expect(id2.extra.version).toBe(version);
    expect(id2.extra.registeredDigest).toBe(forged);
    expect(id2.extra.computedDigest).toBe(computeRuntimeDigest({ root: bad }).digest);
    expect(id2.extra.computedDigest).not.toBe(forged);
    // 文档化边界：identity 段只诊断，不参与 check 的 ok / 退出码（不改既有判定）
    expect(payload.ok).toBe(true);
    expect(res.status).toBe(0);
  });
});
