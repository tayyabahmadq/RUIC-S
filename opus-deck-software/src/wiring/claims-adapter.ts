/**
 * Phase 11: Leader's Claims adapter over coordination (authority).
 *
 * Coordination owns locks as STATE/tasks.json claim rows. Leader's Claims are
 * indexed by taskId; this adapter keeps a taskId -> claim map and delegates
 * acquire/release to coordination.
 */
import { acquire, release, holdersOf } from '../coordination/index.js'
import type { Claim, Claims } from '../leader/types.js'

interface ClaimRecord { taskId: string; path: string; engineerId: string; at: string }

export class ClaimsAdapter implements Claims {
  private readonly byTask = new Map<string, ClaimRecord>()

  constructor(
    private readonly acquireFn: (modelId: string, pathSet: string[]) => 'granted' | { queuedBehind: string },
    private readonly releaseFn: (modelId: string, pathSet: string[]) => void,
    private readonly holdersFn: (path: string) => string[],
  ) {}

  async holdersOf(path: string): Promise<string[]> {
    return Promise.resolve(this.holdersFn(path))
  }

  async claim(taskId: string, path: string, engineerId: string): Promise<void> {
    const result = await this.acquireFn(engineerId, [path])
    if (result !== 'granted') {
      throw new Error(`claimsAdapter: cannot claim ${path} for ${engineerId}: queued behind ${result.queuedBehind}`)
    }
    this.byTask.set(taskId, { taskId, path, engineerId, at: new Date().toISOString() })
  }

  async release(taskId: string): Promise<void> {
    const claim = this.byTask.get(taskId)
    if (!claim) return
    await this.releaseFn(claim.engineerId, [claim.path])
    this.byTask.delete(taskId)
  }

  async listClaims(): Promise<Claim[]> {
    return [...this.byTask.values()].map((c) => ({ ...c }))
  }
}
