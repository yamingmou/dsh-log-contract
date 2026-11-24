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
  {
    id: 'R-2b',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '撤回必须带消费方可读的原因',
    source: '撤回类响应必须含 reason 字段（不是日志/旁路）：原因写进日志或遥测，消费方读不到即等于没有原因',
    description: '撤回类响应（`kind/type` 含 withdraw、或 `withdrawn === true`、或 `status === "withdrawn"`）必须携带**消费方可读**的原因字段（默认 `reason`，非空字符串）；原因只出现在 `log` / `metadata` / `telemetry` 等旁路 ⇒ 仍判红。实现侧**没有**原因字段概念时，调用方传 `reasonSupported: false` ⇒ 结果 `ok: null`（unverifiable，⛔ 不冒充通过）。',
  },
  {
    id: 'R-2b-2',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '初始化中/取不到 不得按空值推"没有"',
    source: '资源未就绪（索引/读端/父链未加载）时，空结果只表示"现在还读不到"，不表示"没有"',
    description: '资源（归档索引/读端/父链等）处于**初始化中或取不到**时，若 `initialized !== true` 却按空值继续判断（把"还没准备好"当成"不存在/无父/无归档"）⇒ 判红。调用方无初始化信号时结果 `ok: null`（unverifiable，⛔ 不冒充通过）。属性口径：看"是否在有就绪信号前就下了空值结论"，不绑定具体读端实现。',
  },
  {
    id: 'R-5',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '闭集须穷尽；开集不得穷尽（留痕 + 默认放行 + 可升级）',
    source: '枚举封闭 ≠ 契约封闭：自己的闭集应穷尽（漏值没人发现），外部会新增的集合不得穷尽（上游加值即崩）',
    description: '**闭集**（自己定义的枚举：已知事件类型表、规则 id/severity 集）必须**穷尽**——声明里有的值都要被处理（未处理 ⇒ 红），处理到的值都必须在声明内（外溢 ⇒ 红）。**开集**（外部会新增：上游事件 type、错误码、provider 名）**不得穷尽**——未知值必须**留痕 + 默认放行 + 可升级**；未知值被判拒绝、或没有留痕、或不可升级 ⇒ 红。',
  },
  {
    id: 'R-6',
    family: RUN_CONTRACT_FAMILY,
    layer: 'run',
    severity: 'error',
    title: '副作用必须幂等（同键只执行一次）',
    source: '同一稳定幂等键的副作用被重复执行 ⇒ 重复写入/重复发送等不可逆后果；第二次必须返回缓存或显式"重复"',
    description: '运行记录按**稳定幂等键**（默认 `key`；运行时可提供 tool call id / turn+step / 消息 id 这类天然键）分组：同一键的副作用**执行次数必须 ≤ 1**；后续尝试必须返回缓存/显式"重复"（`effect/outcome ∈ deduped/cached/duplicate/replayed/skipped/noop`）——执行结果不可判定同样判红。⛔ 记录里没有稳定键 ⇒ `ok: null`（unverifiable，缺前置：键由运行时/调用方提供）。',
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
 * 撤回类响应识别（属性口径：看语义标记，不绑定具体实现）。
 * @param {object} item
 * @returns {boolean}
 */
export function isWithdrawalLike(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.kind === 'withdrawal' || item.type === 'withdrawal') return true;
  if (item.withdrawal === true || item.withdrawn === true) return true;
  if (item.status === 'withdrawn' || item.status === 'withdrawal') return true;
  if (typeof item.type === 'string' && item.type.includes('withdraw')) return true;
  if (typeof item.kind === 'string' && item.kind.includes('withdraw')) return true;
  return false;
}

/**
 * R-2b · 撤回类响应必须带**消费方可读**的原因（不是日志/旁路）。
 *
 * @param {{withdrawals?: object|object[], reasonField?: string, reasonSupported?: boolean}} input
 *   `withdrawals` 缺省 ⇒ `ok: null`（无输入，不冒充通过）；
 *   `reasonSupported === false` ⇒ `ok: null`（实现侧无原因字段概念，按缺前置登记）。
 * @returns {{id:'R-2b', ok:boolean|null, checked:number, findings:Array}}
 */
