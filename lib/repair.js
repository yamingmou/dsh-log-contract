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
import { CHUNK_ROW_TYPES, MARKER_PREFIXES, SURFACE_TYPES } from './checks.js';

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
 * 裁剪 assistant/message 的跨 step sourceEventSeqs（2026-08-30 第二类事故）。
 *
 * 现象：DSH 的 resend/regenerate 在 agent 仍开着 step 时被触发，会把旧 step 的
 * assistant/chunk 全部引用进新 assistant/message 的 sourceEventSeqs（526f1835
 * seq 936047：sourceEventSeqs 覆盖 turn 54 的 step 7/8/9 三段）。token-meter
 * 要求每个 source chunk 与消息同 turn/step（dsh-token-meter lib/index.js:645，
 * `belongs to another step`）→ 同样刷屏压垮 host。
 *
 * 修复：把 sourceEventSeqs 裁剪为只含「与消息同 turn/step 的 assistant/chunk」
 * （丢弃跨 step 的 chunk 与边界事件）。token-meter 检查全过（所有 src 同 step），
 * token 计量仍准（保留的就是本 step 实际输出）。不动 seq/行数/其他字段。
 *
 * @param {string} text - JSONL 全文（含 header 行）。
 * @returns {{ text: string, clipped: number, seqs: Array<number> }}
 */
export function clipCrossStepSourcesText(text) {
  const parts = text.split('\n');
  // 用 decodeLine 展开每行，建立「展开后事件 seq → 事件」映射（chunk 行会展开为
  // 多个 assistant/chunk，其 seq 是 seq0+偏移——必须用展开后的 seq 才能对上
  // sourceEventSeqs 引用的值）。同时记录每个展开后事件属于哪一行，便于回写。
  const bySeq = new Map(); // 展开后 seq → { event, lineIndex }
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw.trim()) continue;
    const decoded = decodeLine(raw);
    if (decoded === null) continue;
    for (const ev of decoded) {
      if (typeof ev.seq === 'number') bySeq.set(ev.seq, { event: ev, lineIndex: i });
    }
  }
  const clipped = [];
  let clippedCount = 0;
  for (const { event, lineIndex } of bySeq.values()) {
    if (event.type !== 'assistant/message' || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) continue;
    const { turn, step } = event.data ?? {};
    if (turn == null || step == null) continue; // turn-null marker 由 neutralize 处理
    if (event.data?.usage === void 0) continue; // 无 usage 不触发 _estimateProviderAssistant（官方 :592 前提）——replace marker 的 sourceEventSeqs 是 S5 遮蔽语义，非 chunk 引用合法，不可裁
    let dirty = false;
    const kept = event.sourceEventSeqs.filter((s) => {
      const src = bySeq.get(s)?.event;
      if (!src || src.type !== 'assistant/chunk') { dirty = true; return false; } // 非 chunk/缺失引用官方 :644 直接 throw → 裁剪
      if (src.data?.turn === turn && src.data?.step === step) return true;
      dirty = true;
      return false;
    });
    if (dirty) {
      // 回写：只改事件所属的行。若该行是 chunk 行（多个展开事件共享一行），
      // 此事件必是独立 assistant/message 行，直接改那一行。
      event.sourceEventSeqs = kept;
      parts[lineIndex] = JSON.stringify(event);
      clipped.push(event.seq);
      clippedCount++;
    }
  }
  return { text: parts.join('\n'), clipped: clippedCount, seqs: clipped };
}

/**
 * 原地中和 turn-null marker（2026-08-30 事故升级：单 marker 会让 token-meter
 * 监听器在每条事件上抛错刷屏、压垮 host 事件循环 → 全会话连锁锁定）。
 *
 * 机制（自检单 §3.3）：把 turn-null `assistant/message` replace marker 改写为
 * `retrace/marker` + `ignorable: true`（dsh-session lib/index.js:1203/1209 认可
 * envelope 级 ignorable），**删除 surfaceOp/sourceEventSeqs，不动行数/seq/时间**。
 * 改写后该事件不再属于 SURFACE_EVENT_TYPES（dsh-session:219-223）→ foldSurface
 * 跳过、token-meter 不做 step 配对（不再抛错刷屏）；会话驻留时也安全（seq 不变，
 * 退出 flush 不撞车）。代价：被遮蔽的旧消息回到 surface（编辑外观回退为原文）。
 *
 * @param {string} text - JSONL 全文（含 header 行）。
 * @returns {{ text: string, neutralized: number, seqs: Array<number> }}
 */
