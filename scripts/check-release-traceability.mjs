#!/usr/bin/env node
/**
 * 发布可追溯闸（release traceability gate）
 *
 * 判据（2026-10-21 事故）：**每个已发布到 npm 的版本，必须核对出一个"可达提交"，
 * 且其 tree 与 npm tarball 的内容逐字节双向一致**。核对全部在**干净克隆**里做
 * （`git clone` 到临时目录 ⇒ 不依赖本仓工作区/索引/未提交改动）：
 *   ① npm 元数据 `gitHead`（发布时的提交）→ 干净克隆里必须存在该提交（clone 只带可达对象，
 *      存在即可达）；该提交的 package.json version 必须 == v；
 *   ② tree → tarball：提交树里的每个文件（除 internal/、reviews/、pnpm-lock.yaml）若出现在
 *      tarball 里必须逐字节一致（tarball 按 package.json#files 裁剪 ⇒ 树里多的文件忽略）；
 *   ③ tarball → tree（反向）：tarball 里每个文件都必须在提交树中存在且逐字节一致
 *      ⛔ 不许只比交集（只比交集 = tarball 塞私货查不出来）；
 *   ④ 无 `gitHead` 的版本（registry 未记录 ⇒ gitHead 绑定维度**无法判定**，如实记）：
 *      按"内容树匹配"认定 —— 在克隆历史找 package.json version == v 且 ②③ 双向一致的**ref 可达**提交；
 *      命中 ⇒ ok（方法记 tree-match）；查无 ⇒ **无法判定**（区分不了"提交只在别处/reflog"与
 *      "从不存在" ⇒ 不假绿；严格口径应判 bad，输出里点明，⛔ 不许冒充 ok）；
 *   ⑤ 下载 tarball 后先核 dist.shasum（sha1）：比对的必须是 registry 上那份产物。
 *
 * 用法：node scripts/check-release-traceability.mjs [--version <v>] [--last N]
 *                        [--clone-src <path|url>] [--clone-args "<git clone 额外参数>"] [--offline-warn]
 *   --clone-src   克隆来源（默认本仓；可给远端 url，或 --clone-args "--branch x --single-branch" 限定 ref）
 *   --offline-warn  registry 不可达时只告警 exit 0（默认无法判定 exit 2）
 * 退出码：0 全部可追溯 / 1 存在不可追溯（bad）/ 2 无法判定（registry/克隆不可用，或存在未判定项且无 bad）
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const vIdx = argv.indexOf('--version'); const wantV = vIdx >= 0 ? argv[vIdx + 1] : null
const lIdx = argv.indexOf('--last'); const lastN = lIdx >= 0 ? Number(argv[lIdx + 1]) : 3
const sIdx = argv.indexOf('--clone-src'); const CLONE_SRC = sIdx >= 0 ? argv[sIdx + 1] : ROOT
const aIdx = argv.indexOf('--clone-args'); const CLONE_ARGS = aIdx >= 0 ? String(argv[aIdx + 1] || '').split(' ').filter(Boolean) : []
const offlineWarn = argv.includes('--offline-warn')
const undecidable = (why) => { console.error(`traceability: ✗ 无法判定 —— ${why}`); return 2 }
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.name

// ── ① registry 元数据（不缓存、不猜：没有就读不到 = 无法判定） ────────────────
let versions = []
try {
  const out = execFileSync('npm', ['view', NAME, 'versions', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '15000' } })
  versions = JSON.parse(out); if (!Array.isArray(versions)) versions = [versions]
} catch { if (offlineWarn) { console.log('traceability: 无法判定（registry 不可达，--offline-warn 放行）'); process.exit(0) } process.exit(undecidable('registry 不可达（npm view versions 失败）')) }
const targets = wantV ? [wantV] : versions.slice(-lastN)

const metaOf = (v) => {
  const out = execFileSync('npm', ['view', `${NAME}@${v}`, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26, env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '15000' } })
  const d = JSON.parse(out)
  return { gitHead: d.gitHead || null, tarball: d.dist?.tarball || null, shasum: d.dist?.shasum || null }
}

// ── ② 干净克隆：所有 git 读取都在这里做 ─────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'trace-'))
const clone = join(work, 'clone')
try {
  execFileSync('git', ['clone', '--quiet', ...CLONE_ARGS, CLONE_SRC, clone], { stdio: ['ignore', 'ignore', 'pipe'] })
} catch (e) { rmSync(work, { recursive: true, force: true }); process.exit(undecidable(`干净克隆失败：${String(e.message).slice(0, 80)}`)) }
const git = (...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
const gitBlob = (sha, f) => execFileSync('git', ['-C', clone, 'cat-file', 'blob', `${sha}:${f}`], { maxBuffer: 1 << 28 })  // 原始字节（⛔ utf8 解码会毁二进制文件的哈希）
const EXCL = (f) => f.startsWith('internal/') || f.startsWith('reviews/') || f === 'pnpm-lock.yaml'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 提交树（排除集之外）：{ path: sha256 } */
function treeHashes(sha) {
  const m = new Map()
  for (const f of git('ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean)) {
    if (EXCL(f)) continue
    m.set(f, sha256(gitBlob(sha, f)))
  }
  return m
}
/** tarball（package/ 之下）：{ path: sha256 } */
function tarHashes(dir) {
  const m = new Map()
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, rel)
      else if (!EXCL(rel)) m.set(rel, sha256(readFileSync(full)))
    }
  }
  walk(join(dir, 'package'), '')
  return m
}
/** 双向比对：tree→tar + tar→tree（⛔ 不只比交集） */
function bidir(tree, tar) {
  const diffs = []
  for (const [f, h] of tree) if (tar.has(f) && tar.get(f) !== h) diffs.push(`tree≠tar: ${f}`)
  for (const [f, h] of tar) { if (!tree.has(f)) diffs.push(`tar 独有（树中缺）: ${f}`); else if (tree.get(f) !== h) diffs.push(`tar≠tree: ${f}`) }
  return diffs
}

