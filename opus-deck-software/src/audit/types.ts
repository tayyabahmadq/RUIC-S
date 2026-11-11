/**
 * Opus//DECK — Phase 8: Security Audit Gate.
 * Type vocabulary + the cross-folder interfaces this phase expects.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type PatchStrategy = 'escape' | 'env-var' | 'https' | 'crypto-random'
export type RuleId = `SEC-${string}`
export type FolderId = 'audit'

export interface Rule {
  readonly id: RuleId
  readonly title: string
  readonly severity: Severity
  readonly detectors: readonly string[]
  readonly test: (line: string) => boolean
  readonly fileTest?: (fileContent: string) => boolean
  readonly patchStrategy?: PatchStrategy
  readonly locateFile?: (fileContent: string) => number[]
  readonly guidance: string
}

export interface ModelRef { readonly id: string; readonly name?: string; readonly provider?: string; readonly role?: 'leader' | 'worker' | 'auditor' }
export interface Artifact { readonly path: string; readonly code: string }

export interface Finding {
  readonly id: string
  readonly ruleId: RuleId
  readonly severity: Severity
  readonly path: string
  readonly line: number
  readonly detectorModelId: string
  readonly resolved: boolean
  readonly evidence: string
  readonly message: string
  readonly patchStrategy?: PatchStrategy
  readonly auditorCount: number
  readonly blocking: boolean
}

export type SeverityCounts = Record<Severity, number>

export interface ScanOptions {
  readonly rules?: readonly Rule[]
  readonly maxHitsPerRulePerFile?: number
  readonly excludePaths?: readonly (string | RegExp)[]
  readonly includePaths?: readonly (string | RegExp)[]
  readonly minAuditors?: number
}

export interface ScanReport {
  readonly findings: readonly Finding[]
  readonly total: number
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly auditors: readonly string[]
  readonly rulesEvaluated: number
  readonly bySeverity: SeverityCounts
  readonly byRule: Readonly<Record<string, number>>
  readonly byModel: Readonly<Record<string, number>>
  readonly byPath: Readonly<Record<string, number>>
  readonly corroborated: number
}

export type TaskPriority = 0 | 1 | 2 | 3

export interface RemediationTask {
  readonly id: string
  readonly kind: 'security-remediation'
  readonly folder: FolderId
  readonly priority: TaskPriority
  readonly round: number
  readonly findingId: string
  readonly ruleId: RuleId
  readonly severity: Severity
  readonly patchStrategy: PatchStrategy
  readonly targetPath: string
  readonly targetLine: number
  readonly evidence: string
  readonly instruction: string
  readonly suggestion: string
  readonly detectorModelId: string
  readonly createdAt: string
}

export interface EnqueueReceipt { readonly taskId: string; readonly accepted: boolean; readonly note?: string }
export interface BusTaskOutcome { readonly taskId: string; readonly ok: boolean; readonly error?: string }

export type EscalationReason = 'unresolved-after-patching' | 'no-patch-strategy' | 'task-rejected' | 'task-failed' | 'rescan-unavailable' | 'batch-unconfirmed'

export interface Escalation {
  readonly id: string
  readonly kind: 'security-escalation'
  readonly folder: FolderId
  readonly findingId: string
  readonly ruleId: RuleId
  readonly severity: Severity
  readonly path: string
  readonly line: number
  readonly detectorModelId: string
  readonly reason: EscalationReason
  readonly rounds: number
  readonly detail: string
  readonly evidence: string
  readonly createdAt: string
}

export interface Advisory {
  readonly findingId: string
  readonly ruleId: RuleId
  readonly severity: Severity
  readonly path: string
  readonly line: number
  readonly detectorModelId: string
  readonly message: string
  readonly suggestion: string
  readonly blocking: false
}

export interface TaskBus {
  enqueue(task: RemediationTask): Promise<EnqueueReceipt>
  awaitSettlement?(receipt: EnqueueReceipt): Promise<BusTaskOutcome>
}

/**
 * Phase 4 seam: the membership of one remediation batch — the blocking,
 * patchable, unresolved findings that would execute together.
 */
export interface BatchConfirmationRequest {
  readonly paths: readonly string[]
  readonly findingIds: readonly string[]
}

/** What the gate hands back once the batch is confirmed and the token burned. */
export interface BatchAuthorization {
  readonly confirmationId: string
  readonly scope: string
  readonly confirmedAt: string
  /** true when the gate minted the token itself (v1 auto-issue-and-record). */
  readonly autoIssued?: boolean
}

/**
 * Phase 4 seam: a remediation batch that spans MORE THAN ONE file executes only
 * against a consumed single-use confirmation. `authorize()` MUST throw when the
 * confirmation cannot be consumed; the loop then enqueues nothing and escalates
 * with reason `batch-unconfirmed`. Omit the gate (or keep the batch single-file)
 * and the loop behaves exactly as before — the gate is additive, not mandatory.
 */
export interface BatchConfirmationGate {
  authorize(request: BatchConfirmationRequest): BatchAuthorization
}

export interface ArtifactStore { read(path: string): Promise<Artifact> }

export interface EscalationQueue { push(entry: Escalation): Promise<void> }

export interface RemediationDeps {
  readonly bus: TaskBus
  readonly artifacts?: ArtifactStore
  readonly escalations?: EscalationQueue
  readonly now?: (() => string)
  /** Phase 4: consulted once before a multi-file batch executes. */
  readonly confirmations?: BatchConfirmationGate
}

export interface RemediationOptions {
  readonly rules?: readonly Rule[]
  readonly artifacts?: readonly Artifact[]
  readonly maxRounds?: number
  /** Phase 4: a pre-issued single-use token authorizing this batch, if any. */
  readonly confirmationToken?: string
  /**
   * Phase 3 (gate severity, R5): THE resolved `gate.failOn` threshold,
   * injected once at wiring (explicit runtime config -> STATE/config.json ->
   * "critical"). At/above the threshold a finding is blocking and may
   * escalate; below it the finding is advisory.
   */
  readonly failOn?: Severity
}

export type RescanSource = 'artifact-store' | 'snapshot' | 'none'

export interface RemediationResult {
  readonly rounds: number
  readonly tasks: readonly RemediationTask[]
  readonly accepted: number
  readonly rejected: number
  readonly resolved: readonly Finding[]
  readonly unresolved: readonly Finding[]
  readonly escalations: readonly Escalation[]
  readonly advisories: readonly Advisory[]
  readonly rescans: number
  readonly rescanSource: RescanSource
  /** Phase 4: present when the run's batch spanned >1 file and was confirmed. */
  readonly batchAuthorization?: BatchAuthorization
  /** Phase 4: the batch membership that was confirmed (or refused) this run. */
  readonly batch?: BatchConfirmationRequest
}

export const MAX_HITS_PER_RULE_PER_FILE = 3
export const DEFAULT_MIN_AUDITORS = 2
export const EVIDENCE_MAX_LENGTH = 240
export const FILE_LEVEL_EVIDENCE = '[file-level match]'
export const MAX_REMEDIATION_ROUNDS = 2
export const SECRET_MIN_LENGTH = 8

export interface RemediationAdvice { readonly instruction: string; readonly suggestion: string }
