# MANIFEST-OF-MOVES — opus-deck → opus-deck-software consolidation (R20)

Every file in the old tree accounted for: moved, archived, or explicitly
accounted for. No orphans. Moves are byte-identical; ZERO edits to src/.

## Moved from opus-deck/ to opus-deck-software/ (byte-identical)

| Old path | New path | Type |
|---|---|---|
| opus-deck/src/ | opus-deck-software/src/ | directory |
| opus-deck/docs/ | opus-deck-software/docs/ | directory |
| opus-deck/dist/ | opus-deck-software/dist/ | directory |
| opus-deck/node_modules/ | opus-deck-software/node_modules/ | directory |
| opus-deck/DECISIONS.log | opus-deck-software/DECISIONS.log | file |
| opus-deck/MERGE_REPORT.md | opus-deck-software/MERGE_REPORT.md | file |
| opus-deck/package-lock.json | opus-deck-software/package-lock.json | file |
| opus-deck/package.json | opus-deck-software/package.json | file |
| opus-deck/README.md | opus-deck-software/README.md | file |
| opus-deck/tsconfig.json | opus-deck-software/tsconfig.json | file |

## Moved from Studio root to docs/verification/ inside new folder

| Old path | New path | Type |
|---|---|---|
| Studio/PRE-FLIGHT.md | opus-deck-software/docs/verification/PRE-FLIGHT.md | file |
| Studio/ACCEPTANCE.md | opus-deck-software/docs/verification/ACCEPTANCE.md | file |
| Studio/PHASE-VERIFY.md | opus-deck-software/docs/verification/PHASE-VERIFY.md | file |
| Studio/BASELINE-VERIFY.md | opus-deck-software/docs/verification/BASELINE-VERIFY.md | file |

## Archived (moved, not copied)

| Old path | New path | Reason |
|---|---|---|
| Studio/parts/ | Studio/archive/parts/ | Superseded component sources; retained for audit, not part of the shipped software |

## Left behind (old location now empty except archive/)

| Old path | Status |
|---|---|
| Studio/opus-deck/ | Empty directory retained (nothing but archive/ and the empty original) |

## New files created in opus-deck-software/

| Path | Reason |
|---|---|
| opus-deck-software/docs/RUNBOOK.md | Runbook — install, setup, config, run, verification commands, governance artifact locations |
| opus-deck-software/MANIFEST-OF-MOVES.md | This manifest — records every move from consolidation |

## Text changes (only sanctioned edits)

| File | Change | Rationale |
|---|---|---|
| opus-deck-software/README.md | `cd opus-deck` → `cd opus-deck-software` (Install section) | Path reference to new folder |
| opus-deck-software/README.md | `opus-deck/` → `opus-deck-software/` (Directory layout) | Path reference to new folder |
| opus-deck-software/DECISIONS.log | `Repo: C:\...\opus-deck` → `Repo: C:\...\opus-deck-software` (line 4) | Absolute path to old location; grep gate requires zero hits |
| opus-deck-software/docs/INTEGRATION-ROADMAP.md | APPEND R1–R20 rulings section | Sanctioned edit — roadmap carries its own governance history |
| opus-deck-software/DECISIONS.log | APPEND R20 remediation entry | Records the consolidation ruling |
| opus-deck-software/docs/RUNBOOK.md | NEW | Runbook for operators who have never seen the project |
| opus-deck-software/MANIFEST-OF-MOVES.md | NEW | Accounts for every file from the old tree |

## Files NOT moved (intentionally left behind)

| Path | Reason |
|---|---|
| Studio/main/ | External survey repo; not part of opus-deck software |
| Studio/system_prompts_leaks-main/ | External survey repo; not part of opus-deck software |
| Studio/archive/parts/ | Archive destination (moved from Studio/parts/) |
