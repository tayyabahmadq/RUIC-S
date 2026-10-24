# Opus//DECK App - Provenance

External material: none. The app is written from scratch inside this project.
The Opus//DECK engine (`opus-deck-software/`) is a read-only dependency; no
engine file is copied, generated from, or modified (R18). The engine-manifest
check in the gate proves the engine is byte-identical to its frozen baseline.

Idea attribution: none (original implementation).

## Component map (what exists, and why)

Governance
- `DECISIONS.log` - governance log (clean UTF-8, no NUL bytes, R14).
- `PROVENANCE.md` - this file.
- `scripts/engine-baseline.txt` - the frozen engine manifests (151 lines after
  the sanctioned engine micro-phase E1: `\<backslash-relpath> <SHA256-UPPERCASE>`),
  used by the gate. The aggregate hash changed by E1 and the gate constant was
  updated in the same change (see app `DECISIONS.log` [E1-RF]).

Build / gate (no bundler anywhere)
- `package.json` - Electron app manifest; scripts `build|test|test:electron|probe|gate`.
- `tsconfig.json` - TypeScript strict, CommonJS, `rootDir: src`, `outDir: dist`.
- `scripts/build.mjs` - runs `tsc` and copies the renderer's static assets.
- `scripts/gate.mjs` - the six gate items, quoting every raw output.
- `scripts/probe-bridge-types.mjs` - the mutation probe (item 5).
- `scripts/run-electron-contract.mjs` - spawns real Electron per mode (item 6).

Main process (Electron-free core)
- `src/main/deck-host.ts` - `DeckHost`: the whole engine-facing behaviour.
  Bootstrap (`initOpusDeck` -> load config -> `wireOpusDeck` -> hold runtime),
  the ordered event journal, batched delivery, the invoke handlers, the
  authoritative `expectedState()`, and the graceful abort path. Imports no
  Electron.
- `src/main/ipc.ts` - `installDeckIpc`: the three IPC handlers over an injected
  `DeckIpcMain` adapter (so it is unit-testable without Electron).
- `src/main/index.ts` - the Electron entry: `app.whenReady` -> create window ->
  `DeckHost` -> `installDeckIpc`; window close aborts and disposes.
- `src/main/transport-factory.ts` - main-only key resolution (R19): registers
  crew models in the engine `ModelRegistry` (`keystoreDir` = `keystores/`),
  resolves the key from `OPUS_DECK_KEY_ENV_<ID>` first, then the keystore file,
  and wraps the transport for usage accounting.

Engine access
- `src/engine/engine-contract.ts` - the hand-authored, `unknown`-safe surface of
  the engine modules the shell uses (no `any`).
- `src/engine/engine-load.ts` - the ONE place the engine crosses into the app: a
  guarded `createRequire` of `dist/{index,wiring/index,crew/index,transport/index}.js`
  with a runtime conformance check before any cast.

Preload (the bridge)
- `src/preload/bridge.ts` - `buildBridge(ipc)`: the entire renderer-facing
  object, built from a minimal IPC surface so it can be asserted outside Electron.
- `src/preload/index.ts` - supplies the real `ipcRenderer` adapter and hands the
  object to `contextBridge.exposeInMainWorld`.

Renderer (plain script; no imports, no bundler)
- `src/renderer/index.html` - Control Deck markup + strict CSP.
- `src/renderer/style.css` - presentation.
- `src/renderer/prelude.js` - CommonJS shim so `../shared/bridge-types.js` loads
  as a classic script (no inline script; keeps `script-src 'self'`).
- `src/renderer/bind-bt.js` - publishes the shared module as the global `BT`.
- `src/renderer/app.ts` - the renderer: its OWN reducer, DOM rendering, boot
  (subscribe -> replay -> crew health), run/abort, internals for the test.
- `src/renderer/globals.d.ts` - ambient declarations for the plain-script build.

Shared contract (loaded by main, preload AND the renderer)
- `src/shared/bridge-types.ts` - the typed bridge surface (quoted below) plus
  `reconstructState` and the canonical ordering functions.
- `src/shared/channels.ts` - the exactly-three IPC channel names.
- `src/shared/event-normalize.ts` - hub event -> bridge event normalization.

Tests
- `src/test/scripted.ts` - every deterministic seam (clock, config, transport,
  health, temp dirs, canonical serializer).
- `src/test/bridge-contract.test.ts` - gate item 3 in node form (cold, mid-run, abort).
- `src/test/reconstruction.test.ts` - renderer reducer vs shared reducer.
- `src/test/keys.test.ts` - gate item 5 / R19.
- `src/test/electron/main.ts` - the REAL-Electron bridge contract test.

