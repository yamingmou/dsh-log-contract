/**
 * dsh-log-contract · contract/runner.js
 *
 * 平台无关的**编排入口**：按适配器声明执行判定流水线，收集判定、做边界映射、
 * 稳定排序并聚合汇总。契约层只认识「中性记录 / 中立判定 / 规则 id 映射」，
 * 不认识任何平台的事件模型。
 *
 * 适配器接口（契约见 `docs/ARCHITECTURE.md` 与批量设计稿）：
 *
 *   adapter = {
 *     id: string,
 *     validateShape(record, ctx) => { violations } | violations[],
 *     invariants: Record<invariantId, (ctx) => { violations, ...metadata }>,
 *     ruleIds: Record<neutralKind, platformRuleId>,
 *     // 可选：
 *     toPlatform?: (neutralViolations) => platformViolations[],
 *     pipeline?: Step[],
 *     compareViolations?: (a, b) => number,
 *   }
 *
 * Step = { type: 'each' | 'phase' | 'when', name?, when?, run }
 * - each  : 对每条 record 执行 `run(record, ctx)`
 * - phase : 整体执行一次 `run(ctx)`
 * - when  : `when(ctx, metadata)` 为真才执行 `run(ctx)`
 *
 * 步骤返回 `{ violations: [...], ...metadata }`（或直接返回 violations 数组）。
 * 判定条目支持两种形状：
 * - 中立 `{ kind, message, ... }`（先经适配器边界映射成平台规则 id）；
 * - 平台形状 `{ id, severity, layer, ... }`（适配器内部已映射，原样通过）。
 * 两种都不合法 ⇒ 抛错（fail-closed，绝不静默丢判定）。
 *
 * 排序：默认按 `seq` → `lineNo`（与既有公开输出一致；稳定排序保留同键的插入顺序）。
 * 本文件不含任何平台词表；平台专属功能由适配器在 dependencies 之外提供。
 */

import { isViolationKind } from './verdict.js';

const STEP_TYPES = new Set(['each', 'phase', 'when']);

/** 默认排序：seq → lineNo（缺省视作 -1；稳定排序保留同键插入序）。 */
export function defaultCompare(a, b) {
  return (a.seq ?? -1) - (b.seq ?? -1) || (a.lineNo ?? -1) - (b.lineNo ?? -1);
}

/** 校验适配器必选接口（任何缺失都抛错，不做静默降级）。 */
function assertAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') throw new TypeError('adapter 必须为对象');
  if (typeof adapter.id !== 'string' || adapter.id === '') throw new TypeError('adapter.id 必须为非空字符串');
  if (typeof adapter.validateShape !== 'function') throw new TypeError(`adapter(${adapter.id}).validateShape 必须为函数`);
  if (adapter.invariants === null || typeof adapter.invariants !== 'object' || Array.isArray(adapter.invariants)) {
    throw new TypeError(`adapter(${adapter.id}).invariants 必须为对象`);
  }
  if (adapter.ruleIds === null || typeof adapter.ruleIds !== 'object' || Array.isArray(adapter.ruleIds)) {
    throw new TypeError(`adapter(${adapter.id}).ruleIds 必须为对象`);
  }
}

/** 步骤返回值归一：数组或 `{ violations, ...metadata }`，其余抛错。 */
function normalizeStepResult(result, step) {
  if (Array.isArray(result)) return { violations: result, metadata: {} };
  if (result !== null && typeof result === 'object' && Array.isArray(result.violations)) {
    const { violations, ...metadata } = result;
    return { violations, metadata };
  }
  throw new TypeError(`步骤「${step.name ?? step.type}」返回形状非法：期望 { violations } 或数组`);
}

/** 未声明 pipeline 时的默认执行计划：逐记录形状校验 + 声明序不变量。 */
function buildDefaultPipeline(adapter) {
  const steps = [{ type: 'each', name: 'validateShape', run: (record, ctx) => adapter.validateShape(record, ctx) }];
  for (const [invariantId, implementation] of Object.entries(adapter.invariants)) {
    if (typeof implementation !== 'function') throw new TypeError(`不变量实现必须为函数：${invariantId}`);
    steps.push({ type: 'phase', name: invariantId, run: (ctx) => implementation(ctx) });
  }
  return steps;
}

