/**
 * dsh-log-contract · lib/archive.js
 *
 * 外置内容（归档）判定公开面（实现层）：
 * - 判定核心（在位可还原）→ contract/invariants.js
 * - DSH 结构化指针提取与归档读取 → adapters/dsh/archive.js
 *
 * 导出名与既有版本保持一致（公开面不变）。
 */
export {
  ARCHIVE_POINTER_FIELDS,
  EXTERNALIZED_POINTER_FIELDS,
  collectArchivePointers,
  archiveBasename,
  readArchiveIndex,
  readArchiveLines,
  verifyArchivePointers,
  archiveVerdict,
} from '../adapters/dsh/archive.js';
