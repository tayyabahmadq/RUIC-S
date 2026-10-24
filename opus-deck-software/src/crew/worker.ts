/**
 * Phase 7: One parallel engineering worker.
 * Loop: claim task -> acquire locks -> assemble prompt -> stream completion ->
 * parse write intent -> commons.write -> release locks -> emit task.completed.
 */
import {
  type CommonsClient,
  type CrewDependencies,
  type EngineerRef,
  type EventBus,
  type LockClient,
  type Task,
  type TaskQueue,
  type WorkingSetEntry,
  type WriteIntent,
  WriteIntentSchema,
  CommonsError as CrewCommonsError,
  type PresenceEntry,
} from './types.js'
import { buildPrompt } from './assemble-prompt.js'
import { currentEntries as currentWorkingSetEntries } from './lru.js'

const CORRECTIVE_NOTE =
  'Your previous response was not valid JSON matching the required schema. ' +
  'Respond with ONLY one JSON object: {"intent": string, "path": string, "added": string[], "atLine": number, "removedLineCount": number}. ' +
  'No markdown fences and no prose.'

/** R21 (E1): token usage for one completion, exactly as a phase-02 `usage`
 * chunk reports it. Recorded verbatim — never synthesized. */
interface UsageLike {
  readonly inputTokens: number
  readonly outputTokens: number
}

interface MutableTask {
  status?: Task['status']
}

function asCallable(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : undefined
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/**
 * R21 (E1) FIX 1 — transport stream realism.
 *
 * A real phase-02 adapter streams the canonical chunk grammar
 * `TransportChunk = text | usage | done` and ALWAYS terminates with `done`
 * (it may emit `usage` before it). The previous consumer
 * JSON.stringify'd EVERY non-text chunk into the write-intent text, so a
 * real stream corrupted the model's JSON with `{"type":"usage",...}` and
 * `{"type":"done",...}` fragments and the worker failed with PARSE_FAILED.
 * The worker path now:
 *   - collects text chunks only (the canonical `text` chunk plus the legacy
 *     string/content/delta/choices shapes);
 *   - feeds `usage` chunks to the injected usage sink when one is available
 *     (never stringified, never double-counted — the shell's transport
 *     wrapper records them at the transport layer);
 *   - stops at the FIRST `done` chunk: it terminates the stream, so a chunk
 *     after `done` is never consumed.
 */
function chunkTypeOf(chunk: unknown): string | undefined {
  if (chunk === null || typeof chunk !== 'object') return undefined
  const raw = (chunk as Record<string, unknown>)['type']
  return typeof raw === 'string' ? raw : undefined
}

function textOfChunk(chunk: unknown): string | undefined {
  if (typeof chunk === 'string') return chunk
  if (chunk === null || typeof chunk !== 'object') return undefined
  const obj = chunk as Record<string, unknown>
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.content === 'string') return obj.content
  if (obj.delta !== null && typeof obj.delta === 'object') {
    const delta = obj.delta as Record<string, unknown>
    if (typeof delta.content === 'string') return delta.content
  }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0]
    if (choice !== null && typeof choice === 'object') {
      const delta = (choice as Record<string, unknown>)['delta']
      if (delta !== null && typeof delta === 'object') {
        const content = (delta as Record<string, unknown>)['content']
        if (typeof content === 'string') return content
      }
      const text = (choice as Record<string, unknown>)['text']
      if (typeof text === 'string') return text
    }
  }
  return undefined
}

function usageOfChunk(chunk: unknown): UsageLike | undefined {
  const obj = chunk
  if (obj === null || typeof obj !== 'object') return undefined
  const inputTokens = (obj as Record<string, unknown>)['inputTokens']
  const outputTokens = (obj as Record<string, unknown>)['outputTokens']
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return { inputTokens, outputTokens }
}

async function readStreamResult(value: unknown, onUsage?: (usage: UsageLike) => void): Promise<string> {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (isAsyncIterable(value)) {
    const chunks: string[] = []
    for await (const chunk of value) {
      const type = chunkTypeOf(chunk)
      if (type === 'usage') {
        const usage = usageOfChunk(chunk)
        if (usage !== undefined && onUsage !== undefined) onUsage(usage)
        continue
      }
      if (type === 'done') break
      const text = textOfChunk(chunk)
      if (text !== undefined) chunks.push(text)
    }
    return chunks.join('')
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
  }
  return String(value)
}

