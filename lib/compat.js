/**
 * dsh-log-contract · lib/compat.js
 *
 * 兼容层公开面（实现层）：
 * - 无损 JSON 判定（平台无关）→ contract/invariants.js
 * - DSH 存储行解码 / 来源序号区间解码 → adapters/dsh/event-shapes.js
 *
 * 导出名与既有版本保持一致（公开面不变）。
 */
export { isJsonValue } from '../contract/invariants.js';
export { decodeStorageRecord, decodeSeqRanges, normalizeEventSeqRanges } from '../adapters/dsh/event-shapes.js';
