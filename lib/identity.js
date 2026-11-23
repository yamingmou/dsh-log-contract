/**
 * lib/identity.js —— IDENTITY（版本同一性）契约：判据 −1「跑的东西是不是你以为的那个」
 *
 * 背景：`0.2.3-alpha.1` 全平台启动即死的真实故障 —— vendored 依赖源码更新了，但**版本号没换**
 * （npm 又不许重发同一版本）⇒ 消费方拿到的仍是旧构建，ESM 链接崩。官方只报
 * `released v2 row … has seq gap` 这类下游症状，指不出"病因在版本同一性"。
 *
 * 两条规则（家族 `version-identity`，与日志契约家族靠 `family` 区分）：
 *   ID1 一物一号：登记表里每个 `版本 → 内容摘要` 必须唯一；同一版本登记两个不同摘要 ⇒ 红。
 *   ID2 号可验：发布前摘要必须**从产物计算**并与声明版本绑定（声明↔登记不一致 ⇒ 红）；
 *       **防噪音**：只改文档/不改运行时代码/不动号 ⇒ 摘要不变 ⇒ 绿（不误报）。
 *       **硬反例**：同号改代码但登记摘要未更新/伪造 ⇒ 红。
 *
 * "产物"口径（明确定义，避免歧义）：**运行身份 = 运行时代码清单**（`lib/**\/*.js` + `bin/**\/*.mjs`），
 * 每个文件取 sha256，按相对路径排序后整体再 sha256。文档/测试/机制件**不承载运行身份**，
 * 改它们不改变摘要 —— 这就是"只改文档必须绿"的判据边界。
 *
 * ⛔ 本模块只产出**诊断**（identity 段），不参与 `check` 的 ok/退出码（不改既有判定）；
 * 登记表缺失（如 npm 安装包不含该文件）⇒ `ok: null`（unverifiable），不冒充通过、不误报红。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const IDENTITY_FAMILY = 'version-identity';

/** 登记表（版本 → 内容摘要）。位于 `docs/`（随仓入库；npm 只打包 `docs/**\/*.md` ⇒ 安装包不含本文件，故为 unverifiable）。 */
export const IDENTITY_REGISTRY = 'docs/identity-registry.json';

/** 运行身份口径：只含运行时代码（文档/测试/机制件不计入）。 */
export const RUNTIME_SOURCES = Object.freeze({ dirs: ['lib', 'bin'], extensions: ['.js', '.mjs'] });

export const IDENTITY_RULES = [
  {
    id: 'ID1',
    title: '一物一号：同一版本只能对应一个内容摘要',
    family: IDENTITY_FAMILY,
    layer: 'identity',
    severity: 'error',
    source: '0.2.3-alpha.1 全平台启动即死：vendored 源码更新但版本未换（npm 不许重发）⇒ 消费方拿到旧构建',
    description: '登记表（`docs/identity-registry.json`）里同一个版本出现**两个不同内容摘要** ⇒ 判红（证据带 file:line）。同一版本重复登记但摘要相同不算违规（不产生噪音）。',
  },
  {
    id: 'ID2',
    title: '号可验：摘要必须由产物计算并与声明版本绑定',
    family: IDENTITY_FAMILY,
    layer: 'identity',
    severity: 'error',
    source: '同上；判据：package.json 声明版本 ↔ 登记表登记的产物摘要 ↔ 由运行时代码实算的摘要，三者必须一致',
    description: '发布前从**产物**计算摘要（运行时代码清单 `lib/**/*.js` + `bin/**/*.mjs` 逐文件 sha256 → 排序后再 sha256）并与声明版本绑定：`package.json.version` 在登记表无条目、或登记摘要 ≠ 实算摘要 ⇒ 判红（证据带 file:line）；摘要**伪造**同样被实算拦下。**防噪音反例**：只改文档/测试/机制件（不改运行时代码）⇒ 摘要不变 ⇒ 绿；**硬反例**：同号改代码但登记未更新 ⇒ 红。',
  },
];

