/**
 * CommonsError for the f12 codegraph phase.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'f12' = 'f12'
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
    }
  }
}
