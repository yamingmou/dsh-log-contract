/**
 * dsh-log-contract · test/frame-shape.test.js
 *
 * **Z4/Z5 的锁 + 测试夹具"保形"守卫**（2026-09-16 真机事故）。
 *
 * 事故：修一条损坏会话时把整份日志**重压成 1 帧**写回。官方写盘形状是
 * 「**帧 1 = header 独占一行** + 事件按批次逐帧追加」，读取端硬断言
 * `assertZstdHeaderFrame`（首帧必须恰好一行）；抛点在 `listArtifacts` **遍历全库**、
 * 无 per-session 容错 ⇒ **整个客户端起不来**（帧计数 3540 → 1 是铁证）。
 *
 * 本文件钉三件事：
 *   ① **规则活着**：单帧整份 ⇒ Z4+Z5 齐报；保形 ⇒ 不报（反向对照）；
 *      首帧"一行但无尾换行"/"空首帧" ⇒ Z4 报（边界）。
 *   ② **规则不是空转**：把 Z4/Z5 的条件**短路**后同样的输入**不再红**
 *      （真变异：拷一份 `lib/` 到临时目录打补丁再跑，见 `mutateZ4Z5`）。
 *   ③ **夹具保形**：`test/` 下除本文件外不得直接做 zstd 压缩、不得使用反面夹具
 *      `writeSingleFrameSession`；且代表性夹具必须真的是"帧 1 = header 独占 + ≥2 帧"。
 *
 * 为什么 ③ 也算交付物：Z4/Z5 变红的 9 条用例，根因是**夹具不真实**（整份压一帧）、
 * 不是规则错。夹具不保形 ⇒ 测不出真实宿主读不读得动 ⇒ 这类事故会再次穿过测试。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { loadSessionLog } from '../lib/index.js';
import { validateSessionLog } from '../lib/validate.js';
import { scanZstdFrames } from '../lib/log-reader.js';
import { HEADER, validSessionEvents, userMessage, assistantMessage, markerEvent, writeSession, writeSessionFrames, writeSingleFrameSession, writeFrameParts, zstdFramesOf, faithfulFrameInfo } from './helpers.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const idsOf = (result) => [...new Set(result.violations.map((v) => v.id))];
const linesOf = (header = HEADER, events = validSessionEvents()) => [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];

/** 解出文件每一帧的明文（帧数即形状事实）。 */
function framesPlain(file) {
  const buf = readFileSync(file);
  const { frames, torn } = scanZstdFrames(buf);
  return { frames: frames.map(([s, e]) => zstdDecompressSync(buf.subarray(s, e)).toString('utf8')), torn };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Z4/Z5 · 单帧整份 ⇒ 齐报（真机事故的直接产物）', () => {
  it('整份日志压成 1 帧 ⇒ Z4 + Z5 同时报，且 ok=false', () => {
    const file = writeSingleFrameSession(linesOf());
    const log = loadSessionLog(file);
    expect(log.frameInfo.frames).toBe(1);              // 形状事实：确实只有 1 帧
    const ids = idsOf(validateSessionLog(log));
    expect(ids).toContain('Z4');                        // 首帧不是"恰好一行"
    expect(ids).toContain('Z5');                        // 多行日志压成 1 帧
    expect(validateSessionLog(log).ok).toBe(false);
  });

  it('反向对照：保形（帧1=header 独占 + 事件帧）⇒ Z4/Z5 都不报，且 ok=true', () => {
    const file = writeSession(validSessionEvents(), { zstd: true });
    const log = loadSessionLog(file);
    expect(log.frameInfo.frames).toBeGreaterThanOrEqual(2);
    expect(log.frameInfo.firstFrameOneLine).toBe(true);
    const ids = idsOf(validateSessionLog(log));
    expect(ids).not.toContain('Z4');
    expect(ids).not.toContain('Z5');
    expect(validateSessionLog(log).ok).toBe(true);
  });

  it('等价性：同一份日志，"保形"与"整份一帧"两种夹具的**语义判定完全相同**，只差 Z4/Z5', () => {
    // 这条是"9 条红是夹具不真实造成的，不是规则错"的直接证据：
    // 两种写法解出的 header/events/rows 逐条相同 ⇒ 除 Z4/Z5 外，违规集合必须一模一样。
    // 若哪天有人在"保形"路径里顺手改了别的东西，这条会红。
    const lines = linesOf();
    const faithful = loadSessionLog(writeSessionFrames(lines));
    const single = loadSessionLog(writeSingleFrameSession(lines));
    const strip = (ids) => ids.filter((id) => id !== 'Z4' && id !== 'Z5');

    expect(faithful.header).toEqual(single.header);
    expect(faithful.events.map((e) => e.event)).toEqual(single.events.map((e) => e.event));
    expect(faithful.rows.length).toBe(single.rows.length);
    expect(faithful.frameInfo.frames).toBeGreaterThan(1);
    expect(single.frameInfo.frames).toBe(1);

    expect(strip(idsOf(validateSessionLog(faithful)))).toEqual(strip(idsOf(validateSessionLog(single))));
    // 而"整份一帧"额外的**正好是** Z4+Z5，没有别的
    const singleIds = idsOf(validateSessionLog(single));
    expect(singleIds.filter((id) => id === 'Z4' || id === 'Z5').sort()).toEqual(['Z4', 'Z5']);
    expect(singleIds.length - strip(singleIds).length).toBe(2);
  });

  it('夹具帧与**本包写回路径**同参：第 1 帧与 `rebuildZstdText()` 的第 1 帧逐字节相同', async () => {
    // 官方写回实现是 `lib/repair.js` 的 `rebuildZstdText()`（帧1=header、帧2=其余、带 checksum）。
    // 夹具若用默认压缩参数就少了 checksum 位 ⇒ `scanZstdFrames` 的 `if (checksum) offset += 4`
    // 在夹具路径上永远走不到，那也是一种"夹具不真实"。zstd 同参数 + 同输入是确定性的，
    // 所以"第 1 帧逐字节相同"就是参数对齐的硬证据。
    const { rebuildZstdText } = await import('../lib/repair.js');
    const lines = linesOf();
    const fromHelper = zstdFramesOf(lines);
    const official = rebuildZstdText(`${lines.join('\n')}\n`);
    const officialFrames = scanZstdFrames(official).frames;
    expect(officialFrames.length).toBe(2);                          // 官方写回就是 2 帧
    const [s0, e0] = officialFrames[0];
    expect(fromHelper[0].equals(official.subarray(s0, e0))).toBe(true);
    // 夹具其余帧也带 checksum 位（descriptor bit 2）
    for (const f of fromHelper) expect(f.readUInt8(4) & 4, 'checksum flag').toBe(4);
  });

  it('边界：首帧"一行但无尾换行" ⇒ Z4 报（Z5 不报，因为不是"整份一帧"）', () => {
    const lines = linesOf();
    const file = writeFrameParts([
      JSON.stringify(HEADER),                                  // 无尾换行
      `${lines.slice(1, 3).join('\n')}\n`,
      `${lines.slice(3).join('\n')}\n`,
    ], { name: 'first-frame-no-newline' });
    const log = loadSessionLog(file);
    expect(log.frameInfo.firstFrameOneLine).toBe(false);       // "恰好一行"不成立
    const ids = idsOf(validateSessionLog(log));
    expect(ids).toContain('Z4');
    expect(ids).not.toContain('Z5');                           // 3 帧，不是压成一帧
  });

  it('边界：空首帧 ⇒ Z4 报', () => {
    const lines = linesOf();
    const file = writeFrameParts(['', `${lines.slice(1).join('\n')}\n`], { name: 'empty-first-frame' });
    const log = loadSessionLog(file);
    expect(log.frameInfo.firstFrameOneLine).toBe(false);
    expect(idsOf(validateSessionLog(log))).toContain('Z4');
  });

  it('边界：只有 header 的单帧（无事件）⇒ Z4/Z5 都不报（这是合法形状，Z5 要求多行）', () => {
    const file = writeFrameParts([`${JSON.stringify(HEADER)}\n`], { name: 'header-only' });
    const log = loadSessionLog(file);
    expect(log.frameInfo.frames).toBe(1);
    expect(log.frameInfo.firstFrameOneLine).toBe(true);
    const ids = idsOf(validateSessionLog(log));
    expect(ids).not.toContain('Z4');
    expect(ids).not.toContain('Z5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * **真变异**：把 Z4/Z5 的判定条件短路，再跑同一份单帧夹具。
 *
 * 做法：把 `lib/` 拷到临时目录（`node_modules` 软链过去），对副本的 `validate.js`
 * 打两处补丁，用子进程 import 副本跑同一输入。断言：
 *   · 补丁**确实**改到了 2 处（锚点漂了就 fail-loud，别让变异静默变空转）；
 *   · 短路后 **Z4/Z5 都不再出现**（⇒ 上面那些红确实由这两条规则产生，不是别的原因）。
 *
 * @returns {{patched: number, ids: string[]}}
 */
function mutateZ4Z5(file) {
  const dir = mkdtempSync(join(tmpdir(), 'dlc-mutate-'));
  try {
    cpSync(join(REPO_ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const target = join(dir, 'lib', 'validate.js');
    const src = readFileSync(target, 'utf8');
    const anchors = [
      ['  if (frameInfo?.firstFrameOneLine === false) {', '  if (false) { // [变异] Z4 短路'],
      ['  if (Number.isSafeInteger(frameInfo?.frames) && frameInfo.frames === 1 && Array.isArray(rows) && rows.length > 1) {', '  if (false) { // [变异] Z5 短路'],
    ];
    let patched = 0;
    let mutated = src;
    for (const [from, to] of anchors) {
      if (!mutated.includes(from)) continue;
      mutated = mutated.replace(from, to);
      patched++;
    }
    writeFileSync(target, mutated);

    const script = `
      import { loadSessionLog } from ${JSON.stringify(join(dir, 'lib', 'index.js'))};
      import { validateSessionLog } from ${JSON.stringify(target)};
      const log = loadSessionLog(${JSON.stringify(file)});
      const ids = [...new Set(validateSessionLog(log).violations.map((v) => v.id))];
      console.log(JSON.stringify({ ids }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`变异副本运行失败：${run.stderr || run.stdout}`);
    return { patched, ids: JSON.parse(run.stdout.trim()).ids };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Z4/Z5 · 变异锁（把规则短路 ⇒ 同样的输入不再红）', () => {
  it('短路 Z4/Z5 后，单帧整份夹具不再报 Z4/Z5（⇒ 那两条红确实来自规则本身）', () => {
    const file = writeSingleFrameSession(linesOf());
    const live = idsOf(validateSessionLog(loadSessionLog(file)));
    expect(live).toContain('Z4');
    expect(live).toContain('Z5');

    const { patched, ids } = mutateZ4Z5(file);
    expect(patched).toBe(2);                       // 两处锚点都命中，变异不是空转
    // 变异后**只少了这两条**（不是"整条链路炸了 ⇒ 什么都没报"那种假绿）
    expect(ids).not.toContain('Z4');
    expect(ids).not.toContain('Z5');
    expect(ids).toEqual(live.filter((id) => id !== 'Z4' && id !== 'Z5'));
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('夹具保形守卫（禁止再出现"整份压一帧"的写法）', () => {
  const testDir = join(REPO_ROOT, 'test');
  const files = readdirSync(testDir).filter((f) => f.endsWith('.js')).sort();
  const source = (f) => readFileSync(join(testDir, f), 'utf8');
  const GUARD = 'frame-shape.test.js';

  // 守卫自己也不能逐字写出那个 API 名，否则"谁都不许压缩"这条会把自己判红。
  // 用拼接构造词面（源码里因此没有连写的标识符），并**显式验证这个词认得出真实用法** ——
  // 免得构造写错导致守卫变成永远绿的空转。
  const COMPRESS_CALL = new RegExp(String.raw`${['zstd', 'CompressSync'].join('')}\s*\(`);
  const COMPRESS_NAME = ['zstd', 'CompressSync'].join('');

  it('守卫非空转：构造出来的词确实认得出 helpers.js 里的真实压缩调用', () => {
    expect(COMPRESS_CALL.test(source('helpers.js'))).toBe(true);
    expect(COMPRESS_NAME.length).toBeGreaterThan(0);
  });

  it('`test/` 下只有 helpers.js 允许做 zstd 压缩（其余文件一律走夹具辅助）', () => {
    const offenders = files
      .filter((f) => f !== 'helpers.js')
      .filter((f) => COMPRESS_CALL.test(source(f)))
      .map((f) => `${f} 直接调用了 ${COMPRESS_NAME}`);
    expect(offenders).toEqual([]);
  });

  it('反面夹具 `writeSingleFrameSession` 只允许本文件使用（其他文件禁止拿它当普通夹具）', () => {
    const offenders = files
      .filter((f) => f !== GUARD && f !== 'helpers.js')
      .filter((f) => /writeSingleFrameSession/.test(source(f)))
      .map((f) => `${f} 使用了反面夹具 writeSingleFrameSession`);
    expect(offenders).toEqual([]);
  });

  it('行为守卫：代表性夹具都是"帧1=header 独占 + ≥2 帧"（与官方写盘形状一致）', () => {
    const cases = [
      ['writeSession(validSessionEvents, {zstd:true})', () => writeSession(validSessionEvents(), { zstd: true }), linesOf()],
      ['writeSessionFrames(4 行)', () => writeSessionFrames(linesOf()), linesOf()],
      ['writeSessionFrames(1 事件)', () => writeSessionFrames(linesOf(HEADER, [validSessionEvents()[0]])), linesOf(HEADER, [validSessionEvents()[0]])],
    ];
    for (const [label, make, lines] of cases) {
      const { frames, torn } = framesPlain(make());
      expect(frames.length, `${label}: 帧数`).toBeGreaterThanOrEqual(2);
      expect(torn, `${label}: 不得是撕裂夹具`).toBe(false);
      const first = frames[0];
      expect(first.split('\n').filter((x) => x !== '').length, `${label}: 帧1 行数`).toBe(1);
      expect(first.endsWith('\n'), `${label}: 帧1 要有结尾换行`).toBe(true);
      expect(JSON.parse(first).type, `${label}: 帧1 是 header`).toBe('session');
      // 逐帧顺序拼接后与整份文本一致（不丢行、不重排、行数守恒）
      expect(frames.join(''), `${label}: 拼接后与原始文本一致`).toBe(`${lines.join('\n')}\n`);
    }
  });

  it('`zstdFramesOf` 确定性：同一输入两次得到逐字节相同的帧', () => {
    const a = zstdFramesOf(linesOf()).map((b) => b.toString('base64'));
    const b = zstdFramesOf(linesOf()).map((b) => b.toString('base64'));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);      // 不是单帧
  });

  it('`faithfulFrameInfo` 与真实文件同形（手搓 log 不得再声明"整份一帧"）', () => {
    const rows = validSessionEvents().length;
    const info = faithfulFrameInfo({ eventRows: rows });
    const real = loadSessionLog(writeSession(validSessionEvents(), { zstd: true })).frameInfo;
    expect(info.frames).toBe(real.frames);
    expect(info.firstFrameOneLine).toBe(real.firstFrameOneLine);
    expect(info.firstFrameLines).toBe(real.firstFrameLines);
    // 空事件时是"只有 header 的单帧"——那才是合法的 1 帧
    expect(faithfulFrameInfo({ eventRows: 0 }).frames).toBe(1);
  });

  it('守卫注入必红：一段"整份压一帧"的写法落在临时文件里 ⇒ 守卫判红', () => {
    // 用同一个构造词生成注入样本，再走同一条判定 ⇒ 证明"报红"这件事本身不是空转
    const injected = `import { ${COMPRESS_NAME} } from 'node:zlib';\nconst buf = ${COMPRESS_NAME}(Buffer.from(text));\n`;
    const root = mkdtempSync(join(tmpdir(), 'dlc-guard-'));
    const fake = join(root, 'bad.test.js');
    try {
      writeFileSync(fake, injected);
      const offenders = [fake].filter((f) => COMPRESS_CALL.test(readFileSync(f, 'utf8')));
      expect(offenders).toEqual([fake]);                            // 判红
      writeFileSync(fake, `import { ${['zstd', 'DecompressSync'].join('')} } from 'node:zlib';\n`);
      expect([fake].filter((f) => COMPRESS_CALL.test(readFileSync(f, 'utf8')))).toEqual([]);   // 解压不算
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('写回路径也必须保形（事故就是"重写时把整份压成一帧"造成的）', () => {
  // 这一组直接把事故路径钉住：任何"重写会话"的入口（fix/repair 的各个原语）产出物
  // 都必须仍满足 Z4/Z5。夹具是**保形**输入 ⇒ 写回后不许出现帧形状退化。
  const markerLines = () => [
    JSON.stringify(HEADER),
    JSON.stringify(userMessage({ seq: 0 })),
    JSON.stringify(assistantMessage({ seq: 1 })),
    JSON.stringify(markerEvent({ seq: 2, start: 0, end: 1, shadowedSeqs: [0, 1], turn: null, step: null })),
    JSON.stringify(userMessage({ seq: 3 })),
  ];

  for (const [label, opts] of [
    ['--remove-markers', { removeMarkers: true }],
    ['--neutralize', { neutralize: true }],
  ]) {
    it(`repairSession(${label}) 写回后仍保形：帧1=header 独占、≥2 帧、Z4/Z5 不报`, async () => {
      const { repairSession } = await import('../lib/repair.js');
      const file = writeSessionFrames(markerLines(), { name: 'rewrite' });
      const r = repairSession(file, { ...opts, apply: true, backupDir: mkdtempSync(join(tmpdir(), 'dlc-shape-')) });
      expect(r.applied).toBe(true);
      const after = loadSessionLog(file);
      expect(after.frameInfo.frames).toBeGreaterThanOrEqual(2);
      expect(after.frameInfo.firstFrameOneLine).toBe(true);
      const ids = idsOf(validateSessionLog(after));
      expect(ids).not.toContain('Z4');
      expect(ids).not.toContain('Z5');
    }, 30000);
  }

  it('事故复发形状：若写回时把整份重压成 1 帧 ⇒ 立刻 Z4+Z5（这正是当时漏掉的检查点）', () => {
    // 用"重写后文本"手工造出单帧版本，等价于当时那个错误动作的产物
    const file = writeSingleFrameSession(markerLines(), { name: 'rewrite-degraded' });
    const ids = idsOf(validateSessionLog(loadSessionLog(file)));
    expect(ids).toContain('Z4');
    expect(ids).toContain('Z5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('真机坏产物（存在则实测，不存在则跳过）', () => {
  // 事故现场那条坏产物按 `broken-singleframe-<ISO>` 命名。这里**按名字找**而不是写死绝对路径：
  // ① 每台机器位置不同；② 公开仓里不该出现本机路径/私有目录名。
  // 需要指向别处时用环境变量（例如把它拷到某个临时目录后 `LC_FRAME_FIXTURE_DIR=… npx vitest run`）。
  const CANDIDATE_DIRS = [
    process.env.LC_FRAME_FIXTURE_DIR,
    join(homedir(), '.dsh', 'sessions'),
  ].filter(Boolean);
  const findBroken = () => {
    for (const dir of CANDIDATE_DIRS) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (name.includes('broken-singleframe')) return join(dir, name);
      }
    }
    return null;
  };

  it('若本机留着那条坏产物 ⇒ Z4+Z5 必须报（否则规则对真实产物无效）', () => {
    const real = findBroken();
    if (real === null) {
      console.log('skip: 真机坏产物不在本机（按 broken-singleframe 名字未找到）');
      return;
    }
    const log = loadSessionLog(real);
    const ids = idsOf(validateSessionLog(log));
    expect(log.frameInfo.frames).toBe(1);        // 铁证：帧计数被压成 1
    expect(ids).toContain('Z4');
    expect(ids).toContain('Z5');
  });
});
