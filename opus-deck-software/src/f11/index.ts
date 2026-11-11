/**
 * opus-deck — Phase 11: Review Agent (public API).
 */
import type {
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
} from './types.js'
import type { RawFinding } from './position.js'
import { ReviewAgent } from './review-agent.js'
import { bundleFiles, assertCoverage } from './bundle.js'
import { listRules, RULE_PACKS, TYPESCRIPT_PACK } from './rules.js'

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
  PersistedFinding,
} from './types.js'
export type { RawFinding } from './position.js'
export { ReviewAgent } from './review-agent.js'
export { listRules, RULE_PACKS, TYPESCRIPT_PACK } from './rules.js'

export function createReviewAgent(deps: ReviewAgentDeps) {
  const agent = new ReviewAgent(deps)
  return {
    review: (request: ReviewRequest) => agent.review(request),
    listRules: () => listRules(),
  }
}
