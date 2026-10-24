/**
 * Opus//DECK App — Control Deck host (the real main-process logic).
 *
 * This module is deliberately Electron-free: it is the whole engine-facing
 * behaviour of the shell, and the Electron entry (`main/index.ts`) and the
 * Electron contract test (`test/electron/main.ts`) both drive THIS module. It
 * is what "through the real main process" means — the same object, the same
 * journal, the same abort path, just reached over real IPC in the test.
 *
 * Responsibilities (R16):
 *   - bootstrap: load config, `initOpusDeck()`, `wireOpusDeck()`, hold the runtime;
 *   - event journal: every hub event AND every host-emitted lifecycle event is
 *     normalized into the typed bridge vocabulary, appended to ONE ordered
 *     journal, and delivered to sinks as batched, cursor-tracked, gap-free
 *     batches (a sink that subscribes mid-run is handed the full history);
 *   - invoke surface: exactly run | abort | config | crewHealth;
 *   - expected state: the authoritative run state, computed directly here from
 *     the engine's return values and the host's own bookkeeping;
 *   - graceful abort: window-close behaves like the CLI's Ctrl-C (emit
 *     `run.failed` 'aborted', release claims, persist the journal position).
 *
 * R18: the engine workspace is read-only; nothing here writes to it.
 * R19: key resolution is main-only (see transport-factory.ts); the renderer
 * sees model names and health, never key material and never env access.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  BridgeCrew, BridgeEventName, BridgeEventPayloads, BridgeModelRef, CrewRole,
  DeckAbortResult, DeckConfigInput, DeckConfigView, DeckCrewHealthResult, DeckEvent,
  DeckEventBatch, DeckInvokeCommand, DeckInvokeResponse, DeckInvokeResults, DeckRunResult,
  ReconstructedCrewHealth, ReconstructedFinding, ReconstructedPresence, ReconstructedState,
  ReconstructedTask, RunPhase,
} from '../shared/bridge-types'
import { compareFindings, comparePresence, compareTasks } from '../shared/bridge-types'
import { HUB_EVENT_NAMES, normalizeHubEvent } from '../shared/event-normalize'
import type {
  EngineConfig, EngineFinding, EngineHealthResult, EngineManifest, EngineModelRef,
  EngineRemediationTask, EngineRuntime, EngineScanReport, EngineSignOff, EngineTask,
  EngineTaskBus, EngineVerificationResult, WiredDeck,
} from '../engine/engine-contract'
import type { LoadedEngine } from '../engine/engine-load'
import { buildEngineTransport, withUsageAccounting, type BuiltTransport } from './transport-factory'
import type { DeckPreviewResult, PreviewHostHandle } from '../shared/bridge-types'

/* ------------------------------------------------------------------ *
 * Seams
 * ------------------------------------------------------------------ */

/** The only clock — injectable so run timings are exact in tests. */
export interface DeckClock {
  now(): string
  nowMs(): number
}

export const systemClock: DeckClock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}

/** Builds the run transport; the default resolves keys in main (R19). */
export type DeckTransportFactory = (config: DeckConfigInput, engine: LoadedEngine) => BuiltTransport

export interface DeckHostHooks {
  /** Awaited right after a phase is entered (lets a test open a window mid-run). */
  afterPhase?: (phase: RunPhase) => void | Promise<void>
}

export interface DeckHostOptions {
  readonly engine: LoadedEngine
  readonly clock?: DeckClock
  readonly transportFactory?: DeckTransportFactory
  /** Overrides the real health probe (deterministic tests). */
  readonly healthCheck?: (modelId: string) => Promise<EngineHealthResult>
  readonly hooks?: DeckHostHooks
  readonly runIdFactory?: () => string
  /** Where the DELTA position is persisted on completion/abort. */
  readonly journalDir?: string
  readonly initialConfig?: DeckConfigInput
  readonly schedule?: (fn: () => void) => void
  /** The sandboxed preview view handle (R16/R17). The host drives it; main
   *  wires the real implementation. Type-only at the boundary — no Electron
   *  type leaks into this Electron-free module. */
  readonly previewHost?: PreviewHostHandle
}

type AnyInvokeResult = DeckInvokeResults[keyof DeckInvokeResults]

interface Sink {
  readonly onBatch: (batch: DeckEventBatch) => void
  cursor: number
  scheduled: boolean
}

