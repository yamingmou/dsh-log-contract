# Architecture — platform-agnostic contract + platform adapters

This package validates session-log contracts. It is split in two layers so that a **new host platform**
requires only a new adapter, not a rewrite of the contract.

```
adapters/<platform>/   ──depends on──▶   contract/
```

## `contract/` — platform-agnostic

| Module | Responsibility |
|---|---|
| `verdict.js` | violation/verdict model: id, severity, source citation, message |
| `invariants.js` | platform-neutral invariants (ordinality, sequence continuity, physical order, lossless payloads, record head, empty containers, in-place restorability, …) |
| `rules.js` | rule-descriptor schema; every descriptor declares the invariant it enforces |
| `registry.js` | rule catalog installation and lookup (holds no rule content itself) |
| `index.js` | the contract-layer public surface |

**Hard rule:** `contract/` must contain **zero platform vocabulary** and must not import any adapter or
implementation module. This is machine-enforced (`scripts/check-core-purity.mjs`), run by
`pnpm check` and `pnpm check:strict` (also in CI and in `.githooks/pre-push`).

## `adapters/<platform>/` — platform-specific

For the reference platform (`adapters/dsh/`): event shapes (turns/steps/chunks/tool pairing),
format versions v0–v4 routing, zstd framing, surface/fold semantics, migration records, host probes,
and the vocabulary tables. Rule data lives here and is registered into the contract layer at load time.

## Adding a platform (current status: in progress)

1. Implement an adapter: event shapes, format-version routing, framing, surface operations, vocabulary.
2. Register its rule catalog through `contract/registry.js`.
3. Reuse `contract/invariants.js` unchanged; add invariants only if the guarantee is genuinely
   platform-neutral (and every new invariant must be referenced by at least one rule).

**Honest status:** the split is extracted and machine-enforced; the platform-neutral orchestration entry now
exists in `contract/runner.js` (`runContract`), and `lib/validate.js` is a [n]-line composition root that only
declares the DSH adapter. A second adapter therefore needs the three interfaces
(`validateShape` / `invariants` / `ruleIds`) plus a composition root — it is **not** zero-code, and 19 of the
28 invariants are still only labels that an adapter must implement.

## Guarantees kept while migrating

- Same 51 rules, same verdicts, same exit codes as before the split.
- Zero regression on real v3 sessions (violation signatures unchanged).
- `contract/` and `adapters/` ship in the npm package (`files`).

### 跨平台复用分类（互斥三分）

| 类别 | 数量 | 判据 |
|---|---|---|
| **A. 不变量已实现且平台无关** | **9 个不变量 / 14 条规则** | `contract/invariants.js` 有实现，且其语义不依赖宿主事件模型（record.head-declared、record.parsable、seq.present、seq.contiguous、seq.monotonic、value.json-lossless、container.empty-explicit、seq.single-writer、content.restorable） |
| **B. 仅有标签、需 adapter 实现** | **37 条规则** | 不变量在 `INVARIANT_REGISTRY` 标 `implemented:false`，由 adapter 提供实现 |
| **C. 绑定宿主事件模型、换平台须重写语义** | **14 条**（S1,S8,T3,T4,T5,Z1,Z2,Z4,Z5,G1–G4） | 语义围绕宿主的视图/帧/迁移概念 |

**注意**：`A1`（在位可还原）**只算"判定逻辑已下沉"**，其指针抽取与完整性语义仍由 adapter 提供 ⇒ **不计入 A 类**（此前"14 条可复用"的分类作废）。

**中性模型的维度来源**：`kind`、`severity`、`layer`、`source` 为平台无关维度；`eventType` 定位字段与 `INVARIANTS` 中的 frame/migration/view 概念**来自宿主语义**，作为"分析维度"保留，换平台时需由 adapter 提供等价维度映射。
