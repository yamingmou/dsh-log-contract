#!/usr/bin/env node
/**
 * 词表登记（wordlist pin）
 * 方法：计算 internal/wordlist.json 的 sha256 并写入 internal/wordlist.sha256。
 * 用途：**有意修改词表后**运行本脚本更新登记；平时不做（闸会判"指纹不匹配"）。
 * 用法：node scripts/wordlist-pin.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const p = join(ROOT, 'internal', 'wordlist.json')
const h = createHash('sha256').update(readFileSync(p)).digest('hex')
writeFileSync(join(ROOT, 'internal', 'wordlist.sha256'), h + '\n')
console.log('wordlist-pin: 已登记', h.slice(0, 16), '…')
