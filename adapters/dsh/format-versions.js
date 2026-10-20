/**
 * dsh-log-contract · adapters/dsh/format-versions.js
 *
 * DSH 专属：会话格式版本路由 v0–v4、词表、宿主能力与版本支持面。
 *
 * 契约层只认「版本是一个非负整数、受支持集合由适配器给出、容器头声明其记录族」；
 * 本文件提供 DSH 的词表（v0/v2 vendored + 运行时词表）、版本推断/解析、宿主能力闸、
 * 支持面检测，以及按文件版本的迁移预检与继承计数语义。
 */
import { createRequire } from 'node:module';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { foldSurface, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { violation } from './rule-ids.js';
import { isSafeInt } from '../../contract/invariants.js';
import { legacyFoldSurface } from './surface.js';
import { resolveIgnorableWhitelist, isIgnorableRegistered } from './vocab.js';

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
 * `dsh-session-format-v2-to-v3` 的构造式推导）：
 *   retained = v0 − {assistant/chunk, assistant/message, session-log-deepseek/delivery-accepted, session/end-seed}
 *   v2 = retained ∪ {assistant/attempt, assistant/message, delivery-accepted, session/end-seed}
 *      = v0 − assistant/chunk + assistant/attempt
 * ⇒ **v2 不含 `assistant/chunk`**（把 chunk 留在 v2 词表里会漏报 v2 里的顶层 chunk 行
 * ⇒ 已修正）。
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
 * `validate.js`）会让同一进程里后调用的 prewrite 读到**别人文件**的版本——先
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
 * v4 判别特征（v3→v4 迁移逐项改写，v3 不可能出现）先于以上各条：`developer/message` 事件、
 * role 为 `tool` 的 `tool/result`、source.kind 为 `system-prompt` 的 `system/message`。
 * 返回 4 / 3 / 2 / 0。**这是启发式**；有 `header.version` 或显式 `formatVersion` 时优先用它们。
 */
export function inferFormatVersion(events = []) {
  return inferFormatVersionDetailed(events) ?? 0;
}

/**
 * 同上，但**没有判别证据时返回 `null`**（而不是假装 0）——供版本支持面报"未验证格式"
 * （无法识别格式 ⇒ 报未验证并按只读处理）。
 * @returns {4|3|2|0|null} 版本号；null = 事件里没有任何判别特征
 */
export function inferFormatVersionDetailed(events = []) {
  let sawLegacyReplace = false;
  let sawModernReplace = false;
  let sawSystemMessage = false;
  let sawChunk = false;
  let sawAttempt = false;
  let sawV4Shape = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const op = event.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace') {
      if (Object.hasOwn(op, 'startSeq') || Object.hasOwn(op, 'endSeq')) sawModernReplace = true;
      else if (Object.hasOwn(op, 'start') || Object.hasOwn(op, 'end')) sawLegacyReplace = true;
    }
    if (event.type === 'system/message') {
      sawSystemMessage = true;
      if (event.data?.message?.source?.kind === 'system-prompt') sawV4Shape = true;
    } else if (event.type === 'developer/message') sawV4Shape = true;
    else if (event.type === 'tool/result' && event.data?.message?.role === 'tool') sawV4Shape = true;
    else if (event.type === 'assistant/chunk') sawChunk = true;
    else if (event.type === 'assistant/attempt') sawAttempt = true;
  }
  if (sawV4Shape) return 4;
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
    return { version: inferred, source: 'inferred', evidence: 'replace 字段名/system/message/developer/message/tool/result role/assistant/{chunk,attempt} 形状' };
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
// v3 语义检查会产出**假阳性**（S8/E3 误报 / verdict=broken），危险在于用户会以为
// 日志坏了去跑 `fix --apply`。故此处显式暴露宿主能力，由入口输出"不可在本宿主评估"档。
// ─────────────────────────────────────────────────────────────────────────────

/** 本宿主支持的最大被检文件版本（= 运行时 `SESSION_FORMAT_VERSION`；缺失按 0）。 */
export const HOST_MAX_FILE_VERSION = Number.isSafeInteger(SESSION_FORMAT_VERSION) && SESSION_FORMAT_VERSION >= 0
  ? SESSION_FORMAT_VERSION
  : 0;

/**
 * 官方迁移链的目标格式版本——**下限 3，不随旧宿主降级**。
 * 依据：App 2.0.9 / `@deepseek-ai/dsh-session-format-*@0.1.5-rc.2` 的迁移链是 v0→v1→v2→v3
 * （`SESSION_FORMAT_VERSION = 3`）；DSH 0.2.x 追加 `dsh-session-format-v3-to-v4`（`= 4`）。
 * 迁移预检问的是"升到目标格式会不会被拒"，与当前宿主能不能评估 v3 **无关**（rc.7 宿主上同样
 * 可以预检一个 v0 文件将来能否升级），所以旧宿主仍按 3；带 v3→v4 迁移的宿主上目标随之为 4。
 */
