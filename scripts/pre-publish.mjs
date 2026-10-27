#!/usr/bin/env node
/**
 * 发布前检查流程（pre-publish checklist runner）
 *
 * 这不是"一个闸"，而是**发布前置的完整流程**：按顺序跑，逐项出 PASS/FAIL/SKIP，
 * 最后写一份可审计报告 ~/.dsh-gates/reports/<version>-<ts>.json，任何 FAIL ⇒ exit 1。
 *
 * 机制适用面（internal/mechanism.config.json，每仓一份）：
 *   · 闸标 "not-applicable" ⇒ 本项记 **SKIP**（必须带理由）；
 *   · 闸带 "exclude" ⇒ 以 `--exclude` 传给对应闸（闸自身也会读同一配置）；
 *   · **未声明的闸照常执行**；配置不可解析 ⇒ 直接 exit 1（fail-closed）。
 * 两仓漂移降级策略（2026-10-27）：日常模式不一致 = **WARN 并记录**（~/.dsh-gates/drift-warnings.jsonl，
 *   不阻断）；`--release` 模式不一致 = **FAIL 阻断发布**（见 DRIFT_ARGS 与漂移项判定）。
 *
 * 用法：node scripts/pre-publish.mjs [--json] [--skip-tests] [--offline-ok] [--pre-release] [--release]
 *       [--plan] [--skip-allow <闸键,闸键,…>]
 *   --plan         只解析适用面并打印"哪些 RUN / 哪些 SKIP"，不执行任何闸（离线、零副作用）
 *   --pre-release  发布前自检语义：缺 reviews/<version>.json ⇒ WARN（待发布补齐），
 *                  正式发布（不带该开关）⇒ 缺记录仍为 FAIL
 *   --release      正式发布口径：任何非 PASS（含 WARN/SKIP）⇒ 不可发布
 *   --skip-allow   SKIP 白名单：显式点名的 SKIP 项不阻断 --release（只放行 SKIP，⛔ 不放行 WARN/FAIL）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadConfig, directiveFor } from './mechanism-config.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const __pkg = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = __pkg.name
const argv = process.argv.slice(2)
const SKIP_TESTS = argv.includes('--skip-tests')
const OFFLINE_OK = argv.includes('--offline-ok')
const RELEASE = argv.includes('--release')
const PLAN = argv.includes('--plan')
const SKIP_ALLOW = (() => {  // SKIP 白名单：--skip-allow a,b --skip-allow c（按闸键=脚本路径或步骤名）
  const keys = new Set()
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--skip-allow') for (const k of String(argv[i + 1] || '').split(',')) if (k.trim()) keys.add(k.trim())
  return keys
})()  // 发布模式：审核记录缺失 = FAIL；开发模式 = WARN（待发布前补齐）  // 显式允许离线；否则 registry 不可达 = FAIL
const PRE_RELEASE = argv.includes('--pre-release') // 发布前自检：缺审核记录 ⇒ WARN（正式发布仍 FAIL）

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

// 机制适用面：坏配置 ⇒ exit 1（⛔ 不许当"全适用"蒙混）
let MECH
try { MECH = loadConfig(ROOT) } catch (e) { console.error(`pre-publish: ✗ 机制适用面配置不可用 —— ${e.message}`); process.exit(1) }
const dirOf = (script, name) => directiveFor(MECH, script, name)

const items = []
const add = (name, status, detail = '', key = null) => items.push({ name, status, detail, key: key || name })
const runNode = (script, args = []) => spawnSync('node', [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8' })
const runCmd = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
const skipDetail = (dir) => `机制配置：${dir.reason}`
const allowMark = (key, name) => (SKIP_ALLOW.has(key) || SKIP_ALLOW.has(name)) ? '（--skip-allow 已放行，不阻断发布）' : ''

// ── 步骤定义（--plan 与执行共用同一份清单） ─────────────────────────────────
const DRIFT_PEER_DIR = process.env.DRIFT_PEER || null  // 不硬编码任何私有路径；未设置则跳过漂移检查
// 漂移降级策略（2026-10-27）：日常（dev）= --warn-only ⇒ 不一致只 WARN 并记录（不阻断）；
// --release = 严格 ⇒ 不一致 FAIL 阻断发布。⛔ 只降"日常阻断"，不降"发布阻断"
const DRIFT_ARGS = RELEASE ? [] : ['--warn-only']
const gates = [
  ['锁文件一致', 'scripts/check-lockfile-consistency.mjs'],
  ['打包白名单覆盖', 'scripts/check-package-files-coverage.mjs'],
  ['发布泄漏闸（两包口径）', 'internal/' + 'scripts/pre' + 'publish-gate.mjs'],
  ['发布入口唯一性', 'scripts/check-publish-entry.mjs'],
  ['tag 面', 'scripts/check-tag-surface.mjs'],
  ...(DRIFT_PEER_DIR ? [['两仓机制件漂移', 'scripts/check-mechanism-drift.mjs', ['--peer', DRIFT_PEER_DIR, ...(DRIFT_ARGS || [])]]] : []),
  ['提交卫生', 'scripts/check-commit-hygiene.mjs'],
  ['手册新鲜度', 'scripts/check-mechanism-freshness.mjs'],
  ['机制冻结基线', 'scripts/check-mechanism-freeze.mjs'],
  ['发版纪律', 'scripts/check-release-discipline.mjs'],
  ['对外信息（发布集）', 'scripts/check-external-surface.mjs'],
  ['GitHub 面对外信息', 'scripts/check-git-surface.mjs'],
  ['闸负对照自检', 'scripts/self-test-gates.mjs'],
  ['独立审核记录', 'scripts/check-review-record.mjs', PRE_RELEASE ? ['--pre-release'] : []],
]
const meta = [
  ['包元数据', 'scripts/check-pkg-meta.mjs'],
  ['语法', 'scripts/check-syntax.mjs'],
  ['契约文档一致', 'scripts/gen-contracts-doc.mjs', ['--check']],
]
const singles = ['工作区干净', '全量测试', 'CHANGELOG 条目', '版本未被发布过', '独立审核记录内容']

if (PLAN) {
  console.log(`pre-publish --plan（版本 ${version} · 仅解析机制适用面，不执行）：`)
  for (const [name, script] of [...gates, ...meta]) {
    const dir = dirOf(script, name)
    const ex = dir.exclude.length ? ` ｜ exclude: ${dir.exclude.join(', ')}` : ''
    console.log(`  ${dir.action === 'skip' ? '· [SKIP]' : '▸ [RUN] '} ${name}（${script}）${dir.reason ? ` — ${dir.reason}` : ''}${dir.action === 'skip' ? '' : ex}`)
  }
  for (const name of singles) {
    const dir = dirOf(null, name)
    console.log(`  ${dir.action === 'skip' ? '· [SKIP]' : '▸ [RUN] '} ${name}${dir.reason ? ` — ${dir.reason}` : ''}`)
  }
  process.exit(0)
}

// 1) 工作区干净
{
  const dir = dirOf(null, '工作区干净')
  if (dir.action === 'skip') add('工作区干净', 'SKIP', skipDetail(dir), '工作区干净')
  else {
    const st = runCmd('git', ['status', '--porcelain'])
    if (st.status !== 0) add('工作区状态可读', 'FAIL', 'git status 失败', '工作区干净')
    else if ((st.stdout || '').trim()) add('工作区干净', 'FAIL', `未提交 ${(st.stdout || '').trim().split('\n').length} 处`, '工作区干净')
    else add('工作区干净', 'PASS', '', '工作区干净')
  }
}

// 2) 结构性检查（脚本闸）
const SKIPPABLE = new Set(['全量测试'])  // 声明式：这些项在显式允许时可 SKIP（如 --skip-tests）
for (const [name, script, gateArgs = []] of gates) {
  const dir = dirOf(script, name)
  if (dir.action === 'skip') { add(name, 'SKIP', skipDetail(dir) + allowMark(script, name), script); continue }
  if (!existsSync(join(ROOT, script))) { add(name, 'FAIL', `脚本缺失 ${script}（fail-closed）`, script); continue }
  const exArgs = dir.exclude.length ? ['--exclude', dir.exclude.join(',')] : []
  const r = runNode(script, [...gateArgs, ...exArgs])
  const raw = ((r.stdout || '') + (r.stderr || '')).trim()
  const HS_BRANCH = (runCmd('git', ['branch', '--show-current']).stdout || '').trim()
  if (name === '提交卫生') {
    const softH = !PRE_RELEASE || HS_BRANCH !== 'main'
    add(name, r.status === 0 ? 'PASS' : (softH ? 'WARN' : 'FAIL'), r.status === 0 ? '' : `分支 ${HS_BRANCH || '(detached)'}｜${raw.split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' ｜ ').slice(0, 140)}`, script)
    continue
  }
  const out = raw.split('\n')
  // 漂移降级策略：日常 warn-only 下不一致 ⇒ WARN（闸已记录、不阻断），⛔ 不冒充 PASS；release 下闸 exit 1 ⇒ FAIL
  if (name === '两仓机制件漂移') {
    const mismatch = /内容不一致 [1-9]/.test(raw) || raw.includes('⚠️ 存在内容不一致')
    add(name, r.status !== 0 ? 'FAIL' : (mismatch ? 'WARN' : 'PASS'), r.status === 0 && !mismatch ? '' : out.slice(-3).join(' ｜ ').slice(0, 160), script)
    continue
  }
  // 审核记录在 --pre-release 下缺记录是"待发布补齐"WARN（exit 0 但输出 ⚠️）：如实降为 WARN，不冒充 PASS
  if (name === '独立审核记录' && r.status === 0 && raw.includes('⚠️')) {
    add(name, 'WARN', out.slice(-2).join(' ｜ ').slice(0, 160), script)
    continue
  }
  const __soft = !PRE_RELEASE && (name === '独立审核记录' || name === '发版纪律')
  add(name, r.status === 0 ? 'PASS' : (__soft ? 'WARN' : 'FAIL'), r.status === 0 ? '' : out.slice(-2).join(' ｜ ').slice(0, 160), script)
}

// 3) 元数据 / 语法 / 契约文档
for (const [name, script, args = []] of meta) {
  const dir = dirOf(script, name)
  if (dir.action === 'skip') { add(name, 'SKIP', skipDetail(dir) + allowMark(script, name), script); continue }
  if (!existsSync(join(ROOT, script))) { add(name, 'FAIL', `脚本缺失 ${script}`, script); continue }
  const exArgs = dir.exclude.length ? ['--exclude', dir.exclude.join(',')] : []
  const r = runNode(script, [...args, ...exArgs])
  add(name, r.status === 0 ? 'PASS' : 'FAIL', r.status === 0 ? '' : ((r.stdout || '') + (r.stderr || '')).trim().slice(-160), script)
}

// 4) 全量测试
{
  const dir = dirOf(null, '全量测试')
  if (dir.action === 'skip') add('全量测试', 'SKIP', skipDetail(dir) + allowMark(null, '全量测试'), '全量测试')
  else if (SKIP_TESTS) add('全量测试', 'SKIP', '--skip-tests' + allowMark(null, '全量测试'), '全量测试')
  else {
    const r = runCmd('npx', ['vitest', 'run'])
    const out = ((r.stdout || '') + (r.stderr || ''))
    add('全量测试', r.status === 0 ? 'PASS' : 'FAIL', r.status === 0 ? (out.match(/Tests\s+.*$/m) || [''])[0].slice(0, 80) : '有失败用例', '全量测试')
  }
}

// 5) 版本与 CHANGELOG / npm latest 一致性
{
  const dir = dirOf(null, 'CHANGELOG 条目')
  if (dir.action === 'skip') add('CHANGELOG 条目', 'SKIP', skipDetail(dir), 'CHANGELOG 条目')
  else {
    try {
      const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
      add('CHANGELOG 条目', cl.includes(`## [${version}]`) ? 'PASS' : 'FAIL', `版本 ${version}`, 'CHANGELOG 条目')
    } catch { add('CHANGELOG 条目', 'FAIL', '缺 CHANGELOG.md', 'CHANGELOG 条目') }
  }
}
{
  const dir = dirOf(null, '版本未被发布过')
  if (dir.action === 'skip') add('版本未被发布过', 'SKIP', skipDetail(dir), '版本未被发布过')
  else {
    try {
      const r = runCmd('npm', ['view', `${PKG_NAME}@${version}`, 'version'])
      const out = (r.stdout || '').trim()
      const stderr = (r.stderr || '')
      const notFound = /E404|404 Not Found|is not in this registry|No match found/i.test(out + ' ' + stderr)
      if (r.status === 0) add('版本未被发布过', out.includes(version) ? 'FAIL' : 'PASS', out.includes(version) ? '该版本已在 npm' : '未发布', '版本未被发布过')
      else if (notFound) add('版本未被发布过', 'PASS', `registry 查无 ${version}（未发布，符合预期）`, '版本未被发布过')
      else add('版本未被发布过', OFFLINE_OK ? 'WARN' : 'FAIL', OFFLINE_OK ? '离线（--offline-ok）：未核验' : 'registry 不可达（fail-closed）', '版本未被发布过')
    } catch { add('版本未被发布过', 'SKIP', '网络不可用', '版本未被发布过') }
  }
}

// 6) 独立审核记录内容检查（不仅是存在）
{
  const dir = dirOf(null, '独立审核记录内容')
  if (dir.action === 'skip') add('独立审核记录内容', 'SKIP', skipDetail(dir), '独立审核记录内容')
  else {
    const p = [join(ROOT, 'internal', 'reviews', `${version}.json`), join(ROOT, 'reviews', `${version}.json`)].find((x) => existsSync(x)) || join(ROOT, 'internal', 'reviews', `${version}.json`)
    if (!existsSync(p)) {
      // 发布前自检：缺记录 = 待补齐（WARN）；正式发布：缺记录 = FAIL（不可发布）
      add('独立审核记录内容', PRE_RELEASE ? 'WARN' : 'FAIL', PRE_RELEASE
        ? `缺 reviews/${version}.json —— 发布前必须补齐（reviewer≠author、gitHead=HEAD、evidence 为可复算命令）`
        : `缺 reviews/${version}.json`, '独立审核记录内容')
    } else {
      try {
        const r = JSON.parse(readFileSync(p, 'utf8'))
        const ok = r.verdict === 'pass' && r.reviewer && r.author && r.reviewer !== r.author && Array.isArray(r.evidence) && r.evidence.length
        add('独立审核记录内容', ok ? 'PASS' : (RELEASE ? 'FAIL' : 'WARN'), ok ? `reviewer=${r.reviewer}` : '字段不合规', '独立审核记录内容')
      } catch { add('独立审核记录内容', 'FAIL', 'JSON 不可解析', '独立审核记录内容') }
    }
  }
}

// 阻断判定：release 口径 = 任何非 PASS（WARN/SKIP 同样不可发布）；--skip-allow 显式放行 SKIP 项
const isAllowed = (i) => i.status === 'SKIP' && (SKIP_ALLOW.has(i.key) || SKIP_ALLOW.has(i.name))
const blockList = RELEASE ? items.filter((i) => i.status !== 'PASS' && !isAllowed(i)) : items.filter((i) => i.status === 'FAIL')
const fail = blockList
const soft = items.filter((i) => i.status === 'WARN' || i.status === 'SKIP')
const report = { version, mode: RELEASE ? 'release' : 'dev', at: new Date().toISOString(), gitHead: (runCmd('git', ['rev-parse', 'HEAD']).stdout || '').trim(), items, verdict: fail.length ? 'fail' : 'pass' }
const reportDir = join(homedir(), '.dsh-gates', 'reports')
mkdirSync(reportDir, { recursive: true })
const rp = join(reportDir, `${version}-${Date.now()}.json`)
writeFileSync(rp, JSON.stringify(report, null, 2))
console.log(`发布前检查（版本 ${version}）：`)
const mark = { PASS: '✓', FAIL: '✗', WARN: '⚠', SKIP: '·' }
for (const i of items) console.log(`  ${mark[i.status] || '?'} [${i.status}] ${i.name}${i.detail ? ` — ${i.detail}` : ''}`)
console.log(`\n${fail.length ? `✗ ${fail.length} 项未通过 ⇒ 不可发布` : `✅ 全部 PASS ⇒ 可发布`}${soft.length ? ` ｜ ⚠️ ${soft.length} 项 WARN/SKIP（不等同通过）` : ''} ｜ 报告 ${rp.replace(ROOT + '/', '')}`)
process.exit(fail.length ? 1 : 0)
