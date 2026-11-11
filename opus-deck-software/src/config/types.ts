/**
 * Opus//DECK — Phase 1: Config & Event Bus.
 * Shared public types consumed by every phase.
 */

/** A model as declared by the orchestrating configuration. */
export interface ModelRef {
  id: string
  provider: 'openai-compatible' | 'anthropic' | 'custom'
  endpoint?: string
  model: string
  apiKeyEnv?: string
  contextWindowTokens: number
  speedClass?: 'fast' | 'standard' | 'heavy'
  /**
   * Native reasoning depth (thinking capability) for this model. Mirrors the
   * transport-layer ModelRef; adapters put it on the wire when set.
   */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** Input configuration handed to initOpusDeck before validation. */
export interface OpusDeckConfig {
  memoryDir: string
  outputDir: string
  brief: string
  goalState: string[]
  crew: {
    lead: ModelRef
    engineers: ModelRef[]
    security: ModelRef[]
  }
  budgets?: {
    digestTokens?: number
    promptTokens?: number
  }
}

/** Validated and defaulted configuration, with absolute paths. */
export interface ResolvedConfig {
  memoryDir: string
  outputDir: string
  brief: string
  goalState: string[]
  crew: ResolvedCrew
  budgets: ResolvedBudgets
}

export interface ResolvedCrew {
  lead: ModelRef
  engineers: ModelRef[]
  security: ModelRef[]
}

export interface ResolvedBudgets {
  digestTokens: number
  promptTokens: number
}

/** The runtime handed out by initOpusDeck. */
export interface OpusDeckRuntime {
  bus: EventBus
  config: ResolvedConfig
  version: string
  shutdown(): Promise<void>
}

/**
 * Why a confirmation token was refused. The three required audit distinctions
 * (expired / replayed / wrong-scope) each get their own reason AND their own
 * error code; `malformed` covers tokens this process cannot even attribute
 * (bad shape, bad signature, foreign process key).
 */
export type ConfirmationRejectionReason = 'expired' | 'replayed' | 'wrong-scope' | 'malformed'

/** The lifecycle events of one orchestration run (additive; names never repurposed). */
export type EventName =
  | 'run.started'
  | 'task.claimed'
  | 'task.completed'
  | 'memory.written'
  | 'finding.raised'
  | 'finding.resolved'
  | 'compaction.requested'
  | 'compaction.started'
  | 'compaction.done'
  | 'crew.sync'
  | 'review.queued'
  | 'review.requested'
  | 'review.bundle.started'
  | 'review.bundle.done'
  | 'review.completed'
  | 'run.completed'
  | 'run.failed'
  | 'action.confirmed'
  | 'action.rejected'
  | 'codegraph.rebuilt'

export interface RunStartedPayload {
  runId: string
  brief: string
  goalState: string[]
}
export interface TaskClaimedPayload {
  runId: string
  taskId: string
  claimedBy: string
}
export interface TaskCompletedPayload {
  runId: string
  taskId: string
  summary: string
}
/**
 * R10 (Phase 2 repair): emitted from the wiring layer after every successful
 * commons.write() — commons itself stays bus-free per its folder-03 contract.
 */
export interface MemoryWrittenPayload {
  path: string
  txnId: string
  author: string
}
export interface FindingRaisedPayload {
  runId: string
  findingId: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
}
export interface FindingResolvedPayload {
  runId: string
  findingId: string
}
export interface CompactionRequestedPayload {
  runId: string
  reason: string
}
export interface CompactionStartedPayload {
  runId: string
}
export interface CompactionDonePayload {
  runId: string
}
export interface CrewSyncPayload {
  runId: string
}
export interface ReviewQueuedPayload {
  runId: string
  decisionId: string
}
export interface ReviewRequestedPayload {
  runId: string
  fileCount: number
  bundleCount: number
}
export interface ReviewBundleStartedPayload {
  bundleId: string
  files: string[]
}
export interface ReviewBundleDonePayload {
  bundleId: string
  files: string[]
  findings: number
  dropped: number
}
export interface ReviewCompletedPayload {
  runId: string
  requests: number
  bundles: Array<{ id: string; files: string[]; tokenEstimate: number }>
  findings: number
  dropped: number
  reflections: number
}
export interface RunCompletedPayload {
  runId: string
}
export interface RunFailedPayload {
  runId: string
  error: string
}

/**
 * Phase 4: a high-impact action was authorized and its single-use confirmation
 * token was burned. Exactly one `action.confirmed` per successful consume.
 */
export interface ActionConfirmedPayload {
  confirmationId: string
  scope: string
  action: string
  subject?: string
  nonce: string
  issuedAt: string
  expiresAt: string
  consumedAt: string
}

/**
 * Phase 4: a confirmation token was refused. `reason` is the audit-grade
 * distinction (expired / replayed / wrong-scope / malformed) and `code` is the
 * matching error code — a generic "invalid token" is never emitted.
 */
export interface ActionRejectedPayload {
  reason: ConfirmationRejectionReason
  code: string
  requestedScope: string
  tokenScope?: string
  action?: string
  nonce?: string
  confirmationId?: string
  expiresAt?: string
  consumedAt?: string
  message: string
  at: string
}

/**
 * Phase 12: the workspace graph was rebuilt. Counts are the headline
 * numbers (files scanned, module clusters found, hub files ranked).
 */
export interface CodegraphRebuiltPayload {
  files: number
  clusters: number
  hubs: number
}

/** Maps every event name to the payload the handler of that event receives. */
export type EventPayloads = {
  'run.started': RunStartedPayload
  'task.claimed': TaskClaimedPayload
  'task.completed': TaskCompletedPayload
  'memory.written': MemoryWrittenPayload
  'finding.raised': FindingRaisedPayload
  'finding.resolved': FindingResolvedPayload
  'compaction.requested': CompactionRequestedPayload
  'compaction.started': CompactionStartedPayload
  'compaction.done': CompactionDonePayload
  'crew.sync': CrewSyncPayload
  'review.queued': ReviewQueuedPayload
  'review.requested': ReviewRequestedPayload
  'review.bundle.started': ReviewBundleStartedPayload
  'review.bundle.done': ReviewBundleDonePayload
  'review.completed': ReviewCompletedPayload
  'run.completed': RunCompletedPayload
  'run.failed': RunFailedPayload
  'action.confirmed': ActionConfirmedPayload
  'action.rejected': ActionRejectedPayload
  'codegraph.rebuilt': CodegraphRebuiltPayload
}

/** The typed event bus every phase emits through. */
export interface EventBus {
  on(event: EventName, handler: (payload: EventPayloads[EventName]) => void): void
  once(event: EventName, handler: (payload: EventPayloads[EventName]) => void): void
  emit(event: EventName, payload: unknown): void
}

/** A destination the event bus forwards events to. */
export interface EventSink {
  write(event: EventName, payload: EventPayloads[EventName]): void
}