export const MIGRATION_TARGET_VERSION = Math.max(3, HOST_MAX_FILE_VERSION);

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

// ── 版本支持面（测试基线 + 运行时检测/告警）──────────────────────────────────
/**
 * **测试基线**（唯一权威）：本规则集在下列宿主 / 会话格式版本上被验证。
 * 改这里必须同步 README（中英）与 docs/CONTRACTS.md 头部（生成器模板）。
 */
export const TESTED_BASELINE = Object.freeze({
  hostPackage: '@deepseek-ai/dsh-session',
  /** 开发机与 CI 实装宿主版本（devDependency 同值;= DSH Desktop 0.2.0 内置版本）。 */
  hostVersion: '0.2.0-rc.2',
  /** 声明的 peer 范围（允许安装,但未逐一验证）。 */
  peerRange: '^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.2.0-rc.1',
  /** 会话格式版本基线（= 宿主 SESSION_FORMAT_VERSION）。 */
  sessionFormatVersion: 4,
  /** 已知/受支持的会话格式版本（0/1/2 由本包 vendored 词表 + 本地等价折叠支持）。 */
  knownFormatVersions: Object.freeze([0, 1, 2, 3, 4]),
  note: '旧格式（0/1/2）由本包自带的 vendored 词表与 legacyFoldSurface 支持,与宿主版本无关;'
    + 'v3/v4 用运行时词表/官方 foldSurface ⇒ 需要宿主 SESSION_FORMAT_VERSION ≥ 该版本;'
    + 'v4 消息形状（tool/result role tool、system-prompt source、developer/message）按文件版本单独判定。',
});

/**
 * 语义化版本比较（只处理 `x.y.z[-pre[.n]]`;不认识 → null = 不可比较）。
 * 预发布版 < 同号正式版（0.1.5-rc.1 < 0.1.5）。
 * @returns {-1|0|1|null}
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ''));
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 被检文件格式版本 → 支持档（`baseline` = 与测试基线同版;`legacy` = 旧格式,由本包自带实现支持）。 */
function fileStatusOf(version) {
  if (!TESTED_BASELINE.knownFormatVersions.includes(version)) return 'unverified';
  return version === TESTED_BASELINE.sessionFormatVersion ? 'baseline' : 'legacy';
}

/**
 * **运行时版本检测**：宿主版本 + 被检文件格式版本,与测试基线对比。
 *
 * @param {{header?:object|null, events?:Array, formatVersion?:number}} [input]
 * @returns {{baseline:object, host:object, file:object, warnings:string[], readOnly:boolean, summary:string}}
 *   `readOnly === true` ⇒ 调用方**不得**给出写入结论（prewrite/fix 必须拒绝）——
 *   触发条件:被检文件格式版本未知(不在 knownFormatVersions 内),或格式完全无法识别。
 */
