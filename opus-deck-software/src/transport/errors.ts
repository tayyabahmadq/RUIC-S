/**
 * CommonsError for the transport phase.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'transport'
  readonly detail?: string

  constructor(code: string, message: string, options?: { detail?: string; cause?: unknown }) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    this.folder = 'transport'
    if (options?.detail !== undefined) {
      this.detail = options.detail
    }
    if (options?.cause) {
      this.cause = options.cause
    }
  }
}

export function isCommonsError(value: unknown): value is CommonsError {
  return value instanceof CommonsError
}

export type ErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_ALREADY_REGISTERED'
  | 'INVALID_MODEL_REF'
  | 'INVALID_REQUEST'
  | 'API_KEY_MISSING'
  | 'KEYSTORE_READ_FAILED'
  | 'UNSUPPORTED_PROVIDER'
  | 'TRANSPORT_HTTP'
  | 'TRANSPORT_NETWORK'
  | 'TRANSPORT_STREAM'
  | 'PROVIDER_STREAM_ERROR'
  | 'REQUEST_ABORTED'
  | 'RUNTIME_UNSUPPORTED'

export const ErrorCodes: {
  readonly MODEL_NOT_FOUND: 'MODEL_NOT_FOUND'
  readonly MODEL_ALREADY_REGISTERED: 'MODEL_ALREADY_REGISTERED'
  readonly INVALID_MODEL_REF: 'INVALID_MODEL_REF'
  readonly INVALID_REQUEST: 'INVALID_REQUEST'
  readonly API_KEY_MISSING: 'API_KEY_MISSING'
  readonly KEYSTORE_READ_FAILED: 'KEYSTORE_READ_FAILED'
  readonly UNSUPPORTED_PROVIDER: 'UNSUPPORTED_PROVIDER'
  readonly TRANSPORT_HTTP: 'TRANSPORT_HTTP'
  readonly TRANSPORT_NETWORK: 'TRANSPORT_NETWORK'
  readonly TRANSPORT_STREAM: 'TRANSPORT_STREAM'
  readonly PROVIDER_STREAM_ERROR: 'PROVIDER_STREAM_ERROR'
  readonly REQUEST_ABORTED: 'REQUEST_ABORTED'
  readonly RUNTIME_UNSUPPORTED: 'RUNTIME_UNSUPPORTED'
} = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_ALREADY_REGISTERED: 'MODEL_ALREADY_REGISTERED',
  INVALID_MODEL_REF: 'INVALID_MODEL_REF',
  INVALID_REQUEST: 'INVALID_REQUEST',
  API_KEY_MISSING: 'API_KEY_MISSING',
  KEYSTORE_READ_FAILED: 'KEYSTORE_READ_FAILED',
  UNSUPPORTED_PROVIDER: 'UNSUPPORTED_PROVIDER',
  TRANSPORT_HTTP: 'TRANSPORT_HTTP',
  TRANSPORT_NETWORK: 'TRANSPORT_NETWORK',
  TRANSPORT_STREAM: 'TRANSPORT_STREAM',
  PROVIDER_STREAM_ERROR: 'PROVIDER_STREAM_ERROR',
  REQUEST_ABORTED: 'REQUEST_ABORTED',
  RUNTIME_UNSUPPORTED: 'RUNTIME_UNSUPPORTED',
}

export function formatZodError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error)
  }
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues
  if (!Array.isArray(issues)) {
    return String(error)
  }
  return issues
    .map((issue) => {
      const path = issue.path ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
