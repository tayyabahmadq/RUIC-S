/**
 * Phase 11: Leader's Conflicts adapter (in-memory).
 */
import type { Conflict, Conflicts } from '../leader/types.js'

export class ConflictsAdapter implements Conflicts {
  private readonly byId = new Map<string, Conflict>()
  private counter = 0

  async record(path: string, taskId: string, heldBy: string[]): Promise<string> {
    const id = `C-${String(++this.counter).padStart(2, '0')}`
    const conflict: Conflict = { id, path, taskId, heldBy: [...heldBy] }
    this.byId.set(id, conflict)
    return id
  }

  async list(): Promise<Conflict[]> {
    return [...this.byId.values()].map((c) => ({ ...c }))
  }

  async resolve(id: string, resolution: 'rerouted' | 'split' | 'requeued', detail?: string): Promise<void> {
    const conflict = this.byId.get(id)
    if (!conflict) throw new Error(`conflictsAdapter: unknown conflict ${id}`)
    conflict.resolution = resolution
    conflict.resolvedAt = new Date().toISOString()
    conflict.detail = detail
    this.byId.set(id, conflict)
  }
}
