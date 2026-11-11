/**
 * opus-deck — Phase 6: The Leader (public API).
 */
export { CommonsError } from './types.js'
export type {
  Bus, BusEvent, Claim, Claims, CompletionRequest, CompletionResponse, Commons,
  Conflicts, Conflict, Crew, Message, PlanInput, ReviewDecision, SignOff, Task,
  Transport, VerificationResult, WorkspaceFile,
  ConfirmationGate, ConfirmationIssueResult, ConfirmationConsumeResult,
} from './types.js'
export { TaskSchema, REVIEW_VETO_SCOPE, REVIEW_VETO_ACTION } from './types.js'
export { Leader } from './leader.js'
export { ReviewQueue } from './review.js'
