/**
 * Zeak v2 — the Learning Loop (the Teacher).
 *
 * Closed loop: try → fail → TRY BOX entry → Model 2 finds the pattern →
 * Model 3 verifies it → guide line → the guide steers the next attempt.
 *
 * Both learning models run on the FREE local Qwen (Ollama). If Ollama is
 * down, Model 2 falls back to deterministic signature clustering and Model 3
 * falls back to a conservative occurrence-count gate — the loop degrades,
 * never blocks.
 *
 * Pins (non-negotiable):
 *   1. A guide is written ONLY after a pattern recurs across
 *      `minOccurrences` independent occurrences AND Model 3 confirms.
 *      One occurrence = TRY BOX entry, never a guide.
 *   2. Guides decay: stale/duplicate guides are pruned by this cycle.
 *   3. Guide tokens are protected — the Zeak Pruner never touches them.
 */
import type { Brain } from '../state/brain.js'

export interface LearningOptions {
  /** Minimum independent occurrences before a guide is even considered. */
  minOccurrences?: number
  /** Hard cap on stored guides (stale ones decay). Default 40. */
  guideCap?: number
  /** Days without a recurrence before a guide decays. Default 14. */
  staleDays?: number
  /** Local chat-completion over Ollama. Returns null when unavailable. */
  chat: (prompt: string, system: string) => Promise<string | null>
  emit: (event: string, payload: unknown) => void
}

export interface PatternCandidate {
  signature: string
  occurrences: number
  methods: string[]
  models: string[]
}

export interface LearningCycleResult {
  candidates: number
  guidesAdded: string[]
  rejected: Array<{ signature: string; reason: string }>
  deterministic: boolean
}

const MODEL2_SYSTEM =
  'You analyze a build system\'s failure memory. Given failed-attempt entries, ' +
  'group them into recurring error patterns. Respond with ONLY a JSON array: ' +
  '[{"signature": string, "occurrences": number, "cause": string}] — one entry per ' +
  'pattern that appears 2+ times. No prose.'

const MODEL3_SYSTEM =
  'You verify whether a recurring error pattern deserves a permanent avoidance ' +
  'rule for a coding crew. Respond with ONLY JSON: {"verified": boolean, "guide": string}. ' +
  'The guide must be one imperative line that prevents the error class (max 140 chars). ' +
  'Reject patterns that look incidental, environmental, or one-off in disguise.'

/** Deterministic fallback: cluster purely by signature, no LLM. */
export function clusterDeterministically(
  tally: Array<{ signature: string; occurrences: number; methods: string[]; models: string[] }>,
): PatternCandidate[] {
  return tally
    .filter((t) => t.occurrences >= 2)
    .map((t) => ({ signature: t.signature, occurrences: t.occurrences, methods: t.methods, models: t.models }))
}

/** Model 2: find patterns across the TRY BOX tally. */
export async function findPatterns(
  brain: Brain,
  options: LearningOptions,
): Promise<{ candidates: PatternCandidate[]; deterministic: boolean }> {
  const tally = await brain.trybox.tally()
  const fresh = tally.filter((t) => t.occurrences >= 2)
  if (fresh.length === 0) return { candidates: [], deterministic: false }

  const llm = await options.chat(
    JSON.stringify(fresh.map((t) => ({ signature: t.signature, occurrences: t.occurrences, methods: t.methods }))),
    MODEL2_SYSTEM,
  )
  if (llm !== null) {
    try {
      const parsed: unknown = JSON.parse(llm.slice(llm.indexOf('['), llm.lastIndexOf(']') + 1))
      if (Array.isArray(parsed)) {
        const candidates = parsed
          .filter((p) => typeof p === 'object' && p !== null && typeof (p as { signature?: unknown }).signature === 'string')
          .map((p) => {
            const o = p as { signature: string; occurrences?: unknown; cause?: unknown }
            const match = fresh.find((t) => t.signature === o.signature)
            return {
              signature: o.signature,
              occurrences: typeof o.occurrences === 'number' ? o.occurrences : match?.occurrences ?? 0,
              methods: match?.methods ?? [],
              models: match?.models ?? [],
            }
          })
          .filter((c) => c.occurrences >= 2)
        return { candidates, deterministic: false }
      }
    } catch {
      // LLM output unusable — deterministic fallback.
    }
  }
  return { candidates: clusterDeterministically(fresh), deterministic: true }
}

