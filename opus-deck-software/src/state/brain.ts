/**
 * Common-S Brain — the facade around the three stores (Tier 1 core).
 *
 *   digest.md     — human-readable compacted state (owned by the Compactor)
 *   contracts.json — the State Contract, one latest entry per task
 *   vectors.json   — semantic knowledge for cache-first retrieval
 *
 * The Brain owns the serialization of compaction: requestCompaction() queues
 * work and never runs two compactions concurrently (Risk #4). Every write in
 * every store is atomic (temp + rename) so a reader never sees half-state.
 */
import { promises as fsp } from 'fs'
import * as nodePath from 'node:path'
import { ContractStore, makeContract, validateContract } from './contract.js'
import type { StateContract, TaskStatus } from './contract.js'
import { VectorStore } from './vector-store.js'
import type { EmbedFn, VectorSearchHit } from './vector-store.js'
import { atomicWriteJson, readJson } from './atomic.js'

export interface TaskFlags {
  zeakFallback?: boolean
  fallbackReason?: string
  fallbackModel?: string
  escalations?: number
}

interface StateFileShape {
  tasks: Record<string, TaskFlags>
}

export interface BrainOptions {
  /** Hard vector cap (RAM budget). */
  vectorCap?: number
  /** Minimum age (days) before a vector is decay-eligible. Default 3. */
  vectorMinAgeDays?: number
  /** Relevance cutoff below which decay-eligible vectors drop. Default 0.5. */
  vectorDecayCutoff?: number
}

export class Brain {
  readonly contracts: ContractStore
  readonly vectors: VectorStore
  private readonly stateDir: string
  private readonly stateFile: string
  private readonly vectorMinAgeDays: number
  private readonly vectorDecayCutoff: number
  private compactionQueue: Promise<void> = Promise.resolve()

  constructor(memoryDir: string, embed: EmbedFn | null, options: BrainOptions = {}) {
    this.stateDir = nodePath.join(memoryDir, 'STATE')
    this.stateFile = nodePath.join(this.stateDir, 'state.json')
    this.contracts = new ContractStore(this.stateDir)
    this.vectors = new VectorStore(this.stateDir, { cap: options.vectorCap })
    this.vectorMinAgeDays = options.vectorMinAgeDays ?? 3
    this.vectorDecayCutoff = options.vectorDecayCutoff ?? 0.5
    if (embed !== null) this.embed = embed
  }

  private embedImpl: EmbedFn | null = null
  private get embed(): EmbedFn {
    if (this.embedImpl === null) {
      throw new Error('Brain: no embedder configured — vector operations are unavailable')
    }
    return this.embedImpl
  }
  private set embed(fn: EmbedFn) {
    this.embedImpl = fn
  }

  get hasEmbedder(): boolean {
    return this.embedImpl !== null
  }

  // --- Task flags (state.json): durable, cross-model metadata -------------

  async getTaskFlags(taskId: string): Promise<TaskFlags> {
    const data = await readJson<StateFileShape>(this.stateFile, { tasks: {} })
    return data.tasks[taskId] ?? {}
  }

  async setTaskFlags(taskId: string, flags: TaskFlags): Promise<void> {
    const data = await readJson<StateFileShape>(this.stateFile, { tasks: {} })
    data.tasks[taskId] = { ...data.tasks[taskId], ...flags }
    await atomicWriteJson(this.stateFile, data)
  }

  // --- Vector knowledge (cache-gate + Data Collection ingest) -------------

  async learn(text: string, source: string): Promise<string | null> {
    if (!this.hasEmbedder) return null
    const vector = await this.embed(text)
    if (vector === null || vector === undefined || !Array.isArray(vector)) return null
    return this.vectors.add(text, source, async () => vector)
  }

  /** Cache-first lookup. Returns null when no embedder or below threshold. */
  async recall(text: string, threshold = 0.9): Promise<VectorSearchHit[] | null> {
    if (!this.hasEmbedder) return null
    const vector = await this.embed(text)
    if (vector === null || vector === undefined || !Array.isArray(vector)) return null
    return this.vectors.search(text, async () => vector, threshold)
  }

  // --- Contract writes (the exit-path obligation) --------------------------

  async writeContract(input: {
    taskId: string
    status: TaskStatus
    owner: string
    done?: string
    decisions?: readonly string[]
    remaining?: readonly string[]
    artifacts?: readonly string[]
    parentTaskId?: string | null
  }): Promise<StateContract> {
    const entry = makeContract(input)
    validateContract(entry)
    await this.contracts.record(entry)
    return entry
  }

  // --- Serialized compaction (the heartbeat) -------------------------------

  /**
   * Queue one compaction cycle. Cycles run strictly one at a time (Risk #4:
   * rapid task completions must never stack concurrent compactions). Each
   * cycle: vector decay + contract fold first, then the digest compaction is
   * left to the caller's `triggerDigest` hook (the existing Compactor's
   * compaction.requested path) — invoked only after the stores settled.
   * Returns true if this call owned the actual work, false if it was folded
   * into an already-queued cycle.
   */
  requestCompaction(triggerDigest: () => void | Promise<void>): Promise<boolean> {
    const run = this.compactionQueue.then(async () => {
      await this.vectors.decay(this.vectorMinAgeDays, this.vectorDecayCutoff)
      await this.foldContracts()
      await triggerDigest()
    })
    // Keep the queue alive regardless of a cycle's fate.
    this.compactionQueue = run.catch(() => undefined)
    return run.then(() => true)
  }

  /** Fold terminal contract rows older than the horizon; recent ones stay so
   * handoffs and stitching keep working. Returns rows removed. */
  private async foldContracts(): Promise<number> {
    const horizon = new Date(Date.now() - 7 * 86_400_000).toISOString()
    return this.contracts.prune(horizon, [])
  }

  /** Stats for the deck UI / tests. */
  async stats(): Promise<{ vectors: number; contracts: number }> {
    await this.vectors.load()
    const all = await this.contracts.listByStatus('in_progress', 'blocked', 'handed_off', 'done')
    return { vectors: this.vectors.size(), contracts: all.length }
  }

  /** Direct state-dir access (tests). */
  get stateDirectory(): string {
    return this.stateDir
  }

  /** Ensure STATE dir exists (boot). */
  async init(): Promise<void> {
    await fsp.mkdir(this.stateDir, { recursive: true })
    await this.vectors.load()
  }
}
