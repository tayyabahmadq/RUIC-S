/**
 * Opus//DECK — Phase 2: Model Registry & Transport.
 * Shared types for the model-calling layer.
 */

/** How a model is reached on the wire. Selects the transport adapter. */
export type ModelProviderKind = 'openai-compatible' | 'anthropic' | 'custom'

/**
 * Native reasoning depth for providers that expose a thinking/effort knob.
 * The five tiers follow Claude Code's `reasoning_effort` scale; Anthropic's
 * Messages API accepts all five via `output_config.effort` (GA), OpenAI-style
 * endpoints accept at least low/medium/high via `reasoning_effort`.
 * Opt-in only: unset means the wire body is unchanged.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A model endpoint registered in the ModelRegistry. */
export interface ModelRef {
  /** Registry-wide unique id. Also the usage-accounting key. */
  id: string
  provider: ModelProviderKind
  /**
   * - `openai-compatible`: base URL; `/chat/completions` is appended.
   * - `anthropic`: base URL; `/v1/messages` is appended.
   * - `custom`: fully-specified request URL, used verbatim.
   */
  endpoint: string
  /** Provider-side model name sent on the wire. */
  model: string
  /** Env var name that may hold the API key (checked before keystores/). */
  apiKeyEnv?: string
  /** Context window in tokens (config-layer field). */
  contextWindowTokens?: number
  /** Speed class hint (config-layer field). */
  speedClass?: 'fast' | 'standard' | 'heavy'
  /** Default max tokens when CompletionRequest.maxTokens is unset. */
  maxTokens?: number
  /** Default temperature when CompletionRequest.temperature is unset. */
  temperature?: number
  /** Extra headers merged into every provider request (applied last). */
  headers?: Record<string, string>
  /**
   * Native thinking depth for this model. When set, the adapter puts it on
   * the wire (openai-compatible/custom: `reasoning_effort`;
   * anthropic: `output_config.effort`). Unset = wire body unchanged.
   */
  reasoningEffort?: ReasoningEffort
}

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

/** One LLM completion request. */
export interface CompletionRequest {
  /** Registry id of the model to call. */
  modelId: string
  /** Convenience system prompt; merged as the first system message. */
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  /** Abort the request/stream immediately when signalled. */
  signal?: AbortSignal
}

export type TransportChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }

/** THE calling interface for the entire system. */
export interface Transport {
  complete(req: CompletionRequest): AsyncIterable<TransportChunk>
}

export interface HealthCheckResult {
  ok: boolean
  latencyMs: number
  detail?: string
}

/** Health probing implemented by every bundled adapter. */
export interface HealthProbe {
  probe(): Promise<HealthCheckResult>
}

/** Env lookup seam. */
export type EnvSource = Record<string, string | undefined>

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  factor: number
}

export interface RegistryOptions {
  keystoreDir?: string
  env?: EnvSource
  fetch?: FetchLike
}

export interface AdapterOptions {
  ref: ModelRef
  apiKey: string
  fetch?: FetchLike
  retry?: Partial<RetryPolicy>
  includeUsage?: boolean
}

export interface CreateTransportOptions {
  retry?: Partial<RetryPolicy>
  includeUsage?: boolean
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
}

export interface UsageReport {
  perModel: Record<string, ModelUsage>
  runWide: ModelUsage
}

/* Structural fetch seam. */
export interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock?(): void
}

export interface ReadableStreamLike {
  getReader(): ReaderLike
}

export interface FetchResponse {
  ok: boolean
  status: number
  statusText?: string
  body: ReadableStreamLike | null
  text(): Promise<string>
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

/** Config seam: provides model list + keystore dir. */
export interface RegistryConfigSource {
  load(): Promise<{ models: ModelRef[]; keystoreDir?: string }>
}
