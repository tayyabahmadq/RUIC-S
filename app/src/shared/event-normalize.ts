/**
 * Opus//DECK App — hub-event normalization.
 *
 * The engine's shared hub is untyped at its edges: `EventHub.emit(type, payload)`
 * carries `unknown` payloads, and the payloads the engine actually emits do not
 * all match the engine's own event catalog (for example the crew emits
 * `task.completed` as `{ taskId, modelId, intent }`, while the catalog declares
 * `{ runId, taskId, summary }`). Rather than trust the wire, this module parses
 * every payload defensively into the typed bridge vocabulary (R11: seams are
 * typed and round-tripped; R13: one canonical shape per data kind).
 *
 * A payload that cannot be parsed is dropped (`null`) — the journal only ever
 * contains well-typed bridge events. Nothing here writes `any`.
 */
import type { BridgeEventName, BridgeEventPayloads, CrewRole, DeckEvent, RunPhase, Severity } from './bridge-types'

export interface NormalizeContext {
  readonly runId: string
  readonly at: string
  readonly nextId: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function isSeverity(value: unknown): value is Severity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low'
}

function isRunPhase(value: unknown): value is RunPhase {
  return (
    value === 'idle' || value === 'planning' || value === 'building' || value === 'auditing' ||
    value === 'patching' || value === 'reviewing' || value === 'merging' || value === 'completed' ||
    value === 'failed'
  )
}

function isCrewRole(value: unknown): value is CrewRole {
  return value === 'lead' || value === 'engineer' || value === 'security'
}

/**
 * Build a typed journal event. This single cast is the only unchecked step:
 * the switch below guarantees the (type, payload) pairing, which TypeScript
 * cannot prove through a generic correlation. All CALL SITES stay fully typed
 * against `DeckEvent`.
 */
function make<K extends BridgeEventName>(
  type: K,
  payload: BridgeEventPayloads[K],
  ctx: NormalizeContext,
): DeckEvent {
  return { id: ctx.nextId(), type, payload, at: ctx.at } as DeckEvent
}

/**
 * Parse one hub emission into a typed bridge event, or `null` when the payload
 * does not satisfy the bridge contract.
 */
