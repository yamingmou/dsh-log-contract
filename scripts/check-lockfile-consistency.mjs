#!/usr/bin/env node
/**
 * 锁文件一致性闸（lockfile-consistency gate）
 *
 * 方法：逐条比对 package.json 的 dependencies/devDependencies 声明（specifier）
 *       与 pnpm-lock.yaml（v6/v9）中 importers..dependencies 的 specifier。
 *       分级：
 *         FAIL  specifier 不一致（声明改了、锁没刷新 ⇒ frozen-lockfile 必失败）
 *         WARN  解析到的版本不满足声明区间（锁里的 packages 段版本落后）
 *       退出码：0 通过（可带 WARN）/ 1 FAIL / 2 无法判定
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rIdx = argv.indexOf('--root')
const ROOT = rIdx >= 0 ? argv[rIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = argv.includes('--json')
const pkgPath = join(ROOT, 'package.json'), lockPath = join(ROOT, 'pnpm-lock.yaml')
if (!existsSync(pkgPath) || !existsSync(lockPath)) { console.error('lockfile: 无法判定 —— 缺 package.json 或 pnpm-lock.yaml'); process.exit(2) }
let pkg
try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { console.error('lockfile: 无法判定 —— package.json 不可解析'); process.exit(2) }
const lock = readFileSync(lockPath, 'utf8')

/** 解析 importers 下的 specifier：`      <name>:` 之后紧跟 `        specifier: <range>` */
function parseSpecifiers(text) {
  const map = new Map(); const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].match(/^(\s+)specifier:\s*(.+?)\s*$/)
    if (!sm) continue
    const indent = sm[1].length
    for (let j = i - 1; j >= 0 && j > i - 40; j--) {
      const km = lines[j].match(/^(\s*)(['"]?)(@?[\w@./-]+)\2:\s*$/)
      if (km && km[1].length < indent) { map.set(km[3], sm[2].replace(/^['"]|['"]$/g, '')); break }
      if (/^\s{0,2}\S/.test(lines[j]) && lines[j].trim()) break
    }
  }
  return map
}
/** 解析 packages 段的解析版本：`  <name>@<version>:` */
function parseResolved(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const m = line.match(/^ {2}(@?[^\s@]+)@(\d[^:()\s]*):\s*$/)
    if (m) { const a = map.get(m[1]) || []; a.push(m[2]); map.set(m[1], a) }
  }
  return map
}

/** 最小 range 判定：支持 ^x.y.z / ~x.y.z / 精确 / >=a <b / a || b */
function satisfies(version, range) {
  const v = version.split('-')[0].split('.').map(Number)
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0) } return 0 }
  return String(range).split('||').some((part) => {
    const p = part.trim()
    if (!p) return false
    if (p.startsWith('^')) {
      const b = p.slice(1).split('-')[0].split('.').map(Number)
      const hi = b[0] > 0 ? [b[0] + 1, 0, 0] : b[1] > 0 ? [0, b[1] + 1, 0] : [0, 0, b[2] + 1]
      return cmp(v, b) >= 0 && cmp(v, hi) < 0
    }
    if (p.startsWith('~')) {
      const b = p.slice(1).split('-')[0].split('.').map(Number)
      return cmp(v, b) >= 0 && cmp(v, [b[0], b[1] + 1, 0]) < 0
    }
    if (/^[<>=]/.test(p)) {
      const toks = p.split(/\s+/).filter(Boolean)
      return toks.every((t) => {
        const m = t.match(/^(>=|<=|>|<|=)?\s*(\d[\w.-]*)$/)
        if (!m) return true
        const b = m[2].split('-')[0].split('.').map(Number); const c = cmp(v, b)
        switch (m[1] || '=') { case '>=': return c >= 0; case '<=': return c <= 0; case '>': return c > 0; case '<': return c < 0; default: return c === 0 }
      })
    }
    if (/^\d/.test(p)) { const b = p.split('-')[0].split('.').map(Number); return cmp(v, b) === 0 }
    return true
  })
}

const spec = parseSpecifiers(lock)
const resolved = parseResolved(lock)
const MIN_SPEC = Number(process.env.GATE_MIN_SPECIFIERS || 3)
if (spec.size < MIN_SPEC) { console.error(`lockfile: 无法判定 —— 只解析出 ${spec.size} 个 specifier（下限 ${MIN_SPEC}，格式不识别或小仓）`); process.exit(2) }

const sections = ['dependencies', 'devDependencies']
const fails = [], warns = []
let checked = 0
for (const sec of sections) {
  for (const [name, want] of Object.entries(pkg[sec] || {})) {
    checked++
    const got = spec.get(name)
    if (got === undefined) { fails.push({ sec, name, want, got: '(lock 中缺失)' }); continue }
    if (got !== want) fails.push({ sec, name, want, got })
    const rv = resolved.get(name) || []
    if (rv.length && !rv.some((v) => satisfies(v, want))) warns.push({ sec, name, want, rv })
  }
}
if (asJson) console.log(JSON.stringify({ ok: fails.length === 0, checked, specifiers: spec.size, fails, warns }, null, 2))
else {
  console.log(`lockfile: 检查 ${checked} 个声明 ｜ lock specifier ${spec.size} ｜ FAIL ${fails.length} ｜ WARN ${warns.length}`)
  for (const f of fails) console.log(`  ✗ [FAIL] ${f.sec}.${f.name}：package.json=${f.want} ｜ lock=${f.got}`)
  for (const w of warns) console.log(`  ⚠ [WARN] ${w.sec}.${w.name}：锁解析 ${w.rv.join('|')} 不满足 ${w.want}`)
  if (!fails.length && !warns.length) console.log('lockfile: ok —— 声明与锁文件一致（frozen-lockfile 可过）')
  else if (!fails.length) console.log('lockfile: ok（有 WARN：解析版本落后，建议 pnpm install 刷新）')
}
process.exit(fails.length ? 1 : 0)
