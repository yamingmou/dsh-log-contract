#!/usr/bin/env node
/**
 * dsh-log-contract · scripts/prepublish-gate.mjs —— **发布泄漏闸门**（fail-closed）
 *
 * 为什么有这个文件（2026-09-14 泄漏事故 + 独立核验）：
 *   0.3.8–0.3.13 的在架版本带着**内部标识**走出去了（真实会话 id / 内部工具名 / 内部线名 /
 *   工单号 / 本机私有落点）。事故的直接成因是「**没有任何闸门**」——本仓的 `prepublishOnly`
 *   只有 pkg-meta + 语法 + 单测,`scripts/` 里没有任何泄漏扫描;而 dsh-retrace 那把闸门
 *   既不在本仓、`sanity` 又写死了"≥40 文件 + 必须含 lib/index.js"(套不到本仓 19 文件)。
 *
 * 设计（与 dsh-retrace 的 `--check-release` **同一套判定口径**,但**自带词表副本**——
 * 本仓要能独立 clone/发布,不能 import 兄弟仓的脚本；两边的词表改动必须同步）：
 *   · MUST0 命中 ⇒ **exit 1**（不发布）；
 *   · 发布集/sync 面**看起来不对**（文件数低于下限 / 缺必需文件 / --sync 目录不存在）⇒ **exit 2**
 *     ——「报 0」必须与「扫错地方」区分开,这是事故里最贵的教训；
 *   · ALLOW 只收**逐条列名 + 写理由**的例外,且未命中的条目会被点名（清单不许静默腐烂）。
 *
 * 用法：
 *   node scripts/prepublish-gate.mjs                    # npm 发布集（package.json#files 展开）
 *   node scripts/prepublish-gate.mjs --sync <目录>       # 公开仓同步面（整树,含 test/ scripts/ docs/）
 *   node scripts/prepublish-gate.mjs [--json] [--repo <目录>] [--min-files N] [--require a,b]
 * 退出码：0 干净 · 1 must-0 命中 · 2 扫描可疑
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 追加：从 internal/wordlist.json 的 _regex 派生正则（含"具体量/语料统计"类），与 publish-leaks 同源
try {
  const wl = JSON.parse(readFileSync(new URL('../../internal/wordlist.json', import.meta.url), 'utf8'))
  for (const r of wl._regex || []) {
    try { MUST0_RE.push(new RegExp(r, 'i')) } catch {}
  }
} catch { /* 无词表则跳过（不假绿：调用方仍会因缺词表告警） */ }


const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = 'scripts/prepublish-gate.mjs'

/**
 * **MUST0 —— 内部标识**（命中即失败）。与 dsh-retrace `scripts/public-projection.mjs` 的
 * `HARD_IDENTIFIER_PATTERNS` 保持同步；独立核验 2026-09-14 点名漏掉的 6 类
 * （engineer / opena-archive / gen-session-codes / dsh-retrace-private / session-<hex8> / seq <大数>）
 * 都必须在这里。
 *
 * **复验(0.3.14)又点名 2 类**，同样钉死在这里：① 内部能力名 `三折`/`三段式`（注入曾 GREEN）；
 * ② **裸大整数** seq 坐标（`seq` 字样规则要求数字紧邻 `seq`，于是不带字样的真实坐标逃逸）。
 *
 * **收口(2026-09-15,0.3.15)**：0.3.14 **已发布**的产物仍含内部标识,而上面这把闸门报 0 ——
 * 因为词表缺词(`三件套` / 私有工作区名 `opena`)。这是同一病根的**第三次**复发(词表人手维护、
 * 两仓各抄一份、且只补"最近一次被点名的词"),所以这轮不是再补两个词,而是按**有界判据**
 * 系统性收口,并把判据写进交付报告(`<private-lab>/report.md`)：
 *   · 入表判据 = ① 可判定(有可测形态) ② 外部不可导出(命名的是**我方工作流/工作区**里的东西,
 *     而非本包对外语义) ③ 本仓语料内一词一义(grep 验证无正当技术义,否则只收复合形,例:裸 `管道`)。
 *   · **每条新规则都要有注入必红用例 + 反向对照**,并由元测试保证"词表没有死条目"(见
 *     test/publish-leaks.test.js)。
 */
