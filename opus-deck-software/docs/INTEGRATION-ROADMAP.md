# opus-deck — Concept-Integration Roadmap (post-acceptance, additive)

Baseline is the accepted ten-folder deck (`ACCEPTANCE.md`: ACCEPT: YES on 2026-10-17).
Everything below is **additive**: new folders `f11+`, new files under documented paths,
wiring registered in `src/wiring/index.ts`. The ten accepted folders keep their behavior;
each phase must leave `npm test` green with zero changes to shipped semantics.

## Clean-room & provenance rules

- Every item in this roadmap is an **architecture/working-concept extraction** from survey
  repos under `../main/`. No code, file, or document was or will be copied from any of
  them; all implementations are written from scratch inside this project.
- Per-concept provenance is recorded so future contributors know the *idea source*
  (idea attribution, not a code lineage):

| Donor repo | License | Concepts borrowed (ideas only) |
|---|---|---|
| `main/open-code-review-main` | Apache-2.0 | Deterministic×agent review pipeline: selection, bundling, rule matching, positioning, reflection |
| `main/graphify-8` | Apache-2.0 | Staged graph pipeline (detect→extract→build→cluster→report/export) as build-memory |
| `main/agency-agents-main` (+zh) | MIT | Persona-as-data: Markdown + frontmatter agent schema; persona linting |
| `main/ARES-main` | MIT | Capability/module registry; single-use confirmation tokens for high-impact actions |
| `main/vibe-guard-main` | MIT | Severity-gated fail semantics (`--fail-on`); AI-output rule scanner stance |
| `main/artemis-main` | Apache-2.0 | Agent-loop / MCP-server patterns (reference reading for f07 worker loop, future deck-as-MCP) |
| `main/firecrawl-main` | AGPL-3.0 | Concept only: URL→markdown ingestion seam. NO code reuse permitted* |
| `main/OpenViking-main` | AGPL-3.0 | Concept only: context-database idea (superseded for our scale by graphify pipeline). NO code reuse permitted* |
| `main/samples-main` | vendor | Reference reading only; nothing to integrate |

\* AGPL sources are idea-source only; any contact surface (hosted APIs, binaries, native
builds) is outside this project's scope and requires an explicit new decision before use.

## Design principles carried over from the accepted baseline

1. **Deterministic engineering × agent hybrid** — process steps that must not drift
   (selection, bundling, rule matching, positioning) are plain code; the LLM does only
   dynamic judgment inside a tightly scoped prompt.
2. **Everything contract-driven, wired at the composition root** — new collaborators are
   constructor-injected into `wireOpusDeck()`, typed in the owning folder, no singletons
   beyond documented module defaults.
3. **All cross-folder communication over the hub** (`commonState/event-hub`) — new events
   are additive; existing event names are never repurposed.
4. **State lives in COMMONS under `STATE/folder-XX/`** — JSON, atomic writes via folder-03.
5. **Every phase ships with its own gate** — build exit 0, smoke test covering the new
   behavior, no stubs, `DECISIONS.log` entry, MERGE-report addendum. Same discipline as
   the original ten.

---

## Phase 1 — f11 `review`: precision diff-review agent

**Goal.** Review a changeset with near-zero false-alarm rate, feeding findings into the
existing `STATE/findings.json` → escalation → ReviewQueue loop. No publish/moment where a
model convenience-choice can silently skip a file.

**Module layout** (`src/f11/`, folder doc: `docs/integration/folder-11.txt`)

