/**
 * opus-deck — Phase 4: The Compactor (public API).
 */
export { CommonsError } from './errors.js'
export {
  COMPACTOR_SYSTEM_PROMPT,
  SECTION_NAMES,
  Compactor,
  chunkDigest,
  estimateTokens,
  extractPins,
  parseSections,
  rangeTokens,
  reduceWorkingSet,
} from './compactor.js'
export type { SectionName } from './types.js'
export type {
  Commons,
  CompactionResult,
  CompactorOptions,
  EventBus,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  RangePointer,
  ReadRange,
  Transport,
  WorkingSetReduction,
} from './types.js'
