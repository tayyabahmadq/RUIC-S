/**
 * Opus//DECK — Phase 4: The Compactor.
 *
 * The only component allowed to shrink what a working model receives from
 * COMMONS. Chunks STATE/digest.md on blank lines, compresses each chunk via
 * a cheap LLM, merges the five required sections, guarantees PINS survive,
 * writes the new digest atomically, archives the previous digest, and emits
 * compaction.done. Idempotent: unchanged digest+DELTA -> ran:false.
 *
 * Kept deliberately small (< 400 lines excluding tests).
 */
import { createHash } from 'crypto'
import { CommonsError } from './errors.js'
import type {
  Commons,
  CompactionResult,
  CompactorOptions,
  EventBus,
  LlmRequest,
  LlmResponse,
  ReadRange,
  RangePointer,
  SectionName,
  Transport,
  WorkingSetReduction,
} from './types.js'

/** Fixed system prompt required by the deck contract. Do not reword. */
export const COMPACTOR_SYSTEM_PROMPT =
  'You maintain a build memory digest. Compress the following chunk. Never drop: ' +
  'file-to-interface mappings, open risks, unsettled decisions, goal-state status. ' +
  'Output markdown with exactly these sections: ARCH, IFACE, OPEN, SETTLED, PINS.'

export const SECTION_NAMES: readonly SectionName[] = ['ARCH', 'IFACE', 'OPEN', 'SETTLED', 'PINS']

const SECTION_RE = /^#{0,6}\s*(ARCH|IFACE|OPEN|SETTLED|PINS)\s*:?\s*$/i
const DIGEST_PATH = 'STATE/digest.md'
const DEFAULT_TOKENS_PER_LINE = 10

/** Dependency-free token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

function asSection(raw: string): SectionName | null {
  const m = SECTION_RE.exec(raw.trim())
  if (!m) return null
  return (m[1] ?? '').toUpperCase() as SectionName
}

/**
 * Chunk the digest on blank lines. A new chunk starts only at a markdown
 * heading or a bare section label; list items and paragraphs attach to the
 * previous chunk, so lists/sections are never split.
 */
export function chunkDigest(digest: string): string[] {
  const blocks = digest
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  const chunks: string[] = []
  for (const block of blocks) {
    const firstLine = block.split('\n', 1)[0] ?? ''
    const startsSection = SECTION_RE.test(firstLine) || /^#{1,6}\s/.test(firstLine)
    if (chunks.length === 0 || startsSection) {
      chunks.push(block)
    } else {
      const last = chunks.length - 1
      chunks[last] = (chunks[last] ?? '') + '\n\n' + block
    }
  }
  return chunks
}

/** Parse ARCH/IFACE/OPEN/SETTLED/PINS sections (headings or bare labels, case-insensitive). */
export function parseSections(md: string): Map<SectionName, string[]> {
  const out = new Map<SectionName, string[]>()
  for (const name of SECTION_NAMES) out.set(name, [])
  let current: SectionName | null = null
  for (const rawLine of md.split('\n')) {
    const section = asSection(rawLine)
    if (section) {
      current = section
      continue
    }
    if (current && rawLine.trim().length > 0) {
      const target = out.get(current)
      if (target) target.push(rawLine.trim())
    }
  }
  return out
}

