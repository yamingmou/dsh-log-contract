#!/usr/bin/env node
/**
 * 手册新鲜度闸（mechanism freshness gate）
 *
 * 方法：用 scripts/mechanism-index.mjs 重新生成到临时文件，与仓库内的
 *       internal/机制方法手册-v3.md 逐字节比较；不一致 ⇒ exit 1（提示重新生成）。
 * 目的：防止"脚本改了、文档没改"（审查已列为 P1；且历史多次发生）。
 * 用法：node scripts/check-mechanism-freshness.mjs [--fix]
 * 退出码：0 一致 / 1 过期（--fix 可自动重生成）/ 2 无法判定
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const tracked = join(ROOT, 'internal', '机制方法手册-v3.md')
const fix = process.argv.includes('--fix')
if (!existsSync(join(ROOT, 'scripts', 'mechanism-index.mjs'))) { console.error('freshness: 无法判定 —— 缺 mechanism-index.mjs'); process.exit(2) }
const tmp = mkdtempSync(join(tmpdir(), 'fresh-'))
try {
  const out = join(tmp, 'manual.md')
  execFileSync('node', [join(ROOT, 'scripts', 'mechanism-index.mjs'), '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] })
  const fresh = readFileSync(out, 'utf8')
  const cur = existsSync(tracked) ? readFileSync(tracked, 'utf8') : null
  if (cur === fresh) { console.log('freshness: ok —— 手册与脚本一致'); process.exit(0) }
  if (fix) { execFileSync('node', [join(ROOT, 'scripts', 'mechanism-index.mjs')], { stdio: 'inherit' }); console.log('freshness: 已重新生成手册'); process.exit(0) }
  const a = (cur || '').split('\n'), b = fresh.split('\n')
  const missing = b.filter((l) => l.startsWith('| `scripts/') && !a.includes(l)).map((l) => l.split('`')[1])
  const extra = a.filter((l) => l.startsWith('| `scripts/') && !b.includes(l)).map((l) => l.split('`')[1])
  console.error('freshness: ✗ 手册过期')
  if (missing.length) console.error('  缺条目：', missing.join(', '))
  if (extra.length) console.error('  多条目：', extra.join(', '))
  console.error('  修复：node scripts/mechanism-index.mjs')
  process.exit(1)
} finally { rmSync(tmp, { recursive: true, force: true }) }
