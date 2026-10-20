/**
 * dsh-log-contract · lib/validate.js
 *
 * 离线体检引擎（**组合根 / 薄壳**）。
 *
 * 本文件只保留平台适配与[internal]输出：
 * 1. DSH 适配：`loadSessionLog` 结果归一（v3 区间编码）、按被检文件版本路由、宿主能力闸；
 * 2. 编排：交给 platform-neutral `contract/runner.js`，由 `adapters/dsh/adapter.js`
 *    声明"跑哪些判定、按什么顺序跑"；
 * 3. 对外输出：`ok/assessable/violations/summary/surface/archive/ignorableDrops/...`
 *    与本文件重构前**逐字段、逐字节一致**（等价性由 `test/runner-equivalence.test.js`、
 *    `test/cli-json-golden.test.js` 与真实语料签名闸守护）。
 *
 * 判定语义不在本文件：契约层不变量在 `contract/`，DSH 形状/版本/帧/视图在 `adapters/dsh/`。
 */
import { ruleById } from './contracts.js';
import { normalizeEventSeqRanges } from './compat.js';
import { HOST_MAX_FILE_VERSION, hostCapability, isAssessableFileVersion } from './vocab.js';
import { detectSupport } from './version-support.js';
import { driftOf, hostProbes } from './host-probes.js';
import { VERSION_DEPENDENT_RULES, migrationVerdict, resumeVerdict } from '../adapters/dsh/format-versions.js';
import { createDshAdapter } from '../adapters/dsh/adapter.js';
import { runContract } from '../contract/runner.js';

/** 事件包装 → 中性记录（runner 只把它当记录容器；判定细节在适配器）。 */
function buildRecords(events) {
  return events.map(({ event, lineNo }) => ({
    id: `line#${lineNo}`,
    seq: Number.isSafeInteger(event.seq) ? event.seq : null,
    lineNo,
    type: typeof event.type === 'string' ? event.type : null,
    payload: event,
  }));
}

/** 统一补齐宿主能力/版本支持面/漂移/迁移读数（重构前后同一逻辑）。 */
function attachVerdictReadings(result, { header, events }) {
  result.support = detectSupport({ header, events });
  result.probes = hostProbes();
  result.drift = driftOf(result.probes);
  result.migration = migrationVerdict(result);
  result.assessmentScope = result.migration.assessmentScope;
  return result;
}

/**
 * 对会话日志执行全量离线体检。
 *
 * @param {object} log `loadSessionLog()` 的返回值
 * @param {{ baseSeq?: number, ignorableWhitelist?: string[], archiveRoots?: string[] }} [opts]
 *   - `ignorableWhitelist`：G4 可忽略消费者白名单（精确 type 或以 `/` 结尾的前缀）；
 *   - `archiveRoots`：A1「在位可还原」的归档根目录；**不传 = 该维度不可判定**（不冒充通过）。
 * @returns {{
 *   ok: boolean,
 *   violations: Array,
 *   summary: object,
 *   surface: object,
 * }}
 */
export function validateSessionLog(log, opts = {}) {
  const { baseSeq = 0, ignorableWhitelist, archiveRoots } = opts;
  const { header, headerLine, rows, frameInfo } = log;
  // 多入口一致：即使调用方手搓 log 对象、未经 `loadSessionLog`，也在体检入口归一一次 v3 区间编码。
  const events = (log.events ?? []).map((e) => ({ ...e, event: normalizeEventSeqRanges(e.event) }));
  // 词表/折叠路径按**被检文件自身版本**选择（不按运行时）；版本是本次调用的局部量。
  const formatVersion = Number.isSafeInteger(header?.version) && header.version >= 0 ? header.version : 0;
  const records = buildRecords(events);

  // ── 宿主能力闸（S2·安全）：版本超出本宿主能力 ⇒ 只跑版本无关结构检查 + 显式"不可评估"档。
  if (!isAssessableFileVersion(formatVersion)) {
    return unassessableResult({ header, headerLine, rows, events, frameInfo, formatVersion, baseSeq, ignorableWhitelist, archiveRoots, records });
  }

  const adapter = createDshAdapter({
    mode: 'assessable',
    events, rows, header, headerLine, frameInfo, formatVersion, baseSeq, ignorableWhitelist, archiveRoots,
  });
  const outcome = runContract({ records, adapter });
  const replay = outcome.metadata.replay;
  const fold = outcome.metadata.fold;
  const ignorableDrops = outcome.metadata.ignorableDrops;
  const archive = outcome.metadata.archive;

  const summary = {
    total: outcome.summary.total,
    bySeverity: outcome.summary.bySeverity,
    byLayer: outcome.summary.byLayer,
    events: events.length,
    surfaceNodes: replay.nodes.length,
    replaceGeneration: replay.replaceGeneration,
    frames: frameInfo?.frames ?? 0,
    compressedBytes: frameInfo?.compressedBytes ?? 0,
    plaintextBytes: frameInfo?.plaintextBytes ?? 0,
    fileVersion: formatVersion,
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
    assessable: true,
    // 0.3.19：结构化读数（不进 ok，只供报告/机器判读）
    seedLength: Object.hasOwn(header ?? {}, 'seedLength') ? header.seedLength : null,
    ignorableDrops: { registered: ignorableDrops.registered.length, unregistered: ignorableDrops.unregistered.length },
    archiveVerdict: archive.verdict,
  };

  const result = {
    ok: outcome.summary.bySeverity.error === 0,
    assessable: true,
    violations: outcome.violations,
    summary,
    surface: fold.surface ?? { nodes: replay.nodes, replacements: [] },
    // A1 独立维度读数：没有归档根时 `verdict='unverifiable'`（不冒充通过）。
    archive,
    // G4 声明式可忽略：已登记（acceptedDrop，不阻断迁移）与未登记（warning + 仍阻断）。
    ignorableDrops: { registered: ignorableDrops.registered, unregistered: ignorableDrops.unregistered },
  };
  return attachVerdictReadings(result, { header, events });
}

