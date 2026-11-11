# Opus//DECK

A multi-model orchestration plugin for opencode. A user supplies one brief
and a goal state, and a crew of AI models builds the software:

- ONE LEAD model decomposes the brief into tasks, routes them, verifies the
  goal state, and signs off.
- 1–5 ENGINEER models work in parallel on claimed tasks.
- 2+ SECURITY models audit everything written, adversarially.
- All models share ONE memory directory, COMMONS (unbounded — nothing is
  ever deleted). A dedicated COMPACTOR keeps each model's prompt small by
  summarizing and demoting detail behind pointers.
- A MERGE engine gates and assembles the final output into the main software
  folder, with a full audit report.

Core thesis: unbounded shared memory, bounded per-model attention.

---

## Stack & conventions

- TypeScript, strict, Node 20+.
- Runtime dependency: `zod` only. No frameworks. Tests: `node:test`.
- Public API: named exports from `src/index.ts`.
- Errors: `CommonsError extends Error { code, folder, detail? }`.
- kebab-case filenames; CommonJS modules.
- All state lives in files — crash-restart resumes from COMMONS alone.

---

## Install

```bash
cd opus-deck-software
npm install
```

## Configure

Call `initOpusDeck(config)` with:

```ts
{
  memoryDir: './COMMONS',       // COMMONS directory
  outputDir: './OUTPUT',        // merged-build target
  brief: 'build a trivial app',
  goalState: ['app builds'],    // >= 1 criterion
  crew: {
    lead: { id: 'lead', provider: 'custom', model: 'lead-m', contextWindowTokens: 4096 },
    engineers: [{ id: 'eng-1', provider: 'custom', model: 'eng-m', contextWindowTokens: 4096 }],
    security: [                 // >= 2, enforced
      { id: 'sec-1', provider: 'custom', model: 'sec-m', contextWindowTokens: 4096 },
      { id: 'sec-2', provider: 'custom', model: 'sec-m2', contextWindowTokens: 4096 },
    ],
  },
  budgets: { digestTokens: 2000, promptTokens: 6000 }, // optional
}
```

Invalid config throws ONE `CommonsError` listing all invalid fields.

Model API keys resolve via the env var named by `apiKeyEnv`, then a
`keystores/<model id>` file (gitignored), then `API_KEY_MISSING`.

---

## Run

```bash
npm run build    # strict tsc -> dist/
npm test         # build + full smoke suite
```

The smoke suite boots `initOpusDeck()` with a mock transport and a crew of one
engineer + two auditors and completes a trivial one-file build end-to-end
(plan → route → worker build → clean audit → merge → signOff → `run.completed`).

---

## CLI

```
/opus run     — start a run from current config
/opus status  — live task ledger
/opus crew    — roster + model health
/opus report  — open the latest REPORT.md
/opus config  — guided wizard: brief, goal state, crew, keys
```

---

## Directory layout

```
opus-deck-software/
  src/
    config/        phase 1 — config & event bus
    transport/     phase 2 — model registry & transport
    commons/       phase 3 — COMMONS core
    compactor/     phase 4 — compactor
    coordination/  phase 5 — presence, claims & locks
    leader/        phase 6 — leader
    crew/          phase 7 — engineering crew runner
    audit/         phase 8 — security audit gate
    merge/         phase 9 — merge & build engine
    cli/           phase 10 — CLI & surface
    wiring/        phase 11 — composition root
  docs/PROVENANCE.md
  DECISIONS.log
  README.md
```

---

## Deliverable docs

- `docs/PROVENANCE.md` — component map, DELTA/DECISIONS/FINDINGS JSONL
  schemas, canonical path table, event catalog, security ruleset.
- `DECISIONS.log` — every interpretation made where the spec was ambiguous.
