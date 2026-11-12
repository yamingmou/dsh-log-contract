/**
 * lib/error-contract.js —— 错误表达契约静态检查（E1–E6 · 可疑清单，非缺陷认定）
 *
 * 依据：错误表达契约的核心判据 + E4–E6 的可执行判据与 T1/T2 范围约定（内部讨论结论）。
 *
 * 核心判据：调用方必须靠匹配错误字符串才能分辨「该重试还是该放弃」⇒ 缺的是契约，不是文案。
 *
 * ⚠️ 本模块输出的是**可疑清单**，不是"某包违规"的判定：规则是启发式的，必然有假阳性，
 * 每条 finding 都带 `evidence`（原始片段）供人复核；白名单见 `whitelist` 参数。
 *
 * 规则（E1–E6，target 分 T1 我方 / T2 官方）：
 *   E1 一个码多成因：同一 CODE ≥2 个 throw site，且 message 或前置条件（是否在 catch 内）不同
 *   E2 message 是常量：同一 CODE 的 ≥2 个 site 共用**同一 message 模板**（插值只含标识）⇒ 无法区分分支
 *   E3 终态词用于非终态因：码名含 NOT_*／UNAVAILABLE／FATAL／CORRUPT，却在 catch 内把任意 error 收编（带 cause）
 *   E4 cause 未透出：throw 带 { cause }，但 message 不含 cause 的摘要（error.code／error.name／error.message）
 *   E5 无条件成功：async 函数所有正常返回都是 true/void，且无 throw（需看调用方，默认只报候选）
 *   E6 声称无执行点：① 配置声明 key 无读取点；② README 不变式句（never/always/guaranteed/must not）无对应断言
 *      ⇒ 默认只输出候选（info），不阻断
 *
 * 范围：`target: 'T1'` = 我方代码（要修）；`'T2'` = 官方产物（只登记/报上游）。
 * 两类**不得混在同一份报告**里（summary 分列 + CLI `--target` 显式选择）。
 */

export const ERROR_CONTRACT_FAMILY = 'error-expression';

/** 规则目录（id 为 E1–E6；注意：与日志契约的 E1–E11 是**不同家族**，靠 family 区分）。 */
export const ERROR_CONTRACT_RULES = [
  {
    id: 'E1',
    title: '一个码多成因',
    family: ERROR_CONTRACT_FAMILY,
    severity: 'error',
    layer: 'L1',
    target: 'T1',
    detection: '按 code 聚合 new XxxError(msg, "CODE", …)：同一 CODE ≥2 个 throw site 且（message 模板不同 或 是否在 catch 内不同）⇒ 报',
    falsePositiveRisk: 'low',
  },
  {
    id: 'E2',
    title: 'message 是常量',
    family: ERROR_CONTRACT_FAMILY,
    severity: 'error',
    layer: 'L1',
    target: 'T1',
    detection: '同一 CODE 的 ≥2 个 site 共用同一 message 模板（插值只含标识，不含判据）⇒ 报',
    falsePositiveRisk: 'low',
  },
  {
    id: 'E3',
    title: '终态词用于非终态因',
    family: ERROR_CONTRACT_FAMILY,
    severity: 'warning',
    layer: 'L1',
    target: 'T1',
    detection: 'code 名匹配 NOT_[A-Z]+／UNAVAILABLE／FATAL／CORRUPT，且该 throw 位于 catch 内并把任意 error 以 cause 收编 ⇒ 报',
    falsePositiveRisk: 'medium',
  },
  {
    id: 'E4',
    title: 'cause 未透出',
    family: ERROR_CONTRACT_FAMILY,
    severity: 'warning',
    layer: 'L1',
    target: 'T1',
    detection: 'throw 带 { cause } 但 message 不含 cause.code／cause.name／cause.message 等摘要 ⇒ 报',
    falsePositiveRisk: 'medium',
  },
  {
    id: 'E5',
    title: '无条件成功',
    family: ERROR_CONTRACT_FAMILY,
    severity: 'info',
    layer: 'L1',
    target: 'T1',
    detection: 'async 函数所有正常返回都是 true/void 且无 throw（需看调用方是否把返回值当"已成功"消费）⇒ 只报候选',
    falsePositiveRisk: 'low',
  },
  {
    id: 'E6',
    title: '声称无执行点',
    family: ERROR_CONTRACT_FAMILY,
    severity: 'info',
    layer: 'L2',
    target: 'T1',
    detection: '① 配置声明的 key 在代码里无读取点；② README 的 never/always/guaranteed/must not 不变式句在写入路径无对应断言 ⇒ 只输出候选',
    falsePositiveRisk: 'high',
  },
];