export function detectSupport({ header, events, formatVersion, hostVersion: hostOverride } = {}) {
  const warnings = [];
  // ── 宿主 ────────────────────────────────────────────────────────────────
  // `hostVersion` 仅用于测试/演示（注入"比基线新的宿主"场景），生产路径不传。
  const hostVersion = hostOverride ?? hostPackageVersion();
  const hostCmp = compareVersions(hostVersion, TESTED_BASELINE.hostVersion);
  let hostStatus;
  if (hostCmp === null) {
    hostStatus = 'unknown';
    warnings.push(`宿主 ${TESTED_BASELINE.hostPackage} 版本不可解析（${hostVersion}）——无法与测试基线 ${TESTED_BASELINE.hostVersion} 比对;结论按"未验证"对待。`);
  } else if (hostCmp > 0) {
    hostStatus = 'newer-than-baseline';
    warnings.push(`宿主 ${TESTED_BASELINE.hostPackage}@${hostVersion} **比测试基线 ${TESTED_BASELINE.hostVersion} 新** —— 本规则集未在该宿主上验证,官方语义可能已变（词表/折叠/replace 字段）;结论可能不适用,请先核对上游变更或升级本包基线。`);
  } else if (hostCmp < 0) {
    hostStatus = 'older-than-baseline';
    warnings.push(`宿主 ${TESTED_BASELINE.hostPackage}@${hostVersion} 比测试基线 ${TESTED_BASELINE.hostVersion} 旧（仍在声明的 peer 范围 ${TESTED_BASELINE.peerRange} 内）—— v3 文件需要宿主能提供对应词表/折叠（本宿主 SESSION_FORMAT_VERSION=${HOST_MAX_FILE_VERSION}）。`);
  } else {
    hostStatus = 'baseline';
  }

  // ── 被检文件格式 ────────────────────────────────────────────────────────
  const resolved = resolveFormatVersionDetailed({ formatVersion, header, events });
  const unknownSource = resolved.source === 'default';
  // S4:无法识别格式时**状态标签必须是 `unverified`**（README 就是这么写的:
  // "Format unrecognisable → same: "unverified format" + read-only"）。旧实现让版本回落到默认 0
  // ⇒ 标签打印成 `legacy`，与 README 不一致（`readOnly` 本来就对）。
  const status = unknownSource ? 'unverified' : fileStatusOf(resolved.version);
  const readOnly = unknownSource || status === 'unverified';
  if (unknownSource) {
    warnings.push('被检文件格式版本**无法识别**（无 header.version,且事件形状无判别特征:S4 replace 字段名 / system/message / assistant/chunk / assistant/attempt 皆未见）——按"未验证格式"处理,仅只读。');
  } else if (status === 'unverified') {
    warnings.push(`被检文件格式版本 ${resolved.version} **不在已知集合 {${TESTED_BASELINE.knownFormatVersions.join(',')}}** 内（来源 ${resolved.source}）——按"未验证格式"处理,仅只读;不得据此判定可写/可修。`);
  }
  const file = {
    version: resolved.version,
    source: resolved.source,   // explicit | header | inferred | default
    status,                    // baseline | legacy | unverified
    known: status !== 'unverified' && !unknownSource,
    evidence: resolved.evidence ?? null,
  };
  // 无法识别时版本号是占位 0 —— 显示成 `?`（否则"文件格式 v0（default,unverified）"自相矛盾）
  const versionLabel = unknownSource ? '?' : `v${file.version}`;
  const summary = `宿主 ${TESTED_BASELINE.hostPackage}@${hostVersion}（基线 ${TESTED_BASELINE.hostVersion},${hostStatus}）`
    + ` ｜ 文件格式 ${versionLabel}（${file.source},${status}${readOnly ? ',只读' : ''}）`;
  return {
    baseline: TESTED_BASELINE,
    host: {
      package: TESTED_BASELINE.hostPackage,
      version: hostVersion,
      sessionFormatVersion: HOST_MAX_FILE_VERSION,
      status: hostStatus,
      tested: hostStatus === 'baseline',
      newerThanBaseline: hostStatus === 'newer-than-baseline',
    },
    file,
    warnings,
    readOnly,
    summary,
  };
}

/** 从 `loadSessionLog()` 的结果算支持面（CLI/调用方共用）。 */
export function supportOfLog(log) {
  return detectSupport({ header: log?.header ?? null, events: (log?.events ?? []).map((e) => e.event ?? e) });
}

// ── 折叠终验的路由（按被检文件版本择路）──────────────────────────────────────
/** 折叠终验：**按文件版本**择路。
 *
 * - v3 文件 → 运行时导出的官方 `foldSurface`（与运行时同语义）；
 * - v0/v1/v2 文件 → 本地 `legacyFoldSurface`（rc.7 `foldSurface` 逐条移植）。
 *
 * 为什么旧格式不能借用官方实现的 `violations` 字段：官方 `foldSurface` **只抛不报**，
 * 曾回退到 `replaySurface` 的 violations，但**没有任何调用方读它**
 * （validate.js / prewrite.js 只看 `folded.error`）⇒ S8 在旧格式上永不触发。
 * 现在两条路径都是"抛错 = 拒绝"的同一种契约。 */
export function finalFold(events, version) {
  const fold = currentFold(version);
  try {
    return { surface: fold(events) };
  } catch (err) {
    return { error: err };
  }
}

