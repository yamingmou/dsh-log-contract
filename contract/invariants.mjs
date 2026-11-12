/**
 * contract/invariants.mjs —— 契约不变量（Phase1 骨架 · 只读判定）
 *
 * 不变量 = 对**抽象模型**的纯谓词，模型形状（由调用方注入，不绑定 loadSessionLog）：
 *   model = {
 *     header: { type, version, id, createdAt, cwd? },
 *     events: Array<{ seq, type }>,
 *     frames: { count, torn, firstFrameHeaderOnly },
 *   }
 *
 * 每条不变量：{ id, ruleIds[], severity, check(model, ctx) → finding[] }
 * finding = { invariantId, ruleId, severity, message }
 *
 * ⛔ Phase1 只收「不依赖 lib 内部状态」的 4 条；其余规则在 rules.mjs 里标 pending。
 * ⛔ 判定语义必须与 lib/validate.js 同义（ok ⇔ error==0），由 verdict.mjs 统一收敛。
 */

import { coverageOf } from './rules.mjs';

const isSafeNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isAbsolutePath = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'));

/** H1/H2：header 可判（结构 + 版本 + 必填字段）。 */
function checkHeader(model) {
  const out = [];
  const push = (ruleId, message) => out.push({ invariantId: 'INV-HDR', ruleId, severity: 'error', message });
  const h = model?.header;
  if (!h || typeof h !== 'object') {
    push('H1', '缺少 header / header 不是对象 —— 会话不可读');
    return out;
  }
  if (h.type !== 'session') push('H1', `header.type 必须为 "session"（实际 ${String(h.type)}）`);
  if (![0, 1, 2, 3, 4].includes(h.version)) push('H2', `header.version 未知（实际 ${String(h.version)}）——已知 0/1/2/3/4`);
  if (typeof h.id !== 'string' || h.id.length === 0) push('H2', 'header.id 必须为非空字符串');
  if (!isSafeNonNegInt(h.createdAt)) push('H2', 'header.createdAt 必须为非负安全整数');
  if (h.cwd !== undefined && !isAbsolutePath(h.cwd)) push('H2', 'header.cwd 若存在必须为绝对路径');
  return out;
}

/** E1/E2：seq 存在且严格连续（单写入者）。 */
function checkSeq(model) {
  const out = [];
  const push = (ruleId, message) => out.push({ invariantId: 'INV-SEQ', ruleId, severity: 'error', message });
  const events = Array.isArray(model?.events) ? model.events : [];
  let prev = null;
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object') {
      push('E1', `events[${i}] 不是对象`);
      return;
    }
    if (!isSafeNonNegInt(e.seq)) {
      push('E1', `events[${i}].seq 必须为非负安全整数（实际 ${String(e.seq)}）`);
      return;
    }
    if (prev !== null && e.seq !== prev + 1) push('E2', `seq 不连续：events[${i}] seq=${e.seq}，期望 ${prev + 1}`);
    prev = e.seq;
  });
  return out;
}

/** Z1/Z4/Z5：帧层结构（撕裂 / 首帧=header 单行 / 帧数>0）。 */
function checkFrames(model) {
  const out = [];
  const push = (ruleId, message) => out.push({ invariantId: 'INV-FRAME', ruleId, severity: 'error', message });
  const f = model?.frames;
  if (!f || typeof f !== 'object') {
    push('Z1', '缺少帧信息 —— 无法判定帧结构（fail-closed）');
    return out;
  }
  if (f.torn === true) push('Z1', 'zstd 尾帧撕裂（写入中或文件被截断）');
  if (f.firstFrameHeaderOnly === false) push('Z4', '首帧必须恰好一行 header（实际含多行）');
  if (!isSafeNonNegInt(f.count) || f.count === 0) push('Z5', `帧数必须为正整数（实际 ${String(f.count)}）`);
  return out;
}

/** 元不变量：规则目录覆盖（unknown/stale ⇒ 红）。 */
function checkCoverage(model, ctx) {
  const rules = ctx?.rules;
  const cov = coverageOf(rules);
  if (cov.ok) return [];
  const msgs = [];
  if (cov.unknown.length) msgs.push(`目录外规则 id：${cov.unknown.join(', ')}`);
  if (cov.stale.length) msgs.push(`分类表残留（目录已无）：${cov.stale.join(', ')}`);
  return [{ invariantId: 'INV-RULES-MAPPED', ruleId: '*', severity: 'error', message: msgs.join('；') }];
}

/** Phase1 不变量表（顺序固定，输出稳定）。 */
export const INVARIANTS = [
  { id: 'INV-HDR', ruleIds: ['H1', 'H2'], severity: 'error', check: checkHeader },
  { id: 'INV-SEQ', ruleIds: ['E1', 'E2'], severity: 'error', check: checkSeq },
  { id: 'INV-FRAME', ruleIds: ['Z1', 'Z4', 'Z5'], severity: 'error', check: checkFrames },
  { id: 'INV-RULES-MAPPED', ruleIds: [], severity: 'error', check: checkCoverage },
];

/**
 * 跑全部不变量。
 * @param {object} model 见文件头
 * @param {{rules?:Array<{id:string}>}} [ctx] 覆盖检查可注入自定义目录（负对照用）
 * @returns {Array<{invariantId,ruleId,severity,message}>}
 */
export function runInvariants(model, ctx = {}) {
  const findings = [];
  for (const inv of INVARIANTS) findings.push(...inv.check(model, ctx));
  return findings;
}