const SECRET_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"][^'"]{8,}['"]/gi

const placeholder = (id: string): BridgeModelRef => ({
  id,
  provider: 'openai-compatible',
  model: id,
  contextWindowTokens: 4096,
})

const DEFAULT_CONFIG: DeckConfigInput = {
  memoryDir: 'COMMONS',
  outputDir: 'OUTPUT',
  brief: '',
  goalState: [],
  crew: {
    lead: placeholder('lead'),
    engineers: [placeholder('eng-1')],
    security: [placeholder('sec-1'), placeholder('sec-2')],
  },
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function cloneConfig(config: DeckConfigInput): DeckConfigInput {
  return {
    memoryDir: config.memoryDir,
    outputDir: config.outputDir,
    brief: config.brief,
    goalState: [...config.goalState],
    crew: {
      lead: projectModel(config.crew.lead),
      engineers: config.crew.engineers.map(projectModel),
      security: config.crew.security.map(projectModel),
    },
  }
}

/**
 * Rebuild a model ref from ONLY the fields the bridge contract declares.
 * Spreading is not enough: an object smuggled across the bridge could carry an
 * `apiKeyEnv` (or any other field) that must never be echoed back to the
 * renderer (R19). Projection makes the contract the whitelist.
 */
function projectModel(ref: BridgeModelRef): BridgeModelRef {
  return {
    id: ref.id,
    provider: ref.provider,
    model: ref.model,
    contextWindowTokens: ref.contextWindowTokens,
    ...(ref.endpoint === undefined ? {} : { endpoint: ref.endpoint }),
    ...(ref.speedClass === undefined ? {} : { speedClass: ref.speedClass }),
    ...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
  }
}

function toModelRef(ref: BridgeModelRef): EngineModelRef {
  return {
    id: ref.id,
    provider: ref.provider,
    model: ref.model,
    contextWindowTokens: ref.contextWindowTokens,
    ...(ref.endpoint === undefined ? {} : { endpoint: ref.endpoint }),
    ...(ref.speedClass === undefined ? {} : { speedClass: ref.speedClass }),
    ...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
  }
}

function toEngineConfig(config: DeckConfigInput): EngineConfig {
  return {
    memoryDir: config.memoryDir,
    outputDir: config.outputDir,
    brief: config.brief,
    goalState: [...config.goalState],
    crew: {
      lead: toModelRef(config.crew.lead),
      engineers: config.crew.engineers.map(toModelRef),
      security: config.crew.security.map(toModelRef),
    },
  }
}

/** Every artifact the crew has written to WORKSPACE, posix-relative, sorted. */
function readWorkspaceArtifacts(memoryDir: string): Array<{ path: string; code: string }> {
  const root = path.join(memoryDir, 'WORKSPACE')
  const out: Array<{ path: string; code: string }> = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) {
        try {
          out.push({ path: rel, code: fs.readFileSync(full, 'utf8') })
        } catch {
          // unreadable file: skip (never crash the audit on I/O)
        }
      }
    }
  }
  walk(root, '')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The remediation task bus, implemented in main. It patches the WORKSPACE
 * artifact for the one auto-patchable strategy this run is scoped to
 * (`env-var`, i.e. a hardcoded secret reads from process.env instead). The
 * audit loop re-scans through the engine's artifact store and clears the
 * finding only when the rule no longer fires — the shell never marks anything
 * resolved on its own.
 */
function createPatchingBus(memoryDir: string, now: () => string): EngineTaskBus {
  void now
  return {
    async enqueue(task: EngineRemediationTask): Promise<{ taskId: string; accepted: boolean }> {
      if (task.patchStrategy === 'env-var' && task.targetPath !== '') {
        const full = path.join(memoryDir, 'WORKSPACE', ...task.targetPath.split('/'))
        let code = ''
        try {
          code = await fs.promises.readFile(full, 'utf8')
        } catch {
          code = ''
        }
        const patched = code.replace(SECRET_PATTERN, '$1 = process.env.SECRET_VALUE')
        if (patched !== code) await fs.promises.writeFile(full, patched, 'utf8')
      }
      return { taskId: task.id, accepted: true }
    },
    async awaitSettlement(receipt: { taskId: string }): Promise<{ taskId: string; ok: boolean }> {
      return { taskId: receipt.taskId, ok: true }
    },
  }
}

/* ------------------------------------------------------------------ *
 * The host
 * ------------------------------------------------------------------ */

export class DeckHost {
  private readonly engine: LoadedEngine
  private readonly clock: DeckClock
  private readonly transportFactory: DeckTransportFactory
  private readonly injectedHealthCheck: ((modelId: string) => Promise<EngineHealthResult>) | undefined
  private readonly hooks: DeckHostHooks
  private readonly runIdFactory: () => string
  private readonly journalDir: string | undefined
  private readonly schedule: (fn: () => void) => void

