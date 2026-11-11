/**
 * Phase 11: Audit glue (phase 8's stubbed collaborators).
 *
 * TaskBus: enqueue() holds remediation tasks in an in-memory queue for the
 * orchestration layer to consume; awaitSettlement resolves ok.
 * ArtifactStore.read(path): reads WORKSPACE/<path> bytes for re-scan.
 * EscalationQueue.push(): records escalations; onPush routes each into the
 * leader's ReviewQueue via decide() (pending decision; veto -> routed task).
 */
import * as fs from 'fs'
import * as nodePath from 'path'
import type {
  Artifact, ArtifactStore, Escalation, EscalationQueue, EnqueueReceipt,
  RemediationTask, TaskBus, BusTaskOutcome,
} from '../audit/types.js'

export interface TaskBusWithQueue {
  bus: TaskBus
  readonly queue: RemediationTask[]
}

export function createTaskBus(): TaskBusWithQueue {
  const queue: RemediationTask[] = []
  const bus: TaskBus = {
    enqueue: (task: RemediationTask): Promise<EnqueueReceipt> => {
      queue.push(task)
      return Promise.resolve({ taskId: task.id, accepted: true })
    },
    awaitSettlement: (receipt: EnqueueReceipt): Promise<BusTaskOutcome> =>
      Promise.resolve({ taskId: receipt.taskId, ok: true }),
  }
  return { bus, queue }
}

export function heldRemediationQueue(bus: TaskBus): RemediationTask[] {
  return (bus as TaskBus & { queue?: RemediationTask[] }).queue ?? []
}

export function createArtifactStore(memoryDir: string): ArtifactStore {
  const root = nodePath.resolve(memoryDir)
  return {
    read: async (artifactPath: string): Promise<Artifact> => {
      const full = nodePath.join(root, 'WORKSPACE', ...artifactPath.split('/'))
      let code: string
      try { code = await fs.promises.readFile(full, 'utf8') } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'ENOENT') throw new Error(`E_ARTIFACT_NOT_FOUND: no such artifact: ${artifactPath}`)
        throw err
      }
      return { path: artifactPath, code }
    },
  }
}

export interface EscalationQueueWithEntries {
  queue: EscalationQueue
  readonly entries: Escalation[]
}

export function createEscalationQueue(options?: {
  onPush?: (entry: Escalation) => void | Promise<void>
}): EscalationQueueWithEntries {
  const entries: Escalation[] = []
  const queue: EscalationQueue = {
    push: async (entry: Escalation): Promise<void> => {
      entries.push(entry)
      if (options?.onPush) {
        try { await options.onPush(entry) } catch { }
      }
    },
  }
  return { queue, entries }
}

export function heldEscalations(queue: EscalationQueue): Escalation[] {
  return (queue as EscalationQueue & { entries?: Escalation[] }).entries ?? []
}
