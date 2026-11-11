/**
 * Opus//DECK — Phase 11: Wiring / composition root.
 *
 * The ONLY place components meet. Assembles all phases into one running
 * plugin around a single shared EventBus (no isolated module-default buses).
 *
 * wireOpusDeck() is called after initOpusDeck() and produces the real
 * cross-phase implementations.
 */
import { openCommons, setClaimsAuthority } from '../commons/index.js'
import type { Commons as F03Commons } from '../commons/types.js'
import {
  setCommons as f05SetCommons,
  acquire, release, holdersOf,
  upsert, snapshot, syncSince, drainQueue,
} from '../coordination/index.js'
import { RealCommonsApi } from './coordination-commons-api.js'
import { Compactor, estimateTokens } from '../compactor/index.js'
import { F04CommonsAdapter } from './f04-commons-adapter.js'
import { LeaderCommonsAdapter } from './leader-commons-adapter.js'
import { ClaimsAdapter } from './claims-adapter.js'
import { ConflictsAdapter } from './conflicts-adapter.js'
import { Leader, ReviewQueue } from '../leader/index.js'
import type { Transport as F06Transport } from '../leader/types.js'
import { EventHub, hubBus } from './event-hub.js'
import { F06TransportAdapter, F04TransportAdapter, F07TransportClient } from './transport-adapter.js'
import { F07CommonsClient } from './f07-commons-client.js'
import { F07LockClient } from './f07-lock-client.js'
import { f07SetDefaultBus, f07SetDefaultSystemPrompt } from '../crew/index.js'
import { createTaskBus, createArtifactStore, createEscalationQueue } from './task-bus-glue.js'
import { merge as f09Merge, writeReport as f09WriteReport } from '../merge/index.js'
import { scanAll as f08ScanAll, remediateFindings as f08RemediateFindings, planRemediationBatch as f08PlanRemediationBatch } from '../audit/index.js'
import { createConfirmant, createRemediationBatchGate } from './confirmations.js'
import type { Confirmant, RemediationBatchGate } from './confirmations.js'
import { loadPersonas } from './personas.js'
import type { PersonaRegistry } from './personas.js'
import { resolveGateSeverity } from './severity-config.js'
import type { FailOnSeverity } from './severity-config.js'
import type {
  BatchAuthorization, BatchConfirmationGate, BatchConfirmationRequest, RemediationDeps, RemediationOptions,
} from '../audit/types.js'
import type { Transport as F02Transport } from '../transport/types.js'
import type { OpusDeckRuntime } from '../config/types.js'
import type { Manifest } from '../merge/types.js'
import type { ScanReport, Finding as F08Finding, RuleId } from '../audit/types.js'
import { ReviewAgent, createReviewAgent, listRules } from '../f11/index.js'
import type { PersistedFinding } from '../f11/index.js'
import { createCodegraph, fingerprintSourceTree } from '../f12/index.js'
import type { CodegraphResult } from '../f12/types.js'
import { Brain } from '../state/index.js'
import type { EmbedFn } from '../state/index.js'
import { route as layaRoute } from '../routing/laya.js'
import type { LayaDecision, LayaInput } from '../routing/laya.js'
import { zeakWrap } from '../zeak/zeak.js'
import { runLearningCycle } from '../zeak/learning.js'
import { ollamaChatComplete } from '../state/ollama.js'
import { collectTopic, GitHubCollector, BrowserCollector, WebFetchCollector, createSerialQueue } from '../depts/data-collection.js'
import { AgentReachCollector } from '../depts/agent-reach.js'
import type { Collector } from '../depts/data-collection.js'
import { f07SetDefaultContractWriter, f07SetDefaultFailureRecorder, f07SetDefaultGuides } from '../crew/index.js'
import * as nodePath from 'node:path'

/**
 * R10: the single memory.written emission point. Wraps phase-03 commons so
 * every successful write emits { path, txnId, author } on the shared hub.
 * Commons itself never touches a bus (folder-03 contract).
 */
