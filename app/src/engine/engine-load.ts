/**
 * Opus//DECK App — Engine loader.
 *
 * The ONE place where the engine's CommonJS output crosses into the app. The
 * dynamic `require()` returns an untyped value; after a runtime conformance
 * check it is cast to the declared contract in `engine-contract.ts`. No `any`
 * is written here — the value stays `unknown` until the conformance check has
 * proven the shape, and every cast is from `unknown`, never from `any`.
 *
 * R18: the engine workspace is read-only. The shell never writes to it.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  EngineCrewModule,
  EngineEntryModule,
  EngineTransportModule,
  EngineWiringModule,
  InitOpusDeck,
  ModelRegistryCtor,
  RunCrew,
  WireOpusDeck,
} from './engine-contract'

const nodeRequire = createRequire(__filename)

/** The engine workspace root (overridable for tests / packaging). */
export function resolveEngineRoot(): string {
  const override = process.env['OPUS_DECK_ENGINE_DIR']
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim())
  // app/src|dist/engine/engine-load.js -> up three levels lands on studio root
  return path.resolve(__dirname, '..', '..', '..', 'opus-deck-software')
}

function engineDistFile(engineRoot: string, ...segments: string[]): string {
  return path.join(engineRoot, 'dist', ...segments)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`engine contract violation: ${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function requireFunction(source: Record<string, unknown>, key: string, label: string): unknown {
  const value = source[key]
  if (typeof value !== 'function') {
    throw new Error(`engine contract violation: ${label}.${key} is not a function`)
  }
  return value
}

function requireEngineFile(file: string): unknown {
  if (!fs.existsSync(file)) {
    throw new Error(
      `engine module not found at ${file}. Build the engine first: cd opus-deck-software && npm run build`,
    )
  }
  return nodeRequire(file)
}

export interface LoadedEngine {
  readonly engineRoot: string
  readonly initOpusDeck: InitOpusDeck
  readonly wireOpusDeck: WireOpusDeck
  readonly runCrew: RunCrew
  readonly ModelRegistry: ModelRegistryCtor
}

let cached: LoadedEngine | null = null

/**
 * Load and conformance-check the engine modules. Cached per process.
 *
 * NOTE (reported, not patched): `wireOpusDeck`, `runCrew` and `ModelRegistry`
 * are not re-exported from the engine's public barrel `src/index.ts`
 * (`package.json` `types` points at a `dist/index.d.ts` that is never emitted,
 * because the engine tsconfig sets no `declaration: true`). The shell therefore
 * loads the engine's compiled `dist/` modules directly. See PROVENANCE.md
 * "Proposed additive engine exports (NOT applied)".
 */
export function loadEngine(): LoadedEngine {
  if (cached !== null) return cached
  const engineRoot = resolveEngineRoot()

  const entry = asRecord(requireEngineFile(engineDistFile(engineRoot, 'index.js')), 'index.js') as
    EngineEntryModule & Record<string, unknown>
  const initOpusDeck = requireFunction(entry, 'initOpusDeck', 'index.js') as InitOpusDeck

  const wiring = asRecord(requireEngineFile(engineDistFile(engineRoot, 'wiring', 'index.js')), 'wiring') as
    EngineWiringModule & Record<string, unknown>
  const wireOpusDeck = requireFunction(wiring, 'wireOpusDeck', 'wiring/index.js') as WireOpusDeck

  const crew = asRecord(requireEngineFile(engineDistFile(engineRoot, 'crew', 'index.js')), 'crew') as
    EngineCrewModule & Record<string, unknown>
  const runCrew = requireFunction(crew, 'runCrew', 'crew/index.js') as RunCrew

  const transport = asRecord(requireEngineFile(engineDistFile(engineRoot, 'transport', 'index.js')), 'transport') as
    EngineTransportModule & Record<string, unknown>
  const registryCtor = requireFunction(transport, 'ModelRegistry', 'transport/index.js') as ModelRegistryCtor

  cached = { engineRoot, initOpusDeck, wireOpusDeck, runCrew, ModelRegistry: registryCtor }
  return cached
}
