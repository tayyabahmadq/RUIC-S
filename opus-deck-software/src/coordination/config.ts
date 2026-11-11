/**
 * Phase 5: configuration. Env/override resolution: configure(), resetConfig(), getConfig().
 */
import { CommonsError } from './errors.js'
import { requirePositiveInt } from './validate.js'
import type {
  CommonsConfig,
  ConfigureOptions,
} from './types.js'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALENESS_MS,
  ENV_HEARTBEAT_MS,
  ENV_STALENESS_MS,
} from './types.js'

let stalenessOverride: number | undefined
let heartbeatOverride: number | undefined

export function configure(options: ConfigureOptions): void {
  if (options.stalenessMs !== undefined) {
    stalenessOverride = requirePositiveInt(options.stalenessMs, 'stalenessMs', 'config_invalid')
  }
  if (options.heartbeatIntervalMs !== undefined) {
    heartbeatOverride = requirePositiveInt(options.heartbeatIntervalMs, 'heartbeatIntervalMs', 'config_invalid')
  }
}

export function resetConfig(): void {
  stalenessOverride = undefined
  heartbeatOverride = undefined
}

export function getConfig(): CommonsConfig {
  const staleness = stalenessOverride ?? envPositiveInt(ENV_STALENESS_MS, DEFAULT_STALENESS_MS)
  const heartbeat = heartbeatOverride ?? envPositiveInt(ENV_HEARTBEAT_MS, DEFAULT_HEARTBEAT_INTERVAL_MS)
  return { stalenessMs: staleness, heartbeatIntervalMs: heartbeat }
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = typeof process !== 'undefined' && process.env ? process.env[name] : undefined
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return fallback
  return n
}
