/**
 * UsageTracker — per-model and run-wide token accounting, clean integers.
 * streamWithUsage wraps a Transport to auto-record token usage.
 */
import { Transport, TransportChunk, UsageReport, ModelUsage } from './types.js'

export class UsageTracker {
  private readonly perModel = new Map<string, ModelUsage>()
  private runWide: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }

  /** Record one usage event. Floors to clean non-negative integers. */
  record(modelId: string, tokens: { inputTokens: number; outputTokens: number }): void {
    const input = Math.floor(Math.max(0, tokens.inputTokens ?? 0))
    const output = Math.floor(Math.max(0, tokens.outputTokens ?? 0))
    const total = input + output
    let m = this.perModel.get(modelId)
    if (!m) {
      m = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }
      this.perModel.set(modelId, m)
    }
    m.inputTokens += input
    m.outputTokens += output
    m.totalTokens += total
    m.calls += 1

    this.runWide.inputTokens += input
    this.runWide.outputTokens += output
    this.runWide.totalTokens += total
    this.runWide.calls += 1
  }

  totals(): UsageReport {
    return {
      perModel: Object.fromEntries([...this.perModel.entries()]),
      runWide: { ...this.runWide },
    }
  }

  reset(): void {
    this.perModel.clear()
    this.runWide = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }
  }
}

/**
 * Wrap a Transport so each `usage` chunk is recorded automatically while
 * forwarding chunks unchanged. Records once per usage chunk.
 */
export async function* streamWithUsage(
  transport: Transport,
  req: { modelId: string; [key: string]: unknown },
  tracker: UsageTracker,
): AsyncGenerator<TransportChunk, void, undefined> {
  for await (const chunk of transport.complete(req as never)) {
    if (chunk.type === 'usage') {
      tracker.record(req.modelId, { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens })
    }
    yield chunk
  }
}