export const MUST0 = [
  { id: 'session-id-shape', re: /\b[0-9a-f]{8}-[0-9a-f]{4}\b/, why: '会话 id 形态(8-4 hex)' },
  { id: 'session-id-prefixed', re: /session-[0-9a-f]{8}/, why: '会话 id 形态(session-<8hex>)' },
  { id: 'session-id-known', re: /\b(?:1e99e1ff|6924781d|97786207|4b149a4a|1f4d986e|3f9e4f12|526f1835|89b3cb30|62c5b531|c2d05ce9|2c3f87d4|b7713ea1|e61d70da|73ed35d8|94108058|668f9166|65bcfa40|3ef7c70c|1c16146f|68f242a6|fea7c484)\b/, why: '已确证的内部会话 id(登记表)' },
  { id: 'session-seq', re: /\bseq\s*[:=]?\s*\d{6,}\b/, why: '会话 seq 号(真实 seq 是百万级)' },
  {
    id: 'session-seq-bare',
    // 复验(0.3.14)实测:只认「紧邻 seq 字样」会漏掉**裸坐标**——真实泄漏样例
    // `(真实数据实测:1360270 → 1360265 的跨度是正常写入)` 带 seq 字样吗?没有,于是逃逸。
    // 排除项都写了理由:① YYYYMMDD 基线日期(对外文档本就该有日期,泛化会假红);
    // ② 已审定常量(1 MiB / 1e6 / zstd 魔数)。**已知代价**:值形如日期的真 seq 会漏,
    // 由上面的登记表兜底(不假装零漏,只保证"已见的必被记名")。
    re: /\b(?![12]\d{3}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b)(?!1048576\b|1000000\b|4247762216\b)\d{7,}\b/,
    why: '裸大整数(真实会话 seq 坐标,不带 seq 字样也算);已排除 YYYYMMDD 日期与已审定常量',
  },
  { id: 'comm-ticket', re: /comm-\d+/, why: '内部协作工单号' },
  { id: 'shortcode', re: /op0\d+|dx0\d+/, why: '内部成员短码(含拼接形)' },
  { id: 'fossil-name', re: /\b[0-9a-f]{8}-(?=[a-z])/, why: '化石文件名里的会话 id 前缀 <id>-<tag>' },
  { id: 'line-name', re: /修复线|\bfix-line\b|三折|三段式/, why: '内部工作线/能力名(修复线·fix-line·三折·三段式)' },
  {
    id: 'capability-name',
    // 与 dsh-retrace `scripts/public-projection.mjs` 的 CAPABILITY_PATTERNS **同步**(收口 2026-09-15):
    // 该侧把 `三件套`/`折叠三件套`/`水位`/`路标卡`/`折前预览`/`自动折叠` 列为内部能力/特性词汇。
    // 实测泄漏:`README.zh.md`/`README.md` 曾有「按 … 三件套规划定名」的叙事(0.3.14 发布面)。
    re: /三件套|水位|路标卡|折前预览|自动折叠/,
    why: '内部能力/特性词汇(三件套·水位·路标卡·折前预览·自动折叠)',
  },
  {
    id: 'layer-name',
    re: /私有线|公开线/,
    why: '内部分层词(私有线·公开线)',
  },
  {
    id: 'workspace-name',
    // **必须写成 `\bopena\b`**:裸 `opena` 会打在 `openable` / `openai` / `openapi` 上
    // (假红同样是事故)。反向对照见 test/publish-leaks.test.js:`openable` 与**本仓真实存在**的
    // `OpenAI 兼容端点` 都必须保持 GREEN。
    re: /\bopena\b/,
    why: '私有工作区名(opena;词边界限定,避免 openable/openai 假红)',
  },
  {
    id: 'internal-doc',
    // **内部任务/审计文档引用**(收口 2026-09-15,由"从私有边界反扫"发现,不在最初点名的类别里)。
    // 判据③(本仓语料内一词一义)+ 证据:下列名字对应的 `.md` **只存在于私有边界**
    // (`<private-lab>/**`),本仓任何位置都没有它们 —— 在公开面引用 = 连内部文档名一起公开。
    // 实测:`lib/contracts.js` 的 `source` 字段 / `docs/CONTRACTS.md` / `lib/archaeology.js` /
    // `lib/checks.js` / `bin/` / CHANGELOG / test 标题里都出现过。
    // 刻意**不收**裸 `复盘`(通用事故复盘义,本仓真用)与 `健康巡检报告`(本仓 `scripts/health-scan.mjs`
    // 自己的产物名,属公开词汇) —— 见报告"被判定为不该入表的候选"。
    re: /任务书|反向挑刺|插件任务|疑点记录|复盘-会话修复事故/,
    why: '内部任务/审计文档引用(任务书·反向挑刺·插件任务·疑点记录·事故复盘文档名)',
  },
  {
    id: 'pipeline-name',
    // 描述"公开面是怎么生成的"的管线词。**只收复合形**:裸 `管道`(本仓真用:"非阻塞管道"/
    // "真管道")、裸 `投影`、裸 `剥离`(通用技术义)一律不入表 —— 判据③,见报告。
    re: /公开投影|投影重建|管道剥离|投影标记|投影产物/,
    why: '内部投影管线词(公开投影·投影重建·管道剥离·投影标记·投影产物)',
  },
  {
    id: 'process-vocab',
    // **过程/机制语汇**(收口 2026-09-15,0.3.16):0.3.15 **自己**就是泄漏源 —— 它把"这条规则是
    // 谁复核的、属于第几轮、按什么编号确认的"写进了注释与文档,于是外部读者能从已发布面
    // 反推出**我方是怎么组织生产与验收的**(有几个复核环节、有没有外部审计、评审是几轮)。
    // 这类的技术信息量为 0(规则的技术依据另有官方源码行号),所以整类挡掉,而不是逐词补。
    //
    // 判据③(本仓语料内一词一义)在这里**尤其**要认真执行,因为它和产品词汇高度同形:
    //   · **裸 `复核`/`审计`/`闸门`/`词表`/`突变` 全部允许** —— 它们在本仓都有正当技术义:
    //     `复核` = 重新核对(如"未在 0.1.5 上复核");`审计`/`考古审计报告` = **产品功能名**
    //     (`audit-report` 子命令);`闸门` = 产品安全闸("S2 安全闸"、"宿主能力闸");
    //     `词表` = 事件类型词表(产品术语);`突变` = 通用工程词(突变测试)。
    //   · 只收**复合形**或**带编号**的形:带上"谁做的/第几轮/编号几"之后,词义就从技术变成流程。
    //   反向对照(必须保持 GREEN)见 test/publish-leaks.test.js:`考古审计报告`、`S2 安全闸`、
    //   `事件类型词表`、`突变测试`、`未在 0.1.5 上复核`、`体检`、`健康巡检报告-*.md`。
    //
    // **刻意不收 `\bM\d+\b` / `\bF\d+\b` / `\bAC\d+\b` / `\bN\d+\b`(裸编号)**:`M1` 是**产品规则 id**
    // (`assistant/message` turn-null 只能 replace),泛化会打在它身上 —— 这类"编号只在特定位置
    // 才是内部号"的形由人读复核,不入表(见交付报告里的边界说明)。当前形态已全部人工清除。
    re: /独立复核|独立核验|独立审核|独立审查|独立复验|对抗性复核|对抗性复查|相互复核|交叉复核|外部审计|外部 AI 审计|内部审计|内部评审|审计批次|审计留档|复核报告|复核原话|复核裁定|复核判定|复核补强|复核结论|最终复核|评审裁定|裁定|变异 ?\d+|突变存活|突变矩阵|突变表|杀死突变|发布泄漏闸门|泄漏闸门|泄漏扫描|过程语汇|机制语汇|对外面核验|对外核验|发布前泄漏|independent (?:review|audit|verification)|adversarial review|external audit|mutation (?:survived|matrix|killed)|review board|ruling [A-Z]-[A-Z]?/,
    why: '过程/机制语汇(复核/审计/裁定/变异编号/泄漏闸门一类"描述我们怎么生产"的词;裸 复核·审计·闸门·词表·突变 允许)',
  },
  { id: 'role-name', re: /\bengineer\b/, why: '内部角色/线名(engineer)' },
  { id: 'internal-tool', re: /tools\/check-[a-z-]+\.mjs|\bcheck-(?:null-turn|step-keys|turn-end-reason)\.mjs/, why: '内部工具名(tools/ 下自查脚本)' },
  { id: 'gen-script', re: /gen-session-codes/, why: '本机/私有短码生成脚本名' },
  { id: 'home-path', re: /~\/(?!(?:\.dsh|dsh-v3|plugins|Library)\/)[A-Za-z0-9._-]+\//, why: '波浪号本机 home 路径(非产品路径约定)' },
  { id: 'abs-home', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//, why: '绝对本机 home 路径' },
  { id: 'mangled-user', re: /\bUsers-[A-Za-z0-9]+-/, why: '本机用户名(压平路径形态)' },
  { id: 'private-repo', re: /dsh-retrace-private/, why: '私有仓名' },
  { id: 'private-dir', re: /opena-archive|dsh-lab|identity-draft/, why: '私有目录名' },
  { id: 'marker-residue', re: /@public-strip/, why: '未剥离的投影标记' },
]

/**
 * **ALLOW —— 逐条列名 + 写理由**（未列入的命中一律算 must-0,fail-closed）。
 *
 * **2026-09-15 独立复验 F1 后的结构性修改:本清单现在按设计为——空。**
 *
 * 复验指出的要害不是"豁免写得太宽",而是:**扫描器自身被公开仓 tracked**。它逐字列着
 * 内部词汇(`三件套`/`私有线`/`opena`/`任务书`/…)与私有路径,注释里还有内部报告名 ——
 * 于是"把它整文件豁免"只让闸门**看不见**它,**它照样躺在公开面上**。
 *
 * 处置(不是收窄豁免,而是让豁免不再需要):扫描器与它的注入测试、以及同样逐字带内部
 * 词汇/路径的维护者工具(`scripts/health-scan.mjs`、`scripts/check-local-fossils.mjs`)
 * 已 **`git rm --cached` + 进 `.gitignore`** —— 文件留在本地,闸门与 `prepublishOnly` 照跑,
 * 但**不进公开仓**。npm 发布集本就不含 `scripts/`、`test/`,所以下沉零损失。
 *
 * 于是新判据(复核给的公开面判据)可满足:`git archive HEAD` 导出的 **tracked-only** 树,
 * 用完整词表扫、**不加任何文件级豁免** ⇒ **0 命中**。
 *
 * 保留这个清单(而不是删掉机制)是为了**未来**真的有"不可不下沉、又必须豁免"的 tracked
 * 文件时,仍走"逐条列名 + 理由"的正门;但**默认必须是空的** —— 任何新增条目都要能回答:
 * "为什么不把这个文件下沉?" 答不上来就不许加。
 */
export const ALLOW = []

/** 该文件是否整文件豁免(当前恒为 undefined —— 见 ALLOW 的说明)。 */
export function allowedFile(file) {
  return ALLOW.find((entry) => entry.file === file)
}

/** 扫描一个文件的文本 → must-0 命中。 */
export function scanText(file, text) {
  if (allowedFile(file)) return []
  const hits = []
  text.split('\n').forEach((lineText, index) => {
    for (const rule of MUST0) {
      rule.re.lastIndex = 0
      if (!rule.re.test(lineText)) continue
      hits.push({ file, line: index + 1, id: rule.id, why: rule.why, text: lineText.trim().slice(0, 200) })
    }
  })
  return hits
}

/** npm 发布集 = `files` 通配展开 + npm 必带文件 + bin。 */
export function publishSetOf(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const out = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.add(full)
    }
  }
  for (const glob of pkg.files ?? []) {
    if (!glob.includes('**')) {
      const full = join(repoRoot, glob)
      try { if (statSync(full).isFile()) out.add(full) } catch { /* 缺文件由 sanity 报 */ }
      continue
    }
    // 只支持 `dir/**/*.ext` 这一种形态（本仓 files 就是这么写的）
    const [head, tail] = glob.split('**')
    const ext = tail.replace(/^\/\*?/, '')
    const base = join(repoRoot, head)
    try {
      if (statSync(base).isDirectory()) {
        for (const f of walkFiles(base)) if (f.endsWith(ext)) out.add(f)
      }
    } catch { /* ditto */ }
  }
  for (const always of ['README.md', 'README.zh.md', 'package.json', 'LICENSE']) {
    try { if (statSync(join(repoRoot, always)).isFile()) out.add(join(repoRoot, always)) } catch { /* 可选 */ }
  }
  for (const bin of Object.values(pkg.bin ?? {})) {
    const full = join(repoRoot, String(bin).replace(/^\.\//, ''))
    try { if (statSync(full).isFile()) out.add(full) } catch { /* 可选 */ }
  }
  return [...out].sort()
}

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * 发布集完整性 sanity —— **参数化**（2026-09-14 独立核验：写死 retrace 口径会让本仓直接 exit 2）。
 * 默认值就是本仓口径（19 文件量级 + lib/index.js）。
 */
export function assertPublishSetSanity(files, options = {}) {
  const { repoRoot = REPO_ROOT, minFiles = 15, required = ['README.md', 'package.json', 'lib/index.js'] } = options
  const names = new Set(files.map((f) => relative(repoRoot, f)))
  if (files.length < minFiles) return `publish set has only ${files.length} files (expected >= ${minFiles})`
  for (const rel of required) if (!names.has(rel)) return `publish set is missing ${rel}`
  return null
}

/** 扫描（发布集或整树）。 */
export function scan(files, repoRoot = REPO_ROOT) {
  const hits = []
  for (const absolute of files) {
    let text
    try { text = readFileSync(absolute, 'utf8') } catch { continue }
    if (text.includes('\u0000')) continue
    hits.push(...scanText(relative(repoRoot, absolute), text))
  }
  return hits
}

/**
 * **F2 —— 被引用的 `.md` 必须在树里真实存在**（可判定检查,替代"枚举内部文档名"）。
 *
 * 为什么需要它(2026-09-15 独立复验 F2):`scripts/health-scan.mjs` 里引用了
 * `<private-lab>/EMERGENCY-SOS-外部急救包.md` —— 该文件**只存在于私有边界**,本仓任何位置都没有,
 * 而"枚举内部文档名"的词表**永远追不上**新出现的内部文档。可判定的判据是:**引用即声明存在**:
 * 公开面引用的 `.md` 若在这棵树里找不到 ⇒ 它引用的是一份外部不可见文档 ⇒ 命中。
 *
 * 显式豁免(逐条列名 + 理由 + **打印**,不静默):
 *   · URL(`http(s)://…`)里的 `.md` —— 指向外部站点,不是本树文件;
 *   · 含 `*` 的通配/模板名(如产物名模板);
 *   · 下面 `DOC_REF_ALLOW` 里逐条列出的模板名。
 * 测试合成路径(如 fixture 里的假文件名)不在此列 —— 它们应写在 `test/`,而 `test/` 里的
 * 引用**也算**:要么那个名字真实存在,要么改掉引用(本轮就是这么处理的)。
 *
 * 已知边界(诚实记录):按 **basename 或 相对路径** 判定存在性 —— 不解析 markdown 链接语义,
 * 也不校验"引用的语气"(提到 vs 引用)。这是有意取舍:可判定、零误判成本的方向。
 */
export const DOC_REF_ALLOW = [
  { re: /^健康巡检报告-YYYYMMDD-HHMM\.md$/, why: '本仓巡检脚本的产物名模板(时间戳占位,非真实文件)' },
]

// **必须带 `i`**:复核实测 `.MD` / `.Md` 会绕过存在性检查(只认小写 `.md`)。
// 大小写不敏感后,引用 `README.MD` 而树里只有 `README.md` 会被判不存在 ——
// 这是**有意的 fail-closed**(Linux 上确实不存在;macOS 大小写不敏感只是巧合)。
const MD_TOKEN = /[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff-]*\.md/gi
const URL_SPAN = /https?:\/\/\S+/g

/** 扫描「被引用的 .md 是否存在」。@returns {{hits: object[], allowed: object[]}} */
export function scanDocRefs(files, repoRoot = REPO_ROOT) {
  // 树内文件名(全树,含未在 files 里的文件 —— 引用可以指向树里任何位置)
  const names = new Set()
  const relPaths = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      names.add(entry)
      relPaths.add(relative(repoRoot, full).split('\\').join('/'))
    }
  }
  try { walk(repoRoot) } catch { /* 目录不可读:交由调用方的 sanity 报 */ }

  const hits = []
  const allowed = []
  for (const absolute of files) {
    let text
    try { text = readFileSync(absolute, 'utf8') } catch { continue }
    if (text.includes('\u0000')) continue
    const rel = relative(repoRoot, absolute)
    text.split('\n').forEach((line, index) => {
      URL_SPAN.lastIndex = 0
      const urlSpans = []
      let u
      while ((u = URL_SPAN.exec(line)) !== null) urlSpans.push([u.index, u.index + u[0].length])
      MD_TOKEN.lastIndex = 0
      let m
      while ((m = MD_TOKEN.exec(line)) !== null) {
        const token = m[0]
        const at = m.index
        if (urlSpans.some(([a, b]) => at >= a && at < b)) continue      // URL 里的 .md
        if (token.includes('*')) continue                                 // 通配/模板
        const exists = token.includes('/') ? relPaths.has(token.replace(/^\.\//, '')) : names.has(token)
        if (exists) continue
        const hit = { file: rel, line: index + 1, id: 'doc-ref', ref: token, text: line.trim().slice(0, 200) }
        const exception = DOC_REF_ALLOW.find((a) => a.re.test(token))
        if (exception) allowed.push({ ...hit, why: exception.why })
        else hits.push({ ...hit, why: '引用的 .md 在本树里不存在(外部不可见文档)' })
      }
    })
  }
  return { hits, allowed }
}

/** 打印「被引用 .md」检查结果(must-0 与显式豁免都打印,不静默)。 */
function reportDocRefs({ hits, allowed }) {
  if (allowed.length > 0) {
    console.log(`  ⓘ 引用 .md 的显式豁免 ${allowed.length} 处(逐条列名 + 理由):`)
    for (const a of allowed) console.log(`      ${a.file}:${a.line}  [${a.ref}]  —— ${a.why}`)
  }
  if (hits.length > 0) {
    console.log(`❌ 引用了本树不存在的 .md = ${hits.length} 命中（exit 1）：`)
    for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.id}] ${h.ref}  —— ${h.why}`)
  } else {
    console.log(`✅ 被引用的 .md 存在性 = 0 命中(URL / 通配 / 已列名模板除外)`)
  }
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isMain) {
  const json = process.argv.includes('--json')
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name)
    return i !== -1 ? process.argv[i + 1] ?? fallback : fallback
  }
  const repoRoot = resolve(arg('--repo', REPO_ROOT))
  const minFiles = Number(arg('--min-files', '15'))
  const requireArg = process.argv.indexOf('--require') !== -1 ? String(arg('--require', '')).split(',').filter(Boolean) : undefined
  const syncDir = arg('--sync', null)

  if (syncDir !== null) {
    const root = resolve(syncDir)
    const st = statSync(root, { throwIfNoEntry: false })
    if (!st?.isDirectory()) {
      console.log(`❌ --sync 目录不存在: ${root}（"报 0" 可能只是扫错了地方，exit 2）`)
      process.exit(2)
    }
    // 公开仓同步面 = **git 推上去的文件**：git 仓只算 tracked（未跟踪/被 .gitignore 的本地备份
    // 不进公开仓——本仓 `backups/` 就是 gitignored）。非 git 目录（如投影产物）退回整树。
    let files = walkFiles(root).filter((f) => !f.includes('/node_modules/') && !f.includes('/.git/'))
    if (statSync(join(root, '.git'), { throwIfNoEntry: false })) {
      const listed = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (listed.status === 0) {
        const tracked = new Set(String(listed.stdout ?? '').split('\u0000').filter(Boolean).map((rel) => join(root, rel)))
        files = files.filter((f) => tracked.has(f))
      }
    }
    const hits = scan(files, root)
    const refs = scanDocRefs(files, root)
    const suspicious = files.length < 20
    if (json) console.log(JSON.stringify({ surface: 'sync', root, files: files.length, hits, docRefHits: refs.hits, docRefAllowed: refs.allowed }, null, 1))
    else {
      console.log(`publish-leaks --sync: ${root}`)
      console.log(`  files scanned: ${files.length}`)
      if (suspicious) console.log(`❌ 扫描可疑：只有 ${files.length} 个文件 —— "报 0" 可能只是扫错了地方（exit 2）`)
      else {
        if (hits.length > 0) { console.log(`❌ must-0 类 = ${hits.length} 命中（exit 1）：`); for (const h of hits.slice(0, 60)) console.log(`  ${h.file}:${h.line} [${h.id}] ${h.text}`) }
        else console.log('✅ must-0 类 = 0 命中')
        reportDocRefs(refs)
      }
    }
    process.exit(suspicious ? 2 : (hits.length + refs.hits.length) > 0 ? 1 : 0)
  }

  const files = publishSetOf(repoRoot)
  const hits = scan(files, repoRoot)
  const refs = scanDocRefs(files, repoRoot)
  const sanity = assertPublishSetSanity(files, { repoRoot, minFiles, ...(requireArg ? { required: requireArg } : {}) })
  if (json) console.log(JSON.stringify({ surface: 'publish', repoRoot, files: files.length, hits, docRefHits: refs.hits, docRefAllowed: refs.allowed, sanity }, null, 1))
  else {
    console.log(`publish-leaks: scanned ${files.length} files (repo root resolved from this script, never CWD)`)
    if (sanity !== null) console.log(`❌ 扫描可疑：${sanity} —— "报 0" 可能只是扫错了地方（exit 2）`)
    else {
      if (hits.length > 0) { console.log(`❌ must-0 类 = ${hits.length} 命中（exit 1）：`); for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.id}] ${h.text}`) }
      else console.log('✅ must-0 类 = 0 命中')
      reportDocRefs(refs)
    }
  }
  process.exit(sanity !== null ? 2 : (hits.length + refs.hits.length) > 0 ? 1 : 0)
}
