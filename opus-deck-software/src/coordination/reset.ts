/**
 * Phase 5: resetState() — full teardown of module state.
 */
import { resetConflicts } from './conflicts.js'
import { resetPresenceState } from './presence.js'
import { resetConfig } from './config.js'
import { setCommons } from './port.js'
import { stopHeartbeat } from './heartbeat.js'

export function resetState(): void {
  stopHeartbeat()
  resetConflicts()
  resetPresenceState()
  resetConfig()
  setCommons(null)
}
