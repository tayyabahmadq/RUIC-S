# Ruic

**Ruic** is a multi-model AI software-orchestration system: you supply one brief and a goal state, and a crew of AI models plans, builds, audits, and merges the software.

## How it works

- **ONE LEAD** model decomposes the brief into tasks, routes them, verifies the goal state, and signs off.
- **1–5 ENGINEER** models work in parallel on claimed tasks.
- **2+ SECURITY** models adversarially audit everything written.
- All models share **one** memory directory — **COMMONS** ("unbounded shared memory, bounded per-model attention") — with a **COMPACTOR** that keeps each model's prompt small.
- A **MERGE engine** gates and assembles the final output into an `OUTPUT/` folder with `MANIFEST.json` and `REPORT.md` (a full audit trail).

## Common-S v2 — the architecture

Ruic v2 implements the **Common-S Autonomous System**: a shared compacted Brain at the center, five departments around it, models as stateless swappable workers, Laya as the router, and Zeak as the cost gate.

| Component | Implementation |
|---|---|
| **Common-S Super Brain** | The COMMONS store, three deep: `STATE/digest.md` (human-readable compacted state), `STATE/contracts.json` (the State Contract), `STATE/vectors.json` (semantic knowledge, RAM-capped, decayed by the Compactor) |
| **State Contract v1.0.0** | Every model writes its compacted result to the Brain before exiting — `done` on completion, `blocked` + remaining on crash (a resume point survives), `handed_off` + remaining on bail (that write IS the handoff). Versioned from day one; readers reject unknown majors |
| **Triangular Compaction Loop** | Fires after EVERY sub-task, serialized (never concurrent), atomic temp+rename writes on all three stores |
| **Laya** | Deterministic code router: reads Brain state, scores complexity — trivial briefs run fully local (zero paid calls), heavy ones decompose through Dept 4. Open handoffs force orchestration |
| **Dept 1 Engineering** | Laya + the local crew (intake/routing) |
| **Dept 2 Data Collection** | Ordered collector chain behind one seam: **GitHub-as-data-source** (free REST, rate limit treated as a budget, back off on 403) → **Agent-Reach** (local CLI: Bilibili, YouTube transcripts, V2EX, web search/read, Chinese + login-walled platforms; sessions copied from your own Chrome, read-only) → **Obscura Browser** slot. All browsing citizens share ONE serialization queue (one agent at a time); cache-gate serves repeat research from the Brain |
| **Dept 3 Deep Thinking** | Frontier models (Sonnet/GPT-4o class), every call through Zeak, opt-in by complexity |
| **Dept 4 Linking & Allocation** | Dependency-graph decomposition, assignments, handoff re-queue (a failing task changes hands whole — never sliced), stitching via `parentTaskId` |
| **Dept 5 Security Check** | Diff-based scanning on the free local model; a Security rejection of a Zeak-downgraded task re-escalates it to the frontier exactly once |
| **Zeak (economic layer)** | Transport decorator: Cache-Gate -> Pruner -> Capper -> Early-Stopper. Over-cap falls back to the free local model, LOUDLY (`zeak.fallback` + a durable flag). Early-Stop only fires when the last complete unit passed checks AND the contract is satisfied — never mid-structure |
| **Local executor** | Ollama `qwen2.5-coder:1.5b` (OpenAI-compatible endpoint, 16K-64K context sized empirically to stay fully on GPU) + `nomic-embed-text` for embeddings |

**Core rules:** models read context only from Common-S (raw logs are for the Compactor); no model-to-model direct communication; compaction after every sub-task; cache-first answering before any external call; trivial tasks never reach paid APIs.

## Repository layout

| Path | What it is |
|---|---|
| `app/` | **ruic-app** — the Electron (Chromium) desktop Control Deck: configure brief/goal/crew, run or abort runs, watch the live Task Ledger and Findings Feed, monitor crew health, and sandboxed-preview the merged output. |
| `opus-deck-software/` | **ruic-engine** — the frozen orchestration engine: event bus, SSE streaming transports (OpenAI-compatible / Anthropic), transactional COMMONS memory, crew runner, merge engine, and CLI (`run \| status \| crew \| report \| config`). |

## Running

```bash
# Engine
cd opus-deck-software
npm install
npm test          # engine test suite

# Desktop app (expects the engine built at ../opus-deck-software/dist)
cd ../app
npm install
npm run build
npm start         # or: npx electron dist/main/index.js
```

The engine API keys are resolved in the main process only (env first, then `keystores/<id>`); they never cross the renderer bridge.

## Security model

- Exactly three IPC channels between the renderer and main; the bridge surface is typed with zero `any` and proven by a mutation probe.
- The renderer never sees key material — only model names and health.
- The preview panel runs generated output in a sandboxed `WebContentsView` with a dedicated session that cancels everything that is not a `file://` URL inside the run's output directory.

## Docs

- `app/DECISIONS.log` — the full engineering decision history.
- `app/PROVENANCE.md` — build provenance and known gaps.
- `Full assessment.md` / `Full assessment.pdf` — an independent full assessment of the codebase.
