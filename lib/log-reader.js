/**
 * dsh-log-contract · lib/log-reader.js
 *
 * 会话日志读取层：zstd 帧扫描 → 解压 → 逐行 JSON.parse → 官方
 * `decodeStorageRecord` 展开（chunk 行展开 / 损坏行报错）。
 *
 * 契约来源：
 * - 帧扫描/撕裂尾帧判定：按 zstd 规范逐帧扫（magic 0xFD2FB528、descriptor、block 头）。
 * - 行解码：本地兼容层 `./compat.js` 的 `decodeStorageRecord`（原官方导出于 0.1.5 移除）
 *   （lib/index.js:1029，validateRow :922 / expandRow :973）。
 * - 损坏语义：chunk 行损坏 = 整段 run 丢失且加载失败（dsh-session
 *   lib/index.js:1022-1024 注释明示 fail-loud，无跳过逃生舱）。
 */
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { decodeStorageRecord, normalizeEventSeqRanges } from './compat.js';

const ZSTD_MAGIC = 0xfd2fb528;

/** 扫描 zstd 帧边界；返回 [start, end] 列表与是否出现撕裂尾帧。 */
export function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  let torn = false;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      torn = true;
      break;
    }
    offset += 4;
    if (offset === buf.length) {
      torn = true;
      break;
    }
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      // 保留位被置位：非法帧头
      return { frames, torn: true, reason: 'reserved-bit' };
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictFlag = descriptor & 3;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const hdrExtra = (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
    if (buf.length - offset < hdrExtra) {
      torn = true;
      break;
    }
    offset += hdrExtra;
    let lastBlock = false;
    while (!lastBlock) {
      if (buf.length - offset < 3) {
        torn = true;
        break;
      }
      const bh = buf.readUInt32LE(offset);
      offset += 3;
      lastBlock = (bh & 1) !== 0;
      offset += (bh >>> 3) & 0x1fffff;
    }
    if (torn) break;
    if (offset > buf.length) {
      // 块内容越过文件末尾：最后一帧被截断，不能算完整帧
      torn = true;
      break;
    }
    if (checksum) offset += 4;
    frames.push([start, offset]);
  }
  return { frames, torn, reason: torn ? 'incomplete-tail' : undefined };
}

/** 把 zstd 多帧拼成完整明文；任一帧解码失败即抛错（N5 单帧全损语义）。 */
export function decompressZstd(buf, { allowTorn = true } = {}) {
  const { frames, torn } = scanZstdFrames(buf);
  // ── 2026-09-14 实测:这里的 Z2 是误报 ───────────────────────────────────
  // 撕裂尾帧**不是**损坏:宿主 `dsh-session-persistence-jsonl@0.1.5-rc.1`
  //   · `readZstdPrefix`（lib/index.js:2791-2849）——"Decode complete frames and retain
  //     complete JSONL records from a torn final frame",恢复并返回 `tornTruncateTo`(:2847);
  //   · 下次写入 `:226-228` 调 `truncateTornTail` 自动截断。
  // 旧实现（本函数）对 torn 直接抛错 ⇒ `loadSessionLog` 返回 header=null/events=[]
  // ⇒ `validate.js` 级联出 Z1(warning)+Z2(error)+H1(error)、verdict=broken —— 把宿主
  // **本来能修**的"边写边读"健康态报成"会话坏了"。现在对齐宿主:解出全部**完整帧**,
  // 尾帧未写完的部分丢弃,由调用方用 `frameInfo.torn` 报 Z1(warning)。
  // `frames.length === 0`(连一个完整帧都没有,例如头帧就断了)**仍然报错** —— 宿主
  // `readZstdPrefix:2793` 对这种情况同样抛 "empty or header-less Zstandard session log"。
  if (frames.length === 0) throw new Error('空文件 / 无完整 zstd 帧（incomplete or header-less session log）');
  if (torn && !allowTorn) throw new Error('zstd 尾帧撕裂（incomplete tail frame）——strict 模式（allowTorn:false）');
  // 逐帧解码后一次性 Buffer.concat：避免每帧一次 concat 的 O(n²) 拷贝
  const parts = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const [s, e] = frames[i];
    try {
      parts[i] = zstdDecompressSync(buf.subarray(s, e));
    } catch (err) {
      // 完整帧解码失败才是真损坏(Z2):磁盘 bitrot / 传输截断 / 保留位非法
      throw new Error(`zstd 帧解码失败 [${s},${e})：${err.message}`);
    }
  }
  return Buffer.concat(parts);
}

/**
 * 读取文件尾部最后一条事件的 seq（看门狗 R1 用，只解最后一帧，O(帧数) 内）。
 *
 * 语义：zstd 多帧文件取最后一个**完整**帧解压（撕裂尾帧跳过——可能正在写入），
 * 从帧内末尾向前找第一条合法 JSON 行，用 `decodeStorageRecord` 展开取末事件 seq
 * （chunk 行展开后末成员即该 run 的最新 seq）。明文文件直接扫末尾。
 *
 * @param {string} path 日志文件路径
 * @returns {number|null} 尾部 seq；读取失败/无可解析行返回 null（调用方降级不检查）。
 */
export function tailSeq(path) {
  let buf;
  try {
    buf = fs.readFileSync(path);
  } catch {
    return null;
  }
  const isZstd = buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC;
  let plain;
  if (isZstd) {
    const { frames } = scanZstdFrames(buf);
    if (frames.length === 0) return null;
    const [s, e] = frames[frames.length - 1];
    try {
      plain = zstdDecompressSync(buf.subarray(s, e));
    } catch {
      return null;
    }
  } else {
    plain = buf;
  }
  const lines = plain.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // 帧边界产物（空行）跳过
    try {
      const decoded = decodeStorageRecord(JSON.parse(line));
      if (decoded.length > 0) return decoded[decoded.length - 1].seq;
    } catch { /* 损坏行/不可解析：继续向前找 */ }
  }
  return null;
}

