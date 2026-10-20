/**
 * dsh-log-contract · lib/log-reader.js
 *
 * 日志读取的公开面（实现层）：实现位于 adapters/dsh/frames.js。
 * 导出名与既有版本保持一致（公开面不变）。
 */
export { scanZstdFrames, decompressZstd, tailSeq, loadSessionLog, readSessionHeader } from '../adapters/dsh/frames.js';
