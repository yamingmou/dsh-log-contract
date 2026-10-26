# 契约规则目录（CONTRACTS）

> **自动生成**（2026-09-06 起）：本文件由 `node scripts/gen-contracts-doc.mjs`
> 从 `lib/contracts.js` 的 `CONTRACT_RULES` 注册表生成——**勿手改**，规则只增不减，
> 新增规则后跑一次生成即同步（此前手工维护滞后 15+ 条）。
> **漂移闸**：`pnpm check` 会跑 `--check` 逐字节比对，改了注册表没重生成 ⇒ 直接红。
>
> DSH 会话日志契约的**可执行 spec**。每条规则在 `lib/checks.js`（逐事件判定）
> 与 `lib/prewrite.js`（写前校验）中有对应实现；离线体检（`lib/validate.js`）
> 逐条执行并在最后用官方 `foldSurface` 终验（S8）。
>
> 规则来源：历史会话日志的实测事故与契约缺口（持久化/客户端引擎/插件语义三层）+ 官方源码逐行核对
> （`@deepseek-ai/dsh-session`，各条出处见下）。后续规则随官方版本演进追加：
> T3/T4 = 渲染层白屏事故复盘，T5 = malformed turn/end 事故复盘。
>
> **版本支持基线（本规则集验证过的版本；权威常量见 `lib/version-support.js` 的 TESTED_BASELINE）**：
> 宿主 `@deepseek-ai/dsh-session@0.2.0-rc.2` ｜ 会话格式 **v4**（`SESSION_FORMAT_VERSION = 4`）｜
> 声明范围 `^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.2.0-rc.1`（可安装 ≠ 逐个验证）｜ 已知格式 0/1/2/3/4
> （0–2 由本包自带 vendored 词表 + `legacyFoldSurface` 支持，与宿主版本无关）。
> **未验证版本**：宿主比基线新 → 运行时告警；文件格式未知/无法识别 → 报"未验证格式"并**按只读处理**
> （`prewrite`/`fix` 拒绝，退出码 3）；文件版本 > 宿主上限 → `not-assessable`（不是 broken）。
>
> 严重度：**error** = 违反即会话不可加载/写入被拒（fail-loud）；**warning** = 合法但可疑。

## 规则索引（共 55 条）

| id | 严重度 | 层级 | 规则 |
|---|---|---|---|
| H1 | error | persistence | 首行为合法 JSON 且 type=session |
| H2 | error | persistence | header 版本与必填字段 |
| R1 | error | persistence | 每行必须是合法 JSON |
| R2 | error | persistence | chunk 行必须满足精确信封形状 |
| R3 | error | persistence | chunk 行展开后成员 seq/time 安全 |
| R4 | error | persistence | 读取/解析容错：单文件损坏不得抛出、不得中断枚举与汇总 |
| R5 | error | persistence | 汇总/枚举类 API 逐项隔离（per-item try/catch + 失败计数） |
| E1 | error | persistence | 每个事件携带非负安全整数 seq |
| E2 | error | persistence | seq 严格连续（单写入者假设） |
| S9 | error | persistence | 文件物理序 seq 单调（多写入者交织现场特征） |
| S10 | error | persistence | sourceEventSeqs 元素必须是（解码后的）非负整数；存储形态只允许官方区间对 |
| I1 | error | engine | inbox seed 相对重放（fork 边界孤儿 spliced） |
| I2 | error | persistence | seedLength = 继承事件条数（不是字节数）；parentSession ∧ seedLength∈{缺失,0} 合法 |
| E3 | error | persistence | type 必须在已知词汇表内（或带 ignorable 标记） |
| E4 | error | persistence | data 与 surface 元数据必须 JSON 无损 |
| E5 | error | persistence | 禁用遗留词汇 |
| E6 | error | persistence | 消息类事件消息形状 |
| S1 | error | persistence | surface 候选类型必须携带 surfaceOp |
| S2 | error | persistence | 非 surface 类型不得携带 surface 元数据 |
| S3 | error | persistence | append 的 sourceEventSeqs 契约 |
| S4 | error | persistence | replace 操作数与范围合法性 |
| S5 | error | persistence | replace 的 sourceEventSeqs 必须完整覆盖被替换节点 |
| S6 | error | persistence | sourceEventSeqs 自身约束 |
| S7 | error | persistence | tool/result 替换仅允许单节点内容改写 |
| S8 | error | persistence | 整日志 foldSurface 可重放 |
| T1 | error | engine | token-meter 配对：assistant/message 与 step/end 必须匹配当前打开的 step/start |
| T2 | error | engine | token-meter 源引用：assistant/message 的 sourceEventSeqs 引用的 chunk 必须同 turn/step |
| T3 | error | engine | step 节点 key 唯一（同 turn 内 step/start 的 step 号不得复用） |
| T4 | error | engine | step/消息本体 turn 缺失（null/undefined）→ 渲染死循环 |
| T5 | error | engine | turn/end 必须带 data.reason.kind |
| E7 | warning | persistence | ignorable 未知 type 合法性（带被忽略标记的未知事件须有消费者） |
| E8 | warning | persistence | 事件信封键白名单（多余键：seed/restore 路径会拒） |
| E9 | error | persistence | system/message 的 source 契约（v3 plugin / v4 system-prompt） |
| E10 | error | persistence | request/header 的 data.header 字段约束 |
| E11 | error | persistence | seq 由日志层分配：写侧不得自造（省略 seq，或必须等于 nextSeq） |
| Z3 | warning | framing | 空会话文件（有 header 无事件）显式报出 |
| P3 | warning | plugin | tool/call ↔ tool/result 配对完整性（考古 B1） |
| P4 | warning | plugin | tool/result 输出结构可解析（考古 B2） |
| M1 | error | engine | turn/step 为 null 的 assistant/message 只能 replace，不能 append |
| P1 | warning | plugin | marker id 前缀必须被识别 |
| P2 | error | plugin | marker 自身 seq 不得出现在自身 shadowed 集 |
| P5 | error | plugin | carrier 两段配对：第 2 段 sourceEventSeqs 首元素 = 第 1 段（审计段）seq |
| C1 | warning | concurrency | seq 缺口/倒退提示多写入者 |
| Z1 | warning | framing | zstd 尾帧撕裂 |
| Z2 | error | framing | zstd 帧解码失败 = 单帧全损 |
| Z4 | error | framing | 首帧必须恰好一行 header |
| Z5 | error | framing | 多行日志不得压成单帧 |
| Z6 | warning | framing | 尾部完整性必须显式声明（tailStatus: complete|truncated|interrupted|unknown） |
| W1 | error | engine | wire 流：tool 消息必须跟在带 tool-call 的 assistant 消息之后 |
| W2 | error | engine | wire 流：user 文本不得插在 tool_calls 与其 tool 结果之间 |
| G1 | warning | migration | 迁移预检：v0 源文件的 subagent/descriptor.data.version 必须为 3 |
| G2 | warning | migration | 迁移预检：v0 源文件不得含词表外的历史事件类型（含 ignorable） |
| G3 | warning | migration | 迁移预检：v0 源 session/title 系列的 messageSeqs 必须引用更早的人类 user/message |
| G4 | warning | migration | 未知历史事件声明式可忽略（ignorable:true + 白名单）——迁移不得硬拒 |
| A1 | error | archive | 在位可还原只认结构化归档指针（archiveRef / archive / externalized.*） |

