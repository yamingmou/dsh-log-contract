#!/usr/bin/env node
/**
 * 发版纪律闸（Release discipline gate）
 *
 * 规则（本次事故 2026-10-20 定的）：
 *  1. **版本号只用于功能与修复**：若本次版本号递增（package.json version 变化），
 *     而该区间的改动**只有文档（*.md）**，直接拒绝发布。
 *  2. CHANGELOG 必须含本次版本的条目（`## [x.y.z]`）。
 *  3. 仓库版本与 npm latest 不一致时**告警**（不拦：多机发布时可能暂时领先）。
 *
 * 用法：
 *   node scripts/check-release-discipline.mjs            # 检查（CI/发布前）
 *   node scripts/check-release-discipline.mjs --json     # 机器可读
 *   node scripts/check-release-discipline.mjs --base <rev>  # 显式指定区间起点
 *
 * 退出码：0 通过 / 1 违规 / 2 无法判定（环境问题）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const baseArgIdx = argv.indexOf('--base')
const explicitBase = baseArgIdx >= 0 ? argv[baseArgIdx + 1] : null
const DOC = /\.(md|markdown|txt|rst)$/i
const isDoc = (p) => DOC.test(p) || p.startsWith('docs/')
const isDocLike = (p) => isDoc(p) || p === 'package.json' || p === 'CHANGELOG.md'
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

function pkgAt(rev = 'HEAD') {
  try { return JSON.parse(execFileSync('git', ['show', `${rev}:package.json`], { encoding: 'utf8' })) }
  catch { return null }
}
function changedFiles(range) {
  return git('diff', '--name-only', range).split('\n').map((s) => s.trim()).filter(Boolean)
}
/** 找"上一次版本号变化"的提交作为区间起点 */
function previousVersionCommit() {
  const commits = git('log', '--format=%H', '-30', '--', 'package.json').split('\n').filter(Boolean)
  const headVer = pkgAt('HEAD')?.version
  for (let i = 1; i < commits.length; i++) {
    const v = pkgAt(commits[i])?.version
    if (v && v !== headVer) return commits[i]
  }
  return null
}

const problems = []
let range = null
let headPkg = null
try {
  headPkg = pkgAt('HEAD')
  const base = explicitBase || previousVersionCommit()
  if (!base) {
    console.log('release-discipline: 无法确定基线（没有可比较的历史版本）——跳过版本纪律检查')
    process.exit(0)
  }
  range = `${base}..HEAD`
  const baseVer = pkgAt(base)?.version
  const headVer = headPkg?.version
  const files = changedFiles(range)
  const versionBumped = baseVer && headVer && baseVer !== headVer
  const docOnly = files.length > 0 && files.every(isDocLike)

  if (versionBumped && docOnly) {
    problems.push(
      `版本号 ${baseVer} → ${headVer} 的改动只有文档（${files.length} 个文件，全部为 md/docs）——` +
      '版本号只用于功能与修复。请把版本号改回去，文档改动随下一次功能版本一起发布。',
    )
  }
  // CHANGELOG 必须有条目
  let changelog = ''
  try { changelog = readFileSync('CHANGELOG.md', 'utf8') } catch { problems.push('缺少 CHANGELOG.md') }
  if (changelog && headVer && !changelog.includes(`## [${headVer}]`) && !changelog.includes(`## ${headVer}`)) {
    problems.push(`CHANGELOG.md 缺少当前版本 ${headVer} 的条目（## [${headVer}]）`)
  }
  // 版本领先 npm 只告警
  const warn = []
  if (range) {
    const nonDoc = files.filter((f) => !isDocLike(f))
    if (versionBumped && nonDoc.length) {
      warn.push(`版本 ${headVer} 含 ${nonDoc.length} 个非文档改动（合纪律），示例：${nonDoc.slice(0, 3).join(', ')}`)
    }
  }
  const result = { ok: problems.length === 0, range, baseVersion: baseVer, headVersion: headVer, changed: files.length, docOnly, problems, warn }
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`release-discipline: 区间 ${range} ｜ 改动 ${files.length} 个文件 ｜ 版本 ${baseVer} → ${headVer}`)
    for (const w of warn) console.log(`  ↑ ${w}`)
    if (problems.length === 0) console.log('release-discipline: ok —— 版本号使用符合纪律')
    else { for (const p of problems) console.log(`  ✗ ${p}`) }
  }
  process.exit(problems.length === 0 ? 0 : 1)
} catch (e) {
  console.error('release-discipline: 无法判定：', e.message)
  process.exit(2)
}
