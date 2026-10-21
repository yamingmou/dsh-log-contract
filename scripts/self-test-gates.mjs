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
const W_PROCESS = pickWord('内部流程', 0)      // 例：结论类
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
  execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'init'], { env })
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
  execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', `chore: 按${W_PROCESS}处理`], { env })
  const r = (() => { try { execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://github.com/x/y.git'], { env }) } catch {} })()
  const r = run('check-git-surface.mjs', ['--allow-no-gh'], d, { GATE_MIN_FILES: '1' })
  const inMsg = /\[提交信息\]/.test(r.out || '')
  results.push({ gate: `git-surface（提交信息含 ${W_PROCESS}，树干净）`, expect: 1, got: r.code, ok: r.code === 1 && inMsg, sample: inMsg ? '[提交信息] 命中' : '未命中提交信息' })
}
// 2) external-surface：包内文件含内部机制词 ⇒ 必须 exit 1
{
  const { d, env } = makeSimplePkg([])
  // 把内部机制词写进一个**会随包发布**的文件（files: lib/**）
  writeFileSync(join(d, 'lib', 'c.js'), `// ${W_MECH}\n`)
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'x'], { env })
  const r = run('check-external-surface.mjs', [], d, { GATE_MIN_FILES: '1' })
  results.push({ gate: `external-surface（包内含 ${W_MECH}）`, expect: 1, got: r.code, ok: r.code === 1 })
}
// 3) release-discipline：只改文档却升版本 ⇒ 必须 exit 1
{
  const { d, env } = makeSimplePkg([], '0.0.1')
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.2', files: ['lib/**'] }, null, 2))
  writeFileSync(join(d, 'CHANGELOG.md'), '## [0.0.2]\n\n- 只改文档\n\n## [0.0.1]\n\n- x\n')
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'docs: 0.0.2（只文档）'], { env })
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
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'init'], { env })
  return { d, env }
}

// 5) commit-hygiene：空提交 ⇒ 必须 exit 1
{
  const { d, env } = mkRepo()
  execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'chore: 空提交（负对照）'], { env })
  const r = run('check-commit-hygiene.mjs', ['--range', 'HEAD~1..HEAD'], d)
  results.push({ gate: 'commit-hygiene（空提交）', expect: 1, got: r.code, ok: r.code === 1 })
}


// 6) lockfile-consistency：负对照 N1–N4（peer 范围满足性 / 只改 lock 解析版本 / lock 缺条目 / 正例）
//     fixture：dep-a/dep-b 普通依赖、dep-c 开发依赖、dep-p 纯 peer（pnpm 把 peer 解析记在 lock 的 dependencies 段）
const LOCK_BASE = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      dep-a:',
  '        specifier: ^1.0.0',
  '        version: 1.2.0',
  '      dep-b:',
  '        specifier: ^2.0.0',
  '        version: 2.0.0',
  '      dep-p:',
  '        specifier: ^4.0.0',
  '        version: 4.1.0',
  '    devDependencies:',
  '      dep-c:',
  '        specifier: ^3.0.0',
  '        version: 3.0.0',
  '',
].join('\n')
const PKG_LOCK_BASE = {
  name: 'x',
  version: '0.0.1',
  dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^2.0.0' },
  devDependencies: { 'dep-c': '^3.0.0' },
  peerDependencies: { 'dep-p': '^4.0.0' },
}
function mkLockRepo(pkg, lock) {
  const d = mkdtempSync(join(tmpdir(), 'gate-lock-'))
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg, null, 2))
  writeFileSync(join(d, 'pnpm-lock.yaml'), lock)
  return d
}
function lockCase(label, pkg, lock, expect) {
  const d = mkLockRepo(pkg, lock)
  const r = run('check-lockfile-consistency.mjs', [], d)
  results.push({ gate: `lockfile-consistency ${label}`, expect, got: r.code, ok: r.code === expect })
  return r
}
// N1：peer 声明改 ^9.9.9，lock 不动（解析版本 4.1.0）⇒ 必须 exit 1
lockCase('N1（dependencies specifier 不一致 ^9.9.9 vs lock ^4.0.0）', { ...PKG_LOCK_BASE, dependencies: { 'dep-d': '^9.9.9' } }, LOCK_BASE, 1)
// N1b：把 lock 的 peer specifier 也同步成 ^9.9.9（只剩解析版本不满足）⇒ 必须 exit 1，证明不是靠 specifier 兜住
lockCase('N1b（optionalDependencies specifier 不一致）', { ...PKG_LOCK_BASE, optionalDependencies: { 'dep-o': '^9.9.9' } }, LOCK_BASE, 1)
// N2：package.json 完全不动，只把 lock 的解析版本 1.2.0 改成 2.0.0（不再满足 ^1.0.0）⇒ 必须 exit 1
lockCase('N2（解析版本落后 ⇒ WARN，exit 0）', PKG_LOCK_BASE, LOCK_BASE.replace('version: 1.2.0', 'version: 2.0.0'), 0)
// N3：lock 缺 dep-b 条目 ⇒ 必须 exit 1（本闸把"缺条目"判为不一致，不静默跳过）
lockCase('N3（lock 缺 dep-b 条目）', PKG_LOCK_BASE, LOCK_BASE.split('\n').filter((l) => !['      dep-b:', '        specifier: ^2.0.0', '        version: 2.0.0'].includes(l)).join('\n'), 1)
// N4：完全一致 ⇒ 必须 exit 0
lockCase('N4（完全一致，正例）', PKG_LOCK_BASE, LOCK_BASE, 0)
// 追加：声明与 lock specifier 逐字不一致（原有漏检场景，保留）⇒ 必须 exit 1
{
  const d = mkLockRepo(PKG_LOCK_BASE, LOCK_BASE.replace('specifier: ^3.0.0', 'specifier: ^0.9.0'))
  const r = run('check-lockfile-consistency.mjs', [], d)
  results.push({ gate: 'lockfile-consistency（声明 ^3.0.0 vs lock specifier ^0.9.0）', expect: 1, got: r.code, ok: r.code === 1 })
}
// 7) check-syntax：文件有语法错 ⇒ 必须 exit 1
{
  const d = mkdtempSync(join(tmpdir(), 'gate-syn-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q', d], { env })
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  mkdirSync(join(d, 'lib'), { recursive: true })
  writeFileSync(join(d, 'lib', 'bad.mjs'), 'export const = ;\n')
  const r = run('check-syntax.mjs', [], d)
  results.push({ gate: 'check-syntax（语法错文件）', expect: 1, got: r.code, ok: r.code !== 0 })
}
// 8) check-pkg-meta：缺 name/version ⇒ 必须非 0
{
  const d = mkdtempSync(join(tmpdir(), 'gate-meta-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q', d], { env })
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ files: ['lib/**'] }, null, 2))
  const r = run('check-pkg-meta.mjs', [], d)
  results.push({ gate: 'check-pkg-meta（缺 name/version）', expect: 1, got: r.code, ok: r.code !== 0 })
}


// 9) check-publish-entry：scripts 里直接 npm publish ⇒ 必须 exit 1
{
  const d = mkdtempSync(join(tmpdir(), 'gate-entry-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q', d], { env })
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.1', scripts: { 'publish:naive': 'npm publish' } }, null, 2))
  const r = run('check-publish-entry.mjs', [], d)
  results.push({ gate: 'check-publish-entry（裸 npm publish）', expect: 1, got: r.code, ok: r.code === 1 })
}
// 10) check-mechanism-drift：共享集内容不一致 ⇒ 必须 exit 1（清单驱动）
{
  const d = mkdtempSync(join(tmpdir(), 'gate-drift-'))
  const peer = mkdtempSync(join(tmpdir(), 'gate-drift-peer-'))
  cpSync(join(ROOT, 'scripts'), join(d, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'internal'), join(d, 'internal'), { recursive: true })
  // 对端：共享清单 + 词表 + 一个被改动的共享脚本
  mkdirSync(join(peer, 'scripts'), { recursive: true })
  mkdirSync(join(peer, 'internal'), { recursive: true })
  cpSync(join(ROOT, 'internal', 'shared-gates.json'), join(peer, 'internal', 'shared-gates.json'))
  cpSync(join(ROOT, 'internal', 'wordlist.json'), join(peer, 'internal', 'wordlist.json'))
  const src = readFileSync(join(ROOT, 'scripts', 'check-lockfile-consistency.mjs'), 'utf8')
  writeFileSync(join(peer, 'scripts', 'check-lockfile-consistency.mjs'), `${src}\nconst driftProbe = 1\n`)
  const r = run('check-mechanism-drift.mjs', ['--peer', peer], d)
  results.push({ gate: 'check-mechanism-drift（共享集内容不一致）', expect: 1, got: r.code, ok: r.code === 1 })
}


// ── 正对照（green）：干净场景必须 exit 0（防"闸恒判红"的替身）──────────────
function posCase(name, fn) {
  try { const got = fn(); results.push({ gate: name + '（绿色正对照）', expect: 0, got, ok: got === 0 }) }
  catch (e) { results.push({ gate: name + '（绿色正对照）', expect: 0, got: -1, ok: false }) }
}
// P1 external-surface：干净发布集 ⇒ 0
{
  const { d, env } = makeSimplePkg([], '0.0.1')
  writeFileSync(join(d, 'lib', 'clean.js'), 'export const c = 1\n')
  execFileSync('git', ['-C', d, 'add', '-A'], { env }); execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'clean'], { env })
  posCase('external-surface', () => run('check-external-surface.mjs', [], d, { GATE_MIN_FILES: '1' }).code)
}
// P2 commit-hygiene：干净提交 ⇒ 0
{
  const { d, env } = makeSimplePkg([], '0.0.1')
  writeFileSync(join(d, 'lib', 'clean2.js'), 'export const c2 = 1\n')
  execFileSync('git', ['-C', d, 'add', '-A'], { env })
  execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'chore: 正常提交'], { env })
  posCase('commit-hygiene', () => run('check-commit-hygiene.mjs', ['--range', 'HEAD~1..HEAD'], d).code)
}
// P3 lockfile：一致 ⇒ 0
posCase('lockfile-consistency', () => run('check-lockfile-consistency.mjs', [], join(ROOT)).code)
// P4 release-discipline：无版本变更 ⇒ 0
posCase('release-discipline', () => run('check-release-discipline.mjs', [], join(ROOT)).code)
// P5 review-record：合规记录（绑当前 treeSha）⇒ 0
{
  const { d, env } = makeSimplePkg([], '0.0.1')
  execFileSync('git', ['-C', d, 'commit', '--allow-empty', '-qm', 'chore: x'], { env })
  const tree = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  mkdirSync(join(d, 'internal', 'reviews'), { recursive: true })
  writeFileSync(join(d, 'internal', 'reviews', '0.0.1.json'), JSON.stringify({ version: '0.0.1', author: 'a', reviewer: 'b', verdict: 'pass', date: '2026-10-21', treeSha: tree, evidence: ['node x'] }))
  posCase('review-record', () => run('check-review-record.mjs', [], d).code)
}


// 6) mechanism-freshness：手册过期 ⇒ 必须 exit 1
{
  const { d } = mkRepo()
  const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs')
  const { join: j } = await import('node:path')
  mk(j(d, 'internal'), { recursive: true })
  wf(j(d, 'internal', '机制方法手册-v3.md'), '# outdated manual\n')
  const r = run('check-mechanism-freshness.mjs', [], d)
  results.push({ gate: 'mechanism-freshness（手册过期）', expect: 1, got: r.code, ok: r.code === 1 })
}

const bad = results.filter((r) => !r.ok)
console.log('闸负对照自检：')
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.gate} ｜ 期望 exit ${r.expect}，实际 ${r.got}${r.sample ? ` ｜ ${r.sample}` : ''}`)
if (bad.length) { console.log(`\n✗ ${bad.length}/${results.length} 道闸在违规场景下未判红 —— 视为该闸失效`); process.exit(1) }
console.log(`\n✅ ${results.length}/${results.length} 道闸在违规场景下都判红（负对照成立）`)
