/**
 * Opus//DECK App — deterministic test seams.
 *
 * Every value a test needs to be exact (a clock, a transport, a health probe,
 * a memory directory, a canonical serializer) lives here so the bridge-contract,
 * reconstruction, keys and Electron tests all drive the SAME scripted engine
 * conversation. Nothing here is imported by production code.
 *
 * The scripted transport answers the engine's real prompts by inspecting the
 * request: plan (TASK_DECOMPOSITION), verify (CRITERION_VERIFICATION), the f11
 * reviewer, the compactor, and finally the engineering crew's write-intent.
 * That is the exact set of transport calls `DeckHost.run()` provokes.
 */
import { mkdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DeckConfigInput } from '../shared/bridge-types'
import type {
  EngineCompletionRequest,
  EngineHealthResult,
  EngineTransport,
  EngineTransportChunk,
} from '../engine/engine-contract'
import type { DeckClock } from '../main/deck-host'
import type { BuiltTransport } from '../main/transport-factory'

/**
 * The hardcoded secret the scripted crew writes into the audited artifact.
 * This is the AUDIT TARGET (the workspace's own offending literal) — the
 * findings feed is expected to quote it back to the operator. It is NOT the
 * R19 "key material" sentinel; see `SCRIPTED_MODEL_KEY`.
 */
export const SCRIPTED_SECRET = 'sk-prod-9f3a2b1cdeadbeef42'
/**
 * MODEL-ACCESS key material (R19): the credential a crew model would use to
 * call its endpoint. It exists only in main's environment / keystore and must
 * NEVER cross the bridge, in any surface, in any form.
 */
export const SCRIPTED_MODEL_KEY = 'model-key-MUST-NEVER-CROSS-THE-BRIDGE-0001'
/** The env var name main resolves `SCRIPTED_MODEL_KEY` from (folder-02 order). */
export const SCRIPTED_MODEL_KEY_ENV = 'DECK_SCRIPTED_MODEL_KEY'
/** The model ids whose keystore files main would fall back to. */
export const SCRIPTED_KEYSTORE_IDS = ['lead', 'eng-1', 'sec-1', 'sec-2'] as const
/** The WORKSPACE-relative artifact the scripted crew writes. */
export const SCRIPTED_FILE = 'src/app.ts'
/** The dirty artifact body — exactly one SEC-004 (env-var, auto-patchable). */
export const SCRIPTED_SOURCE = `export const API_TOKEN = "${SCRIPTED_SECRET}";\n`
/** The task id the scripted planner emits. */
export const SCRIPTED_TASK_ID = 'T-01'

/** The lead/engineer/security model ids the scripted config declares. */
export const SCRIPTED_MODEL_IDS = {
  lead: 'lead',
  engineers: ['eng-1'],
  security: ['sec-1', 'sec-2'],
} as const

/* ------------------------------------------------------------------ *
 * Clock
 * ------------------------------------------------------------------ */

/** A clock that advances exactly one second per read — run timings are exact. */
export class FixedClock implements DeckClock {
  private ms: number

  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.ms = startMs
  }

  now(): string {
    const at = new Date(this.ms).toISOString()
    this.ms += 1000
    return at
  }

  nowMs(): number {
    return this.ms
  }
}

/* ------------------------------------------------------------------ *
 * Config / health / transport
 * ------------------------------------------------------------------ */

export function scriptedConfig(memoryDir: string): DeckConfigInput {
  return {
    memoryDir,
    outputDir: path.join(memoryDir, 'OUTPUT'),
    brief: 'ship a trivial greeting application',
    goalState: ['app builds'],
    crew: {
      lead: { id: 'lead', provider: 'custom', model: 'lead-model', contextWindowTokens: 8192, endpoint: 'http://localhost:11434' },
      engineers: [
        { id: 'eng-1', provider: 'custom', model: 'eng-model', contextWindowTokens: 8192, endpoint: 'http://localhost:11434' },
      ],
      security: [
        { id: 'sec-1', provider: 'custom', model: 'sec-model', contextWindowTokens: 8192, endpoint: 'http://localhost:11434' },
        { id: 'sec-2', provider: 'custom', model: 'sec-model-2', contextWindowTokens: 8192, endpoint: 'http://localhost:11434' },
      ],
    },
  }
}

export const scriptedHealthCheck = async (modelId: string): Promise<EngineHealthResult> => ({
  ok: true,
  latencyMs: 1,
  detail: `scripted health ok for ${modelId}`,
})

