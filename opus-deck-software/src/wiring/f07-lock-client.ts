/**
 * Phase 11: Crew's LockClient adapter over coordination (authority).
 */
import { acquire, release } from '../coordination/index.js'
import type { LockClient } from '../crew/types.js'

export class F07LockClient implements LockClient {
  constructor(
    private readonly acquireFn: (modelId: string, pathSet: string[]) => 'granted' | { queuedBehind: string },
    private readonly releaseFn: (modelId: string, pathSet: string[]) => void,
  ) {}
  async acquire(target: string, owner: string): Promise<void> {
    const result = await this.acquireFn(owner, [target])
    if (result !== 'granted') throw new Error(`f07LockClient: cannot acquire ${target} for ${owner}: ${result.queuedBehind}`)
  }
  async acquireLocks(targets: readonly string[], owner: string): Promise<void> {
    const result = await this.acquireFn(owner, [...targets])
    if (result !== 'granted') throw new Error(`f07LockClient: cannot acquire locks for ${owner}: ${result.queuedBehind}`)
  }
  async release(target: string, owner: string): Promise<void> {
    this.releaseFn(owner, [target])
  }
  async releaseLocks(targets: readonly string[], owner: string): Promise<void> {
    this.releaseFn(owner, [...targets])
  }
}
