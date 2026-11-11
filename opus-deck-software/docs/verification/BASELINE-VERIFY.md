# BASELINE VERIFICATION — single-model opus-deck build

Mechanical verification of the assembled build. No source was modified; this file is the
only artifact created. All fixtures were run under the OS temp directory and removed after
(confirmed `CLEANED=true` / `Test-Path=False`).

- **Repo:** `C:\Users\ctayy\Downloads\Studio\opus-deck`
- **Environment:** Node v24.20.0, npm 11.19.0. Plain `npm` is blocked by PowerShell execution
  policy on this machine, so every command ran through `npm.cmd` (same npm, same exit codes).
- **Build type:** single CommonJS package (one `package.json`, one `tsconfig.json`); phase
  layout, reported in §1.

---

## 1. FRESHNESS — PASS

**Layout (phase layout this build used).** `src/` contains the ten original phases plus the
additive folders:

| Phase dir | Files | Phase | Public barrel |
|---|---|---|---|
| `src/config/` | 7 | 1 config & event bus | `src/index.ts` |
| `src/transport/` | 12 | 2 model registry & transport | `src/index.ts` |
| `src/commons/` | 4 | 3 COMMONS core | `src/index.ts` |
| `src/compactor/` | 5 | 4 compactor | `src/index.ts` |
| `src/coordination/` | 15 | 5 presence, claims & locks | `src/index.ts` |
| `src/leader/` | 5 | 6 leader | `src/index.ts` |
| `src/crew/` | 8 | 7 engineering crew runner | `src/index.ts` |
| `src/audit/` | 8 | 8 security audit gate | `src/index.ts` |
| `src/merge/` | 8 | 9 merge & build engine | `src/index.ts` |
| `src/cli/` | 6 | 10 CLI & surface | `src/index.ts` |
| `src/wiring/` | 15 | 11 composition root | — |
| `src/f11/` | 10 | additive review agent | `src/index.ts` |
| `src/f12/` | 9 | additive codegraph (present, not yet wired) | — |

The ten `f01..f10`-equivalent phases are all present and populated. `src/index.ts` is the
public barrel; `docs/PROVENANCE.md` carries the component map.

**Wiring registration.** `src/wiring/index.ts` is the composition root (`wireOpusDeck`) and
registers every phase on ONE shared `EventHub` (no isolated module-default buses). Markers
present:

- `compactor.watch()` called at startup — `src/wiring/index.ts:176` (F-2 marker, present).
- `f07SetDefaultBus(hub)` retarget seam invoked — `src/wiring/index.ts:128`.
- Phase-3 write gate consults phase-5 `holdersOf` via `setClaimsAuthority` — `src/wiring/index.ts:148`.
- `loadClaims()` reads claim rows from `STATE/tasks.json` (claim authority) — `src/merge/verify-build.ts:96-97` (F-1 marker, present).
- `MERGE_REPORT.md` contains the `## Resolved items (formerly deferred)` section — line 166 (present).

**DECISIONS.log.** Exists at `opus-deck/DECISIONS.log` (13,765 bytes, UTF-8), header
`OPUS//DECK INTEGRATION DECISIONS LOG`. Present.

Observation (informational, not a failure): `wireOpusDeck` is consumed by the composition
root's own tests and by `docs/INTEGRATION-ROADMAP.md` as "wiring registered in
`src/wiring/index.ts`", but is not re-exported from the top-level `src/index.ts` barrel
(only `initOpusDeck` is). This matches the documented usage; no gate depends on it.

---

## 2. GATES — PASS

| Command | Exit |
|---|---|
| `npm.cmd run build` (`tsc`, strict) | **0**, no diagnostics |
| `npm.cmd test` (`npm run build && node --test "dist/**/*.test.js"`) | **0** |

Test count from the runner: **tests 65, pass 65, fail 0, cancelled 0, skipped 0, todo 0**
(`duration_ms ~911`). Both commands exit 0.

---

## 3. EVENT NAME CHECK — PASS

- **Shipped name: `run.completed`.** Emitted at `src/leader/leader.ts:165`:
  `await this.bus.emit('run.completed', { checksum, fileCount: signOff.fileCount, at: signOff.generatedAt })`.
- It is declared in the emitter's event constant/type set: `src/config/types.ts:88`
  (`| 'run.completed'`) and mapped to `RunCompletedPayload` at `src/config/types.ts:222`;
  also `src/cli/types.ts:55`.
- **Catalog:** `docs/PROVENANCE.md:133` — `| run.completed | Run signed off |`.
- **`run.committed`: zero matches** anywhere in the repo (src, dist, docs, README).

**Verdict: the shipped emitter emits `run.completed`, and the catalog matches the emitter.**
`run.committed` is not present; no catalog/emitter drift.

---

## 4. COMPACTION (gate item 5, both paths) — PASS

Fixture: temp `COMMONS` opened via `initOpusDeck` + `wireOpusDeck` (mock transport); seeded
`STATE/digest.md` over the default `digestTokens` budget (2000) with a `PINS` line
`- CRITICAL PIN: never drop this pinned line`. Cleaned up after (`CLEANED=true`).