export const ERROR_CONTRACT_RULE_BY_ID = new Map(ERROR_CONTRACT_RULES.map((r) => [r.id, r]));

// ── 词表 ────────────────────────────────────────────────────────────────��───
/** 码名里的终态词（E3）。 */
const TERMINAL_CODE_RE = /(^|_)(NOT_[A-Z0-9_]+|UNAVAILABLE|FATAL|CORRUPT)($|_)/;
/** 判据词（E2 反面）：message 里出现这些词说明它带"为什么"，不算常量。 */
const JUDGEMENT_WORDS = /\b(because|due to|reason|when|while|if|since|unsupported|invalid|missing|mismatch|conflict|exceed|exceeded|denied|refused|blocked)\b/i;
/** 标识类插值字段（E2：只插标识 ⇒ 无法区分分支）。 */
const IDENT_FIELDS = new Set(['id', 'childid', 'taskid', 'parentid', 'callid', 'path', 'file', 'filename', 'name', 'seq', 'index', 'line', 'lineno', 'count', 'size', 'key', 'type', 'code']);

// ── 词法：掩码注释/字符串 + 收集字符串字面量 ─────────────────────────────
/**
 * @param {string} text
 * @returns {{masked:string, strings:Array<{start:number,end:number,kind:'string'|'template',value:string,interpolations:Array<{start:number,end:number,expr:string}>}>}}
 */
function lexMask(text) {
  const chars = text.split('');
  const strings = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      for (let k = i; k < j; k++) chars[k] = ' ';
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? text.length : j + 2;
      for (let k = i; k < j; k++) chars[k] = ' ';
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      const quote = c;
      i++;
      let value = '';
      const interpolations = [];
      while (i < text.length) {
        if (text[i] === '\\') {
          value += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          const exprStart = j;
          while (j < text.length && depth > 0) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') depth--;
            if (depth === 0) break;
            j++;
          }
          interpolations.push({ start: exprStart, end: j, expr: text.slice(exprStart, j) });
          value += '${}';
          i = j + 1;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        if (text[i] === '\n' && quote !== '`') break;
        value += text[i];
        i++;
      }
      const end = i;
      strings.push({ start, end, kind: quote === '`' ? 'template' : 'string', value, interpolations });
      for (let k = start; k < end; k++) chars[k] = ' ';
      continue;
    }
    i++;
  }
  return { masked: chars.join(''), strings };
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** 在掩码文本上从 `(` 起步解析参数区间（括号/方/花括号联合计深）。 */
function parseArgs(masked, openIdx) {
  const args = [];
  let depth = 0;
  let cur = openIdx + 1;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (i > cur) args.push({ start: cur, end: i });
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push({ start: cur, end: i });
      cur = i + 1;
    }
  }
  return args;
}

/** catch 区域（掩码文本上的 `catch (e) { … }`）。 */
function catchRegions(masked) {
  const regions = [];
  const re = /\bcatch\s*(?:\(([^)]*)\))?\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = masked.length;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    regions.push({ start: open, end, param: (m[1] || '').trim() });
  }
  return regions;
}

/** 从字符串字面量取 message 模板信息。 */
function messageInfo(text, str) {
  return {
    kind: str.kind,
    raw: text.slice(str.start, str.end),
    value: str.value,
    interpolations: str.interpolations.map((it) => it.expr.trim()),
  };
}

/** message 模板签名（E1/E2 判"是否同一模板"）。
 *  N6：插值**归一为 `$`**（`${z}` 与 `${w}` 视为同一模板）——贴「message 是常量」的语义；
 *  变量名差异不再被当成"不同 message"。 */
function templateSig(msg) {
  return msg.value;
}

/** 判据/摘要类末段：这些字段本身就在表达"为什么"，不算纯标识。 */
const JUDGEMENT_MEMBERS = new Set(['code', 'name', 'message', 'reason', 'status', 'kind', 'error']);

