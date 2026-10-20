#!/usr/bin/env node
/**
 * 闸的负对照自检（self-test of gates）—— 机制条款：没有负对照的闸视为未完成
 *
 * 对每道闸构造"故意违规"的最小场景，断言它**必须判红**（exit 1）。
 * 任何一道闸在违规场景下返回 0 ⇒ 本脚本 exit 1（说明该闸失效）。
 *
 * 用法：node scripts/self-test-gates.mjs [--json]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const results = []
// 内部词一律从词表运行时读取 —— 本文件自身不得含内部词（否则被自己的闸判红）
const WL = JSON.parse(readFileSync(join(ROOT, 'internal', 'wordlist.json'), 'utf8'))
const pickWord = (cat, i = 0) => (WL[cat] || [])[i]
const W_PROCESS = pickWord('内部流程', 0)      // 例：裁决类
const W_MECH = pickWord('内部机制', 0)          // 例：三折类

function mkRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gate-neg-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q', d], { env })
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'internal'), join(d, 'internal'), { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.1', files: ['lib/**'] }, null, 2))
  mkdirSync(join(d, 'lib'), { recursive: true })
  writeFileSync(join(d, 'lib', 'a.js'), 'export const a = 1\n')
  writeFileSync(join(d, 'CHANGELOG.md'), '## [0.0.1]\n\n- x\n')
  writeFileSync(join(d, 'reviews'), '')
  rmSync(join(d, 'reviews'))
  execFileSync('git', ['-C', d, 'add', '-A'], { env })
  execFileSync('git', ['-C', d, 'commit', '-qm', 'init'], { env })
  return { d, env }
}
function run(script, args, cwd, env = {}) {
  const r = spawnSync('node', [join(cwd, 'scripts', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
// 1) git-surface：提交信息里带内部流程词 ⇒ 必须 exit 1
{
  const { d, env } = mkRepo()
  writeFileSync(join(d, 'lib', 'b.js'), 'export const b = 2\n')
  execFileSync('git', ['-C', d, 'add', '-A'], { env })
  execFileSync('git', ['-C', d, 'commit', '-qm', `feat: 按${W_PROCESS}执行`], { env })
  const r = run('check-git-surface.mjs', [], d, { GATE_MIN_FILES: '1' })
  results.push({ gate: `git-surface（提交信息含 ${W_PROCESS}）`, expect: 1, got: r.code, ok: r.code === 1, sample: r.out.split('\n').find((l) => l.includes(W_PROCESS)) || '' })
}
// 2) external-surface：包内文件含内部机制词 ⇒ 必须 exit 1
{
  const { d, env } = makeSimplePkg([])
  writeFileSync(join(d, 'lib', 'c.js'), `// ${W_MECH} 与 ${pickWord('内部机制', 4) || ''}\n`)
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '-qm', 'x'], { env })
  const r = run('check-external-surface.mjs', [], d, { GATE_MIN_FILES: '1' })
  results.push({ gate: `external-surface（包内含 ${W_MECH}）`, expect: 1, got: r.code, ok: r.code === 1 })
}
// 3) release-discipline：只改文档却升版本 ⇒ 必须 exit 1
{
  const { d, env } = makeSimplePkg([], '0.0.1')
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.2', files: ['lib/**'] }, null, 2))
  writeFileSync(join(d, 'CHANGELOG.md'), '## [0.0.2]\n\n- 只改文档\n\n## [0.0.1]\n\n- x\n')
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '-qm', 'docs: 0.0.2（只文档）'], { env })
  const r = run('check-release-discipline.mjs', ['--base', 'HEAD~1'], d)
  results.push({ gate: 'release-discipline（只改文档升版本）', expect: 1, got: r.code, ok: r.code === 1 })
}
// 4) review-record：缺记录 ⇒ 必须 exit 1
{
  const { d, env } = makeSimplePkg([])
  const r = run('check-review-record.mjs', [], d)
  results.push({ gate: 'review-record（缺审核记录）', expect: 1, got: r.code, ok: r.code === 1 })
}
function makeSimplePkg(_unused, version = '0.0.2') {
  const d = mkdtempSync(join(tmpdir(), 'gate-neg2-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q', d], { env })
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'internal'), join(d, 'internal'), { recursive: true })
  mkdirSync(join(d, 'lib'), { recursive: true }); writeFileSync(join(d, 'lib', 'a.js'), 'export const a=1\n')
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version, files: ['lib/**'] }, null, 2))
  writeFileSync(join(d, 'CHANGELOG.md'), `## [${version}]\n\n- x\n`)
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '-qm', 'init'], { env })
  return { d, env }
}

// 5) commit-hygiene：空提交 ⇒ 必须 exit 1
{
  const { d, env } = mkRepo()
  execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'chore: 空提交（负对照）'], { env })
  const r = run('check-commit-hygiene.mjs', ['--range', 'HEAD~1..HEAD'], d)
  results.push({ gate: 'commit-hygiene（空提交）', expect: 1, got: r.code, ok: r.code === 1 })
}

const bad = results.filter((r) => !r.ok)
console.log('闸负对照自检：')
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.gate} ｜ 期望 exit ${r.expect}，实际 ${r.got}${r.sample ? ` ｜ ${r.sample}` : ''}`)
if (bad.length) { console.log(`\n✗ ${bad.length}/${results.length} 道闸在违规场景下未判红 —— 视为该闸失效`); process.exit(1) }
console.log(`\n✅ ${results.length}/${results.length} 道闸在违规场景下都判红（负对照成立）`)
