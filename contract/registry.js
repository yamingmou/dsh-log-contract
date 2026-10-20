/**
 * contract/registry.js
 *
 * 规则注册表：层枚举 + 注册与读取接口。
 *
 * 平台无关：本文件只定义「规则如何登记、如何按 id 读取」，
 * **不持有任何具体规则内容**——规则描述符由适配器在加载时登记（adapters → contract 单向）。
 *
 * 登记是幂等的纯数据操作：按 `id` 建索引并冻结目录；重复 id、非数组、
 * 或调用方提供的描述符校验失败时**立即抛错**（fail-loud，不静默跳过）。
 */

// 不变量实现状态由契约层不变量目录维护；注册表对外转发同一机读视图。
export { INVARIANT_REGISTRY, invariantStatus } from './invariants.js';

/**
 * 规则所属层（契约维度）枚举。层名描述「这条规则守的是哪一类性质」，
 * 与具体平台无关：一个平台适配器可以只填其中若干层。
 */
export const LAYER = Object.freeze({
  PERSISTENCE: 'persistence', // 持久化层：记录能被解码器完整重放
  ENGINE: 'engine', // 引擎层：记录形状匹配客户端状态机
  PLUGIN: 'plugin', // 插件语义层：命名/标记的隐藏语义
  CONCURRENCY: 'concurrency', // 并发 / 写入者假设
  FRAMING: 'framing', // 容器帧结构
  MIGRATION: 'migration', // 迁移预检层（独立维度：升级路径会不会拒）
  ARCHIVE: 'archive', // 归档层（独立维度：外置内容能否在位还原）
});

/** 已登记的规则目录（按登记顺序冻结）。 */
let catalog = Object.freeze([]);
/** id → 规则描述符。 */
const index = new Map();
/** 中立 kind → 规则描述符。 */
const kindIndex = new Map();

/**
 * 登记规则目录。
 *
 * @param {ReadonlyArray<object>} rules 规则描述符列表（按展示顺序）
 * @param {{ validate?: (rule: unknown) => boolean }} [opts]
 *   `validate`：调用方提供的描述符形状校验；返回 false 即拒绝整批登记。
 * @returns {ReadonlyArray<object>} 冻结后的目录
 */
export function installRuleCatalog(rules, { validate } = {}) {
  if (!Array.isArray(rules)) {
    throw new TypeError('规则目录必须为数组');
  }
  if (typeof validate === 'function') {
    for (const rule of rules) {
      if (validate(rule)) continue;
      const id = rule !== null && typeof rule === 'object' && 'id' in rule ? String(rule.id) : '<unknown>';
      throw new TypeError(`规则描述符非法：${id}`);
    }
  }
  const next = new Map();
  const nextKinds = new Map();
  for (const rule of rules) {
    const id = rule?.id;
    if (typeof id !== 'string' || id === '') throw new TypeError('规则描述符缺少非空 id');
    if (next.has(id)) throw new TypeError(`规则 id 重复：${id}`);
    const kind = rule?.kind;
    if (typeof kind !== 'string' || kind === '') throw new TypeError(`规则 ${id} 缺少非空中立 kind`);
    if (nextKinds.has(kind)) throw new TypeError(`规则 kind 重复：${kind}`);
    next.set(id, rule);
    nextKinds.set(kind, rule);
  }
  catalog = Object.freeze([...rules]);
  index.clear();
  kindIndex.clear();
  for (const [id, rule] of next) index.set(id, rule);
  for (const [kind, rule] of nextKinds) kindIndex.set(kind, rule);
  return catalog;
}

/** 当前已登记的规则目录（冻结副本，顺序 = 登记顺序）。 */
export function contractRules() {
  return catalog;
}

/** 按 id 取规则；未登记 ⇒ undefined。 */
export function ruleById(id) {
  return index.get(id);
}

/** 按中立 kind 取规则；未登记 ⇒ undefined。 */
export function ruleByKind(kind) {
  return kindIndex.get(kind);
}

/** 按目录顺序渲染规则索引行（`| id | severity | layer | title |`）。 */
export function ruleTableRows() {
  return catalog.map((r) => `| ${r.id} | ${r.severity} | ${r.layer} | ${r.title} |`).join('\n');
}
