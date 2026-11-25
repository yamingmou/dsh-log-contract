# 接口版本：`--json` 报告结构版本 `schemaVersion`

> 适用面：`dsh-log-contract check --json` 的机器可读报告，以及库入口
> `validateSessionLog()` 的返回对象。本文只讲**报告结构**的版本纪律；
> 工具版本（package version）与会话日志格式版本（v0–v4）是另外两个维度，互不替代。

## 字段位置与当前值

| 项 | 值 |
|---|---|
| 字段名 | `schemaVersion` |
| 位置 | `check --json` 报告**顶层**；同值同步进 `validateSessionLog()` 返回对象顶层 |
| 当前值 | `"6"`（字符串，暂不采用 semver；见下文 v2 / v3 / v4 / v5 / v6） |
| 覆盖范围 | 仅 `check --json` 这一份报告结构。`prewrite --json` 是**另一份结构**，暂不带本字段（当前 CLI 亦无 `plan` 子命令） |

`schemaVersion` 标记的是**报告结构**（字段集合 / 字段类型 / 字段含义）的版本：
不是工具版本，也不是被检日志的格式版本。

## 向后兼容承诺

- **旧消费者读新报告**：同一 `schemaVersion` 下，既有顶层键**不删、不改名、不改义**；
  报告**只增新键**。旧消费者遇到未知键必须忽略（跳过），不得报错、不得崩溃。
- **新消费者读旧报告**：缺字段按「未知 / 默认」处理，不视为错误。
  **没有 `schemaVersion` 字段的旧报告一律视为 `"1"`** —— 本字段是首个版本标记，
  在它出现之前的报告结构就是 v1。
- 枚举类字段新增取值属于兼容变更；消费者对未知取值应降级归入 unknown，不得崩溃。

### 已新增的可选键（`schemaVersion: "1"` 期间）

| 键 | 引入 | 形状 | 说明 |
|---|---|---|---|
| `errorContract` | 0.3.x | `{ family: "error-expression", rules: [{id,severity,title,layer,target,falsePositiveRisk}], note }` | 错误表达契约（E1–E6）的**规则目录**；源码扫描结果不在此键内（用 `error-contract` 子命令的独立报告）。旧消费者忽略此键即可。 |

---

## v2 · S9 诊断字段（兼容递增）

`schemaVersion` 由 `"1"` → `"2"`。**这次升版是按"新增枚举/诊断结构要能被消费者识别"显式登记**，
结构上仍是**只增不改**：顶层键集合不变，仅 `violations[]` 里 S9 违规**新增可选字段**。

| 键 | 形状 | 说明 |
|---|---|---|
| `violations[].category` | `"old-cursor-replay" \| "concurrent-writer" \| "format-mix"` | 物理序非单调的**诊断分类**；仅 S9 违规携带 |
| `violations[].confidence` | `number`（0–1） | 分类置信度（启发式，非概率保证） |
| `violations[].hint` | `string` | 处置提示（含"建议 loaded=no 重载后再写"） |
| `violations[].basis` | `string` | 判定式（回卷步数/方向反转/内容重复/格式代/声明版本/连续回放步数） |
| `violations[].diagnosis` | `{ category, confidence, basis, hint }` | 与上述四键同值的对象（便于整体消费） |

兼容性：
- **v1 消费者读 v2 报告**：顶层键与 S9 的 `id/severity/seq/lineNo/message` 语义**未变**，
  新增字段按"未知键忽略"处理即可；S9 **判定不变**（仍为 error，仍只报首个物理序倒退）。
- **v2 消费者读 v1 报告**：S9 违规可能缺 `category/confidence/basis/diagnosis` ⇒ 视为
  "未分类诊断"，按原 S9 文案处理。
- 分类枚举后续只增（新取值按 unknown 降级）；新增取值**不**再单独升版。

## v3 · IDENTITY 段（版本同一性诊断 · 兼容递增）

`schemaVersion` 由 `"2"` → `"3"`。**只增顶层键**：新增 `identity` 段（判据 −1"跑的东西是不是你以为的那个"），
既有键与 `ok`/退出码**语义不变**（identity 是**独立诊断维度**，不进 `ok`）。

