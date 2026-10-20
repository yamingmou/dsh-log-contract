/**
 * dsh-log-contract · adapters/dsh/vocab.js
 *
 * DSH 专属：词表与形状常量（事件类型表、可见面类型表、存储行类型、标记前缀、
 * 信封键集、可忽略消费者白名单、归档指针字段名），以及按文件版本选词表的路由。
 *
 * 契约层不持有任何具体词表：需要判定「种类是否已知」时由本适配器提供词表与白名单。
 * 版本路由与词表数据由 format-versions 适配器提供。
 */



// ── 归档指针字段名（结构化指针语义）────────────────────────────────────────
/** 结构化指针字段（只认这些；自由文本一律不碰）。 */
export const ARCHIVE_POINTER_FIELDS = Object.freeze(['archiveRef', 'archive']);

/** `data.externalized` 下认的键（等价指针字段）。 */
export const EXTERNALIZED_POINTER_FIELDS = Object.freeze(['archiveRef', 'archive']);

export const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
/** v3 新增 `system/message`（官方 `SURFACE_EVENT_TYPES`，0.1.5 `lib/index.js:[n]-[n]`）。 */
export const MODERN_SURFACE_TYPES = new Set([...SURFACE_TYPES, 'system/message']);
/** v4 新增 `developer/message`（官方 `SURFACE_EVENT_TYPES`，dsh-session@0.2.0-rc.2 `src/surface.ts:50-56`）。 */
export const V4_SURFACE_TYPES = new Set([...MODERN_SURFACE_TYPES, 'developer/message']);
export const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

/** 当前文件版本适用的 surface 候选类型集（v3 起含 system/message，v4 起含 developer/message）。version = 被检文件版本。 */
export function currentSurfaceTypes(version) {
  if (version >= 4) return V4_SURFACE_TYPES;
  return version >= 3 ? MODERN_SURFACE_TYPES : SURFACE_TYPES;
}
export const MARKER_PREFIXES = ['retrace', 'message-editor'];


/** 宿主信封键白名单（assertSessionEventEnvelope，dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]）。 */
export const ENVELOPE_ALLOWED_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable']);


// ── G4 · 未知历史事件声明式可忽略 + 白名单 ────────────────────────────────

/** 默认可忽略消费者白名单（与 E7 的已知插件前缀对齐；可被 opts/env 注入扩展）。 */
export const DEFAULT_IGNORABLE_WHITELIST = Object.freeze(['retrace/', 'message-editor/']);

/**
 * 解析注入的白名单：数组，元素为精确 type 或以 `/` 结尾的前缀。
 * @param {string[]|undefined} extra
 * @returns {readonly string[]}
 */
export function resolveIgnorableWhitelist(extra) {
  if (!Array.isArray(extra) || extra.length === 0) return DEFAULT_IGNORABLE_WHITELIST;
  return Object.freeze([...DEFAULT_IGNORABLE_WHITELIST, ...extra.filter((x) => typeof x === 'string' && x !== '')]);
}

/** 未知 type 是否已被登记为"可忽略消费者"。 */
export function isIgnorableRegistered(type, whitelist = DEFAULT_IGNORABLE_WHITELIST) {
  if (typeof type !== 'string' || type === '') return false;
  for (const entry of whitelist ?? []) {
    if (typeof entry !== 'string' || entry === '') continue;
    if (entry.endsWith('/')) {
      if (type.startsWith(entry)) return true;
    } else if (type === entry) {
      return true;
    }
  }
  return false;
}
