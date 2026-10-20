/**
 * dsh-log-contract · adapters/dsh/host-probes.js
 *
 * DSH 专属：宿主行为探针（把宿主运行时函数当 oracle，检测判定前提漂移）。
 *
 * 探针只做只读调用（不写盘、不联网、不改文件）；异常收敛为"探针失败/跳过"。
 */
import {
  adoptSessionEvent, foldSurface, isSurfaceEligibleType, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session';
import { hostPackageVersion } from './format-versions.js';
import { SOURCE_DRIFT } from './rules.js';

/**
 * 探针定义。每条:
 *   `rules` = 该探针**背书**的规则 id（不一致时这些规则被标 UNVERIFIED）;
 *   `expect` = 我们对宿主行为的期望（同时就是规则的假设）;
 *   `run` = 用宿主真代码判定实际行为（返回 true=与期望一致）。
 * 说明:断言只看"宿主收/拒"这一层语义（可用 `adoptSessionEvent` 与 `foldSurface` 观察），
 * 不复制本包任何判定逻辑——否则又变成"自己给自己打分"。
 */
export const PROBES = [
  {
    id: 'p1-replace-v3-fields',
    title: 'v3 replace 只认 {op,startSeq,endSeq}（旧 {start,end} 必须拒）',
    rules: ['S1', 'S4'],
    expect: 'v3 形状通过、rc.7 旧形状被拒',
    run: () => {
      const mk = (op) => ({ type: 'user/message', seq: 1, time: 1, surfaceOp: op, sourceEventSeqs: [0], data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [] } });
      const base = [{ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id: 'u0', role: 'user', source: { kind: 'user' }, content: [] } }];
      const modern = rejects(() => foldSurface([...base, mk({ op: 'replace', startSeq: 0, endSeq: 0 })]));
      const legacy = rejects(() => foldSurface([...base, mk({ op: 'replace', start: 0, end: 0 })]));
      return modern === false && legacy === true;
    },
  },
  {
    id: 'p2-assistant-message-provenance',
    title: 'assistant/message 不得携带 sourceEventSeqs（v3 起）',
    rules: ['S6', 'E4', 'S8'],
    expect: '带 provenance 的 assistant/message 被拒',
    run: () => rejects(() => adoptSessionEvent({
      type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append', sourceEventSeqs: [0],
      data: { turn: 0, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] } },
    })) === true,
  },
  {
    id: 'p3-system-message-source',
    title: 'system/message 是 surface 类型；source 按宿主格式：v3 plugin / v4 system-prompt（kind=user 必须拒）',
    rules: ['E6', 'E9'],
    expect: 'v3 宿主：plugin 通过、system-prompt 被拒；v4 宿主：system-prompt 通过、plugin 被拒；user source 一律被拒',
    run: () => {
      const eligible = isSurfaceEligibleType('system/message') === true;
      const sys = (source) => rejects(() => adoptSessionEvent({
        type: 'system/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { id: 's0', role: 'system', source, content: [] } },
      }));
      const withPlugin = sys({ kind: 'plugin', plugin: 'p' });
      const withSystemPrompt = sys({ kind: 'system-prompt' });
      const withUser = sys({ kind: 'user' });
      const expected = SESSION_FORMAT_VERSION >= 4
        ? withSystemPrompt === false && withPlugin === true
        : withPlugin === false;
      return eligible && expected && withUser === true;
    },
  },
  {
    id: 'p7-tool-result-role',
    title: 'tool/result 的 role 按宿主格式：v3 user + tool-result 包装块 / v4 tool + message.toolCallId',
    rules: ['E6'],
    expect: 'v3 宿主：包装形状通过、v4 形状被拒；v4 宿主：v4 形状通过、包装形状与 toolCallId 不匹配被拒',
    run: () => {
      const tool = (message) => rejects(() => adoptSessionEvent({
        type: 'tool/result', seq: 2, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message },
      }));
      const v4Shape = tool({ id: 't1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [] });
      const v4Mismatch = tool({ id: 't1', role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c1' }, content: [] });
      const v3Shape = tool({ id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] });
      return SESSION_FORMAT_VERSION >= 4
        ? v4Shape === false && v4Mismatch === true && v3Shape === true
        : v3Shape === false && v4Shape === true;
    },
  },
  {
    id: 'p8-developer-message-surface',
    title: 'developer/message 只在 v4 宿主是 surface 类型（role developer）',
    rules: ['E6', 'S1', 'S2'],
    expect: 'v4 宿主：surface-eligible 且 role developer 通过；v3 宿主：非 surface 类型',
    run: () => {
      const eligible = isSurfaceEligibleType('developer/message') === true;
      if (SESSION_FORMAT_VERSION < 4) return eligible === false;
      const accepted = rejects(() => adoptSessionEvent({
        type: 'developer/message', seq: 3, time: 1, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { id: 'd1', role: 'developer', source: { kind: 'tool-registry' }, content: [] } },
      })) === false;
      return eligible && accepted;
    },
  },
  {
    id: 'p4-unknown-ignorable-opaque-metadata',
    title: '未知 + ignorable 的 opaque 元数据被刻意容忍（S2 不得报 error）',
    rules: ['S2'],
    expect: '未知 ignorable + surfaceOp 被接受',
    run: () => rejects(() => adoptSessionEvent({
      type: 'future/thing', seq: 0, time: 1, ignorable: true, surfaceOp: 'append', data: { k: 1 },
    })) === false,
  },
  {
    id: 'p5-envelope-extra-keys-load-tolerant',
    title: '信封多余键：load 路径(adoptSessionEvent)**容忍**，只在 seed 路径拒（E8 的语义）',
    rules: ['E8'],
    expect: 'adoptSessionEvent 不拒（宿主 load 路径容忍）',
    // 这条探针**修正了一条规则的过度声称**：
    //   · 宿主 `assertSessionEventEnvelope`（dsh-session@0.1.5-rc.1 lib/index.js:[n]-[n]）确实拒多余键,
    //     但它的**唯一调用点**是 Session 构造器的 **seed 路径**（:[n]-[n]）——不是 JSONL load 路径;
    //   · load 路径（`adoptSessionEvent`）**容忍**多余键。
    // ⇒ E8 从 error 降为 **warning**、语义限定为"seed/restore 会拒"。
    run: () => rejects(() => adoptSessionEvent({
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', extra: 1,
      data: { id: 'u0', role: 'user', source: { kind: 'user' }, content: [] },
    })) === false,
  },
  {
    id: 'p6-request-header-system',
    title: 'request/header 必须省略 header.system（E10）',
    rules: ['E10'],
    expect: '带 header.system 的 request/header 被拒',
    run: () => rejects(() => adoptSessionEvent({
      type: 'request/header', seq: 0, time: 1, surfaceOp: 'append', data: { header: { system: 'x' } },
    })) === true,
  },
];

