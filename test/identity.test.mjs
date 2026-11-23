/**
 * test/identity.test.mjs —— IDENTITY（版本同一性）契约 · ID1/ID2
 *
 * 判据 −1「跑的东西是不是你以为的那个」：`0.2.3-alpha.1` 案例 = vendored 源码更新但版本号未换
 * （npm 不许重发）⇒ 消费方拿到旧构建。本套件钉住两条规则的正/反例：
 *
 *   ID1 一物一号：同一版本出现两个不同摘要 ⇒ 红（带 file:line）；重复登记但摘要相同 ⇒ 不误报。
 *   ID2 号可验：声明版本 ↔ 登记摘要 ↔ 产物实算摘要必须一致 ⇒ 反之红（未登记/伪造/同号改代码）；
 *       **防噪音**：只改文档（运行时代码不变）⇒ 绿。
 *
 * 夹具用临时目录（自造 package.json + lib/ + bin/ + 登记表），不碰仓库本体；
 * 集成用例只读当前仓（登记表存在 ⇒ 必须绿）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDENTITY_RULES,
  IDENTITY_RULE_BY_ID,
  IDENTITY_FAMILY,
  IDENTITY_REGISTRY,
  checkIdentity,
  computeRuntimeDigest,
  readIdentityRegistry,
  lineOfOccurrence,
} from '../lib/identity.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');

const writeFile = (root, rel, text) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};

/** 造一个"包 + 登记表"夹具；registry 传入对象/字符串，null = 不写登记表。 */
function makeTree({ version = '1.0.0', files = null, registry = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-identity-'));
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture-pkg', version }, null, 2) + '\n');
  const runtime = files ?? { 'lib/a.js': 'export const a = 1;\n', 'lib/nested/b.js': 'export const b = 2;\n', 'bin/c.mjs': '#!/usr/bin/env node\n' };
  for (const [rel, text] of Object.entries(runtime)) writeFile(root, rel, text);
  writeFile(root, 'docs/README.md', '# doc\n');
  if (registry !== null) {
    writeFile(root, IDENTITY_REGISTRY, typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2) + '\n');
  }
  return root;
}

const digestOf = (root) => computeRuntimeDigest({ root }).digest;
const registryWith = (root, entries) => ({ schema: 1, family: IDENTITY_FAMILY, algorithm: 'x', entries });

describe('IDENTITY 规则目录', () => {
  it('ID1/ID2 两条，family/severity/layer 稳定', () => {
    expect(IDENTITY_RULES.map((r) => r.id)).toEqual(['ID1', 'ID2']);
    expect(IDENTITY_RULES.every((r) => r.family === IDENTITY_FAMILY && r.severity === 'error' && r.layer === 'identity')).toBe(true);
    expect(IDENTITY_RULE_BY_ID.ID1.title).toContain('一物一号');
    expect(IDENTITY_RULE_BY_ID.ID2.title).toContain('号可验');
    expect(IDENTITY_RULES.every((r) => r.description.length > 20 && typeof r.source === 'string')).toBe(true);
  });
});

describe('ID1 · 一物一号（正/反例）', () => {
  it('正例：每个版本唯一摘要 ⇒ ok=true、无 finding', () => {
    const root = makeTree();
    const d = digestOf(root);
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: d }]), null, 2) + '\n');
    const rep = checkIdentity({ root });
    expect(rep.ok).toBe(true);
    expect(rep.findings).toEqual([]);
  });

  it('反例：同一版本登记两个不同摘要 ⇒ ID1 红，证据带 file:line（指向第二个条目）', () => {
    const root = makeTree();
    const d = digestOf(root);
    const text = JSON.stringify(registryWith(root, [
      { version: '1.0.0', digest: d },
      { version: '1.0.0', digest: 'sha256:deadbeefdeadbeef' },
    ]), null, 2) + '\n';
    writeFile(root, IDENTITY_REGISTRY, text);
    const rep = checkIdentity({ root });
    expect(rep.ok).toBe(false);
    const id1 = rep.findings.filter((f) => f.id === 'ID1');
    expect(id1).toHaveLength(1);
    expect(id1[0].file).toBe(IDENTITY_REGISTRY);
    // file:line 证据：行号必须指向登记表里**第二个**同版本条目
    const lines = text.split('\n');
    const versionLines = lines.map((l, i) => (l.includes('"1.0.0"') ? i + 1 : null)).filter(Boolean);
    expect(versionLines).toHaveLength(2);
    expect(id1[0].line).toBe(versionLines[1]);
    expect(id1[0].message).toContain('两个不同内容摘要');
  });

  it('反例（防噪音）：重复登记但摘要相同 ⇒ 不报 ID1', () => {
    const root = makeTree();
    const d = digestOf(root);
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith(root, [
      { version: '1.0.0', digest: d },
      { version: '1.0.0', digest: d },
    ]), null, 2) + '\n');
    const rep = checkIdentity({ root });
    expect(rep.findings.filter((f) => f.id === 'ID1')).toEqual([]);
    expect(rep.ok).toBe(true);
  });
});

