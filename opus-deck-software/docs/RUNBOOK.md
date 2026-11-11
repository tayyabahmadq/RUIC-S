# Opus//DECK Runbook

A multi-model orchestration plugin for opencode. A user supplies one brief
and a goal state, and a crew of AI models builds the software.

This runbook is written for someone who has never seen this project.

---

## 1. Install

```bash
cd opus-deck-software
npm install
```

Requires Node 20+. Plain `npm` is blocked by PowerShell execution policy on
some Windows machines; use `npm.cmd` instead:

```bash
npm.cmd install
```

Runtime dependency: `zod` only. Dev dependencies: `@types/node`, `typescript`.
No frameworks. Tests: `node:test`.

---

## 2. Key setup

### Environment / keystores

Model API keys resolve in this order:
1. The env var named by `apiKeyEnv` in the model config
2. A `keystores/<model id>` file (gitignored)
3. `API_KEY_MISSING` error

Keystore files are per-model and live under `keystores/` at the COMMONS root.

### Config authoring

Call `initOpusDeck(config)` with a config object:

```js
{
  memoryDir: './COMMONS',
  outputDir: './OUTPUT',
  brief: 'build a trivial app',
  goalState: ['app builds'],
  crew: {
    lead: { id: 'lead', provider: 'custom', model: 'lead-m', contextWindowTokens: 4096 },
    engineers: [{ id: 'eng-1', provider: 'custom', model: 'eng-m', contextWindowTokens: 4096 }],
    security: [
      { id: 'sec-1', provider: 'custom', model: 'sec-m', contextWindowTokens: 4096 },
      { id: 'sec-2', provider: 'custom', model: 'sec-m2', contextWindowTokens: 4096 },
    ],
  },
  budgets: { digestTokens: 2000, promptTokens: 6000 },
}
```

Invalid config throws one `CommonsError` listing all invalid fields.

---

## 3. Run

```bash
npm.cmd run build    # strict tsc -> dist/
npm.cmd test         # build + full smoke suite (expect 126/126 pass)
```

The smoke suite boots `initOpusDeck()` with a mock transport and a crew of one
engineer + two auditors and completes a trivial one-file build end-to-end
(plan → route → worker build → clean audit → merge → signOff → `run.completed`).

---

## 4. Watchable COMMONS paths

All state lives in files under the COMMONS directory (default `./COMMONS`).
Nothing is ever deleted; a dedicated compactor keeps each model's prompt small.

Canonical bare-segment paths (resolved against `memoryDir` at the wiring layer):

| Constant | Bare segment | Meaning |
|---|---|---|
| BRIEF | `BRIEF.md` | The user brief |
| DECISIONS_LOG | `DECISIONS.log` | Governance log |
| STATE_DIGEST | `STATE/digest.md` | Compiled digest |
| STATE_PRESENCE | `STATE/presence.json` | Model presence |
| STATE_TASKS | `STATE/tasks.json` | Claim rows (claim authority) |
| WORKSPACE | `WORKSPACE` | User workspace directory |
| DELTA | `DELTA` | Transaction log directory |
| ARCHIVE | `ARCHIVE` | Compacted digest archive |
| TXN_LOG | `DELTA/txn.jsonl` | Transaction log |

Directory segments carry no trailing slash. Never mix absolute and relative
paths at call sites.

---

## 5. Verification commands

From inside `opus-deck-software/`:

| Command | Purpose | Expected |
|---|---|---|
| `npm.cmd run build` | TypeScript strict compile to `dist/` | exit 0 |
| `npm.cmd test` | Build + run full test suite (`node --test "dist/**/*.test.js"`) | 126/126 pass, exit 0 |
| `npm.cmd test` (encoding guard) | Verifies all governance artifacts are clean UTF-8, no NUL bytes | included in suite, pass |

The encoding guard covers: `DECISIONS.log`, `MERGE_REPORT.md`, and every
`docs/**/*.md` file (discovered by directory walk, so new docs are covered
automatically). It asserts zero NUL bytes, strict UTF-8 decode, and
byte-lossless UTF-8 round-trip per file.

---

## 6. Governance artifacts

| Artifact | Location | Purpose |
|---|---|---|
| DECISIONS.log | `opus-deck-software/DECISIONS.log` | Every interpretation made where the spec was ambiguous |
| MERGE_REPORT.md | `opus-deck-software/MERGE_REPORT.md` | Merge audit report with addenda |
| MANIFEST-OF-MOVES.md | `opus-deck-software/MANIFEST-OF-MOVES.md` | Records every move from the consolidation (old → new path) |
| INTEGRATION-ROADMAP.md | `opus-deck-software/docs/INTEGRATION-ROADMAP.md` | Additive concept-integration roadmap; carries R1–R20 rulings |
| RUNBOOK.md | `opus-deck-software/docs/RUNBOOK.md` | This file |
| PRE-FLIGHT.md | `opus-deck-software/docs/verification/PRE-FLIGHT.md` | Pre-flight inspection report |
| ACCEPTANCE.md | `opus-deck-software/docs/verification/ACCEPTANCE.md` | Final acceptance verdict |
| PHASE-VERIFY.md | `opus-deck-software/docs/verification/PHASE-VERIFY.md` | Phase verification report |
| BASELINE-VERIFY.md | `opus-deck-software/docs/verification/BASELINE-VERIFY.md` | Baseline verification report |
| PROVENANCE.md | `opus-deck-software/docs/PROVENANCE.md` | Component map, event catalog, security ruleset |

DECISIONS.log and MERGE_REPORT.md stay at the software root. Verification
reports live under `docs/verification/`.

---

## 7. Directory layout

```
opus-deck-software/
  src/
    config/        phase 1 — config & event bus
    transport/     phase 2 — model registry & transport
    commons/       phase 3 — COMMONS core
    compactor/     phase 4 — compactor
    coordination/  phase 5 — presence, claims & locks
    leader/        phase 6 — leader
    crew/          phase 7 — engineering crew runner
    audit/         phase 8 — security audit gate
    merge/         phase 9 — merge & build engine
    cli/           phase 10 — CLI & surface
    wiring/        phase 11 — composition root
    f11/           additive review agent
    f12/           additive codegraph
  docs/
    PROVENANCE.md
    INTEGRATION-ROADMAP.md
    CONFIRMATIONS.md
    thinking.md
    integration/       folder-01..12 INTEGRATION.txt provenance
    verification/      PRE-FLIGHT.md, ACCEPTANCE.md, PHASE-VERIFY.md, BASELINE-VERIFY.md
    RUNBOOK.md         this file
  dist/              compiled output (generated by build)
  DECISIONS.log      governance log (clean UTF-8, no NUL bytes)
  MERGE_REPORT.md    merge audit report
  README.md          this project's overview
  package.json       npm manifest
  tsconfig.json      TypeScript configuration
```
