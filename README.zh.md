# dsh-log-contract · 日志契约守护

> DSH（DeepSeek Harness）会话日志的**结构契约保险丝**：离线体检 + 写前校验。
> 原名 `log-contract-validator`（候选二号），按 Offer快 三件套规划定名 **`dsh-log-contract`**。

给 DSH 会话日志（`*.jsonl` / `*.jsonl.zstd`）装一条保险丝：人眼看不出、程序解析会崩的日志格式漂移，在它这里被拦下并告警。它不判断日志**内容**对不对，只守护日志**结构**是否破坏了下游消费者（Harness 读路径、客户端引擎、插件 marker 语义）的预期。

- **`check <session-log>`** —— 离线体检：官方解码器全量解码 + 契约逐条校验 + foldSurface 终验，产出违规报告。
- **`prewrite <edit-file> --log <session-log>`** —— ★ 写前校验：任何写入（追加 / 帧级手术）在落盘之前先过三层契约，违约即拦。
- **`contracts`** —— 列出内置契约规则目录（每条附官方源码出处）。

---

## 它在业务层里的位置

> **dsh-log-contract 是 [dsh-retrace](https://github.com/yamingmou/dsh-retrace) 的核心能力组件**（业务层的「医生」模块）：负责会话日志的**体检与修复**——让每一次撤回/编辑/回退都落在合法日志上，让 /compact 永不失效。

| 层 | 是什么 | 组件 |
|---|---|---|
| **Agent 业务层（生产级保证）** | 抽象核心能力：会话卫生 / 可回溯 / 可审计 / 可恢复，与平台无关 | 四模块：治理 / 看 / 考古 / **医生** |
| **dsh-retrace** | 业务层在 DeepSeek Harness 上的实现（生产级业务插件） | 撤回/编辑/版本/回退/看门狗 |
| **dsh-log-contract** | dsh-retrace 的核心能力组件 = 业务层的**医生**（体检/修复） | check / prewrite / fix / extract / audit |

**含义**：dsh-log-contract 独立发布（供单独使用或二次开发），但它首先是
dsh-retrace 的「日志体检与修复」能力——与 dsh-retrace 一起构成
**Agent 业务层（生产级保证）** 在 DSH 上的落地（详见 [dsh-retrace 路线图](https://github.com/yamingmou/dsh-retrace/blob/main/docs/ROADMAP.md)）。

---

## 为什么需要它

**#3632「one log, two consumers, two verdicts」**：一条日志同时被人类与自动化程序消费，人眼容忍格式微调，程序解析依赖严格契约；格式一旦漂移，人看不出问题，程序直接崩溃或误报。

**这里每一条规则都来自真实事故**——见下方 [⚡ 事故记录](#-事故记录)。每起事故都是一个回归夹具：损坏的会话本工具必须报出，修复后的会话必须通过。

---

## 三层契约（判定模型）

> 30+ 条规则，覆盖以下三层（`contracts` 列出全部，每条附官方源码出处）。

| 层 | 契约 | 本工具规则 |
|---|---|---|
| **持久化层** | seq 严格连续；type 在已知词汇表内；surface 事件携带合法 `surfaceOp`；replace 的 `sourceEventSeqs` 必须**完整覆盖被替换节点**；**文件物理序 seq 单调**（S9，多写入者交织现场）；官方 `foldSurface` 不抛 = 通过 | H/R/E/S（含 S5 核心）+ **S9** |
| **客户端引擎层** | `data.turn/step` 为 null 的 `assistant/message` 只能以 **replace** 承载（插件 marker 定义），append 会触发引擎崩溃；**token-meter 配对**（T1，assistant/message 必须有打开的 step）；**跨 step source 引用**（T2，sourceEventSeqs 引用的 chunk 必须同 turn/step）；**inbox seed 相对重放**（I1，fork 边界孤儿） | M1 + **T1 / T2 / I1** |
| **wire 消息流** | tool 消息必须跟在带 tool-call 的 assistant 之后（悬空 tool 会被严格端点拒绝）；user 文本不得插在 tool_calls 与结果之间 | **W1 / W2** |
| **插件语义层** | marker id 前缀必须可识别（改名登记遗留前缀）；marker 自身 seq 不得进入自身 shadowed 集 | P1/P2 |

> 校验哲学：先用与官方同语义的增量重放做**逐事件归因**（定位到 seq/行号），再跑官方 `foldSurface` 做**终验**（不抛才算过）——两套都绿才过。

---

## ⚡ 事故记录 ——「生产级保证」不是口号

下面的每一条规则都来自我们工作区的一起**真实事故**。日期与形态真实，会话 id 为隐私省略。

| # | 日期 | 发生了什么 | 产出的规则/修复 |
|---|---|---|---|
| 1 | 2026-08-25 | 一次「恢复被隐藏内容」的修复写了**清空 `sourceEventSeqs`** 的 replace marker → 会话加载被拒（`SessionPersistenceCorruptionError`）；第二次尝试把 marker 改成 **append** → 客户端引擎崩溃。两次都是**违约写入没被拦**。 | **S5**（sourceEventSeqs 必须覆盖被替换节点）、**M1**（turn-null 的 assistant/message 只能 replace）、写前校验 |
| 2 | 2026-08-27~28 | 中断/暂停的轮次恢复时按**过期内存光标**重放，把旧 seq 追加到文件尾（尾部回归、重复批次）；两个写入者交织 → **文件物理序非单调**（`734056 → 733539 → 735470`）。会话 `seq gap` 加载失败。 | **S9**（物理序单调）、fix `--tail-renumber` |
| 3 | 2026-08-27~28 | **fork 边界孤儿 spliced**：fork 的「移除父待处理提示词」splice 假设父会话 inbox；子会话 seed 相对重放里 inbox 为空 → `resume failed: invalid persisted inbox splice`。 | **I1**（inbox seed 相对重放）、fix `--neutralize-orphan` |
| 4 | 2026-08-28 | 超限会话（**1,052,557 tokens** vs 1M 窗口）既无法继续也无法 `/compact`；裁剪预算估算对中文低估 ~3.7×。 | T1（token-meter 配对，保障可压缩）、`fix --trim` 预算指引 |
| 5 | 2026-08-29 | **W1/W2 wire 违规**：marker 遮蔽了带 tool_calls 的 assistant 但漏盖 tool 结果 → 悬空 tool，严格端点 `INVALID_REQUEST` 拒绝请求流。 | **W1 / W2**（wire 消息流） |
| 6 | 2026-08-30 | 单个 **turn-null marker** 让 token-meter 监听器在**每条**追加事件上抛错（`consumedEvents` 不前进 → 每事件全前缀重折）→ **30 秒 / 10,008 行日志**、host 事件循环被压垮、全部会话锁定。同会话还有**跨 step sourceEventSeqs**（step 7/8/9 混进一条 assistant 消息）——离线 check 全绿、实机 meter 崩溃。 | **T1**（turn/step 配对）、**T2**（跨 step 源引用）、`fix --neutralize`、`fix --clip-crossstep` |

> **结论**：这个工具的每条规则都是一次真实会话留下的疤——用真实的损坏会话夹具验证过，不是合成理论。这就是这里「生产级」的含义。

---

## 安装

```bash
pnpm add -D dsh-log-contract   # 或 npm install
pnpm dlx dsh-log-contract --help
```

> **你是 dsh-retrace 用户？** 无需单独安装——`dsh-retrace` 已把 `dsh-log-contract`
> 声明为依赖，装 retrace 时自动带好契约守护（体检/写前校验/修复原语全部随插件生效）。
> 本包独立发布，供愿意单独使用或二次开发的用户直接引入。
>
> **从 GitHub 下载了 ZIP？** 解压后 `cd dsh-log-contract && npm install && npm run build`，
> 然后 `node bin/dsh-log-contract.mjs check <session-log>` 即可使用（无需全局安装）。

依赖：Node ≥ 22（`node:zlib` 内置 zstd）、`@deepseek-ai/dsh-session`（peer，校验/解码复用官方实现，保证与 Harness 读路径同源）。

---

## CLI 用法

### 1. 离线体检

```bash
dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd
dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --json   # 机器可读
```

输出示例：

```
📋 dsh-log-contract check —— backup-session-xxxx.jsonl.zstd
   事件 204754 ｜ surface 节点 16 ｜ replace 代数 5 ｜ 帧 8620（3439.5KiB → 8191.3KiB）
   违规 1（error 1 / warning 0）

  [error] S5 @ seq 156425 / line 778 (assistant/message)
      surface replace: sourceEventSeqs 必须覆盖每个被替换节点；缺失 121774, 121779（共 2 个）

❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）
```

退出码：0 = 通过（无 error 级违规）；1 = 存在 error 级违规。

`check` 自 0.2.0 起新增 **W1/W2 wire 级检查**：按 surface 顺序展开模型请求消息流，
捕获"悬空 tool 消息"（tool 结果没有前置 assistant tool_calls）与"user 文本插在
tool_calls 与其结果之间"——这类问题 DeepSeek 曾容忍，但 MiMo 等严格端点会直接
`INVALID_REQUEST`（2026-08-27 实锤）。

### 2. 修复（`fix`）

```bash
# 干跑（只报告）：严格 seq 连续扫描 + 全契约体检（含 W1/W2）+ 可移除 marker 数
dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers

# 应用：备份后落盘（.zstd 走官方帧格式重建：帧1=header、帧2=其余、checksum、单个结尾换行）
dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers --apply
```

- `--remove-markers`：移除 retrace/message-editor marker 并全量重编号
  （seq/seq0/sourceEventSeqs/surfaceOp 同步）——用于大范围 marker 遮蔽历史、
  marker 漏盖 tool/result 导致的悬空 tool。
- `--neutralize`：原地中和 turn-null marker（事故 #6）——type → `retrace/marker` +
  `ignorable:true`，删 surfaceOp/sourceEventSeqs，seq/行数不变（会话驻留也安全）。
- `--clip-crossstep`：裁剪跨 step sourceEventSeqs（事故 #6）——只保留同 turn/step 的 chunk 引用。
- 手术安全协议：改前备份、改后全量复检（strictScan + check + foldSurface）、
  marker 只能遮蔽其之前的节点、marker 绝不能改成 append（M1 客户端崩溃）。
- ⚠️ 若会话已被运行中的应用驻留内存，修复文件后需**重启应用**（强杀避免脏状态刷回）。

### 3. 写前校验（`prewrite`）

`edit-file` 为 JSON，两种形状：

```jsonc
// 拟追加一个事件到日志尾部（seq 缺省 = 自动按 nextSeq 赋值）
{ "append": { "type": "assistant/message", "surfaceOp": { "op": "replace", "start": 121774, "end": 156421 }, "sourceEventSeqs": [121774, 121779, "…"], "data": { "turn": null, "step": null, "message": { "…": "…" }, "editor": { "targetSeq": 156430, "text": "…" } } } }

// 帧级手术后的完整事件列表（改后确认，与改前基线双绿才允许落盘）
{ "edit": [ "…完整事件列表…" ] }
```

```bash
dsh-log-contract prewrite marker-write.json --log ~/.dsh/sessions/<id>.jsonl.zstd
```

- 基线本身有 error 级违规时直接拒绝校验（安全修复协议第 2 步：**改前基线必须绿**）。
- 判定通过才允许落盘——**validate first, commit later**（与官方 `SurfaceManager.validateNext` 同思路）。

### 4. 契约目录

```bash
dsh-log-contract contracts
```

完整契约清单见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

### 5. 会话考古（`extract` / `audit-report`）

DSH 会话日志持久化了每次工具调用的完整输入输出——数据资产与审计资产。
只读考古能力：

```sh
# 按命令正则导出工具输出（保留原始文本）
dsh-log-contract extract <session-log> --pattern "seed-scale" --min-size 50 --out ./found

# 考古审计报告：调用数 / 配对率 / 孤儿数 / 命令分布
dsh-log-contract audit-report <session-log>
```

契约规则 P3（tool/call↔tool/result 配对完整性）与 P4（输出结构可解析）
守护"挖得动"：孤儿调用、text 字段异常在 check 中告警。

---

## Node API（写前校验嵌入你的脚本）

```js
import { loadSessionLog, validateSessionLog, createPreWriter } from 'dsh-log-contract';

// ① 基线体检（改前基线必须绿）
const log = loadSessionLog('session.jsonl.zstd');
const baseline = validateSessionLog(log);
if (!baseline.ok) throw new Error('基线已坏，先修基线');

// ② 写前校验：拟写入一个 marker replace
const prewriter = createPreWriter({ events: log.events.map((e) => e.event) });
const verdict = prewriter.validateAppend({
  type: 'assistant/message',
  surfaceOp: { op: 'replace', start: 121774, end: 156421 },
  sourceEventSeqs: [121774, 121779 /* …必须完整覆盖被替换节点… */],
  data: { turn: null, step: null, message: { /* … */ } },
});
if (!verdict.ok) {
  for (const v of verdict.violations) console.error(v.id, v.message);
  process.exit(1); // 不落盘
}
// ③ 通过后才写
```

---

## 测试

```bash
pnpm check && pnpm test    # 语法检查 + 79 个单测（含事故回归用例）
```

- **合成夹具**（入库）：合法会话 / seq 缺口 / 空 sourceEventSeqs / turn=null append / 未知 type / 坏 chunk 行 / 撕裂尾帧 / 未知 marker 前缀 / 自指 shadowed 等。
- **真实化石**（不入库，含用户隐私）：本地跑

```bash
node scripts/check-local-fossils.mjs   # 扫描 ../ 下 backup-session-*.jsonl.zstd
```

已知真值表：事故修复后会话 PASS；`seqgap`/`corrupt`/`rewritten-230542` FAIL；`spliced-orphan` PASS（持久化层合法——#3632 的"消费路径判不可读"属于另一类契约，本工具只守护持久化契约层，见 [docs/CONTRACTS.md](docs/CONTRACTS.md) 边界说明）。

---

## Roadmap

- [x] **Phase 1（0.1.0）**：CLI 离线体检 + 写前校验 + 契约目录
- [x] **Phase 1.5（0.2.0）**：`fix` 子命令（严格 seq 扫描 + W1/W2 wire 检查 + 移除 marker 重编号 + 官方帧格式重建）；CI 集成（`dsh-log-contract check` 作为 Harness 会话目录的定时守护）
- [x] **0.3.x（2026-08-30 事故固化）**：T1 token-meter 配对 → 0.3.1 W1/W2 折叠位置修复 → 0.3.2 `tailSeq` → 0.3.3 `fix --neutralize`（turn-null marker 原地中和）→ 0.3.4 `fix --clip-crossstep`（跨 step 引用裁剪）→ 0.3.5 **T2/S9/I1 规则**（跨 step 源引用 / 物理序单调 / inbox 重放）
- [ ] Phase 2：运行时守护（订阅 session append 事件流实时校验，断裂即标记 `dsh/contract-violation` 事件，策略可配 告警/拦截）——DSH 插件形态
- [ ] Phase 3：与 dsh-turn-guard / dsh-retrace 时间线联动

## 许可

MIT © OfferKuai Team

---

[English](./README.md) · **简体中文**