function emitMemoryWritten(commons: F03Commons, hub: EventHub): F03Commons {
  return {
    read: (path, range) => commons.read(path, range),
    write: async (args) => {
      const txnId = await commons.write(args)
      hub.emit('memory.written', { path: args.path, txnId, author: args.author })
      return txnId
    },
    decide: (args) => commons.decide(args),
    sync: (since) => commons.sync(since),
    who: () => commons.who(),
    search: (query) => commons.search(query),
  }
}

export interface WireOptions {
  transport: F02Transport
  leadModelId: string
  auditorModelIds: string[]
  /**
   * Phase 4: default confirmation lifetime in ms (default 15 minutes, R7).
   * Passed through to the per-process confirmant; not persisted anywhere.
   */
  confirmationTtlMs?: number
  /**
   * Phase 4 policy switch. `true` (v1 default) = auto-issue-and-record: a
   * multi-file remediation batch is confirmed by the deck itself so shipped
   * flows stay unattended. `false` requires the caller to pre-issue a token via
   * `confirmations.issue(batchScope(...))` and pass `confirmationToken` — the
   * upgrade path towards prior human confirmation.
   */
  confirmationAutoIssue?: boolean
  /**
   * Phase 3 (gate severity, R5): explicitly-passed runtime config — the
   * HIGHEST-precedence source for `gate.failOn`. When absent the value comes
   * from `<memoryDir>/STATE/config.json`, and when that is absent too the
   * shipped default "critical" applies.
   */
  gate?: { failOn?: FailOnSeverity }
  /**
   * Common-S v2 (Tier 1-4). All optional — absent = shipped behavior with a
   * Brain that has no embedder (vector ops degrade gracefully).
   */
  commonS?: {
    /** Embedder for the vector store (e.g. Ollama nomic-embed-text). */
    embed?: EmbedFn
    /** Zeak: the free local fallback model id in the registry. */
    fallbackModelId?: string
    /** Zeak: per-department token caps for one run. */
    departmentCaps?: Record<string, number>
    /** Zeak: one-shot Security re-escalation budget. Default 1. */
    escalationBudget?: number
    /** Cache-gate similarity threshold. Default 0.9 (conservative). */
    cacheThreshold?: number
    /** Hard vector cap (RAM budget). Default 2000. */
    vectorCap?: number
    /** Zeak v2 learning-loop knobs. */
    learning?: {
      enabled?: boolean
      minOccurrences?: number
      guideCap?: number
      guideTokenBudget?: number
      staleDays?: number
    }
  }
}

