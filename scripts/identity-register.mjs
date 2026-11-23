#!/usr/bin/env node
/**
 * scripts/identity-register.mjs —— IDENTITY 登记表工具（ID2「号可验」的发布前一步）
 *
 * 作用：由**产物**实算运行身份摘要（`lib/**\/*.js` + `bin/**\/*.mjs` 逐文件 sha256 →
 * 按路径排序后再 sha256），写入 `docs/identity-registry.json` 的 `版本 → 摘要` 条目。
 *
 * 用法：
 *   node scripts/identity-register.mjs            # 版本取 package.json
 *   node scripts/identity-register.mjs 0.3.38     # 显式版本
 *   node scripts/identity-register.mjs --print    # 只打印实算摘要（不写盘）
 *
 * 纪律：
 * - **只登记运行身份**：改文档/测试/机制件不会改变摘要（= ID2 的"防噪音"反例）；
 * - **同号改代码必须换号并重登记**——直接用生产摘要覆盖旧条目会让 ID2 变绿，但那
 *   意味着"同一版本号对应了第二份内容"；因此本工具在检测到**同号摘要不一致**时
 *   会先打印警告（ID1 视角），仍按显式指令覆盖（发布流程必须换号，不要靠覆盖蒙混）；
 * - 反例（必须红）：登记旧摘要/伪造摘要 ⇒ `check --json` 的 `identity.findings` 出 ID2。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRuntimeDigest, IDENTITY_REGISTRY } from '../lib/identity.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registryPath = path.join(ROOT, IDENTITY_REGISTRY);
const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const versionArg = argv.find((a) => !a.startsWith('-'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = versionArg ?? pkg.version;
if (!version || typeof version !== 'string') {
  console.error(`identity-register: 无法确定版本（argv=${JSON.stringify(versionArg)}，package.json.version=${JSON.stringify(pkg.version)}）`);
  process.exit(1);
}

const { digest, files } = computeRuntimeDigest({ root: ROOT });
if (printOnly) {
  console.log(JSON.stringify({ version, digest, files: files.length, registry: IDENTITY_REGISTRY }, null, 2));
  process.exit(0);
}

const registry = fs.existsSync(registryPath)
  ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  : {
    schema: 1,
    family: 'version-identity',
    algorithm: 'sha256( sorted(path+sha256(file)) over lib/**/*.js + bin/**/*.mjs )',
    note: 'IDENTITY 契约登记表：版本 → 运行时代码内容摘要（只含运行身份；文档/测试/机制件不计入）。发布前必须把由产物实算的摘要登记进来（ID2）；同一版本不得出现两个不同摘要（ID1）。本文件随仓入库，但 npm 只打包 docs/**/*.md ⇒ 安装包内不含本表（identity 为 unverifiable）。',
    entries: [],
  };
if (!Array.isArray(registry.entries)) registry.entries = [];

const existing = registry.entries.filter((e) => e.version === version);
if (existing.length > 1) {
  console.warn(`identity-register: ⚠️ 登记表里 ${version} 已有 ${existing.length} 条（ID1 视角）；本工具只更新第一条，其余请人工清理`);
}
if (existing.length > 0 && existing[0].digest !== digest) {
  console.warn(`identity-register: ⚠️ 同号摘要变化：${version} 登记 ${existing[0].digest} → 实算 ${digest}。`
    + ' 语义上这是"同一版本号对应了第二份内容"——发布流程应先换号（换号 + 重登记），不要靠覆盖蒙混（ID1/ID2 会指认）。');
}

if (existing.length > 0) {
  existing[0].digest = digest;
  existing[0].note = existing[0].note ?? '';
} else {
  registry.entries.push({
    version,
    digest,
    note: '由 scripts/identity-register.mjs 登记（运行身份 = lib/**/*.js + bin/**/*.mjs 清单 hash）',
  });
}

fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`identity-register: ✅ ${IDENTITY_REGISTRY} ← ${version} ${digest}（${files.length} 个运行时文件）`);
