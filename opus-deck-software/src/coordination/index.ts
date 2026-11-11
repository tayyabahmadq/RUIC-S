/**
 * opus-deck — Phase 5: Presence, Claims & Locks (public API).
 */
export { upsert, snapshot } from './presence.js'
export { acquire, release, releaseAll, holdersOf } from './claims.js'
export { syncSince } from './sync.js'
export {
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatRunning,
  refreshHeartbeat,
  lastHeartbeatError,
} from './heartbeat.js'
export { drainQueue, queueDepth } from './conflicts.js'
export { setCommons, getCommons } from './port.js'
export { configure, resetConfig, getConfig } from './config.js'
export { resetState } from './reset.js'
export { CommonsError, COMMONS_ERROR_CODES } from './errors.js'

export type {
  ModelId,
  TaskId,
  TxnId,
  PresenceEntry,
  PresencePatch,
  AcquireResult,
  Conflict,
  ClaimRow,
  TaskRow,
  TaskRecord,
  Delta,
  DeltaKind,
  SyncResult,
  CommonsApi,
  HeartbeatOptions,
  ConfigureOptions,
  CommonsConfig,
} from './types.js'
