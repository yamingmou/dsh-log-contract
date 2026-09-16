/**
 * dsh-log-contract · test/helpers.js
 *
 * 测试夹具：构造合法/违规会话事件与临时日志文件。
 * 合法事件形状对齐官方 `assertMessageEventShape` 与 surface 契约。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

export const HEADER = { type: 'session', version: 0, id: 'test-session', createdAt: 1 };

export function userMessage({ seq, text = 'hi' } = {}) {
  // 实证形状：user/message 的 data 就是消息本体（无 turn/step）
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: { id: `u-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

export function assistantMessage({ seq, turn = 0, step = 1, text = 'yo', id = `a-${seq}` } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: { id, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text }] },
    },
  };
}

export function turnEnd({ seq, turn = 0, reason = { kind: 'completed' } } = {}) {
  return { type: 'turn/end', seq, time: seq + 1, data: { turn, reason } };
}

/** 插件 marker（retrace 式）：assistant/message replace，data.turn/step 为 null。 */
export function markerEvent({ seq, start, end, shadowedSeqs, id = 'retrace-edit-x', text = 'edited', turn = 1, step = 1 } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: shadowedSeqs,
    data: {
      turn,
      step,
      message: { id, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text }] },
      editor: { targetSeq: start, text },
    },
  };
}

/** tool/result 消息（data.turn/step + message 内嵌，role=user，tool source）。 */
export function toolResultMessage({ seq, turn = 0, step = 0, callId = 'call-1', text = 'ok' } = {}) {
  return {
    type: 'tool/result',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: `t-${seq}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  };
}

/** 一条迷你合法会话：user → assistant → turn/end。 */
export function validSessionEvents() {
  return [
    userMessage({ seq: 0 }),
    assistantMessage({ seq: 1 }),
    turnEnd({ seq: 2 }),
  ];
}

function linesFor(events) {
  return [JSON.stringify(HEADER), ...events.map((e) => JSON.stringify(e))];
}

// ─────────────────────────────────────────────────────────────────────────────
// zstd 帧夹具 —— **必须与官方写盘形状一致**（2026-09-16 真机事故）
//
// 官方形状：**帧 1 = header 独占一行**，其后事件按写入批次逐帧追加；读取端有硬断言
// `assertZstdHeaderFrame`（首帧必须恰好一行），且抛点在 `listArtifacts` **遍历全库**
// 无 per-session 容错 ⇒ 首帧装多行时**整个客户端起不来**（`lib/validate.js` 的 Z4）。
//
// 因此夹具**不允许**把整份日志压成 1 帧：那样的夹具只能测出规则没生效，测不出真实
// 宿主会不会读得动。Z5 专门抓这个形状，`test/frame-shape.test.js` 里还有一条守卫，
// 禁止测试代码再写"整份压一帧"。
// ─────────────────────────────────────────────────────────────────────────────

/** 事件分帧批大小（确定性；见 `zstdFramesOf`）。 */
export const FRAME_BATCH = 2;

/**
 * 帧压缩参数 —— **与官方写盘/本包写回路径同参**。
 *
 * `lib/repair.js` 的 `rebuildZstdText()`（本包唯一的写回实现，逐字节对齐官方帧格式）
 * 用的是 `{ params: { [ZSTD_c_checksumFlag]: 1 } }`：**带 checksum**。
 * 夹具若用默认参数就少了 checksum 位，`scanZstdFrames` 里 `if (checksum) offset += 4`
 * 那条分支在夹具路径上就永远走不到 —— 那正是"夹具不真实"的另一种形态。
 */
const FRAME_OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * 按官方形状切分帧：`lines[0]`（header）独占帧 1，其余按 `batch` 行/帧。
 * @param {string[]} lines 不含换行的行文本，`lines[0]` 必须是 header 行。
 * @param {{batch?: number}} [opts]
 * @returns {Buffer[]} 至少一帧；`lines.length > 1` 时至少两帧。
 */
export function zstdFramesOf(lines, { batch = FRAME_BATCH } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('zstdFramesOf: 至少需要 header 一行');
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error(`zstdFramesOf: batch 必须是正整数（实际 ${batch}）`);
  const frames = [zstdCompressSync(Buffer.from(`${lines[0]}\n`), FRAME_OPTS)];   // 帧 1 = header 独占
  for (let i = 1; i < lines.length; i += batch) {
    frames.push(zstdCompressSync(Buffer.from(`${lines.slice(i, i + batch).join('\n')}\n`), FRAME_OPTS));
  }
  return frames;
}

/**
 * 手搓 log 对象用的 `frameInfo` —— 与官方写盘形状一致。
 *
 * 为什么单独给一个：`loadSessionLog()` 返回的 `frameInfo` 是**文件事实**。手搓 log
 * （不经过文件）若随手写 `frames: 1`，就等于声明"整份压成 1 帧"这种宿主从不产出的形状，
 * 会平白触发 Z5。这里按同样的分帧规则算帧数，让手搓对象与真实文件同形。
 *
 * @param {{eventRows?: number, plaintextBytes?: number, batch?: number, torn?: boolean}} [opts]
 */
export function faithfulFrameInfo({ eventRows = 0, plaintextBytes = 0, batch = FRAME_BATCH, torn = false } = {}) {
  const frames = eventRows === 0 ? 1 : 1 + Math.ceil(eventRows / batch);
  return { frames, torn, compressedBytes: 0, plaintextBytes, firstFrameOneLine: true, firstFrameLines: 1 };
}

/**
 * 写临时会话日志（默认明文 .jsonl；zstd 走**官方形状**多帧，见本节开头）。
 * @param {object} [opts]
 * @param {boolean} [opts.zstd] 是否 zstd
 * @param {false|'tail'|'head'} [opts.torn] 撕裂模式：`'tail'` 砍最后一帧尾部（in-flight 写入，
 *   前帧完整 ⇒ 仍可读）；`'head'` 砍进**第一帧**（header 帧没了 ⇒ 一个完整帧都不剩）。
 * @returns {string} 临时文件路径
 */
export function writeSession(events, { zstd = false, torn = false, header = HEADER, name = 'session' } = {}) {
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  if (!zstd) return writeRawSession(lines, { name });
  return writeSessionFrames(lines, { torn, name });
}

/** 写一个原始行文本（用于 R1/R2 坏行夹具）；zstd 走官方形状多帧。 */
export function writeRawSession(lines, { zstd = false, name = 'session' } = {}) {
  const text = lines.join('\n') + '\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const file = path.join(dir, zstd ? `${name}.jsonl.zstd` : `${name}.jsonl`);
  fs.writeFileSync(file, zstd ? Buffer.concat(zstdFramesOf(lines)) : text);
  return file;
}

/**
 * **反面夹具**：把整份日志压成 **1 帧**（宿主从不这样写）。
 *
 * 唯一用途 = 测 Z4/Z5 会不会抓到它。**不要**拿它当普通会话夹具 —— 它代表的形状
 * 会让客户端起不来（见本节开头）。`test/frame-shape.test.js` 的守卫会禁止
 * `test/` 下除该文件以外的任何地方调用它。
 *
 * @param {string[]} lines 不含换行的行文本；`lines[0]` = header 行。
 * @returns {string} 临时文件路径
 */
export function writeSingleFrameSession(lines, { name = 'single-frame' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const file = path.join(dir, `${name}.jsonl.zstd`);
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`), FRAME_OPTS));
  return file;
}

