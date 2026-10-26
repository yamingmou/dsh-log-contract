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

Formerly `log-contract-validator`; now **`dsh-log-contract`**.

A fuse for DSH session logs (`*.jsonl` / `*.jsonl.zstd`): format drift that humans
cannot see but parsers crash on is caught and reported here. It does **not** judge
whether log *content* is right — only whether log *structure* breaks the
expectations of downstream consumers (the Harness read path, the client engine,
plugin marker semantics).

- **`check <session-log>`** — offline health check: official decoder full decode +
  per-rule contract validation + foldSurface final verification, with a violation
  report and a machine-readable **tail-completeness** field (`tailStatus`).
- **`prewrite <edit-file> --log <session-log>`** — ★ pre-write validation: any
  write (append / frame-level surgery) passes the three-layer contract before it
  lands; violations are blocked (including self-invented `seq` values).
- **`contracts`** — list the built-in contract rule catalog (each with its
  official source reference).
- **`check --resume`** — three-tier verdict (`loadable` / `resumable` /
  `compactable`, plus `not-assessable` when the host cannot judge the file).
- **`fix` / `extract` / `audit-report`** — repair primitives and read-only
  session archaeology.

**Capabilities at a glance**: session formats **v0–v4** · 55 contract rules ·
exit-code contract `0/1/3/4` · three-tier verdicts · pre-write validation ·
per-rule negative-control tests + rules self-test · tolerant reading (a single
damaged file degrades to structured results and is counted, never thrown).

---

