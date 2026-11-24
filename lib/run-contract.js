/**
 * lib/run-contract.js —— 运行时契约（family `run-contract`）：判据「跑的时候会不会静默变样」
 *
 * 三条可机检规则（断言接口，不绑定具体实现）：
 *   R-3  任一输入缺失 ⇒ 判不兼容（fail-closed）：缺字段/缺文件/缺必需上下文 ⇒ 必须拒绝且原因可见；
 *        ⛔ 不得落到"兼容/通过"或静默默认值 —— 「缺失永不匹配」：声明值、解析值、期望值三者必须完全相等。
 *   R-1  失败一次即置位（latched），恢复不清零：状态历史只能「未失败 → 失败」单向；任何
 *        恢复/重载/清缓存路径都不得把置位写回 false。
 *   R-2a 写失败（含写入结果未知）⇒ 产物不得标记为「完整」：必须撤回或标记不可用。
 *
 * 用法（调用方以**真实运行记录**喂进来；本模块只做判定，不读外部状态）：
 *   assertFailClosed({ required, provided, result })     → { ok, missing, findings }
 *   assertFailureLatched(history)                        → { ok, latchedAt, findings }
 *   assertWriteOutcome({ write, artifact })              → { ok, findings }
 *
 * 全部断言：合规样本 ⇒ `ok: true`；违规样本 ⇒ `ok: false` + 带证据的 finding（逐条可定位）。
 */
export const RUN_CONTRACT_FAMILY = 'run-contract';

export const RUN_CONTRACT_RULES = [
  {
    id: 'R-3',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '任一输入缺失 ⇒ 判不兼容（fail-closed）',
    source: '与「三重全等、缺失永不匹配」同口径：声明值/解析值/期望值必须完全相等，任一缺失即不匹配',
    description: '必需输入（字段 / 文件 / 上下文）缺失时，判定必须是**不兼容**（拒绝），且拒绝原因必须**可见**（点出缺了哪一项）。⛔ 缺输入却落到"兼容/通过"、或静默取默认值，都判红——缺失永不匹配。',
  },
  {
    id: 'R-1',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '失败一次即置位，恢复不清零',
    source: '失败一旦发生即 latched；状态历史单向：未失败 → 失败，不得回退',
    description: '状态历史里一旦出现 `failed: true`，其后任何快照都不得再出现 `failed: false`（恢复/重载/清缓存同样禁止清零）。缺省（未声明）视为"未清零"，只有显式 `false` 才算违规。',
  },
  {
    id: 'R-2a',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '写失败不得把产物标为完整',
    source: '不可信数据不得当完整数据交付：写失败（含结果未知）⇒ 撤回或标记不可用',
    description: '写入未成功（`write.ok !== true`，含 `ok` 缺省/未知）时，产物不得被标记为完整（`artifact.complete === true` 或 `artifact.status === "complete"`）；必须撤回或标 `partial` / `unavailable` / `withdrawn`。接口断言，不绑定具体写入实现。',
  },
];

export const RUN_CONTRACT_RULE_BY_ID = Object.freeze(Object.fromEntries(RUN_CONTRACT_RULES.map((r) => [r.id, r])));

/** 输入是否"缺失"：缺键 / undefined / null / 空白字符串 / NaN。 */
export function isMissingInput(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (typeof value === 'number' && Number.isNaN(value)) return true;
  return false;
}

const finding = (id, message, extra = {}) => {
  const rule = RUN_CONTRACT_RULE_BY_ID[id];
  return { id, rule: id, family: RUN_CONTRACT_FAMILY, severity: rule?.severity ?? 'error', title: rule?.title ?? null, message, ...extra };
};

/**
 * R-3 · 输入缺失必须 fail-closed 且原因可见。
 *
 * @param {{required?: string[], provided?: object, result?: {compatible?: boolean, reasons?: string[]}}} input
 *   `required` 必需输入名；`provided` 实际提供值；`result.compatible` 判定结论（true=兼容）；
 *   `result.reasons` 拒绝原因（必须点名缺失项）。
 * @returns {{id:'R-3', ok:boolean, missing:string[], findings:Array}}
 */
/** 按非字母数字切词（`file.b` → ['file','b']；用于完整 token 匹配，避免子串假通过）。 */
export function reasonTokensOf(text) {
  return String(text ?? '').split(/[^A-Za-z0-9_]+/).filter(Boolean);
}

/**
 * 拒绝原因是否**点名**了某输入：完整 token 相等（非子串）。
 * 反例：`required:['file']` + `reasons:['profile missing']` ⇒ 不点名（'file' 不是 'profile' 的一部分）。
 */
export function reasonMentions(reason, name) {
  const nameTokens = reasonTokensOf(name);
  if (nameTokens.length === 0) return false;
  const reasonTokens = reasonTokensOf(reason);
  return nameTokens.every((t) => reasonTokens.includes(t));
}

