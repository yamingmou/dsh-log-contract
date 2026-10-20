/**
 * dsh-log-contract · lib/contracts.js
 *
 * 规则目录的公开聚合面（实现层）。
 *
 * - 层枚举、严重度、注册表读取接口：来自契约层 `contract/`（平台无关）；
 * - 规则描述符数据（`CONTRACT_RULES` / `SOURCE_DRIFT`）：由 DSH 适配器
 *   `adapters/dsh/rules.js` 提供，加载时登记进契约层注册表。
 *
 * 导出名与既有版本保持一致（公开面不变）。
 */

export { LAYER, contractRules, ruleById, ruleTableRows } from '../contract/registry.js';
export { SEVERITY } from '../contract/verdict.js';
export { CONTRACT_RULES, SOURCE_DRIFT } from '../adapters/dsh/rules.js';
