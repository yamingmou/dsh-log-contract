/**
 * dsh-log-contract · lib/vocab.js —— **按被检文件自身版本选词表与折叠路径**（1.3 第二半，内部评审裁定）
 *
 * 背景（一手实测）：同一健康会话，在**生产 0.1.1 解析**下 0 违规，在 **0.1.5 解析**下 3606 违规——
 * 根因是本包原先用**运行时导出**的 `KNOWN_SESSION_EVENT_TYPES` / `foldSurface` 去判**旧格式(v0)文件**：
 * 官方 0.1.5 的词汇表已不含 `assistant/chunk`（v0 词表 51 条里**有**），于是每个 chunk 事件被 E3 误报。
 * 裁定原文（内部评审 §二）：**"判据必须来自文件自身的版本，不是判官(运行时)的版本"**。
 *
 * 2026-09-14 复核补强（同一裁定的完整落地）——一手证据：
 * 1. **0.1.5 的 `foldSurface` 不是"放宽"，而是换成了 v3 语义**（对照 `dsh-session@0.1.0-rc.7`
 *    与 `0.1.5-rc.1` 的 `isReplaceOp` / `assertProvenance`）：
 *    - replace 字段改名：rc.7 `{op,start,end}`（`lib/index.js:300-303`）→ 0.1.5 `{op,startSeq,endSeq}`
 *      （`lib/index.js:279`）；旧 marker 在 0.1.5 直接 “carries an invalid replace surfaceOp”；
 *    - 0.1.5 `lib/index.js:285` 起 `assistant/message` **一律**不得携带 `sourceEventSeqs`
 *      （“embeds its source stream”）；rc.7 允许（空数组仅限 assistant/message）。
 *    ⇒ 0.1.5 的 `foldSurface` **只能**终验 v3 文件；v0/v1/v2 用它会误报，必须走本地等价实现
 *      （`./legacy-fold.js`，rc.7 `foldSurface` 逐条移植、同样 fail-loud）。
 * 2. **版本边界是 v3，不是 v2**：App 2.0.9 内置 `dsh-session-format-v2-to-v3`，其
 *    `lib/index.js:361-371` 明示 v2 仍是 `{start,end}`、由迁移改名为 `startSeq/endSeq`
 *    ⇒ v2 属于"旧格式"。App 内置 `SESSION_FORMAT_VERSION = 3` 并带 v0→v1→v2→v3 三个迁移包。
 * 3. **顶层 chunk 行只在旧格式里存在**：App 2.0.9 的真实持久化层
 *    `dsh-session-persistence-jsonl@0.1.5-rc.1/lib/worker.cjs:4237-4280` 把 chunk run 内嵌进
 *    `assistant/attempt.data.stream`（紧凑记录 `{type,time0,index,dt,texts}`，**无 seq0/turn/step**），
 *    不再写顶层 `text-chunks` 行；v0/v1/v2 才用顶层行（`dsh-session/lib/types/chunk-rows.js`）。
 *    ⇒ v3 词表**不**需要 `assistant/chunk`（官方 `KNOWN_SESSION_EVENT_TYPES` 原样即正确）；
 *      v2 需要 `assistant/attempt`（官方 v2 dispositions = v0 − assistant/chunk + assistant/attempt）。
 *
 * 形态：
 * - 文件版本 0/1 → **vendored v0 词表**（来源：App 内置 `dsh-session-format-v0-to-v1` 的
 *   `RELEASED_V0_EVENT_DISPOSITIONS`，51 条，逐条比对零差异）；
 * - 文件版本 2 → (v0 词表 − `assistant/chunk`) ∪ {`assistant/attempt`}（官方 v2 dispositions
 *   构造式实测：chunk 被显式剔除；见 `V2_EVENT_TYPES` 注释）；
 * - 文件版本 3 → **运行时导出**的 `KNOWN_SESSION_EVENT_TYPES`；
 * - 折叠终验：v0/v1/v2 → `legacyFoldSurface`；v3 → 运行时 `foldSurface`。
 */
import { foldSurface, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createRequire } from 'node:module';
import { legacyFoldSurface } from './legacy-fold.js';

/** v0/v1 词表（vendored；来源见文件头注释，与官方 v0 dispositions 逐条对应）。 */
export const V0_EVENT_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/chunk', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
  'compaction/start', 'compaction/summary', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
  'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context',
  'request/header', 'sandbox/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted',
  'session/end-seed', 'session/title', 'session/title-llm-request', 'step/end', 'step/start',
  'subagent/descriptor', 'subagent/model-selection-policy', 'team/member', 'team/message/delivered',
  'team/message/queued', 'team/task', 'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start',
  'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call', 'tool/code-dispatch',
  'tool/code-dispatch-start', 'tool/result', 'turn/end', 'turn/start', 'user/message',
  'web/deepseek-search-llm-request',
]);

