#!/usr/bin/env node
/**
 * 对外发布前总检（aggregate gate）——一条命令跑完"机检层"
 * 用法：node scripts/gate.mjs [--release] [--skip-registry]
 * 退出码：0 全绿 / 1 有不通过 / 2 无法判定
 * 说明：这是"机检层"聚合器；指南层（人读纪律）见 AGENTS-plugin-line-*.local.md，
 *       skill 层见 docs/机制-六层模型.md，台账层见 工程-插件任务/台账-PROJECT-LEDGER.md。
 */
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const RC = args.includes('--release')
const skipReg = args.includes('--skip-registry')
const steps = [
  ['自检负对照', 'scripts/self-test-gates.mjs', []],
  ['发布面泄漏', 'scripts/check-external-surface.mjs', []],
  ['GitHub 面', 'scripts/check-git-surface.mjs', ['--allow-no-gh']],
  ['提交卫生', 'scripts/check-commit-hygiene.mjs', []],
  ['锁文件', 'scripts/check-lockfile-consistency.mjs', []],
  ['机制文档新鲜度', 'scripts/check-mechanism-freshness.mjs', []],
  ['机制冻结', 'scripts/check-mechanism-freeze.mjs', []],
  ['两仓漂移', 'scripts/check-mechanism-drift.mjs', ['--peer', process.env.DSH_RETRACE_PRIVATE || '../dsh-retrace-private']],
  ['语法', 'scripts/check-syntax.mjs', []],
]
const results = []
for (const [name, script, extra] of steps) {
  const r = spawnSync('node', [script, ...extra], { encoding: 'utf8' })
  const ok = r.status === 0
  results.push({ name, status: r.status, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}（exit ${r.status}）`)
  if (!ok) console.log((r.stdout || r.stderr || '').split('\n').filter(Boolean).slice(-4).map((l) => '    ' + l).join('\n'))
}
if (!skipReg) {
  const r = spawnSync('node', ['scripts/check-published-artifact.mjs'], { encoding: 'utf8' })
  const ok = r.status === 0
  results.push({ name: '发布后 registry 核验', status: r.status, ok })
  console.log(`${ok ? '✓' : '✗'} 发布后 registry 核验（exit ${r.status}）`)
  if (!ok) console.log((r.stdout || '').split('\n').filter(Boolean).slice(0, 6).map((l) => '    ' + l).join('\n'))
}
const bad = results.filter((r) => !r.ok)
console.log(`gate: ${results.length - bad.length}/${results.length} 通过${RC ? '（release 口径）' : ''}`)
process.exit(bad.length ? 1 : 0)
