/**
 * dsh-log-contract · lib/contracts.js
 *
 * DSH 会话日志契约规则目录（spec）。
 *
 * 规则集来源：
 * - 历史会话日志的实测事故与契约缺口（持久化 / 客户端引擎 / 插件语义三层）
 * - `@deepseek-ai/dsh-session@0.1.0-rc.7` 官方源码逐行核对（见每条 `source`）
 *
 * 每条规则只描述"契约是什么"；具体判定逻辑在 `lib/validate.js`（离线体检）
 * 与 `lib/prewrite.js`（写前校验）中按 id 实现。severity：
 * - error   —— 违反即会话不可加载 / 写入会被拒（fail-loud）
 * - warning —— 合法但可疑（撕裂尾帧、未知 marker 前缀等）
 * - info    —— 事实性观察（压缩统计等）
 */

export const LAYER = {
  PERSISTENCE: 'persistence', // 持久化层：日志能被官方解码器完整重放
  ENGINE: 'engine', // 客户端引擎层：事件形状匹配客户端定义
  PLUGIN: 'plugin', // 插件语义层：marker 隐藏语义
  CONCURRENCY: 'concurrency', // 并发/写入者假设
  FRAMING: 'framing', // zstd 帧结构
  MIGRATION: 'migration', // 迁移预检层：官方 v0/v1/v2 → 当前格式的升级路径会不会拒（**独立维度**）
};

export const SEVERITY = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

/**
 * 契约规则目录。id 前缀：
 * - H  header / 会话头
 * - R  存储行 / chunk 行
 * - E  事件信封 / seq / type 词汇表
 * - S  surface（模型可见面）不变量 —— 事故核心层
 * - M  客户端引擎层
 * - P  插件 marker 语义层
 * - C  并发 / 写入者假设
 * - Z  zstd 帧结构
 * - G  迁移预检（migration gate，**独立维度**：官方迁移会不会拒；不进 ok/verdict）
 */
/**
 * （2026-09-14 实测）——**机读的漂移/未复核标注**。
 *
 * 核对结论：规则的 `source` 大量停在 `@deepseek-ai/dsh-session@0.1.0-rc.7` 的行号上，
 * 且其中 4 条（T2/P1/P2/C1）的**判定前提**在真宿主 0.1.5 上已不成立——此前**没有任何机制
 * 能发现**（`source` 只是人读字符串）。这里把它们变成机读字段，并由 `check` 抬头点名。
 */
export const SOURCE_DRIFT = Object.freeze({
  /** 出处停在 rc.7 行号、未在 0.1.5 上复核（清单见下）。 */
  drifted: Object.freeze(['T2', 'P1', 'P2', 'C1', 'I1', 'G3', 'R2', 'R3', 'E5', 'E6']),
  /**
   * **判定前提在 0.1.5 上不成立/无法判定**：
   * T2 token-meter 已改从 `event.data.stream` 重建（无 sourceEventSeqs/无 belongs to another step）；
   * P1/P2 载体已换成 `user/message + data.id`（无 data.editor）；C1 前提"无会话级排他锁"被
   * `session.lock` flock 租约证伪；T3/T4 半步需真机实验。⇒ 这些规则的结论**不可单独采信**。
   */
  premiseStale: Object.freeze(['T2', 'P1', 'P2', 'C1']),
  /** 明确"无法判定"、需要真机实验的条目（列出来是为了不假装覆盖）。 */
  undecidable: Object.freeze(['T3', 'T4']),
  note: '出处/前提漂移是**静默失真**：行为探针（lib/host-probes.js）负责机器可判的那部分，'
    + '其余在此显式列出，结论抬头必须带漂移清单与未复核清单。',
});

