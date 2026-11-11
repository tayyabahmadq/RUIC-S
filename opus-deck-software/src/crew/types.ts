/**
 * Opus//DECK — Phase 7: Engineering Crew Runner.
 * Shared types for the worker pool.
 */
import { z } from 'zod'

export type FolderId = 'crew'

export class CommonsError extends Error {
  readonly code: string
  readonly folder: FolderId = 'crew'
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
    }
  }
}

export interface Task {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly status?: 'pending' | 'claimed' | 'completed' | 'failed' | 'retired'
  readonly claimSet?: readonly string[]
  readonly locks?: readonly string[]
  readonly priority?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface PresenceEntry {
  readonly modelId: string
  readonly role?: string
  readonly status?: string
  readonly taskIds?: readonly string[]
  readonly claimed?: readonly string[]
  readonly lastSeen?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface WorkingSetEntry {
  readonly modelId?: string
  readonly path: string
  readonly startLine?: number
  readonly endLine?: number
  readonly range?: { readonly startLine: number; readonly endLine: number }
  readonly content?: string
  readonly pointer?: boolean
  readonly tokenCount?: number
  readonly updatedAt?: string
}

/** Write-intent wire format produced by the model and written via commons. */
export const WriteIntentSchema = z.object({
  intent: z.string(),
  path: z.string(),
  added: z.array(z.string()),
  atLine: z.number().int(),
  removedLineCount: z.number().int().nonnegative(),
})

export type WriteIntent = z.infer<typeof WriteIntentSchema>

/* ------------------------------------------------------------------ *
 * Cross-part dependency interfaces (injected via wiring).
 * ------------------------------------------------------------------ */

export type BusHandler = (...args: unknown[]) => void

export interface EventBus {
  emit(event: string, ...args: unknown[]): void
  on(event: string, handler: BusHandler): void
  once(event: string, handler: BusHandler): void
  off(event: string, handler: BusHandler): void
  publish?(event: string, ...args: unknown[]): void
  subscribe?(event: string, handler: BusHandler): void
  waitFor?(event: string, timeoutMs?: number): Promise<unknown>
}

export interface CommonsWriteArgs {
  readonly intent?: string
  readonly path: string
  readonly author: string
  readonly added?: readonly string[]
  readonly atLine?: number
  readonly removedLineCount?: number
  readonly content?: string
}

export interface CommonsClient {
  write(args: CommonsWriteArgs): unknown
  read?(path: string): unknown
}

export interface TransportClient {
  stream?(modelId: string, prompt: string, options?: { system?: string }): unknown
  complete?(modelId: string, prompt: string, options?: { system?: string }): unknown
  chat?(modelId: string, prompt: string, options?: { system?: string }): unknown
}

export interface LockClient {
  acquire?(target: string, owner: string): unknown
  acquireLocks?(targets: readonly string[], owner: string): unknown
  release?(target: string, owner: string): unknown
  releaseLocks?(targets: readonly string[], owner: string): unknown
}

export interface TaskQueue {
  claimNext?(workerId: string): Task | null | Promise<Task | null>
  claim?(workerId: string): Task | null | Promise<Task | null>
  retire?(workerId: string): unknown
  remaining?(): number
  releaseClaims?(workerId: string): unknown
}

export interface WorkingSetStore {
  record?(modelId: string, entry: WorkingSetEntry): void
  currentEntries?(modelId: string): WorkingSetEntry[]
}

export interface EngineerRef {
  readonly modelId?: string
  readonly id?: string
  readonly transport?: TransportClient
  readonly workingSet?: WorkingSetStore
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface CrewDependencies {
  readonly bus?: EventBus
  readonly commons?: CommonsClient
  readonly transport?: TransportClient
  readonly locks?: LockClient
  readonly queue?: TaskQueue
  readonly workingSet?: WorkingSetStore
  readonly promptTokenBudget?: number
  readonly consecutiveFailureLimit?: number
  /**
   * Phase 3 (personas): the engineer persona body, used as the worker's
   * system prompt. Injected per worker by the caller; when absent the crew
   * default set by wiring (`f07SetDefaultSystemPrompt`) applies; when THAT is
   * also absent the worker behaves exactly as shipped (no system prompt).
   */
  readonly systemPrompt?: string
  /**
   * R21 (E1): optional usage-accounting seam. When the stream carries
   * phase-02 `usage` chunks, each is handed to this sink verbatim (and is
   * never stringified into the write-intent text). Absent = usage chunks are
   * consumed-and-skipped: the shell's transport wrapper already records them
   * at the transport layer, so the worker never double-counts.
   */
  readonly usageSink?: (usage: StreamUsage) => void
  /**
   * Common-S: the State Contract exit-path writer. Every worker MUST write
   * its compacted result to the Brain before exiting (the "write before you
   * leave the desk" rule). Enforced at the exit path — done / blocked /
   * handed_off — so a crashing worker still leaves a resume point. Absent =
   * shipped behavior (no contract writes, e.g. legacy tests).
   */
  readonly contractWriter?: (input: {
    taskId: string
    status: 'done' | 'blocked' | 'handed_off' | 'in_progress'
    owner: string
    done?: string
    remaining?: readonly string[]
    decisions?: readonly string[]
    artifacts?: readonly string[]
  }) => Promise<void>
  /**
   * Zeak v2: the TRY BOX recorder. Every failed attempt lands here at the
   * exit path (a crash/bail IS a TRY BOX event). Returns the deterministic
   * error signature {E}. Absent = shipped behavior (no failure recording).
   */
  readonly failureRecorder?: (input: {
    taskId: string
    modelId: string
    method: string
    errorDetail: string
  }) => Promise<string | void>
  /**
   * Zeak v2: verified guide lines for THIS task (the "clean" arrow —
   * correlated failure knowledge flowing back to the working model).
   * Returns '' when nothing applies. Guide tokens are PROTECTED: the prompt
   * builder never trims them.
   */
  readonly guides?: () => Promise<string>
}

export interface CrewWorkerResult {
  readonly modelId: string
  readonly completedTaskIds: readonly string[]
  readonly failedTaskIds: readonly string[]
  readonly retired: boolean
  readonly consecutiveFailures: number
}

export interface CrewResult {
  readonly workers: readonly CrewWorkerResult[]
  readonly tasks: readonly Task[]
}

/** R21 (E1): token usage for one completion, exactly as a phase-02 `usage`
 * chunk reports it. Recorded verbatim — never synthesized. */
export interface StreamUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface BuildPromptArgs {
  readonly task: Task
  readonly brief: string
  readonly digest: string
  readonly presence: readonly PresenceEntry[]
  readonly workingSet: readonly WorkingSetEntry[]
  /** Zeak v2: verified guide lines (the "clean" arrow). PROTECTED tokens —
   * never trimmed by the budget overflow path. */
  readonly guides?: string
  /** Shared event bus (injected by wiring). Emits compaction.requested when over budget. */
  readonly bus?: EventBus
}

export interface PromptArgs {
  readonly task: Task
  readonly brief: string
  readonly digest: string
  readonly presence: readonly PresenceEntry[]
  readonly workingSet: readonly WorkingSetEntry[]
}
