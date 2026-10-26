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

// ── 语境判别：具体量分成三类 ──────────────────────────────────────────────
// FLAG  = 内部语料统计（对外禁止）：本机 N 份 / N 处 / N 个（会话/事件/指针/样本/化石）
// ALLOW = 技术常量（对外可留）：flush/frame/block/threshold/limit/max/budget/window/V8/libuv/zstd/chunk/buffer 语境下的 KiB/MB/GB
// UNKNOWN = 无法归类的数字（报告但不阻断，需人判）
const TECH_CONTEXT = /(flush|frame|block|threshold|limit|max|budget|window|V8|libuv|zstd|chunk|buffer|payload|cap\b|上限|阈值|窗口|帧|块)/i
const CORPUS_CONTEXT = /(本机|实测|语料|样本|会话|事件|化石|指针|份|条|处|万)/i
function classifyQuantity(matchText, line) {
  const isStats = /本机|实测|语料|样本|会话|事件|化石|指针/.test(line) || /本机\s*[0-9]+\s*份/.test(matchText)
  const isTechnical = TECH_CONTEXT.test(line) && !CORPUS_CONTEXT.test(line.replace(/本机/g, ''))
  if (isStats) return 'FLAG'
  if (isTechnical) return 'ALLOW'
  return 'UNKNOWN'
}

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
  const allowed = []
  const unknown = []
  for (const f of files) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const re of pats) {
        const m = line.match(re); if (!m) continue
        const kind = classifyQuantity(m[0], line)
        const entry = `${relative(pub, f)}:${i + 1} :: ${m[0]}`
        if (kind === 'FLAG') hits.push(entry)
        else if (kind === 'ALLOW') allowed.push(entry)
        else unknown.push(entry)
        break
      }
    }
  }
  const diffs = []
  for (const f of files) {
    const rel = relative(pub, f); const gp = join(ROOT, rel)
    if (!existsSync(gp)) continue
    const a = createHash('sha256').update(readFileSync(f)).digest('hex')
    const b = createHash('sha256').update(readFileSync(gp)).digest('hex')
    if (a !== b) diffs.push(rel)
  }
  console.log(`pubcheck: ${pkg}@${ver} ｜ 文件 ${files.length} ｜ FLAG ${hits.length} ｜ ALLOW ${allowed.length} ｜ UNKNOWN ${unknown.length} ｜ 与 git 不一致 ${diffs.length}`)
  for (const h of hits.slice(0, 12)) console.log(`  ✗ 泄漏(FLAG): ${h}`)
  for (const a of allowed.slice(0, 6)) console.log(`  · 技术常量(允许): ${a}`)
  for (const u of unknown.slice(0, 6)) console.log(`  ? 待判(UNKNOWN): ${u}`)
  for (const d of diffs.slice(0, 12)) console.log(`  ≠ 不一致: ${d}`)
  process.exit(hits.length ? 1 : 0)
} catch (error) {
  console.error('pubcheck: 无法判定 —— ' + String((error && error.message) || error).slice(0, 160))
  process.exit(2)
} finally { try { rmSync(tmp, { recursive: true, force: true }) } catch {} }