const results = []
for (const v of targets) {
  const row = { v, status: 'bad', method: '', gitHead: null, commit: null, why: [] }
  try {
    // 产物真实性：sha1(tarball) == dist.shasum
    let meta
    try { meta = metaOf(v) } catch (e) { row.status = 'undecidable'; row.why.push(`npm 元数据取不到（${String(e.message).slice(0, 50)}）`); results.push(row); continue }
    row.gitHead = meta.gitHead
    const tgz = join(work, `${v}.tgz`)
    execFileSync('bash', ['-lc', `curl -sL --max-time 60 '${meta.tarball}' -o '${tgz}'`], { stdio: 'ignore' })
    const shasum = createHash('sha1').update(readFileSync(tgz)).digest('hex')
    if (meta.shasum && shasum !== meta.shasum) { row.status = 'undecidable'; row.why.push(`tarball sha1 ≠ dist.shasum（${shasum.slice(0, 10)} ≠ ${String(meta.shasum).slice(0, 10)}）—— 比对的不是 registry 那份产物`); results.push(row); continue }
    const ex = join(work, `x-${v}`)
    execFileSync('bash', ['-lc', `mkdir -p '${ex}' && tar -xzf '${tgz}' -C '${ex}'`], { stdio: 'ignore' })
    const tar = tarHashes(ex)

    if (meta.gitHead) {
      // ① gitHead 绑定
      try { git('cat-file', '-e', `${meta.gitHead}^{commit}`) } catch {
        row.why.push(`gitHead ${meta.gitHead.slice(0, 10)} 不在克隆可达历史里（发布绑定的提交不可达）`); results.push(row); continue
      }
      row.commit = meta.gitHead; row.method = 'gitHead'
      let pv = null
      try { pv = JSON.parse(git('show', `${meta.gitHead}:package.json`)).version } catch { /* 无 package.json */ }
      if (pv !== v) row.why.push(`gitHead 树里 package.json version=${pv} ≠ ${v}`)
      const diffs = bidir(treeHashes(meta.gitHead), tar)
      if (diffs.length) row.why.push(`tarball 与 gitHead 树不一致（${diffs.length} 处，如 ${diffs.slice(0, 3).join('; ')}）`)
    } else {
      // ④ 无 gitHead ⇒ gitHead 维度无法判定，按内容树匹配认定（只认 ref 可达的提交）
      row.method = 'tree-match（gitHead 缺失 ⇒ gitHead 绑定无法判定）'
      const shas = git('log', '--all', '--format=%H').split('\n').filter(Boolean)
      let hit = null
      for (const s of shas) {
        let pv = null
        try { pv = JSON.parse(git('show', `${s}:package.json`)).version } catch { continue }
        if (pv !== v) continue
        if (bidir(treeHashes(s), tar).length === 0) { hit = s; break }
      }
      if (hit) { row.commit = hit; row.status = 'ok' }
      else {
        // 干净克隆（ref 面）查无匹配树：区分不了"提交只在别处/reflog"与"从不存在"
        // ⇒ 无法判定（不假绿）；严格口径（必须有 ref 可达提交）应判 bad，一并记明
        row.status = 'undecidable'
        row.why.push('无 gitHead（registry 未记录）且干净克隆（ref 可达面）无匹配树 ⇒ 绑定无法判定（严格口径应判不可追溯 bad；查无"内容不符"证据，不假绿也不冤枉）')
      }
    }
    if (row.why.length === 0) row.status = 'ok'
  } catch (e) {
    row.status = 'undecidable'; row.why.push(`核对过程异常（${String(e.message).slice(0, 60)}）`)
  }
  results.push(row)
}
rmSync(work, { recursive: true, force: true })

// ── 读数（bad/无法判定 分开数，⛔ 不假绿） ──────────────────────────────────
const bad = results.filter((r) => r.status === 'bad')
const und = results.filter((r) => r.status === 'undecidable')
const ok = results.filter((r) => r.status === 'ok')
console.log(`traceability: 干净克隆来源 ${CLONE_SRC}｜ 检查 ${results.length} 个版本（${targets.join(', ')}）｜ ok ${ok.length} ｜ bad ${bad.length} ｜ 无法判定 ${und.length}`)
for (const r of results) {
  const m = r.status === 'ok' ? '✓' : r.status === 'bad' ? '✗' : '?'
  console.log(`  ${m} [${r.status}] ${r.v}${r.commit ? ` @${r.commit.slice(0, 10)}` : ''}${r.method ? ` ｜ ${r.method}` : ''}${r.why.length ? ` ｜ ${r.why.join('；')}` : ''}`)
}
if (bad.length) { console.log(`traceability: ✗ ${bad.length} 个版本不可追溯`); process.exit(1) }
if (und.length) { console.log(`traceability: ? ${und.length} 个版本无法判定（不假绿）`); process.exit(2) }
console.log('traceability: ok —— 每个版本都有可达提交且 tarball 与树双向一致')
process.exit(0)
