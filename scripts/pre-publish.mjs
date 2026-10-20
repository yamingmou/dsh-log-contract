#!/usr/bin/env node
/**
 * 发布前检查流程（pre-publish checklist runner）
 *
 * 这不是"一个闸"，而是**发布前置的完整流程**：按顺序跑，逐项出 PASS/FAIL/SKIP，
 * 最后写一份可审计报告 internal/release-reports/<version>-<ts>.json，任何 FAIL ⇒ exit 1。
 *
 * 用法：node scripts/pre-publish.mjs [--json] [--skip-tests]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const SKIP_TESTS = argv.includes('--skip-tests')

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
const gates = [
  ['锁文件一致', 'scripts/check-lockfile-consistency.mjs'],
  ['发布泄漏闸（两包口径）', 'internal/scripts/prepublish-gate.mjs'],
  ['提交卫生', 'scripts/check-commit-hygiene.mjs'],
  ['发版纪律', 'scripts/check-release-discipline.mjs'],
  ['对外信息（发布集）', 'scripts/check-external-surface.mjs'],
  ['GitHub 面对外信息', 'scripts/check-git-surface.mjs'],
  ['闸负对照自检', 'scripts/self-test-gates.mjs'],
  ['独立审核记录', 'scripts/check-review-record.mjs'],
]
for (const [name, script] of gates) {
  if (!existsSync(join(ROOT, script))) { add(name, 'FAIL', `脚本缺失 ${script}（fail-closed）`); continue }
  if (name === '提交卫生') {
    const br = (runCmd('git', ['branch', '--show-current']).stdout || '').trim()
    if (br !== 'main') { add(name, 'SKIP', `内部分支 ${br}：不用于公开发布`); continue }
  }
  const r = runNode(script)
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')
  add(name, r.status === 0 ? 'PASS' : 'FAIL', r.status === 0 ? '' : out.slice(-2).join(' ｜ ').slice(0, 160))
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
  const r = runCmd('npm', ['view', `dsh-log-contract@${version}`, 'version'])
  add('版本未被发布过', r.status === 0 && (r.stdout || '').includes(version) ? 'FAIL' : 'PASS', r.status === 0 ? '该版本已在 npm' : '未发布')
} catch { add('版本未被发布过', 'SKIP', '网络不可用') }

// 6) 独立审核记录内容检查（不仅是存在）
{
  const p = join(ROOT, 'reviews', `${version}.json`)
  if (!existsSync(p)) add('独立审核记录内容', 'FAIL', `缺 reviews/${version}.json`)
  else {
    try {
      const r = JSON.parse(readFileSync(p, 'utf8'))
      const ok = r.verdict === 'pass' && r.reviewer && r.author && r.reviewer !== r.author && Array.isArray(r.evidence) && r.evidence.length
      add('独立审核记录内容', ok ? 'PASS' : 'FAIL', ok ? `reviewer=${r.reviewer}` : '字段不合规')
    } catch { add('独立审核记录内容', 'FAIL', 'JSON 不可解析') }
  }
}

const fail = items.filter((i) => i.status === 'FAIL')
const report = { version, at: new Date().toISOString(), gitHead: (runCmd('git', ['rev-parse', 'HEAD']).stdout || '').trim(), items, verdict: fail.length ? 'fail' : 'pass' }
mkdirSync(join(ROOT, 'internal', 'release-reports'), { recursive: true })
const rp = join(ROOT, 'internal', 'release-reports', `${version}-${Date.now()}.json`)
writeFileSync(rp, JSON.stringify(report, null, 2))
console.log(`发布前检查（版本 ${version}）：`)
for (const i of items) console.log(`  ${i.status === 'PASS' ? '✓' : i.status === 'SKIP' ? '·' : '✗'} ${i.name}${i.detail ? ` — ${i.detail}` : ''}`)
console.log(`\n${fail.length ? `✗ ${fail.length} 项未通过 ⇒ 不可发布` : '✅ 全部通过 ⇒ 可发布'} ｜ 报告 ${rp.replace(ROOT + '/', '')}`)
process.exit(fail.length ? 1 : 0)
