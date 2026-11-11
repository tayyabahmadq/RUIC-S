/**
 * Common-S Brain — public surface.
 */
export {
  SCHEMA_VERSION,
  CONTRACT_STATE_MAJOR,
  TaskStatusSchema,
  StateContractSchema,
  ContractValidationError,
  validateContract,
  makeContract,
  ContractStore,
} from './contract.js'
export type { StateContract, TaskStatus } from './contract.js'
export { VectorStore } from './vector-store.js'
export type { VectorEntry, VectorSearchHit, EmbedFn, VectorStoreOptions } from './vector-store.js'
export { atomicWriteJson, readJson } from './atomic.js'
export { Brain } from './brain.js'
export type { BrainOptions, TaskFlags } from './brain.js'
