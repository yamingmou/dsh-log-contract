<div align="center">

# 🔒 dsh-log-contract

**会话日志契约守护** —— DSH 会话日志的结构性保险丝：离线体检 + 写前校验。业务层的**医生**。

[![npm version](https://img.shields.io/npm/v/dsh-log-contract)](https://www.npmjs.com/package/dsh-log-contract)
[![npm downloads](https://img.shields.io/npm/dm/dsh-log-contract)](https://www.npmjs.com/package/dsh-log-contract)
[![License: MIT](https://img.shields.io/npm/l/dsh-log-contract)](https://github.com/yamingmou/dsh-log-contract/blob/main/LICENSE)
[![DSH ecosystem](https://img.shields.io/badge/DSH-ecosystem-4A90D9)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/yamingmou/dsh-log-contract/pulls)

[English](./README.md) · **简体中文**

</div>

## 这是什么

原名 `log-contract-validator`，现为 **`dsh-log-contract`**。

一条会话日志（`*.jsonl` / `*.jsonl.zstd`）有两类读者：人（容忍格式漂移）与程序（漂移就崩）。
本工具检查日志的**结构**——帧布局、事件信封、`seq` 连续性、surface/replace 规则、wire 消息
顺序、插件 marker——并用一个退出码回答一个问题：

> **下游读者（Harness 读路径 / 客户端引擎 / 插件语义）会不会在这份文件上崩？崩在哪？**

它不判断对话内容好坏；也可以在**写入之前**用同一套规则把违约写入拦下（写前校验）。

### 30 秒速览

- **是什么**：DSH 会话日志的结构检查器；输入是一份 `.jsonl` / `.jsonl.zstd`。
- **为什么装**：它能抓到人眼看不出、但解析器会崩的格式漂移，并在坏写入落盘前拦住。
- **最小用法**：三条命令——见[快速开始](#快速开始3-条命令)。
- **可机械检查**：每条规则都有稳定 id、严重度、出处和正/负对照用例；输出是稳定的 JSON 报告
  加一份有文档的退出码。
- **去哪看更多**：[规则目录](docs/CONTRACTS.md) ·
  [报告家族](#规则家族哪些会判红) · [版本对照](VERSIONS.md) · [更新记录](CHANGELOG.md)。

## 业务层定位

> **`dsh-log-contract` 是 [dsh-retrace](https://github.com/yamingmou/dsh-retrace) 的核心
> 检查-修复组件**，即业务层的"医生"模块：它保证每一次回忆 / 编辑 / 回滚都落在合法的日志上——
> 写前校验在**任何写入落盘之前**拒绝 error 级违规。

| 层 | 是什么 | 组成 |
|---|---|---|
| **Agent 业务层（生产级）** | 与框架无关的核心：会话卫生 / 可追溯 / 可审计 / 可恢复 | 四个模块：治理 / 回顾 / 考古 / **医生** |
| **dsh-retrace** | 业务层在 DeepSeek Harness 上的实现 | 回忆 / 编辑 / 版本 / 回滚 / 看门狗 |
| **dsh-log-contract** | dsh-retrace 的核心组件 = 业务层的**医生**（检查 & 修复） | check / prewrite / fix / extract / audit-report |

**含义**：本包独立发布（可直接使用或按契约重实现），但它首先是 dsh-retrace 的"检查 & 修复"
能力——两者共同构成 DSH 上的 **Agent 业务层（生产级保证）**。

**关于 `/compact`（如实表述）**：本工具保证的是**新写入**不再制造 token-meter 配对债——
双段原子载体（marker + 配对段）落地后，新 marker 天然通过 T1。**历史**（单段）marker 仍是
**已知设计债**：写前校验把它们的 T1 降级为 warning（`lib/prewrite.js` 的
`legacyMarkerKindOf`，只作用于历史 marker），因此这类会话在压缩前需要**一次检查 + 清理**
（`check` 定位 → `fix --remove-markers`）。否则 T1 自检会挡住 `/compact`。

## 为什么存在

**一条日志、两类读者、两种结论。** 人容忍格式漂移；程序依赖严格契约。格式一漂，人看不出问题，
程序却崩溃或给出错误结论。

**这里的大多数规则都由真实坏会话塑造**——见[事故表](#事故表为什么生产级不是口号)。每个案例
都有回归用例钉住：坏形状必须判红、修好的形状必须判绿。其余规则来自对官方宿主源码的逐行核对
（每条规则都带 `source` 出处）。

## 快速开始（3 条命令）

运行要求：**Node ≥ 22**（内置 zstd）＋ peer 依赖 `@deepseek-ai/dsh-session`
（解码/折叠语义直接复用宿主实现）。

```bash
# 1. 安装（也可以不装，直接用 pnpm dlx）
pnpm add -D dsh-log-contract

# 2. 体检一份会话日志，机器可读输出
pnpm dlx dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --json

# 3. 查看全部日志契约规则（id / 严重度 / 出处）
pnpm dlx dsh-log-contract contracts
```

> **在用 dsh-retrace？** 不需要单独安装——它把 `dsh-log-contract` 声明为依赖，守卫随插件带入。
> **下载的是 ZIP？** `cd dsh-log-contract && npm install`，再跑
> `node bin/dsh-log-contract.mjs check <log>`（无构建步骤、无需全局安装）。

## 体检输出与退出码

```text
📋 dsh-log-contract check —— <file>
   事件 204754 ｜ surface 节点 16 ｜ replace 代数 5 ｜ 帧 8620
   违规 1（error 1 / warning 0）

  [error] S5 @ seq <seq> / line <line> (assistant/message)
      surface replace: sourceEventSeqs 必须覆盖每个被替换节点；缺失 121774, 121779（共 2 个）

❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）
```

### 退出码

`check` 使用 `0 / 1 / 3 / 4`——**没有 `2`**。`error-contract` 是另一条命令，有自己的错误码。

| 退出码 | 命令 | 含义 |
|---|---|---|
| `0` | `check` | 通过——无 error 级违规，且迁移预检未 blocked |
| `1` | `check` | 存在 error 级违规（下游读者会失败） |
| `3` | `check` | 不可在本宿主评估（文件格式新于宿主支持上限）——**不是**"坏了" |
| `4` | `check` | 迁移预检 blocked（官方升级链会拒绝该文件） |
| `0 / 1 / 2` | `error-contract` | 无疑点（第三方产物疑点默认只登记） / 有 error 级疑点（T1；T2 需 `--strict`） / 无法判定（输入有误） |

### 三档结论（`check --resume`）

| 档位 | 认证什么 | `--json` |
|---|---|---|
| `loadable` | 会话能被读入（结构规则） | `resume.loadable` |
| `resumable` | ＋ inbox 重放合法 | `resume.resumable` |
| `compactable` | ＋ token-meter 配对合法 | `resume.compactable` |
| `broken` | 第一档就不过 | `resume.verdict` |
| `not-assessable` | 本宿主判不了（退出码 3） | `assessable: false` |

### 哪些"没有判"（不要读成通过）

`ok: null` / `skipped` = **不可判定**，不是成功。所有可选段同一个口径：

| 情形 | 字段 / 值 | 怎么读 |
|---|---|---|
| 没有身份登记表（npm 安装包不含 `docs/identity-registry.json`） | `identity.ok: null` | 不可判定——在源码仓/发布流程里做身份校验 |
| 运行时断言缺输入 | 断言 `ok: null`，列在 `skipped` | 不可判定——补运行记录 |
| 归档读端未就绪 / 暂不可读 | `archive.verdict: "unverifiable"`（`notReady`、`unavailable`） | **不是**"内容缺失"；读端恢复后重试 |
| 宿主太旧、判不了文件格式 | `assessable: false`，退出码 3 | 不是健康结论 |
| 最后一帧写入中被切 | `summary.tailStatus: interrupted / truncated / unknown` | `ok: true` 只认证已读到的事件 |

**尾部边界**：`ok: true` 从不承诺文件完整。`interrupted`（尾帧撕裂）宿主读端可恢复；
`truncated` 表示记录真的缺；`unknown` 表示尾部不可读。

## 三层契约（模型）

> **四个报告家族、共 72 条**：下表 **57 条日志契约**（每条带官方出处）＋ **6 条错误表达**
> （E1–E6）＋ **2 条版本同一性**（ID1/ID2）＋ **7 条运行时契约**。`contracts` 只列 57 条
> 日志契约；其余家族各有独立文档。

| 层 | 规则 | 守护什么 |
|---|---|---|
| **持久化** | H/R/E/S（含 **S5**）+ **S9** | `seq` 连续；类型已知；`surfaceOp` 合法；`sourceEventSeqs` 覆盖每个被替换节点；文件物理序 `seq` 单调；`foldSurface` 不抛错 |
| **客户端引擎** | **M1** + **T1 / T2 / I1** | turn-null marker 只能 replace；token-meter 配对；跨 step 源引用；inbox seed 相对重放 |
| **wire 消息流** | **W1 / W2** | tool 消息必须跟在带 tool_calls 的 assistant 之后；tool_calls 与结果之间不得插 user 文本 |
| **插件语义** | **P1 / P2** | marker id 前缀可识别；marker 自身 seq 不得出现在自身 shadowed 集 |
| **帧结构** | **Z1–Z8** | zstd 帧形状（header 独占首帧；不得压成单帧）、空会话、尾部完整性、帧尺寸/校验和 |
| **读取 / 聚合** | **R4 / R5** | 单文件损坏必须降级为结构化、可计数结果（不抛错、不中断枚举）；聚合按项隔离失败 |

> 判定哲学：先按官方同语义做增量重放，**逐事件归因**（定位到 `seq` / 行号），再用官方
> `foldSurface` 做**终验**（不抛错 = 通过）——两者都绿才算过。

## 规则家族（哪些会判红）

每条规则都有稳定 id、严重度、出处，以及**正/负对照用例**（违规样本必须红、合规样本必须绿）。
四个家族按 `family` 分派，⛔ 不要按 id 字面合并。

| 家族（`family`） | 条数 | 守护什么 | 全量清单 |
|---|---|---|---|
| **日志契约 log contract** | **57** | 持久化日志：帧形状（Z）、header（H）、存储行（R）、事件信封/seq（E）、surface 不变量（S）、客户端引擎（T/M/I）、wire 顺序（W）、插件 marker（P）、并发（C）、迁移预检（G）、归档可还原（A） | [docs/CONTRACTS.md](docs/CONTRACTS.md) |
| **错误表达 error-expression** | **6**（E1–E6） | 把错误处理当契约：一码多成因、message 常量、终态词误用、cause 被吞、无条件成功、声称但无执行点 | [docs/ERROR-CONTRACT.md](docs/ERROR-CONTRACT.md) |
| **版本同一性 version-identity** | **2**（ID1–ID2） | *跑的是不是声明版本承诺的那一份？* ID1 一物一号（同版本只能对应一个摘要）；ID2 号可验（摘要由产物计算并与版本绑定） | [docs/interface-versioning.md](docs/interface-versioning.md) |
| **运行时契约 run-contract** | **7** | *跑起来会不会静默变样？* R-1 失败置位不清零；R-2a 写失败不得标完整；R-2b 撤回必须带消费方可读原因；R-2b-2 初始化中 ≠ "没有"；R-3 输入缺失 ⇒ 不兼容；R-5 闭集穷尽 / 开集不穷尽；R-6 同键副作用幂等 | [docs/RUN-CONTRACT.md](docs/RUN-CONTRACT.md) |

合计 **72** 条断言（57 + 6 + 2 + 7）。run-contract 的 id **不是**连续的 1…7——代码里的 id 是
`R-1 / R-2a / R-2b / R-2b-2 / R-3 / R-5 / R-6`（这就是全部七条）。日志家族的 S9 还额外输出
病因分类（`old-cursor-replay` / `concurrent-writer` / `format-mix`）与置信度/判定式；
S9 的判定本身不变。

## 身份契约（ID1 / ID2）——"跑的是不是你以为的那一份？"

**独立报告家族**（`version-identity`）：不计入 57 条日志契约，也**不进 `ok` / 退出码**——
它回答"运行产物是不是声明版本承诺的那一份"。

| 规则 | 守护什么 |
|---|---|
| `ID1` | **一物一号**：登记表（`docs/identity-registry.json`）里同一版本不得对应两个不同内容摘要 ⇒ 判红并带 `file:line` 证据（重复登记但摘要相同不报）。 |
| `ID2` | **号可验**：摘要由**产物**实算——运行身份 = `lib/**/*.js` + `bin/**/*.mjs` 逐文件 sha256 → 排序后再 sha256——并与 `package.json.version` 绑定。未登记、摘要不符/伪造、或**同号改了代码** ⇒ 判红；**只改文档 ⇒ 摘要不变 ⇒ 绿**（不制造噪音）。 |

`check --json` 以 `identity` 段暴露（`family` / `rules` / `ok` / `version` / `digest` /
`runtime` / `registry` / `findings[]`（带 `file:line`）/ `summary`）；登记表缺失时
`identity.ok` 为 `null`（**不可判定**，不冒充通过）——npm 包只带 `docs/**/*.md`。
换版本或改运行时代码后重登记：`pnpm identity:register`（仅源码仓；npm 包不含 `scripts/`）。

## 运行时契约（7 条）——"跑起来会不会静默变样？"

**独立报告家族**（`run-contract`，`check --json` 暴露为 `runContract`），同样不进
`ok` / 退出码。它为真实运行记录提供断言函数：

| 规则 | 断言 | 守护什么 |
|---|---|---|
| `R-1` | `assertFailureLatched(history)` | 失败必须**置位**：出现 `failed: true` 后，恢复/重载/清缓存的任何快照都不得写回 `failed: false` |
| `R-2a` | `assertWriteOutcome({ write, artifact })` | 写入失败或结果未知时，产物不得标 `complete`——必须撤回或标 `partial` / `unavailable` / `withdrawn` |
| `R-2b` | `assertWithdrawalHasReason({ withdrawals, reasonField?, reasonSupported? })` | 撤回类响应必须带**消费方可读的原因**；原因只在日志/遥测旁路 ⇒ 红；实现侧无该字段 ⇒ `ok: null` |
| `R-2b-2` | `assertInitializedNotTreatedAsEmpty({ resources })` | 资源初始化中/取不到时不得按空值推"没有"；无初始化信号 ⇒ `ok: null` |
| `R-3` | `assertFailClosed({ required, provided, result })` | 任一必需输入（字段/文件/上下文）缺失 ⇒ 判定必须**不兼容**，且原因点名缺项 |
| `R-5` | `assertClosedSetExhaustive({ closedSet, covered })` / `assertOpenSetTolerant({ openSet, observations })` | 自己的闭集必须穷尽（漏值/外溢 ⇒ 红）；外部开集不得穷尽——未知值须留痕、默认放行、可升级 |
| `R-6` | `assertIdempotentSideEffects({ operations, keyField? })` | 副作用按稳定键至多执行一次；后续必须缓存或显式"重复"；记录无稳定键 ⇒ `ok: null` |

`checkRunContract({...})` 一起跑，并把未提供输入的断言列进 `skipped`；**一条都没跑**时
`ok` 为 `null`（不可判定，不冒充通过）。用法与正反例见
[docs/RUN-CONTRACT.md](docs/RUN-CONTRACT.md)。

## 版本支持（宿主 / 会话格式）

**测试基线（本规则集验证过的版本）：**

| 项 | 基线 | 说明 |
|---|---|---|
| 宿主包 | `@deepseek-ai/dsh-session@0.2.0-rc.2` | 本规则集开发与 CI 测试所用版本 |
| 会话格式 | **v4**（`SESSION_FORMAT_VERSION = 4`） | v4 使用运行时词表 + 官方 `foldSurface` 终验 |
| 声明范围 | `^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1` | 可安装——声明范围**不等于**逐版本验证 |
| 已知格式 | 0 / 1 / 2 / 3 / 4 | 0–2 由本包自带**vendored** 词表 + 本地等价折叠（`legacyFoldSurface`）支持，与宿主版本无关 |

**未验证版本的行为（运行时检测并报告，绝不用旧规则静默硬判）：**

| 情形 | 行为 |
|---|---|
| 宿主**新于基线** | 明确**告警**；仍给结论，但标记"可能不适用" |
| 宿主旧于基线（仍在 peer 范围） | 提示 + 宿主能力检查判断文件格式能否评估（`SESSION_FORMAT_VERSION` 过低 ⇒ `not-assessable`，退出码 3） |
| **未知**会话格式（不在 0/1/2/3/4） | 报"未验证格式"并**只读**：`check` 只跑结构规则；`prewrite` / `fix` 拒绝（退出码 3） |
| 格式**无法识别**（无 `header.version`、无判别形状） | 同上："未验证格式" + 只读 |
| 文件版本高于宿主支持上限 | `not-assessable`（**不是** broken），退出码 3；列出跳过/已执行规则 |

实现：`lib/version-support.js`（`TESTED_BASELINE` / `detectSupport()`，公开 API 导出）；
`--json` 的 `support` 字段携带同一基线摘要与告警。

## CLI

安装后 `dsh-log-contract` 由包管理器放到 PATH（下面用 `pnpm exec`；不安装可用
`pnpm dlx dsh-log-contract …`）。

### 1. 离线体检

```bash
pnpm exec dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd
pnpm exec dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --json   # 机器可读
pnpm exec dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --resume # 三档结论
```

`check` 还包含 **W1/W2 wire 级检查**：按 surface 顺序展开模型请求流，抓"悬空 tool 消息"
（tool 结果没有前置 assistant tool_calls）与"user 文本插在 tool_calls 和结果之间"——
宽松端点容忍，严格端点直接 `INVALID_REQUEST`。

### 1.1 错误表达扫描（`error-contract`）

对**错误怎么被抛出**做静态扫描（源码文本，无 AST）。这是 **6 条错误表达家族**
（E1–E6）：一码多成因 · message 常量 · 终态词误用 · cause 未暴露 · 无条件成功（候选）·
声称但无执行点（候选）。

```bash
pnpm exec dsh-log-contract error-contract lib/ bin/ --json              # T1（我方代码）：命中 ⇒ 退出码 1
pnpm exec dsh-log-contract error-contract <pkg>/lib/index.js --target T2 # T2（第三方）：只登记，退出码 0
pnpm exec dsh-log-contract error-contract lib/ --keys thresholdRatio,headroom
pnpm exec dsh-log-contract error-contract lib/ --config cordis.patch.yml
```

⚠️ **输出是可疑清单，不是缺陷认定**：规则是启发式，必然有假阳性——每条都带原始
`evidence` 供人复核；白名单条目必须带 `expires` 日期（缺失/非法/过期 ⇒ 退出码 2，
fail-closed）。完整判据见 [docs/ERROR-CONTRACT.md](docs/ERROR-CONTRACT.md)。

### 2. 修复（`fix`）

```bash
# 干跑（只报告）：严格 seq 扫描 + 全量契约检查 + 可移除 marker 计数
pnpm exec dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers

# 落盘：先备份，再写（.zstd 按官方帧格式重建：帧1=header、后续=批次、带 checksum、单个结尾换行）
pnpm exec dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers --apply
```

- `--remove-markers`：移除 retrace / message-editor marker 并全量重编号（`seq` / `seq0` /
  `sourceEventSeqs` / `surfaceOp` 同步）——用于大范围 marker 遮蔽历史或 marker 漏盖 tool。
- `--neutralize`：原地中和 turn-null marker——type → `retrace/marker` + `ignorable: true`，
  删 `surfaceOp` / `sourceEventSeqs`，`seq` / 行数不变（会话驻留时也安全）。
- `--clip-crossstep`：裁剪跨 step 的 `sourceEventSeqs`——只保留同 turn/step 的 chunk 引用。
- 手术安全协议：先备份、改后复核（严格扫描 + check + `foldSurface`）；marker 只能遮蔽更早
  节点；marker 绝不能变成 append（M1 会让客户端引擎崩溃）。
- ⚠️ 若会话正被运行中的应用驻留，修复文件后**重启应用**（强杀，避免脏状态刷回）。

### 3. 写前校验（`prewrite`）

`edit-file` 是 JSON，两种形状：

```jsonc
// 向日志尾部追加一个事件（省略 seq = 自动赋 nextSeq）
{ "append": { "type": "assistant/message", "surfaceOp": { "op": "replace", "start": 121774, "end": 156421 }, "sourceEventSeqs": [121774, 121779], "data": { "turn": null, "step": null, "message": {}, "editor": { "targetSeq": 156430, "text": "…" } } } }

// 帧级手术：编辑后将存在的完整事件列表
{ "edit": [ "…完整事件列表…" ] }
```

```bash
pnpm exec dsh-log-contract prewrite marker-write.json --log ~/.dsh/sessions/<id>.jsonl.zstd
```

- 基线已有 error 级违规 ⇒ 直接拒绝（手术前基线必须绿）。
- `seq` 必须**省略**（自动赋 `nextSeq`）或恰等于 `nextSeq`——自造 `seq` 被拒（`E11`）；
  文件侧的"删行不重编号"和"自造 seq"表现为缺口，由 `E2` / `S9` 抓。
- 只有通过才允许落盘——**先校验、后提交**（与官方 `SurfaceManager.validateNext` 同一思路）。

### 4. 契约目录

```bash
pnpm exec dsh-log-contract contracts            # 57 条日志契约（含出处）
pnpm exec dsh-log-contract explain S9 --json   # 单条规则：标题、判据、对照指针
```

全量目录：[docs/CONTRACTS.md](docs/CONTRACTS.md)。

### 5. 会话考古（`extract` / `audit-report`）

每次工具调用的完整输入/输出都在会话日志里——是数据与审计资产。只读考古：

```bash
# 按命令正则导出工具输出（保留原始文本）
pnpm exec dsh-log-contract extract <session-log> --pattern "build-report" --min-size 50 --out ./found

# 考古审计：调用数 / 配对率 / 孤儿数 / 命令分布
pnpm exec dsh-log-contract audit-report <session-log>
```

契约规则 **P3**（tool/call ↔ tool/result 配对完整性）与 **P4**（输出结构可解析）保证
提取可用：孤儿调用与异常 `text` 字段会在 `check` 里报出。

## 事故表——为什么"生产级"不是口号

每条都是生产会话里**真实的日志损坏形状**——它们塑造了本工具。日期与形状为真实，会话 id
与文件名省略。

| # | 日期 | 发生了什么 | 产生的规则 / 修复 |
|---|---|---|---|
| 1 | 2026-08-25 | 一次"恢复隐藏内容"的修复写入 replace marker 时**清空了 `sourceEventSeqs`** → 会话拒绝加载（`SessionPersistenceCorruptionError`）；第二次改成 **append** → 客户端引擎崩溃。两次都是**没人拦住的违约写入**。 | **S5**（sourceEventSeqs 必须覆盖被遮蔽节点）、**M1**（turn-null assistant/message 只能 replace）、写前校验 |
| 2 | 2026-08-27~28 | 中断/重启的轮次用**旧内存光标**回放，把旧 seq 重新追加到文件尾（尾部回退、重复批次）；两个写入者交织 → **文件物理序非单调**（`734056 → 733539 → 735470`）。会话加载报 `seq gap`。 | **S9**（物理序单调）、`fix --tail-renumber` |
| 3 | 2026-08-27~28 | **fork 边界孤儿 splice**：fork 的"移除父待处理提示词"假设父会话 inbox，而子会话 seed 相对重放时 inbox 为空 → `resume failed: invalid persisted inbox splice`。 | **I1**（inbox seed 相对重放）、`fix --neutralize-orphan` |
| 4 | 2026-08-28 | 超大会话（**1,052,557 tokens**，超出 1M 窗口）既不能继续也不能 `/compact`；裁剪预算估算把 CJK 低估约 3.7×。 | **T1**（token-meter 配对）决定可压缩性、`fix --trim-budget` 指引 |
| 5 | 2026-08-29 | **W1/W2 wire 违规**：marker 遮蔽了带 tool_calls 的 assistant，却漏盖 tool 结果 → 严格端点（`INVALID_REQUEST`）拒绝请求流。 | **W1 / W2**（wire 消息流） |
| 6 | 2026-08-30 | 单个 **turn-null marker** 让 token-meter 监听器在**每次**追加事件时抛错（`consumedEvents` 不前进 → 每个事件重折全前缀）→ **30 秒 / 10,008 行日志**，宿主事件循环被压垮，所有会话卡死。同一会话还有**跨 step `sourceEventSeqs`**（step 7/8/9 混进同一条 assistant 消息）——离线检查全绿，实时计量崩溃。 | **T1**（turn/step 配对）、**T2**（跨 step 源引用）、`fix --neutralize`、`fix --clip-crossstep` |
| 7 | 2026-08-31 | 日志被压成**单个 zstd 帧**（或 header 未独占首帧）→ 不同读者对记录边界判断不一致。 | **Z4 / Z5**（首帧恰好一行 header；正文分帧） |
| 8 | 2026-08-31 | 日志**尾帧写入中被撕裂**，完全无法加载且没有诊断。 | **Z1** + 明确报告"尾帧撕裂/写入进行中" |
| 9 | 2026-09-09 | **会话格式 v4** 下 `tool/result` 使用 `role: 'tool'`、`system/message` 带 `system-prompt` source → 按 v3 形状检查对健康 v4 日志产生**数千条假错**。 | 按版本分派 + **E6 / E9** 的 v4 语义 |
| 10 | 2026-09-17 | **Windows** 上 `header.cwd` 用 POSIX-only 规则判 → **每一个**会话都被 **H2** 误报。 | 平台感知的绝对路径判定 |
| 11 | 2026-10-20 | **> 500 MB 会话**让读取器崩（`ERR_STRING_TOO_LONG`），修复也在内存里拼全量文本。 | 逐行解码 + 流式帧重建 |
| 12 | 2026-10-20 | 两段载体引用有的把审计段放首位，早期写法则从区间起点开头 → 读者报出数百个**假孤儿载体**。 | **P5** 写侧配对 + 读侧容错 |
| 13 | 2026-10-20 | 部分消费方把 `seedLength` 当**字节数**（它其实是继承事件条数），并把 `parentSession` + 缺失/0 当成损坏。 | **I2** 语义钉死 |
| 14 | 2026-10-20 | 一个**未知但显式可忽略**的事件类型让整条迁移卡死。 | **G4** 声明式跳过 + 白名单 |
| 15 | 2026-10-26 | **截断的 zstd 帧**让会话头读取器抛 `ERR_OUT_OF_RANGE`；没有逐项隔离，整轮枚举/汇总失败（33 天累计数百次失败）——一个坏文件拖垮整批。 | **R4**（读取容错：结构化、可计数）、**R5**（聚合逐项隔离 + 失败计数） |
| 16 | 2026-10-26 | 最后一帧写入中被切的文件仍报 `ok=true`——体检只认证它真正读到的事件。 | **Z6**（`tailStatus: complete/interrupted/truncated/unknown`）+ 文档化的尾部边界 |
| 17 | 2026-10-26 | 生产者在写侧**自造 `seq`**，以及**删行不重编号**。 | **E11**（`seq` 只能由日志层分配；写前拒绝自造 `seq`）、缺口痕迹由 `E2` / `S9` 兜住 |

> **结论**：这些规则不是凭空推演——每条都有回归用例复现它守护的坏形状。这就是这里的
> "生产级"。

## Node API（在脚本里嵌入写前校验）

```js
import { loadSessionLog, validateSessionLog, createPreWriter } from 'dsh-log-contract';

// ① 基线检查（手术前基线必须绿）
const log = loadSessionLog('session.jsonl.zstd');
const baseline = validateSessionLog(log);
if (!baseline.ok) throw new Error('baseline is broken; repair it first');

// ② 写前校验：准备写入一次 marker replace
const prewriter = createPreWriter({ events: log.events.map((e) => e.event) });
const verdict = prewriter.validateAppend({
  type: 'assistant/message',
  surfaceOp: { op: 'replace', start: 121774, end: 156421 },
  sourceEventSeqs: [121774, 121779], // 必须覆盖全部被遮蔽节点
  data: { turn: null, step: null, message: {} },
});
if (!verdict.ok) {
  for (const v of verdict.violations) console.error(v.id, v.message);
  process.exit(1); // 不落盘
}
// ③ 只有通过才写入
```

## 版本与兼容

三个独立维度：

| 维度 | 在哪里 | 当前 |
|---|---|---|
| 包版本 | npm / `package.json` | 见页面顶部徽章 |
| 会话格式版本 | 日志的 `header.version` | v0–v4 |
| 报告结构版本 | `check --json` 的 `schemaVersion` | **`"6"`** |

`schemaVersion` 历史（每一步都是只增；旧消费者忽略未知键）：

| 版本 | 新增 | 兼容读法 |
|---|---|---|
| `"1"` | 基础 `check` 报告 | 无该字段的旧报告按 `"1"` 读 |
| `"2"` | S9 诊断字段（`category` / `confidence` / `hint` / `basis` / `diagnosis`） | v1 消费者忽略新增字段 |
| `"3"` | `identity` 段（版本同一性） | v2 消费者忽略该段 |
| `"4"` | `runContract` 段（3 条） | v3 消费者忽略该段 |
| `"5"` | run-contract ＋R-2b / R-6（5 条） | v4 消费者忽略新增规则条目 |
| `"6"` | run-contract ＋R-2b-2 / R-5（7 条）；归档读端未就绪 ⇒ `unverifiable` | v5 消费者忽略新增规则条目 |

- 包版本、会话格式版本、报告结构版本**不可互换**；纯文档改动不改变规则与 `schemaVersion`。
- 版本对照：[VERSIONS.md](VERSIONS.md)；逐版说明：[CHANGELOG.md](CHANGELOG.md)。
- 宿主支持：测试基线 `@deepseek-ai/dsh-session` **0.2.0-rc.2**；声明范围
  `^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1`。文件格式新于宿主支持上限时
  报"不可评估"（退出码 3、只读），不会用旧规则硬判。

## 常见问题

**`ok: true` 就代表会话"能用"吗？** 只代表"本规则集看过的地方没坏"。它不承诺内容质量；
当文件需要格式迁移时，评估范围是 `partial`——迁移维度只部分覆盖
（`--json` → `assessmentScope` / `migration.coverage.uncovered`）。

**尾部被切掉了，为什么还是绿？** 因为体检只认证"读到的事件"。看 `summary.tailStatus`：
`interrupted`（尾帧撕裂，可恢复）与 `truncated`（记录缺失）是两件事。

**身份摘要（identity）是干什么的？** 防"同一个版本号、两份内容"——消费方静默跑旧构建的那类
故障。登记表在 `docs/identity-registry.json`；换版本或改运行时代码后用 `pnpm identity:register`
重登记（仅源码仓）。安装包里没有登记表 ⇒ `identity.ok` 为 `null`（不可判定，不冒充通过）。

**S9 的诊断是什么意思？** 除违规本身，S9 还带病因分类：`old-cursor-replay`（旧内存态回放）/
`concurrent-writer`（并发写者）/ `format-mix`（格式代混写），并在 `--json` 里给出置信度与
判定式（`category` / `confidence` / `hint` / `basis`）；判定本身不变。

**规则怎么验证？** 每条规则都有正/负对照用例；另有一套规则自检（注册表完整性、id 绑定、
逐规则覆盖、"报出的违规码都已注册"）。见下方[测试](#测试)。

## 测试

```bash
pnpm check && pnpm test   # 文档一致性检查 + 全量测试（正/负对照 + 规则自检）
```

- **仓内合成夹具**：合法会话 / seq 缺口 / 空 `sourceEventSeqs` / turn-null append /
  未知类型 / 坏 chunk 行 / 撕裂尾帧 / 未知 marker 前缀 / 自遮蔽。
- **负对照是硬要求**：每条规则都必须有"违规样本判红、合规样本判绿"的用例。
- **规则自检**：注册表完整性、`violation(id)` 绑定、逐规则覆盖（或显式登记的判定委托）、
  "每个报出的违规码都已注册"。

## 许可

MIT © OfferKuai Team