/** Pinned lines from a digest's PINS section, deduped, order-preserving. */
export function extractPins(digest: string): string[] {
  return dedupe(parseSections(digest).get('PINS') ?? [])
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const key = line.trim()
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

function sha256(digest: string, deltaParts: string[]): string {
  const h = createHash('sha256')
  h.update(digest)
  for (const part of deltaParts) {
    h.update('\u0000')
    h.update(part)
  }
  return h.digest('hex')
}

function renderDigest(sections: Map<SectionName, string[]>, pins: string[], version: number): string {
  const parts: string[] = [`# DIGEST (compacted v${version})`]
  for (const name of SECTION_NAMES) {
    const lines = name === 'PINS' ? pins : dedupe(sections.get(name) ?? [])
    parts.push('', name, ...lines)
  }
  parts.push('', `(superseded -> ARCHIVE/digest@v${version}.md)`)
  return parts.join('\n') + '\n'
}

/** Token count for one read range. */
export function rangeTokens(range: ReadRange): number {
  if (range.tokens !== undefined) {
    if (!Number.isFinite(range.tokens) || range.tokens < 0) {
      throw new CommonsError('INVALID_RANGE', 'ReadRange.tokens must be a non-negative finite number', `path=${range.path}`)
    }
    return range.tokens
  }
  if (
    typeof range.path !== 'string' ||
    range.path.length === 0 ||
    !Number.isInteger(range.startLine) ||
    range.startLine < 1 ||
    !Number.isInteger(range.endLine) ||
    range.endLine < range.startLine ||
    !Number.isFinite(range.lastUsed)
  ) {
    throw new CommonsError(
      'INVALID_RANGE',
      'ReadRange requires non-empty path, 1<=startLine<=endLine, finite lastUsed',
      `path=${String(range.path)}`,
    )
  }
  return (range.endLine - range.startLine + 1) * DEFAULT_TOKENS_PER_LINE
}

/** Pure working-set reduction: drop least-recently-used ranges until under budget. */
export function reduceWorkingSet(
  ranges: ReadRange[],
  promptTokensBudget: number,
): WorkingSetReduction {
  if (!Number.isFinite(promptTokensBudget) || promptTokensBudget < 0) {
    throw new CommonsError('INVALID_BUDGET', 'promptTokensBudget must be a non-negative finite number')
  }
  for (const r of ranges) rangeTokens(r)
  const tokensBefore = ranges.reduce((sum, r) => sum + rangeTokens(r), 0)

  const order = ranges
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.lastUsed - b.r.lastUsed || a.i - b.i)

  const droppedIdx = new Set<number>()
  let tokens = tokensBefore
  for (const { i } of order) {
    if (tokens <= promptTokensBudget) break
    droppedIdx.add(i)
    tokens -= rangeTokens(ranges[i])
  }

  const kept = ranges.filter((_, i) => !droppedIdx.has(i))
  const dropped: RangePointer[] = ranges
    .filter((_, i) => droppedIdx.has(i))
    .map((r) => ({
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      pointer: `-> ${r.path}:${r.startLine}-${r.endLine} (demoted by compactor; re-read on demand)`,
    }))
  return { kept, dropped, tokensBefore, tokensAfter: tokens }
}

export class Compactor {
  private readonly transport: Transport
  private readonly commons: Commons
  private readonly bus: EventBus
  private readonly digestTokenBudget: number
  private readonly promptTokensBudget: number
  private readonly llmModel: string
  private readonly budgetCheckEvents: string[]
  private lastFingerprint: string | null = null
  private running = false
  private watched = false

  constructor(
    deps: { transport: Transport; commons: Commons; bus: EventBus },
    options: CompactorOptions = {},
  ) {
    if (
      options.digestTokenBudget !== undefined &&
      (!Number.isFinite(options.digestTokenBudget) || options.digestTokenBudget <= 0)
    ) {
      throw new CommonsError('INVALID_OPTION', 'digestTokenBudget must be a positive finite number')
    }
    if (
      options.promptTokensBudget !== undefined &&
      (!Number.isFinite(options.promptTokensBudget) || options.promptTokensBudget < 0)
    ) {
      throw new CommonsError('INVALID_OPTION', 'promptTokensBudget must be a non-negative finite number')
    }
    if (options.llmModel !== undefined && options.llmModel.trim().length === 0) {
      throw new CommonsError('INVALID_OPTION', 'llmModel must be a non-empty string')
    }
    if (
      options.budgetCheckEvents !== undefined &&
      options.budgetCheckEvents.some((e) => typeof e !== 'string' || e.length === 0)
    ) {
      throw new CommonsError('INVALID_OPTION', 'budgetCheckEvents must be an array of non-empty strings')
    }
    this.transport = deps.transport
    this.commons = deps.commons
    this.bus = deps.bus
    this.digestTokenBudget = options.digestTokenBudget ?? 2000
    this.promptTokensBudget = options.promptTokensBudget ?? 8000
    this.llmModel = options.llmModel ?? 'compactor-small'
    this.budgetCheckEvents = options.budgetCheckEvents ?? ['commons.changed', 'digest.updated']
  }

  /** Subscribe to compaction triggers. Idempotent. */
  watch(): void {
    if (this.watched) return
    this.watched = true
    for (const event of this.budgetCheckEvents) {
      this.bus.subscribe(event, () => this.maybeCompactOnBudget())
    }
    this.bus.subscribe('compaction.requested', () => this.safeCompact())
  }

  private async maybeCompactOnBudget(): Promise<void> {
    try {
      if (!(await this.commons.exists(DIGEST_PATH))) return
      const digest = await this.commons.read(DIGEST_PATH)
      if (estimateTokens(digest) > this.digestTokenBudget) await this.safeCompact()
    } catch {
      // never throw out of a bus handler
    }
  }

