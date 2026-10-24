/**
 * opus-deck — Phase 8: Security Audit Gate (public API).
 */
export { CommonsError, FOLDER_ID, isCommonsError } from './errors.js'
export {
  scanAll, scanFile, findingId, gateBlocked, summarizeFindings, groupByRule,
  worstSeverity, contributingAuditors,
} from './scan.js'
export {
  remediateFindings, buildRemediationTask, selectPatchable, toAdvisories,
  envVarName, describeRemediation, remediationTaskId, planRemediationBatch,
  MAX_REMEDIATION_ROUNDS, DEFAULT_FAIL_ON, atOrAboveFailOn,
} from './remediate.js'
export {
  RULES, RULE_IDS, SEVERITY_ORDER, SECRET_MIN_LENGTH, escapeHtml, getRule,
  hasDetector, isRuleId, rulesForAuditor, severityRank,
} from './rules.js'
export type {
  Severity, PatchStrategy, RuleId, FolderId, Rule, ModelRef, Artifact, Finding,
  SeverityCounts, ScanOptions, ScanReport, TaskPriority, RemediationTask,
  EnqueueReceipt, BusTaskOutcome, EscalationReason, EscalationQueue, Escalation,
  Advisory, RemediationDeps, RemediationOptions, RemediationResult, RescanSource,
  TaskBus, ArtifactStore, RemediationAdvice,
  BatchConfirmationGate, BatchConfirmationRequest, BatchAuthorization,
} from './types.js'