export interface WiredDeck {
  runtime: OpusDeckRuntime
  hub: EventHub
  /** Folder-02 transport (Zeak-wrapped in v2) for f11 review agent (R3: direct LLM calls, not f07 queue). */
  transport: F02Transport
  commons: F03Commons
  /**
   * Phase 3 (personas): the boot-linted persona registry loaded from
   * `<memoryDir>/CREW/personas`. Presence-driven: a role with NO persona file
   * falls back to the shipped built-in prompt, so shipped behavior never
   * depends on a persona file existing.
   */
  personas: PersonaRegistry
  /**
   * Phase 3 (gate severity, R5): THE resolved `gate.failOn` value. Resolved
   * ONCE here (explicit runtime config -> STATE/config.json -> "critical") and
   * injected into both consumers — the f09 merge gate and the f08 escalation
   * threshold. Neither consumer parses the file itself.
   */
  gate: { failOn: FailOnSeverity }
  leader: Leader
  reviewQueue: ReviewQueue
  compactor: Compactor
  /** Phase 4: the per-process single-use confirmation service (v1: in-memory). */
  confirmations: Confirmant
  /** Phase 4: the batch confirmation scope for these findings, or null when the
   *  batch is single-file (no confirmation required). */
  remediationBatchScope: (findings: readonly F08Finding[]) => string | null
  /** Phase 11: the review agent. */
  f11: {
    reviewAgent: ReturnType<typeof createReviewAgent>
    listRules: typeof listRules
  }
  /** Phase 12: the workspace codegraph (knowledge-graph memory). */
  f12: {
    codegraph: ReturnType<typeof createCodegraph>
    rebuildCodegraph: () => Promise<CodegraphResult>
  }
  f05: {
    upsert: typeof upsert
    snapshot: typeof snapshot
    acquire: typeof acquire
    release: typeof release
    holdersOf: typeof holdersOf
    syncSince: typeof syncSince
    drainQueue: typeof drainQueue
  }
  f07: {
    commons: F07CommonsClient
    transport: F07TransportClient
    locks: F07LockClient
    /**
     * Phase 3 (personas): the engineer persona body (undefined = no persona
     * file, i.e. shipped behavior). Callers running the crew pass it as
     * `CrewDependencies.systemPrompt`; wiring also retargets the crew default.
     */
    systemPrompt: string | undefined
  }
  f08: {
    taskBus: ReturnType<typeof createTaskBus>['bus']
    remediationQueue: ReturnType<typeof createTaskBus>['queue']
    artifactStore: ReturnType<typeof createArtifactStore>
    escalationQueue: ReturnType<typeof createEscalationQueue>['queue']
    escalations: ReturnType<typeof createEscalationQueue>['entries']
    /** Phase 4: the multi-file remediation batch gate (single-use tokens). */
    batchConfirmation: RemediationBatchGate
  }
  scan: (artifacts: { path: string; code: string }[], auditors: string[]) => ScanReport
  remediateFindings: (
    findings: readonly F08Finding[],
    deps: { bus: ReturnType<typeof createTaskBus>['bus']; artifacts: ReturnType<typeof createArtifactStore>; escalations: ReturnType<typeof createEscalationQueue>['queue']; now?: () => string; confirmations?: BatchConfirmationGate },
    options?: { maxRounds?: number; confirmationToken?: string; confirmationAutoIssue?: boolean },
  ) => Promise<{
    rounds: number; tasks: readonly any[]; accepted: number; rejected: number;
    resolved: readonly any[]; unresolved: readonly any[]; escalations: readonly any[]; advisories: readonly any[];
    batch?: BatchConfirmationRequest; batchAuthorization?: BatchAuthorization;
  }>
  merge: (memoryDir: string, outputDir: string) => Promise<Manifest>
  writeReport: (memoryDir: string, outPath: string) => Promise<string>
  persistFindings: (findings: readonly F08Finding[]) => Promise<void>
  /** Common-S v2: the Brain (contracts + vectors + task flags). */
  brain: Brain
  /** Common-S v2: Laya routing decision for one instruction. */
  laya: (input: LayaInput) => Promise<LayaDecision>
  /** Common-S v2: Dept 2 — cache-gate first collection through the seam. */
  collect: (topic: string) => ReturnType<typeof collectTopic>
  /** Common-S v2: contract writer factory for crew deps (exit-path writes). */
  contractWriter: NonNullable<import('../crew/types.js').CrewDependencies['contractWriter']>
}