export function assertWithdrawalHasReason({ withdrawals, reasonField = 'reason', reasonSupported } = {}) {
  if (withdrawals === undefined) return { id: 'R-2b', ok: null, checked: 0, skipped: 'no-withdrawals-input', findings: [] };
  if (reasonSupported === false) return { id: 'R-2b', ok: null, checked: 0, skipped: 'implementation-provides-no-reason-field', findings: [] };
  const list = (Array.isArray(withdrawals) ? withdrawals : [withdrawals]).filter(isWithdrawalLike);
  if (list.length === 0) return { id: 'R-2b', ok: null, checked: 0, skipped: 'no-withdrawal-items', findings: [] };
  const findings = [];
  for (const item of list) {
    const reason = item?.[reasonField];
    const readable = typeof reason === 'string' && reason.trim() !== '';
    if (readable) continue;
    const sideChannels = ['log', 'logs', 'metadata', 'telemetry'].filter((k) => item && item[k] !== undefined);
    findings.push(finding('R-2b', `撤回类响应缺消费方可读的 ${reasonField} 字段（原因必须是响应本身的字段，不是日志/旁路）${sideChannels.length > 0 ? `——原因若只在 ${sideChannels.join('/')} 里，消费方读不到` : ''}`, { reasonField, sideChannels }));
  }
  return { id: 'R-2b', ok: findings.length === 0, checked: list.length, findings };
}

const APPLIED_TAGS = new Set(['applied', 'executed', 'side-effect', 'write', 'committed']);
const DEDUPED_TAGS = new Set(['deduped', 'cached', 'duplicate', 'replayed', 'skipped', 'noop', 'not-applied', 'ignored']);

/** 单次副作用的执行状态：applied / deduped / unknown。 */
export function sideEffectState(op) {
  if (op?.applied === true) return 'applied';
  if (op?.applied === false) return 'deduped';
  const tag = op?.effect ?? op?.outcome ?? op?.status;
  if (APPLIED_TAGS.has(tag)) return 'applied';
  if (DEDUPED_TAGS.has(tag)) return 'deduped';
  return 'unknown';
}

/**
 * R-6 · 副作用幂等：同键执行次数 ≤1；后续尝试必须缓存/显式"重复"。
 *
 * @param {{operations?: object|object[], keyField?: string}} input
 *   `operations` 缺省或**没有任何稳定键** ⇒ `ok: null`（unverifiable，缺前置）。
 * @returns {{id:'R-6', ok:boolean|null, keys:number, findings:Array}}
 */
export function assertIdempotentSideEffects({ operations, keyField = 'key' } = {}) {
  if (operations === undefined) return { id: 'R-6', ok: null, keys: 0, skipped: 'no-operations-input', findings: [] };
  const list = (Array.isArray(operations) ? operations : [operations])
    .filter((op) => op && typeof op[keyField] === 'string' && op[keyField].trim() !== '');
  if (list.length === 0) return { id: 'R-6', ok: null, keys: 0, skipped: 'no-stable-keys', findings: [] };
  const byKey = new Map();
  for (const op of list) {
    const k = op[keyField];
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(op);
  }
  const findings = [];
  for (const [key, ops] of byKey) {
    const applied = ops.filter((op) => sideEffectState(op) === 'applied');
    if (applied.length > 1) {
      findings.push(finding('R-6', `同一幂等键 "${key}" 的副作用被执行了 ${applied.length} 次（应 ≤1）——重复执行不可逆，第二次必须返回缓存或显式"重复"`, { key, applied: applied.length }));
    }
    for (const op of ops) {
      const state = sideEffectState(op);
      if (state === 'unknown') {
        findings.push(finding('R-6', `同一幂等键 "${key}" 的一次执行结果不可判定（effect/outcome=${String(op?.effect ?? op?.outcome ?? op?.status)}）——必须显式标 applied 或缓存/重复`, { key }));
      }
    }
  }
  return { id: 'R-6', ok: findings.length === 0, keys: byKey.size, findings };
}

/**
 * R-2b-2 · 有初始化信号时，不得在未就绪状态下按空值继续判断。
 *
 * @param {{resources?: object|object[], initializedField?: string, judgedField?: string}} input
 *   `resources` 每项：`{ name?, initialized?: boolean, judgedFromEmpty?: boolean }`；
 *   没有任何 `initialized` 信号 ⇒ `ok: null`（unverifiable）。
 * @returns {{id:'R-2b-2', ok:boolean|null, checked:number, findings:Array}}
 */
export function assertInitializedNotTreatedAsEmpty({ resources, initializedField = 'initialized', judgedField = 'judgedFromEmpty' } = {}) {
  if (resources === undefined) return { id: 'R-2b-2', ok: null, checked: 0, skipped: 'no-resources-input', findings: [] };
  const list = (Array.isArray(resources) ? resources : [resources]).filter((r) => r && typeof r === 'object');
  const signaled = list.filter((r) => r[initializedField] === true || r[initializedField] === false);
  if (signaled.length === 0) return { id: 'R-2b-2', ok: null, checked: 0, skipped: 'no-initialization-signal', findings: [] };
  const findings = [];
  for (const r of signaled) {
    const name = r.name ?? r.id ?? null;
    if (r[initializedField] !== true && r[judgedField] === true) {
      findings.push(finding('R-2b-2', `资源「${String(name ?? '?')}」未就绪（${initializedField}=${String(r[initializedField])}）却按空值继续判断（${judgedField}=true）——初始化中/取不到不得推"没有"`, { resource: name, initialized: r[initializedField] }));
    }
  }
  return { id: 'R-2b-2', ok: findings.length === 0, checked: signaled.length, findings };
}

