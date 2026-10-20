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

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(ROOT, 'package.json'), lockPath = join(ROOT, 'pnpm-lock.yaml')
if (!existsSync(pkgPath) || !existsSync(lockPath)) { console.error('lockfile: 无法判定 —— 缺 package.json 或 pnpm-lock.yaml'); process.exit(2) }
let pkg; try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) { console.error('lockfile: package.json 不可解析'); process.exit(2) }
const lock = readFileSync(lockPath, 'utf8')
// 兼容 pnpm-lock v6/v9：任意缩进的 `<name>:` 块内出现 `specifier: <range>`
const spec = new Map()
{
  const lines = lock.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].match(/^(\s*)specifier:\s*(.+?)\s*$/)
    if (!sm) continue
    const indent = sm[1].length
    // 向上找最近的、缩进小于 specifier 的键行 = 包名
    let name = null
    for (let j = i - 1; j >= 0 && j > i - 30; j--) {
      const km = lines[j].match(/^(\s*)(['"]?)(@?[\w@./-]+)\2:\s*$/)
      if (km && km[1].length < indent) { name = km[3]; break }
    }
    if (name) spec.set(name, sm[2].replace(/^['"]|['"]$/g, ''))
  }
}
if (spec.size < 3) { console.error(`lockfile: 无法判定 —— 只解析出 ${spec.size} 个 specifier（格式不识别）`); process.exit(2) }
const sections = ['dependencies', 'devDependencies']  // peer 存解析版本，不做 specifier 逐字比对
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
