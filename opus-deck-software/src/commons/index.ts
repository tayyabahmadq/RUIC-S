/**
 * opus-deck — Phase 3: Commons Core (public API).
 */
export { openCommons, setClaimsAuthority, COMMONS_PATHS } from './commons.js'
export type { CommonsPaths } from './types.js'
export { CommonsError, ERROR_CODES } from './types.js'
export type { CommonsErrorCode } from './types.js'
export type {
  Commons,
  Delta,
  DecisionEntry,
  DecisionId,
  DecisionRequest,
  Diff,
  PresenceEntry,
  PresenceStatus,
  ReadRange,
  SearchHit,
  TxnId,
  TxnStatus,
  WriteRequest,
} from './types.js'
