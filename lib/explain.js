/**
 * dsh-log-contract · lib/explain.js
 *
 * `explain <ruleId>` 的数据层：把一条契约规则"解读"成结构化对象。
 *
 * **单一权威**：标题 / 判据（触发条件）/ 严重度 / 层级 / 出处 **原样引自
 * `lib/contracts.js` 的 `CONTRACT_RULES`**——本模块 ⛔ 不复制、不改写判据文本，
 * 也不维护第二份规则清单（改规则只改注册表一处）。
 *
 * 本模块只补充两类**指针**（不是判据）：
 * - 正/反例指针：扫描 `test/` 里以该规则 id 做断言的用例（文件 + 标题）；
 *   发布包不含 `test/` 时如实为空（不冒充有对照）。
 * - 相关命令：用法指针（check / prewrite / contracts，按层级补专项开关）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_RULES, ruleById } from './contracts.js';

/** 契约目录文档（判据全文的可读版；与注册表由生成器同步）。 */
export const EXPLAIN_DOC = 'docs/CONTRACTS.md';

/** `--json` 输出的**稳定键集**（未知 id 时同键、值为 null/空）。 */
export const EXPLAIN_KEYS = Object.freeze([
  'id', 'found', 'title', 'severity', 'layer', 'source', 'criteria',
  'examples', 'relatedCommands', 'doc',
]);

const NEGATIVE_HINTS = ['负对照', '反例', '违规', '判红', '拒绝', '拒', '撕裂', '缺口', '损坏', '截断', '坏', 'poison', 'corrupt', 'bad', 'gap', 'torn', 'missing', 'fail', '未知 id', 'unknown'];
const POSITIVE_HINTS = ['正对照', '正例', '合规', '判绿', '通过', '健康', 'good', 'green', 'complete', '绿'];

function classify(text) {
  const t = String(text);
  const neg = NEGATIVE_HINTS.some((k) => t.includes(k));
  const pos = POSITIVE_HINTS.some((k) => t.includes(k));
  if (neg && !pos) return 'negative';
  if (pos && !neg) return 'positive';
  return 'unclassified';
}

/**
 * 扫描 `test/` 找该规则 id 的对照用例指针（文件 + 最近的用例标题）。
 * 发布包/无 test 目录 ⇒ 空列表 + note（⛔ 不冒充"有对照"）。
 */
export function examplePointers(ruleId, { testDir } = {}) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dir = testDir ?? path.join(root, 'test');
  const out = { negative: [], positive: [], unclassified: [], note: null };
  if (!fs.existsSync(dir)) {
    out.note = '本安装不含 test/ 目录（发布包只含运行时代码与文档）——判据以规则注册表为准';
    return out;
  }
  const quoted = [`'${ruleId}'`, `"${ruleId}"`, `\`${ruleId}\``];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const file = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!quoted.some((q) => lines[i].includes(q))) continue;
      // 最近的 it/test/describe 标题（往上找，至多 60 行）——指针指向"哪条用例"。
      let title = '';
      for (let j = i; j >= 0 && j >= i - 60; j--) {
        const m = /(?:^|[^\w.])(?:it|test|describe)(?:\.\w+)*\(\s*[`'"]([^`'"]{4,120})/.exec(lines[j]);
        if (m) { title = m[1]; break; }
      }
      const bucket = classify(`${title} ${lines[i]}`);
      const pointer = `test/${name}${title ? ` › ${title}` : ''}`;
      if (!out[bucket].includes(pointer)) out[bucket].push(pointer);
    }
  }
  return out;
}

/** 相关命令（用法指针，按层级补专项开关）。 */
export function relatedCommandsOf(rule) {
  const cmds = [
    'dsh-log-contract check <session-log>            # 离线体检：逐条判定本规则',
    'dsh-log-contract prewrite <edit-file> --log <session-log>   # 写前校验（落盘前拦截）',
    `dsh-log-contract contracts                      # 全部规则目录（${CONTRACT_RULES.length} 条，含出处）`,
  ];
  if (rule?.layer === 'archive') {
    cmds.push('dsh-log-contract check <session-log> --archive-root DIR   # A1 维度需归档根才可判');
  }
  if (rule?.layer === 'migration') {
    cmds.push('dsh-log-contract check <session-log> --json     # migration 维度（G 段独立于 ok/verdict）');
  }
  return cmds;
}

/**
 * 解读一条规则。**数据只来自 `CONTRACT_RULES`**（单一权威）。
 *
 * @param {string} ruleId 规则 id（如 `E5`；大小写不敏感）。
 * @param {{testDir?: string}} [opts]
 * @returns {object} 与 `EXPLAIN_KEYS` 同键的稳定结构；未知 id ⇒ `found:false`
 *   且其余字段为 null/空数组（键集不变，便于机器判读）。
 */
export function explainRule(ruleId, opts = {}) {
  const raw = String(ruleId ?? '').trim();
  const rule = ruleById(raw) ?? CONTRACT_RULES.find((r) => r.id.toLowerCase() === raw.toLowerCase());
  const base = {
    id: rule?.id ?? raw,
    found: Boolean(rule),
    title: rule?.title ?? null,
    severity: rule?.severity ?? null,
    layer: rule?.layer ?? null,
    source: rule?.source ?? null,
    criteria: rule?.description ?? null,
    examples: { negative: [], positive: [], unclassified: [] },
    relatedCommands: [],
    doc: EXPLAIN_DOC,
  };
  if (!rule) {
    return {
      ...base,
      error: 'unknown-rule',
      knownCount: CONTRACT_RULES.length,
      hint: `未知规则 id "${raw}"——用 \`dsh-log-contract contracts\` 查看全部 ${CONTRACT_RULES.length} 条（或见 ${EXPLAIN_DOC}）`,
    };
  }
  base.examples = examplePointers(rule.id, opts);
  base.relatedCommands = relatedCommandsOf(rule);
  return base;
}