## 详细规则

### H1 — 首行为合法 JSON 且 type=session

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1109-1126 (validateSessionHeader)
- **契约**: 会话日志首行必须是可 JSON.parse 的对象，且 type 为 "session"。首行损坏 = 整个会话不可读。

### H2 — header 版本与必填字段

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1110-1125；已知格式版本 0/1/2/3/4（App 2.0.9 内置 v0→v1→v2→v3 迁移，SESSION_FORMAT_VERSION=3；DSH 0.2.x 追加 v3→v4，SESSION_FORMAT_VERSION=4）
- **契约**: header.version 必须为已知受支持版本（0/1/2/3/4）；未知版本报 H2。id 为字符串；createdAt 为非负安全整数；cwd 若存在必须为绝对路径（POSIX 与 Windows 盘符/UNC 形态均接受）；origin 只能为 "subagent"。

### R1 — 每行必须是合法 JSON

- **层级**: persistence ｜ **严重度**: error
- **出处**: seq 缺口扫描；dsh-session-persistence-jsonl 读路径
- **契约**: 非空行无法 JSON.parse = 损坏行。帧边界产生的空行是合法的（跳过）。

### R2 — chunk 行必须满足精确信封形状

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:922-971 (validateRow)
- **契约**: text-chunks / reasoning-chunks / tool-call-chunks 行必须精确为 {type, seq0, time0, data}，data 精确为 {turn, step, index, dt, texts|args}。损坏 = 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）。

### R3 — chunk 行展开后成员 seq/time 安全

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:964-969
- **契约**: 展开后成员 seq 与 time 必须保持安全整数（seq0+len-1 与逐 gap 累加的 time 不溢出）。

### R4 — 读取/解析容错：单文件损坏不得抛出、不得中断枚举与汇总

- **层级**: persistence ｜ **严重度**: error
- **出处**: 2026-10 实测：一个截断 zstd 帧让会话读头抛 ERR_OUT_OF_RANGE，逐会话读头的聚合/枚举能力整体失败（33 天内数百次）；根因之一是帧扫描的块头 3 字节越界读（readUInt32LE 读了 4 字节）
- **契约**: **读取/解析入口的行为契约**（判在 rules self-test，不是逐文件判据）：任何单文件**内容级**异常（截断帧、损坏行、坏 chunk 行、空文件、非法 JSON）都必须降级为**结构化结果**——返回 null / 逐行 error 标记 / 帧事实（frameInfo.error / torn / tailStatus / unreadableRows），可被调用方统计；**不得抛出异常**中断"枚举 N 个会话"这类汇总能力。IO 级异常（文件不存在/无权限）不在本条范围（照常抛给调用方处理）。违规样本（截断/损坏文件）必须"判红"（R1/R2/Z1/Z2 或结构化 null + 计数）而不是抛栈；合规样本（健康文件）必须全绿。覆盖入口：读头 readSessionHeader、全量读取 loadSessionLog、尾部查询 tailSeq、帧扫描 scanZstdFrames。

### R5 — 汇总/枚举类 API 逐项隔离（per-item try/catch + 失败计数）

