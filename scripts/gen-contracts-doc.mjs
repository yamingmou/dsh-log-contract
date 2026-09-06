#!/usr/bin/env node
/**
 * 从 lib/contracts.js 的 CONTRACT_RULES 注册表自动生成 docs/CONTRACTS.md。
 *
 * 背景（2026-09-06）：docs/CONTRACTS.md 曾手工维护到 S8/M1/P2，滞后于 README
 * 宣传与实际注册（S9/T1-T5/I1/W1/W2/P3/P4 共 15+ 条缺失）——外部审计指出
 * "README 说 30+ 条，文档只落地一部分"。本脚本保证规则文档与注册表同步：
 * 规则只增不减时，跑一次即刷新；新增规则后 CI/发版前跑一次。
 *
 * 用法：node scripts/gen-contracts-doc.mjs（输出覆盖 docs/CONTRACTS.md）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// contracts.js 是 ESM：用动态 import 读注册表（脚本自身也是 ESM）。
const contracts = await import(`file://${join(root, 'lib/contracts.js')}`)
const rules = contracts.CONTRACT_RULES

const SEV = { error: 'error', warning: 'warning', info: 'info' }
const layerLabel = (l) => (typeof l === 'string' ? l : String(l ?? '?'))

// ── 索引表 ────────────────────────────────────────────────────────────────
const indexRows = rules
  .map((r) => `| ${r.id} | ${r.severity} | ${layerLabel(r.layer)} | ${r.title} |`)
  .join('\n')

// ── 详细规则 ───────────────────────────────────────────────────────────────
const details = rules
  .map((r) => {
    return `### ${r.id} — ${r.title}

- **层级**: ${layerLabel(r.layer)} ｜ **严重度**: ${r.severity}
- **出处**: ${r.source ?? '(未标注)'}
- **契约**: ${r.description ?? '(未描述)'}
`
  })
  .join('\n')

const doc = `# 契约规则目录（CONTRACTS）

> **自动生成**（2026-09-06 起）：本文件由 \`node scripts/gen-contracts-doc.mjs\`
> 从 \`lib/contracts.js\` 的 \`CONTRACT_RULES\` 注册表生成——**勿手改**，规则只增不减，
> 新增规则后跑一次生成即同步（此前手工维护滞后 15+ 条，外部审计指出）。
>
> DSH 会话日志契约的**可执行 spec**。每条规则在 \`lib/checks.js\`（逐事件判定）
> 与 \`lib/prewrite.js\`（写前校验）中有对应实现；离线体检（\`lib/validate.js\`）
> 逐条执行并在最后用官方 \`foldSurface\` 终验（S8）。
>
> 规则来源：\`dsh-scale-audit-疑点记录.md\`（59 条审计发现）+ \`复盘-会话修复事故-20260825.md\`
> （三层契约）+ \`@deepseek-ai/dsh-session@0.1.0-rc.7\` 官方源码逐行核对
> （后续规则随官方版本演进追加：T3/T4 渲染层 = 1e99e1ff 复盘，T5 = 1f4d986e malformed）。
>
> 严重度：**error** = 违反即会话不可加载/写入被拒（fail-loud）；**warning** = 合法但可疑。

## 规则索引（共 ${rules.length} 条）

| id | 严重度 | 层级 | 规则 |
|---|---|---|---|
${indexRows}

## 详细规则

${details}
`
writeFileSync(join(root, 'docs/CONTRACTS.md'), doc)
console.log(`✅ generated docs/CONTRACTS.md（${rules.length} 条规则）`)
