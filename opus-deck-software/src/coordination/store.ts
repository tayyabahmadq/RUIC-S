/**
 * Typed access to the two shared stores (STATE/tasks.json and STATE/presence.json).
 * Reads are validated; writes only receive shapes this phase constructed.
 */
import { z } from 'zod'
import { CommonsError } from './errors.js'
import { callCommons, getCommons } from './port.js'
import type { ClaimRow, PresenceEntry, TaskRecord, TaskRow } from './types.js'
import { claimRowSchema, presenceEntrySchema } from './types.js'

export function isClaimRow(row: TaskRecord): row is ClaimRow {
  return row.kind === 'claim'
}

export function readClaimRows(): ClaimRow[] {
  return readTaskRows().filter(isClaimRow)
}

export function readTaskRows(): TaskRecord[] {
  return callCommons('readTasks()', () => {
    const list = asArray(getCommons().readTasks(), 'tasks store', 'tasks_invalid')
    return list.map((item, index) => decodeTaskRecord(item, index))
  })
}

export function writeTaskRows(rows: TaskRecord[]): void {
  callCommons('writeTasks()', () => getCommons().writeTasks(rows))
}

export function readPresenceStore(): PresenceEntry[] {
  return callCommons('readPresence()', () => {
    const list = asArray(getCommons().readPresence(), 'presence store', 'presence_invalid')
    return list.map((item, index) => {
      const parsed = presenceEntrySchema.safeParse(item)
      if (!parsed.success) {
        throw new CommonsError(
          'presence_invalid',
          `malformed presence entry at index ${index}`,
          describeZodError(parsed.error),
        )
      }
      return parsed.data
    })
  })
}

export function writePresenceStore(entries: PresenceEntry[]): void {
  callCommons('writePresence()', () => getCommons().writePresence(entries))
}

export function assertPresenceEntry(entry: PresenceEntry, where: string): PresenceEntry {
  const parsed = presenceEntrySchema.safeParse(entry)
  if (!parsed.success) {
    throw new CommonsError('presence_invalid', `refusing to write ${where}`, describeZodError(parsed.error))
  }
  return parsed.data
}

function decodeTaskRecord(item: unknown, index: number): TaskRecord {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new CommonsError('tasks_invalid', `task row at index ${index} must be an object`, String(item))
  }
  const record = item as Record<string, unknown>
  if (record.kind === 'claim') {
    const parsed = claimRowSchema.safeParse(record)
    if (!parsed.success) {
      throw new CommonsError(
        'tasks_invalid',
        `malformed claim row at index ${index}`,
        describeZodError(parsed.error),
      )
    }
    return parsed.data
  }
  return item as TaskRow
}

function asArray(value: unknown, what: string, code: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CommonsError(code, `${what} must be an array`, String(value))
  }
  return value as unknown[]
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ')
}