/**
 * 读取并解码一个会话日志文件（.jsonl / .jsonl.zstd / 任意带 zstd 魔数的文件）。
 *
 * @param {string} path 日志文件路径
 * @returns {{
 *   header: object|null, headerLine: number|null,
 *   rows: Array<{lineNo:number, value:unknown, decoded:Array|null, error:Error|null}>,
 *   events: Array<{seq:number, event:object, lineNo:number}>,
 *   frameInfo: {frames:number, torn:boolean, compressedBytes:number, plaintextBytes:number},
 * }}
 */
export function loadSessionLog(path) {
  const buf = fs.readFileSync(path);
  const isZstd = buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC;

  let plain;
  let frameInfo;
  let loadError = null;
  if (isZstd) {
    try {
      plain = decompressZstd(buf);
    } catch (err) {
      loadError = err;
      plain = Buffer.alloc(0);
    }
    const { frames, torn } = scanZstdFrames(buf);
    // 帧形状事实（Z4/Z5，2026-09-16 真机事故）：官方写盘形状 = **header 独占第一帧** +
    // 事件逐帧追加；读取端有硬断言 `assertZstdHeaderFrame`（首帧必须**恰好一行**）。
    // 这里把该事实带出来给 validate 判：整文件被重压成单帧时，首帧装的是全部行 ⇒ 宿主必抛，
    // 而抛点在 `listArtifacts` **遍历全库**、无 per-session 容错 ⇒ 整个客户端起不来。
    let firstFrameOneLine = true, firstFrameLines = 1;
    try {
      const [s0, e0] = frames[0];
      const first = zstdDecompressSync(buf.subarray(s0, e0)).toString('utf8');
      const nl = first.indexOf('\n');
      firstFrameOneLine = nl === first.length - 1 && first.length > 1;
      firstFrameLines = first.split('\n').filter((x) => x !== '').length;
    } catch { /* 首帧解码失败另有 Z2 报 */ }
    frameInfo = { frames: frames.length, torn, compressedBytes: buf.length, plaintextBytes: plain.length, firstFrameOneLine, firstFrameLines };
  } else {
    plain = buf;
    frameInfo = { frames: 0, torn: false, compressedBytes: 0, plaintextBytes: plain.length };
  }
  if (loadError) {
    return {
      header: null,
      headerLine: 0,
      rows: [],
      events: [],
      frameInfo: { ...frameInfo, error: loadError.message },
    };
  }

  const text = plain.toString('utf8');
  const lines = text.split('\n');

  // 第一行 = header
  const headerLine = 0;
  let header = null;
  const headerRaw = lines[0];
  try {
    header = JSON.parse(headerRaw);
  } catch {
    header = null;
  }

  const rows = [];
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // 帧边界产物（空行）跳过
    const lineNo = i;
    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      rows.push({ lineNo, value: null, decoded: null, error: err });
      continue;
    }
    let decoded;
    try {
      decoded = decodeStorageRecord(value);
    } catch (err) {
      rows.push({ lineNo, value, decoded: null, error: err });
      continue;
    }
    // v3 storage-form `sourceEventSeqs` 区间编码 → 内存稠密序列（C1）。
    // 必须在**读取层唯一入口**做：下游 S5/S6 与官方 foldSurface 都按稠密整数序列判定，
    // 拿到含 `[start,end]` 对的未展开形态会误判真实健康会话（S5/S6/S8 + --resume broken）。
    const normalized = decoded.map(normalizeEventSeqRanges);
    for (const event of normalized) {
      events.push({ seq: event.seq, event, lineNo });
    }
    rows.push({ lineNo, value, decoded: normalized, error: null });
  }

  // 按 seq 排序（文件顺序即日志顺序，此处防御性排序以便下游契约检查）
  events.sort((a, b) => a.seq - b.seq);

  return { header, headerLine, rows, events, frameInfo };
}

/**
 * 轻量读取会话文件 header（只解第一帧，不读全文件帧）。
 *
 * 帧布局：帧 1 = header 行（单行 JSON，~几百字节），帧 2+ = 事件流。
 * 短码推导（工作区 createdAt 序号）需要扫全部会话但只需要 header——
 * 读文件前缀 64KiB 足够覆盖完整帧 1，避免全量读大文件（大会话压缩后可达
 * 数百 MiB）。失败返回 null（调用方降级）。
 *
 * @param {string} path 会话日志文件路径（.jsonl.zstd 或明文 .jsonl）。
 * @returns {object|null} header 对象；无法解析返回 null。
 */
export function readSessionHeader(path) {
  let head;
  try {
    const fd = fs.openSync(path, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n);
  } catch {
    return null;
  }
  if (head.length < 4 || head.readUInt32LE(0) !== ZSTD_MAGIC) {
    // 明文（无 zstd magic）：直接取首行
    try {
      const line = head.toString('utf8').split('\n').find((l) => l.trim().length > 0);
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  }
  const { frames } = scanZstdFrames(head);
  if (frames.length === 0) return null;
  const [s, e] = frames[0];
  let plain;
  try {
    plain = zstdDecompressSync(head.subarray(s, e));
  } catch {
    return null;
  }
  const line = plain.toString('utf8').split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
