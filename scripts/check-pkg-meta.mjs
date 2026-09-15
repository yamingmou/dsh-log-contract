#!/usr/bin/env node
/**
 * 发布前元数据校验（2026-09-04）：package.json 的 repository / homepage / bugs
 * 必须指向当前仓库（github.com/yamingmou/<name>），不得指向任何其它账号或仓库名。
 *
 * 为什么必须发布前查：npm 已发布版本的元数据**不可修改**，写错一次就是永久失效的
 * 404 链接（只能靠发新版本覆盖）。这里用**正向断言**兜住——只要不是
 * `github.com/yamingmou/<name>` 就失败，因此旧账号、拼写错误、克隆来的模板值一并拦下。
 *
 * 接入：prepublishOnly（发布必查）+ 可手动跑 `node scripts/check-pkg-meta.mjs`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = pkg.name
const expectedRepo = `github.com/yamingmou/${name}.git`
const expectedPage = `github.com/yamingmou/${name}`

const problems = []

const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
if (!repo.includes(expectedRepo)) {
  problems.push(`repository 应为 ${expectedRepo}，实际 ${JSON.stringify(repo) || '(缺失)'}`)
}

const homepage = pkg.homepage ?? ''
if (homepage && !homepage.includes(expectedPage)) {
  problems.push(`homepage 应指向 ${expectedPage}，实际 ${homepage}`)
}

const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : (pkg.bugs?.url ?? '')
if (bugs && !bugs.includes(expectedPage)) {
  problems.push(`bugs 应指向 ${expectedPage}，实际 ${bugs}`)
}

if (problems.length > 0) {
  console.error(`❌ pkg-meta: ${name} 发布元数据校验失败:`)
  for (const p of problems) console.error(`   - ${p}`)
  process.exit(1)
}
console.log(`✅ pkg-meta: ${name} repository/homepage/bugs 均指向 yamingmou/${name}`)
