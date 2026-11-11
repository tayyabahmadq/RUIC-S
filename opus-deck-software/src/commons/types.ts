/**
 * Opus//DECK — Phase 3: Commons Core (shared memory).
 * Public types for the six-operation memory API.
 */

/** Transaction id, format `txn-%06d` (e.g. "txn-000001"). */
export type TxnId = string

/** Decision id, format `dec-%06d` (e.g. "dec-000001"). */
export type DecisionId = string

/** Whether a transaction's diff was applied or queued as blocked. */
export type TxnStatus = 'applied' | 'blocked'

/** Lifecycle status of a model in the presence table. */
export type PresenceStatus = 'active' | 'idle' | 'gone'

/**
 * A line-oriented diff against a file inside the memory directory.
 * `atLine` is 1-based: removal starts at that line, and the `added`
 * lines are inserted before the original line at `atLine`.
 * `atLine` may be `lineCount + 1` to append at end of file.
 * Every entry of `added` must be a single line (no "\n" / "\r").
 */
export interface Diff {
  added: string[]
  removedLineCount: number
  atLine: number
}

/** Arguments for Commons.write(). */
export interface WriteRequest {
  /** Target path, relative to the memory directory (e.g. "WORKSPACE/src/a.ts"). */
  path: string
  diff: Diff
  /** One-line human summary of what this write accomplishes (mandatory). */
  intent: string
  /** Author model id; must match the claim holder to write a claimed path. */
  author: string
  /** Optional paths this author claims (owns) once the write is applied. */
  claims?: string[]
}

/** One entry of DELTA/txn.jsonl — returned verbatim by sync(). */
export interface Delta {
  txn: TxnId
  ts: string
  path: string
  intent: string
  author: string
  status: TxnStatus
  diff: Diff
  claims?: string[]
}

/** Arguments for Commons.decide(). */
export interface DecisionRequest { summary: string; rationale: string; author: string }

/** One entry of DECISIONS.log. */
export interface DecisionEntry {
  id: DecisionId
  ts: string
  summary: string
  rationale: string
  author: string
}

/** 1-based inclusive line range for Commons.read(). */
export interface ReadRange { fromLine: number; toLine: number }

/** One row of the presence table. */
export interface PresenceEntry {
  model: string
  role: string
  since: string
  lastSeen: string
  status: PresenceStatus
}

/** One hit returned by Commons.search(). */
export interface SearchHit {
  path: string
  line: number
  snippet: string
}

/** The whole memory API — exactly six operations. */
export interface Commons {
  read(path: string, range?: ReadRange): Promise<string>
  write(args: WriteRequest): Promise<TxnId>
  decide(args: DecisionRequest): Promise<DecisionId>
  sync(since?: TxnId): Promise<Delta[]>
  who(): Promise<PresenceEntry[]>
  search(query: string): Promise<SearchHit[]>
}

export type CommonsPaths = {
  BRIEF: string
  DECISIONS: string
  DIGEST: string
  PRESENCE: string
  TASKS: string
  FINDINGS: string
  WORKSPACE: string
  DELTA: string
  ARCHIVE: string
  TXN_LOG: string
}

/** Machine-readable error codes thrown by this folder. */
export const ERROR_CODES = {  OPEN_INVALID_DIR: 'COMMONS_OPEN_INVALID_DIR',
  PATH_EMPTY: 'COMMONS_PATH_EMPTY',
  PATH_ESCAPE: 'COMMONS_PATH_ESCAPE',
  READ_NOT_FOUND: 'COMMONS_READ_NOT_FOUND',
  READ_NOT_A_FILE: 'COMMONS_READ_NOT_A_FILE',
  TARGET_IS_DIRECTORY: 'COMMONS_TARGET_IS_DIRECTORY',
  READ_RANGE_INVALID: 'COMMONS_READ_RANGE_INVALID',
  WRITE_INVALID: 'COMMONS_WRITE_INVALID',
  DIFF_OUT_OF_RANGE: 'COMMONS_DIFF_OUT_OF_RANGE',
  TXN_APPLY_FAILED: 'COMMONS_TXN_APPLY_FAILED',
  DECIDE_INVALID: 'COMMONS_DECIDE_INVALID',
  SYNC_UNKNOWN_SINCE: 'COMMONS_SYNC_UNKNOWN_SINCE',
  PRESENCE_CORRUPT: 'COMMONS_PRESENCE_CORRUPT',
} as const

export type CommonsErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Every failure thrown by this phase is a CommonsError. */
export class CommonsError extends Error {
  readonly code: CommonsErrorCode
  readonly folder = 'commons' as const
  readonly detail?: string

  constructor(code: CommonsErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}
