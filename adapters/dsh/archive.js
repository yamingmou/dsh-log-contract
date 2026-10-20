/**
 * dsh-log-contract · adapters/dsh/archive.js
 *
 * DSH 专属：外置内容（归档）指针的读取与归档文件读取。
 *
 * 「在位可还原」的**判定核心**是平台无关的（目标存在 + 行存在 + 指纹匹配），
 * 在 contract/invariants.js 的 verifyExternalizedPointers；本文件只提供 DSH 侧的
 * 结构化指针字段、归档文件名解析与压缩归档的行读取。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { verifyExternalizedPointers } from '../../contract/invariants.js';
import { violation } from './rule-ids.js';
import { decompressZstd } from '../../lib/log-reader.js';
import { ARCHIVE_POINTER_FIELDS, EXTERNALIZED_POINTER_FIELDS } from './vocab.js';

const ZSTD_MAGIC = 0xfd2fb[n];

// 结构化指针字段名（定义在词表适配器；此处转发以保持归档适配器的导出面完整）。
export { ARCHIVE_POINTER_FIELDS, EXTERNALIZED_POINTER_FIELDS };

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

/** 指纹算法（适配器提供；契约层只接收 matchesIntegrity 的布尔/结果）。 */
function sha[n]Hex(text) {
  return crypto.createHash('sha[n]').update(text).digest('hex');
}

/** 指纹匹配：允许 16 位前缀（深校验以较长指纹为准；过短/缺失不猜）。 */
function shaMatches(line, want) {
  if (typeof want !== 'string' || want.length < 16) return { ok: true, got: null };
  const got = sha[n]Hex(line);
  const w = want.toLowerCase();
  const ok = w.length >= 64 ? got === w.slice(0, 64) : (got.startsWith(w) || w.startsWith(got.slice(0, w.length)));
  return { ok, got };
}

/** DSH 结构化指针 → 契约层通用描述符（`meta` 原样带回，用于重建平台诊断文本）。 */
function toContractPointer(pointer) {
  return {
    ref: pointer.ref,
    line: pointer.archiveLine ?? null,
    digest: pointer.sha[n] ?? null,
    meta: pointer,
  };
}

/** 契约层问题清单 → 平台 A1 判定（诊断文本与字段名属平台侧）。 */
function buildArchiveViolations(issues) {
  const out = [];
  for (const issue of issues ?? []) {
    const p = issue.pointer?.meta ?? {};
    const loc = { seq: p.seq ?? null, lineNo: p.lineNo ?? null, eventType: p.type ?? null };
    if (issue.type === 'unreadable') {
      out.push(violation('A1', loc, `归档不可读：${p.field} → ${p.ref}（解析到 ${issue.target}）——在位可还原判定失败（${issue.reason}）`));
    } else if (issue.type === 'line-missing') {
      out.push(violation('A1', loc, `归档行缺失：${p.field} → ${p.ref} 指向第 ${String(issue.lineNo)} 行，但归档只有 ${issue.lineCount} 行——内容不可在位还原（模板/示例文本不参与本判据）`));
    } else if (issue.type === 'digest-mismatch') {
      const want = typeof issue.want === 'string' ? issue.want.slice(0, 16) : String(issue.want);
      const got = typeof issue.got === 'string' ? issue.got.slice(0, 16) : String(issue.got);
      out.push(violation('A1', loc, `归档内容指纹不符：${p.field} → ${p.ref} 第 ${issue.lineNo} 行 sha[n] 期望 ${want}…，实际 ${got}…——归档已漂移，不可在位还原`));
    } else if (issue.type === 'relocated') {
      const v = violation('A1', loc, `归档指针的绝对路径已失效（${p.ref}），但同名归档在归档根可解析（${issue.target}）——内容可找回，但**不在位**（re-home 未回写）；按 relocated 记 warning`);
      v.severity = 'warning';
      out.push(v);
    }
  }
  return out;
}

/** 契约层通用结论 → 公开 A1 结论（字段名/逐项读数与既有公开面一致）。 */
function toPublicArchiveResult(result) {
  const issues = result.issues ?? [];
  const details = { missing: [], relocated: [], unresolved: [], lineMissing: [], shaMismatch: [] };
  const pushCapped = (list, item) => { if (list.length < 20) list.push(item); };
  for (const issue of issues) {
    const p = issue.pointer?.meta ?? {};
    if (issue.type === 'unreadable') pushCapped(details.missing, { seq: p.seq ?? null, field: p.field, ref: p.ref, target: issue.target, reason: issue.reason });
    else if (issue.type === 'line-missing') pushCapped(details.lineMissing, { seq: p.seq ?? null, field: p.field, ref: p.ref, target: issue.target, archiveLine: issue.lineNo, lines: issue.lineCount });
    else if (issue.type === 'digest-mismatch') pushCapped(details.shaMismatch, { seq: p.seq ?? null, field: p.field, ref: p.ref, target: issue.target, archiveLine: issue.lineNo, want: typeof issue.want === 'string' ? issue.want.slice(0, 16) : issue.want, got: typeof issue.got === 'string' ? issue.got.slice(0, 16) : issue.got });
    else if (issue.type === 'relocated') pushCapped(details.relocated, { seq: p.seq ?? null, field: p.field, ref: p.ref, target: issue.target });
    else if (issue.type === 'unresolved') pushCapped(details.unresolved, { seq: p.seq ?? null, field: p.field, ref: p.ref });
  }
  return {
    assessable: result.assessable,
    pointers: result.pointers,
    effectivePointers: result.effectivePointers,
    restorable: result.restorable,
    relocated: result.relocated,
    missing: result.missing,
    unresolved: result.unresolved,
    lineMissing: result.lineMissing,
    shaMismatch: result.digestMismatch,
    duplicated: result.duplicated,
    restoredBytes: result.restoredBytes,
    restorableRate: result.restorableRate,
    verdict: result.verdict,
    violations: buildArchiveViolations(issues),
    details,
  };
}

/**
 * 校验结构化指针能否在位还原。
 *
 * 平台侧职责：把 DSH 字段（archiveLine/sha[n]/externalized.*）规范化成契约层通用描述符，
 * 注入压缩归档读取器与 sha[n] 指纹校验；判定核心与结论聚合在 contract/invariants.js。
 *
 * @param {Array} pointers collectArchivePointers() 的结果
 * @param {{archiveRoots?:string[], readLines?:Function}} [opts]
 */
export function verifyArchivePointers(pointers, { archiveRoots = [], readLines } = {}) {
  const result = verifyExternalizedPointers(
    (pointers ?? []).map(toContractPointer),
    { roots: archiveRoots, readLines: readLines ?? readArchiveIndex, matchesIntegrity: shaMatches },
  );
  return toPublicArchiveResult(result);
}

/**
 * A1 一站式：事件流 → 结构化指针 → 在位可还原结论。
 * @param {Array<{event:object,lineNo?:number}>} events
 * @param {{archiveRoots?:string[], readLines?:Function}} [opts]
 */
export function archiveVerdict(events, { archiveRoots = [], readLines } = {}) {
  const pointers = collectArchivePointers(events);
  return verifyArchivePointers(pointers, { archiveRoots, readLines });
}