/** E2 判据：插值只含标识（简单变量/属性路径；不含调用/运算/比较；末段不是判据字段）。 */
function onlyIdentifiers(msg) {
  if (msg.interpolations.length === 0) return true;
  return msg.interpolations.every((expr) => {
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(expr)) return false; // 含调用/运算/比较 ⇒ 可能带判据
    const last = expr.split('.').pop().toLowerCase();
    if (JUDGEMENT_MEMBERS.has(last)) return false;
    return IDENT_FIELDS.has(last) || /^[a-z]$/.test(last) || /id$|path$|seq$|count$|size$|name$/.test(last);
  });
}

/** 扫一个文件的 throw 点。 */
function scanThrows(text, masked, strings, catches) {
  const sites = [];
  const re = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const ctor = m[1];
    const openIdx = m.index + m[0].length - 1;
    const argRanges = parseArgs(masked, openIdx);
    const site = { index: m.index, line: lineOf(text, m.index), ctor, code: null, msg: null, hasCause: false, causeExpr: null, inCatch: false, catchParam: null };
    const argInfo = argRanges.map((a, idx) => {
      const raw = text.slice(a.start, a.end);
      const trimmed = raw.trim();
      const strLit = strings.find((s) => s.start >= a.start && s.end <= a.end);
      return {
        idx,
        raw,
        trimmed,
        str: strLit && strLit.kind === 'template' ? strLit : (strLit && /^["']/.test(trimmed) ? strLit : null),
        cause: (trimmed.match(/\bcause\s*:\s*([^,}]+)/) || [])[1],
      };
    });
    const firstString = argInfo.find((x) => x.str && x.idx === 0);
    const codeArg = argInfo.find((x) => x.str && x.idx >= 1 && /^[A-Z][A-Z0-9_]*$/.test(x.str.value));
    const msgArg = firstString || argInfo.find((x) => x.str);
    if (msgArg) site.msg = messageInfo(text, msgArg.str);
    if (codeArg) site.code = codeArg.str.value;
    for (const x of argInfo) {
      if (x.cause) { site.hasCause = true; site.causeExpr = x.cause.trim(); }
    }
    const region = catches.find((r) => site.index > r.start && site.index < r.end);
    if (region) { site.inCatch = true; site.catchParam = region.param; }
    if (site.msg || site.code) sites.push(site);
  }
  return sites;
}

/** 扫 E5 候选：async 函数体里正常返回恒 true/void 且无 throw。 */
function scanE5(text, masked) {
  const out = [];
  const re = /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = masked.length;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = masked.slice(open, end + 1);
    if (/\bthrow\b/.test(body)) continue; // 有失败路径可不报
    const returns = [...body.matchAll(/\breturn\b([^;\n}]*)/g)].map((x) => x[1].trim());
    if (returns.length === 0) continue;
    const allTrue = returns.every((r) => r === '' || r === 'true');
    if (allTrue) {
      out.push({ name: m[1], line: lineOf(text, m.index), returns });
    }
  }
  return out;
}

/**
 * 扫单个源码文本。
 * @param {{file:string, text:string}} input
 * @returns {Array<object>} findings（未做白名单过滤）
 */
