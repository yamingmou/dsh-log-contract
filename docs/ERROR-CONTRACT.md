# 错误表达契约检查（E1–E6）

> ⚠️ **这是可疑清单，不是缺陷认定。** 规则是启发式的，必然有假阳性：
> 每条命中都带原始片段（`evidence`）供人工复核；白名单见下文。
> 检测器输出的是「值得看一眼的地方」，不是「某包违规」。

## 核心判据（一句话）

> **调用方必须靠匹配错误字符串才能分辨「该重试还是该放弃」—— 那就说明缺的是契约，不是文案。**

反过来说：凡是需要「读 message 才知道怎么办」的地方，都是这条契约被违反的地方。

## 规则

| # | 规则 | 判据（可直接写成检测逻辑） | 假阳性风险 |
|---|---|---|---|
| **E1** | 一个码多成因 | 按 error code 聚合 `new XxxError(msg, "CODE", …)`：同一 CODE 出现在 **≥2 个 throw site**，且（message 不同 **或** 上下文不同：一处 `catch` 内、一处在正常路径）⇒ 报 | 低 |
| **E2** | message 是常量 | 同一模板（插值只含**标识**：id/路径/序号）被 **≥2 个 throw site 共用**，且不含判据词 ⇒ 报（message 无法区分分支） | 低 |
| **E3** | 终态词用于非终态因 | code 名匹配 `NOT_[A-Z]+`／`UNAVAILABLE`／`FATAL`／`CORRUPT`，且该 throw 位于 `catch (e) { throw new X(…, CODE, { cause: e }) }` 形态内（把任意 error 收编成终态码）⇒ 报 | 中（需白名单） |
| **E4** | `cause` 未透出 | throw 带 `{ cause }` 但 message 不含 cause 的摘要（`error.code`／`error.name`／`error.message`）⇒ 报 | 中 |
| **E5** | 无条件成功 | `async` 函数所有正常返回都是 `true`／`void` 且无 `throw` ⇒ 只报**候选**（需看调用方如何消费返回值） | 低 |
| **E6** | 声称无执行点 | ① 配置声明的 key 在代码里**无读取点**；② README 的 `never`／`always`／`guaranteed`／`must not` 不变式句，在写入路径**无对应断言** ⇒ 只报**候选** | 高（只输出候选，需人工过） |

分层（决定能否直接进 CI）：

| 层 | 规则 | 说明 |
|---|---|---|
| L1 纯静态 | E1／E2／E3／E4／E5 | 单文件即可判定，可进 CI |
| L2 跨文件 | E6 | 要跨「声明（schema/YAML/README）↔ 执行（代码）」两处比对，半自动 |

## 范围：T1 / T2 必须分开

| target | 扫什么 | 用途 | 命中后 |
|---|---|---|---|
| **T1** | 我方代码 | 修 | `error/warning` 命中 ⇒ 退出码 1 |
| **T2** | 第三方/官方打包产物 | 只登记、报上游、做选题 | 默认退出码 0（`--strict` 才非 0） |

两类**不得混在同一份报告**里：T1 是自查，T2 是观察；混在一起会让「我们自己的违规」
看起来像「别人的违规」。

## 用法

```bash
# T1：扫我方源码（文件或目录；目录递归 *.js/*.mjs/*.cjs，*.md 仅做 E6 候选句扫描）
dsh-log-contract error-contract lib/ bin/ --json

# T2：只登记官方产物（默认 exit 0）
dsh-log-contract error-contract node_modules/@deepseek-ai/dsh-session/lib/index.js --target T2 --json

# 带白名单（逐条、带到期日）
dsh-log-contract error-contract lib/ --whitelist whitelist.json

# 扫仓库根时排除测试与未接线骨架（默认已跳过 node_modules/.git/reports）
dsh-log-contract error-contract . --exclude test,contract

# E6①：配置声明 key 的读取点（--keys 直接给；--config 从 YAML 的 config: 段派生）
dsh-log-contract error-contract lib/ --keys thresholdRatio,headroom --json
dsh-log-contract error-contract lib/ --config cordis.patch.yml --json
```

