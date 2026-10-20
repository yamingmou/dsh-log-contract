/**
 * dsh-log-contract · lib/archive.js
 *
 * A1 —— 「在位可还原」只认结构化归档指针（0.3.19 · v4 契约补充最小集 ⑤）。
 *
 * 为什么单独成模块：这条判定需要读**归档文件**（外置内容的落盘副本），是文件系统维度，
 * 不属于 `checks.js` 的纯事件判定；且它是**独立维度**（与 `migration` 同款）：离线体检
 * 只有在调用方提供归档根目录时才能回答"在位可还原"，否则只能回答"不可判定"——
 * **不许**把"没查"冒充成"通过"。
 *
 * 口径（外部评审一手实测，[n]-10-20）：
 * - 只认**结构化字段**：`data.archiveRef` / `data.archive` /
 *   `data.externalized.archiveRef` / `data.externalized.archive`；
 *   校验元数据取同级 `archiveLine` / `sha[n]`。
 * - ⛔ **不得**从自由文本 grep 路径。实测两版文本口径全错：原版给 78.26%
 *   （正文模板/示例被算成引用）、改成"只认绝对路径"后 2.04%（正文里提到的真实路径示例
 *   又虚低）。本机 [n] 份真实会话：结构化指针 [n] 个，自由文本 `archive 第 N 行`
 *   出现在 [n] 个事件里——两种口径差近 20 倍，文本 grep 不可用。
 *
 * 判据：目标文件存在 + `archiveLine` 行存在 + `sha[n]`（若有）匹配 = 在位可还原；
 * 目标缺失/行缺失/sha 不符 = A1 error；绝对路径失效但同名归档在归档根可解析 = relocated
 * warning（re-home 未回写：内容可找回，但**不在位**）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { violation } from './checks.js';
import { decompressZstd } from './log-reader.js';

const ZSTD_MAGIC = 0xfd2fb[n];

/** 结构化指针字段（只认这些；`content`/`pointer`/散文一律不碰）。 */
export const ARCHIVE_POINTER_FIELDS = Object.freeze(['archiveRef', 'archive']);

/** `data.externalized` 下认的键（等价指针字段）。 */
export const EXTERNALIZED_POINTER_FIELDS = Object.freeze(['archiveRef', 'archive']);

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushPointer(out, event, lineNo, field, ref, line, sha) {
  if (typeof ref !== 'string' || ref === '') return;
  out.push({
    seq: Number.isSafeInteger(event.seq) ? event.seq : null,
    lineNo: typeof lineNo === 'number' ? lineNo : null,
    type: typeof event.type === 'string' ? event.type : null,
    field,
    ref,
    archiveLine: Number.isSafeInteger(line) ? line : null,
    sha[n]: typeof sha === 'string' && sha !== '' ? sha : null,
  });
}

/**
 * 从事件流提取**结构化**归档指针（纯函数，不读盘）。
 *
 * 入参既接受 `{event, lineNo}` 包装（`loadSessionLog().events` 的形状），也接受裸事件对象
 * （手搓用例/第三方直接传事件数组）。
 *
 * @param {Array<{event:object,lineNo?:number}|object>} events
 * @returns {Array<{seq:number|null,lineNo:number|null,type:string|null,field:string,ref:string,archiveLine:number|null,sha[n]:string|null}>}
 */
export function collectArchivePointers(events) {
  const out = [];
  for (const item of events ?? []) {
    const event = item && typeof item === 'object' && Object.hasOwn(item, 'event') ? item.event : item;
    const lineNo = item && typeof item === 'object' ? item.lineNo : undefined;
    if (!event || typeof event !== 'object') continue;
    const data = event.data;
    if (!isPlainRecord(data)) continue;
    for (const field of ARCHIVE_POINTER_FIELDS) {
      if (data[field] === undefined) continue;
      pushPointer(out, event, lineNo, `data.${field}`, data[field], data.archiveLine, data.sha[n] ?? data.archiveSha[n]);
    }
    const ext = data.externalized;
    if (isPlainRecord(ext)) {
      for (const field of EXTERNALIZED_POINTER_FIELDS) {
        if (ext[field] === undefined) continue;
        pushPointer(out, event, lineNo, `data.externalized.${field}`, ext[field], ext.archiveLine, ext.sha[n] ?? ext.archiveSha[n]);
      }
    }
  }
  return out;
}

/** 归档引用 basename（用于在归档根里解析；不改变"在位"判据，只用于 relocated 判定）。 */
export function archiveBasename(ref) {
  return typeof ref === 'string' ? path.basename(ref) : '';
}

