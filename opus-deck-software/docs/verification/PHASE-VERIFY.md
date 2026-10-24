# PHASE VERIFICATION — roadmap phases 1–4 (f11 review, f12 codegraph, personas + severity, confirmation tokens)

Mechanical verification of four phases built on the accepted baseline, **re-verified after the P1R
and P2R directed repairs**. **No source file was modified.** This report is the only artifact
created. All fixtures were built under the OS temp directory and removed after the run.

> **Round 5 / governance close-out (2026-10-18, after repair R14).** Scope: the encoding of the
> decision log, the appended corrections, the encoding guard, and regression. **Phase 2 (§5.2),
> phase 3 (§5.3) and phase 4 (§5.4) are carried forward untouched**, as are their verdict lines.

### Freshness markers for the R14 close-out round

| Marker | Where | Result |
|---|---|---|
| `DECISIONS.log` is strict UTF-8, zero NUL bytes | 44,814 bytes at close (40,905 when measured, appended to mid-verification), strict decode OK, round-trip lossless | **PRESENT** |
| Encoding guard test | `src/wiring/decision-log.test.ts` (created 10/18 00:58:10) | **PRESENT** |
| Appended correction to the DEFECT 2 entry | `DECISIONS.log:154` | **PRESENT — but inaccurate on one clause** |
| `src/f11/defaults.ts` citation removed | `DECISIONS.log:156` now cites `src/f11/bundle.ts` | **PRESENT** |
| R13 entry symbol-anchored / accurate references | `DECISIONS.log:165` | **FAIL — wrong line `:341` and inverted mapping** |

### R14 repair-window file mtimes (verified against)

| File | Created | Last written |
|---|---|---|
| `src/wiring/decision-log.test.ts` | **10/18 00:58:10** (new) | 10/18 00:59:43 |
| `DECISIONS.log` | 10/17 02:21:04 | **10/18 01:01:25** |
| `MERGE_REPORT.md` | 10/17 02:57:36 | 10/18 00:28:08 (not touched this round) |

Unrelated concurrent work in the same window (a separate feature, not Phase 1):
`src/transport/{types.ts,adapters/openai-compatible.ts,adapters/anthropic.ts,adapters/custom.ts}`
(01:11:23–01:11:36), `src/config/{index.ts,types.ts}` (01:11:53), `src/leader/leader.ts` (01:12:14),
`src/crew/assemble-prompt.ts` (01:12:42), `src/crew/smoke.test.ts` and `src/leader/smoke.test.ts`
(01:15:14), new `src/transport/reasoning-effort.test.ts` (01:13:40), `docs/thinking.md` (01:18:18).
Phase 1's own source files and `src/wiring/dirty-smoke.test.ts` were not touched.

### Freshness markers for the R13 repair round

| Marker | Where | Result |
|---|---|---|
| No `any` at the f11 findings boundary | `src/f11/types.ts:123` — `readonly persistFindings: (findings: readonly PersistedFinding[])` | **PRESENT** |
| Reviewer-id attribution | `src/f11/review-agent.ts:203` — `detector: this.deps.reviewModelId` | **PRESENT** |
| Single adapter, injected once | `src/wiring/index.ts:360` (`f11FindingsToF08`), `:292` (injection), `:175` (canonical signature) | **PRESENT** |
| Consumption-point coverage test | new file `src/f11/seam.test.ts` (created 00:36:10) | **PRESENT** |
| R13 governance entry | `DECISIONS.log:320` (session header), `:323` (binding ruling), `:325-331` (evidence) | **PRESENT** |
| Stale `PersistedFinding[]`-as-current-fact assertion removed | `DECISIONS.log:314` | **ABSENT — FAIL** |
| `src/f11/defaults.ts` references removed from the logs | `DECISIONS.log:316` | **ABSENT — FAIL** |

### R13 repair-window file mtimes (verified against)

| File | Created | Last written |
|---|---|---|
| `src/f11/types.ts` | 10/17 19:12:34 | **10/18 00:35:25** |
| `src/f11/review-agent.ts` | 10/17 19:17:30 | **10/18 00:35:30** |
| `src/wiring/index.ts` | 10/17 18:37:44 | **10/18 00:35:38** |
| `src/f11/seam.test.ts` | **10/18 00:36:10** (new) | 10/18 00:36:10 |
| `DECISIONS.log` | 10/17 02:21:04 | **10/18 00:38:44** |
| `MERGE_REPORT.md` | 10/17 02:57:36 | 10/18 00:28:08 (unchanged this round) |

`src/wiring/dirty-smoke.test.ts` was **not** touched in this window — it remains the accepted
baseline content (7,198 bytes, `sha256 E8A0F92A…`, last written 10/18 00:07:22). Phase-2 and
phase-3/4 areas are untouched.

| | |
|---|---|
| **Repo verified** | `C:\Users\ctayy\Downloads\Studio\opus-deck` |
| **Baseline reference** | `Studio/BASELINE-VERIFY.md` (baseline lock, 65 tests, 2026-10-17 20:47:47 local) |
| **Accepted baseline** | `Studio/ACCEPTANCE.md` (ACCEPT: YES) |
| **Round 1 report** | this file, sections §4, §5.1, §5.2 and the Phase 1/2 verdict lines (superseded below) |
| **Round 2 report** | this file, §4, §5.1, §6.1, §7 items 9-10 and the Phase 1 verdict line (partly superseded below) |
| **Environment** | Node v24.20.0, npm 11.19.0. Plain `npm` is blocked by PowerShell execution policy → every command ran through `npm.cmd`. |