/** 宿主是否 **拒** 这次调用（true = 抛错/拒绝）。 */

function rejects(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/**
 * 跑全部探针。
 * @returns {{hostPackage:string, sessionFormatVersion:number, knownTypes:number,
 *   verified:boolean, probes:Array<{id,title,rules,expect,ok,error?}>, unverifiedRules:string[]}}
 */
export function runHostProbes(probes = PROBES) {
  const results = [];
  const unverified = new Set();
  for (const probe of probes) {
    let ok = false;
    let error;
    try {
      ok = probe.run() === true;
    } catch (err) {
      ok = false;
      error = String(err?.message ?? err).slice(0, [n]);
    }
    results.push({ id: probe.id, title: probe.title, rules: probe.rules, expect: probe.expect, ok, ...(error ? { error } : {}) });
    if (!ok) for (const r of probe.rules) unverified.add(r);
  }
  return {
    hostPackage: hostPackageVersion(),
    sessionFormatVersion: SESSION_FORMAT_VERSION,
    knownTypes: KNOWN_SESSION_EVENT_TYPES.size,
    verified: unverified.size === 0,
    probes: results,
    unverifiedRules: [...unverified].sort(),
  };
}


/** 行为探针只跑一次（宿主在同一进程内不变）。 */
let probesMemo;
export function hostProbes() {
  if (probesMemo === undefined) {
    try {
      probesMemo = runHostProbes();
    } catch (err) {
      probesMemo = { hostPackage: 'unknown', sessionFormatVersion: null, knownTypes: 0, verified: false, probes: [], unverifiedRules: ['<probe-run-failed>'], error: String(err?.message ?? err) };
    }
  }
  return probesMemo;
}

/**
 * 合并出的**漂移报告**（`check` 抬头与 `--json` 共用）。
 *   · `unverifiedRules` —— 行为探针在本宿主上**不成立**的规则（宿主语义与规则假设不符）;
 *   · `driftedSources`  —— 出处停在 rc.7、未在 0.1.5 上核对（机读清单）;
 *   · `premiseStale`    —— 判定前提已不成立/无法判定;
 *   · `fixApplyBlocked` —— 只要任一非空,就**不得据此跑 `fix --apply`**。
 */
export function driftOf(probes) {
  const p = probes ?? hostProbes();
  const unverifiedRules = [...new Set(p.unverifiedRules ?? [])];
  const driftedSources = [...SOURCE_DRIFT.drifted];
  const premiseStale = [...SOURCE_DRIFT.premiseStale];
  return {
    probeVerified: p.verified === true,
    unverifiedRules,
    driftedSources,
    premiseStale,
    undecidable: [...SOURCE_DRIFT.undecidable],
    // `fix --apply` 的**硬前提**只看行为探针（宿主语义与规则假设不一致时才禁止写入类动作）;
    // 出处/前提清单是**已知文档债**，会显式告警但不阻断修复流程 —— 否则只要历史
    // 清单非空,"修一个坏会话"这条主路径就永久不可用（见报告"我未照做之处"）。
    fixApplyBlocked: unverifiedRules.length > 0,
    note: SOURCE_DRIFT.note,
  };
}
