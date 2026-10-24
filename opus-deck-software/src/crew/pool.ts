/**
 * Phase 7: Run N engineering workers over one shared task queue.
 */
import {
  type CrewDependencies,
  type CrewResult,
  type CrewWorkerResult,
  type EngineerRef,
  type Task,
  type TaskQueue,
} from './types.js'
import { EngineerWorker } from './worker.js'

export interface RunCrewOptions {
  readonly dependencies?: CrewDependencies
  readonly concurrency?: number
}

function asCallable(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : undefined
}

export async function runCrew(
  engineerRefs: readonly (string | EngineerRef)[],
  tasks: readonly Task[],
  optionsOrDependencies?: CrewDependencies | RunCrewOptions,
): Promise<CrewResult> {
  const options = normalizeOptions(optionsOrDependencies)
  const dependencies = options.dependencies ?? {}
  const refs = [...engineerRefs]

  const queue = dependencies.queue ?? new InMemoryTaskQueue(tasks)
  const sharedDependencies: CrewDependencies = { ...dependencies, queue }

  const workers = refs.map((ref) => new EngineerWorker(ref, sharedDependencies))

  const settled = await Promise.allSettled(workers.map((worker) => worker.run(queue)))

  const workerResults: CrewWorkerResult[] = settled.map((result, index) => {
    const modelId =
      (typeof refs[index] === 'string' ? refs[index] : (refs[index] as EngineerRef).modelId) ?? `engineer-${index}`
    if (result.status === 'fulfilled') {
      return result.value
    }
    return {
      modelId,
      completedTaskIds: workers[index]?.completedTaskIds ?? [],
      failedTaskIds: workers[index]?.failedTaskIds ?? [],
      retired: workers[index]?.isRetired ?? false,
      consecutiveFailures: workers[index]?.failureCount ?? 0,
    }
  })

  for (const result of settled) {
    if (result.status === 'rejected') {
      const reason = result.reason
      const bus = sharedDependencies.bus
      bus?.emit('run.failed', { error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  return {
    workers: workerResults,
    tasks: queue instanceof InMemoryTaskQueue ? [...queue.tasks] : [...tasks],
  }
}

function normalizeOptions(value: CrewDependencies | RunCrewOptions | undefined): RunCrewOptions {
  if (value === undefined) return {}
  if (isRunCrewOptions(value)) return value
  return { dependencies: value }
}

function isRunCrewOptions(value: CrewDependencies | RunCrewOptions): value is RunCrewOptions {
  return typeof value === 'object' && value !== null && ('dependencies' in value || 'concurrency' in value)
}

export class InMemoryTaskQueue {
  readonly tasks: Task[]
  private readonly claimedBy = new Map<string, string>()

  constructor(tasks: readonly Task[]) {
    this.tasks = tasks.map((task) => ({ ...task, status: task.status ?? 'pending' }))
  }

  claimNext(workerId: string): Task | null {
    const task = this.tasks.find((item) => {
      const status = item.status
      return status !== 'claimed' && status !== 'completed' && status !== 'failed' && status !== 'retired'
    })
    if (!task) return null
    ;(task as MutableTask).status = 'claimed'
    this.claimedBy.set(task.id, workerId)
    return task
  }

  retire(workerId: string): void {
    for (const task of this.tasks) {
      if (this.claimedBy.get(task.id) === workerId && task.status === 'claimed') {
        ;(task as MutableTask).status = 'pending'
      }
      this.claimedBy.delete(task.id)
    }
  }

  remaining(): number {
    return this.tasks.filter((task) => task.status !== 'completed').length
  }
}

interface MutableTask {
  status?: Task['status']
}

export function createTaskQueue(tasks: readonly Task[]): TaskQueue {
  return new InMemoryTaskQueue(tasks)
}