  private config: DeckConfigInput
  private engineVersion = ''

  private journal: DeckEvent[] = []
  private counter = 0
  private readonly sinks = new Set<Sink>()

  private running = false
  private aborted = false
  private runSeq = 0
  private runId = ''
  private phase: RunPhase = 'idle'
  private startedAt: string | null = null
  private endedAt: string | null = null
  private tokenInput = 0
  private tokenOutput = 0

  private readonly tasks = new Map<string, ReconstructedTask>()
  private readonly findings = new Map<string, ReconstructedFinding>()
  private readonly presence = new Map<string, ReconstructedPresence>()
  private crewHealthLedger: ReconstructedCrewHealth[] = []

  private currentRuntime: EngineRuntime | null = null
  private currentWired: WiredDeck | null = null
  private currentHealth: ((modelId: string) => Promise<EngineHealthResult>) | null = null
  private hubTeardown: (() => void) | null = null

  /** Preview (R16): sandboxed WebContentsView showing the merged build output.
   *  `previewHostHandle` is the real view (wired by main); `previewState` is the
   *  bookkeeping reflected to the renderer via `preview.state` events. */
  private previewHostHandle: PreviewHostHandle | null = null
  private previewState: { open: boolean; currentFile: string | null; files: string[] } | null =
    null

  private lastManifest: EngineManifest | null = null
  private lastSignOff: EngineSignOff | null = null
  private lastVerification: readonly EngineVerificationResult[] = []

  constructor(options: DeckHostOptions) {
    this.engine = options.engine
    this.clock = options.clock ?? systemClock
    this.transportFactory =
      options.transportFactory ?? ((config, engine) => buildEngineTransport(config, engine))
    this.injectedHealthCheck = options.healthCheck
    this.hooks = options.hooks ?? {}
    this.runIdFactory =
      options.runIdFactory ?? (() => `run-${String(++this.runSeq).padStart(6, '0')}`)
    this.journalDir = options.journalDir
    this.schedule = options.schedule ?? ((fn) => { setImmediate(fn) })
    this.config = cloneConfig(options.initialConfig ?? DEFAULT_CONFIG)
    this.previewHostHandle = options.previewHost ?? null
  }

  /* ---------------- event journal ---------------- */

  private emit<K extends BridgeEventName>(type: K, payload: BridgeEventPayloads[K]): DeckEvent {
    const event = {
      id: `evt-${String(++this.counter).padStart(6, '0')}`,
      type,
      payload,
      at: this.clock.now(),
    } as DeckEvent
    this.journal.push(event)
    this.deliver()
    return event
  }

  private deliver(): void {
    for (const sink of this.sinks) {
      if (sink.scheduled || sink.cursor >= this.journal.length) continue
      sink.scheduled = true
      this.schedule(() => {
        sink.scheduled = false
        this.flushSink(sink)
      })
    }
  }

  private flushSink(sink: Sink): void {
    if (sink.cursor >= this.journal.length) return
    const start = sink.cursor
    const events = this.journal.slice(start)
    sink.cursor = this.journal.length
    sink.onBatch({ events, replayBase: start, at: this.clock.now() })
  }

  /** Deliver every pending batch synchronously (deterministic tests, window close). */
  flushNow(): void {
    for (const sink of this.sinks) {
      sink.scheduled = false
      this.flushSink(sink)
    }
  }

  subscribe(onBatch: (batch: DeckEventBatch) => void): () => void {
    const sink: Sink = { onBatch, cursor: 0, scheduled: false }
    this.sinks.add(sink)
    this.deliver()
    return () => {
      this.sinks.delete(sink)
    }
  }

  /** Full-history batch — how the renderer rebuilds state on a mid-run open. */
  replay(): DeckEventBatch {
    return { events: [...this.journal], replayBase: 0, at: this.clock.now() }
  }

  journalLength(): number {
    return this.journal.length
  }

