/**
 * CommonsError for the compactor phase.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'compactor' = 'compactor'
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
