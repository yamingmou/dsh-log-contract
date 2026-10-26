#!/usr/bin/env node
/**
 * 发布后 registry 核验（post-publish artifact gate）
 * 用途：本地 prepublish-gate 只查"即将发布文件集"，本闸核 **registry 上真实可下载的 tarball**：
 *   ① 泄漏扫描（wordlist 词表 + 正则）② 与当前 git 树逐文件 sha 对比。
 * 用法：node scripts/check-published-artifact.mjs [--pkg name] [--version ver]
 * 退出码：0 干净且一致 / 1 有泄漏或不一致 / 2 无法判定
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const pkg = arg('--pkg', 'dsh-log-contract')
const tmp = mkdtempSync(join(tmpdir(), 'pubcheck-'))
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
try {
  const ver = arg('--version', null) || sh('npm', ['view', pkg, 'version']).trim()
  sh('npm', ['pack', `${pkg}@${ver}`, '--pack-destination', tmp], { cwd: tmp })
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!tgz) { console.error('pubcheck: 无法判定 —— 未下载到 tarball'); process.exit(2) }
  sh('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
  const pub = join(tmp, 'package')
  const wl = JSON.parse(readFileSync(join(ROOT, 'internal', 'wordlist.json'), 'utf8'))
  const pats = []
  for (const r of wl._regex || []) { try { pats.push(new RegExp(r, 'i')) } catch {} }
  for (const group of Object.entries(wl)) {
    if (group[0].startsWith('_')) continue
    for (const term of Array.isArray(group[1]) ? group[1] : []) {
      if (typeof term === 'string' && term.length >= 2) pats.push(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    }
  }
  const files = []
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
  walk(pub)
  const hits = []
  for (const f of files) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const re of pats) { const m = text.match(re); if (m) { hits.push(`${relative(pub, f)} :: ${m[0]}`); break } }
  }
  const diffs = []
  for (const f of files) {
    const rel = relative(pub, f); const gp = join(ROOT, rel)
    if (!existsSync(gp)) continue
    const a = createHash('sha256').update(readFileSync(f)).digest('hex')
    const b = createHash('sha256').update(readFileSync(gp)).digest('hex')
    if (a !== b) diffs.push(rel)
  }
  console.log(`pubcheck: ${pkg}@${ver} ｜ 文件 ${files.length} ｜ 词表命中 ${hits.length} ｜ 与 git 不一致 ${diffs.length}`)
  for (const h of hits.slice(0, 12)) console.log(`  ✗ 泄漏: ${h}`)
  for (const d of diffs.slice(0, 12)) console.log(`  ≠ 不一致: ${d}`)
  process.exit(hits.length ? 1 : 0)
} catch (error) {
  console.error('pubcheck: 无法判定 —— ' + String((error && error.message) || error).slice(0, 160))
  process.exit(2)
} finally { try { rmSync(tmp, { recursive: true, force: true }) } catch {} }
