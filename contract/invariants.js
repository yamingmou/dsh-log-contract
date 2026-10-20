/**
 * contract/invariants.js
 *
 * 平台无关的不变量目录 + 判定原语。
 *
 * 「不变量」= 与具体运行时无关、必须始终成立的性质。适配器负责把平台记录
 * **规范化**成这里的输入形状，再交给这些判定；契约层不反向依赖任何适配器。
 *
 * 判定输入是**规范化记录视图**（不绑定任何平台的字段命名习惯）：
 *
 *   record  = { seq, lineNo?, eventType?, ... }        一条逻辑记录（序号 + 定位）
 *   row     = { lineNo, value, error }                 一条物理存储行（解析结果或解析错误）
 *   pointer = { ref, line, digest, meta }              一条外置内容指针（目标 + 行 + 不透明指纹 + 原样元数据）
 *
 * 平台适配器负责把原始记录翻译成上述视图；本文件只判断不变量是否成立，
 * 并构造与注册表一致的**中立**判定记录（severity/layer 按 kind 解析，平台 id 由适配器映射）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { violation } from './verdict.js';

/**
 * 不变量标识目录。每个标识对应一类跨平台成立的性质；
 * 具体协议/格式相关的判定由 adapters/<platform>/ 提供。
 */
export const INVARIANTS = Object.freeze({
  // 记录与存储
  RECORD_PARSABLE: 'record.parsable',
  RECORD_HEAD_DECLARED: 'record.head-declared',
  ENVELOPE_CLOSED: 'envelope.closed',
  VALUE_JSON_LOSSLESS: 'value.json-lossless',
  EMPTY_CONTAINER_EXPLICIT: 'container.empty-explicit',
  // 序号与写入者
  SEQ_PRESENT: 'seq.present',
  SEQ_CONTIGUOUS: 'seq.contiguous',
  SEQ_MONOTONIC: 'seq.monotonic',
  SINGLE_WRITER: 'seq.single-writer',
  // 种类与引用
  TYPE_KNOWN_OR_DECLARED: 'type.known-or-declared',
  REFERENCE_CLOSURE: 'reference.closure',
  REFERENCE_SAME_SCOPE: 'reference.same-scope',
  PAIRING_COMPLETE: 'pairing.complete',
  // 视图推导与改写
  VIEW_REPLAYABLE: 'view.replayable',
  VIEW_KEY_UNIQUE: 'view.key-unique',
  VIEW_SCOPE_ATTRIBUTABLE: 'view.scope-attributable',
  REWRITE_NODE_BOUNDED: 'rewrite.node-bounded',
  REWRITE_COVERAGE_COMPLETE: 'rewrite.coverage-complete',
  REWRITE_CONTENT_ONLY: 'rewrite.content-only',
  DERIVED_SCOPE_MATCH: 'derived.scope-match',
  // 帧与容器
  FRAME_DECODABLE: 'frame.decodable',
  FRAME_TAIL_INTACT: 'frame.tail-intact',
  FRAME_FIRST_RECORD_ALONE: 'frame.first-record-alone',
  FRAME_LAYOUT_PRESERVED: 'frame.layout-preserved',
  // 版本迁移
  MIGRATION_KNOWN_TYPES: 'migration.known-types',
  MIGRATION_REFERENCE_SOUND: 'migration.reference-sound',
  MIGRATION_DECLARED_SKIP: 'migration.declared-skip',
  // 外置内容
  RESTORABLE: 'content.restorable',
});

/**
 * 不变量实现状态（机读；未实现的标识由 `contract/registry.js` 暴露 `implemented: false`）。
 *
 * key = `INVARIANTS` 的取值；value = 该不变量在本契约层的实现函数名。
 * 只有列在这里的不变量才有平台无关实现；其余标识是**声明/映射用**标签，
 * 具体判定由适配器提供（或尚未实现），不得假装它们已被执行。
 */
export const INVARIANT_IMPLEMENTATIONS = Object.freeze({
  [INVARIANTS.RECORD_PARSABLE]: 'recordParsabilityViolations',
  [INVARIANTS.RECORD_HEAD_DECLARED]: 'recordHeadViolations',
  [INVARIANTS.VALUE_JSON_LOSSLESS]: 'payloadLosslessViolations',
  [INVARIANTS.EMPTY_CONTAINER_EXPLICIT]: 'emptyContainerViolation',
  [INVARIANTS.SEQ_PRESENT]: 'ordinalViolations',
  [INVARIANTS.SEQ_CONTIGUOUS]: 'sequenceContinuityViolations',
  [INVARIANTS.SEQ_MONOTONIC]: 'physicalOrderViolations',
  [INVARIANTS.SINGLE_WRITER]: 'singleWriterDiagnostic',
  [INVARIANTS.RESTORABLE]: 'verifyExternalizedPointers',
});