describe('ID2 · 号可验（正/反例）', () => {
  it('正例：声明版本 ↔ 登记摘要 ↔ 实算摘要一致 ⇒ ok=true', () => {
    const root = makeTree();
    const d = digestOf(root);
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: d }]), null, 2) + '\n');
    const rep = checkIdentity({ root });
    expect(rep.ok).toBe(true);
    expect(rep.digest).toBe(d);
    expect(rep.version).toBe('1.0.0');
    expect(rep.runtime.files).toBe(3);
  });

  it('反例（防噪音）：只改文档，不改运行时代码、不动号 ⇒ 必须绿', () => {
    const root = makeTree();
    const d = digestOf(root);
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: d }]), null, 2) + '\n');
    writeFile(root, 'docs/README.md', '# doc（只改文档）\n');
    writeFile(root, 'docs/extra.md', 'new doc\n');
    const rep = checkIdentity({ root });
    expect(rep.ok).toBe(true);
    expect(rep.digest).toBe(d); // 运行身份不变
  });

  it('反例（硬）：同号改代码、登记摘要未更新 ⇒ ID2 红（证据 file:line）', () => {
    const root = makeTree();
    const d = digestOf(root);
    const text = JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: d }]), null, 2) + '\n';
    writeFile(root, IDENTITY_REGISTRY, text);
    writeFile(root, 'lib/a.js', 'export const a = 999; // 同号改代码\n');
    const rep = checkIdentity({ root });
    expect(rep.ok).toBe(false);
    const id2 = rep.findings.find((f) => f.id === 'ID2');
    expect(id2).toBeTruthy();
    expect(id2.file).toBe(IDENTITY_REGISTRY);
    const lines = text.split('\n');
    const versionLine = lines.findIndex((l) => l.includes('"1.0.0"')) + 1;
    expect(id2.line).toBe(versionLine);
    expect(id2.message).toContain('登记摘要 ≠ 产物实算摘要');
    expect(id2.extra.registeredDigest).toBe(d);
    expect(id2.extra.computedDigest).not.toBe(d);
  });

  it('反例（伪造）：登记摘要与产物实算不符 ⇒ ID2 红', () => {
    const root = makeTree();
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: 'sha256:forged' }]), null, 2) + '\n');
    const rep = checkIdentity({ root });
    expect(rep.findings.some((f) => f.id === 'ID2')).toBe(true);
  });

  it('反例：声明版本未登记 ⇒ ID2 红，证据指向 package.json 的 version 行', () => {
    const root = makeTree({ version: '9.9.9' });
    writeFile(root, IDENTITY_REGISTRY, JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: 'sha256:x' }]), null, 2) + '\n');
    const rep = checkIdentity({ root });
    const id2 = rep.findings.find((f) => f.id === 'ID2');
    expect(id2).toBeTruthy();
    expect(id2.file).toBe('package.json');
    expect(id2.line).toBe(lineOfOccurrence(path.join(root, 'package.json'), '"version"'));
    expect(id2.message).toContain('没有摘要条目');
  });
});

describe('unverifiable / 坏登记表（不冒充通过、不误报）', () => {
  it('登记表缺失（npm 安装包形态）⇒ ok=null（unverifiable），不产生红项', () => {
    const root = makeTree(); // 不写登记表
    const rep = checkIdentity({ root });
    expect(rep.ok).toBeNull();
    expect(rep.findings).toEqual([]);
    expect(rep.registry.present).toBe(false);
    expect(rep.note).toContain('unverifiable');
  });

  it('登记表坏 JSON ⇒ ok=false + ID2（不静默）', () => {
    const root = makeTree();
    writeFile(root, IDENTITY_REGISTRY, '{ not json');
    const rep = checkIdentity({ root });
    expect(rep.ok).toBe(false);
    expect(rep.findings.some((f) => f.id === 'ID2')).toBe(true);
  });

  it('readIdentityRegistry：条目 line 与文件一致', () => {
    const root = makeTree();
    const d = digestOf(root);
    const text = JSON.stringify(registryWith(root, [{ version: '1.0.0', digest: d }, { version: '0.9.0', digest: 'sha256:y' }]), null, 2) + '\n';
    writeFile(root, IDENTITY_REGISTRY, text);
    const reg = readIdentityRegistry({ root });
    expect(reg.present).toBe(true);
    expect(reg.entries).toHaveLength(2);
    expect(reg.entries[0].line).toBe(text.split('\n').findIndex((l) => l.includes('"1.0.0"')) + 1);
    expect(reg.entries[1].line).toBe(text.split('\n').findIndex((l) => l.includes('"0.9.0"')) + 1);
  });
});

describe('集成：check --json 的 identity 段 + schemaVersion', () => {
  it('当前仓：identity 段存在、identity.ok=true、schemaVersion=3，既有键不破坏', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-identity-cli-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1 }) + '\n');
    const res = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(res.stdout);
    expect(payload.schemaVersion).toBe('3');
    // 既有键（不破坏）
    for (const k of ['ok', 'assessable', 'assessmentScope', 'host', 'support', 'migration', 'summary', 'violations']) {
      expect(Object.hasOwn(payload, k), `既有键 ${k} 丢了`).toBe(true);
    }
    // identity 段
    expect(payload.identity.family).toBe(IDENTITY_FAMILY);
    expect(payload.identity.registry.file).toBe(IDENTITY_REGISTRY);
    expect(payload.identity.registry.present).toBe(true);
    expect(payload.identity.rules.map((r) => r.id)).toEqual(['ID1', 'ID2']);
    expect(payload.identity.version).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    expect(payload.identity.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 当前仓登记表必须与产物一致（发布前"号可验"的仓内自检）
    expect(payload.identity.findings, `identity findings: ${JSON.stringify(payload.identity.findings)}`).toEqual([]);
    expect(payload.identity.ok).toBe(true);
  });
});
