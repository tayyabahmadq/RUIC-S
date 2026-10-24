/**
 * CommonsError — the single failure type thrown by every phase.
 * Every failure leaves as a CommonsError so callers can catch one type.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'config'
  readonly detail?: string

  constructor(code: string, message: string, options?: { detail?: string; cause?: unknown }) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    this.folder = 'config'
    if (options?.detail !== undefined) {
      this.detail = options.detail
    }
    if (options?.cause) {
      this.cause = options.cause
    }
  }
}
