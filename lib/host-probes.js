/**
 * dsh-log-contract · lib/host-probes.js
 *
 * 宿主行为探针与漂移报告的公开面（实现层）：实现位于 adapters/dsh/host-probes.js。
 * 导出名与既有版本保持一致（公开面不变）。
 */
export { PROBES, runHostProbes, hostProbes, driftOf } from '../adapters/dsh/host-probes.js';
