#!/usr/bin/env node
/**
 * 机制漂移闸（mechanism drift gate）
 *
 * 方法：只比对 internal/shared-gates.json 里声明的**共享集**（脚本 + 数据文件）：
 *   - 共享集文件内容不一致 ⇒ FAIL（默认）/ WARN（--warn-only）
 *   - 共享集文件在对端缺失 ⇒ WARN（待移植，不视为违规）
 *   - 清单外的文件视为各仓专属，不比对（避免把专属闸当漂移噪音）
 * 退出码：0 通过（可带 WARN）/ 1 内容不一致 / 2 无法判定
 */
import { readFileSync, existsSync } from 'node:fs'
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
const listPath = join(ROOT, 'internal', 'shared-gates.json')
if (!existsSync(listPath)) { console.error('drift: 无法判定 —— 缺 internal/shared-gates.json（不允许全量盲比）'); process.exit(2) }
let manifest
try { manifest = JSON.parse(readFileSync(listPath, 'utf8')) } catch { console.error('drift: 无法判定 —— 共享清单不可解析'); process.exit(2) }
const shared = manifest.shared || [], sharedData = manifest.sharedData || []
if (!shared.length) { console.error('drift: 无法判定 —— 共享清单为空'); process.exit(2) }

const hash = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) } catch { return null } }
const diffs = [], missing = [], ok = []
for (const f of shared) {
  const a = join(ROOT, 'scripts', f), b = join(PEER, 'scripts', f)
  if (!existsSync(a)) { console.error(`drift: 无法判定 —— 本仓缺共享脚本 ${f}`); process.exit(2) }
  if (!existsSync(b)) { missing.push(f); continue }
  if (hash(a) === hash(b)) ok.push(f); else diffs.push(f)
}
const dataDiffs = [], dataMissing = []
for (const f of sharedData) {
  const a = join(ROOT, f), b = join(PEER, f)
  if (!existsSync(a)) continue
  if (!existsSync(b)) { dataMissing.push(f); continue }
  if (hash(a) !== hash(b)) dataDiffs.push(f)
}
const fails = [...diffs, ...dataDiffs]
const warns = [...missing, ...dataMissing]
console.log(`drift: 共享集 ${shared.length} 脚本 + ${sharedData.length} 数据 ｜ 一致 ${ok.length} ｜ 内容不一致 ${fails.length} ｜ 待移植 ${warns.length}`)
for (const f of fails) console.log(`  ✗ [FAIL] 内容不一致：${f}`)
for (const f of warns) console.log(`  ⚠ [WARN] 对端缺失（待移植）：${f}`)
for (const f of ok) console.log(`  ✓ ${f}`)
if (!fails.length && !warns.length) console.log('drift: ok —— 共享集完全一致')
else if (!fails.length) console.log('drift: ok（仅待移植 WARN）')
else if (WARN_ONLY) { console.log('drift: ⚠️ 存在内容不一致（--warn-only 不阻断）'); process.exit(0) }
process.exit(fails.length ? 1 : 0)