async function streamCompletion(
  transport: { stream?: unknown; complete?: unknown; chat?: unknown },
  modelId: string,
  prompt: string,
  system?: string,
  onUsage?: (usage: UsageLike) => void,
): Promise<string> {
  const options = system === undefined ? undefined : { system }
  const streamFn = asCallable((transport as Record<string, unknown>)['stream'])
  if (streamFn) return readStreamResult(await streamFn.call(transport, modelId, prompt, options), onUsage)
  const completeFn = asCallable((transport as Record<string, unknown>)['complete'])
  if (completeFn) return readStreamResult(await completeFn.call(transport, modelId, prompt, options), onUsage)
  const chatFn = asCallable((transport as Record<string, unknown>)['chat'])
  if (chatFn) return readStreamResult(await chatFn.call(transport, modelId, prompt, options), onUsage)
  throw new CrewCommonsError('TRANSPORT_UNAVAILABLE', 'transport has no supported completion method')
}

function extractJson(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const candidate = fenced && fenced[1] !== undefined ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start !== -1 && end > start) return candidate.slice(start, end + 1)
  return candidate
}

function parseWriteIntent(text: string): WriteIntent {
  return WriteIntentSchema.parse(JSON.parse(extractJson(text)))
}

/* Phase 3 (personas): crew default system prompt seam. Mirrors the documented
 * f07SetDefaultBus module-default pattern: wiring retargets it once at wire
 * time; a per-worker deps.systemPrompt always wins; `undefined` restores
 * shipped behavior (no system prompt at all). */
let defaultSystemPrompt: string | undefined

export function f07SetDefaultSystemPrompt(systemPrompt: string | undefined): void {
  defaultSystemPrompt = systemPrompt
}

export function f07GetDefaultSystemPrompt(): string | undefined {
  return defaultSystemPrompt
}

/* Common-S: crew default State Contract writer seam. Same module-default
 * pattern: wiring retargets it once at wire time to the Brain-backed writer;
 * a per-worker deps.contractWriter always wins; `undefined` restores shipped
 * behavior (no contract writes). */
let defaultContractWriter: CrewDependencies['contractWriter']

export function f07SetDefaultContractWriter(
  writer: NonNullable<CrewDependencies['contractWriter']> | undefined,
): void {
  defaultContractWriter = writer
}

export function f07GetDefaultContractWriter(): CrewDependencies['contractWriter'] {
  return defaultContractWriter
}

/* Zeak v2: crew default failure recorder (TRY BOX) + guides provider seams.
 * Same module-default pattern: wiring installs once at wire time. */
let defaultFailureRecorder: NonNullable<CrewDependencies['failureRecorder']>
export function f07SetDefaultFailureRecorder(recorder: NonNullable<CrewDependencies['failureRecorder']>): void {
  defaultFailureRecorder = recorder
}
let defaultGuidesProvider: NonNullable<CrewDependencies['guides']>
export function f07SetDefaultGuides(provider: NonNullable<CrewDependencies['guides']>): void {
  defaultGuidesProvider = provider
}

async function readCommonsText(commons: { read?: unknown }, path: string): Promise<string> {
  const readFn = asCallable((commons as Record<string, unknown>)['read'])
  if (!readFn) return ''
  try {
    const result = await readFn.call(commons, path)
    if (typeof result === 'string') return result
    if (result === null || result === undefined) return ''
    return String(result)
  } catch {
    return ''
  }
}

async function writeCommons(commons: { write?: unknown }, intent: WriteIntent, author: string): Promise<void> {
  const writeFn = asCallable((commons as Record<string, unknown>)['write'])
  if (!writeFn) throw new CrewCommonsError('COMMONS_UNAVAILABLE', 'commons client has no write method')
  const payload = {
    intent: intent.intent,
    path: intent.path,
    author,
    added: [...intent.added],
    atLine: intent.atLine,
    removedLineCount: intent.removedLineCount,
  }
  await writeFn.call(commons, payload)
}

async function acquireLocks(client: { acquire?: unknown; acquireLocks?: unknown }, owner: string, targets: readonly string[]): Promise<void> {
  if (targets.length === 0) return
  const batch = asCallable((client as Record<string, unknown>)['acquireLocks'])
  if (batch) { await batch.call(client, targets, owner); return }
  const single = asCallable((client as Record<string, unknown>)['acquire'])
  if (single) {
    for (const target of targets) await single.call(client, target, owner)
    return
  }
}

async function releaseLocks(client: { release?: unknown; releaseLocks?: unknown }, owner: string, targets: readonly string[]): Promise<void> {
  if (targets.length === 0) return
  const batch = asCallable((client as Record<string, unknown>)['releaseLocks'])
  if (batch) { await batch.call(client, targets, owner); return }
  const single = asCallable((client as Record<string, unknown>)['release'])
  if (single) {
    for (const target of targets) await single.call(client, target, owner)
    return
  }
}

