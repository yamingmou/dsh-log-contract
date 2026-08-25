# 契约规则目录（CONTRACTS）

> DSH 会话日志契约的**可执行 spec**。每条规则在 `lib/checks.js`（逐事件判定）
> 与 `lib/prewrite.js`（写前校验）中有对应实现；离线体检（`lib/validate.js`）
> 逐条执行并在最后用官方 `foldSurface` 终验（S8）。
>
> 规则来源：`dsh-scale-audit-疑点记录.md`（59 条审计发现）+ `复盘-会话修复事故-20260825.md`
> （三层契约）+ `@deepseek-ai/dsh-session@0.1.0-rc.7` 官方源码逐行核对。
>
> 严重度：**error** = 违反即会话不可加载/写入被拒（fail-loud）；**warning** = 合法但可疑。

## 规则索引

| id | 严重度 | 层级 | 规则 |
|---|---|---|---|
| H1 | error | persistence | 首行为合法 JSON 且 type=session |
| H2 | error | persistence | header 版本与必填字段 |
| R1 | error | persistence | 每行必须是合法 JSON |
| R2 | error | persistence | chunk 行必须满足精确信封形状 |
| R3 | error | persistence | chunk 行展开后成员 seq/time 安全 |
| E1 | error | persistence | 每个事件携带非负安全整数 seq |
| E2 | error | persistence | seq 严格连续（单写入者假设） |
| E3 | error | persistence | type 必须在已知词汇表内（或带 ignorable 标记） |
| E4 | error | persistence | data 与 surface 元数据必须 JSON 无损 |
| E5 | error | persistence | 禁用遗留词汇 |
| E6 | error | persistence | 消息类事件消息形状 |
| S1 | error | persistence | surface 候选类型必须携带 surfaceOp |
| S2 | error | persistence | 非 surface 类型不得携带 surface 元数据 |
| S3 | error | persistence | append 的 sourceEventSeqs 契约 |
| S4 | error | persistence | replace 操作数与范围合法性 |
| S5 | error | persistence | ★ replace 的 sourceEventSeqs 必须完整覆盖被替换节点 |
| S6 | error | persistence | sourceEventSeqs 自身约束 |
| S7 | error | persistence | tool/result 替换仅允许单节点内容改写 |
| S8 | error | persistence | 整日志 foldSurface 可重放（终验） |
| M1 | error | engine | turn/step 为 null 的 assistant/message 只能 replace，不能 append |
| P1 | warning | plugin | marker id 前缀必须被识别 |
| P2 | error | plugin | marker 自身 seq 不得出现在自身 shadowed 集 |
| C1 | warning | concurrency | seq 缺口/倒退提示多写入者 |
| Z1 | warning | framing | zstd 尾帧撕裂 |
| Z2 | error | framing | zstd 帧解码失败 = 单帧全损 |

## 详细规则

### H1 — 首行为合法 JSON 且 type=session

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1109-1126 (validateSessionHeader)
- **契约**: 会话日志首行必须是可 JSON.parse 的对象，且 type 为 "session"。首行损坏 = 整个会话不可读。

### H2 — header 版本与必填字段

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1110-1125
- **契约**: header.version 必须为 0；id 为字符串；createdAt 为非负安全整数；cwd 若存在必须为绝对路径；origin 只能为 "subagent"。

### R1 — 每行必须是合法 JSON

- **层级**: persistence ｜ **严重度**: error
- **出处**: 审计方法论（scan-seq-gaps.mjs）；dsh-session-persistence-jsonl 读路径
- **契约**: 非空行无法 JSON.parse = 损坏行。帧边界产生的空行是合法的（跳过）。

### R2 — chunk 行必须满足精确信封形状

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:922-971 (validateRow)
- **契约**: text-chunks / reasoning-chunks / tool-call-chunks 行必须精确为 {type, seq0, time0, data}，data 精确为 {turn, step, index, dt, texts|args}。损坏 = 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）。

### R3 — chunk 行展开后成员 seq/time 安全

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:964-969
- **契约**: 展开后成员 seq 与 time 必须保持安全整数（seq0+len-1 与逐 gap 累加的 time 不溢出）。

### E1 — 每个事件携带非负安全整数 seq

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:295-298 (isEventSeq)、:1453-1459 (append 信封)
- **契约**: 事件信封为 {type, seq, time, data, ...surfaceMetadata}；seq 必须是非负安全整数。

### E2 — seq 严格连续（单写入者假设）

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:398 (planSurfaceEvent "not contiguous")；审计 S2/N6
- **契约**: seq 必须从 0（或窗口 baseSeq）严格连续递增。缺口/倒退 = 违反单写入者假设（多实例共享存储并发写的痕迹），加载时直接 throw。

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
- **契约**: request/header-delta 与 reason=fallback 的 request/header 是已删除的遗留格式，写入即被拒。

### E6 — 消息类事件消息形状

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:1242-1266 (assertMessageEventShape)
- **契约**: user/message、assistant/message、tool/result 必须携带具名 message（非空 id、正确 role、合法 source、content 数组；assistant 需 model source，tool/result 需 tool source 且 toolCallId 匹配）。

