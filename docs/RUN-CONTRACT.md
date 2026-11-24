# 运行时契约（RUN CONTRACT）· R-3 / R-1 / R-2a

> 报告域 `family: "run-contract"`：与日志契约（`check --json` 主报告）、错误表达契约
> （`error-expression`）、版本同一性契约（`version-identity`）并列，按 `family` 分派。
> 这三条规则只做**断言**（判定函数），不改 `check` 的 `ok` / 退出码语义。

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

## 前置项（未实现，列出边界）

| 候选 | 状态 | 前置项 |
|---|---|---|
| **R-2b 场景①** 撤回必须带原因 | **已落断言**（`assertWithdrawalHasReason`） | 记录里出现撤回类响应即可判；实现侧没有原因字段时标 unverifiable（`reasonSupported:false`） |
| **R-2b 场景②** 初始化中不得按空值继续 | 未实现 | 判据：`initialized !== true` 却按空值/不存在继续判断 ⇒ 红（不需新字段）；需在初始化窗口的判定点接入 |
| **R-6** 副作用必须幂等 | **已落接口级断言**（`assertIdempotentSideEffects`） | 天然键已有（tool call id / turn+step / 消息 id）；**仍缺**："重试复用同键 + 第二次返回缓存/重复"的声明（记录不带键 ⇒ unverifiable） |

`check --json` 的 `runContract` 段只承载**规则目录**（`rules` + `note`）；真实判定由调用方
把运行记录喂给上面的断言函数（与 `errorContract` 段同一口径）。
