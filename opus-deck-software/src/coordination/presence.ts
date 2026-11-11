/**
 * Phase 5: PRESENCE — one table (STATE/presence.json) = awareness.
 * This phase is the SOLE writer of STATE/presence.json.
 */
import { getConfig } from './config.js'
import { CommonsError } from './errors.js'
import { requireModelId, requireTimestamp } from './validate.js'
import {
  assertPresenceEntry,
  readPresenceStore,
  writePresenceStore,
} from './store.js'
import type { PresenceEntry, PresencePatch } from './types.js'

const localWorkers = new Map<string, { taskId?: string; file?: string }>()

export function upsert(modelId: string, patch: PresencePatch): PresenceEntry {
  const id = requireModelId(modelId, 'presence_invalid')
  if (typeof patch !== 'object' || patch === null) {
    throw new CommonsError('presence_invalid', 'upsert() expects a patch object', typeof patch)
  }
  const now = requireTimestamp(patch.lastSyncAt, 'patch.lastSyncAt', 'presence_invalid')

  const table = readPresenceStore()
  const index = table.findIndex((entry) => entry.modelId === id)
  const previous = index >= 0 ? table[index] : undefined
  const next = mergeEntry(previous, patch, id, now)
  assertPresenceEntry(next, `presence entry for ${id}`)

  if (index >= 0) table[index] = next
  else table.push(next)
  writePresenceStore(table)

  localWorkers.set(id, { taskId: next.taskId, file: next.file })
  return next
}

export function snapshot(): PresenceEntry[] {
  const table = readPresenceStore()
  const cutoff = Date.now() - getConfig().stalenessMs
  const fresh = table.filter((entry) => entry.lastSyncAt >= cutoff)
  if (fresh.length !== table.length) writePresenceStore(fresh)
  return fresh.sort((a, b) => compare(a.modelId, b.modelId))
}

export function findEntry(modelId: string): PresenceEntry | undefined {
  const id = requireModelId(modelId, 'presence_invalid')
  return readPresenceStore().find((entry) => entry.modelId === id)
}

export function localWorkerIds(): string[] {
  return [...localWorkers.keys()]
}

export function refreshLocalWorkers(now: number): number {
  const timestamp = requireTimestamp(now, 'now', 'presence_invalid')
  const ids = [...localWorkers.keys()]
  if (ids.length === 0) return 0

  const table = readPresenceStore()
  let touched = 0
  for (const id of ids) {
    const cached = localWorkers.get(id)
    const index = table.findIndex((entry) => entry.modelId === id)
    const previous = index >= 0 ? table[index] : undefined
    const next: PresenceEntry = previous
      ? { ...previous, lastSyncAt: timestamp }
      : { modelId: id, lastSyncAt: timestamp }

    if (previous === undefined) {
      if (cached?.taskId !== undefined) next.taskId = cached.taskId
      if (cached?.file !== undefined) next.file = cached.file
    }
    assertPresenceEntry(next, `heartbeat entry for ${id}`)

    if (index >= 0) table[index] = next
    else table.push(next)
    touched += 1
  }
  writePresenceStore(table)
  return touched
}

export function resetPresenceState(): void {
  localWorkers.clear()
}

function mergeEntry(previous: PresenceEntry | undefined, patch: PresencePatch, modelId: string, now: number): PresenceEntry {
  const next: PresenceEntry = previous ? { ...previous, modelId, lastSyncAt: now } : { modelId, lastSyncAt: now }
  if (Object.prototype.hasOwnProperty.call(patch, 'taskId')) {
    assignOptional(next, 'taskId', patch.taskId)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'file')) {
    assignOptional(next, 'file', patch.file)
  }
  return next
}

function assignOptional(entry: PresenceEntry, key: 'taskId' | 'file', value: string | undefined): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new CommonsError('presence_invalid', `patch.${key} must be a string`, String(value))
  }
  entry[key] = value
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
