/**
 * Opus//DECK App — renderer ambient declarations.
 *
 * The renderer is a plain script (no bundler, no imports — see `index.html`),
 * so every type it uses is declared globally here. `BT` is the runtime object
 * the HTML prelude assigns from the compiled `shared/bridge-types.js`; the
 * `window` members are what the preload bridge and this script put there.
 *
 * `export {}` makes this file a module so `declare global` is permitted; no
 * runtime code is emitted.
 */
export {}

declare global {
  interface DeckRendererInternals {
    /** Reduce an event stream to run state (the renderer's own reducer). */
    readonly reconstructState: (events: readonly DeckEvent[]) => ReconstructedState
    /** How many distinct events this renderer has applied. */
    readonly appliedEventCount: () => number
    /** The current published state (same object as `window.__deckState__`). */
    readonly currentState: () => ReconstructedState
    /** True once boot (subscribe + replay + crewHealth) has finished. */
    readonly isReady: () => boolean
    /** True while a crew-health invoke is in flight (boot or run-start refresh). */
    readonly healthRefreshPending: () => boolean
    /** Wire the DOM and start the bridge. Safe to call once. */
    readonly mount: () => void
  }

  type DeckEvent = import('../shared/bridge-types').DeckEvent
  type DeckEventBatch = import('../shared/bridge-types').DeckEventBatch
  type DeckBridge = import('../shared/bridge-types').DeckBridge
  type DeckConfigInput = import('../shared/bridge-types').DeckConfigInput
  type DeckConfigView = import('../shared/bridge-types').DeckConfigView
  type DeckInvokeCommand = import('../shared/bridge-types').DeckInvokeCommand
  type DeckCrewHealthResult = import('../shared/bridge-types').DeckCrewHealthResult
  type BridgeModelRef = import('../shared/bridge-types').BridgeModelRef
  type BridgeCrew = import('../shared/bridge-types').BridgeCrew
  type ReconstructedState = import('../shared/bridge-types').ReconstructedState
  type ReconstructedTask = import('../shared/bridge-types').ReconstructedTask
  type ReconstructedFinding = import('../shared/bridge-types').ReconstructedFinding
  type ReconstructedPresence = import('../shared/bridge-types').ReconstructedPresence
  type ReconstructedCrewHealth = import('../shared/bridge-types').ReconstructedCrewHealth
  type RunPhase = import('../shared/bridge-types').RunPhase
  type Severity = import('../shared/bridge-types').Severity
  type CrewRole = import('../shared/bridge-types').CrewRole

  /** The sorting/state helpers from `shared/bridge-types.js` (set by the HTML prelude). */
  var BT: {
    readonly SEVERITY_ORDER: Readonly<Record<Severity, number>>
    compareFindings(a: ReconstructedFinding, b: ReconstructedFinding): number
    compareTasks(a: ReconstructedTask, b: ReconstructedTask): number
    comparePresence(a: ReconstructedPresence, b: ReconstructedPresence): number
    emptyState(): ReconstructedState
  }

  var __deckState__: ReconstructedState
  var __deckInternals__: DeckRendererInternals

  interface Window {
    __deckBridge__?: DeckBridge
    __deckState__?: ReconstructedState
    __deckInternals__?: DeckRendererInternals
  }
}
