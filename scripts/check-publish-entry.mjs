#!/usr/bin/env node
/**
 * 发布入口闸（check-publish-entry）—— 防止"绕过 release.mjs 直接 npm publish"
 *
 * 方法（机械）：
 *  E1 package.json 的 scripts 里，除 release.mjs 外任何脚本不得直接调用 `npm publish`
 *  E2 .github/workflows/*.yml 里不得出现裸 `npm publish`（必须走 release.mjs 或显式门禁）
 *  E3 release.mjs 必须存在且调用 pre-publish.mjs（单一事实源）
 * 退出码：0 通过 / 1 违规 / 2 无法判定
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const problems = []
// E1
for (const [k, v] of Object.entries(pkg.scripts || {})) {
  if (typeof v !== 'string') continue
  if (/npm\s+publish/.test(v) && !/release\.mjs/.test(v)) problems.push(`E1 scripts.${k} 直接调用 npm publish：${v.slice(0, 80)}`)
}
// E2
const wfDir = join(ROOT, '.github', 'workflows')
if (existsSync(wfDir)) {
  for (const f of readdirSync(wfDir)) {
    const t = readFileSync(join(wfDir, f), 'utf8')
    if (/npm\s+publish/.test(t) && !/release\.mjs|PREPUBLISH_GATED/.test(t)) problems.push(`E2 .github/workflows/${f} 裸 npm publish（未见 release.mjs 门禁）`)
  }
}
// E3
const rel = join(ROOT, 'scripts', 'release.mjs')
if (!existsSync(rel)) problems.push('E3 缺 scripts/release.mjs')
else if (!/pre-publish\.mjs/.test(readFileSync(rel, 'utf8'))) problems.push('E3 release.mjs 未调用 pre-publish.mjs（不是单一事实源）')

console.log(`publish-entry: 检查 scripts(${Object.keys(pkg.scripts || {}).length}) + workflows ｜ 违规 ${problems.length}`)
for (const p of problems) console.log(`  ✗ ${p}`)
if (!problems.length) console.log('publish-entry: ok —— 发布只能经 release.mjs')
process.exit(problems.length ? 1 : 0)
