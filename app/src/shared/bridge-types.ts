/**
 * Opus//DECK App — the typed bridge surface (R16).
 *
 * Shared by main, preload and the renderer's type declarations. This file IS
 * the contract across the contextBridge boundary and it is typed in BOTH
 * directions with zero `any`:
 *
 *   (a) events  — main -> renderer, batched and ordered, with full replay
 *                 (state reconstruction on a cold or mid-run open);
 *   (b) invoke  — renderer -> main, limited to exactly four commands:
 *                 run, abort, config, crewHealth.
 *
 * The renderer never imports engine code, never touches COMMONS files and
 * never sees key material or environment access (R16, R17, R19).
 */

/* ================================================================== *
 * Event vocabulary (main -> renderer)
 *
 * The engine's hub emits a subset of these names directly; the main process
 * normalizes those payloads and emits the remaining lifecycle events itself
 * while it drives the run. Both arrive on the same ordered journal, so the
 * renderer reconstructs state from one stream.
 * ================================================================== */

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
  | 'preview.state'

export interface BridgeEventPayloads {
  'run.started': { runId: string; brief: string; goalState: string[] }
  'run.completed': { runId: string; checksum: string; fileCount: number }
  'run.failed': { runId: string; error: string }
  'phase.change': { runId: string; phase: RunPhase }
  'task.claimed': { runId: string; taskId: string; file: string; holder: string }
  'task.completed': { runId: string; taskId: string }
  'task.failed': { runId: string; taskId: string; error: string }
  'finding.raised': {
    runId: string; findingId: string; severity: Severity; path: string; line: number; message: string
  }
  'finding.resolved': { runId: string; findingId: string }
  'presence.update': { runId: string; modelId: string; role: CrewRole; status: string; taskId?: string }
  'token.use': { runId: string; inputTokens: number; outputTokens: number }
  'memory.written': { path: string; txnId: string; author: string }
  'review.requested': { runId: string; fileCount: number; bundleCount: number }
  'review.bundle.started': { bundleId: string; files: string[] }
  'review.bundle.done': { bundleId: string; files: string[]; findings: number; dropped: number }
  'review.completed': {
    runId: string; requests: number; findings: number; dropped: number; reflections: number
  }
  'compaction.requested': { reason: string }
  'compaction.done': { reason: string }
  'action.confirmed': { confirmationId: string; scope: string; action: string }
  'action.rejected': { reason: string; code: string; message: string }
  'codegraph.rebuilt': { files: number; clusters: number; hubs: number }
  'preview.state': { runId: string; open: boolean; currentFile: string | null; files: string[] }
}

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
  /** Journal length already delivered to this sink before this batch. */
  readonly replayBase: number
  readonly at: string
}

/** Event subscription surface: batched, ordered, and gap-free. */
export interface DeckEventSubscription {
  readonly subscribe: (onBatch: (batch: DeckEventBatch) => void) => () => void
}

/** Full-history replay surface used to rebuild state when the UI opens mid-run. */
export interface DeckEventReplay {
  readonly replay: () => DeckEventBatch
}

/* ================================================================== *
 * Invoke surface (renderer -> main), limited to run | abort | config | crewHealth
 * ================================================================== */

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'custom'
export type SpeedClass = 'fast' | 'standard' | 'heavy'
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type CrewRole = 'lead' | 'engineer' | 'security'

/**
 * A model as the renderer may describe it. NOTE (R19): there is deliberately
 * NO `apiKeyEnv` and no key field — the renderer can name a model, never a
 * key and never an environment variable. Key resolution stays in main.
 */
export interface BridgeModelRef {
  readonly id: string
  readonly provider: ProviderKind
  readonly model: string
  readonly contextWindowTokens: number
  readonly endpoint?: string
  readonly speedClass?: SpeedClass
  readonly reasoningEffort?: ReasoningEffort
}

export interface BridgeCrew {
  readonly lead: BridgeModelRef
  readonly engineers: readonly BridgeModelRef[]
  readonly security: readonly BridgeModelRef[]
}

/** Everything the renderer may send/see for configuration (no key material). */
export interface DeckConfigInput {
  readonly memoryDir: string
  readonly outputDir: string
  readonly brief: string
  readonly goalState: readonly string[]
  readonly crew: BridgeCrew
}

