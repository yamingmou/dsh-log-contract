/**
 * contract/index.mjs —— contract 层入口（Phase1 骨架 · 影子双跑）
 *
 * 对外三个动作：
 *   evaluate(model, ctx)          → { findings, verdict, planRead }   （只读判定）
 *   shadowCompare(contractVerdict, legacyResult, opts)
 *                                  → { match, diffs }                 （与 lib/validate.js 双跑对比）
 *   （规则目录/覆盖）rules.mjs 的 coverageOf
 *
 * ⛔ Phase1 不改 lib/、不改行为：影子不一致只报告（diffs），不抛错、不改真值。
 */

import { runInvariants, INVARIANTS } from './invariants.mjs';
import { verdictOf } from './verdict.mjs';
import { planOf, AUTO_REPAIRABLE } from './plan.mjs';
import { coverageOf, INVARIANT_OF, RULE_STATUS } from './rules.mjs';

export { runInvariants, INVARIANTS } from './invariants.mjs';
export { verdictOf } from './verdict.mjs';
export { planOf, AUTO_REPAIRABLE } from './plan.mjs';
export { coverageOf, INVARIANT_OF, RULE_STATUS } from './rules.mjs';

/**
 * 只读判定入口。
 * @param {object} model 抽象模型：{ header, events, frames }
 * @param {{rules?:Array<{id:string}>}} [ctx] 覆盖检查可注入自定义目录（负对照）
 */
export function evaluate(model, ctx = {}) {
  const findings = runInvariants(model, ctx);
  const verdict = verdictOf(findings);
  return { findings, verdict, planRead: planOf(verdict, { mode: 'read' }) };
}

const errorIds = (list, pick) => {
  const set = new Set();
  for (const v of list || []) {
    if (!v) continue;
    const sev = v.severity;
    if (sev !== undefined && sev !== 'error') continue; // legacy violations 可能无 severity 字段（视为 error）
    const id = pick(v);
    if (id) set.add(id);
  }
  return set;
};

/**
 * 影子双跑对比（Phase1：只报告，不改变任何行为）。
 * @param {{ok:boolean, findings?:Array}} contractVerdict
 * @param {{ok:boolean, violations?:Array}} legacyResult  lib/validate.js 的返回
 * @param {{scope?:'covered'|'all'}} [opts]
 *        covered（默认）= 只比 contract 已覆盖的规则 id（公平对比，未覆盖项不计 diff）
 *        all = 全量比（Phase2 收敛用；未覆盖的 legacy 规则会以 rule-only-legacy 出现）
 */
export function shadowCompare(contractVerdict, legacyResult, { scope = 'covered' } = {}) {
  const diffs = [];
  const contractOk = contractVerdict?.ok === true;
  const legacyOk = legacyResult?.ok === true;
  if (contractOk !== legacyOk) diffs.push({ kind: 'ok-mismatch', contract: contractOk, legacy: legacyOk });

  const contractIds = errorIds(contractVerdict?.findings, (f) => f.ruleId);
  const legacyIds = errorIds(legacyResult?.violations, (v) => v.ruleId ?? v.rule ?? v.id);
  const covered = new Set(Object.keys(INVARIANT_OF));

  const only = (a, b) => [...a].filter((id) => !b.has(id));
  const cOnly = only(contractIds, legacyIds);
  const lOnly = only(legacyIds, contractIds).filter((id) => scope === 'all' || covered.has(id));

  for (const id of cOnly) diffs.push({ kind: 'rule-only-contract', ruleId: id });
  for (const id of lOnly) diffs.push({ kind: 'rule-only-legacy', ruleId: id });
  return { match: diffs.length === 0, diffs };
}
