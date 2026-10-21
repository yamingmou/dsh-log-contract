#!/usr/bin/env node
/**
 * 锁文件一致性闸（lockfile-consistency gate）
 * 抓的正是 2026-10-20 的 P0：package.json 要求 ^0.3.18，pnpm-lock 仍是 ^0.3.12
 * 判据（三条同时成立才算一致）：
 *   1) dependencies/devDependencies 的声明范围必须与 lock 中该包的 specifier 完全一致；
 *   2) dependencies/devDependencies 的 lock 解析版本必须满足声明范围；
 *   3) peerDependencies 的 lock 解析版本必须满足声明范围。
 * pnpm 不单独记录 peer 的 specifier（peer 的解析落在 lock 的 dependencies/devDependencies 段），
 * 所以 peer 以「解析版本满足声明范围」为准；同包若也声明为普通依赖，其 specifier 已在第 1 条校验，
 * 未被声明为普通依赖的纯 peer 则顺带逐字校验 lock specifier。任一条不满足 ⇒ exit 1。
 * 判定不了解析版本时不静默跳过：lock 缺该包条目按不一致处理（exit 1），
 * 版本是 link:/file:/workspace: 或无法解析按无法判定处理（exit 2）。
 * 版本比较是自带的极小 semver 子集：支持 ^x.y.z、~x.y.z、>=a <b、=x.y.z、* 与 || 组合，
 * 并遵守预发布规则（预发布版本需同 major.minor.patch 的比较器本身带预发布才可满足）。
 * 命令行：--root <dir> 可指定仓库根（默认本仓）。
 * 退出码：0 一致 / 1 不一致（逐条列出）/ 2 无法判定（缺文件/格式不识别）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(ROOT, 'package.json'), lockPath = join(ROOT, 'pnpm-lock.yaml')
if (!existsSync(pkgPath) || !existsSync(lockPath)) { console.error('lockfile: 无法判定 —— 缺 package.json 或 pnpm-lock.yaml'); process.exit(2) }
let pkg
try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { console.error('lockfile: package.json 不可解析'); process.exit(2) }
const lockText = readFileSync(lockPath, 'utf8')

const unquote = (s) => String(s).replace(/^['"]|['"]$/g, '')
const normRange = (s) => unquote(s).replace(/\s+/g, ' ').trim()

// ── lock 解析（pnpm-lock v9/v6 的 importers 段结构相同）──────────────────────
// 只取根 importer（`.`）的分段表：{ dependencies: { 包名: { specifier, version } }, ... }
function parseImporters(text) {
  const out = new Map()
  let inImporters = false, importer = null, section = null, name = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const kv = t.match(/^(['"]?)([^'":]+)\1:\s*(.*)$/)
    if (!kv) continue
    const key = unquote(kv[2].trim()), val = kv[3].trim()
    if (indent === 0) { inImporters = key === 'importers'; importer = section = name = null; continue }
    if (!inImporters) continue
    if (indent === 2) { importer = key; section = name = null; if (!out.has(key)) out.set(key, {}); continue }
    if (!importer) continue
    const box = out.get(importer)
    if (indent === 4) { section = key; name = null; if (!box[section]) box[section] = {}; continue }
    if (indent === 6 && section) { name = key; box[section][name] = {}; continue }
    if (indent === 8 && section && name) {
      const e = box[section][name]
      if (key === 'specifier' || key === 'version') e[key] = unquote(val)
    }
  }
  return out
}

const importers = parseImporters(lockText)
const imp = importers.get('.')
if (!imp) {
  console.error(`lockfile: 无法判定 —— pnpm-lock 中找不到根 importer「.」（实际：${[...importers.keys()].join(', ') || '无'}）`)
  process.exit(2)
}

// ── 极小 semver 子集（不引依赖）────────────────────────────────────────────
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
function parseVersion(s) {
  const m = String(s).trim().match(VERSION_RE)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
function comparePre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; continue }
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
function compareVersion(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  return comparePre(a.pre, b.pre)
}
function comparatorBounds(op, s) {
  const v = parseVersion(s)
  if (!v) return null
  const hiOfCaret = v.major > 0
    ? { major: v.major + 1, minor: 0, patch: 0, pre: [] }
    : (v.minor > 0 ? { major: 0, minor: v.minor + 1, patch: 0, pre: [] } : { major: 0, minor: 0, patch: v.patch + 1, pre: [] })
  if (op === '^') return { lo: v, loInc: true, hi: hiOfCaret }
  if (op === '~') return { lo: v, loInc: true, hi: { major: v.major, minor: v.minor + 1, patch: 0, pre: [] } }
  if (op === '>=') return { lo: v, loInc: true }
  if (op === '>') return { lo: v, loInc: false }
  if (op === '<=') return { hi: v, hiInc: true }
  if (op === '<') return { hi: v, hiInc: false }
  return { lo: v, loInc: true, hi: v, hiInc: true }
}
// 单条 `||` 分支 → 比较器数组；不认识的写法返回 null（上层按"无法判定"处理）
function parseComparatorSet(set) {
  const tokens = set.trim().split(/\s+/).filter(Boolean)
  const comps = []
  for (const tok of tokens) {
    if (tok === '*' || tok === 'x' || tok === 'X') continue
    const m = tok.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)
    if (!m) return null
    comps.push({ op: m[1] || '=', ver: m[2] })
  }
  return comps
}
function setSatisfies(v, comps) {
  const tuple = `${v.major}.${v.minor}.${v.patch}`
  const admitsPre = comps.some((c) => { const cv = parseVersion(c.ver); return cv.pre.length && `${cv.major}.${cv.minor}.${cv.patch}` === tuple })
  if (v.pre.length && !admitsPre) return false
  for (const c of comps) {
    const b = comparatorBounds(c.op, c.ver)
    if (b.lo) { const d = compareVersion(v, b.lo); if (b.loInc ? d < 0 : d <= 0) return false }
    if (b.hi) { const d = compareVersion(v, b.hi); if (b.hiInc ? d > 0 : d >= 0) return false }
  }
  return true
}
// true=满足 / false=确定不满足 / undefined=范围写法不支持（无法判定）
function rangeSatisfied(version, range) {
  const v = parseVersion(version)
  if (!v) return undefined
  const sets = String(range).split('||').map((s) => s.trim()).filter(Boolean)
  if (!sets.length) return undefined
  let known = false
  for (const set of sets) {
    const comps = parseComparatorSet(set)
    if (!comps) continue
    known = true
    if (setSatisfies(v, comps)) return true
  }
  return known ? false : undefined
}

// lock 的 version 字段可能是 `1.2.3(peer@x)` / `1.2.3(...)`；link/file/workspace 不可比较
function resolvedVersion(raw) {
  if (!raw) return null
  const v = unquote(String(raw))
  if (/^(link:|file:|workspace:|portal:|npm:)/.test(v)) return null
  const m = v.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
  return m ? m[1] : null
}

// ── 逐条比对 ────────────────────────────────────────────────────────────────
const DECL_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies']
const LOCK_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
const declCount = DECL_SECTIONS.reduce((n, s) => n + Object.keys(pkg[s] || {}).length, 0)
const lockSpecCount = LOCK_SECTIONS.reduce((n, s) => n + Object.values(imp[s] || {}).filter((e) => e.specifier !== undefined).length, 0)
if (declCount > 0 && lockSpecCount === 0) {
  console.error(`lockfile: 无法判定 —— package.json 声明 ${declCount} 个包，但 pnpm-lock 根 importer 解析出 0 个 specifier（格式不识别）`)
  process.exit(2)
}

const bad = [], unknown = [], okRows = []
for (const sec of DECL_SECTIONS) {
  for (const [name, wantRaw] of Object.entries(pkg[sec] || {})) {
    const want = String(wantRaw)
    let entry = null, from = null
    if (imp[sec] && imp[sec][name]) { entry = imp[sec][name]; from = sec }
    else for (const s of LOCK_SECTIONS) { if (imp[s] && imp[s][name]) { entry = imp[s][name]; from = s; break } }
    if (!entry) { bad.push({ sec, name, want, got: '(lock 中缺失)', why: 'lock 缺该包条目（冻结安装无法通过）' }); continue }
    if (LOCK_SECTIONS.includes(sec)) {
      if (from !== sec) { bad.push({ sec, name, want, got: `(只在 lock.${from})`, why: '声明段与 lock 段不一致' }); continue }
      if (entry.specifier === undefined) { unknown.push(`${sec}.${name}：lock 条目缺 specifier`); continue }
      if (normRange(entry.specifier) !== normRange(want)) { bad.push({ sec, name, want, got: entry.specifier, why: 'specifier 与声明不一致' }); continue }
    } else {
      // peer：pnpm 把 peer 解析记在 dependencies/devDependencies 段；纯 peer 的 lock specifier 才是 peer 声明本身
      const alsoPlain = pkg.dependencies?.[name] !== undefined || pkg.devDependencies?.[name] !== undefined
      if (!alsoPlain && entry.specifier !== undefined && normRange(entry.specifier) !== normRange(want)) {
        bad.push({ sec, name, want, got: entry.specifier, why: 'peer 的 lock specifier 与声明不一致' }); continue
      }
    }
    const resolved = resolvedVersion(entry.version)
    if (!resolved) { unknown.push(`${sec}.${name}：lock 解析版本不可判定（${entry.version || '缺 version'}）`); continue }
    const sat = rangeSatisfied(resolved, want)
    if (sat === undefined) { unknown.push(`${sec}.${name}：声明范围 ${want} 不在本闸支持的 semver 子集内`); continue }
    if (!sat) { bad.push({ sec, name, want, got: `${from}=${entry.version}`, why: `解析版本 ${resolved} 不满足声明范围` }); continue }
    okRows.push(`  ✓ ${sec}.${name}：声明 ${want} ｜ lock ${resolved}（一致）`)
  }
}

console.log(`lockfile: 检查 ${declCount} 个声明 ｜ lock specifier ${lockSpecCount} 个 ｜ 不一致 ${bad.length} ｜ 无法判定 ${unknown.length}`)
for (const b of bad) console.log(`  ✗ ${b.sec}.${b.name}：package.json=${b.want} ｜ lock=${b.got} ｜ ${b.why}`)
for (const u of unknown) console.log(`  ? ${u}`)
if (!bad.length && !unknown.length) {
  for (const row of okRows) console.log(row)
  console.log('lockfile: ok —— 声明与锁文件一致（frozen-lockfile 可过）')
  process.exit(0)
}
if (bad.length) { console.error(`lockfile: ✗ ${bad.length} 处不一致`); process.exit(1) }
console.error(`lockfile: 无法判定 —— ${unknown.length} 处解析版本不可比较`)
process.exit(2)
