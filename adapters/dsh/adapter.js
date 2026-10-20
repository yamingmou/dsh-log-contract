/**
 * dsh-log-contract · adapters/dsh/adapter.js
 *
 * DSH 适配器的**编排声明**：把既有判定实现组装成 platform-neutral runner 的 pipeline。
 *
 * 本文件只做三件事（不新增任何判定逻辑）：
 * 1. 声明执行顺序（与重构前 `lib/validate.js` 的插入顺序逐条对齐，保证同键判定顺序不变）；
 * 2. 形状归一：契约层中立判定在边界经 `toPlatformViolations` 映射回平台规则 id；
 * 3. 捕获[internal]输出所需的中间读数（replay/fold/ignorableDrops/archive/continuity）。
 *
 * 目标态：平台无关的遍历/映射/排序/聚合由 `contract/runner.js` 执行；
 * 本文件只提供"DSH 要跑哪些判定、按什么顺序跑"。
 */
import {
  emptyContainerViolation,
  recordHeadViolations,
  recordParsabilityViolations,
  sequenceContinuityViolations,
  singleWriterDiagnostic,
} from '../../contract/invariants.js';
import { toPlatformViolations, violation as platformViolation } from './rule-ids.js';
import {
  archiveVerdict,
} from './archive.js';
import {
  chunkRowMalformationViolations,
  envelopeViolations,
  ignorableTypeViolations,
  physicalOrderViolations,
  rawSourceEventSeqViolations,
  sourceEventSeqElementViolations,
  toolPairingViolations,
  toolResultStructureViolations,
} from './event-shapes.js';
import {
  declarativeIgnorableViolations,
  finalFold,
  headerFieldViolations,
  migrationPrecheckViolations,
  seedLengthViolations,
} from './format-versions.js';
import { frameViolations } from './frames.js';
import {
  carrierPairingViolations,
  engineViolations,
  inboxReplayViolations,
  nullTurnStepViolations,
  pluginViolations,
  replaySurface,
  stepKeyViolations,
  tokenMeterSourceViolations,
  tokenMeterViolations,
  turnEndReasonViolations,
  wireViolations,
} from './surface.js';

/** 把"一组平台判定"包成 runner 步骤返回值。 */
const group = (violations) => ({ violations });

/**
 * 创建 DSH 适配器。
 *
 * @param {{
 *   mode?: 'assessable'|'unassessable',
 *   events: Array<{ event: object, lineNo: number }>,
 *   rows: Array<object>,
 *   header: object|null,
 *   headerLine: number,
 *   frameInfo: object|undefined,
 *   formatVersion: number,
 *   baseSeq?: number,
 *   ignorableWhitelist?: string[],
 *   archiveRoots?: string[],
 * }} context
 * @returns {object} contract/runner 适配器
 */