// ── 迁移预检（独立维度：官方升级路径会不会拒）─────────────────────────────────
/**
 * G · 迁移预检（payload 层 + 类型层）——**官方迁移会不会拒**，与"本工具能否读取/折叠"是
 * **两个独立维度**（见 contracts.js 的 LAYER.MIGRATION 段）。
 *
 * 覆盖（每条都有一手出处，官方 `@0.1.5-rc.2`）：
 * - **G1** `subagent/descriptor.data.version !== 3`
 * - **G2** 事件类型不在官方 v0 dispositions 内（含 `ignorable:true`）
 * - **G3** `session/title` / `session/title-llm-request` 的 `messageSeqs`（`v0-to-v1/lib/index.js:[n]-[n]`）
 *
 * 仍未覆盖（由 `migrationVerdict().coverage.uncovered` 显式列出，**不许**当通过）：
 * `turn/start`（闭合/预期轮）、继承切点、`assistant/attempt` 配对、`stored log corrupt`、
 * v0→v1 对其余事件的形状拒绝。
 *
 * **为什么 `turn/start` 不做**：官方那个状态机（`v0-to-v1:[n]` 的
 * `assertReleasedArtifactRelationships`）**不是**在原始 v0 事件上跑的——它由 **v1→v2**
 * 以 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 调用在**变换后的 v1/v2 artifact** 上
 * （`v1-to-v2/lib/index.js:[n]`），并带 `cut`（继承切点）处理。在原始 v0 上照抄该
 * 状态机会在**已 seed 的会话**上狂报（官方 v0→v1 并不以该规则拒绝），
 * 属"规则文本对、应用对象错"。要忠实复现必须先把 v0→v1→v2 的
 * 变换做出来 ⇒ 记未覆盖。
 *
 * 范围：三条都只约束 **v0 源文件**（官方 v0→v1 迁移的规则；v1/v2 源走别的迁移代码）。
 * severity 固定 warning、layer 固定 migration ⇒ 不进 ok / loadable / resumable / compactable。
 *
 * @param {Array<{event:object, lineNo?:number}>} events 已展开事件（带 loc 包装）
 * @param {number} version 被检文件版本
 */
