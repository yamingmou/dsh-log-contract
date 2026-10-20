#!/usr/bin/env node
/**
 * 对外信息检查闸（external surface gate）
 *
 * 检查 package.json#files 白名单内的**会随包发布的内容**不得含内部信息。
 * 内部词一律来自 internal/wordlist.json（单一词表）—— 本文件自身不得内嵌内部词（否则自伤）。
 * 形态类规则（本机落点/会话标识/事件坐标）内联；词表缺失 ⇒ exit 2（不允许静默弱化）。
 *
 * 用法：node scripts/check-external-surface.mjs [--root <dir>] [--json]
 * 退出码：0 通过 / 1 命中 / 2 无法判定
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : join(here, '..')
const asJson = argv.includes('--json')

// ── 1) 词表（必须在扫描之前载入）──────────────────────────────
const wlPath = [join(ROOT, 'internal', 'wordlist.json'), join(here, '..', 'internal', 'wordlist.json')].find(existsSync)
if (!wlPath) { console.error('external-surface: 无法判定 —— 缺 internal/wordlist.json'); process.exit(2) }
let wl
try { wl = JSON.parse(readFileSync(wlPath, 'utf8')) } catch (e) { console.error('external-surface: 词表不可解析 ——', e.message); process.exit(2) }
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const FORMS = [
  ['本机落点', /\/Users\/[A-Za-z0-9._-]{3,}|~\/dsh-v\d|\/private\/tmp/],
  ['会话标识', /session-[0-9a-f]{8}-[0-9a-f]{4}/],
  ['疑似事件坐标', /\bseq\s*[:=]\s*\d{5,}/],
]
for (const [cat, words] of Object.entries(wl)) {
  if (cat.startsWith('_') || !Array.isArray(words) || !words.length) continue
  FORMS.push([`词表·${cat}`, new RegExp(words.map(esc).join('|'))])
}
for (const re of (Array.isArray(wl._regex) ? wl._regex : [])) FORMS.push(['词表·正则', new RegExp(re)])

// ── 2) 发布集（package.json#files 展开）────────────────────────
function pkgFiles() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return pkg.files || ['lib/**', 'README.md', 'LICENSE', 'package.json']
  } catch { return null }
}
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.ts', '.d.ts'])
function* walk(p) { const st = statSync(p); if (st.isFile()) { yield p; return } for (const e of readdirSync(p)) yield* walk(join(p, e)) }
function expand(pattern) {
  const base = pattern.replace(/\/\*\*?.*$/, '').replace(/\*$/, '')
  try { return [...walk(join(ROOT, base))] } catch { return [] }
}

const files = pkgFiles()
if (!files) { console.error('external-surface: 无法判定 —— package.json 不可读'); process.exit(2) }
const seen = new Set()
for (const f of files) { if (f.startsWith('!')) continue; for (const file of expand(f)) seen.add(file) }
const MINF = Number(process.env.GATE_MIN_FILES || 5)
if (seen.size < MINF) { console.error(`external-surface: 无法判定 —— 只解析出 ${seen.size} 个文件（下限 ${MINF}）（错目录/白名单失效）`); process.exit(2) }

const hits = []
for (const file of seen) {
  if (!TEXT.has(extname(file)) && !file.endsWith('.d.ts')) continue
  const text = readFileSync(file, 'utf8')
  for (const [label, re] of FORMS) { const m = text.match(re); if (m) hits.push({ file: relative(ROOT, file), label, sample: m[0].slice(0, 40) }) }
}
if (asJson) console.log(JSON.stringify({ ok: hits.length === 0, scanned: seen.size, hits }, null, 2))
else {
  console.log(`external-surface: 扫描 ${seen.size} 个文件 ｜ 命中 ${hits.length} 处 ｜ 词表 ${wlPath.includes('internal') ? '已载入' : '缺'}`)
  for (const h of hits.slice(0, 12)) console.log(`  ✗ [${h.label}] ${h.file} — "${h.sample}"`)
  if (!hits.length) console.log('external-surface: ok —— 对外内容零内部信息')
}
process.exit(hits.length ? 1 : 0)
