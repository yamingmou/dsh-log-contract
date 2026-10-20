/**
 * dsh-log-contract · lib/version-support.js
 *
 * 版本支持面的公开面（实现层）：实现位于 adapters/dsh/format-versions.js。
 * 导出名与既有版本保持一致（公开面不变）。
 */
export { TESTED_BASELINE, compareVersions, detectSupport, supportOfLog } from '../adapters/dsh/format-versions.js';
