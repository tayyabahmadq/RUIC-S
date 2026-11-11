/**
 * Common-S — Laya, the fast routing layer (Dept 1).
 *
 * A deterministic code router: no model, no cost, lowest latency. It reads
 * Brain state, scores the instruction's complexity, and routes:
 *   trivial -> the local executor runs end-to-end (free)
 *   heavy   -> Dept 4 (Linking & Allocation) decomposes first
 *
 * Routing is conservative: anything that looks architectural, multi-file, or
 * carries unresolved handoffs goes heavy. Emitting the decision is the
 * caller's job (the wiring layer emits laya.routed on the hub).
 */
import type { Brain } from '../state/brain.js'

export interface LayaInput {
  brief: string
  goalState: readonly string[]
  crewSize?: number
}

export interface LayaDecision {
  decision: 'local' | 'decompose'
  score: number
  reasons: string[]
}

/** Heuristic weights — tuned so routine edits never reach paid APIs. */
const HEAVY_MARKERS = [
  'architecture', 'refactor', 'migrate', 'redesign', 'distributed', 'protocol',
  'database', 'schema', 'security', 'encrypt', 'auth', 'infra', 'deploy',
  'pipeline', 'framework', 'multi-service', 'monorepo',
] as const

const TRIVIAL_MARKERS = [
  'typo', 'rename', 'comment', 'log', 'print', 'fix small', 'css', 'style',
  'text', 'string', 'label', 'readme', 'trivial', 'small',
] as const

/** Score >= 4 routes to decomposition; below runs fully local. */
const DECOMPOSE_THRESHOLD = 4

export function classify(input: LayaInput, brainState: {
  openHandoffs: number
  digestTokens: number
}): LayaDecision {
  const brief = input.brief.toLowerCase()
  const reasons: string[] = []
  let score = 0

  // Size heuristics.
  const words = input.brief.split(/\s+/).filter(Boolean).length
  if (words > 120) { score += 2; reasons.push(`brief is long (${words} words)`) }
  else if (words > 60) { score += 1; reasons.push(`brief is medium (${words} words)`) }

  if (input.goalState.length > 3) { score += 1; reasons.push(`${input.goalState.length} goal criteria`) }

  // Marker heuristics.
  const heavyHits = HEAVY_MARKERS.filter((m) => brief.includes(m))
  if (heavyHits.length > 0) { score += Math.min(3, heavyHits.length); reasons.push(`heavy markers: ${heavyHits.join(', ')}`) }
  const trivialHits = TRIVIAL_MARKERS.filter((m) => brief.includes(m))
  if (trivialHits.length > 0 && heavyHits.length === 0) { score -= 1; reasons.push(`trivial markers: ${trivialHits.join(', ')}`) }

  // Brain state: unresolved handoffs mean the goal already needs orchestration —
  // work changes hands through Dept 4, never silently. Any open handoff forces
  // decomposition decisively (the remaining items must be re-queued).
  if (brainState.openHandoffs > 0) { score = DECOMPOSE_THRESHOLD; reasons.push(`${brainState.openHandoffs} open handoff(s) in Brain -> Dept 4 re-queue`) }
  if (brainState.digestTokens > 8000) { score += 1; reasons.push('Brain digest is large') }

  const decision = score >= DECOMPOSE_THRESHOLD ? 'decompose' : 'local'
  reasons.push(`score ${score} vs threshold ${DECOMPOSE_THRESHOLD} -> ${decision}`)
  return { decision, score, reasons }
}

/** Ask Laya. `brain` supplies open-handoff state; digest size is approximated
 * from the digest file length when available via the reader callback. */
export async function route(input: LayaInput, brain: Brain, digestTokens: number): Promise<LayaDecision> {
  const handoffs = await brain.contracts.listByStatus('handed_off', 'blocked')
  return classify(input, { openHandoffs: handoffs.length, digestTokens })
}
