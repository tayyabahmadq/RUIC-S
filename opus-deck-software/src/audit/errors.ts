/**
 * CommonsError for the audit phase.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'audit' = 'audit'
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

export function isCommonsError(value: unknown): value is CommonsError {
  return value instanceof CommonsError
}

export const FOLDER_ID: 'audit' = 'audit'