/**
 * 宿主能力闸的结果（S2）：被检文件版本 > 本宿主支持的最大版本。
 *
 * 只跑**与版本无关的结构检查**（Z 帧 / H header / R 行 / E 信封不含 E3 词表 / S9 物理序 /
 * M·P / P3·P4 / I1），其余显式跳过并在 `notAssessable.skippedRules` 里列出。
 * **ok 固定 false**（不认证），但 `structuralOk` 单独给出结构层结论——
 * 语义是"本宿主评估不了"，不是"日志坏了"。
 */
function unassessableResult({ header, headerLine, rows, events, frameInfo, formatVersion, baseSeq, ignorableWhitelist, archiveRoots, records }) {
  const cap = hostCapability();
  const notAssessable = {
    fileVersion: formatVersion,
    hostMaxFileVersion: HOST_MAX_FILE_VERSION,
    hostPackage: cap.hostPackage,
    skippedRules: VERSION_DEPENDENT_RULES,
    reason: `被检文件 version=${formatVersion} 高于本宿主 @deepseek-ai/dsh-session@${cap.hostPackage} 支持的最大文件版本 ${HOST_MAX_FILE_VERSION}`
      + `（本宿主只有 ≤${HOST_MAX_FILE_VERSION} 的词表/折叠语义）⇒ 按本宿主语义判定会产出假阳性（如 S8/E3）。`
      + '这不表示日志损坏；请用 0.1.5+ 宿主评估。',
  };

  const adapter = createDshAdapter({
    mode: 'unassessable',
    events, rows, header, headerLine, frameInfo, formatVersion, baseSeq, ignorableWhitelist, archiveRoots,
  });
  const outcome = runContract({ records, adapter });
  const archive = outcome.metadata.archive;

  const result = {
    ok: false, // 不认证（**不是** "broken"——语义见 notAssessable.reason）
    assessable: false,
    structuralOk: outcome.summary.bySeverity.error === 0,
    notAssessable,
    violations: outcome.violations,
    summary: {
      total: outcome.summary.total,
      bySeverity: outcome.summary.bySeverity,
      byLayer: outcome.summary.byLayer,
      events: events.length,
      surfaceNodes: null,
      replaceGeneration: null,
      frames: frameInfo?.frames ?? 0,
      compressedBytes: frameInfo?.compressedBytes ?? 0,
      plaintextBytes: frameInfo?.plaintextBytes ?? 0,
      fileVersion: formatVersion,
      hostMaxFileVersion: HOST_MAX_FILE_VERSION,
      assessable: false,
      seedLength: Object.hasOwn(header ?? {}, 'seedLength') ? header.seedLength : null,
      ignorableDrops: { registered: 0, unregistered: 0 },
      archiveVerdict: archive.verdict,
    },
    surface: null,
    archive,
    ignorableDrops: { registered: [], unregistered: [] },
  };
  return attachVerdictReadings(result, { header, events });
}

/**
 * 评估范围（S1 收窄后的机器可判字段）。
 * - `'partial'`：被检文件需要迁移（`migration.applies === true`）⇒ 迁移维度只覆盖部分规则；
 * - `'full'`：被检文件已是当前官方格式（无需迁移）⇒ 结构维度为全集；
 * - `'none'`：本宿主能力不足以评估该文件版本（S2 闸）⇒ 不给任何档位结论。
 * @param {object} result `validateSessionLog()` 的返回值
 * @returns {'full'|'partial'|'none'}
 */
export function assessmentScope(result) {
  return result?.migration?.assessmentScope
    ?? result?.assessmentScope
    ?? migrationVerdict(result).assessmentScope;
}

export { driftOf, migrationVerdict, resumeVerdict };
export { ruleById };
