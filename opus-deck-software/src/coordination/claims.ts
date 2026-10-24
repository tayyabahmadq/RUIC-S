/**
 * Phase 5: CLAIMS — file-level locks over WORKSPACE paths.
 * STATE/tasks.json is the authoritative store.
 */
import { clearQueuedConflict, enqueueConflict } from './conflicts.js'
import { canonicalPath, normalizePath, normalizePathSet } from './paths.js'
import { findEntry } from './presence.js'
import { isClaimRow, readTaskRows, writeTaskRows } from './store.js'
import { requireModelId } from './validate.js'
import type { AcquireResult, ClaimRow, TaskRecord } from './types.js'

export function acquire(modelId: string, pathSet: string[]): AcquireResult {
  const id = requireModelId(modelId, 'claims_invalid')
  const paths = normalizePathSet(pathSet)
  const rows = readTaskRows()

  for (const path of paths) {
    const blocker = firstForeignHolder(rows, path, id)
    if (blocker !== undefined) {
      enqueueConflict(id, paths, blocker)
      return { queuedBehind: blocker }
    }
  }

  const held = new Set<string>()
  for (const row of rows) {
    if (isClaimRow(row) && row.modelId === id) held.add(canonicalPath(row.path))
  }
  const missing = paths.filter((path) => !held.has(path))
  if (missing.length === 0) {
    clearQueuedConflict(id, paths)
    return 'granted'
  }

  const now = Date.now()
  const taskId = findEntry(id)?.taskId
  const additions = missing.map((path) => makeClaimRow(id, path, now, taskId))
  writeTaskRows([...rows, ...additions])
  clearQueuedConflict(id, paths)
  return 'granted'
}

export function release(modelId: string, pathSet: string[]): void {
  const id = requireModelId(modelId, 'claims_invalid')
  const paths = new Set(normalizePathSet(pathSet))
  const rows = readTaskRows()
  let removed = 0
  const kept = rows.filter((row) => {
    if (isClaimRow(row) && row.modelId === id && paths.has(canonicalPath(row.path))) {
      removed += 1
      return false
    }
    return true
  })
  if (removed > 0) writeTaskRows(kept)
}

export function releaseAll(modelId: string): number {
  const id = requireModelId(modelId, 'claims_invalid')
  const rows = readTaskRows()
  const kept = rows.filter((row) => !(isClaimRow(row) && row.modelId === id))
  const removed = rows.length - kept.length
  if (removed > 0) writeTaskRows(kept)
  return removed
}

export function holdersOf(path: string): string[] {
  const canonical = normalizePath(path)
  const holders = new Set<string>()
  for (const row of readTaskRows()) {
    if (isClaimRow(row) && canonicalPath(row.path) === canonical) holders.add(row.modelId)
  }
  return [...holders].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
}

function firstForeignHolder(rows: TaskRecord[], path: string, self: string): string | undefined {
  const holders = new Set<string>()
  for (const row of rows) {
    if (!isClaimRow(row) || row.modelId === self) continue
    if (canonicalPath(row.path) === path) holders.add(row.modelId)
  }
  if (holders.size === 0) return undefined
  return [...holders].sort((a, b) => (a < b ? -1 : 1))[0]
}

function makeClaimRow(modelId: string, path: string, now: number, taskId: string | undefined): ClaimRow {
  const row: ClaimRow = {
    claimId: `claim:${modelId}:${path}`,
    kind: 'claim',
    modelId,
    path,
    createdAt: now,
  }
  if (taskId !== undefined) row.taskId = taskId
  return row
}
