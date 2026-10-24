/**
 * Common-S — Dept 2: Data Collection.
 *
 * A generic COLLECTOR SEAM (same swappability rule as the model roster):
 * collectors implement `collect(topic)`, and data-collection talks only to
 * the seam. Two implementations ship:
 *
 *   - GitHubCollector  — GitHub-as-data-source: free REST API, the rate limit
 *     is treated as a budget (count calls, back off on 403).
 *   - BrowserCollector — the Obscura Browser agent behind the same seam. RAM
 *     discipline (pinned): ONE browsing agent at a time, serialized through
 *     a queue; any launch/page failure degrades to a cache-gate miss report
 *     and never blocks the pipeline.
 *
 * Every path is cache-gate FIRST (Brain vector lookup >= threshold): repeat
 * research is served from the Brain at zero cost — with no paid API left in
 * this department, time and RAM are the resources the gate saves.
 */
import type { Brain } from '../state/brain.js'
/** The shared one-browsing-agent-at-a-time queue. Both the Obscura Browser
 * and the Agent-Reach session browser serialize through the SAME instance,
 * so one browsing agent at a time holds across implementations. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job)
    tail = run.catch(() => undefined)
    return run
  }
}

export interface CollectedItem {
  title: string
  body: string
  source: string
}

export interface Collector {
  readonly name: string
  collect(topic: string): Promise<CollectedItem[]>
}

export interface CollectEvents {
  emit(event: string, payload: unknown): void
}

// ---------------------------------------------------------------------------
// GitHub-as-data-source collector (free REST, budgeted)
// ---------------------------------------------------------------------------

export interface GitHubCollectorOptions {
  token?: string
  apiBase?: string
  /** Treat the rate limit as a budget: max requests per run. Default 10. */
  maxRequests?: number
  fetchImpl?: typeof fetch
}

export class GitHubCollector implements Collector {
  readonly name = 'github'
  private readonly token?: string
  private readonly apiBase: string
  private readonly maxRequests: number
  private readonly fetchImpl: typeof fetch
  private requests = 0

  constructor(options: GitHubCollectorOptions = {}) {
    this.token = options.token
    this.apiBase = options.apiBase ?? 'https://api.github.com'
    this.maxRequests = options.maxRequests ?? 10
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  requestsUsed(): number {
    return this.requests
  }

  async collect(topic: string): Promise<CollectedItem[]> {
    if (this.requests >= this.maxRequests) {
      return []
    }
    this.requests += 1
    const url = `${this.apiBase}/search/repositories?q=${encodeURIComponent(topic)}&per_page=3`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ruic-data-collection',
          ...(this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      })
    } catch (err) {
      return [] // network failure degrades to a miss, never throws upstream
    }
    if (res.status === 403) {
      // Rate limit hit — back off by treating the budget as spent.
      this.requests = this.maxRequests
      return []
    }
    if (!res.ok) return []
    let data: unknown
    try { data = await res.json() } catch { return [] }
    const items = (data as { items?: unknown }).items
    if (!Array.isArray(items)) return []
    return items.slice(0, 3).map((it) => {
      const r = it as { full_name?: string; description?: string; html_url?: string }
      return {
        title: r.full_name ?? 'unknown repo',
        body: `${r.full_name ?? ''}: ${r.description ?? ''} (${r.html_url ?? ''})`.trim(),
        source: `github:${r.full_name ?? ''}`,
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Obscura Browser collector (RAM-disciplined, serialized)
// ---------------------------------------------------------------------------

export interface BrowserCollectorOptions {
  /** Launch the Obscura agent. Return null when it cannot launch. */
  launch: (topic: string) => Promise<CollectedItem[] | null>
  events: CollectEvents
  /** Shared serialization queue (pass the SAME instance to every browsing
   * collector so one browsing agent at a time holds across implementations). */
  enqueue?: <T>(job: () => Promise<T>) => Promise<T>
}

export class BrowserCollector implements Collector {
  readonly name = 'obscura-browser'
  private readonly launch: (topic: string) => Promise<CollectedItem[] | null>
  private readonly events: CollectEvents
  private readonly enqueue: <T>(job: () => Promise<T>) => Promise<T>

  constructor(options: BrowserCollectorOptions) {
    this.launch = options.launch
    this.events = options.events
    this.enqueue = options.enqueue ?? createSerialQueue()
  }

  /** Pinned rule: ONE browsing agent at a time, via the shared queue (the
   * same instance Agent-Reach uses). A queued call waits for the in-flight
   * one instead of opening a second agent. */
  collect(topic: string): Promise<CollectedItem[]> {
    return this.enqueue(async () => {
      try {
        this.events.emit('collector.browser_start', { topic })
        const items = await this.launch(topic)
        if (items === null) {
          // Graceful degradation: a failed launch is a cache-gate miss report,
          // never a pipeline blocker.
          this.events.emit('collector.browser_miss', { topic, reason: 'launch_failed' })
          return []
        }
        return items
      } catch (err) {
        this.events.emit('collector.browser_miss', {
          topic, reason: 'error', detail: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    })
  }
}

// ---------------------------------------------------------------------------
// The department: cache-gate first, collector second, Brain ingest always
// ---------------------------------------------------------------------------

export interface DataCollectionOptions {
  brain: Brain
  /** Primary collector (back-compat). */
  collector?: Collector
  /** Ordered fallback chain: tried in order until one yields items. Free
   * budget first (GitHub REST), then browser-time (Agent-Reach / Obscura). */
  collectors?: readonly Collector[]
  events: CollectEvents
  /** Cache-gate similarity threshold. Conservative default 0.9. */
  cacheThreshold?: number
}

export interface CollectionResult {
  servedFromCache: boolean
  items: CollectedItem[]
}

export async function collectTopic(topic: string, options: DataCollectionOptions): Promise<CollectionResult> {
  const { brain, collector, events } = options
  const threshold = options.cacheThreshold ?? 0.9

  // --- Cache-gate first: repeat research is free ---------------------------
  if (brain.hasEmbedder) {
    try {
      const hits = await brain.recall(topic, threshold)
      if (hits !== null && hits.length > 0) {
        events.emit('collector.cache_hit', { topic, score: hits[0].score, source: hits[0].entry.source })
        return {
          servedFromCache: true,
          items: hits.map((h) => ({ title: h.entry.source, body: h.entry.text, source: h.entry.source })),
        }
      }
    } catch {
      // Embedding failure degrades to a fresh collect.
    }
  }
  events.emit('collector.cache_miss', { topic })

  // --- Collect through the seam: ordered fallback chain ---------------------
  const chain: readonly Collector[] = options.collectors ?? (options.collector !== undefined ? [options.collector] : [])
  let items: CollectedItem[] = []
  let usedVia = 'none'
  for (const collector of chain) {
    try {
      items = await collector.collect(topic)
    } catch {
      items = []
    }
    if (items.length > 0) {
      usedVia = collector.name
      break
    }
  }

  // --- Ingest into the Brain (embed + store) --------------------------------
  for (const item of items) {
    try {
      await brain.learn(item.body, item.source)
    } catch {
      // Learn failures are non-fatal: the caller still gets the raw items.
    }
  }
  events.emit('collector.collected', { topic, count: items.length, via: usedVia })
  return { servedFromCache: false, items }
}