export class EngineerWorker {
  readonly modelId: string
  private deps: CrewDependencies
  private consecutiveFailures = 0
  private retiredFlag = false
  readonly completedTaskIds: string[] = []
  readonly failedTaskIds: string[] = []

  constructor(modelIdOrRef: string | EngineerRef, deps: CrewDependencies = {}) {
    const ref = typeof modelIdOrRef === 'string' ? { modelId: modelIdOrRef } : modelIdOrRef
    this.modelId = ref.modelId ?? ref.id ?? 'engineer'
    this.deps = {
      ...deps,
      ...(ref.transport !== undefined ? { transport: ref.transport } : {}),
      ...(ref.workingSet !== undefined ? { workingSet: ref.workingSet } : {}),
    }
  }

  get isRetired(): boolean { return this.retiredFlag }
  get failureCount(): number { return this.consecutiveFailures }

  async run(queue?: TaskQueue, tasks?: readonly Task[]): Promise<{
    modelId: string; completedTaskIds: readonly string[]; failedTaskIds: readonly string[]; retired: boolean; consecutiveFailures: number
  }> {
    let resolvedQueue = queue ?? this.deps.queue
    if (!resolvedQueue) throw new CrewCommonsError('QUEUE_UNAVAILABLE', 'no task queue is available for this worker')
    this.deps = { ...this.deps, queue: resolvedQueue }

    while (!this.retiredFlag) {
      const task = await this.claimNext(resolvedQueue)
      if (!task) break
      try {
        await this.processTask(task, resolvedQueue)
      } catch (err) {
        // Common-S exit path: a worker that fails mid-task writes status
        // 'blocked' + remaining BEFORE leaving the desk, so the next model
        // never reads stale state — the resume point survives the crash.
        const detail = err instanceof Error ? err.message : String(err)
        await this.writeContractSafe({
          taskId: task.id, status: 'blocked', owner: this.modelId,
          remaining: [`task ${task.id} failed before completion: ${detail}`],
        })
        // Zeak v2: a crash/bail IS a TRY BOX event — the failure memory.
        await this.recordFailureSafe({
          taskId: task.id, modelId: this.modelId,
          method: task.description ?? task.id,
          errorDetail: detail,
        })
        this.consecutiveFailures += 1
        this.failedTaskIds.push(task.id)
        try { (task as MutableTask).status = 'failed' } catch { }
        this.deps.bus?.emit('task.failed', { taskId: task.id, modelId: this.modelId })
        const limit = this.deps.consecutiveFailureLimit ?? 3
        if (this.consecutiveFailures >= limit) {
          // Common-S handoff: retiring IS bailing — the 'handed_off' write is
          // the handoff. Dept 4 reads remaining and re-queues the work.
          await this.writeContractSafe({
            taskId: task.id, status: 'handed_off', owner: this.modelId,
            remaining: [`worker ${this.modelId} retired after ${this.consecutiveFailures} consecutive failures; re-queue task ${task.id} for another model`],
          })
          this.retiredFlag = true
          const retireFn = asCallable((resolvedQueue as Record<string, unknown>)['retire'])
          if (retireFn) await retireFn.call(resolvedQueue, this.modelId)
          const bus = this.deps.bus
          const payload = { modelId: this.modelId, consecutiveFailures: this.consecutiveFailures }
          bus?.emit('worker.retired', payload)
          bus?.emit('engineer.retired', payload)
          bus?.emit('crew.worker.retired', payload)
        }
      }
    }
    return {
      modelId: this.modelId,
      completedTaskIds: [...this.completedTaskIds],
      failedTaskIds: [...this.failedTaskIds],
      retired: this.retiredFlag,
      consecutiveFailures: this.consecutiveFailures,
    }
  }