const PLAN_JSON = JSON.stringify([
  {
    id: SCRIPTED_TASK_ID,
    path: SCRIPTED_FILE,
    description: 'Write the application entry file',
    acceptance: ['app builds'],
  },
])

const WRITE_INTENT_JSON = JSON.stringify({
  intent: 'write the application entry file',
  path: SCRIPTED_FILE,
  added: [SCRIPTED_SOURCE.replace(/\n$/, '')],
  atLine: 1,
  removedLineCount: 0,
})

const VERIFY_JSON = JSON.stringify({
  satisfied: true,
  evidence: `${SCRIPTED_FILE}:1 declares the API token`,
})

const EMPTY_FINDINGS_JSON = '[]'

const COMPACTOR_MD = [
  'ARCH',
  '- single-file application',
  '',
  'IFACE',
  '- API_TOKEN constant',
  '',
  'OPEN',
  '- none',
  '',
  'SETTLED',
  '- none',
  '',
  'PINS',
  '- keep API_TOKEN',
].join('\n')

/** Classify one engine transport request into the scripted reply. */
function scriptedReply(req: EngineCompletionRequest): string {
  const system = req.system ?? ''
  const user = req.messages.map((message) => message.content).join('\n')
  const both = `${system}\n${user}`
  if (both.includes('TASK_DECOMPOSITION')) return PLAN_JSON
  if (both.includes('CRITERION_VERIFICATION')) return VERIFY_JSON
  if (both.includes('security reviewer')) return EMPTY_FINDINGS_JSON
  if (both.includes('candidate security findings') || both.includes('false positive')) {
    return EMPTY_FINDINGS_JSON
  }
  if (both.includes('build memory digest') || both.includes('Compress the following chunk')) {
    return COMPACTOR_MD
  }
  return WRITE_INTENT_JSON
}

/**
 * The scripted engine transport. EVERY call — crew calls included — streams the
 * full canonical phase-02 chunk grammar a REAL adapter emits: text, then usage,
 * then a terminal `done`.
 *
 * History (E2/B3): while the engine worker still had its pre-E1 bug (every
 * non-text chunk JSON.stringify'd into the write-intent text, via the
 * now-deleted `stringifyChunk` fall-through), crew calls had to be special-cased
 * to emit a single text chunk or the shipped tests would have failed. That
 * workaround meant the shipped suite COULD NOT catch the E1 defect class: it
 * only ever met text-only stubs. Engine micro-phase E1 (R21) fixed the consumer,
 * so the seam now mirrors reality and the suite catches the defect class
 * natively. The engine covers the same grammar from its own side in
 * `src/crew/realistic-stream.test.ts`.
 *
 * Crew calls additionally carry one post-`done` probe chunk: both the crew
 * worker (E1/R21) and the leader adapter (E2/R24) must stop at `done`, so this
 * probe fails loudly if either regressed into concatenating past the terminator.
 * It is a deliberate over-delivery probe, not realism.
 */
export function scriptedTransport(): EngineTransport {
  return {
    complete(req: EngineCompletionRequest): AsyncIterable<EngineTransportChunk> {
      const text = scriptedReply(req)
      const system = req.system ?? ''
      const user = req.messages.map((message) => message.content).join('\n')
      const crewCall = `${system}\n${user}`.includes('## 4. My Task')
      return (async function* (): AsyncGenerator<EngineTransportChunk> {
        yield { type: 'text', text }
        yield { type: 'usage', inputTokens: 120, outputTokens: 80 }
        yield { type: 'done', finishReason: 'stop' }
        // Unreachable: `done` terminates the stream on every consumer.
        if (crewCall) yield { type: 'text', text: 'POST-DONE-LEAK-MUST-NOT-BE-CONSUMED' }
      })()
    },
  }
}

/** The scripted `BuiltTransport` main would otherwise build from the real factory. */
export function scriptedBuiltTransport(): BuiltTransport {
  return { transport: scriptedTransport(), healthCheck: scriptedHealthCheck }
}

/* ------------------------------------------------------------------ *
 * Serialization / misc helpers
 * ------------------------------------------------------------------ */

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key])
    return out
  }
  return value
}

/** Deterministic JSON with recursively sorted keys — used for equality asserts. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** First-occurrence dedupe by `id`. */
export function dedupeById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** A fresh, isolated COMMONS root under the approved temp directory. */
export function makeTempMemoryDir(label: string): string {
  const base = path.join(os.tmpdir(), 'opencode', 'deck-app-tests')
  const dir = path.join(
    base,
    `${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
