# dsh-log-contract · 日志契约守护

> DSH（DeepSeek Harness）会话日志的**结构契约保险丝**：离线体检 + 写前校验。
> 原名 `log-contract-validator`（候选二号），按 Offer快 三件套规划定名 **`dsh-log-contract`**。

给 DSH 会话日志（`*.jsonl` / `*.jsonl.zstd`）装一条保险丝：人眼看不出、程序解析会崩的日志格式漂移，在它这里被拦下并告警。它不判断日志**内容**对不对，只守护日志**结构**是否破坏了下游消费者（Harness 读路径、客户端引擎、插件 marker 语义）的预期。

- **`check <session-log>`** —— 离线体检：官方解码器全量解码 + 契约逐条校验 + foldSurface 终验，产出违规报告。
- **`prewrite <edit-file> --log <session-log>`** —— ★ 写前校验：任何写入（追加 / 帧级手术）在落盘之前先过三层契约，违约即拦。
- **`contracts`** —— 列出内置契约规则目录（每条附官方源码出处）。

---

## 为什么需要它

**#3632「one log, two consumers, two verdicts」**：一条日志同时被人类与自动化程序消费，人眼容忍格式微调，程序解析依赖严格契约；格式一旦漂移，人看不出问题，程序直接崩溃或误报。

**2026-08-25 会话修复事故（真实回归用例）**：一次"恢复被隐藏内容"的修复，第 1 轮清空 marker 的 `sourceEventSeqs` 直接写盘 → 会话加载抛 `SessionPersistenceCorruptionError`；第 2 轮把 marker 改成 `append` → 客户端引擎崩溃。两次都是**违约写入没被拦**。如果有写前校验，会话根本不会被改坏。本工具把这次事故沉淀为两条核心规则（S5、M1）与回归测试。

---

## 三层契约（判定模型）

| 层 | 契约 | 本工具 |
|---|---|---|
| **持久化层** | seq 严格连续；type 在已知词汇表内；surface 事件携带合法 `surfaceOp`；replace 的 `sourceEventSeqs` 必须**完整覆盖被替换节点**；官方 `foldSurface` 不抛 = 通过 | 规则 H/R/E/S（含 S5 核心） |
| **客户端引擎层** | `data.turn/step` 为 null 的 `assistant/message` 只能以 **replace** 承载（插件 marker 定义），append 会触发引擎崩溃 | 规则 M1 |
| **插件语义层** | marker id 前缀必须可识别（改名登记遗留前缀）；marker 自身 seq 不得进入自身 shadowed 集 | 规则 P1/P2 |

> 校验哲学：先用与官方同语义的增量重放做**逐事件归因**（定位到 seq/行号），再跑官方 `foldSurface` 做**终验**（不抛才算过）——两套都绿才过。

---

## 安装

```bash
pnpm add -D dsh-log-contract   # 或 npm install
pnpm dlx dsh-log-contract --help
```

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

### 2. ★ 写前校验（本次事故的直接解药）

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

### 3. 契约目录

```bash
dsh-log-contract contracts
```

完整契约清单见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

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
pnpm check && pnpm test    # 语法检查 + 40 个单测（含事故回归用例）
```

- **合成夹具**（入库）：合法会话 / seq 缺口 / 空 sourceEventSeqs / turn=null append / 未知 type / 坏 chunk 行 / 撕裂尾帧 / 未知 marker 前缀 / 自指 shadowed 等。
- **真实化石**（不入库，含用户隐私）：本地跑

```bash
node scripts/check-local-fossils.mjs   # 扫描 ../ 下 backup-session-*.jsonl.zstd
```

已知真值表：事故修复后会话 PASS；`seqgap`/`corrupt`/`rewritten-230542` FAIL；`spliced-orphan` PASS（持久化层合法——#3632 的"消费路径判不可读"属于另一类契约，本工具只守护持久化契约层，见 [docs/CONTRACTS.md](docs/CONTRACTS.md) 边界说明）。

---

## 与三件套的关系

| 工具 | 象限 | 状态 |
|---|---|---|
| [workbuddy-session-fork](https://github.com/yamingmou/workbuddy-session-fork) | 会话分叉 · 状态管理 | ✅ 已发布 v1.2.0 |
| **dsh-log-contract**（本仓库） | 日志契约 · 接口稳定性 | 🆕 Phase 1 CLI 离线体检 + 写前校验 |
| dsh-turn-guard（规划中） | 中断回合 · 异常韧性 | 待立项 |

三者共享同一份 DSH 日志事件契约认知（59 条审计发现 = spec，aborted/corrupt/seqgap 化石 = 测试集）。dsh-retrace（回溯时间线）可把本工具的违规标记渲染到时间线上；本工具是 retrace 投影源健康度的**前置保险**。

---

## Roadmap

- [x] **Phase 1（本版 0.1.0）**：CLI 离线体检 + 写前校验 + 契约目录
- [ ] Phase 1.5：违规报告的 `--fix` 建议（seq 缺口修复复用 `fix-seq-gap.mjs` 方法论）、CI 集成（`dsh-log-contract check` 作为 Harness 会话目录的定时守护）
- [ ] Phase 2：运行时守护（订阅 session append 事件流实时校验，断裂即标记 `dsh/contract-violation` 事件，策略可配 告警/拦截）——DSH 插件形态
- [ ] Phase 3：与 dsh-turn-guard / dsh-retrace 时间线联动

## 许可

MIT © OfferKuai Team
