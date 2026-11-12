/**
 * contract/verdict.mjs —— 判定收敛（Phase1 骨架）
 *
 * 语义与 `lib/validate.js` **同义**：`ok ⇔ error 级 finding 数 === 0`
 * （对照 lib/validate.js 的 `ok: bySeverity.error === 0`，保证影子对比可比）。
 *
 * fail-closed：severity 不是 error/warning/info 三者之一 ⇒ 按 error 计（未知 = 红）。
 */

export const SEVERITIES = ['error', 'warning', 'info'];

/**
 * @param {Array<{severity?:string}>} [findings]
 * @returns {{ok:boolean, red:boolean, counts:{error:number,warning:number,info:number}, findings:Array}}
 */
export function verdictOf(findings = []) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    const sev = f && f.severity;
    if (sev === 'error' || sev === 'warning' || sev === 'info') counts[sev] += 1;
    else counts.error += 1; // fail-closed：未知 severity 不静默放过
  }
  const ok = counts.error === 0;
  return { ok, red: !ok, counts, findings };
}
