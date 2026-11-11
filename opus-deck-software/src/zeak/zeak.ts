/**
 * Common-S — Zeak, the economic layer (Tier 4).
 *
 * A Transport decorator on the single seam every phase uses. Four gates, in
 * order, before any paid model call:
 *
 *   1. Cache-Gate   — Brain vector lookup first; a strong hit short-circuits
 *                     the call (served knowledge, zero cost).
 *   2. Pruner       — strips redundancy from the payload.
 *   3. Capper       — hard per-department token/budget caps. Over-cap falls
 *                     back to the free local model, LOUDLY:
 *                       - emits zeak.fallback { taskId, from, to, reason }
 *                       - flags zeakFallback in the Brain task state so
 *                         Security rejection can re-escalate (once).
 *   4. Early-Stopper — kills generation ONLY when the last complete unit
 *                     passed checks AND the sub-task contract is satisfied;
 *                     never mid-structure (pinned rule).
 */
import type { Brain } from '../state/brain.js'
import type { Transport, CompletionRequest, TransportChunk } from '../transport/types.js'

export interface ZeakBudgets {
  /** Per-department token caps for the run. */
  departments: Record<string, number>
  /** Separate escalation budget: one-shot Security re-escalations. */
  escalations: number
}

export interface ZeakEvents {
  emit(event: string, payload: unknown): void
}

export interface ZeakOptions {
  budgets: ZeakBudgets
  brain: Brain
  events: ZeakEvents
  /** The free local fallback model id in the registry. */
  fallbackModelId: string
  /** Cache-gate similarity threshold (conservative by default). */
  cacheThreshold?: number
  /** When set, early-stop evaluates this predicate on each chunk boundary. */
  earlyStop?: (chunksSoFar: TransportChunk[]) => boolean
  /**
   * Zeak v2 predictive stop: evaluated (throttled) once a taskId is known.
   * Returns {signature, guide} when the accumulating output is heading
   * toward a method the TRY BOX says already failed — the fused v1+v2
   * trigger: stop on success OR on a known failure, whichever comes first.
   */
  predictive?: (partial: string, taskId: string | null) => Promise<{ signature: string; guide: string } | null>
}

interface SpendState {
  departments: Record<string, number>
  escalationsUsed: number
}

const UNIT_CHUNK = 'text' as const

/** Estimate tokens from a chunk payload (chars/4 heuristic). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Wrap a paid transport with Zeak's gates. `departmentFor` maps a request to
 * its department key (for caps); `taskIdFor` ties the call to Brain state.
 */
