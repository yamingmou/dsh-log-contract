/**
 * dsh-log-contract · lib/repair.js
 *
 * 会话日志修复（2026-08-26/27 事故后的固化方案）。
 *
 * 提供三类修复原语，全部经过两轮真实事故验证：
 *  1. strictScanText —— 展开 chunk 行后做 seq==index 严格连续扫描（复刻
 *     dsh-session-persistence-jsonl 的 committed-region 校验；该检查此前
 *     未被离线体检覆盖，加载失败是它第一次暴露）。
 *  2. removeMarkersText —— 移除 retrace / message-editor 的 replace marker
 *     并全量重编号（seq / seq0 / sourceEventSeqs / surfaceOp 范围同步）。
 *     用于"大范围 marker 遮蔽历史"（旧版 editFromScratch 产物）与
 *     "marker 漏盖 tool/result 导致悬空 tool"。
 *  3. rebuildZstdText —— 按官方 writer 的帧格式重建 .jsonl.zstd：
 *     帧1 = header 行 + "\n"（单独压缩、带 checksum），帧2 = 其余行
 *     + 结尾 "\n"（单独压缩、带 checksum）。**必须精确保持结尾单个换行**
 *     ——双换行/无换行都会被读者判为"complete frame contains a torn
 *     JSONL record"（2026-08-27 实锤踩坑）。
 *
 * 安全协议（每一步手术都必须遵守）：
 *  - 改前备份原文件（`backup-<name>-<ts>` 同级目录或 --backup-dir）；
 *  - 改后全量校验：strictScan + dsh-log-contract check（含 W1/W2 wire
 *    检查）+ foldSurface；
 *  - marker 只能遮蔽它之前的节点（replace start/end 必须已存在于 surface）；
 *  - marker 绝不能改成 append（turn/step null → 客户端引擎崩溃 M1）；
 *  - 运行中的 app 内存优先于文件——修复后若会话已驻留，需重启（强杀避免
 *    脏状态刷回）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { decompressZstd, loadSessionLog } from './log-reader.js';
import { validateSessionLog } from './validate.js';
import { CHUNK_ROW_TYPES, MARKER_PREFIXES } from './checks.js';

/** 复刻 dsh-session expandRow：chunk 行展开为完整事件（含 data/turn/step）。 */
function expandChunkRow(row) {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts;
  const events = [];
  let time = row.time0;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1];
    let chunk;
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] };
        break;
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] };
        break;
      case 'tool-call-chunks':
        chunk = { type: 'tool-call-delta', index: row.data.index, id: row.data.id, ...(row.data.name ? { name: row.data.name } : {}), argumentsDelta: members[k] };
        break;
      default:
        return [];
    }
    events.push({ type: 'assistant/chunk', seq: row.seq0 + k, time, data: { turn: row.data.turn, step: row.data.step, chunk } });
  }
  return events;
}

/** 按行解码一行 JSONL 为事件数组（chunk 行展开，损坏行返回 null）。 */
function decodeLine(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const tag = v.type;
  if (CHUNK_ROW_TYPES.has(tag)) {
    try {
      return expandChunkRow(v);
    } catch {
      return null;
    }
  }
  return [v];
}