  private async safeCompact(): Promise<void> {
    try {
      await this.compact()
    } catch (err) {
      try {
        await this.bus.emit('compaction.error', {
          code: err instanceof CommonsError ? err.code : 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        })
      } catch {
        // swallow
      }
    }
  }

  /** Run one compaction pass. Idempotent: unchanged digest+DELTA -> ran:false. */
  async compact(force = false): Promise<CompactionResult> {
    if (this.running) return { beforeTokens: 0, afterTokens: 0, demotedToArchive: 0, ran: false }
    this.running = true
    try {
      return await this.run(force)
    } finally {
      this.running = false
    }
  }

  private async run(force: boolean): Promise<CompactionResult> {
    if (!(await this.commons.exists(DIGEST_PATH))) {
      throw new CommonsError('DIGEST_MISSING', `no digest at ${DIGEST_PATH}`)
    }
    const digest = await this.commons.read(DIGEST_PATH)
    const deltaFiles = (await this.commons.list('DELTA')).filter((f) => f.endsWith('.md')).sort()
    const deltaParts: string[] = []
    for (const f of deltaFiles) {
      if (await this.commons.exists(f)) deltaParts.push(await this.commons.read(f))
    }

    const fingerprint = sha256(digest, deltaParts)
    if (!force && this.lastFingerprint === fingerprint) {
      return { beforeTokens: 0, afterTokens: 0, demotedToArchive: 0, ran: false }
    }

    const beforeTokens = estimateTokens(digest)
    const chunks = chunkDigest(digest)
    const merged = new Map<SectionName, string[]>()
    for (const name of SECTION_NAMES) merged.set(name, [])

    for (const chunk of chunks) {
      const res = await this.transport.chat({
        system: COMPACTOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: chunk }],
        model: this.llmModel,
      })
      if (typeof res.text !== 'string' || res.text.length === 0) {
        throw new CommonsError('TRANSPORT_FAIL', 'compactor LLM returned an empty response', `chunk=${chunk.slice(0, 80)}`)
      }
      for (const [name, lines] of parseSections(res.text)) {
        const target = merged.get(name)
        if (target) target.push(...lines)
      }
    }

    // PINS survive every compaction: union of old pins + LLM pins.
    const pins = dedupe([...extractPins(digest), ...(merged.get('PINS') ?? [])])
    const version = await this.nextArchiveVersion()
    const newDigest = renderDigest(merged, pins, version)

    await this.commons.write(`ARCHIVE/digest@v${version}.md`, digest)
    await this.commons.write(DIGEST_PATH, newDigest)
    this.lastFingerprint = sha256(newDigest, deltaParts)

    const result: CompactionResult = {
      beforeTokens,
      afterTokens: estimateTokens(newDigest),
      demotedToArchive: chunks.length,
      ran: true,
    }
    await this.bus.emit('compaction.done', result)
    return result
  }

  private async nextArchiveVersion(): Promise<number> {
    let files: string[] = []
    try { files = await this.commons.list('ARCHIVE') } catch { files = [] }
    let max = 0
    for (const f of files) {
      const m = /digest@v(\d+)\.md$/.exec(f)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max + 1
  }

  /** Explicit unpin: the ONLY way a pin is removed. */
  async unpin(query: string): Promise<number> {
    if (!(await this.commons.exists(DIGEST_PATH))) {
      throw new CommonsError('DIGEST_MISSING', `no digest at ${DIGEST_PATH}`)
    }
    const digest = await this.commons.read(DIGEST_PATH)
    const pins = parseSections(digest).get('PINS') ?? []
    const remove = new Set(pins.filter((p) => p.includes(query.trim())).map((p) => p.trim()))
    if (remove.size === 0) return 0

    let current: SectionName | null = null
    let removed = 0
    const outLines: string[] = []
    for (const line of digest.split('\n')) {
      const section = asSection(line)
      if (section) { current = section; outLines.push(line); continue }
      if (current === 'PINS' && remove.has(line.trim())) { removed++; continue }
      outLines.push(line)
    }
    await this.commons.write(DIGEST_PATH, outLines.join('\n'))
    return removed
  }

  /** Working-set reduction for one model. */
  reduceWorkingSet(ranges: ReadRange[], budget?: number): WorkingSetReduction {
    return reduceWorkingSet(ranges, budget ?? this.promptTokensBudget)
  }
}
