#!/usr/bin/env node
/**
 * 两仓机制件漂移闸（check-mechanism-drift）
 *
 * 方法：扫描两仓的机制脚本目录（scripts/、internal/scripts/），按**文件名**配对，
 *       逐字比较两边都存在的同名脚本；归一化后仍不同 ⇒ exit 1（列文件 + 首个差异行）。
 *       单侧独有的脚本只登记、不比对（没有对端副本可比）。
 *       已登记的**非逻辑差异**（注释/路径常量等）按行模式放行，见 ALLOW_LINE。
 * 判定：任一机制脚本目录不可读（含对端仓/对端 scripts/ 不存在）⇒ exit 2 —— 无法判定，
 *       不许当成通过，也不许静默跳过。
 * 用法：node scripts/check-mechanism-drift.mjs [--peer <path>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const pi = argv.indexOf('--peer')
if (pi >= 0 && (!argv[pi + 1] || argv[pi + 1].startsWith('--'))) {
  console.error('drift: 无法判定 —— --peer 缺路径参数')
  process.exit(2)
}
const PEER = pi >= 0 ? argv[pi + 1] : join(ROOT, '..', 'dsh-retrace-private')

/** 机制脚本目录（相对仓库根）。`scripts/` 必备；`internal/scripts/` 存在则必须可读。 */
const MECH_DIRS = ['scripts', 'internal/scripts']
/** 已登记差异（逐条列名 + 理由）：允许的行内容模式（仅放行非逻辑差异）。 */
const ALLOW_LINE = [/同源/, /\.\.', '\.\.'/, /^\/\//, /const ROOT = rootIdx/]

const cannot = (msg) => { console.error(`drift: 无法判定 —— ${msg}`); process.exit(2) }

/** 收集一侧的机制脚本：basename → { dir, file }。同一侧重名 ⇒ 无法判定。 */
function collect(root, side) {
  const out = new Map()
  for (const dir of MECH_DIRS) {
    const abs = join(root, dir)
    let st
    try { st = statSync(abs) } catch (e) {
      if (dir === 'scripts') cannot(`${side}缺机制脚本目录 ${abs}（${e.code || e.message}）`)
      continue // internal/scripts 不存在 = 该仓没有这一层，不是「不可读」
    }
    if (!st.isDirectory()) cannot(`${side}的 ${abs} 不是目录`)
    let entries
    try { entries = readdirSync(abs) } catch (e) { cannot(`${side}目录不可读 ${abs}（${e.code || e.message}）`) }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const file = join(abs, name)
      let fst
      try { fst = statSync(file) } catch (e) { cannot(`${side}无法读取 ${file}（${e.code || e.message}）`) }
      if (!fst.isFile()) continue // 子目录（如 scripts/hooks/）不属于本层比对
      const prev = out.get(name)
      if (prev) cannot(`${side}同名脚本出现在多个机制目录：${prev.dir}/${name} 与 ${dir}/${name}`)
      out.set(name, { dir, file })
    }
  }
  return out
}

// 归一化：剔除注释行与空白差异，再整体比较（允许注释/路径差异，不允许逻辑差异）
const norm = (s) => s.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('#'))
  .filter((l) => !ALLOW_LINE.some((re) => re.test(l)))
  .join('\n')

const mine = collect(ROOT, '本仓')
const theirs = collect(PEER, '对端仓')
const problems = []
let compared = 0

const paired = [...mine.keys()].filter((n) => theirs.has(n)).sort()
for (const name of paired) {
  const a = mine.get(name), b = theirs.get(name)
  let A, B
  try { A = readFileSync(a.file, 'utf8') } catch (e) { cannot(`本仓文件不可读 ${a.file}（${e.code || e.message}）`) }
  try { B = readFileSync(b.file, 'utf8') } catch (e) { cannot(`对端文件不可读 ${b.file}（${e.code || e.message}）`) }
  compared++
  const na = norm(A), nb = norm(B)
  if (na === nb) continue
  const al = na.split('\n'), bl = nb.split('\n')
  let idx = 0
  while (idx < al.length && idx < bl.length && al[idx] === bl[idx]) idx++
  problems.push({
    name,
    a: `${a.dir}/${name}`,
    b: `${b.dir}/${name}`,
    line: idx + 1,
    al: (al[idx] ?? '<无此行>').slice(0, 100),
    bl: (bl[idx] ?? '<无此行>').slice(0, 100),
  })
}

const mineOnly = [...mine.keys()].filter((n) => !theirs.has(n)).sort()
const theirsOnly = [...theirs.keys()].filter((n) => !mine.has(n)).sort()

console.log(`mechanism-drift: 本仓机制脚本 ${mine.size} 个 ｜ 对端 ${theirs.size} 个 ｜ 同名配对 ${compared} 对 ｜ 差异 ${problems.length}`)
for (const p of problems) {
  console.log(`  ✗ ${p.name}：${p.a} vs ${p.b} —— 首个差异 第 ${p.line} 行（归一化后）`)
  console.log(`      本仓「${p.al}」`)
  console.log(`      对端「${p.bl}」`)
}
if (!problems.length) console.log('mechanism-drift: ok —— 同名机制脚本无未登记差异')
if (mineOnly.length) console.log(`mechanism-drift: 仅本仓存在（无对端副本，不比对）：${mineOnly.join(', ')}`)
if (theirsOnly.length) console.log(`mechanism-drift: 仅对端存在（无本仓副本，不比对）：${theirsOnly.join(', ')}`)
process.exit(problems.length ? 1 : 0)