/**
 * 不变量实现状态（机读）：每个不变量标识 → `{ implemented, implementation }`。
 *
 * `implemented: true`  ⇒ 契约层有平台无关实现函数（统一返回 `{ violations, ... }`）；
 * `implemented: false` ⇒ 只是声明/映射用标签，具体判定由适配器提供（或尚未实现）。
 * 由 `INVARIANT_IMPLEMENTATIONS` 派生，不靠人工维护两份清单。
 */
export const INVARIANT_REGISTRY = Object.freeze(Object.fromEntries(
  Object.values(INVARIANTS).map((kind) => [kind, Object.freeze({
    implemented: Object.hasOwn(INVARIANT_IMPLEMENTATIONS, kind),
    implementation: INVARIANT_IMPLEMENTATIONS[kind] ?? null,
  })]),
));

/** 单个不变量的实现状态；未知标识 ⇒ null。 */
export function invariantStatus(kind) {
  return INVARIANT_REGISTRY[kind] ?? null;
}

// ── 通用原语 ────────────────────────────────────────────────────────────────

/** 非负安全整数。 */
export function isSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 普通记录（对象、非 null、非数组）。 */
export function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

//#region lossless-JSON 判定（拒绝稀疏数组、非有限数、-0、循环引用、非普通原型、symbol/不可枚举键）
/** 原型是否为本 realm 的普通对象原型（跨 realm 也认）。 */
function isIntrinsicObjectPrototype(prototype) {
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** 对象是否来自普通/空原型（任意 realm）。 */
function hasPlainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype));
}

/** 数组是否为普通数组（拒绝子类/异形）。 */
function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Array.prototype) return true;
  return typeof prototype === 'object' && prototype !== null && Object.getPrototypeOf(prototype) === Object.prototype && Object.getPrototypeOf(Object.getPrototypeOf(prototype)) === null;
}

/** 取所有 JSON 可见键；含 JSON 会丢弃的键 ⇒ 拒绝。 */
function enumerableStringKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined;
  return keys;
}

/**
 * 判断值是否可无损 JSON 序列化（迭代实现，避免深递归栈溢出）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isJsonValue(value) {
  const ancestors = new Set();
  const tasks = [{ kind: 'visit', value }];
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source);
      continue;
    }
    if (task.kind === 'array-item') {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return false;
      tasks.push({ kind: 'visit', value: task.source[task.index] });
      continue;
    }
    if (task.kind === 'object-property') {
      tasks.push({ kind: 'visit', value: task.source[task.key] });
      continue;
    }
    const current = task.value;
    if (current === null) continue;
    if (typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (ancestors.has(current)) return false;
    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return false;
      const length = current.length;
      if (Reflect.ownKeys(current).length !== length + 1) return false;
      ancestors.add(current);
      tasks.push({ kind: 'leave', source: current });
      for (let index = length - 1; index >= 0; index--) tasks.push({ kind: 'array-item', source: current, index });
      continue;
    }
    if (!hasPlainObjectPrototype(current)) return false;
    const keys = enumerableStringKeys(current);
    if (keys === undefined) return false;
    ancestors.add(current);
    tasks.push({ kind: 'leave', source: current });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === undefined) return false;
      tasks.push({ kind: 'object-property', source: current, key });
    }
  }
  return true;
}
//#endregion

// ── 记录 / 容器不变量 ──────────────────────────────────────────────────────

/**
 * 记录头（容器的首条记录）。
 *
 * @param {object|null} head 首条记录的解析结果（解析失败为 null）
 * @param {number} lineNo 首条记录的物理行号
 * @param {{expectedFamily?: string, familyField?: string}} [opts]
 *   `expectedFamily`：该容器要求的记录族取值；`familyField`：声明记录族的字段名。
 * @returns {{violations: Array<object>}} H1 判定（记录头不可解析 / 未声明期望的记录族）
 */
export function recordHeadViolations(head, lineNo, { expectedFamily, familyField = 'type' } = {}) {
  if (head === null) {
    return { violations: [violation('record.head', { lineNo }, '首行不是合法 JSON —— 整个会话不可读')] };
  }
  if (expectedFamily !== undefined && head?.[familyField] !== expectedFamily) {
    return { violations: [violation('record.head', { lineNo }, `首行 ${familyField} 必须为 "${expectedFamily}"（实际 ${String(head?.[familyField])}）`)] };
  }
  return { violations: [] };
}

