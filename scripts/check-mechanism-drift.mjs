#!/usr/bin/env node
/**
 * 机制漂移闸（mechanism drift gate）
 *
 * 方法：比较"本仓 mechanism 脚本集合"与"对端仓（--peer）的脚本集合"，
 *       以及两边 internal/wordlist.json 的内容是否一致。
 *       缺失/多出/内容不一致 ⇒ 违规（默认 FAIL；--warn-only 降级为 WARN）。
 * 用途：dsh-log-contract 与 dsh-retrace 共用一套闸时，防止一边改了另一边没跟。
 * 用法：node scripts/check-mechanism-drift.mjs --peer <目录> [--warn-only] [--json]
 * 退出码：0 一致 / 1 漂移 / 2 无法判定（对端不可读）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const pIdx = argv.indexOf('--peer')
const PEER = pIdx >= 0 ? argv[pIdx + 1] : null
const WARN_ONLY = argv.includes('--warn-only')
if (!PEER) { console.error('drift: 无法判定 —— 需 --peer <目录>'); process.exit(2) }
if (!existsSync(join(PEER, 'scripts'))) { console.error(`drift: 无法判定 —— 对端无 scripts/：${PEER}`); process.exit(2) }

const list = (d) => readdirSync(join(d, 'scripts')).filter((f) => f.endsWith('.mjs')).sort()
const mine = list(ROOT), theirs = list(PEER)
const missing = mine.filter((f) => !theirs.includes(f))   // 本仓有、对端缺
const extra = theirs.filter((f) => !mine.includes(f))     // 对端有、本仓缺
const hash = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) } catch { return null } }
const differs = mine.filter((f) => theirs.includes(f) && hash(join(ROOT, 'scripts', f)) !== hash(join(PEER, 'scripts', f)))
const wlA = hash(join(ROOT, 'internal', 'wordlist.json')), wlB = hash(join(PEER, 'internal', 'wordlist.json'))
const wlDiff = wlA && wlB && wlA !== wlB
const problems = []
if (missing.length) problems.push(`本仓有、对端缺：${missing.join(', ')}`)
if (extra.length) problems.push(`对端有、本仓缺：${extra.join(', ')}`)
if (differs.length) problems.push(`同名但内容不同：${differs.join(', ')}`)
if (wlDiff) problems.push(`词表不一致：${wlA} ≠ ${wlB}`)
const status = problems.length === 0 ? 'ok' : (WARN_ONLY ? 'warn' : 'fail')
console.log(`drift: 本仓 ${mine.length} 个脚本 ｜ 对端 ${theirs.length} 个 ｜ 缺失 ${missing.length} ｜ 多出 ${extra.length} ｜ 内容不同 ${differs.length} ｜ 词表一致 ${!wlDiff}`)
for (const p of problems.slice(0, 8)) console.log(`  ✗ ${p}`)
if (status === 'ok') console.log('drift: ok —— 两仓机制一致')
else if (status === 'warn') { console.log('drift: ⚠️ 存在漂移（--warn-only）'); process.exit(0) }
else { console.log('drift: ✗ 存在漂移'); process.exit(1) }
