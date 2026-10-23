/**
 * dsh-log-contract · scripts/check-syntax.mjs
 *
 * 用 esbuild 在进程内解析每个 lib/**.js 与 bin/**.mjs、test/**.js、scripts/**.mjs，
 * 坏文件立即失败（避免 `node --check` 只校验首个参数而静默跳过其余文件的坑）。
 *
 * 机制适用面（mechanism.config.json）：生成件片段（如 lib/dynamic-{host,client}.js，
 * 含 top-level return，不是独立 ESM 模块）可从语法闸排除；**未列出的文件照常校验**。
 *
 * 用法：node scripts/check-syntax.mjs [--exclude <相对路径,相对路径,...>]
 *   --exclude  排除清单（逗号分隔）；省略时读 internal/mechanism.config.json 的
 *              gates["scripts/check-syntax.mjs"].exclude（仓级适用面声明，standalone 也生效）
 * 退出码：0 全部可解析 / 1 存在语法错 / 2 无法判定（配置坏）
 */
// 前置：需 node_modules（esbuild）。缺依赖时明确 exit 2，避免误报语法错
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { loadConfig, directiveFor } from './mechanism-config.mjs';

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const argv = process.argv.slice(2)
const eIdx = argv.indexOf('--exclude')
let exclude = eIdx >= 0 ? String(argv[eIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null
if (exclude === null) {
  // 无 CLI 参数 ⇒ 读仓级适用面配置；配置坏 = 无法判定（fail-closed，⛔ 不静默当全适用）
  try {
    const cfg = loadConfig(process.cwd())
    exclude = directiveFor(cfg, 'scripts/check-syntax.mjs').exclude
  } catch (e) { console.error(`syntax: ✗ 无法判定 —— ${e.message}`); process.exit(2) }
}
const norm = (p) => relative(process.cwd(), p).split('\\').join('/').replace(/^\.\//, '')
const excluded = new Set(exclude.map((p) => p.split('\\').join('/').replace(/^\.\//, '')))

const files = [...walk('lib'), ...walk('bin'), ...walk('test'), ...walk('scripts')];
const kept = [], skipped = []
for (const file of files) (excluded.has(norm(file)) ? skipped : kept).push(file)
for (const file of skipped) console.log(`⏭ ${norm(file)}（排除：机制适用面 exclude）`);
let failed = false;
for (const file of kept) {
  try {
    await build({ entryPoints: [file], write: false, bundle: false, logLevel: 'silent', platform: 'node', format: 'esm' });
    console.log(`✔ ${file}`);
  } catch (err) {
    failed = true;
    console.error(`✘ ${file}`);
    console.error(err.errors?.[0]?.text ?? err.message);
  }
}
if (failed) process.exit(1);
console.log(`\nsyntax check passed: ${kept.length} files${skipped.length ? `（排除 ${skipped.length} 个片段）` : ''}`);
