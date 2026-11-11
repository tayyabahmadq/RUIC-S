/**
 * Common-S Brain — the State Contract (Risk #1).
 *
 * The single format every model depends on. Version stamped on day one:
 * readers reject entries whose major version they do not understand, so the
 * format can evolve without silent misreads.
 *
 * Enforcement lives at the worker's EXIT path, not the entry point:
 *   - normal completion        -> status 'done' + artifacts
 *   - crash/error mid-task     -> status 'blocked' + remaining (a resume point)
 *   - bail (limit/context hit) -> status 'handed_off' + remaining — that write
 *     IS the handoff; Dept 4 re-queues `remaining` linked by parentTaskId.
 */
import { z } from 'zod'
import { promises as fsp } from 'fs'
import { atomicWriteJson } from './atomic.js'

export const SCHEMA_VERSION = '1.0.0' as const
export const CONTRACT_STATE_MAJOR = 1

export const TaskStatusSchema = z.enum(['in_progress', 'blocked', 'handed_off', 'done'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const StateContractSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  taskId: z.string().min(1),
  parentTaskId: z.string().nullable(),
  status: TaskStatusSchema,
  owner: z.string().min(1),
  done: z.string(),
  decisions: z.array(z.string()),
  /** Required unless status is exactly 'done' — a contract without remaining
   * work and without completion is not a contract. */
  remaining: z.array(z.string()),
  artifacts: z.array(z.string()),
  updatedAt: z.string(),
})
export type StateContract = z.infer<typeof StateContractSchema>

export class ContractValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`state contract rejected: ${issues.join('; ')}`)
    this.name = 'ContractValidationError'
    this.issues = issues
  }
}

/** Validate one entry. Readers reject unknown MAJOR schema versions. */
export function validateContract(raw: unknown): StateContract {
  const parsed = StateContractSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Distinguish a version mismatch (explicit migration error) from bad shape.
  if (
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw &&
    typeof (raw as { schemaVersion: unknown }).schemaVersion === 'string'
  ) {
    const major = Number.parseInt((raw as { schemaVersion: string }).schemaVersion.split('.')[0] ?? '', 10)
    if (Number.isInteger(major) && major !== CONTRACT_STATE_MAJOR) {
      throw new ContractValidationError([
        `unsupported schema major ${major} (reader understands ${CONTRACT_STATE_MAJOR})`,
      ])
    }
  }
  throw new ContractValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
}

/** Build a fully-formed entry with defaults and the current timestamp. */
export function makeContract(input: {
  taskId: string
  status: TaskStatus
  owner: string
  done?: string
  decisions?: readonly string[]
  remaining?: readonly string[]
  artifacts?: readonly string[]
  parentTaskId?: string | null
}): StateContract {
  const status = input.status
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: input.taskId,
    parentTaskId: input.parentTaskId ?? null,
    status,
    owner: input.owner,
    done: input.done ?? '',
    decisions: [...(input.decisions ?? [])],
    remaining: status === 'done' ? [...(input.remaining ?? [])] : [...(input.remaining ?? [])],
    artifacts: [...(input.artifacts ?? [])],
    updatedAt: new Date().toISOString(),
  }
}

interface ContractFileShape {
  schemaVersion: string
  contracts: Record<string, StateContract>
}

/**
 * The contract store: STATE/contracts.json, one latest entry per taskId,
 * every save atomic (temp + rename).
 */
export class ContractStore {
  private readonly file: string
  private cache: ContractFileShape | null = null

  constructor(stateDir: string) {
    this.file = `${stateDir.replace(/[\\/]+$/, '')}/contracts.json`
  }

  private async load(): Promise<ContractFileShape> {
    if (this.cache !== null) return this.cache
    let parsed: unknown
    try {
      parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'))
    } catch {
      parsed = null
    }
    const contracts: Record<string, StateContract> = {}
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { contracts?: unknown }).contracts)) {
      for (const raw of (parsed as { contracts: unknown[] }).contracts) {
        try {
          const c = validateContract(raw)
          contracts[c.taskId] = c
        } catch {
          // A corrupt/unknown-major entry is skipped, never fatal: the store
          // stays readable and the bad row is overwritten by the next writer.
        }
      }
    }
    this.cache = { schemaVersion: SCHEMA_VERSION, contracts }
    return this.cache
  }

  /** Record (upsert) one contract entry. Throws ContractValidationError on
   * a schema-violating write — the exit path must never persist garbage. */
  async record(entry: StateContract): Promise<void> {
    validateContract(entry) // throws on violation
    const data = await this.load()
    data.contracts[entry.taskId] = entry
    await atomicWriteJson(this.file, { schemaVersion: SCHEMA_VERSION, contracts: Object.values(data.contracts) })
  }

  async get(taskId: string): Promise<StateContract | null> {
    const data = await this.load()
    return data.contracts[taskId] ?? null
  }

  async listByStatus(...statuses: TaskStatus[]): Promise<StateContract[]> {
    const data = await this.load()
    return Object.values(data.contracts).filter((c) => statuses.includes(c.status))
  }

  /** Entries grouped for Dept 4 stitching: children by parentTaskId. */
  async childrenOf(parentTaskId: string): Promise<StateContract[]> {
    const data = await this.load()
    return Object.values(data.contracts).filter((c) => c.parentTaskId === parentTaskId)
  }

  /** Drop terminal entries older than the retention horizon (Compactor fold). */
  async prune(doneBeforeIso: string, keepTaskIds: readonly string[]): Promise<number> {
    const data = await this.load()
    const keep = new Set(keepTaskIds)
    let removed = 0
    for (const [id, c] of Object.entries(data.contracts)) {
      if (c.status === 'done' && c.updatedAt < doneBeforeIso && !keep.has(id)) {
        delete data.contracts[id]
        removed += 1
      }
    }
    if (removed > 0) {
      await atomicWriteJson(this.file, { schemaVersion: SCHEMA_VERSION, contracts: Object.values(data.contracts) })
    }
    return removed
  }
}
