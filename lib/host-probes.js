/**
 * dsh-log-contract · lib/host-probes.js —— **行为探针**（漂移检测的正解）
 * （2026-09-14）
 *
 * 为什么需要它：本包"承重墙建错了地方"——**委托宿主运行时函数**的判据基本正确，
 * **作者手写镜像/自建模型**的判据成片出错，而 `hostPackageVersion()`/`hostCapability()`
 * **只打印不门禁**、规则的 `source` 是**不可机读的字符串** ⇒ 本次 5 类失准**没有任何机制能发现**。
 *
 * 本模块的回答：**不靠人重读源码，靠宿主运行时自身当 oracle**。做法是自造**微型合成日志**
 * 喂给宿主导出的 `foldSurface` / `adoptSessionEvent`（可选 `Session.create`），断言"宿主应当
 * 这么判"，再把**本包规则的假设**与宿主实际行为逐条比对：
 *   - 一致 → 该规则组 **VERIFIED**（在**当前宿主**上）；
 *   - 不一致 → 该规则组标 **UNVERIFIED**，结论抬头显式点名，并提示**勿据此跑 `fix --apply`**。
 *
 * 探针只做**只读调用**（不写盘、不联网、不改任何文件）；任何异常都被收敛成"探针失败/跳过"，
 * 不让漂移检测把工具本身弄崩。
 */
import {
  adoptSessionEvent, foldSurface, isSurfaceEligibleType, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session';
import { hostPackageVersion } from './vocab.js';

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
    id: 'p3-system-message-plugin-source',
    title: 'system/message 是 surface 类型且必须 plugin source（kind=user 必须拒）',
    rules: ['E6', 'E9'],
    expect: 'plugin source 通过；user source 被拒',
    run: () => {
      const eligible = isSurfaceEligibleType('system/message') === true;
      const withPlugin = rejects(() => adoptSessionEvent({
        type: 'system/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { turn: 0, step: 0, message: { id: 's0', role: 'system', source: { kind: 'plugin', plugin: 'p' }, content: [] } },
      }));
      const withUser = rejects(() => adoptSessionEvent({
        type: 'system/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { turn: 0, step: 0, message: { id: 's0', role: 'system', source: { kind: 'user' }, content: [] } },
      }));
      return eligible && withPlugin === false && withUser === true;
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
    title: '信封多余键：load 路径(adoptSessionEvent)**容忍**，只在 seed 路径拒（E8 的口径）',
    rules: ['E8'],
    expect: 'adoptSessionEvent 不拒（宿主 load 路径容忍）',
    // 这条探针**修正了一条规则的过度声称**（探针的价值实证）：
    //   · 宿主 `assertSessionEventEnvelope`（dsh-session@0.1.5-rc.1 lib/index.js:849-861）确实拒多余键,
    //     但它的**唯一调用点**是 Session 构造器的 **seed 路径**（:1063-1068）——不是 JSONL load 路径;
    //   · load 路径（`adoptSessionEvent`）实测**容忍**多余键。
    // ⇒ E8 从 error 降为 **warning**、口径限定为"seed/restore 会拒"（原判"写入即拒"是过度声称）。
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
      error = String(err?.message ?? err).slice(0, 200);
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
