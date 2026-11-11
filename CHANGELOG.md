# Changelog

## 1.0.0 — final whole version

The complete RUIC system: the `opus-deck-software` engine, the Electron
Control Deck, the full document set, and relocatable verification tooling.

### Engine (`opus-deck-software/`)
- Five governed departments: Engineering (Laya routing), Data Collection
  (GitHub → Agent-Reach → Obscura seam), Deep Thinking, Linking & Allocation
  (dependency-graph decomposition, whole-task handoffs), Security Check
  (diff-based scanning, exactly-once re-escalation).
- Common-S Brain shared memory with compaction loop; TRY BOX learning;
  Zeak economic guard (caps, fallbacks, predictive stops).
- MERGE engine gating into `OUTPUT/` with `MANIFEST.json` + `REPORT.md`.

### Control Deck (`app/`)
- Chat-first UI: the Chat view is a real AI chat box — the human's message
  renders as a right-aligned `you` bubble, the crew replies in conversational
  voice, and the governed run streams as turns.
- **Advanced options** toggle under the composer flips it into the
  Goal / Description form (goal-state criteria + description context) —
  one pipeline either way.
- Deep Signal theme (cyan/near-black, RED reserved for errors), ⌘K command
  palette, ambient chip, border beam, spotlight, visibility-gated render.
- Keys live only in the main process; sandboxed preview host.

### Verification
- Engine: 179 tests. Deck: 13 tests. UI: 97 automated Chromium checks
  (`tools/verify/ui_verify.py`) + pixel content checks on screenshots.

### Docs
README, DESIGN (v1–v3 layers), ARCHITECTURE, LAYER-MAP, SECURITY-AUDIT,
MIGRATION (plan of record), findings.json (audit data).