/** 中立判定 → 平台输出：优先适配器边界函数，否则用 ruleIds + 固定字段序构造。 */
function platformViolationOf(neutral, adapter) {
  const ruleId = adapter.ruleIds[neutral.kind];
  if (typeof ruleId !== 'string' || ruleId === '') {
    throw new TypeError(`中立判定 kind 未映射平台规则 id：${neutral.kind}`);
  }
  if (typeof adapter.toPlatform === 'function') {
    const converted = adapter.toPlatform([neutral]);
    if (!Array.isArray(converted) || converted.length !== 1) {
      throw new TypeError(`adapter(${adapter.id}).toPlatform 必须保持逐条 1:1 映射`);
    }
    return converted[0];
  }
  const { kind, ...rest } = neutral;
  const out = {
    id: ruleId,
    severity: rest.severity,
    layer: rest.layer,
    seq: rest.seq,
    lineNo: rest.lineNo,
    eventType: rest.eventType,
    message: rest.message,
    source: rest.source,
  };
  for (const [key, value] of Object.entries(rest)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** 违规条目归一：中立 ⇒ 边界映射；已是平台形状 ⇒ 原样通过；其余抛错。 */
function normalizeViolation(item, adapter) {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    if (typeof item.kind === 'string') {
      if (!isViolationKind(item.kind)) throw new TypeError(`中立判定 kind 形态非法：${item.kind}`);
      return platformViolationOf(item, adapter);
    }
    if (typeof item.id === 'string' && item.id !== '') return item;
  }
  throw new TypeError('判定条目既不是中立 {kind} 也不是平台 {id} 形状');
}

/** 聚合 summary（bySeverity 固定键序；byLayer 按首次出现序）。 */
function summarize(violations) {
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byLayer = {};
  for (const violation of violations) {
    bySeverity[violation.severity] = (bySeverity[violation.severity] ?? 0) + 1;
    byLayer[violation.layer] = (byLayer[violation.layer] ?? 0) + 1;
  }
  return { total: violations.length, bySeverity, byLayer };
}

/**
 * 执行一次契约判定。
 *
 * @param {{
 *   records: Array<object>,
 *   adapter: object,
 *   options?: { pipeline?: Array<object>, compare?: (a: object, b: object) => number },
 * }} args
 * @returns {{ violations: Array<object>, summary: { total: number, bySeverity: object, byLayer: object }, metadata: object }}
 */
export function runContract({ records = [], adapter, options = {} } = {}) {
  assertAdapter(adapter);
  if (!Array.isArray(records)) throw new TypeError('records 必须为数组');

  const metadata = {};
  const ctx = { records, adapter, options, metadata };
  const collected = [];

  const pipeline = options.pipeline ?? adapter.pipeline ?? buildDefaultPipeline(adapter);
  if (!Array.isArray(pipeline)) throw new TypeError('pipeline 必须为步骤数组');

  const execute = (step, invoke) => {
    const normalized = normalizeStepResult(invoke(), step);
    collected.push(...normalized.violations);
    Object.assign(metadata, normalized.metadata);
  };

  for (const step of pipeline) {
    if (step === null || typeof step !== 'object') throw new TypeError('pipeline 步骤必须为对象');
    if (!STEP_TYPES.has(step.type)) throw new TypeError(`未知步骤类型：${String(step.type)}`);
    if (typeof step.run !== 'function') throw new TypeError(`步骤「${step.name ?? step.type}」缺少 run 函数`);
    if (step.type === 'each') {
      for (const record of records) execute(step, () => step.run(record, ctx));
    } else if (step.type === 'phase') {
      execute(step, () => step.run(ctx));
    } else {
      const stepLabel = step.name ?? 'when';
      if (typeof step.when !== 'function') throw new TypeError(`条件步骤「${stepLabel}」缺少 when 函数`);
      if (step.when(ctx, metadata)) execute(step, () => step.run(ctx));
    }
  }

  const violations = collected.map((item) => normalizeViolation(item, adapter));
  const compare = options.compare ?? adapter.compareViolations ?? defaultCompare;
  if (typeof compare !== 'function') throw new TypeError('compare 必须为函数');
  violations.sort(compare);

  return { violations, summary: summarize(violations), metadata };
}