- **层级**: persistence ｜ **严重度**: error
- **出处**: 2026-10 实测：单文件炸整表的第二个根因——聚合循环"一项坏 ⇒ 整批抛"，既无逐项 try/catch 也无失败计数（坏项不可见、整体不可用）
- **契约**: 聚合/汇总类 API（逐事件扫描、工具调用审计、逐项配对导出等）必须**逐项**隔离失败：单项异常只丢该项并**计数**（如 skipped/unreadable），整体结果照常返回。违规样本（构造一个读取即抛的畸形事件）必须让 API 返回"结果 + skipped≥1"且不抛；合规样本必须 skipped=0。⛔ "整体抛出"或"静默吞掉且不可统计"都算违规。

### E1 — 每个事件携带非负安全整数 seq

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:295-298 (isEventSeq)、:1453-1459 (append 信封)
- **契约**: 事件信封为 {type, seq, time, data, ...surfaceMetadata}；seq 必须是非负安全整数。

### E2 — seq 严格连续（单写入者假设）

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:398 (planSurfaceEvent "not contiguous")
- **契约**: seq 必须从 0（或窗口 baseSeq）严格连续递增。缺口/倒退 = 违反单写入者假设（多实例共享存储并发写的痕迹），加载时直接 throw。

### S9 — 文件物理序 seq 单调（多写入者交织现场特征）

- **层级**: persistence ｜ **严重度**: error
- **出处**: 2026-08-28 实锤（某真实会话）：文件物理序出现回退（大→小→更大）；单进程 appendCore 断言 seq==cursor+i 且按 id 串行化不可能写出
- **契约**: 按文件物理行序要求展开后事件 seq 严格单调递增。E2 在排序后检查（loadSessionLog 会 sort），物理序倒退被掩盖；S9 在排序前按行序检查，非单调 = 多写入者/旧光标回放交织的直接现场证据，加载会被拒。

### S10 — sourceEventSeqs 元素必须是（解码后的）非负整数；存储形态只允许官方区间对

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session@0.2.0-rc.2 lib/index.js:963-999（encodeSeqRanges：连续 ≥3 才压缩成 `[start,end]`，即 v3+ JSONL 的存储形态）、:1000-1026（decodeSeqRanges/assertSeq：元素必须是非负安全整数，区间对只允许 `[start,end]` 且 start ≤ end、解码后严格递增）
- **契约**: 所有事件的 `sourceEventSeqs`（**含非 surface 类型与 ignorable 未知插件事件**）原始存储形态只允许两种元素：非负安全整数、或官方区间对 `[start,end]`；经官方 `decodeSeqRanges` 解码后必须全部是非负安全整数。解码后仍为数组/非整数 = 契约违规（投影层/restore/重写路径会把它静默当成 seq，实测 v4test 即如此）⇒ 判红并给出该事件的 seq/行号。注意：`[a,b]` 本身是 v3+ 的**合法存储形态**（本机 760 份真实会话里 265 处，全部可解码），不得误报；判红点是「解码后仍非整数」与「非官方区间对形态」。

### I1 — inbox seed 相对重放（fork 边界孤儿 spliced）

- **层级**: engine ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-agent lib/types/inbox.js:155-178 (apply/validate)；2026-08-28 实锤（某两个真实会话）：fork 边界 removedCount=1 孤儿
- **契约**: 从 header.seedLength 起重放 agent/inbox/spliced，next-turn/next-step 双队列；start+removedCount 不得超过队列长、不得产生重复 pending id。fork 时"移除父待处理提示词"的 splice 假设父会话 inbox，子会话 seed 相对空 inbox 上非法 → resume 被拒（invalid persisted inbox splice）。

### I2 — seedLength = 继承事件条数（不是字节数）；parentSession ∧ seedLength∈{缺失,0} 合法

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2 package/lib/index.js:1707（`seedLength` → `inheritedEventCount`，缺省 0）、:1720（`isSeeded = seedLength !== undefined`）、:1517-1520（"Session inheritedEventCount exceeds its event count" / "unseeded Session inheritedEventCount must be 0"）；v4 运行时头禁该字段：dsh-session@0.2.0-rc.2 lib/index.js:1040（"session header has invalid field \"seedLength\""）
- **契约**: `header.seedLength` 的语义被钉死为**继承事件条数**（官方 `inheritedEventCount`），不是字节数、不是行数。判据：① 若存在必须是非负安全整数；② `seedLength > 展开后事件数` ⇒ error（官方解码/迁移直接抛 "inheritedEventCount exceeds its event count"）；③ 文件版本 ≥4 时该字段必须不存在（v4 运行时 header 校验拒）。**`parentSession` 有值 ∧ `seedLength` 缺失或 0 ⇒ 合法**：`parentSession` 只记血缘，是否 seeded 由 `seedLength` 字段是否存在决定（`isSeeded = seedLength !== undefined`；只有 unseeded 才要求 inheritedEventCount === 0）——实测本机 712/760 份真实 v3/v4 头带 `parentSession` 且无 `seedLength`（`isSeeded:false`）仍正常加载，不能判违规。真实读数（本机 29 份 v0 化石）：19 份带 `seedLength`（15 万／53 万／68 万／28 万／67 万量级），**全部 ≤ 展开后事件数**（约 69 万／59 万／72 万／39 万／317 万条），而同一文件的明文体积是 20.3–105.4 MB ⇒ `seedLength` 既不可能是字节数（差 1–2 个数量级），也不可能是行数（行数仅 1.3–7 万）⇒ 真实数据与"继承事件条数"一致，本机命中 0 例 `> 展开事件数`（判红分支是防"当字节数用"的护栏）。