/** 把指针的声明目标解析为文件路径：绝对路径优先；相对/basename 走归档根。 */
function findArchiveFile(pointer, { archiveRoots = [], index } = {}) {
  const stated = typeof pointer.ref === 'string' && path.isAbsolute(pointer.ref) ? pointer.ref : null;
  if (stated && fs.existsSync(stated)) return { target: stated, statedPath: stated, relocated: false };
  const base = archiveBasename(pointer.ref);
  if (!base) return { target: null, statedPath: stated, relocated: false };
  let found = index?.get(base) ?? null;
  if (!found) {
    for (const root of archiveRoots) {
      const hit = searchByBasename(root, base, 0, index);
      if (hit) { found = hit; break; }
    }
  }
  if (found) return { target: found, statedPath: stated, relocated: stated !== null && stated !== found };
  return { target: null, statedPath: stated, relocated: false };
}

/** 在归档根下按 basename 找文件（深度 ≤3；找到即缓存）。 */
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

/**
 * 读归档文件的**行索引**（只保留请求的行；巨型归档不能整体 `toString`：
 * >[n]MiB 明文会触发 V8 字符串上限——那是器具限制，不是内容缺失，必须避免把它误报成 A1）。
 *
 * @param {string} file 归档路径（.jsonl.zst 走多帧解压；.jsonl 直接 utf8）
 * @param {Set<number>} [wantedLines] 需要的 1-based 行号
 * @returns {{count:number, lineAt:(n:number)=>string}}
 */
export function readArchiveIndex(file, wantedLines = new Set()) {
  const buf = fs.readFileSync(file);
  const isZstd = buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC;
  const plain = isZstd ? decompressZstd(buf) : buf;
  const lines = new Map();
  let count = 0;
  let start = 0;
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] !== 0x0a) continue;
    count++;
    if (wantedLines.has(count)) lines.set(count, plain.subarray(start, i).toString('utf8'));
    start = i + 1;
  }
  if (start < plain.length) {
    count++;
    if (wantedLines.has(count)) lines.set(count, plain.subarray(start).toString('utf8'));
  }
  return { count, lineAt: (n) => lines.get(n) ?? '' };
}

