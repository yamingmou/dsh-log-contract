#!/usr/bin/env node
/**
 * 唯一发布入口（single release entry）
 *
 * 制度：**不得直接 `npm publish`**。发布一律走 `node scripts/release.mjs`（或 `pnpm release`）。
 * 流水线（失败即停）：
 *   0. 工作区必须干净（未提交改动会让"发出去的≠仓库里的"）
 *   1. 发版纪律闸            check-release-discipline
 *   2. 对外信息检查闸        check-external-surface（包内白名单扫描）
 *   3. 核心纯净闸（若存在）  check-core-purity --strict
 *   4. 发布前闸（若存在）    prepublish-gate
 *   5. 包元数据闸            check-pkg-meta
 *   6. 契约文档一致性        gen-contracts-doc --check + check-syntax
 *   7. 全量测试              vitest run
 *   8. 独立审核记录          check-review-record
 *   9. 发布（--ignore-scripts，避免 prepublishOnly 递归）
 *  10. 发布后复验：npm 上版本可查 + tarball 可下载 + 下载内容再跑一次对外信息检查
 * 用法：node scripts/release.mjs [--dry-run] [--skip-tests] [--allow-missing-review]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const SKIP_TESTS = argv.includes('--skip-tests')
const ALLOW_MISSING = false // 已移除放行开关：独立审核记录是硬要求
const sh = (cmd, args = [], opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const cap = (cmd, args = []) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
let step = 0
const phase = (name) => { step++; console.log(`\n[${step}] ${name}`) }
function fail(msg) { console.error(`\n✗ 发布中止：${msg}`); process.exit(1) }

// 0
phase('工作区必须干净')
const dirty = cap('git', ['status', '--porcelain'])
if (dirty) fail(`工作区有未提交改动（${dirty.split('\n').length} 处）。发布内容必须等于仓库内容。`)
const version = JSON.parse(cap('cat', ['package.json'])).version
console.log(`  ✓ 干净 ｜ 待发布版本 ${version}`)

// 0.5 已发布版本检查（防"对已发布版本 dry-run 全绿"的假象）
phase('版本未被发布过')
{
  const { execSync } = await import('node:child_process')
  try {
    const seen = execSync(`npm view dsh-log-contract@${version} version`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim()
    if (seen === version) fail(`版本 ${version} 已存在于 npm —— 发布必被 403；请先升版本号（版本号只用于功能与修复）`)
  } catch { /* 查不到 = 未发布，正常 */ }
  console.log(`  ✓ ${version} 尚未发布`)
}

// 1-8
const gates = [
  ['发版纪律', 'scripts/check-release-discipline.mjs', []],
  ['对外信息检查', 'scripts/check-external-surface.mjs', []],
  ['核心纯净', 'scripts/check-core-purity.mjs', ['--strict'], true],
  ['发布前闸', 'scripts/prepublish-gate.mjs', [], true],
  ['包元数据', 'scripts/check-pkg-meta.mjs', []],
  ['契约文档与语法', null, null],
  ['全量测试', null, null],
  ['独立审核记录', 'scripts/check-review-record.mjs', ALLOW_MISSING ? ['--allow-missing'] : []],
]
for (const [label, script, args = [], optional] of gates) {
  phase(label)
  try {
    if (label === '契约文档与语法') { sh('node', ['scripts/gen-contracts-doc.mjs', '--check']); sh('node', ['scripts/check-syntax.mjs']) }
    else if (label === '全量测试') { if (SKIP_TESTS) console.log('  （--skip-tests 跳过）'); else sh('npx', ['vitest', 'run']) }
    else {
      const { existsSync } = await import('node:fs')
      if (!existsSync(script)) { console.error(`  ✗ 闸脚本缺失：${script} —— 机制不完整，拒绝发布（exit 2）`); process.exit(2) }
      sh('node', [script, ...args])
    }
  } catch { fail(`${label} 未通过`) }
}

if (DRY) { console.log('\n✅ --dry-run：全部闸通过，未发布'); process.exit(0) }

// 9
phase('发布')
try { sh('npm', ['publish', '--ignore-scripts']) } catch { fail('npm publish 失败') }

// 10
phase('发布后复验')
let reg = null
for (let i = 0; i < 12; i++) {
  try {
    reg = JSON.parse(cap('node', ['-e', `const d=await (await fetch('https://registry.npmjs.org/dsh-log-contract')).json();console.log(JSON.stringify(d))`]).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'))
    if (reg.versions[version]) break
  } catch {}
  console.log(`  … registry 尚未可见，第 ${i + 1}/12 次，等 20s`); await new Promise((r) => setTimeout(r, 20000))
}
if (!reg) fail('registry 读取失败')
const __unused = JSON.parse(cap('node', ['-e', `0`])).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'))
if (!reg.versions[version]) fail(`registry 里查不到 ${version}`)
const url = reg.versions[version].dist.tarball
const dir = mkdtempSync(join(tmpdir(), 'rel-check-'))
execFileSync('bash', ['-lc', `curl -sL '${url}' -o '${dir}/p.tgz' && tar -xzf '${dir}/p.tgz' -C '${dir}'`], { stdio: 'inherit' })
sh('node', ['scripts/check-external-surface.mjs', '--root', join(dir, 'package')])
const rec = { version, publishedAt: new Date().toISOString(), tarball: url, gates: 'all-green' }
mkdirSync('.release-records', { recursive: true })
writeFileSync(join('.release-records', `${version}-${Date.now()}.json`), JSON.stringify(rec, null, 2))
console.log(`\n✅ 发布完成：${version} ｜ tarball 已复验 ｜ 记录 .release-records/${version}-*.json`)
