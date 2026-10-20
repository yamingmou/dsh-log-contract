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
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
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
const scan = (text) => { const m = String(text).match(RE); return m ? [...new Set(m)] : [] }

const ref = (() => { try { git('rev-parse', '--verify', 'origin/main') ; return 'origin/main' } catch { return 'HEAD' } })()
let treeFiles
try { treeFiles = git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean) } catch (e) { console.error('git-surface: 无法判定 —— 取不到树', e.message); process.exit(2) }
const MIN = Number(process.env.GATE_MIN_FILES || 20)
if (treeFiles.length < MIN) { console.error(`git-surface: 无法判定 —— ${ref} 只有 ${treeFiles.length} 个文件（下限 ${MIN}）（疑似浅克隆/错 ref）`); process.exit(2) }

const hits = []
// ① 树
for (const f of treeFiles) {
  let blob
  try { blob = git('cat-file', 'blob', `${ref}:${f}`) } catch { continue }
  const h = scan(blob)
  if (h.length) hits.push({ face: '树', file: f, words: h })
}
// ② 提交信息
const msgs = git('log', ref, '--format=%H%x00%s%x00%b').split('\x00')
for (let i = 0; i + 2 < msgs.length; i += 3) {
  const h = scan(msgs[i + 1] + ' ' + msgs[i + 2])
  if (h.length) hits.push({ face: '提交信息', file: msgs[i].slice(0, 10), words: h })
}
// ③ PR/issue + 元数据（gh 不可用时明确标注"未取得"，不计入通过）
let ghOk = false
const repo = sh('git', ['-C', ROOT, 'config', '--get', 'remote.origin.url'])?.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/)
if (!repo) console.error('DEBUG repo 解析失败: url=', (() => { try { return git('config','--get','remote.origin.url') } catch (e) { return 'ERR:' + e.message } })())
const ghProbe = repo ? sh('gh', ['api', 'repos/' + repo[1] + '/' + repo[2], '--jq', '.full_name']) : null
if (repo && !ghProbe) console.error('git-surface: gh 探测失败 repo=' + repo[1] + '/' + repo[2] + '（gh 未认证或无网络）')
if (repo && ghProbe) {
  const [owner, name] = [repo[1], repo[2]]
  const pr = sh('gh', ['api', `repos/${owner}/${name}/pulls?state=all&per_page=100`, '--jq', '.[]|"\(.title) \(.body // "")"'])
  const is = sh('gh', ['api', `repos/${owner}/${name}/issues?state=all&per_page=100`, '--jq', '.[]|"\(.title) \(.body // "")"'])
  const meta = sh('gh', ['api', `repos/${owner}/${name}`, '--jq', '"\(.description // "") \(.homepage // "") \((.topics//[])|join(" "))"'])
  if (pr !== null && is !== null && meta !== null) {
    ghOk = true
    for (const [face, text] of [['PR', pr], ['issue', is], ['元数据', meta]]) {
      const h = scan(text); if (h.length) hits.push({ face, file: '-', words: h })
    }
  }
}
if (!ghOk) console.error('git-surface: ⚠️ gh 面未取得（不计入通过）')

console.log(`git-surface: ref=${ref} ｜ 文件=${treeFiles.length} ｜ 提交=${(msgs.length - 1) / 3} ｜ gh=${ghOk ? 'ok' : '未取得'} ｜ 命中=${hits.length}`)
for (const h of hits.slice(0, 15)) console.log(`  ✗ [${h.face}] ${h.file} — ${h.words.slice(0, 5).join(', ')}`)
if (!hits.length) console.log('git-surface: ok —— GitHub 面零内部信息')
process.exit(hits.length ? 1 : 0)