### Freshness markers for P1R2 (this round)

| Marker | Where | Result |
|---|---|---|
| Baseline seam signature restored | `src/wiring/index.ts:175` and `:340` — `persistFindings(findings: readonly F08Finding[])`, mapping `detector: f.detectorModelId` | **PRESENT** |
| Exactly one f11 → canonical adapter | `src/wiring/index.ts:359-367` (`f11FindingsToF08`), injected once at `:291-292` | **PRESENT** |
| f08 audit call sites unmodified | `src/wiring/dirty-smoke.test.ts:78` — `await wired.persistFindings(report.findings)` | **PRESENT** |
| Coverage check at the consumption point | `src/f11/review-agent.ts:11` (import) and `:56` — `assertCoverage(included, bundles)` right after `bundleFiles()` | **PRESENT** |
| Findings-boundary `any` removed from the f11 dep | `src/f11/types.ts:122` — still `readonly persistFindings: (findings: any[])` | **ABSENT** |

### P1R2 repair-window file mtimes (verified against)

Seven files touched, **no new files created** — every file's NTFS creation time still predates the
original phase build:

| File | Created | Last written |
|---|---|---|
| `src/wiring/dirty-smoke.test.ts` | 10/17 18:50:42 | **10/18 00:07:22** |
| `src/wiring/index.ts` | 10/17 18:37:44 | **10/18 00:16:24** |
| `src/f11/index.ts` | 10/17 19:18:22 | **10/18 00:23:07** |
| `src/f11/review-agent.ts` | 10/17 19:17:30 | **10/18 00:23:13** |
| `src/f11/smoke.test.ts` | 10/17 19:34:23 | **10/18 00:26:05** |
| `DECISIONS.log` | 10/17 02:21:04 | **10/18 00:27:30** |
| `MERGE_REPORT.md` | 10/17 02:57:36 | **10/18 00:28:08** |

`src/f11/types.ts` — which holds the `any` — was **not** touched in this window (last written
10/17 23:18:01, the P1R round). Phase-2 and phase-3/4 areas are untouched. The previous repair
window's mtimes (P1R/P2R, 23:11–23:41 on 10/17) stand as recorded above.

---

## 0. FRESHNESS (STEP 0) — all four phases PRESENT, repairs PRESENT

| Phase | Marker | Result |
|---|---|---|
| f11 | `src/f11/` populated; `review.*` events in catalog | **PRESENT** |
| f12 | `src/f12/` populated; `codegraph.rebuilt` in catalog | **PRESENT** |
| P3 | `CREW/personas/` handling + `src/wiring/personas.ts`; severity config | **PRESENT** |
| P4 | `src/wiring/confirmations.ts`; `action.confirmed`/`action.rejected` in catalog | **PRESENT** |
| P1R | throw-based coverage assertion in `src/f11/` | **PRESENT** |
| P1R | typed findings seam at wiring | **PRESENT** |
| P2R | `memory.written` producer | **PRESENT** |
| P2R | digest slot in the leader plan prompt | **PRESENT** |

---

## 1. BASELINE LOCK — PASS

| Command | Exit |
|---|---|
| `npm.cmd run build` (`tsc`, strict ES2022/commonjs) | **0**, no diagnostics |
| `npm.cmd test` | **0** — `tests=111 pass=111 fail=0` |

Per-file counts: core **45** (unchanged), `f11` **10** (+1), `f12` **20** (+2), `wiring/personas` 15,
`wiring/severity` 10, `wiring/confirmations` 11 (all three untouched) → **111**.

Round 1's 108 reconciles: `45 core + 9 f11 + 11 confirmations = 65` (the baseline-with-f11 snapshot,
where `wiring/confirmations.test.ts` existed from 19:15 and `f12/smoke.test.ts` only from 20:58);
`+18 f12 +15 personas +10 severity = 108`. The three new tests are the repairs' own:
`bundle: coverage guarantee throws when a file is dropped`,
`live: writes through the wired commons trigger a real codegraph rebuild (no manual emission)`,
`live: rebuilt CODEMAP reaches the leader plan prompt through the digest slot` — plus the
`catalog audit:` test, which is a rename of the replaced hook test rather than an addition.
**No test was removed, skipped or weakened in count.**

---

## 2. DIFF CONFINEMENT (R8) — the repair round

The phase verdicts below are scoped to the originally-rejected findings; for completeness, the
repair round's own footprint:

* **In the whitelist:** new code inside `src/f11/` and `src/f12/` (`bundle.ts`, `types.ts`,
  `index.ts`, `review-agent.ts`, `smoke.test.ts` ×2), the wiring registration
  (`src/wiring/index.ts`), the docs (`PROVENANCE.md`, `DECISIONS.log`, `MERGE_REPORT.md`), and the
  event-catalog seam (`src/config/types.ts`).
* **Outside the whitelist, logged as pre-approved exceptions:** `src/leader/leader.ts` and
  `src/leader/types.ts` (the digest slot) and `src/wiring/leader-commons-adapter.ts`
  (`readDigest()`), plus one baseline test file, `src/wiring/dirty-smoke.test.ts`. The exception is
  recorded in `DECISIONS.log` lines 288-297 as "[R8 exception, orchestrator-approved]". The
  leader-side changes are additive and default-preserving (`readDigest?()` is optional, `?? ''`).
* **The `dirty-smoke.test.ts` edit is not cosmetic** — it changed the call shape at line 78. See
  §5.1(c); it is the reason the collateral regression below stayed invisible to the suite.