/** What a `config` get returns to the renderer: names and roles, never keys. */
export interface DeckConfigView extends DeckConfigInput {
  readonly gate: { readonly failOn: Severity }
  readonly engineRoot: string
  readonly engineVersion: string
}

export interface DeckInvokeCommands {
  readonly run: DeckConfigInput
  readonly abort: { readonly runId?: string }
  readonly config: { readonly action: 'get' | 'set'; readonly config?: DeckConfigInput }
  readonly crewHealth: { readonly runId?: string }
  readonly preview: { readonly action: 'open' | 'close'; readonly runId?: string; readonly file?: string }
}

export type DeckInvokeCommand = {
  [K in keyof DeckInvokeCommands]: { readonly type: K; readonly payload: DeckInvokeCommands[K] }
}[keyof DeckInvokeCommands]

export interface DeckCrewHealthResult {
  readonly crew: readonly ReconstructedCrewHealth[]
}

export interface DeckRunResult { readonly runId: string }
export interface DeckAbortResult { readonly aborted: boolean; readonly releasedLocks: number }

export interface DeckInvokeResults {
  readonly run: DeckRunResult
  readonly abort: DeckAbortResult
  readonly config: DeckConfigView
  readonly crewHealth: DeckCrewHealthResult
  readonly preview: DeckPreviewResult
}

export interface DeckPreviewResult {
  readonly open: boolean
  readonly currentFile: string | null
  readonly files: readonly string[]
}

/** Narrow handle the host uses to drive the preview view; no Electron type
 *  leaks into the Electron-free host module. */
export interface PreviewHostHandle {
  open(
    memoryDir: string,
    outputDir: string,
    entryPoint?: string,
  ): Promise<{ readonly open: boolean; readonly currentFile: string | null; readonly files: string[] }>
  close(): Promise<{ readonly open: boolean; readonly currentFile: string | null; readonly files: string[] }>
}

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

/* ================================================================== *
 * Reconstructed run state — what the renderer rebuilds from events, and
 * the shape main computes directly for the bridge-contract comparison.
 * ================================================================== */

export type RunPhase =
  | 'idle'
  | 'planning'
  | 'building'
  | 'auditing'
  | 'patching'
  | 'reviewing'
  | 'merging'
  | 'completed'
  | 'failed'

export interface ReconstructedTask {
  readonly id: string
  readonly file: string
  readonly holder: string
  readonly status: 'pending' | 'claimed' | 'completed' | 'failed'
}

export interface ReconstructedFinding {
  readonly id: string
  readonly severity: Severity
  readonly path: string
  readonly line: number
  readonly message: string
  readonly resolved: boolean
}

export interface ReconstructedPresence {
  readonly modelId: string
  readonly role: CrewRole | 'unknown'
  readonly status: string
  readonly taskId?: string
}

export interface ReconstructedCrewHealth {
  readonly id: string
  readonly role: CrewRole
  readonly healthy: boolean
  readonly detail?: string
}

export interface ReconstructedState {
  readonly runId: string
  readonly phase: RunPhase
  /** Sorted by task id. */
  readonly tasks: readonly ReconstructedTask[]
  /** Severity-sorted (critical -> low), then by id. */
  readonly findings: readonly ReconstructedFinding[]
  /** Sorted by model id. */
  readonly presence: readonly ReconstructedPresence[]
  readonly crewHealth: readonly ReconstructedCrewHealth[]
  readonly tokenSpend: number
  /** endedAt - startedAt (0 while running or before start). */
  readonly elapsedMs: number
  readonly startedAt: string | null
  readonly endedAt: string | null
}

/* ================================================================== *
 * Canonical ordering — ONE definition used by the renderer and by main's
 * directly-computed expected state, so "matches" is well defined.
 * ================================================================== */

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
}

export function compareFindings(a: ReconstructedFinding, b: ReconstructedFinding): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  if (bySeverity !== 0) return bySeverity
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function compareTasks(a: ReconstructedTask, b: ReconstructedTask): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function comparePresence(a: ReconstructedPresence, b: ReconstructedPresence): number {
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0
}

export function emptyState(): ReconstructedState {
  return {
    runId: '',
    phase: 'idle',
    tasks: [],
    findings: [],
    presence: [],
    crewHealth: [],
    tokenSpend: 0,
    elapsedMs: 0,
    startedAt: null,
    endedAt: null,
  }
}

