#!/usr/bin/env node
/**
 * 两仓机制件漂移闸（check-mechanism-drift）
 *
 * 方法：逐字比较"同源机制件"在本仓与对端仓的副本；允许**已登记的最小差异**（逐条列名+理由），
 *       出现新的差异 ⇒ exit 1。找不到对端仓 ⇒ exit 2（不允许当成通过）。
 * 用法：node scripts/check-mechanism-drift.mjs [--peer <path>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const pi = argv.indexOf('--peer')
const PEER = pi >= 0 ? argv[pi + 1] : join(ROOT, '..', 'dsh-retrace-private')
const PAIRS = [
  ['scripts/check-lockfile-consistency.mjs', 'internal/scripts/check-lockfile-consistency.mjs'],
]
// 已登记差异（逐条列名 + 理由）：允许的行内容模式
const ALLOW_LINE = [/同源/, /\.\.', '\.\.'/, /^\/\//]
const problems = []
let compared = 0
for (const [mine, theirs] of PAIRS) {
  const a = join(ROOT, mine), b = join(PEER, theirs)
  if (!existsSync(a)) { problems.push(`本仓缺 ${mine}`); continue }
  if (!existsSync(b)) { console.error(`drift: 无法判定 —— 对端缺 ${b}`); process.exit(2) }
  // 归一化：剔除注释行与空白差异，再整体比较（允许注释/路径差异，不允许逻辑差异）
  const norm = (s) => s.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('#'))
    .join('\n')
  const A = norm(readFileSync(a, 'utf8')), B = norm(readFileSync(b, 'utf8'))
  compared++
  if (A !== B) {
    const al = A.split('\n'), bl = B.split('\n')
    let idx = 0
    while (idx < al.length && idx < bl.length && al[idx] === bl[idx]) idx++
    problems.push(`${mine}: 归一化后仍不一致（首个差异 第 ${idx + 1} 行）—— 本仓「${(al[idx] || '').slice(0, 60)}」 vs 对端「${(bl[idx] || '').slice(0, 60)}」`)
  }
}
console.log(`mechanism-drift: 比较 ${compared} 对 ｜ 未登记差异 ${problems.length}`)
for (const p of problems.slice(0, 10)) console.log(`  ✗ ${p}`)
if (!problems.length) console.log('mechanism-drift: ok —— 仅存在已登记差异')
process.exit(problems.length ? 1 : 0)
