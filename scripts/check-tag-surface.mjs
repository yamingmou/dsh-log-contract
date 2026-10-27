#!/usr/bin/env node
/**
 * tag 面检查闸（tag surface gate）
 *
 * 判据（tag = 对外可见的"版本面"，每个 tag 都是一条历史入口）：
 *   ① **主线可达**：tag 指向的提交必须是当前主线 ref 的祖先
 *      （`git merge-base --is-ancestor <tag-commit> <ref>` 判否 ⇒ 违规）——
 *      旁支/孤儿 tag 会把"从未进主线"的历史暴露到对外 tag 面；
 *   ② **名字白名单**：tag 名必须命中发布白名单 `^v\d+\.\d+\.\d+$`；
 *      内部命名（mechanism-* / *-frozen-* / internal-* / threefold-* / pre-* / *-markers …）⇒ 违规
 *      （白名单是默认拒绝：未命中白名单的名字一律不合格，不是只拦黑名单）。
 *
 * 用法：node scripts/check-tag-surface.mjs [--json] [--ref <主线ref，默认 origin/main>]
 *                        [--repo <目录，默认脚本所在仓>] [--local] [--self-test]
 *   --json       机器可读输出（单一 JSON 对象，便于 --json 读数与门禁串联）
 *   --ref        主线 ref（默认 origin/main）；缺失/空值 ⇒ exit 2（fail-closed，不假装干净）
 *   --repo       要检查的仓库目录（默认=脚本所在仓，避免"CWD 错目录扫出 0 命中"的历史事故）；缺失/空值 ⇒ exit 2
 *   --local      扫**本地** refs/tags（本地自查）；默认扫**公开远端** tag（`git ls-remote --tags origin`）——
 *                与 check-git-surface 同口径：本地可能有从未推送的内部冻结/标记 tag，扫它们只会制造假红
 *   --source     显式选来源 remote|local|auto（默认 remote；auto=仅当远端不可用才回落本地自查并标注）
 *   --self-test  自检：①旁支 tag ②内部命名 tag ③非白名单命名 tag（都必须 exit 1）+ 正对照 + 两条 exit-2 负对照
 * 退出码：0 通过 / 1 存在违规 / 2 无法判定（非 git 仓、无 origin 远端、ls-remote/主线 ref 不可用、tag 对象本地缺失）
 *
 * 接入（二选一，写明理由）：挂进 `scripts/self-test-gates.mjs` 的负对照清单，**不**挂 pre-publish gates。
 *   理由：本私有仓有治理认可的"旁支私有基线 tag / 内部标记 tag"（均不入公开面），无条件挂
 *   pre-publish 会把它们变成永久红（=假阻断）；挂自检里 ⇒ pre-publish 每轮通过「闸负对照自检」
 *   自动验证本闸在违规场景会判红；真仓 tag 面仍可独立 `--json` 读数（发布/投影前按 `--ref` 复核）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const SCRIPT_ROOT = join(dirname(SCRIPT), '..')
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const SELF_TEST = argv.includes('--self-test')
const LOCAL_TAGS = argv.includes('--local')   // 本地自查开关（= --source local）
const SOURCE = (() => { const i = argv.indexOf('--source'); const v = i >= 0 ? String(argv[i+1]||'').trim() : ''; return v || (LOCAL_TAGS ? 'local' : 'remote') })()   // remote|local|auto（默认 remote = 公开远端）
const hasFlag = (name) => argv.indexOf(name) >= 0
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const REF = hasFlag('--ref') ? String(argOf('--ref') ?? '').trim() : 'origin/main'
const REPO_RAW = hasFlag('--repo') ? String(argOf('--repo') ?? '').trim() : null

// 发布白名单：只允许 v<major>.<minor>.<patch>（唯一对外发布 tag 形态）
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
// 内部命名识别（给出比"不在白名单"更准确的诊断；命中即违规，白名单同样判否）
const INTERNAL_NAME_PATTERNS = [
  [/^mechanism[-_]/i, 'mechanism-*（机制类内部命名）'],
  [/-frozen-/i, '*-frozen-*（内部冻结命名）'],
  [/^internal[-_]/i, 'internal-*（内部命名）'],
  [/^threefold[-_]/i, 'threefold-*（机制类内部命名）'],
  [/^pre[-_]/, 'pre-*（内部阶段标记命名）'],
  [/-markers?$/i, '*-marker(s)（内部标记命名）'],
  [/^(wip|tmp|draft|dev|test)[-_]/i, 'wip/tmp/draft/dev/test-*（临时/开发命名）'],
]

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const die = (why) => {
  if (AS_JSON) console.log(JSON.stringify({ ok: false, undecidable: true, reason: why, ref: REF }, null, 2))
  else console.error(`tag-surface: ✗ 无法判定 —— ${why}`)
  process.exit(2)
}

// ── 自检：负对照必须判红；正对照必须绿；两条 exit-2 负对照必须 fail-closed ──────
if (SELF_TEST) {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const sh = (d, args) => {
    const r = spawnSync('git', ['-C', d, ...args], { encoding: 'utf8', env: GIT_ENV })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || r.stdout || '').trim()}`)
    return (r.stdout || '').trim()
  }
  const fixtures = []
  const mkFixture = ({ side = false, tags: fixtureTags = [] } = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'tag-surface-self-'))
    fixtures.push(d)
    sh(d, ['init', '-q', '.'])
    sh(d, ['remote', 'add', 'origin', d])   // 默认来源=公开远端：夹具用"自己当 origin"（file remote，离线可跑）
    writeFileSync(join(d, 'base.txt'), 'base\n')
    sh(d, ['add', '-A'])
    sh(d, ['commit', '-qm', 'base'])
    sh(d, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    if (side) {
      sh(d, ['checkout', '-q', '-b', 'side'])
      writeFileSync(join(d, 'side.txt'), 'side\n')
      sh(d, ['add', '-A'])
      sh(d, ['commit', '-qm', 'side'])
    }
    for (const t of fixtureTags) sh(d, ['tag', t])
    return d
  }
  const runGate = (args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    let json = null
    try { json = JSON.parse(r.stdout) } catch { json = null }
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), json }
  }
  const cases = []
  try {
    // ① 旁支 tag：名字合规（v 版本号），但提交在 side 分支、不在 origin/main ⇒ 必须 exit 1
    const d1 = mkFixture({ side: true, tags: ['v9.9.9'] })
    const r1 = runGate(['--repo', d1, '--ref', 'origin/main', '--json'])
    const v1 = (r1.json?.violations || []).find((v) => v.tag === 'v9.9.9')
    cases.push({ id: '① 旁支 tag（v9.9.9 在 side 分支、不在 origin/main）', expect: 1, got: r1.code, kinds: v1?.kinds || [], ok: r1.code === 1 && !!v1 && v1.kinds.includes('not-in-mainline') })
    // ② 内部命名 tag：提交在主线上（祖先判断会通过），只靠名字白名单拦下 ⇒ 必须 exit 1
    const d2 = mkFixture({ tags: ['mechanism-frozen-baseline'] })
    const r2 = runGate(['--repo', d2, '--ref', 'origin/main', '--json'])
    const v2 = (r2.json?.violations || []).find((v) => v.tag === 'mechanism-frozen-baseline')
    cases.push({ id: '② 内部命名 tag（mechanism-frozen-baseline，提交在主线）', expect: 1, got: r2.code, kinds: v2?.kinds || [], ok: r2.code === 1 && !!v2 && v2.kinds.includes('internal-name') })
    // ③ 正对照：合规 tag + 提交在主线 ⇒ 必须 exit 0（防"闸恒判红"的替身）
    const d3 = mkFixture({ tags: ['v0.0.1'] })
    const r3 = runGate(['--repo', d3, '--ref', 'origin/main', '--json'])
    cases.push({ id: '③ 正对照（v0.0.1，提交在 origin/main）', expect: 0, got: r3.code, kinds: [], ok: r3.code === 0 && r3.json?.ok === true && r3.json?.violations?.length === 0 })
    // ④ exit-2 负对照（一）：主线 ref 不存在 ⇒ exit 2（⛔ 不能当"0 个 tag"或"干净"放过）
    const d4 = mkFixture({ tags: ['v0.0.1'] })
    const r4 = runGate(['--repo', d4, '--ref', 'origin/does-not-exist', '--json'])
    cases.push({ id: '④ fail-closed（主线 ref 不存在）', expect: 2, got: r4.code, kinds: [], ok: r4.code === 2 })
    // ⑤ 非白名单命名支：release-1 既不是 vX.Y.Z、也不命中内部命名模式 ⇒ 必须 exit 1（报 non-release-name）
    //    （专测"白名单默认拒绝"这一支：④之前的负对照只覆盖了祖先不可达/内部命名）
    const d5 = mkFixture({ tags: ['release-1'] })
    const r5 = runGate(['--repo', d5, '--ref', 'origin/main', '--json'])
    const v5 = (r5.json?.violations || []).find((v) => v.tag === 'release-1')
    cases.push({ id: '⑤ 非白名单命名 tag（release-1，提交在主线）', expect: 1, got: r5.code, kinds: v5?.kinds || [], ok: r5.code === 1 && !!v5 && v5.kinds.includes('non-release-name') })
    // ⑥ exit-2 负对照（二）：非 git 仓 ⇒ 必须 exit 2（不静默报"0 个 tag = 干净"）
    const d6 = mkdtempSync(join(tmpdir(), 'tag-surface-nogit-'))
    fixtures.push(d6)
    writeFileSync(join(d6, 'not-a-repo.txt'), 'x\n')
    const r6 = runGate(['--repo', d6, '--json'])
    cases.push({ id: '⑥ exit-2 负对照（非 git 仓）', expect: 2, got: r6.code, kinds: [], ok: r6.code === 2 })
  } finally {
    for (const d of fixtures) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ } }
  }
  const bad = cases.filter((c) => !c.ok)
  if (AS_JSON) console.log(JSON.stringify({ ok: bad.length === 0, cases }, null, 2))
  else {
    console.log('tag-surface --self-test：')
    for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id} ｜ 期望 exit ${c.expect}，实际 ${c.got}${c.kinds.length ? ` ｜ kinds=${c.kinds.join(',')}` : ''}`)
    if (bad.length) console.log(`\n✗ tag-surface self-test ${bad.length}/${cases.length} 未通过 —— 负对照不成立即视为本闸失效`)
    else console.log(`\n✅ tag-surface self-test ${cases.length}/${cases.length} 通过（负对照都判红、正对照绿、两条 exit-2 负对照 fail-closed）`)
  }
  process.exit(bad.length ? 1 : 0)
}

// ── 仓库与主线 ref（两者都必须可解析，否则 fail-closed）─────────────────────────
// 显式给空值（含只写 flag 不给值）⇒ 不静默回退默认："--ref ''" 看着像指定了，实际什么都没核
if (hasFlag('--ref') && !REF) die('--ref 缺值/空值 —— 显式指定 ref 必须非空（空值不静默回退默认 origin/main）')
if (hasFlag('--repo') && !REPO_RAW) die('--repo 缺值/空值 —— 显式指定目录必须非空（空值不静默回退脚本所在仓）')
const repoArg = REPO_RAW
const REPO = repoArg ? resolve(repoArg) : SCRIPT_ROOT
if (repoArg && !existsSync(REPO)) die(`--repo 不存在：${repoArg}`)
const gitDir = git(REPO, 'rev-parse', '--git-dir')
if (gitDir.code !== 0) die(`不是可用的 git 仓库：${REPO}（${gitDir.err.slice(0, 160) || 'git rev-parse 失败'}）`)
const refProbe = git(REPO, 'rev-parse', '--verify', `${REF}^{commit}`)
if (refProbe.code !== 0) die(`主线 ref 不存在：${REF}（默认 origin/main；可用 --ref 指定；未核验 ≠ 干净）`)
const REF_SHA = refProbe.out
const repoLabel = repoArg ? REPO : (git(REPO, 'rev-parse', '--show-toplevel').out || REPO)

const nameProblem = (name) => {
  for (const [re, label] of INTERNAL_NAME_PATTERNS) if (re.test(name)) return { kind: 'internal-name', reason: `内部命名（${label}）` }
  if (!RELEASE_TAG.test(name)) return { kind: 'non-release-name', reason: `不在发布白名单 ^v\\d+\\.\\d+\\.\\d+$（如 release tag 拼写错误/自定义命名）` }
  return null
}

// ── tag 清单来源（默认=公开远端 origin；--local 才扫本地）───────────────────────
// 与 check-git-surface 同口径：**不扫本地 tags** —— 本地可能有从未推公开远端的内部冻结/标记 tag，
// 扫它们只会制造假红。只核"会被别人看到的公开 tag 面"，本地自查是显式的另一档。
const tagEntries = []   // { name, sha|null }  sha = 用于祖先判断的 commit（远端 annotated tag 先 peel）
let TAGS_SOURCE, sourceNote
const remoteProbeUrl = git(REPO, 'remote', 'get-url', 'origin')
const remoteUsable = remoteProbeUrl.code === 0 && git(REPO, 'ls-remote', '--tags', 'origin').code === 0
let srcMode = SOURCE
if (srcMode === 'auto') srcMode = remoteUsable ? 'remote' : 'local'
if (srcMode === 'remote') {
  if (!remoteUsable) die(`公开远端不可用（git ls-remote --tags origin 失败）—— 默认口径只核公开远端；确需本地自查请加 --local（或 --source local）`)
  const lsr = git(REPO, 'ls-remote', '--tags', 'origin')
  const peeled = new Map(), raw = new Map()
  for (const line of lsr.out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t')
    if (!ref || !ref.startsWith('refs/tags/')) continue
    const name = ref.slice('refs/tags/'.length)
    if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), sha)
    else raw.set(name, sha)
  }
  for (const [name, objectSha] of raw) tagEntries.push({ name, sha: peeled.get(name) || objectSha })
  TAGS_SOURCE = 'remote(origin)'
  sourceNote = `公开远端 tag（${remoteProbeUrl.out}）`
} else if (srcMode === 'local') {
  const tagList = git(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/tags')
  if (tagList.code !== 0) die(`枚举本地 refs/tags 失败：${tagList.err.slice(0, 160)}`)
  for (const name of (tagList.out ? tagList.out.split('\n').filter(Boolean) : [])) {
    const commit = git(REPO, 'rev-parse', '--verify', `refs/tags/${name}^{commit}`)
    tagEntries.push({ name, sha: commit.code === 0 ? commit.out : null })
  }
  TAGS_SOURCE = 'local(refs/tags)'
  sourceNote = (SOURCE === 'auto' ? '远端不可用 ⇒ 回落本地自查（不视为对外面）' : '--source local 本地自查（不视为对外面）')
} else {
  die(`--source 只接受 remote|local|auto（收到：${srcMode}）`)
}

// ── 逐 tag 检查 ────────────────────────────────────────────────────────────────
const tags = tagEntries.map((t) => t.name)
const violations = [], clean = [], undecided = []
for (const { name: tag, sha } of tagEntries) {
  const kinds = [], reasons = []
  let commitSha = sha || ''
  if (!commitSha) {
    kinds.push('unresolvable')
    reasons.push('tag 无法解析到提交（指向非 commit 对象或对象损坏）')
  } else {
    // 远端 tag 的提交可能尚未 fetch 到本地 ⇒ 祖先关系无法判定（exit 2，不猜成"违规"也不猜成"干净"）
    const present = git(REPO, 'cat-file', '-e', `${commitSha}^{commit}`)
    if (present.code !== 0) {
      undecided.push({ tag, commit: commitSha.slice(0, 8), reason: '本地缺该 tag 的提交对象（先 git fetch --tags 再核祖先关系）' })
      commitSha = ''
    }
  }
  if (commitSha) {
    const anc = git(REPO, 'merge-base', '--is-ancestor', commitSha, REF)
    if (anc.code === 1) {
      kinds.push('not-in-mainline')
      reasons.push(`不是 ${REF} 的祖先（git merge-base --is-ancestor 判否；旁支/孤儿 tag 会把未进主线的历史带到对外 tag 面）`)
    } else if (anc.code !== 0) {
      die(`tag ${tag} 的祖先判断失败（git merge-base 退出 ${anc.code}）：${anc.err.slice(0, 160)}`)
    }
  }
  const np = nameProblem(tag)
  if (np) { kinds.push(np.kind); reasons.push(np.reason) }
  if (kinds.length) violations.push({ tag, commit: sha ? sha.slice(0, 8) : null, kinds, reasons })
  else if (commitSha) clean.push(tag)
}

const result = {
  ok: violations.length === 0 && undecided.length === 0,
  undecidable: undecided.length > 0,
  repo: repoLabel,
  tagsSource: TAGS_SOURCE,
  sourceNote,
  ref: REF,
  refSha: REF_SHA.slice(0, 12),
  tags: tags.length,
  violations,
  undecided,
  clean,
}


if (AS_JSON) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`tag-surface: repo=${repoLabel} ｜ 来源=${TAGS_SOURCE} ｜ ref=${REF}(${result.refSha}) ｜ tags=${tags.length} ｜ 违规 ${violations.length} ｜ 无法判定 ${undecided.length} ｜ 干净 ${clean.length}`)
  for (const v of violations) {
    const face = v.kinds.map((k) => ({ 'not-in-mainline': '不在主线', 'internal-name': '内部命名', 'non-release-name': '非白名单', unresolvable: '不可解析' })[k] || k).join('+')
    console.log(`  ✗ [${face}] ${v.tag}${v.commit ? `（commit ${v.commit}）` : ''} —— ${v.reasons.join('；')}`)
  }
  for (const u of undecided) console.log(`  ⚠ [无法判定] ${u.tag}（commit ${u.commit}）—— ${u.reason}`)
  if (violations.length) console.log(`tag-surface: ✗ ${violations.length}/${tags.length} 个 tag 不合格 —— 修法：确认 tag 该不该留在对外面（旁支 tag 删/改名，内部标记 tag 不入对外仓）`)
  else if (undecided.length) console.log(`tag-surface: ✗ 无法判定 —— ${undecided.length}/${tags.length} 个 tag 的祖先关系核不了（先 git fetch --tags；未核验 ≠ 干净）`)
  else console.log(tags.length ? `tag-surface: ok —— ${tags.length} 个 ${TAGS_SOURCE} tag 全在 ${REF} 历史内且命中发布白名单` : `tag-surface: ok —— 0 个 tag（${TAGS_SOURCE}，无对外 tag 面可查）`)
}
process.exit(violations.length ? 1 : (undecided.length ? 2 : 0))