Everything from round 1 (§2.1, §2.2) stands unchanged: no file outside `opus-deck/` was touched,
`parts/` and `main/` are clean, and the twelve baseline test files still carry their pre-phase mtimes.

---

## 3. SEAM AUDIT

### R1 — one estimator — **PASS** (unchanged)

`src/f11/bundle.ts:8` and `src/f12/section.ts:6` both import `estimateTokens` from
`../compactor/index.js`; a sweep of all 18 non-test files in the two folders still finds **zero**
local estimator definitions. *Pre-existing footnote unchanged:* `src/crew/assemble-prompt.ts:25`
has its own `Math.ceil(text.length / 4)`, written at 18:07 in the baseline and untouched by any phase.

### R2 — all new events additive; catalog ↔ code diff — **PASS** (re-diffed after the repair)

```
code union (20) == catalog rows (20)   IN CODE NOT IN CATALOG: []   IN CATALOG NOT IN CODE: []
payload map keys == union: true
```

`src/config/types.ts` was edited in the repair window (23:11) to document the `memory.written`
payload as `{ path, txnId, author }`; the union's 20 members are unchanged and no existing event was
repurposed or widened.

### R3 — review calls bypass the task queue — **PASS** (unchanged)

A review run still makes its LLM calls on the raw folder-02 transport (`wiring/index.ts:285`
injects `options.transport`, not `f07.transport`), enqueues nothing on the f07 task bus, and leaves
`STATE/tasks.json` byte-identical.

### R5 — severity resolved once at wiring — **PASS** (unchanged)

Still exactly **one** parser of `STATE/config.json` (`severity-config.ts:118`); the value is
resolved once at `wiring/index.ts` boot and injected into both consumers. The repair did not touch
`severity-config.ts`, `audit/remediate.ts`, or `merge/verify-build.ts`.

### R6 — CODEMAP demotes under compaction, rebuild restores — **PASS** (re-confirmed post-repair)

```
R6_1_preCompactHasCODEMAP=true     (reached through the LIVE hook, not an explicit rebuild)
R6_2_compactRan=true  afterCompactHasCODEMAP=false
R6_3_keptSections=[ARCH, IFACE, OPEN, SETTLED, PINS]     R6_4_archive=["digest@v1.md"]
R6_5_afterRebuildHasCODEMAP=true   compactedHeaderPreserved=true
```

### R7 — distinct codes for expiry vs replay — **PASS** (unchanged)

`confirmations.ts:54-65` is untouched: `CONFIRMATION_EXPIRED` / `CONFIRMATION_REPLAYED` /
`CONFIRMATION_WRONG_SCOPE` / `CONFIRMATION_MALFORMED`, each with its own `action.rejected` reason.

---

## 4. R9 — COVERAGE ASSERTION PROBE — **FIXED and CLOSED** (producer + consumption point)

Round 1 rejected this because **zero `throw` statements existed in `src/f11/`**. That is now false.

### 4a. The assertion exists, checks ACTUAL membership, and fires — **PASS**

`src/f11/bundle.ts:53-67`:

```ts
  // Coverage guarantee: every input file must appear in at least one bundle.
  assertCoverage(files, bundles)
  ...
export function assertCoverage(files: string[], bundles: ReviewBundle[]): void {
  const bundledFiles = new Set(bundles.flatMap((b) => b.files))
  const missing = files.filter((f) => !bundledFiles.has(f))
  if (missing.length > 0) {
    throw new Error(
      `Bundle coverage failure: ${missing.length} file(s) not in any bundle: ${missing.join(', ')}`,
    )
  }
}
```

It is called **after** the bundling loop and reads `bundles.flatMap(b => b.files)` — the real output
bundles, not an intermediate set — which is exactly the property the R9 probe demanded.

### 4b. Proof it fires (faithful re-introduction of the historical bug)

I copied the compiled bundler to a temp directory and deleted the singleton push — the literal
pre-fix code shape (`groups.push([file])` → nothing) — then required the patched module:

```
a2_patchedSingletonPush                        = true
a2_historicalBug_input = ["app.ts","app.test.ts","loose.ts"]   (loose.ts has a unique stem)

a2_THREW = Error: Bundle coverage failure: 1 file(s) not in any bundle: WORKSPACE/src/loose.ts
a2_quoted_error_name    = Error
a2_quoted_error_message = "Bundle coverage failure: 1 file(s) not in any bundle: WORKSPACE/src/loose.ts"
a2_isErrorInstance      = true

a2_correctInput_threw      = no (correct)                    ← no false positive
a2_unpatchedSameInput      = [["…/app.test.ts","…/app.ts"],["…/loose.ts"]]   ← the fix still bundles it
```

The guarantee fires on the real defect shape and stays quiet on correct input.

### 4c. Residual from round 2 — **CLOSED: the check now runs at the consumption point**

Round 2 noted that the assertion was only an internal post-condition of `bundleFiles`, so a drop
introduced *after* it returned completed silently. That gap is closed: `review-agent.ts:11` imports
`assertCoverage` and calls it at `:56`, immediately after `bundleFiles()` returns and **before any
LLM call is dispatched**. Re-running my round-2 method — wrapping the module export so the drop
happens after the bundler returns:

```
4_method       = wrap the module export; drop WORKSPACE/src/zebra.ts from every bundle
4_review_threw = YES
4_throw_name   = Error
4_throw_message = "Bundle coverage failure: 1 file(s) not in any bundle: WORKSPACE/src/zebra.ts"
4_agentRechecksMembership      = true   (2 references to assertCoverage in review-agent.ts)
4_barrelExportsAssertCoverage  = false  (f11/index.ts still does not re-export it — minor)
```

