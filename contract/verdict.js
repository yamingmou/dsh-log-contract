/**
 * contract/verdict.js
 *
 * 平台无关的「判定」模型：一条判定长什么样、严重度如何分级、如何构造。
 *
 * 契约层只描述判定对象的**形状**，不描述任何具体运行时的事件形状，也**不持有平台规则 id**：
 *
 *   { kind, layer, severity, message, seq?, lineNo?, eventType?, source? }
 *
 * - kind     中立判定种类（`domain.kebab-case`，跨平台可复用；如 `seq.contiguous`）
 * - layer    判定所属层（见 registry.js 的 LAYER）
 * - severity error | warning | info
 * - message  人读说明
 * - source   判定出处（人读；来自注册表，由适配器提供）
 * - 定位信息 seq / lineNo / eventType，缺省时补空
 *
 * 规则元数据（severity/layer/source）从注册表按 **kind** 解析：
 * 判定构造本身不持有任何平台规则编号；平台 id 的映射由适配器在边界完成。
 */

import { ruleByKind } from './registry.js';

/** 判定严重度。 */
export const SEVERITY = Object.freeze({
  ERROR: 'error', // 违反即不可加载 / 写入被拒（fail-loud）
  WARNING: 'warning', // 合法但可疑
  INFO: 'info', // 事实性观察
});

/** 中立判定种类必须满足的命名形态（domain.kebab-case）。 */
export const KIND_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** 是否为合法中立判定种类。 */
export function isViolationKind(value) {
  return typeof value === 'string' && KIND_PATTERN.test(value);
}

/**
 * 构造一条**中立**判定记录。
 *
 * @param {string} kind 中立判定种类（注册表按 kind 解析元数据）
 * @param {{seq?: number, lineNo?: number, eventType?: string}|null} eventOrLoc 定位信息
 * @param {string} message 人读说明
 * @param {object} [extra] 追加字段（如规则特有的机器可读读数）
 * @returns {object}
 */
export function violation(kind, eventOrLoc, message, extra = {}) {
  const rule = ruleByKind(kind);
  const loc = eventOrLoc ?? {};
  return {
    kind,
    severity: rule?.severity ?? SEVERITY.ERROR,
    layer: rule?.layer ?? 'unknown',
    seq: typeof loc.seq === 'number' ? loc.seq : null,
    lineNo: typeof loc.lineNo === 'number' ? loc.lineNo : null,
    eventType: loc.eventType ?? null,
    message,
    source: rule?.source ?? null,
    ...extra,
  };
}
