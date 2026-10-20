/**
 * dsh-log-contract · adapters/dsh/index.js
 *
 * DSH 适配器公开面（DeepSeek Harness session log）。
 *
 * 适配器职责：把 DSH 记录形状翻译成契约层的不变量判定输入，并收口所有
 * DSH 专属词汇（事件类型 turn/step、surface 投影、格式版本 v0–v4、zstd 帧、
 * projcache、词表、归档指针）。
 *
 * 依赖方向：adapters/dsh → contract（单向）。跨平台适配器之间互不依赖；
 * 同一适配器内的子模块可共享 `vocab.js`（词表与形状常量）与 `rules.js`（规则数据）。
 */

export const ADAPTER = Object.freeze({
  id: 'dsh',
  name: 'DeepSeek Harness session log',
  eventShapes: 'event-shapes.js',
  formatVersions: 'format-versions.js',
  frames: 'frames.js',
  surface: 'surface.js',
  vocab: 'vocab.js',
  rules: 'rules.js',
  ruleIds: 'rule-ids.js',
  archive: 'archive.js',
  hostProbes: 'host-probes.js',
  projcache: 'surface.js', // 客户端投影缓存：只登记归属，不做落盘判定
});

export * from './event-shapes.js';
export * from './format-versions.js';
export * from './frames.js';
export * from './surface.js';
export * from './vocab.js';
export * from './rules.js';
export * from './rule-ids.js';
export * from './archive.js';
export * from './host-probes.js';
