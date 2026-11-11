/**
 * opus-deck — Phase 9: Merge & Build Engine (public API).
 */
export { CommonsError } from './errors.js'
export { merge, readManifest } from './merge.js'
export { ManifestSchema } from './merge.js'
export type { MergeOptions } from './merge.js'
export {
  checkReadiness, isGatePassed, loadFindings, loadCriteria, loadVerifications,
  loadClaims, loadTransactions, sha256Hex,
  DEFAULT_GATE_SEVERITY, atOrAboveGateSeverity,
} from './verify-build.js'
export type { GateSeverity, ReadinessOptions } from './verify-build.js'
export { generateReport, writeReport, checksumForManifest } from './report.js'
export type {
  Severity, Finding, GoalCriterion, VerificationResult, ClaimRecord,
  TransactionRecord, ManifestEntry, OverrideRecord, Manifest, GateCheck,
  ReportOptions, StubSeed, StubMemoryInfo,
} from './types.js'
export { FOLDER } from './types.js'
