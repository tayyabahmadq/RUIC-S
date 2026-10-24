/**
 * Phase 10: graceful Ctrl-C abort.
 */
import { EventBus } from './types.js'
import { CommonsError } from './types.js'

let aborted = false

export function registerAbort(bus: EventBus, runId: string, releaseLocks: () => Promise<void>): void {
  if (aborted) return
  aborted = true
  const handler = async () => {
    aborted = true
    try { await releaseLocks() } catch { }
    bus.emit('run.failed', { runId, reason: 'aborted' })
    process.exitCode = 1
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
}

export function isAborted(): boolean {
  return aborted
}
