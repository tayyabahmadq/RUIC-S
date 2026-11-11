# PRE-FLIGHT INSPECTION — RE-VERIFICATION ROUND — parts/folder-01 … parts/folder-10

Inspector scope: verification only. Nothing was modified; this report is the only file created/updated.
No folder's code was read for quality judgement — only gates, INTEGRATION.txt contracts, and the checks requested.
This is a full re-run after the repair round (folder-06 gate fix; folder-01 / folder-03 path-constant unification).

**Environment:** Node v24.20.0, npm 11.19.0 — Node LTS (>= 20) already present, no install needed.
Note: plain `npm` is blocked by PowerShell execution policy on this machine
(`npm.ps1 cannot be loaded because running scripts is disabled`), so every command was run through
`npm.cmd` (same npm, same exit codes). All ten folders: `npm install --no-audit --no-fund` exited 0.

---

## 1. PER-FOLDER TABLE

| Folder | install (exit) | build (exit) | test (exit) | GATE | INTEGRATION.txt | ISOLATION |
|---|---|---|---|---|---|---|
| folder-01 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-02 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-03 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-04 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-05 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-06 | 0 | **0** | **0** | **PASS** | 9/9 (order OK) | CLEAN |
| folder-07 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-08 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-09 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |
| folder-10 | 0 | 0 | 0 | **PASS** | 9/9 (order OK) | CLEAN |

**Result: 10/10 gates PASS — build exit 0 and test exit 0 for every folder.**

Test totals (0 failures each): 01 = 9, 02 = 56, 03 = 12, 04 = 17, 05 = 44, 06 = 11, 07 = 12,
08 = 145, 09 = 10, 10 = 13.

---

## 2. VERBATIM FAILURE OUTPUT

**None this round.** No folder produced a non-zero exit code, so there is no failure output to quote.

The previous round's only failure — folder-06, `build exit 1` / `test exit 1` with 13 `tsc` errors
(`TS2304: Cannot find name 'Claims' / 'Conflicts' / 'Bus' / 'nowIso'`, `TS2552`, `TS2322`) — is
**resolved**: this round folder-06 builds clean (`tsc` emits nothing) and all 11 smoke tests pass:

```
> opencode-commons-folder-06@0.1.0 test
> npm run build && node --test dist/smoke.test.js

> opencode-commons-folder-06@0.1.0 build
> tsc

✔ Leader.plan decomposes brief into sequential tasks via ONE LLM call (modelId = crew.lead) (7.3359ms)
✔ Leader.plan resumes from COMMONS without another LLM call (1.5602ms)
✔ Leader.plan throws CommonsError when brief/goalState/crew are missing (1.2071ms)
✔ Leader.route assigns engineers and never assigns an already-claimed path (3.4036ms)
✔ Leader.route splits a task when no engineer is free (1.4349ms)
✔ Leader.verify makes ONE LLM call per criterion with file:line evidence (3.3996ms)
✔ Leader.signOff writes a sha256 checksum and emits run.completed (1.9857ms)
✔ ReviewQueue.decide queues multi-file decisions and ratifies single-file decisions (1.3572ms)
✔ ReviewQueue.veto converts the reason into a routed follow-up task (1.0984ms)
✔ ReviewQueue rejects unknown or already-settled decisions (1.0832ms)
✔ CommonsError is an Error with code and folder (0.2809ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

---

## 3. INTEGRATION.txt AUDIT

All ten `INTEGRATION.txt` files exist and contain all nine headings **in the required order**
(missing sections: none; out-of-order sections: none):

| Folder | 1 WHAT I BUILT | 2 FILE MAP | 3 PUBLIC INTERFACE | 4 EXPECTS | 5 PROVIDES | 6 CONFIG | 7 RUN STANDALONE | 8 INTEGRATION NOTES | 9 DO NOT CHANGE | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 02 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 03 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 04 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 05 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 06 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 07 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 08 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 09 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |
| 10 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 9/9 ordered |

Cosmetic style notes (heading text and order correct — informational only):
- folder-01, folder-06 use markdown form `## 1. WHAT I BUILT`; folder-02/03/05/07/08/10 use `1. WHAT I BUILT`.
- folder-04 heading 3 carries an annotation: `3. PUBLIC INTERFACE (all named exports from src/index.ts)`.
- folder-09 omits numeric prefixes (`WHAT I BUILT`, `FILE MAP`, …) — text and order still match.

---

## 4. ISOLATION CHECK — **CLEAN (all ten folders)**

- **Cross-folder imports:** grep of every folder's `src/` for `import … from '…folder…'`,
  `require('…folder…')`, dynamic `import('…folder…')`, `../folder…` paths → **zero matches**.
  (The only `folder-0N` occurrences in src/ are comments, string literals, error metadata such as
  `folder: 'folder-06'`, package names, and test temp-dir prefixes — the allowed own-number-in-strings case.)
- **Escaping relative imports** (`../../` from any src file) → **zero matches**.
- **Files outside `parts/`:** repo root contains only `parts/` and this `PRE-FLIGHT.md` report
  (checked with hidden files included). No folder wrote any file, directory, or lockfile outside `parts/`;
  each folder's `dist/`, `node_modules/`, `package-lock.json`, `keystores/` (folder-02) are inside its own directory.
- Entries directly under `parts/`: exactly `folder-01` … `folder-10`, nothing else.

---

## 5. TARGETED CHECKS

### 5a. parts/folder-06 — did build and test actually pass?

**YES — both pass.** `npm run build` exit **0** (clean `tsc`, no output), `npm test` exit **0**,
11/11 tests pass, 0 fail (verbatim test tail in section 2). The folder now has a working `dist/`.
The round-1 compile failure (13 errors) is gone.