## The typed bridge surface (R16)

Exactly two surfaces, zero `any`, typed in both directions. The complete surface
(`src/shared/bridge-types.ts`):

```ts
export type BridgeEventName =
  | 'run.started' | 'run.completed' | 'run.failed'
  | 'phase.change'
  | 'task.claimed' | 'task.completed' | 'task.failed'
  | 'finding.raised' | 'finding.resolved'
  | 'presence.update'
  | 'token.use'
  | 'memory.written'
  | 'review.requested' | 'review.bundle.started' | 'review.bundle.done' | 'review.completed'
  | 'compaction.requested' | 'compaction.done'
  | 'action.confirmed' | 'action.rejected'
  | 'codegraph.rebuilt'

/** One journaled event. `type` and `payload` are correlated (a discriminated union). */
export type DeckEvent = {
  [K in BridgeEventName]: {
    readonly id: string
    readonly type: K
    readonly payload: BridgeEventPayloads[K]
    readonly at: string
  }
}[BridgeEventName]

/** A batch of events delivered to the renderer, in journal order. */
export interface DeckEventBatch {
  readonly events: readonly DeckEvent[]
  readonly replayBase: number
  readonly at: string
}

export interface DeckEventSubscription {
  readonly subscribe: (onBatch: (batch: DeckEventBatch) => void) => () => void
}
export interface DeckEventReplay {
  readonly replay: () => DeckEventBatch
}

export type DeckInvokeCommand = {
  [K in keyof DeckInvokeCommands]: { readonly type: K; readonly payload: DeckInvokeCommands[K] }
}[keyof DeckInvokeCommands]

export type DeckInvokeResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly code?: string }

/** The complete bridge surface exposed on `window.__deckBridge__`. */
export interface DeckBridge {
  readonly events: DeckEventSubscription & DeckEventReplay
  readonly invoke: <C extends DeckInvokeCommand>(
    command: C,
  ) => Promise<DeckInvokeResponse<DeckInvokeResults[C['type']]>>
}
```

`DeckInvokeCommands` is exactly four entries:

```ts
export interface DeckInvokeCommands {
  readonly run: DeckConfigInput
  readonly abort: { readonly runId?: string }
  readonly config: { readonly action: 'get' | 'set'; readonly config?: DeckConfigInput }
  readonly crewHealth: { readonly runId?: string }
}
```

R19 is enforced by the type itself: `BridgeModelRef` has no `apiKeyEnv` and no key
field, and `DeckConfigView` is a whitelist projection of the config in main, so
a smuggled `apiKeyEnv` (or any unknown field) cannot round-trip.

IPC channels - exactly three (`src/shared/channels.ts`):

```ts
export const DECK_CHANNELS = {
  invoke: 'deck:invoke',
  eventsBatch: 'deck:events:batch',
  eventsReplay: 'deck:events:replay',
} as const
```

## Proposed additive engine exports (NOW APPLIED, sanctioned micro-phase E1)

The shell needs five engine symbols that the engine's public barrel did not
re-export, and the engine emits no `.d.ts` at all. Both proposals were
sanctioned and applied in engine micro-phase E1 (R18 exception; engine
DECISIONS.log E1 session):

1. `src/index.ts` (the public barrel) now re-exports `wireOpusDeck` (with its
   companion types `WireOptions`/`WiredDeck`), `runCrew`, and `ModelRegistry`.
2. The engine's tsconfig now sets `declaration: true` + `declarationMap: true`,
   so `dist/index.d.ts` exists and the `types` field of its package.json
   resolves.

This app's engine-load deep-require still works unchanged against the applied
state; switching the loader to the barrel is deferred to a later phase.

## Engine behaviours the shell must respect (observed, not patched)

- `leader.route()` writes claims but emits no hub event; the shell reads
  `f05.holdersOf(path)` and emits `task.claimed` itself.
- Payload divergence: the crew emits `task.completed` as
  `{taskId, modelId, intent}`; `leader.signOff` emits `run.completed` as
  `{checksum, fileCount, at}`; CLI/crew `run.failed` variants differ. Main
  normalizes all of these (`src/shared/event-normalize.ts`).
- CORRECTED IN E1: `leader.signOff()` never overwrites `STATE/findings.json`
  (it writes `STATE/leader-06/signoff.json`); the actual overwrite came from
  the f11 review agent's routed persist through the canonical writer. The
  engine now persists findings merge-by-id (R22, sanctioned micro-phase E1), so
  previously persisted rows — including resolved flags — survive the pipeline.
