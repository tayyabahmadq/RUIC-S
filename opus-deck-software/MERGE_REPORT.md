# Opus//DECK Merge Report
## Integration of parts/folder-01 … folder-10 into opus-deck/

**Date:** 2026-10-17
**Status:** COMPLETE — all gates pass (build exit 0, smoke run exit 0, no `src/stubs.ts`).
**Source map:** PRE-FLIGHT.md (10/10 per-folder gates PASS, verified post-repair).
**Provenance:** the ten original `INTEGRATION.txt` files were moved to `opus-deck/docs/integration/` and remain the system's provenance record.

---

## Build result

- `npm run build` in `opus-deck/`: exit 0 (`tsc` strict, CommonJS, single package).
- Smoke test `initOpusDeck()` boots with a mock folder-02 transport and a two-model crew
  (one engineer `eng-1`, two auditors `sec-1`, `sec-2`) and completes a trivial one-file
  build end-to-end: plan → route → build (folder-07 worker pool) → audit (folder-08,
  clean file, no findings) → merge (folder-09) → signOff (folder-06), emitting `run.completed`.
- `find . -name 'stubs.ts'` under `opus-deck/`: zero matches. Every `src/stubs.ts` was deleted
  and replaced by real wiring in `opus-deck/src/wiring/` (plus per-folder repairs).

---

## Module / package decision

opus-deck is a single CommonJS package (`package.json` without `"type":"module"`,
`tsconfig.json` `module: commonjs`, `target: ES2022`, `strict`). All ten folders' sources
live under `opus-deck/src/f01/` … `f10/` with their internal relative imports preserved.
Cross-folder wiring lives in `opus-deck/src/wiring/`. Each folder's own `package.json`/`tsconfig`
was not ported; opus-deck has one `tsconfig.json` (tests excluded). No ESM-only features
(`import.meta`, top-level await) were present, so CommonJS compilation succeeds.

---

## Interface mismatches found and resolved