### 5b. parts/folder-01/src/paths.ts — the NINE canonical constants, verbatim

```ts
export const BRIEF_MD: string = path.join(commonsRoot, 'BRIEF.md')
export const DECISIONS_LOG: string = path.join(commonsRoot, 'DECISIONS.log')
export const STATE_DIGEST: string = path.join(commonsRoot, 'STATE', 'digest.md')
export const STATE_PRESENCE: string = path.join(commonsRoot, 'STATE', 'presence.json')
export const STATE_TASKS: string = path.join(commonsRoot, 'STATE', 'tasks.json')
export const WORKSPACE_DIR: string = path.join(commonsRoot, 'WORKSPACE')
export const DELTA_DIR: string = path.join(commonsRoot, 'DELTA')
export const ARCHIVE_DIR: string = path.join(commonsRoot, 'ARCHIVE')
export const TXN_LOG: string = path.join(commonsRoot, 'DELTA', 'txn.jsonl')
```

Scheme (per the file's own header, verbatim intent): **composed absolute paths** — `path.join()` of the
COMMONS root plus **bare segment names containing no trailing slashes**
(`BRIEF.md`, `DECISIONS.log`, `STATE`, `digest.md`, `presence.json`, `tasks.json`, `WORKSPACE`, `DELTA`,
`ARCHIVE`, `txn.jsonl`); directory segments carry no trailing slash.
`commonsRoot` = `path.resolve(process.env.OPUS_DECK_COMMONS_DIR)` or `path.resolve(process.cwd(), 'COMMONS')`.
(Note: TXN_LOG added in the repair round — folder-01 now exports nine, up from eight.)

### 5c. parts/folder-03/INTEGRATION.txt, section 5 — documented canonical values, verbatim

```
    BRIEF        = "BRIEF.md"
    DECISIONS    = "DECISIONS.log"
    DIGEST       = "STATE/digest.md"
    PRESENCE     = "STATE/presence.json"
    TASKS        = "STATE/tasks.json"
    WORKSPACE    = "WORKSPACE"      (directory, no trailing slash)
    DELTA        = "DELTA"          (directory, no trailing slash)
    ARCHIVE      = "ARCHIVE"        (directory, no trailing slash)
    TXN_LOG      = "DELTA/txn.jsonl"
```

Scheme: **bare segments** (root-relative strings, forward-slash joined).

### 5d. Comparison — NINE values, composed scheme (folder-01) vs bare-segment scheme (folder-03)

Compared on segment names: folder-01's composed path is reduced to its segments after `commonsRoot`
and matched character-for-character against folder-03's bare-segment string (forward slashes ↔ `path.join` separators):

| # | folder-01 constant (composed → segments) | folder-03 §5 (bare segment) | Result |
|---|---|---|---|
| 1 | `BRIEF_MD` → `BRIEF.md` | `"BRIEF.md"` | **MATCH** |
| 2 | `DECISIONS_LOG` → `DECISIONS.log` | `"DECISIONS.log"` | **MATCH** |
| 3 | `STATE_DIGEST` → `STATE` + `digest.md` | `"STATE/digest.md"` | **MATCH** |
| 4 | `STATE_PRESENCE` → `STATE` + `presence.json` | `"STATE/presence.json"` | **MATCH** |
| 5 | `STATE_TASKS` → `STATE` + `tasks.json` | `"STATE/tasks.json"` | **MATCH** |
| 6 | `WORKSPACE_DIR` → `WORKSPACE` | `"WORKSPACE"` | **MATCH** |
| 7 | `DELTA_DIR` → `DELTA` | `"DELTA"` | **MATCH** |
| 8 | `ARCHIVE_DIR` → `ARCHIVE` | `"ARCHIVE"` | **MATCH** |
| 9 | `TXN_LOG` → `DELTA` + `txn.jsonl` | `"DELTA/txn.jsonl"` | **MATCH** |

**RESULT: MATCH — 9 of 9.** The two schemes agree on every segment name, every separator position,
and every trailing character: no trailing slashes anywhere (directories bare on both sides), and the
previously missing ninth constant (`TXN_LOG`) now exists on both sides. The only structural difference
is by design: folder-01 values are root-absolute compositions, folder-03 documents root-relative segments.

Corroborating contract facts (reported, not judged):
- folder-03's source matches its §5 documentation: `COMMONS_PATHS` now uses bare `'WORKSPACE'`, `'DELTA'`,
  `'ARCHIVE'` and `'DELTA/txn.jsonl'`, and its tests assert exactly those values (passing).
- folder-01's own INTEGRATION.txt §9 (DO NOT CHANGE) now documents the same nine bare values with no
  trailing slashes, matching its `src/paths.ts`; its smoke test asserts the bare endings
  (`endsWith('WORKSPACE')`, `endsWith('DELTA')`, `endsWith('ARCHIVE')`) — passing.
- Round-1 mismatch (`WORKSPACE/`, `DELTA/`, `ARCHIVE/` with trailing slashes in folder-03 §5 vs bare
  values in folder-01 `paths.ts`) is **resolved on both sides**.

---

## 6. SUMMARY

- Gates: **10/10 PASS** (folder-06 confirmed repaired: build exit 0, test exit 0, 11/11).
- Contracts: 10/10 have all nine INTEGRATION.txt sections, in order; nothing missing.
- Isolation: 10/10 CLEAN — no cross-folder imports, no escaping relative imports, no files outside `parts/`.
- Canonical path constants: **MATCH — 9/9**, composed scheme and bare-segment scheme agree on segment
  names including the ninth (`TXN_LOG`); no trailing-slash drift remains.
- No verbatim error output exists this round (zero failures).
- Nothing left to repair.

DISPATCH: YES