### E3 — type 必须在已知词汇表内（或带 ignorable 标记）

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1046-1049 (KNOWN_SESSION_EVENT_TYPES 注释)
- **契约**: 词汇表外的 type 会被持久化读路径拒绝，除非事件带信封级 ignorable 标记（新版本 harness 写入的日志）。插件事件（如 retrace marker 以 assistant/message 承载）不在词汇表外——它们复用核心类型。

### E4 — data 与 surface 元数据必须 JSON 无损

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1446-1450 (snapshotJsonValue 双快照)
- **契约**: append 热路径对 data 与 surfaceMetadata 各做一次 lossless-JSON 全量校验；非 JSON 安全值（函数/循环引用/非有限数）写入前即被拒。

### E5 — 禁用遗留词汇

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1273-1277 (assertSupportedRequestHeader)
- **契约**: request/header-delta 与 reason=fallback 的 request/header 是已删除的遗留格式。注意（订正 E5）：宿主 Session.append/appendLines 不看 type ⇒ 写入会成功、下一次读取才炸（依据 dsh-session@0.1.5-rc.1 lib/index.js:1170-1210 / persistence-jsonl:3046-3073），不是写入即被拒。

### E6 — 消息类事件消息形状

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1242-1266 (assertMessageEventShape)；v4：dsh-session@0.2.0-rc.2 src/index.ts:331-381
- **契约**: user/message、assistant/message、tool/result 必须携带具名 message（非空 id、正确 role、合法 source、content 数组；assistant 需 model source，tool/result 需 tool source 且 toolCallId 匹配）。v0–v3：tool/result role 为 user 且恰含一个 tool-result 块；v4：tool/result role 为 tool、不得含 tool-result 包装块、message.toolCallId 等于 source.callId，新增 developer/message（role developer），且任何消息 source.kind 不得为 plugin。

### S1 — surface 候选类型必须携带 surfaceOp

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:312-317 (surfaceOpOf)
- **契约**: user/message、assistant/message、tool/result（v3 起含 system/message，v4 起含 developer/message）是 surface-eligible 类型，缺 surfaceOp 即违反契约。

### S2 — 非 surface 类型不得携带 surface 元数据

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:307-311 (surfaceOpOf)
- **契约**: 词汇表内非 surface-eligible 类型带 surfaceOp / sourceEventSeqs = 违反契约。

### S3 — append 的 sourceEventSeqs 契约

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:401-407、:320-337 (assertProvenance)
- **契约**: append 以空 shadowed 集校验：sourceEventSeqs 若携带必须满足 assertProvenance（数组、无重复、全部引用更早事件）；任何违规即写入被拒。

### S4 — replace 操作数与范围合法性

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:300-303 (isReplaceOp)、:339-350 (replacementRange)
- **契约**: replace 必须是精确的 {op:"replace", start, end}（v0–v2）或 {op:"replace", startSeq, endSeq}（v3/v4）；端点必须存在于当前 surface 节点且 startIdx ≤ endIdx。

### S5 — replace 的 sourceEventSeqs 必须完整覆盖被替换节点

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:335-336 (assertProvenance)；复盘事故第 1 次尝试
- **契约**: ★ 写前校验核心规则：sourceEventSeqs 必须包含每一个被替换（shadowed）的 surface 节点，缺一个 = 会话加载被拒（SessionPersistenceCorruptionError）。2026-08-25 事故第 1 次尝试（清空 sourceEventSeqs）正是违反此规则。

### S6 — sourceEventSeqs 自身约束

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:320-333 (assertProvenance)
- **契约**: sourceEventSeqs 存在时必须为数组、无重复、全部引用更早事件（< 当前 seq），且除 assistant/message 外不得为空。

### S7 — tool/result 替换仅允许单节点内容改写

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:369-395 (assertToolResultRewrite)
- **契约**: tool/result 的 replace 必须恰好重写 1 个当前节点、目标是 tool/result，且除 message.content 外不得改动任何字段。

### S8 — 整日志 foldSurface 可重放

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:444-455 (foldSurface, v3)；v0/v1/v2 用本地等价实现 lib/legacy-fold.js（rc.7 lib/index.js:229-455 逐条移植）
- **契约**: 终验：按被检文件 header.version 选折叠器（v3 → 官方 foldSurface；v0/v1/v2 → 本地 legacyFoldSurface），不抛 = 持久化层通过。S1–S7 任何一条违反都会在此暴露。注意 0.1.5 的官方 foldSurface 是 v3 语义（replace 用 startSeq/endSeq、assistant/message 禁 sourceEventSeqs），对旧格式文件会误报，不可借用。

### T1 — token-meter 配对：assistant/message 与 step/end 必须匹配当前打开的 step/start

- **层级**: engine ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-token-meter lib/index.js:566-625 (_foldEvent)
- **契约**: token meter 折叠要求 assistant/message 与 step/end 与打开的 step/start（turn/step 完全一致）匹配；违反即 /compact 与压力测量永久失败。retrace 的 turn-null 编辑/撤回 marker（空 assistant/message replace）命中此条——foldSurface 认可其合法性但 token meter 崩溃（M1 只约束 append 形态的盲区），压缩前需清理。

### T2 — token-meter 源引用：assistant/message 的 sourceEventSeqs 引用的 chunk 必须同 turn/step