export function scanSource({ file, text }) {
  const { masked, strings } = lexMask(text);
  const catches = catchRegions(masked);
  const sites = scanThrows(text, masked, strings, catches);
  const findings = [];

  // E1 / E2 / E3 / E4（按 code 聚合与逐点判定）
  const byCode = new Map();
  for (const s of sites) {
    if (!s.code) continue;
    if (!byCode.has(s.code)) byCode.set(s.code, []);
    byCode.get(s.code).push(s);
  }

  for (const [code, group] of byCode) {
    const msgs = group.filter((s) => s.msg);
    const sigs = new Set(msgs.map((s) => templateSig(s.msg)));
    const catchMix = new Set(group.map((s) => (s.inCatch ? 'catch' : 'top')));
    if (group.length >= 2 && (sigs.size >= 2 || catchMix.size >= 2)) {
      findings.push({
        id: 'E1', rule: 'E1', family: ERROR_CONTRACT_FAMILY, severity: 'error', file, ruleMeta: 'E1',
        line: group[0].line,
        message: `一个码多成因：CODE=${code} 有 ${group.length} 个 throw site（message 模板 ${sigs.size} 种 / 上下文 ${[...catchMix].join('+')}）`,
        evidence: { code, sites: group.map((s) => ({ line: s.line, ctor: s.ctor, inCatch: s.inCatch, msg: s.msg ? s.msg.raw : null })) },
      });
    }
    // E2：同一模板被 ≥2 个 throw site 共用（插值只含标识、无判据词）⇒ message 是常量，无法区分分支
    const byTemplate = new Map();
    for (const s of msgs) {
      const sig = templateSig(s.msg);
      if (!byTemplate.has(sig)) byTemplate.set(sig, []);
      byTemplate.get(sig).push(s);
    }
    for (const [, same] of byTemplate) {
      if (same.length < 2) continue;
      if (!onlyIdentifiers(same[0].msg) || JUDGEMENT_WORDS.test(same[0].msg.value)) continue;
      findings.push({
        id: 'E2', rule: 'E2', family: ERROR_CONTRACT_FAMILY, severity: 'error', file, ruleMeta: 'E2',
        line: same[0].line,
        message: `message 是常量：CODE=${code} 的 ${same.length} 个 site 共用同一模板（插值只含标识，未带判据）`,
        evidence: { code, template: same[0].msg.raw, sites: same.map((s) => s.line) },
      });
      break;
    }
    for (const s of group) {
      if (!s.msg) continue;
      if (TERMINAL_CODE_RE.test(code) && s.inCatch && s.hasCause) {
        findings.push({
          id: 'E3', rule: 'E3', family: ERROR_CONTRACT_FAMILY, severity: 'warning', file, ruleMeta: 'E3',
          line: s.line,
          message: `终态词用于非终态因：CODE=${code} 在 catch 内把任意 error 收编为终态码`,
          evidence: { code, ctor: s.ctor, cause: s.causeExpr, msg: s.msg.raw },
        });
      }
      if (s.hasCause && !/(\.code|\.name|\.message)\b/.test(s.msg.value) && !s.msg.interpolations.some((e) => /\.(code|name|message)\b/.test(e))) {
        findings.push({
          id: 'E4', rule: 'E4', family: ERROR_CONTRACT_FAMILY, severity: 'warning', file, ruleMeta: 'E4',
          line: s.line,
          message: `cause 未透出：CODE=${code} 带 { cause } 但 message 不含 cause 摘要`,
          evidence: { code, cause: s.causeExpr, msg: s.msg.raw },
        });
      }
    }
  }

  // E5（候选）
  for (const fn of scanE5(text, masked)) {
    findings.push({
      id: 'E5', rule: 'E5', family: ERROR_CONTRACT_FAMILY, severity: 'info', file, ruleMeta: 'E5',
      line: fn.line,
      message: `无条件成功（候选）：async ${fn.name}() 所有正常返回恒 true/void 且无 throw —— 需看调用方`,
      evidence: { fn: fn.name, returns: fn.returns },
    });
  }

  return findings;
}

/** E6①：声明 key 无读取点（跨文件，候选）。 */
export function scanDeclaredKeysNoRead({ keys = [], sources = [], file = '(config)' } = {}) {
  const findings = [];
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const k of keys) {
    const name = typeof k === 'string' ? k : k && k.name;
    if (!name) continue;
    const readRe = new RegExp(`(?:config\\.|config\\[|\\b)${esc(name)}\\b`);
    const hit = sources.some((src) => readRe.test(src.text));
    if (!hit) {
      findings.push({
        id: 'E6', rule: 'E6', family: ERROR_CONTRACT_FAMILY, severity: 'info', file: (k && k.file) || file, ruleMeta: 'E6',
        line: (k && k.line) ?? null,
        message: `声称无执行点（候选）：配置声明 key "${name}" 在已扫代码里无读取点`,
        evidence: { key: name, searched: sources.map((src) => src.file) },
      });
    }
  }
  return findings;
}