export function zeakWrap(
  paid: Transport,
  options: ZeakOptions,
  departmentFor: (req: CompletionRequest) => string = () => 'engineering',
  taskIdFor: (req: CompletionRequest) => string | null = () => null,
): Transport {
  const spend: SpendState = { departments: {}, escalationsUsed: 0 }
  const threshold = options.cacheThreshold ?? 0.9

  async function underCap(req: CompletionRequest): Promise<boolean> {
    const dept = departmentFor(req)
    const cap = options.budgets.departments[dept]
    if (cap === undefined) return true
    const projected = estimateTokens(JSON.stringify(req.messages ?? [])) + (spend.departments[dept] ?? 0)
    return projected <= cap
  }

  return {
    async *complete(req: CompletionRequest): AsyncGenerator<TransportChunk, void, undefined> {
      // --- 1. Cache-Gate: Brain lookup before any external call. ------------
      const taskId = taskIdFor(req)
      const promptText = (req.messages ?? []).map((m) => m.content).join('\n')
      if (options.brain.hasEmbedder && promptText.trim().length > 0) {
        try {
          const hits = await options.brain.recall(promptText, threshold)
          if (hits !== null && hits.length > 0) {
            options.events.emit('zeak.cache_hit', { taskId, score: hits[0].score, source: hits[0].entry.source })
            yield { type: 'text', text: hits[0].entry.text }
            yield { type: 'done', finishReason: 'cache_hit' }
            return
          }
          options.events.emit('zeak.cache_miss', { taskId })
        } catch {
          // Embedding failure must never block the call — proceed ungated.
        }
      }

      // --- 2+3. Prune + Cap -------------------------------------------------
      const pruned = pruneRequest(req)
      if (!(await underCap(pruned))) {
        const dept = departmentFor(pruned)
        const from = pruned.modelId
        if (taskId !== null) {
          const flags = await options.brain.getTaskFlags(taskId)
          await options.brain.setTaskFlags(taskId, {
            zeakFallback: true,
            fallbackReason: 'cap_exceeded',
            fallbackModel: options.fallbackModelId,
            escalations: flags.escalations ?? 0,
          })
        }
        options.events.emit('zeak.fallback', {
          taskId, from, to: options.fallbackModelId, reason: 'cap_exceeded', department: dept,
        })
        // Fall through: the caller's registry resolves the fallback id.
        const fallbackReq: CompletionRequest = { ...pruned, modelId: options.fallbackModelId }
        yield* paid.complete(fallbackReq)
        return
      }

      // --- Paid call with spend accounting + Early-Stop supervision --------
      const dept = departmentFor(pruned)
      const chunks: TransportChunk[] = []
      let stopped = false
      let accumulated = ''
      for await (const chunk of paid.complete(pruned)) {
        chunks.push(chunk)
        if (chunk.type === UNIT_CHUNK && typeof chunk.text === 'string') {
          spend.departments[dept] = (spend.departments[dept] ?? 0) + estimateTokens(chunk.text)
          accumulated += chunk.text
        }
        if (
          !stopped && options.earlyStop !== undefined && chunks.length > 0 &&
          hasCompleteUnit(chunks) && options.earlyStop(chunks)
        ) {
          stopped = true
          options.events.emit('zeak.early_stop', { taskId, department: dept, chunks: chunks.length })
          break
        }
        // Zeak v2 predictive stop (throttled): heading toward a known-failed
        // method? Abort and surface the verified guide instead.
        if (
          !stopped && options.predictive !== undefined && taskId !== null &&
          chunks.length % 8 === 0 && accumulated.length > 0
        ) {
          try {
            const hit = await options.predictive(accumulated, taskId)
            if (hit !== null) {
              stopped = true
              options.events.emit('zeak.predictive_stop', { taskId, signature: hit.signature, guide: hit.guide })
              yield { type: 'text', text: `
[zeak] stopped: this approach already failed (${hit.signature}). Verified guide: ${hit.guide}` }
              yield { type: 'done', finishReason: 'predictive_stop' }
              return
            }
          } catch {
            // predictive lookup must never break the stream
          }
        }
      }
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * Prune: drop redundant fields from the request payload. Conservative —
 * it never touches message content, only structural redundancy.
 */
export function pruneRequest(req: CompletionRequest): CompletionRequest {
  const out: CompletionRequest = { ...req }
  // Trim whitespace-only trailing messages.
  if (Array.isArray(out.messages)) {
    const messages = [...out.messages]
    while (messages.length > 1 && typeof messages[messages.length - 1]?.content === 'string' &&
      (messages[messages.length - 1] as { content: string }).content.trim() === '') {
      messages.pop()
    }
    out.messages = messages
  }
  return out
}

/**
 * A "complete unit" heuristic: the stream has produced at least one complete
 * structural unit when a text chunk ends with a sentence terminator AND a
 * subsequent chunk boundary exists. Early-Stop never fires mid-structure.
 */
export function hasCompleteUnit(chunks: readonly TransportChunk[]): boolean {
  const lastText = [...chunks].reverse().find((c) => c.type === UNIT_CHUNK)
  if (lastText === undefined || typeof lastText.text !== 'string') return false
  const t = lastText.text.trimEnd()
  return t.endsWith('.') || t.endsWith('}') || t.endsWith('```') || t.endsWith('\n')
}

/**
 * The Security-driven re-escalation rule: a zeakFallback task rejected by
 * Security re-escalates to the frontier model exactly once, on its own
 * budget. Returns the model id to use, or null when the budget is spent.
 */
export async function reEscalationModel(
  brain: Brain,
  taskId: string,
  frontierModelId: string,
  budgets: ZeakBudgets,
  events: ZeakEvents,
  spend: SpendState,
): Promise<string | null> {
  const flags = await brain.getTaskFlags(taskId)
  if (flags.zeakFallback !== true) return null
  const used = flags.escalations ?? 0
  if (used >= budgets.escalations) {
    events.emit('zeak.escalation_denied', { taskId, used })
    return null
  }
  await brain.setTaskFlags(taskId, { zeakFallback: true, escalations: used + 1 })
  events.emit('zeak.escalation', { taskId, to: frontierModelId, attempt: used + 1 })
  return frontierModelId
}

/** Fresh spend state for a run (call per run, not per process). */
export function newSpend(): SpendState {
  return { departments: {}, escalationsUsed: 0 }
}
