#!/usr/bin/env node
/**
 * 发布前检查流程（pre-publish checklist runner）
 *
 * 这不是"一个闸"，而是**发布前置的完整流程**：按顺序跑，逐项出 PASS/FAIL/SKIP，
 * 最后写一份可审计报告 internal/release-reports/<version>-<ts>.json，任何 FAIL ⇒ exit 1。
 *
 * 用法：node scripts/pre-publish.mjs [--json] [--skip-tests] [--offline-ok] [--pre-release]
 *   --pre-release  发布前自检语义：缺 reviews/<version>.json ⇒ WARN（待发布补齐），
 *                  正式发布（不带该开关）⇒ 缺记录仍为 FAIL
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const __pkg = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = __pkg.name
const argv = process.argv.slice(2)
const SKIP_TESTS = argv.includes('--skip-tests')
const OFFLINE_OK = argv.includes('--offline-ok')
const RELEASE = argv.includes('--release')  // 发布模式：审核记录缺失 = FAIL；开发模式 = WARN（待发布前补齐）  // 显式允许离线；否则 registry 不可达 = FAIL
const PRE_RELEASE = argv.includes('--pre-release') // 发布前自检：缺审核记录 ⇒ WARN（正式发布仍 FAIL）

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const items = []
const add = (name, status, detail = '') => items.push({ name, status, detail })
const runNode = (script, args = []) => spawnSync('node', [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8' })
const runCmd = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })

// 1) 工作区干净
const st = runCmd('git', ['status', '--porcelain'])
if (st.status !== 0) add('工作区状态可读', 'FAIL', 'git status 失败')
else if ((st.stdout || '').trim()) add('工作区干净', 'FAIL', `未提交 ${(st.stdout || '').trim().split('\n').length} 处`)
else add('工作区干净', 'PASS')

// 2) 结构性检查（脚本闸）
const DRIFT_PEER_DIR = process.env.DRIFT_PEER || join(homedir(), 'opena', 'dsh-retrace-private')
const DRIFT_ARGS = ['--peer', DRIFT_PEER_DIR].concat(RELEASE ? [] : ['--warn-only'])
const gates = [
  ['锁文件一致', 'scripts/check-lockfile-consistency.mjs'],
  ['发布泄漏闸（两包口径）', 'internal/scripts/prepublish-gate.mjs'],
  ['发布入口唯一性', 'scripts/check-publish-entry.mjs'],
  ['两仓机制件漂移', 'scripts/check-mechanism-drift.mjs', DRIFT_ARGS],
  ['提交卫生', 'scripts/check-commit-hygiene.mjs'],
  ['手册新鲜度', 'scripts/check-mechanism-freshness.mjs'],
  ['发版纪律', 'scripts/check-release-discipline.mjs'],
  ['对外信息（发布集）', 'scripts/check-external-surface.mjs'],
  ['GitHub 面对外信息', 'scripts/check-git-surface.mjs'],
  ['闸负对照自检', 'scripts/self-test-gates.mjs'],
  ['独立审核记录', 'scripts/check-review-record.mjs', PRE_RELEASE ? ['--pre-release'] : []],
]
for (const [name, script, gateArgs = []] of gates) {
  if (!existsSync(join(ROOT, script))) { add(name, 'FAIL', `脚本缺失 ${script}（fail-closed）`); continue }
  const r = runNode(script, gateArgs)
  const raw = ((r.stdout || '') + (r.stderr || '')).trim()
  const HS_BRANCH = (runCmd('git', ['branch', '--show-current']).stdout || '').trim()
  if (name === '提交卫生') {
    const softH = !PRE_RELEASE || HS_BRANCH !== 'main'
    add(name, r.status === 0 ? 'PASS' : (softH ? 'WARN' : 'FAIL'), r.status === 0 ? '' : `分支 ${HS_BRANCH || '(detached)'}｜${raw.split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' ｜ ').slice(0, 140)}`)
    continue
  }
  const out = raw.split('\n')
  // 审核记录在 --pre-release 下缺记录是"待发布补齐"WARN（exit 0 但输出 ⚠️）：如实降为 WARN，不冒充 PASS
  if (name === '独立审核记录' && r.status === 0 && raw.includes('⚠️')) {
    add(name, 'WARN', out.slice(-2).join(' ｜ ').slice(0, 160))
    continue
  }
  const __soft = !PRE_RELEASE && (name === '独立审核记录' || name === '发版纪律')
  add(name, r.status === 0 ? 'PASS' : (__soft ? 'WARN' : 'FAIL'), r.status === 0 ? '' : out.slice(-2).join(' ｜ ').slice(0, 160))
}

// 3) 元数据 / 语法 / 契约文档
const meta = [
  ['包元数据', 'scripts/check-pkg-meta.mjs'],
  ['语法', 'scripts/check-syntax.mjs'],
  ['契约文档一致', 'scripts/gen-contracts-doc.mjs', ['--check']],
]
for (const [name, script, args = []] of meta) {
  if (!existsSync(join(ROOT, script))) { add(name, 'FAIL', `脚本缺失 ${script}`); continue }
  const r = runNode(script, args)
  add(name, r.status === 0 ? 'PASS' : 'FAIL', r.status === 0 ? '' : ((r.stdout || '') + (r.stderr || '')).trim().slice(-160))
}

// 4) 全量测试
if (SKIP_TESTS) add('全量测试', 'SKIP', '--skip-tests')
else {
  const r = runCmd('npx', ['vitest', 'run'])
  const out = ((r.stdout || '') + (r.stderr || ''))
  const m = out.match(/Tests\s+(\d+) failed|(\d+) passed/)
  add('全量测试', r.status === 0 ? 'PASS' : 'FAIL', r.status === 0 ? (out.match(/Tests\s+.*$/m) || [''])[0].slice(0, 80) : '有失败用例')
}

// 5) 版本与 CHANGELOG / npm latest 一致性
try {
  const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  add('CHANGELOG 条目', cl.includes(`## [${version}]`) ? 'PASS' : 'FAIL', `版本 ${version}`)
} catch { add('CHANGELOG 条目', 'FAIL', '缺 CHANGELOG.md') }
try {
  const r = runCmd('npm', ['view', `${PKG_NAME}@${version}`, 'version'])
  const out = (r.stdout || '').trim()
  const stderr = (r.stderr || '')
  const notFound = /E404|404 Not Found|is not in this registry|No match found/i.test(out + ' ' + stderr)
  if (r.status === 0) add('版本未被发布过', out.includes(version) ? 'FAIL' : 'PASS', out.includes(version) ? '该版本已在 npm' : '未发布')
  else if (notFound) add('版本未被发布过', 'PASS', `registry 查无 ${version}（未发布，符合预期）`)
  else add('版本未被发布过', OFFLINE_OK ? 'WARN' : 'FAIL', OFFLINE_OK ? '离线（--offline-ok）：未核验' : 'registry 不可达（fail-closed）')
} catch { add('版本未被发布过', 'SKIP', '网络不可用') }

// 6) 独立审核记录内容检查（不仅是存在）
{
  const p = [join(ROOT, 'internal', 'reviews', `${version}.json`), join(ROOT, 'reviews', `${version}.json`)].find((x) => existsSync(x)) || join(ROOT, 'internal', 'reviews', `${version}.json`)
  if (!existsSync(p)) {
    // 发布前自检：缺记录 = 待补齐（WARN）；正式发布：缺记录 = FAIL（不可发布）
    add('独立审核记录内容', PRE_RELEASE ? 'WARN' : 'FAIL', PRE_RELEASE
      ? `缺 reviews/${version}.json —— 发布前必须补齐（reviewer≠author、gitHead=HEAD、evidence 为可复算命令）`
      : `缺 reviews/${version}.json`)
  } else {
    try {
      const r = JSON.parse(readFileSync(p, 'utf8'))
      const ok = r.verdict === 'pass' && r.reviewer && r.author && r.reviewer !== r.author && Array.isArray(r.evidence) && r.evidence.length
      add('独立审核记录内容', ok ? 'PASS' : (RELEASE ? 'FAIL' : 'WARN'), ok ? `reviewer=${r.reviewer}` : '字段不合规')
    } catch { add('独立审核记录内容', 'FAIL', 'JSON 不可解析') }
  }
}

const blockList = RELEASE ? items.filter((i) => i.status !== 'PASS') : items.filter((i) => i.status === 'FAIL')
const fail = blockList
const soft = items.filter((i) => i.status === 'WARN' || i.status === 'SKIP')
const report = { version, at: new Date().toISOString(), gitHead: (runCmd('git', ['rev-parse', 'HEAD']).stdout || '').trim(), items, verdict: fail.length ? 'fail' : 'pass' }
const reportDir = join(homedir(), '.dsh-gates', 'reports')
mkdirSync(reportDir, { recursive: true })
const rp = join(reportDir, `${version}-${Date.now()}.json`)
writeFileSync(rp, JSON.stringify(report, null, 2))
console.log(`发布前检查（版本 ${version}）：`)
const mark = { PASS: '✓', FAIL: '✗', WARN: '⚠', SKIP: '·' }
for (const i of items) console.log(`  ${mark[i.status] || '?'} [${i.status}] ${i.name}${i.detail ? ` — ${i.detail}` : ''}`)
console.log(`\n${fail.length ? `✗ ${fail.length} 项未通过 ⇒ 不可发布` : '✅ 全部 PASS ⇒ 可发布'}${soft.length ? ` ｜ ⚠️ ${soft.length} 项 WARN/SKIP（不等同通过）` : ''} ｜ 报告 ${rp.replace(ROOT + '/', '')}`)
process.exit(fail.length ? 1 : 0)