export const CONTRACT_RULES = [
  // ── H · header ──────────────────────────────────────────────────────────
  {
    id: 'H1',
    title: '首行为合法 JSON 且 type=session',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1109-1126 (validateSessionHeader)',
    description: '会话日志首行必须是可 JSON.parse 的对象，且 type 为 "session"。首行损坏 = 整个会话不可读。',
  },
  {
    id: 'H2',
    title: 'header 版本与必填字段',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1110-1125；已知格式版本 0/1/2/3（App 2.0.9 内置 v0→v1→v2→v3 迁移，SESSION_FORMAT_VERSION=3）',
    description: 'header.version 必须为已知受支持版本（0/1/2/3）；未知版本报 H2。id 为字符串；createdAt 为非负安全整数；cwd 若存在必须为绝对路径；origin 只能为 "subagent"。',
  },

  // ── R · 存储行 ──────────────────────────────────────────────────────────
  {
    id: 'R1',
    title: '每行必须是合法 JSON',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: 'seq 缺口扫描；dsh-session-persistence-jsonl 读路径',
    description: '非空行无法 JSON.parse = 损坏行。帧边界产生的空行是合法的（跳过）。',
  },
  {
    id: 'R2',
    sourceVerified: false,
    title: 'chunk 行必须满足精确信封形状',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:922-971 (validateRow)',
    description: 'text-chunks / reasoning-chunks / tool-call-chunks 行必须精确为 {type, seq0, time0, data}，data 精确为 {turn, step, index, dt, texts|args}。损坏 = 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）。',
  },
  {
    id: 'R3',
    sourceVerified: false,
    title: 'chunk 行展开后成员 seq/time 安全',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:964-969',
    description: '展开后成员 seq 与 time 必须保持安全整数（seq0+len-1 与逐 gap 累加的 time 不溢出）。',
  },

  // ── E · 事件信封 ────────────────────────────────────────────────────────
  {
    id: 'E1',
    title: '每个事件携带非负安全整数 seq',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:295-298 (isEventSeq)、:1453-1459 (append 信封)',
    description: '事件信封为 {type, seq, time, data, ...surfaceMetadata}；seq 必须是非负安全整数。',
  },
  {
    id: 'E2',
    title: 'seq 严格连续（单写入者假设）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:398 (planSurfaceEvent "not contiguous")',
    description: 'seq 必须从 0（或窗口 baseSeq）严格连续递增。缺口/倒退 = 违反单写入者假设（多实例共享存储并发写的痕迹），加载时直接 throw。',
  },
  {
    id: 'S9',
    title: '文件物理序 seq 单调（多写入者交织现场特征）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '2026-08-28 实锤（某真实会话）：文件物理序出现回退（大→小→更大）；单进程 appendCore 断言 seq==cursor+i 且按 id 串行化不可能写出',
    description: '按文件物理行序要求展开后事件 seq 严格单调递增。E2 在排序后检查（loadSessionLog 会 sort），物理序倒退被掩盖；S9 在排序前按行序检查，非单调 = 多写入者/旧光标回放交织的直接现场证据，加载会被拒。',
  },
  {
    id: 'I1',
    sourceVerified: false,
    title: 'inbox seed 相对重放（fork 边界孤儿 spliced）',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-agent lib/types/inbox.js:155-178 (apply/validate)；2026-08-28 实锤（某两个真实会话）：fork 边界 removedCount=1 孤儿',
    description: '从 header.seedLength 起重放 agent/inbox/spliced，next-turn/next-step 双队列；start+removedCount 不得超过队列长、不得产生重复 pending id。fork 时"移除父待处理提示词"的 splice 假设父会话 inbox，子会话 seed 相对空 inbox 上非法 → resume 被拒（invalid persisted inbox splice）。',
  },
  {
    id: 'E3',
    title: 'type 必须在已知词汇表内（或带 ignorable 标记）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1046-1049 (KNOWN_SESSION_EVENT_TYPES 注释)',
    description: '词汇表外的 type 会被持久化读路径拒绝，除非事件带信封级 ignorable 标记（新版本 harness 写入的日志）。插件事件（如 retrace marker 以 assistant/message 承载）不在词汇表外——它们复用核心类型。',
  },
  {
    id: 'E4',
    title: 'data 与 surface 元数据必须 JSON 无损',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1446-1450 (snapshotJsonValue 双快照)',
    description: 'append 热路径对 data 与 surfaceMetadata 各做一次 lossless-JSON 全量校验；非 JSON 安全值（函数/循环引用/非有限数）写入前即被拒。',
  },
  {
    id: 'E5',
    sourceVerified: false,
    title: '禁用遗留词汇',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1273-1277 (assertSupportedRequestHeader)',
    description: 'request/header-delta 与 reason=fallback 的 request/header 是已删除的遗留格式。注意（订正 E5）：宿主 Session.append/appendLines 不看 type ⇒ 写入会成功、下一次读取才炸（依据 dsh-session@0.1.5-rc.1 lib/index.js:1170-1210 / persistence-jsonl:3046-3073），不是写入即被拒。',
  },
  {
    id: 'E6',
    sourceVerified: false,
    title: '消息类事件消息形状',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1242-1266 (assertMessageEventShape)',
    description: 'user/message、assistant/message、tool/result 必须携带具名 message（非空 id、正确 role、合法 source、content 数组；assistant 需 model source，tool/result 需 tool source 且 toolCallId 匹配）。',
  },

  // ── S · surface 不变量（事故核心层）────────────────────────────────────
  {
    id: 'S1',
    title: 'surface 候选类型必须携带 surfaceOp',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:312-317 (surfaceOpOf)',
    description: 'user/message、assistant/message、tool/result 是 surface-eligible 类型，缺 surfaceOp 即违反契约。',
  },
  {
    id: 'S2',
    title: '非 surface 类型不得携带 surface 元数据',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:307-311 (surfaceOpOf)',
    description: '词汇表内非 surface-eligible 类型带 surfaceOp / sourceEventSeqs = 违反契约。',
  },
  {
    id: 'S3',
    title: 'append 的 sourceEventSeqs 契约',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:401-407、:320-337 (assertProvenance)',
    description: 'append 以空 shadowed 集校验：sourceEventSeqs 若携带必须满足 assertProvenance（数组、无重复、全部引用更早事件）；任何违规即写入被拒。',
  },
  {
    id: 'S4',
    title: 'replace 操作数与范围合法性',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:300-303 (isReplaceOp)、:339-350 (replacementRange)',
    description: 'replace 必须是精确的 {op:"replace", start, end}；start/end 必须存在于当前 surface 节点且 startIdx ≤ endIdx。',
  },
  {
    id: 'S5',
    title: 'replace 的 sourceEventSeqs 必须完整覆盖被替换节点',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:335-336 (assertProvenance)；复盘事故第 1 次尝试',
    description: '★ 写前校验核心规则：sourceEventSeqs 必须包含每一个被替换（shadowed）的 surface 节点，缺一个 = 会话加载被拒（SessionPersistenceCorruptionError）。2026-08-25 事故第 1 次尝试（清空 sourceEventSeqs）正是违反此规则。',
  },
  {
    id: 'S6',
    title: 'sourceEventSeqs 自身约束',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:320-333 (assertProvenance)',
    description: 'sourceEventSeqs 存在时必须为数组、无重复、全部引用更早事件（< 当前 seq），且除 assistant/message 外不得为空。',
  },
  {
    id: 'S7',
    title: 'tool/result 替换仅允许单节点内容改写',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:369-395 (assertToolResultRewrite)',
    description: 'tool/result 的 replace 必须恰好重写 1 个当前节点、目标是 tool/result，且除 message.content 外不得改动任何字段。',
  },
  {
    id: 'S8',
    title: '整日志 foldSurface 可重放',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:444-455 (foldSurface, v3)；v0/v1/v2 用本地等价实现 lib/legacy-fold.js（rc.7 lib/index.js:229-455 逐条移植）',
    description: '终验：按被检文件 header.version 选折叠器（v3 → 官方 foldSurface；v0/v1/v2 → 本地 legacyFoldSurface），不抛 = 持久化层通过。S1–S7 任何一条违反都会在此暴露。注意 0.1.5 的官方 foldSurface 是 v3 语义（replace 用 startSeq/endSeq、assistant/message 禁 sourceEventSeqs），对旧格式文件会误报，不可借用。',
  },

  {
    id: 'T1',
    title: 'token-meter 配对：assistant/message 与 step/end 必须匹配当前打开的 step/start',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-token-meter lib/index.js:566-625 (_foldEvent)',
    description: 'token meter 折叠要求 assistant/message 与 step/end 与打开的 step/start（turn/step 完全一致）匹配；违反即 /compact 与压力测量永久失败。retrace 的 turn-null 编辑/撤回 marker（空 assistant/message replace）命中此条——foldSurface 认可其合法性但 token meter 崩溃（M1 只约束 append 形态的盲区），压缩前需清理。',
  },
  {
    id: 'T2',
    premiseStale: true,
    sourceVerified: false,
    title: 'token-meter 源引用：assistant/message 的 sourceEventSeqs 引用的 chunk 必须同 turn/step',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-token-meter lib/index.js:634-650 (_estimateProviderAssistant，:645 belongs to another step)',
    description: 'token meter 重建 provider 输出时，逐条检查 assistant/message 的 sourceEventSeqs：指向 assistant/chunk 的引用必须与消息同 turn/step，且 seq 更早、不重复；跨 step 引用 → 官方抛 belongs to another step → 每次事件追加都重抛（consumedEvents 不前进）→ 刷屏压垮 host（2026-08-30 实测：某真实会话的 chunk 源引用跨 step 7/8/9）。T1 只查 step 配对不查源引用，此条补盲区；修复用 fix --clip-crossstep。',
  },
  {
    id: 'T3',
    title: 'step 节点 key 唯一（同 turn 内 step/start 的 step 号不得复用）',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '复盘 2026-09-02 渲染层白屏事故：客户端渲染节点 key = turn:step，冲突 → React 渲染死循环（由离线自查脚本判出）',
    description: '客户端渲染消息列表从事件流构建节点，节点 key = data.turn:data.step。同 turn 内两个 step/start 的 step 号相同 → key 冲突 → React 渲染死循环 → 白屏/不展示（实测：同一 turn 内两个 step/start 复用 step 95/1，一个来自正常轮、一个来自编辑块；后续全量扫描又发现多个同型冲突）。修复：同 turn 内 step 递增、整块重编号（含块内 chunk/tool/assistant）。',
  },
  {
    id: 'T4',
    title: 'step/消息本体 turn 缺失（null/undefined）→ 渲染死循环',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '复盘 2026-09-01 D8 事故：retrace 0.4.17 编辑块 turn:null（离线自查脚本判致命）',
    description: '客户端渲染状态机对 turn=null 的 step/start|step/end|assistant/message 无法归属任何 turn → 渲染死循环 → 白屏「载入历史」（实测：编辑块的 step/start + marker + step/end 连续若干行 turn 全为 null）。user/message 天然无 turn 不查；chunk 坐标可缺失不查。step/消息本体必须带真实 turn 号。',
  },
  {
    id: 'T5',
    title: 'turn/end 必须带 data.reason.kind',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '官方 dsh-agent-loop lib/index.js:620（turn/end = {turn, reason:{kind}}）；malformed turn/end 事故（2026-09-02，由离线自查脚本判出）',
    description: '官方 validation 强制 turn/end 的 data.reason.kind 存在（kind ∈ completed|max-tokens|blocked|aborted|error|interrupted）。缺失 = malformed → 官方 SessionPersistenceCorruptionError → 会话加载失败。实测：retrace 情形③信封 turn/end 漏 reason → 每次编辑后加载失败（已修 0.4.18）。',
  },
  {
    id: 'E7',
    title: 'ignorable 未知 type 合法性（带被忽略标记的未知事件须有消费者）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.WARNING,
    source: '实测 2026-09-09 T2（E3 ignorable 无合法性校验 = 后门）',
    description: '未知 type + ignorable:true 被读路径接纳但无人消费 = 静默垃圾。排除已知消费者白名单（retrace/marker、retrace/goal-marker、message-editor/ 前缀等 retrace 客户端消费的插件 marker）后，其余 ignorable 未知事件报 warning。',
  },
  {
    id: 'E8',
    title: '事件信封键白名单（多余键：seed/restore 路径会拒）',
    layer: LAYER.PERSISTENCE,
    // 候选规则 + 探针订正：宿主 `assertSessionEventEnvelope`（dsh-session@0.1.5-rc.1
    // lib/index.js:849-861）确实拒多余键，但其**唯一调用点是 Session 构造器的 seed 路径**
    // （:1063-1068）；JSONL **load 路径**（`adoptSessionEvent`）实测**容忍**（探针 p5 钉住）。
    // 故本规则按 **warning** 报（不影响"可加载"，但该日志作为 seed/restore 输入会被拒）。
    severity: SEVERITY.WARNING,
    source: '@deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:849-861（assertSessionEventEnvelope）+ :1063-1068（唯一调用点=seed 路径）；load 路径容忍见行为探针 p5',
    description: '事件对象只允许 7 个信封键（type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable）。实测反例指出"宿主拒、旧契约 0 违规"；行为探针进一步订正口径：**load 路径容忍、seed/restore 路径拒** ⇒ warning。',
    candidate: true,
  },
  {
    id: 'E9',
    title: 'system/message 必须带 plugin source',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:942-944（"must have plugin source"）；角色表 :917-926',
    description: 'v3 新增的 system/message：role 必须为 system，source.kind 必须为 plugin 且 plugin 非空。实测（反例）：source.kind=\'user\' 宿主拒、旧契约 0 违规 ⇒ 漏检。',
    candidate: true,
  },
  {
    id: 'E10',
    title: 'request/header 的 data.header 字段约束',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:231-248（validateSessionEventData：omit header.system / omit empty tools / omit empty adapterDefaults）',
    description: 'request/header 必须省略 header.system（系统提示改走 system/message）、空 tools、空 adapterDefaults。实测（反例）：带 header.system 的写入宿主拒、旧契约 0 违规 ⇒ 漏检。',
    candidate: true,
  },
  {
    id: 'Z3',
    title: '空会话文件（有 header 无事件）显式报出',
    layer: LAYER.FRAMING,
    severity: SEVERITY.WARNING,
    source: '实测 2026-09-09 T3（36 条规则全来自有内容事故,空态无覆盖）',
    description: '有 header 但零事件 = 异常空会话（新建即空或写入未落盘）。空态不在任何有内容规则的覆盖下,显式 warning 供人判断。',
  },
  {
    id: 'P3',
    title: 'tool/call ↔ tool/result 配对完整性（考古 B1）',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    source: '考古方法 §2/§4.2（callId 配对，不可用"上一个 call"推断）',
    description: '每个 tool/call 的 data.callId 必须能在 tool/result 的 data.message.source.callId 中找到配对；孤儿 call（无 result）告警——中断/失败轮次可能产生孤儿（合法但要审计），考古提取将缺该输出。',
  },
  {
    id: 'P4',
    title: 'tool/result 输出结构可解析（考古 B2）',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    source: '考古方法 §2/§4.2（content 递归 text 结构）',
    description: 'tool/result 的 data.message.content 必须可递归解析（list[dict{type:text,text}] 或等价）；不可解析片段 = 考古提取将漏数据。空 content（失败/无输出）合法。',
  },
  // ── M · 客户端引擎层 ────────────────────────────────────────────────────
  {
    id: 'M1',
    title: 'turn/step 为 null 的 assistant/message 只能 replace，不能 append',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '复盘事故第 2 次尝试（rt.js:6816 崩溃）；实证 data.turn/data.step：正常消息为数字、插件 marker 为 null',
    description: 'data.turn/data.step 为 null 的 assistant/message（如插件 marker）只能以 replace 承载（走插件 marker 定义）；作为 append 会落进核心 assistant-step 定义，因 turn=null 发布 location data 导致客户端引擎崩溃。',
  },

  // ── P · 插件 marker 语义层 ──────────────────────────────────────────────
  {
    id: 'P1',
    premiseStale: true,
    sourceVerified: false,
    title: 'marker id 前缀必须被识别',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    source: 'retrace 插件 RENAME RULE（lib/client.js:29-44）；复盘事故',
    description: 'assistant/message 替换事件的 message.id 以 retrace- / message-editor- 为已知前缀。未知前缀 = 改名后未登记遗留前缀，旧 marker 的隐藏语义会断裂（软兼容丢失）。',
  },
  {
    id: 'P2',
    premiseStale: true,
    sourceVerified: false,
    title: 'marker 自身 seq 不得出现在自身 shadowed 集',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.ERROR,
    source: 'retrace 插件 lib/client.js:393（"event and never a surface node"）',
    description: 'marker 的 sourceEventSeqs（= shadowedSeqs，驱动 CSS 隐藏）不得包含 marker 自身 seq——marker 节点由隐藏逻辑跳过，出现在 shadowed 集属于自指语义错误。',
  },

  // ── C · 并发 / 写入者假设 ───────────────────────────────────────────────
  {
    id: 'C1',
    premiseStale: true,
    sourceVerified: false,
    title: 'seq 缺口/倒退提示多写入者',
    layer: LAYER.CONCURRENCY,
    severity: SEVERITY.WARNING,
    source: 'dsh-session-persistence-jsonl appendLines 无锁（:1200-1227），全仓无会话级排他锁',
    description: '离线体检无法直接观测跨进程竞态，但 E2 暴露的缺口/倒退即是"≥2 个 Host 进程共享同一 session 目录并发写"的后果。单实例部署不触发。',
  },

  // ── Z · zstd 帧结构 ─────────────────────────────────────────────────────
  {
    id: 'Z1',
    title: 'zstd 尾帧撕裂',
    layer: LAYER.FRAMING,
    severity: SEVERITY.WARNING,
    source: 'zstd 帧布局（dsh-session-persistence-jsonl 多帧）',
    description: '尾帧不完整（torn）：可能正在写入（in-flight）或文件被截断。若这是唯一异常，通常可等待写入完成；若持续存在则是截断证据。',
  },
  {
    id: 'Z2',
    title: 'zstd 帧解码失败 = 单帧全损',
    layer: LAYER.FRAMING,
    severity: SEVERITY.ERROR,
    source: '多帧单帧全损 → 整会话不可读',
    description: '任一帧解码失败（磁盘 bitrot / 传输截断 / 并发写撕裂）即整会话不可读；帧越多，单帧损坏下丢失概率线性上升。',
  },

  // ── W · wire 消息流（模型请求序列）───────────────────────────────────────
  {
    id: 'W1',
    title: 'wire 流：tool 消息必须跟在带 tool-call 的 assistant 消息之后',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '2026-08-27 实锤：MiMo 等严格端点对悬空 tool 直接 INVALID_REQUEST（Messages with role "tool" must be a response to a preceding message with "tool_calls"）；marker 遮蔽 assistant(tool_calls) 而未盖住 tool/result、或中断回合重放重复 tool/result 写在 marker 之后都会产生',
    description: '按 surface 折叠顺序展开 wire 消息流：每个 role=tool 消息必须消费一个仍未满足的 assistant tool-call；不足 = 悬空（provider 拒绝）。常见来源：marker 范围漏盖 tool/result、重放重复事件。',
  },
  {
    id: 'W2',
    title: 'wire 流：user 文本不得插在 tool_calls 与其 tool 结果之间',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: 'OpenAI 兼容端点对 tool 消息顺序的严格校验；DSH 序列化器将混合 user 消息展开为 text 在前、tool-result 在后',
    description: '当仍有未满足的 assistant tool-call 时出现 user 文本消息，会产生 [assistant(tool_calls), user(text), tool] 序列，严格端点同样拒绝。',
  },

  // ── G · 迁移预检（migration precheck；**独立维度**，不是"可加载"判定）──────────
  // 存在理由：官方把 v0/v1/v2 会话升到当前格式时会做一轮**迁移校验**，其规则比本工具的
  // "读取/折叠"规则集更严（官方原文见各条 source）。本工具判"可加载"≠"可升级"。
  // 这些规则只描述"官方迁移会不会拒"，因此 severity 固定 warning、layer 固定 migration：
  // 它们**不参与** ok / loadable / resumable / compactable，只喂 `migrationVerdict()`。
  {
    id: 'G1',
    title: '迁移预检：v0 源文件的 subagent/descriptor.data.version 必须为 3',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:1584-1586（assertReleasedEventPayload）：data.version !== 3 且源版本 === 0 → SessionFormatUnsupportedMigrationError("uses unsupported descriptor version N")；源版本 1/2 时官方提前 return（容忍）',
    description: '文件版本 0 且事件类型为 subagent/descriptor 且 data.version !== 3 → 官方 v0→v1 迁移直接拒绝（消息形如 `subagent/descriptor <seq> uses unsupported descriptor version 2`）；源版本 1/2 不受此条约束。',
  },
  {
    id: 'G2',
    title: '迁移预检：v0 源文件不得含词表外的历史事件类型（含 ignorable）',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:1580-1583（assertReleasedEventPayload）：RELEASED_V0_EVENT_DISPOSITIONS 里没有该 type → "format v0 contains unknown historical event type … migration refuses unknown historical events even when ignorable"',
    description: '文件版本 0 且事件 type 不在官方 v0 dispositions（本包 vendored 为 V0_EVENT_TYPES）内 → 官方迁移拒绝，**即使该事件带 ignorable:true**。E3 的 ignorable 豁免是**读取路径**语义（不改），本条只在迁移预检维度表达。',
  },
  {
    id: 'G3',
    sourceVerified: false,
    title: '迁移预检：v0 源 session/title 系列的 messageSeqs 必须引用更早的人类 user/message',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:2543-2556（assertTitleSources）：`session/title` 的 messageSeqs 为空 ⟺ source.kind === "user"；每个被引 seq 必须解析到 `user/message` 且其 `data.source.kind === "user"`，否则 "messageSeqs must cite earlier human user/message events" / "must be empty exactly for a user title"',
    description: '文件版本 0 且事件为 session/title 或 session/title-llm-request：messageSeqs 必须是数组；session/title 的"空数组 ⟺ 用户标题"必须成立；每个被引 seq 必须是更早的 user/message 且 source.kind === "user"。违反 → 官方升级到当前格式时拒绝。**应用面说明**：官方 `assertTitleSources` 与 turn/start 状态机同在 `assertReleasedArtifactRelationships`，由 v1→v2 在**变换后的 v1/v2 artifact** 上调用（`dsh-session-format-v1-to-v2/lib/index.js:104`）；对 messageSeqs 这类按 seq 索引 + 类型/source 判定的引用，变换保序保类型 ⇒ 在原始 v0 上判是必要条件的近似，实测 281 真实 v0 上 0 误报。',
  },
];

/** 按 id 取规则。 */
export function ruleById(id) {
  return CONTRACT_RULES.find((r) => r.id === id);
}

/** 生成 docs/CONTRACTS.md 的目录行（供文档维护）。 */
export function ruleTableRows() {
  return CONTRACT_RULES.map(
    (r) => `| ${r.id} | ${r.severity} | ${r.layer} | ${r.title} |`,
  ).join('\n');
}
