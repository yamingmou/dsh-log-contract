#!/usr/bin/env node
/**
 * 锁文件一致性闸（lockfile-consistency gate）
 * 抓的正是 2026-10-20 的 P0：package.json 要求 ^0.3.18，pnpm-lock 仍是 ^0.3.12
 * 判据：package.json 的 dependencies/peerDependencies/devDependencies 中每个包的声明范围，
 *       必须与 pnpm-lock.yaml 中该包的 `specifier` 完全一致。
 * 退出码：0 一致 / 1 不一致（逐条列出）/ 2 无法判定（缺文件/格式不识别）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(ROOT, 'package.json'), lockPath = join(ROOT, 'pnpm-lock.yaml')
if (!existsSync(pkgPath) || !existsSync(lockPath)) { console.error('lockfile: 无法判定 —— 缺 package.json 或 pnpm-lock.yaml'); process.exit(2) }
let pkg; try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) { console.error('lockfile: package.json 不可解析'); process.exit(2) }
const lock = readFileSync(lockPath, 'utf8')
// 解析 pnpm-lock v9：形如 "  pkg:\n    specifier: ^x\n    version: ..."
const spec = new Map()
const re = /^\s{2}(@?[^\s:]+):\s*$/gm
let m
const lines = lock.split('\n')
for (let i = 0; i < lines.length; i++) {
  const mm = lines[i].match(/^  (\S+):\s*$/)
  if (!mm) continue
  const name = mm[1].replace(/^['"]|['"]$/g, '')
  for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
    const sm = lines[j].match(/^\s{4}specifier:\s*(.+?)\s*$/)
    if (sm) { spec.set(name, sm[1].replace(/^['"]|['"]$/g, '')); break }
    if (/^\s{2}\S/.test(lines[j])) break
  }
}
if (spec.size < 3) { console.error(`lockfile: 无法判定 —— 只解析出 ${spec.size} 个 specifier（格式不识别）`); process.exit(2) }
const sections = ['dependencies', 'peerDependencies', 'devDependencies']
const bad = []
for (const sec of sections) {
  for (const [name, want] of Object.entries(pkg[sec] || {})) {
    const got = spec.get(name)
    if (got === undefined) { bad.push({ sec, name, want, got: '(lock 中缺失)' }); continue }
    if (got !== want) bad.push({ sec, name, want, got })
  }
}
console.log(`lockfile: 检查 ${sections.reduce((n, s) => n + Object.keys(pkg[s] || {}).length, 0)} 个声明 ｜ lock specifier ${spec.size} 个 ｜ 不一致 ${bad.length}`)
for (const b of bad) console.log(`  ✗ ${b.sec}.${b.name}：package.json=${b.want} ｜ lock=${b.got}`)
if (!bad.length) console.log('lockfile: ok —— 声明与锁文件一致（frozen-lockfile 可过）')
process.exit(bad.length ? 1 : 0)