| File | Responsibility |
|---|---|
| `f11/types.ts` | `ReviewRequest`, `ReviewBundle`, `ReviewCriterion`, `PositionedFinding`, `ReviewResult` |
| `f11/collect.ts` | Build the deterministic file list (explicit paths or DELTA/txn-log scope from WORKSPACE state) |
| `f11/filter.ts` | Hard exclusions: non-text/binary, files over size cap, held-claim paths, vendored/generated globs |
| `f11/bundle.ts` | Group files into review bundles — same-stem test/files pair, dir-sibling config grouping; token-budgeted with the f04 `estimateTokens` seam (per-bundle + run caps) |
| `f11/rules.ts` | Rule packs as data: `RULES/<lang>.pack` matching globs → per-bundle `ReviewCriterion[]` (id, severity, prompt-hint). Template matching, not model-selected |
| `f11/review-agent.ts` | Orchestrates one `<ReviewBundle, criteria>` → f02 stream call per bundle via the f07 worker contract; findings emerge in our f08 Finding schema |
| `f11/position.ts` | Re-anchor every finding to an exact line via deterministic content match; unanchorable findings are demoted with `disposition: "unanchored"` (logged, not persisted as gate-blocking) |
| `f11/reflect.ts` | Second-pass model call per bundle: for each finding, confirm/deny against raw content; denied findings recorded as `reflections: denied` audit rows and dropped |
| `f11/index.ts` | `createReviewAgent(deps)` → `{ review(request): Promise<ReviewResult>, listRules(): RulePackSummary[] }` |

**Deps (all existing):** hub, commons (folder-03), transport (folder-02), locks
(folder-05, optional claim on reviewed paths), `estimateTokens` (folder-04),
`persistFindings` + escalation queue (folder-08), worker-pool runner (folder-07).

**Events:** `review.requested` → `review.bundle.started`/`review.bundle.done` (per bundle,
with bundle id + file list) → `review.completed` `{ requests, bundles, findings,
dropped, reflections }`.

**State:** `STATE/folder-11/reviews/<runId>.json` — full audit: every file selected or
filter-excluded (with reason), every bundle, every finding with disposition + reflection
verdict. The *"did the reviewer skip it?"* question is always answerable from this file.

**Behavioral contract (the hard guarantees):**
- Every non-excluded file appears in ≥1 bundle (asserted in code; violation is a thrown
  bug, never a silent skip).
- Positioning + reflection are the only reasons a finding may be dropped, and every drop
  is recorded with its reason.
- Findings that survive go through the standard f08 persistence → severity → escalation
  path; unpatchable-critical flows to the ReviewQueue we validated in re-acceptance.

**Deliberate v1 simplifications:** no cross-repo diffing; line anchoring is
content-match-based (not AST); reflection is single round. Each has a recorded upgrade
path; complexity is added only if accuracy data demands it.

**Tests:** golden bundle fixtures (pair grouping, budget split, exclusion reasons);
collector coverage guarantee; position anchor success on a known diff; reflect-deny
drops with audit row; end-to-end dirty-file smoke reuses the re-acceptance probe
expectation (SEC families surface, `review.completed` on hub, escalation still routes).

---

## Phase 2 — f12 `codegraph`: workspace knowledge-graph memory

**Goal.** Give the leader's `plan()` and the digest real structure context: an LLM-free
file→symbol→import graph over the WORKSPACE, summarized into the digest under a `CODEMAP`
section through the compactor's budget.

**Module layout** (`src/f12/`)

| File | Responsibility |
|---|---|
| `f12/types.ts` | `WorkspaceGraph`, `GraphNode { id: symlinkLabel, kind, symbols? }`, `GraphEdge { from, to, kind: "imports"|"sibling" }` |
| `f12/detect.ts` | Classify file roles (entry, module, test, config, doc) from path conventions — no parsing library |
| `f12/extract.ts` | v1: import/require/export extraction with scoped regex for the languages the brief targets (TypeScript/JS first); deterministic and crash-safe per file |
| `f12/build.ts` | Assemble + normalize graph (resolve relative imports in-tree; drop externals to a count) |
| `f12/cluster.ts` | Entry-point traversal → module-cluster tagging + hub-file ranking (in-degree) |
| `f12/section.ts` | Render a compact `CODEMAP` digest section (top hubs, orphan list, cluster table), sized to a token cap |
| `f12/index.ts` | `createCodegraph(deps)` → `{ rebuild(): Promise<CodegraphResult>, load(): WorkspaceGraph | null }` |

**Storage:** `STATE/folder-12/codegraph.json` (graph) + `STATE/folder-12/report.md`
(human-readable). Digest enrichment happens via the folder-03 write path so
compaction/ARCHIVE semantics apply unchanged; planner system prompt gains the section
via the normal digest slot.