/** 读归档文件为明文行数组（.jsonl.zst 走多帧解压；.jsonl 直接 utf8）。 */
export function readArchiveLines(file) {
  const buf = fs.readFileSync(file);
  const isZstd = buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC;
  const text = isZstd ? decompressZstd(buf).toString('utf8') : buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** sha[n]（十六进制）；匹配时允许 16 位前缀（深 H2 以 line16 为准，sha[n] 作对照）。 */
function sha[n]Hex(text) {
  return crypto.createHash('sha[n]').update(text).digest('hex');
}

function shaMatches(line, want) {
  if (typeof want !== 'string' || want.length < 16) return true; // 无/过短指纹 ⇒ 不做深校验（不猜）
  const got = sha[n]Hex(line);
  const w = want.toLowerCase();
  if (w.length >= 64) return got === w.slice(0, 64);
  return got.startsWith(w) || w.startsWith(got.slice(0, w.length));
}

/**
 * 校验收到的结构化指针能否在位还原。
 *
 * @param {Array} pointers `collectArchivePointers()` 的结果
 * @param {{archiveRoots?:string[], readLines?:Function}} [opts]
 * @returns {{
 *   assessable: boolean,
 *   pointers: number, restorable: number, relocated: number, missing: number, unresolved: number,
 *   lineMissing: number, shaMismatch: number, restoredBytes: number,
 *   restorableRate: number, verdict: 'restorable'|'unrestorable'|'unverifiable',
 *   violations: Array, details: object,
 * }}
 */
export function verifyArchivePointers(pointers, { archiveRoots = [], readLines } = {}) {
  const roots = Array.isArray(archiveRoots) ? archiveRoots.filter((r) => typeof r === 'string' && r !== '') : [];
  const assessable = roots.length > 0;
  const result = {
    assessable,
    pointers: pointers.length,
    effectivePointers: 0,
    restorable: 0,
    relocated: 0,
    missing: 0,
    unresolved: 0,
    lineMissing: 0,
    shaMismatch: 0,
    duplicated: 0,
    restoredBytes: 0,
    restorableRate: 0,
    verdict: assessable ? 'restorable' : 'unverifiable',
    violations: [],
    details: { missing: [], relocated: [], unresolved: [], lineMissing: [], shaMismatch: [] },
  };
  if (!assessable) {
    // 不可判定：没有归档根 ⇒ 不冒充通过、也不产生违规（独立维度）。
    return result;
  }
  // ① 解析目标 + 按 (target, line) 去重：同一记录常同时带 `archiveRef`(basename) 与
  //   `archive`(绝对路径) 两个结构化指针，指向同一目标同一行——它们是**一条记录**，不能
  //   算两次（否则"可还原率"会被双字段写法放大/缩小）。
  const index = new Map();
  const unique = [];
  const seen = new Set();
  for (const pointer of pointers) {
    const { target, relocated } = findArchiveFile(pointer, { archiveRoots: roots, index });
    if (!target) {
      result.unresolved++;
      if (result.details.unresolved.length < 20) result.details.unresolved.push({ seq: pointer.seq, field: pointer.field, ref: pointer.ref });
      continue;
    }
    const dedupeKey = `${target}\u[n]${pointer.archiveLine ?? ''}`;
    if (seen.has(dedupeKey)) { result.duplicated++; continue; }
    seen.add(dedupeKey);
    unique.push({ pointer, target, relocated });
  }
  result.effectivePointers = unique.length;
  // ② 按目标分组，一次扫描取回需要的行（巨型归档不能整体 toString：
  //    >[n]MiB 明文会触发 V8 字符串上限，那是器具限制、不是内容缺失）。
  const byTarget = new Map();
  for (const item of unique) {
    if (!byTarget.has(item.target)) byTarget.set(item.target, []);
    byTarget.get(item.target).push(item);
  }
  for (const [target, items] of byTarget) {
    const wanted = new Set(items.map(({ pointer }) => pointer.archiveLine).filter((n) => Number.isSafeInteger(n) && n >= 1));
    let archiveIndex;
    try {
      archiveIndex = (readLines ?? readArchiveIndex)(target, wanted);
      if (Array.isArray(archiveIndex)) archiveIndex = { count: archiveIndex.length, lineAt: (n) => archiveIndex[n - 1] ?? '' };
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, [n]);
      for (const { pointer } of items) {
        result.missing++;
        if (result.details.missing.length < 20) result.details.missing.push({ seq: pointer.seq, field: pointer.field, ref: pointer.ref, target, reason: message });
        result.violations.push(violation('A1', { seq: pointer.seq, lineNo: pointer.lineNo, eventType: pointer.type }, `归档不可读：${pointer.field} → ${pointer.ref}（解析到 ${target}）——在位可还原判定失败（${message}）`));
      }
      continue;
    }
    for (const { pointer, relocated } of items) {
      const loc = { seq: pointer.seq, lineNo: pointer.lineNo, eventType: pointer.type };
      const lineNo = pointer.archiveLine;
      if (!Number.isSafeInteger(lineNo) || lineNo < 1 || lineNo > archiveIndex.count) {
        result.lineMissing++;
        if (result.details.lineMissing.length < 20) result.details.lineMissing.push({ seq: pointer.seq, field: pointer.field, ref: pointer.ref, target, archiveLine: lineNo, lines: archiveIndex.count });
        result.violations.push(violation('A1', loc, `归档行缺失：${pointer.field} → ${pointer.ref} 指向第 ${String(lineNo)} 行，但归档只有 ${archiveIndex.count} 行——内容不可在位还原（模板/示例文本不参与本判据）`));
        continue;
      }
      const line = archiveIndex.lineAt(lineNo);
      if (!shaMatches(line, pointer.sha[n])) {
        result.shaMismatch++;
        if (result.details.shaMismatch.length < 20) result.details.shaMismatch.push({ seq: pointer.seq, field: pointer.field, ref: pointer.ref, target, archiveLine: lineNo, want: pointer.sha[n]?.slice(0, 16), got: sha[n]Hex(line).slice(0, 16) });
        result.violations.push(violation('A1', loc, `归档内容指纹不符：${pointer.field} → ${pointer.ref} 第 ${lineNo} 行 sha[n] 期望 ${pointer.sha[n]?.slice(0, 16)}…，实际 ${sha[n]Hex(line).slice(0, 16)}…——归档已漂移，不可在位还原`));
        continue;
      }
      if (relocated) {
        result.relocated++;
        const v = violation('A1', loc, `归档指针的绝对路径已失效（${pointer.ref}），但同名归档在归档根可解析（${target}）——内容可找回，但**不在位**（re-home 未回写）；按 relocated 记 warning`);
        v.severity = 'warning';
        result.violations.push(v);
        if (result.details.relocated.length < 20) result.details.relocated.push({ seq: pointer.seq, field: pointer.field, ref: pointer.ref, target });
      } else {
        result.restorable++;
        result.restoredBytes += Buffer.byteLength(line, 'utf8');
      }
    }
  }
  result.restorableRate = result.effectivePointers > 0 ? result.restorable / result.effectivePointers : 1;
  result.verdict = result.missing === 0 && result.lineMissing === 0 && result.shaMismatch === 0 && result.unresolved === 0
    ? 'restorable'
    : 'unrestorable';
  return result;
}

/**
 * A1 一站式：事件流 → 结构化指针 → 在位可还原结论。
 * @param {Array<{event:object,lineNo?:number}>} events
 * @param {{archiveRoots?:string[]}} [opts]
 */
export function archiveVerdict(events, { archiveRoots = [], readLines } = {}) {
  const pointers = collectArchivePointers(events);
  return verifyArchivePointers(pointers, { archiveRoots, readLines });
}