function isRetraceMarker(event) {
  if (event?.type !== 'assistant/message') return false;
  if (!event.surfaceOp || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') return false;
  const id = event.data?.message?.id;
  return typeof id === 'string' && MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`));
}

/**
 * 严格 seq 连续扫描（展开 chunk 行后 seq==index）。header 行（首行）跳过。
 * @param {string} text - JSONL 全文（含 header 行）。
 * @returns {{ failures: Array<{line:number, expected:number, got:number, type:string}>, count: number }}
 */
export function strictScanText(text) {
  const lines = text.split('\n');
  const failures = [];
  let count = 0;
  for (let i = 1; i < lines.length; i++) { // 跳过 header（第 1 行）
    const raw = lines[i].trim();
    if (!raw) continue;
    const decoded = decodeLine(raw);
    if (decoded === null) {
      failures.push({ line: i + 1, kind: 'unparsable' });
      continue;
    }
    for (const ev of decoded) {
      if (typeof ev.seq !== 'number') {
        failures.push({ line: i + 1, expected: count, got: ev.seq, type: ev.type ?? '?' });
        continue;
      }
      if (ev.seq !== count) {
        failures.push({ line: i + 1, expected: count, got: ev.seq, type: ev.type });
        count = ev.seq + 1;
        continue;
      }
      count++;
    }
  }
  return { failures, count };
}

/**
 * 移除 retrace/message-editor marker 并全量重编号。
 * @param {string} text - JSONL 全文。
 * @returns {{ text: string, removed: number, renumbered: number, markerSeqs: number[] }}
 */
export function removeMarkersText(text) {
  const parts = text.split('\n');
  const markerSeqs = [];
  for (const raw of parts) {
    if (!raw.trim()) continue;
    const decoded = decodeLine(raw);
    if (decoded && decoded.length === 1 && isRetraceMarker(decoded[0])) markerSeqs.push(decoded[0].seq);
  }
  markerSeqs.sort((a, b) => a - b);
  if (markerSeqs.length === 0) {
    return { text, removed: 0, renumbered: 0, markerSeqs };
  }
  const shiftFor = (seq) => {
    let lo = 0;
    let hi = markerSeqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (markerSeqs[mid] < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const isMarkerSeq = (seq) => markerSeqs.includes(seq);
  const out = [];
  let removed = 0;
  let renumbered = 0;
  for (const raw of parts) {
    if (!raw.trim()) {
      out.push(raw); // 保留结尾空行（确保 join 后仍是单个结尾换行）
      continue;
    }
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      out.push(raw);
      continue;
    }
    if (v && typeof v === 'object' && v.type === 'assistant/message' && v.surfaceOp && v.surfaceOp.op === 'replace') {
      const id = v.data?.message?.id;
      if (typeof id === 'string' && MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`))) {
        removed++;
        continue;
      }
    }
    let touched = false;
    if (typeof v.seq === 'number') {
      const s = shiftFor(v.seq);
      if (s) {
        v.seq -= s;
        touched = true;
      }
    }
    if (CHUNK_ROW_TYPES.has(v.type) && typeof v.seq0 === 'number') {
      const s = shiftFor(v.seq0);
      if (s) {
        v.seq0 -= s;
        touched = true;
      }
    }
    if (Array.isArray(v.sourceEventSeqs)) {
      const next = v.sourceEventSeqs.filter((x) => !isMarkerSeq(x)).map((x) => x - shiftFor(x));
      if (next.length !== v.sourceEventSeqs.length || next.some((x, k) => x !== v.sourceEventSeqs[k])) {
        v.sourceEventSeqs = next;
        touched = true;
      }
    }
    if (v.surfaceOp && v.surfaceOp.op === 'replace') {
      const ns = v.surfaceOp.start - shiftFor(v.surfaceOp.start);
      const ne = v.surfaceOp.end - shiftFor(v.surfaceOp.end);
      if (ns !== v.surfaceOp.start || ne !== v.surfaceOp.end) {
        v.surfaceOp.start = ns;
        v.surfaceOp.end = ne;
        touched = true;
      }
    }
    out.push(touched ? JSON.stringify(v) : raw);
    if (touched) renumbered++;
  }
  let fixed = out.join('\n');
  if (!fixed.endsWith('\n')) fixed += '\n';
  return { text: fixed, removed, renumbered, markerSeqs };
}

/**
 * 通用"删除事件 + 全量重编号"引擎：按谓词删行，seq/seq0/sourceEventSeqs/
 * surfaceOp 范围同步平移。
 * @param {string[]} parts - text.split('\n')。
 * @param {(event: object) => boolean} dropPredicate - 命中即删除该事件行。
 * @returns {{ text: string, removed: number, renumbered: number }}
 */
function renumberWithDrops(parts, dropPredicate) {
  const dropped = new Set();
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof v.seq === 'number' && dropPredicate(v)) dropped.add(v.seq);
  }
  const sortedDrops = [...dropped].sort((a, b) => a - b);
  const shiftFor = (seq) => {
    let lo = 0;
    let hi = sortedDrops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedDrops[mid] < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const isDrop = (seq) => dropped.has(seq);
  const out = [];
  let removed = 0;
  let renumbered = 0;
  for (const raw of parts) {
    if (!raw.trim()) {
      out.push(raw);
      continue;
    }
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      out.push(raw);
      continue;
    }
    if (typeof v.seq === 'number' && dropPredicate(v)) {
      removed++;
      continue;
    }
    let touched = false;
    if (typeof v.seq === 'number') {
      const s = shiftFor(v.seq);
      if (s) {
        v.seq -= s;
        touched = true;
      }
    }
    if (CHUNK_ROW_TYPES.has(v.type) && typeof v.seq0 === 'number') {
      const s = shiftFor(v.seq0);
      if (s) {
        v.seq0 -= s;
        touched = true;
      }
    }
    if (Array.isArray(v.sourceEventSeqs)) {
      const next = v.sourceEventSeqs.filter((x) => !isDrop(x)).map((x) => x - shiftFor(x));
      if (next.length !== v.sourceEventSeqs.length || next.some((x, k) => x !== v.sourceEventSeqs[k])) {
        v.sourceEventSeqs = next;
        touched = true;
      }
    }
    if (v.surfaceOp && v.surfaceOp.op === 'replace') {
      const ns = v.surfaceOp.start - shiftFor(v.surfaceOp.start);
      const ne = v.surfaceOp.end - shiftFor(v.surfaceOp.end);
      if (ns !== v.surfaceOp.start || ne !== v.surfaceOp.end) {
        v.surfaceOp.start = ns;
        v.surfaceOp.end = ne;
        touched = true;
      }
    }
    out.push(touched ? JSON.stringify(v) : raw);
    if (touched) renumbered++;
  }
  let fixed = out.join('\n');
  if (!fixed.endsWith('\n')) fixed += '\n';
  return { text: fixed, removed, renumbered };
}

