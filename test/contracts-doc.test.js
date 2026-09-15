/**
 * dsh-log-contract · test/contracts-doc.test.js
 *
 * **契约文档漂移闸的回归**（2026-09-15）。
 *
 * 背景：`docs/CONTRACTS.md` 由 `scripts/gen-contracts-doc.mjs` 从 `lib/contracts.js` 的
 * `CONTRACT_RULES` 注册表生成——**它是 tracked 的公开文档**。此前生成器没接进
 * `check`/`prepublishOnly`，于是"文档与注册表一致"只靠人记得跑，没有机制保证。
 *
 * 本文件把两件事钉死：
 *   ① **一致**：`buildContractsDoc(CONTRACT_RULES)` 必须与仓库里的 `docs/CONTRACTS.md` 逐字节相同；
 *   ② **非空转**：改动任意一条规则的可见字段 ⇒ 产物必须随之改变（否则这条闸门是死的）。
 * 配套：`pnpm check` 里跑 `node scripts/gen-contracts-doc.mjs --check`（同一实现的 CLI 形态）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContractsDoc, diffLines } from '../scripts/gen-contracts-doc.mjs'
import { CONTRACT_RULES } from '../lib/contracts.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const docPath = join(root, 'docs', 'CONTRACTS.md')

describe('契约文档漂移闸 —— docs/CONTRACTS.md 必须与注册表一致', () => {
  it('生成的文档与仓库里的 docs/CONTRACTS.md 逐字节相同（改了注册表没重生成 ⇒ 这里红）', () => {
    const onDisk = readFileSync(docPath, 'utf8')
    const generated = buildContractsDoc(CONTRACT_RULES)
    // 失败时给出**行号**而不是一团全文,便于直接定位漂移
    expect(diffLines(onDisk, generated), 'docs/CONTRACTS.md 与 lib/contracts.js 注册表漂移：跑 node scripts/gen-contracts-doc.mjs').toEqual([])
    expect(onDisk).toBe(generated)
  })

  it('索引行数与注册表条数一致（防止"文档只落地一部分"的历史问题复发）', () => {
    const onDisk = readFileSync(docPath, 'utf8')
    expect(onDisk).toContain(`## 规则索引（共 ${CONTRACT_RULES.length} 条）`)
    const rows = onDisk.split('\n').filter((l) => /^\| [A-Za-z]/.test(l) && !l.startsWith('| id '))
    expect(rows).toHaveLength(CONTRACT_RULES.length)
  })

  it('非空转：改动任意一条规则的可见字段 ⇒ 产物必须改变（否则闸门是死的）', () => {
    const mutated = CONTRACT_RULES.map((r, i) => (i === 0 ? { ...r, title: `${r.title}（注入）` } : r))
    const before = buildContractsDoc(CONTRACT_RULES)
    const after = buildContractsDoc(mutated)
    expect(after).not.toBe(before)
    expect(diffLines(before, after).length).toBeGreaterThan(0)
    // 且改动的是**人看得见**的地方(索引行 + 详细块标题)
    expect(after).toContain('（注入）')
  })
})
