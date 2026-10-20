/**
 * dsh-log-contract · adapters/dsh/rules.js
 *
 * DSH 专属：契约规则目录（规则描述符数据）。
 *
 * 规则**数据**是平台专属的（每条规则的 title/description/source 都在描述 DSH 的
 * 事件模型与官方源码出处），因此归适配器；契约层 `contract/registry.js`
 * 只提供形状、登记与按 id 读取接口，不持有规则内容。
 *
 * 本文件在加载时把目录登记进契约层注册表（`installRuleCatalog`），
 * 并逐条校验描述符形状（失败即抛错，不静默跳过）。规则只增不改：
 * 规则 id 是稳定主键，历史 id 不复用。
 */
import { LAYER, installRuleCatalog } from '../../contract/registry.js';
import { SEVERITY } from '../../contract/verdict.js';
import { isRuleDescriptor } from '../../contract/rules.js';

/**
 * 契约规则目录。id 前缀：
 * - H  header / 会话头
 * - R  存储行 / chunk 行
 * - E  事件信封 / seq / type 词汇表
 * - S  surface（模型可见面）不变量 —— 核心语义层
 * - M  客户端引擎层
 * - P  插件 marker 语义层
 * - C  并发 / 写入者假设
 * - Z  zstd 帧结构
 * - G  迁移预检（migration gate，**独立维度**：官方迁移会不会拒；不进 ok/verdict）
 */
/**
 * ——**机读的出处/前提漂移标注**。
 *
 * 核对结论：规则的 `source` 大量停在 `@deepseek-ai/dsh-session@0.1.0-rc.7` 的行号上，
 * 且其中 4 条（T2/P1/P2/C1）的**判定前提**在真宿主 0.1.5 上已不成立——此前**没有任何机制
 * 能发现**（`source` 只是人读字符串）。这里把它们变成机读字段，并由 `check` 抬头点名。
 */
export const SOURCE_DRIFT = Object.freeze({
  /** 出处停在 rc.7 行号、未在 0.1.5 上核对（清单见下）。 */
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
    + '其余在此显式列出，结论抬头必须带漂移清单与未核对清单。',
});


