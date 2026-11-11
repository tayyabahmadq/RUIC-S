/**
 * Phase 5: SYNC — bounded catch-up for a heads-down model.
 */
import { CommonsError } from './errors.js'
import { canonicalPath } from './paths.js'
import { snapshot } from './presence.js'
import { getCommons, callCommons } from './port.js'
import { isClaimRow, readTaskRows } from './store.js'
import { requireModelId, requireNonNegativeInt } from './validate.js'
import type { Delta, SyncResult } from './types.js'

export function syncSince(modelId: string, sinceTxnId: number): Delta[] {
  const id = requireModelId(modelId, 'sync_invalid')
  const since = requireNonNegativeInt(sinceTxnId, 'sinceTxnId', 'sync_invalid')
  const commons = getCommons()

  const result = callCommons('sync()', () => readSyncResult(commons.sync()))
  const fresh = result.deltas.filter((delta) => delta.txnId > since)
  if (fresh.length === 0) return []

  const held = heldPaths(id)
  const relevant: Delta[] = []
  for (const delta of fresh) {
    if (delta.kind === 'digest' || delta.kind === 'presence') continue
    if (typeof delta.path === 'string' && held.has(canonicalPath(delta.path))) relevant.push(delta)
  }

  const now = Date.now()
  const digest = callCommons('readDigest()', () => commons.readDigest())
  if (typeof digest !== 'string') {
    throw new CommonsError('sync_invalid', 'commons.readDigest() must return a string', String(digest))
  }
  relevant.push({ txnId: result.head, kind: 'digest', value: digest, at: now })
  relevant.push({ txnId: result.head, kind: 'presence', value: snapshot(), at: now })

  return relevant.sort((a, b) => a.txnId - b.txnId)
}

function heldPaths(modelId: string): Set<string> {
  const paths = new Set<string>()
  for (const row of readTaskRows()) {
    if (isClaimRow(row) && row.modelId === modelId) paths.add(canonicalPath(row.path))
  }
  return paths
}

function readSyncResult(raw: unknown): SyncResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new CommonsError('sync_invalid', 'commons.sync() must return an object', String(raw))
  }
  const record = raw as Record<string, unknown>
  const head = record.head
  if (typeof head !== 'number' || !Number.isInteger(head) || head < 0) {
    throw new CommonsError('sync_invalid', 'commons.sync().head must be a non-negative integer', String(head))
  }
  if (!Array.isArray(record.deltas)) {
    throw new CommonsError('sync_invalid', 'commons.sync().deltas must be an array', String(record.deltas))
  }
  const deltas = (record.deltas as unknown[]).map((item, index) => decodeDelta(item, index, head))
  return { head, deltas }
}

function decodeDelta(item: unknown, index: number, head: number): Delta {
  if (typeof item !== 'object' || item === null) {
    throw new CommonsError('sync_invalid', `delta at index ${index} must be an object`, String(item))
  }
  const record = item as Record<string, unknown>
  const txnId = record.txnId
  if (typeof txnId !== 'number' || !Number.isInteger(txnId) || txnId < 0) {
    throw new CommonsError('sync_invalid', `delta at index ${index} has an invalid txnId`, String(txnId))
  }
  if (txnId > head) {
    throw new CommonsError('sync_invalid', `delta at index ${index} is beyond the log head`, `${txnId} > ${head}`)
  }
  const kind = record.kind
  if (typeof kind !== 'string' || kind === '') {
    throw new CommonsError('sync_invalid', `delta at index ${index} has an invalid kind`, String(kind))
  }
  return item as Delta
}