  async processTask(task: Task, _queue: TaskQueue): Promise<void> {
    const bus = this.deps.bus
    const commons = (this.deps.commons ?? {}) as { write?: unknown; read?: unknown }
    const locks = (this.deps.locks ?? {}) as { acquire?: unknown; acquireLocks?: unknown; release?: unknown; releaseLocks?: unknown }
    const transport = (this.deps.transport ?? {}) as { stream?: unknown; complete?: unknown; chat?: unknown }

    const claimTargets = [...(task.claimSet ?? task.locks ?? [])]
    await acquireLocks(locks, this.modelId, claimTargets)

    try {
      const brief = await readCommonsText(commons, 'BRIEF.md')
      const digest = await readCommonsText(commons, 'STATE/digest.md')
      let presence: PresenceEntry[] = []
      try {
        const raw = await readCommonsText(commons, 'STATE/presence.json')
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) presence = parsed as PresenceEntry[]
      } catch { presence = [] }
      const workingSet = (this.deps.workingSet?.currentEntries?.(this.modelId) ??
        currentWorkingSetEntries(this.modelId)) as WorkingSetEntry[]

      // Zeak v2: the "clean" arrow — verified guides for this task flow
      // back into the working model's context each round.
      let guides: string | undefined
      try {
        const provider = this.deps.guides ?? defaultGuidesProvider
        if (provider !== undefined) guides = await provider()
      } catch { guides = undefined }
      const prompt = buildPrompt({
        task, brief, digest, presence, workingSet, ...(guides !== undefined ? { guides } : {}), bus,
      })

      // Phase 3 (personas): engineer persona body as the system prompt.
      // deps.systemPrompt (constructor-injected) wins; otherwise the wiring-set
      // crew default; otherwise undefined = shipped behavior (no system prompt).
      const systemPrompt = this.deps.systemPrompt ?? defaultSystemPrompt

      let rawOutput = ''
      let intent: WriteIntent | undefined
      const onUsage = this.deps.usageSink
      try {
        rawOutput = await streamCompletion(transport, this.modelId, prompt, systemPrompt, onUsage)
        intent = parseWriteIntent(rawOutput)
      } catch {
        // The corrective note always rides the retry; with a persona present it
        // is appended so the persona is never silently dropped mid-task.
        const retrySystem = systemPrompt === undefined ? CORRECTIVE_NOTE : `${systemPrompt}\n\n${CORRECTIVE_NOTE}`
        rawOutput = await streamCompletion(transport, this.modelId, prompt, retrySystem, onUsage)
        try {
          intent = parseWriteIntent(rawOutput)
        } catch {
          bus?.emit('run.failed', {
            modelId: this.modelId, taskId: task.id, rawOutput,
            error: 'model output did not match the write-intent wire format',
          })
          throw new CrewCommonsError('PARSE_FAILED', 'model output did not match the write-intent wire format', rawOutput)
        }
      }

      await writeCommons(commons, intent, this.modelId)

      this.consecutiveFailures = 0
      this.completedTaskIds.push(task.id)
      try { (task as MutableTask).status = 'completed' } catch { }
      bus?.emit('task.completed', { taskId: task.id, modelId: this.modelId, intent })
      // Common-S exit path: success writes 'done' + artifacts BEFORE the
      // worker picks up its next claim ("write before you leave the desk").
      await this.writeContractSafe({
        taskId: task.id, status: 'done', owner: this.modelId,
        done: `wrote ${intent.path}: ${intent.intent}`,
        artifacts: [intent.path],
        decisions: [intent.intent],
      })
    } finally {
      await releaseLocks(locks, this.modelId, claimTargets)
    }
  }

  /** Zeak v2: TRY BOX recorder — best-effort, never throws into the run loop. */
  private async recordFailureSafe(input: {
    taskId: string
    modelId: string
    method: string
    errorDetail: string
  }): Promise<void> {
    const recorder = this.deps.failureRecorder ?? defaultFailureRecorder
    if (recorder === undefined) return
    try {
      await recorder(input)
    } catch {
      // failure recording must never crash the worker
    }
  }

  /** Exit-path contract writer: best-effort, never throws into the run loop. */
  private async writeContractSafe(input: {
    taskId: string
    status: 'done' | 'blocked' | 'handed_off'
    owner: string
    done?: string
    remaining?: readonly string[]
    decisions?: readonly string[]
    artifacts?: readonly string[]
  }): Promise<void> {
    const writer = this.deps.contractWriter ?? defaultContractWriter
    if (writer === undefined) return
    try {
      await writer(input)
    } catch {
      // A contract write failure must never crash the worker; the next exit
      // path write supersedes it (last entry per taskId wins).
    }
  }

  private async claimNext(queue: TaskQueue): Promise<Task | null> {
    const claimNext = asCallable((queue as Record<string, unknown>)['claimNext']) ??
      asCallable((queue as Record<string, unknown>)['claim'])
    if (!claimNext) throw new CrewCommonsError('QUEUE_UNAVAILABLE', 'queue has no claimNext/claim method')
    return (claimNext.call(queue, this.modelId) as Task | null)
  }
}

export function createEngineerWorker(modelIdOrRef: string | EngineerRef, deps?: CrewDependencies): EngineerWorker {
  return new EngineerWorker(modelIdOrRef, deps)
}
