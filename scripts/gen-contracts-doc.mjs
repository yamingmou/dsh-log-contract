#!/usr/bin/env node
/**
 * 从 lib/contracts.js 的 CONTRACT_RULES 注册表自动生成 docs/CONTRACTS.md。
 *
 * 背景（2026-09-06）：docs/CONTRACTS.md 曾手工维护到 S8/M1/P2，滞后于 README
 * 宣传与实际注册（S9/T1-T5/I1/W1/W2/P3/P4 共 15+ 条缺失）——外部审计指出
 * "README 说 30+ 条，文档只落地一部分"。本脚本保证规则文档与注册表同步。
 *
 * **漂移闸（2026-09-15 独立复验 ⚠️ 项）**：此前本脚本**没接进** `check`/`prepublishOnly`，
 * 于是 docs/CONTRACTS.md 与注册表的一致性**靠手工**（复验实测当时一致，但无机制保证）。
 * 现在 `--check` 是**幂等校验**：重生成到内存 → 与现行文件**逐字节比对** → 不一致即非 0 退出。
 *   · `node scripts/gen-contracts-doc.mjs`          生成/覆盖
 *   · `node scripts/gen-contracts-doc.mjs --check`  只校验（`pnpm check` 与 `prepublishOnly` 走这条）
 * `buildContractsDoc()` 是纯函数（rules → 文本），既供 CLI、也供单测直接比对，
 * 这样"改一条规则文本 ⇒ 文档失配 ⇒ 红"能被用例钉死，而不是靠人记得跑。
 *
 * 用法：
 *   node scripts/gen-contracts-doc.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const TARGET = 'docs/CONTRACTS.md'

const layerLabel = (l) => (typeof l === 'string' ? l : String(l ?? '?'))

/**
 * 纯函数：注册表 → docs/CONTRACTS.md 全文。
 * 与文件系统无关，方便单测做"同一份 rules 必须产出同一份文本"的幂等/漂移断言。
 * @param {ReadonlyArray<object>} rules CONTRACT_RULES
 * @returns {string}
 */
export function buildContractsDoc(rules) {
  // ── 索引表 ──────────────────────────────────────────────────────────────
  const indexRows = rules
    .map((r) => `| ${r.id} | ${r.severity} | ${layerLabel(r.layer)} | ${r.title} |`)
    .join('\n')

  // ── 详细规则 ─────────────────────────────────────────────────────────────
  const details = rules
    .map((r) => {
      return `### ${r.id} — ${r.title}

- **层级**: ${layerLabel(r.layer)} ｜ **严重度**: ${r.severity}
- **出处**: ${r.source ?? '(未标注)'}
- **契约**: ${r.description ?? '(未描述)'}
`
    })
    .join('\n')

  return `# 契约规则目录（CONTRACTS）

> **自动生成**（2026-09-06 起）：本文件由 \`node scripts/gen-contracts-doc.mjs\`
> 从 \`lib/contracts.js\` 的 \`CONTRACT_RULES\` 注册表生成——**勿手改**，规则只增不减，
> 新增规则后跑一次生成即同步（此前手工维护滞后 15+ 条，外部审计指出）。
> **漂移闸**：\`pnpm check\` 会跑 \`--check\` 逐字节比对，改了注册表没重生成 ⇒ 直接红。
>
> DSH 会话日志契约的**可执行 spec**。每条规则在 \`lib/checks.js\`（逐事件判定）
> 与 \`lib/prewrite.js\`（写前校验）中有对应实现；离线体检（\`lib/validate.js\`）
> 逐条执行并在最后用官方 \`foldSurface\` 终验（S8）。
>
> 规则来源：早期内部审计发现（59 条）+ 三层契约事故复盘 + 官方源码逐行核对
> （\`@deepseek-ai/dsh-session\`，各条出处见下）。后续规则随官方版本演进追加：
> T3/T4 = 渲染层白屏事故复盘，T5 = malformed turn/end 事故复盘。
>
> **版本支持基线（本规则集验证过的版本；权威常量见 \`lib/version-support.js\` 的 TESTED_BASELINE）**：
> 宿主 \`@deepseek-ai/dsh-session@0.1.5-rc.1\` ｜ 会话格式 **v3**（\`SESSION_FORMAT_VERSION = 3\`）｜
> 声明范围 \`^0.1.0-rc.7 || ^0.1.5-rc.1\`（可安装 ≠ 逐个验证）｜ 已知格式 0/1/2/3
> （0–2 由本包自带 vendored 词表 + \`legacyFoldSurface\` 支持，与宿主版本无关）。
> **未验证版本**：宿主比基线新 → 运行时告警；文件格式未知/无法识别 → 报"未验证格式"并**按只读处理**
> （\`prewrite\`/\`fix\` 拒绝，退出码 3）；文件版本 > 宿主上限 → \`not-assessable\`（不是 broken）。
>
> 严重度：**error** = 违反即会话不可加载/写入被拒（fail-loud）；**warning** = 合法但可疑。

## 规则索引（共 ${rules.length} 条）

| id | 严重度 | 层级 | 规则 |
|---|---|---|---|
${indexRows}

## 详细规则

${details}
`
}

/** 比对两份文本，返回不同行号（1-based）。 */
export function diffLines(current, expected) {
  const a = current.split('\n')
  const b = expected.split('\n')
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i + 1)
  return out
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === entry
  } catch {
    return false
  }
})()

if (isMain) {
  const contracts = await import(`file://${join(root, 'lib/contracts.js')}`)
  const rules = contracts.CONTRACT_RULES
  const doc = buildContractsDoc(rules)
  const target = join(root, TARGET)
  const check = process.argv.includes('--check')

  if (!check) {
    writeFileSync(target, doc)
    console.log(`✅ generated ${TARGET}（${rules.length} 条规则）`)
    process.exit(0)
  }

  let current = null
  try { current = readFileSync(target, 'utf8') } catch { /* 缺文件 = 不一致 */ }
  if (current === doc) {
    console.log(`✅ ${TARGET} 与注册表一致（${rules.length} 条规则）`)
    process.exit(0)
  }
  const diffs = current === null ? [] : diffLines(current, doc)
  console.log(`❌ ${TARGET} 与 lib/contracts.js 的注册表**不一致**（${rules.length} 条规则）`
    + (current === null ? '：文件缺失' : `：${diffs.length} 行不同`))
  if (current !== null) {
    const a = current.split('\n')
    const b = doc.split('\n')
    for (const l of diffs.slice(0, 10)) {
      console.log(`    行 ${l}:`)
      if (a[l - 1] !== undefined) console.log(`      - ${a[l - 1].slice(0, 140)}`)
      if (b[l - 1] !== undefined) console.log(`      + ${b[l - 1].slice(0, 140)}`)
    }
    if (diffs.length > 10) console.log(`    … 另有 ${diffs.length - 10} 行`)
  }
  console.log('    修法：node scripts/gen-contracts-doc.mjs')
  process.exit(1)
}