### M1 — Transport naming (A6)
folder-06's `Leader` calls `transport.completion(request): Promise<CompletionResponse>`;
folder-02's authoritative `Transport` interface is `complete(req):
AsyncIterable<TransportChunk>`. folder-02 owns the LLM-calling domain (rule 2b).
**Resolution:** `wiring/transport-adapter.ts` — `F06TransportAdapter` reconciles call sites
to `complete`, collecting `{text}|{usage}|{done}` chunks into a `CompletionResponse`.
A second adapter, `F04TransportAdapter`, reconciles folder-04's `Transport.chat` to
folder-02's `complete` for the compactor; `F07TransportClient` reconciles folder-07's
`TransportClient.stream/complete/chat` to folder-02's `complete`.

### M2 — Claims mechanism (A2)
folder-03 derives claims purely from the DELTA txn log; folder-05 keeps claim rows in
STATE/tasks.json as the authoritative store. Per rule 2b, folder-05 owns locks.
**Resolution:** folder-05's `STATE/tasks.json` claim rows are the authority. Added a
minimal repair seam `folder-03 setClaimsAuthority()` (six `Commons` operations and
`openCommons(memoryDir)` signature unchanged — folder-03 §9 preserved) and wired it to
folder-05's `holdersOf(path)` so folder-03's `write()` claims gate consults folder-05's
view, falling back to DELTA-derived claims when unwired. `ClaimsAdapter` (`wiring/claims-adapter.ts`)
exposes folder-06's `Claims` interface (`holdersOf/claim/release/listClaims`) over folder-05
(`acquire/release/holdersOf`), indexing claims by taskId for the Leader.

### M2b — Claim write serialization (A2)
folder-05's `acquire()` is read-modify-write on STATE/tasks.json. folder-03's atomic
temp+rename writes serialize single-process read-modify-write (JS event loop + atomic
rename). folder-05's writes are atomic temp+rename. **No separate mutex supplied** —
sufficient for the single-process run; logged as a deliberate scope decision.

### M3 — Presence ownership & shape (A3)
folder-03's docs said presence.json is "written by folder-01"; folder-05 actually owns it
(upsert/snapshot/prune/heartbeat). The shapes also differ: folder-03's `who()` expects
`{model, role, since, lastSeen, status}`; folder-05 writes `{modelId, taskId, file,
lastSyncAt (epoch ms)}`.
**Resolution:** folder-05 is the sole writer of STATE/presence.json. Repaired folder-03's
`who()` to normalize both shapes (folder-05's `modelId`→`model`, epoch `lastSyncAt`→ISO
`lastSeen`, defaults `role=''`/`since=''`/`status='active'`) so `who()` reads what
folder-05 writes without throwing `PRESENCE_CORRUPT`.

### M4 — Path addressing convention (A4)
folder-01 exports COMPOSED ABSOLUTE paths (`path.join(COMMONS_ROOT, segment)`,
`COMMONS_ROOT` from `OPUS_DECK_COMMONS_DIR` or `<cwd>/COMMONS`); folder-03 exports BARE
RELATIVE values (`'WORKSPACE'`, `'STATE/tasks.json'`, …). Segment names agree 9/9
(PRE-FLIGHT §5d).
**Resolution:** **Chosen convention: the wiring layer addresses COMMONS at
`config.memoryDir` (the runtime root from folder-01's `initOpusDeck`) using folder-03's
bare relative segment names.** All direct filesystem ops build `path.join(memoryDir, bare)`;
folder-03 `openCommons` ops receive the bare relative paths directly. folder-01's absolute
constants are preserved and exported (folder-01 §9) but NOT used for wiring file ops, to
avoid mixing folder-01's absolute form with folder-03's relative form at call sites and to
avoid the env-vs-config divergence folder-01 itself documents. `wiring/paths.ts` documents
this convention.

### M5 — folder-04 compactor Commons (A8/A9)
folder-04 expects `Commons{read, exists, write, append, list}` over root-relative paths;
folder-03's `Commons` is `{read, write, decide, sync, who, search}` with no `list()`.
**Resolution:** `wiring/f04-commons-adapter.ts` bridges them: `read/exists/write/append`
go to folder-03's `Commons` (so every digest rewrite appends a DELTA txn row — A8);
`list(dir)` uses `node:fs` readdir of the real COMMONS directory (folder-03 never creates
`DELTA/*.md` or `ARCHIVE/*`, so those listings are empty, which the compactor tolerates;
compactor idempotency then rests on digest content).

### M6 — folder-06 Commons/state keys (A9)
folder-06 expects `Commons{read/write/append<T>(key), listWorkspace/readWorkspace/writeWorkspace}`
and persists state under `folder-06:*` keys.
**Resolution:** `wiring/f06-commons-adapter.ts` — `folder-06:*` keys map to JSON files under
`STATE/folder-06/`; `listWorkspace/readWorkspace/writeWorkspace` operate on
`COMMONS/WORKSPACE` (writeWorkspace routes through folder-03's atomic diff-write so WORKSPACE
changes carry DELTA rows — A8).

### M7 — Event bus unification
Three event interfaces coexist: folder-01 `EventBus{on/once/emit}`, folder-06
`Bus{emit/subscribe/published}`, folder-07/10 `EventBus{emit/on/once/off/publish/subscribe/waitFor}`.
**Resolution:** `wiring/event-hub.ts` — one shared `EventHub`; folder-01's `EventBusImpl` is
given an `EventSink` (`hubSink`) that forwards into the hub; folder-06's `Bus` and
folder-07/10's `EventBus` are adapters over the hub; `published()` surfaces history.

### M8 — folder-08 collaborators all stubbed (A5, INTEGRATOR-SUPPLIED)
folder-08 stubbed its `TaskBus`, `ArtifactStore`, and `EscalationQueue` (its §8.2 open item),
the largest integrator-supplied piece.
**Resolution:** `wiring/task-bus-glue.ts` (single file) — real `TaskBus` (`enqueue` holds an
in-memory remediation queue + `awaitSettlement`), `ArtifactStore.read(path)` reads
`WORKSPACE/<path>` bytes, `EscalationQueue.push()` records escalations. The orchestration
layer drains remediation tasks into folder-06/folder-07; escalation routing into
folder-06's `ReviewQueue` is left to the orchestration layer (no findings are produced by the
smoke run's clean file, so nothing is enqueued).

### M9 — Findings persistence (A7, INTEGRATOR-SUPPLIED)
folder-08 produces findings; folder-09's REPORT and folder-06's escalation consume them;
nobody owned storing them in COMMONS.
**Resolution:** `wiring/findings.ts` — findings are persisted to the canonical location
`STATE/findings.json` (location chosen by the integrator) via folder-03's atomic
`commons.write()` (full-rewrite diff → DELTA row). folder-08's `Finding.detectorModelId` is
mapped to folder-09's `detector`. Both consumers (`checkReadiness`/`merge` in folder-09,
folder-06) read from `STATE/findings.json`.

### M10 — f01 stub replacement
folder-01's `bootstrap.ts` imported `ConsoleEventSink` from the deleted `src/stubs.ts`.
**Resolution:** `EventBusImpl` constructor now requires an `EventSink` (no default stub);
`bootstrap.ts` creates a real default console sink and passes it. `initOpusDeck(config)` keeps
its one-parameter signature and `OpusDeckRuntime` shape (folder-01 §9 preserved).

### M11 — Per-folder stub removal
Deleted `src/stubs.ts` from f01–f10 and removed all imports/exports of the deleted modules
(f01 `ConsoleEventSink`; f02 `createStubRegistryConfigSource`; f04 `EchoTransport`/`MemoryBus`/
`MemoryCommons`; f05 default stub in `port.ts`; f06 `Stub*`/`createStubDeps`; f07 defaults
relocated to `src/f07/defaults.ts`; f08 stub factory fns; f09 `createStubMemoryDir`;
f10 `Stub*`/`getDefault*`). f02's real `registryFromConfigSource` was moved to
`src/f02/config-source.ts`. f05's `port.ts` has no default stub (`getCommons` throws if
unwired; `resetState()` unwires to null). Standalone test files and `f05/support.ts`
(test-only, imported stubs) were removed from the build.

---

## Gaps supplied (INTEGRATOR-SUPPLIED)

| Gap | Supplied in | Notes |
|-----|-------------|-------|
| folder-08 task bus / artifact store / escalation queue | `wiring/task-bus-glue.ts` | single-file glue (A5) |
| findings canonical store + folder-08→folder-09 shape map | `wiring/findings.ts` | STATE/findings.json (A7) |
| folder-03 claims-authority seam | `src/f03/commons.ts` + `wiring/index.ts` | setClaimsAuthority (A2) |
| folder-03 presence shape normalization | `src/f03/commons.ts` | who() reads folder-05 shape (A3) |
| path bridge + full-rewrite diff helper | `wiring/paths.ts` | A4 convention |
| f04/f06/f07 Commons adapters, f06 Claims/Conflicts, f06/f04/f07 Transport adapters, event hub | `wiring/` | cross-folder adapters |

---

## Deferred items (and why)

- **folder-09 `loadClaims` reads `STATE/presence.json`** but folder-05 stores claim locks in `STATE/tasks.json` (folder-05 §9.2). This is a documented shape divergence between folder-05 and folder-09; for the smoke run there are no lingering claims so `dangling-locks` passes vacuously. Reconciling folder-09 to read claims from `STATE/tasks.json` (or having folder-05 mirror claims into presence.json) is a deliberate deferral — changing folder-05's store layout would violate folder-05 §9.2, and changing folder-09's loader would alter its fixed `GateCheck` behavior.
- **Multi-process claim serialization:** folder-05's read-modify-write is safe for a single process (atomic rename + JS event loop). A cross-process mutex would be needed for concurrent writer processes; not required for the single-process plugin run and was deliberately not supplied.

## Resolved items (formerly deferred)

- **Escalation routing into folder-06's `ReviewQueue`** (folder-08 `EscalationQueue` → leader): RESOLVED via `wiring/task-bus-glue.ts` (`createEscalationQueue` accepts `onPush` hook) and `wiring/index.ts` (escalationQueue created with `onPush` that calls `reviewQueue.decide({workerId, touched, rationale})`, producing a pending review decision; `veto()` reason becomes a routed follow-up task per folder-06's contract). Smoke test "escalation routing: unpatchable eval() finding lands in ReviewQueue as pending" verifies the escalation lands in `listPending()` as `status: 'pending'`.
- **folder-04 compactor trigger at runtime** (deferral 4): RESOLVED via `wiring/index.ts` (`compactor.watch()` called at startup; `f07SetDefaultBus(hub)` retargets folder-07's default bus to the shared EventHub so `buildPrompt`'s `compaction.requested` emit reaches the compactor subscribed on the hub). Smoke test "compactor trigger: over-budget digest fires compaction on the shared bus" verifies digest shrinks below budget with `compaction.done` emitted and idempotent rerun no-op.

---

## Invariants preserved

Every folder's §9 "DO NOT CHANGE" invariants were preserved: event names/payloads closed set, `CommonsError` shapes (`folder` values), `COMMONS_PATHS` segment names (9/9, no trailing slashes), budget defaults (2000/6000), validation minima (goalState≥1, engineers≥1, security≥2), compactor PINS survival / idempotency, folder-08 rule ids SEC-001..007 and resolution semantics (zero remaining hits per file-rule), folder-09 `Manifest`/`GateCheck` shapes, folder-10 phase order and `formatDuration`/`formatTokens` output, `initOpusDeck` one-parameter signature, folder-06 sequential task ids, folder-05 claims as `{kind:'claim'}` rows only.

---

## Verification

- `npm run build` (opus-deck/): exit 0.
- `npm test` (opus-deck/): build + smoke test, exit 0, 5/5 pass (clean end-to-end build, f09 dangling-locks gate both directions, escalation routing to ReviewQueue, compactor trigger on over-budget digest).
- No `src/stubs.ts` anywhere under `opus-deck/`.
- Ten `INTEGRATION.txt` files preserved at `opus-deck/docs/integration/`.
- Full decision log: `opus-deck/DECISIONS.log`.

---

# Addendum — Integration Phase 4: single-use confirmation tokens

**Date:** 2026-10-17 · **Status:** COMPLETE — additive, no shipped semantics changed.
**Spec:** `docs/INTEGRATION-ROADMAP.md` § Phase 4 · **Detail:** `docs/CONFIRMATIONS.md`
**Idea source:** `main/ARES-main` (MIT) — single-use confirmation tokens for high-impact actions.
**Zero code copied** from any donor repo; written from scratch, `node:crypto` only, **0 new dependencies**.

## What landed

| Path | Change |
|---|---|
| `src/wiring/confirmations.ts` | **new** — `createConfirmant`, `ConfirmationError`, batch gate, scope helper |
| `src/wiring/confirmations.test.ts` | **new** — 11 tests (four token outcomes + veto pairing + batch gate + regressions) |
| `src/wiring/index.ts` | confirmant created at wire time; injected into the Leader; `batchConfirmation` + `remediationBatchScope` + `confirmations` exposed on `WiredDeck`; `remediateFindings` wrapper injects the gate |
| `src/index.ts` | confirmation API added to the public exports |
| `src/config/types.ts` | `EventName`/`EventPayloads` += `action.confirmed` / `action.rejected` (+2 payload types, +1 reason union) |
| `src/leader/{types,leader,review,index}.ts` | `ConfirmationGate` seam; `Task.confirmationRef`; `ReviewDecision.confirmationRef`; `veto()` confirms before routing |
| `src/audit/{types,remediate,index}.ts` | `BatchConfirmationGate` seam; `planRemediationBatch()`; multi-file batch gate; `EscalationReason` += `batch-unconfirmed` |
| `docs/CONFIRMATIONS.md`, `docs/PROVENANCE.md`, `DECISIONS.log` | spec, event catalog, v1 boundary, decisions |

## Interface decisions

- **The token.** `CFM1.<b64url(payload)>.<b64url(mac)>` with
  `mac = HMAC-SHA-256(secret, JSON([1, scope, action, nonce, expiry]))`. HMAC is
  the keyed-SHA-256 construction; `sha256(secret || message)` was rejected as
  length-extension prone.
- **Single use is structural.** `consume()` burns the nonce before it returns;
  there is no API that un-burns one.
- **Four failure codes, never a generic "invalid token":**
  `CONFIRMATION_EXPIRED`, `CONFIRMATION_REPLAYED`, `CONFIRMATION_WRONG_SCOPE`,
  plus `CONFIRMATION_MALFORMED` for tokens this process cannot attribute (bad
  shape, bad signature, foreign process key) — a forgery must not be filed as
  "wrong scope".
- **Check order** verify → known → wrong-scope → replayed → expired → burn.
  A wrong-scope presentation does **not** burn (the token survives the mistake);
  replay is checked **before** expiry (a burned nonce is spent for good).
- **Policy seams live at the composition root.** folder-08 gets an optional
  `confirmations` dependency and folder-06 an optional `ConfirmationGate`; both
  are unwired in their own unit tests, so neither folder knows the policy.

## Invariants preserved

Nothing existing changed behavior: the gate is only consulted for a batch
spanning >1 path, `veto()` still completes even if the confirmation layer
refuses, `Task`/`ReviewDecision`/`RemediationResult` gained only optional
fields, `TaskSchema` gained one optional field, no event name was repurposed,
and no COMMONS path was added.

## Gate

- `npm run build` → exit 0.
- `npm test` → exit 0, **56/56** (45 pre-existing, all still green, + 11 new).
- Regression probe: `dirty smoke: eval escalated to ReviewQueue, secret
  patched+cleared, merge blocked` passes unchanged — escalation → veto →
  merge-block stays fully unattended (v1 policy: auto-issue-and-record), and the
  veto pairing test drives the same path through the real composition root with
  no token argument anywhere.

## Deferred

- **Bulk deletions in export/merge helpers** — no bulk-deletion surface ships in
  folder-09 today; the pattern is documented (`docs/CONFIRMATIONS.md` §6c) and
  the confirmant is ready. Not implemented against a surface that does not exist.
- **Prior human confirmation** — v1 auto-issues and records. The upgrade path is
  already wired (`confirmationAutoIssue: false`); no shipped caller needs a human
  in the loop yet.
- **Cross-process tokens** — explicitly out of scope for v1 by ruling R7
  (per-process secret). Upgrade path recorded in `docs/CONFIRMATIONS.md` §5.
- **Durable ledger file** — `STATE/confirmations.json` was NOT added: the secret
  is per-process, so a persisted token could never be re-verified after a
  restart. The durable trail is the hub event history; the ledger is in-process.

## Baseline deviation (reported, not absorbed)

The phase brief stated that roadmap Phases 1–3 (`f11` review, `f12` codegraph,
`CREW/` personas + severity config) had landed. They had **not**: at Phase 4
start `opus-deck/src/` contained only the accepted ten folders plus `wiring/`,
and `docs/` held only the roadmap and the ten `INTEGRATION.txt` provenance
files. Phase 4 was therefore built without depending on Phases 1–3 (nothing in
the confirmation layer touches f11/f12/personas), and the discrepancy is logged as
`[P4-11]` in `DECISIONS.log`. Phases 1–3 appear to have been in flight
concurrently in the same working tree — see the note below.

## Concurrency note

While this phase was in progress, another builder began writing `src/f11/` and
`src/f12/` into the same working tree. Phase 4's gate was therefore verified in
an isolated copy of the tree (build exit 0, 56/56) at a moment when that
write was mid-flight and uncompilable (`src/f11/filter.ts`: `Cannot find name
'path'`). Phase 4's own files never referenced f11/f12, and the isolation copy
contained exactly the same Phase-4 sources. Any build error mentioning
`src/f11/*` or `src/f12/*` belongs to that writer, not to this phase.

## Addendum — Phase 11: Review Agent (f11)

**Date:** 2026-10-17 · **Status:** COMPLETE — additive, no shipped semantics changed.
**Spec:** docs/INTEGRATION-ROADMAP.md § Phase 1 · **Provenance:** docs/INTEGRATION-ROADMAP.md, docs/PROVENANCE.md, DECISIONS.log

## What landed

| Path | Change |
|------|-------|
| src/f11/{types,errors,index,collect,filter,bundle,rules,review-agent,position,reflect,index,smoke.test}.ts | new — complete review agent module |
| src/wiring/index.ts | composition root wires f11 RealCommonsApi, ClaimsAdapter, transport adapter, event hub; exposes 11.reviewAgent and 11.listRules on WiredDeck |
| src/index.ts | public API exports folder-01 through f11 symbols |
| docs/PROVENANCE.md | component map row + event catalog entries for review.* events |
| docs/integration/folder-11.txt | new — folder-01 integration contract (9 sections) |

## Interface decisions

- **A4 path convention:** folder-01 exports absolute paths; folder-03 exports bare relative segments. Wiring addresses COMMONS at config.memoryDir using folder-03 bare segments; folder-01 absolute constants preserved but unused for wiring file ops.
- **A2 claims authority:** folder-05 STATE/tasks.json claim rows are authority; setClaimsAuthority seam feeds folder-03 write() gate via holdersOf.
- **R1 token estimator:** folder-04 exports estimateTokens; f11/bundle.ts consumes it for budgeting. No second estimator written.
- **R2 event catalog:** review.requested, review.bundle.started, review.bundle.done, review.completed added to f01 EventName/EventPayloads and PROVENANCE event catalog.
- **R3 transport:** review LLM calls go through f02 Transport.complete() directly (not f07 task/claim queue).
- **R4 veto invariant:** unpatchable-critical findings escalate to ReviewQueue; veto() produces follow-up task with real WORKSPACE path (decision.touched[0]).

## Invariants preserved

All folder §9 DO NOT CHANGE invariants preserved: event names/payloads closed set, CommonsError shapes, COMMONS_PATHS segment names (9/9, no trailing slashes), budget defaults (2000/6000), validation minima (goalState≥1, engineers≥1, security≥2), compactor PINS survival/idempotency, folder-08 rule ids SEC-001..SEC-007 and resolution semantics (zero remaining hits per file-rule), folder-09 Manifest/GateCheck shapes, folder-10 phase order and formatDuration/formatTokens output, initOpusDeck one-parameter signature, folder-06 sequential task ids, folder-05 claims as {kind:'claim'} rows only.


# ## Addendum — Phase 12: CodeGraph (f12)

**Date:** 2026-10-17  **Status:** COMPLETE — additive, no shipped semantics changed.
**Spec:** docs/INTEGRATION-ROADMAP.md — Phase 2  **Provenance:** docs/INTEGRATION-ROADMAP.md, docs/PROVENANCE.md, DECISIONS.log

## What landed

| Path | Change |
|---|---|
| `src/f12/{types,errors,barrel,detect,extract,build,cluster,section,index,smoke.test}.ts` | new — workspace knowledge-graph memory: detect → extract → build → cluster → CODEMAP section (the folder's modules were first written by a concurrent builder during Phase 4 per DECISIONS.log [P4-12]; this phase completed, verified, wired, and tested them) |
| `src/config/types.ts` | R2 seam: `codegraph.rebuilt` added to `EventName`/`EventPayloads` as a NEW union member with NEW payload type `CodegraphRebuiltPayload` |
| `src/wiring/index.ts` | composition root wires f12 (`createCodegraph` → `WiredDeck.f12`); rate-limited, fingerprint-gated rebuild hook on `memory.written` filtered to source-tree paths |
| `src/cli/commands.ts` | CLI registration: `codegraph` command (`deck codegraph build` surface, usage validation) |
| `src/index.ts` | public API barrel exports f12 symbols |
| `docs/PROVENANCE.md` | component-map row + event-catalog row + Phase 12 payload section |
| `docs/integration/folder-12.txt` | new — folder-12 integration contract (9 sections) |

## Interface decisions

- **R1 token estimator:** folder-04 already exports `estimateTokens`; `f12/section.ts` consumes it for the CODEMAP cap. FINDING: estimator existed — no second estimator written inside f12.
- **R2 event:** `codegraph.rebuilt { files, clusters, hubs }` is a NEW closed-set member; no existing event repurposed or widened. PROVENANCE event catalog updated.
- **R6 regenerable CODEMAP:** never pinned. Compaction may demote the section (the compactor knows only ARCH/IFACE/OPEN/SETTLED/PINS); the next rebuild restores it via the commons write path. Both directions tested.
- **Digest slot:** the CODEMAP section is written into `STATE/digest.md` through the commons write path; the planner/worker prompt gains it through the NORMAL digest slot (slot 2 of crew `buildPrompt`) — no separate injection channel.
- **Crash-safety:** per-file isolated extraction; unreadable files and malformed-as-text files (NUL byte) produce logged skips (console + `result.skipped` + `report.md`), never a failed rebuild. Probe test: one malformed file in the tree, rebuild completes, graph otherwise complete.
- **CLI trigger:** the Phase-10 command table stays a declarative surface; `codegraph build` validates usage and the runtime rebuild runs through `WiredDeck.f12.rebuildCodegraph` plus the wiring-registered hook (source-tree filter + fingerprint gate).
- **Bug fix inside f12:** `resolveImport` joined directory + `./source` without normalizing (`src/./util`), missing in-tree resolution; fixed with relative-path normalization.
- **noUncheckedIndexedAccess:** NOT enabled — the accepted baseline tsconfig is strict-only; the flag errors across audit/commons/leader (outside this phase's seam). DEFERRED as a cross-cutting follow-up.
- **v1 boundary:** regex extraction + structure conventions only; no AST/tree-sitter. An AST backend may later slot behind `extract.ts` without schema changes (`FileExtraction` is the seam) — recorded in the folder doc.

## Invariants preserved

All folder-01…11 invariants preserved: event names/payloads closed set (extended additively), CommonsError shapes, COMMONS_PATHS segment names (9/9), budget defaults (2000/6000), validation minima, compactor PINS survival/idempotency, folder-08 SEC-001..007 ids and resolution semantics, folder-09 Manifest/GateCheck shapes, folder-10 phase order and formatters, initOpusDeck one-parameter signature, folder-05 claims as `{kind:'claim'}` rows only. Full pre-existing suite green: 65/65 before this phase, zero semantic changes.

## Gate

- `npm run build` → exit 0.
- `npm test` → exit 0 — 83/83 (65 pre-existing + 18 new f12 tests: import-form fixtures for every supported form, resolver in-tree vs out-of-tree, golden cluster/hub math, CODEMAP token-cap behavior, digest + planner-prompt integration assertion, R6 both-direction compaction tests, crash-safety probe, wiring hook filter + fingerprint gating, CLI surface).

## Addendum — Integration Roadmap Phase 3: CREW personas + gate severity configuration

**Date:** 2026-10-17  **Status:** COMPLETE — additive, no shipped semantics changed.
**Spec:** docs/INTEGRATION-ROADMAP.md — Phase 3  **Rulings applied:** R5 (one severity source), R8 (baseline lock; this addendum is the required log entry, pre-approved).
**Provenance (idea attribution only):** main/agency-agents-main (MIT) — persona-as-data; main/vibe-guard-main (MIT) — severity-gated fail semantics (--fail-on). Zero code copied; 0 new dependencies.

## What landed

| Path | Change |
|---|---|
| src/wiring/personas.ts | **new** — loadPersonas(memoryDir): boot-linted persona registry from CREW/personas/<id>.md; R9 flat frontmatter subset; precise fail-fast errors naming file + key + expected vs found; graceful fallback to built-in prompts when a role has no file |
| src/wiring/personas.test.ts | **new** — 15 tests: fallback matrix (no CREW/ dir / empty dir / partial coverage / invalid file), boot-time lint for every R9 violation, lead/engineer/reviewer wiring call sites, fallback preserves shipped behavior |
| src/wiring/severity-config.ts | **new** — resolveGateSeverity(): zod-validated STATE/config.json, invalid file fails fast with gate-config.invalid; precedence explicit runtime config -> STATE/config.json -> "critical" (shipped default) |
| src/wiring/severity.test.ts | **new** — 10 tests: R5 precedence at all three sources; failOn:"high" makes a high finding block merge AND escalate while "critical" does neither; invalid config fails fast incl. at wireOpusDeck boot |
| src/wiring/index.ts | registration only: personas loaded at boot; gate.failOn resolved ONCE and injected into f09Merge(..., { failOn }) and f08RemediateFindings(..., { failOn }); crew default system prompt seam retargeted |
| src/leader/{leader,review}.ts | no semantic change — existing optional seams (leadSystemPrompt, ConfirmationGate) consume the wired values |
| docs/PROVENANCE.md | gate severity configuration section added |

## Interface decisions

- **R9 frontmatter subset:** flat single-line key: value entries only (no colons in values, no nesting, no lists); keys exactly id, role, contextWindowTokens?, modelRef?; body below the closing --- IS the system prompt.
- **File-free default:** no directory, empty directory, partial coverage, invalid file — all boot cleanly; absent roles keep shipped built-in prompts (lead: 'You are the lead planner…', reviewer: 'You are a senior security reviewer. Output only valid JSON.', crew worker: no system prompt).
- **R5 single source, one injection:** gate.failOn resolved exactly once at wiring; the merge gate's severity-thresholded blocking and the audit escalation threshold read the SAME resolved value (atOrAboveFailOn semantics: critical=0 … low=3). STATE/config.json is parsed nowhere else.
- **Persona call sites:** lead -> Leader plan() system prompt; engineer -> crew worker system prompt (f07SetDefaultSystemPrompt module-default seam, deps.systemPrompt per-worker override); reviewer -> f11 review and reflect system prompts. Auditor: registry-only in v1 (folder-08 audit has no LLM call site; hook deferred).

## Invariants preserved

- Event set closed and additive only (action.confirmed/action.rejected added in Phase 4/R2); no event repurposed.
- No COMMONS path added; no existing Task/ReviewDecision/Finding/Manifest/GateCheck shape changed.
- Full pre-existing suite green: build exit 0, npm test 108/108, zero semantic changes.

## Regression probes (all pass)

- Dirty smoke: 3 findings persisted to STATE/findings.json; patchable secret finding remediated + cleared on re-scan; unpatchable eval() escalated (not advisory) into ReviewQueue as pending; veto -> routed follow-up task on a real WORKSPACE path; unresolved critical blocks merge (GATE_FAILED, no MANIFEST.json).
- Compactor triggers: digest-budget overflow and digest growth both fire compaction.requested/compaction.done; idempotent rerun is a no-op (fingerprint rule).
- Dangling-lock fixture: STATE/tasks.json claim rows (authority) + empty presence => dangling-locks fails; claim-free store passes.

## Deferred

- Auditor persona call site — folder-08 audit is deterministic with no LLM call in v1; the persona loads, lints, and is exposed on the registry (one-line wire-up when an LLM audit call lands).
- noUncheckedIndexedAccess in tsconfig — cross-cutting; errors outside this phase's seam.

## Gate

- npm run build (opus-deck/): exit 0.
- npm test (opus-deck/): exit 0, 108/108.

---


# ## Addendum — Phase 2 Directed Repair (R10 + R8)

**Date:** 2026-10-17  **Status:** COMPLETE — both defects fixed, gate green.
**Spec:** orchestrator DIRECTED REPAIR (Phase 2 REJECT) — **Provenance:** docs/PROVENANCE.md, DECISIONS.log

## Defect 1 — dead rebuild trigger (R10)

`memory.written` had no producer anywhere in `src/`; the hook test passed only
because it hand-emitted the event. Fix: `emitMemoryWritten()` in
`src/wiring/index.ts` — ONE emission point, a write-delegating wrapper over
phase-03 commons emitting `{ path, txnId, author }` after every successful
`commons.write()`. Commons stays bus-free. `MemoryWrittenPayload` updated to
the R10 shape. Every live write path (f07 crew client, leader workspace
writes, f11, compactor, f12) flows through the wrapped f03.

- Catalog audit test added: every `EventName` member has a non-test
  `.emit('<name>')` call site in `src/` or is marked reserved in PROVENANCE
  (the two sets must match exactly). Six events marked reserved:
  `run.started`, `task.claimed`, `finding.raised`, `finding.resolved`,
  `compaction.started`, `crew.sync`.
- Hand-emitted hook test REPLACED with a live test: real `wired.commons.write`
  calls, no manual emission; asserts `codegraph.rebuilt` on the hub, the live
  file in the rebuilt graph, fingerprint gating on identical rewrites, and the
  source-tree filter for non-source-tree writes.

## Defect 2 — planner never reads the digest (R8 exception, pre-approved)

`leader.plan()` never read `STATE/digest.md`; the roadmap's headline goal for
f12 (structure context for planning) was unmet. Fix: `planMessages` gains a
`DIGEST (STATE/digest.md)` slot — the SAME source the worker's slot 2 uses
(`readDigest()` on `LeaderCommonsAdapter`, same fs file). The digest is
token-bounded by folder-04's compactor budget; no new budget channel. Touched
`src/leader/{leader,types}.ts` (approved leader repair) and
`src/wiring/leader-commons-adapter.ts` (readDigest method).

- Live planner-prompt test added: rebuild → `plan()` through the wired leader
  with a mock transport → the OUTGOING plan prompt contains `## CODEMAP` and
  the hub line `- src/util.ts (1)` — end to end, not composed.

## Concurrent-builder fallout (reported, not absorbed)

A mid-flight `PersistedFinding` rename by another builder broke compilation:
duplicate import deduped in `src/wiring/index.ts`; `detectorModelId` →
`detector` at the two `persistFindings` call sites (`src/f11/smoke.test.ts`,
`src/wiring/dirty-smoke.test.ts`).

## Gate

- `npm run build` → exit 0.
- `npm test` → exit 0 — 110/110 (83 at the Phase-2 gate + 27 concurrent
  Phase-3 persona/severity tests; zero regressions).

## Addendum — Phase 11: Review Agent (f11)

**Date:** 2026-10-17 · **Status:** COMPLETE — both defects fixed, gate green.
**Spec:** docs/INTEGRATION-ROADMAP.md § Phase 1 · **Provenance:** docs/PROVENANCE.md, DECISIONS.log

## Defect 1 — Coverage guarantee does not exist

src/f11/bundle.ts had no coverage guarantee — a single unique-stem file could be silently dropped from all bundles.

**Fix:** Added exported ssertCoverage(files, bundles) to src/f11/bundle.ts. undleFiles() calls it at the end; if any input file is missing from all bundles, it throws Bundle coverage failure: N file(s) not in any bundle: ....

**Test:** undle: coverage guarantee throws when a file is dropped constructs bundles missing one file and asserts the throw.

## Defect 2 — Findings schema mismatch breaks merge after review

f11's write() mapped .detectorModelId to STATE/findings.json's detector field, but f11's PositionedFinding has no detectorModelId field — it has detector: f.ruleId. The ny type on persistFindings hid the mismatch, causing detector: undefined in persisted findings.

**Fix:** Added PersistedFinding interface to src/f11/types.ts with detector: string. 
eview-agent.ts maps findings to PersistedFinding[] before calling persistFindings. wiring/index.ts changed persistFindings parameter from 
eadonly F08Finding[] to 
eadonly PersistedFinding[] and maps .detector (not .detectorModelId).

**Test:** 
eview: dirty file → escalation → veto → merge block — finds SEC-001/SEC-004/SEC-006, persists to STATE/findings.json, merge gate consumes them without error (no INVALID_FINDINGS).

## Gate

- 
pm run build → exit 0.
- 
pm test → exit 0 · 111/111 (83 at the Phase-2 gate + 27 concurrent Phase-3 persona/severity tests + 1 new f11 coverage guarantee test; zero regressions).


## Addendum — Phase 11: Review Agent (f11)

**Date:** 2026-10-17 · **Status:** COMPLETE — both defects fixed, gate green.
**Spec:** docs/INTEGRATION-ROADMAP.md § Phase 1 · **Provenance:** docs/PROVENANCE.md, DECISIONS.log

## Defect 1 — Coverage guarantee does not exist

src/f11/bundle.ts had no coverage guarantee — a single unique-stem file could be silently dropped from all bundles.

**Fix:** Added exported ssertCoverage(files, bundles) to src/f11/bundle.ts. undleFiles() calls it at the end; if any input file is missing from all bundles, it throws Bundle coverage failure: N file(s) not in any bundle: ....

**Test:** undle: coverage guarantee throws when a file is dropped constructs bundles missing one file and asserts the throw.

**Defect 2 — Findings schema mismatch breaks merge after review**

f11's write() mapped .detectorModelId to STATE/findings.json's detector field, but f11's PositionedFinding has no detectorModelId field — it has 
uleId which gets mapped to detector. The ny type on persistFindings hid this mismatch, causing detector: undefined in persisted findings.

**Fix:** Added PersistedFinding interface to src/f11/types.ts with detector: string. 
eview-agent.ts maps findings to PersistedFinding[] (detector: ruleId) before calling persistFindings. wiring/index.ts changed persistFindings parameter type from 
eadonly F08Finding[] to 
eadonly PersistedFinding[] and maps .detector (not .detectorModelId) to 09's detector field.

**Test:** 
eview: dirty file → escalation → veto → merge block — finds SEC-001/SEC-004/SEC-006, persists to STATE/findings.json, merge gate consumes them without error (no INVALID_FINDINGS).

**Repair 3 — Coverage check at consumption point (R3):**

src/f11/review-agent.ts calls ssertCoverage(bundles) immediately after undleFiles() returns, before dispatching any LLM calls. src/f11/bundle.ts re-exports ssertCoverage from its barrel. src/f11/bundle.ts already exported ssertCoverage; src/f11/index.ts re-exports it. Added smoke test that subverts undleFiles to drop a file and asserts ssertCoverage throws.

## Gate

- 
pm run build → exit 0.
- 
pm test → exit 0 · 111/111 (83 at the Phase-2 gate + 27 concurrent Phase-3 persona/severity tests + 1 new f11 coverage guarantee test; zero regressions).


---

## Addendum — THINKING INTEGRATION (system_prompts_leaks-main → deck), 2026-10-18

Integrated reasoning capability from the public system-prompt leak collection
`system_prompts_leaks-main/`, per user direction, using three sources: OpenAI
GPT-5 Thinking prompts, the Claude Code system prompt, and the leaked claude-api
skill's prompt-audit guidance. Governing rule (prompt-audit): on 2026 reasoning
models, depth is controlled by effort configuration and task structure, never by
"think step by step" prose — so no incantations were added.

What changed (all additive, all default-safe):

- **Effort knob (opt-in)** — `ModelRef.reasoningEffort?` in the config layer
  (`src/config/types.ts`, zod enum `src/config/index.ts`) and transport layer
  (`src/transport/types.ts`); all three adapters emit it on the wire when set
  (openai-compatible/custom: `reasoning_effort`; anthropic:
  `output_config.effort` per the leaked claude-api skill — thinking is adaptive
  on current models, so `budget_tokens` is never sent). Unset = wire body
  byte-identical to shipped shape, proven by test.
- **Leader plan protocol** — REASONING PROTOCOL in the TASK_DECOMPOSITION
  *user message* (dependency ordering, smallest viable path set, provable
  acceptance criteria, commit to one decomposition). User-message placement
  survives the Phase-3 persona contract (persona body replaces the system
  prompt verbatim).
- **Leader verify protocol** — VERIFICATION PROTOCOL after the Criterion line
  (order preserved): citation-or-false factuality, never-guess-a-pass
  reporting, judge only what is written.
- **Worker protocol** — fixed `## 6. Execution Protocol` in `buildPrompt`
  (both budget branches, budget-counted): read before write, smallest change,
  verify-then-claim, rabbit-hole rule.

Considered and rejected: two-pass deliberate→commit in `plan()` (doubles cost;
the effort knob delivers hidden native reasoning at high/xhigh); default-on
wire effort (unknown fields can 400 strict endpoints).

Tests: +11 (8 wire/config in `src/transport/reasoning-effort.test.ts`, 2 leader
protocol tests, 1 crew section-6 test).

### Gate
- `npm run build` → exit 0.
- `npm test` → exit 0 — 125/125 (all prior green + 11 new; zero regressions).

### Observed fallout (reported, not absorbed)
- `MERGE_REPORT.md` itself now contains a UTF-16LE region at its tail (NUL
  bytes between ASCII characters, "Repair 3" section onward) — same defect class
  as DECISIONS.log R14. This addendum was appended as clean UTF-8 bytes without
  touching the damaged region; recommend an R14-style full-file remediation plus
  an encoding guard test when the concurrent builder is quiescent.

---

## Addendum — MERGE_REPORT ENCODING REMEDIATION (R14-extended), 2026-10-18

**What was wrong.** `MERGE_REPORT.md` carried the same defect class as the
DECISIONS.log R14 incident: two UTF-16LE runs (NUL bytes between ASCII
characters) interleaved with UTF-8 runs. Measured: 6606 NUL bytes across
[18689..43527]; the file was not valid UTF-8 (`TextDecoder utf-8 fatal` →
`ERR_ENCODING_INVALID_ENCODED_DATA`). Roughly 29 logical lines — the entire
"## Addendum — Phase 11: Review Agent (f11)" section and the R13/"Repair 3"
governance section — were hidden from grep and from every UTF-8 tool.

**What was done (REPAIR 1 — normalize).** Byte-level segment analysis
(32-byte window NUL-density scan + hex dumps at each junction) established an
exact five-segment map: `[0..18689)` UTF-8, `[18689..23711)` UTF-16LE,
`[23711..35274)` UTF-8, `[35274..43528)` UTF-16LE, `[43528..)` UTF-8. Both
UTF-16LE runs have even length and decode cleanly; both UTF-8 runs strict-decode.
The file was rewritten as clean UTF-8 by decoding each segment in its own
encoding and concatenating.

**Evidence.**
- Before: 46225 bytes, 6606 NUL bytes, strict UTF-8 **INVALID**.
- After: 39663 bytes, **zero** NUL bytes, strict UTF-8 **OK**.
- Content preservation: re-decoding the pre-remediation bytes with the same
  segment map reproduces the new file **exactly** (39326 chars,
  `recovered === after` true) — content otherwise unchanged.
- Previously hidden text is now greppable as plain text, e.g.
  `## Addendum — Phase 11: Review Agent (f11)`,
  `Repair 3 — Coverage check at consumption point (R3)`, `111/111`.

**REPAIR 2 — generalize the guard.** `src/wiring/decision-log.test.ts` now
covers every governance artifact — `DECISIONS.log`, `MERGE_REPORT.md`,
`docs/**/*.md` — asserting strict UTF-8 and zero NUL bytes, plus an explicit
fail-then-pass proof: a NUL-injected temp copy of every covered file must FAIL
the guard while the real file PASSES.

**REPAIR 3 — this entry**, citing R14-extended.

**Gate.** `npm run build` exit 0; `npm test` exit 0 — 126/126 (125 prior green
+ 2 new guard tests replacing the 1 old DECISIONS.log special case; zero
regressions).