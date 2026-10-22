#!/usr/bin/env node
/**
 * 打包白名单覆盖闸（package files coverage gate）
 *
 * 事故来源（comm-1841）：`lib/` 里引用 `../contract/`、`../adapters/`，而 `package.json#files`
 * 只放 `lib/**` ⇒ **本地跑得好、装出去必死**。本闸机械检查：
 *   对每个"会进包"的模块，抽取相对引用（import/export/require/动态 import），
 *   解析成仓库内路径；若该路径在磁盘上存在、但**不在 npm pack 结果里** ⇒ FAIL。
 *
 * 用法：node scripts/check-package-files-coverage.mjs [--json]
 * 退出码：0 覆盖完整 / 1 存在"本地可用、安装即缺"的引用 / 2 无法判定
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

let packed
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 })
  const parsed = JSON.parse(out)
  packed = new Set(parsed[0].files.map((f) => f.path))
} catch (e) {
  console.error('check-package-files-coverage: 无法判定 —— npm pack 失败：' + String(e.message).slice(0, 120))
  process.exit(2)
}

const REF = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
const files = [...packed].filter((f) => /\.(js|mjs|cjs|ts)$/.test(f))
const problems = []
for (const file of files) {
  let text
  try { text = readFileSync(join(ROOT, file), 'utf8') } catch { continue }
  for (const m of text.matchAll(REF)) {
    const spec = m[1]
    const base = resolve(ROOT, dirname(file), spec)
    const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.ts')]
    const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile())
    if (!hit) continue                    // 包内解析不到 ⇒ 由 Node 报错，不属本闸
    const rel = relative(ROOT, hit).split('\\').join('/')
    if (!packed.has(rel)) problems.push({ file, spec, missing: rel })
  }
}
if (asJson) console.log(JSON.stringify({ ok: problems.length === 0, packed: packed.size, problems }, null, 2))
if (!problems.length) console.log(`check-package-files-coverage: ok —— ${files.length} 个包内模块，跨目录引用全部被 files 覆盖`)
else {
  console.error(`check-package-files-coverage: ✗ ${problems.length} 处"本地可用、安装即缺"的引用（打包白名单未覆盖）`)
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p.file} → ${p.spec}（缺 ${p.missing}）`)
}
process.exit(problems.length ? 1 : 0)
