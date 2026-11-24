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
| **R-2b** 撤回必须带原因 | 未实现 | 撤回事件需要**必填 `reason`** 字段（现结构只有 `originalText`，没有原因语义）⇒ 先补字段契约，再加断言 |
| **R-6** 副作用必须幂等 | 未实现 | 需要先立"副作用携带稳定**幂等键**"契约（当前没有该概念）；无幂等键时判定只能是"缺前置" |

`check --json` 的 `runContract` 段只承载**规则目录**（`rules` + `note`）；真实判定由调用方
把运行记录喂给上面的断言函数（与 `errorContract` 段同一口径）。
