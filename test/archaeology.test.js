/**
 * 考古能力测试（任务书 §5 验收 V4/V5/V6）：
 * - P3 配对完整性：正常会话 0 孤儿；删 result 的坏日志触发
 * - P4 输出结构：正常 content 通过；不可解析片段违约
 * - extract：按命令正则找回输出（含嵌套 text）
 * - audit-report：调用数/配对率/孤儿数/命令分布与手统计一致
 */
import { describe, it, expect } from 'vitest';
import { toolPairingViolations, toolResultStructureViolations } from '../lib/checks.js';
import { extractText, extractToolOutputs, auditToolCalls } from '../lib/archaeology.js';

function callEvent(seq, callId, command) {
  return {
    seq,
    type: 'tool/call',
    time: seq + 1,
    data: { callId, name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

function resultEvent(seq, callId, content) {
  return {
    seq,
    type: 'tool/result',
    time: seq + 1,
    data: { message: { source: { callId }, content } },
  };
}

const wrapped = (events) => events.map((event) => ({ event, lineNo: 1 }));

describe('P3 配对完整性', () => {
  it('正常会话：call 全配对 → 0 孤儿', () => {
    const events = [
      callEvent(0, 'c1', 'python seed-scale6.py'),
      resultEvent(1, 'c1', [{ type: 'text', text: 'ok' }]),
      callEvent(2, 'c2', 'ls'),
      resultEvent(3, 'c2', [{ type: 'text', text: 'files' }]),
    ];
    expect(toolPairingViolations(wrapped(events))).toHaveLength(0);
  });

  it('删 result 的坏日志 → P3 触发（孤儿 call）', () => {
    const events = [
      callEvent(0, 'c1', 'python seed-scale6.py'),
      callEvent(2, 'c2', 'ls'),
      resultEvent(3, 'c2', [{ type: 'text', text: 'files' }]),
    ];
    const v = toolPairingViolations(wrapped(events));
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('P3');
    expect(v[0].message).toContain('c1');
  });
});

describe('P4 输出结构', () => {
  it('正常嵌套 content → 通过', () => {
    const events = [resultEvent(0, 'c1', [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }])];
    expect(toolResultStructureViolations(wrapped(events))).toHaveLength(0);
  });

  it('text 字段非 string → 违约（提取会漏）', () => {
    const events = [resultEvent(0, 'c1', [{ type: 'text', text: 'ok' }, { type: 'text', text: 42 }])];
    const v = toolResultStructureViolations(wrapped(events));
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('P4');
  });

  it('标量元数据（isError/toolCallId 等）→ 合法', () => {
    const events = [resultEvent(0, 'c1', [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'real' }], isError: false }])];
    expect(toolResultStructureViolations(wrapped(events))).toHaveLength(0);
  });
});

describe('extractText（递归提取）', () => {
  it('嵌套 content[].content[].text 全部提取', () => {
    const content = [{ type: 'text', text: 'a' }, { content: [{ type: 'text', text: 'b' }, [{ type: 'text', text: 'c' }]] }];
    expect(extractText(content)).toBe('a\nb\nc');
  });
});

describe('extractToolOutputs', () => {
  it('按命令正则找回输出（含 min-size 过滤）', () => {
    const events = [
      callEvent(0, 'c1', 'python seed-scale6.py'),
      resultEvent(1, 'c1', [{ type: 'text', text: 'x'.repeat(60) }]),
      callEvent(2, 'c2', 'python seed-evolve.py'),
      resultEvent(3, 'c2', [{ type: 'text', text: 'y'.repeat(10) }]), // 小于 minSize
    ];
    const { pairs } = extractToolOutputs(events, 'seed-scale6', { minSize: 50 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].callId).toBe('c1');
    expect(pairs[0].text).toBe('x'.repeat(60));
  });
});

describe('auditToolCalls', () => {
  it('调用数/配对率/孤儿数/命令分布与手统计一致', () => {
    const events = [
      callEvent(0, 'c1', 'seed-scale6.py'),
      resultEvent(1, 'c1', [{ type: 'text', text: 'out1' }]),
      callEvent(2, 'c2', 'seed-scale6.py'),
      resultEvent(3, 'c2', [{ type: 'text', text: 'out2' }]),
      callEvent(4, 'c3', 'ls'), // 孤儿
    ];
    const report = auditToolCalls(events);
    expect(report.calls).toBe(3);
    expect(report.results).toBe(2);
    expect(report.pairingRate).toBeCloseTo(2 / 3);
    expect(report.orphans).toBe(1);
    expect(report.commands.top[0]).toEqual({ command: 'seed-scale6.py', count: 2 });
    expect(report.commands.top[1]).toEqual({ command: 'ls', count: 1 });
    expect(report.outputBytes).toBe(8); // 'out1' + 'out2'
  });
});
