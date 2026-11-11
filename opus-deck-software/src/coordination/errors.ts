/**
 * CommonsError for the coordination phase.
 */
export class CommonsError extends Error {
  readonly code: string
  readonly folder: 'coordination' = 'coordination'
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

export const COMMONS_ERROR_CODES: readonly [
  'config_invalid',
  'presence_invalid',
  'claims_invalid',
  'tasks_invalid',
  'path_invalid',
  'sync_invalid',
  'commons_failed',
  'heartbeat_running',
  'heartbeat_failed',
] = [
  'config_invalid',
  'presence_invalid',
  'claims_invalid',
  'tasks_invalid',
  'path_invalid',
  'sync_invalid',
  'commons_failed',
  'heartbeat_running',
  'heartbeat_failed',
]
