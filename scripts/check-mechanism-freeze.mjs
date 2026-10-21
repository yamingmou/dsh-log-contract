#!/usr/bin/env node
/**
 * 机制冻结基线校验（mechanism freeze gate）
 * 方法：internal/mechanism-freeze.json 记录的 head/脚本集合 必须与当前一致；
 *       不一致 ⇒ exit 1（提示重新生成），防止"手写冻结文件过期"。
 * 用法：node scripts/check-mechanism-freeze.mjs [--update]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const F = join(ROOT, 'internal', 'mechanism-freeze.json')
const update = process.argv.includes('--update')
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim()
const wlSha = (() => { try { return execFileSync('shasum', ['-a', '256', join(ROOT, 'internal', 'wordlist.json')], { encoding: 'utf8' }).trim().split(/\s+/)[0] } catch { return null } })()
const state = () => ({ generatedAt: new Date().toISOString(), mechanismFiles: readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).sort(), wordlistSha: wlSha })
if (update) { writeFileSync(F, JSON.stringify(state(), null, 2) + '\n'); console.log('freeze: 已更新基线'); process.exit(0) }
if (!existsSync(F)) { console.error('freeze: ✗ 缺 internal/mechanism-freeze.json（先 --update）'); process.exit(1) }
const rec = JSON.parse(readFileSync(F, 'utf8')); const cur = state()
const probs = []
if (rec.wordlistSha && cur.wordlistSha && rec.wordlistSha !== cur.wordlistSha) probs.push(`词表变化：${String(rec.wordlistSha).slice(0,12)} ≠ ${String(cur.wordlistSha).slice(0,12)}`)
const a = new Set(rec.mechanismFiles || []), b = new Set(cur.mechanismFiles)
for (const f of b) if (!a.has(f)) probs.push(`新增脚本未入基线：${f}`)
for (const f of a) if (!b.has(f)) probs.push(`基线里的脚本已删除：${f}`)
if (!probs.length) { console.log('freeze: ok —— 机制基线与当前一致'); process.exit(0) }
for (const p of probs) console.error(`  ✗ ${p}`)
console.error('freeze: ✗ 基线过期（node scripts/check-mechanism-freeze.mjs --update）')
process.exit(1)
