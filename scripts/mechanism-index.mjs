#!/usr/bin/env node
/**
 * 机制方法手册生成器（mechanism index）
 *
 * 方法：扫描 scripts/*.mjs，从文件头注释抽取「用途 / 用法 / 退出码」，生成 markdown 方法表。
 * 目的：**文档由脚本自身生成**，避免"文档写了、脚本没有/反之"的漂移。
 * 用法：node scripts/mechanism-index.mjs [--out <文件>]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, 'internal', '机制方法手册-v3.md')

const rows = []
for (const f of readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).sort()) {
  const text = readFileSync(join(ROOT, 'scripts', f), 'utf8')
  const head = text.slice(0, 3000)
  const title = (head.match(/^\s*\*\s*(.+)$/m) || [, f])[1].trim()
  const usage = (head.match(/用法[:：]\s*(.+)/) || [, '-'])[1].trim()
  const codes = (head.match(/退出码[:：]\s*(.+)/) || [, '-'])[1].trim()
  rows.push({ f, title, usage, codes })
}
const md = [
  '# 机制方法手册 v3（由 scripts/mechanism-index.mjs 自动生成）',
  '',
  '> 原则：**文档不手写**。这份表由脚本从各文件头注释生成，避免"文档写了脚本没有 / 脚本改了文档没改"。',
  '',
  '| 脚本 | 方法（用途） | 用法 | 退出码 |',
  '|---|---|---|---|',
  ...rows.map((r) => `| \`scripts/${r.f}\` | ${r.title} | \`${r.usage}\` | ${r.codes} |`),
  '',
  '## 发布前流程（pre-publish 顺序）',
  '',
  '```',
  '工作区干净 → 锁文件一致 → 发版纪律 → 对外信息(发布集) → GitHub 面 → 闸负对照自检',
  '→ 独立审核记录 → 包元数据 → 语法 → 契约文档一致 → 全量测试 → CHANGELOG → 版本未发布 → 审核记录内容',
  '```',
  '',
  '## 发布流程 SOP',
  '',
  '1. 功能/修复完成，测试与负对照齐备；',
  '2. `node scripts/pre-publish.mjs` ⇒ 必须全绿（报告落 `internal/release-reports/`）；',
  '3. 独立审核者复核 ⇒ 写 `reviews/<version>.json`（reviewer≠author、verdict=pass、evidence 可复算）；',
  '4. `node scripts/release.mjs`（唯一入口）⇒ 发布 + 发布后 tarball 复验；',
  '5. 发布后：registry 读数、tarball 内容、对外面复扫三项留痕。',
  '',
].join('\n')
writeFileSync(OUT, md)
console.log(`mechanism-index: 生成 ${rows.length} 条方法 → ${OUT.replace(ROOT + '/', '')}`)