export const CONTRACT_RULES = [
  // ── H · header ──────────────────────────────────────────────────────────
  {
    id: 'H1',
    kind: 'record.head',
    title: '首行为合法 JSON 且 type=session',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'record.head-declared',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (validateSessionHeader)',
    description: '会话日志首行必须是可 JSON.parse 的对象，且 type 为 "session"。首行损坏 = 整个会话不可读。',
  },
  {
    id: 'H2',
    kind: 'record.head-fields',
    title: 'header 版本与必填字段',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'record.head-declared',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n]；已知格式版本 0/1/2/3/4（App 2.0.9 内置 v0→v1→v2→v3 迁移，SESSION_FORMAT_VERSION=3；DSH 0.2.x 追加 v3→v4，SESSION_FORMAT_VERSION=4）',
    description: 'header.version 必须为已知受支持版本（0/1/2/3/4）；未知版本报 H2。id 为字符串；createdAt 为非负安全整数；cwd 若存在必须为绝对路径（POSIX 与 Windows 盘符/UNC 形态均接受）；origin 只能为 "subagent"。',
  },

  // ── R · 存储行 ──────────────────────────────────────────────────────────
  {
    id: 'R1',
    kind: 'record.parsable',
    title: '每行必须是合法 JSON',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'record.parsable',
    source: 'seq 缺口扫描；dsh-session-persistence-jsonl 读路径',
    description: '非空行无法 JSON.parse = 损坏行。帧边界产生的空行是合法的（跳过）。',
  },
  {
    id: 'R2',
    kind: 'record.aggregate-schema',
    sourceVerified: false,
    title: 'chunk 行必须满足精确信封形状',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'record.parsable',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (validateRow)',
    description: 'text-chunks / reasoning-chunks / tool-call-chunks 行必须精确为 {type, seq0, time0, data}，data 精确为 {turn, step, index, dt, texts|args}。损坏 = 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）。',
  },
  {
    id: 'R3',
    kind: 'record.derived-coordinate',
    sourceVerified: false,
    title: 'chunk 行展开后成员 seq/time 安全',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'seq.present',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n]',
    description: '展开后成员 seq 与 time 必须保持安全整数（seq0+len-1 与逐 gap 累加的 time 不溢出）。',
  },

  // ── E · 事件信封 ────────────────────────────────────────────────────────
  {
    id: 'E1',
    kind: 'seq.present',
    title: '每个事件携带非负安全整数 seq',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'seq.present',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (isEventSeq)、:[n]-[n] (append 信封)',
    description: '事件信封为 {type, seq, time, data, ...surfaceMetadata}；seq 必须是非负安全整数。',
  },
  {
    id: 'E2',
    kind: 'seq.contiguous',
    title: 'seq 严格连续（单写入者假设）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'seq.contiguous',
    source: '@deepseek-ai/dsh-session lib/index.js:[n] (planSurfaceEvent "not contiguous")',
    description: 'seq 必须从 0（或窗口 baseSeq）严格连续递增。缺口/倒退 = 违反单写入者假设（多实例共享存储并发写的痕迹），加载时直接 throw。',
  },
  {
    id: 'S9',
    kind: 'seq.monotonic',
    title: '文件物理序 seq 单调（多写入者交织特征）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'seq.monotonic',
    source: '观测形状：多写入者交织时文件物理序可能出现回退（大→小→更大）；单进程 append 断言 seq==cursor+i 且按 id 串行化，不可能写出该形状',
    description: '按文件物理行序要求展开后事件 seq 严格单调递增。E2 在排序后检查（loadSessionLog 会 sort），物理序倒退被掩盖；S9 在排序前按行序检查，非单调 = 多写入者/旧光标回放交织的直接特征证据，加载会被拒。',
  },
  {
    id: 'S10',
    kind: 'reference.element-type',
    title: 'sourceEventSeqs 元素必须是（解码后的）非负整数；存储形态只允许官方区间对',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'reference.closure',
    source: '@deepseek-ai/dsh-session@0.2.0-rc.2 lib/index.js:[n]-[n]（encodeSeqRanges：连续 ≥3 才压缩成 `[start,end]`，即 v3+ JSONL 的存储形态）、:[n]-[n]（decodeSeqRanges/assertSeq：元素必须是非负安全整数，区间对只允许 `[start,end]` 且 start ≤ end、解码后严格递增）',
    description: '所有事件的 `sourceEventSeqs`（**含非 surface 类型与 ignorable 未知插件事件**）原始存储形态只允许两种元素：非负安全整数、或官方区间对 `[start,end]`；经官方 `decodeSeqRanges` 解码后必须全部是非负安全整数。解码后仍为数组/非整数 = 契约违规（投影层/restore/重写路径会把它静默当成 seq）⇒ 判红并给出该事件的 seq/行号。注意：`[a,b]` 本身是 v3+ 的**合法存储形态**（真实日志中该形态可正常解码），不得误报；判红点是「解码后仍非整数」与「非官方区间对形态」。',
  },
  {
    id: 'I1',
    kind: 'queue.replay-sound',
    sourceVerified: false,
    title: 'inbox seed 相对重放（fork 边界孤儿 spliced）',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'pairing.complete',
    source: '@deepseek-ai/dsh-agent lib/types/inbox.js:[n]-[n] (apply/validate)；fork 边界 removedCount=1 的孤儿 splice 形状即此形态',
    description: '从 header.seedLength 起重放 agent/inbox/spliced，next-turn/next-step 双队列；start+removedCount 不得超过队列长、不得产生重复 pending id。fork 时"移除父待处理提示词"的 splice 假设父会话 inbox，子会话 seed 相对空 inbox 上非法 → resume 被拒（invalid persisted inbox splice）。',
  },
  {
    id: 'I2',
    kind: 'head.inherited-count',
    title: 'seedLength = 继承事件条数（不是字节数）；parentSession ∧ seedLength∈{缺失,0} 合法',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'record.head-declared',
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2 package/lib/index.js:[n]（`seedLength` → `inheritedEventCount`，缺省 0）、:[n]（`isSeeded = seedLength !== undefined`）、:[n]-[n]（"Session inheritedEventCount exceeds its event count" / "unseeded Session inheritedEventCount must be 0"）；v4 运行时头禁该字段：dsh-session@0.2.0-rc.2 lib/index.js:[n]（"session header has invalid field \\"seedLength\\""）',
    description: '`header.seedLength` 的语义被钉死为**继承事件条数**（官方 `inheritedEventCount`），不是字节数、不是行数。判据：① 若存在必须是非负安全整数；② `seedLength > 展开后事件数` ⇒ error（官方解码/迁移直接抛 "inheritedEventCount exceeds its event count"）；③ 文件版本 ≥4 时该字段必须不存在（v4 运行时 header 校验拒）。**`parentSession` 有值 ∧ `seedLength` 缺失或 0 ⇒ 合法**：`parentSession` 只记血缘，是否 seeded 由 `seedLength` 字段是否存在决定（`isSeeded = seedLength !== undefined`；只有 unseeded 才要求 inheritedEventCount === 0）——真实日志中头带 `parentSession` 且无 `seedLength`（`isSeeded:false`）的会话仍正常加载，不能判违规。`seedLength` 与展开后事件条数一致，且明显小于明文体积与行数（可排除字节数/行数语义）；`> 展开事件数` 的判红分支是防"当字节数用"的护栏。',
  },
  {
    id: 'E3',
    kind: 'type.known-or-declared',
    title: 'type 必须在已知词汇表内（或带 ignorable 标记）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'type.known-or-declared',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (KNOWN_SESSION_EVENT_TYPES 注释)',
    description: '词汇表外的 type 会被持久化读路径拒绝，除非事件带信封级 ignorable 标记（新版本 harness 写入的日志）。插件事件（如 retrace marker 以 assistant/message 承载）不在词汇表外——它们复用核心类型。',
  },
  {
    id: 'E4',
    kind: 'value.json-lossless',
    title: 'data 与 surface 元数据必须 JSON 无损',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'value.json-lossless',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (snapshotJsonValue 双快照)',
    description: 'append 热路径对 data 与 surfaceMetadata 各做一次 lossless-JSON 全量校验；非 JSON 安全值（函数/循环引用/非有限数）写入前即被拒。',
  },
  {
    id: 'E5',
    kind: 'type.deprecated-forbidden',
    sourceVerified: false,
    title: '禁用遗留词汇',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'type.known-or-declared',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (assertSupportedRequestHeader)',
    description: 'request/header-delta 与 reason=fallback 的 request/header 是已删除的遗留格式。注意（订正 E5）：宿主 Session.append/appendLines 不看 type ⇒ 写入会成功、下一次读取才炸（依据 dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n] / persistence-jsonl:[n]-[n]），不是写入即被拒。',
  },
  {
    id: 'E6',
    kind: 'message.shape',
    sourceVerified: false,
    title: '消息类事件消息形状',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'derived.scope-match',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (assertMessageEventShape)；v4：dsh-session@0.2.0-rc.2 src/index.ts:[n]-[n]',
    description: 'user/message、assistant/message、tool/result 必须携带具名 message（非空 id、正确 role、合法 source、content 数组；assistant 需 model source，tool/result 需 tool source 且 toolCallId 匹配）。v0–v3：tool/result role 为 user 且恰含一个 tool-result 块；v4：tool/result role 为 tool、不得含 tool-result 包装块、message.toolCallId 等于 source.callId，新增 developer/message（role developer），且任何消息 source.kind 不得为 plugin。',
  },

  // ── S · surface 不变量（核心语义层）────────────────────────────────────
  {
    id: 'S1',
    kind: 'view.projection-declared',
    title: 'surface 候选类型必须携带 surfaceOp',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'view.replayable',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (surfaceOpOf)',
    description: 'user/message、assistant/message、tool/result（v3 起含 system/message，v4 起含 developer/message）是 surface-eligible 类型，缺 surfaceOp 即违反契约。',
  },
  {
    id: 'S2',
    kind: 'view.projection-forbidden',
    title: '非 surface 类型不得携带 surface 元数据',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'envelope.closed',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (surfaceOpOf)',
    description: '词汇表内非 surface-eligible 类型带 surfaceOp / sourceEventSeqs = 违反契约。',
  },
  {
    id: 'S3',
    kind: 'reference.closure',
    title: 'append 的 sourceEventSeqs 契约',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'reference.closure',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n]、:[n]-[n] (assertProvenance)',
    description: 'append 以空 shadowed 集校验：sourceEventSeqs 若携带必须满足 assertProvenance（数组、无重复、全部引用更早事件）；任何违规即写入被拒。',
  },
  {
    id: 'S4',
    kind: 'rewrite.node-bounded',
    title: 'replace 操作数与范围合法性',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'rewrite.node-bounded',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (isReplaceOp)、:[n]-[n] (replacementRange)',
    description: 'replace 必须是精确的 {op:"replace", start, end}（v0–v2）或 {op:"replace", startSeq, endSeq}（v3/v4）；端点必须存在于当前 surface 节点且 startIdx ≤ endIdx。',
  },
  {
    id: 'S5',
    kind: 'rewrite.coverage-complete',
    title: 'replace 的 sourceEventSeqs 必须完整覆盖被替换节点',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'rewrite.coverage-complete',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (assertProvenance)',
    description: '★ 写前校验核心规则：sourceEventSeqs 必须包含每一个被替换（shadowed）的 surface 节点，缺一个 = 会话加载被拒（SessionPersistenceCorruptionError）。清空 sourceEventSeqs 即违反此规则。',
  },
  {
    id: 'S6',
    kind: 'reference.self-constraints',
    title: 'sourceEventSeqs 自身约束',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'reference.closure',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (assertProvenance)',
    description: 'sourceEventSeqs 存在时必须为数组、无重复、全部引用更早事件（< 当前 seq），且除 assistant/message 外不得为空。',
  },
  {
    id: 'S7',
    kind: 'rewrite.content-only',
    title: 'tool/result 替换仅允许单节点内容改写',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'rewrite.content-only',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (assertToolResultRewrite)',
    description: 'tool/result 的 replace 必须恰好重写 1 个当前节点、目标是 tool/result，且除 message.content 外不得改动任何字段。',
  },
  {
    id: 'S8',
    kind: 'view.replayable',
    title: '整日志 foldSurface 可重放',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'view.replayable',
    source: '@deepseek-ai/dsh-session lib/index.js:[n]-[n] (foldSurface, v3)；v0/v1/v2 用本地等价实现 lib/legacy-fold.js（rc.7 lib/index.js:[n]-[n] 逐条移植）',
    description: '终验：按被检文件 header.version 选折叠器（v3 → 官方 foldSurface；v0/v1/v2 → 本地 legacyFoldSurface），不抛 = 持久化层通过。S1–S7 任何一条违反都会在此暴露。注意 0.1.5 的官方 foldSurface 是 v3 语义（replace 用 startSeq/endSeq、assistant/message 禁 sourceEventSeqs），对旧格式文件会误报，不可借用。',
  },

  {
    id: 'T1',
    kind: 'meter.step-pairing',
    title: 'token-meter 配对：assistant/message 与 step/end 必须匹配当前打开的 step/start',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'derived.scope-match',
    source: '@deepseek-ai/dsh-token-meter lib/index.js:[n]-[n] (_foldEvent)',
    description: 'token meter 折叠要求 assistant/message 与 step/end 与打开的 step/start（turn/step 完全一致）匹配；违反即 /compact 与压力测量永久失败。retrace 的 turn-null 编辑/撤回 marker（空 assistant/message replace）命中此条——foldSurface 认可其合法性但 token meter 崩溃（M1 只约束 append 形态的盲区），压缩前需清理。',
  },
  {
    id: 'T2',
    kind: 'meter.source-scope',
    premiseStale: true,
    sourceVerified: false,
    title: 'token-meter 源引用：assistant/message 的 sourceEventSeqs 引用的 chunk 必须同 turn/step',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'reference.same-scope',
    source: '@deepseek-ai/dsh-token-meter lib/index.js:[n]-[n] (_estimateProviderAssistant，:[n] belongs to another step)',
    description: 'token meter 重建 provider 输出时，逐条检查 assistant/message 的 sourceEventSeqs：指向 assistant/chunk 的引用必须与消息同 turn/step，且 seq 更早、不重复；跨 step 引用 → 官方抛 belongs to another step → 每次事件追加都重抛（consumedEvents 不前进）→ 输出放大拖垮 host。T1 只查 step 配对不查源引用，此条补盲区；修复用 fix --clip-crossstep。',
  },
  {
    id: 'T3',
    kind: 'view.key-unique',
    title: 'step 节点 key 唯一（同 turn 内 step/start 的 step 号不得复用）',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'view.key-unique',
    source: 'client render key = turn:step; duplicate keys cause a render deadlock (observed in real logs)',
    description: '客户端渲染消息列表从事件流构建节点，节点 key = data.turn:data.step。同 turn 内两个 step/start 的 step 号相同 → key 冲突 → React 渲染死循环 → 空白渲染（正常轮与编辑块复用同 step 号即触发；同类冲突可成批出现在同一日志）。修复：同 turn 内 step 递增、整块重编号（含块内 chunk/tool/assistant）。',
  },
  {
    id: 'T4',
    kind: 'view.scope-attributable',
    title: 'step/消息本体 turn 缺失（null/undefined）→ 渲染死循环',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'view.scope-attributable',
    source: '观测形状：编辑块的 step/start + marker + step/end 连续若干行 turn 全为 null（客户端渲染状态机无法归属）',
    description: '客户端渲染状态机对 turn=null 的 step/start|step/end|assistant/message 无法归属任何 turn → 渲染死循环 → 空白渲染「载入历史」（编辑块 turn 全为 null 即触发）。user/message 天然无 turn 不查；chunk 坐标可缺失不查。step/消息本体必须带真实 turn 号。',
  },
  {
    id: 'T5',
    kind: 'scope.end-reason',
    title: 'turn/end 必须带 data.reason.kind',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'view.scope-attributable',
    source: '官方 dsh-agent-loop lib/index.js:[n]（turn/end = {turn, reason:{kind}}）；缺 reason.kind 的 turn/end 形状即 malformed',
    description: '官方 validation 强制 turn/end 的 data.reason.kind 存在（kind ∈ completed|max-tokens|blocked|aborted|error|interrupted）。缺失 = malformed → 官方 SessionPersistenceCorruptionError → 会话加载失败。观测形状：信封 turn/end 漏 reason → 每次编辑后加载失败。',
  },
  {
    id: 'E7',
    kind: 'type.ignorable-consumer',
    title: 'ignorable 未知 type 合法性（带被忽略标记的未知事件须有消费者）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.WARNING,
    invariant: 'type.known-or-declared',
    source: 'E3 ignorable 无合法性校验 = 后门',
    description: '未知 type + ignorable:true 被读路径接纳但无人消费 = 静默垃圾。排除已知消费者白名单（retrace/marker、retrace/goal-marker、message-editor/ 前缀等 retrace 客户端消费的插件 marker）后，其余 ignorable 未知事件报 warning。',
  },
  {
    id: 'E8',
    kind: 'envelope.keys-closed',
    title: '事件信封键白名单（多余键：seed/restore 路径会拒）',
    layer: LAYER.PERSISTENCE,
    // 候选规则 + 探针订正：宿主 `assertSessionEventEnvelope`（dsh-session@0.1.5-rc.1
    // lib/index.js:[n]-[n]）确实拒多余键，但其**唯一调用点是 Session 构造器的 seed 路径**
    // （:[n]-[n]）；JSONL **load 路径**（`adoptSessionEvent`）**容忍**（探针 p5 钉住）。
    // 故本规则按 **warning** 报（不影响"可加载"，但该日志作为 seed/restore 输入会被拒）。
    severity: SEVERITY.WARNING,
    invariant: 'envelope.closed',
    source: '@deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]（assertSessionEventEnvelope）+ :[n]-[n]（唯一调用点=seed 路径）；load 路径容忍见行为探针 p5',
    description: '事件对象只允许 7 个信封键（type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable）。行为探针订正语义：**load 路径容忍、seed/restore 路径拒** ⇒ warning。',
    candidate: true,
  },
  {
    id: 'E9',
    kind: 'message.source-producer',
    title: 'system/message 的 source 契约（v3 plugin / v4 system-prompt）',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'derived.scope-match',
    source: '@deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]（"must have plugin source"）；角色表 :[n]-[n]；v4：dsh-session@0.2.0-rc.2 src/index.ts:[n]-[n]（"must have system-prompt source"）',
    description: 'v3 新增的 system/message：role 必须为 system，source.kind 必须为 plugin 且 plugin 非空。反例：source.kind=\'user\' 宿主拒、旧契约漏检。v4（v3→v4 迁移把 @deepseek-ai/dsh-system-prompt 改写为生产者自有 kind）：source.kind 必须为 system-prompt。',
    candidate: true,
  },
  {
    id: 'E10',
    kind: 'request.header-minimal',
    title: 'request/header 的 data.header 字段约束',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    invariant: 'envelope.closed',
    source: '@deepseek-ai/dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]（validateSessionEventData：omit header.system / omit empty tools / omit empty adapterDefaults）',
    description: 'request/header 必须省略 header.system（系统提示改走 system/message）、空 tools、空 adapterDefaults。反例：带 header.system 的写入宿主拒、旧契约漏检。',
    candidate: true,
  },
  {
    id: 'Z3',
    kind: 'container.empty-explicit',
    title: '空会话文件（有 header 无事件）显式报出',
    layer: LAYER.FRAMING,
    severity: SEVERITY.WARNING,
    invariant: 'container.empty-explicit',
    source: '事件流为空（无事件）时的显式报出：空态不在任何有内容规则的覆盖下',
    description: '有 header 但零事件 = 异常空会话（新建即空或写入未落盘）。空态不在任何有内容规则的覆盖下,显式 warning 供人判断。',
  },
  {
    id: 'P3',
    kind: 'pairing.call-result',
    title: 'tool/call ↔ tool/result 配对完整性（考古 B1）',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    invariant: 'pairing.complete',
    source: '考古方法 §2/§4.2（callId 配对，不可用"上一个 call"推断）',
    description: '每个 tool/call 的 data.callId 必须能在 tool/result 的 data.message.source.callId 中找到配对；孤儿 call（无 result）告警——中断/失败轮次可能产生孤儿（合法但要审计），考古提取将缺该输出。',
  },
  {
    id: 'P4',
    kind: 'pairing.result-parsable',
    title: 'tool/result 输出结构可解析（考古 B2）',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    invariant: 'value.json-lossless',
    source: '考古方法 §2/§4.2（content 递归 text 结构）',
    description: 'tool/result 的 data.message.content 必须可递归解析（list[dict{type:text,text}] 或等价）；不可解析片段 = 考古提取将漏数据。空 content（失败/无输出）合法。',
  },
  // ── M · 客户端引擎层 ────────────────────────────────────────────────────
  {
    id: 'M1',
    kind: 'append.deferred-only',
    title: 'turn/step 为 null 的 assistant/message 只能 replace，不能 append',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'derived.scope-match',
    source: '客户端引擎：append 的 turn/step-less assistant/message 触发渲染崩溃（rt.js:[n]）；实证 data.turn/data.step：正常消息为数字、插件 marker 为 null',
    description: 'data.turn/data.step 为 null 的 assistant/message（如插件 marker）只能以 replace 承载（走插件 marker 定义）；作为 append 会落进核心 assistant-step 定义，因 turn=null 发布 location data 导致客户端引擎崩溃。',
  },

  // ── P · 插件 marker 语义层 ──────────────────────────────────────────────
  {
    id: 'P1',
    kind: 'marker.prefix-registered',
    premiseStale: true,
    sourceVerified: false,
    title: 'marker id 前缀必须被识别',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    invariant: 'type.known-or-declared',
    source: 'retrace 插件 RENAME RULE（lib/client.js:29-44）',
    description: 'assistant/message 替换事件的 message.id 以 retrace- / message-editor- 为已知前缀。未知前缀 = 改名后未登记遗留前缀，旧 marker 的隐藏语义会断裂（软兼容丢失）。',
  },
  {
    id: 'P2',
    kind: 'marker.self-reference',
    premiseStale: true,
    sourceVerified: false,
    title: 'marker 自身 seq 不得出现在自身 shadowed 集',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.ERROR,
    invariant: 'reference.closure',
    source: 'retrace 插件 lib/client.js:[n]（"event and never a surface node"）',
    description: 'marker 的 sourceEventSeqs（= shadowedSeqs，驱动 CSS 隐藏）不得包含 marker 自身 seq——marker 节点由隐藏逻辑跳过，出现在 shadowed 集属于自指语义错误。',
  },
  {
    id: 'P5',
    kind: 'carrier.pairing',
    title: 'carrier 两段配对：第 2 段 sourceEventSeqs 首元素 = 第 1 段（审计段）seq',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.ERROR,
    invariant: 'reference.same-scope',
    source: '仓库既有两段载体形状（test/semantics-v4.test.js:[n]-[n]：`compaction/prune` 审计段 + `user/message` replace 载体）；真实日志中两种写法并存：审计段 seq 在 `sourceEventSeqs[0]`（现行写法）、首元素 = 区间起点且不引用审计段 seq（早期写法）⇒ 读侧必须两种都认；官方 compaction 的 `compaction/summary` 引用是另一形状（`[compaction/start, compaction/summary, …]`），不属本条',
    description: '两段载体（第 1 段 = `compaction/prune` 审计段，带 `data.shadowedRange`/`shadowedSeqs`；第 2 段 = 紧随其后的 surface replace 载体）的配对规则：第 2 段 `sourceEventSeqs[0]` 必须等于第 1 段的 seq（现役写法），其余元素覆盖被遮蔽节点。**读侧容错（两种写法都认）**：① 现役 `[审计段 seq, ...被遮蔽节点]`；② 早期 `[区间起点, ...被遮蔽节点]`（不引用审计段 seq；真实日志中存在该写法，若判红会全成"孤儿"）。只有"审计段 seq 在中间位且首元素既非审计段也非区间起点"、或"紧邻审计段却既不引用它、首元素也不是区间起点"才报 error。**写侧**（prewrite）按现役写法严格校验：拟写载体若紧邻审计段，`sourceEventSeqs[0]` 必须是该审计段 seq，否则拒绝（早期写法在写侧被要求升级）。',
  },

  // ── C · 并发 / 写入者假设 ───────────────────────────────────────────────
  {
    id: 'C1',
    kind: 'seq.single-writer',
    premiseStale: true,
    sourceVerified: false,
    title: 'seq 缺口/倒退提示多写入者',
    layer: LAYER.CONCURRENCY,
    severity: SEVERITY.WARNING,
    invariant: 'seq.single-writer',
    source: 'dsh-session-persistence-jsonl appendLines 无锁（:[n]-[n]），全仓无会话级排他锁',
    description: '离线体检无法直接观测跨进程竞态，但 E2 暴露的缺口/倒退即是"≥2 个 Host 进程共享同一 session 目录并发写"的后果。单实例部署不触发。',
  },

  // ── Z · zstd 帧结构 ─────────────────────────────────────────────────────
  {
    id: 'Z1',
    kind: 'frame.tail-intact',
    title: 'zstd 尾帧撕裂',
    layer: LAYER.FRAMING,
    severity: SEVERITY.WARNING,
    invariant: 'frame.tail-intact',
    source: 'zstd 帧布局（dsh-session-persistence-jsonl 多帧）',
    description: '尾帧不完整（torn）：可能正在写入（in-flight）或文件被截断。若这是唯一异常，通常可等待写入完成；若持续存在则是截断证据。',
  },
  {
    id: 'Z2',
    kind: 'frame.decodable',
    title: 'zstd 帧解码失败 = 单帧全损',
    layer: LAYER.FRAMING,
    severity: SEVERITY.ERROR,
    invariant: 'frame.decodable',
    source: '多帧单帧全损 → 整会话不可读',
    description: '任一帧解码失败（磁盘 bitrot / 传输截断 / 并发写撕裂）即整会话不可读；帧越多，单帧损坏下丢失概率线性上升。',
  },
  {
    id: 'Z4',
    kind: 'frame.first-record-alone',
    title: '首帧必须恰好一行 header',
    layer: LAYER.FRAMING,
    severity: SEVERITY.ERROR,
    invariant: 'frame.first-record-alone',
    source: '宿主 assertZstdHeaderFrame（0.1.5-rc.2 lib/index.js:[n]）：首帧非"恰好一行"即抛',
    description: '官方写盘形状是 header **独占第一帧**。首帧装多行时宿主抛错，且抛点在 listArtifacts **遍历全库**、无 per-session 容错 ⇒ **整个客户端起不来**（把整份日志重压成单帧写回即触发）。',
  },
  {
    id: 'Z5',
    kind: 'frame.layout-preserved',
    title: '多行日志不得压成单帧',
    layer: LAYER.FRAMING,
    severity: SEVERITY.ERROR,
    invariant: 'frame.layout-preserved',
    source: '官方形状：header 第一帧 + 事件逐帧追加',
    description: '把整份日志重压成 1 帧会同时触发 Z4；任何"重写会话"的路径都必须**保形**（逐帧解、逐帧回写，或走宿主写入器），不得整体重压缩。',
  },

  // ── W · wire 消息流（模型请求序列）───────────────────────────────────────
  {
    id: 'W1',
    kind: 'wire.tool-result-anchored',
    title: 'wire 流：tool 消息必须跟在带 tool-call 的 assistant 消息之后',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'pairing.complete',
    source: '严格端点（如 MiMo）对悬空 tool 直接 INVALID_REQUEST（Messages with role "tool" must be a response to a preceding message with "tool_calls"）；marker 遮蔽 assistant(tool_calls) 而未盖住 tool/result、或中断回合重放重复 tool/result 写在 marker 之后都会产生',
    description: '按 surface 折叠顺序展开 wire 消息流：每个 role=tool 消息必须消费一个仍未满足的 assistant tool-call；不足 = 悬空（provider 拒绝）。常见来源：marker 范围漏盖 tool/result、重放重复事件。',
  },
  {
    id: 'W2',
    kind: 'wire.user-text-order',
    title: 'wire 流：user 文本不得插在 tool_calls 与其 tool 结果之间',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    invariant: 'pairing.complete',
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
    kind: 'migration.descriptor-version',
    title: '迁移预检：v0 源文件的 subagent/descriptor.data.version 必须为 3',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    invariant: 'migration.known-types',
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:[n]-[n]（assertReleasedEventPayload）：data.version !== 3 且源版本 === 0 → SessionFormatUnsupportedMigrationError("uses unsupported descriptor version N")；源版本 1/2 时官方提前 return（容忍）',
    description: '文件版本 0 且事件类型为 subagent/descriptor 且 data.version !== 3 → 官方 v0→v1 迁移直接拒绝（消息形如 `subagent/descriptor <seq> uses unsupported descriptor version 2`）；源版本 1/2 不受此条约束。',
  },
  {
    id: 'G2',
    kind: 'migration.known-types',
    title: '迁移预检：v0 源文件不得含词表外的历史事件类型（含 ignorable）',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    invariant: 'migration.known-types',
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:[n]-[n]（assertReleasedEventPayload）：RELEASED_V0_EVENT_DISPOSITIONS 里没有该 type → "format v0 contains unknown historical event type … migration refuses unknown historical events even when ignorable"',
    description: '文件版本 0 且事件 type 不在官方 v0 dispositions（本包 vendored 为 V0_EVENT_TYPES）内 → 官方迁移拒绝，**即使该事件带 ignorable:true**。E3 的 ignorable 豁免是**读取路径**语义（不改），本条只在迁移预检维度表达。',
  },
  {
    id: 'G3',
    kind: 'migration.reference-sound',
    sourceVerified: false,
    title: '迁移预检：v0 源 session/title 系列的 messageSeqs 必须引用更早的人类 user/message',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    invariant: 'migration.reference-sound',
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 lib/index.js:[n]-[n]（assertTitleSources）：`session/title` 的 messageSeqs 为空 ⟺ source.kind === "user"；每个被引 seq 必须解析到 `user/message` 且其 `data.source.kind === "user"`，否则 "messageSeqs must cite earlier human user/message events" / "must be empty exactly for a user title"',
    description: '文件版本 0 且事件为 session/title 或 session/title-llm-request：messageSeqs 必须是数组；session/title 的"空数组 ⟺ 用户标题"必须成立；每个被引 seq 必须是更早的 user/message 且 source.kind === "user"。违反 → 官方升级到当前格式时拒绝。**应用面说明**：官方 `assertTitleSources` 与 turn/start 状态机同在 `assertReleasedArtifactRelationships`，由 v1→v2 在**变换后的 v1/v2 artifact** 上调用（`dsh-session-format-v1-to-v2/lib/index.js:[n]`）；对 messageSeqs 这类按 seq 索引 + 类型/source 判定的引用，变换保序保类型 ⇒ 在原始 v0 上判是必要条件的近似。',
  },
  {
    id: 'G4',
    kind: 'migration.declared-skip',
    title: '未知历史事件声明式可忽略（ignorable:true + 白名单）——迁移不得硬拒',
    layer: LAYER.MIGRATION,
    severity: SEVERITY.WARNING,
    invariant: 'migration.declared-skip',
    source: '@deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2 package/lib/index.js:[n]-[n]（assertReleasedArtifactCoordinates：`ignorableCurrent` 分支只在 allowLegacySteering=false 时生效；:[n] 原文 "migration refuses unknown historical events even when ignorable"）、同处 `vocabularyNeutral` 参数（"whether unknown event types remain opaque"，未知类型按不透明事件保留的策略）',
    description: '未知历史事件（不在本包 vendored v0 词表内）若带信封级 `ignorable:true`，契约层按**声明式可忽略**处置：允许按声明丢弃并登记为 `acceptedDrop`，**不得**让整条迁移硬拒（这正是"每新增一类插件事件就卡死整条迁移"的根因）。消费者白名单可注入：`opts.ignorableWhitelist` / `createPreWriter({ignorableWhitelist})` / 环境变量 `DSH_LOG_CONTRACT_IGNORABLE_WHITELIST`（逗号分隔；元素为精确 type 或以 `/` 结尾的前缀），默认 = 已知插件消费者 `retrace/`、`message-editor/`。**未登记**的未知 ignorable 事件仍报 G4 warning（⛔ 不静默），且保持迁移阻断。G2 仍**原样保留**为"官方 v0→v1 会拒"的事实预检，不放宽；本规则只把"已声明可忽略且已登记"的事件从迁移阻断移入 `acceptedDrops`。真实 v0 日志中 `retrace/goal-marker`（ignorable）经默认白名单命中 ⇒ acceptedDrops，迁移不再被它阻断。',
  },
  {
    id: 'A1',
    kind: 'content.restorable',
    title: '在位可还原只认结构化归档指针（archiveRef / archive / externalized.*）',
    layer: LAYER.ARCHIVE,
    severity: SEVERITY.ERROR,
    invariant: 'content.restorable',
    source: '归档指针只认结构化字段（`archiveRef`/`archive`/`externalized.*`），⛔ 不得从自由文本 grep 路径（文本提取会把模板/示例误算成引用、漏掉真实指针）；按（目标,行）去重后逐条校验可还原性',
    description: '外置内容的"在位可还原"判定**只**从结构化字段取指针：`data.archiveRef` / `data.archive` / `data.externalized.archiveRef` / `data.externalized.archive`（校验元数据取同级 `archiveLine`/`sha[n]`）；⛔ **永不**从 `content`/`pointer`/散文模板等自由文本 grep 路径（文本 grep 会把模板/示例误算成引用、漏掉真实指针）。判据：目标文件存在 + `archiveLine` 行存在 + `sha[n]` 匹配 = 在位可还原；目标缺失/行缺失/sha 不符 = error；绝对路径失效但同名归档在归档根可解析 = `relocated` warning（re-home 未回写）。**按记录去重**：同一事件同时带 `archiveRef`(basename) 与 `archive`(绝对路径) 时按（目标,行）算一条记录——同一记录同时带 `archiveRef`(basename) 与 `archive`(绝对路径) 时按（目标,行）算一条记录；绝对路径失效时由 `archiveRef` 在归档根解析（不计为内容缺失）。**独立维度**：需要归档根目录才能评估（`opts.archiveRoots` / `check --archive-root DIR`），未提供时结论为 `unverifiable`（不冒充通过，也不产生违规）。启用本维度后，真实缺失/行缺失/sha 不符是 **error**（红判据：在位可还原须 [n]%），会进 `ok` 与三档结论；`relocated` 只是 warning。',
  },
];

installRuleCatalog(CONTRACT_RULES, { validate: isRuleDescriptor });