  /**
   * Common-S: routing/economic notes folded from the journal with the SAME
   * templates the renderer's reducer uses — expectedState() and the renderer's
   * reconstructState() must agree byte-for-byte (contract test).
   */
  private routingNotesFromJournal(): string[] {
    const notes: string[] = []
    for (const event of this.journal) {
      const p = event.payload as Record<string, unknown>
      switch (event.type) {
        case 'laya.routed':
          notes.push(`Laya routed ${String(p['decision'])} (score ${String(p['score'])}): ${String((p['reasons'] as string[] | undefined)?.[0] ?? '')}`.trim())
          break
        case 'zeak.fallback':
          notes.push(`Zeak fallback ${String(p['from'])} -> ${String(p['to'])} (${String(p['reason'])})`)
          break
        case 'zeak.early_stop':
          notes.push(`Zeak early-stop after ${String(p['chunks'])} chunks (contract satisfied)`)
          break
        case 'zeak.escalation':
          notes.push(`Zeak re-escalated task to ${String(p['to'])} (attempt ${String(p['attempt'])})`)
          break
        case 'collector.collected':
          notes.push(`Collected ${String(p['count'])} item(s) via ${String(p['via'])}: ${String(p['topic'])}`)
          break
        default:
          break
      }
    }
    return notes
  }

  /** The authoritative run state, computed directly from engine returns + bookkeeping. */
  expectedState(): ReconstructedState {
    return {
      runId: this.runId,
      phase: this.phase,
      tasks: [...this.tasks.values()].sort(compareTasks),
      findings: [...this.findings.values()].sort(compareFindings),
      presence: [...this.presence.values()].sort(comparePresence),
      routingNotes: this.routingNotesFromJournal(),
      crewHealth: [...this.crewHealthLedger].sort(byId),
      tokenSpend: this.tokenInput + this.tokenOutput,
      elapsedMs:
        this.startedAt !== null && this.endedAt !== null
          ? Date.parse(this.endedAt) - Date.parse(this.startedAt)
          : 0,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    }
  }

  isRunning(): boolean {
    return this.running
  }

  /* ---------------- config ---------------- */

  configView(): DeckConfigView {
    return {
      memoryDir: this.config.memoryDir,
      outputDir: this.config.outputDir,
      brief: this.config.brief,
      goalState: [...this.config.goalState],
      crew: {
        lead: projectModel(this.config.crew.lead),
        engineers: this.config.crew.engineers.map(projectModel),
        security: this.config.crew.security.map(projectModel),
      },
      gate: { failOn: 'critical' },
      engineRoot: this.engine.engineRoot,
      engineVersion: this.engineVersion,
    }
  }

  private applyConfig(command: { action: 'get' | 'set'; config?: DeckConfigInput }): DeckConfigView {
    if (command.action === 'set') {
      if (this.running) throw new Error('cannot reconfigure while a run is in progress')
      if (command.config === undefined) throw new Error('config set requires a config payload')
      this.config = cloneConfig(command.config)
    }
    return this.configView()
  }

  /* ---------------- crew health (names + health only, R19) ---------------- */

  private async runHealthCheck(modelId: string): Promise<EngineHealthResult> {
    if (this.injectedHealthCheck !== undefined) return this.injectedHealthCheck(modelId)
    if (this.currentHealth !== null) return this.currentHealth(modelId)
    return { ok: false, latencyMs: 0, detail: 'no health probe available before the first run' }
  }

  private async probeCrewHealth(config: DeckConfigInput): Promise<ReconstructedCrewHealth[]> {
    const out: ReconstructedCrewHealth[] = []
    let lead: EngineHealthResult
    try {
      lead = await this.runHealthCheck(config.crew.lead.id)
    } catch (err) {
      lead = { ok: false, latencyMs: 0, detail: messageOf(err) }
    }
    out.push({
      id: config.crew.lead.id,
      role: 'lead',
      healthy: lead.ok,
      ...(lead.detail === undefined ? {} : { detail: lead.detail }),
    })
    for (const ref of config.crew.engineers) {
      out.push({ id: ref.id, role: 'engineer', healthy: true, detail: 'not probed (assumed healthy)' })
    }
    for (const ref of config.crew.security) {
      out.push({ id: ref.id, role: 'security', healthy: true, detail: 'not probed (assumed healthy)' })
    }
    return out.sort(byId)
  }

  async crewHealth(): Promise<DeckCrewHealthResult> {
    if (this.crewHealthLedger.length === 0) {
      this.crewHealthLedger = await this.probeCrewHealth(this.config)
    }
    return { crew: [...this.crewHealthLedger].sort(byId) }
  }

  /* ---------------- preview surface (R16/R17/R18) ---------------- */

  async previewAction(command: { action: 'open' | 'close'; runId?: string; file?: string }): Promise<DeckPreviewResult> {
    if (command.action === 'open') {
      return this.openPreview(command.runId, command.file)
    }
    return this.closePreview()
  }

