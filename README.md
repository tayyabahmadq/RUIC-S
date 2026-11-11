# RUIC — Common-S Autonomous System

**RUIC** is a multi-model AI software-orchestration system with a chat-first desktop control deck. You type **one brief** — the crew plans, builds, audits, and merges the software while you watch it happen live in the chat.

- **ONE LEAD** model decomposes the brief into tasks, routes them, verifies the goal state, and signs off.
- **1–5 ENGINEER** models execute claimed tasks in parallel.
- **2+ SECURITY** models adversarially audit every diff.
- All models share **one** memory directory — the **Common-S Brain** ("unbounded shared memory, bounded per-model attention") — kept compact by an automatic Compaction Loop.
- A **MERGE engine** gates and assembles the final output into `OUTPUT/` with `MANIFEST.json` and `REPORT.md` (a full audit trail).

Trivial briefs run **100% free** on a local Qwen model via Ollama; frontier models are opt-in by complexity and every paid call passes **Zeak**, the economic guard. The system **learns from every failure** and stops repeating mistakes.

---

## 1. Quick start

### Option A — the packaged executable (no install)

Download or build `Ruic.exe` (see §6), double-click it, type a brief in the chat, press Enter.

### Option B — run from source

Requirements: **Node.js 20+**, **Ollama** (for the free local executor — https://ollama.com), and `ollama pull qwen2.5-coder:1.5b` + `ollama pull nomic-embed-text`.

```bash
# 1. Build + test the engine
cd opus-deck-software
npm install
npm run build
npm test                # 179 tests

# 2. Build + run the desktop deck
cd ../app
npm install
npm run build
npm test                # 13 tests
npx electron dist/main/index.js
```

The **Chat** view opens as the main page — an AI chat box. Type a message (or click a quick-start chip) and press Enter; your turn goes up as a bubble and the crew replies, streaming the governed run into the conversation: Laya's routing, task claims, security findings, Zeak events, learning events, merge. Below the input, **advanced options** flips the composer into a Goal / Description form — goal-state criteria the run is verified against, plus a description appended as context for every department. One pipeline either way: the message is the brief.

### Option C — the engine CLI (no UI)

```bash
cd opus-deck-software
npx opus run --brief "your brief" --goal "app builds"
npx opus status | crew | report | config
```

---

## 2. The five departments

| Department | Role |
|---|---|
| **1. Engineering** (Laya + local crew) | Intake and routing. Laya is a deterministic code router — no model, no cost: it reads the Brain, scores the brief's complexity, and routes trivial work fully local; heavy work goes to Dept 4 |
| **2. Data Collection** | Ordered collector chain behind one seam: **GitHub-as-data-source** (free REST, rate limit treated as a budget, back off on 403) → **Agent-Reach** (local CLI for login-walled/video/Chinese platforms) → **Obscura Browser** slot. Cache-gate first: repeat research is served from the Brain at zero cost. All browsing citizens share ONE serialization queue |
| **3. Deep Thinking** | Frontier models (Sonnet / GPT-4o class). Opt-in by complexity; every call passes Zeak |
| **4. Linking & Allocation** | Dependency-graph decomposition, seat assignment, handoff re-queue (a failing task changes hands **whole** — never sliced), module stitching via `parentTaskId` |
| **5. Security Check** | Diff-based scanning (missing imports, syntax errors, breakage) on the free local model. A Security rejection of a Zeak-downgraded task re-escalates it to the frontier **exactly once** |

---

## 3. The Brain and the State Contract

The **Common-S Super Brain** is the single source of truth. Models never talk to each other directly — everything flows through it. It lives in the `COMMONS/` directory as six stores:

| Store | File | What it holds |
|---|---|---|
| Compacted state | `STATE/digest.md` | Human-readable memory (ARCH / IFACE / OPEN / SETTLED / PINS) — the only thing models read |
| **State Contract** | `STATE/contracts.json` | One entry per task: `schemaVersion`, `taskId`, `parentTaskId`, `status` (`in_progress / blocked / handed_off / done`), `owner`, `done`, `decisions`, `remaining`, `artifacts` |
| **TRY BOX** | `STATE/trybox.json` | Every failed attempt with a deterministic error signature `{E}` — the failure memory (Zeak v2) |
| **Guide lines** | `STATE/guides.md` | Verified lessons (Zeak v2) — backed up to `ARCHIVE/guides@vN.md` on every change, decayed when stale |
| **Vector knowledge** | `STATE/vectors.json` | Semantic knowledge for cache-first retrieval — RAM-capped, decayed by the Compactor |
| Task flags | `STATE/state.json` | Durable per-task flags (`zeakFallback`, escalation counts) |
| Raw memory | `BRIEF.md`, `DELTA/txn.jsonl`, `WORKSPACE/`, `ARCHIVE/` | The brief, the transaction log (every write, appended), workspace artifacts, archives |

**The State Contract is the system's law**, enforced at the worker's **exit path**:

- Normal completion → `done` + artifacts, *then* the worker exits.
- Crash mid-task → `blocked` + `remaining` (a resume point survives the crash).
- Bail (limit hit) → `handed_off` + `remaining` — **that write IS the handoff**; Dept 4 re-queues it for another model. The task never degrades; it changes hands.

**The Triangular Compaction Loop** fires after *every* sub-task, strictly serialized, with atomic temp+rename writes. It compacts the digest, folds old contracts, decays stale vectors, and triggers the learning cycle.

---

## 4. Zeak — Economic Guard (v1) + Learning Loop (v2)

**v1 (per-call, the Wallet):** a transport decorator on the single seam every phase uses.

- **Cache-Gate** — Brain vector lookup before any external call (threshold 0.90; a false cache hit is worse than a fresh call).
- **Pruner** — strips payload redundancy (never touches guide tokens).
- **Capper** — hard per-department token caps. Over-cap → fallback to the free local model, **loudly** (`zeak.fallback` event + a durable flag on task state).
- **Early-Stopper** — kills generation only when the last complete unit passed checks AND the sub-task contract is satisfied. Never mid-structure.
- **Loud re-escalation** — a Security rejection of a downgraded task re-escalates it to the frontier once, on its own budget. Downgrades are never silent, never permanent.

**v2 (cross-task, the Teacher):** the self-teaching loop from the design sketches.

```
try → fail → TRY BOX entry → Model 2 finds the pattern →
Model 3 verifies it → guide line → the guide steers the next attempt
```

- **Model 2** (find pattern) and **Model 3** (verify) run on the **free local Qwen** after every compaction cycle, serialized.
- **Pin 1:** a pattern becomes a guide only at **≥ 3 independent occurrences AND Model 3 confirmation**. One occurrence = TRY BOX entry, never a guide.
- **Pin 2:** guides decay — capped (40), oldest dropped.
- **Pin 3:** guide tokens are protected — the Pruner never trims them; the prompt builder keeps the slot in both budget branches.
- **Predictive Early-Stop:** if generation starts heading toward a method the TRY BOX says already failed, Zeak aborts it and surfaces the verified guide instead (`zeak.predictive_stop`).

---

## 5. The Model Pool and FreeLLM failover

Open **Crew** in the deck:

- **＋ Add model** — register any model department-agnostically: model id, tag, provider, endpoint, **context window (tokens)**, **parameter count (B)**, free/paid flag. Persisted locally (localStorage).
- **Department assignment** — assign any pool model to a seat (lead / engineer / security 1 / security 2), or leave **AUTO** and the lead/Laya decides. Picks take effect on the next run.
- **FreeLLM failover loop** — every *free* (local Ollama) model in the crew forms a retry pool: a model that errors, dies mid-stream, or answers **empty** routes to the next free model until one answers. Pool exhaustion throws a precise error naming every model tried. Paid models keep Zeak's loud-fallback instead — the two systems compose.

---

## 6. Packaging — Ruic.exe

```bash
cd app
npm run build
npm run dist        # electron-builder --win portable
```

Output: **`app/dist-exe/Ruic.exe`** (~74 MB, portable — no install, no Node required). The engine is bundled via `extraResources` (compiled `dist/` + `zod`) and resolved at runtime from `process.resourcesPath/engine`. Notes:

- First launch on another machine may trigger a SmartScreen warning (unsigned binary) — "More info → Run anyway".
- The portable exe creates its `COMMONS/` workspace relative to the folder it runs from.

---

## 7. API keys

Key resolution happens **in the main process only**, in the engine's documented order:

1. The env var named by the model's `apiKeyEnv` (for the lead: `OPUS_DECK_KEY_ENV_LEAD`, e.g. pointing at `OPENAI_API_KEY`),
2. then the file `opus-deck-software/keystores/<model-id>`.

**The renderer never sees key material.** Local Ollama models need no real key (a placeholder is supplied automatically). Without a frontier key, everything still works — Laya routes trivial briefs locally, and heavy briefs fail loudly at the lead's first call with a clear message.

---

## 8. Security model

- Exactly **three IPC channels** between renderer and main; the bridge surface is typed with zero `any` and proven by a mutation probe.
- The renderer has **zero Node/IPC surface** (sandboxed, contextIsolation on).
- **Keys never cross the bridge** — the renderer sees model names and health only.
- **Sandboxed preview** — generated output renders in a contained `WebContentsView`: dedicated session, no preload, everything that is not a `file://` URL inside the run's output directory is cancelled; navigation, window-open and permissions denied.
- **Engine freeze** — the engine is byte-frozen (SHA-256 baseline manifest + aggregate hash); `npm run gate` verifies diff-zero, all tests, the bridge contract on a real Electron process, and sandbox escape containment.

---

## 9. Testing and the gate

```bash
cd opus-deck-software && npm test    # 179 tests (engine: crew, brain, zeak v1+v2, learning, transports…)
cd app && npm test                   # 13 tests (bridge contract, reconstruction, keys, FreeLLM failover)
cd app && npm run gate               # the full 7-item phase gate
```

The gate asserts: engine diff-zero vs the frozen baseline (re-freeze with `node scripts/refreeze.mjs` after a sanctioned engine change), all engine tests, all app tests, strict tsc build, bridge-type mutation probe, real-Electron contract (renderer state == main state, cold + mid-run open), and sandbox escape containment.

---

## 10. Repository layout

| Path | What it is |
|---|---|
| `app/` | **ruic-app** — the Electron Control Deck (chat-first UI): Chat (AI chat box with advanced options), Overview, Findings, Crew (model pool + assignments), Preview — themed by the [Deep Signal design system](DESIGN.md), upgraded per [LAYER-MAP](LAYER-MAP.md), audited per [SECURITY-AUDIT](SECURITY-AUDIT.md), system view in [ARCHITECTURE](ARCHITECTURE.md) |
| `app/src/main/` | Main process: DeckHost (engine-facing core, Electron-free), IPC, transport factory (lazy builds + FreeLLM failover), sandboxed PreviewHost |
| `app/src/engine/` | The guarded engine bridge (deep `createRequire` + runtime conformance check + hand-authored TypeScript contract) |
| `app/src/shared/` | The typed bridge vocabulary: 3 channels, event catalog, shared reducer (byte-matches the renderer's) |
| `app/scripts/` | Build (tsc, no bundler), the 7-item gate, freeze tooling |
| `opus-deck-software/` | **ruic-engine** — the frozen orchestration engine (see below) |
| `opus-deck-software/src/state/` | The Brain: State Contract, TRY BOX, vector store, guides, Ollama bridge |
| `opus-deck-software/src/zeak/` | Zeak v1 (economic transport decorator) + v2 learning loop |
| `opus-deck-software/src/routing/` | Laya, the deterministic router |
| `opus-deck-software/src/depts/` | Data Collection (GitHub / Agent-Reach / Obscura collector seam) |
| `opus-deck-software/src/crew/` | Engineer workers (exit-path contracts, TRY BOX recording, guide injection) |
| `opus-deck-software/src/leader/` | Dept 4: planning, claims, handoff re-queue, verify, sign-off |
| `opus-deck-software/src/merge/`, `src/audit/`, `src/f11/`, `src/f12/` | Merge gate, findings remediation, review agent, codegraph |
| `opus-deck-software/src/cli/` | The `opus` CLI |
| `app/PROVENANCE.md` | Build provenance, freeze hashes, known gaps |
| `tools/verify/` | Relocatable visual-check tooling: harness builder, mock bridge, 97-check UI verifier, screenshot driver |
| `docs/screenshots/` | Deck screenshots (chat idle/live/completed, every view, advanced options, ⌘K) |

**Technologies:** TypeScript (strict, zero `any` at the bridge), Node 20+, Electron 31, electron-builder (portable exe), Ollama (qwen2.5-coder + nomic-embed-text), `zod` (the engine's only runtime dependency), built-in `node:test`. **No bundler, no frameworks.**

---

## 11. Current state and known gaps

- **Works end-to-end:** local trivial runs (fully free), handoffs, security scanning, remediation, merge + audit report, learning loop, FreeLLM failover, model pool, sandboxed preview.
- **Needs a frontier key:** heavy briefs (Dept 3 planning) — see §7.
- **Not yet done:** installer/auto-update (portable exe only), code signing, per-task similarity ranking of injected guides (currently newest-first under a token cap), production transport soak-testing beyond the scripted suite, crew-health probing of engineers/security (lead only).
- Agent-Reach integration activates once the CLI is installed locally; without it, Dept 2 runs GitHub-only by design.

---

## 12. Screenshots

The deck, live — in `docs/screenshots/`:

- `01-chat-idle.png` — the chat box with quick-start chips
- `07-chat-live.png` / `10-chat-completed.png` — conversational turns: your message as a `you` bubble, the crew's replies streaming the governed run
- `15-advanced-open.png` — the composer flipped into the Goal / Description form via **advanced options**
- every view (overview, findings, crew, preview) idle and live, plus the ⌘K palette

---

## 13. License

Apache License 2.0 — see [LICENSE](LICENSE). Engine (`opus-deck-software/`) and deck (`app/`) ship under the same grant.

---

*RUIC — one brief in, a crew of models out, and the system gets smarter with every failure.*
