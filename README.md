# Ruic

**Ruic** is a multi-model AI software-orchestration system: you supply one brief and a goal state, and a crew of AI models plans, builds, audits, and merges the software.

## How it works

- **ONE LEAD** model decomposes the brief into tasks, routes them, verifies the goal state, and signs off.
- **1–5 ENGINEER** models work in parallel on claimed tasks.
- **2+ SECURITY** models adversarially audit everything written.
- All models share **one** memory directory — **COMMONS** ("unbounded shared memory, bounded per-model attention") — with a **COMPACTOR** that keeps each model's prompt small.
- A **MERGE engine** gates and assembles the final output into an `OUTPUT/` folder with `MANIFEST.json` and `REPORT.md` (a full audit trail).

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