  private async openPreview(runId?: string, file?: string): Promise<DeckPreviewResult> {
    const runIdStr = runId ?? this.runId
    const result =
      (await this.previewHostHandle?.open(this.config.memoryDir, this.config.outputDir, file)) ??
      { open: false, currentFile: null, files: [] }
    this.previewState = {
      open: result.open,
      currentFile: result.currentFile,
      files: result.files,
    }
    this.emit('preview.state', {
      runId: runIdStr,
      open: result.open,
      currentFile: result.currentFile,
      files: result.files,
    })
    return { open: result.open, currentFile: result.currentFile, files: result.files }
  }

  private async closePreview(): Promise<DeckPreviewResult> {
    const result =
      (await this.previewHostHandle?.close()) ?? { open: false, currentFile: null, files: [] }
    this.previewState = {
      open: result.open,
      currentFile: result.currentFile,
      files: result.files,
    }
    this.emit('preview.state', {
      runId: this.runId,
      open: result.open,
      currentFile: result.currentFile,
      files: result.files,
    })
    return { open: result.open, currentFile: result.currentFile, files: result.files }
  }

  /** Called by main/index.ts to initialise preview state to closed. */
  setPreviewHost(open: boolean, currentFile: string | null, files: string[]): void {
    this.previewState = { open, currentFile, files }
    this.emit('preview.state', {
      runId: this.runId,
      open,
      currentFile,
      files,
    })
  }

  /* ---------------- invoke surface ---------------- */

  async invoke(command: DeckInvokeCommand): Promise<DeckInvokeResponse<AnyInvokeResult>> {
    try {
      switch (command.type) {
        case 'run':
          return { ok: true, data: await this.run(command.payload) }
        case 'abort':
          return { ok: true, data: await this.abort() }
        case 'config':
          return { ok: true, data: this.applyConfig(command.payload) }
        case 'crewHealth':
          return { ok: true, data: await this.crewHealth() }
        case 'preview':
          return { ok: true, data: await this.previewAction(command.payload) }
      }
    } catch (err) {
      return { ok: false, error: messageOf(err) }
    }
  }

  /* ---------------- the run ---------------- */

