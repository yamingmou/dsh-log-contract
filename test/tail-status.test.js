/**
 * test/tail-status.test.js —— Z6 负对照套件（0.3.28）
 *
 * 口径边界（真实事故形态）：体检 `check --json` 只保证"**已读到的事件**自洽"，
 * **不保证尾部完整**——最后一帧被切掉时仍可能 `ok=true`。Z6 把尾部状态变成
 * 机器可判字段 `tailStatus: complete | interrupted | truncated | unknown`
 * （判定实现 `lib/log-reader.js` 的 `deriveTailStatus`）。
 *
 * 四个状态各有正/反对照；`ok` 不被 Z6 翻转（撕裂尾帧在宿主读取器语义下可恢复），
 * 真损坏另由 R1/Z2 判 error。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionLog, validateSessionLog } from '../lib/index.js';
import { deriveTailStatus } from '../lib/log-reader.js';
import { ruleById } from '../lib/contracts.js';
import { HEADER, validSessionEvents, writeRawSession, writeSession, writeSessionFrames } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'dsh-log-contract.mjs');

const has = (violations, id) => violations.some((v) => v.id === id);

describe('Z6 · 尾部完整性 tailStatus（四态判定）', () => {
  it('Z6 注册表绑定：warning 级、framing 层（不翻转 ok）', () => {
    expect(ruleById('Z6')?.severity).toBe('warning');
    expect(ruleById('Z6')?.layer).toBe('framing');
  });

  it('complete：健康 zstd / 明文 ⇒ tailStatus=complete 且不报 Z6', () => {
    for (const zstd of [true, false]) {
      const file = writeSession(validSessionEvents(), { zstd });
      const result = validateSessionLog(loadSessionLog(file));
      expect(result.summary.tailStatus).toBe('complete');
      expect(has(result.violations, 'Z6')).toBe(false);
      expect(result.ok).toBe(true);
    }
  });

  it('interrupted：zstd 尾帧撕裂 ⇒ tailStatus=interrupted + Z6/Z1 warning，但 ok 不被翻转', () => {
    const file = writeSession(validSessionEvents(), { zstd: true, torn: 'tail' });
    const log = loadSessionLog(file);
    expect(log.frameInfo.tailStatus).toBe('interrupted');
    const result = validateSessionLog(log);
    expect(result.summary.tailStatus).toBe('interrupted');
    expect(result.summary.tailStatusReason).toBe('torn-tail-frame');
    expect(has(result.violations, 'Z6')).toBe(true);
    expect(has(result.violations, 'Z1')).toBe(true);
    // Z6 是 warning：撕裂尾帧在宿主读取器语义下是可恢复态（丢弃未写完尾帧）。
    expect(result.violations.find((v) => v.id === 'Z6').severity).toBe('warning');
    expect(result.ok).toBe(true);
  });

  it('truncated：末行记录被切断（半行 JSON）⇒ tailStatus=truncated + Z6，且 R1 判 error', () => {
    const file = writeRawSession([
      JSON.stringify(HEADER),
      JSON.stringify(validSessionEvents()[0]),
      '{"type":"user/mes', // 尾行被切：不是完整 JSON
    ]);
    const log = loadSessionLog(file);
    expect(log.frameInfo.tailStatus).toBe('truncated');
    const result = validateSessionLog(log);
    expect(result.summary.tailStatus).toBe('truncated');
    expect(has(result.violations, 'Z6')).toBe(true);
    expect(has(result.violations, 'R1')).toBe(true); // 真损坏仍判 error
    expect(result.ok).toBe(false);
  });

  it('unknown：空文件 ⇒ tailStatus=unknown + Z6（不冒充 complete）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-contract-'));
    const file = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.summary.tailStatus).toBe('unknown');
    expect(has(result.violations, 'Z6')).toBe(true);
  });

  it('deriveTailStatus：显式声明优先；坏帧/撕裂/半行/空各有归类', () => {
    expect(deriveTailStatus({ frameInfo: { tailStatus: 'complete' } }).tailStatus).toBe('complete');
    expect(deriveTailStatus({ frameInfo: { error: 'x' } }).tailStatus).toBe('unknown');
    expect(deriveTailStatus({ frameInfo: { torn: true } }).tailStatus).toBe('interrupted');
    expect(deriveTailStatus({ frameInfo: { torn: false }, rows: [{ lineNo: 2, value: null, error: new Error('x') }], header: HEADER }).tailStatus).toBe('truncated');
    expect(deriveTailStatus({ frameInfo: { torn: false }, rows: [], header: null }).tailStatus).toBe('unknown');
    expect(deriveTailStatus({ frameInfo: { torn: false }, rows: [], header: HEADER }).tailStatus).toBe('complete');
  });

  it('CLI --json：summary.tailStatus 是机器可判字段（口径边界显式化）', () => {
    const file = writeSession(validSessionEvents(), { zstd: true, torn: 'tail' });
    const res = spawnSync(process.execPath, [CLI, 'check', file, '--json'], { encoding: 'utf8' });
    const payload = JSON.parse(res.stdout);
    expect(payload.summary.tailStatus).toBe('interrupted');
    expect(payload.violations.some((v) => v.id === 'Z6')).toBe(true);
    expect(payload.ok).toBe(true); // 口径：ok 只保证"已读到的事件自洽"
  });
});