export function migrationPrecheckViolations(events, version, opts = {}) {
  const out = [];
  if (version !== 0) return out;
  const ignorableWhitelist = resolveIgnorableWhitelist(opts.ignorableWhitelist);
  for (const { event, lineNo } of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'subagent/descriptor') {
      const dv = event.data?.version;
      if (dv !== 3) {
        out.push(violation('G1', { seq: event.seq, lineNo, eventType: event.type },
          `subagent/descriptor data.version=${JSON.stringify(dv)}（官方 v0→v1 迁移要求 === 3）—— 升级到当前格式时官方会拒绝：subagent/descriptor ${event.seq} uses unsupported descriptor version ${String(dv)}`));
      }
    }
    if (typeof event.type === 'string' && !V0_EVENT_TYPES.has(event.type)) {
      // 官方对"unknown historical event"一律拒（原文 even when ignorable）；E3 的 ignorable
      // 豁免只作用于**读取路径**，这里不改它，只在迁移维度表达。
      // G4：把"是否声明可忽略 + 是否已登记"作为**机读字段**带出——事实预检（G2）
      // 保留不变，但 migrationVerdict 据此把"已登记的可忽略事件"移入 acceptedDrops（不阻断）。
      const ignorable = event.ignorable === true;
      const ignorableRegistered = ignorable && isIgnorableRegistered(event.type, ignorableWhitelist);
      out.push(violation('G2', { seq: event.seq, lineNo, eventType: event.type },
        `type "${event.type}" 不在官方 v0 dispositions 内${ignorable ? '（即使 ignorable:true）' : ''}—— 官方迁移会拒：format v0 contains unknown historical event type`,
        { ignorable, ignorableRegistered }));
    }
  }
  // ── G3 · session/title 系列 messageSeqs（官方 v0→v1 `assertTitleSources`，:[n]-[n]）──
  // 判据：每个被引 seq 必须解析到更早的 `user/message`，且 `data.source.kind === 'user'`；
  // 另 `session/title` 的 `source.kind === 'user'` ⟺ `messageSeqs` 空。
  //
  // ⚠️ 应用面说明：官方 `assertTitleSources` 与 `turn/start` 状态机
  //    同在 `assertReleasedArtifactRelationships` 里，而该函数被 **v1→v2** 以
  //    `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 调用在**变换后的 v1/v2 artifact** 上
  //    （`dsh-session-format-v1-to-v2/lib/index.js:[n]`），不是原始 v0 事件。
  //    对 `messageSeqs` 这类"按 seq 索引 + 事件类型/source 判定"的引用，变换保序保类型
  //    ⇒ 在原始 v0 上判是**必要条件的近似**；真实 v0 上未观察到误报。
  const bySeq = new Map();
  for (const { event } of events) if (event && typeof event === 'object') bySeq.set(event.seq, event);
  for (const { event, lineNo } of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type !== 'session/title' && event.type !== 'session/title-llm-request') continue;
    const seqs = event.data?.messageSeqs;
    if (!Array.isArray(seqs)) {
      out.push(violation('G3', { seq: event.seq, lineNo, eventType: event.type },
        `${event.type} ${event.seq} 的 messageSeqs 必须是数组 —— 官方迁移会拒`));
      continue;
    }
    if (event.type === 'session/title') {
      const kind = event.data?.source?.kind;
      if ((seqs.length === 0) !== (kind === 'user')) {
        out.push(violation('G3', { seq: event.seq, lineNo, eventType: event.type },
          `session/title ${event.seq} messageSeqs must be empty exactly for a user title（官方原文；source.kind=${String(kind)}，seqs=${seqs.length}）`));
      }
    }
    for (const s of seqs) {
      const src = bySeq.get(s);
      if (!src || src.type !== 'user/message' || src.data?.source?.kind !== 'user') {
        out.push(violation('G3', { seq: event.seq, lineNo, eventType: event.type },
          `${event.type} ${event.seq} messageSeqs must cite earlier human user/message events（seq ${String(s)} 不是更早的人类 user/message）`));
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

// v4 契约补充最小集
// 5 条硬规则：S10 / I2 / P5 / G4 / A1。判据只新增/收严，不改既有规则的判定。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I2 —— `seedLength` 语义钉死 + `parentSession ∧ seedLength∈{缺失,0}` 合法。
 *
 * 一手依据（`@deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2`）：
 * - `package/lib/index.js:[n]` `seedLength` → `inheritedEventCount`（缺省 0）；
 * - `:[n]` `isSeeded = record["seedLength"] !== undefined`（是否 seeded **只由字段是否存在决定**）；
 * - `:[n]-[n]` `inheritedEventCount > events.length` → "Session inheritedEventCount exceeds its event count"；`!isSeeded && inheritedEventCount !== 0` → "unseeded Session inheritedEventCount must be 0"。
 *
 * 结论（不再猜）：
 * - **`parentSession` 有值 ≠ seeded**：血缘关系与继承计数是两件事。真实日志中头带
 *   `parentSession` 且**无** `seedLength`（`isSeeded:false`）仍正常加载 ⇒
 *   `parentSession ∧ seedLength∈{缺失,0}` 判 **合法**（不告警、不拒）。
 * - `seedLength` 超过**展开后**事件数 ⇒ error（这类值明显是字节数/其它语义，官方迁移必拒）。
 * - v4 运行时头**禁** `seedLength`（dsh-session@0.2.0-rc.2 lib/index.js:[n]）⇒ v4 文件带该字段 error。
 *
 * @param {object|null} header
 * @param {Array<object>} events 展开后事件（chunk 行已展开），用于比较继承条数
 * @param {number} version 被检文件版本
 * @returns I2 违规列表
 */
export function seedLengthViolations(header, events, version) {
  const out = [];
  if (!header || typeof header !== 'object') return out;
  const has = Object.hasOwn(header, 'seedLength');
  if (version >= 4) {
    if (has) {
      out.push(violation('I2', {}, `v4 会话头不得带 seedLength（实际 ${String(header.seedLength)}）——宿主 header 校验直接拒："session header has invalid field \\"seedLength\\""（dsh-session@0.2.0-rc.2 lib/index.js:[n]）；v4 用 isSeeded + 构造器 inheritedEventCount，不落盘该字段`));
    }
    return out;
  }
  if (!has) return out;
  const seedLength = header.seedLength;
  if (!isSafeInt(seedLength)) {
    out.push(violation('I2', {}, `header.seedLength 必须是非负安全整数（实际 ${String(seedLength)}）——语义 = 继承事件条数（官方 inheritedEventCount），不是字节数`));
    return out;
  }
  const count = Array.isArray(events) ? events.length : 0;
  if (seedLength > count) {
    out.push(violation('I2', {}, `header.seedLength=${seedLength} 大于展开后事件数 ${count}——seedLength 语义是**继承事件条数**（官方 inheritedEventCount），不是字节数/行数；官方解码/迁移会抛 "Session inheritedEventCount exceeds its event count"（dsh-session-format-v0-to-v1@0.2.0-rc.2 :[n]-[n]）`));
  }
  return out;
}

/**
 * G4 —— 未知历史事件的"声明式可忽略"策略（**迁移维度**，仅 v0 源文件）。
 *
 * 规则：`未知类型 ∧ ignorable:true ⇒ 允许按声明丢弃并登记`（⛔ 不静默）。
 * - **已登记**（白名单命中）⇒ **不报违规**，进 `registered`（acceptedDrop）——迁移不再因它硬拒；
 * - **未登记** ⇒ G4 warning（仍阻断迁移：⛔ 不静默），提示登记到白名单；
 * - 未知且**无** ignorable ⇒ 不归本条（E3 读路径 error；G2 迁移事实预检）。
 *
 * 只作用于 v0（G 层是 v0→v1 迁移预检维度）；v3/v4 的 ignorable 语义由 E3 表达，不改。
 *
 * @param {Array<{event:object,lineNo?:number}>} events
 * @param {number} version 被检文件版本
 * @param {{ignorableWhitelist?:string[]}} [opts]
 * @returns {{violations:Array, registered:Array, unregistered:Array}}
 */
export function declarativeIgnorableViolations(events, version, { ignorableWhitelist } = {}) {
  const whitelist = resolveIgnorableWhitelist(ignorableWhitelist);
  const registered = [];
  const unregistered = [];
  const violations = [];
  if (version !== 0) return { violations, registered, unregistered };
  for (const { event, lineNo } of events ?? []) {
    if (typeof event?.type !== 'string' || event.ignorable !== true) continue;
    if (V0_EVENT_TYPES.has(event.type)) continue; // 已知历史事件，不属本条
    const loc = { seq: event.seq, lineNo, eventType: event.type };
    if (isIgnorableRegistered(event.type, whitelist)) {
      registered.push({ type: event.type, seq: typeof event.seq === 'number' ? event.seq : null, lineNo: typeof lineNo === 'number' ? lineNo : null });
      continue;
    }
    unregistered.push({ type: event.type, seq: typeof event.seq === 'number' ? event.seq : null, lineNo: typeof lineNo === 'number' ? lineNo : null });
    violations.push(violation('G4', loc, `type "${event.type}" 是未知历史事件且带 ignorable:true，但不在可忽略白名单——按声明丢弃会被静默吞掉（⛔ 不静默）；登记到 opts.ignorableWhitelist / DSH_LOG_CONTRACT_IGNORABLE_WHITELIST（精确 type 或以 / 结尾的前缀）后才移出迁移阻断`));
  }
  return { violations, registered, unregistered };
}


// ── 会话头字段约束（H2）──────────────────────────────────────────────────────

/**
 * `header.cwd` 的"绝对路径"判据 —— **平台感知**（Issue #1）。
 *
 * 旧实现只认 POSIX 的 `/` 前缀 ⇒ Windows 会话的 `C:\…` / `\\server\share\…` 全部误报 H2
 * （体检是离线、跨机只读的：被检日志可能来自任意平台，不能按运行宿主 `process.platform` 判）。
 * 两种形态都接受：
 * - POSIX：`/home/user`、`/home/x`
 * - Windows 盘符绝对：`C:\Users\x`、`C:/home/user`
 * - Windows UNC：`\\server\share\x`、`//server/share/x`
 *
 * 反例（仍报 H2）：`C:relative`（盘符相对）、`Users/x`、`./x`、空串。
 */
export function isAbsoluteLogPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  return posixPath.isAbsolute(value) || win32Path.isAbsolute(value);
}

/** 宿主能力闸触发时**跳过**的规则（v3/被检版本语义相关）——报告里显式列出，避免"静默通过"。 */

export const VERSION_DEPENDENT_RULES = ['E3', 'E7', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'W1', 'W2', 'T1', 'T2', 'T3', 'T4', 'T5', 'G1', 'G2', 'G4', 'P5'];

/**
 * 会话头字段约束（H2）：版本属于已知格式集合、必填字段类型/取值域合法。
 * @param {object|null} header 已解析的会话头（解析失败为 null ⇒ 不判本组）
 * @param {number} headerLine 会话头所在行号
 * @returns {Array<object>} H2 判定
 */
export function headerFieldViolations(header, headerLine) {
  if (header === null) return [];
  const out = [];
  if (![0, 1, 2, 3, 4].includes(header.version)) {
    out.push(violation('H2', { lineNo: headerLine }, `header.version 未知（实际 ${String(header.version)}）——已知 0/1/2/3/4；未知版本按 0 处理会误判，请先确认格式`));
  }
  if (typeof header.id !== 'string' || header.id === '') out.push(violation('H2', { lineNo: headerLine }, 'header.id 必须为非空字符串'));
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) out.push(violation('H2', { lineNo: headerLine }, 'header.createdAt 必须为非负安全整数'));
  if (header.cwd !== undefined && !isAbsoluteLogPath(header.cwd)) out.push(violation('H2', { lineNo: headerLine }, 'header.cwd 若存在必须为绝对路径（POSIX 或 Windows 形态）'));
  if (header.origin !== undefined && header.origin !== 'subagent') out.push(violation('H2', { lineNo: headerLine }, `header.origin 只能为 "subagent"（实际 ${String(header.origin)}）`));
  return out;
}

