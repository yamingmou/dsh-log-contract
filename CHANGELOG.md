## [0.3.14] — 2026-09-14 · 发布面清洗（泄漏闸门）+ 版本支持检测 + 文档如实性

> 背景：0.3.8–0.3.13 的在架版本带着**内部标识**（真实会话 id / 内部工具名 / 内部线名 / 工单号 /
> 本机私有落点），随 npm 与公开仓外泄。本版把对外面清到 0，并把「发布前必须核验」变成**可执行的闸门**。

### 新增
- **发布泄漏闸门**（`scripts/check-publish-leaks.mjs`）:must-0 词表（会话 id / seq / 内部线名与工具名 /
  工单号 / 私有路径 / 私有概念）+ 逐条列名的 allow 清单（fail-closed:未列名一律算 must-0）;
  发布集完整性 sanity(文件数下限 + 必需文件，按本仓参数化)⇒ 需大小 2 退出码区分"真干净"与"扫错地方"。
- **版本支持检测**（`lib/version-support.js`):测试基线（宿主 `@deepseek-ai/dsh-session@0.1.5-rc.1` /
  会话格式 v3 / 已知 0/1/2/3）变成**常量**并**运行时比对**:宿主比基线新 ⇒ 告警;
  被检文件格式未知或无法识别 ⇒ 报"未验证格式"并**按只读处理**（`prewrite`/`fix` 拒绝，退出码 3）。
- **行为探针**（`lib/host-probes.js`，独立复核裁定 R-D):自造微型日志喂宿主导出的
  `foldSurface`/`adoptSessionEvent`,断言规则假设;不一致 ⇒ 相关规则标 `UNVERIFIED` 并在结论抬头点名。

### 修复（独立复核 2026-09-14 确证的误报/漏检）
- **Z2 撕裂尾帧误报**:宿主 `readZstdPrefix` 会恢复撕裂尾帧并 `tornTruncateTo`,旧实现直接抛错 ⇒
  级联 `Z1+Z2+H1`、verdict=broken(把宿主能修的文件报成"会话坏了")。现按宿主语义**恢复**
  (无完整帧仍报错);写路径仍 strict(不回写活动会话正在写的尾部)。
- **S2 误报**:未知类型 + `ignorable:true` 的 opaque 元数据宿主**刻意容忍**(`dsh-session:270`),
  不再报 S2 error(E7 warning 保留)。
- **T2/P1/P2/C1/T3 标注**为"出处未复核 / 判定前提存疑"(机读字段 + 结论抬头清单);
  **E5**"写入即被拒"订正为"写入会成功、下一次读取才炸"。
- **R-C 历史 marker 白名单收窄**:从"任意 `data.editor`"收窄为可识别的历史 retrace 载体
  (id 前缀 + `editor.targetSeq === op.start`),**只对 ≤v2 降级**且降级可见;
  新增一次性根治 `fix --neutralize-legacy-markers`。
- **R-G 补 3 条候选规则**:E9 `system/message` 必须 plugin source;E10 `request/header` 字段约束;
  E8 信封键白名单(**按 R-D 探针订正口径**:load 路径容忍、seed/restore 路径拒 ⇒ warning)。

### 文档
- README 中英:「版本支持」明文（基线 + 未验证版本行为）;`/compact` 表述改为**带前提的如实版**
  （只承诺新写入不再制造 token-meter 配对债;历史单段 marker 需先清理）。
- 删除 README 中英重复的「版本支持」整段;「升级到 0.3.12」标题更新到 0.3.14。

## [0.3.13] — 2026-09-14 · 修复 --tail-renumber 的静默数据破坏 + 迁移门可 opt-out

> ⚠️ **安全修复**:0.3.11/0.3.12 的 `--tail-renumber` 在 v3 会话上会把**区间对** `sourceEventSeqs` 写成 `null`
> （`[[0,1]]` → `[null]`，静默破坏且仍报 `changed`）。本版修复。

### 修复
- **`--tail-renumber` 位移时同步所有 seq 引用**:`data.shadowedRange{start,end}` / `data.shadowedSeqs` /
  `surfaceOp{start,end,startSeq,endSeq}` / `data.messageSeqs` / **v3 区间对 `sourceEventSeqs`**。
  跨平移起点的区间对**明确报错**（不猜：两端分属起点两侧时结果不是单个闭区间）。
  已知未覆盖:`command/done.data.sourceEventSeq`（单数，命中 2/284 文件，低严重度）。
