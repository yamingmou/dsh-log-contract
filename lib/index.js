/**
 * dsh-log-contract · lib/index.js
 *
 * 日志契约守护（DSH session log contract guard）。
 * 公开 API：离线体检 + 写前校验 + 修复 + 契约目录。
 */
export { loadSessionLog, tailSeq } from './log-reader.js';
export { validateSessionLog, resumeVerdict } from './validate.js';
export { createPreWriter, preWriterFromLog } from './prewrite.js';
export { repairSession, strictScanText, removeMarkersText, neutralizeMarkersText, clipCrossStepSourcesText, dropFailedTurnsText, trimLastMessagesText, trimLastMessagesByBudget, estimateTokensText, compactLastMessagesText, rebuildZstdText, tailRenumberText, neutralizeOrphanText, extractTurnText, keepRangesText } from './repair.js';
export { CONTRACT_RULES, LAYER, SEVERITY, ruleById } from './contracts.js';
export { tokenMeterViolations, tokenMeterSourceViolations, stepKeyViolations, nullTurnStepViolations, physicalOrderViolations, inboxReplayViolations } from './checks.js';
export { auditToolCalls, extractText, extractToolOutputs, indexToolCalls, toolCommandOf } from './archaeology.js';