- **层级**: engine ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-token-meter lib/index.js:634-650 (_estimateProviderAssistant，:645 belongs to another step)
- **契约**: token meter 重建 provider 输出时，逐条检查 assistant/message 的 sourceEventSeqs：指向 assistant/chunk 的引用必须与消息同 turn/step，且 seq 更早、不重复；跨 step 引用 → 官方抛 belongs to another step → 每次事件追加都重抛（consumedEvents 不前进）→ 刷屏压垮 host（2026-08-30 实测：某真实会话的 chunk 源引用跨 step 7/8/9）。T1 只查 step 配对不查源引用，此条补盲区；修复用 fix --clip-crossstep。

### T3 — step 节点 key 唯一（同 turn 内 step/start 的 step 号不得复用）

- **层级**: engine ｜ **严重度**: error
- **出处**: 复盘 2026-09-02 渲染层白屏事故：客户端渲染节点 key = turn:step，冲突 → React 渲染死循环（由离线自查脚本判出）
- **契约**: 客户端渲染消息列表从事件流构建节点，节点 key = data.turn:data.step。同 turn 内两个 step/start 的 step 号相同 → key 冲突 → React 渲染死循环 → 白屏/不展示（实测：同一 turn 内两个 step/start 复用 step 95/1，一个来自正常轮、一个来自编辑块；后续全量扫描又发现多个同型冲突）。修复：同 turn 内 step 递增、整块重编号（含块内 chunk/tool/assistant）。

### T4 — step/消息本体 turn 缺失（null/undefined）→ 渲染死循环

- **层级**: engine ｜ **严重度**: error
- **出处**: 复盘 2026-09-01 D8 事故：retrace 0.4.17 编辑块 turn:null（离线自查脚本判致命）
- **契约**: 客户端渲染状态机对 turn=null 的 step/start|step/end|assistant/message 无法归属任何 turn → 渲染死循环 → 白屏「载入历史」（实测：编辑块的 step/start + marker + step/end 连续若干行 turn 全为 null）。user/message 天然无 turn 不查；chunk 坐标可缺失不查。step/消息本体必须带真实 turn 号。

### T5 — turn/end 必须带 data.reason.kind

- **层级**: engine ｜ **严重度**: error
- **出处**: 官方 dsh-agent-loop lib/index.js:620（turn/end = {turn, reason:{kind}}）；malformed turn/end 事故（2026-09-02，由离线自查脚本判出）
- **契约**: 官方 validation 强制 turn/end 的 data.reason.kind 存在（kind ∈ completed|max-tokens|blocked|aborted|error|interrupted）。缺失 = malformed → 官方 SessionPersistenceCorruptionError → 会话加载失败。实测：retrace 情形③信封 turn/end 漏 reason → 每次编辑后加载失败（已修 0.4.18）。

### E7 — ignorable 未知 type 合法性（带被忽略标记的未知事件须有消费者）

- **层级**: persistence ｜ **严重度**: warning
- **出处**: 实测 2026-09-09 T2（E3 ignorable 无合法性校验 = 后门）
- **契约**: 未知 type + ignorable:true 被读路径接纳但无人消费 = 静默垃圾。排除已知消费者白名单（retrace/marker、retrace/goal-marker、message-editor/ 前缀等 retrace 客户端消费的插件 marker）后，其余 ignorable 未知事件报 warning。

### E8 — 事件信封键白名单（多余键：seed/restore 路径会拒）

- **层级**: persistence ｜ **严重度**: warning
- **出处**: @deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:849-861（assertSessionEventEnvelope）+ :1063-1068（唯一调用点=seed 路径）；load 路径容忍见行为探针 p5
- **契约**: 事件对象只允许 7 个信封键（type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable）。实测反例指出"宿主拒、旧契约 0 违规"；行为探针进一步订正口径：**load 路径容忍、seed/restore 路径拒** ⇒ warning。

### E9 — system/message 的 source 契约（v3 plugin / v4 system-prompt）

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:942-944（"must have plugin source"）；角色表 :917-926；v4：dsh-session@0.2.0-rc.2 src/index.ts:360-364（"must have system-prompt source"）
- **契约**: v3 新增的 system/message：role 必须为 system，source.kind 必须为 plugin 且 plugin 非空。实测（反例）：source.kind='user' 宿主拒、旧契约 0 违规 ⇒ 漏检。v4（v3→v4 迁移把 @deepseek-ai/dsh-system-prompt 改写为生产者自有 kind）：source.kind 必须为 system-prompt。

### E10 — request/header 的 data.header 字段约束

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:231-248（validateSessionEventData：omit header.system / omit empty tools / omit empty adapterDefaults）
- **契约**: request/header 必须省略 header.system（系统提示改走 system/message）、空 tools、空 adapterDefaults。实测（反例）：带 header.system 的写入宿主拒、旧契约 0 违规 ⇒ 漏检。

### E11 — seq 由日志层分配：写侧不得自造（省略 seq，或必须等于 nextSeq）

- **层级**: persistence ｜ **严重度**: error
- **出处**: 官方 append 信封按日志层连续光标分配 seq（dsh-session lib/index.js:1453-1459 append 信封、:398 planSurfaceEvent "not contiguous"）；实测两类破坏：① 生产者自行生成 seq 写入 ⇒ E2/S8 类红；② 删除两行不重编号 ⇒ 缺口
- **契约**: seq 的唯一合法来源是**日志层的连续光标**（写入时分配）。写侧（prewrite）拟写事件**不携带 seq**（由校验器赋 nextSeq），携带时必须等于 nextSeq，否则 E11 拒绝——⛔ 生产者不得自造/自增 seq。文件侧的"写侧自造"痕迹由 E2（缺口/倒退）与 S9（文件物理序回退）判红：删行不重编号 = 缺口 ⇒ E2；自造/回放旧光标 = 与光标不连续或物理序回退 ⇒ E2/S9。离线单看一行无法知道 seq 是谁写的，故文件侧判据是"连续性/物理序"这条可判下界。