export function normalizeHubEvent(type: string, payload: unknown, ctx: NormalizeContext): DeckEvent | null {
  const p = isRecord(payload) ? payload : {}

  switch (type) {
    case 'run.started': {
      const brief = asString(p['brief'])
      const goalState = asStringArray(p['goalState'])
      if (brief === undefined || goalState === undefined) return null
      return make('run.started', { runId: asString(p['runId']) ?? ctx.runId, brief, goalState }, ctx)
    }

    case 'run.completed': {
      // The engine's leader.signOff emits { checksum, fileCount, at }.
      const checksum = asString(p['checksum']) ?? ''
      const fileCount = asNumber(p['fileCount']) ?? 0
      return make('run.completed', { runId: asString(p['runId']) ?? ctx.runId, checksum, fileCount }, ctx)
    }

    case 'run.failed': {
      // Engine callers emit several shapes ({ runId, error }, { error, modelId, taskId }).
      const error = asString(p['error']) ?? 'run failed'
      return make('run.failed', { runId: asString(p['runId']) ?? ctx.runId, error }, ctx)
    }

    case 'phase.change': {
      const phase = p['phase']
      if (!isRunPhase(phase)) return null
      return make('phase.change', { runId: asString(p['runId']) ?? ctx.runId, phase }, ctx)
    }

    case 'task.claimed': {
      const taskId = asString(p['taskId'])
      if (taskId === undefined) return null
      return make('task.claimed', {
        runId: asString(p['runId']) ?? ctx.runId,
        taskId,
        file: asString(p['file']) ?? '',
        holder: asString(p['claimedBy']) ?? asString(p['holder']) ?? '',
      }, ctx)
    }

    case 'task.completed': {
      const taskId = asString(p['taskId'])
      if (taskId === undefined) return null
      return make('task.completed', { runId: asString(p['runId']) ?? ctx.runId, taskId }, ctx)
    }

    case 'task.failed': {
      const taskId = asString(p['taskId'])
      if (taskId === undefined) return null
      return make('task.failed', {
        runId: asString(p['runId']) ?? ctx.runId,
        taskId,
        error: asString(p['error']) ?? 'task failed',
      }, ctx)
    }

    case 'finding.raised': {
      const findingId = asString(p['findingId'])
      const severity = p['severity']
      if (findingId === undefined || !isSeverity(severity)) return null
      return make('finding.raised', {
        runId: asString(p['runId']) ?? ctx.runId,
        findingId,
        severity,
        path: asString(p['path']) ?? '',
        line: asNumber(p['line']) ?? 0,
        message: asString(p['message']) ?? asString(p['description']) ?? '',
      }, ctx)
    }

    case 'finding.resolved': {
      const findingId = asString(p['findingId'])
      if (findingId === undefined) return null
      return make('finding.resolved', { runId: asString(p['runId']) ?? ctx.runId, findingId }, ctx)
    }

    case 'presence.update': {
      const modelId = asString(p['modelId'])
      const role = p['role']
      if (modelId === undefined || !isCrewRole(role)) return null
      const taskId = asString(p['taskId'])
      return make('presence.update', {
        runId: asString(p['runId']) ?? ctx.runId,
        modelId,
        role,
        status: asString(p['status']) ?? 'unknown',
        ...(taskId === undefined ? {} : { taskId }),
      }, ctx)
    }

    case 'token.use': {
      const inputTokens = asNumber(p['inputTokens'])
      const outputTokens = asNumber(p['outputTokens'])
      if (inputTokens === undefined || outputTokens === undefined) return null
      return make('token.use', { runId: asString(p['runId']) ?? ctx.runId, inputTokens, outputTokens }, ctx)
    }

    case 'memory.written': {
      const path = asString(p['path'])
      if (path === undefined) return null
      const txnId = p['txnId']
      return make('memory.written', {
        path,
        txnId: typeof txnId === 'number' ? String(txnId) : asString(txnId) ?? '',
        author: asString(p['author']) ?? '',
      }, ctx)
    }

    case 'review.requested': {
      return make('review.requested', {
        runId: asString(p['runId']) ?? ctx.runId,
        fileCount: asNumber(p['fileCount']) ?? 0,
        bundleCount: asNumber(p['bundleCount']) ?? 0,
      }, ctx)
    }

    case 'review.bundle.started': {
      const bundleId = asString(p['bundleId'])
      if (bundleId === undefined) return null
      return make('review.bundle.started', { bundleId, files: asStringArray(p['files']) ?? [] }, ctx)
    }

    case 'review.bundle.done': {
      const bundleId = asString(p['bundleId'])
      if (bundleId === undefined) return null
      return make('review.bundle.done', {
        bundleId,
        files: asStringArray(p['files']) ?? [],
        findings: asNumber(p['findings']) ?? 0,
        dropped: asNumber(p['dropped']) ?? 0,
      }, ctx)
    }

    case 'review.completed': {
      return make('review.completed', {
        runId: asString(p['runId']) ?? ctx.runId,
        requests: asNumber(p['requests']) ?? 0,
        findings: asNumber(p['findings']) ?? 0,
        dropped: asNumber(p['dropped']) ?? 0,
        reflections: asNumber(p['reflections']) ?? 0,
      }, ctx)
    }

    case 'compaction.requested': {
      return make('compaction.requested', { reason: asString(p['reason']) ?? 'compaction requested' }, ctx)
    }

    case 'compaction.done': {
      return make('compaction.done', { reason: asString(p['reason']) ?? 'compaction done' }, ctx)
    }

    case 'action.confirmed': {
      const confirmationId = asString(p['confirmationId'])
      if (confirmationId === undefined) return null
      return make('action.confirmed', {
        confirmationId,
        scope: asString(p['scope']) ?? '',
        action: asString(p['action']) ?? '',
      }, ctx)
    }

    case 'action.rejected': {
      return make('action.rejected', {
        reason: asString(p['reason']) ?? 'rejected',
        code: asString(p['code']) ?? 'CONFIRMATION_REJECTED',
        message: asString(p['message']) ?? 'confirmation refused',
      }, ctx)
    }

    case 'laya.routed': {
      const decision = p['decision']
      const score = asNumber(p['score'])
      const reasons = asStringArray(p['reasons'])
      if ((decision !== 'local' && decision !== 'decompose') || score === undefined || reasons === undefined) return null
      return make('laya.routed', { runId: asString(p['runId']) ?? ctx.runId, decision, score, reasons }, ctx)
    }

    case 'zeak.fallback': {
      const from = asString(p['from'])
      const to = asString(p['to'])
      const reason = asString(p['reason'])
      if (from === undefined || to === undefined || reason === undefined) return null
      const taskId = asString(p['taskId']) ?? null
      return make('zeak.fallback', { runId: asString(p['runId']) ?? ctx.runId, taskId, from, to, reason }, ctx)
    }

    case 'zeak.early_stop': {
      const chunks = asNumber(p['chunks'])
      if (chunks === undefined) return null
      const taskId = asString(p['taskId']) ?? null
      return make('zeak.early_stop', { runId: asString(p['runId']) ?? ctx.runId, taskId, chunks }, ctx)
    }

    case 'zeak.escalation': {
      const to = asString(p['to'])
      const attempt = asNumber(p['attempt'])
      if (to === undefined || attempt === undefined) return null
      const taskId = asString(p['taskId']) ?? null
      return make('zeak.escalation', { runId: asString(p['runId']) ?? ctx.runId, taskId, to, attempt }, ctx)
    }

    case 'collector.collected': {
      const topic = asString(p['topic'])
      const count = asNumber(p['count'])
      const via = asString(p['via'])
      if (topic === undefined || count === undefined || via === undefined) return null
      return make('collector.collected', { runId: asString(p['runId']) ?? ctx.runId, topic, count, via }, ctx)
    }

    case 'codegraph.rebuilt': {
      return make('codegraph.rebuilt', {
        files: asNumber(p['files']) ?? 0,
        clusters: asNumber(p['clusters']) ?? 0,
        hubs: asNumber(p['hubs']) ?? 0,
      }, ctx)
    }

    default:
      return null
  }
}

/** Every hub event name the main process subscribes to (union of engine-emitted and host-emitted). */
export const HUB_EVENT_NAMES: readonly string[] = [
  'run.started', 'run.completed', 'run.failed',
  'phase.change',
  'task.claimed', 'task.completed', 'task.failed',
  'finding.raised', 'finding.resolved',
  'presence.update',
  'token.use',
  'memory.written',
  'review.requested', 'review.bundle.started', 'review.bundle.done', 'review.completed',
  'compaction.requested', 'compaction.done',
  'action.confirmed', 'action.rejected',
  'codegraph.rebuilt',
]