/**
 * v2 词表（官方 `RELEASED_V2_EVENT_DISPOSITIONS` 推导；App 2.0.9 内置
 * `dsh-session-format-v2-to-v3` 的构造式逐字实测）：
 *   retained = v0 − {assistant/chunk, assistant/message, session-log-deepseek/delivery-accepted, session/end-seed}
 *   v2 = retained ∪ {assistant/attempt, assistant/message, delivery-accepted, session/end-seed}
 *      = v0 − assistant/chunk + assistant/attempt
 * ⇒ **v2 不含 `assistant/chunk`**（旧实现误用 `V0 ∪ {attempt}`，把 chunk 留在 v2 词表里 =
 * 宽松口径，会漏报 v2 里的顶层 chunk 行 ⇒ F9 修正）。
 */
export const V2_EVENT_TYPES = new Set([
  ...[...V0_EVENT_TYPES].filter((t) => t !== 'assistant/chunk'),
  'assistant/attempt',
]);

/** 旧的顶层 `{start,end}` replace 语义适用的最高文件版本（v3 起改为 `{startSeq,endSeq}`）。 */
export const LEGACY_FORMAT_MAX_VERSION = 2;

/**
 * 当前应使用的词表（**必须显式传 version**）。
 *
 * 这里**不再有模块级可变全局**：旧实现 `let fileVersion` + `setFileFormatVersion()`（唯一写入点
 * `validate.js`）会让同一进程里后调用的 prewrite 读到**别人文件**的版本——C2 实测：先
 * validate(v3) 再 prewrite(v0)，同一份合法 v0 输入的结论从 ok 翻成 S4+S8。改为参数后，
 * 每个入口各自持有本次被检文件的版本。
 */
export function currentVocabulary(version) {
  if (version <= 1) return V0_EVENT_TYPES;
  if (version === 2) return V2_EVENT_TYPES;
  return KNOWN_SESSION_EVENT_TYPES;
}

/** 当前可用的**终验**折叠：旧格式用本地等价实现，v3 用运行时导出。 */
export function currentFold(version) {
  return isLegacyFormat(version) ? legacyFoldSurface : foldSurface;
}

/** 文件版本是否属于"旧格式"（v0/v1/v2：`{start,end}` replace + 允许 assistant/message 携带 sourceEventSeqs）。 */
export function isLegacyFormat(version) {
  return version <= LEGACY_FORMAT_MAX_VERSION;
}

/**
 * 从事件形状推断文件版本——调用方只给 `events`、拿不到 header 时的兜底（C2）。
 * 判据（可靠性从高到低）：
 *   1. replace 的字段名：v3 `{startSeq,endSeq}` / v0–v2 `{start,end}`（最强，直接决定 S4/S8 路由）；
 *   2. `system/message`：官方 v3 才有的 surface 类型（V0/V2 词表均无）；
 *   3. `assistant/chunk`：顶层 chunk 行只在旧格式出现（v2 dispositions 已剔除它）；
 *   4. `assistant/attempt`：v2 与 v3 都有（v0 无）⇒ 只能推出"≥2"。
 * 返回 3 / 2 / 0。**这是启发式**；有 `header.version` 或显式 `formatVersion` 时优先用它们。
 */
export function inferFormatVersion(events = []) {
  return inferFormatVersionDetailed(events) ?? 0;
}

/**
 * 同上，但**没有判别证据时返回 `null`**（而不是假装 0）——供版本支持面报"未验证格式"
 * （2026-09-14 用户要求第 1 条：无法识别格式 ⇒ 报未验证并按只读处理）。
 * @returns {3|2|0|null} 版本号；null = 事件里没有任何判别特征
 */
export function inferFormatVersionDetailed(events = []) {
  let sawLegacyReplace = false;
  let sawModernReplace = false;
  let sawSystemMessage = false;
  let sawChunk = false;
  let sawAttempt = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const op = event.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace') {
      if (Object.hasOwn(op, 'startSeq') || Object.hasOwn(op, 'endSeq')) sawModernReplace = true;
      else if (Object.hasOwn(op, 'start') || Object.hasOwn(op, 'end')) sawLegacyReplace = true;
    }
    if (event.type === 'system/message') sawSystemMessage = true;
    else if (event.type === 'assistant/chunk') sawChunk = true;
    else if (event.type === 'assistant/attempt') sawAttempt = true;
  }
  if (sawModernReplace || sawSystemMessage) return 3;
  if (sawLegacyReplace) return sawAttempt ? 2 : 0;
  if (sawAttempt) return 2;
  if (sawChunk) return 0;
  return null;   // 无证据：调用方（版本支持面）据此报"未验证格式"
}