export const IDENTITY_RULE_BY_ID = Object.freeze(Object.fromEntries(IDENTITY_RULES.map((r) => [r.id, r])));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const toRel = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** 包根（本模块位于 `<root>/lib/identity.js`）。 */
export function packageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function walkRuntime(root) {
  const out = [];
  for (const dir of RUNTIME_SOURCES.dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const name of fs.readdirSync(cur)) {
        const full = path.join(cur, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (RUNTIME_SOURCES.extensions.includes(path.extname(name))) out.push(toRel(root, full));
      }
    }
  }
  return out.sort();
}

/**
 * 计算运行身份摘要（确定性：与目录遍历顺序无关，只依赖"路径 + 文件内容"）。
 *
 * @param {{root?: string}} [opts] `root` 缺省 = 本包根（测试可传临时夹具根）
 * @returns {{digest: string, algorithm: string, files: Array<{path: string, sha256: string}>}}
 */
export function computeRuntimeDigest({ root } = {}) {
  const base = root ?? packageRoot();
  const files = walkRuntime(base).map((rel) => ({ path: rel, sha256: sha256(fs.readFileSync(path.join(base, rel))) }));
  const manifest = files.map((f) => `${f.path}\u0000${f.sha256}`).join('\n');
  return { digest: `sha256:${sha256(Buffer.from(manifest, 'utf8'))}`, algorithm: 'sha256( sorted(path+sha256(file)) over lib/**/*.js + bin/**/*.mjs )', files };
}

/** 文件里第一次出现 `needle` 的行号（1-based；找不到 ⇒ null）。用于 file:line 证据。 */
export function lineOfOccurrence(file, needle) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes(needle));
    return idx >= 0 ? idx + 1 : null;
  } catch {
    return null;
  }
}

/**
 * 读登记表（缺文件/坏 JSON 不抛：分别记为 present:false / parseError）。
 * @param {{root?: string, registryPath?: string}} [opts]
 */
export function readIdentityRegistry({ root, registryPath } = {}) {
  const base = root ?? packageRoot();
  const rel = registryPath ?? IDENTITY_REGISTRY;
  const file = path.join(base, rel);
  if (!fs.existsSync(file)) return { present: false, file: rel, entries: [], parseError: null };
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { present: true, file: rel, entries: [], parseError: String(err?.message ?? err) };
  }
  const lines = text.split('\n');
  let cursor = 0;
  const entries = (Array.isArray(data.entries) ? data.entries : []).map((e) => {
    const marker = `"${String(e.version)}"`;
    let line = null;
    for (let i = cursor; i < lines.length; i++) {
      if (lines[i].includes(marker)) { line = i + 1; cursor = i + 1; break; }
    }
    return { version: e.version, digest: e.digest, line };
  });
  return { present: true, file: rel, entries, parseError: null };
}

const finding = (ruleId, { file, line = null, message, extra = {} }) => {
  const rule = IDENTITY_RULE_BY_ID[ruleId];
  const findingObj = { id: ruleId, rule: ruleId, family: IDENTITY_FAMILY, severity: rule?.severity ?? 'error', title: rule?.title ?? null, file, line, message };
  return Object.keys(extra).length > 0 ? { ...findingObj, extra } : findingObj;
};

/**
 * 版本同一性检查（IDENTITY 家族报告；⛔ 不进 check 的 ok/退出码）。
 *
 * @param {{root?: string, version?: string, registryPath?: string}} [opts]
 * @returns {{
 *   ok: boolean|null,                 // null = unverifiable（登记表缺失/损坏，不冒充通过）
 *   family: string, version: string|null,
 *   digest: string|null, algorithm: string,
 *   runtime: {files: number},
 *   registry: {file: string, present: boolean, entries: number},
 *   findings: Array<object>,
 *   summary: {byRule: object},
 *   note?: string,
 * }}
 */