### S1 — surface 候选类型必须携带 surfaceOp

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:312-317 (surfaceOpOf)
- **契约**: user/message、assistant/message、tool/result 是 surface-eligible 类型，缺 surfaceOp 即违反契约。

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
- **契约**: replace 必须是精确的 {op:"replace", start, end}；start/end 必须存在于当前 surface 节点且 startIdx ≤ endIdx。

### S5 — replace 的 sourceEventSeqs 必须完整覆盖被替换节点

- **层级**: persistence ｜ **严重度**: error
- **出处**: @deepseek-ai/dsh-session lib/index.js:335-336 (assertProvenance)；复盘事故第 1 轮
- **契约**: ★ 写前校验核心规则：sourceEventSeqs 必须包含每一个被替换（shadowed）的 surface 节点，缺一个 = 会话加载被拒（SessionPersistenceCorruptionError）。2026-08-25 事故第 1 轮（清空 sourceEventSeqs）正是违反此规则。

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
- **出处**: @deepseek-ai/dsh-session lib/index.js:444-455 (foldSurface)；复盘"官方 foldSurface 不抛 = 通过"
- **契约**: 终验：把全部事件按序喂给官方 foldSurface，不抛 = 持久化层通过。S1–S7 任何一条违反都会在此暴露。

### M1 — turn/step 为 null 的 assistant/message 只能 replace，不能 append

- **层级**: engine ｜ **严重度**: error
- **出处**: 复盘事故第 2 轮（rt.js:6816 崩溃）；实证 data.turn/data.step：正常消息为数字、插件 marker 为 null
- **契约**: data.turn/data.step 为 null 的 assistant/message（如插件 marker）只能以 replace 承载（走插件 marker 定义）；作为 append 会落进核心 assistant-step 定义，因 turn=null 发布 location data 导致客户端引擎崩溃。

### P1 — marker id 前缀必须被识别

- **层级**: plugin ｜ **严重度**: warning
- **出处**: retrace 插件 RENAME RULE（lib/client.js:29-44）；复盘事故
- **契约**: assistant/message 替换事件的 message.id 以 retrace- / message-editor- 为已知前缀。未知前缀 = 改名后未登记遗留前缀，旧 marker 的隐藏语义会断裂（软兼容丢失）。

### P2 — marker 自身 seq 不得出现在自身 shadowed 集

- **层级**: plugin ｜ **严重度**: error
- **出处**: retrace 插件 lib/client.js:393（"event and never a surface node"）
- **契约**: marker 的 sourceEventSeqs（= shadowedSeqs，驱动 CSS 隐藏）不得包含 marker 自身 seq——marker 节点由隐藏逻辑跳过，出现在 shadowed 集属于自指语义错误。

### C1 — seq 缺口/倒退提示多写入者

- **层级**: concurrency ｜ **严重度**: warning
- **出处**: 审计 N6：dsh-session-persistence-jsonl appendLines 无锁（:1200-1227），全仓无会话级排他锁
- **契约**: 离线体检无法直接观测跨进程竞态，但 E2 暴露的缺口/倒退即是"≥2 个 Host 进程共享同一 session 目录并发写"的后果。单实例部署不触发。

### Z1 — zstd 尾帧撕裂

- **层级**: framing ｜ **严重度**: warning
- **出处**: 审计 N5 相关；帧扫描方法论
- **契约**: 尾帧不完整（torn）：可能正在写入（in-flight）或文件被截断。若这是唯一异常，通常可等待写入完成；若持续存在则是截断证据。

### Z2 — zstd 帧解码失败 = 单帧全损

- **层级**: framing ｜ **严重度**: error
- **出处**: 审计 N5：多帧单帧全损 → 整会话不可读
- **契约**: 任一帧解码失败（磁盘 bitrot / 传输截断 / 并发写撕裂）即整会话不可读；帧越多，单帧损坏下丢失概率线性上升。

---

## 边界说明（诚实声明）

1. **本工具守护"持久化契约层"**。`#3632` 的"one log, two consumers, two verdicts"中，
   `agent/inbox/spliced` 孤儿在持久化层**是合法的**（官方 `foldSurface` 可通过）——
   违规发生在**消费路径**（`sessionQuery`/UI 判不可读）。本工具的 `check` 会如实报 PASS，
   不冒充能判消费路径契约；该层契约属另一类问题（可配合 dsh-retrace / 上游修复）。
2. **M1 是引擎层启发式规则**：`data.turn/step` 为 null 的 `assistant/message` 以 append 进入
   surface 会触发客户端引擎崩溃（rt.js:6816）——依据是 2026-08-25 事故第 2 轮实证。
   离线场景无法渲染客户端，故以 error 级保守拦截，避免事故重演。
3. **写前校验以"官方 foldSurface 不抛"为最终权威**：逐事件归因（S1–S7）负责定位，
   官方重放（S8）负责背书；两套都绿才算通过。若官方实现更新导致判定漂移，
   以官方为准并更新本 spec（本工具自己就是契约漂移的哨兵）。
4. **seq 严格连续是单写入者假设**（N6）：离线 `check` 只能看到缺口/倒退的结果，
   无法观测竞态本身；`C1` 给出解释性告警而非臆断。
