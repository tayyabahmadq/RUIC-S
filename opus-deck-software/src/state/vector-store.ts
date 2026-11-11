/**
 * Common-S Brain — the vector store (Risk #5).
 *
 * File-backed JSON, in-memory index, sized to the RAM budget. Every scrape,
 * cache-gate write and knowledge ingest lands here; without a decay policy it
 * would grow unboundedly while RAM stays fixed, so the store carries:
 *   - a hard cap on vector count,
 *   - prune-by-recency x relevance (age, hit count),
 * executed by the Compactor's loop, not ad hoc.
 */
import { promises as fsp } from 'fs'
import { atomicWriteJson, readJson } from './atomic.js'

export interface VectorEntry {
  id: string
  text: string
  vector: number[]
  addedAt: string
  hits: number
  source: string
}

interface VectorFileShape {
  entries: VectorEntry[]
}

export interface VectorSearchHit {
  entry: VectorEntry
  score: number
}

export type EmbedFn = (text: string) => Promise<number[]>

function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface VectorStoreOptions {
  /** Hard cap on stored vectors (RAM budget). Default 2000. */
  cap?: number
  /** Decay batch: how many entries one decay pass may drop. Default cap/10. */
  decayBatch?: number
}

export class VectorStore {
  private readonly file: string
  private readonly cap: number
  private readonly decayBatch: number
  private entries: VectorEntry[] = []
  private loaded = false
  private seq = 0

  constructor(stateDir: string, options: VectorStoreOptions = {}) {
    this.file = `${stateDir.replace(/[\\/]+$/, '')}/vectors.json`
    this.cap = options.cap ?? 2000
    this.decayBatch = options.decayBatch ?? Math.max(1, Math.floor(this.cap / 10))
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const data = await readJson<VectorFileShape>(this.file, { entries: [] })
    this.entries = Array.isArray(data.entries) ? data.entries.filter(
      (e) => typeof e?.id === 'string' && Array.isArray(e?.vector) && typeof e?.text === 'string',
    ) : []
    for (const e of this.entries) {
      const m = /^v-(\d+)$/.exec(e.id)
      if (m) this.seq = Math.max(this.seq, Number(m[1]))
    }
    this.loaded = true
  }

  async persist(): Promise<void> {
    await atomicWriteJson(this.file, { entries: this.entries })
  }

  size(): number {
    return this.entries.length
  }

  /** Embed + store one knowledge item. Oldest/least-relevant entries are
   * evicted immediately when the cap would be exceeded. */
  async add(text: string, source: string, embed: EmbedFn): Promise<string> {
    await this.load()
    const vector = await embed(text)
    const id = `v-${String(++this.seq).padStart(6, '0')}`
    this.entries.push({ id, text, vector, addedAt: new Date().toISOString(), hits: 0, source })
    while (this.entries.length > this.cap) this.evictOne()
    await this.persist()
    return id
  }

  /** Cache-gate lookup: cosine similarity above `threshold` counts as a hit.
   * Conservative threshold by default (Risk #5: a false cache hit is worse
   * than a fresh call). */
  async search(text: string, embed: EmbedFn, threshold = 0.9, limit = 5): Promise<VectorSearchHit[]> {
    await this.load()
    const q = await embed(text)
    const scored = this.entries
      .map((entry) => ({ entry, score: cosine(q, entry.vector) }))
      .filter((h) => h.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    for (const h of scored) h.entry.hits += 1
    if (scored.length > 0) await this.persist()
    return scored
  }

  /** Relevance score for decay ordering: hits weight against age. */
  private relevance(e: VectorEntry, now: number): number {
    const ageMs = Math.max(0, now - Date.parse(e.addedAt).valueOf())
    const ageDays = ageMs / 86_400_000
    return (e.hits + 1) / (1 + ageDays)
  }

  private evictOne(): void {
    if (this.entries.length === 0) return
    const now = Date.now()
    let worstIdx = 0
    let worstScore = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.entries.length; i++) {
      const s = this.relevance(this.entries[i], now)
      if (s < worstScore) {
        worstScore = s
        worstIdx = i
      }
    }
    this.entries.splice(worstIdx, 1)
  }

  /** One Compactor-driven decay pass: drop up to `decayBatch` entries whose
   * relevance falls below the cutoff AND that are past the minimum age.
   * Returns how many were dropped. */
  async decay(minAgeDays: number, cutoff: number): Promise<number> {
    await this.load()
    const now = Date.now()
    const candidates = this.entries
      .map((entry, idx) => ({ entry, idx, score: this.relevance(entry, now), ageDays: (now - Date.parse(entry.addedAt).valueOf()) / 86_400_000 }))
      .filter((c) => c.ageDays >= minAgeDays && c.score < cutoff)
      .sort((a, b) => a.score - b.score)
      .slice(0, this.decayBatch)
    if (candidates.length === 0) return 0
    const drop = new Set(candidates.map((c) => c.idx))
    this.entries = this.entries.filter((_, i) => !drop.has(i))
    await this.persist()
    return candidates.length
  }

  /** Direct file access for tests/tools. */
  async raw(): Promise<VectorEntry[]> {
    await this.load()
    return [...this.entries]
  }

  /** Force replace (used by tests and future migrations). */
  async replace(entries: VectorEntry[]): Promise<void> {
    this.entries = entries
    this.loaded = true
    await this.persist()
  }

  static async exists(file: string): Promise<boolean> {
    try {
      await fsp.access(file)
      return true
    } catch {
      return false
    }
  }
}
