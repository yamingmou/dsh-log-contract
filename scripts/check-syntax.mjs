/**
 * dsh-log-contract · scripts/check-syntax.mjs
 *
 * 用 esbuild 在进程内解析每个 lib/**.js 与 bin/**.mjs、test/**.js，
 * 坏文件立即失败（避免 `node --check` 只校验首个参数而静默跳过其余文件的坑）。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = [...walk('lib'), ...walk('bin'), ...walk('test'), ...walk('scripts')];
let failed = false;
for (const file of files) {
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
console.log(`\nsyntax check passed: ${files.length} files`);