/**
 * 物理存储行可解析性：非空行必须能解析成 JSON（解析失败且无值 = 损坏行）。
 * @param {Array<{lineNo:number, value:unknown, error:Error|null}>} rows
 * @returns {{violations: Array<object>}} R1 判定
 */
export function recordParsabilityViolations(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!row?.error || row.value !== null) continue;
    out.push(violation('record.parsable', { lineNo: row.lineNo }, '该行不是合法 JSON（损坏行）'));
  }
  return { violations: out };
}

/**
 * 有头无记录 = 异常空容器（显式报出，不静默通过）。
 * @param {boolean} hasHead
 * @param {number} recordCount
 * @param {number} lineNo
 * @returns {{violations: Array<object>}} Z3 判定
 */
export function emptyContainerViolation(hasHead, recordCount, lineNo) {
  if (!hasHead || recordCount !== 0) return { violations: [] };
  return { violations: [violation('container.empty-explicit', { lineNo }, '会话文件无任何事件（仅 header）——异常空会话（新建即空或写入未落盘）；空态不在任何有内容规则的覆盖下，显式报出供人判断')] };
}

// ── 序号 / 写入者不变量 ────────────────────────────────────────────────────

/**
 * 每条逻辑记录必须携带非负安全整数序号。
 * @param {Array<{seq:unknown, lineNo?:number, eventType?:string}>} records 规范化记录视图
 * @returns {{violations: Array<object>}} E1 判定
 */
export function ordinalViolations(records) {
  const out = [];
  for (const record of records ?? []) {
    if (isSafeInt(record?.seq)) continue;
    out.push(violation('seq.present', { seq: null, lineNo: record?.lineNo ?? null, eventType: record?.eventType ?? null }, `事件 seq 缺失或非法（${String(record?.seq)}），必须为非负安全整数`));
  }
  return { violations: out };
}

/**
 * 单写入者假设：序号从落点起严格连续（相等步长 1）。
 *
 * @param {Array<{seq:unknown, lineNo?:number, eventType?:string}>} records 按逻辑顺序排列的记录
 * @param {{baseSeq?: number}} [opts]
 * @returns {{violations: Array<object>, broken: boolean}} E2 判定 + 是否出现缺口/倒退
 */
export function sequenceContinuityViolations(records, { baseSeq = 0 } = {}) {
  const violations = [];
  let broken = false;
  let expected = baseSeq;
  for (const record of records ?? []) {
    const seq = record?.seq;
    if (!isSafeInt(seq)) continue; // 缺失/非法序号由序号存在性不变量负责
    if (seq !== expected) {
      const kind = seq < expected ? '倒退（backward）' : '缺口（gap）';
      violations.push(violation('seq.contiguous', { seq, lineNo: record.lineNo ?? null, eventType: record.eventType ?? null }, `seq ${seq} 不连续：${kind}，期望 ${expected} —— 违反单写入者假设`));
      broken = true;
    }
    expected = seq + 1;
  }
  return { violations, broken };
}

/**
 * 物理顺序与逻辑序号一致：按**物理顺序**逐条比较，出现倒退即多写入者/回放交织特征。
 *
 * @param {Array<{seq:unknown, lineNo?:number, eventType?:string}>} entries 按物理顺序展开后的记录
 * @returns {{violations: Array<object>}} S9 判定（首个倒退即报，后续乱序皆源于此）
 */
export function physicalOrderViolations(entries) {
  const out = [];
  let prevSeq = -1;
  let prevLineNo = null;
  for (const entry of entries ?? []) {
    const seq = entry?.seq;
    if (!isSafeInt(seq)) continue; // 序号非法由序号存在性不变量负责
    if (seq < prevSeq) {
      out.push(violation('seq.monotonic', { seq, lineNo: entry.lineNo ?? null, eventType: entry.eventType ?? null },
        `文件物理序 seq 倒退：${prevSeq}（line ${prevLineNo}）→ ${seq}（line ${entry.lineNo ?? null}）——非单调 = 多写入者/旧光标回放交织（单进程 append 不可能写出），会话加载会被拒`));
      return { violations: out };
    }
    prevSeq = seq;
    prevLineNo = entry.lineNo ?? null;
  }
  return { violations: out };
}

/**
 * 并发诊断：序号破坏出现时给出解释性告警（不替代 E2/S9，只解释原因）。
 * @param {boolean} broken 是否出现序号缺口/倒退
 * @param {string} message 人读说明
 * @returns {{violations: Array<object>}} C1 判定
 */
export function singleWriterDiagnostic(broken, message) {
  if (!broken) return { violations: [] };
  return { violations: [violation('seq.single-writer', { lineNo: null }, message)] };
}

