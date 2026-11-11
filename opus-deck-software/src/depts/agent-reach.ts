/**
 * Common-S — Dept 2: Agent-Reach collector.
 *
 * Agent-Reach (github.com/Panniantong/Agent-Reach) is a local CLI that gives
 * agents access to login-walled, video, and Chinese-language platforms
 * (Bilibili, YouTube transcripts, V2EX, web search/read; Xiaohongshu, Reddit,
 * LinkedIn and more opt-in). Local-first, read-only, sessions copied from the
 * user's own Chrome — philosophically aligned with the zero-marginal-cost
 * thesis.
 *
 * Integration rules (pinned):
 *  - It implements the SAME Collector seam as GitHub/Obscura: this module
 *    shells the CLI and parses structured output into CollectedItem[].
 *  - Its per-site headless browser is the heaviest citizen on the machine:
 *    collection runs through the SHARED serialization queue (one browsing
 *    agent at a time, ever).
 *  - Missing CLI / failed channel = graceful miss, never a thrown error.
 *  - No channel requiring a paid key is invoked here (YouTube speech-to-text
 *    wants a Groq/OpenAI key — that stays out unless explicitly enabled).
 */
import { spawn } from 'child_process'
import { createSerialQueue } from './data-collection.js'
import type { CollectedItem, Collector, CollectEvents } from './data-collection.js'

/** Availability probe result, cached after first check. */
export interface AgentReachAvailability {
  available: boolean
  detail: string
}

export interface AgentReachCollectorOptions {
  /** CLI binary name/path. Default `agent-reach` (must be on PATH). */
  bin?: string
  /** Channels to query, in order. Default: the no-login free set. */
  channels?: string[]
  /** Timeout per CLI invocation (ms). Default 120s. */
  timeoutMs?: number
  events: CollectEvents
  /** Shared serial queue (one browsing agent at a time). */
  enqueue?: <T>(job: () => Promise<T>) => Promise<T>
  spawnImpl?: typeof spawn
  /** Precomputed availability (tests); otherwise probed on first use. */
  availability?: AgentReachAvailability
}

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export class AgentReachCollector implements Collector {
  readonly name = 'agent-reach'
  private readonly bin: string
  private readonly channels: string[]
  private readonly timeoutMs: number
  private readonly events: CollectEvents
  private readonly enqueue: <T>(job: () => Promise<T>) => Promise<T>
  private readonly spawnImpl: typeof spawn
  private availability: AgentReachAvailability | null

  constructor(options: AgentReachCollectorOptions) {
    this.bin = options.bin ?? 'agent-reach'
    this.channels = options.channels ?? ['websearch', 'github']
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.events = options.events
    this.enqueue = options.enqueue ?? createSerialQueue()
    this.spawnImpl = options.spawnImpl ?? spawn
    this.availability = options.availability ?? null
  }

  private spawnOnce(args: string[], timeoutMs: number): Promise<SpawnResult> {
    return new Promise((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let child
      try {
        child = this.spawnImpl(this.bin, args, { windowsHide: true })
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
        return
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try { child.kill() } catch { /* already dead */ }
          resolve({ code: -2, stdout, stderr: stderr + '\ntimeout' })
        }
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => { stdout += String(d) })
      child.stderr?.on('data', (d: Buffer) => { stderr += String(d) })
      child.on('error', (err: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }) }
      })
      child.on('close', (code: number | null) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) }
      })
    })
  }

  /** Probe the CLI once. ENOENT = not installed: the collector then
   * permanently reports a miss without spawning anything. */
  private async probe(): Promise<AgentReachAvailability> {
    if (this.availability !== null) return this.availability
    const res = await this.spawnOnce(['--help'], 15_000)
    this.availability = res.code === 0
      ? { available: true, detail: 'cli ready' }
      : { available: false, detail: res.code === -1 ? 'not installed' : `cli error: ${res.stderr.slice(0, 120)}` }
    this.events.emit('collector.agentreach_probe', this.availability)
    return this.availability
  }

  async collect(topic: string): Promise<CollectedItem[]> {
    const status = await this.probe()
    if (!status.available) {
      this.events.emit('collector.agentreach_miss', { topic, reason: status.detail })
      return []
    }
    // Pinned: serialized through the shared browsing queue.
    return this.enqueue(async () => {
      const items: CollectedItem[] = []
      for (const channel of this.channels) {
        const res = await this.spawnOnce([channel, 'search', topic], this.timeoutMs)
        if (res.code !== 0) {
          this.events.emit('collector.agentreach_miss', { topic, channel, reason: `exit ${res.code}` })
          continue
        }
        items.push(...this.parseOutput(topic, channel, res.stdout))
        if (items.length > 0) break // first productive channel wins
      }
      this.events.emit('collector.agentreach_collected', { topic, count: items.length })
      return items
    })
  }

  /** Parse Agent-Reach's structured output. The CLI emits human/markdown or
   * JSON depending on channel; we accept both: JSON arrays/objects with
   * title/body-ish fields, or markdown blocks split on headings/links. */
  parseOutput(topic: string, channel: string, raw: string): CollectedItem[] {
    const out: CollectedItem[] = []
    const trimmed = raw.trim()
    if (trimmed.length === 0) return out
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        const list = Array.isArray(parsed) ? parsed : [parsed]
        for (const entry of list) {
          if (typeof entry !== 'object' || entry === null) continue
          const o = entry as Record<string, unknown>
          const title = typeof o['title'] === 'string' ? o['title'] : undefined
          const body = ['content', 'body', 'text', 'summary', 'description']
            .map((k) => (typeof o[k] === 'string' ? (o[k] as string) : null))
            .find((v) => v !== null)
          if (title === undefined && body === undefined) continue
          const url = typeof o['url'] === 'string' ? o['url'] : ''
          out.push({
            title: title ?? `${channel}: ${topic}`,
            body: (body ?? '').slice(0, 8000),
            source: `agent-reach:${channel}${url !== '' ? `:${url}` : ''}`,
          })
        }
        return out
      } catch {
        // fall through to markdown parsing
      }
    }
    // Markdown fallback: split on headings; each non-empty block is an item.
    const blocks = trimmed.split(/\n#{1,3}\s+/).map((b) => b.trim()).filter((b) => b.length > 20)
    for (const block of blocks.slice(0, 10)) {
      const firstLine = block.split('\n', 1)[0] ?? ''
      out.push({
        title: firstLine.replace(/^#+\s*/, '').slice(0, 120) || `${channel}: ${topic}`,
        body: block.slice(0, 8000),
        source: `agent-reach:${channel}`,
      })
    }
    return out
  }
}