// ── 判定结论（迁移维度 / 恢复档位）───────────────────────────────────────────

/**
 * 迁移预检结论（S1）——**独立维度**：官方把 v0/v1/v2 升到当前格式会不会拒。
 *
 * 与 `ok` / `loadable` / `resumable` / `compactable` **并列且互不蕴含**：
 * 本工具判 ok **不代表**官方迁移会接受（反之亦然）。只统计 `layer === 'migration'` 的违规
 * （G1/G2），并**显式声明覆盖边界**——未覆盖的官方迁移规则不等于通过。
 *
 * @param {object} result `validateSessionLog()` 的返回值
 */
export function migrationVerdict(result) {
  const violations = result?.violations ?? [];
  const fileVersion = result?.summary?.fileVersion ?? result?.notAssessable?.fileVersion ?? null;
  const coverage = {
    implemented: [
      'G1  v0 源：subagent/descriptor.data.version !== 3',
      'G2  v0 源：事件类型不在官方 v0 dispositions 内（含 ignorable:true）',
      'G3  v0 源：session/title 系列 messageSeqs 必须引用更早的人类 user/message（含"空 ⟺ 用户标题"）',
      'G4  v0 源：未知历史事件 + ignorable:true = 声明式可忽略（已登记白名单 ⇒ acceptedDrop，不硬拒；未登记 ⇒ warning 且仍阻断）',
    ],
    uncovered: [
      // `turn/start` 在**真实 v0 原始事件**上被判定为"应用对象错"——
      // 官方状态机（assertReleasedArtifactRelationships）由 v1→v2 在**变换后的 v1/v2 artifact**
      // 上调用（v1-to-v2/lib/index.js:[n]），带 cut/继承切点处理；在原始 v0 上照抄会在已 seed
      // 的会话上狂报（官方 v0→v1 并不以该规则拒绝）。
      // ⇒ 忠实复现需先做 v0→v1→v2 变换；暂不做，保持未覆盖。
      'turn/start 闭合/预期轮（官方 v1→v2 在**变换后** artifact 上判：does not close the prior turn / does not open expected turn）',
      'assistant/attempt 配对/闭合（migration refuses the transformed artifact）',
      'Session inheritedEventCut / 继承切点（官方在变换后 artifact 上按 cut 判；header 只有 seedLength）',
      'stored log corrupt（SessionFormatError）',
      'v0→v1 对其余事件的形状拒绝',
      'turn/end 无匹配 open turn / open step 穿越 / 未解析 tool / open compaction 穿越（官方同一状态机的其余分支）',
      'v3→v4 迁移（tool-result 提升为 role tool、plugin source 改名、父会话 subagent 目录补写、中断轮闭合；官方 dsh-session-format-v3-to-v4）',
    ],
    note: '未覆盖 ≠ 通过：本维度只对 implemented 三条负责。官方判据版本：@deepseek-ai/dsh-session-format-v0-to-v1@0.1.5-rc.2 + v1-to-v2@0.1.5-rc.2',
  };
  if (result?.assessable === false) {
    return { assessable: false, applies: null, ready: null, fileVersion, blocked: [], acceptedDrops: { registered: [], unregistered: [] }, coverage, assessmentScope: 'none', reason: result?.notAssessable?.reason ?? null };
  }
  // G4：已登记的"声明式可忽略"未知历史事件 = acceptedDrop，**不阻断**迁移；
  // G2 事实预检本身保留（仍在 violations 里，供人看"官方 v0→v1 会拒"），只是不再计入 blocked。
  // 未登记 ⇒ 仍在 blocked（⛔ 不静默：新增插件事件必须显式登记一次）。
  const registered = [];
  const unregistered = [];
  for (const v of violations) {
    if (v.layer !== 'migration') continue;
    if (v.id === 'G2' && v.ignorable === true) {
      const drop = { id: v.id, seq: v.seq ?? null, eventType: v.eventType ?? null, message: v.message };
      if (v.ignorableRegistered === true) registered.push(drop);
      else unregistered.push(drop);
    }
  }
  const acceptedDrops = { registered, unregistered };
  const blocked = violations.filter((v) => v.layer === 'migration'
    && !(v.id === 'G2' && v.ignorable === true && v.ignorableRegistered === true));
  if (fileVersion !== null && fileVersion === MIGRATION_TARGET_VERSION) {
    return { assessable: true, applies: false, ready: null, fileVersion, targetFileVersion: MIGRATION_TARGET_VERSION, blocked, acceptedDrops, coverage, assessmentScope: 'full', reason: `被检文件已是当前官方格式（version=${fileVersion}），无需迁移` };
  }
  const applies = fileVersion !== null && fileVersion < MIGRATION_TARGET_VERSION;
  return {
    assessable: true,
    applies,
    ready: applies ? blocked.length === 0 : null,
    fileVersion,
    targetFileVersion: MIGRATION_TARGET_VERSION,
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
    blocked,
    acceptedDrops,
    coverage,
    // 待迁移文件（applies=true）**只**被 2 条 G 规则覆盖，
    // 另有 6 类官方迁移规则未覆盖 ⇒ 评估范围只能是 "partial"。工具无法逐文件知道
    // 本文件是否命中未覆盖类（那要先把 6 类实现出来或跑官方迁移），但它**知道**这件事。
    assessmentScope: applies ? 'partial' : 'full',
  };
}

