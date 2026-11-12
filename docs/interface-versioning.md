# 接口版本：`--json` 报告结构版本 `schemaVersion`

> 适用面：`dsh-log-contract check --json` 的机器可读报告，以及库入口
> `validateSessionLog()` 的返回对象。本文只讲**报告结构**的版本纪律；
> 工具版本（package version）与会话日志格式版本（v0–v4）是另外两个维度，互不替代。

## 字段位置与当前值

| 项 | 值 |
|---|---|
| 字段名 | `schemaVersion` |
| 位置 | `check --json` 报告**顶层**；同值同步进 `validateSessionLog()` 返回对象顶层 |
| 当前值 | `"1"`（字符串，暂不采用 semver） |
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

### 已新增的可选键（同 `schemaVersion: "1"`）

| 键 | 引入 | 形状 | 说明 |
|---|---|---|---|
| `errorContract` | 0.3.x | `{ family: "error-expression", rules: [{id,severity,title,layer,target,falsePositiveRisk}], note }` | 错误表达契约（E1–E6）的**规则目录**；源码扫描结果不在此键内（用 `error-contract` 子命令的独立报告）。旧消费者忽略此键即可。 |

## 何时升版

**不兼容才升**（`"1"` → `"2"`）：

| 变更 | 升版？ |
|---|---|
| 删除字段 | 升 |
| 改字段名 | 升 |
| 改字段类型 | 升 |
| 改字段含义（同名同型但语义变了） | 升 |
| 新增可选字段 | 不升 |
| 新增枚举取值 | 不升 |

升版后消费者按 `schemaVersion` 分派：遇到不认识的版本号 ⇒ 只读自己认识的键、
显式降级（不硬失败）。同一版本内永远只增不改。

---

## 报告域（`family`）与版本独立性

`schemaVersion` 是**按报告域**计数，不是全局单号：

| 报告域 | 命令 | 版本字段 | 备注 |
|---|---|---|---|
| 日志契约（session log contract） | `check --json` | 顶层 `schemaVersion`（当前 `"1"`） | 本文正文主要讲这一域 |
| 错误表达契约（error-expression） | `error-contract --json` | 顶层 `schemaVersion`（当前 `"1"`）+ `family: "error-expression"` | 与日志契约**互不影响**：任一域升版不牵动另一域 |

- 两个域的 id 集合可能重名（都有 `E1`…），消费者**必须按 `family` 分派**，⛔ 不要按 id 字面合并。
- 「只增不改」承诺按域生效：某域新增键/取值 → 该域不升版；字段类型/含义变更 → 只升该域的版本。
- `check --json` 里的 `errorContract` 键只承载**规则目录**（无 findings）；`error-contract` 的完整
  报告（findings/`evidence`）在它自己的输出里。

---

本文与实现同口径；报告语义如有修订，随实现一并更新本文。
