/**
 * opus-deck — Phase 2: Model Registry & Transport (public API).
 */
export { CommonsError, isCommonsError, ErrorCodes } from './errors.js'
export type { ErrorCode } from './errors.js'

export { ModelRegistry, keystoreFileName } from './registry.js'
export { validateCompletionRequest, resolveFetch } from './transport.js'
export { DEFAULT_RETRY_POLICY, withRetry, HttpStatusError, isRetryableError, sleep } from './retry.js'
export { SseParser } from './sse.js'

export {
  OpenAiCompatibleTransport,
} from './adapters/openai-compatible.js'
export {
  AnthropicTransport,
  ANTHROPIC_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} from './adapters/anthropic.js'
export { CustomTransport } from './adapters/custom.js'

export { UsageTracker, streamWithUsage } from './usage.js'

export type {
  AdapterOptions,
  ChatMessage,
  ChatRole,
  CompletionRequest,
  CreateTransportOptions,
  EnvSource,
  FetchInit,
  FetchLike,
  FetchResponse,
  HealthCheckResult,
  HealthProbe,
  ModelProviderKind,
  ModelRef,
  ModelUsage,
  ReaderLike,
  ReadableStreamLike,
  RegistryConfigSource,
  RegistryOptions,
  RetryPolicy,
  Transport,
  TransportChunk,
  UsageReport,
} from './types.js'
