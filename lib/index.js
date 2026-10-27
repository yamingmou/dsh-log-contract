/**
 * dsh-log-contract · lib/index.js
 *
 * 日志契约守护（DSH session log contract guard）。
 * 公开 API：离线体检 + 写前校验 + 修复 + 契约目录。
 */
export { loadSessionLog, tailSeq, readSessionHeader } from './log-reader.js';
export { validateSessionLog, resumeVerdict, migrationVerdict, assessmentScope } from './validate.js';
export { createPreWriter, preWriterFromLog } from './prewrite.js';
export { repairSession, strictScanText, removeMarkersText, neutralizeMarkersText, clipCrossStepSourcesText, dropFailedTurnsText, trimLastMessagesText, trimLastMessagesByBudget, estimateTokensText, compactLastMessagesText, rebuildZstdText, tailRenumberText, neutralizeOrphanText, extractTurnText, keepRangesText } from './repair.js';
export { CONTRACT_RULES, LAYER, SEVERITY, ruleById } from './contracts.js';
export { explainRule, examplePointers, relatedCommandsOf, EXPLAIN_KEYS, EXPLAIN_DOC } from './explain.js';
export { HOST_MAX_FILE_VERSION, hostPackageVersion, hostCapability, isAssessableFileVersion } from './vocab.js';
export { TESTED_BASELINE, compareVersions, detectSupport, supportOfLog } from './version-support.js';
export { tokenMeterViolations, tokenMeterSourceViolations, stepKeyViolations, nullTurnStepViolations, turnEndReasonViolations, ignorableTypeViolations, physicalOrderViolations, inboxReplayViolations, sourceEventSeqElementViolations, rawSourceEventSeqViolations, isSeqRangePair, seedLengthViolations, carrierPairingViolations, carrierWriteViolations, isCarrierAuditSegment, carrierRangesMatch, surfaceReplaceRange, declarativeIgnorableViolations, isIgnorableRegistered, resolveIgnorableWhitelist, DEFAULT_IGNORABLE_WHITELIST } from './checks.js';
export { collectArchivePointers, verifyArchivePointers, archiveVerdict, archiveBasename, readArchiveLines, readArchiveIndex, ARCHIVE_POINTER_FIELDS, EXTERNALIZED_POINTER_FIELDS } from './archive.js';
export { auditToolCalls, extractText, extractToolOutputs, indexToolCalls, toolCommandOf } from './archaeology.js';
