/**
 * contract/plan.mjs —— 行动计划（Phase1 骨架 · 只读优先）
 *
 * 语义（迁移顺序的硬保证）：
 *   - `mode:'read'`  ⇒ **writePath 恒为 false**（先只读判定，后写路径；read 永不产生写动作）
 *   - `mode:'write'` ⇒ 仅 AUTO_REPAIRABLE 中的规则 id 产出 writePath:true
 *     （Phase1 为空集：未接 lib/repair.js 前**不存在自动可修项**，Phase2 才允许登记）
 *   - `needsHuman`：存在不可写动作时为 true（报告项都要人看）
 */

/** Phase2：接 lib/repair.js 后按规则 id 登记可自动修复项；Phase1 必须为空集。 */
export const AUTO_REPAIRABLE = new Set();

/**
 * @param {{findings?:Array}} verdict `verdictOf()` 的返回值
 * @param {{mode?:'read'|'write'}} [opts]
 * @returns {{mode:string, actions:Array, writesAllowed:boolean, needsHuman:boolean}}
 */
export function planOf(verdict, { mode = 'read' } = {}) {
  if (mode !== 'read' && mode !== 'write') throw new Error(`planOf: 未知 mode=${String(mode)}（只允许 read/write）`);
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const actions = findings.map((f) => {
    const auto = AUTO_REPAIRABLE.has(f.ruleId);
    return {
      ruleId: f.ruleId,
      invariantId: f.invariantId,
      kind: auto ? 'repair' : 'report',
      writePath: mode === 'write' && auto,
      message: f.message,
    };
  });
  const writesAllowed = mode === 'write' && actions.some((a) => a.writePath === true);
  return { mode, actions, writesAllowed, needsHuman: actions.some((a) => a.writePath === false) };
}
