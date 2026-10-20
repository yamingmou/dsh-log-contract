/**
 * dsh-log-contract · adapters/dsh/rule-ids.js
 *
 * DSH 专属：平台规则 id ↔ 中立判定 kind 的双向映射。
 *
 * 契约层只产生**中立 kind** 的判定（例如 `seq.contiguous` / `view.replayable`），
 * 不知道任何平台规则编号；本适配器在每个边界把 kind 映射回平台既有规则 id，
 * 因此**外部输出（CLI / JSON / 文档 / 退出码）逐字节不变**。
 *
 * 约定：
 * - 中立 kind = `domain.kebab-case`（域.语义），与平台无关、可跨平台复用；
 * - 平台 id 是稳定主键（历史 id 不复用），只在 adapter 侧出现；
 * - 双向表由同一份数据派生，不维护第二份真相。
 */

import { violation as neutralViolation } from '../../contract/verdict.js';

/** 平台规则 id → 中立 kind（51 条规则全覆盖；未列出的 id 视为 kind 本身）。 */
export const RULE_KIND_BY_ID = Object.freeze({
  H1: 'record.head',
  H2: 'record.head-fields',
  R1: 'record.parsable',
  R2: 'record.aggregate-schema',
  R3: 'record.derived-coordinate',
  E1: 'seq.present',
  E2: 'seq.contiguous',
  E3: 'type.known-or-declared',
  E4: 'value.json-lossless',
  E5: 'type.deprecated-forbidden',
  E6: 'message.shape',
  E7: 'type.ignorable-consumer',
  E8: 'envelope.keys-closed',
  E9: 'message.source-producer',
  E10: 'request.header-minimal',
  S1: 'view.projection-declared',
  S2: 'view.projection-forbidden',
  S3: 'reference.closure',
  S4: 'rewrite.node-bounded',
  S5: 'rewrite.coverage-complete',
  S6: 'reference.self-constraints',
  S7: 'rewrite.content-only',
  S8: 'view.replayable',
  S9: 'seq.monotonic',
  S10: 'reference.element-type',
  I1: 'queue.replay-sound',
  I2: 'head.inherited-count',
  T1: 'meter.step-pairing',
  T2: 'meter.source-scope',
  T3: 'view.key-unique',
  T4: 'view.scope-attributable',
  T5: 'scope.end-reason',
  M1: 'append.deferred-only',
  P1: 'marker.prefix-registered',
  P2: 'marker.self-reference',
  P3: 'pairing.call-result',
  P4: 'pairing.result-parsable',
  P5: 'carrier.pairing',
  C1: 'seq.single-writer',
  Z1: 'frame.tail-intact',
  Z2: 'frame.decodable',
  Z3: 'container.empty-explicit',
  Z4: 'frame.first-record-alone',
  Z5: 'frame.layout-preserved',
  W1: 'wire.tool-result-anchored',
  W2: 'wire.user-text-order',
  G1: 'migration.descriptor-version',
  G2: 'migration.known-types',
  G3: 'migration.reference-sound',
  G4: 'migration.declared-skip',
  A1: 'content.restorable',
});

/** 中立 kind → 平台规则 id（由 `RULE_KIND_BY_ID` 反向派生）。 */
export const RULE_ID_BY_KIND = Object.freeze(Object.fromEntries(
  Object.entries(RULE_KIND_BY_ID).map(([id, kind]) => [kind, id]),
));

/** 平台规则 id → 中立 kind；未知 id 原样返回（兼容尚未登记的规则）。 */
export function neutralKindOf(ruleId) {
  return RULE_KIND_BY_ID[ruleId] ?? ruleId;
}

/** 中立 kind → 平台规则 id；未知 kind 原样返回（外部不再凭空造 id）。 */
export function platformIdOf(kind) {
  return RULE_ID_BY_KIND[kind] ?? kind;
}

/**
 * 中立判定 → 平台判定（边界转换）。
 *
 * 输出字段顺序与既有公开输出一致：`id` 在首位，随后 severity/layer/定位/消息/出处，
 * 最后是规则特有附加字段；中立 `kind` 不落到外部输出里。
 */
export function toPlatformViolation(neutral) {
  if (neutral === null || typeof neutral !== 'object') return neutral;
  const { kind, ...rest } = neutral;
  const out = {
    id: platformIdOf(kind),
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

/** 中立判定列表 → 平台判定列表。 */
export function toPlatformViolations(list) {
  return Array.isArray(list) ? list.map(toPlatformViolation) : [];
}

/**
 * 平台侧判定构造：入参为**平台规则 id**（适配器既有调用点不变），
 * 内部先构造中立 kind 判定、再在边界映射回平台 id。
 *
 * @param {string} ruleId 平台规则 id
 * @param {{seq?:number, lineNo?:number, eventType?:string}|null} eventOrLoc 定位
 * @param {string} message 人读说明
 * @param {object} [extra] 规则特有机器可读字段
 */
export function violation(ruleId, eventOrLoc, message, extra = {}) {
  return toPlatformViolation(neutralViolation(neutralKindOf(ruleId), eventOrLoc, message, extra));
}
