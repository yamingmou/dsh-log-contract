#!/usr/bin/env node
/**
 * 机制状态矩阵（mechanism status）
 * 方法：逐项检查"能力 → 脚本存在 → 负对照存在 → 已接入 pre-publish/pre-push"，输出矩阵与缺口。
 * 用途：一眼看出机制还缺什么，而不是靠人记。
 * 用法：node scripts/mechanism-status.mjs [--md <out>]
 * 退出码：0（仅报告，不作闸）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--md')
const OUT = outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, 'internal', '机制状态-最新.md')
const has = (p) => existsSync(join(ROOT, p))
const pre = has('scripts/pre-publish.mjs') ? readFileSync(join(ROOT, 'scripts/pre-publish.mjs'), 'utf8') : ''
const self = has('scripts/self-test-gates.mjs') ? readFileSync(join(ROOT, 'scripts/self-test-gates.mjs'), 'utf8') : ''
const hook = has('internal/hooks/pre-push') ? readFileSync(join(ROOT, 'internal/hooks/pre-push'), 'utf8') : ''

const CAPS = [
  ['对外信息（发布集）', 'scripts/check-external-surface.mjs', 'check-external-surface', 'check-external-surface'],
  ['对外信息（GitHub 面）', 'scripts/check-git-surface.mjs', 'check-git-surface', 'check-git-surface'],
  ['提交卫生', 'scripts/check-commit-hygiene.mjs', 'check-commit-hygiene', '—'],
  ['发版纪律', 'scripts/check-release-discipline.mjs', 'check-release-discipline', 'check-release-discipline'],
  ['锁文件一致', 'scripts/check-lockfile-consistency.mjs', '—', '—'],
  ['两仓机制漂移', 'scripts/check-mechanism-drift.mjs', '—', '—'],
  ['手册新鲜度', 'scripts/check-mechanism-freshness.mjs', 'mechanism-freshness', '—'],
  ['独立审核记录', 'scripts/check-review-record.mjs', 'review-record', '—'],
  ['包元数据', 'scripts/check-pkg-meta.mjs', '—', '—'],
  ['语法', 'scripts/check-syntax.mjs', '—', '—'],
  ['契约文档一致', 'scripts/gen-contracts-doc.mjs', '—', '—'],
  ['发布前流程', 'scripts/pre-publish.mjs', '—', '—'],
  ['唯一发布入口', 'scripts/release.mjs', '—', '—'],
  ['方法手册生成', 'scripts/mechanism-index.mjs', '—', '—'],
]
const rows = CAPS.map(([name, script, neg, inHook]) => [
  name,
  has(script) ? '✅' : '❌',
  neg === '—' ? '—' : (self.includes(neg) ? '✅' : '❌'),
  pre.includes(script.split('/')[1]) ? '✅' : '—',
  inHook === '—' ? '—' : (hook.includes(inHook.replace('.mjs', '.mjs')) ? '✅' : '—'),
])
const md = [
  '# 机制状态矩阵（自动生成）', '',
  '| 能力 | 脚本 | 负对照 | 接入 pre-publish | 接入 pre-push |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`), '',
  `生成时间：${new Date().toISOString()}`, '',
].join('\n')
writeFileSync(OUT, md)
const miss = rows.filter((r) => r[1] === '❌' || r[2] === '❌')
console.log(`mechanism-status: ${rows.length} 项能力 ｜ 缺脚本/负对照 ${miss.length} 项 → ${OUT.replace(ROOT + '/', '')}`)
for (const m of miss) console.log(`  ✗ ${m[0]}（脚本=${m[1]} 负对照=${m[2]}）`)
