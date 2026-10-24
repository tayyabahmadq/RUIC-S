/**
 * ModelRegistry — registers ModelRefs, resolves API keys
 * (env var named by apiKeyEnv -> keystores/<model id> file -> typed CommonsError),
 * and builds Transports.
 */
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { z } from 'zod'
import { AnthropicTransport } from './adapters/anthropic.js'
import { CustomTransport } from './adapters/custom.js'
import { OpenAiCompatibleTransport } from './adapters/openai-compatible.js'
import { CommonsError, ErrorCodes, formatZodError } from './errors.js'
import { resolveFetch } from './transport.js'
import type {
  CreateTransportOptions,
  EnvSource,
  FetchLike,
  HealthCheckResult,
  HealthProbe,
  ModelRef,
  RegistryOptions,
  Transport,
} from './types.js'

const ModelRefSchema = z.object({
  id: z.string().min(1),
  provider: z.enum(['openai-compatible', 'anthropic', 'custom']),
  endpoint: z.string().url(),
  model: z.string().min(1),
  apiKeyEnv: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  headers: z.record(z.string()).optional(),
})

/** Keystore filename for a model id: unsafe chars replaced with `__`. */
export function keystoreFileName(modelId: string): string {
  return modelId.replace(/[\\/:*?"<>|]/gu, '__')
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelRef>()
  private readonly keystoreDir: string
  private readonly env: EnvSource
  private readonly fetchImpl: FetchLike

  constructor(options: RegistryOptions = {}) {
    this.keystoreDir = options.keystoreDir ?? path.resolve(process.cwd(), 'keystores')
    this.env = options.env ?? process.env
    this.fetchImpl = resolveFetch(options.fetch)
  }

  /** Register a model. Throws INVALID_MODEL_REF or MODEL_ALREADY_REGISTERED. */
  register(ref: ModelRef): void {
    const result = ModelRefSchema.safeParse(ref)
    if (!result.success) {
      throw new CommonsError(ErrorCodes.INVALID_MODEL_REF, 'invalid ModelRef', {
        detail: formatZodError(result.error),
      })
    }
    const value: ModelRef = result.data
    if (this.models.has(value.id)) {
      throw new CommonsError(
        ErrorCodes.MODEL_ALREADY_REGISTERED,
        `model "${value.id}" is already registered`,
      )
    }
    this.models.set(value.id, Object.freeze({ ...value }))
  }

  /** Get a registered model (defensive copy). Throws MODEL_NOT_FOUND. */
  get(id: string): ModelRef {
    const ref = this.models.get(id)
    if (ref === undefined) {
      throw new CommonsError(ErrorCodes.MODEL_NOT_FOUND, `model "${id}" is not registered`, {
        detail: `known ids: ${[...this.models.keys()].join(', ') || '(none)'}`,
      })
    }
    return { ...ref }
  }

  /** All registered models, insertion order. */
  list(): ModelRef[] {
    return [...this.models.values()].map((ref) => ({ ...ref }))
  }

  /**
   * API key resolution order:
   *  1. env var named by ModelRef.apiKeyEnv (non-empty after trim)
   *  2. file `keystores/<model id>` (see keystoreFileName), trimmed
   *  3. CommonsError API_KEY_MISSING
   */
  resolveApiKey(id: string): string {
    const ref = this.get(id)
    if (ref.apiKeyEnv !== undefined) {
      const fromEnv = this.env[ref.apiKeyEnv]
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    }
    const filePath = path.join(this.keystoreDir, keystoreFileName(id))
    if (existsSync(filePath)) {
      let content = ''
      try {
        content = readFileSync(filePath, 'utf8')
      } catch (err) {
        throw new CommonsError(
          ErrorCodes.KEYSTORE_READ_FAILED,
          `failed to read keystore file for model "${id}"`,
          { detail: filePath, cause: err },
        )
      }
      const key = content.trim()
      if (key !== '') return key
    }
    throw new CommonsError(ErrorCodes.API_KEY_MISSING, `no API key for model "${id}"`, {
      detail: `set env ${ref.apiKeyEnv ?? '(no apiKeyEnv configured on ModelRef)'} or write ${filePath}`,
    })
  }

  /** Build the Transport for a model id (resolves the API key eagerly). */
  createTransport(id: string, options: CreateTransportOptions = {}): Transport {
    const ref = this.get(id)
    const apiKey = this.resolveApiKey(id)
    const adapterOptions = {
      ref,
      apiKey,
      fetch: this.fetchImpl,
      retry: options.retry,
      includeUsage: options.includeUsage,
    }
    switch (ref.provider) {
      case 'openai-compatible':
        return new OpenAiCompatibleTransport(adapterOptions)
      case 'anthropic':
        return new AnthropicTransport(adapterOptions)
      case 'custom':
        return new CustomTransport(adapterOptions)
      default:
        throw new CommonsError(ErrorCodes.UNSUPPORTED_PROVIDER, `unsupported provider: ${String(ref.provider)}`)
    }
  }

  /**
   * Health check against the provider (minimal 1-token completion probe).
   * - unknown id -> throws MODEL_NOT_FOUND
   * - missing/unreadable key -> resolves to { ok: false, detail: ... }
   * - provider/network failures -> { ok: false, detail }
   */
  async healthCheck(id: string): Promise<HealthCheckResult> {
    this.get(id) // throws MODEL_NOT_FOUND for unknown ids
    let transport: Transport
    try {
      transport = this.createTransport(id)
    } catch (err) {
      if (err instanceof CommonsError && (err.code === ErrorCodes.API_KEY_MISSING || err.code === ErrorCodes.KEYSTORE_READ_FAILED)) {
        return { ok: false, latencyMs: 0, detail: `${err.code}: ${err.message}` }
      }
      throw err
    }
    const probe = (transport as Partial<HealthProbe>).probe
    if (typeof probe !== 'function') {
      throw new CommonsError(
        ErrorCodes.UNSUPPORTED_PROVIDER,
        `model "${id}" transport does not support health probes`,
      )
    }
    return probe.call(transport)
  }
}