export function neutralizeMarkersText(text) {
  const parts = text.split('\n');
  const seqs = [];
  let neutralized = 0;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || v.type !== 'assistant/message') continue;
    // 只中和 turn-null 的 retrace marker（data.turn/step 为 null 且 id 带 marker 前缀）
    if (v.data?.turn != null || v.data?.step != null) continue;
    const id = v.data?.message?.id;
    if (typeof id !== 'string' || !MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`))) continue;
    const seq = v.seq;
    delete v.surfaceOp;
    delete v.sourceEventSeqs;
    v.type = 'retrace/marker';
    v.ignorable = true;
    parts[i] = JSON.stringify(v);
    seqs.push(seq);
    neutralized++;
  }
  return { text: parts.join('\n'), neutralized, seqs };
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
 * 尾部 seq 统一平移（fix-tail 收编，源：tools/trim-session.mjs fix-tail 模式）。
 *
 * 修复多写入者/旧光标造成的尾部 seq 回归/间隙：从 startSeq 起（含）的所有
 * 事件的 seq / seq0 / sourceEventSeqs 统一加减 delta。
 * @param {string} text - JSONL 全文。
 * @param {number} startSeq - 平移起点（该 seq 及之后的事件全部平移）。
 * @param {number} delta - 偏移量（减数语义：要加 N 传 −N；要减 N 传 +N）。
 * @returns {{ text: string, changed: number, startSeq: number, delta: number }}
 */
export function tailRenumberText(text, startSeq, delta) {
  if (!Number.isInteger(delta) || delta === 0) return { text, changed: 0, startSeq, delta };
  const parts = text.split('\n');
  const out = [];
  let changed = 0;
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
    let modified = false;
    const seq = v.seq;
    if (typeof seq === 'number' && seq >= startSeq) {
      const ns = seq - delta;
      if (ns < 0) return { text, changed: 0, startSeq, delta, error: `seq ${seq} 平移后为负（delta 过大或起点有误）` };
      v.seq = ns;
      modified = true;
    }
    if (typeof v.seq0 === 'number' && v.seq0 >= startSeq) {
      const ns = v.seq0 - delta;
      if (ns < 0) return { text, changed: 0, startSeq, delta, error: `seq0 ${v.seq0} 平移后为负（delta 过大或起点有误）` };
      v.seq0 = ns;
      modified = true;
    }
    if (Array.isArray(v.sourceEventSeqs)) {
      const mapped = v.sourceEventSeqs.map((s) => {
        if (s < startSeq) return s;
        const ns = s - delta;
        if (ns < 0) throw new Error(`sourceEventSeqs ${s} 平移后为负`);
        return ns;
      });
      if (mapped.some((s, i) => s !== v.sourceEventSeqs[i])) {
        v.sourceEventSeqs = mapped;
        modified = true;
      }
    }
    if (modified) changed++;
    out.push(JSON.stringify(v));
  }
  return { text: out.join('\n'), changed, startSeq, delta };
}

/**
 * fork 边界孤儿 spliced 原地归零（--neutralize-orphan）。
 *
 * 2026-08-28 fork 边界事故：裁剪后历史 inbox spliced 残留（已消费消息被
 * 重新排队 → UI 显示"待排队消息"）。与 neutralize 同类：原地改
 * `removedCount → 0`（start/inserted 不变，seq/行数不变 → 附着力安全）。
 * 只处理 target='next-turn' 的 spliced（队列头）——旧队列残留的典型形态。
 * @param {string} text - JSONL 全文。
 * @returns {{ text: string, neutralized: number, seqs: number[] }}
 */
export function neutralizeOrphanText(text) {
  const parts = text.split('\n');
  const seqs = [];
  let neutralized = 0;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || v.type !== 'agent/inbox/spliced') continue;
    if (v.data?.target !== 'next-turn') continue;
    // 孤儿判定：removedCount > 0（把已消费消息重新排队）——这是 fork 边界
    // 裁剪后残留的典型形态；归零后 inbox 重放视作「空队列」，不再重复投递。
    if (typeof v.data?.removedCount === 'number' && v.data.removedCount > 0) {
      v.data.removedCount = 0;
      parts[i] = JSON.stringify(v);
      seqs.push(v.seq);
      neutralized++;
    }
  }
  return { text: parts.join('\n'), neutralized, seqs };
}

/**
 * 双流交织恢复：保留指定轮次（extract-turn 收编，源：tools/recover-interleaved.mjs）。
 *
 * 并发写入把两条事件流交织进同一文件（旧光标重放流 + 真实新轮次）。本原语：
 * 保留 keepTurn 轮次的全部事件 + 其间的无 turn 系统事件（spliced/user/request
 * 等），丢弃其余（重放流、turn-null marker、非目标轮次），全量重编号；
 * 可选把该轮次的第二个 turn/start 起改号为 secondTurnTo（避免未闭合 turn 冲突）。
 * @param {string} text - JSONL 全文（含 header 行）。
 * @param {number} keepTurn - 要保留的轮次号。
 * @param {number|null} secondTurnTo - 第二个同名 turn/start 起改号（默认 null 不改）。
 * @returns {{ text: string, removed: number, renumbered: number, kept: number, secondRenamed: boolean }}
 */
export function extractTurnText(text, keepTurn, secondTurnTo = null) {
  const parts = text.split('\n');
  const KEEP_NULL_TYPES = new Set(['agent/inbox/spliced', 'user/message', 'request/header', 'session/end-seed', 'command/run', 'command/done']);
  // 第一轮：决定每行去留（按 turn 归属 + 无 turn 系统事件白名单），
  // 并就地改第二个同名轮次的 turn 号（用索引遍历，避免重复行误改）。
  const drop = new Set();
  let sawFirstTurnStart = false;
  let inRenumberTurn = false;
  let kept = 0;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    const d = v.data || {};
    const turn = d.turn;
    const t = v.type;
    let keep = false;
    if (turn === keepTurn) keep = true;
    else if (turn == null && KEEP_NULL_TYPES.has(t)) keep = true;
    if (t === 'turn/start' && d.turn === keepTurn) {
      if (sawFirstTurnStart) inRenumberTurn = true;
      else sawFirstTurnStart = true;
    }
    if (keep) {
      kept++;
      if (inRenumberTurn && turn === keepTurn && secondTurnTo !== null) {
        v.data.turn = secondTurnTo;
        parts[i] = JSON.stringify(v);
      }
    } else if (typeof v.seq === 'number') {
      drop.add(v.seq);
    }
  }
  if (kept === 0) return { text, removed: 0, renumbered: 0, kept: 0, secondRenamed: false };
  // 重编号：对非 drop 行按物理序重排 seq（含 header 行保持原样）
  const r = renumberWithDrops(parts, (v) => typeof v.seq === 'number' && drop.has(v.seq));
  return { ...r, kept, secondRenamed: secondTurnTo !== null && inRenumberTurn };
}

/**
 * 只保留指定 seq 区间，其余删除 + 全量重编号（keep-ranges 收编，
 * 源：tools/keep-ranges.mjs）。
 *
 * 从交织/污染文件中提取干净区段。区间为 1-based 行号（含端点），
 * 如 "10-20,40-50"；区段外的行丢弃。header 行（首行）永远保留。
 * @param {string} text - JSONL 全文（含 header 行）。
 * @param {string} rangesSpec - 区间串，如 "10-20,40-50"。
 * @returns {{ text: string, removed: number, renumbered: number, keptLines: number }}
 */
export function keepRangesText(text, rangesSpec) {
  const ranges = String(rangesSpec).split(',').map((part) => {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (!m) throw new Error(`区间格式错误: "${part}"（应为 a-b，如 10-20）`);
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > b) throw new Error(`区间起点大于终点: "${part}"`);
    return [a, b];
  });
  const parts = text.split('\n');
  const drop = new Set();
  let keptLines = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) { keptLines++; continue; } // header 永远保留
    const one = i + 1; // 1-based 行号
    const inRange = ranges.some(([a, b]) => one >= a && one <= b);
    if (inRange) keptLines++;
    else {
      let v;
      try {
        v = JSON.parse(parts[i]);
      } catch {
        continue;
      }
      if (typeof v.seq === 'number') drop.add(v.seq);
    }
  }
  if (keptLines === 1) return { text, removed: 0, renumbered: 0, keptLines };
  const r = renumberWithDrops(parts, (v) => typeof v.seq === 'number' && drop.has(v.seq));
  return { ...r, keptLines };
}

/**
 * 消息文本 token 估算（L5：中文密度校准）。
 *
 * 2026-08 事故教训：chars/4 对中文密集内容低估 ~3.7×（实际 ≈ 字符数×0.94）。
 * 本函数按消息类型取文本并加权：
 *   - 中文/全角字符：×0.94（实测密度，不是 /4）；
 *   - 其余字符（ASCII/空格/标点）：×0.25（近似词元密度）；
 *   - JSON 结构开销（每消息 envelope）：+12 tokens 固定。
 * @param {string} text - JSONL 全文（含 header）。
 * @returns {{ tokens: number, cjk: number, other: number }}
 */
export function estimateTokensText(text) {
  const parts = text.split('\n');
  let cjk = 0;
  let other = 0;
  let messages = 0;
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    let body = '';
    if (v.type === 'user/message') {
      body = (v.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      messages++;
    } else if (v.type === 'assistant/message' && v.surfaceOp === 'append') {
      body = (v.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      messages++;
    }
    // 按码点分类：CJK 统一表意文字 + 全角符号按中文字符计
    for (const ch of body) {
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
        (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
        (cp >= 0xff00 && cp <= 0xffef) || // 全角
        (cp >= 0x3000 && cp <= 0x303f)    // CJK 标点
      ) cjk++;
      else if (cp > 0x20) other++;
    }
  }
  const tokens = Math.ceil(cjk * 0.94 + other * 0.25 + messages * 12);
  return { tokens, cjk, other, messages };
}

/**
 * 按 token 预算裁剪（L5）：自动选保留消息数，使「估算 token ≤ 预算」。
 * 保留 --trim-last N 按消息数语义；--trim-budget 走本函数。
 * 下限保护：至少保留 5 条消息（防空会话）。
 *
 * 精确做法：按消息类型逐条累计 token 估算（复用 estimateTokensText 的
 * 单条消息算法），从最近消息往回累加，直到超过预算——避免比例估算误差。
 * @param {string} text - JSONL 全文。
 * @param {number} budget - token 预算（如 450000）。
 * @returns {{ text: string, removed: number, renumbered: number, kept: number, cutoff: number, estimatedTokens: number }}
 */
export function trimLastMessagesByBudget(text, budget) {
  const parts = text.split('\n');
  // 逐条消息的 { seq, tokens }：从最近往回累计
  const msgs = [];
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    let body = '';
    if (v.type === 'user/message') {
      body = (v.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    } else if (v.type === 'assistant/message' && v.surfaceOp === 'append') {
      body = (v.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    } else {
      continue;
    }
    let cjk = 0;
    let other = 0;
    for (const ch of body) {
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xff00 && cp <= 0xffef) ||
        (cp >= 0x3000 && cp <= 0x303f)
      ) cjk++;
      else if (cp > 0x20) other++;
    }
    msgs.push({ seq: v.seq, tokens: Math.ceil(cjk * 0.94 + other * 0.25 + 12) });
  }
  const total = msgs.length;
  const MIN_KEEP = 5;
  // 从最近往回累计，找到「估算 ≤ 预算」的最大保留数
  let acc = 0;
  let kept = 0;
  for (let i = total - 1; i >= 0; i--) {
    if (acc + msgs[i].tokens > budget) break;
    acc += msgs[i].tokens;
    kept++;
  }
  if (kept < MIN_KEEP) kept = MIN_KEEP;
  if (kept >= total) {
    const all = estimateTokensText(text);
    return { text, removed: 0, renumbered: 0, kept: total, cutoff: 0, estimatedTokens: all.tokens };
  }
  const r = trimLastMessagesText(text, kept);
  return { ...r, estimatedTokens: acc };
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

/** 从被遮蔽的 user/assistant 消息做提取式摘要（跨范围均匀采样，不依赖模型）。 */
function extractiveSummary(msgEvents) {
  const lines = [];
  const step = Math.max(1, Math.ceil(msgEvents.length / 18));
  const sampled = [];
  for (let i = 0; i < msgEvents.length; i += step) sampled.push(msgEvents[i]);
  const last = msgEvents[msgEvents.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  for (const ev of sampled) {
    let text = '';
    if (ev.type === 'user/message') {
      text = (ev.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    } else if (ev.type === 'assistant/message') {
      text = (ev.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const chunk = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    lines.push(`${ev.type === 'user/message' ? '问' : '答'} ${chunk}`);
    if (lines.join('\n').length > 1800) break;
  }
  if (lines.length === 0) return '（早期对话无文本内容）';
  return `【早期对话提取式摘要 · 完整原文保留在会话日志与备份中】\n${lines.join('\n')}`;
}

/**
 * DSH 官方压缩（compaction）：不删除任何事件——在日志尾部追加
 * compaction/start → compaction/summary → checkpoint(user/message, replace
 * [start..end]) → compaction/end，把 [start..end] 从模型表面遮蔽，替换为
 * 提取式摘要。旧事件全部保留（append-only 审计），日志一行不删。
 * @param {string} text - JSONL 全文（严格连续）。
 * @param {number} keepMessages - 保留的最近 append 消息数。
 * @returns {{ text: string, compacted: boolean, kept: number, shadowed: number, summary: string }}
 */
export function compactLastMessagesText(text, keepMessages) {
  const parts = text.split('\n');
  const bySeq = new Map();
  const surfaceNodes = [];
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;
    const decoded = decodeLine(raw);
    if (decoded === null) continue;
    for (const ev of decoded) {
      bySeq.set(ev.seq, ev);
      if (SURFACE_TYPES.has(ev.type)) {
        const op = ev.surfaceOp;
        if (op === 'append') surfaceNodes.push(ev.seq);
        else if (op && op.op === 'replace') {
          const s = surfaceNodes.indexOf(op.start);
          const e = surfaceNodes.indexOf(op.end);
          if (s !== -1 && e !== -1 && s <= e) surfaceNodes.splice(s, e - s + 1);
          surfaceNodes.push(ev.seq);
        }
      }
    }
  }
  const appendMsgs = surfaceNodes.filter((seq) => {
    const ev = bySeq.get(seq);
    return ev && (ev.type === 'user/message' || (ev.type === 'assistant/message' && ev.surfaceOp === 'append'));
  });
  const total = appendMsgs.length;
  if (total <= keepMessages) return { text, compacted: false, kept: total, shadowed: 0, summary: '' };
  const target = appendMsgs[total - keepMessages];
  let boundary = target;
  for (const seq of appendMsgs) {
    const ev = bySeq.get(seq);
    if (ev.type === 'user/message' && seq <= target) boundary = seq;
  }
  const shadowedSeqs = surfaceNodes.filter((seq) => seq < boundary);
  const start = shadowedSeqs[0];
  const end = shadowedSeqs[shadowedSeqs.length - 1];
  const summary = extractiveSummary(shadowedSeqs.map((seq) => bySeq.get(seq)).filter(Boolean));
  // 压缩事件插入到"第一个保留事件"之前（seq = boundary..boundary+3），
  // 之后的事件整体 +4 重编号——保证表面顺序为 [checkpoint, 近期轮次…]。
  const boundarySeq = boundary;
  const compactionId = `dsh-fix-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const startSeq = boundarySeq;
  const summarySeq = boundarySeq + 1;
  const checkpointSeq = boundarySeq + 2;
  const endSeq = boundarySeq + 3;
  const now = Date.now();
  const appended = [
    { type: 'compaction/start', seq: startSeq, time: now, data: { compactionId, turn: null } },
    {
      type: 'compaction/summary',
      seq: summarySeq,
      time: now,
      data: {
        compactionId,
        summary,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount: Math.round(summary.length / 4),
        provider: 'dsh-log-contract',
        model: 'extractive',
      },
    },
    {
      type: 'user/message',
      seq: checkpointSeq,
      time: now,
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs],
      data: {
        id: `checkpoint-${compactionId}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: summary }],
      },
    },
    { type: 'compaction/end', seq: endSeq, time: now, data: { compactionId, turn: null } },
  ];
  // 找到第一个事件 seq >= boundary 的行（保留区起点），在其前插入压缩事件
  let insertIdx = parts.length - 1;
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;
    const decoded = decodeLine(raw);
    if (decoded === null || decoded.length === 0) continue;
    if (decoded[0].seq >= boundarySeq) {
      insertIdx = i;
      break;
    }
  }
  const shiftFields = (v) => {
    if (typeof v.seq === 'number') v.seq += 4;
    if (CHUNK_ROW_TYPES.has(v.type) && typeof v.seq0 === 'number') v.seq0 += 4;
    if (Array.isArray(v.sourceEventSeqs)) v.sourceEventSeqs = v.sourceEventSeqs.map((x) => x + 4);
    if (v.surfaceOp && v.surfaceOp.op === 'replace') {
      v.surfaceOp.start += 4;
      v.surfaceOp.end += 4;
    }
    return v;
  };
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === insertIdx) for (const e of appended) out.push(JSON.stringify(e));
    const raw = parts[i];
    if (i > 0 && i >= insertIdx && raw.trim()) {
      let v;
      try {
        v = JSON.parse(raw);
      } catch {
        out.push(raw);
        continue;
      }
      if (typeof v.seq === 'number') {
        out.push(JSON.stringify(shiftFields(v)));
        continue;
      }
    }
    out.push(raw);
  }
  const newText = out.join('\n');
  if (!newText.endsWith('\n')) return { text: newText + '\n', compacted: true, kept: keepMessages, shadowed: shadowedSeqs.length, summary };
  return { text: newText, compacted: true, kept: keepMessages, shadowed: shadowedSeqs.length, summary };
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
 *   removeMarkers?: boolean, dropFailedTurns?: boolean, trimLast?: number, compactLast?: number,
 *   neutralize?: boolean, clipCrossStep?: boolean, apply?: boolean, backupDir?: string
 * }} opts
 * @returns {{
 *   file, ok, issues: Array<{kind:string, detail:string}>,
 *   removed, renumbered, neutralized, neutralizedSeqs: Array<number>,
 *   clipped, clippedSeqs: Array<number>, backupPath, applied,
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
  let neutralized = 0;
  const neutralizedSeqs = [];
  if (opts.neutralize) {
    const r = neutralizeMarkersText(plain);
    neutralized = r.neutralized;
    neutralizedSeqs.push(...r.seqs);
    if (r.neutralized > 0) {
      issues.push({ kind: 'neutralize', detail: `原地中和 ${r.neutralized} 个 turn-null marker（type→retrace/marker + ignorable:true，删除 surfaceOp/sourceEventSeqs，seq/行数不变）→ token-meter 不再刷屏` });
      plain = r.text;
    }
  }
  let clipped = 0;
  const clippedSeqs = [];
  if (opts.clipCrossStep) {
    const r = clipCrossStepSourcesText(plain);
    clipped = r.clipped;
    clippedSeqs.push(...r.seqs);
    if (r.clipped > 0) {
      issues.push({ kind: 'clip-crossstep', detail: `裁剪 ${r.clipped} 个 assistant/message 的跨 step sourceEventSeqs（保留同 step chunk，token-meter 不再抛 belongs to another step）` });
      plain = r.text;
    }
  }
  if (typeof opts.trimLast === 'number') {
    const r = trimLastMessagesText(plain, opts.trimLast);
    applyFix('trim', r, `裁剪到最近 ${r.kept} 条消息（丢弃 ${r.removed} 行，重编号 ${r.renumbered} 行）`);
  }
  if (typeof opts.trimBudget === 'number') {
    const r = trimLastMessagesByBudget(plain, opts.trimBudget);
    if (r.removed > 0) {
      issues.push({ kind: 'trim-budget', detail: `按 token 预算 ${opts.trimBudget} 裁剪：保留 ${r.kept} 条消息（估算 ≈${r.estimatedTokens} tokens，丢弃 ${r.removed} 行，重编号 ${r.renumbered} 行）` });
      plain = r.text;
    } else {
      issues.push({ kind: 'trim-budget', detail: `估算 ${r.estimatedTokens} tokens ≤ 预算 ${opts.trimBudget}——无需裁剪（${r.kept} 条消息全保留）` });
    }
  }
  // L4 新原语（2026-08-30 任务书 §L4 收编 tools/ 验证工具）
  if (typeof opts.tailRenumberDelta === 'number') {
    // 起点自动推导：从首个可平移的 seq 起（即所有事件都平移）。
    // fix-tail 原工具是 <startLine> <delta> 双参；任务书 §L4 简化为单参 delta
    // （尾部全部平移）。若需部分平移，传 --tail-renumber 前先 --keep-ranges。
    const r = tailRenumberText(plain, 0, opts.tailRenumberDelta);
    if (r.error) {
      issues.push({ kind: 'tail-renumber', detail: r.error });
    } else if (r.changed > 0) {
      issues.push({ kind: 'tail-renumber', detail: `尾部 ${r.changed} 行 seq 平移 delta=${r.delta}` });
      plain = r.text;
    }
  }
  if (opts.neutralizeOrphan) {
    const r = neutralizeOrphanText(plain);
    if (r.neutralized > 0) {
      issues.push({ kind: 'neutralize-orphan', detail: `原地归零 ${r.neutralized} 个孤儿 inbox spliced（removedCount→0，seq/行数不变）→ 不再重复排队` });
      plain = r.text;
    }
  }
  if (typeof opts.extractTurn === 'number') {
    const r = extractTurnText(plain, opts.extractTurn, opts.extractTurnTo ?? null);
    if (r.kept === 0) {
      issues.push({ kind: 'extract-turn', detail: `轮次 ${opts.extractTurn} 不存在（无保留行）` });
    } else {
      issues.push({ kind: 'extract-turn', detail: `保留轮次 ${opts.extractTurn}（${r.kept} 行，丢弃 ${r.removed} 行，重编号 ${r.renumbered} 行）${r.secondRenamed ? `，第二同名轮次改号 ${opts.extractTurnTo}` : ''}` });
      plain = r.text;
    }
  }
  if (typeof opts.keepRanges === 'string') {
    try {
      const r = keepRangesText(plain, opts.keepRanges);
      issues.push({ kind: 'keep-ranges', detail: `保留区间 ${opts.keepRanges}（${r.keptLines} 行，丢弃 ${r.removed} 行，重编号 ${r.renumbered} 行）` });
      plain = r.text;
    } catch (err) {
      issues.push({ kind: 'keep-ranges', detail: String(err.message ?? err) });
    }
  }
  if (typeof opts.compactLast === 'number') {
    const r = compactLastMessagesText(plain, opts.compactLast);
    if (r.compacted) {
      issues.push({ kind: 'compact', detail: `官方压缩：遮蔽 ${r.shadowed} 个 surface 节点，保留最近 ${r.kept} 条消息；旧事件全部保留（日志零删除）` });
      plain = r.text;
    }
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
    neutralized,
    neutralizedSeqs,
    clipped,
    clippedSeqs,
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
