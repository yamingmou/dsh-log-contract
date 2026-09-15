/**
 * dsh-log-contract · lib/prewrite.js
 *
 * ★ 写前校验（pre-write validation）——本工具的第一公民。
 *
 * 复盘事故（2026-08-25）第 1 次尝试失败就是"违约写入没被拦"：surface-replace
 * 的 `sourceEventSeqs` 被清空后写入，会话加载直接抛
 * `SessionPersistenceCorruptionError`。如果写入前先校验，会话根本不会被改坏。
 *
 * 本模块把"三层契约"（持久化 / 客户端引擎 / 插件语义）固化为可执行检查：
 * - `createPreWriter({ events }).validateAppend(candidate)` —— 追加写入前校验：
 *   拟写事件在进入日志之前，先与当前日志的折叠状态比对（官方 append 的
 *   SurfaceManager.validateNext 同思路：validate first, commit later）。
 * - `createPreWriter({ events }).validateEdit(editedEvents)` —— 帧级手术校验：
 *   修改后的完整事件列表端到端重放（安全修复协议第 2 步"改后确认"）。
 *
 * 所有判定复用 `lib/checks.js`（与离线体检同一套逻辑），
 * 保证"体检看到的问题 = 写入前拦下的问题"。
 */
import { envelopeViolations, engineViolations, finalFold, isSafeInt, nullTurnStepViolations, pluginViolations, replaySurface, stepKeyViolations, tokenMeterViolations, turnEndReasonViolations, violation, wireViolations } from './checks.js';
import { resolveFormatVersion, LEGACY_FORMAT_MAX_VERSION } from './vocab.js';
import { normalizeEventSeqRanges } from './compat.js';

/**
 * retrace 历史 marker 的 id 前缀（旧载体:`assistant/message` replace + `data.editor`）。
 * 与 retrace 侧 `MARKER_ID_PREFIX`（`retrace`/`message-editor`——后者是插件改名前的旧前缀）对齐。
 */
const LEGACY_MARKER_ID_PREFIXES = ['retrace', 'message-editor'];

/**
 * **可识别的历史 retrace 载体**（2026-09-14 实测:白名单收窄）。
 *
 * 旧实现只判"任意 `data.editor` 存在" ⇒ **任何**写 `assistant/message` replace + `data.editor`
 * 的第三方插件都能领 T1 豁免（实测判定:"设计粗糙的豁口"）。收窄为四条同时成立:
 *   ① 类型/操作:`assistant/message` + replace;
 *   ② 载体标记:`data.editor !== undefined`;
 *   ③ **身份**:`data.message.id` 带 retrace 历史 marker 前缀（`retrace-*` / `message-editor-*`）;
 *   ④ **形状**:`editor.targetSeq === (op.start ?? op.startSeq)`（retrace 自己的写前断言钉住的形状）。
 * 任一不满足 → 不是可识别的 retrace 历史 marker,不降级（保持 error）。
 *
 * @returns {{prefix:string,id:string,targetSeq:number,seq:unknown}|null}
 */
export function legacyMarkerKindOf(event) {
  if (!event || event.type !== 'assistant/message') return null;
  const op = event.surfaceOp;
  if (!op || typeof op !== 'object' || op.op !== 'replace') return null;
  const editor = event.data?.editor;
  if (editor === undefined || editor === null || typeof editor !== 'object') return null;
  const id = event.data?.message?.id;
  if (typeof id !== 'string') return null;
  const prefix = LEGACY_MARKER_ID_PREFIXES.find((p) => id.startsWith(`${p}-`));
  if (!prefix) return null;
  const start = op.start ?? op.startSeq;
  if (editor.targetSeq !== start) return null;
  return { prefix, id, targetSeq: editor.targetSeq, seq: event.seq };
}

/** 把一个"拟写事件"规整为带 seq 的事件；seq 未携带时按追加位置赋值。 */
function normalizeCandidate(candidate, nextSeq) {
  return candidate.seq === undefined ? { ...candidate, seq: nextSeq } : candidate;
}

/**
 * 基于当前日志事件列表建立写前校验器。
 *
 * **格式版本（C2）**：`formatVersion` > `header.version` > 事件形状推断 > 0，在**本次
 * `createPreWriter` 调用内固定**并显式传给每条按版本择路的判定。**不再读写模块级全局**
 * `fileVersion`——旧实现下同一进程"先 validate(v3) 再 prewrite(v0)"会把同一份合法 v0 输入
 * 的结论翻成 S4+S8（实测复现）。下游 `dsh-retrace` 正是只传 `events` 直接调用
 * （`lib/prewrite-guard.js:166`），所以缺省时必须能自行推断，不能把 v3 输入按 0 处理
 * （否则首次调用即 10 条 E3/S2/S8 误报）。
 *
 * @param {{ events: Array<object>, baseSeq?: number, formatVersion?: number, header?: object|null }} input
 *   当前日志的已解码事件（按日志顺序；无 seq 字段的事件按位置补 seq，用于窗口校验）。
 *   `formatVersion`/`header` 二者其一优先决定被检文件的格式版本。
 * @returns {{
 *   events: Array, nextSeq: number, formatVersion: number,
 *   validateAppend(candidate, opts?): { ok, violations, stateAfter },
 *   validateEdit(editedEvents, opts?): { ok, violations, stateAfter },
 * }}
 */
