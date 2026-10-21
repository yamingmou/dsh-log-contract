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

const PKG_NAME = 'dsh-log-contract'
// 只有"版本变更就发生在 HEAD 这个提交"时，才是发布动作；否则是开发分支的日常提交
let BUMP_IN_HEAD = false
try { BUMP_IN_HEAD = git('log', '-1', '--format=%H', '--', 'package.json') === git('rev-parse', 'HEAD') } catch { BUMP_IN_HEAD = false }
const problems = []
// npm latest 一致性（头注释早已声明、此前未实现）：本版本若已发布 ⇒ 不可再发
let npmLatest = null
try {
  const { execFileSync: ex } = await import('node:child_process')
  npmLatest = ex('npm', ['view', PKG_NAME, 'version'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim()
} catch { npmLatest = null }
let range = null
let headPkg = null
try {
  headPkg = pkgAt('HEAD')
  const headVer0 = headPkg?.version
  // 基线优先：显式 --base；否则用"把版本改成 headVer 的那个提交"自身的 diff（避免混入无关提交）
  let base = explicitBase
  if (!base) {
    try {
      const commits = git('log', '--format=%H', '-80', '--', 'package.json').split('\n').filter(Boolean)
      for (const c of commits) {
        const v = pkgAt(c)?.version
        const pv = pkgAt(`${c}^`)?.version
        if (v === headVer0 && pv && pv !== v) { base = `${c}^`; break }
      }
    } catch { /* ignore */ }
    if (!base) base = previousVersionCommit()
  }
  if (!base) {
    console.error('release-discipline: 无法判定 —— 无法确定基线（浅克隆或无历史）；fail-closed exit 2')
    process.exit(2)
  }
  range = `${base}..HEAD`
  // 实质改动判定：忽略注释行、空白行、以及纯 lock 文件的"版本号/完整性"噪声
  const substantiveLines = (() => {
    try {
      const diff = git('diff', '-U0', range)
      let changed = 0
      for (const line of diff.split('\n')) {
        if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue
        const body = line.slice(1).trim()
        if (!body) continue
        if (/^(\/\/|\/\*|\*|#|<!--)/.test(body)) continue   // 注释行
        if (/^['"]?[\w.-]+['"]?\s*:\s*['"]?[\d.]+['"]?,?$/.test(body)) continue // 纯版本/字段行（package.json）
        changed++
      }
      return changed
    } catch { return null }
  })()
  const files0 = changedFiles(range)
  if (files0.length === 0) { console.error('release-discipline: 无法判定 —— 区间为空（--base 指向 HEAD？）'); process.exit(2) }
  const baseVer = pkgAt(base)?.version
  const headVer = headPkg?.version
  const files = changedFiles(range)
  const versionBumped = baseVer && headVer && baseVer !== headVer
  const docOnly = substantiveLines === 0 || (files.length > 0 && files.every(isDocLike))

  // "实质改动"判定：lib/|bin/|test/ 中新增行去掉注释/空行后仍有内容
  let substantive = false
  if (versionBumped) {
    const codeFiles = files.filter((f) => /^(lib|bin|test|scripts)\//.test(f) && !f.endsWith('.md'))
    for (const f of codeFiles) {
      let diff = ''
      try { diff = git('diff', `${base}..HEAD`, '--', f) } catch { continue }
      const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .map((l) => l.slice(1).trim())
        .map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
        .filter((l) => l && !/^(\*|#|<!--)/.test(l))
      if (added.length) { substantive = true; break }
    }
  }
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
    if (npmLatest) {
    // 只在「本次确实升了版本」时，才把"与 npm latest 相同"视为发布违规；
    // 无版本变更（日常开发分支）只作提示 —— 否则每次检查都是红，导致红灯免疫。
    if (BUMP_IN_HEAD && versionBumped && headVer === npmLatest) problems.push(`版本 ${headVer} 已是 npm latest —— 未升版本不得发布`)
    else if (versionBumped && baseVer === npmLatest) console.log(`  提示：当前版本 ${headVer} 高于 npm latest ${npmLatest}，可发布`)
    else if (!versionBumped) console.log(`  提示：本次无版本变更（当前 ${headVer}，npm latest ${npmLatest}）`)
  } else console.log('  提示：npm latest 未取得（离线）')
  if (versionBumped && !docOnly && !substantive) problems.push('版本号递增但代码文件里只有注释/空行改动 —— 不算功能/修复')
  if (problems.length === 0) console.log('release-discipline: ok —— 版本号使用符合纪律')
    else { for (const p of problems) console.log(`  ✗ ${p}`) }
  }
  process.exit(problems.length === 0 ? 0 : 1)
} catch (e) {
  console.error('release-discipline: 无法判定：', e.message)
  process.exit(2)
}
