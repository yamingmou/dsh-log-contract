#!/usr/bin/env node
/**
 * GitHub 面对外信息闸（git surface gate）—— 补 check-external-surface 只扫 npm 白名单的空档
 *
 * 覆盖面：① 远端树文件内容 ② 全部提交信息 ③ PR/issue 标题正文 ④ 仓库元数据
 * 硬要求：
 *  - **以脚本位置定位仓库根**（不依赖 CWD —— 历史事故：在错目录扫出 0 命中）
 *  - **min-files sanity**：扫到的文件数低于下限 ⇒ exit 2（"报 0"必须与"扫错地方"区分）
 *  - 词表：internal/wordlist.json（缺失 ⇒ exit 2，不允许静默退回弱规则）
 * 退出码：0 干净 / 1 命中 / 2 无法判定
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const ALLOW_NO_GH = process.argv.includes('--allow-no-gh')  // 显式 flag；默认 fail-closed

// 词表指纹固定：wordlist.json 的 sha256 必须等于 internal/wordlist.sha256
// （改词表必须同时更新登记文件 ⇒ 删词/改词会在 diff 中可见，且单点删词立即判红）
{
  const { createHash } = await import('node:crypto')
  const { readFileSync: __rf } = await import('node:fs')
  const p = join(ROOT, 'internal', 'wordlist.json')
  const pinPath = join(ROOT, 'internal', 'wordlist.sha256')
  let actual = null, expected = null
  try { actual = createHash('sha256').update(__rf(p)).digest('hex') } catch { console.error('无法读取词表'); process.exit(2) }
  try { expected = __rf(pinPath, 'utf8').trim() } catch { console.error('git-surface: ⚠️ 缺 internal/wordlist.sha256 —— 跳过指纹校验（仅用词表内容）'); expected = null }
  if (expected && actual && actual !== expected) { console.error(`无法判定 —— 词表指纹不匹配（实际 ${actual.slice(0,12)}… ≠ 登记 ${expected.slice(0,12)}…）；如确属有意修改，请运行 node scripts/wordlist-pin.mjs 更新登记`); process.exit(2) }
}
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { if (process.env.DEBUG_GH) console.error('gh 调用失败:', cmd, args.join(' '), '｜', (e.stderr || e.message || '').slice(0, 300)); return null }
}

const wlPath = join(ROOT, 'internal', 'wordlist.json')
if (!existsSync(wlPath)) { console.error('git-surface: 无法判定 —— 缺 internal/wordlist.json（不允许静默弱化）'); process.exit(2) }
let words = []
let regexes = []
try {
  const wl = JSON.parse(readFileSync(wlPath, 'utf8'))
  for (const [k, v] of Object.entries(wl)) if (!k.startsWith('_') && Array.isArray(v)) for (const w of v) words.push(w)
  regexes = Array.isArray(wl._regex) ? wl._regex : []
} catch (e) { console.error('git-surface: 词表不可解析 ——', e.message); process.exit(2) }
if (words.length < 20) { console.error(`git-surface: 无法判定 —— 词表仅 ${words.length} 条（疑似损坏）`); process.exit(2) }
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const RE = new RegExp([...words.map(esc), ...regexes].join('|'), 'g')

// 允许清单：这些词是"公开历史里已存在的检查器名"，不算内部信息（否则公开 main 无法通过）

const scan = (text) => { const m = String(text).match(RE); return m ? [...new Set(m)] : [] }

// 发布审查对象 = **会被发布的公开分支**：origin/main + 本地 main（覆盖未推送提交）
// 内部分支（local/process 等）自身含机制内容，不应作为对外面扫描对象
const refArgIdx = process.argv.indexOf('--ref')
const REF_ARG = refArgIdx >= 0 ? process.argv[refArgIdx + 1] : null
const existsRef = (r) => { try { git('rev-parse', '--verify', r); return true } catch { return false } }
// 复审（P0-2）：默认扫**全部公开 ref**（origin/* 分支 + tags），不只是 main
const refs = (() => {
  if (REF_ARG) {
    if (!existsRef(REF_ARG)) { console.error(`git-surface: 无法判定 —— 指定 ref 不存在：${REF_ARG}`); process.exit(2) }
    return [REF_ARG]
  }
  const list = []
  try {
    // 只扫**公开 ref**：origin/* 分支 + 本地 main（超集）。
    // ⛔ 不扫本地 tags：内部冻结 tag 从未推公开远端，扫它们只会制造假红。
    for (const r of git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin').split('\n').filter(Boolean)) {
      if (!r.endsWith('/HEAD')) list.push(r)
    }
  } catch { /* ignore */ }
  if (existsRef('main')) list.push('main')
  if (!list.length) for (const r of ['origin/main', 'HEAD']) if (existsRef(r)) list.push(r)
  return [...new Set(list)]
})()

const hits = []
let scannedFiles = 0, scannedCommits = 0

