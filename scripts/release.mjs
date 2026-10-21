#!/usr/bin/env node
/**
 * 唯一发布入口（single release entry）
 *
 * 制度：**不得直接 `npm publish`**。发布一律走本脚本。
 * 单一事实源：所有"该跑什么检查"只在 `scripts/pre-publish.mjs` 里定义一次，本脚本只负责
 *   ①前置（干净/未发布）→ ②调用 pre-publish（全绿才继续）→ ③独立审核记录 → ④发布 → ⑤发布后复验
 * 用法：node scripts/release.mjs [--dry-run] [--skip-tests]
 * 退出码：0 成功 / 1 被闸拒绝 / 2 环境问题
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const __pkg = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = __pkg.name
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const SKIP_TESTS = argv.includes('--skip-tests')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const node = (script, args = []) => spawnSync('node', [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
const cmd = (c, a) => spawnSync(c, a, { cwd: ROOT, encoding: 'utf8' })
const fail = (m, code = 1) => { console.error(`\n✗ 发布中止：${m}`); process.exit(code) }

// ① 前置
{
  const st = cmd('git', ['status', '--porcelain'])
  if (st.status !== 0) fail('git status 失败（exit 2）', 2)
  if ((st.stdout || '').trim()) fail(`工作区有未提交改动（${(st.stdout || '').trim().split('\n').length} 处）—— 发布内容必须等于仓库内容`)
  const seen = cmd('npm', ['view', `${PKG_NAME}@${version}`, 'version'])
  if (seen.status === 0 && (seen.stdout || '').includes(version)) fail(`版本 ${version} 已存在于 npm —— 请先升版本号（版本号只用于功能与修复）`)
  console.log(`[release] 前置通过：工作区干净 ｜ 版本 ${version} 未发布`)
}

// ② 发布前检查（单一事实源）
console.log('[release] 运行发布前检查（scripts/pre-publish.mjs）…')
{
  const args = ['scripts/pre-publish.mjs', '--release']
  if (SKIP_TESTS) args.push('--skip-tests')
  const r = spawnSync('node', args.map((a) => (a.startsWith('--') ? a : join(ROOT, a))), { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
  if (r.status !== 0) fail(`发布前检查未通过（exit ${r.status}）—— 报告见 internal/release-reports/`)
}

// ③ 独立审核记录（内容级：reviewer≠author / verdict=pass / evidence 非空）
console.log('[release] 检查独立审核记录…')
if (node('scripts/check-review-record.mjs').status !== 0) fail('独立审核记录不合规')

if (DRY) { console.log('\n✅ --dry-run：全部前置与检查通过，未发布'); process.exit(0) }

// ④ 发布
console.log('[release] 发布…')
{
  const r = spawnSync('npm', ['publish', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
  if (r.status !== 0) fail('npm publish 失败')
}

// ⑤ 发布后复验（退避等 registry 传播）
console.log('[release] 发布后复验…')
let reg = null
for (let i = 0; i < 12; i++) {
  const r = cmd('node', ['-e', `const d=await (await fetch('https://registry.npmjs.org/' + PKG_NAME)).json();console.log(JSON.stringify(d))`])
  if (r.status === 0) { try { reg = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch {} }
  if (reg?.versions?.[version]) break
  console.log(`  … registry 暂不可见 ${i + 1}/12，等 20s`)
  execFileSync('sleep', ['20'])
}
if (!reg?.versions?.[version]) fail('registry 里查不到刚发布的版本')
const url = reg.versions[version].dist.tarball
const dir = mkdtempSync(join(tmpdir(), 'rel-check-'))
execFileSync('bash', ['-lc', `curl -sL '${url}' -o '${dir}/p.tgz' && tar -xzf '${dir}/p.tgz' -C '${dir}'`], { stdio: 'inherit' })
if (node('scripts/check-external-surface.mjs', ['--root', join(dir, 'package')]).status !== 0) fail('已发布 tarball 的对外信息检查未通过')
mkdirSync(join(ROOT, 'internal', 'release-reports'), { recursive: true })
const rec = { repo: PKG_NAME, version, at: new Date().toISOString(), gitHead: (cmd('git', ['rev-parse', 'HEAD']).stdout || '').trim(), tarball: url, gates: 'pre-publish green + review record pass + tarball re-scanned' }
const rp = join(ROOT, 'internal', 'release-reports', `${version}-release-${Date.now()}.json`)
writeFileSync(rp, JSON.stringify(rec, null, 2))
console.log(`\n✅ 发布完成：${version} ｜ tarball 已复验 ｜ 记录 ${rp.replace(ROOT + '/', '')}`)