- **迁移门可 opt-out**:新增 `--no-fail-on-migration`（恢复 0.3.11 退出码;**只影响退出码**,JSON 结论不变）;
  与 `--fail-on-migration` 同给时 opt-out 优先。
- **迁移预检新增 G3**（`session/title` 系列 `messageSeqs`,出处 `v0-to-v1:2543-2556`）。

### 一条**做了又撤回**的规则（如实记录）
turn/start 状态机规则（G4）原型在 281 个真实 v0 上 **0 误报**、能把残余 mismatch 打到 0,
但机制审计发现**官方把它跑在变换后的 v1/v2 artifact 上**（`v1-to-v2:104`,带 `cut`）,不是原始 v0 ——
把官方该断言直接喂**原始 v0** 会 `THROW: assistant/chunk does not match an open turn and step`。
⇒ **撤回**,并写进工具的 `coverage.uncovered`。
**"0 误报"不等于"语义与官方一致"** —— 撤回的价值不是修 mismatch,而是**避免写错病因**。

### 指标
- 迁移交叉表（281 真实 v0）:拦住 **234** / **误拦 0** / 残余 mismatch **26**（原 27）/ 官方 OK 21;
- 突变矩阵 **32/32 RED、0 存活**;双宿主 `0.1.5-rc.1` **169/0/2**、`0.1.0-rc.7` **157/0/14**;
- 未覆盖（`coverage.uncovered`,6 类）:`turn/start` close-prior 10 / open-expected 7 / shape 4 / attempt 2 / inheritedCount 2 / inheritedCut 1;
  下轮第一顺位 = `inheritedEventCount`（= `header.seedLength`,须与**展开后**事件数比较）。

## [0.3.12] — 2026-09-14 · 宿主 0.1.5 语义对齐（按被检文件版本择路）+ 诚实性修复

### 新增/修复
- **按被检文件自身 `header.version` 择路**（不按运行时版本）：v0–v2 走本地等价折叠，v3 走官方 `foldSurface`；
  修掉一处**死分支**（旧格式回退路径只看 `.error`，`violations` 成死数据 ⇒ 终验 S8 永不触发）。
- **v3 区间编码**：`sourceEventSeqs` 的官方区间对 `[[a,b],…]` 现在会展开（本地 vendored `decodeSeqRanges`；
  该导出**只有 0.1.5+ 有**，直接引官方会在旧宿主上"装即坏"）；在**读取层 / 体检入口 / 写前入口**三处归一。
  实测：一处真实 v3 会话由「S5×1+S6×4+S8×1 误报」变为 `ok` 且与官方一致（487 节点 / 198 替换）。
- **删掉模块级 `fileVersion` 全局状态**，版本改为「显式参数 > `header.version` > 事件形状推断」，
  消除"同进程先体检 v3 再写前校验 v0 结论翻转"的隐式串味。
- **宿主能力闸**：文件版本高于宿主上限 ⇒ 输出 `not-assessable`（退出码 3），不再误报 `broken`；
  `fix --apply` 拒绝落盘。
- **迁移预检**（`migrationVerdict`）：对"官方升级链会拒"的文件显式 blocked（退出码 4），
  交叉表把"工具判 ok 但官方拒"从 259/280 降到 27/281。
- **`--json` 新增 `assessmentScope`**（`full`/`partial`/`none`）：`partial` 时 CLI 不再给无条件绿。
- `--json` 大报告不再被 `process.exit` 截断（先同步写完）；v2 词表按官方构造式剔除 `assistant/chunk`。

### ⚠️ 破坏性变更
- **退出码**：新增 3/4，且"工具自己判官方会拒"的文件不再返回 0。

### 已知限制（未覆盖，详见 `coverage.uncovered`）
- 迁移预检只覆盖 2 条规则，另有 6 类未覆盖；`turn/start` 未闭合/未打开预期轮、继承切点、
  `title messageSeqs`、`assistant/attempt` 等仍不在覆盖内。
- payload 层形状（如 `subagent/descriptor.data.version`）与内嵌 `assistant/attempt.data.stream` 的校验未做。
- `fix --tail-renumber` 未同步 `shadowedRange`/`surfaceOp`/`shadowedSeqs` 的位移（未审改动，本版**未纳入**）。

## [0.3.11] — 2026-09-09 · 对抗性复核规则增量 T1-T3（38 条规则）

### 新增（2026-09-09 · 工程师任务清单 插件需求-对抗性复核提取-20260909.md）