export function createDshAdapter(context) {
  const {
    mode = 'assessable',
    events,
    rows,
    header,
    headerLine,
    frameInfo,
    formatVersion,
    baseSeq = 0,
    ignorableWhitelist,
    archiveRoots,
  } = context;

  const loc = (event, lineNo) => ({ seq: event.seq, lineNo, eventType: event.type });
  const eventLocs = () => events.map(({ event, lineNo }) => loc(event, lineNo));

  // ── 共同步骤：帧 / 头 / 行 / 序号 / 引用 ────────────────────────────────
  const assessmentSteps = {
    head: () => ({
      violations: [
        ...toPlatformViolations(recordHeadViolations(header, headerLine, { expectedFamily: 'session' }).violations),
        ...headerFieldViolations(header, headerLine),
        ...toPlatformViolations(emptyContainerViolation(header !== null, events.length, headerLine).violations),
      ],
    }),
    rows: () => ({
      violations: [
        ...toPlatformViolations(recordParsabilityViolations(rows).violations),
        ...chunkRowMalformationViolations(rows),
      ],
    }),
  };

  if (mode === 'unassessable') {
    // 能力不足分支：只跑与版本无关的结构检查（E3 词表判定跳过；帧布局类 Z4/Z5 跳过）。
    const continuities = () => sequenceContinuityViolations(eventLocs(), { baseSeq });
    const archive = archiveVerdict(events, { archiveRoots });
    return {
      id: 'dsh',
      mode,
      validateShape: (record) => ({ violations: [] }),
      invariants: {},
      ruleIds: {},
      toPlatform: toPlatformViolations,
      pipeline: [
        { type: 'phase', name: 'frame', run: () => group(frameViolations(frameInfo, rows, { layout: false })) },
        { type: 'phase', name: 'head', run: assessmentSteps.head },
        { type: 'phase', name: 'rows', run: assessmentSteps.rows },
        {
          type: 'phase',
          name: 'envelope',
          run: () => group((() => {
            const out = [];
            for (const { event, lineNo } of events) {
              out.push(...envelopeViolations(event, loc(event, lineNo), formatVersion).filter((v) => v.id !== 'E3'));
            }
            return out;
          })()),
        },
        {
          type: 'phase',
          name: 'sequence',
          run: () => ({
            violations: [
              ...toPlatformViolations(continuities().violations),
              ...physicalOrderViolations(rows),
            ],
            continuityBroken: continuities().broken,
          }),
        },
        { type: 'phase', name: 'inbox', run: () => group(inboxReplayViolations(events, header)) },
        { type: 'phase', name: 'pairing', run: () => group([...toolPairingViolations(events), ...toolResultStructureViolations(events)]) },
        {
          type: 'phase',
          name: 'reference',
          run: () => group([...rawSourceEventSeqViolations(rows), ...sourceEventSeqElementViolations(events)]),
        },
        { type: 'phase', name: 'seed', run: () => group(seedLengthViolations(header, events.map((e) => e.event), formatVersion)) },
        { type: 'phase', name: 'archive', run: () => ({ violations: archive.violations, archive }) },
        {
          type: 'phase',
          name: 'record-shape',
          run: () => {
            const out = [];
            for (const { event, lineNo } of events) {
              const eventLoc = loc(event, lineNo);
              out.push(...engineViolations(event, eventLoc), ...pluginViolations(event, eventLoc));
            }
            return group(out);
          },
        },
        {
          type: 'when',
          name: 'single-writer',
          when: (ctx, metadata) => metadata.continuityBroken === true,
          run: () => group(toPlatformViolations(singleWriterDiagnostic(true, 'seq 缺口/倒退是多写入者并发写的典型后果').violations)),
        },
      ],
    };
  }

  // ── 可评估分支：与重构前插入顺序逐条对齐 ────────────────────────────────
  const continuityState = () => sequenceContinuityViolations(eventLocs(), { baseSeq });
  return {
    id: 'dsh',
    mode,
    validateShape: (record) => ({ violations: [] }),
    invariants: {},
    ruleIds: {},
    toPlatform: toPlatformViolations,
    pipeline: [
      { type: 'phase', name: 'frame', run: () => group(frameViolations(frameInfo, rows)) },
      { type: 'phase', name: 'head', run: assessmentSteps.head },
      { type: 'phase', name: 'rows', run: assessmentSteps.rows },
      {
        type: 'phase',
        name: 'reference',
        run: () => group([...rawSourceEventSeqViolations(rows), ...sourceEventSeqElementViolations(events)]),
      },
      { type: 'phase', name: 'seed', run: () => group(seedLengthViolations(header, events.map((e) => e.event), formatVersion)) },
      {
        type: 'phase',
        name: 'envelope',
        run: () => {
          const out = [];
          for (const { event, lineNo } of events) out.push(...envelopeViolations(event, loc(event, lineNo), formatVersion));
          return group(out);
        },
      },
      {
        type: 'phase',
        name: 'sequence',
        run: () => {
          const continuity = continuityState();
          return {
            violations: [
              ...toPlatformViolations(continuity.violations),
              ...physicalOrderViolations(rows),
            ],
            continuityBroken: continuity.broken,
          };
        },
      },
      {
        type: 'phase',
        name: 'view',
        run: () => {
          const replay = replaySurface(events, formatVersion);
          return { violations: replay.violations, replay };
        },
      },
      {
        type: 'phase',
        name: 'terminal-view',
        run: () => {
          const fold = finalFold(events.map((e) => e.event), formatVersion);
          const violations = fold.error
            ? [platformViolation('S8', { lineNo: null }, `foldSurface 重放失败（按文件版本选：v3 官方 / v0–v2 本地等价）：${fold.error.message} —— 会话加载会被拒（SessionPersistenceCorruptionError）`)]
            : [];
          return { violations, fold };
        },
      },
      { type: 'phase', name: 'meter', run: () => group([...tokenMeterViolations(events), ...tokenMeterSourceViolations(events)]) },
      {
        type: 'phase',
        name: 'render-scope',
        run: () => group([...stepKeyViolations(events), ...nullTurnStepViolations(events), ...turnEndReasonViolations(events)]),
      },
      { type: 'phase', name: 'type-consumers', run: () => group(ignorableTypeViolations(events, formatVersion)) },
      { type: 'phase', name: 'inbox', run: () => group(inboxReplayViolations(events, header)) },
      { type: 'phase', name: 'pairing', run: () => group([...toolPairingViolations(events), ...toolResultStructureViolations(events)]) },
      { type: 'phase', name: 'wire', run: () => group(wireViolations(events, formatVersion)) },
      {
        type: 'phase',
        name: 'record-shape',
        run: () => {
          const out = [];
          for (const { event, lineNo } of events) {
            const eventLoc = loc(event, lineNo);
            out.push(...engineViolations(event, eventLoc), ...pluginViolations(event, eventLoc));
          }
          return group(out);
        },
      },
      { type: 'phase', name: 'carrier', run: () => group(carrierPairingViolations(events, { version: formatVersion })) },
      {
        type: 'when',
        name: 'single-writer',
        when: (ctx, metadata) => metadata.continuityBroken === true,
        run: () => group(toPlatformViolations(singleWriterDiagnostic(true, 'seq 缺口/倒退是多写入者（≥2 个 Host 进程共享同一 session 目录）并发写的典型后果；离线体检无法观测竞态本身，但此痕迹需人工核查').violations)),
      },
      { type: 'phase', name: 'migration', run: () => group(migrationPrecheckViolations(events, formatVersion, { ignorableWhitelist })) },
      {
        type: 'phase',
        name: 'declared-skip',
        run: () => {
          const ignorableDrops = declarativeIgnorableViolations(events, formatVersion, { ignorableWhitelist });
          return { violations: ignorableDrops.violations, ignorableDrops };
        },
      },
      {
        type: 'phase',
        name: 'externalized',
        run: () => {
          const archive = archiveVerdict(events, { archiveRoots });
          return { violations: archive.violations, archive };
        },
      },
    ],
  };
}
