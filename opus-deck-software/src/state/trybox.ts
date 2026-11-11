/**
 * Zeak v2 — the TRY BOX (the failure memory).
 *
 * Every failed attempt is appended as a first-class, queryable object:
 * method tried, normalized error signature {E}, task context, which model
 * failed, when. Written at the SAME exit-path that writes blocked/handed_off
 * contract entries — a crash or bail IS a TRY BOX event.
 *
 * The signature is extracted deterministically (normalized keywords + hash):
 * no LLM in the hot path, stable across runs, comparable across attempts.
 */
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { atomicWriteJson, readJson } from './atomic.js'

export interface TryBoxEntry {
  id: string
  taskId: string
  modelId: string
  /** The method/attempt that failed (short, compacted). */
  method: string
  /** Deterministic error signature — the correlation key {E}. */
  signature: string
  /** Raw error detail, capped. */
  errorDetail: string
  at: string
}

interface TryBoxFileShape {
  entries: TryBoxEntry[]
}

/** Keywords that anchor a signature inside an error message. */
const SIG_ANCHORS = [
  'ENOENT', 'EACCES', 'ECONNREFUSED', 'ETIMEDOUT', 'EEXIST', 'EMFILE',
  'PARSE_FAILED', 'QUEUE_UNAVAILABLE', 'TXN_APPLY_FAILED', 'API_KEY_MISSING',
  'SyntaxError', 'TypeError', 'ReferenceError', 'RangeError', 'JSON',
  'timeout', 'rate limit', '429', '401', '403', '500',
] as const

/** Extract a deterministic error signature {E} from a raw error string.
 * Anchored keywords dominate; otherwise the normalized first line + hash. */
export function errorSignature(raw: string): string {
  const text = (raw ?? '').slice(0, 2000)
  const anchors = SIG_ANCHORS.filter((a) => text.toLowerCase().includes(a.toLowerCase()))
  if (anchors.length > 0) return `E:${anchors.slice(0, 2).join('+').toUpperCase()}`
  const firstLine = text.split('\n', 1)[0]?.trim() ?? 'unknown'
  const normalized = firstLine.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120)
  const h = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  return `E:${normalized.slice(0, 60)}#${h}`
}

export interface TryBoxOptions {
  /** Hard cap on stored entries (RAM budget). Oldest evicted. Default 500. */
  cap?: number
}

export class TryBox {
  private readonly file: string
  private readonly cap: number
  private entries: TryBoxEntry[] = []
  private loaded = false
  private seq = 0

  constructor(stateDir: string, options: TryBoxOptions = {}) {
    this.file = `${stateDir.replace(/[\\/]+$/, '')}/trybox.json`
    this.cap = options.cap ?? 500
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const data = await readJson<TryBoxFileShape>(this.file, { entries: [] })
    this.entries = Array.isArray(data.entries) ? data.entries : []
    for (const e of this.entries) {
      const m = /^try-(\d+)$/.exec(e.id)
      if (m) this.seq = Math.max(this.seq, Number(m[1]))
    }
    this.loaded = true
  }

  async persist(): Promise<void> {
    await atomicWriteJson(this.file, { entries: this.entries })
  }

  /** Record one failed attempt. Returns the signature {E}. */
  async record(input: {
    taskId: string
    modelId: string
    method: string
    errorDetail: string
  }): Promise<string> {
    await this.load()
    const signature = errorSignature(input.errorDetail)
    this.entries.push({
      id: `try-${String(++this.seq).padStart(4, '0')}`,
      taskId: input.taskId,
      modelId: input.modelId,
      method: input.method.slice(0, 300),
      signature,
      errorDetail: input.errorDetail.slice(0, 1500),
      at: new Date().toISOString(),
    })
    while (this.entries.length > this.cap) this.entries.shift()
    await this.persist()
    return signature
  }

  /** All entries for one signature {E}, newest last. */
  async bySignature(signature: string): Promise<TryBoxEntry[]> {
    await this.load()
    return this.entries.filter((e) => e.signature === signature)
  }

  /** Signatures with occurrence counts, newest first. */
  async tally(): Promise<Array<{ signature: string; occurrences: number; methods: string[]; models: string[]; lastAt: string }>> {
    await this.load()
    const map = new Map<string, { signature: string; occurrences: number; methods: Set<string>; models: Set<string>; lastAt: string }>()
    for (const e of this.entries) {
      let t = map.get(e.signature)
      if (t === undefined) {
        t = { signature: e.signature, occurrences: 0, methods: new Set(), models: new Set(), lastAt: e.at }
        map.set(e.signature, t)
      }
      t.occurrences += 1
      t.methods.add(e.method)
      t.models.add(e.modelId)
      if (e.at > t.lastAt) t.lastAt = e.at
    }
    return [...map.values()]
      .map((t) => ({ signature: t.signature, occurrences: t.occurrences, methods: [...t.methods], models: [...t.models], lastAt: t.lastAt }))
      .sort((a, b) => b.occurrences - a.occurrences || (a.lastAt < b.lastAt ? 1 : -1))
  }

  /** Whether any entry carries this signature (predictive early-stop lookup). */
  async knows(signature: string): Promise<boolean> {
    await this.load()
    return this.entries.some((e) => e.signature === signature)
  }

  size(): number {
    return this.entries.length
  }

  /** Direct access (tests). */
  async raw(): Promise<TryBoxEntry[]> {
    await this.load()
    return [...this.entries]
  }

  /** Only used by tests/migrations. */
  async replace(entries: TryBoxEntry[]): Promise<void> {
    this.entries = entries
    this.loaded = true
    await this.persist()
  }

  /** Touch the file (boot). */
  async init(): Promise<void> {
    try { await fsp.access(this.file) } catch { await this.persist() }
    await this.load()
  }
}
