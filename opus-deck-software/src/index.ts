/**
 * opus-deck — public API (named exports).
 * Phase 1: config & event bus.
 */
export { initOpusDeck } from './config/bootstrap.js'
export type { OpusDeckConfig, OpusDeckRuntime, ResolvedConfig, ResolvedCrew, ResolvedBudgets, ModelRef } from './config/types.js'
export { EventBusImpl } from './config/bus.js'
export { resolveOpusDeckConfig, DEFAULT_DIGEST_TOKENS, DEFAULT_PROMPT_TOKENS } from './config/index.js'
export { CommonsError as ConfigCommonsError } from './config/errors.js'
export {
  BRIEF, DECISIONS, DIGEST, PRESENCE, TASKS, FINDINGS,
  WORKSPACE, DELTA, ARCHIVE, TXN_LOG,
} from './config/paths.js'
export type { ActionConfirmedPayload, ActionRejectedPayload, ConfirmationRejectionReason, CodegraphRebuiltPayload } from './config/types.js'
export {
  createConfirmant, createRemediationBatchGate, remediationBatchScope,
  ConfirmationError, DEFAULT_CONFIRMATION_TTL_MS, MIN_CONFIRMATION_TTL_MS,
  MAX_CONFIRMATION_TTL_MS, CONFIRMATION_TOKEN_PREFIX, REMEDIATION_BATCH_ACTION,
} from './wiring/confirmations.js'
export type {
  Confirmant, ConfirmantOptions, IssuedConfirmation, ConsumptionReceipt,
  ConfirmationRecord, ConfirmationErrorCode, ConfirmationRejectionDetail,
  ConfirmationSink, IssueOptions, BatchGateOptions, RemediationBatchGate,
} from './wiring/confirmations.js'
// Phase 11: Review Agent
export { ReviewAgent, createReviewAgent } from './f11/index.js'
export { listRules, RULE_PACKS, TYPESCRIPT_PACK } from './f11/rules.js'
export type {
  ReviewAgentDeps,
  ReviewRequest,
  ReviewResult,
  ReviewBundle,
  PositionedFinding,
  ReviewDrop,
  ReviewReflection,
  ReviewCriterion,
  RulePack,
  RulePackSummary,
} from './f11/types.js'
export type { RawFinding } from './f11/position.js'
// Phase 12: CodeGraph (workspace knowledge-graph memory)
export { createCodegraph, fingerprintSourceTree } from './f12/index.js'
export { CommonsError as F12CommonsError } from './f12/errors.js'
export { classifyFileRole } from './f12/detect.js'
export { extractFromFile, extractImports, extractSymbols } from './f12/extract.js'
export { buildGraph, resolveImport } from './f12/build.js'
export { clusterGraph } from './f12/cluster.js'
export { renderCodegraphSection, renderReport } from './f12/section.js'
export type { Codegraph, CodegraphDeps } from './f12/index.js'
export type {
  CodegraphResult,
  WorkspaceGraph,
  GraphNode,
  GraphEdge,
  FileRole,
  ExtractedImport,
  ExtractedSymbol,
  FileExtraction,
  ClusterInfo,
  HubInfo,
  ClusterResult,
} from './f12/types.js'
/**
 * Phase E1 (sanctioned additive exports): the shell consumers no longer
 * deep-require dist/ internals. Exactly the three symbols approved in the
 * C1 report, plus their companion result/options types so the exports are
 * usable from the barrel alone.
 */
export { wireOpusDeck } from './wiring/index.js'
export type { WireOptions, WiredDeck } from './wiring/index.js'
export { runCrew } from './crew/index.js'
export { ModelRegistry } from './transport/index.js'

/**
 * Common-S v2 exports: the Brain (contracts + vectors + task flags), Laya
 * routing, Zeak economic layer, Dept 2 collection, and the Ollama embedder.
 */
export {
  Brain,
  SCHEMA_VERSION,
  CONTRACT_STATE_MAJOR,
  TaskStatusSchema,
  StateContractSchema,
  ContractValidationError,
  validateContract,
  makeContract,
  ContractStore,
  VectorStore,
} from './state/index.js'
export type { StateContract, TaskStatus, TaskFlags, EmbedFn, VectorEntry } from './state/index.js'
export { classify as layaClassify, route as layaRoute } from './routing/laya.js'
export type { LayaDecision, LayaInput } from './routing/laya.js'
export { zeakWrap, pruneRequest, hasCompleteUnit, reEscalationModel } from './zeak/zeak.js'
export type { ZeakBudgets, ZeakOptions } from './zeak/zeak.js'
export { collectTopic, GitHubCollector, BrowserCollector } from './depts/data-collection.js'
export type { Collector, CollectedItem, CollectionResult } from './depts/data-collection.js'
export { ollamaEmbed, ollamaChatComplete, ollamaPing } from './state/ollama.js'
