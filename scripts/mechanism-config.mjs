#!/usr/bin/env node
/**
 * 机制适用面配置装载器（mechanism applicability config）
 *
 * 每仓一份 `internal/mechanism.config.json`，声明"这套闸里哪些在本仓适用、怎么适用"：
 *   { "gates": {
 *       "<闸键>": "not-applicable"
 *               | { "not-applicable": "<理由>" }
 *               | { "exclude": ["<相对路径>", ...], "reason": "<理由>" } } }
 * 闸键 = pre-publish 里的脚本路径（如 `scripts/check-syntax.mjs`）或步骤名（如 `全量测试`）。
 * 语义（fail-closed）：
 *   · not-applicable ⇒ 该闸在本仓不适用 ⇒ pre-publish 记 **SKIP**（必须带理由，不许静默消失）；
 *   · exclude        ⇒ 传给对应闸（`--exclude`）；闸自身也可从本文件读，standalone 运行同样生效；
 *   · **未声明 ⇒ 全适用，照常执行**（⛔ 不声明 ≠ 跳过）；
 *   · 配置不可解析 / 字段非法 ⇒ **exit 1**（⛔ 不许当"全适用"蒙混过关）。
 * 纪律：`not-applicable` 只许声明"本仓确实不适用"；"适用但缺失/未移植"必须保持
 *       fail-closed FAIL，⛔ 不得用本配置掩盖（掩盖 = 把红变绿，属造假）。
 * 用法：node scripts/mechanism-config.mjs [--root <目录>] [--json]
 * 退出码：0 配置可用（含"无配置=全适用"） / 1 配置不可解析或字段非法
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 读取机制适用面配置。无文件 ⇒ 全适用（gates: {}）；坏文件/坏字段 ⇒ throw（调用方 fail-closed）。 */
export function loadConfig(root = SELF_ROOT) {
  const p = join(root, 'internal', 'mechanism.config.json')
  if (!existsSync(p)) return { gates: {}, source: null }
  let raw
  try { raw = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { throw new Error(`internal/mechanism.config.json 不可解析：${e.message}`) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('internal/mechanism.config.json 顶层必须是对象')
  const gates = raw.gates ?? {}
  if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) throw new Error('gates 必须是对象')
  for (const [key, val] of Object.entries(gates)) {
    if (val === 'not-applicable') continue
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const hasNA = Object.prototype.hasOwnProperty.call(val, 'not-applicable')
      const hasEx = Object.prototype.hasOwnProperty.call(val, 'exclude')
      if (hasNA && hasEx) throw new Error(`gates["${key}"]：not-applicable 与 exclude 互斥`)
      if (hasNA && typeof val['not-applicable'] !== 'string') throw new Error(`gates["${key}"]：not-applicable 必须是理由字符串`)
      if (hasEx && (!Array.isArray(val.exclude) || val.exclude.some((x) => typeof x !== 'string'))) throw new Error(`gates["${key}"]：exclude 必须是字符串数组`)
      if (!hasNA && !hasEx) throw new Error(`gates["${key}"]：需要 not-applicable 或 exclude`)
      continue
    }
    throw new Error(`gates["${key}"]：值必须是 "not-applicable" 或对象`)
  }
  return { gates, source: p }
}

/**
 * 取某道闸的适用面指令。key 先按脚本路径找，再按步骤名找；未声明 ⇒ run（全适用）。
 * 返回 { action: 'run'|'skip', reason, exclude: [] }
 */
export function directiveFor(config, script = null, name = null) {
  const gates = config?.gates ?? {}
  const key = (script && Object.prototype.hasOwnProperty.call(gates, script)) ? script
    : (name && Object.prototype.hasOwnProperty.call(gates, name)) ? name : null
  const val = key === null ? null : gates[key]
  if (val === undefined || val === null) return { action: 'run', reason: '', exclude: [] }
  if (val === 'not-applicable') return { action: 'skip', reason: `not-applicable（internal/mechanism.config.json gates["${key}"]）`, exclude: [] }
  if (typeof val === 'object') {
    if (Object.prototype.hasOwnProperty.call(val, 'not-applicable'))
      return { action: 'skip', reason: `not-applicable：${val['not-applicable']}`, exclude: [] }
    return { action: 'run', reason: '', exclude: val.exclude ?? [] }
  }
  /* c8 ignore next */
  throw new Error(`gates["${key}"]：值非法（loadConfig 应已拦截）`)
}

// ── CLI：打印解析结果（人工审计用） ────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('mechanism-config.mjs')) {
  const argv = process.argv.slice(2)
  const rIdx = argv.indexOf('--root')
  const root = rIdx >= 0 ? argv[rIdx + 1] : SELF_ROOT
  try {
    const cfg = loadConfig(root)
    const out = { source: cfg.source, gates: {} }
    for (const k of Object.keys(cfg.gates)) out.gates[k] = directiveFor(cfg, k)
    if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(`mechanism-config: ${cfg.source ? cfg.source.replace(root + '/', '') : '（无配置 = 全闸适用）'}`)
      for (const [k, d] of Object.entries(out.gates))
        console.log(`  ${d.action === 'skip' ? '· SKIP' : '▸ RUN '} ${k}${d.reason ? ` — ${d.reason}` : ''}${d.exclude.length ? ` ｜ exclude: ${d.exclude.join(', ')}` : ''}`)
      console.log(`mechanism-config: ok —— ${Object.keys(out.gates).length} 条声明`)
    }
    process.exit(0)
  } catch (e) {
    console.error(`mechanism-config: ✗ ${e.message}`)
    process.exit(1)
  }
}
