#!/usr/bin/env node
/**
 * health-scan —— 定期巡检机制（健康监控/定期巡检层）。
 *
 * 2026-08-31 用户要求：光有事后急救（医生自救/外部急救）不健全，
 * 必须有**主动发现**——定期或随时全量扫描会话健康，发现问题分级处置。
 * 本脚本是「定期巡检」的执行体：
 *
 *   全量扫描 ~/.dsh/sessions 下所有 session.jsonl.zstd
 *     → 每会话 check（error 级违规 + resume 三档结论）
 *     → 汇总健康报告（健康/可修/损坏三档）
 *     → 写入 ~/opena-archive-2026-08/健康巡检报告-YYYYMMDD-HHMM.md
 *     → 分级处置建议（自动修安全原语 / 转医生 / 转外部急救）
 *
 * 触发方式（机制，不是工具）：
 *   1. 手动：node ~/opena/dsh-log-contract/scripts/health-scan.mjs
 *   2. 定时（macOS launchd / cron）：每天一次（示例见文件尾注释）
 *   3. 开机/新会话启动时顺手跑一次
 *
 * 分级（与 医生SOS 四层对应）：
 *   🟢 健康     —— error 0，三档结论无倒退，不动作
 *   🟡 可自修   —— 仅安全原语可修（T1/T2/I1），给出 fix 命令，建议医生执行
 *   🔴 损坏     —— 结构级 error（E/S/H 系列）或反复修不好，转医生/外部急救
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const REPORT_DIR = path.join(os.homedir(), 'opena-archive-2026-08')
const CONTRACT_BIN = path.join(os.homedir(), 'opena', 'dsh-log-contract', 'bin', 'dsh-log-contract.mjs')
const CONTRACT_PKG = path.join(os.homedir(), 'opena', 'dsh-log-contract', 'package.json')

function findSessions() {
  const out = []
  if (!fs.existsSync(SESSIONS_ROOT)) return out
  for (const wd of fs.readdirSync(SESSIONS_ROOT)) {
    const wdir = path.join(SESSIONS_ROOT, wd)
    if (!fs.statSync(wdir).isDirectory()) continue
    for (const sid of fs.readdirSync(wdir)) {
      const f = path.join(wdir, sid, 'session.jsonl.zstd')
      if (fs.existsSync(f)) out.push({ sessionId: sid, workspace: wd, file: f })
    }
  }
  return out
}

/** 对单会话跑 check --json，解析 error 数与 resume 三档。 */
function scanOne(session) {
  try {
    const out = execFileSync(process.execPath, [CONTRACT_BIN, 'check', session.file, '--resume', '--json'], {
      encoding: 'utf8', timeout: 60000,
    })
    const j = JSON.parse(out)
    const errs = j.violations.filter((v) => v.severity === 'error')
    const resume = j.resume || {}
    // 分级：结构级 error（非 T1/T2/I1）= 损坏；T1/T2/I1 = 可自修
    const structural = errs.filter((v) => !['T1', 'T2', 'I1'].includes(v.id))
    let grade = '🟢'
    if (errs.length === 0) grade = '🟢'
    else if (structural.length === 0) grade = '🟡'
    else grade = '🔴'
    return {
      sessionId: session.sessionId,
      workspace: session.workspace,
      file: session.file,
      grade,
      errorCount: errs.length,
      errorIds: [...new Set(errs.map((v) => v.id))],
      verdict: resume.verdict || '?',
      loadable: resume.loadable, resumable: resume.resumable, compactable: resume.compactable,
    }
  } catch (err) {
    return { sessionId: session.sessionId, workspace: session.workspace, file: session.file, grade: '🔴', errorCount: -1, errorIds: ['UNREADABLE'], error: String(err.message || err).slice(0, 120) }
  }
}

function main() {
  if (!fs.existsSync(CONTRACT_BIN)) {
    console.error(`✗ 工具链缺失: ${CONTRACT_BIN}（先确认 dsh-log-contract 源码存在）`)
    process.exit(2)
  }
  const sessions = findSessions()
  console.log(`=== 健康巡检 ${new Date().toISOString()} ===`)
  console.log(`发现 ${sessions.length} 个会话，开始扫描...\n`)

  const results = sessions.map(scanOne)
  const green = results.filter((r) => r.grade === '🟢')
  const yellow = results.filter((r) => r.grade === '🟡')
  const red = results.filter((r) => r.grade === '🔴')

  for (const r of results) {
    const line = `${r.grade} ${r.sessionId} (${r.workspace}) error=${r.errorCount} [${r.errorIds.join(',')}] verdict=${r.verdict}`
    console.log(line)
  }

  console.log(`\n=== 汇总: 🟢${green.length} 🟡${yellow.length} 🔴${red.length} (共${results.length}) ===`)

  // 处置建议
  if (yellow.length) {
    console.log('\n🟡 可自修（安全原语）建议：')
    for (const r of yellow) {
      const cmds = []
      if (r.errorIds.includes('T1')) cmds.push(`fix ${r.file} --neutralize --apply`)
      if (r.errorIds.includes('T2')) cmds.push(`fix ${r.file} --clip-crossstep --apply`)
      if (r.errorIds.includes('I1')) cmds.push(`fix ${r.file} --neutralize-orphan --apply`)
      console.log(`  ${r.sessionId}: ${cmds.join(' ; ')}`)
    }
    console.log('  （执行前先备份；建议由对话修复线/医生执行）')
  }
  if (red.length) {
    console.log('\n🔴 损坏（结构级）转医生/外部急救：')
    for (const r of red) console.log(`  ${r.sessionId}: ${r.file} (${r.errorIds.join(',')})`)
    console.log('  处置见 EMERGENCY-SOS-外部急救包.md')
  }

  // 写入健康巡检报告（只加不减，追加到当日文件）
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 13)
  const reportFile = path.join(REPORT_DIR, `健康巡检报告-${ts}.md`)
  const block = `\n## [${new Date().toISOString()}] 巡检 ${sessions.length} 会话 → 🟢${green.length} 🟡${yellow.length} 🔴${red.length}\n` +
    results.map((r) => `- ${r.grade} ${r.sessionId} error=${r.errorCount} [${r.errorIds.join(',')}] ${r.file}`).join('\n') + '\n'
  fs.appendFileSync(reportFile, block)
  console.log(`\n✓ 报告已追加: ${reportFile}`)

  // 退出码：有 🔴 或 🟡 时非 0（供定时任务告警）
  process.exit(red.length + yellow.length > 0 ? 1 : 0)
}

main()

/* 定时触发示例（macOS launchd，每天 03:00）：
   ~/Library/LaunchAgents/com.offerkuai.health-scan.plist:
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.offerkuai.health-scan</string>
     <key>ProgramArguments</key>
     <array><string>/usr/local/bin/node</string><string>/Users/maxwell/opena/dsh-log-contract/scripts/health-scan.mjs</string></array>
     <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
     <key>StandardOutPath</key><string>/tmp/health-scan.log</string>
   </dict></plist>
   launchctl load ~/Library/LaunchAgents/com.offerkuai.health-scan.plist
*/
