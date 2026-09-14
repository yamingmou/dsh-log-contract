/**
 * dsh-log-contract · lib/compat.js —— 兼容层（任务 1.3 · 装即坏修复；2026-09-14 语义对齐重写）
 *
 * 背景：本包原先从 `@deepseek-ai/dsh-session` 直接导入 `decodeStorageRecord` 与 `isJsonValue`。
 * 官方 0.1.5 树已**不再从包根导出**这两个符号（0.1.5-rc.1 `lib/index.js` 的 26 个导出里没有它们），
 * 而本包是 plugin 的依赖 ⇒ 升级后"装即坏"（模块加载期报 does not provide an export named ...）。
 *
 * 本文件把这两个符号**本地化**，并把语义从"近似"改为**逐条移植**（原实现是宽松近似：
 * `decodeStorageRecord` 对损坏 chunk 行返回 `[value]` 而非抛错，导致 R2 永不触发；
 * `isJsonValue` 不拒 `-0`、不拒稀疏数组、不查原型——与官方 lossless-JSON 边界不一致）。
 *
 * 移植源（一手，2026-09-14 实测）：
 * - `decodeStorageRecord` / `validateRow` / `expandRow`：
 *   `@deepseek-ai/dsh-session@0.1.0-rc.7` `lib/index.js:922-1035`（该版本是最后一个把
 *   `decodeStorageRecord` 从包根导出的版本；与 App 2.0.9 内置的
 *   `dsh-session/lib/types/chunk-rows.js`（= 0.1.2-rc.1，sha256 前 16 位 `5724c4f798ed07e7`）
 *   校验规则一致）。**fail-loud**：损坏的 chunk 行必须抛错——它是损坏存储，静默当普通事件
 *   处理会丢掉整段 run。
 * - `isJsonValue`：`@deepseek-ai/dsh-session@0.1.0-rc.7` `lib/index.js:74-205`
 *   `walkJsonValue(value, false)`（lossless-JSON 边界：拒绝稀疏数组、非有限数、`-0`、
 *   循环引用、非普通原型、symbol/不可枚举键）。
 *
 * 仍从官方导入的符号（升级后保留）：`foldSurface` / `isSurfaceEligibleType` /
 * `KNOWN_SESSION_EVENT_TYPES`（见 `./vocab.js` / `./checks.js`）。
 */

/** Whether a value is a JSON-visible record (object, not null, not array)（rc.7 `isRecord`）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** Exact-key check: `value` has every key in `keys` and nothing else（rc.7 `hasExactKeys`）。 */
function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

//#region isJsonValue —— rc.7 walkJsonValue 的移植（不含 detach）
/** Whether a value is an object whose prototype is an intrinsic (plain) object prototype, across realms. */
function isIntrinsicObjectPrototype(prototype) {
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype));
}
/** Whether an array is a plain array from any JavaScript realm (rejects subclasses/exotics). */
function hasPlainArrayPrototype(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Array.prototype) return true;
  return typeof prototype === 'object' && prototype !== null && Object.getPrototypeOf(prototype) === Object.prototype && Object.getPrototypeOf(Object.getPrototypeOf(prototype)) === null;
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined;
  return keys;
}