/**
 * 低层帧构造：给定**每帧的原始载荷**（字符串），逐帧压缩后拼成文件。
 *
 * 用于 Z4 的边界夹具（首帧"一行但无尾换行" / 空首帧 / 只有 header 的单帧）——
 * 这些形状**故意**不是官方形状，所以不能走 `writeSessionFrames`，但压缩动作仍然
 * 收在本文件里（守卫禁止 `test/` 其他文件直接调 zstd 压缩）。
 *
 * @param {string[]} parts 每帧的明文载荷（**不做**任何换行补全，调用方自己写全）
 * @returns {string} 临时文件路径
 */
export function writeFrameParts(parts, { name = 'frame-parts' } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('writeFrameParts: 至少需要一帧');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const file = path.join(dir, `${name}.jsonl.zstd`);
  fs.writeFileSync(file, Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p), FRAME_OPTS))));
  return file;
}

/**
 * 写 zstd 会话文件，**帧 1 只放 header 一行**、其余行按批次分帧（官方形状）。
 *
 * @param {string[]} lines 不含换行的行文本；`lines[0]` = header 行。
 * @param {{batch?: number, torn?: false|'tail'|'head', name?: string}} [opts]
 *   `torn: 'tail'` ⇒ 只砍**最后一帧**的尾部（"边写边读"的 in-flight 尾帧，前帧完整）；
 *   `torn: 'head'` ⇒ 砍进**第一帧**（header 帧都读不出来 ⇒ 无完整帧）。
 *   两种撕裂都只动字节、不改帧划分，故与帧形状两件事互不干扰。
 * @returns {string} 临时文件路径
 */
export function writeSessionFrames(lines, { batch = FRAME_BATCH, torn = false, name = 'session' } = {}) {
  if (torn !== false && torn !== 'tail' && torn !== 'head') {
    throw new Error(`writeSessionFrames: torn 只能是 false / 'tail' / 'head'（实际 ${JSON.stringify(torn)}）`);
  }
  const frames = zstdFramesOf(lines, { batch });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
  const file = path.join(dir, `${name}.jsonl.zstd`);
  const whole = Buffer.concat(frames);
  if (torn === false) {
    fs.writeFileSync(file, whole);
    return file;
  }
  if (torn === 'head') {
    // 砍进第一帧：保留 magic + descriptor，其余丢掉 ⇒ scanZstdFrames 得 0 个完整帧
    fs.writeFileSync(file, whole.subarray(0, 6));
    return file;
  }
  // 'tail'：只砍最后一帧的尾部若干字节，前面完整帧的字节位置原样保留
  let before = 0;
  for (let i = 0; i < frames.length - 1; i++) before += frames[i].length;
  const lastFrameLen = frames[frames.length - 1].length;
  const cut = Math.max(1, Math.min(7, lastFrameLen - 4));
  fs.writeFileSync(file, whole.subarray(0, before + lastFrameLen - cut));
  return file;
}
