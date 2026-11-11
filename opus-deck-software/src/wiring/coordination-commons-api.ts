/**
 * Phase 11: Real CommonsApi for the coordination phase (presence, claims,
 * locks, sync). Installed via coordination.setCommons().
 *
 * Reads/writes STATE/tasks.json and STATE/presence.json directly (coordination
 * owns those files). Reads DELTA/txn.jsonl through phase-03's commons for
 * sync(). Every presence rewrite appends a DELTA row so syncSince() has a
 * cursor.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { CommonsApi, Delta, PresenceEntry, SyncResult, TaskRecord } from '../coordination/types.js'

const TXN_ID_PATTERN = /^txn-(\d{6})$/

function isoNow(): string {
  return new Date().toISOString()
}

function seqOf(txn: string): number {
  const m = TXN_ID_PATTERN.exec(txn)
  return m ? Number(m[1]) : 0
}

function readJsonFileSync(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function writeJsonAtomicSync(file: string, value: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function appendDeltaRowSync(deltaPath: string, entry: unknown): void {
  const dir = path.dirname(deltaPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(deltaPath, JSON.stringify(entry) + '\n', 'utf8')
}

function nextTxnId(deltaPath: string): string {
  let maxSeq = 0
  try {
    const raw = fs.readFileSync(deltaPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const m = TXN_ID_PATTERN.exec(JSON.parse(line).txn ?? '')
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]))
      } catch { /* skip malformed line */ }
    }
  } catch { /* no delta log yet */ }
  return `txn-${String(maxSeq + 1).padStart(6, '0')}`
}

export class RealCommonsApi implements CommonsApi {
  private readonly memoryDir: string
  private readonly deltaPath: string
  private readonly tasksPath: string
  private readonly presencePath: string
  private readonly digestPath: string

  constructor(memoryDir: string) {
    this.memoryDir = path.resolve(memoryDir)
    this.deltaPath = path.join(this.memoryDir, 'DELTA', 'txn.jsonl')
    this.tasksPath = path.join(this.memoryDir, 'STATE', 'tasks.json')
    this.presencePath = path.join(this.memoryDir, 'STATE', 'presence.json')
    this.digestPath = path.join(this.memoryDir, 'STATE', 'digest.md')
  }

  sync(): SyncResult {
    const deltas: Delta[] = []
    let maxSeq = 0
    try {
      const raw = fs.readFileSync(this.deltaPath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        const record = parsed as { txn?: string; ts?: string; path?: string; intent?: string; author?: string; status?: string; diff?: unknown; claims?: unknown }
        const txn = typeof record.txn === 'string' ? record.txn : ''
        if (!TXN_ID_PATTERN.test(txn)) continue
        maxSeq = Math.max(maxSeq, seqOf(txn))
        deltas.push({
          txnId: seqOf(txn),
          kind: 'file',
          path: typeof record.path === 'string' ? record.path : undefined,
          taskId: undefined,
          modelId: typeof record.author === 'string' ? record.author : undefined,
          value: undefined,
          at: typeof record.ts === 'string' ? new Date(record.ts).getTime() : undefined,
        })
      }
    } catch { /* no delta log yet */ }
    return { head: maxSeq, deltas }
  }

  readTasks(): TaskRecord[] {
    const data = readJsonFileSync(this.tasksPath)
    if (!Array.isArray(data)) return []
    return data as TaskRecord[]
  }

  writeTasks(rows: TaskRecord[]): void {
    writeJsonAtomicSync(this.tasksPath, rows)
  }

  readPresence(): PresenceEntry[] {
    const data = readJsonFileSync(this.presencePath)
    if (!data || typeof data !== 'object' || !Array.isArray((data as { entries?: unknown }).entries)) return []
    return (data as { entries: PresenceEntry[] }).entries
  }

  writePresence(entries: PresenceEntry[]): void {
    writeJsonAtomicSync(this.presencePath, { updated: isoNow(), entries })
    // A8: every presence rewrite carries a DELTA txn so syncSince() has a cursor.
    const txn = nextTxnId(this.deltaPath)
    appendDeltaRowSync(this.deltaPath, {
      txn, ts: isoNow(), path: 'STATE/presence.json', intent: 'coordination presence upsert',
      author: 'coordination', status: 'applied',
      diff: { added: [], removedLineCount: 0, atLine: 1 },
      claims: undefined,
    })
  }

  readDigest(): string {
    try { return fs.readFileSync(this.digestPath, 'utf8') } catch { return '' }
  }
}