export async function wireOpusDeck(runtime: OpusDeckRuntime, options: WireOptions): Promise<WiredDeck> {
  const memoryDir = runtime.config.memoryDir

  // --- Phase 3: personas (persona-as-data). BOOT-TIME LINT: an invalid
  // persona file aborts boot with a precise error (file + key + expected vs
  // found); a missing file — or no CREW/ directory at all — never does: the
  // role falls back to its shipped built-in prompt.
  const personas = loadPersonas(memoryDir)
  const leadPersona = personas.get('lead')
  const engineerPersona = personas.get('engineer')
  const reviewerPersona = personas.get('reviewer')

  // --- Phase 3 (R5): gate severity. ONE source, resolved ONCE here:
  // explicit runtime config -> STATE/config.json -> default "critical"
  // (shipped behavior). Both consumers below read this exact value; neither
  // parses the file independently.
  const gateFailOn = resolveGateSeverity({
    ...(options.gate?.failOn === undefined ? {} : { explicit: options.gate.failOn }),
    memoryDir,
  })

  // --- Shared event hub (all phases converge here) ---
  const hub = new EventHub()
  // Retarget crew's default bus (used by buildPrompt) to the shared hub so
  // compaction.requested reaches the compactor subscribed below.
  f07SetDefaultBus(hub)

  // --- Common-S v2: the Brain (Tier 1 core) ---
  const cs = options.commonS ?? {}
  const brain = new Brain(memoryDir, cs.embed ?? null, { vectorCap: cs.vectorCap })
  await brain.init()
  // State Contract exit-path enforcement: wiring installs the Brain-backed
  // writer as the crew default (per-worker deps.contractWriter still wins).
  f07SetDefaultContractWriter(async (input) => {
    await brain.writeContract(input)
  })
  // Triangular Loop heartbeat: after EVERY sub-task (completion or failure),
  // queue a serialized compaction cycle. Brain.requestCompaction guarantees
  // one-at-a-time; the Compactor's own running-flag + fingerprint dedupe the
  // digest pass. Vector decay + contract fold run inside the serialized cycle.
  const triggerDigestCompaction = (): void => {
    void hub.emit('compaction.requested', {})
  }
  hub.subscribe('task.completed', (payload: unknown) => {
    const taskId = (payload as { taskId?: unknown } | null)?.taskId
    void brain.requestCompaction(triggerDigestCompaction).catch(() => undefined)
    if (typeof taskId === 'string') void brain.setTaskFlags(taskId, {}).catch(() => undefined)
  })
  hub.subscribe('task.failed', () => {
    void brain.requestCompaction(triggerDigestCompaction).catch(() => undefined)
  })

  // --- Zeak v2: the learning loop (the Teacher) ---------------------------
  // Model 2 (find pattern) + Model 3 (verify) run on the FREE local Qwen,
  // triggered after every compaction cycle. Serialized through its own
  // chain; Ollama-down degrades to deterministic clustering. Guides live in
  // STATE/guides.md (backed up on every change) and are PROTECTED tokens.
  const learning = cs.learning ?? {}
  const learningEnabled = learning.enabled !== false
  const learningOptions = {
    ...(learning.minOccurrences !== undefined ? { minOccurrences: learning.minOccurrences } : {}),
    ...(learning.guideCap !== undefined ? { guideCap: learning.guideCap } : {}),
    ...(learning.staleDays !== undefined ? { staleDays: learning.staleDays } : {}),
    chat: (prompt: string, system: string): Promise<string | null> =>
      ollamaChatComplete('qwen2.5-coder:1.5b', [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ], { numCtx: 32768 }),
    emit: (event: string, payload: unknown) => void hub.emit(event, payload),
  }
  let learningQueue: Promise<void> = Promise.resolve()
  if (learningEnabled) {
    hub.subscribe('compaction.done', () => {
      learningQueue = learningQueue
        .then(async () => { await runLearningCycle(brain, learningOptions) })
        .catch(() => undefined)
    })
    // Exit-path TRY BOX recording + guide provider (the "clean" arrow).
    f07SetDefaultFailureRecorder(async (input: { taskId: string; modelId: string; method: string; errorDetail: string }) => {
      return brain.recordFailure(input)
    })
    f07SetDefaultGuides(async () => {
      // Cap: guide tokens are protected, but bounded — the sketch's "prompts
      // stay small" rule. Default 500 tokens (~2000 chars) of guide lines.
      const budgetChars = (learning.guideTokenBudget ?? 500) * 4
      const raw = await brain.readGuides()
      const lines = raw.split(String.fromCharCode(10)).filter((l) => l.startsWith('- '))
      const out: string[] = []
      let used = 0
      for (const line of lines.reverse()) {
        if (used + line.length > budgetChars) break
        out.unshift(line)
        used += line.length
      }
      return out.join(String.fromCharCode(10))
    })
  }

  // --- Common-S v2: Zeak (Tier 4 economic layer) wraps the ONE transport
  // seam every phase shares. Over-cap falls back to the free local model,
  // loudly (zeak.fallback + a durable zeakFallback flag on Brain state).
  const zeakSpend = { departments: {} as Record<string, number>, escalationsUsed: 0 }
  const zeakBudgets = {
    departments: cs.departmentCaps ?? { engineering: 60_000, security: 30_000, deep_thinking: 120_000 },
    escalations: cs.escalationBudget ?? 1,
  }
  const transport = zeakWrap(options.transport, {
    budgets: zeakBudgets,
    brain,
    events: { emit: (event, payload) => void hub.emit(event, payload) },
    fallbackModelId: cs.fallbackModelId ?? 'local-executor',
    ...(cs.cacheThreshold !== undefined ? { cacheThreshold: cs.cacheThreshold } : {}),
  })

  // --- Phase 3: COMMONS (single source of truth) ---
  // R10: memory.written is emitted from the wiring layer — commons itself
  // stays bus-free per its folder-03 contract. ONE emission point: this
  // write-delegating wrapper emits { path, txnId, author } on the shared hub
  // after every successful write through the wired commons.
  const f03: F03Commons = emitMemoryWritten(await openCommons(memoryDir), hub)
  // Phase 3: retarget the crew's engineer persona (module-default seam, same
  // pattern as the bus). undefined restores shipped behavior.
  f07SetDefaultSystemPrompt(engineerPersona === undefined ? undefined : engineerPersona.systemPrompt)

  // --- Phase 4: single-use confirmations (R7: per-process, in-memory secret) ---
  // Created here, at wire time: the secret is generated once per process and is
  // never persisted, so tokens cannot outlive the run that minted them.
  const confirmations = createConfirmant({ sink: hub, ttlMs: options.confirmationTtlMs })
  const wireAutoIssue = options.confirmationAutoIssue ?? true
  const batchConfirmation = createRemediationBatchGate(confirmations, { autoIssue: wireAutoIssue })

  /** The exact scope a caller must issue against to pre-confirm this batch. */
  function remediationBatchScopeFor(findings: readonly F08Finding[]): string | null {
    const request = f08PlanRemediationBatch(findings)
    return request === null ? null : batchConfirmation.scopeFor(request)
  }

  // --- Phase 5: coordination (presence, claims, locks) ---
  const f05Api = new RealCommonsApi(memoryDir)
  f05SetCommons(f05Api)

  // Claims authority: phase-3 write() gate consults coordination's holdersOf.
  setClaimsAuthority((p: string) => {
    try { const h = holdersOf(p); return h[0] ?? undefined } catch { return undefined }
  })

  // --- Phase 6: Leader dependencies ---
  const f06Commons = new LeaderCommonsAdapter(f03, memoryDir)
  const claims = new ClaimsAdapter(acquire, release, holdersOf)
  const conflicts = new ConflictsAdapter()
  const bus = hubBus(hub)
  const f06Transport = new F06TransportAdapter(transport)
  const leader = new Leader({
    transport: f06Transport as unknown as F06Transport,
    commons: f06Commons,
    claims,
    conflicts,
    bus,
    // Phase 4: vetoes confirm before their follow-up task is routed.
    confirmations,
    // Phase 3 (personas): the lead persona body drives the plan() system
    // prompt; absent = the shipped built-in planner prompt.
    ...(leadPersona === undefined ? {} : { leadSystemPrompt: leadPersona.systemPrompt }),
  })
  const reviewQueue = leader.reviewQueue

  // --- Phase 4: Compactor (watch() at startup on the shared hub) ---
  const f04Commons = new F04CommonsAdapter(f03, memoryDir)
  const f04Transport = new F04TransportAdapter(transport, options.leadModelId)
  const compactor = new Compactor(
    { transport: f04Transport, commons: f04Commons, bus: hub },
    { llmModel: 'compactor-small', digestTokenBudget: runtime.config.budgets.digestTokens },
  )
  compactor.watch()

  // --- Phase 7: Crew deps ---
  const f07Commons = new F07CommonsClient(f03, memoryDir)
  const f07Transport = new F07TransportClient(transport)
  const f07Locks = new F07LockClient(acquire, release)

  // --- Phase 8: Audit glue ---
  const taskBus = createTaskBus()
  const artifactStore = createArtifactStore(memoryDir)
  const escalationQueue = createEscalationQueue({
    onPush: async (escalation) => {
      await reviewQueue.decide({
        workerId: escalation.detectorModelId,
        touched: [escalation.path, escalation.ruleId],
        rationale: escalation.detail,
      })
    },
  })

  // --- Phase 11: Review Agent ---
  const f11ReviewAgent = createReviewAgent({
    hub,
    commons: f03,
    transport,
    estimateTokens,
    holdersOf: (p: string) => Promise.resolve(holdersOf(p)),
    persistFindings: (findings: readonly PersistedFinding[]) =>
      persistFindings(f11FindingsToF08(findings)),
    escalationQueue: escalationQueue.queue,
    auditorModelIds: options.auditorModelIds,
    reviewModelId: options.leadModelId,
    // Phase 3 (personas): the reviewer persona body drives every review/reflect
    // call's system prompt; absent = the shipped built-in reviewer prompt.
    ...(reviewerPersona === undefined ? {} : { reviewerSystemPrompt: reviewerPersona.systemPrompt }),
  })

  // --- Phase 12: CodeGraph (workspace knowledge-graph memory) ---
  const f12Codegraph = createCodegraph({
    commons: f03,
    bus: hub,
    memoryDir,
    sourceTree: 'WORKSPACE',
    tokenCap: runtime.config.budgets.digestTokens,
  })

  // Rebuild trigger (roadmap Phase 2): a rate-limited hook on commons
  // events. Filter: only writes whose path sits under the source tree
  // (WORKSPACE) qualify. Fingerprint-gated: an identical source-tree state
  // never triggers a second rebuild. All failures are swallowed — a
  // rebuild must never break the hub that carries it.
  let f12LastFingerprint: string | null = null
  const f12SourceRoot = nodePath.join(memoryDir, 'WORKSPACE')
  hub.subscribe('memory.written', (payload: unknown) => {
    try {
      const path = (payload as { path?: unknown } | null)?.path
      if (typeof path !== 'string') return
      if (path !== 'WORKSPACE' && !path.startsWith('WORKSPACE/')) return
      void (async () => {
        try {
          const fp = await fingerprintSourceTree(f12SourceRoot)
          if (fp === f12LastFingerprint) return
          await f12Codegraph.rebuild()
          f12LastFingerprint = fp
        } catch {
          // never let a failed scheduled rebuild escape into the hub
        }
      })()
    } catch {
      // never throw out of a hub handler
    }
  })

  // Findings persistence (A7): STATE/findings.json via phase-03 atomic write.
  // Accepts the canonical f08 finding shape; f11's PersistedFinding[] is adapted
  // at the wiring boundary via f11FindingsToF08.
  async function persistFindings(findings: readonly F08Finding[]): Promise<void> {
    // R22 (E1): STATE/findings.json is never uninformed-dropped. The file is
    // the MERGE of everything every producer has reported this process plus
    // whatever it already held — producers differ in what they see (the f11
    // review agent persists only its own re-scan; a remediation re-persist
    // carries the audit's resolved flags), so a wholesale overwrite erased
    // sibling rows and un-resolved preserved resolutions. Merge semantics:
    //   - rows are keyed by finding id;
    //   - an EXISTING row keeps every field the incoming row does not carry
    //     (its identity fields survive a narrower incoming write);
    //   - `resolved` can only ever go UP: an incoming unresolved row never
    //     clears an existing resolution (a resolution is withdrawn only by an
    //     explicit re-verification flow, none existing in v1);
    //   - a file-sourced row never seen again survives (stale, unchecked rows
    //     are harmless to the gates: only unresolved at-or-above-threshold
    //     rows block, and that is the persisted truth).
    interface PersistedRow {
      id: string
      severity: F08Finding['severity']
      path: string
      line?: number
      detector: string
      resolved: boolean
    }
    const rows = new Map<string, PersistedRow>()
    try {
      const raw = await f03.read('STATE/findings.json')
      const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      const list = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown[] } | null)?.findings
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item === null || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          if (typeof row.id !== 'string' || row.id === '') continue
          rows.set(row.id, {
            id: row.id,
            severity: (row.severity === 'high' || row.severity === 'medium' || row.severity === 'low'
              ? row.severity : 'critical') as F08Finding['severity'],
            path: typeof row.path === 'string' ? row.path : '',
            ...(typeof row.line === 'number' ? { line: row.line } : {}),
            detector: typeof row.detector === 'string' ? row.detector : 'unknown',
            resolved: row.resolved === true,
          })
        }
      }
    } catch {
      // not found or unparsable — first write
    }
    for (const f of findings) {
      const incoming: PersistedRow = {
        id: f.id,
        severity: f.severity,
        path: f.path,
        ...(f.line !== undefined ? { line: f.line } : {}),
        detector: f.detectorModelId,
        resolved: !!f.resolved,
      }
      const prev = rows.get(incoming.id)
      rows.set(incoming.id, prev === undefined
        ? incoming
        : {
            ...prev,
            ...incoming,
            resolved: prev.resolved || incoming.resolved,
          })
    }
    const content = JSON.stringify([...rows.values()], null, 2)
    let current = ''
    try { current = await f03.read('STATE/findings.json') } catch { }
    await f03.write({
      path: 'STATE/findings.json',
      diff: { added: content.split('\n'), removedLineCount: current ? splitLines(current) : 0, atLine: 1 },
      intent: 'audit findings', author: 'audit',
    })
  }

  // Adapter (R13): f11's PersistedFinding[] → canonical F08Finding[]. Single
  // translation point between f11's internal shape and the canonical COMMONS
  // findings schema used by merge and report. f11's `detector` is the reviewer
  // model id and lands on the canonical `detectorModelId`.
  function f11FindingsToF08(findings: readonly PersistedFinding[]): F08Finding[] {
    return findings.map((f) => ({
      id: f.id, ruleId: f.ruleId as RuleId, severity: f.severity, path: f.path,
      line: f.line ?? 0,
      detectorModelId: f.detector, resolved: !!f.resolved,
      evidence: f.evidence, message: f.message, patchStrategy: f.patchStrategy,
      auditorCount: 1, blocking: f.blocking,
    }))
  }

  function splitLines(c: string): number {
    if (c === '') return 0
    const lines = c.split(/\r?\n/)
    if (c.endsWith('\n')) lines.pop()
    return lines.length
  }

  return {
    runtime, hub, transport, commons: f03, leader, reviewQueue, compactor,
    confirmations,
    personas,
    brain,
    laya: (input: LayaInput) => layaRoute(input, brain, 0),
    collect: (topic: string) => {
      // Dept 2 fallback chain: FREE budget first (GitHub REST), then direct
      // web fetch (WebFetchCollector: robots + SSRF-guard + size-capped),
      // then browser time (Agent-Reach: login-walled/video/Chinese platforms;
      // Obscura Browser joins the same queue when the host wires a launch
      // callback). Cache-gate already ran above: repeat research never
      // reaches any of them.
      const enqueue = createSerialQueue()
      const github = new GitHubCollector({
        ...(process.env.GITHUB_TOKEN !== undefined ? { token: process.env.GITHUB_TOKEN } : {}),
      })
      const web = new WebFetchCollector()
      const agentReach = new AgentReachCollector({
        events: { emit: (event, payload) => void hub.emit(event, payload) },
        enqueue,
        channels: ['websearch', 'github'],
      })
      const collectors: readonly Collector[] = [github, web, agentReach]
      return collectTopic(topic, {
        brain,
        collectors,
        events: { emit: (event, payload) => void hub.emit(event, payload) },
        ...(cs.cacheThreshold !== undefined ? { cacheThreshold: cs.cacheThreshold } : {}),
      })
    },
    contractWriter: async (input) => {
      await brain.writeContract(input)
    },
    gate: { failOn: gateFailOn },
    remediationBatchScope: remediationBatchScopeFor,
    f05: { upsert, snapshot, acquire, release, holdersOf, syncSince, drainQueue },
    f07: {
      commons: f07Commons,
      transport: f07Transport,
      locks: f07Locks,
      systemPrompt: engineerPersona === undefined ? undefined : engineerPersona.systemPrompt,
    },
    f08: {
      taskBus: taskBus.bus,
      remediationQueue: taskBus.queue,
      artifactStore,
      escalationQueue: escalationQueue.queue,
      escalations: escalationQueue.entries,
      batchConfirmation,
    },
    f11: {
      reviewAgent: f11ReviewAgent,
      listRules,
    },
    f12: {
      codegraph: f12Codegraph,
      rebuildCodegraph: () => f12Codegraph.rebuild(),
    },
    scan: (artifacts: { path: string; code: string }[], auditors: string[]): ScanReport =>
      f08ScanAll(artifacts, auditors),
    remediateFindings: async (findings, deps, options = {}) => {
      // Phase 4: a multi-file batch executes only against a consumed
      // confirmation. The gate is injected here (composition root) so the audit
      // folder itself stays policy-free; a caller-supplied gate wins.
      const gate = deps.confirmations ?? createRemediationBatchGate(confirmations, {
        autoIssue: options.confirmationAutoIssue ?? wireAutoIssue,
        ...(options.confirmationToken === undefined ? {} : { token: options.confirmationToken }),
      })
      // Phase E2 (R23): remediating a finding is only REAL once the resolution
      // is in STATE/findings.json, which is what the pre-merge gate reads.
      // f08's remediateFindings returns the resolutions but never persists them,
      // so before this the ONLY writer of a resolved flag was a caller (the C1
      // shell's post-review re-persist). Persisting here, through the canonical
      // R22 merge-by-id writer, makes the engine alone sufficient: the resolved
      // rows merge onto whatever the file already holds and `resolved` can only
      // ever go up (R22), so this is idempotent and never uninformed-drops.
      const remediationDeps: RemediationDeps = { ...deps, confirmations: gate }
      const remediationOptions: RemediationOptions = {
        ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
        ...(options.confirmationToken === undefined ? {} : { confirmationToken: options.confirmationToken }),
        // Phase 3 (R5): THE resolved gate severity is injected here, once, and
        // overrides any per-call value — the escalation threshold and the merge
        // gate are driven by this single value (WireOptions.gate / STATE/config.json).
        failOn: gateFailOn,
      }
      const result = await f08RemediateFindings(findings, remediationDeps, remediationOptions)
      if (result.resolved.length > 0) await persistFindings(result.resolved)
      return result
    },
    // Phase 3 (R5): the merge gate's severity-thresholded blocking reads the
    // SAME resolved value as the audit escalation threshold above.
    merge: (memoryDir: string, outputDir: string) => f09Merge(memoryDir, outputDir, { failOn: gateFailOn }),
    writeReport: f09WriteReport,
    persistFindings,
  }
}
