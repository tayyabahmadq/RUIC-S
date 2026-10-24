/**
 * Opus//DECK — Phase 6: The Leader.
 * Type contracts the Leader expects from its dependencies (adapted in wiring).
 */
import { z } from 'zod'

export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'leader' = 'leader'
  readonly detail?: string

  constructor(code: string, message: string, opts?: { detail?: string; cause?: unknown }) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    if (opts?.detail !== undefined) this.detail = opts.detail
    if (opts?.cause) this.cause = opts.cause
  }
}

export interface Crew { lead: string; engineers: string[] }

export interface PlanInput { brief: string; goalState: string; crew: Crew }

export interface Task {
  id: string
  path: string
  description: string
  acceptance: string[]
  /**
   * Phase 4: the single-use confirmation that authorized this task's creation
   * (`CFM-…`). Present only on tasks born of a confirmed action (today: veto
   * follow-ups). It resolves to exactly one confirmed action in the ledger.
   */
  confirmationRef?: string
}

export const TaskSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  description: z.string().min(1),
  acceptance: z.array(z.string().min(1)),
  confirmationRef: z.string().min(1).optional(),
})

export interface VerificationResult { criterion: string; satisfied: boolean; evidence: string }

export interface SignOff { checksum: string; fileCount: number; generatedAt: string }

export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }

export interface CompletionRequest { modelId: string; messages: Message[]; temperature?: number; maxTokens?: number }

export interface CompletionResponse { text: string; modelId: string; provider?: string; usage?: { inputTokens?: number; outputTokens?: number } }

export interface Transport { completion(request: CompletionRequest): Promise<CompletionResponse> }

export interface WorkspaceFile { path: string; size: number; mtime: string }

export interface Commons {
  read<T>(key: string): Promise<T | undefined>
  write(key: string, value: unknown): Promise<void>
  append(key: string, entry: unknown): Promise<void>
  listWorkspace(): Promise<WorkspaceFile[]>
  readWorkspace(path: string): Promise<string>
  writeWorkspace(path: string, content: string): Promise<void>
  /**
   * STATE/digest.md — the SAME source the worker's prompt slot 2 uses, so a
   * rebuilt CODEMAP reaches plan() through the normal digest path.
   */
  readDigest?(): string
}

export interface Claim { taskId: string; path: string; engineerId: string; at: string }

export interface Claims {
  holdersOf(path: string): Promise<string[]>
  claim(taskId: string, path: string, engineerId: string): Promise<void>
  release(taskId: string): Promise<void>
  listClaims(): Promise<Claim[]>
}

export interface Conflict {
  id: string
  path: string
  taskId: string
  heldBy: string[]
  resolution?: 'rerouted' | 'split'
  resolvedAt?: string
  detail?: string
}

export interface Conflicts {
  record(path: string, taskId: string, heldBy: string[]): Promise<string>
  list(): Promise<Conflict[]>
  resolve(id: string, resolution: 'rerouted' | 'split', detail?: string): Promise<void>
}

export interface BusEvent { id: string; type: string; payload: unknown; at: string }

export interface Bus {
  emit(type: string, payload: unknown): Promise<string>
  subscribe(type: string, handler: (payload: unknown) => void): Promise<void>
  published(): Promise<BusEvent[]>
}

export interface ReviewDecision {
  id: string
  workerId: string
  touched: string[]
  rationale: string
  status: 'pending' | 'ratified' | 'vetoed'
  createdAt: string
  resolvedAt?: string
  vetoReason?: string
  followUpTaskId?: string
  /** Phase 4: the confirmation that authorized this decision's follow-up task. */
  confirmationRef?: string
}

/** Phase 4: the scope a vetoed decision's follow-up is confirmed under. */
export const REVIEW_VETO_SCOPE = 'review.veto:follow-up'

/** Phase 4: the action label recorded for a vetoed decision's follow-up. */
export const REVIEW_VETO_ACTION = 'veto-follow-up'

export interface ConfirmationIssueResult {
  token: string
  scope: string
  confirmationId: string
  expiresAt: string
  nonce: string
}

export interface ConfirmationConsumeResult {
  confirmationId: string
  scope: string
  consumedAt: string
}

/**
 * Phase 4 seam: the confirmation service, seen structurally by the leader.
 * The leader knows nothing about how tokens are signed — only that issuing one
 * and consuming it is what authorizes a high-impact action. `wiring/confirmations.ts`
 * is the only implementation. Optional: unwired, the veto path behaves exactly
 * as it did before Phase 4.
 */
export interface ConfirmationGate {
  issue(scope: string, options?: { action?: string; subject?: string }): ConfirmationIssueResult
  consume(token: string, scope: string): ConfirmationConsumeResult
}