/**
 * 删除"本轮运行失败"的轮次（turn/end 带 reason.kind==='error' 的完整轮次：
 * [turnStart..turnEnd]，含其中的 user 消息与失败产出），并全量重编号。
 * 用于清掉界面上的失败报错气泡。
 * @param {string} text - JSONL 全文。
 * @returns {{ text: string, removed: number, renumbered: number, failedTurns: number }}
 */
export function dropFailedTurnsText(text) {
  const parts = text.split('\n');
  const spans = [];
  let curTurnStart = null;
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (v.type === 'turn/start') curTurnStart = v.seq;
    else if (v.type === 'turn/end') {
      if (v.data?.reason?.kind === 'error' && curTurnStart !== null) spans.push([curTurnStart, v.seq]);
      curTurnStart = null;
    }
  }
  if (spans.length === 0) return { text, removed: 0, renumbered: 0, failedTurns: 0 };
  const inSpan = (seq) => spans.some(([s, e]) => seq >= s && seq <= e);
  const r = renumberWithDrops(parts, (v) => inSpan(v.seq));
  return { ...r, failedTurns: spans.length };
}

/**
 * 裁剪到最近 keepMessages 条 append 消息（保留其所在 turn 的结构），
 * 同时移除全部 retrace/message-editor marker，并全量重编号。
 * 用于"完整历史超出模型 context 窗口"（MiMo 1M tokens 实锤）。
 * @param {string} text - JSONL 全文。
 * @param {number} keepMessages - 保留的 append 消息数。
 * @returns {{ text: string, removed: number, renumbered: number, kept: number, cutoff: number }}
 */
export function trimLastMessagesText(text, keepMessages) {
  const parts = text.split('\n');
  const msgSeqs = [];
  let lastTurnStart = null;
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (v.type === 'user/message' || (v.type === 'assistant/message' && v.surfaceOp === 'append')) msgSeqs.push(v.seq);
  }
  const total = msgSeqs.length;
  if (total <= keepMessages) return { text, removed: 0, renumbered: 0, kept: total, cutoff: 0 };
  const cutoffMsg = msgSeqs[total - keepMessages];
  // 往前取到包含 cutoffMsg 的那个 turn 的 turn/start，保住轮次结构
  let cutoff = cutoffMsg;
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (v.type === 'turn/start' && v.seq < cutoffMsg) cutoff = v.seq;
  }
  const drop = (v) => (typeof v.seq === 'number' && v.seq < cutoff) || isRetraceMarker(v);
  const r = renumberWithDrops(parts, drop);
  return { ...r, kept: keepMessages, cutoff };
}

/**
 * 按官方 writer 帧格式重建 .jsonl.zstd（帧1=header，帧2=其余，均带 checksum）。
 * @param {string} text - JSONL 全文（以 "\n" 结尾）。
 * @returns {Buffer}
 */
export function rebuildZstdText(text) {
  const nl = text.indexOf('\n');
  if (nl === -1) throw new Error('repair: JSONL 缺 header 行');
  const header = text.slice(0, nl + 1);
  const body = text.slice(nl + 1);
  if (!body.endsWith('\n')) throw new Error('repair: JSONL 必须以单个换行结尾');
  const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  const f1 = zstdCompressSync(Buffer.from(header), opts);
  const f2 = zstdCompressSync(Buffer.from(body), opts);
  const out = Buffer.concat([f1, f2]);
  // roundtrip 验证
  const back = Buffer.concat([zstdDecompressSync(f1), zstdDecompressSync(f2)]).toString('utf8');
  if (back !== text) throw new Error('repair: zstd 重建 roundtrip 不一致');
  return out;
}

/**
 * 对单个会话日志执行诊断 +（可选）修复。
 * @param {string} file - .jsonl 或 .jsonl.zstd 路径。
 * @param {{
 *   removeMarkers?: boolean, dropFailedTurns?: boolean, trimLast?: number,
 *   apply?: boolean, backupDir?: string
 * }} opts
 * @returns {{
 *   file, ok, issues: Array<{kind:string, detail:string}>,
 *   removed, renumbered, backupPath, applied,
 *   check: { ok, summary }
 * }}
 */
