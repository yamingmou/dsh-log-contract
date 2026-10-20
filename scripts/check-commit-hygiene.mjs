#!/usr/bin/env node
/**
 * 提交卫生闸（commit hygiene gate）
 *
 * 方法（逐条机械判定，全部可复核）：
 *   H1 空提交：某提交与其父树相同 ⇒ 违规（禁止空提交）
 *   H2 提交信息含内部词：从 internal/wordlist.json 取词，命中 ⇒ 违规
 *   H3 "改-撤"来回：同一文件在最近 N 个提交里先出现 `revert:`/`恢复…` 且紧邻前提交含 `中性化/清理` 类操作 ⇒ 告警
 *   H4 提交信息过空：subject 少于 6 字符或 body 与 subject 相同 ⇒ 告警
 * 用法：node scripts/check-commit-hygiene.mjs [--range origin/main..HEAD] [--json]
 * 退出码：0 通过 / 1 违规 / 2 无法判定
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const rangeIdx = argv.indexOf('--range')
const range = rangeIdx >= 0 ? argv[rangeIdx + 1] : 'origin/main..HEAD'
const asJson = argv.includes('--json')
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

const wl = JSON.parse(readFileSync(join(ROOT, 'internal', 'wordlist.json'), 'utf8'))
const words = Object.entries(wl).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => v)
if (words.length < 20) { console.error('commit-hygiene: 无法判定 —— 词表异常'); process.exit(2) }
const RE = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')

let commits
try {
  // 记录分隔用 \x1e（body 可含换行）；字段分隔 \x1f
  commits = git('log', '--format=%H%x1f%s%x1f%b%x1e', range).split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean)
} catch (e) { console.error('commit-hygiene: 无法判定 ——', e.message); process.exit(2) }
if (!commits.length) { console.log(`commit-hygiene: 区间 ${range} 无提交（没有要公开的提交）⇒ ok`); process.exit(0) }

const fail = [], warn = []
let prevSubject = ''
for (const line of commits.slice().reverse()) {
  const [sha, subject = '', body = ''] = line.split('\x1f')
  const short = sha.slice(0, 8)
  // H1 空提交
  try {
    const parent = git('rev-parse', `${sha}^`).trim()
    if (git('rev-parse', `${sha}^{tree}`).trim() === git('rev-parse', `${parent}^{tree}`).trim()) fail.push(`H1 空提交 ${short} ${subject.slice(0, 50)}`)
  } catch { /* 根提交 */ }
  // H2 内部词
  const hit = (subject + ' ' + body).match(RE)
  if (hit) fail.push(`H2 提交信息含内部词 ${short}: ${[...new Set(hit)].slice(0, 4).join(',')}`)
  // H4 过空
  if (subject && subject.trim().length < 6) warn.push(`H4 subject 过短 ${short}: "${subject}"`)
  // H3 改-撤来回
  if (/^revert:|恢复|重新中性化/.test(subject) && /中性化|清理|去掉|移除/.test(prevSubject)) warn.push(`H3 改-撤来回 ${short}: "${prevSubject.slice(0, 32)}" → "${subject.slice(0, 32)}"`)
  prevSubject = subject
}
const result = { ok: fail.length === 0, range, commits: commits.length, fail, warn }
if (asJson) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`commit-hygiene: 区间 ${range} ｜ 提交 ${commits.length} ｜ 违规 ${fail.length} ｜ 告警 ${warn.length}`)
  for (const f of fail.slice(0, 10)) console.log(`  ✗ ${f}`)
  for (const w of warn.slice(0, 6)) console.log(`  · ${w}`)
  if (!fail.length) console.log('commit-hygiene: ok —— 无空提交/无内部词提交信息')
}
process.exit(fail.length ? 1 : 0)