**Events:** `codegraph.rebuilt` `{ files, clusters, hubs }`. Rebuild triggers: explicit
CLI (`deck codegraph build`), or wiring-optional low-frequency hook on folder-03 events
(filter: `path` under the source tree only, rate-limited by fingerprint so identical
states don't rebuild).

**v1 boundary:** no tree-sitter/AST parsers (heavy, brittle). Regex extraction +
structure conventions are enough for hubs/orphans/dead-code candidate reporting; an AST
backend can slot behind `extract.ts` later without schema changes.

**Tests:** extraction fixtures for import forms we support; resolver in/out of tree;
cluster/hub math on a small golden graph; CODEMAP token-cap behavior; digest + planner
prompt integration assertion.

---

## Phase 3 — `CREW/` personas + gate severity configuration

**Persona-as-data** (idea: agent corpus):
- `CREW/personas/<id>.md` — YAML frontmatter `{ id, role: lead|engineer|auditor|reviewer,
  contextWindowTokens?, modelRef? }`, body = the system prompt.
- `src/wiring/personas.ts`: `loadPersonas(memoryDir)` → registry; presence-driven roles
  with graceful fallback to current built-in prompts when a role has no persona file
  (zero-risk default; the shipped behavior must not depend on persona files existing).
- Boot-time lint (required frontmatter keys, unknown role) fails fast with a precise
  error — the "lint your agent corpus before it ships" stance.
- Wires in: leader plan prompt (lead persona), f07 worker system prompt (engineer
  persona), f08 audit calls (auditor persona), f11 review calls (reviewer persona).

**Severity configuration** (idea: `--min-severity/--fail-on`):
- `STATE/config.json` `{ gate: { failOn: "critical"|"high"|"medium"|"low" } }`, default
  `"critical"` = shipped behavior.
- Folder-09 `critical-findings` check renames conceptually to severity-thresholded
  blocking; escalation thresholds in folder-08 have read the same value when set.
- Documented in `docs/integration/`; changeable without code edits.

---

## Phase 4 — single-use confirmation tokens (high-impact actions)

- `src/wiring/confirmations.ts`: `confirmant.issue(scope)` → `{ token, scope, expiresAt,
  nonce }`; `confirmant.consume(token, scope)` verifies + burns. Token = keyed SHA-256
  over `(scope, action, nonce, expiry)` with an in-memory secret generated at wire time
  (`node:crypto`, no new dependency).
- Applied first to: `veto` follow-up generation, multi-file remediation batches, and
  (when shipping) bulk deletions in export/merge helpers. Hub records `action.confirmed`
  / `action.rejected` for the audit trail.
- The point is auditability + intent, not crypto theater: a follow-up task born of a
  human-led veto decision is traceably paired to exactly one confirmed action.

---

## Sequencing, sizing, verification

```
Phase 0  baseline snapshot          (done — ACCEPT: YES; npm test 5/5 green)
Phase 1  f11 review                 largest; independent — START HERE
Phase 2  f12 codegraph              independent; later enriches f11 rule packs + planner context
Phase 3  personas + severity config small; benefits f11 (reviewer persona) and f08/f09
Phase 4  confirmation tokens        small; last, touches most-sensitive paths
```

| Phase | New files (approx) | New deps | Climactic verification |
|---|---|---|---|
| 1 | ~10 + rules packs + folder doc | 0 | full review smoke (coverage/anchor/reflect/escalation) + audit of `reviews/<runId>.json` |
| 2 | ~8 | 0 | graph golden tests + digest CODEMAP section + planner prompt integration |
| 3 | ~4 | 0 | persona fallback matrix + gate threshold fixtures |
| 4 | ~2 | 0 (node:crypto) | token round-trip, expiry, replay-rejection tests |

**Non-goals (explicit):** no AGPL code or API embedding (firecrawl/OpenViking concept
source only); no multi-process/distributed execution; no DB — all state stays
JSON-in-COMMONS; no model-provider changes (folder-02 transport is the single seam).

**Provenance note for DECISIONS.log (to append at implementation time, one entry per
phase):** rationale, idea source repo + license, confirmation that zero code was copied,
and the new acceptance gate executed for the phase.

---

## Consolidation Rulings (R1–R20)

Collected from DECISIONS.log, PROVENANCE.md, PHASE-VERIFY.md, and source code comments
across the session record. One line each.

| # | Ruling (binding) |
|---|---|
| R1 | folder-04 exports estimateTokens (already existed), consumed by f11/bundle.ts for budgeting. No second estimator written. |
| R2 | review.* event names added to f01 EventName/EventPayloads closed set; PROVENANCE event catalog updated. No existing event repurposed. |
| R3 | review LLM calls go through f02 Transport.complete() directly, NOT the f07 task/claim queue. |
| R4 | unpatchable-critical findings escalate to ReviewQueue via decide(); veto() produces follow-up task with real WORKSPACE path (decision.touched[0]). |
| R5 | ONE source for the merge gate's blocking threshold (ruling R5), zod-validated at load in src/wiring/severity-config.ts; resolved once at wireOpusDeck() boot and injected into both consumers. |
| R6 | CODEMAP digest section is regenerable state — compaction may demote it and the next rebuild restores it — it is never pinned. |
| R7 | tokens are PER-PROCESS in v1 — the signing secret is generated in memory at wire time and never persisted; a pre-restart token is CONFIRMATION_MALFORMED/foreign-key. |
| R8 | diff confinement — repair round scoped to whitelist (src/f11/, src/f12/, wiring registration, docs) with pre-approved exceptions logged in DECISIONS.log lines 288-297. |
| R9 | Coverage assertion at consumption point — assertCoverage(files, bundles) throws if any input file is missing from all bundles (bundle.ts post-condition); forced-drop test (subverted bundleFiles drops a file) proves it fires before any LLM call (review-agent.ts); audit-file reconciliation confirms selectedNotBundled = []. |
| R10 | memory.written — a file was written through COMMONS — emitted from the wiring layer after every successful commons.write() with { path, txnId, author }; commons itself stays bus-free. |
| R11 | Cross-folder schema seams are typed and round-tripped. The seam between any two components' data shapes gets a shared type (no `any`), and a test runs the full round trip: producer -> persisted -> consumer. Any finding-producing or state-producing component ships with that test. |
| R12 | Additive barrel re-exports from src/index.ts are whitelisted (logged per phase). |
| R13 | one canonical persisted type per data kind — findings keep the baseline f08 shape (Finding; field detectorModelId), unchanged. A new producer adapts INTO the canonical shape at its own wiring boundary, via exactly ONE adapter function. Existing producers never change their call shape for a newcomer. |
| R15 | No writes to accepted folders during an open verification. A verification in progress pins the baseline it verifies; new work touching accepted code waits for the gate to close or is staged as a new phase. |
| R14 | DECISIONS.log must be clean UTF-8 with no NUL bytes; encoding guard test at src/wiring/decision-log.test.ts asserts strict UTF-8 decode + zero NUL bytes + byte-lossless round-trip. Go-forward: UTF-8 only; no tool that may introduce UTF-16LE or NUL bytes may be used to edit DECISIONS.log. |
| R14-EXTENDED | every governance artifact is a UTF-8 text file — no NUL bytes or invalid UTF-8 sequences; guarantee enforced by a test that iterates the artifact set (DECISIONS.log, MERGE_REPORT.md, docs/**/*.md), not by per-file special case. |
| R20 | consolidation — move working repo into ONE self-contained software folder (opus-deck-software/); moves byte-identical; ZERO edits to src/; governance artifacts (DECISIONS.log, MERGE_REPORT.md) stay at software root; verification reports move to docs/verification/; INTEGRATION-ROADMAP.md carries R1–R20 rulings; archive parts/ to ../archive/parts/. |

| R16–R19 | PENDING — proposed for the Chromium/Electron phase; effective at Phase C1 dispatch: R16 bus-only bridge; R17 generated code is untrusted output (sandboxed preview); R18 Electron quarantined to the app/ workspace; R19 keys never cross the process boundary. |