- CORRECTED IN E2 (R23): `wired.remediateFindings` USED to return the
  remediation resolutions without persisting them, so the shell's re-persist
  around review was the ONLY writer of a resolved flag — verified by experiment:
  with that call removed, a clean run fails `pre-merge gate failed:
  critical-findings`. The engine now persists resolutions through the same
  canonical merge-by-id writer, and the engine-alone path passes the pre-merge
  gate (`src/wiring/remediation-persist.test.ts`, fail-then-pass). The shell's
  call is now redundant and idempotent — REMOVABLE, and retired-in-E3; see app `DECISIONS.log` [E3-B1].
- The merge gate `checkReadiness` reads `STATE/findings.json` AND requires
  `STATE/tasks.json` to hold no live `claim` rows; the shell therefore releases
  claims before verifying, and orders merge BEFORE verify.

## Observed engine integration risk (REPAIRED, sanctioned micro-phase E1)

The crew's `EngineerWorker` calls `F07TransportClient.stream()`, which returns the
RAW chunk iterable; the worker's `readStreamResult` used to `JSON.stringify`s EVERY
non-text chunk (old `stringifyChunk` fallback) — a real provider adapter always
terminates with `{ type: 'done', finishReason }` (and may emit usage chunks), so a
real run would have appended `{"type":"done","finishReason":"stop"}` to the
model's JSON and failed write-intent parsing. The engine itself now implements
the full realistic grammar (R21, sanctioned micro-phase E1): the worker collects
text chunks only, feeds `usage` chunks to the optional `usageSink` accounting
seam, and terminates at `done`. The engine's crew and full-wiring test stubs
were upgraded to emit the full grammar, and
`src/crew/realistic-stream.test.ts` proves the realistic sequence fail-then-pass.

## Deferrals (phase C2 and beyond)

- No packaging/signing, no auto-update, no updater, no installer.
- The scripted transport is a test seam; a production run uses the real
  transport factory, whose crew path is repaired by engine micro-phase E1
  (R21) - the E1 repair is proven fail-then-pass, but no production-run
  transport has been executed from this app yet.
- Crew health probes only the lead model; engineers/auditors are reported as
  "assumed healthy" (they are not independently reachable without a key).

## The test seam and the E1/E2 defect classes (E2/B3 finding)

E1 verification found that the scripted seam (`src/test/scripted.ts`) still
encoded the PRE-E1 workaround - crew calls emitted a single text chunk, and the
comment cited a `stringifyChunk` function the engine had already deleted. The
consequence was not cosmetic: **the shipped suite could not have caught the E1
defect class at all**, because it only ever met text-only stubs.

E2/B3 upgrades the seam to the realistic grammar on every call (text, usage,
done), plus a post-`done` probe chunk on crew calls, and removes the stale
comment. Proven by mutation:

| seam | engine | app suite |
|---|---|---|
| old (text-only crew calls) | pre-E1 (E1 reverted) | **10/10 pass — defect invisible** |
| new (realistic grammar) | pre-E1 (E1 reverted) | **8/10 — 2 failures, defect caught** |
| new (realistic grammar) | fixed | 10/10 pass |

The same shape applies to the leader path, which E2/A2 repaired (R24:
`F06TransportAdapter` now terminates on `done` instead of concatenating every
text chunk - previously a post-`done` chunk corrupted the plan JSON with
`LEADER_INVALID_LLM_JSON`, observed during E1 verification). The seam's probe
chunk guards that path too.

## Encoding rules (R14)

`DECISIONS.log` and this file are clean UTF-8 with no NUL bytes.

## Preview surface (phase C2)

The control deck gained a sandboxed preview of the merged build output, built
in `app/` only; the engine is untouched (R18, aggregate 46B641F2…).

- **Containment (R17):** `src/main/preview-host.ts` manages a single
  `WebContentsView` (BrowserView is deprecation-bound; WebContentsView chosen
  deliberately) with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `webSecurity: true`, **no preload**, no
  `contextBridge`, no `__deckBridge__`, no IPC. Each preview instance gets a
  dedicated `Session` whose `webRequest` layer cancels every request that is
  not a `file://` URL inside the run's `outputDir`, and whose permission
  handler denies every request. `will-navigate`/`will-redirect` are prevented,
  `setWindowOpenHandler` returns `deny`, and `will-attach-webview` is
  prevented. Entry points are strictly validated: listed in MANIFEST.json,
  resolve inside `outputDir`, `.html`/`.htm` only, loaded via `pathToFileURL`.
- **Bridge contract (R16):** preview rides the existing typed `deck:invoke`
  command (`preview: { action: 'open' | 'close', runId?, file? }`) and its
  state is delivered on `deck:events:batch` (`preview.state`). Exactly three
  channels; no fourth channel; no double delivery. `DeckPreviewResult` carries
  `open`, `currentFile`, `files`. Verified both directions by
  `scripts/probe-bridge-types.mjs`.