/**
 * Validate lossless JSON iteratively（rc.7 `walkJsonValue(value, false)`）。
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
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) return false;
      tasks.push({ kind: 'object-property', source: current, key });
    }
  }
  return true;
}
//#endregion

//#region decodeStorageRecord —— rc.7 validateRow/expandRow 的移植
/** Throw the uniform malformed-row diagnostic（rc.7 `malformed`）。 */
function malformed(tag, why) {
  throw new Error(`malformed ${tag} storage row: ${why}`);
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload（rc.7 `validateRunData`）。 */
function validateRunData(tag, data, payloadKey) {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') malformed(tag, 'turn/step/index must be numbers');
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== 'string')) malformed(tag, `${payloadKey} must be a non-empty string array`);
  const dt = data.dt;
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap))) malformed(tag, 'dt must be an array of safe integers');
  if (dt.length !== payload.length - 1) malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`);
  return payload;
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation（rc.7 `validateRow`）。 */
function validateRow(value, tag) {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) malformed(tag, 'envelope must be exactly {type, seq0, time0, data}');
  if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0) malformed(tag, 'seq0 must be a non-negative safe integer');
  if (!Number.isSafeInteger(value.time0)) malformed(tag, 'time0 must be a safe integer');
  const data = value.data;
  if (!isRecord(data)) malformed(tag, 'data must be an object');
  let payload;
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']);
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}');
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) malformed(tag, 'id (and name when present) must be strings');
    payload = validateRunData(tag, data, 'args');
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) malformed(tag, 'data must be exactly {turn, step, index, dt, texts}');
    payload = validateRunData(tag, data, 'texts');
  }
  if (!Number.isSafeInteger(value.seq0 + payload.length - 1)) malformed(tag, 'member seqs must stay safe integers');
  let time = value.time0;
  for (const gap of data.dt) {
    time += gap;
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers');
  }
  return value;
}

/** Expand a validated row back into its exact original events, in order（rc.7 `expandRow`）。 */
function expandRow(row) {
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
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...Object.hasOwn(row.data, 'name') ? { name: row.data.name } : {},
          argumentsDelta: members[k],
        };
        break;
      /* v8 ignore next 4 -- validateRow only returns the three row tags */
      default:
        throw new Error(`chunk-rows received unsupported row ${String(row)}`);
    }
    events.push({ type: 'assistant/chunk', seq: row.seq0 + k, time, data: { turn: row.data.turn, step: row.data.step, chunk } });
  }
  return events;
}

/**
 * 存储行解码：chunk 行校验后展开为完整事件序列，其他行原样返回（rc.7 `decodeStorageRecord`）。
 * 损坏的 chunk 行**抛错**（fail-loud）——调用方（log-reader）据此落 `row.error` → R2。
 * @param {unknown} value 已 JSON.parse 的一行
 * @returns {unknown[]} 事件数组
 */
export function decodeStorageRecord(value) {
  if (!isRecord(value)) return [value];
  const tag = value.type;
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [value];
  return expandRow(validateRow(value, tag));
}
//#endregion

//#region decodeSeqRanges —— v3 storage-form 区间编码解码（0.1.5 `lib/types/seq-ranges.js` 逐条移植）
// 为什么本地化：`decodeSeqRanges` 只在 0.1.5+ 从包根导出；`0.1.0-rc.7` 实测 `undefined`
// （见 vocab.js 的双宿主声明）。本包 peer 允许两个版本 ⇒ 必须在两种宿主上都能解码。
//
// 语义（官方 `seq-ranges.js:34-73`）：`sourceEventSeqs` 的 JSON 存储形态是"数字 + 闭区间对"
// 混合数组，例 `[3, [174,176], 180, …]` ⇒ 内存形态 `[3,174,175,176,180,…]`。
// v3 持久化层对连续段用区间对压缩（App 2.0.9 真实 v3 会话实测：1 个 `user/message` replace
// 的 `sourceEventSeqs` 2251 个存储项展开为 2259 个 seq）。**不解码 = 拿物理未展开的序列
// 喂 S5/S6 与官方 foldSurface ⇒ 真实健康会话被误判 S5/S6/S8 + `--resume` broken。**

/** 非负安全整数（rc.7/0.1.5 `assertSeq`）。 */
function assertSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('sourceEventSeqs must contain non-negative safe integers');
}
/** 带 Session 序号 brand 的断言（官方 `SessionSeq`；额外拒绝 `-0`）。 */
function sessionSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/**
 * 展开 JSON 存储形态的 `sourceEventSeqs`（官方 `decodeSeqRanges` 逐条移植）。
 * 任一形态非法即抛 `TypeError`（fail-loud：调用方据此报 S6/E4，不静默当稠密序列）。
 * @param {unknown} value 已 JSON.parse 的 `sourceEventSeqs`
 * @param {number} [maxEntries] 该事件允许的最大成员数
 * @returns {number[]} 内存稠密序列
 */
export function decodeSeqRanges(value, maxEntries = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value)) throw new TypeError('sourceEventSeqs must be an array');
  const decoded = [];
  let hasRange = false;
  for (const entry of value) {
    if (typeof entry === 'number') {
      assertSeq(entry);
      if (decoded.length >= maxEntries) throw new TypeError('sourceEventSeqs exceeds its event sequence');
      decoded.push(sessionSeq(entry));
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('sourceEventSeqs range entries must be [start, end] pairs');
    }
    const start = entry[0];
    const end = entry[1];
    assertSeq(start);
    assertSeq(end);
    if (end < start) throw new TypeError('sourceEventSeqs ranges require start <= end');
    if (end - start + 1 > maxEntries - decoded.length) {
      throw new TypeError('sourceEventSeqs range exceeds its event sequence');
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(sessionSeq(seq));
    hasRange = true;
  }
  if (hasRange && !decoded.every((v, i) => i === 0 || v > decoded[i - 1])) {
    throw new TypeError('sourceEventSeqs ranges must be strictly increasing');
  }
  return decoded;
}

/**
 * 把一个已解码事件的 storage-form `sourceEventSeqs` 归一成内存稠密序列。
 * - 无 `sourceEventSeqs` / 非对象 → 原样返回（同一引用）；
 * - 解码成功 → 返回**新对象**（不修改入参；调用方须使用返回值）；
 * - 解码失败 → 原样返回，保留存储形态交由 S6/E4 报违规（读取层不崩、不吞错）。
 */
export function normalizeEventSeqRanges(event) {
  if (!isRecord(event) || event.sourceEventSeqs === undefined) return event;
  let expanded;
  try {
    expanded = decodeSeqRanges(event.sourceEventSeqs);
  } catch {
    return event;
  }
  return { ...event, sourceEventSeqs: expanded };
}
//#endregion
