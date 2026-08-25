/**
 * dsh-log-contract · lib/contracts.js
 *
 * DSH 会话日志契约规则目录（spec）。
 *
 * 规则集来源：
 * - `dsh-scale-audit-疑点记录.md`（59 条契约发现 / F1–F7 / N1–N6 / R1–R3）
 * - `复盘-会话修复事故-20260825.md`（三层契约：持久化 / 客户端引擎 / 插件语义）
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
 */
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
    source: '@deepseek-ai/dsh-session lib/index.js:1110-1125',
    description: 'header.version 必须为 0；id 为字符串；createdAt 为非负安全整数；cwd 若存在必须为绝对路径；origin 只能为 "subagent"。',
  },

  // ── R · 存储行 ──────────────────────────────────────────────────────────
  {
    id: 'R1',
    title: '每行必须是合法 JSON',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '审计方法论（scan-seq-gaps.mjs）；dsh-session-persistence-jsonl 读路径',
    description: '非空行无法 JSON.parse = 损坏行。帧边界产生的空行是合法的（跳过）。',
  },
  {
    id: 'R2',
    title: 'chunk 行必须满足精确信封形状',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:922-971 (validateRow)',
    description: 'text-chunks / reasoning-chunks / tool-call-chunks 行必须精确为 {type, seq0, time0, data}，data 精确为 {turn, step, index, dt, texts|args}。损坏 = 整段 run 丢失且加载失败（fail-loud，无跳过逃生舱）。',
  },
  {
    id: 'R3',
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
    source: '@deepseek-ai/dsh-session lib/index.js:398 (planSurfaceEvent "not contiguous")；审计 S2/N6',
    description: 'seq 必须从 0（或窗口 baseSeq）严格连续递增。缺口/倒退 = 违反单写入者假设（多实例共享存储并发写的痕迹），加载时直接 throw。',
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
    title: '禁用遗留词汇',
    layer: LAYER.PERSISTENCE,
    severity: SEVERITY.ERROR,
    source: '@deepseek-ai/dsh-session lib/index.js:1273-1277 (assertSupportedRequestHeader)',
    description: 'request/header-delta 与 reason=fallback 的 request/header 是已删除的遗留格式，写入即被拒。',
  },
  {
    id: 'E6',
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
    source: '@deepseek-ai/dsh-session lib/index.js:335-336 (assertProvenance)；复盘事故第 1 轮',
    description: '★ 写前校验核心规则：sourceEventSeqs 必须包含每一个被替换（shadowed）的 surface 节点，缺一个 = 会话加载被拒（SessionPersistenceCorruptionError）。2026-08-25 事故第 1 轮（清空 sourceEventSeqs）正是违反此规则。',
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
    source: '@deepseek-ai/dsh-session lib/index.js:444-455 (foldSurface)；复盘"官方 foldSurface 不抛 = 通过"',
    description: '终验：把全部事件按序喂给官方 foldSurface，不抛 = 持久化层通过。S1–S7 任何一条违反都会在此暴露。',
  },

  // ── M · 客户端引擎层 ────────────────────────────────────────────────────
  {
    id: 'M1',
    title: 'turn/step 为 null 的 assistant/message 只能 replace，不能 append',
    layer: LAYER.ENGINE,
    severity: SEVERITY.ERROR,
    source: '复盘事故第 2 轮（rt.js:6816 崩溃）；实证 data.turn/data.step：正常消息为数字、插件 marker 为 null',
    description: 'data.turn/data.step 为 null 的 assistant/message（如插件 marker）只能以 replace 承载（走插件 marker 定义）；作为 append 会落进核心 assistant-step 定义，因 turn=null 发布 location data 导致客户端引擎崩溃。',
  },

  // ── P · 插件 marker 语义层 ──────────────────────────────────────────────
  {
    id: 'P1',
    title: 'marker id 前缀必须被识别',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.WARNING,
    source: 'retrace 插件 RENAME RULE（lib/client.js:29-44）；复盘事故',
    description: 'assistant/message 替换事件的 message.id 以 retrace- / message-editor- 为已知前缀。未知前缀 = 改名后未登记遗留前缀，旧 marker 的隐藏语义会断裂（软兼容丢失）。',
  },
  {
    id: 'P2',
    title: 'marker 自身 seq 不得出现在自身 shadowed 集',
    layer: LAYER.PLUGIN,
    severity: SEVERITY.ERROR,
    source: 'retrace 插件 lib/client.js:393（"event and never a surface node"）',
    description: 'marker 的 sourceEventSeqs（= shadowedSeqs，驱动 CSS 隐藏）不得包含 marker 自身 seq——marker 节点由隐藏逻辑跳过，出现在 shadowed 集属于自指语义错误。',
  },

  // ── C · 并发 / 写入者假设 ───────────────────────────────────────────────
  {
    id: 'C1',
    title: 'seq 缺口/倒退提示多写入者',
    layer: LAYER.CONCURRENCY,
    severity: SEVERITY.WARNING,
    source: '审计 N6：dsh-session-persistence-jsonl appendLines 无锁（:1200-1227），全仓无会话级排他锁',
    description: '离线体检无法直接观测跨进程竞态，但 E2 暴露的缺口/倒退即是"≥2 个 Host 进程共享同一 session 目录并发写"的后果。单实例部署不触发。',
  },

  // ── Z · zstd 帧结构 ─────────────────────────────────────────────────────
  {
    id: 'Z1',
    title: 'zstd 尾帧撕裂',
    layer: LAYER.FRAMING,
    severity: SEVERITY.WARNING,
    source: '审计 N5 相关；帧扫描方法论',
    description: '尾帧不完整（torn）：可能正在写入（in-flight）或文件被截断。若这是唯一异常，通常可等待写入完成；若持续存在则是截断证据。',
  },
  {
    id: 'Z2',
    title: 'zstd 帧解码失败 = 单帧全损',
    layer: LAYER.FRAMING,
    severity: SEVERITY.ERROR,
    source: '审计 N5：多帧单帧全损 → 整会话不可读',
    description: '任一帧解码失败（磁盘 bitrot / 传输截断 / 并发写撕裂）即整会话不可读；帧越多，单帧损坏下丢失概率线性上升。',
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