/**
 * resumeVerdict —— `check --resume` 三档结论（L3）。
 *
 * 回答用户「这个会话还能不能用」，三档蕴含（可压缩 ⊂ 可继续 ⊂ 可加载）：
 *   ✅ 可加载  loadable    —— 结构规则全绿（S1-S9/E 系列/W1/W2 等 error 级全清）
 *   ✅ 可继续  resumable   —— 结构绿 + I1（inbox 重放）绿
 *   ✅ 可压缩  compactable —— 前两档绿 + T1/T2（token-meter 配对）绿
 *
 * 纯聚合输出，不新增校验逻辑：直接复用 validateSessionLog 的 violations
 * 按规则 id 分组判定（离线 check 全绿但实机 token-meter 崩溃的教训——
 * T1/T2 必须单独看，不能只看 error 总数）。
 *
 * @param {{ok: boolean, violations: Array, summary: object}} result validateSessionLog 的返回值
 * @returns {{
 *   verdict: 'loadable' | 'resumable' | 'compactable' | 'broken' | 'not-assessable',
 *   assessable: boolean,
 *   loadable: boolean, resumable: boolean, compactable: boolean,
 *   migration: object,
 *   blocking: { loadable: Array, resumable: Array, compactable: Array },
 * }}
 */
export function resumeVerdict(result) {
  const { ok, violations = [] } = result;
  // 宿主能力闸（S2）：本宿主评估不了 ⇒ 新档位 `not-assessable`（**不是** broken）。
  // 三档 loadable/resumable/compactable 一律 false（不认证），原因在 notAssessable.reason。
  if (result?.assessable === false) {
    return {
      verdict: 'not-assessable',
      assessable: false,
      loadable: false,
      resumable: false,
      compactable: false,
      notAssessable: result.notAssessable ?? null,
      migration: result.migration ?? migrationVerdict(result),
      blocking: { loadable: [], resumable: [], compactable: [] },
      violationsByTier: { structural: [], inbox: [], tokenMeter: [] },
    };
  }
  // 三档各自的「阻断规则集」——按 L3 档位定义：
  //   可加载：结构层（PERSISTENCE/FRAMING）+ 引擎层非 I1/T1/T2/T3/T4 的 error；
  //   可继续：+ I1（inbox 重放）；
  //   可压缩：+ T1/T2/T3/T4（token-meter 配对 + 渲染层节点 key/turn）。
  const byId = {};
  for (const v of violations) {
    if (v.severity !== 'error') continue;
    (byId[v.id] ??= []).push(v);
  }
  const has = (id) => (byId[id]?.length ?? 0) > 0;

  // 可加载阻断 = 除 I1/T1/T2/T3/T4 外的所有 error 违规（结构/信封/物理序/工具配对等）。
  // 注意：不能用 result.ok（它把 T1/T2/T3/T4/I1 也计为 error）——三档判定按 L3 定义，
  // T1/T2/T3/T4 只影响「可压缩」档、I1 只影响「可继续」档。
  const loadableBlockers = violations.filter(
    (v) => v.severity === 'error' && !['I1', 'T1', 'T2', 'T3', 'T4', 'T5'].includes(v.id),
  ).map((v) => v.id);
  const loadable = loadableBlockers.length === 0;

  const resumableBlockers = loadable ? (has('I1') ? ['I1'] : []) : [];
  const resumable = loadable && !has('I1');

  const compactableBlockers = resumable
    ? (has('T1') || has('T2') || has('T3') || has('T4') || has('T5') ? ['T1', 'T2', 'T3', 'T4', 'T5'].filter((id) => has(id)) : [])
    : [];
  const compactable = resumable && !has('T1') && !has('T2') && !has('T3') && !has('T4') && !has('T5');

  // 最差档位
  const verdict = !loadable ? 'broken' : !resumable ? 'loadable' : !compactable ? 'resumable' : 'compactable';

  return {
    verdict,
    assessable: true,
    loadable,
    resumable,
    compactable,
    migration: result.migration ?? migrationVerdict(result),
    blocking: {
      loadable: [...new Set(loadableBlockers)],
      resumable: resumableBlockers,
      compactable: compactableBlockers,
    },
    violationsByTier: {
      structural: [...new Set(loadableBlockers)],
      inbox: has('I1') ? ['I1'] : [],
      tokenMeter: has('T1') || has('T2') || has('T3') || has('T4') || has('T5') ? ['T1', 'T2', 'T3', 'T4', 'T5'].filter((id) => has(id)) : [],
    },
  };
}
