/**
 * dsh-log-contract · test/prewrite.test.js
 *
 * ★ 写前校验测试：写入前的三层契约判定（validate first, commit later）。
 * 含复盘事故回归用例：违约写入必须在落盘前被拦下。
 */
import { describe, expect, it } from 'vitest';
import { createPreWriter } from '../lib/prewrite.js';
import { validateSessionLog } from '../lib/validate.js';
import { loadSessionLog } from '../lib/log-reader.js';
import {
  assistantMessage,
  markerEvent,
  turnEnd,
  userMessage,
  validSessionEvents,
  writeSession,
} from './helpers.js';

function ids(result) {
  return result.violations.map((v) => v.id);
}

describe('validateAppend —— 追加写入前校验', () => {
  it('合法追加（不带 seq）→ 通过，nextSeq 推进', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    expect(prewriter.nextSeq).toBe(3);
    const r = prewriter.validateAppend(userMessage({ seq: 3 }));
    expect(r.ok).toBe(true);
    expect(r.stateAfter.nextSeq).toBe(4);
    expect(r.stateAfter.surfaceNodes).toEqual([0, 1, 3]);
  });

  it('合法追加（携带正确 seq）→ 通过', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    expect(prewriter.validateAppend({ ...assistantMessage({ seq: 3, turn: 1, step: 0 }) }).ok).toBe(true);
  });

  it('seq 不匹配期望 → E2 拦截', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const r = prewriter.validateAppend(userMessage({ seq: 9 }));
    expect(r.ok).toBe(false);
    expect(ids(r)).toContain('E2');
  });

  it('★ 事故第 1 轮：marker 空 sourceEventSeqs 的 replace 写入 → S5/S6/S8 拦截', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const badMarker = markerEvent({ seq: 3, start: 0, end: 1, shadowedSeqs: [] });
    const r = prewriter.validateAppend(badMarker);
    expect(r.ok).toBe(false);
    expect(ids(r)).toContain('S5');
    expect(ids(r)).toContain('S8');
  });

  it('★ 事故第 2 轮：turn=null 的 assistant/message 以 append 写入 → M1 拦截', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const bad = assistantMessage({ seq: 3, turn: 1, step: 0 });
    bad.data.turn = null;
    bad.data.step = null;
    const r = prewriter.validateAppend(bad);
    expect(r.ok).toBe(false);
    expect(ids(r)).toContain('M1');
  });

  it('完整覆盖 shadowed 的 marker replace → 通过', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const okMarker = markerEvent({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] });
    const r = prewriter.validateAppend(okMarker);
    expect(r.ok).toBe(true);
  });

  it('replace 目标不在 surface → S4 拦截', () => {
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const r = prewriter.validateAppend(markerEvent({ seq: 3, start: 50, end: 51, shadowedSeqs: [50, 51] }));
    expect(r.ok).toBe(false);
    expect(ids(r)).toContain('S4');
  });
});

describe('validateEdit —— 帧级手术校验（改后确认）', () => {
  it('手术后的完整列表合法 → 通过', () => {
    const edited = [
      userMessage({ seq: 0 }),
      assistantMessage({ seq: 1 }),
      turnEnd({ seq: 2 }),
      markerEvent({ seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] }),
      turnEnd({ seq: 4 }),
    ];
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const r = prewriter.validateEdit(edited);
    expect(r.ok).toBe(true);
  });

  it('手术引入 seq 缺口 → 拦截（E2 + S8）', () => {
    const edited = validSessionEvents().filter((e) => e.seq !== 1);
    const prewriter = createPreWriter({ events: validSessionEvents() });
    const r = prewriter.validateEdit(edited);
    expect(r.ok).toBe(false);
    expect(ids(r)).toContain('E2');
    expect(ids(r)).toContain('S8');
  });

  it('改后确认与离线体检结论一致（双绿才算过）', () => {
    const file = writeSession(validSessionEvents());
    const baseline = validateSessionLog(loadSessionLog(file));
    expect(baseline.ok).toBe(true);
    const prewriter = createPreWriter({ events: validSessionEvents() });
    // 引入事故式违约：空 sourceEventSeqs
    const broken = [
      ...validSessionEvents().slice(0, 2),
      markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [] }),
    ];
    expect(prewriter.validateEdit(broken).ok).toBe(false);
  });
});