Both the producer-side post-condition (`bundle.ts:54`) and the consumption-point check
(`review-agent.ts:56`) now fire. `DECISIONS.log` line 316 records this as `[R3] Coverage check at
consumption point`.

### 4d. Audit-file reconciliation, from the audit's own data — **PASS**

`STATE/folder-11/reviews/E2E.json`, read back from disk after the P1R2 build:

```
auditReconciles = true      selectedNotBundled = []
review.completed on the hub = {"runId":"E2E","requests":2,
  "bundles":[{"id":"BND-000001","files":["WORKSPACE/src/app.ts"],"tokenEstimate":5}],
  "findings":1,"dropped":0,"reflections":1}
```

(An earlier round also verified the full-accounting shape: 4 collected = 2 selected +
2 excluded-with-reason, 0 duplicates.)

---

## 5.1 f11 — review agent (governance close-out)

The code is unchanged and remains correct. This round verifies the governance record: the encoding
defect, the appended corrections, and the guard test. Phases 2–4 are untouched.

### Technical state (carried, re-confirmed this round)

`src/f11/types.ts:123` — `readonly persistFindings: (findings: readonly PersistedFinding[])` (no
`any`); a wrong-shaped injected implementation fails with **TS2322**; the canonical consumer
boundary is independently strict (**TS2345**). Wiring unchanged: canonical signature `:175`, one
adapter `:360`, injected once `:292`, canonical mapping `:344`, attribution `review-agent.ts:203`.
Build exit 0, **125/125** green, dirty smoke reaches `GATE_FAILED` through the original call shape
(detectors `["sec-1","sec-1","sec-1"]`, `INVALID_FINDINGS=false`) — full detail in §6.1.

### 1. ENCODING — **PASS**

```
DECISIONS.log        bytes = 40,905 at measurement (44,814 at close — appended mid-verification)
strict UTF-8 decode  = SUCCESS (UTF8Encoding(throwOnInvalidBytes: true))
NUL bytes            = 0            ← the UTF-16LE run (previously bytes 11381-31742) is gone
BOM                  = absent
UTF-8 round-trip     = lossless (re-encode equals the original byte-for-byte)
```

The file was appended to (173 → 184 lines) by unrelated work while this verification ran, so the
four governance lines quoted below were re-read against the final content at 01:19:02 — all four are
**unchanged**, as are the three code facts they are judged against (`wiring/index.ts:341` is still the
`.map(` opening, `:344` still maps `detector: f.detectorModelId`; `review-agent.ts:203` still sets
`this.deps.reviewModelId`; `src/f11/index.ts` still has **zero** export lines mentioning
`assertCoverage`).

The previously-hidden run is now greppable. Control search: `"R13"` now returns **10 hits** through
a plain text scan (previously the affected region was unsearchable — the string is not contiguous in
the file when NUL bytes separate every character).

**On searching the `defaults.ts` text specifically: there are now zero occurrences of `defaults.ts`
anywhere in `DECISIONS.log`** (the only surviving hit for "defaults" is the unrelated
`budget defaults (2000/6000)` at line 18). That is because the phantom citation was *removed* rather
than merely made searchable. Quoted with surrounding context, line 156:

```
154: - [CORRECTED under R13/R14] The above describes the P1R2 state and is superseded: canonical
     signature restored (F08Finding[]), detector: f.detectorModelId, review-agent sets detector:
     f.ruleId, dirty-smoke.test.ts byte-identical to baseline.
155:
156: - [R3] Coverage check at consumption point: src/f11/review-agent.ts calls
     assertCoverage(included, bundles) immediately after bundleFiles() returns, before any LLM call
     is dispatched. src/f11/bundle.ts exports assertCoverage; src/f11/index.ts re-exports it.
     Added smoke test that subverts bundleFiles to drop a file and asserts assertCoverage throws.
```

Previously line 316 read `src/f11/defaults.ts re-exports assertCoverage from ./bundle.js`. The
citation now points at `src/f11/bundle.ts` — the file that actually exists and does export it.

### 2. CORRECTIONS — **FAIL** (present, but two of the three do not match the code)

**(b) Line-153 correction — appended, but states a fact the code contradicts.**

A correction was appended at `DECISIONS.log:154` (the log is append-only; the stale DEFECT 2 text
at 153 is preserved above it, as it should be). Three of its four clauses match the verified code:
canonical signature restored to `F08Finding[]` ✓, `detector: f.detectorModelId` ✓,
`dirty-smoke.test.ts` byte-identical to baseline ✓.

The fourth clause does not:

> line 154: "… review-agent sets detector: **f.ruleId** …"

