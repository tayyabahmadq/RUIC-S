/**
 * Runtime helpers around the Transport contract: request validation and the
 * fetch default.
 */
import { z } from 'zod'
import { CommonsError, ErrorCodes, formatZodError } from './errors.js'
import type { CompletionRequest, FetchLike, Transport, TransportChunk } from './types.js'

export type { CompletionRequest, Transport, TransportChunk } from './types.js'

const ChatRoleSchema = z.enum(['system', 'user', 'assistant'])

const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
})

const CompletionRequestSchema = z.object({
  modelId: z.string().min(1),
  system: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
})

/** Validate an unknown value as CompletionRequest. Throws INVALID_REQUEST on failure. */
export function validateCompletionRequest(req: unknown): CompletionRequest {
  const result = CompletionRequestSchema.safeParse(req)
  if (!result.success) {
    throw new CommonsError(ErrorCodes.INVALID_REQUEST, 'invalid CompletionRequest', {
      detail: formatZodError(result.error),
    })
  }
  const signal = (req as { signal?: unknown }).signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new CommonsError(ErrorCodes.INVALID_REQUEST, 'invalid CompletionRequest', {
      detail: 'signal: must be an AbortSignal',
    })
  }
  return signal === undefined ? result.data : { ...result.data, signal }
}

/** Resolve the fetch implementation; global fetch by default. */
export function resolveFetch(provided?: FetchLike): FetchLike {
  if (provided !== undefined) return provided
  const globalFetch: unknown = globalThis.fetch
  if (typeof globalFetch !== 'function') {
    throw new CommonsError(
      ErrorCodes.RUNTIME_UNSUPPORTED,
      'global fetch is unavailable; pass options.fetch',
    )
  }
  return globalFetch as FetchLike
}

/** Narrow unknown JSON values to plain records. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** Coerce a provider token count to a clean non-negative integer. */
export function toTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/** Drop trailing slashes so base URLs concatenate cleanly. */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '')
}
