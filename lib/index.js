/**
 * dsh-log-contract · lib/index.js
 *
 * 日志契约守护（DSH session log contract guard）。
 * 公开 API：离线体检 + 写前校验 + 修复 + 契约目录。
 */
export { loadSessionLog } from './log-reader.js';
export { validateSessionLog } from './validate.js';
export { createPreWriter, preWriterFromLog } from './prewrite.js';
export { repairSession, strictScanText, removeMarkersText, dropFailedTurnsText, trimLastMessagesText, compactLastMessagesText, rebuildZstdText } from './repair.js';
export { CONTRACT_RULES, LAYER, SEVERITY, ruleById } from './contracts.js';
export { tokenMeterViolations } from './checks.js';