Observed:

```
seededDigestTokens              = 7314          # over the 2000 budget
pathA_promptTokens              = 7394          # buildPrompt over prompt budget (set to 50)
pathA_compactionRequestedCount  = 1             # buildPrompt -> compaction.requested on shared hub
pathA_compactionDoneReceived    = true          # compactor.watch() handler completed a pass
pathA_compactionDoneCount       = 1
pathA_digestTokens              = 35            # digest shrank below budget
pathA_digestShrank              = true
pathA_archiveFiles              = ["digest@v1.md"]   # ARCHIVE digest written
pathA_pinSurvived               = true          # PINS line survived
rerun_ran                       = false         # idempotent (fingerprint unchanged)
rerun_noExtraCompactionDone     = true          # second trigger no-ops
pathB_secondCompactionDone      = true          # digest-growth trigger -> 2nd compaction
pathB_compactionDoneCount       = 2
pathB_digestTokens              = 33
pathB_archiveFiles              = ["digest@v1.md","digest@v2.md"]
pathB_growthPinSurvived         = true
```

- **Path A (oversized `buildPrompt` budget → `compaction.done`):** an over-budget
  `buildPrompt` emitted `compaction.requested` on the shared hub; `compactor.watch()`
  subscribed at startup ran one pass, emitted `compaction.done`, wrote
  `ARCHIVE/digest@v1.md`, shrank the digest, and preserved the PIN. A rerun is idempotent
  (`ran=false`, no extra `compaction.done`).
- **Path B (digest-growth trigger → second compaction):** a fresh over-budget digest plus a
  `commons.changed` event raised a second pass → `ARCHIVE/digest@v2.md` and a second
  `compaction.done`; the growth PIN also survived.

---

## 5. GATE FIXTURE (gate item 6) — PASS

Fixture (temp dir, removed after): `WORKSPACE/app.ts` present; `STATE/tasks.json` holds a
**live claim row**; `STATE/presence.json` is **empty** (`entries: []`); `findings.json` empty.

```
presenceEntries   = 0
loadClaimsCount   = 1
loadClaims        = [{"holder":"eng-1","path":"src/app.ts","released":false}]
danglingPassed    = false
danglingDetail    = 1 dangling: eng-1:src/app.ts
mergeThrew        = true
mergeErrorCode    = GATE_FAILED
mergeErrorFolder  = merge
manifestWritten   = false
```

- Dangling lock is reported from the `STATE/tasks.json` claim (not presence.json); with no
  presence entry the lock still dangles.
- `merge()` throws `CommonsError { code: "GATE_FAILED" }` and writes **no** `MANIFEST.json`.

---

## 6. VETO PATH (gate item 4d) — PASS

Fixture (temp dir, removed after): dirty smoke via `wireOpusDeck` — file contains
`eval(input);` (SEC-001, no strategy), a hardcoded secret (SEC-004, env-var), and
`Math.random()` (SEC-006). Findings scanned/persisted, then `remediateFindings` ran with the
wired escalation queue (onPush → `reviewQueue.decide`).

```
findings                = ["SEC-001","SEC-004","SEC-006"]
escalationId            = ESC-71E9FF6E
escalationPath          = src/app.ts
pendingCount            = 1
decisionId              = D-01
decisionTouched         = ["src/app.ts","SEC-001"]
decisionStatus          = pending
vetoedStatus            = vetoed
followUpTaskId          = T-02
followUpFoundInStore    = true
followUpPath            = src/app.ts
resolved_commons_exists = false                       # not mis-prefixed with WORKSPACE/
resolved_workspaceRel_exists = true                   # real file: COMMONS/WORKSPACE/src/app.ts
doubleWorkspacePrefix   = false
holdersOf_afterVetoRoute = ["eng-1"]                  # routed claim landed on the path
acquirable_afterRelease  = true                       # coordination grants a fresh claim
```

- The unpatchable `eval()` escalates (not advisory), lands in the ReviewQueue as a **pending**
  decision `D-01` touching `src/app.ts`, and `veto()` produces follow-up task `T-02`.
- The follow-up task's path is `src/app.ts` (a WORKSPACE-relative path), resolves to the real
  file `COMMONS/WORKSPACE/src/app.ts`, carries no `WORKSPACE/WORKSPACE/` duplication, is
  recognized by the claims authority (`holdersOf` = the routed holder), and is genuinely
  claimable (a fresh `acquire` returns `granted` once the existing holder releases).

---

## FINAL VERDICT

All items pass: layout present, build exit 0, test exit 0 (65/65), event name `run.completed`
matches both the emitter and the catalog, compaction both paths verified (ARCHIVE digest,
PINS survive, idempotent rerun, second compaction on growth), the gate fixture reports the
dangling lock and throws `GATE_FAILED`, and the veto follow-up task path is a real claimable
WORKSPACE path. Fixtures lived under temp and were removed.

BASELINE: VERIFIED
