/**
 * Phase 5: CONFLICTS — denial queue ordered by task order.
 */
import { requireModelId } from './validate.js'
import type { Conflict, ModelId } from './types.js'
import { normalizePathSet } from './paths.js'

const queue: Conflict[] = []
const dedupeKey = (c: Conflict) => `${c.modelId}\u0000${c.pathSet.slice().sort().join('\u0000')}`

export function enqueueConflict(modelId: string, pathSet: string[], queuedBehind: ModelId): void {
  const entry: Conflict = { modelId, pathSet: normalizePathSet(pathSet), queuedBehind }
  if (queue.some((c) => dedupeKey(c) === dedupeKey(entry))) return
  queue.push(entry)
  queue.sort((a, b) => orderKey(a) - orderKey(b))
}

export function clearQueuedConflict(modelId: string, pathSet: string[]): void {
  const key = dedupeKey({ modelId, pathSet: normalizePathSet(pathSet), queuedBehind: '' })
  const idx = queue.findIndex((c) => dedupeKey(c) === key)
  if (idx !== -1) queue.splice(idx, 1)
}

export function drainQueue(): Conflict[] {
  const copy = queue.slice()
  queue.length = 0
  return copy
}

export function queueDepth(): number {
  return queue.length
}

export function resetConflicts(): void {
  queue.length = 0
}

function orderKey(c: Conflict): number {
  const m = /^T-(\d+)$/.exec(c.modelId)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}
