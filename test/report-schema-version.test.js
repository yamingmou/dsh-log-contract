/**
 * dsh-log-contract · test/report-schema-version.test.js
 *
 * 回归钉（B 组：`check --json` 增加 `schemaVersion`）——报告契约四条：
 *   T1 体检结果对象 `schemaVersion` 存在且 === '1'（字符串）
 *   T2 宿主能力闸（unassessable）路径同样带该字段
 *   T3 `check --json` 顶层 `schemaVersion === '1'`，且既有键一个不少、JSON 可解析
 *   T4 负对照（必须变）：缺字段 / 非字符串 / 空串 / 非 '1' ⇒ 判据必须判红（防断言恒真）
 * ⛔ 只钉契约，不动实现（实现：lib/validate.js REPORT_SCHEMA_VERSION + 两个返回对象 + bin 透传）。
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { loadSessionLog, validateSessionLog } from '../lib/index.js';
import { HEADER, validSessionEvents, writeSession } from './helpers.js';

const require = createRequire(import.meta.url);
const BIN = require.resolve('../bin/dsh-log-contract.mjs');

function run(args) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: err.stdout ?? '' };
  }
}

const REPORT_SCHEMA_VERSION = '1';
/** T1–T3 共用判据；T4 对同一判据做负对照（必须判红的形状不得判绿）。 */
const hasSchemaVersion = (o) => typeof o?.schemaVersion === 'string' && o.schemaVersion.length > 0;
const isSchemaV1 = (o) => o?.schemaVersion === REPORT_SCHEMA_VERSION;
/** check --json 既有键（schemaVersion 增量不得挤掉任何一个）。 */
const LEGACY_KEYS = ['file', 'ok', 'assessable', 'assessmentScope', 'host', 'migration', 'summary', 'violations'];

describe('check --json schemaVersion 回归钉', () => {
  it('T1 体检结果对象 schemaVersion === "1"（存在且为字符串）', () => {
    const log = loadSessionLog(writeSession(validSessionEvents()));
    const result = validateSessionLog(log);
    expect(hasSchemaVersion(result)).toBe(true);
    expect(typeof result.schemaVersion).toBe('string');
    expect(isSchemaV1(result)).toBe(true);
  });

  it('T2 宿主能力闸（unassessable）路径同样带 schemaVersion', () => {
    // 被检文件版本高于任何宿主上限 ⇒ 必走 unassessable 档（不依赖运行宿主）
    const file = writeSession(validSessionEvents(), { header: { ...HEADER, version: 99 } });
    const result = validateSessionLog(loadSessionLog(file));
    expect(result.assessable).toBe(false);
    expect(hasSchemaVersion(result)).toBe(true);
    expect(isSchemaV1(result)).toBe(true);
    // CLI 同路径（exit 3）也必须透传
    const { code, out } = run(['check', file, '--json']);
    expect(code).toBe(3);
    const parsed = JSON.parse(out);
    expect(isSchemaV1(parsed)).toBe(true);
  });

  it('T3 check --json 顶层 schemaVersion === "1" 且既有键一个不少、JSON 可解析', () => {
    const file = writeSession(validSessionEvents());
    const { code, out } = run(['check', file, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);            // JSON 可解析（管道刷尾坑见 bin 头注释）
    expect(isSchemaV1(parsed)).toBe(true);
    for (const k of LEGACY_KEYS) expect(parsed).toHaveProperty(k);
    expect(parsed.ok).toBe(true);
    expect(parsed.summary.events).toBe(3);
  });

  it('T4 负对照：schemaVersion 缺失/非字符串/空串/非 "1" 必须判红（判据本身不失效）', () => {
    expect(isSchemaV1({ schemaVersion: REPORT_SCHEMA_VERSION })).toBe(true);   // 正对照
    for (const bad of [{}, { schemaVersion: 1 }, { schemaVersion: null }, { schemaVersion: '' }, { schemaVersion: '2' }]) {
      expect(hasSchemaVersion(bad) && isSchemaV1(bad)).toBe(false);            // 必须变：判红
    }
  });
});