  async run(config: DeckConfigInput): Promise<DeckRunResult> {
    if (this.running) throw new Error('a run is already in progress')
    this.running = true
    this.aborted = false
    this.resetForRun()
    this.config = cloneConfig(config)
    const runId = this.runIdFactory()
    this.runId = runId

    try {
      const runtime = this.engine.initOpusDeck(toEngineConfig(config))
      this.currentRuntime = runtime
      this.engineVersion = runtime.version

      const built = this.transportFactory(config, this.engine)
      this.currentHealth = built.healthCheck
      this.crewHealthLedger = await this.probeCrewHealth(config)

      const wrapped = withUsageAccounting(built.transport, (usage) => {
        this.tokenInput += usage.inputTokens
        this.tokenOutput += usage.outputTokens
        this.emit('token.use', {
          runId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
      })

      const wired = await this.engine.wireOpusDeck(runtime, {
        transport: wrapped,
        leadModelId: config.crew.lead.id,
        auditorModelIds: config.crew.security.map((s) => s.id),
        confirmationAutoIssue: true,
        gate: { failOn: 'critical' },
        commonS: {
          // Zeak fallback: route over-cap paid calls to the first local
          // engineer when one exists (Ollama endpoint), else omit and Zeak
          // falls back to its default id.
          ...(config.crew.engineers.some((e) => e.endpoint !== undefined && e.endpoint.includes('11434'))
            ? { fallbackModelId: config.crew.engineers.find((e) => e.endpoint !== undefined && e.endpoint.includes('11434'))!.id }
            : {}),
        },
      })
      this.currentWired = wired
      this.subscribeHub(wired, runId)

      // ---- planning ----
      const started = this.emit('run.started', {
        runId,
        brief: config.brief,
        goalState: [...config.goalState],
      })
      this.startedAt = started.at
      this.phase = 'planning'
      this.seedPresence(config)

      // ---- Laya (Dept 1): route before anything paid happens ----
      const layaDecision = await wired.laya({
        brief: config.brief,
        goalState: config.goalState,
        crewSize: config.crew.engineers.length,
      })
      this.emit('laya.routed', {
        runId,
        decision: layaDecision.decision,
        score: layaDecision.score,
        reasons: layaDecision.reasons,
      })

      let tasks: Awaited<ReturnType<typeof wired.leader.plan>>
      const crewForPlan = {
        lead: config.crew.lead.id,
        engineers: config.crew.engineers.map((e) => e.id),
      }
      if (layaDecision.decision === 'local') {
        // Trivial: skip the frontier planner entirely — Laya mints ONE task
        // for the local executor; zero paid calls in planning. seedLocalPlan
        // persists the same commons keys plan() would, so route/verify/
        // signOff/merge all behave identically downstream.
        tasks = [{
          id: 'T-01',
          path: 'WORKSPACE/output.md',
          description: config.brief,
          acceptance: [...config.goalState],
        }]
        await wired.leader.seedLocalPlan({
          brief: config.brief,
          goalState: config.goalState.join(', '),
          crew: crewForPlan,
          tasks,
        })
      } else {
        tasks = await wired.leader.plan({
          brief: config.brief,
          goalState: config.goalState.join(', '),
          crew: crewForPlan,
        })
      }
      this.abortGuard()

      // ---- building: route (claims) then run the crew ----
      await wired.leader.route()
      this.setPhase('building')
      for (const task of tasks) {
        const holder = wired.f05.holdersOf(task.path)[0] ?? ''
        this.tasks.set(task.id, {
          id: task.id,
          file: task.path,
          holder,
          status: 'claimed',
        })
        this.emit('task.claimed', { runId, taskId: task.id, file: task.path, holder })
        if (holder !== '') this.setPresence(holder, this.roleOf(config, holder), 'working', task.id)
      }
      await this.hooks.afterPhase?.('building')
      this.abortGuard()

      const crewResult = await this.engine.runCrew(
        config.crew.engineers.map((e) => ({ modelId: e.id })),
        tasks,
        {
          dependencies: {
            bus: wired.hub,
            commons: wired.f07.commons,
            transport: wired.f07.transport,
            locks: wired.f07.locks,
            // Common-S: the State Contract exit-path writer — done/blocked/
            // handed_off entries land in the Brain before a worker leaves.
            contractWriter: wired.contractWriter,
          },
        },
      )
      for (const worker of crewResult.workers) {
        this.setPresence(worker.modelId, 'engineer', worker.retired ? 'retired' : 'idle')
      }
      this.abortGuard()

      // ---- auditing ----
      this.setPhase('auditing')
      await this.hooks.afterPhase?.('auditing')
      this.abortGuard()
      const artifacts = readWorkspaceArtifacts(runtime.config.memoryDir)
      const report: EngineScanReport = wired.scan(
        artifacts,
        config.crew.security.map((s) => s.id),
      )
      for (const finding of report.findings) {
        this.recordFinding(finding, false)
        this.emit('finding.raised', {
          runId,
          findingId: finding.id,
          severity: finding.severity,
          path: finding.path,
          line: finding.line,
          message: finding.message,
        })
      }
      await wired.persistFindings(report.findings)
      this.abortGuard()

      // ---- patching ----
      this.setPhase('patching')
      const remediation = await wired.remediateFindings(
        report.findings,
        {
          bus: createPatchingBus(runtime.config.memoryDir, () => this.clock.now()),
          artifacts: wired.f08.artifactStore,
          escalations: wired.f08.escalationQueue,
          now: () => this.clock.now(),
        },
        { maxRounds: 2 },
      )
      for (const finding of remediation.resolved) {
        const existing = this.findings.get(finding.id)
        if (existing !== undefined) this.findings.set(finding.id, { ...existing, resolved: true })
        this.emit('finding.resolved', { runId, findingId: finding.id })
      }
      this.abortGuard()

      // ---- reviewing ----
      this.setPhase('reviewing')
      await wired.f11.reviewAgent.review({
        runId,
        brief: config.brief,
        goalState: [...config.goalState],
        memoryDir: runtime.config.memoryDir,
        files: artifacts.map((a) => `WORKSPACE/${a.path}`),
      })
      // RETIRED in micro-phase E3 (app DECISIONS.log [E3-B1]). This block used
      // to re-persist the resolved-flagged findings after the review. History:
      //   - C1 added it because the f11 review agent overwrote STATE/findings.json
      //     wholesale (an engine defect, repaired in E1/R22 by merge-by-id);
      //   - it remained load-bearing after E1 because wired.remediateFindings
      //     RETURNED the remediation resolutions without PERSISTING them, so this
      //     call was the only writer of a resolved flag (E1 verification proved
      //     it: remove it and the run failed "pre-merge gate failed:
      //     critical-findings");
      //   - E2/R23 fixed that at the real site - the wiring now persists the
      //     resolutions through the same canonical merge-by-id writer.
      // The engine alone therefore reaches a passing pre-merge gate
      // (engine test src/wiring/remediation-persist.test.ts), and this call is
      // gone. Nothing else is needed here: the audit persist above records the
      // findings as open, the engine's remediation persist records the
      // resolutions, and R22's merge means the review agent's own persist can
      // only ever add to, never drop, those rows.
      this.abortGuard()

      // ---- merging: release claims, merge, verify, sign off ----
      this.setPhase('merging')
      this.releaseClaims(wired, tasks)
      this.lastManifest = await wired.merge(runtime.config.memoryDir, runtime.config.outputDir)
      this.lastVerification = await wired.leader.verify([...config.goalState])
      this.lastSignOff = await wired.leader.signOff() // emits run.completed on the hub

      if ((this.phase as string) !== 'completed') {
        // Defensive: signOff emits run.completed, but the ledger must agree.
        const completed = this.emit('run.completed', {
          runId,
          checksum: this.lastSignOff.checksum,
          fileCount: this.lastSignOff.fileCount,
        })
        this.phase = 'completed'
        this.endedAt = completed.at
      }
      return { runId }
    } catch (err) {
      if (this.phase !== 'failed') {
        this.releaseCurrentClaims()
        const failed = this.emit('run.failed', { runId, error: messageOf(err) })
        this.phase = 'failed'
        this.endedAt = failed.at
      }
      throw err
    } finally {
      this.running = false
      this.persistJournalPosition()
      this.teardownHub()
      this.currentWired = null
    }
  }

  private abortGuard(): void {
    if (this.aborted) throw new AbortSignal_()
  }

  /* ---------------- abort (CLI Ctrl-C equivalent) ---------------- */

  async abort(): Promise<DeckAbortResult> {
    const wired = this.currentWired
    if (!this.running || wired === null) {
      return { aborted: false, releasedLocks: 0 }
    }
    this.aborted = true
    const released = this.releaseCurrentClaims()
    // Exactly the CLI's Ctrl-C: run.failed 'aborted' on the shared hub.
    wired.hub.emit('run.failed', { runId: this.runId, error: 'aborted' })
    if (this.phase !== 'failed') {
      const failed = this.emit('run.failed', { runId: this.runId, error: 'aborted' })
      this.phase = 'failed'
      this.endedAt = failed.at
    }
    this.persistJournalPosition()
    return { aborted: true, releasedLocks: released }
  }

  private releaseCurrentClaims(): number {
    const wired = this.currentWired
    if (wired === null) return 0
    const held = [...this.tasks.values()]
      .map((t) => t.file)
      .filter((file) => file !== '')
    let released = 0
    for (const modelId of this.presence.keys()) {
      for (const file of new Set(held)) {
        wired.f05.release(modelId, [file])
        released += 1
      }
    }
    return released
  }

  private releaseClaims(wired: WiredDeck, tasks: readonly EngineTask[]): void {
    for (const task of tasks) {
      for (const holder of wired.f05.holdersOf(task.path)) {
        wired.f05.release(holder, [task.path])
      }
    }
  }

  /* ---------------- ledger bookkeeping ---------------- */

  private resetForRun(): void {
    this.journal = []
    this.tasks.clear()
    this.findings.clear()
    this.presence.clear()
    this.crewHealthLedger = []
    this.tokenInput = 0
    this.tokenOutput = 0
    this.phase = 'idle'
    this.startedAt = null
    this.endedAt = null
    this.runId = ''
    this.lastManifest = null
    this.lastSignOff = null
    this.lastVerification = []
    for (const sink of this.sinks) {
      sink.cursor = 0
      sink.scheduled = false
    }
  }

  private recordFinding(finding: EngineFinding, resolved: boolean): void {
    this.findings.set(finding.id, {
      id: finding.id,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      message: finding.message,
      resolved,
    })
  }

  private setPhase(phase: RunPhase): void {
    if (this.aborted) return
    this.phase = phase
    this.emit('phase.change', { runId: this.runId, phase })
    this.presenceForPhase(phase)
  }

  private seedPresence(config: DeckConfigInput): void {
    this.setPresence(config.crew.lead.id, 'lead', 'planning')
    for (const ref of config.crew.engineers) this.setPresence(ref.id, 'engineer', 'idle')
    for (const ref of config.crew.security) this.setPresence(ref.id, 'security', 'idle')
  }

  private presenceForPhase(phase: RunPhase): void {
    const leadBusy = phase === 'planning' || phase === 'reviewing' || phase === 'merging'
    this.setPresence(this.config.crew.lead.id, 'lead', leadBusy ? 'working' : 'idle')
    for (const ref of this.config.crew.engineers) {
      this.setPresence(ref.id, 'engineer', phase === 'building' ? 'working' : 'idle')
    }
    for (const ref of this.config.crew.security) {
      this.setPresence(ref.id, 'security', phase === 'auditing' || phase === 'patching' ? 'working' : 'idle')
    }
  }

  private setPresence(modelId: string, role: CrewRole, status: string, taskId?: string): void {
    this.presence.set(modelId, {
      modelId,
      role,
      status,
      ...(taskId === undefined ? {} : { taskId }),
    })
    this.emit('presence.update', {
      runId: this.runId,
      modelId,
      role,
      status,
      ...(taskId === undefined ? {} : { taskId }),
    })
  }

  private roleOf(config: DeckConfigInput, modelId: string): CrewRole {
    if (modelId === config.crew.lead.id) return 'lead'
    if (config.crew.security.some((s) => s.id === modelId)) return 'security'
    return 'engineer'
  }

  /* ---------------- hub -> journal -> ledger ---------------- */

  private subscribeHub(wired: WiredDeck, runId: string): void {
    const handlers: Array<{ event: string; handler: (payload: unknown) => void }> = []
    for (const name of HUB_EVENT_NAMES) {
      const handler = (payload: unknown): void => {
        this.onHubEvent(name, payload, runId)
      }
      wired.hub.on(name, handler)
      handlers.push({ event: name, handler })
    }
    this.hubTeardown = () => {
      for (const entry of handlers) wired.hub.off(entry.event, entry.handler)
    }
  }

  private onHubEvent(type: string, payload: unknown, runId: string): void {
    const event = normalizeHubEvent(type, payload, {
      runId,
      at: this.clock.now(),
      nextId: () => `evt-${String(++this.counter).padStart(6, '0')}`,
    })
    if (event === null) return
    this.journal.push(event)
    this.deliver()
    this.applyHubEventToLedger(event)
  }

  private applyHubEventToLedger(event: DeckEvent): void {
    switch (event.type) {
      case 'task.completed': {
        const existing = this.tasks.get(event.payload.taskId)
        this.tasks.set(event.payload.taskId, {
          id: event.payload.taskId,
          file: existing?.file ?? '',
          holder: existing?.holder ?? '',
          status: 'completed',
        })
        return
      }
      case 'task.failed': {
        const existing = this.tasks.get(event.payload.taskId)
        this.tasks.set(event.payload.taskId, {
          id: event.payload.taskId,
          file: existing?.file ?? '',
          holder: existing?.holder ?? '',
          status: 'failed',
        })
        return
      }
      case 'run.completed':
        this.phase = 'completed'
        this.endedAt = event.at
        return
      case 'run.failed':
        this.phase = 'failed'
        this.endedAt = event.at
        return
      default:
        return
    }
  }

  private teardownHub(): void {
    if (this.hubTeardown !== null) {
      this.hubTeardown()
      this.hubTeardown = null
    }
  }

  private persistJournalPosition(): void {
    if (this.journalDir === undefined) return
    try {
      fs.mkdirSync(this.journalDir, { recursive: true })
      const position = {
        runId: this.runId,
        phase: this.phase,
        journalLength: this.journal.length,
        at: this.clock.now(),
      }
      fs.writeFileSync(
        path.join(this.journalDir, 'position.json'),
        `${JSON.stringify(position, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // position persistence is best-effort; never fail a run over it
    }
  }

  /** Tear down everything (e.g. when the last window is gone). */
  dispose(): void {
    this.teardownHub()
    this.sinks.clear()
    this.currentWired = null
    this.currentRuntime = null
  }

  /* ---------------- introspection for the report/test ---------------- */

  lastRunManifest(): EngineManifest | null {
    return this.lastManifest
  }

  lastRunSignOff(): EngineSignOff | null {
    return this.lastSignOff
  }

  lastRunVerification(): readonly EngineVerificationResult[] {
    return this.lastVerification
  }

  crew(): BridgeCrew {
    return this.configView().crew
  }
}

/**
 * Internal signal used by `abortGuard` to unwind the run loop. Never escapes:
 * `run()` converts it into the `run.failed` path.
 */
class AbortSignal_ extends Error {
  constructor() {
    super('run aborted')
    this.name = 'DeckAbortSignal'
  }
}