// ── 负载不变量 ─────────────────────────────────────────────────────────────

/**
 * 记录负载必须可无损 JSON 序列化。
 *
 * @param {object} record 规范化记录（原始记录对象）
 * @param {{lineNo?:number, seq?:number, eventType?:string}} loc 定位
 * @param {{required?: string[], optional?: string[]}} [fields]
 *   `required`：无论是否存在都必须判定的负载字段；`optional`：存在时才判定。
 * @returns {{violations: Array<object>}} E4 判定
 */
export function payloadLosslessViolations(record, loc, { required = [], optional = [] } = {}) {
  const out = [];
  for (const field of required) {
    if (isJsonValue(record?.[field])) continue;
    out.push(violation('value.json-lossless', loc, `${field} 不是 lossless-JSON（函数/循环引用/非有限数等），写入热路径会拒绝`));
  }
  for (const field of optional) {
    if (record?.[field] === undefined || isJsonValue(record[field])) continue;
    out.push(violation('value.json-lossless', loc, `${field} 不是 lossless-JSON`));
  }
  return { violations: out };
}

// ── 外置内容不变量（在位可还原）─────────────────────────────────────────────
//
// **通用接口**：接受适配器提供的指针描述符，只判定与平台无关的性质——
// 「目标可解析 / 行存在 / 指纹匹配 / 按记录去重 / 结论聚合 / 全损分类」。
// 描述符字段（由适配器定义并负责解释）：
//   { ref, line, digest, meta }
//     ref    目标定位（绝对路径或可被 basename 解析的引用，语义由适配器决定）
//     line   目标内的行号（1-based；多少制由适配器决定，契约层只比较与读取）
//     digest 不透明指纹（完整性校验交给适配器注入的 matchesIntegrity）
//     meta   原始指针元数据（契约层原样带回问题清单，不解释其字段）
//
// 指纹算法、文件名解析、压缩容器读取、字段命名全部留在适配器。

/** 读明文行索引（无平台容器格式时的兜底读法；适配器可注入自己的读取器）。 */
function readPlainLineIndex(file, wantedLines = new Set()) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { count: lines.length, lineAt: (n) => lines[n - 1] ?? '' };
}

/** 把声明目标解析为文件路径：绝对路径优先；相对/basename 走提供的根目录。 */
function findExternalizedFile(pointer, { roots = [], index } = {}) {
  const stated = typeof pointer.ref === 'string' && path.isAbsolute(pointer.ref) ? pointer.ref : null;
  if (stated && fs.existsSync(stated)) return { target: stated, statedPath: stated, relocated: false };
  const base = typeof pointer.ref === 'string' ? path.basename(pointer.ref) : '';
  if (!base) return { target: null, statedPath: stated, relocated: false };
  let found = index?.get(base) ?? null;
  if (!found) {
    for (const root of roots) {
      const hit = searchByBasename(root, base, 0, index);
      if (hit) { found = hit; break; }
    }
  }
  if (!found) return { target: null, statedPath: stated, relocated: false };
  return { target: found, statedPath: stated, relocated: stated !== null && stated !== found };
}

/** 在根目录下按 basename 找文件（深度 ≤3；找到即缓存）。 */
function searchByBasename(dir, base, depth, index) {
  if (depth > 3 || !fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const hit = searchByBasename(full, base, depth + 1, index);
      if (hit) { index?.set(base, hit); return hit; }
    } else if (name === base) {
      index?.set(base, full);
      return full;
    }
  }
  return null;
}

const RESTORABLE_ISSUE_MESSAGES = Object.freeze({
  unreadable: '外置内容不可读：目标无法读取',
  'line-missing': '外置内容行缺失：指针行超出目标行数',
  'digest-mismatch': '外置内容指纹不符：内容已漂移',
  relocated: '外置内容指针失效但可重定位（不在位）',
});

/**
 * 校验外置内容指针能否在位还原（通用接口）。
 *
 * 判据：目标可解析 + 行存在 + 指纹匹配 = 在位可还原；目标缺失/行缺失/指纹不符 = error；
 * 绝对路径失效但同名目标在提供的根目录可解析 = relocated（可找回但不在位）。
 * 同一（目标, 行）被多个指针引用时按一条记录计（去重）。
 *
 * @param {Array<{ref:string, line:number|null, digest:string|null, meta:object}>} pointers
 *   适配器规范化后的指针描述符（`meta` 为原始指针，契约层原样带回问题清单）
 * @param {{roots?: string[], readLines?: Function, matchesIntegrity?: Function}} [opts]
 *   `readLines(file, wanted): {count, lineAt}` 或行数组；
 *   `matchesIntegrity(line, digest): boolean | {ok:boolean, got?:string}` 返回指纹校验结果
 * @returns {object} 结论（verdict + 逐项读数 + `issues` 问题清单 + 中立 `violations`）
 */