export function repairSession(file, opts = {}) {
  const buf = fs.readFileSync(file);
  const isZstd = buf.length >= 4 && buf.readUInt32LE(0) === 4247762216;
  const issues = [];
  let plain;
  if (isZstd) {
    try {
      plain = decompressZstd(buf).toString('utf8');
    } catch (err) {
      return { file, ok: false, issues: [{ kind: 'zstd-decode', detail: String(err.message ?? err) }], removed: 0, renumbered: 0, applied: false };
    }
  } else {
    plain = buf.toString('utf8');
  }
  if (!plain.endsWith('\n')) {
    issues.push({ kind: 'trailing-newline', detail: '文件未以单个换行结尾——读者会判为撕裂记录；将补回' });
    plain += '\n';
  }
  const scan = strictScanText(plain);
  if (scan.failures.length > 0) {
    const f = scan.failures[0];
    issues.push({ kind: 'seq-gap', detail: `line ${f.line}：期望 ${f.expected} 实际 ${f.got}（${f.type}）——${scan.failures.length} 处` });
  }
  // 契约体检（含 W1/W2 wire 检查）
  const check = validateSessionLog(loadSessionLogFromText(plain));
  if (!check.ok) {
    const errs = check.violations.filter((v) => v.severity === 'error');
    issues.push({ kind: 'contract', detail: `${errs.length} 个 error 级违规（首条：${errs[0]?.id ?? '-'} ${errs[0]?.message?.slice(0, 90) ?? ''}）` });
  }
  let removed = 0;
  let renumbered = 0;
  const applyFix = (label, r, detail) => {
    removed += r.removed;
    renumbered += r.renumbered;
    if (r.removed > 0) {
      issues.push({ kind: label, detail });
      plain = r.text;
    }
  };
  if (opts.dropFailedTurns) {
    const r = dropFailedTurnsText(plain);
    applyFix('failed-turns', r, `移除 ${r.failedTurns} 个失败轮次（"本轮运行失败"报错气泡，重编号 ${r.renumbered} 行）`);
  }
  if (opts.removeMarkers) {
    const r = removeMarkersText(plain);
    applyFix('markers', r, `移除 ${r.removed} 个 retrace/message-editor marker（重编号 ${r.renumbered} 行）`);
  }
  if (typeof opts.trimLast === 'number') {
    const r = trimLastMessagesText(plain, opts.trimLast);
    applyFix('trim', r, `裁剪到最近 ${r.kept} 条消息（丢弃 ${r.removed} 行，重编号 ${r.renumbered} 行）`);
  }
  // 全部修复完成后做一次终检（中间态的临时违规不阻塞——后续修复可能已消除）
  const scanFinal = strictScanText(plain);
  const checkFinal = validateSessionLog(loadSessionLogFromText(plain));
  if (scanFinal.failures.length > 0) {
    const f = scanFinal.failures[0];
    issues.push({ kind: 'final-scan', detail: `修复后仍不连续：line ${f.line} 期望 ${f.expected} 实际 ${f.got}——${scanFinal.failures.length} 处` });
  }
  if (!checkFinal.ok) {
    const errs = checkFinal.violations.filter((v) => v.severity === 'error');
    issues.push({ kind: 'final-contract', detail: `修复后仍有 ${errs.length} 个 error 级违规（首条：${errs[0]?.id ?? '-'} ${errs[0]?.message?.slice(0, 90) ?? ''}）` });
  }
  const ok = scanFinal.failures.length === 0 && checkFinal.ok;
  let backupPath = null;
  let applied = false;
  if (opts.apply && ok) {
    const dir = opts.backupDir ?? path.dirname(file);
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const base = path.basename(file).replace(/\.(jsonl\.zstd|jsonl)$/, '');
    backupPath = path.join(dir, `backup-${base}-${ts}.jsonl.zstd`);
    fs.copyFileSync(file, backupPath);
    const out = isZstd ? rebuildZstdText(plain) : Buffer.from(plain, 'utf8');
    fs.writeFileSync(file + '.tmp', out);
    fs.renameSync(file + '.tmp', file);
    applied = true;
  }
  return {
    file,
    ok,
    issues,
    removed,
    renumbered,
    backupPath,
    applied,
    check,
  };
}

/** 从文本构造 loadSessionLog 同形状对象（复用校验器）。 */
function loadSessionLogFromText(text) {
  const lines = text.split('\n');
  let header = null;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    header = null;
  }
  const rows = [];
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      rows.push({ lineNo: i, value: null, decoded: null, error: new Error('unparsable') });
      continue;
    }
    const decoded = decodeLine(line);
    if (decoded === null) {
      rows.push({ lineNo: i, value, decoded: null, error: new Error('decode failed') });
      continue;
    }
    for (const event of decoded) events.push({ seq: event.seq, event, lineNo: i });
    rows.push({ lineNo: i, value, decoded, error: null });
  }
  events.sort((a, b) => a.seq - b.seq);
  return { header, headerLine: 0, rows, events, frameInfo: {} };
}