/**
 * R-5（闭集）· 自己定义的枚举必须穷尽，且不得外溢。
 *
 * @param {{closedSet?: string[], covered?: string[]}} input
 *   `closedSet` 声明的枚举；`covered` 实际处理到的值。
 * @returns {{id:'R-5', kind:'closed-set', ok:boolean|null, missing:string[], extra:string[], findings:Array}}
 */
export function assertClosedSetExhaustive({ closedSet, covered } = {}) {
  if (closedSet === undefined || covered === undefined) {
    return { id: 'R-5', kind: 'closed-set', ok: null, missing: [], extra: [], skipped: 'no-closed-set-input', findings: [] };
  }
  const declared = new Set(closedSet);
  const handled = new Set(covered);
  const missing = [...declared].filter((v) => !handled.has(v));
  const extra = [...handled].filter((v) => !declared.has(v));
  const findings = [];
  for (const v of missing) findings.push(finding('R-5', `闭集成员「${String(v)}」在声明里但没有任何处理分支——闭集未穷尽（漏值不会被发现）`, { kind: 'closed-set', value: v }));
  for (const v of extra) findings.push(finding('R-5', `处理分支出现闭集之外的值「${String(v)}」——闭集外溢（应把它加进声明，否则契约不封闭）`, { kind: 'closed-set', value: v }));
  return { id: 'R-5', kind: 'closed-set', ok: findings.length === 0, missing, extra, findings };
}

/**
 * R-5（开集）· 外部会新增的集合不得穷尽：未知值必须留痕 + 默认放行 + 可升级。
 *
 * @param {{openSet?: string[], observations?: Array<{value:string, decision?:'allow'|'reject', traced?:boolean, upgradeable?:boolean}>}} input
 * @returns {{id:'R-5', kind:'open-set', ok:boolean|null, unknown:string[], findings:Array}}
 */
export function assertOpenSetTolerant({ openSet = [], observations } = {}) {
  if (observations === undefined) {
    return { id: 'R-5', kind: 'open-set', ok: null, unknown: [], skipped: 'no-observations-input', findings: [] };
  }
  const known = new Set(openSet);
  const list = Array.isArray(observations) ? observations : [observations];
  const unknown = [];
  const findings = [];
  for (const obs of list) {
    const value = obs?.value;
    if (typeof value !== 'string' || known.has(value)) continue;
    unknown.push(value);
    if (obs.decision !== 'allow') {
      findings.push(finding('R-5', `外部集合的未知值「${value}」被拒绝（decision=${String(obs.decision)}）——外部集合会新增，不得穷尽/不得因未知而拒`, { kind: 'open-set', value }));
    }
    if (obs.traced !== true) {
      findings.push(finding('R-5', `外部集合的未知值「${value}」没有留痕（traced!==true）——未知必须可观察`, { kind: 'open-set', value }));
    }
    if (obs.upgradeable !== true) {
      findings.push(finding('R-5', `外部集合的未知值「${value}」未标可升级（upgradeable!==true）——必须留出升级路径`, { kind: 'open-set', value }));
    }
  }
  return { id: 'R-5', kind: 'open-set', ok: findings.length === 0, unknown, findings };
}

/**
 * 断言一起跑（调用方按需提供输入；未提供的断言跳过并在 `skipped` 里可见，⛔ 不冒充通过）。
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
  if (input.withdrawals !== undefined) {
    const r = assertWithdrawalHasReason({ withdrawals: input.withdrawals, reasonField: input.reasonField, reasonSupported: input.reasonSupported });
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-2b');
  if (input.initializations !== undefined) {
    const r = assertInitializedNotTreatedAsEmpty({ resources: input.initializations });
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-2b-2');
  if (input.closedSet !== undefined) {
    const r = assertClosedSetExhaustive(input.closedSet);
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-5-closed');
  if (input.openSet !== undefined) {
    const r = assertOpenSetTolerant(input.openSet);
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-5-open');
  if (input.operations !== undefined) {
    const r = assertIdempotentSideEffects({ operations: input.operations, keyField: input.keyField });
    checks.push(r);
    findings.push(...r.findings);
  } else skipped.push('R-6');
  const ran = checks.filter((c) => c.ok !== null).length > 0;
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