/* ================================================================== *
 * State reconstruction (R16, hard requirement).
 *
 * The ONE reducer that turns a delivered event stream into run state. The
 * renderer runs it over everything the bridge delivers, and it is what the
 * mid-run open relies on: a window opened after the run started replays the
 * journal and rebuilds tasks / findings / phase / presence from scratch.
 *
 * Events are deduplicated by id, so a consumer may safely apply the full
 * replay batch AND the live tail (or apply a replayed batch twice) without
 * double-counting. The output is canonically ordered, so two consumers that
 * saw the same set of events produce byte-identical state.
 * ================================================================== */

interface MutableState {
  runId: string
  phase: RunPhase
  startedAt: string | null
  endedAt: string | null
  tokenInput: number
  tokenOutput: number
  readonly tasks: Map<string, ReconstructedTask>
  readonly findings: Map<string, ReconstructedFinding>
  readonly presence: Map<string, ReconstructedPresence>
}

function applyEvent(state: MutableState, event: DeckEvent): void {
  switch (event.type) {
    case 'run.started':
      state.runId = event.payload.runId
      state.startedAt = event.at
      state.phase = 'planning'
      return
    case 'phase.change':
      state.phase = event.payload.phase
      return
    case 'task.claimed':
      state.tasks.set(event.payload.taskId, {
        id: event.payload.taskId,
        file: event.payload.file,
        holder: event.payload.holder,
        status: 'claimed',
      })
      return
    case 'task.completed': {
      const existing = state.tasks.get(event.payload.taskId)
      state.tasks.set(event.payload.taskId, {
        id: event.payload.taskId,
        file: existing?.file ?? '',
        holder: existing?.holder ?? '',
        status: 'completed',
      })
      return
    }
    case 'task.failed': {
      const existing = state.tasks.get(event.payload.taskId)
      state.tasks.set(event.payload.taskId, {
        id: event.payload.taskId,
        file: existing?.file ?? '',
        holder: existing?.holder ?? '',
        status: 'failed',
      })
      return
    }
    case 'finding.raised':
      state.findings.set(event.payload.findingId, {
        id: event.payload.findingId,
        severity: event.payload.severity,
        path: event.payload.path,
        line: event.payload.line,
        message: event.payload.message,
        resolved: false,
      })
      return
    case 'finding.resolved': {
      const existing = state.findings.get(event.payload.findingId)
      if (existing === undefined) return
      state.findings.set(event.payload.findingId, { ...existing, resolved: true })
      return
    }
    case 'presence.update': {
      const taskId = event.payload.taskId
      state.presence.set(event.payload.modelId, {
        modelId: event.payload.modelId,
        role: event.payload.role,
        status: event.payload.status,
        ...(taskId === undefined ? {} : { taskId }),
      })
      return
    }
    case 'token.use':
      state.tokenInput += event.payload.inputTokens
      state.tokenOutput += event.payload.outputTokens
      return
    case 'run.completed':
      state.phase = 'completed'
      state.endedAt = event.at
      return
    case 'run.failed':
      state.phase = 'failed'
      state.endedAt = event.at
      return
    default:
      return
  }
}

/**
 * Reduce an ordered (possibly overlapping) event stream into run state.
 *
 * `crewHealth` is not derived from events: it is fetched over the invoke
 * surface and merged by the caller (the renderer) before rendering.
 */
export function reconstructState(events: readonly DeckEvent[]): ReconstructedState {
  const state: MutableState = {
    runId: '',
    phase: 'idle',
    startedAt: null,
    endedAt: null,
    tokenInput: 0,
    tokenOutput: 0,
    tasks: new Map(),
    findings: new Map(),
    presence: new Map(),
  }

  const seen = new Set<string>()
  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    applyEvent(state, event)
  }

  const elapsedMs =
    state.startedAt !== null && state.endedAt !== null
      ? Date.parse(state.endedAt) - Date.parse(state.startedAt)
      : 0

  return {
    runId: state.runId,
    phase: state.phase,
    tasks: [...state.tasks.values()].sort(compareTasks),
    findings: [...state.findings.values()].sort(compareFindings),
    presence: [...state.presence.values()].sort(comparePresence),
    crewHealth: [],
    tokenSpend: state.tokenInput + state.tokenOutput,
    elapsedMs,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
  }
}
