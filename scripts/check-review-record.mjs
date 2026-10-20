#!/usr/bin/env node
/**
 * 独立审核记录闸（independent review gate）
 *
 * 制度：任何版本发布前，必须有**一份独立审核记录**，且审核者 ≠ 作者。
 * 记录文件：reviews/<version>.json
 *   { "version":"0.3.20", "author":"OfferKuai Team", "reviewer":"<独立者>",
 *     "verdict":"pass", "date":"2026-10-20", "evidence":["<命令/读数/链接>", ...],
 *     "scope":["lib/**","tests"] }
 * 用法：node scripts/check-review-record.mjs [--allow-missing]（--allow-missing 仅供 bootstrap）
 * 退出码：0 通过 / 1 缺失或不合规
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const allowMissing = process.argv.includes('--allow-missing')
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
  }
}
if (problems.length && allowMissing && problems.every((p) => p.startsWith('缺少独立审核记录'))) {
  console.log('review-record: ⚠️ 缺少审核记录，但 --allow-missing 已允许（仅限 bootstrap）')
  process.exit(0)
}
if (problems.length) { for (const p of problems) console.log(`  ✗ ${p}`); console.log(`review-record: 未通过（版本 ${version}）`); process.exit(1) }
console.log(`review-record: ok —— ${version} 有独立审核记录（reviewer=${JSON.parse(readFileSync(file,'utf8')).reviewer}）`)
