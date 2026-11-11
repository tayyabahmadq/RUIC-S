/**
 * Opus//DECK — Phase 5: Presence, Claims & Locks.
 * Type contract. Everything needed from the outside world is declared here
 * (`CommonsApi`). Nothing imports another phase; the real COMMONS is wired in
 * through `setCommons()`.
 */
import { z } from 'zod'

/** Stable id of an orchestrator worker, e.g. `"lead"`, `"eng-3"`, `"sec-1"`. */
export type ModelId = string

/** Task id as written in STATE/tasks.json, e.g. `"T-03"`. */
export type TaskId = string

/** Monotonic transaction id of the COMMONS delta log. Integer, starts at 0. */
export type TxnId = number

/* ------------------------------------------------------------------ *
 * Presence — one table (STATE/presence.json) = awareness.
 * ------------------------------------------------------------------ */

/** One row of the presence table. `lastSyncAt` is the heartbeat timestamp (ms). */
export interface PresenceEntry {
  modelId: ModelId
  taskId?: string
  file?: string
  lastSyncAt: number
}

/** Patch accepted by `upsert()`. */
export interface PresencePatch {
  taskId?: string
  file?: string
  lastSyncAt: number
}

/* ------------------------------------------------------------------ *
 * Claims — file-level locks stored as rows in STATE/tasks.json.
 * ------------------------------------------------------------------ */

/** `'granted'`, or the model the requester queued behind. */
export type AcquireResult = 'granted' | { queuedBehind: ModelId }

/** A denied `acquire()` request parked for the leader to drain. */
export interface Conflict {
  modelId: ModelId
  pathSet: string[]
  queuedBehind: ModelId
}

/** A lock row. folder-05 is the only writer of `kind: 'claim'` rows. */
export interface ClaimRow {
  kind: 'claim'
  claimId: string
  modelId: ModelId
  path: string
  taskId?: string
  createdAt: number
}

/** Any non-claim row of STATE/tasks.json (foreign, never mutated). */
export interface TaskRow {
  kind?: 'task'
  taskId?: string
  order?: number
  assignee?: string
  status?: string
  title?: string
  [key: string]: unknown
}

/** Every row of STATE/tasks.json. */
export type TaskRecord = TaskRow | ClaimRow

/* ------------------------------------------------------------------ *
 * Sync — what a heads-down model sees when it comes back.
 * ------------------------------------------------------------------ */

/** One change from the COMMONS delta log. */
export interface Delta {
  txnId: TxnId
  kind: string
  path?: string
  taskId?: TaskId
  modelId?: ModelId
  value?: unknown
  at?: number
}

export type DeltaKind = 'digest' | 'presence' | 'task' | 'claim' | 'file' | 'note'

/** Result of `CommonsApi.sync()`. */
export interface SyncResult {
  head: TxnId
  deltas: Delta[]
}

/* ------------------------------------------------------------------ *
 * The interface this phase expects from the COMMONS core.
 * ------------------------------------------------------------------ */

export interface CommonsApi {
  sync(): SyncResult
  readTasks(): TaskRecord[]
  writeTasks(rows: TaskRecord[]): void
  readPresence(): PresenceEntry[]
  writePresence(entries: PresenceEntry[]): void
  readDigest(): string
}

export interface HeartbeatOptions { intervalMs?: number }

export interface ConfigureOptions { stalenessMs?: number; heartbeatIntervalMs?: number }

export interface CommonsConfig { stalenessMs: number; heartbeatIntervalMs: number }

export const ENV_STALENESS_MS = 'COMMONS_PRESENCE_STALENESS_MS'
export const ENV_HEARTBEAT_MS = 'COMMONS_HEARTBEAT_INTERVAL_MS'

export const DEFAULT_STALENESS_MS = 120000
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000

const presenceEntrySchema = z.object({
  modelId: z.string().min(1),
  taskId: z.string().optional(),
  file: z.string().optional(),
  lastSyncAt: z.number().min(0),
})

const claimRowSchema = z.object({
  kind: z.literal('claim'),
  claimId: z.string().min(1),
  modelId: z.string().min(1),
  path: z.string().min(1),
  taskId: z.string().optional(),
  createdAt: z.number().min(0),
})

export { presenceEntrySchema, claimRowSchema }