/**
 * 解析版本 + **来源**（版本支持面用）：显式 `formatVersion` > `header.version` > 事件形状推断 > 无证据。
 * @param {{formatVersion?:number, header?:object|null, events?:Array}} [input]
 * @returns {{version:number, source:'explicit'|'header'|'inferred'|'default', evidence:string|null}}
 */
export function resolveFormatVersionDetailed({ formatVersion, header, events } = {}) {
  if (Number.isSafeInteger(formatVersion) && formatVersion >= 0) {
    return { version: formatVersion, source: 'explicit', evidence: null };
  }
  if (header && Number.isSafeInteger(header.version) && header.version >= 0) {
    return { version: header.version, source: 'header', evidence: null };
  }
  const inferred = inferFormatVersionDetailed(events ?? []);
  if (inferred !== null) {
    return { version: inferred, source: 'inferred', evidence: 'replace 字段名/system/message/assistant/{chunk,attempt} 形状' };
  }
  return { version: 0, source: 'default', evidence: null };
}

/**
 * 解析本次校验应使用的文件版本：显式 `formatVersion` > `header.version` > 事件形状推断 > 0。
 * @param {{formatVersion?:number, header?:object|null, events?:Array}} [input]
 * @returns {number}
 */
export function resolveFormatVersion({ formatVersion, header, events } = {}) {
  if (Number.isSafeInteger(formatVersion) && formatVersion >= 0) return formatVersion;
  if (header && Number.isSafeInteger(header.version) && header.version >= 0) return header.version;
  return inferFormatVersion(events ?? []);
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主能力闸（S2）——**被检文件版本 > 宿主支持的最大版本**时不能按本宿主语义判定。
// 一手依据：`@deepseek-ai/dsh-session` 导出 `SESSION_FORMAT_VERSION`（rc.7 = 0，0.1.5 = 3），
// 词表 `KNOWN_SESSION_EVENT_TYPES` 与 `foldSurface` 都随它变。rc.7 上拿 v3 文件跑本包的
// v3 语义检查会产出**假阳性**（实测 S8×1 + E3×40 / verdict=broken），危险在于用户会以为
// 日志坏了去跑 `fix --apply`。故此处显式暴露宿主能力，由入口输出"不可在本宿主评估"档。
// ─────────────────────────────────────────────────────────────────────────────

/** 本宿主支持的最大被检文件版本（= 运行时 `SESSION_FORMAT_VERSION`；缺失按 0）。 */
export const HOST_MAX_FILE_VERSION = Number.isSafeInteger(SESSION_FORMAT_VERSION) && SESSION_FORMAT_VERSION >= 0
  ? SESSION_FORMAT_VERSION
  : 0;

/**
 * 官方迁移链的目标格式版本（固定 3）——**不是宿主版本**。
 * 依据：App 2.0.9 / `@deepseek-ai/dsh-session-format-*@0.1.5-rc.2` 的迁移链是 v0→v1→v2→v3，
 * `SESSION_FORMAT_VERSION = 3`。迁移预检问的是"升到目标格式会不会被拒"，与当前宿主能不能
 * 评估 v3 **无关**（rc.7 宿主上同样可以预检一个 v0 文件将来能否升级）。
 */
export const MIGRATION_TARGET_VERSION = 3;

let hostVersionMemo;
/** 宿主 `@deepseek-ai/dsh-session` 的包版本（用于输出/报告；不可解析时给未知标记，不抛）。 */
export function hostPackageVersion() {
  if (hostVersionMemo !== undefined) return hostVersionMemo;
  try {
    const req = createRequire(import.meta.url);
    hostVersionMemo = String(req('@deepseek-ai/dsh-session/package.json').version);
  } catch {
    hostVersionMemo = `unknown (SESSION_FORMAT_VERSION=${HOST_MAX_FILE_VERSION})`;
  }
  return hostVersionMemo;
}

/** 被检文件版本能否在本宿主上按其自身语义评估。
 *
 * 判据（两层）：
 * - **v0/v1/v2**：本包自带 vendored 词表 + 本地等价折叠（`legacyFoldSurface`），**宿主无关** ⇒ 任何宿主都能评估；
 * - **v3+**：词表用运行时 `KNOWN_SESSION_EVENT_TYPES`、折叠用运行时 `foldSurface` ⇒
 *   需要宿主 `SESSION_FORMAT_VERSION >= 该版本`（rc.7 = 0 ⇒ v3 不可评估）。
 */
export function isAssessableFileVersion(version) {
  if (!Number.isSafeInteger(version) || version < 0) return false;
  if (version <= LEGACY_FORMAT_MAX_VERSION) return true;
  return version <= HOST_MAX_FILE_VERSION;
}

/** 宿主能力描述（CLI/--json 共用）。 */
export function hostCapability() {
  return {
    hostPackage: hostPackageVersion(),
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
  };
}
