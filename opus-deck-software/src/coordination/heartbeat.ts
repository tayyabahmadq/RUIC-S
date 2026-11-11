/**
 * Phase 5: HEARTBEAT — one unref()'d timer per process.
 */
import { getConfig } from './config.js'
import { CommonsError } from './errors.js'
import { requirePositiveInt } from './validate.js'
import { refreshLocalWorkers, resetPresenceState } from './presence.js'
import type { HeartbeatOptions } from './types.js'

let timer: NodeJS.Timeout | null = null
let configuredInterval = 0

export function startHeartbeat(options: HeartbeatOptions = {}): void {
  if (timer !== null) throw new CommonsError('heartbeat_running', 'heartbeat is already running')
  const intervalMs = requirePositiveInt(options.intervalMs, 'intervalMs', 'config_invalid')
  configuredInterval = intervalMs
  const tick = () => {
    try {
      refreshLocalWorkers(Date.now())
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  tick()
}

let lastError: Error | null = null

export function stopHeartbeat(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  configuredInterval = 0
  lastError = null
}

export function isHeartbeatRunning(): boolean {
  return timer !== null
}

export function refreshHeartbeat(): number {
  return refreshLocalWorkers(Date.now())
}

export function lastHeartbeatError(): Error | null {
  return lastError
}