| 键 | 形状 | 说明 |
|---|---|---|
| `identity.family` | `"version-identity"` | 报告域（与 `error-expression` 并列，靠 family 分派） |
| `identity.rules` | `[{id,severity,title,layer}]` | IDENTITY 规则目录（ID1 一物一号 / ID2 号可验） |
| `identity.ok` | `true \| false \| null` | `null` = unverifiable（登记表缺失/不可读：npm 安装包不含该文件）——**不冒充通过** |
| `identity.version` | `string \| null` | `package.json` 声明版本（或调用方注入） |
| `identity.digest` | `sha256:…` | 由**产物**实算的运行身份摘要（`lib/**/*.js` + `bin/**/*.mjs` 逐文件 sha256 → 排序后再 sha256） |
| `identity.runtime.files` | `number` | 计入摘要的运行时代码文件数 |
| `identity.registry` | `{file, present, entries}` | 登记表位置与条目数 |
| `identity.findings[]` | `[{id,severity,title,file,line,message}]` | 判红项：`ID1`（同一版本两个摘要）/`ID2`（声明↔登记↔实算不一致、未登记、摘要伪造）；**带 file:line 证据** |
| `identity.summary.byRule` | `object` | 按规则计数 |

兼容性与边界：
- **v2 消费者读 v3 报告**：忽略未知键 `identity` 即可；`ok`/`violations`/退出码语义未变。
- **防噪音**：只改文档/测试/发布脚本（不改运行时代码）⇒ `identity.digest` 不变 ⇒ 绿；
  只改代码不动版本 ⇒ `ID2` 红（"同号改代码"必须换号并重新登记摘要）。
- 登记表 `docs/identity-registry.json` **不随 npm 包发布**（npm 只打包 `docs/**/*.md`） ⇒ 安装包内 `identity.ok = null`（unverifiable）。
- 换版本或改运行时代码后**重登记摘要**：`pnpm identity:register`（仅源码仓；npm 包不含 `scripts/` 目录）。登记旧摘要/伪造摘要 ⇒ `ID2` 红（发布前检查，不是可选项）。

## v4 · RUN CONTRACT 段（运行时契约 · 兼容递增）

`schemaVersion` 由 `"3"` → `"4"`。**只增顶层键**：新增 `runContract` 段（v4 时点为 3 条断言的规则目录），
既有键与 `ok`/退出码**语义不变**（真实判定由调用方把运行记录喂给断言函数）。

| 键 | 形状 | 说明 |
|---|---|---|
| `runContract.family` | `"run-contract"` | 报告域（与 `error-expression` / `version-identity` 并列，靠 family 分派） |
| `runContract.rules` | `[{id,severity,title,layer}]` | 规则目录（v4 = 3 条；v6 当前 = 7 条）：`R-1` 失败置位不清零 / `R-2a` 写失败不得标完整 / `R-2b` 撤回必须带消费方可读原因 / `R-2b-2` 初始化中不得按空值推"没有" / `R-3` 输入缺失⇒不兼容 / `R-5` 闭集穷尽·开集不穷尽 / `R-6` 副作用幂等（同键只执行一次） |
| `runContract.note` | `string` | 断言接口入口（`docs/RUN-CONTRACT.md`）；真实判定需调用方提供运行记录 |

兼容性：**v3 消费者读 v4 报告**忽略未知键 `runContract` 即可；`ok`/`violations`/退出码语义未变。
断言接口（`assertFailClosed` / `assertFailureLatched` / `assertWriteOutcome` / `checkRunContract`）
不改变任何既有报告字段，只是"可以调用"的诊断 API。

## v5 · R-2b / R-6 断言（兼容递增）

`schemaVersion` 由 `"4"` → `"5"`。**只增内容**：`runContract.rules` 从 3 条扩到 5 条，新增两个断言
接口；顶层键集合与 `ok`/退出码语义**不变**。

| 新增 | 形状 | 说明 |
|---|---|---|
| `R-2b` | `assertWithdrawalHasReason({ withdrawals, reasonField?, reasonSupported? })` | 撤回类响应必须带**消费方可读**的原因字段（非空字符串）；原因只在 `log`/`metadata`/`telemetry` 旁路 ⇒ 红；实现侧无该字段 ⇒ 传 `reasonSupported:false` ⇒ `ok:null`（unverifiable） |
| `R-6` | `assertIdempotentSideEffects({ operations, keyField? })` | 按**稳定幂等键**分组：同键副作用执行次数 ≤1，后续尝试必须缓存/显式"重复"；结果不可判定 ⇒ 红；记录无稳定键 ⇒ `ok:null`（缺前置） |

兼容性：v4 消费者读 v5 报告忽略新增规则条目即可；既有断言与报告字段语义未变。

