#!/usr/bin/env node
/**
 * 发布可追溯闸（release traceability gate）
 *
 * 判据（2026-10-21 事故）：**每个已发布到 npm 的版本，必须在仓库历史中有一个"可达提交"**
 * 且其 tree 与 npm tarball 的文件内容逐字节一致。
 *   1) 可达 = 从 refs（main / local/process / 任意分支）出发可 `git merge-base --is-ancestor` 或 `git log --all` 命中
 *   2) tarball == tree：下载 tarball，逐文件比对 sha256（tarball 里没有的文件忽略；tree 里被 package.json#files 排除的也忽略）
 *
 * 用法：node scripts/check-release-traceability.mjs [--version <v>] [--last N] [--offline-warn]
 * 退出码：0 全部可追溯 / 1 存在不可追溯 / 2 无法判定
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const vIdx = argv.indexOf('--version'); const wantV = vIdx >= 0 ? argv[vIdx + 1] : null
const lIdx = argv.indexOf('--last'); const lastN = lIdx >= 0 ? Number(argv[lIdx + 1]) : 3
const offlineWarn = argv.includes('--offline-warn')
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore','pipe','ignore'] })
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.name

// registry 版本列表
let versions = []
try {
  const out = execFileSync('npm', ['view', NAME, 'versions', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  versions = JSON.parse(out); if (!Array.isArray(versions)) versions = [versions]
} catch { if (offlineWarn) { console.log('traceability: 无法判定（registry 不可达，--offline-warn 放行）'); process.exit(0) } console.error('traceability: ✗ 无法判定（registry 不可达）'); process.exit(2) }
const targets = wantV ? [wantV] : versions.slice(-lastN)

// 找每个版本对应的可达提交
function commitForVersion(v) {
  const shas = git('log', '--all', '--format=%H').split('\n').filter(Boolean)
  for (const s of shas) {
    try { const p = JSON.parse(git('show', `${s}:package.json`)); if (p.version === v) return s } catch { /* 无 package.json */ }
  }
  return null
}
const bad = []
for (const v of targets) {
  const sha = commitForVersion(v)
  if (!sha) { bad.push({ v, why: '仓库中无可达提交的 package.json 版本匹配' }); continue }
  // 下载 tarball 比对
  const dir = mkdtempSync(join(tmpdir(), 'trace-'))
  try {
    execFileSync('bash', ['-lc', `cd '${dir}' && curl -sL --max-time 60 'https://registry.npmjs.org/${NAME}/-/${NAME}-${v}.tgz' -o p.tgz && tar -xzf p.tgz`], { stdio: 'ignore' })
    const pkgRoot = join(dir, 'package')
    const files = git('ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean)
    const diffs = []
    for (const f of files) {
      if (f.startsWith('internal/') || f.startsWith('reviews/') || f === 'pnpm-lock.yaml') continue
      const inTar = join(pkgRoot, f)
      if (!existsSync(inTar)) continue
      const a = createHash('sha256').update(git('cat-file', 'blob', `${sha}:${f}`)).digest('hex')
      const b = createHash('sha256').update(readFileSync(inTar)).digest('hex')
      if (a !== b) diffs.push(f)
    }
    if (diffs.length) bad.push({ v, sha, why: `tarball 与提交树不一致（${diffs.length} 文件，如 ${diffs.slice(0,3).join(', ')}）` })
  } catch (e) { bad.push({ v, sha, why: `无法比对（${String(e.message).slice(0, 60)}）` }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log(`traceability: 检查 ${targets.length} 个版本（${targets.join(', ')}）｜ 不可追溯 ${bad.length}`)
for (const b of bad) console.log(`  ✗ ${b.v}${b.sha ? ` @${b.sha.slice(0,8)}` : ''}：${b.why}`)
if (!bad.length) console.log('traceability: ok —— 每个版本都有可达提交且 tarball 与树一致')
process.exit(bad.length ? 1 : 0)