`--json` 输出稳定键集：`schemaVersion` / `family` / `target` / `rules` / `findings` / `summary`；
每条 finding 带 `id` / `rule` / `severity` / `file` / `line` / `message` / `evidence`。
外层 `schemaVersion` 遵循 `docs/interface-versioning.md`（只增不改）。

退出码：

| 码 | 含义 |
|---|---|
| 0 | 无可疑点（或 T2 只登记） |
| 1 | T1 命中 error/warning |
| 2 | 无法判定（白名单不合规/读不了路径等）—— fail-closed |

## 白名单（逐条例外，到期复审）

```json
{ "entries": [
  { "rule": "E3", "file": "lib/foo.js", "line": 12,
    "reason": "该处 transition 有专门测试覆盖，判定为设计意图", "expires": "2026-12-31" }
] }
```

- `rule` 必须是 E1–E6；`file` 必填；`line` 可选（精确到行）。
- **`expires` 必填**（`YYYY-MM-DD`）：缺失、非法或已过期 ⇒ 退出码 2（fail-closed），
  ⛔ 不得静默放行。与仓库内其他登记制例外同口径。

## 与日志契约规则的关系

本工具的日志契约规则集里也有 `E1`–`E11`（seq/词汇表等，见 `CONTRACTS.md`）。
两者是**不同家族**：错误表达规则带 `family: "error-expression"` 字段，报告里独立成块
（`check --json` 的 `errorContract` 只给规则目录；源码扫描结果在 `error-contract` 子命令）。
消费者按 `family` 区分，⛔ 不要按 id 字面合并。

## 已知边界

- 只扫**源码文本**（不做完整 AST/类型分析）：动态构造的 code/message、跨文件聚合、
  包装函数不在覆盖内。
- E2 的「同一模板」判定 = 模板文本（插值**归一为 `$`**）：同一句只换插值变量名
  （`thing ${z} failed` vs `thing ${w} failed`）仍算同一模板 ⇒ **计 E2**（贴 spec 语义）。
  但插值末段是判据/摘要字段（`code`／`name`／`message`／`reason`／`status`）时视为携带判据
  ⇒ **不算常量**（不报 E2）。变量名 vs 判据字段的边界是启发式的，见本条即边界。
- E5 只看函数体，**不看调用方**：幂等操作返回 `true` 本身不是错。
- E6 默认只输出候选：不变式句与校验点的对应关系需要人判。
- 「名字是否准确」（码名与 throw 条件是否相符）机器判不了 ⇒ 只能输出可疑清单给人过。

## 仓库布局与发布面（纳入/排除）

| 路径 | 内容 | 是否随 npm 包发布 |
|---|---|---|
| `lib/error-contract.js` | 本检查器的运行时（规则 + 检测器 + 报告） | ✅ 是（`files` 白名单含 `lib/**`） |
| `bin/dsh-log-contract.mjs` | CLI（`error-contract` 子命令） | ✅ 是 |
| `docs/ERROR-CONTRACT.md` | 本文 | ✅ 是（白名单含 `docs/**`） |
| `test/error-contract*.test.mjs` | 单元测试 / CLI 测试 | ❌ 否（不发布；`vitest run` 收集） |
| `contract/` | 抽象契约 Phase1 骨架（未接线，供后续迁移） | ❌ 否（白名单不含 `contract/`） |

扫描口径：`error-contract <path>` 会**递归扫入**传入目录下所有 `*.js/*.mjs/*.cjs` 与 `*.md`
（含未跟踪文件）。因此扫仓库根时会连 `test/`、`contract/` 一起扫到；要只看发布面请显式
传 `lib/ bin/` 或用 `--exclude test,contract`（默认已跳过 `node_modules/`、`.git/`、`reports/`）。

判据：npm `files` 白名单 = `lib/**`、`bin/**`、`docs/**`、README、LICENSE；
白名单之外的目录不随包发布，也不构成运行时契约的一部分。
