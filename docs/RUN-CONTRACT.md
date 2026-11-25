# 运行时契约（RUN CONTRACT）· 7 条

> 规则索引（id / 一句话）：`R-1` 失败置位不清零 · `R-2a` 写失败不得标完整 ·
> `R-2b` 撤回必须带消费方可读原因 · `R-2b-2` 初始化中不得按空值推"没有" ·
> `R-3` 输入缺失 ⇒ 不兼容 · `R-5` 闭集穷尽 / 开集不穷尽 · `R-6` 同键副作用幂等。
> 总数 **7**（id 不是连续 1…7；以本表为准）。

> 报告域 `family: "run-contract"`：与日志契约（`check --json` 主报告）、错误表达契约
> （`error-expression`）、版本同一性契约（`version-identity`）并列，按 `family` 分派。
> 本组规则只做**断言**（判定函数），不改 `check` 的 `ok` / 退出码语义。

一句话：日志契约问"这份日志合法吗"，版本同一性问"跑的是不是你以为的那份"，
运行时契约问"**跑起来会不会静默变样**"。

## R-3 · 任一输入缺失 ⇒ 判不兼容（fail-closed）

**判据**：必需输入（字段 / 文件 / 必需上下文）缺失时，判定必须是**不兼容**（拒绝），
且拒绝原因**可见**（点出缺了哪一项）。原因可见性按**完整 token** 判定（按非字母数字切词后
相等），⛔ 不是子串包含：`required:['file']` + `reasons:['profile missing']` **不算**点名。
缺失永不匹配：声明值、解析值、期望值三者必须完全相等才算匹配；任一缺失 ⇒ 不匹配。

```js
import { assertFailClosed } from 'dsh-log-contract';

// ✅ 合规：缺 fileB ⇒ 拒绝，且原因点名 fileB
assertFailClosed({
  required: ['fieldA', 'fileB'],
  provided: { fieldA: 1 },
  result: { compatible: false, reasons: ['fileB missing'] },
}).ok === true;

// ⛔ 违规：缺 fileB 却判兼容（fail-open）
assertFailClosed({ required: ['fieldA', 'fileB'], provided: { fieldA: 1 }, result: { compatible: true } });
// ⇒ findings[0].id === 'R-3'

// ⛔ 违规：拒绝原因不可见（reasons 未点名缺项）
assertFailClosed({ required: ['fileB'], provided: {}, result: { compatible: false, reasons: ['bad input'] } });
```

`isMissingInput(v)` 的口径：缺键 / `undefined` / `null` / 空白字符串 / `NaN` 都算缺失。

## R-1 · 失败一次即置位，恢复不清零

**判据**：状态历史一旦出现 `failed: true`，其后任何快照都不得再出现 `failed: false`——
恢复、重载、清缓存同样禁止清零；状态只能「未失败 → 失败」单向。缺省（未声明）视为
未清零，只有**显式** `false` 才算违规。

```js
import { assertFailureLatched } from 'dsh-log-contract';

// ✅ 合规：失败后恢复，但置位保持 true
assertFailureLatched([
  { phase: 'run', failed: false },
  { phase: 'run', failed: true },
  { phase: 'recover', failed: true },
  { phase: 'reload', failed: true },
]).ok === true;

// ⛔ 违规：恢复路径把置位清零
assertFailureLatched([
  { phase: 'run', failed: true },
  { phase: 'reload', failed: false },
]);
// ⇒ findings[0].id === 'R-1'（带 index/phase 证据）
```

## R-2a · 写失败不得把产物标为完整

**判据**：写入未成功（`write.ok !== true`，含 `ok` 缺省/结果未知）时，产物不得被标记为
完整（`artifact.complete === true` 或 `artifact.status === "complete"`）；必须撤回或标
`partial` / `unavailable` / `withdrawn`。接口断言，不绑定具体写入实现。

```js
import { assertWriteOutcome } from 'dsh-log-contract';

// ✅ 合规：写成功 ⇒ 产物可标完整
assertWriteOutcome({ write: { ok: true }, artifact: { complete: true } }).ok === true;

// ✅ 合规：写失败 ⇒ 产物标 partial/unavailable
assertWriteOutcome({ write: { ok: false, error: 'EIO' }, artifact: { complete: false, status: 'partial' } }).ok === true;

// ⛔ 违规：写失败却把产物标完整
assertWriteOutcome({ write: { ok: false, error: 'EIO' }, artifact: { complete: true } });
// ⇒ findings[0].id === 'R-2a'
```

## R-2b · 撤回必须带消费方可读的原因（场景①）

**判据**：撤回类响应（`kind/type` 含 withdraw、或 `withdrawn === true`、或 `status === "withdrawn"`）
必须携带**消费方可读**的原因字段（默认 `reason`，非空字符串）。原因只出现在 `log`、`metadata`、
`telemetry` 等**旁路** ⇒ 仍判红——消费方读不到日志里的原因，不等于撤回有原因。
实现侧**没有**原因字段概念时，传 `reasonSupported: false` ⇒ `ok: null`（unverifiable，⛔ 不冒充通过）。

