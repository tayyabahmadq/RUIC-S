/**
 * The COMMONS handle this phase talks to. No default stub: the integrator
 * must call `setCommons(realCommons)` before any operation.
 */
import { CommonsError } from './errors.js'
import type { CommonsApi } from './types.js'

let commons: CommonsApi | null = null

/** Install the real COMMONS implementation. `null` unwires. */
export function setCommons(api: CommonsApi | null): void {
  commons = api
}

/** The currently installed COMMONS implementation. Throws if unwired. */
export function getCommons(): CommonsApi {
  if (commons === null) {
    throw new CommonsError(
      'commons_failed',
      'coordination CommonsApi not wired; call setCommons() before using phase 5',
    )
  }
  return commons
}

/** Run one operation against COMMONS so every failure leaving this phase is a CommonsError. */
export function callCommons<T>(what: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof CommonsError) throw error
    throw new CommonsError(
      'commons_failed',
      `commons ${what} failed`,
      error instanceof Error ? error.message : String(error),
    )
  }
}
