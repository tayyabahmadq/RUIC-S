/**
 * Opus//DECK — Phase 11: Review Agent (f11).
 * Shared types for the precision diff-review agent.
 */

import type { TransportChunk } from '../transport/types.js'

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low'
export type PatchStrategy = 'escape' | 'env-var' | 'https' | 'crypto-random'
export type Disposition = 'anchored' | 'unanchored'
export type ReflectionVerdict = 'confirmed' | 'denied'
export type DropReason = 'unanchored' | 'denied'

/** One review criterion derived from a rule pack. */
export interface ReviewCriterion {
  readonly id: string                    // e.g. 'SEC-001' or 'REVIEW-001'
  readonly severity: ReviewSeverity
  readonly promptHint: string            // what the LLM should look for
  readonly ruleSource: 'f08' | 'f11'     // where the rule originated
}

/** One bundle of files sent to the review LLM in a single call. */
export interface ReviewBundle {
  readonly id: string                    // e.g. 'BND-000001'
  readonly files: string[]               // WORKSPACE-relative paths
  readonly tokenEstimate: number
  readonly criteria: ReviewCriterion[]
}

/** Input to review(). */
export interface ReviewRequest {
  readonly runId: string
  readonly brief: string
  readonly goalState: string[]
  readonly memoryDir: string
  readonly files?: string[]              // explicit files; if absent, collect from WORKSPACE
  readonly criteria?: ReviewCriterion[]  // criteria override
}

/** A finding re-anchored to an exact line via content match. */
export interface PositionedFinding {
  readonly id: string
  readonly ruleId: string
  readonly severity: ReviewSeverity
  readonly path: string
  readonly line: number                  // 1-based, anchored
  readonly evidence: string              // collapsed line text
  readonly message: string
  readonly patchStrategy?: PatchStrategy
  readonly blocking: boolean             // critical or high
  readonly disposition: Disposition      // 'anchored' | 'unanchored'
  readonly reflection?: ReflectionVerdict
}

/** A finding dropped during positioning or reflection. */
export interface ReviewDrop {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly ruleId: string
  readonly reason: DropReason            // 'unanchored' | 'denied'
}

/** Reflection verdict for one finding. */
export interface ReviewReflection {
  readonly findingId: string
  readonly verdict: ReflectionVerdict
}

/** Result of review(). */
export interface ReviewResult {
  readonly runId: string
  readonly requests: number              // number of LLM calls made
  readonly bundles: ReviewBundle[]
  readonly findings: PositionedFinding[] // surviving findings (anchored + confirmed)
  readonly dropped: ReviewDrop[]         // dropped with reason
  readonly reflections: ReviewReflection[]
}

/** Findings persisted to STATE/findings.json (shared with f08/f09 via wiring). */
export interface PersistedFinding {
  readonly id: string
  readonly ruleId: string
  readonly severity: ReviewSeverity
  readonly path: string
  readonly line?: number
  readonly detector: string  // the REVIEWER MODEL's id that produced the finding
                             // (adapted to the canonical f08 `detectorModelId` in wiring)
  readonly evidence: string
  readonly message: string
  readonly patchStrategy?: PatchStrategy
  readonly blocking: boolean
  readonly resolved: boolean
}

/** One rule pack as data: globs → criteria. */
export interface RulePack {
  readonly id: string
  readonly language: string
  readonly globs: string[]
  readonly criteria: ReviewCriterion[]
}

export interface RulePackSummary {
  readonly id: string
  readonly language: string
  readonly globs: string[]
  readonly criteriaCount: number
}

/** Dependencies injected by the wiring layer (composition root). */
export interface ReviewAgentDeps {
  readonly hub: { emit(event: string, payload: unknown): void }
  readonly commons: {
    read(path: string): Promise<string>
    write(args: any): Promise<any>
  }
  readonly transport: {
    complete(req: any): AsyncIterable<TransportChunk>
  }
  readonly estimateTokens: (text: string) => number
  readonly holdersOf?: (path: string) => Promise<string[]>
  readonly persistFindings: (findings: readonly PersistedFinding[]) => Promise<void>
  readonly escalationQueue: { push(entry: any): Promise<void> }
  readonly auditorModelIds: readonly string[]
  readonly reviewModelId: string
  /**
   * Phase 3 (personas): the `reviewer` persona body, used as the system prompt
   * of every review/reflect LLM call. Absent = the shipped built-in prompt.
   */
  readonly reviewerSystemPrompt?: string
}