```js
import { assertWithdrawalHasReason } from 'dsh-log-contract';

// ✅ 合规：原因在响应本身
assertWithdrawalHasReason({ withdrawals: [{ kind: 'withdrawal', target: 'x', reason: 'user asked' }] }).ok === true;

// ⛔ 违规：没有 reason（原因只在日志旁路）
assertWithdrawalHasReason({ withdrawals: [{ withdrawn: true, target: 'x', log: 'revoked by policy' }] });
// ⇒ findings[0].id === 'R-2b'（sideChannels: ['log']）

// ⚪ 不可判定：实现侧没有该字段
assertWithdrawalHasReason({ withdrawals: [{ withdrawn: true }], reasonSupported: false }).ok === null;
```

> 场景②（"初始化中"被当成空值继续判断）属另一条判据（`initialized !== true` 却继续），本包暂未实现。

## R-2b-2 · 初始化中/取不到 不得按空值推"没有"

**判据**：资源（归档索引 / 读端 / 父链等）处于**初始化中或取不到**时，`initialized !== true`
却按空值继续判断（把"还没准备好"当成"不存在 / 无父 / 无归档"）⇒ 红。
无初始化信号 ⇒ `ok: null`（unverifiable，⛔ 不冒充通过）。

```js
import { assertInitializedNotTreatedAsEmpty } from 'dsh-log-contract';

// ✅ 合规：已就绪后才判断
assertInitializedNotTreatedAsEmpty({ resources: [{ name: 'archive-index', initialized: true, judgedFromEmpty: true }] }).ok === true;

// ⛔ 违规：父链还没加载就按"无父"继续
assertInitializedNotTreatedAsEmpty({ resources: [{ name: 'parent-chain', initialized: false, judgedFromEmpty: true }] });
// ⇒ findings[0].id === 'R-2b-2'

// ⚪ 无初始化信号 ⇒ unverifiable
assertInitializedNotTreatedAsEmpty({ resources: [{ name: 'x', judgedFromEmpty: true }] }).ok === null;
```

读端落地（本仓）：
- `archiveVerdict(events, { archiveRoots, readLines, initialized })`——`initialized === false` ⇒
  显式 `not-initialized` 降级（`verdict: 'unverifiable'`、`notInitialized: true`，不冒充、不报缺失）；
- 归档读端（`readArchiveIndex` / `readArchiveLines` 经 `verifyArchivePointers`）**暂不可读**时计入
  `unavailable` / `notReady`，结论 `unverifiable`，**不再**并入"内容缺失"（`missing`/`lineMissing` 保持 0）；
  内容级失败（行缺失等）仍判 `unrestorable`。
- 可忽略白名单解析（`resolveIgnorableWhitelist`）：外部白名单缺失时保持**内置默认集**（安全侧），
  未知事件仍会以 warning 报出——不会把"白名单没加载"静默当成"全部不忽略"。
- 父链：本仓**没有**谱系读取实现（父链读取在外部实现），故本仓只提供断言接口与判据，不硬做父链逻辑。

### 读失败的口径（P3）：读失败 = 不可判定（unverifiable）

读失败**不等于**"内容缺失"：读端抛错、索引未就绪时，结论落到 `unverifiable`
（`notReady` / `unavailable`），`missing` / `lineMissing` 保持 0——不冒充"归档缺失"，
也不冒充"已还原"。

**下一版将区分两种读失败**（本版先统一按 `unverifiable` 处理，尚未实现）：

| 情形 | 下一版判定口径 |
|---|---|
| **未就绪**（短窗口 / 首次失败、可重试） | 保持 `unverifiable`，允许重试；不产生内容级判据 |
| **持久损坏**（同一目标连续 N 次读取失败，默认 N=2） | 升级为内容级判据（error），明确报"持久不可读" |
| `ENOENT`（目标不存在） | 与"暂不可读"分开归类（缺失 ≠ 未就绪） |
| **解析失败**（文件在、内容不可解析） | 直接判内容级失败（不属于"未就绪"） |

## R-5 · 闭集须穷尽；开集不得穷尽

**判据**：**枚举封闭 ≠ 契约封闭**，两个方向都会出事。

| 集类型 | 例子 | 断言 | 违规 |
|---|---|---|---|
| **闭集**（自己定义） | 已知事件类型表、规则 id/severity 集 | `assertClosedSetExhaustive({ closedSet, covered })` | 声明里有但没处理（漏值）；处理分支出现声明外的值（外溢） |
| **开集**（外部会新增） | 上游事件 `type`、错误码、模型 provider | `assertOpenSetTolerant({ openSet, observations })` | 未知值被拒绝；未知值没留痕；未知值不可升级 |