- **T1 → P3 双向**：tool/result 无对应 tool/call（孤儿 result）也告警,精确指认 callId
  （原只查孤儿 call;折叠后 wire 流无主 tool 消息 = provider 拒绝风险,W1/W2 同族不同层）;
- **T2 → E7（新规则）**：ignorable 未知 type 合法性——未知 type + ignorable + 无已知
  消费者（retrace/marker、retrace/goal-marker、message-editor/ 白名单外）= warning
  "静默垃圾"（ignorable 后门补校验）;全量 138 会话 0 误报（白名单覆盖 neutralize 产物）;
- **T3 → Z3（新规则）**：空会话文件（有 header 无事件）显式 warning（36 条规则全来自
  有内容事故,空态无覆盖——补盲区）;
- 测试 +5（110 全绿）;docs/CONTRACTS.md 自动生成 38 条;
- 观察项:T4 重复投递检测语义边界待澄清（内容重复难判:用户重复提问合法）;
  C2 超时专项记 backlog;C4 自查通过（check 纯读不落盘,保持）。



### 风险跟踪（2026-09-06 · 外部 AI 审计引出）：官方 session 格式 v1→v2

- 官方 deepseek-harness 9/4 release **0.1.3-alpha.1** + worktree
  `session-format-05-v1-v2-chunk-migration`（9/2-9/4 活跃）——session 格式 v1→v2 迁移；
- 本包解码路径依赖官方：peerDep `@deepseek-ai/dsh-session ^0.1.0-rc.7`，
  `decodeStorageRecord`（log-reader）+ `foldSurface`/`KNOWN_SESSION_EVENT_TYPES`（checks）；
- **现状兼容**：DSH Desktop 2.0.3 捆绑 0.1.1-rc.2（v1），本包服务 v1 会话不受影响；
- **策略**：v2 未冻结不追（追移动靶）；**冻结（进 rc/正式 + DSH 升级）时评估**：
  ① 格式 diff（chunk 迁移改什么）② 解码路径要动的点（理想 = decode 层单点替换，
  log-reader 与规则层边界清晰则只动 decode）③ v1 老会话在 v2 读路径的兼容性（主要战场）；
- 讨论：内部调研（评审记录）。

### 工具（2026-09-06 · 外部审计教训固化）

- `scripts/gen-contracts-doc.mjs`：从 `lib/contracts.js` CONTRACT_RULES 自动生成
  `docs/CONTRACTS.md`（36 条全覆盖）——规则文档禁止手工维护（曾滞后 15+ 条被外部审计指出）；
- `scripts/check-pkg-meta.mjs`：发布前校验 repository/homepage/bugs 指向 yamingmou
  （曾残留旧账号 azmavethy → 404 永久失效），接入 prepublishOnly。



### 新增

- **`readSessionHeader(path)`**：只读会话文件帧 1（header 单行），不读全文件帧——
  全量 ~110 会话扫描 ≈ 30ms（zstd 文件读前缀 64KiB 解帧 1；明文直接取首行）。
  用途：会话短码推导（工作区 createdAt 序号）只需要 header；失败返回 null。
- 105 测试绿。

## 0.3.9 — 2026-09-02 · T5 turn/end reason.kind（malformed turn/end 固化）

### 新增（2026-09-02 · T5 turn/end 必须带 data.reason.kind）

- **T5**（`turnEndReasonViolations`）：turn/end 的 `data.reason?.kind` 缺失/非字符串
  = error——官方 validation 强制（镜像 dsh-agent-loop:620），缺失 = malformed →
  会话加载失败（实测：retrace 情形③信封 turn/end 漏 reason，已修 0.4.18）；
- 进 `check` 全量体检 + `--resume`（计入可加载/可压缩阻断）+ prewrite 写前校验；
- 契约注册 T5；测试 fixture 修正（turnEnd helper 的 reason 从字符串改为
  `{ kind: 'completed' }` 对象——真实 DSH 契约）；102 测试绿。

## 0.3.8 — 2026-09-02 · 渲染层规则 T3/T4（渲染层白屏复盘固化）

### 新增（2026-09-02 · 渲染层规则 T3/T4 —— 渲染层白屏复盘固化）

- **T3 step 节点 key 唯一**（`stepKeyViolations`）：同 turn 内两个 step/start 的
  step 号重复 = error（客户端 React 节点 key 冲突 → 渲染死循环白屏事故；
  同类会话已由修复工具整块重编号修复）；
