/**
 * dsh-log-contract · lib/checks.js
 *
 * 逐事件契约检查的**聚合面**：离线体检（validate.js）与写前校验（prewrite.js）
 * 复用同一套判定，保证"体检看到的问题 = 写入前拦下的问题"。
 *
 * 实现位置：
 * - 平台无关不变量 → contract/invariants.js
 * - DSH 事件形状 / 视图改写 / 版本路由与迁移 → adapters/dsh/
 *
 * 导出名与既有版本保持一致（公开面不变）。
 */
export { violation } from '../adapters/dsh/rule-ids.js';
export { isSafeInt } from '../contract/invariants.js';
export {
  envelopeViolations,
  messageShapeViolations,
  toolPairingViolations,
  toolResultStructureViolations,
  ignorableTypeViolations,
  sourceEventSeqElementViolations,
  rawSourceEventSeqViolations,
  isSeqRangePair,
  physicalOrderViolations,
  chunkRowMalformationViolations,
  physicalSequence,
} from '../adapters/dsh/event-shapes.js';
export {
  SURFACE_TYPES,
  MODERN_SURFACE_TYPES,
  V4_SURFACE_TYPES,
  currentSurfaceTypes,
  CHUNK_ROW_TYPES,
  MARKER_PREFIXES,
  ENVELOPE_ALLOWED_KEYS,
  DEFAULT_IGNORABLE_WHITELIST,
  resolveIgnorableWhitelist,
  isIgnorableRegistered,
} from '../adapters/dsh/vocab.js';
export {
  isReplaceOp,
  normalizeReplaceOp,
  replaySurface,
  provenanceViolations,
  toolResultRewriteViolations,
  engineViolations,
  pluginViolations,
  stepKeyViolations,
  nullTurnStepViolations,
  turnEndReasonViolations,
  tokenMeterViolations,
  tokenMeterSourceViolations,
  inboxReplayViolations,
  deriveWireMessage,
  wireViolations,
  isCarrierAuditSegment,
  surfaceReplaceRange,
  carrierRangesMatch,
  carrierPairingViolations,
  carrierWriteViolations,
} from '../adapters/dsh/surface.js';
export {
  finalFold,
  migrationPrecheckViolations,
  seedLengthViolations,
  declarativeIgnorableViolations,
} from '../adapters/dsh/format-versions.js';
