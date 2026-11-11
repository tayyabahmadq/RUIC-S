# ACCEPTANCE — opus-deck/ final gate (V-2b, post-repair round F)

Repo path verified: C:\Users\ctayy\Downloads\Studio\opus-deck
mtime of opus-deck/src/wiring/index.ts: 10/17/2026 4:48:13 PM
mtime of opus-deck/src/f09/verify-build.ts: 10/17/2026 3:39:24 AM

Freshness gate (STEP 0) — all markers present:
  a. compactor.watch() call at startup in wiring/index.ts (line 165) — PRESENT (F-2 marker)
  b. loadClaims reads STATE/tasks.json claim rows in verify-build.ts (line 140) — PRESENT (F-1 marker)
  c. MERGE_REPORT.md contains "Resolved items (formerly deferred)" section (line 166) — PRESENT (report-state marker)

All ten original INTEGRATION.txt files preserved at opus-deck/docs/integration/.

---

## CHECK 1 — TREE — PASS (carried forward from V-2)
opus-deck/ exists with package.json, tsconfig.json, src/, DECISIONS.log, MERGE_REPORT.md at root.
docs/integration/ holds all ten INTEGRATION.txt files (all non-empty).

## CHECK 2 — GATE (npm install && npm run build) — PASS
`npm.cmd install` exited 0; `npm.cmd run build` (tsc, strict ES2022/commonjs) exited 0 with no diagnostics.

## CHECK 3 — STUB — PASS (carried forward from V-2)
No file named stubs.ts anywhere under opus-deck/src/. No references to deleted-stubs modules remain (only folder-09's own `StubSeed` type, declared in src/f09/types.ts, not an import from a stubs file).

## CHECK 4 — CLEAN SMOKE — PASS (carried forward, re-verified: 5/5)
`npm test` = tsc + node --test dist/smoke.test.js, exit 0, 5/5 pass:
  - initOpusDeck boots and completes a trivial one-file build end-to-end (plan -> route -> build -> audit -> merge -> signOff, asserting run.completed)
  - f09 gate: live tasks.json claim with empty presence.json reports a dangling lock
  - f09 gate: no claim rows reports zero dangling locks (control)
  - escalation routing: unpatchable eval() finding lands in ReviewQueue as pending
  - compactor trigger: over-budget digest fires compaction on the shared bus

## CHECK 5 — DIRTY SMOKE — PASS (re-run incl. veto-path 5a–5d; new task/escalation IDs)
Purpose-built harness (temp dir, deleted after run): same wiring/crew/mock transport; WORKSPACE/src/app.ts contains SEC-001 `eval(input);` (critical, no strategy), SEC-004 hardcoded secret `sk-prod-...` (critical, env-var strategy), SEC-006 `Math.random()` (medium).

**5a — finding raised and persisted — VERIFIED.** Folder-08 scan raised all 3 findings (two auditors, quorum 2). After `persistFindings`, STATE/findings.json contained 3 rows with `detectorModelId` mapped to `detector`.

**5b — patchable finding -> task emitted — VERIFIED.** `remediateFindings` emitted tasks `RTD-0779138D` (SEC-004, env-var, round 1) and `RTD-04790ED4` (SEC-004, env-var, round 2). Task IDs are NEW (not RTD-7B23B52F from prior round). The emit->execute->re-scan loop mechanics work via the wired ArtifactStore (source: artifact-store).

**5c — unpatchable finding ESCALATED, not advisory; reaches ReviewQueue; veto path — VERIFIED.** SEC-001 produced escalation `ESC-0169C98B` (kind security-escalation, reason `no-patch-strategy`, rounds 0). Task/escalation IDs are NEW (not ESC-172FFA1C from prior round). `advisories` contained only the medium SEC-006 advisory (blocking: false) — deliberate contrast. Deferral 1 fixed: escalation reached folder-06's ReviewQueue as pending decision `D-01` (touched [src/app.ts, SEC-001], status pending). Veto path exercised: `veto('D-01', ...)` set status vetoed and produced follow-up task `T-02` (veto reason routed as a follow-up task per folder-06's contract).

**5d — unresolved critical blocks folder-09 merge gate — VERIFIED.** With unresolved criticals persisted, `checkReadiness()` returned dangling-locks failed (2 dangling from tasks.json claim rows). `merge()` threw `CommonsError { code: "GATE_FAILED", folder: "folder-09" }` and no MANIFEST.json was written.

## CHECK 6 — MERGE-GATE CLAIM SOURCE — PASS (re-run, F-1 fix verified)
`src/f09/verify-build.ts` `loadClaims()` reads `STATE/tasks.json` (line 140), not presence.json. Runtime-confirmed: a COMMONS with live claim rows in STATE/tasks.json fails `dangling-locks`; claim-free store passes. The gate logic is intact and sourced from the correct store (folder-05's claim authority).

## CHECK 7 — COMPACTOR TRIGGER — PASS (re-run, F-2 fix verified)
`src/wiring/index.ts` calls `compactor.watch()` at startup (line 165), subscribing the compactor to the shared EventHub. `f07SetDefaultBus(hub)` retargets folder-07's default bus (via new `setDefaultBus()` seam in src/f07/defaults.ts) so `buildPrompt`'s `compaction.requested` emit reaches the compactor on the shared hub — not folder-07's isolated default bus. Runtime-confirmed: digest exceeded `digestTokens` (2000), `compaction.done` emitted on shared hub, digest shrank below budget, idempotent rerun no-oped (fingerprint rule).

## CHECK 8 — REPORT DIFF — PASS (carried forward from V-2)
All MERGE_REPORT.md / DECISIONS.log claims verified against code. The prior minor inaccuracy (tsconfig "*.test.ts excluded") was corrected in DECISIONS.log. Both documented deferrals (escalation routing, compactor trigger) are now resolved and reflected in MERGE_REPORT.md's "Resolved items (formerly deferred)" section.

---

## FINAL VERDICT

ACCEPT: YES — issues: []

All acceptance checks pass after repair round F. The tree contains the repair (all STEP 0 freshness markers present), build exits 0, clean smoke 5/5 pass, dirty smoke 5a–5d pass with veto path, merge gate reads tasks.json claim authority, and compactor trigger fires on the shared bus. No stubs remain. Ten INTEGRATION.txt provenance files preserved.