export function createPreWriter(input = {}) {
  const { baseSeq = 0, header = null } = input;
  // C1：v3 storage-form 区间编码 → 内存稠密序列（与 log-reader 同一归一，覆盖"直接传 events"入口）
  let events = (input.events ?? []).map(normalizeEventSeqRanges);
  // C2：版本显式解析并固定在本次调用内（不读模块级全局）
  const formatVersion = resolveFormatVersion({ formatVersion: input.formatVersion, header, events });
  // 窗口校验支持"无 seq 的原始事件列表"：按位置补齐 seq 与 time。
  let nextSeq = baseSeq;
  events = events.map((e) => {
    const normalized = e.seq === undefined ? { ...e, seq: nextSeq } : e;
    nextSeq = Math.max(nextSeq, normalized.seq + 1);
    return normalized;
  });

  const runChecks = (candidateEvents, tailHint) => {
    const violations = [];
    // E2 —— 全列表 seq 严格连续（含拟写事件）；tailHint 时给 append-only 语境
    let expected = baseSeq;
    for (let i = 0; i < candidateEvents.length; i++) {
      const event = candidateEvents[i];
      if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0) {
        if (event.seq !== expected) {
          const kind = event.seq < expected ? '倒退（backward）' : '缺口（gap）';
          const tail = tailHint !== undefined && i === candidateEvents.length - 1 ? ' —— 只能追加到日志尾部（append-only，N6）' : '';
          violations.push(violation('E2', { seq: event.seq, eventType: event.type }, `seq ${event.seq} 不连续：${kind}，期望 ${expected}${tail}`));
          expected = event.seq + 1;
        } else {
          expected = event.seq + 1;
        }
      }
    }
    // E1/E3/E4/E5/E6 + M1 + P1/P2 —— 逐事件
    for (const event of candidateEvents) {
      const loc = { seq: event.seq, lineNo: null, eventType: event.type };
      violations.push(...envelopeViolations(event, loc, formatVersion));
      violations.push(...engineViolations(event, loc));
      violations.push(...pluginViolations(event, loc));
    }
    // S1–S7 —— 与官方同语义的增量重放（含拟写事件）
    const replay = replaySurface(candidateEvents.map((event) => ({ event })), formatVersion);
    violations.push(...replay.violations);
    // S8 —— fold 终验（按当前文件版本选：v3 官方 foldSurface / v0–v2 本地 legacyFoldSurface）
    const folded = finalFold(candidateEvents, formatVersion);
    if (folded.error) {
      violations.push(violation('S8', { lineNo: null }, `foldSurface 重放失败（按文件版本选：v3 官方 / v0–v2 本地等价）：${folded.error.message} —— 会话加载会被拒（SessionPersistenceCorruptionError）`));
    }
    // W1/W2 —— wire 流配对（2026-09-09 V3 验证补：离线 check 有、写前原漏——悬空 tool
    // 编辑必须写前拦，否则违约写入先落盘、体检才报 = 晚一步）
    violations.push(...wireViolations(candidateEvents.map((event) => ({ event })), formatVersion));
    // T1 —— token-meter 配对（事故根因 3 固化）。写前校验只判定**拟写事件自身**
    // 的 step 配对：retrace 的 turn-null 编辑/撤回 marker 必然命中（空
    // assistant/message replace 无 step 可配对），但编辑功能必须可用——白名单
    // 降级为 warning（已知设计债，压缩前需 doctor 清理）；非 marker 的
    // assistant/message 配对失败保持 error。历史已有事件的 T1 归属离线体检
    // （check），不在这里重复拦截（否则历史 marker 会让后续编辑全部被拒）。
    const lastCandidate = candidateEvents[candidateEvents.length - 1];
    const legacyKind = legacyMarkerKindOf(lastCandidate);
    // 版本门(2026-09-14):降级**只对 ≤v2 文件**。
    // 依据:新载体(`user/message` + `data.id`,retrace 0.4.26)根本不带 `data.editor`,在 v3 上
    // 降级**救不回任何写入**(v3 禁 assistant/message 带 provenance ⇒ S8 兜住) —— 留在 v3 上
    // 只会掩盖 T1 的真实原因。v0/v1/v2 才是有价值的作用域(回放/重写历史形态 marker)。
    const legacyDowngradeAllowed = formatVersion <= LEGACY_FORMAT_MAX_VERSION;
    for (const t1 of tokenMeterViolations(candidateEvents.map((event) => ({ event })))) {
      if (t1.id !== 'T1' || t1.seq !== lastCandidate?.seq) continue;
      if (legacyKind && legacyDowngradeAllowed) {
        // 降级**可见**:违规里带 markerKind/id/targetSeq,并由结果字段 `legacyMarkerDebt`
        // 显式带出;入口(CLI)打印"压缩前需一次性清理",不再"记了没人看"。
        violations.push({
          ...t1,
          severity: 'warning',
          markerKind: legacyKind.prefix,
          markerId: legacyKind.id,
          targetSeq: legacyKind.targetSeq,
          message: `${t1.message}（已知历史 retrace marker 设计债：${legacyKind.prefix} 载体 id=${legacyKind.id} targetSeq=${legacyKind.targetSeq}；`
            + `仅对 v≤${LEGACY_FORMAT_MAX_VERSION} 文件降级。压缩前需一次性清理：fix --neutralize-legacy-markers）`,
        });
      } else {
        violations.push(t1);
      }
    }
    // T3/T4 —— 渲染层（2026-09-02 渲染层白屏事故）。**error 级拒绝**：
    // - T4：拟写事件（step/start|step/end|assistant/message）turn 缺失 → 客户端
    //   渲染死循环白屏（D8），写入前直接拦下（防再犯：任何写 turn:null 的 marker）；
    // - T3：拟写事件引入 step 节点 key 冲突（同 turn 同 step 的 step/start 重复）→
    //   同样拒绝。只判拟写事件自身（历史冲突归属离线 check 的 T3/T4 扫描）。
    for (const v of nullTurnStepViolations(candidateEvents.map((event) => ({ event })))) {
      if (v.seq !== lastCandidate?.seq) continue;
      violations.push(v);
    }
    for (const v of stepKeyViolations(candidateEvents.map((event) => ({ event })))) {
      if (v.seq !== lastCandidate?.seq) continue;
      violations.push(v);
    }
    // T5 —— 拟写 turn/end 缺 reason.kind → error 拒绝（malformed turn/end 防再犯）
    for (const v of turnEndReasonViolations(candidateEvents.map((event) => ({ event })))) {
      if (v.seq !== lastCandidate?.seq) continue;
      violations.push(v);
    }
    const bySeverity = { error: 0, warning: 0, info: 0 };
    for (const v of violations) bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
    // 「让降级可见」:把"本次写入沿用了历史 marker 形态(债)"作为**结构化字段**带出,
    // 入口据此打印"压缩前需一次性清理"。降级不再只是 violations 里的一句 warning。
    const legacyDebt = legacyKind && legacyDowngradeAllowed && bySeverity.error === 0
      ? { kind: legacyKind.prefix, id: legacyKind.id, targetSeq: legacyKind.targetSeq, seq: lastCandidate?.seq ?? null, formatVersion }
      : null;
    return {
      ok: bySeverity.error === 0,
      violations,
      bySeverity,
      legacyMarkerDebt: legacyDebt,
      surface: folded.surface ?? { nodes: replay.nodes, replacements: [] },
      nextSeq: candidateEvents.length ? candidateEvents[candidateEvents.length - 1].seq + 1 : baseSeq,
    };
  };

  return {
    events,
    formatVersion,
    get nextSeq() {
      return nextSeq;
    },

    /**
     * 追加写入前校验：candidate 将以 nextSeq 进入日志。
     * candidate 可携带 seq（必须等于 nextSeq）或不携带（自动赋 nextSeq）。
     */
    validateAppend(candidate, opts = {}) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        return {
          ok: false,
          violations: [violation('E1', {}, '拟写事件必须是普通对象（会话事件信封）')],
          bySeverity: { error: 1, warning: 0, info: 0 },
          surface: null,
          nextSeq,
        };
      }
      const normalized = normalizeEventSeqRanges(normalizeCandidate(candidate, nextSeq));
      const after = [...events, normalized];
      const result = runChecks(after, nextSeq);      result.stateAfter = {
        events: after,
        nextSeq: result.nextSeq,
        surfaceNodes: result.surface?.nodes ?? [],
      };
      return result;
    },

    /**
     * 帧级手术校验：editedEvents 是"写入后将存在的完整事件列表"。
     * 用于安全修复协议第 2 步（改后确认）：必须与"改前基线
     * （validateSessionLog 通过）"双绿才允许落盘。
     */
    validateEdit(editedEvents) {
      if (!Array.isArray(editedEvents)) {
        return {
          ok: false,
          violations: [violation('E1', {}, 'editedEvents 必须是事件数组')],
          bySeverity: { error: 1, warning: 0, info: 0 },
          surface: null,
          nextSeq,
        };
      }
      const edited = editedEvents.map(normalizeEventSeqRanges);
      const result = runChecks(edited, undefined);
      result.stateAfter = {
        events: edited,
        nextSeq: result.nextSeq,
        surfaceNodes: result.surface?.nodes ?? [],
      };
      return result;
    },
  };
}

/**
 * 一站式便利：加载会话日志 → 建立写前校验器。
 * @param {import('./log-reader.js').loadSessionLog} log `loadSessionLog()` 结果
 */
export function preWriterFromLog(log) {
  const events = (log.events ?? []).map((e) => e.event);
  return createPreWriter({ events, header: log?.header ?? null });
}