### Z3 — 空会话文件（有 header 无事件）显式报出

- **层级**: framing ｜ **严重度**: warning
- **出处**: 实测 2026-09-09 T3（36 条规则全来自有内容事故,空态无覆盖）
- **契约**: 有 header 但零事件 = 异常空会话（新建即空或写入未落盘）。空态不在任何有内容规则的覆盖下,显式 warning 供人判断。**与文件版本无关**：v0–v4 一律判（v4 空壳同样报 Z3）；0 字节/无 header 的空文件另由 H1 判（首行不可解析）+ tailStatus=unknown。

### P3 — tool/call ↔ tool/result 配对完整性（考古 B1）

- **层级**: plugin ｜ **严重度**: warning
- **出处**: 考古方法 §2/§4.2（callId 配对，不可用"上一个 call"推断）
- **契约**: 每个 tool/call 的 data.callId 必须能在 tool/result 的 data.message.source.callId 中找到配对；孤儿 call（无 result）告警——中断/失败轮次可能产生孤儿（合法但要审计），考古提取将缺该输出。

### P4 — tool/result 输出结构可解析（考古 B2）

- **层级**: plugin ｜ **严重度**: warning
- **出处**: 考古方法 §2/§4.2（content 递归 text 结构）
- **契约**: tool/result 的 data.message.content 必须可递归解析（list[dict{type:text,text}] 或等价）；不可解析片段 = 考古提取将漏数据。空 content（失败/无输出）合法。

### M1 — turn/step 为 null 的 assistant/message 只能 replace，不能 append

- **层级**: engine ｜ **严重度**: error
- **出处**: 复盘事故第 2 次尝试（rt.js:6816 崩溃）；实证 data.turn/data.step：正常消息为数字、插件 marker 为 null
- **契约**: data.turn/data.step 为 null 的 assistant/message（如插件 marker）只能以 replace 承载（走插件 marker 定义）；作为 append 会落进核心 assistant-step 定义，因 turn=null 发布 location data 导致客户端引擎崩溃。

### P1 — marker id 前缀必须被识别

- **层级**: plugin ｜ **严重度**: warning
- **出处**: retrace 插件 RENAME RULE（lib/client.js:29-44）；复盘事故
- **契约**: assistant/message 替换事件的 message.id 以 retrace- / message-editor- 为已知前缀。未知前缀 = 改名后未登记遗留前缀，旧 marker 的隐藏语义会断裂（软兼容丢失）。

### P2 — marker 自身 seq 不得出现在自身 shadowed 集

- **层级**: plugin ｜ **严重度**: error
- **出处**: retrace 插件 lib/client.js:393（"event and never a surface node"）
- **契约**: marker 的 sourceEventSeqs（= shadowedSeqs，驱动 CSS 隐藏）不得包含 marker 自身 seq——marker 节点由隐藏逻辑跳过，出现在 shadowed 集属于自指语义错误。

### P5 — carrier 两段配对：第 2 段 sourceEventSeqs 首元素 = 第 1 段（审计段）seq

- **层级**: plugin ｜ **严重度**: error
- **出处**: 仓库既有两段载体形状（test/semantics-v4.test.js:108-121：`compaction/prune` 审计段 + `user/message` replace 载体）；2026-10-20 本机实测 760 份真实 v3/v4：884 个载体按现役写法（审计段 seq 在 `sourceEventSeqs[0]`，全部 user/message）；另有 1,519 个载体按**早期写法**（首元素 = 区间起点、不引用审计段 seq；user/message 1,022 + tool/result 497）⇒ 读侧必须两种都认；对照官方 compaction 的 `compaction/summary` 引用是另一形状（`[compaction/start, compaction/summary, …]`，15 例），不属本条
- **契约**: 两段载体（第 1 段 = `compaction/prune` 审计段，带 `data.shadowedRange`/`shadowedSeqs`；第 2 段 = 紧随其后的 surface replace 载体）的配对规则：第 2 段 `sourceEventSeqs[0]` 必须等于第 1 段的 seq（现役写法），其余元素覆盖被遮蔽节点。**读侧容错（两种写法都认）**：① 现役 `[审计段 seq, ...被遮蔽节点]`；② 早期 `[区间起点, ...被遮蔽节点]`（不引用审计段 seq——实测真实语料 1,519 个载体即此写法，若判红会全成"孤儿"）。只有"审计段 seq 在中间位且首元素既非审计段也非区间起点"、或"紧邻审计段却既不引用它、首元素也不是区间起点"才报 error。**写侧**（prewrite）按现役写法严格校验：拟写载体若紧邻审计段，`sourceEventSeqs[0]` 必须是该审计段 seq，否则拒绝（早期写法在写侧被要求升级）。

### C1 — seq 缺口/倒退提示多写入者

- **层级**: concurrency ｜ **严重度**: warning
- **出处**: dsh-session-persistence-jsonl appendLines 无锁（:1200-1227），全仓无会话级排他锁
- **契约**: 离线体检无法直接观测跨进程竞态，但 E2 暴露的缺口/倒退即是"≥2 个 Host 进程共享同一 session 目录并发写"的后果。单实例部署不触发。

