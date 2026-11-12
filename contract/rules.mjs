/**
 * contract/rules.mjs —— 契约规则目录适配（Phase1 骨架 · 只读）
 *
 * 作用：把 `lib/contracts.js` 的 CONTRACT_RULES 目录（唯一真值）映射为 contract 层的
 * 分类视图：每条规则 statu = mapped（已被某条不变量覆盖）| pending（Phase2 适配器接入）。
 * ⛔ 本层不改 lib/、不新增规则；只为「覆盖可见」提供机检。
 *
 * 覆盖语义（coverageOf）：
 *   - mapped   规则 id ∈ INVARIANT_OF ⇒ 有 contract 不变量兜着
 *   - pending  在目录里但尚未映射 ⇒ **显式登记**，Phase2 才允许迁
 *   - unknown  传入了目录外的 id（夹具/注入/拼写错）⇒ 覆盖红（负对照用）
 *   - stale    分类表里有、目录里已无 ⇒ 目录漂移（红）
 */

import { CONTRACT_RULES } from '../lib/contracts.js';

/** Phase1 已映射到 contract 不变量的规则（其余一律 pending）。 */
export const INVARIANT_OF = {
  H1: 'INV-HDR',
  H2: 'INV-HDR',
  E1: 'INV-SEQ',
  E2: 'INV-SEQ',
  Z1: 'INV-FRAME',
  Z4: 'INV-FRAME',
  Z5: 'INV-FRAME',
};

/** 目录 id → 分类（构建期由真值目录生成，目录变化自动跟着变）。 */
export const RULE_STATUS = new Map();
for (const r of CONTRACT_RULES) {
  const inv = INVARIANT_OF[r.id];
  RULE_STATUS.set(
    r.id,
    inv
      ? { status: 'mapped', invariant: inv, layer: r.layer, severity: r.severity }
      : { status: 'pending', reason: `phase2:${r.layer}`, layer: r.layer, severity: r.severity },
  );
}

/**
 * @param {Array<{id:string}>} [rules] 待查的分类对象（默认=真值目录）
 * @returns {{total:number, mapped:Array, pending:Array, unknown:string[], stale:string[], ok:boolean}}
 *          ok ⇔ 无 unknown 且无 stale
 */
export function coverageOf(rules = CONTRACT_RULES) {
  const mapped = [];
  const pending = [];
  const unknown = [];
  const seen = new Set();
  for (const r of rules) {
    seen.add(r.id);
    const st = RULE_STATUS.get(r.id);
    if (!st) {
      unknown.push(r.id);
    } else if (st.status === 'mapped') {
      mapped.push({ id: r.id, invariant: st.invariant });
    } else {
      pending.push({ id: r.id, reason: st.reason });
    }
  }
  const stale = [...RULE_STATUS.keys()].filter((id) => !seen.has(id));
  return { total: rules.length, mapped, pending, unknown, stale, ok: unknown.length === 0 && stale.length === 0 };
}
