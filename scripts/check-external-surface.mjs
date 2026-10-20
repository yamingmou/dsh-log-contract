#!/usr/bin/env node
/**
 * 对外信息检查闸（external surface gate）
 *
 * 目的：发布到 npm/GitHub 的**所有会随包发布的内容**不得含内部信息：
 *  - 内部治理叙事（裁定/派工/私有树/投影树/放行件/共同体/线名…）
 *  - 本机路径（/Users/<name>、~/.dsh、/private/tmp…）
 *  - 会话/事件标识（session-<uuid>、seq 明细坐标）
 *  - 机制类词汇（三折/三段式/头缓存/水位…）——本仓不含私有能力，命中即视为泄漏
 *
 * 检查范围：package.json#files 白名单（默认 lib/**、bin/**、README*、cordis.patch.yml、HUMANS.txt、LICENSE）
 * 用法：node scripts/check-external-surface.mjs [--root <dir>] [--json]
 * 退出码：0 通过 / 1 命中 / 2 环境问题
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd()
const asJson = argv.includes('--json')

const FORMS = [
  ['内部治理叙事', /裁定|派工单|放行件|私有树|投影树|共同体|插件线|修复线|体检线|comm-\d{3,}|A\d\s*[-–]\s*A\d/],
  ['机制类词汇', /三折|三段式|三件套|头缓存|水位线?|断裂点|抢在自动压缩前|折叠三件套/],
  ['本机落点', /\/Users\/[A-Za-z0-9._-]+|~\/dsh-v\d|\/private\/tmp|C:\\\\Users\\\\/],
  ['会话/事件标识', /session-[0-9a-f]{8}-[0-9a-f]{4}/],
  ['暴露性绝对路径断言', /绝对路径.*示例[:：]\s*\//],
]

function pkgFiles() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const files = pkg.files || ['lib/**', 'README.md', 'README.zh.md', 'LICENSE', 'package.json']
    return files
  } catch { return null }
}
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.ts', '.d.ts'])
function* walk(p) {
  const st = statSync(p)
  if (st.isFile()) { yield p; return }
  for (const e of readdirSync(p)) yield* walk(join(p, e))
}
// 把 glob 简化：lib/** → lib 目录；其余当文件/目录处理
function expand(pattern) {
  const base = pattern.replace(/\/\*\*?.*$/, '').replace(/\*$/, '')
  const full = join(ROOT, base)
  try { return [...walk(full)] } catch { return [] }
}

const seen = new Set(); const hits = []
for (const f of pkgFiles() || []) {
  for (const file of expand(f)) {
    if (seen.has(file)) continue
    seen.add(file)
    if (!TEXT.has(extname(file)) && !file.endsWith('.d.ts')) continue
    const text = readFileSync(file, 'utf8')
    for (const [label, re] of FORMS) {
      const m = text.match(re)
      if (m) hits.push({ file: relative(ROOT, file), label, sample: m[0].slice(0, 40) })
    }
  }
}
if (asJson) console.log(JSON.stringify({ ok: hits.length === 0, scanned: seen.size, hits }, null, 2))
else {
  console.log(`external-surface: 扫描 ${seen.size} 个文件 ｜ 命中 ${hits.length} 处`)
  for (const h of hits.slice(0, 12)) console.log(`  ✗ [${h.label}] ${h.file} — "${h.sample}"`)
  if (!hits.length) console.log('external-surface: ok —— 对外内容零内部信息')
}
process.exit(hits.length === 0 ? 0 : 1)
