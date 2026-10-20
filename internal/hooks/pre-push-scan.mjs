#!/usr/bin/env node
/**
 * pre-push 扫描器（机器级）：扫描**即将推送的树与提交**，而不是推送前的 origin/main。
 *
 * 输入（stdin，git 约定）：`<local_ref> <local_sha> <remote_ref> <remote_sha>`
 * 判据：
 *  T1 推送树：`git ls-tree -r <local_sha>` 的每个 blob 用词表扫描（与工作区无关，push -f/新分支同样生效）
 *  T2 提交信息：`<remote_sha>..<local_sha>` 范围内的 subject+body 扫描
 *  T3 删除提交（local_sha 全 0）跳过
 * 词表：~/.dsh-gates/wordlist.json（安装时从内部分支复制）
 * 退出码：0 通过 / 1 命中（拒绝推送）/ 2 无法判定（fail-closed ⇒ 也拒绝）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const GATE = join(homedir(), '.dsh-gates')
const wlPath = join(GATE, 'wordlist.json')
if (!existsSync(wlPath)) { console.error('[gate] ✗ 无法判定：缺 ~/.dsh-gates/wordlist.json'); process.exit(2) }
const wl = JSON.parse(readFileSync(wlPath, 'utf8'))
const words = Object.entries(wl).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => v)
const regexes = Array.isArray(wl._regex) ? wl._regex : []
if (words.length < 20) { console.error('[gate] ✗ 词表异常（条目过少）'); process.exit(2) }
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const RE = new RegExp([...words.map(esc), ...regexes].join('|'), 'g')

const ZERO = /^0+$/
const idx = process.argv.indexOf('--repo')
const REPO = idx >= 0 ? process.argv[idx + 1] : process.cwd()
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })

const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean)
if (!lines.length) { console.error('[gate] ✗ 无法判定：stdin 无 ref 行'); process.exit(2) }
let hits = []
for (const line of lines) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(' ')
  if (!localSha || ZERO.test(localSha)) continue // 删除分支
  // T1 推送树
  let files = []
  try { files = git('ls-tree', '-r', '--name-only', localSha).split('\n').filter(Boolean) } catch (e) { console.error('[gate] ✗ 取不到推送树', localSha.slice(0,8), e.message); process.exit(2) }
  if (files.length < 1) { console.error('[gate] ✗ 无法判定：推送树为空', localSha.slice(0,8)); process.exit(2) }
  for (const f of files) {
    let blob
    try { blob = git('cat-file', 'blob', `${localSha}:${f}`) } catch { continue }
    const m = blob.match(RE)
    if (m) hits.push({ face: 'T1 树', ref: localRef, sha: localSha.slice(0,8), file: f, words: [...new Set(m)].slice(0, 5) })
  }
  // T2 提交信息
  if (!remoteSha || ZERO.test(remoteSha)) continue // 新分支：只进 T1（树已覆盖）
  let msgs = ''
  try { msgs = git('log', `${remoteSha}..${localSha}`, '--format=%s%x00%b') } catch { msgs = '' }
  const m2 = msgs.match(RE)
  if (m2) hits.push({ face: 'T2 提交信息', ref: localRef, sha: localSha.slice(0,8), file: '(range)', words: [...new Set(m2)].slice(0, 5) })
}
hits = hits.slice(0, 20)
console.log(`[gate] 推送面扫描：refs=${lines.length} ｜ 命中=${hits.length}`)
for (const h of hits) console.log(`  ✗ [${h.face}] ${h.file} — ${h.words.join(', ')}`)
if (hits.length) { console.error('[gate] ✗ 推送被拒绝（推送面含内部信息）'); process.exit(1) }
console.log('[gate] ok —— 推送面零内部信息')
