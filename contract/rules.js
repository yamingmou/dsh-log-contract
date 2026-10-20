/**
 * contract/rules.js
 *
 * 规则描述符（record schema）：一条契约规则在注册表里必须具备的形状。
 *
 * 规则描述符是平台无关的数据模型 —— 它只说明「一条规则如何被描述」，
 * 不携带任何平台词汇。平台专属的规则内容由适配器提供，注册表负责汇总。
 *
 * 字段：
 *   必填 id         平台规则标识（注册表主键，稳定不可复用）
 *        kind       中立判定种类（domain.kebab-case；契约层按它解析元数据）
 *        title      一句话说明
 *        layer      规则所属层（registry.js 的 LAYER）
 *        severity   严重度（verdict.js 的 SEVERITY）
 *        source     契约出处（人读）
 *        description 判定说明（人读）
 *   可选 sourceVerified 出处是否已在目标宿主版本上核对（缺省视为未核对）
 *        premiseStale   判定前提是否已失效
 *        candidate      是否为候选规则（尚未进入正式判定集）
 *        invariant      该规则守护的不变量标识（contract/invariants.js 的 INVARIANTS 值）
 *
 * 描述符形状与校验为契约层自有实现；规则内容（含 invariant 声明）由适配器登记。
 */

import { SEVERITY, isViolationKind } from './verdict.js';

/** 规则描述符的必填字段。 */
export const RULE_REQUIRED_FIELDS = Object.freeze([
  'id',
  'kind',
  'title',
  'layer',
  'severity',
  'source',
  'description',
]);

/** 规则描述符的可选字段。 */
export const RULE_OPTIONAL_FIELDS = Object.freeze([
  'sourceVerified',
  'premiseStale',
  'candidate',
  'invariant',
]);

const REQUIRED = new Set(RULE_REQUIRED_FIELDS);
const KNOWN = new Set([...RULE_REQUIRED_FIELDS, ...RULE_OPTIONAL_FIELDS]);
const SEVERITIES = new Set(Object.values(SEVERITY));

/**
 * 判断一个对象是否满足规则描述符的必填约束。
 *
 * 只做形状校验（不校验 id 是否与判定实现一一对应）：
 * 必填字段齐全、id/title/layer/source 为非空字符串、severity 属于已知枚举、多余字段报 false。
 *
 * @param {unknown} rule
 * @returns {boolean}
 */
export function isRuleDescriptor(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return false;
  for (const field of REQUIRED) {
    if (!Object.hasOwn(rule, field)) return false;
  }
  for (const field of ['id', 'title', 'layer', 'source', 'description']) {
    if (typeof rule[field] !== 'string' || rule[field] === '') return false;
  }
  if (!isViolationKind(rule.kind)) return false;
  if (!SEVERITIES.has(rule.severity)) return false;
  for (const key of Object.keys(rule)) {
    if (!KNOWN.has(key)) return false;
  }
  return true;
}
