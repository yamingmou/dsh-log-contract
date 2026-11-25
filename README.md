<div align="center">

# 🔒 dsh-log-contract

**Log Contract Guard** — the structural fuse for DeepSeek Harness session logs:
offline health check + pre-write validation. The business layer's **doctor**.

[![npm version](https://img.shields.io/npm/v/dsh-log-contract)](https://www.npmjs.com/package/dsh-log-contract)
[![npm downloads](https://img.shields.io/npm/dm/dsh-log-contract)](https://www.npmjs.com/package/dsh-log-contract)
[![License: MIT](https://img.shields.io/npm/l/dsh-log-contract)](https://github.com/yamingmou/dsh-log-contract/blob/main/LICENSE)
[![DSH ecosystem](https://img.shields.io/badge/DSH-ecosystem-4A90D9)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/yamingmou/dsh-log-contract/pulls)

**English** · [简体中文](./README.zh.md)

</div>

## What it is

Formerly `log-contract-validator`; now **`dsh-log-contract`**.

A session log (`*.jsonl` / `*.jsonl.zstd`) has two readers: humans, who tolerate format
drift, and programs, which fail on it. This tool checks the **structure** of the log —
frame layout, event envelope, `seq` continuity, surface/replace rules, wire message order,
plugin markers — and answers one question with an exit code:

> **Will a downstream reader (the Harness read path, the client engine, plugin semantics)
> choke on this file — and if so, exactly where?**

It does **not** judge conversation content. It can also validate a write **before** it
lands: the same rule set runs as pre-write validation.

### In 30 seconds

- **What:** a checker for DSH session-log structure; input is one `.jsonl` / `.jsonl.zstd` file.
- **Why install it:** it catches drift that humans cannot see but parsers crash on, and it
  stops a bad write before it reaches disk.
- **Minimum usage:** three commands — see [Quick start](#quick-start-3-commands).
- **What makes it mechanically checkable:** every rule has a stable id, a severity, a source
  reference and positive/negative control cases; results are a stable JSON report plus a
  documented exit code.
- **Where to read more:** [rule catalog](docs/CONTRACTS.md) ·
  [report families](#rule-families-what-turns-red) ·
  [version map](VERSIONS.md) · [changelog](CHANGELOG.md).

## Where it sits in the business layer

> **`dsh-log-contract` is the core check-and-repair component of
> [dsh-retrace](https://github.com/yamingmou/dsh-retrace)** — the business layer's "doctor"
> module. It ensures that every recall / edit / rollback lands on a legal log:
> pre-write validation rejects error-level violations **before** anything is written.

| Layer | What it is | Components |
|---|---|---|
| **Agent business layer (production-grade)** | Framework-agnostic core: session hygiene / retraceability / auditability / recoverability | Four modules: governance / retrospect / archaeology / **doctor** |
| **dsh-retrace** | The business layer's DeepSeek Harness implementation | recall / edit / version / rollback / watchdog |
| **dsh-log-contract** | dsh-retrace's core component = the business layer's **doctor** (check & repair) | check / prewrite / fix / extract / audit-report |

**Meaning:** the package is published standalone (for direct use or re-implementation), but
it is first the "check & repair" capability of dsh-retrace — together they form the
**Agent business layer (production-grade guarantees)** on DSH.

**About `/compact` (stated honestly):** what this tool guarantees is that **new writes**
stop creating token-meter pairing debt — since two-segment atomic pairs (marker + paired
segment) landed, new markers pass T1 by construction. **Legacy** (single-segment) markers
remain **known design debt**: pre-write validation downgrades their T1 violation to a
warning (`legacyMarkerKindOf` in `lib/prewrite.js`, historical markers only), so such
sessions need **one check + cleanup before compaction** (`check` to locate →
`fix --remove-markers`). Otherwise the T1 self-check blocks `/compact`.

## Why it exists

**One log, two consumers, two verdicts.** Humans tolerate format drift; programs depend on
strict contracts. Once the format drifts, humans see nothing wrong while programs crash or
misreport.

**Most rules here were shaped by real corrupted sessions** — see the
[case log](#case-log--why-production-grade-is-not-a-slogan). Each case is pinned by a
regression test: a corrupt shape this tool must flag, and the repaired shape it must pass.
The remaining rules come from line-by-line verification against the official Host source
(every rule carries a `source` reference).

## Quick start (3 commands)

Requires **Node ≥ 22** (built-in zstd) and the peer package `@deepseek-ai/dsh-session`
(decode/fold semantics are reused from the host).

```bash
# 1. install (or use `pnpm dlx dsh-log-contract` without installing)
pnpm add -D dsh-log-contract

# 2. check a session log — machine-readable output
pnpm dlx dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --json

# 3. see every log-contract rule (id, severity, source)
pnpm dlx dsh-log-contract contracts
```

> **Using dsh-retrace?** No separate install is needed — it declares `dsh-log-contract` as a
> dependency, so the guard comes with the plugin. **Downloaded the repo as a ZIP?**
> `cd dsh-log-contract && npm install`, then run `node bin/dsh-log-contract.mjs check <log>`
> (no build step, no global install).

## What a check reports

```text
📋 dsh-log-contract check —— <file>
   事件 204754 ｜ surface 节点 16 ｜ replace 代数 5 ｜ 帧 8620
   违规 1（error 1 / warning 0）

  [error] S5 @ seq <seq> / line <line> (assistant/message)
      surface replace: sourceEventSeqs 必须覆盖每个被替换节点；缺失 121774, 121779（共 2 个）

❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）
```

### Exit codes

`check` uses `0 / 1 / 3 / 4` — **there is no `2`**. `error-contract` is a separate command
with its own codes.

| code | command | meaning |
|---|---|---|
| `0` | `check` | pass — no error-level violations, migration pre-check not blocked |
| `1` | `check` | error-level violations exist (a downstream reader would fail) |
| `3` | `check` | not assessable on this host (file format newer than host support) — **not** "broken" |
| `4` | `check` | migration pre-check blocked (the official upgrade chain would refuse the file) |
| `0 / 1 / 2` | `error-contract` | no findings (third-party findings are report-only) / error-level findings (T1, or T2 with `--strict`) / cannot judge (bad input) |

### Three-tier verdict (`check --resume`)

| tier | what it certifies | `--json` |
|---|---|---|
| `loadable` | the session can be read (structure rules) | `resume.loadable` |
| `resumable` | + inbox replay is valid | `resume.resumable` |
| `compactable` | + token-meter pairing is valid | `resume.compactable` |
| `broken` | fails the `loadable` tier | `resume.verdict` |
| `not-assessable` | this host cannot judge the file (exit 3) | `assessable: false` |

### What is *not* judged (never read as a pass)

`ok: null` / `skipped` means **unverifiable**, not success. The same rule applies to every
optional section:

| situation | field / value | how to read it |
|---|---|---|
| identity registry absent (npm install has no `docs/identity-registry.json`) | `identity.ok: null` | unverifiable — run identity checks in a source checkout / release pipeline |
| a run-contract assertion has no input | assertion `ok: null`, listed in `skipped` | unverifiable — provide the runtime record |
| archive reader not ready / unavailable | `archive.verdict: "unverifiable"` (`notReady`, `unavailable`) | **not** "content missing"; retry when the reader is up |
| host too old for the file format | `assessable: false`, exit 3 | not a health verdict |
| last frame cut mid-write | `summary.tailStatus: interrupted / truncated / unknown` | `ok: true` only certifies the events actually read |

**Tail boundary:** `ok: true` never promises the file is complete. A torn tail
(`interrupted`) is recoverable by the host reader; `truncated` means data is actually
missing; `unknown` means the tail could not be read.

## Three-layer contract (the model)

> **72 rules in four report families**: **57 log-contract rules** across the layers below
> (each with an official source reference), plus **6 error-expression** (E1–E6),
> **2 version-identity** (ID1/ID2) and **7 run-contract** rules. `contracts` lists the 57
> log-contract rules; the other families live in their own documents.

| Layer | Rules | What it guards |
|---|---|---|
| **Persistence** | H/R/E/S (incl. **S5**) + **S9** | `seq` contiguous; known types; legal `surfaceOp`; `sourceEventSeqs` fully covers shadowed nodes; file-physical `seq` monotonic; `foldSurface` does not throw |
| **Client engine** | **M1** + **T1 / T2 / I1** | turn-null markers only as replace; token-meter pairing; cross-step source refs; inbox seed-relative replay |
| **Wire message flow** | **W1 / W2** | tool messages follow an assistant with tool_calls; no user text between tool_calls and their results |
| **Plugin semantics** | **P1 / P2** | marker id prefixes are recognizable; a marker's seq is not in its own shadowed set |
| **Framing** | **Z1–Z8** | zstd frame shape (header owns the first frame; no single-frame recompression), empty sessions, tail completeness, frame size/checksum |
| **Reader / aggregation** | **R4 / R5** | a single damaged file degrades to a structured, countable result (never throws, never aborts enumeration); aggregation isolates failures per item |

> Philosophy: first an incremental replay with official-equivalent semantics for
> **per-event attribution** (pinpoint `seq` / line), then the official `foldSurface` as the
> **final verdict** (not throwing = pass) — both must be green.

## Rule families (what turns red)

Every rule has a stable id, a severity, a source reference and **positive/negative control
cases** (a violating sample must fail, a compliant one must pass). The four families are
dispatched by `family` and must not be merged by bare id.

| family | rules | guards | full list |
|---|---|---|---|
| **log contract** | **57** | persisted session logs: frames (Z), header (H), storage rows (R), envelope/`seq` (E), surface (S), client engine (T/M/I), wire order (W), markers (P), concurrency (C), migration (G), archive (A) | [docs/CONTRACTS.md](docs/CONTRACTS.md) |
| **error-expression** | **6** (E1–E6) | error handling as a contract: one code with many causes, constant messages, terminal-word misuse, swallowed `cause`, unconditional success, claimed-but-unenforced invariants | [docs/ERROR-CONTRACT.md](docs/ERROR-CONTRACT.md) |
| **version-identity** | **2** (ID1–ID2) | *is the artifact you run the one the version promises?* ID1 one version ↔ one digest; ID2 the digest is computed from the artifact and bound to `package.json.version` | [docs/interface-versioning.md](docs/interface-versioning.md) |
| **run-contract** | **7** | *will it silently change while running?* R-1 failure latched; R-2a failed write never marked complete; R-2b withdrawal needs a consumer-readable reason; R-2b-2 initializing ≠ "none"; R-3 missing input ⇒ incompatible; R-5 closed sets exhaustive / open sets tolerant; R-6 side effects idempotent per stable key | [docs/RUN-CONTRACT.md](docs/RUN-CONTRACT.md) |

Total: **72** assertions (57 + 6 + 2 + 7). The run-contract ids are **not** a contiguous
1…7 sequence — the code ids are `R-1 / R-2a / R-2b / R-2b-2 / R-3 / R-5 / R-6` (that is all
seven). S9 (log family) additionally reports a diagnosis category
(`old-cursor-replay` / `concurrent-writer` / `format-mix`) with a confidence and the decision
basis; the S9 verdict itself is unchanged.

## Identity contract (ID1 / ID2) — "is what runs what you think it is?"

A **separate report family** (`version-identity`): not counted in the 57 log-contract rules,
and **not part of `ok` / exit codes** — it answers whether the artifact you run is the one
the declared version promises.

| Rule | What it guards |
|---|---|
| `ID1` | **One version, one digest**: the registry (`docs/identity-registry.json`) must not map one version to two different content digests ⇒ red with `file:line` evidence (duplicate entries sharing the same digest do not fire). |
| `ID2` | **The number is verifiable**: the digest is computed **from the artifact** — runtime identity = `lib/**/*.js` + `bin/**/*.mjs`, per-file sha256 → sorted → sha256 — and bound to `package.json.version`. Unregistered version, mismatched or **forged** digest, or *same version after a code change* ⇒ red. **Doc-only changes keep the digest unchanged ⇒ green** (no noise). |

`check --json` exposes it as the `identity` section (`family`, `rules`, `ok`, `version`,
`digest`, `runtime`, `registry`, `findings[]` with `file:line`, `summary`); `identity.ok` is
`null` (**unverifiable**, never "pass") when the registry is absent — npm tarballs ship
`docs/**/*.md` only. After a version bump or a runtime-code change, re-register:
`pnpm identity:register` (source checkout only; the npm package does not ship `scripts/`).

## Runtime contract (7 rules) — "will it silently change while running?"

A **separate report family** (`run-contract`, exposed as `check --json` → `runContract`), again
outside `ok` / exit codes. It ships assertion helpers for real run records:

| Rule | Assertion | What it guards |
|---|---|---|
| `R-1` | `assertFailureLatched(history)` | a failure is **latched**: after `failed: true`, no later snapshot (recover / reload / cache clear) may write `failed: false` |
| `R-2a` | `assertWriteOutcome({ write, artifact })` | a failed or unknown write must never leave the artifact marked `complete` — withdraw it or mark it `partial` / `unavailable` / `withdrawn` |
| `R-2b` | `assertWithdrawalHasReason({ withdrawals, reasonField?, reasonSupported? })` | a withdrawal response must carry a **consumer-readable reason**; a reason only in logs/telemetry is red; no such field ⇒ `ok: null` |
| `R-2b-2` | `assertInitializedNotTreatedAsEmpty({ resources })` | a resource still initializing (or unavailable) must not be judged as "none"; no initialization signal ⇒ `ok: null` |
| `R-3` | `assertFailClosed({ required, provided, result })` | any missing required input (field / file / context) ⇒ the verdict must be **incompatible**, with a visible reason naming the missing input |
| `R-5` | `assertClosedSetExhaustive({ closedSet, covered })` / `assertOpenSetTolerant({ openSet, observations })` | own closed sets must be exhaustive (missing / extra values are red); external open sets must not be exhausted — unknown values must be traced, allowed by default and upgradeable |
| `R-6` | `assertIdempotentSideEffects({ operations, keyField? })` | side effects execute at most once per stable idempotency key; later attempts must be cached / explicitly duplicated; no stable key ⇒ `ok: null` |

`checkRunContract({...})` runs them together and lists assertions you did not supply under
`skipped`; when **none** ran, `ok` is `null` (unverifiable — never "pass"). Usage,
positive/negative examples and open items are in [docs/RUN-CONTRACT.md](docs/RUN-CONTRACT.md).

## Version support (host / session format)

**Tested baseline (the versions this rule set was verified against):**

| Item | Baseline | Note |
|---|---|---|
| Host package | `@deepseek-ai/dsh-session@0.2.0-rc.2` | the version this rule set is developed and CI-tested against |
| Session format | **v4** (`SESSION_FORMAT_VERSION = 4`) | v4 uses the runtime vocabulary + official `foldSurface` final check |
| Declared range | `^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1` | installable — a declared range is **not** a per-version verification |
| Known formats | 0 / 1 / 2 / 3 / 4 | 0–2 are supported by this package's **vendored** vocabulary + local equivalent fold (`legacyFoldSurface`), independent of the host |

**What happens on unverified versions (detected at runtime — never silently judged by stale rules):**

| Case | Behaviour |
|---|---|
| Host **newer than the baseline** | explicit **warning**; the verdict is still produced but flagged as possibly not applicable |
| Host older than the baseline (still in peer range) | notice + the host-capability check decides whether the file's format is assessable (`SESSION_FORMAT_VERSION` too low ⇒ `not-assessable`, exit 3) |
| **Unknown** session format (not in 0/1/2/3/4) | reported as **unverified format** and handled **read-only**: `check` runs structure rules only; `prewrite` / `fix` **refuse** (exit 3) |
| Format **unrecognisable** (no `header.version`, no distinguishing shapes) | same: "unverified format" + read-only |
| File version above the host's supported maximum | `not-assessable` (**not** broken), exit 3; skipped/executed rules are listed |

Implementation: `lib/version-support.js` (`TESTED_BASELINE` / `detectSupport()`), exported in
the public API; the `--json` `support` field carries the same baseline and warnings.

## CLI

After install, `dsh-log-contract` is on the PATH through your package manager (the examples
below use `pnpm exec`; `pnpm dlx dsh-log-contract …` works without installing).

### 1. Offline health check

```bash
pnpm exec dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd
pnpm exec dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --json   # machine-readable
pnpm exec dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --resume # three-tier verdict
```

`check` also runs **W1/W2 wire-level checks**: expand the model request stream in surface
order and catch "dangling tool messages" (a tool result with no preceding assistant
tool_calls) and "user text between tool_calls and their results" — tolerated by some
endpoints, `INVALID_REQUEST` on strict ones.

### 1.1 Error-expression scan (`error-contract`)

Static scan of *how errors are raised* (source text; no AST). This is the **6-rule
error-expression family** (E1–E6): one code with many causes · constant message · terminal
word on a non-terminal cause · `cause` not surfaced · unconditional success (candidate) ·
claims with no enforcement point (candidate).

```bash
pnpm exec dsh-log-contract error-contract lib/ bin/ --json              # T1 (our code): hits ⇒ exit 1
pnpm exec dsh-log-contract error-contract <pkg>/lib/index.js --target T2 # T2 (third-party): report only, exit 0
pnpm exec dsh-log-contract error-contract lib/ --keys thresholdRatio,headroom
pnpm exec dsh-log-contract error-contract lib/ --config cordis.patch.yml
```

⚠️ **Output is a suspicion list, not a verdict**: the rules are heuristics and necessarily
carry false positives — every finding ships raw `evidence` for human review; whitelist
entries must carry an `expires` date (missing/invalid/expired ⇒ exit 2, fail-closed). Full
criteria: [docs/ERROR-CONTRACT.md](docs/ERROR-CONTRACT.md).

### 2. Repair (`fix`)

```bash
# Dry run (report only): strict seq scan + full contract check + removable-marker count
pnpm exec dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers

# Apply: backup first, then write (.zstd rebuilt in official frame format:
# frame 1 = header, following frames = batches, checksum, single trailing newline)
pnpm exec dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers --apply
```

- `--remove-markers`: remove retrace/message-editor markers and renumber everything
  (`seq` / `seq0` / `sourceEventSeqs` / `surfaceOp` in sync) — for large marker-shadowed
  history or markers that left dangling tools.
- `--neutralize`: in-place neutralization of turn-null markers — type → `retrace/marker` +
  `ignorable: true`, drops `surfaceOp` / `sourceEventSeqs`, `seq` / line count unchanged
  (safe while the session is resident).
- `--clip-crossstep`: trim cross-step `sourceEventSeqs` — keep only same-turn/step chunk
  references.
- Surgery safety: back up first, re-verify after (strict scan + check + `foldSurface`);
  markers may only shadow earlier nodes; a marker must never become append (M1 crashes the
  client engine).
- ⚠️ If the session is resident in a running app, **restart the app** after fixing the file
  (hard-kill to avoid dirty state flushing back).

### 3. Pre-write validation (`prewrite`)

`edit-file` is JSON with two shapes:

```jsonc
// Append one event to the log tail (seq omitted = auto-assigned as nextSeq)
{ "append": { "type": "assistant/message", "surfaceOp": { "op": "replace", "start": 121774, "end": 156421 }, "sourceEventSeqs": [121774, 121779], "data": { "turn": null, "step": null, "message": {}, "editor": { "targetSeq": 156430, "text": "…" } } } }

// Frame-level surgery: the complete event list after the edit
{ "edit": [ "…the full event list…" ] }
```

```bash
pnpm exec dsh-log-contract prewrite marker-write.json --log ~/.dsh/sessions/<id>.jsonl.zstd
```

- A baseline with error-level violations is rejected outright (the pre-surgery baseline must
  be green).
- `seq` must be **omitted** (auto-assigned as `nextSeq`) or exactly `nextSeq` — a
  self-invented `seq` is rejected (`E11`); on the file side, delete-without-renumber and
  invented `seq` show up as gaps and are caught by `E2` / `S9`.
- Only a pass may land — **validate first, commit later** (the same idea as the official
  `SurfaceManager.validateNext`).

### 4. Contract catalog

```bash
pnpm exec dsh-log-contract contracts            # 57 log-contract rules with sources
pnpm exec dsh-log-contract explain S9 --json   # one rule: title, criteria, control pointers
```

Full catalog: [docs/CONTRACTS.md](docs/CONTRACTS.md).

### 5. Session archaeology (`extract` / `audit-report`)

Every tool call's full input/output is persisted in the session log — a data and audit
asset. Read-only archaeology:

```bash
# Export tool outputs matching a command regex (original text preserved)
pnpm exec dsh-log-contract extract <session-log> --pattern "build-report" --min-size 50 --out ./found

# Audit report: call count / pairing rate / orphans / command distribution
pnpm exec dsh-log-contract audit-report <session-log>
```

Contract rules **P3** (tool/call ↔ tool/result pairing integrity) and **P4** (output
structure parseable) keep the dig working: orphan calls and abnormal `text` fields are
flagged in `check`.

## Case log — why "production-grade" is not a slogan

Each entry is a **real log-corruption shape** from production sessions — the cases that
shaped this tool. Dates and shapes are real; session ids and file names are omitted.

| # | Date | What happened | The rule / fix it produced |
|---|---|---|---|
| 1 | 2026-08-25 | A "restore hidden content" repair wrote a replace marker with **emptied `sourceEventSeqs`** → the session refused to load (`SessionPersistenceCorruptionError`); a second attempt changed the marker to **append** → the client engine crashed. Both were violating writes that nothing caught. | **S5** (sourceEventSeqs must cover shadowed nodes), **M1** (turn-null assistant/message can only be replace), pre-write validation |
| 2 | 2026-08-27~28 | Interrupted/restarted turns replayed with a **stale in-memory cursor**, re-appending old seqs to the file tail (tail regression, duplicate batches); two writers interleaved → **file-physical order non-monotonic** (`734056 → 733539 → 735470`). Sessions failed to load with `seq gap`. | **S9** (physical-order monotonic), `fix --tail-renumber` |
| 3 | 2026-08-27~28 | **Fork-boundary orphan splice**: the fork's "remove parent's pending prompt" splice assumed the parent's inbox; the child's seed-relative replay has an empty inbox → `resume failed: invalid persisted inbox splice`. | **I1** (inbox seed-relative replay), `fix --neutralize-orphan` |
| 4 | 2026-08-28 | An oversized session (**1,052,557 tokens** vs the 1M window) could neither continue nor `/compact`; the trim budget estimator underpriced CJK by ~3.7×. | **T1** (token-meter pairing) for compactability, `fix --trim-budget` guidance |
| 5 | 2026-08-29 | **W1/W2 wire violations**: markers shadowed an assistant with tool_calls but left the tool results dangling → strict endpoints (`INVALID_REQUEST`) reject the request stream. | **W1 / W2** (wire message flow) |
| 6 | 2026-08-30 | A single **turn-null marker** made the token-meter listener throw on **every** appended event (`consumedEvents` never advanced → full-prefix re-fold per event) → **30s / 10,008 log lines**, host event loop crushed, all sessions locked. The same session also had a **cross-step `sourceEventSeqs`** (steps 7/8/9 mixed in one assistant message) — offline checks were green, the live meter crashed. | **T1** (turn/step pairing), **T2** (cross-step source refs), `fix --neutralize`, `fix --clip-crossstep` |
| 7 | 2026-08-31 | A log was compressed as a **single zstd frame** (or the header did not form its own frame) → different readers disagreed on record boundaries. | **Z4 / Z5** (first frame = exactly one header line; body framed) |
| 8 | 2026-08-31 | A log whose **last zstd frame was torn** mid-write could not be loaded at all, with no diagnosis. | **Z1** + explicit "torn tail / in-flight write" reporting |
| 9 | 2026-09-09 | On **session format v4**, `tool/result` uses `role: 'tool'` and `system/message` carries a `system-prompt` source → v3-shaped checks produced **thousands of false errors on healthy v4 logs**. | version dispatch + **E6 / E9** v4 semantics |
| 10 | 2026-09-17 | On **Windows**, `header.cwd` was judged with POSIX-only rules → **every** session flagged by **H2**. | platform-aware absolute-path check |
| 11 | 2026-10-20 | A **> 500 MB session** crashed the reader (`ERR_STRING_TOO_LONG`) and repair built the whole text in memory. | line-wise decode + streaming frame rebuild |
| 12 | 2026-10-20 | Two-segment carrier references were written with the audit segment first while an earlier convention started at the range start → readers reported hundreds of **false orphan carriers**. | **P5** write-side pairing + tolerant read-side |
| 13 | 2026-10-20 | `seedLength` was read as a **byte size** by some consumers (it is the number of inherited events), and `parentSession` with missing/0 was treated as corruption. | **I2** semantics pinned |
| 14 | 2026-10-20 | An **unknown but explicitly ignorable** event type blocked an entire migration. | **G4** declarative skip + allow-list |
| 15 | 2026-10-26 | A **truncated zstd frame** made the session-header reader throw `ERR_OUT_OF_RANGE`; with no per-item isolation the whole enumeration/summary run failed (hundreds of failures over 33 days) — one damaged file sank the whole batch. | **R4** (read/parse tolerance: structured, countable result), **R5** (per-item isolation + failure counting) |
| 16 | 2026-10-26 | A file whose **last frame was cut mid-write** still reported `ok=true` — the check certifies only the events it actually read. | **Z6** (`tailStatus: complete/interrupted/truncated/unknown`) + the documented tail boundary |
| 17 | 2026-10-26 | Producers **inventing `seq` on the write side**, and **deleting rows without renumbering**. | **E11** (`seq` assigned by the log layer only; pre-write rejects self-invented `seq`), gap traces pinned to `E2` / `S9` |

> **Takeaway:** these rules are not synthetic theory — each one is pinned by a regression
> test that reproduces the corrupt shape it guards against. That is what "production-grade"
> means here.

## Node API (embed pre-write validation in your script)

```js
import { loadSessionLog, validateSessionLog, createPreWriter } from 'dsh-log-contract';

// ① Baseline check (the pre-surgery baseline must be green)
const log = loadSessionLog('session.jsonl.zstd');
const baseline = validateSessionLog(log);
if (!baseline.ok) throw new Error('baseline is broken; repair it first');

// ② Pre-write validation: about to write a marker replace
const prewriter = createPreWriter({ events: log.events.map((e) => e.event) });
const verdict = prewriter.validateAppend({
  type: 'assistant/message',
  surfaceOp: { op: 'replace', start: 121774, end: 156421 },
  sourceEventSeqs: [121774, 121779], // must fully cover shadowed nodes
  data: { turn: null, step: null, message: {} },
});
if (!verdict.ok) {
  for (const v of verdict.violations) console.error(v.id, v.message);
  process.exit(1); // do not land
}
// ③ Only a pass writes
```

## Versioning and compatibility

Three independent axes:

| axis | where it lives | current |
|---|---|---|
| package version | npm / `package.json` | see the badge above |
| session format version | `header.version` in the log | v0–v4 |
| report structure version | `schemaVersion` in `check --json` | **`"6"`** |

`schemaVersion` history (each step is additive; old consumers ignore unknown keys):

| version | added | compatible reading |
|---|---|---|
| `"1"` | base `check` report | pre-field reports are read as `"1"` |
| `"2"` | S9 diagnosis fields (`category` / `confidence` / `hint` / `basis` / `diagnosis`) | v1 consumers can ignore the added fields |
| `"3"` | `identity` section (version-identity) | v2 consumers ignore the section |
| `"4"` | `runContract` section (3 rules) | v3 consumers ignore the section |
| `"5"` | run-contract +R-2b / R-6 (5 rules) | v4 consumers ignore new rule entries |
| `"6"` | run-contract +R-2b-2 / R-5 (7 rules); archive `unverifiable` on not-ready readers | v5 consumers ignore new rule entries |

- Package version, session format version and report schema version are **not**
  interchangeable; a docs-only change does not change the rule set or `schemaVersion`.
- Version map: [VERSIONS.md](VERSIONS.md). Per-release notes: [CHANGELOG.md](CHANGELOG.md).
- Host support: tested against `@deepseek-ai/dsh-session` **0.2.0-rc.2**; declared peer range
  `^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1`. A file newer than the host
  supports is reported as *not assessable* (exit 3, read-only), never judged by stale rules.

## FAQ

**Does `ok: true` mean the session is "usable"?** It means *nothing this rule set looks at
is broken*. It does not promise content quality; when the file needs a format migration the
assessment scope is `partial` — the migration dimension is only partly covered (`--json` →
`assessmentScope` / `migration.coverage.uncovered`).

**The tail is cut off — why still green?** The check certifies only what it read. Read
`summary.tailStatus`: `interrupted` (torn tail, recoverable) is not the same as `truncated`
(records actually missing).

**What is the identity digest for?** It catches "same version number, different content" —
the class of bug where consumers silently run an old build. The registry is
`docs/identity-registry.json`; re-register with `pnpm identity:register` after a version bump
or runtime-code change (source checkout only). In an npm install the registry is absent, so
`identity.ok` is `null` — unverifiable, never "pass".

**What does S9's diagnosis mean?** Besides the violation itself, S9 reports a cause category:
`old-cursor-replay` (stale in-memory cursor resumed after a tail rewrite), `concurrent-writer`
(two writers interleaved) or `format-mix` (legacy and modern event shapes mixed), with a
confidence and a decision basis (`category` / `confidence` / `hint` / `basis`); the verdict
does not change.

**How are the rules verified?** Every rule ships positive/negative controls; the suite also
runs a rules self-test (registry completeness, id binding, per-rule coverage, and "every
emitted id is registered"). See [Tests](#tests).

## Tests

```bash
pnpm check && pnpm test   # doc drift check + full suite (positive/negative controls + rules self-test)
```

- **Synthetic fixtures** (in-repo): legal session / seq gap / empty `sourceEventSeqs` /
  turn-null append / unknown type / bad chunk row / torn tail frame / unknown marker prefix /
  self-shadowing.
- **Negative controls are mandatory**: every rule must have a violating sample that turns red
  and a compliant sample that stays green.
- **Rules self-test**: registry completeness, `violation(id)` binding, per-rule coverage (or
  an explicit justified delegation), and "every emitted id is registered".

## License

MIT © OfferKuai Team