`src/f11/review-agent.ts:203` is `detector: this.deps.reviewModelId`. The same log says so
correctly at line 168 — "`review-agent.ts:203` changed `detector: f.ruleId` -> `detector:
this.deps.reviewModelId` … never the rule id" — so **the log now contradicts itself**, and the
correction entry is the wrong half. The criterion requires the appended correction to match the
verified code state; it does not.

**(c) `defaults.ts` citation — removed ✓, but the replacement is inaccurate.**

The phantom reference is gone (line 156 above), which satisfies the requirement. However the
replacement asserts `src/f11/index.ts re-exports it` — it does not. `src/f11/index.ts` contains
exactly one mention of `assertCoverage`, line 18, an **import**:

```
src/f11/index.ts:18   import { bundleFiles, assertCoverage } from './bundle.js'
export lines mentioning assertCoverage in f11/index.ts = 0
```

So one false claim (`src/f11/defaults.ts re-exports assertCoverage`) was replaced by another
(`src/f11/index.ts re-exports it`). The specific requirement is met; the surrounding text is not
reliable.

**(d) R13 entry symbol-anchored references — still wrong, and now inverted.**

| R13 line 165 claim | actual | verdict |
|---|---|---|
| `src/wiring/index.ts:175` canonical signature | line 175 ✓ | correct |
| `:341` canonical impl maps … | the canonical mapping is at **line 344**; line 341 is the `.map(` opening | **wrong line** |
| …maps **`detectorModelId: f.detector`** | the canonical impl at `:344` maps `detector: f.detectorModelId`. It is the **adapter** at `:364` that maps `detectorModelId: f.detector` | **direction inverted** |
| `:360` adapter, injected once at `:292` | ✓ | correct |
| `review-agent.ts:226`, `types.ts:87`, `types.ts:123` | ✓ | correct |

The previous round recorded this as "`:341` … maps `detector: f.detectorModelId`" — right direction,
wrong line. The edit changed the direction too, so the entry is now inaccurate in two ways instead
of one. Per the stated condition ("an entry that cites wrong line numbers or wrong facts is also a
FAIL"), this fails.

### 3. GUARD — **PASS**

`src/wiring/decision-log.test.ts` (created 10/18 00:58:10, written 00:59:43) asserts that
`DECISIONS.log` decodes as UTF-8 with no NUL bytes and round-trips losslessly. It is in the suite
and passes (`dist/wiring/decision-log.test.js tests=1 fail=0`).

Because the guard resolves the log via `process.cwd()`, I could point the **real compiled test** at
temp copies without touching the repo's log:

| fixture | result |
|---|---|
| byte-exact copy of the clean log | **PASSES** (`ok 1 - DECISIONS.log decodes as strict UTF-8 with no NUL bytes`) |
| copy with one NUL byte injected at offset 11,393 (inside `PHASE 11 (review agent)`) | **FAILS** — `error: 'DECISIONS.log contains NUL bytes — not clean UTF-8'`, expected true, actual false |
| copy with an invalid 2-byte sequence (`C3 28`) at offset 100 | **FAILS** — round-trip byte-length mismatch, expected 44,814, actual 44,816 |

The guard demonstrably fails on a NUL-injected copy, as required.

*Accuracy note (non-blocking):* the test's comment claims "Strict UTF-8 decode must succeed", but
line 19 uses `fs.readFileSync(logPath, 'utf-8')`, which is lenient — Node substitutes U+FFFD rather
than throwing. Invalid sequences are therefore caught by the **round-trip byte comparison**, not by
a strict decode. Coverage is complete for both cases (demonstrated above); only the wording
overstates the mechanism. The test is also cwd-dependent, so it only resolves the log when run from
the repo root.

### 4. REGRESSION — **PASS**

| Gate | Result |
|---|---|
| `npm.cmd run build` | exit **0**, no diagnostics |
| `npm.cmd test` | exit **0** — **125/125 pass, 0 fail** |
| dirty smoke, original call shape | `persisted=3 detectors=["sec-1","sec-1","sec-1"]`; `SEC-004:env-var` resolved; `no-patch-strategy:critical` escalated; `D-01` pending; veto → `T-02` on `src/app.ts`, claimable `"granted"`; `merge = GATE_FAILED folder=merge`, no MANIFEST; `GATE_FAILED_VIA_ORIGINAL_PATH=true`, `INVALID_FINDINGS=false` |

Test count moved 113 → 125. The +12 are **not** Phase 1: `wiring/decision-log.test.js` (1, the
encoding guard) and `transport/reasoning-effort.test.js` (8), plus +1 in `crew/smoke` and +2 in
`leader/smoke` from the concurrent reasoning-effort work described below. Phase 1's own tests are
unchanged at `f11/smoke` (10) + `f11/seam` (2).

### Remaining Phase-1 notes (non-blocking)

* **Governance record remains unreliable in three places** — the appended correction at line 154
  (wrong `f.ruleId` clause), the rewritten line 156 (claims a re-export that does not exist), and the
  R13 entry at line 165 (wrong line number and inverted mapping direction). No further correction or
  superseding entry exists anywhere in the log.
* f11 findings are written with `WORKSPACE/`-prefixed paths while the f08 path writes `src/app.ts` —
  inconsistent with `PROVENANCE.md:100-108`.
* f11 accepts findings whose path is outside the reviewed bundle and re-anchors them against a
  run-wide content cache (`fileContents.get(path) ?? ''`), which can reach the reflection call with
  empty content.
* Out of scope, but observed while measuring: during this window a **new unrelated feature was
  built into accepted baseline folders** — `src/transport/{types,adapters/*}`, `src/config/{index,types}`,
  `src/leader/leader.ts`, `src/crew/assemble-prompt.ts` and their smoke tests, all written
  01:11–01:15, with a new `src/transport/reasoning-effort.test.ts` and `docs/thinking.md`. That is a
  different work item, not a Phase 1 defect, but it means the accepted ten folders are no longer
  byte-stable and Phase 1's regression evidence now sits on top of a moving baseline.

## 5.2 f12 — codegraph (both rejected findings FIXED)

### (a) Live COMMONS-seeded run — **FIXED**

Four writes through `wired.commons.write()` only; the probe never calls `hub.emit`:

```
a_commonsWritesIssued     = 4 (via wired.commons.write)
a_memoryWrittenEvents     = 16  sample=[{"path":"WORKSPACE/src/index.ts","txnId":"txn-000001","author":"probe"}, …]
a_codegraphRebuiltEvents  = 4   payloads=[{"files":1,…},{"files":2,…},{"files":4,"clusters":1,"hubs":2},…]
a_ge1_rebuild             = true
a_codegraphJson           = true      a_reportMd = true      a_digestHasCODEMAP = true
a_noManualEmitInProbe     = true
```

The producer is `emitMemoryWritten` (`wiring/index.ts:55-68`): a write-delegating wrapper over
phase-03 commons that emits `{ path, txnId, author }` after every successful write, so folder-03
itself stays bus-free per its own contract. The hook (`wiring/index.ts:316-334`) now fires in live
runs.

**Fingerprint gating — verified, and one earlier alarm of mine was a probe artifact.** My first
probe saw a rebuild after an "identical" re-write. Reading the file proved the state had genuinely
changed: `commons.write` applies a **diff**, so re-applying `added` with `removedLineCount: 0`
*appended* (`"export const a = 1\n\nexport const a = 1\n\n"`). Isolated correctly:

```
no write at all                       -> rebuild delta 0
memory.written on an unchanged tree   -> rebuild delta 0   ← the documented gate, holds
changed write                         -> rebuild delta 1
```

There is no rebuild loop: one logical write emits ~4 events (the seed write plus the rebuild's own
three state writes), and the hook's path filter (`wiring/index.ts:320`) drops everything outside
`WORKSPACE/`.

### (b) Live planner path — **FIXED**

```
b_planCallObserved    = true
b_planHasDigestSlot   = true      ("DIGEST (STATE/digest.md)")
b_planHasCODEMAP      = true
b_planHasHubLine      = true      ("- src/util.ts (1)")
b_workerHasCODEMAP    = true      (worker slot 2 still carries it)
```

`leader.ts:85` reads the digest through the optional `readDigest?()` on the Commons contract
(`leader/types.ts:71`), implemented at `leader-commons-adapter.ts:91` as a read of the same
`STATE/digest.md` the worker's slot 2 uses, and injects it as a user-message slot
(`leader.ts:223`). Captured from the **outgoing** transport call, not composed.

### (c) Event catalog audit — **PASS**

Test present: `src/f12/smoke.test.ts:583` *"catalog audit: every event name has a producer call site
in `src/` or is marked reserved in PROVENANCE"*. It parses the `EventName` union, scans non-test
sources for `.emit('<name>')`, parses the catalog for "reserved" markings, and asserts the two sets
match **exactly** in both directions (no uncovered events, no stale reservations).

My own independent cross-check agrees:

```
c_catalogSize = 20      produced = 14      reserved = 6
c_reservedSet = ["compaction.started","crew.sync","finding.raised","finding.resolved","run.started","task.claimed"]
c_uncovered = []        c_staleReserved = []        c_INVARIANT_HOLDS = true
c_codeVsCatalog identical = true (n=20)        c_memoryWritten_producer = true
```

The six producer-less events are now **disclosed** in `PROVENANCE.md` as "Reserved — no producer
call site in `src/` yet (catalog audit enforces …)" rather than silently implying a producer. This
is an honesty improvement over round 1, where the same gap was invisible.

### Remaining round-1 phase-2 notes (still open, non-blocking)

* Duplicate import edges are not deduplicated: a file importing the same module twice scores
  in-degree 2 and outranks a genuine one-edge hub (`f12/build.ts:71`; reproduced post-repair:
  `dupImport_edges=2 → hubs=[{id:"b.ts",inDegree:2}]`).
* Rule packs ship as in-code data (`src/f11/rules.ts`) rather than the `RULES/<lang>.pack` files the
  roadmap's module table describes.

Golden graph math re-confirmed unchanged after the repair: `external=1`, `clusters=1`,
`hubs=[src/helper.ts(1), src/util.ts(1)]`, `orphans=3`.

---

## 5.3 P3 — personas + severity (PASS — carried forward unchanged, not re-verified this round)

Persona fallback matrix (10/10 cases), severity matrix (16/16 cells), the headline
`high`-blocks-at-`high`/not-at-`critical` fixture on both consumers, precedence and fail-fast
behaviour — all as recorded in round 1 and untouched by the repairs
(`personas.ts` 21:48, `severity-config.ts` 21:40, both test files 22:18).

---

## 5.4 P4 — confirmation tokens (PASS — carried forward unchanged, not re-verified this round)

Round trip, expiry, replay, wrong-scope (does not burn), burn, the R7 per-process boundary, the
deterministic batch scope, and the veto follow-up whose `confirmationRef` resolves to exactly one
burned confirmation keyed to the decision id — unchanged (`confirmations.ts` 19:17,
`confirmations.test.ts` 19:16).

---

## 6. REGRESSION PROBES after P1R2 — ALL PASS

### 6.1 Baseline dirty smoke a–e

| | check | observed |
|---|---|---|
| a | findings raised + persisted | `SEC-001, SEC-004, SEC-006` → 3 rows, `detectors = ["sec-1","sec-1","sec-1"]` |
| b | patchable → task → patched → cleared | `SEC-004:env-var:r1`, `SEC-004 resolved:true`, `sk-prod-…` gone |
| c | unpatchable escalates, not advisory | `no-patch-strategy:critical` → `D-01:pending:["src/app.ts","SEC-001"]`; advisories `SEC-006:blocking=false` |
| d | veto → follow-up task, real + claimable | `vetoed`, `T-02`, `src/app.ts`, real file, no double prefix, `confirmationRef` present, `acquire → "granted"` |
| e | unresolved critical blocks merge | `GATE_FAILED folder=merge`, `MANIFEST.json` written = false |

The round-2 caveat is **resolved**: step (a) carries `detector` again and step (e) reaches
`GATE_FAILED`, both through the **unmodified** baseline call shape — see §5.1 §§2 and 5.

### 6.2 Both compaction triggers

```
PATH A (over-budget buildPrompt → compaction.requested on the shared hub)
  seeded 2277 tokens vs budget 2000 → compaction.done = 1 → digest 44 tokens
  ARCHIVE/=["digest@v1.md"]  PIN survived=true  idempotent rerun=true
PATH B (digest-growth trigger)
  pre 2273 → compaction.done = 1 → 39 tokens
  ARCHIVE/=["digest@v1.md"]  growth PIN survived=true
```

### 6.3 Dangling-lock fixture

```
live claim row in STATE/tasks.json, empty presence.json
  critical-findings passed=true   dangling-locks passed=false  "1 dangling: eng-1:src/app.ts"
  merge → GATE_FAILED      MANIFEST.json written=false
CONTROL: no claim rows → dangling-locks passed=true
```

### 6.4 Veto path with a claimable task — covered in 6.1(d): `src/app.ts` resolves to a real
WORKSPACE file, no double prefix, `"granted"` after release.

---

## 7. OBSERVATIONS

Carried forward from round 1 and still open (phases 3/4 areas, untouched by the repairs):

1. `DECISIONS.log` / `MERGE_REPORT.md` contain UTF-16LE lines inside UTF-8 files (the f11 entry
   region). **Resolved by the repair?** No — the repair appended more entries to both files; the
   mixed-encoding run from round 1 is still present.
2. Escalation → ReviewQueue is fire-and-forget and silently lossy (`audit/remediate.ts:189`,
   `wiring/task-bus-glue.ts:68`). My probes still needed a ~350 ms settle before pending decisions
   appeared — `c_pending` is empty immediately after `remediateFindings()` returns.
3. f11 accepts out-of-bundle findings and can feed reflection empty content (`review-agent.ts:133`).
4. f11 rule packs are in-code data, not `RULES/<lang>.pack` files.
5. Duplicate import edges inflate in-degree hub ranking (`f12/build.ts:71`).
6. `src/wiring/confirmations.test.ts` leaks temp dirs per run.
7. Three severity-rank comparators (`severity-config.ts:28`, `audit/remediate.ts:28`,
   `verify-build.ts:185`).
8. `memory.written`'s siblings `commons.changed` / `digest.updated` remain producer-less — now
   **disclosed** as reserved by the new catalog audit, but still needed as hand-emitted triggers for
   the growth-compaction path (§6.2 path B drives it the same way round 1 did).

New in round 2, **both now resolved by P1R2**:

9. ~~`WiredDeck.persistFindings` is a breaking API change~~ — **resolved**: the signature is back to
   the accepted baseline `readonly F08Finding[]` (`wiring/index.ts:175`, `:340`).
10. ~~`dirty-smoke.test.ts` was modified and masked the regression~~ — **resolved**: the file is back
    to the baseline content (7,198 bytes, `sha256 E8A0F92A…`, line 78 is the original call, zero
    object-spread field mappings in the file) and passes unmodified.

New this round (P1R2):

11. ~~`src/f11/types.ts:122` still declares `persistFindings: (findings: any[])`~~ — **resolved**:
    now `(findings: readonly PersistedFinding[])` at `:123`; a wrong-shaped injected implementation
    no longer compiles (TS2322, verified).
12. ~~No R13 entry exists~~ — **resolved**: `DECISIONS.log:320-331`.
13. ~~`DECISIONS.log` line 316 claims a non-existent `src/f11/defaults.ts`~~ — **NOT resolved**:
    the claim survives at line 316, uncorrected, and is invisible to byte-level search because the
    line sits in the log's UTF-16LE run.
14. ~~`DECISIONS.log` line 314 asserts the reverted signature change as fact~~ — **NOT resolved**:
    four false claims persist unretracted (see §5.1 governance (b)).

New this round (R13 governance):

15. `DECISIONS.log:325` cites `src/wiring/index.ts:341` for `detector: f.detectorModelId`; that
    mapping is on **line 344** (line 341 is the `.map(` opening). Every other citation in the R13
    entry (`:175`, `:292`, `:360`, `:357-359`, `review-agent.ts:203`, `:226`, `types.ts:87`, `:123`)
    checks out against the code.

---

## 8. SUMMARY BY PHASE

**Phase 1 (f11 review), after the R14 governance close-out.** The encoding defect that hid a stale
governance claim is genuinely fixed: `DECISIONS.log` now strict-decodes as UTF-8, carries zero NUL
bytes, round-trips losslessly, and the previously unsearchable region is greppable. The encoding guard
exists and demonstrably fails on both a NUL-injected copy and an invalid-sequence copy while passing
on the clean log. A correction was appended to the DEFECT 2 entry and the phantom `defaults.ts`
citation is gone. The code is unchanged and still correct — no `any` at the findings boundary, both
TS boundaries strict, build exit 0, 125/125 green, dirty smoke to `GATE_FAILED` through the original
call shape. Acceptance still fails on the governance record itself: the appended correction asserts
`review-agent sets detector: f.ruleId` when `review-agent.ts:203` sets `this.deps.reviewModelId`
(the same log says so correctly at line 168, so it contradicts itself); the rewritten citation claims
`src/f11/index.ts re-exports assertCoverage` when that file only imports it; and the R13 entry still
cites `wiring/index.ts:341` for a mapping that lives on line 344, and now states it inverted —
attributing the adapter's `detectorModelId: f.detector` (`:364`) to the canonical impl, which maps
`detector: f.detectorModelId`. Three inaccuracies remain in an append-only audit log whose whole
purpose is to be trustworthy, and the instruction forbids me from appending the corrections.

**Phase 2 (f12 codegraph).** Both rejections are fixed and verified live. Four writes through the
real wired commons now produce four `codegraph.rebuilt` events with no manual emission anywhere, and
the outgoing `leader.plan()` prompt — captured from the transport call, not composed — carries the
digest slot, the `## CODEMAP` section and the hub line. The catalog audit test is present, passing,
and two-way strict; my independent cross-check agrees, and the six producer-less events are now
disclosed in the catalog rather than implied. The two non-blocking notes from round 1 (duplicate
import edges, in-code rule packs) remain open.

**Phase 3 (personas + severity).** ACCEPT, carried forward unchanged.

**Phase 4 (confirmation tokens).** ACCEPT, carried forward unchanged.

---

PHASE 1: REJECT — encoding CLOSED, guard PASS, regression PASS, code unchanged and correct, but the governance record still fails. PASSING: (1) `DECISIONS.log` is now 40,905 bytes of strict UTF-8 — strict decode succeeds, ZERO NUL bytes, no BOM, lossless round-trip — and the previously unsearchable region is greppable (`"R13"` now returns 10 hits through plain text search); (3) the guard `src/wiring/decision-log.test.ts` exists, passes in-suite, and using its real compiled form against temp copies it FAILS on a NUL-injected copy (`DECISIONS.log contains NUL bytes — not clean UTF-8`) and on an invalid-UTF-8 copy (round-trip 44,816 vs 44,814) while PASSING on a byte-exact copy of the clean log; (4) regression — build exit 0, 125/125 green, dirty smoke reaches `GATE_FAILED` via the ORIGINAL call shape (detectors `["sec-1","sec-1","sec-1"]`, `INVALID_FINDINGS=false`); code unchanged and still correct (no `any` at the findings boundary, TS2322/TS2345 both fire, adapter at `:360` injected once at `:292`, canonical signature at `:175`). FAILING: (2a) the appended correction at `DECISIONS.log:154` states "review-agent sets detector: f.ruleId", but `review-agent.ts:203` sets `this.deps.reviewModelId` — and line 168 of the same log states it correctly, so the log contradicts itself; (2b) the rewritten `defaults.ts` citation at line 156 replaces one false claim with another: it asserts `src/f11/index.ts re-exports it`, but that file contains exactly one mention of `assertCoverage` — an import at line 18 — and zero export lines mentioning it; (2c) the R13 entry at line 165 still cites `src/wiring/index.ts:341` for the canonical mapping (it is on line 344; 341 is the `.map(` opening) and now states it INVERTED — attributing the adapter's `detectorModelId: f.detector` (`:364`) to the canonical impl, which maps `detector: f.detectorModelId` — so it is now wrong in two ways where it was previously wrong in one. Non-blocking: f11 findings keep `WORKSPACE/`-prefixed paths while f08 writes `src/app.ts`; out-of-bundle findings can reach reflection with empty content; the guard's comment claims a "strict UTF-8 decode" that line 19 does not perform (Node substitutes U+FFFD; coverage comes from the NUL check and round-trip) and the guard is cwd-dependent; `MERGE_REPORT.md` still carries 29 UTF-16LE lines and was NOT remediated; and an unrelated concurrent feature was written into accepted baseline folders (`src/transport/*`, `src/config/*`, `src/leader/leader.ts`, `src/crew/assemble-prompt.ts`, plus their smoke tests and a new `src/transport/reasoning-effort.test.ts`, `docs/thinking.md`), so the baseline Phase 1 is regression-tested against is no longer byte-stable.
PHASE 2: ACCEPT — issues: none blocking; the round-1 rejections (a) and (b) are fixed and verified live; notes: (a) `assertCoverage`-equivalent caveats do not apply; carried-forward non-blocking items: duplicate import edges are not deduplicated and inflate in-degree hub ranking (`f12/build.ts:71`, reproduced post-repair); rule packs ship as in-code data rather than `RULES/<lang>.pack` files; the repair's footprint reached `src/leader/{leader,types}.ts` and `src/wiring/leader-commons-adapter.ts` outside the R8 whitelist, logged as an orchestrator-approved exception (`DECISIONS.log` 288-297) — the changes are additive and default-preserving (`readDigest?()` is optional).
PHASE 3: ACCEPT — issues: none blocking; notes: (a) the `auditor` persona has no call site (folder-08 is a deterministic scanner) — recorded deferral, accurate; (b) three independently maintained severity-rank comparators exist (`severity-config.ts:28`, `audit/remediate.ts:28`, `verify-build.ts:185`) — R5's single *value* holds (one parser, `severity-config.ts:118`), the duplicated ordering can drift; (c) `wired.remediateFindings` forces the resolved `failOn` over any per-call value (`wiring/index.ts:380`) — harmless at the wired surface, raw `remediateFindings` still honours per-call options.
PHASE 4: ACCEPT — issues: none blocking; notes: (a) a `veto()` whose follow-up routing throws still burns the confirmation and records `action.confirmed` before `persistDecision` runs (`leader/review.ts:76-94`) — observed when the veto failed with "No crew configured"; the code comment states the intent (shipped behavior first) and no gate depends on it; (b) `src/wiring/confirmations.test.ts` leaks ~11 temp dirs per run; (c) `DECISIONS.log` line 258 double-counts the 11 confirmation tests, which were already inside the 83 it builds on.