## Where it sits in the business layer
> **dsh-log-contract is the core capability component of [dsh-retrace](https://github.com/yamingmou/dsh-retrace)** (the business layer's "doctor" module): it **checks and repairs** session logs so every recall/edit/rollback lands on a legal log — pre-write validation (`prewrite`) rejects error-level violations **before** anything is written.
>
> **About `/compact` (stated honestly)**: what this tool guarantees is that **new writes** stop creating token-meter pairing debt — since two-segment atomic pairs (marker + paired segment) landed, new markers pass T1 by construction. **Legacy** (single-segment) markers are still **known design debt**: pre-write validation downgrades their T1 violation to a warning (`legacyMarkerKindOf` in `lib/prewrite.js`, which applies to **historical markers only**), so such sessions need **one check + cleanup before compaction** (`check` to locate → `fix --remove-markers`; the plugin side calls this "the doctor"). Otherwise the T1 self-check blocks `/compact`.

| Layer | What it is | Components |
|---|---|---|
| **Agent business layer (production-grade)** | Framework-agnostic core: session hygiene / retraceability / auditability / recoverability | Four modules: governance / retrospect / archaeology / **doctor** |
| **dsh-retrace** | The business layer's DeepSeek Harness implementation | recall/edit/version/rollback/watchdog |
| **dsh-log-contract** | dsh-retrace's core component = the business layer's **doctor** (check & repair) | check / prewrite / fix / extract / audit-report |

**Meaning**: dsh-log-contract is published standalone (for direct use or
re-implementation), but it is first the "check & repair" capability of dsh-retrace —
together they form the **Agent business layer (production-grade guarantees)** on
DSH (see the [dsh-retrace repository](https://github.com/yamingmou/dsh-retrace)).

---

## Why it exists
**"one log, two consumers, two verdicts"**: one log is consumed by both
humans and automated programs. Humans tolerate format drift; programs depend on
strict contracts. Once the format drifts, humans see nothing wrong while programs
crash or misreport.

**Real log-corruption shapes found in production sessions shaped most of the rules here** —
see the [Case log](#case-log--why-production-grade-is-not-a-slogan) below. The case-derived instances are pinned by regression tests: a corrupt log shape
this tool must flag, and the repaired shape it must pass. The remaining rules come from
line-by-line verification against the official Host source (each rule carries its
`source`).

---

## Three-layer contract (the model)
> 55 rules across the layers below (`contracts` lists them all, each with its
> official source reference).

| Layer | Rules | What it guards |
|---|---|---|
| **Persistence** | H/R/E/S (incl. **S5**) + **S9** | seq contiguous, known types, legal `surfaceOp`, `sourceEventSeqs` fully covers shadowed nodes, file-physical seq monotonic, `foldSurface` not throwing |
| **Client engine** | **M1** + **T1 / T2 / I1** | turn-null markers only as replace; token-meter pairing; cross-step source refs; inbox seed-relative replay |
| **Wire message flow** | **W1 / W2** | tool messages follow an assistant with tool_calls; no user text between tool_calls and results |
| **Plugin semantics** | P1/P2 | marker id prefixes recognizable; a marker's seq not in its own shadowed set |
| **Framing** | Z1–Z6 | zstd frame shape (header own first frame; no single-frame re-compression), empty-shell sessions, **tail completeness (`tailStatus`)** |
| **Reader / aggregation** | **R4 / R5** | a single damaged file must degrade to a structured, countable result (never throw, never abort enumeration); aggregation APIs isolate failures per item |

> Philosophy: first an incremental replay with official-equivalent semantics for
> **per-event attribution** (pinpoint seq/line), then the official `foldSurface` as
> the **final verdict** (not throwing = pass) — both green to pass.

---

## Version support (host / session format)
**Tested baseline (the versions this rule set was verified against)**:

| Item | Baseline | Note |
|---|---|---|
| Host package | `@deepseek-ai/dsh-session@0.2.0-rc.2` | the version this rule set is developed and CI-tested against (CI runs `pnpm check` + `pnpm test`; the four `prepublishOnly` steps are green locally on it) |
| Session format | **v4** (`SESSION_FORMAT_VERSION = 4`) | v4 uses the runtime vocabulary + official `foldSurface` final check |
| Declared range | `peerDependencies: ^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.2.0-rc.1` | installable — a declared range is **not** a per-version verification |
| Known formats | 0 / 1 / 2 / 3 / 4 | 0–2 are supported by this package's **vendored** vocabulary + local equivalent fold (`legacyFoldSurface`), independent of the host |

**What happens on unverified versions (detected and reported at runtime — never silently judged by stale rules)**:

| Case | Behaviour |
|---|---|
| Host **newer than the baseline** | explicit **warning** (`host … is newer than the tested baseline …`); the verdict is still produced but flagged as possibly not applicable |
| Host older than the baseline (still in peer range) | notice + the host-capability gate decides whether the file's format is assessable (`SESSION_FORMAT_VERSION` too low ⇒ `not-assessable`, exit 3) |
| **Unknown** session format (not in 0/1/2/3/4) | reported as **unverified format** and handled **read-only**: `check` runs structure rules only; `prewrite` / `fix` **refuse** (exit 3) |
| Format **unrecognisable** (no `header.version` and no distinguishing event shapes) | same: "unverified format" + read-only |
| File version above the host's supported maximum | `not-assessable` (**not** broken), exit 3; skipped/executed rules are listed |

Implementation: `lib/version-support.js` (`TESTED_BASELINE` / `detectSupport()`, exported in the public API).
Both the human-readable `check` output and the `--json` `support` field carry the baseline summary and the warnings, e.g.:

```
version support: host @deepseek-ai/dsh-session@0.2.0-rc.2 (baseline 0.2.0-rc.2) | file format v4 (header, baseline)
```

## 🆕 0.3.28 · Reader tolerance, tail completeness, seq provenance
Four rules distilled from recent production failures (each pinned by a
negative-control test — a violating sample must turn red, a compliant one green):

| Rule | Checks | Severity |
|---|---|---|
| `R4` | read/parse tolerance: a single damaged file (torn zstd frame, corrupt line, bad chunk row, empty file) must degrade to a **structured, countable** result (`null` / per-row `error` markers / `frameInfo` facts) — never throw and never abort an enumeration/summary run | error |
| `R5` | aggregation/summary APIs isolate failures **per item** (per-item `try/catch` + a `skipped` counter); one bad item must not sink the batch | error |
| `E11` | `seq` is assigned by the log layer's continuous cursor only: a pre-write candidate must omit `seq` (auto-assigned) or carry exactly `nextSeq`; producer-side `seq` invention / delete-without-renumber shows up as gaps ⇒ `E2`/`S9` | error |
| `Z6` | tail completeness must be declared: `tailStatus: complete \| interrupted \| truncated \| unknown` (see the known boundary below) | warning |

Also in 0.3.28: **rules self-test** — the registry, the tests and the generated
docs are cross-checked (`test/rules-self-test.test.js`): every rule must be
referenced by a control or a binding assertion in the tests (or carry an
explicit, justified delegation entry; the red/green strength of each control is
owned by that rule's own negative-control cases); every emitted violation id
must be registered. `summary.unreadableRows` and
`summary.tailStatus` are new machine-readable fields.

**Known boundary (stated honestly)**: `check` / `check --json` guarantee that
**the events actually read** are self-consistent — they do **not** guarantee the
file tail is intact. A file whose last frame was cut mid-write can still come
back `ok=true`; read `summary.tailStatus` (`--json`) to know the tail state.
`tailStatus` values: `complete` (tail intact) · `interrupted` (torn zstd tail —
in-flight/interrupted write; the host reader keeps complete records and drops
the unfinished tail, so it is recoverable) · `truncated` (the tail record itself
is cut — data is missing) · `unknown` (undecidable: unreadable/empty file).
`Z6` reports the non-`complete` states as a warning and deliberately does not
flip `ok`.

## 🆕 0.3.18 – 0.3.24 · DSH 0.2.x (session format v4) support
**Session format v4** (`@deepseek-ai/dsh-session` 0.2.x) is now validated by format-version dispatch
rather than by relaxing the format gate:

- `tool/result` is validated with the v4 shape (`role: 'tool'`, no `tool-result` wrapper block)
- `system/message` accepts v4's `source.kind: 'system-prompt'`
- validation for v3 and earlier is **unchanged** (identical verdicts on 408 real v3 sessions before/after)
- the format gate still rejects **unknown** future versions (`readOnly`); v5+ remains unassessable by design

**Rules (55 total as of 0.3.28):** the five rules below were added in the
0.3.18 – 0.3.24 window (see above for the 0.3.28 additions):

| Rule | Checks |
|---|---|
| `G4` | unknown historical events may be declaratively skipped (`ignorable: true`; allow-list injectable) |
| `S10` | `sourceEventSeqs` elements: non-negative integers after decoding (official interval pairs allowed in storage) |
| `I2` | `seedLength` means *number of inherited events* (not bytes); `parentSession` + missing/0 is legal |
| `P5` | two-segment carrier pairing: 2nd segment's first seq == 1st segment seq (read side accepts the legacy order) |
| `A1` | "in-place restorable" is judged from structured fields only (`archiveRef` / `archive` / `externalized.*`) — never from free text |

**Large sessions:** reading is line-wise (no whole-file stringification ⇒ no `ERR_STRING_TOO_LONG` above ~536 MB),
and repair rebuilds `.jsonl.zstd` with streaming frames (header frame + chunked body frames, per-frame checksum + round-trip).

**Windows:** the `header.cwd` absolute-path check in `H2` is platform-aware (`win32` and `posix` both accepted).

**Compatibility:** Node ≥ 22; `@deepseek-ai/dsh-session` `^0.1.0-rc.7 || ^0.1.5-rc.1 || ^0.2.0-rc.1`; session formats v0–v4.

## Case log — why "production-grade" is not a slogan
Each entry below is a **real log-corruption shape** from production sessions — the cases that
shaped this tool. Dates and shapes are real; session ids and file names are
omitted.

| # | Date | What happened | The rule / fix it produced |
| --- | --- | --- | --- |
| 1 | 2026-08-25 | A "restore hidden content" repair wrote a replace marker with **emptied `sourceEventSeqs`** → the session refused to load (`SessionPersistenceCorruptionError`); a second attempt changed the marker to **append** → the client engine crashed. Both were **violating writes that nothing caught**. | **S5** (sourceEventSeqs must cover shadowed nodes), **M1** (turn-null assistant/message can only be replace), pre-write validation |
| 2 | 2026-08-27~28 | Interrupted/restarted turns replayed with a **stale in-memory cursor**, re-appending old seqs to the file tail (tail regression, duplicate batches); two writers interleaved → **file-physical order non-monotonic** (`734056 → 733539 → 735470`). Sessions failed to load with `seq gap`. | **S9** (physical-order monotonic), fix `--tail-renumber` |
| 3 | 2026-08-27~28 | **Fork-boundary orphan splice**: the fork's "remove parent's pending prompt" splice assumed the parent's inbox; the child's seed-relative replay has an empty inbox → `resume failed: invalid persisted inbox splice`. | **I1** (inbox seed-relative replay), fix `--neutralize-orphan` |
| 4 | 2026-08-28 | An oversized session (**1,052,557 tokens** vs the 1M window) could neither continue nor `/compact`; the trim budget estimator underpriced CJK by ~3.7×. | T1 (token-meter pairing) for compactability, `fix --trim-budget` guidance |
| 5 | 2026-08-29 | **W1/W2 wire violations**: markers shadowed an assistant with tool_calls but left the tool results dangling → strict endpoints (`INVALID_REQUEST`) reject the session's request stream. | **W1 / W2** (wire message flow) |
| 6 | 2026-08-30 | A single **turn-null marker** made the token-meter listener throw on **every** appended event (`consumedEvents` never advanced → full-prefix re-fold per event) → **30s / 10,008 log lines**, host event loop crushed, all sessions locked. Same session also had a **cross-step sourceEventSeqs** (steps 7/8/9 mixed in one assistant message) — offline checks were green, the live meter crashed. | **T1** (turn/step pairing), **T2** (cross-step source refs), `fix --neutralize`, `fix --clip-crossstep` |
| 7 | 2026-08-31 | A log was compressed as a **single zstd frame** (or the header did not form its own frame) → different readers disagreed on record boundaries ⇒ **Z4/Z5** frame-shape rules (first frame = exactly one header line; body framed) |  |
| 8 | 2026-08-31 | A log whose **last zstd frame was torn** mid-write could not be loaded at all, with no diagnosis ⇒ **Z1** + explicit "torn tail / in-flight write" reporting |  |
| 9 | 2026-09-09 | On **session format v4**, `tool/result` uses `role: 'tool'` and `system/message` carries a `system-prompt` source → v3-shaped checks produced **thousands of false errors on healthy v4 logs** ⇒ version dispatch + **E6/E9** v4 semantics |  |
| 10 | 2026-09-17 | On **Windows**, `header.cwd` was judged with POSIX-only rules → **every** session flagged by **H2** ⇒ platform-aware absolute-path check |  |
| 11 | 2026-10-20 | A **> 500 MB session** crashed the reader (`ERR_STRING_TOO_LONG`) and repair built the whole text in memory ⇒ line-wise decode + streaming frame rebuild |  |
| 12 | 2026-10-20 | Two-segment carrier references were written with the audit segment first while an earlier convention started at the range start → readers reported hundreds of **false orphan carriers** ⇒ **P5** write-side pairing + tolerant read-side |  |
| 13 | 2026-10-20 | `seedLength` was read as a **byte size** by some consumers (it is the number of inherited events), and `parentSession` with missing/0 was treated as corruption ⇒ **I2** semantics pinned |  |
| 14 | 2026-10-20 | An **unknown but explicitly ignorable** event type blocked an entire migration ⇒ **G4** declarative skip + allow-list |  |
| 15 | 2026-10-26 | A **truncated zstd frame** made the session-header reader throw `ERR_OUT_OF_RANGE`, and because there was no per-item isolation the whole enumeration/summary run failed (hundreds of failures over 33 days) — **one damaged file sank the whole batch** | **R4** (read/parse tolerance: degrade to a structured, countable result), **R5** (per-item isolation + failure counting in aggregation APIs) |
| 16 | 2026-10-26 | A file whose **last frame was cut mid-write** still reported `ok=true` — the check certifies only the events it actually read | **Z6** (`tailStatus: complete/interrupted/truncated/unknown`) + the documented tail-completeness boundary |
| 17 | 2026-10-26 | Producers **inventing `seq` on the write side**, and **deleting rows without renumbering** | **E11** (`seq` assigned by the log layer only; pre-write rejects self-invented `seq`), gap traces pinned to `E2`/`S9` |

> **Takeaway**: these rules are not synthetic theory — each one is pinned by a
> regression test that reproduces the corrupt shape it guards against. That is what
> "production-grade" means here.

---

## Installation
```bash
pnpm add -D dsh-log-contract   # or npm install
pnpm dlx dsh-log-contract --help
```

> **Using dsh-retrace?** No separate install needed — `dsh-retrace` declares
> `dsh-log-contract` as a dependency, so the contract guard (check / pre-write /
> repair primitives) comes with the plugin automatically. This package is published
> standalone for direct use or re-implementation.
>
> **Downloaded the repo as a ZIP?** `cd dsh-log-contract && npm install`, then
> `node bin/dsh-log-contract.mjs check <session-log>` — no build step and no global install needed.

Dependencies: Node ≥ 22 (`node:zlib` has built-in zstd), `@deepseek-ai/dsh-session`
(peer; validation/decode reuse the official implementation, so it stays in sync
with the Harness read path).

---

## CLI
### 1. Offline health check

```bash
dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd
dsh-log-contract check ~/.dsh/sessions/<id>.jsonl.zstd --json   # machine-readable
```

Sample output (the CLI reports in Chinese — it is the tool's UI language):

```
📋 dsh-log-contract check —— backup-session-xxxx.jsonl.zstd
   事件 204754 ｜ surface 节点 16 ｜ replace 代数 5 ｜ 帧 8620（3439.5KiB → 8191.3KiB）
   违规 1（error 1 / warning 0）

  [error] S5 @ seq <seq> / line <line> (assistant/message)
      surface replace: sourceEventSeqs 必须覆盖每个被替换节点；缺失 121774, 121779（共 2 个）

❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）
```

**Exit-code contract** (there is no exit code `2`):

| Code | Meaning |
|---|---|
| `0` | pass — no error-level violations (and the migration pre-check is not blocked) |
| `1` | error-level violations exist (session unreadable/unwritable under this rule set) |
| `3` | not assessable on this host (file format newer than the host supports) — **not** "broken" |
| `4` | the migration pre-check is blocked (the official upgrade chain will refuse the file) |

**Three-tier verdict** (`check --resume`, also in `--json` as `resume`):
`loadable` (structure green) ⊂ `resumable` (+ `I1` inbox replay green) ⊂
`compactable` (+ `T1`/`T2` token-meter pairing green); a file failing the first
tier is reported as `broken`, and `not-assessable` is a separate fourth state
when the host cannot judge the file.

**Tail-completeness boundary**: `ok=true` only certifies that *the events actually
read* are self-consistent — see the `tailStatus` note in the 0.3.28 section above.

`check` adds **W1/W2 wire-level checks** since 0.2.0: expand the model request
stream in surface order and catch "dangling tool messages" (a tool result with no
preceding assistant tool_calls) and "user text between tool_calls and their
results" — tolerated by some endpoints, `INVALID_REQUEST` on strict ones
(MiMo, verified 2026-08-27).

### 2. Repair (`fix`)

```bash
# Dry run (report only): strict seq scan + full contract check + removable-marker count
dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers

# Apply: backup first, then write (.zstd rebuilt in official frame format: frame1=header,
# frame2=rest, checksum, single trailing newline)
dsh-log-contract fix ~/.dsh/sessions/<id>.jsonl.zstd --remove-markers --apply
```

- `--remove-markers`: remove retrace/message-editor markers and renumber everything
  (seq/seq0/sourceEventSeqs/surfaceOp in sync) — for large marker-shadowed history
  or markers that left dangling tools.
- `--neutralize`: in-place neutralization of turn-null markers (case #6) —
  type → `retrace/marker` + `ignorable:true`, drops surfaceOp/sourceEventSeqs,
  seq/line count unchanged (safe while the session is resident).
- `--clip-crossstep`: trim cross-step sourceEventSeqs (case #6) — keep only
  same-turn/step chunk references.
- Surgery safety protocol: back up first, re-verify after (strictScan + check +
  foldSurface); markers may only shadow earlier nodes; a marker must never become
  append (M1 crashes the client engine).
- ⚠️ If the session is resident in a running app, **restart the app** after fixing
  the file (hard-kill to avoid dirty state flushing back).

### 3. Pre-write validation (`prewrite`)

`edit-file` is JSON with two shapes:

```jsonc
// Append one event to the log tail (seq omitted = auto-assigned as nextSeq)
{ "append": { "type": "assistant/message", "surfaceOp": { "op": "replace", "start": 121774, "end": 156421 }, "sourceEventSeqs": [121774, 121779, "…"], "data": { "turn": null, "step": null, "message": { "…": "…" }, "editor": { "targetSeq": 156430, "text": "…" } } } }

// Frame-level surgery: the complete event list after the edit (both baseline and
// result must be green before it may land)
{ "edit": [ "…full event list…" ] }
```

```bash
dsh-log-contract prewrite marker-write.json --log ~/.dsh/sessions/<id>.jsonl.zstd
```

- A baseline with error-level violations is rejected outright (safety protocol
  step 2: **the pre-surgery baseline must be green**).
- `seq` must be **omitted** (auto-assigned as `nextSeq`) or exactly `nextSeq` —
  a self-invented `seq` is rejected (`E11`); on the file side, delete-without-
  renumber and invented `seq` show up as gaps and are caught by `E2`/`S9`.
- Only a pass may land — **validate first, commit later** (same idea as the
  official `SurfaceManager.validateNext`).

### 4. Contract catalog

```bash
dsh-log-contract contracts
```

Full catalog in [docs/CONTRACTS.md](docs/CONTRACTS.md).

### 5. Session archaeology (`extract` / `audit-report`)

Every tool call's full input/output is persisted in the session log — a data and
audit asset. Read-only archaeology:

```sh
# Export tool outputs matching a command regex (original text preserved)
dsh-log-contract extract <session-log> --pattern "build-report" --min-size 50 --out ./found

# Archaeology audit report: call count / pairing rate / orphans / command distribution
dsh-log-contract audit-report <session-log>
```

Contract rules P3 (tool/call↔tool/result pairing integrity) and P4 (output
structure parseable) keep the dig working: orphan calls and abnormal `text` fields
are flagged in `check`.

---

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
  sourceEventSeqs: [121774, 121779 /* …must fully cover shadowed nodes… */],
  data: { turn: null, step: null, message: { /* … */ } },
});
if (!verdict.ok) {
  for (const v of verdict.violations) console.error(v.id, v.message);
  process.exit(1); // do not land
}
// ③ Only a pass writes
```

---

## Tests
```bash
pnpm check && pnpm test    # syntax check + contract-doc drift gate + all unit tests
```

- **Synthetic fixtures** (in-repo): legal session / seq gap / empty sourceEventSeqs
  / turn-null append / unknown type / bad chunk row / torn tail frame / unknown
  marker prefix / self-shadowing etc.
- **Negative controls are mandatory**: every rule must have a violating sample
  that turns red and a compliant sample that stays green (the incident-derived
  fixtures above double as those controls).
- **Rules self-test** (`test/rules-self-test.test.js`): registry completeness,
  `violation(id)` binding, test coverage per rule (or an explicit justified
  delegation), and "every emitted id is registered" — so a rule cannot exist
  without a control, and a control cannot reference a rule that was never
  registered.

> **Scope of the published package**: it contains the runtime code and documentation only.
> Local maintainer tooling is not part of the public repository, so `pnpm check` and `pnpm test`
> work from a clean clone.

## Local git hooks (opt-in)
The repository ships `.githooks/pre-push` (runs `pnpm check` before pushing), but it is
**not active automatically on clone** — point Git at it explicitly:

```bash
git config core.hooksPath .githooks   # enable
git config --get core.hooksPath       # verify: should print .githooks
```

Skip only for emergencies: `git push --no-verify`. Uninstall: `git config --unset core.hooksPath`.

> Hooks are local convenience, not a trust boundary: CI (`.github/workflows/ci.yml`) runs
> `pnpm check` / `pnpm check:strict` / `pnpm test`, so clones without hooks stay gated.

Verdict by **log shape** — what the tool must say about each defect class, not about
any particular file:

| Log shape | Verdict | Rules that fire |
|---|---|---|
| seq gap, or non-monotonic file-physical order | FAIL | S8 / C1 / T1 / E2 (plus S9 when seq goes backwards) |
| a rewrite that introduces a gap | FAIL | S8 / C1 / T1 / E2 / I1 |
| invalid inbox splice + turn-null marker | FAIL | T1 / I1 |
| pre-fix shape: legacy turn-null markers still present | FAIL | T1 |
| a multi-thousand-span replace marker with full coverage | PASS | error 0 — data-legal, official `foldSurface` replays cleanly |

Rule evolution moves rows: 0.3.5 added I1, which flipped the "invalid inbox splice"
shape from PASS to FAIL. And "a repaired session passes" holds only for the repaired
artifact — the pre-repair form of the same session is normally still a FAIL. See the
boundary note in [docs/CONTRACTS.md](docs/CONTRACTS.md).

---

## ⚠️ Upgrading — behaviour notes (0.3.12 → 0.3.28)

### 0.3.24 → 0.3.28 in one paragraph

Four rules were added (`R4`/`R5` read tolerance and aggregation isolation,
`E11` seq provenance on the write side, `Z6` tail completeness) and three
machine-readable fields appeared in `--json` (`summary.tailStatus`,
`summary.tailStatusReason`, `summary.unreadableRows`). Behaviour changes are narrow: `check` now emits a
`Z6` **warning** when the tail is not `complete` (verdicts and exit codes are
unchanged — a torn tail is recoverable under the host reader semantics), and
`prewrite` rejects a candidate that carries a self-invented `seq` (`E11`, error).
Rule count: 51 → 55.

### 0.3.18 → 0.3.24 in one paragraph

Session format **v4** (host `dsh-session` 0.2.x) is supported by version dispatch (`tool/result` role,
`system/message` source); five rules were added (`G4` unknown-but-ignorable events, `S10` reference element
types, `I2` `seedLength` semantics, `P5` carrier pairing, `A1` structured-only in-place restorability);
large sessions (> 500 MB) are read line-wise and repaired with streaming frames; the Windows absolute-path
check for `H2` is platform-aware. still **partial** — see the changelog's known-gap list). Verdicts, exit codes and `--json` fields are unchanged.

> **0.3.17 changes no behaviour.** It only adjusts the wording of comments, test titles, a few
> diagnostic strings and the README. Every verdict, exit code and `--json`
> field is unchanged from 0.3.15, so everything below applies unchanged when going from 0.3.12 to 0.3.17.
>
> 0.3.15 was a documentation-only release as well.

**1. New exit codes `3` / `4` — a defect fix that is also a breaking change.**
- `3` = **not assessable on this host**: the file's `header.version` is higher than the host supports
  (e.g. checking a v3 log under `@deepseek-ai/dsh-session@0.1.0-rc.7`). Instead of reporting `broken`,
  the tool now says the host lacks the capability, and `fix --apply` **refuses** the file (nothing written, no backup).
- `4` = **migration pre-check blocked**: the tool judges that the official upgrade chain will refuse the file.
- ⚠️ **Pipelines that treated `exit 0` as "fine" will now fail.** The old behaviour returned `0` even for files
  the tool itself reported as refused by the official chain — a false negative where the exit code contradicted
  the verdict. `--fail-on-migration` is an **explicit alias of the (now default) behaviour**; the **real opt-out
  is `--no-fail-on-migration`**, which restores the 0.3.11 behaviour (structural green ⇒ `exit 0`). When both
  flags are given, the opt-out wins. You can also ignore the exit code and read `assessmentScope` /
  `migration.ready` from `--json` with your own threshold.

**2. `--json` gains `assessmentScope` (three values).**

| value | meaning |
|---|---|
| `full` | file is already the host's target format (no migration) — coverage is complete |
| `partial` | file needs migration ⇒ the migration pre-check covers **2 rules only; 6 classes are uncovered** (≠ pass; see `coverage.uncovered`) |
| `none` | **not assessable on this host** — no "usable / upgradable" claim is certified |

Under `partial` the CLI no longer prints an unconditional green: both the migration line and the last line say
the migration dimension is only partially covered.

**3. What "the health check passed" does *not* mean.**
The rule set is **not** the official upgrade chain's acceptance condition. `assessmentScope=partial` means
"the part this tool looked at is clean" — it does **not** mean the official upgrade will accept the file.
Read `coverage.uncovered` for the known gaps.

## Roadmap
- [x] **Phase 1 (0.1.0)**: CLI offline check + pre-write validation + contract catalog
- [x] **Phase 1.5 (0.2.0)**: `fix` subcommand (strict seq scan + W1/W2 wire checks +
  marker removal with renumbering + official frame rebuild); CI integration
  (`dsh-log-contract check` as a scheduled guard over the Harness session dir)
- [x] **0.3.x (2026-08-30 case hardening)**: T1 token-meter pairing → 0.3.1 W1/W2
  fold-position fix → 0.3.2 `tailSeq` → 0.3.3 `fix --neutralize` (in-place
  turn-null neutralization) → 0.3.4 `fix --clip-crossstep` (cross-step clipping) →
  0.3.5 **T2/S9/I1 rules** (cross-step source refs / physical order / inbox replay)
- [x] **0.3.6 → 0.3.15**: per-version rule routing for v0–v3 (T3/T4/T5, L3–L5, E8/E9/E10),
  exit codes `3`/`4` for the host-capability and migration gates, and a version-support
  report that says what was *not* verified (see [CHANGELOG.md](CHANGELOG.md))
- [ ] Phase 2: runtime guard (subscribe to the session append stream, validate live,
  mark violations as `dsh/contract-violation`, policy configurable alert/block) —
  DSH plugin form
- [ ] Phase 3: link with dsh-turn-guard / dsh-retrace timeline

## License
MIT © OfferKuai Team

---
