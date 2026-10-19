/**
 * dsh-log-contract · lib/version-support.js —— **版本支持面**:测试基线 + 运行时检测/告警
 * （2026-09-14 用户要求第 1 条:把"哪些版本被验证过"写成明文,并在运行时检测报告）。
 *
 * 背景（外部质疑 + 事实核对）：
 * - 事实①:本包 `peerDependencies` = `^0.1.0-rc.7 || ^0.1.5-rc.1`,devDependency 与开发机
 *   宿主实装都是 `0.1.5-rc.1` ⇒ **覆盖到了**;且本规则集在 v3 会话上实测有效
 *   （在真实 v3 文件上准确拒绝了伪造的 `seq: 0`，见 E2/S6/S8 用例）。
 * - 事实②:"**哪些版本被验证过**"此前只散落在注释与 CHANGELOG 里,**没有一处明文**,
 *   外部无法核对 ⇒ 本模块把**测试基线**变成一个可读、可比对、会告警的常量。
 *
 * 三条运行时规则（"不闷着按旧规则判"）：
 * 1. 宿主 `@deepseek-ai/dsh-session` 版本**比基线新** ⇒ 明确告警（规则集未在该版本上验证）；
 * 2. 被检**会话文件格式版本**不在已知集合 {0,1,2,3,4} 内 ⇒ 报"未验证格式"并**按只读处理**
 *    （不做写入前判定、不做修复）；
 * 3. 两者都可解析时,给出一行可核对的摘要（宿主 / 文件格式 / 基线）。
 */
import { hostPackageVersion, resolveFormatVersionDetailed, HOST_MAX_FILE_VERSION } from './vocab.js';

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
  // S4（实测）:无法识别格式时**状态标签必须是 `unverified`**（README 就是这么写的:
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