- **T4 step/消息本体 turn 缺失**（`nullTurnStepViolations`）：step/start|step/end|
  assistant/message 的 data.turn 为 null/undefined = error（客户端渲染状态机
  无法归属 → 死循环白屏（D8 事故）；user/message 天然无 turn 不查、chunk 不查）；
- 两条规则进 `check` 全量体检 + `--resume` 三档（计入可加载/可压缩阻断）+ prewrite
  写前校验（拟写事件引入 T3/T4 → error 拒绝，防再犯：任何写 turn:null 或 step
  冲突的 marker 写入前被拦）；
- 契约注册 T3/T4；98 测试绿。

## 0.3.7 — 2026-08-31 · L3/L4/L5 + 独立审查 5 项修复 + health-scan 巡检

### 新增

- **L3 `check --resume` 三档结论**：loadable / resumable / compactable——体检不只报违规，
  还能判定会话能否加载/续跑/压缩（`bin/dsh-log-contract.mjs check <file> --resume`）；
- **L4 fix 原语收编**：neutralize / clip-crossstep / drop-turnnull / trim 等收进统一命令；
- **L5 `--trim-budget`**：按 token 预算裁剪（中文字符密度实测校准）；
- **health-scan.mjs 定期巡检**（`scripts/health-scan.mjs`）：全量扫描会话 → 分级
  （🟢健康/🟡可自修/🔴损坏）→ 报告归档 `健康巡检报告-*.md`——生产级运行时的
  「定期巡检」层（工程-生产级运行时/自检机制）。

### 修复（独立审查 5 项）

- neutralize-orphan 误伤健康文件（孤立判定过宽）；
- extract-turn 同 seq 丢内容（同 seq 多事件只取最后一个）；
- tail-renumber 崩溃（尾部非数字/空文件）；
- keep-ranges 静默输出错误 header（header 被当普通行）；
- 工具 exit 码不统一（成功/失败无法脚本判断）。

---

## 0.3.6 — 2026-08-30 · T2 规则盲区修复（非 chunk 引用 + usage 前提）

### 事故（2026-08-30 第二层根因）

- 某真实会话 neutralize 后仍报错：6 个 error 级 T2 跨 step 引用。
- 精查该会话：sourceEventSeqs 2011 个引用 = 2001 同 step chunk + **10 个非 chunk**
  （assistant/message、tool/call、tool/result、step/end、step/start 各 2）——DSH resend
  在 step 未关时把旧 step 整段引用进新消息。
- **官方 `dsh-token-meter/lib/index.js:644`：非 chunk 引用直接 throw `is not assistant/chunk`**
  （:640 非更早 / :641 重复 / :644 非 chunk / :645 跨 step，四查全 throw）。
- 我们 0.3.5 的 T2 规则写 `continue`（注释"非 chunk 官方跳过"）——**假设错误** →
  磁盘 check 全绿、实机必崩；clip-crossstep 同样错误保留非 chunk 引用。

### 修复

- **关键区分（官方 :592 前提）**：`_estimateProviderAssistant` 只在
  `event.data.usage !== undefined && nextHeader !== undefined` 时被调用——
  **replace marker（空内容、无 usage）根本不走 source 检查**，其非 chunk
  sourceEventSeqs 是 S5 遮蔽语义、合法且必需，**不可裁剪**；只有带 usage 的
  append 消息才检查/裁剪。
- T2 规则 + clip-crossstep 都加 usage 前提；非 chunk 引用改报 error（原 continue）。
- 某真实会话修复：只裁剪一条跨 step 引用（2011→2001，去掉 10 个非 chunk），
  5 条 replace marker 不动；复检 0 违规。
- 测试 +2（非 chunk → T2 error / replace marker 无 usage 不报），**81 全绿**。

### 铁律沉淀

- **规则必须逐字镜像官方源码**——凡注释写"官方跳过/官方不管"的，先打开官方源码
  确认，别猜（本事故就是"猜官方跳过"猜错的）。

## 0.3.6 发版清查台账（2026-08-30）

- 全量历史会话清查（~/.dsh/sessions 85 会话）：**error 级违规 0**（T1/T2/I1/S9 全清）。
- 该会话遗留 6 个 0.4.6 时代 turn-null marker（seq 约 1.09M–1.14M）已在前序 neutralize 中处理；跨 step 引用已 clip（2011→2001）。
- 说明：0.3.6 的 T2 usage 前提修复后复扫，replace marker（无 usage）的 sourceEventSeqs 不再误报——S5 遮蔽语义合法引用保留。
