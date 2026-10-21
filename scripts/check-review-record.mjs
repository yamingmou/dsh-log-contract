#!/usr/bin/env node
/**
 * 独立审核记录闸（independent review gate）
 *
 * 制度：任何版本发布前，必须有**一份独立审核记录**，且审核者 ≠ 作者。
 * 记录文件：reviews/<version>.json
 *   { "version":"0.3.20", "author":"OfferKuai Team", "reviewer":"<独立者>",
 *     "verdict":"pass", "date":"2026-10-20", "evidence":["<命令/读数/链接>", ...],
 *     "scope":["lib/**","tests"] }
 * 用法：node scripts/check-review-record.mjs [--allow-missing] [--pre-release]
 *   --allow-missing  仅供 bootstrap：缺记录不判 FAIL（内容不合规仍 FAIL）
 *   --pre-release    发布前自检：缺记录 ⇒ WARN/exit 0（记录存在但内容不合规仍 FAIL）；
 *                    正式发布（默认）缺记录 ⇒ FAIL/exit 1
 * 退出码：0 通过（含 --pre-release 的"待发布补齐"WARN） / 1 缺失或不合规
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const allowMissing = process.argv.includes('--allow-missing')
const PRE_RELEASE = process.argv.includes('--pre-release')  // 发布模式：缺记录 = FAIL；开发模式 = 提示（exit 0）
const preRelease = process.argv.includes('--pre-release')
const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const file = join(root, 'reviews', `${version}.json`)
const problems = []

if (!existsSync(file)) {
  problems.push(`缺少独立审核记录：reviews/${version}.json`)
} else {
  let r
  try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { problems.push(`审核记录不是合法 JSON：${e.message}`) }
  if (r) {
    if (r.version !== version) problems.push(`记录版本 ${r.version} ≠ 当前版本 ${version}`)
    if (!r.reviewer) problems.push('缺少 reviewer')
    if (!r.author) problems.push('缺少 author')
    if (r.reviewer && r.author && String(r.reviewer).trim().toLowerCase() === String(r.author).trim().toLowerCase())
      problems.push('reviewer 与 author 相同 —— 不构成独立审核')
    if (String(r.verdict || '').toLowerCase() !== 'pass') problems.push(`verdict 必须为 "pass"（实际 ${r.verdict ?? '缺失'}）`)
    if (!Array.isArray(r.evidence) || r.evidence.length === 0) problems.push('evidence 必须是非空数组（命令/读数/链接）')
    if (!r.date) problems.push('缺少 date')
    // 绑定 gitHead：记录必须指向当前 HEAD（防止"改完代码再说已审过"）
    try {
      const { execFileSync } = await import('node:child_process')
      const head = execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      if (!r.gitHead) problems.push('缺少 gitHead（必须绑定被审的提交）')
      else if (r.gitHead !== head) problems.push(`gitHead 不匹配：记录 ${String(r.gitHead).slice(0,8)} ≠ HEAD ${head.slice(0,8)}`)
    } catch { problems.push('无法读取 HEAD（无法绑定）') }
    // reviewer 不能是占位/数字
    if (r.reviewer && (/^[xX]+$/.test(String(r.reviewer)) || /^\d+$/.test(String(r.reviewer)))) problems.push('reviewer 像占位值（x/number）')
    // 证据必须像可复算的命令
    if (Array.isArray(r.evidence)) {
      const CMD = /^(node |npx |pnpm |npm |git |curl |gh )/
      const ok = r.evidence.every((e) => typeof e === 'string' && CMD.test(e.trim()))
      if (!ok) problems.push('evidence 每条必须以命令开头（node/npx/pnpm/npm/git/curl/gh），不接受描述性文字')
    }
  }
}
const missingOnly = problems.length > 0 && problems.every((p) => p.startsWith('缺少独立审核记录'))
const mustFill = `发布前必须补齐 reviews/${version}.json（reviewer≠author、gitHead=HEAD、evidence 为可复算命令）`

// 发布前自检：缺记录只是"待补齐"，不判 FAIL；记录存在但内容不合规仍按上面的 problems 判 FAIL。
if (missingOnly && preRelease) {
  console.log(`review-record: ⚠️ 待发布补齐 —— 缺 reviews/${version}.json（--pre-release：本次不判 FAIL）`)
  console.log(`  ⇒ ${mustFill}`)
  process.exit(0)
}
if (missingOnly && allowMissing) {
  console.log('review-record: ⚠️ 缺少审核记录，但 --allow-missing 已允许（仅限 bootstrap）')
  process.exit(0)
}
if (problems.length) {
  for (const p of problems) console.log(`  ✗ ${p}`)
  if (missingOnly) console.log(`  ⇒ ${mustFill}`)
  console.log(`review-record: 未通过（版本 ${version}）`)
  process.exit(1)
}
console.log(`review-record: ok —— ${version} 有独立审核记录（reviewer=${JSON.parse(readFileSync(file,'utf8')).reviewer}）`)
