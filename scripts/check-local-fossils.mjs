#!/usr/bin/env node
/**
 * dsh-log-contract · scripts/check-local-fossils.mjs
 *
 * 本地真实化石回归（不进 CI，也不入库）：
 * 指向工作区里的真实事故/缺陷会话备份，验证本工具的判定符合已知事实。
 *
 * 用法：node scripts/check-local-fossils.mjs [目录或文件…]
 * 默认扫描 ../ 下的 backup-session-*.jsonl.zstd。
 *
 * 预期判定（真值表）：
 *   - e61d70da-pre-markerfix-20260825-002906  → PASS（事故修复后会话，官方 foldSurface 可重放）
 *   - b7713ea1-seqgap / 2c3f87d4-corrupt      → FAIL（seq 缺口 / 倒退 → 加载被拒）
 *   - 2c3f87d4-spliced-orphan                 → PASS（持久化层合法；#3632 是消费路径判定差异，
 *                                                 本工具只负责持久化契约层，见 docs/CONTRACTS.md）
 *   - 2c3f87d4-rewritten-230542               → FAIL（那次重写引入了 seq 缺口）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionLog, validateSessionLog } from '../lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.resolve(here, '..', '..'); // opena 工作区

const inputs = process.argv.slice(2);
const files = inputs.length > 0
  ? inputs
  : fs.readdirSync(defaultDir)
      .filter((n) => /^backup-session-.*\.jsonl\.zstd$/.test(n))
      .map((n) => path.join(defaultDir, n));

let failed = 0;
for (const file of files) {
  let result;
  try {
    const log = loadSessionLog(file);
    result = validateSessionLog(log);
  } catch (err) {
    console.log(`✘ ${path.basename(file)}  读取异常: ${err.message}`);
    failed += 1;
    continue;
  }
  const { ok, summary } = result;
  const ids = [...new Set(result.violations.map((v) => v.id))].join(',');
  console.log(`${ok ? '✔' : '✘'} ${path.basename(file)}  events=${summary.events} err=${summary.bySeverity.error} warn=${summary.bySeverity.warning}${ids ? ` [${ids}]` : ''}`);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