### Z1 — zstd 尾帧撕裂

- **层级**: framing ｜ **严重度**: warning
- **出处**: zstd 帧布局（dsh-session-persistence-jsonl 多帧）
- **契约**: 尾帧不完整（torn）：可能正在写入（in-flight）或文件被截断。若这是唯一异常，通常可等待写入完成；若持续存在则是截断证据。

### Z2 — zstd 帧解码失败 = 单帧全损

- **层级**: framing ｜ **严重度**: error
- **出处**: 多帧单帧全损 → 整会话不可读
- **契约**: 任一帧解码失败（磁盘 bitrot / 传输截断 / 并发写撕裂）即整会话不可读；帧越多，单帧损坏下丢失概率线性上升。

### Z4 — 首帧必须恰好一行 header

- **层级**: framing ｜ **严重度**: error
- **出处**: 宿主 assertZstdHeaderFrame（0.1.5-rc.2 lib/index.js:2184）：首帧非"恰好一行"即抛
- **契约**: 官方写盘形状是 header **独占第一帧**。首帧装多行时宿主抛错，且抛点在 listArtifacts **遍历全库**、无 per-session 容错 ⇒ **整个客户端起不来**（2026-09-16 真机事故：有人把整份日志重压成单帧写回）。

### Z5 — 多行日志不得压成单帧

- **层级**: framing ｜ **严重度**: error
- **出处**: 官方形状：header 第一帧 + 事件批次逐帧追加
- **契约**: 把整份日志重压成 1 帧会同时触发 Z4；任何"重写会话"的路径都必须**保形**（逐帧解、逐帧回写，或走宿主写入器），不得整体重压缩。

### Z6 — 尾部完整性必须显式声明（tailStatus: complete|truncated|interrupted|unknown）

- **层级**: framing ｜ **严重度**: warning
- **出处**: 2026-10 实测口径边界：体检只保证"已读到的事件自洽"，最后一帧被切掉仍可能 ok=true；判定实现见 lib/log-reader.js deriveTailStatus（与宿主 readZstdPrefix"保留完整记录、丢弃未写完尾帧"语义对齐）
- **契约**: 每次体检必须给出机器可判的 `tailStatus`（`complete` 尾部完整｜`interrupted` zstd 尾帧撕裂=写入中断/进行中，宿主可恢复｜`truncated` 末行记录被切断｜`unknown` 帧解码失败/空文件/不可读）。**口径边界**：`ok=true` 只保证"已读到的事件自洽"，**不保证尾部完整**——判读尾部请用 `check --json` 的 `summary.tailStatus`（库级 `validateSessionLog()` 返回值另有顶层 `tailStatus`）。非 complete 时显式报 warning（⛔ 不翻转 ok：撕裂尾帧在宿主读取器语义下是可恢复的边写边读态，见 Z1；真损坏由 Z2/R1 判 error）。离线无法区分"写入中被读到"与"写完前进程中断"（字节形态相同）⇒ 都归 `interrupted`。

### W1 — wire 流：tool 消息必须跟在带 tool-call 的 assistant 消息之后

- **层级**: engine ｜ **严重度**: error
- **出处**: 2026-08-27 实锤：MiMo 等严格端点对悬空 tool 直接 INVALID_REQUEST（Messages with role "tool" must be a response to a preceding message with "tool_calls"）；marker 遮蔽 assistant(tool_calls) 而未盖住 tool/result、或中断回合重放重复 tool/result 写在 marker 之后都会产生
- **契约**: 按 surface 折叠顺序展开 wire 消息流：每个 role=tool 消息必须消费一个仍未满足的 assistant tool-call；不足 = 悬空（provider 拒绝）。常见来源：marker 范围漏盖 tool/result、重放重复事件。

### W2 — wire 流：user 文本不得插在 tool_calls 与其 tool 结果之间

- **层级**: engine ｜ **严重度**: error
- **出处**: OpenAI 兼容端点对 tool 消息顺序的严格校验；DSH 序列化器将混合 user 消息展开为 text 在前、tool-result 在后
- **契约**: 当仍有未满足的 assistant tool-call 时出现 user 文本消息，会产生 [assistant(tool_calls), user(text), tool] 序列，严格端点同样拒绝。

### G1 — 迁移预检：v0 源文件的 subagent/descriptor.data.version 必须为 3

- **层级**: migration ｜ **严重度**: warning
- **出处**: @deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:1584-1586（assertReleasedEventPayload）：data.version !== 3 且源版本 === 0 → SessionFormatUnsupportedMigrationError("uses unsupported descriptor version N")；源版本 1/2 时官方提前 return（容忍）
- **契约**: 文件版本 0 且事件类型为 subagent/descriptor 且 data.version !== 3 → 官方 v0→v1 迁移直接拒绝（消息形如 `subagent/descriptor <seq> uses unsupported descriptor version 2`）；源版本 1/2 不受此条约束。

### G2 — 迁移预检：v0 源文件不得含词表外的历史事件类型（含 ignorable）