export function verifyExternalizedPointers(pointers, { roots = [], readLines, matchesIntegrity } = {}) {
  const rootsList = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r !== '') : [];
  const assessable = rootsList.length > 0;
  const integrityOf = typeof matchesIntegrity === 'function' ? matchesIntegrity : () => true;
  const result = {
    assessable,
    pointers: pointers.length,
    effectivePointers: 0,
    restorable: 0,
    relocated: 0,
    missing: 0,
    unresolved: 0,
    lineMissing: 0,
    digestMismatch: 0,
    duplicated: 0,
    restoredBytes: 0,
    restorableRate: 0,
    verdict: assessable ? 'restorable' : 'unverifiable',
    violations: [],
    issues: [],
  };
  if (!assessable) return result; // 不可判定：不冒充通过、也不产生判定
  const locOf = (pointer) => ({ seq: pointer.meta?.seq ?? null, lineNo: pointer.meta?.lineNo ?? null, eventType: pointer.meta?.type ?? null });
  const pushIssue = (type, fields) => {
    const issue = { type, ...fields };
    result.issues.push(issue);
    if (RESTORABLE_ISSUE_MESSAGES[type] !== undefined) {
      const v = violation('content.restorable', locOf(issue.pointer), RESTORABLE_ISSUE_MESSAGES[type], { issue });
      if (type === 'relocated') v.severity = 'warning';
      result.violations.push(v);
    }
    return issue;
  };
  // ① 解析目标 + 按 (target, line) 去重
  const index = new Map();
  const unique = [];
  const seen = new Set();
  for (const pointer of pointers) {
    const { target, relocated } = findExternalizedFile(pointer, { roots: rootsList, index });
    if (!target) {
      result.unresolved++;
      pushIssue('unresolved', { pointer, target: null, ref: pointer.ref });
      continue;
    }
    const dedupeKey = `${target}\u[n]${pointer.line ?? ''}`;
    if (seen.has(dedupeKey)) { result.duplicated++; continue; }
    seen.add(dedupeKey);
    unique.push({ pointer, target, relocated });
  }
  result.effectivePointers = unique.length;
  // ② 按目标分组，一次扫描取回需要的行
  const byTarget = new Map();
  for (const item of unique) {
    if (!byTarget.has(item.target)) byTarget.set(item.target, []);
    byTarget.get(item.target).push(item);
  }
  for (const [target, items] of byTarget) {
    const wanted = new Set(items.map(({ pointer }) => pointer.line).filter((n) => Number.isSafeInteger(n) && n >= 1));
    let lineIndex;
    try {
      lineIndex = (readLines ?? readPlainLineIndex)(target, wanted);
      if (Array.isArray(lineIndex)) lineIndex = { count: lineIndex.length, lineAt: (n) => lineIndex[n - 1] ?? '' };
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, [n]);
      for (const { pointer } of items) {
        result.missing++;
        pushIssue('unreadable', { pointer, target, reason });
      }
      continue;
    }
    for (const { pointer, relocated } of items) {
      const lineNo = pointer.line;
      if (!Number.isSafeInteger(lineNo) || lineNo < 1 || lineNo > lineIndex.count) {
        result.lineMissing++;
        pushIssue('line-missing', { pointer, target, lineNo, lineCount: lineIndex.count });
        continue;
      }
      const line = lineIndex.lineAt(lineNo);
      const verdict = integrityOf(line, pointer.digest);
      const ok = typeof verdict === 'object' && verdict !== null ? verdict.ok === true : Boolean(verdict);
      const got = typeof verdict === 'object' && verdict !== null && typeof verdict.got === 'string' ? verdict.got : null;
      if (!ok) {
        result.digestMismatch++;
        pushIssue('digest-mismatch', { pointer, target, lineNo, want: pointer.digest, got });
        continue;
      }
      if (relocated) {
        result.relocated++;
        pushIssue('relocated', { pointer, target });
        continue;
      }
      result.restorable++;
      result.restoredBytes += Buffer.byteLength(line, 'utf8');
    }
  }
  result.restorableRate = result.effectivePointers > 0 ? result.restorable / result.effectivePointers : 1;
  result.verdict = result.missing === 0 && result.lineMissing === 0 && result.digestMismatch === 0 && result.unresolved === 0
    ? 'restorable'
    : 'unrestorable';
  return result;
}
