/**
 * Phase 7: Per-model LRU working set (cap 12 entries). Consumed by the
 * compactor for slot-5 trimming.
 */
import type { WorkingSetEntry } from './types.js'

export class WorkingSetLru {
  private readonly entries = new Map<string, WorkingSetEntry[]>()
  readonly capacity: number

  constructor(capacity: number = 12) {
    this.capacity = capacity
  }

  record(modelId: string, entry: WorkingSetEntry): void {
    const list = (this.entries.get(modelId) ?? []).filter((e) => e.path !== entry.path)
    list.unshift({ ...entry, modelId: entry.modelId ?? modelId })
    if (list.length > this.capacity) list.length = this.capacity
    this.entries.set(modelId, list)
  }

  recordRange(modelId: string, path: string, startLine: number, endLine: number, content?: string): void {
    this.record(modelId, { modelId, path, startLine, endLine, content, updatedAt: new Date().toISOString() })
  }

  currentEntries(modelId: string): WorkingSetEntry[] {
    return [...(this.entries.get(modelId) ?? [])]
  }

  size(modelId: string): number {
    return this.entries.get(modelId)?.length ?? 0
  }

  clear(modelId?: string): void {
    if (modelId) this.entries.delete(modelId)
    else this.entries.clear()
  }
}

export const defaultWorkingSetLru = new WorkingSetLru(12)

export function getWorkingSetLru(): WorkingSetLru {
  return defaultWorkingSetLru
}

export function recordRead(modelId: string, entry: WorkingSetEntry): void {
  defaultWorkingSetLru.record(modelId, entry)
}

export function recordReadRange(modelId: string, path: string, startLine: number, endLine: number, content?: string): void {
  defaultWorkingSetLru.recordRange(modelId, path, startLine, endLine, content)
}

export function currentEntries(modelId: string): WorkingSetEntry[] {
  return defaultWorkingSetLru.currentEntries(modelId)
}
