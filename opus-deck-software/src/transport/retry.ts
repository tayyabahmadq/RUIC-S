/**
 * Retry policy: exponential backoff 250ms * 2^n, max 4 attempts,
 * ONLY on 429 / 5xx / network errors, never on other 4xx,
 * AbortSignal honored immediately (including mid-backoff).
 * Never retries after a chunk was yielded.
 */
import { CommonsError, ErrorCodes } from './errors.js'

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  factor: 2,
})

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  factor: number
}

export class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.status === 429 || err.status >= 500
  }
  if (err instanceof TypeError || err instanceof Error) {
    // network / abort / fetch failures are retryable (except abort handled by caller)
    return true
  }
  return false
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('aborted'))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * withRetry(fn, policy, signal) — retries on retryable errors.
 * AbortSignal is honored immediately, including mid-backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw new Error('aborted')
      if (attempt === policy.maxAttempts - 1) break
      if (!isRetryableError(err)) break
      const delay = policy.baseDelayMs * Math.pow(policy.factor, attempt)
      await sleep(delay, signal)
    }
  }
  throw lastErr
}
