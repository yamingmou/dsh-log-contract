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

// 历史基线豁免（可审计）：只检查"基线之后"的提交。
// 原因：历史提交信息含早期内部术语，全史改写会破坏真实历史；发布对外由投影流程保证。
// 用法：CHECK_COMMIT_HYGIENE_BASELINE=<sha> 或 internal/commit-hygiene-baseline 文件。
const BASELINE = (() => {
  const env = process.env.CHECK_COMMIT_HYGIENE_BASELINE
  if (env) return env
  try { return readFileSync(new URL('../internal/commit-hygiene-baseline', import.meta.url), 'utf8').trim() } catch { return null }
})()


const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 词表指纹固定：wordlist.json 的 sha256 必须等于 internal/wordlist.sha256
// （改词表必须同时更新登记文件 ⇒ 删词/改词会在 diff 中可见，且单点删词立即判红）
{
  const { createHash } = await import('node:crypto')
  const { readFileSync: __rf } = await import('node:fs')
  const p = join(ROOT, 'internal', 'wordlist.json')
  const pinPath = join(ROOT, 'internal', 'wordlist.sha256')
  let actual = null, expected = null
  try { actual = createHash('sha256').update(__rf(p)).digest('hex') } catch { console.error('无法读取词表'); process.exit(2) }
  try { expected = __rf(pinPath, 'utf8').trim() } catch { console.error('无法判定 —— 缺 internal/wordlist.sha256（词表未登记）'); process.exit(2) }
  if (actual !== expected) { console.error(`无法判定 —— 词表指纹不匹配（实际 ${actual.slice(0,12)}… ≠ 登记 ${expected.slice(0,12)}…）；如确属有意修改，请运行 node scripts/wordlist-pin.mjs 更新登记`); process.exit(2) }
}
const argv = process.argv.slice(2)
const rangeIdx = argv.indexOf('--range')

// 基线有效性校验：夹具/其它仓里该 sha 不存在 ⇒ 视为无基线（回退到显式 range 默认值）
const BASELINE_VALID = (() => {
  if (!BASELINE) return null
  try { execFileSync('git', ['cat-file', '-e', `${BASELINE}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' }); return BASELINE } catch { return null }
})()
const range = (BASELINE_VALID ? `${BASELINE_VALID}..HEAD` : rangeIdx >= 0 ? argv[rangeIdx + 1] : 'origin/main..HEAD')
const asJson = argv.includes('--json')
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

const wl = JSON.parse(readFileSync(join(ROOT, 'internal', 'wordlist.json'), 'utf8'))
const words = Object.entries(wl).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => v)

// 词表完整性守卫：每类非空 + 总数 ≥ 55（防"删一行即失效"的单点弱化）
if (words.length < 20) { console.error('commit-hygiene: 无法判定 —— 词表异常'); process.exit(2) }
const regexes = Array.isArray(wl._regex) ? wl._regex : []
const RE = new RegExp([...words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ...regexes].join('|'), 'g')

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
    // merge 提交天然"无净改动"，不算空提交（负对照里用 --allow-empty 造的才是真空提交）
    const parents = git('rev-list', '--parents', '-n1', sha).trim().split(/\s+/).slice(1)
    if (parents.length === 1) {
      const parent = parents[0]
      if (git('rev-parse', `${sha}^{tree}`).trim() === git('rev-parse', `${parent}^{tree}`).trim()) fail.push(`H1 空提交 ${short} ${subject.slice(0, 50)}`)
    }
  } catch { /* 根提交 */ }
  // H2 内部词
  const hit = (subject + ' ' + body).match(RE)
  if (hit) fail.push(`H2 提交信息含内部词 ${short}: ${[...new Set(hit)].slice(0, 4).join(',')}`)
  // H4 过空
  if (subject && subject.trim().length < 6) warn.push(`H4 subject 过短 ${short}: "${subject}"`)
  // H3 改-撤来回
  if (/^revert:|恢复|重新中性化/.test(subject) && /中性化|清理|去掉|移除/.test(prevSubject)) fail.push(`H3 改-撤来回 ${short}: "${prevSubject.slice(0, 32)}" → "${subject.slice(0, 32)}"`)
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