- **层级**: migration ｜ **严重度**: warning
- **出处**: @deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:1580-1583（assertReleasedEventPayload）：RELEASED_V0_EVENT_DISPOSITIONS 里没有该 type → "format v0 contains unknown historical event type … migration refuses unknown historical events even when ignorable"
- **契约**: 文件版本 0 且事件 type 不在官方 v0 dispositions（本包 vendored 为 V0_EVENT_TYPES）内 → 官方迁移拒绝，**即使该事件带 ignorable:true**。E3 的 ignorable 豁免是**读取路径**语义（不改），本条只在迁移预检维度表达。

### G3 — 迁移预检：v0 源 session/title 系列的 messageSeqs 必须引用更早的人类 user/message

- **层级**: migration ｜ **严重度**: warning
- **出处**: @deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:2543-2556（assertTitleSources）：`session/title` 的 messageSeqs 为空 ⟺ source.kind === "user"；每个被引 seq 必须解析到 `user/message` 且其 `data.source.kind === "user"`，否则 "messageSeqs must cite earlier human user/message events" / "must be empty exactly for a user title"
- **契约**: 文件版本 0 且事件为 session/title 或 session/title-llm-request：messageSeqs 必须是数组；session/title 的"空数组 ⟺ 用户标题"必须成立；每个被引 seq 必须是更早的 user/message 且 source.kind === "user"。违反 → 官方升级到当前格式时拒绝。**应用面说明**：官方 `assertTitleSources` 与 turn/start 状态机同在 `assertReleasedArtifactRelationships`，由 v1→v2 在**变换后的 v1/v2 artifact** 上调用（`dsh-session-format-v1-to-v2/lib/index.js:104`）；对 messageSeqs 这类按 seq 索引 + 类型/source 判定的引用，变换保序保类型 ⇒ 在原始 v0 上判是必要条件的近似，实测 281 真实 v0 上 0 误报。

### G4 — 未知历史事件声明式可忽略（ignorable:true + 白名单）——迁移不得硬拒

- **层级**: migration ｜ **严重度**: warning
- **出处**: @deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2 package/lib/index.js:1513-1535（assertReleasedArtifactCoordinates：`ignorableCurrent` 分支只在 allowLegacySteering=false 时生效；:1531 原文 "migration refuses unknown historical events even when ignorable"）、同处 `vocabularyNeutral` 参数（"whether unknown event types remain opaque"，未知类型按不透明事件保留的策略）
- **契约**: 未知历史事件（不在本包 vendored v0 词表内）若带信封级 `ignorable:true`，契约层按**声明式可忽略**处置：允许按声明丢弃并登记为 `acceptedDrop`，**不得**让整条迁移硬拒（这正是"每新增一类插件事件就卡死整条迁移"的根因）。消费者白名单可注入：`opts.ignorableWhitelist` / `createPreWriter({ignorableWhitelist})` / 环境变量 `DSH_LOG_CONTRACT_IGNORABLE_WHITELIST`（逗号分隔；元素为精确 type 或以 `/` 结尾的前缀），默认 = 已知插件消费者 `retrace/`、`message-editor/`。**未登记**的未知 ignorable 事件仍报 G4 warning（⛔ 不静默），且保持迁移阻断。G2 仍**原样保留**为"官方 v0→v1 会拒"的事实预检，不放宽；本规则只把"已声明可忽略且已登记"的事件从迁移阻断移入 `acceptedDrops`。实测：本机 2 份真实 v0 化石含 `retrace/goal-marker`（ignorable），默认白名单命中 ⇒ acceptedDrops，迁移不再被它阻断。

### A1 — 在位可还原只认结构化归档指针（archiveRef / archive / externalized.*）

- **层级**: archive ｜ **严重度**: error
- **出处**: 归档指针口径的外部实测（2026-10-20）：只认 `archiveRef`/`archive`/`externalized.*`，⛔ 不得从自由文本 grep 路径；两版文本口径实测全错（原版 78.26%、只认绝对路径 2.04%）；本机 763 份真实会话实测：结构化指针 273,571 个 → 按（目标,行）去重后 271,538 条记录，**可还原 271,538（100%）**、真实落空 0、行缺失 0、sha 不符 0；同批数据自由文本 `archive 第 N 行` 出现在 144,391 个事件里（口径差近 20 倍）
- **契约**: 外置内容的"在位可还原"判定**只**从结构化字段取指针：`data.archiveRef` / `data.archive` / `data.externalized.archiveRef` / `data.externalized.archive`（校验元数据取同级 `archiveLine`/`sha256`）；⛔ **永不**从 `content`/`pointer`/散文模板等自由文本 grep 路径（实测两版全错：模板/示例会被算成引用，真实路径示例又被误计）。判据：目标文件存在 + `archiveLine` 行存在 + `sha256` 匹配 = 在位可还原；目标缺失/行缺失/sha 不符 = error；绝对路径失效但同名归档在归档根可解析 = `relocated` warning（re-home 未回写）。**按记录去重**：同一事件同时带 `archiveRef`(basename) 与 `archive`(绝对路径) 时按（目标,行）算一条记录——本机 2,033 个双字段指针即此类（其中 `/tmp` 绝对路径已失效者由 `archiveRef` 解析回 history 根，故真实落空 0，而不是把工具限制或旧路径算成内容缺失）。**独立维度**：需要归档根目录才能评估（`opts.archiveRoots` / `check --archive-root DIR`），未提供时结论为 `unverifiable`（不冒充通过，也不产生违规）。启用本维度后，真实缺失/行缺失/sha 不符是 **error**（红判据：在位可还原须 100%），会进 `ok` 与三档结论；`relocated` 只是 warning。

