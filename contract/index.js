/**
 * contract/index.js
 *
 * 契约层（platform-neutral）公开面。
 *
 * 两层边界：
 * - contract/          平台无关：判定模型、不变量目录、规则描述符与注册表、记录 schema
 * - adapters/<platform>/  平台专属：事件形状、格式版本、帧结构、视图推导、词表
 *
 * 依赖方向固定为 adapters → contract，契约层不得反向依赖任何适配器。
 * 各模块为契约层自有实现；平台专属内容由适配器提供（adapters → contract 单向）。
 */

export * from './verdict.js';
export * from './invariants.js';
export * from './rules.js';
export * from './registry.js';
export * from './runner.js';
