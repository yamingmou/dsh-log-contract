/**
 * test/seq-provenance.test.js —— E11 / E2 负对照套件（0.3.28）
 *
 * 事故形态（真实）两类：
 *   ① 生产者**自行生成 seq**（写侧自造/自增）写入 ⇒ E2/S8 类红；
 *   ② 删除两行**不重编号** ⇒ seq 缺口。
 * E11 把"seq 只能由日志层连续光标分配"钉成写侧硬规则（prewrite 拟写事件携带
 * seq 必须等于 nextSeq，或省略由校验器赋值）；文件侧的自造痕迹由 E2（缺口/倒退）
 * 与 S9（物理序回退）判红。每条 = 违规样本判红 + 合规样本绿。
 */
import { describe, expect, it } from 'vitest';
import { createPreWriter, loadSessionLog, validateSessionLog } from '../lib/index.js';
import { ruleById } from '../lib/contracts.js';
import { userMessage, validSessionEvents, writeSession } from './helpers.js';

const has = (violations, id) => violations.some((v) => v.id === id);

describe('E11 · seq 由日志层分配：写侧不得自造', () => {
  it('E11 注册表绑定：error 级、persistence 层', () => {
    expect(ruleById('E11')?.severity).toBe('error');
    expect(ruleById('E11')?.layer).toBe('persistence');
  });

  it('E11 负对照：拟写事件自造 seq（≠ nextSeq）⇒ 拒绝（E11 error）', () => {
    const pre = createPreWriter({ events: validSessionEvents() }); // nextSeq = 3
    const verdict = pre.validateAppend(userMessage({ seq: 42 }));
    expect(verdict.ok).toBe(false);
    expect(has(verdict.violations, 'E11')).toBe(true);
    expect(verdict.violations.find((v) => v.id === 'E11').severity).toBe('error');
    expect(verdict.violations.find((v) => v.id === 'E11').message).toContain('不得自造');
  });

  it('E11 正对照：省略 seq（校验器赋值）或显式等于 nextSeq ⇒ 绿', () => {
    const omitted = createPreWriter({ events: validSessionEvents() })
      .validateAppend(userMessage({ seq: undefined }));
    expect(has(omitted.violations, 'E11')).toBe(false);
    expect(omitted.ok).toBe(true);

    const exact = createPreWriter({ events: validSessionEvents() })
      .validateAppend(userMessage({ seq: 3 }));
    expect(has(exact.violations, 'E11')).toBe(false);
    expect(exact.ok).toBe(true);
  });

  it('E2 负对照（删行不重编号）：中间删除两行留下缺口 ⇒ E2 error', () => {
    const events = [...validSessionEvents(), userMessage({ seq: 3 })];
    // 删掉 seq 1、2 且不重编号 ⇒ [0, 3]：缺口
    const edited = [events[0], events[3]];
    const verdict = createPreWriter({ events: [] }).validateEdit(edited);
    expect(verdict.ok).toBe(false);
    expect(has(verdict.violations, 'E2')).toBe(true);
  });

  it('E2 正对照（重编号）：删行后全量重编号 ⇒ 绿', () => {
    const events = [...validSessionEvents(), userMessage({ seq: 3 })];
    const edited = [events[0], { ...events[3], seq: 1, time: 2 }];
    const verdict = createPreWriter({ events: [] }).validateEdit(edited);
    expect(verdict.ok).toBe(true);
    expect(has(verdict.violations, 'E2')).toBe(false);
  });

  it('E2 负对照（文件侧）：日志里 seq 缺口 ⇒ check 判红（写侧自造/删行痕迹）', () => {
    const file = writeSession([userMessage({ seq: 0 }), userMessage({ seq: 2 })]);
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.ok).toBe(false);
    expect(has(result.violations, 'E2')).toBe(true);
  });
});