- **Renderer:** the `<iframe>` preview was removed; the preview panel shows
  open/closed state and the manifest file list and drives open/close/file-pick
  through the typed `preview` invoke command.
- **Escape tests (gate item 3):** `src/test/electron/escape.test.ts` runs in
  real Electron, instantiates the product `PreviewHost`, loads a hostile
  generated page, and asserts `require`/`process`/`__deckBridge__`/`ipcRenderer`
  are all undefined, navigation is blocked, new windows return null, and
  `fetch` is cancelled at the session layer. Proven to fail on the pre-C2
  scaffolding and to pass on the hardened host.
- **Electron:** pinned to 31.x; WebContentsView used because BrowserView is
  removal-bound.


## Common-S v2 (2026-10-25)

Sanctioned engine phase (re-freeze aggregate `58861E794B70EF5C01C1CE55C1BBFD1C12C4600057B22239AB83EDA4A071AC98`, regenerated via `scripts/refreeze.mjs`):

- **Brain** (`src/state/`): State Contract v1.0.0 (`schemaVersion`, `taskId`, `parentTaskId`, `status` in_progress|blocked|handed_off|done, `owner`, `done`, `decisions`, `remaining`, `artifacts`), enforced at the worker EXIT path; `state.json` task flags; file-backed vector store with recency-x-relevance decay cap.
- **Triangular Loop**: `compaction.requested` after every sub-task (completion AND failure), serialized through the Brain's queue; all three stores compacted.
- **Laya** (`src/routing/laya.ts`): deterministic router; trivial -> local end-to-end (`leader.seedLocalPlan` mints T-01 with zero paid calls); heavy -> Dept 4.
- **Dept 4**: the leader's string-split "split" strategy REPLACED by intact handoff re-queue (`'requeued'` resolution); `parentTaskId` stitching.
- **Dept 2** (`src/depts/data-collection.ts`): collector seam — GitHub-as-data-source (budgeted REST, 403 = budget spent) + Obscura Browser behind the same interface (serialized, graceful miss).
- **Zeak** (`src/zeak/`): Cache-Gate -> Pruner -> Capper -> Early-Stopper over the single transport seam; loud fallback (`zeak.fallback` + durable `zeakFallback` flag) with a one-shot Security re-escalation budget.
- **Crew**: `task.failed` emitted on worker failure; `contractWriter` seam (module default installed by wiring) writes done/blocked/handed_off contracts.
- **Gate**: engine diff zero re-baselined; expected test counts replaced with all-pass assertions.
- **Fixed en route**: `STATE/tasks.json` initialized as an array at BOTH boot sites (the object shape broke merge/verify on any run that skipped leader.plan).

Verification: engine suite 155/155, app suite 10/10, gate.mjs PASS (all 7 items incl. real-Electron contract + escape tests).

### Agent-Reach collector (Dept 2 addition, 2026-10-25)

Re-freeze aggregate `04BA4193E5F20C6CAB2C2951B150DA96AED079D5F20C1AB96930E2A6FEA187A1`.

- `src/depts/agent-reach.ts`: `AgentReachCollector` — shells the local Agent-Reach CLI (github.com/Panniantong/Agent-Reach) behind the existing Collector seam. JSON + markdown output parsing, per-channel fallback, cached availability probe, graceful miss on missing CLI.
- Browsing citizens (Obscura Browser + Agent-Reach session browser) share ONE serial queue (`createSerialQueue`, now owned by data-collection.ts) — one browsing agent at a time across implementations.
- `collectTopic` takes an ordered `collectors` chain: free budget first (GitHub REST), browser time second; cache-gate still gates everything.
- Channels default to the no-login free set (`websearch`, `github`); no paid-key channel (YouTube STT) is ever invoked by the engine.

Verification: engine suite 162/162 (7 new Agent-Reach tests), gate re-run before push.

### Local executor online (2026-10-25)

- Ollama 0.40.11 installed; `qwen2.5-coder:1.5b` (986 MB) + `nomic-embed-text` (274 MB) pulled.
- Empirical context ladder verdict: **32768, 100% GPU (2.1 GB)**. 65536 is IMPOSSIBLE on this model — the qwen2 architecture caps context_length at 32768 and Ollama silently clamps; the ladder's honest winner is 32K (recorded in COMMONS/STATE/context.txt).
- The Brain embedder is wired in the deck's main process (local nomic-embed-text via Ollama; null on failure degrades vector ops to miss-only).
