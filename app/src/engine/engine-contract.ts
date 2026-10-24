/**
 * Opus//DECK App — Engine contract (R18: engine is read-only).
 *
 * The engine's published surface lives in `opus-deck-software/src/` and is
 * compiled to CommonJS in `opus-deck-software/dist/` WITHOUT declaration files
 * (the engine tsconfig has no `declaration: true`), and the package barrel
 * `src/index.ts` does not re-export the composition root (`wireOpusDeck`),
 * the shared `EventHub`, the crew runner (`runCrew`) or the transport registry.
 *
 * This file is the app's DECLARED contract for the exact engine surface the
 * shell consumes. It is authored here (never inside the engine) so the engine
 * diff stays ZERO across the phase. Every declaration below mirrors a concrete
 * engine source file; the file/line provenance is recorded per block.
 *
 * `engine-load.ts` casts the dynamically-required engine modules into these
 * shapes ONCE, after a runtime conformance check, so no `any` crosses into the
 * app and drift is caught at boot instead of silently mis-typed.
 */

/* ------------------------------------------------------------------ *
 * config/types.ts — ModelRef, OpusDeckConfig, ResolvedConfig, runtime
 * ------------------------------------------------------------------ */

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'custom'
export type SpeedClass = 'fast' | 'standard' | 'heavy'
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

/** config/types.ts:7 ModelRef */
export interface EngineModelRef {
  id: string
  provider: ProviderKind
  endpoint?: string
  model: string
  apiKeyEnv?: string
  contextWindowTokens: number
  speedClass?: SpeedClass
  reasoningEffort?: ReasoningEffort
}

/** config/types.ts:23 OpusDeckConfig */
export interface EngineConfig {
  memoryDir: string
  outputDir: string
  brief: string
  goalState: string[]
  crew: {
    lead: EngineModelRef
    engineers: EngineModelRef[]
    security: EngineModelRef[]
  }
  budgets?: { digestTokens?: number; promptTokens?: number }
}

/** config/types.ts:40 ResolvedConfig */
export interface EngineResolvedConfig {
  memoryDir: string
  outputDir: string
  brief: string
  goalState: string[]
  crew: {
    lead: EngineModelRef
    engineers: EngineModelRef[]
    security: EngineModelRef[]
  }
  budgets: { digestTokens: number; promptTokens: number }
}

/** config/types.ts:61 OpusDeckRuntime */
export interface EngineRuntime {
  bus: { on(event: string, handler: (payload: unknown) => void): void; emit(event: string, payload: unknown): void }
  config: EngineResolvedConfig
  version: string
  shutdown(): Promise<void>
}

/** config/bootstrap.ts:31 initOpusDeck */
export type InitOpusDeck = (config: EngineConfig) => EngineRuntime

/* ------------------------------------------------------------------ *
 * transport/types.ts — the single model-calling interface
 * ------------------------------------------------------------------ */

/** transport/types.ts:71 TransportChunk */
export type EngineTransportChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }

/** transport/types.ts:59 CompletionRequest */
export interface EngineCompletionRequest {
  modelId: string
  system?: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

/** transport/types.ts:77 Transport */
export interface EngineTransport {
  complete(req: EngineCompletionRequest): AsyncIterable<EngineTransportChunk>
}

/** transport/types.ts:81 HealthCheckResult */
export interface EngineHealthResult {
  ok: boolean
  latencyMs: number
  detail?: string
}

/* ------------------------------------------------------------------ *
 * wiring/event-hub.ts — the shared EventHub
 * ------------------------------------------------------------------ */

/** wiring/event-hub.ts:18 one journaled hub event */
export interface EngineHubEvent {
  id: string
  type: string
  payload: unknown
  at: string
}

/** wiring/event-hub.ts:16 EventHub (the surface the shell uses) */
export interface EngineHub {
  on(event: string, handler: (payload: unknown) => void): void
  off(event: string, handler: (payload: unknown) => void): void
  emit(event: string, payload: unknown): void
  emitWithId(event: string, payload: unknown): string
  subscribe(event: string, handler: (payload: unknown) => void): void
  published(): EngineHubEvent[]
}

/* ------------------------------------------------------------------ *
 * audit/types.ts — canonical finding + scan report
 * ------------------------------------------------------------------ */

/** audit/types.ts:25 Finding (the canonical persisted shape, R13) */
export interface EngineFinding {
  readonly id: string
  readonly ruleId: string
  readonly severity: Severity
  readonly path: string
  readonly line: number
  readonly detectorModelId: string
  readonly resolved: boolean
  readonly evidence: string
  readonly message: string
  readonly patchStrategy?: 'escape' | 'env-var' | 'https' | 'crypto-random'
  readonly auditorCount: number
  readonly blocking: boolean
}

/** audit/types.ts:50 ScanReport */
export interface EngineScanReport {
  readonly findings: readonly EngineFinding[]
  readonly total: number
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly auditors: readonly string[]
  readonly rulesEvaluated: number
  readonly bySeverity: Record<Severity, number>
  readonly byRule: Readonly<Record<string, number>>
  readonly byModel: Readonly<Record<string, number>>
  readonly byPath: Readonly<Record<string, number>>
  readonly corroborated: number
}

/** audit/types.ts:66 RemediationTask */
export interface EngineRemediationTask {
  readonly id: string
  readonly kind: 'security-remediation'
  readonly priority: 0 | 1 | 2 | 3
  readonly round: number
  readonly findingId: string
  readonly ruleId: string
  readonly severity: Severity
  readonly patchStrategy: 'escape' | 'env-var' | 'https' | 'crypto-random'
  readonly targetPath: string
  readonly targetLine: number
  readonly evidence: string
  readonly instruction: string
  readonly suggestion: string
  readonly detectorModelId: string
  readonly createdAt: string
}

/** audit/types.ts:85 EnqueueReceipt / audit/types.ts:86 BusTaskOutcome */
export interface EngineEnqueueReceipt { readonly taskId: string; readonly accepted: boolean; readonly note?: string }
export interface EngineBusTaskOutcome { readonly taskId: string; readonly ok: boolean; readonly error?: string }

/** audit/types.ts:119 TaskBus */
export interface EngineTaskBus {
  enqueue(task: EngineRemediationTask): Promise<EngineEnqueueReceipt>
  awaitSettlement?(receipt: EngineEnqueueReceipt): Promise<EngineBusTaskOutcome>
}

/** audit/types.ts:153 ArtifactStore */
export interface EngineArtifactStore {
  read(path: string): Promise<{ readonly path: string; readonly code: string }>
}

/** audit/types.ts:155 EscalationQueue */
export interface EngineEscalationQueue {
  push(entry: unknown): Promise<void>
}

/** audit/types.ts:183 RemediationResult */
export interface EngineRemediationResult {
  readonly rounds: number
  readonly tasks: readonly EngineRemediationTask[]
  readonly accepted: number
  readonly rejected: number
  readonly resolved: readonly EngineFinding[]
  readonly unresolved: readonly EngineFinding[]
  readonly escalations: readonly unknown[]
  readonly advisories: readonly unknown[]
  readonly rescans: number
  readonly rescanSource: 'artifact-store' | 'snapshot' | 'none'
}

/** audit/types.ts:157 RemediationDeps */
export interface EngineRemediationDeps {
  readonly bus: EngineTaskBus
  readonly artifacts?: EngineArtifactStore
  readonly escalations?: EngineEscalationQueue
  readonly now?: () => string
}

/* ------------------------------------------------------------------ *
 * merge/types.ts — manifest
 * ------------------------------------------------------------------ */

/** merge/types.ts Manifest */
export interface EngineManifest {
  version: number
  createdAt: string
  memoryDir: string
  files: Array<{ path: string; loc: number; txn: number; sha256: string; bytes: number }>
  overrides: Array<{ path: string; winner: string; losers: string[] }>
  totalFiles: number
  totalLoc: number
}

/* ------------------------------------------------------------------ *
 * leader/types.ts — tasks, verification, sign-off
 * ------------------------------------------------------------------ */

/** leader/types.ts:25 Task */
export interface EngineTask {
  id: string
  path: string
  description: string
  acceptance: string[]
  confirmationRef?: string
}

/** leader/types.ts:23 PlanInput */
export interface EnginePlanInput {
  brief: string
  goalState: string
  crew: { lead: string; engineers: string[] }
}

/** leader/types.ts:46 VerificationResult */
export interface EngineVerificationResult { criterion: string; satisfied: boolean; evidence: string }

/** leader/types.ts:48 SignOff */
export interface EngineSignOff { checksum: string; fileCount: number; generatedAt: string }

/** leader/leader.ts:36 Leader (surface the shell drives) */
export interface EngineLeader {
  plan(input?: EnginePlanInput): Promise<EngineTask[]>
  route(tasks?: EngineTask[]): Promise<void>
  verify(criteria?: string[]): Promise<EngineVerificationResult[]>
  signOff(): Promise<EngineSignOff>
}

/* ------------------------------------------------------------------ *
 * f11/types.ts — the review agent
 * ------------------------------------------------------------------ */

/** f11/types.ts:31 ReviewRequest */
export interface EngineReviewRequest {
  runId: string
  brief: string
  goalState: string[]
  memoryDir: string
  files?: string[]
}

/** f11/review-agent.ts:38 review()`s result surface (subset the shell reads) */
export interface EngineReviewResult {
  readonly runId: string
  readonly requests: number
  readonly findings: readonly { readonly id: string; readonly ruleId: string; readonly severity: Severity }[]
  readonly dropped: readonly unknown[]
  readonly reflections: readonly unknown[]
}

export interface EngineReviewAgent { review(request: EngineReviewRequest): Promise<EngineReviewResult> }

/* ------------------------------------------------------------------ *
 * crew/types.ts — the engineering runner seam
 * ------------------------------------------------------------------ */

/** crew/types.ts:94 CommonsClient */
export interface CrewCommonsClient {
  write(args: {
    intent?: string
    path: string
    author: string
    added?: readonly string[]
    atLine?: number
    removedLineCount?: number
    content?: string
  }): unknown
  read?(path: string): unknown
}

/** crew/types.ts:99 TransportClient */
export interface CrewTransportClient {
  complete?(modelId: string, prompt: string, options?: { system?: string }): unknown
}

/** crew/types.ts:105 LockClient */
export interface CrewLockClient {
  acquire?(target: string, owner: string): unknown
  release?(target: string, owner: string): unknown
}

/** crew/types.ts:74 EventBus (crew-side) */
export interface CrewEventBus {
  emit(event: string, ...args: unknown[]): void
  on(event: string, handler: (...args: unknown[]) => void): void
}

/** crew/types.ts:133 CrewDependencies */
export interface CrewDependencies {
  readonly bus?: CrewEventBus
  readonly commons?: CrewCommonsClient
  readonly transport?: CrewTransportClient
  readonly locks?: CrewLockClient
  readonly systemPrompt?: string
}

/** crew/types.ts:125 EngineerRef (a bare model id is accepted too) */
export interface CrewEngineerRef { readonly modelId?: string; readonly id?: string }

/** crew/types.ts:24 Task (crew's view) */
export interface CrewTask {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly status?: 'pending' | 'claimed' | 'completed' | 'failed' | 'retired'
}

/** crew/types.ts:151 CrewWorkerResult / crew/types.ts:159 CrewResult */
export interface CrewWorkerResult {
  readonly modelId: string
  readonly completedTaskIds: readonly string[]
  readonly failedTaskIds: readonly string[]
  readonly retired: boolean
  readonly consecutiveFailures: number
}
export interface CrewResult { readonly workers: readonly CrewWorkerResult[]; readonly tasks: readonly CrewTask[] }

/** crew/pool.ts:23 runCrew */
export type RunCrew = (
  engineerRefs: readonly (string | CrewEngineerRef)[],
  tasks: readonly CrewTask[],
  options?: { readonly dependencies?: CrewDependencies; readonly concurrency?: number },
) => Promise<CrewResult>

/* ------------------------------------------------------------------ *
 * coordination/types.ts — presence (subset)
 * ------------------------------------------------------------------ */

/** coordination/types.ts:23 PresenceEntry */
export interface EnginePresenceEntry {
  modelId: string
  taskId?: string
  file?: string
  lastSyncAt: number
}

/* ------------------------------------------------------------------ *
 * wiring/index.ts — the composition root
 * ------------------------------------------------------------------ */

/** wiring/index.ts:70 WireOptions */
export interface EngineWireOptions {
  transport: EngineTransport
  leadModelId: string
  auditorModelIds: string[]
  confirmationTtlMs?: number
  confirmationAutoIssue?: boolean
  gate?: { failOn?: Severity }
}

/**
 * wiring/index.ts:96 WiredDeck — the subset the shell uses. Fields the shell
 * does not touch are deliberately absent rather than `any`: a missing field is
 * a compile error, an `any` field hides one.
 */
export interface WiredDeck {
  runtime: EngineRuntime
  hub: EngineHub
  commons: {
    read(path: string): Promise<string>
    write(args: {
      path: string
      diff: { added: string[]; removedLineCount: number; atLine: number }
      intent: string
      author: string
    }): Promise<number>
  }
  gate: { failOn: Severity }
  leader: EngineLeader
  f05: {
    snapshot(): EnginePresenceEntry[]
    holdersOf(path: string): string[]
    release(modelId: string, paths: string[]): void
  }
  f07: {
    commons: CrewCommonsClient
    transport: CrewTransportClient
    locks: CrewLockClient
    systemPrompt: string | undefined
  }
  f08: {
    artifactStore: EngineArtifactStore
    escalationQueue: EngineEscalationQueue
    taskBus: EngineTaskBus
  }
  f11: { reviewAgent: EngineReviewAgent }
  scan(artifacts: Array<{ path: string; code: string }>, auditors: readonly string[]): EngineScanReport
  remediateFindings(
    findings: readonly EngineFinding[],
    deps: EngineRemediationDeps,
    options?: { maxRounds?: number; confirmationToken?: string; confirmationAutoIssue?: boolean },
  ): Promise<EngineRemediationResult>
  merge(memoryDir: string, outputDir: string): Promise<EngineManifest>
  persistFindings(findings: readonly EngineFinding[]): Promise<void>
}

/** wiring/index.ts:178 wireOpusDeck */
export type WireOpusDeck = (runtime: EngineRuntime, options: EngineWireOptions) => Promise<WiredDeck>

/* ------------------------------------------------------------------ *
 * transport/registry.ts — key resolution stays here (main only, R19)
 * ------------------------------------------------------------------ */

export interface EngineRegistryOptions { keystoreDir?: string }
export interface EngineModelRegistry {
  register(ref: EngineModelRef): void
  list(): EngineModelRef[]
  resolveApiKey(id: string): string
  createTransport(id: string): EngineTransport
  healthCheck(id: string): Promise<EngineHealthResult>
}
export type ModelRegistryCtor = new (options?: EngineRegistryOptions) => EngineModelRegistry

/* ------------------------------------------------------------------ *
 * the module shapes the loader casts into
 * ------------------------------------------------------------------ */

export interface EngineEntryModule { initOpusDeck: InitOpusDeck }
export interface EngineWiringModule { wireOpusDeck: WireOpusDeck }
export interface EngineCrewModule { runCrew: RunCrew }
export interface EngineTransportModule { ModelRegistry: ModelRegistryCtor }