// ── 逐条例外（禁止全局豁免）：词 + sha 或 文件 + 理由 ──
const GATES_HOME = process.env.DSH_GATES_HOME || join(homedir(), '.dsh-gates')
const EXC_PATH = [join(ROOT, 'internal', 'git-surface-exceptions.json'), join(GATES_HOME, 'git-surface-exceptions.json')].find(existsSync) || join(ROOT, 'internal', 'git-surface-exceptions.json')
let EXCEPTIONS = []
try { EXCEPTIONS = (JSON.parse(readFileSync(EXC_PATH, 'utf8')).exceptions || []) } catch { EXCEPTIONS = [] }
const excused = (word, { sha = '', file = '' } = {}) =>
  EXCEPTIONS.some((e) => e.word === word && ((e.sha && sha.startsWith(e.sha)) || (e.file && file === e.file)))

const MIN = Number(process.env.GATE_MIN_FILES || 20)
for (const ref of refs) {
  let treeFiles = []
  try { treeFiles = git('-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--name-only', ref).split('\0').filter(Boolean) } catch { continue }
  scannedFiles += treeFiles.length
  if (treeFiles.length < MIN) continue          // 浅克隆/空 ref：跳过但由下面的"全空"判定兜底
  for (const f of treeFiles) {
    const nameHit = scan(f).filter((w) => !excused(w, { file: f }))
    if (nameHit.length) hits.push({ face: `文件名@${ref}`, file: f, words: nameHit.slice(0, 5) })
    let blob
    try { blob = git('cat-file', 'blob', `${ref}:${f}`) } catch { continue }
    const h = scan(blob).filter((w) => !excused(w, { file: f }))
    if (h.length) hits.push({ face: `树@${ref}`, file: f, words: h })
  }
}
if (refs.length && !hits.length) { /* 干净 */ }

// ② 提交信息（对所有 ref 的提交去重后扫一次）
const seen = new Set()
for (const ref of refs) {
  let raw = ''
  try { raw = git('log', ref, '--format=%H%x1f%s%x1f%b%x1e') } catch { continue }
  for (const rec of raw.split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean)) {
    const [sha = '', subject = '', body = ''] = rec.split('\x1f')
    if (seen.has(sha)) continue
    seen.add(sha)
    scannedCommits += 1
    const h = scan(subject + ' ' + body).filter((w) => !excused(w, { sha }))
    if (h.length) hits.push({ face: '提交信息', file: sha.slice(0, 10), words: h })
  }
}
const ref = refs[0] || 'HEAD'

// ③ PR/issue + 元数据（gh 不可用时明确标注"未取得"，不计入通过）
let ghOk = false
const repo = sh('git', ['-C', ROOT, 'config', '--get', 'remote.origin.url'])?.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/)
if (!repo) console.error('DEBUG repo 解析失败: url=', (() => { try { return git('config','--get','remote.origin.url') } catch (e) { return 'ERR:' + e.message } })())
if (!repo) {
  console.error('git-surface: 无法判定 —— 非 GitHub 远端（本地克隆/离线），gh 面不可核')
  if (!ALLOW_NO_GH) process.exit(2)
}
const ghProbe = repo ? sh('gh', ['api', 'repos/' + repo[1] + '/' + repo[2], '--jq', '.full_name']) : null
if (repo && !ghProbe) console.error('git-surface: gh 探测失败 repo=' + repo[1] + '/' + repo[2] + '（gh 未认证或无网络）')
if (repo && ghProbe) {
  const [owner, name] = [repo[1], repo[2]]
  const pr = sh('gh', ['api', `repos/${owner}/${name}/pulls?state=all&per_page=100`, '--jq', '.[] | (.title + " " + (.body // ""))'])
  const is = sh('gh', ['api', `repos/${owner}/${name}/issues?state=all&per_page=100`, '--jq', '.[] | (.title + " " + (.body // ""))'])
  const meta = sh('gh', ['api', `repos/${owner}/${name}`, '--jq', '.description, (.homepage // ""), ((.topics // []) | join(" "))'])
  if (pr !== null && is !== null && meta !== null) {
    ghOk = true
    const comments = sh('gh', ['api', `repos/${owner}/${name}/issues/comments?per_page=100`, '--jq', '.[]|.body']) || ''
    const releases = sh('gh', ['api', `repos/${owner}/${name}/releases`, '--jq', '.[]|"\(.name // "") \(.body // "")"']) || ''
    for (const [face, text] of [['PR', pr], ['issue', is], ['评论', comments], ['release', releases], ['元数据', meta]]) {
      const h = scan(text); if (h.length) hits.push({ face, file: '-', words: h })
    }
  }
}
if (!ghOk) {
  console.error('git-surface: ⚠️ gh 面未取得')
  if (!ALLOW_NO_GH) { console.error('git-surface: ✗ 默认 fail-closed（gh 面未核 ⇒ 不可判定）；确需跳过请加 --allow-no-gh'); process.exit(2) }
}

console.log(`git-surface: ref=${ref} ｜ 文件=${scannedFiles} ｜ 提交=${scannedCommits} ｜ gh=${ghOk ? 'ok' : '未取得'} ｜ 命中=${hits.length}`)
for (const h of hits.slice(0, 200)) console.log(`  ✗ [${h.face}] ${h.file} — ${h.words.slice(0, 5).join(', ')}`)
if (!hits.length) console.log('git-surface: ok —— GitHub 面零内部信息')
process.exit(hits.length ? 1 : 0)
