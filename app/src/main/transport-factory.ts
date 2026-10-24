/**
 * Opus//DECK App — main-process transport factory (R19).
 *
 * Key resolution NEVER crosses the bridge. It happens here, in main, using the
 * engine's own ModelRegistry, in the engine's documented folder-02 order:
 *
 *   1. the environment variable named by the model's `apiKeyEnv`, then
 *   2. the file `keystores/<model id>` (see `keystoreFileName`), then
 *   3. the engine raises API_KEY_MISSING.
 *
 * The renderer never supplies `apiKeyEnv` and never receives key material:
 * the env-var NAME for a model is derived in main from
 * `OPUS_DECK_KEY_ENV_<SANITIZED_MODEL_ID>` (default: unset, which falls
 * through to the keystore file). Keys are only ever handed to the engine's
 * adapter constructors, inside this process.
 */
import * as path from 'node:path'
import type { DeckConfigInput, BridgeModelRef } from '../shared/bridge-types'
import type { EngineHealthResult, EngineModelRegistry, EngineTransport, EngineTransportChunk } from '../engine/engine-contract'
import type { LoadedEngine } from '../engine/engine-load'

/** Registry keystore directory (folder-02 order), app-overridable. */
export function resolveKeystoreDir(engineRoot: string): string {
  const override = process.env['OPUS_DECK_KEYSTORE_DIR']
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim())
  return path.join(engineRoot, 'keystores')
}

function defaultEndpoint(provider: BridgeModelRef['provider']): string | undefined {
  switch (provider) {
    case 'openai-compatible': return 'https://api.openai.com/v1'
    case 'anthropic': return 'https://api.anthropic.com'
    case 'custom': return undefined
    default: return undefined
  }
}

function envVarNameFor(modelId: string): string {
  return `OPUS_DECK_KEY_ENV_${modelId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/** Register one crew model and build its engine transport (key resolved in main). */
function buildModelTransport(registry: EngineModelRegistry, ref: BridgeModelRef): EngineTransport {
  const endpoint = ref.endpoint ?? defaultEndpoint(ref.provider)
  if (endpoint === undefined) {
    throw new Error(`model "${ref.id}": provider "custom" requires an explicit endpoint`)
  }
  // Common-S: a local Ollama model needs no real key, but the engine's key
  // resolution is mandatory — satisfy it with the OLLAMA_API_KEY env var
  // (any value; Ollama ignores the Authorization header).
  const isOllama = /(?:localhost|127\.0\.0\.1):11434/.test(endpoint)
  if (isOllama && (process.env.OLLAMA_API_KEY ?? '').length === 0) {
    process.env.OLLAMA_API_KEY = 'ollama-local'
  }
  const apiKeyEnv = process.env[envVarNameFor(ref.id)] ?? (isOllama ? 'OLLAMA_API_KEY' : undefined)
  registry.register({
    id: ref.id,
    provider: ref.provider,
    endpoint,
    model: ref.model,
    contextWindowTokens: ref.contextWindowTokens,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(ref.speedClass === undefined ? {} : { speedClass: ref.speedClass }),
    ...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
  })
  return registry.createTransport(ref.id)
}

export interface UsageSnapshot { readonly inputTokens: number; readonly outputTokens: number }

/** Wrap a transport so every `usage` chunk is reported to the host counter. */
export function withUsageAccounting(
  transport: EngineTransport,
  onUsage: (usage: UsageSnapshot) => void,
): EngineTransport {
  return {
    complete(req) {
      const inner = transport.complete(req)
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<EngineTransportChunk> {
          for await (const chunk of inner) {
            if (chunk.type === 'usage') {
              onUsage({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens })
            }
            yield chunk
          }
        },
      }
    },
  }
}

export interface BuiltTransport {
  readonly transport: EngineTransport
  readonly healthCheck: (modelId: string) => Promise<EngineHealthResult>
}

/**
 * Build the single routing transport the engine's composition root consumes.
 * Model ids the engine uses internally (for example the compactor's
 * `compactor-small`) fall back to the lead model's transport, mirroring the
 * engine's own adapter defaults.
 */
export function buildEngineTransport(config: DeckConfigInput, engine: LoadedEngine): BuiltTransport {
  const registry = new engine.ModelRegistry({ keystoreDir: resolveKeystoreDir(engine.engineRoot) })

  const lead = buildModelTransport(registry, config.crew.lead)
  const byId = new Map<string, EngineTransport>()
  byId.set(config.crew.lead.id, lead)
  for (const ref of [...config.crew.engineers, ...config.crew.security]) {
    byId.set(ref.id, buildModelTransport(registry, ref))
  }

  const transport: EngineTransport = {
    complete(req) {
      const chosen = byId.get(req.modelId) ?? lead
      return chosen.complete(req)
    },
  }

  return {
    transport,
    healthCheck: (modelId: string) => registry.healthCheck(modelId),
  }
}