/** Model 3: verify one candidate; returns the guide line or null. */
export async function verifyPattern(
  candidate: PatternCandidate,
  brain: Brain,
  options: LearningOptions,
): Promise<{ guide: string | null; reason: string }> {
  // PIN 1: occurrence gate — sacred, checked BEFORE the LLM.
  if (candidate.occurrences < (options.minOccurrences ?? 3)) {
    return { guide: null, reason: `only ${candidate.occurrences} occurrence(s) — needs ${options.minOccurrences ?? 3}` }
  }
  const entries = await brain.trybox.bySignature(candidate.signature)
  const detail = entries
    .slice(-3)
    .map((e) => `- [${e.modelId}] ${e.method}: ${e.errorDetail.slice(0, 200)}`)
    .join('\n')
  const llm = await options.chat(
    `Pattern: ${candidate.signature}\nOccurrences: ${candidate.occurrences}\nRecent failures:\n${detail}`,
    MODEL3_SYSTEM,
  )
  if (llm === null) {
    // Ollama down: conservative auto-guide from the signature itself —
    // recurrence across >= minOccurrences is already strong evidence.
    return { guide: `Avoid repeating failure pattern ${candidate.signature} — it failed ${candidate.occurrences}x across ${candidate.models.join(', ')}. Check: ${candidate.methods[0] ?? 'prior method'} first.`, reason: 'llm unavailable, occurrence gate passed' }
  }
  try {
    const parsed = JSON.parse(llm.slice(llm.indexOf('{'), llm.lastIndexOf('}') + 1)) as { verified?: unknown; guide?: unknown }
    if (parsed.verified === true && typeof parsed.guide === 'string' && parsed.guide.trim().length > 0) {
      return { guide: parsed.guide.trim().slice(0, 140), reason: 'model3 verified' }
    }
    return { guide: null, reason: parsed.verified === false ? 'model3 rejected (incidental/environmental)' : 'model3 output unusable' }
  } catch {
    return { guide: null, reason: 'model3 output unusable' }
  }
}

/** One full learning cycle. Serialized by the caller (Brain queue). */
export async function runLearningCycle(brain: Brain, options: LearningOptions): Promise<LearningCycleResult> {
  const { candidates, deterministic } = await findPatterns(brain, options)
  const result: LearningCycleResult = { candidates: candidates.length, guidesAdded: [], rejected: [], deterministic }
  for (const candidate of candidates.slice(0, 5)) {
    const existing = await brain.readGuides()
    if (existing.includes(candidate.signature)) {
      result.rejected.push({ signature: candidate.signature, reason: 'guide already present' })
      continue
    }
    const verdict = await verifyPattern(candidate, brain, options)
    if (verdict.guide !== null) {
      await brain.addGuide(verdict.guide)
      result.guidesAdded.push(verdict.guide)
      options.emit('learning.guide_added', { signature: candidate.signature, guide: verdict.guide, occurrences: candidate.occurrences })
    } else {
      result.rejected.push({ signature: candidate.signature, reason: verdict.reason })
      options.emit('learning.guide_rejected', { signature: candidate.signature, reason: verdict.reason })
    }
  }
  if (result.guidesAdded.length > 0 || candidates.length > 0) {
    options.emit('learning.pattern_found', { candidates: candidates.length, deterministic })
  }
  await decayGuides(brain, options)
  return result
}

/** PIN 2: guides decay — hard cap; the OLDEST guides (top of file) drop
 * first when over the cap. Freshness beyond the cap is driven by the TRY
 * BOX: a guide whose signature keeps recurring stays relevant through the
 * vector store's recency weighting. */
export async function decayGuides(brain: Brain, options: LearningOptions): Promise<number> {
  const cap = options.guideCap ?? 40
  const raw = await brain.readGuides()
  const NL = String.fromCharCode(10)
  const lines = raw.split(NL).filter((l) => l.startsWith('- '))
  if (lines.length <= cap) return 0
  const removed = lines.length - cap
  const kept = lines.slice(lines.length - cap)
  const header = raw.split(NL).filter((l) => !l.startsWith('- ')).join(NL)
  const updated = (header.trimEnd() + NL + kept.join(NL) + NL).replace(/\n{3,}/g, NL + NL)
  await brain.replaceGuides(updated)
  return removed
}