## v6 · R-2b-2 / R-5 断言（兼容递增·当前）

`schemaVersion` 由 `"5"` → `"6"`。**只增内容**：`runContract.rules` 扩到 7 条，新增两个断言接口；
顶层键集合与 `ok`/退出码语义**不变**。

| 新增 | 形状 | 说明 |
|---|---|---|
| `R-2b-2` | `assertInitializedNotTreatedAsEmpty({ resources })` | 资源初始化中/取不到时不得按空值推"没有"（`initialized !== true` 却继续判断 ⇒ 红）；无初始化信号 ⇒ `ok:null`。归档读端同步降级：`archiveVerdict` 支持 `initialized`，读端不可读时结论 `unverifiable`（`notReady`），不并入内容缺失 |
| `R-5` | `assertClosedSetExhaustive({ closedSet, covered })` / `assertOpenSetTolerant({ openSet, observations })` | 自己的闭集必须穷尽（漏值/外溢 ⇒ 红）；外部开集不得穷尽——未知值须留痕 + 默认放行 + 可升级（否则红） |

兼容性：v5 消费者读 v6 报告忽略新增规则条目即可；既有断言与报告字段语义未变。

## 版本总表（v1 → v6）

| 版本 | 引入内容 | 当前消费者读法 |
|---|---|---|
| `"1"` | 基础 `check` 报告（无 `schemaVersion` 的旧报告按此读） | 基线 |
| `"2"` | S9 诊断字段（`category` / `confidence` / `hint` / `basis` / `diagnosis`） | v1 消费者忽略新增字段 |
| `"3"` | `identity` 段（version-identity：ID1 一物一号 / ID2 号可验） | v2 消费者忽略该段；`identity.ok: null` = 不可判定 |
| `"4"` | `runContract` 段（3 条断言：R-1 / R-2a / R-3） | v3 消费者忽略该段 |
| `"5"` | `runContract.rules` +R-2b / R-6（5 条） | v4 消费者忽略新增条目 |
| `"6"` | `runContract.rules` +R-2b-2 / R-5（7 条）；归档读端未就绪 ⇒ `unverifiable` | v5 消费者忽略新增条目 |

每个版本的既有键**不删、不改名、不改义**；新段/新家族可整段忽略，新增字段可在段内忽略。

## 何时升版

**不兼容才升**（版本号只增，如 `"5"` → `"6"`）：

| 变更 | 升版？ |
|---|---|
| 删除字段 | 升 |
| 改字段名 | 升 |
| 改字段类型 | 升 |
| 改字段含义（同名同型但语义变了） | 升 |
| 新增**报告段/家族**（如 `identity` / `runContract`） | 升（消费者需要识别新段的语义） |
| 同一段内新增**可选字段** | 不升 |
| 同一段内新增**枚举取值** | 不升 |
| 纯文档/文案修订（报告结构不变） | 不升 |

升版后消费者按 `schemaVersion` 分派：遇到不认识的版本号 ⇒ 只读自己认识的键、
显式降级（不硬失败）。同一版本内永远只增不改。

---

## 报告域（`family`）与版本独立性

`schemaVersion` 是**按报告域**计数，不是全局单号：

| 报告域 | 命令 | 版本字段 | 备注 |
|---|---|---|---|
| 日志契约（session log contract） | `check --json` | 顶层 `schemaVersion`（当前 `"6"`） | 本文正文主要讲这一域 |
| 运行时契约（run-contract） | 断言接口（`docs/RUN-CONTRACT.md`） | `family: "run-contract"`（`check --json` 的 `runContract` 段只给规则目录） | 与日志契约**互不影响**：断言不改 `ok`/退出码 |
| 错误表达契约（error-expression） | `error-contract --json` | 顶层 `schemaVersion`（当前 `"1"`）+ `family: "error-expression"` | 与日志契约**互不影响**：任一域升版不牵动另一域 |

- 两个域的 id 集合可能重名（都有 `E1`…），消费者**必须按 `family` 分派**，⛔ 不要按 id 字面合并。
- 「只增不改」承诺按域生效：某域新增键/取值 → 该域不升版；字段类型/含义变更 → 只升该域的版本。
- `check --json` 里的 `errorContract` 键只承载**规则目录**（无 findings）；`error-contract` 的完整
  报告（findings/`evidence`）在它自己的输出里。

---

本文与实现同口径；报告语义如有修订，随实现一并更新本文。
