# dsh-log-contract · Log Contract Guard

> The **structural contract fuse** for DeepSeek Harness session logs: offline
> health check + pre-write validation. Formerly `log-contract-validator` (candidate
> #2); named **`dsh-log-contract`** per the OfferKuai three-piece plan.

A fuse for DSH session logs (`*.jsonl` / `*.jsonl.zstd`): format drift that humans
cannot see but parsers crash on is caught and reported here. It does **not** judge
whether log *content* is right — only whether log *structure* breaks the
expectations of downstream consumers (the Harness read path, the client engine,
plugin marker semantics).

- **`check <session-log>`** — offline health check: official decoder full decode +
  per-rule contract validation + foldSurface final verification, with a violation
  report.
- **`prewrite <edit-file> --log <session-log>`** — ★ pre-write validation: any
  write (append / frame-level surgery) passes the three-layer contract before it
  lands; violations are blocked.
- **`contracts`** — list the built-in contract rule catalog (each with its
  official source reference).

---

## Where it sits in the business layer

> **dsh-log-contract is the core capability component of
> [dsh-retrace](https://github.com/yamingmou/dsh-retrace)** — the "doctor" module
> of the business layer: session-log **check & repair**, so every recall/edit/rewind
> lands on a legal log and `/compact` never breaks.

| Layer | What it is | Components |
|---|---|---|
| **Agent business layer (production-grade)** | Framework-agnostic core: session hygiene / retraceability / auditability / recoverability | Four modules: governance / retrospect / archaeology / **doctor** |
| **dsh-retrace** | The business layer's DeepSeek Harness implementation | recall/edit/version/rollback/watchdog |
| **dsh-log-contract** | dsh-retrace's core component = the business layer's **doctor** (check & repair) | check / prewrite / fix / extract / audit |

**Meaning**: dsh-log-contract is published standalone (for direct use or
re-implementation), but it is first the "check & repair" capability of dsh-retrace —
together they form the **Agent business layer (production-grade guarantees)** on
DSH (see the [dsh-retrace roadmap](https://github.com/yamingmou/dsh-retrace/blob/main/docs/ROADMAP.md)).

---

## Why it exists

**#3632 "one log, two consumers, two verdicts"**: one log is consumed by both
humans and automated programs. Humans tolerate format drift; programs depend on
strict contracts. Once the format drifts, humans see nothing wrong while programs
crash or misreport.

**Real incidents shaped every rule here** — see the [Incident log](#-incident-log)
below. Each incident is a regression fixture: a corrupted session that this tool
must flag, and a fixed session that it must pass.

---

## Three-layer contract (the model)

> 30+ rules across the layers below (`contracts` lists them all, each with its
> official source reference).

| Layer | Contract | Rules |
|---|---|---|
| **Persistence** | seq strictly contiguous; type in the known vocabulary; surface events carry a legal `surfaceOp`; a replace's `sourceEventSeqs` must **fully cover** the shadowed nodes; **file-physical seq monotonic** (S9, multi-writer interleave evidence); official `foldSurface` not throwing = pass | H/R/E/S (incl. S5) + **S9** |
| **Client engine** | `assistant/message` with `turn/step = null` may only be carried as **replace** (plugin marker definition; append crashes the engine); **token-meter pairing** (T1, every `assistant/message` needs an open step); **cross-step source refs** (T2, referenced chunks must match turn/step); **inbox seed-relative replay** (I1, fork-boundary orphans) | M1 + **T1 / T2 / I1** |
| **Wire message flow** | tool messages must follow an assistant with tool_calls (dangling tools are rejected by strict endpoints); user text must not sit between tool_calls and their results | **W1 / W2** |
| **Plugin semantics** | marker id prefixes must be recognizable (legacy prefixes registered); a marker's own seq must not enter its own shadowed set | P1/P2 |

> Philosophy: first an incremental replay with official-equivalent semantics for
> **per-event attribution** (pinpoint seq/line), then the official `foldSurface` as
> the **final verdict** (not throwing = pass) — both green to pass.

---

## ⚡ Incident log — why "production-grade" is not a slogan

Every rule below was born from a **real incident** in our workspace. These are the
sessions that made us build this tool. Dates and shapes are real; session ids are
omitted for privacy.

| # | Date | What happened | The rule / fix it produced |
|---|---|---|---|
| 1 | 2026-08-25 | A "restore hidden content" repair wrote a replace marker with **emptied `sourceEventSeqs`** → the session refused to load (`SessionPersistenceCorruptionError`); a second attempt changed the marker to **append** → the client engine crashed. Both were **violating writes that nothing caught**. | **S5** (sourceEventSeqs must cover shadowed nodes), **M1** (turn-null assistant/message can only be replace), pre-write validation |
| 2 | 2026-08-27~28 | Interrupted/restarted turns replayed with a **stale in-memory cursor**, re-appending old seqs to the file tail (tail regression, duplicate batches); two writers interleaved → **file-physical order non-monotonic** (`734056 → 733539 → 735470`). Sessions failed to load with `seq gap`. | **S9** (physical-order monotonic), fix `--tail-renumber` |
| 3 | 2026-08-27~28 | **Fork-boundary orphan splice**: the fork's "remove parent's pending prompt" splice assumed the parent's inbox; the child's seed-relative replay has an empty inbox → `resume failed: invalid persisted inbox splice`. | **I1** (inbox seed-relative replay), fix `--neutralize-orphan` |
| 4 | 2026-08-28 | An oversized session (**1,052,557 tokens** vs the 1M window) could neither continue nor `/compact`; the trim budget estimator underpriced CJK by ~3.7×. | T1 (token-meter pairing) for compactability, `fix --trim` budget guidance |
| 5 | 2026-08-29 | **W1/W2 wire violations**: markers shadowed an assistant with tool_calls but left the tool results dangling → strict endpoints (`INVALID_REQUEST`) reject the session's request stream. | **W1 / W2** (wire message flow) |
| 6 | 2026-08-30 | A single **turn-null marker** made the token-meter listener throw on **every** appended event (`consumedEvents` never advanced → full-prefix re-fold per event) → **30s / 10,008 log lines**, host event loop crushed, all sessions locked. Same session also had a **cross-step sourceEventSeqs** (steps 7/8/9 mixed in one assistant message) — offline checks were green, the live meter crashed. | **T1** (turn/step pairing), **T2** (cross-step source refs), `fix --neutralize`, `fix --clip-crossstep` |

> **Takeaway**: every rule in this tool is a scar from a real session — validated
> against the actual corrupted-session fixtures, not synthetic theory. That is what
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
> **Downloaded the repo as a ZIP?** `cd dsh-log-contract && npm install && npm run build`,
> then `node bin/dsh-log-contract.mjs check <session-log>` — no global install needed.

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

  [error] S5 @ seq 156425 / line 778 (assistant/message)
      surface replace: sourceEventSeqs 必须覆盖每个被替换节点；缺失 121774, 121779（共 2 个）

❌ 未通过：见上方违规明细（error 级 = 会话不可读/不可写）
```

Exit code: 0 = pass (no error-level violations); 1 = error-level violations exist.

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
- `--neutralize`: in-place neutralization of turn-null markers (incident #6) —
  type → `retrace/marker` + `ignorable:true`, drops surfaceOp/sourceEventSeqs,
  seq/line count unchanged (safe while the session is resident).
- `--clip-crossstep`: trim cross-step sourceEventSeqs (incident #6) — keep only
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
dsh-log-contract extract <session-log> --pattern "seed-scale" --min-size 50 --out ./found

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
pnpm check && pnpm test    # syntax check + 79 unit tests (incl. incident regressions)
```

- **Synthetic fixtures** (in-repo): legal session / seq gap / empty sourceEventSeqs
  / turn-null append / unknown type / bad chunk row / torn tail frame / unknown
  marker prefix / self-shadowing etc.
- **Real fossils** (not in-repo, contain user data): run locally

```bash
node scripts/check-local-fossils.mjs   # scans ../ for backup-session-*.jsonl.zstd
```

Known truth table: incident-repaired sessions PASS; `seqgap`/`corrupt`/
`rewritten-230542` FAIL; `spliced-orphan` PASS (legal for the persistence layer —
#3632's "consumer path deems it unreadable" is a different contract; this tool only
guards the persistence contract layer, see the boundary note in
[docs/CONTRACTS.md](docs/CONTRACTS.md)).

---

## Roadmap

- [x] **Phase 1 (0.1.0)**: CLI offline check + pre-write validation + contract catalog
- [x] **Phase 1.5 (0.2.0)**: `fix` subcommand (strict seq scan + W1/W2 wire checks +
  marker removal with renumbering + official frame rebuild); CI integration
  (`dsh-log-contract check` as a scheduled guard over the Harness session dir)
- [x] **0.3.x (2026-08-30 incident hardening)**: T1 token-meter pairing → 0.3.1 W1/W2
  fold-position fix → 0.3.2 `tailSeq` → 0.3.3 `fix --neutralize` (in-place
  turn-null neutralization) → 0.3.4 `fix --clip-crossstep` (cross-step clipping) →
  0.3.5 **T2/S9/I1 rules** (cross-step source refs / physical order / inbox replay)
- [ ] Phase 2: runtime guard (subscribe to the session append stream, validate live,
  mark violations as `dsh/contract-violation`, policy configurable alert/block) —
  DSH plugin form
- [ ] Phase 3: link with dsh-turn-guard / dsh-retrace timeline

## License

MIT © OfferKuai Team

---

**English** · [简体中文](./README.zh.md)