export function checkIdentity({ root, version, registryPath } = {}) {
  const base = root ?? packageRoot();
  const pkgFile = path.join(base, 'package.json');
  const pkgText = fs.existsSync(pkgFile) ? fs.readFileSync(pkgFile, 'utf8') : null;
  let declared = version ?? null;
  if (declared === null && pkgText !== null) {
    try {
      declared = JSON.parse(pkgText).version ?? null;
    } catch {
      declared = null;
    }
  }
  const pkgVersionLine = pkgText !== null ? lineOfOccurrence(pkgFile, '"version"') : null;
  const pkgRel = 'package.json';
  const runtime = computeRuntimeDigest({ root: base });
  const registry = readIdentityRegistry({ root: base, registryPath });
  const baseReport = {
    ok: null,
    family: IDENTITY_FAMILY,
    version: declared,
    digest: runtime.digest,
    algorithm: runtime.algorithm,
    runtime: { files: runtime.files.length },
    registry: { file: registry.file, present: registry.present, entries: registry.entries.length },
    findings: [],
    summary: { byRule: {} },
  };

  if (!registry.present) {
    return { ...baseReport, note: `登记表缺失（${registry.file}）：本安装不含登记表（发布包只含运行时代码与 *.md 文档）——身份校验需在源码仓/发布流水线内运行（unverifiable，不冒充通过）` };
  }
  if (registry.parseError) {
    return {
      ...baseReport,
      findings: [finding('ID2', { file: registry.file, message: `登记表不是合法 JSON：${registry.parseError}` })],
      ok: false,
      summary: { byRule: { ID2: 1 } },
    };
  }

  const findings = [];
  // ── ID1 · 一物一号：同一版本出现两个不同摘要 ──────────────────────────
  const byVersion = new Map();
  for (const entry of registry.entries) {
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, []);
    byVersion.get(entry.version).push(entry);
  }
  for (const [v, entries] of byVersion) {
    const digests = [...new Set(entries.map((e) => e.digest))];
    if (digests.length <= 1) continue; // 重复但摘要相同：不产生噪音
    const first = entries[0];
    for (const entry of entries.slice(1)) {
      if (entry.digest === first.digest) continue;
      findings.push(finding('ID1', {
        file: registry.file,
        line: entry.line,
        message: `同一版本 ${v} 登记了两个不同内容摘要：${first.digest}（line ${first.line ?? '?'}）与 ${entry.digest}（line ${entry.line ?? '?'}）——一物多号/一物多内容（判红）`,
        extra: { version: v, digests },
      }));
    }
  }

  // ── ID2 · 号可验：声明版本 ↔ 登记摘要 ↔ 产物实算摘要 必须一致 ─────────────
  if (declared === null) {
    findings.push(finding('ID2', { file: pkgRel, line: pkgVersionLine, message: 'package.json 无法解析出版本号，无法与登记表绑定（声明↔登记不可验）' }));
  } else {
    const entries = registry.entries.filter((e) => e.version === declared);
    if (entries.length === 0) {
      findings.push(finding('ID2', {
        file: pkgRel,
        line: pkgVersionLine,
        message: `声明版本 ${declared} 在登记表中没有摘要条目——发布前须把由产物实算的摘要登记进去（实算 ${runtime.digest}）`,
        extra: { version: declared, computedDigest: runtime.digest },
      }));
    } else {
      const mismatched = entries.filter((e) => e.digest !== runtime.digest);
      if (mismatched.length > 0) {
        findings.push(finding('ID2', {
          file: registry.file,
          line: mismatched[0].line,
          message: `声明版本 ${declared} 的登记摘要 ≠ 产物实算摘要（同号改代码未换号/未更新登记/摘要伪造均命中）：登记 ${mismatched[0].digest}，实算 ${runtime.digest}（package.json:${pkgVersionLine ?? '?'}）`,
          extra: { version: declared, registeredDigest: mismatched[0].digest, computedDigest: runtime.digest },
        }));
      }
    }
  }

  const byRule = {};
  for (const f of findings) byRule[f.id] = (byRule[f.id] ?? 0) + 1;
  return { ...baseReport, ok: findings.length === 0, findings, summary: { byRule } };
}