/** E6②：README 不变式句（候选，需人工确认写入路径有无对应校验）。 */
export function scanInvariantSentences({ file, text }) {
  const findings = [];
  const re = /(never|always|guaranteed|must\s+not)/i;
  text.split('\n').forEach((line, i) => {
    if (!re.test(line)) return;
    if (line.trim().length < 20) return; // 太短的多半是标题/表格残片
    findings.push({
      id: 'E6', rule: 'E6', family: ERROR_CONTRACT_FAMILY, severity: 'info', file, ruleMeta: 'E6',
      line: i + 1,
      message: '声称无执行点（候选）：不变式句需人工确认写入路径有对应校验',
      evidence: { sentence: line.trim().slice(0, 160) },
    });
  });
  return findings;
}

/**
 * 白名单（fail-closed）：entries[{rule, file, line?, reason, expires}]
 * expires 必填且 YYYY-MM-DD；缺失/非法/过期 ⇒ 抛错（由调用方 exit 2），⛔ 不得静默放行。
 */
export function validateWhitelist(entries, today = new Date().toISOString().slice(0, 10)) {
  const list = Array.isArray(entries) ? entries : [];
  const problems = [];
  const active = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    if (!e.rule || !ERROR_CONTRACT_RULE_BY_ID.has(String(e.rule))) problems.push(`whitelist[${i}].rule 非法（须为 E1–E6）：${e.rule}`);
    if (typeof e.file !== 'string' || e.file.length === 0) problems.push(`whitelist[${i}].file 必填`);
    if (typeof e.reason !== 'string' || e.reason.trim().length === 0) problems.push(`whitelist[${i}].reason 必填`);
    if (typeof e.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) problems.push(`whitelist[${i}].expires 必填且须 YYYY-MM-DD`);
    else if (e.expires < today) problems.push(`whitelist[${i}] 已过期（expires=${e.expires}）`);
    else active.push(e);
  }
  return { ok: problems.length === 0, problems, active };
}

/** 路径归一（N1）：折叠重复斜杠、去尾斜杠；白名单比较与 CLI walk 共用同一口径。 */
export function normalizePath(p) {
  if (typeof p !== 'string') return p;
  let x = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (x.length > 1) x = x.replace(/\/+$/, '');
  return x;
}

const isWhitelisted = (finding, active) =>
  active.some((w) => w.rule === finding.id
    && (w.file === '*' || normalizePath(finding.file) === normalizePath(w.file))
    && (w.line === undefined || w.line === finding.line));

/**
 * 汇总报告（CLI 与测试共用；同一 schemaVersion 纪律，新增键不破坏旧消费者）。
 * @param {{files:Array<{file:string,text:string}>, target?:'T1'|'T2', whitelist?:Array<object>}} input
 */
export function checkErrorContract({ files = [], target = 'T1', whitelist = [], declaredKeys = [] }) {
  const { ok: wlOk, problems: wlProblems, active } = validateWhitelist(whitelist);
  const rawFindings = [];
  const sources = files.filter((f) => /\.(mjs|cjs|js)$/i.test(f.file));
  for (const f of files) {
    rawFindings.push(...scanSource({ file: f.file, text: f.text }));
    if (/\.md$/i.test(f.file)) rawFindings.push(...scanInvariantSentences({ file: f.file, text: f.text }));
  }
  // E6①：配置声明 key 的读取点检查（N3：CLI --keys/--config 可达）
  if (declaredKeys.length) rawFindings.push(...scanDeclaredKeysNoRead({ keys: declaredKeys, sources }));
  const suppressed = rawFindings.filter((x) => isWhitelisted(x, active));
  const findings = rawFindings.filter((x) => !isWhitelisted(x, active));
  const byRule = {};
  const bySeverity = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    byRule[f.id] = (byRule[f.id] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return {
    schemaVersion: '1',
    family: ERROR_CONTRACT_FAMILY,
    target,
    rules: ERROR_CONTRACT_RULES.map((r) => ({ id: r.id, severity: r.severity, title: r.title, layer: r.layer, target: r.target, falsePositiveRisk: r.falsePositiveRisk })),
    findings,
    suppressed: suppressed.map(({ evidence, ...rest }) => rest),
    summary: {
      files: files.length,
      findings: findings.length,
      suppressed: suppressed.length,
      byRule,
      bySeverity,
      whitelistOk: wlOk,
      whitelistProblems: wlProblems,
    },
  };
}