export function assertFailClosed({ required = [], provided = {}, result = {} } = {}) {
  const findings = [];
  const missing = required.filter((name) => !Object.hasOwn(provided ?? {}, name) || isMissingInput(provided[name]));
  const compatible = result?.compatible;
  const reasons = Array.isArray(result?.reasons) ? result.reasons : [];
  for (const name of missing) {
    if (compatible !== false) {
      findings.push(finding('R-3', `必需输入 "${name}" 缺失，但判定未拒绝（compatible=${String(compatible)}）——缺失必须判不兼容（fail-closed），不得落到兼容/通过或静默默认值`, { input: name, compatible: compatible ?? null }));
    } else if (!reasons.some((r) => typeof r === 'string' && reasonMentions(r, name))) {
      findings.push(finding('R-3', `必需输入 "${name}" 缺失且已拒绝，但拒绝原因不可见（reasons 未以完整 token 点名该输入）——原因必须能定位到缺项`, { input: name }));
    }
  }
  return { id: 'R-3', ok: findings.length === 0, missing, findings };
}

/**
 * R-1 · 失败置位后不得被清零（恢复/重载/清缓存同样禁止）。
 *
 * @param {Array<{phase?: string, failed?: boolean}>} history 时间序状态快照
 * @returns {{id:'R-1', ok:boolean, latchedAt: {index:number, phase:string|null}|null, findings:Array}}
 */
export function assertFailureLatched(history = []) {
  const findings = [];
  let latchedAt = null;
  (Array.isArray(history) ? history : []).forEach((snap, index) => {
    const failed = snap?.failed;
    if (failed === true && latchedAt === null) {
      latchedAt = { index, phase: snap?.phase ?? null };
      return;
    }
    if (latchedAt !== null && failed === false) {
      findings.push(finding('R-1', `失败在 ${latchedAt.phase ?? `#${latchedAt.index}`} 置位后，第 ${index} 步（phase=${snap?.phase ?? '-'}）把置位清零（failed=false）——恢复/重载/清缓存不得清零`, { index, phase: snap?.phase ?? null, latchedAt }));
    }
  });
  return { id: 'R-1', ok: findings.length === 0, latchedAt, findings };
}

/**
 * R-2a · 写失败（含结果未知）⇒ 产物不得标"完整"。
 *
 * @param {{write?: {ok?: boolean, error?: unknown}, artifact?: {complete?: boolean, status?: string}}} input
 * @returns {{id:'R-2a', ok:boolean, findings:Array}}
 */
export function assertWriteOutcome({ write = {}, artifact = {} } = {}) {
  const findings = [];
  const writeOk = write?.ok === true;
  const markedComplete = artifact?.complete === true
    || artifact?.status === 'complete';
  if (!writeOk && markedComplete) {
    findings.push(finding('R-2a', `写入未成功（ok=${String(write?.ok)}${write?.error ? `，error=${String(write.error)}` : ''}）但产物被标记为完整（${artifact?.complete === true ? 'complete=true' : `status=${String(artifact?.status)}`}）——写失败必须撤回或标记不可用（partial/unavailable/withdrawn）`, { writeOk, artifact }));
  }
  return { id: 'R-2a', ok: findings.length === 0, findings };
}

/**
 * 三条断言一起跑（调用方按需提供输入；未提供的断言跳过并在 `skipped` 里可见，⛔ 不冒充通过）。
 *
 * @param {{required?, provided?, result?, history?, write?, artifact?}} input
 * @returns {{family:string, rules:Array, checks:Array, skipped:string[], ok:boolean|null, findings:Array}}
 *   `ok: null` = **unverifiable**（三条断言一条都没跑：没有任何输入）——⛔ 不冒充通过。
 */
export function checkRunContract(input = {}) {
  const checks = [];
  const skipped = [];
  const findings = [];
  if (input.history !== undefined) {
    const r = assertFailureLatched(input.history);
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-1');
  if (input.write !== undefined || input.artifact !== undefined) {
    const r = assertWriteOutcome({ write: input.write, artifact: input.artifact });
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-2a');
  if (input.required !== undefined) {
    const r = assertFailClosed({ required: input.required, provided: input.provided, result: input.result });
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-3');
  const ran = checks.length > 0;
  return {
    family: RUN_CONTRACT_FAMILY,
    rules: RUN_CONTRACT_RULES.map(({ id, severity, title, layer }) => ({ id, severity, title, layer })),
    checks: checks.map(({ id, ok, findings: f }) => ({ id, ok, findings: f.length })),
    skipped,
    // 一条都没跑 ⇒ unverifiable（null），⛔ 不冒充通过；跑过 ⇒ 只看已跑断言的结论。
    ok: ran ? findings.length === 0 : null,
    findings,
  };
}
