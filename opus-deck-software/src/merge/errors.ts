/**
 * CommonsError for the merge phase.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'merge' = 'merge'
  readonly detail?: string

  constructor(message: string, code: string, detail?: string) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
    }
  }
}