```js
import { assertClosedSetExhaustive, assertOpenSetTolerant } from 'dsh-log-contract';

// ✅ 闭集穷尽
assertClosedSetExhaustive({ closedSet: ['a', 'b'], covered: ['a', 'b'] }).ok === true;
// ⛔ 闭集漏值 / 外溢
assertClosedSetExhaustive({ closedSet: ['a', 'b'], covered: ['a'] }).missing; // ['b']
assertClosedSetExhaustive({ closedSet: ['a'], covered: ['a', 'c'] }).extra;   // ['c']

// ✅ 开集：未知值留痕 + 默认放行 + 可升级
assertOpenSetTolerant({ openSet: ['user/message'], observations: [{ value: 'future/event', decision: 'allow', traced: true, upgradeable: true }] }).ok === true;
// ⛔ 开集：未知被拒（外部集合不得穷尽）
assertOpenSetTolerant({ openSet: [], observations: [{ value: 'future/event', decision: 'reject', traced: true, upgradeable: true }] });
```

## R-6 · 副作用必须幂等（同键只执行一次）

**核查结论（先查再判）**：运行记录里**已有天然稳定键**——`tool/call` 的 `data.callId`
被持久化、且由 `tool/result` 的 `data.message.source.callId` 引用（本包 `P3` 配对即用它），
`turn+step`、消息 `id` 同样稳定。因此 R-6 可落为**接口级可机检**：调用方按稳定键把执行记录
喂进来，断言「同键副作用执行次数 ≤ 1；第二次必须返回缓存或显式"重复"」。
**仍缺的前置清单**：

| 缺什么 | 谁提供 | 最小补法 |
|---|---|---|
| 重试**复用同一幂等键**的声明 | 写入/调用路径（运行时） | 调用的重试沿用首次的键（tool call id 已持久化，直接复用即可） |
| 第二次执行**返回缓存或显式"重复"**的标记 | 副作用执行器（工具/写入实现） | 记录里写 `effect: "cached" \| "duplicate"`（或 `applied: false`），让"未重复执行"可判 |

记录不带键时无法判定 ⇒ `ok: null`（unverifiable，⛔ 不冒充通过）。

```js
import { assertIdempotentSideEffects } from 'dsh-log-contract';

// ✅ 合规：同键首次执行 + 第二次返回缓存
assertIdempotentSideEffects({ operations: [
  { key: 'call-1', effect: 'applied' },
  { key: 'call-1', effect: 'cached' },
] }).ok === true;

// ⛔ 违规：同键执行两次
assertIdempotentSideEffects({ operations: [
  { key: 'call-1', applied: true },
  { key: 'call-1', applied: true },
] });
// ⇒ findings[0].id === 'R-6'

// ⚪ 不可判定：记录里没有稳定键（缺前置）
assertIdempotentSideEffects({ operations: [{ effect: 'applied' }] }).ok === null;
```

## 一起跑

```js
import { checkRunContract } from 'dsh-log-contract';
const report = checkRunContract({ history, write, artifact, required, provided, result });
// { family: 'run-contract', rules, checks, skipped, ok, findings }
```

未提供输入的断言会列在 `skipped` 里；**一条断言都没跑**时 `ok: null`（unverifiable，⛔ 不冒充通过）。

| 情形 | 返回 | 读法 |
|---|---|---|
| 某条断言缺输入 | 该条 `ok: null` + `skipped: '<原因>'` | 不可判定（不是通过） |
| 全部断言都缺输入 | 汇总 `ok: null` | 不可判定（不是通过） |
| `check --json` 的 `runContract` 段 | 只有 `rules`（目录）+ `note` | 该段不承载判定结果 |
| 记录缺稳定键（R-6）/ 无初始化信号（R-2b-2）/ 实现无原因字段（R-2b） | 对应断言 `ok: null` | 补输入或补实现后再判 |

## 前置项（未实现，列出边界）

| 候选 | 状态 | 前置项 |
|---|---|---|
| **R-2b 场景①** 撤回必须带原因 | **已落断言**（`assertWithdrawalHasReason`） | 记录里出现撤回类响应即可判；实现侧没有原因字段时标 unverifiable（`reasonSupported:false`） |
| **R-2b 场景②** 初始化中不得按空值继续 | **已落断言 + 读端降级**（`assertInitializedNotTreatedAsEmpty`；`archiveVerdict` 显式 `initialized`） | 父链读取在外部实现：本仓只出断言/判据，不硬做父链逻辑 |
| **R-6** 副作用必须幂等 | **已落接口级断言**（`assertIdempotentSideEffects`） | 天然键已有（tool call id / turn+step / 消息 id）；**仍缺**："重试复用同键 + 第二次返回缓存/重复"的声明（记录不带键 ⇒ unverifiable） |
| **R-5** 闭/开集 | **已落断言**（`assertClosedSetExhaustive` / `assertOpenSetTolerant`） | 闭集清单：已知事件类型表、规则 id/severity；开集：上游 `type` 词表/错误码/provider |
| **dsh-6** 归档列表写入 | **不做写入断言** | 本仓归档模块**没有写调用**（`lib/archive.js` 内 0 处写）；写入方=外部 workspace archive op（协调项） |

`check --json` 的 `runContract` 段只承载**规则目录**（`rules` + `note`）；真实判定由调用方
把运行记录喂给上面的断言函数（与 `errorContract` 段同一口径）。
